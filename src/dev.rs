//! The parts of the CLI that make `foar` usable on its own, with nothing else
//! installed: the runtime is built into the binary, `foar dev` serves a project
//! with live reload, and `foar build` (in a project) writes a deployable `dist/`.

use std::io::{BufRead, BufReader, IsTerminal, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, UNIX_EPOCH};

/// The minified runtime (web/foar-runtime.min.js, built by scripts/build-runtime.mjs):
/// what `foar build` writes next to your app.
pub const RUNTIME: &str = include_str!("../web/foar-runtime.min.js");
/// The readable runtime, served by `foar dev` so stack traces stay readable.
pub const RUNTIME_DEV: &str = include_str!("../web/foar-runtime.js");

pub const INSTALL_SH: &str = "https://josmanvis.github.io/FOAR/install.sh";
pub const INSTALL_PS1: &str = "https://josmanvis.github.io/FOAR/install.ps1";

// ---- terminal styling --------------------------------------------------------------

fn color() -> bool {
    std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal()
}

/// `paint("1;33", "text")`: ANSI SGR when stdout is a colour terminal.
pub fn paint(code: &str, text: &str) -> String {
    if color() {
        format!("\x1b[{}m{}\x1b[0m", code, text)
    } else {
        text.to_string()
    }
}
const AMBER: &str = "38;5;214";
const GREEN: &str = "32";
const RED: &str = "31";
const DIM: &str = "2";
const BOLD: &str = "1";

// ---- projects ------------------------------------------------------------------------

/// The entry file: `entry = "…"` in foar.toml, else app.foar.
pub fn entry_of(dir: &Path) -> String {
    std::fs::read_to_string(dir.join("foar.toml"))
        .ok()
        .and_then(|toml| {
            toml.lines().find_map(|l| {
                let l = l.trim();
                let rest = l.strip_prefix("entry")?.trim_start().strip_prefix('=')?.trim();
                Some(rest.trim_matches('"').to_string())
            })
        })
        .unwrap_or_else(|| "app.foar".to_string())
}

pub fn compile_dir(dir: &Path, entry: &str) -> Result<foar::ast::Program, foar::CompileError> {
    foar::project::load(entry, &mut |p| std::fs::read_to_string(dir.join(p)).ok()).and_then(|files| foar::project::compile_files(&files))
}

fn project_name(dir: &Path) -> String {
    std::fs::canonicalize(dir)
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "foar-app".to_string())
}

/// The page `foar init` writes, and what `foar dev` serves when there's no index.html.
pub fn index_html(title: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import {{ mount }} from './app.js';
      mount(document.getElementById('app'));
    </script>
  </body>
</html>
"#,
        title.replace('<', "&lt;")
    )
}

/// app.js for a program that doesn't compile: shows the error in the page.
fn error_module(message: &str) -> String {
    let msg = serde_json::to_string(message).unwrap();
    format!(
        r#"// foar dev: the program doesn't compile
const message = {msg};
console.error(message);
export function mount(el) {{
  el.replaceChildren();
  const box = document.createElement('pre');
  box.textContent = message;
  box.style.cssText = 'margin:24px;padding:18px 20px;border-left:6px solid #c8322b;border-radius:6px;background:#2c3b34;color:#f3f4f1;font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap';
  el.append(box);
}}
export const hydrate = mount;
"#
    )
}

// ---- foar build (in a project) -----------------------------------------------------------

/// `foar build` with no file: <project>/dist with index.html, app.js, foar-runtime.js.
pub fn build_project(dir: &Path, out: &Path) {
    let entry = entry_of(dir);
    if !dir.join(&entry).is_file() {
        eprintln!("foar: no {} here. Run `foar init` to start a project, or `foar build <file.foar>`.", entry);
        std::process::exit(1);
    }
    let started = Instant::now();
    let program = compile_dir(dir, &entry).unwrap_or_else(|e| {
        eprintln!("{}", paint(RED, &e.to_string()));
        std::process::exit(1)
    });
    std::fs::create_dir_all(out).unwrap_or_else(|e| {
        eprintln!("foar: cannot create {}: {}", out.display(), e);
        std::process::exit(1)
    });
    let index = std::fs::read_to_string(dir.join("index.html")).unwrap_or_else(|_| index_html(&project_name(dir)));
    let files = [
        ("index.html", index),
        ("app.js", foar::program_to_js_module(&program, "./foar-runtime.js")),
        ("foar-runtime.js", RUNTIME.to_string()),
    ];
    for (name, text) in &files {
        std::fs::write(out.join(name), text).unwrap_or_else(|e| {
            eprintln!("foar: cannot write {}: {}", out.join(name).display(), e);
            std::process::exit(1)
        });
    }
    println!(
        "{} built {} in {} ms {}",
        paint(GREEN, "✓"),
        paint(BOLD, &entry),
        started.elapsed().as_millis(),
        paint(DIM, &format!("→ {}/ (index.html, app.js, foar-runtime.js)", out.display()))
    );
}

// ---- foar dev ------------------------------------------------------------------------------

/// Newest modification time of the project's source files: the page polls it to reload.
fn stamp(dir: &Path) -> u128 {
    fn walk(p: &Path, depth: usize, best: &mut u128) {
        let Ok(entries) = std::fs::read_dir(p) else { return };
        for e in entries.flatten() {
            let path = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "dist" || name == "target" {
                continue;
            }
            if path.is_dir() {
                if depth < 8 {
                    walk(&path, depth + 1, best);
                }
            } else if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                let ms = t.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                *best = (*best).max(ms);
            }
        }
    }
    let mut best = 0;
    walk(dir, 0, &mut best);
    best
}

const RELOAD: &str = r#"<script type="module">
  // foar dev: reload when a file changes
  const seen = '__STAMP__';
  setInterval(async () => {
    try {
      const now = await (await fetch('/__foar/stamp')).text();
      if (now !== seen) location.reload();
    } catch {}
  }, 400);
</script>
"#;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "txt" | "foar" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn respond(stream: &mut TcpStream, status: &str, kind: &str, body: &[u8]) {
    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        status,
        kind,
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body);
}

struct Dev {
    dir: PathBuf,
    /// the project directory, resolved: nothing outside it is served (symlinks included)
    root: PathBuf,
    /// the --host the server was started with
    bind_host: String,
    entry: String,
    /// the last compile result we printed, so each change is reported once
    last: Mutex<Option<(u128, bool)>>,
}

impl Dev {
    fn app_js(&self) -> String {
        let started = Instant::now();
        let result = compile_dir(&self.dir, &self.entry);
        let now = stamp(&self.dir);
        let ok = result.is_ok();
        let mut last = self.last.lock().unwrap();
        if last.map_or(true, |(s, o)| s != now || o != ok) {
            match &result {
                Ok(_) => println!(
                    "  {} compiled {} {}",
                    paint(GREEN, "✓"),
                    self.entry,
                    paint(DIM, &format!("in {} ms", started.elapsed().as_millis()))
                ),
                Err(e) => println!("  {} {}", paint(RED, "✗"), paint(RED, &e.to_string())),
            }
            *last = Some((now, ok));
        }
        match result {
            Ok(p) => foar::program_to_js_module(&p, "./foar-runtime.js"),
            Err(e) => error_module(&e.to_string()),
        }
    }

    fn handle(&self, mut stream: TcpStream) {
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut first = String::new();
        if reader.read_line(&mut first).is_err() {
            return;
        }
        let mut host_header = None;
        for _ in 0..100 {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line == "\r\n" || line == "\n" => break,
                _ => {
                    if let Some((k, v)) = line.split_once(':') {
                        if k.trim().eq_ignore_ascii_case("host") {
                            host_header = Some(v.trim().to_string());
                        }
                    }
                }
            }
        }
        // DNS rebinding: a web page can point its own domain at 127.0.0.1 and read
        // this server; it can't make the browser send Host: localhost or an IP.
        if !self.host_allowed(host_header.as_deref().unwrap_or("")) {
            return respond(&mut stream, "403 Forbidden", "text/plain", b"foar dev: this Host isn't allowed (use localhost or the --host you started it with)");
        }
        let mut parts = first.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("/");
        if method != "GET" && method != "HEAD" {
            return respond(&mut stream, "405 Method Not Allowed", "text/plain", b"GET only");
        }
        let path = target.split(['?', '#']).next().unwrap_or("/");
        let path = percent_decode(path);
        match path.as_str() {
            "/__foar/stamp" => respond(&mut stream, "200 OK", "text/plain", stamp(&self.dir).to_string().as_bytes()),
            "/app.js" => respond(&mut stream, "200 OK", mime("x.js"), self.app_js().as_bytes()),
            "/foar-runtime.js" if !self.dir.join("foar-runtime.js").is_file() => respond(&mut stream, "200 OK", mime("x.js"), RUNTIME_DEV.as_bytes()),
            _ => self.serve_file(&mut stream, &path),
        }
    }

    fn host_allowed(&self, header: &str) -> bool {
        let host = if header.starts_with('[') {
            header.split(']').next().map(|h| format!("{}]", h)).unwrap_or_default()
        } else {
            header.rsplit_once(':').map_or(header, |(h, port)| if port.chars().all(|c| c.is_ascii_digit()) { h } else { header }).to_string()
        };
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        host.eq_ignore_ascii_case("localhost")
            || host.to_ascii_lowercase().ends_with(".localhost")
            || bare.parse::<std::net::IpAddr>().is_ok()
            || host.eq_ignore_ascii_case(&self.bind_host)
    }

    fn serve_file(&self, stream: &mut TcpStream, path: &str) {
        let rel = Path::new(path.trim_start_matches('/'));
        if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
            return respond(stream, "403 Forbidden", "text/plain", b"forbidden");
        }
        let mut file = self.dir.join(rel);
        if path.ends_with('/') || file.is_dir() {
            file = file.join("index.html");
        }
        let is_root_index = rel.as_os_str().is_empty() || rel == Path::new("index.html");
        // follow symlinks, then make sure we're still inside the project
        if let Ok(real) = std::fs::canonicalize(&file) {
            if !real.starts_with(&self.root) {
                return respond(stream, "403 Forbidden", "text/plain", b"forbidden: outside the project");
            }
        }
        let body = match std::fs::read(&file) {
            Ok(b) => b,
            Err(_) if is_root_index => index_html(&project_name(&self.dir)).into_bytes(),
            Err(_) => return respond(stream, "404 Not Found", "text/plain; charset=utf-8", format!("{} not found", path).as_bytes()),
        };
        let name = file.to_string_lossy().to_string();
        if name.ends_with(".html") {
            let html = String::from_utf8_lossy(&body);
            // the stamp as of this page, so a change made before the first poll still reloads
            let reload = RELOAD.replace("__STAMP__", &stamp(&self.dir).to_string());
            let html = match html.rfind("</body>") {
                Some(i) => format!("{}{}{}", &html[..i], reload, &html[i..]),
                None => format!("{}{}", html, reload),
            };
            respond(stream, "200 OK", mime(&name), html.as_bytes())
        } else {
            respond(stream, "200 OK", mime(&name), &body)
        }
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// `foar dev [dir] [--port 5173] [--host 127.0.0.1]`
pub fn dev_cmd(args: &[String]) {
    let mut dir = PathBuf::from(".");
    let mut port: u16 = 5173;
    let mut host = "127.0.0.1".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" | "-p" => {
                i += 1;
                port = args.get(i).and_then(|p| p.parse().ok()).unwrap_or_else(|| {
                    eprintln!("foar: --port needs a number");
                    std::process::exit(2)
                });
            }
            "--host" => {
                i += 1;
                host = args.get(i).cloned().unwrap_or(host);
            }
            a => dir = PathBuf::from(a),
        }
        i += 1;
    }
    let entry = entry_of(&dir);
    if !dir.join(&entry).is_file() {
        eprintln!("foar: no {} in {}. Run `foar init` to start a project.", entry, dir.display());
        std::process::exit(1);
    }
    // the requested port, or the next free one
    let listener = (port..port.saturating_add(20))
        .find_map(|p| TcpListener::bind((host.as_str(), p)).ok())
        .unwrap_or_else(|| {
            eprintln!("foar: no free port from {}", port);
            std::process::exit(1)
        });
    let addr = listener.local_addr().unwrap();
    let shown_host = if host == "127.0.0.1" || host == "0.0.0.0" { "localhost".to_string() } else { host.clone() };
    println!();
    println!("  {} {}  {}", paint(AMBER, "●"), paint(BOLD, "foar dev"), paint(DIM, &format!("v{}", foar::version())));
    println!();
    println!("  {}  {}", paint(DIM, "Local "), paint("36", &format!("http://{}:{}/", shown_host, addr.port())));
    println!("  {}  {}", paint(DIM, "Entry "), entry);
    println!("  {}  {}", paint(DIM, "Reload"), "on save");
    println!();
    let root = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    let dev = Arc::new(Dev { dir, root, bind_host: host.clone(), entry, last: Mutex::new(None) });
    let _ = dev.app_js(); // report the first compile straight away
    for stream in listener.incoming().flatten() {
        let dev = Arc::clone(&dev);
        std::thread::spawn(move || dev.handle(stream));
    }
}

// ---- foar upgrade --------------------------------------------------------------------------

/// Re-runs the installer, into the directory this binary lives in.
pub fn upgrade_cmd(args: &[String]) {
    let version = args.first().cloned().unwrap_or_else(|| "latest".to_string());
    let exe = std::env::current_exe().ok().and_then(|p| std::fs::canonicalize(p).ok());
    let bin_dir = exe.as_ref().and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let mut cmd = if cfg!(windows) {
        let mut c = std::process::Command::new("powershell");
        c.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &format!("irm {} | iex", INSTALL_PS1)]);
        c
    } else {
        let mut c = std::process::Command::new("sh");
        c.args(["-c", &format!("(curl -fsSL {0} || wget -qO- {0}) | sh", INSTALL_SH)]);
        c
    };
    cmd.env("FOAR_VERSION", &version);
    if let Some(d) = &bin_dir {
        cmd.env("FOAR_BIN_DIR", d);
    }
    match cmd.status() {
        Ok(s) if s.success() => {}
        Ok(s) => std::process::exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("foar: could not run the installer: {}", e);
            std::process::exit(1)
        }
    }
}
