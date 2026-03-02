import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const peersHandlers: GatewayRequestHandlers = {
  "peers.sync_config": async ({ params, respond, context }) => {
    try {
      const cfg = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));

      const peersFile = path.join(workspaceDir, "peer_agents.json");
      const peersMdFile = path.join(workspaceDir, "peers.md");
      const peersList = params.peers;

      if (!Array.isArray(peersList)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "peers must be an array"));
        return;
      }

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(peersFile, JSON.stringify(peersList, null, 2), "utf8");

      let mdContent = "# My Peer Agents\\n\\n";
      mdContent +=
        "These are other agents deployed by my user. I can communicate with them using the `message-other-agent` skill by passing their exact `Agent Name`.\\n\\n";
      mdContent += "| Agent Name | Agent ID | Model | Description |\\n";
      mdContent += "|---|---|---|---|\\n";

      for (const peer of peersList) {
        const name = peer.agentName || peer.name || "Unknown";
        const id = peer.agentId || peer.id || "Unknown";
        const model = peer.model || "Unknown";
        let desc = peer.systemPrompt || peer.description || "-";
        if (desc.length > 100) {
          desc = desc.substring(0, 97) + "...";
        }
        // Clean up newlines for the markdown table
        desc = desc.replace(/\\r?\\n|\\r/g, " ");
        mdContent += `| ${name} | ${id} | ${model} | ${desc} |\\n`;
      }

      await fs.writeFile(peersMdFile, mdContent, "utf8");

      context?.logGateway?.info(
        `peers.sync_config: Synced ${peersList.length} peer agents to ${peersFile} and ${peersMdFile}`,
      );

      respond(true, { ok: true, syncedCount: peersList.length }, undefined);
    } catch (err: unknown) {
      context?.logGateway?.error(`peers.sync_config error: ${JSON.stringify(err)}`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, JSON.stringify(err)));
    }
  },

  /**
   * group-chat.log
   * Called by the message-other-agent skill (via bash curl) or directly by internal
   * gateway logic to log a message to the central group chat store.
   *
   * The gateway token is used as the bearer auth against the control-plane API.
   */
  "group-chat.log": async ({ params, respond, context }) => {
    try {
      // const controlPlaneUrl =
      //   process.env.OPENCLAW_CONTROL_PLANE_URL ||
      //   process.env.LAZZY_CONTROL_PLANE_URL ||
      //   "https://gwal.ai";

      const controlPlaneUrl = "https://gwal.ai";

      // const cfg = loadConfig();
      // Resolve the gateway token from the environment (set by lazzy-bootstrap.js)
      const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

      if (!gatewayToken) {
        context?.logGateway?.warn("group-chat.log: OPENCLAW_GATEWAY_TOKEN not set, skipping log");
        respond(true, { ok: true, skipped: true }, undefined);
        return;
      }

      const body = {
        conversationId: params.conversationId ?? "default",
        fromAgentId: params.fromAgentId ?? null,
        fromAgentName: params.fromAgentName ?? (process.env.OPENCLAW_AGENT_NAME || null),
        toAgentId: params.toAgentId ?? null,
        toAgentName: params.toAgentName ?? null,
        role: params.role ?? "agent",
        content: params.content ?? "",
        sentAt: params.sentAt ?? new Date().toISOString(),
      };

      const response = await fetch(`${controlPlaneUrl}/api/group-chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        context?.logGateway?.warn(
          `group-chat.log: control plane returned ${response.status}: ${text}`,
        );
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Control plane error: ${response.status}`),
        );
        return;
      }

      context?.logGateway?.info(
        `group-chat.log: logged message from ${JSON.stringify(body.fromAgentName)}`,
      );
      respond(true, { ok: true }, undefined);
    } catch (err: unknown) {
      context?.logGateway?.error(`group-chat.log error: ${JSON.stringify(err)}`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, JSON.stringify(err)));
    }
  },
};
