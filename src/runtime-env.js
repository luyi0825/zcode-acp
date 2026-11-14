// 从 ZCode Desktop 的运行时环境继承认证配置。
//
// 背景（实测）：zcode 的 provider 认证走 Desktop 主进程的命名管道。
// 桥接进程被其它宿主拉起时拿不到这套变量，表现为 provider 401 "API Key 不存在"。
// 这些值由 Desktop 动态签发、无法从配置文件推导，只能由使用方导出成 env-file。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 需要继承的运行时变量白名单。 */
const RUNTIME_ENV_KEYS = [
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_OFFICIAL_ENDPOINT",
  "ZCODE_OFFICIAL_ENDPOINT_TOKEN",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  // 安装根定位：ZCode Desktop 注入的安装目录，供 bridge 找 zcode.cjs。
  "ZCODE_HOME",
  "ZCODE_WINDOWS_APP_INSTALL_DIR",
];

/** 需要继承的运行时变量白名单（导出 env-file 时也用这份单一定义）。 */
export { RUNTIME_ENV_KEYS };

/** 只认已存在的普通文件。 */
function isFile(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isFile();
}

/**
 * 读取 env-file。
 *
 * 规则：
 * - 路径必须是绝对路径，规范化后不得含 `..`（禁止目录穿越）；
 * - 每行 `KEY=VALUE`，只接受白名单内的键；
 * - 路径不合规或文件不存在时返回空对象。
 */
export function readRuntimeEnvFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return {};
  const normalized = path.normalize(filePath);
  if (normalized.split(/[\\/]/).includes("..")) return {};
  if (!isFile(normalized)) return {};

  const parsed = {};
  for (const line of readFileSync(normalized, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!RUNTIME_ENV_KEYS.includes(key)) continue;
    parsed[key] = trimmed.slice(eq + 1).trim();
  }
  return parsed;
}

/**
 * 把 env-file 里的运行时变量补进目标环境。
 * 规则：目标环境已有的值优先，不覆盖。
 */
export function mergeRuntimeEnv(env, filePath) {
  for (const [key, value] of Object.entries(readRuntimeEnvFile(filePath))) {
    if (!env[key]) env[key] = value;
  }
}

/** 宿主显式指定的 env-file 路径（如 ZCODE_ACP_ENV_FILE），未指定为空。 */
function configuredEnvFile() {
  return process.env.ZCODE_ACP_ENV_FILE;
}

/** 默认 env-file 路径：用户主目录下的 .zcode-acp.env。 */
export function defaultEnvFile() {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".zcode-acp.env");
}

/**
 * 进程级默认加载：显式指定的 env-file 优先，否则读 `~/.zcode-acp.env`。
 * CLI 启动时调用一次（serve / login / doctor 各路径都依赖合并后的 process.env），
 * 已有值优先，重复调用无副作用。路径合法性由 readRuntimeEnvFile 校验。
 */
export function loadDefaultRuntimeEnv() {
  mergeRuntimeEnv(process.env, configuredEnvFile() ?? defaultEnvFile());
}
