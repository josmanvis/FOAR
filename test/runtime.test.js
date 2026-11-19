import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDom, tick, fire, compile as parseFoar, loadProject } from './dom.js';
import { createFoarRuntime, hydrate, hydrateIslands, renderToString, renderToStringAsync, renderToStream, matchRoute, parseUrl } from '../web/foar-runtime.js';

const todoSrc = loadProject('todo'); // multi-file project
const counterSrc = fs.readFileSync(new URL('../examples/counter/app.foar', import.meta.url), 'utf8');

const q = (c, sel) => Array.from(c.querySelectorAll(sel));
const texts = (c) => q(c, '.f4-view-TodoItem .f4-text').map((e) => e.textContent);
const typeInto = (window, input, value) => { input.value = value; fire(window, input, 'input'); };

test('TodoApp mounts seeded items from the .foar file', async () => {
  const { container } = makeDom();
  const rt = createFoarRuntime(parseFoar(todoSrc), container, {});
  assert.deepEqual(texts(container), [
    'Design explicit topological UI states',
    'Double-click or click Edit to test Editing state',
    'Eliminate React boolean flags forever',
  ]);
  const boxes = q(container, '.f4-checkbox');
  assert.deepEqual(boxes.map((b) => b.checked), [true, false, false]);
  assert.equal(rt.getSnapshot().length, 4); // root + 3 items
  rt.destroy();
});

test('typing in search patches in place: same input node, keyed rows kept', async () => {
  const { window, container } = makeDom();
  const renders = [];
  const rt = createFoarRuntime(parseFoar(todoSrc), container, { onRender: (s) => renders.push(s.length) });
  const search = q(container, '.f4-input')[0];
  const row3Before = q(container, '.f4-view-TodoItem')[2];
  typeInto(window, search, 'Eliminate');
  await tick();
  assert.equal(texts(container).length, 1);
  assert.equal(q(container, '.f4-input')[0], search, 'search input was recreated');
  assert.equal(q(container, '.f4-view-TodoItem')[0], row3Before, 'surviving row was recreated');
  assert.equal(rt.getSnapshot().length, 2, 'filtered-out instances must be disposed');
  typeInto(window, search, '');
  await tick();
  assert.equal(texts(container).length, 3);
  assert.equal(q(container, '.f4-view-TodoItem')[2], row3Before, 'row identity lost after unfilter');
  assert.equal(rt.getSnapshot().length, 4);
  rt.destroy();
});

test('toggle: child emit -> parent effect -> dynamic style patched on the same node', async () => {
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(todoSrc), container, {});
  const box = q(container, '.f4-checkbox')[1];
  const label = q(container, '.f4-view-TodoItem .f4-text')[1];
  assert.equal(label.style.getPropertyValue('text-decoration'), 'none');
  box.checked = true;
  fire(window, box, 'change');
  await tick();
  assert.equal(q(container, '.f4-view-TodoItem .f4-text')[1], label);
  assert.equal(label.style.getPropertyValue('text-decoration'), 'line-through');
  assert.equal(rt.getSnapshot().find((s) => s.key === 'root').stores.todos[1].completed, true);
  rt.destroy();
});

test('edit flow: transition swaps only that item subtree; Enter saves', async () => {
  const { window, container } = makeDom();
  const transitions = [];
  const rt = createFoarRuntime(parseFoar(todoSrc), container, { onTransition: (t) => transitions.push(`${t.from}->${t.to}`) });
  const rows = q(container, '.f4-view-TodoItem');
  const rootHost = container.firstChild;
  const editBtn = q(rows[0], '.f4-button')[0];
  assert.equal(editBtn.textContent, 'Edit');
  fire(window, editBtn, 'click');
  await tick();
  assert.equal(rows[0].dataset.stateName, 'Editing');
  assert.equal(container.firstChild, rootHost, 'root host must not be recreated');
  assert.equal(q(container, '.f4-view-TodoItem')[1], rows[1], 'sibling row must not be recreated');
  const editInput = q(rows[0], '.f4-input')[0];
  assert.equal(editInput.value, 'Design explicit topological UI states');
  typeInto(window, editInput, 'Renamed');
  fire(window, editInput, 'keydown', { key: 'Enter' });
  await tick();
  assert.equal(rows[0].dataset.stateName, 'Idle');
  assert.equal(texts(container)[0], 'Renamed');
  assert.deepEqual(transitions, ['Idle->Editing', 'Editing->Idle']);
  rt.destroy();
});

test('delete disposes the instance (no leak); add creates one', async () => {
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(todoSrc), container, {});
  const del = q(container, '.f4-view-TodoItem')[1].querySelectorAll('.f4-button')[1];
  assert.equal(del.textContent, 'Delete');
  fire(window, del, 'click');
  await tick();
  assert.equal(texts(container).length, 2);
  assert.equal(rt.getSnapshot().length, 3);
  const draft = q(container, '.f4-input')[1];
  typeInto(window, draft, 'New thing');
  fire(window, q(container, '.f4-row .f4-button')[0], 'click');
  await tick();
  assert.equal(texts(container)[2], 'New thing');
  assert.equal(draft.value, '', 'draft input should be cleared by the effect');
  assert.equal(rt.getSnapshot().length, 4);
  rt.destroy();
});

test('keyed reorder moves existing nodes instead of recreating them', async () => {
  const src = `
    view L {
      store items: Vec<any> = [{id:"a",n:1},{id:"b",n:2},{id:"c",n:3}];
      state Main {
        render {
          Button("rev") -> on_click(Rev)
          List(items) { it => Text("{it.n}") }
        }
        effect Rev() { items = items.slice().reverse(); }
      }
    }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const before = q(container, '.f4-list .f4-text');
  assert.deepEqual(before.map((e) => e.textContent), ['1', '2', '3']);
  fire(window, q(container, '.f4-button')[0], 'click');
  await tick();
  const after = q(container, '.f4-list .f4-text');
  assert.deepEqual(after.map((e) => e.textContent), ['3', '2', '1']);
  assert.equal(after[0], before[2]);
  assert.equal(after[2], before[0]);
  rt.destroy();
});

test('Counter: transitions, async transition with simulated latency and on_exit', async () => {
  const { window, container } = makeDom();
  const log = [];
  const rt = createFoarRuntime(parseFoar(counterSrc), container, {
    asyncDelay: 5,
    onTransition: (t) => log.push(`${t.from}->${t.to}${t.asyncCall ? ' ' + t.asyncCall : ''}`),
  });
  fire(window, q(container, '.f4-button')[0], 'click'); // Start
  await tick();
  assert.equal(container.firstChild.dataset.stateName, 'Active');
  const [minus, plus, finish] = q(container, '.f4-button');
  fire(window, plus, 'click'); fire(window, plus, 'click'); fire(window, minus, 'click');
  await tick();
  assert.equal(q(container, '.f4-text')[0].textContent, 'Current count: 1');
  fire(window, finish, 'click');
  await tick();
  assert.equal(container.firstChild.dataset.stateName, 'Saving');
  assert.ok(q(container, '.f4-spinner-wrap').length === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(container.firstChild.dataset.stateName, 'Initial');
  assert.deepEqual(log, ['Initial->Active', 'Active->Saving api_save(1)', 'Saving->Initial']);
  assert.equal(rt.getSnapshot()[0].stores.count, 0);
  rt.destroy();
});

test('external async binding replaces the simulated timer', async () => {
  const { window, container } = makeDom();
  const calls = [];
  const rt = createFoarRuntime(parseFoar(counterSrc), container, {
    bindings: { api_save: async (n) => { calls.push(n); } },
  });
  fire(window, q(container, '.f4-button')[0], 'click');
  await tick();
  fire(window, q(container, '.f4-button')[1], 'click'); // +
  await tick();
  fire(window, q(container, '.f4-button')[2], 'click'); // Finish
  await tick(); await tick();
  assert.deepEqual(calls, [1]);
  assert.equal(container.firstChild.dataset.stateName, 'Initial');
  rt.destroy();
});

test('batching: many synchronous effects => one flush', async () => {
  const { container } = makeDom();
  let renders = 0;
  const rt = createFoarRuntime(parseFoar(counterSrc), container, { onRender: () => renders++ });
  renders = 0;
  rt.forceStateTransition('root', 'Active');
  renders = 0;
  for (let i = 0; i < 50; i++) rt.invokeEffect('root', 'Increment');
  assert.equal(renders, 0, 'must not flush synchronously');
  await tick();
  assert.equal(renders, 1);
  assert.equal(container.querySelector('.f4-text').textContent, 'Current count: 50');
  rt.destroy();
});

test('static styles become CSS classes; @hover becomes :hover; dynamic stays inline', async () => {
  const { document, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(todoSrc), container, {});
  const css = document.querySelector('style[data-f4-runtime]').textContent;
  assert.match(css, /\.f4-TodoItem\.f4-TodoItem:hover\{background:var\(--row-hover\)\}/);
  assert.match(css, /background:#007bff;color:white/);
  const add = q(container, '.f4-row .f4-button')[0];
  assert.equal(add.style.getPropertyValue('background'), '', 'static style must not be inline');
  assert.ok([...add.classList].some((c) => /^f4-TodoApp-\d+$/.test(c)));
  const label = q(container, '.f4-view-TodoItem .f4-text')[0];
  assert.equal(label.style.getPropertyValue('text-decoration'), 'line-through');
  rt.destroy();
  assert.equal(document.querySelector('style[data-f4-runtime]'), null, 'destroy must remove the stylesheet');
  assert.equal(container.childNodes.length, 0);
});

test('CSS features: theme vars, custom-property bindings, named styles, @state, keyframes, css {}', async () => {
  const src = `
    theme { --accent: #07f; @dark { --accent: #4da3ff; } }
    style Pill { border-radius: 999px; padding: 4px 10px; }
    @keyframes pop { from { transform: scale(.9); } to { transform: scale(1); } }
    css { .f4-text b { color: var(--accent); } }
    view Meter {
      store level: i32 = 30;
      style {
        --level: {level}%;
        width: 200px;
        @state Hot { outline: 2px solid red; }
      }
      state Cool {
        render {
          Text("{level}").style(Pill, { animation: pop .2s ease-out; color: {level > 50 ? "red" : "inherit"}; })
          Button("up") -> on_click(Up)
        }
        effect Up() { level += 30; if level > 50 { transition Hot; } }
      }
      state Hot { render { Text("hot").style(Pill) } }
    }`;
  const { window, document, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const css = document.querySelector('style[data-f4-runtime]').textContent;
  assert.match(css, /:root\{--accent:#07f\}/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\{:root\{--accent:#4da3ff\}\}/);
  assert.match(css, /\.f4-Pill\.f4-Pill\{border-radius:999px;padding:4px 10px\}/);
  assert.match(css, /@keyframes pop\{from\{transform:scale\(\.9\)\}to\{transform:scale\(1\)\}\}/);
  assert.match(css, /\.f4-text b \{ color: var\(--accent\); \}/);
  assert.match(css, /\.f4-Meter\.f4-Meter\[data-state-name="Hot"\]\{outline:2px solid red\}/);
  const host = container.firstChild;
  assert.equal(host.style.getPropertyValue('--level'), '30%');
  const text = q(container, '.f4-text')[0];
  assert.ok(text.classList.contains('f4-Pill'));
  assert.equal(text.style.getPropertyValue('color'), 'inherit');
  fire(window, q(container, '.f4-button')[0], 'click');
  await tick();
  assert.equal(host.dataset.stateName, 'Hot', '@state rule activates via data-state-name');
  assert.equal(host.style.getPropertyValue('--level'), '60%', 'custom property binding updates');
  rt.destroy();
});

test('externs: host functions callable from store init, expressions and effects', async () => {
  const src = `
    view N {
      store notes: any = load();
      store sel: String = "";
      state S {
        render {
          List(notes.filter(|n| n.id == sel), empty: "Nothing selected") { n => Text(shout(n.text)) }
          TextArea(value: notes[0].text, placeholder: "Body") -> on_input(Edit)
          Button("pick") -> on_click(Pick)
        }
        effect Pick() { sel = notes[0].id; }
        effect Edit(t: String) { notes = [{ id: notes[0].id, text: t }]; save(notes); }
      }
    }`;
  const saved = [];
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {
    bindings: { load: () => [{ id: 'a', text: 'hi' }], shout: (s) => s.toUpperCase() + '!', save: (n) => saved.push(n) },
  });
  assert.equal(q(container, '.f4-list-empty')[0].textContent, 'Nothing selected');
  fire(window, q(container, '.f4-button')[0], 'click');
  await tick();
  assert.equal(q(container, '.f4-list .f4-text')[0].textContent, 'HI!');
  assert.equal(q(container, '.f4-list-empty').filter((e) => e.isConnected).length, 0);
  const ta = q(container, '.f4-textarea')[0];
  assert.equal(ta.value, 'hi');
  assert.equal(ta.placeholder, 'Body');
  ta.value = 'yo\nthere';
  fire(window, ta, 'input');
  await tick();
  assert.equal(q(container, '.f4-textarea')[0], ta, 'textarea must not be recreated');
  assert.equal(q(container, '.f4-list .f4-text')[0].textContent, 'YO\nTHERE!');
  assert.deepEqual(saved, [[{ id: 'a', text: 'yo\nthere' }]]);
  rt.destroy();
});

test('If, RichText, Image, context menu, blur, title, innermost handler wins', async () => {
  const src = `
    view P {
      store open: bool = false;
      store html: String = "<p>hi</p>";
      store log: Vec<String> = [];
      store img: String = "";
      store a: bool = false;
      store b: bool = false;
      state S {
        render {
          Row {
            Button("toggle", title: "Toggle panel") -> on_click(Toggle)
          } -> on_click(RowClick) -> on_context_menu(Menu)
          If(open) { Text("panel") Child() }
          RichText(value: html, placeholder: "Write…", editable: !open) -> on_input(Edit)
          Image(src: img, alt: "pic")
          Input(value: "x") -> on_blur(Blurred)
          Text(a || b || open ? "any" : "none")
        }
        effect Toggle() { open = !open; log = [...log, "toggle"]; }
        effect RowClick() { log = [...log, "row"]; }
        effect Menu() { log = [...log, "menu"]; img = "data:image/gif;base64,R0lGODlhAQABAAAAACw="; }
        effect Edit(h: String) { html = h; }
        effect Blurred(v: String) { log = [...log, "blur:" + v]; }
      }
    }
    view Child { store n: i32 = 1; state S { render { Text("child") } } }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const snap = () => rt.getSnapshot().find((s) => s.key === 'root').stores;
  const btn = q(container, '.f4-button')[0];
  assert.equal(btn.title, 'Toggle panel');
  assert.equal(q(container, '.f4-if')[0].childNodes.length, 0);
  assert.equal(q(container, '.f4-text').at(-1).textContent, 'none', '`a || b || open` must not become a closure');

  fire(window, btn, 'click'); await tick();
  assert.deepEqual(snap().log, ['toggle'], 'button click must not bubble to the row handler');
  assert.equal(q(container, '.f4-if .f4-text')[0].textContent, 'panel');
  assert.equal(rt.getSnapshot().length, 2, 'child view mounted inside If');
  assert.equal(q(container, '.f4-text').at(-1).textContent, 'any');

  const rte = q(container, '.f4-richtext')[0];
  assert.equal(rte.innerHTML, '<p>hi</p>');
  assert.equal(rte.contentEditable, 'false', 'editable: binding');
  assert.equal(rte.dataset.placeholder, 'Write…');
  rte.innerHTML = '<p>hi <b>there</b></p>'; fire(window, rte, 'input'); await tick();
  assert.equal(snap().html, '<p>hi <b>there</b></p>');
  assert.equal(q(container, '.f4-richtext')[0], rte, 'editor kept');

  fire(window, btn, 'click'); await tick();
  assert.equal(q(container, '.f4-if')[0].childNodes.length, 0, 'If unmounts');
  assert.equal(rt.getSnapshot().length, 1, 'child instance disposed');
  assert.equal(rte.contentEditable, 'true');

  const img = q(container, '.f4-image')[0];
  assert.equal(img.hidden, true);
  const ev = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  q(container, '.f4-row')[0].dispatchEvent(ev); await tick();
  assert.equal(ev.defaultPrevented, true, 'native menu suppressed');
  assert.equal(img.hidden, false);
  assert.equal(img.alt, 'pic');

  const inp = q(container, '.f4-input')[0];
  inp.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); await tick();
  assert.deepEqual(snap().log, ['toggle', 'toggle', 'menu', 'blur:x']);
  rt.destroy();
});

test('props and stores shadow host functions with the same name', async () => {
  const src = `
    view Root { state S { render { Line(label: "from prop") Text(label("x")) } } }
    view Line(label: String) {
      store title: String = "from store";
      state S { render { Text(label) Text(title) } }
    }`;
  const { container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {
    bindings: { label: (x) => `host ${x}`, title: () => 'host title' },
  });
  const texts = q(container, '.f4-text').map((e) => e.textContent);
  assert.deepEqual(texts, ['from prop', 'from store', 'host x']);
  rt.destroy();
});

test('i18n: t() with placeholders, plurals, fallback, and live setLocale', async () => {
  const src = `
    view Root {
      store n: i32 = 1;
      state S {
        render {
          Text(t("hello", { name: "Ana" }))
          Text(t("notes", { count: n }))
          Text(t("only.en"))
          Text(t(t_key("add")))
          Button(t("add")) -> on_click(Add)
        }
        effect Add() { n = n + 1; }
      }
    }`;
  const { window, container } = makeDom();
  const messages = {
    en: { hello: 'Hello, {name}!', notes: { zero: 'No notes', one: '{count} note', other: '{count} notes' }, 'only.en': 'English only', add: 'Add' },
    es: { hello: '¡Hola, {name}!', notes: { one: '{count} nota', other: '{count} notas' }, add: 'Añadir' },
  };
  const rt = createFoarRuntime(parseFoar(src), container, { i18n: { locale: 'en', messages } });
  const texts = () => q(container, '.f4-text, .f4-button').map((e) => e.textContent);
  assert.deepEqual(texts(), ['Hello, Ana!', '1 note', 'English only', 'Add', 'Add']);
  assert.equal(container.lang, 'en');
  fire(window, q(container, '.f4-button')[0], 'click'); await tick();
  assert.equal(texts()[1], '2 notes');
  const button = q(container, '.f4-button')[0];
  rt.setLocale('es');
  assert.deepEqual(texts(), ['¡Hola, Ana!', '2 notas', 'English only', 'Añadir', 'Añadir']);
  assert.equal(q(container, '.f4-button')[0], button, 'switching language patches in place');
  assert.equal(container.lang, 'es');
  rt.setLocale('ar');
  assert.equal(container.dir, 'rtl');
  rt.destroy();
});

test('accessibility: label/role/aria args, icon button names, keyboard-operable rows', async () => {
  const src = `
    view Root {
      store open: bool = false;
      store hits: i32 = 0;
      state S {
        render {
          Button("⋯", title: "More") -> on_click(Toggle)
          Row { Text("Row") } -> on_click(Hit)
          Column { Text("x") }.style({ gap: 0; })
          Text("list", role: "listbox", label: "Notes", aria: { expanded: open, activedescendant: open ? "a" : null })
        }
        effect Toggle() { open = !open; }
        effect Hit() { hits = hits + 1; }
      }
    }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const btn = q(container, '.f4-button')[0];
  assert.equal(btn.getAttribute('aria-label'), 'More');
  const row = q(container, '.f4-row')[0];
  assert.equal(row.getAttribute('role'), 'button');
  assert.equal(row.tabIndex, 0);
  assert.equal(q(container, '.f4-column')[0].hasAttribute('tabindex'), false, 'non-clickable stays out of tab order');
  fire(window, row, 'keydown', { key: 'Enter' }); await tick();
  fire(window, row, 'keydown', { key: ' ' }); await tick();
  fire(window, row, 'keydown', { key: 'a' }); await tick();
  assert.equal(rt.getSnapshot()[0].stores.hits, 2);
  const lb = q(container, '[role=listbox]')[0];
  assert.equal(lb.getAttribute('aria-label'), 'Notes');
  assert.equal(lb.getAttribute('aria-expanded'), 'false');
  assert.equal(lb.hasAttribute('aria-activedescendant'), false);
  fire(window, btn, 'click'); await tick();
  assert.equal(lb.getAttribute('aria-expanded'), 'true');
  assert.equal(lb.getAttribute('aria-activedescendant'), 'a');
  rt.destroy();
});

test('context menu effects receive the pointer position', async () => {
  const src = `
    view Root {
      store at: any = null;
      state S { render { Row { Text("r") } -> on_context_menu(Menu) } effect Menu(p: any) { at = p; } }
    }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  q(container, '.f4-row')[0].dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 45 }));
  await tick();
  assert.deepEqual(rt.getSnapshot()[0].stores.at, { x: 120, y: 45 });
  rt.destroy();
});

test('drag and drop: drag payload reaches the drop target effect; classes while dragging', async () => {
  const src = `
    view Root {
      store items: Vec<any> = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
      store moved: any = null;
      state S {
        render {
          List(items) { it => Text(it.name, drag: it.id, drag_text: it.name) }
          Column { Text("Trash") } -> on_drop(Dropped)
        }
        effect Dropped(id: any) { moved = id; }
      }
    }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const src0 = q(container, '[draggable=true]')[1];
  assert.ok(src0, 'draggable element');
  const target = q(container, '.f4-column')[0];
  const data = {};
  const dt = { setData: (k, v) => { data[k] = v; }, effectAllowed: '', dropEffect: '' };
  const drag = (el, type) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    e.dataTransfer = dt;
    el.dispatchEvent(e);
    return e;
  };
  drag(src0, 'dragstart');
  assert.equal(data['text/plain'], 'B');
  assert.ok(src0.classList.contains('f4-drag-source'));
  const over = drag(target.firstChild, 'dragover');
  assert.equal(over.defaultPrevented, true, 'drop target accepts');
  assert.ok(target.classList.contains('f4-drop-over'));
  drag(target, 'drop');
  await tick();
  assert.equal(rt.getSnapshot()[0].stores.moved, 'b');
  assert.equal(src0.classList.contains('f4-drag-source'), false);
  assert.equal(target.classList.contains('f4-drop-over'), false);
  // A drag from outside (files) is left alone.
  const ext = drag(target, 'dragover');
  assert.equal(ext.defaultPrevented, false);
  rt.destroy();
});

test('List containers take role/label and events (context menu on the background)', async () => {
  const src = `
    view Root {
      store items: Vec<any> = [{ id: "a" }];
      store hit: any = null;
      state S {
        render { List(items, role: "listbox", label: "Things") { it => Text(it.id) } -> on_context_menu(Menu) }
        effect Menu(p: any) { hit = p; }
      }
    }`;
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const list = q(container, '.f4-list')[0];
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.equal(list.getAttribute('aria-label'), 'Things');
  list.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 }));
  await tick();
  assert.deepEqual(rt.getSnapshot()[0].stores.hit, { x: 5, y: 6 });
  rt.destroy();
});

// ---- enums, match, Match/If-Else, let, loops --------------------------------------------
const langSrc = `
enum Filter { All, Active, Done = "completed" }

view App {
    store filter: Filter = Filter.All;
    store items: Vec<any> = [{ id: "a", done: false }, { id: "b", done: true }, { id: "c", done: false }];
    store log: String = "";
    let open = items.filter(|t| !t.done).len();
    let shown = match filter {
        Filter.All => items,
        Filter.Active => items.filter(|t| !t.done),
        Filter.Done => items.filter(|t| t.done),
    };

    state Ready {
        render {
            Text("{open} open").style({ color: red; })
            Match(filter) {
                All => Text("everything"),
                Active => { Text("todo") Text("only") }
                Done => Text("finished"),
            }
            If(shown.len() == 0) { Text("none") } Else If(shown.len() == 1) { Text("one") } Else { Text("many") }
            Match(open) {
                0 => Text("all done"),
                n if n > 1 => Text("{n} left"),
                _ => Text("one left"),
            }
            Button("next") -> on_click(Next)
            Button("finish") -> on_click(FinishAll)
        }
        effect Next() {
            filter = match filter {
                Filter.All => Filter.Active,
                Filter.Active => Filter.Done,
                Filter.Done => Filter.All,
            };
        }
        effect FinishAll() {
            for t in items { t.done = true; }
            let mut total = 0;
            for i in 1..=3 { total += i; }
            match open {
                0 => log = "nothing to do",
                _ => { log = "finished " + total; }
            }
        }
    }
}
`;

test('enums + match: values, render Match swaps arms, If/Else chain, let recomputes', async () => {
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(langSrc), container, {});
  const textsAll = () => q(container, '.f4-text').map((e) => e.textContent);
  assert.deepEqual(textsAll(), ['2 open', 'everything', 'many', '2 left']);
  const head = q(container, '.f4-text')[0];
  const next = q(container, '.f4-button')[0];
  next.click();
  await tick();
  assert.equal(rt.getSnapshot()[0].stores.filter, 'Active', 'enum values are plain strings');
  assert.deepEqual(textsAll(), ['2 open', 'todo', 'only', 'many', '2 left']);
  next.click();
  await tick();
  assert.equal(rt.getSnapshot()[0].stores.filter, 'completed', 'explicit enum value');
  assert.deepEqual(textsAll(), ['2 open', 'finished', 'one', '2 left']);
  assert.equal(q(container, '.f4-text')[0], head, 'nodes outside the Match are kept');
  // the same arm stays mounted when the value changes but the arm doesn't
  const leftNode = q(container, '.f4-text').at(-1);
  q(container, '.f4-button')[1].click();
  await tick();
  assert.deepEqual(textsAll(), ['0 open', 'finished', 'many', 'all done'], 'let values recompute after effects');
  assert.notEqual(q(container, '.f4-text').at(-1), leftNode, 'a new arm mounts new nodes');
  assert.equal(rt.getSnapshot()[0].stores.log, 'finished 6', 'for loops and match statements run');
  rt.destroy();
});

test('Match keeps an arm mounted while the value changes inside it (binding updates)', async () => {
  const { window, container } = makeDom();
  const src = 'view C {\n store n: i32 = 5;\n state S {\n render {\n Match(n) {\n 0 => Text("zero"),\n k if k > 0 => Text("pos {k}"),\n _ => Text("neg"),\n }\n Button("-") -> on_click(Dec)\n }\n effect Dec() { n -= 1; }\n }\n}\n';
  const rt = createFoarRuntime(parseFoar(src), container, {});
  const node = q(container, '.f4-text')[0];
  assert.equal(node.textContent, 'pos 5');
  q(container, '.f4-button')[0].click();
  await tick();
  assert.equal(q(container, '.f4-text')[0], node, 'same arm: node reused');
  assert.equal(node.textContent, 'pos 4', 'binding updated');
  rt.destroy();
});

test('orders example: exhaustive matches drive badges and actions; let values recompute', async () => {
  const { window, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(loadProject('orders')), container, {});
  const row = (i) => [...container.querySelectorAll('.f4-view-OrderRow')[i].querySelectorAll('.f4-text, .f4-button')].map((e) => e.textContent);
  assert.deepEqual(row(0), ['A-1001 · Ana', '1 item · $18', 'Pending', 'Mark paid', 'Cancel']);
  assert.deepEqual(row(4).slice(2), ['Cancelled', '—']);
  const first = container.querySelector('.f4-view-OrderRow');
  fire(window, first.querySelector('.f4-button'), 'click');
  await tick();
  assert.deepEqual(row(0).slice(2), ['Paid', 'Ship', 'Cancel']);
  assert.equal(rt.getSnapshot()[0].stores.orders[0].status, 'Paid');
  fire(window, [...first.querySelectorAll('.f4-button')].find((b) => b.textContent === 'Cancel'), 'click');
  await tick();
  assert.deepEqual(row(0).slice(2), ['Cancelled', '—']);
  assert.equal(container.querySelector('.f4-view-Orders > .f4-row .f4-text').textContent, '2 open · revenue $506.40');
  rt.destroy();
});

const routedSrc = `
extern fn format_badge(id: String) -> String;

view App {
    state Ready {
        render {
            Column {
                Row {
                    Link("/", "Home")
                    Link("/orders/42", "Order 42")
                    Link("/orders/99", "Order 99")
                }
                Router {
                    Route("/") { Text("Welcome home") }
                    Route("/orders/:id") { params => OrderPage(id: params.id) }
                    Route("*") { Text("404: {route.path}") }
                }
                Button("Go missing") -> on_click(GoMissing)
            }
        }
        effect GoMissing() { navigate("/nope?from=btn"); }
    }
}

view OrderPage(id: String) {
    store clicks: i32 = 0;
    let label: String = format_badge(id);
    state Ready {
        render {
            Column {
                Text("Order {label} ({clicks})")
                Button("Ping") -> on_click(Ping)
            }
        }
        effect Ping() { clicks += 1; }
    }
}
`;

test('router: Route matching, Link navigation, aria-current, param updates, and navigate()', async () => {
  assert.deepEqual(matchRoute('/orders/:id', '/orders/A-1002'), { id: 'A-1002' });
  assert.deepEqual(matchRoute('/docs/*slug', '/docs/a/b/c'), { slug: 'a/b/c' });
  assert.equal(matchRoute('/orders/:id', '/orders'), null);
  assert.deepEqual(parseUrl('/orders/42?tab=items#sec'), { path: '/orders/42', query: { tab: 'items' }, hash: 'sec' });

  const { window, container } = makeDom();
  const ast = parseFoar(routedSrc);
  const bindings = { format_badge: (id) => `#${id}` };
  const rt = createFoarRuntime(ast, container, { url: '/', bindings });

  assert.equal(q(container, '.f4-text')[0].textContent, 'Welcome home');
  const links = q(container, 'a.f4-link');
  assert.equal(links[0].getAttribute('aria-current'), 'page');
  assert.equal(links[1].getAttribute('aria-current'), null);

  // Click Link("/orders/42")
  links[1].click();
  await tick();
  assert.equal(rt.getRoute().path, '/orders/42');
  assert.deepEqual(rt.getRoute().params, { id: '42' });
  assert.equal(links[0].getAttribute('aria-current'), null);
  assert.equal(links[1].getAttribute('aria-current'), 'page');
  const orderText = container.querySelector('.f4-view-OrderPage .f4-text');
  assert.equal(orderText.textContent, 'Order #42 (0)');

  // Navigating to another order reuses the mounted Route and updates params in place
  links[2].click();
  await tick();
  assert.equal(container.querySelector('.f4-view-OrderPage .f4-text'), orderText, 'same Route kept mounted');
  assert.equal(orderText.textContent, 'Order #99 (0)');

  // Effect calling navigate("/nope?from=btn") hits wildcard Route("*")
  q(container, '.f4-button').find((b) => b.textContent === 'Go missing').click();
  await tick();
  assert.equal(rt.getRoute().path, '/nope');
  assert.deepEqual(rt.getRoute().query, { from: 'btn' });
  assert.equal(container.querySelector('.f4-router .f4-text').textContent, '404: /nope');
  assert.equal(rt.getSnapshot().length, 1, 'unmounted OrderPage disposed cleanly');
  rt.destroy();
});

test('SSR renderToString (zero DOM) + zero-recreation client hydrate()', async () => {
  const ast = parseFoar(routedSrc);
  const bindings = { format_badge: (id) => `#${id}` };

  // 1. Server render with NO DOM globals
  const prevDoc = globalThis.document;
  delete globalThis.document;
  let ssr;
  try {
    ssr = renderToString(ast, { url: '/orders/77', bindings });
  } finally {
    globalThis.document = prevDoc;
  }
  assert.ok(ssr.html.includes('Order #77 (0)'), ssr.html);
  assert.ok(ssr.html.includes('href="/orders/42"'), ssr.html);
  assert.ok(ssr.css.includes('.f4-row'), 'emits scoped CSS');
  assert.equal(ssr.state.route, '/orders/77');
  assert.ok(ssr.head.includes('data-f4-ssr') && ssr.head.includes('__foar_state__'));

  // 2. Client hydrate() in place — verify ZERO createElement calls!
  const { document, container } = makeDom();
  document.head.innerHTML = ssr.head;
  container.innerHTML = ssr.html;

  const ssrTextNode = container.querySelector('.f4-view-OrderPage .f4-text');
  const ssrPingBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Ping');
  const ssrHomeLink = container.querySelector('a.f4-link');
  assert.ok(ssrTextNode && ssrPingBtn && ssrHomeLink);

  let createdDuringHydrate = 0;
  const origCreate = document.createElement.bind(document);
  document.createElement = (...args) => {
    createdDuringHydrate++;
    return origCreate(...args);
  };
  let rt;
  try {
    rt = hydrate(ast, container, { bindings });
  } finally {
    document.createElement = origCreate;
  }

  assert.equal(createdDuringHydrate, 0, `expected 0 DOM elements created during hydrate, got ${createdDuringHydrate}`);
  assert.equal(container.querySelector('.f4-view-OrderPage .f4-text'), ssrTextNode, 'adopted exact text node');
  assert.equal([...container.querySelectorAll('button')].find((b) => b.textContent === 'Ping'), ssrPingBtn, 'adopted exact button');
  assert.equal(container.querySelector('a.f4-link'), ssrHomeLink, 'adopted exact link');

  // 3. Hydrated app is immediately live & interactive
  ssrPingBtn.click();
  await tick();
  assert.equal(ssrTextNode.textContent, 'Order #77 (1)');

  ssrHomeLink.click();
  await tick();
  assert.equal(rt.getRoute().path, '/');
  assert.equal(container.querySelector('.f4-router .f4-text').textContent, 'Welcome home');
  rt.destroy();
});

test('Slots: default + named slots + fallback content + caller events + SSR + hydrate', async () => {
  const src = `
view Card(title: String) {
  state Ready {
    render {
      Column {
        Row { Slot(name: "header") { Text("Default Header") } }
        Text(title)
        Column { Slot() { Text("Empty Body") } }
        Row { Slot(name: "footer") { Text("No Footer") } }
      }
    }
  }
}

view App {
  store count: i32 = 1;
  state Ready {
    render {
      Card(title: "Card #{count}") {
        Text("Custom Header", slot: "header")
        Text("Count is {count}")
        Button("Inc") -> on_click(Inc)
      }
    }
    effect Inc() { count += 1; }
  }
}
`;
  const ast = parseFoar(src);
  // Swap entry view so App is first? Remember ast.views[0] is root!
  // Let's put App first in a second test or reorder src so App is first:
  assert.equal(ast.views[0].name, 'Card');
  const appFirst = `
view App {
  store count: i32 = 1;
  state Ready {
    render {
      Card(title: "Card #{count}") {
        Text("Custom Header", slot: "header")
        Text("Count is {count}")
        Button("Inc") -> on_click(Inc)
      }
    }
    effect Inc() { count += 1; }
  }
}

view Card(title: String) {
  state Ready {
    render {
      Column {
        Row { Slot(name: "header") { Text("Default Header") } }
        Text(title)
        Column { Slot() { Text("Empty Body") } }
        Row { Slot(name: "footer") { Text("No Footer") } }
      }
    }
  }
}
`;
  const appAst = parseFoar(appFirst);

  // 1. SSR renders named slot, default slot, and slot fallback
  const ssr = renderToString(appAst);
  assert.ok(ssr.html.includes('Custom Header'), ssr.html);
  assert.ok(ssr.html.includes('Card #1'), ssr.html);
  assert.ok(ssr.html.includes('Count is 1'), ssr.html);
  assert.ok(ssr.html.includes('No Footer'), 'unfilled named slot uses fallback');

  // 2. Client hydrate preserves zero-recreation DOM + keeps caller events live!
  const { document, container } = makeDom();
  document.head.innerHTML = ssr.head;
  container.innerHTML = ssr.html;
  const origBtn = container.querySelector('button');
  let created = 0;
  const origCreate = document.createElement.bind(document);
  document.createElement = (...a) => { created++; return origCreate(...a); };
  let rt;
  try {
    rt = hydrate(appAst, container);
  } finally {
    document.createElement = origCreate;
  }
  assert.equal(created, 0, 'slot hydration creates 0 DOM nodes');
  assert.equal(container.querySelector('button'), origBtn);

  // Clicking button inside projected slot runs caller's Inc effect and updates both Card prop & slotted Text!
  origBtn.click();
  await tick();
  const txts = q(container, '.f4-text').map((e) => e.textContent);
  assert.deepEqual(txts, ['Custom Header', 'Card #2', 'Count is 2', 'No Footer']);
  rt.destroy();
});

test('Portals: renders into target container, delegates events, and cleans up on unmount', async () => {
  const src = `
view App {
  store open: bool = true;
  store clicks: i32 = 0;
  state Ready {
    render {
      Column {
        Text("Clicks: {clicks}")
        Button("Toggle") -> on_click(Toggle)
        If(open) {
          Portal(target: "#modal-root") {
            Column {
              Text("Modal Body {clicks}")
              Button("Portal Click") -> on_click(Hit)
            }
          }
        }
      }
    }
    effect Toggle() { open = !open; }
    effect Hit() { clicks += 1; }
  }
}
`;
  const { document, container } = makeDom();
  const modalRoot = document.createElement('div');
  modalRoot.id = 'modal-root';
  document.body.appendChild(modalRoot);

  const ast = parseFoar(src);
  const rt = createFoarRuntime(ast, container);

  assert.equal(container.querySelectorAll('.f4-portal-root').length, 0, 'portal is not inside app container');
  assert.equal(modalRoot.querySelectorAll('.f4-portal-root').length, 1, 'portal mounted into #modal-root');
  assert.equal(modalRoot.querySelector('.f4-text').textContent, 'Modal Body 0');

  // Event delegation works inside the portal
  modalRoot.querySelector('button').click();
  await tick();
  assert.equal(container.querySelector('.f4-text').textContent, 'Clicks: 1');
  assert.equal(modalRoot.querySelector('.f4-text').textContent, 'Modal Body 1');

  // Toggling If(open) off unmounts and removes the portal cleanly
  container.querySelector('button').click();
  await tick();
  assert.equal(modalRoot.querySelectorAll('.f4-portal-root').length, 0, 'portal removed on unmount');
  rt.destroy();
});

test('Lifecycle hooks: on_enter, state on_unmount, and view on_unmount fire in order', async () => {
  const src = `
extern fn log_event(name: String) -> Void;

view App {
  on_unmount { log_event("view:unmount"); }
  state Alpha {
    on_enter { log_event("Alpha:enter"); }
    on_unmount { log_event("Alpha:unmount"); }
    render { Button("Next") -> on_click(Go) }
    effect Go() { transition Beta; }
  }
  state Beta {
    on_enter { log_event("Beta:enter"); }
    on_unmount { log_event("Beta:unmount"); }
    render { Text("In Beta") }
  }
}
`;
  const { container } = makeDom();
  const events = [];
  const rt = createFoarRuntime(parseFoar(src), container, {
    bindings: { log_event: (n) => events.push(n) },
  });
  assert.deepEqual(events, ['Alpha:enter']);

  container.querySelector('button').click();
  await tick();
  assert.deepEqual(events, ['Alpha:enter', 'Alpha:unmount', 'Beta:enter']);

  rt.destroy();
  assert.deepEqual(events, ['Alpha:enter', 'Alpha:unmount', 'Beta:enter', 'Beta:unmount', 'view:unmount']);
});

test('Error boundaries: Catch / Fallback isolates runtime & SSR errors without crashing siblings', async () => {
  const src = `
extern fn risky(boom: bool) -> String;

view App {
  store boom: bool = false;
  state Ready {
    render {
      Column {
        Text("Safe Sibling")
        Button("Break") -> on_click(Break)
        Catch {
          Text(risky(boom))
        } Fallback { err =>
          Text("Caught: {err.message} @ {err.view}")
        }
      }
    }
    effect Break() { boom = true; }
  }
}
`;
  const ast = parseFoar(src);
  const errors = [];
  const risky = (b) => {
    if (b) throw new Error('Kaboom');
    return 'All Good';
  };

  // 1. Live client runtime: starts healthy, then catches error on reactive update
  const { container } = makeDom();
  const rt = createFoarRuntime(ast, container, {
    bindings: { risky },
    onError: (e) => errors.push(e),
  });
  assert.deepEqual(q(container, '.f4-text').map((e) => e.textContent), ['Safe Sibling', 'All Good']);

  container.querySelector('button').click();
  await tick();
  assert.deepEqual(q(container, '.f4-text').map((e) => e.textContent), ['Safe Sibling', 'Caught: Kaboom @ App']);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Kaboom');
  rt.destroy();

  // 2. SSR Catch isolates render-time errors too
  const ssrSrc = src.replace('store boom: bool = false;', 'store boom: bool = true;');
  const ssr = renderToString(parseFoar(ssrSrc), { bindings: { risky } });
  assert.ok(ssr.html.includes('Safe Sibling'), ssr.html);
  assert.ok(ssr.html.includes('Caught: Kaboom @ App'), ssr.html);
});

test('Tagged-union enums with payloads + generic data<T> / enum<T> at runtime & SSR', async () => {
  const src = `
data User { name: String }
enum LoadState<T> { Idle, Loading, Ready(T), Failed(String) }

view App {
  store req: LoadState<User> = LoadState.Ready(User { name: "Ada" });
  let summary: String = match req {
    LoadState.Ready(u) => "Hello {u.name}",
    LoadState.Failed(msg) => "Err: {msg}",
    LoadState.Idle | LoadState.Loading => "Waiting",
  };
  state Main {
    render {
      Column {
        Text(summary)
        Match(req) {
          Ready(u) => Text("User: {u.name}")
          Failed(err) => Text("Failed: {err}")
          Idle | Loading => Spinner("...")
        }
        Button("Fail") -> on_click(Fail)
      }
    }
    effect Fail() { req = LoadState.Failed("timeout"); }
  }
}
`;
  const ast = parseFoar(src);
  const ssr = renderToString(ast);
  assert.ok(ssr.html.includes('Hello Ada'), ssr.html);
  assert.ok(ssr.html.includes('User: Ada'), ssr.html);

  const { container } = makeDom();
  const rt = createFoarRuntime(ast, container);
  assert.deepEqual(q(container, '.f4-text').map((e) => e.textContent), ['Hello Ada', 'User: Ada']);

  container.querySelector('button').click();
  await tick();
  assert.deepEqual(q(container, '.f4-text').map((e) => e.textContent), ['Err: timeout', 'Failed: timeout']);
  rt.destroy();
});

test('Streaming SSR (renderToStream) + async route loaders (renderToStringAsync)', async () => {
  const src = `
extern fn get_title() -> String;

view App {
  let title: String = get_title();
  state Ready {
    render {
      Column {
        Text(title)
        Router {
          Route("/posts/:id") { p => Text("Post #{p.id}") }
          Route("*") { Text("Home") }
        }
      }
    }
  }
}
`;
  const ast = parseFoar(src);
  const loaders = {
    '/posts/:id': async (params) => {
      await new Promise((r) => setTimeout(r, 5));
      return { get_title: () => `Loaded Post ${params.id}` };
    },
  };

  // 1. renderToStringAsync
  const asyncRes = await renderToStringAsync(ast, { url: '/posts/404', loaders });
  assert.ok(asyncRes.html.includes('Loaded Post 404'), asyncRes.html);
  assert.ok(asyncRes.html.includes('Post #404'), asyncRes.html);

  // 2. renderToStream (Web ReadableStream, flushes style shell before async body)
  const stream = renderToStream(ast, {
    url: '/posts/88',
    loaders,
    shellBefore: '<!doctype html><html><head>',
    shellAfter: '</body></html>',
  });
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(dec.decode(value));
  }
  assert.ok(chunks.length >= 3, `expected progressive chunks, got ${chunks.length}`);
  assert.ok(chunks[0].startsWith('<!doctype html>'));
  assert.ok(chunks[1].includes('<style data-f4-ssr>'));
  const full = chunks.join('');
  assert.ok(full.includes('Loaded Post 88'), full);
  assert.ok(full.includes('Post #88'), full);
  assert.ok(full.includes('id="__foar_state__"'), full);
  assert.ok(full.endsWith('</body></html>'));
});

test('Shared reactive Context (context / use) + pure FOAR fn across views, SSR, and hydrate', async () => {
  const src = `
fn format_usd(cents: i32) -> String {
  return "$" + (cents / 100).toFixed(2);
}

context Cart {
  store cents: i32 = 250;
  let total_str: String = format_usd(cents);

  effect Add(delta: i32) { cents += delta; }
  effect Reset() { cents = 0; }
}

view Header {
  use Cart;
  state Ready {
    render {
      Row {
        Text("Total: {Cart.total_str}")
        Button("Clear", disabled: Cart.cents == 0) -> on_click(Cart.Reset)
      }
    }
  }
}

view App {
  use Cart;
  state Ready {
    render {
      Column {
        Header()
        Button("Add $1.50") -> on_click(Buy)
      }
    }
    effect Buy() { Cart.Add(150); }
  }
}
`;
  const appFirst = src.slice(0, src.indexOf('view Header')) + src.slice(src.indexOf('view App')) + '\n' + src.slice(src.indexOf('view Header'), src.indexOf('view App'));
  const ast = parseFoar(appFirst);

  // 1. SSR evaluates pure `fn` and `context` stores/lets with zero DOM
  const ssr = renderToString(ast);
  assert.ok(ssr.html.includes('Total: $2.50'), ssr.html);
  assert.deepEqual(ssr.state.contexts, { Cart: { cents: 250 } });

  // 2. Hydrate restores context & updates sibling view reactively on Cart.Add / Cart.Reset
  const { document, container } = makeDom();
  document.head.innerHTML = ssr.head;
  container.innerHTML = ssr.html;
  const rt = hydrate(ast, container);
  const clearBtn = q(container, 'button').find((b) => b.textContent === 'Clear');
  const addBtn = q(container, 'button').find((b) => b.textContent === 'Add $1.50');
  assert.equal(clearBtn.disabled, false);

  addBtn.click();
  await tick();
  assert.equal(container.querySelector('.f4-text').textContent, 'Total: $4.00');

  // Direct `-> on_click(Cart.Reset)` invokes context effect and updates disabled prop!
  clearBtn.click();
  await tick();
  assert.equal(container.querySelector('.f4-text').textContent, 'Total: $0.00');
  assert.equal(clearBtn.disabled, true);
  rt.destroy();
});

test('Forms & controls (Form, Select/Option, Slider, Progress, disabled/class/id) + SSR', async () => {
  const src = `
view App {
  store plan: String = "pro";
  store level: i32 = 40;
  store submitted: i32 = 0;

  state Ready {
    render {
      Form(id: "cfg-form") {
        Select(value: plan, class: "picker") {
          Option(value: "free", "Free")
          Option(value: "pro", "Pro")
          Option(value: "team", "Team")
        } -> on_change(PickPlan)
        Slider(value: level, min: 0, max: 100, step: 10) -> on_input(SetLevel)
        Progress(value: level, max: 100)
        Text("{plan}:{level}:{submitted}", class: submitted > 0 ? "is-saved" : "")
        Button("Save", disabled: level == 0) -> on_click(Save)
      } -> on_submit(Save)
    }
    effect PickPlan(p: String) { plan = p; }
    effect SetLevel(v: i32) { level = v; }
    effect Save() { submitted += 1; }
  }
}
`;
  const ast = parseFoar(src);
  const ssr = renderToString(ast);
  assert.ok(ssr.html.includes('<form class="f4-form" id="cfg-form">'), ssr.html);
  assert.ok(ssr.html.includes('<option class="f4-option" value="pro" selected>Pro</option>'), ssr.html);
  assert.ok(ssr.html.includes('<progress class="f4-progress" value="40" max="100"></progress>'), ssr.html);

  const { window, container } = makeDom();
  const rt = createFoarRuntime(ast, container);
  const sel = container.querySelector('select');
  const slider = container.querySelector('input[type="range"]');
  const prog = container.querySelector('progress');
  const form = container.querySelector('form');
  const txt = container.querySelector('.f4-text');

  assert.equal(sel.value, 'pro');
  assert.equal(Number(prog.value), 40);

  sel.value = 'team';
  fire(window, sel, 'change');
  slider.value = '80';
  fire(window, slider, 'input');
  fire(window, form, 'submit');
  await tick();

  assert.equal(txt.textContent, 'team:80:1');
  assert.equal(Number(prog.value), 80);
  assert.ok(txt.classList.contains('is-saved'));
  rt.destroy();
});

test('State-scoped keyboard shortcuts (on_key) activate only in their owning state', async () => {
  const src = `
view App {
  store note: String = "Draft";
  state Viewing {
    on_key("Mod+K") { transition Editing; }
    render { Text("Viewing: {note}") }
  }
  state Editing {
    on_key("Escape") { transition Viewing; }
    render { Text("Editing: {note}") }
  }
}
`;
  const { window, document, container } = makeDom();
  const rt = createFoarRuntime(parseFoar(src), container);
  assert.equal(container.querySelector('.f4-text').textContent, 'Viewing: Draft');

  // Escape does nothing in Viewing
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(rt.getSnapshot()[0].state, 'Viewing');

  // Mod+K transitions Viewing -> Editing
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
  assert.equal(rt.getSnapshot()[0].state, 'Editing');
  assert.equal(container.querySelector('.f4-text').textContent, 'Editing: Draft');

  // Escape in Editing transitions back to Viewing
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await tick();
  assert.equal(rt.getSnapshot()[0].state, 'Viewing');
  rt.destroy();
});

test('Async transition result on_exit(res) and rejection hook on_error(err)', async () => {
  const src = `
extern fn submit_order(ok: bool) -> Promise<String>;

view App {
  store message: String = "ready";
  state Idle {
    render {
      Row {
        Text(message)
        Button("OK") -> on_click(SendOk)
        Button("Fail") -> on_click(SendFail)
      }
    }
    effect SendOk() { submit_order(true) -> transition(Sending); }
    effect SendFail() { submit_order(false) -> transition(Sending); }
  }
  state Sending {
    render { Spinner("Sending...") }
    on_exit(receipt: String) {
      message = "Receipt: {receipt}";
      transition Idle;
    }
    on_error(err: String) {
      message = "Error: {err}";
      transition Failed;
    }
  }
  state Failed {
    render { Text(message) }
  }
}
`;
  const { container } = makeDom();
  const ast = parseFoar(src);
  const submit_order = async (ok) => {
    if (!ok) throw new Error('Card declined');
    return 'ORD-778';
  };
  const rt = createFoarRuntime(ast, container, { bindings: { submit_order } });

  q(container, 'button').find((b) => b.textContent === 'OK').click();
  await tick();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(rt.getSnapshot()[0].state, 'Idle');
  assert.equal(container.querySelector('.f4-text').textContent, 'Receipt: ORD-778');

  q(container, 'button').find((b) => b.textContent === 'Fail').click();
  await tick();
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(rt.getSnapshot()[0].state, 'Failed');
  assert.equal(container.querySelector('.f4-text').textContent, 'Error: Card declined');
  rt.destroy();
});

test('Partial Islands Hydration (Island + hydrateIslands) hydrates only the island in place', async () => {
  const src = `
view Page {
  state Static {
    render {
      Column {
        Text("Static Server Article")
        Island(client: "load") {
          LikeButton(initial: 5)
        }
      }
    }
  }
}

view LikeButton(initial: i32) {
  store likes: i32 = initial;
  state Ready {
    render {
      Button("Likes: {likes}") -> on_click(Like)
    }
    effect Like() { likes += 1; }
  }
}
`;
  const ast = parseFoar(src);
  const ssr = renderToString(ast);
  assert.ok(ssr.html.includes('data-f4-island="LikeButton"'), ssr.html);
  assert.ok(ssr.html.includes('data-f4-hydrate="load"'), ssr.html);

  const { document, container } = makeDom();
  document.head.innerHTML = ssr.head;
  container.innerHTML = ssr.html;
  const staticNode = container.querySelector('.f4-text');
  const likeBtn = container.querySelector('button');
  assert.equal(likeBtn.textContent, 'Likes: 5');

  let created = 0;
  const origCreate = document.createElement.bind(document);
  document.createElement = (...a) => { created++; return origCreate(...a); };
  let mgr;
  try {
    mgr = hydrateIslands(container, ast);
  } finally {
    document.createElement = origCreate;
  }

  assert.equal(mgr.islands.length, 1);
  assert.equal(created, 0, 'island hydration creates 0 DOM elements');
  assert.equal(container.querySelector('.f4-text'), staticNode, 'static HTML untouched');
  assert.equal(container.querySelector('button'), likeBtn, 'adopted exact island button');

  likeBtn.click();
  await tick();
  assert.equal(likeBtn.textContent, 'Likes: 6');
  mgr.destroy();
});

test('prop defaults: used when a prop is not given, on the client and in SSR', async () => {
  const src = `view App {
    state S { render { Badge(label: "a") Badge(label: "b", tone: "red", count: 2) } }
}
view Badge(label: String, tone: String = "gray", count: i32 = 0) {
    state S { render { Text("{label}:{tone}:{count}") } }
}`;
  const ast = parseFoar(src);
  const { container } = makeDom();
  const rt = createFoarRuntime(ast, container, {});
  assert.deepEqual(q(container, '.f4-text').map((e) => e.textContent), ['a:gray:0', 'b:red:2']);
  rt.destroy();
  const { html } = renderToString(ast, {});
  assert.ok(html.includes('a:gray:0') && html.includes('b:red:2'), html);
});

test('contexts as modules: cross-context lets, dependency order, host call/getContext, innermost hotkey', async () => {
  // Shown is declared before Items but reads it: it must initialise after Items.
  const src = `context Shown {
    store query: String = "";
    let matching = Items.all.filter(|i| i.includes(query));
    effect Search(q: String) { query = q; }
}
context Items {
    store all: Vec<String> = ["apple", "banana"];
    effect Add(name: String) { all = [...all, name]; }
}
view App {
    use Shown;
    store closed: i32 = 0;
    state S {
        on_key("Escape") { closed = closed + 1; }
        render {
            Text(Shown.matching.len() + " of " + closed)
            Popup()
        }
    }
}
view Popup {
    store open: bool = true;
    state S {
        on_key("Escape") { open = false; transition Gone; }
        render { Text("popup") }
    }
    state Gone { render { Text("gone") } }
}`;
  const ast = parseFoar(src);
  const { window, container } = makeDom();
  const app = createFoarRuntime(ast, container, {});
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const text = () => q(container, '.f4-text').map((e) => e.textContent);
  assert.deepEqual(text(), ['2 of 0', 'popup'], 'Shown.matching sees Items at start');

  // host API: call a context effect, read a context
  app.call('Items.Add', 'apricot');
  app.call('Shown.Search', 'ap');
  await tick();
  assert.deepEqual(app.getContext('Shown').matching, ['apple', 'apricot']);
  assert.equal(text()[0], '2 of 0', "a let reading another context stays current");
  app.call('Items.Add', 'grape');
  await tick();
  assert.equal(text()[0], '3 of 0', 'Items changed, Shown.matching follows');
  assert.throws(() => app.call('Items.Nope'), /no context effect Items.Nope/);

  // Escape: the popup (innermost) handles it first, then the app
  const esc = () => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  esc();
  await tick();
  assert.deepEqual(text(), ['3 of 0', 'gone']);
  esc();
  await tick();
  assert.deepEqual(text(), ['3 of 1', 'gone']);
  app.destroy();

  // SSR: same order
  const { html, state } = renderToString(ast, {});
  assert.ok(html.includes('2 of 0'), html);
  assert.deepEqual(state.contexts.Items.all, ['apple', 'banana']);
});
