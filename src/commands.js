// 斜杠命令 / 技能 / 子 agent 清单。
//
// 数据来自 zcode CLI 自身的发现结果（`commands list --json` 读自定义命令，
// `skills list --json` 读已装 skill），与 TUI 里能用到的完全一致——
// 不在这里硬编码清单，避免与 CLI 版本漂移。
import { execFile } from "node:child_process";
import { applyZcodeRuntimeEnv, resolveZcode } from "./zcode.js";
import { listSubagents } from "./subagents.js";

// 命令描述在客户端菜单里只是一行提示，截断避免超长描述撑爆 UI。
const MAX_DESCRIPTION = 200;

/** 解析 JSON 输出；空输出或非 JSON（CLI 改动、诊断混入）返回 null，调用方据此跳过该类命令。 */
function parseJson(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * 执行 zcode CLI 并取 stdout；失败返回空串（清单是增强项，不应阻断会话）。
 *
 * 安全：argv 由调用方以**完全字面量**数组给出，函数只做前缀拼接（不可执行的外部
 * 输入不进入 argv）；execFile 显式 shell: false，不经 shell 解析。
 *
 * 运行时用字面量 "node" 而非 process.execPath：单文件 exe（SEA）形态下
 * process.execPath 是 exe 自身，拿它跑 .cjs 参数会失败，清单会静默变空。
 */
function runZcode(extraArgs) {
  return new Promise((resolve) => {
    let cli;
    try {
      ({ cli } = resolveZcode());
    } catch {
      resolve("");
      return;
    }
    const env = { ...process.env };
    applyZcodeRuntimeEnv(env, cli);
    execFile(
      "node",
      [cli, ...extraArgs],
      { env, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout) => resolve(err ? "" : stdout),
    );
  });
}

/** 自定义命令清单（zcode 斜杠注册表的来源）。 */
function fetchCommands() {
  return runZcode(["commands", "list", "--json"]);
}

/** 已装技能清单。 */
function fetchSkills() {
  return runZcode(["skills", "list", "--json"]);
}

/** 命令描述压成单行并截断：换行会让部分客户端把菜单项渲染变形。 */
function flattenDescription(value) {
  if (typeof value !== "string") return "";
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > MAX_DESCRIPTION ? `${single.slice(0, MAX_DESCRIPTION)}…` : single;
}

// 进程级缓存：这些清单在一次 bridge 生命周期内不会变，而读它们要起子进程，
// 每个新会话都重读会明显拖慢会话建立。promise 形式保证并发会话共享同一次读取。
let cached = null;

/**
 * 本机可用的命令 / 技能 / 子 agent 清单。
 *
 * 规则：
 * - 命令与技能分开返回，因为调用形式不同：自定义命令是 `/name`，
 *   **技能必须 `/skill <name>`**——实测裸写技能名得到 "Unknown command"，
 *   CLI 的斜杠注册表只含自定义命令；
 * - 重名时命令优先于技能（裸 `/name` 命中的是命令），与 CLI 自身优先级一致；
 * - 任一子命令失败只丢那一类，不抛错；
 * - 结果按进程缓存，重启 bridge 后重新发现。
 */
export function discoverCapabilities() {
  cached ??= discoverOnce();
  return cached;
}

/** 实际发现逻辑：命令与技能各跑一次 CLI，子 agent 读本地定义目录。 */
async function discoverOnce() {
  const [commandsOut, skillsOut] = await Promise.all([fetchCommands(), fetchSkills()]);

  const commands = [];
  const commandNames = new Set();
  // 自定义命令优先：重名时先加入的留下，与 CLI 自身优先级一致。
  for (const command of parseJson(commandsOut)?.commands ?? []) {
    const name = typeof command?.name === "string" ? command.name.trim() : "";
    if (!name || commandNames.has(name)) continue;
    commandNames.add(name);
    commands.push({ name, description: flattenDescription(command?.description) });
  }

  const skills = [];
  const skillNames = new Set(commandNames);
  for (const skill of parseJson(skillsOut)?.skills ?? []) {
    const name = String(skill?.qualifiedName ?? skill?.name ?? "").trim();
    // 与自定义命令同名时以命令为准：裸 `/name` 命中的是命令，技能需 /skill 前缀区分。
    if (!name || skillNames.has(name)) continue;
    skillNames.add(name);
    skills.push({ name, description: flattenDescription(skill?.description) });
  }

  return { commands, skills, subagents: listSubagents() };
}

/**
 * 斜杠命令清单（ACP AvailableCommand 形态）。
 *
 * 规则：
 * - 自定义命令以 `/<name>` 出现；
 * - 技能也进这个菜单（`/<name>` 形式）：ACP 客户端只会展示这份清单里的条目，
 *   不放进来用户在 OpenIdea / Zed / Mutica 里根本看不到技能，也就无从调用；
 *   实测 `/技能名` 裸写会被 zcode 判为 "Unknown command"，但因为它的 `Skill`
 *   工具在上下文里可用，模型仍会自行加载该技能并执行（见 agent.js 的文本改写）；
 * - 技能排在命令之后（命令是 CLI 原生斜杠项，优先级更高）。
 */
export async function listSlashCommands() {
  const { commands, skills } = await discoverCapabilities();
  return [
    ...commands.map((command) => ({ name: command.name, description: command.description })),
    ...skills.map((skill) => ({ name: skill.name, description: skill.description })),
  ];
}