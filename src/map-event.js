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
  TodoWrite: "think",
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

/** 工具入参里的文件路径 → 绝对路径；非字符串或空串返回 undefined。 */
function absolutePathOf(filePath, cwd) {
  if (typeof filePath !== "string" || !filePath) return undefined;
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
}

/** 解析工具入参里的文件路径 → ACP locations。 */
function locationsOf(input, cwd) {
  const filePath = absolutePathOf(input?.file_path ?? input?.path, cwd);
  return filePath ? [{ path: filePath }] : undefined;
}

/** 标题取工具入参里有代表性的一个字段，避免把整段 JSON 塞给客户端。 */
function titleOf(toolName, input) {
  const subject = input?.file_path ?? input?.command ?? input?.pattern ?? input?.url ?? input?.query;
  const summary = textOf(subject, MAX_TITLE).replace(/\s+/g, " ").trim();
  return summary ? `${toolName}: ${summary}` : toolName;
}

/** 工具结果的 toolCallId（裁剪后的字符串，缺失时为空串）。 */
function toolCallIdOf(payload) {
  return textOf(payload.toolCallId, 128);
}

/**
 * 结构化改动 → ACP diff 内容块。
 *
 * 规则：
 * - zcode 的 `display.structuredPatch` 是 unified diff 的 hunk 数组，每行带 " +-" 前缀；
 *   ACP 的 diff 要的是改前/改后行集（不是 unified diff 字符串），逐 hunk 拆成两侧；
 * - 丢掉 "-" 行即新增侧（上下文 + 增加行），丢掉 "+" 行即原始侧（上下文 + 删除行）；
 * - `\ No newline` 一类标记行不是正文，剔除；
 * - 新内容为空（纯删除 hunk）或不带 file_diff 结构（如 Bash 输出）时返回空数组。
 */
function diffBlocks(display, cwd) {
  if (display?.kind !== "file_diff") return [];
  const filePath = absolutePathOf(display.filePath, cwd);
  if (!filePath) return [];
  const hunks = Array.isArray(display.structuredPatch) ? display.structuredPatch : [];
  return hunks.flatMap((hunk) => {
    const lines = (Array.isArray(hunk?.lines) ? hunk.lines : []).filter(
      (line) => typeof line === "string" && !line.startsWith("\\"),
    );
    const side = (dropped) =>
      lines
        .filter((line) => !line.startsWith(dropped))
        .map((line) => line.slice(1))
        .join("\n");
    const newText = side("-");
    return newText ? [{ type: "diff", path: filePath, oldText: side("+"), newText }] : [];
  });
}

/**
 * Write 新建文件的结果里没有 display，用入参内容合成一份「新增文件」diff
 * （oldText 为 null 是 ACP 的新文件约定）。
 * 超过单条上限的内容不合成，避免把整个大文件推给客户端。
 */
function writeDiffBlocks(toolName, input, cwd) {
  if (toolName !== "Write" || typeof input?.content !== "string") return [];
  if (input.content.length > MAX_TEXT) return [];
  const filePath = absolutePathOf(input.file_path ?? input.path, cwd);
  return filePath ? [{ type: "diff", path: filePath, oldText: null, newText: input.content }] : [];
}

/** zcode 待办状态 → ACP PlanEntryStatus；未知值按未开始处理。 */
const PLAN_STATUS = { pending: "pending", in_progress: "in_progress", completed: "completed" };
/** zcode 待办优先级 → ACP PlanEntryPriority；未知值按中等处理。 */
const PLAN_PRIORITY = { high: "high", medium: "medium", low: "low" };

/**
 * TodoWrite 入参 → ACP 计划面板。
 *
 * 规则：
 * - 入参的 todos 是完整清单（不是增量），ACP 的 plan 语义也是整份替换，直接一一对应；
 * - content 缺失的条目会被客户端判为无效，直接丢弃；
 * - 非 TodoWrite 或没有可用条目时返回 null（不发空计划，避免清空客户端已有面板）。
 */
function planUpdateOf(toolName, input) {
  if (toolName !== "TodoWrite" || !Array.isArray(input?.todos)) return null;
  const entries = input.todos
    .filter((todo) => typeof todo?.content === "string" && todo.content.trim())
    .map((todo) => ({
      content: todo.content,
      status: PLAN_STATUS[todo.status] ?? "pending",
      priority: PLAN_PRIORITY[todo.priority] ?? "medium",
    }));
  return entries.length > 0 ? { sessionUpdate: "plan", entries } : null;
}

/**
 * 把单个 zcode 事件映射为 ACP update 列表（可能为空）。
 *
 * 规则：
 * - `model.streaming` 的 text_delta → agent_message_chunk；reasoning_delta → agent_thought_chunk。
 * - `tool.updated` 是工具调用的唯一来源（见 toolUpdated）。
 * - `session.updated` 同时携带 `usage` 和 `contextWindow` 时 → usage_update（上报 token 使用量）。
 * - `session.titleUpdated` → session_info_update（客户端会话标题）。
 * - 其他事件（hook、checkpoint）忽略，避免污染客户端 UI。
 */
export function eventToUpdates(event, cwd) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return [];

  if (event.type === "model.streaming") {
    return streamingUpdates(payload);
  }
  if (event.type === "tool.updated") {
    return toolUpdated(payload, cwd);
  }
  // zcode 在每轮结束时发一条同时携带 usage 和 contextWindow 的 session.updated，
  // 把它翻译成 ACP 的 usage_update，让客户端能展示 token 使用量。
  if (event.type === "session.updated" && payload.usage != null && payload.contextWindow != null) {
    return usageUpdates(payload);
  }
  // 首轮输入后 zcode 自动生成标题（source=first_input），用户在客户端改标题时也会推。
  if (event.type === "session.titleUpdated") {
    const title = textOf(payload.title, MAX_TITLE).trim();
    return title ? [{ sessionUpdate: "session_info_update", title }] : [];
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

/**
 * 工具调用的生命周期翻译。
 *
 * 规则（实测 zcode 0.17 的 stream-json）：
 * - 流里没有顶层 `tool_call` 事件，每个工具按 scheduled → started → result 三段推进，
 *   因此卡片只能由 scheduled 创建（它同时带 toolName 与完整 input），后两段是增量更新；
 * - `batch` 只是本批工具的计数汇总，各工具结果已单独翻译，这里忽略；
 * - 未知子类型忽略，避免新版本事件污染客户端 UI。
 */
function toolUpdated(payload, cwd) {
  const toolCallId = toolCallIdOf(payload);
  if (!toolCallId) return [];

  if (payload.kind === "scheduled") {
    const toolName = textOf(payload.toolName, 64);
    const updates = [];
    // TodoWrite 的入参就是完整待办清单，先转计划面板（客户端整份替换，必须全量）。
    const plan = planUpdateOf(toolName, payload.input);
    if (plan) updates.push(plan);
    const update = {
      sessionUpdate: "tool_call",
      toolCallId,
      title: titleOf(toolName, payload.input),
      name: toolName,
      kind: TOOL_KINDS[toolName] ?? "other",
      // scheduled 表示已排队但未开始执行，ACP 对应 pending。
      status: "pending",
    };
    const locations = locationsOf(payload.input, cwd);
    if (locations) update.locations = locations;
    // 新建文件的 diff 只能从入参合成，结果事件里不带 display。
    const content = writeDiffBlocks(toolName, payload.input, cwd);
    if (content.length > 0) update.content = content;
    updates.push(update);
    return updates;
  }
  if (payload.kind === "started") {
    return [{ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" }];
  }
  if (payload.kind === "result") {
    return resultUpdates(payload, toolCallId, cwd);
  }
  return [];
}

function resultUpdates(payload, toolCallId, cwd) {
  const raw = payload.result ?? payload.output;
  const text = textOf(typeof raw === "string" ? raw : raw?.content, MAX_TOOL_OUTPUT);
  const content = [];
  if (text) content.push({ type: "content", content: { type: "text", text } });
  content.push(...diffBlocks(raw?.display, cwd));
  return [
    {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: raw?.success === false ? "failed" : "completed",
      content,
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