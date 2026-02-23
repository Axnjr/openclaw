import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createStubSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";
import { subscribeEmbeddedPiSession } from "./pi-embedded-subscribe.js";

describe("subscribeEmbeddedPiSession lifecycle billing errors", () => {
  it("includes provider and model context in lifecycle billing errors", () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-billing-error",
      onAgentEvent,
      sessionKey: "test-session",
    });

    const assistantMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "insufficient credits",
      provider: "Anthropic",
      model: "claude-3-5-sonnet",
    } as AssistantMessage;

    emit({ type: "message_update", message: assistantMessage });
    emit({ type: "agent_end" });

    const lifecycleError = onAgentEvent.mock.calls.find(
      (call) => call[0]?.stream === "lifecycle" && call[0]?.data?.phase === "error",
    );
    expect(lifecycleError).toBeDefined();
    expect(lifecycleError?.[0]?.data?.error).toContain("Anthropic (claude-3-5-sonnet)");
  });

  it("falls back to usage totals when last assistant usage is missing", () => {
    const { session, emit } = createStubSessionHarness();
    const onAgentEvent = vi.fn();

    subscribeEmbeddedPiSession({
      session,
      runId: "run-usage-totals-fallback",
      onAgentEvent,
      sessionKey: "test-session",
    });

    emit({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-4o-mini",
        usage: {
          input: 120,
          output: 40,
          total: 160,
        },
      } as AssistantMessage,
    });

    emit({
      type: "message_update",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-4o-mini",
      } as AssistantMessage,
    });

    emit({ type: "agent_end" });

    const lifecycleEnd = onAgentEvent.mock.calls.find(
      (call) => call[0]?.stream === "lifecycle" && call[0]?.data?.phase === "end",
    );
    expect(lifecycleEnd).toBeDefined();
    expect(lifecycleEnd?.[0]?.data?.usage?.input).toBe(120);
    expect(lifecycleEnd?.[0]?.data?.usage?.output).toBe(40);
    expect(lifecycleEnd?.[0]?.data?.usage?.total).toBe(160);
    expect(lifecycleEnd?.[0]?.data?.usageSource).toBe("usage_totals");
  });
});
