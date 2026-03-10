import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

afterEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  resetAgentRunContextForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("agent event handler", () => {
  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      " NO_REPLY  ",
    );
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    handler({
      runId: "run-2",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
      usage?: { creditsUsed?: number; credits_used?: number };
      creditsUsed?: number;
      credits_used?: number;
    };
    expect(payload.state).toBe("final");
    expect(payload.message).toBeUndefined();
    expect(payload.creditsUsed).toBe(0);
    expect(payload.credits_used).toBe(0);
    expect(payload.usage?.creditsUsed).toBe(0);
    expect(payload.usage?.credits_used).toBe(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("keeps top-level and usage credits on silent final payloads", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({
      now: 2_300,
    });
    chatRunState.registry.add("run-credits", {
      sessionKey: "session-credits",
      clientRunId: "client-credits",
    });

    handler({
      runId: "run-credits",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    handler({
      runId: "run-credits",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "end",
        creditsUsed: 12.5,
      },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: unknown;
      creditsUsed?: number;
      credits_used?: number;
      usage?: { creditsUsed?: number; credits_used?: number };
    };
    expect(payload.message).toBeUndefined();
    expect(payload.creditsUsed).toBe(12.5);
    expect(payload.credits_used).toBe(12.5);
    expect(payload.usage?.creditsUsed).toBe(12.5);
    expect(payload.usage?.credits_used).toBe(12.5);
    nowSpy?.mockRestore();
  });

  it("includes byok authMode in final payload and skips billing consume", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_325,
    });
    chatRunState.registry.add("run-byok", {
      sessionKey: "session-byok",
      clientRunId: "client-byok",
    });
    registerAgentRunContext("run-byok", { sessionKey: "session-byok", authMode: "byok" });

    handler({
      runId: "run-byok",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    handler({
      runId: "run-byok",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end", creditsUsed: 7 },
    });

    const finalCalls = chatBroadcastCalls(broadcast).filter(([, payload]) => {
      return (payload as { state?: string }).state === "final";
    });
    expect(finalCalls).toHaveLength(1);
    const payload = finalCalls[0]?.[1] as { authMode?: string };
    expect(payload.authMode).toBe("byok");

    const sessionCalls = sessionChatCalls(nodeSendToSession).filter(([, , payload]) => {
      return (payload as { state?: string }).state === "final";
    });
    expect(sessionCalls).toHaveLength(1);
    const sessionPayload = sessionCalls[0]?.[2] as { authMode?: string };
    expect(sessionPayload.authMode).toBe("byok");

    const billingCalls = broadcast.mock.calls.filter(([event]) => event === "billing.update");
    expect(billingCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    nowSpy?.mockRestore();
  });

  it("emits billing.update after hosted credit consumption succeeds", async () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "test-gateway-token";
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          appliedCredits: 12.5,
          creditsRemaining: 87.5,
          canChat: true,
          billingReason: "ok",
          idempotencyKey: "credit:client-hosted",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_350,
    });
    chatRunState.registry.add("run-hosted", {
      sessionKey: "session-hosted",
      clientRunId: "client-hosted",
    });
    registerAgentRunContext("run-hosted", {
      sessionKey: "session-hosted",
      authMode: "hosted",
    });

    handler({
      runId: "run-hosted",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    handler({
      runId: "run-hosted",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end", creditsUsed: 12.5 },
    });

    await vi.waitFor(() => {
      const billingCalls = broadcast.mock.calls.filter(([event]) => event === "billing.update");
      expect(billingCalls).toHaveLength(1);
    });

    const billingCalls = broadcast.mock.calls.filter(([event]) => event === "billing.update");
    const payload = billingCalls[0]?.[1] as {
      runId?: string;
      authMode?: string;
      ok?: boolean;
      creditsRemaining?: number;
      canChat?: boolean;
      billingReason?: string;
      appliedCredits?: number;
      source?: string;
    };
    expect(payload).toMatchObject({
      runId: "client-hosted",
      authMode: "hosted",
      ok: true,
      creditsRemaining: 87.5,
      canChat: true,
      billingReason: "ok",
      appliedCredits: 12.5,
      source: "consume_ack",
    });

    const nodeBillingCalls = nodeSendToSession.mock.calls.filter(
      ([, event]) => event === "billing.update",
    );
    expect(nodeBillingCalls).toHaveLength(1);
    const billingFetchCalls = fetchMock.mock.calls.filter(([url]) => {
      return typeof url === "string" && url.includes("/billing/consume");
    });
    expect(billingFetchCalls).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    handler({
      runId: "run-fallback",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as {
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    handler({
      runId: "run-fallback-internal",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    handler({
      runId: "run-fallback-session-key",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "session-from-event",
      data: {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/minimax-m2p5",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
    });

    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    const payload = broadcastAgentCalls[0]?.[1] as { sessionKey?: string };
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });
});
