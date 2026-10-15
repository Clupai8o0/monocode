//! Fork feature: compile a `.tex` file for the side-by-side LaTeX preview.
//!
//! Runs pdflatex, xelatex or lualatex from MacTeX directly, never latexmk: a
//! project's `.latexmkrc` is Perl that would run on every save of a file an
//! agent may have written. Shell escape is off, TeX may only write inside the
//! working folder and the output folder (`openout_any=p`), and the output goes
//! to a cache folder so the project is not littered with `.aux` and `.log`.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;

use crate::dirs_home;
use crate::fork_statusline::{exited_by, kill_group};

const TEXBIN: &str = "/Library/TeX/texbin";
const RUN_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ENGINE_RUNS: usize = 3;
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ISSUES: usize = 50;
const ENGINES: [&str; 3] = ["pdflatex", "xelatex", "lualatex"];

/// One compile at a time: two saves in a row must not share an output folder.
static COMPILING: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LatexIssue {
    file: Option<String>,
    line: Option<u32>,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatexResult {
    /// "ok", "errors", "no-tex" (MacTeX missing) or "not-root" (no \documentclass).
    status: &'static str,
    pdf: Option<String>,
    root: String,
    engine: String,
    errors: Vec<LatexIssue>,
    warnings: u32,
    notes: Vec<String>,
    log_tail: String,
    millis: u64,
}

#[tauri::command]
pub async fn fork_latex_compile(path: String, cwd: String) -> Result<LatexResult, String> {
    tauri::async_runtime::spawn_blocking(move || compile(Path::new(&path), Path::new(&cwd)))
        .await
        .map_err(|e| e.to_string())?
}

/// `cwd` is the project folder: a `% !TEX root` may not point outside it.
fn compile(path: &Path, cwd: &Path) -> Result<LatexResult, String> {
    let started = Instant::now();
    if !path.is_absolute() || !is_tex(path) || !path.is_file() {
        return Err("Not a .tex file".into());
    }
    let path = &path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))?;
    let source = read_text(path, MAX_SOURCE_BYTES)?;
    let dir = path.parent().unwrap_or(Path::new("/"));
    let root = match magic(&source, "root") {
        Some(value) => {
            let root = dir.join(value);
            let root = root.canonicalize().map_err(|_| {
                format!("% !TEX root points at {}, which does not exist.", root.display())
            })?;
            if !is_tex(&root) || !root.is_file() {
                return Err("% !TEX root must name a .tex file.".into());
            }
            let project = cwd.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            if !root.starts_with(&project) {
                return Err("% !TEX root must stay inside the project folder.".into());
            }
            root
        }
        None => path.to_path_buf(),
    };
    let root_source = if root == *path { source } else { read_text(&root, MAX_SOURCE_BYTES)? };
    let engine = choose_engine(&root_source);
    let mut result = LatexResult {
        status: "ok",
        pdf: None,
        root: root.to_string_lossy().into_owned(),
        engine: engine.to_string(),
        errors: Vec::new(),
        warnings: 0,
        notes: Vec::new(),
        log_tail: String::new(),
        millis: 0,
    };
    if !root_source.contains("\\documentclass") && !root_source.contains("\\documentstyle") {
        result.status = "not-root";
        return Ok(result);
    }
    let binary = Path::new(TEXBIN).join(engine);
    if !binary.is_file() {
        result.status = "no-tex";
        return Ok(result);
    }

    let root_dir = root.parent().unwrap_or(Path::new("/")).to_path_buf();
    let stem = root.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let out = output_dir(&root)?;
    mirror_dirs(&root_dir, &out, 0);

    let _guard = COMPILING.lock().unwrap_or_else(|poison| poison.into_inner());
    let since = SystemTime::now();
    let file_name = root.file_name().map(|s| s.to_os_string()).unwrap_or_default();
    let out_flag = format!("-output-directory={}", out.display());
    let aux = out.join(format!("{stem}.aux"));
    let mut log = String::new();
    let mut ran_bibtex = false;

    for run in 0..MAX_ENGINE_RUNS {
        let mut cmd = Command::new(&binary);
        cmd.args([
            "-interaction=nonstopmode",
            "-file-line-error",
            "-no-shell-escape",
            "-synctex=1",
            &out_flag,
        ])
        .arg(&file_name);
        if !run_tool(cmd, &root_dir, &out)? {
            result.notes.push(format!("{engine} took over {} s and was stopped.", RUN_TIMEOUT.as_secs()));
            break;
        }
        log = read_prefix(&out.join(format!("{stem}.log")), MAX_LOG_BYTES).unwrap_or_default();
        if fatal(&log) {
            break;
        }
        let mut again = needs_rerun(&log);
        if run == 0 && !ran_bibtex && read_prefix(&aux, MAX_LOG_BYTES).is_ok_and(|a| a.contains("\\bibdata")) {
            let bibtex = Path::new(TEXBIN).join("bibtex");
            if bibtex.is_file() {
                let mut cmd = Command::new(bibtex);
                cmd.arg(out.join(&stem));
                ran_bibtex = true;
                again = run_tool(cmd, &root_dir, &out)? || again;
            }
        }
        if run == 0 && out.join(format!("{stem}.bcf")).is_file() && !Path::new(TEXBIN).join("biber").is_file() {
            result.notes.push("biber is not installed, so biblatex citations show as ?.".into());
        }
        if !again {
            break;
        }
    }

    let (errors, warnings) = parse_log(&log, &root_dir);
    result.errors = errors;
    result.warnings = warnings;
    let pdf = out.join(format!("{stem}.pdf"));
    let fresh = std::fs::metadata(&pdf)
        .and_then(|m| m.modified())
        .is_ok_and(|modified| modified >= since);
    if fresh {
        result.pdf = Some(pdf.to_string_lossy().into_owned());
    }
    if !result.errors.is_empty() || !fresh {
        result.status = "errors";
        if result.errors.is_empty() {
            result.log_tail = tail(&log, 30);
        }
    }
    result.millis = started.elapsed().as_millis() as u64;
    Ok(result)
}

fn is_tex(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tex"))
}

/// The first `limit` bytes; enough for logs, which can grow without bound.
fn read_prefix(path: &Path, limit: u64) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whole file or an error: a cut-off source would build a misleading PDF.
fn read_text(path: &Path, limit: u64) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{} is over {} MB.", path.display(), limit >> 20));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// `% !TEX root = main.tex` / `% !TeX program = xelatex`, in the first 20 lines.
fn magic(source: &str, key: &str) -> Option<String> {
    source.lines().take(20).find_map(|line| {
        let rest = line.trim_start().strip_prefix('%')?.trim_start();
        let rest = rest.strip_prefix('!')?.trim_start();
        let (word, rest) = rest.split_once(char::is_whitespace)?;
        if !word.eq_ignore_ascii_case("tex") {
            return None;
        }
        let (name, value) = rest.split_once('=')?;
        let name = name.trim();
        let name = name.strip_prefix("TS-").unwrap_or(name);
        (name.eq_ignore_ascii_case(key) && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

fn choose_engine(source: &str) -> &'static str {
    if let Some(program) = magic(source, "program") {
        let program = program.to_ascii_lowercase();
        if let Some(engine) = ENGINES.iter().find(|engine| **engine == program) {
            return engine;
        }
    }
    let needs_unicode = ["{fontspec}", "{unicode-math}", "{polyglossia}", "{xeCJK}"]
        .iter()
        .any(|package| source.contains(package));
    if needs_unicode { "xelatex" } else { "pdflatex" }
}

fn output_dir(root: &Path) -> Result<PathBuf, String> {
    let home = dirs_home().ok_or("No home folder")?;
    let mut hasher = DefaultHasher::new();
    root.hash(&mut hasher);
    let dir = PathBuf::from(home)
        .join("Library/Caches/monocode-fork/latex")
        .join(format!("{:016x}", hasher.finish()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    Ok(dir)
}

/// `\include{chapters/one}` writes `chapters/one.aux` under the output
/// folder, which TeX will not create; make the project's folders there.
fn mirror_dirs(from: &Path, to: &Path, depth: usize) {
    if depth >= 3 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    for entry in entries.flatten().take(200) {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if name_str.starts_with('.') || name_str == "node_modules" || name_str == "target" {
            continue;
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            let target = to.join(&name);
            let _ = std::fs::create_dir_all(&target);
            mirror_dirs(&entry.path(), &target, depth + 1);
        }
    }
}

/// Runs a TeX tool; false when it ran past the timeout and was stopped.
fn run_tool(mut cmd: Command, cwd: &Path, out: &Path) -> Result<bool, String> {
    cmd.current_dir(cwd)
        .env("PATH", format!("{TEXBIN}:/usr/bin:/bin"))
        .env("TEXMFOUTPUT", out)
        .env("openout_any", "p")
        .env("shell_escape", "f")
        .env("max_print_line", "10000")
        .env("error_line", "254")
        .env("half_error_line", "238")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("LaTeX failed to start: {e}"))?;
    if !exited_by(&mut child, Instant::now() + RUN_TIMEOUT) {
        kill_group(&mut child);
        let _ = child.wait();
        return Ok(false);
    }
    Ok(true)
}

fn fatal(log: &str) -> bool {
    log.contains("Fatal error occurred") || log.contains("! Emergency stop")
}

fn needs_rerun(log: &str) -> bool {
    log.contains("Rerun to get")
        || log.contains("Label(s) may have changed")
        || log.contains("Rerun LaTeX")
}

/// `./ch/one.tex:12: Undefined control sequence.` → (file, 12, message).
fn file_line_error(line: &str) -> Option<(&str, u32, &str)> {
    let mut search = 0;
    while let Some(found) = line[search..].find(':') {
        let colon = search + found;
        let rest = &line[colon + 1..];
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(": ") {
            let file = &line[..colon];
            let known = [".tex", ".sty", ".cls", ".ltx", ".bib", ".def", ".cfg", ".clo", ".dtx", ".bbl"];
            if known.iter().any(|ext| file.to_ascii_lowercase().ends_with(ext)) {
                let number = rest[..digits].parse().ok()?;
                return Some((file, number, &rest[digits + 2..]));
            }
        }
        search = colon + 1;
    }
    None
}

fn parse_log(log: &str, root_dir: &Path) -> (Vec<LatexIssue>, u32) {
    let lines: Vec<&str> = log.lines().collect();
    let mut errors = Vec::new();
    let mut warnings = 0;
    let mut bang = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if line.contains("Warning:") {
            warnings += 1;
        }
        if let Some((file, number, message)) = file_line_error(line) {
            let file = file.strip_prefix("./").unwrap_or(file);
            let path = root_dir.join(file);
            let mut message = message.trim().to_string();
            // TeX shows the text it choked on as `l.12 \foo` a few lines on.
            if let Some(context) = lines[index + 1..]
                .iter()
                .take(8)
                .find_map(|next| next.strip_prefix(&format!("l.{number} ")))
            {
                message.push_str(" — ");
                message.push_str(context.trim());
            }
            if errors.len() < MAX_ISSUES {
                errors.push(LatexIssue {
                    file: Some(path.to_string_lossy().into_owned()),
                    line: Some(number),
                    message,
                });
            }
        } else if let Some(message) = line.strip_prefix("! ") {
            if !message.starts_with("Emergency stop") && bang.len() < MAX_ISSUES {
                bang.push(LatexIssue { file: None, line: None, message: message.trim().to_string() });
            }
        }
    }
    if errors.is_empty() {
        errors = bang;
    }
    (errors, warnings)
}

fn tail(log: &str, count: usize) -> String {
    let lines: Vec<&str> = log.lines().collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_magic_comments() {
        let source = "% !TEX root = ../main.tex\n%!TeX program=xelatex\n\\section{x}";
        assert_eq!(magic(source, "root").as_deref(), Some("../main.tex"));
        assert_eq!(magic(source, "program").as_deref(), Some("xelatex"));
        assert_eq!(magic("% !TEX TS-program = lualatex", "program").as_deref(), Some("lualatex"));
        assert_eq!(magic("% just a comment = x", "root"), None);
        assert_eq!(magic("% !TEX root =", "root"), None);
    }

    #[test]
    fn picks_the_engine() {
        assert_eq!(choose_engine("\\documentclass{article}"), "pdflatex");
        assert_eq!(choose_engine("\\usepackage{fontspec}"), "xelatex");
        assert_eq!(choose_engine("% !TEX program = lualatex\n\\usepackage{fontspec}"), "lualatex");
        // Only the three engines; anything else falls back to detection.
        assert_eq!(choose_engine("% !TEX program = sh -c evil"), "pdflatex");
    }

    #[test]
    fn parses_errors_with_context_and_counts_warnings() {
        let log = "\
(./main.tex
LaTeX Warning: Reference `x' on page 1 undefined on input line 5.
./main.tex:12: Undefined control sequence.
l.12 \\foo
          bar
./ch/one.tex:3: LaTeX Error: File `nope.sty' not found.
! Emergency stop.
Package hyperref Warning: Token not allowed.
";
        let (errors, warnings) = parse_log(log, Path::new("/w"));
        assert_eq!(warnings, 2);
        assert_eq!(
            errors,
            vec![
                LatexIssue {
                    file: Some("/w/main.tex".into()),
                    line: Some(12),
                    message: "Undefined control sequence. — \\foo".into(),
                },
                LatexIssue {
                    file: Some("/w/ch/one.tex".into()),
                    line: Some(3),
                    message: "LaTeX Error: File `nope.sty' not found.".into(),
                },
            ]
        );
    }

    #[test]
    fn falls_back_to_bang_lines() {
        let (errors, _) = parse_log("! I can't find file `x'.\n! Emergency stop.\n", Path::new("/w"));
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].message, "I can't find file `x'.");
        assert_eq!(errors[0].file, None);
    }

    #[test]
    fn ignores_colons_that_are_not_file_lines() {
        assert_eq!(file_line_error("Note: 12: nothing"), None);
        assert_eq!(file_line_error("C:/x.tex:7: Bad"), Some(("C:/x.tex", 7, "Bad")));
    }

    #[test]
    fn keeps_the_root_inside_the_project_and_rejects_huge_files() {
        let base = std::env::temp_dir().join(format!("fork-latex-guard-{}", std::process::id()));
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(base.join("outside.tex"), "\\documentclass{article}").unwrap();
        let part = project.join("part.tex");
        std::fs::write(&part, "% !TEX root = ../outside.tex\n").unwrap();
        let err = compile(&part, &project).unwrap_err();
        assert!(err.contains("inside the project"), "{err}");

        let big = project.join("big.tex");
        std::fs::write(&big, vec![b'%'; (MAX_SOURCE_BYTES + 1) as usize]).unwrap();
        assert!(read_text(&big, MAX_SOURCE_BYTES).is_err());
        assert_eq!(read_prefix(&big, 10).unwrap().len(), 10);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn compiles_a_document_when_mactex_is_installed() {
        if !Path::new(TEXBIN).join("pdflatex").is_file() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("fork-latex-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("ch")).unwrap();
        let main = dir.join("main.tex");
        std::fs::write(&main, "\\documentclass{article}\n\\begin{document}\nHi \\ref{a}.\n\\include{ch/one}\n\\end{document}\n").unwrap();
        std::fs::write(dir.join("ch/one.tex"), "% !TEX root = ../main.tex\n\\section{One}\\label{a}\n").unwrap();

        let ok = compile(&dir.join("ch/one.tex"), &dir).unwrap();
        assert_eq!(ok.status, "ok", "{ok:?}");
        assert!(ok.root.ends_with("main.tex"));
        assert!(Path::new(ok.pdf.as_deref().unwrap()).is_file());
        assert!(!dir.join("main.aux").exists(), "output must go to the cache folder");

        std::fs::write(&main, "\\documentclass{article}\n\\begin{document}\n\\nosuchmacro\n\\end{document}\n").unwrap();
        let bad = compile(&main, &dir).unwrap();
        assert_eq!(bad.status, "errors");
        assert_eq!(bad.errors[0].line, Some(3));
        assert!(bad.errors[0].message.starts_with("Undefined control sequence"));

        std::fs::write(&main, "\\section{no class}").unwrap();
        assert_eq!(compile(&main, &dir).unwrap().status, "not-root");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(output_dir(&main.canonicalize().unwrap_or(main)).unwrap());
    }
}
