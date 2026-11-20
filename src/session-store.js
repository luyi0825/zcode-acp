// bridge 会话续接状态落盘：ACP sessionId → zcode 续接所需的最小状态。
//
// 背景：zcodeSessionId（zcode CLI 真实会话 id）原先只存 bridge 内存，进程重启
// 或记录被淘汰即丢。客户端 IM 多轮对话带着旧 ACP sessionId 调 resume/load 时，
// 重建的记录拿不到 zcodeSessionId，下一轮不带 --resume → zcode 新建会话，
// 表现为同一对话反复创建出多个重复会话。这里把续接状态按 ACP sessionId 持久化，
// resume/load 重建记录时恢复，续接不再断。
//
// 只存续接需要的字段（zcodeSessionId / model / reasoningLevel / mode）；
// cwd 每次 resume/load 都由客户端带上，不必落盘。消息历史仍不持久化（见 agent.js）。
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homeDir } from "./runtime-env.js";

// 落盘上限：bridge 被宿主长期复用，会话只增不减；超出按最旧淘汰，
// 与内存 records 的淘汰同思路（磁盘留得比内存多，供重启后恢复）。
const MAX_PERSISTED = 256;

/**
 * 落盘文件路径。
 * 规则：显式环境变量优先（测试隔离 / 运维改路径）；否则用户主目录下的
 * `.zcode-acp-sessions.json`，与 bridge 自有的 `.zcode-acp.env` 同处一地。
 */
export function sessionStorePath() {
  return process.env.ZCODE_ACP_SESSION_STORE_FILE ?? path.join(homeDir(), ".zcode-acp-sessions.json");
}

/**
 * 读整份映射。
 * 规则：
 * - 用 null 原型对象承载，键来自客户端 sessionId，杜绝 `__proto__`/`constructor`
 *   这类键经括号赋值触发原型 setter（信任边界）；
 * - 文件不存在 / 损坏 / 非对象一律当空映射：落盘是增强项，读失败降级回内存-only。
 */
function readStore(file) {
  const store = Object.create(null);
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return store;
  }
  if (doc && typeof doc === "object") {
    for (const key of Object.keys(doc)) store[key] = doc[key];
  }
  return store;
}

/**
 * 把落盘状态填进重建的记录（resume/load 内存未命中时调用）。
 * 规则：只覆盖落盘里确实存在的合法字段，其余保持 createRecord 的默认值；
 * 没有该 id 的落盘（全新会话）时原样返回，不影响后续新建。
 */
export function restoreSession(record, file = sessionStorePath()) {
  const saved = readStore(file)[record.id];
  if (!saved || typeof saved !== "object") return;
  if (typeof saved.zcodeSessionId === "string") record.zcodeSessionId = saved.zcodeSessionId;
  if (saved.model && typeof saved.model === "object") record.model = saved.model;
  if (typeof saved.reasoningLevel === "string") record.reasoningLevel = saved.reasoningLevel;
  if (typeof saved.mode === "string") record.mode = saved.mode;
}

/**
 * 落盘当前记录的续接状态（读-改-写整份映射）。
 * 规则：
 * - 临时文件 + rename 原子替换，避免写一半崩溃留下半截 JSON 毁掉整份映射；
 *   临时名带 pid，多进程并发写不互相覆盖（同目录 rename 才原子）；
 * - 超上限按 updatedAt 淘汰最旧；
 * - 任何异常都吞掉降级回内存-only，落盘失败绝不能阻断会话本身。
 */
export function persistSession(record, file = sessionStorePath()) {
  try {
    const store = readStore(file);
    store[record.id] = {
      zcodeSessionId: record.zcodeSessionId,
      model: record.model,
      reasoningLevel: record.reasoningLevel,
      mode: record.mode,
      updatedAt: Date.now(),
    };
    const ids = Object.keys(store);
    if (ids.length > MAX_PERSISTED) {
      ids.sort((a, b) => (store[a].updatedAt ?? 0) - (store[b].updatedAt ?? 0));
      for (const id of ids.slice(0, ids.length - MAX_PERSISTED)) delete store[id];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(store));
    renameSync(tmp, file);
  } catch {
    // 落盘失败（权限/磁盘满等）降级：会话仍按内存状态继续，只是重启后丢映射。
  }
}
