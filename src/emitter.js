// ACP 会话通知发送。
// 分层原因：会话更新的构造与发送集中在此，agent.js 只管协议流程。
// 传输为 ACP 的 stdio NDJSON 连接，本模块不发起任何网络请求。
import * as acp from "@agentclientprotocol/sdk";

const MAX_TEXT = 20000;

// 连接级客户端句柄：进程只有一个 ACP 连接，在 connect 时注册一次。
let client = null;

/** 注册当前 ACP 连接的客户端句柄。 */
export function attachClient(agentContext) {
  client = agentContext;
}

/** 文本裁剪，避免把超长内容整段推给客户端。 */
function clip(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * 向客户端发一条会话更新。
 * 规则：sessionId 由调用方持有（本进程 session/new 时签发）；连接未就绪时静默丢弃。
 */
export function emitUpdate(sessionId, update) {
  if (!client) return Promise.resolve();
  return client.notify(acp.methods.client.session.update, { sessionId, update });
}

/** 发一段助手文本；空文本不发。 */
export function emitText(sessionId, text) {
  if (!text) return Promise.resolve();
  return emitUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: clip(text) },
  });
}
