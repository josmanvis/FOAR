// Find / replace in the active editor (Ctrl+F, Ctrl+H), drawn over the editor
// like any code editor: match count, case / word / regex, F3 / Shift+F3,
// matches marked in the text, replace one / all (one undo step each).
import { buildMatcher, findAll, replaceRanges, replacementFor, searchField } from './search.js';

const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
};

export function createFindBar(ws, host) {
  const options = { matchCase: false, wholeWord: false, regex: false };
  let open = false;
  let ranges = [];
  let current = -1;
  let re = null;

  const field = searchField({
    placeholder: 'Find',
    label: 'Find in file',
    options,
    onInput: () => update({ jump: true }),
    onKey: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    },
  });
  const count = h('span', { class: 'fb-count', 'aria-live': 'polite' });
  const btn = (text, title, onclick) => h('button', { class: 'fb-btn', type: 'button', title, 'aria-label': title, text, onclick, onmousedown: (e) => e.preventDefault() });
  const replaceInput = h('input', {
    class: 'sf-input',
    type: 'text',
    placeholder: 'Replace',
    'aria-label': 'Replace with',
    spellcheck: 'false',
    onkeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
        e.preventDefault();
        replaceAll();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        replaceOne();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    },
  });
  const toggle = h('button', { class: 'fb-toggle', type: 'button', 'aria-label': 'Toggle replace', title: 'Toggle replace (Ctrl+H)', 'aria-expanded': 'false', text: '›', onclick: () => setReplace(!replaceRow.classList.contains('open')) });
  const replaceRow = h('div', { class: 'fb-row fb-replace' }, h('div', { class: 'sf' }, replaceInput), btn('⇂', 'Replace (Enter)', () => replaceOne()), btn('⇊', 'Replace all (Ctrl+Alt+Enter)', () => replaceAll()));
  const el = h(
    'div',
    { class: 'findbar', role: 'search', 'aria-label': 'Find in file' },
    toggle,
    h(
      'div',
      { class: 'fb-rows' },
      h('div', { class: 'fb-row' }, field.el, count, btn('↑', 'Previous match (Shift+Enter)', () => step(-1)), btn('↓', 'Next match (Enter)', () => step(1)), btn('✕', 'Close (Escape)', () => close())),
      replaceRow
    )
  );
  host.append(el);

  function setReplace(on) {
    replaceRow.classList.toggle('open', on);
    toggle.setAttribute('aria-expanded', String(on));
    toggle.classList.toggle('open', on);
  }

  const editor = () => ws.activeEditor();

  function update({ jump = false } = {}) {
    const ae = editor();
    re = buildMatcher(field.input.value, options);
    field.el.classList.toggle('invalid', !!re?.error);
    ranges = ae && re && !re.error ? findAll(re, ae.ta.value) : [];
    if (!ae) return;
    if (!ranges.length) current = -1;
    else if (jump || current < 0 || current >= ranges.length) {
      // first match at or after the caret
      const from = ae.ta.selectionStart;
      current = ranges.findIndex(([a]) => a >= from);
      if (current < 0) current = 0;
    }
    paint(jump);
  }

  let markedEd = null;
  function paint(reveal) {
    const ae = editor();
    if (!ae) return;
    if (markedEd && markedEd !== ae.ed) markedEd.setMarks([]);
    markedEd = ae.ed;
    ae.ed.setMarks(open ? ranges : [], current);
    count.textContent = re?.error ? 'Invalid' : !field.input.value ? '' : ranges.length ? `${current + 1} of ${ranges.length}${ranges.length >= 20000 ? '+' : ''}` : 'No results';
    count.classList.toggle('none', !!field.input.value && !ranges.length);
    if (reveal && current >= 0) ae.ed.select(ranges[current][0], ranges[current][1], { focus: false });
  }

  function step(dir) {
    if (!open) return show();
    if (!ranges.length) return;
    current = (current + dir + ranges.length) % ranges.length;
    paint(true);
  }

  function replaceOne() {
    const ae = editor();
    if (!ae || current < 0 || !ranges.length) return;
    const [a, b] = ranges[current];
    const text = ae.ta.value;
    const next = text.slice(0, a) + replacementFor(re, text.slice(a, b), replaceInput.value, options.regex) + text.slice(b);
    keepFocus(() => ws.applyEdit(ae.path, next));
    // stay on the same index: it is now the next match
    update();
    paint(true);
  }

  function replaceAll() {
    const ae = editor();
    if (!ae || !ranges.length) return;
    const n = ranges.length;
    keepFocus(() => ws.applyEdit(ae.path, replaceRanges(ae.ta.value, ranges, re, replaceInput.value, options.regex)));
    update();
    count.textContent = `Replaced ${n}`;
  }

  function keepFocus(fn) {
    const f = document.activeElement;
    fn();
    f?.focus?.();
  }

  function show({ replace = false } = {}) {
    const ae = editor();
    if (!ae) return;
    const sel = ae.ta.value.slice(ae.ta.selectionStart, ae.ta.selectionEnd);
    if (sel && !sel.includes('\n')) field.input.value = sel;
    open = true;
    el.classList.add('open');
    setReplace(replace || replaceRow.classList.contains('open'));
    update({ jump: false });
    (replace ? replaceInput : field.input).focus();
    field.input.select();
  }

  function close() {
    if (!open) return;
    open = false;
    el.classList.remove('open');
    markedEd?.setMarks([]);
    const ae = editor();
    if (ae) ae.ta.focus({ preventScroll: true });
  }

  ws.events.addEventListener('active', () => open && update({ jump: false }));
  ws.events.addEventListener('change', () => open && update());

  return {
    show,
    close,
    next: () => step(1),
    prev: () => step(-1),
    get isOpen() {
      return open;
    },
  };
}
