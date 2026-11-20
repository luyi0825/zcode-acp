// 定位并调用本机 zcode CLI。
// CLI 定位本身在 cli-locate.js（models.js 也要用，放在这里会形成循环依赖）。
// 背景：zcode CLI 随 ZCode Desktop 发行（Windows 在安装根 resources/glm，
// macOS 在 app bundle 的 Contents/Resources/glm），官方不单独分发、也不在
// PATH 上放命令；用系统 Node 运行。不用安装根里的 Electron 二进制：
// ELECTRON_RUN_AS_NODE 模式下实测拿不到完整凭据环境（provider 401）。
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveZcode } from "./cli-locate.js";
import { builtinProviderConfigAt, dataBaseDir, homeDir, mergeRuntimeEnv } from "./runtime-env.js";
import { writeSelectionConfig } from "./models.js";
import { logEvent } from "./logger.js";

// CLI 定位在 cli-locate.js；这里转出给 login/commands/doctor 沿用原有导入路径。
export { resolveZcode };

// 与 cli-locate.js 的判定保持一致（后者未导出 WIN，这里只用于 spawn 选项）。
const WIN = process.platform === "win32";

// zcode 支持的权限模式（--mode 的合法取值，与 CLI 帮助一致）。
// 白名单双重防线：agent 层校验后，这里在 spawn 前再校验一次，
// 非法值一律回落 yolo，外部输入不可能以任意形态进入命令行。
const MODES = new Set(["plan", "build", "edit", "guarded", "yolo"]);

// stderr 里的噪声行：栈帧，以及崩溃时被打断的压缩 bundle 源码。
// 压缩源码的可靠特征是「很长却几乎没有空白」（正常错误消息总是有断词的空格）。
// 长度门槛取 80：低于它的短片段即使来自源码也带不出有效信息，留着无害。
const SOURCE_NOISE_MIN_LENGTH = 80;
function isNoiseLine(line) {
  if (/^\s*at [^()]*(\(.*\))?$/.test(line)) return true;
  if (line.length < SOURCE_NOISE_MIN_LENGTH) return false;
  const spaces = (line.match(/\s/g) ?? []).length;
  return spaces * 20 < line.length;
}

/**
 * 结束整棵进程树。
 * Windows：PATH 上的 node 可能是版本管理器 shim（mise/volta/fnm），shim 再拉真 node；
 *   child.kill() 只杀 shim，真身带着 stdout 管道继续跑，close 永不触发（stop 失效）。
 *   taskkill /T /F 连 shim 带真身及 zcode 工具调用拉起的孙进程一并终止。
 * POSIX：子进程以 detached 启动自成进程组，按组发 SIGKILL；组不存在时退回单进程 kill。
 */
export function killTree(child) {
  if (WIN) {
    const pid = child.pid;
    // pid 由 spawn 返回（内核分配的正整数），非数字时退回单进程 kill。
    // 用数组形式的参数列表交给 spawn（shell: false，不经任何命令行解释器）；
    // pid 先转成十进制字符串，字符集封闭为数字，不会被解析成其它选项。
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
      // 先构造完整参数列表再交给 spawn：参数以数组元素传递，不拼接到任何命令行。
      // pid 已被限定为正安全整数，再显式断言其十进制形态不带前导符号，
      // 保证 taskkill 收到的永远是纯数字值。（taskkill 不支持 `--` 终止符
      // 也不支持 `/pid=` 等号形式，实测均报"无效参数/选项"，故只能靠值域保证。）
      const pidArg = pid.toString(10);
      if (!/^[0-9]+$/.test(pidArg)) {
        child.kill();
        return;
      }
      const args = ["/pid", pidArg, "/T", "/F"];
      const killer = spawn("taskkill", args, {
        windowsHide: true,
        stdio: "ignore",
        shell: false,
      });
      // 失败不外抛：taskkill 不存在或进程已退出都不影响后续流程。
      killer.on("error", () => {});
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

/**
 * 补齐 zcode 运行所需的运行时环境。
 *
 * 规则：
 * - env-file 与调用方显式值优先；builtin provider config 未设置时才按安装根兜底；
 * - ZCODE_DATA_BASE_DIR 未设置时用 dataBaseDir() 的自动发现结果补上：
 *   CLI 自身不读 Desktop 的 setting.json，不注入就会退回家目录读到旧配置
 *   （provider 401）；未重定向时它与 homedir 同值，无副作用。
 *
 * 导出供 login 代理复用（login.js）：与 runTurn 用同一套定位与环境准备。
 * @param {string} [cli] 已解析的 zcode.cjs 路径，用于定位实际安装根。
 */
export function applyZcodeRuntimeEnv(env, cli) {
  // Desktop 的认证上下文由使用方导出成 env-file（见 runtime-env.js）。
  mergeRuntimeEnv(env, process.env.ZCODE_ACP_ENV_FILE);
  if (!env.ZCODE_DATA_BASE_DIR) {
    const base = dataBaseDir();
    // 与 homedir 相同表示未重定向，保持不注入（CLI 默认行为即可）。
    if (base !== homeDir()) env.ZCODE_DATA_BASE_DIR = base;
  }
  if (cli && !env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
    const config = builtinProviderConfigAt(cli);
    if (config) env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config;
  }
}

// 兜底解析的原始输出上限：命令类输出是一个小 JSON 文档，超限即判定不是该形态。
const MAX_RAW_OUTPUT = 1024 * 1024;

/**
 * 读取 zcode 的 stream-json 事件流并逐条回调。
 * 之所以按行解析：zcode 的 stdout 是 NDJSON，一行一个事件对象。
 * 返回原始输出取值函数：内置斜杠命令（/goal 等）不产生 NDJSON，整段 stdout
 * 是一个普通 JSON 文档，收尾时要从这里兜底解析。
 */
function onNdjsonStream(readable, onEvent) {
  let buffer = "";
  let raw = "";
  readable.setEncoding("utf8");
  readable.on("data", (chunk) => {
    if (raw.length < MAX_RAW_OUTPUT) raw = (raw + chunk).slice(0, MAX_RAW_OUTPUT);
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
  return () => raw;
}

/**
 * 解析命令类输出：zcode 的内置斜杠命令（实测 /goal）在 headless 下会以与
 * `--output-format json` 同形的整段 JSON 文档输出，而不是 NDJSON 事件流。
 *
 * 规则：
 * - 只取 response 作为回显文本；**不取其中的 sessionId**——实测那是命令执行时
 *   的临时会话，拿它 --resume 会报 "Session not found"，续接必须沿用原会话；
 * - 不是该形态（空输出、NDJSON 事件流、缺 response）时返回 null。
 */
export function parseCommandOutput(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || typeof doc.response !== "string") return null;
  return { response: doc.response };
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
 * - attachments 是本进程自己写的临时文件（见 runTurn），同样用等号形式绑定，
 *   每个附件一个 `--attach=`，避免路径以 `-` 开头时被当成选项。
 */
function buildArgs({ cli, text, cwd, resume, mode, attachments }) {
  // 所有可变值都以 `--opt=<值>` 的单个 argv 出现（等号绑定）：即使值以 `-` 开头，
  // 也只能作为该选项的值被消费，不可能变成独立选项。配合 spawn 的数组传参
  //（shell: false），用户输入无法逃逸为选项或命令。
  return [
    cli,
    `--prompt=${text}`,
    "--output-format",
    "stream-json",
    `--cwd=${cwd}`,
    `--mode=${mode}`,
    ...(resume ? [`--resume=${resume}`] : []),
    ...(attachments ?? []).map((file) => `--attach=${file}`),
  ];
}

/**
 * 从 stderr 提取可读的错误摘要。
 *
 * 规则：
 * - zcode 崩溃时会把被打断的那行 bundle 源码（数 KB 单行）一并打进 stderr，
 *   原样转给用户完全不可读，因此优先只取 `Error:` / `SdkError:` 行；
 * - 没有错误行时退回尾部上下文：丢弃超长行与栈帧/源码特征行，
 *   并把 `providerXxx:` 这类结构化字段前置（provider 报错的真正原因都在这里）；
 * - 保留较多行是因为 401 / 认证类错误需要上下文才能定位。
 */
export function summarizeStderr(stderr) {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = [...new Set(lines.filter((line) => /^(Sdk)?Error: /.test(line)))];
  if (errors.length > 0) return errors.slice(0, 5).join("\n");

  // 没有 Error: 行时（provider 报错、崩溃中途被打断的 bundle 源码）挑可读的尾部行：
  // 丢掉压缩源码与栈帧，优先保留 provider* 结构化字段，
  // 否则客户端里看到的会是一屏源码而不是错误原因。
  const readable = lines.filter((line) => line.length <= 300 && !isNoiseLine(line));
  const providerLines = readable.filter((line) => /^provider[A-Za-z]*:/.test(line));
  const rest = readable.filter((line) => !providerLines.includes(line));
  return [...providerLines, ...rest].slice(-20).join("\n");
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
 * @param {string} [opts.envelope] 上下文文本（MiCO 任务模板），仅首轮写入临时附件
 *   后经 `--attach` 交给 CLI：附件进模型上下文且跨 resume 保留，但不进会话标题与首条消息
 * @returns {Promise<{sessionId?: string, content?: string, error?: string, cancelled?: boolean}>}
 */
export function runTurn({ cwd, text, resume, mode, model, envelope, onStart, onEvent }) {
  // 用户输入的唯一入口：只接受字符串。下游把它拼进 `--prompt=<值>` 单个 argv
  //（见 buildArgs），非字符串会让拼接结果形态不可控，这里直接拒绝。
  if (typeof text !== "string") throw new TypeError("runTurn: text 必须是字符串");
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

  // 上下文附件：写到本轮独享临时目录，进程结束后整目录删除。
  // 只在首轮（无 --resume）挂入：附件内容跨 --resume 持久保留（见 prompt-envelope.js），
  // 续接轮再挂会在会话里累积出重复的 context.md 文件 part；首轮挂一次即够全程使用。
  // shortcut: 首轮无信封、续接轮才出现信封的罕见场景会漏挂, 出现该场景再改为按会话跟踪已挂状态。
  // 写失败不阻断执行——退回把文本拼进 prompt 会让标题变脏，但功能优先。
  const attachmentDir = !resume && typeof envelope === "string" && envelope.trim()
    ? mkdtempSync(path.join(tmpdir(), "zcode-acp-context-"))
    : null;
  const attachments = [];
  if (attachmentDir) {
    const file = path.join(attachmentDir, "context.md");
    writeFileSync(file, envelope, "utf8");
    attachments.push(file);
  }
  const cleanup = () => {
    if (!attachmentDir) return;
    try {
      rmSync(attachmentDir, { recursive: true, force: true });
    } catch {
      // Windows 上子进程刚退出时句柄可能还没释放，留给系统临时目录清理。
    }
  };

  // 每轮生命周期落日志（spawn 参数与退出结果）：宿主侧行为异常时这是唯一现场。
  const startedAt = Date.now();
  logEvent("turn.start", {
    cwd,
    mode: safeMode,
    resumed: Boolean(resume),
    textLength: text.length,
    model: model?.modelId,
    reasoningLevel: model?.reasoningLevel,
    envelope: Boolean(attachmentDir),
  });

  return new Promise((resolve) => {
    const child = spawn(node, buildArgs({ cli, text, cwd, resume, mode: safeMode, attachments }), {
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
      logEvent("turn.end", {
        ms: Date.now() - startedAt,
        cancelled: Boolean(result.cancelled),
        failed: Boolean(result.error),
        hasContent: result.content !== undefined,
      });
      // 临时上下文附件只服务本轮进程，收尾时一并删除（含所有提前返回路径）。
      cleanup();
      resolve(result);
    };

    onStart?.(() => {
      cancelled = true;
      killTree(child);
    });

    const rawOutput = onNdjsonStream(child.stdout, (event) => {
      if (event.sessionId) zcodeSessionId = event.sessionId;
      if (event.type === "session.updated" && typeof event.payload?.content === "string") {
        // 每轮结束时 zcode 会发一条 payload.content 完整回复。
        content = event.payload.content;
      }
      // 内置斜杠命令（/compact 等）不发 payload.content，回复只在末尾 result 行的
      // response 字段；正常轮次没有 content 时用它兜底，两者内容一致。
      if (event.type === "result" && typeof event.response === "string" && content === undefined) {
        content = event.response;
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
        return;
      }
      // 正常轮次取 session.updated 的完整回复；命令类轮次取末尾 result 行，
      // 再不济按整段 JSON 文档兜底（/goal 等不产出任何 NDJSON 事件）。
      const reply = content ?? parseCommandOutput(rawOutput())?.response;
      if (reply !== undefined) {
        finish({ sessionId: zcodeSessionId, content: reply });
        return;
      }
      // 保留较多行：zcode 的 401/认证类错误需要上下文才能定位。
      const tail = summarizeStderr(stderr);
      // 认证过期最常见（ZCode Desktop 重启会换 token），给出可执行的修复指引，
      // 用户在客户端里直接能看到，不用翻日志。
      const authHint = /API Key 不存在|invalid_key|statusCode: 401/.test(stderr)
        ? "\n\n>>> 认证已过期或未登录。请执行 zcode-acp login 重新登录后重试。"
        : "";
      const ctx = `[debug] cwd=${cwd} HOME=${env.HOME ?? env.USERPROFILE ?? "(unset)"} cli=${cli} node=${node}`;
      finish({
        sessionId: zcodeSessionId,
        error: `zcode 退出码 ${code}\n${ctx}${tail ? `\n${tail}` : ""}${authHint}`,
      });
    });
  });
}
