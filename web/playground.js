import { compileFoar, extractStateMachines, generateReadableJS, compilerBackend } from './foar-compiler.js';
import { createFoarRuntime } from './foar-runtime.js';

const exampleSelect = document.getElementById('example-select');
const currentFilename = document.getElementById('current-filename');
const codeEditor = document.getElementById('code-editor');
const lineNumbers = document.getElementById('line-numbers');
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

let currentRuntime = null;
let currentMachines = [];
let debounceTimer = null;

function updateLineNumbers() {
  const count = codeEditor.value.split('\n').length;
  const nums = [];
  for (let i = 1; i <= count; i++) nums.push(i);
  lineNumbers.textContent = nums.join('\n');
}

codeEditor.addEventListener('scroll', () => {
  lineNumbers.scrollTop = codeEditor.scrollTop;
});

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
        `<span class="summary-chip">${inst.viewName}: <strong>${inst.state}</strong></span>`
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
      <span class="machine-view-name">view ${machine.viewName}</span>
      <span style="font-size:11px;color:#8b949e;">${matchingInstances.length} mounted instance${matchingInstances.length === 1 ? '' : 's'}</span>
    `;
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
      .map(([k, v]) => `<span style="color:#79c0ff">${k}</span>: ${ JSON.stringify(v) }`)
      .join(', ');
    row.innerHTML = `
      <div><strong style="color:#e6edf3">${inst.viewName}</strong> <span style="color:#3fb950">[${inst.state}]</span></div>
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

let compileSeq = 0;
async function compileAndMount(source) {
  const seq = ++compileSeq;
  const t0 = performance.now();
  try {
    const ast = await compileFoar(source);
    if (seq !== compileSeq) return; // a newer edit superseded this compile
    const elapsed = (performance.now() - t0).toFixed(2);
    const backend = compilerBackend === 'wasm' ? 'Rust→WASM' : 'Rust native';
    compilerStatus.className = 'status-pill status-ok';
    errorBanner.classList.add('hidden');

    currentMachines = extractStateMachines(ast);
    compiledJsOutput.textContent = generateReadableJS(ast);
    astOutput.textContent = JSON.stringify(ast, null, 2);

    if (currentRuntime) {
      currentRuntime.destroy();
    }

    const tMount = performance.now();
    currentRuntime = createFoarRuntime(ast, foarMount, {
      badges: true,
      onRender(snapshot) {
        scheduleInspector(snapshot);
      },
      onEffect({ viewName, state, effect, arg }) {
        const argStr = arg !== undefined ? `(${JSON.stringify(arg)})` : '()';
        appendLog(
          'effect',
          `<span class="log-tag-effect">⚡ effect</span> <strong>${viewName}.${state}.${effect}</strong>${argStr}`
        );
      },
      onTransition({ viewName, from, to, asyncCall, manual }) {
        const extra = asyncCall
          ? ` <span style="color:#d29922">[await ${asyncCall}]</span>`
          : manual
            ? ` <span style="color:#8b949e">[inspector forced]</span>`
            : '';
        appendLog(
          'transition',
          `<span class="log-tag-transition">🔀 transition</span> <strong>${viewName}</strong>: ${from} ──▶ <strong>${to}</strong>${extra}`
        );
      },
      onEmit({ viewName, event, payload }) {
        appendLog(
          'emit',
          `<span class="log-tag-emit">📡 emit</span> <strong>${viewName}</strong> ──▶ <code>on_${event}(${JSON.stringify(payload)})</code>`
        );
      },
    });
    const mountMs = (performance.now() - tMount).toFixed(2);
    compilerStatus.textContent = `● ${backend} ${elapsed}ms · mounted ${mountMs}ms`;
  } catch (err) {
    if (seq !== compileSeq) return;
    compilerStatus.textContent = '✖ Syntax Error';
    compilerStatus.className = 'status-pill status-err';
    errorBanner.textContent = err.message;
    errorBanner.classList.remove('hidden');
  }
}

async function loadExample(filename) {
  try {
    const res = await fetch(`/examples/${filename}`);
    if (!res.ok) throw new Error(`Failed to fetch ${filename}`);
    const source = await res.text();
    currentFilename.textContent = `examples/${filename}`;
    codeEditor.value = source;
    updateLineNumbers();
    eventLog.innerHTML = '';
    await compileAndMount(source);
    appendLog('info', `<span style="color:#8b949e">Loaded examples/${filename}</span>`);
  } catch (err) {
    console.error(err);
  }
}

exampleSelect.addEventListener('change', () => {
  loadExample(exampleSelect.value);
});

codeEditor.addEventListener('input', () => {
  updateLineNumbers();
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    compileAndMount(codeEditor.value);
  }, 180);
});

toggleBadges.addEventListener('change', () => {
  foarMount.classList.toggle('show-badges', toggleBadges.checked);
});

btnReset.addEventListener('click', async () => {
  eventLog.innerHTML = '';
  await compileAndMount(codeEditor.value);
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

// Initial boot
loadExample(exampleSelect.value);
