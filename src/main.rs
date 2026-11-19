//! foar CLI
//!   foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]
//!   foar build - --project      (stdin: {"entry", "files": {path: source}})
//!   foar check <file.foar>
//!   foar i18n <locales-dir> <source files...> [--fallback en] [--format json]
use std::io::{Read, Write};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "foar {}\n\nUsage:\n  foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]\n  foar check <file.foar>\n  foar i18n <locales-dir> <source files...> [--fallback en] [--format json]\n\n  --format json   program JSON for createFoarRuntime (default)\n  --format js     ES module exporting {{ program, mount }}\n  --runtime       import path of foar-runtime.js in the JS module (default ./foar-runtime.js)\n  -               read source from stdin\n  --project       with -: stdin is a project {{\"entry\", \"files\": {{path: source}}}}\n\nA file is compiled together with the files it imports (import \"./components/Row\").",
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
    if cmd == "i18n" {
        i18n_cmd(&args[1..]);
        return;
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
            Ok(p) => println!("✓ {}: {} view(s), {} data type(s), {} bytes of CSS", input, p.views.len(), p.data_decls.len(), p.css.len()),
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
