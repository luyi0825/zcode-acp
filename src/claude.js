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
        if (!event.sessionId) return;
        sessionId = event.sessionId;
        emitInit();
      },
    });
    emitInit();

    const content = result.error ?? result.content ?? "";
    emit({
      type: "assistant",
      message: {
        id: randomUUID(),
        model: options.model,
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: content }],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    });
    emit({
      type: "result",
      subtype: "success",
      is_error: Boolean(result.error),
      result: content,
      session_id: sessionId,
      duration_ms: Date.now() - startedAt,
      num_turns: 1,
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
