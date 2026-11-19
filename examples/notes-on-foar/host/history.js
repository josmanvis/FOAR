// Undo/redo for the note editor. Formatting rebuilds the DOM directly, which
// Chrome's own undo stack can't follow, so the editor keeps its own history:
// a snapshot (HTML + selection) before each burst of typing and before every
// formatting command, per note.

const MAX_BYTES = 40_000_000;
const GROUP_MS = 900;
const histories = new Map(); // note id -> { undo, redo, last, lastType, bytes }

function pathTo(ed, node) {
  const path = [];
  while (node && node !== ed) {
    path.unshift([...node.parentNode.childNodes].indexOf(node));
    node = node.parentNode;
  }
  return node === ed ? path : null;
}

function nodeAt(ed, path) {
  let n = ed;
  for (const i of path) {
    n = n?.childNodes[i];
    if (!n) return null;
  }
  return n;
}

function snapshot(ed) {
  const sel = getSelection();
  let range = null;
  if (sel.rangeCount && ed.contains(sel.getRangeAt(0).startContainer)) {
    const r = sel.getRangeAt(0);
    const s = pathTo(ed, r.startContainer);
    const e = pathTo(ed, r.endContainer);
    if (s && e) range = { s, so: r.startOffset, e, eo: r.endOffset };
  }
  return { html: ed.innerHTML, range };
}

function apply(ed, snap) {
  ed.innerHTML = snap.html;
  if (!snap.range) return;
  const s = nodeAt(ed, snap.range.s);
  const e = nodeAt(ed, snap.range.e);
  if (!s || !e) return;
  try {
    const r = document.createRange();
    r.setStart(s, snap.range.so);
    r.setEnd(e, snap.range.eo);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch {
    /* selection no longer fits; leave it */
  }
}

function historyOf(key) {
  let h = histories.get(key);
  if (!h) histories.set(key, (h = { undo: [], redo: [], last: 0, lastType: '', bytes: 0 }));
  return h;
}

function push(h, snap) {
  h.undo.push(snap);
  h.bytes += snap.html.length;
  while (h.undo.length > 1 && (h.bytes > MAX_BYTES || h.undo.length > 300)) h.bytes -= h.undo.shift().html.length;
  h.redo = [];
}

/** Call before the editor changes. `type` groups consecutive typing into one undo step. */
export function record(key, ed, type = 'op') {
  const h = historyOf(key);
  const now = Date.now();
  const grouped = type !== 'op' && type === h.lastType && now - h.last < GROUP_MS;
  h.last = now;
  h.lastType = type;
  if (grouped) return;
  const snap = snapshot(ed);
  if (h.undo.at(-1)?.html === snap.html) return;
  push(h, snap);
}

export function undo(key, ed) {
  const h = historyOf(key);
  const cur = snapshot(ed);
  // Skip snapshots identical to the current content.
  while (h.undo.length && h.undo.at(-1).html === cur.html) h.undo.pop();
  const snap = h.undo.pop();
  if (!snap) return false;
  h.bytes -= snap.html.length;
  h.redo.push(cur);
  h.lastType = '';
  apply(ed, snap);
  return true;
}

export function redo(key, ed) {
  const h = historyOf(key);
  const snap = h.redo.pop();
  if (!snap) return false;
  const cur = snapshot(ed);
  h.undo.push(cur);
  h.bytes += cur.html.length;
  h.lastType = '';
  apply(ed, snap);
  return true;
}
