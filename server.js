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

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/compile') return compileNative(req, res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  let filePath;
  if (pathname === '/' || pathname === '/index.html') {
    filePath = path.join(WEB_DIR, 'index.html');
  } else if (pathname.startsWith('/examples/')) {
    const rel = path.basename(pathname);
    filePath = path.join(EXAMPLES_DIR, rel);
  } else {
    const rel = pathname.replace(/^\/+/, '');
    filePath = path.join(WEB_DIR, rel);
  }

  // Prevent directory traversal
  if (!filePath.startsWith(WEB_DIR) && !filePath.startsWith(EXAMPLES_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end(`Not found: ${pathname}`);
      return;
    }
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FOAR Interactive Browser Playground running at http://localhost:${PORT}`);
});
