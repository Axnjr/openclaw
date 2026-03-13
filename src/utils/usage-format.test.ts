import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "./usage-format.js";

afterEach(() => {
  delete process.env.OPENCLAW_MODEL_COST_OVERRIDES_JSON;
});

describe("usage-format", () => {
  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12000)).toBe("12k");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                id: "m1",
                cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cost = resolveModelCostConfig({
      provider: "test",
      model: "m1",
      config,
    });

    expect(cost).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0.5,
      cacheWrite: 0,
    });

    const total = estimateUsageCost({
      usage: { input: 1000, output: 500, cacheRead: 2000 },
      cost,
    });

    expect(total).toBeCloseTo(0.003);
  });

  it("resolves built-in OpenRouter pricing for known dynamic models", () => {
    const cost = resolveModelCostConfig({
      provider: "openrouter",
      model: "openrouter/google/gemini-3.1-pro-preview",
    });

    expect(cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("resolves built-in Google pricing for known direct models", () => {
    const direct = resolveModelCostConfig({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    const prefixed = resolveModelCostConfig({
      provider: "google",
      model: "google/gemini-3.1-pro-preview-customtools",
    });

    expect(direct).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(prefixed).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("prefers env model cost overrides for google/openrouter key variants", () => {
    process.env.OPENCLAW_MODEL_COST_OVERRIDES_JSON = JSON.stringify({
      "openrouter/google/gemini-3.1-pro-preview": {
        input: 2.5,
        output: 11.5,
        cacheRead: 0.25,
        cacheWrite: 0.5,
      },
    });

    const fromGoogleDirect = resolveModelCostConfig({
      provider: "google",
      model: "gemini-3.1-pro-preview",
    });
    const fromGooglePrefixed = resolveModelCostConfig({
      provider: "google",
      model: "google/gemini-3.1-pro-preview",
    });
    const fromOpenRouterPrefixed = resolveModelCostConfig({
      provider: "openrouter",
      model: "openrouter/google/gemini-3.1-pro-preview",
    });

    expect(fromGoogleDirect).toEqual({
      input: 2.5,
      output: 11.5,
      cacheRead: 0.25,
      cacheWrite: 0.5,
    });
    expect(fromGooglePrefixed).toEqual({
      input: 2.5,
      output: 11.5,
      cacheRead: 0.25,
      cacheWrite: 0.5,
    });
    expect(fromOpenRouterPrefixed).toEqual({
      input: 2.5,
      output: 11.5,
      cacheRead: 0.25,
      cacheWrite: 0.5,
    });
  });

  it("treats zero placeholder Gemini config costs as missing and uses defaults", () => {
    const config = {
      models: {
        providers: {
          google: {
            models: [
              {
                id: "gemini-3.1-pro-preview",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
          openrouter: {
            models: [
              {
                id: "openrouter/google/gemini-3.1-pro-preview",
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const googleCost = resolveModelCostConfig({
      provider: "google",
      model: "gemini-3.1-pro-preview",
      config,
    });
    const openRouterCost = resolveModelCostConfig({
      provider: "openrouter",
      model: "openrouter/google/gemini-3.1-pro-preview",
      config,
    });

    expect(googleCost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(openRouterCost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
