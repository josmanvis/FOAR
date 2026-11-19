//! Recursive-descent parser for .foar sources.
use crate::ast::*;
use crate::css::{self, Ctx, Hoisted, NestedKind, StyleBlock, Value};
use crate::lexer::{lex, unescape, Kind, Token};
use crate::transpile::{rust_idioms_to_js, string_literal_to_js};
use serde_json::{Map, Value as J};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CompileError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{}: {}", self.line, self.col, self.message)
    }
}

fn err_at(src: &str, at: usize, message: String) -> CompileError {
    let at = at.min(src.len());
    let line = src[..at].matches('\n').count() + 1;
    let col = at - src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    CompileError { message, line, col }
}

type PResult<T> = Result<T, CompileError>;

pub struct Parser<'s> {
    src: &'s str,
    toks: Vec<Token>,
    pos: usize,
    hoisted: Hoisted,
    cur_view: Option<String>,
    cls_counter: usize,
    /// named style -> the styles it `@use`s (expanded onto elements after parsing)
    style_uses: std::collections::HashMap<String, Vec<String>>,
}

impl<'s> Parser<'s> {
    pub fn new(src: &'s str) -> PResult<Self> {
        let toks = lex(src).map_err(|at| err_at(src, at, "Unexpected character".to_string()))?;
        Ok(Self { src, toks, pos: 0, hoisted: Hoisted::default(), cur_view: None, cls_counter: 0, style_uses: Default::default() })
    }

    // ---- token helpers ----------------------------------------------------
    fn tok(&self, i: usize) -> &Token {
        &self.toks[i.min(self.toks.len() - 1)]
    }
    fn peek(&self) -> &Token {
        self.tok(self.pos)
    }
    fn peek_at(&self, off: usize) -> &Token {
        self.tok(self.pos + off)
    }
    fn text(&self, t: &Token) -> &str {
        &self.src[t.start..t.end]
    }
    fn at_end(&self) -> bool {
        self.peek().kind == Kind::Eof
    }
    fn tok_is(&self, t: &Token, s: &str) -> bool {
        t.kind != Kind::Str && t.kind != Kind::Eof && self.text(t) == s
    }
    fn is(&self, s: &str) -> bool {
        self.tok_is(self.peek(), s)
    }
    fn is_at(&self, off: usize, s: &str) -> bool {
        self.tok_is(self.peek_at(off), s)
    }
    fn advance(&mut self) -> Token {
        let t = self.peek().clone();
        if t.kind != Kind::Eof {
            self.pos += 1;
        }
        t
    }
    fn describe(&self) -> String {
        let t = self.peek();
        if t.kind == Kind::Eof { "end of file".to_string() } else { self.text(t).to_string() }
    }
    fn err<T>(&self, msg: impl Into<String>) -> PResult<T> {
        Err(err_at(self.src, self.peek().start, msg.into()))
    }
    fn expect(&mut self, s: &str) -> PResult<Token> {
        if self.is(s) { Ok(self.advance()) } else { self.err(format!("Expected '{}', got '{}'", s, self.describe())) }
    }
    fn expect_ident(&mut self) -> PResult<String> {
        if self.peek().kind == Kind::Ident {
            let t = self.advance();
            Ok(self.text(&t).to_string())
        } else {
            self.err(format!("Expected identifier, got '{}'", self.describe()))
        }
    }
    fn eat(&mut self, s: &str) -> bool {
        if self.is(s) {
            self.advance();
            true
        } else {
            false
        }
    }

    // ---- reconstruction ---------------------------------------------------
    /// Tokens -> JS, keeping the author's spacing; strings become JS literals
    /// (template literals when they interpolate), then Rust idioms are rewritten.
    fn join_js(&self, toks: &[Token]) -> String {
        if toks.is_empty() {
            return "undefined".to_string();
        }
        let mut out = String::new();
        for (i, t) in toks.iter().enumerate() {
            if i > 0 && t.start > toks[i - 1].end {
                out.push(' ');
            }
            match t.kind {
                Kind::Str => out.push_str(&string_literal_to_js(&unescape(self.text(t)))),
                _ => out.push_str(self.text(t)),
            }
        }
        rust_idioms_to_js(out.trim())
    }
    /// Tokens -> CSS text, keeping the author's spacing.
    fn join_css(&self, toks: &[Token]) -> String {
        let mut out = String::new();
        for (i, t) in toks.iter().enumerate() {
            if i > 0 && t.start > toks[i - 1].end {
                out.push(' ');
            }
            out.push_str(self.text(t));
        }
        out.trim().to_string()
    }

    // ---- program ----------------------------------------------------------
    pub fn parse_program(mut self) -> PResult<Program> {
        let mut data_decls = Vec::new();
        let mut views = Vec::new();
        while !self.at_end() {
            if self.is("data") {
                data_decls.push(self.parse_data()?);
            } else if self.is("view") {
                views.push(self.parse_view()?);
            } else if self.is("theme") {
                self.parse_theme()?;
            } else if self.is("style") && self.peek_at(1).kind == Kind::Ident && self.is_at(2, "{") {
                self.parse_named_style()?;
            } else if self.is("css") && self.is_at(1, "{") {
                self.parse_raw_css()?;
            } else if self.is("@keyframes") {
                self.advance();
                self.parse_keyframes_body()?;
            } else {
                return self.err(format!("Unexpected top-level token '{}'", self.describe()));
            }
        }
        // `style A { @use B; }` then `.style(A)`: the element needs B's class too.
        // Done after parsing because named styles may be declared after their use.
        let mut views = views;
        for v in &mut views {
            if let Some(st) = &mut v.style {
                expand_uses(st, &self.style_uses);
            }
            for s in &mut v.states {
                for el in &mut s.render {
                    expand_element(el, &self.style_uses);
                }
            }
        }
        Ok(Program { kind: "Program", data_decls, views, css: self.hoisted.css() })
    }

    fn parse_type(&mut self) -> PResult<String> {
        let base = self.expect_ident()?;
        if self.eat("<") {
            let inner = self.parse_type()?;
            self.expect(">")?;
            return Ok(format!("{}<{}>", base, inner));
        }
        Ok(base)
    }

    fn parse_data(&mut self) -> PResult<DataDecl> {
        self.expect("data")?;
        let name = self.expect_ident()?;
        self.expect("{")?;
        let mut fields = Vec::new();
        while !self.at_end() && !self.is("}") {
            let fname = self.expect_ident()?;
            self.expect(":")?;
            let field_type = self.parse_type()?;
            self.eat(",");
            fields.push(Field { name: fname, field_type });
        }
        self.expect("}")?;
        Ok(DataDecl { kind: "DataDecl", name, fields })
    }

    // ---- views ------------------------------------------------------------
    fn parse_view(&mut self) -> PResult<ViewDecl> {
        self.expect("view")?;
        let name = self.expect_ident()?;
        self.cur_view = Some(name.clone());
        self.cls_counter = 0;
        let mut params = Vec::new();
        if self.eat("(") {
            while !self.at_end() && !self.is(")") {
                let pname = self.expect_ident()?;
                self.expect(":")?;
                let param_type = self.parse_type()?;
                self.eat(",");
                params.push(Param { name: pname, param_type });
            }
            self.expect(")")?;
        }
        self.expect("{")?;
        let mut stores = Vec::new();
        let mut style = None;
        let mut states = Vec::new();
        while !self.at_end() && !self.is("}") {
            if self.is("store") {
                self.advance();
                let sname = self.expect_ident()?;
                let store_type = if self.eat(":") { self.parse_type()? } else { "any".to_string() };
                self.expect("=")?;
                let mut init = Vec::new();
                while !self.at_end() && !self.is(";") {
                    init.push(self.advance());
                }
                if init.is_empty() {
                    return self.err(format!("Expected an initial value for store {}", sname));
                }
                self.expect(";")?;
                stores.push(Store { name: sname, store_type, init_expr: self.join_js(&init) });
            } else if self.is("style") {
                self.advance();
                self.expect("{")?;
                let block = self.parse_style_block()?;
                self.expect("}")?;
                let ctx = Ctx { view: Some(&name), is_host: true, allow_dynamic: true };
                style = Some(self.compile_style(&block, &format!("f4-{}", name), &ctx)?);
            } else if self.is("state") {
                states.push(self.parse_state()?);
            } else {
                return self.err(format!("Unexpected token '{}' inside view {}", self.describe(), name));
            }
        }
        self.expect("}")?;
        self.cur_view = None;
        Ok(ViewDecl { kind: "ViewDecl", name, params, stores, style, states })
    }

    fn compile_style(&mut self, block: &StyleBlock, cls: &str, ctx: &Ctx) -> PResult<Style> {
        css::compile_block(block, cls, ctx, &mut self.hoisted).map_err(|m| err_at(self.src, self.peek().start, m))
    }

    fn parse_state(&mut self) -> PResult<StateDecl> {
        self.expect("state")?;
        let name = self.expect_ident()?;
        self.expect("{")?;
        let mut render = Vec::new();
        let mut effects = Vec::new();
        let mut on_exit = None;
        while !self.at_end() && !self.is("}") {
            if self.is("render") {
                self.advance();
                self.expect("{")?;
                render = self.parse_render_block()?;
                self.expect("}")?;
            } else if self.is("effect") {
                effects.push(self.parse_effect()?);
            } else if self.is("on_exit") {
                self.advance();
                let body = self.parse_balanced_braces()?;
                on_exit = Some(self.effect_body(&body));
            } else {
                return self.err(format!("Unexpected token '{}' in state {}", self.describe(), name));
            }
        }
        self.expect("}")?;
        Ok(StateDecl { kind: "StateDecl", name, render, effects, on_exit })
    }

    fn parse_render_block(&mut self) -> PResult<Vec<UiElement>> {
        let mut out = Vec::new();
        while !self.at_end() && !self.is("}") {
            out.push(self.parse_element()?);
        }
        Ok(out)
    }

    fn collect_arg_tokens(&mut self) -> Vec<Token> {
        let mut toks = Vec::new();
        let mut depth = 0i32;
        while !self.at_end() {
            if depth == 0 && (self.is(",") || self.is(")")) {
                break;
            }
            if self.is("(") || self.is("{") || self.is("[") {
                depth += 1;
            } else if self.is(")") || self.is("}") || self.is("]") {
                depth -= 1;
            }
            toks.push(self.advance());
        }
        toks
    }

    fn parse_element(&mut self) -> PResult<UiElement> {
        let tag = self.expect_ident()?;
        let mut el = UiElement {
            kind: "UIElement",
            tag: tag.clone(),
            args: Vec::new(),
            named_args: Map::new(),
            list_binding: None,
            list_expr: None,
            children: Vec::new(),
            events: Map::new(),
            style: None,
        };
        if self.eat("(") {
            if tag == "List" {
                let mut depth = 1;
                let mut toks = Vec::new();
                while !self.at_end() && depth > 0 {
                    if self.is("(") {
                        depth += 1;
                    } else if self.is(")") {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    toks.push(self.advance());
                }
                self.expect(")")?;
                // `List(items, empty: "No notes")`: split top-level commas;
                // the first segment is the items expression, the rest are named args.
                let mut segs: Vec<Vec<Token>> = vec![Vec::new()];
                let mut d = 0i32;
                for t in toks {
                    if self.tok_is(&t, "(") || self.tok_is(&t, "[") || self.tok_is(&t, "{") {
                        d += 1;
                    } else if self.tok_is(&t, ")") || self.tok_is(&t, "]") || self.tok_is(&t, "}") {
                        d -= 1;
                    }
                    if d == 0 && self.tok_is(&t, ",") {
                        segs.push(Vec::new());
                    } else {
                        segs.last_mut().unwrap().push(t);
                    }
                }
                let mut segs = segs.into_iter();
                el.list_expr = Some(self.join_js(&segs.next().unwrap_or_default()));
                for seg in segs {
                    if seg.len() >= 3 && seg[0].kind == Kind::Ident && self.tok_is(&seg[1], ":") {
                        let name = self.text(&seg[0]).to_string();
                        el.named_args.insert(name, J::String(self.join_js(&seg[2..])));
                    } else if !seg.is_empty() {
                        return Err(err_at(self.src, seg[0].start, "Expected `name: value` after the List items expression".to_string()));
                    }
                }
            } else {
                while !self.at_end() && !self.is(")") {
                    if self.peek().kind == Kind::Ident && self.is_at(1, ":") {
                        let name = self.expect_ident()?;
                        self.expect(":")?;
                        let toks = self.collect_arg_tokens();
                        el.named_args.insert(name, J::String(self.join_js(&toks)));
                    } else {
                        let toks = self.collect_arg_tokens();
                        el.args.push(self.join_js(&toks));
                    }
                    self.eat(",");
                }
                self.expect(")")?;
            }
        }
        if self.eat("{") {
            if tag == "List" && self.peek().kind == Kind::Ident && self.is_at(1, "=>") {
                el.list_binding = Some(self.expect_ident()?);
                self.expect("=>")?;
            }
            el.children = self.parse_render_block()?;
            self.expect("}")?;
        }
        loop {
            if self.eat("->") {
                let ev = self.expect_ident()?;
                self.expect("(")?;
                let handler = self.expect_ident()?;
                self.expect(")")?;
                el.events.insert(ev, J::String(handler));
            } else if self.is(".") && self.is_at(1, "style") {
                self.advance();
                self.advance();
                self.expect("(")?;
                el.style = Some(self.parse_style_ref()?);
                self.expect(")")?;
            } else {
                break;
            }
        }
        Ok(el)
    }

    /// `.style({ ... })`, `.style(Name)`, or `.style(Name, { ... })`
    fn parse_style_ref(&mut self) -> PResult<Style> {
        let mut block = StyleBlock::default();
        if self.peek().kind == Kind::Ident {
            block.uses.push(self.expect_ident()?);
            if self.eat(",") {
                self.expect("{")?;
                let inner = self.parse_style_block()?;
                self.expect("}")?;
                block.decls = inner.decls;
                block.nested = inner.nested;
                block.uses.extend(inner.uses);
            }
        } else {
            self.expect("{")?;
            block = self.parse_style_block()?;
            self.expect("}")?;
        }
        let view = self.cur_view.clone().unwrap_or_default();
        self.cls_counter += 1;
        let cls = format!("f4-{}-{}", view, self.cls_counter);
        let ctx = Ctx { view: Some(&view), is_host: false, allow_dynamic: true };
        self.compile_style(&block, &cls, &ctx)
    }

    fn parse_balanced_braces(&mut self) -> PResult<Vec<Token>> {
        self.expect("{")?;
        let mut toks = Vec::new();
        let mut depth = 1;
        while !self.at_end() && depth > 0 {
            if self.is("{") {
                depth += 1;
            } else if self.is("}") {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            toks.push(self.advance());
        }
        self.expect("}")?;
        Ok(toks)
    }

    fn parse_effect(&mut self) -> PResult<EffectDecl> {
        self.expect("effect")?;
        let name = self.expect_ident()?;
        self.expect("(")?;
        let mut params = Vec::new();
        while !self.at_end() && !self.is(")") {
            let pname = self.expect_ident()?;
            let param_type = if self.eat(":") { self.parse_type()? } else { "any".to_string() };
            self.eat(",");
            params.push(Param { name: pname, param_type });
        }
        self.expect(")")?;
        let body = self.parse_balanced_braces()?;
        let b = self.effect_body(&body);
        Ok(EffectDecl { kind: "EffectDecl", name, params, transitions: b.transitions, emissions: b.emissions, js_body: b.js_body })
    }

    fn effect_body(&self, toks: &[Token]) -> EffectBody {
        let mut transitions = Vec::new();
        let mut emissions = Vec::new();
        for i in 0..toks.len() {
            if self.tok_is(&toks[i], "transition") {
                if let Some(n) = toks.get(i + 1) {
                    if self.tok_is(n, "(") {
                        if let Some(t) = toks.get(i + 2) {
                            transitions.push(Transition { target: self.text(t).to_string(), is_async: true });
                        }
                    } else if n.kind == Kind::Ident {
                        transitions.push(Transition { target: self.text(n).to_string(), is_async: false });
                    }
                }
            } else if self.tok_is(&toks[i], "emit") {
                if let Some(n) = toks.get(i + 1) {
                    if n.kind == Kind::Ident {
                        emissions.push(self.text(n).to_string());
                    }
                }
            }
        }
        EffectBody { transitions, emissions, js_body: self.join_js(toks) }
    }

    // ---- styles -----------------------------------------------------------
    fn parse_style_block(&mut self) -> PResult<StyleBlock> {
        let mut block = StyleBlock::default();
        while !self.at_end() && !self.is("}") {
            if self.peek().kind == Kind::Special && self.text(self.peek()).starts_with('@') {
                let t = self.advance();
                let name = self.text(&t).to_string();
                match name.as_str() {
                    "@use" => {
                        block.uses.push(self.expect_ident()?);
                        self.eat(";");
                    }
                    "@keyframes" => self.parse_keyframes_body()?,
                    _ => {
                        let mut arg_toks = Vec::new();
                        while !self.at_end() && !self.is("{") {
                            arg_toks.push(self.advance());
                        }
                        let args = self.join_css(&arg_toks);
                        self.expect("{")?;
                        let sub = self.parse_style_block()?;
                        self.expect("}")?;
                        self.eat(";");
                        let kind = match name.as_str() {
                            "@media" => NestedKind::Media(args),
                            "@state" => NestedKind::State(args),
                            "@dark" => NestedKind::Media("(prefers-color-scheme: dark)".to_string()),
                            "@light" => NestedKind::Media("(prefers-color-scheme: light)".to_string()),
                            "@reduced-motion" => NestedKind::Media("(prefers-reduced-motion: reduce)".to_string()),
                            _ => NestedKind::Pseudo(format!("{}{}", &name[1..], args)),
                        };
                        block.nested.push((kind, sub));
                    }
                }
                continue;
            }
            let mut name_toks = Vec::new();
            while !self.at_end() && !self.is(":") && !self.is("}") && !self.is(";") {
                name_toks.push(self.advance());
            }
            if name_toks.is_empty() {
                return self.err(format!("Expected a style property, got '{}'", self.describe()));
            }
            self.expect(":")?;
            let mut val_toks = Vec::new();
            let mut depth = 0i32;
            while !self.at_end() {
                if depth == 0 && (self.is(";") || self.is("}")) {
                    break;
                }
                if self.is("(") || self.is("{") || self.is("[") {
                    depth += 1;
                } else if self.is(")") || self.is("}") || self.is("]") {
                    depth -= 1;
                }
                val_toks.push(self.advance());
            }
            self.eat(";");
            let key = self.join_css(&name_toks).replace(' ', "");
            let value = self.parse_value(&val_toks)?;
            block.decls.push((key, value));
        }
        Ok(block)
    }

    fn parse_value(&self, toks: &[Token]) -> PResult<Value> {
        let has_interp = toks.iter().any(|t| self.tok_is(t, "{"));
        if has_interp {
            let mut tpl = String::from("`");
            let mut i = 0;
            let mut prev_end: Option<usize> = None;
            while i < toks.len() {
                let t = &toks[i];
                if self.tok_is(t, "{") {
                    let mut depth = 1;
                    let mut j = i + 1;
                    while j < toks.len() {
                        if self.tok_is(&toks[j], "{") {
                            depth += 1;
                        } else if self.tok_is(&toks[j], "}") {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        j += 1;
                    }
                    if j >= toks.len() {
                        return Err(err_at(self.src, t.start, "Unclosed '{' in style value".to_string()));
                    }
                    if let Some(pe) = prev_end {
                        if t.start > pe {
                            tpl.push(' ');
                        }
                    }
                    tpl.push_str("${");
                    tpl.push_str(&self.join_js(&toks[i + 1..j]));
                    tpl.push('}');
                    prev_end = Some(toks[j].end);
                    i = j + 1;
                    continue;
                }
                if let Some(pe) = prev_end {
                    if t.start > pe {
                        tpl.push(' ');
                    }
                }
                tpl.push_str(&self.text(t).replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${"));
                prev_end = Some(t.end);
                i += 1;
            }
            tpl.push('`');
            return Ok(Value::Dynamic(tpl));
        }
        let mut depth = 0i32;
        let mut q = None;
        for (i, t) in toks.iter().enumerate() {
            if self.tok_is(t, "(") || self.tok_is(t, "[") {
                depth += 1;
            } else if self.tok_is(t, ")") || self.tok_is(t, "]") {
                depth -= 1;
            } else if depth == 0 && self.tok_is(t, "?") {
                q = Some(i);
                break;
            }
        }
        if let Some(q) = q {
            let mut depth = 0i32;
            let mut colon = None;
            for (i, t) in toks.iter().enumerate().skip(q + 1) {
                if self.tok_is(t, "(") || self.tok_is(t, "[") {
                    depth += 1;
                } else if self.tok_is(t, ")") || self.tok_is(t, "]") {
                    depth -= 1;
                } else if depth == 0 && self.tok_is(t, ":") {
                    colon = Some(i);
                    break;
                }
            }
            let colon = match colon {
                Some(c) => c,
                None => return Err(err_at(self.src, toks[q].start, "Expected ':' in conditional style value".to_string())),
            };
            let cond = self.join_js(&toks[..q]);
            let a = self.join_css(&toks[q + 1..colon]);
            let b = self.join_css(&toks[colon + 1..]);
            return Ok(Value::Dynamic(format!(
                "({}) ? {} : {}",
                cond,
                serde_json::to_string(&a).unwrap(),
                serde_json::to_string(&b).unwrap()
            )));
        }
        Ok(Value::Static(self.join_css(toks)))
    }

    /// After the `@keyframes` token: `name { from { } 50% { } to { } }`
    fn parse_keyframes_body(&mut self) -> PResult<()> {
        let mut name_toks = Vec::new();
        while !self.at_end() && !self.is("{") {
            name_toks.push(self.advance());
        }
        let name = self.join_css(&name_toks).replace(' ', "");
        if name.is_empty() {
            return self.err("Expected a @keyframes name");
        }
        self.expect("{")?;
        let mut frames = Vec::new();
        while !self.at_end() && !self.is("}") {
            let mut sel_toks = Vec::new();
            while !self.at_end() && !self.is("{") {
                sel_toks.push(self.advance());
            }
            let sel = self.join_css(&sel_toks);
            self.expect("{")?;
            let block = self.parse_style_block()?;
            self.expect("}")?;
            self.eat(";");
            let mut lines = Vec::new();
            for (k, v) in &block.decls {
                match v {
                    Value::Static(s) => lines.extend(css::css_decls(k, s)),
                    Value::Dynamic(_) => return self.err("dynamic values are not allowed inside @keyframes"),
                }
            }
            frames.push(format!("{}{{{}}}", sel, lines.join(";")));
        }
        self.expect("}")?;
        self.hoisted.rules.push(format!("@keyframes {}{{{}}}", name, frames.join("")));
        Ok(())
    }

    fn parse_theme(&mut self) -> PResult<()> {
        self.expect("theme")?;
        self.expect("{")?;
        let block = self.parse_style_block()?;
        self.expect("}")?;
        css::compile_root(&block, &mut self.hoisted).map_err(|m| err_at(self.src, self.peek().start, m))
    }

    fn parse_named_style(&mut self) -> PResult<()> {
        self.expect("style")?;
        let name = self.expect_ident()?;
        self.expect("{")?;
        let block = self.parse_style_block()?;
        self.expect("}")?;
        let ctx = Ctx { view: None, is_host: false, allow_dynamic: false };
        self.compile_style(&block, &format!("f4-{}", name), &ctx)?;
        self.style_uses.insert(name, block.uses.clone());
        Ok(())
    }

    /// `css { ...verbatim... }`
    fn parse_raw_css(&mut self) -> PResult<()> {
        self.expect("css")?;
        let open = self.expect("{")?;
        let mut depth = 1;
        let mut i = self.pos;
        while i < self.toks.len() - 1 {
            if self.tok_is(&self.toks[i], "{") {
                depth += 1;
            } else if self.tok_is(&self.toks[i], "}") {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            i += 1;
        }
        if depth != 0 {
            return Err(err_at(self.src, open.start, "Unclosed css { } block".to_string()));
        }
        let close = self.toks[i].clone();
        self.hoisted.rules.push(self.src[open.end..close.start].trim().to_string());
        self.pos = i + 1;
        Ok(())
    }
}

fn expand_uses(st: &mut Style, uses: &std::collections::HashMap<String, Vec<String>>) {
    let Some(cls) = &st.cls else { return };
    let mut out: Vec<String> = cls.split(' ').map(str::to_string).collect();
    let mut i = 0;
    while i < out.len() {
        if let Some(name) = out[i].strip_prefix("f4-") {
            for u in uses.get(name).into_iter().flatten() {
                let c = format!("f4-{}", u);
                if !out.contains(&c) {
                    out.push(c);
                }
            }
        }
        i += 1;
    }
    st.cls = Some(out.join(" "));
}

fn expand_element(el: &mut UiElement, uses: &std::collections::HashMap<String, Vec<String>>) {
    if let Some(st) = &mut el.style {
        expand_uses(st, uses);
    }
    for c in &mut el.children {
        expand_element(c, uses);
    }
}

#[cfg(test)]
mod tests {
    use crate::compile;

    #[test]
    fn examples_parse() {
        let p = compile(include_str!("../examples/TodoApp.foar")).unwrap();
        assert_eq!(p.views.len(), 2);
        assert_eq!(p.views[0].stores[0].init_expr.starts_with("[ {"), true, "{}", p.views[0].stores[0].init_expr);
        assert!(p.css.contains(".f4-TodoItem.f4-TodoItem:hover{background:var(--row-hover)}"));
        let item_text = &p.views[1].states[0].render[1];
        assert_eq!(item_text.tag, "Text");
        let st = item_text.style.as_ref().unwrap();
        assert_eq!(st.dynamic[0].key, "text-decoration");
        assert_eq!(st.dynamic[0].expr, "(item.completed) ? \"line-through\" : \"none\"");
        let c = compile(include_str!("../examples/Counter.foar")).unwrap();
        let fin = &c.views[0].states[1].effects[2];
        assert_eq!(fin.name, "FinishAndSave");
        assert_eq!(fin.js_body, "__asyncTransition(\"api_save\", [count], \"Saving\");");
        assert!(fin.transitions[0].is_async);
    }

    #[test]
    fn css_features() {
        let src = r#"
            theme { --accent: #07f; --radius: 6px; @dark { --accent: #4da3ff; } }
            style Card { padding: 12px; border-radius: var(--radius); @hover { box-shadow: 0 2px 8px rgba(0,0,0,.2); } }
            style Drop { @drop-over { outline: 2px solid red; } @drag-source { opacity: .5; } @reduced-motion { animation: none; } }
            @keyframes pulse { from { transform: scale(1); } to { transform: scale(1.05); } }
            @keyframes fade-in-up { from { opacity: 0; } to { opacity: 1; } }
            css { .legacy > b { font-weight: 700 } }
            view V {
                store hue: i32 = 200;
                store big: bool = false;
                style {
                    --hue: {hue};
                    background: hsl(var(--hue) 80% 50%);
                    animation: pulse 1s ease-in-out infinite alternate;
                    width: calc(100% - 20px);
                    @state Open { outline: 2px solid var(--accent); }
                    @media (max-width: 600px) { padding: 4px; }
                    @hover { color: {big ? "red" : "blue"}; }
                }
                state Open {
                    render {
                        Text("x").style(Card, { font-size: big ? 24px : 14px; @focus-within { color: red; } })
                        Button("y").style(Card)
                    }
                }
            }"#;
        let p = compile(src).unwrap();
        let css = &p.css;
        assert!(css.contains(":root{--accent:#07f;--radius:6px}"), "{}", css);
        assert!(css.contains("@media (prefers-color-scheme: dark){:root{--accent:#4da3ff}}"));
        assert!(css.contains(".f4-Card.f4-Card{padding:12px;border-radius:var(--radius)}"));
        assert!(css.contains(".f4-Card.f4-Card:hover{box-shadow:0 2px 8px rgba(0,0,0,.2)}"));
        assert!(css.contains("@keyframes pulse{from{transform:scale(1)}to{transform:scale(1.05)}}"));
        assert!(css.contains(".legacy > b { font-weight: 700 }"));
        assert!(css.contains(".f4-Drop.f4-Drop.f4-drop-over{outline:2px solid red}"), "{}", css);
        // @use inside a named style reaches elements that use it, even when declared later.
        let p2 = compile("view W { state S { render { Text(\"x\").style(Late) } } } style Base { color: red; } style Late { @use Base; padding: 1px; }").unwrap();
        let cls = p2.views[0].states[0].render[0].style.as_ref().unwrap().cls.clone().unwrap();
        assert!(cls.contains("f4-Late") && cls.contains("f4-Base"), "{}", cls);
        assert!(css.contains(".f4-Drop.f4-Drop.f4-drag-source{opacity:.5}"), "{}", css);
        assert!(css.contains("@media (prefers-reduced-motion: reduce){.f4-Drop.f4-Drop{animation:none}}"), "{}", css);
        assert!(css.contains("@keyframes fade-in-up{from{opacity:0}to{opacity:1}}"), "{}", css);
        assert!(css.contains(".f4-V.f4-V{background:hsl(var(--hue) 80% 50%);animation:pulse 1s ease-in-out infinite alternate;width:calc(100% - 20px)}"), "{}", css);
        assert!(css.contains(".f4-V.f4-V[data-state-name=\"Open\"]{outline:2px solid var(--accent)}"));
        assert!(css.contains("@media (max-width: 600px){.f4-V.f4-V{padding:4px}}"));
        assert!(css.contains(".f4-V.f4-V:hover{color:var(--f4-d1)}"));
        let host = p.views[0].style.as_ref().unwrap();
        assert_eq!(host.cls.as_deref(), Some("f4-V"));
        assert_eq!(host.dynamic[0].key, "--hue");
        assert_eq!(host.dynamic[0].expr, "`${hue}`");
        assert_eq!(host.dynamic[1].key, "--f4-d1");
        assert_eq!(host.dynamic[1].expr, "`${big ? \"red\" : \"blue\"}`");
        let text = p.views[0].states[0].render[0].style.as_ref().unwrap();
        assert_eq!(text.cls.as_deref(), Some("f4-V-1 f4-Card"));
        assert_eq!(text.dynamic[0].expr, "(big) ? \"24px\" : \"14px\"");
        assert!(css.contains(".f4-V-1.f4-V-1:focus-within{color:red}"));
        let btn = p.views[0].states[0].render[1].style.as_ref().unwrap();
        assert_eq!(btn.cls.as_deref(), Some("f4-V-2 f4-Card"));
    }

    #[test]
    fn list_named_args() {
        let p = compile(r#"view V { store xs: any = []; state S { render { List(xs.filter(|x| x > 1), empty: "None yet") { x => Text("{x}") } } } }"#).unwrap();
        let l = &p.views[0].states[0].render[0];
        assert_eq!(l.list_expr.as_deref(), Some("xs.filter((x) => x > 1)"));
        assert_eq!(l.named_args["empty"], "\"None yet\"");
    }

    #[test]
    fn errors_have_positions() {
        let e = compile("view X {\n  store a = ;\n").unwrap_err();
        assert_eq!(e.line, 2);
        let e = compile("theme { --x: {y}; }").unwrap_err();
        assert!(e.message.contains("not allowed"));
    }
}
