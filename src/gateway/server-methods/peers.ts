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
      const peersList = params.peers;

      if (!Array.isArray(peersList)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "peers must be an array"));
        return;
      }

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.writeFile(peersFile, JSON.stringify(peersList, null, 2), "utf8");

      context?.logGateway?.info(
        `peers.sync_config: Synced ${peersList.length} peer agents to ${peersFile}`,
      );

      respond(true, { ok: true, syncedCount: peersList.length }, undefined);
    } catch (err: unknown) {
      context?.logGateway?.error(`peers.sync_config error: ${JSON.stringify(err)}`);
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, JSON.stringify(err)));
    }
  },
};
