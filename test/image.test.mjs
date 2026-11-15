import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BRIDGE = path.resolve(import.meta.dirname, "../bin/cli.js");
const DEPLOYED_BRIDGE = process.env.ZCODE_ACP_BRIDGE;
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function startClient(env, cwd) {
  const command = DEPLOYED_BRIDGE ?? process.execPath;
  const args = DEPLOYED_BRIDGE ? [] : [BRIDGE];
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  const updates = [];
  let nextId = 1;
  let buffer = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method === "session/update") {
        updates.push(message.params.update);
        continue;
      }
      if (message.id === undefined || !pending.has(message.id)) continue;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    child,
    updates,
    stderr: () => stderr,
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时：${stderr}`));
        }, 10_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

async function removeDir(dir) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("acpPromptPassesImageToZcodeReadAndCleansUp", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-acp-image-test-"));
  const installRoot = path.join(dir, "ZCode");
  const cli = path.join(installRoot, "resources", "glm", "zcode.cjs");
  const capture = path.join(dir, "capture.json");
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(
    cli,
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "commands" || args[0] === "skills") {
  console.log("{}");
  process.exit(0);
}
const promptArg = args.find((arg) => arg.startsWith("--prompt=")) ?? "";
const prompt = promptArg.slice("--prompt=".length);
const imagePath = prompt.trimEnd().split(/\\r?\\n/).at(-1);
const data = fs.readFileSync(imagePath).toString("base64");
fs.writeFileSync(process.env.ZCODE_IMAGE_TEST_CAPTURE, JSON.stringify({ args, imagePath, data }));
console.log(JSON.stringify({ sessionId: "image-test", type: "session.updated", payload: { content: "ok" } }));
`,
  );

  const client = startClient(
    {
      ...process.env,
      ZCODE_HOME: installRoot,
      ZCODE_ACP_ENV_FILE: path.join(dir, "missing.env"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(dir, "missing-provider.json"),
      ZCODE_IMAGE_TEST_CAPTURE: capture,
    },
    dir,
  );
  t.after(async () => {
    if (client.child.exitCode === null && client.child.signalCode === null) {
      const closed = new Promise((resolve) => client.child.once("close", resolve));
      client.child.kill();
      await closed;
    }
    await removeDir(dir);
  });

  const initialized = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  assert.equal(initialized.agentCapabilities.promptCapabilities.image, true);

  const { sessionId } = await client.request("session/new", { cwd: dir, mcpServers: [] });
  const prompted = await client.request("session/prompt", {
    sessionId,
    prompt: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }],
  });
  assert.equal(prompted.stopReason, "end_turn", client.stderr());

  const captured = JSON.parse(readFileSync(capture, "utf8"));
  const promptArg = captured.args.find((arg) => arg.startsWith("--prompt="));
  assert.ok(promptArg.includes("请分析所附图片。"));
  assert.ok(promptArg.includes("请使用 Read 工具读取以下图片后再回答"));
  assert.equal(path.basename(captured.imagePath), "image-0.png");
  assert.equal(captured.data, PNG_1X1);
  assert.equal(existsSync(path.dirname(captured.imagePath)), false, "临时图片目录应在 prompt 后删除");
});

test("acpModelSelectionRefreshesReasoningOptions", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-acp-reasoning-test-"));
  const installRoot = path.join(dir, "ZCode");
  const cli = path.join(installRoot, "resources", "glm", "zcode.cjs");
  const personal = path.join(dir, "personal.json");
  const builtin = path.join(dir, "builtin.json");
  mkdirSync(path.dirname(cli), { recursive: true });
  writeFileSync(
    cli,
    `if (process.argv[2] === "commands" || process.argv[2] === "skills") {
  console.log("{}");
  process.exit(0);
}
process.exit(0);
`,
  );
  writeFileSync(
    personal,
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [{ providerId: "p1", config: { modelOrder: ["alpha", "beta"] } }],
        },
        modelConfigRules: { providerModelRules: [] },
      },
    }),
  );
  writeFileSync(
    builtin,
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: "alpha", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } },
            { modelMatch: "beta", config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "xhigh"] } } } },
          ],
        },
      },
    }),
  );

  const client = startClient(
    {
      ...process.env,
      ZCODE_HOME: installRoot,
      ZCODE_ACP_ENV_FILE: path.join(dir, "missing.env"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    },
    dir,
  );
  t.after(async () => {
    if (client.child.exitCode === null && client.child.signalCode === null) {
      const closed = new Promise((resolve) => client.child.once("close", resolve));
      client.child.kill();
      await closed;
    }
    await removeDir(dir);
  });

  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const created = await client.request("session/new", { cwd: dir, mcpServers: [] });
  const sessionId = created.sessionId;
  const initialOption = created.configOptions.find((option) => option.id === "thought_level");
  assert.equal(initialOption.currentValue, "max");
  assert.deepEqual(initialOption.options.map((option) => option.value), ["low", "high", "max"]);
  assert.ok(created.models.availableModels.every((model) => !Object.hasOwn(model, "reasoningLevels")));
  assert.deepEqual(
    created.modes.availableModes.map((mode) => mode.id),
    ["plan", "build", "guarded", "yolo"],
  );
  assert.deepEqual(
    created.modes.availableModes.map((mode) => mode.name),
    ["计划模式", "变更前确认", "自主模式", "完全访问"],
  );

  await client.request("session/set_config_option", {
    sessionId,
    configId: "thought_level",
    value: "high",
  });
  await client.request("session/set_model", { sessionId, modelId: "p1::beta" });
  const switchedUpdate = client.updates
    .filter((update) => update.sessionUpdate === "config_option_update")
    .at(-1);
  const switchedOption = switchedUpdate.configOptions.find((option) => option.id === "thought_level");
  assert.equal(switchedOption.currentValue, "xhigh");
  assert.deepEqual(switchedOption.options.map((option) => option.value), ["low", "medium", "xhigh"]);

  await client.request("session/set_config_option", {
    sessionId,
    configId: "thought_level",
    value: "medium",
  });
  const reloaded = await client.request("session/load", { sessionId, cwd: dir, mcpServers: [] });
  const reloadedOption = reloaded.configOptions.find((option) => option.id === "thought_level");
  assert.equal(reloadedOption.currentValue, "medium");
  assert.deepEqual(reloadedOption.options.map((option) => option.value), ["low", "medium", "xhigh"]);

  await client.request("session/set_model", { sessionId, modelId: "p1::alpha" });
  const restored = await client.request("session/load", { sessionId, cwd: dir, mcpServers: [] });
  const restoredOption = restored.configOptions.find((option) => option.id === "thought_level");
  assert.equal(restoredOption.currentValue, "max");
  assert.deepEqual(restoredOption.options.map((option) => option.value), ["low", "high", "max"]);
});
