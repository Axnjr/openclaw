---
name: message-other-agent
description: "Send a direct message to a peer agent. Use this when the user asks you collaborate with your other peer agents, talk to, ask, or send a message to another agent. You must provide the exact agent name and the message. The skill reads your peer agents configuration and sends the message."
metadata: { "openclaw": { "emoji": "💬", "requires": { "bins": ["curl", "jq"] } } }
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

AGENT_JSON=$(jq -r --arg name "$AGENT_NAME" '.[] | select(.agentName == $name or .name == $name)' "$PEERS_FILE")
if [ -z "$AGENT_JSON" ]; then
  echo "Error: Agent not found: $AGENT_NAME. Available agents are:"
  jq -r '.[].agentName' "$PEERS_FILE"
  exit 1
fi

DOMAIN=$(echo "$AGENT_JSON" | jq -r '.domain')
TOKEN=$(echo "$AGENT_JSON" | jq -r '.gatewayToken')
SENDER_NAME="${OPENCLAW_AGENT_NAME:-Agent}"
ESCAPED_MSG=$(echo "[From: $SENDER_NAME]\n\n$MESSAGE" | jq -Rsa .)

echo "Sending message to $AGENT_NAME..."

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
