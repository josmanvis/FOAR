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
**states**, what each state shows, and which events it handles. Enums, an
**exhaustive `match`**, a **static type checker** (including typed `extern fn`
host bindings), a built-in **router**, **zero-DOM SSR + hydration**, and
`foar.toml` **packages** ship in one **Rust compiler** (native + WebAssembly)
targeting an 18 KB retained-DOM runtime with no virtual DOM.

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

- **Explicit state machines.** A view is in exactly one state; effects belong
  to states; `transition Editing;` swaps only that view's subtree. Async work
  is a state with an `on_exit`.
- **Enums and exhaustive `match`.** No fall-through and no `break`. Patterns
  cover literals, `a | b`, ranges, enum variants and guards. A match works as
  a value, as a statement, and in `render` (`Match`). Enum values compile to
  plain strings.
- **Derived values without dependency lists.** `let open = items.filter(|t| !t.done).len();`
- **Compiled, retained DOM.** Bindings write only changed values, keyed lists
  reuse rows, and inputs keep focus. All static CSS is generated at build time.
- **Styling in the language.** Scoped CSS, themes, dark mode, nested
  `@hover`/`@media`, and `@state Editing { … }`.
- **i18n and accessibility.** `t(key, params)` with plurals and a catalog
  checker; `label:`, `role:`, `aria:` everywhere; clickable elements are
  keyboard-operable by default.
- **Static type checking & typed `extern fn`.** Stores, derived `let`s, `data`
  literals & fields, view props, assignments, transitions, and declared
  `extern fn` host calls are checked at compile time with `file:line:col`.
- **Built-in routing & SSR + hydration.** Declarative `Router` / `Route` /
  `Link` and `navigate()`, zero-DOM `renderToString` (Node/Edge), and
  zero-recreation `hydrate` that adopts server DOM nodes in place.
- **Packages & multi-file programs.** `foar.toml` manifests, `import "@ui/Badge"`,
  and `foar init` / `foar add` / `foar pkg`.
- **A browser IDE.** The [playground](https://josmanvis.github.io/FOAR/playground/)
  runs the Rust compiler as WebAssembly and has completions, hover docs,
  diagnostics as you type, go to definition, references, rename, a formatter,
  project search, and a live state-machine inspector.

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

## Repository

```
src/                 the Rust compiler (lexer, parser, match/enums, CSS, imports, i18n checker, CLI, WASM ABI)
web/foar-runtime.js  the DOM runtime (one module, no dependencies)
web/foar-compiler.js runs the compiler in the browser (WASM)
web/playground/      the browser IDE: workbench/ and language/ (the language service)
web/index.html       the website's landing page; docs/ are rendered into it
examples/            example projects, one folder each
scripts/site.mjs     builds the static website (pnpm build:site)
test/ · bench/       runtime tests (happy-dom) · interaction benchmark
```

```sh
pnpm test          # Rust compiler tests + runtime tests
pnpm bench         # cost per interaction on the todo example
pnpm build:wasm    # web/foar.wasm (rustup target add wasm32-unknown-unknown)
pnpm build:site    # the static website in _site/ (deployed to GitHub Pages)
```

FOAR is still young: local/Git `foar.toml` packages work today without a hosted
public registry yet, and undeclared JS host calls remain a gradual escape hatch.
See [what FOAR is not (yet)](docs/why.md#what-foar-is-not-yet).

## License

[MIT](LICENSE)
