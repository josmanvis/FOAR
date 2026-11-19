// First-run content, and migration from the previous (localStorage) version.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const sunset = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a5a"/><stop offset=".55" stop-color="#ffcf7a"/><stop offset="1" stop-color="#7ec8e3"/></linearGradient></defs>
<rect width="640" height="360" fill="url(#s)"/><circle cx="420" cy="190" r="54" fill="#fff4d6" opacity=".9"/>
<path d="M0 250 Q80 210 160 238 T320 232 T480 240 T640 226 V360 H0Z" fill="#e0785a" opacity=".85"/>
<path d="M0 286 Q120 262 240 280 T480 276 T640 268 V360 H0Z" fill="#b8545a"/>
<g fill="#f6e7d0"><rect x="70" y="214" width="26" height="40"/><rect x="100" y="200" width="22" height="54"/><rect x="128" y="222" width="30" height="32"/><rect x="164" y="208" width="18" height="46"/></g>
<g fill="#c0392b"><path d="M66 214 l17-12 17 12z"/><path d="M97 200 l14-10 14 10z"/><path d="M125 222 l18-11 18 11z"/></g></svg>`)}`;

export function seedData() {
  const now = Date.now();
  const folders = [
    { id: 'notes', name: 'Notes' },
    { id: 'personal', name: 'Personal' },
    { id: 'work', name: 'Work' },
    { id: 'recipes', name: 'Recipes' },
  ];
  const note = (id, folder, html, updatedAgo, extra = {}) => ({
    id,
    folder,
    title: '',
    html,
    created: now - updatedAgo - 2 * DAY,
    updated: now - updatedAgo,
    pinned: false,
    deleted_at: 0,
    locked: false,
    ...extra,
  });

  const notes = [
    note('welcome', 'notes', `<h1>Welcome to Notes on FOAR</h1>
<p>A macOS Notes–style app written in <b>FOAR</b>, a state-machine UI language. Everything is saved on this device.</p>
<h2>Try it</h2>
<ul class="checklist">
<li data-checked="">Open this note</li>
<li>Right-click a note to pin, lock, move, duplicate, export or delete it</li>
<li>Create a folder with <i>New Folder</i> at the bottom of the sidebar (double-click a folder to rename it)</li>
<li>Lock a note with the 🔒 button: it is encrypted with your password</li>
<li>Switch to Gallery view and change sorting from the ☰ menu</li>
<li>Drop or paste an image into a note</li>
</ul>
<h2>Formatting</h2>
<p>Use <b>Aa</b> for <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strikethrough</s>, titles, headings, lists and quotes, and 🖍 for <span style="background-color: rgb(255, 213, 158);">highlights</span>.</p>
<h3>Keyboard shortcuts</h3>
<table><tbody>
<tr><th>Action</th><th>Keys</th></tr>
<tr><td>New note</td><td>Ctrl/⌘ ⌥ N</td></tr>
<tr><td>New folder</td><td>Ctrl/⌘ ⇧ N</td></tr>
<tr><td>Search</td><td>Ctrl/⌘ F</td></tr>
<tr><td>Title · Heading · Subheading · Body</td><td>Ctrl/⌘ ⌥ 1 · 2 · 3 · 0</td></tr>
<tr><td>Checklist</td><td>Ctrl/⌘ ⇧ L</td></tr>
<tr><td>Link</td><td>Ctrl/⌘ K</td></tr>
<tr><td>Print</td><td>Ctrl/⌘ P</td></tr>
<tr><td>Delete note</td><td>Ctrl/⌘ ⌫</td></tr>
</tbody></table>
<p><br></p>
<p>Tags like #foar and #demo show up in the sidebar.</p>`, 2 * MIN, { pinned: true }),

    note('lisbon', 'personal', `<h1>Lisbon trip ✈️</h1>
<p>May 14 – 19 · Alfama apartment</p>
<img src="${sunset}" alt="">
<h3>Packing</h3>
<ul class="checklist">
<li data-checked="">Passport</li>
<li data-checked="">Adapters</li>
<li>Comfortable shoes (hills!)</li>
<li>Sunscreen</li>
</ul>
<h3>Places</h3>
<ul class="dashed">
<li>Miradouro da Senhora do Monte at sunset</li>
<li>Pastéis de Belém</li>
<li>LX Factory on Sunday</li>
<li>Tram 28 early in the morning</li>
</ul>
<p>Guide: <a href="https://www.visitlisboa.com">visitlisboa.com</a></p>
<p>#travel</p>`, 3 * HOUR),

    note('sync', 'work', `<h1>Weekly sync</h1>
<p>Attendees: Ana, Ben, Chloé</p>
<h2>Agenda</h2>
<ol>
<li>Release checklist for 0.3</li>
<li>Runtime benchmark results</li>
<li>Docs and examples</li>
</ol>
<h2>Notes</h2>
<blockquote>Keyboard focus survives every update now that inputs are never re-created.</blockquote>
<ul class="dashed">
<li>Mount 500 rows: ~50 ms in happy-dom</li>
<li>Keystroke with 500 rows: ~2 ms</li>
</ul>
<h3>Action items</h3>
<ul class="checklist">
<li>Ana: write the migration guide</li>
<li data-checked="">Ben: publish the benchmark</li>
<li>Chloé: review the CSS syntax docs</li>
</ul>
<p>#work #foar</p>`, DAY + 2 * HOUR),

    note('pasta', 'recipes', `<h1>Pasta al limone</h1>
<p>Serves 2 · 20 minutes</p>
<h3>Ingredients</h3>
<ul>
<li>200 g spaghetti</li>
<li>2 lemons (zest + juice)</li>
<li>40 g butter</li>
<li>60 g Parmigiano, finely grated</li>
<li>Black pepper, basil</li>
</ul>
<h3>Method</h3>
<ol>
<li>Cook the pasta in well-salted water; keep a cup of pasta water.</li>
<li>Melt the butter with the zest, add half the juice.</li>
<li>Toss pasta, cheese and a splash of pasta water until glossy.</li>
<li>Finish with the rest of the juice, pepper and basil.</li>
</ol>
<p>#recipes #quick</p>`, 3 * DAY),

    note('roadmap', 'notes', `<h1>FOAR roadmap</h1>
<p>Ideas for the language and tooling.</p>
<pre>view Toggle {
    state Off { render { Button("Off") -&gt; on_click(Flip) } effect Flip() { transition On; } }
    state On  { render { Button("On")  -&gt; on_click(Flip) } effect Flip() { transition Off; } }
}</pre>
<ul>
<li>Router as a state machine</li>
<li>Dev tools that show the live state graph</li>
<li>Server-side rendering + hydration</li>
<li>Dependency tracking per binding</li>
</ul>
<p>#foar</p>`, 9 * DAY),

    note('groceries', 'personal', `<h1>Groceries</h1>
<ul class="checklist">
<li>Oat milk</li>
<li data-checked="">Sourdough</li>
<li>Tomatoes</li>
<li>Basil</li>
<li>Lemons</li>
</ul>`, 40 * DAY),

    note('old-draft', 'notes', `<h1>Old draft</h1><p>This note is in Recently Deleted. Recover it from the ⋯ menu or the banner above.</p>`, 6 * DAY, {
      deleted_at: now - 2 * DAY,
    }),
  ];
  return { notes, folders };
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Notes from the first version of this demo (localStorage, plain text). */
export function readV1() {
  try {
    const raw = localStorage.getItem('notes-on-foar/v1');
    if (!raw) return [];
    return JSON.parse(raw).map((n) => ({
      id: `v1-${n.id}`,
      folder: 'imported',
      title: n.title || '',
      html:
        `<h1>${esc(n.title || 'Untitled')}</h1>` +
        String(n.body || '')
          .split('\n')
          .map((l) => `<div>${esc(l) || '<br>'}</div>`)
          .join(''),
      created: n.updated || Date.now(),
      updated: n.updated || Date.now(),
      pinned: false,
      deleted_at: 0,
      locked: false,
    }));
  } catch {
    return [];
  }
}
