// Command palette and quick open, one box with prefixes:
//   (none)  open a file by fuzzy name           Ctrl+P
//   >       run a command                       Ctrl+Shift+P, F1
//   :       go to line[:column]                 Ctrl+G
//   @       go to a symbol in this file         Ctrl+Shift+O
//   #       go to a symbol in the project
// Plus a keybinding registry: commands declare their keys, one listener runs them.

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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// ---- keys ------------------------------------------------------------------------------
const CODE_KEYS = { Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']', Backquote: '`', Comma: ',', Period: '.', Semicolon: ';', Quote: "'", Minus: '-', Equal: '=' };
/** KeyboardEvent -> "Ctrl+Shift+P" (Cmd counts as Ctrl). */
export function keyString(e) {
  let key;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}
/** "Ctrl+Shift+P" -> "⌘⇧P" on a Mac, as is elsewhere. */
export function showKeys(k) {
  if (!k) return '';
  if (!isMac) return k;
  return k.replace(/Ctrl\+/g, '⌘').replace(/Alt\+/g, '⌥').replace(/Shift\+/g, '⇧');
}

// ---- fuzzy matching ------------------------------------------------------------------------
/** Score `query` as a subsequence of `text` (higher is better), with matched indices; null if no match. */
export function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const hits = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, ti);
    if (at < 0) return null;
    const boundary = at === 0 || '/-_. '.includes(text[at - 1]) || (text[at] !== t[at] && text[at - 1] === t[at - 1]);
    score += 1 + (at === prev + 1 ? 5 : 0) + (boundary ? 8 : 0) - Math.min(3, (at - ti) * 0.05);
    hits.push(at);
    prev = at;
    ti = at + 1;
  }
  // prefer matches in the file name, and shorter paths
  const base = text.lastIndexOf('/') + 1;
  if (hits[0] >= base) score += 10;
  if (t.slice(base).startsWith(q)) score += 15;
  return { score: score - text.length * 0.02, hits };
}
const marked = (text, hits, from = 0) => {
  const set = new Set(hits.map((i) => i - from));
  return [...text].map((c, i) => (set.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
};

// ---- symbols ------------------------------------------------------------------------------------
const SYMBOL_RE = /^[ \t]*(view|state|effect|style|data|theme|store|@keyframes)[ \t]+([A-Za-z_][\w-]*)?/gm;
const KIND_ICON = { view: '◇', state: '●', effect: 'ƒ', style: '¶', data: '▤', theme: '◐', store: '▭', '@keyframes': '∿' };
export function symbolsIn(path, text) {
  const out = [];
  let view = null;
  for (const m of text.matchAll(SYMBOL_RE)) {
    const kind = m[1];
    const name = m[2] ?? (kind === 'theme' ? 'theme' : '');
    if (!name) continue;
    if (kind === 'view') view = name;
    const line = text.slice(0, m.index).split('\n').length;
    const col = m[0].length - name.length + 1;
    out.push({ kind, name, path, line, col, container: kind === 'view' || kind === 'style' || kind === 'data' ? '' : view ?? '' });
  }
  return out;
}

// ---- the palette ---------------------------------------------------------------------------------
export function createPalette(ws) {
  const commands = new Map();
  const recent = []; // recently active files, most recent first
  const recentCommands = [];
  let mode = 'files';
  let items = [];
  let index = 0;
  let restoreFocus = null;
  let pickHandler = null; // custom pick lists (e.g. "Open project…")

  ws.events.addEventListener('active', (e) => {
    if (!e.detail) return;
    const i = recent.indexOf(e.detail);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(e.detail);
  });

  const input = h('input', {
    class: 'pal-input',
    type: 'text',
    role: 'combobox',
    'aria-expanded': 'true',
    'aria-controls': 'pal-list',
    'aria-autocomplete': 'list',
    'aria-label': 'Search files, commands (>), lines (:), symbols (@, #)',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const list = h('div', { class: 'pal-list', id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  const hint = h('div', { class: 'pal-hint' });
  const box = h('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, hint, list);
  const scrim = h('div', { class: 'pal-scrim hidden' }, box);
  document.body.append(scrim);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });

  function open(prefix = '', { placeholder } = {}) {
    // the same shortcut again closes; another one switches mode
    if (!scrim.classList.contains('hidden') && input.value === prefix && !pickHandler) return close();
    if (scrim.classList.contains('hidden')) restoreFocus = document.activeElement;
    pickHandler = null;
    scrim.classList.remove('hidden');
    input.value = prefix;
    input.placeholder = placeholder ?? 'Search files by name (type > for commands, : for a line, @ or # for symbols)';
    update();
    input.focus();
    input.setSelectionRange(prefix.length, prefix.length);
  }

  /** A one-off list: pick({ placeholder, items: [{ label, description, detail, run }] }). */
  function pick({ placeholder, items: list }) {
    open('');
    input.placeholder = placeholder;
    pickHandler = list;
    update();
  }

  function close({ refocus = true } = {}) {
    if (scrim.classList.contains('hidden')) return;
    scrim.classList.add('hidden');
    pickHandler = null;
    if (refocus && restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
  }

  function update() {
    const v = input.value;
    const ae = ws.activeEditor();
    if (pickHandler) {
      mode = 'pick';
      items = rank(pickHandler, v, (it) => it.label).map(({ it, hits }) => ({ ...it, html: marked(it.label, hits) }));
      hint.textContent = '';
    } else if (v.startsWith('>')) {
      mode = 'commands';
      const q = v.slice(1).trim();
      const all = [...commands.values()].filter((c) => !c.hidden && (!c.when || c.when()));
      let ranked = rank(all, q, (c) => `${c.category}: ${c.title}`);
      if (!q) ranked = ranked.sort((a, b) => rankRecent(recentCommands, a.it.id) - rankRecent(recentCommands, b.it.id));
      items = ranked.map(({ it, hits }) => ({
        html: marked(`${it.category}: ${it.title}`, hits),
        keys: showKeys(it.keys?.[0]),
        run: () => runCommand(it.id),
        id: it.id,
      }));
      hint.textContent = items.length ? '' : 'No matching commands';
    } else if (v.startsWith(':')) {
      mode = 'line';
      const [ln, col] = v.replace(/^:+/, '').split(/[:,]/).map((x) => parseInt(x, 10));
      const total = ae ? ae.ta.value.split('\n').length : 0;
      if (!ae) items = [];
      else if (!ln) {
        const cur = ae.ta.value.slice(0, ae.ta.selectionStart).split('\n').length;
        items = [];
        hint.textContent = `Current line: ${cur}. Type a line number between 1 and ${total} to go to (line:column also works).`;
      } else {
        const line = Math.max(1, Math.min(total, ln));
        items = [{ html: `Go to line ${line}${col ? `, column ${col}` : ''}`, desc: ae.path, run: () => ws.openFile(ae.path, { line, col: col || 1 }) }];
        hint.textContent = '';
      }
    } else if (v.startsWith('@') || v.startsWith('#')) {
      mode = 'symbols';
      const project = v.startsWith('#');
      const q = v.slice(1).trim();
      const { files } = ws.project();
      const syms = project
        ? Object.entries(files).flatMap(([p, t]) => symbolsIn(p, t).filter((s) => ['view', 'style', 'data', '@keyframes'].includes(s.kind)))
        : ae
          ? symbolsIn(ae.path, ae.ta.value)
          : [];
      const ranked = q ? rank(syms, q, (s) => s.name) : syms.map((it) => ({ it, hits: [] }));
      items = ranked.slice(0, 300).map(({ it, hits }) => ({
        html: `<span class="pal-kind k-${it.kind.replace('@', '')}" aria-hidden="true">${KIND_ICON[it.kind]}</span>${marked(it.name, hits)}`,
        desc: project ? it.path : `${it.kind}${it.container ? ` · ${it.container}` : ''}`,
        label: it.name,
        run: () => ws.openFile(it.path, { line: it.line, col: it.col }),
      }));
      hint.textContent = items.length ? '' : project ? 'No symbols match' : ae ? 'No symbols in this file' : 'Open a file first';
    } else {
      mode = 'files';
      const q = v.trim();
      const paths = Object.keys(ws.project().files);
      let ranked;
      if (!q) {
        const rec = recent.filter((p) => paths.includes(p));
        ranked = [...rec, ...paths.filter((p) => !rec.includes(p)).sort((a, b) => a.localeCompare(b))].map((it) => ({ it, hits: [] }));
      } else ranked = rank(paths, q, (p) => p);
      items = ranked.slice(0, 200).map(({ it, hits }, i) => {
        const base = it.lastIndexOf('/') + 1;
        return {
          html: `<span class="pal-file" aria-hidden="true">▤</span>${marked(it.slice(base), hits.filter((x) => x >= base), base)}`,
          desc: it.slice(0, Math.max(0, base - 1)),
          tag: !q && recent.includes(it) && i < recent.length ? 'recently opened' : '',
          label: it,
          run: () => ws.openFile(it),
        };
      });
      hint.textContent = items.length ? '' : 'No matching files';
    }
    index = 0;
    render();
  }

  const rankRecent = (arr, id) => {
    const i = arr.indexOf(id);
    return i < 0 ? 1e6 : i;
  };

  function rank(arr, q, text) {
    if (!q) return arr.map((it) => ({ it, hits: [] }));
    const out = [];
    for (const it of arr) {
      const m = fuzzy(q, text(it));
      if (m) out.push({ it, hits: m.hits, score: m.score });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function render() {
    list.textContent = '';
    items.forEach((it, i) => {
      const row = h('div', { class: `pal-item${i === index ? ' active' : ''}`, role: 'option', id: `pal-opt-${i}`, 'aria-selected': String(i === index) });
      row.innerHTML = `<span class="pal-label">${it.html}</span>${it.desc ? `<span class="pal-desc">${esc(it.desc)}</span>` : ''}${it.tag ? `<span class="pal-tag">${esc(it.tag)}</span>` : ''}${it.keys ? `<kbd>${esc(it.keys)}</kbd>` : ''}`;
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => accept(i));
      row.addEventListener('mousemove', () => {
        if (index !== i) {
          index = i;
          highlight();
        }
      });
      list.append(row);
    });
    highlight();
  }

  function highlight() {
    [...list.children].forEach((r, i) => {
      r.classList.toggle('active', i === index);
      r.setAttribute('aria-selected', String(i === index));
    });
    input.setAttribute('aria-activedescendant', items.length ? `pal-opt-${index}` : '');
    list.children[index]?.scrollIntoView({ block: 'nearest' });
  }

  function accept(i = index) {
    const it = items[i];
    if (!it) return;
    close({ refocus: !['files', 'symbols', 'line'].includes(mode) });
    it.run();
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) index = Math.min(items.length - 1, index + 1);
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p' && !e.shiftKey)) index = Math.max(0, index - 1);
    else if (e.key === 'PageDown') index = Math.min(items.length - 1, index + 10);
    else if (e.key === 'PageUp') index = Math.max(0, index - 10);
    else if (e.key === 'Enter') return e.preventDefault(), accept();
    else if (e.key === 'Escape') return e.preventDefault(), close();
    else if (e.key === 'Tab') return e.preventDefault();
    else return;
    e.preventDefault();
    highlight();
  });

  // ---- commands ----
  function register(cmd) {
    commands.set(cmd.id, cmd);
  }
  function runCommand(id) {
    const c = commands.get(id);
    if (!c || (c.when && !c.when())) return;
    const i = recentCommands.indexOf(id);
    if (i >= 0) recentCommands.splice(i, 1);
    recentCommands.unshift(id);
    c.run();
  }

  // One keydown listener for every command's keys (capture: before the editor).
  // Chords ("Ctrl+K Z") wait for their second key.
  let chord = null;
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      let k = keyString(e);
      if (!k) return;
      if (chord) {
        k = `${chord} ${k}`;
        chord = null;
      } else if ([...commands.values()].some((c) => c.keys?.some((x) => x.startsWith(`${k} `)))) {
        chord = k;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // inside the palette only its own keys apply
      // inside the palette, only the keys that switch its mode apply
      if (!scrim.classList.contains('hidden') && box.contains(e.target) && !['Ctrl+Shift+P', 'Ctrl+P', 'F1', 'Ctrl+G', 'Ctrl+Shift+O', 'Ctrl+Alt+O'].includes(k)) return;
      for (const c of commands.values()) {
        if (!c.keys?.includes(k) || c.displayOnly) continue;
        if (c.when && !c.when()) continue;
        if (c.inInputs === false && e.target.matches?.('input:not(.code-input), textarea:not(.code-input)')) continue;
        e.preventDefault();
        e.stopPropagation();
        runCommand(c.id);
        return;
      }
    },
    true
  );

  return {
    open,
    close,
    pick,
    register,
    run: runCommand,
    commands,
    get isOpen() {
      return !scrim.classList.contains('hidden');
    },
  };
}
