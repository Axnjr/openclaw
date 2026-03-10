import type { OpenClawConfig } from "../config/config.js";
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "../agents/usage.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import { buildControlPlaneApiUrl } from "./control-plane-url.js";

const DEFAULT_USD_PER_CREDIT = 0.01;
const CREDITS_ROUNDING_SCALE = 10_000;
const DEFAULT_BILLING_STATUS_CACHE_TTL_MS = 3_000;
const BILLING_CONSUME_RETRY_DELAYS_MS = [500, 1_500, 4_000] as const;
const BILLING_CONSUME_INFLIGHT_TTL_MS = 5 * 60 * 1000;

type JsonRecord = Record<string, unknown>;

type BillingStatusResult = { canChat: boolean; error?: string };
type BillingStatusCacheEntry = BillingStatusResult & { expiresAt: number };
type BillingReason = "ok" | "byok" | "entitlement_required" | "insufficient_credits";
type BillingConsumeInflightEntry = {
  promise: Promise<ConsumeBillingCreditsResult>;
  expiresAt: number;
};

const billingStatusCache = new Map<string, BillingStatusCacheEntry>();
const billingConsumeInflight = new Map<string, BillingConsumeInflightEntry>();

export type GatewayUsageWithCredits = {
  usage?: JsonRecord;
  costUsd?: number;
  creditsUsed: number;
};

export type ConsumeBillingCreditsResult = {
  ok: boolean;
  appliedCredits: number;
  creditsRemaining: number | null;
  canChat: boolean | null;
  billingReason: BillingReason | null;
  idempotencyKey: string | null;
  statusCode: number | null;
  retryable: boolean;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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

function resolveUsdPerCredit(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.USD_PER_CREDIT?.trim();
  if (!raw) {
    return DEFAULT_USD_PER_CREDIT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_USD_PER_CREDIT;
  }
  return parsed;
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
  const derivedCreditsFromCost = costUsd !== undefined ? costUsd / resolveUsdPerCredit() : 0;
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

export async function consumeBillingCredits(params: {
  domain: string | undefined;
  runId: string;
  creditsUsed: number;
}): Promise<ConsumeBillingCreditsResult> {
  pruneBillingConsumeInflight();
  const existing = billingConsumeInflight.get(params.runId);
  if (existing && existing.expiresAt > Date.now()) {
    return existing.promise;
  }

  const promise = performConsumeBillingCredits(params).finally(() => {
    billingConsumeInflight.delete(params.runId);
  });
  billingConsumeInflight.set(params.runId, {
    promise,
    expiresAt: Date.now() + BILLING_CONSUME_INFLIGHT_TTL_MS,
  });
  return promise;
}

async function performConsumeBillingCredits(params: {
  domain: string | undefined;
  runId: string;
  creditsUsed: number;
}): Promise<ConsumeBillingCreditsResult> {
  console.log(`[BillingConsume] Request initialized:`, params);
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  if (!gatewayToken) {
    console.log(`[BillingConsume] Failed: No OPENCLAW_GATEWAY_TOKEN found`);
    return {
      ok: false,
      appliedCredits: 0,
      creditsRemaining: null,
      canChat: null,
      billingReason: null,
      idempotencyKey: null,
      statusCode: null,
      retryable: false,
    };
  }
  if (params.creditsUsed <= 0) {
    console.log(`[BillingConsume] Skipped: creditsUsed (${params.creditsUsed}) <= 0`);
    return {
      ok: true,
      appliedCredits: 0,
      creditsRemaining: null,
      canChat: null,
      billingReason: null,
      idempotencyKey: null,
      statusCode: null,
      retryable: false,
    };
  }

  clearBillingStatusCache(params.domain);
  const url = buildControlPlaneApiUrl("/billing/consume");
  console.log(`[BillingConsume] URL Built: ${url}`);

  for (let attempt = 0; attempt < BILLING_CONSUME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openclaw-gateway-token": gatewayToken,
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify({
          domain: params.domain,
          runId: params.runId,
          creditsUsed: params.creditsUsed,
        }),
      });

      const text = await response.text();
      console.log(`[BillingConsume] Response Status: ${response.status} ${response.statusText}`);
      console.log(`[BillingConsume] Response Body: ${text}`);

      const parsedPayload = parseJsonObjectRecord(text);
      const result = buildConsumeBillingCreditsResult(response.status, parsedPayload);
      if (!result.retryable || attempt === BILLING_CONSUME_RETRY_DELAYS_MS.length - 1) {
        return result;
      }
    } catch (err) {
      console.warn(`[BillingConsume] Request error (attempt ${attempt + 1}): ${String(err)}`);
      if (attempt === BILLING_CONSUME_RETRY_DELAYS_MS.length - 1) {
        return {
          ok: false,
          appliedCredits: 0,
          creditsRemaining: null,
          canChat: null,
          billingReason: null,
          idempotencyKey: null,
          statusCode: null,
          retryable: true,
        };
      }
    }

    await delay(BILLING_CONSUME_RETRY_DELAYS_MS[attempt]);
  }

  return {
    ok: false,
    appliedCredits: 0,
    creditsRemaining: null,
    canChat: null,
    billingReason: null,
    idempotencyKey: null,
    statusCode: null,
    retryable: true,
  };
}

function parseJsonObjectRecord(raw: string): JsonRecord | null {
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed) ?? null;
  } catch {
    return null;
  }
}

function buildConsumeBillingCreditsResult(
  statusCode: number,
  payload: JsonRecord | null,
): ConsumeBillingCreditsResult {
  const billingReasonRaw = asString(payload?.billingReason) ?? asString(payload?.billing_reason);
  const billingReason =
    billingReasonRaw === "ok" ||
    billingReasonRaw === "byok" ||
    billingReasonRaw === "entitlement_required" ||
    billingReasonRaw === "insufficient_credits"
      ? billingReasonRaw
      : null;
  const appliedCredits = roundGatewayCredits(asFiniteNumber(payload?.appliedCredits) ?? 0);
  const creditsRemaining = asFiniteNumber(payload?.creditsRemaining) ?? null;
  const canChat = asBoolean(payload?.canChat) ?? null;
  const idempotencyKey = asString(payload?.idempotencyKey) ?? null;
  const retryable = statusCode === 429 || statusCode >= 500;
  return {
    ok: statusCode >= 200 && statusCode < 300,
    appliedCredits,
    creditsRemaining,
    canChat,
    billingReason,
    idempotencyKey,
    statusCode,
    retryable,
  };
}

function pruneBillingConsumeInflight(): void {
  if (billingConsumeInflight.size === 0) {
    return;
  }
  const now = Date.now();
  for (const [runId, entry] of billingConsumeInflight) {
    if (entry.expiresAt <= now) {
      billingConsumeInflight.delete(runId);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveBillingStatusCacheKey(domain: string | undefined): string {
  return domain?.trim() || "__default__";
}

function resolveBillingStatusCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OPENCLAW_BILLING_STATUS_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_BILLING_STATUS_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_BILLING_STATUS_CACHE_TTL_MS;
  }
  return Math.round(parsed);
}

function readBillingStatusCache(domain: string | undefined): BillingStatusResult | undefined {
  const cacheKey = resolveBillingStatusCacheKey(domain);
  const entry = billingStatusCache.get(cacheKey);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    billingStatusCache.delete(cacheKey);
    return undefined;
  }
  return {
    canChat: entry.canChat,
    error: entry.error,
  };
}

function writeBillingStatusCache(domain: string | undefined, result: BillingStatusResult): void {
  const ttlMs = resolveBillingStatusCacheTtlMs();
  if (ttlMs <= 0) {
    return;
  }
  billingStatusCache.set(resolveBillingStatusCacheKey(domain), {
    ...result,
    expiresAt: Date.now() + ttlMs,
  });
}

function clearBillingStatusCache(domain: string | undefined): void {
  billingStatusCache.delete(resolveBillingStatusCacheKey(domain));
}

export async function checkBillingStatus(domain: string | undefined): Promise<BillingStatusResult> {
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) {
    return { canChat: true }; // Default to true if not configured
  }

  const cached = readBillingStatusCache(domain);
  if (cached) {
    return cached;
  }

  try {
    const url = buildControlPlaneApiUrl(
      domain ? `/billing/status?domain=${encodeURIComponent(domain)}` : `/billing/status`,
    );
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-openclaw-gateway-token": gatewayToken,
        Authorization: `Bearer ${gatewayToken}`,
      },
    });

    if (!res.ok) {
      const result = { canChat: false, error: `Billing API returned status: ${res.status}` };
      writeBillingStatusCache(domain, result);
      return result;
    }

    const data = await res.json();
    const result = {
      canChat: data.canChat !== false,
      error:
        data.canChat === false
          ? "Insufficient credits or active subscription required to chat."
          : undefined,
    };
    writeBillingStatusCache(domain, result);
    return result;
  } catch (err) {
    const result = { canChat: false, error: `Billing API error: ${String(err)}` };
    writeBillingStatusCache(domain, result);
    return result;
  }
}
