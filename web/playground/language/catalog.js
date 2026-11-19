// What the FOAR language and runtime provide, for completions and hovers.
// Keep in sync with src/parser.rs (keywords, @rules) and web/foar-runtime.js
// (elements, named arguments, events).

export const KEYWORDS = {
  view: 'Declares a view: a component with its own state machine.\n`view Name(param: Type) { store … state … }`',
  state: 'A state of the view. The first state is the initial one; each state has its own `render` and effects.',
  store: 'View-local data that survives state changes. `store name: Type = initial;`',
  effect: 'Runs in response to an event: changes stores, `transition`s to another state, or `emit`s to the parent.',
  render: 'The elements shown while the view is in this state.',
  transition: 'Moves the view to another state: `transition Editing;`',
  emit: 'Sends an event to the parent: `emit pick(id);` → the parent handles `-> on_pick(Effect)`.',
  on_exit: 'Runs when an async transition resolves (`api(...) -> transition(State)`), then usually transitions.',
  data: 'Declares a data type: `data Note { id: String, title: String }`.',
  theme: 'Design tokens: CSS custom properties on :root, with `@dark { … }` / `@light { … }` variants.',
  style: '`style Name { … }` declares a named style (apply with `.style(Name)` or `@use Name`); `style { … }` inside a view styles its host element.',
  css: 'A raw CSS block, copied into the stylesheet as is.',
  import: 'Makes another file part of the program: `import "components/Row"` (root-relative) or `import "./Row"` (relative).',
  let: 'A local variable in an effect.',
  if: 'Conditional in an effect.',
  else: 'Conditional branch in an effect.',
  return: 'Leaves the effect.',
  true: 'Boolean true.',
  false: 'Boolean false.',
};

export const TYPES = {
  String: 'Text.',
  bool: 'true or false.',
  i32: '32-bit integer.',
  i64: '64-bit integer (timestamps, ids).',
  f64: 'Floating-point number.',
  any: 'Any value (no type check).',
  Vec: 'A list: `Vec<Note>`.',
  Option: 'A value that may be missing: `Option<String>`.',
};

const COMMON = ['label', 'title', 'role', 'aria', 'tab_index', 'drag', 'drag_text', 'autofocus'];
const ARG_DOCS = {
  label: 'Accessible name (`aria-label`).',
  title: 'Tooltip; for an icon Button without `label`, also its accessible name.',
  role: 'ARIA role.',
  aria: 'ARIA attributes: `aria: { expanded: open, current: selected }` (snake_case → kebab-case, null removes).',
  tab_index: '`tabindex`.',
  drag: 'Makes the element draggable; the value is the payload `on_drop` receives.',
  drag_text: 'text/plain data for drops into other apps.',
  autofocus: 'Focus the element when it appears (when the expression is true).',
  value: 'The current value (kept in sync; read it in `on_input`).',
  placeholder: 'Placeholder text.',
  secure: 'Password field (hides the text).',
  checked: 'Whether the box is checked.',
  editable: 'Whether the rich text can be edited.',
  src: 'Image URL.',
  alt: 'Alternative text for the image.',
  empty: 'Shown when the list is empty.',
};
export const argDoc = (name) => ARG_DOCS[name] ?? '';

/** Built-in elements: signature, doc, positional args, named args, events. */
export const ELEMENTS = {
  Text: { sig: 'Text(text)', doc: 'A run of text. `{expr}` interpolates.', named: [...COMMON], events: ['on_click', 'on_double_click', 'on_context_menu', 'on_drop', 'on_drag_start', 'on_drag_end'], snippet: 'Text("${1:text}")' },
  Button: { sig: 'Button(text)', doc: 'A button. Icon buttons: `Button("⋯", title: "More")`.', named: [...COMMON], events: ['on_click', 'on_double_click', 'on_context_menu', 'on_drop', 'on_blur'], snippet: 'Button("${1:Label}") -> on_click(${2:Effect})' },
  Input: { sig: 'Input(value: String, placeholder: String, secure: bool)', doc: 'A one-line text field.', named: ['value', 'placeholder', 'secure', ...COMMON], events: ['on_input', 'on_enter', 'on_blur', 'on_change'], snippet: 'Input(value: ${1:text}, placeholder: "${2}") -> on_input(${3:Effect})' },
  TextArea: { sig: 'TextArea(value: String, placeholder: String)', doc: 'A multi-line text field.', named: ['value', 'placeholder', ...COMMON], events: ['on_input', 'on_blur', 'on_change'], snippet: 'TextArea(value: ${1:text}) -> on_input(${2:Effect})' },
  Checkbox: { sig: 'Checkbox(checked: bool)', doc: 'A checkbox; `on_change` receives the new value.', named: ['checked', ...COMMON], events: ['on_change'], snippet: 'Checkbox(checked: ${1:done}) -> on_change(${2:Effect})' },
  RichText: { sig: 'RichText(value: String, placeholder: String, editable: bool)', doc: 'An editable HTML area (contenteditable); `on_input` receives its HTML.', named: ['value', 'placeholder', 'editable', ...COMMON], events: ['on_input', 'on_blur', 'on_context_menu', 'on_drop'], snippet: 'RichText(value: ${1:html}) -> on_input(${2:Effect})' },
  Image: { sig: 'Image(src: String, alt: String)', doc: 'An image.', named: ['src', 'alt', ...COMMON], events: ['on_click', 'on_drop'], snippet: 'Image(src: ${1:url}, alt: "${2}")' },
  Spinner: { sig: 'Spinner(text)', doc: 'A busy indicator with optional text.', named: [...COMMON], events: [], snippet: 'Spinner("${1:Loading…}")' },
  Row: { sig: 'Row { … }', doc: 'Lays children out horizontally (flex row, centred).', named: [...COMMON], events: ['on_click', 'on_double_click', 'on_context_menu', 'on_drop', 'on_drag_start', 'on_drag_end'], snippet: 'Row {\n    $0\n}' },
  Column: { sig: 'Column { … }', doc: 'Lays children out vertically (flex column).', named: [...COMMON], events: ['on_click', 'on_double_click', 'on_context_menu', 'on_drop', 'on_drag_start', 'on_drag_end'], snippet: 'Column {\n    $0\n}' },
  List: { sig: 'List(items, empty: element) { item => … }', doc: 'Renders one block per item, keyed by `item.id` (rows are reused, not rebuilt).', named: ['empty', 'role', 'label', 'aria'], events: ['on_context_menu', 'on_drop'], snippet: 'List(${1:items}) { ${2:item} =>\n    $0\n}' },
  If: { sig: 'If(condition) { … }', doc: 'Shows its children while the condition is true.', named: [], events: [], snippet: 'If(${1:condition}) {\n    $0\n}' },
};

export const EVENTS = {
  on_click: 'Click (or Enter/Space on a focusable element).',
  on_double_click: 'Double click.',
  on_input: 'Each edit; the effect receives the new value.',
  on_change: 'Committed change (Checkbox: the new checked value).',
  on_enter: 'Enter pressed in a field.',
  on_context_menu: 'Right-click or the Menu key; the effect receives `{ x, y }`.',
  on_blur: 'Focus left the element.',
  on_drop: 'Something dragged with `drag:` was dropped here; the effect receives the payload.',
  on_drag_start: 'A drag started from this element.',
  on_drag_end: 'The drag from this element ended.',
};

export const STYLE_AT = {
  '@hover': 'While the pointer is over the element (`:hover`).',
  '@focus': 'While focused (`:focus`).',
  '@focus-visible': 'While keyboard-focused (`:focus-visible`).',
  '@focus-within': 'While it or a child has focus.',
  '@active': 'While pressed.',
  '@disabled': 'While disabled.',
  '@first-child': 'The first child.',
  '@last-child': 'The last child.',
  '@nth-child': 'Every nth child: `@nth-child(2n) { … }`.',
  '@state': 'While the view is in a state: `@state Editing { … }`.',
  '@media': 'Media query: `@media (max-width: 700px) { … }`.',
  '@dark': 'In dark mode (`prefers-color-scheme: dark`).',
  '@light': 'In light mode.',
  '@reduced-motion': 'When the user asks for less motion.',
  '@drop-over': 'While something is dragged over this drop target.',
  '@drag-source': 'On the element being dragged.',
  '@use': 'Also apply a named style: `@use Card;`.',
};
export const STYLE_AT_SNIPPETS = {
  '@nth-child': '@nth-child(${1:2n}) {\n    $0\n}',
  '@state': '@state ${1:State} {\n    $0\n}',
  '@media': '@media (${1:max-width: 700px}) {\n    $0\n}',
  '@use': '@use ${1:Style};',
};

// FOAR layout shorthands plus common CSS properties, with value hints.
export const FOAR_PROPS = {
  layout: { doc: 'FOAR shorthand: `vertical` (flex column) or `horizontal` (flex row).', values: ['vertical', 'horizontal'] },
  align: { doc: 'FOAR shorthand for `align-items`.', values: ['center', 'start', 'end', 'stretch', 'baseline'] },
};
const V = {
  display: ['flex', 'grid', 'block', 'inline-block', 'inline-flex', 'none', 'contents'],
  position: ['relative', 'absolute', 'fixed', 'sticky', 'static'],
  overflow: ['hidden', 'auto', 'scroll', 'visible', 'clip'],
  'flex-direction': ['row', 'column', 'row-reverse', 'column-reverse'],
  'justify-content': ['center', 'flex-start', 'flex-end', 'space-between', 'space-around', 'space-evenly'],
  'align-items': ['center', 'flex-start', 'flex-end', 'stretch', 'baseline'],
  'align-self': ['center', 'flex-start', 'flex-end', 'stretch', 'auto'],
  'text-align': ['left', 'center', 'right', 'start', 'end', 'justify'],
  'font-weight': ['400', '500', '600', '700', 'bold', 'normal'],
  'font-style': ['italic', 'normal'],
  'text-decoration': ['none', 'underline', 'line-through'],
  'white-space': ['nowrap', 'normal', 'pre', 'pre-wrap'],
  'text-overflow': ['ellipsis', 'clip'],
  cursor: ['pointer', 'default', 'text', 'grab', 'not-allowed', 'col-resize', 'row-resize'],
  'pointer-events': ['none', 'auto'],
  'user-select': ['none', 'text', 'all'],
  'box-sizing': ['border-box', 'content-box'],
  visibility: ['visible', 'hidden'],
  'flex-wrap': ['wrap', 'nowrap'],
  'object-fit': ['cover', 'contain', 'fill'],
  'word-break': ['break-word', 'break-all', 'normal'],
  resize: ['none', 'both', 'vertical', 'horizontal'],
  'backdrop-filter': ['blur(20px)'],
  transition: ['all 0.2s ease', 'background 0.15s ease', 'opacity 0.2s ease', 'transform 0.2s ease'],
  animation: [],
};
export const CSS_PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'inset', 'z-index', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'gap', 'row-gap', 'column-gap', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'justify-content', 'align-items', 'align-self', 'align-content', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'place-items',
  'color', 'background', 'background-color', 'background-image', 'opacity', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-radius', 'outline', 'outline-offset', 'box-shadow',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'text-overflow', 'white-space', 'word-break',
  'overflow', 'overflow-x', 'overflow-y', 'cursor', 'pointer-events', 'user-select', 'box-sizing', 'visibility', 'object-fit', 'resize',
  'transform', 'transform-origin', 'transition', 'animation', 'filter', 'backdrop-filter', 'content', 'accent-color', 'caret-color', 'scroll-behavior', 'overscroll-behavior',
];
export const cssValues = (prop) => FOAR_PROPS[prop]?.values ?? V[prop] ?? [];
export const isCssProp = (p) => CSS_PROPS.includes(p) || p in FOAR_PROPS;

/** Snippets offered at the start of a line, by where the caret is. */
export const SNIPPETS = {
  top: [
    ['view', 'view ${1:Name} {\n    state ${2:Idle} {\n        render {\n            $0\n        }\n    }\n}', 'A view with one state'],
    ['view (with params)', 'view ${1:Name}(${2:label}: ${3:String}) {\n    state ${4:Idle} {\n        render {\n            $0\n        }\n    }\n}', 'A view that takes parameters'],
    ['data', 'data ${1:Name} {\n    id: String,\n    $0\n}', 'A data type'],
    ['style', 'style ${1:Name} {\n    $0\n}', 'A named style'],
    ['theme', 'theme {\n    --${1:accent}: ${2:#4f46e5};\n    @dark { --$1: ${3:#818cf8}; }\n}', 'Design tokens with a dark variant'],
    ['import', 'import "${1:components/Name}"', 'Make another file part of the program'],
    ['@keyframes', '@keyframes ${1:name} {\n    from { $2 }\n    to { $0 }\n}', 'A CSS animation'],
    ['css', 'css {\n    $0\n}', 'Raw CSS'],
  ],
  view: [
    ['store', 'store ${1:name}: ${2:String} = ${3:""};', 'View data'],
    ['state', 'state ${1:Name} {\n    render {\n        $0\n    }\n}', 'A state'],
    ['style', 'style {\n    $0\n}', 'Styles for the view’s host element'],
  ],
  state: [
    ['render', 'render {\n    $0\n}', 'What this state shows'],
    ['effect', 'effect ${1:Name}(${2}) {\n    $0\n}', 'Handles an event'],
    ['on_exit', 'on_exit {\n    transition ${1:State};\n}', 'After an async transition resolves'],
  ],
  effect: [
    ['transition', 'transition ${1:State};', 'Go to another state'],
    ['emit', 'emit ${1:event}(${2});', 'Send an event to the parent'],
    ['let', 'let ${1:name} = ${2:value};', 'Local variable'],
    ['if', 'if ${1:condition} {\n    $0\n}', 'Conditional'],
  ],
};
