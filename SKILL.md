---
name: shared-remote-browser
description: >
  Launch a shared remote Chrome browser session with live screencast for humans to watch and interact with.
  Use when an agent needs browser automation AND human visibility — OAuth flows, CAPTCHAs, visual verification,
  or any task where a human should see/control the browser alongside the agent. Starts Chrome with CDP,
  serves a mobile-friendly viewer (tap, type, scroll, zoom), and tunnels via Cloudflare for a shareable URL.
---

# Remote Browser

Shared browser session: agent automates via CDP/Playwright, human watches and interacts via a mobile-friendly viewer URL.

## Quick Start

```bash
# Start session (launches Chrome + viewer server + Cloudflare tunnel)
bash "$(dirname "$0")/scripts/start.sh" --url "https://example.com"

# Check state file for the shareable URL
cat /tmp/remote-browser-19222.json
```

## Starting a Session

```bash
# Basic
scripts/start.sh

# With options
scripts/start.sh --url "https://example.com" --cdp-port 19222 --port 19224
```

The script outputs a shareable URL and writes a state file to `/tmp/remote-browser-{cdpPort}.json`:
```json
{
  "cdpPort": 19222,
  "serverPort": 19224,
  "tunnelUrl": "https://xxx.trycloudflare.com",
  "viewerUrl": "https://xxx.trycloudflare.com/viewer",
  "otp": "123456"
}
```

Share `viewerUrl` **and the OTP access code** with the human. They'll need to enter the 6-digit code before accessing the viewer. The OTP is printed to stdout and included in the state file.

## Automating Alongside

Connect Playwright (or any CDP client) to the same Chrome instance:

```javascript
const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
```

The human sees everything the agent does in real-time.

## Checking Session Status

```bash
# Health check
curl -s http://127.0.0.1:19224/health

# State file
cat /tmp/remote-browser-19222.json
```

## Architecture

Chrome CDP rejects non-localhost `Host` headers, so `server.mjs` acts as a WebSocket proxy — it connects to CDP locally and bridges screencast frames + input events to/from the viewer client over the tunneled connection.

## Requirements

- **Google Chrome** (macOS path: `/Applications/Google Chrome.app/`)
- **`ws` npm package** — auto-installed to `/tmp/node_modules` if missing
- **`cloudflared` CLI** — for the public tunnel

## Notes

- `~/.cloudflared/config.yml` must be temporarily moved for quick tunnels to work (start.sh handles this automatically and restores it)
- The viewer runs in the foreground (Ctrl+C to stop the tunnel)
- Multiple sessions can run on different port pairs
