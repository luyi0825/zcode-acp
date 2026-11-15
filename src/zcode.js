// 定位并调用本机 zcode CLI。
// 背景：zcode CLI 随 ZCode Desktop 发行（Windows 在安装根 resources/glm，
// macOS 在 app bundle 的 Contents/Resources/glm），官方不单独分发、也不在
// PATH 上放命令；这里按标准安装路径自适应定位，
// 用系统 Node 运行。不用安装根里的 Electron 二进制：ELECTRON_RUN_AS_NODE
// 模式下实测拿不到完整凭据环境（provider 401）。
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { mergeRuntimeEnv } from "./runtime-env.js";
import { writeSelectionConfig } from "./models.js";

const WIN = process.platform === "win32";

// ZCode 安装根下的固定相对路径，可执行文件只能从这里派生。
const CLI_RELATIVE = path.join("resources", "glm", "zcode.cjs");
const MACOS_CLI_RELATIVE = path.join("Contents", "Resources", "glm", "zcode.cjs");

// zcode 支持的权限模式（--mode 的合法取值，与 CLI 帮助一致）。
// 白名单双重防线：agent 层校验后，这里在 spawn 前再校验一次，
// 非法值一律回落 yolo，外部输入不可能以任意形态进入命令行。
const MODES = new Set(["plan", "build", "edit", "guarded", "yolo"]);

/**
 * 安装根候选（按平台，可移植顺序）。
 * 规则：
 * - 环境变量只表达"安装目录"，可执行文件仍由 CLI_RELATIVE 派生，
 *   避免环境变量换掉实际启动的程序；
 * - ZCODE_WINDOWS_APP_INSTALL_DIR 是 ZCode Desktop 注入给子进程的安装目录，
 *   经 env-file 继承后用于非标准安装位置的自适应定位。
 */
function installRoots() {
  const roots = [];
  for (const key of ["ZCODE_HOME", "ZCODE_WINDOWS_APP_INSTALL_DIR"]) {
    const value = process.env[key];
    if (typeof value === "string" && value && path.isAbsolute(value)) {
      roots.push(value);
    }
  }
  if (WIN) {
    roots.push(
      path.join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode"),
      path.join(process.env.PROGRAMFILES ?? "", "ZCode"),
    );
  } else {
    roots.push("/Applications/ZCode.app");
  }
  return roots;
}

/** 只认已存在的普通文件。 */
function isFile(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isFile();
}

/**
 * 补齐 zcode 运行所需的运行时环境。
 *
 * 规则：
 * - env-file 与调用方显式值优先；builtin provider config 未设置时才按安装根兜底；
 * - 不默认注入 ZCODE_DATA_BASE_DIR：它替代的是 homedir，而非 ~/.zcode，
 *   显式设置还会切入受管模式；Desktop 重定向场景仍由 env-file 提供。
 *
 * 导出供 login 代理复用（login.js）：与 runTurn 用同一套定位与环境准备。
 * @param {string} [cli] 已解析的 zcode.cjs 路径，用于定位实际安装根。
 */
export function applyZcodeRuntimeEnv(env, cli) {
  // Desktop 的认证上下文由使用方导出成 env-file（见 runtime-env.js）。
  mergeRuntimeEnv(env, process.env.ZCODE_ACP_ENV_FILE);
  if (cli && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    // 从 CLI 反推实际安装根，兼容 macOS 的 <bundle>/Contents 布局。
    const installRoot = path.resolve(path.dirname(cli), "..", "..");
    const config = path.join(installRoot, "config", "provider", "zcode-builtin.json");
    if (isFile(config)) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config;
  }
}

/**
 * 解析出可执行的 (node, cli) 组合。
 * 规则：
 * - cli 固定为安装根下的平台对应路径，必须真实存在；
 * - macOS 优先标准 Contents/Resources 布局，回退裸 bundle 的 resources 布局；
 * - node 固定为字面量 "node"（交给 PATH 解析）。
 */
export function resolveZcode() {
  const roots = installRoots();
  const relativeCliPaths = WIN ? [CLI_RELATIVE] : [MACOS_CLI_RELATIVE, CLI_RELATIVE];
  const cli = roots
    .flatMap((root) => relativeCliPaths.map((relative) => path.join(root, relative)))
    .find(isFile);
  if (!cli) {
    throw new Error(
      "找不到 zcode.cjs。请先安装 ZCode Desktop（zcode CLI 随其发行），" +
        "或把环境变量 ZCODE_HOME 指向 ZCode 安装目录",
    );
  }
  return { node: "node", cli };
}

/**
 * 读取 zcode 的 stream-json 事件流并逐条回调。
 * 之所以按行解析：zcode 的 stdout 是 NDJSON，一行一个事件对象。
 */
function onNdjsonStream(readable, onEvent) {
  let buffer = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line));
        } catch {
          // 非 JSON 行只可能是诊断输出，丢掉即可。
        }
      }
      nl = buffer.indexOf("\n");
    }
  });
}

/**
 * 构造 zcode 命令行参数。
 *
 * 规则：
 * - 提示词与模式都用 `--opt=<value>` 等号形式传入：值是完全外部输入，若作为独立
 *   argv 出现，以 `-` 开头会被 zcode 当成选项（选项注入）。等号形式让整个值
 *   固定绑定在选项上，不可能被解析成其他选项。mode 在进入本函数前已过
 *   MODES 白名单（plan/build/edit/guarded/yolo 之一），缺省 yolo 与 zcode
 *   对 --prompt 的默认一致（headless 无确认入口）。
 * - cwd 是本地归一化后的绝对路径。
 */
function buildArgs({ cli, text, cwd, resume, mode }) {
  return [
    cli,
    `--prompt=${text}`,
    "--output-format",
    "stream-json",
    "--cwd",
    cwd,
    `--mode=${mode}`,
    ...(resume ? ["--resume", resume] : []),
  ];
}

/**
 * 跑一轮 zcode。
 *
 * 规则：
 * - 每轮独立进程；多轮上下文由 `--resume <zcodeSessionId>` 续接。
 * - 本函数只负责搬运事件，不了解 ACP 语义。
 * - 取消由调用方通过 `onStart` 拿到的 stop 函数触发，stop 直接结束子进程。
 *
 * @param {object} opts
 * @param {string} opts.cwd 工作目录（已归一化的绝对路径）
 * @param {string} opts.text 用户输入
 * @param {string} [opts.resume] 上一轮产出的 zcode sessionId
 * @param {string} [opts.mode] 权限模式；白名单外或缺省一律按 yolo 执行
 * @param {{providerId: string, modelId: string, reasoningLevel?: string}} [opts.model]
 *   选中的模型与思考级别；headless 无对应参数，靠 provider 配置副本驱动
 *   默认模型与默认思考级别（见 models.js）
 * @param {(stop: () => void) => void} opts.onStart 子进程启动后交回控柄
 * @param {(e: object) => void} opts.onEvent 每个 stream-json 事件回调
 * @returns {Promise<{sessionId?: string, content?: string, error?: string, cancelled?: boolean}>}
 */
export function runTurn({ cwd, text, resume, mode, model, onStart, onEvent }) {
  const { node, cli } = resolveZcode();
  // spawn 前的白名单门卫：只放行枚举内的已知模式。
  const safeMode = MODES.has(mode) ? mode : "yolo";

  const env = { ...process.env };
  applyZcodeRuntimeEnv(env, cli);
  if (model) {
    // 在 merge 之后覆盖，确保副本一定生效（mergeRuntimeEnv 不覆盖已有值）。
    // 生成失败（配置被删/损坏）时沿用原配置，zcode 用其默认模型。
    const copy = writeSelectionConfig(model);
    if (copy) env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = copy;
  }

  return new Promise((resolve) => {
    const child = spawn(node, buildArgs({ cli, text, cwd, resume, mode: safeMode }), {
      cwd,
      env,
      windowsHide: true,
    });

    let zcodeSessionId;
    let content;
    let cancelled = false;
    let stderr = "";

    onStart?.(() => {
      cancelled = true;
      child.kill();
    });

    onNdjsonStream(child.stdout, (event) => {
      if (event.sessionId) zcodeSessionId = event.sessionId;
      if (event.type === "session.updated" && typeof event.payload?.content === "string") {
        // 每轮结束时 zcode 会发一条 payload.content 完整回复。
        content = event.payload.content;
      }
      onEvent(event);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      // 只保留尾部，避免长任务把内存吃满。
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on("error", (err) => resolve({ error: `无法启动 zcode：${err.message}` }));

    child.on("close", (code) => {
      if (cancelled) {
        resolve({ sessionId: zcodeSessionId, cancelled: true });
      } else if (content !== undefined) {
        resolve({ sessionId: zcodeSessionId, content });
      } else {
        // 保留较多行：zcode 的 401/认证类错误需要上下文才能定位。
        const tail = stderr.trim().split("\n").slice(-40).join("\n");
        // 认证过期最常见（ZCode Desktop 重启会换 token），给出可执行的修复指引，
        // 用户在客户端里直接能看到，不用翻日志。
        const authHint = /API Key 不存在|invalid_key|statusCode: 401/.test(stderr)
          ? "\n\n>>> 认证已过期或未登录。请执行 zcode-acp-bridge login 重新登录后重试。"
          : "";
        const ctx = `[debug] cwd=${cwd} HOME=${env.HOME ?? "(unset)"} cli=${cli} node=${node}`;
        resolve({
          sessionId: zcodeSessionId,
          error: `zcode 退出码 ${code}\n${ctx}${tail ? `\n${tail}` : ""}${authHint}`,
        });
      }
    });
  });
}
