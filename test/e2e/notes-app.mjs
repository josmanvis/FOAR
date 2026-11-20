import { launch } from './cdp.mjs';
import os from 'node:os';
import path from 'node:path';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';

const URL = `${BASE}/playground/app.html?example=notes-on-foar`;
const ALT = 1, CTRL = 2, SHIFT = 8;
const page = await launch({ profile: `${OUT}/chrome-ex-notes-chrome` });
const problems = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type))
    problems.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});

let pass = 0, fail = 0;
async function step(name, fn) {
  try {
    const r = await fn();
    if (r === false) throw new Error('assertion false');
    pass++;
    console.log(`✓ ${name}${typeof r === 'string' ? `  — ${r}` : ''}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}\n    ${e.message.split('\n')[0]}`);
  }
}
const ev = (e) => page.eval(e);
const H = `
  window.$t = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
  window.$has = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
  window.rows = () => [...document.querySelectorAll('.f4-view-NoteRow')].map((r) => r.querySelector('.f4-text').textContent);
  window.ed = () => document.querySelector('.f4-richtext');
  window.root = () => { const b = foarApp.getContext('Browse'); return { ...foarApp.getSnapshot().find((i) => i.key === 'root').stores, ...foarApp.getContext('Library'), ...foarApp.getContext('Prefs'), ...foarApp.getContext('Vault'), ...b, selected_id: b.selected }; };
  window.selectText = (text) => {
    const e = ed(); const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { const i = n.data.indexOf(text); if (i >= 0) {
      e.focus(); const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + text.length);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; } }
    return false;
  };
  window.caretAtEnd = (sel) => { const el = ed().querySelector(sel) || ed(); ed().focus(); const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; };
  true`;

await page.goto(URL);
await page.waitFor('document.querySelector(".f4-view-NoteRow")');
await ev(H);
await page.click(`document.querySelector('.f4-view-NoteRow .f4-row')`);
await page.sleep(400);
await page.screenshot(`${OUT}/e2e-01-initial.png`);

// ---------------------------------------------------------------- layout & seed
await step('fills the viewport', async () => {
  const r = await ev(`(() => { const b = document.querySelector('.f4-view-NotesApp').getBoundingClientRect(); return [b.width, b.height, innerWidth, innerHeight]; })()`);
  return r[0] === r[2] && r[1] === r[3] ? `${r[0]}×${r[1]}` : false;
});
await step('sidebar: folders with counts, Recently Deleted, tags', async () => {
  const s = await ev(`[...document.querySelectorAll('.f4-Sidebar .f4-SidebarItem')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim()).join(' | ')`);
  const tags = await ev(`[...document.querySelectorAll('.f4-view-TagChip')].map((e) => e.textContent).join(' ')`);
  if (!s.includes('All Notes6') || !s.includes('Personal2') || !s.includes('Recently Deleted1') || !tags.includes('#travel')) throw new Error(s + ' / ' + tags);
  return `${s} / ${tags}`;
});
await step('list grouped: Pinned first, then date groups', async () => {
  const g = await ev(`[...document.querySelectorAll('.f4-GroupLabel')].map((e) => e.textContent).join(', ')`);
  return /^Pinned, (Today|Yesterday)/.test(g) ? g : (() => { throw new Error(g); })();
});
await step('All Notes rows show folder names; folders listed alphabetically', async () => {
  const labels = await ev(`[...document.querySelectorAll('.f4-view-NoteRow')].map((r) => r.querySelectorAll('.f4-text')[3]?.textContent ?? '')`);
  if (labels.some((l) => l.includes('=>')) || !labels.includes('📁 Personal')) throw new Error(JSON.stringify(labels));
  const order = await ev(`[...document.querySelectorAll('.f4-view-FolderRow')].map((r) => r.textContent.replace(/[^A-Za-z]/g, ''))`);
  if (JSON.stringify(order) !== JSON.stringify(['Notes', 'Personal', 'Recipes', 'Work'])) throw new Error(order.join(','));
  return labels.slice(0, 3).join(', ');
});
await step('note row shows image thumbnail', async () =>
  ev(`!![...document.querySelectorAll('.f4-view-NoteRow')].find((r) => r.textContent.includes('Lisbon') && r.querySelector('img.f4-image:not([hidden])'))`));

// ---------------------------------------------------------------- editing & formatting
await step('select note → editor shows rich content', async () => {
  await page.click(`$has('.f4-view-NoteRow', 'Lisbon')`);
  await page.waitFor(`ed() && ed().querySelector('h1')?.textContent.includes('Lisbon')`);
  return ev(`ed().querySelectorAll('ul.checklist li').length === 4 && !!ed().querySelector('ul.dashed') && !!ed().querySelector('img')`);
});
await step('typing in the body updates title/preview and moves note to Today', async () => {
  await ev(`caretAtEnd('h1')`);
  await page.type(' 2027');
  await page.waitFor(`rows().some((t) => t.includes('Lisbon trip ✈️ 2027'))`);
  return ev(`root().notes.find((n) => n.id === 'lisbon').title`);
});
await step('Aa → Bold', async () => {
  await ev(`selectText('Sunscreen')`);
  await page.sleep(50);
  await page.click(`$t('.f4-view-FormatButtons button', 'Aa')`);
  await page.waitFor(`foarApp.getSnapshot().some((i) => i.viewName === 'FormatBar' && i.state === 'Styles')`);
  await page.sleep(150);
  await page.screenshot(`${OUT}/e2e-07-styles-menu.png`);
  await page.click(`$t('.f4-Menu button', 'B')`);
  await page.waitFor(`/<b>Sunscreen<\\/b>/.test(root().notes.find((n) => n.id === 'lisbon').html)`);
  return 'saved as <b>';
});
await step('Aa → Heading (formatBlock) keeps editor selection', async () => {
  await ev(`selectText('Places')`);
  await page.sleep(50);
  await page.click(`$has('.f4-Menu .f4-view-MenuItem', 'Heading')`).catch(async () => {
    await page.click(`$t('.f4-view-FormatButtons button', 'Aa')`);
    await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Heading')`);
  });
  await page.waitFor(`[...ed().querySelectorAll('h2')].some((h) => h.textContent === 'Places')`);
  return ev(`foarApp.getSnapshot().find((i) => i.viewName === 'FormatBar').state`).then((s) => `menu closed: ${s}`);
});
await step('Checklist: toggle a paragraph into a checklist, click the circle to check', async () => {
  await ev(`caretAtEnd('p:last-of-type')`);
  await page.key('Enter');
  await page.type('Book the airport transfer');
  await page.click(`$t('.f4-view-FormatButtons button', '☑')`);
  await page.waitFor(`[...ed().querySelectorAll('ul.checklist li')].some((li) => li.textContent === 'Book the airport transfer')`);
  const li = `[...ed().querySelectorAll('ul.checklist li')].find((li) => li.textContent === 'Book the airport transfer')`;
  const c = await page.center(li);
  await page.mouse(c.left - 19, c.top + 12);
  await page.waitFor(`${li}.hasAttribute('data-checked')`);
  await page.waitFor(`root().notes.find((n) => n.id === 'lisbon').html.includes('data-checked="">Book the airport transfer')`);
  return 'checked + saved';
});
await step('Enter after a checked item starts an unchecked one', async () => {
  await page.key('End');
  await ev(`caretAtEnd('ul.checklist:last-of-type li:last-child')`);
  await page.key('Enter');
  await page.type('Pack snacks');
  const li = `[...ed().querySelectorAll('ul.checklist li')].find((li) => li.textContent === 'Pack snacks')`;
  await page.waitFor(li);
  return ev(`!${li}.hasAttribute('data-checked')`);
});
await step('lists are not nested inside paragraphs', async () => {
  const bad = await ev(`[...ed().querySelectorAll('p > ul, p > ol, div > ul, div > ol')].filter((l) => l.parentElement !== ed()).length`);
  const where = await ev(`[...ed().querySelectorAll('p > ul, p > ol, div > ul, div > ol')].filter((l) => l.parentElement !== ed()).map((l) => l.parentElement.outerHTML.slice(0, 160)).join(' ‖ ')`);
  return bad === 0 ? 'no <p><ul>' : (() => { throw new Error(`${bad} nested: ${where}`); })();
});
await step('Table: insert, Tab moves between cells, Tab on last cell adds a row', async () => {
  await ev(`caretAtEnd('p:last-of-type')`);
  await page.key('Enter');
  await page.click(`$t('.f4-view-FormatButtons button', '⊞')`);
  await page.waitFor(`!!ed().querySelector('table')`);
  await page.type('Day');
  await page.key('Tab');
  await page.type('Plan');
  for (let i = 0; i < 8; i++) await page.key('Tab'); // cell 2 -> 9 (last), then one more adds a row
  return ev(`(() => { const t = ed().querySelector('table'); return t.rows.length === 4 && t.rows[0].cells[0].textContent === 'Day' && t.rows[0].cells[1].textContent === 'Plan'; })()`);
});
await step('Link: select text, 🔗, type URL, Enter', async () => {
  await ev(`selectText('Tram 28')`);
  await page.sleep(50);
  await page.click(`$t('.f4-view-FormatButtons button', '🔗')`);
  await page.waitFor(`document.activeElement?.placeholder === 'https://example.com'`);
  await page.type('carris.pt');
  await page.key('Enter');
  await page.waitFor(`!!ed().querySelector('a[href="https://carris.pt"]')`);
  return ev(`ed().querySelector('a[href="https://carris.pt"]').textContent`);
});
await step('Highlight: select text, 🖍, Mint swatch', async () => {
  await ev(`selectText('Pastéis de Belém')`);
  await page.sleep(50);
  await page.click(`$t('.f4-view-FormatButtons button', '🖍')`);
  await page.click(`document.querySelector('.f4-view-Swatch button[title="Mint"]')`);
  await page.waitFor(`[...ed().querySelectorAll('span')].some((s) => s.style.backgroundColor && s.textContent.includes('Belém'))`);
  return ev(`[...ed().querySelectorAll('span')].find((s) => s.textContent.includes('Belém')).style.backgroundColor`);
});
await step('Ctrl+Alt+2 makes a heading, Ctrl+Shift+L toggles checklist', async () => {
  await ev(`caretAtEnd('p:last-of-type')`);
  await page.key('Enter');
  await page.type('Budget');
  await page.key('2', { code: 'Digit2', mods: CTRL | ALT });
  await page.waitFor(`[...ed().querySelectorAll('h2')].some((h) => h.textContent === 'Budget')`);
  await page.key('Enter');
  await page.type('Flights');
  await page.key('l', { mods: CTRL | SHIFT });
  try {
    return await page.waitFor(`[...ed().querySelectorAll('ul.checklist li')].some((li) => li.textContent === 'Flights')`);
  } catch {
    throw new Error((await ev(`ed().innerHTML`)).slice(-400));
  }
});
await step('edits persist in IndexedDB across reload', async () => {
  await page.sleep(600);
  await page.goto(URL);
  await page.waitFor('document.querySelector(".f4-view-NoteRow")');
  await ev(H);
  await page.click(`$has('.f4-view-NoteRow', 'Lisbon')`);
  await page.waitFor(`ed()?.querySelector('a[href="https://carris.pt"]')`);
  return ev(`!!ed().querySelector('table') && ed().innerHTML.includes('<b>Sunscreen</b>')`);
});
await page.screenshot(`${OUT}/e2e-02-editor.png`);

// ---------------------------------------------------------------- notes
await step('✎ new note: title style, focused, appears at top of Today', async () => {
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title^="New note"]')`);
  await page.waitFor(`document.activeElement === ed() && ed().innerHTML.startsWith('<h1>')`);
  await page.type('Shopping list');
  await page.key('Enter');
  await page.type('Coffee beans');
  await page.waitFor(`rows().includes('Shopping list')`);
  return ev(`[...document.querySelectorAll('.f4-view-NoteRow')].find((r) => r.textContent.includes('Shopping list')).textContent.includes('Coffee beans')`);
});
await step('Ctrl+Alt+N creates another note', async () => {
  const before = await ev(`root().notes.length`);
  await page.key('n', { mods: CTRL | ALT });
  return page.waitFor(`root().notes.length === ${before + 1}`);
});
await step('right-click note → Pin Note', async () => {
  await page.click(`$has('.f4-view-NoteRow', 'Shopping list')`, { button: 'right' });
  await page.waitFor(`!!document.querySelector('.f4-view-NoteRow .f4-Menu')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Pin Note')`);
  return page.waitFor(`root().notes.find((n) => n.title === 'Shopping list').pinned && !document.querySelector('.f4-view-NoteRow .f4-Menu')`);
});
await page.click(`$has('.f4-view-NoteRow', 'Shopping list')`, { button: 'right' });
await page.sleep(200);
await page.screenshot(`${OUT}/e2e-06-context-menu.png`);
await page.mouse(1000, 700);
await page.sleep(100);
await step('right-click → Move to… → Personal', async () => {
  await page.click(`$has('.f4-view-NoteRow', 'Shopping list')`, { button: 'right' });
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Move to…')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Personal')`);
  return page.waitFor(`root().notes.find((n) => n.title === 'Shopping list').folder === 'personal'`);
});
await step('⋯ → Duplicate Note', async () => {
  const before = await ev(`root().notes.filter((n) => n.title === 'Shopping list').length`);
  await page.click(`$t('.f4-EditorToolbar button', '⋯')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Duplicate Note')`);
  return page.waitFor(`root().notes.filter((n) => n.title === 'Shopping list').length === ${before + 1}`);
});
await step('click outside closes an open menu', async () => {
  await page.click(`$t('.f4-EditorToolbar button', '⋯')`);
  await page.waitFor(`!!document.querySelector('.f4-EditorToolbar .f4-Menu')`);
  await page.mouse(900, 600);
  return page.waitFor(`!document.querySelector('.f4-EditorToolbar .f4-Menu')`);
});
await step('Delete Note → Recently Deleted (count, banner, read-only), Recover', async () => {
  await page.click(`$t('.f4-EditorToolbar button', '⋯')`);
  await page.click(`$has('.f4-Menu .f4-view-MenuItem', 'Delete Note')`);
  await page.waitFor(`$has('.f4-SidebarItem', 'Recently Deleted')?.textContent.includes('2')`);
  await page.click(`$has('.f4-SidebarItem', 'Recently Deleted')`);
  await page.click(`$has('.f4-view-NoteRow', 'Shopping list')`);
  await page.waitFor(`$has('.f4-view-NoteEditor', 'can’t be edited') && ed().contentEditable === 'false'`);
  await page.click(`$t('.f4-view-NoteEditor button', 'Recover')`);
  return page.waitFor(`root().notes.filter((n) => n.title === 'Shopping list' && !n.deleted_at).length === 2`);
});
await step('Delete Permanently asks first', async () => {
  await page.click(`$has('.f4-view-NoteRow', 'Old draft')`, { button: 'right' });
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Delete Permanently…')`);
  await page.waitFor(`$has('.f4-Menu', 'permanently')`);
  await page.click(`$t('.f4-Menu button', 'Delete')`);
  return page.waitFor(`!root().notes.some((n) => n.id === 'old-draft')`);
});

// ---------------------------------------------------------------- folders & tags
await step('New Folder: inline name field, Enter creates and opens it', async () => {
  await page.click(`$has('.f4-Sidebar button', 'New Folder')`);
  await page.waitFor(`document.activeElement?.value === 'New Folder'`);
  await page.type('Ideas');
  await page.key('Enter');
  await page.waitFor(`root().folders.some((f) => f.name === 'Ideas')`);
  return ev(`document.querySelector('.f4-view-HeaderBar').textContent.includes('Ideas')`);
});
await step('double-click folder → rename', async () => {
  await page.dblclick(`$has('.f4-view-FolderRow', 'Ideas')`);
  await page.waitFor(`document.activeElement?.value === 'Ideas'`);
  await page.type('Someday');
  await page.key('Enter');
  return page.waitFor(`root().folders.some((f) => f.name === 'Someday')`);
});
await step('right-click folder → Delete Folder… → confirm', async () => {
  await page.click(`$has('.f4-view-FolderRow', 'Someday')`, { button: 'right' });
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Delete Folder…')`);
  await page.click(`$t('.f4-Menu button', 'Delete')`);
  return page.waitFor(`!root().folders.some((f) => f.name === 'Someday') && root().view === 'all'`);
});
await step('inside a folder, rows have no folder label', async () => {
  await page.click(`$has('.f4-view-FolderRow', 'Personal')`);
  await page.waitFor(`root().view === 'personal'`);
  return ev(`[...document.querySelectorAll('.f4-view-NoteRow')].every((r) => !r.textContent.includes('📁'))`);
});
await step('tag chip filters notes', async () => {
  await page.click(`$t('.f4-view-TagChip button', '#recipes')`);
  await page.waitFor(`root().view === 'tag:recipes'`);
  return ev(`rows().join(', ')`);
});
await step('search across all notes', async () => {
  await page.click(`$has('.f4-SidebarItem', 'All Notes')`);
  await page.key('f', { mods: CTRL });
  await page.type('parmigiano');
  await page.waitFor(`rows().length === 1`);
  return ev(`rows()[0]`);
});

// ---------------------------------------------------------------- locked notes
await step('lock: first time asks to create a password', async () => {
  await page.click(`$has('.f4-SidebarItem', 'All Notes')`);
  await page.click(`$has('.f4-view-NoteRow', 'Weekly sync')`);
  await page.click(`document.querySelector('.f4-EditorToolbar button[title="Lock note"]')`);
  await page.waitFor(`!!document.querySelector('.f4-view-PasswordSheet')`);
  await page.type('hunter2');
  await page.key('Tab');
  await page.type('hunter2');
  await page.key('Tab');
  await page.type('the classic');
  await page.key('Enter');
  await page.waitFor(`!document.querySelector('.f4-view-PasswordSheet') && root().notes.find((n) => n.id === 'sync').locked`);
  return 'password set, note locked';
});
await step('stored note is encrypted (no plaintext in IndexedDB)', async () => {
  await page.sleep(700);
  return ev(`new Promise((res) => { const r = indexedDB.open('notes-on-foar'); r.onsuccess = () => { const g = r.result.transaction('notes').objectStore('notes').get('sync'); g.onsuccess = () => { const n = g.result; res(n.locked && n.html === '' && !!n.cipher?.data && !JSON.stringify(n).includes('Attendees')); }; }; })`);
});
await step('Lock All Notes hides content; wrong password shows an error; right one unlocks', async () => {
  await page.click(`$has('.f4-Sidebar button', 'Lock All Notes')`);
  await page.waitFor(`$has('.f4-view-NoteEditor', 'This note is locked')`);
  const preview = await ev(`$has('.f4-view-NoteRow', 'Weekly sync').textContent`);
  if (!preview.includes('Locked')) throw new Error('row preview should say Locked: ' + preview);
  await page.screenshot(`${OUT}/e2e-03-locked.png`);
  await page.type('nope');
  await page.key('Enter');
  await page.waitFor(`$has('.f4-view-NoteEditor', 'Incorrect password')`, 6000);
  await page.type('hunter2');
  await page.key('Enter');
  await page.waitFor(`ed()?.textContent.includes('Attendees')`, 6000);
  return 'hint shown: ' + (await ev(`!!$has('.f4-view-NoteEditor', 'the classic') || 'n/a after unlock'`));
});
await step('locked note survives reload encrypted, unlocks again', async () => {
  await page.sleep(500);
  await page.goto(URL);
  await page.waitFor('document.querySelector(".f4-view-NoteRow")');
  await ev(H);
  await page.click(`$has('.f4-view-NoteRow', 'Weekly sync')`);
  await page.waitFor(`$has('.f4-view-NoteEditor', 'Hint: the classic')`);
  await page.click(`document.querySelector('.f4-view-NoteEditor input[type=password]')`);
  await page.type('hunter2');
  await page.key('Enter');
  return page.waitFor(`ed()?.textContent.includes('Attendees')`, 6000);
});
await step('⋯ → Remove Lock', async () => {
  await page.click(`$t('.f4-EditorToolbar button', '⋯')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Remove Lock')`);
  return page.waitFor(`!root().notes.find((n) => n.id === 'sync').locked`);
});

// ---------------------------------------------------------------- view options
await step('☰ → Sort By Title', async () => {
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="View options"]')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Title')`);
  await page.waitFor(`root().sort === 'title'`);
  // Pinned group first, then the rest alphabetically (locked rows have a 🔒 prefix).
  const groups = await ev(`[...document.querySelectorAll('.f4-NoteScroller > .f4-list > .f4-if, .f4-NoteScroller .f4-list .f4-list')].length`);
  const unpinned = await ev(`root().notes.filter((n) => !n.deleted_at && !n.pinned).map((n) => n.title || 'New Note')`);
  const shown = await ev(`rows().slice(root().notes.filter((n) => !n.deleted_at && n.pinned).length).map((t) => t.replace(/^🔒 /, ''))`);
  const expected = [...unpinned].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (JSON.stringify(shown) !== JSON.stringify(expected)) throw new Error(`shown ${JSON.stringify(shown)} expected ${JSON.stringify(expected)}`);
  return shown.slice(0, 4).join(', ');
});
await step('☰ → Gallery view, double-click opens, Esc returns', async () => {
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="View options"]')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Gallery')`);
  await page.waitFor(`document.querySelectorAll('.f4-view-GalleryCard').length > 4`);
  await page.sleep(300);
  await page.screenshot(`${OUT}/e2e-04-gallery.png`);
  await page.dblclick(`$has('.f4-view-GalleryCard', 'Pasta al limone')`);
  await page.waitFor(`ed()?.textContent.includes('Spaghetti') || ed()?.textContent.includes('spaghetti')`);
  await page.key('Escape');
  await page.waitFor(`document.querySelectorAll('.f4-view-GalleryCard').length > 4`);
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="View options"]')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'List')`);
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="View options"]')`);
  await page.click(`$t('.f4-Menu .f4-view-MenuItem', 'Date Edited')`);
  return page.waitFor(`root().layout === 'list' && root().sort === 'edited'`);
});
await step('sidebar toggle', async () => {
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="Hide sidebar"]')`);
  await page.waitFor(`!document.querySelector('.f4-Sidebar')`);
  await page.click(`document.querySelector('.f4-view-HeaderBar button[title="Show sidebar"]')`);
  return page.waitFor(`!!document.querySelector('.f4-Sidebar')`);
});
await step('export: Markdown conversion', async () => {
  const md = await ev(`import(new URL('../examples/notes-on-foar/host/export.js', location.href).href).then((m) => m.toMarkdown(root().notes.find((n) => n.id === 'lisbon').html))`);
  const ok = md.startsWith('# Lisbon trip') && md.includes('- [x] Passport') && md.includes('[Tram 28](https://carris.pt)') && md.includes('| Day | Plan |');
  if (!ok) throw new Error(['# Lisbon', '- [x] Passport', '[Tram 28](https://carris.pt)', '| Day | Plan |'].filter((x) => !md.includes(x)).join(' / ') + ' missing');
  return md.split('\n').slice(0, 3).join(' ⏎ ');
});

// ---------------------------------------------------------------- dark mode
await page.click(`$has('.f4-view-NoteRow', 'Welcome')`);
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await page.sleep(300);
await page.screenshot(`${OUT}/e2e-05-dark.png`);
await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

console.log(`\n${pass} passed, ${fail} failed`);
console.log(problems.length ? `console problems:\n  ${problems.join('\n  ')}` : 'no console errors or warnings');
await page.close();
process.exit(0);
