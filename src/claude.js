// Mutica 的 Claude 适配器使用 Claude Code stream-json，而不是 ACP。
// 这里只适配它实际下发的单轮消息、--resume 与 interrupt，执行仍复用 zcode headless。
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { loadDefaultRuntimeEnv } from "./runtime-env.js";
import { findModel, listModels, REASONING_LEVELS } from "./models.js";
import { discoverCapabilities } from "./commands.js";
import { rewriteSkillCommand } from "./slash-text.js";
import { runTurn } from "./zcode.js";

const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** Mutica 与 ZCode 使用同名档位；开关型配置不伪装成强度滑块。 */
export function effortLevelsForModel(reasoningLevels = REASONING_LEVELS) {
  return CLAUDE_EFFORT_LEVELS.filter((level) => reasoningLevels.includes(level));
}

/** 只接受当前模型实际支持的同名档位，不兼容时回退模型默认值。 */
export function reasoningLevelForEffort(effort, reasoningLevels = REASONING_LEVELS) {
  return reasoningLevels.includes(effort) ? effort : undefined;
}

/**
 * 本机已知的命令 / 技能名集合；发现失败返回空集合（此时不改写，按原样下发）。
 * 与能力清单共用 discoverCapabilities 的进程级缓存，正常不会重复读 CLI。
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

function parseArgs(args) {
  const options = { model: "zcode", mode: "yolo", resume: undefined, effort: undefined };
  for (let index = 0; index < args.length; index++) {
    const value = args[index + 1];
    switch (args[index]) {
      case "--model":
        options.model = value || options.model;
        index++;
        break;
      case "--effort":
        options.effort = value;
        index++;
        break;
      case "--resume":
        options.resume = value;
        index++;
        break;
      case "--permission-mode":
        // Mutica 固定传 bypassPermissions；保留 plan 的只读语义，其余沿用 headless 默认 yolo。
        options.mode = value === "plan" ? "plan" : "yolo";
        index++;
        break;
      // 这些选项带值但不影响 ZCode 调用，跳过值可避免把路径误认成命令。
      case "--mcp-config":
      case "--permission-prompt-tool":
      case "--plugin-dir":
        index++;
        break;
    }
  }
  return options;
}

function messageText(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

// 单条工具结果上限：Bash 动辄几十 KB 输出，整段推给宿主会撑爆消息体。
const MAX_TOOL_RESULT = 20000;

// zcode 的 usage 用驼峰，宿主（MiCO Claude 适配器）按 Claude Code 的 snake_case 累加 token。
// reasoning 是 output 的子集，单列会被重复计费，故不映射；inputTokens 需扣缓存，单列处理。
const USAGE_FIELDS = {
  outputTokens: "output_tokens",
  cacheReadTokens: "cache_read_input_tokens",
  cacheWriteTokens: "cache_creation_input_tokens",
};

/** 累加两份 usage；逐字段相加，缺失字段按 0 处理。 */
function addUsage(base, extra) {
  const sum = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extra)) {
    sum[key] = (sum[key] ?? 0) + value;
  }
  return sum;
}

/**
 * 取一次模型请求的 token 用量。
 *
 * 规则：
 * - zcode 每次请求结束发一条 session.updated，payload.usage 是 JSON 字符串而非对象；
 * - 该次 inputTokens 是这次请求的完整输入，属于独立计费量，多次请求需累加；
 * - zcode 的 inputTokens **含缓存**（inputTokenDetails = noCache + cacheRead + cacheWrite），
 *   而 Claude 的 input_tokens 不含缓存，故扣减后上报，避免宿主把缓存重复计入；
 * - 无 usage、parse 失败或值非法时返回 null，不阻断执行。
 */
export function usageOf(event) {
  if (event?.type !== "session.updated") return null;
  const raw = event.payload?.usage;
  if (raw == null) return null;
  let usage;
  try {
    usage = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!usage || typeof usage !== "object") return null;
  const fields = {};
  for (const [from, to] of Object.entries(USAGE_FIELDS)) {
    const value = Number(usage[from]);
    if (Number.isFinite(value) && value >= 0) fields[to] = value;
  }
  const input = Number(usage.inputTokens);
  if (Number.isFinite(input) && input >= 0) {
    const cached = (fields.cache_read_input_tokens ?? 0) + (fields.cache_creation_input_tokens ?? 0);
    fields.input_tokens = Math.max(0, input - cached);
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

// 语义事件保活间隔：宿主按「距上次语义事件」判活（实测预算 10 分钟），
// 纯文本长任务不产生工具事件，需要定期把已累积文本作为一段发出。
const SEMANTIC_KEEPALIVE_MS = 60_000;

/** 工具输出裁剪到上限；非字符串返回空串。 */
function clipToolResult(value) {
  if (typeof value !== "string") return "";
  return value.length > MAX_TOOL_RESULT ? `${value.slice(0, MAX_TOOL_RESULT)}…` : value;
}

/**
 * zcode 事件 → Claude stream-json 语义消息（assistant / user）。
 *
 * 背景：宿主按「距上次语义事件」判断任务是否还活着，超时即按
 * provider_zero_events 判死。整轮只回一条最终结果时，跑十几分钟的长任务
 * 必然被误杀；这里把工具流实时翻成 assistant(tool_use) / user(tool_result)，
 * 让每次工具起止都成为一次可观测进展。
 *
 * 规则：
 * - 文本增量只累积不立刻发：碎片化的 assistant 消息在客户端会变成一串气泡；
 * - 工具 scheduled 是收口点，累积文本与该 tool_use 合成一条 assistant 消息；
 * - 工具 result 翻成 user 消息里的 tool_result，is_error 取 success === false；
 * - flush 用于收尾与长时间纯文本保活，只吐尚未发出的文本，不重复；
 * - 其余事件返回 null，调用方据此不发任何消息。
 */
export function createSemanticStream() {
  let pendingText = "";
  let produced = false;

  /** 取出并清空已累积的文本：工具边界与 flush 都用它收口，保证不重复发送。 */
  function takeText() {
    const text = pendingText;
    pendingText = "";
    return text;
  }

  function build(event) {
    if (event?.type === "model.streaming" && event.payload?.kind === "text_delta") {
      if (typeof event.payload.delta === "string") pendingText += event.payload.delta;
      return null;
    }
    if (event?.type !== "tool.updated") return null;
    const payload = event.payload ?? {};
    const toolUseId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
    if (!toolUseId) return null;

    if (payload.kind === "scheduled") {
      const content = [];
      const text = takeText();
      if (text) content.push({ type: "text", text });
      // 工具名缺失也照发：宿主靠这张卡片判断「有工具在跑」，不能静默丢弃。
      content.push({
        type: "tool_use",
        id: toolUseId,
        name: payload.toolName || "unknown",
        input: payload.input ?? {},
      });
      return { type: "assistant", message: { role: "assistant", content } };
    }

    if (payload.kind === "result") {
      const raw = payload.result ?? payload.output;
      const text = typeof raw === "string" ? raw : raw?.content;
      return {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: clipToolResult(text),
              is_error: raw?.success === false,
            },
          ],
        },
      };
    }
    return null;
  }

  return {
    /** 本轮是否已产出过语义消息：收尾时据此决定要不要补整段兜底。 */
    produced: () => produced,

    consume(event) {
      const semantic = build(event);
      if (semantic) produced = true;
      return semantic;
    },

    flush() {
      const text = takeText();
      if (!text.trim()) return null;
      produced = true;
      return { type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
    },
  };
}

/** 发一条语义消息：补齐 id / session_id / uuid，宿主只认完整形态。 */
function emitSemantic(sessionId, modelName, semantic) {
  if (!semantic) return;
  const message =
    semantic.type === "assistant"
      ? { id: randomUUID(), type: "message", model: modelName, ...semantic.message }
      : semantic.message;
  emit({
    type: semantic.type,
    message,
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  });
}

function discoveryModels() {
  const models = listModels();
  if (!models) {
    // 配置不可读时保留一个可运行的回退项，实际执行仍使用 ZCode 默认模型。
    return [
      {
        value: "claude-sonnet-4-6",
        resolvedModel: "claude-sonnet-4-6",
        displayName: "ZCode 默认模型",
        description: "ZCode 当前默认模型（Claude 协议兼容）",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high"],
        supportsAdaptiveThinking: false,
        supportsThinkingOff: false,
      },
    ];
  }
  return models.availableModels.map((model) => {
    const supportedEffortLevels = effortLevelsForModel(model.reasoningLevels);
    return {
      value: model.modelId,
      resolvedModel: model.modelId,
      displayName: model.name,
      description: "ZCode 模型",
      supportsEffort: supportedEffortLevels.length > 0,
      supportedEffortLevels,
      supportsAdaptiveThinking: false,
      supportsThinkingOff: false,
    };
  });
}

/**
 * 把本地命令 / 技能 / 子 agent 转成 Mutica 侧的清单。
 *
 * 规则：
 * - 自定义命令按 `/<name>` 暴露：它们的调用形式就是裸斜杠命令；
 * - 技能按 `/<name>` 暴露（与命令同形）：实测裸写 `/技能名` 在 zcode 里会得到
 *   "Unknown command"，但 **不带斜杠的 `skill <name>` 更糟**——模型可能只回一句
 *   "已加载"而根本没调用 Skill 工具。真正可靠的是 `/skill <name>`；
 *   因此清单里给 `/<技能名>`（与命令统一），由 bridge 在 session/prompt 前
 *   改写成 `/skill <技能名>`（见 agent.js 的 rewriteSkillCommand）；
 * - 子 agent 进 agents（Agent 工具的 subagent_type 取值）；
 * - 发现失败返回空清单而不抛错：能力清单是增强项，不应阻断模型发现。
 */
async function capabilityPayload() {
  try {
    const { commands, skills, subagents } = await discoverCapabilities();
    const availableCommands = [
      ...commands.map((command) => ({ name: `/${command.name}`, description: command.description })),
      ...skills.map((skill) => ({ name: `/${skill.name}`, description: skill.description })),
    ];
    return {
      commands: availableCommands,
      agents: subagents.map((agent) => ({ name: agent.name, description: agent.description })),
    };
  } catch {
    return { commands: [], agents: [] };
  }
}

// Mutica 模型发现只读 control_response 里的模型能力，不应触发真实模型调用。
async function emitDiscoveryResponse(requestId) {
  const { commands, agents } = await capabilityPayload();
  emit({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        commands,
        agents,
        models: discoveryModels(),
        current_permission_mode: "bypassPermissions",
        capabilities: [],
      },
    },
  });
}

function readPrompt(onInterrupt) {
  let resolveInput;
  let rejectInput;
  let settled = false;
  let sessionId;
  const input = new Promise((resolve, reject) => {
    resolveInput = resolve;
    rejectInput = reject;
  });
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const fail = (message) => {
    if (settled) return;
    settled = true;
    rejectInput(new Error(message));
  };

  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail("Claude stream-json 输入不是有效 JSON");
      return;
    }
    if (message.type === "control_request" && message.request?.subtype === "initialize" && !settled) {
      settled = true;
      // 响应要先发完再放行：发现清单要读 CLI（异步），提前 resolve 会让进程退出、
      // 客户端收不到 control_response。故这里用 then 串行化，不 await 阻塞读循环。
      emitDiscoveryResponse(message.request_id).finally(() => resolveInput(null));
      return;
    }
    if (message.type === "control_request" && message.request?.subtype === "interrupt") {
      onInterrupt();
      emit({
        type: "control_response",
        response: { subtype: "success", request_id: message.request_id },
      });
      return;
    }
    if (message.type !== "user" || settled) return;
    const text = messageText(message);
    if (!text.trim()) {
      fail("Claude 用户消息缺少文本内容");
      return;
    }
    settled = true;
    sessionId = typeof message.session_id === "string" ? message.session_id : undefined;
    resolveInput(text);
  });
  lines.on("close", () => fail("Claude 输入结束，未收到用户消息"));

  return { input, lines, sessionId: () => sessionId };
}

/** 启动 Mutica 所需的 Claude Code stream-json 兼容入口。 */
export async function startClaude(args) {
  loadDefaultRuntimeEnv();
  const options = parseArgs(args);
  let stop;
  const { input, lines, sessionId: incomingSessionId } = readPrompt(() => stop?.());

  try {
    const text = await input;
    if (text === null) return;
    let sessionId = options.resume || incomingSessionId() || randomUUID();
    // init 事件是同步发出的（由首个 sessionId 事件驱动），清单必须先取好：
    // 与 initialize 共用一个进程级缓存，正常路径不会重复读 CLI。
    const capabilities = await capabilityPayload().catch(() => ({ commands: [], agents: [] }));
    let initialized = false;
    const emitInit = () => {
      if (initialized) return;
      initialized = true;
      emit({
        type: "system",
        subtype: "init",
        cwd: process.cwd(),
        session_id: sessionId,
        // 工具清单来自 zcode 的实际工具集：Agent 对应子 agent 派发。
        tools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "Agent"],
        mcp_servers: [],
        model: options.model,
        permissionMode: options.mode === "yolo" ? "bypassPermissions" : options.mode,
        slash_commands: capabilities.commands.map((command) => command.name),
      });
    };

    const selection = findModel(options.model);
    const reasoningLevel = reasoningLevelForEffort(
      options.effort,
      selection?.reasoningLevels ?? REASONING_LEVELS,
    );
    let model = null;
    if (selection) model = { ...selection, reasoningLevel };
    else if (reasoningLevel) model = { reasoningLevel };
    // Mutica 下发的 `/技能名` 要改写成 `/skill 技能名`：裸写会被 CLI 判为未知命令。
    const commandText = rewriteSkillCommand(text, await knownNames());
    const startedAt = Date.now();
    const semantics = createSemanticStream();
    // zcode 每次模型请求发一条带 usage 的 session.updated；该次 inputTokens 是这次请求的
    // 完整输入，多次请求各自计费，整轮累加才是这轮真实消耗（结果的 usage 上报口径）。
    let usage;
    // 保活：长任务在两次工具调用之间可能长时间没有语义事件，宿主会判死。
    const keepalive = setInterval(() => {
      emitSemantic(sessionId, options.model, semantics.flush());
    }, SEMANTIC_KEEPALIVE_MS);
    keepalive.unref();
    const result = await runTurn({
      cwd: process.cwd(),
      text: commandText,
      resume: options.resume,
      mode: options.mode,
      model,
      onStart: (stopTurn) => {
        stop = stopTurn;
      },
      onEvent: (event) => {
        if (event.sessionId) {
          sessionId = event.sessionId;
          emitInit();
        }
        const turnUsage = usageOf(event);
        if (turnUsage) usage = addUsage(usage, turnUsage);
        emitSemantic(sessionId, options.model, semantics.consume(event));
      },
    }).finally(() => clearInterval(keepalive));
    emitInit();

    const content = result.error ?? result.content ?? "";
    // 收尾：先吐最后一段未发出的文本，避免结尾回复丢失。
    emitSemantic(sessionId, options.model, semantics.flush());
    // 正常路径下文本已随语义消息分段发出，整段再发一次会让宿主侧回复重复；
    // 只有全程没有任何增量事件（老版本 CLI 或纯错误）时才回退成整段发出。
    if (content && (result.error || !semantics.produced())) {
      emitSemantic(sessionId, options.model, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: content }] },
      });
    }
    emit({
      type: "result",
      subtype: "success",
      is_error: Boolean(result.error),
      result: content,
      session_id: sessionId,
      duration_ms: Date.now() - startedAt,
      num_turns: 1,
      // 宿主按 Claude Code 的 result.usage 兜底累加 token 用量；缺失时不写该字段。
      ...(usage ? { usage } : {}),
    });
    if (result.error) process.exitCode = 1;
  } catch (error) {
    const content = error instanceof Error ? error.message : String(error);
    emit({
      type: "result",
      subtype: "success",
      is_error: true,
      result: content,
      session_id: options.resume || incomingSessionId() || randomUUID(),
      duration_ms: 0,
      num_turns: 1,
    });
    process.exitCode = 1;
  } finally {
    lines.close();
  }
}
