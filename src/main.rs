//! foar CLI
//!   foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]
//!   foar build - --project      (stdin: {"entry", "files": {path: source}})
//!   foar check <file.foar>
//!   foar i18n <locales-dir> <source files...> [--fallback en] [--format json]
use std::io::{Read, Write};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "foar {}\n\nUsage:\n  foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]\n  foar check <file.foar>\n  foar init [dir]\n  foar add <name> --path <dir> | --git <url> | --version <ver> [--registry <url>]\n  foar install [--frozen]\n  foar pkg [--verify]\n  foar lsp\n  foar i18n <locales-dir> <source files...> [--fallback en] [--format json]\n\n  --format json   program JSON for createFoarRuntime (default)\n  --format js     ES module exporting {{ program, mount, hydrate, renderToString, renderToStringAsync, renderToStream, createI18n }}\n  --runtime       import path of foar-runtime.js in the JS module (default ./foar-runtime.js)\n  -               read source from stdin\n  --project       with -: stdin is a project {{\"entry\", \"files\": {{path: source}}}}\n\nA file is compiled together with its imports (relative paths or @package via foar.toml).",
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
                        std::fs::write(&path, text).unwrap_or_else(|e| {
                            eprintln!("foar: cannot write {}: {}", path, e);
                            exit(1)
                        });
                        eprintln!("✓ wrote {}", path);
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
    println!("✓ initialized FOAR project in {}", dir.display());
}

fn add_cmd(args: &[String]) {
    if args.len() < 3 {
        eprintln!("Usage: foar add <name> --path <dir> | --git <url> | --version <ver> [--registry <url>]");
        exit(2);
    }
    let name = &args[0];
    let (flag, val) = (args[1].as_str(), &args[2]);
    let registry = args
        .windows(2)
        .find(|w| w[0] == "--registry")
        .map(|w| w[1].as_str())
        .unwrap_or("https://registry.foar-lang.org");
    let line = match flag {
        "--path" => format!("{} = {{ path = \"{}\" }}\n", name, val),
        "--git" => {
            let dest = std::path::Path::new("foar_packages").join(name);
            if !dest.exists() {
                std::fs::create_dir_all("foar_packages").ok();
                let status = std::process::Command::new("git")
                    .args(["clone", "--depth", "1", val, &dest.to_string_lossy()])
                    .status();
                match status {
                    Ok(s) if s.success() => {}
                    _ => {
                        eprintln!("foar: git clone {} failed", val);
                        exit(1);
                    }
                }
            }
            format!("{} = {{ git = \"{}\", path = \"foar_packages/{}\" }}\n", name, val, name)
        }
        "--version" => {
            format!("{} = {{ version = \"{}\", registry = \"{}\" }}\n", name, val, registry)
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
                let status = std::process::Command::new("git")
                    .args(["clone", "--depth", "1", git, &dest])
                    .status();
                match status {
                    Ok(s) if s.success() => {}
                    _ => {
                        eprintln!("foar: git clone {} failed", git);
                        exit(1);
                    }
                }
            }
            (dest, format!("git+{}", git), dep.version.clone().unwrap_or_else(|| "0.1.0".to_string()))
        } else {
            let ver = dep.version.clone().unwrap_or_else(|| "latest".to_string());
            let reg = dep.registry.as_deref().unwrap_or("https://registry.foar-lang.org").trim_end_matches('/');
            let dest = format!("foar_packages/{}", name);
            if !std::path::Path::new(&dest).exists() {
                let url = format!("{}/packages/{}/{}.tar.gz", reg, name, ver.trim_start_matches('^'));
                std::fs::create_dir_all(&dest).ok();
                let status = std::process::Command::new("sh")
                    .args(["-c", &format!("curl -fsSL {} | tar -xz -C {}", url, dest)])
                    .status();
                match status {
                    Ok(s) if s.success() => {}
                    _ => {
                        eprintln!("foar: failed to fetch @{} ({}) from {}", name, ver, url);
                        exit(1);
                    }
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
