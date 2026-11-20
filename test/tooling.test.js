import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import foarPlugin from '../integrations/vite-plugin-foar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'target/release/foar');

function spawnLsp() {
  const proc = cp.spawn(BIN, ['lsp'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = Buffer.alloc(0);
  const queue = [];
  const waiters = [];

  proc.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const header = buf.slice(0, sep).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) { buf = buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      if (buf.length < sep + 4 + len) return;
      const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
      buf = buf.slice(sep + 4 + len);
      const msg = JSON.parse(body);
      if (waiters.length) waiters.shift()(msg);
      else queue.push(msg);
    }
  });

  const send = (msg) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    proc.stdin.write(body);
  };
  const recv = () => new Promise((resolve, reject) => {
    if (queue.length) return resolve(queue.shift());
    const timer = setTimeout(() => reject(new Error('LSP response timeout')), 4000);
    waiters.push((m) => { clearTimeout(timer); resolve(m); });
  });
  return { proc, send, recv };
}

test('LSP server (foar lsp): initialize, diagnostics, completion, hover, definition, shutdown', async () => {
  const { proc, send, recv } = spawnLsp();
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: null, capabilities: {} } });
    const init = await recv();
    assert.equal(init.id, 1);
    assert.equal(init.result.serverInfo.name, 'foar-lsp');
    assert.equal(init.result.capabilities.hoverProvider, true);
    assert.equal(init.result.capabilities.definitionProvider, true);

    const uri = 'file:///tmp/foar-lsp-test.foar';
    const validSrc = [
      'enum Load { Idle, Ready(String) }',
      'view Badge(label: String) { state Ready { render { Text(label) } } }',
      'view App {',
      '  store req: Load = Load.Idle;',
      '  state Main { render { Badge(label: "hi") } }',
      '}',
    ].join('\n');

    send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'foar', version: 1, text: validSrc } } });
    const diag1 = await recv();
    assert.equal(diag1.method, 'textDocument/publishDiagnostics');
    assert.equal(diag1.params.diagnostics.length, 0, 'valid source has 0 diagnostics');

    // Hover on built-in `Text` (line 1, col 52)
    send({ jsonrpc: '2.0', id: 2, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 1, character: 52 } } });
    const hoverBuiltin = await recv();
    assert.ok(hoverBuiltin.result.contents.value.includes('Text'), JSON.stringify(hoverBuiltin));

    // Definition of `Badge` used on line 4 col 26 -> jumps to line 1
    send({ jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: { textDocument: { uri }, position: { line: 4, character: 26 } } });
    const def = await recv();
    assert.equal(def.result.range.start.line, 1);

    // Completion after `Load.` on line 3 col 25 -> offers Idle and Ready
    send({ jsonrpc: '2.0', id: 4, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 3, character: 25 } } });
    const comp = await recv();
    const labels = comp.result.map((i) => i.label);
    assert.deepEqual(labels, ['Idle', 'Ready']);

    // Invalid change -> publishes real compiler type diagnostic
    const badSrc = validSrc.replace('Load.Idle', 'Load.Ready(123)');
    send({ jsonrpc: '2.0', method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: badSrc }] } });
    const diag2 = await recv();
    assert.equal(diag2.params.diagnostics.length, 1);
    assert.ok(diag2.params.diagnostics[0].message.includes('Payload for Load.Ready expects String'), diag2.params.diagnostics[0].message);

    send({ jsonrpc: '2.0', id: 5, method: 'shutdown', params: null });
    const shut = await recv();
    assert.equal(shut.id, 5);
    send({ jsonrpc: '2.0', method: 'exit', params: null });
  } finally {
    proc.kill();
  }
});

test('Vite plugin (integrations/vite-plugin-foar.js): transforms .foar with HMR and watch files', () => {
  const plugin = foarPlugin({ foarBin: BIN });
  const watched = [];
  const ctx = {
    addWatchFile(p) { watched.push(p); },
    error(msg) { throw new Error(msg); },
  };

  // Multi-file project (examples/todo/app.foar)
  const todoApp = path.join(ROOT, 'examples/todo/app.foar');
  const res = plugin.transform.call(ctx, '', todoApp);
  assert.ok(res && typeof res.code === 'string');
  assert.ok(res.code.includes('export const program ='));
  assert.ok(res.code.includes('export function renderToStream('));
  assert.ok(res.code.includes('export function renderToStringAsync('));
  assert.ok(res.code.includes('import.meta.hot.accept'));
  assert.ok(watched.some((f) => f.endsWith('models.foar')), `expected watched models.foar, got ${watched}`);
  assert.ok(watched.some((f) => f.endsWith('TodoItem.foar')), `expected watched TodoItem.foar, got ${watched}`);
});

test('CLI lockfile workflow: foar init, add --path, install, pkg --verify, and tamper detection', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-cli-lock-'));
  try {
    const pkgDir = path.join(tmp, 'vendor', 'ui');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'foar.toml'), '[package]\nname = "ui"\nversion = "1.4.0"\n');
    fs.writeFileSync(path.join(pkgDir, 'Chip.foar'), 'view Chip(text: String) { state S { render { Text(text) } } }\n');

    cp.execFileSync(BIN, ['init'], { cwd: tmp, encoding: 'utf8' });
    cp.execFileSync(BIN, ['add', 'ui', '--path', './vendor/ui'], { cwd: tmp, encoding: 'utf8' });
    assert.ok(fs.existsSync(path.join(tmp, 'foar.lock')), 'foar.lock generated');
    const lockText = fs.readFileSync(path.join(tmp, 'foar.lock'), 'utf8');
    assert.ok(lockText.includes('version = "1.4.0"'), lockText);
    assert.ok(lockText.includes('integrity = "sha256-'), lockText);

    // Verify succeeds
    const verifyOut = cp.execFileSync(BIN, ['pkg', '--verify'], { cwd: tmp, encoding: 'utf8' });
    assert.ok(verifyOut.includes('foar.lock integrity verified'), verifyOut);

    // Frozen install succeeds
    const frozenOut = cp.execFileSync(BIN, ['install', '--frozen'], { cwd: tmp, encoding: 'utf8' });
    assert.ok(frozenOut.includes('verified 1 package(s)'), frozenOut);

    // Tamper with package -> pkg --verify and install --frozen fail!
    fs.writeFileSync(path.join(pkgDir, 'Chip.foar'), 'view Chip(text: String) { state S { render { Text("HACKED") } } }\n');
    assert.throws(() => cp.execFileSync(BIN, ['pkg', '--verify'], { cwd: tmp, stdio: 'pipe' }));
    assert.throws(() => cp.execFileSync(BIN, ['install', '--frozen'], { cwd: tmp, stdio: 'pipe' }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('VS Code extension manifests, TextMate grammar, and extension.js are valid', () => {
  const dir = path.join(ROOT, 'editors/vscode');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const langCfg = JSON.parse(fs.readFileSync(path.join(dir, 'language-configuration.json'), 'utf8'));
  const grammar = JSON.parse(fs.readFileSync(path.join(dir, 'syntaxes/foar.tmLanguage.json'), 'utf8'));
  assert.equal(pkg.contributes.languages[0].id, 'foar');
  assert.equal(grammar.scopeName, 'source.foar');
  assert.ok(langCfg.comments.lineComment === '//');
  // Check JS syntax with `node --check`
  cp.execFileSync(process.execPath, ['--check', path.join(dir, 'extension.js')]);
});

test('CLI formatter (foar fmt / --check) formats .foar files idempotently', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-fmt-'));
  try {
    const file = path.join(tmp, 'app.foar');
    fs.writeFileSync(file, 'view App {  \nstore n: i32 = 0;\n\n\nstate S {\nrender { Text("{n}") }\n}\n}\n');
    // --check fails on unformatted file
    assert.throws(() => cp.execFileSync(BIN, ['fmt', file, '--check'], { stdio: 'pipe' }));
    // foar fmt formats in place
    cp.execFileSync(BIN, ['fmt', file], { encoding: 'utf8' });
    // --check now passes!
    cp.execFileSync(BIN, ['fmt', file, '--check'], { encoding: 'utf8' });
    const formatted = fs.readFileSync(file, 'utf8');
    assert.equal(formatted, 'view App {\n    store n: i32 = 0;\n\n    state S {\n        render { Text("{n}") }\n    }\n}\n');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('language service: generic views and contexts', async () => {
  const { createLanguageService } = await import('../web/playground/language/service.js');
  const lib = 'context Library {\n    store notes: Vec<String> = [];\n    let count: i32 = notes.len();\n    effect Trash(id: String) { notes = notes; }\n}\n';
  const item = 'view MenuItem<T>(label: String, value: T, check: bool = false) {\n    state S {\n        render { Button(label) -> on_click(Pick) }\n        effect Pick() { emit pick(value); }\n    }\n}\n';
  const app = 'import "./lib"\nimport "./item"\nview A {\n    use Library;\n    state S {\n        render {\n            MenuItem(label: "x", value: 1) -> on_pick(Go)\n            Button("x") -> on_click(Library.)\n        }\n        effect Go(v: any) {}\n    }\n}\n';
  const ls = createLanguageService();
  ls.update({ 'lib.foar': lib, 'item.foar': item, 'app.foar': app });
  // a generic view keeps its params and events: no "never emits 'pick'"
  assert.deepEqual([...ls.diagnostics()], []);
  assert.deepEqual([...ls.index.views.get('MenuItem').emits], ['pick']);
  assert.equal(ls.hover('app.foar', app.indexOf('MenuItem(') + 2).code, 'view MenuItem<T>(label: String, value: T, check: bool = false)');
  // Library. in a handler offers its effects; hover and go-to-definition work
  assert.deepEqual(ls.complete('app.foar', app.indexOf('Library.)') + 8).items.map((i) => i.label), ['Trash']);
  assert.match(ls.hover('app.foar', app.indexOf('use Library') + 6).code, /^context Library \{\n    store notes: Vec<String>;/);
  assert.deepEqual(ls.definition('app.foar', app.indexOf('use Library') + 6), { path: 'lib.foar', offset: 8 });
});

test('install.sh: verifies SHA-256 checksum, installs binary, and uninstalls cleanly', () => {
  if (process.platform === 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foar-installer-'));
  try {
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
    const triple = process.platform === 'darwin' ? `${arch}-apple-darwin` : `${arch}-unknown-linux-musl`;
    const pkgName = `foar-${triple}`;
    const pkgDir = path.join(tmp, 'pkg', pkgName);
    const dlDir = path.join(tmp, 'releases', 'download', 'v0.3.1');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(dlDir, { recursive: true });
    fs.copyFileSync(BIN, path.join(pkgDir, 'foar'));
    const archive = path.join(dlDir, `${pkgName}.tar.gz`);
    cp.execFileSync('tar', ['-C', path.join(tmp, 'pkg'), '-czf', archive, pkgName]);
    const sha = cp.execFileSync('sha256sum', [archive], { encoding: 'utf8' });
    fs.writeFileSync(`${archive}.sha256`, sha);

    const instRoot = path.join(tmp, 'home-foar');
    const script = path.join(ROOT, 'web/install.sh');
    const out = cp.execFileSync('sh', [script, '--version', '0.3.1', '--dir', instRoot, '--no-modify-path'], {
      env: { ...process.env, FOAR_DOWNLOAD_URL: `file://${path.join(tmp, 'releases')}`, NO_COLOR: '1' },
      encoding: 'utf8',
    });
    assert.ok(out.includes('foar 0.3.1'), out);
    assert.ok(fs.existsSync(path.join(instRoot, 'bin', 'foar')));

    const uninst = cp.execFileSync('sh', [script, '--uninstall', '--dir', instRoot], {
      env: { ...process.env, NO_COLOR: '1' },
      encoding: 'utf8',
    });
    assert.ok(uninst.includes('uninstalled'), uninst);
    assert.ok(!fs.existsSync(path.join(instRoot, 'bin', 'foar')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
