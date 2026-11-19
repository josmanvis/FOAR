// Syntax highlighting for .foar sources: one pass over the text, HTML out.
// Used by the playground editor (a highlighted <pre> under a transparent
// <textarea>), so it must be fast on every keystroke: ~1ms for 1,000 lines.

const KEYWORDS = new Set([
  'view', 'state', 'store', 'effect', 'render', 'transition', 'emit', 'data', 'theme', 'style', 'css',
  'import', 'if', 'else', 'for', 'in', 'let', 'const', 'return', 'on_exit', 'async', 'await', 'match',
  'while', 'break', 'continue', 'fn', 'mut', 'new', 'typeof', 'of', 'enum', 'loop',
]);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'None', 'Some']);
const TYPES = new Set(['String', 'bool', 'i32', 'i64', 'u32', 'u64', 'f32', 'f64', 'Vec', 'any', 'Option']);

// Order matters: the first alternative that matches at a position wins.
const TOKEN = new RegExp(
  [
    String.raw`(?<comment>//[^\n]*|/\*[\s\S]*?(?:\*/|$))`,
    String.raw`(?<string>"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|\x60(?:[^\x60\\]|\\.)*\x60?)`,
    String.raw`(?<cssvar>--[A-Za-z0-9_-]+)`,
    String.raw`(?<at>@[A-Za-z][\w-]*)`,
    String.raw`(?<color>#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b)`,
    String.raw`(?<number>\b\d[\d_.]*(?:e[+-]?\d+)?(?:px|em|rem|%|vh|vw|ms|s|deg|fr|ch|ex|dvh|svh)?)`,
    String.raw`(?<prop>[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?=\s*:(?!:)))`,
    String.raw`(?<ident>[A-Za-z_$][\w$]*)`,
    String.raw`(?<arrow>->|=>)`,
    String.raw`(?<punct>[{}()[\];,.:?=!<>+\-*/%&|^~])`,
  ].join('|'),
  'gy'
);

const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
const span = (cls, text) => `<span class="hl-${cls}">${esc(text)}</span>`;

// "Hello {name}!" -> string parts plus highlighted interpolations.
function stringHtml(text) {
  if (text[0] !== '"' || !text.includes('{')) return span('string', text);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(/\{[^{}"\n]*\}/g)) {
    out += span('string', text.slice(last, m.index));
    out += `<span class="hl-interp">${esc('{')}${highlightFoar(m[0].slice(1, -1))}${esc('}')}</span>`;
    last = m.index + m[0].length;
  }
  return out + span('string', text.slice(last));
}

function identClass(word, src, end, prevWord) {
  if (KEYWORDS.has(word)) return 'keyword';
  if (LITERALS.has(word)) return 'literal';
  if (TYPES.has(word)) return 'type';
  // the name being declared: view X / state X / effect X / data X / style X
  if (prevWord === 'view' || prevWord === 'data' || prevWord === 'style') return 'decl';
  if (prevWord === 'state' || prevWord === 'transition') return 'state';
  if (prevWord === 'effect') return 'fn';
  if (word.startsWith('on_')) return 'event';
  const rest = src.slice(end, end + 40);
  if (/^[A-Z]/.test(word)) return 'component';
  if (/^\s*\(/.test(rest)) return 'fn';
  if (/^\s*:(?!:)/.test(rest)) return 'prop';
  return null;
}

/** .foar source -> HTML (spans with `hl-*` classes; whitespace kept as is). */
export function highlightFoar(src) {
  let out = '';
  let pos = 0;
  let prevWord = '';
  TOKEN.lastIndex = 0;
  while (pos < src.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (!m) {
      // whitespace or a character no rule covers: copy up to the next token start
      let next = pos + 1;
      while (next < src.length && /\s/.test(src[next]) && /\s/.test(src[pos])) next++;
      out += esc(src.slice(pos, next));
      pos = next;
      continue;
    }
    const text = m[0];
    const g = m.groups;
    if (g.comment) out += span('comment', text);
    else if (g.string) out += stringHtml(text);
    else if (g.cssvar) out += span('cssvar', text);
    else if (g.at) out += span('at', text);
    else if (g.color) out += `<span class="hl-color" style="--swatch:${text}">${esc(text)}</span>`;
    else if (g.number) out += span('number', text);
    else if (g.prop) out += span('prop', text);
    else if (g.ident) {
      const cls = identClass(text, src, pos + text.length, prevWord);
      out += cls ? span(cls, text) : esc(text);
      prevWord = text;
    } else if (g.arrow) out += span('arrow', text);
    else out += span('punct', text);
    if (!g.ident && !/^\s*$/.test(text)) prevWord = g.punct || g.arrow ? '' : prevWord;
    pos += text.length;
  }
  return out;
}
