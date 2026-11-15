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
    rmSync(dir, { recursive: true, force: true });
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
