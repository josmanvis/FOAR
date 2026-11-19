# Examples

Each example is a project folder: `app.foar` is the entry (its first view is the
root view) and imports the rest. Open them in the [playground](https://josmanvis.github.io/FOAR/playground/)
(`pnpm dev`, then the Project menu) or build one with the CLI:

```sh
foar check examples/todo/app.foar
foar build examples/todo/app.foar --format js -o app.js
```

| Example | Shows |
|---|---|
| [`starter/`](starter) | The smallest multi-file app: a root view and one component. The playground's Scratch project starts from it. |
| [`counter/`](counter) | One view, three states, an async transition (`api_save(...) -> transition(Saving)`) and `on_exit`. |
| [`orders/`](orders) | Enums and exhaustive `match`: an order status drives badges, colours and the allowed actions; `match` as a value and as a statement, alternatives, ranges, guards, derived `let` values, `for` loops. |
| [`router/`](router) | Fleet Console: declarative `Router` / `Route("/services/:id")` / `Link`, named `Slot()` via `@ui/Panel`, `Portal` dialog, generic tagged-union `ProbeState<i32>`, `on_enter`, `Catch`/`Fallback` error boundary, and verified `foar.lock`. |
| [`todo/`](todo) | Sub-views with their own state machines (`TodoItem`: Idle / Editing), keyed lists, events (`emit`), theme, named styles, `@state` and `@keyframes`, data types — split into `models.foar`, `styles/`, `components/`; a `Filter` enum, derived `let` values and a `Match` footer. |
| [`notes-on-foar/`](notes-on-foar) | A 21-file macOS Notes-style app: folders, tags, locked notes, rich-text editing, drag and drop, context menus, i18n, and dark mode. |
