import type { NormalizedUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/config.js";

export type ModelCostConfig = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type UsageTotals = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

const OPENROUTER_DYNAMIC_MODEL_COSTS: Record<string, ModelCostConfig> = {
  "qwen/qwen3.5-35b-a3b": {
    input: 0.2,
    output: 1.4,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "openai/gpt-5.4": {
    input: 3,
    output: 16,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "minimax/minimax-m2.5": {
    input: 0.3,
    output: 1.2,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "x-ai/grok-4.1-fast": {
    input: 0.3,
    output: 0.6,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "moonshotai/kimi-k2-thinking": {
    input: 0.5,
    output: 2.2,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "google/gemini-3.1-pro-preview-customtools": {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "google/gemini-3.1-pro-preview": {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  },
};

const GOOGLE_DYNAMIC_MODEL_COSTS: Record<string, ModelCostConfig> = {
  "gemini-3.1-pro-preview-customtools": {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "gemini-3.1-pro-preview": {
    input: 3,
    output: 15,
    cacheRead: 0,
    cacheWrite: 0,
  },
};

const MODEL_COST_OVERRIDES_ENV = "OPENCLAW_MODEL_COST_OVERRIDES_JSON";

let cachedModelCostOverridesRaw = "";
let cachedModelCostOverrides: Record<string, ModelCostConfig> = {};

function normalizeOpenRouterCostLookupModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("openrouter/")) {
    return trimmed.slice("openrouter/".length);
  }
  return trimmed;
}

function normalizeGoogleCostLookupModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("google/")) {
    return trimmed.slice("google/".length);
  }
  return trimmed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonnegativeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseModelCostConfigFromOverride(raw: unknown): ModelCostConfig | undefined {
  const record = asRecord(raw);
  if (!record) {
    return undefined;
  }
  const input = asNonnegativeFiniteNumber(record.input);
  const output = asNonnegativeFiniteNumber(record.output);
  if (input === undefined || output === undefined) {
    return undefined;
  }
  const cacheRead =
    asNonnegativeFiniteNumber(record.cacheRead) ??
    asNonnegativeFiniteNumber(record.cache_read) ??
    0;
  const cacheWrite =
    asNonnegativeFiniteNumber(record.cacheWrite) ??
    asNonnegativeFiniteNumber(record.cache_write) ??
    0;
  return { input, output, cacheRead, cacheWrite };
}

function normalizeModelCostOverrideKey(key: string): string {
  return key.trim().toLowerCase();
}

function resolveModelCostOverrides(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, ModelCostConfig> {
  const raw = env[MODEL_COST_OVERRIDES_ENV]?.trim() ?? "";
  if (raw === cachedModelCostOverridesRaw) {
    return cachedModelCostOverrides;
  }

  cachedModelCostOverridesRaw = raw;
  cachedModelCostOverrides = {};
  if (!raw) {
    return cachedModelCostOverrides;
  }

  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) {
      return cachedModelCostOverrides;
    }
    const next: Record<string, ModelCostConfig> = {};
    for (const [modelKey, value] of Object.entries(parsed)) {
      const normalizedKey = normalizeModelCostOverrideKey(modelKey);
      if (!normalizedKey) {
        continue;
      }
      const cost = parseModelCostConfigFromOverride(value);
      if (cost) {
        next[normalizedKey] = cost;
      }
    }
    cachedModelCostOverrides = next;
  } catch {
    cachedModelCostOverrides = {};
  }

  return cachedModelCostOverrides;
}

function addModelCostOverrideLookupKey(keys: Set<string>, key: string | undefined): void {
  if (!key) {
    return;
  }
  const normalized = normalizeModelCostOverrideKey(key);
  if (normalized) {
    keys.add(normalized);
  }
}

function resolveModelCostOverride(params: {
  provider: string;
  model: string;
  env?: NodeJS.ProcessEnv;
}): ModelCostConfig | undefined {
  const overrides = resolveModelCostOverrides(params.env);
  if (Object.keys(overrides).length === 0) {
    return undefined;
  }

  const provider = params.provider.trim().toLowerCase();
  const model = params.model.trim();
  const openRouterModel = normalizeOpenRouterCostLookupModelId(model);
  const googleModel = normalizeGoogleCostLookupModelId(model);
  const keys = new Set<string>();

  addModelCostOverrideLookupKey(keys, model);
  addModelCostOverrideLookupKey(keys, openRouterModel);
  addModelCostOverrideLookupKey(keys, googleModel);
  if (!model.startsWith("openrouter/")) {
    addModelCostOverrideLookupKey(keys, `openrouter/${model}`);
  }

  if (provider === "google") {
    addModelCostOverrideLookupKey(keys, googleModel);
    addModelCostOverrideLookupKey(keys, `google/${googleModel}`);
    addModelCostOverrideLookupKey(keys, `openrouter/google/${googleModel}`);
  }

  if (provider === "openrouter") {
    addModelCostOverrideLookupKey(keys, openRouterModel);
    addModelCostOverrideLookupKey(keys, `openrouter/${openRouterModel}`);
    if (openRouterModel.startsWith("google/")) {
      const googleUnprefixed = openRouterModel.slice("google/".length);
      addModelCostOverrideLookupKey(keys, googleUnprefixed);
      addModelCostOverrideLookupKey(keys, `google/${googleUnprefixed}`);
      addModelCostOverrideLookupKey(keys, `openrouter/google/${googleUnprefixed}`);
    }
  }

  for (const key of keys) {
    const match = overrides[key];
    if (match) {
      return match;
    }
  }
  return undefined;
}

export function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.round(safe));
}

export function formatUsd(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function hasPositiveModelCost(cost: ModelCostConfig | undefined): boolean {
  if (!cost) {
    return false;
  }
  return cost.input > 0 || cost.output > 0 || cost.cacheRead > 0 || cost.cacheWrite > 0;
}

function resolveDynamicModelCost(
  providerLower: string,
  model: string,
): ModelCostConfig | undefined {
  if (providerLower === "google") {
    return GOOGLE_DYNAMIC_MODEL_COSTS[normalizeGoogleCostLookupModelId(model)];
  }
  if (providerLower === "openrouter") {
    return OPENROUTER_DYNAMIC_MODEL_COSTS[normalizeOpenRouterCostLookupModelId(model)];
  }
  return undefined;
}

export function resolveModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): ModelCostConfig | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model) {
    return undefined;
  }
  const providerLower = provider.toLowerCase();
  const dynamicCost = resolveDynamicModelCost(providerLower, model);

  const providers = params.config?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  if (entry?.cost && (hasPositiveModelCost(entry.cost) || !dynamicCost)) {
    return entry.cost;
  }

  const envOverride = resolveModelCostOverride({ provider, model });
  if (envOverride) {
    return envOverride;
  }

  if (dynamicCost) {
    return dynamicCost;
  }

  return entry?.cost;
}

const toNumber = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

export function estimateUsageCost(params: {
  usage?: NormalizedUsage | UsageTotals | null;
  cost?: ModelCostConfig;
}): number | undefined {
  const usage = params.usage;
  const cost = params.cost;
  if (!usage || !cost) {
    return undefined;
  }
  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);
  const total =
    input * cost.input +
    output * cost.output +
    cacheRead * cost.cacheRead +
    cacheWrite * cost.cacheWrite;
  if (!Number.isFinite(total)) {
    return undefined;
  }
  return total / 1_000_000;
}
