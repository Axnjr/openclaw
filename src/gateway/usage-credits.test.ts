import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkBillingStatus,
  consumeBillingCredits,
  resolveGatewayUsageWithCredits,
} from "./usage-credits.js";

afterEach(() => {
  delete process.env.OPENCLAW_BILLING_STATUS_CACHE_TTL_MS;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("gateway/usage-credits", () => {
  it("replaces zero placeholder cost and credits with derived OpenRouter pricing", () => {
    const result = resolveGatewayUsageWithCredits({
      usageRaw: {
        input: 1000,
        output: 500,
        creditsUsed: 0,
        cost: { total: 0 },
      },
      provider: "openrouter",
      model: "qwen/qwen3.5-35b-a3b",
    });

    expect(result.costUsd).toBeCloseTo(0.0009);
    expect(result.creditsUsed).toBeCloseTo(0.1286);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 500,
      total: 1500,
      creditsUsed: 0.1286,
      credits_used: 0.1286,
      cost: {
        total: 0.0009,
        totalUsd: 0.0009,
        usd: 0.0009,
      },
    });
  });

  it("derives credits for the new OpenAI OpenRouter default model", () => {
    const result = resolveGatewayUsageWithCredits({
      usageRaw: {
        input: 1000,
        output: 500,
        creditsUsed: 0,
        cost: { total: 0 },
      },
      provider: "openrouter",
      model: "openai/gpt-5.4",
    });

    expect(result.costUsd).toBeCloseTo(0.011);
    expect(result.creditsUsed).toBeCloseTo(1.5714);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 500,
      total: 1500,
      creditsUsed: 1.5714,
      credits_used: 1.5714,
      cost: {
        total: 0.011,
        totalUsd: 0.011,
        usd: 0.011,
      },
    });
  });

  it("honors USD_PER_CREDIT when deriving credits from usage cost", () => {
    const previous = process.env.USD_PER_CREDIT;
    process.env.USD_PER_CREDIT = "0.02";
    try {
      const result = resolveGatewayUsageWithCredits({
        usageRaw: {
          input: 1000,
          output: 500,
          creditsUsed: 0,
          cost: { total: 0 },
        },
        provider: "openrouter",
        model: "openai/gpt-5.4",
      });

      expect(result.costUsd).toBeCloseTo(0.011);
      expect(result.creditsUsed).toBeCloseTo(0.55);
    } finally {
      if (previous === undefined) {
        delete process.env.USD_PER_CREDIT;
      } else {
        process.env.USD_PER_CREDIT = previous;
      }
    }
  });

  it("falls back to default USD_PER_CREDIT when env value is invalid", () => {
    const previous = process.env.USD_PER_CREDIT;
    process.env.USD_PER_CREDIT = "invalid";
    try {
      const result = resolveGatewayUsageWithCredits({
        usageRaw: {
          input: 1000,
          output: 500,
          creditsUsed: 0,
          cost: { total: 0 },
        },
        provider: "openrouter",
        model: "openai/gpt-5.4",
      });

      expect(result.costUsd).toBeCloseTo(0.011);
      expect(result.creditsUsed).toBeCloseTo(1.5714);
    } finally {
      if (previous === undefined) {
        delete process.env.USD_PER_CREDIT;
      } else {
        process.env.USD_PER_CREDIT = previous;
      }
    }
  });

  it("caches billing status responses for the configured TTL", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    process.env.OPENCLAW_BILLING_STATUS_CACHE_TTL_MS = "1000";

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ canChat: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await checkBillingStatus("cached.example.com");
    const second = await checkBillingStatus("cached.example.com");

    expect(first).toEqual({ canChat: true, error: undefined });
    expect(second).toEqual({ canChat: true, error: undefined });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient consume failures and returns the successful response", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 500,
        statusText: "Server Error",
        text: async () => JSON.stringify({ billingReason: "ok" }),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        text: async () =>
          JSON.stringify({
            appliedCredits: 5,
            creditsRemaining: 45,
            canChat: true,
            billingReason: "ok",
            idempotencyKey: "credit:run-retry",
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const consumePromise = consumeBillingCredits({
      domain: "retry.example.com",
      runId: "run-retry",
      creditsUsed: 5,
    });

    await vi.runAllTimersAsync();
    const result = await consumePromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      appliedCredits: 5,
      creditsRemaining: 45,
      canChat: true,
      billingReason: "ok",
      idempotencyKey: "credit:run-retry",
      statusCode: 200,
      retryable: false,
    });

    vi.useRealTimers();
  });

  it("reuses a single inflight consume request per hosted runId", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";

    let resolveFetch:
      | ((value: { status: number; statusText: string; text: () => Promise<string> }) => void)
      | undefined;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const firstPromise = consumeBillingCredits({
      domain: "singleflight.example.com",
      runId: "run-singleflight",
      creditsUsed: 3,
    });
    const secondPromise = consumeBillingCredits({
      domain: "singleflight.example.com",
      runId: "run-singleflight",
      creditsUsed: 3,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          appliedCredits: 3,
          creditsRemaining: 42,
          canChat: true,
          billingReason: "ok",
          idempotencyKey: "credit:run-singleflight",
        }),
    });

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult).toMatchObject({
      ok: true,
      appliedCredits: 3,
      creditsRemaining: 42,
      canChat: true,
      billingReason: "ok",
      idempotencyKey: "credit:run-singleflight",
      statusCode: 200,
      retryable: false,
    });
  });
});
