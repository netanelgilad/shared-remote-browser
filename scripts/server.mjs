/**
 * Remote Browser Viewer Server
 * 
 * Serves a mobile-friendly browser viewer that connects to Chrome via CDP.
 * Provides: live screencast, virtual keyboard, click/scroll, pinch-to-zoom.
 * Protected by a one-time access code (OTP) generated on startup.
 * 
 * Usage:
 *   node server.mjs [--cdp-port 19222] [--port 19224] [--quality 55]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const CDP_PORT = parseInt(getArg('cdp-port', '19222'));
const PORT = parseInt(getArg('port', '19224'));
const QUALITY = parseInt(getArg('quality', '55'));

const VIEWER_HTML = fs.readFileSync(path.join(__dirname, 'viewer.html'), 'utf8');
const AUTH_HTML = fs.readFileSync(path.join(__dirname, 'auth.html'), 'utf8');

// --- OTP & Session Auth ---
const OTP = String(Math.floor(100000 + Math.random() * 900000));
const validSessions = new Set();

function generateSessionToken() {
  const token = crypto.randomBytes(24).toString('hex');
  validSessions.add(token);
  return token;
}

function parseCookies(header) {
  const cookies = {};
  if (header) header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k] = v.join('=');
  });
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  return cookies['rb-auth'] && validSessions.has(cookies['rb-auth']);
}

function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `rb-auth=${token}; HttpOnly; SameSite=Strict; Path=/`);
}

// --- Key map ---
const KEY_MAP = {
  'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  'Enter':     { key: 'Enter', code: 'Enter', keyCode: 13 },
  'Tab':       { key: 'Tab', code: 'Tab', keyCode: 9 },
  'Escape':    { key: 'Escape', code: 'Escape', keyCode: 27 },
};

const server = http.createServer((req, res) => {
  // --- Auth routes (always accessible) ---
  if (req.url === '/auth' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(AUTH_HTML);
    return;
  }
  if (req.url === '/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { code } = JSON.parse(body);
        if (code === OTP) {
          const token = generateSessionToken();
          setAuthCookie(res, token);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      } catch {
        res.writeHead(400); res.end('Bad request');
      }
    });
    return;
  }

  // --- Health (no auth needed) ---
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cdpPort: CDP_PORT, clients: wss.clients.size }));
    return;
  }

  // --- All other routes require auth ---
  if (!isAuthenticated(req)) {
    res.writeHead(302, { 'Location': '/auth' });
    res.end();
    return;
  }

  if (req.url === '/viewer' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(VIEWER_HTML);
    return;
  }

  // Proxy to CDP
  const options = {
    hostname: '127.0.0.1', port: CDP_PORT, path: req.url, method: req.method,
    headers: { ...req.headers, host: `localhost:${CDP_PORT}` }
  };
  const proxy = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxy);
  proxy.on('error', () => { res.writeHead(502); res.end('CDP not reachable'); });
});

const wss = new WebSocketServer({ noServer: true });

// Handle WebSocket upgrade with auth check
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/viewer-ws') {
    socket.destroy();
    return;
  }
  if (!isAuthenticated(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (clientWs) => {
  console.log(`[${ts()}] Client connected (total: ${wss.clients.size})`);
  
  http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      let pages;
      try { pages = JSON.parse(data); } catch { clientWs.close(); return; }
      const page = pages.find(p => !p.url.startsWith('chrome-extension') && p.type === 'page') || pages[0];
      if (!page) { clientWs.close(); return; }
      
      console.log(`[${ts()}] CDP target: ${page.url}`);
      clientWs.send(JSON.stringify({ type: 'url', url: page.url }));
      
      const cdp = new WebSocket(page.webSocketDebuggerUrl);
      let msgId = 1;
      
      function cdpSend(method, params = {}) {
        if (cdp.readyState === WebSocket.OPEN) {
          cdp.send(JSON.stringify({ id: msgId++, method, params }));
        }
      }
      
      cdp.on('open', () => {
        console.log(`[${ts()}] CDP connected, starting screencast`);
        cdpSend('Page.enable');
        cdpSend('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: 1280, maxHeight: 960, everyNthFrame: 2 });
      });
      
      cdp.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.method === 'Page.frameNavigated' && msg.params?.frame?.url) {
            clientWs.send(JSON.stringify({ type: 'url', url: msg.params.frame.url }));
          }
          if (msg.method === 'Page.screencastFrame') {
            clientWs.send(JSON.stringify({
              type: 'frame',
              data: msg.params.data,
              width: msg.params.metadata.deviceWidth,
              height: msg.params.metadata.deviceHeight
            }));
            cdpSend('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
          }
        } catch {}
      });
      
      cdp.on('error', (e) => console.error(`[${ts()}] CDP error:`, e.message));
      cdp.on('close', () => { console.log(`[${ts()}] CDP closed`); clientWs.close(); });
      
      clientWs.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          switch (msg.type) {
            case 'type':
              cdpSend('Input.insertText', { text: msg.text });
              break;
            case 'key': {
              const km = KEY_MAP[msg.key] || { key: msg.key, code: msg.key, keyCode: 0 };
              cdpSend('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: km.key, code: km.code, windowsVirtualKeyCode: km.keyCode, nativeVirtualKeyCode: km.keyCode });
              cdpSend('Input.dispatchKeyEvent', { type: 'keyUp', key: km.key, code: km.code, windowsVirtualKeyCode: km.keyCode, nativeVirtualKeyCode: km.keyCode });
              break;
            }
            case 'click':
              cdpSend('Input.dispatchMouseEvent', { type: 'mousePressed', x: msg.x, y: msg.y, button: 'left', clickCount: 1 });
              cdpSend('Input.dispatchMouseEvent', { type: 'mouseReleased', x: msg.x, y: msg.y, button: 'left', clickCount: 1 });
              break;
            case 'scroll':
              cdpSend('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 512, y: 384, deltaX: 0, deltaY: msg.deltaY * 100 });
              break;
            case 'navigate':
              cdpSend('Runtime.evaluate', { expression: msg.dir === 'back' ? 'history.back()' : 'history.forward()' });
              break;
          }
        } catch {}
      });
      
      clientWs.on('close', () => {
        console.log(`[${ts()}] Client disconnected`);
        cdpSend('Page.stopScreencast');
        cdp.close();
      });
    });
  }).on('error', (e) => {
    console.error(`[${ts()}] CDP unreachable:`, e.message);
    clientWs.close();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // Structured ready line for CLI consumption
  console.log(JSON.stringify({ ready: true, port: PORT, cdpPort: CDP_PORT, otp: OTP }));
  // Human-readable info on stderr
  console.error(`[${ts()}] Remote Browser Viewer`);
  console.error(`  Local:  http://127.0.0.1:${PORT}/viewer`);
  console.error(`  CDP:    127.0.0.1:${CDP_PORT}`);
  console.error(`  OTP:    ${OTP}`);
  console.error(`  Share:  cloudflared tunnel --url http://127.0.0.1:${PORT}`);
});

function ts() { return new Date().toISOString().slice(11, 19); }
