# Examples

Each example is a project folder: `app.foar` is the entry (its first view is the
root view) and imports the rest. Open them in the playground
(`npm start`, then the Example menu) or build one with the CLI:

```sh
foar check examples/todo/app.foar
foar build examples/todo/app.foar --format js -o app.js
```

| Example | Shows |
|---|---|
| [`starter/`](starter) | The smallest multi-file app: a root view and one component. The playground's Scratch project starts from it. |
| [`counter/`](counter) | One view, three states, an async transition (`api_save(...) -> transition(Saving)`) and `on_exit`. |
| [`orders/`](orders) | Enums and exhaustive `match`: an order status drives badges, colours and the allowed actions; `match` as a value and as a statement, alternatives, ranges, guards, derived `let` values, `for` loops. |
| [`todo/`](todo) | Sub-views with their own state machines (`TodoItem`: Idle / Editing), keyed lists, events (`emit`), theme, named styles, `@state` and `@keyframes`, data types — split into `models.foar`, `styles/`, `components/`; a `Filter` enum, derived `let` values and a `Match` footer. |

A larger app, Notes on FOAR (a macOS Notes clone in 21 files), lives in its own
repository next to this one (`../notes-on-foar`).
