// FOAR website: theme toggle, the hero panel (a real FOAR component), the
// match demo, copy buttons, and the docs table of contents.

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const isDark = () => {
    const explicit = document.documentElement.dataset.theme;
    if (explicit) return explicit === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const render = () => {
    const dark = isDark();
    btn.innerHTML = dark ? SUN_ICON : MOON_ICON;
    btn.setAttribute('aria-label', dark ? 'Use the light theme' : 'Use the dark theme');
    btn.title = btn.getAttribute('aria-label');
  };
  render();
  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('foar-theme', next);
    } catch {
      // storage may be unavailable
    }
    render();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) render();
  });
}

// ---- hero: hero/note.foar, compiled at build time, mounted with the runtime ----
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** Note.foar split into chunks: the view's shell, and one block per state. */
function stateChunks(source) {
  const body = source.replace(/^(?:\/\/[^\n]*\n)+\n?/, '').trimEnd();
  const out = [];
  let cur = { state: null, lines: [] };
  for (const line of body.split('\n')) {
    const m = /^ {4}state (\w+) \{/.exec(line);
    if (m) {
      if (cur.lines.length) out.push(cur);
      cur = { state: m[1], lines: [line] };
      continue;
    }
    cur.lines.push(line);
    if (cur.state && line === '    }') {
      out.push(cur);
      cur = { state: null, lines: [] };
    }
  }
  if (cur.lines.length) out.push(cur);
  return out;
}

async function initHero() {
  const mount = document.getElementById('hero-mount');
  if (!mount) return;
  const panel = document.getElementById('hero-panel');
  const status = document.getElementById('hero-status');
  const sourceEl = document.getElementById('hero-source');
  let program;
  let source;
  let runtime;
  let highlight;
  try {
    [runtime, highlight, program, source] = await Promise.all([
      import('./foar-runtime.js'),
      import('./playground/language/highlight.js'),
      fetch('hero/note.json').then((r) => r.json()),
      fetch('hero/note.foar').then((r) => r.text()),
    ]);
  } catch {
    status.textContent = 'The live component could not load. The playground has the same example.';
    return;
  }

  sourceEl.innerHTML = stateChunks(source)
    .map((c) => {
      const html = highlight.highlightFoar(c.lines.join('\n'));
      return c.state ? `<span class="block" data-state="${c.state}">${html}\n</span>` : `<span class="shell">${html}\n</span>`;
    })
    .join('')
    .replace(/\n<\/span>$/, '</span>');

  let lastEffect = null;
  const show = (state, route) => {
    for (const el of panel.querySelectorAll('[data-station]')) el.classList.toggle('is-on', el.dataset.station === state);
    for (const el of panel.querySelectorAll('[data-route]')) el.classList.toggle('is-set', el.dataset.route === route);
    for (const el of sourceEl.querySelectorAll('.block')) el.classList.toggle('is-on', el.dataset.state === state);
  };
  show('Viewing', null);

  runtime.createFoarRuntime(program, mount, {
    bindings: { save_note: () => new Promise((resolve) => setTimeout(resolve, 1300)) },
    onEffect: ({ effect }) => {
      lastEffect = effect;
    },
    onTransition: ({ from, to }) => {
      show(to, `${from}>${to}`);
      const how = from === 'Saving' ? 'save_note finished, and on_exit' : lastEffect ? `${lastEffect}()` : 'A transition';
      status.innerHTML = `${esc(how)} moved it from <strong>${esc(from)}</strong> to <strong>${esc(to)}</strong>.`;
      lastEffect = null;
    },
  });
}

// ---- the match demo -------------------------------------------------------------
function initMatchDemo() {
  const btn = document.getElementById('match-fix-toggle');
  const codeEl = document.getElementById('match-code');
  const term = document.getElementById('match-terminal');
  if (!btn || !codeEl || !term) return;
  const BROKEN = `enum Payment { Card, Transfer, Invoice }

let fee = match method {
    Payment.Card => 0.29,
    Payment.Transfer => 0,
};`;
  const FIXED = `enum Payment { Card, Transfer, Invoice }

let fee = match method {
    Payment.Card => 0.29,
    Payment.Transfer => 0,
    Payment.Invoice => 1.5,
};`;
  let fixed = false;
  btn.addEventListener('click', async () => {
    fixed = !fixed;
    const { highlightFoar } = await import('./playground/language/highlight.js');
    codeEl.innerHTML = highlightFoar(fixed ? FIXED : BROKEN);
    btn.textContent = fixed ? 'Remove the Invoice arm' : 'Add the Invoice arm';
    btn.setAttribute('aria-pressed', String(fixed));
    term.classList.toggle('is-ok', fixed);
    term.innerHTML = fixed
      ? `<span class="dim">$ foar check checkout.foar</span>\n<span class="ok">✓ checkout.foar compiles: every Payment is handled</span>`
      : `<span class="dim">$ foar check checkout.foar</span>\n<span class="err">checkout.foar:3:11: This match doesn't handle Payment.Invoice\n(add an arm for it or \`_ => …\`)</span>`;
  });
}

// ---- copy buttons ---------------------------------------------------------------
function initCopyButtons() {
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-copy');
      const src = id ? document.getElementById(id) : btn.closest('.cmd-box, .code-block-wrap')?.querySelector('pre');
      if (!src) return;
      try {
        await navigator.clipboard.writeText(src.textContent.trim());
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1400);
      } catch {
        // clipboard may be denied
      }
    });
  }
}

// ---- docs: highlight the section being read --------------------------------------
function initDocsToc() {
  const links = [...document.querySelectorAll('.docs-toc a[href^="#"]')];
  if (!links.length) return;
  const map = new Map();
  for (const link of links) {
    const heading = document.getElementById(link.getAttribute('href').slice(1));
    if (heading) map.set(heading, link);
  }
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const current = map.get(visible[0].target);
      for (const link of links) link.classList.toggle('is-current', link === current);
    },
    { rootMargin: '-84px 0px -65% 0px', threshold: 0 },
  );
  for (const heading of map.keys()) observer.observe(heading);
}

// the landing page's static code samples
async function highlightSamples() {
  const samples = document.querySelectorAll('code.foar');
  if (!samples.length) return;
  const { highlightFoar } = await import('./playground/language/highlight.js');
  for (const el of samples) el.innerHTML = highlightFoar(el.textContent);
}

initThemeToggle();
highlightSamples();
initHero();
initMatchDemo();
initCopyButtons();
initDocsToc();
