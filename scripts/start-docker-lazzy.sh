#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-openclaw-local-test}"
CONTAINER_NAME="${CONTAINER_NAME:-openclaw-lazzy-local}"
PORT="${PORT:-18889}"
OPENCLAW_MODEL="${OPENCLAW_MODEL:-google/gemini-3-pro-preview}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-${GATEWAY_TOKEN:-test-token-123}}"
GEMINI_API_KEY="${GEMINI_API_KEY:-${1:-}}"

if [[ -z "${GEMINI_API_KEY}" ]]; then
  echo "Missing GEMINI_API_KEY."
  echo "Usage:"
  echo "  GEMINI_API_KEY=<key> scripts/start-docker-lazzy.sh"
  echo "  or"
  echo "  scripts/start-docker-lazzy.sh <key>"
  exit 1
fi

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

echo "Starting $CONTAINER_NAME from image $IMAGE_NAME on port $PORT..."
docker run --rm -it \
  --name "$CONTAINER_NAME" \
  -p "$PORT:18789" \
  -e "GEMINI_API_KEY=$GEMINI_API_KEY" \
  -e "OPENCLAW_MODEL=$OPENCLAW_MODEL" \
  -e "OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" \
  "$IMAGE_NAME"
