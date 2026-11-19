// The FOAR website: landing page (web/index.html), docs rendered from
// docs/*.md, the playground (web/playground/), the runtime + compiler, and the
// example projects. Used by server.js (live) and by `pnpm build:site`
// (static, for GitHub Pages: everything uses relative URLs).
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { highlightFoar } from '../web/playground/language/highlight.js';

const ROOT = path.resolve(import.meta.dirname, '..');
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
        const body = lang === 'foar' ? highlightFoar(text) : esc(text);
        return `<pre class="code${lang ? ` lang-${esc(lang)}` : ''}"><code>${body}</code></pre>\n`;
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
        h = h.replace(/^\.\.\/examples\/(\w+)\/?$/, '../playground/?example=$1');
        const ext = /^https?:/.test(h);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener"' : ''}>${text}</a>`;
      },
    },
  });
  return { html: md.parse(src), toc };
}

/** A docs page as a complete HTML document. */
export function renderDoc(name) {
  const page = PAGES.find((p) => p.name === name);
  if (!page) return null;
  const { html, toc } = markdown(fs.readFileSync(path.join(DOCS, page.file), 'utf8'));
  const title = /<h1[^>]*>(?:<a[^>]*>#<\/a>)?(.*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, '') ?? page.title;
  const nav = PAGES.map((p) => `<a href="${p.name}.html"${p.name === name ? ' aria-current="page"' : ''}>${esc(p.title)}</a>`).join('');
  const onPage = toc.map((t) => `<a class="toc-${t.depth}" href="#${t.id}">${esc(t.text)}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · FOAR</title>
<meta name="description" content="FOAR: a UI language where every component is an explicit state machine.">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../site.css">
</head>
<body class="docs">
<header class="site-nav">
  <a class="logo" href="../" aria-label="FOAR home"><img src="../favicon.svg" alt="" width="24" height="24"> <span>FOAR</span></a>
  <nav aria-label="Site"><a href="./" aria-current="page">Docs</a><a href="../playground/">Playground</a><a class="hide-sm" href="../#examples">Examples</a><a href="https://github.com/josmanvis/FOAR" rel="noopener">GitHub</a></nav>
</header>
<div class="docs-layout">
  <aside class="docs-side" aria-label="Documentation">
    <nav class="docs-pages">${nav}</nav>
    <nav class="docs-toc" aria-label="On this page">${onPage}</nav>
  </aside>
  <main class="prose" id="main">
${html}
    <p class="edit"><a href="https://github.com/josmanvis/FOAR/blob/main/docs/${page.file}" rel="noopener">Edit this page on GitHub</a></p>
  </main>
</div>
</body>
</html>
`;
}

/** examples/<id>/ projects: [{ id, title, description, entry, files }] */
export function examplesIndex() {
  const out = [];
  for (const e of fs.readdirSync(EXAMPLES, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(EXAMPLES, e.name);
    if (!fs.existsSync(path.join(dir, 'app.foar'))) continue;
    const files = {};
    for (const rel of fs.readdirSync(dir, { recursive: true })) {
      if (String(rel).endsWith('.foar')) files[String(rel).split(path.sep).join('/')] = fs.readFileSync(path.join(dir, String(rel)), 'utf8');
    }
    const first = /^\/\/\s*(.+)$/m.exec(files['app.foar'])?.[1] ?? e.name;
    const [title, description = ''] = first.split(/\s+—\s+/);
    out.push({ id: e.name, title: title.replace(/^FOAR\s+/, ''), description, entry: 'app.foar', files });
  }
  const order = ['starter', 'counter', 'todo', 'orders'];
  return out.sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
}

/** Writes the static site into `out`. */
export function buildSite(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const web = path.join(ROOT, 'web');
  fs.cpSync(web, out, { recursive: true, filter: (src) => !src.includes(`${path.sep}docs${path.sep}`) });
  if (!fs.existsSync(path.join(out, 'foar.wasm'))) throw new Error('web/foar.wasm is missing: run `pnpm build:wasm` first');
  fs.mkdirSync(path.join(out, 'docs'), { recursive: true });
  for (const p of PAGES) fs.writeFileSync(path.join(out, 'docs', `${p.name}.html`), renderDoc(p.name));
  fs.mkdirSync(path.join(out, 'examples'), { recursive: true });
  fs.writeFileSync(path.join(out, 'examples', 'index.json'), JSON.stringify(examplesIndex()));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, '_site'));
  buildSite(out);
  console.log(`✓ site built in ${path.relative(process.cwd(), out) || '.'}`);
}
