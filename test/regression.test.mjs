import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findModel, listModels, writeSelectionConfig } from "../src/models.js";
import { effortLevelsForModel, reasoningLevelForEffort } from "../src/claude.js";
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
