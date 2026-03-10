import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";

export const HOSTED_AGENT_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "KIMI_API_KEY",
  "MINIMAX_API_KEY",
  "QWEN_PORTAL_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
] as const;

export type HostedAgentSecretName = (typeof HOSTED_AGENT_SECRET_NAMES)[number];

const secretCache = new Map<HostedAgentSecretName, string>();
const pendingFetches = new Map<HostedAgentSecretName, Promise<string | null>>();

function normalizeSecretProxyUrl(): string | null {
  const raw = normalizeOptionalSecretInput(process.env.OPENCLAW_SECRET_PROXY_URL);
  if (!raw) {
    return null;
  }
  return raw.replace(/\/$/, "");
}

function normalizeGatewayToken(): string | null {
  return normalizeOptionalSecretInput(process.env.OPENCLAW_GATEWAY_TOKEN) ?? null;
}

export function isHostedAgentSecretName(value: string): value is HostedAgentSecretName {
  return HOSTED_AGENT_SECRET_NAMES.includes(value as HostedAgentSecretName);
}

export async function fetchHostedAgentSecret(
  secretName: HostedAgentSecretName,
): Promise<string | null> {
  const cached = secretCache.get(secretName);
  if (cached) {
    return cached;
  }

  const pending = pendingFetches.get(secretName);
  if (pending) {
    return await pending;
  }

  const request = (async () => {
    const url = normalizeSecretProxyUrl();
    const gatewayToken = normalizeGatewayToken();
    if (!url || !gatewayToken) {
      return null;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify({ keys: [secretName] }),
    });
    if (!res.ok) {
      throw new Error(`secret proxy request failed (${res.status})`);
    }

    const body = (await res.json()) as {
      secrets?: Partial<Record<HostedAgentSecretName, unknown>>;
    };
    const resolved = normalizeOptionalSecretInput(body.secrets?.[secretName]);
    if (resolved) {
      secretCache.set(secretName, resolved);
      return resolved;
    }
    return null;
  })();

  pendingFetches.set(secretName, request);
  try {
    return await request;
  } finally {
    pendingFetches.delete(secretName);
  }
}

export function sanitizeChildProcessEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of [
    ...HOSTED_AGENT_SECRET_NAMES,
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "OPENCLAW_SECRET_PROXY_URL",
  ]) {
    delete sanitized[key];
  }
  return sanitized;
}

export function resetHostedAgentSecretCacheForTests(): void {
  secretCache.clear();
  pendingFetches.clear();
}
