// Language features in the playground editor: suggestions (as you type and
// Ctrl+Space) with docs, snippet tab stops, signature help, hover, squiggles,
// a Problems list, bracket matching, auto-closing pairs, rename (F2), go to
// definition (F12, Ctrl+click), references (Shift+F12), format (Shift+Alt+F).
import { createLanguageService, formatFoar } from './service.js';
import { fuzzy } from '../workbench/palette.js';
import { formatFoarSource } from '../../foar-compiler.js';

const KIND_ICON = {
  keyword: ['⌘', 'k-keyword'], element: ['◻', 'k-element'], view: ['◇', 'k-view'], property: ['¶', 'k-prop'], value: ['=', 'k-value'],
  state: ['●', 'k-state'], effect: ['ƒ', 'k-effect'], event: ['⚡', 'k-event'], style: ['✦', 'k-style'], variable: ['𝑥', 'k-var'],
  type: ['T', 'k-type'], snippet: ['{}', 'k-snippet'], file: ['▤', 'k-file'], cssvar: ['--', 'k-cssvar'], arg: ['∶', 'k-arg'], function: ['ƒ', 'k-fn'],
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"' };
const CLOSERS = new Set([')', ']', '}', '"']);

/** "${1:name}" / "$1" / "$0" snippet -> { text, stops: [{ n, s, e }] } */
function expandSnippet(snippet) {
  let text = '';
  const stops = [];
  const re = /\$\{(\d+):([^}]*)\}|\$(\d+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(snippet))) {
    text += snippet.slice(last, m.index);
    const n = Number(m[1] ?? m[3]);
    const def = m[2] ?? '';
    stops.push({ n, s: text.length, e: text.length + def.length });
    text += def;
    last = m.index + m[0].length;
  }
  text += snippet.slice(last);
  // no $0: Tab after the last stop leaves the snippet at its end
  if (stops.length && !stops.some((x) => x.n === 0)) stops.push({ n: 0, s: text.length, e: text.length });
  stops.sort((a, b) => (a.n === 0) - (b.n === 0) || a.n - b.n);
  return { text, stops };
}

export function createLanguageFeatures({ ws, palette, notify }) {
  const ls = createLanguageService();
  const events = new EventTarget(); // 'problems' { errors, warnings }
  const host = ws.editorColEl.querySelector('.editor-host');
  let diagnostics = new Map();
  let stale = true;
  const sync = () => {
    if (!stale) return;
    ls.update(ws.project().files);
    stale = false;
  };
  ws.events.addEventListener('change', () => {
    stale = true;
    scheduleDiagnostics();
  });
  ws.setDefinitionProvider((path, offset) => {
    sync();
    const d = ls.definition(path, offset);
    return d && { ...d, length: 0 };
  });

  // ---- popups -----------------------------------------------------------------------------
  const suggestEl = document.createElement('div');
  suggestEl.className = 'lang-suggest hidden';
  suggestEl.innerHTML = '<div class="ls-list" role="listbox" id="ls-list" aria-label="Suggestions"></div><div class="ls-doc" aria-live="polite"></div>';
  const listEl = suggestEl.querySelector('.ls-list');
  const docEl = suggestEl.querySelector('.ls-doc');
  const sigEl = document.createElement('div');
  sigEl.className = 'lang-sig hidden';
  sigEl.setAttribute('role', 'tooltip');
  const hoverEl = document.createElement('div');
  hoverEl.className = 'lang-hover hidden';
  hoverEl.setAttribute('role', 'tooltip');
  document.body.append(suggestEl, sigEl, hoverEl);
  suggestEl.addEventListener('mousedown', (e) => e.preventDefault());

  const active = () => ws.activeEditor();
  // edits we make ourselves (accepting, auto-closing) must not count as typing
  let selfEdit = false;
  const edit = (ae, ...args) => {
    selfEdit = true;
    try {
      ae.ed.replace(...args);
    } finally {
      selfEdit = false;
    }
  };
  const place = (el, x, yBelow, yAbove, preferAbove = false) => {
    el.style.left = '0px';
    el.style.top = '0px';
    el.classList.remove('hidden');
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, innerWidth - r.width - 8));
    const fitsBelow = yBelow + r.height + 8 < innerHeight;
    const top = (preferAbove ? yAbove - r.height - 4 >= 8 : !fitsBelow) ? yAbove - r.height - 4 : yBelow + 2;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
  };

  // ---- suggestions ----------------------------------------------------------------------------
  let sug = null; // { path, from, items, shown, index, explicit }

  function openSuggest({ explicit = false } = {}) {
    const ae = active();
    if (!ae) return;
    sync();
    const off = ae.ta.selectionStart;
    if (ae.ta.selectionEnd !== off) return;
    const res = ls.complete(ae.path, off);
    if (!res || !res.items.length) {
      closeSuggest();
      if (explicit) notify?.('No suggestions');
      return;
    }
    sug = { path: ae.path, from: res.from, items: res.items, index: 0, explicit };
    filterSuggest();
  }

  /** What's been typed since the suggestion list opened. */
  function suggestPrefix() {
    const ae = active();
    return sug && ae ? ae.ta.value.slice(sug.from, ae.ta.selectionStart) : '';
  }

  function filterSuggest() {
    const ae = active();
    if (!sug || !ae || ae.path !== sug.path) return closeSuggest();
    const off = ae.ta.selectionStart;
    if (off < sug.from) return closeSuggest();
    const prefix = ae.ta.value.slice(sug.from, off);
    if (/\s/.test(prefix) && !sug.items.some((i) => i.label.includes(' '))) return closeSuggest();
    const ranked = [];
    for (const it of sug.items) {
      const f = fuzzy(prefix, it.filter ?? it.label);
      if (!f) continue;
      ranked.push({ it, hits: (it.filter ? [] : f.hits), score: f.score - (it.sort ? Number(it.sort) * 0.5 : 0) });
    }
    if (!prefix) ranked.sort((a, b) => (a.it.sort ?? '5').localeCompare(b.it.sort ?? '5'));
    else ranked.sort((a, b) => b.score - a.score);
    // an exact match only (already typed in full) is noise unless asked for
    if (!ranked.length || (!sug.explicit && ranked.length === 1 && ranked[0].it.label === prefix && !ranked[0].it.retrigger)) return closeSuggest();
    sug.shown = ranked.slice(0, 80);
    sug.index = Math.min(sug.index, sug.shown.length - 1);
    renderSuggest();
    const c = ae.ed.coords(sug.from);
    place(suggestEl, c.left - 22, c.bottom, c.top);
    ae.ta.setAttribute('aria-expanded', 'true');
    ae.ta.setAttribute('aria-controls', 'ls-list');
    ae.ta.setAttribute('aria-autocomplete', 'list');
  }

  function renderSuggest() {
    listEl.textContent = '';
    sug.shown.forEach(({ it, hits }, i) => {
      const [icon, cls] = KIND_ICON[it.kind] ?? ['·', ''];
      const row = document.createElement('div');
      row.className = `ls-item${i === sug.index ? ' active' : ''}`;
      row.id = `ls-opt-${i}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === sug.index));
      const set = new Set(hits);
      const label = [...it.label].map((ch, k) => (set.has(k) ? `<b>${esc(ch)}</b>` : esc(ch))).join('');
      row.innerHTML = `<span class="ls-icon ${cls}" aria-hidden="true">${icon}</span><span class="ls-label">${label}</span><span class="ls-detail">${esc(it.detail ?? '')}</span>`;
      row.addEventListener('click', () => {
        sug.index = i;
        accept();
      });
      listEl.append(row);
    });
    highlightSuggest();
  }

  function highlightSuggest() {
    [...listEl.children].forEach((r, i) => {
      r.classList.toggle('active', i === sug.index);
      r.setAttribute('aria-selected', String(i === sug.index));
    });
    listEl.children[sug.index]?.scrollIntoView({ block: 'nearest' });
    const it = sug.shown[sug.index]?.it;
    docEl.innerHTML = it && (it.doc || it.detail) ? `${it.detail ? `<div class="ls-sig">${esc(it.detail)}</div>` : ''}${it.doc ? `<div>${md(it.doc)}</div>` : ''}` : '';
    docEl.classList.toggle('hidden', !docEl.innerHTML);
    active()?.ta.setAttribute('aria-activedescendant', `ls-opt-${sug.index}`);
  }

  function closeSuggest() {
    sug = null;
    suggestEl.classList.add('hidden');
    const ta = active()?.ta;
    ta?.setAttribute('aria-expanded', 'false');
    ta?.removeAttribute('aria-activedescendant');
  }

  function accept() {
    const ae = active();
    if (!sug || !ae) return;
    const { it } = sug.shown[sug.index];
    const off = ae.ta.selectionStart;
    // replace the typed prefix and the rest of the word after the caret
    let to = off;
    while (to < ae.ta.value.length && /[\w$-]/.test(ae.ta.value[to]) && it.kind !== 'value') to++;
    const lineStart = ae.ta.value.lastIndexOf('\n', sug.from - 1) + 1;
    const indent = /^[ \t]*/.exec(ae.ta.value.slice(lineStart))[0];
    const { text, stops } = expandSnippet((it.insert ?? it.label).replace(/\n/g, `\n${indent}`));
    const from = sug.from;
    closeSuggest();
    insertSnippet(ae, from, to, text, stops);
    if (it.retrigger) setTimeout(() => openSuggest(), 0);
  }

  // ---- snippet tab stops ----
  let session = null; // { path, stops: [{ n, s, e }], i, len }
  function insertSnippet(ae, from, to, text, stops) {
    const first = stops[0];
    edit(ae, from, to, text, from + (first ? first.s : text.length), from + (first ? first.e : text.length));
    if (stops.length > 1 || (stops.length === 1 && stops[0].n !== 0)) {
      session = { path: ae.path, stops: stops.map((x) => ({ ...x, s: x.s + from, e: x.e + from })), i: 0, len: ae.ta.value.length };
    } else session = null;
    showSignature();
  }
  function nextStop(dir) {
    const ae = active();
    if (!session || !ae || ae.path !== session.path) return false;
    const i = session.i + dir;
    if (i < 0 || i >= session.stops.length) return false;
    session.i = i;
    const st = session.stops[i];
    ae.ta.setSelectionRange(st.s, st.e);
    if (i === session.stops.length - 1 && st.n === 0) session = null;
    return true;
  }
  // keep stop positions in step with typing inside the current stop
  host.addEventListener('input', () => {
    const ae = active();
    if (!session || !ae || ae.path !== session.path) return;
    const delta = ae.ta.value.length - session.len;
    session.len = ae.ta.value.length;
    const cur = session.stops[session.i];
    const caret = ae.ta.selectionStart;
    if (caret < cur.s || caret > cur.e + Math.max(0, delta)) {
      session = null;
      return;
    }
    cur.e += delta;
    for (const st of session.stops.slice(session.i + 1)) {
      if (st.s >= cur.s) {
        st.s += delta;
        st.e += delta;
      }
    }
  });

  // ---- signature help ----
  function showSignature() {
    const ae = active();
    if (!ae || document.activeElement !== ae.ta) return hide(sigEl);
    sync();
    const sig = ls.signature(ae.path, ae.ta.selectionStart);
    if (!sig) return hide(sigEl);
    sigEl.innerHTML = `<code>${esc(sig.label)}(${sig.params.map((p, i) => (i === sig.active ? `<b>${esc(p)}</b>` : esc(p))).join(', ')})</code>${sig.doc ? `<div class="lh-doc">${md(sig.doc)}</div>` : ''}`;
    const c = ae.ed.coords(ae.ta.selectionStart);
    place(sigEl, c.left - 10, c.bottom, c.top, true);
  }
  const hide = (el) => el.classList.add('hidden');

  // ---- hover ----
  let hoverTimer = 0;
  let hoverKey = '';
  host.addEventListener('mousemove', (e) => {
    if (!e.target.classList?.contains('code-input')) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHover(e.clientX, e.clientY), 350);
  });
  host.addEventListener('mouseleave', () => {
    clearTimeout(hoverTimer);
    hide(hoverEl);
    hoverKey = '';
  });
  hoverEl.addEventListener('mouseleave', () => hide(hoverEl));
  function showHover(x, y) {
    const ae = active();
    if (!ae || sug) return;
    const off = ae.ed.offsetAt(x, y);
    if (off < 0) {
      hoverKey = '';
      return hide(hoverEl);
    }
    sync();
    const probs = (diagnostics.get(ae.path) ?? []).filter((d) => d.s <= off && off <= Math.max(d.e, d.s + 1));
    const h = ls.hover(ae.path, off);
    if (!h && !probs.length) {
      hoverKey = '';
      return hide(hoverEl);
    }
    const key = `${ae.path}:${h?.s}:${probs.length}`;
    if (key === hoverKey && !hoverEl.classList.contains('hidden')) return;
    hoverKey = key;
    hoverEl.innerHTML =
      probs.map((p) => `<div class="lh-problem ${p.severity}">${p.severity === 'error' ? '⊗' : '⚠'} ${esc(p.message)}</div>`).join('') +
      (h ? `<pre class="lh-code">${esc(h.code)}</pre>${h.doc ? `<div class="lh-doc">${md(h.doc)}</div>` : ''}` : '');
    const c = ae.ed.coords(h ? h.s : off);
    place(hoverEl, c.left, c.bottom, c.top, true);
  }

  // ---- diagnostics ----
  let diagTimer = 0;
  const problemsList = document.getElementById('problems-list');
  const problemsCount = document.getElementById('problems-count');
  function scheduleDiagnostics() {
    clearTimeout(diagTimer);
    diagTimer = setTimeout(runDiagnostics, 250);
  }
  function runDiagnostics() {
    sync();
    diagnostics = ls.diagnostics();
    paintDiagnostics();
  }
  function allProblems() {
    const out = [];
    const err = ws.error;
    const files = ws.project().files;
    let compilerAt = null;
    if (err?.file && files[err.file] != null) {
      const src = files[err.file];
      const ls0 = src.split('\n').slice(0, err.line - 1).join('\n').length + (err.line > 1 ? 1 : 0);
      const s0 = ls0 + err.col - 1;
      // the compiler points at a character: underline (and select) the whole word there
      let e0 = s0 + 1;
      while (e0 < src.length && /[\w$]/.test(src[e0]) && /[\w$]/.test(src[s0])) e0++;
      out.push({ path: err.file, s: s0, e: e0, severity: 'error', message: err.message, source: 'compiler' });
      compilerAt = `${err.file}:${s0}`;
    }
    for (const [path, list] of diagnostics) {
      for (const d of list) {
        // the compiler already reports this spot: don't list it twice
        if (`${path}:${d.s}` === compilerAt) continue;
        out.push({ path, ...d });
      }
    }
    const text = (p) => files[p] ?? '';
    for (const p of out) p.line = text(p.path).slice(0, p.s).split('\n').length;
    return out.sort((a, b) => a.path.localeCompare(b.path) || a.s - b.s);
  }
  function paintDiagnostics() {
    const probs = allProblems();
    for (const path of ws.openPaths) ws.editorFor(path)?.setDiagnostics(probs.filter((p) => p.path === path));
    const errors = probs.filter((p) => p.severity === 'error').length;
    const warnings = probs.length - errors;
    if (problemsCount) problemsCount.textContent = probs.length ? String(probs.length) : '';
    if (problemsList) {
      problemsList.textContent = '';
      if (!probs.length) problemsList.innerHTML = '<div class="pr-empty">No problems in the project. ✓</div>';
      for (const p of probs) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = `pr-item ${p.severity}`;
        row.innerHTML = `<span class="pr-icon">${p.severity === 'error' ? '⊗' : '⚠'}</span><span class="pr-msg">${esc(p.message)}</span><span class="pr-loc">${esc(p.path)}:${p.line}</span>`;
        row.addEventListener('click', () => ws.openFile(p.path, { select: [p.s, p.e] }));
        problemsList.append(row);
      }
    }
    events.dispatchEvent(new CustomEvent('problems', { detail: { errors, warnings } }));
  }
  ws.events.addEventListener('compile', () => paintDiagnostics());
  ws.events.addEventListener('active', () => {
    closeSuggest();
    hide(sigEl);
    paintDiagnostics();
  });

  // ---- bracket matching ----
  function paintBrackets() {
    const ae = active();
    if (!ae) return;
    sync();
    const f = ls.index?.files.get(ae.path);
    if (!f || f.text !== ae.ta.value) return ae.ed.setBrackets([]);
    const off = ae.ta.selectionStart;
    const i = f.toks.findIndex((t) => t.k === 'p' && '(){}[]'.includes(t.v) && (t.s === off || t.s === off - 1));
    if (i < 0 || f.match[i] < 0) return ae.ed.setBrackets([]);
    ae.ed.setBrackets([f.toks[i].s, f.toks[f.match[i]].s]);
  }

  // ---- keys (capture: before the editor's own handlers) ----
  host.addEventListener(
    'keydown',
    (e) => {
      const ae = active();
      if (!ae || e.target !== ae.ta) return;
      const ta = ae.ta;
      const stop = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (sug) {
        if (e.key === 'ArrowDown') return stop(), (sug.chosen = true), (sug.index = (sug.index + 1) % sug.shown.length), highlightSuggest();
        if (e.key === 'ArrowUp') return stop(), (sug.chosen = true), (sug.index = (sug.index - 1 + sug.shown.length) % sug.shown.length), highlightSuggest();
        if (e.key === 'PageDown') return stop(), (sug.chosen = true), (sug.index = Math.min(sug.shown.length - 1, sug.index + 8)), highlightSuggest();
        if (e.key === 'PageUp') return stop(), (sug.chosen = true), (sug.index = Math.max(0, sug.index - 8)), highlightSuggest();
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) return stop(), accept();
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          // Enter takes a suggestion only when you were after one: you typed part
          // of a word, moved through the list, or pressed Ctrl+Space. A list that
          // popped up by itself (after `,` or `:`) must not eat the newline.
          if (sug.explicit || sug.chosen || suggestPrefix().length > 0) return stop(), accept();
          closeSuggest();
        }
        if (e.key === 'Escape') return stop(), closeSuggest();
      }
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') return stop(), openSuggest({ explicit: true });
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') return stop(), showSignature();
      if (e.key === 'Escape' && (!sigEl.classList.contains('hidden') || session)) {
        hide(sigEl);
        session = null;
        return;
      }
      if (e.key === 'Tab' && session && !e.ctrlKey && !e.altKey) {
        if (nextStop(e.shiftKey ? -1 : 1)) return stop();
        session = null;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = ta.selectionStart;
      const en = ta.selectionEnd;
      const v = ta.value;
      const next = v[en] ?? '';
      // typing a closer that is already there: step over it
      if (CLOSERS.has(e.key) && s === en && next === e.key) {
        const inString = e.key === '"' && (v.slice(v.lastIndexOf('\n', s - 1) + 1, s).match(/"/g) || []).length % 2 === 1;
        if (e.key !== '"' || inString) {
          stop();
          ta.setSelectionRange(s + 1, s + 1);
          showSignature();
          return;
        }
      }
      // auto-close pairs (and wrap a selection)
      if (PAIRS[e.key]) {
        const prev = v[s - 1] ?? '';
        if (s !== en) {
          stop();
          edit(ae, s, en, e.key + v.slice(s, en) + PAIRS[e.key], s + 1, en + 1);
          return;
        }
        const lineBefore = v.slice(v.lastIndexOf('\n', s - 1) + 1, s);
        const inString = (lineBefore.match(/"/g) || []).length % 2 === 1;
        const inComment = /\/\//.test(lineBefore.replace(/"(?:[^"\\]|\\.)*"/g, ''));
        const okNext = !next || /[\s)\]};,.]/.test(next);
        const okQuote = e.key !== '"' || (!/[\w"]/.test(prev) && !inString);
        if (okNext && okQuote && !inComment && (e.key === '"' || !inString)) {
          stop();
          // an opening quote starts a string: no member/keyword suggestions in there
          if (e.key === '"' && sug) closeSuggest();
          edit(ae, s, en, e.key + PAIRS[e.key], s + 1);
          if (e.key === '(') setTimeout(showSignature, 0);
          if (e.key === '"' && /import\s+$/.test(lineBefore)) setTimeout(() => openSuggest(), 0);
          return;
        }
      }
      // backspace inside an empty pair deletes both
      if (e.key === 'Backspace' && s === en && s > 0 && PAIRS[v[s - 1]] === next && next) {
        stop();
        edit(ae, s - 1, s + 1, '', s - 1);
      }
    },
    true
  );

  // suggest as you type
  host.addEventListener('input', (e) => {
    const ae = active();
    if (!ae || e.target !== ae.ta) return;
    stale = true;
    if (selfEdit) return;
    if (sug) {
      filterSuggest();
      if (sug) return;
    }
    if (e.inputType === 'insertText' && e.data) {
      const ch = e.data.slice(-1);
      const before = ae.ta.value.slice(Math.max(0, ae.ta.selectionStart - 12), ae.ta.selectionStart);
      const lineBefore = ae.ta.value.slice(ae.ta.value.lastIndexOf('\n', ae.ta.selectionStart - 1) + 1, ae.ta.selectionStart);
      const inString = (lineBefore.replace(/\\./g, '').match(/"/g) || []).length % 2 === 1;
      if (inString && !/(?:^\s*import\s+|\bt\()"[^"]*$/.test(lineBefore)) {
        if (sug) closeSuggest();
      } else if (/[\w@.]/.test(ch) || (ch === '-' && /--$|->$/.test(before)) || (ch === '>' && /->$/.test(before)) || (ch === ' ' && /(?:->|transition|@use|@state|:)\s$/.test(before)) || (ch === '(' && /(?:style|on_\w+)\($/.test(before)) || ch === ',' || ch === ':') {
        openSuggest();
      }
    }
    if (e.inputType === 'deleteContentBackward' && sug) filterSuggest();
  });
  host.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && !sug) {
      showSignature();
    }
    paintBrackets();
    if (/^[(),]$/.test(e.key) || e.key === 'Backspace') showSignature();
  });
  host.addEventListener('mouseup', () => {
    closeSuggest();
    paintBrackets();
    showSignature();
  });
  host.addEventListener('focusout', (e) => {
    if (suggestEl.contains(e.relatedTarget)) return;
    closeSuggest();
    hide(sigEl);
  });
  // scrolling (including the scroll typing causes) moves the popups with the caret
  let scrollRaf = 0;
  host.addEventListener('scroll', () => {
    hide(hoverEl);
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      const ae = active();
      if (!ae) return;
      const r = ae.ta.getBoundingClientRect();
      const c = ae.ed.coords(ae.ta.selectionStart);
      // only vertical: popups are clamped to the window horizontally anyway
      const visible = c.top >= r.top - 2 && c.bottom <= r.bottom + 2;
      if (!visible) {
        closeSuggest();
        hide(sigEl);
        return;
      }
      if (sug) filterSuggest();
      if (!sigEl.classList.contains('hidden')) showSignature();
    });
  }, true);

  // ---- rename (F2), references, definition, format ----
  let renameBox = null;
  function startRename() {
    const ae = active();
    if (!ae) return;
    sync();
    const sym = ls.symbolAt(ae.path, ae.ta.selectionStart);
    if (!sym) return notify?.('Nothing to rename here: put the caret on a view, state, effect, store, parameter, style, data type or CSS variable');
    renameBox?.remove();
    const input = document.createElement('input');
    input.className = 'lang-rename';
    input.value = sym.name;
    input.setAttribute('aria-label', `Rename ${sym.kind} ${sym.name}`);
    const c = ae.ed.coords(sym.s);
    document.body.append(input);
    input.style.left = `${c.left - 4}px`;
    input.style.top = `${c.top - 2}px`;
    input.focus();
    input.select();
    renameBox = input;
    const done = () => {
      if (renameBox !== input) return;
      renameBox = null;
      input.remove();
      ae.ta.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const name = input.value.trim();
        if (!name || name === sym.name) return done();
        sync();
        const res = ls.rename(ae.path, ae.ta.selectionStart, name);
        if (res.error) {
          input.classList.add('invalid');
          input.title = res.error;
          notify?.(res.error);
          return;
        }
        const caret = ae.ta.selectionStart;
        for (const [p, text] of Object.entries(res.edits)) ws.applyEdit(p, text);
        done();
        ae.ta.setSelectionRange(caret, caret);
        notify?.(`Renamed ${sym.kind} ${sym.name} → ${name}: ${res.count} place${res.count === 1 ? '' : 's'} in ${Object.keys(res.edits).length} file${Object.keys(res.edits).length === 1 ? '' : 's'}`);
      }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => renameBox === input && done());
  }

  function goToDefinition() {
    const ae = active();
    if (!ae) return;
    sync();
    const d = ls.definition(ae.path, ae.ta.selectionStart);
    if (!d) return notify?.('No definition found');
    const f = ls.index.files.get(d.path);
    const m = /^[\w$-]*/.exec(f.text.slice(d.offset));
    ws.openFile(d.path, { select: [d.offset, d.offset + (m ? m[0].length : 0)] });
  }

  function findReferences() {
    const ae = active();
    if (!ae) return;
    sync();
    const r = ls.references(ae.path, ae.ta.selectionStart);
    if (!r) return notify?.('No symbol here');
    palette.pick({
      placeholder: `${r.refs.length} reference${r.refs.length === 1 ? '' : 's'} to ${r.sym.kind} ${r.sym.name}`,
      items: r.refs.map((x) => ({ label: `${x.path}:${x.line}  ${x.text}`, run: () => ws.openFile(x.path, { select: [x.s, x.e] }) })),
    });
  }

  async function formatDocument() {
    const ae = active();
    if (!ae) return;
    const before = ae.ta.value;
    // the compiler's formatter (identical to `foar fmt`); the JS port only as a fallback
    const after = (await formatFoarSource(before).catch(() => null)) ?? formatFoar(before);
    if (ae.ta.value !== before) return; // edited while formatting
    if (after === before) return notify?.('Already formatted');
    const line = before.slice(0, ae.ta.selectionStart).split('\n').length;
    ws.applyEdit(ae.path, after);
    ae.ed.goTo(line, after.split('\n')[line - 1]?.search(/\S|$/) + 1);
    notify?.('Formatted');
  }

  const inEditor = () => !!active() && document.activeElement === active()?.ta;
  return {
    events,
    commands: [
      ['lang.suggest', 'Editor', 'Trigger Suggest', ['Ctrl+Space'], () => openSuggest({ explicit: true }), inEditor, { displayOnly: true }],
      ['lang.signature', 'Editor', 'Trigger Parameter Hints', ['Ctrl+Shift+Space'], () => showSignature(), inEditor, { displayOnly: true }],
      ['lang.rename', 'Editor', 'Rename Symbol', ['F2'], startRename, inEditor],
      ['lang.definition', 'Editor', 'Go to Definition', ['F12'], goToDefinition, inEditor],
      ['lang.references', 'Editor', 'Find All References', ['Shift+F12'], findReferences, inEditor],
      ['lang.format', 'Editor', 'Format Document', ['Alt+Shift+F'], formatDocument, () => !!active()],
    ],
    problems: allProblems,
    /** Go to the next (dir 1) or previous (-1) problem after the caret. */
    nextProblem(dir = 1) {
      const probs = allProblems();
      if (!probs.length) return notify?.('No problems');
      const ae = active();
      const key = (p) => `${p.path}\u0000${String(p.s).padStart(9, '0')}`;
      const here = ae ? `${ae.path}\u0000${String(ae.ta.selectionStart).padStart(9, '0')}` : '';
      const sorted = probs.sort((a, b) => key(a).localeCompare(key(b)));
      const p = dir > 0 ? sorted.find((x) => key(x) > here) ?? sorted[0] : [...sorted].reverse().find((x) => key(x) < here) ?? sorted[sorted.length - 1];
      ws.openFile(p.path, { select: [p.s, p.e] });
      const c = ws.activeEditor()?.ed.coords(p.s);
      if (c) {
        hoverEl.innerHTML = `<div class="lh-problem ${p.severity}">${p.severity === 'error' ? '⊗' : '⚠'} ${esc(p.message)}</div>`;
        place(hoverEl, c.left, c.bottom, c.top);
      }
    },
    refresh: runDiagnostics,
  };
}
