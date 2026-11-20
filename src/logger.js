// 诊断日志（NDJSON 追加式）：bridge 跑在宿主进程树下，stderr 通常被宿主吞掉，
// 宿主侧行为异常（如客户端看不到版本、会话突然中断）没有现场可查，这里提供
// 文件级现场：设 ZCODE_ACP_LOG 指向目标文件即启用，未设置整体 no-op（零开销）。
//
// 规则：
// - 一行一个 JSON 事件（ts + event + 字段），追加写、不做轮转——文件由使用者
//   自行管理（shortcut: 无轮转，长期开日志的部署用 logrotate 类外部工具截断）；
// - 写失败绝不影响会话：首次失败在 stderr 提示一次（手动跑 doctor / 终端拉起时
//   可见，配错路径至少有迹可循），之后静默，避免刷屏；
// - 异步追加不等待：进程退出瞬间可能丢最后一条，日志允许丢尾，换会话不阻塞。
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

// 目录已确保创建（mkdir 只需成功一次）；写入失败提示也只发一次。
let dirReady = false;
let warned = false;

/**
 * 追加一条诊断日志。
 *
 * @param {string} event 事件名（如 "turn.start"），调用方用点分层便于 grep
 * @param {object} [fields] 附加字段；值必须是可直接 JSON 化的原始类型
 */
export function logEvent(event, fields = {}) {
  const file = process.env.ZCODE_ACP_LOG;
  if (!file) return;
  const write = async () => {
    if (!dirReady) {
      await mkdir(path.dirname(file), { recursive: true });
      dirReady = true;
    }
    await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`, "utf8");
  };
  write().catch((err) => {
    if (warned) return;
    warned = true;
    console.error(`zcode-acp: 无法写诊断日志（ZCODE_ACP_LOG=${file}）：${err?.message ?? err}`);
  });
}
