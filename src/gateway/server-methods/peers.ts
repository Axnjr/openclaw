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
};
