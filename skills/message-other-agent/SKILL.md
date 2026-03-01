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

# Use Node.js to extract the specific agent and parse its data securely without jq
AGENT_DATA=$(node -e "
const fs = require('fs');
try {
  const fileData = fs.readFileSync('$PEERS_FILE', 'utf8');
  const peers = JSON.parse(fileData);
  const targetAgent = peers.find(p => p.agentName === '$AGENT_NAME' || p.name === '$AGENT_NAME');
  if (!targetAgent) {
    console.error('Error: Agent not found: $AGENT_NAME. Available agents are: ' + peers.map(p => p.agentName).join(', '));
    process.exit(1);
  }
  const senderName = process.env.OPENCLAW_AGENT_NAME || 'Agent';
  const escapedMessage = \\\`[From: \\\${senderName}]\\\\n\\\\n$MESSAGE\\\`;
  console.log(JSON.stringify({ domain: targetAgent.domain, token: targetAgent.gatewayToken, escapedMessage }));
} catch(e) {
  console.error('Error parsing JSON:', e.message);
  process.exit(1);
}")

if [ $? -ne 0 ]; then
  exit 1
fi

DOMAIN=$(node -e "console.log(JSON.parse(process.argv[1]).domain)" "$AGENT_DATA")
TOKEN=$(node -e "console.log(JSON.parse(process.argv[1]).token)" "$AGENT_DATA")
ESCAPED_MSG=$(node -e "console.log(JSON.stringify(JSON.parse(process.argv[1]).escapedMessage))" "$AGENT_DATA")

echo "Sending message to $AGENT_NAME via $DOMAIN..."

curl -s -X POST "https://$DOMAIN/v1/chat/completions" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"model\": \"${OPENCLAW_MODEL:-openclaw}\", \"messages\": [{\"role\": \"user\", \"content\": $ESCAPED_MSG}]}"

# Note: Adjust the model if the target agent enforces a specific model ID. Currently we pass a dummy model name,
# since the proxy gateway may enforce its own or use the default.
echo "\nMessage sent."
```

## Notes

- This uses the `/v1/chat/completions` endpoint on the peer agent's gateway.
- Ensure you exact-match the agent name.
