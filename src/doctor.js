// 安装自检（doctor）与接入引导（setup）。
//
// doctor 检查四项：Node 版本、zcode CLI 定位、登录态、模型列表；
// --probe 额外实跑一轮 headless 冒烟。
// setup 在 doctor 之上：Desktop 环境里导出认证 env-file，并打印各客户端接入片段。
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveZcode, runTurn } from "./zcode.js";
import { listModels } from "./models.js";
import {
  dataBaseDir,
  defaultEnvFile,
  loadDefaultRuntimeEnv,
  personalProviderConfigPath,
  RUNTIME_ENV_KEYS,
} from "./runtime-env.js";
import { registerAllClients } from "./register.js";

/**
 * 自检并打印结果。
 *
 * @param {{probe?: boolean}} options probe 为 true 时实跑一轮 headless 冒烟
 * @returns {Promise<boolean>} 全部关键项通过返回 true
 */
export async function runDoctor({ probe = false } = {}) {
  loadDefaultRuntimeEnv();

  let healthy = true;
  const ok = (label) => console.log(`  [ok] ${label}`);
  const bad = (label) => {
    console.error(`  [FAIL] ${label}`);
    healthy = false;
  };
  const warn = (label) => console.warn(`  [warn] ${label}`);

  console.log("zcode-acp 自检\n");

  // 1. Node 运行时
  const [major] = process.versions.node.split(".").map(Number);
  if (major >= 20) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}（需要 >= 20）`);

  // 2. zcode CLI 定位
  let cli = null;
  try {
    cli = resolveZcode().cli;
    ok(`zcode CLI：${cli}`);
  } catch (err) {
    bad(err.message);
  }

  // 3. 登录态：凭据路径与 zcode CLI 的规则一致
  //（<ZCODE_DATA_BASE_DIR 或 home>/.zcode/v2/credentials.json）。
  const credPath = path.join(dataBaseDir(), ".zcode", "v2", "credentials.json");
  if (existsSync(credPath)) ok(`已登录（凭据：${credPath}）`);
  else warn(`未登录（${credPath} 不存在）。执行 zcode-acp login 登录；纯 api-key 配置可忽略`);

  // 4. 模型列表（personal provider config 可读才有）
  const models = listModels();
  if (models) {
    const names = models.availableModels.slice(0, 3).map((m) => m.name).join("、");
    const more = models.availableModels.length > 3 ? " 等" : "";
    ok(`模型 ${models.availableModels.length} 个（${names}${more}）`);
  } else {
    bad(`读不到模型列表：${personalProviderConfigPath()} 缺失或损坏（登录后由 zcode 生成）`);
  }

  // 5. --probe：实跑一轮
  if (probe) {
    process.stdout.write("  probe：实跑一轮 headless … ");
    const result = await runTurn({
      cwd: tmpdir(),
      text: "只回复PONG",
      onEvent: () => {},
    });
    if (result.content?.includes("PONG")) ok("probe 返回 PONG");
    else bad(`probe 失败：${(result.error ?? result.content ?? "无输出").slice(0, 300)}`);
  }

  console.log(healthy ? "\n全部通过" : "\n存在失败项");
  return healthy;
}

/**
 * 把当前 shell 里的 ZCode 运行时变量导出到默认 env-file。
 *
 * 规则：
 * - 这些值都是本机布局（数据目录、安装位置），跑一次长期有效，
 *   只有换数据目录或换安装位置才需要重跑；
 * - 不导出 ZCODE_OFFICIAL_ENDPOINT / TOKEN：它们每次 Desktop 重启都换，
 *   且普通对话的 provider 认证不依赖它们；
 * - 没有任何可导出项时返回 -1。
 */
function exportRuntimeEnvFile() {
  const entries = RUNTIME_ENV_KEYS.filter((key) => process.env[key]).map(
    (key) => `${key}=${process.env[key]}`,
  );
  if (entries.length === 0) return -1;
  writeFileSync(defaultEnvFile(), `${entries.join("\n")}\n`, { mode: 0o600 });
  return entries.length;
}

/** setup：自检 + 运行时环境导出 + 向已装客户端自动注册。 */
export async function runSetup() {
  const healthy = await runDoctor();
  console.log();

  const exported = exportRuntimeEnvFile();
  if (exported >= 0) {
    console.log(`已导出本机布局（${exported} 项）到 ${defaultEnvFile()}`);
    console.log("这些值长期有效，仅在更换数据目录或安装位置后需要重新运行 setup。");
  } else {
    console.warn("没有可导出的运行时变量，跳过导出。");
  }

  // 通用注册：向本机所有已装的 ACP 客户端写入 agent 入口（客户端发现制，
  // 模式对齐 Claude 生态）。未装的客户端自动跳过。
  console.log("\n注册到本机 ACP 客户端：");
  // Windows 的客户端配置根是 APPDATA；HOME 在 Windows 上通常指向别处（或不存在），
  // 拿它当回退会去错误目录找客户端，静默得到「未检测到」。
  const appDataDir = process.platform === "win32"
    ? process.env.APPDATA
    : process.env.XDG_CONFIG_HOME ?? process.env.HOME;
  if (!appDataDir) {
    console.warn("  [warn] 找不到配置目录（APPDATA / HOME 均未设置），跳过注册");
  } else {
    const results = registerAllClients(appDataDir);
    if (results.length === 0) {
      console.log("  未检测到已装的 ACP 客户端（OpenIdea / Zed），可手接其它客户端：");
      console.log("  以 stdio NDJSON 拉起 zcode-acp（无参数即 ACP 服务）。");
    } else {
      for (const line of results) console.log(`  ${line}`);
      console.log("\n  重启客户端后生效。");
    }
  }
  return healthy;
}
