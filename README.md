<p align="center"><img src="web/favicon.svg" width="72" height="72" alt="FOAR logo"></p>

<h1 align="center">FOAR</h1>

<p align="center"><strong>Interfaces are state machines. Write them that way.</strong></p>

<p align="center">
  <a href="https://josmanvis.github.io/FOAR/">Website</a> ·
  <a href="https://josmanvis.github.io/FOAR/playground/">Playground</a> ·
  <a href="https://josmanvis.github.io/FOAR/docs/">Guide</a> ·
  <a href="https://josmanvis.github.io/FOAR/docs/language.html">Reference</a> ·
  <a href="https://josmanvis.github.io/FOAR/docs/why.html">Why FOAR</a>
</p>

FOAR is a language for user interfaces. Every component declares its
**states**, what each state shows, and which events it handles. **Shared
reactive `context`**, pure typed **`fn`** functions, **tagged-union enums with
payloads**, generic `data<T>` / `enum<T>` / `view<T>`, **exhaustive `match`**,
a **static type checker** (including typed `extern fn`), **Slots**, **Portals**,
**error boundaries (`Catch`/`Fallback`)**, **state-scoped `on_key` hotkeys**,
typed async **`on_exit(res)` / `on_error(err)`**, native **`Form`/`Select`/`Slider`/`Progress`**,
a built-in **router**, **streaming & async zero-DOM SSR + zero-recreation full
& partial-islands hydration (`Island`/`hydrateIslands`)**, `foar.toml` +
SHA-256 `foar.lock` **packages**, a **Rust LSP server**, **CLI formatter (`foar fmt`)**,
**Vite HMR plugin**, and **VS Code extension** ship in one **Rust compiler**
(native + WebAssembly) targeting a 25 KB retained-DOM runtime with no virtual DOM.

```rust
enum Status { Draft, Review, Published }

view Article {
    store status: Status = Status.Draft;
    store title: String = "Untitled";

    state Viewing {
        render {
            Text(title).style({ font-size: 22px; font-weight: 700; })
            Match(status) {
                Draft => Button("Send for review") -> on_click(Advance),
                Review => Button("Publish") -> on_click(Advance),
                Published => Text("Live ✓"),
            }
            Button("Rename") -> on_click(Rename)
        }
        effect Advance() {
            status = match status {
                Status.Draft => Status.Review,
                Status.Review | Status.Published => Status.Published,
            };
        }
        effect Rename() { transition Editing; }
    }

    state Editing {
        render {
            Input(value: title, autofocus: true) -> on_input(Type) -> on_enter(Done)
        }
        effect Type(text: String) { title = text; }
        effect Done() { transition Viewing; }
    }
}
```

Add a fourth `Status` and both `match`es stop compiling until they handle it:

```text
article.foar:10:13: This match doesn't handle Status.Archived (add an arm for it or `_ => …`)
```

## What you get

- **Explicit state machines, hotkeys & lifecycle hooks.** A view is in exactly
  one state; effects belong to states; `transition Editing;` swaps only that
  view's subtree. Async transitions pass resolved values to `on_exit(res)` and
  rejections to `on_error(err)`, alongside `on_enter`, `on_unmount`, and
  state-scoped keyboard shortcuts (`on_key("Escape") { … }`).
- **Contexts: your app's stores, one per file.** `context Library { store ...; let ...; effect ... }`
  holds a slice of app data and every operation on it; views `use Library;` and call
  `Library.Trash(id)` directly, contexts call each other, and all of it is type-checked.
  Plus typed pure functions (`fn format_usd(c: i32) -> String { … }`) that run the same in SSR.
- **Tagged-union ADTs, generics & exhaustive `match`.** `enum LoadState<T> { Idle, Ready(T), Failed(String) }`
  and generic `data<T>` / `view<T>`. No fall-through and no `break`; payload
  destructuring (`Ready(user) => …`), literals, `a | b`, ranges, and guards work
  as values, statements, and in `render` (`Match`).
- **Composition, Forms, Portals & Error Boundaries.** Default & named `Slot()`,
  `Form -> on_submit`, `Select`/`Option`, `Slider`, `Progress`, reactive
  `disabled:`/`class:`/`id:`, `Portal(target: "#modal-root")`, and
  `Catch { … } Fallback { err => … }` boundaries across client and SSR.
- **Derived values without dependency lists.** `let open = items.filter(|t| !t.done).len();`
- **Compiled, retained DOM.** Bindings write only changed values, keyed lists
  reuse rows, and inputs keep focus. All static CSS is generated at build time.
- **Styling in the language.** Scoped CSS, themes, dark mode, nested
  `@hover`/`@media`, and `@state Editing { … }`.
- **i18n and accessibility.** `t(key, params)` with plurals and a catalog
  checker; `label:`, `role:`, `aria:` everywhere; clickable elements are
  keyboard-operable by default.
- **Static type checking & typed `extern fn`.** Stores, derived `let`s, pure
  `fn`s, `context` fields & effects, generic `data` literals & fields,
  tagged-union payloads, view props, assignments, transitions, and declared
  `extern fn` host calls are checked at compile time with `file:line:col`.
- **Built-in routing, streaming SSR & partial islands hydration.** Declarative
  `Router` / `Route` / `Link` and `navigate()`, zero-DOM `renderToString`, async
  loaders (`renderToStringAsync`), Web `ReadableStream` streaming SSR
  (`renderToStream`), zero-recreation `hydrate`, and `Island(client: "visible" | "idle" | "load")`
  with `hydrateIslands`.
- **Packages, lockfiles, formatter & editor tooling.** `foar.toml` + SHA-256
  `foar.lock` (`foar init` / `add` / `install` / `pkg --verify`), `foar fmt`,
  native Rust LSP server (`foar lsp`), Vite HMR plugin
  (`integrations/vite-plugin-foar.js`), VS Code extension (`editors/vscode/`),
  and the [browser playground](https://josmanvis.github.io/FOAR/playground/)
  with full-viewport standalone app runner.

## Install

macOS and Linux:

```sh
curl -fsSL https://josmanvis.github.io/FOAR/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://josmanvis.github.io/FOAR/install.ps1 | iex
```

One binary, nothing else needed: the compiler, the runtime and a dev server.
Prebuilt for x64 and arm64; the installer checks the download's SHA-256 and
puts `foar` on your PATH. `foar upgrade` updates it. Or download an archive
from [Releases](https://github.com/josmanvis/FOAR/releases).

No install at all: the [playground](https://josmanvis.github.io/FOAR/playground/).

## Quick start

```sh
foar init my-app && cd my-app
foar dev                       # http://localhost:5173, reloads on save
foar build                     # dist/: index.html, app.js, foar-runtime.js
```

Other commands: `foar check app.foar`, `foar fmt`, `foar build app.foar --format js -o dist/app.js`
(see [Tooling](docs/tooling.md)).

```js
import { mount } from './dist/app.js';
mount(document.getElementById('app'), {
  bindings: { save_note: async (note) => { /* … */ } }, // host functions, callable from .foar code
});
```

## Learn

| | |
|---|---|
| [Guide](docs/guide.md) | from a counter to a multi-file app, in fifteen minutes |
| [Language reference](docs/language.md) | views, states, render, effects, enums, `match`, styles, i18n, runtime API |
| [Tooling](docs/tooling.md) | the CLI, the playground and its keys, dev servers, tests |
| [Why FOAR](docs/why.md) | the design, how it compares, and architectural trade-offs |
| [Examples](examples/README.md) | starter, counter, todo, orders, router, notes-on-foar |
| [Changelog](CHANGELOG.md) | release notes and recent milestones |

## Build from source

```sh
git clone https://github.com/josmanvis/FOAR && cd FOAR
cargo build --release          # target/release/foar
pnpm install && pnpm dev       # site + playground on http://localhost:3000
```

## Repository

```
src/                 the Rust compiler (lexer, parser, match/enums, typecheck, CSS, imports/lockfile, i18n, LSP, CLI, WASM)
web/foar-runtime.js  the DOM + SSR + streaming + islands runtime (one module, ~25 KB gzipped, zero dependencies)
web/foar-compiler.js runs the compiler in the browser (WASM)
integrations/        Vite plugin with state-preserving HMR (vite-plugin-foar.js)
editors/vscode/      VS Code extension + TextMate grammar launching `foar lsp`
web/playground/      the browser IDE: workbench/, language/, and full-viewport app runner (app.html)
web/index.html       the website's landing page; docs/ are rendered into it
examples/            example projects, one folder each
scripts/site.mjs     builds the static website (pnpm build:site)
test/ · bench/       runtime + LSP + Vite + lockfile tests · interaction benchmark
```

```sh
pnpm test          # Rust compiler tests + runtime, LSP, Vite & lockfile tests
pnpm bench         # cost per interaction on the todo example
pnpm build:wasm    # web/foar.wasm (rustup target add wasm32-unknown-unknown)
pnpm build:site    # the static website in _site/ (deployed to GitHub Pages)
```

For architectural trade-offs and roadmap items (a hosted central public package registry), see [trade-offs & roadmap](docs/why.md#trade-offs-and-roadmap).

## License

[MIT](LICENSE)
