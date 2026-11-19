// Source analysis for the language service: a tolerant scanner (it never fails
// on half-typed code) that finds views, params, stores, states, effects, named
// styles, data types, theme variables and imports, the regions they span (to
// know what the caret is inside), and the references to check (transitions,
// handlers, styles, CSS variables, events).

const TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|--[A-Za-z0-9_-]+|@[A-Za-z][\w-]*|#[\w-]+|\d[\w.%]*|[A-Za-z_$][\w$]*|->|=>|\S/g;

/** Tokens (comments left out) + the comment/string spans. */
export function tokenize(text) {
  const toks = [];
  const skips = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const v = m[0];
    const s = m.index;
    const e = s + v.length;
    const c = v[0];
    if (c === '/' && (v[1] === '/' || v[1] === '*')) {
      skips.push({ kind: 'comment', s, e });
      continue;
    }
    let k;
    if (c === '"' || c === "'") {
      k = 'str';
      skips.push({ kind: 'string', s, e, closed: v.length > 1 && v.endsWith(c) && !v.endsWith(`\\${c}`) });
    } else if (v.startsWith('--')) k = 'cssvar';
    else if (c === '@') k = 'at';
    else if (c === '#') k = 'hash';
    else if (/\d/.test(c)) k = 'num';
    else if (/[A-Za-z_$]/.test(c)) k = 'id';
    else k = 'p';
    toks.push({ k, v, s, e });
  }
  return { toks, skips };
}

const OPEN = { '(': ')', '{': '}', '[': ']' };

function matchBrackets(toks) {
  const match = new Int32Array(toks.length).fill(-1);
  const stack = [];
  toks.forEach((t, i) => {
    if (t.k !== 'p') return;
    if (OPEN[t.v]) stack.push(i);
    else if (t.v === ')' || t.v === '}' || t.v === ']') {
      // tolerate mismatches: pop to the nearest matching opener
      for (let j = stack.length - 1; j >= 0; j--) {
        if (OPEN[toks[stack[j]].v] === t.v) {
          match[stack[j]] = i;
          match[i] = stack[j];
          stack.length = j;
          break;
        }
      }
    }
  });
  return match;
}

/** Analyzes one file. Offsets are into `text`. */
export function analyzeFile(path, text) {
  const { toks, skips } = tokenize(text);
  const match = matchBrackets(toks);
  const end = (i) => (match[i] >= 0 ? match[i] : toks.length - 1);
  const offEnd = (i) => (match[i] >= 0 ? toks[match[i]].s : text.length);
  const f = {
    path,
    text,
    toks,
    skips,
    match,
    views: [],
    styles: [],
    datas: [],
    cssVars: [],
    keyframes: [],
    imports: [],
    enums: [],
    regions: [],
    refs: { transitions: [], handlers: [], styleUses: [], varUses: [], events: [], elements: [], stateStyles: [] },
  };
  const region = (kind, openIdx, extra = {}) => {
    const r = { kind, start: toks[openIdx].e, end: offEnd(openIdx), ...extra };
    f.regions.push(r);
    return r;
  };
  const is = (i, v) => toks[i] && toks[i].v === v && toks[i].k !== 'str';

  // params "(a: T, b: Vec<T>)" between parens
  function params(openIdx) {
    const out = [];
    const close = end(openIdx);
    let i = openIdx + 1;
    while (i < close) {
      if (toks[i].k === 'id' && is(i + 1, ':')) {
        let j = i + 2;
        let depth = 0;
        const typeToks = [];
        while (j < close && !(depth === 0 && is(j, ','))) {
          if (is(j, '<')) depth++;
          if (is(j, '>')) depth--;
          typeToks.push(toks[j].v);
          j++;
        }
        out.push({ name: toks[i].v, type: typeToks.join(''), offset: toks[i].s });
        i = j + 1;
      } else i++;
    }
    return out;
  }

  // style blocks: declarations of --vars, var() uses, @use, @state
  function scanStyle(a, b, ctx) {
    for (let i = a; i < b; i++) {
      const t = toks[i];
      if (t.k === 'cssvar') {
        if (is(i + 1, ':') && !(is(i - 1, '(') && toks[i - 2]?.v === 'var')) {
          let j = i + 2;
          while (j < b && !is(j, ';') && !is(j, '}')) j++;
          f.cssVars.push({ name: t.v, value: text.slice(toks[i + 2]?.s ?? t.e, toks[j]?.s ?? t.e).trim(), offset: t.s, path, dark: ctx.dark });
        } else f.refs.varUses.push({ name: t.v, s: t.s, e: t.e });
      } else if (t.v === '@use' && toks[i + 1]?.k === 'id') {
        f.refs.styleUses.push({ name: toks[i + 1].v, s: toks[i + 1].s, e: toks[i + 1].e });
      } else if (t.v === '@state' && toks[i + 1]?.k === 'id' && ctx.view) {
        f.refs.stateStyles.push({ name: toks[i + 1].v, view: ctx.view, s: toks[i + 1].s, e: toks[i + 1].e });
      } else if (t.v === '@dark' && is(i + 1, '{')) {
        scanStyle(i + 2, end(i + 1), { ...ctx, dark: true });
        i = end(i + 1);
      }
    }
  }

  // render blocks: elements, calls, .style(...), -> events (handlers)
  function scanRender(a, b, view, state) {
    const lastElem = [];
    let depth = 0;
    for (let i = a; i < b; i++) {
      const t = toks[i];
      if (t.k === 'p' && OPEN[t.v]) depth++;
      else if (t.k === 'p' && (t.v === ')' || t.v === '}' || t.v === ']')) depth--;
      if (t.k === 'id' && /^[A-Z]/.test(t.v) && (is(i + 1, '(') || is(i + 1, '{')) && !is(i - 1, '.')) {
        f.refs.elements.push({ tag: t.v, s: t.s, e: t.e, view });
        lastElem[depth] = t.v;
        if (is(i + 1, '(')) region('call', i + 1, { tag: t.v, view: view.name, state: state?.name });
      } else if (t.v === '.' && is(i + 1, 'style') && is(i + 2, '(')) {
        const open = i + 2;
        const close = end(open);
        region('styleArgs', open, { view: view.name, state: state?.name });
        for (let j = open + 1; j < close; j++) {
          if (is(j, '{')) {
            region('style', j, { view: view.name, state: state?.name });
            scanStyle(j + 1, end(j), { view: view.name });
            j = end(j);
          } else if (toks[j].k === 'id' && /^[A-Z]/.test(toks[j].v)) f.refs.styleUses.push({ name: toks[j].v, s: toks[j].s, e: toks[j].e });
        }
      } else if (t.v === '->' && toks[i + 1]?.k === 'id') {
        const ev = toks[i + 1];
        f.refs.events.push({ name: ev.v, tag: lastElem[depth], s: ev.s, e: ev.e, view: view.name });
        if (is(i + 2, '(')) {
          region('handler', i + 2, { view: view.name, state: state?.name });
          const h = toks[i + 3];
          if (h?.k === 'id' && is(i + 4, ')')) f.refs.handlers.push({ name: h.v, s: h.s, e: h.e, view: view.name, state: state?.name });
        }
      }
    }
  }

  function scanEffect(a, b, view) {
    for (let i = a; i < b; i++) {
      const t = toks[i];
      if (t.v === 'transition' && t.k === 'id') {
        const n = is(i + 1, '(') ? toks[i + 2] : toks[i + 1];
        if (n?.k === 'id') f.refs.transitions.push({ name: n.v, s: n.s, e: n.e, view: view.name });
      } else if (t.v === 'emit' && t.k === 'id' && toks[i + 1]?.k === 'id') view.emits.add(toks[i + 1].v);
      else if (t.v === '->' && is(i + 1, 'transition') && is(i + 2, '(') && toks[i + 3]?.k === 'id') {
        f.refs.transitions.push({ name: toks[i + 3].v, s: toks[i + 3].s, e: toks[i + 3].e, view: view.name });
      }
    }
  }

  function parseView(i) {
    const nameTok = toks[i + 1];
    if (nameTok?.k !== 'id') return i + 1;
    const view = { name: nameTok.v, offset: nameTok.s, path, params: [], stores: [], lets: [], states: [], emits: new Set(), start: toks[i].s, end: text.length };
    let j = i + 2;
    if (is(j, '(')) {
      region('params', j, { view: view.name });
      view.params = params(j);
      j = end(j) + 1;
    }
    if (!is(j, '{')) {
      f.views.push(view);
      return j;
    }
    const bodyOpen = j;
    const bodyClose = end(j);
    view.end = offEnd(j);
    region('view', bodyOpen, { view: view.name });
    let k = bodyOpen + 1;
    while (k < bodyClose) {
      const t = toks[k];
      if (t.v === 'store' && toks[k + 1]?.k === 'id') {
        const n = toks[k + 1];
        let m = k + 2;
        const typeToks = [];
        if (is(m, ':')) {
          m++;
          while (m < bodyClose && !is(m, '=') && !is(m, ';')) typeToks.push(toks[m++].v);
        }
        while (m < bodyClose && !is(m, ';') && !(toks[m].k === 'id' && ['store', 'state', 'style'].includes(toks[m].v) && toks[m].s > n.e && text.slice(n.e, toks[m].s).includes('\n'))) {
          if (toks[m].k === 'p' && OPEN[toks[m].v]) m = end(m);
          m++;
        }
        view.stores.push({ name: n.v, type: typeToks.join(''), offset: n.s });
        k = m + 1;
      } else if (t.v === 'let' && toks[k + 1]?.k === 'id') {
        const n = toks[k + 1];
        let m = k + 2;
        const typeToks = [];
        if (is(m, ':')) {
          m++;
          while (m < bodyClose && !is(m, '=') && !is(m, ';')) typeToks.push(toks[m++].v);
        }
        while (m < bodyClose && !is(m, ';')) m = toks[m].k === 'p' && OPEN[toks[m].v] ? end(m) + 1 : m + 1;
        view.lets.push({ name: n.v, type: typeToks.join('') || 'derived', offset: n.s });
        k = m + 1;
      } else if (t.v === 'style' && is(k + 1, '{')) {
        region('style', k + 1, { view: view.name });
        scanStyle(k + 2, end(k + 1), { view: view.name });
        k = end(k + 1) + 1;
      } else if (t.v === 'state' && toks[k + 1]?.k === 'id' && is(k + 2, '{')) {
        const st = { name: toks[k + 1].v, offset: toks[k + 1].s, effects: [], start: toks[k].s, end: offEnd(k + 2) };
        view.states.push(st);
        region('state', k + 2, { view: view.name, state: st.name });
        const sEnd = end(k + 2);
        let m = k + 3;
        while (m < sEnd) {
          const u = toks[m];
          if (u.v === 'render' && is(m + 1, '{')) {
            region('render', m + 1, { view: view.name, state: st.name });
            scanRender(m + 2, end(m + 1), view, st);
            m = end(m + 1) + 1;
          } else if (u.v === 'effect' && toks[m + 1]?.k === 'id') {
            const ef = { name: toks[m + 1].v, offset: toks[m + 1].s, params: [], state: st.name };
            let n = m + 2;
            if (is(n, '(')) {
              region('effectParams', n, { view: view.name, state: st.name });
              ef.params = params(n);
              n = end(n) + 1;
            }
            if (is(n, '{')) {
              region('effect', n, { view: view.name, state: st.name, effect: ef.name, params: ef.params });
              scanEffect(n + 1, end(n), view);
              n = end(n) + 1;
            }
            st.effects.push(ef);
            m = n;
          } else if (u.v === 'on_exit' && is(m + 1, '{')) {
            region('effect', m + 1, { view: view.name, state: st.name, effect: 'on_exit', params: [] });
            scanEffect(m + 2, end(m + 1), view);
            st.hasOnExit = true;
            m = end(m + 1) + 1;
          } else m = u.k === 'p' && OPEN[u.v] ? end(m) + 1 : m + 1;
        }
        k = sEnd + 1;
      } else k = t.k === 'p' && OPEN[t.v] ? end(k) + 1 : k + 1;
    }
    f.views.push(view);
    return bodyClose + 1;
  }

  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.k === 'id' && t.v === 'view') i = parseView(i);
    else if (t.k === 'id' && t.v === 'import' && toks[i + 1]?.k === 'str') {
      const s = toks[i + 1];
      f.imports.push({ spec: s.v.slice(1, s.v.endsWith('"') && s.v.length > 1 ? -1 : undefined), s: s.s + 1, e: s.e - (s.v.endsWith('"') && s.v.length > 1 ? 1 : 0) });
      i += 2;
    } else if (t.k === 'id' && t.v === 'style' && toks[i + 1]?.k === 'id' && is(i + 2, '{')) {
      const st = { name: toks[i + 1].v, offset: toks[i + 1].s, path, start: toks[i].s, end: offEnd(i + 2) };
      f.styles.push(st);
      region('style', i + 2, { style: st.name });
      scanStyle(i + 3, end(i + 2), {});
      i = end(i + 2) + 1;
    } else if (t.k === 'id' && t.v === 'theme' && is(i + 1, '{')) {
      region('style', i + 1, { theme: true });
      scanStyle(i + 2, end(i + 1), {});
      i = end(i + 1) + 1;
    } else if (t.k === 'id' && t.v === 'css' && is(i + 1, '{')) {
      region('css', i + 1);
      scanStyle(i + 2, end(i + 1), {});
      i = end(i + 1) + 1;
    } else if (t.k === 'id' && t.v === 'enum' && toks[i + 1]?.k === 'id' && is(i + 2, '{')) {
      const close = end(i + 2);
      const en = { name: toks[i + 1].v, offset: toks[i + 1].s, path, variants: [] };
      for (let j = i + 3; j < close; j++) {
        if (toks[j].k !== 'id') continue;
        let value = JSON.stringify(toks[j].v);
        if (is(j + 1, '=') && toks[j + 2]) {
          value = toks[j + 2].v;
          en.variants.push({ name: toks[j].v, value, offset: toks[j].s });
          j += 2;
        } else en.variants.push({ name: toks[j].v, value, offset: toks[j].s });
      }
      f.enums.push(en);
      region('enum', i + 2, { enum: en.name });
      i = close + 1;
    } else if (t.k === 'id' && t.v === 'data' && toks[i + 1]?.k === 'id' && is(i + 2, '{')) {
      const d = { name: toks[i + 1].v, offset: toks[i + 1].s, path, fields: [] };
      const close = end(i + 2);
      for (let j = i + 3; j < close; j++) {
        if (toks[j].k === 'id' && is(j + 1, ':')) {
          let k = j + 2;
          const ty = [];
          while (k < close && !is(k, ',')) ty.push(toks[k++].v);
          d.fields.push({ name: toks[j].v, type: ty.join('') });
          j = k;
        }
      }
      f.datas.push(d);
      region('data', i + 2, { data: d.name });
      i = close + 1;
    } else if (t.v === '@keyframes' && toks[i + 1]) {
      // names may contain "-": take everything up to the "{"
      let j = i + 1;
      while (j < toks.length && !is(j, '{') && !text.slice(toks[i].e, toks[j].s).includes('\n')) j++;
      const name = text.slice(toks[i + 1].s, toks[j]?.s ?? text.length).trim();
      f.keyframes.push({ name, offset: toks[i + 1].s, path });
      if (is(j, '{')) {
        region('keyframes', j);
        i = end(j) + 1;
      } else i = j;
    } else i = t.k === 'p' && OPEN[t.v] ? end(i) + 1 : i + 1;
  }
  return f;
}

/** Index of a whole project: { files: Map<path, file>, views, styles, datas, cssVars, keyframes }. */
export function analyzeProject(files, prev = null) {
  const out = { files: new Map(), views: new Map(), styles: new Map(), datas: new Map(), cssVars: new Map(), keyframes: new Map(), enums: new Map() };
  for (const [path, text] of Object.entries(files)) {
    const old = prev?.files.get(path);
    const f = old && old.text === text ? old : analyzeFile(path, text);
    out.files.set(path, f);
    for (const v of f.views) if (!out.views.has(v.name)) out.views.set(v.name, v);
    for (const s of f.styles) if (!out.styles.has(s.name)) out.styles.set(s.name, s);
    for (const d of f.datas) if (!out.datas.has(d.name)) out.datas.set(d.name, d);
    for (const e of f.enums) if (!out.enums.has(e.name)) out.enums.set(e.name, e);
    for (const k of f.keyframes) out.keyframes.set(k.name, k);
    for (const c of f.cssVars) {
      if (!out.cssVars.has(c.name)) out.cssVars.set(c.name, []);
      out.cssVars.get(c.name).push(c);
    }
  }
  return out;
}

/** The innermost region around `offset` (or null at the top level). */
export function regionAt(file, offset) {
  let best = null;
  for (const r of file.regions) {
    if (r.start <= offset && offset <= r.end && (!best || r.end - r.start <= best.end - best.start)) best = r;
  }
  return best;
}

/** Comment or string span containing `offset` (strictly inside). */
export function skipAt(file, offset) {
  for (const s of file.skips) {
    if (s.s < offset && (offset < s.e || (s.kind === 'string' && !s.closed && offset <= s.e) || (s.kind === 'comment' && offset <= s.e && file.text[s.s + 1] === '/'))) return s;
    if (s.s >= offset) break;
  }
  return null;
}

/** The identifier-ish word at `offset`: { word, s, e } (includes @ and -- prefixes). */
export function wordAt(text, offset) {
  let s = offset;
  let e = offset;
  while (s > 0 && /[\w$-]/.test(text[s - 1])) s--;
  if (s > 0 && text[s - 1] === '@') s--;
  while (e < text.length && /[\w$-]/.test(text[e])) e++;
  let word = text.slice(s, e);
  // a word like "a-b" outside CSS: keep the part under the caret
  if (!word.startsWith('--') && !word.startsWith('@') && word.includes('-') && !/^[a-z]+(-[a-z]+)+$/.test(word)) {
    s = offset;
    e = offset;
    while (s > 0 && /[\w$]/.test(text[s - 1])) s--;
    while (e < text.length && /[\w$]/.test(text[e])) e++;
    word = text.slice(s, e);
  }
  return { word, s, e };
}
