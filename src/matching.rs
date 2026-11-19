//! Enums (unit and tagged-union ADTs with payloads) and exhaustive `match`.
//!
//! Unit enums compile to plain strings/numbers (`Status.Paid` -> `"Paid"`).
//! Tagged-union enums (any variant with a payload, e.g. `Ready(Vec<Item>)`)
//! compile to `{ tag: "Ready", value: ... }` objects and destructure cleanly
//! in `match` and render `Match(...)` with full exhaustiveness checking.
use super::{err_at, PResult, Parser};
use crate::ast::{EnumDecl, EnumVariant};
use crate::lexer::{unescape, Kind, Token};
use crate::parser::CompileError;
use crate::transpile::string_literal_to_js;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub(super) struct VariantInfo {
    pub name: String,
    pub value_js: String,
    pub payload: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct EnumInfo {
    pub variants: Vec<VariantInfo>,
    pub is_tagged: bool,
}

pub(super) type Enums = HashMap<String, EnumInfo>;

fn tok_text<'a>(src: &'a str, t: &Token) -> &'a str {
    &src[t.start..t.end]
}

fn literal_js(src: &str, t: &Token, neg: bool) -> Option<String> {
    match t.kind {
        Kind::Str => Some(serde_json::to_string(&unescape(tok_text(src, t))).unwrap()),
        Kind::Num => {
            let n = tok_text(src, t);
            n.parse::<f64>().ok().map(|_| format!("{}{}", if neg { "-" } else { "" }, n))
        }
        _ => None,
    }
}

/// Pre-scans top-level `enum Name[<T>] { ... }` declarations so code anywhere
/// in the program (including imported files) can use them.
pub(super) fn prescan_enums(src: &str, toks: &[Token]) -> Enums {
    let mut out = Enums::new();
    let mut depth = 0i32;
    let mut i = 0;
    let is = |t: &Token, s: &str| t.kind != Kind::Str && tok_text(src, t) == s;
    while i < toks.len() {
        let t = &toks[i];
        if is(t, "{") {
            depth += 1;
        } else if is(t, "}") {
            depth -= 1;
        } else if depth == 0 && t.kind == Kind::Ident && tok_text(src, t) == "enum" && toks.get(i + 1).is_some_and(|n| n.kind == Kind::Ident) {
            let name = tok_text(src, &toks[i + 1]).to_string();
            let mut k = i + 2;
            // Skip optional generic params `<T, U>`
            if toks.get(k).is_some_and(|n| is(n, "<")) {
                let mut gd = 0;
                while k < toks.len() {
                    if is(&toks[k], "<") {
                        gd += 1;
                    } else if is(&toks[k], ">") {
                        gd -= 1;
                        if gd == 0 {
                            k += 1;
                            break;
                        }
                    }
                    k += 1;
                }
            }
            if !toks.get(k).is_some_and(|n| is(n, "{")) {
                i += 1;
                continue;
            }
            let mut variants = Vec::new();
            let mut j = k + 1;
            while j < toks.len() && !is(&toks[j], "}") {
                if toks[j].kind == Kind::Ident {
                    let v = tok_text(src, &toks[j]).to_string();
                    let mut value_js = serde_json::to_string(&v).unwrap();
                    let mut payload = None;
                    if toks.get(j + 1).is_some_and(|n| is(n, "(")) {
                        let mut pd = 1;
                        let mut p = j + 2;
                        let mut pty = String::new();
                        while p < toks.len() && pd > 0 {
                            if is(&toks[p], "(") {
                                pd += 1;
                            } else if is(&toks[p], ")") {
                                pd -= 1;
                                if pd == 0 {
                                    break;
                                }
                            }
                            pty.push_str(tok_text(src, &toks[p]));
                            p += 1;
                        }
                        payload = Some(pty.trim().to_string());
                        j = p;
                    } else if toks.get(j + 1).is_some_and(|n| is(n, "=")) {
                        let neg = toks.get(j + 2).is_some_and(|n| is(n, "-"));
                        if let Some(lit) = toks.get(j + if neg { 3 } else { 2 }).and_then(|n| literal_js(src, n, neg)) {
                            value_js = lit;
                        }
                        j += if neg { 3 } else { 2 };
                    }
                    variants.push(VariantInfo { name: v, value_js, payload });
                }
                j += 1;
            }
            let is_tagged = variants.iter().any(|v| v.payload.is_some());
            out.entry(name).or_insert(EnumInfo { variants, is_tagged });
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

#[derive(Debug, Clone)]
enum Pat {
    Wild,
    Bind(String),
    Lit(String),
    Range(String, String, bool),
    /// Unit enum variant: JS value literal (`"Paid"`)
    Variant(String),
    /// Tagged-union variant: tag literal (`"Ready"`) + optional payload binding (`data`)
    TaggedVariant(String, Option<String>),
}

struct ArmInfo {
    alts: Vec<Pat>,
    guarded: bool,
    at: usize,
}

const OPEN: [&str; 3] = ["(", "[", "{"];
const CLOSE: [&str; 3] = [")", "]", "}"];

impl<'s> Parser<'s> {
    fn tis(&self, t: &Token, s: &str) -> bool {
        t.kind != Kind::Str && self.text(t) == s
    }

    pub(super) fn defer(&self, e: CompileError) {
        let mut d = self.deferred.borrow_mut();
        if d.is_none() {
            *d = Some(e);
        }
    }

    // ---- enum declarations ------------------------------------------------------
    pub(super) fn parse_enum(&mut self) -> PResult<EnumDecl> {
        self.expect("enum")?;
        let name = self.declare("Enum")?;
        let type_params = self.parse_type_params()?;
        self.expect("{")?;
        let mut variants = Vec::new();
        let mut seen = HashSet::new();
        while !self.at_end() && !self.is("}") {
            let at = self.peek().start;
            let v = self.expect_ident()?;
            if !v.starts_with(|c: char| c.is_ascii_uppercase()) {
                return Err(err_at(self.src, at, format!("Enum variants start with a capital letter: '{}'", v)));
            }
            if !seen.insert(v.clone()) {
                return Err(err_at(self.src, at, format!("{} already has a variant '{}'", name, v)));
            }
            let mut value = serde_json::to_string(&v).unwrap();
            let mut payload_type = None;
            if self.eat("(") {
                let pt = self.parse_type()?;
                self.expect(")")?;
                payload_type = Some(pt);
            } else if self.eat("=") {
                let neg = self.eat("-");
                let t = self.advance();
                value = literal_js(self.src, &t, neg).ok_or_else(|| err_at(self.src, t.start, "An enum value is a string or a number: `Gallery = \"grid\"`".to_string()))?;
            }
            variants.push(EnumVariant { name: v, value, payload_type });
            if !self.eat(",") && !self.is("}") {
                return self.err(format!("Expected ',' or '}}' in enum {}, got '{}'", name, self.describe()));
            }
        }
        self.expect("}")?;
        if variants.is_empty() {
            return self.err(format!("Enum {} has no variants", name));
        }
        Ok(EnumDecl { name, type_params, variants })
    }

    fn variant_info(&self, enum_name: &str, variant: &str) -> Option<&VariantInfo> {
        self.enums.get(enum_name)?.variants.iter().find(|v| v.name == variant)
    }

    // ---- token -> JS with enums and match lowered ----------------------------------
    pub(super) fn raw_join(&self, toks: &[Token], stmts: bool) -> String {
        let mut out = String::new();
        let mut i = 0;
        while i < toks.len() {
            let t = &toks[i];
            if i > 0 && t.start > toks[i - 1].end {
                out.push(' ');
            }
            if t.kind == Kind::Ident && self.text(t) == "match" && !(i > 0 && self.tis(&toks[i - 1], ".")) {
                let stmt = stmts && (i == 0 || [";", "{", "}"].iter().any(|s| self.tis(&toks[i - 1], s)));
                match self.lower_match(toks, i, stmt) {
                    Ok((js, next)) => {
                        out.push_str(&js);
                        i = next;
                        continue;
                    }
                    Err(e) => {
                        self.defer(e);
                        i += 1;
                        continue;
                    }
                }
            }
            if t.kind == Kind::Ident && self.enums.contains_key(self.text(t)) && toks.get(i + 1).is_some_and(|n| self.tis(n, ".")) && toks.get(i + 2).is_some_and(|n| n.kind == Kind::Ident) {
                let (e, v) = (self.text(t), self.text(&toks[i + 2]));
                let info = &self.enums[e];
                match self.variant_info(e, v) {
                    Some(vi) if info.is_tagged => {
                        if vi.payload.is_some() {
                            if toks.get(i + 3).is_some_and(|n| self.tis(n, "(")) {
                                let close = self.close_of(toks, i + 3);
                                let payload_js = self.raw_join(&toks[i + 4..close.min(toks.len())], false);
                                out.push_str(&format!("({{ tag: {}, value: ({}) }})", vi.value_js, payload_js));
                                i = (close + 1).min(toks.len());
                                continue;
                            } else {
                                self.defer(err_at(self.src, toks[i + 2].start, format!("{}.{} requires a payload value: `{}.{}(value)`", e, v, e, v)));
                                out.push_str("undefined");
                            }
                        } else {
                            out.push_str(&format!("({{ tag: {} }})", vi.value_js));
                        }
                    }
                    Some(vi) => out.push_str(&vi.value_js),
                    None => {
                        self.defer(err_at(self.src, toks[i + 2].start, format!("{} has no variant '{}'. Variants: {}", e, v, info.variants.iter().map(|x| x.name.as_str()).collect::<Vec<_>>().join(", "))));
                        out.push_str("undefined");
                    }
                }
                i += 3;
                continue;
            }
            // Option values: `Some(x)` -> `(x)`, `None` -> `null`
            if t.kind == Kind::Ident && !(i > 0 && self.tis(&toks[i - 1], ".")) {
                let w = self.text(t);
                if w == "None" {
                    out.push_str("null");
                    i += 1;
                    continue;
                }
                if w == "Some" && toks.get(i + 1).is_some_and(|n| self.tis(n, "(")) && !(i > 0 && self.tis(&toks[i - 1], "let")) {
                    i += 1;
                    continue;
                }
            }
            // `.len()` -> `.length`
            if self.tis(t, ".") && toks.get(i + 1).is_some_and(|n| self.tis(n, "len")) && toks.get(i + 2).is_some_and(|n| self.tis(n, "(")) && toks.get(i + 3).is_some_and(|n| self.tis(n, ")")) {
                out.push_str(".length");
                i += 4;
                continue;
            }
            match t.kind {
                Kind::Str => out.push_str(&string_literal_to_js(&unescape(self.text(t)))),
                _ => out.push_str(self.text(t)),
            }
            i += 1;
        }
        out.trim().to_string()
    }

    fn close_of(&self, toks: &[Token], open: usize) -> usize {
        let mut depth = 0;
        for (k, t) in toks.iter().enumerate().skip(open) {
            if OPEN.iter().any(|s| self.tis(t, s)) {
                depth += 1;
            } else if CLOSE.iter().any(|s| self.tis(t, s)) {
                depth -= 1;
                if depth == 0 {
                    return k;
                }
            }
        }
        toks.len()
    }

    fn lower_match(&self, toks: &[Token], i: usize, stmt: bool) -> PResult<(String, usize)> {
        let kw = &toks[i];
        let mut j = i + 1;
        let mut depth = 0;
        while j < toks.len() {
            let t = &toks[j];
            if depth == 0 && self.tis(t, "{") {
                break;
            }
            if self.tis(t, "(") || self.tis(t, "[") {
                depth += 1;
            } else if self.tis(t, ")") || self.tis(t, "]") {
                depth -= 1;
            }
            j += 1;
        }
        if j >= toks.len() || j == i + 1 {
            return Err(err_at(self.src, kw.start, "Expected `match <value> { pattern => … }`".to_string()));
        }
        let scrut = &toks[i + 1..j];
        let end = self.close_of(toks, j);
        if end >= toks.len() {
            return Err(err_at(self.src, toks[j].start, "This match has no closing '}'".to_string()));
        }
        let body = &toks[j + 1..end];
        let id = self.match_id.get() + 1;
        self.match_id.set(id);
        let v = format!("__m{}", id);
        let scrut_js = self.raw_join(scrut, false);
        let scrut_enum = self.enum_of_value(scrut);

        let mut arms: Vec<(ArmInfo, Option<String>, Vec<Token>, bool)> = Vec::new();
        let mut p = 0;
        let mut enum_name = scrut_enum.clone();
        while p < body.len() {
            let start = p;
            let mut depth = 0;
            let mut guard_at = None;
            while p < body.len() {
                let t = &body[p];
                if depth == 0 && t.kind == Kind::Op && self.text(t) == "=>" {
                    break;
                }
                if depth == 0 && guard_at.is_none() && self.tis(t, "if") && p > start {
                    guard_at = Some(p);
                }
                if OPEN.iter().any(|s| self.tis(t, s)) {
                    depth += 1;
                } else if CLOSE.iter().any(|s| self.tis(t, s)) {
                    depth -= 1;
                }
                p += 1;
            }
            if p >= body.len() {
                return Err(err_at(self.src, body[start].start, "Expected `=>` after the pattern".to_string()));
            }
            let pat_toks = &body[start..guard_at.unwrap_or(p)];
            let guard = guard_at.map(|g| self.raw_join(&body[g + 1..p], false));
            if pat_toks.is_empty() {
                return Err(err_at(self.src, body[start].start, "Expected a pattern before `=>`".to_string()));
            }
            let (alts, e) = self.parse_alts(pat_toks, enum_name.as_deref())?;
            if enum_name.is_none() {
                enum_name = e;
            }
            p += 1; // =>
            if p >= body.len() {
                return Err(err_at(self.src, body[p - 1].start, "Expected a value or a block after `=>`".to_string()));
            }
            let (arm_toks, is_block) = if self.tis(&body[p], "{") {
                let c = self.close_of(body, p);
                let t = body[p + 1..c.min(body.len())].to_vec();
                p = c + 1;
                (t, true)
            } else {
                let s = p;
                let mut depth = 0;
                while p < body.len() {
                    let t = &body[p];
                    if depth == 0 && self.tis(t, ",") {
                        break;
                    }
                    if OPEN.iter().any(|x| self.tis(t, x)) {
                        depth += 1;
                    } else if CLOSE.iter().any(|x| self.tis(t, x)) {
                        depth -= 1;
                    }
                    p += 1;
                }
                (body[s..p].to_vec(), false)
            };
            if p < body.len() && self.tis(&body[p], ",") {
                p += 1;
            }
            if is_block && !stmt {
                return Err(err_at(self.src, body[start].start, "In a match expression each arm is a value (`pattern => value,`). To run statements, use match as a statement.".to_string()));
            }
            arms.push((ArmInfo { alts, guarded: guard.is_some(), at: body[start].start }, guard, arm_toks, is_block));
        }
        if arms.is_empty() {
            return Err(err_at(self.src, kw.start, "A match needs at least one arm".to_string()));
        }
        let infos: Vec<&ArmInfo> = arms.iter().map(|a| &a.0).collect();
        self.check_exhaustive(&infos, enum_name.as_deref(), kw.start, &scrut_js)?;

        let mut js = String::new();
        if stmt {
            js.push_str(&format!("__match{}: {{ const {} = ({}); ", id, v, scrut_js));
        } else {
            js.push_str(&format!("(() => {{ const {} = ({}); ", v, scrut_js));
        }
        for (info, guard, arm_toks, is_block) in &arms {
            let value = self.raw_join(arm_toks, *is_block);
            let run = if stmt {
                if *is_block { format!("{} break __match{};", value, id) } else { format!("{}; break __match{};", value, id) }
            } else {
                format!("return ({});", value)
            };
            match info.alts.first() {
                Some(Pat::Bind(b)) => {
                    js.push_str(&format!("{{ const {} = {}; if ({}) {{ {} }} }} ", b, v, guard.as_deref().unwrap_or("true"), run));
                }
                Some(Pat::TaggedVariant(tag, Some(b))) if info.alts.len() == 1 => {
                    let g = guard.as_deref().unwrap_or("true");
                    js.push_str(&format!("if ({v} && {v}.tag === {tag}) {{ const {b} = {v}.value; if ({g}) {{ {run} }} }} "));
                }
                _ => {
                    let mut test = alts_test(&info.alts, &v);
                    if let Some(g) = guard {
                        test = format!("({}) && ({})", test, g);
                    }
                    js.push_str(&format!("if ({}) {{ {} }} ", test, run));
                }
            }
        }
        js.push_str(if stmt { "}" } else { "})()" });
        Ok((js, end + 1))
    }

    fn base_enum_name<'a>(&self, ty: &'a str) -> Option<String> {
        let base = ty.split('<').next().unwrap_or(ty).trim();
        self.enums.contains_key(base).then(|| base.to_string())
    }

    fn enum_of_value(&self, scrut: &[Token]) -> Option<String> {
        if scrut.len() != 1 || scrut[0].kind != Kind::Ident {
            return None;
        }
        let ty = self.var_types.get(self.text(&scrut[0]))?;
        self.base_enum_name(ty)
    }

    pub(super) fn enum_of_expr(&self, expr: &str) -> Option<String> {
        let ty = self.var_types.get(expr.trim())?;
        self.base_enum_name(ty)
    }

    fn resolve_enum_variant_pat(
        &self,
        owner: &str,
        variant: &str,
        bind: Option<String>,
        at: usize,
    ) -> PResult<Pat> {
        let info = &self.enums[owner];
        let Some(vi) = self.variant_info(owner, variant) else {
            return Err(err_at(
                self.src,
                at,
                format!(
                    "{} has no variant '{}'. Variants: {}",
                    owner,
                    variant,
                    info.variants.iter().map(|x| x.name.as_str()).collect::<Vec<_>>().join(", ")
                ),
            ));
        };
        if info.is_tagged {
            if bind.is_some() && vi.payload.is_none() {
                return Err(err_at(self.src, at, format!("{}.{} has no payload to destructure", owner, variant)));
            }
            Ok(Pat::TaggedVariant(vi.value_js.clone(), bind))
        } else {
            if bind.is_some() {
                return Err(err_at(self.src, at, format!("{}.{} has no payload to destructure", owner, variant)));
            }
            Ok(Pat::Variant(vi.value_js.clone()))
        }
    }

    fn parse_alts(&self, toks: &[Token], scrut_enum: Option<&str>) -> PResult<(Vec<Pat>, Option<String>)> {
        let mut alts = Vec::new();
        let mut cur: Vec<&Token> = Vec::new();
        let mut groups = Vec::new();
        let mut depth = 0i32;
        for t in toks {
            if OPEN.iter().any(|s| self.tis(t, s)) {
                depth += 1;
            } else if CLOSE.iter().any(|s| self.tis(t, s)) {
                depth -= 1;
            }
            if depth == 0 && t.kind == Kind::Punct && self.text(t) == "|" {
                groups.push(std::mem::take(&mut cur));
            } else {
                cur.push(t);
            }
        }
        groups.push(cur);
        let mut found_enum: Option<String> = scrut_enum.map(String::from);
        for g in &groups {
            let Some(first) = g.first() else {
                return Err(err_at(self.src, toks[0].start, "Empty alternative in pattern".to_string()));
            };
            let text: String = g.iter().map(|t| self.text(t)).collect();
            let pat = if g.len() == 1 && first.kind == Kind::Str {
                Pat::Lit(serde_json::to_string(&unescape(self.text(first))).unwrap())
            } else if let Some(r) = range_of(&text) {
                r
            } else if (g.len() == 1 && first.kind == Kind::Num) || (g.len() == 2 && self.tis(first, "-") && g[1].kind == Kind::Num) {
                if text.parse::<f64>().is_err() {
                    return Err(err_at(self.src, first.start, format!("'{}' is not a number", text)));
                }
                Pat::Lit(text.clone())
            } else if g.len() == 6 && g[0].kind == Kind::Ident && self.tis(g[1], ".") && g[2].kind == Kind::Ident && self.tis(g[3], "(") && g[4].kind == Kind::Ident && self.tis(g[5], ")") {
                // Qualified payload destructure: `Enum.Variant(binding)` or `Enum.Variant(_)`
                let (e, v, b) = (self.text(g[0]), self.text(g[2]), self.text(g[4]));
                if !self.enums.contains_key(e) {
                    return Err(err_at(self.src, g[0].start, format!("Unknown enum '{}'", e)));
                }
                if let Some(fe) = &found_enum {
                    if fe != e {
                        return Err(err_at(self.src, g[0].start, format!("This match is on {}, not {}", fe, e)));
                    }
                }
                found_enum.get_or_insert(e.to_string());
                let bind = (b != "_").then(|| b.to_string());
                self.resolve_enum_variant_pat(e, v, bind, g[2].start)?
            } else if g.len() == 4 && g[0].kind == Kind::Ident && self.tis(g[1], "(") && g[2].kind == Kind::Ident && self.tis(g[3], ")") && self.text(g[0]).starts_with(|c: char| c.is_ascii_uppercase()) {
                // Bare payload destructure: `Ready(data)`
                let (v, b) = (self.text(g[0]), self.text(g[2]));
                let owner = self.resolve_bare_variant_owner(v, found_enum.as_deref(), first.start)?;
                found_enum.get_or_insert(owner.clone());
                let bind = (b != "_").then(|| b.to_string());
                self.resolve_enum_variant_pat(&owner, v, bind, first.start)?
            } else if g.len() == 1 && first.kind == Kind::Ident {
                let w = self.text(first);
                match w {
                    "_" => Pat::Wild,
                    "true" | "false" | "null" => Pat::Lit(w.to_string()),
                    "None" => Pat::Lit("null".to_string()),
                    _ if w.starts_with(|c: char| c.is_ascii_uppercase()) => {
                        let owner = self.resolve_bare_variant_owner(w, found_enum.as_deref(), first.start)?;
                        found_enum.get_or_insert(owner.clone());
                        self.resolve_enum_variant_pat(&owner, w, None, first.start)?
                    }
                    _ => Pat::Bind(w.to_string()),
                }
            } else if g.len() == 3 && g[0].kind == Kind::Ident && self.tis(g[1], ".") && g[2].kind == Kind::Ident {
                let (e, v) = (self.text(g[0]), self.text(g[2]));
                if !self.enums.contains_key(e) {
                    return Err(err_at(self.src, g[0].start, format!("Unknown enum '{}'", e)));
                }
                if let Some(fe) = &found_enum {
                    if fe != e {
                        return Err(err_at(self.src, g[0].start, format!("This match is on {}, not {}", fe, e)));
                    }
                }
                found_enum.get_or_insert(e.to_string());
                self.resolve_enum_variant_pat(e, v, None, g[2].start)?
            } else {
                return Err(err_at(self.src, first.start, format!("Unsupported pattern '{}'. Patterns: literals, `a | b`, ranges `1..=5`, enum variants (with optional payload `(x)`), `_`, or a name (with an optional `if` guard)", text)));
            };
            alts.push(pat);
        }
        if alts.len() > 1 && alts.iter().any(|a| matches!(a, Pat::Bind(_) | Pat::TaggedVariant(_, Some(_)))) {
            return Err(err_at(self.src, toks[0].start, "A binding pattern can't be combined with `|`".to_string()));
        }
        Ok((alts, found_enum))
    }

    fn resolve_bare_variant_owner(&self, w: &str, found_enum: Option<&str>, at: usize) -> PResult<String> {
        match found_enum {
            Some(e) => {
                if self.variant_info(e, w).is_none() {
                    return Err(err_at(
                        self.src,
                        at,
                        format!(
                            "{} has no variant '{}'. Variants: {}",
                            e,
                            w,
                            self.enums[e].variants.iter().map(|x| x.name.as_str()).collect::<Vec<_>>().join(", ")
                        ),
                    ));
                }
                Ok(e.to_string())
            }
            None => {
                let owners: Vec<&String> = self
                    .enums
                    .iter()
                    .filter(|(_, info)| info.variants.iter().any(|x| x.name == w))
                    .map(|(k, _)| k)
                    .collect();
                match owners.len() {
                    1 => Ok(owners[0].clone()),
                    0 => Err(err_at(self.src, at, format!("Unknown pattern '{}': not a variant of any enum", w))),
                    _ => Err(err_at(self.src, at, format!("'{}' is a variant of several enums: write {}.{}", w, owners[0], w))),
                }
            }
        }
    }

    /// Exhaustive (every case handled) and no dead arms.
    fn check_exhaustive(&self, arms: &[&ArmInfo], enum_name: Option<&str>, at: usize, what: &str) -> PResult<()> {
        let mut covered: HashSet<String> = HashSet::new();
        let mut catch_all = false;
        for a in arms {
            if catch_all {
                return Err(err_at(self.src, a.at, "This arm can never match: an earlier arm matches everything".to_string()));
            }
            if a.guarded {
                continue;
            }
            let mut new_case = false;
            for p in &a.alts {
                let key = match p {
                    Pat::Wild | Pat::Bind(_) => {
                        catch_all = true;
                        new_case = true;
                        continue;
                    }
                    Pat::Lit(js) | Pat::Variant(js) | Pat::TaggedVariant(js, _) => js.clone(),
                    Pat::Range(a, b, inc) => format!("{}..{}{}", a, if *inc { "=" } else { "" }, b),
                };
                if covered.insert(key) {
                    new_case = true;
                }
            }
            if !new_case {
                return Err(err_at(self.src, a.at, "This arm can never match: earlier arms already handle these values".to_string()));
            }
        }
        if catch_all {
            return Ok(());
        }
        if let Some(e) = enum_name {
            let missing: Vec<String> = self.enums[e]
                .variants
                .iter()
                .filter(|v| !covered.contains(&v.value_js))
                .map(|v| format!("{}.{}", e, v.name))
                .collect();
            if missing.is_empty() {
                return Ok(());
            }
            return Err(err_at(self.src, at, format!("This match doesn't handle {} (add {} or `_ => …`)", missing.join(", "), if missing.len() == 1 { "an arm for it" } else { "arms for them" })));
        }
        if covered.contains("true") && covered.contains("false") {
            return Ok(());
        }
        Err(err_at(self.src, at, format!("This match on `{}` doesn't handle every value: add a `_ => …` arm", what)))
    }

    // ---- render Match --------------------------------------------------------------
    pub(super) fn parse_render_arms(&mut self, scrut_js: &str, at: usize) -> PResult<Vec<crate::ast::MatchArm>> {
        let scrut_enum = self.enum_of_expr(scrut_js);
        let mut enum_name = scrut_enum.clone();
        let mut out = Vec::new();
        let mut infos = Vec::new();
        while !self.at_end() && !self.is("}") {
            let start = self.peek().start;
            let mut pat = Vec::new();
            let mut guard = Vec::new();
            let mut in_guard = false;
            let mut depth = 0;
            while !self.at_end() && !(depth == 0 && self.is("=>")) {
                if depth == 0 && !in_guard && self.is("if") && !pat.is_empty() {
                    in_guard = true;
                    self.advance();
                    continue;
                }
                if self.is("(") || self.is("[") || self.is("{") {
                    depth += 1;
                } else if self.is(")") || self.is("]") || self.is("}") {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                }
                let t = self.advance();
                if in_guard { guard.push(t) } else { pat.push(t) }
            }
            if !self.is("=>") {
                return self.err("Expected `=>` after the pattern");
            }
            self.advance();
            if pat.is_empty() {
                return Err(err_at(self.src, start, "Expected a pattern before `=>`".to_string()));
            }
            let (alts, e) = self.parse_alts(&pat, enum_name.as_deref())?;
            if enum_name.is_none() {
                enum_name = e;
            }
            let arm_bind = match alts.first() {
                Some(Pat::Bind(b)) => Some((b.clone(), None)),
                Some(Pat::TaggedVariant(tag_js, Some(b))) => {
                    let vname = tag_js.trim_matches('"');
                    let hint = enum_name.as_ref().map(|e| format!("EnumPayload:{}:{}:{}", scrut_js.trim(), e, vname));
                    Some((b.clone(), hint))
                }
                _ => None,
            };
            if let Some((bname, hint)) = &arm_bind {
                self.render_locals.push((bname.clone(), hint.clone()));
            }
            let children = if self.is("{") {
                self.advance();
                let c = self.parse_render_block()?;
                self.expect("}")?;
                c
            } else {
                vec![self.parse_element()?]
            };
            if arm_bind.is_some() {
                self.render_locals.pop();
            }
            self.eat(",");
            let guard_js = (!guard.is_empty()).then(|| self.join_js(&guard));
            let (test, binding, binding_expr) = match alts.first() {
                Some(Pat::Bind(b)) => (guard_js.clone().unwrap_or_else(|| "true".to_string()), Some(b.clone()), None),
                Some(Pat::TaggedVariant(tag, Some(b))) if alts.len() == 1 => {
                    let base = format!("(__m && __m.tag === {})", tag);
                    let t = match &guard_js {
                        Some(g) => format!("({}) && ({})", base, g),
                        None => base,
                    };
                    (t, Some(b.clone()), Some("__m.value".to_string()))
                }
                _ => {
                    let t = alts_test(&alts, "__m");
                    (match &guard_js { Some(g) => format!("({}) && ({})", t, g), None => t }, None, None)
                }
            };
            infos.push(ArmInfo { alts, guarded: guard_js.is_some(), at: start });
            out.push(crate::ast::MatchArm { test, binding, binding_expr, children });
        }
        if out.is_empty() {
            return Err(err_at(self.src, at, "Match needs at least one arm".to_string()));
        }
        let refs: Vec<&ArmInfo> = infos.iter().collect();
        self.check_exhaustive(&refs, enum_name.as_deref(), at, scrut_js)?;
        Ok(out)
    }
}

fn range_of(text: &str) -> Option<Pat> {
    let (a, rest) = text.split_once("..")?;
    let (inc, b) = match rest.strip_prefix('=') {
        Some(b) => (true, b),
        None => (false, rest),
    };
    if a.parse::<f64>().is_err() || b.parse::<f64>().is_err() {
        return None;
    }
    Some(Pat::Range(a.to_string(), b.to_string(), inc))
}

fn alts_test(alts: &[Pat], v: &str) -> String {
    let parts: Vec<String> = alts
        .iter()
        .map(|p| match p {
            Pat::Wild | Pat::Bind(_) => "true".to_string(),
            Pat::Lit(js) | Pat::Variant(js) => format!("{} === {}", v, js),
            Pat::TaggedVariant(tag, _) => format!("({v} && {v}.tag === {tag})"),
            Pat::Range(a, b, inc) => format!("({v} >= {a} && {v} {} {b})", if *inc { "<=" } else { "<" }),
        })
        .collect();
    if parts.len() == 1 { parts.into_iter().next().unwrap() } else { format!("({})", parts.join(" || ")) }
}

#[cfg(test)]
mod tests {
    use crate::compile;

    fn err(src: &str) -> String {
        match compile(src) {
            Ok(_) => panic!("expected an error for:\n{}", src),
            Err(e) => format!("{}:{} {}", e.line, e.col, e.message),
        }
    }
    const VIEW: &str = "enum Layout { List, Gallery = \"grid\", Board = 3 }\nview V {\n    store layout: Layout = Layout.List;\n    store n: i32 = 0;\n    state S {\n        render { Text(\"x\") }\n        effect E() {\n";
    fn effect(body: &str) -> String {
        format!("{}{}\n        }}\n    }}\n}}\n", VIEW, body)
    }

    #[test]
    fn enums_compile_to_values() {
        let p = compile(&effect("layout = Layout.Gallery;")).unwrap();
        assert_eq!(p.enums[0].variants.iter().map(|v| v.value.as_str()).collect::<Vec<_>>(), ["\"List\"", "\"grid\"", "3"]);
        assert_eq!(p.views[0].stores[0].init_expr, "\"List\"");
        assert!(p.views[0].states[0].effects[0].js_body.contains("layout = \"grid\";"));
        assert!(err(&effect("layout = Layout.Grid;")).contains("Layout has no variant 'Grid'. Variants: List, Gallery, Board"));
    }

    #[test]
    fn tagged_union_enums_with_payloads() {
        let src = r#"
enum Load { Idle, Loading, Ready(String), Failed(String) }
view App {
    store load: Load = Load.Ready("hello");
    state Main {
        render {
            Match(load) {
                Load.Idle => Text("idle"),
                Load.Loading => Spinner("..."),
                Load.Ready(msg) => Text("ok: {msg}"),
                Load.Failed(e) => Text("err: {e}"),
            }
        }
        effect Fail() {
            let label = match load {
                Load.Idle => "idle",
                Load.Loading => "busy",
                Load.Ready(v) => v,
                Load.Failed(e) => e,
            };
            load = Load.Failed(label);
        }
    }
}
"#;
        let p = compile(src).unwrap();
        assert_eq!(p.views[0].stores[0].init_expr, "({ tag: \"Ready\", value: (\"hello\") })");
        let arms = p.views[0].states[0].render[0].arms.as_ref().unwrap();
        assert_eq!(arms[2].test, "(__m && __m.tag === \"Ready\")");
        assert_eq!(arms[2].binding.as_deref(), Some("msg"));
        assert_eq!(arms[2].binding_expr.as_deref(), Some("__m.value"));

        // Missing arm is still a compile error!
        let missing = src.replace("                Load.Failed(e) => Text(\"err: {e}\"),\n", "");
        assert!(err(&missing).contains("doesn't handle Load.Failed"));
    }

    #[test]
    fn match_statement_and_expression() {
        let p = compile(&effect("match layout {\n Layout.List => n = 1,\n Gallery | Board => { n = 2; transition S; }\n}\nlet s = match n { 0 => \"none\", 1 | 2 => \"few\", 3..=9 => \"some\", k if k < 0 => \"neg\", _ => \"many\" };")).unwrap();
        let js = &p.views[0].states[0].effects[0].js_body;
        assert!(js.contains("__match1: { const __m1 = (layout); if (__m1 === \"List\") { n = 1; break __match1; } if ((__m1 === \"grid\" || __m1 === 3)) { n = 2; __transition(\"S\"); break __match1; } }"), "{}", js);
        assert!(js.contains("let s = (() => { const __m2 = (n); if (__m2 === 0) { return (\"none\"); }"), "{}", js);
        assert!(js.contains("if ((__m2 >= 3 && __m2 <= 9)) { return (\"some\"); }"), "{}", js);
        assert!(js.contains("{ const k = __m2; if (k < 0) { return (\"neg\"); } }"), "{}", js);
        assert_eq!(p.views[0].states[0].effects[0].transitions[0].target, "S");
    }

    #[test]
    fn match_must_be_exhaustive_and_reachable() {
        assert!(err(&effect("match layout { Layout.List => n = 1 }")).contains("doesn't handle Layout.Gallery, Layout.Board"));
        assert!(err(&effect("match n { 1 => n = 2 }")).contains("doesn't handle every value: add a `_ => …` arm"));
        assert!(err(&effect("match n { _ => n = 2, 1 => n = 3 }")).contains("can never match: an earlier arm matches everything"));
        assert!(err(&effect("match n { 1 => n = 2, 1 => n = 3, _ => n = 4 }")).contains("can never match: earlier arms already handle"));
        assert!(err(&effect("let x = match n { 1 => { n = 2; }, _ => 0 };")).contains("In a match expression each arm is a value"));
        assert!(err(&effect("match n { k if k > 1 => n = 0 }")).contains("doesn't handle every value"));
        assert!(compile(&effect("let ok = true; match ok { true => n = 1, false => n = 0 }")).is_ok());
        assert!(err(&effect("let l = layout; match l { Layout.List => n = 1, Gallery => n = 2 }")).contains("doesn't handle Layout.Board"));
    }

    #[test]
    fn render_match_if_else_and_let() {
        let src = "enum Layout { List, Gallery }\nview V {\n    store layout: Layout = Layout.List;\n    store items: Vec<any> = [];\n    let count = items.len();\n    state S {\n        render {\n            Match(layout) {\n                List => Text(\"list\"),\n                Gallery => { Text(\"a\") Text(\"b\") }\n            }\n            If(count == 0) { Text(\"empty\") } Else If(count == 1) { Text(\"one\") } Else { Text(\"many\") }\n        }\n    }\n}\n";
        let p = compile(src).unwrap();
        let r = &p.views[0].states[0].render;
        let arms = r[0].arms.as_ref().unwrap();
        assert_eq!(arms.iter().map(|a| a.test.as_str()).collect::<Vec<_>>(), ["__m === \"List\"", "__m === \"Gallery\""]);
        assert_eq!(arms[1].children.len(), 2);
        let els = r[1].else_children.as_ref().unwrap();
        assert_eq!(els[0].tag, "If");
        assert_eq!(els[0].else_children.as_ref().unwrap()[0].tag, "Text");
        assert_eq!(p.views[0].derived[0].expr, "items.length");
        let bad = src.replace("                Gallery => { Text(\"a\") Text(\"b\") }\n", "");
        assert!(err(&bad).contains("doesn't handle Layout.Gallery"));
        assert!(err("view V { state S { render { Else { Text(\"x\") } } } }").contains("Else must follow an If block"));
    }

    #[test]
    fn loops_and_options() {
        let p = compile(&effect("for x in [1, 2] { n += x; }\nfor i in 0..n { n -= 1; }\nfor i in 1..=3 { n += i; }\nwhile n > 10 { n -= 1; }\nlet t = Some(n);\nif let Some(v) = t { n = v; }\nlet z = None;\nlet s = \"None stays\";")).unwrap();
        let js = &p.views[0].states[0].effects[0].js_body;
        for want in ["for (const x of [1, 2]) {", "for (let i = 0; i < n; i++) {", "for (let i = 1; i <= 3; i++) {", "while (n > 10) {", "let t = (n);", "let v; if ((v = (t)) != null) {", "let z = null;", "\"None stays\""] {
            assert!(js.contains(want), "missing `{}` in {}", want, js);
        }
    }

    #[test]
    fn multiple_enums_in_same_file() {
        let p = compile(
            "enum A { One = \"1\", Two = \"2\" }\n\
             enum B { Alpha, Beta }\n\
             enum C { X = \"\", Y = \"y\" }\n\
             view App {\n\
                 store c: C = C.X;\n\
                 state S { render { Match(c) { X => Text(\"x\") Y => Text(\"y\") } } }\n\
             }",
        );
        assert!(p.is_ok(), "{:?}", p);
    }
}
