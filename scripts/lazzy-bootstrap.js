import fs from "node:fs";
import path from "node:path";

const stateDir = process.env.OPENCLAW_STATE_DIR || "/app/.openclaw";
const configPath = path.join(stateDir, "openclaw.json");

let config = {};
if (fs.existsSync(configPath)) {
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    console.error("[Bootstrap] Failed to parse existing openclaw.json", e);
  }
}

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
  console.log(`[Bootstrap] No OPENCLAW_MODEL found in environment, proceeding with defaults.`);
}

if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir, { recursive: true });
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`[Bootstrap] Injected proxy authorization bypass config into openclaw.json`);
