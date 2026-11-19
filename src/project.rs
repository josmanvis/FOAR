//! Multi-file programs and `foar.toml` package resolution.
//!
//! A program is an entry file plus everything it imports, transitively:
//!
//! ```foar
//! import "./components/NoteRow.foar"
//! import "./theme"            // ".foar" may be left out
//! import "@ui/Button"         // package declared in foar.toml or foar_packages/
//! ```
//!
//! Paths starting with `./` or `../` are relative to the importing file;
//! `@pkg` / `@pkg/Sub` resolves through `foar.toml` `[dependencies]` (or
//! `foar_packages/<pkg>/`); any other path is relative to the project root.
//! Views, data types, enums, externs, and named styles are global by name.
//! Order: the entry file first (its first view is the root view), then imports
//! depth-first in the order written.
use crate::ast::Program;
use crate::lexer::{lex, unescape, Kind};
use crate::parser::CompileError;
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub entry: String,
    pub dependencies: BTreeMap<String, DepSpec>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct DepSpec {
    pub path: Option<String>,
    pub git: Option<String>,
    pub version: Option<String>,
    pub registry: Option<String>,
    pub entry: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Lockfile {
    pub version: u32,
    pub packages: Vec<LockedPackage>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LockedPackage {
    pub name: String,
    pub version: String,
    pub source: String,
    pub path: String,
    pub integrity: String,
}

/// Pure-Rust SHA-256 returning lowercase 64-char hex digest (no external crate).
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks_exact(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (slot, delta) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(delta);
        }
    }
    let mut out = String::with_capacity(64);
    for word in h {
        out.push_str(&format!("{:08x}", word));
    }
    out
}

/// Parse a `foar.lock` file (`version = 1` + `[[package]]` entries).
pub fn parse_lockfile(src: &str) -> Lockfile {
    let mut lock = Lockfile { version: 1, packages: Vec::new() };
    let mut cur: Option<LockedPackage> = None;
    for raw in src.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line == "[[package]]" {
            if let Some(p) = cur.take() {
                lock.packages.push(p);
            }
            cur = Some(LockedPackage::default());
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let key = k.trim();
        let val = unquote(v.trim());
        if let Some(p) = &mut cur {
            match key {
                "name" => p.name = val,
                "version" => p.version = val,
                "source" => p.source = val,
                "path" => p.path = val,
                "integrity" => p.integrity = val,
                _ => {}
            }
        } else if key == "version" {
            if let Ok(vnum) = val.parse::<u32>() {
                lock.version = vnum;
            }
        }
    }
    if let Some(p) = cur.take() {
        lock.packages.push(p);
    }
    lock
}

/// Render a deterministic `foar.lock` file.
pub fn render_lockfile(lock: &Lockfile) -> String {
    let mut out = format!("# Auto-generated by foar — commit to version control.\nversion = {}\n", lock.version.max(1));
    let mut pkgs = lock.packages.clone();
    pkgs.sort_by(|a, b| a.name.cmp(&b.name));
    for p in pkgs {
        out.push_str("\n[[package]]\n");
        out.push_str(&format!("name = \"{}\"\n", p.name));
        out.push_str(&format!("version = \"{}\"\n", p.version));
        out.push_str(&format!("source = \"{}\"\n", p.source));
        out.push_str(&format!("path = \"{}\"\n", p.path));
        out.push_str(&format!("integrity = \"{}\"\n", p.integrity));
    }
    out
}

/// Deterministic SHA-256 integrity hash over a package directory's `.foar` and `foar.toml` files.
#[cfg(not(target_arch = "wasm32"))]
pub fn hash_package_dir(dir: &std::path::Path) -> Result<String, String> {
    if !dir.is_dir() {
        return Err(format!("package directory '{}' does not exist", dir.display()));
    }
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    fn walk(base: &std::path::Path, cur: &std::path::Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
        let rd = std::fs::read_dir(cur).map_err(|e| format!("cannot read {}: {}", cur.display(), e))?;
        for ent in rd.flatten() {
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, out)?;
            } else if name.ends_with(".foar") || name == "foar.toml" {
                let rel = p.strip_prefix(base).unwrap_or(&p).to_string_lossy().replace('\\', "/");
                let bytes = std::fs::read(&p).map_err(|e| format!("cannot read {}: {}", p.display(), e))?;
                out.push((rel, bytes));
            }
        }
        Ok(())
    }
    walk(dir, dir, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut buf = Vec::new();
    for (rel, bytes) in entries {
        buf.extend_from_slice(rel.as_bytes());
        buf.push(0);
        buf.extend_from_slice(&(bytes.len() as u64).to_be_bytes());
        buf.push(0);
        buf.extend_from_slice(&bytes);
        buf.push(0);
    }
    Ok(format!("sha256-{}", sha256_hex(&buf)))
}

/// Verify every package in `foar.lock` matches the current files on disk.
#[cfg(not(target_arch = "wasm32"))]
pub fn verify_lockfile(root: &std::path::Path, lock: &Lockfile) -> Result<Vec<String>, Vec<String>> {
    let mut verified = Vec::new();
    let mut errors = Vec::new();
    for p in &lock.packages {
        let dir = root.join(&p.path);
        match hash_package_dir(&dir) {
            Ok(actual) if actual == p.integrity => {
                verified.push(format!("@{} ({}) {}", p.name, p.version, &actual[..19.min(actual.len())]));
            }
            Ok(actual) => {
                errors.push(format!(
                    "@{} integrity mismatch: expected {}, got {}",
                    p.name, p.integrity, actual
                ));
            }
            Err(e) => errors.push(format!("@{}: {}", p.name, e)),
        }
    }
    if errors.is_empty() { Ok(verified) } else { Err(errors) }
}

/// Parses a minimal `foar.toml` manifest (`[package]` and `[dependencies]`).
pub fn parse_manifest(src: &str) -> Manifest {
    let mut m = Manifest { entry: "app.foar".to_string(), ..Default::default() };
    let mut section = String::new();
    for raw in src.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            continue;
        }
        let Some((k, v)) = line.split_once('=') else { continue };
        let key = k.trim().trim_matches('"').to_string();
        let val = v.trim();
        match section.as_str() {
            "package" => {
                let s = unquote(val);
                match key.as_str() {
                    "name" => m.name = s,
                    "version" => m.version = s,
                    "entry" => m.entry = s,
                    _ => {}
                }
            }
            "dependencies" => {
                let mut dep = DepSpec::default();
                if val.starts_with('{') && val.ends_with('}') {
                    for part in val[1..val.len() - 1].split(',') {
                        if let Some((dk, dv)) = part.split_once('=') {
                            let dval = unquote(dv.trim());
                            match dk.trim() {
                                "path" => dep.path = Some(dval),
                                "git" => dep.git = Some(dval),
                                "version" => dep.version = Some(dval),
                                "registry" => dep.registry = Some(dval),
                                "entry" => dep.entry = Some(dval),
                                _ => {}
                            }
                        }
                    }
                } else {
                    let s = unquote(val);
                    if s.starts_with('.') || s.contains('/') {
                        dep.path = Some(s);
                    } else {
                        dep.version = Some(s);
                    }
                }
                m.dependencies.insert(key, dep);
            }
            _ => {}
        }
    }
    m
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"')) || (s.starts_with('\'') && s.ends_with('\'')) {
        if s.len() >= 2 {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

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
        return Err(format!("import \"{}\": use a path relative to the file, project root, or @package", spec));
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

/// Resolves a package import (`@pkg` or `@pkg/Module`) to candidate relative file paths.
pub fn package_candidates(spec: &str, manifest: Option<&Manifest>) -> Result<Vec<String>, String> {
    let body = spec.strip_prefix('@').ok_or_else(|| "not a package import".to_string())?;
    if body.is_empty() || body.contains("..") || body.contains('\\') {
        return Err(format!("invalid package import \"{}\"", spec));
    }
    let (pkg, sub) = match body.split_once('/') {
        Some((p, s)) if !s.is_empty() => (p, Some(s)),
        Some((p, _)) => (p, None),
        None => (body, None),
    };
    let mut bases = Vec::new();
    let mut custom_entry: Option<String> = None;
    if let Some(m) = manifest {
        if let Some(dep) = m.dependencies.get(pkg) {
            if let Some(p) = &dep.path {
                bases.push(p.trim_start_matches("./").trim_end_matches('/').to_string());
            }
            custom_entry = dep.entry.clone();
        }
    }
    bases.push(format!("foar_packages/{}", pkg));
    bases.push(format!("packages/{}", pkg));

    let mut out = Vec::new();
    for base in bases {
        let prefix = if base.is_empty() { String::new() } else { format!("{}/", base) };
        if let Some(sub) = sub {
            let file = if sub.ends_with(".foar") { sub.to_string() } else { format!("{}.foar", sub) };
            out.push(format!("{}{}", prefix, file));
            out.push(format!("{}src/{}", prefix, file));
        } else {
            if let Some(e) = &custom_entry {
                out.push(format!("{}{}", prefix, e));
            }
            out.push(format!("{}index.foar", prefix));
            out.push(format!("{}lib.foar", prefix));
            out.push(format!("{}src/index.foar", prefix));
            out.push(format!("{}src/lib.foar", prefix));
            out.push(format!("{}app.foar", prefix));
        }
    }
    Ok(out)
}

fn located(file: &str, src: &str, at: usize, message: String) -> CompileError {
    let at = at.min(src.len());
    let line = src[..at].matches('\n').count() + 1;
    let col = at - src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    CompileError { message, line, col, file: Some(file.to_string()), offset: at }
}

/// Loads `entry` and its imports through `load(path) -> Option<source>`.
/// Automatically reads `foar.toml` (if present through `load("foar.toml")`) to
/// resolve `@package` imports.
pub fn load(entry: &str, load: &mut dyn FnMut(&str) -> Option<String>) -> Result<Vec<SourceFile>, CompileError> {
    let manifest = load("foar.toml").map(|s| parse_manifest(&s));
    let entry = resolve("", entry).map_err(|m| CompileError { message: m, line: 0, col: 0, file: None, offset: 0 })?;
    let Some(src) = load(&entry) else {
        return Err(CompileError { message: format!("cannot read {}", entry), line: 0, col: 0, file: Some(entry), offset: 0 });
    };
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(entry.clone());
    visit(entry, src, manifest.as_ref(), load, &mut seen, &mut files)?;
    Ok(files)
}

fn visit(
    path: String,
    src: String,
    manifest: Option<&Manifest>,
    load: &mut dyn FnMut(&str) -> Option<String>,
    seen: &mut HashSet<String>,
    files: &mut Vec<SourceFile>,
) -> Result<(), CompileError> {
    let mut children = Vec::new();
    let mut imports = Vec::new();
    for (spec, at) in imports_in(&src) {
        let (target, preloaded) = if spec.starts_with('@') {
            let cands = package_candidates(&spec, manifest).map_err(|m| located(&path, &src, at, m))?;
            let mut found = None;
            for c in &cands {
                if seen.contains(c) {
                    found = Some((c.clone(), None));
                    break;
                }
                if let Some(s) = load(c) {
                    found = Some((c.clone(), Some(s)));
                    break;
                }
            }
            match found {
                Some(pair) => pair,
                None => {
                    return Err(located(
                        &path,
                        &src,
                        at,
                        format!("cannot resolve package \"{}\" (declare it in foar.toml [dependencies] or install under foar_packages/)", spec),
                    ));
                }
            }
        } else {
            let t = resolve(&path, &spec).map_err(|m| located(&path, &src, at, m))?;
            (t, None)
        };
        imports.push(target.clone());
        if !seen.insert(target.clone()) {
            continue; // already part of the program (imports may be shared or circular)
        }
        let child = match preloaded {
            Some(s) => s,
            None => match load(&target) {
                Some(s) => s,
                None => return Err(located(&path, &src, at, format!("cannot find \"{}\" ({})", spec, target))),
            },
        };
        children.push((target, child));
    }
    files.push(SourceFile { path, src, imports });
    for (p, s) in children {
        visit(p, s, manifest, load, seen, files)?;
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
    fn resolves_foar_toml_packages() {
        let files = project(&[
            ("foar.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n\n[dependencies]\nui = { path = \"./vendor/ui\" }\n"),
            ("app.foar", "import \"@ui/Badge\"\nview App { state Ready { render { Badge(label: \"ok\") } } }"),
            ("vendor/ui/Badge.foar", "view Badge(label: String) { state Ready { render { Text(label) } } }"),
        ]);
        let all = load("app.foar", &mut |p| files.get(p).cloned()).unwrap();
        assert_eq!(all.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app.foar", "vendor/ui/Badge.foar"]);
        let p = compile_files(&all).unwrap();
        assert_eq!(p.views.len(), 2);

        let missing = project(&[("app.foar", "import \"@nope/Widget\"\nview App { state Ready { render { Text(\"x\") } } }")]);
        let err = load("app.foar", &mut |p| missing.get(p).cloned()).unwrap_err();
        assert!(err.message.contains("cannot resolve package \"@nope/Widget\""), "{:?}", err);
    }

    #[test]
    fn compiles_imports_in_order_with_mapped_errors() {
        let files = project(&[
            ("app.foar", "import \"./ui/Row\"\nimport \"./theme\"\nview App { state Ready { render { Line(name: \"a\") } } }"),
            ("ui/Row.foar", "import \"../theme\" // shared + circular is fine\nview Line(name: String) { style { color: var(--ink); } state Idle { render { Text(name) } } }"),
            ("theme.foar", "import \"./app\"\ntheme { --ink: #222; }"),
        ]);
        let all = load("app.foar", &mut |p| files.get(p).cloned()).unwrap();
        assert_eq!(all.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app.foar", "ui/Row.foar", "theme.foar"]);
        let p = compile_files(&all).unwrap();
        assert_eq!(p.views[0].name, "App"); // entry's first view is the root
        assert_eq!(p.views[1].name, "Line");
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

    #[test]
    fn sha256_and_lockfile_integrity_verification() {
        // FIPS 180-4 SHA-256 test vector for "abc"
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let lock = Lockfile {
            version: 1,
            packages: vec![LockedPackage {
                name: "ui".to_string(),
                version: "1.2.0".to_string(),
                source: "path:./vendor/ui".to_string(),
                path: "vendor/ui".to_string(),
                integrity: "sha256-deadbeef".to_string(),
            }],
        };
        let rendered = render_lockfile(&lock);
        assert_eq!(parse_lockfile(&rendered), lock);

        // Verify disk hashing & tampering detection using a temp dir
        let tmp = std::env::temp_dir().join(format!("foar_lock_test_{}", std::process::id()));
        let pkg_dir = tmp.join("vendor/ui");
        std::fs::create_dir_all(&pkg_dir).unwrap();
        std::fs::write(pkg_dir.join("Badge.foar"), "view Badge(t: String) { state S { render { Text(t) } } }\n").unwrap();
        let integrity = hash_package_dir(&pkg_dir).unwrap();
        assert!(integrity.starts_with("sha256-"));
        let disk_lock = Lockfile {
            version: 1,
            packages: vec![LockedPackage {
                name: "ui".to_string(),
                version: "0.1.0".to_string(),
                source: "path:./vendor/ui".to_string(),
                path: "vendor/ui".to_string(),
                integrity: integrity.clone(),
            }],
        };
        assert!(verify_lockfile(&tmp, &disk_lock).is_ok());

        // Tamper with a file and ensure verify_lockfile catches it
        std::fs::write(pkg_dir.join("Badge.foar"), "view Badge(t: String) { state S { render { Text(\"tampered\") } } }\n").unwrap();
        let errs = verify_lockfile(&tmp, &disk_lock).unwrap_err();
        assert!(errs[0].contains("integrity mismatch"), "{:?}", errs);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
