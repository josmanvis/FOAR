// Rich-text behaviour for FOAR's RichText element: formatting commands
// (called from app.foar as `fmt(cmd, arg)`), checklists, tables, links,
// colors, images, paste/drop, collapsible sections, undo and shortcuts.
// Line-level formatting lives in blocks.js, undo in history.js.

import * as blocks from './blocks.js';
import * as history from './history.js';

let app = null;
let savedRange = null; // last selection inside an editor
let linkRange = null; // selection captured when the link popover opened
let copiedStyle = null; // Copy Style / Paste Style

const editorOf = (node) => {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return el?.closest?.('.f4-richtext') ?? null;
};
const activeEditor = () =>
  editorOf(document.activeElement) || (savedRange && editorOf(savedRange.startContainer)) || document.querySelector('.f4-richtext[contenteditable="true"]');
const fireInput = (ed) => ed?.dispatchEvent(new Event('input', { bubbles: true }));
// Marks a message key that is translated later, when the toast renders (see foar i18n).
const t_key = (key) => key;
const noteKey = () => app?.getContext('Browse')?.selected ?? '';
const checkpoint = (ed) => history.record(noteKey(), ed, 'op');

function restore(range) {
  const ed = range ? editorOf(range.startContainer) : activeEditor();
  if (!ed || !ed.isConnected || ed.contentEditable !== 'true') return null;
  ed.focus({ preventScroll: true });
  if (range && ed.contains(range.startContainer)) {
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return ed;
}

const exec = (cmd, arg = null) => document.execCommand(cmd, false, arg);

function selectionElement() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const n = sel.getRangeAt(0).startContainer;
  return n.nodeType === 1 ? n : n.parentElement;
}

function caretIn(node, atEnd = false) {
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(!atEnd);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Line-level change: undo checkpoint, transform, refold, save. */
function lineOp(ed, fn) {
  checkpoint(ed);
  blocks.transformLines(ed, fn);
  blocks.applyFolding(ed);
  rememberSelection();
  fireInput(ed);
}

// selectionchange arrives asynchronously; commands that run right after
// another (Aa popover checkmarks) need the selection now.
function rememberSelection() {
  const sel = getSelection();
  if (sel.rangeCount && editorOf(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function normalizeUrl(url) {
  const u = url.trim();
  if (!u) return '';
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(u)) return `mailto:${u}`;
  return `https://${u}`;
}

function anchorAt(range) {
  if (!range) return null;
  const el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  return el?.closest('a') ?? null;
}

// ---- inline styles -------------------------------------------------------------------
const MARK = { color: 'rgb(1, 2, 3)', backgroundColor: 'rgb(1, 2, 4)' };

function unwrapIfBare(el) {
  if (el.tagName === 'SPAN' && !el.attributes.length) el.replaceWith(...el.childNodes);
}

/** Text color / highlight; an empty color removes it. */
function paint(ed, prop, color) {
  const cmd = prop === 'color' ? 'foreColor' : 'hiliteColor';
  const saved = blocks.saveSelection(ed);
  exec('styleWithCSS', true);
  exec(cmd, color || MARK[prop]);
  exec('styleWithCSS', false);
  // Whatever was selected now has one color: drop older nested ones.
  const marked = [...ed.querySelectorAll('[style]')].filter((el) => el.style[prop] === (color ? el.style[prop] : MARK[prop]));
  for (const el of ed.querySelectorAll('font[color]')) {
    if (prop === 'color') {
      const s = document.createElement('span');
      s.style.color = el.getAttribute('color');
      s.append(...el.childNodes);
      el.replaceWith(s);
    }
  }
  if (!color) {
    for (const el of marked) {
      for (const inner of el.querySelectorAll('[style]')) {
        inner.style.removeProperty(prop === 'color' ? 'color' : 'background-color');
        if (!inner.getAttribute('style')) inner.removeAttribute('style');
        unwrapIfBare(inner);
      }
      el.style.removeProperty(prop === 'color' ? 'color' : 'background-color');
      if (!el.getAttribute('style')) el.removeAttribute('style');
      unwrapIfBare(el);
    }
  }
  blocks.restoreSelection(ed, saved);
}

/** Format ▸ Font ▸ Bigger / Smaller. */
function resize(ed, step) {
  if (getSelection().isCollapsed) return;
  const cur = parseFloat(getComputedStyle(selectionElement()).fontSize) || 15;
  const next = Math.max(10, Math.min(48, Math.round(cur + step * 2)));
  const saved = blocks.saveSelection(ed);
  exec('styleWithCSS', false);
  exec('fontSize', '7');
  for (const f of ed.querySelectorAll('font[size="7"]')) {
    const s = document.createElement('span');
    s.style.fontSize = `${next}px`;
    s.append(...f.childNodes);
    for (const inner of s.querySelectorAll('[style*="font-size"]')) {
      inner.style.removeProperty('font-size');
      if (!inner.getAttribute('style')) inner.removeAttribute('style');
      unwrapIfBare(inner);
    }
    f.replaceWith(s);
  }
  blocks.restoreSelection(ed, saved);
}

function styledAncestor(prop) {
  for (let el = selectionElement(); el && !el.classList?.contains('f4-richtext'); el = el.parentElement) {
    if (el.style?.[prop]) return el.style[prop];
  }
  return '';
}

function copyStyle(ed) {
  const ctx = blocks.contextAt(ed, getSelection().anchorNode).split('|').filter(Boolean);
  copiedStyle = {
    line: ctx[0] === 'li' ? { list: ctx[1] } : { block: ctx[0] },
    inline: Object.fromEntries(['bold', 'italic', 'underline', 'strikeThrough'].map((c) => [c, document.queryCommandState(c)])),
    color: styledAncestor('color'),
    highlight: styledAncestor('backgroundColor'),
  };
}

function pasteStyle(ed) {
  if (!copiedStyle) return;
  const { line, inline, color, highlight } = copiedStyle;
  lineOp(ed, (recs, si, ei) => {
    for (const r of recs.slice(si, ei + 1)) {
      if (r.kind === 'atom') continue;
      if (line.list) {
        if (r.kind !== 'li') r.depth = 0;
        r.kind = 'li';
        r.list = line.list;
      } else r.kind = line.block;
    }
  });
  if (!getSelection().isCollapsed) {
    for (const [c, on] of Object.entries(inline)) if (document.queryCommandState(c) !== on) exec(c);
    paint(ed, 'color', color);
    paint(ed, 'backgroundColor', highlight);
  }
  fireInput(ed);
}

// ---- tables --------------------------------------------------------------------------
const TABLE =
  '<table data-new=""><tbody>' +
  '<tr><th><br></th><th><br></th><th><br></th></tr>' +
  '<tr><td><br></td><td><br></td><td><br></td></tr>' +
  '<tr><td><br></td><td><br></td><td><br></td></tr>' +
  '</tbody></table><p><br></p>';

function newCell(tag) {
  const c = document.createElement(tag);
  c.innerHTML = '<br>';
  return c;
}

function insertTable(ed) {
  checkpoint(ed);
  exec('insertHTML', TABLE);
  const table = ed.querySelector('table[data-new]');
  if (table) {
    table.removeAttribute('data-new');
    caretIn(table.querySelector('th, td'));
    fireInput(ed);
  }
}

function tableOp(ed, op) {
  const cell = selectionElement()?.closest('td, th');
  if (!cell || !ed.contains(cell)) return;
  const table = cell.closest('table');
  const row = cell.parentElement;
  const col = cell.cellIndex;
  if (op === 'to-text') {
    lineOp(ed, (recs) => blocks.tableToText(recs, table));
    return;
  }
  checkpoint(ed);
  let focus = cell;
  const removeTable = () => {
    const p = document.createElement('p');
    p.innerHTML = '<br>';
    table.replaceWith(p);
    focus = p;
  };
  switch (op) {
    case 'row-above':
    case 'row-below': {
      const tr = document.createElement('tr');
      for (let i = 0; i < row.cells.length; i++) tr.appendChild(newCell('td'));
      if (op === 'row-above') row.before(tr);
      else row.after(tr);
      focus = tr.cells[col];
      break;
    }
    case 'col-before':
    case 'col-after':
      for (const tr of table.rows) {
        const ref = tr.cells[Math.min(col, tr.cells.length - 1)];
        const c = newCell(ref?.tagName === 'TH' ? 'th' : 'td');
        if (!ref) tr.appendChild(c);
        else if (op === 'col-before') ref.before(c);
        else ref.after(c);
      }
      focus = row.cells[op === 'col-before' ? col : col + 1];
      break;
    case 'delete-row': {
      if (table.rows.length === 1) {
        removeTable();
        break;
      }
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      focus = next.cells[Math.min(col, next.cells.length - 1)];
      break;
    }
    case 'delete-col':
      if (row.cells.length === 1) {
        removeTable();
        break;
      }
      for (const tr of [...table.rows]) tr.cells[col]?.remove();
      focus = row.cells[Math.min(col, row.cells.length - 1)];
      break;
    case 'delete-table':
      removeTable();
      break;
  }
  if (focus) caretIn(focus, true);
  fireInput(ed);
}

function moveInTable(cell, back) {
  const cells = [...cell.closest('table').querySelectorAll('td, th')];
  let i = cells.indexOf(cell) + (back ? -1 : 1);
  if (i < 0) return;
  if (i >= cells.length) {
    const ed = editorOf(cell);
    checkpoint(ed);
    const lastRow = cell.closest('tr');
    const row = document.createElement('tr');
    for (let c = 0; c < lastRow.children.length; c++) row.appendChild(newCell('td'));
    lastRow.after(row);
    fireInput(ed);
    i = cells.length;
  }
  caretIn(cell.closest('table').querySelectorAll('td, th')[i], true);
}

// ---- the fmt() entry point ---------------------------------------------------------------
const BLOCK_KINDS = new Set(['p', 'h1', 'h2', 'h3', 'pre']);

/**
 * Entry point for `fmt(cmd, arg)` in app.foar. `cmd` may carry its argument
 * as "cmd:arg". Returns a string (the link target, or the selection context).
 */
export function fmt(cmd, arg = '') {
  if (cmd.includes(':') && !arg) [cmd, arg] = cmd.split(':');
  // The live selection wins when it's in an editor: selectionchange is async
  // and a fast shortcut can arrive before it.
  rememberSelection();

  if (cmd === 'link-target') {
    linkRange = savedRange ? savedRange.cloneRange() : null;
    return anchorAt(linkRange)?.getAttribute('href') ?? '';
  }
  if (cmd === 'restore-selection') {
    restore(linkRange);
    return '';
  }
  if (cmd === 'attach') {
    pickImages();
    return '';
  }
  if (cmd === 'context') {
    const ed = savedRange && editorOf(savedRange.startContainer);
    return ed ? blocks.contextAt(ed, savedRange.startContainer) + (copiedStyle ? 'can-paste-style|' : '') : '||';
  }

  if (cmd === 'ask-link') {
    const fb = instanceOf('FormatBar');
    if (fb) queueMicrotask(() => app.invokeEffect(fb.key, 'AskLink', true));
    return '';
  }
  if (cmd === 'copy') {
    // Copying works in read-only notes too.
    const ed = savedRange && editorOf(savedRange.startContainer);
    if (ed) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
      exec('copy');
    }
    return '';
  }

  const ed = restore(cmd === 'link' || cmd === 'unlink' ? linkRange : savedRange);
  if (!ed) return '';

  switch (cmd) {
    case 'bold':
    case 'italic':
    case 'underline':
    case 'strikeThrough':
    case 'superscript':
    case 'subscript':
      checkpoint(ed);
      exec(cmd);
      break;
    case 'cut':
      checkpoint(ed);
      exec('cut');
      break;
    case 'paste':
      pasteFromMenu(ed);
      break;
    case 'bigger':
    case 'smaller':
      checkpoint(ed);
      resize(ed, cmd === 'bigger' ? 1 : -1);
      fireInput(ed);
      break;
    case 'block':
      if (arg === 'blockquote') lineOp(ed, blocks.toggleQuote);
      else if (BLOCK_KINDS.has(arg)) lineOp(ed, (r, s, e) => blocks.setBlock(r, s, e, arg));
      break;
    case 'quote':
      lineOp(ed, blocks.toggleQuote);
      break;
    case 'list':
      lineOp(ed, (r, s, e) => blocks.setList(r, s, e, arg));
      break;
    case 'checklist':
      lineOp(ed, (r, s, e) => blocks.setList(r, s, e, 'check'));
      break;
    case 'indent':
    case 'outdent':
      lineOp(ed, (r, s, e) => blocks.indent(r, s, e, cmd === 'indent' ? 1 : -1));
      break;
    case 'align':
      lineOp(ed, (r, s, e) => blocks.align(r, s, e, arg));
      break;
    case 'move-up':
    case 'move-down':
      lineOp(ed, (r, s, e) => blocks.move(r, s, e, cmd === 'move-up' ? -1 : 1));
      selectionElement()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      break;
    case 'mark-checked':
      lineOp(ed, blocks.markChecked);
      break;
    case 'check-all':
    case 'uncheck-all':
      lineOp(ed, (r, s, e) => blocks.checkAll(r, s, e, cmd === 'check-all'));
      break;
    case 'checked-to-bottom':
      lineOp(ed, blocks.moveCheckedToBottom);
      break;
    case 'delete-checked':
      lineOp(ed, blocks.deleteChecked);
      break;
    case 'collapse-all':
    case 'expand-all':
      if (cmd === 'collapse-all') caretIn(ed.firstElementChild || ed);
      blocks.setAllCollapsed(ed, cmd === 'collapse-all');
      fireInput(ed);
      break;
    case 'copy-style':
      copyStyle(ed);
      break;
    case 'paste-style':
      pasteStyle(ed);
      break;
    case 'table':
      insertTable(ed);
      break;
    case 'table-op':
      tableOp(ed, arg);
      break;
    case 'highlight':
      checkpoint(ed);
      paint(ed, 'backgroundColor', arg);
      fireInput(ed);
      break;
    case 'color':
      checkpoint(ed);
      paint(ed, 'color', arg);
      fireInput(ed);
      break;
    case 'link': {
      const url = normalizeUrl(arg || '');
      if (!url) break;
      checkpoint(ed);
      const existing = anchorAt(linkRange);
      if (existing) {
        existing.setAttribute('href', url);
        fireInput(ed);
      } else if (getSelection().isCollapsed) {
        exec('insertHTML', `<a href="${escapeHtml(url)}">${escapeHtml(arg.trim())}</a>&nbsp;`);
      } else {
        exec('createLink', url);
      }
      break;
    }
    case 'unlink': {
      checkpoint(ed);
      const a = anchorAt(linkRange);
      if (a) {
        const r = document.createRange();
        r.selectNodeContents(a);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      exec('unlink');
      break;
    }
  }
  return '';
}

// Paste from the context menu needs the async clipboard API (Chrome asks for permission once).
async function pasteFromMenu(ed) {
  const range = savedRange?.cloneRange();
  try {
    let html = '';
    let text = '';
    if (navigator.clipboard.read) {
      for (const item of await navigator.clipboard.read()) {
        const img = item.types.find((t) => t.startsWith('image/'));
        if (img) {
          const blob = await item.getType(img);
          return insertImages([new File([blob], 'pasted', { type: img })], range);
        }
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        else if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    } else text = await navigator.clipboard.readText();
    if (!restore(range)) return;
    checkpoint(ed);
    if (html) exec('insertHTML', sanitize(html));
    else if (text) exec('insertText', text);
  } catch {
    notify(t_key('toast.pasteBlocked'));
  }
}

/** A toast without Undo (host-side messages): a message key, translated when shown. */
export function notify(key, params = null) {
  if (!app) return;
  app.call('Toasts.Show', key, params, null);
}

// ---- images -------------------------------------------------------------------
const MAX_SIDE = 1600;

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function imageToDataURL(file) {
  const original = await readAsDataURL(file);
  if (file.type === 'image/gif' || file.type === 'image/svg+xml' || file.size < 250_000) return original;
  const img = new Image();
  img.src = original;
  await img.decode();
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.86);
}

async function insertImages(files, range) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) return;
  const html = (await Promise.all(images.map(imageToDataURL))).map((src) => `<img src="${src}" alt="">`).join('');
  const ed = restore(range);
  if (!ed) return;
  checkpoint(ed);
  exec('insertHTML', `${html}<p><br></p>`);
}

function pickImages() {
  const range = savedRange ? savedRange.cloneRange() : null;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => insertImages(input.files, range);
  input.click();
}

// ---- paste sanitizing ---------------------------------------------------------------
const ALLOWED = new Set(['P', 'DIV', 'BR', 'H1', 'H2', 'H3', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'A', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'PRE', 'CODE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'IMG', 'SPAN', 'SUP', 'SUB']);
const RENAME = { H4: 'H3', H5: 'H3', H6: 'H3' };
const LINE_TAG = /^(P|DIV|H[1-3]|LI|BLOCKQUOTE|PRE)$/;

function sanitize(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 8) {
        child.remove();
        continue;
      }
      if (child.nodeType !== 1) continue;
      let el = child;
      if (RENAME[el.tagName]) {
        const r = document.createElement(RENAME[el.tagName]);
        r.append(...el.childNodes);
        el.replaceWith(r);
        el = r;
      }
      if (!ALLOWED.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'IFRAME', 'OBJECT'].includes(el.tagName)) el.remove();
        else {
          walk(el);
          el.replaceWith(...el.childNodes);
        }
        continue;
      }
      // Styles worth keeping: colors and sizes on spans, alignment on lines.
      const keepStyle = {};
      if (el.tagName === 'SPAN') {
        for (const p of ['color', 'backgroundColor', 'fontSize']) if (el.style[p] && el.style[p] !== 'transparent') keepStyle[p] = el.style[p];
      } else if (LINE_TAG.test(el.tagName) && /^(center|right|justify)$/.test(el.style.textAlign)) keepStyle.textAlign = el.style.textAlign;
      for (const attr of [...el.attributes]) {
        const keep =
          (el.tagName === 'A' && attr.name === 'href' && /^(https?:|mailto:|tel:)/i.test(attr.value)) ||
          (el.tagName === 'IMG' && attr.name === 'src' && /^(data:image\/|https:)/i.test(attr.value)) ||
          (/^T[DH]$/.test(el.tagName) && /^(colspan|rowspan)$/.test(attr.name)) ||
          (el.tagName === 'UL' && attr.name === 'class') ||
          (el.tagName === 'LI' && attr.name === 'data-checked') ||
          (/^H[1-3]$/.test(el.tagName) && attr.name === 'data-collapsed') ||
          (LINE_TAG.test(el.tagName) && attr.name === 'data-indent' && /^[1-8]$/.test(attr.value));
        if (!keep) el.removeAttribute(attr.name);
      }
      Object.assign(el.style, keepStyle);
      if (el.tagName === 'UL' && el.className) el.className = [...el.classList].filter((c) => c === 'checklist' || c === 'dashed').join(' ');
      if (el.tagName === 'SPAN' && !el.attributes.length) {
        walk(el);
        el.replaceWith(...el.childNodes);
        continue;
      }
      walk(el);
    }
  };
  walk(t.content);
  const div = document.createElement('div');
  div.append(t.content);
  return div.innerHTML;
}

// ---- auto-formatting: "- ", "* ", "1. " at the start of a line start a list -------------------
const AUTO_LIST = { '-': 'dash', '–': 'dash', '*': 'bullet', '•': 'bullet', '1.': 'number', '1)': 'number' };

function autoList(ed) {
  const sel = getSelection();
  if (!sel.isCollapsed || sel.anchorNode?.nodeType !== 3) return;
  const line = sel.anchorNode.parentElement.closest('p, div, h1, h2, h3, blockquote');
  if (!line || line === ed || !ed.contains(line) || line.closest('li, pre, td, th')) return;
  const before = document.createRange();
  before.setStart(line, 0);
  before.setEnd(sel.anchorNode, sel.anchorOffset);
  const m = /^(\S{1,2})[  ]$/.exec(before.toString());
  const kind = m && AUTO_LIST[m[1]];
  if (!kind) return;
  checkpoint(ed); // undo brings back the typed "- "
  before.deleteContents();
  blocks.transformLines(ed, (recs, si) => blocks.setList(recs, si, si, kind));
  rememberSelection();
  fireInput(ed);
}

// ---- collapsible sections ------------------------------------------------------------------
function headingAtGutter(ed, e) {
  for (const h of ed.querySelectorAll(':scope > h1, :scope > h2, :scope > h3')) {
    const r = h.getBoundingClientRect();
    if (e.clientY >= r.top && e.clientY <= r.bottom && e.clientX < r.left && e.clientX > r.left - 32) return h;
  }
  return null;
}

function toggleSection(ed, h) {
  const collapsing = !h.hasAttribute('data-collapsed');
  if (collapsing) {
    const next = h.nextElementSibling;
    if (!next) return;
    caretIn(h, true); // keep the caret out of the section being hidden
  }
  h.toggleAttribute('data-collapsed', collapsing);
  blocks.applyFolding(ed);
  fireInput(ed);
}

const pendingFold = new Set();
function scheduleFold(ed) {
  if (pendingFold.has(ed)) return;
  pendingFold.add(ed);
  queueMicrotask(() => {
    pendingFold.delete(ed);
    if (ed.isConnected) blocks.applyFolding(ed);
  });
}

// ---- wiring ---------------------------------------------------------------------------
const POPUP_STATES = new Set(['Menu', 'Options', 'ConfirmEmpty', 'ConfirmDelete', 'Styles', 'Colors', 'Linking', 'Table', 'Showing']);

/** Close open menus/popovers, except those of the views the click landed in
 *  (their own buttons toggle them; closing first would re-render the button
 *  under the pointer and swallow the click). */
function dismissPopups(target) {
  const inside = new Set();
  if (target?.closest?.('button')) {
    for (let el = target.closest('[data-key]'); el; el = el.parentElement?.closest('[data-key]')) inside.add(el.dataset.key);
  }
  for (const inst of app.getSnapshot()) {
    if (inside.has(inst.key)) continue;
    if (inst.stores.menu === true || inst.stores.edit_at || POPUP_STATES.has(inst.state)) app.invokeEffect(inst.key, 'Dismiss');
  }
}

const instanceOf = (viewName) => app.getSnapshot().find((i) => i.viewName === viewName);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

let editorCleanup = null;

export function installEditor(foarApp, mountEl = document.body) {
  app = foarApp;
  if (editorCleanup) editorCleanup();
  const ac = new AbortController();
  const { signal } = ac;
  const on = (type, fn, capture = false) => document.addEventListener(type, fn, { capture, signal });

  on('selectionchange', () => {
    const sel = getSelection();
    if (sel.rangeCount && editorOf(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  });

  // Keep folding in sync when a note is opened or lines are added.
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      const ed = editorOf(m.target) || (m.target.querySelector && m.target.querySelector('.f4-richtext'));
      if (ed) scheduleFold(ed);
    }
  });
  obs.observe(mountEl, { childList: true, subtree: true });

  on(
    'mousedown',
    (e) => {
      if (!mountEl.contains(e.target)) return;
      // Toolbar buttons must not steal focus/selection from the editor.
      if (e.target.closest('.f4-view-FormatBar, .f4-view-ContextMenu') && !e.target.closest('input, textarea')) e.preventDefault();
      // Click outside any menu closes open menus/popovers.
      if (!e.target.closest('.f4-Menu, .f4-view-PasswordSheet')) dismissPopups(e.target);
      // The chevron left of a heading collapses its section.
      const ed = editorOf(e.target);
      const h = ed && e.button === 0 && headingAtGutter(ed, e);
      if (h) {
        e.preventDefault();
        toggleSection(ed, h);
      }
    },
    true,
  );

  // Right-click outside the selection moves the caret there first (like native
  // editors), so the context menu's commands apply to the line that was clicked.
  on(
    'contextmenu',
    (e) => {
      const ed = editorOf(e.target);
      if (!ed || e.shiftKey || (!e.clientX && !e.clientY)) return;
      const sel = getSelection();
      if (sel.rangeCount && !sel.isCollapsed) {
        for (const r of sel.getRangeAt(0).getClientRects()) {
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
        }
      }
      const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (at && ed.contains(at.startContainer)) {
        sel.removeAllRanges();
        sel.addRange(at);
        savedRange = at.cloneRange();
      }
    },
    true,
  );

  on('click', (e) => {
    const ed = editorOf(e.target);
    if (!ed) return;
    const li = e.target.closest('li');
    if (li && li.parentElement.classList.contains('checklist') && ed.contentEditable === 'true') {
      if (e.clientX < li.getBoundingClientRect().left + 2) {
        e.preventDefault();
        checkpoint(ed);
        li.toggleAttribute('data-checked');
        fireInput(ed);
        return;
      }
    }
    const a = e.target.closest('a[href]');
    if (a && (e.metaKey || e.ctrlKey || ed.contentEditable !== 'true')) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  });

  // Undo history: a snapshot before each burst of typing.
  on('beforeinput', (e) => {
    const ed = editorOf(e.target);
    if (!ed) return;
    if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
      e.preventDefault();
      if ((e.inputType === 'historyUndo' ? history.undo : history.redo)(noteKey(), ed)) fireInput(ed);
      return;
    }
    const type = e.inputType.startsWith('insertText') || e.inputType === 'insertCompositionText' ? 'type' : e.inputType;
    history.record(noteKey(), ed, type);
  });

  on('input', (e) => {
    const ed = editorOf(e.target);
    if (!ed) return;
    if (e.inputType === 'insertText' && e.data?.endsWith(' ')) autoList(ed);
    if (e.inputType !== 'insertParagraph') return;
    // A new checklist item must start unchecked.
    const li = selectionElement()?.closest('li');
    if (li && li.hasAttribute('data-checked') && !li.textContent.trim()) {
      li.removeAttribute('data-checked');
      fireInput(ed);
    }
  });

  on('paste', (e) => {
    const ed = editorOf(e.target);
    if (!ed || ed.contentEditable !== 'true') return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      insertImages(files, savedRange?.cloneRange());
      return;
    }
    const html = e.clipboardData?.getData('text/html');
    if (html) {
      e.preventDefault();
      checkpoint(ed);
      exec('insertHTML', sanitize(html));
    }
  });

  on('dragover', (e) => {
    if (editorOf(e.target) && e.dataTransfer?.types.includes('Files')) e.preventDefault();
  });
  on('drop', (e) => {
    const ed = editorOf(e.target);
    if (!ed || !e.dataTransfer?.files.length || ed.contentEditable !== 'true') return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    insertImages(e.dataTransfer.files, pos || savedRange);
  });

  on('keydown', (e) => {
    if (!mountEl.contains(e.target)) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const inEditor = editorOf(e.target);
    const editable = inEditor && inEditor.contentEditable === 'true';

    if (e.key === 'Escape') {
      for (const inst of app.getSnapshot()) {
        app.invokeEffect(inst.key, 'Cancel');
        if (inst.stores.menu === true || POPUP_STATES.has(inst.state)) app.invokeEffect(inst.key, 'Dismiss');
      }
      return;
    }

    if (editable && e.key === 'Tab') {
      const cell = selectionElement()?.closest('td, th');
      e.preventDefault();
      if (cell && inEditor.contains(cell)) moveInTable(cell, e.shiftKey);
      // In a list, Tab nests/un-nests the item; elsewhere it inserts space.
      else if (selectionElement()?.closest('li')) fmt(e.shiftKey ? 'outdent' : 'indent');
      else if (!e.shiftKey) exec('insertText', '    ');
      return;
    }

    // Move Item Up/Down: ⌃⌘↑/↓ on a Mac; Alt+Shift+↑/↓ elsewhere (GNOME owns Ctrl+Alt+arrows).
    if (editable && (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
        (isMac ? e.metaKey && e.ctrlKey : e.altKey && e.shiftKey && !e.ctrlKey)) {
      e.preventDefault();
      fmt(e.key === 'ArrowUp' ? 'move-up' : 'move-down');
      return;
    }

    if (!mod) return;
    const fmtShortcut = (cmd, arg) => {
      e.preventDefault();
      if (editable) fmt(cmd, arg);
    };

    if (editable && key === 'z' && !e.altKey) {
      e.preventDefault();
      if ((e.shiftKey ? history.redo : history.undo)(noteKey(), inEditor)) fireInput(inEditor);
    } else if (editable && key === 'y' && !isMac && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (history.redo(noteKey(), inEditor)) fireInput(inEditor);
    } else if (e.altKey && key === 'n') {
      e.preventDefault();
      app.call('Browse.NewNote');
    } else if (e.shiftKey && key === 'n') {
      const nf = instanceOf('NewFolderRow');
      if (nf) {
        e.preventDefault();
        app.invokeEffect(nf.key, 'Start');
      }
    } else if (key === 'f' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      document.querySelector('input[placeholder="Search all notes"]')?.focus();
    } else if (key === 'k' && inEditor) {
      const fb = instanceOf('FormatBar');
      e.preventDefault();
      if (fb) {
        if (fb.state !== 'Idle') app.invokeEffect(fb.key, 'Dismiss');
        queueMicrotask(() => app.invokeEffect(fb.key, 'AskLink', true));
      }
    } else if (e.altKey && e.code === 'Digit1') fmtShortcut('block', 'h1');
    else if (e.altKey && e.code === 'Digit2') fmtShortcut('block', 'h2');
    else if (e.altKey && e.code === 'Digit3') fmtShortcut('block', 'h3');
    else if (e.altKey && e.code === 'Digit0') fmtShortcut('block', 'p');
    else if (e.altKey && e.code === 'KeyM') fmtShortcut('block', 'pre');
    else if (e.altKey && e.code === 'KeyU') fmtShortcut('mark-checked');
    else if (e.altKey && e.code === 'KeyC' && inEditor) fmtShortcut('copy-style');
    else if (e.altKey && e.code === 'KeyV' && inEditor) fmtShortcut('paste-style');
    else if (e.shiftKey && e.code === 'Digit7') fmtShortcut('list', 'bullet');
    else if (e.shiftKey && e.code === 'Digit8') fmtShortcut('list', 'dash');
    else if (e.shiftKey && e.code === 'Digit9') fmtShortcut('list', 'number');
    else if (e.shiftKey && e.code === 'KeyL') fmtShortcut('checklist');
    else if (e.shiftKey && e.code === 'KeyU') fmtShortcut('mark-checked');
    else if (e.shiftKey && e.code === 'KeyX') fmtShortcut('strikeThrough');
    else if (!e.shiftKey && e.code === 'Quote' && inEditor) fmtShortcut('quote');
    else if (!e.shiftKey && e.code === 'BracketRight' && inEditor) fmtShortcut('indent');
    else if (!e.shiftKey && e.code === 'BracketLeft' && inEditor) fmtShortcut('outdent');
    else if (editable && !e.shiftKey && !e.altKey && ['b', 'i', 'u'].includes(key)) {
      fmtShortcut({ b: 'bold', i: 'italic', u: 'underline' }[key]);
    } else if (key === 'p') {
      const sel = noteKey();
      if (sel) {
        e.preventDefault();
        app.call('Library.Export', 'print', sel);
      }
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !inEditor && !e.target.closest('input, textarea')) {
      const sel = noteKey();
      const note = app.getContext('Library').notes.find((n) => n.id === sel);
      // Moves to Recently Deleted only; permanent deletion always asks first (note menu).
      if (note && !note.deleted_at) {
        e.preventDefault();
        app.call('Library.Trash', sel);
      }
    }
  });

  editorCleanup = () => {
    ac.abort();
    obs.disconnect();
  };
  return editorCleanup;
}
