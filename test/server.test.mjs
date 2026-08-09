import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

let cdpServer;
let cdpWss;
let cdpPort;
let viewerPort;
let viewerProcess;
let viewerOtp;
let cookie;
let browserSocket;
const cdpCommands = [];
const targetOne = {
  targetId: "page-one",
  type: "page",
  title: "First page",
  url: "https://example.test/",
};
const targetTwo = {
  targetId: "page-two",
  type: "page",
  title: "OAuth popup",
  url: "https://login.example.test/",
  openerId: "page-one",
};

before(async () => {
  cdpPort = await freePort();
  viewerPort = await freePort();
  cdpWss = new WebSocketServer({ noServer: true });
  cdpServer = http.createServer((request, response) => {
    if (request.url === "/json/version") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        webSocketDebuggerUrl: `ws://127.0.0.1:${cdpPort}/devtools/browser/test`,
      }));
      return;
    }
    response.writeHead(404).end();
  });
  cdpServer.on("upgrade", (request, socket, head) => {
    cdpWss.handleUpgrade(
      request,
      socket,
      head,
      (ws) => cdpWss.emit("connection", ws),
    );
  });
  cdpWss.on("connection", (ws) => {
    browserSocket = ws;
    ws.on("message", (raw) => {
      const command = JSON.parse(raw.toString());
      cdpCommands.push(command);
      let result = {};
      if (command.method === "Target.getTargets") {
        result = { targetInfos: [targetOne] };
      }
      if (command.method === "Target.attachToTarget") {
        result = { sessionId: `session-${command.params.targetId}` };
      }
      ws.send(
        JSON.stringify({
          id: command.id,
          result,
          sessionId: command.sessionId,
        }),
      );
    });
  });
  await listen(cdpServer, cdpPort);

  viewerProcess = spawn(process.execPath, [
    "scripts/server.mjs",
    "--cdp-port",
    String(cdpPort),
    "--port",
    String(viewerPort),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  const ready = await firstJsonLine(viewerProcess.stdout);
  viewerOtp = ready.otp;
  await waitFor(() =>
    cdpCommands.some((command) => command.method === "Page.startScreencast")
  );

  const auth = await fetch(`http://127.0.0.1:${viewerPort}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: viewerOtp }),
    redirect: "manual",
  });
  assert.equal(auth.status, 200);
  cookie = auth.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  viewerProcess?.kill("SIGTERM");
  await waitForExit(viewerProcess);
  for (const ws of cdpWss?.clients || []) ws.terminate();
  await close(cdpWss);
  await close(cdpServer);
});

test("requires authentication and never proxies raw CDP routes", async () => {
  const viewer = await fetch(`http://127.0.0.1:${viewerPort}/viewer`, {
    redirect: "manual",
  });
  assert.equal(viewer.status, 302);

  const rawCdp = await fetch(`http://127.0.0.1:${viewerPort}/json/version`, {
    headers: { Cookie: cookie },
  });
  assert.equal(rawCdp.status, 404);
});

test("fans one screencast out to multiple reconnectable viewers", async () => {
  const first = await openViewer();
  const second = await openViewer();
  await nextMessage(first, (message) => message.type === "state");
  await nextMessage(second, (message) => message.type === "state");

  const startsBefore =
    cdpCommands.filter((command) => command.method === "Page.startScreencast")
      .length;
  const stopsBefore =
    cdpCommands.filter((command) => command.method === "Page.stopScreencast")
      .length;
  emitFrame(1, "session-page-one");
  const firstFrame = await nextMessage(
    first,
    (message) => message.type === "frame",
  );
  const secondFrame = await nextMessage(
    second,
    (message) => message.type === "frame",
  );
  assert.equal(firstFrame.sequence, secondFrame.sequence);
  first.send(
    JSON.stringify({ type: "frame-painted", sequence: firstFrame.sequence }),
  );
  second.send(
    JSON.stringify({ type: "frame-painted", sequence: secondFrame.sequence }),
  );
  await waitFor(() =>
    cdpCommands.some((command) => command.method === "Page.screencastFrameAck")
  );

  first.close();
  await onceClosed(first);
  emitFrame(2, "session-page-one");
  const survivingFrame = await nextMessage(
    second,
    (message) => message.type === "frame",
  );
  assert.ok(survivingFrame.sequence > secondFrame.sequence);
  assert.equal(
    cdpCommands.filter((command) => command.method === "Page.startScreencast")
      .length,
    startsBefore,
  );
  assert.equal(
    cdpCommands.filter((command) => command.method === "Page.stopScreencast")
      .length,
    stopsBefore,
  );
  second.close();
});

test("adopts an OAuth popup and exposes explicit handoff state", async () => {
  const viewer = await openViewer();
  await nextMessage(viewer, (message) => message.type === "state");
  browserSocket.send(JSON.stringify({
    method: "Target.targetCreated",
    params: { targetInfo: targetTwo },
  }));
  await waitFor(() =>
    cdpCommands.some(
      (command) =>
        command.method === "Target.attachToTarget" &&
        command.params.targetId === "page-two",
    )
  );

  const targets = await nextMessage(
    viewer,
    (message) =>
      message.type === "targets" && message.activeTargetId === "page-two",
  );
  assert.equal(targets.targets.length, 2);

  viewer.send(JSON.stringify({ type: "handoff-complete" }));
  await waitFor(async () => {
    const health = await fetch(`http://127.0.0.1:${viewerPort}/health`).then((
      response,
    ) => response.json());
    return health.handoff.status === "complete";
  });
  viewer.close();
});

test("dispatches validated human input through the active target session", async () => {
  const viewer = await openViewer();
  await nextMessage(viewer, (message) => message.type === "state");
  viewer.send(JSON.stringify({ type: "claim-control" }));
  viewer.send(
    JSON.stringify({
      type: "click",
      x: 42,
      y: 84,
      button: "left",
      clickCount: 1,
    }),
  );
  await waitFor(() =>
    cdpCommands.filter((command) =>
      command.method === "Input.dispatchMouseEvent"
    ).length >= 2
  );
  const click = cdpCommands.find(
    (command) =>
      command.method === "Input.dispatchMouseEvent" &&
      command.params.type === "mousePressed",
  );
  assert.equal(click.sessionId, "session-page-two");
  assert.equal(click.params.x, 42);
  assert.equal(click.params.y, 84);
  viewer.close();
});

function emitFrame(sessionId, targetSessionId) {
  browserSocket.send(JSON.stringify({
    method: "Page.screencastFrame",
    sessionId: targetSessionId,
    params: {
      sessionId,
      data: Buffer.from("jpeg").toString("base64"),
      metadata: {
        deviceWidth: 1000,
        deviceHeight: 700,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    },
  }));
}

async function openViewer() {
  const ws = new WebSocket(`ws://127.0.0.1:${viewerPort}/viewer-ws`, {
    headers: {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${viewerPort}`,
    },
  });
  ws.receivedMessages = [];
  ws.on(
    "message",
    (raw) => ws.receivedMessages.push(JSON.parse(raw.toString())),
  );
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function nextMessage(ws, predicate, timeoutMs = 5000) {
  let found;
  await waitFor(() => {
    const index = ws.receivedMessages.findIndex(predicate);
    if (index < 0) return false;
    found = ws.receivedMessages.splice(index, 1)[0];
    return true;
  }, timeoutMs);
  return found;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(resolve));
}

function firstJsonLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    stream.once("error", reject);
  });
}

function onceClosed(ws) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => ws.once("close", resolve));
}

function waitForExit(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}
