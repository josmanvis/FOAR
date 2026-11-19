// Export a note as Markdown or HTML, and print it.

const PRINT_CSS = `
  body { font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif; color: #1d1d1f; max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1 { font-size: 26px; margin: 0 0 8px; } h2 { font-size: 20px; margin: 18px 0 4px; } h3 { font-size: 16px; margin: 14px 0 2px; }
  p, div { margin: 0; } ul, ol { padding-left: 26px; }
  ul.dashed { list-style: none; } ul.dashed > li::before { content: "– "; margin-left: -16px; }
  ul.checklist { list-style: none; padding-left: 26px; }
  ul.checklist > li::before { content: "○"; display: inline-block; width: 22px; margin-left: -22px; }
  ul.checklist > li[data-checked]::before { content: "◉"; color: #e0a100; }
  ul.checklist > li[data-checked] { color: #86868b; }
  blockquote { margin: 8px 0; padding-left: 14px; border-left: 3px solid #e0a100; color: #555; }
  pre { font: 13px/1.5 ui-monospace, Menlo, monospace; background: #f4f4f4; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; }
  img { max-width: 100%; border-radius: 8px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; }
  a { color: #0a66d6; }
`;

const safeName = (title) => (title || 'Note').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80).trim() || 'Note';
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function htmlDocument(note) {
  return `<!doctype html>
<html lang="${document.documentElement.lang || 'en'}"><head><meta charset="utf-8"><title>${esc(note.title || 'Note')}</title>
<style>${PRINT_CSS}</style></head>
<body>${note.html}</body></html>`;
}

// ---- HTML -> Markdown -----------------------------------------------------------
function inline(node) {
  let out = '';
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      out += n.textContent.replace(/ /g, ' ');
      continue;
    }
    if (n.nodeType !== 1) continue;
    const t = n.tagName;
    const inner = inline(n);
    if (t === 'B' || t === 'STRONG') out += inner.trim() ? `**${inner}**` : inner;
    else if (t === 'I' || t === 'EM') out += inner.trim() ? `*${inner}*` : inner;
    else if (t === 'S' || t === 'STRIKE') out += `~~${inner}~~`;
    else if (t === 'U') out += `<u>${inner}</u>`;
    else if (t === 'CODE') out += `\`${inner}\``;
    else if (t === 'A') out += `[${inner}](${n.getAttribute('href')})`;
    else if (t === 'IMG') out += `![](${n.getAttribute('src')})`;
    else if (t === 'BR') out += '\n';
    else if (t === 'SPAN' && n.style.backgroundColor) out += `==${inner}==`;
    else out += inner;
  }
  return out;
}

function block(node, depth = 0) {
  const lines = [];
  for (const n of node.childNodes) {
    if (n.nodeType === 3) {
      if (n.textContent.trim()) lines.push(n.textContent.trim());
      continue;
    }
    if (n.nodeType !== 1) continue;
    const t = n.tagName;
    if (t === 'H1') lines.push(`# ${inline(n).trim()}`, '');
    else if (t === 'H2') lines.push('', `## ${inline(n).trim()}`, '');
    else if (t === 'H3') lines.push('', `### ${inline(n).trim()}`, '');
    else if (t === 'UL' || t === 'OL') {
      let i = 1;
      for (const li of n.children) {
        const pad = '  '.repeat(depth);
        const marker =
          t === 'OL' ? `${i++}.` : n.classList.contains('checklist') ? (li.hasAttribute('data-checked') ? '- [x]' : '- [ ]') : '-';
        const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(UL|OL)$/.test(c.tagName)));
        const holder = document.createElement('div');
        holder.append(...own.map((c) => c.cloneNode(true)));
        lines.push(`${pad}${marker} ${inline(holder).trim()}`);
        for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) {
          const wrap = document.createElement('div');
          wrap.append(sub.cloneNode(true));
          lines.push(...block(wrap, depth + 1));
        }
      }
      if (!depth) lines.push('');
    } else if (t === 'BLOCKQUOTE') lines.push(...block(n).map((l) => `> ${l}`), '');
    else if (t === 'PRE') lines.push('```', n.textContent.replace(/\n$/, ''), '```', '');
    else if (t === 'TABLE') {
      const rows = [...n.querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|')));
      if (rows.length) {
        lines.push(`| ${rows[0].join(' | ')} |`, `| ${rows[0].map(() => '---').join(' | ')} |`);
        for (const r of rows.slice(1)) lines.push(`| ${r.join(' | ')} |`);
        lines.push('');
      }
    } else if (t === 'IMG') lines.push(`![](${n.getAttribute('src')})`, '');
    else {
      const text = inline(n);
      lines.push(text.trim() ? text.replace(/\s+$/, '') : '');
    }
  }
  return lines;
}

export function toMarkdown(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  const holder = document.createElement('div');
  holder.append(t.content);
  return `${block(holder).join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function exportNote(note, format) {
  if (format === 'md') download(`${safeName(note.title)}.md`, toMarkdown(note.html), 'text/markdown');
  else download(`${safeName(note.title)}.html`, htmlDocument(note), 'text/html');
}

export function printNote(note) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  frame.srcdoc = htmlDocument(note);
  frame.onload = () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };
}

/** `note_command(kind, note)` from app.foar */
export function noteCommand(kind, note) {
  if (!note) return;
  if (kind === 'export_md') exportNote(note, 'md');
  else if (kind === 'export_html') exportNote(note, 'html');
  else if (kind === 'print') printNote(note);
}
