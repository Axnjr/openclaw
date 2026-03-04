import type { NodeRegistry } from "./node-registry.js";
import { normalizeVerboseLevel } from "../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { loadConfig } from "../config/config.js";
import { type AgentEventPayload, getAgentRunContext } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  resolveApnsAuthConfigFromEnv,
  loadAllApnsRegistrations,
  sendApnsAlert,
} from "../infra/push-apns.js";
import { loadSessionEntry } from "./session-utils.js";
import {
  parseGatewayCreditsUsed,
  resolveGatewayUsageWithCredits,
  roundGatewayCredits,
  withUsageCredits,
} from "./usage-credits.js";
import { formatForLog } from "./ws-log.js";

// const DEBUG_GATEWAY_CREDITS = process.env.OPENCLAW_DEBUG_CREDITS === "1";

function debugGatewayCredits(label: string, payload: Record<string, unknown>) {
  // if (!DEBUG_GATEWAY_CREDITS) {
  //   return;
  // }
  console.log(`[GatewayCredits] ${label}`, payload);
}

/**
 * Check if webchat broadcasts should be suppressed for heartbeat runs.
 * Returns true if the run is a heartbeat and showOk is false.
 */
function shouldSuppressHeartbeatBroadcast(runId: string): boolean {
  const runContext = getAgentRunContext(runId);
  if (!runContext?.isHeartbeat) {
    return false;
  }

  try {
    const cfg = loadConfig();
    const visibility = resolveHeartbeatVisibility({ cfg, channel: "webchat" });
    return !visibility.showOk;
  } catch {
    // Default to suppressing if we can't load config
    return true;
  }
}

type JsonRecord = Record<string, unknown>;

type TerminalUsageSnapshot = {
  usage?: JsonRecord;
  creditsUsed: number;
  source: "explicit_credits" | "cost_derived" | "usage_fallback";
  explicitCredits?: number;
  costUsd?: number;
};

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

function ensureUsageWithCredits(
  usage: JsonRecord | undefined,
  creditsUsed: number,
  costUsd?: number,
): JsonRecord {
  const usageWithCredits =
    withUsageCredits(usage, creditsUsed) ??
    ({
      creditsUsed,
      credits_used: creditsUsed,
    } as JsonRecord);
  if (costUsd !== undefined && !asRecord(usageWithCredits.cost)) {
    usageWithCredits.cost = {
      total: costUsd,
      totalUsd: costUsd,
      usd: costUsd,
    };
  }
  return usageWithCredits;
}

function resolveTerminalUsageSnapshot(data: unknown): TerminalUsageSnapshot {
  const record = asRecord(data);
  const usageRaw = record?.usage;
  const usageSummary = resolveGatewayUsageWithCredits({
    usageRaw,
    provider: typeof record?.provider === "string" ? record.provider : undefined,
    model: typeof record?.model === "string" ? record.model : undefined,
  });
  const costUsd =
    asFiniteNumber(record?.costUsd) ?? asFiniteNumber(record?.cost_usd) ?? usageSummary.costUsd;
  const creditsFromCost = costUsd !== undefined ? roundGatewayCredits(costUsd / 0.01) : undefined;
  const explicitCredits =
    parseGatewayCreditsUsed(record?.creditsUsed) ?? parseGatewayCreditsUsed(record?.credits_used);
  const source =
    explicitCredits !== undefined
      ? "explicit_credits"
      : creditsFromCost !== undefined
        ? "cost_derived"
        : "usage_fallback";
  const creditsUsed = explicitCredits ?? creditsFromCost ?? usageSummary.creditsUsed;
  const baseUsage = usageSummary.usage ?? asRecord(usageRaw);
  const usage = ensureUsageWithCredits(baseUsage, creditsUsed, costUsd);
  return {
    usage,
    creditsUsed,
    source,
    explicitCredits,
    costUsd,
  };
}

export type ChatRunEntry = {
  sessionKey: string;
  clientRunId: string;
};

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunEntry) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
  clear: () => void;
};

export function createChatRunRegistry(): ChatRunRegistry {
  const chatRunSessions = new Map<string, ChatRunEntry[]>();

  const add = (sessionId: string, entry: ChatRunEntry) => {
    const queue = chatRunSessions.get(sessionId);
    if (queue) {
      queue.push(entry);
    } else {
      chatRunSessions.set(sessionId, [entry]);
    }
  };

  const peek = (sessionId: string) => chatRunSessions.get(sessionId)?.[0];

  const shift = (sessionId: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const queue = chatRunSessions.get(sessionId);
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      chatRunSessions.delete(sessionId);
    }
    return entry;
  };

  const clear = () => {
    chatRunSessions.clear();
  };

  return { add, peek, shift, remove, clear };
}

export type ChatRunState = {
  registry: ChatRunRegistry;
  buffers: Map<string, string>;
  deltaSentAt: Map<string, number>;
  abortedRuns: Map<string, number>;
  terminalUsageByRun: Map<string, TerminalUsageSnapshot>;
  clear: () => void;
};

export function createChatRunState(): ChatRunState {
  const registry = createChatRunRegistry();
  const buffers = new Map<string, string>();
  const deltaSentAt = new Map<string, number>();
  const abortedRuns = new Map<string, number>();
  const terminalUsageByRun = new Map<string, TerminalUsageSnapshot>();

  const clear = () => {
    registry.clear();
    buffers.clear();
    deltaSentAt.clear();
    abortedRuns.clear();
    terminalUsageByRun.clear();
  };

  return {
    registry,
    buffers,
    deltaSentAt,
    abortedRuns,
    terminalUsageByRun,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
};

type ToolRecipientEntry = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

export function createToolEventRecipientRegistry(): ToolEventRecipientRegistry {
  const recipients = new Map<string, ToolRecipientEntry>();

  const prune = () => {
    if (recipients.size === 0) {
      return;
    }
    const now = Date.now();
    for (const [runId, entry] of recipients) {
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        recipients.delete(runId);
      }
    }
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const existing = recipients.get(runId);
    if (existing) {
      existing.connIds.add(connId);
      existing.updatedAt = now;
    } else {
      recipients.set(runId, {
        connIds: new Set([connId]),
        updatedAt: now,
      });
    }
    prune();
  };

  const get = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return undefined;
    }
    entry.updatedAt = Date.now();
    prune();
    return entry.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = recipients.get(runId);
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune();
  };

  return { add, get, markFinal };
}

export type ChatEventBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

export type NodeSendToSession = (sessionKey: string, event: string, payload: unknown) => void;

export type AgentEventHandlerOptions = {
  broadcast: ChatEventBroadcast;
  broadcastToConnIds: (
    event: string,
    payload: unknown,
    connIds: ReadonlySet<string>,
    opts?: { dropIfSlow?: boolean },
  ) => void;
  nodeSendToSession: NodeSendToSession;
  agentRunSeq: Map<string, number>;
  chatRunState: ChatRunState;
  resolveSessionKeyForRun: (runId: string) => string | undefined;
  clearAgentRunContext: (runId: string) => void;
  toolEventRecipients: ToolEventRecipientRegistry;
  /** Optional: when provided, nodes that are currently connected via WebSocket will be skipped for push notifications. */
  nodeRegistry?: NodeRegistry;
};

export function createAgentEventHandler({
  broadcast,
  broadcastToConnIds,
  nodeSendToSession,
  agentRunSeq,
  chatRunState,
  resolveSessionKeyForRun,
  clearAgentRunContext,
  toolEventRecipients,
  nodeRegistry,
}: AgentEventHandlerOptions) {
  const emitChatDelta = (sessionKey: string, clientRunId: string, seq: number, text: string) => {
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return;
    }
    chatRunState.buffers.set(clientRunId, text);
    const now = Date.now();
    const last = chatRunState.deltaSentAt.get(clientRunId) ?? 0;
    if (now - last < 150) {
      return;
    }
    chatRunState.deltaSentAt.set(clientRunId, now);
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "delta" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: now,
      },
    };
    // Suppress webchat broadcast for heartbeat runs when showOk is false
    if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
      broadcast("chat", payload, { dropIfSlow: true });
    }
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const emitChatFinal = (
    sessionKey: string,
    clientRunId: string,
    seq: number,
    jobState: "done" | "error",
    sourceRunId: string,
    error?: unknown,
  ) => {
    const text = chatRunState.buffers.get(clientRunId)?.trim() ?? "";
    const shouldSuppressSilent = isSilentReplyText(text, SILENT_REPLY_TOKEN);
    const terminalUsage =
      chatRunState.terminalUsageByRun.get(sourceRunId) ??
      chatRunState.terminalUsageByRun.get(clientRunId);
    const creditsUsed = terminalUsage?.creditsUsed ?? 0;
    const usage = terminalUsage?.usage;
    debugGatewayCredits("chat_final_emit", {
      runId: clientRunId,
      sourceRunId,
      sessionKey,
      jobState,
      creditsUsed,
      terminalSource: terminalUsage?.source ?? "none",
      explicitCredits: terminalUsage?.explicitCredits ?? null,
      costUsd: terminalUsage?.costUsd ?? null,
      hasUsage: Boolean(usage),
      hasText: Boolean(text && !shouldSuppressSilent),
    });
    chatRunState.buffers.delete(clientRunId);
    chatRunState.deltaSentAt.delete(clientRunId);
    chatRunState.terminalUsageByRun.delete(sourceRunId);
    chatRunState.terminalUsageByRun.delete(clientRunId);
    if (jobState === "done") {
      const usageWithCredits = ensureUsageWithCredits(usage, creditsUsed, terminalUsage?.costUsd);
      const payload = {
        runId: clientRunId,
        sessionKey,
        seq,
        state: "final" as const,
        usage: usageWithCredits,
        creditsUsed,
        credits_used: creditsUsed,
        message:
          text && !shouldSuppressSilent
            ? {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
                usage: usageWithCredits,
              }
            : undefined,
      };
      // Suppress webchat broadcast for heartbeat runs when showOk is false
      if (!shouldSuppressHeartbeatBroadcast(clientRunId)) {
        broadcast("chat", payload);
      }
      nodeSendToSession(sessionKey, "chat", payload);

      if (text && !shouldSuppressSilent) {
        setImmediate(() => {
          void (async () => {
            try {
              const registrations = await loadAllApnsRegistrations();
              if (registrations.length === 0) {
                return;
              }
              const auth = await resolveApnsAuthConfigFromEnv(process.env);
              if (!auth.ok) {
                return;
              }
              const agentName = process.env.OPENCLAW_AGENT_NAME || "Agent";
              const title = `${agentName} needs your attention.`;
              const body = text.length > 100 ? text.slice(0, 97) + "..." : text;
              // Only push to nodes that are NOT currently connected via WebSocket.
              // If the node is connected, the app is in the foreground and already
              // received the message via the live socket — no push needed.
              const offlineRegistrations = nodeRegistry
                ? registrations.filter((r) => !nodeRegistry.get(r.nodeId))
                : registrations;
              if (offlineRegistrations.length === 0) {
                return;
              }
              await Promise.allSettled(
                offlineRegistrations.map(async (registration) => {
                  try {
                    await sendApnsAlert({
                      auth: auth.value,
                      registration,
                      nodeId: registration.nodeId,
                      title,
                      body,
                    });
                  } catch (err) {
                    console.warn(
                      `[push-apns] Failed to auto-push to ${registration.nodeId}: \n${JSON.stringify(err, null, 4)}`,
                    );
                  }
                }),
              );
            } catch (err) {
              console.warn(
                `[push-apns] Failed to auto-push chat message: \n${JSON.stringify(err, null, 4)}`,
              );
            }
          })();
        });
      }

      return;
    }
    const payload = {
      runId: clientRunId,
      sessionKey,
      seq,
      state: "error" as const,
      errorMessage: error ? formatForLog(error) : undefined,
    };
    broadcast("chat", payload);
    nodeSendToSession(sessionKey, "chat", payload);
  };

  const resolveToolVerboseLevel = (runId: string, sessionKey?: string) => {
    const runContext = getAgentRunContext(runId);
    const runVerbose = normalizeVerboseLevel(runContext?.verboseLevel);
    if (runVerbose) {
      return runVerbose;
    }
    if (!sessionKey) {
      return "off";
    }
    try {
      const { cfg, entry } = loadSessionEntry(sessionKey);
      const sessionVerbose = normalizeVerboseLevel(entry?.verboseLevel);
      if (sessionVerbose) {
        return sessionVerbose;
      }
      const defaultVerbose = normalizeVerboseLevel(cfg.agents?.defaults?.verboseDefault);
      return defaultVerbose ?? "off";
    } catch {
      return "off";
    }
  };

  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
    const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
    const last = agentRunSeq.get(evt.runId) ?? 0;
    const isToolEvent = evt.stream === "tool";
    const toolVerbose = isToolEvent ? resolveToolVerboseLevel(evt.runId, sessionKey) : "off";
    // Build tool payload: strip result/partialResult unless verbose=full
    const toolPayload =
      isToolEvent && toolVerbose !== "full"
        ? (() => {
            const data = evt.data ? { ...evt.data } : {};
            delete data.result;
            delete data.partialResult;
            return sessionKey
              ? { ...eventForClients, sessionKey, data }
              : { ...eventForClients, data };
          })()
        : agentPayload;
    if (evt.seq !== last + 1) {
      broadcast("agent", {
        runId: eventRunId,
        stream: "error",
        ts: Date.now(),
        sessionKey,
        data: {
          reason: "seq gap",
          expected: last + 1,
          received: evt.seq,
        },
      });
    }
    agentRunSeq.set(evt.runId, evt.seq);
    if (isToolEvent) {
      // Always broadcast tool events to registered WS recipients with
      // tool-events capability, regardless of verboseLevel. The verbose
      // setting only controls whether tool details are sent as channel
      // messages to messaging surfaces (Telegram, Discord, etc.).
      const recipients = toolEventRecipients.get(evt.runId);
      if (recipients && recipients.size > 0) {
        broadcastToConnIds("agent", toolPayload, recipients);
      }
    } else {
      broadcast("agent", agentPayload);
    }

    const lifecyclePhase =
      evt.stream === "lifecycle" && typeof evt.data?.phase === "string" ? evt.data.phase : null;
    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      const terminalUsage = resolveTerminalUsageSnapshot(evt.data);
      chatRunState.terminalUsageByRun.set(evt.runId, terminalUsage);
      chatRunState.terminalUsageByRun.set(clientRunId, terminalUsage);
      debugGatewayCredits("lifecycle_terminal_snapshot", {
        runId: evt.runId,
        clientRunId,
        sessionKey,
        phase: lifecyclePhase,
        creditsUsed: terminalUsage.creditsUsed,
        source: terminalUsage.source,
        explicitCredits: terminalUsage.explicitCredits ?? null,
        costUsd: terminalUsage.costUsd ?? null,
        hasUsage: Boolean(terminalUsage.usage),
      });
    }

    if (sessionKey) {
      // Send tool events to node/channel subscribers only when verbose is enabled;
      // WS clients already received the event above via broadcastToConnIds.
      if (!isToolEvent || toolVerbose !== "off") {
        nodeSendToSession(sessionKey, "agent", isToolEvent ? toolPayload : agentPayload);
      }
      if (!isAborted && evt.stream === "assistant" && typeof evt.data?.text === "string") {
        emitChatDelta(sessionKey, clientRunId, evt.seq, evt.data.text);
      } else if (!isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        if (chatLink) {
          const finished = chatRunState.registry.shift(evt.runId);
          if (!finished) {
            clearAgentRunContext(evt.runId);
            return;
          }
          emitChatFinal(
            finished.sessionKey,
            finished.clientRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.runId,
            evt.data?.error,
          );
        } else {
          emitChatFinal(
            sessionKey,
            eventRunId,
            evt.seq,
            lifecyclePhase === "error" ? "error" : "done",
            evt.runId,
            evt.data?.error,
          );
        }
      } else if (isAborted && (lifecyclePhase === "end" || lifecyclePhase === "error")) {
        chatRunState.abortedRuns.delete(clientRunId);
        chatRunState.abortedRuns.delete(evt.runId);
        chatRunState.buffers.delete(clientRunId);
        chatRunState.deltaSentAt.delete(clientRunId);
        if (chatLink) {
          chatRunState.registry.remove(evt.runId, clientRunId, sessionKey);
        }
      }
    }

    if (lifecyclePhase === "end" || lifecyclePhase === "error") {
      toolEventRecipients.markFinal(evt.runId);
      clearAgentRunContext(evt.runId);
      agentRunSeq.delete(evt.runId);
      agentRunSeq.delete(clientRunId);
      chatRunState.terminalUsageByRun.delete(evt.runId);
      chatRunState.terminalUsageByRun.delete(clientRunId);
    }
  };
}
