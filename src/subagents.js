// 本地子 agent 清单：Agent 工具的 subagent_type 取值。
//
// 子 agent 定义是 ~/.zcode/agents/*.md（frontmatter 带 name/description），
// 本模块只读这些文件，不执行任何命令、不启动子进程。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// 描述在客户端列表里只是一行提示，截断避免超长描述撑爆 UI。
const MAX_DESCRIPTION = 200;

// 文件名白名单：只接受 <name>.md，name 限定在安全字符集内（无分隔符、无上跳）。
const SUBAGENT_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
// frontmatter 分隔块与单行 key: value。
const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---/;
const FRONTMATTER_FIELD = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/;

/** 描述压成单行并截断：换行会让部分客户端把列表项渲染变形。 */
function flattenDescription(value) {
  if (typeof value !== "string") return "";
  const single = value.split(/\s+/).join(" ").trim();
  if (single.length <= MAX_DESCRIPTION) return single;
  return single.slice(0, MAX_DESCRIPTION) + "…";
}

/**
 * 子 agent 定义目录候选。
 *
 * 规则：`~/.zcode/agents` 是 CLI 实际扫描的位置（即使 ZCODE_DATA_BASE_DIR
 * 重定向了数据根，agents 仍留在用户主目录下——实测）；数据根下的同名目录
 * 作为补充，便于受管部署集中投放。
 */
function agentsDirs() {
  const dirs = [path.join(homedir(), ".zcode", "agents")];
  const base = process.env.ZCODE_DATA_BASE_DIR;
  if (base) dirs.push(path.join(base, ".zcode", "agents"));
  return dirs;
}

/**
 * 解析扁平 YAML frontmatter 的字符串字段。
 * 规则：只认 `key: value`，去掉成对引号；子 agent 文件字段都是扁平的，
 * 引入完整 YAML 解析器不值得（多一个依赖）。
 */
function frontmatterFields(text) {
  const fields = {};
  const block = text.match(FRONTMATTER_BLOCK);
  if (!block) return fields;
  for (const line of block[1].split(/\r?\n/)) {
    const field = line.match(FRONTMATTER_FIELD);
    if (!field) continue;
    fields[field[1]] = field[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return fields;
}

/**
 * 本地子 agent 清单。
 *
 * 规则：
 * - 只读用户级目录下**一层**的 *.md，frontmatter 缺 name 时用文件名兜底；
 * - 目录项按不可信输入处理：文件名先过白名单正则，解析后再次校验真实路径的
 *   父目录仍是该目录，杜绝越界读取；
 * - 单个文件越界或不可读只跳过自己，不影响整份清单。
 */
export function listSubagents() {
  const agents = [];
  const seen = new Set();
  for (const dir of agentsDirs()) {
    if (!existsSync(dir)) continue;
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch {
      continue;
    }
    for (const entry of readdirSync(dir)) {
      if (!SUBAGENT_FILE.test(entry)) continue;
      let text;
      try {
        const real = realpathSync(path.join(dir, entry));
        if (path.dirname(real) !== realDir) continue;
        if (!statSync(real).isFile()) continue;
        text = readFileSync(real, "utf8");
      } catch {
        continue;
      }
      const fields = frontmatterFields(text);
      const name = fields.name || entry.slice(0, -3);
      // 同名以先找到的为准（用户目录优先于数据根目录）。
      if (!name || seen.has(name)) continue;
      seen.add(name);
      agents.push({ name, description: flattenDescription(fields.description) });
    }
  }
  return agents;
}