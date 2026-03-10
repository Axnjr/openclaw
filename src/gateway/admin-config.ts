import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadConfig, writeConfigFile } from "../config/config.js";
import { upsertSharedEnvVar } from "../infra/env-file.js";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { getHeader } from "./http-utils.js";

const MAX_BODY_BYTES = 32_768;
const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_KEYS = new Set([
  "OPENCLAW_MODEL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "USD_PER_CREDIT",
]);

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function ensureModelPrimaryConfig(cfg: OpenClawConfig): OpenClawConfig {
  cfg.agents = cfg.agents ?? {};
  cfg.agents.defaults = cfg.agents.defaults ?? {};
  cfg.agents.defaults.model = cfg.agents.defaults.model ?? {};
  return cfg;
}

export async function handleAdminConfigRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/admin/config") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  const expectedSecret = process.env.ADMIN_AUTH_SECRET?.trim();
  if (!expectedSecret) {
    sendJson(res, 503, { ok: false, error: "ADMIN_AUTH_SECRET is not configured" });
    return true;
  }

  const providedSecret = getHeader(req, "x-admin-auth-secret")?.trim();
  if (!providedSecret || !safeEqualSecret(providedSecret, expectedSecret)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return true;
  }

  const body = await readJsonBodyWithLimit(req, {
    maxBytes: MAX_BODY_BYTES,
    emptyObjectOnEmpty: false,
  });
  if (!body.ok) {
    if (body.code === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { ok: false, error: "Payload too large" });
      return true;
    }
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  if (!body.value || typeof body.value !== "object" || Array.isArray(body.value)) {
    sendJson(res, 400, { ok: false, error: "Request body must be a JSON object" });
    return true;
  }

  const updatesRaw = (body.value as { updates?: unknown }).updates;
  if (!updatesRaw || typeof updatesRaw !== "object" || Array.isArray(updatesRaw)) {
    sendJson(res, 400, { ok: false, error: "updates must be an object" });
    return true;
  }

  const updates = Object.entries(updatesRaw);
  if (updates.length === 0) {
    sendJson(res, 400, { ok: false, error: "updates must contain at least one key" });
    return true;
  }

  const normalizedUpdates = new Map<string, string>();
  for (const [key, value] of updates) {
    if (!ENV_VAR_KEY_RE.test(key)) {
      sendJson(res, 400, {
        ok: false,
        error: `Invalid env var key: ${key}`,
      });
      return true;
    }
    if (!ALLOWED_KEYS.has(key)) {
      sendJson(res, 403, {
        ok: false,
        error: `Key is not allowed: ${key}`,
      });
      return true;
    }
    if (typeof value !== "string" || value.trim().length === 0) {
      sendJson(res, 400, {
        ok: false,
        error: `Invalid value for key: ${key}`,
      });
      return true;
    }
    normalizedUpdates.set(key, value.trim());
  }

  try {
    let persistedPath = "";
    for (const [key, value] of normalizedUpdates) {
      process.env[key] = value;
      const persisted = upsertSharedEnvVar({ key, value });
      persistedPath = persisted.path;
    }

    let configPatched = false;
    const modelOverride = normalizedUpdates.get("OPENCLAW_MODEL");
    if (modelOverride) {
      const cfg = ensureModelPrimaryConfig(loadConfig());
      const modelConfig = cfg.agents?.defaults?.model;
      if (modelConfig) {
        modelConfig.primary = modelOverride;
      }
      await writeConfigFile(cfg);
      configPatched = true;
    }

    sendJson(res, 200, {
      ok: true,
      applied: Array.from(normalizedUpdates.keys()),
      persistedPath,
      configPatched,
    });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: `Failed to apply admin config: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return true;
}
