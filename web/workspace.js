// The playground's multi-file workspace: a file tree, editor tabs, and a
// syntax-highlighted editor per open file.
//
// A project is { entry, files: {path: source} } plus a backend that stores it:
//   * localBackend: bundled examples and scratch projects, kept in this browser
//     (localStorage) on every change.
//   * remoteBackend: a running app's dev server (notes-on-foar's dev.mjs serves
//     /__foar/project and accepts PUT/DELETE /__foar/files). Changes are saved
//     to disk with Ctrl+S / "Save all"; the app then rebuilds and reloads.
//
// Buffers are the truth for compiling; `saved` is what the backend has. Saving
// is a diff: changed or new paths are written, missing ones deleted.
import { highlightFoar } from './foar-highlight.js';

const LINE_HEIGHT = 20; // px, keep in sync with .code-* in styles.css
const PAD_TOP = 14;
const PAD_LEFT = 16;

// Monospace metrics for drawing find marks over the highlighted text.
let cachedCharWidth = 0;
function charWidth(pre) {
  if (cachedCharWidth) return cachedCharWidth;
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(200);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
  pre.append(probe);
  cachedCharWidth = probe.getBoundingClientRect().width / 200 || 7.8;
  probe.remove();
  return cachedCharWidth;
}
function visualCol(text, lineStart, off) {
  let col = 0;
  for (let i = lineStart; i < off; i++) col = text[i] === '\t' ? col + 4 - (col % 4) : col + 1;
  return col;
}
const INDENT = '    ';

// ---- paths and imports (same rules as src/project.rs) ---------------------------------
export function resolveImport(from, spec) {
  if (!spec || spec.startsWith('/') || spec.includes('\\') || spec.includes('://')) return null;
  const parts = [];
  if (spec.startsWith('./') || spec.startsWith('../')) {
    parts.push(...from.split('/'));
    parts.pop();
  }
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const p = parts.join('/');
  return p.endsWith('.foar') ? p : `${p}.foar`;
}

const IMPORT_RE = /^([ \t]*import[ \t]+)"([^"\n]*)"(.*)$/gm;

/** Spec to write in `from` for `target`, in the style of `like` (relative or root, with/without .foar). */
function specFor(from, target, like) {
  let spec;
  if (like.startsWith('./') || like.startsWith('../')) {
    const a = from.split('/').slice(0, -1);
    const b = target.split('/');
    let i = 0;
    while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
    const ups = a.length - i;
    spec = (ups ? '../'.repeat(ups) : './') + b.slice(i).join('/');
  } else spec = target;
  return like.endsWith('.foar') ? spec : spec.replace(/\.foar$/, '');
}

/** Rewrites imports after files moved (`moves`: old path -> new path). */
export function rewriteImports(files, moves) {
  const out = {};
  for (const [newPath, src] of Object.entries(files)) {
    const oldPath = Object.entries(moves).find(([, n]) => n === newPath)?.[0] ?? newPath;
    out[newPath] = src.replace(IMPORT_RE, (line, head, spec, tail) => {
      const target = resolveImport(oldPath, spec);
      if (!target) return line;
      const moved = moves[target] ?? target;
      if (moved === target && oldPath === newPath) return line;
      return `${head}"${specFor(newPath, moved, spec)}"${tail}`;
    });
  }
  return out;
}

const viewNameFor = (path) => {
  const base = path.split('/').pop().replace(/\.foar$/, '');
  const name = base.replace(/(^|[-_ ]+)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/\W/g, '');
  return /^[A-Z]/.test(name) ? name : `View${name}`;
};

const template = (path) => {
  const name = viewNameFor(path);
  return `// ${name}\n\nview ${name}(label: String) {\n    state Idle {\n        render {\n            Text(label).style({\n                padding: 8px 12px;\n                border-radius: 8px;\n                background: #eef2ff;\n            })\n        }\n    }\n}\n`;
};

const VALID = /^[A-Za-z0-9_][A-Za-z0-9_. -]*(?:\/[A-Za-z0-9_][A-Za-z0-9_. -]*)*\.foar$/;

// ---- backends ---------------------------------------------------------------------------
export function localBackend(id, original) {
  const key = `foar.playground.v1.${id}`;
  return {
    kind: 'local',
    label: 'Kept in this browser',
    async load() {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved?.files && saved.files[original.entry]) return { ...original, files: saved.files, modified: true };
      } catch {}
      return { ...original, files: { ...original.files }, modified: false };
    },
    async save(files) {
      try {
        localStorage.setItem(key, JSON.stringify({ files }));
      } catch {}
    },
    async revert() {
      try {
        localStorage.removeItem(key);
      } catch {}
      return { ...original, files: { ...original.files } };
    },
  };
}

export function remoteBackend(base) {
  const api = (p) => new URL(p, base).href;
  return {
    kind: 'remote',
    label: base,
    async load() {
      const res = await fetch(api('/__foar/project'), { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res.json(); // { entry, name, files, writable }
    },
    async write(path, src) {
      const res = await fetch(api(`/__foar/files?path=${encodeURIComponent(path)}`), { method: 'PUT', body: src, headers: { 'Content-Type': 'text/plain' } });
      if (!res.ok) throw new Error(`${path}: ${(await res.text()) || res.status}`);
    },
    async remove(path) {
      const res = await fetch(api(`/__foar/files?path=${encodeURIComponent(path)}`), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`${path}: ${(await res.text()) || res.status}`);
    },
    watch(onChange) {
      try {
        const es = new EventSource(api('/__dev'));
        es.addEventListener('reload', onChange);
        es.addEventListener('compile-error', onChange);
        return () => es.close();
      } catch {
        return () => {};
      }
    },
  };
}

// ---- small DOM helpers --------------------------------------------------------------------
const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
};

const ICON = {
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  folder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.5l1.5 1.5h7v8.5h-13z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  newFile: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 1.5h5L12 5v3M3.5 1.5v13H8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M12 10v5M9.5 12.5h5" stroke="currentColor" stroke-width="1.3"/></svg>',
  newFolder: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.5l1.5 1.5h7v3M1.5 3.5v10H8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M12 9.5v5M9.5 12h5" stroke="currentColor" stroke-width="1.3"/></svg>',
  save: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 2.5h9l2 2v9h-11z M5 2.5v3.5h5V2.5 M5 13.5V9.5h6v4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};
const icon = (name, cls = '') => {
  const s = h('span', { class: `ico ${cls}` });
  s.innerHTML = ICON[name];
  return s;
};

// ---- the workspace ----------------------------------------------------------------------------
/**
 * createWorkspace(root, { onChange(project), onStatus(text) }) -> api
 * `root` gets the explorer + tabs + editors. onChange fires (debounced by the
 * caller) whenever any buffer changes; it receives { entry, files }.
 */
export function createWorkspace(root, { onChange, onSave } = {}) {
  let backend = null;
  let entry = '';
  let projectName = '';
  let files = {}; // path -> buffer
  let saved = {}; // path -> what the backend has
  let writable = true;
  let dirs = new Set(); // empty folders created in the tree
  let collapsed = new Set();
  let open = []; // open tab paths
  let active = null;
  let included = null; // Set of paths in the compiled program (null: unknown)
  let error = null; // { file, line, col, message }
  const editors = new Map(); // path -> editor
  let unwatch = () => {};
  let renaming = null; // { path, isDir, creating: 'file'|'dir', parent }
  let menu = null;
  let confirmDelete = null;

  // DOM
  const tree = h('div', { class: 'tree', role: 'tree', 'aria-label': 'Project files' });
  const title = h('span', { class: 'explorer-title' });
  const btnNewFile = h('button', { class: 'icon-btn', type: 'button', title: 'New file', 'aria-label': 'New file', onclick: () => startCreate('file', currentFolder()) });
  btnNewFile.append(icon('newFile'));
  const btnNewDir = h('button', { class: 'icon-btn', type: 'button', title: 'New folder', 'aria-label': 'New folder', onclick: () => startCreate('dir', currentFolder()) });
  btnNewDir.append(icon('newFolder'));
  const btnSave = h('button', { class: 'icon-btn', type: 'button', title: 'Save all (Ctrl+S)', 'aria-label': 'Save all', onclick: () => saveAll() });
  btnSave.append(icon('save'));
  const foot = h('div', { class: 'explorer-foot', 'aria-live': 'polite' });
  const explorer = h(
    'aside',
    { class: 'explorer', 'aria-label': 'Explorer' },
    h('div', { class: 'explorer-head' }, title, h('span', { class: 'spacer' }), btnNewFile, btnNewDir, btnSave),
    tree,
    foot
  );
  const tabs = h('div', { class: 'tabs-bar', role: 'tablist', 'aria-label': 'Open files' });
  const host = h('div', { class: 'editor-host' });
  const empty = h('div', { class: 'editor-empty' }, 'Open a file from the explorer, or create one with ', icon('newFile'), '.');
  host.append(empty);
  const editorCol = h('div', { class: 'editor-col' }, tabs, host);
  root.append(explorer, editorCol);
  // 'active' (tab switched), 'change' (buffers), 'compile' (result in), 'cursor'
  const events = new EventTarget();
  const emit = (type, detail) => events.dispatchEvent(new CustomEvent(type, { detail }));

  // ---- state helpers ----
  const dirty = (p) => files[p] !== saved[p];
  const dirtyPaths = () => [...new Set([...Object.keys(files), ...Object.keys(saved)])].filter((p) => files[p] !== saved[p]);
  const project = () => ({ entry, files: { ...files } });
  const currentFolder = () => {
    const sel = tree.querySelector('[aria-selected="true"]');
    if (!sel) return '';
    return sel.dataset.dir != null ? sel.dataset.dir : sel.dataset.path.split('/').slice(0, -1).join('/');
  };

  let persistTimer = 0;
  function changed({ structure = false } = {}) {
    if (backend?.kind === 'local') {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        backend.save(files);
        saved = { ...files };
        renderTree();
        renderTabs();
        renderFoot();
      }, 250);
    }
    if (structure) renderTree();
    else updateDirtyMarks();
    renderTabs();
    renderFoot();
    onChange?.(project());
    emit('change');
  }

  // ---- editor (one per open file: each keeps its own undo history) ----
  function makeEditor(path) {
    const gutter = h('div', { class: 'code-gutter', 'aria-hidden': 'true' });
    const code = h('code');
    const marker = h('div', { class: 'code-error-line hidden' });
    const pre = h('pre', { class: 'code-hl', 'aria-hidden': 'true' }, marker, code);
    const ta = h('textarea', {
      class: 'code-input',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      wrap: 'off',
      'aria-label': `${path} source`,
      'aria-multiline': 'true',
    });
    ta.value = files[path] ?? '';
    const marks = h('div', { class: 'code-marks' });
    pre.prepend(marks);
    const wrap = h('div', { class: 'code-view', role: 'tabpanel' }, gutter, h('div', { class: 'code-stack' }, pre, ta));
    ta.addEventListener('keyup', () => emit('cursor'));
    ta.addEventListener('mouseup', () => emit('cursor'));
    ta.addEventListener('focus', () => emit('cursor'));
    let lines = -1;
    const paint = () => {
      code.innerHTML = highlightFoar(ta.value) + '\n';
      const n = ta.value.split('\n').length;
      if (n !== lines) {
        lines = n;
        gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n');
      }
      paintError();
      sync();
    };
    const sync = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      gutter.scrollTop = ta.scrollTop;
    };
    const paintError = () => {
      const on = error && error.file === path && error.line > 0;
      marker.classList.toggle('hidden', !on);
      if (on) marker.style.top = `${PAD_TOP + (error.line - 1) * LINE_HEIGHT}px`;
      for (const el of gutter.querySelectorAll('.err')) el.classList.remove('err');
      gutter.classList.toggle('has-error', !!on);
      gutter.style.setProperty('--err-top', on ? `${PAD_TOP + (error.line - 1) * LINE_HEIGHT}px` : '-100px');
    };
    ta.addEventListener('input', () => {
      files[path] = ta.value;
      paint();
      changed();
    });
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keydown', (e) => onEditorKey(e, ta));
    ta.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) goToDefinition(ta);
    });
    paint();
    return {
      wrap,
      ta,
      paint,
      paintError,
      setValue(v) {
        if (ta.value === v) return;
        const { selectionStart: s, selectionEnd: e, scrollTop } = ta;
        ta.value = v;
        ta.setSelectionRange(Math.min(s, v.length), Math.min(e, v.length));
        ta.scrollTop = scrollTop;
        paint();
      },
      /** Find matches: [[start, end], ...] offsets; `current` is drawn stronger. */
      setMarks(ranges = [], current = -1) {
        marks.textContent = '';
        if (!ranges.length) return;
        const cw = charWidth(pre);
        const v = ta.value;
        const lineStarts = [0];
        for (let i = 0; i < v.length; i++) if (v.charCodeAt(i) === 10) lineStarts.push(i + 1);
        const lineOf = (off) => {
          let lo = 0;
          let hi = lineStarts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= off) lo = mid;
            else hi = mid - 1;
          }
          return lo;
        };
        const frag = document.createDocumentFragment();
        ranges.slice(0, 5000).forEach(([a, b], i) => {
          const line = lineOf(a);
          const col = visualCol(v, lineStarts[line], a);
          const lineEnd = v.indexOf('\n', a);
          const endCol = visualCol(v, lineStarts[line], Math.min(b, lineEnd < 0 ? v.length : lineEnd));
          const m = document.createElement('div');
          m.className = `code-mark${i === current ? ' current' : ''}`;
          m.style.cssText = `top:${PAD_TOP + line * LINE_HEIGHT}px;left:${PAD_LEFT + col * cw}px;width:${Math.max(2, (endCol - col) * cw)}px`;
          frag.append(m);
        });
        marks.append(frag);
      },
      /** Select [start, end) and scroll it into view (centred if off screen). */
      select(start, end = start, { focus = true } = {}) {
        if (focus) ta.focus({ preventScroll: true });
        ta.setSelectionRange(start, end);
        const line = ta.value.slice(0, start).split('\n').length - 1;
        const top = PAD_TOP + line * LINE_HEIGHT;
        if (top < ta.scrollTop + LINE_HEIGHT || top > ta.scrollTop + ta.clientHeight - 3 * LINE_HEIGHT) ta.scrollTop = Math.max(0, top - ta.clientHeight / 3);
        const cw = charWidth(pre);
        const col = visualCol(ta.value, ta.value.lastIndexOf('\n', start - 1) + 1, start);
        const left = PAD_LEFT + col * cw;
        if (left < ta.scrollLeft || left > ta.scrollLeft + ta.clientWidth - 40) ta.scrollLeft = Math.max(0, left - ta.clientWidth / 2);
        sync();
        emit('cursor');
      },
      goTo(line, col = 1) {
        const ls = ta.value.split('\n');
        let off = 0;
        for (let i = 0; i < Math.min(line - 1, ls.length); i++) off += ls[i].length + 1;
        off += Math.max(0, col - 1);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(off, off);
        ta.scrollTop = Math.max(0, (line - 6) * LINE_HEIGHT);
        sync();
      },
    };
  }

  // Edits through execCommand keep the textarea's own undo history (Ctrl+Z).
  function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) ta.setRangeText(text, start, end, 'end');
    if (selStart != null) ta.setSelectionRange(selStart, selEnd ?? selStart);
    ta.dispatchEvent(new Event('input'));
  }

  function lineRange(ta) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && v[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    if (end < 0) end = v.length;
    return [start, end];
  }

  function onEditorKey(e, ta) {
    const mod = e.ctrlKey || e.metaKey;
    const v = ta.value;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      const multi = v.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
      if (!multi && !e.shiftKey) {
        e.preventDefault();
        replaceRange(ta, ta.selectionStart, ta.selectionEnd, INDENT);
        return;
      }
      e.preventDefault();
      const [s, end] = lineRange(ta);
      const block = v.slice(s, end);
      const out = e.shiftKey
        ? block.replace(/^( {1,4}|\t)/gm, '')
        : block.replace(/^(?=.)/gm, INDENT);
      replaceRange(ta, s, end, out, s, s + out.length);
    } else if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey) {
      const ls = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(v.slice(ls))[0];
      const before = v.slice(0, ta.selectionStart).trimEnd();
      const after = v.slice(ta.selectionEnd);
      const opens = /[{([]$/.test(before);
      const closes = /^[ \t]*[})\]]/.test(after);
      e.preventDefault();
      if (opens && closes) {
        const text = `\n${indent}${INDENT}\n${indent}`;
        const caret = ta.selectionStart + 1 + indent.length + INDENT.length;
        replaceRange(ta, ta.selectionStart, ta.selectionEnd, text, caret);
      } else replaceRange(ta, ta.selectionStart, ta.selectionEnd, `\n${indent}${opens ? INDENT : ''}`);
    } else if (e.key === '}' && !mod) {
      // Typing } on a blank indented line: outdent it.
      const ls = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      const lead = v.slice(ls, ta.selectionStart);
      if (/^[ \t]+$/.test(lead) && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        replaceRange(ta, ls, ta.selectionStart, `${lead.replace(/( {1,4}|\t)$/, '')}}`);
      }
    } else if (mod && e.key === '/') {
      e.preventDefault();
      const [s, end] = lineRange(ta);
      const block = v.slice(s, end);
      const lines = block.split('\n');
      const commented = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
      const minIndent = Math.min(...lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length));
      const out = lines
        .map((l) => {
          if (!l.trim()) return l;
          return commented ? l.replace(/^(\s*)\/\/ ?/, '$1') : `${l.slice(0, minIndent)}// ${l.slice(minIndent)}`;
        })
        .join('\n');
      replaceRange(ta, s, end, out, s, s + out.length);
    } else if (mod && (e.key === 'd' || e.key === 'D') && e.shiftKey) {
      // Duplicate line(s)
      e.preventDefault();
      const [s, end] = lineRange(ta);
      const block = v.slice(s, end);
      replaceRange(ta, end, end, `\n${block}`, end + 1, end + 1 + block.length);
    }
  }

  // Ctrl/Cmd+click on a name: open the file that declares it.
  function declarations() {
    const out = new Map();
    for (const [p, src] of Object.entries(files)) {
      for (const m of src.matchAll(/^[ \t]*(view|data|style)[ \t]+([A-Za-z_]\w*)/gm)) {
        const line = src.slice(0, m.index).split('\n').length;
        out.set(m[2], { path: p, line });
      }
    }
    return out;
  }
  function goToDefinition(ta) {
    const v = ta.value;
    let s = ta.selectionStart;
    let e = s;
    while (s > 0 && /\w/.test(v[s - 1])) s--;
    while (e < v.length && /\w/.test(v[e])) e++;
    const word = v.slice(s, e);
    const lineText = v.slice(v.lastIndexOf('\n', s - 1) + 1, v.indexOf('\n', s) < 0 ? v.length : v.indexOf('\n', s));
    const imp = /import\s+"([^"]+)"/.exec(lineText);
    const from = Object.keys(files).find((p) => editors.get(p)?.ta === ta);
    if (imp && from) {
      const target = resolveImport(from, imp[1]);
      if (target && files[target] != null) return openFile(target);
    }
    const d = word && declarations().get(word);
    if (d) openFile(d.path, { line: d.line });
  }

  // ---- tabs ----
  function openFile(path, { line, col, select, focus = true } = {}) {
    if (files[path] == null) return;
    if (!open.includes(path)) open.push(path);
    active = path;
    let ed = editors.get(path);
    if (!ed) {
      ed = makeEditor(path);
      editors.set(path, ed);
      host.append(ed.wrap);
    }
    for (const [p, e] of editors) e.wrap.classList.toggle('active', p === path);
    empty.classList.add('hidden');
    renderTabs();
    selectInTree(path);
    if (select) ed.select(select[0], select[1], { focus });
    else if (line) ed.goTo(line, col);
    else if (focus) ed.ta.focus({ preventScroll: true });
    persistUi();
    emit('active', path);
  }

  function closeFile(path) {
    const i = open.indexOf(path);
    if (i < 0) return;
    open.splice(i, 1);
    const ed = editors.get(path);
    ed?.wrap.remove();
    editors.delete(path);
    if (active === path) {
      active = open[i] ?? open[i - 1] ?? null;
      if (active) openFile(active);
      else {
        empty.classList.remove('hidden');
        emit('active', null);
      }
    }
    renderTabs();
    persistUi();
  }

  function renderTabs() {
    tabs.textContent = '';
    for (const p of open) {
      const name = p.split('/').pop();
      const isDirty = dirty(p) && backend?.kind === 'remote';
      const tab = h(
        'div',
        {
          class: `tab${p === active ? ' active' : ''}${isDirty ? ' dirty' : ''}${error?.file === p ? ' has-error' : ''}`,
          role: 'tab',
          'aria-selected': String(p === active),
          tabindex: p === active ? '0' : '-1',
          title: p,
          dataset: { path: p },
          onclick: (e) => {
            if (!e.target.closest('.tab-close')) openFile(p);
          },
          onauxclick: (e) => {
            if (e.button === 1) closeFile(p);
          },
          onkeydown: (e) => {
            const i = open.indexOf(p);
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              const next = open[(i + (e.key === 'ArrowRight' ? 1 : -1) + open.length) % open.length];
              openFile(next, { focus: false });
              tabs.querySelector(`[data-path="${CSS.escape(next)}"]`)?.focus();
            } else if (e.key === 'Delete') closeFile(p);
            else if (e.key === 'Enter') editors.get(p)?.ta.focus();
          },
        },
        icon('file', p === entry ? 'entry' : ''),
        h('span', { class: 'tab-name', text: name }),
        h('button', { class: 'tab-close', type: 'button', 'aria-label': `Close ${name}`, title: 'Close (middle-click)', onclick: () => closeFile(p), tabindex: '-1' }, '×')
      );
      tabs.append(tab);
    }
    tabs.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---- tree ----
  function buildTree() {
    const rootNode = { dirs: new Map(), files: [] };
    const dirNode = (path) => {
      let n = rootNode;
      if (!path) return n;
      let acc = '';
      for (const seg of path.split('/')) {
        acc = acc ? `${acc}/${seg}` : seg;
        if (!n.dirs.has(seg)) n.dirs.set(seg, { path: acc, dirs: new Map(), files: [] });
        n = n.dirs.get(seg);
      }
      return n;
    };
    for (const d of dirs) dirNode(d);
    for (const p of Object.keys(files)) {
      const parts = p.split('/');
      dirNode(parts.slice(0, -1).join('/')).files.push(p);
    }
    return rootNode;
  }

  function renameRow(depth, value, onCommit) {
    const input = h('input', {
      class: 'tree-input',
      value,
      'aria-label': 'Name',
      spellcheck: 'false',
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(input.value.trim());
        } else if (e.key === 'Escape') {
          e.preventDefault();
          renaming = null;
          renderTree();
          tree.querySelector('[aria-selected="true"]')?.focus();
        }
        e.stopPropagation();
      },
      onblur: () => {
        if (renaming) onCommit(input.value.trim(), true);
      },
    });
    const row = h('div', { class: 'tree-row editing', style: `--depth:${depth}` }, icon(renaming?.creating === 'dir' || renaming?.isDir ? 'folder' : 'file'), input);
    requestAnimationFrame(() => {
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 && !renaming?.isDir ? dot : value.length);
    });
    return row;
  }

  function renderTree() {
    const focusedKey = document.activeElement?.closest?.('.tree-row')?.dataset;
    const focusPath = focusedKey?.path ?? (focusedKey?.dir != null ? `dir:${focusedKey.dir}` : null);
    tree.textContent = '';
    const add = (node, depth) => {
      const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
      if (renaming?.creating && renaming.parent === (node.path ?? '')) {
        tree.append(renameRow(depth, renaming.creating === 'dir' ? 'folder' : 'Component.foar', (v, blur) => commitCreate(v, blur)));
      }
      for (const name of dirNames) {
        const d = node.dirs.get(name);
        const isOpen = !collapsed.has(d.path);
        if (renaming?.path === d.path && renaming.isDir) {
          tree.append(renameRow(depth, name, (v, blur) => commitRename(d.path, v, true, blur)));
        } else {
          const row = h(
            'div',
            {
              class: 'tree-row dir',
              role: 'treeitem',
              'aria-level': String(depth + 1),
              'aria-expanded': String(isOpen),
              'aria-selected': 'false',
              tabindex: '-1',
              style: `--depth:${depth}`,
              dataset: { dir: d.path },
              draggable: 'true',
            },
            icon('chevron', `chev${isOpen ? ' open' : ''}`),
            icon('folder'),
            h('span', { class: 'tree-name', text: name })
          );
          tree.append(row);
        }
        if (isOpen) add(d, depth + 1);
      }
      for (const p of node.files.sort((a, b) => (a === entry ? -1 : b === entry ? 1 : a.localeCompare(b)))) {
        const name = p.split('/').pop();
        if (renaming?.path === p && !renaming.isDir) {
          tree.append(renameRow(depth, name, (v, blur) => commitRename(p, v, false, blur)));
          continue;
        }
        const orphan = included && !included.has(p);
        const isDirty = dirty(p) && backend?.kind === 'remote';
        const row = h(
          'div',
          {
            class: `tree-row file${orphan ? ' orphan' : ''}${error?.file === p ? ' has-error' : ''}${p === active ? ' current' : ''}`,
            role: 'treeitem',
            'aria-level': String(depth + 1),
            'aria-selected': 'false',
            tabindex: '-1',
            style: `--depth:${depth}`,
            dataset: { path: p },
            draggable: 'true',
            title: orphan ? `${p} — not part of the program: nothing imports it` : p,
          },
          h('span', { class: 'ico chev-space' }),
          icon('file', p === entry ? 'entry' : ''),
          h('span', { class: 'tree-name', text: name }),
          p === entry ? h('span', { class: 'badge', text: 'entry', title: 'Entry file: its first view is the root' }) : null,
          orphan ? h('span', { class: 'badge muted', text: 'not imported' }) : null,
          error?.file === p ? h('span', { class: 'badge err', text: `${error.line}:${error.col}`, title: error.message }) : null,
          h('span', { class: `dot${isDirty ? ' on' : ''}`, 'aria-label': isDirty ? 'unsaved' : null })
        );
        tree.append(row);
      }
    };
    add(buildTree(), 0);
    if (!tree.querySelector('.tree-row[role=treeitem]') && !renaming) tree.append(h('div', { class: 'tree-empty', text: 'No files yet.' }));
    // selection + roving tabindex
    selectInTree(active, false);
    if (focusPath) {
      const el = focusPath.startsWith('dir:')
        ? tree.querySelector(`[data-dir="${CSS.escape(focusPath.slice(4))}"]`)
        : tree.querySelector(`[data-path="${CSS.escape(focusPath)}"]`);
      if (el) {
        selectRow(el);
        if (!renaming) el.focus({ preventScroll: true });
      }
    }
  }

  function updateDirtyMarks() {
    for (const row of tree.querySelectorAll('.tree-row.file')) {
      const on = dirty(row.dataset.path) && backend?.kind === 'remote';
      row.querySelector('.dot')?.classList.toggle('on', on);
    }
  }

  function selectRow(row) {
    for (const r of tree.querySelectorAll('.tree-row[aria-selected="true"]')) r.setAttribute('aria-selected', 'false');
    for (const r of tree.querySelectorAll('.tree-row[tabindex="0"]')) r.setAttribute('tabindex', '-1');
    if (!row) return;
    row.setAttribute('aria-selected', 'true');
    row.setAttribute('tabindex', '0');
  }

  function selectInTree(path, scroll = true) {
    if (!path) {
      const first = tree.querySelector('.tree-row[role=treeitem]');
      if (first) first.setAttribute('tabindex', '0');
      return;
    }
    // reveal: expand parent folders
    const parts = path.split('/');
    let changedDirs = false;
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (collapsed.delete(d)) changedDirs = true;
    }
    if (changedDirs) return renderTree();
    for (const r of tree.querySelectorAll('.tree-row.current')) r.classList.remove('current');
    const row = tree.querySelector(`[data-path="${CSS.escape(path)}"]`);
    row?.classList.add('current');
    selectRow(row);
    if (scroll) row?.scrollIntoView({ block: 'nearest' });
  }

  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row[role=treeitem]');
    if (!row) return;
    selectRow(row);
    if (row.dataset.dir != null) toggleDir(row.dataset.dir);
    else openFile(row.dataset.path, { focus: e.detail > 1 });
  });

  function toggleDir(d, force) {
    const isOpen = !collapsed.has(d);
    const want = force ?? !isOpen;
    if (want) collapsed.delete(d);
    else collapsed.add(d);
    renderTree();
    tree.querySelector(`[data-dir="${CSS.escape(d)}"]`)?.focus();
    persistUi();
  }

  tree.addEventListener('keydown', (e) => {
    const row = e.target.closest('.tree-row[role=treeitem]');
    if (!row) return;
    const rows = [...tree.querySelectorAll('.tree-row[role=treeitem]')];
    const i = rows.indexOf(row);
    const go = (r) => {
      if (!r) return;
      selectRow(r);
      r.focus();
      r.scrollIntoView({ block: 'nearest' });
    };
    const isDir = row.dataset.dir != null;
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') go(rows[i - 1]);
    else if (e.key === 'Home') go(rows[0]);
    else if (e.key === 'End') go(rows[rows.length - 1]);
    else if (e.key === 'ArrowRight' && isDir) {
      if (collapsed.has(row.dataset.dir)) toggleDir(row.dataset.dir, true);
      else go(rows[i + 1]);
    } else if (e.key === 'ArrowLeft') {
      if (isDir && !collapsed.has(row.dataset.dir)) toggleDir(row.dataset.dir, false);
      else {
        const parent = (row.dataset.dir ?? row.dataset.path).split('/').slice(0, -1).join('/');
        go(tree.querySelector(`[data-dir="${CSS.escape(parent)}"]`));
      }
    } else if (e.key === 'Enter') {
      if (isDir) toggleDir(row.dataset.dir);
      else openFile(row.dataset.path);
    } else if (e.key === 'F2') startRename(row);
    else if (e.key === 'Delete') askDelete(row);
    else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      const r = row.getBoundingClientRect();
      showMenu(row, r.left + 24, r.bottom);
    } else return;
    e.preventDefault();
  });

  // ---- drag a file or folder onto a folder (or the empty area = root) to move it ----
  let dragging = null;
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.tree-row[role=treeitem]');
    if (!row) return;
    dragging = row.dataset.dir != null ? { dir: row.dataset.dir } : { path: row.dataset.path };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragging.path ?? dragging.dir);
    row.classList.add('drag-source');
  });
  tree.addEventListener('dragend', () => {
    dragging = null;
    for (const r of tree.querySelectorAll('.drag-source, .drop-over')) r.classList.remove('drag-source', 'drop-over');
    tree.classList.remove('drop-root');
  });
  const dropTarget = (e) => {
    const row = e.target.closest('.tree-row[role=treeitem]');
    if (!row) return '';
    return row.dataset.dir ?? row.dataset.path.split('/').slice(0, -1).join('/');
  };
  tree.addEventListener('dragover', (e) => {
    if (!dragging) return;
    const target = dropTarget(e);
    const src = dragging.path ?? dragging.dir;
    if (dragging.dir != null && (target === dragging.dir || target.startsWith(`${dragging.dir}/`))) return;
    if (src.split('/').slice(0, -1).join('/') === target) return;
    e.preventDefault();
    for (const r of tree.querySelectorAll('.drop-over')) r.classList.remove('drop-over');
    if (target) tree.querySelector(`[data-dir="${CSS.escape(target)}"]`)?.classList.add('drop-over');
    tree.classList.toggle('drop-root', !target);
  });
  tree.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const target = dropTarget(e);
    const src = dragging.path ?? dragging.dir;
    const name = src.split('/').pop();
    move(src, target ? `${target}/${name}` : name, dragging.dir != null);
  });

  // ---- create / rename / move / delete ----
  // A folder emptied by a move or delete stays in the tree (until reload, like an
  // empty folder in a git checkout).
  function keepFolder(path) {
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && !Object.keys(files).some((p) => p.startsWith(`${parent}/`))) dirs.add(parent);
  }

  function startCreate(kind, parent) {
    if (parent) collapsed.delete(parent);
    renaming = { creating: kind, parent };
    renderTree();
  }

  function validate(path, isDir) {
    if (!isDir && !VALID.test(path)) return 'Use letters, digits, "-", "_" and "/"; files end in .foar';
    if (isDir && !/^[A-Za-z0-9_][A-Za-z0-9_. -]*(\/[A-Za-z0-9_][A-Za-z0-9_. -]*)*$/.test(path)) return 'Invalid folder name';
    if (files[path] != null || dirs.has(path) || Object.keys(files).some((p) => p.startsWith(`${path}/`))) return `${path} already exists`;
    return null;
  }

  function flash(msg) {
    foot.dataset.flash = msg;
    renderFoot();
    setTimeout(() => {
      if (foot.dataset.flash === msg) {
        delete foot.dataset.flash;
        renderFoot();
      }
    }, 3500);
  }

  function commitCreate(value, fromBlur) {
    const r = renaming;
    if (!r) return;
    if (!value) {
      renaming = null;
      return renderTree();
    }
    let name = value.replace(/^\/+|\/+$/g, '');
    if (r.creating === 'file' && !name.endsWith('.foar')) name += '.foar';
    const path = r.parent ? `${r.parent}/${name}` : name;
    const problem = validate(path, r.creating === 'dir');
    if (problem) {
      if (fromBlur) {
        renaming = null;
        renderTree();
      }
      return flash(problem);
    }
    renaming = null;
    if (r.creating === 'dir') {
      dirs.add(path);
      collapsed.delete(path);
      renderTree();
      tree.querySelector(`[data-dir="${CSS.escape(path)}"]`)?.focus();
      return;
    }
    files[path] = template(path);
    for (const d of [...dirs]) if (path.startsWith(`${d}/`)) dirs.delete(d);
    // Make it part of the program: import it from the entry file.
    const spec = path.replace(/\.foar$/, '');
    const src = files[entry] ?? '';
    const imports = [...src.matchAll(/^[ \t]*import[ \t]+"[^"\n]*".*$/gm)];
    const at = imports.length ? imports[imports.length - 1].index + imports[imports.length - 1][0].length : firstCodeOffset(src);
    const line = `import "${spec}"`;
    files[entry] = imports.length ? `${src.slice(0, at)}\n${line}${src.slice(at)}` : `${src.slice(0, at)}${line}\n\n${src.slice(at)}`;
    editors.get(entry)?.setValue(files[entry]);
    changed({ structure: true });
    openFile(path, { line: 3, col: 6 });
    flash(`Created ${path} and imported it from ${entry}`);
  }

  // After the header comment of a file: where a first import goes.
  function firstCodeOffset(src) {
    const m = /^(?:[ \t]*\/\/[^\n]*\n|[ \t]*\n)*/.exec(src);
    return m ? m[0].length : 0;
  }

  function startRename(row) {
    if (row.dataset.dir != null) renaming = { path: row.dataset.dir, isDir: true };
    else renaming = { path: row.dataset.path, isDir: false };
    renderTree();
  }

  function commitRename(oldPath, value, isDir, fromBlur) {
    renaming = null;
    const parent = oldPath.split('/').slice(0, -1).join('/');
    let name = (value || '').replace(/\//g, '');
    if (!name || name === oldPath.split('/').pop()) return renderTree();
    if (!isDir && !name.endsWith('.foar')) name += '.foar';
    move(oldPath, parent ? `${parent}/${name}` : name, isDir, fromBlur);
  }

  function move(from, to, isDir) {
    if (from === to) return renderTree();
    const problem = validate(to, isDir);
    if (problem) {
      renderTree();
      return flash(problem);
    }
    const moves = {};
    if (isDir) {
      for (const p of Object.keys(files)) if (p.startsWith(`${from}/`)) moves[p] = to + p.slice(from.length);
      for (const d of [...dirs]) if (d === from || d.startsWith(`${from}/`)) {
        dirs.delete(d);
        dirs.add(to + d.slice(from.length));
      }
    } else moves[from] = to;
    const next = {};
    for (const [p, src] of Object.entries(files)) next[moves[p] ?? p] = src;
    const rewritten = rewriteImports(next, moves);
    const touched = Object.keys(rewritten).filter((p) => rewritten[p] !== next[p]).length;
    files = rewritten;
    keepFolder(from);
    for (const d of [...dirs]) if (to === d || to.startsWith(`${d}/`)) dirs.delete(d);
    if (moves[entry]) entry = moves[entry];
    // carry open editors/tabs over
    open = open.map((p) => moves[p] ?? p);
    if (active) active = moves[active] ?? active;
    for (const [oldP, newP] of Object.entries(moves)) {
      const ed = editors.get(oldP);
      if (ed) {
        editors.delete(oldP);
        editors.set(newP, ed);
        ed.ta.setAttribute('aria-label', `${newP} source`);
      }
    }
    for (const [p, ed] of editors) ed.setValue(files[p]);
    changed({ structure: true });
    if (active) selectInTree(active);
    flash(`Moved to ${to}${touched ? ` · updated imports in ${touched} file${touched === 1 ? '' : 's'}` : ''}`);
  }

  function askDelete(row) {
    const isDir = row.dataset.dir != null;
    const target = isDir ? row.dataset.dir : row.dataset.path;
    if (!isDir && target === entry) return flash('The entry file can’t be deleted');
    const doomed = isDir ? Object.keys(files).filter((p) => p.startsWith(`${target}/`)) : [target];
    const importers = Object.entries(files).filter(([p, src]) => !doomed.includes(p) && [...src.matchAll(IMPORT_RE)].some((m) => doomed.includes(resolveImport(p, m[2]))));
    closeMenu();
    confirmDelete?.remove();
    const what = isDir ? `folder ${target} (${doomed.length} file${doomed.length === 1 ? '' : 's'})` : target;
    const dlg = h(
      'div',
      { class: 'ws-confirm', role: 'alertdialog', 'aria-modal': 'false', 'aria-label': `Delete ${what}?` },
      h('div', { class: 'ws-confirm-title', text: `Delete ${what}?` }),
      h('div', {
        class: 'ws-confirm-body',
        text:
          (importers.length ? `Its import in ${importers.map(([p]) => p).join(', ')} will be removed. ` : '') +
          (backend?.kind === 'remote' ? 'The file is deleted from disk when you save.' : 'You can revert the example later.'),
      }),
      h(
        'div',
        { class: 'ws-confirm-actions' },
        h('button', { type: 'button', class: 'btn-tiny', text: 'Cancel', onclick: () => closeConfirm() }),
        h('button', { type: 'button', class: 'btn-tiny danger', text: 'Delete', onclick: () => doDelete(doomed, isDir ? target : null) })
      )
    );
    const closeConfirm = () => {
      dlg.remove();
      confirmDelete = null;
      row.isConnected ? row.focus() : tree.querySelector('[tabindex="0"]')?.focus();
    };
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeConfirm();
    });
    explorer.append(dlg);
    confirmDelete = dlg;
    dlg.querySelector('.danger').focus();
  }

  function doDelete(doomed, dir) {
    confirmDelete?.remove();
    confirmDelete = null;
    for (const p of doomed) {
      delete files[p];
      if (open.includes(p)) closeFile(p);
    }
    keepFolder(dir ?? doomed[0]);
    if (dir) for (const d of [...dirs]) if (d === dir || d.startsWith(`${dir}/`)) dirs.delete(d);
    for (const [p, src] of Object.entries(files)) {
      const out = src.replace(/^[ \t]*import[ \t]+"([^"\n]*)".*(?:\n|$)/gm, (line, spec) => (doomed.includes(resolveImport(p, spec)) ? '' : line));
      if (out !== src) {
        files[p] = out;
        editors.get(p)?.setValue(out);
      }
    }
    changed({ structure: true });
    tree.querySelector('[tabindex="0"]')?.focus();
    flash(`Deleted ${dir ?? doomed[0]}`);
  }

  // ---- context menu ----
  function closeMenu() {
    menu?.remove();
    menu = null;
  }
  function showMenu(row, x, y) {
    closeMenu();
    const isDir = row?.dataset.dir != null;
    const path = row ? row.dataset.dir ?? row.dataset.path : '';
    const folder = row ? (isDir ? path : path.split('/').slice(0, -1).join('/')) : '';
    const items = [
      ['New file…', () => startCreate('file', folder)],
      ['New folder…', () => startCreate('dir', folder)],
      row && ['—'],
      row && !isDir && ['Open', () => openFile(path)],
      row && ['Rename…', () => startRename(row), 'F2'],
      row && !isDir && ['Copy import', () => navigator.clipboard?.writeText(`import "${path.replace(/\.foar$/, '')}"`).then(() => flash('Import copied'))],
      row && !isDir && path !== entry && ['Duplicate', () => duplicate(path)],
      row && ['—'],
      row && (isDir || path !== entry) && ['Delete…', () => askDelete(row), 'Del', 'danger'],
    ].filter(Boolean);
    menu = h('div', { class: 'ws-menu', role: 'menu', 'aria-label': row ? `Actions for ${path}` : 'Explorer actions' });
    for (const [label, fn, hint, cls] of items) {
      if (label === '—') {
        menu.append(h('div', { class: 'ws-menu-sep', role: 'separator' }));
        continue;
      }
      menu.append(
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            class: `ws-menu-item ${cls ?? ''}`,
            tabindex: '-1',
            onclick: () => {
              closeMenu();
              fn();
            },
          },
          h('span', { text: label }),
          hint ? h('span', { class: 'hint', text: hint }) : null
        )
      );
    }
    menu.addEventListener('keydown', (e) => {
      const its = [...menu.querySelectorAll('[role=menuitem]')];
      const i = its.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') its[(i + 1) % its.length].focus();
      else if (e.key === 'ArrowUp') its[(i - 1 + its.length) % its.length].focus();
      else if (e.key === 'Escape' || e.key === 'Tab') {
        closeMenu();
        (row?.isConnected ? row : tree.querySelector('[tabindex="0"]'))?.focus();
      } else return;
      e.preventDefault();
    });
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
    menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
    menu.querySelector('[role=menuitem]')?.focus();
  }
  explorer.addEventListener('contextmenu', (e) => {
    if (e.shiftKey || e.target.closest('input')) return;
    e.preventDefault();
    const row = e.target.closest('.tree-row[role=treeitem]');
    if (row) selectRow(row);
    showMenu(row, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target)) closeMenu();
  }, true);

  function duplicate(path) {
    let n = 2;
    const base = path.replace(/\.foar$/, '');
    while (files[`${base}${n}.foar`] != null) n++;
    const to = `${base}${n}.foar`;
    const oldName = viewNameFor(path);
    const newName = viewNameFor(to);
    files[to] = files[path].replace(new RegExp(`\\b(view|data|style)(\\s+)${oldName}\\b`, 'g'), `$1$2${newName}`);
    changed({ structure: true });
    openFile(to);
    flash(`Duplicated as ${to} (view ${newName}); import it to use it`);
  }

  // ---- saving ----
  async function saveAll() {
    if (!backend) return;
    if (backend.kind === 'local') {
      await backend.save(files);
      saved = { ...files };
      flash('Saved in this browser');
      return;
    }
    if (!writable) return flash('This project is read-only');
    const paths = dirtyPaths();
    if (!paths.length) return flash('Nothing to save');
    try {
      // Writes first, then deletes: an import never points at a missing file on disk.
      for (const p of paths.filter((p) => files[p] != null)) {
        await backend.write(p, files[p]);
        saved[p] = files[p];
      }
      for (const p of paths.filter((p) => files[p] == null)) {
        await backend.remove(p);
        delete saved[p];
      }
      flash(`Saved ${paths.length} file${paths.length === 1 ? '' : 's'} · the app is rebuilding`);
      onSave?.();
    } catch (err) {
      flash(`Save failed: ${err.message}`);
    }
    renderTree();
    renderTabs();
    renderFoot();
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      saveAll();
    }
  });
  addEventListener('beforeunload', (e) => {
    if (backend?.kind === 'remote' && dirtyPaths().length) e.preventDefault();
  });

  function renderFoot() {
    const n = backend?.kind === 'remote' ? dirtyPaths().length : 0;
    foot.textContent = '';
    if (foot.dataset.flash) {
      foot.append(h('span', { class: 'flash', text: foot.dataset.flash }));
      return;
    }
    if (backend?.kind === 'remote') {
      foot.append(
        h('span', { class: n ? 'unsaved' : '', text: !writable ? 'Read-only' : n ? `● ${n} unsaved · Ctrl+S saves to disk` : 'All changes saved to disk' })
      );
    } else if (backend) {
      const changedFromOriginal = JSON.stringify(files) !== JSON.stringify(original);
      foot.append(h('span', { text: changedFromOriginal ? 'Your edits are kept in this browser' : 'Edits are kept in this browser' }));
      if (changedFromOriginal) foot.append(h('button', { type: 'button', class: 'link-btn', text: 'Revert', onclick: revert }));
    }
    btnSave.disabled = backend?.kind !== 'remote' || !n;
  }

  let original = {};
  async function revert() {
    const p = await backend.revert();
    applyProject(p, { keepUi: false });
    flash('Reverted to the original example');
  }

  // ---- UI state persistence (open tabs, collapsed folders) ----
  let uiKey = '';
  function persistUi() {
    if (!uiKey) return;
    try {
      localStorage.setItem(uiKey, JSON.stringify({ open, active, collapsed: [...collapsed] }));
    } catch {}
  }
  function loadUi() {
    try {
      return JSON.parse(localStorage.getItem(uiKey) || 'null');
    } catch {
      return null;
    }
  }

  function applyProject(p, { keepUi = true } = {}) {
    for (const ed of editors.values()) ed.wrap.remove();
    editors.clear();
    entry = p.entry;
    files = { ...p.files };
    saved = { ...p.files };
    writable = p.writable !== false;
    dirs = new Set();
    included = null;
    error = null;
    const ui = keepUi ? loadUi() : null;
    collapsed = new Set(ui?.collapsed ?? []);
    open = (ui?.open ?? []).filter((x) => files[x] != null);
    active = null;
    title.textContent = projectName;
    renderTree();
    const first = ui?.active && files[ui.active] != null ? ui.active : entry;
    for (const x of open) if (x !== first) openFile(x, { focus: false });
    openFile(first, { focus: false });
    renderFoot();
    onChange?.(project());
    emit('change');
  }

  // External changes (another editor saved a file): take them for files without unsaved edits.
  async function refreshFromDisk() {
    if (backend?.kind !== 'remote') return;
    let p;
    try {
      p = await backend.load();
    } catch {
      return;
    }
    let structure = false;
    for (const [path, src] of Object.entries(p.files)) {
      if (saved[path] === src) continue;
      if (files[path] == null && saved[path] == null) {
        files[path] = src;
        structure = true;
      } else if (files[path] === saved[path]) {
        files[path] = src;
        editors.get(path)?.setValue(src);
      }
      saved[path] = src;
    }
    for (const path of Object.keys(saved)) {
      if (p.files[path] != null) continue;
      if (files[path] === saved[path]) {
        delete files[path];
        if (open.includes(path)) closeFile(path);
        structure = true;
      }
      delete saved[path];
    }
    if (structure) renderTree();
    renderTabs();
    renderFoot();
    onChange?.(project());
    emit('change');
  }

  return {
    events,
    explorerEl: explorer,
    editorColEl: editorCol,
    get name() {
      return projectName;
    },
    get dirtyCount() {
      return backend?.kind === 'remote' ? dirtyPaths().length : 0;
    },
    get error() {
      return error;
    },
    get openPaths() {
      return [...open];
    },
    /** { path, ta, ed } of the active editor, or null. */
    activeEditor() {
      const ed = active && editors.get(active);
      return ed ? { path: active, ta: ed.ta, ed } : null;
    },
    /**
     * Replace a file's whole text (search & replace). An open editor gets it as
     * one undoable edit; other files just change in the buffer.
     */
    applyEdit(path, text) {
      if (files[path] == null || files[path] === text) return;
      const ed = editors.get(path);
      if (ed) {
        const { scrollTop, selectionStart } = ed.ta;
        const focused = document.activeElement;
        replaceRange(ed.ta, 0, ed.ta.value.length, text, Math.min(selectionStart, text.length));
        ed.ta.scrollTop = scrollTop;
        if (focused && focused !== ed.ta) focused.focus({ preventScroll: true });
      } else {
        files[path] = text;
        changed();
      }
    },
    newFile: () => startCreate('file', currentFolder()),
    newFolder: () => startCreate('dir', currentFolder()),
    saveAll: () => saveAll(),
    closeActive: () => active && closeFile(active),
    cycleTab(dir) {
      if (!open.length) return;
      const i = open.indexOf(active);
      openFile(open[(i + dir + open.length) % open.length]);
    },
    collapseAll() {
      for (const d of Object.keys(files).flatMap((p) => p.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/')))) collapsed.add(d);
      for (const d of dirs) collapsed.add(d);
      renderTree();
      persistUi();
    },
    revealActive() {
      if (!active) return;
      selectInTree(active);
      tree.querySelector(`[data-path="${CSS.escape(active)}"]`)?.focus();
    },
    focusTree() {
      (tree.querySelector('[aria-selected="true"]') ?? tree.querySelector('[tabindex="0"]') ?? tree.querySelector('.tree-row'))?.focus();
    },
    revert: () => backend?.kind === 'local' && revert(),
    /** Loads a project through `backend`; `name` is shown in the explorer. */
    async load(b, { name, id, original: orig } = {}) {
      unwatch();
      backend = b;
      projectName = name;
      uiKey = `foar.playground.ui.${id ?? name}`;
      original = orig?.files ?? {};
      const p = await b.load();
      if (p.name && !name) projectName = p.name;
      applyProject(p);
      if (b.watch) unwatch = b.watch(() => refreshFromDisk());
      return p;
    },
    project,
    get entry() {
      return entry;
    },
    get backendKind() {
      return backend?.kind;
    },
    /** After a compile: which files are in the program, and the error (if any). */
    setCompileResult({ files: inProgram, error: err }) {
      if (inProgram) included = new Set(inProgram.map((f) => f.path));
      error = err && err.file ? err : err ? { ...err, file: entry } : null;
      for (const ed of editors.values()) ed.paintError();
      renderTree();
      renderTabs();
      emit('compile', error);
    },
    openFile,
    /** Open the file declaring view `name`. */
    revealDeclaration(name) {
      const d = declarations().get(name);
      if (d) openFile(d.path, { line: d.line });
    },
  };
}
