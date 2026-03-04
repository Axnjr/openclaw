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
  "openai/gpt-5.3-codex": {
    input: 1.75,
    output: 14,
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
    input: 2,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
  },
  "google/gemini-3.1-pro-preview": {
    input: 2,
    output: 12,
    cacheRead: 0,
    cacheWrite: 0,
  },
};

function normalizeOpenRouterCostLookupModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("openrouter/")) {
    return trimmed.slice("openrouter/".length);
  }
  return trimmed;
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
  const providers = params.config?.models?.providers ?? {};
  const entry = providers[provider]?.models?.find((item) => item.id === model);
  if (entry?.cost) {
    return entry.cost;
  }

  if (provider.toLowerCase() !== "openrouter") {
    return undefined;
  }

  return OPENROUTER_DYNAMIC_MODEL_COSTS[normalizeOpenRouterCostLookupModelId(model)];
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
