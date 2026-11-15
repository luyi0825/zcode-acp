// 定位并调用本机 zcode CLI。
// 背景：zcode CLI 随 ZCode Desktop 发行（安装目录 resources/glm/zcode.cjs），
// 官方不单独分发、也不在 PATH 上放命令；这里按标准安装路径自适应定位，
// 用系统 Node 运行。不用安装根里的 Electron 二进制：ELECTRON_RUN_AS_NODE
// 模式下实测拿不到完整凭据环境（provider 401）。
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { mergeRuntimeEnv } from "./runtime-env.js";
import { writeSelectionConfig } from "./models.js";

const WIN = process.platform === "win32";

// ZCode 安装根下的固定相对路径，可执行文件只能从这里派生。
const CLI_RELATIVE = path.join("resources", "glm", "zcode.cjs");

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

/**
 * 结束整棵进程树。
 * Windows：PATH 上的 node 可能是版本管理器 shim（mise/volta/fnm），shim 再拉真 node；
 *   child.kill() 只杀 shim，真身带着 stdout 管道继续跑，close 永不触发（stop 失效）。
 *   taskkill /T /F 连 shim 带真身及 zcode 工具调用拉起的孙进程一并终止。
 * POSIX：子进程以 detached 启动自成进程组，按组发 SIGKILL；组不存在时退回单进程 kill。
 */
function killTree(child) {
  if (WIN) {
    if (child.pid != null) {
      execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    } else {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill();
  }
}

/** 只认已存在的普通文件。 */
function isFile(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isFile();
}

/** 只认已存在的目录。 */
function isDir(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isDirectory();
}

/**
 * 数据目录候选：zcode 的凭据与 provider 配置都在这里。
 * 规则：优先用已有的 ZCODE_DATA_BASE_DIR（ZCode Desktop 注入），
 * 否则从本进程可见的环境推断，最后回退 <用户主目录>。
 */
function dataBaseDirs() {
  const dirs = [];
  if (process.env.ZCODE_DATA_BASE_DIR) dirs.push(process.env.ZCODE_DATA_BASE_DIR);
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) dirs.push(path.join(home, ".zcode"));
  return dirs.filter((d) => typeof d === "string" && path.isAbsolute(d));
}

/**
 * 补齐 zcode 运行所需的运行时环境。
 *
 * 规则：
 * - ZCODE_DATA_BASE_DIR 是认证的关键：缺了它 zcode 会去默认位置找凭据，
 *   被其它宿主拉起时表现为 provider 401 "API Key 不存在"。
 * - 只在未设置时补齐，不覆盖调用方显式给的值。
 *
 * 导出供 login 代理复用（login.js）：与 runTurn 用同一套定位与环境准备。
 */
export function applyZcodeRuntimeEnv(env) {
  // Desktop 的认证上下文由使用方导出成 env-file（见 runtime-env.js）。
  mergeRuntimeEnv(env, process.env.ZCODE_ACP_ENV_FILE);
  if (!env.ZCODE_DATA_BASE_DIR) {
    const dir = dataBaseDirs().find(isDir);
    if (dir) env.ZCODE_DATA_BASE_DIR = dir;
  }
}

/**
 * 解析出可执行的 (node, cli) 组合。
 * 规则：
 * - cli 固定为 <安装根>/resources/glm/zcode.cjs，必须真实存在；
 * - node 固定为字面量 "node"（交给 PATH 解析）。
 */
export function resolveZcode() {
  const roots = installRoots();
  const cli = roots.map((root) => path.join(root, CLI_RELATIVE)).find(isFile);
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
 * - 取消由调用方通过 `onStart` 拿到的 stop 函数触发，stop 结束整棵进程树（见 killTree）。
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
  // 被其它宿主拉起时不继承 ZCode Desktop 的运行时环境：缺 ZCODE_DATA_BASE_DIR 会去
  // 错误的目录找凭据，缺 ZCODE_OFFICIAL_ENDPOINT 拿不到认证管道，表现为
  // provider 401 "API Key 不存在"。这里从配置补齐（见 applyZcodeRuntimeEnv）。
  applyZcodeRuntimeEnv(env);
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
      // POSIX 下自成进程组，stop 时按组杀（见 killTree）。Windows 无进程组，不用。
      detached: !WIN,
    });

    let zcodeSessionId;
    let content;
    let cancelled = false;
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    onStart?.(() => {
      cancelled = true;
      killTree(child);
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

    child.on("error", (err) => finish({ error: `无法启动 zcode：${err.message}` }));

    child.on("exit", () => {
      // 兜底：cancel 场景下不等管道排空。被 taskkill 的进程若有幸存句柄拖住
      // stdout 管道，close 可能迟迟不来，而取消结果不需要等剩余输出。
      if (cancelled) finish({ sessionId: zcodeSessionId, cancelled: true });
    });

    child.on("close", (code) => {
      if (cancelled) {
        finish({ sessionId: zcodeSessionId, cancelled: true });
      } else if (content !== undefined) {
        finish({ sessionId: zcodeSessionId, content });
      } else {
        // 保留较多行：zcode 的 401/认证类错误需要上下文才能定位。
        const tail = stderr.trim().split("\n").slice(-40).join("\n");
        // 认证过期最常见（ZCode Desktop 重启会换 token），给出可执行的修复指引，
        // 用户在客户端里直接能看到，不用翻日志。
        const authHint = /API Key 不存在|invalid_key|statusCode: 401/.test(stderr)
          ? "\n\n>>> 认证已过期或未登录。请执行 zcode-acp login 重新登录后重试。"
          : "";
        const ctx = `[debug] cwd=${cwd} HOME=${env.HOME ?? "(unset)"} cli=${cli} node=${node}`;
        finish({
          sessionId: zcodeSessionId,
          error: `zcode 退出码 ${code}\n${ctx}${tail ? `\n${tail}` : ""}${authHint}`,
        });
      }
    });
  });
}
