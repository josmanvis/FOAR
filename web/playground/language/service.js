// The FOAR language service: completions, signature help, hover, diagnostics,
// go to definition, references, rename and formatting — over the whole project.
import { analyzeProject, regionAt, skipAt, tokenize, wordAt } from './analysis.js';
import { argDoc, CSS_PROPS, cssValues, ELEMENTS, EVENTS, FOAR_PROPS, isCssProp, KEYWORDS, SNIPPETS, STYLE_AT, STYLE_AT_SNIPPETS, TYPES } from './catalog.js';

const METHODS = {
  push: 'Append to a list: `items.push(x)`',
  retain: 'Keep the items that match: `items.retain(|t| t.id != id)`',
  filter: 'Items that match: `items.filter(|t| t.done)`',
  map: 'Transform each item: `items.map(|t| t.title)`',
  find: 'First item that matches.',
  find_index: 'Index of the first item that matches (Some(i) / None).',
  is_empty: 'True for an empty string or list.',
  len: 'Length of a string or list.',
  contains: 'Substring / item test.',
  starts_with: 'Prefix test.',
  ends_with: 'Suffix test.',
  to_lowercase: 'Lowercase copy.',
  to_uppercase: 'Uppercase copy.',
  trim: 'Without surrounding whitespace.',
  join: 'Join a list of strings: `parts.join(", ")`',
  slice: 'Part of a string or list.',
  sort_by: 'Sort a list in place: `items.sort_by(|a, b| a.order - b.order)`',
};

const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const didYouMean = (name, options) => {
  let best = null;
  let bestD = Infinity;
  for (const o of options) {
    const dd = lev(name.toLowerCase(), o.toLowerCase());
    if (dd < bestD) {
      bestD = dd;
      best = o;
    }
  }
  return best && bestD <= Math.max(2, Math.floor(name.length / 3)) ? ` Did you mean '${best}'?` : '';
};
const lineOf = (text, off) => text.slice(0, off).split('\n').length;

export function createLanguageService() {
  let index = null;

  const fileOf = (path) => index?.files.get(path);
  const viewAt = (f, offset) => f.views.find((v) => v.start <= offset && offset <= v.end);
  const ctxEffectSig = (c, e) => `${c.name}.${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')})`;
  const ctxSummary = (c) =>
    [`context ${c.name} {`, ...c.stores.map((s) => `    store ${s.name}: ${s.type};`), ...c.lets.map((l) => `    let ${l.name}${l.type !== 'derived' ? `: ${l.type}` : ''};`), ...c.effects.map((e) => `    effect ${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')})`), '}'].join('\n');
  const ctxMembers = (c, effectsOnly = false) => [
    ...c.effects.map((e) => ({ label: e.name, kind: 'effect', detail: ctxEffectSig(c, e), insert: effectsOnly ? e.name : `${e.name}($1)`, sort: '0' })),
    ...(effectsOnly ? [] : [...c.stores.map((s) => ({ label: s.name, kind: 'variable', detail: `store ${s.name}: ${s.type}`, doc: `in context ${c.name}`, insert: s.name, sort: '1' })), ...c.lets.map((l) => ({ label: l.name, kind: 'variable', detail: `let ${l.name}${l.type !== 'derived' ? `: ${l.type}` : ''}`, doc: `derived, in context ${c.name}`, insert: l.name, sort: '1' }))]),
  ];
  const viewSig = (v) => `view ${v.name}${v.typeParams?.length ? `<${v.typeParams.join(", ")}>` : ""}${v.params.length ? `(${v.params.map((p) => `${p.name}: ${p.type}${p.default != null ? ` = ${p.default}` : ''}`).join(', ')})` : ''}`;
  const allEffects = (v) => v.states.flatMap((s) => s.effects.map((e) => ({ ...e, state: s.name })));

  // the element a "-> on_x" chain belongs to (walk back over balanced brackets)
  function ownerTag(f, offset) {
    let i = f.toks.findLastIndex((t) => t.e <= offset);
    while (i >= 0) {
      const t = f.toks[i];
      if (t.k === 'p' && (t.v === ')' || t.v === '}' || t.v === ']')) {
        const o = f.match[i];
        if (o < 0) return null;
        const prev = f.toks[o - 1];
        if (prev?.k === 'id' && /^[A-Z]/.test(prev.v) && f.toks[o - 2]?.v !== '.') return prev.v;
        i = o - 1;
        continue;
      }
      if (t.k === 'p' && (t.v === '{' || t.v === '(' || t.v === ';' || t.v === '[')) return null;
      if (t.k === 'id' && /^[A-Z]/.test(t.v) && f.toks[i - 1]?.v !== '.' && f.toks[i + 1]?.v !== '(' && f.toks[i + 1]?.v !== '{') return null;
      i--;
    }
    return null;
  }

  // the call "Tag(" around offset, and which argument the caret is in
  function callAt(f, offset) {
    let depth = 0;
    let i = f.toks.findLastIndex((t) => t.e <= offset);
    let commas = 0;
    let named = null;
    for (; i >= 0; i--) {
      const t = f.toks[i];
      if (t.k !== 'p' && t.k !== 'id') continue;
      if (t.v === ')' || t.v === '}' || t.v === ']') depth++;
      else if (t.v === '(' || t.v === '{' || t.v === '[') {
        if (depth === 0) {
          if (t.v !== '(') return null;
          const callee = f.toks[i - 1];
          if (callee?.k !== 'id') return null;
          return { callee: callee.v, open: t.e, commas, named, method: f.toks[i - 2]?.v === '.' };
        }
        depth--;
      } else if (depth === 0 && t.v === ',') commas++;
      else if (depth === 0 && t.k === 'id' && f.toks[i + 1]?.v === ':' && named === null && commas === 0) named = t.v;
      else if (depth === 0 && t.v === ';') return null;
    }
    return null;
  }

  function localsAt(f, r, offset) {
    // "{ item =>" list bindings between the render start and the caret
    const out = [];
    if (!r) return out;
    const render = f.regions.filter((x) => x.kind === 'render' && x.start <= offset && offset <= x.end)[0];
    if (!render) return out;
    for (const m of f.text.slice(render.start, offset).matchAll(/\{\s*(\w+)\s*=>/g)) out.push(m[1]);
    return out;
  }

  function expressionItems(f, r, offset, view) {
    const items = [];
    if (view) {
      for (const s of view.stores) items.push({ label: s.name, kind: 'variable', detail: `store ${s.name}: ${s.type}`, insert: s.name });
      for (const p of view.params) items.push({ label: p.name, kind: 'variable', detail: `param ${p.name}: ${p.type}`, insert: p.name });
      for (const l of view.lets ?? []) items.push({ label: l.name, kind: 'variable', detail: `let ${l.name}`, doc: 'Derived value (recomputed on every update).', insert: l.name });
    }
    // inside a context's effect: its own stores and lets
    const own = r?.context && index.contexts?.get(r.context);
    if (own) for (const x of [...own.stores, ...own.lets]) items.push({ label: x.name, kind: 'variable', detail: `${own.stores.includes(x) ? 'store' : 'let'} ${x.name}: ${x.type}`, insert: x.name, sort: '0' });
    for (const en of index.enums.values()) items.push({ label: en.name, kind: 'type', detail: `enum ${en.name}`, doc: en.variants.map((v) => v.name).join(' | '), insert: `${en.name}.`, retrigger: true, sort: '7' });
    for (const c of index.contexts?.values() ?? []) items.push({ label: c.name, kind: 'type', detail: `context ${c.name}`, doc: ctxSummary(c), insert: `${c.name}.`, retrigger: true, sort: '6' });
    for (const p of r?.params ?? []) items.push({ label: p.name, kind: 'variable', detail: `${p.name}: ${p.type}`, insert: p.name, sort: '0' });
    for (const l of localsAt(f, r, offset)) items.push({ label: l, kind: 'variable', detail: 'list item', insert: l, sort: '0' });
    items.push({ label: 't', kind: 'function', detail: 't(key, params)', doc: 'Translated string from the locale catalogs.', insert: 't("${1:key}")' });
    for (const k of ['true', 'false']) items.push({ label: k, kind: 'keyword', insert: k, sort: '9' });
    return items;
  }

  // ---- completions -------------------------------------------------------------------
  function complete(path, offset) {
    const f = fileOf(path);
    if (!f) return null;
    const text = f.text;
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const before = text.slice(lineStart, offset);
    const skip = skipAt(f, offset);
    const word = (re = /[\w$]*$/) => {
      const m = re.exec(before);
      return { from: offset - (m ? m[0].length : 0), to: offset };
    };
    if (skip?.kind === 'comment') return null;
    if (skip?.kind === 'string') {
      if (/^\s*import\s+"[^"]*$/.test(before)) {
        const { from } = word(/[^"]*$/);
        const items = [...index.files.keys()].filter((p) => p !== path).map((p) => ({ label: p.replace(/\.foar$/, ''), kind: 'file', detail: p, insert: p.replace(/\.foar$/, '') }));
        return { from, to: offset, items };
      }
      return null;
    }
    const r = regionAt(f, offset);
    const kind = r?.kind ?? 'top';
    const view = r?.view ? f.views.find((v) => v.name === r.view) : null;
    const state = view?.states.find((s) => s.name === r?.state);
    let m;

    // Library.<store | let | effect>   (only effects in `-> on_x(Library.…)`)
    if ((m = /\b([A-Z]\w*)\.(\w*)$/.exec(before)) && index.contexts?.has(m[1])) {
      return { ...word(), items: ctxMembers(index.contexts.get(m[1]), /->\s*on_\w+\(\s*\w+\.\w*$/.test(before)) };
    }
    // use <Context>;
    if (/^\s*use\s+\w*$/.test(before.slice(before.lastIndexOf('\n') + 1))) {
      return { ...word(), items: [...(index.contexts?.values() ?? [])].map((c) => ({ label: c.name, kind: 'type', detail: `context ${c.name}`, doc: ctxSummary(c), insert: c.name })) };
    }
    // Layout.<variant>
    if ((m = /\b([A-Z]\w*)\.(\w*)$/.exec(before)) && index.enums.has(m[1])) {
      const en = index.enums.get(m[1]);
      return { ...word(), items: en.variants.map((v) => ({ label: v.name, kind: 'value', detail: `${en.name}.${v.name} = ${v.value}`, insert: v.name })) };
    }

    // transition <State>
    if (view && (m = /\btransition\s*\(?\s*(\w*)$/.exec(before))) {
      return { ...word(), items: view.states.map((s) => ({ label: s.name, kind: 'state', detail: `state of ${view.name}`, insert: s.name, sort: s.name === state?.name ? '9' : '0' })) };
    }
    // -> on_x(<Effect>)
    if (view && (kind === 'handler' || /->\s*on_\w+\(\s*\w*$/.test(before))) {
      const items = allEffects(view).map((e) => ({
        label: e.name,
        kind: 'effect',
        detail: `effect ${e.name}(${e.params.map((p) => `${p.name}: ${p.type}`).join(', ')}) · ${e.state}`,
        doc: e.state === state?.name ? '' : `Declared in state ${e.state}: only runs while the view is in that state.`,
        insert: e.name,
        sort: e.state === state?.name ? '0' : '5',
      }));
      return { ...word(), items };
    }
    // -> <event>
    if ((m = /->\s*(\w*)$/.exec(before)) && (kind === 'render' || kind === 'call' || kind === 'styleArgs' || kind === 'style' || kind === 'state')) {
      const tag = ownerTag(f, offset - m[1].length - (m[0].length - m[1].length));
      const v = tag && index.views.get(tag);
      let names;
      if (v) names = [...v.emits].map((e) => [`on_${e}`, `${tag} emits ${e}`]);
      else if (tag && ELEMENTS[tag]) names = ELEMENTS[tag].events.map((e) => [e, EVENTS[e]]);
      else names = Object.entries(EVENTS);
      return { ...word(), items: names.map(([n, d]) => ({ label: n, kind: 'event', detail: tag ? `${tag} event` : 'event', doc: d, insert: `${n}($1)`, retrigger: true })) };
    }
    // @use <Style>  /  .style(<Style>, …)
    if (/@use\s+\w*$/.test(before) || (kind === 'styleArgs' && /(?:\(|,)\s*\w*$/.test(text.slice(r.start - 1, offset).replace(/\{[^{}]*\}/g, '')))) {
      const items = [...index.styles.values()].map((s) => ({ label: s.name, kind: 'style', detail: `style ${s.name} · ${s.path}`, insert: s.name }));
      if (kind === 'styleArgs') items.push({ label: '{ … }', kind: 'snippet', detail: 'inline style', insert: '{ $0 }', filter: '{', sort: '9' });
      return { ...word(), items };
    }
    const inStyle = kind === 'style' || kind === 'keyframes' || kind === 'css';
    if (inStyle) {
      if ((m = /var\(\s*(-{0,2}[\w-]*)$/.exec(before)) || (m = /(?:^|[\s:(,])(--[\w-]*)$/.exec(before))) {
        const declaring = /^\s*--[\w-]*$/.test(before);
        const items = [...index.cssVars.entries()].map(([n, defs]) => ({
          label: n,
          kind: 'cssvar',
          detail: defs.map((d) => `${d.dark ? 'dark: ' : ''}${d.value}`).join('  ·  '),
          insert: declaring ? `${n}: $0;` : n,
        }));
        return { from: offset - m[1].length, to: offset, items };
      }
      if (view && (m = /@state\s+(\w*)$/.exec(before))) return { ...word(), items: view.states.map((s) => ({ label: s.name, kind: 'state', insert: s.name })) };
      if ((m = /(?:^|[;{])\s*(@[\w-]*)$/.exec(before))) {
        const items = Object.entries(STYLE_AT).map(([n, d]) => ({ label: n, kind: 'keyword', doc: d, insert: STYLE_AT_SNIPPETS[n] ?? `${n} { $0 }` }));
        return { from: offset - m[1].length, to: offset, items };
      }
      if ((m = /([\w-]+)\s*:\s*(?:[^;{}]*\s)?([\w#.%-]*)$/.exec(before)) && isCssProp(m[1])) {
        const prop = m[1];
        const items = cssValues(prop).map((v) => ({ label: v, kind: 'value', insert: v }));
        if (/^animation/.test(prop)) for (const k of index.keyframes.keys()) items.push({ label: k, kind: 'value', detail: '@keyframes', insert: `${k} \${1:0.2s} \${2:ease-out}` });
        for (const [n, defs] of index.cssVars) items.push({ label: `var(${n})`, kind: 'cssvar', detail: defs[0].value, insert: `var(${n})`, sort: '5', filter: n });
        return { from: offset - m[2].length, to: offset, items };
      }
      if ((m = /(?:^|[;{])\s*([\w-]*)$/.exec(before))) {
        const items = [
          ...Object.entries(FOAR_PROPS).map(([n, d]) => ({ label: n, kind: 'property', detail: 'FOAR', doc: d.doc, insert: `${n}: $0;`, retrigger: true })),
          ...CSS_PROPS.map((n) => ({ label: n, kind: 'property', insert: `${n}: $0;`, retrigger: cssValues(n).length > 0 })),
        ];
        return { from: offset - m[1].length, to: offset, items };
      }
      return null;
    }
    // types
    if (
      ((kind === 'params' || kind === 'effectParams' || kind === 'data') && /:\s*(?:\w+<)?\w*$/.test(before)) ||
      /\bstore\s+\w+\s*:\s*(?:\w+<)?\w*$/.test(before)
    ) {
      const items = [
        ...Object.entries(TYPES).map(([n, d]) => ({ label: n, kind: 'type', doc: d, insert: n === 'Vec' || n === 'Option' ? `${n}<$1>` : n })),
        ...[...index.datas.values()].map((d) => ({ label: d.name, kind: 'type', detail: `data ${d.name}`, doc: d.fields.map((x) => `${x.name}: ${x.type}`).join(', '), insert: d.name })),
        ...[...index.enums.values()].map((en) => ({ label: en.name, kind: 'type', detail: `enum ${en.name}`, doc: en.variants.map((v) => v.name).join(' | '), insert: en.name })),
      ];
      return { ...word(), items };
    }
    // .method
    if ((m = /\.(\w*)$/.exec(before))) {
      if (kind === 'render' || kind === 'call') return { ...word(), items: [{ label: 'style', kind: 'function', detail: '.style(Name, { … })', doc: 'Apply named styles and/or an inline style block.', insert: 'style($1)', retrigger: true }] };
      if (kind === 'effect') return { ...word(), items: Object.entries(METHODS).map(([n, d]) => ({ label: n, kind: 'function', doc: d, insert: n === 'is_empty' || n === 'len' || n === 'trim' || n === 'to_lowercase' || n === 'to_uppercase' ? `${n}()` : `${n}($1)` })) };
      return null;
    }
    // element call arguments
    if (kind === 'call') {
      const call = callAt(f, offset);
      const atArgStart = /(?:\(|,)\s*\w*$/.test(text.slice(r.start - 1, offset).replace(/"(?:[^"\\]|\\.)*"/g, '""'));
      const items = [];
      if (call && atArgStart) {
        const v = index.views.get(call.callee);
        if (v) for (const p of v.params) items.push({ label: `${p.name}:`, kind: 'arg', detail: p.default != null ? `${p.type} = ${p.default}` : p.type, insert: `${p.name}: $0`, filter: p.name, sort: p.default != null ? '1' : '0' });
        else if (ELEMENTS[call.callee]) for (const n of ELEMENTS[call.callee].named) items.push({ label: `${n}:`, kind: 'arg', doc: argDoc(n), insert: n === 'aria' || n === 'data' ? `${n}: { $1 }` : `${n}: $0`, filter: n, sort: '0' });
      }
      items.push(...expressionItems(f, r, offset, view));
      return { ...word(), items };
    }
    // statements
    const lineWord = /^\s*\w*$/.test(before) || /[{}]\s*\w*$/.test(before);
    if (kind === 'render') {
      const items = [];
      if (lineWord) {
        for (const [n, e] of Object.entries(ELEMENTS)) items.push({ label: n, kind: 'element', detail: e.sig, doc: e.doc, insert: e.snippet });
        for (const v of index.views.values()) {
          if (v.name === view?.name) continue;
          const args = v.params.filter((p) => p.default == null && !/^Option</.test(p.type)).map((p, i) => `${p.name}: \${${i + 1}:${p.name}}`).join(', ');
          items.push({ label: v.name, kind: 'view', detail: viewSig(v), doc: `${v.path}${v.emits.size ? ` · emits ${[...v.emits].join(', ')}` : ''}`, insert: v.params.length ? `${v.name}(${args})` : `${v.name}()` });
        }
      }
      if (!lineWord || /\w$/.test(before)) items.push(...expressionItems(f, r, offset, view).map((x) => ({ ...x, sort: '8' })));
      return { ...word(), items };
    }
    if (kind === 'effect') {
      const items = [...expressionItems(f, r, offset, view)];
      if (lineWord) items.push(...SNIPPETS.effect.map(([n, s, d]) => ({ label: n, kind: 'keyword', detail: d, doc: KEYWORDS[n], insert: s, sort: '1' })));
      return { ...word(), items };
    }
    if (kind === 'state' && lineWord) return { ...word(), items: SNIPPETS.state.map(([n, s, d]) => ({ label: n, kind: 'keyword', detail: d, doc: KEYWORDS[n], insert: s })) };
    if (kind === 'view' && lineWord) return { ...word(), items: SNIPPETS.view.map(([n, s, d]) => ({ label: n, kind: 'keyword', detail: d, doc: KEYWORDS[n], insert: s })) };
    if (kind === 'top' && /^\s*[\w@]*$/.test(before)) {
      return { ...word(/@?[\w$]*$/), items: SNIPPETS.top.map(([n, s, d]) => ({ label: n, kind: 'keyword', detail: d, doc: KEYWORDS[n.split(' ')[0]], insert: s, filter: n.split(' ')[0] })) };
    }
    return null;
  }

  // ---- signature help -------------------------------------------------------------------
  function signature(path, offset) {
    const f = fileOf(path);
    if (!f || skipAt(f, offset)?.kind === 'comment') return null;
    const call = callAt(f, offset);
    if (!call || call.method) return null;
    const v = index.views.get(call.callee);
    if (v) {
      const params = v.params.map((p) => `${p.name}: ${p.type}`);
      const named = (() => {
        const seg = f.text.slice(call.open, offset).split(',').pop();
        const nm = /^\s*(\w+)\s*:/.exec(seg);
        return nm ? v.params.findIndex((p) => p.name === nm[1]) : -1;
      })();
      return { label: v.name, params, active: named >= 0 ? named : Math.min(call.commas, params.length - 1), doc: `${v.path}` };
    }
    const e = ELEMENTS[call.callee];
    if (e) {
      const inner = /\((.*)\)/.exec(e.sig)?.[1] ?? '';
      const params = inner ? inner.split(/,\s*/) : [];
      return { label: call.callee, params, active: Math.min(call.commas, params.length - 1), doc: e.doc };
    }
    // effects called from a handler or helper: show nothing
    return null;
  }

  // ---- hover --------------------------------------------------------------------------------
  function hover(path, offset) {
    const f = fileOf(path);
    if (!f) return null;
    const skip = skipAt(f, offset);
    if (skip?.kind === 'comment') return null;
    if (skip?.kind === 'string') {
      const imp = f.imports.find((i) => i.s <= offset && offset <= i.e);
      if (!imp) return null;
      const target = resolveSpec(path, imp.spec);
      return { code: `import "${imp.spec}"`, doc: target && index.files.has(target) ? `→ ${target}` : `Cannot find ${target ?? imp.spec}`, s: imp.s, e: imp.e };
    }
    const { word, s, e } = wordAt(f.text, offset);
    if (!word) return null;
    const r = regionAt(f, offset);
    const view = viewAt(f, offset);
    const at = (code, doc) => ({ code, doc, s, e });
    if (word.startsWith('@')) return STYLE_AT[word] ? at(word, STYLE_AT[word]) : word === '@keyframes' ? at('@keyframes name { from { … } to { … } }', 'A CSS animation.') : null;
    if (word.startsWith('--')) {
      const defs = index.cssVars.get(word);
      return at(word, defs ? defs.map((d) => `${d.dark ? '🌙 ' : ''}${d.value}   (${d.path}:${lineOf(index.files.get(d.path).text, d.offset)})`).join('\n') : 'Not defined in any theme or style.');
    }
    const owner = /([A-Z]\w*)\.$/.exec(f.text.slice(Math.max(0, s - 40), s))?.[1];
    if (owner && index.enums.has(owner)) {
      const v = index.enums.get(owner).variants.find((x) => x.name === word);
      if (v) return at(`${owner}.${v.name}`, `= ${v.value}`);
    }
    if (owner && index.contexts?.has(owner)) {
      const c = index.contexts.get(owner);
      const e = c.effects.find((x) => x.name === word);
      if (e) return at(`effect ${ctxEffectSig(c, e)}`, `in context ${c.name}\n${c.path}:${lineOf(index.files.get(c.path).text, e.offset)}`);
      const x = c.stores.find((y) => y.name === word) ?? c.lets.find((y) => y.name === word);
      if (x) return at(`${c.stores.includes(x) ? 'store' : 'let'} ${c.name}.${x.name}${x.type !== 'derived' ? `: ${x.type}` : ''}`, `in context ${c.name}`);
    }
    const cx = index.contexts?.get(word);
    if (cx) return at(ctxSummary(cx), `A shared store: views \`use ${cx.name};\` and call it directly.\n${cx.path}:${lineOf(index.files.get(cx.path).text, cx.offset)}`);
    const v = index.views.get(word);
    if (v) {
      const states = v.states.map((st) => st.name).join(' · ');
      return at(viewSig(v), `States: ${states || '—'}${v.emits.size ? `\nEmits: ${[...v.emits].map((x) => `on_${x}`).join(', ')}` : ''}\n${v.path}:${lineOf(index.files.get(v.path).text, v.offset)}`);
    }
    if (ELEMENTS[word]) return at(ELEMENTS[word].sig, `${ELEMENTS[word].doc}${ELEMENTS[word].events.length ? `\nEvents: ${ELEMENTS[word].events.join(', ')}` : ''}`);
    if (EVENTS[word]) return at(word, EVENTS[word]);
    if (word.startsWith('on_') && view) {
      const owner = ownerTag(f, s);
      if (owner && index.views.get(owner)) return at(word, `Emitted by ${owner} (\`emit ${word.slice(3)}(…)\`).`);
    }
    const st = index.styles.get(word);
    if (st) {
      const src = index.files.get(st.path).text.slice(st.start, st.end + 1).split('\n');
      return at(src.slice(0, 8).join('\n') + (src.length > 8 ? '\n    …' : ''), `${st.path}:${lineOf(index.files.get(st.path).text, st.offset)}`);
    }
    const d = index.datas.get(word);
    if (d) return at(`data ${d.name} {\n${d.fields.map((x) => `    ${x.name}: ${x.type},`).join('\n')}\n}`, d.path);
    const en = index.enums.get(word);
    if (en) return at(`enum ${en.name} {\n${en.variants.map((v) => `    ${v.name}${v.value !== JSON.stringify(v.name) ? ` = ${v.value}` : ''},`).join('\n')}\n}`, `${KEYWORDS.enum.split('. ')[0]}.\n${en.path}`);
    if (view) {
      const sd = view.states.find((x) => x.name === word);
      if (sd) return at(`state ${word}`, `of ${view.name}${sd.effects.length ? `\nEffects: ${sd.effects.map((x) => x.name).join(', ')}` : ''}`);
      const ef = allEffects(view).find((x) => x.name === word);
      if (ef) return at(`effect ${ef.name}(${ef.params.map((p) => `${p.name}: ${p.type}`).join(', ')})`, `in state ${ef.state} of ${view.name}`);
      const store = view.stores.find((x) => x.name === word);
      if (store) return at(`store ${store.name}: ${store.type}`, `of ${view.name}`);
      const lt = (view.lets ?? []).find((x) => x.name === word);
      if (lt) return at(`let ${lt.name}`, `derived value of ${view.name}, recomputed on every update`);
      const param = view.params.find((x) => x.name === word);
      if (param) return at(`${param.name}: ${param.type}`, `parameter of ${view.name}`);
      const ep = r?.params?.find((x) => x.name === word);
      if (ep) return at(`${ep.name}: ${ep.type}`, `parameter of effect ${r.effect}`);
    }
    if (KEYWORDS[word]) return at(word, KEYWORDS[word]);
    if (TYPES[word]) return at(word, TYPES[word]);
    if (METHODS[word] && r?.kind === 'effect') return at(`.${word}(…)`, METHODS[word]);
    if ((r?.kind === 'style' || r?.kind === 'css') && isCssProp(word)) {
      const vals = cssValues(word);
      return at(`${word}: …;`, `${FOAR_PROPS[word]?.doc ?? 'CSS property.'}${vals.length ? `\nValues: ${vals.join(' | ')}` : ''}`);
    }
    return null;
  }

  // ---- definition --------------------------------------------------------------------------
  function definition(path, offset) {
    const f = fileOf(path);
    if (!f) return null;
    const imp = f.imports.find((i) => i.s <= offset && offset <= i.e);
    if (imp) {
      const t = resolveSpec(path, imp.spec, index.files);
      return t && index.files.has(t) ? { path: t, offset: 0 } : null;
    }
    if (skipAt(f, offset)) return null;
    const { word } = wordAt(f.text, offset);
    const at = (x) => x && { path: x.path, offset: x.offset };
    if (word.startsWith('--')) return at(index.cssVars.get(word)?.[0]);
    const owner = /([A-Z]\w*)\.$/.exec(f.text.slice(Math.max(0, offset - word.length - 40), wordAt(f.text, offset).s))?.[1];
    if (owner && index.enums.has(owner)) {
      const en = index.enums.get(owner);
      const v = en.variants.find((x) => x.name === word);
      if (v) return { path: en.path, offset: v.offset };
    }
    if (owner && index.contexts?.has(owner)) {
      const c = index.contexts.get(owner);
      const x = c.effects.find((y) => y.name === word) ?? c.stores.find((y) => y.name === word) ?? c.lets.find((y) => y.name === word);
      if (x) return { path: c.path, offset: x.offset };
    }
    const g = index.views.get(word) ?? index.contexts?.get(word) ?? index.styles.get(word) ?? index.datas.get(word) ?? index.enums.get(word) ?? index.keyframes.get(word);
    if (g) return at(g);
    const view = viewAt(f, offset);
    if (view) {
      const x = view.states.find((s) => s.name === word) ?? allEffects(view).find((s) => s.name === word) ?? view.stores.find((s) => s.name === word) ?? (view.lets ?? []).find((s) => s.name === word) ?? view.params.find((s) => s.name === word);
      if (x) return { path, offset: x.offset };
    }
    return null;
  }

  // ---- references / rename ------------------------------------------------------------------
  /** What the identifier at `offset` is: { name, kind, scope: 'project' | { path, s, e }, view? } */
  function symbolAt(path, offset) {
    const f = fileOf(path);
    if (!f || skipAt(f, offset)) return null;
    const { word, s, e } = wordAt(f.text, offset);
    if (!word || KEYWORDS[word] || ELEMENTS[word] || TYPES[word]) return null;
    if (word.startsWith('--')) return index.cssVars.has(word) ? { name: word, kind: 'cssvar', scope: 'project', s, e } : null;
    if (index.views.has(word)) return { name: word, kind: 'view', scope: 'project', s, e };
    if (index.styles.has(word)) return { name: word, kind: 'style', scope: 'project', s, e };
    if (index.datas.has(word)) return { name: word, kind: 'data', scope: 'project', s, e };
    if (index.enums.has(word)) return { name: word, kind: 'enum', scope: 'project', s, e };
    if (index.contexts?.has(word)) return { name: word, kind: 'context', scope: 'project', s, e };
    const view = viewAt(f, offset);
    if (!view) return null;
    const scope = { path, s: view.start, e: view.end };
    if (view.states.some((x) => x.name === word)) return { name: word, kind: 'state', scope, view, s, e };
    if (allEffects(view).some((x) => x.name === word)) return { name: word, kind: 'effect', scope, view, s, e };
    if (view.stores.some((x) => x.name === word)) return { name: word, kind: 'store', scope, view, s, e };
    if ((view.lets ?? []).some((x) => x.name === word)) return { name: word, kind: 'let', scope, view, s, e };
    if (view.params.some((x) => x.name === word)) return { name: word, kind: 'param', scope, view, s, e };
    return null;
  }

  function occurrences(sym) {
    const out = [];
    const want = sym.kind === 'cssvar' ? 'cssvar' : 'id';
    for (const f of index.files.values()) {
      if (sym.scope !== 'project' && sym.scope.path !== f.path && sym.kind !== 'param') continue;
      f.toks.forEach((t, i) => {
        if (t.k !== want || t.v !== sym.name) return;
        if (sym.scope !== 'project') {
          const inScope = f.path === sym.scope.path && t.s >= sym.scope.s && t.e <= sym.scope.e;
          // a view parameter is also named at call sites: Row(name: …)
          const atCall = sym.kind === 'param' && f.toks[i + 1]?.v === ':' && f.regions.some((r) => r.kind === 'call' && r.tag === sym.view.name && r.start <= t.s && t.e <= r.end);
          if (!inScope && !atCall) return;
          if (inScope && f.toks[i - 1]?.v === '.') return; // obj.name is a field, not this symbol
        }
        out.push({ path: f.path, s: t.s, e: t.e, line: lineOf(f.text, t.s), text: f.text.slice(f.text.lastIndexOf('\n', t.s - 1) + 1, f.text.indexOf('\n', t.s) < 0 ? undefined : f.text.indexOf('\n', t.s)).trim() });
      });
    }
    return out;
  }

  function references(path, offset) {
    const sym = symbolAt(path, offset);
    return sym ? { sym, refs: occurrences(sym) } : null;
  }

  /** New file texts for renaming the symbol at `offset`, or { error }. */
  function rename(path, offset, newName) {
    const sym = symbolAt(path, offset);
    if (!sym) return { error: 'Nothing to rename here' };
    const valid = sym.kind === 'cssvar' ? /^--[\w-]+$/ : /^[A-Za-z_]\w*$/;
    if (!valid.test(newName)) return { error: `'${newName}' is not a valid name` };
    if (KEYWORDS[newName] || ELEMENTS[newName]) return { error: `'${newName}' is reserved` };
    if (['view', 'style', 'data', 'enum'].includes(sym.kind) && (index.views.has(newName) || index.styles.has(newName) || index.datas.has(newName) || index.enums.has(newName))) return { error: `'${newName}' already exists` };
    if (sym.view && (sym.view.states.some((x) => x.name === newName) || allEffects(sym.view).some((x) => x.name === newName) || sym.view.stores.some((x) => x.name === newName) || sym.view.params.some((x) => x.name === newName))) return { error: `'${newName}' is already used in ${sym.view.name}` };
    const occ = occurrences(sym);
    const edits = {};
    for (const o of [...occ].sort((a, b) => b.s - a.s)) {
      const text = edits[o.path] ?? index.files.get(o.path).text;
      edits[o.path] = text.slice(0, o.s) + newName + text.slice(o.e);
    }
    return { sym, count: occ.length, edits };
  }

  // ---- diagnostics -----------------------------------------------------------------------------
  function diagnostics() {
    const out = new Map();
    const push = (path, s, e, severity, message) => {
      if (!out.has(path)) out.set(path, []);
      out.get(path).push({ s, e, severity, message });
    };
    for (const f of index.files.values()) {
      const local = (name) => f.views.find((v) => v.name === name);
      for (const t of f.refs.transitions) {
        const v = local(t.view);
        if (v && !v.states.some((s) => s.name === t.name)) push(f.path, t.s, t.e, 'error', `${v.name} has no state '${t.name}'.${didYouMean(t.name, v.states.map((s) => s.name))}`);
      }
      for (const st of f.refs.stateStyles) {
        const v = local(st.view);
        if (v && !v.states.some((s) => s.name === st.name)) push(f.path, st.s, st.e, 'warning', `${v.name} has no state '${st.name}'.${didYouMean(st.name, v.states.map((s) => s.name))}`);
      }
      for (const h of f.refs.handlers) {
        const v = local(h.view);
        if (!v) continue;
        const effs = allEffects(v);
        const here = v.states.find((s) => s.name === h.state)?.effects.some((x) => x.name === h.name);
        if (here) continue;
        const elsewhere = effs.find((x) => x.name === h.name);
        if (elsewhere) push(f.path, h.s, h.e, 'warning', `'${h.name}' is an effect of state ${elsewhere.state}, not ${h.state}: it won't run from here.`);
        else push(f.path, h.s, h.e, 'error', `${v.name} has no effect '${h.name}'.${didYouMean(h.name, effs.map((x) => x.name))}`);
      }
      for (const u of f.refs.styleUses) {
        if (!index.styles.has(u.name)) push(f.path, u.s, u.e, 'error', `Unknown style '${u.name}'.${didYouMean(u.name, [...index.styles.keys()])}`);
      }
      for (const u of f.refs.varUses) {
        if (!index.cssVars.has(u.name) && !u.name.startsWith('--f4-')) push(f.path, u.s, u.e, 'warning', `${u.name} isn't defined in any theme or style.${didYouMean(u.name, [...index.cssVars.keys()])}`);
      }
      for (const ev of f.refs.events) {
        if (!ev.tag) continue;
        const v = index.views.get(ev.tag);
        if (v) {
          if (!ev.name.startsWith('on_') || !v.emits.has(ev.name.slice(3))) push(f.path, ev.s, ev.e, 'warning', `${v.name} never emits '${ev.name.replace(/^on_/, '')}'.${v.emits.size ? ` It emits: ${[...v.emits].join(', ')}.` : ''}`);
        } else if (ELEMENTS[ev.tag] && !ELEMENTS[ev.tag].events.includes(ev.name) && ev.tag !== 'List') {
          push(f.path, ev.s, ev.e, 'warning', `${ev.tag} doesn't fire ${ev.name}.${ELEMENTS[ev.tag].events.length ? ` It fires: ${ELEMENTS[ev.tag].events.join(', ')}.` : ''}`);
        }
      }
      f.toks.forEach((t, i) => {
        if (t.k !== 'id' || !index.enums.has(t.v) || f.toks[i + 1]?.v !== '.' || f.toks[i + 2]?.k !== 'id' || f.toks[i - 1]?.v === '.') return;
        const en = index.enums.get(t.v);
        const v = f.toks[i + 2];
        if (!en.variants.some((x) => x.name === v.v)) push(f.path, v.s, v.e, 'error', `${en.name} has no variant '${v.v}'.${didYouMean(v.v, en.variants.map((x) => x.name))} Variants: ${en.variants.map((x) => x.name).join(', ')}.`);
      });
      for (const imp of f.imports) {
        const t = resolveSpec(f.path, imp.spec, index.files);
        if (t && !index.files.has(t)) push(f.path, imp.s, imp.e, 'error', `Cannot find ${t}.`);
      }
    }
    return out;
  }

  return {
    update(files) {
      index = analyzeProject(files, index);
    },
    get index() {
      return index;
    },
    complete,
    signature,
    hover,
    definition,
    references,
    rename,
    symbolAt,
    diagnostics,
  };
}

// same rules as src/project.rs (including @package imports via foar.toml)
export function resolveSpec(from, spec, files = null) {
  if (!spec || spec.startsWith('/') || spec.includes('://')) return null;
  if (spec.startsWith('@')) {
    const body = spec.slice(1);
    const slash = body.indexOf('/');
    const pkg = slash >= 0 ? body.slice(0, slash) : body;
    const sub = slash >= 0 ? body.slice(slash + 1) : '';
    const bases = [];
    const manifest = files?.get?.('foar.toml')?.text;
    if (manifest) {
      const m = new RegExp(`^\\s*${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(?:\\{[^}]*path\\s*=\\s*"([^"]+)"|"([^"]+)")`, 'm').exec(manifest);
      const p = (m?.[1] || m?.[2] || '').replace(/^\.\//, '').replace(/\/$/, '');
      if (p) bases.push(p);
    }
    bases.push(`foar_packages/${pkg}`, `packages/${pkg}`);
    const cands = [];
    for (const base of bases) {
      const pre = base ? `${base}/` : '';
      if (sub) {
        const file = sub.endsWith('.foar') ? sub : `${sub}.foar`;
        cands.push(`${pre}${file}`, `${pre}src/${file}`);
      } else {
        cands.push(`${pre}index.foar`, `${pre}lib.foar`, `${pre}src/index.foar`, `${pre}src/lib.foar`, `${pre}app.foar`);
      }
    }
    if (files) {
      for (const c of cands) if (files.has(c)) return c;
    }
    return cands[0] ?? null;
  }
  const parts = [];
  if (spec.startsWith('./') || spec.startsWith('../')) {
    parts.push(...from.split('/'));
    parts.pop();
  }
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  const p = parts.join('/');
  return p.endsWith('.foar') ? p : `${p}.foar`;
}

// ---- formatting ---------------------------------------------------------------------------------
/**
 * Re-indents with 4 spaces by bracket nesting. A line's contents sit one level
 * inside the line that opened their bracket; closers line up with that line;
 * `.style(…)` / `-> on_x(…)` continuation lines get one extra level. Trailing
 * whitespace goes, runs of blank lines collapse to one, block comments and
 * strings are left alone.
 */
export function formatFoar(text) {
  const { toks, skips } = tokenize(text);
  const lines = text.split('\n');
  const starts = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  // lines that begin inside a block comment are kept verbatim
  const keep = new Set();
  for (const sk of skips) {
    if (sk.kind !== 'comment' || !text.startsWith('/*', sk.s)) continue;
    for (let i = 0; i < lines.length; i++) if (starts[i] > sk.s && starts[i] < sk.e) keep.add(i);
  }
  const byLine = lines.map(() => []);
  let li = 0;
  for (const t of toks) {
    while (li + 1 < lines.length && starts[li + 1] <= t.s) li++;
    if (t.k === 'p' && '(){}[]'.includes(t.v)) byLine[li].push(t.v);
    else byLine[li].push(t.k === 'p' && t.v === '.' ? '.' : t.v === '->' ? '->' : 'x');
  }
  const stack = []; // { line, count, indent }
  const out = [];
  let blank = 0;
  lines.forEach((raw, i) => {
    if (keep.has(i)) {
      out.push(raw);
      return;
    }
    const content = raw.trim();
    if (!content) {
      blank++;
      if (blank <= 1 && out.length) out.push('');
      return;
    }
    blank = 0;
    const ts = byLine[i];
    let k = 0;
    let level = null;
    // leading closers
    while (k < ts.length && (ts[k] === ')' || ts[k] === '}' || ts[k] === ']')) {
      const top = stack[stack.length - 1];
      if (top) {
        if (level === null) level = top.indent;
        top.count--;
        if (top.count <= 0) stack.pop();
      }
      k++;
    }
    if (level === null) {
      const top = stack[stack.length - 1];
      level = top ? top.indent + 1 : 0;
      // continuation lines (and comments just above one) sit one level deeper
      // (".name(" or "->" — not a CSS selector like ".row {")
      let next = ts.length ? i : -1;
      if (!ts.length) for (let j = i + 1; j < lines.length; j++) if (byLine[j].length) { next = j; break; }
      if (next >= 0 && /^(?:\.[A-Za-z_]\w*\s*\(|->)/.test(lines[next].trim())) level++;
    }
    // brackets opened after this line closed an earlier one belong to that
    // statement: `List(a,\n  b) { item =>` indents from the List line
    let base = level;
    for (; k < ts.length; k++) {
      const t = ts[k];
      if (t === '(' || t === '{' || t === '[') {
        const top = stack[stack.length - 1];
        if (top && top.line === i) top.count++;
        else stack.push({ line: i, count: 1, indent: base });
      } else if (t === ')' || t === '}' || t === ']') {
        const top = stack[stack.length - 1];
        if (top) {
          top.count--;
          if (top.count <= 0) {
            stack.pop();
            if (top.line !== i) base = top.indent;
          }
        }
      }
    }
    out.push('    '.repeat(Math.max(0, level)) + content);
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n')}\n`;
}
