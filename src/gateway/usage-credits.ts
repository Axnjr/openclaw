import type { OpenClawConfig } from "../config/config.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "../agents/usage.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";

const USD_PER_CREDIT = 0.01;
const CREDITS_ROUNDING_SCALE = 10_000;

type JsonRecord = Record<string, unknown>;

export type GatewayUsageWithCredits = {
  usage?: JsonRecord;
  costUsd?: number;
  creditsUsed: number;
};

function resolveGatewayModelCostConfig(params: {
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}) {
  const direct = resolveModelCostConfig(params);
  if (direct || params.provider?.trim() !== "openrouter") {
    return direct;
  }

  const model = params.model?.trim();
  if (!model?.startsWith("openrouter/")) {
    return direct;
  }

  return resolveModelCostConfig({
    ...params,
    model: model.slice("openrouter/".length),
  });
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function resolveTotalTokens(usage: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}): number | undefined {
  if (typeof usage.total === "number" && Number.isFinite(usage.total)) {
    return usage.total;
  }
  const derived =
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return derived > 0 ? derived : undefined;
}

function resolveUsageCostUsd(usageRaw: unknown): number | undefined {
  const usage = asRecord(usageRaw);
  if (!usage) {
    return undefined;
  }
  const cost = asRecord(usage.cost);
  const value =
    asFiniteNumber(cost?.totalUsd) ??
    asFiniteNumber(cost?.total_usd) ??
    asFiniteNumber(cost?.usd) ??
    asFiniteNumber(cost?.total) ??
    asFiniteNumber(usage.totalCostUsd) ??
    asFiniteNumber(usage.total_cost_usd) ??
    asFiniteNumber(usage.costUsd) ??
    asFiniteNumber(usage.cost_usd);
  if (value === undefined || value < 0) {
    return undefined;
  }
  return value;
}

function resolveUsageCredits(usageRaw: unknown): number | undefined {
  const usage = asRecord(usageRaw);
  if (!usage) {
    return undefined;
  }
  const value = asFiniteNumber(usage.creditsUsed) ?? asFiniteNumber(usage.credits_used);
  if (value === undefined) {
    return undefined;
  }
  return Math.max(0, value);
}

export function roundGatewayCredits(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value * CREDITS_ROUNDING_SCALE) / CREDITS_ROUNDING_SCALE);
}

export function parseGatewayCreditsUsed(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  if (parsed === undefined) {
    return undefined;
  }
  return roundGatewayCredits(parsed);
}

export function withUsageCredits(
  usage: JsonRecord | undefined,
  creditsUsed: number,
): JsonRecord | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    ...usage,
    creditsUsed,
    credits_used: creditsUsed,
  };
}

export function resolveGatewayUsageWithCredits(params: {
  usageRaw: unknown;
  provider?: string;
  model?: string;
  config?: OpenClawConfig;
}): GatewayUsageWithCredits {
  const normalizedUsage = normalizeUsage((params.usageRaw ?? undefined) as UsageLike | undefined);
  const explicitCostUsd = resolveUsageCostUsd(params.usageRaw);
  const derivedCostUsd = normalizedUsage
    ? estimateUsageCost({
        usage: normalizedUsage,
        cost: resolveGatewayModelCostConfig({
          provider: params.provider,
          model: params.model,
          config: params.config,
        }),
      })
    : undefined;
  const shouldPreferDerivedCost =
    explicitCostUsd === 0 &&
    hasNonzeroUsage(normalizedUsage) &&
    typeof derivedCostUsd === "number" &&
    Number.isFinite(derivedCostUsd) &&
    derivedCostUsd > 0;
  const resolvedCostUsd = shouldPreferDerivedCost
    ? derivedCostUsd
    : (explicitCostUsd ?? derivedCostUsd);
  const costUsd =
    typeof resolvedCostUsd === "number" && Number.isFinite(resolvedCostUsd) && resolvedCostUsd >= 0
      ? resolvedCostUsd
      : undefined;

  const explicitCreditsFromUsage = resolveUsageCredits(params.usageRaw);
  const derivedCreditsFromCost = costUsd !== undefined ? costUsd / USD_PER_CREDIT : 0;
  const shouldPreferDerivedCredits =
    explicitCreditsFromUsage === 0 &&
    hasNonzeroUsage(normalizedUsage) &&
    Number.isFinite(derivedCreditsFromCost) &&
    derivedCreditsFromCost > 0;
  const creditsFromUsage = shouldPreferDerivedCredits ? undefined : explicitCreditsFromUsage;
  const creditsUsed = roundGatewayCredits(creditsFromUsage ?? derivedCreditsFromCost);

  if (!normalizedUsage) {
    return { creditsUsed, costUsd };
  }

  const totalTokens = resolveTotalTokens(normalizedUsage);
  const usage: JsonRecord = {
    input: normalizedUsage.input,
    output: normalizedUsage.output,
    cacheRead: normalizedUsage.cacheRead,
    cacheWrite: normalizedUsage.cacheWrite,
    total: totalTokens,
    totalTokens,
    total_tokens: totalTokens,
    creditsUsed,
    credits_used: creditsUsed,
  };

  if (costUsd !== undefined) {
    usage.cost = {
      total: costUsd,
      totalUsd: costUsd,
      usd: costUsd,
    };
  }

  return { usage, costUsd, creditsUsed };
}
