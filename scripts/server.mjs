/**
 * Shared Remote Browser server.
 *
 * One browser-level CDP connection owns target discovery and one active page
 * screencast. Viewer WebSockets subscribe to that shared stream, so reconnects
 * and additional observers never start competing screencasts.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket, WebSocketServer } from "ws";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

function getArg(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const CDP_PORT = parseInteger(getArg("cdp-port", "19222"), 19222, 1, 65535);
const PORT = parseInteger(getArg("port", "19224"), 19224, 1, 65535);
const QUALITY = parseInteger(getArg("quality", "60"), 60, 20, 90);
const MAX_CLIENT_BUFFER = 1_500_000;
const MAX_MESSAGE_SIZE = 64 * 1024;
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILURES = 8;

const assets = new Map([
  ["/viewer", ["viewer.html", "text/html; charset=utf-8"]],
  ["/", ["viewer.html", "text/html; charset=utf-8"]],
  ["/viewer.js", ["viewer.js", "text/javascript; charset=utf-8"]],
  ["/viewer.css", ["viewer.css", "text/css; charset=utf-8"]],
]);
for (const [route, [file, type]] of assets) {
  assets.set(route, {
    body: fs.readFileSync(path.join(SCRIPT_DIR, file)),
    type,
  });
}
const authHtml = fs.readFileSync(path.join(SCRIPT_DIR, "auth.html"));

const OTP = String(crypto.randomInt(100000, 1000000));
const otpExpiresAt = Date.now() + OTP_TTL_MS;
const validSessions = new Map();
const authFailures = new Map();

function parseInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = value.join("=");
  }
  return cookies;
}

function authenticatedToken(req) {
  const token = parseCookies(req.headers.cookie)["rb-auth"];
  const session = token && validSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    validSessions.delete(token);
    return null;
  }
  return token;
}

function requestIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(
    Array.isArray(forwarded)
      ? forwarded[0]
      : forwarded || req.socket.remoteAddress || "unknown",
  )
    .split(",")[0]
    .trim();
}

function isRateLimited(ip) {
  const now = Date.now();
  const record = authFailures.get(ip);
  if (!record || now - record.startedAt > AUTH_WINDOW_MS) {
    authFailures.set(ip, { startedAt: now, failures: 0 });
    return false;
  }
  return record.failures >= AUTH_MAX_FAILURES;
}

function recordAuthFailure(ip) {
  const record = authFailures.get(ip) || { startedAt: Date.now(), failures: 0 };
  record.failures += 1;
  authFailures.set(ip, record);
}

function secureRequest(req) {
  return req.headers["x-forwarded-proto"] === "https" ||
    req.socket.encrypted === true;
}

function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  validSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  const secure = secureRequest(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `rb-auth=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${
      Math.floor(SESSION_TTL_MS / 1000)
    }${secure}`,
  );
}

function setSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
}

function sendJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error("body-too-large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    req.on("error", reject);
  });
}

function socketOriginAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function publicTarget(target) {
  return {
    id: target.targetId,
    title: target.title || "Untitled",
    url: target.url || "about:blank",
    openerId: target.openerId || null,
  };
}

function isViewableTarget(target) {
  return target?.type === "page" &&
    !String(target.url || "").startsWith("devtools://") &&
    !String(target.url || "").startsWith("chrome-extension://");
}

class CdpHub {
  constructor() {
    this.browserWs = null;
    this.pending = new Map();
    this.nextId = 1;
    this.targets = new Map();
    this.activeTargetId = null;
    this.activeSessionId = null;
    this.latestFrame = null;
    this.frameSequence = 0;
    this.pendingFrameAck = null;
    this.lastAckAt = 0;
    this.interactiveUntil = 0;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.stopped = false;
    this.switchChain = Promise.resolve();
    this.frameRefresh = null;
    this.visible = true;
  }

  async start() {
    this.stopped = false;
    await this.connect().catch((error) => {
      logError("Initial CDP connection failed", error);
      this.scheduleReconnect();
    });
  }

  async connect() {
    if (this.stopped || this.browserWs?.readyState === WebSocket.OPEN) return;
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (!response.ok) {
      throw new Error(`CDP discovery returned ${response.status}`);
    }
    const version = await response.json();
    if (!version.webSocketDebuggerUrl) {
      throw new Error("Missing browser WebSocket URL");
    }

    const ws = new WebSocket(version.webSocketDebuggerUrl, {
      maxPayload: 16 * 1024 * 1024,
    });
    this.browserWs = ws;
    ws.on("message", (raw) => this.onBrowserMessage(ws, raw));
    ws.on("close", () => this.onBrowserClose(ws));
    ws.on("error", (error) => logError("Browser CDP socket error", error));
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    this.reconnectAttempt = 0;
    await this.request("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await this.request("Target.getTargets");
    for (const target of targetInfos) this.updateTarget(target, false);
    broadcastState();
    if (!this.activeTargetId || !this.targets.has(this.activeTargetId)) {
      const first = this.targets.keys().next().value;
      if (first) await this.selectTarget(first, "initial");
    }
  }

  onBrowserMessage(ws, raw) {
    if (ws !== this.browserWs) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(
          new Error(message.error.message || "CDP command failed"),
        );
      } else pending.resolve(message.result || {});
      return;
    }

    if (
      message.method === "Target.targetCreated" ||
      message.method === "Target.targetInfoChanged"
    ) {
      this.updateTarget(message.params.targetInfo, true);
      return;
    }
    if (message.method === "Target.targetDestroyed") {
      this.removeTarget(message.params.targetId);
      return;
    }
    if (message.sessionId === this.activeSessionId) this.onPageEvent(message);
  }

  onBrowserClose(ws) {
    if (ws !== this.browserWs) return;
    this.browserWs = null;
    this.activeSessionId = null;
    this.flushFrameAck();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("CDP disconnected"));
    }
    this.pending.clear();
    broadcastState();
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(10000, 500 * (2 ** this.reconnectAttempt++)) +
      Math.floor(Math.random() * 250);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        logError("CDP reconnect failed", error);
        this.scheduleReconnect();
      });
    }, delay);
  }

  request(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      if (this.browserWs?.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP is not connected"));
        return;
      }
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.browserWs.send(JSON.stringify(message));
    });
  }

  send(method, params = {}, sessionId = this.activeSessionId) {
    this.request(method, params, sessionId).catch((error) =>
      logError(`${method} failed`, error)
    );
  }

  updateTarget(target, allowPopupSwitch) {
    if (!isViewableTarget(target)) {
      if (target?.targetId) this.removeTarget(target.targetId);
      return;
    }
    const isNew = !this.targets.has(target.targetId);
    this.targets.set(target.targetId, target);
    broadcastTargets();

    if (!this.activeTargetId) {
      this.selectTarget(target.targetId, "first-target");
    } else if (
      allowPopupSwitch &&
      isNew &&
      target.openerId === this.activeTargetId
    ) {
      setTimeout(() => {
        if (this.targets.has(target.targetId)) {
          this.selectTarget(target.targetId, "popup");
        }
      }, 150);
    }
  }

  removeTarget(targetId) {
    if (!this.targets.delete(targetId)) return;
    broadcastTargets();
    if (targetId !== this.activeTargetId) return;
    this.activeTargetId = null;
    this.activeSessionId = null;
    this.latestFrame = null;
    const fallback = this.targets.keys().next().value;
    if (fallback) this.selectTarget(fallback, "target-closed");
    else broadcastState();
  }

  selectTarget(targetId, reason = "viewer") {
    this.switchChain = this.switchChain
      .then(() => this.performTargetSwitch(targetId, reason))
      .catch((error) => logError("Target switch failed", error));
    return this.switchChain;
  }

  async performTargetSwitch(targetId, reason) {
    if (
      !this.targets.has(targetId) ||
      this.browserWs?.readyState !== WebSocket.OPEN
    ) return;
    if (targetId === this.activeTargetId && this.activeSessionId) return;

    const previousSession = this.activeSessionId;
    this.activeSessionId = null;
    this.flushFrameAck();
    if (previousSession) {
      await this.request("Page.stopScreencast", {}, previousSession).catch(
        () => {},
      );
      await this.request("Target.detachFromTarget", {
        sessionId: previousSession,
      }).catch(() => {});
    }

    const result = await this.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.activeTargetId = targetId;
    this.activeSessionId = result.sessionId;
    this.latestFrame = null;
    this.visible = true;
    await this.request("Page.enable", {}, result.sessionId);
    await this.request("Page.bringToFront", {}, result.sessionId).catch(
      () => {},
    );
    await this.startScreencast(result.sessionId);
    log(
      `Active target (${reason}): ${
        this.targets.get(targetId)?.url || targetId
      }`,
    );
    broadcastSnapshot();
  }

  startScreencast(sessionId = this.activeSessionId) {
    return this.request("Page.startScreencast", {
      format: "jpeg",
      quality: QUALITY,
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    }, sessionId);
  }

  ensureViewerFrame() {
    if (this.latestFrame || !this.activeSessionId || this.frameRefresh) {
      return this.frameRefresh;
    }
    const sessionId = this.activeSessionId;
    this.frameRefresh = (async () => {
      // Chrome can begin a screencast before its first composited frame exists. A
      // static page would then remain blank for the first viewer until it paints
      // again, so restart the stream once when there is no cached frame.
      await this.request("Page.stopScreencast", {}, sessionId).catch(() => {});
      if (sessionId === this.activeSessionId) {
        await this.startScreencast(sessionId);
      }
    })().finally(() => {
      this.frameRefresh = null;
    });
    return this.frameRefresh;
  }

  onPageEvent(message) {
    const { method, params = {} } = message;
    if (method === "Page.screencastFrame") {
      this.onScreencastFrame(params, message.sessionId);
      return;
    }
    if (method === "Page.screencastVisibilityChanged") {
      this.visible = params.visible !== false;
      broadcastState();
      return;
    }
    if (
      method === "Page.frameNavigated" && params.frame && !params.frame.parentId
    ) {
      const target = this.targets.get(this.activeTargetId);
      if (target) {
        target.url = params.frame.url;
        broadcastTargets();
      }
      return;
    }
    if (method === "Page.javascriptDialogOpening") {
      broadcast({
        type: "dialog",
        dialogType: params.type,
        message: params.message,
        defaultPrompt: params.defaultPrompt || "",
      });
    }
  }

  onScreencastFrame(params, sessionId) {
    const sequence = ++this.frameSequence;
    const payload = JSON.stringify({
      type: "frame",
      sequence,
      data: params.data,
      metadata: params.metadata,
    });
    this.latestFrame = payload;
    for (const client of viewerClients) {
      if (client.ws.readyState !== WebSocket.OPEN) continue;
      if (client.ws.bufferedAmount > MAX_CLIENT_BUFFER) {
        client.droppedFrames += 1;
        continue;
      }
      client.ws.send(payload);
    }

    this.pendingFrameAck = {
      sequence,
      sessionId,
      cdpSessionId: params.sessionId,
      receivedAt: Date.now(),
    };
    this.scheduleFrameAck();
  }

  scheduleFrameAck() {
    if (!this.pendingFrameAck) return;
    const now = Date.now();
    const interval = now < this.interactiveUntil ? 34 : 67;
    const delay = Math.max(0, this.lastAckAt + interval - now);
    clearTimeout(this.frameAckTimer);
    this.frameAckTimer = setTimeout(() => this.tryFrameAck(), delay);
  }

  tryFrameAck() {
    const pending = this.pendingFrameAck;
    if (!pending) return;
    const controller = controllerClient();
    const saturated = controller?.ws.bufferedAmount > MAX_CLIENT_BUFFER;
    const painted = !controller || controller.lastPainted >= pending.sequence;
    const waitedLongEnough = Date.now() - pending.receivedAt >= 180;
    if ((saturated || !painted) && !waitedLongEnough) {
      this.frameAckTimer = setTimeout(() => this.tryFrameAck(), 20);
      return;
    }
    this.pendingFrameAck = null;
    this.lastAckAt = Date.now();
    this.send(
      "Page.screencastFrameAck",
      { sessionId: pending.cdpSessionId },
      pending.sessionId,
    );
  }

  flushFrameAck() {
    clearTimeout(this.frameAckTimer);
    const pending = this.pendingFrameAck;
    this.pendingFrameAck = null;
    if (pending && this.browserWs?.readyState === WebSocket.OPEN) {
      this.send(
        "Page.screencastFrameAck",
        { sessionId: pending.cdpSessionId },
        pending.sessionId,
      );
    }
  }

  boost() {
    this.interactiveUntil = Math.max(this.interactiveUntil, Date.now() + 750);
    this.scheduleFrameAck();
  }

  async navigateHistory(delta) {
    if (!this.activeSessionId) return;
    const history = await this.request(
      "Page.getNavigationHistory",
      {},
      this.activeSessionId,
    );
    const entry = history.entries?.[history.currentIndex + delta];
    if (entry) this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.flushFrameAck();
    if (this.activeSessionId) {
      await this.request("Page.stopScreencast", {}, this.activeSessionId).catch(
        () => {},
      );
    }
    this.browserWs?.close();
  }
}

const viewerClients = new Set();
let controllerToken = null;
let controlReleaseTimer = null;
let handoff = { status: "idle", updatedAt: new Date().toISOString() };
const hub = new CdpHub();

function controllerClient() {
  if (!controllerToken) return null;
  return [...viewerClients].find((client) =>
    client.token === controllerToken
  ) || null;
}

function isController(client) {
  return Boolean(controllerToken && client.token === controllerToken);
}

function claimControl(client) {
  clearTimeout(controlReleaseTimer);
  controllerToken = client.token;
  handoff = {
    status: "human-controlling",
    updatedAt: new Date().toISOString(),
  };
  broadcastState();
}

function releaseControl(client, completed = false) {
  if (!isController(client)) return;
  controllerToken = null;
  handoff = {
    status: completed ? "complete" : "idle",
    updatedAt: new Date().toISOString(),
  };
  broadcastState();
}

function broadcast(message) {
  const payload = typeof message === "string"
    ? message
    : JSON.stringify(message);
  for (const client of viewerClients) {
    if (
      client.ws.readyState === WebSocket.OPEN &&
      client.ws.bufferedAmount < MAX_CLIENT_BUFFER
    ) {
      client.ws.send(payload);
    }
  }
}

function targetsMessage() {
  return {
    type: "targets",
    activeTargetId: hub.activeTargetId,
    targets: [...hub.targets.values()].map(publicTarget),
  };
}

function stateMessage(client = null) {
  return {
    type: "state",
    connected: hub.browserWs?.readyState === WebSocket.OPEN &&
      Boolean(hub.activeSessionId),
    visible: hub.visible,
    controller: client ? isController(client) : null,
    hasController: Boolean(controllerToken),
    handoff,
  };
}

function broadcastTargets() {
  broadcast(targetsMessage());
}

function broadcastState() {
  for (const client of viewerClients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(stateMessage(client)));
    }
  }
}

function broadcastSnapshot() {
  for (const client of viewerClients) sendSnapshot(client);
}

function sendSnapshot(client) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(JSON.stringify({ type: "hello", viewerId: client.id }));
  client.ws.send(JSON.stringify(stateMessage(client)));
  client.ws.send(JSON.stringify(targetsMessage()));
  if (hub.latestFrame && client.ws.bufferedAmount < MAX_CLIENT_BUFFER) {
    client.ws.send(hub.latestFrame);
  }
}

function finiteNumber(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : null;
}

function validUrl(input) {
  let value = String(input || "").trim();
  if (!value) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) value = `https://${value}`;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "about:"].includes(parsed.protocol)
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

const SPECIAL_KEYS = {
  Backspace: ["Backspace", "Backspace", 8],
  Delete: ["Delete", "Delete", 46],
  Enter: ["Enter", "Enter", 13],
  Tab: ["Tab", "Tab", 9],
  Escape: ["Escape", "Escape", 27],
  ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
  ArrowUp: ["ArrowUp", "ArrowUp", 38],
  ArrowRight: ["ArrowRight", "ArrowRight", 39],
  ArrowDown: ["ArrowDown", "ArrowDown", 40],
};

function dispatchKey(key, modifiers = 0) {
  const [name, code, keyCode] = SPECIAL_KEYS[key] ||
    [String(key).slice(0, 32), String(key).slice(0, 32), 0];
  const base = {
    key: name,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  };
  hub.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  hub.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

async function handleViewerMessage(client, raw) {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_SIZE) {
    return client.ws.close(1009, "Message too large");
  }
  const now = Date.now();
  if (now - client.rateWindowAt > 1000) {
    client.rateWindowAt = now;
    client.rateCount = 0;
  }
  if (++client.rateCount > 240) return client.ws.close(1008, "Rate limit");

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (message.type === "frame-painted") {
    client.lastPainted = Math.max(
      client.lastPainted,
      Number(message.sequence) || 0,
    );
    return;
  }
  if (message.type === "claim-control") {
    claimControl(client);
    return;
  }
  if (!isController(client)) return;

  hub.boost();
  handoff = {
    status: "human-controlling",
    updatedAt: new Date().toISOString(),
  };

  switch (message.type) {
    case "handoff-complete":
      releaseControl(client, true);
      return;
    case "switch-target":
      if (hub.targets.has(message.targetId)) hub.selectTarget(message.targetId);
      return;
    case "navigate": {
      const url = validUrl(message.url);
      if (url) hub.send("Page.navigate", { url });
      return;
    }
    case "history":
      await hub.navigateHistory(message.delta < 0 ? -1 : 1).catch((error) =>
        logError("History navigation failed", error)
      );
      return;
    case "reload":
      hub.send("Page.reload", { ignoreCache: false });
      return;
    case "text":
      if (typeof message.text === "string" && message.text.length <= 8192) {
        hub.send("Input.insertText", { text: message.text });
      }
      return;
    case "key":
      if (typeof message.key === "string") {
        dispatchKey(message.key, parseInteger(message.modifiers, 0, 0, 15));
      }
      return;
    case "click": {
      const x = finiteNumber(message.x, 0, 100000);
      const y = finiteNumber(message.y, 0, 100000);
      if (x === null || y === null) return;
      const button = ["left", "right", "middle"].includes(message.button)
        ? message.button
        : "left";
      const clickCount = parseInteger(message.clickCount, 1, 1, 3);
      hub.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        clickCount,
      });
      hub.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        clickCount,
      });
      return;
    }
    case "pointer": {
      const x = finiteNumber(message.x, 0, 100000);
      const y = finiteNumber(message.y, 0, 100000);
      if (x === null || y === null) return;
      const allowed = {
        down: "mousePressed",
        move: "mouseMoved",
        up: "mouseReleased",
      };
      const type = allowed[message.action];
      if (!type) return;
      const button =
        ["left", "right", "middle", "none"].includes(message.button)
          ? message.button
          : "left";
      const buttonMask = { left: 1, right: 2, middle: 4, none: 0 }[button];
      const clickCount = parseInteger(message.clickCount, 1, 1, 3);
      hub.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button,
        buttons: message.buttons ? buttonMask : 0,
        clickCount,
      });
      return;
    }
    case "scroll": {
      const x = finiteNumber(message.x, 0, 100000);
      const y = finiteNumber(message.y, 0, 100000);
      const deltaX = finiteNumber(message.deltaX, -2000, 2000);
      const deltaY = finiteNumber(message.deltaY, -2000, 2000);
      if ([x, y, deltaX, deltaY].some((value) => value === null)) return;
      hub.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
      });
      return;
    }
    case "blur":
      hub.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 0,
        y: 0,
        button: "left",
        buttons: 0,
      });
      return;
    case "dialog-response":
      hub.send("Page.handleJavaScriptDialog", {
        accept: message.accept !== false,
        promptText: typeof message.promptText === "string"
          ? message.promptText.slice(0, 8192)
          : "",
      });
      return;
  }
}

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_SIZE,
});

const server = http.createServer(async (req, res) => {
  setSecurityHeaders(res);
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/auth" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(authHtml);
    return;
  }

  if (pathname === "/auth" && req.method === "POST") {
    const ip = requestIp(req);
    if (isRateLimited(ip)) {
      sendJson(res, 429, {
        ok: false,
        error: "Too many attempts. Try again later.",
      });
      return;
    }
    try {
      const { code } = await readJsonBody(req);
      const supplied = Buffer.from(String(code || ""));
      const expected = Buffer.from(OTP);
      const valid = Date.now() <= otpExpiresAt &&
        supplied.length === expected.length &&
        crypto.timingSafeEqual(supplied, expected);
      if (!valid) {
        recordAuthFailure(ip);
        sendJson(res, 403, {
          ok: false,
          error: Date.now() > otpExpiresAt ? "Code expired." : "Wrong code.",
        });
        return;
      }
      authFailures.delete(ip);
      issueSession(req, res);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, error.message === "body-too-large" ? 413 : 400, {
        ok: false,
        error: "Invalid request.",
      });
    }
    return;
  }

  if (pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      cdpPort: CDP_PORT,
      cdpConnected: hub.browserWs?.readyState === WebSocket.OPEN,
      activeTargetId: hub.activeTargetId,
      targets: hub.targets.size,
      viewers: viewerClients.size,
      handoff,
    });
    return;
  }

  if (!authenticatedToken(req)) {
    res.writeHead(302, { Location: "/auth" });
    res.end();
    return;
  }

  const asset = assets.get(pathname);
  if (asset) {
    res.writeHead(200, { "Content-Type": asset.type });
    res.end(asset.body);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const token = authenticatedToken(req);
  if (pathname !== "/viewer-ws" || !token || !socketOriginAllowed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(
    req,
    socket,
    head,
    (ws) => wss.emit("connection", ws, req, token),
  );
});

wss.on("connection", (ws, _req, token) => {
  const client = {
    id: crypto.randomBytes(6).toString("hex"),
    token,
    ws,
    lastPainted: 0,
    droppedFrames: 0,
    rateWindowAt: Date.now(),
    rateCount: 0,
    alive: true,
  };
  viewerClients.add(client);
  if (!controllerToken) claimControl(client);
  sendSnapshot(client);
  hub.ensureViewerFrame()?.catch((error) =>
    logError("Frame refresh failed", error)
  );
  log(`Viewer connected (${viewerClients.size})`);

  ws.on("pong", () => {
    client.alive = true;
  });
  ws.on(
    "message",
    (raw) =>
      handleViewerMessage(client, raw).catch((error) =>
        logError("Viewer message failed", error)
      ),
  );
  ws.on("close", () => {
    viewerClients.delete(client);
    if (
      isController(client) &&
      ![...viewerClients].some((item) => item.token === client.token)
    ) {
      clearTimeout(controlReleaseTimer);
      controlReleaseTimer = setTimeout(() => {
        if (
          controllerToken === client.token &&
          ![...viewerClients].some((item) => item.token === client.token)
        ) {
          controllerToken = null;
          broadcastState();
        }
      }, 10000);
    }
    log(`Viewer disconnected (${viewerClients.size})`);
  });
});

const heartbeat = setInterval(() => {
  for (const client of viewerClients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, 20000);

server.listen(PORT, "127.0.0.1", async () => {
  console.log(
    JSON.stringify({
      ready: true,
      port: PORT,
      cdpPort: CDP_PORT,
      otp: OTP,
      otpExpiresAt: new Date(otpExpiresAt).toISOString(),
    }),
  );
  console.error(`[${timestamp()}] Shared Remote Browser`);
  console.error(`  Local:  http://127.0.0.1:${PORT}/viewer`);
  console.error(`  CDP:    127.0.0.1:${CDP_PORT}`);
  console.error(`  OTP:    ${OTP} (valid for 10 minutes)`);
  await hub.start();
});

async function shutdown() {
  clearInterval(heartbeat);
  clearTimeout(controlReleaseTimer);
  await hub.stop();
  for (const client of viewerClients) {
    client.ws.close(1001, "Server shutting down");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

function log(message) {
  console.error(`[${timestamp()}] ${message}`);
}

function logError(message, error) {
  console.error(`[${timestamp()}] ${message}: ${error?.message || error}`);
}
