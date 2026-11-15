import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findModel, listModels, writeSelectionConfig } from "../src/models.js";
import { createSemanticStream, effortLevelsForModel, reasoningLevelForEffort } from "../src/claude.js";
import { readRuntimeEnvFile } from "../src/runtime-env.js";
import { applyZcodeRuntimeEnv } from "../src/zcode.js";

function makeTempDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "zcode-acp-regression-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function isolateEnv(t, keys) {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function writeFixture(filePath, content = "") {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

test("writeSelectionConfigPreservesOptionSpecs", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]);
  const configPath = path.join(dir, "provider.json");
  writeFixture(
    configPath,
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [
            { providerId: "p1", config: { modelOrder: ["m1"] } },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "p1",
              modelId: "m1",
              config: {
                optionSpecs: {
                  maxOutputTokens: { max: 64000 },
                  reasoningLevel: {
                    values: ["disabled", "low", "medium", "xhigh"],
                    map: { preset: "keep-me" },
                  },
                },
              },
            },
          ],
        },
      },
    }),
  );
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = configPath;

  const copy = writeSelectionConfig({ providerId: "p1", modelId: "m1", reasoningLevel: "medium" });
  assert.ok(copy);
  t.after(() => rmSync(copy, { force: true }));
  const written = JSON.parse(readFileSync(copy, "utf8"));
  const modelRule = written.config.modelConfigRules.providerModelRules[0];
  assert.deepEqual(modelRule.config.optionSpecs.maxOutputTokens, { max: 64000 });
  assert.deepEqual(modelRule.config.optionSpecs.reasoningLevel.map, { preset: "keep-me" });
  assert.deepEqual(
    modelRule.config.optionSpecs.reasoningLevel.values,
    ["disabled", "low", "xhigh", "medium"],
  );
});

test("listModelsResolvesReasoningLevelsPerModel", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]);
  const personalPath = path.join(dir, "personal.json");
  const builtinPath = path.join(dir, "builtin.json");
  writeFixture(
    personalPath,
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [{
            providerId: "p1",
            templateId: "template-p1",
            config: {
              modelOrder: ["glm-5.3", "qwen3.8-max", "custom"],
              api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1/" },
            },
          }],
        },
        modelConfigRules: {
          providerModelRules: [{
            providerId: "p1",
            modelId: "custom",
            config: { optionSpecs: { reasoningLevel: { values: ["enabled"] } } },
          }],
        },
      },
    }),
  );
  writeFixture(
    builtinPath,
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: ".*", config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } } },
            { modelMatch: ".*glm-5\\.3.*", config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } } },
            { modelMatch: ".*qwen3\\.8.*", config: { optionSpecs: { reasoningLevel: { values: ["low", "medium", "xhigh"] } } } },
          ],
          modelApiRules: [{
            modelMatch: ".*glm-5\\.3.*",
            apiTypeMatch: "openai-chat-completions",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "max"] } } },
          }],
          providerSiteRules: [{
            modelMatch: ".*qwen3\\.8.*",
            apiTypeMatch: "openai-chat-completions",
            baseUrlMatch: ".*api\\.example\\.com/v1",
            config: { optionSpecs: { reasoningLevel: { values: ["medium", "high"] } } },
          }],
          templateModelRules: [{
            templateId: "template-p1",
            modelId: "custom",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high"] } } },
          }],
        },
      },
    }),
  );
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath;
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;

  const models = listModels();
  assert.equal(models.currentModelId, "p1::glm-5.3");
  assert.deepEqual(
    models.availableModels.map((model) => model.reasoningLevels),
    [["low", "max"], ["medium", "high"], ["enabled"]],
  );
  assert.deepEqual(findModel("p1::qwen3.8-max").reasoningLevels, ["medium", "high"]);
});

test("listModelsFiltersDisabledModelsUsingEffectiveRules", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]);
  const personalPath = path.join(dir, "personal.json");
  const builtinPath = path.join(dir, "builtin.json");
  writeFixture(
    personalPath,
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [{
            providerId: "p1",
            templateId: "template-p1",
            config: { modelOrder: ["visible", "builtin-disabled", "disabled", "re-enabled"] },
          }],
        },
        modelConfigRules: {
          providerModelRules: [{ providerId: "p1", modelId: "disabled", config: { enabled: false } }],
          manualProviderModelRules: [{ providerId: "p1", modelId: "re-enabled", config: { enabled: true } }],
        },
      },
    }),
  );
  writeFixture(
    builtinPath,
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [{ modelMatch: ".*", config: { enabled: true } }],
          templateModelRules: [
            { templateId: "template-p1", modelId: "builtin-disabled", config: { enabled: false } },
            { templateId: "template-p1", modelId: "disabled", config: { enabled: true } },
            { templateId: "template-p1", modelId: "re-enabled", config: { enabled: false } },
          ],
        },
      },
    }),
  );
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath;
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;

  const models = listModels();
  assert.equal(models.currentModelId, "p1::visible");
  assert.deepEqual(
    models.availableModels.map((model) => model.modelId),
    ["p1::visible", "p1::re-enabled"],
  );
  assert.equal(findModel("p1::disabled"), null);
  assert.equal(findModel("p1::builtin-disabled"), null);
  assert.ok(findModel("p1::re-enabled"));
});

test("claudeEffortMappingFollowsModelCapabilities", () => {
  assert.deepEqual(effortLevelsForModel(["low", "high", "max"]), ["low", "high", "max"]);
  assert.equal(reasoningLevelForEffort("medium", ["low", "high", "max"]), undefined);
  assert.equal(reasoningLevelForEffort("high", ["low", "high", "max"]), "high");
  assert.equal(reasoningLevelForEffort("max", ["low", "high", "max"]), "max");
  assert.deepEqual(effortLevelsForModel(["low", "medium", "xhigh"]), ["low", "medium", "xhigh"]);
  assert.equal(reasoningLevelForEffort("xhigh", ["low", "medium", "xhigh"]), "xhigh");
  assert.deepEqual(effortLevelsForModel(["disabled", "enabled"]), []);
  assert.equal(reasoningLevelForEffort("high", ["enabled"]), undefined);
});

// 守卫必须在 normalize 之前判断：normalize 会把 `..` 解析掉，之后检查永远为假。
// 用户消息里的语义事件流：宿主的看门狗按「距上次语义事件」判活，
// 整轮只回最终结果会让长任务被误杀（实测 provider_zero_events）。
test("semanticStreamEmitsToolUseAndToolResult", () => {
  const stream = createSemanticStream();
  assert.equal(stream.produced(), false);

  // 文本增量只累积，不单独发消息。
  assert.equal(
    stream.consume({ type: "model.streaming", payload: { kind: "text_delta", delta: "先读文件" } }),
    null,
  );
  assert.equal(stream.produced(), false);

  // 工具 scheduled 收口：累积文本与 tool_use 合成一条 assistant 消息。
  const scheduled = stream.consume({
    type: "tool.updated",
    payload: { kind: "scheduled", toolCallId: "c1", toolName: "Read", input: { file_path: "a.txt" } },
  });
  assert.equal(scheduled.type, "assistant");
  assert.deepEqual(scheduled.message.content, [
    { type: "text", text: "先读文件" },
    { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.txt" } },
  ]);
  assert.equal(stream.produced(), true);

  // 同一工具的 started 段只是状态推进，不产生新消息（避免重复卡片）。
  assert.equal(
    stream.consume({ type: "tool.updated", payload: { kind: "started", toolCallId: "c1" } }),
    null,
  );

  const result = stream.consume({
    type: "tool.updated",
    payload: { kind: "result", toolCallId: "c1", result: { success: true, content: "file body" } },
  });
  assert.equal(result.type, "user");
  assert.deepEqual(result.message.content, [
    { type: "tool_result", tool_use_id: "c1", content: "file body", is_error: false },
  ]);

  // 失败结果必须标 is_error，宿主据此区分成功与失败卡片。
  const failed = stream.consume({
    type: "tool.updated",
    payload: { kind: "result", toolCallId: "c2", result: { success: false, content: "boom" } },
  });
  assert.equal(failed.message.content[0].is_error, true);
});

// 收尾与保活都靠 flush：它只吐未发出的文本，不重复已发内容。
test("semanticStreamFlushEmitsPendingTextOnce", () => {
  const stream = createSemanticStream();
  stream.consume({ type: "model.streaming", payload: { kind: "text_delta", delta: "最终结论" } });
  const flushed = stream.flush();
  assert.deepEqual(flushed.message.content, [{ type: "text", text: "最终结论" }]);
  assert.equal(stream.produced(), true);
  // 再 flush 不能重复发出同一段文本。
  assert.equal(stream.flush(), null);
  // 空白增量不算内容，不产生空消息。
  stream.consume({ type: "model.streaming", payload: { kind: "text_delta", delta: "   " } });
  assert.equal(stream.flush(), null);
});

// 工具结果裁剪上限：Bash 输出可能几十 KB，整段推给宿主会撑爆消息体。
test("semanticStreamClipsOversizedToolResult", () => {
  const stream = createSemanticStream();
  const huge = "x".repeat(30000);
  const message = stream.consume({
    type: "tool.updated",
    payload: { kind: "result", toolCallId: "c1", result: { success: true, content: huge } },
  });
  const content = message.message.content[0].content;
  assert.equal(content.length, 20001);
  assert.ok(content.endsWith("…"));
});

// 缺 toolCallId 的事件无法与工具卡片配对，必须整条丢弃而不是发半截消息。
test("semanticStreamIgnoresEventsWithoutToolCallId", () => {
  const stream = createSemanticStream();
  assert.equal(stream.consume({ type: "tool.updated", payload: { kind: "scheduled" } }), null);
  assert.equal(stream.consume({ type: "session.updated", payload: {} }), null);
  assert.equal(stream.produced(), false);
});

test("configurationPathsRejectParentTraversal", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]);
  const secret = path.join(dir, "nested", "provider.json");
  writeFixture(
    secret,
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: { providerRules: [{ providerId: "p1", config: { modelOrder: ["m1"] } }] },
      },
    }),
  );
  // 不能经 path.join 构造：它自身会先规范化，`..` 不会留在字符串里。
  const traversing = `${path.join(dir, "nested")}${path.sep}..${path.sep}nested${path.sep}provider.json`;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = traversing;
  assert.equal(listModels(), null);
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = traversing;
  assert.deepEqual(readRuntimeEnvFile(traversing), {});

  // 同一文件的直白路径仍可读，确认拒绝的是穿越形态而不是文件本身。
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = secret;
  assert.equal(listModels()?.availableModels.length, 1);
});

test("resolveZcodePrefersMacContentsAndFallsBack", async (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_HOME", "ZCODE_WINDOWS_APP_INSTALL_DIR"]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const { resolveZcode } = await import("../src/zcode.js?test=darwin");

  const bundle = path.join(dir, "ZCode.app");
  const contentsCli = path.join(bundle, "Contents", "Resources", "glm", "zcode.cjs");
  writeFixture(contentsCli);
  writeFixture(path.join(bundle, "resources", "glm", "zcode.cjs"));
  process.env.ZCODE_HOME = bundle;
  assert.equal(resolveZcode().cli, contentsCli);

  const bareBundle = path.join(dir, "BareZCode.app");
  const bareCli = path.join(bareBundle, "resources", "glm", "zcode.cjs");
  writeFixture(bareCli);
  process.env.ZCODE_HOME = bareBundle;
  assert.equal(resolveZcode().cli, bareCli);
});

test("applyZcodeRuntimeEnvInjectsBuiltinProviderFallback", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_ENV_FILE", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]);
  process.env.ZCODE_ACP_ENV_FILE = path.join(dir, "missing.env");
  const installRoot = path.join(dir, "ZCode.app", "Contents");
  const cli = path.join(installRoot, "Resources", "glm", "zcode.cjs");
  const config = path.join(installRoot, "config", "provider", "zcode-builtin.json");
  writeFixture(config, "{}");

  const env = {};
  applyZcodeRuntimeEnv(env, cli);
  assert.equal(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, config);

  const explicit = path.join(dir, "explicit.json");
  const explicitEnv = { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: explicit };
  applyZcodeRuntimeEnv(explicitEnv, cli);
  assert.equal(explicitEnv.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, explicit);
});

test("applyZcodeRuntimeEnvDoesNotInjectDataBaseDirByDefault", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_ENV_FILE", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"]);
  mkdirSync(path.join(dir, ".zcode"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ZCODE_ACP_ENV_FILE = path.join(dir, "missing.env");

  const env = {};
  applyZcodeRuntimeEnv(env);
  assert.equal(env.ZCODE_DATA_BASE_DIR, undefined);

  const redirected = path.join(dir, "desktop-home");
  writeFixture(process.env.ZCODE_ACP_ENV_FILE, `ZCODE_DATA_BASE_DIR=${redirected}\n`);
  const desktopEnv = {};
  applyZcodeRuntimeEnv(desktopEnv);
  assert.equal(desktopEnv.ZCODE_DATA_BASE_DIR, redirected);
});
