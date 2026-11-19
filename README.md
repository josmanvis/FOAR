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
**states**, what each state shows, and which events it handles. **Tagged-union
enums with payloads**, generic `data<T>` / `enum<T>` / `view<T>`, **exhaustive
`match`**, a **static type checker** (including typed `extern fn` host bindings),
**Slots**, **Portals**, **error boundaries (`Catch`/`Fallback`)**, lifecycle
hooks (`on_enter`/`on_unmount`), a built-in **router**, **streaming & async
zero-DOM SSR + zero-recreation hydration**, `foar.toml` + `foar.lock`
**packages**, a **Rust LSP server**, **Vite HMR plugin**, and **VS Code
extension** ship in one **Rust compiler** (native + WebAssembly) targeting a
21 KB retained-DOM runtime with no virtual DOM.

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

- **Explicit state machines & lifecycle hooks.** A view is in exactly one state;
  effects belong to states; `transition Editing;` swaps only that view's
  subtree. Async work is a state with `on_exit`, plus `on_enter` and
  `on_unmount` hooks on states and views.
- **Tagged-union ADTs, generics & exhaustive `match`.** `enum LoadState<T> { Idle, Ready(T), Failed(String) }`
  and generic `data<T>` / `view<T>`. No fall-through and no `break`; payload
  destructuring (`Ready(user) => …`), literals, `a | b`, ranges, and guards work
  as values, statements, and in `render` (`Match`).
- **Composition, Portals & Error Boundaries.** Default & named `Slot()`
  outlets, `Portal(target: "#modal-root")` with delegated events and cleanup,
  and `Catch { … } Fallback { err => … }` boundaries across client and SSR.
- **Derived values without dependency lists.** `let open = items.filter(|t| !t.done).len();`
- **Compiled, retained DOM.** Bindings write only changed values, keyed lists
  reuse rows, and inputs keep focus. All static CSS is generated at build time.
- **Styling in the language.** Scoped CSS, themes, dark mode, nested
  `@hover`/`@media`, and `@state Editing { … }`.
- **i18n and accessibility.** `t(key, params)` with plurals and a catalog
  checker; `label:`, `role:`, `aria:` everywhere; clickable elements are
  keyboard-operable by default.
- **Static type checking & typed `extern fn`.** Stores, derived `let`s, generic
  `data` literals & fields, tagged-union payloads, view props, assignments,
  transitions, and declared `extern fn` host calls are checked at compile time
  with `file:line:col`.
- **Built-in routing, streaming SSR & hydration.** Declarative `Router` /
  `Route` / `Link` and `navigate()`, zero-DOM `renderToString`, async loaders
  (`renderToStringAsync`), Web `ReadableStream` streaming SSR (`renderToStream`),
  and zero-recreation `hydrate` that adopts server DOM nodes in place.
- **Packages, lockfiles & editor tooling.** `foar.toml` + SHA-256 `foar.lock`
  (`foar init` / `add` / `install` / `pkg --verify`), native Rust LSP server
  (`foar lsp`), Vite HMR plugin (`integrations/vite-plugin-foar.js`), VS Code
  extension (`editors/vscode/`), and the [browser playground](https://josmanvis.github.io/FOAR/playground/).

## Quick start

No install: open the [playground](https://josmanvis.github.io/FOAR/playground/).

Locally (Rust and Node):

```sh
git clone https://github.com/josmanvis/FOAR && cd FOAR
pnpm install
pnpm dev                       # site + playground on http://localhost:3000

cargo build --release          # the CLI: target/release/foar
foar check app.foar
foar build app.foar --format js -o dist/app.js
```

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
| [Why FOAR](docs/why.md) | the design, how it compares, and its current limits |
| [Examples](examples/README.md) | starter, counter, todo, orders, router, notes-on-foar |
| [Changelog](CHANGELOG.md) | release notes and recent milestones |

## Repository

```
src/                 the Rust compiler (lexer, parser, match/enums, typecheck, CSS, imports/lockfile, i18n, LSP, CLI, WASM)
web/foar-runtime.js  the DOM + SSR + streaming runtime (one module, ~21 KB gzipped, zero dependencies)
web/foar-compiler.js runs the compiler in the browser (WASM)
integrations/        Vite plugin with state-preserving HMR (vite-plugin-foar.js)
editors/vscode/      VS Code extension + TextMate grammar launching `foar lsp`
web/playground/      the browser IDE: workbench/ and language/ (the language service)
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

FOAR is still young: local, Git, and custom-registry `foar.toml` + `foar.lock`
packages work today without a hosted public central registry yet, and undeclared
JS host calls remain a gradual escape hatch. See [what FOAR is not (yet)](docs/why.md#what-foar-is-not-yet).

## License

[MIT](LICENSE)
