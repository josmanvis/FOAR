//! Deterministic formatter for `.foar` source files (`foar fmt [--check]`).
//!
//! Normalizes indentation (4 spaces per `{` / `}` block level), strips trailing
//! whitespace, collapses excess consecutive blank lines to at most one, and
//! ensures a single trailing newline while preserving strings and comments verbatim.

pub fn format_source(src: &str) -> String {
    let mut out = String::with_capacity(src.len() + 16);
    let mut indent: usize = 0;
    let mut blank_run: usize = 0;
    let mut in_block_comment = false;

    for raw in src.lines() {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            if !out.is_empty() && blank_run == 0 {
                out.push('\n');
                blank_run += 1;
            }
            continue;
        }
        blank_run = 0;

        // Count leading closing braces on this line (outside block comments)
        let leading_closes = if in_block_comment {
            0
        } else {
            trimmed.chars().take_while(|&c| c == '}' || c == ']').count()
        };
        let line_indent = indent.saturating_sub(leading_closes);

        for _ in 0..line_indent {
            out.push_str("    ");
        }
        out.push_str(trimmed);
        out.push('\n');

        // Track brace delta on this line ignoring strings and comments
        let mut chars = trimmed.chars().peekable();
        let mut in_str = false;
        let mut escape = false;
        let mut opens: usize = 0;
        let mut closes: usize = 0;
        while let Some(c) = chars.next() {
            if in_block_comment {
                if c == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    in_block_comment = false;
                }
                continue;
            }
            if in_str {
                if escape {
                    escape = false;
                } else if c == '\\' {
                    escape = true;
                } else if c == '"' {
                    in_str = false;
                }
                continue;
            }
            if c == '/' && chars.peek() == Some(&'/') {
                break;
            }
            if c == '/' && chars.peek() == Some(&'*') {
                chars.next();
                in_block_comment = true;
                continue;
            }
            if c == '"' {
                in_str = true;
                continue;
            }
            match c {
                '{' | '[' => opens += 1,
                '}' | ']' => closes += 1,
                _ => {}
            }
        }
        indent = indent.saturating_add(opens).saturating_sub(closes);
    }

    while out.ends_with("\n\n") {
        out.pop();
    }
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out
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
        let formatted = format_source(src);
        assert_eq!(
            formatted,
            "view App {\n    // { unclosed comment brace\n    state Ready {\n        render { Text(\"a {b} c\") }\n    }\n}\n"
        );
    }
}
