// Window-level UX that isn't tied to one view:
//   * resizable sidebar / note list (drag the dividers, or focus one and use ←/→)
//   * keyboard navigation of the note list (↑/↓, ←/→ in the gallery, Home/End, Enter)
//   * menus: arrow keys, focus moves into a menu opened from the keyboard and
//     returns to its opener when it closes, menus are kept inside the window
//   * focus trap in modal dialogs
import * as model from './model.js';

let app = null;
let mountEl = document.body;
let uxCleanup = null;
const selectedId = () => app?.getContext('Browse')?.selected ?? '';

// ---- resizable panes ------------------------------------------------------------------
const PANES = {
  'f4-SidebarSplitter': { prop: '--sidebar-w', pane: '.f4-Sidebar', min: 150, max: 360, def: 185 },
  'f4-ListSplitter': { prop: '--list-w', pane: '.f4-ListPane', min: 190, max: 460, def: 230 },
};
const paneOf = (el) => {
  for (const [cls, p] of Object.entries(PANES)) if (el?.classList?.contains(cls)) return p;
  return null;
};
const rtl = () => mountEl?.dir === 'rtl';

function setWidth(p, px, save = true) {
  const w = Math.round(Math.max(p.min, Math.min(p.max, px)));
  mountEl.style.setProperty(p.prop, `${w}px`);
  for (const el of mountEl.querySelectorAll(`.${Object.keys(PANES).find((k) => PANES[k] === p)}`)) {
    el.setAttribute('aria-valuenow', String(w));
    el.setAttribute('aria-valuemin', String(p.min));
    el.setAttribute('aria-valuemax', String(p.max));
  }
  if (save) model.savePref(p.prop, w);
  return w;
}
const widthOf = (p) => mountEl.querySelector(p.pane)?.getBoundingClientRect().width ?? p.def;

function installSplitters(on) {
  for (const p of Object.values(PANES)) {
    const w = model.loadPref(p.prop, null);
    // the separators report the panes' real widths (aria-valuenow) from the start
    setWidth(p, w || widthOf(p) || p.def, false);
  }
  on('pointerdown', (e) => {
    if (!mountEl.contains(e.target)) return;
    const p = paneOf(e.target);
    if (!p || e.button !== 0) return;
    e.preventDefault();
    const handle = e.target;
    const left = mountEl.querySelector(p.pane)?.getBoundingClientRect();
    if (!left) return;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev) => setWidth(p, rtl() ? left.right - ev.clientX : ev.clientX - left.left, false);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth(p, widthOf(p));
      handle.focus({ preventScroll: true });
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  on('dblclick', (e) => {
    if (!mountEl.contains(e.target)) return;
    const p = paneOf(e.target);
    if (p) setWidth(p, p.def);
  });
  on('keydown', (e) => {
    if (!mountEl.contains(e.target)) return;
    const p = paneOf(e.target);
    if (!p) return;
    const step = e.shiftKey ? 48 : 16;
    const sign = rtl() ? -1 : 1;
    const keys = {
      ArrowLeft: () => widthOf(p) - step * sign,
      ArrowRight: () => widthOf(p) + step * sign,
      Home: () => p.min,
      End: () => p.max,
      Enter: () => p.def,
    };
    if (!keys[e.key]) return;
    e.preventDefault();
    setWidth(p, keys[e.key]());
  });
}

// ---- note list keyboard navigation ------------------------------------------------------
function focusSelectedOption() {
  requestAnimationFrame(() => {
    const opt = document.querySelector('[role=listbox] [role=option][aria-selected=true]');
    if (!opt) return;
    opt.focus({ preventScroll: true });
    opt.scrollIntoView({ block: 'nearest' });
  });
}

function galleryColumns(opt) {
  const grid = opt.closest('.f4-GalleryGrid');
  return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 1;
}

function installListKeys(on) {
  on('keydown', (e) => {
    if (!mountEl.contains(e.target)) return;
    const opt = e.target.closest?.('[role=option]');
    if (!opt || e.ctrlKey || e.metaKey || e.altKey) return;
    const inGallery = !!opt.closest('.f4-GalleryScroller');
    const cols = inGallery ? galleryColumns(opt) : 1;
    const moves = {
      ArrowDown: cols,
      ArrowUp: -cols,
      ArrowRight: inGallery ? (rtl() ? -1 : 1) : 0,
      ArrowLeft: inGallery ? (rtl() ? 1 : -1) : 0,
      Home: -999,
      End: 999,
      PageDown: 10,
      PageUp: -10,
    };
    if (moves[e.key]) {
      e.preventDefault();
      app.call('Browse.Step', moves[e.key]);
      focusSelectedOption();
    } else if (e.key === 'Enter' && !e.repeat) {
      e.preventDefault();
      if (inGallery) app.call('Browse.Open', selectedId());
      requestAnimationFrame(() => document.querySelector('.f4-richtext[contenteditable=true]')?.focus());
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      const note = app.getContext('Library').notes.find((n) => n.id === selectedId());
      if (note && !note.deleted_at) {
        e.preventDefault();
        app.call('Library.Trash', note.id);
        focusSelectedOption();
      }
    }
  });
}

// ---- menus ----------------------------------------------------------------------------------
let keyboardMode = false;
let opener = null;
const ITEM = '[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]';

function keepOnScreen(menu) {
  // The positioned box is the menu itself or its fixed host view.
  let box = menu;
  for (let el = menu; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).position === 'fixed') {
      box = el;
      break;
    }
  }
  if (getComputedStyle(box).position !== 'fixed') return;
  // Layout size, not getBoundingClientRect(): the pop-in animation scales the menu.
  const at = box.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const pad = 8;
  if (at.left + w > innerWidth - pad) box.style.left = `${Math.max(pad, innerWidth - w - pad)}px`;
  if (at.top + h > innerHeight - pad) box.style.top = `${Math.max(pad, innerHeight - h - pad)}px`;
}

function installMenus(on) {
  on('keydown', (e) => {
    if (e.key === 'Tab' || e.key.startsWith('Arrow') || e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) keyboardMode = true;
  }, true);
  on('pointerdown', () => { keyboardMode = false; }, true);
  on('focusin', (e) => {
    if (mountEl.contains(e.target) && !e.target.closest?.('[role=menu], [role=dialog], [role=alertdialog]')) opener = e.target;
  });
  // The opener may have been re-rendered (a view changed state): find its replacement.
  const findOpener = () => {
    if (!opener) return null;
    if (opener.isConnected) return opener;
    const label = opener.getAttribute?.('aria-label');
    return label ? mountEl.querySelector(`[aria-label="${CSS.escape(label)}"]`) : null;
  };

  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        const menu = n.matches('[role=menu]') ? n : n.querySelector('[role=menu]');
        if (menu) {
          requestAnimationFrame(() => {
            if (!menu.isConnected) return;
            keepOnScreen(menu);
            if (keyboardMode) menu.querySelector(ITEM)?.focus();
          });
        }
      }
      if (m.removedNodes.length && document.activeElement === document.body) {
        findOpener()?.focus({ preventScroll: true });
      }
    }
  });
  obs.observe(mountEl, { childList: true, subtree: true });

  on('keydown', (e) => {
    if (!mountEl.contains(e.target)) return;
    const menu = e.target.closest?.('[role=menu]');
    if (!menu) return;
    const items = [...menu.querySelectorAll(ITEM)].filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(e.target.closest(ITEM));
    let next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Tab') {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLocaleLowerCase();
      next = [...items.slice(i + 1), ...items.slice(0, i + 1)].find((el) => el.textContent.trim().replace(/^✓/, '').trim().toLocaleLowerCase().startsWith(k));
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  return obs;
}

// ---- modal dialogs: keep Tab inside ---------------------------------------------------------------
function installDialogTrap(on) {
  on('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const dialog = mountEl.querySelector('[role=dialog][aria-modal=true]');
    if (!dialog) return;
    const f = [...dialog.querySelectorAll('input, button, [tabindex="0"]')].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!dialog.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

export function installUx(foarApp, el = document.body) {
  app = foarApp;
  mountEl = el;
  if (uxCleanup) uxCleanup();
  const ac = new AbortController();
  const on = (type, fn, capture = false) => document.addEventListener(type, fn, { capture, signal: ac.signal });
  installSplitters(on);
  installListKeys(on);
  const obs = installMenus(on);
  installDialogTrap(on);
  uxCleanup = () => {
    ac.abort();
    obs.disconnect();
  };
  return uxCleanup;
}
