// MiCO 任务信封拆解：把模板从正文里摘出来，交给 CLI 的附件通道。
//
// 背景：MiCO 用固定模板包裹每条用户消息（`## Task Initiator` 发起人与产物目录
// → `[user message=<id> version=<n>]` → 用户原话 → `## Human interaction` 规则）。
// zcode CLI 取首条输入的**原文**作为会话标题，于是 ZCode 项目列表里显示的是
// "## Task Initiator This task was initiated by **XXX** ..."；首条消息也被模板占满，
// 用户原话被淹在中间。
//
// 这里把模板拆成两部分：
// - 用户原话 → 作为 prompt 正文（标题就取它，客户端里也只显示它）；
// - 模板原文（发起人、产物目录、交互规则）→ 原样写成附件，经 `--attach` 交给 CLI。
// 实测附件内容会进入模型上下文并跨 `--resume` 保留，但不出现在标题与首条消息里。
// 信息量一字不减，变的只是可见性与顺序。
//
// 任何一段对不上模板形态时整体原样返回（envelope 为空）：宁可显示难看，
// 也不能吞掉用户输入。

// 模板起始行：只认这一种标题形态，避免误伤用户自己写的二级标题。
const ENVELOPE_START = /^## Task Initiator[^\r\n]*\r?\n/;
// 用户消息标记行：`[user message=<id> version=<n>]`。
const USER_MESSAGE_MARK = /^\[user message=[^\]\r\n]{1,128} version=[^\]\r\n]{1,16}\]\r?\n?/m;
// 规则段起始行：标记之后出现它，则其后全部属于交互规则。
const RULES_START = /^## Human interaction[^\r\n]*$/m;

/**
 * 把 MiCO 任务信封拆成「用户原话 + 模板原文」。
 *
 * 规则：
 * - 仅当整段以 `## Task Initiator` 开头**且**含 `[user message=... version=...]`
 *   标记时才拆解，两者缺一视为普通输入（envelope 为 null）；
 * - 标记之后、规则段之前的全部内容是用户原话，原样保留（含换行与空行）；
 * - 用户原话为空时按普通输入处理：纯模板消息不能变成空 prompt；
 * - envelope 是原文去掉用户原话后的拼接结果，一字不删，调用方负责写入附件。
 *
 * @param {string} text 客户端下发的原始输入
 * @returns {{prompt: string, envelope: string | null}} prompt 为可下发的正文
 */
export function splitTaskEnvelope(text) {
  if (typeof text !== "string" || !ENVELOPE_START.test(text)) return { prompt: text, envelope: null };
  const mark = text.match(USER_MESSAGE_MARK);
  if (!mark) return { prompt: text, envelope: null };

  const head = text.slice(0, mark.index);
  const rest = text.slice(mark.index + mark[0].length);
  const rulesAt = rest.search(RULES_START);
  const prompt = (rulesAt >= 0 ? rest.slice(0, rulesAt) : rest).trim();
  // 纯模板消息没有用户原话，拆出去会得到空 prompt，按原样下发。
  if (!prompt) return { prompt: text, envelope: null };

  const tail = rulesAt >= 0 ? rest.slice(rulesAt).trim() : "";
  const envelope = `${head.trim()}\n\n${tail}`.trim();
  return { prompt, envelope: envelope || null };
}