// 自测：起一个本地 ACP 客户端，经 CLI 入口直连 bridge，验证 initialize /
// session/new / session/prompt 流式文本 / 多轮续接 / cancel / 模型选择 / 思考级别。
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BRIDGE = path.resolve(import.meta.dirname, "../bin/cli.js");
const cwd = mkdtempSync(path.join(tmpdir(), "zcode-acp-smoke-"));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
}

// 极简 ACP 客户端：NDJSON 帧 + 请求/通知分发。
function startClient() {
  const child = spawn(process.execPath, [BRIDGE], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const updates = [];
  let nextId = 1;
  let buffer = "";

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
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method === "session/update") {
        updates.push(msg.params.update);
      }
    }
  });

  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => stderr.push(d));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 180_000);
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  return {
    request,
    notify,
    updates,
    stderr: () => stderr.join(""),
    kill: () => child.kill(),
    exited: new Promise((resolve) => child.on("close", resolve)),
  };
}

const client = startClient();
const textOf = () =>
  client.updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");

try {
  // 1. 握手
  const init = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  check("initialize 返回 protocolVersion", init.protocolVersion === 1, JSON.stringify(init));
  check("initialize 声明 agentInfo.name", init.agentInfo?.name === "zcode-acp-bridge");

  // 2. 建会话
  const { sessionId } = await client.request("session/new", { cwd, mcpServers: [] });
  check("session/new 返回 sessionId", typeof sessionId === "string" && sessionId.length > 0);

  // 3. 第一轮：验证流式文本
  writeFileSync(path.join(cwd, "note.txt"), "alpha-7731 is the code word\n");
  const r1 = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "Read note.txt and reply with only the code word." }],
  });
  check("第一轮 stopReason=end_turn", r1.stopReason === "end_turn", JSON.stringify(r1));
  check("第一轮流式产出包含 alpha-7731", textOf().includes("alpha-7731"), JSON.stringify(textOf()));

  // 4. 第二轮：验证 --resume 续接（不再给文件内容，只能靠上下文）
  const before = client.updates.length;
  const r2 = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: "What was that code word again? One word only." }],
  });
  const secondText = client.updates
    .slice(before)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  check("第二轮 stopReason=end_turn", r2.stopReason === "end_turn", JSON.stringify(r2));
  check("第二轮凭上下文答出 alpha-7731", secondText.includes("alpha-7731"), JSON.stringify(secondText));

  // 5. cancel：发一个长任务立刻取消
  const cancelSession = await client.request("session/new", { cwd, mcpServers: [] });
  const pendingPrompt = client.request("session/prompt", {
    sessionId: cancelSession.sessionId,
    prompt: [{ type: "text", text: "Count slowly from 1 to 400, one number per line." }],
  });
  await new Promise((r) => setTimeout(r, 2500));
  client.notify("session/cancel", { sessionId: cancelSession.sessionId });
  const r3 = await pendingPrompt;
  check("cancel 后 stopReason=cancelled", r3.stopReason === "cancelled", JSON.stringify(r3));

  // 6. 未知 sessionId 必须报错
  let notFound = false;
  try {
    await client.request("session/prompt", {
      sessionId: "00000000-0000-0000-0000-000000000000",
      prompt: [{ type: "text", text: "hi" }],
    });  } catch {
    notFound = true;
  }
  check("未知 sessionId 被拒绝", notFound);

  // 7. resume/load 未知 sessionId 要重建而不是报错（bridge 进程重启后内存丢失，
  //    客户端的 IM 多轮对话靠它续接，报错会让第二轮起全部失败）
  const ghost = "11111111-2222-4333-8444-555555555555";
  const resumed = await client.request("session/resume", { sessionId: ghost, cwd });
  check("session/resume 未知 id 不报错", !resumed.error, JSON.stringify(resumed).slice(0, 120));
  const loaded = await client.request("session/load", { sessionId: ghost, cwd, mcpServers: [] });
  check("session/load 未知 id 不报错", !loaded.error, JSON.stringify(loaded).slice(0, 120));

  // 8. session/set_model：部分宿主的私有扩展，不实现会 -32601 使任务失败。
  //    未知模型不报错也不生效（保持默认）。
  const setModel = await client.request("session/set_model", {
    sessionId,
    modelId: "kimi-k2",
  });
  check("session/set_model 未知模型不报错", !setModel.error, JSON.stringify(setModel).slice(0, 120));

  // 9. 模型选择：真实列表（provider::model 编码）→ set_model 生效 → load 回显 → prompt 可跑
  const modelSession = await client.request("session/new", { cwd, mcpServers: [] });
  const models = modelSession.models ?? {};
  check(
    "session/new 返回模型列表",
    Array.isArray(models.availableModels) && models.availableModels.length > 0 &&
      typeof models.currentModelId === "string",
    JSON.stringify(models).slice(0, 200),
  );
  const firstModel = models.availableModels?.[0];
  if (firstModel && firstModel.modelId !== "zcode") {
    check(
      "modelId 为 provider::model 编码",
      firstModel.modelId.includes("::") && models.currentModelId === firstModel.modelId,
      JSON.stringify(firstModel),
    );
    // 取第二个模型，覆盖跨 provider 场景（默认第一个是 providerOrder[0]）
    const target = models.availableModels[1] ?? firstModel;
    const setKnown = await client.request("session/set_model", {
      sessionId: modelSession.sessionId,
      modelId: target.modelId,
    });
    check("session/set_model 已知模型不报错", !setKnown.error, JSON.stringify(setKnown).slice(0, 120));
    const reloaded = await client.request("session/load", {
      sessionId: modelSession.sessionId,
      cwd,
      mcpServers: [],
    });
    check(
      "session/load 回显选中模型",
      reloaded.models?.currentModelId === target.modelId,
      JSON.stringify(reloaded.models?.currentModelId),
    );
    // 选中模型下跑一轮，验证 provider 配置副本不破坏 zcode 启动
    const markBefore = client.updates.length;
    const r4 = await client.request("session/prompt", {
      sessionId: modelSession.sessionId,
      prompt: [{ type: "text", text: "Reply with only: PONG" }],
    });
    const modelText = client.updates
      .slice(markBefore)
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content.text)
      .join("");
    check("选中模型下 stopReason=end_turn", r4.stopReason === "end_turn", JSON.stringify(r4));
    check("选中模型下有回复", modelText.length > 0, JSON.stringify(modelText));
  }

  // 10. 思考级别：configOptions 声明 → set_config_option → load 回显 → prompt 可跑
  const reasonSession = await client.request("session/new", { cwd, mcpServers: [] });
  const reasonOption = (reasonSession.configOptions ?? []).find((o) => o.id === "reasoning");
  check(
    "session/new 声明思考级别选项",
    reasonOption?.currentValue === "max" && reasonOption.options.some((o) => o.value === "low"),
    JSON.stringify(reasonSession.configOptions).slice(0, 200),
  );
  const setOption = await client.request("session/set_config_option", {
    sessionId: reasonSession.sessionId,
    configId: "reasoning",
    value: "low",
  });
  check("session/set_config_option 不报错", !setOption.error, JSON.stringify(setOption).slice(0, 120));
  const badOption = await client.request("session/set_config_option", {
    sessionId: reasonSession.sessionId,
    configId: "reasoning",
    value: "ultra",
  });
  check("session/set_config_option 非法值不报错", !badOption.error, JSON.stringify(badOption).slice(0, 120));
  const reasonReloaded = await client.request("session/load", {
    sessionId: reasonSession.sessionId,
    cwd,
    mcpServers: [],
  });
  const reloadedOption = (reasonReloaded.configOptions ?? []).find((o) => o.id === "reasoning");
  check(
    "session/load 回显选中思考级别",
    reloadedOption?.currentValue === "low",
    JSON.stringify(reloadedOption?.currentValue),
  );
  // 选中思考级别下跑一轮，验证 optionSpecs 副本不破坏 zcode 启动
  const reasonMark = client.updates.length;
  const r5 = await client.request("session/prompt", {
    sessionId: reasonSession.sessionId,
    prompt: [{ type: "text", text: "Reply with only: PONG" }],
  });
  const reasonText = client.updates
    .slice(reasonMark)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  check("选中思考级别下 stopReason=end_turn", r5.stopReason === "end_turn", JSON.stringify(r5));
  check("选中思考级别下有回复", reasonText.length > 0, JSON.stringify(reasonText));
} catch (err) {
  check("smoke 执行未抛异常", false, String(err));
} finally {
  client.kill();
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
if (failures && client.stderr()) console.log("bridge stderr:\n" + client.stderr());
process.exit(failures === 0 ? 0 : 1);
