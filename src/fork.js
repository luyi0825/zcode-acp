// zcode 会话 fork：headless 没有 fork 参数（/fork 是 TUI 命令，-p 下退出码 1），
// 借 app-server（ZCode Protocol）走 ZCode Desktop 同款 fork 路径：
// session/resume 加载原会话，session/fork 把历史复制进独立新会话，
// 后续 --resume=<新id> 与原会话天然隔离。
//
// 协议要点（zcode 0.17.1 实测，NDJSON 帧）：
// - 请求 {id,method,params}，响应 {id,result|error}；启动后等
//   startup/storageState phase=ready 才能发请求；
// - resume 期间服务端会发反向请求（运行时偏好 / 官方 MCP 认证头），必须应答，
//   否则 15s 超时卸载会话，fork 报 runtimeNotReady；
// - fork target 取最后一条消息 id：latestCheckpoint 在无文件改动的纯对话
//   会话报 "No workspace checkpoint"，message 形态两种场景都通。
import { spawn } from "node:child_process";
import { resolveZcode } from "./cli-locate.js";
import { applyZcodeRuntimeEnv, killTree, summarizeStderr } from "./zcode.js";

// 与 zcode.js 的判定保持一致（后者未导出 WIN，这里只用于 spawn 选项）。
const WIN = process.platform === "win32";
// fork 全程预算：resume 要物化运行时，大会话可能偏慢；超时报错而不是挂死客户端。
const FORK_TIMEOUT_MS = 60000;
// stderr 只留尾部供错误摘要，避免长输出吃满内存。
const MAX_STDERR = 8192;

/**
 * fork 指定 zcode 会话，返回新会话 id。
 * 规则：
 * - 会话没有任何消息时返回 null（无历史可复制，调用方按新建处理）；
 * - 失败抛带服务端消息的错误，由调用方报给客户端，绝不静默降级成共享会话；
 * - 子进程专用于本次 fork：成功 / 失败 / 超时都整树杀掉，不复用。
 */
export function forkZcodeSession({ cwd, sessionId }) {
  const { node, cli } = resolveZcode();
  const env = { ...process.env };
  applyZcodeRuntimeEnv(env, cli);
  return new Promise((resolve, reject) => {
    const child = spawn(node, [cli, "app-server", "--stdio"], {
      cwd,
      env,
      windowsHide: true,
      // POSIX 下自成进程组，收尾按组杀（见 killTree）。Windows 无进程组，不用。
      detached: !WIN,
    });
    let settled = false;
    let ready = false;
    let stderr = "";
    let buffer = "";
    let nextId = 1;
    const pending = new Map();

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      const detail = stderr ? `\n${summarizeStderr(stderr)}` : "";
      reject(new Error(`${error.message}${detail}`));
    };
    const timer = setTimeout(() => fail(new Error("app-server fork 超时")), FORK_TIMEOUT_MS);

    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });

    const drive = async () => {
      const resumed = await request("session/resume", { sessionId });
      const messages = resumed?.messages ?? [];
      if (messages.length === 0) {
        finish(null);
        return;
      }
      const messageId = messages.at(-1)?.info?.messageId;
      if (typeof messageId !== "string" || !messageId) {
        throw new Error("无法解析 fork 目标消息 id");
      }
      const forked = await request("session/fork", { sessionId, target: { kind: "message", messageId } });
      const forkedSessionId = forked?.forkedSessionId;
      if (typeof forkedSessionId !== "string" || !forkedSessionId) {
        throw new Error("app-server 未返回 forkedSessionId");
      }
      finish(forkedSessionId);
    };

    const handle = (msg) => {
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message ?? "app-server 请求失败"));
        else res(msg.result);
        return;
      }
      // 服务端反向请求：不应答会让 resume 超时卸载会话。运行时偏好按 headless
      // 默认（native search 关，其余字段走 schema 默认值）；官方 MCP 认证头
      // 回空——bridge 不持有 Desktop 登录态。未知请求同样回空对象兜底。
      if (msg.id !== undefined && msg.method) {
        const result = msg.method === "session/requestRuntimePreferences"
          ? { nativeSearchEnhancementsEnabled: false }
          : {};
        child.stdin.write(JSON.stringify({ id: msg.id, result }) + "\n");
        return;
      }
      if (msg.method === "startup/storageState" && msg.params?.phase === "ready" && !ready) {
        ready = true;
        drive().catch(fail);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          // 非 JSON 行只可能是诊断输出，丢掉即可。
          continue;
        }
        handle(msg);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
    });
    // 子进程先退时写 stdin 会 EPIPE：错误交给 exit 分支统一处理，这里吞掉防崩。
    child.stdin.on("error", () => {});
    child.on("error", fail);
    child.on("exit", (code) => {
      if (!settled) fail(new Error(`app-server 提前退出（code=${code}）`));
    });
  });
}
