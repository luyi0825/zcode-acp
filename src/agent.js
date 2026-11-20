// ZCode ACP agent：把本机 zcode CLI 包装成 ACP v1 agent，
// 让 Zed / Neovim / OpenIdea 这类 ACP 客户端把 ZCode 当作编码 agent 使用。
import { Readable, Writable } from "node:stream";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { runTurn } from "./zcode.js";
import { eventToUpdates } from "./map-event.js";
import { attachClient, emitAvailableCommands, emitText, emitUpdate } from "./emitter.js";
import { discoverCapabilities, listSlashCommands } from "./commands.js";
import { rewriteSkillCommand } from "./slash-text.js";
import { splitTaskEnvelope } from "./prompt-envelope.js";
import { persistSession, restoreSession } from "./session-store.js";
import { forkZcodeSession } from "./fork.js";
import { logEvent } from "./logger.js";
import { loadDefaultRuntimeEnv } from "./runtime-env.js";
import { encodeModelId, findModel, isKnownReasoningLevel, listModels, REASONING_LEVELS } from "./models.js";

export const AGENT_INFO = { name: "zcode-acp", title: "ZCode", version: "0.5.6" };

// 认证方式声明：ACP Registry 校验 authMethods 非空，空数组会让上架 CI 直接拒绝。
// 凭据由 zcode CLI 自己持有（login / Desktop 签发），客户端无需提供任何东西，
// 因此这里只做「已就绪」宣告，authenticate 不读取参数。
const AUTH_METHODS = [
  {
    id: "zcode-credentials",
    name: "ZCode 登录态",
    description: "凭据来自 zcode CLI（zcode-acp login 或 ZCode Desktop 签发），无需在客户端填写",
  },
];

// 权限模式与 ZCode 选择器保持一致；edit 仅接受旧客户端回传，不作为可选项展示。
// 默认 yolo：headless 没有确认入口，与 zcode 对 --prompt 的默认一致。
const DEFAULT_MODE = "yolo";
const MODES = [
  { id: "plan", name: "计划模式", description: "编辑前先出计划。" },
  { id: "build", name: "变更前确认", description: "改文件前先问我。" },
  { id: "guarded", name: "自主模式", description: "在有风险时询问。" },
  { id: "yolo", name: "完全访问", description: "减少确认次数。" },
];
const MODE_IDS = new Set([...MODES.map((mode) => mode.id), "edit"]);

// 会话记录（本进程签发）。客户端回传的会话 id 只做等值比对，
// 命中的始终是本地记录对象，外部值不参与任何寻址。
// 上限：桥接进程可能被宿主长期复用，客户端反复 new/load 会让记录无限增长
//（每条还持有 cancel 闭包 → 子进程引用）。超出上限时淘汰最旧的**空闲**记录，
// 正在跑的轮次不淘汰，否则会丢 zcodeSessionId 造成上下文断裂。
const MAX_RECORDS = 64;
const records = [];

// 退出宽限（毫秒）：killTree 的 Windows 分支靠异步 spawn taskkill 杀进程树，
// 收到退出事件就立即 exit 可能抢在信号落地前——留一个短窗口让清理先生效。
const SHUTDOWN_GRACE_MS = 300;

/** 记录入表：超上限时从最早开始淘汰空闲项；满了且全忙则放弃淘汰（宁可不加）。 */
function trackRecord(record) {
  if (records.length >= MAX_RECORDS) {
    const idle = records.findIndex((candidate) => !candidate.busy);
    if (idle < 0) {
      // 满载且全忙：本次记录不入表，客户端拿着返回的 sessionId 调 prompt 会报
      // sessionNotFound——这种罕见失败没有日志时无从排查。
      logEvent("records.full", { total: records.length });
      return false;
    }
    records.splice(idle, 1);
  }
  records.push(record);
  return true;
}

/**
 * 新建一条会话记录。
 *
 * 规则：字段必须在此集中初始化——session/new、resume、load 三条路径都要完整
 * 记录，漏一个字段（如 busy）会让对应路径的串行保护失效。
 */
function createRecord(id, cwd) {
  return {
    id,
    cwd,
    zcodeSessionId: undefined,
    model: null,
    reasoningLevel: null,
    mode: null,
    // 当前轮次的取消句柄（由 runTurn 的 onStart 赋值），仅用于 session/cancel。
    stop: null,
    // 串行占位：进入 session/prompt 时同步置位，阻止同会话并发轮次。
    busy: false,
  };
}

/** 按本地签发值与回传值等值比对，返回对应的本地记录。 */
function findRecord(incomingId) {
  if (typeof incomingId !== "string") return undefined;
  for (const record of records) {
    if (record.id === incomingId) return record;
  }
  return undefined;
}

/**
 * ACP 的 cwd 必须是绝对路径且真实存在，否则 zcode --cwd 会直接报错退出。
 * 规则：任一校验失败都回退到用户主目录——cwd 是客户端给的，路径不可读
 * （权限不足等）时 statSync 会抛异常，不能让它冒泡成协议错误。
 */
function normalizeCwd(cwd) {
  if (typeof cwd === "string" && path.isAbsolute(cwd)) {
    try {
      if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
    } catch {
      // 权限不足或路径消失：落到下面的主目录回退。
    }
  }
  return process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
}

// zcode Read 工具支持的图片格式；固定扩展名避免 MIME 输入进入文件路径。
const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * 把 prompt 的文本与图片拆成 CLI 输入；纯图片消息补一条提示，避免被空文本检查跳过。
 * audio / embeddedContext 仍未声明支持，不下发给 CLI。
 */
function promptContent(blocks) {
  const content = blocks ?? [];
  const text = content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  const images = content
    .filter((block) => block.type === "image")
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
  if (!text.trim() && images.length > 0) return { text: "请分析所附图片。", images };
  return { text, images };
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
    // reasoningLevels 是 bridge 内部元数据，不塞进 ACP 的非标准模型字段。
    availableModels: models.availableModels.map(({ modelId, name, description }) => ({
      modelId,
      name,
      description,
    })),
    currentModelId: record?.model ? encodeModelId(record.model) : models.currentModelId,
  };
}

// ACP 新版用 configOptions 声明可调选项；旧版字段（models/modes）与之并存。
// category 是客户端识别选择器的语义标记，不能只靠自定义 id：
// 新版 schema 的 session/new 已无 models 字段，Zed 只认 category=model 的选项。
const MODEL_OPTION_ID = "model";
const REASONING_OPTION_ID = "thought_level";
const REASONING_OPTION_IDS = new Set([REASONING_OPTION_ID, "reasoning"]);
const REASONING_NAMES = {
  disabled: "关闭",
  enabled: "开启",
  none: "无",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
};

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

/** 当前模型的有效思考档位；选中模型已携带元数据时无需再次读配置。 */
function reasoningLevelsForRecord(record) {
  if (record?.model?.reasoningLevels) return record.model.reasoningLevels;
  const models = listModels();
  const currentId = record?.model ? encodeModelId(record.model) : models?.currentModelId;
  const current = models?.availableModels.find((model) => model.modelId === currentId);
  return current?.reasoningLevels ?? REASONING_LEVELS;
}

/**
 * 会话配置选项（configOptions 形态）：模型选择器 + 思考级别选择器。
 * 规则：
 * - 模型选项只在本机有真实模型列表时声明；回退单模型不可切换，不摆死选择器；
 * - 思考档位与默认值来自当前模型的有效规则，模型明确不支持时不返回该选择器。
 */
function configOptionsPayload(record) {
  const options = [];
  const models = listModels();
  if (models) {
    options.push({
      id: MODEL_OPTION_ID,
      name: "模型",
      description: "本机可用的 ZCode 模型",
      category: "model",
      type: "select",
      currentValue: record?.model ? encodeModelId(record.model) : models.currentModelId,
      options: models.availableModels.map(({ modelId, name }) => ({ value: modelId, name })),
    });
  }
  const levels = reasoningLevelsForRecord(record);
  if (levels.length > 0) {
    const selected = record?.reasoningLevel;
    const currentValue = selected && levels.includes(selected) ? selected : levels.at(-1);
    options.push({
      id: REASONING_OPTION_ID,
      name: "思考级别",
      description: "当前 ZCode 模型支持的推理深度（reasoningLevel）",
      category: "thought_level",
      type: "select",
      currentValue,
      options: levels.map((level) => ({ value: level, name: REASONING_NAMES[level] ?? level })),
    });
  }
  return options;
}

/**
 * 本机已知的命令 / 技能名集合；发现失败返回空集合（此时不改写，按原样下发）。
 * 与命令菜单共用 discoverCapabilities 的进程级缓存，正常不会重复读 CLI。
 */
async function knownNames() {
  try {
    const { skills, commands } = await discoverCapabilities();
    return {
      skills: new Set(skills.map((skill) => skill.name)),
      commands: new Set(commands.map((command) => command.name)),
    };
  } catch {
    return { skills: new Set(), commands: new Set() };
  }
}

/**
 * 异步推送斜杠命令菜单；读取失败时推空列表（清掉客户端残留条目）。
 */
async function emitSlashCommands(sessionId) {
  let commands = [];
  try {
    commands = await listSlashCommands();
  } catch {
    // 命令发现是增强项，失败按空列表处理。
  }
  await emitAvailableCommands(sessionId, commands);
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
    .onRequest("initialize", (ctx) => {
      // 客户端连接的唯一现场：宿主侧行为异常（如不显示 agent 版本）时靠它对版本与来源。
      logEvent("initialize", {
        client: ctx.params?.clientInfo?.name,
        clientVersion: ctx.params?.clientInfo?.version,
        agentVersion: AGENT_INFO.version,
      });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          // 部分客户端的 IM 路径会先 session/load 再 prompt；声明 false 会让它在协商阶段
          // 判定 runtime 不可用（日志 supported:false → provider_process_exited）。
          loadSession: true,
          // 客户端续接任务时会调用 session/resume；不声明会被判为方法不存在。
          // fork 是 unstable 能力：OpenIDEA 按该声明启用 fork 入口（实现见 session/fork）。
          sessionCapabilities: { resume: {}, fork: {} },
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
        },
        authMethods: AUTH_METHODS,
        agentInfo: AGENT_INFO,
      };
    })
    .onRequest("authenticate", () => ({}))
    .onRequest("session/new", (ctx) => {
      const record = createRecord(randomUUID(), normalizeCwd(ctx.params.cwd));
      trackRecord(record);
      // 命令菜单在响应之后异步推：读命令要起子进程（约百毫秒级），
      // 同步等待会拖慢每个新会话；菜单晚到不影响会话可用。
      void emitSlashCommands(record.id);
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
      // 正确做法是接受该 id 并重建记录，再从落盘恢复 zcodeSessionId 等续接状态
      //（见 session-store.js），续接不断、也不再新建重复会话。
      // 已有记录只刷新 cwd，保留 zcodeSessionId / model / reasoningLevel / mode，续接与选型不丢。
      const existing = findRecord(ctx.params.sessionId);
      const record = existing ?? createRecord(String(ctx.params.sessionId), normalizeCwd(ctx.params.cwd));
      record.cwd = normalizeCwd(ctx.params.cwd);
      if (!existing) {
        restoreSession(record);
        trackRecord(record);
      }
      return {
        models: modelsPayload(record),
        modes: modesPayload(record),
        configOptions: configOptionsPayload(record),
      };
    })
    .onRequest("session/load", (ctx) => {
      // 客户端的 IM 对话路径会先用 session/load 恢复会话再 prompt。
      // 本 agent 不持久化消息历史，无法重放历史 update；这里重建会话记录并从落盘
      // 恢复续接状态（见 session-store.js），让后续 prompt 能续接原 zcode 会话
      //（历史为空由客户端自行处理）。
      const existing = findRecord(ctx.params.sessionId);
      const record = existing ?? createRecord(String(ctx.params.sessionId), normalizeCwd(ctx.params.cwd));
      record.cwd = normalizeCwd(ctx.params.cwd);
      if (!existing) {
        restoreSession(record);
        trackRecord(record);
      }
      return {
        models: modelsPayload(record),
        modes: modesPayload(record),
        configOptions: configOptionsPayload(record),
      };
    })
    // ACP unstable 的 session/fork：复制历史到独立新会话，后续 prompt 不影响原会话。
    // fork 经 zcode app-server 完成（见 fork.js）；新会话继承模型 / 思考档位 / 模式选择。
    // 源记录未命中时与 resume/load 同规则重建（bridge 重启后从落盘恢复续接状态）。
    // unstable 方法不在 SDK stable 方法表里，必须显式传 params 解析器。
    .onRequest(
      "session/fork",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      async (ctx) => {
        const existing = findRecord(ctx.params.sessionId);
        const source = existing ?? createRecord(String(ctx.params.sessionId), normalizeCwd(ctx.params.cwd));
        if (!existing) {
          restoreSession(source);
          trackRecord(source);
        }
        // zcode 侧也禁止运行中 fork；这里先挡一层，避免白起一个 app-server。
        if (source.busy) throw acp.RequestError.internalError(null, "会话正在执行中，无法 fork");
        const cwd = normalizeCwd(ctx.params.cwd);
        const record = createRecord(randomUUID(), cwd);
        record.model = source.model;
        record.reasoningLevel = source.reasoningLevel;
        record.mode = source.mode;
        // 无 zcodeSessionId 即还没跑过对话：无历史可复制，fork 退化为新建。
        if (source.zcodeSessionId) {
          const forkedId = await forkZcodeSession({ cwd, sessionId: source.zcodeSessionId });
          if (forkedId) record.zcodeSessionId = forkedId;
        }
        trackRecord(record);
        persistSession(record);
        void emitSlashCommands(record.id);
        return {
          sessionId: record.id,
          models: modelsPayload(record),
          modes: modesPayload(record),
          configOptions: configOptionsPayload(record),
        };
      },
    )
    // 部分宿主的私有扩展（ACP 标准里没有）：会话建立后会调它设置模型；
    // 其它客户端在用户切换模型时也会调它。不实现会 -32601 直接失败。
    // 只记录本机模型列表里的选择（provider::model 编码，见 models.js），
    // 未知值保持默认模型，避免客户端传任意串后静默跑非预期模型。
    .onRequest(
      "session/set_model",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      async (ctx) => {
        const record = findRecord(ctx.params.sessionId);
        const selection = findModel(ctx.params.modelId);
        if (record && selection) {
          record.model = selection;
          // 旧档位可能不受新模型支持，清空后由 configOptionsPayload 回显新模型默认档位。
          if (!isKnownReasoningLevel(record.reasoningLevel, selection.reasoningLevels)) {
            record.reasoningLevel = null;
          }
          persistSession(record);
          await emitUpdate(record.id, {
            sessionUpdate: "config_option_update",
            configOptions: configOptionsPayload(record),
          }).catch(() => {});
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
          persistSession(record);
          await emitUpdate(record.id, {
            sessionUpdate: "current_mode_update",
            currentModeId: record.mode,
          }).catch(() => {});
        }
        return {};
      },
    )
    // ACP 标准的配置选项设置：configId 为本 agent 声明的选项 id。
    // 接受模型与思考级别选项，非法值静默忽略保持当前值。
    // 设置成功后广播 config_option_update（全量选项），让客户端 UI 即时刷新。
    .onRequest(
      "session/set_config_option",
      (params) => (typeof params === "object" && params !== null ? params : {}),
      async (ctx) => {
        const record = findRecord(ctx.params.sessionId);
        if (!record) return {};
        if (ctx.params.configId === MODEL_OPTION_ID) {
          // 与 set_model 同规则：只认本机模型列表内的选择，未知值保持默认。
          const selection = findModel(ctx.params.value);
          if (selection) {
            record.model = selection;
            // 旧档位可能不受新模型支持，清空后由 configOptionsPayload 回显新模型默认档位。
            if (!isKnownReasoningLevel(record.reasoningLevel, selection.reasoningLevels)) {
              record.reasoningLevel = null;
            }
            persistSession(record);
            await emitUpdate(record.id, {
              sessionUpdate: "config_option_update",
              configOptions: configOptionsPayload(record),
            }).catch(() => {});
          }
          return {};
        }
        if (
          REASONING_OPTION_IDS.has(ctx.params.configId) &&
          isKnownReasoningLevel(ctx.params.value, reasoningLevelsForRecord(record))
        ) {
          record.reasoningLevel = ctx.params.value;
          persistSession(record);
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

      const { text, images } = promptContent(ctx.params.prompt);
      if (!text.trim()) return { stopReason: "end_turn" };

      // 同一会话串行：并发 prompt 会争抢 zcodeSessionId，先拒绝后者。
      // 占位必须在这里同步完成：record.stop 由 runTurn 的 onStart 才赋值，
      // 中间隔着下面的 await，两个并发请求都能穿过检查各自 spawn 一个 zcode。
      if (record.busy) return { stopReason: "refusal" };
      record.busy = true;
      try {
        // 先拆 MiCO 信封（用户原话留作正文、模板走附件），再改写 `/技能名`
        //（只认首行斜杠命令）；两者都在拼附件说明之前——CLI 只认开头的斜杠命令。
        const split = splitTaskEnvelope(text);
        const commandText = rewriteSkillCommand(split.prompt, await knownNames());

        const attachmentDir = images.length > 0 ? mkdtempSync(path.join(tmpdir(), "zcode-acp-images-")) : null;
        try {
          // 本轮是否已向客户端发过正文：内置斜杠命令（/compact、/goal）不产生
          // model.streaming 事件，回复只在 runTurn 返回的 content 里，需要在这里补发。
          let sawText = false;
          const attachments = images.map((image, index) => {
            const extension = IMAGE_EXTENSIONS[image.mimeType];
            if (!extension) throw new Error(`不支持的图片类型：${image.mimeType}；仅支持 PNG/JPEG/GIF/WebP`);
            const data = Buffer.from(image.data, "base64");
            if (data.length === 0) throw new Error("图片内容为空");
            const file = path.join(attachmentDir, `image-${index}${extension}`);
            writeFileSync(file, data);
            return file;
          });
          const prompt = attachments.length > 0
            ? `${commandText}\n\n请使用 Read 工具读取以下图片后再回答：\n${attachments.join("\n")}`
            : commandText;
          const result = await runTurn({
            cwd: record.cwd,
            text: prompt,
            // MiCO 模板走附件：进模型上下文，但不进会话标题与首条消息。
            envelope: split.envelope,
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
              // 先落 sessionId，即使这一轮被中断也能续接下一轮；变化时落盘，
              // bridge 重启后 resume/load 据此恢复续接（见 session-store.js）。
              if (event.sessionId && event.sessionId !== record.zcodeSessionId) {
                record.zcodeSessionId = event.sessionId;
                persistSession(record);
              }
              // model.streaming 是正文的唯一来源；命令类轮次没有它。
              if (event.type === "model.streaming" && event.payload?.kind === "text_delta") sawText = true;
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
          // 命令类轮次的回复没有流式增量，需要在这里补发，否则客户端什么都看不到。
          if (!sawText && result.content) await emitText(record.id, result.content);
          return { stopReason: "end_turn" };
        } finally {
          record.stop = null;
          if (attachmentDir) rmSync(attachmentDir, { recursive: true, force: true });
        }
      } catch (error) {
        // runTurn 的启动失败（CLI 找不到 / provider 配置副本写盘失败）与图片校验抛错
        // 在此收口：不兜底会冒泡成协议级 Internal error，用户看不到任何定位指引。
        const message = error instanceof Error ? error.message : String(error);
        logEvent("prompt.error", { sessionId: record.id, message: message.slice(0, 500) });
        await emitText(record.id, message).catch(() => {});
        return { stopReason: "refusal" };
      } finally {
        // 串行占位必须在所有返回路径上释放，否则该会话此后一律 refusal。
        record.busy = false;
      }
    })
    .onNotification("session/cancel", (ctx) => {
      findRecord(ctx.params.sessionId)?.stop?.();
    });

  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  // 连接建立后注册客户端句柄，供通知发送使用。
  attachClient(app.connect(stream).client);

  // 宿主断开 / 终止信号时先终止在跑的 zcode 子进程树再退出：POSIX 下 zcode
  // 自成进程组（detached），宿主杀 bridge 进程组不会波及它，不清理会留下孤儿
  // 继续消耗 token / 改文件。空闲记录的 stop 为 null，重复触发安全。
  const shutdown = () => {
    const running = records.filter((record) => record.busy);
    if (running.length > 0) {
      logEvent("shutdown", { killed: running.length });
      for (const record of running) record.stop?.();
    }
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  };
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
