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

## Elements

| Element | Arguments | Events |
|---|---|---|
| `Text(expr)` | | `on_click`, `on_double_click`, `on_context_menu` |
| `Button(label)` | | `on_click`, … |
| `Input(value:, placeholder:, autofocus:, secure:)` | `secure: true` = password field | `on_input(text)`, `on_enter`, `on_blur(text)` |
| `TextArea(value:, placeholder:, autofocus:)` | | `on_input(text)`, `on_blur(text)` |
| `RichText(value:, placeholder:, editable:, autofocus:)` | contenteditable; `value` is HTML | `on_input(html)` |
| `Image(src:, alt:)` | hidden while `src` is empty | `on_click`, … |
| `Checkbox(checked:)` | | `on_change(bool)` |
| `Spinner(label)` | | |
| `Row { … }`, `Column { … }` | | `on_click`, `on_double_click`, `on_context_menu` |
| `If(cond) { … }` | mounts children while `cond` is truthy | |
| `List(items, empty: "…") { item => … }` | keyed by `item.id` / `item.key`; takes `role:`, `label:`, `aria:` | `on_context_menu`, … |
| `SomeView(prop: expr)` | sub-view | `on_<emitted event>` |

Every element also accepts `title:` (tooltip). Events are delegated and the
**innermost handler wins**: a button inside a clickable row does not also
trigger the row.

`on_context_menu` suppresses the browser menu and its effect receives the
pointer position `{ x, y }` (from the keyboard: just below the element).
Shift+right-click is left to the browser.

### Accessibility

| Argument | Result |
|---|---|
| `label: expr` | `aria-label` |
| `role: expr` | `role` (e.g. `"listbox"`, `"option"`, `"menu"`, `"dialog"`) |
| `aria: { selected: x, expanded: y, … }` | `aria-*` attributes; `null` removes one, `snake_case` becomes `kebab-case` |
| `tab_index: expr` | `tabindex` (roving tabindex: `tab_index: selected ? 0 : -1`) |

A `Button` with `title:` and no `label:` uses the title as its accessible name
(icon buttons). Clickable `Row`/`Column`/`Text` get `tabindex=0`, `role=button`
and Enter/Space activation unless you say otherwise. `RichText` is a
`role=textbox` with `aria-multiline`.

### Drag and drop

```foar
Row(drag: note.id, drag_text: note.title) { … }             // draggable; payload + text/plain for other apps
Row { … } -> on_drop(MoveHere).style({ @drop-over { outline: 2px solid blue; } })
effect MoveHere(id: any) { … }                               // receives the payload
```

While dragging, the source has class `f4-drag-source` (`@drag-source {}`) and
the hovered target `f4-drop-over` (`@drop-over {}`); the mount container has
`f4-dragging`. Drags from outside the app (files) are left alone.

### i18n

Every expression and effect can call `t(key, params)`:

```foar
Text(t("list.count", { count: notes.length }))   // "3 notes" / "3 notas"
toast = { key: t_key("toast.deleted") };          // keep a key as data, translate when shown
Text(t(toast.key))
```

```json
{ "list.count": { "one": "{count} note", "other": "{count} notes" }, "toast.deleted": "Note deleted" }
```

Messages use `{name}` placeholders (numbers are formatted for the locale). A
message object is a plural, picked with `Intl.PluralRules` from
`params.count` (`zero` is used for 0 when present). Lookup goes locale →
base language → fallback. `rt.setLocale("es")` re-renders everything in one
flush and sets `lang`/`dir` (RTL languages) on the mount.

`foar i18n locales/ app.foar host/*.js` checks the catalogs against the
source: missing keys per locale, unused keys, placeholders that differ from
the fallback locale and plurals without `other`; `t("sort." + s)` counts as a
dynamic prefix. It exits non-zero on problems, so it can run in CI.

Inside a view, its own props and stores shadow host functions of the same name.

Inside a view, its own props and stores shadow host functions of the same name.

See [notes-on-foar](../notes-on-foar) for a complete app.

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
| `@use Name;` inside a block | also apply `f4-Name` (also through named styles: `style Primary { @use Button; }`) |
| `@hover`, `@focus`, `@active`, `@nth-child(…)`, any pseudo | `:hover` … |
| `@drop-over { }`, `@drag-source { }` | drag-and-drop states (classes set by the runtime) |
| `@reduced-motion { }` | `@media (prefers-reduced-motion: reduce)` |
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
import { createFoarRuntime, createI18n } from './web/foar-runtime.js';

const i18n = createI18n({ locale: 'en', fallback: 'en', messages: { en, es } }); // or pass the config itself
const rt = createFoarRuntime(await compileFoar(source), mountEl, {
  i18n,              // shared with host code: i18n.t(key, params)
  bindings: { api_save: async (count) => fetch('/save', { body: count }) }, // external async calls
  asyncDelay: 1400,  // simulated latency when a binding is missing
  badges: false,     // dev-only per-view state badges
  onRender(snapshot) {}, onEffect(info) {}, onTransition(info) {}, onEmit(info) {},
});
rt.getSnapshot();                       // [{ key, viewName, state, stores, props }]
rt.invokeEffect('root', 'Increment');   // programmatic effect
rt.forceStateTransition('root', 'Active');
rt.setLocale('de');                     // switch language, re-render
rt.flush();                             // synchronous update
rt.destroy();
```

Every function in `bindings` is also callable by name from `.foar` code: store
initializers, render expressions and effects
(`store notes = load_notes();`, `Text(fmt_date(note.updated))`, `persist(notes);`).

An `api_name(args) -> transition(State);` statement calls `bindings.api_name`
(if provided), moves to `State`, and runs that state's `on_exit` when the
promise settles.

Ahead-of-time: `foar build app.foar --format js -o app.js` produces an ES module
exporting `{ program, mount(container, callbacks), createI18n }`.

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
foar i18n locales app.foar host/*.js                 # check translation catalogs
```

Open any app's source in the playground with
`http://localhost:3000/?src=<url of the .foar file>`. It is compiled there
(AST, compiled JS, state machines); an app that needs its own host functions
is shown running from its origin (or `&app=<url>`), and if that app posts its
runtime events to a localhost parent (as notes-on-foar does), the state
machine and store inspector follow it live.

The Example menu lists Notes on FOAR (`localhost:4400`) under Apps, and a plain
visit to the playground opens it when its dev server is running; otherwise the
bundled examples load (`?example=Counter.foar` picks one).

Without `web/foar.wasm` the playground compiles through the dev server, which
runs the native `foar` binary. Both paths use the same Rust compiler.
