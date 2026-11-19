//! AST as consumed by web/foar-runtime.js (serialized to JSON, camelCase).
use serde::Serialize;
use serde_json::Map;
use serde_json::Value;

#[derive(Serialize, Debug, Clone)]
pub struct Program {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(rename = "dataDecls")]
    pub data_decls: Vec<DataDecl>,
    /// `enum Name { A, B = "b" }` or tagged union `enum Load<T> { Idle, Ready(T) }`.
    pub enums: Vec<EnumDecl>,
    /// `extern fn name(a: Type) -> RetType;`: typed host JS bindings checked by the compiler.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub externs: Vec<ExternDecl>,
    /// Top-level pure FOAR functions: `fn name(a: Type) -> RetType { ... }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub functions: Vec<FnDecl>,
    /// Shared reactive contexts: `context Auth { store ...; let ...; effect ... }`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub contexts: Vec<ContextDecl>,
    pub views: Vec<ViewDecl>,
    /// All generated CSS for the program (themes, named styles, keyframes,
    /// raw css blocks, and every view/element style block).
    pub css: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct FnDecl {
    pub name: String,
    pub params: Vec<Param>,
    #[serde(rename = "returnType")]
    pub return_type: String,
    #[serde(rename = "jsBody")]
    pub js_body: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ContextDecl {
    pub name: String,
    pub stores: Vec<Store>,
    pub derived: Vec<Derived>,
    pub effects: Vec<EffectDecl>,
}

#[derive(Serialize, Debug, Clone)]
pub struct KeyHandler {
    pub combo: String,
    pub body: EffectBody,
}

#[derive(Serialize, Debug, Clone)]
pub struct ExternDecl {
    pub name: String,
    pub params: Vec<Param>,
    #[serde(rename = "returnType")]
    pub return_type: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct DataDecl {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    #[serde(rename = "typeParams", default, skip_serializing_if = "Vec::is_empty")]
    pub type_params: Vec<String>,
    pub fields: Vec<Field>,
}

#[derive(Serialize, Debug, Clone)]
pub struct EnumDecl {
    pub name: String,
    #[serde(rename = "typeParams", default, skip_serializing_if = "Vec::is_empty")]
    pub type_params: Vec<String>,
    pub variants: Vec<EnumVariant>,
}

#[derive(Serialize, Debug, Clone)]
pub struct EnumVariant {
    pub name: String,
    /// JS literal of the variant's value (`"List"`, `"grid"`, `2`)
    pub value: String,
    /// Optional payload type for tagged-union variants: `Ready(Vec<Item>)`
    #[serde(rename = "payloadType", skip_serializing_if = "Option::is_none")]
    pub payload_type: Option<String>,
}

/// `let name = expr;` in a view: a derived value, recomputed on every update.
#[derive(Serialize, Debug, Clone)]
pub struct Derived {
    pub name: String,
    #[serde(rename = "derivedType")]
    pub derived_type: String,
    pub expr: String,
}

/// One arm of a render `Match`: `test` is a JS expression over `__m` (the
/// matched value) and the arm's `binding` (bound to `bindingExpr` or `__m`).
#[derive(Serialize, Debug, Clone)]
pub struct MatchArm {
    pub test: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
    #[serde(rename = "bindingExpr", skip_serializing_if = "Option::is_none")]
    pub binding_expr: Option<String>,
    pub children: Vec<UiElement>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Field {
    pub name: String,
    #[serde(rename = "fieldType")]
    pub field_type: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Param {
    pub name: String,
    #[serde(rename = "paramType")]
    pub param_type: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Store {
    pub name: String,
    #[serde(rename = "storeType")]
    pub store_type: String,
    #[serde(rename = "initExpr")]
    pub init_expr: String,
}

/// Compiled style: class names to add (static CSS lives in Program.css) and
/// dynamic bindings (`key` is a CSS property or custom property, `expr` a JS
/// expression over the view's props/stores/locals yielding the value).
#[derive(Serialize, Debug, Clone, Default)]
pub struct Style {
    pub cls: Option<String>,
    pub dynamic: Vec<DynBinding>,
}

#[derive(Serialize, Debug, Clone)]
pub struct DynBinding {
    pub key: String,
    pub expr: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ViewDecl {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    #[serde(rename = "typeParams", default, skip_serializing_if = "Vec::is_empty")]
    pub type_params: Vec<String>,
    pub params: Vec<Param>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub uses: Vec<String>,
    pub stores: Vec<Store>,
    pub derived: Vec<Derived>,
    pub style: Option<Style>,
    #[serde(rename = "onUnmount", skip_serializing_if = "Option::is_none")]
    pub on_unmount: Option<EffectBody>,
    pub states: Vec<StateDecl>,
}

#[derive(Serialize, Debug, Clone)]
pub struct StateDecl {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    pub render: Vec<UiElement>,
    pub effects: Vec<EffectDecl>,
    #[serde(rename = "onEnter", skip_serializing_if = "Option::is_none")]
    pub on_enter: Option<EffectBody>,
    #[serde(rename = "onExit")]
    pub on_exit: Option<EffectBody>,
    #[serde(rename = "onError", skip_serializing_if = "Option::is_none")]
    pub on_error: Option<EffectBody>,
    #[serde(rename = "onUnmount", skip_serializing_if = "Option::is_none")]
    pub on_unmount: Option<EffectBody>,
    #[serde(rename = "keyHandlers", default, skip_serializing_if = "Vec::is_empty")]
    pub key_handlers: Vec<KeyHandler>,
}

#[derive(Serialize, Debug, Clone)]
pub struct Transition {
    pub target: String,
    #[serde(rename = "async")]
    pub is_async: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct EffectBody {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<Param>,
    pub transitions: Vec<Transition>,
    pub emissions: Vec<String>,
    #[serde(rename = "jsBody")]
    pub js_body: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct EffectDecl {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub name: String,
    pub params: Vec<Param>,
    pub transitions: Vec<Transition>,
    pub emissions: Vec<String>,
    #[serde(rename = "jsBody")]
    pub js_body: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct UiElement {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub tag: String,
    pub args: Vec<String>,
    #[serde(rename = "namedArgs")]
    pub named_args: Map<String, Value>,
    #[serde(rename = "listBinding")]
    pub list_binding: Option<String>,
    #[serde(rename = "listExpr", skip_serializing_if = "Option::is_none")]
    pub list_expr: Option<String>,
    pub children: Vec<UiElement>,
    pub events: Map<String, Value>,
    pub style: Option<Style>,
    /// `Match(x) { pattern => … }`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arms: Option<Vec<MatchArm>>,
    /// `If(c) { … } Else { … }` or `Catch { … } Fallback { err => … }`
    #[serde(rename = "elseChildren", skip_serializing_if = "Option::is_none")]
    pub else_children: Option<Vec<UiElement>>,
    #[serde(rename = "fallbackBinding", skip_serializing_if = "Option::is_none")]
    pub fallback_binding: Option<String>,
}
