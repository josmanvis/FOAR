# Tooling

## The compiler

The compiler is written in Rust and builds two ways from the same source: a
native command-line tool, and a WebAssembly module (≈210 KB gzipped) that the
playground runs in the browser. Both compile the 21-file Notes app (≈2,000
lines) in about 30 ms.

```sh
cargo build --release              # target/release/foar
pnpm build:wasm                    # web/foar.wasm (needs: rustup target add wasm32-unknown-unknown)
```

### CLI

```sh
foar check app.foar                         # compile app.foar and its imports, report errors
foar build app.foar --pretty                # program JSON (for createFoarRuntime)
foar build app.foar --format js -o app.js   # ES module: { program, mount, createI18n }
foar build app.foar --format js --runtime ./foar-runtime.js -o dist/app.js
foar build - < app.foar                     # one source from stdin
foar build - --project < project.json       # {"entry", "files": {path: source}} from stdin
foar i18n locales/ app.foar host/*.js       # check translation catalogs
```

Errors name the file, line and column (`components/Row.foar:12:9: …`), and
`--format json` prints them as `{"error": {message, file, line, col}}` for
tools.

### i18n

`foar i18n <locales-dir> <sources…>` reads `<locale>.json` catalogs and the
`t("key")` / `t_key("key")` calls in `.foar` and `.js` files, and reports:

- keys used in code but missing from a locale;
- keys in a catalog that nothing uses;
- messages whose `{placeholders}` differ from the fallback locale;
- plurals without an `other` form.

`t("sort." + mode)` counts as a dynamic prefix, so `sort.*` keys aren't
reported as unused. It exits with status 1 when there are problems, so it can
run in CI.

## The runtime

`web/foar-runtime.js` is one ES module (≈13 KB gzipped) with no dependencies:
`createFoarRuntime(program, element, callbacks)` and `createI18n(config)`. See
the [reference](./language.md#host-functions-and-the-runtime).

## The playground

The [playground](../playground/) is a small IDE for FOAR projects, running the
Rust compiler as WebAssembly in your browser.

**Projects.** The examples (starter, counter, todo, orders) and a Scratch
project are kept in your browser; edits survive reloads and *Revert*
restores an example. Run locally next to an app's dev server and it can open
that app's project and **save to disk** (see [project API](#project-api)).

**Files.** A tree of the project's files: new file or folder, rename (F2), move
by dragging, duplicate, delete (it asks first). A new file starts as a
component named after it and is imported for you. Renaming or moving a file
rewrites the imports that point at it, and files nothing imports are dimmed.

**Editor.** Syntax highlighting, tabs, auto-indent and auto-closing brackets,
plus a language service:

- suggestions as you type and with Ctrl+Space, with docs: elements and views
  (parameters as tab stops), named arguments, the events of that element, the
  effects of the current state, states after `transition`, enum variants after
  `Status.`, named styles, CSS properties and values, `@rules`, theme
  variables, types, import paths;
- parameter hints, hover docs for every name;
- problems as you type: unknown states, effects that don't exist or belong to
  another state, unknown styles, enum variants or CSS variables, events an
  element never fires, missing imports, plus the compiler's own errors, all
  with "did you mean" suggestions;
- go to definition (F12, Ctrl+click), find references (Shift+F12), rename
  symbol (F2) across files, format document (Shift+Alt+F).

**Workbench.** Command palette (Ctrl+Shift+P), quick open (Ctrl+P, with `:`
for a line and `@`/`#` for symbols), search and replace across files
(Ctrl+Shift+F) with regex and include/exclude globs, find in file (Ctrl+F),
toggles for the sidebar (Ctrl+B), preview (Ctrl+Alt+B), tools (Ctrl+J) and
zen mode (Ctrl+K Z), resizable panes, a status bar.

**Inspector.** Every view's states and transitions, the state of each mounted
instance, live stores, an effect/transition log, the compiled JavaScript and
the AST. Click a state to force a transition, or a view to open its file.

| Keys | |
|---|---|
| Ctrl+P · Ctrl+Shift+P | go to file · command palette |
| Ctrl+Space · Ctrl+Shift+Space | suggestions · parameter hints |
| F12 · Shift+F12 · F2 | definition · references · rename |
| Shift+Alt+F | format document |
| F8 · Shift+F8 · Ctrl+Shift+M | next / previous problem · problems list |
| Ctrl+F · Ctrl+H · Ctrl+Shift+F | find · replace · search in files |
| Ctrl+B · Ctrl+Alt+B · Ctrl+J · Ctrl+K Z | sidebar · preview · tools · zen |
| Ctrl+S | save all (to disk, for a local app) |

Cmd works for Ctrl on a Mac. Keys the browser keeps for itself (Ctrl+W,
Ctrl+T, Ctrl+Tab) have Alt equivalents: Alt+W closes a tab, Alt+PageUp and
Alt+PageDown switch tabs.

### Run it locally

```sh
pnpm install
pnpm dev          # builds the compiler, serves http://localhost:3000
```

`/` is the site, `/playground/` the playground, `/docs/` these pages
(rendered from `docs/*.md`). `pnpm build:site` writes the same thing as static
files to `_site/`; the GitHub Pages workflow deploys that.

### Project API

A dev server can let the playground open and save its project by serving:

| Request | |
|---|---|
| `GET /__foar/project` | `{ entry, name, files: { path: source } }` |
| `PUT /__foar/files?path=…` | write a `.foar` file (body: source) |
| `DELETE /__foar/files?path=…` | delete a `.foar` file |
| `GET /__dev` | server-sent events; `reload` after a rebuild |

Answer CORS only for the playground's origin, accept writes only with a
localhost `Host` header (against DNS rebinding), and only for `.foar` paths
inside the project. Then open `http://localhost:3000/playground/?src=<url of
the app's entry .foar file>`: edits save with Ctrl+S, the app rebuilds and
reloads, and changes made in another editor flow back in.

## Tests

```sh
pnpm test        # Rust compiler tests + runtime tests (in happy-dom)
pnpm bench       # cost per interaction on the todo app with 3–2,000 items
```
