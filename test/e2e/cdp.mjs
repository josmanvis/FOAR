// Minimal Chrome DevTools Protocol driver for real-browser e2e tests.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** CHROME, or the first Chrome/Chromium on PATH. */
function chromeBinary() {
  if (process.env.CHROME) return process.env.CHROME;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (process.env.PATH || '').split(':')) {
    for (const n of names) if (fs.existsSync(`${dir}/${n}`)) return `${dir}/${n}`;
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  throw new Error('No Chrome found: set CHROME=/path/to/chrome');
}

export async function launch({ port = Number(process.env.CDP_PORT || 9333), profile, width = 1440, height = 900 } = {}) {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const proc = spawn(chromeBinary(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, 'about:blank',
  ], { stdio: 'ignore' });
  // never leave a headless Chrome behind
  process.on('exit', () => proc.kill());
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));
  let list;
  for (let i = 0; i < 100; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (list.some((t) => t.type === 'page')) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      waiting.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (fn) => listeners.push(fn);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });

  const page = {
    send,
    on,
    async goto(url) {
      const loaded = new Promise((r) => on((m) => m.method === 'Page.loadEventFired' && r()));
      await send('Page.navigate', { url });
      await loaded;
    },
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(expr, timeout = 4000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await page.eval(expr).catch(() => false)) return true;
        await page.sleep(40);
      }
      throw new Error(`timeout waiting for: ${expr}`);
    },
    async center(selectorExpr) {
      const r = await page.eval(`(() => { const el = ${selectorExpr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.left, top: b.top, h: b.height }; })()`);
      if (!r) throw new Error(`no element: ${selectorExpr}`);
      return r;
    },
    async mouse(x, y, { button = 'left', clickCount = 1 } = {}) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
    },
    async click(selectorExpr, opts) {
      const c = await page.center(selectorExpr);
      await page.mouse(c.x, c.y, opts);
      await page.sleep(60);
    },
    async dblclick(selectorExpr) {
      const c = await page.center(selectorExpr);
      await page.mouse(c.x, c.y, { clickCount: 1 });
      await page.mouse(c.x, c.y, { clickCount: 2 });
      await page.sleep(60);
    },
    async type(text) {
      await send('Input.insertText', { text });
      await page.sleep(40);
    },
    async key(key, { code, mods = 0, text } = {}) {
      const vk = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, ' ': 32, F10: 121, F2: 113, ContextMenu: 93, "/": 191, "}": 221, S: 83 }[key] ?? key.toUpperCase().charCodeAt(0);
      const base = { key, code: code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key), windowsVirtualKeyCode: vk, modifiers: mods };
      const t = text ?? (key === 'Enter' && !mods ? '\r' : undefined);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(t ? { text: t } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await page.sleep(60);
    },
    async screenshot(path) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path, Buffer.from(data, 'base64'));
    },
    async close() {
      ws.close();
      proc.kill();
    },
  };
  return page;
}
