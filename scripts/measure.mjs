// The figures quoted in README.md, docs/ and web/index.html, measured from
// this checkout. Run after `pnpm build && pnpm build:wasm`:
//   node scripts/measure.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(root, f)), { level: 9 }).length;
const kb = (n) => `${Math.round(n / 1024)} KB`;

const notesDir = path.join(root, 'examples/notes-on-foar');
const notesFiles = fs.readdirSync(notesDir, { recursive: true }).filter((f) => f.endsWith('.foar'));
const files = Object.fromEntries(notesFiles.map((f) => [f, fs.readFileSync(path.join(notesDir, f), 'utf8')]));
const lines = Object.values(files).reduce((n, s) => n + s.split('\n').length, 0);

// WebAssembly compile time of the Notes app (what the playground does on every edit)
const wasm = await WebAssembly.instantiate(fs.readFileSync(path.join(root, 'web/foar.wasm')), {});
const { memory, f4_alloc, f4_free, f4_compile_project } = wasm.instance.exports;
const input = new TextEncoder().encode(JSON.stringify({ entry: 'app.foar', files }));
const compileOnce = () => {
  const ptr = f4_alloc(input.length);
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  const t = performance.now();
  f4_compile_project(ptr, input.length);
  const ms = performance.now() - t;
  f4_free(ptr, input.length);
  return ms;
};
for (let i = 0; i < 5; i++) compileOnce();
const times = Array.from({ length: 25 }, compileOnce).sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];

const bin = path.join(root, 'target/release/foar');
const t0 = performance.now();
execFileSync(bin, ['check', path.join(notesDir, 'app.foar')]);
const nativeMs = performance.now() - t0;

const rows = [
  ['runtime, gzipped (as served)', kb(gz('web/foar-runtime.min.js')), 'web/foar-runtime.min.js'],
  ['runtime source, gzipped', kb(gz('web/foar-runtime.js')), 'web/foar-runtime.js (readable)'],
  ['compiler as WebAssembly, gzipped', kb(gz('web/foar.wasm')), 'web/foar.wasm'],
  ['CLI binary', kb(fs.statSync(bin).size), 'target/release/foar (this platform)'],
  ['Notes example', `${notesFiles.length} files, ${lines.toLocaleString('en')} lines`, 'examples/notes-on-foar/**/*.foar'],
  ['Notes compile, WebAssembly (median)', `${median.toFixed(0)} ms`, 'f4_compile_project, 25 runs'],
  ['Notes check, native CLI (incl. process start)', `${nativeMs.toFixed(0)} ms`, 'foar check'],
];
for (const [what, value, how] of rows) console.log(`${what.padEnd(46)} ${value.padEnd(24)} ${how}`);
console.log('\nInteraction costs: pnpm bench');
