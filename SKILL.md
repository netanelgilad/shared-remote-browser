---
name: shared-remote-browser
description: >
  Launch a shared local Chrome session with a secure, mobile-friendly live viewer for human-in-the-loop work.
  Use for OAuth, CAPTCHAs, credentials, visual verification, or any browser task where an agent must pause and let
  a human watch or control the same browser from a phone. Provides CDP automation, popup/tab switching, native phone
  keyboard and clipboard input, and an explicit Done handoff signal.
---

# Shared Remote Browser

Use this skill when browser automation needs human visibility or intervention. The agent and viewer share one local Chrome; raw CDP stays on loopback.

## Start a session

From the skill directory:

```bash
./shared-browser launch --url "https://example.com" --name "oauth"
```

The command prints the viewer URL, ten-minute access code, local CDP port, and session ID. Share only the viewer URL and access code with the human.

To expose Chrome that is already running with CDP enabled:

```bash
./shared-browser expose 19222 --name "existing-browser"
```

Never expose or tunnel the CDP port itself.

## Coordinate the handoff

1. Navigate and prepare the page using the agent’s CDP client.
2. Tell the human to open the viewer and enter the code.
3. Pause all agent browser input while `handoff.status` is `human-controlling`.
4. Poll the local viewer health endpoint until the human presses **Done**:

```bash
curl -s http://127.0.0.1:<serverPort>/health
```

Resume automation only when the response contains:

```json
{"handoff":{"status":"complete"}}
```

Direct CDP clients are not forcibly blocked, so respecting this pause is required to avoid racing the human.

## Connect the agent

```javascript
const browser = await chromium.connectOverCDP('http://127.0.0.1:<cdpPort>');
```

OAuth popups opened by the active page are automatically selected in the human viewer. The human can also switch among all open page targets.

## Inspect and stop sessions

```bash
./shared-browser ps
./shared-browser ps --json
./shared-browser kill <id-or-port-or-name>
```

Always stop a session after the handoff task. `kill` removes a profile only when this tool created it; an externally exposed Chrome is left running.

## Operational notes

- Access codes expire after ten minutes; authenticated viewer cookies remain valid for the running session.
- Cloudflare quick-tunnel URLs are temporary. Restart the session if the tunnel dies.
- The viewer handles page content, tabs/popups, and JavaScript dialogs. Native browser/macOS UI such as file pickers, passkeys, permissions, and extension popups requires a full-desktop fallback.
- Multiple agents are serialized during session launch through a private registry lock, and sessions use separate port pairs and ephemeral Chrome profiles.

## Requirements

- Google Chrome at `/Applications/Google Chrome.app/`
- Deno, Node.js/npm, and `cloudflared` available in `PATH`
