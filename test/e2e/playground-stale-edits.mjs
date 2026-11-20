// Edits to a bundled example are kept in the browser. When the example itself
// changes, old edits must not shadow it: the new version opens, the old
// edits are set aside and can be restored.
import os from 'node:os';
import path from 'node:path';
import { launch } from './cdp.mjs';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
const KEY = 'foar.playground.v1.example:counter';

const page = await launch({ profile: `${OUT}/chrome-stale-${Date.now()}` });
let pass = 0;
let fail = 0;
const step = async (name, fn) => {
  try {
    const r = await fn();
    pass++;
    console.log(`✓ ${name}${r ? `  — ${r}` : ''}`);
  } catch (e) {
    fail++;
    console.log(`✗ ${name}: ${e.message.split('\n')[0]}`);
  }
};
const ok = (c, msg) => {
  if (!c) throw new Error(msg);
};
const state = () =>
  page.eval(`JSON.stringify({ preview: document.getElementById('f4-mount').textContent, foot: [...document.querySelectorAll('button')].map(b => b.textContent).filter(t => /Restore them|Discard|Revert/.test(t)) })`).then(JSON.parse);
const open = async () => {
  await page.goto(`${BASE}/playground/?example=counter`);
  await page.waitFor(`document.getElementById('compiler-status').textContent.includes(' file')`, 15000);
  await page.sleep(400);
};

try {
  await open();
  // what an older playground saved: no record of which example version it was made on
  const stale = { files: { 'app.foar': 'view Old {\n    state S {\n        render {\n            Text("stale edit")\n        }\n    }\n}\n' } };
  await page.eval(`localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(stale))})`);

  await step('an edit made on an older version is set aside: the current example opens', async () => {
    await open();
    const s = await state();
    ok(!s.preview.includes('stale edit') && s.foot.includes('Restore them'), JSON.stringify(s));
    return s.foot.join(', ');
  });
  await step('Restore brings the earlier edits back, and they stay after a reload', async () => {
    await page.click(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Restore them')`);
    await page.waitFor(`document.getElementById('f4-mount').textContent.includes('stale edit')`, 8000);
    await open();
    const s = await state();
    ok(s.preview.includes('stale edit') && s.foot.includes('Revert'), JSON.stringify(s));
  });
  await step('Revert returns to the current example', async () => {
    await page.click(`[...document.querySelectorAll('button')].find(b => b.textContent === 'Revert')`);
    await page.waitFor(`!document.getElementById('f4-mount').textContent.includes('stale edit')`, 8000);
    await page.eval(`localStorage.clear()`);
  });
} catch (e) {
  fail++;
  console.log(`✗ setup: ${e.message.split('\n')[0]}`);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await page.close?.();
  process.exit(fail ? 1 : 0);
}
