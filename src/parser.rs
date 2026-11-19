//! Recursive-descent parser for .foar sources.
use crate::ast::*;
use crate::css::{self, Ctx, Hoisted, NestedKind, StyleBlock, Value};
use crate::lexer::{lex, Kind, Token};
use crate::transpile::rust_idioms_to_js;
use serde_json::{Map, Value as J};

#[path = "matching.rs"]
mod matching;

#[derive(Debug, Clone, serde::Serialize)]
pub struct CompileError {
    pub message: String,
    pub line: usize,
    pub col: usize,
    /// Project-relative path of the file the error is in (multi-file builds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    /// Byte offset into the compiled source (remapped to `file`/`line`/`col`).
    #[serde(skip)]
    pub offset: usize,
}

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.file {
            Some(file) => write!(f, "{}:{}:{}: {}", file, self.line, self.col, self.message),
            None => write!(f, "{}:{}: {}", self.line, self.col, self.message),
        }
    }
}

fn err_at(src: &str, at: usize, message: String) -> CompileError {
    let at = at.min(src.len());
    let line = src[..at].matches('\n').count() + 1;
    let col = at - src[..at].rfind('\n').map(|i| i + 1).unwrap_or(0) + 1;
    CompileError { message, line, col, file: None, offset: at }
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
    /// declared view / data names (duplicates are errors: views are global by name)
    declared: std::collections::HashSet<String>,
    /// every element tag used, with its position (checked against views + built-ins)
    tag_refs: Vec<(String, usize)>,
    /// all enums of the program (pre-scanned, so code can use them before their declaration)
    enums: matching::Enums,
    /// first error found while joining expressions (join_js can't return one)
    deferred: std::cell::RefCell<Option<CompileError>>,
    match_id: std::cell::Cell<usize>,
    /// declared types of the current view's params / stores / lets (+ effect params)
    var_types: std::collections::HashMap<String, String>,
    /// captured expressions/statements/view-calls to typecheck once all decls are parsed
    check_items: Vec<crate::typecheck::CheckItem>,
    /// the state whose render/effects are being parsed
    cur_state: Option<String>,
    /// `-> on_x(Handler)` in render blocks: (view, state, handler, offset)
    handler_refs: Vec<(String, String, String, usize)>,
    /// `-> on_x(Cart.Add)`: (view, "Cart", "Add", offset)
    ctx_handler_refs: Vec<(String, String, String, usize)>,
    /// `-> on_x(...)` on a sub-view element: (target view, event, offset)
    view_event_refs: Vec<(String, String, usize)>,
    /// events each view emits (`emit name(...)` in any of its effects)
    emits: std::cell::RefCell<std::collections::HashMap<String, std::collections::HashSet<String>>>,
    /// active lexical locals in the current render tree (List / Route bindings)
    render_locals: Vec<(String, Option<String>)>,
}

/// Elements the runtime provides (web/foar-runtime.js mountNode/mountElement).
const BUILTIN_ELEMENTS: &[&str] = &[
    "Text", "Button", "Input", "TextArea", "Checkbox", "RichText", "Image", "Spinner",
    "Row", "Column", "List", "If", "Match", "Router", "Route", "Link", "Slot", "Portal", "Catch",
    "Form", "Select", "Option", "Slider", "Progress", "Island",
];

impl<'s> Parser<'s> {
    pub fn new(src: &'s str) -> PResult<Self> {
        let toks = lex(src).map_err(|at| err_at(src, at, "Unexpected character".to_string()))?;
        let enums = matching::prescan_enums(src, &toks);
        Ok(Self {
            src,
            toks,
            pos: 0,
            hoisted: Hoisted::default(),
            cur_view: None,
            cls_counter: 0,
            style_uses: Default::default(),
            declared: Default::default(),
            tag_refs: Vec::new(),
            enums,
            deferred: Default::default(),
            match_id: Default::default(),
            var_types: Default::default(),
            check_items: Vec::new(),
            cur_state: None,
            handler_refs: Vec::new(),
            ctx_handler_refs: Vec::new(),
            view_event_refs: Vec::new(),
            emits: Default::default(),
            render_locals: Vec::new(),
        })
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
    /// (`Enum.Variant` and `match` are lowered first, see matching.rs.)
    fn join_js(&self, toks: &[Token]) -> String {
        if toks.is_empty() {
            return "undefined".to_string();
        }
        rust_idioms_to_js(&self.raw_join(toks, false))
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
        // CSS is emitted by kind, not in file order, so splitting a program into
        // files never changes the cascade: theme, named styles, keyframes,
        // `css { }` blocks, then view/element styles (which use doubled classes).
        let mut chunks: Vec<(u8, std::ops::Range<usize>)> = Vec::new();
        let mut enums = Vec::new();
        let mut externs = Vec::new();
        let mut functions = Vec::new();
        let mut contexts = Vec::new();
        while !self.at_end() {
            let first = self.hoisted.rules.len();
            let kind = match self.text(self.peek()) {
                "theme" => 0,
                "style" => 1,
                "@keyframes" => 2,
                "css" => 3,
                _ => 4,
            };
            self.parse_top_level(&mut data_decls, &mut views, &mut enums, &mut externs, &mut functions, &mut contexts)?;
            if let Some(e) = self.deferred.borrow_mut().take() {
                return Err(e);
            }
            chunks.push((kind, first..self.hoisted.rules.len()));
        }
        let mut css_rules = Vec::with_capacity(self.hoisted.rules.len());
        for k in 0..=4 {
            for (_, r) in chunks.iter().filter(|(c, _)| *c == k) {
                css_rules.extend_from_slice(&self.hoisted.rules[r.clone()]);
            }
        }
        self.hoisted.rules = css_rules;
        // A tag that is neither a built-in element nor a declared view: usually a
        // missing import or a renamed view.
        let view_names: std::collections::HashSet<&str> = views.iter().map(|v| v.name.as_str()).collect();
        if let Some((tag, at)) = self.tag_refs.iter().find(|(t, _)| !view_names.contains(t.as_str()) && !BUILTIN_ELEMENTS.contains(&t.as_str())) {
            let hint = if tag.starts_with(|c: char| c.is_ascii_uppercase()) { " (is the file that declares it imported?)" } else { "" };
            return Err(err_at(self.src, *at, format!("Unknown view or element '{}'{}", tag, hint)));
        }
        // Static type check across the whole program (stores, lets, data literals,
        // field accesses, view props, effects, transitions, contexts, fns, and extern fns).
        self.check_view_events(&views)?;
        self.check_context_handlers(&views, &contexts)?;
        crate::typecheck::check_program(self.src, &data_decls, &enums, &externs, &functions, &contexts, &views, &self.check_items)?;
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
        if let Some(e) = self.deferred.borrow_mut().take() {
            return Err(e);
        }
        Ok(Program { kind: "Program", data_decls, enums, externs, functions, contexts, views, css: self.hoisted.css() })
    }

    fn parse_top_level(
        &mut self,
        data_decls: &mut Vec<DataDecl>,
        views: &mut Vec<ViewDecl>,
        enums: &mut Vec<EnumDecl>,
        externs: &mut Vec<ExternDecl>,
        functions: &mut Vec<FnDecl>,
        contexts: &mut Vec<ContextDecl>,
    ) -> PResult<()> {
        {
            if self.is("import") && self.peek_at(1).kind == Kind::Str {
                // `import "./components/Row.foar"`: resolved by crate::project
                // before parsing; the imported files are part of this source.
                self.advance();
                self.advance();
                self.eat(";");
            } else if self.is("extern") {
                externs.push(self.parse_extern()?);
            } else if self.is("fn") {
                functions.push(self.parse_fn()?);
            } else if self.is("context") {
                contexts.push(self.parse_context()?);
            } else if self.is("data") {
                data_decls.push(self.parse_data()?);
            } else if self.is("enum") {
                enums.push(self.parse_enum()?);
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
        Ok(())
    }

    fn parse_fn(&mut self) -> PResult<FnDecl> {
        self.expect("fn")?;
        let name = self.declare("Function")?;
        self.expect("(")?;
        let mut params = Vec::new();
        while !self.at_end() && !self.is(")") {
            let pname = self.expect_ident()?;
            self.expect(":")?;
            let param_type = self.parse_type()?;
            self.eat(",");
            params.push(Param { name: pname, param_type, default: None });
        }
        self.expect(")")?;
        let return_type = if self.eat("->") { self.parse_type()? } else { "any".to_string() };
        let body = self.parse_balanced_braces()?;
        self.check_items.push(crate::typecheck::CheckItem::FnBody {
            name: name.clone(),
            params: params.clone(),
            return_type: return_type.clone(),
            tokens: body.clone(),
        });
        let saved = self.var_types.clone();
        self.var_types.clear();
        for p in &params {
            self.var_types.insert(p.name.clone(), p.param_type.clone());
        }
        let js_body = if body.is_empty() { String::new() } else { rust_idioms_to_js(&self.raw_join(&body, true)) };
        self.var_types = saved;
        Ok(FnDecl { name, params, return_type, js_body })
    }

    fn parse_context(&mut self) -> PResult<ContextDecl> {
        self.expect("context")?;
        let name = self.declare("Context")?;
        self.cur_view = Some(format!("@ctx:{}", name));
        self.var_types.clear();
        self.expect("{")?;
        let mut stores = Vec::new();
        let mut derived = Vec::new();
        let mut effects = Vec::new();
        while !self.at_end() && !self.is("}") {
            if self.is("store") {
                self.advance();
                let sat = self.peek().start;
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
                self.var_types.insert(sname.clone(), store_type.clone());
                self.check_items.push(crate::typecheck::CheckItem::StoreInit {
                    view: format!("@ctx:{}", name),
                    name: sname.clone(),
                    declared: store_type.clone(),
                    tokens: init.clone(),
                    at: init.first().map(|t| t.start).unwrap_or(sat),
                });
                stores.push(Store { name: sname, store_type, init_expr: self.join_js(&init) });
            } else if self.is("let") {
                self.advance();
                let dat = self.peek().start;
                let dname = self.expect_ident()?;
                let derived_type = if self.eat(":") { self.parse_type()? } else { "any".to_string() };
                self.expect("=")?;
                let mut expr = Vec::new();
                while !self.at_end() && !self.is(";") {
                    expr.push(self.advance());
                }
                if expr.is_empty() {
                    return self.err(format!("Expected a value for let {}", dname));
                }
                self.expect(";")?;
                self.var_types.insert(dname.clone(), derived_type.clone());
                self.check_items.push(crate::typecheck::CheckItem::DerivedInit {
                    view: format!("@ctx:{}", name),
                    name: dname.clone(),
                    declared: derived_type.clone(),
                    tokens: expr.clone(),
                    at: expr.first().map(|t| t.start).unwrap_or(dat),
                });
                derived.push(Derived { name: dname, derived_type, expr: self.join_js(&expr) });
            } else if self.is("effect") {
                effects.push(self.parse_effect()?);
            } else {
                return self.err(format!("Unexpected token '{}' inside context {}", self.describe(), name));
            }
        }
        self.expect("}")?;
        self.cur_view = None;
        Ok(ContextDecl { name, stores, derived, effects })
    }

    fn parse_extern(&mut self) -> PResult<ExternDecl> {
        self.expect("extern")?;
        self.expect("fn")?;
        let name = self.declare("Extern function")?;
        self.expect("(")?;
        let mut params = Vec::new();
        while !self.at_end() && !self.is(")") {
            let pname = self.expect_ident()?;
            self.expect(":")?;
            let param_type = self.parse_type()?;
            self.eat(",");
            params.push(Param { name: pname, param_type, default: None });
        }
        self.expect(")")?;
        let return_type = if self.eat("->") { self.parse_type()? } else { "Void".to_string() };
        self.eat(";");
        Ok(ExternDecl { name, params, return_type })
    }

    fn parse_type_params(&mut self) -> PResult<Vec<String>> {
        let mut params = Vec::new();
        if self.eat("<") {
            while !self.at_end() && !self.is(">") {
                params.push(self.expect_ident()?);
                self.eat(",");
            }
            self.expect(">")?;
        }
        Ok(params)
    }

    fn parse_type(&mut self) -> PResult<String> {
        let base = self.expect_ident()?;
        if self.eat("<") {
            let mut inner = vec![self.parse_type()?];
            while self.eat(",") {
                inner.push(self.parse_type()?);
            }
            self.expect(">")?;
            return Ok(format!("{}<{}>", base, inner.join(", ")));
        }
        Ok(base)
    }

    /// A top-level name (view or data type); each may be declared once per program.
    fn declare(&mut self, what: &str) -> PResult<String> {
        let at = self.peek().start;
        let name = self.expect_ident()?;
        if !self.declared.insert(format!("{}:{}", what, name)) {
            return Err(err_at(self.src, at, format!("{} '{}' is already declared (views and data types are shared by every file of a program)", what, name)));
        }
        Ok(name)
    }

    fn parse_data(&mut self) -> PResult<DataDecl> {
        self.expect("data")?;
        let name = self.declare("Data type")?;
        let type_params = self.parse_type_params()?;
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
        Ok(DataDecl { kind: "DataDecl", name, type_params, fields })
    }

    // ---- views ------------------------------------------------------------
    fn parse_view(&mut self) -> PResult<ViewDecl> {
        self.expect("view")?;
        let name_at = self.peek().start;
        let name = self.declare("View")?;
        if BUILTIN_ELEMENTS.contains(&name.as_str()) || name == "Else" || name == "Fallback" {
            return Err(err_at(self.src, name_at, format!("'{}' is a built-in element: give the view another name", name)));
        }
        let type_params = self.parse_type_params()?;
        self.cur_view = Some(name.clone());
        self.cls_counter = 0;
        self.var_types.clear();
        let mut params = Vec::new();
        if self.eat("(") {
            while !self.at_end() && !self.is(")") {
                let pname = self.expect_ident()?;
                self.expect(":")?;
                let param_type = self.parse_type()?;
                // `check: bool = false`: the prop becomes optional
                let mut default = None;
                if self.eat("=") {
                    let at = self.peek().start;
                    let toks = self.collect_arg_tokens();
                    if toks.is_empty() {
                        return self.err(format!("Expected a default value for prop {}", pname));
                    }
                    default = Some(self.join_js(&toks));
                    self.check_items.push(crate::typecheck::CheckItem::ParamDefault { view: name.clone(), name: pname.clone(), declared: param_type.clone(), tokens: toks, at });
                }
                self.eat(",");
                self.var_types.insert(pname.clone(), param_type.clone());
                params.push(Param { name: pname, param_type, default });
            }
            self.expect(")")?;
        }
        self.expect("{")?;
        let mut uses = Vec::new();
        let mut derived = Vec::new();
        let mut stores = Vec::new();
        let mut style = None;
        let mut on_unmount = None;
        let mut states = Vec::new();
        while !self.at_end() && !self.is("}") {
            if self.is("use") {
                self.advance();
                let ctx_name = self.expect_ident()?;
                uses.push(ctx_name);
                while self.eat(",") {
                    uses.push(self.expect_ident()?);
                }
                self.eat(";");
            } else if self.is("store") {
                self.advance();
                let sat = self.peek().start;
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
                self.var_types.insert(sname.clone(), store_type.clone());
                self.check_items.push(crate::typecheck::CheckItem::StoreInit {
                    view: name.clone(),
                    name: sname.clone(),
                    declared: store_type.clone(),
                    tokens: init.clone(),
                    at: init.first().map(|t| t.start).unwrap_or(sat),
                });
                stores.push(Store { name: sname, store_type, init_expr: self.join_js(&init) });
            } else if self.is("let") {
                // `let total = items.len();` — a derived value, recomputed on every update
                self.advance();
                let dat = self.peek().start;
                let dname = self.expect_ident()?;
                let derived_type = if self.eat(":") { self.parse_type()? } else { "any".to_string() };
                self.expect("=")?;
                let mut expr = Vec::new();
                while !self.at_end() && !self.is(";") {
                    expr.push(self.advance());
                }
                if expr.is_empty() {
                    return self.err(format!("Expected a value for let {}", dname));
                }
                self.expect(";")?;
                self.var_types.insert(dname.clone(), derived_type.clone());
                self.check_items.push(crate::typecheck::CheckItem::DerivedInit {
                    view: name.clone(),
                    name: dname.clone(),
                    declared: derived_type.clone(),
                    tokens: expr.clone(),
                    at: expr.first().map(|t| t.start).unwrap_or(dat),
                });
                derived.push(Derived { name: dname, derived_type, expr: self.join_js(&expr) });
            } else if self.is("style") {
                self.advance();
                self.expect("{")?;
                let block = self.parse_style_block()?;
                self.expect("}")?;
                let ctx = Ctx { view: Some(&name), is_host: true, allow_dynamic: true };
                style = Some(self.compile_style(&block, &format!("f4-{}", name), &ctx)?);
            } else if self.is("on_unmount") {
                self.advance();
                let body = self.parse_balanced_braces()?;
                self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                    view: name.clone(),
                    params: Vec::new(),
                    tokens: body.clone(),
                });
                on_unmount = Some(self.effect_body(&body));
            } else if self.is("state") {
                states.push(self.parse_state()?);
            } else {
                return self.err(format!("Unexpected token '{}' inside view {}", self.describe(), name));
            }
        }
        self.expect("}")?;
        self.check_handlers(&name, &states)?;
        self.cur_view = None;
        Ok(ViewDecl { kind: "ViewDecl", name, type_params, params, uses, stores, derived, style, on_unmount, states })
    }

    fn compile_style(&mut self, block: &StyleBlock, cls: &str, ctx: &Ctx) -> PResult<Style> {
        css::compile_block(block, cls, ctx, &mut self.hoisted).map_err(|m| err_at(self.src, self.peek().start, m))
    }

    fn parse_opt_hook_params(&mut self, default_type: &str) -> PResult<Vec<Param>> {
        let mut params = Vec::new();
        if self.eat("(") {
            while !self.at_end() && !self.is(")") {
                let pname = self.expect_ident()?;
                let param_type = if self.eat(":") { self.parse_type()? } else { default_type.to_string() };
                self.eat(",");
                params.push(Param { name: pname, param_type, default: None });
            }
            self.expect(")")?;
        }
        Ok(params)
    }

    fn parse_state(&mut self) -> PResult<StateDecl> {
        self.expect("state")?;
        let name = self.expect_ident()?;
        self.cur_state = Some(name.clone());
        self.expect("{")?;
        let mut render = Vec::new();
        let mut effects = Vec::new();
        let mut on_enter = None;
        let mut on_exit = None;
        let mut on_error = None;
        let mut on_unmount = None;
        let mut key_handlers = Vec::new();
        while !self.at_end() && !self.is("}") {
            if self.is("render") {
                self.advance();
                self.expect("{")?;
                render = self.parse_render_block()?;
                self.expect("}")?;
            } else if self.is("effect") {
                effects.push(self.parse_effect()?);
            } else if self.is("on_enter") {
                self.advance();
                let body = self.parse_balanced_braces()?;
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                        view: view.clone(),
                        params: Vec::new(),
                        tokens: body.clone(),
                    });
                }
                on_enter = Some(self.effect_body(&body));
            } else if self.is("on_exit") {
                self.advance();
                let params = self.parse_opt_hook_params("any")?;
                let body = self.parse_balanced_braces()?;
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                        view: view.clone(),
                        params: params.clone(),
                        tokens: body.clone(),
                    });
                }
                let saved = self.var_types.clone();
                for p in &params {
                    self.var_types.insert(p.name.clone(), p.param_type.clone());
                }
                let mut eb = self.effect_body(&body);
                eb.params = params;
                self.var_types = saved;
                on_exit = Some(eb);
            } else if self.is("on_error") {
                self.advance();
                let params = self.parse_opt_hook_params("String")?;
                let body = self.parse_balanced_braces()?;
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                        view: view.clone(),
                        params: params.clone(),
                        tokens: body.clone(),
                    });
                }
                let saved = self.var_types.clone();
                for p in &params {
                    self.var_types.insert(p.name.clone(), p.param_type.clone());
                }
                let mut eb = self.effect_body(&body);
                eb.params = params;
                self.var_types = saved;
                on_error = Some(eb);
            } else if self.is("on_unmount") {
                self.advance();
                let body = self.parse_balanced_braces()?;
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                        view: view.clone(),
                        params: Vec::new(),
                        tokens: body.clone(),
                    });
                }
                on_unmount = Some(self.effect_body(&body));
            } else if self.is("on_key") {
                self.advance();
                self.expect("(")?;
                if self.peek().kind != Kind::Str {
                    return self.err("on_key expects a key shortcut string, e.g. `on_key(\"Escape\") { … }`");
                }
                let tok = self.advance();
                let combo = crate::lexer::unescape(self.text(&tok));
                self.expect(")")?;
                let body = self.parse_balanced_braces()?;
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                        view: view.clone(),
                        params: Vec::new(),
                        tokens: body.clone(),
                    });
                }
                key_handlers.push(KeyHandler { combo, body: self.effect_body(&body) });
            } else {
                return self.err(format!("Unexpected token '{}' in state {}", self.describe(), name));
            }
        }
        self.expect("}")?;
        self.cur_state = None;
        Ok(StateDecl { kind: "StateDecl", name, render, effects, on_enter, on_exit, on_error, on_unmount, key_handlers })
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
        let at = self.peek().start;
        let tag = self.expect_ident()?;
        self.tag_refs.push((tag.clone(), at));
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
            arms: None,
            else_children: None,
            fallback_binding: None,
        };
        if tag == "Else" {
            return Err(err_at(self.src, at, "Else must follow an If block: `If(cond) { … } Else { … }`".to_string()));
        }
        if tag == "Fallback" {
            return Err(err_at(self.src, at, "Fallback must follow a Catch block: `Catch { … } Fallback { err => … }`".to_string()));
        }
        let mut raw_pos_args: Vec<(Vec<Token>, usize)> = Vec::new();
        let mut raw_named_args: Vec<(String, Vec<Token>, usize)> = Vec::new();
        let mut list_src_hint: Option<String> = None;
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
                let items_toks = segs.next().unwrap_or_default();
                let items_js = self.join_js(&items_toks);
                list_src_hint = Some(items_js.clone());
                if let Some(view) = &self.cur_view {
                    self.check_items.push(crate::typecheck::CheckItem::RenderExpr {
                        view: view.clone(),
                        locals: self.render_locals.clone(),
                        tokens: items_toks,
                    });
                }
                el.list_expr = Some(items_js);
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
                        let arg_at = self.peek().start;
                        let toks = self.collect_arg_tokens();
                        el.named_args.insert(name.clone(), J::String(self.join_js(&toks)));
                        raw_named_args.push((name, toks, arg_at));
                    } else {
                        let arg_at = self.peek().start;
                        let toks = self.collect_arg_tokens();
                        el.args.push(self.join_js(&toks));
                        raw_pos_args.push((toks, arg_at));
                    }
                    self.eat(",");
                }
                self.expect(")")?;
            }
        }
        if let Some(view) = &self.cur_view {
            if !BUILTIN_ELEMENTS.contains(&tag.as_str()) {
                self.check_items.push(crate::typecheck::CheckItem::ViewCall {
                    view: view.clone(),
                    locals: self.render_locals.clone(),
                    target: tag.clone(),
                    pos_args: raw_pos_args,
                    named_args: raw_named_args,
                    at,
                });
            } else {
                for (toks, _) in raw_pos_args {
                    self.check_items.push(crate::typecheck::CheckItem::RenderExpr {
                        view: view.clone(),
                        locals: self.render_locals.clone(),
                        tokens: toks,
                    });
                }
                for (_, toks, _) in raw_named_args {
                    self.check_items.push(crate::typecheck::CheckItem::RenderExpr {
                        view: view.clone(),
                        locals: self.render_locals.clone(),
                        tokens: toks,
                    });
                }
            }
        }
        if tag == "Route" && el.args.is_empty() && !el.named_args.contains_key("path") {
            return Err(err_at(self.src, at, "Route requires a path pattern: `Route(\"/orders/:id\") { … }`".to_string()));
        }
        if tag == "Match" {
            if el.args.len() != 1 {
                return Err(err_at(self.src, at, "Match takes one value: `Match(layout) { … }`".to_string()));
            }
            self.expect("{")?;
            let scrut = el.args[0].clone();
            el.arms = Some(self.parse_render_arms(&scrut, at)?);
            self.expect("}")?;
        } else if self.eat("{") {
            let mut pushed_local = false;
            if (tag == "List" || tag == "Route") && self.peek().kind == Kind::Ident && self.is_at(1, "=>") {
                let bname = self.expect_ident()?;
                el.list_binding = Some(bname.clone());
                self.expect("=>")?;
                let hint = if tag == "Route" { Some("RouteParams".to_string()) } else { list_src_hint };
                self.render_locals.push((bname, hint));
                pushed_local = true;
            }
            el.children = self.parse_render_block()?;
            if pushed_local {
                self.render_locals.pop();
            }
            self.expect("}")?;
        }
        if tag == "If" && self.is("Else") {
            self.advance();
            if self.is("If") {
                el.else_children = Some(vec![self.parse_element()?]);
            } else {
                self.expect("{")?;
                el.else_children = Some(self.parse_render_block()?);
                self.expect("}")?;
            }
        }
        if tag == "Catch" && self.is("Fallback") {
            self.advance();
            self.expect("{")?;
            let mut pushed_err = false;
            if self.peek().kind == Kind::Ident && self.is_at(1, "=>") {
                let bname = self.expect_ident()?;
                el.fallback_binding = Some(bname.clone());
                self.expect("=>")?;
                self.render_locals.push((bname, Some("CatchError".to_string())));
                pushed_err = true;
            }
            el.else_children = Some(self.parse_render_block()?);
            if pushed_err {
                self.render_locals.pop();
            }
            self.expect("}")?;
        }
        loop {
            if self.eat("->") {
                let ev_at = self.peek().start;
                let ev = self.expect_ident()?;
                self.expect("(")?;
                let handler_at = self.peek().start;
                let mut handler = self.expect_ident()?;
                if let (Some(v), Some(st)) = (&self.cur_view, &self.cur_state) {
                    if !self.is(".") {
                        self.handler_refs.push((v.clone(), st.clone(), handler.clone(), handler_at));
                    }
                }
                if !BUILTIN_ELEMENTS.contains(&tag.as_str()) {
                    self.view_event_refs.push((tag.clone(), ev.clone(), ev_at));
                }
                if self.eat(".") {
                    let effect = self.expect_ident()?;
                    if let Some(v) = &self.cur_view {
                        self.ctx_handler_refs.push((v.clone(), handler.clone(), effect.clone(), handler_at));
                    }
                    handler.push('.');
                    handler.push_str(&effect);
                }
                self.expect(")")?;
                el.events.insert(ev, J::String(handler));
            } else if self.is(".") && self.is_at(1, "style") {
                if matches!(tag.as_str(), "If" | "Match" | "Router" | "Route" | "Slot" | "Portal" | "Catch" | "Island") {
                    return self.err(format!("{} has no box of its own to style: style the elements inside it, or wrap it in a Row/Column", tag));
                }
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
            params.push(Param { name: pname, param_type, default: None });
        }
        self.expect(")")?;
        let body = self.parse_balanced_braces()?;
        if let Some(view) = &self.cur_view {
            self.check_items.push(crate::typecheck::CheckItem::EffectBody {
                view: view.clone(),
                params: params.clone(),
                tokens: body.clone(),
            });
        }
        let saved = self.var_types.clone();
        for p in &params {
            self.var_types.insert(p.name.clone(), p.param_type.clone());
        }
        let b = self.effect_body(&body);
        self.var_types = saved;
        Ok(EffectDecl { kind: "EffectDecl", name, params, transitions: b.transitions, emissions: b.emissions, js_body: b.js_body })
    }

    /// `-> on_click(Save)` must name an effect of the state it appears in: the
    /// runtime looks effects up in the current state, so anything else would
    /// silently do nothing.
    fn check_handlers(&mut self, view: &str, states: &[StateDecl]) -> PResult<()> {
        let refs: Vec<_> = self.handler_refs.iter().filter(|r| r.0 == view).cloned().collect();
        self.handler_refs.retain(|r| r.0 != view);
        for (_, state, handler, at) in refs {
            let here = states.iter().find(|s| s.name == state).is_some_and(|s| s.effects.iter().any(|e| e.name == handler));
            if here {
                continue;
            }
            if let Some(other) = states.iter().find(|s| s.effects.iter().any(|e| e.name == handler)) {
                return Err(err_at(
                    self.src,
                    at,
                    format!("'{}' is an effect of state {}, not {}: in {} this event would do nothing. Declare it in {} too, or move the element.", handler, other.name, state, state, state),
                ));
            }
            let all: Vec<&str> = states.iter().flat_map(|s| s.effects.iter().map(|e| e.name.as_str())).collect();
            let hint = crate::typecheck::did_you_mean(&handler, all.iter().copied());
            return Err(err_at(self.src, at, format!("State {} of {} has no effect '{}'{}", state, view, handler, hint)));
        }
        Ok(())
    }

    /// `-> on_click(Cart.Add)`: the context exists, the view `use`s it, and it has that effect.
    fn check_context_handlers(&self, views: &[ViewDecl], contexts: &[ContextDecl]) -> PResult<()> {
        for (view, ctx, effect, at) in &self.ctx_handler_refs {
            let Some(c) = contexts.iter().find(|c| &c.name == ctx) else {
                let hint = crate::typecheck::did_you_mean(ctx, contexts.iter().map(|c| c.name.as_str()));
                return Err(err_at(self.src, *at, format!("There is no context '{}'{}", ctx, hint)));
            };
            if let Some(v) = views.iter().find(|v| &v.name == view) {
                if !v.uses.iter().any(|u| u == ctx) {
                    return Err(err_at(self.src, *at, format!("{} uses context {} without declaring it: add `use {};` to the view", view, ctx, ctx)));
                }
            }
            if !c.effects.iter().any(|e| &e.name == effect) {
                let hint = crate::typecheck::did_you_mean(effect, c.effects.iter().map(|e| e.name.as_str()));
                return Err(err_at(self.src, *at, format!("Context {} has no effect '{}'{}", ctx, effect, hint)));
            }
        }
        Ok(())
    }

    /// `-> on_pick(...)` on a component must be an event it emits (or a DOM event).
    fn check_view_events(&self, views: &[ViewDecl]) -> PResult<()> {
        const DOM_EVENTS: &[&str] = &["on_click", "on_double_click", "on_input", "on_change", "on_enter", "on_context_menu", "on_blur", "on_drop", "on_drag_start", "on_drag_end", "on_submit"];
        let emits = self.emits.borrow();
        for (target, ev, at) in &self.view_event_refs {
            if !views.iter().any(|v| &v.name == target) || DOM_EVENTS.contains(&ev.as_str()) {
                continue;
            }
            let name = ev.strip_prefix("on_").unwrap_or(ev);
            let set = emits.get(target);
            if set.is_some_and(|s| s.contains(name)) {
                continue;
            }
            let mut list: Vec<String> = set.map(|s| s.iter().map(|e| format!("on_{}", e)).collect()).unwrap_or_default();
            list.sort();
            let msg = if list.is_empty() {
                format!("{} never emits '{}' (it doesn't emit any events)", target, name)
            } else {
                format!("{} never emits '{}'{}. It emits: {}", target, name, crate::typecheck::did_you_mean(ev, list.iter().map(|s| s.as_str())), list.join(", "))
            };
            return Err(err_at(self.src, *at, msg));
        }
        Ok(())
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
        if let Some(view) = &self.cur_view {
            self.emits.borrow_mut().entry(view.clone()).or_default().extend(emissions.iter().cloned());
        }
        let js_body = if toks.is_empty() { "undefined".to_string() } else { rust_idioms_to_js(&self.raw_join(toks, true)) };
        EffectBody { params: Vec::new(), transitions, emissions, js_body }
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
    if let Some(ec) = &mut el.else_children {
        for c in ec {
            expand_element(c, uses);
        }
    }
    if let Some(arms) = &mut el.arms {
        for a in arms {
            for c in &mut a.children {
                expand_element(c, uses);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::compile;

    #[test]
    fn examples_parse() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/todo");
        let files = crate::project::load("app.foar", &mut |p| std::fs::read_to_string(root.join(p)).ok()).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["app.foar", "models.foar", "styles/theme.foar", "components/TodoItem.foar"]);
        let p = crate::project::compile_files(&files).unwrap();
        assert_eq!(p.views.len(), 2);
        assert_eq!(p.views[0].stores[0].init_expr.starts_with("[ {"), true, "{}", p.views[0].stores[0].init_expr);
        assert!(p.css.contains(".f4-TodoItem.f4-TodoItem:hover{background:var(--row-hover)}"));
        let item_text = &p.views[1].states[0].render[1];
        assert_eq!(item_text.tag, "Text");
        let st = item_text.style.as_ref().unwrap();
        assert_eq!(st.dynamic[0].key, "text-decoration");
        assert_eq!(st.dynamic[0].expr, "(item.completed) ? \"line-through\" : \"none\"");
        let c = compile(include_str!("../examples/counter/app.foar")).unwrap();
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
