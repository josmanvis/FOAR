//! `foar i18n`: checks the message catalogs of an app against the keys its
//! source uses with the runtime's built-in `t(key, params)`.
//!
//! * `t("a.b")` and `t_key("a.b")` are keys; `t("sort." + s)` is a dynamic prefix that marks every
//!   catalog key starting with `sort.` as used.
//! * Catalogs are `<dir>/<locale>.json`: flat `{ "key": "message" }`, where a
//!   message may be a plural object `{ "one": "...", "other": "..." }`.
//! * Reports, per locale: missing keys, unused keys, placeholders that differ
//!   from the fallback locale, and plural messages without `other`.
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Serialize)]
pub struct LocaleReport {
    pub locale: String,
    pub keys: usize,
    pub missing: Vec<String>,
    pub unused: Vec<String>,
    pub placeholder_mismatch: Vec<String>,
    pub plural_without_other: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub used: Vec<String>,
    pub dynamic_prefixes: Vec<String>,
    pub fallback: String,
    pub locales: Vec<LocaleReport>,
}

impl Report {
    pub fn ok(&self) -> bool {
        self.locales
            .iter()
            .all(|l| l.missing.is_empty() && l.placeholder_mismatch.is_empty() && l.plural_without_other.is_empty())
    }
}

/// Keys used by `t("...")` calls, and prefixes of `t("..." + expr)` calls.
pub fn keys_in_source(src: &str) -> (BTreeSet<String>, BTreeSet<String>) {
    // t("key") in .foar, t('key') or t("key") in host JavaScript; t_key("key")
    // marks a key stored as data and translated later.
    let re = Regex::new(
        r#"(?:^|[^A-Za-z0-9_$.])(?:t|t_key)\([ \t\r\n]*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')[ \t\r\n]*([+,)])"#,
    )
    .unwrap();
    let mut keys = BTreeSet::new();
    let mut prefixes = BTreeSet::new();
    for c in re.captures_iter(src) {
        let k = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_string()).unwrap_or_default();
        if &c[3] == "+" {
            prefixes.insert(k);
        } else {
            keys.insert(k);
        }
    }
    (keys, prefixes)
}

fn placeholders(v: &Value) -> BTreeSet<String> {
    let re = Regex::new(r"\{([A-Za-z0-9_]+)\}").unwrap();
    let mut out = BTreeSet::new();
    let mut scan = |s: &str| {
        for c in re.captures_iter(s) {
            out.insert(c[1].to_string());
        }
    };
    match v {
        Value::String(s) => scan(s),
        Value::Object(m) => {
            for x in m.values() {
                if let Value::String(s) = x {
                    scan(s);
                }
            }
            // plural messages get {count} implicitly
            out.insert("count".to_string());
        }
        _ => {}
    }
    out
}

pub fn check(
    sources: &[String],
    catalogs: &BTreeMap<String, BTreeMap<String, Value>>,
    fallback: &str,
) -> Report {
    let mut used = BTreeSet::new();
    let mut prefixes = BTreeSet::new();
    for s in sources {
        let (k, p) = keys_in_source(s);
        used.extend(k);
        prefixes.extend(p);
    }
    let is_used = |k: &str| used.contains(k) || prefixes.iter().any(|p| k.starts_with(p.as_str()));
    let base = catalogs.get(fallback);

    let mut locales = Vec::new();
    for (name, cat) in catalogs {
        let mut r = LocaleReport { locale: name.clone(), keys: cat.len(), ..Default::default() };
        for k in &used {
            if !cat.contains_key(k) {
                r.missing.push(k.clone());
            }
        }
        // Keys reached through a dynamic prefix must exist wherever the fallback has them.
        if let Some(base) = base {
            for k in base.keys() {
                if prefixes.iter().any(|p| k.starts_with(p.as_str())) && !cat.contains_key(k) {
                    r.missing.push(k.clone());
                }
            }
        }
        for (k, v) in cat {
            if !is_used(k) {
                r.unused.push(k.clone());
            }
            if let Value::Object(m) = v {
                if !m.contains_key("other") {
                    r.plural_without_other.push(k.clone());
                }
            }
            if name != fallback {
                if let Some(bv) = base.and_then(|b| b.get(k)) {
                    let (a, b) = (placeholders(bv), placeholders(v));
                    if a != b {
                        r.placeholder_mismatch.push(format!("{}: {:?} vs {:?}", k, b, a));
                    }
                }
            }
        }
        r.missing.sort();
        r.missing.dedup();
        locales.push(r);
    }
    Report {
        used: used.into_iter().collect(),
        dynamic_prefixes: prefixes.into_iter().collect(),
        fallback: fallback.to_string(),
        locales,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn cat(v: Value) -> BTreeMap<String, Value> {
        v.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    #[test]
    fn finds_keys_and_problems() {
        let src = r#"Text(t("a.title")) Text(t("count", { count: n })) Text(t("sort." + s)) x.t("not.a.key") at("nope") t('js.key') t_key("later")"#;
        let (keys, pre) = keys_in_source(src);
        assert_eq!(keys.into_iter().collect::<Vec<_>>(), vec!["a.title", "count", "js.key", "later"]);
        assert_eq!(pre.into_iter().collect::<Vec<_>>(), vec!["sort."]);

        let mut cats = BTreeMap::new();
        cats.insert("en".into(), cat(json!({ "later": "x", "js.key": "x", "a.title": "Hi {name}", "count": { "one": "# item", "other": "{count} items" }, "sort.title": "Title", "old": "x" })));
        cats.insert("es".into(), cat(json!({ "later": "x", "js.key": "x", "a.title": "Hola", "count": { "one": "1" }, "old": "x" })));
        let r = check(&[src.to_string()], &cats, "en");
        let en = &r.locales[0];
        assert!(en.missing.is_empty(), "{:?}", en.missing);
        assert_eq!(en.unused, vec!["old"]);
        let es = &r.locales[1];
        assert_eq!(es.missing, vec!["sort.title"]);
        assert_eq!(es.plural_without_other, vec!["count"]);
        assert_eq!(es.placeholder_mismatch.len(), 1);
        assert!(!r.ok());
    }
}
