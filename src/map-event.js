// stream-json 事件 → ACP session/update。
// 只做翻译，不碰协议细节：输入是 zcode 的一行事件，输出是 ACP 的 update 对象。
import path from "node:path";

/** zcode 工具名 → ACP ToolKind（决定客户端图标与分组）。 */
const TOOL_KINDS = {
  Read: "read",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "execute",
};

// 单条输出上限，避免把超大内容整段推给客户端。
const MAX_TEXT = 20000;
const MAX_TOOL_OUTPUT = 4000;
const MAX_TITLE = 160;

/** 取字符串并裁剪到上限；非字符串返回空串。 */
function textOf(value, max) {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 解析工具入参里的文件路径 → ACP locations。 */
function locationsOf(input, cwd) {
  const filePath = input?.file_path ?? input?.path;
  if (typeof filePath !== "string" || !filePath) return undefined;
  return [{ path: path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath) }];
}

/** 标题取工具入参里有代表性的一个字段，避免把整段 JSON 塞给客户端。 */
function titleOf(toolName, input) {
  const subject = input?.file_path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query;
  const summary = textOf(subject, MAX_TITLE).replace(/\s+/g, " ").trim();
  return summary ? `${toolName}: ${summary}` : toolName;
}

/**
 * 工具结果可能是字符串或 `{ content }` 结构，统一压成短文本。
 * 其他形态直接丢弃：结构化对象原样转发对客户端没有意义。
 */
function outputTextOf(output) {
  if (typeof output === "string") return textOf(output, MAX_TOOL_OUTPUT);
  if (typeof output?.content === "string") return textOf(output.content, MAX_TOOL_OUTPUT);
  return "";
}

/**
 * 把单个 zcode 事件映射为 ACP update 列表（可能为空）。
 *
 * 规则：
 * - `model.streaming` 的 text_delta → agent_message_chunk；reasoning_delta → agent_thought_chunk。
 * - `tool_call` → tool_call；`tool.updated` 的 result → tool_call_update。
 * - `session.updated` 同时携带 `usage` 和 `contextWindow` 时 → usage_update（上报 token 使用量）。
 * - 其他事件（hook、标题）忽略，避免污染客户端 UI。
 */
export function eventToUpdates(event, cwd) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return [];

  if (event.type === "model.streaming") {
    return streamingUpdates(payload);
  }
  if (event.type === "tool_call") {
    return toolCallUpdates(payload, cwd);
  }
  if (event.type === "tool.updated" && payload.kind === "result") {
    return toolResultUpdates(payload);
  }
  // zcode 在每轮结束时发一条同时携带 usage 和 contextWindow 的 session.updated，
  // 把它翻译成 ACP 的 usage_update，让客户端能展示 token 使用量。
  if (event.type === "session.updated" && payload.usage != null && payload.contextWindow != null) {
    return usageUpdates(payload);
  }
  return [];
}

function streamingUpdates(payload) {
  if (payload.kind !== "text_delta" && payload.kind !== "reasoning_delta") return [];
  const text = textOf(payload.delta, MAX_TEXT);
  if (!text) return [];
  const sessionUpdate =
    payload.kind === "text_delta" ? "agent_message_chunk" : "agent_thought_chunk";
  return [{ sessionUpdate, content: { type: "text", text } }];
}

function toolCallUpdates(payload, cwd) {
  const toolCallId = textOf(payload.toolCallId, 128);
  if (!toolCallId) return [];
  const toolName = textOf(payload.toolName, 64);
  const update = {
    sessionUpdate: "tool_call",
    toolCallId,
    title: titleOf(toolName, payload.input),
    name: toolName,
    kind: TOOL_KINDS[toolName] ?? "other",
    status: "in_progress",
  };
  const locations = locationsOf(payload.input, cwd);
  if (locations) update.locations = locations;
  return [update];
}

function toolResultUpdates(payload) {
  const toolCallId = textOf(payload.toolCallId, 128);
  if (!toolCallId) return [];
  const text = outputTextOf(payload.output ?? payload.result);
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: payload.success === false ? "failed" : "completed",
      content: text ? [{ type: "content", content: { type: "text", text } }] : [],
    },
  ];
}

/**
 * 把 zcode 的 usage（JSON 字符串）+ contextWindow 翻译成 ACP usage_update。
 *
 * 规则：
 * - zcode 的 usage 是 JSON 字符串（非对象），需先 parse。
 * - used 取 totalTokens（输入+输出），反映该轮实际 token 消耗。
 * - size 取 contextWindow，即模型的上下文窗口上限。
 * - parse 失败或值非法时返回空列表，不阻断执行。
 */
function usageUpdates(payload) {
  let usage;
  try {
    usage = typeof payload.usage === "string" ? JSON.parse(payload.usage) : payload.usage;
  } catch {
    return [];
  }
  if (!usage || typeof usage !== "object") return [];
  const used = Number(usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
  if (!Number.isFinite(used) || used < 0) return [];
  const size = Number(payload.contextWindow ?? 0);
  return [
    {
      sessionUpdate: "usage_update",
      used,
      size: Number.isFinite(size) && size > 0 ? size : 0,
    },
  ];
}
