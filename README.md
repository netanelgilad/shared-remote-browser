# Shared Remote Browser

**Share a live browser session between AI agents and humans via a simple URL**

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

## What It Does

Shared Remote Browser creates a live, interactive browser session that both AI agents and humans can control simultaneously. Perfect for when automation needs human oversight or intervention — OAuth flows, CAPTCHA solving, visual verification, or any task where a human should see what's happening in real-time.

The agent automates via Chrome DevTools Protocol (CDP), while the human watches and interacts through a shareable URL on any device.

## Demo

_Screenshot/demo coming soon_

## How It Works

```
┌─────────────┐
│   Chrome    │ ← Agent automates via CDP (localhost:19222)
│  (headless) │
└──────┬──────┘
       │ CDP WebSocket
       │
┌──────▼───────────┐
│  Viewer Server   │ ← Proxies CDP screencast + input events
│   (server.mjs)   │
└──────┬───────────┘
       │
┌──────▼───────────┐
│ Cloudflare Tunnel│ ← Creates public HTTPS URL
└──────┬───────────┘
       │
┌──────▼───────────┐
│  Shareable URL   │ ← Human views/controls from any device
│ (Mobile-friendly)│
└──────────────────┘
```

**Architecture:**
1. Chrome launches with CDP enabled on localhost
2. Viewer server connects to Chrome CDP and streams JPEG screenshots
3. Cloudflare tunnel exposes the viewer server via a public URL
4. Human accesses the URL and sees live browser activity with full interaction

## Quick Start

### As an OpenClaw Skill

If you're using [OpenClaw](https://openclaw.com), install this as a skill:

```bash
# Skill is auto-discovered if cloned to ~/clawd/skills/shared-remote-browser
openclaw skill install shared-remote-browser
```

Then use it from any AI agent session:

```bash
bash ~/clawd/skills/shared-remote-browser/scripts/start.sh --url "https://example.com"
```

### Standalone Usage

```bash
# Clone the repo
git clone https://github.com/netanelgilad/shared-remote-browser.git
cd shared-remote-browser

# Start a session
bash scripts/start.sh --url "https://example.com"

# The script outputs a shareable URL like:
# https://xxx.trycloudflare.com/viewer

# Share that URL with a human — they'll see the live browser
```

The session state is saved to `/tmp/remote-browser-19222.json` with the tunnel URL and OTP for easy reference.

The viewer is protected by a 6-digit access code. Share the URL and the code with the human — they'll see a numpad-style entry screen before accessing the browser.

### Session Manager CLI

The included CLI starts sessions in the background and tracks them locally. It requires [Deno](https://deno.com/).

```bash
# Start a fresh browser session
./shared-browser launch --url "https://example.com" --name "oauth"

# Share a Chrome instance that already exposes CDP
./shared-browser expose 19222 --name "existing-browser"

# List or stop sessions
./shared-browser ps
./shared-browser kill <id-or-port>
```

Add `--json` to `launch`, `expose`, or `ps` when another agent needs structured session details. The CLI keeps its session registry in `/tmp/shared-browser-sessions.json`.

## Features

🔒 **OTP Access Protection** — 6-digit code required to connect (generated per session)  
✨ **Live JPEG Screencast** — Real-time browser view streamed to the viewer  
⌨️ **iOS-style Virtual Keyboard** — Type naturally from any device  
👆 **Tap-to-Click** — Touch-friendly interaction  
🤏 **Pinch-to-Zoom** — Mobile gesture support  
📜 **Scroll** — Smooth scrolling on mobile and desktop  
◀️▶️ **Back/Forward Navigation** — Browser controls  
🔗 **URL Bar** — Navigate to any URL from the viewer  
🤖 **Agent-Friendly** — Playwright/Puppeteer can connect to the same CDP port

## Requirements

- **Google Chrome** — Must be installed (macOS: `/Applications/Google Chrome.app/`)
- **Deno** — Required for the optional `shared-browser` session-management CLI
- **Node.js** — For running the viewer server
- **`ws` npm package** — Auto-installed to `/tmp/node_modules` if missing
- **`cloudflared` CLI** — For creating the public tunnel ([install here](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/))

## Use Cases

🔐 **OAuth Flows** — Let humans complete sign-in while the agent waits  
🧩 **CAPTCHA Solving** — Human verifies while agent continues automation  
👁️ **Visual Verification** — "Does this look right?" moments in automation  
🤝 **Human-in-the-Loop** — Any browser task that needs occasional human input  
🐛 **Debugging Automation** — Watch what your agent is doing in real-time  
📱 **Mobile Testing** — View and interact with desktop browser from your phone

## Advanced Usage

### Connect an Agent

While the viewer is running, connect Playwright or Puppeteer to the same CDP port:

```javascript
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
const page = (await browser.contexts()[0].pages())[0];

// Agent automations appear live in the viewer
await page.goto('https://example.com');
await page.fill('input[name="email"]', 'user@example.com');
```

### Multiple Sessions

Run multiple browser sessions on different ports:

```bash
bash scripts/start.sh --cdp-port 19222 --port 19224  # Session 1
bash scripts/start.sh --cdp-port 19223 --port 19225  # Session 2
```

### Check Session Status

```bash
# Health check
curl http://127.0.0.1:19224/health

# View session info
cat /tmp/remote-browser-19222.json
```

## How the Proxy Works

Chrome CDP only accepts WebSocket connections from `localhost`. Since Cloudflare tunnels change the `Host` header, direct connections fail.

The viewer server (`scripts/server.mjs`) acts as a WebSocket proxy:
- Connects to Chrome CDP on localhost
- Relays screencast frames and input events
- Serves the viewer HTML page
- Works over the Cloudflare tunnel

This architecture keeps Chrome secure while enabling remote access.

## Troubleshooting

**"cloudflared tunnel failed"** — Make sure `cloudflared` is installed and in your PATH

**"Chrome not found"** — Update the Chrome path in `scripts/start.sh` for your OS

**"Port already in use"** — Another session is running; use different `--cdp-port` and `--port` values

**Tunnel disconnects** — Cloudflare quick tunnels are temporary; restart the script to get a new URL

## License

MIT © 2026 Offload

---

**Built for [OpenClaw](https://openclaw.com)** — AI agents that actually get things done
