//! FOAR compiler: .foar source -> JSON program (consumed by web/foar-runtime.js)
//! or a ready-to-import JS module. Builds natively and for wasm32.
pub mod ast;
pub mod css;
pub mod fmt;
pub mod i18n;
pub mod lexer;
#[cfg(not(target_arch = "wasm32"))]
pub mod lsp;
pub mod parser;
pub mod project;
pub mod transpile;
pub mod typecheck;
#[cfg(target_arch = "wasm32")]
pub mod wasm;

pub use parser::CompileError;

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

pub fn compile(src: &str) -> Result<ast::Program, CompileError> {
    parser::Parser::new(src)?.parse_program()
}

/// Program JSON, or `{"error":{"message","line","col"}}`.
pub fn compile_to_json(src: &str, pretty: bool) -> String {
    match compile(src) {
        Ok(p) => {
            if pretty { serde_json::to_string_pretty(&p).unwrap() } else { serde_json::to_string(&p).unwrap() }
        }
        Err(e) => serde_json::json!({ "error": e }).to_string(),
    }
}

/// An ES module that mounts, hydrates, or server-renders the program with the runtime.
pub fn compile_to_js_module(src: &str, runtime_path: &str) -> Result<String, CompileError> {
    Ok(program_to_js_module(&compile(src)?, runtime_path))
}

fn is_js_global(name: &str) -> bool {
    matches!(name,
        "as" | "async" | "await" | "break" | "case" | "catch" | "class" | "const" |
        "continue" | "debugger" | "default" | "delete" | "do" | "else" | "export" |
        "extends" | "false" | "finally" | "for" | "from" | "function" | "if" |
        "import" | "in" | "instanceof" | "let" | "new" | "null" | "of" | "return" |
        "static" | "super" | "switch" | "this" | "throw" | "true" | "try" | "typeof" |
        "undefined" | "var" | "void" | "while" | "with" | "yield" |
        "Array" | "BigInt" | "Boolean" | "Date" | "Error" | "Infinity" | "Intl" |
        "JSON" | "Map" | "Math" | "NaN" | "Number" | "Object" | "Promise" | "RegExp" |
        "Set" | "String" | "Symbol" | "console" | "globalThis" | "parseFloat" | "parseInt" |
        "structuredClone"
    )
}

/// Identifier-like words in compiler-produced JavaScript. It intentionally
/// over-approximates (property names and words in strings are harmless extra
/// declarations); this keeps the emitted evaluator small and independent of a
/// JavaScript parser while never missing a free FOAR name.
fn js_names(src: &str) -> Vec<String> {
    let bytes = src.as_bytes();
    let mut names = std::collections::BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        let first = bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' || bytes[i] == b'$';
        if !first { i += 1; continue; }
        let start = i;
        i += 1;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$') {
            i += 1;
        }
        let name = &src[start..i];
        if !is_js_global(name) { names.insert(name.to_string()); }
    }
    names.into_iter().collect()
}

fn declared_js_names(src: &str) -> std::collections::BTreeSet<String> {
    let names = js_names(src);
    let mut out = std::collections::BTreeSet::new();
    for needle in ["let", "const", "var"] {
        let mut at = 0;
        while let Some(found) = src[at..].find(needle) {
            let pos = at + found;
            let before_ok = pos == 0 || !src.as_bytes()[pos - 1].is_ascii_alphanumeric() && src.as_bytes()[pos - 1] != b'_';
            let end = pos + needle.len();
            let after_ok = end >= src.len() || !src.as_bytes()[end].is_ascii_alphanumeric() && src.as_bytes()[end] != b'_';
            if before_ok && after_ok {
                let tail = &src[end..];
                if let Some(name) = js_names(tail).into_iter().next() { out.insert(name); }
            }
            at = end;
        }
    }
    // Silence the otherwise useful over-approximation when there are no
    // declarations. `names` also validates the same identifier alphabet.
    let _ = names;
    out
}

fn json(s: &str) -> String { serde_json::to_string(s).unwrap() }

fn lookup_decl(name: &str, local: &str, vars: &str, globals: &str) -> String {
    let q = json(name);
    format!(
        "const {name} = ({local} != null && {q} in Object({local})) ? {local}.{name} : (({vars} != null && {q} in Object({vars})) ? {vars}.{name} : {globals}.{name});",
    )
}

fn expression_fn(expr: &str) -> String {
    let decls = js_names(expr).into_iter()
        .map(|n| lookup_decl(&n, "$l", "$v", "$g"))
        .collect::<Vec<_>>().join("\n");
    format!("($v, $l, $g) => {{\n{decls}\nreturn ({expr});\n}}")
}

fn effect_key(js_body: &str, params: &[ast::Param], stores: &[String], props: &[String]) -> String {
    format!("{}|{}|{}|{}", stores.join(","), props.join(","), params.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(","), js_body)
}

fn effect_fn(js_body: &str, params: &[ast::Param], stores: &[String], props: &[String]) -> String {
    let mut declared = declared_js_names(js_body);
    let mut outer = std::collections::BTreeSet::new();
    let mut setup = Vec::new();
    for name in stores {
        outer.insert(name.clone());
        setup.push(format!("let {name} = $scope.{name};"));
    }
    for name in props {
        if outer.insert(name.clone()) { setup.push(format!("const {name} = $scope.{name};")); }
    }
    for (i, p) in params.iter().enumerate() {
        if outer.insert(p.name.clone()) { setup.push(format!("const {} = $args[{}];", p.name, i)); }
    }
    for (i, name) in ["__transition", "__emit", "__asyncTransition"].iter().enumerate() {
        outer.insert((*name).to_string());
        setup.push(format!("const {name} = $helpers[{i}];"));
    }
    for name in js_names(js_body) {
        if !outer.contains(&name) && !declared.contains(&name) {
            setup.push(format!("const {name} = $g.{name};"));
        }
    }
    declared.clear();
    format!("($scope, $args, $helpers, $g) => {{\n{}\n(() => {{\n{}\n}})();\nreturn [{}];\n}}", setup.join("\n"), js_body, stores.join(","))
}

fn function_fn(f: &ast::FnDecl) -> String {
    let mut declared = declared_js_names(&f.js_body);
    let params: std::collections::BTreeSet<String> = f.params.iter().map(|p| p.name.clone()).collect();
    let mut setup = f.params.iter().enumerate()
        .map(|(i, p)| format!("const {} = $args[{}];", p.name, i))
        .collect::<Vec<_>>();
    for name in js_names(&f.js_body) {
        if !params.contains(&name) && !declared.contains(&name) {
            setup.push(format!("const {name} = $f.{name} !== undefined ? $f.{name} : $g.{name};"));
        }
    }
    declared.clear();
    format!("($args, $g, $f) => {{\n{}\n{}\n}}", setup.join("\n"), f.js_body)
}

fn collect_element_expressions(el: &ast::UiElement, out: &mut std::collections::BTreeSet<String>) {
    out.extend(el.args.iter().cloned());
    out.extend(el.named_args.values().filter_map(|v| v.as_str().map(str::to_string)));
    if let Some(expr) = &el.list_expr { out.insert(expr.clone()); }
    if let Some(style) = &el.style { out.extend(style.dynamic.iter().map(|d| d.expr.clone())); }
    for child in &el.children { collect_element_expressions(child, out); }
    if let Some(children) = &el.else_children {
        for child in children { collect_element_expressions(child, out); }
    }
    if let Some(arms) = &el.arms {
        for arm in arms {
            out.insert(arm.test.clone());
            for child in &arm.children { collect_element_expressions(child, out); }
        }
    }
}

fn add_effect(map: &mut std::collections::BTreeMap<String, String>, js_body: &str, params: &[ast::Param], stores: &[String], props: &[String]) {
    map.entry(effect_key(js_body, params, stores, props))
        .or_insert_with(|| effect_fn(js_body, params, stores, props));
}

fn precompiled_module_parts(p: &ast::Program) -> (String, String, String) {
    let mut expressions = std::collections::BTreeSet::new();
    let mut effects = std::collections::BTreeMap::new();
    for ctx in &p.contexts {
        expressions.extend(ctx.stores.iter().map(|s| s.init_expr.clone()));
        expressions.extend(ctx.derived.iter().map(|d| d.expr.clone()));
        let stores = ctx.stores.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let props = ctx.derived.iter().map(|d| d.name.clone()).collect::<Vec<_>>();
        for eff in &ctx.effects { add_effect(&mut effects, &eff.js_body, &eff.params, &stores, &props); }
    }
    for view in &p.views {
        expressions.extend(view.params.iter().filter_map(|p| p.default.clone()));
        expressions.extend(view.stores.iter().map(|s| s.init_expr.clone()));
        expressions.extend(view.derived.iter().map(|d| d.expr.clone()));
        if let Some(style) = &view.style { expressions.extend(style.dynamic.iter().map(|d| d.expr.clone())); }
        for state in &view.states {
            for el in &state.render { collect_element_expressions(el, &mut expressions); }
        }
        let stores = view.stores.iter().map(|s| s.name.clone()).collect::<Vec<_>>();
        let props = view.params.iter().map(|p| p.name.clone()).chain(view.derived.iter().map(|d| d.name.clone())).collect::<Vec<_>>();
        for state in &view.states {
            for eff in &state.effects { add_effect(&mut effects, &eff.js_body, &eff.params, &stores, &props); }
            for body in [state.on_enter.as_ref(), state.on_exit.as_ref(), state.on_error.as_ref(), state.on_unmount.as_ref()].into_iter().flatten() {
                add_effect(&mut effects, &body.js_body, &body.params, &stores, &props);
            }
            for kh in &state.key_handlers { add_effect(&mut effects, &kh.body.js_body, &kh.body.params, &stores, &props); }
        }
        if let Some(body) = &view.on_unmount { add_effect(&mut effects, &body.js_body, &body.params, &stores, &props); }
    }
    let expr_src = expressions.into_iter().map(|e| format!("{}: {}", json(&e), expression_fn(&e))).collect::<Vec<_>>().join(",\n");
    let effect_src = effects.into_iter().map(|(k, v)| format!("{}: {}", json(&k), v)).collect::<Vec<_>>().join(",\n");
    let fn_src = p.functions.iter().map(|f| format!("{}: {}", json(&f.name), function_fn(f))).collect::<Vec<_>>().join(",\n");
    (expr_src, effect_src, fn_src)
}

pub fn program_to_js_module(p: &ast::Program, runtime_path: &str) -> String {
    let (expressions, effects, functions) = precompiled_module_parts(p);
    format!(
        "// Generated by foar {} — do not edit.\nimport {{ attachPrecompiled, createFoarRuntime, hydrate as hydrateRuntime, hydrateIslands as hydrateIslandsRuntime, renderToString as renderRuntimeToString, renderToStringAsync as renderRuntimeToStringAsync, renderToStream as renderRuntimeToStream, createI18n }} from {};\n\nexport {{ createI18n }};\n\nexport const program = {};\n\nattachPrecompiled(program, {{\n  expressions: {{\n{}\n  }},\n  effects: {{\n{}\n  }},\n  functions: {{\n{}\n  }},\n}});\n\nexport function mount(container, callbacks = {{}}) {{\n  return createFoarRuntime(program, container, callbacks);\n}}\n\nexport function hydrate(container, callbacks = {{}}) {{\n  return hydrateRuntime(program, container, callbacks);\n}}\n\nexport function hydrateIslands(root, callbacks = {{}}) {{\n  return hydrateIslandsRuntime(root, program, callbacks);\n}}\n\nexport function renderToString(options = {{}}) {{\n  return renderRuntimeToString(program, options);\n}}\n\nexport function renderToStringAsync(options = {{}}) {{\n  return renderRuntimeToStringAsync(program, options);\n}}\n\nexport function renderToStream(options = {{}}) {{\n  return renderRuntimeToStream(program, options);\n}}\n",
        version(),
        serde_json::to_string(runtime_path).unwrap(),
        serde_json::to_string_pretty(p).unwrap(),
        expressions,
        effects,
        functions,
    )
}
