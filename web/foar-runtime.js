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
// Public API: createFoarRuntime(ast, container, callbacks) ->
//   { renderApp, flush, getSnapshot, forceStateTransition, invokeEffect, destroy }
//
// callbacks: { onRender(snapshot), onEffect(info), onTransition(info), onEmit(info),
//              bindings: { [apiName]: async fn },  // external async bindings
//              asyncDelay: ms,                      // simulated latency when no binding
//              badges: true }                       // render dev-only state badges per view

const EVENT_TYPES = ['click', 'dblclick', 'input', 'change', 'keydown', 'contextmenu', 'focusout'];
const EVENT_MAP = {
  on_click: 'click',
  on_double_click: 'dblclick',
  on_input: 'input',
  on_change: 'change',
  on_enter: 'keydown',
  on_context_menu: 'contextmenu',
  on_blur: 'focusout',
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
export function createFoarRuntime(ast, container, callbacks = {}) {
  const rootViewDecl = ast.views[0];
  if (!rootViewDecl) {
    container.textContent = 'No view declarations found in .foar file.';
    return null;
  }

  const rid = ++runtimeCounter;
  const doc = container.ownerDocument;
  const viewMap = new Map(ast.views.map((v) => [v.name, v]));
  const instances = new Map(); // key -> instance (live registry)
  const handlers = new WeakMap(); // element -> { [eventType]: fn }
  const asyncTimers = new Set();
  const warned = new Set();
  const badges = callbacks.badges === true;
  // Host functions callable from .foar expressions and effects
  // (`persist(notes);`, `Text(fmt_date(note.updated))`).
  const externs = Object.assign(Object.create(null), { random_uuid }, callbacks.bindings || {});
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

  const styleEl = doc.createElement('style');
  styleEl.setAttribute('data-f4-runtime', String(rid));
  styleEl.textContent = `${BASE_CSS}\n${ast.css || ''}`;
  (doc.head || doc.documentElement).appendChild(styleEl);

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
    const states = new Map();
    for (const s of decl.states) {
      states.set(s.name, { decl: s, effects: new Map(s.effects.map((e) => [e.name, e])) });
    }
    m = {
      decl,
      propNames,
      storeNames,
      varNames: dedupe([...propNames, ...storeNames]),
      // host functions visible in this view: its own props/stores win on a name clash
      externNames: externNames.filter((n) => !propNames.includes(n) && !storeNames.includes(n)),
      states,
      firstState: decl.states[0] || null,
      hostStyle: compileStyle(decl.style),
    };
    viewMeta.set(decl, m);
    return m;
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
    const initLocals = externs;
    for (const st of decl.stores) {
      const fn = compileExpr(st.initExpr, meta.varNames, meta.externNames);
      vars[st.name] = safeEval(fn, vars, initLocals, st.initExpr);
    }
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
    const { storeNames, propNames } = inst.meta;
    const c = compileEffect(eff, storeNames, propNames, externNames, effectCache);
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
    const host = doc.createElement('div');
    host.className = `f4-view-host f4-view-${inst.viewName}`;
    addClasses(host, meta.hostStyle.cls);
    host.dataset.viewName = inst.viewName;

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
    return host;
  }

  function mountState(inst) {
    const st = inst.meta.states.get(inst.state) || (inst.meta.firstState && inst.meta.states.get(inst.meta.firstState.name));
    inst.mountedState = inst.state;
    inst.host.dataset.stateName = inst.state;
    if (inst.badgeState) inst.badgeState.textContent = inst.state;
    inst.blocks = st ? st.decl.render.map((node, i) => mountNode(node, inst, inst.meta.externNames, externs, String(i))) : [];
    for (const b of inst.blocks) inst.host.appendChild(b.el);
  }

  function unmountState(inst) {
    for (const b of inst.blocks) {
      b.dispose();
      b.el.remove();
    }
    inst.blocks = [];
  }

  function updateInstance(inst) {
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
            e.preventDefault();
            invokeEffect(inst, handlerName);
          };
          break;
        case 'on_change':
          map.change = (e) => invokeEffect(inst, handlerName, e.target.checked);
          break;
        case 'on_enter':
          map.keydown = (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              invokeEffect(inst, handlerName);
            }
          };
          break;
        default:
          map[domType] = () => invokeEffect(inst, handlerName);
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
        el = doc.createElement('div');
        el.className = 'f4-text';
        if (node.args[0]) bind(node.args[0], (v) => { el.textContent = v ?? ''; });
        if (node.events.on_click || node.events.on_double_click) {
          el.dataset.clickable = '';
          if (node.events.on_double_click) el.title = 'Double-click to trigger ' + node.events.on_double_click;
        }
        break;
      }
      case 'Button': {
        el = doc.createElement('button');
        el.className = 'f4-button';
        el.type = 'button';
        if (node.args[0]) bind(node.args[0], (v) => { el.textContent = v ?? ''; });
        else el.textContent = 'Button';
        break;
      }
      case 'Input': {
        el = doc.createElement('input');
        el.className = 'f4-input';
        el.type = node.namedArgs.secure !== undefined ? 'password' : 'text';
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
        el = doc.createElement('textarea');
        el.className = 'f4-textarea';
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
        el = doc.createElement('input');
        el.className = 'f4-checkbox';
        el.type = 'checkbox';
        if (node.namedArgs.checked !== undefined) {
          bind(node.namedArgs.checked, (v) => {
            const c = Boolean(v);
            if (el.checked !== c) el.checked = c;
          }, true);
        }
        break;
      }
      case 'RichText': {
        // contenteditable editor; `value` is HTML. Live binding: only written
        // when the store differs from the DOM, so typing never resets the caret.
        el = doc.createElement('div');
        el.className = 'f4-richtext';
        el.contentEditable = 'true';
        el.spellcheck = true;
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
          bind(node.namedArgs.editable, (v) => { el.contentEditable = v ? 'true' : 'false'; });
        }
        break;
      }
      case 'Image': {
        el = doc.createElement('img');
        el.className = 'f4-image';
        el.decoding = 'async';
        el.loading = 'lazy';
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
        el = doc.createElement('div');
        el.className = 'f4-spinner-wrap';
        const ring = doc.createElement('div');
        ring.className = 'f4-spinner-ring';
        const txt = doc.createElement('span');
        el.append(ring, txt);
        if (node.args[0]) bind(node.args[0], (v) => { txt.textContent = v ?? ''; });
        else txt.textContent = 'Loading...';
        break;
      }
      case 'Row':
      case 'Column': {
        el = doc.createElement('div');
        el.className = node.tag === 'Row' ? 'f4-row' : 'f4-column';
        children = node.children.map((c, i) => mountNode(c, inst, localNames, locals, `${path}/${i}`));
        for (const c of children) el.appendChild(c.el);
        break;
      }
      default: {
        el = doc.createElement('div');
        el.textContent = `[Unknown element: ${node.tag}]`;
      }
    }

    const sc = compileStyle(node.style);
    addClasses(el, sc.cls);
    for (const d of sc.dynamic) bind(d.expr, (v) => applyInlineStyle(el, d.key, v));
    if (node.namedArgs.title !== undefined && node.tag !== 'Image') {
      bind(node.namedArgs.title, (v) => { if (v) el.title = v; else el.removeAttribute('title'); });
    }
    registerEvents(el, node, inst);
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
  function mountIf(node, inst, localNames, locals, path) {
    const el = doc.createElement('div');
    el.className = 'f4-if';
    el.style.display = 'contents';
    const expr = node.args[0] !== undefined ? node.args[0] : 'false';
    const fn = compileExpr(expr, inst.meta.varNames, localNames);
    let blocks = null;
    function update() {
      const on = Boolean(safeEval(fn, inst.vars, locals, expr));
      if (on && !blocks) {
        blocks = node.children.map((c, i) => mountNode(c, inst, localNames, locals, `${path}/if${i}`));
        for (const b of blocks) el.appendChild(b.el);
      } else if (!on && blocks) {
        for (const b of blocks) {
          b.dispose();
          b.el.remove();
        }
        blocks = null;
      } else if (on) {
        for (const b of blocks) b.update();
      }
    }
    update();
    return {
      el,
      update,
      dispose() {
        if (blocks) for (const b of blocks) b.dispose();
        blocks = null;
      },
    };
  }

  function mountList(node, inst, localNames, locals, path) {
    const el = doc.createElement('div');
    el.className = 'f4-list';
    addClasses(el, compileStyle(node.style).cls);

    const itemsFn = compileExpr(node.listExpr, inst.meta.varNames, localNames);
    const emptyExpr = node.namedArgs && node.namedArgs.empty;
    const emptyFn = emptyExpr !== undefined ? compileExpr(emptyExpr, inst.meta.varNames, localNames) : null;
    const binding = node.listBinding;
    const childLocalNames = binding ? dedupe([...localNames, binding]) : localNames;
    const rows = new Map(); // key -> { locals, blocks }
    let emptyEl = null;
    const seen = new Set();

    function update() {
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

    update();
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
      if (fn) {
        // Innermost handler wins: a button inside a clickable row must not
        // also trigger the row.
        fn(e);
        return;
      }
      t = t.parentNode;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const t of asyncTimers) clearTimeout(t);
    asyncTimers.clear();
    for (const type of EVENT_TYPES) container.removeEventListener(type, dispatch);
    disposeInstance(rootInst);
    styleEl.remove();
    container.textContent = '';
  }

  // ---- boot ----------------------------------------------------------------
  const rootInst = createInstance('root', rootViewDecl, {}, null, null);
  container.textContent = '';
  container.appendChild(mountInstance(rootInst));
  for (const type of EVENT_TYPES) container.addEventListener(type, dispatch);
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
    destroy,
  };
}
