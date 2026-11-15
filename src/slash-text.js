// 斜杠命令文本改写：把客户端的 `/技能名` 转成 zcode 能真正执行的 `/skill 技能名`。
//
// 背景：zcode 的斜杠注册表只含自定义命令，技能不在其中（实测裸写 `/技能名`
// 得到 "Unknown command"）。技能要靠 CLI 的 `/skill <name>` 子命令加载，
// 因此 bridge 在两个入口（ACP 的 session/prompt 与 MiCO 的 Claude 入口）
// 统一做这次改写。

// 首行的斜杠命令形式：/名字 后面可跟参数。
const LEADING_COMMAND = /^\/([A-Za-z0-9][\w.:@/-]*)([\s\S]*)$/;

/**
 * 把整段以 `/技能名` 开头的文本改写为 `/skill 技能名`。
 *
 * 规则：
 * - 只改写**整段开头**的斜杠命令：正文中间提到命令名时不改动；
 * - 名字必须命中本机技能白名单才改写，避免把普通文本误当命令；
 * - **同名自定义命令优先，不改写**：一个名字可能既是命令又是技能
 *   （如 cross-cr），此时 `/名字` 命中 CLI 的原生命令，改成 /skill 反而
 *   绕过命令定义、丢失它自带的上下文；
 * - 已是 `/skill` 形式原样放行（CLI 自己解析技能名参数）；
 * - 无前导斜杠的 `skill xxx` 不改写——实测这种形态模型常只回一句"已加载"
 *   而不真正调用 Skill 工具，交给模型自行判断。
 *
 * @param {string} text 原始输入
 * @param {{skills: Set<string>, commands?: Set<string>}} names 本机已知名字
 * @returns {string} 可下发给 CLI 的文本
 */
export function rewriteSkillCommand(text, names) {
  const parts = text.match(LEADING_COMMAND);
  if (!parts) return text;
  const command = parts[1];
  if (command === "skill") return text;
  // 同名命令优先：CLI 会把 /名字 当命令执行，技能要靠模型自行加载。
  if (names.commands?.has(command)) return text;
  if (!names.skills.has(command)) return text;
  return `/skill ${command}${parts[2]}`;
}