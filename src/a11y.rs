//! Accessibility checks the compiler can make from the source alone: clear
//! WCAG 2.2 / WAI-ARIA 1.2 failures become compile errors that say how to fix
//! them. Only literal values are checked; dynamic ones are the author's call.

/// WAI-ARIA 1.2 roles (plus the Graphics module). Abstract roles are in ABSTRACT_ROLES.
const ROLES: &[&str] = &[
    "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell", "checkbox",
    "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion", "dialog", "directory",
    "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell", "group", "heading", "img",
    "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee", "math", "menu", "menubar", "menuitem",
    "menuitemcheckbox", "menuitemradio", "meter", "navigation", "none", "note", "option", "paragraph", "presentation",
    "progressbar", "radio", "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox",
    "separator", "slider", "spinbutton", "status", "strong", "subscript", "superscript", "switch", "tab", "table",
    "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
    "graphics-document", "graphics-object", "graphics-symbol",
];

const ABSTRACT_ROLES: &[&str] = &[
    "command", "composite", "input", "landmark", "range", "roletype", "section", "sectionhead", "select", "structure",
    "widget", "window",
];

/// WAI-ARIA 1.2 states and properties, without the `aria-` prefix.
const ARIA_ATTRS: &[&str] = &[
    "activedescendant", "atomic", "autocomplete", "braillelabel", "brailleroledescription", "busy", "checked",
    "colcount", "colindex", "colindextext", "colspan", "controls", "current", "describedby", "description", "details",
    "disabled", "dropeffect", "errormessage", "expanded", "flowto", "grabbed", "haspopup", "hidden", "invalid",
    "keyshortcuts", "label", "labelledby", "level", "live", "modal", "multiline", "multiselectable", "orientation",
    "owns", "placeholder", "posinset", "pressed", "readonly", "relevant", "required", "roledescription", "rowcount",
    "rowindex", "rowindextext", "rowspan", "selected", "setsize", "sort", "valuemax", "valuemin", "valuenow",
    "valuetext",
];

/// Allowed literal values of enumerated ARIA attributes.
fn enum_values(attr: &str) -> Option<&'static [&'static str]> {
    Some(match attr {
        "live" => &["off", "polite", "assertive"],
        "current" => &["page", "step", "location", "date", "time", "true", "false"],
        "haspopup" => &["false", "true", "menu", "listbox", "tree", "grid", "dialog"],
        "orientation" => &["horizontal", "vertical", "undefined"],
        "sort" => &["none", "ascending", "descending", "other"],
        "autocomplete" => &["none", "inline", "list", "both"],
        "invalid" => &["false", "true", "grammar", "spelling"],
        "relevant" => &["additions", "removals", "text", "all", "additions text"],
        "checked" | "pressed" => &["true", "false", "mixed", "undefined"],
        _ => return None,
    })
}

/// What a check needs to know about one element.
pub struct Element<'a> {
    pub tag: &'a str,
    /// first positional argument, if it is a plain string literal (no `{interpolation}`)
    pub text: Option<String>,
    /// named arguments: name → plain string literal value (None when dynamic)
    pub named: Vec<(String, Option<String>)>,
    /// `aria: { key: value }` when written as an object literal: key → literal value
    pub aria: Option<Vec<(String, usize, Option<String>)>>,
    /// `aria:` given, but not as an object literal (dynamic)
    pub aria_dynamic: bool,
    /// `tab_index:` when it's a number literal
    pub tab_index: Option<i64>,
}

impl Element<'_> {
    fn has(&self, name: &str) -> bool {
        self.named.iter().any(|(n, _)| n == name)
    }
    fn lit(&self, name: &str) -> Option<&str> {
        self.named.iter().find(|(n, _)| n == name).and_then(|(_, v)| v.as_deref())
    }
    fn aria_has(&self, key: &str) -> bool {
        self.aria.as_ref().is_some_and(|a| a.iter().any(|(k, _, _)| k == key))
    }
    /// Has an accessible name (or doesn't need one: hidden or presentational).
    fn named_ok(&self) -> bool {
        self.has("label")
            || self.aria_dynamic
            || self.aria_has("labelledby")
            || self.aria_has("label")
            || self.hidden()
    }
    fn hidden(&self) -> bool {
        matches!(self.lit("role"), Some("presentation" | "none"))
            || self.aria.as_ref().is_some_and(|a| a.iter().any(|(k, _, v)| k == "hidden" && v.as_deref() != Some("false")))
    }
}

/// A problem: (byte offset key — "role" / "aria:<key>" / "tab_index" / "" for the element, message)
pub type Problem = (String, String);

pub fn check(el: &Element) -> Vec<Problem> {
    let mut out = Vec::new();

    // role: a real, non-abstract WAI-ARIA role
    if let Some(role) = el.lit("role") {
        for r in role.split_whitespace() {
            if ABSTRACT_ROLES.contains(&r) {
                out.push(("role".into(), format!("'{}' is an abstract ARIA role and can't be used on an element: pick a concrete one (WAI-ARIA 1.2)", r)));
            } else if !ROLES.contains(&r) && !r.starts_with("doc-") {
                out.push(("role".into(), format!("'{}' isn't an ARIA role{} (WAI-ARIA 1.2)", r, crate::typecheck::did_you_mean(r, ROLES.iter().copied()))));
            }
        }
    }

    // aria: { key: value }: real states and properties, valid tokens
    if let Some(aria) = &el.aria {
        for (key, _, value) in aria {
            let attr = key.trim_start_matches("aria_").replace('_', "");
            if !ARIA_ATTRS.contains(&attr.as_str()) {
                out.push((format!("aria:{}", key), format!("'aria-{}' isn't an ARIA attribute{} (WAI-ARIA 1.2)", attr, crate::typecheck::did_you_mean(&attr, ARIA_ATTRS.iter().copied()))));
                continue;
            }
            if let (Some(v), Some(allowed)) = (value, enum_values(&attr)) {
                if !allowed.contains(&v.as_str()) {
                    out.push((format!("aria:{}", key), format!("aria-{} can't be \"{}\": use one of {}", attr, v, allowed.iter().map(|a| format!("\"{}\"", a)).collect::<Vec<_>>().join(", "))));
                }
            }
        }
    }

    // a positive tabindex reorders keyboard focus away from the visual order
    if el.tab_index.is_some_and(|n| n > 0) {
        out.push(("tab_index".into(), "tab_index above 0 makes keyboard focus jump out of reading order: use 0 (focusable in order) or -1 (focusable from code) (WCAG 2.4.3)".into()));
    }

    match el.tag {
        "Image" if !el.has("alt") && !el.hidden() => out.push((
            String::new(),
            "Image needs `alt:`: say what it shows, or `alt: \"\"` if it's only decoration (WCAG 1.1.1)".into(),
        )),
        "Svg" | "Canvas" if !el.named_ok() => out.push((
            String::new(),
            format!("{} needs `label:` (what it shows), or `aria: {{ hidden: true }}` if it's only decoration (WCAG 1.1.1)", el.tag),
        )),
        "Dialog" if !el.named_ok() => out.push((
            String::new(),
            "Dialog needs `label:` (its title, read when it opens) (WCAG 4.1.2)".into(),
        )),
        "Input" | "TextArea" | "Select" | "Slider" | "Checkbox" | "RichText" | "Progress" if !el.named_ok() => out.push((
            String::new(),
            format!(
                "{} needs `label:` saying what it's for{} (WCAG 1.3.1, 3.3.2, 4.1.2)",
                el.tag,
                if el.has("placeholder") { ": a placeholder disappears as you type and isn't a label" } else { "" }
            ),
        )),
        "Button" | "Link" => {
            if let Some(t) = &el.text {
                let readable = t.chars().any(|c| c.is_alphanumeric());
                if !readable && !el.has("title") && !el.named_ok() {
                    out.push((
                        String::new(),
                        format!("\"{}\" isn't a name a screen reader can say: add `label:` (or `title:`) saying what this {} does (WCAG 4.1.2)", t.trim(), el.tag.to_lowercase()),
                    ));
                }
            }
        }
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::compile;

    fn err(src: &str) -> String {
        compile(src).map(|_| String::from("(compiled)")).unwrap_or_else(|e| e.message)
    }
    fn view(body: &str) -> String {
        format!("view A {{ store v: String = \"\"; state S {{ render {{ {} }} }} }}", body)
    }

    #[test]
    fn wcag_and_aria_rules() {
        assert!(err(&view(r#"Image(src: "a.png")"#)).contains("Image needs `alt:`"));
        assert_eq!(err(&view(r#"Image(src: "a.png", alt: "")"#)), "(compiled)");
        assert!(err(&view(r#"Input(value: v, placeholder: "Name")"#)).contains("a placeholder disappears"));
        assert_eq!(err(&view(r#"Input(value: v, label: "Name")"#)), "(compiled)");
        assert_eq!(err(&view(r#"Input(value: v, aria: { labelledby: "name-label" })"#)), "(compiled)");
        assert!(err(&view(r#"Checkbox(checked: true)"#)).contains("Checkbox needs `label:`"));
        assert!(err(&view(r#"Button("⋯")"#)).contains("\"⋯\" isn't a name a screen reader can say"));
        assert_eq!(err(&view(r#"Button("⋯", title: "More")"#)), "(compiled)");
        assert_eq!(err(&view(r#"Button("Save")"#)), "(compiled)");
        assert!(err(&view(r#"Svg(view_box: "0 0 24 24")"#)).contains("Svg needs `label:`"));
        assert_eq!(err(&view(r#"Svg(view_box: "0 0 24 24", aria: { hidden: true })"#)), "(compiled)");
        assert!(err(&view(r#"Text("x", role: "buton")"#)).contains("'buton' isn't an ARIA role (did you mean 'button'?)"));
        assert!(err(&view(r#"Text("x", role: "widget")"#)).contains("abstract ARIA role"));
        assert!(err(&view(r#"Text("x", aria: { lable: "y" })"#)).contains("'aria-lable' isn't an ARIA attribute (did you mean 'label'?)"));
        assert!(err(&view(r#"Text("x", aria: { live: "loud" })"#)).contains("aria-live can't be \"loud\""));
        assert!(err(&view(r#"Text("x", tab_index: 3)"#)).contains("tab_index above 0"));
        assert_eq!(err(&view(r#"Text("x", role: "heading", aria: { level: 2, live: "polite" }, tab_index: -1)"#)), "(compiled)");
        assert_eq!(err(&view(r#"Text("x", role: "doc-chapter")"#)), "(compiled)");
        assert!(err(&view(r#"Dialog(open: true) { Text("x") } -> on_close(Go)"#)).contains("Dialog needs `label:`"));
        assert!(err(&view(r#"Dialog(open: true, label: "Rename") { Text("x") }"#)).contains("Dialog needs `-> on_close(Effect)`"));
    }
}
