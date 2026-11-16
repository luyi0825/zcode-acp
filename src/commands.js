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

// 客户端菜单需要展示、且 headless 下真的会执行的 CLI 内置命令。
//
// 背景：`commands list --json` 只返回用户自定义命令，内置命令在 CLI 里是硬编码的、
// 没有导出接口，因此只能在这里声明。只收录实测在 `-p` 模式下真正执行的两条：
//   /compact  → 返回 "Context is up to date; no compression needed" 一类结果；
//   /goal     → 返回 {"response":"No goal is set. Use /goal <objective> to set one."}；
// 其余内置命令（/model /mode /mcp /plugins /effort /dwf /locale）在 headless 下
// 不被识别，会被当成普通提示词让模型解释一遍；/workflow /fork 直接退出码 1。
// 模型、模式、思考级别已由 ACP 的 set_model / set_mode / set_config_option 承担，
// 不重复进菜单。
const BUILTIN_COMMANDS = [
  { name: "compact", description: "压缩当前会话上下文，可附加摘要要求" },
  { name: "goal", description: "查看或设置当前会话目标" },
];

// 进程级缓存：这些清单在一次 bridge 生命周期内不会变，而读它们要起子进程，
// 每个新会话都重读会明显拖慢会话建立。promise 形式保证并发会话共享同一次读取。
let cached = null;

/**
 * 本机可用的命令 / 技能 / 子 agent 清单。
 *
 * 规则：
 * - commands 含内置命令与自定义命令（内置在前），调用方可一律按「原生命令名」处理；
 * - 命令与技能分开返回，因为调用形式不同：命令是 `/name`，
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

  // 内置命令排在自定义命令之前：它们的名字占用后，同名的自定义项与技能都不再
  // 视为「命令」，从而不会被 rewriteSkillCommand 改写成 /skill（内置命令永远优先）。
  const commands = BUILTIN_COMMANDS.map((command) => ({ ...command }));
  const commandNames = new Set(BUILTIN_COMMANDS.map((command) => command.name));
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
    // 与命令同名时以命令为准：裸 `/name` 命中的是命令，技能需 /skill 前缀区分。
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
 * - commands 已含内置命令（见 BUILTIN_COMMANDS）与自定义命令，内置在前；
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