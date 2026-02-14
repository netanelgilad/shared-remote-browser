#!/bin/bash
# Start a shared remote browser session
# Usage: ./start.sh [--url <initial-url>] [--cdp-port 19222] [--port 19224]
#
# Starts Chrome with CDP, the viewer server, and a Cloudflare tunnel.
# Outputs the shareable URL.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CDP_PORT="${CDP_PORT:-19222}"
SERVER_PORT="${SERVER_PORT:-19224}"
INITIAL_URL="${INITIAL_URL:-about:blank}"
CHROME_DIR="/tmp/chrome-remote-browser-${CDP_PORT}"

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --url) INITIAL_URL="$2"; shift 2;;
    --cdp-port) CDP_PORT="$2"; shift 2;;
    --port) SERVER_PORT="$2"; shift 2;;
    *) shift;;
  esac
done

echo "🌐 Starting Remote Browser..."
echo "   CDP port: $CDP_PORT"
echo "   Server port: $SERVER_PORT"
echo "   Initial URL: $INITIAL_URL"

# 1. Start Chrome with CDP
if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
  echo "✓ Chrome already running on :${CDP_PORT}"
else
  echo "→ Launching Chrome..."
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port="${CDP_PORT}" \
    '--remote-allow-origins=*' \
    --user-data-dir="${CHROME_DIR}" \
    --no-first-run \
    "${INITIAL_URL}" > /dev/null 2>&1 &
  
  # Wait for CDP
  for i in $(seq 1 10); do
    if curl -s "http://127.0.0.1:${CDP_PORT}/json/version" > /dev/null 2>&1; then
      echo "✓ Chrome ready"
      break
    fi
    sleep 1
  done
fi

# 2. Ensure ws module is available
if ! node -e "require('ws')" 2>/dev/null; then
  echo "→ Installing ws module..."
  cd /tmp && npm install ws > /dev/null 2>&1
fi

# 3. Start viewer server
if curl -s "http://127.0.0.1:${SERVER_PORT}/health" > /dev/null 2>&1; then
  echo "✓ Viewer already running on :${SERVER_PORT}"
else
  echo "→ Starting viewer server..."
  NODE_PATH=/tmp/node_modules node "${SCRIPT_DIR}/server.mjs" \
    --cdp-port "${CDP_PORT}" --port "${SERVER_PORT}" > "/tmp/remote-browser-${SERVER_PORT}.log" 2>&1 &
  sleep 2
  echo "✓ Viewer ready"
fi

# Extract OTP from server log
OTP=$(grep -oE 'OTP:    [0-9]{6}' "/tmp/remote-browser-${SERVER_PORT}.log" 2>/dev/null | head -1 | awk '{print $2}')
if [ -n "$OTP" ]; then
  echo "🔑 Access code: ${OTP}"
fi

# 4. Start Cloudflare tunnel
echo "→ Starting tunnel..."

# Temporarily hide named tunnel config if it exists
MOVED_CONFIG=false
if [ -f ~/.cloudflared/config.yml ]; then
  mv ~/.cloudflared/config.yml ~/.cloudflared/config.yml.remote-browser-bak
  MOVED_CONFIG=true
fi

cloudflared tunnel --url "http://127.0.0.1:${SERVER_PORT}" --no-autoupdate --protocol http2 > "/tmp/tunnel-remote-browser-${SERVER_PORT}.log" 2>&1 &
TUNNEL_PID=$!

# Restore config
sleep 3
if [ "$MOVED_CONFIG" = true ]; then
  mv ~/.cloudflared/config.yml.remote-browser-bak ~/.cloudflared/config.yml
fi

# Wait for tunnel URL
for i in $(seq 1 10); do
  TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "/tmp/tunnel-remote-browser-${SERVER_PORT}.log" 2>/dev/null | head -1)
  if [ -n "$TUNNEL_URL" ]; then break; fi
  sleep 1
done

if [ -n "$TUNNEL_URL" ]; then
  echo ""
  echo "════════════════════════════════════════"
  echo "✅ Remote Browser Ready!"
  echo ""
  echo "   ${TUNNEL_URL}/viewer"
  echo ""
  echo "════════════════════════════════════════"
  echo ""
  echo "Share this URL to view/control the browser."
  echo "Press Ctrl+C to stop the tunnel."
  
  # Write state file for agents to discover
  cat > "/tmp/remote-browser-${CDP_PORT}.json" << EOF
{
  "cdpPort": ${CDP_PORT},
  "serverPort": ${SERVER_PORT},
  "tunnelUrl": "${TUNNEL_URL}",
  "viewerUrl": "${TUNNEL_URL}/viewer",
  "otp": "${OTP}",
  "tunnelPid": ${TUNNEL_PID},
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
  
  # Keep running until Ctrl+C
  wait $TUNNEL_PID
else
  echo "❌ Tunnel failed to start. Check /tmp/tunnel-remote-browser-${SERVER_PORT}.log"
  exit 1
fi
