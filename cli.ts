#!/usr/bin/env -S deno run --allow-all
/**
 * shared-browser CLI — Browser session manager
 *
 * Commands:
 *   ps                          List running sessions
 *   launch [--url] [--cdp-port] [--name] [--json]  Start a new session
 *   expose <cdp-port> [--name] [--json]             Expose existing Chrome
 *   kill <id-or-port>           Stop a session
 */

import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";

const STATE_FILE = "/tmp/shared-browser-sessions.json";
const SCRIPT_DIR = new URL("./scripts/", import.meta.url).pathname;
const CHROME_BIN =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── Types ──

interface Session {
  id: string;
  name: string;
  cdpPort: number;
  serverPort: number;
  tunnelUrl: string;
  viewerUrl: string;
  otp: string;
  chromePid: number | null;
  serverPid: number;
  tunnelPid: number;
  startedAt: string;
}

// ── State helpers ──

function loadSessions(): Session[] {
  try {
    return JSON.parse(Deno.readTextFileSync(STATE_FILE));
  } catch {
    return [];
  }
}

function saveSessions(sessions: Session[]) {
  Deno.writeTextFileSync(STATE_FILE, JSON.stringify(sessions, null, 2));
}

function isAlive(pid: number | null): boolean {
  if (pid == null) return false;
  try {
    Deno.kill(pid, "SIGCONT"); // signal 0 equivalent — doesn't kill
    return true;
  } catch {
    return false;
  }
}

function cleanSessions(): Session[] {
  const sessions = loadSessions();
  // A session is alive if at least server or tunnel is running
  const alive = sessions.filter(
    (s) => isAlive(s.serverPid) || isAlive(s.tunnelPid),
  );
  if (alive.length !== sessions.length) saveSessions(alive);
  return alive;
}

function genId(): string {
  return crypto.randomUUID().slice(0, 8);
}

// ── Port helpers ──

async function isPortFree(port: number): Promise<boolean> {
  try {
    const l = Deno.listen({ port, hostname: "127.0.0.1" });
    l.close();
    return true;
  } catch {
    return false;
  }
}

async function findFreePort(start: number): Promise<number> {
  for (let p = start; p < start + 100; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found starting from ${start}`);
}

// ── Wait for HTTP ──

async function waitForHttp(
  url: string,
  timeoutMs = 15000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      await r.body?.cancel();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

// ── Launch Chrome ──

async function launchChrome(
  cdpPort: number,
  url: string,
): Promise<{ child: Deno.ChildProcess; pid: number }> {
  const chromeDir = `/tmp/chrome-remote-browser-${cdpPort}`;
  // Launch via nohup so Chrome survives CLI exit
  const cmd = new Deno.Command("bash", {
    args: [
      "-c",
      `nohup "${CHROME_BIN}" --remote-debugging-port=${cdpPort} --remote-allow-origins=* --user-data-dir="${chromeDir}" --no-first-run "${url}" > /dev/null 2>&1 &`,
    ],
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });
  const child = cmd.spawn();
  child.unref();
  if (!(await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`))) {
    throw new Error(`Chrome failed to start on port ${cdpPort}`);
  }
  // Get actual Chrome PID from CDP
  let chromePid = child.pid;
  try {
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    const info = await resp.json();
    // webSocketDebuggerUrl contains the PID info, but easier to just find it via lsof
    const lsof = new Deno.Command("lsof", {
      args: ["-ti", `tcp:${cdpPort}`, "-sTCP:LISTEN"],
      stdout: "piped",
      stderr: "null",
    });
    const out = await lsof.output();
    const pid = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
    if (pid) chromePid = parseInt(pid);
  } catch {}
  return { child, pid: chromePid };
}

// ── Launch viewer server ──

async function launchServer(
  cdpPort: number,
  serverPort: number,
): Promise<{ process: Deno.ChildProcess; otp: string }> {
  // Ensure ws module
  try {
    const check = new Deno.Command("node", {
      args: ["-e", "require('ws')"],
      stdout: "null",
      stderr: "null",
    });
    const { success } = await check.output();
    if (!success) {
      const install = new Deno.Command("npm", {
        args: ["install", "ws"],
        cwd: "/tmp",
        stdout: "null",
        stderr: "null",
      });
      await install.output();
    }
  } catch {
    // best effort
  }

  // Launch server via shell redirect so it survives CLI exit
  const serverLogPath = `/tmp/shared-browser-server-${serverPort}.log`;
  const serverCmd = new Deno.Command("bash", {
    args: [
      "-c",
      `node "${SCRIPT_DIR}server.mjs" --cdp-port ${cdpPort} --port ${serverPort} > "${serverLogPath}" 2>&1`,
    ],
    env: {
      ...Deno.env.toObject(),
      NODE_PATH: `${Deno.cwd()}/node_modules:/tmp/node_modules`,
    },
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });
  const child = serverCmd.spawn();
  child.unref();

  // Poll the log file for JSON ready line
  let otp = "";
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const log = await Deno.readTextFile(serverLogPath);
      // Server outputs JSON line: {"ready":true,"port":...,"cdpPort":...,"otp":"..."}
      const nlIdx = log.indexOf("\n");
      if (nlIdx !== -1) {
        try {
          const msg = JSON.parse(log.slice(0, nlIdx));
          if (msg.ready && msg.otp) {
            otp = msg.otp;
            break;
          }
        } catch { /* not valid JSON yet */ }
      }
    } catch { /* file not ready */ }
  }

  if (!otp) throw new Error("Failed to get ready signal from server");
  return { process: child, otp };
}

// ── Launch tunnel ──

async function launchTunnel(
  serverPort: number,
): Promise<{ process: Deno.ChildProcess; tunnelUrl: string }> {
  // Use isolated HOME so cloudflared ignores existing named tunnel config/certs
  const isolatedHome = "/tmp/shared-browser-cf";
  try {
    await Deno.mkdir(isolatedHome, { recursive: true });
  } catch {}

  // Redirect cloudflared output to a log file so the process survives CLI exit
  const logPath = `/tmp/shared-browser-tunnel-${serverPort}.log`;
  const shellCmd = new Deno.Command("bash", {
    args: [
      "-c",
      `HOME="${isolatedHome}" cloudflared tunnel --url "http://127.0.0.1:${serverPort}" --no-autoupdate >> "${logPath}" 2>&1`,
    ],
    stdout: "null",
    stderr: "null",
    stdin: "null",
  });
  const child = shellCmd.spawn();
  child.unref();

  // Poll the log file for the tunnel URL
  let tunnelUrl = "";
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const log = await Deno.readTextFile(logPath);
      const match = log.match(
        /(https:\/\/[a-z]+-[a-z0-9-]+\.trycloudflare\.com)/,
      );
      if (match) {
        tunnelUrl = match[1];
        break;
      }
    } catch { /* file not ready */ }
  }

  if (!tunnelUrl) {
    try {
      child.kill();
    } catch {}
    throw new Error("Failed to extract tunnel URL from cloudflared");
  }

  return { process: child, tunnelUrl };
}

// ── Commands ──

async function cmdPs(flags: ReturnType<typeof parse>) {
  const sessions = cleanSessions();
  const json = flags.json;

  if (json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log("No active sessions.");
    return;
  }

  for (const s of sessions) {
    const uptime = Math.round(
      (Date.now() - new Date(s.startedAt).getTime()) / 60000,
    );
    const chromeOk = isAlive(s.chromePid) ? "✓" : "✗";
    const serverOk = isAlive(s.serverPid) ? "✓" : "✗";
    const tunnelOk = isAlive(s.tunnelPid) ? "✓" : "✗";
    console.log(
      `${s.id} (${s.name})  CDP:${s.cdpPort}  Server:${s.serverPort}  ${uptime}m uptime`,
    );
    console.log(
      `  Chrome ${chromeOk}  Server ${serverOk}  Tunnel ${tunnelOk}`,
    );
    console.log(`  Viewer: ${s.viewerUrl}`);
    console.log(`  OTP: ${s.otp}`);
    console.log();
  }
}

async function cmdLaunch(flags: ReturnType<typeof parse>) {
  const url = (flags.url as string) || "about:blank";
  const name = (flags.name as string) || "browser";
  let cdpPort = flags["cdp-port"]
    ? Number(flags["cdp-port"])
    : await findFreePort(19222);

  // Check if Chrome already on this port
  let chromePid: number | null = null;
  let chromeAlready = false;
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    await r.body?.cancel();
    chromeAlready = true;
    // Get PID of existing Chrome
    try {
      const lsof = new Deno.Command("lsof", {
        args: ["-ti", `tcp:${cdpPort}`, "-sTCP:LISTEN"],
        stdout: "piped",
        stderr: "null",
      });
      const out = await lsof.output();
      const pid = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
      if (pid) chromePid = parseInt(pid);
    } catch {}
    console.log(`✓ Chrome already running on :${cdpPort}`);
  } catch {
    // need to launch
  }

  if (!chromeAlready) {
    if (!(await isPortFree(cdpPort))) {
      cdpPort = await findFreePort(cdpPort + 1);
    }
    console.log(`→ Launching Chrome on :${cdpPort}...`);
    const chrome = await launchChrome(cdpPort, url);
    chromePid = chrome.pid;
    console.log(`✓ Chrome ready (PID ${chromePid})`);
  }

  const serverPort = await findFreePort(cdpPort + 2);
  console.log(`→ Starting viewer server on :${serverPort}...`);
  const { process: serverProc, otp } = await launchServer(cdpPort, serverPort);
  console.log(`✓ Server ready (PID ${serverProc.pid}), OTP: ${otp}`);

  console.log(`→ Starting tunnel...`);
  const { process: tunnelProc, tunnelUrl } = await launchTunnel(serverPort);
  console.log(`✓ Tunnel ready (PID ${tunnelProc.pid})`);

  const session: Session = {
    id: genId(),
    name,
    cdpPort,
    serverPort,
    tunnelUrl,
    viewerUrl: `${tunnelUrl}/viewer`,
    otp,
    chromePid,
    serverPid: serverProc.pid,
    tunnelPid: tunnelProc.pid,
    startedAt: new Date().toISOString(),
  };

  const sessions = loadSessions();
  sessions.push(session);
  saveSessions(sessions);

  if (flags.json) {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.log();
    console.log("════════════════════════════════════════");
    console.log("✅ Remote Browser Ready!");
    console.log();
    console.log(`   Viewer: ${session.viewerUrl}`);
    console.log(`   OTP:    ${session.otp}`);
    console.log(`   CDP:    127.0.0.1:${session.cdpPort}`);
    console.log(`   ID:     ${session.id}`);
    console.log("════════════════════════════════════════");
  }
}

async function cmdExpose(flags: ReturnType<typeof parse>) {
  const target = flags._[1];
  if (!target) {
    console.error("Usage: shared-browser expose <cdp-port>");
    Deno.exit(1);
  }
  const cdpPort = Number(target);

  // Verify Chrome is running
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    await r.body?.cancel();
  } catch {
    console.error(`No Chrome found on port ${cdpPort}`);
    Deno.exit(1);
  }

  const name = (flags.name as string) || `exposed-${cdpPort}`;
  const serverPort = await findFreePort(cdpPort + 2);

  console.log(`→ Starting viewer server on :${serverPort}...`);
  const { process: serverProc, otp } = await launchServer(cdpPort, serverPort);
  console.log(`✓ Server ready, OTP: ${otp}`);

  console.log(`→ Starting tunnel...`);
  const { process: tunnelProc, tunnelUrl } = await launchTunnel(serverPort);
  console.log(`✓ Tunnel ready`);

  const session: Session = {
    id: genId(),
    name,
    cdpPort,
    serverPort,
    tunnelUrl,
    viewerUrl: `${tunnelUrl}/viewer`,
    otp,
    chromePid: null,
    serverPid: serverProc.pid,
    tunnelPid: tunnelProc.pid,
    startedAt: new Date().toISOString(),
  };

  const sessions = loadSessions();
  sessions.push(session);
  saveSessions(sessions);

  if (flags.json) {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.log();
    console.log("════════════════════════════════════════");
    console.log("✅ Session Exposed!");
    console.log();
    console.log(`   Viewer: ${session.viewerUrl}`);
    console.log(`   OTP:    ${session.otp}`);
    console.log("════════════════════════════════════════");
  }
}

async function cmdKill(flags: ReturnType<typeof parse>) {
  const target = String(flags._[1] || "");
  if (!target) {
    console.error("Usage: shared-browser kill <id-or-port>");
    Deno.exit(1);
  }

  const sessions = loadSessions();
  const idx = sessions.findIndex(
    (s) => s.id === target || String(s.cdpPort) === target || s.name === target,
  );

  if (idx === -1) {
    console.error(`Session not found: ${target}`);
    Deno.exit(1);
  }

  const s = sessions[idx];
  const killed: string[] = [];

  for (
    const [label, pid] of [
      ["Chrome", s.chromePid],
      ["Server", s.serverPid],
      ["Tunnel", s.tunnelPid],
    ] as const
  ) {
    if (pid && isAlive(pid)) {
      try {
        Deno.kill(pid, "SIGTERM");
        killed.push(`${label}(${pid})`);
      } catch {}
    }
  }

  sessions.splice(idx, 1);
  saveSessions(sessions);

  console.log(
    `Killed session ${s.id} (${s.name}): ${
      killed.join(", ") || "no live processes"
    }`,
  );
}

// ── Main ──

const flags = parse(Deno.args, {
  string: ["url", "cdp-port", "name"],
  boolean: ["json", "help"],
});

const command = String(flags._[0] || "");

switch (command) {
  case "ps":
    await cmdPs(flags);
    break;
  case "launch":
    await cmdLaunch(flags);
    break;
  case "expose":
    await cmdExpose(flags);
    break;
  case "kill":
    await cmdKill(flags);
    break;
  default:
    console.log(`shared-browser — Browser session manager

Commands:
  ps                              List running sessions
  launch [--url <url>] [--name]   Start a new session
  expose <cdp-port> [--name]      Expose existing Chrome
  kill <id-or-port>               Stop a session

Flags:
  --json          JSON output
  --cdp-port <n>  CDP port (default: auto)
  --url <url>     Initial URL (default: about:blank)
  --name <name>   Session name`);
    break;
}
