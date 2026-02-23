import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR || "/app/.openclaw";
const configPath = path.join(stateDir, "openclaw.json");
const buildInfoPath = path.join(process.cwd(), "dist", "build-info.json");

function readBuildInfo() {
  if (!fs.existsSync(buildInfoPath)) {
    return { version: null, commit: null, builtAt: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
    return {
      version: typeof parsed?.version === "string" ? parsed.version : null,
      commit: typeof parsed?.commit === "string" ? parsed.commit : null,
      builtAt: typeof parsed?.builtAt === "string" ? parsed.builtAt : null,
    };
  } catch {
    return { version: null, commit: null, builtAt: null };
  }
}

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error("[Bootstrap] Failed to parse existing openclaw.json", e);
  }
}

const buildInfo = readBuildInfo();
const runtimeFingerprint = {
  imageIdentifier: process.env.OPENCLAW_IMAGE_IDENTIFIER?.trim() || "unset",
  buildVersion: buildInfo.version ?? "unknown",
  buildCommit: buildInfo.commit ?? "unknown",
  buildBuiltAt: buildInfo.builtAt ?? "unknown",
  railwayDeploymentId: process.env.RAILWAY_DEPLOYMENT_ID?.trim() || "unknown",
  railwayServiceId: process.env.RAILWAY_SERVICE_ID?.trim() || "unknown",
};
console.log("[Bootstrap] Runtime fingerprint", runtimeFingerprint);

function parseTrustedProxies(rawValue) {
  if (typeof rawValue !== "string") {
    return [];
  }

  const trimmed = rawValue.trim();
  if (!trimmed) {
    return [];
  }

  const parseCsv = (value) =>
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

  if (!trimmed.startsWith("[")) {
    return parseCsv(trimmed);
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    console.warn("[Bootstrap] trusted proxy JSON is not an array, falling back to CSV parsing.");
    return parseCsv(trimmed);
  } catch {
    console.warn("[Bootstrap] Failed to parse trusted proxy JSON, falling back to CSV parsing.");
    return parseCsv(trimmed);
  }
}

const trustedProxiesRaw =
  process.env.OPENCLAW_BOOTSTRAP_TRUSTED_PROXIES || process.env.OPENCLAW_TRUSTED_PROXIES;
const trustedProxies = parseTrustedProxies(trustedProxiesRaw);

// The mobile app connects as openclaw-control-ui to bypass device pairing
// when deployed to Railway. We need to explicitly allow this bypass in the config.
const gatewayConfig = {
  controlUi: {
    dangerouslyDisableDeviceAuth: true,
    allowInsecureAuth: true,
  },
};

if (trustedProxies.length > 0) {
  gatewayConfig.trustedProxies = trustedProxies;
  console.log(`[Bootstrap] Configured gateway.trustedProxies: ${trustedProxies.join(", ")}`);
}

config.gateway = { ...config.gateway, ...gatewayConfig };

const model = process.env.OPENCLAW_MODEL || process.env.OPENCLAW_PRIMARY_MODEL;

if (model) {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.primary = model;
  console.log(`[Bootstrap] Configured primary model to: ${model}`);
} else {
  console.log("[Bootstrap] No OPENCLAW_MODEL found in environment, proceeding with defaults.");
}

if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log("[Bootstrap] Runtime fingerprint (post-config)", runtimeFingerprint);
console.log("[Bootstrap] Injected proxy authorization bypass config into openclaw.json");
