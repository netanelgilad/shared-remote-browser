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
const LOCK_FILE = "/tmp/shared-browser-sessions.lock";
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
  chromeLabel?: string | null;
  ownsChrome: boolean;
  profileDir: string | null;
  serverPid: number;
  serverLabel?: string;
  tunnelPid: number;
  tunnelLabel?: string;
  startedAt: string;
}

interface ManagedProcess {
  pid: number;
  label: string;
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
  const temporary = `${STATE_FILE}.${Deno.pid}.tmp`;
  Deno.writeTextFileSync(temporary, JSON.stringify(sessions, null, 2), {
    mode: 0o600,
  });
  Deno.chmodSync(temporary, 0o600);
  Deno.renameSync(temporary, STATE_FILE);
}

function isAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    return new Deno.Command("/bin/kill", {
      args: ["-0", String(pid)],
      stdout: "null",
      stderr: "null",
    }).outputSync().success;
  } catch {
    return false;
  }
}

async function withRegistryLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 75_000;
  let lock: Deno.FsFile | null = null;
  while (!lock) {
    try {
      lock = Deno.openSync(LOCK_FILE, {
        write: true,
        createNew: true,
        mode: 0o600,
      });
      lock.writeSync(new TextEncoder().encode(`${Deno.pid}\n`));
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      try {
        const stat = Deno.statSync(LOCK_FILE);
        if (Date.now() - (stat.mtime?.getTime() || 0) > 70_000) {
          Deno.removeSync(LOCK_FILE);
          continue;
        }
      } catch (statError) {
        if (!(statError instanceof Deno.errors.NotFound)) throw statError;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the session registry lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await operation();
  } finally {
    lock.close();
    try {
      Deno.removeSync(LOCK_FILE);
    } catch {
      // The lock may already have been cleaned after an interrupted command.
    }
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

function progress(flags: ReturnType<typeof parse>, message = "") {
  if (flags.json) console.error(message);
  else console.log(message);
}

// ── Port helpers ──

function isPortFree(port: number): boolean {
  try {
    const l = Deno.listen({ port, hostname: "127.0.0.1" });
    l.close();
    return true;
  } catch {
    return false;
  }
}

function findFreePort(start: number): number {
  for (let p = start; p < start + 100; p++) {
    if (isPortFree(p)) return p;
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
  profileDir: string,
  label: string,
): Promise<ManagedProcess> {
  const process = await submitManagedProcess(
    label,
    CHROME_BIN,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      url,
    ],
    "/dev/null",
  );
  if (!(await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`))) {
    terminateProcess(process.pid, process.label);
    throw new Error(`Chrome failed to start on port ${cdpPort}`);
  }
  // Get actual Chrome PID from CDP
  let chromePid = process.pid;
  try {
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    await resp.body?.cancel();
    // webSocketDebuggerUrl contains the PID info, but easier to just find it via lsof
    const lsof = new Deno.Command("lsof", {
      args: ["-ti", `tcp:${cdpPort}`, "-sTCP:LISTEN"],
      stdout: "piped",
      stderr: "null",
    });
    const out = await lsof.output();
    const pid = new TextDecoder().decode(out.stdout).trim().split("\n")[0];
    if (pid) chromePid = parseInt(pid);
  } catch {
    // Fall back to the launcher PID when lsof is unavailable.
  }
  return { pid: chromePid, label };
}

// ── Launch viewer server ──

async function launchServer(
  cdpPort: number,
  serverPort: number,
  label: string,
): Promise<{ process: ManagedProcess; otp: string }> {
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

  const serverLogPath = `/tmp/shared-browser-server-${serverPort}.log`;
  const node = executablePath("node");
  const child = await submitManagedProcess(
    label,
    node,
    [
      `${SCRIPT_DIR}server.mjs`,
      "--cdp-port",
      String(cdpPort),
      "--port",
      String(serverPort),
    ],
    serverLogPath,
  );

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
  label: string,
): Promise<{ process: ManagedProcess; tunnelUrl: string }> {
  // Use an explicit empty config so a named tunnel configuration is untouched.
  const logPath = `/tmp/shared-browser-tunnel-${serverPort}.log`;
  const cloudflared = executablePath("cloudflared");
  const child = await submitManagedProcess(
    label,
    cloudflared,
    [
      "tunnel",
      "--config",
      "/dev/null",
      "--url",
      `http://127.0.0.1:${serverPort}`,
      "--no-autoupdate",
    ],
    logPath,
  );

  // Poll the log file for the tunnel URL
  let tunnelUrl = "";
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const log = await Deno.readTextFile(logPath);
      const match = log.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (match) {
        tunnelUrl = match[1];
        break;
      }
    } catch { /* file not ready */ }
  }

  if (!tunnelUrl) {
    try {
      terminateProcess(child.pid, child.label);
    } catch {
      // The tunnel may already have exited.
    }
    throw new Error("Failed to extract tunnel URL from cloudflared");
  }

  return { process: child, tunnelUrl };
}

// ── Commands ──

function cmdPs(flags: ReturnType<typeof parse>) {
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
  const sessionId = genId();
  const profileDir = `/tmp/shared-browser-profile-${sessionId}`;
  const chromeLabel = `com.shared-browser.${sessionId}.chrome`;
  const serverLabel = `com.shared-browser.${sessionId}.server`;
  const tunnelLabel = `com.shared-browser.${sessionId}.tunnel`;
  let cdpPort = flags["cdp-port"]
    ? Number(flags["cdp-port"])
    : await findFreePort(19222);

  // Check if Chrome already on this port
  let chromePid: number | null = null;
  let ownsChrome = false;
  let chromeAlready = false;
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    await r.body?.cancel();
    chromeAlready = true;
    progress(flags, `✓ Chrome already running on :${cdpPort}`);
  } catch {
    // need to launch
  }

  if (!chromeAlready) {
    if (!isPortFree(cdpPort)) {
      cdpPort = await findFreePort(cdpPort + 1);
    }
    progress(flags, `→ Launching Chrome on :${cdpPort}...`);
    const chrome = await launchChrome(cdpPort, url, profileDir, chromeLabel);
    chromePid = chrome.pid;
    ownsChrome = true;
    progress(flags, `✓ Chrome ready (PID ${chromePid})`);
  }

  let serverProc: ManagedProcess | null = null;
  let tunnelProc: ManagedProcess | null = null;
  let session: Session;
  try {
    const serverPort = await findFreePort(cdpPort + 2);
    progress(flags, `→ Starting viewer server on :${serverPort}...`);
    const server = await launchServer(cdpPort, serverPort, serverLabel);
    serverProc = server.process;
    progress(
      flags,
      `✓ Server ready (PID ${serverProc.pid}), OTP: ${server.otp}`,
    );

    progress(flags, `→ Starting tunnel...`);
    const tunnel = await launchTunnel(serverPort, tunnelLabel);
    tunnelProc = tunnel.process;
    progress(flags, `✓ Tunnel ready (PID ${tunnelProc.pid})`);

    session = {
      id: sessionId,
      name,
      cdpPort,
      serverPort,
      tunnelUrl: tunnel.tunnelUrl,
      viewerUrl: `${tunnel.tunnelUrl}/viewer`,
      otp: server.otp,
      chromePid,
      chromeLabel: ownsChrome ? chromeLabel : null,
      ownsChrome,
      profileDir: ownsChrome ? profileDir : null,
      serverPid: serverProc.pid,
      serverLabel,
      tunnelPid: tunnelProc.pid,
      tunnelLabel,
      startedAt: new Date().toISOString(),
    };

    const sessions = loadSessions();
    sessions.push(session);
    saveSessions(sessions);
  } catch (error) {
    terminateProcess(tunnelProc?.pid, tunnelProc?.label);
    terminateProcess(serverProc?.pid, serverProc?.label);
    if (ownsChrome) terminateProcess(chromePid, chromeLabel);
    if (ownsChrome) await removeOwnedProfile(profileDir);
    throw error;
  }

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
  const sessionId = genId();
  const serverLabel = `com.shared-browser.${sessionId}.server`;
  const tunnelLabel = `com.shared-browser.${sessionId}.tunnel`;
  const serverPort = await findFreePort(cdpPort + 2);

  progress(flags, `→ Starting viewer server on :${serverPort}...`);
  const { process: serverProc, otp } = await launchServer(
    cdpPort,
    serverPort,
    serverLabel,
  );
  progress(flags, `✓ Server ready, OTP: ${otp}`);

  let tunnelProc: ManagedProcess;
  let tunnelUrl: string;
  try {
    progress(flags, `→ Starting tunnel...`);
    const tunnel = await launchTunnel(serverPort, tunnelLabel);
    tunnelProc = tunnel.process;
    tunnelUrl = tunnel.tunnelUrl;
    progress(flags, `✓ Tunnel ready`);
  } catch (error) {
    terminateProcess(serverProc.pid, serverProc.label);
    throw error;
  }

  const session: Session = {
    id: sessionId,
    name,
    cdpPort,
    serverPort,
    tunnelUrl,
    viewerUrl: `${tunnelUrl}/viewer`,
    otp,
    chromePid: null,
    chromeLabel: null,
    ownsChrome: false,
    profileDir: null,
    serverPid: serverProc.pid,
    serverLabel,
    tunnelPid: tunnelProc.pid,
    tunnelLabel,
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
    const [name, pid, jobLabel] of [
      ["Chrome", s.ownsChrome ? s.chromePid : null, s.chromeLabel],
      ["Server", s.serverPid, s.serverLabel],
      ["Tunnel", s.tunnelPid, s.tunnelLabel],
    ] as const
  ) {
    if (jobLabel || (pid && isAlive(pid))) {
      terminateProcess(pid, jobLabel);
      killed.push(`${name}(${pid || "launchd"})`);
    }
  }

  sessions.splice(idx, 1);
  saveSessions(sessions);

  if (s.ownsChrome && s.profileDir) await removeOwnedProfile(s.profileDir);

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

function executablePath(name: string): string {
  const result = new Deno.Command("/usr/bin/which", {
    args: [name],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  const resolved = new TextDecoder().decode(result.stdout).trim();
  if (!result.success || !resolved.startsWith("/")) {
    throw new Error(`${name} was not found in PATH`);
  }
  return resolved;
}

async function submitManagedProcess(
  label: string,
  program: string,
  args: string[],
  logPath: string,
): Promise<ManagedProcess> {
  if (logPath !== "/dev/null") {
    Deno.writeTextFileSync(logPath, "", { mode: 0o600 });
    Deno.chmodSync(logPath, 0o600);
  }
  const result = await new Deno.Command("launchctl", {
    args: [
      "submit",
      "-l",
      label,
      "-o",
      logPath,
      "-e",
      logPath,
      "--",
      program,
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(
      `launchd could not start ${label}${detail ? `: ${detail}` : ""}`,
    );
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = managedProcessPid(label);
    if (pid) return { pid, label };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  terminateProcess(null, label);
  throw new Error(`launchd did not report a PID for ${label}`);
}

function managedProcessPid(label: string): number | null {
  const result = new Deno.Command("launchctl", {
    args: ["print", `gui/${Deno.uid()}/${label}`],
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!result.success) return null;
  const match = new TextDecoder().decode(result.stdout).match(
    /^\s*pid = (\d+)$/m,
  );
  const pid = match ? Number.parseInt(match[1], 10) : 0;
  return pid > 1 ? pid : null;
}

function terminateProcess(
  pid: number | undefined | null,
  label?: string | null,
) {
  if (label) {
    new Deno.Command("launchctl", {
      args: ["remove", label],
      stdout: "null",
      stderr: "null",
    }).outputSync();
  }
  if (!pid || !isAlive(pid)) return;
  try {
    Deno.kill(pid, "SIGTERM");
  } catch {
    // The child may have exited between the liveness check and the signal.
  }
}

async function removeOwnedProfile(profileDir: string) {
  if (!/^\/tmp\/shared-browser-profile-[a-f0-9]{8}$/.test(profileDir)) return;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await Deno.remove(profileDir, { recursive: true });
      return;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

await withRegistryLock(async () => {
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
});
