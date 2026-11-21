//! foar CLI
//!   foar init [dir] / foar dev [dir] / foar build (in a project) / foar upgrade
//!   foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]
//!   foar build - --project      (stdin: {"entry", "files": {path: source}})
//!   foar check <file.foar>
//!   foar i18n <locales-dir> <source files...> [--fallback en] [--format json]
use std::io::{Read, Write};
use std::process::exit;

mod dev;
use dev::paint;

fn usage() -> ! {
    eprintln!(
        "foar {}\n\nStart:\n  foar init [dir]             a new project (app.foar, index.html, foar.toml)\n  foar dev [dir] [--port N]   serve it with live reload\n  foar build                  write dist/ (index.html, app.js, foar-runtime.js)\n  foar upgrade [version]      install the latest foar (or a given one)\n\nUsage:\n  foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]\n  foar check <file.foar>\n  foar fmt <files...> [--check]\n  foar init [dir]\n  foar add <name> --path <dir> | --git <url> | --version <ver> [--registry <url>]\n  foar install [--frozen]\n  foar pkg [--verify]\n  foar lsp\n  foar i18n <locales-dir> <source files...> [--fallback en] [--format json]\n\n  --format json   program JSON for createFoarRuntime (default)\n  --format js     ES module exporting {{ program, mount, hydrate, hydrateIslands, renderToString, renderToStringAsync, renderToStream, createI18n }}\n  --runtime       import path of foar-runtime.js in the JS module (default ./foar-runtime.js)\n  -               read source from stdin\n  --project       with -: stdin is a project {{\"entry\", \"files\": {{path: source}}}}\n\nA file is compiled together with its imports (relative paths or @package via foar.toml).",
        foar::version()
    );
    exit(2)
}

fn read_source(path: &str) -> String {
    if path == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    } else {
        match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("foar: cannot read {}: {}", path, e);
                exit(1)
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        usage();
    }
    if args[0] == "--version" || args[0] == "-V" {
        println!("foar {}", foar::version());
        return;
    }
    let cmd = args[0].as_str();
    match cmd {
        "i18n" => {
            i18n_cmd(&args[1..]);
            return;
        }
        "init" => {
            init_cmd(&args[1..]);
            return;
        }
        "add" => {
            add_cmd(&args[1..]);
            return;
        }
        "install" => {
            install_cmd(&args[1..]);
            return;
        }
        "pkg" => {
            pkg_cmd(&args[1..]);
            return;
        }
        "lsp" => {
            foar::lsp::run_stdio();
            return;
        }
        "fmt" => {
            fmt_cmd(&args[1..]);
            return;
        }
        "dev" | "serve" => {
            dev::dev_cmd(&args[1..]);
            return;
        }
        "upgrade" | "self-update" => {
            dev::upgrade_cmd(&args[1..]);
            return;
        }
        _ => {}
    }
    let mut input = None;
    let mut out = None;
    let mut format = "json".to_string();
    let mut pretty = false;
    let mut project = false;
    let mut runtime = "./foar-runtime.js".to_string();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-o" | "--out" => {
                i += 1;
                out = args.get(i).cloned();
            }
            "--format" | "-f" => {
                i += 1;
                format = args.get(i).cloned().unwrap_or_default();
            }
            "--runtime" => {
                i += 1;
                runtime = args.get(i).cloned().unwrap_or_default();
            }
            "--pretty" | "-p" => pretty = true,
            "--project" => project = true,
            a if input.is_none() => input = Some(a.to_string()),
            a => {
                eprintln!("foar: unexpected argument {}", a);
                usage()
            }
        }
        i += 1;
    }
    // `foar build` in a project: a deployable dist/
    if cmd == "build" && input.is_none() && (std::path::Path::new("foar.toml").is_file() || std::path::Path::new("app.foar").is_file()) {
        dev::build_project(std::path::Path::new("."), std::path::Path::new(out.as_deref().unwrap_or("dist")));
        return;
    }
    let input = input.unwrap_or_else(|| usage());
    if project {
        // `foar build - --project`: stdin is {"entry", "files": {path: source}};
        // prints the program JSON (with `files`) or {"error": ...}.
        let out = foar::project::compile_project_json(&read_source(&input));
        println!("{}", out);
        exit(if out.starts_with("{\"error\"") { 1 } else { 0 })
    }
    // A file is compiled with everything it imports (see src/project.rs);
    // stdin is a single self-contained source.
    let compiled = if input == "-" {
        foar::compile(&read_source(&input))
    } else {
        let entry = std::path::Path::new(&input);
        let root = entry.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let name = entry.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !entry.is_file() {
            eprintln!("foar: cannot read {}", input);
            exit(1)
        }
        foar::project::load(&name, &mut |p| std::fs::read_to_string(root.join(p)).ok()).and_then(|files| foar::project::compile_files(&files)).map_err(|mut e| {
            if let Some(f) = &e.file {
                e.file = Some(root.join(f).to_string_lossy().trim_start_matches("./").to_string());
            }
            e
        })
    };
    let show = |e: &foar::CompileError| if e.file.is_some() { e.to_string() } else { format!("{}:{}", input, e) };

    match cmd {
        "check" => match compiled {
            Ok(p) => println!(
                "✓ {}: {} view(s), {} data type(s), {} enum(s), {} extern(s), {} bytes of CSS",
                input,
                p.views.len(),
                p.data_decls.len(),
                p.enums.len(),
                p.externs.len(),
                p.css.len()
            ),
            Err(e) => {
                eprintln!("{}", show(&e));
                exit(1)
            }
        },
        "build" => {
            let result = match format.as_str() {
                "json" => compiled.map(|p| if pretty { serde_json::to_string_pretty(&p).unwrap() } else { serde_json::to_string(&p).unwrap() }),
                "js" => compiled.map(|p| foar::program_to_js_module(&p, &runtime)),
                other => {
                    eprintln!("foar: unknown format {}", other);
                    exit(2)
                }
            };
            match result {
                Ok(text) => match out {
                    Some(path) => {
                        if let Some(parent) = std::path::Path::new(&path).parent().filter(|p| !p.as_os_str().is_empty()) {
                            std::fs::create_dir_all(parent).ok();
                        }
                        std::fs::write(&path, text).unwrap_or_else(|e| {
                            eprintln!("foar: cannot write {}: {}", path, e);
                            exit(1)
                        });
                        eprintln!("✓ wrote {}", path);
                        // the module imports ./foar-runtime.js: put the built-in one beside it
                        if format == "js" && runtime == "./foar-runtime.js" {
                            let beside = std::path::Path::new(&path).with_file_name("foar-runtime.js");
                            if !beside.exists() && std::fs::write(&beside, dev::RUNTIME).is_ok() {
                                eprintln!("✓ wrote {}", beside.display());
                            }
                        }
                    }
                    None => {
                        let mut so = std::io::stdout();
                        so.write_all(text.as_bytes()).unwrap();
                        so.write_all(b"\n").unwrap();
                    }
                },
                Err(e) => {
                    if format == "json" {
                        // machine-readable for tooling (dev server, editors)
                        println!("{}", serde_json::json!({ "error": e }));
                    }
                    eprintln!("{}", show(&e));
                    exit(1)
                }
            }
        }
        _ => usage(),
    }
}

fn i18n_cmd(args: &[String]) {
    let mut fallback = "en".to_string();
    let mut json = false;
    let mut paths = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--fallback" => {
                i += 1;
                fallback = args.get(i).cloned().unwrap_or_else(|| usage());
            }
            "--format" | "-f" => {
                i += 1;
                json = args.get(i).map(|s| s == "json").unwrap_or(false);
            }
            a => paths.push(a.to_string()),
        }
        i += 1;
    }
    if paths.len() < 2 {
        usage();
    }
    let dir = &paths[0];
    let mut catalogs = std::collections::BTreeMap::new();
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| {
        eprintln!("foar: cannot read {}: {}", dir, e);
        exit(1)
    });
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = p.file_stem().unwrap().to_string_lossy().to_string();
        let text = read_source(&p.to_string_lossy());
        match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text) {
            Ok(m) => {
                catalogs.insert(name, m.into_iter().collect());
            }
            Err(e) => {
                eprintln!("{}: invalid JSON: {}", p.display(), e);
                exit(1)
            }
        }
    }
    if !catalogs.contains_key(&fallback) {
        eprintln!("foar: no {}/{}.json (fallback locale)", dir, fallback);
        exit(1)
    }
    let sources: Vec<String> = paths[1..].iter().map(|p| read_source(p)).collect();
    let report = foar::i18n::check(&sources, &catalogs, &fallback);
    if json {
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
    } else {
        println!("{} keys used in source, {} dynamic prefix(es) {:?}", report.used.len(), report.dynamic_prefixes.len(), report.dynamic_prefixes);
        for l in &report.locales {
            let mark = if l.missing.is_empty() && l.placeholder_mismatch.is_empty() && l.plural_without_other.is_empty() { "✓" } else { "✗" };
            println!("{} {}: {} messages", mark, l.locale, l.keys);
            for k in &l.missing {
                println!("    missing      {}", k);
            }
            for k in &l.placeholder_mismatch {
                println!("    placeholders {}", k);
            }
            for k in &l.plural_without_other {
                println!("    plural needs \"other\": {}", k);
            }
            for k in &l.unused {
                println!("    unused       {}", k);
            }
        }
    }
    if !report.ok() {
        exit(1)
    }
}

fn init_cmd(args: &[String]) {
    let dir = args.first().map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("."));
    if dir != std::path::Path::new(".") {
        std::fs::create_dir_all(&dir).unwrap_or_else(|e| {
            eprintln!("foar: cannot create {}: {}", dir.display(), e);
            exit(1)
        });
    }
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty() && *n != ".")
        .unwrap_or("foar-app");
    let manifest_path = dir.join("foar.toml");
    let app_path = dir.join("app.foar");
    if !manifest_path.exists() {
        let toml = format!(
            "[package]\nname = \"{}\"\nversion = \"0.1.0\"\nentry = \"app.foar\"\n\n[dependencies]\n",
            name
        );
        std::fs::write(&manifest_path, toml).unwrap_or_else(|e| {
            eprintln!("foar: cannot write {}: {}", manifest_path.display(), e);
            exit(1)
        });
    }
    if !app_path.exists() {
        let starter = "view App {\n    store count: i32 = 0;\n\n    state Ready {\n        render {\n            Column {\n                Text(\"Count: {count}\")\n                Button(\"Increment\") -> on_click(Inc)\n            }\n        }\n        effect Inc() {\n            count += 1;\n        }\n    }\n}\n";
        std::fs::write(&app_path, starter).unwrap_or_else(|e| {
            eprintln!("foar: cannot write {}: {}", app_path.display(), e);
            exit(1)
        });
    }
    let index_path = dir.join("index.html");
    if !index_path.exists() {
        std::fs::write(&index_path, dev::index_html(name)).ok();
    }
    let ignore_path = dir.join(".gitignore");
    if !ignore_path.exists() {
        std::fs::write(&ignore_path, "dist/\nfoar_packages/\n").ok();
    }
    println!();
    println!("  {} {} {}", paint("38;5;214", "●"), paint("1", "New FOAR project"), paint("2", &format!("in {}", dir.display())));
    println!();
    for f in ["app.foar", "index.html", "foar.toml", ".gitignore"] {
        println!("    {} {}", paint("32", "+"), f);
    }
    println!();
    println!("  Next:");
    if dir != std::path::Path::new(".") {
        println!("    {}", paint("36", &format!("cd {}", dir.display())));
    }
    println!("    {}       {}", paint("36", "foar dev"), paint("2", "open it in the browser, reloads on save"));
    println!("    {}     {}", paint("36", "foar build"), paint("2", "write dist/ for any static host"));
    println!();
}


// ---- packages: everything here can come from someone else's foar.toml ----------------
// Names, versions and URLs are validated, and git/curl/tar run without a shell,
// so a manifest can't run commands or write outside foar_packages/.

fn pkg_die(msg: String) -> ! {
    eprintln!("foar: {}", msg);
    exit(1)
}

/// `ui`, `date-fns`, `my_pkg.v2`: no paths, no leading dot or dash.
fn check_pkg_name(name: &str) -> &str {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        && !name.starts_with(['.', '-'])
        && !name.contains("..");
    if !ok {
        pkg_die(format!("invalid package name {:?}: use letters, digits, '-', '_' and '.'", name));
    }
    name
}

/// `1.2.3`, `^1.0.0`, `~2.1`, `latest`.
fn check_version(v: &str) -> &str {
    let body = v.trim_start_matches(['^', '~', '=']);
    let ok = !body.is_empty() && body.len() <= 64 && body.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    if !ok {
        pkg_die(format!("invalid version {:?}", v));
    }
    v
}

fn is_loopback_http(url: &str) -> bool {
    let rest = url.strip_prefix("http://").unwrap_or("");
    let host = rest.split(['/', ':']).next().unwrap_or("");
    !rest.is_empty() && matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

/// A registry is an https URL (or http on localhost, for testing). There's no
/// default: FOAR has no public registry, so the domain can't be squatted.
fn check_registry(url: Option<&str>) -> String {
    let Some(url) = url else {
        pkg_die("this dependency has no registry: FOAR has no public package registry, so give one (`registry = \"https://…\"`, or `--registry`), or use `git` / `path`".to_string())
    };
    let ok = (url.starts_with("https://") || is_loopback_http(url)) && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"');
    if !ok {
        pkg_die(format!("invalid registry {:?}: it must be an https:// URL", url));
    }
    url.trim_end_matches('/').to_string()
}

/// https://, ssh://, git://, file:// or user@host:path; never an option or a git transport helper.
fn check_git_url(url: &str) -> &str {
    let scheme_ok = ["https://", "http://", "ssh://", "git://", "file://"].iter().any(|p| url.starts_with(p))
        || (url.contains('@') && url.contains(':') && !url.contains("://"));
    let ok = scheme_ok && !url.starts_with('-') && !url.contains("::") && !url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"');
    if !ok {
        pkg_die(format!("invalid git URL {:?}: use https://, ssh://, git://, file:// or user@host:path", url));
    }
    url
}

fn git_clone(url: &str, dest: &std::path::Path) -> bool {
    std::process::Command::new("git")
        .args(["-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "clone", "--depth", "1", "--"])
        .arg(url)
        .arg(dest)
        .status()
        .is_ok_and(|s| s.success())
}

/// Downloads <registry>/packages/<name>/<version>.tar.gz and unpacks it into dest.
fn fetch_registry_package(registry: &str, name: &str, version: &str, dest: &std::path::Path) -> Result<(), String> {
    let url = format!("{}/packages/{}/{}.tar.gz", registry, name, version.trim_start_matches(['^', '~', '=']));
    let archive = std::env::temp_dir().join(format!("foar-pkg-{}-{}.tar.gz", std::process::id(), name));
    let mut curl = std::process::Command::new("curl");
    curl.args(["-fsSL", "--max-filesize", "104857600"]);
    if url.starts_with("https://") {
        curl.args(["--proto", "=https", "--proto-redir", "=https"]);
    }
    let fetched = curl.arg("-o").arg(&archive).arg("--").arg(&url).status().is_ok_and(|s| s.success());
    if !fetched {
        std::fs::remove_file(&archive).ok();
        return Err(format!("could not download {}", url));
    }
    std::fs::create_dir_all(dest).map_err(|e| format!("cannot create {}: {}", dest.display(), e))?;
    // tar refuses absolute paths and `..` members by default (GNU and bsdtar)
    let unpacked = std::process::Command::new("tar").arg("-xzf").arg(&archive).arg("-C").arg(dest).arg("--no-same-owner").status().is_ok_and(|s| s.success());
    std::fs::remove_file(&archive).ok();
    if unpacked { Ok(()) } else { Err(format!("could not unpack {}", url)) }
}

fn add_cmd(args: &[String]) {
    if args.len() < 3 {
        eprintln!("Usage: foar add <name> --path <dir> | --git <url> | --version <ver> [--registry <url>]");
        exit(2);
    }
    let name = check_pkg_name(&args[0]);
    let (flag, val) = (args[1].as_str(), &args[2]);
    if val.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
        pkg_die(format!("invalid value {:?}", val));
    }
    let registry_arg = args.windows(2).find(|w| w[0] == "--registry").map(|w| w[1].as_str());
    let line = match flag {
        "--path" => format!("{} = {{ path = \"{}\" }}\n", name, val),
        "--git" => {
            let dest = std::path::Path::new("foar_packages").join(name);
            if !dest.exists() {
                std::fs::create_dir_all("foar_packages").ok();
                if !git_clone(check_git_url(val), &dest) {
                    pkg_die(format!("git clone {} failed", val));
                }
            }
            format!("{} = {{ git = \"{}\", path = \"foar_packages/{}\" }}\n", name, val, name)
        }
        "--version" => {
            let registry = check_registry(registry_arg);
            format!("{} = {{ version = \"{}\", registry = \"{}\" }}\n", name, check_version(val), registry)
        }
        _ => {
            eprintln!("Usage: foar add <name> --path <dir> | --git <url> | --version <ver> [--registry <url>]");
            exit(2);
        }
    };
    let mut content = std::fs::read_to_string("foar.toml").unwrap_or_else(|_| {
        "[package]\nname = \"foar-app\"\nversion = \"0.1.0\"\nentry = \"app.foar\"\n\n[dependencies]\n".to_string()
    });
    if !content.contains("[dependencies]") {
        content.push_str("\n[dependencies]\n");
    }
    if !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(&line);
    std::fs::write("foar.toml", content).unwrap_or_else(|e| {
        eprintln!("foar: cannot write foar.toml: {}", e);
        exit(1);
    });
    println!("✓ added dependency '{}' to foar.toml", name);
    if flag == "--path" || flag == "--git" {
        install_cmd(&[]);
    }
}

fn install_cmd(args: &[String]) {
    let frozen = args.iter().any(|a| a == "--frozen");
    let text = match std::fs::read_to_string("foar.toml") {
        Ok(s) => s,
        Err(_) => {
            eprintln!("foar: no foar.toml in current directory (run `foar init`)");
            exit(1);
        }
    };
    let manifest = foar::project::parse_manifest(&text);
    let existing_lock = std::fs::read_to_string("foar.lock").ok().map(|s| foar::project::parse_lockfile(&s));
    if frozen && existing_lock.is_none() {
        eprintln!("foar: --frozen requires an existing foar.lock");
        exit(1);
    }

    let mut locked = Vec::new();
    for (name, dep) in &manifest.dependencies {
        let name = &check_pkg_name(name).to_string();
        let (rel_path, source, version) = if let Some(p) = &dep.path {
            let clean = p.trim_start_matches("./").trim_end_matches('/').to_string();
            let src = dep
                .git
                .as_ref()
                .map(|g| format!("git+{}", g))
                .unwrap_or_else(|| format!("path:{}", p));
            let pkg_manifest = std::fs::read_to_string(std::path::Path::new(&clean).join("foar.toml"))
                .ok()
                .map(|s| foar::project::parse_manifest(&s));
            let ver = dep
                .version
                .clone()
                .or_else(|| pkg_manifest.map(|m| m.version).filter(|v| !v.is_empty()))
                .unwrap_or_else(|| "0.1.0".to_string());
            (clean, src, ver)
        } else if let Some(git) = &dep.git {
            let dest = format!("foar_packages/{}", name);
            if !std::path::Path::new(&dest).exists() {
                std::fs::create_dir_all("foar_packages").ok();
                if !git_clone(check_git_url(git), std::path::Path::new(&dest)) {
                    pkg_die(format!("git clone {} failed", git));
                }
            }
            (dest, format!("git+{}", git), dep.version.clone().unwrap_or_else(|| "0.1.0".to_string()))
        } else {
            let ver = check_version(dep.version.as_deref().unwrap_or("latest")).to_string();
            let reg = check_registry(dep.registry.as_deref());
            let dest = format!("foar_packages/{}", name);
            if !std::path::Path::new(&dest).exists() {
                if let Err(e) = fetch_registry_package(&reg, name, &ver, std::path::Path::new(&dest)) {
                    std::fs::remove_dir_all(&dest).ok();
                    pkg_die(format!("@{} ({}): {}", name, ver, e));
                }
            }
            (dest, format!("registry+{}", reg), ver)
        };

        let integrity = match foar::project::hash_package_dir(std::path::Path::new(&rel_path)) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("foar: cannot hash @{}: {}", name, e);
                exit(1);
            }
        };

        if frozen {
            if let Some(lock) = &existing_lock {
                let found = lock.packages.iter().find(|p| p.name == *name);
                match found {
                    Some(prev) if prev.integrity == integrity => {}
                    Some(prev) => {
                        eprintln!("foar: frozen lockfile mismatch for @{}: expected {}, got {}", name, prev.integrity, integrity);
                        exit(1);
                    }
                    None => {
                        eprintln!("foar: @{} is missing from foar.lock (run `foar install` without --frozen)", name);
                        exit(1);
                    }
                }
            }
        }

        locked.push(foar::project::LockedPackage {
            name: name.clone(),
            version,
            source,
            path: rel_path,
            integrity,
        });
    }

    let lock = foar::project::Lockfile { version: 1, packages: locked };
    if !frozen {
        let rendered = foar::project::render_lockfile(&lock);
        std::fs::write("foar.lock", rendered).unwrap_or_else(|e| {
            eprintln!("foar: cannot write foar.lock: {}", e);
            exit(1);
        });
    }
    println!(
        "✓ {} {} package(s) in foar.lock",
        if frozen { "verified" } else { "locked" },
        lock.packages.len()
    );
}

fn pkg_cmd(args: &[String]) {
    let verify = args.iter().any(|a| a == "--verify");
    let text = match std::fs::read_to_string("foar.toml") {
        Ok(s) => s,
        Err(_) => {
            eprintln!("foar: no foar.toml in current directory (run `foar init`)");
            exit(1);
        }
    };
    let m = foar::project::parse_manifest(&text);
    let lock = std::fs::read_to_string("foar.lock").ok().map(|s| foar::project::parse_lockfile(&s));
    if verify {
        let Some(l) = lock else {
            eprintln!("foar: no foar.lock found (run `foar install` first)");
            exit(1);
        };
        match foar::project::verify_lockfile(std::path::Path::new("."), &l) {
            Ok(ok) => {
                for line in ok {
                    println!("✓ {}", line);
                }
                println!("✓ foar.lock integrity verified ({} package(s))", l.packages.len());
                return;
            }
            Err(errs) => {
                for e in errs {
                    eprintln!("✗ {}", e);
                }
                exit(1);
            }
        }
    }
    println!("{} {} (entry: {})", m.name, m.version, m.entry);
    if m.dependencies.is_empty() {
        println!("  (no dependencies)");
        return;
    }
    for (name, dep) in &m.dependencies {
        let loc = dep
            .path
            .as_deref()
            .or(dep.git.as_deref())
            .or(dep.version.as_deref())
            .unwrap_or("foar_packages/");
        let hash = lock
            .as_ref()
            .and_then(|l| l.packages.iter().find(|p| p.name == *name))
            .map(|p| format!(" [{}]", &p.integrity[..19.min(p.integrity.len())]))
            .unwrap_or_default();
        println!("  @{} -> {}{}", name, loc, hash);
    }
}

fn fmt_cmd(args: &[String]) {
    let mut check = false;
    let mut files = Vec::new();
    for a in args {
        if a == "--check" {
            check = true;
        } else {
            files.push(a.as_str());
        }
    }
    if files.is_empty() {
        eprintln!("Usage: foar fmt <files...> [--check]");
        exit(2);
    }
    let mut unformatted = 0usize;
    for path in files {
        let src = read_source(path);
        let formatted = foar::fmt::format_source(&src);
        if path == "-" {
            print!("{}", formatted);
            continue;
        }
        if formatted != src {
            if check {
                eprintln!("✗ {} needs formatting", path);
                unformatted += 1;
            } else {
                std::fs::write(path, formatted).unwrap_or_else(|e| {
                    eprintln!("foar: cannot write {}: {}", path, e);
                    exit(1);
                });
                println!("✓ formatted {}", path);
            }
        } else if !check {
            println!("✓ {} (already formatted)", path);
        }
    }
    if check && unformatted > 0 {
        exit(1);
    }
}
