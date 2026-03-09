import type { Api, Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeModelCompat } from "../model-compat.js";
import { resolveForwardCompatModel } from "../model-forward-compat.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import {
  discoverAuthStorage,
  discoverModels,
  type AuthStorage,
  type ModelRegistry,
} from "../pi-model-discovery.js";

type InlineModelEntry = ModelDefinitionConfig & { provider: string; baseUrl?: string };
type InlineProviderConfig = {
  baseUrl?: string;
  api?: ModelDefinitionConfig["api"];
  models?: ModelDefinitionConfig[];
};

const XAI_MODEL_ALIASES: Record<string, string> = {
  "grok-4-1-fast": "grok-4.1-fast",
};

const MINIMAX_MODEL_ALIASES: Record<string, string> = {
  "minimax-m2.1": "MiniMax-M2.1",
  "minimax-m2.1-lightning": "MiniMax-M2.1-lightning",
  "minimax-vl-01": "MiniMax-VL-01",
  "minimax-m2.5": "MiniMax-M2.5",
  "minimax-m2.5-lightning": "MiniMax-M2.5-Lightning",
};

export { buildModelAliasLines };

export function buildInlineProviderModels(
  providers: Record<string, InlineProviderConfig>,
): InlineModelEntry[] {
  return Object.entries(providers).flatMap(([providerId, entry]) => {
    const trimmed = providerId.trim();
    if (!trimmed) {
      return [];
    }
    return (entry?.models ?? []).map((model) => ({
      ...model,
      provider: trimmed,
      baseUrl: entry?.baseUrl,
      api: model.api ?? entry?.api,
    }));
  });
}

function normalizeModelIdForProvider(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (provider === "xai") {
    return XAI_MODEL_ALIASES[lower] ?? trimmed;
  }
  if (provider === "minimax" || provider === "minimax-cn" || provider === "minimax-portal") {
    return MINIMAX_MODEL_ALIASES[lower] ?? trimmed;
  }
  return trimmed;
}

function normalizeRequestedProviderModel(
  provider: string,
  modelId: string,
): {
  provider: string;
  modelId: string;
} {
  const providerTrimmed = provider.trim();
  const modelTrimmed = modelId.trim();

  // Recover from malformed provider values accidentally containing a model id:
  // "xai/grok-4.1-fast" + "grok-4.1-fast" -> provider "xai".
  const slash = providerTrimmed.indexOf("/");
  const providerBase = slash > 0 ? providerTrimmed.slice(0, slash) : providerTrimmed;
  const normalizedProvider = normalizeProviderId(providerBase);
  const normalizedModelId = normalizeModelIdForProvider(normalizedProvider, modelTrimmed);
  return { provider: normalizedProvider, modelId: normalizedModelId };
}

export function resolveModel(
  provider: string,
  modelId: string,
  agentDir?: string,
  cfg?: OpenClawConfig,
): {
  model?: Model<Api>;
  error?: string;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
} {
  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
  const authStorage = discoverAuthStorage(resolvedAgentDir);
  const modelRegistry = discoverModels(authStorage, resolvedAgentDir);
  const requested = normalizeRequestedProviderModel(provider, modelId);
  const model = modelRegistry.find(requested.provider, requested.modelId) as Model<Api> | null;
  if (!model) {
    const providers = cfg?.models?.providers ?? {};
    const inlineModels = buildInlineProviderModels(providers);
    const normalizedProvider = requested.provider;
    const normalizedModelId = requested.modelId;
    const inlineMatch = inlineModels.find(
      (entry) =>
        normalizeProviderId(entry.provider) === normalizedProvider &&
        normalizeModelIdForProvider(normalizedProvider, entry.id) === normalizedModelId,
    );
    if (inlineMatch) {
      const normalized = normalizeModelCompat(inlineMatch as Model<Api>);
      return {
        model: normalized,
        authStorage,
        modelRegistry,
      };
    }
    // Forward-compat fallbacks must be checked BEFORE the generic providerCfg fallback.
    // Otherwise, configured providers can default to a generic API and break specific transports.
    const forwardCompat = resolveForwardCompatModel(
      normalizedProvider,
      normalizedModelId,
      modelRegistry,
    );
    if (forwardCompat) {
      return { model: forwardCompat, authStorage, modelRegistry };
    }
    const providerCfg = findNormalizedProviderValue(providers, normalizedProvider);
    if (providerCfg || normalizedModelId.startsWith("mock-")) {
      const fallbackModel: Model<Api> = normalizeModelCompat({
        id: normalizedModelId,
        name: normalizedModelId,
        api: providerCfg?.api ?? "openai-responses",
        provider: normalizedProvider,
        baseUrl: providerCfg?.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: providerCfg?.models?.[0]?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
        maxTokens: providerCfg?.models?.[0]?.maxTokens ?? DEFAULT_CONTEXT_TOKENS,
      } as Model<Api>);
      return { model: fallbackModel, authStorage, modelRegistry };
    }
    return {
      error: buildUnknownModelError(normalizedProvider, normalizedModelId),
      authStorage,
      modelRegistry,
    };
  }
  return { model: normalizeModelCompat(model), authStorage, modelRegistry };
}

/**
 * Build a more helpful error when the model is not found.
 *
 * Local providers (ollama, vllm) need a dummy API key to be registered.
 * Users often configure `agents.defaults.model.primary: "ollama/…"` but
 * forget to set `OLLAMA_API_KEY`, resulting in a confusing "Unknown model"
 * error.  This detects known providers that require opt-in auth and adds
 * a hint.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
const LOCAL_PROVIDER_HINTS: Record<string, string> = {
  ollama:
    "Ollama requires authentication to be registered as a provider. " +
    'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/ollama",
  vllm:
    "vLLM requires authentication to be registered as a provider. " +
    'Set VLLM_API_KEY (any value works) or run "openclaw configure". ' +
    "See: https://docs.openclaw.ai/providers/vllm",
};

function buildUnknownModelError(provider: string, modelId: string): string {
  const base = `Unknown model: ${provider}/${modelId}`;
  const hint = LOCAL_PROVIDER_HINTS[provider.toLowerCase()];
  return hint ? `${base}. ${hint}` : base;
}
