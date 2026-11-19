// Vite plugin for FOAR (.foar single- and multi-file projects) with HMR.
//
// Usage in vite.config.js:
//   import foar from 'foar/integrations/vite-plugin-foar.js';
//   export default { plugins: [foar()] };
//
// Then in main.js:
//   import { mount, hydrate, renderToString, renderToStream } from './app.foar';
//   mount(document.getElementById('app'));
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUNTIME = path.resolve(HERE, '../web/foar-runtime.js');
const DEFAULT_BIN = path.resolve(HERE, '../target/release/foar');

function resolveFoarBin(optBin) {
  if (optBin) return optBin;
  if (fs.existsSync(DEFAULT_BIN)) return DEFAULT_BIN;
  return 'foar';
}

function collectLocalImports(entryFile) {
  const seen = new Set();
  const stack = [entryFile];
  const root = path.dirname(entryFile);
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur) || !fs.existsSync(cur)) continue;
    seen.add(cur);
    const src = fs.readFileSync(cur, 'utf8');
    const re = /^\s*import\s+"([^"]+)"/gm;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (spec.startsWith('@')) continue;
      let target = spec.startsWith('.')
        ? path.resolve(path.dirname(cur), spec)
        : path.resolve(root, spec);
      if (!target.endsWith('.foar')) target += '.foar';
      if (fs.existsSync(target)) stack.push(target);
    }
  }
  const manifest = path.join(root, 'foar.toml');
  if (fs.existsSync(manifest)) seen.add(manifest);
  return [...seen];
}

export default function foarPlugin(options = {}) {
  const foarBin = resolveFoarBin(options.foarBin);
  const runtimePath = options.runtimePath || DEFAULT_RUNTIME;
  const hmr = options.hmr !== false;

  return {
    name: 'vite-plugin-foar',
    enforce: 'pre',

    transform(_code, id) {
      const cleanId = id.split('?')[0];
      if (!cleanId.endsWith('.foar')) return null;

      // Register transitive .foar imports + foar.toml so Vite triggers HMR on edits
      for (const dep of collectLocalImports(cleanId)) {
        if (dep !== cleanId) this.addWatchFile(dep);
      }

      let out;
      try {
        out = execFileSync(
          foarBin,
          ['build', cleanId, '--format', 'js', '--runtime', runtimePath],
          { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
        );
      } catch (err) {
        const msg = (err.stderr || err.stdout || err.message || String(err)).trim();
        this.error(`FOAR compile error in ${cleanId}:\n${msg}`);
      }

      if (!hmr) {
        return { code: out, map: null };
      }

      // Append state-preserving Vite HMR wrapper around mount() / hydrate().
      const hmrTrailer = `
const __f4ActiveMounts = new Set();
const __f4OrigMount = mount;
const __f4OrigHydrate = hydrate;

function __f4Track(rt, container, callbacks) {
  if (!rt) return rt;
  const rec = { rt, container, callbacks };
  __f4ActiveMounts.add(rec);
  const origDestroy = rt.destroy.bind(rt);
  rt.destroy = () => {
    __f4ActiveMounts.delete(rec);
    return origDestroy();
  };
  return rt;
}

export function mountHmr(container, callbacks = {}) {
  return __f4Track(__f4OrigMount(container, callbacks), container, callbacks);
}

export function hydrateHmr(container, callbacks = {}) {
  return __f4Track(__f4OrigHydrate(container, callbacks), container, callbacks);
}

if (import.meta.hot) {
  import.meta.hot.accept((nextMod) => {
    if (!nextMod || !nextMod.program) return;
    for (const rec of [...__f4ActiveMounts]) {
      const snap = rec.rt.getSnapshot();
      const curRoute = rec.rt.getRoute();
      const instances = {};
      for (const s of snap) instances[s.key] = { state: s.state, stores: s.stores };
      rec.rt.destroy();
      const nextRt = nextMod.mount(rec.container, {
        ...rec.callbacks,
        url: curRoute.path,
        initialState: { route: curRoute.path, instances },
      });
      rec.rt = nextRt;
    }
  });
}
`;
      return { code: `${out}\n${hmrTrailer}`, map: null };
    },
  };
}
