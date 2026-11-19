# Language reference

A FOAR program is one or more `.foar` files. This page describes everything
they can contain. For a gentler introduction, read the [guide](./guide.md).

## Files and declarations

At the top level of a file:

| Declaration | Meaning |
|---|---|
| `import "path"` | make another file part of the program |
| `view Name(params) { … }` | a component (the entry file's first view is the root) |
| `data Name { field: Type, … }` | a record type |
| `enum Name { A, B = "b", C = 3 }` | a closed set of named values |
| `style Name { … }` | a reusable named style |
| `theme { --var: value; … }` | CSS custom properties on `:root` |
| `@keyframes name { … }` | a CSS animation |
| `css { … }` | raw CSS, copied as is |

Comments are `// line` and `/* block */`.

### Imports

```foar
import "models"                      // models.foar, from the project root
import "components/list/NoteRow"     // ".foar" may be left out
import "./Badge.foar"                // ./ and ../ are relative to this file
```

Views, data types, enums and named styles are **global by name**: an import
says "this file is part of the program", it does not bring names into scope.
Each file is loaded once; shared and circular imports are fine. Declaring the
same view, data type or enum twice is an error, and so is using a view that no
file declares (usually a missing import).

## Views

```foar
view NoteRow(note: Note, selected: bool) {
    store menu_open: bool = false;            // data owned by this view
    let title = note.title == "" ? "New note" : note.title;   // derived value

    style { layout: horizontal; gap: 8px; }   // styles the view's own element

    state Idle { … }                          // the first state is the initial one
    state Menu { … }
}
```

| Member | |
|---|---|
| parameters | `view Name(a: Type, b: Type = default)`: values from the parent, read-only. A parameter with a default, or of type `Option<T>`, is optional; every other one must be passed |
| `store name: Type = value;` | mutable data, kept across renders and state changes |
| `let name = expr;` | a **derived value**: recomputed before every update and every effect, read-only |
| `style { … }` | styles for the view's host element |
| `state Name { … }` | a state: `render`, effects and `on_exit` |

Types are names: `String`, `bool`, `i32`, `i64`, `f64`, `any`, `Vec<T>`,
`Option<T>`, your `data` and `enum` types. The compiler checks them (see
[static type checking](#static-type-checking-and-extern-fn)).

```foar
view MenuItem(label: String, check: bool = false, hint: String = "") { … }

MenuItem(label: "Rename")                     // check is false, hint is ""
MenuItem(label: "Pin", check: pinned)
```

A default is used whenever the prop isn't given, or its value is `undefined`,
both in the browser and in server rendering. A view can't take the name of a
built-in element (`Row`, `Text`, `List`, …).

### States

```foar
state Editing {
    render { … }                     // what this state shows
    effect Save() { … }              // handlers, only while in this state
    on_exit { … }                    // after an async transition resolves (see below)
}
```

A view is always in exactly one state. Effects belong to a state, and an
element's `-> on_click(Save)` must name an effect of the state it appears in:
anything else is a compile error (with "did you mean"), because at runtime it
would silently do nothing. Moving between states (`transition Name;`)
replaces only this view's subtree.

## Render

A `render` block is a list of elements:

```foar
Text("Hello {name}")
Button("Save", title: "Save the note") -> on_click(Save)
Row {
    Input(value: query, placeholder: "Search") -> on_input(Search)
    Spinner("Loading…")
}.style({ gap: 8px; })
```

| Element | Arguments | Events (effect receives) |
|---|---|---|
| `Text(text)` | | `on_click`, `on_double_click`, `on_context_menu({x, y})`, `on_drop(payload)`, drag events |
| `Button(text)` | | `on_click`, `on_double_click`, `on_context_menu`, `on_drop`, `on_blur` |
| `Input(value:, placeholder:, secure:, autofocus:)` | `secure: true` is a password field | `on_input(text)`, `on_enter`, `on_blur(text)`, `on_change` |
| `TextArea(value:, placeholder:, autofocus:)` | | `on_input(text)`, `on_blur(text)`, `on_change` |
| `Checkbox(checked:)` | | `on_change(bool)` |
| `RichText(value:, placeholder:, editable:)` | contenteditable; the value is HTML | `on_input(html)`, `on_blur`, `on_context_menu`, `on_drop` |
| `Image(src:, alt:)` | hidden while `src` is empty | `on_click`, `on_drop` |
| `Spinner(text)` | | |
| `Row { … }`, `Column { … }` | flex row / column | `on_click`, `on_double_click`, `on_context_menu`, `on_drop`, drag events |
| `List(items, empty: …) { item => … }` | one block per item, keyed | `on_context_menu`, `on_drop` |
| `If(cond) { … } Else If(c) { … } Else { … }` | shows one branch | |
| `Match(value) { pattern => … }` | shows one arm, see [match](#match) | |
| `ViewName(param: value, …)` | a sub-view | `on_<event>` for each `emit <event>` |

Every element also takes:

| Argument | |
|---|---|
| `title: text` | tooltip; for a `Button` without `label:`, also its accessible name |
| `label: text` | `aria-label` |
| `role: text` | ARIA role (`"listbox"`, `"option"`, `"menu"`, …) |
| `aria: { expanded: open, current: sel ? "page" : null }` | `aria-*` attributes; `null` removes one; `snake_case` becomes `kebab-case` |
| `tab_index: n` | `tabindex` (e.g. a roving tabindex: `selected ? 0 : -1`) |
| `drag: payload`, `drag_text: text` | draggable; the payload goes to the drop target's `on_drop` |
| `autofocus: cond` | focus when it appears |

Clickable `Row`, `Column` and `Text` get `tabindex=0`, `role=button` and
Enter/Space activation automatically. Events are delegated, and the innermost
handler wins: a button inside a clickable row doesn't also trigger the row.

### Strings

`"Hello {name}"` and `"{note.title}"` interpolate a name or a dotted path. For
anything more complex, compute it in a `let` or concatenate:
`"Total: " + total.toFixed(2)`.

### Lists

```foar
List(notes.filter(|n| n.pinned), empty: "No pinned notes", role: "listbox") { note =>
    NoteRow(note: note)
}
```

Rows are keyed by `item.id` (then `item.key`, then position). When the list
changes, existing rows are kept and moved; only new items mount and only
removed items unmount. Inputs inside rows keep their focus and selection.

### If and Else

```foar
If(results.len() == 0) {
    Text("No results")
} Else If(results.len() == 1) {
    Text("One result")
} Else {
    Text("{results.length} results")
}
```

`If` and `Match` have no box of their own (`display: contents`), so they can't
be styled; style the elements inside them.

## Effects

```foar
effect Rename(text: String) {
    draft = text;
    if draft.is_empty() { return; }
    note.title = draft;
    emit renamed(note.id);
    transition Idle;
}
```

An effect runs when its event fires and receives the event's value (the text
of an input, the payload of a drop, the value a child emitted). It can assign
stores, call host functions, `emit` to the parent and `transition`.

Effect code is a small Rust-flavoured language that compiles to JavaScript:

| Write | Means |
|---|---|
| `transition Editing;` | go to another state of this view |
| `emit pick(id);` | send `pick` to the parent (`-> on_pick(Effect)`) |
| `api(args) -> transition(State);` | go to `State` now, call the async host function `api`, run `State`'s `on_exit` when it settles |
| `let x = 1;` / `let mut copy = item;` | a local; `let mut` makes a deep copy |
| `if a > b { … } else if c { … } else { … }` | no parentheses needed |
| `if let Some(n) = maybe { … }` | runs with `n` when `maybe` is not null |
| `if let Some(i) = xs.find_index(\|x\| x.id == id) { … }` | index of the first match, when there is one |
| `for item in items { … }` | loop over a list |
| `for i in 0..n { … }` / `for i in 1..=n { … }` | loop over a range (`..=` includes the end) |
| `while cond { … }`, `loop { … }`, `break`, `return` | |
| `match value { … }` | see [match](#match) |
| `\|x\| x * 2`, `\|a, b\| a + b` | closures |
| `xs.len()` | length of a list or string |
| `xs.retain(\|x\| keep)` | keep only matching items (in place) |
| `xs.push(x)`, `xs.filter(…)`, `xs.map(…)`, `xs.find(…)`, `xs.reduce(…, init)` | the usual list operations |
| `s.is_empty()` | true for `""` and whitespace-only strings |
| `s.contains(q)` | case-insensitive substring test |
| `Some(x)` / `None` | an optional value / no value (`null`) |
| `Todo { id: "1", done: false }` | a record literal |

Anything else is ordinary JavaScript expression syntax (`a ? b : c`, `&&`,
`??`, method calls, template math), and host functions are called by name.

### on_exit and async work

```foar
state Idle {
    render { Button("Save") -> on_click(Save) }
    effect Save() { save_note(note) -> transition(Saving); }
}
state Saving {
    render { Spinner("Saving…") }
    on_exit { transition Idle; }
}
```

The view is in `Saving` for exactly as long as `save_note` runs. If it leaves
`Saving` some other way first, `on_exit` doesn't run.

## Enums, tagged unions & generics

```foar
enum Layout { List, Gallery }
enum Sort { Edited = "updated", Created = "created", Title = "title" }

// Tagged-union enum with payloads and generic type parameter
enum LoadState<T> { Idle, Loading, Ready(T), Failed(String) }

data Page<T> { items: Vec<T>, total: i32 }
```

- Refer to a variant as `Layout.Gallery` or construct a payload variant as `LoadState.Ready(user)`. A misspelled variant or mismatched payload type is a compile error.
- Plain enum variants compile to their string or number values, so they serialize to JSON and compare with `==` directly.
- Tagged-union variants compile to `{ tag: "Ready", value: payload }` and destructure cleanly in both `match` and render `Match` (`Ready(user) => Text(user.name)`).
- `data<T>`, `enum<T>`, and `view<T>` accept generic type parameters that the static type checker substitutes across fields, payloads, and match arms.

## Match

```foar
let label = match count {
    0 => "none",
    1 | 2 => "a few",
    3..=9 => "several",
    n if n < 0 => "invalid",
    _ => "many",
};
```

`match` compares a value against **patterns**, top to bottom, and runs the
first arm that fits. Unlike `switch`, there is no fall-through, no `break`,
and no silent "nothing happened" when a case is missing.

| Pattern | Matches |
|---|---|
| `"text"`, `42`, `-1.5`, `true`, `None` | that value |
| `Status.Paid` or `Paid` | an enum variant (the bare name when the enum is known) |
| `a \| b \| c` | any of them |
| `1..10` / `1..=10` | a number in the range (end excluded / included) |
| `_` | anything |
| `name` | anything, bound to `name` for the arm |
| `pattern if condition` | the pattern, when the condition also holds |

**Exhaustiveness.** A match must handle every possible value: all variants of
the enum, both `true` and `false`, or a catch-all (`_` or a name). The
compiler names what is missing:

```text
app.foar:12:9: This match doesn't handle Status.Shipped (add an arm for it or `_ => …`)
```

The enum is known from the patterns (`Status.Paid`), or from the type of the
store, parameter, `let` or effect parameter being matched. Arms with a guard
(`if`) don't count towards exhaustiveness.

**Reachability.** An arm after a catch-all, or one whose values were all
handled earlier, is an error.

### Three forms

**As a value**, each arm is an expression:

```foar
let color = match status {
    Status.Paid => "green",
    Status.Cancelled => "red",
    _ => "gray",
};
```

**As a statement** (in an effect), each arm is an expression or a `{ block }`:

```foar
effect Advance() {
    match status {
        Status.Pending => status = Status.Paid,
        Status.Paid => {
            status = Status.Shipped;
            emit shipped(id);
        }
        _ => {}
    }
}
```

**In render**, `Match` shows one arm. Each arm is an element or a block of
elements:

```foar
Match(layout) {
    List => NoteList(notes: notes),
    Gallery => {
        Text("Gallery")
        NoteGrid(notes: notes)
    }
}
```

The arm that is showing stays mounted, and updates in place, until another
arm wins. A binding arm (`n if n > 9 => Text("{n}+")`) sees the current value.

## Styles

A style block is CSS: any property, `var()`, `calc()`, gradients,
transitions. Everything is compiled into one stylesheet at build time; class
names use the `f4-` prefix.

```foar
Text(title).style({
    font-weight: 600;
    color: done ? var(--muted) : inherit;     // dynamic: updated at runtime
    --progress: {percent}%;                   // reactive custom property
    @hover { text-decoration: underline; }
})
```

| Syntax | |
|---|---|
| `.style({ … })` | styles for that element |
| `.style(Name)`, `.style(Name, { … })` | a named style, plus local additions |
| `style Name { … }` | a named style (compiles to a class) |
| `@use Name;` | include another named style |
| `theme { --x: v; @dark { --x: w; } }` | global custom properties |
| `@hover`, `@focus`, `@focus-visible`, `@focus-within`, `@active`, `@disabled`, `@first-child`, `@last-child`, `@nth-child(2n)`, … | pseudo-classes |
| `@state Editing { … }` | while the view is in that state |
| `@media (…) { … }`, `@dark { … }`, `@light { … }`, `@reduced-motion { … }` | media queries (they nest) |
| `@drop-over { … }`, `@drag-source { … }` | drag-and-drop states |
| `layout: horizontal \| vertical`, `align: center` | flexbox shorthands |
| `prop: {expr}` / `prop: cond ? a : b` | a value computed at runtime |

The stylesheet is ordered by kind, not by file: theme, named styles,
keyframes, `css { }` blocks, then view styles. Moving code between files
never changes the cascade.

## Internationalization

Every expression and effect can call `t(key, params)`:

```foar
Text(t("list.count", { count: notes.length }))
```

```json
{ "list.count": { "one": "{count} note", "other": "{count} notes" } }
```

Messages use `{name}` placeholders; an object is a plural chosen by
`Intl.PluralRules` from `params.count`. Lookup goes locale → base language →
fallback, and `setLocale("es")` re-renders in one pass (and sets `lang`/`dir`,
including right-to-left). `t_key("…")` marks a key that is stored now and
translated later. `foar i18n` checks the catalogs against the code (see
[tooling](./tooling.md#i18n)).

## Static type checking and `extern fn`

The Rust compiler statically checks types across the entire program before
emitting output:

- `store` initializers and explicit `let` annotations;
- `data` struct literals (missing required fields, unknown fields with
  "did you mean", and field value types) and `.field` accesses;
- child view props: unknown props, prop types, and required props that are
  missing (a view's own props win over built-in attributes such as `label` or
  `title`);
- event wiring: `-> on_x(Effect)` names an effect of the current state, and on
  a component, `on_x` is an event it emits (`emit x(…)`) or a DOM event;
- assignments and operators in `effect` blocks, enum comparisons, `match` arm
  types (all arms of a value-producing match agree; plain enums count as
  strings), prop defaults, and `transition` target state names.

To typecheck calls into JavaScript host functions, declare their signatures at
the top level with `extern fn`:

```foar
extern fn format_price(cents: i32) -> String;
extern fn save_note(id: String, body: String) -> Promise<bool>;
```

Every call to a declared `extern fn` is checked for argument count and argument
types, and its return type flows into `let` inference and downstream checks.
Use `any` explicitly when you want a gradual escape hatch.

## Routing

FOAR includes a declarative URL router in the language and runtime:

```foar
Column {
    Row {
        Link("/", "Overview")
        Link("/orders/42", "Order 42")
    }
    Router {
        Route("/") { HomePage() }
        Route("/orders/:id") { params => OrderDetail(id: params.id) }
        Route("*") { Text("Not found: {route.path}") }
    }
}
```

- `Router` renders the first matching `Route` child, keeping it mounted and
  updating `params` in place when staying on the same route pattern.
- `Route` supports static segments, `:param` parameters, `*catchall` tails, and
  `*` wildcards.
- `Link(href, label)` renders a real `<a href>` with `aria-current="page"` when
  active and intercepts unmodified left-clicks to navigate via the History API
  (or hash/memory mode).
- Every view and effect can read `route.path`, `route.params`, `route.query`,
  and `route.hash`, and effects can call `navigate("/path")` or
  `replace("/path")`.

## Shared Contexts & Pure Functions

Declare shared singleton reactive state with `context` and subscribe from any
view with `use`:

```foar
fn format_usd(cents: i32) -> String {
    return "$" + (cents / 100).toFixed(2);
}

context Cart {
    store cents: i32 = 0;
    let label: String = format_usd(cents);

    effect Add(delta: i32) { cents += delta; }
    effect Clear() { cents = 0; }
}

view Navbar {
    use Cart;
    state Ready {
        render {
            Row {
                Text(Cart.label)
                Button("Clear", disabled: Cart.cents == 0) -> on_click(Cart.Clear)
            }
        }
    }
}
```

- Pure top-level `fn` declarations are statically checked at declaration and
  call sites and run identically on client and server (SSR) without JS host
  bindings.
- Context stores serialize into `__foar_state__` on SSR and restore on
  `hydrate()`.

## Composition: Slots, Portals, Forms, Hotkeys & Error Boundaries

- **Slots (`Slot()` / `Slot(name: "header")`)**: project caller children into a reusable child view while keeping them bound to the caller's reactive scope and events. Provide fallback content inside `Slot() { Text("Empty") }`, and assign named slots with `slot: "header"`.
- **Portals (`Portal(target: "#modal-root") { … }`)**: render modals, popovers, and toasts into another DOM container (default `document.body`) with full delegated FOAR events and automatic cleanup on unmount.
- **Native forms & universal props**: `Form { … } -> on_submit(Save)` (auto-`preventDefault()`), `Select(value: x) { Option(value: "a", "Alpha") } -> on_change(Pick)`, `Slider(value: v, min: 0, max: 100, step: 1) -> on_input(Set)`, `Progress(value: v, max: 100)`, plus reactive `disabled:`, `class:`, and `id:` on any element.
- **Lifecycle hooks, async results & state-scoped hotkeys**: states support `on_enter { … }`, `on_exit(res: Type) { … }` (receives the resolved async transition value), `on_error(err: String) { … }` (handles rejections), `on_unmount { … }`, and `on_key("Escape") { … }` / `on_key("Mod+K") { … }` shortcuts active only while in that state. Views also support view-level `on_unmount { … }`.
- **Error boundaries (`Catch { … } Fallback { err => … }`)**: isolate runtime and SSR errors in a subtree without crashing sibling views. The `err` binding has typed `CatchError` fields (`err.message` and `err.view`), and `callbacks.onError(errObj, rawErr)` notifies host telemetry.
- **Partial Islands (`Island(client: "visible" | "idle" | "load") { … }`)**: emit island hydration markers during SSR so `hydrateIslands(document, program)` hydrates only interactive islands while leaving static server HTML untouched.

## Server-side rendering, streaming and hydration

`web/foar-runtime.js` runs in Node, Deno, Bun, and Edge workers with zero DOM
dependencies:

```js
// Server (Node / Edge): synchronous, async loaders, or streaming Web ReadableStream
import { renderToString, renderToStringAsync, renderToStream } from './dist/app.js';

const { html, css, state, head } = await renderToStringAsync({
  url: req.url,
  loaders: {
    '/orders/:id': async ({ id }) => ({ order: await db.getOrder(id) }),
  },
  bindings: { format_price },
});

// Or stream progressively with Web ReadableStream (flushes CSS shell immediately):
const stream = renderToStream({
  url: req.url,
  loaders,
  shellBefore: '<!doctype html><html><head>',
  shellAfter: '</body></html>',
});

// Client
import { hydrate } from './dist/app.js';

hydrate(document.getElementById('app'), {
  bindings: { format_price },
});
```

`hydrate` restores serialized store/state snapshots from `<script id="__foar_state__">`
and adopts the existing server-rendered DOM nodes in place (creating zero new
elements when the server HTML matches).

## Host functions and the runtime

```js
import {
  createFoarRuntime,
  hydrate,
  renderToString,
  renderToStringAsync,
  renderToStream,
  createI18n,
} from './web/foar-runtime.js';

const rt = createFoarRuntime(program, mountElement, {
  bindings: { load_notes, save_note: async (n) => { … } }, // callable by name from .foar code
  i18n: createI18n({ locale: 'en', fallback: 'en', messages: { en, es } }),
  router: { mode: 'history' }, // 'history' | 'hash' | 'memory'
  onRender(snapshot) {}, onEffect(info) {}, onTransition(info) {}, onEmit(info) {}, onNavigate(info) {},
});
rt.getSnapshot();                    // [{ key, viewName, state, stores, props }]
rt.invokeEffect('root', 'Refresh');  // run an effect from outside
rt.navigate('/orders/42');
rt.getRoute();                       // { path, params, query, hash }
rt.setLocale('de');
rt.destroy();
```

`program` comes from `foar build app.foar` (JSON), or use
`foar build app.foar --format js`, which produces an ES module exporting
`{ program, mount, hydrate, renderToString, createI18n }`.

### How updates work

- Each element is compiled once into a block that owns real DOM nodes and a
  list of **bindings** (text, value, checked, attributes, dynamic styles). An
  update re-evaluates the bindings and writes only the values that changed.
  There is no virtual DOM and no diff of element trees.
- A transition replaces only that view's subtree; `If`/`Match` swap DOM only
  when the branch or arm changes; `List` reconciles by key.
- Effects in one tick are batched into one update (a microtask).
- One delegated listener per event type on the mount element.
