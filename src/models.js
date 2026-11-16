// ZCode 真实模型列表与"选中模型"的 provider 配置副本生成。
//
// 背景：zcode headless（-p）没有切换模型的参数（无 --model，/model 是客户端命令）。
// 实测其默认模型取 personal provider config 中 providerOrder[0] 的 modelOrder[0]，
// 且 ZCODE_PERSONAL_PROVIDER_CONFIG_FILE 允许重定向到副本文件。
// 因此模型选择 = 把选中 provider/模型重排到最前，生成一次性副本喂给子进程。
// （config.defaultModelSelection 字段只影响 Desktop UI，实测 headless 不读。）
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { builtinProviderConfigAt, personalProviderConfigPath } from "./runtime-env.js";
import { resolveZcode } from "./cli-locate.js";

// 找不到模型规则时的旧版回退档位。有元数据时使用该模型实际的
// optionSpecs.reasoningLevel.values，默认级别取末位（实测验证），
// 配置副本把选中值移到末位即完成切换。
export const REASONING_LEVELS = ["low", "high", "max"];

/** 思考级别是否是 zcode 认可的取值（set_config_option 只接受集合内的选择）。 */
export function isKnownReasoningLevel(value, levels = REASONING_LEVELS) {
  return levels.includes(value);
}

// ACP 的 modelId 是单个字符串，而模型由 (providerId, modelId) 二元组决定。
// 用 "::" 拼接：providerId（UUID 或 slug）与模型 id（如 zhipuai/glm-5.3-flash）
// 都不含 "::"，无歧义。
const SEPARATOR = "::";

export function encodeModelId({ providerId, modelId }) {
  return `${providerId}${SEPARATOR}${modelId}`;
}

/** 只认已存在的普通文件。 */
function isFile(p) {
  return Boolean(p) && existsSync(p) && statSync(p).isFile();
}

/**
 * 校验 provider 配置路径并返回规范化结果。
 *
 * 规则（与 runtime-env.js 的 env-file 防御一致）：必须是绝对路径，原始路径
 * 任一段不得为 `..`（禁止目录穿越），且必须是普通文件；不满足返回 null。
 * 所有把外部路径交给读文件的入口都要先过这里。
 */
function configPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  // 必须在 normalize 之前判断：normalize 会把 `..` 解析掉，之后再也查不到。
  if (value.split(/[\\/]/).includes("..")) return null;
  const normalized = path.normalize(value);
  return isFile(normalized) ? normalized : null;
}

/**
 * 读取 personal provider config，路径由调用方传入（env-file 继承的
 * ZCODE_PERSONAL_PROVIDER_CONFIG_FILE）。读不到或损坏返回 null，
 * 调用方回退到单模型声明，保证 ACP 链路不断。
 */
function readProviderConfig(filePath) {
  const normalized = configPath(filePath);
  if (!normalized) return null;
  try {
    return JSON.parse(readFileSync(normalized, "utf8"));
  } catch {
    return null;
  }
}

/** 模型配置规则数组；配置损坏时按空规则处理，保留调用方的降级路径。 */
function modelConfigRules(config, key) {
  const rules = config?.config?.modelConfigRules?.[key];
  return Array.isArray(rules) ? rules : [];
}

/** 与 zcode 一致：模型匹配大小写不敏感，API 类型与 URL 匹配大小写敏感。 */
function matchesRule(pattern, value, caseInsensitive = false) {
  if (typeof pattern !== "string" || typeof value !== "string") return false;
  try {
    return new RegExp(`^(?:${pattern})$`, caseInsensitive ? "i" : undefined).test(value);
  } catch {
    return false;
  }
}

/** 与 zcode 的规则匹配一致：比较前去掉 base URL 路径末尾的斜杠，保留 query/hash。 */
function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    const suffix = `${url.search}${url.hash}`;
    const full = url.toString();
    return `${(suffix ? full.slice(0, -suffix.length) : full).replace(/\/+$/, "")}${suffix}`;
  } catch {
    return undefined;
  }
}

/**
 * 只合并 reasoningLevel.values，其他配置仍由 zcode 自己处理。
 * 字段缺失表示继承；显式 null 表示清除；找不到任何规则时由调用方使用旧版三档回退。
 */
function overlayReasoningLevels(levels, modelConfig) {
  if (!modelConfig || !Object.hasOwn(modelConfig, "optionSpecs")) return levels;
  const specs = modelConfig.optionSpecs;
  if (specs === null) return [];
  if (!Object.hasOwn(specs, "reasoningLevel")) return levels;
  const reasoning = specs.reasoningLevel;
  if (!reasoning || typeof reasoning !== "object") return [];
  if (!Object.hasOwn(reasoning, "values")) return levels;
  if (!Array.isArray(reasoning.values)) return [];
  return [...new Set(reasoning.values.filter((value) => typeof value === "string" && value.trim()))];
}

/**
 * 按 zcode 的规则顺序计算单个模型的有效配置。
 * 顺序：通用模型 → API → 站点 → 模板 → 内置 provider → 个人 provider → 手工配置。
 */
function resolveModelConfig(personalConfig, builtinConfig, providerRule, modelId) {
  const providerId = providerRule.providerId;
  const apiType = providerRule.config?.api?.type;
  const baseUrl = normalizeBaseUrl(providerRule.config?.api?.baseUrl);
  let levels;
  // 没有启用元数据时保持旧版可见；显式禁用必须过滤，后续规则仍可重新启用。
  let enabled = true;
  const overlay = (rule) => {
    levels = overlayReasoningLevels(levels, rule.config);
    if (typeof rule.config?.enabled === "boolean") enabled = rule.config.enabled;
  };

  for (const rule of modelConfigRules(builtinConfig, "modelRules")) {
    if (matchesRule(rule.modelMatch, modelId, true)) overlay(rule);
  }
  for (const rule of modelConfigRules(builtinConfig, "modelApiRules")) {
    if (matchesRule(rule.modelMatch, modelId, true) && matchesRule(rule.apiTypeMatch, apiType)) overlay(rule);
  }
  for (const rule of modelConfigRules(builtinConfig, "providerSiteRules")) {
    if (
      matchesRule(rule.modelMatch, modelId, true) &&
      (rule.apiTypeMatch === undefined || matchesRule(rule.apiTypeMatch, apiType)) &&
      matchesRule(rule.baseUrlMatch, baseUrl)
    ) overlay(rule);
  }
  for (const rule of modelConfigRules(builtinConfig, "templateModelRules")) {
    if (rule.templateId === providerRule.templateId && rule.modelId === modelId) overlay(rule);
  }
  for (const rule of modelConfigRules(builtinConfig, "builtinProviderModelRules")) {
    if (rule.providerId === providerId && rule.modelId === modelId) overlay(rule);
  }
  for (const rule of modelConfigRules(personalConfig, "providerModelRules")) {
    if (rule.providerId === providerId && rule.modelId === modelId) overlay(rule);
  }
  for (const rule of modelConfigRules(personalConfig, "manualProviderModelRules")) {
    // 手工规则同样只做 overlay：zcode 只把既有配置投影到手册可表达字段，不清空档位。
    if (rule.providerId === providerId && rule.modelId === modelId) overlay(rule);
  }
  return { enabled, reasoningLevels: levels ?? [...REASONING_LEVELS] };
}

/** 按 providerOrder 展开启用的 provider 规则（enabled 缺失视为启用，与实测数据一致）。 */
function orderedRules(config) {
  const rules = config?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return [];
  const byId = new Map(
    rules.filter((rule) => rule?.providerId && rule?.config).map((rule) => [rule.providerId, rule]),
  );
  const order = Array.isArray(config.config.providerOrder)
    ? config.config.providerOrder
    : [...byId.keys()];
  return order.map((id) => byId.get(id)).filter((rule) => rule && rule.enabled !== false);
}

/**
 * 内置 provider 配置（含模型启用状态与思考档位规则）。
 *
 * 规则：环境变量优先；未设置时从 zcode CLI 的安装根反推，与 zcode.js
 * 注入给子进程的路径保持一致——否则本进程算出的模型列表（含 disabled 过滤）
 * 会与子进程实际行为不符。定位不到返回 null。
 */
function builtinProviderConfig() {
  const explicit = configPath(process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
  if (explicit) return readProviderConfig(explicit);
  let cli;
  try {
    ({ cli } = resolveZcode());
  } catch {
    return null;
  }
  // builtinProviderConfigAt 只拼接在 CLI 安装根之下，路径来源可信。
  return readProviderConfig(builtinProviderConfigAt(cli));
}

/**
 * 真实模型列表（含默认 currentModelId，即 providerOrder[0] 的第一个模型，
 * 与 headless 实测行为一致）。读不到配置返回 null。
 */
export function listModels() {
  const config = readProviderConfig(personalProviderConfigPath());
  if (!config) return null;
  const builtinConfig = builtinProviderConfig();
  const availableModels = [];
  for (const rule of orderedRules(config)) {
    const ids = rule.config.modelOrder ?? rule.config.personalModelIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string" || id === "") continue;
      const modelConfig = resolveModelConfig(config, builtinConfig, rule, id);
      if (!modelConfig.enabled) continue;
      const label = rule.providerName ?? rule.providerId;
      availableModels.push({
        modelId: encodeModelId({ providerId: rule.providerId, modelId: id }),
        name: `${id.split("/").pop()} (${label})`,
        reasoningLevels: modelConfig.reasoningLevels,
      });
    }
  }
  if (availableModels.length === 0) return null;
  return { availableModels, currentModelId: availableModels[0].modelId };
}

/**
 * 解析客户端回传的 modelId（`<providerId>::<modelId>` 编码）并确认在本机
 * 模型列表里；非本编码或不在列表内返回 null。
 */
export function findModel(value) {
  if (typeof value !== "string") return null;
  const at = value.indexOf(SEPARATOR);
  if (at <= 0) return null;
  const modelId = value.slice(at + SEPARATOR.length);
  if (!modelId) return null;
  const known = listModels()?.availableModels.find((model) => model.modelId === value);
  return known
    ? { providerId: value.slice(0, at), modelId, reasoningLevels: known.reasoningLevels }
    : null;
}

/**
 * 生成把选中模型重排到最前的 provider 配置副本，返回副本路径；
 * 选中的 provider 不存在时返回 null（调用方沿用原配置）。
 *
 * selection 可带 reasoningLevel（思考级别）：写入该模型 optionSpecs 的
 * values 末位（zcode 取末位为默认级别，实测验证）。只选思考级别未选模型时，
 * 落到默认模型（providerOrder[0] 的 modelOrder[0]，与 headless 行为一致）。
 *
 * 规则：
 * - 副本一次性（随机文件名）：同会话串行、跨会话并发都天然安全，
 *   留在临时目录由系统清理；
 * - 不改 apiKey 等其余内容：认证走该文件里的 apiKey，副本只是重排顺序。
 */
export function writeSelectionConfig(selection) {
  const config = readProviderConfig(personalProviderConfigPath());
  if (!config) return null;
  let rule;
  let modelId = selection.modelId;
  if (selection.providerId && modelId) {
    const rules = config.config?.providerConfigRules?.providerRules;
    rule = Array.isArray(rules)
      ? rules.find((r) => r?.providerId === selection.providerId && r?.config)
      : undefined;
  } else {
    // 未选模型：落到默认模型，只为了给思考级别一个 optionSpecs 落点。
    const first = orderedRules(config)[0];
    rule = first;
    modelId = first ? (first.config.modelOrder ?? first.config.personalModelIds)?.[0] : undefined;
  }
  if (!rule || !modelId) return null;
  if (selection.providerId) {
    if (Array.isArray(config.config.providerOrder)) {
      config.config.providerOrder = [
        selection.providerId,
        ...config.config.providerOrder.filter((id) => id !== selection.providerId),
      ];
    }
    // modelOrder 与 personalModelIds 语义同源，一并重排，避免 zcode 侧取另一字段时失配。
    for (const key of ["modelOrder", "personalModelIds"]) {
      const ids = rule.config[key];
      if (Array.isArray(ids)) {
        rule.config[key] = [modelId, ...ids.filter((id) => id !== modelId)];
      }
    }
  }
  if (selection.reasoningLevel) {
    const builtinConfig = builtinProviderConfig();
    const { reasoningLevels: levels } = resolveModelConfig(config, builtinConfig, rule, modelId);
    // 找不到既有 modelConfigRules 条目时补一条，保证 optionSpecs 有落点。
    const modelRules = config.config.modelConfigRules?.providerModelRules;
    if (Array.isArray(modelRules) && levels.includes(selection.reasoningLevel)) {
      let modelRule = modelRules.find(
        (r) => r?.modelId === modelId && r?.providerId === rule.providerId,
      );
      if (!modelRule) {
        modelRule = { modelId, providerId: rule.providerId, config: {} };
        modelRules.push(modelRule);
      }
      modelRule.config.optionSpecs = {
        ...modelRule.config.optionSpecs,
        reasoningLevel: {
          ...modelRule.config.optionSpecs?.reasoningLevel,
          values: [
            ...levels.filter((level) => level !== selection.reasoningLevel),
            selection.reasoningLevel,
          ],
        },
      };
    }
  }
  const copy = path.join(tmpdir(), `zcode-acp-provider-${randomUUID()}.json`);
  writeFileSync(copy, JSON.stringify(config));
  return copy;
}
