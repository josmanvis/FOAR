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
//   * Expressions and effects are compiled to functions once and cached.
//   * One delegated listener per event type on the container.
//   * Store writes are batched: N effects in one tick => one flush (microtask).
//
// Also exported: createI18n({ locale, fallback, messages }) -> { t, locale, dir, setLocale }.
//
// Public API: createFoarRuntime(ast, container, callbacks) ->
//   { renderApp, flush, getSnapshot, forceStateTransition, invokeEffect,
//     setLocale, getLocale, destroy }
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

const EVENT_TYPES = ['click', 'dblclick', 'input', 'change', 'keydown', 'contextmenu', 'focusout'];
const DRAG_TYPES = ['dragstart', 'dragover', 'dragleave', 'drop', 'dragend'];
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv']);
const EVENT_MAP = {
  on_click: 'click',
  on_double_click: 'dblclick',
  on_input: 'input',
  on_change: 'change',
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
// Expression & effect compilation (cached across runtimes)
// ---------------------------------------------------------------------------
const exprCache = new Map();
const compileErrors = new Set();

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

// Compiles `expr` into fn($v, $l) where $v holds view vars (props + stores)
// and $l holds lexical locals (List bindings). Locals shadow vars.
export function compileExpr(expr, varNames, localNames) {
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
  let compiled = cache.get(eff);
  if (compiled) return compiled;
  const paramNames = (eff.params || []).map((p) => p.name);
  const names = dedupe([...storeNames, ...propNames, ...paramNames]);
  const externs = externNames.filter((n) => !names.includes(n) && !HELPERS.includes(n));
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

export function createFoarRuntime(ast, container, callbacks = {}) {
  const rootViewDecl = ast.views[0];
  if (!rootViewDecl) {
    container.textContent = 'No view declarations found in .foar file.';
    return null;
  }

  const rid = ++runtimeCounter;
  const doc = container.ownerDocument;
  const win = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  const viewMap = new Map(ast.views.map((v) => [v.name, v]));
  const instances = new Map(); // key -> instance (live registry)
  const handlers = new WeakMap(); // element -> { [eventType]: fn }
  const dragSources = new WeakMap(); // element -> () => { payload, text }
  const dropTargets = new WeakMap(); // element -> () => (payload) => void
  let dragging = null; // { payload, el }
  let dropOver = null; // element showing f4-drop-over

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

  function claim(tag) {
    if (hydrating && hyCursor && hyCursor.tagName && hyCursor.tagName.toLowerCase() === tag) {
      const el = hyCursor;
      hyCursor = el.nextElementSibling;
      return { el, claimed: true };
    }
    return { el: doc.createElement(tag), claimed: false };
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
  const externNames = Object.keys(externs).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const effectCache = new Map();
  let destroyed = false;
  let scheduled = false;

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
    const states = new Map();
    for (const s of decl.states) {
      states.set(s.name, { decl: s, effects: new Map(s.effects.map((e) => [e.name, e])) });
    }
    m = {
      decl,
      propNames,
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
    m.derived = (decl.derived || []).map((d) => ({ name: d.name, expr: d.expr, fn: compileExpr(d.expr, m.varNames, m.externNames) }));
    viewMeta.set(decl, m);
    return m;
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
  function createInstance(key, decl, props, parentEmitter, parentInst) {
    const meta = metaFor(decl);
    const vars = {};
    for (const p of meta.propNames) vars[p] = props[p];
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
      host: null,
      badgeState: null,
      hostBindings: [],
      blocks: [],
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
        const fn = compileExpr(st.initExpr, meta.varNames, meta.externNames);
        vars[st.name] = safeEval(fn, vars, initLocals, st.initExpr);
      }
    }
    computeDerived(inst);
    instances.set(key, inst);
    return inst;
  }

  function makeHelpers(inst) {
    const __transition = (next) => {
      const from = inst.state;
      inst.state = next;
      callbacks.onTransition?.({ instanceKey: inst.key, viewName: inst.viewName, from, to: next });
      invalidate();
    };
    const __emit = (event, payload) => {
      callbacks.onEmit?.({ instanceKey: inst.key, viewName: inst.viewName, event, payload });
      if (inst.parentEmitter) inst.parentEmitter(event, payload);
    };
    const __asyncTransition = (apiName, apiArgs, next) => {
      const from = inst.state;
      inst.state = next;
      callbacks.onTransition?.({
        instanceKey: inst.key,
        viewName: inst.viewName,
        from,
        to: next,
        asyncCall: `${apiName}(${apiArgs.map((a) => JSON.stringify(a)).join(', ')})`,
      });
      invalidate();

      const finish = () => {
        if (destroyed || inst.disposed || inst.state !== next) return;
        const st = inst.meta.states.get(next);
        if (st && st.decl.onExit) {
          runEffect(inst, st.decl.onExit, []);
          invalidate();
        }
      };
      const binding = callbacks.bindings && callbacks.bindings[apiName];
      if (typeof binding === 'function') {
        Promise.resolve()
          .then(() => binding(...apiArgs))
          .then(finish, (err) => {
            console.error(`FOAR: binding ${apiName} failed:`, err);
            finish();
          });
      } else {
        const t = setTimeout(() => {
          asyncTimers.delete(t);
          finish();
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
    const c = compileEffect(eff, storeNames, derivedNames.length ? [...propNames, ...derivedNames] : propNames, externNames, effectCache);
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
      const out = fn.apply(null, vals);
      if (out) for (let i = 0; i < storeNames.length; i++) inst.vars[storeNames[i]] = out[i];
    } catch (err) {
      console.error(`FOAR: error in effect ${inst.viewName}.${inst.state}.${eff.name || 'on_exit'}:`, err);
    }
  }

  function invokeEffect(inst, effectName, argValue) {
    if (inst.disposed) return;
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
      fn: compileExpr(d.expr, meta.varNames, inst.meta.externNames),
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
  }

  function unmountState(inst) {
    for (const b of inst.blocks) {
      b.dispose();
      b.el.remove();
    }
    inst.blocks = [];
  }

  function updateInstance(inst) {
    if (inst.meta.derived.length) computeDerived(inst);
    if (inst.mountedState !== inst.state) {
      unmountState(inst);
      mountState(inst);
      // freshly mounted blocks already reflect current vars
      runBindings(inst.hostBindings, inst.vars, externs);
      return;
    }
    runBindings(inst.hostBindings, inst.vars, externs);
    for (const b of inst.blocks) b.update();
  }

  function disposeInstance(inst) {
    for (const b of inst.blocks) b.dispose();
    inst.blocks = [];
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
    return mountElement(node, inst, localNames, locals, path);
  }

  function registerEvents(el, node, inst) {
    let map = null;
    for (const [evName, handlerName] of Object.entries(node.events)) {
      const domType = EVENT_MAP[evName];
      if (!domType) continue;
      map = map || {};
      switch (evName) {
        case 'on_input':
          // RichText reports its HTML; form controls their value.
          map.input = () => invokeEffect(inst, handlerName, node.tag === 'RichText' ? el.innerHTML : el.value);
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
          map.change = (e) => invokeEffect(inst, handlerName, e.target.checked);
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
    if (map) handlers.set(el, map);
  }

  function mountElement(node, inst, localNames, locals, path) {
    const vn = inst.meta.varNames;
    const bindings = [];
    const bind = (expr, apply, live = false) =>
      bindings.push({ fn: compileExpr(expr, vn, localNames), expr, apply, last: UNSET, live });
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
        handlers.set(el, { click: navClick });
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
    if (na.aria !== undefined) {
      let prev = [];
      bind(na.aria, (obj) => {
        const keys = obj ? Object.keys(obj) : [];
        for (const k of prev) if (!keys.includes(k)) el.removeAttribute(`aria-${k.replace(/_/g, '-')}`);
        for (const k of keys) setAttr(el, `aria-${k.replace(/_/g, '-')}`, obj[k]);
        prev = keys;
      });
    }
    if (na.drag !== undefined) {
      const dragFn = compileExpr(na.drag, vn, localNames);
      const textFn = na.drag_text !== undefined ? compileExpr(na.drag_text, vn, localNames) : null;
      el.setAttribute('draggable', 'true');
      dragSources.set(el, () => ({
        payload: safeEval(dragFn, inst.vars, locals, na.drag),
        text: textFn ? safeEval(textFn, inst.vars, locals, na.drag_text) : '',
      }));
    }
    if (node.tag !== 'Link') registerEvents(el, node, inst);
    runBindings(bindings, inst.vars, locals);
    if (node.namedArgs.autofocus !== undefined) {
      const af = compileExpr(node.namedArgs.autofocus, vn, localNames);
      if (safeEval(af, inst.vars, locals, node.namedArgs.autofocus)) {
        queueMicrotask(() => {
          if (!el.isConnected) return;
          el.focus();
          if (node.tag === 'Input' && el.value) el.select(); // rename-style: select existing text
        });
      }
    }

    return {
      el,
      update() {
        runBindings(bindings, inst.vars, locals);
        if (children) for (const c of children) c.update();
      },
      dispose() {
        if (children) for (const c of children) c.dispose();
      },
    };
  }

  function mountSubView(node, inst, localNames, locals, path) {
    const childDecl = viewMap.get(node.tag);
    const vn = inst.meta.varNames;
    const propFns = [];
    node.args.forEach((expr, i) => {
      const p = childDecl.params[i];
      if (p) propFns.push({ name: p.name, fn: compileExpr(expr, vn, localNames), expr });
    });
    for (const [name, expr] of Object.entries(node.namedArgs)) {
      propFns.push({ name, fn: compileExpr(expr, vn, localNames), expr });
    }
    const props = {};
    for (const p of propFns) props[p.name] = safeEval(p.fn, inst.vars, locals, p.expr);

    const emitter = (event, payload) => {
      const handlerName = node.events[`on_${event}`];
      if (handlerName) invokeEffect(inst, handlerName, payload);
    };
    const child = createInstance(`${inst.key}/${path}`, childDecl, props, emitter, inst);
    const el = mountInstance(child);

    return {
      el,
      update() {
        for (const p of propFns) {
          const v = safeEval(p.fn, inst.vars, locals, p.expr);
          if (v !== child.vars[p.name]) child.vars[p.name] = v;
        }
        updateInstance(child);
      },
      dispose() {
        disposeInstance(child);
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
    const fn = compileExpr(expr, inst.meta.varNames, localNames);
    const branches = [node.children, node.elseChildren || null];
    let shown = -1;
    let blocks = null;
    function update(first = false) {
      const want = safeEval(fn, inst.vars, locals, expr) ? 0 : branches[1] ? 1 : -1;
      if (want === shown) {
        if (blocks) for (const b of blocks) b.update();
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
    update(true);
    return {
      el,
      update: () => update(false),
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
    const fn = compileExpr(expr, inst.meta.varNames, localNames);
    const arms = node.arms.map((a, i) => {
      const names = a.binding ? [...localNames, '__m', a.binding] : [...localNames, '__m'];
      return { arm: a, names, test: compileExpr(a.test, inst.meta.varNames, names), path: `${path}/arm${i}` };
    });
    let current = -1;
    let armLocals = null;
    let blocks = null;
    function update(first = false) {
      const value = safeEval(fn, inst.vars, locals, expr);
      let pick = -1;
      for (let i = 0; i < arms.length; i++) {
        const a = arms[i];
        const scope = { ...locals, __m: value };
        if (a.arm.binding) scope[a.arm.binding] = value;
        if (safeEval(a.test, inst.vars, scope, a.arm.test)) {
          pick = i;
          break;
        }
      }
      if (pick === current && blocks) {
        armLocals.__m = value;
        if (arms[pick].arm.binding) armLocals[arms[pick].arm.binding] = value;
        for (const b of blocks) b.update();
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
      if (a.arm.binding) armLocals[a.arm.binding] = value;
      if (first) enterHydrate(el, c.claimed);
      blocks = a.arm.children.map((ch, i) => mountNode(ch, inst, a.names, armLocals, `${a.path}/${i}`));
      for (const b of blocks) if (b.el.parentNode !== el) el.appendChild(b.el);
      if (first) leaveHydrate();
    }
    update(true);
    return {
      el,
      update: () => update(false),
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
          patFn: compileExpr(patExpr, inst.meta.varNames, localNames),
          patExpr,
          binding: r.listBinding,
          names: r.listBinding ? dedupe([...localNames, r.listBinding]) : localNames,
          path: `${path}/route${i}`,
        };
      });
    let current = -1;
    let routeLocals = null;
    let blocks = null;
    function update(first = false) {
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
        if (routes[pick].binding) routeLocals[routes[pick].binding] = matchedParams;
        for (const b of blocks) b.update();
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
    update(true);
    return {
      el,
      update: () => update(false),
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

    const itemsFn = compileExpr(node.listExpr, inst.meta.varNames, localNames);
    const emptyExpr = node.namedArgs && node.namedArgs.empty;
    const emptyFn = emptyExpr !== undefined ? compileExpr(emptyExpr, inst.meta.varNames, localNames) : null;
    const binding = node.listBinding;
    const childLocalNames = binding ? dedupe([...localNames, binding]) : localNames;
    const rows = new Map(); // key -> { locals, blocks }
    let emptyEl = null;
    const seen = new Set();
    // role / label / aria on the list container (e.g. role: "listbox")
    const attrFns = [];
    for (const [arg, attr] of [['role', 'role'], ['label', 'aria-label']]) {
      const ex = node.namedArgs?.[arg];
      if (ex !== undefined) attrFns.push({ attr, ex, fn: compileExpr(ex, inst.meta.varNames, localNames) });
    }
    const ariaEx = node.namedArgs?.aria;
    const ariaFn = ariaEx !== undefined ? compileExpr(ariaEx, inst.meta.varNames, localNames) : null;
    // A list container can take events too (e.g. on_context_menu on its background).
    if (node.events && Object.keys(node.events).length) registerEvents(el, node, inst);

    function update() {
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
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        let key = itemKey(item, i);
        if (seen.has(key)) key = `${key}#${i}`;
        seen.add(key);
        order[i] = key;
        let row = rows.get(key);
        if (!row) {
          const rl = Object.create(locals);
          if (binding) rl[binding] = item;
          row = { locals: rl, blocks: null };
          row.blocks = node.children.map((c, ci) => mountNode(c, inst, childLocalNames, rl, `${path}/${key}/${ci}`));
          rows.set(key, row);
        } else {
          if (binding) row.locals[binding] = item;
          for (const b of row.blocks) b.update();
        }
      }

      for (const [key, row] of rows) {
        if (!seen.has(key)) {
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
      // Single forward pass: place each desired element at the cursor.
      let cursor = el.firstChild;
      for (let i = 0; i < order.length; i++) {
        const blocks = rows.get(order[i]).blocks;
        for (let j = 0; j < blocks.length; j++) {
          const n = blocks[j].el;
          if (n === cursor) cursor = cursor.nextSibling;
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

  // ---- scheduling ----------------------------------------------------------
  function invalidate() {
    if (scheduled || destroyed) return;
    scheduled = true;
    queueMicrotask(flush);
  }

  function flush() {
    scheduled = false;
    if (destroyed) return;
    updateInstance(rootInst);
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
    callbacks.onTransition?.({ instanceKey, viewName: inst.viewName, from, to: nextState, manual: true });
    flush();
  }

  function dispatch(e) {
    let t = e.target;
    while (t && t !== container) {
      const h = handlers.get(t);
      const fn = h && h[e.type];
      // Innermost handler wins: a button inside a clickable row must not
      // also trigger the row. A handler returns false to pass the event on.
      if (fn && fn(e) !== false) return;
      t = t.parentNode;
    }
  }

  // ---- drag and drop (in-app payloads; other drags pass through) -------------
  const closestIn = (map, node) => {
    for (let t = node; t && t !== container; t = t.parentNode) if (map.has(t)) return t;
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
    handlers.get(el)?.dragend?.(payload);
  }
  function onDrag(e) {
    switch (e.type) {
      case 'dragstart': {
        const src = closestIn(dragSources, e.target);
        if (!src) return;
        const { payload, text } = dragSources.get(src)();
        dragging = { payload, el: src };
        e.dataTransfer.effectAllowed = 'copyMove';
        e.dataTransfer.setData('text/plain', text || '');
        e.dataTransfer.setData('application/x-foar', String(rid));
        src.classList.add('f4-drag-source');
        container.classList.add('f4-dragging');
        handlers.get(src)?.dragstart?.(payload);
        return;
      }
      case 'dragover': {
        if (!dragging) return;
        const target = closestIn(dropTargets, e.target);
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
        const target = closestIn(dropTargets, e.target);
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

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const t of asyncTimers) clearTimeout(t);
    asyncTimers.clear();
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
  const rootInst = createInstance('root', rootViewDecl, {}, null, null);
  if (!hydrating) container.textContent = '';
  const rootEl = mountInstance(rootInst);
  if (rootEl.parentNode !== container) container.appendChild(rootEl);
  hydrating = false;
  hyCursor = null;
  hyStack.length = 0;
  for (const type of EVENT_TYPES) container.addEventListener(type, dispatch);
  for (const type of DRAG_TYPES) container.addEventListener(type, onDrag);
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
    /** Switch language: every t() re-evaluates in one flush. */
    setLocale(next) {
      if (!next) return;
      i18n.setLocale(next);
      applyLocale();
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
 * Zero-DOM Server-Side Rendering (runs in Node, Deno, Bun, Edge workers).
 * Returns `{ html, css, state, head }`.
 */
export function renderToString(ast, options = {}) {
  const rootViewDecl = ast.views[0];
  if (!rootViewDecl) return { html: '', css: '', state: { route: '/', instances: {} }, head: '' };

  const viewMap = new Map(ast.views.map((v) => [v.name, v]));
  const i18n = options.i18n && typeof options.i18n.t === 'function' ? options.i18n : createI18n(options.i18n || {});
  const t = i18n.t;
  const t_key = (key) => key;
  const parsed = parseUrl(options.url || '/');
  const route = { path: parsed.path, query: parsed.query, hash: parsed.hash, params: {} };
  const noop = () => {};
  const externs = Object.assign(Object.create(null), { random_uuid, t, t_key, route, navigate: noop, replace: noop }, options.bindings || {});
  const externNames = Object.keys(externs).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
  const serializedInstances = {};

  const evalSafe = (expr, vn, vars, ln, locals) => {
    try {
      return compileExpr(expr, vn, ln)(vars, locals);
    } catch {
      return undefined;
    }
  };

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

  function renderView(key, decl, props) {
    const propNames = decl.params.map((p) => p.name);
    const storeNames = decl.stores.map((s) => s.name);
    const derivedNames = (decl.derived || []).map((d) => d.name);
    const varNames = dedupe([...propNames, ...storeNames, ...derivedNames]);
    const viewExterns = externNames.filter((n) => !varNames.includes(n));
    const vars = {};
    for (const p of propNames) vars[p] = props[p];
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
      ? firstState.render.map((n, i) => renderNode(n, key, varNames, vars, viewExterns, externs, String(i))).join('')
      : '';
    return `<div${attrsStr([['class', cls], ['data-view-name', decl.name], ['data-key', key], ['data-state-name', stateName], ['style', st]])}>${inner}</div>`;
  }

  function renderNode(node, instKey, vn, vars, ln, locals, path) {
    if (viewMap.has(node.tag)) {
      const childDecl = viewMap.get(node.tag);
      const props = {};
      node.args.forEach((expr, i) => {
        const p = childDecl.params[i];
        if (p) props[p.name] = evalSafe(expr, vn, vars, ln, locals);
      });
      for (const [name, expr] of Object.entries(node.namedArgs)) {
        props[name] = evalSafe(expr, vn, vars, ln, locals);
      }
      return renderView(`${instKey}/${path}`, childDecl, props);
    }
    if (node.tag === 'If') {
      const cond = node.args[0] !== undefined ? Boolean(evalSafe(node.args[0], vn, vars, ln, locals)) : false;
      const list = cond ? node.children : node.elseChildren || null;
      const inner = list ? list.map((c, i) => renderNode(c, instKey, vn, vars, ln, locals, `${path}/${cond ? 'if' : 'else'}${i}`)).join('') : '';
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
        if (a.binding) scope[a.binding] = value;
        if (evalSafe(a.test, vn, vars, names, scope)) {
          inner = a.children.map((c, ci) => renderNode(c, instKey, vn, vars, names, scope, `${path}/arm${i}/${ci}`)).join('');
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
          inner = r.children.map((c, ci) => renderNode(c, instKey, vn, vars, names, scope, `${path}/route${i}/${ci}`)).join('');
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
        return node.children.map((c, ci) => renderNode(c, instKey, vn, vars, childLn, rl, `${path}/${k}/${ci}`)).join('');
      }).join('');
      return `<div${attrsStr(attrs)}>${rowsHtml}</div>`;
    }

    // Standard elements
    const na = node.namedArgs || {};
    const commonAttrs = (baseCls, extra = []) => {
      const cls = [baseCls, node.style?.cls].filter(Boolean).join(' ');
      const out = [['class', cls], ...extra];
      const st = styleAttr(node.style, vn, vars, ln, locals);
      if (st) out.push(['style', st]);
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
          ? node.children.map((c, i) => renderNode(c, instKey, vn, vars, ln, locals, `${path}/${i}`)).join('')
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
      case 'Row':
      case 'Column': {
        const base = node.tag === 'Row' ? 'f4-row' : 'f4-column';
        const inner = node.children.map((c, i) => renderNode(c, instKey, vn, vars, ln, locals, `${path}/${i}`)).join('');
        return `<div${commonAttrs(base)}>${inner}</div>`;
      }
      default:
        return `<div>${escapeHtml(`[Unknown element: ${node.tag}]`)}</div>`;
    }
  }

  const html = renderView('root', rootViewDecl, {});
  const css = `${BASE_CSS}\n${ast.css || ''}`;
  const state = { route: options.url || '/', instances: serializedInstances };
  const safeState = JSON.stringify(state).replace(/</g, '\\u003c');
  const head = `<style data-f4-ssr>${css}</style>\n<script id="__foar_state__" type="application/json">${safeState}</script>`;
  return { html, css, state, head };
}
