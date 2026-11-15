import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeSelectionConfig } from "../src/models.js";
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
  isolateEnv(t, ["ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"]);
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
                  reasoningLevel: { values: ["low", "high", "max"] },
                },
              },
            },
          ],
        },
      },
    }),
  );
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = configPath;

  const copy = writeSelectionConfig({ providerId: "p1", modelId: "m1", reasoningLevel: "low" });
  assert.ok(copy);
  t.after(() => rmSync(copy, { force: true }));
  const written = JSON.parse(readFileSync(copy, "utf8"));
  const modelRule = written.config.modelConfigRules.providerModelRules[0];
  assert.deepEqual(modelRule.config.optionSpecs.maxOutputTokens, { max: 64000 });
  assert.deepEqual(modelRule.config.optionSpecs.reasoningLevel.values, ["high", "max", "low"]);
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
