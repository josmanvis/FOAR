//! Language Server Protocol (LSP) server for FOAR (`foar lsp`).
//!
//! Speaks JSON-RPC 2.0 over stdio (`Content-Length` framing) with zero extra
//! dependencies beyond `serde_json`. Provides:
//! - Live compiler diagnostics (`textDocument/publishDiagnostics`), multi-file aware
//! - Context-aware completions (`textDocument/completion`)
//! - Hover documentation (`textDocument/hover`)
//! - Go-to-definition (`textDocument/definition`)
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

struct Server {
    docs: HashMap<String, String>,
    shutdown: bool,
}

#[derive(Debug, Clone)]
struct SymbolInfo {
    kind: &'static str,
    name: String,
    detail: String,
    line: usize,
    col: usize,
    uri: String,
}

const KEYWORDS: &[(&str, &str)] = &[
    ("view", "Declare a state-machine UI view (`view Name(prop: Type) { ... }`)."),
    ("state", "Declare an explicit topological UI state inside a view."),
    ("render", "Declare the retained UI tree for a state."),
    ("effect", "Declare a state-scoped event handler that mutates stores, emits, or transitions."),
    ("on_enter", "Lifecycle hook executed when entering a state."),
    ("on_exit", "Lifecycle hook executed when an async transition resolves (`on_exit(res: Type) { … }`)."),
    ("on_error", "Error hook executed when an async transition rejects (`on_error(err: String) { … }`)."),
    ("on_unmount", "Lifecycle hook executed when leaving a state or disposing a view."),
    ("on_key", "State-scoped keyboard shortcut (`on_key(\"Escape\") { … }`, `on_key(\"Mod+K\") { … }`)."),
    ("context", "Declare a shared reactive singleton context (`context Auth { store ...; let ...; effect ... }`)."),
    ("use", "Subscribe a view to a shared reactive context (`use Auth;`)."),
    ("fn", "Declare a typed pure FOAR function (`fn format_price(cents: i32) -> String { … }`)."),
    ("store", "Declare reactive view state (`store name: Type = init;`)."),
    ("let", "Declare a derived reactive value (`let total = items.len();`)."),
    ("data", "Declare a typed record struct (`data User<T> { ... }`)."),
    ("enum", "Declare a sum type / tagged union (`enum LoadState<T> { Idle, Ready(T) }`)."),
    ("extern", "Declare a typed JS host function (`extern fn fmt(n: i32) -> String;`)."),
    ("transition", "Transition the view to another explicit state (`transition Saving;`)."),
    ("emit", "Emit an event to the parent view (`emit save(value);`)."),
    ("theme", "Declare CSS custom properties on `:root` (supports `@dark` / `@light`)."),
    ("style", "Declare a scoped view style block or reusable named style."),
    ("css", "Include verbatim global CSS rules."),
    ("import", "Import another `.foar` file or `@package` declared in `foar.toml`."),
    ("match", "Exhaustive pattern matching expression or statement."),
];

const BUILTIN_ELEMENTS: &[(&str, &str)] = &[
    ("Text", "Display reactive text (`Text(\"Hello {name}\")`)."),
    ("Button", "Interactive button (`Button(\"Save\") -> on_click(Save)`)."),
    ("Input", "Single-line text/password input (`Input(value: q, placeholder: \"Search\")`)."),
    ("TextArea", "Multi-line text input."),
    ("Checkbox", "Boolean checkbox (`Checkbox(checked: done) -> on_change(Toggle)`)."),
    ("RichText", "Content-editable rich HTML editor."),
    ("Image", "Lazy-loaded image (`Image(src: url, alt: \"...\")`)."),
    ("Spinner", "Animated loading indicator (`Spinner(\"Loading...\")`)."),
    ("Row", "Horizontal flex container."),
    ("Column", "Vertical flex container."),
    ("List", "Keyed list reconciliation (`List(items, empty: \"None\") { item => ... }`)."),
    ("If", "Conditional render branch (`If(cond) { ... } Else { ... }`)."),
    ("Else", "Alternative branch following `If`."),
    ("Match", "Exhaustive render-tree pattern match (`Match(state) { Ready(x) => ... }`)."),
    ("Router", "Built-in client & SSR URL router (`Router { Route(\"/...\") { ... } }`)."),
    ("Route", "Route branch inside `Router` (`Route(\"/orders/:id\") { params => ... }`)."),
    ("Link", "SPA navigation link with automatic `aria-current=\"page\"` (`Link(\"/about\", \"About\")`)."),
    ("Slot", "Slot outlet for caller children (`Slot()` or `Slot(name: \"header\")`)."),
    ("Portal", "Render children into another DOM container (`Portal(target: \"#modal-root\") { ... }`)."),
    ("Catch", "Error boundary isolating runtime & SSR errors (`Catch { ... } Fallback { err => ... }`)."),
    ("Fallback", "Fallback UI rendered when a `Catch` boundary catches an error."),
    ("Form", "Native `<form>` container with automatic `preventDefault()` (`Form { ... } -> on_submit(Submit)`)."),
    ("Select", "Native `<select>` dropdown (`Select(value: x) { Option(value: \"a\", \"Alpha\") } -> on_change(Pick)`)."),
    ("Option", "Option inside a `Select` (`Option(value: \"a\", \"Alpha\")`)."),
    ("Slider", "Native range slider (`Slider(value: v, min: 0, max: 100, step: 1) -> on_input(Set)`)."),
    ("Progress", "Native progress bar (`Progress(value: v, max: 100)`)."),
    ("Island", "Partial hydration boundary (`Island(client: \"visible\" | \"idle\" | \"load\") { ... }`)."),
];

pub fn run_stdio() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = stdout.lock();
    let mut server = Server { docs: HashMap::new(), shutdown: false };

    while let Some(msg) = read_message(&mut reader) {
        if let Some(responses) = server.handle_message(msg) {
            for resp in responses {
                if write_message(&mut writer, &resp).is_err() {
                    return;
                }
            }
        }
        if server.shutdown {
            // Wait for `exit` notification, or finish on EOF
        }
    }
}

fn read_message<R: BufRead>(reader: &mut R) -> Option<Value> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).ok()?;
        if n == 0 {
            return None;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.eq_ignore_ascii_case("Content-Length") {
                content_length = v.trim().parse::<usize>().ok();
            }
        }
    }
    let len = content_length?;
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn write_message<W: Write>(writer: &mut W, msg: &Value) -> io::Result<()> {
    let body = serde_json::to_string(msg).unwrap();
    write!(writer, "Content-Length: {}\r\n\r\n{}", body.len(), body)?;
    writer.flush()
}

fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let stripped = uri.strip_prefix("file://")?;
    let decoded = stripped.replace("%20", " ");
    Some(PathBuf::from(decoded))
}

fn path_to_uri(p: &Path) -> String {
    let abs = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    format!("file://{}", abs.to_string_lossy())
}

impl Server {
    fn handle_message(&mut self, msg: Value) -> Option<Vec<Value>> {
        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => Some(vec![json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "capabilities": {
                        "textDocumentSync": 1,
                        "completionProvider": {
                            "triggerCharacters": [".", "@", ":"]
                        },
                        "hoverProvider": true,
                        "definitionProvider": true
                    },
                    "serverInfo": {
                        "name": "foar-lsp",
                        "version": crate::version()
                    }
                }
            })]),
            "initialized" => None,
            "shutdown" => {
                self.shutdown = true;
                Some(vec![json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null })])
            }
            "exit" => {
                std::process::exit(if self.shutdown { 0 } else { 1 });
            }
            "textDocument/didOpen" => {
                let uri = params["textDocument"]["uri"].as_str()?.to_string();
                let text = params["textDocument"]["text"].as_str()?.to_string();
                self.docs.insert(uri.clone(), text);
                Some(vec![self.diagnostics_notification(&uri)])
            }
            "textDocument/didChange" => {
                let uri = params["textDocument"]["uri"].as_str()?.to_string();
                if let Some(changes) = params["contentChanges"].as_array() {
                    if let Some(last) = changes.last().and_then(|c| c["text"].as_str()) {
                        self.docs.insert(uri.clone(), last.to_string());
                    }
                }
                Some(vec![self.diagnostics_notification(&uri)])
            }
            "textDocument/didSave" => {
                let uri = params["textDocument"]["uri"].as_str()?.to_string();
                if let Some(text) = params["text"].as_str() {
                    self.docs.insert(uri.clone(), text.to_string());
                }
                Some(vec![self.diagnostics_notification(&uri)])
            }
            "textDocument/didClose" => {
                if let Some(uri) = params["textDocument"]["uri"].as_str() {
                    self.docs.remove(uri);
                    return Some(vec![json!({
                        "jsonrpc": "2.0",
                        "method": "textDocument/publishDiagnostics",
                        "params": { "uri": uri, "diagnostics": [] }
                    })]);
                }
                None
            }
            "textDocument/completion" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
                let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
                let col = params["position"]["character"].as_u64().unwrap_or(0) as usize;
                let items = self.completions(uri, line, col);
                Some(vec![json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": items
                })])
            }
            "textDocument/hover" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
                let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
                let col = params["position"]["character"].as_u64().unwrap_or(0) as usize;
                let hover = self.hover(uri, line, col);
                Some(vec![json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": hover
                })])
            }
            "textDocument/definition" => {
                let uri = params["textDocument"]["uri"].as_str().unwrap_or("");
                let line = params["position"]["line"].as_u64().unwrap_or(0) as usize;
                let col = params["position"]["character"].as_u64().unwrap_or(0) as usize;
                let loc = self.definition(uri, line, col);
                Some(vec![json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": loc
                })])
            }
            _ => {
                if id.is_some() {
                    Some(vec![json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": Value::Null
                    })])
                } else {
                    None
                }
            }
        }
    }

    fn compile_uri(&self, uri: &str) -> Result<crate::ast::Program, crate::CompileError> {
        let src = self.docs.get(uri).cloned().unwrap_or_default();
        if let Some(path) = uri_to_path(uri) {
            if let (Some(root), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) {
                let entry_norm = name.to_string();
                let res = crate::project::load(&entry_norm, &mut |rel| {
                    if rel == entry_norm {
                        return Some(src.clone());
                    }
                    let full = root.join(rel);
                    let f_uri = path_to_uri(&full);
                    if let Some(open) = self.docs.get(&f_uri) {
                        return Some(open.clone());
                    }
                    std::fs::read_to_string(full).ok()
                })
                .and_then(|files| crate::project::compile_files(&files));
                return res;
            }
        }
        crate::compile(&src)
    }

    fn diagnostics_notification(&self, uri: &str) -> Value {
        let mut diagnostics = Vec::new();
        if let Err(err) = self.compile_uri(uri) {
            let line = err.line.saturating_sub(1);
            let col = err.col.saturating_sub(1);
            diagnostics.push(json!({
                "range": {
                    "start": { "line": line, "character": col },
                    "end": { "line": line, "character": col + 1 }
                },
                "severity": 1,
                "source": "foar",
                "message": err.message
            }));
        }
        json!({
            "jsonrpc": "2.0",
            "method": "textDocument/publishDiagnostics",
            "params": {
                "uri": uri,
                "diagnostics": diagnostics
            }
        })
    }

    fn collect_symbols(&self, uri: &str) -> Vec<SymbolInfo> {
        let mut out = Vec::new();
        let Some(src) = self.docs.get(uri) else { return out };
        for (line_idx, raw) in src.lines().enumerate() {
            let trimmed = raw.trim_start();
            let indent = raw.len() - trimmed.len();
            let rest_ident = |prefix: &str| -> Option<(String, usize)> {
                let after = trimmed.strip_prefix(prefix)?;
                let after = after.trim_start();
                let ident: String = after.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                if ident.is_empty() {
                    None
                } else {
                    let col = raw.find(&ident).unwrap_or(indent);
                    Some((ident, col))
                }
            };
            if let Some((name, col)) = rest_ident("view ") {
                out.push(SymbolInfo { kind: "view", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("data ") {
                out.push(SymbolInfo { kind: "data", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("enum ") {
                out.push(SymbolInfo { kind: "enum", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("extern fn ") {
                out.push(SymbolInfo { kind: "extern fn", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("fn ") {
                out.push(SymbolInfo { kind: "fn", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("context ") {
                out.push(SymbolInfo { kind: "context", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            } else if let Some((name, col)) = rest_ident("state ") {
                out.push(SymbolInfo { kind: "state", name, detail: trimmed.to_string(), line: line_idx, col, uri: uri.to_string() });
            }
        }
        out
    }

    fn word_at(&self, uri: &str, line: usize, col: usize) -> Option<String> {
        let src = self.docs.get(uri)?;
        let text = src.lines().nth(line)?;
        let bytes = text.as_bytes();
        let mut idx = col.min(bytes.len());
        if idx == bytes.len() && idx > 0 {
            idx -= 1;
        }
        let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        if !bytes.get(idx).is_some_and(|&b| is_word(b)) {
            if idx > 0 && bytes.get(idx - 1).is_some_and(|&b| is_word(b)) {
                idx -= 1;
            } else {
                return None;
            }
        }
        let mut start = idx;
        while start > 0 && is_word(bytes[start - 1]) {
            start -= 1;
        }
        let mut end = idx;
        while end < bytes.len() && is_word(bytes[end]) {
            end += 1;
        }
        Some(text[start..end].to_string())
    }

    fn completions(&self, uri: &str, line: usize, col: usize) -> Vec<Value> {
        let mut items = Vec::new();
        // Check if cursor follows `EnumName.` -> offer enum variants!
        if let Some(src) = self.docs.get(uri) {
            if let Some(l) = src.lines().nth(line) {
                let prefix = &l[..col.min(l.len())];
                if let Some(before_dot) = prefix.strip_suffix('.') {
                    let ename: String = before_dot
                        .chars()
                        .rev()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect();
                    if let Ok(prog) = self.compile_uri(uri) {
                        if let Some(en) = prog.enums.iter().find(|e| e.name == ename) {
                            for v in &en.variants {
                                let detail = match &v.payload_type {
                                    Some(pt) => format!("{}.{}({})", en.name, v.name, pt),
                                    None => format!("{}.{}", en.name, v.name),
                                };
                                items.push(json!({
                                    "label": v.name,
                                    "kind": 20, // EnumMember
                                    "detail": detail
                                }));
                            }
                            return items;
                        }
                    }
                }
            }
        }

        for &(kw, doc) in KEYWORDS {
            items.push(json!({ "label": kw, "kind": 14, "detail": "keyword", "documentation": doc }));
        }
        for &(el, doc) in BUILTIN_ELEMENTS {
            items.push(json!({ "label": el, "kind": 7, "detail": "FOAR built-in element", "documentation": doc }));
        }
        for sym in self.collect_symbols(uri) {
            let kind = match sym.kind {
                "view" => 7,
                "data" => 22,
                "enum" => 13,
                "extern fn" => 3,
                _ => 6,
            };
            items.push(json!({
                "label": sym.name,
                "kind": kind,
                "detail": sym.detail
            }));
        }
        items
    }

    fn hover(&self, uri: &str, line: usize, col: usize) -> Value {
        let Some(word) = self.word_at(uri, line, col) else { return Value::Null };
        if let Some((_, doc)) = BUILTIN_ELEMENTS.iter().find(|(k, _)| *k == word) {
            return json!({ "contents": { "kind": "markdown", "value": format!("**`{}`** (FOAR built-in)\n\n{}", word, doc) } });
        }
        if let Some((_, doc)) = KEYWORDS.iter().find(|(k, _)| *k == word) {
            return json!({ "contents": { "kind": "markdown", "value": format!("**`{}`** (keyword)\n\n{}", word, doc) } });
        }
        if let Some(sym) = self.collect_symbols(uri).into_iter().find(|s| s.name == word) {
            return json!({ "contents": { "kind": "markdown", "value": format!("```foar\n{}\n```", sym.detail) } });
        }
        Value::Null
    }

    fn definition(&self, uri: &str, line: usize, col: usize) -> Value {
        let Some(word) = self.word_at(uri, line, col) else { return Value::Null };
        if let Some(sym) = self.collect_symbols(uri).into_iter().find(|s| s.name == word) {
            return json!({
                "uri": sym.uri,
                "range": {
                    "start": { "line": sym.line, "character": sym.col },
                    "end": { "line": sym.line, "character": sym.col + sym.name.len() }
                }
            });
        }
        Value::Null
    }
}
