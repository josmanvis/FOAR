import os from 'node:os';
import path from 'node:path';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
// Language features e2e: suggestions + snippets, parameter hints, hover,
// diagnostics/problems, definition, references, rename, format, pairs, brackets.
import { launch } from './cdp.mjs';
import fs from 'node:fs';
const NOTES = new URL('../../examples/notes-on-foar/', import.meta.url).pathname;
const snapshot = () => Object.fromEntries(fs.readdirSync(NOTES, { recursive: true }).filter((f) => f.endsWith('.foar')).map((f) => [f, fs.readFileSync(`${NOTES}/${f}`, 'utf8')]));
const before = snapshot();
const page = await launch({ profile: `${OUT}/chrome-pg6-${Date.now()}` });
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
const TA = `document.querySelector('.code-view.active .code-input')`;
const val = () => page.eval(`${TA}.value`);
const caretAfter = (needle, delta = needle.length) => page.eval(`(() => { const t = ${TA}; const i = t.value.indexOf(${JSON.stringify(needle)}); if (i < 0) throw new Error('not found: ' + ${JSON.stringify(needle)}); t.focus(); t.setSelectionRange(i + ${delta}, i + ${delta}); const line = t.value.slice(0, i).split('\\n').length; t.scrollTop = Math.max(0, line * 20 - t.clientHeight / 2); t.dispatchEvent(new KeyboardEvent('keyup', { key: 'End', bubbles: true })); })()`);
const sugg = () => J(`(() => { const s = document.querySelector('.lang-suggest'); return s.classList.contains('hidden') ? null : [...s.querySelectorAll('.ls-item')].map(i => i.querySelector('.ls-label').textContent); })()`);
const sel = () => page.eval(`(() => { const t = ${TA}; return t.value.slice(t.selectionStart, t.selectionEnd); })()`);
const openTab = async (p) => {
  await page.eval(`(() => { const r = document.querySelector('[data-path="${p}"]'); if (r) r.click(); })()`);
  await page.sleep(120);
};
const lineAt = () => page.eval(`(() => { const t = ${TA}; const s = t.value.lastIndexOf('\\n', t.selectionStart - 1) + 1; let e = t.value.indexOf('\\n', t.selectionStart); if (e < 0) e = t.value.length; return t.value.slice(s, e); })()`);

try {
  await page.goto(`${BASE}/playground/?example=scratch`);
  await page.waitFor(`document.getElementById('compiler-status').textContent.includes('mounted')`, 15000);
  await page.eval(`localStorage.clear()`);
  await page.goto(`${BASE}/playground/?example=scratch`);
  await page.waitFor(`document.getElementById('compiler-status').textContent.includes('mounted') && document.querySelector('.tab.active')`, 15000);
  await openTab('app.foar');

  await step('typing in render suggests elements and views; Enter inserts a snippet with tab stops', async () => {
    await caretAfter('Greeting(label: "Hello from another file!")');
    await page.key('Enter');
    await page.type('Bu');
    await page.sleep(80);
    const s = await sugg();
    ok(s && s[0] === 'Button', JSON.stringify(s));
    await page.key('Enter');
    await page.sleep(60);
    const placeholder = await sel();
    await page.type('Save');
    await page.key('Tab');
    const second = await sel();
    await page.type('Bump');
    const line = (await lineAt()).trim();
    ok(placeholder === 'Label' && second === 'Effect' && line === 'Button("Save") -> on_click(Bump)', `${placeholder} / ${second} / ${line}`);
    return line;
  });

  await step('the new button compiles and renders', async () => {
    await page.waitFor(`[...document.querySelectorAll('#f4-mount button')].some(b => b.textContent === 'Save')`, 3000);
  });

  await step('a view call shows parameter hints and suggests its named args', async () => {
    await page.key('Tab'); // last tab stop: the end of the snippet
    await page.key('Enter');
    await page.type('Greeting');
    await page.key('Escape');
    await page.key('(', { text: '(' });
    await page.sleep(80);
    const t = await J(`{ line: (() => { const t = ${TA}; const s = t.value.lastIndexOf('\\n', t.selectionStart - 1) + 1; return t.value.slice(s, t.value.indexOf('\\n', s)); })(), sig: document.querySelector('.lang-sig:not(.hidden)')?.textContent }`);
    ok(t.line.trim() === 'Greeting()' && t.sig?.startsWith('Greeting(label: String)'), JSON.stringify(t));
    await page.key(' ', { mods: CTRL, code: 'Space' });
    await page.sleep(60);
    const s = await sugg();
    ok(s?.[0] === 'label:', JSON.stringify(s));
    await page.key('Enter');
    await page.type('"Second"');
    await page.sleep(60);
    const line = (await lineAt()).trim();
    ok(line === 'Greeting(label: "Second")', line);
    return `hint: ${t.sig}`;
  });

  await step('-> suggests events for the element; on_click( suggests effects of this state', async () => {
    await caretAfter('Greeting(label: "Second")');
    await page.type(' ->');
    await page.sleep(60);
    const s1 = await sugg();
    await page.key('Escape');
    await caretAfter('Button("Save") -> on_click(Bump)', 'Button("Save") -> on_'.length);
    await page.key(' ', { mods: CTRL, code: 'Space' });
    await page.sleep(60);
    const s2 = await sugg();
    await page.key('Escape');
    await caretAfter('on_click(Bump', 'on_click('.length);
    await page.key(' ', { mods: CTRL, code: 'Space' });
    const s3 = await sugg();
    await page.key('Escape');
    // remove the dangling " ->"
    await page.eval(`(() => { const t = ${TA}; const i = t.value.indexOf('"Second") ->'); t.focus(); t.setSelectionRange(i + 9, i + 12); document.execCommand('insertText', false, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    ok(!(await val()).includes('"Second") ->'), 'cleanup failed');
    ok(s1 && s1.length === 0 || s1 === null, `Greeting emits nothing: ${JSON.stringify(s1)}`);
    ok(s2?.includes('on_click') && !s2.includes('on_input'), JSON.stringify(s2));
    ok(s3?.[0] === 'Bump', JSON.stringify(s3));
    return `Button events: ${s2.join(', ')}; effects: ${s3.join(', ')}`;
  });

  await step('inside .style({ … }) CSS properties and then values are suggested', async () => {
    await caretAfter('.style({ gap: 12px; padding: 24px; ', '.style({ gap: 12px; padding: 24px; '.length);
    await page.type('disp');
    await page.sleep(60);
    const s1 = await sugg();
    await page.key('Enter');
    await page.sleep(80);
    const s2 = await sugg();
    await page.type('fl');
    await page.sleep(50);
    await page.key('Enter');
    const line = (await lineAt()).trim();
    ok(s1?.[0] === 'display' && s2?.includes('flex') && line.includes('display: flex;'), `${JSON.stringify(s1?.slice(0, 3))} ${JSON.stringify(s2?.slice(0, 4))} ${line}`);
    return line;
  });

  await step('transition suggests the view’s states', async () => {
    await caretAfter('effect Bump() { count += 1; }', 'effect Bump() { count += 1;'.length);
    await page.type(' transition ');
    await page.sleep(60);
    const s = await sugg();
    await page.key('Escape');
    ok(JSON.stringify(s) === '["Ready"]', JSON.stringify(s));
    await page.type('Nope;');
  });

  await step('diagnostics: squiggle, hover message, Problems tab and status bar', async () => {
    await page.waitFor(`[...document.querySelectorAll('.pr-item')].some(i => /state 'Nope'/.test(i.textContent)) `, 3000);
    const t = await J(`{ count: document.getElementById('problems-count').textContent, items: [...document.querySelectorAll('.pr-item')].map(i => i.textContent), status: [...document.querySelectorAll('.sb-item')].map(i => i.textContent).find(t => t.includes('⊗')) }`);
    ok(t.items.some((x) => /no state 'Nope'|Unknown state 'Nope'/.test(x)) && /^⊗ [12]/.test(t.status), JSON.stringify(t));
    // hover over the squiggle
    const c = await J(`(() => { const t = ${TA}; const i = t.value.indexOf('Nope'); const ed = document.querySelector('.code-view.active .code-diag.error').getBoundingClientRect(); return { x: ed.left + 4, y: ed.top - 8 }; })()`);
    await page.mouse(c.x, c.y, { button: 'none' }).catch(() => {});
    await page.eval(`document.querySelector('.code-view.active .code-input').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${c.x}, clientY: ${c.y} }))`);
    await page.sleep(500);
    const hov = await page.eval(`document.querySelector('.lang-hover:not(.hidden)')?.textContent ?? ''`);
    ok(/state 'Nope'/.test(hov), hov);
    // F8 jumps to it
    await caretAfter('import');
    await page.key('F8');
    await page.sleep(100);
    ok((await sel()) === 'Nope', await sel());
    // fix it
    await page.type('Ready');
    await page.waitFor(`!document.querySelector('.code-view.active .code-diag')`, 3000);
    return t.items[0];
  });

  await step('hover shows a view’s signature', async () => {
    const c = await J(`(() => { const t = ${TA}; const i = t.value.indexOf('Greeting(label'); const r = document.querySelector('.code-view.active'); return null; })()`);
    await caretAfter('Greeting(label: "Hello', 3);
    const xy = await J(`(() => { const ta = ${TA}; const r = ta.getBoundingClientRect(); const cw = (() => { const p = document.createElement('span'); p.textContent = 'M'.repeat(100); p.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:13px "JetBrains Mono", "Fira Code", "SFMono-Regular", Consolas, monospace'; document.querySelector('.code-view.active .code-hl').append(p); const w = p.getBoundingClientRect().width / 100; p.remove(); return w; })(); const v = ta.value; const i = v.indexOf('Greeting(label: "Hello') + 3; const ls = v.lastIndexOf('\\n', i - 1) + 1; const line = v.slice(0, ls).split('\\n').length - 1; return { x: r.left + 16 + (i - ls) * cw - ta.scrollLeft, y: r.top + 14 + line * 20 + 10 - ta.scrollTop }; })()`);
    await page.eval(`${TA}.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${xy.x}, clientY: ${xy.y} }))`);
    await page.sleep(500);
    const hov = await page.eval(`document.querySelector('.lang-hover:not(.hidden)')?.textContent ?? ''`);
    ok(hov.includes('view Greeting(label: String)') && hov.includes('components/Greeting.foar'), hov);
    return hov.split('States')[0];
  });

  await step('F12 goes to the definition in another file', async () => {
    await caretAfter('Greeting(label: "Hello', 3);
    await page.key('F12');
    await page.sleep(120);
    const t = await J(`{ tab: document.querySelector('.tab.active').dataset.path, sel: (() => { const t = ${TA}; return t.value.slice(t.selectionStart, t.selectionEnd); })() }`);
    ok(t.tab === 'components/Greeting.foar' && t.sel === 'Greeting', JSON.stringify(t));
  });

  await step('Shift+F12 lists references across files', async () => {
    await page.key('F12', { mods: SHIFT });
    await page.sleep(120);
    const items = await J(`[...document.querySelectorAll('.pal-item')].map(i => i.textContent)`);
    const ph = await page.eval(`document.querySelector('.pal-input').placeholder`);
    await page.key('Escape');
    ok(items.length >= 3 && items.some((x) => x.startsWith('app.foar')) && items.some((x) => x.startsWith('components/Greeting.foar')), JSON.stringify(items));
    return ph;
  });

  await step('F2 renames a view in every file (one undo per file)', async () => {
    await caretAfter('view Greeting', 'view Gr'.length);
    await page.key('F2');
    await page.waitFor(`document.querySelector('.lang-rename')`, 1000);
    await page.eval(`document.querySelector('.lang-rename').select()`);
    await page.type('Banner');
    await page.key('Enter');
    await page.sleep(500);
    const t = await J(`{ all: [...document.querySelectorAll('.code-input')].map(t => t.value).join('\\n'), toast: document.querySelector('.pg-toast').textContent, status: document.getElementById('compiler-status').textContent, banner: document.getElementById('error-banner').textContent }`);
    ok(!/\bGreeting\(/.test(t.all) && t.all.includes('view Banner') && t.all.includes('Banner(label:') && t.status.includes('mounted'), JSON.stringify({ toast: t.toast, status: t.status, banner: t.banner, all: t.all }));
    return t.toast;
  });

  await step('rename refuses names already in use', async () => {
    await openTab('app.foar');
    await caretAfter('store count', 'store co'.length);
    await page.key('F2');
    await page.waitFor(`document.querySelector('.lang-rename')`, 1000);
    await page.eval(`document.querySelector('.lang-rename').select()`);
    await page.type('Ready');
    await page.key('Enter');
    await page.sleep(100);
    const t = await J(`{ box: !!document.querySelector('.lang-rename.invalid'), toast: document.querySelector('.pg-toast').textContent }`);
    await page.key('Escape');
    ok(t.box && t.toast.includes('already used'), JSON.stringify(t));
    return t.toast;
  });

  await step('auto-closing pairs, typing over closers, backspace removes an empty pair', async () => {
    await caretAfter('effect Bump() {', 'effect Bump() {'.length);
    await page.key('Enter');
    await page.type('let a = ');
    await page.key('[', { text: '[', code: 'BracketLeft' });
    const a = await lineAt();
    await page.key('Backspace');
    const b = await lineAt();
    await page.key('"', { text: '"', code: 'Quote' });
    await page.type('x');
    await page.key('"', { text: '"', code: 'Quote' });
    await page.type(';');
    const c = await lineAt();
    ok(a.trim().startsWith('let a = []') && b.trim().startsWith('let a = ') && !b.includes('[') && c.trim().startsWith('let a = "x";'), JSON.stringify([a.trim(), b.trim(), c.trim()]));
    // take it out again
    await page.eval(`(() => { const t = ${TA}; const k = 'let a = "x";'; const i = t.value.indexOf(k); const ls = t.value.lastIndexOf('\\n', i - 1); t.setSelectionRange(ls, i + k.length); document.execCommand('insertText', false, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  });

  await step('bracket matching marks the pair at the caret', async () => {
    await caretAfter('view App {', 'view App '.length);
    await page.sleep(60);
    const n = await page.eval(`document.querySelectorAll('.code-view.active .code-bracket').length`);
    ok(n === 2, `${n}`);
  });

  await step('Format Document (Shift+Alt+F) re-indents; one Ctrl+Z restores', async () => {
    const original = await val();
    await page.eval(`(() => { const t = ${TA}; t.focus(); t.select(); document.execCommand('insertText', false, t.value.replace(/^ +/gm, '')); })()`);
    await page.key('f', { mods: ALT | SHIFT });
    await page.sleep(120);
    const formatted = await val();
    ok(formatted === original, 'format did not restore the indentation');
    await page.key('z', { mods: CTRL });
    await page.sleep(80);
    ok((await val()) !== original, 'undo did nothing');
    await page.key('z', { mods: CTRL, }); // back to the original
    await page.sleep(80);
    ok((await val()) === original, 'second undo did not restore');
  });

  await step('the suggestion list is accessible (listbox, active descendant)', async () => {
    await caretAfter('state Ready {', 'state Ready {'.length);
    await page.key('Enter');
    await page.key(' ', { mods: CTRL, code: 'Space' });
    await page.sleep(60);
    const t = await J(`{ role: document.querySelector('.ls-list').getAttribute('role'), expanded: ${TA}.getAttribute('aria-expanded'), ad: ${TA}.getAttribute('aria-activedescendant'), opt: document.getElementById(${TA}.getAttribute('aria-activedescendant'))?.getAttribute('aria-selected'), items: [...document.querySelectorAll('.ls-item .ls-label')].map(i => i.textContent), doc: document.querySelector('.ls-doc').textContent }`);
    await page.key('Escape');
    ok(t.role === 'listbox' && t.expanded === 'true' && t.opt === 'true' && t.items.includes('render') && t.items.includes('effect'), JSON.stringify(t));
    await page.key('z', { mods: CTRL });
    return `state body: ${t.items.join(', ')} · doc: ${t.doc.slice(0, 50)}`;
  });

  await page.screenshot(`${OUT}/pg6-scratch.png`);

  // ---- the notes project: no false problems, completions know all 18 views ----
  await page.goto(`${BASE}/playground/?example=notes-on-foar`);
  await page.waitFor(`document.querySelectorAll('.tree-row.file').length > 5 && document.getElementById('compiler-status').textContent.includes('files')`, 15000);
  await page.sleep(600);
  await step('notes app: no problems reported across 21 files', async () => {
    const t = await J(`{ count: document.getElementById('problems-count').textContent, empty: document.querySelector('.pr-empty')?.textContent, status: [...document.querySelectorAll('.sb-item')].map(i => i.textContent).find(t => t.includes('⊗')) }`);
    ok(!t.count && t.empty && t.status.startsWith('⊗ 0  ⚠ 0'), JSON.stringify(t));
    return t.status;
  });
  await step('notes app: suggestions inside NoteRow know the other components and styles', async () => {
    await page.eval(`(() => { for (const d of ['components', 'components/list']) { const r = document.querySelector('[data-dir="' + d + '"][aria-expanded="false"]'); if (r) r.click(); } })()`);
    await page.sleep(100);
    await openTab('components/list/NoteRow.foar');
    await caretAfter('@use Ellipsis', '@use El'.length);
    await page.key(' ', { mods: CTRL, code: 'Space' });
    await page.sleep(80);
    const s = await sugg();
    await page.key('Escape');
    const h = await page.eval(`document.querySelector('.ls-detail')?.textContent ?? ''`);
    ok(s?.[0] === 'Ellipsis', JSON.stringify(s?.slice(0, 5)));
    return s.slice(0, 4).join(', ');
  });
  await step('typing key by key: the caret never jumps; `,` + Enter makes a new line, not a suggestion', async () => {
    await page.eval(`(() => { for (const d of ['components', 'components/sidebar']) { const r = document.querySelector('[data-dir="' + d + '"][aria-expanded="false"]'); if (r) r.click(); } })()`);
    await page.sleep(100);
    await openTab('components/sidebar/FolderRow.foar');
    await caretAfter('danger: true');
    const start = await page.eval(`${TA}.selectionStart`);
    const before = await val();
    // real key events (keydown handlers run), as a person types a fix
    const keys = [',', 'Enter', ...'hint: "Delete (and its notes)"'];
    const jumps = [];
    for (const k of keys) {
      const c0 = await page.eval(`${TA}.selectionStart`);
      await page.key(k, k === 'Enter' ? {} : { text: k });
      const c1 = await page.eval(`${TA}.selectionStart`);
      if (k !== 'Enter' && c1 !== c0 + 1) jumps.push(`${JSON.stringify(k)}: ${c0} → ${c1}`);
    }
    const after = await val();
    const typed = after.slice(start, start + after.length - before.length);
    ok(!jumps.length, `caret jumped: ${jumps.join(', ')}`);
    ok(/^,\n\s+hint: "Delete \(and its notes\)"$/.test(typed), JSON.stringify(typed));
    ok(after.slice(start + typed.length) === before.slice(start), 'text after the caret changed');
    // undo the edit so later steps and the "files untouched" check see the original
    await page.eval(`(() => { const t = ${TA}; t.focus(); t.setSelectionRange(${start}, ${start} + ${JSON.stringify(typed)}.length); document.execCommand('insertText', false, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    return JSON.stringify(typed);
  });
  await page.screenshot(`${OUT}/pg6-notes.png`);
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
