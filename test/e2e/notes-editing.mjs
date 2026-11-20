import os from 'node:os';
import path from 'node:path';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
// E2E for formatting, drag and drop, context menus, keyboard, i18n and a11y.
import { launch } from './cdp.mjs';

const URL = `${BASE}/playground/app.html?example=notes-on-foar`;
const ALT = 1, CTRL = 2, SHIFT = 8;
const page = await launch({ profile: `${OUT}/chrome-v3-${Date.now()}` });
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
const expect = async (expr, msgExpr = 'ed().innerHTML') => {
  if (!(await ev(expr))) throw new Error(String(await ev(msgExpr)).slice(0, 300));
  return true;
};

const H = `
  window.$t = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);
  window.$has = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
  window.ed = () => document.querySelector('.f4-richtext');
  window.root = () => { const b = foarApp.getContext('Browse'); return { ...foarApp.getSnapshot().find((i) => i.key === 'root').stores, ...foarApp.getContext('Library'), ...foarApp.getContext('Prefs'), ...foarApp.getContext('Vault'), ...b, selected_id: b.selected }; };
  window.textNode = (text) => { const w = document.createTreeWalker(ed(), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(text); if (i >= 0) return [n, i]; } return null; };
  window.selectSpan = (a, b) => { const [n1, i1] = textNode(a); const [n2, i2] = textNode(b); ed().focus();
    const r = document.createRange(); r.setStart(n1, i1); r.setEnd(n2, i2 + b.length); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; };
  window.caretIn = (text, atEnd = true) => { const [n, i] = textNode(text); ed().focus(); const r = document.createRange();
    r.setStart(n, atEnd ? i + text.length : i); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; };
  window.lines = () => [...ed().children].map((e) => e.tagName + (e.className ? '.' + e.className : '') + ':' + e.textContent.trim()).join(' | ');
  window.dnd = (src, dst) => { const dt = new DataTransfer(); const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire(src, 'dragstart'); fire(dst, 'dragenter'); const over = fire(dst, 'dragover'); const hl = dst.classList.contains('f4-drop-over') || !!dst.closest('.f4-drop-over'); fire(dst, 'drop'); fire(src, 'dragend'); return { accepted: !over, hl, text: dt.getData('text/plain') }; };
  window.menuItems = () => [...document.querySelectorAll('[role=menu] [role^=menuitem]')].map((e) => e.querySelectorAll('.f4-text')[1].textContent.trim());
  true`;

await page.goto(URL);
await page.waitFor('document.querySelector("[role=option]")');
await ev(H);
await page.click(`document.querySelector('.f4-view-NoteRow .f4-row')`);
await page.sleep(300);

// ---------------------------------------------------------------- multi-line formatting
await step('new note with four lines', async () => {
  await page.key('n', { mods: CTRL | ALT });
  await page.waitFor(`document.activeElement === ed()`);
  for (const [i, w] of ['Shopping', 'alpha', 'beta', 'gamma'].entries()) {
    if (i) await page.key('Enter');
    await page.type(w);
  }
  return expect(`ed().textContent.includes('gamma')`, 'lines()');
});

await step('select three lines → Aa ▸ Bulleted List makes ONE list of three items', async () => {
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.click(`$t('.f4-view-FormatButtons button', 'Aa')`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Bulleted List')`);
  return expect(`ed().querySelectorAll(':scope > ul > li').length === 3 && !ed().querySelector(':scope p ul, :scope div ul') && ed().querySelector(':scope > h1')?.textContent === 'Shopping'`, 'ed().innerHTML');
});

await step('Aa popover stays open and shows the checkmark on Bulleted List', async () =>
  expect(`!!$has('[role=menuitemcheckbox][aria-checked=true]', 'Bulleted List')`, 'menuItems().join(",")'));

await step('same selection → Checklist button converts all three', async () => {
  await page.key('Escape');
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][1]`);
  return expect(`ed().querySelectorAll('ul.checklist > li').length === 3`, 'lines()');
});

await step('Ctrl ⇧ 9 → numbered; again → back to body text', async () => {
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.key('(', { code: 'Digit9', mods: CTRL | SHIFT });
  await expect(`ed().querySelectorAll(':scope > ol > li').length === 3`, 'lines()');
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.key('(', { code: 'Digit9', mods: CTRL | SHIFT });
  return expect(`!ed().querySelector('ol, ul') && lines().includes('alpha') && ed().children.length === 4`, 'lines()');
});

await step('undo / redo (Ctrl Z / Ctrl ⇧ Z) step through formatting', async () => {
  await page.key('z', { mods: CTRL });
  await expect(`ed().querySelectorAll('ol > li').length === 3`, 'lines()');
  await page.key('z', { mods: CTRL });
  await expect(`ed().querySelectorAll('ul.checklist > li').length === 3`, 'lines()');
  await page.key('z', { mods: CTRL | SHIFT });
  await expect(`ed().querySelectorAll('ol > li').length === 3`, 'lines()');
  await page.key('z', { mods: CTRL | SHIFT });
  return expect(`!ed().querySelector('ol')`, 'lines()');
});

await step('Title/Heading on several lines, then Body', async () => {
  await ev(`selectSpan('alpha', 'beta')`);
  await page.key('2', { code: 'Digit2', mods: CTRL | ALT });
  await expect(`ed().querySelectorAll(':scope > h2').length === 2`, 'lines()');
  await ev(`selectSpan('alpha', 'beta')`);
  await page.key('0', { code: 'Digit0', mods: CTRL | ALT });
  return expect(`ed().querySelectorAll(':scope > h2').length === 0`, 'lines()');
});

await step('Tab nests a list item, ⇧Tab un-nests it', async () => {
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.key('*', { code: 'Digit7', mods: CTRL | SHIFT });
  await ev(`caretIn('beta')`);
  await page.key('Tab');
  await expect(`!!ed().querySelector('ul > li > ul > li') && ed().querySelector('ul > li > ul > li').textContent === 'beta'`, 'ed().innerHTML');
  await page.key('Tab', { mods: SHIFT });
  return expect(`!ed().querySelector('li ul') && ed().querySelectorAll(':scope > ul > li').length === 3`, 'ed().innerHTML');
});

await step('Move line down (Alt ⇧ ↓) and up', async () => {
  await ev(`caretIn('alpha')`);
  await page.key('ArrowDown', { mods: ALT | SHIFT });
  await expect(`[...ed().querySelectorAll('li')].map((l) => l.textContent).join() === 'beta,alpha,gamma'`, `[...ed().querySelectorAll('li')].map((l) => l.textContent).join()`);
  await page.key('ArrowUp', { mods: ALT | SHIFT });
  return expect(`[...ed().querySelectorAll('li')].map((l) => l.textContent).join() === 'alpha,beta,gamma'`, `[...ed().querySelectorAll('li')].map((l) => l.textContent).join()`);
});

await step('Block quote (Ctrl \') and center alignment (Aa ▸ ↔)', async () => {
  await ev(`caretIn('Shopping')`);
  await page.key("'", { code: 'Quote', mods: CTRL });
  await expect(`ed().querySelector(':scope > blockquote')?.textContent === 'Shopping'`, 'lines()');
  await page.click(`$t('.f4-view-FormatButtons button', 'Aa')`);
  await page.click(`$t('.f4-view-Key button', '↔')`);
  await page.key('Escape');
  return expect(`ed().querySelector(':scope > blockquote').style.textAlign === 'center'`, 'ed().innerHTML');
});

await step('typing "- " at the start of a line starts a dashed list', async () => {
  await ev(`caretIn('gamma')`);
  await page.key('Enter');
  await page.key('Enter'); // leave the list
  await page.type('- ');
  await page.type('dash item');
  return expect(`[...ed().querySelectorAll('ul.dashed > li')].some((l) => l.textContent === 'dash item')`, 'lines()');
});

await step('checklist: mark checked (Ctrl ⌥ U), move checked to bottom, delete checked', async () => {
  await ev(`selectSpan('alpha', 'gamma')`);
  await page.key('L', { code: 'KeyL', mods: CTRL | SHIFT });
  await ev(`caretIn('alpha')`);
  await page.key('u', { code: 'KeyU', mods: CTRL | ALT });
  await expect(`$t('ul.checklist > li', 'alpha')?.hasAttribute('data-checked')`, 'ed().innerHTML');
  await page.click(`$t('.f4-view-FormatButtons button', 'Aa')`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Move Checked to Bottom')`);
  await expect(`[...ed().querySelectorAll('ul.checklist > li')].map((l) => l.textContent).join() === 'beta,gamma,alpha'`, `[...ed().querySelectorAll('ul.checklist > li')].map((l) => l.textContent).join()`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Delete Checked Items')`);
  await page.key('Escape');
  return expect(`[...ed().querySelectorAll('ul.checklist > li')].map((l) => l.textContent).join() === 'beta,gamma'`, 'ed().innerHTML');
});

await step('table: insert, then ⊞ offers row/column commands', async () => {
  await ev(`caretIn('dash item')`);
  await page.key('Enter');
  await page.key('Enter');
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][2]`);
  await expect(`!!ed().querySelector('table') && document.activeElement === ed()`, 'lines()');
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][2]`);
  await expect(`menuItems().includes('Add Column After')`, 'menuItems().join()');
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Add Column After')`);
  await expect(`ed().querySelector('table tr').cells.length === 4`, `ed().querySelector('table').outerHTML`);
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][2]`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Delete Row')`);
  return expect(`ed().querySelector('table').rows.length === 2`, `ed().querySelector('table').outerHTML`);
});

await step('text color red, then Default removes it', async () => {
  await ev(`selectSpan('beta', 'beta')`);
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][4]`);
  await page.click(`[...document.querySelectorAll('.f4-view-Swatch button')].find((b) => b.title === 'Red')`);
  await expect(`!![...ed().querySelectorAll('[style*="color"]')].find((s) => s.textContent === 'beta' && s.style.color)`, 'ed().innerHTML');
  await ev(`selectSpan('beta', 'beta')`);
  await page.click(`[...document.querySelectorAll('.f4-view-FormatButtons button')][4]`);
  await page.click(`[...document.querySelectorAll('.f4-view-Swatch button')].find((b) => b.title === 'Default color')`);
  return expect(`![...ed().querySelectorAll('[style]')].some((s) => s.style.color)`, 'ed().innerHTML');
});

await step('collapsible section: chevron hides the lines under a heading, click again shows them', async () => {
  await ev(`caretIn('Shopping')`);
  await page.key('1', { code: 'Digit1', mods: CTRL | ALT });
  const h = await page.center(`ed().querySelector(':scope > h1')`);
  await page.mouse(h.left - 14, h.y);
  await expect(`ed().querySelector(':scope > h1').hasAttribute('data-collapsed') && [...ed().children].filter((e) => e.hasAttribute('data-folded')).length >= 3`, 'lines()');
  const visible = await ev(`[...ed().children].filter((e) => e.offsetParent !== null).length`);
  await page.mouse(h.left - 14, h.y);
  await expect(`![...ed().children].some((e) => e.hasAttribute('data-folded'))`, 'lines()');
  return `${visible} line(s) visible while collapsed`;
});

await step('editor context menu at the pointer: Heading applies to the line', async () => {
  const c = await page.center(`$t('ul.checklist > li', 'gamma')`);
  await page.mouse(c.x, c.y, { button: 'right' });
  await page.waitFor(`menuItems().includes('Cut') && menuItems().includes('Heading')`);
  const pos = await ev(`(() => { const r = document.querySelector('.f4-view-ContextMenu [role=menu]').getBoundingClientRect(); return Math.abs(r.left - ${c.x}) < 4 && Math.abs(r.top - ${c.y}) < 4; })()`);
  if (!pos) throw new Error('menu not at pointer');
  await expect(`menuItems().includes('Mark as Checked')`, 'menuItems().join()'); // checklist commands appear in a checklist
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Heading')`);
  return expect(`ed().querySelector(':scope > h2')?.textContent === 'gamma' && !document.querySelector('.f4-view-ContextMenu')`, 'lines()');
});

// ---------------------------------------------------------------- drag and drop
let movedTitle = '';
await step('drag a note onto the “Work” folder: moves it, toast with Undo', async () => {
  movedTitle = await ev(`root().notes.find((n) => n.title === 'Groceries') ? 'Groceries' : root().notes.find((n) => n.folder === 'personal').title`);
  const r = await ev(`dnd($has('[role=option]', ${JSON.stringify(movedTitle)}), $has('.f4-view-FolderRow [role=listitem]', 'Work'))`);
  if (!r.accepted || !r.hl) throw new Error(JSON.stringify(r));
  await page.waitFor(`root().notes.find((n) => n.title === ${JSON.stringify(movedTitle)}).folder === 'work'`);
  await page.waitFor(`!!$has('[role=status]', 'Moved to “Work”')`);
  return `dragged "${r.text}"`;
});
await step('Undo in the toast moves it back', async () => {
  await page.click(`$t('[role=status] button', 'Undo')`);
  await page.waitFor(`root().notes.find((n) => n.title === ${JSON.stringify(movedTitle)}).folder !== 'work'`);
  return expect(`!document.querySelector('.f4-view-Toast')`, 'document.querySelector("[role=status]").textContent');
});
await step('drag a note onto Recently Deleted deletes it; Undo recovers it', async () => {
  const r = await ev(`dnd($has('[role=option]', ${JSON.stringify(movedTitle)}), $has('.f4-SidebarItem', 'Recently Deleted'))`);
  if (!r.accepted) throw new Error(JSON.stringify(r));
  await page.waitFor(`root().notes.find((n) => n.title === ${JSON.stringify(movedTitle)}).deleted_at > 0`);
  await page.click(`$t('[role=status] button', 'Undo')`);
  await page.waitFor(`root().notes.find((n) => n.title === ${JSON.stringify(movedTitle)}).deleted_at === 0`);
  return true;
});
await step('files dragged from outside are not hijacked by note drop targets', async () =>
  ev(`(() => { const dt = new DataTransfer(); const e = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }); $has('.f4-view-FolderRow [role=listitem]', 'Work').dispatchEvent(e); return !e.defaultPrevented; })()`));

// ---------------------------------------------------------------- keyboard
await step('note list: one tab stop, ↓ / End move selection and focus', async () => {
  await page.click(`$has('.f4-SidebarItem', 'All Notes')`);
  await ev(`document.querySelector('[role=option][aria-selected=true]').focus()`);
  const tabStops = await ev(`document.querySelectorAll('[role=listbox] [role=option][tabindex="0"]').length`);
  const before = await ev(`root().selected_id`);
  await page.key('ArrowDown');
  await page.waitFor(`root().selected_id !== ${JSON.stringify(before)} && document.activeElement.getAttribute('aria-selected') === 'true'`);
  await page.key('End');
  await page.waitFor(`document.activeElement === [...document.querySelectorAll('[role=option]')].at(-1)`);
  return tabStops === 1 ? 'roving tabindex' : false;
});
await step('View options from the keyboard: focus goes into the menu, ↓ moves, Esc returns focus', async () => {
  await ev(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'View options').focus()`);
  await page.key('Tab', { mods: SHIFT });
  await page.key('Tab');
  await page.key('Enter');
  await page.waitFor(`document.activeElement?.closest('[role=menu]') && document.activeElement.textContent.includes('List')`);
  await page.key('ArrowDown');
  const second = await ev(`document.activeElement.querySelectorAll('.f4-text')[1].textContent`);
  await page.key('Escape');
  await page.waitFor(`!document.querySelector('[role=menu]') && document.activeElement?.getAttribute('aria-label') === 'View options'`);
  return `↓ → ${second}`;
});
await step('sidebar divider: focusable separator, → widens the sidebar', async () => {
  const w0 = await ev(`document.querySelector('.f4-Sidebar').getBoundingClientRect().width`);
  await ev(`document.querySelector('.f4-SidebarSplitter').focus()`);
  await page.key('ArrowRight');
  await page.key('ArrowRight');
  const w1 = await ev(`document.querySelector('.f4-Sidebar').getBoundingClientRect().width`);
  const now = await ev(`document.querySelector('.f4-SidebarSplitter').getAttribute('aria-valuenow')`);
  if (w1 - w0 !== 32) throw new Error(`${w0} → ${w1}`);
  return `${w0}px → ${w1}px (aria-valuenow ${now})`;
});
await step('dragging the list divider resizes the note list', async () => {
  const s = await page.center(`document.querySelector('.f4-ListSplitter')`);
  const w0 = await ev(`document.querySelector('.f4-ListPane').getBoundingClientRect().width`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x + 30, y: s.y, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x + 60, y: s.y, button: 'left', buttons: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x + 60, y: s.y, button: 'left', clickCount: 1 });
  const w1 = await ev(`document.querySelector('.f4-ListPane').getBoundingClientRect().width`);
  return Math.abs(w1 - w0 - 60) <= 2 ? `${w0}px → ${w1}px` : false;
});

// ---------------------------------------------------------------- context menus elsewhere
await step('right-click the list background: New Note / View As / Sort By', async () => {
  const c = await page.center(`document.querySelector('.f4-NoteScroller')`);
  const box = await page.center(`document.querySelector('.f4-NoteScroller .f4-GroupLabel')`);
  await page.mouse(box.x, box.y, { button: 'right' });
  await page.waitFor(`menuItems().includes('New Note')`).catch(async (e) => { throw new Error(e.message + ' / ' + await ev(`JSON.stringify([root().menu_at, menuItems(), document.elementFromPoint(${box.x}, ${box.y})?.className])`)); });
  const items = await ev(`menuItems().join(', ')`);
  await page.key('Escape');
  await page.waitFor(`!document.querySelector('.f4-view-ContextMenu')`);
  return items;
});
await step('right-click a note row opens its menu at the pointer', async () => {
  const c = await page.center(`document.querySelectorAll('[role=option]')[1]`);
  await page.mouse(c.x + 30, c.y, { button: 'right' });
  await page.waitFor(`menuItems().includes('Duplicate Note')`);
  const ok = await ev(`(() => { const r = document.querySelector('.f4-view-NoteMenu [role=menu]').getBoundingClientRect(); return Math.abs(r.left - ${c.x + 30}) < 4; })()`);
  await page.key('Escape');
  return ok;
});

// ---------------------------------------------------------------- i18n
await step('switch to Español: everything re-renders in place', async () => {
  const rowBefore = await ev(`document.querySelector('[role=option]')`);
  await page.click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'View options')`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Español')`);
  await page.waitFor(`document.querySelector('[role=heading][aria-level="1"]').textContent === 'Todas las notas'`);
  const sample = await ev(`[document.querySelector('.f4-Count').textContent, [...document.querySelectorAll('.f4-GroupLabel')].map((e) => e.textContent).join('/'), document.querySelector('input[aria-label]').placeholder, document.getElementById('app').lang, document.title].join(' · ')`);
  if (!/notas/.test(sample) || !/Fijadas/.test(sample) || !sample.includes(' es ')) throw new Error(sample);
  return sample;
});
await step('Deutsch, then back to English (choice persists across reload)', async () => {
  await page.click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Darstellungsoptionen' || b.getAttribute('aria-label') === 'Opciones de visualización')`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'Deutsch')`);
  await page.waitFor(`document.querySelector('[role=heading][aria-level="1"]').textContent === 'Alle Notizen'`);
  await page.goto(URL);
  await page.waitFor('document.querySelector("[role=option]")');
  await ev(H);
  const de = await ev(`document.querySelector('[role=heading][aria-level="1"]').textContent`);
  await page.click(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Darstellungsoptionen')`);
  await page.click(`$has('[role=menu] [role^=menuitem]', 'English')`);
  await page.waitFor(`document.querySelector('[role=heading][aria-level="1"]').textContent === 'All Notes'`);
  return de === 'Alle Notizen' ? 'after reload: Alle Notizen' : false;
});

// ---------------------------------------------------------------- accessibility audit
await step('a11y: every button, input and option has an accessible name', async () => {
  const bad = await ev(`[...document.querySelectorAll('button, input, [role=option], [role=menuitem], [role=separator][tabindex]')]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => !(el.getAttribute('aria-label') || (el.tagName !== 'INPUT' && el.textContent.trim())))
    .map((el) => el.outerHTML.slice(0, 80))`);
  if (bad.length) throw new Error(bad.join(' | '));
  const n = await ev(`document.querySelectorAll('button, input, [role=option]').length`);
  return `${n} controls checked`;
});
await step('a11y: landmarks, listbox ownership, clickable rows reachable by keyboard', async () => {
  const r = await ev(`({
    nav: !!document.querySelector('[role=navigation][aria-label]'),
    status: !!document.querySelector('[role=status]'),
    orphans: [...document.querySelectorAll('[role=option]')].filter((o) => !o.closest('[role=listbox]')).length,
    unreachable: [...document.querySelectorAll('[role=button]')].filter((e) => e.tabIndex < 0).length,
    editor: ed().getAttribute('role') + '/' + ed().getAttribute('aria-multiline') + '/' + ed().getAttribute('aria-label'),
  })`);
  if (!r.nav || !r.status || r.orphans || r.unreachable || r.editor !== 'textbox/true/Note text') throw new Error(JSON.stringify(r));
  return JSON.stringify(r);
});

await page.screenshot(`${OUT}/v3-final.png`);
console.log(`\n${pass} passed, ${fail} failed`);
console.log(problems.length ? `console problems:\n  ${problems.join('\n  ')}` : 'no console errors or warnings');
await page.close();
process.exit(fail ? 1 : 0);
