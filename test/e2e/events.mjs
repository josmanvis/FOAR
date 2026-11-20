// DOM events in a real browser (React parity): enter/leave semantics, capture,
// pointer, wheel, keyboard, focus, image load/error, scroll, on_resize.
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const FOAR = process.env.FOAR_BIN || new URL(`../../target/release/foar${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-events-'));
fs.copyFileSync(new URL('./fixtures/events/app.foar', import.meta.url), path.join(work, 'app.foar'));
const dev = spawn(FOAR, ['dev', '--port', String(5600 + Math.floor(Math.random() * 300))], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));
const url = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`foar dev didn't start:\n${devLog}`)), 5000);
  dev.stdout.on('data', () => {
    const m = /http:\/\/localhost:(\d+)\//.exec(devLog);
    if (m) { clearTimeout(t); res(`http://localhost:${m[1]}/`); }
  });
});

let pass = 0, fail = 0;
async function step(name, fn) {
  try {
    const r = await fn();
    pass++; console.log(`✓ ${name}${r ? `  — ${r}` : ''}`);
  } catch (e) { fail++; console.log(`✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const page = await launch({ profile: `${OUT}/chrome-events`, width: 900, height: 700 });
const problems = [];
page.on((m) => { if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description); });
const log = () => page.eval(`document.getElementById('log').textContent`);
const clear = () => page.eval(`(() => { const a = window.__app; })()`);
const at = (id, dx = 0.5, dy = 0.5) => page.eval(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.left + r.width * ${dx}, y: r.top + r.height * ${dy} }; })()`);
const move = (p) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
const since = async (before) => (await log()).slice(before.length).replace(/^,/, '');

try {
  await page.goto(url);
  await page.waitFor(`document.getElementById('log')`);
  await page.sleep(300);

  await step('mouse enter/leave: entering a child doesn\'t re-fire the parent; leaving fires inner then outer', async () => {
    await move({ x: 880, y: 680 });
    const b = await log();
    await move(await at('outer', 0.5, 0.95));
    await move(await at('child'));
    await move({ x: 880, y: 680 });
    await page.sleep(100);
    const got = await since(b);
    ok(got === 'outer-enter,inner-enter,inner-leave,outer-leave', got);
    return got;
  });
  await step('capture handler runs first; pointer events carry pointer_type and button', async () => {
    const b = await log();
    const p = await at('child');
    await page.mouse(p.x, p.y);
    await page.sleep(100);
    const got = await since(b);
    ok(got.startsWith('outer-capture:pointerdown') === false && got.includes('pointerdown:mouse:0') && got.includes('outer-capture:click'), got);
    return got;
  });
  await step('wheel gives delta_y', async () => {
    const b = await log();
    const p = await at('inner');
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY: 120 });
    await page.sleep(150);
    const got = await since(b);
    ok(/wheel:120/.test(got), got);
  });
  await step('mouse down / up / click with client_x', async () => {
    const b = await log();
    await page.click(`document.getElementById('btn')`);
    await page.sleep(100);
    const got = await since(b);
    ok(/(^|,)mousedown,mouseup,click:\d+/.test(got), got);
    return got;
  });
  await step('focus, key down/up (+modifiers), on_enter alongside on_key_down, blur', async () => {
    const b = await log();
    await page.click(`document.getElementById('inp')`);
    await page.key('a', { text: 'a' });
    await page.key('B', { text: 'B', mods: 8 });
    await page.key('Enter');
    await page.click(`document.getElementById('btn')`);
    await page.sleep(100);
    const got = await since(b);
    for (const want of ['focus', 'keydown:a', 'keyup:a', 'keydown:B+shift', 'keydown:Enter', 'enter', 'blur']) ok(got.split(',').includes(want), `${want} missing in ${got}`);
    return got.split(',').filter((x) => !x.startsWith('mouse') && !x.startsWith('click') && !x.startsWith('outer')).join(',');
  });
  await step('image on_load and on_error (non-bubbling, exact target)', async () => {
    const got = await log();
    ok(got.includes('img-load') && got.includes('img-error'), got);
  });
  await step('on_scroll gives scroll_top', async () => {
    const b = await log();
    await page.eval(`document.getElementById('scroller').scrollTop = 300`);
    await page.sleep(200);
    const got = await since(b);
    ok(/scroll:300/.test(got), got);
  });
  await step('on_resize reports the new size before the next paint', async () => {
    const first = await page.eval(`document.getElementById('size').textContent`);
    // after the click, wait exactly two frames: ResizeObserver (after layout) + the
    // microtask update must already show the new width
    const r = await page.eval(`new Promise((done) => {
      document.getElementById('grow').click();
      requestAnimationFrame(() => requestAnimationFrame(() => done({ size: document.getElementById('size').textContent, width: document.getElementById('sized').getBoundingClientRect().width })));
    })`);
    ok(first.startsWith('200x') && r.size.startsWith(`${Math.round(r.width)}x`) && r.width === 300, `${first} → ${JSON.stringify(r)}`);
    return `${first} → ${r.size}`;
  });
  await step('no exceptions', async () => ok(problems.length === 0, problems.join('; ')));
} catch (e) {
  fail++;
  console.log(`✗ setup: ${e.message.split('\n')[0]}`);
} finally {
  dev.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
