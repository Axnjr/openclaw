const fs = require("fs");
const path = require("path");

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

// The mobile app connects as openclaw-control-ui to bypass device pairing
// when deployed to Railway. We need to explicitly allow this bypass in the config.
const gatewayConfig = {
  controlUi: {
    dangerouslyDisableDeviceAuth: true,
    allowInsecureAuth: true,
  },
};

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
