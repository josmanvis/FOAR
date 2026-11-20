// Accessibility in a real browser: axe-core (WCAG 2.0–2.2 A/AA) on every
// example, and the runtime's built-ins: Dialog, announce(), Spinner, the focus
// ring, reduced motion.
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
const FOAR = process.env.FOAR_BIN || new URL(`../../target/release/foar${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname;
const AXE = fs.readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let pass = 0, fail = 0;
async function step(name, fn) {
  try {
    const r = await fn();
    pass++; console.log(`✓ ${name}${r ? `  — ${r}` : ''}`);
  } catch (e) { fail++; console.log(`✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const page = await launch({ profile: `${OUT}/chrome-a11y`, width: 1200, height: 800 });
const axe = async (scope = 'document') => {
  await page.eval(AXE);
  const v = JSON.parse(await page.eval(`axe.run(${scope}, { runOnly: { type: 'tag', values: ${JSON.stringify(WCAG)} } }).then(r => JSON.stringify(r.violations.map(v => v.id + ' ×' + v.nodes.length + ': ' + v.nodes[0].html.slice(0, 90))))`));
  return v;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-a11y-'));
fs.copyFileSync(new URL('./fixtures/a11y/app.foar', import.meta.url), path.join(work, 'app.foar'));
const dev = spawn(FOAR, ['dev', '--port', String(5900 + Math.floor(Math.random() * 90))], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
let devLog = '';
dev.stdout.on('data', (d) => (devLog += d));

try {
  for (const ex of ['counter', 'starter', 'todo', 'orders', 'router', 'notes-on-foar']) {
    await step(`axe: ${ex} has no WCAG 2.2 A/AA violations`, async () => {
      await page.goto(`${BASE}/playground/app.html?example=${ex}`);
      await page.waitFor(`document.querySelector('.f4-view-host')`, 20000);
      await page.sleep(1200);
      const v = await axe(`document.querySelector('.f4-view-host').parentElement`);
      ok(!v.length, v.join(' | '));
    });
  }

  const url = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`foar dev didn't start:\n${devLog}`)), 5000);
    const check = () => { const m = /http:\/\/localhost:(\d+)\//.exec(devLog); if (m) { clearTimeout(t); res(`http://localhost:${m[1]}/`); } };
    dev.stdout.on('data', check);
    check();
  });
  await page.goto(url);
  await page.waitFor(`document.getElementById('opener')`);
  await page.sleep(200);

  await step('Spinner is a status message (role=status)', async () => {
    ok(await page.eval(`document.querySelector('.f4-spinner-wrap').getAttribute('role') === 'status'`), 'no role=status');
  });
  await step('the keyboard focus ring is visible', async () => {
    await page.eval(`document.body.focus()`);
    await page.key('Tab');
    const s = JSON.parse(await page.eval(`JSON.stringify({ id: document.activeElement.id, style: getComputedStyle(document.activeElement).outlineStyle, width: getComputedStyle(document.activeElement).outlineWidth })`));
    ok(s.id === 'opener' && s.style !== 'none' && s.width !== '0px', JSON.stringify(s));
    return `${s.style} ${s.width}`;
  });
  await step('Dialog opens modal, moves focus inside, and Tab stays inside', async () => {
    await page.key('Enter');
    await page.sleep(150);
    const s = JSON.parse(await page.eval(`JSON.stringify({ modal: document.querySelector('dialog').matches(':modal'), focus: document.activeElement.id, name: document.querySelector('dialog').getAttribute('aria-label') })`));
    ok(s.modal && s.focus === 'name' && s.name === 'Rename folder', JSON.stringify(s));
    const seen = [];
    for (let i = 0; i < 4; i++) { await page.key('Tab'); seen.push(await page.eval(`document.activeElement.closest('dialog') ? 'in' : (document.activeElement.id || document.activeElement.tagName)`)); }
    ok(!seen.includes('save') && !seen.includes('opener'), `focus left the dialog: ${seen.join(',')}`);
  });
  await step('axe: no violations with the dialog open', async () => {
    const v = await axe();
    ok(!v.length, v.join(' | '));
  });
  await step('Escape runs on_close; focus returns to the button that opened it', async () => {
    await page.key('Escape');
    await page.sleep(150);
    const s = JSON.parse(await page.eval(`JSON.stringify({ open: document.querySelector('dialog').open, focus: document.activeElement.id })`));
    ok(!s.open && s.focus === 'opener', JSON.stringify(s));
  });
  await step('announce("Saved") reaches a polite live region', async () => {
    await page.click(`document.getElementById('save')`);
    await page.sleep(150);
    const r = JSON.parse(await page.eval(`JSON.stringify([...document.querySelectorAll('[aria-live]')].map(e => [e.getAttribute('role'), e.getAttribute('aria-live'), e.textContent]))`));
    ok(r.some(([role, live, text]) => role === 'status' && live === 'polite' && text === 'Saved'), JSON.stringify(r));
  });
  await step('prefers-reduced-motion stops animations', async () => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.sleep(100);
    const d = await page.eval(`getComputedStyle(document.querySelector('.f4-spinner-ring')).animationDuration`);
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    ok(parseFloat(d) < 0.001, d);
    return d;
  });
} catch (e) {
  fail++;
  console.log(`✗ setup: ${e.message.split('\n')[0]}`);
} finally {
  dev.kill();
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
