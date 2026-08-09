# Shared Remote Browser

Share one live Chrome session between an AI agent and a human on any phone or desktop browser.

The agent connects locally through Chrome DevTools Protocol (CDP). The human receives a temporary HTTPS viewer URL with direct touch control, native mobile keyboard input, clipboard paste, tab and OAuth-popup switching, and an explicit **Done** handoff back to the agent.

## Quick start

```bash
git clone https://github.com/netanelgilad/shared-remote-browser.git
cd shared-remote-browser
npm install

./shared-browser launch --url "https://example.com" --name "oauth"
```

The command prints:

- a temporary `https://…trycloudflare.com/viewer` URL;
- a six-digit access code valid for ten minutes;
- the local CDP port for Playwright, Puppeteer, or another agent;
- a session ID used by `ps` and `kill`.

Open the viewer URL on the phone and enter the access code. The first authenticated viewer receives control. Additional viewers are read-only until they choose **Take control**.

## Human handoff

The intended coordination loop is:

1. The agent pauses browser input and shares the viewer URL and code.
2. The human opens the viewer and completes the login, CAPTCHA, or visual task.
3. The human presses **Done**.
4. The agent observes `handoff.status: "complete"` and resumes.

```bash
curl -s http://127.0.0.1:19224/health
```

Agents connecting directly to Chrome CDP are not technically prevented from sending commands while the human controls the session. They must honor this handoff contract and pause until **Done**. Enforced arbitration would require routing agent CDP traffic through the viewer server as well.

## Session manager

```bash
# Start a new isolated Chrome profile and share it
./shared-browser launch --url "https://example.com" --name "oauth"

# Share a Chrome instance already listening on a local CDP port
./shared-browser expose 19222 --name "existing-browser"

# Inspect and stop sessions
./shared-browser ps
./shared-browser ps --json
./shared-browser kill <id-or-port-or-name>
```

The registry is stored privately at `/tmp/shared-browser-sessions.json`. Freshly launched Chrome profiles are ephemeral and are removed when their owning session is killed. An exposed Chrome instance is never terminated by `shared-browser kill`.

The legacy `scripts/start.sh` command remains as a thin wrapper around `shared-browser launch`.

## Agent connection

The agent attaches to the same local Chrome independently:

```javascript
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP('http://127.0.0.1:19222');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();
```

Never tunnel or publicly expose the raw CDP port. The viewer server keeps discovery and CDP on loopback and publishes only its authenticated viewer protocol.

## Viewer experience

- Direct single-tap clicking, double-clicking, long-press right-click, desktop drag, and continuous scrolling.
- Pinch zoom and one-finger local panning while zoomed, with a **Fit** reset.
- Native mobile keyboard bridge supporting Unicode, RTL text, emoji, composition/IME, dictation, and paste.
- Dedicated Backspace, Tab, Enter, and clipboard controls for login flows.
- Editable URL, back, forward, reload, and tab selector.
- Automatic adoption of newly opened OAuth popups.
- JavaScript alert, confirm, and prompt handling.
- Automatic WebSocket/CDP reconnect with visible connection state and screen wake lock where supported.
- One controller plus additional read-only observers.

## Architecture

```text
Agent ── Playwright/Puppeteer ──┐
                               ▼
                         Chrome on loopback
                               ▲
                               │ one browser-level CDP connection
                               │ one selected-page screencast
                               ▼
Phone ─ Cloudflare Tunnel ─ Viewer server
          HTTPS/WSS          ├─ target and popup discovery
                             ├─ paced latest-frame fan-out
                             ├─ input validation and CDP dispatch
                             └─ authentication + handoff state
```

The server owns one CDP screencast and fans it out to all viewers. Chrome frame acknowledgements are paced at approximately 15 FPS while idle and 30 FPS briefly after input. Slow observers skip stale frames rather than building an unbounded JPEG queue. The controlling viewer acknowledges painted frames, providing an additional backpressure signal.

Target discovery uses Chrome’s browser-level `Target` domain. OAuth popups opened by the active page are adopted automatically, while all current page targets remain selectable in the viewer.

## Security model

- Chrome and the viewer server bind only to `127.0.0.1`.
- Raw `/json/*` and CDP WebSockets are never proxied through the public server.
- The access code uses cryptographic randomness, expires after ten minutes, and is rate-limited.
- Viewer cookies are random, HTTP-only, same-site, expiring, and marked secure through HTTPS.
- WebSocket origins, message size, event rate, URLs, text sizes, coordinates, keys, and message types are validated.
- State and log files are created with private permissions.
- Cloudflare quick tunnels use an explicit empty configuration and never move the user’s named-tunnel configuration.

Quick tunnels are temporary public endpoints. For persistent or multi-user deployments, put the viewer behind Cloudflare Access or a private network such as Tailscale.

## Limits and full-desktop fallback

CDP page screencasts cannot represent every piece of native browser or macOS UI. File pickers, passkey sheets, camera/microphone permission sheets, HTTP-auth windows, extension UI, and some downloads may require full-desktop control. Use macOS Screen Sharing, Chrome Remote Desktop, or noVNC as the fallback for those cases.

## Requirements

- Google Chrome at `/Applications/Google Chrome.app/`
- Deno available in `PATH`
- Node.js and npm
- `cloudflared` available in `PATH`

## Development

```bash
npm install
npm test
deno fmt --check cli.ts
deno check --lock=deno.lock cli.ts
node --check scripts/server.mjs
node --check scripts/viewer.js
```

The integration test uses a fake browser-level CDP server to verify shared screencasting, reconnect-safe viewers, popup adoption, handoff state, input dispatch, authentication, and the absence of a public raw-CDP proxy.

The implementation was informed by maintained prior art without copying incompatible code. See [Prior art and design lineage](docs/PRIOR_ART.md).

## License

MIT © 2026 Offload
