// FOAR Reactive Runtime
// ---------------------
// Compiled, retained-DOM runtime for FOAR state-machine views.
//
// Design (vs. the original "rebuild everything on every event" runtime):
//   * Every render node is compiled ONCE into a Block that owns real DOM and a
//     list of bindings. An update re-evaluates bindings and touches the DOM only
//     when a value changed. No virtual DOM, no diffing of trees.
//   * State transitions swap only the transitioning view's subtree.
//   * `List` does keyed reconciliation (item.id / item.key / index): rows are
//     reused, moved with insertBefore, and disposed when gone (no leaks).
//   * Static styles become generated CSS classes (`@hover` -> real `:hover`);
//     only ternary styles stay inline, as bindings.
//   * Production modules carry expressions and effects compiled at build time,
//     so they run under a strict Content Security Policy (no `unsafe-eval`).
//   * One delegated listener per event type on the container.
//   * Store writes are batched: N effects in one tick => one flush (microtask).
//
// Also exported: createI18n({ locale, fallback, messages }) -> { t, locale, dir, setLocale }.
//
// Public API: createFoarRuntime(ast, container, callbacks) ->
//   { renderApp, flush, getSnapshot, forceStateTransition, invokeEffect,
//     call, getContext, setContext, getHost, setLocale, getLocale, destroy }
//
// callbacks: { onRender(snapshot), onEffect(info), onTransition(info), onEmit(info),
//              bindings: { [apiName]: async fn },  // external async bindings
//              i18n: { locale, fallback, messages: { [locale]: { [key]: msg } } },
//              asyncDelay: ms,                      // simulated latency when no binding
//              badges: true }                       // render dev-only state badges per view
//
// Built into every expression and effect:
//   t(key, params)  translated string. Messages use {name} placeholders; a
//                   message may be { zero?, one, two?, few?, many?, other }
//                   picked by Intl.PluralRules with params.count.
//   t_key(key)      returns key; marks a key kept as data and translated later.
//
// Accessibility: any element takes `label:` (aria-label), `role:`, and
// `aria: { expanded: x, selected: y, ... }`. Clickable rows/text get
// tabindex=0, role=button and Enter/Space activation automatically;
// `tab_index:` overrides (roving tabindex in lists).
//
// Drag and drop: `drag: payload` makes an element draggable (`drag_text:`
// adds text/plain for other apps); `-> on_drop(Effect)` makes a drop target
// whose effect receives the payload. While dragging, the source has class
// f4-drag-source and the hovered target f4-drop-over (`@drag-source {}` /
// `@drop-over {}` in styles). on_context_menu effects receive { x, y };
// Shift+right-click is left to the browser.

const EVENT_TYPES = ['click', 'dblclick', 'input', 'change', 'submit', 'keydown', 'contextmenu', 'focusout'];
const DRAG_TYPES = ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend'];
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv']);
const EVENT_MAP = {
  on_click: 'click',
  on_double_click: 'dblclick',
  on_input: 'input',
  on_change: 'change',
  on_submit: 'submit',
  on_enter: 'keydown',
  on_context_menu: 'contextmenu',
  on_blur: 'focusout',
  on_drop: 'drop',
  on_drag_start: 'dragstart',
  on_drag_end: 'dragend',
};
const EMPTY = Object.freeze({});
const UNSET = Symbol('unset');

const BASE_CSS = [
  '.f4-row{display:flex;flex-direction:row;gap:10px;align-items:center}',
  '.f4-column{display:flex;flex-direction:column;gap:10px;align-items:stretch}',
  '.f4-text[data-clickable]{cursor:pointer}',
].join('\n');

let runtimeCounter = 0;
const random_uuid = () => Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------------------
// Expression & effect compilation
// ---------------------------------------------------------------------------
const exprCache = new Map();
const compileErrors = new Set();

/**
 * Attach functions emitted by `foar build --format js` to a program object.
 * The functions are normal module code, compiled by the browser while loading
 * the module; the runtime never has to create code dynamically for them.
 */
export function attachPrecompiled(program, compiled) {
  Object.defineProperty(program, '__foarCompiled', {
    value: compiled || {}, configurable: true, enumerable: false, writable: false,
  });
  return program;
}

function dedupe(names) {
  const out = [];
  const seen = new Set();
  for (const n of names) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

const EMPTY_SET = Object.freeze(new Set());
const STAR_SET = Object.freeze(new Set(['*']));
const ROUTE_SET = Object.freeze(new Set(['route']));
const depsCache = new Map();

// The compiler already emits JavaScript expressions. For invalidation we only
// need a conservative dependency set: extra names cause an inexpensive update;
// missing one would be incorrect. Property names and words in strings are
// therefore intentionally retained.Cached once per unique expression string.
function exprDeps(expr) {
  const key = String(expr || '');
  let cached = depsCache.get(key);
  if (cached) return cached;
  const matches = key.match(/[A-Za-z_$][\w$]*/g);
  cached = matches && matches.length ? Object.freeze(new Set(matches)) : EMPTY_SET;
  depsCache.set(key, cached);
  return cached;
}
function mergeDeps(...sets) {
  let single = null;
  let count = 0;
  for (const set of sets) {
    if (!set || set.size === 0) continue;
    if (set === STAR_SET || set.has('*')) return STAR_SET;
    single = set;
    count++;
  }
  if (count === 0) return EMPTY_SET;
  if (count === 1) return single;
  const out = new Set();
  for (const set of sets) if (set) for (const name of set) out.add(name);
  return out;
}
function blockDeps(blocks) {
  if (!blocks || !blocks.length) return EMPTY_SET;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || !b.deps || b.deps === STAR_SET || b.deps.has('*')) return STAR_SET;
  }
  if (blocks.length === 1) return blocks[0].deps;
  const out = new Set();
  for (let i = 0; i < blocks.length; i++) {
    for (const name of blocks[i].deps) out.add(name);
  }
  return out;
}
function needsUpdate(deps, changes) {
  if (!changes || changes === STAR_SET || changes.has('*') || !deps || deps === STAR_SET || deps.has('*')) return true;
  for (const name of deps) if (changes.has(name)) return true;
  return false;
}

// Compiles `expr` into fn($v, $l) where $v holds view vars (props + stores)
// and $l holds lexical locals (List bindings). Locals shadow vars.
export function compileExpr(expr, varNames = [], localNames = [], precompiled = null, globals = null) {
  if (typeof precompiled === 'function') {
    return ($v, $l) => precompiled($v, $l, globals || EMPTY);
  }
  const key = `${varNames.join(',')}|${localNames.join(',')}|${expr}`;
  let fn = exprCache.get(key);
  if (fn) return fn;
  // Destructure only names the expression mentions: keeps evaluation cheap
  // even with many stores/externs in scope.
  const words = new Set(expr.match(/[A-Za-z_$][\w$]*/g) || []);
  const locals = localNames.filter((n) => words.has(n));
  const vars = varNames.filter((n) => !localNames.includes(n) && words.has(n));
  const dv = vars.length ? `const {${vars.join(',')}} = $v;` : '';
  const dl = locals.length ? `const {${locals.join(',')}} = $l;` : '';
  try {
    fn = new Function('$v', '$l', `"use strict";${dv}${dl}return (${expr});`);
  } catch (err) {
    if (!compileErrors.has(expr)) {
      compileErrors.add(expr);
      console.error(`FOAR: cannot compile expression \`${expr}\`: ${err.message}`);
    }
    fn = () => undefined;
  }
  exprCache.set(key, fn);
  return fn;
}

const HELPERS = ['__transition', '__emit', '__asyncTransition'];

// Compiles an effect body once. Returns { fn, names, externs } where fn takes
// the values for `names`, the helpers, then the `externs` (host functions),
// and returns the store values (in storeNames order) after the body ran.
function compileEffect(eff, storeNames, propNames, externNames, cache) {
  return compileEffectWithPrecompiled(eff, storeNames, propNames, externNames, cache, null);
}

function effectKey(eff, storeNames, propNames) {
  return `${storeNames.join(',')}|${propNames.join(',')}|${(eff.params || []).map((p) => p.name).join(',')}|${eff.jsBody}`;
}

function compileEffectWithPrecompiled(eff, storeNames, propNames, externNames, cache, precompiled) {
  let compiled = cache.get(eff);
  if (compiled) return compiled;
  const paramNames = (eff.params || []).map((p) => p.name);
  const names = dedupe([...storeNames, ...propNames, ...paramNames]);
  const externs = externNames.filter((n) => !names.includes(n) && !HELPERS.includes(n));
  const staticFn = precompiled?.effects?.[effectKey(eff, storeNames, propNames)];
  if (typeof staticFn === 'function') {
    compiled = { fn: null, staticFn, names, paramNames, externs };
    cache.set(eff, compiled);
    return compiled;
  }
  const src = `"use strict";
(() => {
${eff.jsBody}
})();
return [${storeNames.join(',')}];`;
  let fn;
  try {
    fn = new Function(...names, ...HELPERS, ...externs, src);
  } catch (err) {
    console.error(`FOAR: cannot compile effect ${eff.name || 'on_exit'}: ${err.message}\n${eff.jsBody}`);
    fn = () => null;
  }
  compiled = { fn, names, paramNames, externs };
  cache.set(eff, compiled);
  return compiled;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// i18n: t(key, params) with {name} placeholders, plural objects picked by
// Intl.PluralRules (params.count), locale -> base language -> fallback lookup.
// ---------------------------------------------------------------------------
export function createI18n({ locale, fallback = 'en', messages = {} } = {}) {
  let current = locale || fallback;
  let plural = new Intl.PluralRules(current);
  let numbers = new Intl.NumberFormat(current);
  const missing = new Set();
  function lookup(key) {
    for (const tb of [messages[current], messages[current.split('-')[0]], messages[fallback]]) {
      if (tb && tb[key] !== undefined) return tb[key];
    }
    if (!missing.has(`${current}:${key}`) && Object.keys(messages).length) {
      missing.add(`${current}:${key}`);
      console.warn(`FOAR i18n: missing message "${key}" (${current})`);
    }
    return key;
  }
  function t(key, params) {
    let msg = lookup(key);
    if (msg && typeof msg === 'object') {
      const n = Number(params?.count ?? 0);
      msg = (n === 0 && msg.zero !== undefined ? msg.zero : msg[plural.select(n)]) ?? msg.other ?? key;
    }
    if (!params) return msg;
    return String(msg).replace(/\{(\w+)\}/g, (m, name) => {
      const v = params[name];
      if (v === undefined) return m;
      return typeof v === 'number' ? numbers.format(v) : String(v);
    });
  }
  return {
    t,
    get locale() { return current; },
    get dir() { return RTL.has(current.split('-')[0]) ? 'rtl' : 'ltr'; },
    get locales() { return Object.keys(messages); },
    setLocale(next) {
      current = next;
      plural = new Intl.PluralRules(current);
      numbers = new Intl.NumberFormat(current);
    },
  };
}

// ---------------------------------------------------------------------------
// Router utilities (shared by client runtime, hydration, and zero-DOM SSR)
// ---------------------------------------------------------------------------
function normalizePath(p) {
  if (!p) return '/';
  let s = String(p);
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function parseUrl(raw = '/') {
  const str = String(raw || '/');
  const hashIdx = str.indexOf('#');
  const hash = hashIdx >= 0 ? str.slice(hashIdx + 1) : '';
  const beforeHash = hashIdx >= 0 ? str.slice(0, hashIdx) : str;
  const qIdx = beforeHash.indexOf('?');
  const path = normalizePath(qIdx >= 0 ? beforeHash.slice(0, qIdx) : beforeHash);
  const query = {};
  if (qIdx >= 0) {
    const qs = beforeHash.slice(qIdx + 1);
    for (const part of qs.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const k = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
      const v = decodeURIComponent(eq >= 0 ? part.slice(eq + 1) : '');
      query[k] = v;
    }
  }
  return { path, query, hash };
}

export function matchRoute(pattern, pathname) {
  const pat = String(pattern || '').trim();
  const path = normalizePath(pathname);
  if (pat === '*' || pat === '/*') return {};
  const pSegs = normalizePath(pat).split('/').filter(Boolean);
  const uSegs = path.split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < pSegs.length; i++) {
    const ps = pSegs[i];
    if (ps.startsWith('*')) {
      const key = ps.slice(1) || 'rest';
      params[key] = uSegs.slice(i).map(decodeURIComponent).join('/');
      return params;
    }
    if (i >= uSegs.length) return null;
    if (ps.startsWith(':')) {
      params[ps.slice(1)] = decodeURIComponent(uSegs[i]);
    } else if (ps !== uSegs[i]) {
      return null;
    }
  }
  return pSegs.length === uSegs.length ? params : null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function inlineStyleToCss(key, val) {
  if (val === undefined || val === null || val === false || val === '') return '';
  if (key === 'layout') return `display:flex;flex-direction:${val === 'horizontal' ? 'row' : 'column'}`;
  if (key === 'align') return `align-items:${val}`;
  return `${key}:${val}`;
}

function buildFunctions(ast, env) {
  const fns = ast.functions || [];
  if (!fns.length) return {};
  const out = {};
  const statics = ast.__foarCompiled?.functions || EMPTY;
  const allNames = dedupe([...Object.keys(env), ...fns.map((f) => f.name)]).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  for (const f of fns) {
    const pNames = (f.params || []).map((p) => p.name);
    const staticFn = statics[f.name];
    if (typeof staticFn === 'function') {
      out[f.name] = (...args) => staticFn(args, env, out);
      continue;
    }
    const extNames = allNames.filter((n) => !pNames.includes(n));
    let raw;
    try {
      raw = new Function(...pNames, ...extNames, `"use strict";\n${f.jsBody}`);
    } catch (err) {
      console.error(`FOAR: cannot compile fn ${f.name}: ${err.message}`);
      raw = () => undefined;
    }
    out[f.name] = (...args) => {
      const vals = pNames.map((_, i) => args[i]);
      for (const n of extNames) vals.push(out[n] !== undefined ? out[n] : env[n]);
      return raw.apply(null, vals);
    };
  }
  return out;
}

function matchesKeyCombo(e, combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1));
  const wantMod = mods.has('mod');
  const wantCtrl = mods.has('ctrl') || mods.has('control');
  const wantMeta = mods.has('meta') || mods.has('cmd');
  const wantAlt = mods.has('alt') || mods.has('option');
  const wantShift = mods.has('shift');
  if (wantMod) {
    if (!(e.metaKey || e.ctrlKey)) return false;
  } else {
    if (Boolean(e.ctrlKey) !== wantCtrl) return false;
    if (Boolean(e.metaKey) !== wantMeta) return false;
  }
  if (Boolean(e.altKey) !== wantAlt) return false;
  if (Boolean(e.shiftKey) !== wantShift) return false;
  const evKey = (e.key || '').toLowerCase();
  return evKey === key || (key === 'esc' && evKey === 'escape') || (key === 'space' && evKey === ' ');
}

/**
 * Contexts in dependency order: one whose stores or lets read `Other.x` comes
 * after Other, so its initial values see Other's. Cycles keep source order.
 */
function contextsInOrder(list = []) {
  const byName = new Map(list.map((c) => [c.name, c]));
  const reads = (c) => {
    const text = [...c.stores.map((s) => s.initExpr), ...(c.derived || []).map((d) => d.expr)].join('\n');
    return list.filter((o) => o !== c && new RegExp(`\\b${o.name}\\.`).test(text)).map((o) => o.name);
  };
  const out = [];
  const state = new Map();
  const visit = (c) => {
    if (state.get(c.name)) return;
    state.set(c.name, 'visiting');
    for (const dep of reads(c)) if (!state.get(dep)) visit(byName.get(dep));
    out.push(c);
  };
  for (const c of list) visit(c);
  return out;
}

export function createFoarRuntime(ast, container, callbacks = {}) {
  const rootViewDecl = ast.views[0];
  if (!rootViewDecl) {
    container.textContent = 'No view declarations found in .foar file.';
    return null;
  }

  const rid = ++runtimeCounter;
  const staticProgram = ast.__foarCompiled || EMPTY;
  const doc = container.ownerDocument;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const viewMap = new Map(ast.views.map((v) => [v.name, v]));
  const instances = new Map(); // key -> instance (live registry)
  const HANDLERS = Symbol('f4-handlers'); // element[HANDLERS] -> { [eventType]: fn } (proxy-safe & GC-safe)
  const hosts = new Map(); // Host(name:) -> DOM node for imperative integrations
  const dragSources = new WeakMap(); // element -> () => { payload, text }
  const dropTargets = new WeakMap(); // element -> () => (payload) => void
  let dragging = null; // { payload, el }
  let dropOver = null; // element showing f4-drop-over
  const pendingGlobalChanges = new Set();
  const pendingHostMounts = [];
  let deferHostMounts = true;
  let emitDepth = 0;
  const subViewPropCache = new WeakMap();

  function flushHostMounts() {
    if (deferHostMounts || !pendingHostMounts.length) return;
    const queue = pendingHostMounts.splice(0, pendingHostMounts.length);
    for (let i = 0; i < queue.length; i++) queue[i]();
  }

  function setHost(name, el, info) {
    if (!name) return;
    const key = String(name);
    const prior = hosts.get(key);
    if (prior === el) return;
    if (prior && prior !== el) callbacks.onUnmount?.(prior, { ...info, name: key, replaced: true });
    hosts.set(key, el);
    el.dataset.f4Host = key;
    if (deferHostMounts || (!el.isConnected && !container.contains(el))) {
      pendingHostMounts.push(() => {
        if (!destroyed && hosts.get(key) === el) {
          callbacks.onMount?.(el, { ...info, name: key });
        }
      });
    } else {
      callbacks.onMount?.(el, { ...info, name: key });
    }
  }

  function clearHost(name, el, info) {
    if (!name) return;
    const key = String(name);
    if (hosts.get(key) !== el) return;
    hosts.delete(key);
    delete el.dataset.f4Host;
    callbacks.onUnmount?.(el, { ...info, name: key });
  }

  // ---- hydration state & cursor --------------------------------------------
  let hydrating = callbacks.hydrate === true;
  let initialState = callbacks.initialState || null;
  if (hydrating && !initialState) {
    const stateEl = doc.getElementById('__foar_state__');
    if (stateEl?.textContent) {
      try {
        initialState = JSON.parse(stateEl.textContent);
      } catch {}
    }
  }
  const initialInstances = initialState?.instances || initialState || null;
  const hyStack = [];
  let hyCursor = hydrating ? container.firstElementChild : null;

  function claim(tag, namespace = null) {
    if (hydrating && hyCursor && hyCursor.tagName && hyCursor.tagName.toLowerCase() === tag) {
      const el = hyCursor;
      hyCursor = el.nextElementSibling;
      return { el, claimed: true };
    }
    return { el: namespace ? doc.createElementNS(namespace, tag) : doc.createElement(tag), claimed: false };
  }
  function enterHydrate(parentEl, claimed) {
    if (!hydrating) return;
    hyStack.push(hyCursor);
    hyCursor = claimed ? parentEl.firstElementChild : null;
  }
  function leaveHydrate() {
    if (!hydrating) return;
    hyCursor = hyStack.pop() ?? null;
  }

  // ---- router --------------------------------------------------------------
  const routerCfg = callbacks.router || {};
  const routerMode =
    routerCfg.mode ||
    (callbacks.url !== undefined || routerCfg.initialPath !== undefined
      ? 'memory'
      : win && win.history && typeof win.location?.pathname === 'string' && !win.location.pathname.includes('/playground')
        ? 'history'
        : 'memory');

  function readBrowserUrl() {
    if (callbacks.url !== undefined) return callbacks.url;
    if (routerCfg.initialPath !== undefined) return routerCfg.initialPath;
    if (initialState?.route) return initialState.route;
    if (!win || !win.location) return '/';
    if (routerMode === 'hash') return (win.location.hash || '#/').replace(/^#/, '') || '/';
    if (routerMode === 'history') return `${win.location.pathname || '/'}${win.location.search || ''}${win.location.hash || ''}`;
    return '/';
  }

  const initialParsed = parseUrl(readBrowserUrl());
  const route = {
    path: initialParsed.path,
    query: initialParsed.query,
    hash: initialParsed.hash,
    params: {},
  };

  function applyRoute(nextUrl, mode = 'push') {
    const parsed = parseUrl(nextUrl);
    const full = `${parsed.path}${Object.keys(parsed.query).length ? '?' + new URLSearchParams(parsed.query).toString() : ''}${parsed.hash ? '#' + parsed.hash : ''}`;
    route.path = parsed.path;
    route.query = parsed.query;
    route.hash = parsed.hash;
    route.params = {};
    pendingGlobalChanges.add('route');
    if (win && routerMode === 'history' && win.history) {
      try {
        if (mode === 'replace') win.history.replaceState(null, '', full);
        else if (mode === 'push') win.history.pushState(null, '', full);
      } catch {}
    } else if (win && routerMode === 'hash' && win.location) {
      if (mode === 'replace') win.location.replace(`#${full}`);
      else if (mode === 'push') win.location.hash = `#${full}`;
    }
    callbacks.onNavigate?.({ ...route, url: full });
    invalidate();
  }

  const navigate = (to) => applyRoute(to, 'push');
  const replace = (to) => applyRoute(to, 'replace');
  const onPopState = () => {
    if (destroyed) return;
    const cur = routerMode === 'hash'
      ? (win.location.hash || '#/').replace(/^#/, '') || '/'
      : `${win.location.pathname || '/'}${win.location.search || ''}${win.location.hash || ''}`;
    applyRoute(cur, 'pop');
  };
  if (win && (routerMode === 'history' || routerMode === 'hash')) {
    win.addEventListener(routerMode === 'hash' ? 'hashchange' : 'popstate', onPopState);
  }

  // Attribute helper: null/undefined/false-for-non-aria removes, booleans become "true"/"false".
  function setAttr(el, name, v) {
    if (v === undefined || v === null || v === '') el.removeAttribute(name);
    else el.setAttribute(name, typeof v === 'boolean' ? String(v) : v);
  }
  const asyncTimers = new Set();
  const warned = new Set();
  const badges = callbacks.badges === true;
  // Host functions callable from .foar expressions and effects
  // (`persist(notes);`, `Text(fmt_date(note.updated))`).
  // ---- i18n ------------------------------------------------------------------
  // `callbacks.i18n` is a config ({ locale, fallback, messages }) or a shared
  // translator from createI18n() that host code also uses.
  const i18n = callbacks.i18n && typeof callbacks.i18n.t === 'function' ? callbacks.i18n : createI18n(callbacks.i18n || {});
  const t = i18n.t;
  function applyLocale() {
    container.lang = i18n.locale;
    container.dir = i18n.dir;
  }

  // t_key("a.b") marks a key that is stored now and translated later (gettext's N_()).
  const t_key = (key) => key;
  const externs = Object.assign(Object.create(null), { random_uuid, t, t_key, route, navigate, replace }, callbacks.bindings || {});
  // Generated ES modules attach static evaluators. JSON programs deliberately
  // retain the legacy fallback below for playgrounds and tooling, but a module
  // built with `--format js` never reaches `new Function`.
  const compile = (expr, varNames, localNames) =>
    compileExpr(expr, varNames, localNames, staticProgram.expressions?.[expr], externs);
  const programFns = buildFunctions(ast, externs);
  Object.assign(externs, programFns);

  // ---- shared reactive contexts (`context Name { store ...; let ...; effect ... }`) ----
  const contexts = new Map();
  const initialContexts = initialState?.contexts || null;
  for (const ctxDecl of contextsInOrder(ast.contexts)) {
    const storeNames = ctxDecl.stores.map((s) => s.name);
    const derivedNames = (ctxDecl.derived || []).map((d) => d.name);
    const varNames = dedupe([...storeNames, ...derivedNames]);
    const ctxObj = {};
    const ctxRec = { decl: ctxDecl, storeNames, derivedNames, varNames, derived: [], obj: ctxObj };
    contexts.set(ctxDecl.name, ctxRec);
    externs[ctxDecl.name] = ctxObj;
  }
  const externNames = Object.keys(externs).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const effectCache = new Map();
  let destroyed = false;
  let scheduled = false;
  let catchDepth = 0;

  function recomputeContext(ctx) {
    for (const d of ctx.derived) {
      ctx.obj[d.name] = safeEval(d.fn, ctx.obj, externs, d.expr);
    }
  }
  for (const ctx of contexts.values()) {
    const savedCtx = hydrating && initialContexts && initialContexts[ctx.decl.name];
    const extForCtx = externNames.filter((n) => !ctx.varNames.includes(n));
    for (const st of ctx.decl.stores) {
      if (savedCtx && Object.prototype.hasOwnProperty.call(savedCtx, st.name)) {
        ctx.obj[st.name] = savedCtx[st.name];
      } else {
        const fn = compile(st.initExpr, ctx.varNames, extForCtx);
        ctx.obj[st.name] = safeEval(fn, ctx.obj, externs, st.initExpr);
      }
    }
    ctx.derived = (ctx.decl.derived || []).map((d) => ({
      name: d.name,
      expr: d.expr,
      fn: compile(d.expr, ctx.varNames, extForCtx),
    }));
    recomputeContext(ctx);
    ctx.lastValues = Object.fromEntries(ctx.varNames.map((name) => [name, ctx.obj[name]]));
    const ctxNoop = () => {};
    for (const ef of ctx.decl.effects || []) {
      const compiled = compileEffectWithPrecompiled(ef, ctx.storeNames, ctx.derivedNames, externNames, effectCache, staticProgram);
      ctx.obj[ef.name] = (...args) => {
        if (destroyed) return;
        recomputeContext(ctx);
        const vals = [];
        for (let i = 0; i < compiled.names.length; i++) {
          const n = compiled.names[i];
          const pi = compiled.paramNames.indexOf(n);
          vals.push(pi !== -1 ? args[pi] : ctx.obj[n]);
        }
        vals.push(ctxNoop, ctxNoop, ctxNoop);
        for (const n of compiled.externs) vals.push(externs[n]);
        try {
          const out = compiled.staticFn
            ? compiled.staticFn(ctx.obj, args, [ctxNoop, ctxNoop, ctxNoop], externs)
            : compiled.fn.apply(null, vals);
          if (out) for (let i = 0; i < ctx.storeNames.length; i++) ctx.obj[ctx.storeNames[i]] = out[i];
          recomputeContext(ctx);
        } catch (err) {
          console.error(`FOAR: error in context effect ${ctx.decl.name}.${ef.name}:`, err);
        }
        invalidate();
      };
    }
  }

  // ---- styles ---------------------------------------------------------------
  // The Rust compiler emits all static CSS (themes, named styles, keyframes,
  // css {} blocks, @hover/@state/@media rules) into `ast.css`, and gives each
  // style a { cls, dynamic: [{ key, expr }] }. Only `dynamic` is touched at
  // runtime, as bindings; `key` may be a CSS property or a custom property.
  const NO_STYLE = Object.freeze({ cls: null, dynamic: [] });
  const compileStyle = (st) => st || NO_STYLE;
  const addClasses = (el, cls) => { if (cls) el.classList.add(...cls.split(' ')); };

  const existingSsrStyle = hydrating ? doc.querySelector('style[data-f4-ssr]') : null;
  let styleEl = existingSsrStyle;
  let ownsStyleEl = false;
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.setAttribute('data-f4-runtime', String(rid));
    styleEl.textContent = `${BASE_CSS}\n${ast.css || ''}`;
    (doc.head || doc.documentElement).appendChild(styleEl);
    ownsStyleEl = true;
  }
  applyLocale();

  function applyInlineStyle(el, key, val) {
    if (val === undefined || val === null || val === false || val === '') {
      if (key === 'layout') { el.style.removeProperty('display'); el.style.removeProperty('flex-direction'); }
      else el.style.removeProperty(key === 'align' ? 'align-items' : key);
    } else if (key === 'layout') {
      el.style.display = 'flex';
      el.style.flexDirection = val === 'horizontal' ? 'row' : 'column';
    } else if (key === 'align') {
      el.style.alignItems = val;
    } else {
      el.style.setProperty(key, String(val));
    }
  }

  // ---- per-view metadata ---------------------------------------------------
  const viewMeta = new Map();
  function metaFor(decl) {
    let m = viewMeta.get(decl);
    if (m) return m;
    const propNames = decl.params.map((p) => p.name);
    const storeNames = decl.stores.map((s) => s.name);
    const derivedNames = (decl.derived || []).map((d) => d.name);
    // `view Row(check: bool = false)`: defaults for props that aren't given
    const propDefaults = new Map(
      decl.params.filter((p) => p.default !== undefined).map((p) => [p.name, { expr: p.default, fn: compile(p.default, [], externNames) }]),
    );
    const states = new Map();
    for (const s of decl.states) {
      states.set(s.name, { decl: s, effects: new Map(s.effects.map((e) => [e.name, e])) });
    }
    m = {
      decl,
      propNames,
      propDefaults,
      storeNames,
      derivedNames,
      // `let` values, in order (a later one may use an earlier one)
      derived: null,
      varNames: dedupe([...propNames, ...storeNames, ...derivedNames]),
      // host functions visible in this view: its own props/stores win on a name clash
      externNames: externNames.filter((n) => !propNames.includes(n) && !storeNames.includes(n) && !derivedNames.includes(n)),
      states,
      firstState: decl.states[0] || null,
      hostStyle: compileStyle(decl.style),
    };
    m.derived = (decl.derived || []).map((d) => ({ name: d.name, expr: d.expr, fn: compile(d.expr, m.varNames, m.externNames) }));
    viewMeta.set(decl, m);
    return m;
  }

  /** A prop's value, or its declared default when it's undefined. */
  function propValue(meta, name, value) {
    if (value !== undefined) return value;
    const d = meta.propDefaults.get(name);
    return d ? safeEval(d.fn, {}, externs, d.expr) : undefined;
  }

  // `let` values: recomputed before every update and every effect.
  function computeDerived(inst) {
    for (const d of inst.meta.derived) inst.vars[d.name] = safeEval(d.fn, inst.vars, externs, d.expr);
  }

  // ---- evaluation helpers --------------------------------------------------
  function safeEval(fn, vars, locals, exprText) {
    try {
      return fn(vars, locals);
    } catch (err) {
      if (catchDepth > 0) throw err;
      if (!warned.has(exprText)) {
        warned.add(exprText);
        console.warn(`FOAR: error evaluating \`${exprText}\`:`, err);
      }
      return undefined;
    }
  }

  function runBindings(bindings, vars, locals) {
    for (let i = 0; i < bindings.length; i++) {
      const b = bindings[i];
      const v = safeEval(b.fn, vars, locals, b.expr);
      // `live` bindings (input value / checked) compare against the DOM itself:
      // the user can change those properties behind the runtime's back.
      if (b.live || v !== b.last) {
        b.last = v;
        b.apply(v);
      }
    }
  }

  // ---- instances -----------------------------------------------------------
  function createInstance(key, decl, props, parentEmitter, parentInst, slotCtx = null) {
    const meta = metaFor(decl);
    const vars = {};
    for (const p of meta.propNames) vars[p] = propValue(meta, p, props[p]);
    const inst = {
      key,
      viewName: decl.name,
      decl,
      meta,
      vars,
      state: meta.firstState ? meta.firstState.name : 'Initial',
      mountedState: null,
      parentEmitter,
      parentInst,
      slotCtx,
      host: null,
      badgeState: null,
      hostBindings: [],
      blocks: [],
      dirtyVars: null,
      subtreeDirty: false,
      disposed: false,
      helpers: null,
    };
    inst.helpers = makeHelpers(inst);
    const savedInst = hydrating && initialInstances && initialInstances[key];
    if (savedInst && savedInst.state && meta.states.has(savedInst.state)) {
      inst.state = savedInst.state;
    }
    const initLocals = externs;
    for (const st of decl.stores) {
      if (savedInst && savedInst.stores && Object.prototype.hasOwnProperty.call(savedInst.stores, st.name)) {
        vars[st.name] = savedInst.stores[st.name];
      } else {
        const fn = compile(st.initExpr, meta.varNames, meta.externNames);
        vars[st.name] = safeEval(fn, vars, initLocals, st.initExpr);
      }
    }
    computeDerived(inst);
    instances.set(key, inst);
    return inst;
  }

  function markDirty(inst, varName) {
    if (varName) {
      if (!inst.dirtyVars) inst.dirtyVars = new Set();
      inst.dirtyVars.add(varName);
    }
    for (let p = inst; p && !p.subtreeDirty; p = p.parentInst) {
      p.subtreeDirty = true;
    }
  }

  function makeHelpers(inst) {
    const __transition = (next) => {
      const from = inst.state;
      inst.state = next;
      markDirty(inst, null);
      callbacks.onTransition?.({ instanceKey: inst.key, viewName: inst.viewName, from, to: next });
      invalidate();
    };
    const __emit = (event, payload) => {
      markDirty(inst, '*');
      callbacks.onEmit?.({ instanceKey: inst.key, viewName: inst.viewName, event, payload });
      if (inst.parentEmitter) {
        emitDepth++;
        try {
          inst.parentEmitter(event, payload);
        } finally {
          emitDepth--;
        }
      }
    };
    const __asyncTransition = (apiName, apiArgs, next) => {
      const from = inst.state;
      inst.state = next;
      markDirty(inst, null);
      callbacks.onTransition?.({
        instanceKey: inst.key,
        viewName: inst.viewName,
        from,
        to: next,
        asyncCall: `${apiName}(${apiArgs.map((a) => JSON.stringify(a)).join(', ')})`,
      });
      invalidate();

      const finishOk = (result) => {
        if (destroyed || inst.disposed || inst.state !== next) return;
        const st = inst.meta.states.get(next);
        if (st && st.decl.onExit) {
          runEffect(inst, st.decl.onExit, result === undefined ? [] : [result]);
          invalidate();
        }
      };
      const finishErr = (err) => {
        if (destroyed || inst.disposed || inst.state !== next) return;
        const st = inst.meta.states.get(next);
        if (st && st.decl.onError) {
          runEffect(inst, st.decl.onError, [err?.message || String(err)]);
          invalidate();
        } else {
          console.error(`FOAR: binding ${apiName} failed:`, err);
          finishOk(undefined);
        }
      };
      const binding = callbacks.bindings && callbacks.bindings[apiName];
      if (typeof binding === 'function') {
        Promise.resolve()
          .then(() => binding(...apiArgs))
          .then(finishOk, finishErr);
      } else {
        const t = setTimeout(() => {
          asyncTimers.delete(t);
          finishOk(undefined);
        }, callbacks.asyncDelay ?? 1400);
        asyncTimers.add(t);
      }
    };
    return [__transition, __emit, __asyncTransition];
  }

  function runEffect(inst, eff, args) {
    const { storeNames, propNames, derivedNames } = inst.meta;
    if (derivedNames.length) computeDerived(inst);
    // derived values are read-only inputs, like props
    const c = compileEffectWithPrecompiled(eff, storeNames, derivedNames.length ? [...propNames, ...derivedNames] : propNames, externNames, effectCache, staticProgram);
    const { fn, names, paramNames } = c;
    const vals = [];
    for (let i = 0; i < names.length; i++) {
      const n = names[i];
      const pi = paramNames.indexOf(n);
      vals.push(pi !== -1 ? args[pi] : inst.vars[n]);
    }
    vals.push(inst.helpers[0], inst.helpers[1], inst.helpers[2]);
    for (const n of c.externs) vals.push(externs[n]);
    try {
      const out = c.staticFn
        ? c.staticFn(inst.vars, args, inst.helpers, externs)
        : fn.apply(null, vals);
      if (out) {
        let changed = 0;
        for (let i = 0; i < storeNames.length; i++) {
          const name = storeNames[i];
          if (inst.vars[name] !== out[i]) {
            inst.vars[name] = out[i];
            markDirty(inst, name);
            changed++;
          }
        }
        if (changed === 0 && storeNames.length > 0) {
          if (emitDepth > 0) {
            for (let i = 0; i < storeNames.length; i++) {
              const v = inst.vars[storeNames[i]];
              if (v !== null && typeof v === 'object') markDirty(inst, storeNames[i]);
            }
          } else {
            markDirty(inst, '*');
          }
        }
      }
    } catch (err) {
      console.error(`FOAR: error in effect ${inst.viewName}.${inst.state}.${eff.name || 'on_exit'}:`, err);
    }
  }

  function invokeEffect(inst, effectName, argValue) {
    if (inst.disposed) return;
    if (effectName && effectName.includes('.')) {
      const [ctxName, efName] = effectName.split('.');
      const ctx = contexts.get(ctxName);
      if (ctx && typeof ctx.obj[efName] === 'function') {
        ctx.obj[efName](argValue);
      }
      return;
    }
    const st = inst.meta.states.get(inst.state);
    if (!st) return;
    const eff = st.effects.get(effectName);
    if (!eff) return;
    callbacks.onEffect?.({
      instanceKey: inst.key,
      viewName: inst.viewName,
      state: inst.state,
      effect: effectName,
      arg: argValue,
    });
    runEffect(inst, eff, argValue === undefined ? [] : [argValue]);
    invalidate();
  }

  function mountInstance(inst) {
    const meta = inst.meta;
    const { el: host, claimed } = claim('div');
    if (!claimed) {
      host.className = `f4-view-host f4-view-${inst.viewName}`;
      addClasses(host, meta.hostStyle.cls);
      host.dataset.viewName = inst.viewName;
      host.dataset.key = inst.key; // which instance this is (host code, devtools)
    }

    enterHydrate(host, claimed);
    // Topology badge is dev tooling (4 extra nodes per view); opt-in via callbacks.badges.
    if (badges) {
      const badge = doc.createElement('div');
      badge.className = 'f4-topology-badge';
      const bView = doc.createElement('span');
      bView.className = 'f4-badge-view';
      bView.textContent = inst.viewName;
      const bDot = doc.createElement('span');
      bDot.className = 'f4-badge-dot';
      const bState = doc.createElement('span');
      bState.className = 'f4-badge-state';
      badge.append(bView, bDot, bState);
      host.appendChild(badge);
      inst.badgeState = bState;
    }
    inst.host = host;
    inst.hostBindings = meta.hostStyle.dynamic.map((d) => ({
      fn: compile(d.expr, meta.varNames, inst.meta.externNames),
      expr: d.expr,
      last: UNSET,
      apply: (v) => applyInlineStyle(host, d.key, v),
    }));
    runBindings(inst.hostBindings, inst.vars, externs);
    mountState(inst);
    leaveHydrate();
    return host;
  }

  function mountState(inst) {
    const st = inst.meta.states.get(inst.state) || (inst.meta.firstState && inst.meta.states.get(inst.meta.firstState.name));
    inst.mountedState = inst.state;
    inst.host.dataset.stateName = inst.state;
    if (inst.badgeState) inst.badgeState.textContent = inst.state;
    inst.blocks = st ? st.decl.render.map((node, i) => mountNode(node, inst, inst.meta.externNames, externs, String(i))) : [];
    for (const b of inst.blocks) {
      if (b.el.parentNode !== inst.host) inst.host.appendChild(b.el);
    }
    if (st && st.decl.onEnter) {
      const prevState = inst.state;
      const prevStores = inst.meta.storeNames.map((n) => inst.vars[n]);
      runEffect(inst, st.decl.onEnter, []);
      const changed = inst.state !== prevState || inst.meta.storeNames.some((n, i) => inst.vars[n] !== prevStores[i]);
      if (changed) invalidate();
    }
  }

  function unmountState(inst) {
    const prevSt = inst.mountedState ? inst.meta.states.get(inst.mountedState) : null;
    if (prevSt && prevSt.decl.onUnmount) {
      runEffect(inst, prevSt.decl.onUnmount, []);
    }
    for (const b of inst.blocks) {
      b.dispose();
      b.el.remove();
    }
    inst.blocks = [];
  }

  function updateInstance(inst, globalChanges = null) {
    const hasGlobals = Boolean(globalChanges && globalChanges.size > 0);
    if (!inst.subtreeDirty && !inst.dirtyVars && !hasGlobals && inst.mountedState === inst.state && !inst.slotCtx) {
      return;
    }
    let changes = inst.dirtyVars;
    if (hasGlobals) {
      changes = changes ? new Set(changes) : new Set();
      for (const g of globalChanges) changes.add(g);
    }
    inst.dirtyVars = null;
    inst.subtreeDirty = false;
    if (inst.meta.derived.length && (changes || inst.mountedState !== inst.state)) {
      for (const d of inst.meta.derived) {
        const next = safeEval(d.fn, inst.vars, externs, d.expr);
        if (next !== inst.vars[d.name]) {
          inst.vars[d.name] = next;
          if (!changes) changes = new Set();
          changes.add(d.name);
        }
      }
    }
    if (inst.mountedState !== inst.state) {
      unmountState(inst);
      mountState(inst);
      // freshly mounted blocks already reflect current vars
      runBindings(inst.hostBindings, inst.vars, externs);
      return;
    }
    if (changes && changes.size > 0 && inst.hostBindings.length > 0) {
      runBindings(inst.hostBindings, inst.vars, externs);
    }
    const childChanges = changes || EMPTY_SET;
    for (const b of inst.blocks) b.update(childChanges);
  }

  function disposeInstance(inst) {
    if (inst.disposed) return;
    const activeSt = inst.mountedState ? inst.meta.states.get(inst.mountedState) : null;
    if (activeSt && activeSt.decl.onUnmount) {
      runEffect(inst, activeSt.decl.onUnmount, []);
    }
    for (const b of inst.blocks) b.dispose();
    inst.blocks = [];
    if (inst.decl.onUnmount) {
      runEffect(inst, inst.decl.onUnmount, []);
    }
    inst.disposed = true;
    instances.delete(inst.key);
  }

  // ---- blocks --------------------------------------------------------------
  function mountNode(node, inst, localNames, locals, path) {
    if (viewMap.has(node.tag)) return mountSubView(node, inst, localNames, locals, path);
    if (node.tag === 'List') return mountList(node, inst, localNames, locals, path);
    if (node.tag === 'If') return mountIf(node, inst, localNames, locals, path);
    if (node.tag === 'Match') return mountMatch(node, inst, localNames, locals, path);
    if (node.tag === 'Router') return mountRouter(node, inst, localNames, locals, path);
    if (node.tag === 'Slot') return mountSlot(node, inst, localNames, locals, path);
    if (node.tag === 'Portal') return mountPortal(node, inst, localNames, locals, path);
    if (node.tag === 'Catch') return mountCatch(node, inst, localNames, locals, path);
    if (node.tag === 'Island') return mountIsland(node, inst, localNames, locals, path);
    return mountElement(node, inst, localNames, locals, path);
  }

  function mountIsland(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-island';
      el.style.display = 'contents';
    }
    enterHydrate(el, c.claimed);
    const children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/isl${i}`));
    for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
    leaveHydrate();
    return {
      el,
      update() { for (const ch of children) ch.update(); },
      dispose() { for (const ch of children) ch.dispose(); },
    };
  }

  function registerEvents(el, node, inst) {
    let map = null;
    for (const [evName, handlerName] of Object.entries(node.events)) {
      const domType = EVENT_MAP[evName];
      if (!domType) continue;
      map = map || {};
      switch (evName) {
        case 'on_input':
          // RichText reports its HTML; Slider reports a Number; form controls their value.
          map.input = () => invokeEffect(
            inst,
            handlerName,
            node.tag === 'RichText' ? el.innerHTML : node.tag === 'Slider' ? Number(el.value) : el.value,
          );
          break;
        case 'on_submit':
          map.submit = (e) => {
            e.preventDefault();
            invokeEffect(inst, handlerName);
          };
          break;
        case 'on_blur':
          map.focusout = () => invokeEffect(inst, handlerName, el.value);
          break;
        case 'on_context_menu':
          map.contextmenu = (e) => {
            // Shift+right-click keeps the browser's own menu (spelling, inspect...).
            if (e.shiftKey) return false;
            e.preventDefault();
            // Opened from the keyboard (Shift+F10 / Menu key): no pointer position.
            let x = e.clientX;
            let y = e.clientY;
            if (!x && !y) {
              const r = el.getBoundingClientRect();
              x = r.left + 16;
              y = r.bottom;
            }
            invokeEffect(inst, handlerName, { x, y });
          };
          break;
        case 'on_drop':
          dropTargets.set(el, () => (payload) => invokeEffect(inst, handlerName, payload));
          break;
        case 'on_drag_start':
        case 'on_drag_end':
          map[domType] = (payload) => invokeEffect(inst, handlerName, payload);
          break;
        case 'on_change':
          map.change = (e) => invokeEffect(inst, handlerName, node.tag === 'Checkbox' ? e.target.checked : e.target.value);
          break;
        case 'on_enter':
          map.keydown = (e) => {
            if (e.key !== 'Enter' || e.isComposing) return false;
            e.preventDefault();
            invokeEffect(inst, handlerName);
          };
          break;
        default:
          map[domType] = () => invokeEffect(inst, handlerName);
      }
    }
    // Clickable non-controls are reachable and operable from the keyboard.
    if (map?.click && !/^(BUTTON|INPUT|TEXTAREA|SELECT|A)$/.test(el.tagName) && !el.isContentEditable) {
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!map.keydown) {
        map.keydown = (e) => {
          if (e.target !== el || (e.key !== 'Enter' && e.key !== ' ')) return false;
          e.preventDefault();
          map.click(e);
        };
      }
    }
    if (map) el[HANDLERS] = map;
  }

  function mountElement(node, inst, localNames, locals, path) {
    const vn = inst.meta.varNames;
    const bindings = [];
    const bind = (expr, apply, live = false) =>
      bindings.push({ fn: compile(expr, vn, localNames), expr, apply, last: UNSET, live });
    let el;
    let children = null;

    switch (node.tag) {
      case 'Text': {
        const c = claim('div');
        el = c.el;
        if (!c.claimed) el.className = 'f4-text';
        if (node.args[0]) bind(node.args[0], (v) => { const s = v ?? ''; if (el.textContent !== String(s)) el.textContent = s; });
        if (node.events.on_click || node.events.on_double_click) {
          el.dataset.clickable = '';
          if (node.events.on_double_click) el.title = 'Double-click to trigger ' + node.events.on_double_click;
        }
        break;
      }
      case 'Button': {
        const c = claim('button');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-button';
          el.type = 'button';
        }
        if (node.args[0]) bind(node.args[0], (v) => { const s = v ?? ''; if (el.textContent !== String(s)) el.textContent = s; });
        else if (!c.claimed) el.textContent = 'Button';
        break;
      }
      case 'Link': {
        const c = claim('a');
        el = c.el;
        if (!c.claimed) el.className = 'f4-link';
        const hrefExpr = node.namedArgs.to !== undefined ? node.namedArgs.to : node.namedArgs.href !== undefined ? node.namedArgs.href : node.args[0];
        const replaceNav = node.namedArgs.replace !== undefined;
        let currentHref = '/';
        if (hrefExpr !== undefined) {
          bind(hrefExpr, (v) => {
            currentHref = v == null ? '/' : String(v);
            const target = routerMode === 'hash' && currentHref.startsWith('/') ? `#${currentHref}` : currentHref;
            if (el.getAttribute('href') !== target) el.setAttribute('href', target);
            const active = parseUrl(currentHref).path === route.path;
            setAttr(el, 'aria-current', active ? 'page' : null);
          }, true);
        }
        if (node.children.length > 0) {
          enterHydrate(el, c.claimed);
          children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${i}`));
          for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
          leaveHydrate();
        } else if (node.args[1] !== undefined) {
          bind(node.args[1], (v) => { const s = v ?? ''; if (el.textContent !== String(s)) el.textContent = s; });
        } else if (hrefExpr !== undefined) {
          bind(hrefExpr, (v) => { const s = v ?? ''; if (el.textContent !== String(s)) el.textContent = s; });
        }
        const navClick = (e) => {
          if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
          if (/^https?:\/\//.test(currentHref) || currentHref.startsWith('mailto:')) return false;
          e.preventDefault();
          applyRoute(currentHref, replaceNav ? 'replace' : 'push');
          if (node.events.on_click) invokeEffect(inst, node.events.on_click);
        };
        el[HANDLERS] = { click: navClick };
        break;
      }
      case 'Input': {
        const c = claim('input');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-input';
          el.type = node.namedArgs.secure !== undefined ? 'password' : 'text';
        }
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) {
          bind(valueExpr, (v) => {
            const s = v == null ? '' : String(v);
            if (el.value !== s) el.value = s;
          }, true);
        }
        if (node.namedArgs.placeholder !== undefined) {
          bind(node.namedArgs.placeholder, (v) => { el.placeholder = v ?? ''; });
        }
        break;
      }
      case 'TextArea': {
        const c = claim('textarea');
        el = c.el;
        if (!c.claimed) el.className = 'f4-textarea';
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) {
          bind(valueExpr, (v) => {
            const s = v == null ? '' : String(v);
            if (el.value !== s) el.value = s;
          }, true);
        }
        if (node.namedArgs.placeholder !== undefined) {
          bind(node.namedArgs.placeholder, (v) => { el.placeholder = v ?? ''; });
        }
        break;
      }
      case 'Checkbox': {
        const c = claim('input');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-checkbox';
          el.type = 'checkbox';
        }
        if (node.namedArgs.checked !== undefined) {
          bind(node.namedArgs.checked, (v) => {
            const ch = Boolean(v);
            if (el.checked !== ch) el.checked = ch;
          }, true);
        }
        break;
      }
      case 'RichText': {
        const c = claim('div');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-richtext';
          el.contentEditable = 'true';
          el.setAttribute('role', 'textbox');
          el.setAttribute('aria-multiline', 'true');
          el.spellcheck = true;
        }
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) {
          bind(valueExpr, (v) => {
            const s = v == null ? '' : String(v);
            if (el.innerHTML !== s) el.innerHTML = s;
          }, true);
        }
        if (node.namedArgs.placeholder !== undefined) {
          bind(node.namedArgs.placeholder, (v) => { el.dataset.placeholder = v ?? ''; });
        }
        if (node.namedArgs.editable !== undefined) {
          bind(node.namedArgs.editable, (v) => {
            el.contentEditable = v ? 'true' : 'false';
            el.setAttribute('aria-readonly', String(!v));
          });
        }
        break;
      }
      case 'Image': {
        const c = claim('img');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-image';
          el.decoding = 'async';
          el.loading = 'lazy';
        }
        const srcExpr = node.namedArgs.src !== undefined ? node.namedArgs.src : node.args[0];
        if (srcExpr !== undefined) {
          bind(srcExpr, (v) => {
            if (v) {
              el.src = v;
              el.hidden = false;
            } else {
              el.removeAttribute('src');
              el.hidden = true;
            }
          });
        }
        if (node.namedArgs.alt !== undefined) bind(node.namedArgs.alt, (v) => { el.alt = v ?? ''; });
        break;
      }
      case 'Spinner': {
        const c = claim('div');
        el = c.el;
        let txt;
        if (!c.claimed) {
          el.className = 'f4-spinner-wrap';
          const ring = doc.createElement('div');
          ring.className = 'f4-spinner-ring';
          txt = doc.createElement('span');
          el.append(ring, txt);
        } else {
          txt = el.querySelector('span') || el.appendChild(doc.createElement('span'));
        }
        if (node.args[0]) bind(node.args[0], (v) => { txt.textContent = v ?? ''; });
        else if (!c.claimed) txt.textContent = 'Loading...';
        break;
      }
      case 'Host': {
        const c = claim('div');
        el = c.el;
        if (!c.claimed) el.className = 'f4-host';
        enterHydrate(el, c.claimed);
        children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${i}`));
        for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
        leaveHydrate();
        break;
      }
      case 'Video': {
        const c = claim('video');
        el = c.el;
        if (!c.claimed) el.className = 'f4-video';
        const srcExpr = node.namedArgs.src !== undefined ? node.namedArgs.src : node.args[0];
        if (srcExpr !== undefined) bind(srcExpr, (v) => setAttr(el, 'src', v));
        if (node.namedArgs.poster !== undefined) bind(node.namedArgs.poster, (v) => setAttr(el, 'poster', v));
        if (node.namedArgs.preload !== undefined) bind(node.namedArgs.preload, (v) => setAttr(el, 'preload', v));
        for (const name of ['controls', 'autoplay', 'loop', 'muted', 'playsinline']) {
          if (node.namedArgs[name] !== undefined) bind(node.namedArgs[name], (v) => {
            const yes = Boolean(v);
            const prop = name === 'playsinline' ? 'playsInline' : name;
            el[prop] = yes;
            if (yes) el.setAttribute(name, ''); else el.removeAttribute(name);
          });
        }
        break;
      }
      case 'Canvas': {
        const c = claim('canvas');
        el = c.el;
        if (!c.claimed) el.className = 'f4-canvas';
        for (const name of ['width', 'height']) {
          if (node.namedArgs[name] !== undefined) bind(node.namedArgs[name], (v) => {
            const n = Number(v);
            if (Number.isFinite(n)) {
              if (el[name] !== n) el[name] = n;
              el.setAttribute(name, String(n));
            }
          });
        }
        break;
      }
      case 'Svg': {
        const c = claim('svg', 'http://www.w3.org/2000/svg');
        el = c.el;
        if (!c.claimed) {
          el.setAttribute('class', 'f4-svg');
          el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        }
        for (const [name, attr] of [['view_box', 'viewBox'], ['width', 'width'], ['height', 'height'], ['preserve_aspect_ratio', 'preserveAspectRatio']]) {
          if (node.namedArgs[name] !== undefined) bind(node.namedArgs[name], (v) => setAttr(el, attr, v));
        }
        break;
      }
      case 'Form': {
        const c = claim('form');
        el = c.el;
        if (!c.claimed) el.className = 'f4-form';
        enterHydrate(el, c.claimed);
        children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${i}`));
        for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
        leaveHydrate();
        break;
      }
      case 'Select': {
        const c = claim('select');
        el = c.el;
        if (!c.claimed) el.className = 'f4-select';
        enterHydrate(el, c.claimed);
        children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${i}`));
        for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
        leaveHydrate();
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) {
          bind(valueExpr, (v) => {
            const s = v == null ? '' : String(v);
            if (el.value !== s) el.value = s;
          }, true);
        }
        break;
      }
      case 'Option': {
        const c = claim('option');
        el = c.el;
        if (!c.claimed) el.className = 'f4-option';
        const valExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        const lblExpr = node.namedArgs.value !== undefined ? (node.args[0] ?? valExpr) : (node.args[1] ?? node.args[0]);
        if (valExpr !== undefined) bind(valExpr, (v) => { el.value = v == null ? '' : String(v); });
        if (lblExpr !== undefined) bind(lblExpr, (v) => { el.textContent = v ?? ''; });
        break;
      }
      case 'Slider': {
        const c = claim('input');
        el = c.el;
        if (!c.claimed) {
          el.className = 'f4-slider';
          el.type = 'range';
        }
        if (node.namedArgs.min !== undefined) bind(node.namedArgs.min, (v) => setAttr(el, 'min', v == null ? null : String(v)));
        if (node.namedArgs.max !== undefined) bind(node.namedArgs.max, (v) => setAttr(el, 'max', v == null ? null : String(v)));
        if (node.namedArgs.step !== undefined) bind(node.namedArgs.step, (v) => setAttr(el, 'step', v == null ? null : String(v)));
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) {
          bind(valueExpr, (v) => {
            const s = v == null ? '0' : String(v);
            if (el.value !== s) el.value = s;
          }, true);
        }
        break;
      }
      case 'Progress': {
        const c = claim('progress');
        el = c.el;
        if (!c.claimed) el.className = 'f4-progress';
        if (node.namedArgs.max !== undefined) bind(node.namedArgs.max, (v) => setAttr(el, 'max', v == null ? null : String(v)));
        const valueExpr = node.namedArgs.value !== undefined ? node.namedArgs.value : node.args[0];
        if (valueExpr !== undefined) bind(valueExpr, (v) => { el.value = Number(v ?? 0); });
        break;
      }
      case 'Row':
      case 'Column': {
        const c = claim('div');
        el = c.el;
        if (!c.claimed) el.className = node.tag === 'Row' ? 'f4-row' : 'f4-column';
        enterHydrate(el, c.claimed);
        children = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${i}`));
        for (const ch of children) if (ch.el.parentNode !== el) el.appendChild(ch.el);
        leaveHydrate();
        break;
      }
      default: {
        const c = claim('div');
        el = c.el;
        if (!c.claimed) el.textContent = `[Unknown element: ${node.tag}]`;
      }
    }

    const sc = compileStyle(node.style);
    addClasses(el, sc.cls);
    for (const d of sc.dynamic) bind(d.expr, (v) => applyInlineStyle(el, d.key, v));
    const na = node.namedArgs;
    if (na.title !== undefined && node.tag !== 'Image') {
      // An icon button's tooltip is also its accessible name unless `label:` says otherwise.
      const nameFromTitle = node.tag === 'Button' && na.label === undefined;
      bind(na.title, (v) => {
        if (v) el.title = v;
        else el.removeAttribute('title');
        if (nameFromTitle) setAttr(el, 'aria-label', v);
      });
    }
    if (na.label !== undefined) bind(na.label, (v) => setAttr(el, 'aria-label', v));
    if (na.role !== undefined) bind(na.role, (v) => setAttr(el, 'role', v));
    if (na.tab_index !== undefined) bind(na.tab_index, (v) => setAttr(el, 'tabindex', v == null ? v : String(v)));
    if (na.id !== undefined) bind(na.id, (v) => setAttr(el, 'id', v));
    if (na.disabled !== undefined) {
      bind(na.disabled, (v) => {
        const dis = Boolean(v);
        if ('disabled' in el) el.disabled = dis;
        setAttr(el, 'aria-disabled', dis ? 'true' : null);
      });
    }
    if (na.class !== undefined) {
      let prevExtra = [];
      bind(na.class, (v) => {
        for (const cls of prevExtra) el.classList.remove(cls);
        prevExtra = v ? String(v).split(/\s+/).filter(Boolean) : [];
        for (const cls of prevExtra) el.classList.add(cls);
      });
    }
    if (na.aria !== undefined) {
      let prev = [];
      bind(na.aria, (obj) => {
        const keys = obj ? Object.keys(obj) : [];
        for (const k of prev) if (!keys.includes(k)) el.removeAttribute(`aria-${k.replace(/_/g, '-')}`);
        for (const k of keys) setAttr(el, `aria-${k.replace(/_/g, '-')}`, obj[k]);
        prev = keys;
      });
    }
    let hostName = null;
    if (node.tag === 'Host') {
      const hostExpr = na.name !== undefined ? na.name : na.ref !== undefined ? na.ref : na.id;
      if (hostExpr !== undefined) {
        const hostInfo = { instanceKey: inst.key, viewName: inst.viewName, path };
        bind(hostExpr, (v) => {
          const next = v == null || v === '' ? null : String(v);
          if (hostName === next) return;
          clearHost(hostName, el, hostInfo);
          hostName = next;
          setHost(hostName, el, hostInfo);
        });
      }
    }
    if (na.drag !== undefined) {
      const dragFn = compile(na.drag, vn, localNames);
      const textFn = na.drag_text !== undefined ? compile(na.drag_text, vn, localNames) : null;
      el.setAttribute('draggable', 'true');
      dragSources.set(el, () => ({
        payload: safeEval(dragFn, inst.vars, locals, na.drag),
        text: textFn ? safeEval(textFn, inst.vars, locals, na.drag_text) : '',
      }));
    }
    if (node.tag !== 'Link') registerEvents(el, node, inst);
    runBindings(bindings, inst.vars, locals);
    if (node.namedArgs.autofocus !== undefined) {
      const af = compile(node.namedArgs.autofocus, vn, localNames);
      if (safeEval(af, inst.vars, locals, node.namedArgs.autofocus)) {
        queueMicrotask(() => {
          if (!el.isConnected) return;
          el.focus();
          if (node.tag === 'Input' && el.value) el.select(); // rename-style: select existing text
        });
      }
    }

    let ownDeps = bindings.length === 0
      ? EMPTY_SET
      : bindings.length === 1
        ? exprDeps(bindings[0].expr)
        : mergeDeps(...bindings.map((b) => exprDeps(b.expr)));
    if (node.tag === 'Link') ownDeps = mergeDeps(ownDeps, ROUTE_SET);
    const deps = !children || children.length === 0
      ? ownDeps
      : mergeDeps(ownDeps, blockDeps(children));

    return {
      el,
      deps,
      update(changes) {
        if (changes && !needsUpdate(deps, changes)) return;
        if (!changes || needsUpdate(ownDeps, changes)) runBindings(bindings, inst.vars, locals);
        if (children) for (const c of children) c.update(changes);
      },
      dispose() {
        if (children) for (const c of children) c.dispose();
        if (node.tag === 'Host') clearHost(hostName, el, { instanceKey: inst.key, viewName: inst.viewName, path });
      },
    };
  }

  function mountSubView(node, inst, localNames, locals, path) {
    const childDecl = viewMap.get(node.tag);
    const vn = inst.meta.varNames;
    let propFns;
    const cached = subViewPropCache.get(node);
    const localKey = localNames.join(',');
    if (cached && cached.localKey === localKey) {
      propFns = cached.propFns;
    } else {
      propFns = [];
      node.args.forEach((expr, i) => {
        const p = childDecl.params[i];
        if (p) propFns.push({ name: p.name, fn: compile(expr, vn, localNames), expr, deps: exprDeps(expr) });
      });
      for (const [name, expr] of Object.entries(node.namedArgs)) {
        if (name === 'slot') continue;
        propFns.push({ name, fn: compile(expr, vn, localNames), expr, deps: exprDeps(expr) });
      }
      subViewPropCache.set(node, { localKey, propFns });
    }
    const props = {};
    for (let i = 0; i < propFns.length; i++) {
      const p = propFns[i];
      props[p.name] = safeEval(p.fn, inst.vars, locals, p.expr);
    }

    const emitter = (event, payload) => {
      const handlerName = node.events[`on_${event}`];
      if (handlerName) invokeEffect(inst, handlerName, payload);
    };
    const slotCtx = node.children && node.children.length
      ? { nodes: node.children, inst, localNames, locals, path }
      : null;
    const child = createInstance(`${inst.key}/${path}`, childDecl, props, emitter, inst, slotCtx);
    const el = mountInstance(child);

    return {
      el,
      update(changes) {
        const forceObjectProps = Boolean(changes && (changes === STAR_SET || changes.has('*')));
        for (let i = 0; i < propFns.length; i++) {
          const p = propFns[i];
          if (changes && !needsUpdate(p.deps, changes)) continue;
          const v = propValue(child.meta, p.name, safeEval(p.fn, inst.vars, locals, p.expr));
          if (v !== child.vars[p.name] || (forceObjectProps && v !== null && typeof v === 'object')) {
            child.vars[p.name] = v;
            markDirty(child, p.name);
          }
        }
        if (
          child.subtreeDirty ||
          child.dirtyVars ||
          child.mountedState !== child.state ||
          (pendingGlobalForFlush && pendingGlobalForFlush.size > 0) ||
          child.slotCtx
        ) {
          updateInstance(child, pendingGlobalForFlush);
        }
      },
      dispose() {
        disposeInstance(child);
      },
    };
  }

  function childSlotName(ch, slotInst, slotLocalNames, slotLocals) {
    const expr = ch.namedArgs && ch.namedArgs.slot;
    if (expr === undefined) return 'default';
    const fn = compile(expr, slotInst.meta.varNames, slotLocalNames);
    const v = safeEval(fn, slotInst.vars, slotLocals, expr);
    return v == null || v === '' ? 'default' : String(v);
  }

  // Slot() / Slot(name: "header") { fallback }: projects caller's children
  // into the child view while keeping them bound to the caller's scope & events.
  function mountSlot(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-slot';
      el.style.display = 'contents';
    }
    const nameExpr = node.namedArgs.name !== undefined ? node.namedArgs.name : node.args[0];
    const wanted = nameExpr !== undefined
      ? String(safeEval(compile(nameExpr, inst.meta.varNames, localNames), inst.vars, locals, nameExpr) ?? 'default')
      : 'default';
    let blocks = [];
    enterHydrate(el, c.claimed);
    const ctx = inst.slotCtx;
    const projected = ctx
      ? ctx.nodes.filter((ch) => childSlotName(ch, ctx.inst, ctx.localNames, ctx.locals) === wanted)
      : [];
    if (projected.length > 0) {
      blocks = projected.map((ch, i) => mountNode(ch, ctx.inst, ctx.localNames, ctx.locals, `${ctx.path}/slot-${wanted}/${i}`));
    } else if (node.children && node.children.length > 0) {
      blocks = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/fallback/${i}`));
    }
    for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
    leaveHydrate();
    return {
      el,
      update() {
        for (const b of blocks) b.update();
      },
      dispose() {
        for (const b of blocks) b.dispose();
        blocks = [];
      },
    };
  }

  // Portal(target: "#modal-root") { ... }: renders children into another DOM
  // container (default: document.body) with full event delegation and cleanup.
  function mountPortal(node, inst, localNames, locals, path) {
    const c = claim('div');
    const anchor = c.el;
    if (c.claimed && anchor.classList.contains('f4-portal')) {
      anchor.textContent = '';
    }
    anchor.className = 'f4-portal-anchor';
    anchor.style.display = 'none';

    const targetExpr = node.namedArgs.target !== undefined ? node.namedArgs.target : node.args[0];
    const selector = targetExpr !== undefined
      ? safeEval(compile(targetExpr, inst.meta.varNames, localNames), inst.vars, locals, targetExpr)
      : 'body';
    const targetEl = (selector && selector !== 'body' ? doc.querySelector(String(selector)) : null) || doc.body || container;
    const portalRoot = doc.createElement('div');
    portalRoot.className = 'f4-portal-root';
    portalRoot.dataset.portalTarget = String(selector || 'body');
    targetEl.appendChild(portalRoot);

    for (const type of EVENT_TYPES) portalRoot.addEventListener(type, dispatch);
    for (const type of DRAG_TYPES) portalRoot.addEventListener(type, onDrag);

    // Portals live outside `container`, so mount their children fresh (not claiming inside container).
    const wasHydrating = hydrating;
    hydrating = false;
    const blocks = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/portal/${i}`));
    for (const b of blocks) if (b.el.parentNode !== portalRoot) portalRoot.appendChild(b.el);
    hydrating = wasHydrating;

    return {
      el: anchor,
      update(changes) {
        for (const b of blocks) b.update(changes);
      },
      dispose() {
        for (const b of blocks) b.dispose();
        for (const type of EVENT_TYPES) portalRoot.removeEventListener(type, dispatch);
        for (const type of DRAG_TYPES) portalRoot.removeEventListener(type, onDrag);
        portalRoot.remove();
      },
    };
  }

  // Catch { ... } Fallback { err => ... }: isolates runtime errors in its
  // subtree and renders Fallback with `{ message, view }` without crashing siblings.
  function mountCatch(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-catch';
      el.style.display = 'contents';
    }
    let failed = false;
    let blocks = [];
    let fallbackLocals = null;
    const fbNames = node.fallbackBinding ? dedupe([...localNames, node.fallbackBinding]) : localNames;

    function clearBlocks() {
      for (const b of blocks) {
        b.dispose();
        b.el.remove();
      }
      blocks = [];
    }

    function showFallback(err) {
      clearBlocks();
      failed = true;
      const errObj = { message: err?.message || String(err), view: inst.viewName };
      callbacks.onError?.(errObj, err);
      if (!node.elseChildren || !node.elseChildren.length) return;
      fallbackLocals = Object.create(locals || null);
      if (node.fallbackBinding) fallbackLocals[node.fallbackBinding] = errObj;
      blocks = node.elseChildren.map((ch, i) => mountNode(ch, inst, fbNames, fallbackLocals, `${path}/fallback/${i}`));
      for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
    }

    enterHydrate(el, c.claimed);
    catchDepth++;
    try {
      blocks = node.children.map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/try/${i}`));
      for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
    } catch (err) {
      catchDepth--;
      leaveHydrate();
      showFallback(err);
      return {
        el,
        update(changes) {
          for (const b of blocks) b.update(changes);
        },
        dispose() {
          for (const b of blocks) b.dispose();
          blocks = [];
        },
      };
    }
    catchDepth--;
    leaveHydrate();

    return {
      el,
      update(changes) {
        if (failed) {
          for (const b of blocks) b.update(changes);
          return;
        }
        catchDepth++;
        try {
          for (const b of blocks) b.update(changes);
        } catch (err) {
          catchDepth--;
          showFallback(err);
          return;
        }
        catchDepth--;
      },
      dispose() {
        for (const b of blocks) b.dispose();
        blocks = [];
      },
    };
  }

  function itemKey(item, index) {
    if (item !== null && typeof item === 'object') {
      if (item.id !== undefined) return `i:${item.id}`;
      if (item.key !== undefined) return `k:${item.key}`;
      return `n:${index}`;
    }
    if (typeof item === 'string' || typeof item === 'number') return `v:${item}`;
    return `n:${index}`;
  }

  // If(cond) { children }: mounts children while cond is truthy. The wrapper
  // is `display: contents`, so it does not affect layout.
  // If(cond) { … } Else { … }: one branch is mounted at a time; switching
  // branches swaps DOM, staying on one only updates its bindings.
  function mountIf(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-if';
      el.style.display = 'contents';
    }
    const expr = node.args[0] !== undefined ? node.args[0] : 'false';
    const fn = compile(expr, inst.meta.varNames, localNames);
    const branches = [node.children, node.elseChildren || null];
    let shown = -1;
    let blocks = null;
    function update(first = false, changes = null) {
      const want = safeEval(fn, inst.vars, locals, expr) ? 0 : branches[1] ? 1 : -1;
      if (want === shown) {
        if (blocks) for (const b of blocks) b.update(changes);
        return;
      }
      if (blocks) {
        for (const b of blocks) {
          b.dispose();
          b.el.remove();
        }
        blocks = null;
      }
      shown = want;
      if (want >= 0) {
        if (first) enterHydrate(el, c.claimed);
        blocks = branches[want].map((ch, i) => mountNode(ch, inst, localNames, locals, `${path}/${want ? 'else' : 'if'}${i}`));
        for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
        if (first) leaveHydrate();
      }
    }
    update(true, null);
    return {
      el,
      update: (changes) => update(false, changes),
      dispose() {
        if (blocks) for (const b of blocks) b.dispose();
        blocks = null;
      },
    };
  }

  // Match(value) { pattern => … }: the compiler made each arm's test an
  // expression over `__m` (and the arm's binding). The first arm whose test
  // holds is mounted; it is kept (and updated) until another arm wins.
  function mountMatch(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-match';
      el.style.display = 'contents';
    }
    const expr = node.args[0];
    const fn = compile(expr, inst.meta.varNames, localNames);
    const arms = node.arms.map((a, i) => {
      const names = a.binding ? [...localNames, '__m', a.binding] : [...localNames, '__m'];
      return { arm: a, names, test: compile(a.test, inst.meta.varNames, names), path: `${path}/arm${i}` };
    });
    let current = -1;
    let armLocals = null;
    let blocks = null;
    function update(first = false, changes = null) {
      const value = safeEval(fn, inst.vars, locals, expr);
      let pick = -1;
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i];
        const scope = { ...locals, __m: value };
        if (a.arm.binding) scope[a.arm.binding] = a.arm.bindingExpr === '__m.value' ? value?.value : value;
        if (safeEval(a.test, inst.vars, scope, a.arm.test)) {
          pick = i;
          break;
        }
      }
      if (pick === current && blocks) {
        const prevVal = armLocals.__m;
        armLocals.__m = value;
        let armChanges = changes;
        if (arms[pick].arm.binding) {
          const nextBind = arms[pick].arm.bindingExpr === '__m.value' ? value?.value : value;
          if (armLocals[arms[pick].arm.binding] !== nextBind) {
            armLocals[arms[pick].arm.binding] = nextBind;
            if (armChanges) armChanges = mergeDeps(armChanges, new Set([arms[pick].arm.binding, '__m']));
          }
        } else if (prevVal !== value && armChanges) {
          armChanges = mergeDeps(armChanges, new Set(['__m']));
        }
        for (const b of blocks) b.update(armChanges);
        return;
      }
      if (blocks) {
        for (const b of blocks) {
          b.dispose();
          b.el.remove();
        }
        blocks = null;
      }
      current = pick;
      if (pick < 0) return;
      const a = arms[pick];
      armLocals = Object.create(locals || null);
      armLocals.__m = value;
      if (a.arm.binding) armLocals[a.arm.binding] = a.arm.bindingExpr === '__m.value' ? value?.value : value;
      if (first) enterHydrate(el, c.claimed);
      blocks = a.arm.children.map((ch, i) => mountNode(ch, inst, a.names, armLocals, `${a.path}/${i}`));
      for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
      if (first) leaveHydrate();
    }
    update(true, null);
    return {
      el,
      update: (changes) => update(false, changes),
      dispose() {
        if (blocks) for (const b of blocks) b.dispose();
        blocks = null;
      },
    };
  }

  // Router { Route("/orders/:id") { params => ... } Route("*") { ... } }
  function mountRouter(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-router';
      el.style.display = 'contents';
    }
    const routes = node.children
      .filter((ch) => ch.tag === 'Route')
      .map((r, i) => {
        const patExpr = r.namedArgs.path !== undefined ? r.namedArgs.path : r.args[0];
        return {
          node: r,
          patFn: compile(patExpr, inst.meta.varNames, localNames),
          patExpr,
          binding: r.listBinding,
          names: r.listBinding ? dedupe([...localNames, r.listBinding]) : localNames,
          path: `${path}/route${i}`,
        };
      });
    let current = -1;
    let routeLocals = null;
    let blocks = null;
    function update(first = false, changes = null) {
      let pick = -1;
      let matchedParams = {};
      for (let i = 0; i < routes.length; i++) {
        const pat = safeEval(routes[i].patFn, inst.vars, locals, routes[i].patExpr);
        const m = matchRoute(pat, route.path);
        if (m) {
          pick = i;
          matchedParams = m;
          break;
        }
      }
      route.params = matchedParams;
      if (pick === current && blocks) {
        let routeChanges = changes;
        if (routes[pick].binding) {
          routeLocals[routes[pick].binding] = matchedParams;
          if (routeChanges && routeChanges.has('route')) {
            routeChanges = mergeDeps(routeChanges, new Set([routes[pick].binding]));
          }
        }
        for (const b of blocks) b.update(routeChanges);
        return;
      }
      if (blocks) {
        for (const b of blocks) {
          b.dispose();
          b.el.remove();
        }
        blocks = null;
      }
      current = pick;
      if (pick < 0) return;
      const r = routes[pick];
      routeLocals = Object.create(locals || null);
      if (r.binding) routeLocals[r.binding] = matchedParams;
      if (first) enterHydrate(el, c.claimed);
      blocks = r.node.children.map((ch, i) => mountNode(ch, inst, r.names, routeLocals, `${r.path}/${i}`));
      for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
      if (first) leaveHydrate();
    }
    update(true, null);
    return {
      el,
      update: (changes) => update(false, changes),
      dispose() {
        if (blocks) for (const b of blocks) b.dispose();
        blocks = null;
      },
    };
  }


  function mountList(node, inst, localNames, locals, path) {
    const c = claim('div');
    const el = c.el;
    if (!c.claimed) {
      el.className = 'f4-list';
      addClasses(el, compileStyle(node.style).cls);
    }

    const itemsFn = compile(node.listExpr, inst.meta.varNames, localNames);
    const emptyExpr = node.namedArgs && node.namedArgs.empty;
    const emptyFn = emptyExpr !== undefined ? compile(emptyExpr, inst.meta.varNames, localNames) : null;
    const binding = node.listBinding;
    const bindingSet = binding ? Object.freeze(new Set([binding])) : null;
    const childLocalNames = binding ? dedupe([...localNames, binding]) : localNames;
    const rows = new Map(); // key -> { locals, blocks, item }
    let emptyEl = null;
    const seen = new Set();
    // role / label / aria on the list container (e.g. role: "listbox")
    const attrFns = [];
    for (const [arg, attr] of [['role', 'role'], ['label', 'aria-label']]) {
      const ex = node.namedArgs?.[arg];
      if (ex !== undefined) attrFns.push({ attr, ex, fn: compile(ex, inst.meta.varNames, localNames) });
    }
    const ariaEx = node.namedArgs?.aria;
    const ariaFn = ariaEx !== undefined ? compile(ariaEx, inst.meta.varNames, localNames) : null;
    const ownDeps = mergeDeps(
      exprDeps(node.listExpr),
      emptyExpr !== undefined ? exprDeps(emptyExpr) : null,
      ...attrFns.map((a) => exprDeps(a.ex)),
      ariaEx !== undefined ? exprDeps(ariaEx) : null,
    );
    // A list container can take events too (e.g. on_context_menu on its background).
    if (node.events && Object.keys(node.events).length) registerEvents(el, node, inst);

    function update(changes = null) {
      if (changes && !needsUpdate(ownDeps, changes)) {
        for (const row of rows.values()) {
          for (const b of row.blocks) b.update(changes);
        }
        return;
      }
      for (const a of attrFns) setAttr(el, a.attr, safeEval(a.fn, inst.vars, locals, a.ex));
      if (ariaFn) {
        const obj = safeEval(ariaFn, inst.vars, locals, ariaEx) || {};
        for (const k of Object.keys(obj)) setAttr(el, `aria-${k.replace(/_/g, '-')}`, obj[k]);
      }
      let items = safeEval(itemsFn, inst.vars, locals, node.listExpr);
      if (!Array.isArray(items)) items = items == null ? [] : Array.from(items);

      if (items.length === 0) {
        if (!emptyEl) {
          emptyEl = doc.createElement('div');
          emptyEl.className = 'f4-list-empty';
        }
        const msg = emptyFn ? safeEval(emptyFn, inst.vars, locals, emptyExpr) : 'No matching items.';
        emptyEl.textContent = msg ?? '';
        emptyEl.hidden = msg == null || msg === '';
      } else if (emptyEl && emptyEl.parentNode) {
        emptyEl.remove();
      }

      seen.clear();
      const order = new Array(items.length);
      let orderChanged = rows.size !== items.length;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let key = itemKey(item, i);
        if (seen.has(key)) key = `${key}#${i}`;
        seen.add(key);
        order[i] = key;
        let row = rows.get(key);
        if (!row) {
          orderChanged = true;
          const rl = Object.create(locals);
          if (binding) rl[binding] = item;
          row = { locals: rl, blocks: null, item, index: i };
          row.blocks = node.children.map((c, ci) => mountNode(c, inst, childLocalNames, rl, `${path}/${key}/${ci}`));
          rows.set(key, row);
        } else {
          if (row.index !== i) {
            orderChanged = true;
            row.index = i;
          }
          const sameItem = row.item === item;
          row.item = item;
          if (binding) row.locals[binding] = item;
          const rowChanges = sameItem
            ? changes
            : changes && bindingSet
              ? mergeDeps(changes, bindingSet)
              : bindingSet;
          for (const b of row.blocks) b.update(rowChanges);
        }
      }

      for (const [key, row] of rows) {
        if (!seen.has(key)) {
          orderChanged = true;
          for (const b of row.blocks) {
            b.dispose();
            b.el.remove();
          }
          rows.delete(key);
        }
      }

      if (items.length === 0) {
        if (!emptyEl.parentNode) el.appendChild(emptyEl);
        return;
      }
      if (!orderChanged) return;
      // Single forward pass: place each desired element at the cursor.
      // Use moveBefore() where available for already-connected row nodes so the
      // browser preserves focus, animations, media playback, and iframe state.
      const canMove = typeof el.moveBefore === 'function';
      let cursor = el.firstChild;
      for (let i = 0; i < order.length; i++) {
        const blocks = rows.get(order[i]).blocks;
        for (let j = 0; j < blocks.length; j++) {
          const n = blocks[j].el;
          if (n === cursor) cursor = cursor.nextSibling;
          else if (canMove && n.parentNode === el) el.moveBefore(n, cursor);
          else el.insertBefore(n, cursor);
        }
      }
    }

    enterHydrate(el, c.claimed);
    update();
    leaveHydrate();
    return {
      el,
      update,
      dispose() {
        for (const row of rows.values()) for (const b of row.blocks) b.dispose();
        rows.clear();
      },
    };
  }

  let pendingGlobalForFlush = null;

  // ---- scheduling ----------------------------------------------------------
  function invalidate() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function flush() {
    scheduled = false;
    if (destroyed) return;
    const globalChanges = new Set(pendingGlobalChanges);
    pendingGlobalChanges.clear();
    // a context's `let` may read other contexts: bring them all up to date
    for (const [ctxName, ctx] of contexts) {
      recomputeContext(ctx);
      const last = ctx.lastValues || {};
      for (const k of ctx.varNames) {
        if (ctx.obj[k] !== last[k]) {
          globalChanges.add(ctxName);
          last[k] = ctx.obj[k];
        }
      }
      ctx.lastValues = last;
    }
    pendingGlobalForFlush = globalChanges;
    updateInstance(rootInst, globalChanges);
    pendingGlobalForFlush = null;
    flushHostMounts();
    callbacks.onRender?.(getSnapshot());
  }

  function getSnapshot() {
    const out = [];
    for (const inst of instances.values()) {
      const stores = {};
      for (const n of inst.meta.storeNames) stores[n] = inst.vars[n];
      const props = {};
      for (const n of inst.meta.propNames) props[n] = inst.vars[n];
      out.push({ key: inst.key, viewName: inst.viewName, state: inst.state, stores, props });
    }
    return out;
  }

  function forceStateTransition(instanceKey, nextState) {
    const inst = instances.get(instanceKey);
    if (!inst) return;
    const from = inst.state;
    inst.state = nextState;
    markDirty(inst, null);
    callbacks.onTransition?.({ instanceKey, viewName: inst.viewName, from, to: nextState, manual: true });
    flush();
  }

  function dispatch(e) {
    const root = e.currentTarget || container;
    let t = e.target;
    while (t && t !== root) {
      const h = t[HANDLERS];
      const fn = h && h[e.type];
      // Innermost handler wins: a button inside a clickable row must not
      // also trigger the row. A handler returns false to pass the event on.
      if (fn && fn(e) !== false) return;
      t = t.parentNode;
    }
  }

  // ---- drag and drop (in-app payloads; other drags pass through) -------------
  const closestIn = (map, node, root = container) => {
    for (let t = node; t && t !== root; t = t.parentNode) if (map.has(t)) return t;
    return null;
  };
  function setDropOver(el) {
    if (dropOver === el) return;
    dropOver?.classList.remove('f4-drop-over');
    dropOver = el;
    el?.classList.add('f4-drop-over');
  }
  function endDrag() {
    if (!dragging) return;
    dragging.el.classList.remove('f4-drag-source');
    container.classList.remove('f4-dragging');
    setDropOver(null);
    const { el, payload } = dragging;
    dragging = null;
    el[HANDLERS]?.dragend?.(payload);
  }
  function onDrag(e) {
    const root = e.currentTarget || container;
    switch (e.type) {
      case 'dragstart': {
        const src = closestIn(dragSources, e.target, root);
        if (!src) return;
        const { payload, text } = dragSources.get(src)();
        dragging = { payload, el: src };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', text || '');
        e.dataTransfer.setData('application/x-foar', String(rid));
        src.classList.add('f4-drag-source');
        container.classList.add('f4-dragging');
        src[HANDLERS]?.dragstart?.(payload);
        return;
      }
      case 'dragover': {
        if (!dragging) return;
        const target = closestIn(dropTargets, e.target, root);
        setDropOver(target);
        if (target) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
        return;
      }
      case 'dragleave':
        if (dropOver && !dropOver.contains(e.relatedTarget)) setDropOver(null);
        return;
      case 'drop': {
        if (!dragging) return;
        const target = closestIn(dropTargets, e.target, root);
        if (!target) return;
        e.preventDefault();
        const payload = dragging.payload;
        endDrag();
        dropTargets.get(target)()(payload);
        return;
      }
      case 'dragend':
        endDrag();
    }
  }

  // ---- state-scoped keyboard shortcuts (`on_key("Escape") { ... }`) ----------
  const hasKeyHandlers = ast.views.some((v) => v.states.some((s) => s.keyHandlers && s.keyHandlers.length));
  function onDocKeyDown(e) {
    if (destroyed) return;
    // innermost first: a menu or sheet handles Escape before the view around it
    for (const inst of [...instances.values()].reverse()) {
      if (inst.disposed) continue;
      const st = inst.meta.states.get(inst.state);
      if (!st || !st.decl.keyHandlers || !st.decl.keyHandlers.length) continue;
      for (const kh of st.decl.keyHandlers) {
        if (matchesKeyCombo(e, kh.combo)) {
          e.preventDefault();
          runEffect(inst, kh.body, []);
          invalidate();
          return;
        }
      }
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const t of asyncTimers) clearTimeout(t);
    asyncTimers.clear();
    if (hasKeyHandlers) doc.removeEventListener('keydown', onDocKeyDown);
    if (win && (routerMode === 'history' || routerMode === 'hash')) {
      win.removeEventListener(routerMode === 'hash' ? 'hashchange' : 'popstate', onPopState);
    }
    for (const type of EVENT_TYPES) container.removeEventListener(type, dispatch);
    for (const type of DRAG_TYPES) container.removeEventListener(type, onDrag);
    disposeInstance(rootInst);
    if (ownsStyleEl) styleEl.remove();
    container.textContent = '';
  }

  // ---- boot ----------------------------------------------------------------
  const rootInst = createInstance(callbacks.rootKey || 'root', rootViewDecl, callbacks.props || {}, null, null);
  if (!hydrating) container.textContent = '';
  const rootEl = mountInstance(rootInst);
  if (rootEl.parentNode !== container) container.appendChild(rootEl);
  hydrating = false;
  hyCursor = null;
  hyStack.length = 0;
  deferHostMounts = false;
  flushHostMounts();
  for (const type of EVENT_TYPES) container.addEventListener(type, dispatch);
  for (const type of DRAG_TYPES) container.addEventListener(type, onDrag);
  if (hasKeyHandlers) doc.addEventListener('keydown', onDocKeyDown);
  callbacks.onRender?.(getSnapshot());

  return {
    renderApp: flush,
    flush,
    getSnapshot,
    forceStateTransition,
    invokeEffect(instanceKey, effectName, arg) {
      const inst = instances.get(instanceKey);
      if (inst) invokeEffect(inst, effectName, arg);
    },
    /** Run a context effect from host code: `app.call('Library.Trash', id)`. */
    call(name, ...args) {
      const [ctxName, efName] = String(name).split('.');
      const fn = contexts.get(ctxName)?.obj[efName];
      if (typeof fn !== 'function') throw new Error(`FOAR: no context effect ${name}`);
      fn(...args);
    },
    /**
     * Atomically replace one or more stores from an external subscription.
     * Derived `let`s are recomputed and the DOM update is batched just like an
     * effect. Functions receive a read-only context snapshot and return a patch.
     */
    setContext(name, values) {
      const ctx = contexts.get(name);
      if (!ctx) throw new Error(`FOAR: no context ${name}`);
      const current = {};
      for (const store of ctx.storeNames) current[store] = ctx.obj[store];
      const patch = typeof values === 'function' ? values(Object.freeze(current)) : values;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError(`FOAR: setContext(${name}) expects a store patch object`);
      }
      for (const key of Object.keys(patch)) {
        if (!ctx.storeNames.includes(key)) throw new Error(`FOAR: ${name}.${key} is not a writable context store`);
      }
      for (const [key, value] of Object.entries(patch)) ctx.obj[key] = value;
      recomputeContext(ctx);
      invalidate();
      const out = {};
      for (const n of ctx.varNames) out[n] = ctx.obj[n];
      return out;
    },
    /** A context's stores and lets (read-only copy): `app.getContext('Library').notes`. */
    getContext(name) {
      const ctx = contexts.get(name);
      if (!ctx) return undefined;
      const out = {};
      for (const n of ctx.varNames) out[n] = ctx.obj[n];
      return out;
    },
    /** DOM node exposed by `Host(name: "…")`; null after it unmounts. */
    getHost(name) { return hosts.get(String(name)) ?? null; },
    /** Switch language: every t() re-evaluates in one flush. */
    setLocale(next) {
      if (!next) return;
      i18n.setLocale(next);
      applyLocale();
      pendingGlobalChanges.add('t');
      flush();
    },
    getLocale: () => i18n.locale,
    t,
    navigate,
    replace,
    getRoute: () => ({ ...route, params: { ...route.params }, query: { ...route.query } }),
    destroy,
  };
}

/**
 * Hydrate server-rendered HTML in place (adopts existing DOM nodes without
 * recreating them and restores serialized state from `<script id="__foar_state__">`).
 */
export function hydrate(ast, container, callbacks = {}) {
  return createFoarRuntime(ast, container, { ...callbacks, hydrate: true });
}

/**
 * Partial Islands Hydration: discovers `[data-f4-island]` boundaries inside
 * `root` and hydrates only interactive islands according to their `client:`
 * strategy (`"load"`, `"idle"`, or `"visible"`), leaving static HTML untouched.
 */
export function hydrateIslands(root, ast, callbacks = {}) {
  const doc = root?.ownerDocument || root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return { islands: [], destroy() {} };
  const scope = root && typeof root.querySelectorAll === 'function' ? root : doc;
  const nodes = Array.from(scope.querySelectorAll('[data-f4-island]'));
  const active = [];
  const observers = [];
  const timers = [];

  let initialState = callbacks.initialState || null;
  if (!initialState) {
    const stateEl = doc.getElementById('__foar_state__');
    if (stateEl?.textContent) {
      try { initialState = JSON.parse(stateEl.textContent); } catch {}
    }
  }

  function hydrateOne(el) {
    if (el.dataset.f4Hydrated === 'true') return null;
    const viewName = el.dataset.f4Island;
    const viewDecl = ast.views.find((v) => v.name === viewName);
    if (!viewDecl) return null;
    el.dataset.f4Hydrated = 'true';
    let props = {};
    if (el.dataset.f4Props) {
      try { props = JSON.parse(el.dataset.f4Props); } catch {}
    }
    const subAst = {
      ...ast,
      views: [viewDecl, ...ast.views.filter((v) => v !== viewDecl)],
    };
    const rootKey = el.firstElementChild?.dataset?.key || `island:${viewName}`;
    const rt = createFoarRuntime(subAst, el, {
      ...callbacks,
      hydrate: true,
      initialState,
      rootKey,
      props,
    });
    const rec = { el, viewName, runtime: rt };
    active.push(rec);
    return rt;
  }

  for (const el of nodes) {
    const mode = (el.dataset.f4Hydrate || 'load').toLowerCase();
    if (mode === 'idle') {
      const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.requestIdleCallback === 'function') {
        const id = win.requestIdleCallback(() => hydrateOne(el));
        timers.push(() => win.cancelIdleCallback(id));
      } else {
        const id = setTimeout(() => hydrateOne(el), 1);
        timers.push(() => clearTimeout(id));
      }
    } else if (mode === 'visible') {
      const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.IntersectionObserver === 'function') {
        const obs = new win.IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            obs.disconnect();
            hydrateOne(el);
          }
        });
        obs.observe(el);
        observers.push(obs);
      } else {
        hydrateOne(el);
      }
    } else {
      hydrateOne(el);
    }
  }

  return {
    islands: active,
    hydrateElement: hydrateOne,
    destroy() {
      for (const cancel of timers) cancel();
      for (const obs of observers) obs.disconnect();
      for (const rec of active) rec.runtime?.destroy?.();
      active.length = 0;
    },
  };
}

/**
 * Zero-DOM Server-Side Rendering (runs in Node, Deno, Bun, Edge workers).
 * Returns `{ html, css, state, head }`.
 */
export function renderToString(ast, options = {}) {
  const rootViewDecl = ast.views[0];
  if (!rootViewDecl) return { html: '', css: '', state: { route: '/', instances: {}, contexts: {} }, head: '' };

  const viewMap = new Map(ast.views.map((v) => [v.name, v]));
  const i18n = options.i18n && typeof options.i18n.t === 'function' ? options.i18n : createI18n(options.i18n || {});
  const t = i18n.t;
  const t_key = (key) => key;
  const parsed = parseUrl(options.url || '/');
  const route = { path: parsed.path, query: parsed.query, hash: parsed.hash, params: {} };
  const noop = () => {};
  const externs = Object.assign(Object.create(null), { random_uuid, t, t_key, route, navigate: noop, replace: noop }, options.bindings || {});
  const staticProgram = ast.__foarCompiled || EMPTY;
  const compile = (expr, varNames, localNames) =>
    compileExpr(expr, varNames, localNames, staticProgram.expressions?.[expr], externs);
  Object.assign(externs, buildFunctions(ast, externs));
  const serializedInstances = {};
  const serializedContexts = {};
  let ssrCatchDepth = 0;

  const evalSafe = (expr, vn, vars, ln, locals) => {
    try {
      return compile(expr, vn, ln)(vars, locals);
    } catch (err) {
      if (ssrCatchDepth > 0) throw err;
      return undefined;
    }
  };

  for (const ctxDecl of ast.contexts || []) {
    externs[ctxDecl.name] = {};
  }
  const externNames = Object.keys(externs).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  for (const ctxDecl of contextsInOrder(ast.contexts)) {
    const storeNames = ctxDecl.stores.map((s) => s.name);
    const derivedNames = (ctxDecl.derived || []).map((d) => d.name);
    const varNames = dedupe([...storeNames, ...derivedNames]);
    const ctxExt = externNames.filter((n) => !varNames.includes(n));
    const obj = externs[ctxDecl.name];
    const snap = {};
    for (const st of ctxDecl.stores) {
      obj[st.name] = evalSafe(st.initExpr, varNames, obj, ctxExt, externs);
      snap[st.name] = obj[st.name];
    }
    for (const d of ctxDecl.derived || []) {
      obj[d.name] = evalSafe(d.expr, varNames, obj, ctxExt, externs);
    }
    for (const ef of ctxDecl.effects || []) obj[ef.name] = noop;
    serializedContexts[ctxDecl.name] = snap;
  }

  function attrsStr(pairs) {
    let s = '';
    for (const [k, v] of pairs) {
      if (v === undefined || v === null || v === false) continue;
      if (v === true) s += ` ${k}="true"`;
      else s += ` ${k}="${escapeHtml(v)}"`;
    }
    return s;
  }

  function styleAttr(st, vn, vars, ln, locals) {
    if (!st || !st.dynamic || !st.dynamic.length) return null;
    const parts = [];
    for (const d of st.dynamic) {
      const css = inlineStyleToCss(d.key, evalSafe(d.expr, vn, vars, ln, locals));
      if (css) parts.push(css);
    }
    return parts.length ? parts.join(';') : null;
  }

  function renderView(key, decl, props, slotCtx = null) {
    const propNames = decl.params.map((p) => p.name);
    const storeNames = decl.stores.map((s) => s.name);
    const derivedNames = (decl.derived || []).map((d) => d.name);
    const varNames = dedupe([...propNames, ...storeNames, ...derivedNames]);
    const viewExterns = externNames.filter((n) => !varNames.includes(n));
    const vars = {};
    for (const p of decl.params) {
      vars[p.name] = props[p.name] !== undefined || p.default === undefined ? props[p.name] : evalSafe(p.default, [], {}, externNames, externs);
    }
    for (const s of decl.stores) vars[s.name] = evalSafe(s.initExpr, varNames, vars, viewExterns, externs);
    for (const d of decl.derived || []) vars[d.name] = evalSafe(d.expr, varNames, vars, viewExterns, externs);

    const firstState = decl.states[0];
    const stateName = firstState ? firstState.name : 'Initial';
    const storesSnap = {};
    for (const s of storeNames) storesSnap[s] = vars[s];
    serializedInstances[key] = { state: stateName, stores: storesSnap };

    const cls = ['f4-view-host', `f4-view-${decl.name}`, decl.style?.cls].filter(Boolean).join(' ');
    const st = styleAttr(decl.style, varNames, vars, viewExterns, externs);
    const inner = firstState
      ? firstState.render.map((n, i) => renderNode(n, key, decl.name, varNames, vars, viewExterns, externs, String(i), slotCtx)).join('')
      : '';
    return `<div${attrsStr([['class', cls], ['data-view-name', decl.name], ['data-key', key], ['data-state-name', stateName], ['style', st]])}>${inner}</div>`;
  }

  function ssrChildSlotName(ch, vn, vars, ln, locals) {
    const expr = ch.namedArgs && ch.namedArgs.slot;
    if (expr === undefined) return 'default';
    const v = evalSafe(expr, vn, vars, ln, locals);
    return v == null || v === '' ? 'default' : String(v);
  }

  function renderNode(node, instKey, viewName, vn, vars, ln, locals, path, slotCtx) {
    if (viewMap.has(node.tag)) {
      const childDecl = viewMap.get(node.tag);
      const props = {};
      node.args.forEach((expr, i) => {
        const p = childDecl.params[i];
        if (p) props[p.name] = evalSafe(expr, vn, vars, ln, locals);
      });
      for (const [name, expr] of Object.entries(node.namedArgs)) {
        if (name === 'slot') continue;
        props[name] = evalSafe(expr, vn, vars, ln, locals);
      }
      const nextSlot = node.children && node.children.length
        ? { nodes: node.children, instKey, viewName, vn, vars, ln, locals, path, slotCtx }
        : null;
      return renderView(`${instKey}/${path}`, childDecl, props, nextSlot);
    }
    if (node.tag === 'Slot') {
      const nameExpr = node.namedArgs.name !== undefined ? node.namedArgs.name : node.args[0];
      const wanted = nameExpr !== undefined ? String(evalSafe(nameExpr, vn, vars, ln, locals) ?? 'default') : 'default';
      const projected = slotCtx
        ? slotCtx.nodes.filter((ch) => ssrChildSlotName(ch, slotCtx.vn, slotCtx.vars, slotCtx.ln, slotCtx.locals) === wanted)
        : [];
      let inner = '';
      if (projected.length > 0) {
        inner = projected.map((c, i) => renderNode(c, slotCtx.instKey, slotCtx.viewName, slotCtx.vn, slotCtx.vars, slotCtx.ln, slotCtx.locals, `${slotCtx.path}/slot-${wanted}/${i}`, slotCtx.slotCtx)).join('');
      } else if (node.children && node.children.length > 0) {
        inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/fallback/${i}`, slotCtx)).join('');
      }
      return `<div class="f4-slot" style="display:contents">${inner}</div>`;
    }
    if (node.tag === 'Island') {
      const clientExpr = node.namedArgs.client !== undefined ? node.namedArgs.client : node.args[0];
      const strategy = clientExpr !== undefined ? String(evalSafe(clientExpr, vn, vars, ln, locals) ?? 'load') : 'load';
      const firstChild = node.children[0];
      const isView = firstChild && viewMap.has(firstChild.tag);
      let islandAttrs = [['class', 'f4-island'], ['style', 'display:contents']];
      if (isView) {
        const childDecl = viewMap.get(firstChild.tag);
        const islandProps = {};
        firstChild.args.forEach((expr, i) => {
          const p = childDecl.params[i];
          if (p) islandProps[p.name] = evalSafe(expr, vn, vars, ln, locals);
        });
        for (const [name, expr] of Object.entries(firstChild.namedArgs || {})) {
          if (name === 'slot') continue;
          islandProps[name] = evalSafe(expr, vn, vars, ln, locals);
        }
        islandAttrs.push(['data-f4-island', firstChild.tag]);
        islandAttrs.push(['data-f4-hydrate', strategy]);
        if (Object.keys(islandProps).length) islandAttrs.push(['data-f4-props', JSON.stringify(islandProps)]);
      }
      const inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/isl${i}`, slotCtx)).join('');
      return `<div${attrsStr(islandAttrs)}>${inner}</div>`;
    }
    if (node.tag === 'Portal') {
      const targetExpr = node.namedArgs.target !== undefined ? node.namedArgs.target : node.args[0];
      const sel = targetExpr !== undefined ? String(evalSafe(targetExpr, vn, vars, ln, locals) ?? 'body') : 'body';
      const inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/portal/${i}`, slotCtx)).join('');
      return `<div class="f4-portal" data-portal-target="${escapeHtml(sel)}">${inner}</div>`;
    }
    if (node.tag === 'Catch') {
      ssrCatchDepth++;
      let inner = '';
      try {
        inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/try/${i}`, slotCtx)).join('');
      } catch (err) {
        ssrCatchDepth--;
        const errObj = { message: err?.message || String(err), view: viewName };
        if (node.elseChildren && node.elseChildren.length) {
          const fbLn = node.fallbackBinding ? dedupe([...ln, node.fallbackBinding]) : ln;
          const fbScope = Object.create(locals || null);
          if (node.fallbackBinding) fbScope[node.fallbackBinding] = errObj;
          inner = node.elseChildren.map((c, i) => renderNode(c, instKey, viewName, vn, vars, fbLn, fbScope, `${path}/fallback/${i}`, slotCtx)).join('');
        }
        return `<div class="f4-catch" style="display:contents">${inner}</div>`;
      }
      ssrCatchDepth--;
      return `<div class="f4-catch" style="display:contents">${inner}</div>`;
    }
    if (node.tag === 'If') {
      const cond = node.args[0] !== undefined ? Boolean(evalSafe(node.args[0], vn, vars, ln, locals)) : false;
      const list = cond ? node.children : node.elseChildren || null;
      const inner = list ? list.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${cond ? 'if' : 'else'}${i}`, slotCtx)).join('') : '';
      return `<div class="f4-if" style="display:contents">${inner}</div>`;
    }
    if (node.tag === 'Match') {
      const value = evalSafe(node.args[0], vn, vars, ln, locals);
      let inner = '';
      for (let i = 0; i < (node.arms || []).length; i++) {
        const a = node.arms[i];
        const names = a.binding ? [...ln, '__m', a.binding] : [...ln, '__m'];
        const scope = Object.create(locals || null);
        scope.__m = value;
        if (a.binding) scope[a.binding] = a.bindingExpr === '__m.value' ? value?.value : value;
        if (evalSafe(a.test, vn, vars, names, scope)) {
          inner = a.children.map((c, ci) => renderNode(c, instKey, viewName, vn, vars, names, scope, `${path}/arm${i}/${ci}`, slotCtx)).join('');
          break;
        }
      }
      return `<div class="f4-match" style="display:contents">${inner}</div>`;
    }
    if (node.tag === 'Router') {
      const routes = node.children.filter((c) => c.tag === 'Route');
      let inner = '';
      for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        const patExpr = r.namedArgs.path !== undefined ? r.namedArgs.path : r.args[0];
        const pat = evalSafe(patExpr, vn, vars, ln, locals);
        const m = matchRoute(pat, route.path);
        if (m) {
          route.params = m;
          const names = r.listBinding ? dedupe([...ln, r.listBinding]) : ln;
          const scope = Object.create(locals || null);
          if (r.listBinding) scope[r.listBinding] = m;
          inner = r.children.map((c, ci) => renderNode(c, instKey, viewName, vn, vars, names, scope, `${path}/route${i}/${ci}`, slotCtx)).join('');
          break;
        }
      }
      return `<div class="f4-router" style="display:contents">${inner}</div>`;
    }
    if (node.tag === 'List') {
      let items = evalSafe(node.listExpr, vn, vars, ln, locals);
      if (!Array.isArray(items)) items = items == null ? [] : Array.from(items);
      const cls = ['f4-list', node.style?.cls].filter(Boolean).join(' ');
      const attrs = [['class', cls]];
      if (node.namedArgs?.role !== undefined) attrs.push(['role', evalSafe(node.namedArgs.role, vn, vars, ln, locals)]);
      if (node.namedArgs?.label !== undefined) attrs.push(['aria-label', evalSafe(node.namedArgs.label, vn, vars, ln, locals)]);
      if (items.length === 0) {
        const msg = node.namedArgs?.empty !== undefined ? evalSafe(node.namedArgs.empty, vn, vars, ln, locals) : 'No matching items.';
        const emptyHtml = msg == null || msg === '' ? `<div class="f4-list-empty" hidden></div>` : `<div class="f4-list-empty">${escapeHtml(msg)}</div>`;
        return `<div${attrsStr(attrs)}>${emptyHtml}</div>`;
      }
      const binding = node.listBinding;
      const childLn = binding ? dedupe([...ln, binding]) : ln;
      const seen = new Set();
      const rowsHtml = items.map((item, idx) => {
        let k = item !== null && typeof item === 'object' ? (item.id !== undefined ? `i:${item.id}` : item.key !== undefined ? `k:${item.key}` : `n:${idx}`) : typeof item === 'string' || typeof item === 'number' ? `v:${item}` : `n:${idx}`;
        if (seen.has(k)) k = `${k}#${idx}`;
        seen.add(k);
        const rl = Object.create(locals);
        if (binding) rl[binding] = item;
        return node.children.map((c, ci) => renderNode(c, instKey, viewName, vn, vars, childLn, rl, `${path}/${k}/${ci}`, slotCtx)).join('');
      }).join('');
      return `<div${attrsStr(attrs)}>${rowsHtml}</div>`;
    }

    // Standard elements
    const na = node.namedArgs || {};
    const commonAttrs = (baseCls, extra = []) => {
      const extraCls = na.class !== undefined ? evalSafe(na.class, vn, vars, ln, locals) : null;
      const cls = [baseCls, node.style?.cls, extraCls].filter(Boolean).join(' ');
      const out = [['class', cls], ...extra];
      const st = styleAttr(node.style, vn, vars, ln, locals);
      if (st) out.push(['style', st]);
      if (na.id !== undefined) out.push(['id', evalSafe(na.id, vn, vars, ln, locals)]);
      if (na.disabled !== undefined && Boolean(evalSafe(na.disabled, vn, vars, ln, locals))) {
        out.push(['disabled', '']);
        out.push(['aria-disabled', 'true']);
      }
      if (na.title !== undefined && node.tag !== 'Image') out.push(['title', evalSafe(na.title, vn, vars, ln, locals)]);
      if (na.label !== undefined) out.push(['aria-label', evalSafe(na.label, vn, vars, ln, locals)]);
      if (na.role !== undefined) out.push(['role', evalSafe(na.role, vn, vars, ln, locals)]);
      if (na.tab_index !== undefined) out.push(['tabindex', evalSafe(na.tab_index, vn, vars, ln, locals)]);
      if (na.aria !== undefined) {
        const obj = evalSafe(na.aria, vn, vars, ln, locals) || {};
        for (const [k, v] of Object.entries(obj)) out.push([`aria-${k.replace(/_/g, '-')}`, v]);
      }
      return attrsStr(out);
    };

    switch (node.tag) {
      case 'Text': {
        const txt = node.args[0] ? evalSafe(node.args[0], vn, vars, ln, locals) ?? '' : '';
        const extra = node.events.on_click || node.events.on_double_click ? [['data-clickable', '']] : [];
        return `<div${commonAttrs('f4-text', extra)}>${escapeHtml(txt)}</div>`;
      }
      case 'Button': {
        const txt = node.args[0] ? evalSafe(node.args[0], vn, vars, ln, locals) ?? '' : 'Button';
        return `<button${commonAttrs('f4-button', [['type', 'button']])}>${escapeHtml(txt)}</button>`;
      }
      case 'Link': {
        const hrefExpr = na.to !== undefined ? na.to : na.href !== undefined ? na.href : node.args[0];
        const href = hrefExpr !== undefined ? String(evalSafe(hrefExpr, vn, vars, ln, locals) ?? '/') : '/';
        const active = parseUrl(href).path === route.path;
        const inner = node.children.length > 0
          ? node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${i}`, slotCtx)).join('')
          : escapeHtml(node.args[1] !== undefined ? evalSafe(node.args[1], vn, vars, ln, locals) ?? '' : href);
        return `<a${commonAttrs('f4-link', [['href', href], ['aria-current', active ? 'page' : null]])}>${inner}</a>`;
      }
      case 'Input': {
        const type = na.secure !== undefined ? 'password' : 'text';
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const val = valExpr !== undefined ? evalSafe(valExpr, vn, vars, ln, locals) ?? '' : '';
        const ph = na.placeholder !== undefined ? evalSafe(na.placeholder, vn, vars, ln, locals) : null;
        return `<input${commonAttrs('f4-input', [['type', type], ['value', String(val)], ['placeholder', ph]])}>`;
      }
      case 'TextArea': {
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const val = valExpr !== undefined ? evalSafe(valExpr, vn, vars, ln, locals) ?? '' : '';
        const ph = na.placeholder !== undefined ? evalSafe(na.placeholder, vn, vars, ln, locals) : null;
        return `<textarea${commonAttrs('f4-textarea', [['placeholder', ph]])}>${escapeHtml(val)}</textarea>`;
      }
      case 'Checkbox': {
        const checked = na.checked !== undefined && Boolean(evalSafe(na.checked, vn, vars, ln, locals));
        return `<input${commonAttrs('f4-checkbox', [['type', 'checkbox']])}${checked ? ' checked' : ''}>`;
      }
      case 'RichText': {
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const htmlVal = valExpr !== undefined ? String(evalSafe(valExpr, vn, vars, ln, locals) ?? '') : '';
        return `<div${commonAttrs('f4-richtext', [['contenteditable', 'true'], ['role', 'textbox'], ['aria-multiline', 'true']])}>${htmlVal}</div>`;
      }
      case 'Image': {
        const srcExpr = na.src !== undefined ? na.src : node.args[0];
        const src = srcExpr !== undefined ? evalSafe(srcExpr, vn, vars, ln, locals) : null;
        const alt = na.alt !== undefined ? evalSafe(na.alt, vn, vars, ln, locals) ?? '' : '';
        return `<img${commonAttrs('f4-image', [['src', src], ['alt', alt], ['loading', 'lazy'], ['decoding', 'async']])}>`;
      }
      case 'Spinner': {
        const txt = node.args[0] ? evalSafe(node.args[0], vn, vars, ln, locals) ?? '' : 'Loading...';
        return `<div${commonAttrs('f4-spinner-wrap')}><div class="f4-spinner-ring"></div><span>${escapeHtml(txt)}</span></div>`;
      }
      case 'Host': {
        const nameExpr = na.name !== undefined ? na.name : na.ref !== undefined ? na.ref : na.id;
        const name = nameExpr !== undefined ? evalSafe(nameExpr, vn, vars, ln, locals) : null;
        const inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${i}`, slotCtx)).join('');
        return `<div${commonAttrs('f4-host', name ? [['data-f4-host', name]] : [])}>${inner}</div>`;
      }
      case 'Video': {
        const srcExpr = na.src !== undefined ? na.src : node.args[0];
        const src = srcExpr !== undefined ? evalSafe(srcExpr, vn, vars, ln, locals) : null;
        const extra = [['src', src]];
        for (const name of ['poster', 'preload']) if (na[name] !== undefined) extra.push([name, evalSafe(na[name], vn, vars, ln, locals)]);
        for (const name of ['controls', 'autoplay', 'loop', 'muted', 'playsinline']) if (na[name] !== undefined && Boolean(evalSafe(na[name], vn, vars, ln, locals))) extra.push([name, '']);
        return `<video${commonAttrs('f4-video', extra)}></video>`;
      }
      case 'Canvas': {
        const extra = [];
        for (const name of ['width', 'height']) if (na[name] !== undefined) extra.push([name, evalSafe(na[name], vn, vars, ln, locals)]);
        return `<canvas${commonAttrs('f4-canvas', extra)}></canvas>`;
      }
      case 'Svg': {
        const extra = [['xmlns', 'http://www.w3.org/2000/svg']];
        for (const [name, attr] of [['view_box', 'viewBox'], ['width', 'width'], ['height', 'height'], ['preserve_aspect_ratio', 'preserveAspectRatio']]) {
          if (na[name] !== undefined) extra.push([attr, evalSafe(na[name], vn, vars, ln, locals)]);
        }
        return `<svg${commonAttrs('f4-svg', extra)}></svg>`;
      }
      case 'Form': {
        const inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${i}`, slotCtx)).join('');
        return `<form${commonAttrs('f4-form')}>${inner}</form>`;
      }
      case 'Select': {
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const selVal = valExpr !== undefined ? String(evalSafe(valExpr, vn, vars, ln, locals) ?? '') : null;
        const inner = node.children.map((c, i) => {
          if (c.tag === 'Option') {
            const cna = c.namedArgs || {};
            const ovExpr = cna.value !== undefined ? cna.value : c.args[0];
            const olExpr = cna.value !== undefined ? (c.args[0] ?? ovExpr) : (c.args[1] ?? c.args[0]);
            const ov = ovExpr !== undefined ? String(evalSafe(ovExpr, vn, vars, ln, locals) ?? '') : '';
            const ol = olExpr !== undefined ? String(evalSafe(olExpr, vn, vars, ln, locals) ?? '') : '';
            return `<option class="f4-option" value="${escapeHtml(ov)}"${selVal === ov ? ' selected' : ''}>${escapeHtml(ol)}</option>`;
          }
          return renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${i}`, slotCtx);
        }).join('');
        return `<select${commonAttrs('f4-select')}>${inner}</select>`;
      }
      case 'Option': {
        const ovExpr = na.value !== undefined ? na.value : node.args[0];
        const olExpr = na.value !== undefined ? (node.args[0] ?? ovExpr) : (node.args[1] ?? node.args[0]);
        const ov = ovExpr !== undefined ? String(evalSafe(ovExpr, vn, vars, ln, locals) ?? '') : '';
        const ol = olExpr !== undefined ? String(evalSafe(olExpr, vn, vars, ln, locals) ?? '') : '';
        return `<option${commonAttrs('f4-option', [['value', ov]])}>${escapeHtml(ol)}</option>`;
      }
      case 'Slider': {
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const val = valExpr !== undefined ? String(evalSafe(valExpr, vn, vars, ln, locals) ?? '0') : '0';
        const min = na.min !== undefined ? String(evalSafe(na.min, vn, vars, ln, locals)) : null;
        const max = na.max !== undefined ? String(evalSafe(na.max, vn, vars, ln, locals)) : null;
        const step = na.step !== undefined ? String(evalSafe(na.step, vn, vars, ln, locals)) : null;
        return `<input${commonAttrs('f4-slider', [['type', 'range'], ['value', val], ['min', min], ['max', max], ['step', step]])}>`;
      }
      case 'Progress': {
        const valExpr = na.value !== undefined ? na.value : node.args[0];
        const val = valExpr !== undefined ? String(evalSafe(valExpr, vn, vars, ln, locals) ?? '0') : '0';
        const max = na.max !== undefined ? String(evalSafe(na.max, vn, vars, ln, locals)) : null;
        return `<progress${commonAttrs('f4-progress', [['value', val], ['max', max]])}></progress>`;
      }
      case 'Row':
      case 'Column': {
        const base = node.tag === 'Row' ? 'f4-row' : 'f4-column';
        const inner = node.children.map((c, i) => renderNode(c, instKey, viewName, vn, vars, ln, locals, `${path}/${i}`, slotCtx)).join('');
        return `<div${commonAttrs(base)}>${inner}</div>`;
      }
      default:
        return `<div>${escapeHtml(`[Unknown element: ${node.tag}]`)}</div>`;
    }
  }

  const html = renderView('root', rootViewDecl, {}, null);
  const css = `${BASE_CSS}\n${ast.css || ''}`;
  const state = { route: options.url || '/', instances: serializedInstances, contexts: serializedContexts };
  const safeState = JSON.stringify(state).replace(/</g, '\\u003c');
  const head = `<style data-f4-ssr>${css}</style>\n<script id="__foar_state__" type="application/json">${safeState}</script>`;
  return { html, css, state, head };
}

/**
 * Async SSR with route data loaders.
 * Accepts `options.load(route)` and/or `options.loaders` (`{ "/orders/:id": async (params, route) => data }`).
 * Loaded values are merged into `options.bindings` before rendering and included on `result.data`.
 */
export async function renderToStringAsync(ast, options = {}) {
  const parsed = parseUrl(options.url || '/');
  const routeInfo = { path: parsed.path, query: parsed.query, hash: parsed.hash, params: {} };
  const extraBindings = {};
  let loadedData = null;

  if (options.loaders && typeof options.loaders === 'object') {
    for (const [pattern, loader] of Object.entries(options.loaders)) {
      if (typeof loader !== 'function') continue;
      const params = matchRoute(pattern, routeInfo.path);
      if (params) {
        routeInfo.params = params;
        loadedData = await loader(params, routeInfo);
        break;
      }
    }
  }
  if (typeof options.load === 'function') {
    const res = await options.load(routeInfo);
    if (res !== undefined) {
      loadedData = loadedData && typeof loadedData === 'object' && typeof res === 'object'
        ? { ...loadedData, ...res }
        : res;
    }
  }
  if (loadedData !== null && loadedData !== undefined) {
    extraBindings.loaderData = () => loadedData;
    if (typeof loadedData === 'object' && !Array.isArray(loadedData)) {
      if (loadedData.bindings && typeof loadedData.bindings === 'object') {
        Object.assign(extraBindings, loadedData.bindings);
      } else {
        for (const [k, v] of Object.entries(loadedData)) {
          extraBindings[k] = typeof v === 'function' ? v : () => v;
        }
      }
    }
  }
  const merged = { ...options, bindings: { ...extraBindings, ...(options.bindings || {}) } };
  const out = renderToString(ast, merged);
  return { ...out, data: loadedData };
}

/**
 * Streaming SSR returning a standard Web `ReadableStream` (Node, Deno, Bun, Edge).
 * Flushes `<style data-f4-ssr>` (and optional `shellBefore`) immediately while
 * awaiting async route loaders, then streams rendered HTML + state script + `shellAfter`.
 */
export function renderToStream(ast, options = {}) {
  const encode = options.encoding === 'string' ? (s) => s : (() => {
    const enc = new TextEncoder();
    return (s) => enc.encode(s);
  })();
  const css = `${BASE_CSS}\n${ast.css || ''}`;
  return new ReadableStream({
    async start(controller) {
      try {
        if (options.shellBefore) controller.enqueue(encode(String(options.shellBefore)));
        controller.enqueue(encode(`<style data-f4-ssr>${css}</style>\n`));
        const { html, state } = await renderToStringAsync(ast, options);
        const safeState = JSON.stringify(state).replace(/</g, '\\u003c');
        controller.enqueue(encode(html));
        controller.enqueue(encode(`\n<script id="__foar_state__" type="application/json">${safeState}</script>`));
        if (options.shellAfter) controller.enqueue(encode(String(options.shellAfter)));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
