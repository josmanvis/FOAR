// The FOAR website: landing page (web/index.html), docs rendered from
// docs/*.md, the playground (web/playground/), the runtime + compiler, and the
// example projects. Used by server.js (live) and by `pnpm build:site`
// (static, for GitHub Pages: everything uses relative URLs).
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { highlightFoar } from '../web/playground/language/highlight.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The landing page's hero panel is a real FOAR component (web/hero/note.foar),
 * compiled here with the WebAssembly compiler into program JSON that the page
 * mounts with the runtime. Returns the JSON text.
 */
let wasmExports = null;
export async function compileHero() {
  if (!wasmExports) {
    const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(ROOT, 'web', 'foar.wasm')), {});
    wasmExports = instance.exports;
  }
  const x = wasmExports;
  const bytes = new TextEncoder().encode(fs.readFileSync(path.join(ROOT, 'web', 'hero', 'note.foar'), 'utf8'));
  const ptr = x.f4_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  const out = x.f4_compile(ptr, bytes.length);
  x.f4_free(ptr, bytes.length);
  const len = new DataView(x.memory.buffer).getUint32(out, true);
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, out + 4, len).slice());
  x.f4_free(out, len + 4);
  if (JSON.parse(json).error) throw new Error(`web/hero/note.foar: ${json}`);
  return json;
}
const DOCS = path.join(ROOT, 'docs');
const EXAMPLES = path.join(ROOT, 'examples');

/** The docs, in nav order: docs/<file>.md -> /docs/<name>.html */
export const PAGES = [
  { name: 'index', file: 'guide.md', title: 'Guide' },
  { name: 'language', file: 'language.md', title: 'Language reference' },
  { name: 'tooling', file: 'tooling.md', title: 'Tooling' },
  { name: 'why', file: 'why.md', title: 'Why FOAR' },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

function markdown(src) {
  const toc = [];
  const md = new Marked({
    gfm: true,
    renderer: {
      code({ text, lang }) {
        const cleanLang = (lang || '').trim();
        const body = cleanLang === 'foar' ? highlightFoar(text) : esc(text);
        const label = cleanLang || 'text';
        return `<div class="code-block-wrap"><div class="code-block-head"><span>${esc(label)}</span><button class="copy-btn" type="button" data-copy>Copy</button></div><pre class="code${cleanLang ? ` lang-${esc(cleanLang)}` : ''}"><code>${body}</code></pre></div>\n`;
      },
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const id = slug(html);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: html.replace(/<[^>]+>/g, '') });
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        // docs link to each other as ./name.md (readable on GitHub); the site serves .html
        let h = href.replace(/^\.\/(\w+)\.md(#.*)?$/, (_, n, hash) => `${n === 'guide' ? 'index' : n}.html${hash ?? ''}`);
        h = h.replace(/^\.\.\/examples\/([\w-]+)\/?$/, '../playground/?example=$1');
        h = h.replace(/^https:\/\/josmanvis\.github\.io\/FOAR\/playground\/?(\?.*)?$/, '../playground/$1');
        const ext = /^https?:/.test(h);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${text}</a>`;
      },
    },
  });
  return { html: md.parse(src), toc };
}

/** A docs page as a complete HTML document. */
export function renderDoc(name) {
  const idx = PAGES.findIndex((p) => p.name === name);
  if (idx === -1) return null;
  const page = PAGES[idx];
  const prev = idx > 0 ? PAGES[idx - 1] : null;
  const next = idx < PAGES.length - 1 ? PAGES[idx + 1] : null;

  const { html, toc } = markdown(fs.readFileSync(path.join(DOCS, page.file), 'utf8'));
  const title = /<h1[^>]*>(?:<a[^>]*>#<\/a>)?(.*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, '') ?? page.title;
  const nav = PAGES.map((p) => `<a href="${p.name}.html"${p.name === name ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('');
  const unescape = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const onPage = toc.map((t) => `<a class="toc-${t.depth}" href="#${t.id}">${esc(unescape(t.text))}</a>`).join('');

  const pager = (prev || next)
    ? `<nav class="docs-pager" aria-label="Page navigation">
        ${prev ? `<a class="pager-link" href="${prev.name}.html"><span class="pager-dir">Previous</span><span class="pager-title">${esc(prev.title)}</span></a>` : ''}
        ${next ? `<a class="pager-link is-next" href="${next.name}.html"><span class="pager-dir">Next</span><span class="pager-title">${esc(next.title)}</span></a>` : ''}
      </nav>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} · FOAR docs</title>
  <meta name="description" content="FOAR documentation: a UI programming language where every component is an explicit state machine.">
  <link rel="icon" href="../favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Overpass:ital,wght@0,300..900;1,300..900&family=Overpass+Mono:wght@400..700&display=swap" rel="stylesheet">
  <script>
    try {
      const t = localStorage.getItem('foar-theme');
      if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    } catch {}
  </script>
  <link rel="stylesheet" href="../site.css">
</head>
<body class="docs">
<a class="skip" href="#main">Skip to content</a>

<header class="site-nav">
  <div class="site-nav-inner">
    <a class="logo" href="../" aria-label="FOAR home">
      <img src="../favicon.svg" alt="" width="28" height="28">
      <span class="logo-wordmark">FOAR</span>
    </a>
    <nav aria-label="Site">
      <a href="./" aria-current="page">Docs</a>
      <a href="../playground/">Playground</a>
      <a class="hide-sm" href="../#examples">Examples</a>
      <a href="https://github.com/josmanvis/FOAR" rel="noopener">GitHub</a>
    </nav>
    <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle color theme"></button>
  </div>
</header>

<div class="docs-layout">
  <aside class="docs-side" aria-label="Documentation">
    <nav class="docs-pages" aria-label="Documentation pages">${nav}</nav>
    ${onPage ? `<div class="docs-toc-wrap"><p class="docs-group-label">On this page</p><nav class="docs-toc" aria-label="On this page">${onPage}</nav></div>` : ''}
    <p class="docs-side-cta"><a href="../playground/">Try it in the playground</a></p>
  </aside>

  <main class="prose" id="main">
${html}
${pager}
    <p class="edit"><a href="https://github.com/josmanvis/FOAR/blob/main/docs/${page.file}" rel="noopener">Edit this page on GitHub</a></p>
  </main>
</div>

<footer class="site-footer">
  <div class="wrap footer-inner">
    <div class="footer-brand">
      <img src="../favicon.svg" alt="" width="22" height="22">
      <span>FOAR is open source under the MIT license.</span>
    </div>
    <nav class="footer-links" aria-label="Footer">
      <a href="./">Guide</a>
      <a href="language.html">Language</a>
      <a href="tooling.html">Tooling</a>
      <a href="why.html">Why FOAR</a>
      <a href="../playground/">Playground</a>
      <a href="https://github.com/josmanvis/FOAR" rel="noopener">GitHub</a>
    </nav>
  </div>
</footer>

<script type="module" src="../site.js"></script>
</body>
</html>
`;
}

/** examples/<id>/ projects: [{ id, title, description, entry, files, host }] */
export function examplesIndex() {
  const out = [];
  for (const e of fs.readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(EXAMPLES, e.name);
    if (!fs.existsSync(path.join(dir, 'app.foar'))) continue;
    const files = {};
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      const s = String(rel).split(path.sep).join('/');
      if (s.endsWith('.foar') || s === 'foar.toml') files[s] = fs.readFileSync(path.join(dir, String(rel)), 'utf8');
    }
    const headerLines = files['app.foar']
      .split('\n')
      .slice(0, 4)
      .map((l) => /^\/\/\s*(.+)$/.exec(l)?.[1]?.trim())
      .filter(Boolean);
    const first = headerLines[0] ?? e.name;
    let [title, description = ''] = first.split(/\s+—\s+/);
    if (!description && headerLines[1]) description = headerLines[1].replace(/\.$/, '');
    const host = fs.existsSync(path.join(dir, 'host.js')) ? `../examples/${e.name}/host.js` : null;
    out.push({ id: e.name, title: title.replace(/^FOAR\s+/, ''), description, entry: 'app.foar', files, ...(host ? { host } : {}) });
  }
  const order = ['starter', 'counter', 'todo', 'orders', 'router', 'notes-on-foar'];
  return out.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
}

/** Writes the static site into `out`. */
export async function buildSite(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const web = path.join(ROOT, 'web');
  fs.cpSync(web, out, { recursive: true, filter: (src) => !src.includes(`${path.sep}docs${path.sep}`) });
  if (!fs.existsSync(path.join(out, 'foar.wasm'))) throw new Error('web/foar.wasm is missing: run `pnpm build:wasm` first');
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  for (const p of PAGES) fs.writeFileSync(path.join(out, 'docs', `${p.name}.html`), renderDoc(p.name));
  fs.mkdirSync(path.join(out, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(out, 'examples', 'index.json'), JSON.stringify(examplesIndex()));
  for (const e of fs.readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const srcDir = path.join(EXAMPLES, e.name);
    for (const asset of ['host.js', 'host', 'locales']) {
      const from = path.join(srcDir, asset);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(out, 'examples', e.name, asset), { recursive: true });
    }
  }
  fs.writeFileSync(path.join(out, 'hero', 'note.json'), await compileHero());
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, '_site'));
  await buildSite(out);
  console.log(`✓ site built in ${path.relative(process.cwd(), out) || '.'}`);
}
