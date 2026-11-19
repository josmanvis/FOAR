import { Window } from 'happy-dom';
export function makeDom() {
  const window = new Window({ url: 'http://localhost/' });
  const document = window.document;
  globalThis.document = document;           // old runtime uses globals
  globalThis.CSS = { escape: (s) => s };
  globalThis.window = window;
  const container = document.createElement('div');
  container.id = 'mount';
  document.body.appendChild(container);
  return { window, document, container };
}
export const tick = () => new Promise((r) => setTimeout(r, 0));
export function fire(window, el, type, init = {}) {
  const Ev = type === 'keydown' ? window.KeyboardEvent : window.Event;
  el.dispatchEvent(new Ev(type, { bubbles: true, cancelable: true, ...init }));
}

// Compile .foar with the native Rust compiler (target/release/foar).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const FOAR_BIN = new URL('../target/release/foar', import.meta.url).pathname;
/** An example project folder -> { entry: 'app.foar', files: { path: source } }. */
export function loadProject(dir) {
  const root = new URL(`../examples/${dir}/`, import.meta.url);
  const files = {};
  for (const rel of fs.readdirSync(root, { recursive: true })) {
    if (String(rel).endsWith('.foar')) files[String(rel).split(path.sep).join('/')] = fs.readFileSync(new URL(String(rel), root), 'utf8');
  }
  return { entry: 'app.foar', files };
}

/** Compiles a source string, or a project { entry, files } (imports resolved). */
export function compile(source) {
  let out;
  const project = typeof source !== 'string';
  try {
    out = execFileSync(FOAR_BIN, ['build', '-', ...(project ? ['--project'] : [])], { input: project ? JSON.stringify(source) : source, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    out = e.stdout;
  }
  const program = JSON.parse(out.toString());
  if (program.error) throw new SyntaxError(`${program.error.line}:${program.error.col}: ${program.error.message}`);
  return program;
}
