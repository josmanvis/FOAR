# Changelog

All notable changes to FOAR are documented in this file.

## Unreleased

### Website & identity
- New identity built on railway interlocking (a signal box makes conflicting routes impossible to set, as FOAR does for UI states): a turnout logo, Overpass type, a green-grey panel colour, one amber lamp for "the current state", signal red only for compiler errors. No purple, no gradients.
- The landing page's hero is now a real FOAR component (`web/hero/note.foar`), compiled at build time with the WebAssembly compiler and mounted on the runtime; a track diagram lights the current state and the transition that just ran.
- Landing, docs and playground restyled to match; docs table of contents no longer double-escapes `&`.

### Language
- **Prop defaults**: `view MenuItem(label: String, check: bool = false)`; a prop with a default (or of type `Option<T>`) is optional, the default is type-checked and applied on the client, on updates and in SSR.
- The compiler now rejects: missing required props; an event handler that isn't an effect of the state it's in (it would silently do nothing) or doesn't exist; `-> on_x` on a component that never emits `x`; match arms of different types; views named like a built-in element (`view Row` used to be silently ignored in favour of the built-in).
- Fixed: props named `label`, `title`, `role`, `id`… were not type-checked because built-in attribute names were checked first.

### Tooling
- `foar fmt` indents continuation lines (`.style(…)`, `-> on_click(…)`) and multi-line call arguments instead of flattening them, and tracks `(` as well as `{`/`[`. The playground's Format Document now uses the same formatter through WebAssembly (`f4_format`).
- Playground: compiler errors underline the whole word, the Problems list no longer shows a compiler error twice, and suggestions stay open for long lines.

## [0.2.0] — 2026-11-19

### Language & Compiler (Rust native + WebAssembly)
- **Shared reactive Contexts (`context` / `use`)**: top-level `context Auth { store ...; let ...; effect ... }` singletons subscribed via `use Auth;` in any view, supporting statically checked `Auth.field`, `Auth.Effect(...)`, direct event bindings `-> on_click(Auth.SignOut)`, SSR serialization, and `hydrate()` restoration.
- **Pure typed FOAR functions (`fn`)**: top-level `fn name(a: Type) -> RetType { … }` checked at declaration and call sites, callable from stores, derived `let`s, effects, expressions, and SSR without external JS.
- **Forms, native controls & state-scoped hotkeys**: `Form { … } -> on_submit(Save)` (auto-`preventDefault()`), `Select` + `Option`, `Slider`, `Progress`, universal reactive `disabled:`, `class:`, `id:`, and state-scoped `on_key("Escape")` / `on_key("Mod+K")` shortcuts that activate only while in their owning state.
- **Typed async transition results & errors**: `on_exit(result: Type) { … }` receives the resolved promise value and `on_error(err: String) { … }` handles rejections cleanly inside the loading state.
- **Partial Islands Hydration & CLI Formatter**: `Island(client: "load" | "visible" | "idle") { … }` + `hydrateIslands(root, program, callbacks)` for zero-JS static SSR shells with selective island hydration, plus deterministic Rust `foar fmt <files...> [--check]` (`src/fmt.rs`).
- **Tagged-union ADTs & generics**: `enum LoadState<T> { Idle, Loading, Ready(T), Failed(String) }` with payload constructors, qualified/bare payload destructuring in expression/statement `match` and render `Match`, plus generic `data<T>` / `enum<T>` / `view<T>` with full type-parameter substitution.
- **Composition, Portals, Lifecycle & Error Boundaries**: default and named `Slot()` / `Slot(name: "header")` with fallback content, `Portal(target: "#modal-root")` with delegated events and cleanup, `on_enter` and `on_unmount` lifecycle hooks on states and views, and `Catch { … } Fallback { err => … }` error boundaries with typed `CatchError`.
- **Static type checker (`src/typecheck.rs`)**: checks `store` initializers, derived `let` values (with closure parameter inference through `.filter`, `.map`, `.find`, `.reduce`), generic `data` struct literals & fields, tagged-union constructor payloads & destructured bindings, view props, assignments, arithmetic operators, enum comparisons, `match` arm types, and `transition` target state names — with `file:line:col` diagnostics.
- **Typed `extern fn` host bindings**: top-level `extern fn name(a: Type) -> RetType;` declarations checked for argument count, argument types, and return types across the JavaScript boundary.
- **Enums & exhaustive `match`**: `enum Name { A, B = "b" }`, exhaustive `match` expressions/statements and render `Match(…)` with literals, `a | b`, ranges (`1..=9`), guards, and unreachable-arm detection; `If … Else If … Else`; derived `let`; loops (`for x in xs`, `for i in 0..n`, `while`, `loop`), `if let Some(x) = …`, `.len()`.
- **`foar.toml` + SHA-256 `foar.lock` packages & CLI**: package manifest resolution for `import "@pkg"` and `import "@pkg/Module"`, deterministic pure-Rust SHA-256 integrity hashing, `foar init`, `foar add --path|--git|--version`, `foar install [--frozen]`, and `foar pkg [--verify]`.

### Runtime (`web/foar-runtime.js`, ~24 KB gzipped, zero dependencies)
- **Built-in Router**: declarative `Router`, `Route("/orders/:id") { params => … }`, `Link` (with `aria-current="page"` and unmodified click interception), reactive `route.{path, params, query, hash}`, and `navigate()` / `replace()` supporting `history`, `hash`, and `memory` modes.
- **Zero-DOM SSR, Async Loaders & Streaming SSR**: `renderToString(program, { url, bindings, i18n })`, `renderToStringAsync(program, { url, loaders, load })`, and `renderToStream(program, options)` returning a standard Web `ReadableStream` (Node, Deno, Bun, Edge).
- **Zero-recreation Hydration**: `hydrate(program, container, callbacks)` restores serialized state from `<script id="__foar_state__">`, adopts `<style data-f4-ssr>`, and reuses existing server-rendered DOM nodes in place (`0` elements created on match, including Slots).
- **Retained-DOM compiled blocks**: fine-grained binding updates, keyed `List` reconciliation, Slots, Portals, Catch/Fallback error boundaries, `on_enter`/`on_unmount` lifecycle hooks, state-aware CSS (`@state`, `@hover`, `@media`, `@dark`), `i18n` with plurals/RTL, accessibility props, context menus, and drag-and-drop.

### Editor, Build & Playground Tooling
- **Native Rust LSP Server (`foar lsp`, `src/lsp.rs`)**: JSON-RPC 2.0 stdio language server with real multi-file compiler diagnostics, context-aware completions (including `Enum.` variants), hover docs, and go-to-definition.
- **Vite Plugin with HMR (`integrations/vite-plugin-foar.js`)**: compiles `.foar` imports with transitive watch files and state-preserving `import.meta.hot` reloads.
- **VS Code Extension (`editors/vscode/`)**: TextMate syntax grammar (`syntaxes/foar.tmLanguage.json`), language configuration, and zero-dependency client launching `foar lsp`.
- **Browser IDE**: WebAssembly Rust compiler, completions, hover docs, go-to-definition (including `@package` imports), rename, formatter, state-machine inspector, and accessible Zen Mode exit (`Exit Zen Mode` header/status-bar controls, `Esc` exit, no sticky reload trap).
- **Examples**: upgraded `router/` (Fleet Console showcasing Router, Slots via `@ui/Panel`, Portals, Tagged-Union `ProbeState<i32>`, `on_enter`, `Catch`/`Fallback`, and verified `foar.lock`), plus `orders/` and `notes-on-foar/` (21-file macOS Notes clone).
- **Brand, Landing Page & Docs**: new geometric `4` logo, redesigned landing page with live interactive `Note.foar` state machine and exhaustive-match toggle, harmonized docs site with Light/Dark theme toggle, and GitHub Pages CI/CD.

## [0.1.0] — Initial prototype
- Initial `.foar` syntax, state-machine views, Rust compiler prototype, and basic browser playground.
