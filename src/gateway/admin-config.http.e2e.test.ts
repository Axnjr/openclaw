import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveConfigDir } from "../utils.js";
import { installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway admin config HTTP endpoint", () => {
  const previousAdminAuthSecret = process.env.ADMIN_AUTH_SECRET;
  const previousOpenClawModel = process.env.OPENCLAW_MODEL;
  const previousGeminiApiKey = process.env.GEMINI_API_KEY;
  const previousGoogleApiKey = process.env.GOOGLE_API_KEY;
  const previousUsdPerCredit = process.env.USD_PER_CREDIT;

  beforeEach(() => {
    process.env.ADMIN_AUTH_SECRET = "test-admin-secret";
    delete process.env.OPENCLAW_MODEL;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.USD_PER_CREDIT;
  });

  afterEach(async () => {
    if (previousAdminAuthSecret === undefined) {
      delete process.env.ADMIN_AUTH_SECRET;
    } else {
      process.env.ADMIN_AUTH_SECRET = previousAdminAuthSecret;
    }
    if (previousOpenClawModel === undefined) {
      delete process.env.OPENCLAW_MODEL;
    } else {
      process.env.OPENCLAW_MODEL = previousOpenClawModel;
    }
    if (previousGeminiApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = previousGeminiApiKey;
    }
    if (previousGoogleApiKey === undefined) {
      delete process.env.GOOGLE_API_KEY;
    } else {
      process.env.GOOGLE_API_KEY = previousGoogleApiKey;
    }
    if (previousUsdPerCredit === undefined) {
      delete process.env.USD_PER_CREDIT;
    } else {
      process.env.USD_PER_CREDIT = previousUsdPerCredit;
    }

    const envPath = path.join(resolveConfigDir(process.env), ".env");
    await fs.rm(envPath, { force: true });
  });

  test("returns 401 when admin auth header is missing or invalid", async () => {
    await withGatewayServer(async ({ port }) => {
      const missing = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: {
            GEMINI_API_KEY: "gem-key",
          },
        }),
      });
      expect(missing.status).toBe(401);

      const invalid = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "wrong-secret",
        },
        body: JSON.stringify({
          updates: {
            GEMINI_API_KEY: "gem-key",
          },
        }),
      });
      expect(invalid.status).toBe(401);
    });
  });

  test("returns 503 when ADMIN_AUTH_SECRET is not configured", async () => {
    delete process.env.ADMIN_AUTH_SECRET;

    await withGatewayServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "any",
        },
        body: JSON.stringify({ updates: { GEMINI_API_KEY: "gem-key" } }),
      });
      expect(res.status).toBe(503);
    });
  });

  test("returns 400 for invalid JSON and malformed payloads", async () => {
    await withGatewayServer(async ({ port }) => {
      const invalidJson = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "test-admin-secret",
        },
        body: "{",
      });
      expect(invalidJson.status).toBe(400);

      const invalidUpdates = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "test-admin-secret",
        },
        body: JSON.stringify({ updates: [] }),
      });
      expect(invalidUpdates.status).toBe(400);
    });
  });

  test("returns 403 for non-allowlisted keys", async () => {
    await withGatewayServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "test-admin-secret",
        },
        body: JSON.stringify({
          updates: {
            OPENAI_API_KEY: "not-allowed",
          },
        }),
      });
      expect(res.status).toBe(403);
    });
  });

  test("applies env updates, persists shared .env, and patches OPENCLAW_MODEL in config", async () => {
    await withGatewayServer(async ({ port }) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/admin/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-auth-secret": "test-admin-secret",
        },
        body: JSON.stringify({
          updates: {
            OPENCLAW_MODEL: "google/gemini-3-pro",
            GEMINI_API_KEY: "gem-key-123",
            GOOGLE_API_KEY: "google-key-456",
            USD_PER_CREDIT: "0.02",
          },
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        applied: string[];
        persistedPath: string;
        configPatched: boolean;
      };
      expect(body.ok).toBe(true);
      expect(body.applied).toEqual([
        "OPENCLAW_MODEL",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "USD_PER_CREDIT",
      ]);
      expect(body.configPatched).toBe(true);
      expect(body.persistedPath).toBe(path.join(resolveConfigDir(process.env), ".env"));

      expect(process.env.OPENCLAW_MODEL).toBe("google/gemini-3-pro");
      expect(process.env.GEMINI_API_KEY).toBe("gem-key-123");
      expect(process.env.GOOGLE_API_KEY).toBe("google-key-456");
      expect(process.env.USD_PER_CREDIT).toBe("0.02");

      const persistedEnv = await fs.readFile(body.persistedPath, "utf-8");
      expect(persistedEnv).toContain("OPENCLAW_MODEL=google/gemini-3-pro");
      expect(persistedEnv).toContain("GEMINI_API_KEY=gem-key-123");
      expect(persistedEnv).toContain("GOOGLE_API_KEY=google-key-456");
      expect(persistedEnv).toContain("USD_PER_CREDIT=0.02");

      const snapshot = await readConfigFileSnapshot();
      const config = snapshot.config as {
        agents?: { defaults?: { model?: { primary?: string } } };
      };
      expect(config.agents?.defaults?.model?.primary).toBe("google/gemini-3-pro");
    });
  });
});
