// FOAR compiler front-end (browser + Node ESM).
// The compiler itself is Rust (src/). This module runs it:
//   1. as WebAssembly (web/foar.wasm, built with `pnpm build:wasm`), or
//   2. via the dev server's POST /api/compile, which runs the native binary.
// Plus helpers for the playground: state-machine extraction and a JS preview.

let wasmPromise = null;
// next to this module, so the site works under any base path (e.g. GitHub Pages /FOAR/)
const DEFAULT_WASM = new URL('./foar.wasm', import.meta.url).href;
const DEFAULT_API = new URL('./api/compile', import.meta.url).href;

async function loadWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`no ${url} (${res.status})`);
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  return instance.exports;
}

function compileWithWasm(x, source, fn = 'f4_compile') {
  const bytes = new TextEncoder().encode(source);
  const ptr = x.f4_alloc(bytes.length);
  new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
  const out = x[fn](ptr, bytes.length);
  x.f4_free(ptr, bytes.length);
  const len = new DataView(x.memory.buffer).getUint32(out, true);
  const json = new TextDecoder().decode(new Uint8Array(x.memory.buffer, out + 4, len));
  x.f4_free(out, len + 4);
  return JSON.parse(json);
}

/** Which backend is compiling: 'wasm' | 'native' (resolved after first compile). */
export let compilerBackend = null;

/**
 * Compiles .foar source with the Rust compiler. Resolves to the program
 * object for createFoarRuntime; rejects with a SyntaxError carrying
 * `line`/`col` on compile errors.
 */
export async function compileFoar(source, { wasmUrl = DEFAULT_WASM, apiUrl = DEFAULT_API } = {}) {
  if (!wasmPromise) wasmPromise = loadWasm(wasmUrl).catch(() => null);
  const wasm = await wasmPromise;
  let result;
  if (wasm) {
    compilerBackend = 'wasm';
    result = compileWithWasm(wasm, source);
  } else {
    compilerBackend = 'native';
    const res = await fetch(apiUrl, { method: 'POST', body: source, headers: { 'Content-Type': 'text/plain' } });
    result = await res.json();
  }
  if (result.error) {
    const e = new SyntaxError(`${result.error.message} (line ${result.error.line}:${result.error.col})`);
    e.line = result.error.line;
    e.col = result.error.col;
    throw e;
  }
  return result;
}

/**
 * Compiles a multi-file project `{ entry, files: { path: source } }` (imports
 * resolved as in src/project.rs). Resolves to the program plus `files`: the
 * files in the program and what each imports. Compile errors reject with a
 * SyntaxError carrying `file`, `line`, `col`.
 */
export async function compileFoarProject(project, { wasmUrl = DEFAULT_WASM, apiUrl = DEFAULT_API } = {}) {
  if (!wasmPromise) wasmPromise = loadWasm(wasmUrl).catch(() => null);
  const wasm = await wasmPromise;
  const input = JSON.stringify({ entry: project.entry, files: project.files });
  let result;
  if (wasm?.f4_compile_project) {
    compilerBackend = 'wasm';
    result = compileWithWasm(wasm, input, 'f4_compile_project');
  } else {
    compilerBackend = 'native';
    const res = await fetch(apiUrl, { method: 'POST', body: input, headers: { 'Content-Type': 'application/json' } });
    result = await res.json();
  }
  if (result.error) {
    const { message, file, line, col } = result.error;
    const e = new SyntaxError(file ? `${file}:${line}:${col}: ${message}` : `${message} (line ${line}:${col})`);
    Object.assign(e, { file, line, col, reason: message });
    throw e;
  }
  return result;
}

/**
 * Formats .foar source with the compiler's formatter (the same rules as
 * `foar fmt`), or resolves to null when the WebAssembly compiler isn't available.
 */
export async function formatFoarSource(source, { wasmUrl = DEFAULT_WASM } = {}) {
  if (!wasmPromise) wasmPromise = loadWasm(wasmUrl).catch(() => null);
  const wasm = await wasmPromise;
  if (!wasm?.f4_format) return null;
  const bytes = new TextEncoder().encode(source);
  const ptr = wasm.f4_alloc(bytes.length);
  new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  const out = wasm.f4_format(ptr, bytes.length);
  wasm.f4_free(ptr, bytes.length);
  const len = new DataView(wasm.memory.buffer).getUint32(out, true);
  const text = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, out + 4, len).slice());
  wasm.f4_free(out, len + 4);
  return text;
}

export function extractStateMachines(ast) {
  return ast.views.map((view) => {
    const states = view.states.map((s) => s.name);
    const initialState = states[0] || null;
    const transitions = [];

    for (const st of view.states) {
      for (const eff of st.effects) {
        for (const tr of eff.transitions) {
          transitions.push({
            from: st.name,
            to: tr.target,
            via: eff.name,
            async: tr.async,
          });
        }
      }
      if (st.onExit) {
        for (const tr of st.onExit.transitions) {
          transitions.push({
            from: st.name,
            to: tr.target,
            via: 'on_exit',
            async: true,
          });
        }
      }
    }

    return {
      viewName: view.name,
      params: view.params,
      stores: view.stores,
      states,
      initialState,
      transitions,
    };
  });
}

export function generateReadableJS(ast) {
  const lines = [
    '// ✨ Compiled by FOAR Browser Compiler (State-Machine UI -> Reactive DOM)',
    'const random_uuid = () => crypto.randomUUID().slice(0, 8);',
    '',
  ];

  for (const d of ast.dataDecls) {
    lines.push(`// data ${d.name} { ${d.fields.map((f) => `${f.name}: ${f.fieldType}`).join(', ')} }`);
  }
  if (ast.dataDecls.length) lines.push('');

  for (const view of ast.views) {
    const paramList = view.params.map((p) => p.name).join(', ');
    lines.push(`export function create${view.name}View({ ${paramList} } = {}) {`);
    lines.push(`  let __state = ${JSON.stringify(view.states[0]?.name || 'Initial')};`);
    for (const st of view.stores) {
      lines.push(`  let ${st.name} = ${st.initExpr};`);
    }
    lines.push('');
    lines.push('  const states = {');
    for (const st of view.states) {
      lines.push(`    ${st.name}: {`);
      for (const eff of st.effects) {
        const effParams = eff.params.map((p) => p.name).join(', ');
        lines.push(`      ${eff.name}(${effParams}) {`);
        lines.push(`        ${eff.jsBody}`);
        lines.push('      },');
      }
      if (st.onExit) {
        lines.push('      on_exit() {');
        lines.push(`        ${st.onExit.jsBody}`);
        lines.push('      },');
      }
      lines.push('    },');
    }
    lines.push('  };');
    lines.push('  return { getState: () => __state, states };');
    lines.push('}');
    lines.push('');
  }

  return lines.join('\n');
}

export { createFoarRuntime } from './foar-runtime.js';
