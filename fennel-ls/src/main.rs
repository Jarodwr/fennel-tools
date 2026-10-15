mod analyzer;
mod config;
mod lua_to_fennel;
mod docs;
mod expander;
mod fmt;
mod hooks;
mod lexer;
mod parser;
mod server;
mod text;
mod workspace;

use clap::{Parser, Subcommand};
use tower_lsp::{LspService, Server};

#[derive(Parser)]
#[command(name = "fennel-ls", version, about = "Language server for Fennel")]
struct Cli {
    /// Disable textDocument/formatting support.
    #[arg(long)]
    no_formatting: bool,

    /// Write logs to this file (defaults to stderr). Useful for debugging
    /// since stdout is used for the LSP transport.
    #[arg(long)]
    log_file: Option<std::path::PathBuf>,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the LSP server (default when no subcommand given)
    Server,
    /// Check files for errors and print diagnostics
    Check { files: Vec<std::path::PathBuf> },
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();

    // `check` prints diagnostics on stdout; keep the server's info logs out of it
    let default_level = if matches!(cli.command, Some(Command::Check { .. })) { "warn" } else { "info" };
    let mut builder = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or(default_level),
    );
    if let Some(ref log_path) = cli.log_file {
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
            .expect("failed to open log file");
        builder.target(env_logger::Target::Pipe(Box::new(file)));
    }
    builder.init();

    log::info!("fennel-ls {} starting", env!("CARGO_PKG_VERSION"));

    let formatting_enabled = !cli.no_formatting;

    match cli.command.unwrap_or(Command::Server) {
        Command::Server => run_server(formatting_enabled).await,
        Command::Check { files } => run_check(files).await,
    }
}

async fn run_server(formatting_enabled: bool) {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();

    let (service, socket) = LspService::new(move |client| server::Backend::new(client, formatting_enabled));
    Server::new(stdin, stdout, socket).serve(service).await;
}

/// The `.lsp.fnl` settings `check` applies, as the server does for its workspace
struct CheckConfig {
    builtins: docs::BuiltinSet,
    extra_globals: std::collections::HashSet<String>,
    global_macros: std::collections::HashMap<String, String>,
    hooks: Option<hooks::HookRunner>,
}

impl CheckConfig {
    /// From the nearest `.lsp.fnl` in `dir` or its ancestors (defaults if none)
    fn find(dir: &std::path::Path) -> Self {
        let root = dir.ancestors().find(|d| d.join(".lsp.fnl").is_file());
        let config = root.map(config::Config::load).unwrap_or_default();
        let platform = config.platform.as_deref().and_then(server::platform_from_str);
        let mut extra_globals: std::collections::HashSet<String> =
            config.known_globals.unwrap_or_default().into_iter().collect();
        if let Some(docs) = &config.global_docs {
            for key in docs.keys() {
                if let Some(root_name) = key.split(['.', ':']).find(|s| !s.is_empty()) {
                    extra_globals.insert(root_name.to_string());
                }
            }
        }
        let global_macros = config.global_macros.unwrap_or_default()
            .into_iter()
            .map(|name| (name, String::new()))
            .collect();
        let hooks = root.and_then(|root| {
            let src = std::fs::read_to_string(root.join(".lsp.fnl")).ok()?;
            let runner = hooks::HookRunner::new();
            runner.try_set_source(src, root.to_string_lossy().into_owned());
            Some(runner)
        });
        Self {
            builtins: docs::BuiltinSet::for_platform(platform.unwrap_or(docs::Platform::Lua54)),
            extra_globals,
            global_macros,
            hooks,
        }
    }
}

async fn run_check(files: Vec<std::path::PathBuf>) {
    let mut had_errors = false;
    let mut configs: std::collections::HashMap<std::path::PathBuf, std::sync::Arc<CheckConfig>> =
        std::collections::HashMap::new();

    for path in &files {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("{}: {}", path.display(), e);
                had_errors = true;
                continue;
            }
        };
        let dir = std::fs::canonicalize(path).ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        let config = configs.entry(dir.clone())
            .or_insert_with(|| std::sync::Arc::new(CheckConfig::find(&dir)))
            .clone();

        let (ast, parse_errors) = parser::Parser::parse(&text);
        // Two passes, as the server runs them: the first finds macro calls,
        // the second analyzes them with their hooks' instructions
        let no_hooks = std::collections::HashMap::new();
        let mut analysis = analyzer::analyze_with_hooks(&ast, &no_hooks, &config.global_macros);
        if let Some(runner) = &config.hooks {
            let mut results = std::collections::HashMap::new();
            for (span_start, source_module, macro_name) in &analysis.macro_calls {
                let Some(call) = workspace::find_list_at(&ast, *span_start) else { continue };
                let module = source_module.as_deref().unwrap_or("");
                if let Some(instructions) = runner.run_hook(module, macro_name, hooks::SerialNode::from_ast(call)).await {
                    results.insert(*span_start, instructions);
                }
            }
            if !results.is_empty() {
                analysis = analyzer::analyze_with_hooks(&ast, &results, &config.global_macros);
            }
        }

        for err in &parse_errors {
            println!(
                "{}:{}:{}: error: {}",
                path.display(),
                err.span.line + 1,
                err.span.col + 1,
                err.message
            );
            had_errors = true;
        }

        let mut diagnostics: Vec<(u32, u32, String)> = Vec::new();
        for sym in &analysis.syms {
            if sym.is_def {
                continue;
            }
            if sym.def_byte.is_none() && !sym.in_macro && !config.builtins.is_known(&sym.name) {
                let root = sym.name.split(['.', ':']).find(|s| !s.is_empty()).unwrap_or(&sym.name);
                if !server::known_global(root) && !config.extra_globals.contains(root) {
                    diagnostics.push((sym.span.line, sym.span.col, format!("unknown identifier `{}`", sym.name)));
                }
            }
        }
        for warning in &analysis.warnings {
            diagnostics.push((warning.span.line, warning.span.col, warning.message.clone()));
        }
        diagnostics.sort();
        for (line, col, message) in diagnostics {
            println!("{}:{}:{}: warning: {}", path.display(), line + 1, col + 1, message);
        }
    }

    if had_errors {
        std::process::exit(1);
    }
}
