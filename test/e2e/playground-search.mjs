import os from 'node:os';
import path from 'node:path';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
// Playground workbench e2e: palette, quick open, symbols, go to line, find/replace,
// project search/replace, layout toggles, splitters, zen, status bar.
import { launch } from './cdp.mjs';
import fs from 'node:fs';
const NOTES = new URL('../../examples/notes-on-foar/', import.meta.url).pathname;
const snapshot = () => Object.fromEntries(fs.readdirSync(NOTES, { recursive: true }).filter((f) => f.endsWith('.foar') && !f.startsWith('dist')).map((f) => [f, fs.readFileSync(`${NOTES}/${f}`, 'utf8')]));
const before = snapshot();
const page = await launch({ profile: `${OUT}/chrome-pg5-${Date.now()}` });
const problems = [];
page.on((m) => {
  if (m.method === 'Runtime.exceptionThrown') problems.push(`exception: ${m.params.exceptionDetails.exception?.description}`);
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
});
let pass = 0;
let fail = 0;
async function step(name, fn) {
  try {
    const info = await fn();
    pass++;
    console.log(`✓ ${name}${info ? `  — ${info}` : ''}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}: ${e.message}`);
  }
}
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};
const J = async (expr) => JSON.parse(await page.eval(`JSON.stringify(${expr})`));
const CTRL = 2, ALT = 1, SHIFT = 8;
const activeTa = `document.querySelector('.code-view.active .code-input')`;
const active = () => page.eval(`document.querySelector('.tab.active')?.dataset.path`);
const caretLine = () => page.eval(`(() => { const t = ${activeTa}; return t.value.slice(0, t.selectionStart).split('\\n').length; })()`);
const palItems = () => J(`[...document.querySelectorAll('.pal-item')].map(i => i.textContent)`);
const palOpen = () => page.eval(`!document.querySelector('.pal-scrim').classList.contains('hidden')`);
const visible = (sel) => page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0; })()`);

try {
  await page.goto(`${BASE}/playground/?example=notes-on-foar`);
  await page.eval(`localStorage.clear()`);
  await page.goto(`${BASE}/playground/?example=notes-on-foar`);
  await page.waitFor(`document.querySelectorAll('.tree-row.file').length > 5 && document.getElementById('compiler-status').textContent.includes('files')`, 15000);
  await page.sleep(500);

  await step('workbench chrome: activity bar, command center, layout toggles, status bar', async () => {
    const t = await J(`{ act: document.querySelectorAll('.act-btn').length, center: !!document.querySelector('.command-center'), toggles: [...document.querySelectorAll('.layout-btn')].map(b => b.getAttribute('aria-label') + '=' + b.getAttribute('aria-pressed')), status: document.querySelector('.statusbar').textContent }`);
    ok(t.act === 3 && t.center && t.toggles.length === 4 && (t.status.includes('saved to disk') || t.status.includes('kept in this browser')) && t.status.includes('Ln ') && t.status.includes('⊗ 0'), JSON.stringify(t));
    return t.status.replace(/\s+/g, ' ');
  });

  await step('Ctrl+P quick open: fuzzy file search, Enter opens', async () => {
    await page.key('p', { mods: CTRL });
    await page.waitFor(`!document.querySelector('.pal-scrim').classList.contains('hidden')`, 2000);
    await page.type('notrow');
    await page.sleep(80);
    const items = await palItems();
    ok(items[0]?.startsWith('▤NoteRow.foar'), JSON.stringify(items.slice(0, 3)));
    await page.key('Enter');
    await page.sleep(150);
    ok((await active()) === 'components/list/NoteRow.foar' && !(await palOpen()), await active());
    return `top hits: ${items.slice(0, 3).join(' | ')}`;
  });

  await step('empty quick open lists recently opened files first', async () => {
    await page.key('p', { mods: CTRL });
    await page.sleep(80);
    const items = await palItems();
    ok(items[0].includes('NoteRow.foar') && items[0].includes('recently opened'), JSON.stringify(items.slice(0, 2)));
    await page.key('Escape');
    await page.sleep(80);
    ok(!(await palOpen()), 'still open');
  });

  await step('Ctrl+Shift+P command palette: run "Toggle Preview" by fuzzy name', async () => {
    await page.key('p', { mods: CTRL | SHIFT });
    await page.sleep(80);
    const all = (await palItems()).length;
    await page.type('tog prev');
    await page.sleep(80);
    const items = await palItems();
    ok(items[0].startsWith('View: Toggle Preview') && items[0].includes('Ctrl+Alt+B'), JSON.stringify(items.slice(0, 2)));
    await page.key('Enter');
    await page.sleep(120);
    ok(!(await visible('.preview-section')) && (await visible('.inspector-section')), 'preview still visible');
    return `${all} commands`;
  });

  await step('Ctrl+Alt+B brings the preview back; Ctrl+J toggles tools', async () => {
    await page.key('b', { mods: CTRL | ALT });
    await page.sleep(80);
    ok(await visible('.preview-section'), 'preview hidden');
    await page.key('j', { mods: CTRL });
    await page.sleep(80);
    const t = await J(`{ tools: document.querySelector('.inspector-section').offsetParent !== null, previewH: document.querySelector('.preview-section').getBoundingClientRect().height, rightH: document.querySelector('.right-column').getBoundingClientRect().height }`);
    ok(!t.tools && Math.abs(t.previewH - t.rightH) < 2, JSON.stringify(t));
    await page.key('j', { mods: CTRL });
    await page.sleep(80);
    ok(await visible('.inspector-section'), 'tools not back');
  });

  await step('hiding preview and tools gives the editor the full width', async () => {
    await page.key('b', { mods: CTRL | ALT });
    await page.key('j', { mods: CTRL });
    await page.sleep(80);
    const t = await J(`{ editor: document.querySelector('.editor-pane').getBoundingClientRect().width, win: innerWidth, right: document.querySelector('.right-column').offsetParent !== null }`);
    ok(!t.right && t.editor >= t.win - 2, JSON.stringify(t));
    await page.key('b', { mods: CTRL | ALT });
    await page.key('j', { mods: CTRL });
    await page.sleep(80);
  });

  await step('Ctrl+B toggles the sidebar; the activity bar toggles panels', async () => {
    await page.key('b', { mods: CTRL });
    await page.sleep(80);
    ok(!(await visible('.sidebar')), 'sidebar visible');
    await page.click(`document.querySelector('.act-btn[data-panel="search"]')`);
    await page.sleep(80);
    const t = await J(`{ side: document.querySelector('.sidebar').offsetParent !== null, search: document.querySelector('.search-panel').offsetParent !== null, explorer: document.querySelector('.explorer').offsetParent !== null, focus: document.activeElement.getAttribute('aria-label') }`);
    ok(t.side && t.search && !t.explorer && t.focus === 'Search in all files', JSON.stringify(t));
    await page.click(`document.querySelector('.act-btn[data-panel="explorer"]')`);
    await page.sleep(80);
    ok(await visible('.explorer'), 'explorer not shown');
  });

  await step('Ctrl+K Z zen mode hides everything but the editor', async () => {
    await page.eval(`${activeTa}.focus()`);
    await page.key('k', { mods: CTRL });
    await page.key('z');
    await page.sleep(100);
    const t = await J(`{ zen: document.body.classList.contains('zen'), topbar: document.querySelector('.topbar').offsetParent !== null, side: document.querySelector('.sidebar').offsetParent !== null, right: document.querySelector('.right-column').offsetParent !== null, editor: document.querySelector('.code-view.active').getBoundingClientRect().width > 0 }`);
    ok(t.zen && !t.topbar && !t.side && !t.right && t.editor, JSON.stringify(t));
    await page.key('k', { mods: CTRL });
    await page.key('z');
    await page.sleep(100);
    ok(await visible('.topbar') && await visible('.sidebar'), 'not restored');
  });

  await step('Ctrl+G go to line', async () => {
    await page.eval(`${activeTa}.focus()`);
    await page.key('g', { mods: CTRL });
    await page.type('30');
    await page.sleep(60);
    const items = await palItems();
    await page.key('Enter');
    await page.sleep(100);
    const line = await caretLine();
    const status = await page.eval(`document.querySelector('.statusbar').textContent`);
    ok(line === 30 && status.includes('Ln 30, Col 1') && items[0].startsWith('Go to line 30'), `${line} ${status}`);
    return items[0];
  });

  await step('Ctrl+Shift+O symbols in file (views, states, effects)', async () => {
    await page.key('o', { mods: CTRL | SHIFT });
    await page.sleep(80);
    const items = await palItems();
    ok(items.some((i) => i.includes('NoteRow') && i.includes('view')) && items.some((i) => i.includes('state')), JSON.stringify(items));
    await page.key('Escape');
    return items.slice(0, 4).join(' | ');
  });

  await step('# project symbols: jump to a view in another file', async () => {
    await page.key('p', { mods: CTRL });
    await page.type('#FormatB');
    await page.sleep(80);
    const items = await palItems();
    await page.key('Enter');
    await page.sleep(150);
    const a = await active();
    const lineText = await page.eval(`(() => { const t = ${activeTa}; const s = t.value.lastIndexOf('\\n', t.selectionStart - 1) + 1; return t.value.slice(s, t.value.indexOf('\\n', s)); })()`);
    ok(a === 'components/editor/FormatBar.foar' && lineText.startsWith('view FormatBar'), `${a}: ${lineText}`);
    return items.slice(0, 2).join(' | ');
  });

  await step('Ctrl+F find: count, marks, Enter / Shift+Enter, Esc clears', async () => {
    await page.eval(`(() => { const t = ${activeTa}; t.focus(); t.setSelectionRange(0, 0); })()`);
    await page.key('f', { mods: CTRL });
    await page.waitFor(`document.querySelector('.findbar.open')`, 1000);
    await page.type('transition');
    await page.sleep(80);
    const t1 = await J(`{ count: document.querySelector('.fb-count').textContent, marks: document.querySelectorAll('.code-view.active .code-mark').length, cur: document.querySelectorAll('.code-view.active .code-mark.current').length, focus: document.activeElement.getAttribute('aria-label') }`);
    ok(/^1 of \d+$/.test(t1.count) && t1.marks > 3 && t1.cur === 1 && t1.focus === 'Find in file', JSON.stringify(t1));
    await page.key('Enter');
    const c2 = await page.eval(`document.querySelector('.fb-count').textContent`);
    await page.key('Enter', { mods: SHIFT });
    const c3 = await page.eval(`document.querySelector('.fb-count').textContent`);
    ok(c2.startsWith('2 of') && c3.startsWith('1 of'), `${c2} / ${c3}`);
    // whole word toggle via Alt+W changes the count ("transition" also matches inside other words? use case toggle)
    await page.key('Escape');
    await page.sleep(60);
    const t2 = await J(`{ open: !!document.querySelector('.findbar.open'), marks: document.querySelectorAll('.code-mark').length, focus: document.activeElement.classList.contains('code-input'), sel: (() => { const t = ${activeTa}; return t.value.slice(t.selectionStart, t.selectionEnd); })() }`);
    ok(!t2.open && t2.marks === 0 && t2.focus && t2.sel === 'transition', JSON.stringify(t2));
    return `${t1.count}, ${t1.marks} marks`;
  });

  await step('find marks line up with the text', async () => {
    await page.key('f', { mods: CTRL });
    await page.sleep(80);
    const t = await J(`(() => { const v = document.querySelector('.code-view.active'); const m = v.querySelector('.code-mark.current').getBoundingClientRect(); const ta = v.querySelector('.code-input');
      // measure where the selected text is: put a probe range into the highlighted pre at the same offsets
      const pre = v.querySelector('.code-hl code'); const r = document.createRange(); let off = ta.selectionStart, node, walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      while ((node = walker.nextNode())) { if (off <= node.data.length) break; off -= node.data.length; }
      r.setStart(node, off); r.setEnd(node, Math.min(node.data.length, off + 3)); const t = r.getBoundingClientRect();
      return { dx: Math.round(m.left - t.left), dy: Math.round(m.top - t.top) }; })()`);
    ok(Math.abs(t.dx) <= 1 && Math.abs(t.dy) <= 3, JSON.stringify(t));
    await page.key('Escape');
    return JSON.stringify(t);
  });

  await step('Ctrl+Shift+F project search: results by file, include filter, regex, open match', async () => {
    await page.key('f', { mods: CTRL | SHIFT });
    await page.sleep(100);
    await page.eval(`(() => { const i = document.querySelector('.search-panel .sf-input'); i.select(); })()`);
    await page.type('MenuItem(');
    await page.sleep(250);
    const t1 = await J(`{ summary: document.querySelector('.sr-summary').textContent, files: [...document.querySelectorAll('.sr-file')].map(f => f.querySelector('.sr-name').textContent + ':' + f.querySelector('.sr-count').textContent) }`);
    ok(/results? in \d+ files?/.test(t1.summary) && t1.files.length >= 4, JSON.stringify(t1));
    await page.click(`document.querySelector('.search-panel [aria-label="Toggle search details"]')`);
    await page.type('components/menus/**');
    await page.sleep(250);
    const t2 = await J(`{ summary: document.querySelector('.sr-summary').textContent, files: [...document.querySelectorAll('.sr-file .sr-name')].map(f => f.textContent) }`);
    ok(t2.files.every((f) => ['ContextMenu.foar', 'NoteMenu.foar', 'MenuItem.foar'].includes(f)), JSON.stringify(t2));
    await page.eval(`document.querySelector('.search-panel input[aria-label="Files to include"]').value = ''; document.querySelector('.search-panel input[aria-label="Files to include"]').dispatchEvent(new Event('input'))`);
    // regex
    await page.eval(`(() => { const i = document.querySelector('.search-panel .sf-input'); i.focus(); i.select(); })()`);
    await page.type('state (Menu|Renaming)\\b');
    await page.click(`document.querySelector('.search-panel .sf-toggle[aria-label^="Use regular"]')`);
    await page.sleep(250);
    const t3 = await J(`{ summary: document.querySelector('.sr-summary').textContent, first: document.querySelector('.sr-match')?.textContent }`);
    ok(/result/.test(t3.summary) && /state (Menu|Renaming)/.test(t3.first), JSON.stringify(t3));
    await page.click(`document.querySelector('.sr-match')`);
    await page.sleep(150);
    const sel = await page.eval(`(() => { const t = ${activeTa}; return t.value.slice(t.selectionStart, t.selectionEnd); })()`);
    ok(/^state (Menu|Renaming)$/.test(sel), sel);
    return `${t1.summary}; regex: ${t3.summary}; opened ${await active()}`;
  });

  await step('search results are keyboard navigable', async () => {
    await page.eval(`document.querySelector('.sr-row').focus()`);
    await page.key('ArrowDown');
    await page.key('ArrowDown');
    const f = await J(`{ cls: document.activeElement.className, role: document.activeElement.getAttribute('role') }`);
    await page.key('Enter');
    await page.sleep(120);
    const focusEditor = await page.eval(`document.activeElement.classList.contains('code-input')`);
    ok(f.role === 'treeitem' && focusEditor, JSON.stringify(f));
  });

  await step('splitters resize with the keyboard and layout survives a reload', async () => {
    await page.eval(`document.querySelector('.workspace > .splitter').focus()`);
    const w0 = await page.eval(`document.querySelector('.editor-pane').getBoundingClientRect().width`);
    await page.key('ArrowRight', { mods: SHIFT });
    await page.sleep(60);
    const w1 = await page.eval(`document.querySelector('.editor-pane').getBoundingClientRect().width`);
    ok(w1 > w0 + 50, `${w0} -> ${w1}`);
    await page.key('j', { mods: CTRL }); // hide tools
    await page.goto(`${BASE}/playground/?example=notes-on-foar`);
    await page.waitFor(`document.querySelectorAll('.tree-row.file').length > 5`, 15000);
    await page.sleep(300);
    const t = await J(`{ w: document.querySelector('.editor-pane').getBoundingClientRect().width, tools: document.querySelector('.inspector-section').offsetParent !== null }`);
    ok(Math.abs(t.w - w1) < 4 && !t.tools, JSON.stringify(t));
    await page.key('j', { mods: CTRL });
    await page.eval(`document.querySelector('.workspace > .splitter').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    return `${Math.round(w0)}px → ${Math.round(w1)}px, kept after reload`;
  });

  // ---- replace (scratch project: never touches disk) ----
  await page.goto(`${BASE}/playground/?example=scratch`);
  await page.waitFor(`document.getElementById('compiler-status').textContent.includes('mounted')`, 15000);
  await page.eval(`localStorage.removeItem('foar.playground.v1.scratch')`);
  await page.goto(`${BASE}/playground/?example=scratch`);
  await page.waitFor(`document.getElementById('compiler-status').textContent.includes('mounted')`, 15000);
  await page.sleep(300);

  await step('Ctrl+H replace in file: one, then all; one Ctrl+Z undoes "replace all"', async () => {
    await page.click(`document.querySelector('.tab[data-path="app.foar"]')`);
    await page.eval(`(() => { const t = ${activeTa}; t.focus(); t.setSelectionRange(0, 0); })()`);
    await page.key('h', { mods: CTRL });
    await page.sleep(80);
    await page.eval(`(() => { const i = document.querySelector('.findbar .sf-input'); i.value = 'count'; i.dispatchEvent(new Event('input')); })()`);
    await page.sleep(60);
    const n0 = await page.eval(`document.querySelector('.fb-count').textContent`);
    await page.eval(`document.querySelector('.findbar input[aria-label="Replace with"]').focus()`);
    await page.type('clicks');
    await page.key('Enter'); // replace one
    await page.sleep(80);
    const n1 = await page.eval(`document.querySelector('.fb-count').textContent`);
    await page.key('Enter', { mods: CTRL | ALT }); // replace all
    await page.sleep(150);
    const t = await J(`{ val: ${activeTa}.value, count: document.querySelector('.fb-count').textContent, preview: document.getElementById('f4-mount').textContent }`);
    ok(!/\\bcount\\b/.test(t.val) && t.val.includes('store clicks') && t.preview.includes('Clicked 0 times'), JSON.stringify({ n0, n1, count: t.count }));
    await page.key('Escape');
    await page.eval(`${activeTa}.focus()`);
    await page.key('z', { mods: CTRL });
    await page.sleep(100);
    const after = await page.eval(`${activeTa}.value`);
    ok((after.match(/\bcount\b/g) || []).length === Number(n0.split(' of ')[1]) - 1, `undo left ${(after.match(/\bcount\b/g) || []).length}`);
    await page.key('z', { mods: CTRL });
    await page.sleep(100);
    return `${n0} → ${n1} → ${t.count}`;
  });

  await step('project replace all (with confirmation) changes every file, and the preview', async () => {
    await page.key('h', { mods: CTRL | SHIFT });
    await page.sleep(100);
    await page.eval(`(() => { const i = document.querySelector('.search-panel .sf-input'); i.value = 'another file'; i.dispatchEvent(new Event('input')); })()`);
    await page.sleep(250);
    const found = await page.eval(`document.querySelector('.sr-summary').textContent`);
    await page.eval(`(() => { const r = document.querySelector('.search-panel input[aria-label="Replace with"]'); r.focus(); r.value = 'a second file'; r.dispatchEvent(new Event('input')); })()`);
    await page.sleep(80);
    const preview = await page.eval(`document.querySelector('.sr-match')?.innerHTML`);
    await page.click(`document.querySelector('.search-panel [aria-label="Replace all"]')`);
    await page.waitFor(`!document.querySelector('.sr-confirm').classList.contains('hidden')`, 1000);
    const q = await page.eval(`document.querySelector('.sr-confirm').textContent`);
    await page.click(`document.querySelector('.sr-confirm .primary')`);
    await page.waitFor(`document.getElementById('f4-mount').textContent.includes('a second file')`, 3000);
    const t = await J(`{ summary: document.querySelector('.sr-summary').textContent, all: [...document.querySelectorAll('.code-input')].map(t => t.value).join('\\n') }`);
    ok(!t.all.includes('another file') && preview.includes('<del>') && preview.includes('<ins>'), JSON.stringify(t.summary));
    return `${found}; ${q.split('?')[0]}? → ${t.summary}`;
  });

  await step('status bar shows compile errors; F8 jumps to the error', async () => {
    await page.click(`document.querySelector('.tab[data-path="app.foar"]')`);
    await page.eval(`(() => { const t = ${activeTa}; t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`);
    await page.type('\nview {');
    await page.waitFor(`document.querySelector('.sb-item.err')`, 3000);
    const sb = await page.eval(`document.querySelector('.sb-item.err').textContent`);
    await page.eval(`(() => { const t = ${activeTa}; t.setSelectionRange(0, 0); })()`);
    await page.key('F8');
    await page.sleep(100);
    const line = await caretLine();
    const banner = await page.eval(`document.querySelector('.error-link')?.textContent ?? ''`);
    ok(sb.startsWith('⊗ 1') && banner.startsWith(`app.foar:${line}:`), `${sb} / ${banner} vs line ${line}`);
    await page.key('z', { mods: CTRL });
    await page.waitFor(`!document.querySelector('.sb-item.err')`, 3000);
    return sb.trim();
  });

  await step('palette and panels are accessible (roles, labels, focus return)', async () => {
    await page.eval(`${activeTa}.focus()`);
    await page.key('p', { mods: CTRL | SHIFT });
    await page.sleep(60);
    const t = await J(`{ dialog: document.querySelector('.palette').getAttribute('role'), modal: document.querySelector('.palette').getAttribute('aria-modal'), combo: document.activeElement.getAttribute('role'), listbox: document.querySelector('.pal-list').getAttribute('role'), active: document.activeElement.getAttribute('aria-activedescendant'), opt: document.querySelector('#' + document.activeElement.getAttribute('aria-activedescendant'))?.getAttribute('aria-selected') }`);
    await page.key('Escape');
    await page.sleep(60);
    const back = await page.eval(`document.activeElement.classList.contains('code-input')`);
    ok(t.dialog === 'dialog' && t.modal === 'true' && t.combo === 'combobox' && t.listbox === 'listbox' && t.opt === 'true' && back, JSON.stringify(t));
  });

  await page.eval(`localStorage.removeItem('foar.playground.v1.scratch'); localStorage.removeItem('foar.playground.layout.v1')`);
  await page.goto(`${BASE}/playground/?example=notes-on-foar`);
  await page.waitFor(`document.querySelectorAll('.tree-row.file').length > 5`, 15000);
  await page.sleep(600);
  await page.screenshot(`${OUT}/pg5-workbench.png`);
  await page.key('p', { mods: CTRL | SHIFT });
  await page.sleep(150);
  await page.screenshot(`${OUT}/pg5-palette.png`);
  await page.key('Escape');
  await page.key('f', { mods: CTRL | SHIFT });
  await page.type('Menu');
  await page.sleep(300);
  await page.eval(`${activeTa}.focus()`);
  await page.key('f', { mods: CTRL });
  await page.type('style');
  await page.sleep(200);
  await page.screenshot(`${OUT}/pg5-search.png`);
} catch (e) {
  fail++;
  console.log(`✗ setup: ${e.message.split('\n')[0]}`);
} finally {
  const after = snapshot();
  const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f]);
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log(changed.length ? `⚠ notes files changed on disk: ${changed.join(', ')}` : 'notes-on-foar files untouched');
  console.log(problems.join('\n') || 'no console errors or warnings');
  await page.close();
  process.exit(fail ? 1 : 0);
}
