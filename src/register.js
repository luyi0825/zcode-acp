// 通用客户端注册：向本机已装的 ACP 客户端写入 agent 入口。
//
// 模式对齐 Claude 生态（客户端发现制）：agent 不"注册自己到宿主"，而是把入口
// 写进各客户端的发现位置——OpenIdea 扫 agents/ 目录放 toml 即现，Zed 读
// settings.json 的 agent_servers。新增客户端支持 = 在 CLIENTS 注册表加一段
// 检测 + 写入器，bridge 本体不感知。
//
// 命令一律写裸名 "zcode-acp"（PATH 解析，npm 全局 bin 的标准 shim 三件套
// .cmd/.sh/.ps1 由 npm 生成）：配置里不出现任何用户路径，可原样分享/迁移，
// 也与 Zed 官方 Custom Agent 文档的形态一致（command: "pool", args: ["acp"]）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 客户端拉起本 agent 的统一命令（裸名，PATH 解析）。 */
const AGENT_COMMAND = "zcode-acp";

/**
 * 把环境值限定在指定父目录内的绝对路径（拼接固定文件名）。
 * 防御：外部可控的目录值不允许经 `..` 逃出父目录。
 */
function safeJoin(parentDir, ...segments) {
  const base = path.normalize(parentDir);
  const joined = path.normalize(path.join(base, ...segments));
  return joined.startsWith(base + path.sep) ? joined : null;
}

/**
 * OpenIdea：agents/ 目录放 toml 即被扫描（实测）。
 * 文件内容是唯一事实源，重复运行覆盖为当前正确配置（幂等）。
 */
function writeOpenIdea(appDataDir) {
  const agentsDir = safeJoin(appDataDir, "ai.l0ng.openidea", "agents");
  if (!agentsDir) return `跳过 OpenIdea：目录路径异常`;
  mkdirSync(agentsDir, { recursive: true });
  const toml = safeJoin(agentsDir, "zcode.toml");
  if (!toml) return `跳过 OpenIdea：文件路径异常`;
  const content = `name = "ZCode"\ncommand = '${AGENT_COMMAND}'\n`;
  writeFileSync(toml, content, "utf8");
  return `OpenIdea 已注册（${toml}）`;
}

/**
 * Zed：settings.json（JSONC）的 agent_servers 增加本地条目。
 *
 * 规则：
 * - JSONC 文本级手术，只动 agent_servers 块，保留用户全部注释与其它配置；
 * - 已有 zcode 条目则跳过（幂等）；无 agent_servers 键时在顶层对象内新增；
 * - 括号计数定位块的闭合位置，不依赖 JSON.parse（注释会挂）。
 */
function writeZed(appDataDir) {
  const settingsPath = safeJoin(appDataDir, "Zed", "settings.json");
  if (!settingsPath || !existsSync(settingsPath)) return `跳过 Zed：settings.json 不存在`;
  const original = readFileSync(settingsPath, "utf8");
  if (/"zcode"\s*:/.test(original)) return `Zed 已有 zcode 条目，跳过`;

  // Zed 官方 Custom Agent 格式（zed.dev/docs/ai/external-agents）：type: "custom"
  // 标记非 registry 来源；command 为裸名走 PATH（官方 Poolside 示例同款），
  // args 的 "acp" 是 ACP 生态的约定入口子命令。
  const entry = `"zcode": { "type": "custom", "command": "${AGENT_COMMAND}", "args": ["acp"] }`;
  const keyIndex = original.indexOf('"agent_servers"');
  let updated;
  if (keyIndex < 0) {
    // 无键：在最后一个闭合大括号（顶层对象结束）前插入新块。
    const closeBrace = original.lastIndexOf("}");
    if (closeBrace < 0) return `跳过 Zed：settings.json 结构异常`;
    // 前一个有效字符若是 } 或 ]，需要补逗号；空对象则直接插入。
    const before = original.slice(0, closeBrace).replace(/[,\s]*$/, "");
    const prefix = before.trim().length > 0 ? `${before},\n` : "{\n";
    updated = `${prefix}  "agent_servers": {\n    ${entry}\n  }\n}`;
  } else {
    // 有键：括号计数找 agent_servers 值对象的闭合位置，在其前插入条目。
    const openBrace = original.indexOf("{", keyIndex);
    if (openBrace < 0) return `跳过 Zed：agent_servers 结构异常`;
    let depth = 0;
    let closeBrace = -1;
    let inString = false;
    let escaped = false;
    for (let i = openBrace; i < original.length; i++) {
      const ch = original[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          closeBrace = i;
          break;
        }
      }
    }
    if (closeBrace < 0) return `跳过 Zed：agent_servers 括号不配对`;
    const before = original.slice(0, closeBrace).replace(/[,\s]*$/, "");
    const after = original.slice(closeBrace);
    updated = `${before},\n    ${entry}\n  ${after}`;
  }
  writeFileSync(settingsPath, updated, "utf8");
  return `Zed 已注册（${settingsPath}）`;
}

/**
 * 已知客户端注册表。检测到目录存在即视为已安装并写入；
 * 写入失败（结构异常等）返回说明文本而非中断，其余客户端继续。
 */
const CLIENTS = [
  { name: "OpenIdea", detect: (dir) => existsSync(path.join(dir, "ai.l0ng.openidea")), write: writeOpenIdea },
  { name: "Zed", detect: (dir) => existsSync(path.join(dir, "Zed")), write: writeZed },
];

/**
 * 向所有已装客户端注册 agent 入口，返回逐客户端结果（已装才登记）。
 *
 * @param {string} appDataDir 配置根目录（Windows 为 %APPDATA%）
 */
export function registerAllClients(appDataDir) {
  const results = [];
  for (const client of CLIENTS) {
    if (!client.detect(appDataDir)) continue;
    try {
      results.push(`[ok] ${client.write(appDataDir)}`);
    } catch (err) {
      results.push(`[fail] ${client.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}
