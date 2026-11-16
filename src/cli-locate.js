// 定位本机 zcode CLI（随 ZCode Desktop 发行，不在 PATH 上）。
//
// 单独成模块的理由：models.js 需要解析 CLI 安装根来定位 builtin provider 配置，
// 而 zcode.js 又依赖 models.js 生成 provider 配置副本。把定位逻辑放在这里，
// 两者都向下依赖本模块，不形成环。
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

// ZCode 安装根下的固定相对路径，可执行文件只能从这里派生。
const CLI_RELATIVE = path.join("resources", "glm", "zcode.cjs");
const MACOS_CLI_RELATIVE = path.join("Contents", "Resources", "glm", "zcode.cjs");

/**
 * 是否 Windows 布局。
 *
 * 规则：按调用时的 process.platform 求值，不在模块加载时固化——
 * 测试会临时改写 process.platform 验证 macOS 布局，固化会让改写失效。
 */
function isWindows() {
  return process.platform === "win32";
}

/** 只认已存在的普通文件。 */
export function isFile(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isFile();
}

/**
 * 从注册表的卸载信息里读出 ZCode 安装目录（仅 Windows）。
 *
 * 规则：
 * - 只查标准卸载表（HKCU / HKLM / WOW6432Node），DisplayName 含 "ZCode" 才算；
 * - InstallLocation 才是安装根，DisplayIcon/UninstallString 都可能是子路径；
 * - 任何异常（reg 不存在、键缺失、权限不足）都返回 undefined，由调用方继续试其它候选。
 *
 * 存在理由：非默认安装路径下，只靠标准目录猜不到安装根，而这一步不查注册表
 * 就得让用户手工设 ZCODE_HOME。
 */
function installRootFromRegistry() {
  const BS = "\\";
  const keys = [
    ["HKCU", "Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(BS),
    ["HKLM", "Software", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(BS),
    ["HKLM", "Software", "WOW6432Node", "Microsoft", "Windows", "CurrentVersion", "Uninstall"].join(BS),
  ];
  for (const key of keys) {
    let out;
    try {
      out = execFileSync("reg", ["query", key, "/s", "/v", "DisplayName"], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    for (const block of out.split(/\r?\n\r?\n/)) {
      if (!/DisplayName\s+REG_SZ\s+ZCode/i.test(block)) continue;
      const subKey = block.match(/^(HKEY_[^\r\n]+)/m)?.[1];
      if (!subKey) continue;
      try {
        const detail = execFileSync("reg", ["query", subKey], { encoding: "utf8", windowsHide: true });
        const location = detail.match(/InstallLocation\s+REG_SZ\s+(.+)/);
        if (location) return location[1].trim();
      } catch {
        // 单个子键读失败不影响继续试其它候选。
      }
    }
  }
  return undefined;
}

/**
 * 安装根候选（按平台，可移植顺序）。
 *
 * 规则：
 * - 环境变量只表达"安装目录"，可执行文件仍由 CLI_RELATIVE 派生，
 *   避免环境变量换掉实际启动的程序；
 * - ZCODE_WINDOWS_APP_INSTALL_DIR 是 ZCode Desktop 注入给子进程的安装目录，
 *   经 env-file 继承后用于非标准安装位置的自适应定位；
 * - 标准路径排在最前面，注册表查询放最后：前者是纯文件存在性检查（微秒级），
 *   后者要起 reg 子进程（几十毫秒），只有标准路径全落空才值得付这个代价。
 */
function installRoots() {
  const roots = [];
  for (const key of ["ZCODE_HOME", "ZCODE_WINDOWS_APP_INSTALL_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string" && value && path.isAbsolute(value)) {
      roots.push(value);
    }
  }
  if (isWindows()) {
    roots.push(
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode"),
      path.join(process.env.PROGRAMFILES ?? "", "ZCode"),
    );
  } else {
    roots.push("/Applications/ZCode.app");
  }
  return roots;
}

/** 在给定候选根里找 zcode.cjs，返回绝对路径或 undefined。 */
function findCli(roots) {
  const relativeCliPaths = isWindows() ? [CLI_RELATIVE] : [MACOS_CLI_RELATIVE, CLI_RELATIVE];
  return roots
    .flatMap((root) => relativeCliPaths.map((relative) => path.join(root, relative)))
    .find(isFile);
}

/** 注册表兜底查到的安装根（进程级缓存，避免每次解析都起 reg 子进程）。 */
let registryRootCache;

/** 读注册表安装根，只查一次；查不到也缓存（undefined），避免反复起子进程。 */
function cachedRegistryRoot() {
  if (registryRootCache === undefined) {
    const found = installRootFromRegistry();
    registryRootCache = found && path.isAbsolute(found) ? found : null;
  }
  return registryRootCache ?? undefined;
}

/**
 * 解析出可执行的 (node, cli) 组合。
 *
 * 规则：
 * - cli 固定为安装根下的平台对应路径，必须真实存在；
 * - macOS 优先标准 Contents/Resources 布局，回退裸 bundle 的 resources 布局；
 * - 标准候选全落空后才查注册表卸载信息（非默认安装路径的唯一可靠来源）；
 * - node 固定为字面量 "node"（交给 PATH 解析）。
 */
export function resolveZcode() {
  let cli = findCli(installRoots());
  if (!cli) {
    const registered = cachedRegistryRoot();
    if (registered) cli = findCli([registered]);
  }
  if (!cli) {
    throw new Error(
      "找不到 zcode.cjs。请先安装 ZCode Desktop（zcode CLI 随其发行），" +
        "或把环境变量 ZCODE_HOME 指向 ZCode 安装目录",
    );
  }
  return { node: "node", cli };
}