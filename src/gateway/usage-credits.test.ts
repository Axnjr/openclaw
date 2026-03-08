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

    expect(result.costUsd).toBeCloseTo(0.0009);
    expect(result.creditsUsed).toBeCloseTo(0.09);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 500,
      total: 1500,
      creditsUsed: 0.09,
      credits_used: 0.09,
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
    expect(result.creditsUsed).toBeCloseTo(1.1);
    expect(result.usage).toMatchObject({
      input: 1000,
      output: 500,
      total: 1500,
      creditsUsed: 1.1,
      credits_used: 1.1,
      cost: {
        total: 0.011,
        totalUsd: 0.011,
        usd: 0.011,
      },
    });
  });
});
