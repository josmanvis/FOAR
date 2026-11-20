import { launch } from './cdp.mjs';
import os from 'node:os';
import path from 'node:path';
const OUT = process.env.FOAR_E2E_OUT || path.join(os.tmpdir(), 'foar-e2e');
const BASE = process.env.FOAR_E2E_URL || 'http://localhost:3000';
const page = await launch({ profile: `${OUT}/chrome-pg4-${Date.now()}` });
const problems = [];
page.on((m) => { if (m.method === 'Runtime.exceptionThrown') problems.push(m.params.exceptionDetails.exception?.description); });
await page.goto(`${BASE}/playground/?example=scratch`);
await page.waitFor(`document.getElementById('compiler-status').textContent.includes('mounted')`, 15000);
const drag = (src, dst) => page.eval(`(() => {
  const dt = new DataTransfer();
  const s = document.querySelector(${JSON.stringify(src)}), d = document.querySelector(${JSON.stringify(dst)});
  s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  d.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
  d.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  s.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
})()`);
const state = async () => JSON.parse(await page.eval(`JSON.stringify({ files: [...document.querySelectorAll('.tree-row.file')].map(r => r.dataset.path), imports: [...document.querySelectorAll('.code-input')].map(t => t.value.match(/^import .*$/gm)).flat().filter(Boolean), status: document.getElementById('compiler-status').textContent.trim(), flash: document.querySelector('.explorer-foot').textContent })`));
// make a folder "ui", then move components/Greeting.foar into it
await page.click(`document.querySelector('button[aria-label="New folder"]')`);
await page.waitFor(`document.activeElement?.classList.contains('tree-input')`, 2000);
await page.eval(`document.activeElement.select()`); await page.type('ui'); await page.key('Enter'); await page.sleep(200);
await drag('[data-path="components/Greeting.foar"]', '[data-dir="ui"]'); await page.sleep(400);
console.log('file → folder:', JSON.stringify(await state()));
// move the whole folder ui into components
await drag('[data-dir="ui"]', '[data-dir="components"]'); await page.sleep(400);
console.log('folder → folder:', JSON.stringify(await state()));
// move back to the root (drop on app.foar, a root file)
await drag('[data-path="components/ui/Greeting.foar"]', '[data-path="app.foar"]'); await page.sleep(400);
console.log('file → root:', JSON.stringify(await state()));
await page.eval(`localStorage.removeItem('foar.playground.v1.scratch')`);
console.log(problems.join('\n') || 'no exceptions');
await page.close(); process.exit(0);
