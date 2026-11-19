//! foar CLI
//!   foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]
//!   foar check <file.foar>
use std::io::{Read, Write};
use std::process::exit;

fn usage() -> ! {
    eprintln!(
        "foar {}\n\nUsage:\n  foar build <file.foar | -> [-o <out>] [--format json|js] [--pretty] [--runtime <path>]\n  foar check <file.foar>\n\n  --format json   program JSON for createFoarRuntime (default)\n  --format js     ES module exporting {{ program, mount }}\n  --runtime       import path of foar-runtime.js in the JS module (default ./foar-runtime.js)\n  -               read source from stdin",
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
    let mut input = None;
    let mut out = None;
    let mut format = "json".to_string();
    let mut pretty = false;
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
            a if input.is_none() => input = Some(a.to_string()),
            a => {
                eprintln!("foar: unexpected argument {}", a);
                usage()
            }
        }
        i += 1;
    }
    let input = input.unwrap_or_else(|| usage());
    let src = read_source(&input);

    match cmd {
        "check" => match foar::compile(&src) {
            Ok(p) => println!("✓ {}: {} view(s), {} data type(s), {} bytes of CSS", input, p.views.len(), p.data_decls.len(), p.css.len()),
            Err(e) => {
                eprintln!("{}:{}", input, e);
                exit(1)
            }
        },
        "build" => {
            let result = match format.as_str() {
                "json" => match foar::compile(&src) {
                    Ok(p) => Ok(if pretty { serde_json::to_string_pretty(&p).unwrap() } else { serde_json::to_string(&p).unwrap() }),
                    Err(e) => Err(e),
                },
                "js" => foar::compile_to_js_module(&src, &runtime),
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
                    eprintln!("{}:{}", input, e);
                    exit(1)
                }
            }
        }
        _ => usage(),
    }
}
