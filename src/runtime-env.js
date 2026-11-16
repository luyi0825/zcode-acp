// 从 ZCode Desktop 的运行时环境继承本机布局配置。
//
// 背景（实测）：Desktop 重定向数据目录后，zcode CLI 只认 ZCODE_DATA_BASE_DIR
// 环境变量（不读 setting.json 里的 dataBaseDir），桥接进程拿不到就退回家目录，
// 读到旧的 provider 配置，表现为 provider 401 "API Key 不存在"。
//
// 会话级凭据（ZCODE_OFFICIAL_ENDPOINT / TOKEN，官方命令服务用）不参与继承：
// 它们每次 Desktop 重启都换，而普通对话的 provider 认证走 provider_config.json
// 里的静态 apiKey，不依赖这两个变量。
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** 需要继承的运行时变量白名单（都是不随 Desktop 重启变化的固定值）。 */
const RUNTIME_ENV_KEYS = [
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
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
 * 按 CLI 路径定位内置 provider 配置。
 *
 * 规则：
 * - CLI 恒在 `<发行根>/resources/glm/zcode.cjs`：Windows/Linux 是
 *   `<安装根>/resources/glm`，macOS 是 `<bundle>/Contents/Resources/glm`；
 * - 从 CLI 所在目录向上两级得到 resources 目录，再试它的父目录，
 *   两者任一存在 `config/provider/zcode-builtin.json` 即采用；
 * - 找不到返回 undefined。
 *
 * zcode.js 与 models.js 共用本函数，保证两处对 builtin 配置的定位一致。
 */
export function builtinProviderConfigAt(cli) {
  if (typeof cli !== "string" || !cli) return undefined;
  const resourcesDir = path.dirname(path.dirname(cli));
  for (const root of [resourcesDir, path.dirname(resourcesDir)]) {
    const config = path.join(root, "config", "provider", "zcode-builtin.json");
    if (isFile(config)) return config;
  }
  return undefined;
}

/**
 * ZCode 数据根（即 `ZCODE_DATA_BASE_DIR`，未设置时退回家目录）。
 *
 * 规则：
 * - 显式设置的环境变量最优先（Desktop 注入或 env-file 提供）；
 * - 未设置时读 `~/.zcode/v2/setting.json` 的 `dataBaseDir`：这是 Desktop
 *   重定向数据目录时持久化的值。CLI 自身不读它，但 Desktop 打开终端时会把
 *   同样的值注入 ZCODE_DATA_BASE_DIR，因此两者语义一致、不会分叉；
 * - 仍取不到才退回家目录（未重定向的默认安装）。
 *
 * 加自动发现的理由：只靠环境变量时，非 Desktop 终端（如宿主直接拉起 bridge）
 * 会静默读到 ~/.zcode 下的旧配置，表现为 provider 401，而用户无从判断。
 */
export function dataBaseDir() {
  if (process.env.ZCODE_DATA_BASE_DIR) return process.env.ZCODE_DATA_BASE_DIR;
  return redirectDataBaseDir() ?? homeDir();
}

/** 用户主目录（数据目录的默认值与 setting.json 的固定位置都基于它）。 */
export function homeDir() {
  return process.env.USERPROFILE || homedir();
}

/**
 * 从 Desktop 的 setting.json 读取重定向后的数据目录。
 *
 * 规则：
 * - 只接受绝对路径、路径段不得含 `..`、且目录真实存在，否则返回 undefined；
 * - 返回 normalize 之后的路径，后续拼 provider_config 等子路径都在它之下；
 * - 任何读取/解析异常都当作没有重定向（自动发现是增强项，不能阻断启动）。
 */
function redirectDataBaseDir() {
  const home = homeDir();
  if (!home) return undefined;
  const settingPath = path.join(home, ".zcode", "v2", "setting.json");
  if (!isFile(settingPath)) return undefined;
  let value;
  try {
    value = JSON.parse(readFileSync(settingPath, "utf8"))?.dataBaseDir;
  } catch {
    return undefined;
  }
  if (typeof value !== "string" || !path.isAbsolute(value)) return undefined;
  // 必须在 normalize 之前判断：normalize 会把 `..` 解析掉，之后再也查不到。
  if (value.split(/[\\/]/).includes("..")) return undefined;
  const normalized = path.normalize(value);
  if (!existsSync(normalized)) return undefined;
  return normalized;
}

/**
 * 读取 env-file。
 *
 * 规则：
 * - 路径必须是绝对路径，原始路径任一段不得为 `..`（禁止目录穿越）；
 * - 每行 `KEY=VALUE`，只接受白名单内的键；
 * - 路径不合规或文件不存在时返回空对象。
 */
export function readRuntimeEnvFile(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return {};
  // 必须在 normalize 之前判断：normalize 会把 `..` 解析掉，之后再也查不到。
  if (filePath.split(/[\\/]/).includes("..")) return {};
  const normalized = path.normalize(filePath);
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
 * 按数据目录推导 personal provider config 路径。
 *
 * 规则：
 * - 已显式设置时原样返回（env-file 与调用方值优先）；
 * - 否则用 ZCODE_DATA_BASE_DIR（未设置退回家目录）拼 `.zcode/v2/provider_config.json`，
 *   与 zcode CLI 的布局一致；
 * - 推导结果不校验存在性：读不到时由调用方按原有降级路径处理。
 */
export function personalProviderConfigPath() {
  if (process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    return process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  }
  return path.join(dataBaseDir(), ".zcode", "v2", "provider_config.json");
}

/**
 * 进程级默认加载：显式指定的 env-file 优先，否则读 `~/.zcode-acp.env`。
 * CLI 启动时调用一次（serve / login / doctor 各路径都依赖合并后的 process.env），
 * 已有值优先，重复调用无副作用。路径合法性由 readRuntimeEnvFile 校验。
 */
export function loadDefaultRuntimeEnv() {
  mergeRuntimeEnv(process.env, configuredEnvFile() ?? defaultEnvFile());
}
