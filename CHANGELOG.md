# Changelog

All notable changes to FOAR are documented in this file.

## [0.2.0] — 2026-11-19

### Language & Compiler (Rust native + WebAssembly)
- **Static type checker (`src/typecheck.rs`)**: checks `store` initializers, derived `let` values (with closure parameter inference through `.filter`, `.map`, `.find`, `.reduce`), `data` struct literals (missing required fields, unknown fields with suggestions, field types), `.field` accesses, child view props, effect assignments, arithmetic operators, enum comparisons, `match` arm types, and `transition` target state names — with `file:line:col` diagnostics.
- **Typed `extern fn` host bindings**: top-level `extern fn name(a: Type) -> RetType;` declarations checked for argument count, argument types, and return types across the JavaScript boundary.
- **Enums & exhaustive `match`**: `enum Name { A, B = "b" }`, exhaustive `match` expressions/statements and render `Match(…)` with literals, `a | b`, ranges (`1..=9`), guards, and unreachable-arm detection; `If … Else If … Else`; derived `let`; loops (`for x in xs`, `for i in 0..n`, `while`, `loop`), `if let Some(x) = …`, `.len()`.
- **`foar.toml` packages & CLI**: package manifest resolution for `import "@pkg"` and `import "@pkg/Module"` (CLI, WASM, and browser playground language service), plus `foar init`, `foar add --path|--git`, and `foar pkg`.

### Runtime (`web/foar-runtime.js`, ~18 KB gzipped, zero dependencies)
- **Built-in Router**: declarative `Router`, `Route("/orders/:id") { params => … }`, `Link` (with `aria-current="page"` and unmodified click interception), reactive `route.{path, params, query, hash}`, and `navigate()` / `replace()` supporting `history`, `hash`, and `memory` modes.
- **Zero-DOM Server-Side Rendering**: `renderToString(program, { url, bindings, i18n })` returning `{ html, css, state, head }` with no DOM dependency (Node, Deno, Bun, Edge).
- **Zero-recreation Hydration**: `hydrate(program, container, callbacks)` restores serialized state from `<script id="__foar_state__">`, adopts `<style data-f4-ssr>`, and reuses existing server-rendered DOM nodes in place (`0` elements created on match).
- **Retained-DOM compiled blocks**: fine-grained binding updates, keyed `List` reconciliation, state-aware CSS (`@state`, `@hover`, `@media`, `@dark`), `i18n` with plurals/RTL, accessibility props, context menus, and drag-and-drop.

### Playground, Website & Examples
- **Browser IDE**: WebAssembly Rust compiler, completions, hover docs, go-to-definition (including `@package` imports), rename, formatter, state-machine inspector, and accessible Zen Mode exit (`Exit Zen Mode` header/status-bar controls, `Esc` exit, no sticky reload trap).
- **Examples**: added `router/` (declarative routes + `@ui/Badge` package), `orders/` (enums + exhaustive `match`), and `notes-on-foar/` (21-file macOS Notes clone running live in the playground with bundled host bindings and `en`/`es`/`de` locales).
- **Brand, Landing Page & Docs**: new geometric `4` logo, redesigned landing page with live interactive `Note.foar` state machine and exhaustive-match toggle, harmonized docs site with Light/Dark theme toggle, and GitHub Pages CI/CD.

## [0.1.0] — Initial prototype
- Initial `.foar` syntax, state-machine views, Rust compiler prototype, and basic browser playground.
