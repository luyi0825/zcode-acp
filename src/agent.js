// ZCode ACP agent：把本机 zcode CLI 包装成 ACP v1 agent，
// 让 Zed / Neovim / OpenIdea 这类 ACP 客户端把 ZCode 当作编码 agent 使用。
import { Readable, Writable } from "node:stream";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { runTurn } from "./zcode.js";
import { eventToUpdates } from "./map-event.js";
import { attachClient, emitText, emitUpdate } from "./emitter.js";
import { loadDefaultRuntimeEnv } from "./runtime-env.js";
import { encodeModelId, findModel, isKnownReasoningLevel, listModels, REASONING_LEVELS } from "./models.js";

export const AGENT_INFO = { name: "zcode-acp", title: "ZCode", version: "0.5.3" };

// 权限模式：id 沿用 zcode 原生枚举（--mode 的合法取值），跨端语义一致。
// 默认 yolo：headless 没有确认入口，与 zcode 对 --prompt 的默认一致；
// plan（只读）/ guarded（最严）等受控模式由客户端按需选择。
const DEFAULT_MODE = "yolo";
const MODES = [
  { id: "plan", name: "Plan" },
  { id: "build", name: "Build" },
  { id: "edit", name: "Edit" },
  { id: "guarded", name: "Guarded" },
  { id: "yolo", name: "Yolo" },
];
const MODE_IDS = new Set(MODES.map((mode) => mode.id));

// 会话记录（本进程签发）。客户端回传的会话 id 只做等值比对，
// 命中的始终是本地记录对象，外部值不参与任何寻址。
const records = [];

/** 按本地签发值与回传值等值比对，返回对应的本地记录。 */
function findRecord(incomingId) {
  if (typeof incomingId !== "string") return undefined;
  for (const record of records) {
    if (record.id === incomingId) return record;
  }
  return undefined;
}

/**
 * ACP 的 cwd 必须是绝对路径；不存在时回退到用户主目录，
 * 否则 zcode --cwd 会直接报错退出。
 */
function normalizeCwd(cwd) {
  if (typeof cwd === "string" && path.isAbsolute(cwd) && existsSync(cwd) && statSync(cwd).isDirectory()) {
    return cwd;
  }
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

/**
 * 把 prompt 内容块拼成一段文本。
 * shortcut: 只取 text 块；本 agent 在 initialize 里已声明不支持 image/audio/embeddedContext，
 * 客户端不应下发其他块类型。
 */
function promptText(blocks) {
  return (blocks ?? [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * 组装会话响应里的 models 声明。
 * 真实列表来自 personal provider config（见 models.js）；读不到配置时回退
 * 单模型声明——部分宿主靠 availableModels 发现模型并派发任务，缺失会让任务排队。
 * record.model 是客户端 set_model 选中的模型，存在则回显为当前模型。
 */
function modelsPayload(record) {
  const models = listModels();
  if (!models) {
    return {
      availableModels: [{ modelId: "zcode", name: "ZCode", description: "ZCode 默认模型" }],
      currentModelId: "zcode",
    };
  }
  return {
    availableModels: models.availableModels,
    currentModelId: record?.model ? encodeModelId(record.model) : models.currentModelId,
  };
}

// ACP 新版用 configOptions 声明可调选项；旧版字段（models/modes）与之并存，
// 客户端优先读 configOptions。多数客户端把 id "reasoning" 归类为思考级别。
const REASONING_OPTION_ID = "reasoning";
const REASONING_NAMES = { low: "低", high: "高", max: "最大" };

/**
 * 会话响应里的 modes 声明（ACP 旧版字段，与 configOptions 并存）。
 * 客户端（编辑器等）据此渲染模式下拉框；当前值来自 record.mode，
 * 未选择时回显默认 yolo。
 */
function modesPayload(record) {
  return {
    availableModes: MODES,
    currentModeId: record?.mode ?? DEFAULT_MODE,
  };
}

/**
 * 思考级别选项（configOptions 形态）。未选择时回显 "max"，
 * 与 headless 不设置 optionSpecs 时的默认级别一致（实测）。
 */
function configOptionsPayload(record) {
  return [
    {
      id: REASONING_OPTION_ID,
      name: "思考级别",
      description: "ZCode 的推理深度（reasoningLevel）",
      type: "select",
      currentValue: record?.reasoningLevel ?? "max",
      options: REASONING_LEVELS.map((level) => ({ value: level, name: REASONING_NAMES[level] ?? level })),
    },
  ];
}

/**
 * 启动 ACP agent（stdio NDJSON 模式）。
 * 由 CLI 入口在无参数 / serve 子命令时调用，每个进程只调一次。
 */
export function startAgent() {
  // env-file 默认加载：ZCode Desktop 重定向过数据目录的用户靠它继承认证环境
  //（未设置时读取 ~/.zcode-acp.env，已有值优先，无副作用）。
  loadDefaultRuntimeEnv();

  const app = acp.agent({ name: AGENT_INFO.name });

  app
    .onRequest("initialize", () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        // 部分客户端的 IM 路径会先 session/load 再 prompt；声明 false 会让它在协商阶段
        // 判定 runtime 不可用（日志 supported:false → provider_process_exited）。
        loadSession: true,
        // 客户端续接任务时会调用 session/resume；不声明会被判为方法不存在。
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: AGENT_INFO,
    }))
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", (ctx) => {
      const record = {
        id: randomUUID(),
        cwd: normalizeCwd(ctx.params.cwd),
        zcodeSessionId: undefined,
        model: null,
        reasoningLevel: null,
        mode: null,
        stop: null,
      };
      records.push(record);
      return {
        sessionId: record.id,
        models: modelsPayload(record),
        modes: modesPayload(record),
        configOptions: configOptionsPayload(record),
      };
    })
    .onRequest("session/resume", (ctx) => {
      // 客户端的 IM 多轮对话会带着旧 sessionId 调 resume。bridge 进程重启后内存记录
      // 必然丢失，报 Resource not found 会让对话从第二轮起全部失败；
      // 正确做法是接受该 id 并重建记录（zcode 侧上下文丢了，由客户端重发消息弥补）。
      // 已有记录只刷新 cwd，保留 zcodeSessionId / model / reasoningLevel / mode，续接与选型不丢。
      const existing = findRecord(ctx.params.sessionId);
      const record = existing ?? {
        id: String(ctx.params.sessionId),
        zcodeSessionId: undefined,
        model: null,
        reasoningLevel: null,
        mode: null,
        stop: null,
      };
      record.cwd = normalizeCwd(ctx.params.cwd);
      if (!existing) records.push(record);
      return {
        models: modelsPayload(record),
        modes: modesPayload(record),
        configOptions: configOptionsPayload(record),
      };
    })
    .onRequest("session/load", (ctx) => {
      // 客户端的 IM 对话路径会先用 session/load 恢复会话再 prompt。
      // 本 agent 不持久化消息历史，无法重放历史 update；这里只重建会话记录，
      // 让后续 prompt 能用（历史为空由客户端自行处理）。
      const existing = findRecord(ctx.params.sessionId);
      const record = existing ?? {
        id: String(ctx.params.sessionId),
        zcodeSessionId: undefined,
        model: null,
        reasoningLevel: null,
        mode: null,
        stop: null,
      };
      record.cwd = normalizeCwd(ctx.params.cwd);
      if (!existing) records.push(record);
      return {
        models: modelsPayload(record),
        modes: modesPayload(record),
        configOptions: configOptionsPayload(record),
      };
    })
    // 部分宿主的私有扩展（ACP 标准里没有）：会话建立后会调它设置模型；
    // 其它客户端在用户切换模型时也会调它。不实现会 -32601 直接失败。
    // 只记录本机模型列表里的选择（provider::model 编码，见 models.js），
    // 未知值保持默认模型，避免客户端传任意串后静默跑非预期模型。
    .onRequest(
      "session/set_model",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      (ctx) => {
        const record = findRecord(ctx.params.sessionId);
        const selection = findModel(ctx.params.modelId);
        if (record && selection) {
          record.model = selection;
        }
        return {};
      },
    )
    // ACP 标准的模式设置：modeId 必须在 zcode 支持的模式枚举内，
    // 非法值静默忽略保持当前模式。设置成功后广播 current_mode_update，
    // 让编辑器的模式下拉框即时刷新（借鉴 zcode-acp-server 的做法）。
    .onRequest(
      "session/set_mode",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      async (ctx) => {
        const record = findRecord(ctx.params.sessionId);
        if (record && MODE_IDS.has(ctx.params.modeId)) {
          record.mode = ctx.params.modeId;
          await emitUpdate(record.id, {
            sessionUpdate: "current_mode_update",
            currentModeId: record.mode,
          }).catch(() => {});
        }
        return {};
      },
    )
    // ACP 标准的配置选项设置：configId 为本 agent 声明的选项 id。
    // 只接受思考级别选项且值在认可集合内；其余静默忽略，保持当前值。
    // 设置成功后广播 config_option_update（全量选项），让客户端 UI 即时刷新。
    .onRequest(
      "session/set_config_option",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      async (ctx) => {
        const record = findRecord(ctx.params.sessionId);
        if (
          record &&
          ctx.params.configId === REASONING_OPTION_ID &&
          isKnownReasoningLevel(ctx.params.value)
        ) {
          record.reasoningLevel = ctx.params.value;
          await emitUpdate(record.id, {
            sessionUpdate: "config_option_update",
            configOptions: configOptionsPayload(record),
          }).catch(() => {});
        }
        return {};
      },
    )
    .onRequest("session/prompt", async (ctx) => {
      const record = findRecord(ctx.params.sessionId);
      if (!record) throw acp.RequestError.sessionNotFound(String(ctx.params.sessionId));

      const text = promptText(ctx.params.prompt);
      if (!text.trim()) return { stopReason: "end_turn" };

      // 同一会话串行：并发 prompt 会争抢 zcodeSessionId，先拒绝后者。
      if (record.stop) return { stopReason: "refusal" };

      try {
        const result = await runTurn({
          cwd: record.cwd,
          text,
          resume: record.zcodeSessionId,
          mode: record.mode ?? DEFAULT_MODE,
          // 思考级别随模型一起进 provider 配置副本（见 models.js）。
          model: record.model
            ? { ...record.model, reasoningLevel: record.reasoningLevel ?? undefined }
            : record.reasoningLevel
              ? { reasoningLevel: record.reasoningLevel }
              : null,
          onStart: (stop) => {
            record.stop = stop;
          },
          onEvent: (event) => {
            // 先落 sessionId，即使这一轮被中断也能续接下一轮。
            if (event.sessionId) record.zcodeSessionId = event.sessionId;
            for (const update of eventToUpdates(event, record.cwd)) {
              // 不等待客户端确认：单条通知失败不应阻断整轮执行。
              emitUpdate(record.id, update).catch(() => {});
            }
          },
        });

        if (result.cancelled) return { stopReason: "cancelled" };
        if (result.error) {
          await emitText(record.id, result.error);
          return { stopReason: "refusal" };
        }
        return { stopReason: "end_turn" };
      } finally {
        record.stop = null;
      }
    })
    .onNotification("session/cancel", (ctx) => {
      findRecord(ctx.params.sessionId)?.stop?.();
    });

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  // 连接建立后注册客户端句柄，供通知发送使用。
  attachClient(app.connect(stream).client);

  // ACP 客户端断开 stdin 时进程应退出，避免留下僵尸子进程。
  process.stdin.on("end", () => process.exit(0));
}
