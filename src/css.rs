//! Style blocks -> CSS. Static declarations become class rules emitted once
//! into Program.css; dynamic values (`{expr}` interpolation or `cond ? a : b`)
//! become runtime bindings. A dynamic value inside a nested block
//! (@hover/@state/@media) is routed through a generated custom property so it
//! still works as a plain CSS rule.
use crate::ast::{DynBinding, Style};

#[derive(Debug, Clone)]
pub enum Value {
    Static(String),
    /// JS expression (over props/stores/locals) that yields the CSS value.
    Dynamic(String),
}

#[derive(Debug, Clone)]
pub enum NestedKind {
    /// `@hover`, `@focus-within`, `@nth-child(2n)` ... -> `:hover` etc.
    Pseudo(String),
    /// `@state Editing` -> matches while the view is in that state.
    State(String),
    /// `@media (query)` (also `@dark` / `@light` shorthands).
    Media(String),
}

#[derive(Debug, Clone, Default)]
pub struct StyleBlock {
    pub decls: Vec<(String, Value)>,
    pub nested: Vec<(NestedKind, StyleBlock)>,
    /// `@use Name;` -> also apply the named style's class.
    pub uses: Vec<String>,
}

#[derive(Default)]
pub struct Hoisted {
    pub rules: Vec<String>,
    dyn_counter: usize,
}

impl Hoisted {
    pub fn next_dyn(&mut self) -> String {
        self.dyn_counter += 1;
        format!("--f4-d{}", self.dyn_counter)
    }
    pub fn css(&self) -> String {
        self.rules.join("\n")
    }
}

pub struct Ctx<'a> {
    pub view: Option<&'a str>,
    pub is_host: bool,
    pub allow_dynamic: bool,
}

/// FOAR layout shorthands -> CSS declarations.
pub fn css_decls(key: &str, val: &str) -> Vec<String> {
    match key {
        "layout" => vec![
            "display:flex".to_string(),
            format!("flex-direction:{}", if val == "horizontal" { "row" } else { "column" }),
        ],
        "align" => vec![format!("align-items:{}", val)],
        _ => vec![format!("{}:{}", key, val)],
    }
}

pub fn compile_block(block: &StyleBlock, cls: &str, ctx: &Ctx, h: &mut Hoisted) -> Result<Style, String> {
    let mut dynamic = Vec::new();
    // Doubled class => specificity (0,2,0): wins over base `.f4-button:hover` rules.
    let sel = format!(".{0}.{0}", cls);
    emit(block, &sel, &mut Vec::new(), false, ctx, h, &mut dynamic)?;
    let mut classes = vec![cls.to_string()];
    for u in &block.uses {
        classes.push(format!("f4-{}", u));
    }
    Ok(Style { cls: Some(classes.join(" ")), dynamic })
}

/// `theme { }` -> `:root { }` (static only).
pub fn compile_root(block: &StyleBlock, h: &mut Hoisted) -> Result<(), String> {
    let ctx = Ctx { view: None, is_host: false, allow_dynamic: false };
    let mut d = Vec::new();
    emit(block, ":root", &mut Vec::new(), false, &ctx, h, &mut d)
}

fn emit(
    block: &StyleBlock,
    sel: &str,
    media: &mut Vec<String>,
    nested: bool,
    ctx: &Ctx,
    h: &mut Hoisted,
    dynamic: &mut Vec<DynBinding>,
) -> Result<(), String> {
    let mut lines = Vec::new();
    for (key, val) in &block.decls {
        match val {
            Value::Static(s) => lines.extend(css_decls(key, s)),
            Value::Dynamic(expr) => {
                if !ctx.allow_dynamic {
                    return Err(format!("dynamic value for `{}` is not allowed here (theme and named styles are static)", key));
                }
                if !nested {
                    dynamic.push(DynBinding { key: key.clone(), expr: expr.clone() });
                } else {
                    if key == "layout" {
                        return Err("dynamic `layout` inside @hover/@state/@media is not supported".to_string());
                    }
                    let var = h.next_dyn();
                    lines.extend(css_decls(key, &format!("var({})", var)));
                    dynamic.push(DynBinding { key: var, expr: expr.clone() });
                }
            }
        }
    }
    if !lines.is_empty() {
        let mut rule = format!("{}{{{}}}", sel, lines.join(";"));
        for q in media.iter().rev() {
            rule = format!("@media {}{{{}}}", q, rule);
        }
        h.rules.push(rule);
    }
    for (kind, sub) in &block.nested {
        match kind {
            NestedKind::Pseudo(p) => emit(sub, &format!("{}:{}", sel, p), media, true, ctx, h, dynamic)?,
            NestedKind::State(s) => {
                let s2 = if ctx.is_host {
                    format!("{}[data-state-name=\"{}\"]", sel, s)
                } else {
                    match ctx.view {
                        Some(v) => format!(".f4-view-{}[data-state-name=\"{}\"] {}", v, s, sel),
                        None => return Err("@state is only valid inside a view".to_string()),
                    }
                };
                emit(sub, &s2, media, true, ctx, h, dynamic)?
            }
            NestedKind::Media(q) => {
                media.push(q.clone());
                emit(sub, sel, media, true, ctx, h, dynamic)?;
                media.pop();
            }
        }
    }
    Ok(())
}
