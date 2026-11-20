# Changelog

All notable changes to FOAR are documented in this file.

## Unreleased

### Playground
- Edits to a bundled example no longer shadow newer versions of it. The playground kept the whole edited project in the browser and kept loading it after the example changed, so anyone who had touched the Notes example before its rewrite got a stale, broken mix. Saves now record the example version; edits made on an older one are set aside (the footer offers Restore / Discard) and the current example opens.
- Typing no longer makes the caret jump: Enter only takes a suggestion you asked for (typed part of a word, moved through the list, or pressed Ctrl+Space). A list that opened by itself after `,` or `:` used to swallow Enter and insert e.g. `label:` where you wanted a new line. No suggestions pop up inside strings (except import paths and `t("…")` keys).
- Saving while still typing no longer loses the newest keystrokes when the dev server reloads the project from disk.

### Language
- New errors for mangled arguments: `danger: hint: true` ("Two labels in a row"), the same prop given twice, and `name:` with no value.

## [0.3.5] — 2026-11-20

### Security
- Server rendering didn't check `data: { … }` and `aria: { … }` keys, so a key taken from user data (`data: attrs`) could inject HTML into the page. Keys that aren't plain attribute names are now skipped, on the server and in the browser (where `setAttribute` would have thrown).

### Fixed
- Modules from `foar build --format js` and `foar dev` failed to load ("Unexpected reserved word") when any string in the app contained `package`, `enum`, `public`, `private`, `protected`, `interface`, `implements`, `eval` or `arguments`: the precompiled module declared a `const` for each word.
- Fine-grained updates (0.3.x) skipped views whose inputs hadn't changed, including views that call host functions, so a host function whose result changes on its own (a clock, host state) showed a stale value. Views that call an undeclared host function now re-evaluate on every update; declaring it with `extern fn` marks it pure and keeps the fast path.
- `|x| { ...x, done: true }` and other closures returning an object literal compiled to a JavaScript block and returned `undefined`; they now return the object.
- The release workflow fails when the installers' fallback version doesn't match the tag being released.

## [0.3.4] — 2026-11-19

### Performance (DOM Runtime)
- **Per-AST-node execution plans, static literal fast-paths, lazy effect helpers & Set-free `List` reconciliation (11–15% faster over v0.3.3, 28–47% faster over v0.3.1)**:
  - `nodePlanCache` (`WeakMap`) precomputes static style classification (`sc`, `scCls`), attribute presence (`hasCommonAttrs`, `dataAttrs`), event presence (`hasEvents`), and `hasAutofocus` once per AST node, allowing elements without optional attributes or events to bypass attribute/event setup in a single check.
  - `staticStringLiteral` detects compile-time string literals on `Text` and `Button` (`"Edit"`, `"Delete"`) and writes `el.textContent` directly on mount without reactive binding, expression compilation, or `safeEval`, while static leaf elements return a shared `{ el, deps: EMPTY_SET, update: NOOP, dispose: NOOP }` descriptor without per-node closure allocations.
  - `inst.helpers` (`[__transition, __emit, __asyncTransition]`) is now allocated lazily inside `runEffect` only when an effect executes on an instance, eliminating 6,000 closure allocations on a 2,000-row mount.
  - `mountList` replaces its per-reconcile `seen` `Set` and `rows` `Map` deletion scan with an integer generation stamp (`listGen` / `row.seen === gen`) and skips the DOM cursor walk entirely on pure filter/delete updates (`!mountedNewRow && !survivingReordered`).
  - `runEffect` skips redundant pre-effect `computeDerived(inst)` calls when no local or context stores are dirty (`!inst.dirtyVars && pendingGlobalChanges.size === 0`), cutting derived evaluations in half per interaction.

## [0.3.3] — 2026-11-19

### Performance (DOM Runtime & Type Checker)
- **Single-pass `class` & batched dynamic `style` attribute writes (15–46% faster mounts & filters)**:
  - `mountElement` now combines base element classes and static style classes (`withCls`) into a single `el.className` assignment on creation instead of mutating `className` twice per element (eliminating 8,000 duplicate `setAttribute("class")` calls on a 2,000-row list).
  - Elements with dynamic styles (`sc.dynamic`) now batch multi-property style evaluations (`flushStyle`) into a single serialized `setAttribute("style", cssText)` write per update, avoiding intermediate `CSSStyleDeclaration` parses and cutting dynamic-style mount costs by **7×**.
  - `mountList` appends initial unhydrated rows directly on creation (skipping the 2,000-node `insertBefore(n, null)` reconciliation pass on initial mount), and `mountState` / `Row` / `Column` use preallocated arrays and cached index strings (`IDX_STR`).
- **Type-checker scope reuse & import prescan (`src/typecheck.rs`, `src/project.rs`)**:
  - Pass 2 of `typecheck::check` reuses the active `Checker` and variable scope across consecutive `RenderExpr` and `ViewCall` items within the same `(view, locals)` scope and precomputes `view_defaults`, and `imports_in` skips lexing files without `"import"`.

## [0.3.2] — 2026-11-19

### Performance (Compiler & DOM Runtime)
- **Rust / WebAssembly compiler (2.9× faster)**: added fast substring guards and zero-allocation `Cow` rewrites in `rust_idioms_to_js` / `string_literal_to_js` (`src/transpile.rs`) and literal fast-paths in `src/typecheck.rs`, cutting 26-file Notes app WebAssembly compilation from **35 ms → 12 ms** (**66% faster**) and native `foar check` from **38 ms → 11 ms** (**71% faster**).
- **Retained-DOM runtime (15–30% faster mounts & list updates)**:
  - Per-view precompiled store initializers (`meta.storeInits`), host class strings (`meta.hostClassName`), and view-scoped expression lookup (`meta.compile`) eliminate repeated scope-key joins on hot mount paths.
  - Per-AST-node `ownDeps` caching (`nodeOwnDepsCache` `WeakMap`), direct `setAttribute` data attribute writes on view hosts, and single-write `className` assignment on unhydrated mounts cut 500–2,000-row mount times by **15–24%**.
  - Keyed `List` prefix-match and $O(1)$ tail-append fast paths skip `Map`/`Set`/key-allocation passes and DOM cursor walks when existing rows remain in order, improving keystroke and item-append throughput by **15–18%**.

## [0.3.1] — 2026-11-19

### Language & Runtime
- **Custom `data-*` attributes**: every element, `List` container, and sub-view call accepts `data: { test_id: "save", row_index: i }` (`snake_case` keys become `data-kebab-case`; `null` or `false` removes the attribute) as well as direct `data_<name>: value` shorthands (`data_testid: "save-btn"` → `data-testid="save-btn"`), on both client DOM and zero-DOM SSR (`renderToString`).
- **Node handle primitive (`Host`) & media/graphics elements**: built-in `Host(name: "chart") { … }` with `callbacks.onMount(el, info)`, `callbacks.onUnmount(el, info)`, and `app.getHost(name)` (firing `onMount` only after `el` is connected in the live DOM), plus native `Video`, `Canvas`, and `Svg` elements.
- **Ahead-of-time CSP-safe JS modules (`foar build --format js`)**: precompiles all render expressions, initializers, effects, and pure `fn` declarations into static module functions (`attachPrecompiled`) so production builds execute with zero `new Function()` calls under `Content-Security-Policy: script-src 'self'`.
- **Dirty-subtree skipping & `List` `moveBefore()`**: caches expression dependency sets (`depsCache`) and sub-view prop evaluators (`subViewPropCache`), skips unchanged sibling subtrees and unchanged `List` rows/sub-views in $O(1)$, and uses `el.moveBefore()` where available when reordering connected list rows.
- **External store pushes (`app.setContext`)**: `app.setContext(name, patchOrUpdaterFn)` atomically updates writable context stores, recomputes derived `let`s across contexts, batches DOM updates, and returns the updated context snapshot.
- **Installer resilience (`install.sh` / `install.ps1`)**: 3-tier latest-release tag lookup (HTTP redirect → GitHub Releases API → embedded release fallback) plus Apple Silicon ad-hoc codesign refresh on macOS.

## [0.3.0] — 2026-11-19

### Install & CLI
- **One-line install** with prebuilt binaries for macOS, Linux and Windows (x64 and arm64), published to GitHub Releases by `.github/workflows/release.yml`:
  `curl -fsSL https://josmanvis.github.io/FOAR/install.sh | sh` or, in PowerShell, `irm https://josmanvis.github.io/FOAR/install.ps1 | iex`. The installers verify the SHA-256, install to `~/.foar/bin`, and make `foar` usable at once (a link from a directory already on PATH, or the shell profile / user PATH). `--version`, `--dir`, `--no-modify-path`, `--uninstall`.
- `foar` works with nothing else installed: the runtime is built into the binary.
  - `foar init` scaffolds `app.foar`, `index.html`, `foar.toml`, `.gitignore`.
  - `foar dev` serves the project with live reload; compile errors show in the page and the terminal.
  - `foar build` in a project writes `dist/` (index.html, app.js, foar-runtime.js); `foar build x.foar --format js -o out/app.js` writes the runtime beside the module and creates `out/`.
  - `foar upgrade [version]` reinstalls in place.

### Website & identity
- New identity built on railway interlocking (a signal box makes conflicting routes impossible to set, as FOAR does for UI states): a turnout logo, Overpass type, a green-grey panel colour, one amber lamp for "the current state", signal red only for compiler errors. No purple, no gradients.
- The landing page's hero is now a real FOAR component (`web/hero/note.foar`), compiled at build time with the WebAssembly compiler and mounted on the runtime; a track diagram lights the current state and the transition that just ran.
- Landing, docs and playground restyled to match; docs table of contents no longer double-escapes `&`.

### Language
- **Contexts as the app's stores.** A context can read and call other contexts (type-checked); its `let`s stay current when the contexts they read change; contexts initialise in dependency order. A view must `use` the contexts it reads, and `-> on_click(Ctx.Effect)` is checked (context, `use`, effect name).
- Hosts: `app.call('Library.Trash', id)` runs a context effect, `app.getContext('Library')` reads one.
- `clics += 1` where the store is `clicks` is now a compile error ("isn't a store of view V (did you mean 'clicks'?)") instead of silently writing nowhere.
- Hotkeys: the innermost `on_key` wins, so a menu or dialog handles Escape before the view around it.
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
