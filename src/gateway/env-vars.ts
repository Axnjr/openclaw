import type { IncomingMessage, ServerResponse } from "node:http";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ResolvedGatewayAuth } from "./auth.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { ENV_VARS_HKDF_INFO } from "./env-vars-constants.js";
import { getBearerToken } from "./http-utils.js";

const ENV_VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_BODY_BYTES = 32_768; // 32 KB

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Derives a 32-byte AES key from the gateway bearer token using HKDF-SHA256.
 * node:crypto hkdfSync(digest, ikm, salt, info, keylen)
 * salt = "" (empty), info = ENV_VARS_HKDF_INFO — must match mobile @noble derivation.
 */
function deriveAesKey(gatewayToken: string): Buffer {
  return Buffer.from(hkdfSync("sha256", gatewayToken, "", ENV_VARS_HKDF_INFO, 32));
}

/**
 * Decrypts an AES-256-GCM ciphertext that was produced by the mobile client.
 *
 * Wire format (base64-encoded):
 *   [12-byte IV] [N-byte ciphertext] [16-byte auth tag]
 */
function decryptEnvValue(encryptedBase64: string, gatewayToken: string): string {
  const buf = Buffer.from(encryptedBase64, "base64");
  if (buf.length < 12 + 16) {
    throw new Error("Encrypted value too short");
  }

  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);

  const key = deriveAesKey(gatewayToken);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

/**
 * Writes / updates a single key=value pair in the .env file located in the
 * gateway's working directory. Creates the file if it doesn't exist.
 */
function persistToEnvFile(key: string, value: string): void {
  const envPath = resolve(process.cwd(), ".env");
  let lines: string[] = [];

  if (existsSync(envPath)) {
    const raw = readFileSync(envPath, "utf8");
    lines = raw.split("\n");
  }

  // Remove any existing declaration for this key.
  const prefix = `${key}=`;
  lines = lines.filter((line) => !line.startsWith(prefix));

  // Append the new value. Escape newlines in the value by quoting it.
  const safeValue = value.includes("\n") ? JSON.stringify(value) : value;
  lines.push(`${key}=${safeValue}`);

  // Trim trailing blank lines then add a single trailing newline.
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
}

/**
 * Handles POST /api/env
 *
 * Expected JSON body:
 *   { key: string, encryptedValue: string }
 *
 * `encryptedValue` is base64(IV[12] + ciphertext + authTag[16]) encrypted
 * with AES-256-GCM using a key derived from the gateway bearer token via
 * HKDF-SHA256 (salt="", info=ENV_VARS_HKDF_INFO).
 */
export async function handleEnvVarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    resolvedAuth: ResolvedGatewayAuth;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/env") {
    return false;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end("Method Not Allowed");
    return true;
  }

  // --- Auth ---
  const { resolvedAuth } = opts;
  const expectedToken = resolvedAuth.token ?? resolvedAuth.password;
  if (!expectedToken) {
    sendJson(res, 503, { ok: false, error: "Gateway auth not configured" });
    return true;
  }
  const bearerToken = getBearerToken(req);
  if (!bearerToken || !safeEqualSecret(bearerToken, expectedToken)) {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return true;
  }

  // --- Parse body ---
  let rawBody = "";
  try {
    rawBody = await new Promise<string>((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("Payload too large"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  } catch {
    sendJson(res, 413, { ok: false, error: "Payload too large" });
    return true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error("Expected JSON object");
    }
  } catch {
    sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
    return true;
  }

  const { key, encryptedValue } = body as { key?: unknown; encryptedValue?: unknown };

  if (typeof key !== "string" || !ENV_VAR_KEY_RE.test(key)) {
    sendJson(res, 400, {
      ok: false,
      error: "Invalid env var key. Must match /^[A-Za-z_][A-Za-z0-9_]*$/",
    });
    return true;
  }

  if (typeof encryptedValue !== "string" || encryptedValue.trim().length === 0) {
    sendJson(res, 400, { ok: false, error: "encryptedValue is required" });
    return true;
  }

  // --- Decrypt ---
  let plainValue: string;
  try {
    plainValue = decryptEnvValue(encryptedValue.trim(), expectedToken);
  } catch {
    sendJson(res, 400, {
      ok: false,
      error: "Failed to decrypt value. Check that the gateway token matches.",
    });
    return true;
  }

  // --- Apply ---
  try {
    process.env[key] = plainValue;
    persistToEnvFile(key, plainValue);
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: "Failed to persist env var: " + (err instanceof Error ? err.message : String(err)),
    });
    return true;
  }

  sendJson(res, 200, { ok: true, key });
  return true;
}
