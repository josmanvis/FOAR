//! Multi-file programs.
//!
//! A program is an entry file plus everything it imports, transitively:
//!
//! ```foar
//! import "./components/NoteRow.foar"
//! import "./theme"            // ".foar" may be left out
//! ```
//!
//! Paths starting with `./` or `../` are relative to the importing file, any
//! other path is relative to the project root (the entry file's folder). Views,
//! data types and named styles are global by name, so an import only says
//! "this file is part of the program". Order: the entry file first (its first
//! view is the root view), then imports depth-first in the order written.
//!
//! The files are compiled as one source; errors are mapped back to the file,
//! line and column they came from.
use crate::ast::Program;
use crate::lexer::{lex, unescape, Kind};
use crate::parser::CompileError;
use std::collections::HashSet;

#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceFile {
    pub path: String,
    #[serde(skip)]
    pub src: String,
    /// Project paths this file imports (resolved).
    pub imports: Vec<String>,
}

/// `import "<spec>"` statements at the top level of `src`: (spec, byte offset of the string).
pub fn imports_in(src: &str) -> Vec<(String, usize)> {
    let Ok(toks) = lex(src) else { return Vec::new() };
    let mut out = Vec::new();
    let mut depth = 0i32;
    for (i, t) in toks.iter().enumerate() {
        let text = &src[t.start..t.end];
        match (t.kind, text) {
            (Kind::Punct, "{") => depth += 1,
            (Kind::Punct, "}") => depth -= 1,
            (Kind::Ident, "import") if depth == 0 => {
                if let Some(s) = toks.get(i + 1).filter(|s| s.kind == Kind::Str) {
                    out.push((unescape(&src[s.start..s.end]), s.start));
                }
            }
            _ => {}
        }
    }
    out
}

/// Normalizes `spec` imported from `from` to a project path (`a/b/C.foar`).
pub fn resolve(from: &str, spec: &str) -> Result<String, String> {
    if spec.is_empty() {
        return Err("empty import path".into());
    }
    if spec.starts_with('/') || spec.contains('\\') || spec.contains("://") {
        return Err(format!("import \"{}\": use a path relative to the file or the project root", spec));
    }
    let mut parts: Vec<&str> = Vec::new();
    if spec.starts_with("./") || spec.starts_with("../") {
        parts.extend(from.split('/'));
        parts.pop(); // the importing file's name
    }
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(format!("import \"{}\" points outside the project", spec));
                }
            }
            s => parts.push(s),
        }
    }
    let mut path = parts.join("/");
    if !path.ends_with(".foar") {
        path.push_str(".foar");
    }
    Ok(path)
}

fn located(file: &str, src: &str, at: usize, message: String) -> CompileError {
    let at = at.min(src.len());
    let line = src[..at].matches('\n').count() + 1;
    let col = at - src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    CompileError { message, line, col, file: Some(file.to_string()), offset: at }
}

/// Loads `entry` and its imports through `load(path) -> Option<source>`.
pub fn load(entry: &str, load: &mut dyn FnMut(&str) -> Option<String>) -> Result<Vec<SourceFile>, CompileError> {
    let entry = resolve("", entry).map_err(|m| CompileError { message: m, line: 0, col: 0, file: None, offset: 0 })?;
    let Some(src) = load(&entry) else {
        return Err(CompileError { message: format!("cannot read {}", entry), line: 0, col: 0, file: Some(entry), offset: 0 });
    };
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(entry.clone());
    visit(entry, src, load, &mut seen, &mut files)?;
    Ok(files)
}

fn visit(
    path: String,
    src: String,
    load: &mut dyn FnMut(&str) -> Option<String>,
    seen: &mut HashSet<String>,
    files: &mut Vec<SourceFile>,
) -> Result<(), CompileError> {
    let mut children = Vec::new();
    let mut imports = Vec::new();
    for (spec, at) in imports_in(&src) {
        let target = resolve(&path, &spec).map_err(|m| located(&path, &src, at, m))?;
        imports.push(target.clone());
        if !seen.insert(target.clone()) {
            continue; // already part of the program (imports may be shared or circular)
        }
        let Some(child) = load(&target) else {
            return Err(located(&path, &src, at, format!("cannot find \"{}\" ({})", spec, target)));
        };
        children.push((target, child));
    }
    files.push(SourceFile { path, src, imports });
    for (p, s) in children {
        visit(p, s, load, seen, files)?;
    }
    Ok(())
}

/// Compiles loaded files as one program.
pub fn compile_files(files: &[SourceFile]) -> Result<Program, CompileError> {
    let mut joined = String::new();
    let mut starts = Vec::with_capacity(files.len());
    for f in files {
        starts.push(joined.len());
        joined.push_str(&f.src);
        joined.push('\n');
    }
    crate::compile(&joined).map_err(|e| {
        let i = starts.partition_point(|&s| s <= e.offset).saturating_sub(1);
        match files.get(i) {
            Some(f) => located(&f.path, &f.src, e.offset - starts[i], e.message),
            None => e,
        }
    })
}

/// `{"entry": "app.foar", "files": {"app.foar": "...", ...}}` -> program JSON
/// (with `files`: the files in the program and what each imports) or `{"error": ...}`.
pub fn compile_project_json(input: &str) -> String {
    #[derive(serde::Deserialize)]
    struct Input {
        entry: String,
        files: std::collections::HashMap<String, String>,
    }
    let input: Input = match serde_json::from_str(input) {
        Ok(i) => i,
        Err(e) => return serde_json::json!({ "error": { "message": format!("bad project: {}", e), "line": 0, "col": 0 } }).to_string(),
    };
    let result = load(&input.entry, &mut |p| input.files.get(p).cloned()).and_then(|files| Ok((compile_files(&files)?, files)));
    match result {
        Ok((program, files)) => {
            let mut v = serde_json::to_value(&program).unwrap();
            v["files"] = serde_json::to_value(&files).unwrap();
            v.to_string()
        }
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn project(files: &[(&str, &str)]) -> HashMap<String, String> {
        files.iter().map(|(p, s)| (p.to_string(), s.to_string())).collect()
    }

    #[test]
    fn resolves_paths() {
        assert_eq!(resolve("app.foar", "./components/Row").unwrap(), "components/Row.foar");
        assert_eq!(resolve("components/Row.foar", "./Chip.foar").unwrap(), "components/Chip.foar");
        assert_eq!(resolve("components/Row.foar", "../theme").unwrap(), "theme.foar");
        assert_eq!(resolve("components/Row.foar", "theme.foar").unwrap(), "theme.foar");
        assert!(resolve("app.foar", "../x").is_err());
        assert!(resolve("app.foar", "/etc/x").is_err());
    }

    #[test]
    fn compiles_imports_in_order_with_mapped_errors() {
        let files = project(&[
            ("app.foar", "import \"./ui/Row\"\nimport \"./theme\"\nview App { state Ready { render { Row(name: \"a\") } } }"),
            ("ui/Row.foar", "import \"../theme\" // shared + circular is fine\nview Row(name: String) { style { color: var(--ink); } state Idle { render { Text(name) } } }"),
            ("theme.foar", "import \"./app\"\ntheme { --ink: #222; }"),
        ]);
        let all = load("app.foar", &mut |p| files.get(p).cloned()).unwrap();
        assert_eq!(all.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app.foar", "ui/Row.foar", "theme.foar"]);
        let p = compile_files(&all).unwrap();
        assert_eq!(p.views[0].name, "App"); // entry's first view is the root
        assert_eq!(p.views[1].name, "Row");
        assert!(p.css.contains("--ink"));

        let broken = project(&[("app.foar", "import \"./b\"\nview App { state S { render { Text(\"x\") } } }"), ("b.foar", "\n\nview B {\n  state S { render { Text(\"x\") }\n")]);
        let e = load("app.foar", &mut |p| broken.get(p).cloned()).and_then(|f| compile_files(&f)).unwrap_err();
        assert_eq!(e.file.as_deref(), Some("b.foar"));
        assert!(e.line >= 4, "{:?}", e);

        let unknown = project(&[("app.foar", "import \"./b\"\nview A { state S { render { B() } } }"), ("b.foar", "view B { state S { render {\n  Column { Badge(label: \"x\") } } } }")]);
        let e = load("app.foar", &mut |p| unknown.get(p).cloned()).and_then(|f| compile_files(&f)).unwrap_err();
        assert_eq!((e.file.as_deref(), e.line, e.col), (Some("b.foar"), 2, 12), "{:?}", e);
        assert!(e.message.contains("Unknown view or element 'Badge'"));

        let missing = project(&[("app.foar", "\nimport \"./nope\"\n")]);
        let e = load("app.foar", &mut |p| missing.get(p).cloned()).unwrap_err();
        assert_eq!((e.file.as_deref(), e.line, e.col), (Some("app.foar"), 2, 8));

        let dup = project(&[("app.foar", "import \"./b\"\nview A { state S { render { Text(\"x\") } } }"), ("b.foar", "view A { state S { render { Text(\"y\") } } }")]);
        let e = load("app.foar", &mut |p| dup.get(p).cloned()).and_then(|f| compile_files(&f)).unwrap_err();
        assert_eq!((e.file.as_deref(), e.line), (Some("b.foar"), 1));
        assert!(e.message.contains("already declared"));

        let json = compile_project_json(&serde_json::json!({ "entry": "app.foar", "files": files }).to_string());
        assert!(json.contains("\"files\":[{\"path\":\"app.foar\",\"imports\":[\"ui/Row.foar\",\"theme.foar\"]}"), "{}", json);
    }
}
