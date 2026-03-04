import { describe, expect, it } from "vitest";
import { resolveGatewayUsageWithCredits } from "./usage-credits.js";

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

    expect(result.costUsd).toBeCloseTo(0.00125);
    expect(result.creditsUsed).toBeCloseTo(0.125);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 500,
      total: 1500,
      creditsUsed: 0.125,
      credits_used: 0.125,
      cost: {
        total: 0.00125,
        totalUsd: 0.00125,
        usd: 0.00125,
      },
    });
  });
});
