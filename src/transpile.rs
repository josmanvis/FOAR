//! Rust-flavoured FOAR expressions/statements -> JavaScript.
//! Same rewrite rules (and order) as the original JS compiler.
use regex::Regex;
use std::sync::OnceLock;

struct Rules {
    if_let_find: Regex,
    retain: Regex,
    closure: Regex,
    contains: Regex,
    is_empty: Regex,
    struct_lit: Regex,
    let_mut: Regex,
    async_transition: Regex,
    transition: Regex,
    emit: Regex,
    if_no_parens: Regex,
    if_let_some: Regex,
    for_in: Regex,
    while_no_parens: Regex,
    loop_kw: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        if_let_find: Regex::new(r"if[ \t\r\n]+let[ \t\r\n]+Some[ \t\r\n]*\([ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\)[ \t\r\n]*=[ \t\r\n]*([a-zA-Z0-9_.]+)[ \t\r\n]*\.[ \t\r\n]*find_index[ \t\r\n]*\([ \t\r\n]*\|[ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\|[ \t\r\n]*([^)]+)\)").unwrap(),
        retain: Regex::new(r"([a-zA-Z0-9_]+)[ \t\r\n]*\.[ \t\r\n]*retain[ \t\r\n]*\([ \t\r\n]*\|[ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\|[ \t\r\n]*([^)]+)\)").unwrap(),
        // only after `(`, `,`, `=` or `[` so that `a || b || c` is left alone
        closure: Regex::new(r"([(,=\[][ \t\r\n]*)\|[ \t\r\n]*([a-zA-Z0-9_,[ \t\r\n]]+?)[ \t\r\n]*\|[ \t\r\n]*").unwrap(),
        contains: Regex::new(r"\.contains[ \t\r\n]*\(([^)]+)\)").unwrap(),
        is_empty: Regex::new(r"([a-zA-Z0-9_.]+)\.is_empty[ \t\r\n]*\([ \t\r\n]*\)").unwrap(),
        struct_lit: Regex::new(r"([=(,\[])[ \t\r\n]*[A-Z][a-zA-Z0-9_]*[ \t\r\n]*\{").unwrap(),
        let_mut: Regex::new(r"let[ \t\r\n]+mut[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*=[ \t\r\n]*([^;]+);").unwrap(),
        async_transition: Regex::new(r"([a-zA-Z0-9_]+)[ \t\r\n]*\(([^)]*)\)[ \t\r\n]*->[ \t\r\n]*transition[ \t\r\n]*\([ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\)[ \t\r\n]*;").unwrap(),
        transition: Regex::new(r"(?-u:\b)transition[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*;").unwrap(),
        emit: Regex::new(r"(?-u:\b)emit[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*\(([^)]*)\)[ \t\r\n]*;").unwrap(),
        // `if cond {` (no parens) -> `if (cond) {`
        if_no_parens: Regex::new(r"(?-u:\b)if[ \t\r\n]+([^({][^{]*)\{").unwrap(),
        // `if let Some(x) = expr {` (any expression)
        if_let_some: Regex::new(r"(?-u:\b)if[ \t\r\n]+let[ \t\r\n]+Some[ \t\r\n]*\([ \t\r\n]*([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]*\)[ \t\r\n]*=[ \t\r\n]*([^{]+?)[ \t\r\n]*\{").unwrap(),
        // `for x in items {` / `for i in 0..n {` / `for i in 1..=n {`
        for_in: Regex::new(r"(?-u:\b)for[ \t\r\n]+([A-Za-z_][A-Za-z0-9_]*)[ \t\r\n]+in[ \t\r\n]+([^{]+?)[ \t\r\n]*\{").unwrap(),
        while_no_parens: Regex::new(r"(?-u:\b)while[ \t\r\n]+([^({ \t\r\n][^{]*)\{").unwrap(),
        loop_kw: Regex::new(r"(?-u:\b)loop[ \t\r\n]*\{").unwrap(),
    })
}

pub fn rust_idioms_to_js(code: &str) -> String {
    let r = rules();
    let mut out = code.to_string();
    let has_if = out.contains("if");
    if has_if && out.contains("let") {
        if out.contains("find_index") {
            if let std::borrow::Cow::Owned(s) = r.if_let_find.replace_all(&out, "const ${1} = ${2}.findIndex((${3}) => ${4}); if (${1} !== -1)") {
                out = s;
            }
        }
        if out.contains("Some") {
            if let std::borrow::Cow::Owned(s) = r.if_let_some.replace_all(&out, "let ${1}; if ((${1} = (${2})) != null) {") {
                out = s;
            }
        }
    }
    if out.contains("for") {
        if let std::borrow::Cow::Owned(s) = r.for_in.replace_all(&out, |c: &regex::Captures| {
            let (var, src) = (&c[1], c[2].trim());
            match src.split_once("..") {
                Some((a, b)) if !a.is_empty() && !b.is_empty() && !a.contains('(') => {
                    let (op, b) = match b.strip_prefix('=') {
                        Some(b) => ("<=", b),
                        None => ("<", b),
                    };
                    format!("for (let {v} = {a}; {v} {op} {b}; {v}++) {{", v = var, a = a.trim(), b = b.trim(), op = op)
                }
                _ => format!("for (const {} of {}) {{", var, src),
            }
        }) {
            out = s;
        }
    }
    if out.contains("while") {
        if let std::borrow::Cow::Owned(s) = r.while_no_parens.replace_all(&out, |c: &regex::Captures| format!("while ({}) {{", c[1].trim())) {
            out = s;
        }
    }
    if out.contains("loop") {
        if let std::borrow::Cow::Owned(s) = r.loop_kw.replace_all(&out, "while (true) {") {
            out = s;
        }
    }
    if out.contains("retain") {
        if let std::borrow::Cow::Owned(s) = r.retain.replace_all(&out, "${1} = ${1}.filter((${2}) => ${3})") {
            out = s;
        }
    }
    if out.contains('|') {
        if let std::borrow::Cow::Owned(s) = r.closure.replace_all(&out, "${1}(${2}) => ") {
            out = parenthesize_object_bodies(&s);
        }
    }
    if out.contains("contains") {
        if let std::borrow::Cow::Owned(s) = r.contains.replace_all(&out, ".toLowerCase().includes(String(${1}).toLowerCase())") {
            out = s;
        }
    }
    if out.contains("is_empty") {
        if let std::borrow::Cow::Owned(s) = r.is_empty.replace_all(&out, "(${1}.trim().length === 0)") {
            out = s;
        }
    }
    if out.contains('{') {
        if let std::borrow::Cow::Owned(s) = r.struct_lit.replace_all(&out, "${1} {") {
            out = s;
        }
    }
    if out.contains("let") && out.contains("mut") {
        if let std::borrow::Cow::Owned(s) = r.let_mut.replace_all(&out, "let ${1} = structuredClone(${2});") {
            out = s;
        }
    }
    if out.contains("transition") {
        if out.contains("->") {
            if let std::borrow::Cow::Owned(s) = r.async_transition.replace_all(&out, "__asyncTransition(\"${1}\", [${2}], \"${3}\");") {
                out = s;
            }
        }
        if let std::borrow::Cow::Owned(s) = r.transition.replace_all(&out, "__transition(\"${1}\");") {
            out = s;
        }
    }
    if out.contains("emit") {
        if let std::borrow::Cow::Owned(s) = r.emit.replace_all(&out, "__emit(\"${1}\", ${2});") {
            out = s;
        }
    }
    if has_if && out.contains('{') {
        if let std::borrow::Cow::Owned(s) = r.if_no_parens.replace_all(&out, |c: &regex::Captures| format!("if ({}) {{", c[1].trim())) {
            out = s;
        }
    }
    out
}

/// A string literal -> JS source. `"Count: {count}"` becomes a template literal.
pub fn string_literal_to_js(value: &str) -> String {
    if value.contains('{') {
        static INTERP: OnceLock<Regex> = OnceLock::new();
        let re = INTERP.get_or_init(|| Regex::new(r"\{([a-zA-Z0-9_.]+)\}").unwrap());
        if re.is_match(value) {
            let escaped = value.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
            return format!("`{}`", re.replace_all(&escaped, "$${${1}}"));
        }
    }
    serde_json::to_string(value).unwrap()
}

/// `|i| { ...i, done: true }` is an object literal, but JavaScript reads
/// `(i) => { ...i }` as a block: wrap such bodies as `(i) => ({ ... })`.
fn parenthesize_object_bodies(src: &str) -> String {
    parenthesize_object_bodies_utf8(src)
}

/// Walks by character, so string contents in any script are copied intact.
fn parenthesize_object_bodies_utf8(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 8);
    let mut closers: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < src.len() {
        if src[i..].starts_with("=> {") && starts_object_literal(&src[i + 4..]) {
            if let Some(close) = matching_brace(src, i + 3) {
                closers.push(close);
                out.push_str("=> ({");
                i += 4;
                continue;
            }
        }
        let ch = src[i..].chars().next().unwrap();
        out.push(ch);
        if closers.last() == Some(&i) {
            closers.pop();
            out.push(')');
        }
        i += ch.len_utf8();
    }
    out
}

/// After `{`: `...x`, `key:`, `"key":` or `}` (an empty object).
fn starts_object_literal(rest: &str) -> bool {
    let t = rest.trim_start();
    if t.starts_with("...") || t.starts_with('}') {
        return true;
    }
    let key_end = if let Some(q) = t.strip_prefix('"') {
        q.find('"').map(|n| n + 2)
    } else {
        let n = t.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').count();
        (n > 0 && !t.as_bytes()[0].is_ascii_digit()).then_some(n)
    };
    match key_end {
        Some(n) => {
            let after = t[n..].trim_start();
            after.starts_with(':') && !after.starts_with("::")
        }
        None => false,
    }
}

/// Index of the `}` matching the `{` at `open`, skipping strings.
fn matching_brace(src: &str, open: usize) -> Option<usize> {
    let b = src.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < b.len() {
        let c = b[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else {
            match c {
                b'"' | b'\'' | b'`' => quote = Some(c),
                b'{' | b'(' | b'[' => depth += 1,
                b'}' | b')' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return (c == b'}').then_some(i);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idioms() {
        assert_eq!(rust_idioms_to_js("transition Active;"), "__transition(\"Active\");");
        assert_eq!(rust_idioms_to_js("emit update(new_item);"), "__emit(\"update\", new_item);");
        assert_eq!(rust_idioms_to_js("api_save(count) -> transition(Saving);"), "__asyncTransition(\"api_save\", [count], \"Saving\");");
        assert_eq!(rust_idioms_to_js("todos.retain(|t| t.id != id);"), "todos = todos.filter((t) => t.id != id);");
        assert_eq!(rust_idioms_to_js("if draft.is_empty() { return; }"), "if (draft.trim().length === 0) { return; }");
        assert_eq!(rust_idioms_to_js("if !x.is_empty() { a; }"), "if (!(x.trim().length === 0)) { a; }");
        assert_eq!(rust_idioms_to_js("let mut n = item;"), "let n = structuredClone(item);");
        assert_eq!(rust_idioms_to_js("x = [Todo { id: 1 }, Todo { id: 2 }];"), "x = [ { id: 1 }, { id: 2 }];");
        assert_eq!(rust_idioms_to_js("a || b || c"), "a || b || c");
        assert_eq!(rust_idioms_to_js("xs.sort(|a, b| a.x || b.x)"), "xs.sort((a, b) => a.x || b.x)");
        assert_eq!(rust_idioms_to_js("let f = |n| n + 1;"), "let f = (n) => n + 1;");
        assert_eq!(rust_idioms_to_js("items.map(|i| { ...i, done: true })"), "items.map((i) => ({ ...i, done: true }))");
        assert_eq!(rust_idioms_to_js("xs.map(|x| { id: x.id, n: { a: 1 } })"), "xs.map((x) => ({ id: x.id, n: { a: 1 } }))");
        assert_eq!(rust_idioms_to_js("xs.map(|x| { \"k\": \"}é\" })"), "xs.map((x) => ({ \"k\": \"}é\" }))");
        assert_eq!(rust_idioms_to_js("xs.map(|x| { let y = x; y })"), "xs.map((x) => { let y = x; y })");
        assert_eq!(rust_idioms_to_js("xs.map(|x| {})"), "xs.map((x) => ({}))");
        assert_eq!(rust_idioms_to_js("todos.filter(|t| t.text.contains(q))"), "todos.filter((t) => t.text.toLowerCase().includes(String(q).toLowerCase()))");
    }
    #[test]
    fn strings() {
        assert_eq!(string_literal_to_js("plain"), "\"plain\"");
        assert_eq!(string_literal_to_js("Count: {count}"), "`Count: ${count}`");
    }
}
