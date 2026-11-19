import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeDom, tick, fire, compile as parseFoar } from './dom.js';
import { createFoarRuntime } from '../web/foar-runtime.js';

const todoSrc = fs.readFileSync(new URL('../examples/TodoApp.foar', import.meta.url), 'utf8');
const counterSrc = fs.readFileSync(new URL('../examples/Counter.foar', import.meta.url), 'utf8');

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
