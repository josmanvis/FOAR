import { compileFoarProject } from '../foar-compiler.js';
import { createFoarRuntime, createI18n } from '../foar-runtime.js';
import { localUrl, LOCAL_ONLY_MESSAGE } from './local-url.js';

const mountEl = document.getElementById('app');
const editLink = document.getElementById('edit-in-playground');
const pill = document.getElementById('foar-pill');
document.getElementById('dismiss-pill')?.addEventListener('click', () => {
  pill.hidden = true;
});

const params = new URLSearchParams(location.search);
const exampleId = params.get('example') || 'todo';
const remoteSrc = localUrl(params.get('src'));

editLink.href = remoteSrc
  ? `./?src=${encodeURIComponent(remoteSrc)}`
  : `./?example=${encodeURIComponent(exampleId)}`;

let currentRuntime = null;
let activeHost = null;
let storageKey = null;
let currentExample = null;

function showError(msg) {
  mountEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'f4-error';
  box.textContent = msg;
  mountEl.appendChild(box);
}

function loadProjectFromStorage(original, key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved?.files && saved.files[original.entry]) {
      return { entry: original.entry, files: saved.files };
    }
  } catch {}
  return { entry: original.entry, files: { ...original.files } };
}

async function mountProject(project, hostUrl) {
  if (currentRuntime) {
    currentRuntime.destroy();
    currentRuntime = null;
  }
  if (activeHost) {
    activeHost.destroy?.();
    activeHost = null;
  }

  let ast;
  try {
    ast = await compileFoarProject(project);
  } catch (err) {
    const loc = err.file ? `${err.file}:${err.line}:${err.col}: ` : '';
    showError(`FOAR compile error:\n${loc}${err.reason || err.message || err}`);
    return;
  }

  let hostOpts = {};
  if (hostUrl) {
    const mod = await import(new URL(hostUrl, import.meta.url).href);
    activeHost = await mod.createHost({ createI18n, getApp: () => currentRuntime });
    hostOpts = {
      i18n: activeHost.i18n,
      bindings: activeHost.bindings,
    };
  }

  const fullBleed = Boolean(activeHost?.fullBleed);
  document.body.classList.toggle('is-fullbleed', fullBleed);

  // Full browser hash routing (`app.html?example=router#/services`) so links,
  // navigate(), replace(), refresh, and Back/Forward buttons all work natively!
  currentRuntime = createFoarRuntime(ast, mountEl, {
    badges: false,
    router: { mode: 'hash' },
    ...hostOpts,
  });
  activeHost?.attach?.(currentRuntime, mountEl);
  // for the browser console: foarApp.getContext('Library'), foarApp.getSnapshot()
  window.foarApp = currentRuntime;
}

async function boot() {
  if (params.has('src') && !remoteSrc) {
    showError(LOCAL_ONLY_MESSAGE);
    return;
  }
  if (remoteSrc) {
    // If the user opened a remote local dev app (?src=...), redirect straight
    // to the running app origin if available, or compile its source standalone.
    const res = await fetch(remoteSrc).catch(() => null);
    if (!res?.ok) {
      showError(`Could not fetch ${remoteSrc}`);
      return;
    }
    const name = remoteSrc.split('/').pop();
    document.title = `${name} — FOAR`;
    await mountProject({ entry: name, files: { [name]: await res.text() } }, null);
    return;
  }

  const list = await fetch(new URL('../examples/index.json', import.meta.url), { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);

  if (exampleId === 'scratch') {
    const starter = list.find((e) => e.id === 'starter');
    const original = {
      entry: starter?.entry ?? 'app.foar',
      files: starter?.files ?? { 'app.foar': 'view App { state Ready { render { Text("Hello") } } }\n' },
    };
    storageKey = 'foar.playground.v1.scratch';
    currentExample = { original, host: null };
    document.title = 'Scratch — FOAR';
    await mountProject(loadProjectFromStorage(original, storageKey), null);
    return;
  }

  const ex = list.find((e) => e.id === exampleId) || list[0];
  if (!ex) {
    showError(`Example "${exampleId}" not found.`);
    return;
  }
  document.title = `${ex.title} — FOAR`;
  storageKey = `foar.playground.v1.example:${ex.id}`;
  currentExample = { original: { entry: ex.entry, files: ex.files }, host: ex.host ?? null };
  await mountProject(loadProjectFromStorage(currentExample.original, storageKey), currentExample.host);
}

// Live-sync edits made in another Playground tab for the same example!
window.addEventListener('storage', (e) => {
  if (!storageKey || e.key !== storageKey || !currentExample) return;
  mountProject(loadProjectFromStorage(currentExample.original, storageKey), currentExample.host);
});

boot();
