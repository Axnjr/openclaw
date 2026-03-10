import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./auth-profiles.js";
import {
  requireApiKey,
  resolveApiKeyForProvider,
  resolveAwsSdkEnvVarName,
  resolveModelAuthMode,
} from "./model-auth.js";
import { resetHostedAgentSecretCacheForTests } from "./secret-proxy.js";

const previousSecretProxyUrl = process.env.OPENCLAW_SECRET_PROXY_URL;
const previousGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  resetHostedAgentSecretCacheForTests();
  if (previousSecretProxyUrl === undefined) {
    delete process.env.OPENCLAW_SECRET_PROXY_URL;
  } else {
    process.env.OPENCLAW_SECRET_PROXY_URL = previousSecretProxyUrl;
  }
  if (previousGatewayToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = previousGatewayToken;
  }
});

describe("resolveAwsSdkEnvVarName", () => {
  it("prefers bearer token over access keys and profile", () => {
    const env = {
      AWS_BEARER_TOKEN_BEDROCK: "bearer",
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_BEARER_TOKEN_BEDROCK");
  });

  it("uses access keys when bearer token is missing", () => {
    const env = {
      AWS_ACCESS_KEY_ID: "access",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_ACCESS_KEY_ID");
  });

  it("uses profile when no bearer token or access keys exist", () => {
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;

    expect(resolveAwsSdkEnvVarName(env)).toBe("AWS_PROFILE");
  });

  it("returns undefined when no AWS auth env is set", () => {
    expect(resolveAwsSdkEnvVarName({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("resolveModelAuthMode", () => {
  it("returns mixed when provider has both token and api key profiles", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:token": {
          type: "token",
          provider: "openai",
          token: "token-value",
        },
        "openai:key": {
          type: "api_key",
          provider: "openai",
          key: "api-key",
        },
      },
    };

    expect(resolveModelAuthMode("openai", undefined, store)).toBe("mixed");
  });

  it("returns aws-sdk when provider auth is overridden", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        {
          models: {
            providers: {
              "amazon-bedrock": {
                baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
                models: [],
                auth: "aws-sdk",
              },
            },
          },
        },
        { version: 1, profiles: {} },
      ),
    ).toBe("aws-sdk");
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const key = requireApiKey(
      {
        apiKey: "\n sk-test-abc\r\n",
        source: "env: OPENAI_API_KEY",
        mode: "api-key",
      },
      "openai",
    );

    expect(key).toBe("sk-test-abc");
  });

  it("throws when no API key is present", () => {
    expect(() =>
      requireApiKey(
        {
          source: "env: OPENAI_API_KEY",
          mode: "api-key",
        },
        "openai",
      ),
    ).toThrow('No API key resolved for provider "openai"');
  });
});

describe("secret proxy auth", () => {
  it("resolves hosted provider keys from the secret proxy", async () => {
    process.env.OPENCLAW_SECRET_PROXY_URL = "https://control.example.com/api/agent/secrets";
    process.env.OPENCLAW_GATEWAY_TOKEN = "gateway-token";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            secrets: {
              OPENAI_API_KEY: "proxied-openai-key",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const resolved = await resolveApiKeyForProvider({
      provider: "openai",
      store: { version: 1, profiles: {} },
    });

    expect(resolved.apiKey).toBe("proxied-openai-key");
    expect(resolved.source).toBe("secret-proxy: OPENAI_API_KEY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
