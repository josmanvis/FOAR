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

See [`examples/`](examples): `todo/` (sub-views, keyed lists, emitted events,
dynamic styles, split into components), `counter/` (async transitions) and
`starter/` (the smallest multi-file app).

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

## Files and imports

A program can be one file or many. The entry file's first view is the root;
other files join the program with `import`:

```foar
// app.foar
import "models"                        // models.foar, from the project root
import "components/list/NoteRow"       // .foar may be left out
import "./theme.foar"                  // ./ and ../ are relative to this file

view App { ... }
```

- Views, data types and named styles are **global by name**: an import says
  "this file is part of the program", not "bring these names into scope". A
  component file usually imports the files it uses, so it reads on its own.
- Each file is loaded once (shared and circular imports are fine). Order: the
  entry, then imports depth-first.
- Declaring a view or data type twice is an error, and so is using a view that
  no file in the program declares (usually a missing import).
- Errors name the file: `components/Toast.foar:40:1: Expected '}'`.
- The stylesheet is ordered by kind, not by file (`theme`, named styles,
  `@keyframes`, `css { }`, then view styles), so moving code between files never
  changes the cascade.

`foar build app.foar` / `foar check app.foar` follow imports from the file's
folder. In the browser, `compileFoarProject({ entry, files })` (WASM export
`f4_compile_project`, or `foar build - --project` with that JSON on stdin)
compiles a project held in memory and also returns `files`: each file in the
program and what it imports.

## Layout

```
FOAR/
├── src/                    the Rust compiler (native CLI + WebAssembly)
│   ├── lexer.rs parser.rs  tokens → AST; css.rs (styles), transpile.rs (Rust idioms → JS)
│   ├── project.rs          imports: multi-file programs, errors mapped to file:line:col
│   ├── i18n.rs             `foar i18n` catalog checker
│   ├── main.rs             CLI · wasm.rs: the WASM ABI · ast.rs: the program JSON
├── web/
│   ├── foar-runtime.js     the reactive DOM runtime (createFoarRuntime, createI18n)
│   ├── foar-compiler.js    runs the compiler in the browser (WASM, or the dev server)
│   ├── foar.wasm           built by `pnpm build:wasm` (git-ignored)
│   └── playground/         the browser IDE served at http://localhost:3000
│       ├── index.html  styles.css  playground.js   (preview, inspector, commands)
│       ├── workbench/      workspace (files, tabs, editor), layout, palette, search, find bar
│       └── language/       highlighting and the language service (completions, hover, …)
├── examples/               one folder per project: starter/, counter/, todo/
├── test/                   runtime tests (happy-dom) · bench/: interaction benchmark
├── server.js               zero-dependency playground server (/, /examples/index.json, /api/compile)
└── Cargo.toml  package.json
```

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

foar check examples/todo/app.foar
foar build examples/todo/app.foar --pretty            # program JSON
foar build examples/todo/app.foar --format js -o app.js
foar i18n locales app.foar host/*.js                 # check translation catalogs
```

### Playground

`http://localhost:3000` is a small IDE for FOAR projects:

- **Files**: a tree of the project's `.foar` files. New file / new folder (the
  buttons, or right-click), rename with F2, move by dragging onto a folder,
  duplicate, delete (asks first). A new file starts as a component named after
  it and is imported from the entry file; renaming or moving a file rewrites the
  imports that point at it; deleting one removes them. Files that nothing
  imports are shown dimmed ("not imported").
- **Editor**: syntax highlighting, a tab per open file (each keeps its own
  undo), auto-indent, Tab / Shift+Tab, Ctrl+/ to comment, Ctrl+Shift+D to
  duplicate lines, Ctrl/Cmd+click a view name or an import to open its file.
  Compile errors show in the tree, the tab and the gutter; click the error to
  jump to it. Clicking a view in the inspector opens its file too.
- **Saving**: examples and the Scratch project are kept in this browser
  (Revert restores an example). A running app opened with
  `?src=<url of its .foar entry>` is saved to disk with **Ctrl+S** if its dev
  server offers the project API below; the app then rebuilds and reloads, and
  files changed on disk by another editor flow into the playground.

- **Workbench**: an activity bar (Explorer, Search), a command center in the
  title bar, and toggles for the sidebar, preview, tools (state machines,
  compiled JS, AST) and zen mode. Every divider can be dragged, moved with the
  arrow keys or reset with a double-click; the layout is remembered. The status
  bar shows the project, save state, compile errors (click or F8 to jump),
  line/column and compile time.
- **Search**: quick open with fuzzy matching and recent files; project-wide
  search with match case / whole word / regex, include and exclude globs,
  results per file, and replace (one, per file, or all after a confirmation,
  with a preview of each change); find and replace in the open file with the
  matches marked in the text.

| Keys | |
|---|---|
| Ctrl+P | Go to file (`>` commands, `:` line, `@` symbol in file, `#` symbol in project) |
| Ctrl+Shift+P, F1 | Command palette |
| Ctrl+G · Ctrl+Shift+O · Ctrl+Alt+O | Go to line · symbol in file · symbol in project |
| Ctrl+F · Ctrl+H · F3 / Shift+F3 | Find · replace · next / previous match |
| Ctrl+Shift+F · Ctrl+Shift+H | Search in files · replace in files |
| Ctrl+B · Ctrl+Alt+B · Ctrl+J · Ctrl+K Z | Toggle sidebar · preview · tools · zen mode |
| Ctrl+Shift+E | Show explorer |
| Alt+N · Alt+Shift+N · F2 · Delete | New file · new folder · rename · delete (in the tree) |
| Ctrl+S | Save all |
| Alt+W · Alt+PageDown / PageUp | Close editor · next / previous editor |
| F8 | Go to the compile error |
| Ctrl+/ · Ctrl+Shift+D · Tab / Shift+Tab | Comment · duplicate line · indent / outdent |
| Ctrl/Cmd+click | Open the file that declares a view (or an import) |

(Cmd works for Ctrl on a Mac. Keys the browser keeps for itself, such as
Ctrl+W, Ctrl+T and Ctrl+Tab, have Alt-based equivalents.)

The project API a dev server can offer (notes-on-foar's `dev.mjs` does):

| Request | |
|---|---|
| `GET /__foar/project` | `{ entry, name, files: { path: source } }` |
| `PUT /__foar/files?path=…` | write a `.foar` file (body: source) |
| `DELETE /__foar/files?path=…` | delete a `.foar` file |
| `GET /__dev` | server-sent events; `reload` after a rebuild |

It should answer CORS only for the playground's origin, accept writes only
with a localhost `Host` header (DNS rebinding), and only for `.foar` paths
inside the project. Without it, the playground shows the single file and keeps
edits in the browser.

An app that needs its own host functions is shown running from its origin (or
`&app=<url>`); if it posts its runtime events to a localhost parent (as
notes-on-foar does), the inspector follows it live. The Example menu lists
Notes on FOAR under Apps, and a plain visit opens it when its dev server is
running (`?example=counter` or `?example=scratch` pick another project).

Without `web/foar.wasm` the playground compiles through the dev server, which
runs the native `foar` binary. Both paths use the same Rust compiler.
