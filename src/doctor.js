// 安装自检（doctor）与接入引导（setup）。
//
// doctor 检查四项：Node 版本、zcode CLI 定位、登录态、模型列表；
// --probe 额外实跑一轮 headless 冒烟。
// setup 在 doctor 之上：Desktop 环境里导出认证 env-file，并打印各客户端接入片段。
import { existsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { resolveZcode, runTurn } from "./zcode.js";
import { listModels } from "./models.js";
import { defaultEnvFile, loadDefaultRuntimeEnv, RUNTIME_ENV_KEYS } from "./runtime-env.js";

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

  console.log("zcode-acp-bridge 自检\n");

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
  const credPath = path.join(process.env.ZCODE_DATA_BASE_DIR ?? homedir(), ".zcode", "v2", "credentials.json");
  if (existsSync(credPath)) ok(`已登录（凭据：${credPath}）`);
  else warn(`未登录（${credPath} 不存在）。执行 zcode-acp-bridge login 登录；纯 api-key 配置可忽略`);

  // 4. 模型列表（personal provider config 可读才有）
  const models = listModels();
  if (models) {
    const names = models.availableModels.slice(0, 3).map((m) => m.name).join("、");
    const more = models.availableModels.length > 3 ? " 等" : "";
    ok(`模型 ${models.availableModels.length} 个（${names}${more}）`);
  } else {
    bad("读不到模型列表：personal provider config 缺失或损坏（登录后由 zcode 生成）");
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
 * 仅在检测到 Desktop 签发的 endpoint 时执行（这些变量只有 ZCode Desktop
 * 打开的终端里才有）；返回导出的键数量，不适合导出时返回 -1。
 */
function exportRuntimeEnvFile() {
  if (!process.env.ZCODE_OFFICIAL_ENDPOINT) return -1;
  const entries = RUNTIME_ENV_KEYS.filter((key) => process.env[key]).map(
    (key) => `${key}=${process.env[key]}`,
  );
  if (entries.length === 0) return -1;
  writeFileSync(defaultEnvFile(), `${entries.join("\n")}\n`, { mode: 0o600 });
  return entries.length;
}

/** setup：自检 + Desktop 环境导出 + 客户端接入片段。 */
export async function runSetup() {
  const healthy = await runDoctor();
  console.log();

  const exported = exportRuntimeEnvFile();
  if (exported >= 0) {
    console.log(`已导出认证环境（${exported} 项）到 ${defaultEnvFile()}`);
    console.log("注意：ZCode Desktop 重启后 endpoint/token 会更换，届时重新运行 setup。");
  } else if (process.env.ZCODE_OFFICIAL_ENDPOINT === undefined) {
    console.log("当前终端不是 ZCode Desktop 会话，跳过认证环境导出（独立 login 用户无需此步）。");
  } else {
    console.warn("检测到 Desktop 环境但没有可导出的变量，请在 ZCode Desktop 打开的终端里运行 setup。");
  }

  console.log(`
客户端接入（command 均为 zcode-acp-bridge，走 PATH 解析）：

  Zed        settings.json:
             { "agent_servers": { "zcode": { "command": "zcode-acp-bridge", "args": [] } } }

  OpenIdea   %APPDATA%/<OpenIdea>/agents/zcode.toml:
             name = "ZCode"
             command = 'zcode-acp-bridge'

  其它 ACP 客户端
             以 stdio NDJSON 拉起 zcode-acp-bridge（无参数即 ACP 服务）。

提示词经 --prompt=<text> 等号形式传入，客户端输入不会逃逸成 CLI 选项。`);
  return healthy;
}
