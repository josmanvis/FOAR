import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT || 3000);
const ROOT = import.meta.dirname;
const WEB_DIR = path.join(ROOT, 'web');
const EXAMPLES_DIR = path.join(ROOT, 'examples');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.foar': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// Native Rust compiler, used by the playground when web/foar.wasm is absent.
const FOAR_BIN = path.join(ROOT, 'target', 'release', 'foar');

function compileNative(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (!fs.existsSync(FOAR_BIN)) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rust compiler not built: run `cargo build --release`', line: 0, col: 0 } }));
      return;
    }
    const project = String(req.headers['content-type'] || '').startsWith('application/json');
    const child = spawn(FOAR_BIN, ['build', '-', ...(project ? ['--project'] : [])]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(out || JSON.stringify({ error: { message: 'compiler produced no output', line: 0, col: 0 } }));
    });
    child.stdin.end(Buffer.concat(chunks));
  });
}

// examples/<id>/ are project folders: app.foar (entry) + whatever it imports.
// GET /examples/index.json -> [{ id, title, description, entry, files: { path: source } }]
function examplesIndex() {
  const out = [];
  for (const e of fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(EXAMPLES_DIR, e.name);
    if (!fs.existsSync(path.join(dir, 'app.foar'))) continue;
    const files = {};
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      if (String(rel).endsWith('.foar')) files[String(rel).split(path.sep).join('/')] = fs.readFileSync(path.join(dir, String(rel)), 'utf8');
    }
    // "// Title — description" on the entry's first line
    const first = /^\/\/\s*(.+)$/m.exec(files['app.foar'])?.[1] ?? e.name;
    const [title, description = ''] = first.split(/\s+—\s+/);
    out.push({ id: e.name, title: title.replace(/^FOAR\s+/, ''), description, entry: 'app.foar', files });
  }
  const order = ['starter', 'counter', 'todo'];
  return out.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
}

const send = (res, status, type, body) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/compile') return compileNative(req, res);
  let pathname;
  try {
    // "//x" would parse as a host name: collapse leading slashes first
    pathname = decodeURIComponent(new URL((req.url || '/').replace(/^\/+/, '/'), 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }

  if (pathname === '/examples/index.json') return send(res, 200, MIME_TYPES['.json'], JSON.stringify(examplesIndex()));

  // /            -> the playground (web/playground/index.html)
  // /examples/…  -> example sources
  // anything else -> web/ (runtime, compiler, wasm, playground modules)
  let filePath;
  if (pathname === '/' || pathname === '/index.html') filePath = path.join(WEB_DIR, 'playground', 'index.html');
  else if (pathname.startsWith('/examples/')) filePath = path.join(EXAMPLES_DIR, pathname.slice('/examples/'.length));
  else filePath = path.join(WEB_DIR, pathname.replace(/^\/+/, ''));
  filePath = path.normalize(filePath);

  // no directory traversal
  if (!filePath.startsWith(WEB_DIR + path.sep) && !filePath.startsWith(EXAMPLES_DIR + path.sep)) return send(res, 403, 'text/plain', 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'text/plain', `Not found: ${pathname}`);
    send(res, 200, MIME_TYPES[path.extname(filePath)] || 'application/octet-stream', data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FOAR Interactive Browser Playground running at http://localhost:${PORT}`);
});
