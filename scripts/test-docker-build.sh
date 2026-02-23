#!/bin/bash
set -e

# Get the path to the openclaw directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== OpenClaw Local Docker Build Test ==="

echo "1. Building Docker image..."
cd "$OPENCLAW_DIR"
docker build -f Dockerfile.lazzy -t openclaw-local-test .

echo "=== Build Successful! ==="
echo "You can test the image by running:"
echo "TOKEN=test-token-123"
echo "docker run --rm -it -p 18789:18789 -e OPENCLAW_GATEWAY_TOKEN=$TOKEN openclaw-local-test"
echo ""
echo "Then, in another terminal, test the chat connection with:"
echo "bun run scripts/test-agent-chat.js --token $TOKEN"
