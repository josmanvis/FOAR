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
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        if_let_find: Regex::new(r"if[ \t\r\n]+let[ \t\r\n]+Some[ \t\r\n]*\([ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\)[ \t\r\n]*=[ \t\r\n]*([a-zA-Z0-9_.]+)[ \t\r\n]*\.[ \t\r\n]*find_index[ \t\r\n]*\([ \t\r\n]*\|[ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\|[ \t\r\n]*([^)]+)\)").unwrap(),
        retain: Regex::new(r"([a-zA-Z0-9_]+)[ \t\r\n]*\.[ \t\r\n]*retain[ \t\r\n]*\([ \t\r\n]*\|[ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\|[ \t\r\n]*([^)]+)\)").unwrap(),
        closure: Regex::new(r"\|[ \t\r\n]*([a-zA-Z0-9_,[ \t\r\n]]+?)[ \t\r\n]*\|[ \t\r\n]*").unwrap(),
        contains: Regex::new(r"\.contains[ \t\r\n]*\(([^)]+)\)").unwrap(),
        is_empty: Regex::new(r"([a-zA-Z0-9_.]+)\.is_empty[ \t\r\n]*\([ \t\r\n]*\)").unwrap(),
        struct_lit: Regex::new(r"([=(,\[])[ \t\r\n]*[A-Z][a-zA-Z0-9_]*[ \t\r\n]*\{").unwrap(),
        let_mut: Regex::new(r"let[ \t\r\n]+mut[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*=[ \t\r\n]*([^;]+);").unwrap(),
        async_transition: Regex::new(r"([a-zA-Z0-9_]+)[ \t\r\n]*\(([^)]*)\)[ \t\r\n]*->[ \t\r\n]*transition[ \t\r\n]*\([ \t\r\n]*([a-zA-Z0-9_]+)[ \t\r\n]*\)[ \t\r\n]*;").unwrap(),
        transition: Regex::new(r"(?-u:\b)transition[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*;").unwrap(),
        emit: Regex::new(r"(?-u:\b)emit[ \t\r\n]+([a-zA-Z0-9_]+)[ \t\r\n]*\(([^)]*)\)[ \t\r\n]*;").unwrap(),
        // `if cond {` (no parens) -> `if (cond) {`
        if_no_parens: Regex::new(r"(?-u:\b)if[ \t\r\n]+([^({][^{]*)\{").unwrap(),
    })
}

pub fn rust_idioms_to_js(code: &str) -> String {
    let r = rules();
    let mut out = code.to_string();
    out = r.if_let_find.replace_all(&out, "const ${1} = ${2}.findIndex((${3}) => ${4}); if (${1} !== -1)").into_owned();
    out = r.retain.replace_all(&out, "${1} = ${1}.filter((${2}) => ${3})").into_owned();
    out = r.closure.replace_all(&out, "(${1}) => ").into_owned();
    out = r.contains.replace_all(&out, ".toLowerCase().includes(String(${1}).toLowerCase())").into_owned();
    out = r.is_empty.replace_all(&out, "(${1}.trim().length === 0)").into_owned();
    out = r.struct_lit.replace_all(&out, "${1} {").into_owned();
    out = r.let_mut.replace_all(&out, "let ${1} = structuredClone(${2});").into_owned();
    out = r.async_transition.replace_all(&out, "__asyncTransition(\"${1}\", [${2}], \"${3}\");").into_owned();
    out = r.transition.replace_all(&out, "__transition(\"${1}\");").into_owned();
    out = r.emit.replace_all(&out, "__emit(\"${1}\", ${2});").into_owned();
    out = r.if_no_parens.replace_all(&out, |c: &regex::Captures| format!("if ({}) {{", c[1].trim())).into_owned();
    out
}

/// A string literal -> JS source. `"Count: {count}"` becomes a template literal.
pub fn string_literal_to_js(value: &str) -> String {
    static INTERP: OnceLock<Regex> = OnceLock::new();
    let re = INTERP.get_or_init(|| Regex::new(r"\{([a-zA-Z0-9_.]+)\}").unwrap());
    if re.is_match(value) {
        let escaped = value.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");
        format!("`{}`", re.replace_all(&escaped, "$${${1}}"))
    } else {
        serde_json::to_string(value).unwrap()
    }
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
        assert_eq!(rust_idioms_to_js("todos.filter(|t| t.text.contains(q))"), "todos.filter((t) => t.text.toLowerCase().includes(String(q).toLowerCase()))");
    }
    #[test]
    fn strings() {
        assert_eq!(string_literal_to_js("plain"), "\"plain\"");
        assert_eq!(string_literal_to_js("Count: {count}"), "`Count: ${count}`");
    }
}
