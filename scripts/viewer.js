const canvas = document.getElementById("frame");
const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
const viewport = document.getElementById("viewport");
const screen = document.getElementById("screen");
const status = document.getElementById("status");
const emptyState = document.getElementById("empty-state");
const targetSelect = document.getElementById("targets");
const urlInput = document.getElementById("url");
const keyboardCapture = document.getElementById("keyboard-capture");
const tapDot = document.getElementById("tap-dot");

let socket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let connectedToChrome = false;
let controller = false;
let frameMetadata = null;
let pendingFrame = null;
let renderingFrame = false;
let latestSequence = 0;
let scale = 1;
let translateX = 0;
let translateY = 0;
let wakeLock = null;

function setStatus(text, kind = "connecting") {
  status.textContent = text;
  status.className = `status status-${kind}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/viewer-ws`);
  setStatus(reconnectAttempt ? "Reconnecting…" : "Connecting…");

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    setStatus("Connected", "connected");
    requestWakeLock();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    connectedToChrome = false;
    emptyState.classList.remove("hidden");
    setStatus("Connection lost — retrying", "error");
    scheduleReconnect();
  });

  socket.addEventListener("error", () => socket.close());
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(10000, 500 * (2 ** reconnectAttempt++)) +
    Math.floor(Math.random() * 300);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function handleServerMessage(message) {
  if (message.type === "state") {
    connectedToChrome = message.connected;
    controller = message.controller === true;
    document.body.classList.toggle("controller", controller);
    document.body.classList.toggle("observer", !controller);
    document.getElementById("control").textContent = message.hasController
      ? "Take control"
      : "Control";
    if (!message.connected) setStatus("Waiting for Chrome…");
    else if (!message.visible) setStatus("Tab is inactive", "observer");
    else if (!controller) {
      setStatus(
        message.handoff?.status === "complete"
          ? "Handed back to agent"
          : "Watching — tap Control to interact",
        "observer",
      );
    } else setStatus("You have control", "connected");
    return;
  }

  if (message.type === "targets") {
    updateTargets(message.targets || [], message.activeTargetId);
    return;
  }

  if (message.type === "frame") {
    pendingFrame = message;
    renderLatestFrame();
    return;
  }

  if (message.type === "dialog") showDialog(message);
}

function updateTargets(targets, activeTargetId) {
  const previous = targetSelect.value;
  targetSelect.replaceChildren();
  for (const target of targets) {
    const option = document.createElement("option");
    option.value = target.id;
    option.textContent = target.title || target.url || "Untitled";
    option.title = target.url;
    targetSelect.appendChild(option);
    if (target.id === activeTargetId) {
      option.selected = true;
      if (document.activeElement !== urlInput) {
        urlInput.value = target.url || "";
      }
    }
  }
  targetSelect.disabled = targets.length < 2 || !controller;
  if (!activeTargetId && previous) targetSelect.value = previous;
}

async function renderLatestFrame() {
  if (renderingFrame) return;
  renderingFrame = true;
  try {
    while (pendingFrame) {
      const frame = pendingFrame;
      pendingFrame = null;
      const bytes = Uint8Array.from(
        atob(frame.data),
        (character) => character.charCodeAt(0),
      );
      const blob = new Blob([bytes], { type: "image/jpeg" });
      const bitmap = await decodeBitmap(blob);
      if (pendingFrame && pendingFrame.sequence > frame.sequence) {
        bitmap.close?.();
        continue;
      }
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close?.();
      frameMetadata = frame.metadata || {};
      latestSequence = frame.sequence;
      emptyState.classList.add("hidden");
      send({ type: "frame-painted", sequence: frame.sequence });
    }
  } catch (error) {
    console.warn("Frame decode failed", error);
  } finally {
    renderingFrame = false;
    if (pendingFrame) renderLatestFrame();
  }
}

async function decodeBitmap(blob) {
  if ("createImageBitmap" in window) return createImageBitmap(blob);
  const image = new Image();
  const source = URL.createObjectURL(blob);
  try {
    image.src = source;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(source);
  }
}

function remotePoint(clientX, clientY) {
  if (
    !frameMetadata?.deviceWidth || !frameMetadata?.deviceHeight || !canvas.width
  ) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const screenZoom = rect.width / frameMetadata.deviceWidth;
  const x = (clientX - rect.left) / screenZoom;
  const y = (clientY - rect.top) / screenZoom - (frameMetadata.offsetTop || 0);
  return {
    x: Math.max(0, Math.min(frameMetadata.deviceWidth, x)),
    y: Math.max(0, Math.min(frameMetadata.deviceHeight, y)),
  };
}

function showTap(clientX, clientY) {
  const rect = screen.getBoundingClientRect();
  tapDot.style.left = `${clientX - rect.left}px`;
  tapDot.style.top = `${clientY - rect.top}px`;
  tapDot.classList.remove("show");
  void tapDot.offsetWidth;
  tapDot.classList.add("show");
}

function applyTransform() {
  if (scale <= 1.001) {
    scale = 1;
    translateX = 0;
    translateY = 0;
  } else {
    const wrap = screen.getBoundingClientRect();
    const rendered = canvas.getBoundingClientRect();
    const baseWidth = rendered.width / scale;
    const baseHeight = rendered.height / scale;
    const maxX = Math.max(0, (baseWidth * scale - wrap.width) / 2);
    const maxY = Math.max(0, (baseHeight * scale - wrap.height) / 2);
    translateX = Math.max(-maxX, Math.min(maxX, translateX));
    translateY = Math.max(-maxY, Math.min(maxY, translateY));
  }
  viewport.style.transform =
    `translate(${translateX}px, ${translateY}px) scale(${scale})`;
}

function resetView() {
  scale = 1;
  translateX = 0;
  translateY = 0;
  applyTransform();
}

const pointers = new Map();
let gesture = null;
let longPressTimer = null;
let lastTap = { at: 0, x: 0, y: 0 };
let scrollPending = null;
let scrollRaf = null;
let mouseMovePending = null;
let mouseMoveRaf = null;

const movementThreshold = () => 8 * Math.min(window.devicePixelRatio || 1, 2);

function pointerRecord(event) {
  return {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: event.clientX,
    startY: event.clientY,
  };
}

canvas.addEventListener("pointerdown", (event) => {
  if (!controller) return;
  event.preventDefault();
  canvas.setPointerCapture?.(event.pointerId);
  const pointer = pointerRecord(event);
  pointers.set(event.pointerId, pointer);

  if (event.pointerType === "mouse") {
    const point = remotePoint(event.clientX, event.clientY);
    if (!point) return;
    const button = event.button === 2
      ? "right"
      : event.button === 1
      ? "middle"
      : "left";
    gesture = { mode: "mouse", button, last: point };
    send({ type: "pointer", action: "down", ...point, button, buttons: true });
    canvas.focus({ preventScroll: true });
    return;
  }

  if (pointers.size === 1) {
    gesture = {
      mode: "pending",
      startedAt: performance.now(),
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startTranslateX: translateX,
      startTranslateY: translateY,
    };
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(() => {
      if (gesture?.mode !== "pending" || pointers.size !== 1) return;
      const point = remotePoint(gesture.startX, gesture.startY);
      if (point) {
        send({ type: "click", ...point, button: "right", clickCount: 1 });
        showTap(gesture.startX, gesture.startY);
        gesture.mode = "long-press";
      }
    }, 650);
  } else if (pointers.size === 2) {
    clearTimeout(longPressTimer);
    const [first, second] = [...pointers.values()];
    const midpoint = {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
    gesture = {
      mode: "pinch",
      distance: Math.hypot(first.x - second.x, first.y - second.y),
      midpoint,
      scale,
      translateX,
      translateY,
    };
  }
}, { passive: false });

canvas.addEventListener("pointermove", (event) => {
  const pointer = pointers.get(event.pointerId);
  if (!pointer || !gesture) return;
  event.preventDefault();
  pointer.x = event.clientX;
  pointer.y = event.clientY;

  if (gesture.mode === "mouse") {
    const point = remotePoint(event.clientX, event.clientY);
    if (point) queueMouseMove(point, gesture.button);
    return;
  }

  if (pointers.size >= 2 && gesture.mode === "pinch") {
    const [first, second] = [...pointers.values()];
    const distance = Math.hypot(first.x - second.x, first.y - second.y);
    const midpoint = {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    };
    const nextScale = Math.max(
      1,
      Math.min(5, gesture.scale * distance / Math.max(1, gesture.distance)),
    );
    const rect = screen.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const ratio = nextScale / gesture.scale;
    translateX = (gesture.midpoint.x - centerX) -
      ((gesture.midpoint.x - centerX) - gesture.translateX) * ratio +
      (midpoint.x - gesture.midpoint.x);
    translateY = (gesture.midpoint.y - centerY) -
      ((gesture.midpoint.y - centerY) - gesture.translateY) * ratio +
      (midpoint.y - gesture.midpoint.y);
    scale = nextScale;
    applyTransform();
    return;
  }

  const totalDistance = Math.hypot(
    event.clientX - gesture.startX,
    event.clientY - gesture.startY,
  );
  if (gesture.mode === "pending" && totalDistance > movementThreshold()) {
    clearTimeout(longPressTimer);
    gesture.mode = scale > 1 ? "pan" : "scroll";
  }

  if (gesture.mode === "pan") {
    translateX = gesture.startTranslateX + event.clientX - gesture.startX;
    translateY = gesture.startTranslateY + event.clientY - gesture.startY;
    applyTransform();
  } else if (gesture.mode === "scroll") {
    const anchor = remotePoint(gesture.startX, gesture.startY);
    if (anchor) {
      queueScroll(
        anchor,
        gesture.lastX - event.clientX,
        gesture.lastY - event.clientY,
      );
    }
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  }
}, { passive: false });

function finishPointer(event, cancelled = false) {
  const pointer = pointers.get(event.pointerId);
  if (!pointer || !gesture) return;
  event.preventDefault();
  clearTimeout(longPressTimer);

  if (gesture.mode === "mouse") {
    flushMouseMove();
    const point = remotePoint(event.clientX, event.clientY) || gesture.last;
    send({
      type: "pointer",
      action: "up",
      ...point,
      button: gesture.button,
      buttons: false,
    });
  } else if (gesture.mode === "pending" && !cancelled && pointers.size === 1) {
    const point = remotePoint(event.clientX, event.clientY);
    if (point) {
      const now = performance.now();
      const closeToLast =
        Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 24;
      const clickCount = now - lastTap.at < 340 && closeToLast ? 2 : 1;
      send({ type: "click", ...point, button: "left", clickCount });
      showTap(event.clientX, event.clientY);
      lastTap = clickCount === 2
        ? { at: 0, x: 0, y: 0 }
        : { at: now, x: event.clientX, y: event.clientY };
    }
  }

  pointers.delete(event.pointerId);
  if (cancelled) send({ type: "blur" });
  if (pointers.size === 0) gesture = null;
  else if (gesture.mode === "pinch") gesture = { mode: "ignore-until-release" };
}

canvas.addEventListener("pointerup", (event) => finishPointer(event), {
  passive: false,
});
canvas.addEventListener(
  "pointercancel",
  (event) => finishPointer(event, true),
  { passive: false },
);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("wheel", (event) => {
  if (!controller) return;
  event.preventDefault();
  if (event.ctrlKey) {
    const next = Math.max(
      1,
      Math.min(5, scale * (event.deltaY > 0 ? .9 : 1.1)),
    );
    scale = next;
    applyTransform();
    return;
  }
  const point = remotePoint(event.clientX, event.clientY);
  if (point) queueScroll(point, event.deltaX, event.deltaY);
}, { passive: false });

function queueScroll(point, deltaX, deltaY) {
  if (!scrollPending) scrollPending = { ...point, deltaX: 0, deltaY: 0 };
  scrollPending.x = point.x;
  scrollPending.y = point.y;
  scrollPending.deltaX += deltaX;
  scrollPending.deltaY += deltaY;
  if (!scrollRaf) scrollRaf = requestAnimationFrame(flushScroll);
}

function flushScroll() {
  scrollRaf = null;
  if (!scrollPending) return;
  send({ type: "scroll", ...scrollPending });
  scrollPending = null;
}

function queueMouseMove(point, button) {
  mouseMovePending = { ...point, button };
  if (!mouseMoveRaf) mouseMoveRaf = requestAnimationFrame(flushMouseMove);
}

function flushMouseMove() {
  if (mouseMoveRaf) cancelAnimationFrame(mouseMoveRaf);
  mouseMoveRaf = null;
  if (!mouseMovePending) return;
  send({ type: "pointer", action: "move", ...mouseMovePending, buttons: true });
  mouseMovePending = null;
}

const FILLER = "\u00a0".repeat(8);
let previousKeyboardValue = FILLER;
let composing = false;
let suppressCompositionInput = false;

function resetKeyboardCapture() {
  keyboardCapture.value = FILLER;
  previousKeyboardValue = FILLER;
  keyboardCapture.setSelectionRange(4, 4);
}

function openKeyboard() {
  if (!controller) return;
  resetKeyboardCapture();
  keyboardCapture.focus({ preventScroll: true });
}

keyboardCapture.addEventListener("compositionstart", () => {
  composing = true;
});
keyboardCapture.addEventListener("compositionend", (event) => {
  composing = false;
  suppressCompositionInput = true;
  if (event.data) send({ type: "text", text: event.data });
  resetKeyboardCapture();
});

keyboardCapture.addEventListener("input", () => {
  if (composing) return;
  if (suppressCompositionInput) {
    suppressCompositionInput = false;
    resetKeyboardCapture();
    return;
  }
  const current = keyboardCapture.value;
  let prefix = 0;
  while (
    prefix < previousKeyboardValue.length && prefix < current.length &&
    previousKeyboardValue[prefix] === current[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousKeyboardValue.length - prefix &&
    suffix < current.length - prefix &&
    previousKeyboardValue[previousKeyboardValue.length - 1 - suffix] ===
      current[current.length - 1 - suffix]
  ) suffix += 1;
  const removed = previousKeyboardValue.length - prefix - suffix;
  const inserted = current.slice(prefix, current.length - suffix);
  for (let index = 0; index < removed; index += 1) {
    send({ type: "key", key: "Backspace" });
  }
  if (inserted) send({ type: "text", text: inserted });
  resetKeyboardCapture();
});

keyboardCapture.addEventListener("keydown", (event) => {
  const special = [
    "Enter",
    "Tab",
    "Escape",
    "ArrowLeft",
    "ArrowUp",
    "ArrowRight",
    "ArrowDown",
    "Delete",
  ];
  if (!special.includes(event.key)) return;
  event.preventDefault();
  send({ type: "key", key: event.key, modifiers: modifierMask(event) });
});

keyboardCapture.addEventListener("paste", (event) => {
  const text = event.clipboardData?.getData("text/plain");
  if (!text) return;
  event.preventDefault();
  send({ type: "text", text });
  resetKeyboardCapture();
});

function modifierMask(event) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

async function pasteClipboard() {
  if (!controller) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) send({ type: "text", text });
  } catch {
    const text = window.prompt("Paste text to send to the remote browser:");
    if (text) send({ type: "text", text });
  }
}

function showDialog(message) {
  const dialog = document.getElementById("dialog");
  const prompt = document.getElementById("dialog-prompt");
  document.getElementById("dialog-title").textContent =
    message.dialogType === "prompt" ? "Browser prompt" : "Browser message";
  document.getElementById("dialog-message").textContent = message.message || "";
  prompt.hidden = message.dialogType !== "prompt";
  prompt.value = message.defaultPrompt || "";
  if (!dialog.open) dialog.showModal();
  if (!prompt.hidden) prompt.focus();
}

document.getElementById("dialog").addEventListener("close", (event) => {
  const dialog = event.currentTarget;
  send({
    type: "dialog-response",
    accept: dialog.returnValue === "accept",
    promptText: document.getElementById("dialog-prompt").value,
  });
});

document.getElementById("url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (controller) send({ type: "navigate", url: urlInput.value });
  urlInput.blur();
});
document.getElementById("back").addEventListener(
  "click",
  () => send({ type: "history", delta: -1 }),
);
document.getElementById("forward").addEventListener(
  "click",
  () => send({ type: "history", delta: 1 }),
);
document.getElementById("reload").addEventListener(
  "click",
  () => send({ type: "reload" }),
);
targetSelect.addEventListener(
  "change",
  () => send({ type: "switch-target", targetId: targetSelect.value }),
);
document.getElementById("keyboard-button").addEventListener(
  "click",
  openKeyboard,
);
document.getElementById("backspace").addEventListener(
  "click",
  () => send({ type: "key", key: "Backspace" }),
);
document.getElementById("tab-key").addEventListener(
  "click",
  () => send({ type: "key", key: "Tab" }),
);
document.getElementById("enter-key").addEventListener(
  "click",
  () => send({ type: "key", key: "Enter" }),
);
document.getElementById("paste").addEventListener("click", pasteClipboard);
document.getElementById("fit").addEventListener("click", resetView);
document.getElementById("control").addEventListener(
  "click",
  () => send({ type: "claim-control" }),
);
document.getElementById("done").addEventListener("click", () => {
  keyboardCapture.blur();
  send({ type: "handoff-complete" });
});

window.addEventListener("blur", () => send({ type: "blur" }));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    send({ type: "blur" });
    wakeLock?.release?.();
    wakeLock = null;
  } else {
    requestWakeLock();
  }
});

window.visualViewport?.addEventListener("resize", applyTransform);
window.addEventListener("resize", applyTransform);

async function requestWakeLock() {
  if (!("wakeLock" in navigator) || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    // Wake lock is a progressive enhancement.
  }
}

resetKeyboardCapture();
connect();
