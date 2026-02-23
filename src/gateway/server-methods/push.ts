import type { GatewayRequestHandlers } from "./types.js";
import {
  loadApnsRegistration,
  normalizeApnsEnvironment,
  registerApnsToken,
  resolveApnsAuthConfigFromEnv,
  sendApnsAlert,
} from "../../infra/push-apns.js";
import {
  ErrorCodes,
  errorShape,
  validatePushRegisterParams,
  validatePushTestParams,
} from "../protocol/index.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const pushHandlers: GatewayRequestHandlers = {
  "push.register": async ({ params, respond, context }) => {
    if (!validatePushRegisterParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.register",
        validator: validatePushRegisterParams,
      });
      return;
    }

    try {
      await registerApnsToken({
        nodeId: params.nodeId,
        token: params.token,
        topic: params.topic,
        environment: params.environment,
      });
      respond(true, { success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      context.logGateway.warn(`push apns register failed node=${params.nodeId}: ${message}`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    }
  },

  "push.test": async ({ params, respond }) => {
    if (!validatePushTestParams(params)) {
      respondInvalidParams({
        respond,
        method: "push.test",
        validator: validatePushTestParams,
      });
      return;
    }

    const nodeId = String(params.nodeId ?? "").trim();
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "OpenClaw";
    const body = normalizeOptionalString(params.body) ?? `Push test for node ${nodeId}`;

    await respondUnavailableOnThrow(respond, async () => {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `node ${nodeId} has no APNs registration (connect iOS node first)`,
          ),
        );
        return;
      }

      const auth = await resolveApnsAuthConfigFromEnv(process.env);
      if (!auth.ok) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
        return;
      }

      const overrideEnvironment = normalizeApnsEnvironment(params.environment);
      const result = await sendApnsAlert({
        auth: auth.value,
        registration: {
          ...registration,
          environment: overrideEnvironment ?? registration.environment,
        },
        nodeId,
        title,
        body,
      });
      respond(true, result, undefined);
    });
  },
};
