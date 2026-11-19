// FOAR runtime benchmark: cost per user interaction on TodoApp with N todos.
// Runs in happy-dom (a JS DOM: no layout/paint, element construction is much
// more expensive than a browser's). Treat the numbers as relative, and the
// "elements created" column as the real work metric.
//   pnpm bench
import fs from 'node:fs';
import { makeDom, tick, fire, compile as parseFoar } from '../test/dom.js';
import { createFoarRuntime } from '../web/foar-runtime.js';

const src = fs.readFileSync(new URL('../examples/TodoApp.foar', import.meta.url), 'utf8');
const withTodos = (n) => {
  const items = Array.from({ length: n }, (_, i) => `{id:"t${i}",text:"item ${i}",completed:${i % 2 === 0}}`).join(',');
  return src.replace(/store todos: Vec<Todo> = \[[\s\S]*?\];/, `store todos: Vec<Todo> = [${items}];`);
};

async function scenario(n, iters) {
  const { window, document, container } = makeDom();
  let created = 0;
  const realCreate = document.createElement.bind(document);
  document.createElement = (...a) => { created++; return realCreate(...a); };
  const ast = parseFoar(withTodos(n));
  const t0 = performance.now();
  const rt = createFoarRuntime(ast, container, {});
  const rows = [['mount', (performance.now() - t0).toFixed(2), created]];
  const inputs = () => container.querySelectorAll('.f4-input');
  const run = async (name, fn) => {
    await tick(); created = 0;
    const t = performance.now();
    for (let i = 0; i < iters; i++) { await fn(i); await tick(); }
    rows.push([name, ((performance.now() - t) / iters).toFixed(2), Math.round(created / iters)]);
  };
  await run('keystroke (same result set)', async (i) => { const s = inputs()[0]; s.value = 'item' + (i % 2 ? ' ' : ''); fire(window, s, 'input'); });
  await run('keystroke (filter 19% / all)', async (i) => { const s = inputs()[0]; s.value = i % 2 ? '9' : ''; fire(window, s, 'input'); });
  { const s = inputs()[0]; s.value = ''; fire(window, s, 'input'); await tick(); }
  await run('toggle checkbox', async () => { const b = container.querySelector('.f4-checkbox'); b.checked = !b.checked; fire(window, b, 'change'); });
  await run('edit + save item', async () => {
    const row = container.querySelector('.f4-view-TodoItem');
    fire(window, row.querySelector('.f4-button'), 'click'); await tick();
    const inp = row.querySelector('.f4-input'); inp.value = 'renamed'; fire(window, inp, 'input');
    fire(window, inp, 'keydown', { key: 'Enter' });
  });
  await run('add item', async () => { const d = inputs()[1]; d.value = 'x'; fire(window, d, 'input'); fire(window, container.querySelector('.f4-row .f4-button'), 'click'); });
  rt.destroy();
  return rows;
}

for (const n of [3, 100, 500, 2000]) {
  const rows = await scenario(n, n >= 500 ? 10 : 30);
  console.log(`\nTodoApp, ${n} todos   ${'ms/op'.padStart(10)}   elements created/op`);
  for (const [name, ms, created] of rows) console.log(`  ${name.padEnd(30)} ${ms.padStart(8)}   ${String(created).padStart(8)}`);
}
