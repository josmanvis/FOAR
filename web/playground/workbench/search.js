// Search: the matcher shared by find-in-file and project search, and the
// project search panel (Ctrl+Shift+F) with replace, include/exclude globs.

/** Builds a global RegExp from the query and options, or { error }. */
export function buildMatcher(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (!query) return null;
  let source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord) source = `(?<![\\w$])(?:${source})(?![\\w$])`;
  try {
    return new RegExp(source, `g${matchCase ? '' : 'i'}m`);
  } catch (e) {
    return { error: e.message.replace(/^Invalid regular expression: /, '') };
  }
}

/** All [start, end] match ranges of `re` in `text` (empty matches skipped). */
export function findAll(re, text, limit = 20000) {
  const out = [];
  if (!re || re.error) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) && out.length < limit) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

/** The replacement for one match (regex mode expands $1, $<name>, $&). */
export function replacementFor(re, matched, replace, regex) {
  if (!regex) return replace;
  const single = new RegExp(re.source, re.flags.replace('g', ''));
  return matched.replace(single, replace);
}

/** Applies a replacement to every range (ranges sorted, non-overlapping). */
export function replaceRanges(text, ranges, re, replace, regex) {
  let out = '';
  let last = 0;
  for (const [a, b] of ranges) {
    out += text.slice(last, a) + replacementFor(re, text.slice(a, b), replace, regex);
    last = b;
  }
  return out + text.slice(last);
}

// "components/**, *.foar" -> matcher; empty -> null
function globMatcher(list) {
  const parts = list
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const res = parts.map((g) => {
    const src = g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/?/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0000/g, '.*');
    // a bare name matches anywhere in the path (like VS Code)
    return new RegExp(g.includes('/') || g.includes('*') ? `^${src}$|^${src}/|/${src}$` : `(^|/)${src}($|/)`, 'i');
  });
  return (path) => res.some((r) => r.test(path));
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

/** A text field with Aa / ab / .* toggles (shared by find bar and project search). */
export function searchField({ placeholder, label, onInput, onKey, options }) {
  const input = h('input', { class: 'sf-input', type: 'text', placeholder, 'aria-label': label, spellcheck: 'false', autocomplete: 'off' });
  const toggle = (key, text, title) =>
    h('button', {
      class: 'sf-toggle',
      type: 'button',
      title,
      'aria-label': title,
      'aria-pressed': String(!!options[key]),
      text,
      onclick: (e) => {
        options[key] = !options[key];
        e.currentTarget.setAttribute('aria-pressed', String(options[key]));
        onInput();
        input.focus();
      },
      onmousedown: (e) => e.preventDefault(),
    });
  input.addEventListener('input', onInput);
  if (onKey) input.addEventListener('keydown', onKey);
  const wrap = h(
    'div',
    { class: 'sf' },
    input,
    toggle('matchCase', 'Aa', 'Match case (Alt+C)'),
    toggle('wholeWord', 'ab', 'Match whole word (Alt+W)'),
    toggle('regex', '.*', 'Use regular expression (Alt+R)')
  );
  input.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = { c: 'matchCase', w: 'wholeWord', r: 'regex' }[e.key.toLowerCase()];
    if (!k) return;
    e.preventDefault();
    wrap.querySelectorAll('.sf-toggle')[['matchCase', 'wholeWord', 'regex'].indexOf(k)].click();
  });
  return { el: wrap, input };
}

/**
 * The project search panel. `ws` is the workspace (project(), openFile(),
 * applyEdit(), events).
 */
export function createSearchPanel(ws) {
  const options = { matchCase: false, wholeWord: false, regex: false };
  let showReplace = false;
  let showFilters = false;
  let results = []; // [{ path, ranges, text }]
  const collapsed = new Set();
  const dismissed = new Set(); // "path:start" of matches hidden by the user
  let re = null;

  const field = searchField({ placeholder: 'Search', label: 'Search in all files', options, onInput: () => schedule(), onKey: (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run();
      list.querySelector('.sr-match')?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list.querySelector('.sr-row')?.focus();
    }
  } });
  const replaceInput = h('input', { class: 'sf-input', type: 'text', placeholder: 'Replace', 'aria-label': 'Replace with', spellcheck: 'false', oninput: () => render(), onkeydown: (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.altKey) {
      e.preventDefault();
      askReplaceAll();
    }
  } });
  const replaceAllBtn = h('button', { class: 'sf-action', type: 'button', title: 'Replace all (Ctrl+Alt+Enter)', 'aria-label': 'Replace all', text: '⇄', onclick: () => askReplaceAll() });
  const replaceRow = h('div', { class: 'sr-replace hidden' }, h('div', { class: 'sf' }, replaceInput), replaceAllBtn);
  const toggleReplace = h('button', {
    class: 'sr-expand',
    type: 'button',
    'aria-label': 'Toggle replace',
    title: 'Toggle replace (Ctrl+Shift+H)',
    'aria-expanded': 'false',
    onclick: () => setReplace(!showReplace),
  }, '›');
  const include = h('input', { class: 'sf-input plain', placeholder: 'e.g. components/**, *.foar', 'aria-label': 'Files to include', oninput: () => schedule() });
  const exclude = h('input', { class: 'sf-input plain', placeholder: 'e.g. styles/**', 'aria-label': 'Files to exclude', oninput: () => schedule() });
  const filters = h('div', { class: 'sr-filters hidden' }, h('label', { text: 'files to include' }), include, h('label', { text: 'files to exclude' }), exclude);
  const filtersBtn = h('button', { class: 'icon-btn small', type: 'button', title: 'Toggle search details', 'aria-label': 'Toggle search details', 'aria-pressed': 'false', text: '⋯', onclick: () => {
    showFilters = !showFilters;
    filters.classList.toggle('hidden', !showFilters);
    filtersBtn.setAttribute('aria-pressed', String(showFilters));
    if (showFilters) include.focus();
  } });
  const summary = h('div', { class: 'sr-summary', 'aria-live': 'polite' });
  const list = h('div', { class: 'sr-list', role: 'tree', 'aria-label': 'Search results' });
  const confirm = h('div', { class: 'sr-confirm hidden', role: 'alertdialog', 'aria-label': 'Replace all' });
  const collapseBtn = h('button', { class: 'icon-btn small', type: 'button', title: 'Collapse all', 'aria-label': 'Collapse all results', text: '⊟', onclick: () => {
    const all = results.every((r) => collapsed.has(r.path));
    for (const r of results) all ? collapsed.delete(r.path) : collapsed.add(r.path);
    render();
  } });
  const clearBtn = h('button', { class: 'icon-btn small', type: 'button', title: 'Clear search', 'aria-label': 'Clear search results', text: '✕', onclick: () => {
    field.input.value = '';
    replaceInput.value = '';
    dismissed.clear();
    run();
    field.input.focus();
  } });

  const el = h(
    'section',
    { class: 'search-panel', 'aria-label': 'Search' },
    h('div', { class: 'explorer-head' }, h('span', { class: 'explorer-title', text: 'Search' }), h('span', { class: 'spacer' }), collapseBtn, clearBtn),
    h('div', { class: 'sr-form' }, toggleReplace, h('div', { class: 'sr-fields' }, h('div', { class: 'sr-findrow' }, field.el, filtersBtn), replaceRow)),
    filters,
    summary,
    confirm,
    list
  );

  function setReplace(on) {
    showReplace = on;
    replaceRow.classList.toggle('hidden', !on);
    toggleReplace.setAttribute('aria-expanded', String(on));
    toggleReplace.classList.toggle('open', on);
    render();
  }

  let timer = 0;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  }

  function run() {
    const q = field.input.value;
    re = buildMatcher(q, options);
    field.el.classList.toggle('invalid', !!re?.error);
    results = [];
    if (re && !re.error) {
      const inc = globMatcher(include.value);
      const exc = globMatcher(exclude.value);
      const { files } = ws.project();
      for (const path of Object.keys(files).sort((a, b) => a.localeCompare(b))) {
        if (inc && !inc(path)) continue;
        if (exc && exc(path)) continue;
        const text = files[path];
        const ranges = findAll(re, text, 2000).filter(([a]) => !dismissed.has(`${path}:${a}`));
        if (ranges.length) results.push({ path, ranges, text });
      }
    }
    render();
  }

  function lineInfo(text, a, b) {
    const ls = text.lastIndexOf('\n', a - 1) + 1;
    let le = text.indexOf('\n', a);
    if (le < 0) le = text.length;
    return { line: text.slice(0, ls).split('\n').length, ls, le, b: Math.min(b, le) };
  }

  function render() {
    const focusKey = document.activeElement?.closest?.('.sr-row')?.dataset.key;
    list.textContent = '';
    const total = results.reduce((n, r) => n + r.ranges.length, 0);
    if (re?.error) summary.textContent = re.error;
    else if (!field.input.value) summary.textContent = '';
    else summary.textContent = total ? `${total} result${total === 1 ? '' : 's'} in ${results.length} file${results.length === 1 ? '' : 's'}` : 'No results found.';
    replaceAllBtn.disabled = !total;
    const repl = replaceInput.value;
    for (const r of results) {
      const name = r.path.split('/').pop();
      const dir = r.path.split('/').slice(0, -1).join('/');
      const open = !collapsed.has(r.path);
      const fileRow = h(
        'div',
        { class: 'sr-row sr-file', role: 'treeitem', 'aria-expanded': String(open), 'aria-level': '1', tabindex: '-1', dataset: { key: r.path } },
        h('span', { class: `chev${open ? ' open' : ''}`, text: '›' }),
        h('span', { class: 'sr-name', text: name }),
        h('span', { class: 'sr-dir', text: dir }),
        h('span', { class: 'sr-count', text: String(r.ranges.length) }),
        showReplace ? h('button', { class: 'sr-act', type: 'button', title: 'Replace all in file', 'aria-label': `Replace all in ${r.path}`, text: '⇄', onclick: (e) => {
          e.stopPropagation();
          replaceIn(r.path, r.ranges);
        } }) : null,
        h('button', { class: 'sr-act', type: 'button', title: 'Dismiss', 'aria-label': `Dismiss ${r.path}`, text: '✕', onclick: (e) => {
          e.stopPropagation();
          for (const [a] of r.ranges) dismissed.add(`${r.path}:${a}`);
          run();
        } })
      );
      fileRow.addEventListener('click', () => {
        open ? collapsed.add(r.path) : collapsed.delete(r.path);
        render();
        list.querySelector(`[data-key="${CSS.escape(r.path)}"]`)?.focus();
      });
      list.append(fileRow);
      if (!open) continue;
      for (const [a, b] of r.ranges) {
        const { line, ls, le, b: be } = lineInfo(r.text, a, b);
        // keep the match visible: trim long prefixes
        const startCtx = Math.max(ls, a - 28);
        const before = (startCtx > ls ? '…' : '') + r.text.slice(startCtx, a).replace(/^\s+/, '');
        const matched = r.text.slice(a, be);
        const after = r.text.slice(be, Math.min(le, be + 80));
        const key = `${r.path}:${a}`;
        const row = h('div', {
          class: 'sr-row sr-match',
          role: 'treeitem',
          'aria-level': '2',
          tabindex: '-1',
          title: `${r.path}:${line}`,
          dataset: { key },
        });
        const replaced = showReplace ? replacementFor(re, r.text.slice(a, b), repl, options.regex) : null;
        row.innerHTML = `<span class="sr-line">${esc(before)}${
          showReplace ? `<del>${esc(matched)}</del><ins>${esc(replaced)}</ins>` : `<mark>${esc(matched)}</mark>`
        }${esc(after)}</span>`;
        if (showReplace) row.append(h('button', { class: 'sr-act', type: 'button', title: 'Replace', 'aria-label': `Replace in ${r.path} line ${line}`, text: '⇄', onclick: (e) => {
          e.stopPropagation();
          replaceIn(r.path, [[a, b]]);
        } }));
        row.append(h('button', { class: 'sr-act', type: 'button', title: 'Dismiss', 'aria-label': 'Dismiss', text: '✕', onclick: (e) => {
          e.stopPropagation();
          dismissed.add(key);
          run();
        } }));
        row.addEventListener('click', () => ws.openFile(r.path, { select: [a, b], focus: false }));
        row.addEventListener('dblclick', () => ws.openFile(r.path, { select: [a, b] }));
        list.append(row);
      }
    }
    const first = list.querySelector('.sr-row');
    if (first) first.tabIndex = 0;
    if (focusKey) list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  list.addEventListener('keydown', (e) => {
    const row = e.target.closest('.sr-row');
    if (!row) return;
    const rows = [...list.querySelectorAll('.sr-row')];
    const i = rows.indexOf(row);
    const go = (r) => r && (r.focus(), r.scrollIntoView({ block: 'nearest' }));
    if (e.key === 'ArrowDown') go(rows[i + 1]);
    else if (e.key === 'ArrowUp') i === 0 ? field.input.focus() : go(rows[i - 1]);
    else if (e.key === 'Enter') {
      if (row.classList.contains('sr-match')) {
        const [path, a] = [row.dataset.key.slice(0, row.dataset.key.lastIndexOf(':')), +row.dataset.key.slice(row.dataset.key.lastIndexOf(':') + 1)];
        const r = results.find((x) => x.path === path);
        const range = r?.ranges.find(([x]) => x === a);
        if (range) ws.openFile(path, { select: range, focus: !e.altKey });
        if (e.altKey) go(rows[i + 1]);
      } else row.click();
    } else if (e.key === 'ArrowLeft' && row.classList.contains('sr-file') && row.getAttribute('aria-expanded') === 'true') row.click();
    else if (e.key === 'ArrowRight' && row.classList.contains('sr-file') && row.getAttribute('aria-expanded') === 'false') row.click();
    else if (e.key === 'Delete') row.querySelector('.sr-act:last-child')?.click();
    else return;
    e.preventDefault();
  });
  list.addEventListener('focusin', (e) => {
    for (const r of list.querySelectorAll('.sr-row[tabindex="0"]')) r.tabIndex = -1;
    const row = e.target.closest('.sr-row');
    if (row) row.tabIndex = 0;
  });

  function replaceIn(path, ranges) {
    if (!re || re.error) return;
    const { files } = ws.project();
    const text = files[path];
    // re-validate: the file may have changed since the search ran
    const fresh = findAll(re, text);
    const keep = ranges.filter(([a, b]) => fresh.some(([x, y]) => x === a && y === b));
    if (!keep.length) return run();
    ws.applyEdit(path, replaceRanges(text, keep, re, replaceInput.value, options.regex));
    run();
  }

  function askReplaceAll() {
    if (!re || re.error || !results.length) return;
    const total = results.reduce((n, r) => n + r.ranges.length, 0);
    confirm.textContent = '';
    const cancel = () => {
      confirm.classList.add('hidden');
      replaceInput.focus();
    };
    confirm.append(
      h('div', { text: `Replace ${total} occurrence${total === 1 ? '' : 's'} across ${results.length} file${results.length === 1 ? '' : 's'} with “${replaceInput.value}”?` }),
      h('div', { class: 'ws-confirm-actions' },
        h('button', { type: 'button', class: 'btn-tiny', text: 'Cancel', onclick: cancel }),
        h('button', { type: 'button', class: 'btn-tiny primary', text: 'Replace', onclick: () => {
          confirm.classList.add('hidden');
          for (const r of [...results]) replaceIn(r.path, r.ranges);
          summary.textContent = `Replaced ${total} occurrence${total === 1 ? '' : 's'}.`;
          replaceInput.focus();
        } }))
    );
    confirm.classList.remove('hidden');
    confirm.addEventListener('keydown', (e) => e.key === 'Escape' && cancel(), { once: true });
    confirm.querySelector('.primary').focus();
  }

  // Keep results current while files change (typing in an editor, saves from disk).
  ws.events.addEventListener('change', () => {
    if (el.isConnected && el.offsetParent !== null && field.input.value) schedule();
  });

  return {
    el,
    /** Focus the query (prefilled with `text` when given). */
    focus({ text, replace } = {}) {
      if (text) field.input.value = text;
      if (replace != null) setReplace(replace);
      run();
      (replace ? replaceInput : field.input).focus();
      (replace ? replaceInput : field.input).select();
    },
    refresh: run,
  };
}
