//! Tokenizer (logos). Tokens keep their source span so the parser can
//! reconstruct text with the user's own spacing (important for CSS values
//! like `calc(100% - 20px)` vs `line-through`).
use logos::Logos;

#[derive(Logos, Debug, Clone, PartialEq)]
#[logos(skip r"[ \t\r\n\f]+")]
#[logos(skip r"//[^\n]*")]
#[logos(skip r"/\*([^*]|\*[^/])*\*/")]
enum Raw {
    #[regex(r"->|=>|==|!=|<=|>=|\+=|-=|&&|\|\|")]
    Op,
    #[regex(r#""([^"\\]|\\.)*""#)]
    Str,
    #[regex(r"[#@][a-zA-Z0-9_-]*")]
    Special,
    #[regex(r"[0-9][0-9.]*[a-zA-Z%]*")]
    Num,
    #[regex(r"[a-zA-Z_][a-zA-Z0-9_]*")]
    Ident,
    #[regex(r##"[^ \t\r\n\fa-zA-Z0-9_"#@]"##)]
    Punct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Op,
    Str,
    Special,
    Num,
    Ident,
    Punct,
    Eof,
}

#[derive(Debug, Clone)]
pub struct Token {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
}

pub fn unescape(quoted: &str) -> String {
    let inner = &quoted[1..quoted.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(o) => out.push(o),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn lex(src: &str) -> Result<Vec<Token>, usize> {
    let mut out = Vec::new();
    for (res, span) in Raw::lexer(src).spanned() {
        let kind = match res {
            Ok(Raw::Op) => Kind::Op,
            Ok(Raw::Str) => Kind::Str,
            Ok(Raw::Special) => Kind::Special,
            Ok(Raw::Num) => Kind::Num,
            Ok(Raw::Ident) => Kind::Ident,
            Ok(Raw::Punct) => Kind::Punct,
            Err(_) => return Err(span.start),
        };
        out.push(Token { kind, start: span.start, end: span.end });
    }
    out.push(Token { kind: Kind::Eof, start: src.len(), end: src.len() });
    Ok(out)
}
