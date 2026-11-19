// Workbench layout: activity bar (Explorer / Search), sidebar, editor, preview
// and tools (inspector) panes — each can be toggled and resized, the layout is
// remembered — plus zen mode and the status bar.

const KEY = 'foar.playground.layout.v1';
const DEFAULTS = { sidebar: true, preview: true, tools: true, panel: 'explorer', sidebarW: 210, editorW: 52, previewH: 52, zen: false };

const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
};

export const ICONS = {
  files: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3.5h7l4 4V17H8z M15 3.5V7.5h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M5 7v13.5h11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15 15l5.5 5.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  command: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7l5 5-5 5M12 17h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sidebar: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect class="fill" x="2.1" y="3.1" width="4" height="9.8" fill="currentColor"/><path d="M6.5 2.5v11" stroke="currentColor" stroke-width="1.2"/></svg>',
  preview: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect class="fill" x="9.6" y="3.1" width="4.3" height="5.4" fill="currentColor"/><path d="M9.5 2.5v11M9.5 8.5h5" stroke="currentColor" stroke-width="1.2"/></svg>',
  tools: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/><rect class="fill" x="9.6" y="8.6" width="4.3" height="4.3" fill="currentColor"/><path d="M9.5 2.5v11M9.5 8.5h5" stroke="currentColor" stroke-width="1.2"/></svg>',
  zen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};

export function createLayout({ ws, search, palette }) {
  let state = { ...DEFAULTS };
  let problems = { errors: 0, warnings: 0 };
  try {
    state = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {}
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {}
  };

  const workspace = document.querySelector('.workspace');
  const editorPane = document.querySelector('.editor-pane');
  const right = document.querySelector('.right-column');
  const preview = document.querySelector('.preview-section');
  const tools = document.querySelector('.inspector-section');
  const ide = document.getElementById('workspace-root');

  // ---- activity bar + sidebar ----
  const act = (id, icon, label, keys) =>
    h('button', {
      class: 'act-btn',
      type: 'button',
      'data-panel': id,
      title: `${label} (${keys})`,
      'aria-label': label,
      'aria-pressed': 'false',
      html: ICONS[icon],
      onclick: () => showPanel(id, { toggle: true }),
    });
  const activity = h(
    'nav',
    { class: 'activity', 'aria-label': 'Views' },
    act('explorer', 'files', 'Explorer', 'Ctrl+Shift+E'),
    act('search', 'search', 'Search', 'Ctrl+Shift+F'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'act-btn', type: 'button', title: 'Command palette (Ctrl+Shift+P)', 'aria-label': 'Command palette', html: ICONS.command, onclick: () => palette.open('>') })
  );
  const sidebar = h('div', { class: 'sidebar' }, ws.explorerEl, search.el);
  const sideSplit = h('div', { class: 'splitter v', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize sidebar', tabindex: '0' });
  ide.prepend(activity, sidebar, sideSplit);

  // ---- splitters between editor | right column, and preview / tools ----
  const mainSplit = h('div', { class: 'splitter v', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize editor and preview', tabindex: '0' });
  workspace.insertBefore(mainSplit, right);
  const rightSplit = h('div', { class: 'splitter hz', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize preview and tools', tabindex: '0' });
  right.insertBefore(rightSplit, tools);

  // ---- title-bar controls ----
  const toggleBtn = (key, label, keys) =>
    h('button', {
      class: 'layout-btn',
      type: 'button',
      title: `${label} (${keys})`,
      'aria-label': label,
      'aria-pressed': 'true',
      html: ICONS[key],
      onclick: () => toggle(key),
    });
  const tSidebar = toggleBtn('sidebar', 'Toggle sidebar', 'Ctrl+B');
  const tPreview = toggleBtn('preview', 'Toggle preview', 'Ctrl+Alt+B');
  const tTools = toggleBtn('tools', 'Toggle tools', 'Ctrl+J');
  const tZen = h('button', { class: 'layout-btn', type: 'button', title: 'Zen mode (Ctrl+K Z)', 'aria-label': 'Zen mode', 'aria-pressed': 'false', html: ICONS.zen, onclick: () => toggle('zen') });
  const center = h(
    'button',
    { class: 'command-center', type: 'button', 'aria-label': 'Search files (Ctrl+P)', onclick: () => palette.open('') },
    h('span', { class: 'cc-icon', html: ICONS.search }),
    h('span', { class: 'cc-text', text: 'Search files' }),
    h('kbd', { text: 'Ctrl+P' })
  );
  const controls = document.querySelector('.topbar-controls');
  const brand = document.querySelector('.brand');
  brand.after(center);
  controls.append(h('div', { class: 'layout-btns', role: 'group', 'aria-label': 'Layout' }, tSidebar, tPreview, tTools, tZen));

  // ---- status bar ----
  const sb = {
    project: h('button', { class: 'sb-item', type: 'button', title: 'Switch project', onclick: () => palette.run('project.open') }),
    save: h('span', { class: 'sb-item' }),
    errors: h('button', { class: 'sb-item', type: 'button', title: 'Problems (Ctrl+Shift+M) · next: F8', onclick: () => palette.run('view.problems') }),
    pos: h('button', { class: 'sb-item', type: 'button', title: 'Go to line (Ctrl+G)', onclick: () => palette.open(':') }),
    indent: h('span', { class: 'sb-item', text: 'Spaces: 4' }),
    lang: h('span', { class: 'sb-item', text: 'FOAR' }),
    compile: h('span', { class: 'sb-item' }),
  };
  const statusbar = h(
    'footer',
    { class: 'statusbar', 'aria-label': 'Status bar' },
    sb.project,
    sb.save,
    sb.errors,
    h('span', { class: 'spacer' }),
    sb.pos,
    sb.indent,
    sb.lang,
    sb.compile
  );
  document.body.append(statusbar);

  function updateStatus() {
    sb.project.textContent = `⎇ ${ws.name || 'project'}`;
    const n = ws.dirtyCount;
    sb.save.textContent = ws.backendKind === 'remote' ? (n ? `● ${n} unsaved` : '✓ saved to disk') : 'kept in this browser';
    sb.save.classList.toggle('warn', !!n);
    const errors = problems.errors;
    sb.errors.textContent = `⊗ ${errors}  ⚠ ${problems.warnings}`;
    sb.errors.classList.toggle('err', errors > 0);
    sb.errors.classList.toggle('warn', !errors && problems.warnings > 0);
    const ae = ws.activeEditor();
    if (ae) {
      const { ta } = ae;
      const before = ta.value.slice(0, ta.selectionStart);
      const line = before.split('\n').length;
      const col = ta.selectionStart - before.lastIndexOf('\n');
      const sel = Math.abs(ta.selectionEnd - ta.selectionStart);
      sb.pos.textContent = `Ln ${line}, Col ${col}${sel ? ` (${sel} selected)` : ''}`;
      sb.pos.hidden = false;
    } else sb.pos.hidden = true;
    const status = document.getElementById('compiler-status');
    sb.compile.textContent = status?.textContent.trim().replace(/^● /, '') ?? '';
  }
  for (const ev of ['active', 'change', 'compile', 'cursor']) ws.events.addEventListener(ev, () => queueMicrotask(updateStatus));
  document.addEventListener('selectionchange', () => {
    if (document.activeElement?.classList.contains('code-input')) updateStatus();
  });
  new MutationObserver(updateStatus).observe(document.getElementById('compiler-status'), { childList: true, characterData: true, subtree: true });

  // ---- apply ----
  function apply() {
    const zen = state.zen;
    const showSide = state.sidebar && !zen;
    const showPreview = state.preview && !zen;
    const showTools = state.tools && !zen;
    const showRight = showPreview || showTools;
    document.body.classList.toggle('zen', zen);
    // hidden children leave the grid, so list columns for the visible ones only
    ide.style.gridTemplateColumns = [!zen && '44px', showSide && `${state.sidebarW}px`, showSide && '4px', 'minmax(0, 1fr)'].filter(Boolean).join(' ');
    activity.hidden = zen;
    sidebar.hidden = !showSide;
    sideSplit.hidden = !showSide;
    ws.explorerEl.hidden = state.panel !== 'explorer';
    search.el.hidden = state.panel !== 'search';
    for (const b of activity.querySelectorAll('[data-panel]')) {
      const on = showSide && b.dataset.panel === state.panel;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    workspace.style.gridTemplateColumns = showRight ? `minmax(320px, ${state.editorW}%) 4px minmax(280px, 1fr)` : 'minmax(0, 1fr) 0 0';
    right.hidden = !showRight;
    mainSplit.hidden = !showRight;
    preview.hidden = !showPreview;
    tools.hidden = !showTools;
    rightSplit.hidden = !(showPreview && showTools);
    right.style.gridTemplateRows = showPreview && showTools ? `minmax(120px, ${state.previewH}%) 4px minmax(100px, 1fr)` : '1fr';
    tSidebar.setAttribute('aria-pressed', String(state.sidebar));
    tPreview.setAttribute('aria-pressed', String(state.preview));
    tTools.setAttribute('aria-pressed', String(state.tools));
    tZen.setAttribute('aria-pressed', String(zen));
    for (const [el, v] of [[sideSplit, state.sidebarW], [mainSplit, state.editorW], [rightSplit, state.previewH]]) el.setAttribute('aria-valuenow', String(Math.round(v)));
    save();
  }

  function toggle(key, force) {
    if (key === 'zen') state.zen = force ?? !state.zen;
    else {
      state[key] = force ?? !state[key];
      if (state.zen && state[key]) state.zen = false;
    }
    apply();
    if (key === 'sidebar' && !state.sidebar && document.activeElement?.closest('.sidebar')) ws.activeEditor()?.ta.focus();
  }

  function showPanel(id, { toggle: tog = false, focus = true } = {}) {
    if (tog && state.sidebar && !state.zen && state.panel === id) {
      state.sidebar = false;
      apply();
      ws.activeEditor()?.ta.focus();
      return;
    }
    state.panel = id;
    state.sidebar = true;
    state.zen = false;
    apply();
    if (!focus) return;
    if (id === 'search') search.focus();
    else ws.focusTree();
  }

  // ---- splitters: drag, arrows, double-click resets ----
  function splitter(el, { get, set, axis, min, max, step, reset, measure }) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
      const move = (ev) => {
        set(Math.max(min, Math.min(max, measure(ev))));
        apply();
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing-x', 'resizing-y');
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', () => {
      set(reset);
      apply();
    });
    el.addEventListener('keydown', (e) => {
      const dir = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      set(Math.max(min, Math.min(max, get() + dir * step * (e.shiftKey ? 4 : 1))));
      apply();
    });
    el.setAttribute('aria-valuemin', String(min));
    el.setAttribute('aria-valuemax', String(max));
  }
  splitter(sideSplit, {
    axis: 'x', min: 160, max: 480, step: 10, reset: DEFAULTS.sidebarW,
    get: () => state.sidebarW, set: (v) => (state.sidebarW = v),
    measure: (ev) => ev.clientX - sidebar.getBoundingClientRect().left,
  });
  splitter(mainSplit, {
    axis: 'x', min: 22, max: 80, step: 2, reset: DEFAULTS.editorW,
    get: () => state.editorW, set: (v) => (state.editorW = v),
    measure: (ev) => ((ev.clientX - workspace.getBoundingClientRect().left) / workspace.clientWidth) * 100,
  });
  splitter(rightSplit, {
    axis: 'y', min: 12, max: 88, step: 2, reset: DEFAULTS.previewH,
    get: () => state.previewH, set: (v) => (state.previewH = v),
    measure: (ev) => ((ev.clientY - right.getBoundingClientRect().top) / right.clientHeight) * 100,
  });

  apply();
  updateStatus();

  return {
    toggle,
    showPanel,
    get state() {
      return { ...state };
    },
    reset() {
      state = { ...DEFAULTS };
      apply();
    },
    updateStatus,
    setProblems(p) {
      problems = p;
      updateStatus();
    },
  };
}
