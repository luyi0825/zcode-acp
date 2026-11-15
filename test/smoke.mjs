// 自测：起一个本地 ACP 客户端，经 CLI 入口直连 bridge，验证 initialize /
// session/new / session/prompt 流式文本 / 多轮续接 / cancel / 模型选择 / 思考级别 /
// 权限模式 / 通用客户端注册器。
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerAllClients } from "../src/register.js";
import { reasoningLevelForEffort } from "../src/claude.js";
import { listSlashCommands } from "../src/commands.js";

const BRIDGE = path.resolve(import.meta.dirname, "../bin/cli.js");
const cwd = mkdtempSync(path.join(tmpdir(), "zcode-acp-smoke-"));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
  if (!ok) failures++;
}

// 极简 ACP 客户端：NDJSON 帧 + 请求/通知分发。
function startClient(args = []) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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

// 以 MiCO 的 Claude 参数启动一轮，收集 stream-json 事件直到进程退出。
function runClaude(args, message) {
  const child = spawn(process.execPath, [BRIDGE, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const events = [];
  const stderr = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) events.push(JSON.parse(line));
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${JSON.stringify(message)}\n`);
  const timer = setTimeout(() => child.kill(), 90_000);
  return new Promise((resolve) => {
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ events, stderr: stderr.join(""), code });
    });
  });
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
  check("initialize 声明 agentInfo.name", init.agentInfo?.name === "zcode-acp");

  // MiCO qoder 适配器会在启动命令前加 --yolo，必须先能完成 ACP 握手。
  const qoderClient = startClient(["--yolo"]);
  try {
    const qoderInit = await qoderClient.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    check("MiCO qoder --yolo 启动兼容", qoderInit.protocolVersion === 1, qoderClient.stderr());
  } finally {
    qoderClient.kill();
  }

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

  // 10. 权限模式：modes 声明 → set_mode → 通知 → load 回显 → 选中模式下可跑
  const modeSession = await client.request("session/new", { cwd, mcpServers: [] });
  const modes = modeSession.modes ?? {};
  check(
    "session/new 声明权限模式",
    modes.currentModeId === "yolo" && (modes.availableModes ?? []).some((m) => m.id === "plan"),
    JSON.stringify(modes).slice(0, 200),
  );
  const beforeModeUpdate = client.updates.length;
  const setMode = await client.request("session/set_mode", {
    sessionId: modeSession.sessionId,
    modeId: "plan",
  });
  check("session/set_mode 不报错", !setMode.error, JSON.stringify(setMode).slice(0, 120));
  check(
    "set_mode 后广播 current_mode_update",
    client.updates
      .slice(beforeModeUpdate)
      .some((u) => u.sessionUpdate === "current_mode_update" && u.currentModeId === "plan"),
  );
  const badMode = await client.request("session/set_mode", {
    sessionId: modeSession.sessionId,
    modeId: "turbo",
  });
  check("session/set_mode 非法值不报错", !badMode.error, JSON.stringify(badMode).slice(0, 120));
  const modeReloaded = await client.request("session/load", {
    sessionId: modeSession.sessionId,
    cwd,
    mcpServers: [],
  });
  check(
    "session/load 回显选中模式",
    modeReloaded.modes?.currentModeId === "plan",
    JSON.stringify(modeReloaded.modes?.currentModeId),
  );
  // 选中模式（plan 只读）下跑一轮：纯文本回复不受工具限制
  const modeMark = client.updates.length;
  const r6 = await client.request("session/prompt", {
    sessionId: modeSession.sessionId,
    prompt: [{ type: "text", text: "Reply with only: PONG" }],
  });
  const modeText = client.updates
    .slice(modeMark)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");
  check("选中模式下 stopReason=end_turn", r6.stopReason === "end_turn", JSON.stringify(r6));
  check("选中模式下有回复", modeText.length > 0, JSON.stringify(modeText));

  // 11. 思考级别：configOptions 声明 → set_config_option → 通知 → load 回显 → prompt 可跑
  const reasonSession = await client.request("session/new", { cwd, mcpServers: [] });
  const reasonOption = (reasonSession.configOptions ?? []).find((o) => o.id === "reasoning");
  check(
    "session/new 声明思考级别选项",
    reasonOption?.currentValue === "max" &&
      reasonOption.category === "thought_level" &&
      reasonOption.options.some((o) => o.value === "low"),
    JSON.stringify(reasonSession.configOptions).slice(0, 200),
  );
  const beforeOptionUpdate = client.updates.length;
  const setOption = await client.request("session/set_config_option", {
    sessionId: reasonSession.sessionId,
    configId: "reasoning",
    value: "low",
  });
  check("session/set_config_option 不报错", !setOption.error, JSON.stringify(setOption).slice(0, 120));
  check(
    "set_config_option 后广播 config_option_update",
    client.updates
      .slice(beforeOptionUpdate)
      .some(
        (u) =>
          u.sessionUpdate === "config_option_update" &&
          (u.configOptions ?? []).some((o) => o.id === "reasoning" && o.currentValue === "low"),
      ),
  );
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

  // 12. 通用注册器：临时目录模拟 OpenIdea 与 Zed（含 JSONC 注释与既有配置）
  const fakeAppData = mkdtempSync(path.join(tmpdir(), "zcode-acp-register-"));
  mkdirSync(path.join(fakeAppData, "ai.l0ng.openidea"), { recursive: true });
  mkdirSync(path.join(fakeAppData, "Zed"), { recursive: true });
  writeFileSync(
    path.join(fakeAppData, "Zed", "settings.json"),
    `// Zed settings\n// 注释必须保留\n{\n  "theme": "dark",\n  "agent_servers": {\n    "kimi": { "type": "registry" }\n  },\n  "ui_font_size": 16\n}\n`,
    "utf8",
  );
  const results = registerAllClients(fakeAppData);
  check(
    "注册器处理两个已装客户端",
    results.length === 2 && results.every((line) => line.startsWith("[ok]")),
    JSON.stringify(results),
  );
  const toml = readFileSync(path.join(fakeAppData, "ai.l0ng.openidea", "agents", "zcode.toml"), "utf8");
  check(
    "OpenIdea toml 写入（PATH 裸名，无用户路径）",
    toml.includes('name = "ZCode"') && toml.includes("command = 'zcode-acp'") && !toml.includes(":\\"),
    toml,
  );
  const zed = readFileSync(path.join(fakeAppData, "Zed", "settings.json"), "utf8");
  check(
    "Zed settings 合并且保留注释与既有条目",
    zed.includes("// 注释必须保留") &&
      zed.includes('"kimi": { "type": "registry" }') &&
      zed.includes('"zcode"') &&
      zed.includes('"ui_font_size": 16'),
    zed,
  );
  const reparsed = JSON.parse(zed.replace(/^[ \t]*\/\/.*$/gm, ""));
  check(
    "Zed 条目为官方 Custom Agent 格式（PATH 裸名 + acp 子命令）",
    reparsed.agent_servers.zcode.type === "custom" &&
      reparsed.agent_servers.zcode.command === "zcode-acp" &&
      reparsed.agent_servers.zcode.args[0] === "acp" &&
      !JSON.stringify(reparsed.agent_servers.zcode).includes(":\\\\"),
    JSON.stringify(reparsed.agent_servers),
  );
  // 幂等：重复注册不产生重复条目
  registerAllClients(fakeAppData);
  const zedAgain = readFileSync(path.join(fakeAppData, "Zed", "settings.json"), "utf8");
  check("Zed 重复注册幂等", (zedAgain.match(/"zcode"/g) ?? []).length === 1, zedAgain);
// 13. 工具卡片 / diff / 计划面板：zcode 的工具事件是 tool.updated 的
  //     scheduled → started → result 三段（流里没有顶层 tool_call），
  //     这三段必须翻译成 ACP 的 tool_call + tool_call_update，否则客户端什么都看不到。
  const { eventToUpdates } = await import("../src/map-event.js");
  const toolCwd = "C:/work/proj";
  const scheduled = eventToUpdates(
    { type: "tool.updated", payload: { kind: "scheduled", toolCallId: "c1", toolName: "Read", input: { file_path: "a.txt" } } },
    toolCwd,
  );
  check(
    "scheduled 创建工具卡片（pending + 绝对路径）",
    scheduled.length === 1 &&
      scheduled[0].sessionUpdate === "tool_call" &&
      scheduled[0].status === "pending" &&
      scheduled[0].kind === "read" &&
      scheduled[0].locations?.[0]?.path === path.resolve(toolCwd, "a.txt"),
    JSON.stringify(scheduled),
  );
  const started = eventToUpdates(
    { type: "tool.updated", payload: { kind: "started", toolCallId: "c1", toolName: "Read" } },
    toolCwd,
  );
  check(
    "started 推进为 in_progress",
    started.length === 1 && started[0].sessionUpdate === "tool_call_update" && started[0].status === "in_progress",
    JSON.stringify(started),
  );
  const diffResult = eventToUpdates(
    {
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "c2",
        result: {
          success: true,
          content: "updated",
          display: {
            kind: "file_diff",
            filePath: "C:/work/proj/e.txt",
            structuredPatch: [{ lines: [" line1", "-line2", "+lineY", " line3"] }],
          },
        },
      },
    },
    toolCwd,
  );
  const diffBlock = diffResult[0]?.content?.find((c) => c.type === "diff");
  check(
    "result 携带 ACP diff 内容块（改前/改后行集）",
    diffResult[0]?.status === "completed" &&
      diffBlock?.path === "C:/work/proj/e.txt" &&
      diffBlock?.oldText === "line1\nline2\nline3" &&
      diffBlock?.newText === "line1\nlineY\nline3",
    JSON.stringify(diffResult),
  );
  const writeCard = eventToUpdates(
    {
      type: "tool.updated",
      payload: { kind: "scheduled", toolCallId: "c4", toolName: "Write", input: { file_path: "n.txt", content: "hello" } },
    },
    toolCwd,
  );
  const writeDiff = writeCard[0]?.content?.find((c) => c.type === "diff");
  check(
    "Write 新建文件合成新增 diff（oldText 为 null）",
    writeDiff?.oldText === null && writeDiff?.newText === "hello",
    JSON.stringify(writeCard),
  );
  const planUpdates = eventToUpdates(
    {
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "c3",
        toolName: "TodoWrite",
        input: { todos: [{ content: "A", status: "completed", priority: "high" }, { content: "B", status: "pending", priority: "low" }] },
      },
    },
    toolCwd,
  );
  const plan = planUpdates.find((u) => u.sessionUpdate === "plan");
  check(
    "TodoWrite 转计划面板（整份替换语义）",
    plan?.entries?.length === 2 &&
      plan.entries[0].status === "completed" &&
      plan.entries[1].priority === "low",
    JSON.stringify(planUpdates),
  );
  check(
    "batch 汇总事件不产生 update",
    eventToUpdates({ type: "tool.updated", payload: { kind: "batch", toolCallIds: ["c1"], successCount: 1 } }, toolCwd).length === 0,
  );

  // 14. 真实一轮里的工具卡片：让模型读文件，断言客户端收到 tool_call 与 completed。
  const toolSession = await client.request("session/new", { cwd, mcpServers: [] });
  writeFileSync(path.join(cwd, "probe.txt"), "probe-4412\n");
  const toolMark = client.updates.length;
  const rTool = await client.request("session/prompt", {
    sessionId: toolSession.sessionId,
    prompt: [{ type: "text", text: "Read probe.txt and reply with only the code word." }],
  });
  const toolUpdates = client.updates.slice(toolMark);
  check("工具轮 stopReason=end_turn", rTool.stopReason === "end_turn", JSON.stringify(rTool));
  check(
    "客户端收到 tool_call 卡片",
    toolUpdates.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId),
    JSON.stringify(toolUpdates.filter((u) => String(u.sessionUpdate).startsWith("tool")).slice(0, 3)),
  );
  check(
    "客户端收到工具完成状态",
    toolUpdates.some(
      (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
    ),
    JSON.stringify(toolUpdates.filter((u) => String(u.sessionUpdate).startsWith("tool")).slice(0, 3)),
  );
  // 15. MiCO Claude 协议：真实启动参数 → init / assistant / result，并校验档位映射。
  const claudeModelId = models.availableModels?.[1]?.modelId ?? firstModel?.modelId ?? "claude-sonnet-4-6";
  const claudeRun = await runClaude(
    [
      "-p",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--permission-prompt-tool", "stdio",
      "--model", claudeModelId,
      "--effort", "high",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
    ],
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Reply with only: PONG" }] },
      session_id: "",
    },
  );
  const claudeInit = claudeRun.events.find((event) => event.type === "system" && event.subtype === "init");
  const claudeAssistant = claudeRun.events.find((event) => event.type === "assistant");
  const claudeResult = claudeRun.events.find((event) => event.type === "result");
  check(
    "Claude stream-json 返回 init 与 session_id",
    typeof claudeInit?.session_id === "string" && claudeInit.session_id.length > 0,
    JSON.stringify(claudeRun.events).slice(0, 500),
  );
  check(
    "Claude stream-json 返回 PONG 与成功 result",
    claudeRun.code === 0 &&
      claudeAssistant?.message?.content?.[0]?.text === "PONG" &&
      claudeResult?.result === "PONG" &&
      claudeResult.is_error === false,
    JSON.stringify({ code: claudeRun.code, stderr: claudeRun.stderr, result: claudeResult }).slice(0, 800),
  );
  check(
    "Claude low/medium/high 映射 ZCode low/high/max",
    reasoningLevelForEffort("low") === "low" &&
      reasoningLevelForEffort("medium") === "high" &&
      reasoningLevelForEffort("high") === "max",
  );
  // 16. MiCO 模型发现走 control_request/initialize，不启动真实模型调用。
  const discoveryRun = await runClaude(
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--no-session-persistence"],
    { type: "control_request", request_id: "mico-model-discovery", request: { subtype: "initialize" } },
  );
  const discoveryResponse = discoveryRun.events.find((event) => event.type === "control_response");
  const discoveryModels = discoveryResponse?.response?.response?.models;
  check(
    "Claude 模型发现返回三档思考能力",
    discoveryRun.code === 0 &&
      discoveryResponse?.response?.request_id === "mico-model-discovery" &&
      discoveryModels?.[0]?.supportedEffortLevels?.join(",") === "low,medium,high",
    JSON.stringify(discoveryRun.events),
  );
  check(
    "Claude 模型发现保留完整 ZCode 模型列表",
    discoveryModels?.length > 1 &&
      discoveryModels.every((model) => model.value.includes("::")) &&
      discoveryModels.some((model) => model.value === claudeModelId),
    JSON.stringify(discoveryModels?.map((model) => model.value)),
  );

  // 16b. MiCO 能力清单：命令 + 技能（/skill 前缀形式）+ 子 agent 都要下发，
  //      否则 MiCO 侧看不到本地能力；技能必须带前缀，裸名在 zcode 里是 Unknown command。
  const discoveryCommands = discoveryResponse?.response?.response?.commands ?? [];
  const discoveryAgents = discoveryResponse?.response?.response?.agents ?? [];
  check(
    "Claude 模型发现下发本地命令清单",
    discoveryCommands.length > 0 &&
      discoveryCommands.every((c) => typeof c.name === "string" && c.name && typeof c.description === "string"),
    JSON.stringify(discoveryCommands.slice(0, 3)),
  );
  check(
    "技能以斜杠形式暴露（供 MiCO 点选）",
    discoveryCommands.some((c) => c.name.startsWith("/")),
    JSON.stringify(discoveryCommands.filter((c) => c.name.startsWith("/")).slice(0, 2)),
  );
  check(
    "Claude 模型发现下发子 agent 清单",
    discoveryAgents.length > 0 &&
      discoveryAgents.every((a) => typeof a.name === "string" && a.name),
    JSON.stringify(discoveryAgents.slice(0, 3)),
  );

  // 17. 标题与命令菜单：标题来自 session.titleUpdated，菜单来自 CLI 的命令发现。
  const titleUpdates = eventToUpdates(
    { type: "session.titleUpdated", payload: { previousTitle: "", source: "first_input", title: "修复登录问题" } },
    cwd,
  );
  check(
    "titleUpdated 转 session_info_update",
    titleUpdates.length === 1 &&
      titleUpdates[0].sessionUpdate === "session_info_update" &&
      titleUpdates[0].title === "修复登录问题",
    JSON.stringify(titleUpdates),
  );
  check(
    "空标题不推 session_info_update",
    eventToUpdates({ type: "session.titleUpdated", payload: { title: "  " } }, cwd).length === 0,
  );
  const slashCommands = await listSlashCommands();
  check(
    "斜杠命令清单可用（name/description 齐全）",
    Array.isArray(slashCommands) &&
      slashCommands.length > 0 &&
      slashCommands.every((c) => typeof c.name === "string" && c.name && typeof c.description === "string"),
    JSON.stringify(slashCommands.slice(0, 3)),
  );
  check(
    "斜杠命令无重名",
    new Set(slashCommands.map((c) => c.name)).size === slashCommands.length,
  );

  // 17b. 技能必须进客户端菜单（否则 OpenIdea / Zed / MiCO 里根本看不到、点不到），
  //      且技能名改写要遵守「同名命令优先」——cross-cr 既是命令又是技能，
  //      改成 /skill 会绕过命令自带上下文。
  const capabilityNames = await (async () => {
    const { discoverCapabilities: discover } = await import("../src/commands.js");
    return discover();
  })();
  check(
    "技能进入客户端命令菜单",
    slashCommands.some((c) => capabilityNames.skills.some((s) => s.name === c.name)),
    JSON.stringify({ menuSize: slashCommands.length, skills: capabilityNames.skills.length }),
  );
  const { rewriteSkillCommand } = await import("../src/slash-text.js");
  const knownNames = {
    skills: new Set(capabilityNames.skills.map((s) => s.name)),
    commands: new Set(capabilityNames.commands.map((c) => c.name)),
  };
  const skillOnly = capabilityNames.skills.find((s) => !knownNames.commands.has(s.name));
  const bothCommandAndSkill = capabilityNames.skills.find((s) => knownNames.commands.has(s.name));
  check(
    "纯技能名改写为 /skill 前缀",
    Boolean(skillOnly) &&
      rewriteSkillCommand(`/${skillOnly.name}`, knownNames) === `/skill ${skillOnly.name}`,
    JSON.stringify({ skillOnly: skillOnly?.name }),
  );
  check(
    "同名命令优先不改写（避免绕过命令定义）",
    !bothCommandAndSkill ||
      rewriteSkillCommand(`/${bothCommandAndSkill.name}`, knownNames) === `/${bothCommandAndSkill.name}`,
    JSON.stringify({ bothCommandAndSkill: bothCommandAndSkill?.name }),
  );
  check(
    "正文中提到的技能名不被篡改",
    rewriteSkillCommand(`请解释 /${skillOnly?.name ?? "x"} 的用途`, knownNames) ===
      `请解释 /${skillOnly?.name ?? "x"} 的用途`,
  );

  // 18. initialize 的 authMethods 必须非空（ACP Registry 上架校验项）
  check(
    "initialize 声明非空 authMethods",
    Array.isArray(init.authMethods) &&
      init.authMethods.length > 0 &&
      init.authMethods.every((m) => typeof m.id === "string" && typeof m.name === "string"),
    JSON.stringify(init.authMethods),
  );

  // 19. 会话收到 available_commands_update（session/new 之后异步推送）
  await new Promise((resolve) => setTimeout(resolve, 3000));
  check(
    "会话收到 available_commands_update",
    client.updates.some(
      (u) => u.sessionUpdate === "available_commands_update" && Array.isArray(u.availableCommands),
    ),
    String(client.updates.filter((u) => u.sessionUpdate === "available_commands_update").length),
  );
} catch (err) {
  check("smoke 执行未抛异常", false, String(err));
} finally {
  client.kill();
}

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
if (failures && client.stderr()) console.log("bridge stderr:\n" + client.stderr());
process.exit(failures === 0 ? 0 : 1);
