import { compileFoarProject, extractStateMachines, generateReadableJS, compilerBackend } from '../foar-compiler.js';
import { localUrl, LOCAL_ONLY_MESSAGE } from './local-url.js';
import { createWorkspace, localBackend, remoteBackend } from './workbench/workspace.js';
import { createSearchPanel } from './workbench/search.js';
import { createFindBar } from './workbench/findbar.js';
import { createPalette } from './workbench/palette.js';
import { createLayout } from './workbench/layout.js';
import { createLanguageFeatures } from './language/editor.js';
import { createFoarRuntime, createI18n } from '../foar-runtime.js';

const exampleSelect = document.getElementById('example-select');
const projectTitle = document.getElementById('project-title');
const compilerStatus = document.getElementById('compiler-status');
const errorBanner = document.getElementById('error-banner');
const foarMount = document.getElementById('f4-mount');
const activeStatesSummary = document.getElementById('active-states-summary');
const machinesVisualizer = document.getElementById('machines-visualizer');
const storesInspector = document.getElementById('stores-inspector');
const eventLog = document.getElementById('event-log');
const compiledJsOutput = document.getElementById('compiled-js-output');
const astOutput = document.getElementById('ast-output');
const toggleBadges = document.getElementById('toggle-badges');
const btnReset = document.getElementById('btn-reset');
const btnClearLog = document.getElementById('btn-clear-log');
const btnOpenExampleTab = document.getElementById('btn-open-example-tab');
const btnOpenPreviewTab = document.getElementById('btn-open-preview-tab');

let currentRuntime = null;
let currentMachines = [];
let debounceTimer = null;
let currentHostUrl = null;
let activeHost = null;
// ?src=<url of a .foar file>: compile it here; when it needs host functions
// (an app with its own JS), the preview embeds the running app (?app=<url>,
// default: the source's origin) instead of mounting it bare.
const params = new URLSearchParams(location.search);
const rejectedSrc = (params.has('src') && !localUrl(params.get('src'))) || (params.has('app') && !localUrl(params.get('app')));
const remoteSrc = rejectedSrc ? null : localUrl(params.get('src'));
const previewUrl = remoteSrc ? localUrl(params.get('app')) || new URL(remoteSrc).origin + '/' : null;

function buildAppUrl(value) {
  const v = value || exampleSelect.value || 'todo';
  if (v.startsWith('src:')) {
    const raw = localUrl(v.slice(4));
    return raw ? new URL(raw).origin + '/' : 'app.html';
  }
  if (remoteSrc && !v) {
    return previewUrl || `app.html?src=${encodeURIComponent(remoteSrc)}`;
  }
  return `app.html?example=${encodeURIComponent(v)}`;
}

function syncNewTabLinks(value) {
  const appHref = buildAppUrl(value);
  if (btnOpenExampleTab) btnOpenExampleTab.href = appHref;
  if (btnOpenPreviewTab) btnOpenPreviewTab.href = appHref;
}


// Data (store values, effect args, payloads) is escaped before it goes into
// innerHTML: with ?src= it comes from a real app and may contain HTML.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function show(v) {
  let j;
  try {
    j = JSON.stringify(v);
  } catch {
    j = String(v);
  }
  if (j === undefined) j = String(v);
  return esc(j.length > 160 ? `${j.slice(0, 160)}…` : j);
}

function appendLog(type, htmlText) {
  const row = document.createElement('div');
  row.className = 'log-entry';
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  row.innerHTML = `<span class="log-time">[${ts}]</span> ${htmlText}`;
  eventLog.prepend(row);
  while (eventLog.children.length > 60) {
    eventLog.lastChild.remove();
  }
}

function renderStateMachinesAndStores(snapshot) {
  // Update top summary chips
  activeStatesSummary.innerHTML = snapshot
    .map(
      (inst) =>
        `<span class="summary-chip">${esc(inst.viewName)}: <strong>${esc(inst.state)}</strong></span>`
    )
    .join('');

  // Render State Machine Graph Cards
  machinesVisualizer.innerHTML = '';
  for (const machine of currentMachines) {
    const matchingInstances = snapshot.filter((s) => s.viewName === machine.viewName);
    const activeStateCounts = {};
    for (const inst of matchingInstances) {
      activeStateCounts[inst.state] = (activeStateCounts[inst.state] || 0) + 1;
    }

    const card = document.createElement('div');
    card.className = 'machine-card';

    const header = document.createElement('div');
      header.className = 'machine-card-header';
    header.innerHTML = `
      <button type="button" class="machine-view-name" title="Open the file that declares ${esc(machine.viewName)}">view ${esc(machine.viewName)}</button>
      <span style="font-size:11px;color:#8b949e;">${matchingInstances.length} mounted instance${matchingInstances.length === 1 ? '' : 's'}</span>
    `;
    header.querySelector('.machine-view-name').addEventListener('click', () => ws.revealDeclaration(machine.viewName));
    card.appendChild(header);

    const statesRow = document.createElement('div');
    statesRow.className = 'machine-states-row';

    for (const stName of machine.states) {
      const count = activeStateCounts[stName] || 0;
      const isActive = count > 0;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `state-node ${isActive ? 'active' : ''}`;
      btn.title = `Click to transition ${machine.viewName} instance to '${stName}'`;
      btn.innerHTML = `
        <span class="state-node-dot"></span>
        <span>${stName}</span>
        ${matchingInstances.length > 1 ? `<span class="state-count-badge">${count}</span>` : ''}
      `;
      btn.addEventListener('click', () => {
        if (currentRuntime && matchingInstances.length > 0) {
          currentRuntime.forceStateTransition(matchingInstances[0].key, stName);
        }
      });
      statesRow.appendChild(btn);
    }
    card.appendChild(statesRow);

    if (machine.transitions.length > 0) {
      const trList = document.createElement('div');
      trList.className = 'transitions-list';
      for (const tr of machine.transitions) {
        const item = document.createElement('div');
        item.className = 'transition-item';
        item.innerHTML = `
          <span class="tr-from">${tr.from}</span>
          <span>──▶</span>
          <span class="tr-to">${tr.to}</span>
          <span class="tr-via">via ${tr.via}${tr.async ? ' (async)' : ''}</span>
        `;
        trList.appendChild(item);
      }
      card.appendChild(trList);
    }

    machinesVisualizer.appendChild(card);
  }

  // Render Live Stores Inspector
  storesInspector.innerHTML = '';
  for (const inst of snapshot) {
    const storeEntries = Object.entries(inst.stores);
    if (storeEntries.length === 0) continue;

    const row = document.createElement('div');
    row.className = 'store-instance-row';
    const formattedStores = storeEntries
      .map(([k, v]) => `<span style="color:#79c0ff">${esc(k)}</span>: ${show(v)}`)
      .join(', ');
    row.innerHTML = `
      <div><strong style="color:#e6edf3">${esc(inst.viewName)}</strong> <span style="color:#3fb950">[${esc(inst.state)}]</span></div>
      <div style="color:#8b949e;margin-top:2px;word-break:break-all;">${formattedStores}</div>
    `;
    storesInspector.appendChild(row);
  }
}

let inspectorRaf = 0;
let pendingSnapshot = null;
function scheduleInspector(snapshot) {
  pendingSnapshot = snapshot;
  if (inspectorRaf) return;
  inspectorRaf = requestAnimationFrame(() => {
    inspectorRaf = 0;
    renderStateMachinesAndStores(pendingSnapshot);
  });
}

// Runtime callbacks feeding the inspector (also used for an embedded app, via postMessage).
const inspectorCallbacks = {
  onRender(snapshot) {
    scheduleInspector(snapshot);
  },
  onEffect({ viewName, state, effect, arg }) {
    const argStr = arg !== undefined ? `(${show(arg)})` : '()';
    appendLog(
      'effect',
      `<span class="log-tag-effect">⚡ effect</span> <strong>${esc(viewName)}.${esc(state)}.${esc(effect)}</strong>${argStr}`
    );
  },
  onTransition({ viewName, from, to, asyncCall, manual }) {
    const extra = asyncCall
      ? ` <span style="color:#d29922">[await ${esc(asyncCall)}]</span>`
      : manual
        ? ` <span style="color:#8b949e">[inspector forced]</span>`
        : '';
    appendLog(
      'transition',
      `<span class="log-tag-transition">🔀 transition</span> <strong>${esc(viewName)}</strong>: ${esc(from)} ──▶ <strong>${esc(to)}</strong>${extra}`
    );
  },
  onEmit({ viewName, event, payload }) {
    appendLog(
      'emit',
      `<span class="log-tag-emit">📡 emit</span> <strong>${esc(viewName)}</strong> ──▶ <code>on_${esc(event)}(${show(payload)})</code>`
    );
  },
};

let compileSeq = 0;
async function compileAndMount(project) {
  const seq = ++compileSeq;
  const t0 = performance.now();
  try {
    const ast = await compileFoarProject(project);
    if (seq !== compileSeq) return; // a newer edit superseded this compile
    const elapsed = (performance.now() - t0).toFixed(2);
    const backend = compilerBackend === 'wasm' ? 'Rust→WASM' : 'Rust native';
    compilerStatus.className = 'status-pill status-ok';
    errorBanner.classList.add('hidden');
    ws.setCompileResult({ files: ast.files, error: null });
    const fileCount = ast.files?.length ?? 1;

    currentMachines = extractStateMachines(ast);
    compiledJsOutput.textContent = generateReadableJS(ast);
    astOutput.textContent = JSON.stringify(ast, null, 2);

    if (currentRuntime) {
      currentRuntime.destroy();
      currentRuntime = null;
    }
    if (activeHost) {
      activeHost.destroy?.();
      activeHost = null;
    }

    if (previewUrl) {
      if (!foarMount.querySelector('iframe')) {
        foarMount.textContent = '';
        const frame = document.createElement('iframe');
        frame.src = previewUrl;
        frame.title = 'Running app';
        frame.className = 'remote-preview';
        foarMount.appendChild(frame);
        foarMount.classList.add('remote');
      }
      compilerStatus.textContent = `● ${backend} ${elapsed}ms · ${fileCount} files · ${ast.views.length} views`;
      compilerStatus.title = `Preview: ${previewUrl}`;
      renderStateMachinesAndStores(lastRemoteSnapshot);
      return;
    }

    let hostOpts = {};
    if (currentHostUrl) {
      const mod = await import(new URL(currentHostUrl, import.meta.url).href);
      if (seq !== compileSeq) return;
      activeHost = await mod.createHost({ createI18n, getApp: () => currentRuntime });
      if (seq !== compileSeq) {
        activeHost?.destroy?.();
        activeHost = null;
        return;
      }
      hostOpts = {
        i18n: activeHost.i18n,
        bindings: activeHost.bindings,
      };
    }

    const fullBleed = Boolean(activeHost?.fullBleed);
    foarMount.classList.toggle('fullbleed', fullBleed);

    const tMount = performance.now();
    currentRuntime = createFoarRuntime(ast, foarMount, {
      badges: !fullBleed,
      ...hostOpts,
      ...inspectorCallbacks,
    });
    activeHost?.attach?.(currentRuntime, foarMount);
    const mountMs = (performance.now() - tMount).toFixed(2);
    compilerStatus.textContent = `● ${backend} ${elapsed}ms · ${fileCount} file${fileCount === 1 ? '' : 's'} · mounted ${mountMs}ms`;
  } catch (err) {
    if (seq !== compileSeq) return;
    compilerStatus.textContent = '✖ Compile error';
    compilerStatus.className = 'status-pill status-err';
    const where = err.file ? { file: err.file, line: err.line, col: err.col, message: err.reason ?? err.message } : err.line ? { file: ws.entry, line: err.line, col: err.col, message: err.reason ?? err.message } : null;
    ws.setCompileResult({ error: where });
    errorBanner.textContent = '';
    if (where) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'error-link';
      link.textContent = `${where.file}:${where.line}:${where.col}`;
      link.title = 'Go to the error';
      link.addEventListener('click', () => ws.openFile(where.file, { line: where.line, col: where.col }));
      errorBanner.append(link, ` ${where.message}`);
    } else errorBanner.textContent = err.message;
    errorBanner.classList.remove('hidden');
  }
}

// ---- projects ---------------------------------------------------------------------------
// Examples are project folders in examples/ (GET /examples/index.json lists them
// with their files). "Scratch" starts as a copy of examples/starter and is kept
// in this browser.
// The live-app projects only exist on a developer's machine.
if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
  exampleSelect.querySelector('optgroup[label="Apps"]')?.remove();
}

let examples = [];
const examplesReady = fetch(new URL('../examples/index.json', import.meta.url), { cache: 'no-store' })
  .then((r) => (r.ok ? r.json() : []))
  .catch(() => [])
  .then((list) => {
    examples = list;
    const group = document.getElementById('examples-group');
    for (const ex of list) group.append(new Option(`${ex.title} — ${ex.description}`, ex.id));
  });

const ws = createWorkspace(document.getElementById('workspace-root'), {
  onChange(project) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => compileAndMount(project), 180);
  },
});

async function openProject(backend, info) {
  eventLog.innerHTML = '';
  projectTitle.textContent = info.name;
  try {
    await ws.load(backend, info);
    appendLog('info', `<span style="color:#8b949e">Opened ${esc(info.name)} · ${esc(backend.kind === 'remote' ? `Ctrl+S saves to ${backend.label}` : 'edits are kept in this browser')}</span>`);
  } catch (err) {
    compilerStatus.textContent = '✖ Could not open project';
    compilerStatus.className = 'status-pill status-err';
    errorBanner.textContent = `Could not open ${info.name}: ${err.message}`;
    errorBanner.classList.remove('hidden');
  }
}

function openScratch() {
  currentHostUrl = null;
  syncNewTabLinks('scratch', 'Scratch');
  const starter = examples.find((e) => e.id === 'starter');
  const original = { entry: starter?.entry ?? 'app.foar', files: starter?.files ?? { 'app.foar': 'view App {\n    state Ready {\n        render {\n            Text("Hello")\n        }\n    }\n}\n' } };
  return openProject(localBackend('scratch', original), { name: 'Scratch', id: 'scratch', original });
}

function loadExample(id) {
  const ex = examples.find((e) => e.id === id);
  if (!ex) return openScratch();
  currentHostUrl = ex.host ?? null;
  syncNewTabLinks(id, ex.title);
  const original = { entry: ex.entry, files: ex.files };
  return openProject(localBackend(`example:${id}`, original), { name: `examples/${id}`, id: `example:${id}`, original });
}

// A running app: its dev server serves the whole project and saves edits
// (GET /__foar/project, PUT/DELETE /__foar/files). Without that API, only the
// one .foar file is shown, and edits stay in this browser.
async function loadRemote(url) {
  syncNewTabLinks(`src:${url}`, url.split('/').pop());
  const base = `${new URL(url).origin}/`;
  const remote = remoteBackend(base);
  let p = null;
  try {
    p = await remote.load();
  } catch {}
  if (p) return openProject(remote, { name: p.name || new URL(url).host, id: `remote:${base}` });
  const res = await fetch(url).catch(() => null);
  if (!res?.ok) {
    compilerStatus.textContent = '✖ Could not load source';
    compilerStatus.className = 'status-pill status-err';
    errorBanner.textContent = `Could not load ${url}`;
    errorBanner.classList.remove('hidden');
    return;
  }
  const name = url.split('/').pop();
  const original = { entry: name, files: { [name]: await res.text() } };
  await openProject(localBackend(`remote-file:${url}`, original), { name: new URL(url).host, id: `remote-file:${url}`, original });
}

// "src:<url>" options open a running app's source (remote mode); the others are
// bundled examples. Switching between the two modes reloads the page.
const NOTES_SRC = 'http://localhost:4400/src/app.foar';
exampleSelect.addEventListener('change', () => {
  const v = exampleSelect.value;
  if (!v) return;
  if (v.startsWith('src:')) {
    location.search = `?src=${encodeURIComponent(v.slice(4))}`;
  } else if (remoteSrc) {
    location.search = `?example=${encodeURIComponent(v)}`; // leave remote mode
  } else {
    history.replaceState(null, '', `?example=${encodeURIComponent(v)}`);
    if (v === 'scratch') openScratch();
    else loadExample(v);
  }
});


toggleBadges.addEventListener('change', () => {
  foarMount.classList.toggle('show-badges', toggleBadges.checked);
});

btnReset.addEventListener('click', async () => {
  eventLog.innerHTML = '';
  await compileAndMount(ws.project());
  appendLog('info', `<span style="color:#8b949e">↺ Reset all view state machines &amp; stores</span>`);
});

btnClearLog.addEventListener('click', () => {
  eventLog.innerHTML = '';
});

// Inspector Tab Switching
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

// The embedded app posts its runtime events here (see notes-on-foar/main.js).
let lastRemoteSnapshot = [];
if (previewUrl) {
  const appOrigin = new URL(previewUrl).origin;
  window.addEventListener('message', (e) => {
    if (e.origin !== appOrigin || e.data?.type !== 'foar') return;
    const { kind, data } = e.data;
    if (kind === 'render') {
      lastRemoteSnapshot = data;
      inspectorCallbacks.onRender(data);
    } else if (inspectorCallbacks[kind]) inspectorCallbacks[kind](data);
  });
}

// ---- workbench: search, find, command palette, layout ------------------------------------
const searchPanel = createSearchPanel(ws);
const findBar = createFindBar(ws, ws.editorColEl.querySelector('.editor-host'));
const palette = createPalette(ws);
const layout = createLayout({ ws, search: searchPanel, palette });

// small notifications at the bottom of the editor
const toastEl = document.createElement('div');
toastEl.className = 'pg-toast hidden';
toastEl.setAttribute('role', 'status');
ws.editorColEl.append(toastEl);
let toastTimer = 0;
const notify = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 3200);
};
const lang = createLanguageFeatures({ ws, palette, notify });
lang.events.addEventListener('problems', (e) => layout.setProblems(e.detail));
// for debugging from the console (and tests)
window.__playground = { ws, lang, palette, layout };

const hasEditor = () => !!ws.activeEditor();
const selectedText = () => {
  const ae = ws.activeEditor();
  if (!ae || document.activeElement !== ae.ta) return '';
  const t = ae.ta.value.slice(ae.ta.selectionStart, ae.ta.selectionEnd);
  return t.includes('\n') ? '' : t;
};
const showInspectorTab = (id) => {
  layout.toggle('tools', true);
  document.querySelector(`.tab-btn[data-tab="${id}"]`)?.click();
};
const COMMANDS = [
  // go / open
  ['workbench.quickOpen', 'Go', 'Go to File…', ['Ctrl+P'], () => palette.open('')],
  ['workbench.commands', 'View', 'Command Palette…', ['Ctrl+Shift+P', 'F1'], () => palette.open('>')],
  ['go.line', 'Go', 'Go to Line/Column…', ['Ctrl+G'], () => palette.open(':'), hasEditor],
  ['go.symbol', 'Go', 'Go to Symbol in File…', ['Ctrl+Shift+O'], () => palette.open('@'), hasEditor],
  ['go.workspaceSymbol', 'Go', 'Go to Symbol in Project…', ['Ctrl+Alt+O'], () => palette.open('#')],
  ['go.error', 'Go', 'Go to Next Problem', ['F8'], () => lang.nextProblem(1)],
  ['go.prevError', 'Go', 'Go to Previous Problem', ['Shift+F8'], () => lang.nextProblem(-1)],
  ['view.problems', 'View', 'Show Problems', ['Ctrl+Shift+M'], () => showInspectorTab('tab-problems')],
  ['go.nextTab', 'View', 'Open Next Editor', ['Alt+PageDown'], () => ws.cycleTab(1)],
  ['go.prevTab', 'View', 'Open Previous Editor', ['Alt+PageUp'], () => ws.cycleTab(-1)],
  // layout
  ['view.sidebar', 'View', 'Toggle Sidebar', ['Ctrl+B'], () => layout.toggle('sidebar')],
  ['view.preview', 'View', 'Toggle Preview', ['Ctrl+Alt+B'], () => layout.toggle('preview')],
  ['view.tools', 'View', 'Toggle Tools (State Machines, Compiled JS, AST)', ['Ctrl+J'], () => layout.toggle('tools')],
  ['view.zen', 'View', 'Toggle Zen Mode', ['Ctrl+K Z'], () => layout.toggle('zen')],
  ['view.explorer', 'View', 'Show Explorer', ['Ctrl+Shift+E'], () => layout.showPanel('explorer')],
  ['view.search', 'View', 'Show Search', ['Ctrl+Shift+F'], () => {
    layout.showPanel('search', { focus: false });
    searchPanel.focus({ text: selectedText() || undefined, replace: false });
  }],
  ['view.resetLayout', 'View', 'Reset Layout', [], () => layout.reset()],
  ['view.focusEditor', 'View', 'Focus Active Editor', [], () => ws.activeEditor()?.ta.focus()],
  ['view.machines', 'View', 'Show State Machines & Stores', [], () => showInspectorTab('tab-machines')],
  ['view.js', 'View', 'Show Compiled JS', [], () => showInspectorTab('tab-js')],
  ['view.ast', 'View', 'Show AST', [], () => showInspectorTab('tab-ast')],
  ['view.badges', 'View', 'Toggle Topology Badges', [], () => document.getElementById('toggle-badges').click()],
  // edit
  ['edit.find', 'Edit', 'Find', ['Ctrl+F'], () => findBar.show(), hasEditor],
  ['edit.replace', 'Edit', 'Replace', ['Ctrl+H'], () => findBar.show({ replace: true }), hasEditor],
  ['edit.findNext', 'Edit', 'Find Next', ['F3'], () => findBar.next(), hasEditor],
  ['edit.findPrev', 'Edit', 'Find Previous', ['Shift+F3'], () => findBar.prev(), hasEditor],
  ['edit.replaceInFiles', 'Edit', 'Replace in Files', ['Ctrl+Shift+H'], () => {
    layout.showPanel('search', { focus: false });
    searchPanel.focus({ text: selectedText() || undefined, replace: true });
  }],
  // files
  ['file.new', 'File', 'New File…', ['Alt+N'], () => {
    layout.showPanel('explorer', { focus: false });
    ws.newFile();
  }],
  ['file.newFolder', 'File', 'New Folder…', ['Alt+Shift+N'], () => {
    layout.showPanel('explorer', { focus: false });
    ws.newFolder();
  }],
  ['file.save', 'File', 'Save All', ['Ctrl+S'], () => ws.saveAll(), null, { displayOnly: true }],
  ['file.close', 'View', 'Close Editor', ['Alt+W'], () => ws.closeActive(), hasEditor],
  ['file.reveal', 'File', 'Reveal Active File in Explorer', [], () => {
    layout.showPanel('explorer', { focus: false });
    ws.revealActive();
  }, hasEditor],
  ['file.collapse', 'File', 'Collapse Folders in Explorer', [], () => ws.collapseAll()],
  ['file.revert', 'File', 'Revert Project to Original', [], () => ws.revert(), () => ws.backendKind === 'local'],
  ['file.restoreAside', 'File', 'Restore Earlier Edits (made on an older version)', [], () => ws.restoreSetAside(), () => ws.hasSetAside],
  // project / app
  ['project.open', 'Project', 'Open Project…', [], () =>
    palette.pick({
      placeholder: 'Open a project',
      items: [...exampleSelect.options].map((o) => ({
        label: o.textContent.trim(),
        run: () => {
          exampleSelect.value = o.value;
          exampleSelect.dispatchEvent(new Event('change'));
        },
      })),
    })],
  ['preview.openNewTab', 'Preview', 'Open Current App in New Tab (Full Viewport)', [], () => {
    window.open(buildAppUrl(exampleSelect.value), '_blank', 'noopener,noreferrer');
  }],
  ['preview.openAnyNewTab', 'Preview', 'Open Example App in New Tab (Full Viewport)…', [], () =>
    palette.pick({
      placeholder: 'Open an example app full-viewport in a new tab',
      items: [...exampleSelect.options].map((o) => ({
        label: o.textContent.trim(),
        run: () => window.open(buildAppUrl(o.value), '_blank', 'noopener,noreferrer'),
      })),
    })],
  ['app.reset', 'Preview', 'Reset State (recompile and remount)', [], () => btnReset.click()],
  ['app.clearLog', 'Preview', 'Clear Event Log', [], () => btnClearLog.click()],
];
COMMANDS.push(...lang.commands);
for (const [id, category, title, keys, run, when, extra] of COMMANDS) palette.register({ id, category, title, keys, run, when: when || undefined, ...extra });

// Initial boot
if (remoteSrc) {
  const listed = [...exampleSelect.options].find((o) => o.value === `src:${remoteSrc}`);
  if (listed) {
    exampleSelect.value = listed.value;
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = remoteSrc.split('/').pop() + ' (remote)';
    exampleSelect.prepend(opt);
    exampleSelect.value = '';
  }
  loadRemote(remoteSrc);
} else {
  if (rejectedSrc) notify(LOCAL_ONLY_MESSAGE);
  examplesReady.then(() => {
    const example = params.get('example');
    const ids = examples.map((e) => e.id);
    if (example === 'scratch') {
      exampleSelect.value = 'scratch';
      openScratch();
    } else if (example && ids.includes(example)) {
      exampleSelect.value = example;
      loadExample(example);
    } else {
      // Plain visit: open the Notes app when its dev server is running on
      // this machine (only probed when the playground itself is local),
      // otherwise the first example.
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      (local ? fetch(NOTES_SRC, { method: 'HEAD', signal: AbortSignal.timeout(800) }) : Promise.reject(new Error('not local')))
        .then((r) => {
          if (!r.ok) throw new Error();
          location.replace(`?src=${encodeURIComponent(NOTES_SRC)}`);
        })
        .catch(() => {
          const first = ids.includes('todo') ? 'todo' : ids[0];
          exampleSelect.value = first;
          loadExample(first);
        });
    }
  });
}
