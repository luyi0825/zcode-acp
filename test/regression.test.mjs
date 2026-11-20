import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findModel, listModels, writeSelectionConfig } from "../src/models.js";
import {
  assistantUsageOf,
  createSemanticStream,
  createUsageLedger,
  effortLevelsForModel,
  modelUsageOf,
  reasoningLevelForEffort,
  usageOf,
} from "../src/claude.js";
import { readRuntimeEnvFile, personalProviderConfigPath, builtinProviderConfigAt } from "../src/runtime-env.js";
import { applyZcodeRuntimeEnv, parseCommandOutput, summarizeStderr } from "../src/zcode.js";
import { splitTaskEnvelope } from "../src/prompt-envelope.js";
import { persistSession, restoreSession, sessionStorePath } from "../src/session-store.js";
import { rewriteSkillCommand } from "../src/slash-text.js";
import { resolveZcode } from "../src/cli-locate.js";
import { logEvent } from "../src/logger.js";

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

test("usageOfTranslatesZcodeUsageToClaudeFields", () => {
  // zcode 的 usage 是 JSON 字符串，字段驼峰；宿主按 Claude 的 snake_case 累加。
  // zcode 的 inputTokens 含缓存，Claude 的 input_tokens 不含，故需扣减。
  const usage = usageOf({
    type: "session.updated",
    payload: {
      usage: JSON.stringify({ inputTokens: 27743, outputTokens: 201, cacheReadTokens: 19200 }),
      contextWindow: 200000,
    },
  });
  assert.deepEqual(usage, {
    input_tokens: 8543,
    output_tokens: 201,
    cache_read_input_tokens: 19200,
  });
  // 已解析成对象时同样接受。
  assert.deepEqual(
    usageOf({ type: "session.updated", payload: { usage: { inputTokens: 5, outputTokens: 1 }, contextWindow: 1 } }),
    { input_tokens: 5, output_tokens: 1 },
  );
  // 缓存大于输入（异常数据）时 input 归零而不是负数。
  assert.deepEqual(
    usageOf({
      type: "session.updated",
      payload: { usage: { inputTokens: 10, cacheReadTokens: 99 }, contextWindow: 1 },
    }),
    { input_tokens: 0, cache_read_input_tokens: 99 },
  );
  // 无 usage / 非法 JSON / 非 session.updated 一律返回 null，不能中断执行。
  assert.equal(usageOf({ type: "session.updated", payload: { contextWindow: 1 } }), null);
  assert.equal(usageOf({ type: "session.updated", payload: { usage: "{bad", contextWindow: 1 } }), null);
  assert.equal(usageOf({ type: "model.streaming", payload: { usage: "{}", contextWindow: 1 } }), null);
  assert.equal(
    usageOf({ type: "session.updated", payload: { usage: { inputTokens: -1 }, contextWindow: 1 } }),
    null,
  );
  // 每次请求结束有两条载荷相同的 session.updated（一条仅 usage、一条轮末汇总），
  // 只有带 contextWindow 的轮末那条计入，否则每次请求的用量会记两遍。
  const body = { inputTokens: 27743, outputTokens: 201, cacheReadTokens: 19200 };
  const counted = [
    { type: "session.updated", payload: { usage: JSON.stringify(body) } },
    { type: "session.updated", payload: { usage: JSON.stringify(body), contextWindow: 200000 } },
  ]
    .map(usageOf)
    .filter(Boolean);
  assert.deepEqual(counted, [
    { input_tokens: 8543, output_tokens: 201, cache_read_input_tokens: 19200 },
  ]);
});

// 一个 turn 内多次模型请求各自计费：inputTokens 是每次请求的完整输入，必须累加。
// 这是 result.usage 的上报口径，漏加会让用量严重偏低。
test("usageOfAccumulatesPerRequest", () => {
  const total = [
    { inputTokens: 27743, outputTokens: 201, cacheReadTokens: 19200 },
    { inputTokens: 28612, outputTokens: 366, cacheReadTokens: 27648 },
  ].reduce((sum, body) => {
    const usage = usageOf({
      type: "session.updated",
      payload: { usage: JSON.stringify(body), contextWindow: 200000 },
    });
    const merged = { ...sum };
    for (const [key, value] of Object.entries(usage)) merged[key] = (merged[key] ?? 0) + value;
    return merged;
  }, {});
  assert.deepEqual(total, {
    input_tokens: 9507,
    output_tokens: 567,
    cache_read_input_tokens: 46848,
  });
});

// 宿主（MiCO Claude 适配器）对每条 assistant 消息按 message.id 建账后跨消息求和：
// 每份用量必须恰好挂到一条 assistant 消息上。把整轮累计挂到每条消息（旧实现）
// 会让多工具轮的用量成倍虚高。
test("usageLedgerAttachesEachRequestOnce", () => {
  const ledger = createUsageLedger();
  const assistant = { type: "assistant", message: { role: "assistant", content: [] } };
  const toolResult = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  };
  // 请求 1 结束，请求 2 期间无 assistant 消息（工具结果都是 user 消息）：
  // 两份用量都攒在 pending，挂到下一条 assistant 消息时合并成一份。
  ledger.add({ input_tokens: 100, output_tokens: 1 });
  ledger.add({ input_tokens: 23, output_tokens: 2 });
  assert.deepEqual(ledger.take(toolResult), null);
  assert.deepEqual(ledger.take(assistant), { input_tokens: 123, output_tokens: 3 });
  // 挂过即清：同轮后续 assistant 消息不能再挂（宿主按消息求和会翻倍）。
  assert.equal(ledger.pending(), false);
  assert.deepEqual(ledger.take(assistant), null);
  // 请求 3 的量挂下一条；total 始终是整轮累计（result 行口径）。
  ledger.add({ input_tokens: 7 });
  assert.deepEqual(ledger.take(assistant), { input_tokens: 7 });
  assert.deepEqual(ledger.total(), { input_tokens: 130, output_tokens: 3 });
});

// 模拟真实工具轮的完整时序：请求 N 的 usage 在其输出消息之后才到达，因此挂账
// 对象是「下一条」assistant 消息；每份请求的量恰好挂一次，加总等于整轮累计。
test("usageLedgerMatchesToolTurnTimeline", () => {
  const ledger = createUsageLedger();
  const newAssistant = () => ({ type: "assistant", message: { role: "assistant", content: [] } });
  const toolResult = { type: "user", message: { role: "user", content: [] } };
  const attached = [];
  const emit = (semantic) => {
    const usage = ledger.take(semantic);
    if (usage) attached.push(usage);
  };
  // 请求 1：tool_use 消息先出（pending 为空不挂），usage 随轮末事件后到。
  emit(newAssistant());
  ledger.add({ input_tokens: 100, output_tokens: 10 });
  emit(toolResult);
  // 请求 2：tool_use 消息挂走请求 1 的量，自己的量留给下一条。
  emit(newAssistant());
  ledger.add({ input_tokens: 200, output_tokens: 20 });
  emit(toolResult);
  // 请求 3（收尾文本）：保活 flush 把文本提前发出，挂走请求 2 的量；
  // 随后到达的请求 3 usage 没有后续消息可挂，pending 保持非空。
  emit(newAssistant());
  ledger.add({ input_tokens: 50, output_tokens: 5 });
  assert.deepEqual(attached, [
    { input_tokens: 100, output_tokens: 10 },
    { input_tokens: 200, output_tokens: 20 },
  ]);
  // 收尾兜底：空 content 的 assistant 消息把最后一份量挂出，不漏计。
  assert.equal(ledger.pending(), true);
  emit(newAssistant());
  assert.deepEqual(attached.at(-1), { input_tokens: 50, output_tokens: 5 });
  // 三份请求的量各挂一次，加总等于整轮累计（result 行口径）。
  assert.deepEqual(sumUsage(attached), ledger.total());
});

function sumUsage(list) {
  return list.reduce((sum, usage) => {
    const merged = { ...sum };
    for (const [key, value] of Object.entries(usage)) merged[key] = (merged[key] ?? 0) + value;
    return merged;
  }, {});
}

test("emitSemanticAttachesUsageToAssistantMessages", () => {
  // 宿主按消息 id 逐条聚合 token（MiCO 侧为 assistantUsageByID），usage 必须挂在
  // assistant 消息上；只发 result 总量会让逐条累加拿不到任何一条，统计恒为 0。
  const usage = { input_tokens: 42, output_tokens: 6, cache_read_input_tokens: 1024 };
  const assistant = { type: "assistant", message: { role: "assistant", content: [] } };
  assert.deepEqual(assistantUsageOf(assistant, usage), usage);
  // user 消息（工具结果）不挂 usage：一条轮次里只有模型输出计费。
  const toolResult = {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "" }] },
  };
  assert.equal(assistantUsageOf(toolResult, usage), null);
  // 无 usage 时不写该字段，避免给宿主塞空对象。
  assert.equal(assistantUsageOf(assistant, null), null);
});

test("modelUsageOfConvertsToCamelFields", () => {
  // modelUsage 是「模型名 → 用量」的 map，条目字段为驼峰，与 usage 的 snake_case 不同源。
  assert.deepEqual(
    modelUsageOf({
      input_tokens: 42,
      output_tokens: 6,
      cache_read_input_tokens: 1024,
      cache_creation_input_tokens: 0,
    }),
    { inputTokens: 42, outputTokens: 6, cacheReadInputTokens: 1024, cacheCreationInputTokens: 0 },
  );
  // 缺字段补 0，宿主侧按整数累加，不能出现 undefined。
  assert.deepEqual(modelUsageOf({ input_tokens: 5 }), {
    inputTokens: 5,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  });
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

test("builtinProviderConfigRejectsParentTraversal", (t) => {
  // builtin 配置同样来自环境变量，穿越形态必须与 personal 一样被拒绝：
  // 否则能借它读到模型清单之外的任意 JSON。
  const dir = makeTempDir(t);
  isolateEnv(t, [
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_DATA_BASE_DIR",
  ]);
  const dataDir = path.join(dir, "data");
  writeFixture(
    path.join(dataDir, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [{ providerId: "p1", config: { modelOrder: ["m-hidden", "m-live"] } }],
        },
      },
    }),
  );
  process.env.ZCODE_DATA_BASE_DIR = dataDir;

  // 穿越路径指向的 builtin 配置会禁用 m-live；若被采用，模型列表会只剩 m-hidden。
  const builtin = path.join(dir, "nested", "zcode-builtin.json");
  writeFixture(
    builtin,
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [{ modelMatch: "m-live", config: { enabled: false } }],
        },
      },
    }),
  );
  const traversing = `${path.join(dir, "nested")}${path.sep}..${path.sep}nested${path.sep}zcode-builtin.json`;
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = traversing;

  // 穿越被拒后回退到安装根派生（本测试环境没有安装根，等价于没有 builtin 配置），
  // 因此两个模型都应在列表里 —— 证明穿越值没有被采用。
  const models = listModels();
  assert.equal(models.availableModels.length, 2);
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

test("resolveZcodeSkipsRegistryWhenEnvPathHits", (t) => {
  // 注册表查询要起 reg 子进程（几十毫秒），只在标准候选全落空时才该发生。
  // 用注入的假 reg 证明：环境变量命中时它一次都不被调用。
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_HOME", "ZCODE_WINDOWS_APP_INSTALL_DIR"]);
  const installRoot = path.join(dir, "Zcode");
  const cli = path.join(installRoot, "resources", "glm", "zcode.cjs");
  writeFixture(cli);
  process.env.ZCODE_HOME = installRoot;

  const marker = path.join(dir, "reg-was-called");
  const fakeReg = path.join(dir, "reg");
  // 假 reg：被调用就留下标记文件，然后以非零码退出（模拟「注册表里没有 ZCode」）。
  writeFixture(
    fakeReg,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "");\nprocess.exit(1);\n`,
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ""}`;
  t.after(() => {
    process.env.PATH = savedPath;
  });

  assert.equal(resolveZcode().cli, cli);
  assert.equal(existsSync(marker), false, "命中环境变量路径时不应查询注册表");
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

test("builtinProviderConfigAtFindsWindowsResourcesLayout", (t) => {
  // Windows/Linux 布局是 <安装根>/resources/glm/zcode.cjs，配置在
  // <安装根>/resources/config/provider/ 下（曾按 CLI 上两级推导，少一层 resources）。
  const dir = makeTempDir(t);
  const cli = path.join(dir, "Zcode", "resources", "glm", "zcode.cjs");
  const config = path.join(dir, "Zcode", "resources", "config", "provider", "zcode-builtin.json");
  writeFixture(cli);
  writeFixture(config, "{}");
  assert.equal(builtinProviderConfigAt(cli), config);
  assert.equal(builtinProviderConfigAt(), undefined);
});

test("listModelsFallsBackToInstallRootBuiltinConfig", (t) => {
  // 未设 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 时也要按安装根取 builtin 配置，
  // 否则 enabled/disabled 与思考档位会与子进程实际行为不一致。
  const dir = makeTempDir(t);
  isolateEnv(t, [
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_HOME",
    "ZCODE_WINDOWS_APP_INSTALL_DIR",
  ]);
  const dataDir = path.join(dir, "data");
  writeFixture(
    path.join(dataDir, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [
            { providerId: "p1", config: { modelOrder: ["m-disabled", "m-live"] } },
          ],
        },
      },
    }),
  );
  process.env.ZCODE_DATA_BASE_DIR = dataDir;

  const installRoot = path.join(dir, "Zcode");
  writeFixture(path.join(installRoot, "resources", "glm", "zcode.cjs"));
  writeFixture(
    path.join(installRoot, "resources", "config", "provider", "zcode-builtin.json"),
    JSON.stringify({
      config: {
        modelConfigRules: {
          modelRules: [
            { modelMatch: "m-disabled", config: { enabled: false } },
            {
              modelMatch: "m-live",
              config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
            },
          ],
        },
      },
    }),
  );
  process.env.ZCODE_WINDOWS_APP_INSTALL_DIR = installRoot;

  const models = listModels();
  assert.equal(models.availableModels.length, 1);
  assert.equal(models.availableModels[0].name.startsWith("m-live"), true);
  assert.deepEqual(models.availableModels[0].reasoningLevels, ["low", "high", "max"]);
});

test("parseCommandOutputReadsCommandJsonDocument", () => {
  // /goal 在 headless 下不发 NDJSON，整段 stdout 是一个普通 JSON 文档。
  const doc = JSON.stringify({
    sessionId: "sess_123",
    traceId: "trace_1",
    response: "No goal is set. Use /goal <objective> to set one.",
  });
  // 只取回显文本：其中的 sessionId 是命令的临时会话，不可 resume（实测 Session not found）。
  assert.deepEqual(parseCommandOutput(`\n${doc}\n`), {
    response: "No goal is set. Use /goal <objective> to set one.",
  });
});

test("parseCommandOutputRejectsNonCommandShapes", () => {
  // NDJSON 事件流、空输出、缺少 response 的 JSON 都不是命令类形态，返回 null。
  assert.equal(parseCommandOutput('{"type":"result","response":"ok"}\n{"type":"x"}\n'), null);
  assert.equal(parseCommandOutput("   "), null);
  assert.equal(parseCommandOutput('{"sessionId":"sess_1"}'), null);
  assert.equal(parseCommandOutput("not json"), null);
});

test("parseCommandOutputIgnoresTrailingNdjsonLines", () => {
  // /compact 走 NDJSON，结果在末尾 result 行（由 runTurn 的 result 分支处理）；
  // 整段解析必须失败返回 null，不能把半截事件当成命令文档。
  const mixed = [
    '{"type":"session.updated","payload":{}}',
    '{"type":"result","response":"Summary: ok"}',
  ].join("\n");
  assert.equal(parseCommandOutput(mixed), null);
});

test("summarizeStderrKeepsErrorLinesOnly", () => {
  // zcode 崩溃时会把被打断的 bundle 源码整行打进 stderr，必须过滤掉，
  // 否则客户端里看到的是一屏压缩源码而不是错误信息。
  const stderr = [
    "Error: Select a model before sending a message (traceId: abc)",
    `,(e.stderr==="pipe"||e.stderr==="overlapped")&&(this._stderrStream=new vEo.PassThrough)}${"x".repeat(500)}`,
    "SdkError: Version negotiation probe failed: Connection closed",
    "    at classifyNetworkError (zcode.cjs:2300:78579)",
  ].join("\n");
  const summary = summarizeStderr(stderr);
  assert.match(summary, /Select a model before sending/);
  assert.match(summary, /Version negotiation probe failed/);
  assert.ok(!summary.includes("PassThrough"), summary);
});

test("summarizeStderrFallsBackToTailLines", () => {
  // 没有 Error: 行时保留尾部可读内容，仍要丢掉超长源码行。
  const stderr = `${"y".repeat(400)}\nzcode 退出码 1\n最后一行`;
  const summary = summarizeStderr(stderr);
  assert.match(summary, /zcode 退出码 1/);
  assert.match(summary, /最后一行/);
  assert.ok(!summary.includes("yyyy"), summary);
});

// MiCO 派发的固定信封；首条输入原文会被 CLI 当成会话标题，故用真实形态做用例。
const MICO_ENVELOPE = [
  "## Task Initiator",
  "",
  "This task was initiated by **邹翔宇** (zouxiangyu@xiaomi.com), a member of this workspace.",
  "",
  "Artifact directory for this turn: `C:/tmp/mico-task/artifacts/`.",
  "",
  "[user message=27da3833-0b39-4b3f-9d9d-cda2f484fd24 version=1]",
  "你好",
  "",
  "",
  "## Human interaction",
  "",
  "Make progress with the assignment and available evidence.",
].join("\n");

test("splitTaskEnvelopeSeparatesUserTextFromTemplate", () => {
  // 标题取 prompt 正文：模板必须离开正文，否则 ZCode 项目列表显示的是模板首行。
  const { prompt, envelope } = splitTaskEnvelope(MICO_ENVELOPE);
  assert.equal(prompt, "你好");
  assert.ok(envelope && !envelope.includes("你好"), envelope);
});

test("splitTaskEnvelopeKeepsEnvelopeContent", () => {
  // 拆出去不等于丢弃：发起人、产物目录、交互规则都要原样进附件。
  const { envelope } = splitTaskEnvelope(MICO_ENVELOPE);
  assert.match(envelope, /This task was initiated by \*\*邹翔宇\*\*/);
  assert.match(envelope, /Artifact directory for this turn: `C:\/tmp\/mico-task\/artifacts\/`\./);
  assert.match(envelope, /## Human interaction/);
  assert.match(envelope, /Make progress with the assignment and available evidence\./);
});

test("splitTaskEnvelopePassesThroughPlainInput", () => {
  // 非模板输入一律原样下发，不能因为通用文本里出现类似结构就被改写。
  assert.deepEqual(splitTaskEnvelope("只回复 PONG"), { prompt: "只回复 PONG", envelope: null });
  const notEnvelope = "## 我的笔记\n[user message=x version=1]\n正文";
  assert.deepEqual(splitTaskEnvelope(notEnvelope), { prompt: notEnvelope, envelope: null });
});

test("splitTaskEnvelopeKeepsTemplateOnlyMessage", () => {
  // 纯模板消息没有用户原话：拆解会让 prompt 变空，故整体按原样下发。
  const templateOnly = "## Task Initiator\n[user message=x version=1]\n## Human interaction\n规则";
  assert.deepEqual(splitTaskEnvelope(templateOnly), { prompt: templateOnly, envelope: null });
});

test("splitTaskEnvelopeKeepsSkillCommandOnFirstLine", () => {
  // 拆开后用户的斜杠命令回到首行，紧随其后的改写才能真正命中。
  const wrapped = MICO_ENVELOPE.replace("你好", "/cross-cr 检查这段代码");
  const { prompt } = splitTaskEnvelope(wrapped);
  assert.equal(prompt, "/cross-cr 检查这段代码");
  const rewritten = rewriteSkillCommand(prompt, { skills: new Set(["cross-cr"]), commands: new Set() });
  assert.equal(rewritten, "/skill cross-cr 检查这段代码");
});

test("summarizeStderrFiltersBundledSourceNoise", () => {
  // 实测现场：provider 报错时 stderr 混入崩溃中途的压缩 bundle 源码与栈帧，
  // providerMessage 才是真正的原因，必须留下来，源码不能占位。
  const stderr = [
    "[debug] cwd=C:\\x HOME=C:\\y cli=D:\\zcode\\resources\\glm\\zcode.cjs node=node",
    'ffer=new wAn({maxBufferSize:e.maxBufferSize}),(e.stderr==="pipe"||e.stderr==="overlapped")&&this._stderrStream=new vEo.PassThrough)}async start(){if(!this._proc',
    "    at classifyNetworkError (zcode.cjs:2300:78579)",
    "  providerKind: 'openai-compatible',",
    "  providerMessage: 'API Key 不存在',",
  ].join("\n");
  const summary = summarizeStderr(stderr);
  assert.match(summary, /providerMessage: 'API Key 不存在'/, summary);
  assert.match(summary, /providerKind: 'openai-compatible'/, summary);
  assert.ok(!summary.includes("PassThrough"), summary);
  assert.ok(!summary.includes("maxBufferSize"), summary);
  assert.ok(!summary.includes("classifyNetworkError"), summary);
  // 结构化字段要排在上下文之前，避免被尾部截断挤掉。
  assert.ok(summary.indexOf("providerMessage") < summary.indexOf("[debug]"), summary);
});

test("applyZcodeRuntimeEnvInjectsDataBaseDirOnlyWhenRedirected", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_ENV_FILE", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"]);
  mkdirSync(path.join(dir, ".zcode"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ZCODE_ACP_ENV_FILE = path.join(dir, "missing.env");

  // 未重定向（setting.json 不存在）：不注入，交给 CLI 默认行为。
  const env = {};
  applyZcodeRuntimeEnv(env);
  assert.equal(env.ZCODE_DATA_BASE_DIR, undefined);

  // env-file 显式给出重定向值：原样继承。
  const redirected = path.join(dir, "desktop-home");
  writeFixture(process.env.ZCODE_ACP_ENV_FILE, `ZCODE_DATA_BASE_DIR=${redirected}\n`);
  const desktopEnv = {};
  applyZcodeRuntimeEnv(desktopEnv);
  assert.equal(desktopEnv.ZCODE_DATA_BASE_DIR, redirected);
});

test("applyZcodeRuntimeEnvDiscoversDataBaseDirFromSettingFile", (t) => {
  // Desktop 重定向数据目录后，非 Desktop 终端里只能靠 setting.json 发现；
  // CLI 自身不读它，因此必须由 bridge 注入，否则会读到家目录下的旧配置（401）。
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_ENV_FILE", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"]);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ZCODE_ACP_ENV_FILE = path.join(dir, "missing.env");

  const redirected = path.join(dir, "redirected-data");
  mkdirSync(redirected, { recursive: true });
  writeFixture(
    path.join(dir, ".zcode", "v2", "setting.json"),
    JSON.stringify({ dataBaseDir: redirected }),
  );

  const env = {};
  applyZcodeRuntimeEnv(env);
  assert.equal(env.ZCODE_DATA_BASE_DIR, path.normalize(redirected));
});

test("redirectedDataBaseDirRejectsUnsafeValues", (t) => {
  // setting.json 是本机文件但仍按不可信输入处理：非法形态一律忽略。
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_ENV_FILE", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"]);
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.ZCODE_ACP_ENV_FILE = path.join(dir, "missing.env");
  const settingPath = path.join(dir, ".zcode", "v2", "setting.json");

  for (const dataBaseDir of [
    "relative/path",
    path.join(dir, "nested", "..", "nested"),
    path.join(dir, "does-not-exist"),
    42,
  ]) {
    writeFixture(settingPath, JSON.stringify({ dataBaseDir }));
    const env = {};
    applyZcodeRuntimeEnv(env);
    assert.equal(env.ZCODE_DATA_BASE_DIR, undefined, `应拒绝：${String(dataBaseDir)}`);
  }

  // 损坏的 JSON 同样忽略。
  writeFixture(settingPath, "{not json");
  const env = {};
  applyZcodeRuntimeEnv(env);
  assert.equal(env.ZCODE_DATA_BASE_DIR, undefined);
});

test("personalProviderConfigPathFollowsDataBaseDir", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_DATA_BASE_DIR", "HOME", "USERPROFILE"]);

  // 显式设置的值优先，不因数据目录存在而被改写。
  const explicit = path.join(dir, "custom-provider.json");
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = explicit;
  process.env.ZCODE_DATA_BASE_DIR = path.join(dir, "data");
  assert.equal(personalProviderConfigPath(), explicit);

  // 未设置时按数据目录推导，布局与 zcode CLI 一致。
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  assert.equal(
    personalProviderConfigPath(),
    path.join(dir, "data", ".zcode", "v2", "provider_config.json"),
  );

  // 数据目录也未设置时退回家目录。
  delete process.env.ZCODE_DATA_BASE_DIR;
  process.env.USERPROFILE = dir;
  assert.equal(
    personalProviderConfigPath(),
    path.join(dir, ".zcode", "v2", "provider_config.json"),
  );
});

test("listModelsDerivesProviderConfigFromDataBaseDir", (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, [
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_DATA_BASE_DIR",
  ]);
  const dataDir = path.join(dir, "data");
  writeFixture(
    path.join(dataDir, ".zcode", "v2", "provider_config.json"),
    JSON.stringify({
      config: {
        providerOrder: ["p1"],
        providerConfigRules: { providerRules: [{ providerId: "p1", config: { modelOrder: ["m1"] } }] },
      },
    }),
  );
  process.env.ZCODE_DATA_BASE_DIR = dataDir;
  assert.equal(listModels()?.availableModels.length, 1);
});

// 会话续接状态落盘（session-store）：bridge 重启后 resume/load 据此恢复 zcodeSessionId，
// 不再新建重复会话。用 env 覆盖把落盘路径隔离到临时目录。
function makeRecord(id, overrides = {}) {
  return { id, zcodeSessionId: undefined, model: null, reasoningLevel: null, mode: null, ...overrides };
}

function isolateStore(t) {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_SESSION_STORE_FILE"]);
  const file = path.join(dir, "sessions.json");
  process.env.ZCODE_ACP_SESSION_STORE_FILE = file;
  return file;
}

test("sessionStorePathHonorsEnvOverride", (t) => {
  const file = isolateStore(t);
  assert.equal(sessionStorePath(), file);
});

test("sessionStoreRoundTripsResumeState", (t) => {
  isolateStore(t);
  const model = { providerId: "p1", modelId: "m1", reasoningLevels: ["low", "high"] };
  persistSession(makeRecord("acp-1", { zcodeSessionId: "sess_abc", model, reasoningLevel: "high", mode: "build" }));
  // 模拟 bridge 重启：内存记录丢失，resume/load 重建一条空记录再恢复。
  const rebuilt = makeRecord("acp-1");
  restoreSession(rebuilt);
  assert.equal(rebuilt.zcodeSessionId, "sess_abc");
  assert.deepEqual(rebuilt.model, model);
  assert.equal(rebuilt.reasoningLevel, "high");
  assert.equal(rebuilt.mode, "build");
});

test("restoreSessionLeavesDefaultsForUnknownId", (t) => {
  isolateStore(t);
  persistSession(makeRecord("known", { zcodeSessionId: "sess_known" }));
  const ghost = makeRecord("never-seen");
  restoreSession(ghost);
  assert.equal(ghost.zcodeSessionId, undefined);
  assert.equal(ghost.model, null);
});

test("persistSessionPrunesOldestBeyondCap", (t) => {
  const file = isolateStore(t);
  // 超出 256 上限：最旧淘汰，最新保留。
  for (let i = 0; i < 260; i++) persistSession(makeRecord(`id-${i}`, { zcodeSessionId: `sess_${i}` }));
  const store = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(Object.keys(store).length <= 256);
  assert.equal(store["id-0"], undefined);
  assert.equal(store["id-259"].zcodeSessionId, "sess_259");
});

test("sessionStoreSurvivesCorruptFile", (t) => {
  const file = isolateStore(t);
  writeFixture(file, "{ 这不是合法 JSON");
  const r = makeRecord("x");
  restoreSession(r); // 损坏文件当空映射，不抛错
  assert.equal(r.zcodeSessionId, undefined);
  persistSession(makeRecord("x", { zcodeSessionId: "sess_ok" })); // 覆盖损坏文件
  const r2 = makeRecord("x");
  restoreSession(r2);
  assert.equal(r2.zcodeSessionId, "sess_ok");
});

test("sessionStoreResistsPrototypePollutionKey", (t) => {
  isolateStore(t);
  // 客户端 sessionId 是外部输入：恶意键不得经括号赋值污染原型。
  persistSession(makeRecord("__proto__", { zcodeSessionId: "sess_evil" }));
  assert.equal(Object.prototype.zcodeSessionId, undefined);
  persistSession(makeRecord("normal", { zcodeSessionId: "sess_normal" }));
  const normal = makeRecord("normal");
  restoreSession(normal);
  assert.equal(normal.zcodeSessionId, "sess_normal");
  // 恶意键作为普通自有键存取，不影响其它会话。
  const evil = makeRecord("__proto__");
  restoreSession(evil);
  assert.equal(evil.zcodeSessionId, "sess_evil");
});

test("logEventAppendsNdjsonWhenConfigured", async (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_LOG"]);
  const logPath = path.join(dir, "logs", "acp.log");
  process.env.ZCODE_ACP_LOG = logPath;
  logEvent("turn.start", { mode: "yolo" });
  logEvent("turn.end", { failed: true });
  // appendFile 是异步追加：轮询等两行落齐再断言。
  let lines = [];
  for (let i = 0; i < 50; i++) {
    if (existsSync(logPath)) {
      lines = readFileSync(logPath, "utf8").trim().split("\n");
      if (lines.length >= 2) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(lines.length, 2);
  const start = JSON.parse(lines[0]);
  assert.equal(start.event, "turn.start");
  assert.equal(start.mode, "yolo");
  assert.ok(start.ts);
  assert.equal(JSON.parse(lines[1]).event, "turn.end");
});

test("logEventWritesNothingWithoutEnv", async (t) => {
  const dir = makeTempDir(t);
  isolateEnv(t, ["ZCODE_ACP_LOG"]);
  logEvent("noop", {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readdirSync(dir).length, 0);
});
