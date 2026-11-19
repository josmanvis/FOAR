# FOAR guide

FOAR is a language for user interfaces in which **every component is an
explicit state machine**. You write views, their states, and the effects that
move between them; a Rust compiler (native or WebAssembly) turns that into a
small retained-DOM runtime that updates the page by touching only what
changed.

This guide takes you from a counter to a multi-file app in about fifteen
minutes. Everything here runs in the [playground](../playground/), so you can
follow along without installing anything.

- [Language reference](./language.md): every construct, in detail.
- [Tooling](./tooling.md): the CLI, the playground, dev servers.
- [Why FOAR](./why.md): the design, and how it compares.

## Your first view

```foar
view Counter {
    store count: i32 = 0;

    state Ready {
        render {
            Text("Clicked {count} times")
            Button("Click me") -> on_click(Bump)
        }
        effect Bump() { count += 1; }
    }
}
```

A **view** is a component. It has:

- **stores**: its data (`store count: i32 = 0;`), kept across renders;
- **states**: what it can be doing. Each state has a `render` block (what to
  show) and **effects** (what happens on events). The first state is the
  initial one.

`Button(...) -> on_click(Bump)` connects an event to an effect of the current
state. `"Clicked {count} times"` interpolates. When an effect changes a store,
FOAR re-evaluates the bindings that read it and writes only the values that
changed: the `Text` node is updated in place, the button is never re-created.

## States instead of flags

Most UI bugs come from flags that disagree: `isLoading` and `isError` both
true, an edit box that shows while the item is being deleted. In FOAR a view is
in exactly one state, and each state says what it shows:

```foar
view Profile {
    store name: String = "Ada";
    store draft: String = "";

    state Viewing {
        render {
            Text(name).style({ font-size: 20px; })
            Button("Edit") -> on_click(Edit)
        }
        effect Edit() {
            draft = name;
            transition Editing;
        }
    }

    state Editing {
        render {
            Input(value: draft, autofocus: true) -> on_input(Type) -> on_enter(Save)
            Button("Save") -> on_click(Save)
            Button("Cancel") -> on_click(Cancel)
        }
        effect Type(text: String) { draft = text; }
        effect Save() {
            name = draft;
            transition Viewing;
        }
        effect Cancel() { transition Viewing; }
    }
}
```

`transition Editing;` moves the view to another state. Only this view's
subtree is swapped; everything around it keeps its DOM, focus and scroll.
Because effects belong to states, `Save` simply does not exist while the view
is `Viewing`: there is no "save while not editing" case to guard against.

The playground's inspector draws every view's states and transitions, and
shows which state each mounted instance is in.

## Data, lists and components

```foar
data Todo {
    id: String,
    text: String,
    done: bool,
}

view TodoList {
    store todos: Vec<Todo> = [
        Todo { id: "1", text: "Learn FOAR", done: false },
        Todo { id: "2", text: "Ship it", done: false },
    ];

    // derived values: recomputed on every update, no dependency lists
    let left = todos.filter(|t| !t.done).len();

    state Ready {
        render {
            List(todos, empty: "Nothing to do.") { todo =>
                TodoRow(todo: todo) -> on_toggle(Toggle)
            }
            Text("{left} left")
        }
        effect Toggle(id: String) {
            for t in todos {
                if t.id == id { t.done = !t.done; }
            }
        }
    }
}

view TodoRow(todo: Todo) {
    state Idle {
        render {
            Checkbox(checked: todo.done) -> on_change(Flip)
            Text(todo.text)
        }
        effect Flip(on: bool) { emit toggle(todo.id); }
    }
}
```

- `data` declares a record type.
- `List(items) { item => … }` renders one block per item, **keyed by
  `item.id`**: when the list changes, rows are reused and moved, never rebuilt.
- A view with parameters (`view TodoRow(todo: Todo)`) is a component. It talks
  to its parent with `emit toggle(todo.id);`, which the parent handles with
  `-> on_toggle(Toggle)`.
- `let left = …;` is a **derived value**: it is recomputed whenever the view
  updates, so it can never go stale and needs no dependency list.

Effect code is a small, Rust-flavoured language: closures are `|t| …`,
`for x in list { … }`, `if cond { … }` without parentheses, `Some(x)` /
`None`, `items.len()`. See the [reference](./language.md#effects).

## Enums and match

`switch` statements in most languages fall through by default, and nothing
tells you when you forget a case. FOAR has **enums** and an **exhaustive
`match`**:

```foar
enum Status {
    Draft,
    Review,
    Published,
    Archived = "archived",
}

view Article {
    store status: Status = Status.Draft;

    let label = match status {
        Status.Draft => "Draft",
        Status.Review => "In review",
        Status.Published => "Live",
        Status.Archived => "Archived",
    };

    state Ready {
        render {
            Text(label)
            Match(status) {
                Draft => Button("Send for review") -> on_click(Advance),
                Review => Button("Publish") -> on_click(Advance),
                Published => Button("Archive") -> on_click(Advance),
                Archived => Text("Read-only"),
            }
        }
        effect Advance() {
            status = match status {
                Status.Draft => Status.Review,
                Status.Review => Status.Published,
                Status.Published | Status.Archived => Status.Archived,
            };
        }
    }
}
```

- `match` picks **one** arm. There is no fall-through and no `break`.
- It must be **exhaustive**: every variant of the enum (or `true` and
  `false`, or a `_` arm). Add a variant to `Status` and every `match` that
  doesn't handle it stops compiling, telling you which cases are missing.
- An arm that can never run (after `_`, or a repeated value) is an error too.
- Patterns: literals, `a | b`, ranges (`1..=9`), enum variants, and
  `name if guard`.
- `match` is a value (`let label = match …`) or a statement; in `render`,
  `Match(value) { … }` shows one arm and keeps it mounted until another wins.
- Enum values are just their names (or the value you give them, like
  `"archived"`), so they go to JSON, `localStorage` and host code as plain
  strings.

`If(cond) { … } Else If(other) { … } Else { … }` covers the simple two-way
cases in `render`.

## Styling

Style blocks are real CSS, scoped to the element and compiled into one
stylesheet at build time. Values can be expressions; only those are updated at
runtime.

```foar
theme {
    --accent: #4f46e5;
    @dark { --accent: #818cf8; }
}

style Card {
    padding: 16px;
    border-radius: 12px;
    background: white;
    @hover { box-shadow: 0 4px 16px rgba(0, 0, 0, .1); }
    @dark { background: #1f2937; }
}

view Meter {
    store level: i32 = 30;

    style {
        layout: vertical;
        gap: 8px;
        @state Full { outline: 2px solid var(--accent); }
    }

    state Filling {
        render {
            Text("{level}%").style(Card, {
                color: level > 80 ? var(--accent) : inherit;
            })
            Button("+10") -> on_click(Fill)
        }
        effect Fill() {
            level += 10;
            if level >= 100 { transition Full; }
        }
    }
    state Full {
        render { Text("Full!").style(Card) }
    }
}
```

`theme` declares CSS variables (with a dark-mode variant), `style Name` a
reusable style, `@hover`/`@focus`/`@media`/`@dark` nest like SCSS, and
`@state Full { … }` applies while the view is in that state.

## Multiple files

Real apps are split into files. The entry file's first view is the root;
other files join the program with `import`:

```foar
// app.foar
import "models"
import "components/TodoRow"
import "./theme.foar"
```

Views, data types, enums and styles are global by name. An import only says
that a file is part of the program. Errors point at the right file and line.
Look at the [todo](../examples/todo) and [orders](../examples/orders) examples.
The largest FOAR app so far, a macOS Notes clone, is 21 files: one view per
file under `components/`, plus `models.foar` and `styles/`.

## Host code

FOAR talks to JavaScript through named functions you pass in. They are
callable from any expression or effect:

```js
import { mount, createI18n } from './dist/app.js'; // built with `foar build app.foar --format js`
mount(document.getElementById('app'), {
  bindings: {
    load_notes: () => JSON.parse(localStorage.notes ?? '[]'),
    save_notes: (notes) => { localStorage.notes = JSON.stringify(notes); },
    api_save: async (n) => fetch('/save', { method: 'POST', body: String(n) }),
  },
});
```

```foar
view Notes {
    store notes: Vec<any> = load_notes();

    state Idle {
        render { Button("Save") -> on_click(Save) }
        effect Save() { api_save(notes.length) -> transition(Saving); }
    }
    state Saving {
        render { Spinner("Saving…") }
        on_exit { transition Idle; }
    }
}
```

`api(args) -> transition(State);` moves to `State` right away, calls the async
function, and runs that state's `on_exit` when it settles. Loading states are
states, not flags.

## Where next

- Open the [playground](../playground/). It has completions, hover docs,
  errors as you type, go to definition, rename and a formatter.
- Read the [language reference](./language.md).
- Read [why FOAR is built this way](./why.md).
