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

// zcode 的思考级别（reasoningLevel）取值集。headless 同样无参数可设，但
// 默认级别 = modelConfigRules 中该模型 optionSpecs.reasoningLevel.values 的
// 最后一项（实测验证），副本里把选中值放到最后即完成切换。
// 末位 "max" 与不设置 optionSpecs 时的默认行为一致（实测多个模型默认 max）。
export const REASONING_LEVELS = ["low", "high", "max"];

/** 思考级别是否是 zcode 认可的取值（set_config_option 只接受集合内的选择）。 */
export function isKnownReasoningLevel(value) {
  return REASONING_LEVELS.includes(value);
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
 * 读取 personal provider config，路径由调用方传入（env-file 继承的
 * ZCODE_PERSONAL_PROVIDER_CONFIG_FILE）。读不到或损坏返回 null，
 * 调用方回退到单模型声明，保证 ACP 链路不断。
 *
 * 规则（与 runtime-env.js 的 env-file 防御一致）：路径必须是绝对路径，
 * 规范化后任一路径段不得为 `..`（禁止目录穿越），且必须是普通文件。
 */
function readProviderConfig(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  const normalized = path.normalize(filePath);
  if (normalized.split(/[\\/]/).includes("..")) return null;
  if (!isFile(normalized)) return null;
  try {
    return JSON.parse(readFileSync(normalized, "utf8"));
  } catch {
    return null;
  }
}

/** 本进程环境中配置的 personal provider config 路径（由 env-file 继承）。 */
function providerConfigPath() {
  return process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
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
 * 真实模型列表（含默认 currentModelId，即 providerOrder[0] 的第一个模型，
 * 与 headless 实测行为一致）。读不到配置返回 null。
 */
export function listModels() {
  const config = readProviderConfig(providerConfigPath());
  if (!config) return null;
  const availableModels = [];
  for (const rule of orderedRules(config)) {
    const ids = rule.config.modelOrder ?? rule.config.personalModelIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== "string" || id === "") continue;
      const label = rule.providerName ?? rule.providerId;
      availableModels.push({
        modelId: encodeModelId({ providerId: rule.providerId, modelId: id }),
        name: `${id.split("/").pop()} (${label})`,
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
  const known = listModels()?.availableModels.some((model) => model.modelId === value);
  return known ? { providerId: value.slice(0, at), modelId } : null;
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
 * - 不改 apiKey 等其余内容：认证走 ZCODE_OFFICIAL_ENDPOINT，与该文件无关。
 */
export function writeSelectionConfig(selection) {
  const config = readProviderConfig(providerConfigPath());
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
    // 找不到既有 modelConfigRules 条目时补一条，保证 optionSpecs 有落点。
    const modelRules = config.config.modelConfigRules?.providerModelRules;
    if (Array.isArray(modelRules)) {
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
          values: [
            ...REASONING_LEVELS.filter((level) => level !== selection.reasoningLevel),
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
