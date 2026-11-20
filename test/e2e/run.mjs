// Browser end-to-end suites (headless Chrome over the DevTools protocol).
//
//   pnpm test:e2e                 # all suites
//   pnpm test:e2e notes-app       # some of them
//
// Starts the site/playground server on a free port, builds nothing: run
// `pnpm build && pnpm build:wasm` first so the binary and web/foar.wasm are current.
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const root = path.join(here, '../..');
const ALL = ['cli-dev', 'events', 'a11y', 'playground-editor', 'playground-search', 'playground-language', 'playground-stale-edits', 'notes-app', 'notes-editing'];
const pick = process.argv.slice(2);
const suites = pick.length ? ALL.filter((s) => pick.some((p) => s.includes(p))) : ALL;

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });
const port = await freePort();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-e2e-'));
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try { await fetch(`http://localhost:${port}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

const results = [];
for (const s of suites) {
  const started = Date.now();
  const lines = [];
  const code = await new Promise((res) => {
    const p = spawn(process.execPath, [path.join(here, `${s}.mjs`)], {
      cwd: root,
      env: { ...process.env, FOAR_E2E_URL: `http://localhost:${port}`, FOAR_E2E_OUT: out, CDP_PORT: String(9400 + results.length) },
    });
    const take = (d) => { for (const l of String(d).split('\n')) if (l.trim()) lines.push(l); };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    const t = setTimeout(() => p.kill(), 300_000);
    p.on('exit', (c) => { clearTimeout(t); res(c); });
  });
  const failed = lines.filter((l) => l.startsWith('✗') || /^\s{4}\S/.test(l) || /exception|warning:/i.test(l));
  const summary = lines.find((l) => /\d+ passed, \d+ failed/.test(l)) || lines.at(-1) || '';
  const ok = code === 0 && !lines.some((l) => l.startsWith('✗'));
  results.push({ s, ok });
  console.log(`${ok ? '✓' : '✗'} ${s.padEnd(22)} ${summary.trim()}  (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  if (!ok) for (const l of failed.slice(0, 12)) console.log(`    ${l}`);
}
server.kill();
const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad}/${results.length} suites passed`);
process.exit(bad ? 1 : 0);
