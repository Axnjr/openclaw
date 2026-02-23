import type { EmbeddedPiSubscribeContext } from "./pi-embedded-subscribe.handlers.types.js";
import { resolveGatewayUsageWithCredits } from "../gateway/usage-credits.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createInlineCodeState } from "../markdown/code-spans.js";
import { formatAssistantErrorText } from "./pi-embedded-helpers.js";
import { isAssistantMessage } from "./pi-embedded-utils.js";

// const DEBUG_GATEWAY_CREDITS = process.env.OPENCLAW_DEBUG_CREDITS === "1";

export {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.compaction.js";

function buildTerminalLifecycleData(
  ctx: EmbeddedPiSubscribeContext,
  endedAt: number,
): Record<string, unknown> {
  const lastAssistant = ctx.state.lastAssistant;
  const provider =
    isAssistantMessage(lastAssistant) && typeof lastAssistant.provider === "string"
      ? lastAssistant.provider
      : undefined;
  const model =
    isAssistantMessage(lastAssistant) && typeof lastAssistant.model === "string"
      ? lastAssistant.model
      : undefined;
  const lastAssistantUsage =
    isAssistantMessage(lastAssistant) &&
    typeof (lastAssistant as { usage?: unknown }).usage !== "undefined"
      ? (lastAssistant as { usage?: unknown }).usage
      : undefined;
  const usageTotals = lastAssistantUsage === undefined ? ctx.getUsageTotals() : undefined;
  const usageRaw = lastAssistantUsage ?? usageTotals;
  const usageSource =
    lastAssistantUsage !== undefined ? "last_assistant" : usageTotals ? "usage_totals" : "none";
  const usageWithCredits = resolveGatewayUsageWithCredits({
    usageRaw,
    provider,
    model,
    config: ctx.params.config,
  });

  return {
    endedAt,
    provider,
    model,
    usage: usageWithCredits.usage,
    costUsd: usageWithCredits.costUsd,
    creditsUsed: usageWithCredits.creditsUsed,
    credits_used: usageWithCredits.creditsUsed,
    usageSource,
  };
}

export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  ctx.log.debug(`embedded run agent start: runId=${ctx.params.runId}`);
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: {
      phase: "start",
      startedAt: Date.now(),
    },
  });
  void ctx.params.onAgentEvent?.({
    stream: "lifecycle",
    data: { phase: "start" },
  });
}

export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  const endedAt = Date.now();
  const terminalData = buildTerminalLifecycleData(ctx, endedAt);

  ctx.log.debug(
    `[GatewayCredits] lifecycle_terminal_data runId=${ctx.params.runId}\n\nTERMINAL_DATA:\n${JSON.stringify(terminalData, null, 2)}`,
  );
  // if (DEBUG_GATEWAY_CREDITS) {
  // }

  ctx.log.debug(`embedded run agent end: runId=${ctx.params.runId} isError=${isError}`);

  if (isError && lastAssistant) {
    const friendlyError = formatAssistantErrorText(lastAssistant, {
      cfg: ctx.params.config,
      sessionKey: ctx.params.sessionKey,
      provider: lastAssistant.provider,
      model: lastAssistant.model,
    });
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "error",
        error: friendlyError || lastAssistant.errorMessage || "LLM request failed.",
        ...terminalData,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: friendlyError || lastAssistant.errorMessage || "LLM request failed.",
        ...terminalData,
      },
    });
  } else {
    emitAgentEvent({
      runId: ctx.params.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        ...terminalData,
      },
    });
    void ctx.params.onAgentEvent?.({
      stream: "lifecycle",
      data: { phase: "end", ...terminalData },
    });
  }

  ctx.flushBlockReplyBuffer();

  ctx.state.blockState.thinking = false;
  ctx.state.blockState.final = false;
  ctx.state.blockState.inlineCode = createInlineCodeState();

  if (ctx.state.pendingCompactionRetry > 0) {
    ctx.resolveCompactionRetry();
  } else {
    ctx.maybeResolveCompactionWait();
  }
}
