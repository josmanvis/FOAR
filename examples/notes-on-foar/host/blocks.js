// Line-level formatting (paragraph styles, lists, checklists, indentation,
// alignment, moving lines) that works on every line in the selection.
//
// Chrome's execCommand list/block commands only handle the line the selection
// starts on and nest lists inside paragraphs. Instead, the editor is
// flattened into a list of line records, the records are changed, and the DOM
// is rebuilt from them. Text nodes are moved, never copied, so the selection
// is restored exactly and images are not reloaded.

const LINE_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE']);
const BLOCK_TAGS = new Set([...LINE_TAGS, 'UL', 'OL', 'LI', 'TABLE', 'HR', 'FIGURE', 'SECTION', 'ARTICLE']);
const isBlock = (n) => n.nodeType === 1 && BLOCK_TAGS.has(n.tagName);
const isList = (n) => n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL');
export const MAX_INDENT = 8;

export function listKind(list) {
  if (!list) return null;
  if (list.tagName === 'OL') return 'number';
  if (list.classList.contains('checklist')) return 'check';
  if (list.classList.contains('dashed')) return 'dash';
  return 'bullet';
}

function tagKind(el, quote) {
  const t = el.tagName;
  if (t === 'H1' || t === 'H2' || t === 'H3') return t.toLowerCase();
  if (t === 'H4' || t === 'H5' || t === 'H6') return 'h3';
  if (t === 'PRE') return 'pre';
  if (t === 'BLOCKQUOTE' || quote) return 'blockquote';
  return 'p';
}

// ---- selection that survives moving nodes ---------------------------------------
// A boundary is stored as a text node + offset, or as "before/after this leaf
// element" (an empty <br>, an empty <li>, an <img>).
// Elements replaced by retag(): old -> new, so saved points can follow them.
const replaced = new WeakMap();
const current = (n) => {
  while (replaced.has(n)) n = replaced.get(n);
  return n;
};

function leafPoint(node, offset) {
  for (;;) {
    // An empty text node may be dropped when its line is rebuilt: anchor to the line instead.
    if (node.nodeType === 3) return node.length || !node.parentElement ? { node, offset } : { node: node.parentElement, at: 'in' };
    const kids = node.childNodes;
    if (!kids.length) return { node, at: 'in' };
    if (offset < kids.length) {
      node = kids[offset];
      offset = 0;
    } else {
      node = kids[kids.length - 1];
      if (node.nodeType === 3) return { node, offset: node.length };
      if (!node.childNodes.length) return { node, at: 'after' };
      offset = node.childNodes.length;
    }
  }
}

export function saveSelection(ed) {
  const sel = getSelection();
  if (!sel.rangeCount || !ed.contains(sel.getRangeAt(0).startContainer)) return null;
  const r = sel.getRangeAt(0);
  return { start: leafPoint(r.startContainer, r.startOffset), end: leafPoint(r.endContainer, r.endOffset), collapsed: r.collapsed };
}

function setPoint(range, p, which) {
  const set = which === 'start' ? 'setStart' : 'setEnd';
  if (p.offset !== undefined) range[set](p.node, Math.min(p.offset, p.node.length));
  else if (p.at === 'in' && p.node.nodeName !== 'BR' && p.node.nodeName !== 'IMG') range[set](p.node, 0);
  else if (p.at === 'after') range[set === 'setStart' ? 'setStartAfter' : 'setEndAfter'](p.node);
  else range[set === 'setStart' ? 'setStartBefore' : 'setEndBefore'](p.node);
}

export function restoreSelection(ed, saved) {
  if (!saved) return;
  const start = { ...saved.start, node: current(saved.start.node) };
  const end = { ...saved.end, node: current(saved.end.node) };
  if (!ed.contains(start.node) || !ed.contains(end.node)) return;
  const r = document.createRange();
  try {
    setPoint(r, start, 'start');
    setPoint(r, end, 'end');
  } catch {
    return;
  }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

// ---- flatten / rebuild -----------------------------------------------------------------
/**
 * Editor DOM → [{ kind: 'p'|'h1'|'h2'|'h3'|'pre'|'blockquote'|'li'|'atom', el, list?, depth?, checked? }].
 * Wraps loose inline content in <p> and detaches nested lists from their <li>.
 */
export function flatten(ed) {
  const recs = [];

  const walkList = (list, depth) => {
    const kind = listKind(list);
    for (const item of [...list.childNodes]) {
      if (isList(item)) {
        walkList(item, depth + 1); // <ul><ul> from Chrome's indent
        continue;
      }
      let li = item;
      if (item.nodeType !== 1 || item.tagName !== 'LI') {
        if (item.nodeType !== 1 && !item.textContent.trim()) continue;
        li = document.createElement('li');
        li.appendChild(item);
      }
      const nested = [...li.childNodes].filter(isList);
      for (const n of nested) n.remove();
      // <li><p>text</p></li> → <li>text</li>
      if (li.childNodes.length === 1 && li.firstChild.nodeType === 1 && /^(P|DIV)$/.test(li.firstChild.tagName)) {
        li.firstChild.replaceWith(...li.firstChild.childNodes);
      }
      recs.push({ kind: 'li', el: li, list: kind, depth, checked: li.hasAttribute('data-checked') });
      for (const n of nested) walkList(n, depth + 1);
    }
  };

  const walk = (container, quote) => {
    let run = null;
    const flush = () => {
      if (run) recs.push({ kind: quote ? 'blockquote' : 'p', el: run });
      run = null;
    };
    for (const child of [...container.childNodes]) {
      if (child.nodeType === 8) continue;
      if (!isBlock(child)) {
        if (child.nodeType === 3 && !child.textContent.trim() && !run) continue;
        if (!run) run = document.createElement('p');
        run.appendChild(child);
        continue;
      }
      flush();
      if (isList(child)) walkList(child, 0);
      else if (child.tagName === 'LI') walkList({ childNodes: [child], tagName: 'UL', classList: { contains: () => false } }, 0);
      else if (LINE_TAGS.has(child.tagName)) {
        if ([...child.childNodes].some(isBlock)) walk(child, quote || child.tagName === 'BLOCKQUOTE');
        else recs.push({ kind: tagKind(child, quote), el: child });
      } else recs.push({ kind: 'atom', el: child });
    }
    flush();
  };

  walk(ed, false);
  if (!recs.length) recs.push({ kind: 'p', el: Object.assign(document.createElement('p'), { innerHTML: '<br>' }) });
  return recs;
}

function retag(el, tag) {
  if (el.tagName.toLowerCase() === tag) return el;
  const n = document.createElement(tag);
  for (const a of el.attributes) if (a.name !== 'data-checked' || tag === 'li') n.setAttribute(a.name, a.value);
  n.append(...el.childNodes);
  replaced.set(el, n);
  return n;
}

function materialize(r) {
  let el;
  if (r.kind === 'atom') return r.el;
  if (r.kind === 'li') {
    el = retag(r.el, 'li');
    el.removeAttribute('data-indent');
    el.toggleAttribute('data-checked', r.list === 'check' && !!r.checked);
  } else {
    // A <div> line stays a <div>; anything else takes the record's tag.
    el = r.kind === 'p' && r.el.tagName === 'DIV' ? r.el : retag(r.el, r.kind);
    if (!/^H[1-3]$/.test(el.tagName)) el.removeAttribute('data-collapsed');
  }
  // An empty line needs a <br> to have height and hold the caret.
  if (!el.textContent && !el.querySelector('br, img')) el.replaceChildren(document.createElement('br'));
  r.el = el;
  return el;
}

function makeList(kind) {
  const l = document.createElement(kind === 'number' ? 'ol' : 'ul');
  if (kind === 'check') l.className = 'checklist';
  if (kind === 'dash') l.className = 'dashed';
  return l;
}

export function rebuild(ed, recs) {
  const frag = document.createDocumentFragment();
  const stack = []; // open lists: stack[d] is the list at depth d
  for (const r of recs) {
    if (r.kind !== 'li') {
      stack.length = 0;
      frag.appendChild(materialize(r));
      continue;
    }
    const d = Math.min(Math.max(0, r.depth | 0), stack.length);
    r.depth = d;
    stack.length = Math.min(stack.length, d + 1);
    if (stack.length === d + 1 && stack[d].kind !== r.list) stack.length = d;
    if (stack.length === d) {
      const list = makeList(r.list);
      if (d === 0) frag.appendChild(list);
      else {
        let host = stack[d - 1].el.lastElementChild;
        if (!host) stack[d - 1].el.appendChild((host = document.createElement('li')));
        host.appendChild(list);
      }
      stack.push({ kind: r.list, el: list });
    }
    stack[d].el.appendChild(materialize(r));
  }
  ed.replaceChildren(frag);
}

// ---- which records are selected ------------------------------------------------------------
function recordIndexOf(recs, node) {
  for (let i = 0; i < recs.length; i++) if (recs[i].el === node || recs[i].el.contains(node)) return i;
  return -1;
}

function atRecordStart(rec, p) {
  const r = document.createRange();
  r.setStart(rec.el, 0);
  try {
    setPoint(r, p, 'end');
  } catch {
    return false;
  }
  return r.toString() === '' && !r.cloneContents().querySelector?.('img');
}

function selectedSpan(recs, saved) {
  if (!saved) return [0, 0];
  let si = recordIndexOf(recs, saved.start.node);
  let ei = recordIndexOf(recs, saved.end.node);
  if (si < 0) si = Math.max(0, ei);
  if (ei < 0) ei = si;
  // A triple-click selection ends at the start of the next line: not part of it.
  if (!saved.collapsed && ei > si && atRecordStart(recs[ei], saved.end)) ei--;
  return [si, ei];
}

/** Run `fn(recs, si, ei, ed)` over the editor's lines, then rebuild and keep the selection. */
export function transformLines(ed, fn) {
  const saved = saveSelection(ed);
  const recs = flatten(ed);
  const [si, ei] = selectedSpan(recs, saved);
  const result = fn(recs, si, ei, ed);
  if (!recs.length) recs.push({ kind: 'p', el: document.createElement('p') });
  rebuild(ed, recs);
  restoreSelection(ed, saved);
  return result;
}

// ---- operations on records -------------------------------------------------------------------
const lines = (recs, si, ei) => recs.slice(si, ei + 1).filter((r) => r.kind !== 'atom');

export function setBlock(recs, si, ei, kind) {
  for (const r of lines(recs, si, ei)) {
    r.kind = kind;
    delete r.list;
  }
}

export function toggleQuote(recs, si, ei) {
  const ls = lines(recs, si, ei);
  const all = ls.length && ls.every((r) => r.kind === 'blockquote');
  setBlock(recs, si, ei, all ? 'p' : 'blockquote');
}

export function setList(recs, si, ei, kind) {
  const ls = lines(recs, si, ei);
  if (ls.length && ls.every((r) => r.kind === 'li' && r.list === kind)) {
    for (const r of ls) r.kind = 'p'; // toggle off
    return;
  }
  for (const r of ls) {
    if (r.kind !== 'li') {
      r.kind = 'li';
      r.depth = Math.min(Number(r.el.dataset.indent) || 0, MAX_INDENT);
      r.checked = false;
    }
    r.list = kind;
  }
}

export function indent(recs, si, ei, delta) {
  for (const r of lines(recs, si, ei)) {
    if (r.kind === 'li') r.depth = Math.max(0, Math.min(MAX_INDENT, r.depth + delta));
    else {
      const n = Math.max(0, Math.min(MAX_INDENT, (Number(r.el.dataset.indent) || 0) + delta));
      if (n) r.el.dataset.indent = n;
      else delete r.el.dataset.indent;
    }
  }
}

export function align(recs, si, ei, how) {
  for (const r of lines(recs, si, ei)) {
    r.el.style.textAlign = how === 'left' ? '' : how;
    if (!r.el.getAttribute('style')) r.el.removeAttribute('style');
  }
}

// A list item moves together with its sub-items.
function unitEnd(recs, i) {
  let e = i;
  if (recs[i].kind === 'li') while (recs[e + 1]?.kind === 'li' && recs[e + 1].depth > recs[i].depth) e++;
  return e;
}

export function move(recs, si, ei, dir) {
  ei = unitEnd(recs, ei);
  const block = recs.slice(si, ei + 1);
  if (dir < 0) {
    if (si === 0) return;
    let t = si - 1;
    const d = recs[si].kind === 'li' ? recs[si].depth : -1;
    while (t > 0 && d >= 0 && recs[t].kind === 'li' && recs[t].depth > d && recs[t - 1].kind === 'li') t--;
    recs.splice(si, block.length);
    recs.splice(t, 0, ...block);
  } else {
    if (ei + 1 >= recs.length) return;
    const after = unitEnd(recs, ei + 1);
    recs.splice(si, block.length);
    recs.splice(after - block.length + 1, 0, ...block);
  }
}

// ---- checklists ----------------------------------------------------------------------------------
const isCheck = (r) => r.kind === 'li' && r.list === 'check';

/** The checklist around the caret, or every checklist in the note. */
function checklistScope(recs, si) {
  if (isCheck(recs[si])) {
    let a = si;
    let b = si;
    while (a > 0 && recs[a - 1].kind === 'li' && (recs[a].depth > 0 || recs[a - 1].list === 'check')) a--;
    while (b + 1 < recs.length && recs[b + 1].kind === 'li' && (recs[b + 1].depth > 0 || recs[b + 1].list === 'check')) b++;
    return [a, b];
  }
  return [0, recs.length - 1];
}

export function markChecked(recs, si, ei) {
  const items = recs.slice(si, ei + 1).filter(isCheck);
  const value = items.some((r) => !r.checked);
  for (const r of items) r.checked = value;
}

export function checkAll(recs, si, ei, value) {
  const [a, b] = checklistScope(recs, si);
  for (const r of recs.slice(a, b + 1)) if (isCheck(r)) r.checked = value;
}

function sortUnits(arr) {
  if (!arr.length) return arr;
  const units = [];
  for (let i = 0; i < arr.length; ) {
    const e = unitEnd(arr, i);
    units.push([arr[i], ...sortUnits(arr.slice(i + 1, e + 1))]);
    i = e + 1;
  }
  const done = (u) => isCheck(u[0]) && u[0].checked;
  return [...units.filter((u) => !done(u)), ...units.filter(done)].flat();
}

export function moveCheckedToBottom(recs, si) {
  const [a, b] = checklistScope(recs, si);
  // Sort each run of list items separately so other content stays put.
  for (let i = a; i <= b; ) {
    if (recs[i].kind !== 'li') {
      i++;
      continue;
    }
    let e = i;
    while (e + 1 <= b && recs[e + 1].kind === 'li') e++;
    recs.splice(i, e - i + 1, ...sortUnits(recs.slice(i, e + 1)));
    i = e + 1;
  }
}

export function deleteChecked(recs, si) {
  const [a, b] = checklistScope(recs, si);
  for (let i = b; i >= a; i--) {
    if (isCheck(recs[i]) && recs[i].checked) recs.splice(i, unitEnd(recs, i) - i + 1);
  }
}

/** Table → one paragraph per row. */
export function tableToText(recs, table) {
  const i = recs.findIndex((r) => r.el === table);
  if (i < 0) return;
  const rows = [...table.rows].map((tr) => {
    const p = document.createElement('p');
    [...tr.cells].forEach((cell, j) => {
      if (j) p.append('    ');
      p.append(...cell.childNodes);
    });
    p.querySelectorAll('br').forEach((br) => br.remove());
    return { kind: 'p', el: p };
  });
  recs.splice(i, 1, ...rows);
}

// ---- context for the toolbar --------------------------------------------------------------------
/** "|h2|list|check|table|" style summary of what's at the selection. */
export function contextAt(ed, node) {
  const parts = [];
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  if (!el || !ed.contains(el)) return '||';
  const li = el.closest('li');
  if (li && ed.contains(li)) parts.push('li', listKind(li.parentElement));
  else {
    const line = el.closest('h1, h2, h3, pre, blockquote, p, div');
    parts.push(line && line !== ed && ed.contains(line) ? tagKind(line, false) : 'p');
  }
  if (el.closest('td, th')) parts.push('table');
  if (ed.querySelector('ul.checklist')) parts.push('has-checklist');
  return `|${parts.join('|')}|`;
}

// ---- collapsible sections (click the chevron next to a heading) ---------------------------------
const level = (el) => (/^H[1-3]$/.test(el.tagName) ? Number(el.tagName[1]) : 0);

export function applyFolding(ed) {
  const sel = getSelection();
  const caret = sel.rangeCount && ed.contains(sel.anchorNode) ? sel.anchorNode : null;
  let hideBelow = 0; // hiding everything until a heading of this level or higher
  let owner = null;
  for (const el of ed.children) {
    const lv = level(el);
    if (hideBelow && lv && lv <= hideBelow) hideBelow = 0;
    if (hideBelow) {
      if (caret && el.contains(caret)) {
        // Never hide the line being edited: open its section instead.
        owner.removeAttribute('data-collapsed');
        return applyFolding(ed);
      }
      if (!el.hasAttribute('data-folded')) el.setAttribute('data-folded', '');
      continue;
    }
    if (el.hasAttribute('data-folded')) el.removeAttribute('data-folded');
    if (lv && el.hasAttribute('data-collapsed')) {
      hideBelow = lv;
      owner = el;
    }
  }
}

export function setAllCollapsed(ed, collapsed) {
  for (const h of ed.querySelectorAll(':scope > h1, :scope > h2, :scope > h3')) {
    // Only headings that have something under them can collapse.
    const next = h.nextElementSibling;
    if (collapsed && next && !(level(next) && level(next) <= level(h))) h.setAttribute('data-collapsed', '');
    else h.removeAttribute('data-collapsed');
  }
  applyFolding(ed);
}
