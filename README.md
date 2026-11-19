# FOAR

A state-machine UI language. UIs are state machines, so a FOAR `view` declares
its states explicitly instead of juggling boolean flags:

```foar
view AsyncCounter {
    store count: i32 = 0;
    style { layout: vertical; gap: 16px; }

    state Initial {
        render { Button("Start") -> on_click(Begin) }
        effect Begin() { transition Active; }
    }
    state Active {
        render {
            Text("Count: {count}").style({ font-size: 24px; })
            Row { Button("-") -> on_click(Dec)  Button("+") -> on_click(Inc) }
        }
        effect Inc() { count += 1; }
        effect Dec() { count -= 1; }
    }
}
```

See `examples/` for the full `TodoApp.foar` (sub-views, keyed lists, events,
emitted events, dynamic styles) and `Counter.foar` (async transitions).

## Architecture

```
 .foar ──► Rust compiler (src/) ──► program JSON (+ one stylesheet) ──► JS runtime ──► DOM
            native CLI `foar`            or an ES module (--format js)
            or WebAssembly (web/foar.wasm) in the browser
```

The **compiler is Rust** (lexer: `logos`; hand-written recursive-descent
parser; CSS compiler; Rust-idiom → JS transpiler). It builds as a native CLI
and as a `wasm32` module the playground loads. The **runtime is JavaScript**
on purpose: WebAssembly cannot touch the DOM except through JS calls, so a
WASM runtime driving the DOM is slower, not faster.

## Layout

| Path | What |
|---|---|
| `src/` | The Rust compiler: `lexer.rs`, `parser.rs`, `css.rs`, `transpile.rs`, `ast.rs`, CLI `main.rs`, WASM ABI `wasm.rs` |
| `web/foar-runtime.js` | The reactive DOM runtime (`createFoarRuntime`) |
| `web/foar-compiler.js` | Browser front-end: runs the Rust compiler as WASM (or via the dev server), plus playground helpers |
| `web/playground.js`, `web/index.html` | Browser playground: editor, live preview, state-machine inspector |
| `server.js` | Zero-dependency static server for the playground (`pnpm dev`) |
| `test/` | Runtime test suite (`pnpm test`, runs in happy-dom) |
| `bench/` | Interaction benchmark (`pnpm bench`) |

## Styling

Style blocks are real CSS (any property, `calc()`, `var()`, gradients,
transitions, animations) plus a few SCSS-style conveniences. Everything is
compiled to one stylesheet; generated classes and attributes use the `f4-` prefix.

```foar
// Global custom properties (:root), with a dark-mode override.
theme {
    --accent: #007bff;
    --radius: 6px;
    @dark { --accent: #4da3ff; }
}

// Reusable named style (like an SCSS mixin / utility class).
style Field {
    padding: 10px;
    border-radius: var(--radius);
    @focus { border-color: var(--accent); }
}

@keyframes slide-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: none; }
}

// Escape hatch: raw CSS, emitted verbatim.
css { .f4-text b { color: var(--accent); } }

view Meter {
    store level: i32 = 30;
    style {
        --level: {level}%;                       // reactive custom property
        background: linear-gradient(90deg, var(--accent) var(--level), #eee 0);
        animation: slide-in .2s ease-out;
        @hover { filter: brightness(1.1); }      // any pseudo: @focus-within, @nth-child(2n)...
        @state Hot { outline: 2px solid red; }   // only while the view is in state Hot
        @media (max-width: 600px) { padding: 4px; }
    }
    state Cool {
        render {
            Text("{level}%").style(Field, { color: level > 50 ? red : inherit; })
            Input(value: "").style(Field)
        }
    }
}
```

| Syntax | Compiles to |
|---|---|
| `theme { --x: v; }` | `:root { --x: v }` |
| `style Name { }` / `.style(Name)` / `.style(Name, { … })` | shared class `f4-Name`, composed with local overrides |
| `@use Name;` inside a block | also apply `f4-Name` |
| `@hover`, `@focus`, `@active`, `@nth-child(…)`, any pseudo | `:hover` … |
| `@state S { }` | rule active while the view is in state `S` (`[data-state-name]`) |
| `@media (…) { }`, `@dark { }`, `@light { }` | media queries (nestable) |
| `@keyframes name { }` | top-level or inside a style block |
| `prop: {expr}` / `prop: cond ? a : b` | runtime binding (only changed values are written) |
| `--var: {expr}` | reactive CSS custom property on the element |
| dynamic value inside `@hover`/`@state`/`@media` | routed through a generated custom property |
| `css { … }` | verbatim CSS |
| `layout: horizontal \| vertical`, `align: …` | flexbox shorthands |

## Runtime design

The runtime is **compiled and retained**, not virtual-DOM based:

- Every render node is compiled once into a block that owns real DOM nodes and
  a list of *bindings* (text, value, checked, dynamic style). An update
  re-evaluates bindings and writes to the DOM only when a value changed.
- A state transition replaces only that view's subtree. Nothing else is touched.
- `List` reconciles by key (`item.id`, then `item.key`, then index): rows are
  reused, moved with `insertBefore`, and disposed when they leave.
- All static CSS is generated at compile time into one stylesheet. Only
  dynamic values (`{expr}` / `cond ? a : b`) are touched at runtime.
- Expressions and effects compile to functions once and are cached.
- One delegated listener per event type on the mount container.
- Store writes are batched: any number of effects in one tick → one flush
  (microtask). Inputs are never re-created, so cursor, selection, scroll and
  CSS transitions survive updates.

### API

```js
import { compileFoar } from './web/foar-compiler.js';   // Rust compiler (WASM)
import { createFoarRuntime } from './web/foar-runtime.js';

const rt = createFoarRuntime(await compileFoar(source), mountEl, {
  bindings: { api_save: async (count) => fetch('/save', { body: count }) }, // external async calls
  asyncDelay: 1400,  // simulated latency when a binding is missing
  badges: false,     // dev-only per-view state badges
  onRender(snapshot) {}, onEffect(info) {}, onTransition(info) {}, onEmit(info) {},
});
rt.getSnapshot();                       // [{ key, viewName, state, stores, props }]
rt.invokeEffect('root', 'Increment');   // programmatic effect
rt.forceStateTransition('root', 'Active');
rt.flush();                             // synchronous update
rt.destroy();
```

An `api_name(args) -> transition(State);` statement calls `bindings.api_name`
(if provided), moves to `State`, and runs that state's `on_exit` when the
promise settles.

Ahead-of-time: `foar build app.foar --format js -o app.js` produces an ES module
exporting `{ program, mount(container, callbacks) }`.

## Develop

```sh
pnpm install
pnpm dev          # cargo build --release, playground at http://localhost:3000
pnpm build:wasm   # compile the compiler to web/foar.wasm (needs the wasm32 target)
pnpm test         # cargo test + runtime tests
pnpm bench

foar check examples/TodoApp.foar
foar build examples/TodoApp.foar --pretty            # program JSON
foar build examples/TodoApp.foar --format js -o app.js
```

Without `web/foar.wasm` the playground compiles through the dev server, which
runs the native `foar` binary. Both paths use the same Rust compiler.
