// foar init + foar dev in a real browser: renders, clicks, reloads on save,
// shows compile errors in the page, recovers.
import { launch } from './cdp.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const FOAR = process.env.FOAR_BIN || new URL(`../../target/release/foar${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url).pathname;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-dev-'));
const run = (args, cwd) => new Promise((res, rej) => spawn(FOAR, args, { cwd, stdio: 'ignore' }).on('exit', (c) => (c ? rej(new Error(`foar ${args.join(' ')}: exit ${c}`)) : res())));

await run(['init', 'hello'], work);
const dir = path.join(work, 'hello');
const port = 5300 + Math.floor(Math.random() * 500);
const dev = spawn(FOAR, ['dev', '--port', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
dev.stdout.on('data', (d) => (log += d));
const url = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`foar dev didn't start:\n${log}`)), 5000);
  dev.stdout.on('data', () => {
    const m = /http:\/\/localhost:(\d+)\//.exec(log);
    if (m) { clearTimeout(t); res(`http://localhost:${m[1]}/`); }
  });
});

let pass = 0, fail = 0;
async function step(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion false');
    pass++; console.log(`✓ ${name}${typeof r === 'string' ? `  — ${r}` : ''}`);
  } catch (e) { fail++; console.log(`✗ ${name}\n    ${e.message.split('\n')[0]}`); }
}

const page = await launch({ profile: `${OUT}/chrome-cli-dev`, width: 900, height: 600 });
const problems = [];
page.on((m) => { if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description); });
const app = path.join(dir, 'app.foar');
const src = fs.readFileSync(app, 'utf8');
try {
  await step('the scaffolded app renders and counts', async () => {
    await page.goto(url);
    await page.waitFor(`document.querySelector('.f4-button')`);
    await page.click(`document.querySelector('.f4-button')`);
    await page.click(`document.querySelector('.f4-button')`);
    await page.waitFor(`document.querySelector('.f4-text').textContent === 'Count: 2'`);
  });
  await step('saving a file reloads the page', async () => {
    fs.writeFileSync(app, src.replace('Increment', 'Add one'));
    await page.waitFor(`document.querySelector('.f4-button')?.textContent === 'Add one'`);
  });
  await step('a compile error shows in the page and the terminal', async () => {
    fs.writeFileSync(app, src.replace('count += 1;', 'cont += 1;'));
    await page.waitFor(`/isn't a store of view App \\(did you mean 'count'\\?\\)/.test(document.querySelector('pre')?.textContent || '')`);
    return log.includes("'cont' isn't a store") || Promise.reject(new Error('not in the terminal log'));
  });
  await step('fixing it recovers', async () => {
    fs.writeFileSync(app, src);
    await page.waitFor(`document.querySelector('.f4-button')?.textContent === 'Increment'`);
  });
  await step('foar build writes a dist/ that runs', async () => {
    await run(['build'], dir);
    for (const f of ['index.html', 'app.js', 'foar-runtime.js']) if (!fs.statSync(path.join(dir, 'dist', f)).size) throw new Error(`empty ${f}`);
    return 'index.html, app.js, foar-runtime.js';
  });
  await step('no exceptions', async () => problems.length === 0 || Promise.reject(new Error(problems.join('; '))));
} finally {
  dev.kill();
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
