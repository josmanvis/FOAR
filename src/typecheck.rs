//! Static type checker for FOAR expressions, stores, derived `let`s, data
//! literals, view props, effects, and typed `extern fn` host bindings.
//!
//! Runs after parsing with full program visibility (all data types, enums,
//! extern declarations, and views across all imported files), reporting exact
//! source offsets that multi-file builds map back to `file:line:col`.

use crate::ast::{ContextDecl, DataDecl, EnumDecl, ExternDecl, FnDecl, Param, ViewDecl};
use crate::lexer::{Kind, Token};
use crate::parser::CompileError;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ty {
    Any,
    Void,
    Null,
    Bool,
    Number,
    String,
    Enum(String, Vec<Ty>),
    Data(String, Vec<Ty>),
    TypeParam(String),
    Vec(Box<Ty>),
    Option(Box<Ty>),
    Promise(Box<Ty>),
    Record(Box<Ty>),
    RouteInfo,
    CatchError,
    Context(String),
}

impl std::fmt::Display for Ty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Ty::Any => write!(f, "any"),
            Ty::Void => write!(f, "Void"),
            Ty::Null => write!(f, "null"),
            Ty::Bool => write!(f, "bool"),
            Ty::Number => write!(f, "number"),
            Ty::String => write!(f, "String"),
            Ty::TypeParam(n) => write!(f, "{}", n),
            Ty::Enum(n, args) | Ty::Data(n, args) => {
                if args.is_empty() {
                    write!(f, "{}", n)
                } else {
                    let s: Vec<String> = args.iter().map(|a| a.to_string()).collect();
                    write!(f, "{}<{}>", n, s.join(", "))
                }
            }
            Ty::Vec(t) => write!(f, "Vec<{}>", t),
            Ty::Option(t) => write!(f, "Option<{}>", t),
            Ty::Promise(t) => write!(f, "Promise<{}>", t),
            Ty::Record(t) => write!(f, "Record<{}>", t),
            Ty::RouteInfo => write!(f, "Route"),
            Ty::CatchError => write!(f, "CatchError"),
            Ty::Context(n) => write!(f, "context {}", n),
        }
    }
}

/// Captured source-level items to typecheck once the whole program is parsed.
#[derive(Debug, Clone)]
pub enum CheckItem {
    StoreInit {
        view: String,
        name: String,
        declared: String,
        tokens: Vec<Token>,
        at: usize,
    },
    DerivedInit {
        view: String,
        name: String,
        declared: String,
        tokens: Vec<Token>,
        at: usize,
    },
    EffectBody {
        view: String,
        params: Vec<Param>,
        tokens: Vec<Token>,
    },
    FnBody {
        name: String,
        params: Vec<Param>,
        return_type: String,
        tokens: Vec<Token>,
    },
    ViewCall {
        view: String,
        locals: Vec<(String, Option<String>)>,
        target: String,
        pos_args: Vec<(Vec<Token>, usize)>,
        named_args: Vec<(String, Vec<Token>, usize)>,
        at: usize,
    },
    RenderExpr {
        view: String,
        locals: Vec<(String, Option<String>)>,
        tokens: Vec<Token>,
    },
    /// `view R(check: bool = false)`: the default must fit the prop's type.
    ParamDefault {
        view: String,
        name: String,
        declared: String,
        tokens: Vec<Token>,
        at: usize,
    },
}

struct Env<'a> {
    src: &'a str,
    /// data name -> (type_params, fields)
    data: HashMap<String, (Vec<String>, Vec<(String, Ty)>)>,
    /// enum name -> (type_params, variants: (variant_name, optional payload ty))
    enums: HashMap<String, (Vec<String>, Vec<(String, Option<Ty>)>)>,
    /// extern fns + top-level FOAR `fn`s: name -> (params, return_ty)
    externs: HashMap<String, (Vec<(String, Ty)>, Ty)>,
    /// context name -> (fields: stores+derived, effects: name -> params)
    contexts: HashMap<String, (HashMap<String, Ty>, HashMap<String, Vec<(String, Ty)>>)>,
    views: HashMap<String, Vec<(String, Ty)>>,
    view_states: HashMap<String, HashSet<String>>,
    /// Per-view (and per-context `@ctx:Name`) scope.
    view_vars: HashMap<String, HashMap<String, Ty>>,
}

const BUILTIN_ATTR_PROPS: &[&str] = &[
    "key", "label", "role", "aria", "data", "title", "tab_index", "drag", "drag_text",
    "class", "id", "slot", "disabled", "min", "max", "step", "client",
];

fn err_at(src: &str, at: usize, message: String) -> CompileError {
    let at = at.min(src.len());
    let line = src[..at].matches('\n').count() + 1;
    let col = at - src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    CompileError { message, line, col, file: None, offset: at }
}

fn split_type_args(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (i, c) in s.char_indices() {
        match c {
            '<' => depth += 1,
            '>' => depth -= 1,
            ',' if depth == 0 => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let tail = s[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

pub fn parse_ty(s: &str, data: &HashSet<String>, enums: &HashSet<String>) -> Ty {
    parse_ty_with_params(s, data, enums, &[])
}

fn parse_ty_with_params(s: &str, data: &HashSet<String>, enums: &HashSet<String>, type_params: &[String]) -> Ty {
    let s = s.trim();
    if let Some(lt) = s.find('<') {
        if let Some(inner) = s[lt + 1..].strip_suffix('>') {
            let base = s[..lt].trim();
            let args: Vec<Ty> = split_type_args(inner)
                .into_iter()
                .map(|a| parse_ty_with_params(a, data, enums, type_params))
                .collect();
            match base {
                "Vec" => return Ty::Vec(Box::new(args.into_iter().next().unwrap_or(Ty::Any))),
                "Option" => return Ty::Option(Box::new(args.into_iter().next().unwrap_or(Ty::Any))),
                "Promise" => return Ty::Promise(Box::new(args.into_iter().next().unwrap_or(Ty::Any))),
                "Record" | "Map" => return Ty::Record(Box::new(args.into_iter().last().unwrap_or(Ty::Any))),
                name if enums.contains(name) => return Ty::Enum(name.to_string(), args),
                name if data.contains(name) => return Ty::Data(name.to_string(), args),
                _ => return Ty::Any,
            }
        }
    }
    if type_params.iter().any(|p| p == s) {
        return Ty::TypeParam(s.to_string());
    }
    match s {
        "" | "any" | "Any" | "Object" | "object" => Ty::Any,
        "void" | "Void" | "()" => Ty::Void,
        "null" => Ty::Null,
        "bool" | "boolean" => Ty::Bool,
        "i8" | "i16" | "i32" | "i64" | "isize" | "u8" | "u16" | "u32" | "u64" | "usize" | "f32" | "f64" | "number" | "Number" => Ty::Number,
        "String" | "string" | "str" => Ty::String,
        "Route" | "RouteInfo" => Ty::RouteInfo,
        "CatchError" => Ty::CatchError,
        name if enums.contains(name) => Ty::Enum(name.to_string(), Vec::new()),
        name if data.contains(name) => Ty::Data(name.to_string(), Vec::new()),
        _ => Ty::Any,
    }
}

fn substitute_ty(ty: &Ty, params: &[String], args: &[Ty]) -> Ty {
    if params.is_empty() {
        return ty.clone();
    }
    match ty {
        Ty::TypeParam(name) => {
            if let Some(pos) = params.iter().position(|p| p == name) {
                args.get(pos).cloned().unwrap_or(Ty::Any)
            } else {
                Ty::Any
            }
        }
        Ty::Vec(t) => Ty::Vec(Box::new(substitute_ty(t, params, args))),
        Ty::Option(t) => Ty::Option(Box::new(substitute_ty(t, params, args))),
        Ty::Promise(t) => Ty::Promise(Box::new(substitute_ty(t, params, args))),
        Ty::Record(t) => Ty::Record(Box::new(substitute_ty(t, params, args))),
        Ty::Data(n, a) => Ty::Data(n.clone(), a.iter().map(|x| substitute_ty(x, params, args)).collect()),
        Ty::Enum(n, a) => Ty::Enum(n.clone(), a.iter().map(|x| substitute_ty(x, params, args)).collect()),
        other => other.clone(),
    }
}

fn is_assignable(expected: &Ty, actual: &Ty) -> bool {
    if matches!(expected, Ty::Any | Ty::TypeParam(_)) || matches!(actual, Ty::Any | Ty::TypeParam(_)) {
        return true;
    }
    if expected == actual {
        return true;
    }
    match (expected, actual) {
        (Ty::Option(_), Ty::Null) => true,
        (Ty::Option(e), Ty::Option(a)) => is_assignable(e, a),
        (Ty::Option(e), a) => is_assignable(e, a),
        (Ty::Vec(e), Ty::Vec(a)) => is_assignable(e, a),
        (Ty::Promise(e), Ty::Promise(a)) => is_assignable(e, a),
        (Ty::Record(e), Ty::Record(a)) => is_assignable(e, a),
        (Ty::Data(en, ea), Ty::Data(an, aa)) if en == an => {
            ea.is_empty() || aa.is_empty() || (ea.len() == aa.len() && ea.iter().zip(aa).all(|(x, y)| is_assignable(x, y)))
        }
        (Ty::Enum(en, ea), Ty::Enum(an, aa)) if en == an => {
            ea.is_empty() || aa.is_empty() || (ea.len() == aa.len() && ea.iter().zip(aa).all(|(x, y)| is_assignable(x, y)))
        }
        _ => false,
    }
}

fn unify(a: Ty, b: Ty) -> Ty {
    if a == b {
        return a;
    }
    match (a, b) {
        (Ty::Any, x) | (x, Ty::Any) => x,
        (Ty::Null, Ty::Option(t)) | (Ty::Option(t), Ty::Null) => Ty::Option(t),
        (Ty::Null, x) | (x, Ty::Null) => Ty::Option(Box::new(x)),
        (Ty::Option(x), Ty::Option(y)) => Ty::Option(Box::new(unify(*x, *y))),
        (Ty::Vec(x), Ty::Vec(y)) => Ty::Vec(Box::new(unify(*x, *y))),
        _ => Ty::Any,
    }
}

/// " (did you mean 'x'?)" for the closest candidate, or "".
pub fn did_you_mean<'a>(needle: &str, candidates: impl Iterator<Item = &'a str>) -> String {
    closest(needle, candidates).map(|s| format!(" (did you mean '{}'?)", s)).unwrap_or_default()
}

fn closest<'a>(needle: &str, candidates: impl Iterator<Item = &'a str>) -> Option<String> {
    let mut best: Option<(usize, &str)> = None;
    for c in candidates {
        let d = edit_distance(needle, c);
        if d <= 2 && best.map_or(true, |(bd, _)| d < bd) {
            best = Some((d, c));
        }
    }
    best.map(|(_, s)| s.to_string())
}

fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

pub fn check_program(
    src: &str,
    data_decls: &[DataDecl],
    enums: &[EnumDecl],
    externs: &[ExternDecl],
    functions: &[FnDecl],
    contexts: &[ContextDecl],
    views: &[ViewDecl],
    items: &[CheckItem],
) -> Result<(), CompileError> {
    let data_names: HashSet<String> = data_decls.iter().map(|d| d.name.clone()).collect();
    let enum_names: HashSet<String> = enums.iter().map(|e| e.name.clone()).collect();

    let mut env = Env {
        src,
        data: HashMap::new(),
        enums: HashMap::new(),
        externs: HashMap::new(),
        contexts: HashMap::new(),
        views: HashMap::new(),
        view_states: HashMap::new(),
        view_vars: HashMap::new(),
    };

    for d in data_decls {
        let fields = d
            .fields
            .iter()
            .map(|f| (f.name.clone(), parse_ty_with_params(&f.field_type, &data_names, &enum_names, &d.type_params)))
            .collect();
        env.data.insert(d.name.clone(), (d.type_params.clone(), fields));
    }

    for e in enums {
        let variants = e
            .variants
            .iter()
            .map(|v| {
                let payload = v
                    .payload_type
                    .as_ref()
                    .map(|pt| parse_ty_with_params(pt, &data_names, &enum_names, &e.type_params));
                (v.name.clone(), payload)
            })
            .collect();
        env.enums.insert(e.name.clone(), (e.type_params.clone(), variants));
    }

    for ex in externs {
        let params = ex.params.iter().map(|p| (p.name.clone(), parse_ty(&p.param_type, &data_names, &enum_names))).collect();
        let ret = parse_ty(&ex.return_type, &data_names, &enum_names);
        env.externs.insert(ex.name.clone(), (params, ret));
    }

    for f in functions {
        let params = f.params.iter().map(|p| (p.name.clone(), parse_ty(&p.param_type, &data_names, &enum_names))).collect();
        let ret = parse_ty(&f.return_type, &data_names, &enum_names);
        env.externs.insert(f.name.clone(), (params, ret));
    }

    for ctx in contexts {
        let mut fields = HashMap::new();
        for s in &ctx.stores {
            fields.insert(s.name.clone(), parse_ty(&s.store_type, &data_names, &enum_names));
        }
        for d in &ctx.derived {
            fields.insert(d.name.clone(), parse_ty(&d.derived_type, &data_names, &enum_names));
        }
        let mut effs = HashMap::new();
        for ef in &ctx.effects {
            let ps = ef.params.iter().map(|p| (p.name.clone(), parse_ty(&p.param_type, &data_names, &enum_names))).collect();
            effs.insert(ef.name.clone(), ps);
        }
        env.view_vars.insert(format!("@ctx:{}", ctx.name), fields.clone());
        env.contexts.insert(ctx.name.clone(), (fields, effs));
    }

    for v in views {
        let params: Vec<(String, Ty)> = v
            .params
            .iter()
            .map(|p| (p.name.clone(), parse_ty_with_params(&p.param_type, &data_names, &enum_names, &v.type_params)))
            .collect();
        env.views.insert(v.name.clone(), params.clone());
        env.view_states.insert(v.name.clone(), v.states.iter().map(|s| s.name.clone()).collect());

        let mut scope = HashMap::new();
        scope.insert("route".to_string(), Ty::RouteInfo);
        for ctx_name in &v.uses {
            if !env.contexts.contains_key(ctx_name) {
                return Err(err_at(src, 0, format!("Unknown context '{}' in view '{}'", ctx_name, v.name)));
            }
            scope.insert(ctx_name.clone(), Ty::Context(ctx_name.clone()));
        }
        for (n, ty) in params {
            scope.insert(n, ty);
        }
        for s in &v.stores {
            scope.insert(s.name.clone(), parse_ty_with_params(&s.store_type, &data_names, &enum_names, &v.type_params));
        }
        for d in &v.derived {
            scope.insert(d.name.clone(), parse_ty_with_params(&d.derived_type, &data_names, &enum_names, &v.type_params));
        }
        env.view_vars.insert(v.name.clone(), scope);
    }

    // Pass 1: prop defaults, store initializers + derived `let`s (in order, updating inferred `let` types)
    for item in items {
        match item {
            CheckItem::ParamDefault { view, name, declared, tokens, at } => {
                let expected = parse_ty(declared, &data_names, &enum_names);
                let mut tc = Checker::new(&env, view, HashMap::new());
                let actual = tc.check_expr(tokens, Some(&expected))?;
                if !is_assignable(&expected, &actual) {
                    return Err(err_at(src, *at, format!("Default for prop '{}' should be {}, got {}", name, expected, actual)));
                }
            }
            CheckItem::StoreInit { view, name, declared, tokens, at } => {
                let scope = env.view_vars.get(view).cloned().unwrap_or_default();
                let expected = parse_ty(declared, &data_names, &enum_names);
                let mut tc = Checker::new(&env, view, scope);
                let actual = tc.check_expr(tokens, Some(&expected))?;
                if !is_assignable(&expected, &actual) {
                    return Err(err_at(
                        src,
                        *at,
                        format!("Type mismatch for store '{}': expected {}, got {}", name, expected, actual),
                    ));
                }
            }
            CheckItem::DerivedInit { view, name, declared, tokens, at } => {
                let scope = env.view_vars.get(view).cloned().unwrap_or_default();
                let expected = parse_ty(declared, &data_names, &enum_names);
                let mut tc = Checker::new(&env, view, scope);
                let actual = tc.check_expr(tokens, if expected == Ty::Any { None } else { Some(&expected) })?;
                if expected != Ty::Any && !is_assignable(&expected, &actual) {
                    return Err(err_at(
                        src,
                        *at,
                        format!("Type mismatch for let '{}': expected {}, got {}", name, expected, actual),
                    ));
                }
                if expected == Ty::Any && actual != Ty::Any {
                    if let Some(vscope) = env.view_vars.get_mut(view) {
                        vscope.insert(name.clone(), actual.clone());
                    }
                    if let Some(cname) = view.strip_prefix("@ctx:") {
                        if let Some((fields, _)) = env.contexts.get_mut(cname) {
                            fields.insert(name.clone(), actual);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut view_defaults: HashMap<String, HashSet<String>> = HashMap::new();
    for v in views {
        view_defaults.insert(
            v.name.clone(),
            v.params.iter().filter(|p| p.default.is_some()).map(|p| p.name.clone()).collect(),
        );
    }

    // Pass 2: Effects, ViewCalls, and Render expressions
    let mut cached_render_tc: Option<(&str, &[(String, Option<String>)], Checker<'_>)> = None;
    for item in items {
        match item {
            CheckItem::EffectBody { view, params, tokens } => {
                let mut scope = env.view_vars.get(view).cloned().unwrap_or_default();
                for p in params {
                    scope.insert(p.name.clone(), parse_ty(&p.param_type, &data_names, &enum_names));
                }
                let mut tc = Checker::new(&env, view, scope);
                tc.check_statements(tokens)?;
            }
            CheckItem::FnBody { name, params, return_type: _, tokens } => {
                let mut scope = HashMap::new();
                for p in params {
                    scope.insert(p.name.clone(), parse_ty(&p.param_type, &data_names, &enum_names));
                }
                let mut tc = Checker::new(&env, name, scope);
                tc.check_statements(tokens)?;
            }
            CheckItem::ViewCall { view, locals, target, pos_args, named_args, at } => {
                let Some(target_params) = env.views.get(target) else { continue };
                let tc = match &mut cached_render_tc {
                    Some((cv, cl, checker)) if *cv == view.as_str() && *cl == locals.as_slice() => checker,
                    slot => {
                        let scope = scope_with_locals(&env, view, locals);
                        *slot = Some((view.as_str(), locals.as_slice(), Checker::new(&env, view, scope)));
                        &mut slot.as_mut().unwrap().2
                    }
                };

                for (i, (toks, arg_at)) in pos_args.iter().enumerate() {
                    if let Some((pname, pty)) = target_params.get(i) {
                        let actual = tc.check_expr(toks, Some(pty))?;
                        if !is_assignable(pty, &actual) {
                            return Err(err_at(
                                src,
                                *arg_at,
                                format!("Prop '{}' of view '{}' expects {}, got {}", pname, target, pty, actual),
                            ));
                        }
                    } else if !toks.is_empty() {
                        return Err(err_at(
                            src,
                            *arg_at,
                            format!("View '{}' takes at most {} positional prop(s)", target, target_params.len()),
                        ));
                    }
                }

                for (pname, toks, arg_at) in named_args {
                    // the view's own props win over the built-in attributes (label, title, data, data_*, …)
                    if (BUILTIN_ATTR_PROPS.contains(&pname.as_str()) || pname.starts_with("data_"))
                        && !target_params.iter().any(|(n, _)| n == pname)
                    {
                        tc.check_expr(toks, None)?;
                        continue;
                    }
                    if let Some((_, pty)) = target_params.iter().find(|(n, _)| n == pname) {
                        let actual = tc.check_expr(toks, Some(pty))?;
                        if !is_assignable(pty, &actual) {
                            return Err(err_at(
                                src,
                                *arg_at,
                                format!("Prop '{}' of view '{}' expects {}, got {}", pname, target, pty, actual),
                            ));
                        }
                    } else {
                        let hint = closest(pname, target_params.iter().map(|(n, _)| n.as_str()))
                            .map(|s| format!(" (did you mean '{}'?)", s))
                            .unwrap_or_default();
                        return Err(err_at(
                            src,
                            *at,
                            format!("Unknown prop '{}' on view '{}'{}", pname, target, hint),
                        ));
                    }
                }
                // every prop must be given, except Option<…> ones and ones with a default
                let defaults = view_defaults.get(target);
                for (i, (pname, pty)) in target_params.iter().enumerate() {
                    let given = i < pos_args.len() || named_args.iter().any(|(n, _, _)| n == pname);
                    let has_default = defaults.map(|d| d.contains(pname)).unwrap_or(false);
                    if !given && !has_default && !matches!(pty, Ty::Option(_) | Ty::Any) {
                        return Err(err_at(src, *at, format!("{} needs the prop '{}' ({})", target, pname, pty)));
                    }
                }
            }
            CheckItem::RenderExpr { view, locals, tokens } => {
                if tokens.len() == 1
                    && (tokens[0].kind == Kind::Num
                        || (tokens[0].kind == Kind::Str && !src[tokens[0].start..tokens[0].end].contains('{')))
                {
                    continue;
                }
                let tc = match &mut cached_render_tc {
                    Some((cv, cl, checker)) if *cv == view.as_str() && *cl == locals.as_slice() => checker,
                    slot => {
                        let scope = scope_with_locals(&env, view, locals);
                        *slot = Some((view.as_str(), locals.as_slice(), Checker::new(&env, view, scope)));
                        &mut slot.as_mut().unwrap().2
                    }
                };
                tc.check_expr(tokens, None)?;
            }
            _ => {}
        }
    }

    Ok(())
}

fn scope_with_locals(env: &Env<'_>, view: &str, locals: &[(String, Option<String>)]) -> HashMap<String, Ty> {
    let mut scope = env.view_vars.get(view).cloned().unwrap_or_default();
    for (name, hint) in locals {
        let ty = match hint.as_deref() {
            Some("RouteParams") => Ty::Record(Box::new(Ty::String)),
            Some("CatchError") => Ty::CatchError,
            Some(s) if s.starts_with("EnumPayload:") => {
                let parts: Vec<&str> = s.splitn(4, ':').collect();
                if parts.len() == 4 {
                    let (scrut, ename, vname) = (parts[1], parts[2], parts[3]);
                    let scrut_args: Vec<Ty> = match scope.get(scrut) {
                        Some(Ty::Enum(en, args)) if en == ename => args.clone(),
                        _ => Vec::new(),
                    };
                    if let Some((tparams, variants)) = env.enums.get(ename) {
                        if let Some((_, Some(pty))) = variants.iter().find(|(vn, _)| vn == vname) {
                            substitute_ty(pty, tparams, &scrut_args)
                        } else {
                            Ty::Any
                        }
                    } else {
                        Ty::Any
                    }
                } else {
                    Ty::Any
                }
            }
            Some(list_src) => {
                // If local is a List binding over a variable/member we know is Vec<T>, infer T!
                let trimmed = list_src.trim();
                if let Some(Ty::Vec(elem)) = scope.get(trimmed) {
                    (**elem).clone()
                } else {
                    Ty::Any
                }
            }
            None => Ty::Any,
        };
        scope.insert(name.clone(), ty);
    }
    scope
}

struct Checker<'a> {
    env: &'a Env<'a>,
    view: &'a str,
    scope: HashMap<String, Ty>,
}

impl<'a> Checker<'a> {
    fn new(env: &'a Env<'a>, view: &'a str, scope: HashMap<String, Ty>) -> Self {
        Self { env, view, scope }
    }

    fn text(&self, t: &Token) -> &'a str {
        &self.env.src[t.start..t.end]
    }

    fn is(&self, t: &Token, s: &str) -> bool {
        t.kind != Kind::Str && t.kind != Kind::Eof && self.text(t) == s
    }

    fn err<T>(&self, at: usize, msg: impl Into<String>) -> Result<T, CompileError> {
        Err(err_at(self.env.src, at, msg.into()))
    }

    // ---- Statements (inside effects / blocks) ------------------------------
    fn check_statements(&mut self, toks: &[Token]) -> Result<(), CompileError> {
        let mut i = 0;
        while i < toks.len() {
            if self.is(&toks[i], ";") {
                i += 1;
                continue;
            }
            if self.is(&toks[i], "return") {
                let end = self.find_stmt_end(toks, i + 1);
                if end > i + 1 {
                    self.check_expr(&toks[i + 1..end], None)?;
                }
                i = (end + 1).min(toks.len());
                continue;
            }
            if self.is(&toks[i], "break") || self.is(&toks[i], "continue") {
                i = (self.find_stmt_end(toks, i + 1) + 1).min(toks.len());
                continue;
            }
            if self.is(&toks[i], "transition") {
                if let Some(t) = toks.get(i + 1) {
                    if t.kind == Kind::Ident {
                        let target = self.text(t);
                        self.check_state_exists(target, t.start)?;
                    }
                }
                i = (self.find_stmt_end(toks, i + 1) + 1).min(toks.len());
                continue;
            }
            if self.is(&toks[i], "emit") {
                if let Some(open) = toks.get(i + 2).filter(|t| self.is(t, "(")) {
                    let _ = open;
                    if let Some(close) = self.find_matching(toks, i + 2, "(", ")") {
                        if close > i + 3 {
                            self.check_expr(&toks[i + 3..close], None)?;
                        }
                        i = close + 1;
                        if i < toks.len() && self.is(&toks[i], ";") {
                            i += 1;
                        }
                        continue;
                    }
                }
                i = (self.find_stmt_end(toks, i + 1) + 1).min(toks.len());
                continue;
            }
            if self.is(&toks[i], "let") || self.is(&toks[i], "const") {
                let mut j = i + 1;
                if j < toks.len() && self.is(&toks[j], "mut") {
                    j += 1;
                }
                if j < toks.len() && toks[j].kind == Kind::Ident {
                    let var = self.text(&toks[j]).to_string();
                    let var_at = toks[j].start;
                    j += 1;
                    let mut explicit_ty: Option<Ty> = None;
                    if j < toks.len() && self.is(&toks[j], ":") {
                        j += 1;
                        let ty_start = j;
                        while j < toks.len() && !self.is(&toks[j], "=") && !self.is(&toks[j], ";") {
                            j += 1;
                        }
                        let ty_str: String = toks[ty_start..j].iter().map(|t| self.text(t)).collect();
                        let data_names: HashSet<String> = self.env.data.keys().cloned().collect();
                        let enum_names: HashSet<String> = self.env.enums.keys().cloned().collect();
                        explicit_ty = Some(parse_ty(&ty_str, &data_names, &enum_names));
                    }
                    if j < toks.len() && self.is(&toks[j], "=") {
                        let end = self.find_stmt_end(toks, j + 1);
                        let actual = self.check_expr(&toks[j + 1..end], explicit_ty.as_ref())?;
                        if let Some(exp) = &explicit_ty {
                            if !is_assignable(exp, &actual) {
                                return self.err(var_at, format!("Type mismatch for '{}': expected {}, got {}", var, exp, actual));
                            }
                        }
                        self.scope.insert(var, explicit_ty.unwrap_or(actual));
                        i = (end + 1).min(toks.len());
                        continue;
                    }
                }
                i = (self.find_stmt_end(toks, i + 1) + 1).min(toks.len());
                continue;
            }
            if self.is(&toks[i], "if") {
                // `if let Some(x) = expr { ... }` or `if cond { ... } [else ...]`
                let mut j = i + 1;
                let mut binding: Option<(String, Ty)> = None;
                if j + 4 < toks.len() && self.is(&toks[j], "let") && self.is(&toks[j + 1], "Some") && self.is(&toks[j + 2], "(") {
                    let bname = self.text(&toks[j + 3]).to_string();
                    let mut eq = j + 4;
                    while eq < toks.len() && !self.is(&toks[eq], "=") {
                        eq += 1;
                    }
                    if let Some(brace) = self.find_top_level(toks, eq + 1, "{") {
                        let rhs_ty = self.check_expr(&toks[eq + 1..brace], None)?;
                        let inner = match rhs_ty {
                            Ty::Option(t) => *t,
                            other => other,
                        };
                        binding = Some((bname, inner));
                        j = brace;
                    }
                } else if let Some(brace) = self.find_top_level(toks, j, "{") {
                    self.check_expr(&toks[j..brace], None)?;
                    j = brace;
                }
                if j < toks.len() && self.is(&toks[j], "{") {
                    if let Some(close) = self.find_matching(toks, j, "{", "}") {
                        let saved = self.scope.clone();
                        if let Some((n, ty)) = binding {
                            self.scope.insert(n, ty);
                        }
                        self.check_statements(&toks[j + 1..close])?;
                        self.scope = saved;
                        i = close + 1;
                        if i < toks.len() && self.is(&toks[i], "else") {
                            i += 1;
                            if i < toks.len() && self.is(&toks[i], "{") {
                                if let Some(ec) = self.find_matching(toks, i, "{", "}") {
                                    let saved2 = self.scope.clone();
                                    self.check_statements(&toks[i + 1..ec])?;
                                    self.scope = saved2;
                                    i = ec + 1;
                                }
                            }
                        }
                        continue;
                    }
                }
                i += 1;
                continue;
            }
            if self.is(&toks[i], "for") {
                if i + 3 < toks.len() && toks[i + 1].kind == Kind::Ident && self.is(&toks[i + 2], "in") {
                    let var = self.text(&toks[i + 1]).to_string();
                    if let Some(brace) = self.find_top_level(toks, i + 3, "{") {
                        let iter_toks = &toks[i + 3..brace];
                        let elem_ty = if iter_toks.iter().any(|t| self.is(t, "..") || self.is(t, "..=")) {
                            Ty::Number
                        } else {
                            match self.check_expr(iter_toks, None)? {
                                Ty::Vec(t) => *t,
                                _ => Ty::Any,
                            }
                        };
                        if let Some(close) = self.find_matching(toks, brace, "{", "}") {
                            let saved = self.scope.clone();
                            self.scope.insert(var, elem_ty);
                            self.check_statements(&toks[brace + 1..close])?;
                            self.scope = saved;
                            i = close + 1;
                            continue;
                        }
                    }
                }
                i += 1;
                continue;
            }
            if self.is(&toks[i], "while") {
                if let Some(brace) = self.find_top_level(toks, i + 1, "{") {
                    self.check_expr(&toks[i + 1..brace], None)?;
                    if let Some(close) = self.find_matching(toks, brace, "{", "}") {
                        let saved = self.scope.clone();
                        self.check_statements(&toks[brace + 1..close])?;
                        self.scope = saved;
                        i = close + 1;
                        continue;
                    }
                }
                i += 1;
                continue;
            }
            if self.is(&toks[i], "loop") {
                if i + 1 < toks.len() && self.is(&toks[i + 1], "{") {
                    if let Some(close) = self.find_matching(toks, i + 1, "{", "}") {
                        let saved = self.scope.clone();
                        self.check_statements(&toks[i + 2..close])?;
                        self.scope = saved;
                        i = close + 1;
                        continue;
                    }
                }
                i += 1;
                continue;
            }
            if self.is(&toks[i], "match") {
                if let Some(brace) = self.find_top_level(toks, i + 1, "{") {
                    let scrut_ty = self.check_expr(&toks[i + 1..brace], None)?;
                    if let Some(close) = self.find_matching(toks, brace, "{", "}") {
                        self.check_match_arms(&toks[brace + 1..close], Some(&scrut_ty), None, true)?;
                        i = close + 1;
                        if i < toks.len() && self.is(&toks[i], ";") {
                            i += 1;
                        }
                        continue;
                    }
                }
                i += 1;
                continue;
            }
            if self.is(&toks[i], "{") {
                if let Some(close) = self.find_matching(toks, i, "{", "}") {
                    let saved = self.scope.clone();
                    self.check_statements(&toks[i + 1..close])?;
                    self.scope = saved;
                    i = close + 1;
                    continue;
                }
            }

            // Expression statement, assignment, or async transition `api(args) -> transition(Target);`
            let end = self.find_stmt_end(toks, i);
            let stmt = &toks[i..end];
            if !stmt.is_empty() {
                if let Some(arrow) = self.find_top_level(stmt, 0, "->") {
                    // Async transition: `api(...) -> transition(State)`
                    self.check_expr(&stmt[..arrow], None)?;
                    if arrow + 3 < stmt.len() && self.is(&stmt[arrow + 1], "transition") && self.is(&stmt[arrow + 2], "(") {
                        let target = self.text(&stmt[arrow + 3]);
                        self.check_state_exists(target, stmt[arrow + 3].start)?;
                    }
                } else if let Some((eq_pos, op)) = self.find_top_level_assign(stmt) {
                    // `count = …` must name a store (or a local): a typo would
                    // otherwise silently write nowhere
                    if eq_pos == 1 && stmt[0].kind == Kind::Ident {
                        let name = self.text(&stmt[0]);
                        if !self.scope.contains_key(name) {
                            let owner = self.view.strip_prefix("@ctx:").map_or(format!("view {}", self.view), |c| format!("context {}", c));
                            let hint = closest(name, self.scope.keys().map(|s| s.as_str())).map(|s| format!(" (did you mean '{}'?)", s)).unwrap_or_default();
                            return self.err(stmt[0].start, format!("'{}' isn't a store of {}{}: declare it with `store {}: Type = …;`", name, owner, hint, name));
                        }
                    }
                    let lhs_ty = self.check_expr(&stmt[..eq_pos], None)?;
                    let rhs_ty = self.check_expr(&stmt[eq_pos + 1..], if op == "=" { Some(&lhs_ty) } else { None })?;
                    if op == "=" {
                        if !is_assignable(&lhs_ty, &rhs_ty) {
                            let lhs_name: String = stmt[..eq_pos].iter().map(|t| self.text(t)).collect();
                            return self.err(
                                stmt[eq_pos].start,
                                format!("Cannot assign {} to '{}' (expected {})", rhs_ty, lhs_name, lhs_ty),
                            );
                        }
                    } else if matches!(op, "-=" | "*=" | "/=") {
                        if lhs_ty != Ty::Any && lhs_ty != Ty::Number {
                            return self.err(stmt[eq_pos].start, format!("Operator '{}' requires a number, got {}", op, lhs_ty));
                        }
                        if rhs_ty != Ty::Any && rhs_ty != Ty::Number {
                            return self.err(stmt[eq_pos].start, format!("Operator '{}' requires a number, got {}", op, rhs_ty));
                        }
                    }
                } else {
                    self.check_expr(stmt, None)?;
                }
            }
            i = (end + 1).min(toks.len());
        }
        Ok(())
    }

    fn check_state_exists(&self, state: &str, at: usize) -> Result<(), CompileError> {
        if let Some(states) = self.env.view_states.get(self.view) {
            if !states.contains(state) {
                let hint = closest(state, states.iter().map(|s| s.as_str()))
                    .map(|s| format!(" (did you mean '{}'?)", s))
                    .unwrap_or_default();
                return self.err(at, format!("Unknown state '{}' in view '{}'{}", state, self.view, hint));
            }
        }
        Ok(())
    }

    // ---- Expressions -------------------------------------------------------
    fn check_expr(&mut self, toks: &[Token], expected: Option<&Ty>) -> Result<Ty, CompileError> {
        if toks.is_empty() {
            return Ok(Ty::Any);
        }
        // Unwrap matching outer parens: `(expr)`
        if self.is(&toks[0], "(") {
            if let Some(close) = self.find_matching(toks, 0, "(", ")") {
                if close == toks.len() - 1 {
                    return self.check_expr(&toks[1..close], expected);
                }
            }
        }
        // `match scrut { arms }`
        if self.is(&toks[0], "match") {
            if let Some(brace) = self.find_top_level(toks, 1, "{") {
                let scrut_ty = self.check_expr(&toks[1..brace], None)?;
                if let Some(close) = self.find_matching(toks, brace, "{", "}") {
                    return self.check_match_arms(&toks[brace + 1..close], Some(&scrut_ty), expected, false);
                }
            }
            return Ok(Ty::Any);
        }
        // Closure `|a, b| body`
        if self.is(&toks[0], "|") {
            return Ok(Ty::Any);
        }
        // Ternary `cond ? a : b`
        if let Some(q) = self.find_top_level(toks, 0, "?") {
            if let Some(c) = self.find_top_level_ternary_colon(toks, q + 1) {
                self.check_expr(&toks[..q], None)?;
                let ta = self.check_expr(&toks[q + 1..c], expected)?;
                let tb = self.check_expr(&toks[c + 1..], expected)?;
                return Ok(unify(ta, tb));
            }
        }
        // Logical ||, &&
        if let Some(p) = self.find_last_top_level(toks, &["||", "??"]) {
            let a = self.check_expr(&toks[..p], None)?;
            let b = self.check_expr(&toks[p + 1..], expected)?;
            return Ok(if self.is(&toks[p], "??") {
                let a_unwrapped = match a { Ty::Option(t) => *t, other => other };
                unify(a_unwrapped, b)
            } else {
                unify(a, b)
            });
        }
        if let Some(p) = self.find_last_top_level(toks, &["&&"]) {
            self.check_expr(&toks[..p], None)?;
            return self.check_expr(&toks[p + 1..], expected);
        }
        // Equality ==, !=, ===, !==
        if let Some(p) = self.find_last_top_level(toks, &["==", "!=", "===", "!=="]) {
            let a = self.check_expr(&toks[..p], None)?;
            let b = self.check_expr(&toks[p + 1..], None)?;
            if let (Ty::Enum(ea, _), Ty::Enum(eb, _)) = (&a, &b) {
                if ea != eb {
                    return self.err(toks[p].start, format!("Cannot compare enum '{}' with enum '{}'", ea, eb));
                }
            }
            return Ok(Ty::Bool);
        }
        // Comparisons <, <=, >, >=
        if let Some(p) = self.find_last_top_level(toks, &["<", "<=", ">", ">="]) {
            self.check_expr(&toks[..p], None)?;
            self.check_expr(&toks[p + 1..], None)?;
            return Ok(Ty::Bool);
        }
        // Additive +, -
        if let Some(p) = self.find_last_top_level_binary(toks, &["+", "-"]) {
            let a = self.check_expr(&toks[..p], None)?;
            let b = self.check_expr(&toks[p + 1..], None)?;
            if self.is(&toks[p], "-") {
                if a != Ty::Any && a != Ty::Number {
                    return self.err(toks[p].start, format!("Cannot subtract from {} (expected number)", a));
                }
                if b != Ty::Any && b != Ty::Number {
                    return self.err(toks[p].start, format!("Cannot subtract {} (expected number)", b));
                }
                return Ok(Ty::Number);
            }
            if a == Ty::String || b == Ty::String {
                return Ok(Ty::String);
            }
            if a == Ty::Number && b == Ty::Number {
                return Ok(Ty::Number);
            }
            return Ok(Ty::Any);
        }
        // Multiplicative *, /, %
        if let Some(p) = self.find_last_top_level_binary(toks, &["*", "/", "%"]) {
            let a = self.check_expr(&toks[..p], None)?;
            let b = self.check_expr(&toks[p + 1..], None)?;
            let op = self.text(&toks[p]);
            if a != Ty::Any && a != Ty::Number {
                return self.err(toks[p].start, format!("Operator '{}' requires numbers, got {}", op, a));
            }
            if b != Ty::Any && b != Ty::Number {
                return self.err(toks[p].start, format!("Operator '{}' requires numbers, got {}", op, b));
            }
            return Ok(Ty::Number);
        }
        // Unary !, -, +
        if self.is(&toks[0], "!") {
            self.check_expr(&toks[1..], None)?;
            return Ok(Ty::Bool);
        }
        if self.is(&toks[0], "-") || self.is(&toks[0], "+") {
            let t = self.check_expr(&toks[1..], None)?;
            if t != Ty::Any && t != Ty::Number {
                return self.err(toks[0].start, format!("Unary '{}' requires a number, got {}", self.text(&toks[0]), t));
            }
            return Ok(Ty::Number);
        }

        // Postfix chain: primary followed by .field, .method(...), (...), [...]
        self.check_postfix(toks, expected)
    }

    fn check_postfix(&mut self, toks: &[Token], expected: Option<&Ty>) -> Result<Ty, CompileError> {
        let (mut ty, mut idx) = self.check_primary(toks, expected)?;
        while idx < toks.len() {
            if self.is(&toks[idx], ".") || self.is(&toks[idx], "?.") {
                idx += 1;
                if idx >= toks.len() {
                    break;
                }
                let member = self.text(&toks[idx]).to_string();
                let mem_at = toks[idx].start;
                idx += 1;
                // Method call `.member(...)`
                if idx < toks.len() && self.is(&toks[idx], "(") {
                    if let Some(close) = self.find_matching(toks, idx, "(", ")") {
                        let args = self.split_args(&toks[idx + 1..close]);
                        ty = self.check_method_call(&ty, &member, &args, mem_at)?;
                        idx = close + 1;
                        continue;
                    }
                }
                // Field access `.member`
                ty = self.check_field_access(&ty, &member, mem_at)?;
            } else if self.is(&toks[idx], "[") {
                if let Some(close) = self.find_matching(toks, idx, "[", "]") {
                    self.check_expr(&toks[idx + 1..close], None)?;
                    ty = match ty {
                        Ty::Vec(elem) => *elem,
                        Ty::Record(val) => *val,
                        Ty::String => Ty::String,
                        _ => Ty::Any,
                    };
                    idx = close + 1;
                } else {
                    break;
                }
            } else if self.is(&toks[idx], "(") {
                if let Some(close) = self.find_matching(toks, idx, "(", ")") {
                    for arg in self.split_args(&toks[idx + 1..close]) {
                        self.check_expr(&arg, None)?;
                    }
                    ty = Ty::Any;
                    idx = close + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        Ok(ty)
    }

    fn check_primary(&mut self, toks: &[Token], expected: Option<&Ty>) -> Result<(Ty, usize), CompileError> {
        let first = &toks[0];
        let text = self.text(first);

        if first.kind == Kind::Str {
            return Ok((Ty::String, 1));
        }
        if first.kind == Kind::Num {
            return Ok((Ty::Number, 1));
        }
        if text == "true" || text == "false" {
            return Ok((Ty::Bool, 1));
        }
        if text == "null" {
            return Ok((Ty::Null, 1));
        }
        if text == "None" {
            return Ok((Ty::Option(Box::new(Ty::Any)), 1));
        }
        if text == "Some" && toks.len() > 1 && self.is(&toks[1], "(") {
            if let Some(close) = self.find_matching(toks, 1, "(", ")") {
                let inner_exp = match expected {
                    Some(Ty::Option(t)) => Some(t.as_ref()),
                    _ => None,
                };
                let inner = self.check_expr(&toks[2..close], inner_exp)?;
                return Ok((Ty::Option(Box::new(inner)), close + 1));
            }
        }
        // Array literal `[a, b, ...]`
        if self.is(first, "[") {
            if let Some(close) = self.find_matching(toks, 0, "[", "]") {
                let elem_exp = match expected {
                    Some(Ty::Vec(t)) => Some(t.as_ref()),
                    _ => None,
                };
                let elems = self.split_args(&toks[1..close]);
                let mut elem_ty = Ty::Any;
                for e in elems {
                    if !e.is_empty() && !self.is(&e[0], "...") {
                        let t = self.check_expr(&e, elem_exp)?;
                        elem_ty = if elem_ty == Ty::Any { t } else { unify(elem_ty, t) };
                    }
                }
                return Ok((Ty::Vec(Box::new(elem_ty)), close + 1));
            }
        }
        // Object literal `{ a: 1, b: 2 }`
        if self.is(first, "{") {
            if let Some(close) = self.find_matching(toks, 0, "{", "}") {
                self.check_object_fields(&toks[1..close], None, first.start)?;
                return Ok((Ty::Any, close + 1));
            }
        }
        // Parenthesized expression `(expr)`
        if self.is(first, "(") {
            if let Some(close) = self.find_matching(toks, 0, "(", ")") {
                let t = self.check_expr(&toks[1..close], expected)?;
                return Ok((t, close + 1));
            }
        }
        // Enum variant `EnumName.Variant` or tagged-union constructor `EnumName.Variant(payload)`
        if let Some((tparams, variants)) = self.env.enums.get(text).cloned() {
            if toks.len() > 2 && self.is(&toks[1], ".") {
                let vname = self.text(&toks[2]).to_string();
                let exp_args: Vec<Ty> = match expected {
                    Some(Ty::Enum(en, args)) if en == text => args.clone(),
                    _ => Vec::new(),
                };
                if let Some((_, Some(payload_ty))) = variants.iter().find(|(vn, _)| vn == &vname) {
                    if toks.len() > 3 && self.is(&toks[3], "(") {
                        if let Some(close) = self.find_matching(toks, 3, "(", ")") {
                            let expected_payload = substitute_ty(payload_ty, &tparams, &exp_args);
                            let actual_payload = self.check_expr(&toks[4..close], Some(&expected_payload))?;
                            if !is_assignable(&expected_payload, &actual_payload) {
                                let arg_at = toks.get(4).map(|t| t.start).unwrap_or(first.start);
                                return self.err(
                                    arg_at,
                                    format!("Payload for {}.{} expects {}, got {}", text, vname, expected_payload, actual_payload),
                                );
                            }
                            let inferred_args = if !exp_args.is_empty() {
                                exp_args
                            } else if let Ty::TypeParam(tp) = payload_ty {
                                tparams.iter().map(|p| if p == tp { actual_payload.clone() } else { Ty::Any }).collect()
                            } else {
                                Vec::new()
                            };
                            return Ok((Ty::Enum(text.to_string(), inferred_args), close + 1));
                        }
                    }
                }
                return Ok((Ty::Enum(text.to_string(), exp_args), 3));
            }
        }
        // Data struct literal `DataName { field: expr, ... }`
        if let Some((tparams, raw_fields)) = self.env.data.get(text).cloned() {
            if toks.len() > 1 && self.is(&toks[1], "{") {
                if let Some(close) = self.find_matching(toks, 1, "{", "}") {
                    let exp_args: Vec<Ty> = match expected {
                        Some(Ty::Data(dn, args)) if dn == text => args.clone(),
                        _ => Vec::new(),
                    };
                    let fields: Vec<(String, Ty)> = raw_fields
                        .iter()
                        .map(|(n, ty)| (n.clone(), substitute_ty(ty, &tparams, &exp_args)))
                        .collect();
                    self.check_object_fields(&toks[2..close], Some((text, &fields)), first.start)?;
                    return Ok((Ty::Data(text.to_string(), exp_args), close + 1));
                }
            }
        }
        // Function call `name(args...)`
        if first.kind == Kind::Ident && toks.len() > 1 && self.is(&toks[1], "(") {
            if let Some(close) = self.find_matching(toks, 1, "(", ")") {
                let args = self.split_args(&toks[2..close]);
                let ret = self.check_fn_call(text, &args, first.start)?;
                return Ok((ret, close + 1));
            }
        }
        // Identifier lookup
        if first.kind == Kind::Ident {
            if let Some(ty) = self.scope.get(text) {
                return Ok((ty.clone(), 1));
            }
            // contexts: other contexts may use them freely; views declare them with `use`
            if self.env.contexts.contains_key(text) {
                if self.view.starts_with("@ctx:") {
                    return Ok((Ty::Context(text.to_string()), 1));
                }
                return self.err(first.start, format!("{} uses context {} without declaring it: add `use {};` to the view", self.view, text, text));
            }
            if text == "Date" || text == "Math" || text == "JSON" || text == "Object" || text == "Array" || text == "window" || text == "console" {
                return Ok((Ty::Any, 1));
            }
            return Ok((Ty::Any, 1));
        }

        Ok((Ty::Any, 1))
    }

    fn check_object_fields(
        &mut self,
        toks: &[Token],
        data_def: Option<(&str, &[(String, Ty)])>,
        lit_at: usize,
    ) -> Result<(), CompileError> {
        let mut seen = HashSet::new();
        let mut has_spread = false;
        for entry in self.split_args(toks) {
            if entry.is_empty() {
                continue;
            }
            if self.is(&entry[0], "...") {
                has_spread = true;
                self.check_expr(&entry[1..], None)?;
                continue;
            }
            if entry.len() >= 2 && self.is(&entry[1], ":") {
                let fname = self.text(&entry[0]).to_string();
                let fat = entry[0].start;
                seen.insert(fname.clone());
                let fval = &entry[2..];
                if let Some((dname, fields)) = data_def {
                    if let Some((_, fty)) = fields.iter().find(|(n, _)| n == &fname) {
                        let actual = self.check_expr(fval, Some(fty))?;
                        if !is_assignable(fty, &actual) {
                            return self.err(
                                fat,
                                format!("Field '{}' of {} expects {}, got {}", fname, dname, fty, actual),
                            );
                        }
                    } else {
                        let hint = closest(&fname, fields.iter().map(|(n, _)| n.as_str()))
                            .map(|s| format!(" (did you mean '{}'?)", s))
                            .unwrap_or_default();
                        return self.err(fat, format!("Unknown field '{}' on {}{}", fname, dname, hint));
                    }
                } else {
                    self.check_expr(fval, None)?;
                }
            } else if entry.len() == 1 && entry[0].kind == Kind::Ident {
                // Shorthand `{ id, text }`
                let fname = self.text(&entry[0]).to_string();
                let fat = entry[0].start;
                seen.insert(fname.clone());
                if let Some((dname, fields)) = data_def {
                    if let Some((_, fty)) = fields.iter().find(|(n, _)| n == &fname) {
                        let actual = self.scope.get(&fname).cloned().unwrap_or(Ty::Any);
                        if !is_assignable(fty, &actual) {
                            return self.err(
                                fat,
                                format!("Field '{}' of {} expects {}, got {}", fname, dname, fty, actual),
                            );
                        }
                    } else {
                        let hint = closest(&fname, fields.iter().map(|(n, _)| n.as_str()))
                            .map(|s| format!(" (did you mean '{}'?)", s))
                            .unwrap_or_default();
                        return self.err(fat, format!("Unknown field '{}' on {}{}", fname, dname, hint));
                    }
                }
            }
        }
        if let Some((dname, fields)) = data_def {
            if !has_spread {
                for (fname, fty) in fields {
                    if !seen.contains(fname) && !matches!(fty, Ty::Option(_) | Ty::Any) {
                        return self.err(lit_at, format!("Missing required field '{}' in {} literal", fname, dname));
                    }
                }
            }
        }
        Ok(())
    }

    fn check_field_access(&self, base: &Ty, field: &str, at: usize) -> Result<Ty, CompileError> {
        match base {
            Ty::Data(dname, targs) => {
                if let Some((tparams, fields)) = self.env.data.get(dname) {
                    if let Some((_, fty)) = fields.iter().find(|(n, _)| n == field) {
                        return Ok(substitute_ty(fty, tparams, targs));
                    }
                    let hint = closest(field, fields.iter().map(|(n, _)| n.as_str()))
                        .map(|s| format!(" (did you mean '{}'?)", s))
                        .unwrap_or_default();
                    return self.err(at, format!("Unknown field '{}' on {}{}", field, dname, hint));
                }
                Ok(Ty::Any)
            }
            Ty::Vec(_) | Ty::String if field == "length" => Ok(Ty::Number),
            Ty::RouteInfo => match field {
                "path" | "hash" => Ok(Ty::String),
                "params" | "query" => Ok(Ty::Record(Box::new(Ty::String))),
                _ => self.err(at, format!("Unknown field '{}' on route (available: path, params, query, hash)", field)),
            },
            Ty::CatchError => match field {
                "message" | "view" => Ok(Ty::String),
                _ => self.err(at, format!("Unknown field '{}' on CatchError (available: message, view)", field)),
            },
            Ty::Context(cname) => {
                if let Some((fields, _)) = self.env.contexts.get(cname) {
                    if let Some(fty) = fields.get(field) {
                        return Ok(fty.clone());
                    }
                    let hint = closest(field, fields.keys().map(|s| s.as_str()))
                        .map(|s| format!(" (did you mean '{}'?)", s))
                        .unwrap_or_default();
                    return self.err(at, format!("Unknown store or let '{}' on context '{}'{}", field, cname, hint));
                }
                Ok(Ty::Any)
            }
            Ty::Record(v) => Ok((**v).clone()),
            _ => Ok(Ty::Any),
        }
    }

    fn check_method_call(&mut self, base: &Ty, method: &str, args: &[Vec<Token>], at: usize) -> Result<Ty, CompileError> {
        // Context effect call: `Auth.SignIn("Ada")`
        if let Ty::Context(cname) = base {
            if let Some((_, effects)) = self.env.contexts.get(cname) {
                let Some(params) = effects.get(method) else {
                    let hint = closest(method, effects.keys().map(|s| s.as_str()))
                        .map(|s| format!(" (did you mean '{}'?)", s))
                        .unwrap_or_default();
                    return self.err(at, format!("Unknown effect '{}' on context '{}'{}", method, cname, hint));
                };
                if args.len() != params.len() {
                    return self.err(
                        at,
                        format!("Context effect '{}.{}' expects {} argument(s), got {}", cname, method, params.len(), args.len()),
                    );
                }
                for (i, (a, (pname, pty))) in args.iter().zip(params.iter()).enumerate() {
                    let actual = self.check_expr(a, Some(pty))?;
                    if !is_assignable(pty, &actual) {
                        let a_at = a.first().map(|t| t.start).unwrap_or(at);
                        return self.err(
                            a_at,
                            format!("Argument {} ('{}') of '{}.{}' expects {}, got {}", i + 1, pname, cname, method, pty, actual),
                        );
                    }
                }
                return Ok(Ty::Void);
            }
        }
        // Handle closure-taking Vec methods with inferred element parameter types
        if let Ty::Vec(elem) = base {
            match method {
                "len" => return Ok(Ty::Number),
                "is_empty" => return Ok(Ty::Bool),
                "push" => {
                    for a in args {
                        let t = self.check_expr(a, Some(elem))?;
                        if !is_assignable(elem, &t) {
                            return self.err(at, format!("Vec<{}>.push expects {}, got {}", elem, elem, t));
                        }
                    }
                    return Ok(Ty::Number);
                }
                "pop" => return Ok(Ty::Option(elem.clone())),
                "filter" | "retain" => {
                    if let Some(a0) = args.first() {
                        self.check_closure(a0, &[elem.as_ref().clone()])?;
                    }
                    return Ok(if method == "filter" { Ty::Vec(elem.clone()) } else { Ty::Void });
                }
                "find" => {
                    if let Some(a0) = args.first() {
                        self.check_closure(a0, &[elem.as_ref().clone()])?;
                    }
                    return Ok(Ty::Option(elem.clone()));
                }
                "find_index" | "findIndex" => {
                    if let Some(a0) = args.first() {
                        self.check_closure(a0, &[elem.as_ref().clone()])?;
                    }
                    return Ok(Ty::Number);
                }
                "some" | "every" => {
                    if let Some(a0) = args.first() {
                        self.check_closure(a0, &[elem.as_ref().clone()])?;
                    }
                    return Ok(Ty::Bool);
                }
                "map" => {
                    let mapped = if let Some(a0) = args.first() {
                        self.check_closure(a0, &[elem.as_ref().clone()])?
                    } else {
                        Ty::Any
                    };
                    return Ok(Ty::Vec(Box::new(mapped)));
                }
                "reduce" => {
                    let init_ty = if let Some(a1) = args.get(1) {
                        self.check_expr(a1, None)?
                    } else {
                        Ty::Any
                    };
                    if let Some(a0) = args.first() {
                        self.check_closure(a0, &[init_ty.clone(), elem.as_ref().clone()])?;
                    }
                    return Ok(init_ty);
                }
                "join" => {
                    for a in args {
                        self.check_expr(a, None)?;
                    }
                    return Ok(Ty::String);
                }
                "slice" | "concat" | "sort" => {
                    for a in args {
                        self.check_expr(a, None)?;
                    }
                    return Ok(Ty::Vec(elem.clone()));
                }
                "includes" | "contains" => {
                    for a in args {
                        self.check_expr(a, None)?;
                    }
                    return Ok(Ty::Bool);
                }
                _ => {}
            }
        }
        for a in args {
            self.check_expr(a, None)?;
        }
        match (base, method) {
            (Ty::String, "len") => Ok(Ty::Number),
            (Ty::String, "is_empty" | "contains" | "includes" | "startsWith" | "endsWith") => Ok(Ty::Bool),
            (Ty::String, "trim" | "toLowerCase" | "toUpperCase" | "replace" | "slice") => Ok(Ty::String),
            (Ty::String, "split") => Ok(Ty::Vec(Box::new(Ty::String))),
            (Ty::Number, "toFixed" | "toString") => Ok(Ty::String),
            (_, "len") => Ok(Ty::Number),
            (_, "is_empty") => Ok(Ty::Bool),
            _ => Ok(Ty::Any),
        }
    }

    fn check_closure(&mut self, toks: &[Token], param_tys: &[Ty]) -> Result<Ty, CompileError> {
        if toks.len() < 3 || !self.is(&toks[0], "|") {
            return self.check_expr(toks, None);
        }
        let Some(end_bar) = (1..toks.len()).find(|&k| self.is(&toks[k], "|")) else {
            return Ok(Ty::Any);
        };
        let pnames: Vec<String> = toks[1..end_bar]
            .iter()
            .filter(|t| t.kind == Kind::Ident)
            .map(|t| self.text(t).to_string())
            .collect();
        let body = &toks[end_bar + 1..];
        let saved = self.scope.clone();
        for (i, n) in pnames.iter().enumerate() {
            self.scope.insert(n.clone(), param_tys.get(i).cloned().unwrap_or(Ty::Any));
        }
        let ret = if !body.is_empty() && self.is(&body[0], "{") {
            if let Some(close) = self.find_matching(body, 0, "{", "}") {
                self.check_statements(&body[1..close])?;
            }
            Ty::Any
        } else {
            self.check_expr(body, None)?
        };
        self.scope = saved;
        Ok(ret)
    }

    fn check_fn_call(&mut self, name: &str, args: &[Vec<Token>], at: usize) -> Result<Ty, CompileError> {
        // 1. Built-in typed runtime helpers
        match name {
            "navigate" | "replace" => {
                if args.len() != 1 {
                    return self.err(at, format!("'{}' expects 1 argument (path: String), got {}", name, args.len()));
                }
                let t = self.check_expr(&args[0], Some(&Ty::String))?;
                if !is_assignable(&Ty::String, &t) {
                    return self.err(at, format!("'{}' expects String, got {}", name, t));
                }
                return Ok(Ty::Void);
            }
            "t" | "t_key" => {
                if let Some(a0) = args.first() {
                    let t = self.check_expr(a0, Some(&Ty::String))?;
                    if !is_assignable(&Ty::String, &t) {
                        return self.err(at, format!("'{}' key expects String, got {}", name, t));
                    }
                }
                for a in args.iter().skip(1) {
                    self.check_expr(a, None)?;
                }
                return Ok(Ty::String);
            }
            "random_uuid" => return Ok(Ty::String),
            "String" => {
                for a in args {
                    self.check_expr(a, None)?;
                }
                return Ok(Ty::String);
            }
            "Number" | "parseInt" | "parseFloat" => {
                for a in args {
                    self.check_expr(a, None)?;
                }
                return Ok(Ty::Number);
            }
            "Boolean" => {
                for a in args {
                    self.check_expr(a, None)?;
                }
                return Ok(Ty::Bool);
            }
            _ => {}
        }

        // 2. Typed `extern fn` declarations
        if let Some((params, ret)) = self.env.externs.get(name).cloned() {
            if args.len() != params.len() {
                return self.err(
                    at,
                    format!(
                        "extern fn '{}' expects {} argument(s), got {}",
                        name,
                        params.len(),
                        args.len()
                    ),
                );
            }
            for (i, (arg_toks, (pname, pty))) in args.iter().zip(params.iter()).enumerate() {
                let actual = self.check_expr(arg_toks, Some(pty))?;
                if !is_assignable(pty, &actual) {
                    let arg_at = arg_toks.first().map(|t| t.start).unwrap_or(at);
                    return self.err(
                        arg_at,
                        format!(
                            "Argument {} ('{}') of extern fn '{}' expects {}, got {}",
                            i + 1,
                            pname,
                            name,
                            pty,
                            actual
                        ),
                    );
                }
            }
            return Ok(ret);
        }

        // 3. Undeclared JS host function (gradual escape hatch): check arg expressions, return Any
        for a in args {
            self.check_expr(a, None)?;
        }
        Ok(Ty::Any)
    }

    fn extract_pat_binding(&self, pat: &[Token], scrut_ty: Option<&Ty>) -> Option<(String, Ty)> {
        // Qualified payload pattern: `Enum.Variant(x)`
        if pat.len() == 6
            && pat[0].kind == Kind::Ident
            && self.is(&pat[1], ".")
            && pat[2].kind == Kind::Ident
            && self.is(&pat[3], "(")
            && pat[4].kind == Kind::Ident
            && self.is(&pat[5], ")")
        {
            let ename = self.text(&pat[0]);
            let vname = self.text(&pat[2]);
            let bname = self.text(&pat[4]).to_string();
            let args: &[Ty] = match scrut_ty {
                Some(Ty::Enum(en, a)) if en == ename => a.as_slice(),
                _ => &[],
            };
            if let Some((tparams, variants)) = self.env.enums.get(ename) {
                if let Some((_, Some(pty))) = variants.iter().find(|(vn, _)| vn == vname) {
                    return Some((bname, substitute_ty(pty, tparams, args)));
                }
            }
            return Some((bname, Ty::Any));
        }
        // Bare payload pattern: `Variant(x)`
        if pat.len() == 4
            && pat[0].kind == Kind::Ident
            && self.is(&pat[1], "(")
            && pat[2].kind == Kind::Ident
            && self.is(&pat[3], ")")
        {
            let vname = self.text(&pat[0]);
            let bname = self.text(&pat[2]).to_string();
            if let Some(Ty::Enum(ename, args)) = scrut_ty {
                if let Some((tparams, variants)) = self.env.enums.get(ename) {
                    if let Some((_, Some(pty))) = variants.iter().find(|(vn, _)| vn == vname) {
                        return Some((bname, substitute_ty(pty, tparams, args)));
                    }
                }
            } else {
                for (tparams, variants) in self.env.enums.values() {
                    if let Some((_, Some(pty))) = variants.iter().find(|(vn, _)| vn == vname) {
                        return Some((bname, substitute_ty(pty, tparams, &[])));
                    }
                }
            }
            return Some((bname, Ty::Any));
        }
        // Simple catch-all identifier binding: `x` (lowercase)
        if pat.len() == 1 && pat[0].kind == Kind::Ident {
            let w = self.text(&pat[0]);
            if w != "_" && w != "true" && w != "false" && w != "null" && w.starts_with(|c: char| c.is_ascii_lowercase() || c == '_') {
                return Some((w.to_string(), scrut_ty.cloned().unwrap_or(Ty::Any)));
            }
        }
        None
    }

    fn check_match_arms(&mut self, toks: &[Token], scrut_ty: Option<&Ty>, expected: Option<&Ty>, is_stmt: bool) -> Result<Ty, CompileError> {
        let mut i = 0;
        let mut result_ty = Ty::Any;
        while i < toks.len() {
            let Some(arrow) = self.find_top_level(toks, i, "=>") else { break };
            let pat_toks = &toks[i..arrow];
            let pat_only = match self.find_top_level(pat_toks, 0, "if") {
                Some(g) => &pat_toks[..g],
                None => pat_toks,
            };
            let arm_bind = self.extract_pat_binding(pat_only, scrut_ty);
            let mut j = arrow + 1;
            if j >= toks.len() {
                break;
            }
            let arm_at = toks[j].start;
            if self.is(&toks[j], "{") {
                if let Some(close) = self.find_matching(toks, j, "{", "}") {
                    let saved = self.scope.clone();
                    if let Some((bname, bty)) = arm_bind {
                        self.scope.insert(bname, bty);
                    }
                    self.check_statements(&toks[j + 1..close])?;
                    self.scope = saved;
                    j = close + 1;
                    if j < toks.len() && self.is(&toks[j], ",") {
                        j += 1;
                    }
                } else {
                    break;
                }
            } else {
                let end = self.find_top_level(toks, j, ",").unwrap_or(toks.len());
                let saved = self.scope.clone();
                if let Some((bname, bty)) = arm_bind {
                    self.scope.insert(bname, bty);
                }
                if is_stmt {
                    self.check_statements(&toks[j..end])?;
                } else {
                    let t = self.check_expr(&toks[j..end], expected)?;
                    if let Some(exp) = expected {
                        if !is_assignable(exp, &t) {
                            self.scope = saved;
                            return self.err(arm_at, format!("Match arm produces {}, expected {}", t, exp));
                        }
                    }
                    // enum values compile to their (string) values, so String and an enum agree
                    // (only enums without payloads: tagged unions compile to objects)
                    let env = self.env;
                    let stringish = |x: &Ty| match x {
                        Ty::String => true,
                        Ty::Enum(n, a) => a.is_empty() && env.enums.get(n).is_some_and(|(_, vs)| vs.iter().all(|(_, p)| p.is_none())),
                        _ => false,
                    };
                    if expected.is_none() && result_ty != Ty::Any && t != Ty::Any && !matches!(t, Ty::Null) && !matches!(result_ty, Ty::Null) && !(stringish(&t) && stringish(&result_ty)) && !is_assignable(&result_ty, &t) && !is_assignable(&t, &result_ty) {
                        self.scope = saved;
                        return self.err(arm_at, format!("Match arms produce different types: {} here, {} before", t, result_ty));
                    }
                    result_ty = if result_ty == Ty::Any { t } else { unify(result_ty, t) };
                }
                self.scope = saved;
                j = (end + 1).min(toks.len());
            }
            i = j;
        }
        Ok(result_ty)
    }

    // ---- Token scanning helpers --------------------------------------------
    fn find_matching(&self, toks: &[Token], open_idx: usize, open: &str, close: &str) -> Option<usize> {
        let mut depth = 0i32;
        for (i, t) in toks.iter().enumerate().skip(open_idx) {
            if self.is(t, open) {
                depth += 1;
            } else if self.is(t, close) {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
        }
        None
    }

    fn find_top_level(&self, toks: &[Token], start: usize, needle: &str) -> Option<usize> {
        let mut depth = 0i32;
        for (i, t) in toks.iter().enumerate().skip(start) {
            if depth == 0 && self.is(t, needle) {
                return Some(i);
            }
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            }
        }
        None
    }

    fn find_top_level_ternary_colon(&self, toks: &[Token], start: usize) -> Option<usize> {
        let mut depth = 0i32;
        let mut nested_q = 0i32;
        for (i, t) in toks.iter().enumerate().skip(start) {
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            } else if depth == 0 {
                if self.is(t, "?") {
                    nested_q += 1;
                } else if self.is(t, ":") {
                    if nested_q == 0 {
                        return Some(i);
                    }
                    nested_q -= 1;
                }
            }
        }
        None
    }

    fn find_last_top_level(&self, toks: &[Token], ops: &[&str]) -> Option<usize> {
        let mut depth = 0i32;
        let mut found = None;
        for (i, t) in toks.iter().enumerate() {
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            } else if depth == 0 && ops.iter().any(|op| self.is(t, op)) {
                found = Some(i);
            }
        }
        found
    }

    fn find_last_top_level_binary(&self, toks: &[Token], ops: &[&str]) -> Option<usize> {
        let mut depth = 0i32;
        let mut found = None;
        for (i, t) in toks.iter().enumerate() {
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            } else if depth == 0 && i > 0 && ops.iter().any(|op| self.is(t, op)) {
                let prev = &toks[i - 1];
                // Ignore unary +/- after operators or punctuation
                let prev_is_val = prev.kind == Kind::Ident || prev.kind == Kind::Num || prev.kind == Kind::Str
                    || self.is(prev, ")") || self.is(prev, "]") || self.is(prev, "}");
                if prev_is_val {
                    found = Some(i);
                }
            }
        }
        found
    }

    fn find_top_level_assign(&self, toks: &[Token]) -> Option<(usize, &'static str)> {
        let mut depth = 0i32;
        for (i, t) in toks.iter().enumerate() {
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            } else if depth == 0 && i > 0 {
                for &op in &["=", "+=", "-=", "*=", "/="] {
                    if self.is(t, op) {
                        return Some((i, op));
                    }
                }
            }
        }
        None
    }

    fn find_stmt_end(&self, toks: &[Token], start: usize) -> usize {
        let mut depth = 0i32;
        for (i, t) in toks.iter().enumerate().skip(start) {
            if depth == 0 && self.is(t, ";") {
                return i;
            }
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            }
        }
        toks.len()
    }

    fn split_args(&self, toks: &[Token]) -> Vec<Vec<Token>> {
        if toks.is_empty() {
            return Vec::new();
        }
        let mut out = vec![Vec::new()];
        let mut depth = 0i32;
        for t in toks {
            if self.is(t, "(") || self.is(t, "[") || self.is(t, "{") {
                depth += 1;
            } else if self.is(t, ")") || self.is(t, "]") || self.is(t, "}") {
                depth -= 1;
            }
            if depth == 0 && self.is(t, ",") {
                out.push(Vec::new());
            } else {
                out.last_mut().unwrap().push(t.clone());
            }
        }
        if out.last().map_or(false, |v| v.is_empty()) {
            out.pop();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use crate::compile;

    #[test]
    fn catches_store_and_assignment_type_errors() {
        let e = compile("view A { store n: i32 = \"nope\"; state S { render { Text(\"{n}\") } } }").unwrap_err();
        assert!(e.message.contains("Type mismatch for store 'n'"), "{}", e);

        let e = compile("view A { store n: i32 = 0; state S { render { Button(\"x\") -> on_click(Go) } effect Go() { n = \"bad\"; } } }").unwrap_err();
        assert!(e.message.contains("Cannot assign String to 'n'"), "{}", e);

        let e = compile("view A { store n: i32 = 0; let bad: bool = n + 1; state S { render { Text(\"{bad}\") } } }").unwrap_err();
        assert!(e.message.contains("Type mismatch for let 'bad'"), "{}", e);
    }

    #[test]
    fn catches_data_struct_and_field_errors() {
        let e = compile("data User { id: i32, name: String }\nview A { store u: User = User { id: 1, nam: \"Ada\" }; state S { render { Text(u.name) } } }").unwrap_err();
        assert!(e.message.contains("Unknown field 'nam' on User (did you mean 'name'?)"), "{}", e);

        let e = compile("data User { id: i32, name: String }\nview A { store u: User = User { id: 1 }; state S { render { Text(u.name) } } }").unwrap_err();
        assert!(e.message.contains("Missing required field 'name'"), "{}", e);

        let e = compile("data User { id: i32, name: String }\nview A { store u: User = User { id: 1, name: \"Ada\" }; state S { render { Text(u.nam) } } }").unwrap_err();
        assert!(e.message.contains("Unknown field 'nam' on User (did you mean 'name'?)"), "{}", e);
    }

    #[test]
    fn checks_typed_extern_fns_and_view_props() {
        let ok = compile(
            "extern fn format_cents(cents: i32) -> String;\n\
             extern fn save_item(id: String, done: bool) -> Promise<bool>;\n\
             view Badge(text: String) { state Ready { render { Text(text) } } }\n\
             view App {\n\
                 store total: i32 = 420;\n\
                 let label: String = format_cents(total);\n\
                 state Ready {\n\
                     render { Badge(text: label) Button(\"Save\") -> on_click(Save) }\n\
                     effect Save() { save_item(\"a1\", true) -> transition(Saving); }\n\
                 }\n\
                 state Saving { render { Spinner(\"...\") } on_exit { transition Ready; } }\n\
             }",
        );
        assert!(ok.is_ok(), "{:?}", ok);

        let bad_arg = compile(
            "extern fn format_cents(cents: i32) -> String;\n\
             view App { let label: String = format_cents(\"oops\"); state Ready { render { Text(label) } } }",
        ).unwrap_err();
        assert!(bad_arg.message.contains("Argument 1 ('cents') of extern fn 'format_cents' expects number, got String"), "{}", bad_arg);

        let bad_arity = compile(
            "extern fn format_cents(cents: i32) -> String;\n\
             view App { let label: String = format_cents(1, 2); state Ready { render { Text(label) } } }",
        ).unwrap_err();
        assert!(bad_arity.message.contains("expects 1 argument(s), got 2"), "{}", bad_arity);

        let bad_ret = compile(
            "extern fn format_cents(cents: i32) -> String;\n\
             view App { let n: i32 = format_cents(10); state Ready { render { Text(\"{n}\") } } }",
        ).unwrap_err();
        assert!(bad_ret.message.contains("Type mismatch for let 'n'"), "{}", bad_ret);

        let bad_prop = compile(
            "view Badge(text: String) { state Ready { render { Text(text) } } }\n\
             view App { state Ready { render { Badge(text: 123) } } }",
        ).unwrap_err();
        assert!(bad_prop.message.contains("Prop 'text' of view 'Badge' expects String, got number"), "{}", bad_prop);

        let unknown_prop = compile(
            "view Badge(text: String) { state Ready { render { Text(text) } } }\n\
             view App { state Ready { render { Badge(tex: \"hi\") } } }",
        ).unwrap_err();
        assert!(unknown_prop.message.contains("Unknown prop 'tex' on view 'Badge' (did you mean 'text'?)"), "{}", unknown_prop);
    }

    #[test]
    fn checks_transitions_enums_and_router() {
        let bad_tr = compile("view App { state Idle { render { Button(\"x\") -> on_click(Go) } effect Go() { transition Missng; } } }").unwrap_err();
        assert!(bad_tr.message.contains("Unknown state 'Missng' in view 'App'"), "{}", bad_tr);

        let bad_cmp = compile(
            "enum A { X, Y }\nenum B { X, Y }\n\
             view App { store a: A = A.X; store b: B = B.X; let eq = a == b; state S { render { Text(\"{eq}\") } } }",
        ).unwrap_err();
        assert!(bad_cmp.message.contains("Cannot compare enum 'A' with enum 'B'"), "{}", bad_cmp);

        let router_ok = compile(
            "view Detail(id: String) { state Ready { render { Text(\"Order {id}\") } } }\n\
             view App {\n\
                 state Ready {\n\
                     render {\n\
                         Column {\n\
                             Link(\"/orders/42\", \"Order 42\")\n\
                             Router {\n\
                                 Route(\"/\") { Text(\"Home\") }\n\
                                 Route(\"/orders/:id\") { params => Detail(id: params.id) }\n\
                                 Route(\"*\") { Text(\"Not found: {route.path}\") }\n\
                             }\n\
                         }\n\
                     }\n\
                     effect GoHome() { navigate(\"/\"); }\n\
                 }\n\
             }",
        );
        assert!(router_ok.is_ok(), "{:?}", router_ok);

        let bad_nav = compile("view App { state S { render { Button(\"x\") -> on_click(Go) } effect Go() { navigate(123); } } }").unwrap_err();
        assert!(bad_nav.message.contains("'navigate' expects String, got number"), "{}", bad_nav);
    }

    #[test]
    fn checks_generics_tagged_unions_slots_portals_lifecycle_and_catch() {
        let ok = compile(
            "data User { id: i32, name: String }\n\
             data Page<T> { items: Vec<T>, total: i32 }\n\
             enum Async<T> { Idle, Loading, Ready(T), Failed(String) }\n\
             view Card(title: String) {\n\
                 state Open {\n\
                     render {\n\
                         Column {\n\
                             Text(title)\n\
                             Slot(name: \"header\")\n\
                             Slot()\n\
                         }\n\
                     }\n\
                 }\n\
             }\n\
             view App {\n\
                 store page: Page<User> = Page { items: [User { id: 1, name: \"Ada\" }], total: 1 };\n\
                 store req: Async<User> = Async.Ready(User { id: 2, name: \"Grace\" });\n\
                 let first_name: String = match req {\n\
                     Async.Ready(u) => u.name,\n\
                     Async.Failed(msg) => msg,\n\
                     Async.Idle | Async.Loading => \"none\",\n\
                 };\n\
                 on_unmount { console.log(\"app bye\"); }\n\
                 state Ready {\n\
                     on_enter { console.log(\"entered\"); }\n\
                     on_unmount { console.log(\"state bye\"); }\n\
                     render {\n\
                         Column {\n\
                             Card(title: first_name) {\n\
                                 Text(\"Header\", slot: \"header\")\n\
                                 Text(\"Body {page.total}\")\n\
                             }\n\
                             Portal(target: \"#modal-root\") {\n\
                                 Text(\"Modal\")\n\
                             }\n\
                             Catch {\n\
                                 Match(req) {\n\
                                     Ready(u) => Text(u.name)\n\
                                     Failed(msg) => Text(msg)\n\
                                     Idle | Loading => Spinner(\"...\")\n\
                                 }\n\
                             } Fallback { err =>\n\
                                 Text(\"Recovered: {err.message} in {err.view}\")\n\
                             }\n\
                         }\n\
                     }\n\
                 }\n\
             }",
        );
        assert!(ok.is_ok(), "{:?}", ok);

        // Wrong payload type for tagged union
        let bad_payload = compile(
            "enum Load { Idle, Ready(String) }\n\
             view App { store s: Load = Load.Ready(42); state S { render { Text(\"x\") } } }",
        ).unwrap_err();
        assert!(bad_payload.message.contains("Payload for Load.Ready expects String, got number"), "{}", bad_payload);

        // Bad field access on destructured generic payload
        let bad_field = compile(
            "data User { name: String }\n\
             enum Async<T> { Idle, Ready(T) }\n\
             view App {\n\
                 store req: Async<User> = Async.Idle;\n\
                 let n = match req { Async.Ready(u) => u.nam, Async.Idle => \"\" };\n\
                 state S { render { Text(n) } }\n\
             }",
        ).unwrap_err();
        assert!(bad_field.message.contains("Unknown field 'nam' on User"), "{}", bad_field);

        // Bad field on CatchError
        let bad_err = compile(
            "view App { state S { render { Catch { Text(\"ok\") } Fallback { err => Text(err.nope) } } } }",
        ).unwrap_err();
        assert!(bad_err.message.contains("Unknown field 'nope' on CatchError"), "{}", bad_err);
    }

    #[test]
    fn checks_contexts_pure_fns_forms_hotkeys_and_async_error_hooks() {
        let ok = compile(
            "fn format_cents(cents: i32) -> String {\n\
                 return \"$\" + (cents / 100).toFixed(2);\n\
             }\n\
             context Cart {\n\
                 store total: i32 = 0;\n\
                 let label: String = format_cents(total);\n\
                 effect Add(cents: i32) { total += cents; }\n\
                 effect Clear() { total = 0; }\n\
             }\n\
             extern fn checkout(amount: i32) -> Promise<String>;\n\
             view App {\n\
                 use Cart;\n\
                 store tier: String = \"pro\";\n\
                 store vol: i32 = 50;\n\
                 store msg: String = \"\";\n\
                 state Idle {\n\
                     on_key(\"Escape\") { Cart.Clear(); }\n\
                     render {\n\
                         Form {\n\
                             Text(Cart.label)\n\
                             Select(value: tier) {\n\
                                 Option(value: \"free\", \"Free\")\n\
                                 Option(value: \"pro\", \"Pro\")\n\
                             } -> on_change(SetTier)\n\
                             Slider(value: vol, min: 0, max: 100, step: 5) -> on_input(SetVol)\n\
                             Progress(value: vol, max: 100)\n\
                             Island(client: \"visible\") { Button(\"Clear\", disabled: Cart.total == 0) -> on_click(Cart.Clear) }\n\
                             Button(\"Pay\") -> on_click(Pay)\n\
                         } -> on_submit(Pay)\n\
                     }\n\
                     effect SetTier(v: String) { tier = v; }\n\
                     effect SetVol(v: i32) { vol = v; }\n\
                     effect Pay() { Cart.Add(500); checkout(Cart.total) -> transition(Paying); }\n\
                 }\n\
                 state Paying {\n\
                     render { Spinner(\"Paying...\") }\n\
                     on_exit(receipt: String) { msg = receipt; transition Idle; }\n\
                     on_error(err: String) { msg = err; transition Idle; }\n\
                 }\n\
             }",
        );
        assert!(ok.is_ok(), "{:?}", ok);

        let bad_fn = compile("fn dbl(n: i32) -> i32 { return n * 2; }\nview A { let x: i32 = dbl(\"no\"); state S { render { Text(\"{x}\") } } }").unwrap_err();
        assert!(bad_fn.message.contains("expects number, got String"), "{}", bad_fn);

        let bad_ctx_field = compile("context Auth { store user: String = \"\"; }\nview A { use Auth; state S { render { Text(Auth.usr) } } }").unwrap_err();
        assert!(bad_ctx_field.message.contains("Unknown store or let 'usr' on context 'Auth' (did you mean 'user'?)"), "{}", bad_ctx_field);

        let bad_ctx_eff = compile("context Auth { store user: String = \"\"; effect Login(u: String) { user = u; } }\nview A { use Auth; state S { render { Button(\"x\") -> on_click(Go) } effect Go() { Auth.Login(42); } } }").unwrap_err();
        assert!(bad_ctx_eff.message.contains("expects String, got number"), "{}", bad_ctx_eff);
    }

    #[test]
    fn checks_handlers_view_events_required_props_defaults_and_arm_types() {
        let err = |src: &str| compile(src).unwrap_err().message;
        // a handler must be an effect of the state it appears in
        assert!(err(r#"view A { state S { render { Button("b") -> on_click(Nope) } effect Nop() {} } }"#).contains("State S of A has no effect 'Nope' (did you mean 'Nop'?)"));
        assert!(err(r#"view A { state S { render { Button("b") -> on_click(E2) } } state T { render { Text("t") } effect E2() { transition S; } } }"#).contains("'E2' is an effect of state T, not S"));
        // events on components must be emitted by them (DOM events are fine)
        let r = r#"view R { state S { render { Button("r") -> on_click(P) } effect P() { emit pick(1); } } }"#;
        assert!(err(&format!("view A {{ state S {{ render {{ R() -> on_pik(E) }} effect E() {{}} }} }}\n{}", r)).contains("R never emits 'pik' (did you mean 'on_pick'?). It emits: on_pick"));
        assert!(compile(&format!("view A {{ state S {{ render {{ R() -> on_pick(E) -> on_click(E) }} effect E(n: any) {{}} }} }}\n{}", r)).is_ok());
        // props: the view's own `label` is type-checked, required props must be given
        let line = r#"view Line(label: String, check: bool = false, note: Option<String>) { state S { render { Text(label) } } }"#;
        assert!(err(&format!("view A {{ state S {{ render {{ Line(label: 5) }} }} }}\n{}", line)).contains("Prop 'label' of view 'Line' expects String, got number"));
        assert!(err(&format!("view A {{ state S {{ render {{ Line() }} }} }}\n{}", line)).contains("Line needs the prop 'label' (String)"));
        let ok = compile(&format!("view A {{ state S {{ render {{ Line(label: \"x\") }} }} }}\n{}", line));
        assert!(ok.is_ok(), "defaults and Option<…> props are optional: {:?}", ok.err());
        assert_eq!(ok.unwrap().views[1].params[1].default.as_deref(), Some("false"));
        assert!(err(r#"view R(n: i32 = "x") { state S { render { Text("r") } } }"#).contains("Default for prop 'n' should be number, got String"));
        // views can't take a built-in element's name
        assert!(err(r#"view Row { state S { render { Text("x") } } }"#).contains("'Row' is a built-in element"));
        // match arms must agree on a type (string enums count as String)
        assert!(err(r#"view A { store n: i32 = 1; let s = match n { 1 => "a", _ => 2 }; state S { render { Text("x") } } }"#).contains("Match arms produce different types"));
        assert!(compile("enum K { A, B }\nview A { store k: K = K.A; let s = match k { K.A => \"first\", other => other }; state S { render { Text(s) } } }").is_ok());
    }

    #[test]
    fn contexts_are_checked_like_modules() {
        let err = |src: &str| compile(src).unwrap_err().message;
        let a = "context A { store n: i32 = 0; effect Inc(by: i32) { n += by; } }\n";
        // one context calling another is type-checked
        assert!(err(&format!("{}context B {{ store k: i32 = 0; effect Go() {{ A.Inc(\"x\"); }} }}\nview V {{ use B; state S {{ render {{ Button(\"b\") -> on_click(B.Go) }} }} }}", a)).contains("Argument 1 ('by') of 'A.Inc' expects number, got String"));
        // views declare the contexts they read
        assert!(err(&format!("{}view V {{ state S {{ render {{ Text(A.n) }} }} }}", a)).contains("V uses context A without declaring it: add `use A;` to the view"));
        assert!(err(&format!("{}view V {{ state S {{ render {{ Button(\"b\") -> on_click(A.Inc) }} }} }}", a)).contains("add `use A;`"));
        // handlers name real contexts and effects
        assert!(err(&format!("{}view V {{ use A; state S {{ render {{ Button(\"b\") -> on_click(A.Incr) }} }} }}", a)).contains("Context A has no effect 'Incr' (did you mean 'Inc'?)"));
        assert!(err(&format!("{}view V {{ state S {{ render {{ Button(\"b\") -> on_click(B.Inc) }} }} }}", a)).contains("There is no context 'B'"));
        // assigning to something that isn't a store is a typo, not a new variable
        assert!(err(r#"view V { store clicks: i32 = 0; state S { render { Button("b") -> on_click(Go) } effect Go() { clics += 1; } } }"#).contains("'clics' isn't a store of view V (did you mean 'clicks'?)"));
        assert!(err("context C { store n: i32 = 0; effect Go() { m = 1; } }\nview V { state S { render { Text(\"x\") } } }").contains("'m' isn't a store of context C"));
        assert!(compile(r#"view V { store n: i32 = 0; state S { render { Button("b") -> on_click(Go) } effect Go(by: i32) { let k = by; k = k + 1; n = k; for i in 0..3 { n += i; } } } }"#).is_ok());
        assert!(compile(&format!("{}context B {{ let twice: i32 = A.n * 2; effect Go() {{ A.Inc(2); }} }}\nview V {{ use A; use B; state S {{ render {{ Text(B.twice) Button(\"b\") -> on_click(B.Go) }} }} }}", a)).is_ok());
    }
}
