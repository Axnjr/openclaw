---
name: message-other-agent
description: "Send a direct message to a peer agent. Use this when the user asks you collaborate with your other peer agents, talk to, ask, or send a message to another agent. You must provide the exact agent name and the message. The skill reads your peer agents configuration and sends the message."
metadata: { "openclaw": { "emoji": "💬", "requires": { "bins": ["curl", "node"] } } }
---

# Message Other Agent Skill

Send a direct message to a peer agent deployed by the same user.

## Commands

### Send Message

```bash
AGENT_NAME="OtherAgent"
MESSAGE="Hello, what do you think about this?"
PEERS_FILE="${OPENCLAW_WORKSPACE_DIR:-~/.openclaw/workspace}/peer_agents.json"

if [ ! -f "$PEERS_FILE" ]; then
  echo "Error: Peer agents file not found at $PEERS_FILE. Ensure the mobile app has synced the configuration."
  exit 1
fi

# Use Node.js to parse the peer list and extract connection details (no jq needed)
AGENT_DATA=$(node -e "
const fs = require('fs');
try {
  const fileData = fs.readFileSync('$PEERS_FILE', 'utf8');
  const peers = JSON.parse(fileData);
  const targetAgent = peers.find(p => p.agentName === '$AGENT_NAME' || p.name === '$AGENT_NAME');
  if (!targetAgent) {
    process.stderr.write('Error: Agent not found: $AGENT_NAME. Available agents: ' + peers.map(p => p.agentName || p.name).join(', ') + '\n');
    process.exit(1);
  }
  const senderName = process.env.OPENCLAW_AGENT_NAME || 'Agent';
  const body = '[From: ' + senderName + ']\n\n$MESSAGE';
  console.log(JSON.stringify({
    domain: targetAgent.domain,
    token: targetAgent.gatewayToken,
    agentId: targetAgent.agentId || targetAgent.id || '',
    body
  }));
} catch(e) {
  process.stderr.write('Error: ' + e.message + '\n');
  process.exit(1);
}
")

if [ $? -ne 0 ]; then
  exit 1
fi

DOMAIN=$(node -e "console.log(JSON.parse(process.argv[1]).domain)" "$AGENT_DATA")
TOKEN=$(node -e "console.log(JSON.parse(process.argv[1]).token)" "$AGENT_DATA")
TO_AGENT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).agentId)" "$AGENT_DATA")
MSG_BODY=$(node -e "console.log(JSON.stringify(JSON.parse(process.argv[1]).body))" "$AGENT_DATA")
SENDER_NAME="${OPENCLAW_AGENT_NAME:-Agent}"

# Control plane for group chat logging (optional)
CONTROL_PLANE_URL="${OPENCLAW_CONTROL_PLANE_URL:-${LAZZY_CONTROL_PLANE_URL:-https://lazzy.ai}}"
GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"

echo "Sending message to $AGENT_NAME via $DOMAIN..."

curl -s -X POST "https://$DOMAIN/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${OPENCLAW_MODEL:-openclaw}\", \"messages\": [{\"role\": \"user\", \"content\": $MSG_BODY}]}"

echo ""
echo "Message sent."

# Log this outgoing message to the group chat (fire-and-forget, non-blocking)
# Only runs when a gateway token is configured.
if [ -n "$GATEWAY_TOKEN" ]; then
  SENT_AT=$(node -e "console.log(new Date().toISOString())")
  LOG_BODY=$(node -e "
    process.stdout.write(JSON.stringify({
      role: 'agent',
      fromAgentName: process.argv[1],
      toAgentId: process.argv[2],
      toAgentName: process.argv[3],
      content: process.argv[4],
      sentAt: process.argv[5]
    }));
  " "$SENDER_NAME" "$TO_AGENT_ID" "$AGENT_NAME" "$MESSAGE" "$SENT_AT")
  curl -s -X POST "$CONTROL_PLANE_URL/api/group-chat" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$LOG_BODY" > /dev/null 2>&1 &
fi
```

## Notes

- This uses the `/v1/chat/completions` endpoint on the peer agent's gateway.
- Ensure you exact-match the agent name (check `peers.md` in your workspace).
- Outgoing messages are silently logged to the group chat if `OPENCLAW_GATEWAY_TOKEN` is set.
