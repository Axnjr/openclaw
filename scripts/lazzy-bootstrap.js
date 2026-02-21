import fs from "fs";
import path from "path";

// This script runs before the gateway starts to ensure any injected
// environment variables (like OPENCLAW_MODEL) are properly populated into openclaw.json
// since OpenClaw's model resolution expects it to be in the config file.

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

const model = process.env.OPENCLAW_MODEL || process.env.OPENCLAW_PRIMARY_MODEL;

if (model) {
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = config.agents.defaults.model || {};
  config.agents.defaults.model.primary = model;

  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`[Bootstrap] Configured primary model to: ${model}`);
} else {
  console.log(`[Bootstrap] No OPENCLAW_MODEL found in environment, proceeding with defaults.`);
}
