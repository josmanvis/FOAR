# Why FOAR

## Interfaces are state machines

A save button is idle, saving, saved or failed. A list row is shown, being
edited, being dragged or showing a menu. A form is pristine, invalid,
submitting, or done. Designers draw these as states and arrows; users
experience them as states.

Most UI code doesn't write them as states. It writes them as **flags**:

```js
const [editing, setEditing] = useState(false);
const [saving, setSaving] = useState(false);
const [error, setError] = useState(null);
const [menuOpen, setMenuOpen] = useState(false);
```

Four booleans describe sixteen combinations, and most of them are nonsense:
editing *and* saving, a menu open over an error. Every render then has to
reconstruct the real state from the flags (`saving ? … : error ? … : editing
? … : …`), and every handler has to guard against the combinations it can't
handle. That's where a large share of UI bugs come from: states nobody
designed, reached by an order of events nobody tested.

## FOAR makes the states the code

```foar
view Note {
    store text: String = "";

    state Viewing {
        render { Text(text) Button("Edit") -> on_click(Edit) }
        effect Edit() { transition Editing; }
    }
    state Editing {
        render { Input(value: text) -> on_input(Type)  Button("Save") -> on_click(Save) }
        effect Type(t: String) { text = t; }
        effect Save() { save_note(text) -> transition(Saving); }
    }
    state Saving {
        render { Spinner("Saving…") }
        on_exit { transition Viewing; }
    }
}
```

- A view is in **exactly one state**. Impossible combinations can't be
  written, so they can't happen.
- Each state declares **what it shows** and **which events it handles**.
  `Save` exists only while `Editing`; there is no "save while saving" bug to
  guard against, because there is no handler for it.
- Async work is a state (`Saving`), entered when the call starts and left
  when it settles, not a flag set in one place and cleared in another.
- The structure is **visible**. The playground draws every view's states and
  transitions from the source, and shows which state each instance is in
  while you click around.

This is the idea behind statecharts and libraries like XState. FOAR makes it
the syntax of the UI language itself, so it costs nothing to use and there
is no second model to keep in sync with the components.

## The compiler checks the cases

`switch` falls through unless you remember `break`, and when you add a case
to a union, nothing tells you about the `switch` statements that don't handle
it. FOAR has enums and a `match` that **must be exhaustive**:

```foar
enum Payment { Card, Transfer, Invoice }

let fee = match method {
    Payment.Card => 0.29,
    Payment.Transfer => 0,
};
```

```text
checkout.foar:3:11: This match doesn't handle Payment.Invoice (add an arm for it or `_ => …`)
```

There is no fall-through; an arm that can never run is an error; patterns
cover literals, alternatives, ranges and guards; and `match` works as a value,
as a statement, and in `render`. Enum values compile to plain strings, so the
safety costs nothing at runtime or in your data.

The same attitude runs through the compiler and the editor: unknown views,
states, effects, styles, enum variants, CSS variables and imports are
reported before the code runs, with the file, line and a "did you mean".

## Fast by construction

FOAR doesn't diff a virtual DOM. The compiler turns every element into a
block that owns its real DOM nodes and a list of **bindings**: this text node
shows `count`, this input's value is `draft`, this element's color is
`done ? gray : inherit`. An update re-evaluates the bindings and writes only
values that changed.

- Typing in a field of a 500-row list re-evaluates bindings and creates
  **zero** elements; nothing is re-rendered and compared. (≈2 ms per
  keystroke in the [benchmark](./tooling.md#tests), which runs in happy-dom, a
  JavaScript DOM that is much slower than a browser's.)
- A state transition replaces one view's subtree. `If` and `Match` swap DOM
  only when the branch changes. `List` reuses rows by key.
- All static CSS is generated at compile time into one stylesheet; only
  dynamic values are touched at runtime.
- Inputs are never re-created, so focus, selection, scroll and CSS
  transitions survive every update.
- The runtime is one dependency-free module of ≈18 KB gzipped (including the
  router, zero-DOM SSR, client hydration, i18n, and accessibility helpers).

## One language for the whole interface

| | |
|---|---|
| **Static typing** | checks `store` initializers, `let` derived values, `data` struct literals & fields, view props, assignments, transitions, and typed `extern fn` host calls at compile time |
| **Routing** | declarative `Router`, `Route("/orders/:id")`, `Link`, reactive `route`, and `navigate()` / `replace()` with History, Hash, and memory modes |
| **SSR & hydration** | zero-DOM `renderToString(program, { url })` on Node/Deno/Bun/Edge and zero-recreation `hydrate(program, el)` that adopts server DOM nodes in place |
| **Packages** | `foar.toml` manifests, `@pkg/Module` imports, and `foar init` / `foar add` / `foar pkg` CLI commands |
| **Styling** | real CSS, scoped per element, with themes, dark mode, `@hover`/`@media` nesting, and `@state Editing { … }` for styles that follow the state machine |
| **Accessibility** | `label:`, `role:`, `aria: {…}` on any element; clickable rows become keyboard-operable buttons by default |
| **i18n** | `t(key, params)` with plurals everywhere; a checker that finds missing and unused keys |
| **Interaction** | context menus at the pointer, drag and drop with a payload, keyed lists |
| **Tooling** | a Rust compiler that runs natively and as WebAssembly; a browser IDE with completions, diagnostics, rename and a formatter |

## How it compares

| | React | Svelte | Elm | FOAR |
|---|---|---|---|---|
| Component state | flags in hooks | variables | one model + messages | **explicit states** per view |
| Showing a branch | `cond && …`, ternaries | `{#if}`, `{#each}` | `case` | `Match`, `If`/`Else`, `List` |
| Exhaustive branching | opt-in via TypeScript | — | yes | **yes** (enums, bools) |
| Type checking | external (TypeScript) | external (TS) | built-in | **built-in** (stores, data, props, effects, `extern fn`) |
| Routing & SSR | external framework (Next/Remix) | SvelteKit | Elm Land | **built-in** (`Router`, `renderToString`, `hydrate`) |
| Derived values | `useMemo` + dependency list | `$derived` | functions of the model | `let` (no dependencies to list) |
| Updates | virtual DOM diff | compiled, fine-grained | virtual DOM diff | compiled bindings, retained DOM |
| Styling | external / CSS-in-JS | scoped `<style>` | external / elm-css | in the language, state-aware |
| Compiler | Babel / TS (JS) | JS | Haskell | **Rust**, native + WASM |

FOAR takes Elm's best idea (exhaustive pattern matching), Svelte's
(compile the framework away), and XState's (UI as a state machine), and puts
them in one small language.

## What FOAR is not (yet)

Honesty about the remaining limits:

- **No central public package registry yet.** Projects can declare local path
  and Git dependencies in `foar.toml` and import `@pkg/Module`, but there is no
  hosted registry like npm or crates.io yet.
- **Gradual typing at the JS boundary.** `extern fn` declarations are statically
  checked on every call, and FOAR code is typechecked across stores, data
  literals, fields, view props, and assignments — but undeclared JS host
  functions and `any` annotations remain a gradual escape hatch, and FOAR does
  not yet have user-defined generic views or algebraic data types with payloads.
- **Synchronous SSR.** `renderToString` and `hydrate` run synchronously with
  zero DOM dependency and adopt existing DOM nodes in place, but streaming
  suspense SSR and partial islands hydration are not built yet.

If those trade-offs work for you, [try it in the playground](https://josmanvis.github.io/FOAR/playground/)
or read the [guide](./guide.md).
