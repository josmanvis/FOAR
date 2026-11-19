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
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.md': 'text/markdown; charset=utf-8',
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

// The site, live: / (landing), /docs/*.html (rendered from docs/*.md),
// /playground/, /examples/index.json, and web/ for everything else.
// `pnpm build:site` writes the same pages as static files (scripts/site.mjs).
const site = await import('./scripts/site.mjs');

const send = (res, status, type, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
};

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/compile') return compileNative(req, res);
  let url;
  try {
    // "//x" would parse as a host name: collapse leading slashes first
    url = new URL((req.url || '/').replace(/^\/+/, '/'), 'http://localhost');
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'text/plain', 'Bad request');
  }

  // old links: /?src=… and /?example=… open the playground
  if (pathname === '/' && (url.searchParams.has('src') || url.searchParams.has('example'))) return send(res, 302, 'text/plain', '', { Location: `/playground/${url.search}` });
  if (pathname === '/playground' || pathname === '/docs') return send(res, 301, 'text/plain', '', { Location: `${pathname}/${url.search}` });
  if (pathname === '/examples/index.json') return send(res, 200, MIME_TYPES['.json'], JSON.stringify(site.examplesIndex()));
  if (pathname === '/hero/note.json') {
    site.compileHero().then(
      (json) => send(res, 200, MIME_TYPES['.json'], json),
      (err) => send(res, 500, 'text/plain', String(err.message ?? err)),
    );
    return;
  }
  const doc = /^\/docs\/(?:([\w-]+)\.html)?$/.exec(pathname);
  if (doc) {
    const html = site.renderDoc(doc[1] ?? 'index');
    return html ? send(res, 200, MIME_TYPES['.html'], html) : send(res, 404, 'text/plain', 'Not found');
  }

  let filePath;
  if (pathname.startsWith('/examples/')) filePath = path.join(EXAMPLES_DIR, pathname.slice('/examples/'.length));
  else filePath = path.join(WEB_DIR, pathname.replace(/^\/+/, ''));
  if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
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
