//! Deterministic formatter for `.foar` source files (`foar fmt [--check]`, the
//! language server, and the playground through WebAssembly).
//!
//! Indentation is 4 spaces, decided by bracket nesting:
//! - a line's contents sit one level inside the line that opened their bracket;
//! - a line that starts by closing a bracket lines up with the line that opened it;
//! - continuation lines (`.style(…)`, `-> on_click(…)`) and comments directly
//!   above them sit one level deeper than the element they continue;
//! - brackets opened on a line after it closed an earlier one (`List(a,\n b) {`)
//!   belong to that earlier statement and indent from its line.
//!
//! Trailing whitespace goes, runs of blank lines collapse to one, the file ends
//! with exactly one newline, and strings and block comments are left alone.

/// Bracket characters of each line (outside strings and comments), whether the
/// line has any code, and whether it starts inside a block comment.
struct LineInfo {
    brackets: Vec<char>,
    has_code: bool,
    in_comment_at_start: bool,
}

fn scan(lines: &[&str]) -> Vec<LineInfo> {
    let mut out = Vec::with_capacity(lines.len());
    let mut in_block = false;
    for line in lines {
        let start_in_block = in_block;
        let mut brackets = Vec::new();
        let mut has_code = false;
        let mut chars = line.chars().peekable();
        let mut quote: Option<char> = None;
        while let Some(c) = chars.next() {
            if in_block {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    in_block = false;
                }
                continue;
            }
            if let Some(q) = quote {
                if c == '\\' {
                    chars.next();
                } else if c == q {
                    quote = None;
                }
                continue;
            }
            match c {
                '/' if chars.peek() == Some(&'/') => break,
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    in_block = true;
                }
                '"' | '\'' => {
                    has_code = true;
                    quote = Some(c);
                }
                '(' | ')' | '{' | '}' | '[' | ']' => {
                    has_code = true;
                    brackets.push(c);
                }
                c if c.is_whitespace() => {}
                _ => has_code = true,
            }
        }
        out.push(LineInfo { brackets, has_code, in_comment_at_start: start_in_block });
    }
    out
}

/// `.name(` or `->` at the start of a trimmed line: it continues the element above.
fn is_continuation(trimmed: &str) -> bool {
    if trimmed.starts_with("->") {
        return true;
    }
    let Some(rest) = trimmed.strip_prefix('.') else { return false };
    let ident: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    !ident.is_empty() && !ident.starts_with(|c: char| c.is_ascii_digit()) && rest[ident.len()..].trim_start().starts_with('(')
}

struct Open {
    line: usize,
    count: usize,
    indent: usize,
}

pub fn format_source(src: &str) -> String {
    let lines: Vec<&str> = src.lines().collect();
    let info = scan(&lines);
    let mut stack: Vec<Open> = Vec::new();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut blank = 0;

    for (i, raw) in lines.iter().enumerate() {
        if info[i].in_comment_at_start {
            out.push(raw.trim_end().to_string());
            continue;
        }
        let content = raw.trim();
        if content.is_empty() {
            blank += 1;
            if blank <= 1 && !out.is_empty() {
                out.push(String::new());
            }
            continue;
        }
        blank = 0;
        let br = &info[i].brackets;
        let mut k = 0;
        let mut level: Option<usize> = None;
        // leading closers line up with the line that opened them
        let lead = content.chars().filter(|c| !c.is_whitespace()).take_while(|c| matches!(c, ')' | '}' | ']')).count();
        while k < lead && k < br.len() {
            if let Some(top) = stack.last_mut() {
                if level.is_none() {
                    level = Some(top.indent);
                }
                top.count -= 1;
                if top.count == 0 {
                    stack.pop();
                }
            }
            k += 1;
        }
        let level = match level {
            Some(l) => l,
            None => {
                let mut l = stack.last().map_or(0, |t| t.indent + 1);
                // the line itself, or (for a comment) the next line with code
                let next = if info[i].has_code { Some(i) } else { (i + 1..lines.len()).find(|&j| info[j].has_code && !info[j].in_comment_at_start) };
                if next.is_some_and(|j| is_continuation(lines[j].trim())) {
                    l += 1;
                }
                l
            }
        };
        let mut base = level;
        for &c in &br[k..] {
            match c {
                '(' | '{' | '[' => match stack.last_mut() {
                    Some(top) if top.line == i => top.count += 1,
                    _ => stack.push(Open { line: i, count: 1, indent: base }),
                },
                _ => {
                    if let Some(top) = stack.last_mut() {
                        top.count -= 1;
                        if top.count == 0 {
                            let opened_on = top.line;
                            let indent = top.indent;
                            stack.pop();
                            if opened_on != i {
                                base = indent;
                            }
                        }
                    }
                }
            }
        }
        out.push(format!("{}{}", "    ".repeat(level), content));
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    let mut s = out.join("\n");
    if !s.is_empty() {
        s.push('\n');
    }
    s
}

#[cfg(test)]
mod tests {
    use super::format_source;

    #[test]
    fn formats_and_is_idempotent() {
        let messy = "view App {   \n  store x: i32 = 1;\n\n\n  state Ready {\nrender {\nText(\"hi {x}\")\n}\n}\n}\n";
        let expected = "view App {\n    store x: i32 = 1;\n\n    state Ready {\n        render {\n            Text(\"hi {x}\")\n        }\n    }\n}\n";
        let once = format_source(messy);
        assert_eq!(once, expected);
        assert_eq!(format_source(&once), once, "formatter must be idempotent");
    }

    #[test]
    fn ignores_braces_in_strings_and_comments() {
        let src = "view App {\n// { unclosed comment brace\nstate Ready {\nrender { Text(\"a {b} c\") }\n}\n}\n";
        assert_eq!(format_source(src), "view App {\n    // { unclosed comment brace\n    state Ready {\n        render { Text(\"a {b} c\") }\n    }\n}\n");
    }

    #[test]
    fn continuation_lines_and_multi_line_calls() {
        let src = "render {\nText(title)\n// a comment about the style\n.style({\ncolor: red;\n})\n-> on_click(Pick)\nRow(\nlabel: \"x\",\nrole: \"group\") {\nText(\"inside\")\n}\n}\n";
        let want = "render {\n    Text(title)\n        // a comment about the style\n        .style({\n            color: red;\n        })\n        -> on_click(Pick)\n    Row(\n        label: \"x\",\n        role: \"group\") {\n        Text(\"inside\")\n    }\n}\n";
        let got = format_source(src);
        assert_eq!(got, want, "\n{}", got);
        assert_eq!(format_source(&got), got);
    }

    #[test]
    fn css_selectors_are_not_continuations() {
        let src = "css {\n.row { gap: 4px; }\n.f4-text:hover { color: red; }\n}\n";
        assert_eq!(format_source(src), "css {\n    .row { gap: 4px; }\n    .f4-text:hover { color: red; }\n}\n");
    }

    #[test]
    fn block_comments_are_kept() {
        let src = "/* keep\n      this as is\n*/\nview A {\n}\n";
        assert_eq!(format_source(src), src);
    }
}
