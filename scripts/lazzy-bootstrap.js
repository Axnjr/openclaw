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

function ensureAgentsDefaults() {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    config = {};
  }
  config.agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  config.agents.defaults =
    config.agents.defaults && typeof config.agents.defaults === "object"
      ? config.agents.defaults
      : {};
  return config.agents.defaults;
}

function resolveFallbackWorkspaceDir() {
  const rawHome =
    process.env.OPENCLAW_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    "/home/node";
  const homeDir = rawHome.startsWith("~")
    ? rawHome.replace(/^~(?=$|[\\/])/, process.env.HOME?.trim() || "/home/node")
    : rawHome;
  return path.join(path.resolve(homeDir), ".openclaw", "workspace");
}

function resolveUserPath(input) {
  const trimmed = typeof input === "string" ? input.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("~")) {
    const homeDir =
      process.env.OPENCLAW_HOME?.trim() ||
      process.env.HOME?.trim() ||
      process.env.USERPROFILE?.trim() ||
      "/home/node";
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, homeDir));
  }
  return path.resolve(trimmed);
}

function resolveConfiguredWorkspaceDir() {
  if (
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    config.agents &&
    typeof config.agents === "object" &&
    config.agents.defaults &&
    typeof config.agents.defaults === "object" &&
    typeof config.agents.defaults.workspace === "string"
  ) {
    const resolved = resolveUserPath(config.agents.defaults.workspace);
    if (resolved) {
      return resolved;
    }
  }
  return "";
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
console.log(
  "\n\n\n[Bootstrap] WITH SOUL, IDENTITY & USER PROMPTS FEATURE ADDITIONS: Sun 1st March 2026",
  process.env.OPENCLAW_MODEL,
  "\n\n\n",
);
console.log(`[Bootstrap] 🚀 Starting OpenClaw Gateway (${runtimeFingerprint.imageIdentifier})`);
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

const workspaceDirFromEnv = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || "";
const configuredWorkspaceDir = resolveConfiguredWorkspaceDir();
const effectiveWorkspaceDir = workspaceDirFromEnv
  ? resolveUserPath(workspaceDirFromEnv)
  : configuredWorkspaceDir || resolveFallbackWorkspaceDir();

if (workspaceDirFromEnv) {
  const defaults = ensureAgentsDefaults();
  if (typeof defaults.workspace !== "string" || !defaults.workspace.trim()) {
    defaults.workspace = effectiveWorkspaceDir;
    console.log(
      `[Bootstrap] Set agents.defaults.workspace from OPENCLAW_WORKSPACE_DIR: ${effectiveWorkspaceDir}`,
    );
  }
}

if (!fs.existsSync(effectiveWorkspaceDir)) {
  fs.mkdirSync(effectiveWorkspaceDir, { recursive: true });
}
console.log(`[Bootstrap] Resolved effective workspace directory: ${effectiveWorkspaceDir}`);

const agentName = process.env.OPENCLAW_AGENT_NAME?.trim() || "";
const systemPrompt = process.env.OPENCLAW_SYSTEM_PROMPT?.trim() || "";
const identityPrompt = process.env.OPENCLAW_IDENTITY?.trim() || "";
const userPrompt = process.env.OPENCLAW_USER?.trim() || "";

if (agentName || systemPrompt || identityPrompt || userPrompt) {
  if (agentName || systemPrompt) {
    const soulPath = path.join(effectiveWorkspaceDir, "SOUL.md");
    const namePart = agentName ? `# ${agentName}\n\n` : "";
    fs.writeFileSync(soulPath, namePart + systemPrompt);
    console.log(
      `[Bootstrap] Wrote SOUL.md to ${soulPath} (name=${agentName || "(none)"}, prompt=${systemPrompt ? "yes" : "none"})`,
    );
  }

  if (identityPrompt) {
    const identityPath = path.join(effectiveWorkspaceDir, "IDENTITY.md");
    fs.writeFileSync(identityPath, identityPrompt);
    console.log(`[Bootstrap] Wrote IDENTITY.md to ${identityPath}`);
  }

  if (userPrompt) {
    const userPath = path.join(effectiveWorkspaceDir, "USER.md");
    fs.writeFileSync(userPath, userPrompt);
    console.log(`[Bootstrap] Wrote USER.md to ${userPath}`);
  }

  // Remove BOOTSTRAP.md so the agent starts from the user's SOUL instead of
  // treating the generic bootstrap directives as a higher-priority "birth certificate".
  // Only do this when a real personality was provided — agentName alone is always set
  // and doesn't indicate an intentional soul configuration.
  if (systemPrompt) {
    const bootstrapPath = path.join(effectiveWorkspaceDir, "BOOTSTRAP.md");
    if (fs.existsSync(bootstrapPath)) {
      fs.unlinkSync(bootstrapPath);
      console.log(`[Bootstrap] Removed BOOTSTRAP.md — agent will start from SOUL.md`);
    }
  }
} else {
  console.log(
    `\n\n\n[Bootstrap] No OPENCLAW_SYSTEM_PROMPT or OPENCLAW_AGENT_NAME found, proceeding with defaults. Workspace: ${effectiveWorkspaceDir}\n\n\n`,
  );
}

// Clean up any unrecognized keys from previous bootstrap versions before writing.
// Older Docker image versions wrote `agents.defaults.name` which is no longer valid.
if (config.agents?.defaults && typeof config.agents.defaults === "object") {
  delete config.agents.defaults.name;
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log("[Bootstrap] Runtime fingerprint (post-config)", runtimeFingerprint);
console.log("[Bootstrap] Injected proxy authorization bypass config into openclaw.json");
