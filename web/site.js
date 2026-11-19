// FOAR website interactions: theme toggle, live Note.foar hero state machine,
// exhaustive match check toggle, clipboard copy buttons, and docs TOC tracking.

const SUN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>`;

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
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  };

  render();

  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('foar-theme', next);
    } catch {
      // ignore storage restrictions
    }
    render();
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) render();
  });
}

function initHeroMachine() {
  const root = document.getElementById('hero-machine');
  if (!root) return;

  const stage = root.querySelector('[data-stage]');
  const trace = root.querySelector('[data-trace]');
  const tabs = Array.from(root.querySelectorAll('[data-state-tab]'));
  const blocks = Array.from(root.querySelectorAll('[data-state-block]'));
  const diagramNodes = Array.from(document.querySelectorAll('[data-diagram-node]'));

  let state = 'Viewing';
  let noteText = 'Explicit states, not flags.';
  let draftText = noteText;
  let saveTimer = null;

  function setActiveIndicators(nextState) {
    for (const tab of tabs) {
      tab.setAttribute('aria-selected', String(tab.dataset.stateTab === nextState));
    }
    for (const block of blocks) {
      block.classList.toggle('is-active', block.dataset.stateBlock === nextState);
    }
    for (const node of diagramNodes) {
      node.classList.toggle('is-on', node.dataset.diagramNode === nextState);
    }
  }

  function transition(nextState, eventLabel) {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const prev = state;
    state = nextState;
    setActiveIndicators(state);

    if (trace) {
      trace.textContent = eventLabel ? `${prev} -> ${eventLabel} -> ${state}` : `state: ${state}`;
    }

    renderStage();

    if (state === 'Saving') {
      saveTimer = setTimeout(() => {
        noteText = draftText.trim() || noteText;
        transition('Viewing', 'on_exit');
      }, 950);
    }
  }

  function renderStage() {
    if (!stage) return;
    stage.innerHTML = '';

    const content = document.createElement('div');
    content.className = 'stage-content';

    const actions = document.createElement('div');
    actions.className = 'stage-actions';

    if (state === 'Viewing') {
      const p = document.createElement('span');
      p.className = 'stage-text';
      p.textContent = noteText;
      content.appendChild(p);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'stage-btn is-action';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        draftText = noteText;
        transition('Editing', 'Edit()');
        const input = stage.querySelector('input');
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
      actions.appendChild(editBtn);
    } else if (state === 'Editing') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'stage-input';
      input.value = draftText;
      input.setAttribute('aria-label', 'Note text');
      input.addEventListener('input', (e) => {
        draftText = e.target.value;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') transition('Saving', 'Save()');
        if (e.key === 'Escape') transition('Viewing', 'Cancel()');
      });
      content.appendChild(input);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'stage-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => transition('Viewing', 'Cancel()'));

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'stage-btn is-action';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => transition('Saving', 'Save()'));

      actions.append(cancelBtn, saveBtn);
    } else {
      const saving = document.createElement('span');
      saving.className = 'stage-saving';
      const spinner = document.createElement('span');
      spinner.className = 'stage-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = 'Saving…';
      saving.append(spinner, label);
      content.appendChild(saving);

      const hint = document.createElement('span');
      hint.className = 'stage-note';
      hint.textContent = 'No Edit or Save handler exists in Saving';
      actions.appendChild(hint);
    }

    stage.append(content, actions);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.stateTab;
      if (target && target !== state) {
        if (target === 'Editing') draftText = noteText;
        transition(target, 'inspect');
      }
    });
  }

  setActiveIndicators(state);
  renderStage();
}

function initMatchDemo() {
  const toggleBtn = document.getElementById('match-fix-toggle');
  const codeEl = document.getElementById('match-code');
  const termEl = document.getElementById('match-terminal');
  if (!toggleBtn || !codeEl || !termEl) return;

  const BROKEN_SRC = `enum Payment { Card, Transfer, Invoice }

let fee = match method {
    Payment.Card => 0.29,
    Payment.Transfer => 0,
};

Match(cart.len()) {
    0 => Text("Your cart is empty"),
    1..=9 => CartList(items: cart),
    n => Text("{n} items, showing the first 9"),
}`;

  const FIXED_SRC = `enum Payment { Card, Transfer, Invoice }

let fee = match method {
    Payment.Card => 0.29,
    Payment.Transfer => 0,
    Payment.Invoice => 1.50,
};

Match(cart.len()) {
    0 => Text("Your cart is empty"),
    1..=9 => CartList(items: cart),
    n => Text("{n} items, showing the first 9"),
}`;

  let fixed = false;

  toggleBtn.addEventListener('click', async () => {
    fixed = !fixed;
    const { highlightFoar } = await import('./playground/language/highlight.js');
    codeEl.innerHTML = highlightFoar(fixed ? FIXED_SRC : BROKEN_SRC);
    toggleBtn.textContent = fixed ? 'Remove Invoice arm' : 'Add Invoice arm';

    if (fixed) {
      termEl.innerHTML = `<span class="dim">$</span> foar check checkout.foar\n<span class="ok">checkout.foar: 0 errors — all 3 Payment variants handled</span>`;
    } else {
      termEl.innerHTML = `<span class="dim">$</span> foar check checkout.foar\n<span class="err">checkout.foar:3:11: This match doesn't handle Payment.Invoice\n(add an arm for it or \`_ => …\`)</span>`;
    }
  });
}

function initCopyButtons() {
  for (const btn of document.querySelectorAll('[data-copy]')) {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-copy');
      const source = targetId
        ? document.getElementById(targetId)
        : btn.closest('.cmd-box, .code-block-wrap')?.querySelector('pre');
      if (!source) return;
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = prev;
        }, 1400);
      } catch {
        // ignore clipboard denial
      }
    });
  }
}

function initDocsToc() {
  const tocLinks = Array.from(document.querySelectorAll('.docs-toc a[href^="#"]'));
  if (!tocLinks.length) return;

  const map = new Map();
  for (const link of tocLinks) {
    const id = link.getAttribute('href').slice(1);
    const heading = document.getElementById(id);
    if (heading) map.set(heading, link);
  }
  if (!map.size) return;

  const setCurrent = (activeLink) => {
    for (const link of tocLinks) {
      link.classList.toggle('is-current', link === activeLink);
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible.length) {
        setCurrent(map.get(visible[0].target));
      }
    },
    { rootMargin: '-84px 0px -65% 0px', threshold: 0 }
  );

  for (const heading of map.keys()) observer.observe(heading);
}

initThemeToggle();
initHeroMachine();
initMatchDemo();
initCopyButtons();
initDocsToc();
