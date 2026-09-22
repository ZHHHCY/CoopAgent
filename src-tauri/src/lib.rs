mod projects;
use projects::ProjectToken;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::Cell,
    collections::HashMap,
    fs,
    fs::OpenOptions,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, Manager, State};

#[cfg(all(feature = "agent-test", debug_assertions))]
mod agent_test_api;
#[cfg(all(feature = "agent-test", debug_assertions))]
pub use agent_test_api::{run_agent_test_stdio, run_agent_test_desktop};

#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    if text.is_empty() || text.len() > 4096 {
        return Err("Clipboard text must contain between 1 and 4096 bytes.".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = Command::new("pbcopy");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("clip.exe");
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("wl-copy");
        command.arg("--type").arg("text/plain");
        command
    };

    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to open the system clipboard: {error}"))?;
    child
        .stdin
        .take()
        .ok_or_else(|| "System clipboard input is unavailable.".to_string())?
        .write_all(text.as_bytes())
        .map_err(|error| format!("Unable to write to the system clipboard: {error}"))?;
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Unable to finish clipboard copy: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if error.is_empty() {
            "The system clipboard command failed.".to_string()
        } else {
            error
        })
    }
}

fn project_root() -> Result<PathBuf, String> {
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve the project root.".to_string())?;
    // Debug-only desktop regression uses the same backend against a marked
    // copy. Reject arbitrary roots; release builds never honor this override.
    #[cfg(debug_assertions)]
    if let Some(candidate) = std::env::var_os("COOPAGENT_TEST_PROJECT_ROOT") {
        return regression_project_root(&source, Path::new(&candidate));
    }
    // A locally built desktop stays inside its checkout. Resolve from the exe
    // so moving/copying that checkout cannot send writes to the build machine's path.
    if let Ok(executable) = std::env::current_exe() {
        if let Some(root) = application_root_from_executable(&executable) { return Ok(root); }
    }
    if cfg!(debug_assertions) { return Ok(source); }
    Err("请将桌面程序保留在 CoopAgent 仓库中，并通过 start.cmd 启动。".into())
}

fn application_root_from_executable(executable: &Path) -> Option<PathBuf> {
    executable.parent()?.ancestors().find(|root| {
        root.join("src-tauri/tauri.conf.json").is_file()
            && root.join("runtime/coop-mcp/server.mjs").is_file()
            && root.join("opencode.json").is_file()
    }).map(Path::to_path_buf)
}

#[tauri::command]
fn open_log_directory(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let directory = project_root()?.join(".coopagent/logs");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    app.opener().open_path(display_path(&directory), None::<&str>).map_err(|error| error.to_string())
}

#[cfg(debug_assertions)]
fn regression_project_root(source: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let allowed = fs::canonicalize(source.join(".tools/agent-regressions")).map_err(|error| error.to_string())?;
    let resolved = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !candidate.is_absolute() || !resolved.starts_with(&allowed) || candidate.file_name().is_none_or(|name| name != "project") {
        return Err("Desktop regression requires a marked isolated project".into());
    }
    let fixture: Value = serde_json::from_slice(&fs::read(candidate.parent().unwrap().join("fixture.json"))
        .map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
    if fixture.get("root").and_then(Value::as_str).map(Path::new) != Some(candidate)
        || fixture.get("source").and_then(Value::as_str).map(Path::new) != Some(source) {
        return Err("Desktop regression fixture identity mismatch".into());
    }
    Ok(candidate.to_path_buf())
}

fn opencode_path(project_root: &std::path::Path) -> Result<PathBuf, String> {
    let executable = if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    };
    let path = project_root.join(".tools/opencode/bin").join(executable);
    if path.is_file() {
        Ok(path)
    } else {
        Err(
            "OpenCode is missing. Run scripts/bootstrap.cmd on Windows or ./scripts/bootstrap on macOS."
                .to_string(),
        )
    }
}

fn node_path(project_root: &Path) -> Result<PathBuf, String> {
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let base = if cfg!(windows) {
        project_root.join(".tools/node")
    } else {
        project_root.join(".tools/node/bin")
    };
    let path = base.join(executable);
    if path.is_file() {
        Ok(path)
    } else {
        Err("Bundled Node.js is missing. Run the CoopAgent bootstrap script.".to_string())
    }
}

fn runtime_path(project_root: &std::path::Path) -> Result<std::ffi::OsString, String> {
    let node_bin = if cfg!(windows) {
        project_root.join(".tools/node")
    } else {
        project_root.join(".tools/node/bin")
    };
    let current_path = std::env::var_os("PATH").unwrap_or_default();
    std::env::join_paths(std::iter::once(node_bin).chain(std::env::split_paths(&current_path)))
        .map_err(|error| format!("Unable to prepare the runtime PATH: {error}"))
}

fn user_home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve the user home directory.".to_string())
}

fn model_config_path() -> Result<PathBuf, String> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| user_home().ok().map(|home| home.join(".config")))
    }
    .ok_or_else(|| "Unable to resolve the user configuration directory.".to_string())?;
    Ok(base.join("CoopAgent").join("opencode-models.json"))
}

fn coopagent_config_root() -> Result<PathBuf, String> {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| user_home().ok().map(|home| home.join(".config")))
    }
    .ok_or_else(|| "Unable to resolve the user configuration directory.".to_string())?;
    Ok(base.join("CoopAgent"))
}

fn coopagent_local_data_root() -> Result<PathBuf, String> {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                user_home()
                    .ok()
                    .map(|home| home.join(".local").join("share"))
            })
    }
    .ok_or_else(|| "Unable to resolve the user data directory.".to_string())?;
    Ok(base.join("CoopAgent"))
}

const TRACE_VERSION: u8 = 1;
const TRACE_VALUE_LIMIT: usize = 32 * 1024;
static TRACE_COUNTER: AtomicU64 = AtomicU64::new(1);

fn unix_time_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn trace_root() -> Result<PathBuf, String> {
    if let Some(context) = projects::context()? {
        if context["legacy"] != true { return Ok(projects::workspace()?.join(".coopagent/traces")); }
    }
    Ok(coopagent_config_root()?.join("traces"))
}

fn new_run_id() -> String {
    let counter = TRACE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "run-{}-{}-{counter}",
        unix_time_millis(),
        std::process::id()
    )
}

fn is_valid_run_id(run_id: &str) -> bool {
    !run_id.is_empty()
        && run_id.len() <= 96
        && run_id.starts_with("run-")
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn bounded_trace_value(value: &Value) -> Value {
    let serialized = serde_json::to_string(value).unwrap_or_default();
    if serialized.len() <= TRACE_VALUE_LIMIT {
        return value.clone();
    }

    let mut preview_end = serialized.len().min(TRACE_VALUE_LIMIT / 2);
    while preview_end > 0 && !serialized.is_char_boundary(preview_end) {
        preview_end -= 1;
    }
    let preview = &serialized[..preview_end];
    serde_json::json!({
        "truncated": true,
        "originalBytes": serialized.len(),
        "preview": preview,
    })
}

fn trace_part_value(event: &Value, pointer: &str) -> Option<Value> {
    let value = event.pointer(pointer)?;
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return Some(bounded_trace_value(&parsed));
        }
    }
    Some(bounded_trace_value(value))
}

struct TraceWriter {
    run_id: String,
    path: PathBuf,
    sequence: u64,
}

impl TraceWriter {
    fn create() -> Result<Self, String> {
        let run_id = new_run_id();
        let root = trace_root()?;
        fs::create_dir_all(&root)
            .map_err(|error| format!("Unable to create the trace directory: {error}"))?;
        Ok(Self {
            path: root.join(format!("{run_id}.jsonl")),
            run_id,
            sequence: 0,
        })
    }

    fn open(run_id: &str) -> Result<Self, String> {
        if !is_valid_run_id(run_id) {
            return Err("The CoopAgent trace run ID is invalid.".to_string());
        }
        let path = trace_root()?.join(format!("{run_id}.jsonl"));
        if !path.is_file() {
            return Err(format!("The CoopAgent trace does not exist: {run_id}"));
        }
        let contents = fs::read(&path)
            .map_err(|error| format!("Unable to read the CoopAgent trace: {error}"))?;
        if !contents.is_empty() && contents.last() != Some(&b'\n') {
            OpenOptions::new()
                .append(true)
                .open(&path)
                .and_then(|mut file| file.write_all(b"\n"))
                .map_err(|error| {
                    format!("Unable to repair the CoopAgent trace boundary: {error}")
                })?;
        }
        let sequence = String::from_utf8_lossy(&contents).lines().count() as u64;
        Ok(Self {
            run_id: run_id.to_string(),
            path,
            sequence,
        })
    }

    fn run_id(&self) -> &str {
        &self.run_id
    }

    fn display_path(&self) -> String {
        display_path(&self.path)
    }

    fn append(&mut self, event: &str, status: &str, details: Value) -> Result<(), String> {
        self.sequence += 1;
        let record = serde_json::json!({
            "traceVersion": TRACE_VERSION,
            "runId": self.run_id,
            "sequence": self.sequence,
            "timestampMs": unix_time_millis(),
            "event": event,
            "status": status,
            // Keep tool identity/status queryable even when a large input and
            // output together exceed the generic event budget.
            "details": if event.starts_with("agent.tool.") {
                let mut safe = details.clone();
                for key in ["input", "output", "error"] {
                    if let Some(value) = safe.get_mut(key) { *value = bounded_trace_value(value); }
                }
                safe
            } else { bounded_trace_value(&details) },
        });
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("Unable to open the CoopAgent trace: {error}"))?;
        serde_json::to_writer(&mut file, &record)
            .map_err(|error| format!("Unable to encode the CoopAgent trace: {error}"))?;
        file.write_all(b"\n")
            .and_then(|_| file.flush())
            .map_err(|error| format!("Unable to write the CoopAgent trace: {error}"))
    }
}

fn read_trace_records(run_id: &str) -> Result<Vec<Value>, String> {
    if !is_valid_run_id(run_id) {
        return Err("The CoopAgent trace run ID is invalid.".to_string());
    }
    let path = trace_root()?.join(format!("{run_id}.jsonl"));
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read the CoopAgent trace: {error}"))?;
    Ok(contents
        .lines()
        .enumerate()
        .map(|(index, line)| {
            serde_json::from_str::<Value>(line).unwrap_or_else(|error| {
                serde_json::json!({
                    "traceVersion": TRACE_VERSION,
                    "runId": run_id,
                    "sequence": index + 1,
                    "timestampMs": Value::Null,
                    "event": "trace.corrupt_line",
                    "status": "error",
                    "details": {
                        "line": index + 1,
                        "bytes": line.len(),
                        "message": error.to_string(),
                    },
                })
            })
        })
        .collect())
}

const SESSION_MESSAGE_LIMIT: usize = 400;
const SESSION_MESSAGE_TEXT_LIMIT: usize = 100_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCodeSessionSummary {
    id: String,
    title: String,
    updated: u64,
    created: u64,
    directory: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionSummary {
    id: String,
    title: String,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionMessage {
    id: String,
    role: String,
    text: String,
    created_at_ms: Option<u64>,
}

const APPLICATION_LOG_VERSION: u8 = 1;
static APPLICATION_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static APPLICATION_LOG_LOCK: Mutex<()> = Mutex::new(());

fn application_log_path() -> Result<PathBuf, String> {
    if let Some(path) = APPLICATION_LOG_PATH.get() { return Ok(path.clone()); }
    let root = project_root()?.join(".coopagent/logs");
    fs::create_dir_all(&root).map_err(|error| format!("Unable to create the application log directory: {error}"))?;
    let path = root.join(format!("app-{}-{}.jsonl", unix_time_millis(), std::process::id()));
    let _ = APPLICATION_LOG_PATH.set(path);
    Ok(APPLICATION_LOG_PATH.get().expect("application log path initialized").clone())
}

fn write_application_log_record(path: &Path, level: &str, event: &str, details: Value) -> Result<(), String> {
    let record = serde_json::json!({
        "logVersion": APPLICATION_LOG_VERSION,
        "timestampMs": unix_time_millis(),
        "processId": std::process::id(),
        "level": level,
        "event": event,
        "details": bounded_trace_value(&details),
    });
    let mut bytes = serde_json::to_vec(&record).map_err(|error| format!("Unable to encode the application log: {error}"))?;
    bytes.push(b'\n');
    let _guard = APPLICATION_LOG_LOCK.lock().map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new().create(true).append(true).open(path)
        .map_err(|error| format!("Unable to open the application log: {error}"))?;
    file.write_all(&bytes).and_then(|_| file.flush())
        .map_err(|error| format!("Unable to write the application log: {error}"))
}

fn app_log(level: &str, event: &str, details: Value) {
    if let Ok(path) = application_log_path() {
        let _ = write_application_log_record(&path, level, event, details);
    }
}

fn initialize_application_logging() {
    let path = application_log_path().ok();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |information| {
        app_log("error", "application.panic", serde_json::json!({ "message": information.to_string() }));
        previous(information);
    }));
    app_log("info", "application.started", serde_json::json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "projectRoot": project_root().ok().map(|root| display_path(&root)),
        "logPath": path.map(|path| display_path(&path)),
    }));
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentTokenUsage {
    input: u64,
    cached: u64,
    output: u64,
}

impl AgentTokenUsage {
    fn add(&mut self, usage: Self) {
        self.input = self.input.saturating_add(usage.input);
        self.cached = self.cached.saturating_add(usage.cached);
        self.output = self.output.saturating_add(usage.output);
    }

    fn from_message(message: &Value) -> Self {
        Self {
            input: message.pointer("/info/tokens/input").and_then(Value::as_u64).unwrap_or_default(),
            cached: message.pointer("/info/tokens/cache/read").and_then(Value::as_u64).unwrap_or_default(),
            output: message.pointer("/info/tokens/output").and_then(Value::as_u64).unwrap_or_default(),
        }
    }
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionUsage {
    last_turn: AgentTokenUsage,
    total: AgentTokenUsage,
}

fn agent_session_usage(messages: &[Value]) -> AgentSessionUsage {
    let mut usage = AgentSessionUsage::default();
    for message in messages {
        match message.pointer("/info/role").and_then(Value::as_str) {
            Some("user") => usage.last_turn = AgentTokenUsage::default(),
            Some("assistant") => {
                let message_usage = AgentTokenUsage::from_message(message);
                usage.last_turn.add(message_usage);
                usage.total.add(message_usage);
            }
            _ => {}
        }
    }
    usage
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionDetail {
    id: String,
    title: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    model: Option<String>,
    messages: Vec<AgentSessionMessage>,
    history_truncated: bool,
    usage: AgentSessionUsage,
}

fn is_valid_agent_session_id(session_id: &str) -> bool {
    session_id.starts_with("ses_")
        && session_id.len() <= 128
        && session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn same_project_directory(directory: &str, project_root: &Path) -> bool {
    let candidate = PathBuf::from(directory);
    match (candidate.canonicalize(), project_root.canonicalize()) {
        (Ok(candidate), Ok(project_root)) => candidate == project_root,
        _ => candidate == project_root,
    }
}

fn run_opencode_command(project_root: &Path, arguments: &[&str]) -> Result<Vec<u8>, String> {
    let executable = opencode_path(project_root)?;
    let mut command = Command::new(executable);
    command
        .current_dir(project_root)
        .env("PATH", runtime_path(project_root)?)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    projects::configure(&mut command)?;
    let output = command
        .output()
        .map_err(|error| format!("Unable to run OpenCode session command: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("OpenCode session command exited with {}.", output.status)
        } else {
            stderr
        })
    }
}

fn list_agent_sessions(limit: usize) -> Result<Vec<AgentSessionSummary>, String> {
    let project_root = project_root()?;
    let limit = limit.clamp(1, 100);
    let workspace = projects::workspace()?;
    let output = run_opencode_command(
        &project_root,
        &["session", "list", "--format", "json"],
    )?;
    if output.iter().all(u8::is_ascii_whitespace) { return Ok(vec![]); }
    let sessions = serde_json::from_slice::<Vec<OpenCodeSessionSummary>>(&output)
        .map_err(|error| format!("OpenCode returned an invalid session list: {error}"))?;
    if projects::context()?.is_some_and(|c| c["legacy"] != true)
        && sessions.iter().any(|session| !same_project_directory(&session.directory, &workspace)) {
        return Err("项目目录已移动，聊天记录仍绑定旧目录，需重新关联会话；工程修改保持不变。".into());
    }
    let mut result = sessions
        .into_iter()
        .filter(|session| {
            is_valid_agent_session_id(&session.id)
                && same_project_directory(&session.directory, &workspace)
        })
        .map(|session| AgentSessionSummary {
            id: session.id,
            title: if session.title.trim().is_empty() {
                "未命名会话".to_string()
            } else {
                session.title.trim().to_string()
            },
            created_at_ms: session.created,
            updated_at_ms: session.updated,
        })
        .collect::<Vec<_>>();
    result.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
    result.truncate(limit);
    Ok(result)
}

fn bounded_session_text(text: &str) -> (String, bool) {
    if text.chars().count() <= SESSION_MESSAGE_TEXT_LIMIT {
        return (text.to_string(), false);
    }
    let mut truncated = text
        .chars()
        .take(SESSION_MESSAGE_TEXT_LIMIT)
        .collect::<String>();
    truncated.push_str("\n\n[消息过长，界面仅显示前部内容]");
    (truncated, true)
}

// A delivery checkpoint carries the actual answer before the host stops generation.
fn saved_delivery_text(task: &Value) -> Option<&str> {
    let checkpoint = task.get("checkpoint")?;
    if checkpoint["disposition"] != "deliver" { return None; }
    checkpoint.get("summary")?.as_str().filter(|text| !text.trim().is_empty())
}

fn delivery_text_from_part(part: &Value) -> Option<String> {
    if part["type"] != "tool" || part["tool"] != "coop_task_checkpoint"
        || part.pointer("/state/status")?.as_str()? != "completed" { return None; }
    let output = part.pointer("/state/output")?;
    let parsed;
    let output = if let Some(text) = output.as_str() {
        parsed = serde_json::from_str::<Value>(text).ok()?; &parsed
    } else { output };
    if output["status"] != "delivery-saved" { return None; }
    saved_delivery_text(&output["task"]).map(str::to_string)
}

fn agent_session_detail_from_export(
    session_id: &str,
    export: &Value,
    project_root: &Path,
) -> Result<AgentSessionDetail, String> {
    let info = export
        .get("info")
        .and_then(Value::as_object)
        .ok_or_else(|| "OpenCode session export is missing its info object.".to_string())?;
    let exported_id = info
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "OpenCode session export is missing its ID.".to_string())?;
    if exported_id != session_id || !is_valid_agent_session_id(exported_id) {
        return Err("OpenCode returned a different session than requested.".to_string());
    }
    let directory = info
        .get("directory")
        .and_then(Value::as_str)
        .ok_or_else(|| "OpenCode session export is missing its project directory.".to_string())?;
    if !same_project_directory(directory, project_root) {
        return Err("The requested session belongs to another project.".to_string());
    }

    let raw_messages = export
        .get("messages")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // Usage covers the complete session even when visible history is truncated.
    let usage = agent_session_usage(raw_messages);
    let start = raw_messages.len().saturating_sub(SESSION_MESSAGE_LIMIT);
    let mut history_truncated = start > 0;
    let mut messages: Vec<AgentSessionMessage> = Vec::new();
    let mut delivered = false;
    for (index, message) in raw_messages.iter().enumerate().skip(start) {
        let role = message
            .pointer("/info/role")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        if role == "user" { delivered = false; }
        if role == "assistant" && delivered { continue; }
        let delivery = if role == "assistant" {
            message.get("parts").and_then(Value::as_array)
                .and_then(|parts| parts.iter().find_map(delivery_text_from_part))
        } else { None };
        if delivery.is_some() {
            // Replace this turn's progress, retaining earlier user turns.
            let keep = messages.iter().rposition(|m| m.role == "user").map_or(0, |i| i + 1);
            messages.truncate(keep);
            delivered = true;
        }
        let text = delivery.unwrap_or_else(|| message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n"));
        if text.trim().is_empty() {
            continue;
        }
        let (text, text_truncated) = bounded_session_text(&text);
        history_truncated |= text_truncated;
        messages.push(AgentSessionMessage {
            id: message
                .pointer("/info/id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{session_id}-{index}")),
            role: role.to_string(),
            text,
            created_at_ms: message
                .pointer("/info/time/created")
                .and_then(Value::as_u64),
        });
    }

    let provider = export
        .pointer("/info/model/providerID")
        .and_then(Value::as_str);
    let model_id = export
        .pointer("/info/model/id")
        .or_else(|| export.pointer("/info/model/modelID"))
        .and_then(Value::as_str);
    let model = match (provider, model_id) {
        (Some(provider), Some(model_id)) => Some(format!("{provider}/{model_id}")),
        (_, Some(model_id)) => Some(model_id.to_string()),
        _ => None,
    };
    Ok(AgentSessionDetail {
        id: session_id.to_string(),
        title: info
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("未命名会话")
            .trim()
            .to_string(),
        created_at_ms: export
            .pointer("/info/time/created")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        updated_at_ms: export
            .pointer("/info/time/updated")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        model,
        messages,
        history_truncated,
        usage,
    })
}

fn load_agent_session(session_id: &str) -> Result<AgentSessionDetail, String> {
    if !is_valid_agent_session_id(session_id) {
        return Err("The OpenCode session ID is invalid.".to_string());
    }
    let project_root = project_root()?;
    let output = run_opencode_command(&project_root, &["export", session_id])?;
    let export = serde_json::from_slice::<Value>(&output)
        .map_err(|error| format!("OpenCode returned an invalid session export: {error}"))?;
    let export = run_agent_task_command("history", serde_json::json!({ "sessionId": session_id, "exported": export }))?;
    agent_session_detail_from_export(session_id, &export, &projects::workspace()?)
}

#[tauri::command]
async fn agent_session_list(limit: Option<usize>, project: Option<ProjectToken>) -> Result<Vec<AgentSessionSummary>, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    tauri::async_runtime::spawn_blocking(move || list_agent_sessions(limit.unwrap_or(50)))
        .await
        .map_err(|error| format!("Unable to join the session list task: {error}"))?
}

#[tauri::command]
async fn agent_session_read(session_id: String, project: Option<ProjectToken>) -> Result<AgentSessionDetail, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    tauri::async_runtime::spawn_blocking(move || load_agent_session(session_id.trim()))
        .await
        .map_err(|error| format!("Unable to join the session read task: {error}"))?
}

#[tauri::command]
async fn agent_session_delete(
    state: State<'_, AgentState>,
    session_id: String, project: Option<ProjectToken>) -> Result<(), String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    if state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("CoopAgent is busy and cannot delete a session right now.".to_string());
    }
    let running = Arc::clone(&state.running);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let session_id = session_id.trim().to_string();
        load_agent_session(&session_id)?;
        let project_root = project_root()?;
        run_opencode_command(&project_root, &["session", "delete", &session_id])?;
        Ok(())
    })
    .await;
    running.store(false, Ordering::Release);
    result.map_err(|error| format!("Unable to join the session delete task: {error}"))?
}

fn sc2_installation_config_path() -> Result<PathBuf, String> {
    Ok(coopagent_config_root()?.join("sc2-installation.json"))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sc2InstallationCheck {
    id: String,
    label: String,
    passed: bool,
    path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sc2InstallationStatus {
    configured: bool,
    valid: bool,
    database_ready: bool,
    database_build: Option<String>,
    database_status: Value,
    root_path: Option<String>,
    build: Option<String>,
    editor_path: Option<String>,
    game_path: Option<String>,
    checks: Vec<Sc2InstallationCheck>,
    message: String,
    config_path: String,
}

fn local_database_status() -> Value {
    let read = || -> Result<Value, String> {
        let root = project_root()?;
        let context = projects::context()?;
        let workspace = context.as_ref().and_then(|c| c["workspaceRoot"].as_str()).map(PathBuf::from).unwrap_or(root.clone());
        let mut command = Command::new(node_path(&root)?);
        command.arg(root.join("scripts/database-status.mjs")).arg(workspace);
        if let Some(file) = context.as_ref().and_then(|c| c["databaseFile"].as_str()) { command.arg(file); }
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let output = command.output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into()); }
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
    };
    let status = read().unwrap_or_else(|error| serde_json::json!({
        "ready": false, "code": "database-check-failed", "message": "数据库检查失败，请运行 setup.cmd 或重新检查。",
        "details": { "reason": error },
    }));
    if status["ready"] != true { app_log("error", "database.check_failed", status.clone()); }
    status
}

fn optional_sc2_root() -> Result<Option<String>, String> {
    let status = load_sc2_installation_status()?;
    Ok(status.valid.then_some(status.root_path).flatten())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Sc2InstallationConfig {
    root_path: String,
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn first_existing_file(root: &Path, candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|candidate| root.join(candidate))
        .find(|path| path.is_file())
}

fn find_sc2_game_binary(root: &Path) -> Option<(String, PathBuf)> {
    let versions = root.join("Versions");
    let mut candidates = fs::read_dir(versions)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let number = name.strip_prefix("Base")?.parse::<u64>().ok()?;
            let executable = entry.path().join("SC2_x64.exe");
            executable.is_file().then_some((number, name, executable))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(number, _, _)| *number);
    candidates
        .pop()
        .map(|(_, build, executable)| (build, executable))
}

fn validate_sc2_installation(root_path: Option<String>) -> Result<Sc2InstallationStatus, String> {
    let config_path = sc2_installation_config_path()?;
    let database_status = local_database_status();
    let database_ready = database_status["ready"] == true;
    let database_build = database_ready.then(|| database_status["dataBuild"].as_str().map(str::to_string)).flatten();
    let Some(raw_root) = root_path.filter(|value| !value.trim().is_empty()) else {
        return Ok(Sc2InstallationStatus {
            configured: false,
            valid: false,
            database_ready,
            database_build,
            database_status,
            root_path: None,
            build: None,
            editor_path: None,
            game_path: None,
            checks: Vec::new(),
            message: if database_ready {
                "本地合作模式数据库可用；无需配置游戏路径即可使用 Agent。".to_string()
            } else {
                "请先选择 StarCraft II 安装文件夹。".to_string()
            },
            config_path: display_path(&config_path),
        });
    };

    let root = PathBuf::from(raw_root.trim().trim_matches('"'));
    let root_exists = root.is_dir();
    let build_info = root.join(".build.info");
    let casc_root = if root.join("SC2Data").is_dir() {
        root.join("SC2Data")
    } else {
        root.join("Data")
    };
    let casc_exists = casc_root.join("data").is_dir() && casc_root.join("indices").is_dir();
    let editor = first_existing_file(
        &root,
        &[
            "StarCraft II Editor_x64.exe",
            "StarCraft II Editor.exe",
            "Support64/SC2Editor_x64.exe",
            "Support/SC2Editor.exe",
        ],
    );
    let game = find_sc2_game_binary(&root);

    let checks = vec![
        Sc2InstallationCheck {
            id: "root".to_string(),
            label: "StarCraft II 安装目录".to_string(),
            passed: root_exists,
            path: Some(display_path(&root)),
        },
        Sc2InstallationCheck {
            id: "buildInfo".to_string(),
            label: "版本信息（.build.info）".to_string(),
            passed: build_info.is_file(),
            path: Some(display_path(&build_info)),
        },
        Sc2InstallationCheck {
            id: "casc".to_string(),
            label: "CASC 数据（data + indices）".to_string(),
            passed: casc_exists,
            path: Some(display_path(&casc_root)),
        },
        Sc2InstallationCheck {
            id: "editor".to_string(),
            label: "StarCraft II 编辑器".to_string(),
            passed: editor.is_some(),
            path: editor.as_deref().map(display_path),
        },
        Sc2InstallationCheck {
            id: "game".to_string(),
            label: "StarCraft II 游戏核心".to_string(),
            passed: game.is_some(),
            path: game.as_ref().map(|(_, path)| display_path(path)),
        },
    ];
    let valid = checks.iter().all(|check| check.passed);

    Ok(Sc2InstallationStatus {
        configured: true,
        valid,
        database_ready,
        database_build,
        database_status,
        root_path: Some(display_path(&root)),
        build: game.as_ref().map(|(build, _)| build.clone()),
        editor_path: editor.as_deref().map(display_path),
        game_path: game.as_ref().map(|(_, path)| display_path(path)),
        checks,
        message: if valid && database_ready {
            "StarCraft II 安装和合作模式数据库均已验证，可以使用 Agent。".to_string()
        } else if valid {
            "StarCraft II 安装已验证，但合作模式数据库尚未准备完成；请运行 setup.cmd。"
                .to_string()
        } else if database_ready {
            "游戏路径不可用，但本地合作模式数据库可用，Agent 已进入离线开发模式。"
                .to_string()
        } else {
            "所选文件夹不是完整的 StarCraft II 安装目录。".to_string()
        },
        config_path: display_path(&config_path),
    })
}

fn load_sc2_installation_status() -> Result<Sc2InstallationStatus, String> {
    let config_path = sc2_installation_config_path()?;
    if !config_path.is_file() {
        return validate_sc2_installation(None);
    }
    let content = fs::read_to_string(&config_path)
        .map_err(|error| format!("Unable to read {}: {error}", config_path.display()))?;
    let config: Sc2InstallationConfig = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid JSON in {}: {error}", config_path.display()))?;
    validate_sc2_installation(Some(config.root_path))
}

fn require_sc2_installation() -> Result<Sc2InstallationStatus, String> {
    let status = load_sc2_installation_status()?;
    if status.valid {
        Ok(status)
    } else {
        Err(format!(
            "{} 请在左侧配置 StarCraft II 路径。",
            status.message
        ))
    }
}

#[tauri::command]
fn sc2_installation_status() -> Result<Sc2InstallationStatus, String> {
    load_sc2_installation_status()
}

#[tauri::command]
fn sc2_installation_set(root_path: String) -> Result<Sc2InstallationStatus, String> {
    let status = validate_sc2_installation(Some(root_path))?;
    let config_path = sc2_installation_config_path()?;
    let root_path = status.root_path.clone().unwrap_or_default();
    let config = Sc2InstallationConfig { root_path };
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Unable to serialize StarCraft II configuration: {error}"))?;
    fs::write(&config_path, format!("{content}\n"))
        .map_err(|error| format!("Unable to write {}: {error}", config_path.display()))?;
    Ok(status)
}

fn opencode_auth_path() -> Result<PathBuf, String> {
    Ok(user_home()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json"))
}

fn read_json_object(path: &std::path::Path) -> Result<Value, String> {
    if !path.is_file() {
        return Ok(serde_json::json!({}));
    }
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Invalid JSON in {}: {error}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("Expected a JSON object in {}.", path.display()))
    }
}

fn write_json_object(path: &std::path::Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to serialize model configuration: {error}"))?;
    fs::write(path, format!("{content}\n"))
        .map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProfile {
    provider_id: String,
    provider_name: String,
    base_url: String,
    model_id: String,
    model_name: String,
    full_id: String,
    selected: bool,
    has_api_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelCatalog {
    models: Vec<ModelProfile>,
    selected_model: Option<String>,
    config_path: String,
    credential_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelInput {
    provider_id: String,
    provider_name: String,
    base_url: String,
    model_id: String,
    model_name: String,
    api_key: Option<String>,
}

fn validate_provider_id(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 48
        && value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit());
    if valid {
        Ok(())
    } else {
        Err("Provider ID must use lowercase letters, numbers, and hyphens.".to_string())
    }
}

fn validate_model_input(input: &ModelInput) -> Result<(), String> {
    validate_provider_id(input.provider_id.trim())?;
    if input.provider_name.trim().is_empty() || input.provider_name.chars().count() > 80 {
        return Err("Provider name must be between 1 and 80 characters.".to_string());
    }
    if input.model_id.trim().is_empty()
        || input.model_id.chars().count() > 160
        || input.model_id.contains('#')
    {
        return Err(
            "Model ID must be between 1 and 160 characters and cannot contain '#'.".to_string(),
        );
    }
    if input.model_name.trim().is_empty() || input.model_name.chars().count() > 80 {
        return Err("Model name must be between 1 and 80 characters.".to_string());
    }
    let base_url = input.base_url.trim();
    if !(base_url.starts_with("https://") || base_url.starts_with("http://"))
        || base_url.chars().any(char::is_whitespace)
    {
        return Err("Base URL must be a valid http:// or https:// address.".to_string());
    }
    Ok(())
}

fn load_model_catalog() -> Result<ModelCatalog, String> {
    let config_path = model_config_path()?;
    let credential_path = opencode_auth_path()?;
    let config = read_json_object(&config_path)?;
    let credentials = read_json_object(&credential_path)?;
    let selected_model = config
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let mut models = Vec::new();

    if let Some(providers) = config.get("provider").and_then(Value::as_object) {
        for (provider_id, provider) in providers {
            let provider_name = provider
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(provider_id);
            let base_url = provider
                .pointer("/options/baseURL")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let has_api_key = credentials
                .pointer(&format!("/{provider_id}/key"))
                .and_then(Value::as_str)
                .is_some_and(|key| !key.is_empty());
            if let Some(provider_models) = provider.get("models").and_then(Value::as_object) {
                for (model_id, model) in provider_models {
                    let full_id = format!("{provider_id}/{model_id}");
                    models.push(ModelProfile {
                        provider_id: provider_id.clone(),
                        provider_name: provider_name.to_string(),
                        base_url: base_url.to_string(),
                        model_id: model_id.clone(),
                        model_name: model
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or(model_id)
                            .to_string(),
                        selected: selected_model.as_deref() == Some(full_id.as_str()),
                        has_api_key,
                        full_id,
                    });
                }
            }
        }
    }
    models.sort_by(|left, right| left.full_id.cmp(&right.full_id));

    Ok(ModelCatalog {
        models,
        selected_model,
        config_path: config_path.display().to_string(),
        credential_path: credential_path.display().to_string(),
    })
}

#[tauri::command]
fn model_list() -> Result<ModelCatalog, String> {
    load_model_catalog()
}

#[tauri::command]
fn model_save(input: ModelInput) -> Result<ModelCatalog, String> {
    validate_model_input(&input)?;
    let provider_id = input.provider_id.trim();
    let model_id = input.model_id.trim();
    let config_path = model_config_path()?;
    let mut config = read_json_object(&config_path)?;
    config["$schema"] = Value::String("https://opencode.ai/config.json".to_string());
    if !config.get("provider").is_some_and(Value::is_object) {
        config["provider"] = serde_json::json!({});
    }
    let providers = config["provider"]
        .as_object_mut()
        .ok_or_else(|| "Unable to prepare provider configuration.".to_string())?;
    let provider = providers
        .entry(provider_id.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !provider.is_object() {
        *provider = serde_json::json!({});
    }
    provider["npm"] = Value::String("@ai-sdk/openai-compatible".to_string());
    provider["name"] = Value::String(input.provider_name.trim().to_string());
    provider["options"] = serde_json::json!({ "baseURL": input.base_url.trim() });
    if !provider.get("models").is_some_and(Value::is_object) {
        provider["models"] = serde_json::json!({});
    }
    provider["models"][model_id] = serde_json::json!({
        "name": input.model_name.trim()
    });
    config["model"] = Value::String(format!("{provider_id}/{model_id}"));

    if let Some(api_key) = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        let auth_path = opencode_auth_path()?;
        let mut auth = read_json_object(&auth_path)?;
        auth[provider_id] = serde_json::json!({ "type": "api", "key": api_key });
        write_json_object(&auth_path, &auth)?;
    }
    write_json_object(&config_path, &config)?;
    load_model_catalog()
}

#[tauri::command]
fn model_select(provider_id: String, model_id: String) -> Result<ModelCatalog, String> {
    let full_id = format!("{}/{}", provider_id.trim(), model_id.trim());
    let config_path = model_config_path()?;
    let mut config = read_json_object(&config_path)?;
    let model_exists = config
        .get("provider")
        .and_then(Value::as_object)
        .and_then(|providers| providers.get(provider_id.trim()))
        .and_then(|provider| provider.get("models"))
        .and_then(Value::as_object)
        .is_some_and(|models| models.contains_key(model_id.trim()));
    if !model_exists {
        return Err(format!("Unknown model: {full_id}"));
    }
    config["model"] = Value::String(full_id);
    write_json_object(&config_path, &config)?;
    load_model_catalog()
}

#[tauri::command]
fn model_delete(provider_id: String, model_id: String) -> Result<ModelCatalog, String> {
    let provider_id = provider_id.trim();
    let model_id = model_id.trim();
    let config_path = model_config_path()?;
    let mut config = read_json_object(&config_path)?;
    let mut provider_removed = false;
    if let Some(provider) = config
        .get_mut("provider")
        .and_then(Value::as_object_mut)
        .and_then(|providers| providers.get_mut(provider_id))
    {
        if let Some(models) = provider.get_mut("models").and_then(Value::as_object_mut) {
            models.remove(model_id);
            provider_removed = models.is_empty();
        }
    }
    if provider_removed {
        if let Some(providers) = config.get_mut("provider").and_then(Value::as_object_mut) {
            providers.remove(provider_id);
        }
        let auth_path = opencode_auth_path()?;
        let mut auth = read_json_object(&auth_path)?;
        if let Some(credentials) = auth.as_object_mut() {
            credentials.remove(provider_id);
        }
        write_json_object(&auth_path, &auth)?;
    }

    let deleted_full_id = format!("{provider_id}/{model_id}");
    if config.get("model").and_then(Value::as_str) == Some(deleted_full_id.as_str()) {
        config.as_object_mut().map(|object| object.remove("model"));
    }
    write_json_object(&config_path, &config)?;
    load_model_catalog()
}

#[derive(Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum AgentEvent {
    Scoped { project_id: String, context_generation: u64, event: Box<AgentEvent> },
    Started {
        run_id: String,
        trace_path: String,
    },
    Activity {
        label: String,
    },
    Usage {
        session_id: Option<String>,
        tokens: AgentTokenUsage,
    },
    Phase { task: Value },
    Paused { run_id: String, session_id: Option<String>, task: Value },
    SubmissionChanged {},
    PlanReady {
        run_id: String,
        plan_path: String,
        plan_sha256: String,
        plan_id: String,
        operation_count: usize,
        changed_files: Vec<String>,
        summary_items: Vec<String>,
        verification_level: String,
        verification_label: String,
        runtime_verified: bool,
    },
    Text {
        text: String,
    },
    Complete {
        run_id: String,
        session_id: Option<String>,
    },
    Cancelled {
        run_id: String,
        message: String,
        session_id: Option<String>,
    },
    Error {
        run_id: String,
        message: String,
        session_id: Option<String>,
    },
}

#[derive(Clone, Default)]
struct AgentState {
    running: Arc<AtomicBool>,
    closing: Arc<AtomicBool>,
    exit_ready: Arc<AtomicBool>,
    shutdown_error: Arc<Mutex<Option<String>>>,
    active: Arc<Mutex<Option<AgentRunControl>>>,
    snapshot: Arc<Mutex<Option<AgentRunSnapshot>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRunSnapshot {
    run_id: String,
    trace_path: String,
    prompt: String,
    started_at_ms: u64,
    session_id: Option<String>,
    state: String,
    text: String,
    activity: String,
    error: Option<String>,
    sequence: u64,
    task: Option<Value>,
}

impl AgentRunSnapshot {
    fn observe(&mut self, event: &AgentEvent) {
        self.sequence += 1;
        match event {
            AgentEvent::Started { .. } => self.state = "running".into(),
            AgentEvent::Activity { label } => self.activity = label.clone(),
            AgentEvent::Text { text } => self.text.push_str(text),
            AgentEvent::Phase { task } => {
                if let Some(text) = saved_delivery_text(task) { self.text = text.to_string(); }
                self.task = Some(task.clone());
            }
            AgentEvent::Paused { task, session_id, .. } => {
                self.state = if task["status"] == "ended" { "completed" } else { "paused" }.into();
                self.task = Some(task.clone());
                if task["status"] == "awaiting_confirmation" {
                    self.text = task.pointer("/confirmation/question").and_then(Value::as_str).unwrap_or("等待确认修改目标").into();
                    self.activity = "等待用户确认目标与效果".into();
                } else if let Some(text) = task.pointer("/lastCheckpoint/summary").and_then(Value::as_str) {
                    self.text = text.to_string();
                }
                self.session_id = session_id.clone().or(self.session_id.take());
            }
            AgentEvent::Complete { session_id, .. } => {
                self.state = "completed".into();
                self.session_id = session_id.clone().or(self.session_id.take());
            }
            AgentEvent::Error { message, session_id, .. }
            | AgentEvent::Cancelled { message, session_id, .. } => {
                self.state = if matches!(event, AgentEvent::Cancelled { .. }) { "cancelled" } else { "failed" }.into();
                self.error = Some(message.clone());
                self.session_id = session_id.clone().or(self.session_id.take());
            }
            _ => {}
        }
    }
}

struct AgentEventSink {
    project: Option<ProjectToken>,
    channel: Channel<AgentEvent>,
    run_id: String,
    snapshot: Arc<Mutex<Option<AgentRunSnapshot>>>,
}

impl AgentEventSink {
    fn update(&self, update: impl FnOnce(&mut AgentRunSnapshot)) {
        if let Ok(mut slot) = self.snapshot.lock() {
            if let Some(snapshot) = slot.as_mut().filter(|snapshot| snapshot.run_id == self.run_id) {
                update(snapshot);
            }
        }
    }
}

#[tauri::command]
fn agent_snapshot(state: State<'_, AgentState>, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    current_agent_snapshot(&state)
}

fn current_agent_snapshot(state: &AgentState) -> Result<Value, String> {
    let run = state.snapshot.lock().map_err(|_| "Agent snapshot lock poisoned".to_string())?.clone();
    let shutdown_error = state.shutdown_error.lock().map_err(|_| "Agent shutdown lock poisoned".to_string())?.clone();
    Ok(serde_json::json!({ "busy": state.running.load(Ordering::Acquire) || state.closing.load(Ordering::Acquire),
        "run": run, "shutdownError": shutdown_error }))
}

#[derive(Clone)]
struct AgentRunControl {
    run_id: String,
    child: Arc<Mutex<Option<std::process::Child>>>,
    cancelled: Arc<AtomicBool>,
}

impl AgentRunControl {
    fn new(run_id: String) -> Self {
        Self { run_id, child: Arc::new(Mutex::new(None)), cancelled: Arc::new(AtomicBool::new(false)) }
    }

    fn cancel_with(&self, persist: impl FnOnce() -> Result<(), String>) -> Result<(), String> {
        // Persist the write barrier before killing only the owned model process.
        // Detached submission workers must finish or recover their transaction.
        persist()?;
        self.cancelled.store(true, Ordering::Release);
        let mut slot = self.child.lock().map_err(|_| "Agent process lock poisoned".to_string())?;
        if let Some(child) = slot.as_mut() {
            if child.try_wait().map_err(|error| error.to_string())?.is_none() {
                child.kill().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

struct ActiveAgentGuard { active: Arc<Mutex<Option<AgentRunControl>>>, run_id: String }
impl Drop for ActiveAgentGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.lock() {
            if active.as_ref().is_some_and(|run| run.run_id == self.run_id) { *active = None; }
        }
    }
}

struct AgentBusyGuard(Option<Arc<AtomicBool>>);

impl AgentBusyGuard {
    fn acquire(state: &AgentState) -> Result<Self, String> {
        if state.closing.load(Ordering::Acquire) { return Err("CoopAgent 正在停止任务并关闭。".into()); }
        state.running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "CoopAgent 正在处理请求、应用修改或启动地图运行层，请等待完成后重试。".to_string())?;
        Ok(Self(Some(Arc::clone(&state.running))))
    }

    fn release(&mut self) {
        if let Some(running) = self.0.take() {
            running.store(false, Ordering::Release);
        }
    }
}

impl Drop for AgentBusyGuard {
    fn drop(&mut self) { self.release(); }
}

// Keep the window alive until the cancellation barrier and model exit are
// confirmed. This deliberately never waits on or kills a detached committer.
fn request_agent_shutdown(app: &AppHandle) -> bool {
    let state = app.state::<AgentState>();
    if state.exit_ready.load(Ordering::Acquire) { return false; }
    let control = state.active.lock().unwrap_or_else(|error| error.into_inner()).clone();
    if state.closing.load(Ordering::Acquire) { return true; }
    let Some(control) = control else { return false; };
    if state.closing.swap(true, Ordering::AcqRel) { return true; }
    *state.shutdown_error.lock().unwrap_or_else(|error| error.into_inner()) = None;
    let app = app.clone();
    let closing = Arc::clone(&state.closing);
    let snapshot = Arc::clone(&state.snapshot);
    let shutdown_error = Arc::clone(&state.shutdown_error);
    let exit_ready = Arc::clone(&state.exit_ready);
    thread::spawn(move || {
        let result = control.cancel_with(|| run_plan_jobs_command("cancel-run", Some(&control.run_id)).map(|_| ()))
            .and_then(|_| {
                let deadline = Instant::now() + Duration::from_secs(10);
                loop {
                    let active = app.state::<AgentState>().active.lock()
                        .unwrap_or_else(|error| error.into_inner()).as_ref()
                        .is_some_and(|run| run.run_id == control.run_id);
                    if !active { return Ok(()); }
                    if Instant::now() >= deadline { return Err("停止请求已保存，但模型进程尚未完成清理；请稍后再关闭。".into()); }
                    thread::sleep(Duration::from_millis(50));
                }
            });
        match result {
            Ok(()) => {
                // Keep new requests gated until the event loop actually exits.
                exit_ready.store(true, Ordering::Release);
                app.exit(0);
            }
            Err(error) => {
                closing.store(false, Ordering::Release);
                *shutdown_error.lock().unwrap_or_else(|error| error.into_inner()) = Some(error.clone());
                if let Ok(mut slot) = snapshot.lock() {
                    if let Some(run) = slot.as_mut().filter(|run| run.run_id == control.run_id) {
                        run.activity = format!("暂时无法关闭：{error}");
                        run.sequence += 1;
                    }
                }
                app_log("error", "agent.shutdown.failed", serde_json::json!({ "message": &error }));
                eprintln!("Agent shutdown: {error}");
            }
        }
    });
    true
}

fn send_agent_event(channel: &AgentEventSink, event: AgentEvent) {
    // The page channel is disposable. Record first, including terminal output,
    // so a newly mounted page can observe and stop the same backend task.
    channel.update(|snapshot| snapshot.observe(&event));
    let event = if let Some(project) = &channel.project {
        AgentEvent::Scoped { project_id: project.project_id.clone(), context_generation: project.context_generation, event: Box::new(event) }
    } else { event };
    let _ = channel.channel.send(event);
}

fn validate_checked_plan_run(records: &[Value], plan_path: &str, plan_sha256: &str) -> Result<(), String> {
    let mut checked: Option<&Value> = None;
    let mut completed = false;
    for record in records {
        match record.get("event").and_then(Value::as_str) {
            Some("agent.tool.completed" | "agent.tool.failed")
                if matches!(record.pointer("/details/tool").and_then(Value::as_str),
                    Some("coop_patch_plan_write" | "coop_patch_plan_check")) => {
                checked = None;
                completed = false;
            }
            Some("patch_plan.checked") => { checked = record.get("details"); completed = false; }
            Some("agent.completed") => completed = true,
            Some("agent.failed" | "agent.output.failed") => completed = false,
            _ => {}
        }
    }
    if completed && checked.is_some_and(|details| {
        details.get("planPath").and_then(Value::as_str) == Some(plan_path)
            && details.get("fileSha256").and_then(Value::as_str)
                .is_some_and(|sha| sha.eq_ignore_ascii_case(plan_sha256))
    }) { return Ok(()); }
    Err("该计划不是此任务最终预检通过的版本，或原 Agent 任务未正常完成。请让 Agent 重新预检后再应用。".to_string())
}

#[derive(Default)]
struct AgentObservationState {
    checkpoint_saved: bool,
    delivery_saved: bool,
    confirmation_requested: bool,
    harness_stop_requested: bool,
    harness_stage: Option<String>,
    harness_waiting: bool,
    harness_deadline_update: Option<(bool, u64)>,
    tools: HashMap<(String, String), String>,
    steps: std::collections::HashSet<String>,
    usage: std::collections::HashSet<String>,
    observer_ready: bool,
}

impl AgentObservationState {
    fn finish(&self, trace: &mut TraceWriter) {
        for ((call_id, tool), status) in &self.tools {
            if matches!(status.as_str(), "running" | "pending") {
                let _ = trace.append("agent.tool.unfinished", "unknown", serde_json::json!({
                    "toolCallId": call_id, "tool": tool, "lastObservedStatus": status,
                    "reason": "run_ended_without_tool_result",
                    "note": "No terminal result was observed; this does not prove failure or rollback. Check durable submission jobs separately.",
                }));
            }
        }
        let _ = trace.append("agent.observation.summary", if self.observer_ready { "ok" } else { "warning" }, serde_json::json!({
            "observerAvailable": self.observer_ready,
            "usageSteps": self.usage.len(), "startedSteps": self.steps.len(),
            "harnessStage": self.harness_stage, "deliverySaved": self.delivery_saved,
            "harnessWaiting": self.harness_waiting,
            "note": if self.observer_ready { "Usage is provider-reported; an interrupted last request may remain unknown." }
                else { "Early tool-call capture was unavailable; CLI output may omit unfinished calls." },
        }));
    }
}

fn handle_agent_json_line(
    line: &str,
    channel: &AgentEventSink,
    session_id: &mut Option<String>,
    assistant_text: &mut String,
    observations: &mut AgentObservationState,
    plan_ready: &mut bool,
    trace: &mut TraceWriter,
) {
    let Ok(event) = serde_json::from_str::<Value>(line) else {
        let _ = trace.append(
            "agent.output.ignored",
            "warning",
            serde_json::json!({
                "reason": "invalid_json",
                "bytes": line.len(),
            }),
        );
        return;
    };
    if matches!(event.get("type").and_then(Value::as_str), Some("context_projection" | "context_observed")) {
        let mut metrics = serde_json::Map::new();
        for key in ["beforeCharacters", "afterCharacters", "limitCharacters", "originalMessages", "keptMessages", "archivedParts"] {
            if let Some(value) = event.get(key).and_then(Value::as_u64) {
                metrics.insert(key.into(), serde_json::json!(value));
            }
        }
        for key in ["modified", "archiveFailed"] {
            if let Some(value) = event.get(key).and_then(Value::as_bool) {
                metrics.insert(key.into(), serde_json::json!(value));
            }
        }
        let observed = event.get("type").and_then(Value::as_str) == Some("context_observed");
        let _ = trace.append(if observed { "agent.context.observed" } else { "agent.context.projected" }, "ok", Value::Object(metrics));
        return;
    }
    if event.get("type").and_then(Value::as_str) == Some("observer_ready") {
        if !observations.observer_ready {
            observations.observer_ready = true;
            let _ = trace.append("agent.observer.ready", "ok", serde_json::json!({ "version": 1 }));
        }
        return;
    }
    if let Some(value) = event.get("sessionID").and_then(Value::as_str) {
        // A process-local plugin can see background/sub-session events. They
        // must not replace this run's session or inflate its token accounting.
        if session_id.as_deref().is_some_and(|current| current != value) { return; }
        if session_id.as_deref() != Some(value) {
            let _ = trace.append(
                "agent.session.discovered",
                "ok",
                serde_json::json!({ "sessionId": value }),
            );
        }
        *session_id = Some(value.to_string());
        channel.update(|snapshot| snapshot.session_id = Some(value.to_string()));
    }

    if event.get("type").and_then(Value::as_str) == Some("harness_ready") {
        let _ = trace.append("agent.harness.ready", "ok", serde_json::json!({
            "version": event.get("version"), "boundary": event.get("boundary"),
        }));
        return;
    }
    if event.get("type").and_then(Value::as_str) == Some("harness_control") {
        let action = event.get("action").and_then(Value::as_str).unwrap_or("continue");
        let stage = event.get("stage").and_then(Value::as_str).unwrap_or("work");
        observations.harness_stage = Some(stage.to_string());
        observations.harness_stop_requested |= action == "stop";
        if let Some(remaining) = event.get("remainingMs").and_then(Value::as_u64) {
            let waiting = event.get("waiting").and_then(Value::as_bool).unwrap_or(false);
            observations.harness_waiting = waiting;
            observations.harness_deadline_update = Some((waiting, remaining));
        }
        let _ = trace.append("agent.harness.control", if action == "stop" { "stopping" } else { "ok" }, serde_json::json!({
            "action": action, "stage": stage, "reason": event.get("reason"),
            "elapsedMs": event.get("elapsedMs"), "toolSteps": event.get("toolSteps"),
            "remainingMs": event.get("remainingMs"), "waiting": event.get("waiting"),
            "applicationStatus": event.get("applicationStatus"), "usefulResult": event.get("usefulResult"),
            "instructionInjected": event.get("instructionInjected"), "boundary": event.get("boundary"),
            "eventId": event.get("eventId"), "sessionId": event.get("sessionID"),
        }));
        if action == "close" {
            send_agent_event(channel, AgentEvent::Activity { label: if stage == "final" {
                "正在完成最终收尾…".to_string()
            } else { "已有可交付结果或探索进入长尾，正在收尾…".to_string() } });
        }
        return;
    }

    if event.get("type").and_then(Value::as_str) == Some("step_start") {
        let step_key = event.pointer("/part/messageID").or_else(|| event.pointer("/part/id")).and_then(Value::as_str);
        if step_key.is_none_or(|key| observations.steps.insert(key.to_string())) {
            let _ = trace.append(
            "agent.step.started",
            "running",
            serde_json::json!({ "sessionId": session_id, "messageId": event.pointer("/part/messageID"), "partId": event.pointer("/part/id") }),
            );
        } else { return; }
    }

    match event.get("type").and_then(Value::as_str) {
        Some("step_finish") => {
            let step_key = event.pointer("/part/id").or_else(|| event.pointer("/part/messageID")).and_then(Value::as_str);
            if step_key.is_some_and(|key| !observations.usage.insert(key.to_string())) { return; }
            let number = |pointer: &str| event.pointer(pointer).and_then(Value::as_u64);
            let tokens = AgentTokenUsage {
                input: number("/part/tokens/input").unwrap_or_default(),
                cached: number("/part/tokens/cache/read").unwrap_or_default(),
                output: number("/part/tokens/output").unwrap_or_default(),
            };
            let _ = trace.append("agent.usage", "ok", serde_json::json!({
                "sessionId": session_id, "messageId": event.pointer("/part/messageID"), "partId": event.pointer("/part/id"),
                "tokens": { "input": number("/part/tokens/input"), "output": number("/part/tokens/output"),
                    "reasoning": number("/part/tokens/reasoning"), "total": number("/part/tokens/total"),
                    "cache": { "read": number("/part/tokens/cache/read"), "write": number("/part/tokens/cache/write") } },
            }));
            send_agent_event(channel, AgentEvent::Usage {
                session_id: session_id.clone(),
                tokens,
            });
        }
        Some("step_start") => send_agent_event(
            channel,
            AgentEvent::Activity {
                label: "正在分析项目…".to_string(),
            },
        ),
        Some("tool_use") => {
            let tool = event
                .pointer("/part/tool")
                .and_then(Value::as_str)
                .unwrap_or("project tool");
            let tool_call_id = event
                .pointer("/part/callID")
                .or_else(|| event.pointer("/part/id"))
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let tool_status = event
                .pointer("/part/state/status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let state_key = (tool_call_id.to_string(), tool.to_string());
            let previous = observations.tools.get(&state_key).map(String::as_str);
            // stdout and the observer may deliver duplicates or late starts.
            if previous == Some(tool_status) || previous.is_some_and(|s| matches!(s, "completed" | "error" | "failed")) { return; }
            {
                observations.tools.insert(state_key, tool_status.to_string());
                let trace_event = match tool_status {
                    "completed" => "agent.tool.completed",
                    "error" | "failed" => "agent.tool.failed",
                    _ => "agent.tool.started",
                };
                let trace_status = match tool_status {
                    "completed" => "ok",
                    "error" | "failed" => "error",
                    _ => "running",
                };
                let _ = trace.append(
                    trace_event,
                    trace_status,
                    serde_json::json!({
                        "tool": tool,
                        "toolCallId": tool_call_id,
                        "providerStatus": tool_status,
                        "providerTime": event.pointer("/part/state/time"),
                        "input": trace_part_value(&event, "/part/state/input"),
                        "output": if tool_status == "completed" { trace_part_value(&event, "/part/state/output") } else { None },
                        "error": if matches!(tool_status, "error" | "failed") { trace_part_value(&event, "/part/state/error") } else { None },
                    }),
                );
            }
            if tool == "coop_patch_plan_check"
                && event.pointer("/part/state/status").and_then(Value::as_str) == Some("completed")
            {
                if let Some(output) = event
                    .pointer("/part/state/output")
                    .and_then(Value::as_str)
                    .and_then(|output| serde_json::from_str::<Value>(output).ok())
                {
                    let plan_path = output.get("planPath").and_then(Value::as_str);
                    let plan_sha256 = output.get("planSha256").and_then(Value::as_str);
                    let plan_id = output.pointer("/report/id").and_then(Value::as_str);
                    if let (Some(plan_path), Some(plan_sha256), Some(plan_id)) =
                        (plan_path, plan_sha256, plan_id)
                    {
                        *plan_ready = true;
                        let operations = output
                            .pointer("/report/operations")
                            .and_then(Value::as_array);
                        let changed_files: Vec<String> = output
                            .pointer("/report/changedFiles")
                            .and_then(Value::as_array)
                            .map(|files| {
                                files
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let summary_items: Vec<String> = output
                            .pointer("/review/userSummary/items")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let verification_level = output
                            .pointer("/review/userSummary/verificationLevel")
                            .and_then(Value::as_str)
                            .unwrap_or("static-preflight")
                            .to_string();
                        let verification_label = output
                            .pointer("/review/userSummary/verificationLabel")
                            .and_then(Value::as_str)
                            .unwrap_or("静态预检通过；尚未写入地图运行层，也未完成试玩验证。")
                            .to_string();
                        let runtime_verified = output
                            .pointer("/review/userSummary/runtimeVerified")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        let _ = trace.append(
                            "patch_plan.checked",
                            "ok",
                            serde_json::json!({
                                "planPath": plan_path,
                                "fileSha256": plan_sha256,
                                "planId": plan_id,
                                "operationCount": operations.map_or(0, Vec::len),
                                "changedFiles": changed_files.clone(),
                                "summaryItems": summary_items.clone(),
                                "verificationLevel": verification_level.clone(),
                                "runtimeVerified": runtime_verified,
                            }),
                        );
                        send_agent_event(
                            channel,
                            AgentEvent::PlanReady {
                                run_id: trace.run_id().to_string(),
                                plan_path: plan_path.to_string(),
                                plan_sha256: plan_sha256.to_string(),
                                plan_id: plan_id.to_string(),
                                operation_count: operations.map_or(0, Vec::len),
                                changed_files,
                                summary_items,
                                verification_level,
                                verification_label,
                                runtime_verified,
                            },
                        );
                    }
                }
            }
            if tool == "coop_target_confirm" && tool_status == "completed" {
                if let Some(output) = event.pointer("/part/state/output").and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str::<Value>(text).ok()) {
                    if output["status"] == "awaiting-confirmation" && output["task"]["status"] == "awaiting_confirmation" {
                        observations.confirmation_requested = true;
                        observations.checkpoint_saved = true;
                        let _ = trace.append("task.confirmation.requested", "waiting", output["task"].clone());
                        send_agent_event(channel, AgentEvent::Phase { task: output["task"].clone() });
                    }
                }
            }
            if tool == "coop_task_checkpoint" && tool_status == "completed" {
                if let Some(output) = event.pointer("/part/state/output").and_then(Value::as_str)
                    .and_then(|text| serde_json::from_str::<Value>(text).ok()) {
                    if matches!(output["status"].as_str(), Some("checkpoint-saved" | "delivery-saved")) && output["task"].is_object() {
                        observations.delivery_saved |= output["status"] == "delivery-saved";
                        observations.checkpoint_saved = true;
                        let _ = trace.append(if output["status"] == "delivery-saved" { "task.delivery.saved" }
                            else { "task.checkpoint.saved" }, "ok", output["task"].clone());
                        send_agent_event(channel, AgentEvent::Phase { task: output["task"].clone() });
                    }
                }
            }
            if tool == "coop_plan_submit" && matches!(tool_status, "completed" | "error" | "failed") {
                let _ = trace.append("plan.submission.observed", tool_status, serde_json::json!({
                    "output": trace_part_value(&event, "/part/state/output"),
                    "error": trace_part_value(&event, "/part/state/error"),
                }));
                send_agent_event(channel, AgentEvent::SubmissionChanged {});
            }
            send_agent_event(
                channel,
                AgentEvent::Activity {
                    label: format!("正在调用 {tool}…"),
                },
            );
        }
        Some("reasoning") => {
            // Provider reasoning is transient activity, never answer/history text.
            if !observations.checkpoint_saved {
                if let Some(text) = event.pointer("/part/text").and_then(Value::as_str).filter(|text| !text.trim().is_empty()) {
                    send_agent_event(channel, AgentEvent::Activity { label: text.to_string() });
                }
            }
        }
        Some("text") => {
            if let Some(text) = event.pointer("/part/text").and_then(Value::as_str) {
                assistant_text.push_str(text);
                if !observations.checkpoint_saved { send_agent_event(
                    channel,
                    AgentEvent::Text {
                        text: text.to_string(),
                    },
                ); }
            }
        }
        _ => {}
    }
}

fn is_approved_draft_path(plan_path: &str) -> bool {
    let normalized = plan_path.replace('\\', "/");
    let Some(file_name) = normalized.strip_prefix("game-a/drafts/") else {
        return false;
    };
    let Some(id) = file_name.strip_suffix(".patch-plan.json") else {
        return false;
    };
    !id.is_empty()
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn launch_game_a_editor(project_root: &Path, sc2_root: &str) -> Result<Value, String> {
    let launcher = project_root.join("game-a/scripts/launch-game-a.ps1");
    if !launcher.is_file() {
        return Err("The Map Runtime editor launcher is missing.".to_string());
    }

    let mut command = Command::new("powershell.exe");
    command
        .current_dir(project_root)
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&launcher)
        .arg("-StarCraftRoot")
        .arg(sc2_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    projects::configure(&mut command)?;
    let output = command
        .output()
        .map_err(|error| format!("Unable to start the Map Runtime editor launcher: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("Map Runtime editor launcher exited with {}.", output.status)
        });
    }

    let mut result = parse_editor_launch_result(&stdout)?;
    result["output"] = stdout.into();
    Ok(result)
}

fn parse_editor_launch_result(stdout: &str) -> Result<Value, String> {
    stdout.lines().rev()
        .find_map(|line| line.strip_prefix("COOPAGENT_EDITOR_RESULT "))
        .and_then(|line| serde_json::from_str(line).ok())
        .filter(|result: &Value| result["status"] == "ok" && result["editor"] == "opened"
            && result["documentName"].as_str().is_some_and(|name| !name.trim().is_empty())
            && result["manualStartRequired"].is_boolean())
        .ok_or_else(|| "编辑器启动器未确认最新地图已打开，请重试。".to_string())
}

#[tauri::command]
async fn game_a_editor_status(document_name: Option<String>, project: Option<ProjectToken>) -> Result<Value, String> {
    // Validate the caller, then release immediately: this system process query
    // reads no workspace files and must not block switching projects while polling.
    drop(projects::acquire(project.as_ref(), false)?);
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(project_root()?.join("game-a/scripts/editor-status.ps1"));
        if let Some(name) = document_name { command.arg("-DocumentName").arg(name); }
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let output = command.output().map_err(|error| error.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
    }).await.map_err(|error| error.to_string())?
}

fn latest_game_a_build(_project_root: &Path) -> Option<Value> {
    let latest_root = projects::workspace().ok()?.join("game-a/build/latest");
    let mut pointers = fs::read_dir(&latest_root)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    pointers.sort_by_key(|path| {
        std::cmp::Reverse(
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .unwrap_or(UNIX_EPOCH),
        )
    });
    let pointer_path = pointers.first()?;
    let manifest = fs::read_to_string(pointer_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())?;
    Some(serde_json::json!({
        "pointerPath": display_path(pointer_path),
        "manifest": manifest,
    }))
}

fn safe_portrait_cache_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn safe_portrait_casc_path(value: &str) -> bool {
    let normalized = value.replace('/', "\\");
    let lower = normalized.to_ascii_lowercase();
    (lower.starts_with("mods\\") || lower.starts_with("campaigns\\"))
        && lower.ends_with(".dds")
        && !normalized.contains("..")
        && !normalized.contains('=')
        && !normalized.contains('\r')
        && !normalized.contains('\n')
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn rgb565_to_bgra(value: u16) -> [u8; 4] {
    let red = ((value >> 11) & 0x1f) as u32;
    let green = ((value >> 5) & 0x3f) as u32;
    let blue = (value & 0x1f) as u32;
    [
        ((blue * 255 + 15) / 31) as u8,
        ((green * 255 + 31) / 63) as u8,
        ((red * 255 + 15) / 31) as u8,
        255,
    ]
}

fn mix_channel(left: u8, right: u8, left_weight: u16, right_weight: u16, sum: u16) -> u8 {
    ((u16::from(left) * left_weight + u16::from(right) * right_weight) / sum) as u8
}

fn dxt_color_palette(block: &[u8], allow_dxt1_transparency: bool) -> [[u8; 4]; 4] {
    let color_0 = u16::from_le_bytes([block[0], block[1]]);
    let color_1 = u16::from_le_bytes([block[2], block[3]]);
    let mut palette = [[0u8; 4]; 4];
    palette[0] = rgb565_to_bgra(color_0);
    palette[1] = rgb565_to_bgra(color_1);
    if allow_dxt1_transparency && color_0 <= color_1 {
        for channel in 0..3 {
            palette[2][channel] = mix_channel(palette[0][channel], palette[1][channel], 1, 1, 2);
        }
        palette[2][3] = 255;
        palette[3] = [0, 0, 0, 0];
    } else {
        for channel in 0..3 {
            palette[2][channel] = mix_channel(palette[0][channel], palette[1][channel], 2, 1, 3);
            palette[3][channel] = mix_channel(palette[0][channel], palette[1][channel], 1, 2, 3);
        }
        palette[2][3] = 255;
        palette[3][3] = 255;
    }
    palette
}

fn decode_dxt_pixels(
    data: &[u8],
    width: usize,
    height: usize,
    format: &[u8; 4],
    asset_id: &str,
) -> Result<Vec<u8>, String> {
    let block_bytes = if format == b"DXT1" { 8 } else { 16 };
    let blocks_wide = width.div_ceil(4);
    let blocks_high = height.div_ceil(4);
    let expected = blocks_wide
        .checked_mul(blocks_high)
        .and_then(|value| value.checked_mul(block_bytes))
        .ok_or_else(|| format!("The {asset_id} DDS dimensions are invalid."))?;
    if data.len() < expected {
        return Err(format!("The {asset_id} DDS pixel data is truncated."));
    }
    let mut pixels = vec![0u8; width * height * 4];

    for block_y in 0..blocks_high {
        for block_x in 0..blocks_wide {
            let block_offset = (block_y * blocks_wide + block_x) * block_bytes;
            let block = &data[block_offset..block_offset + block_bytes];
            let color_offset = if format == b"DXT1" { 0 } else { 8 };
            let colors = dxt_color_palette(&block[color_offset..], format == b"DXT1");
            let color_indices = u32::from_le_bytes(
                block[color_offset + 4..color_offset + 8]
                    .try_into()
                    .unwrap(),
            );

            let mut alpha_palette = [255u8; 8];
            let mut alpha_indices = 0u64;
            let dxt3_alpha = if format == b"DXT3" {
                Some(u64::from_le_bytes(block[0..8].try_into().unwrap()))
            } else {
                None
            };
            if format == b"DXT5" {
                let alpha_0 = block[0];
                let alpha_1 = block[1];
                alpha_palette[0] = alpha_0;
                alpha_palette[1] = alpha_1;
                if alpha_0 > alpha_1 {
                    for index in 1..=6 {
                        alpha_palette[index + 1] =
                            mix_channel(alpha_0, alpha_1, (7 - index) as u16, index as u16, 7);
                    }
                } else {
                    for index in 1..=4 {
                        alpha_palette[index + 1] =
                            mix_channel(alpha_0, alpha_1, (5 - index) as u16, index as u16, 5);
                    }
                    alpha_palette[6] = 0;
                    alpha_palette[7] = 255;
                }
                for (index, byte) in block[2..8].iter().enumerate() {
                    alpha_indices |= u64::from(*byte) << (index * 8);
                }
            }

            for pixel_y in 0..4 {
                for pixel_x in 0..4 {
                    let x = block_x * 4 + pixel_x;
                    let y = block_y * 4 + pixel_y;
                    if x >= width || y >= height {
                        continue;
                    }
                    let block_pixel = pixel_y * 4 + pixel_x;
                    let color_index = ((color_indices >> (block_pixel * 2)) & 0x03) as usize;
                    let mut color = colors[color_index];
                    if let Some(alpha_bits) = dxt3_alpha {
                        color[3] = (((alpha_bits >> (block_pixel * 4)) & 0x0f) * 17) as u8;
                    } else if format == b"DXT5" {
                        let alpha_index = ((alpha_indices >> (block_pixel * 3)) & 0x07) as usize;
                        color[3] = alpha_palette[alpha_index];
                    }
                    let output_offset = (y * width + x) * 4;
                    pixels[output_offset..output_offset + 4].copy_from_slice(&color);
                }
            }
        }
    }
    Ok(pixels)
}

fn dds_to_bmp(dds: &[u8], asset_id: &str) -> Result<Vec<u8>, String> {
    let read_u32 = |offset: usize| -> Result<u32, String> {
        let bytes = dds
            .get(offset..offset + 4)
            .ok_or_else(|| format!("The {asset_id} asset has a truncated DDS header."))?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    };
    if dds.get(0..4) != Some(b"DDS ") {
        return Err(format!("The {asset_id} asset is not a DDS file."));
    }
    let height = read_u32(12)? as usize;
    let width = read_u32(16)? as usize;
    let rgb_bits = read_u32(88)?;
    let masks = [read_u32(92)?, read_u32(96)?, read_u32(100)?, read_u32(104)?];
    let four_cc: [u8; 4] = dds
        .get(84..88)
        .ok_or_else(|| format!("The {asset_id} asset has a truncated DDS header."))?
        .try_into()
        .unwrap();
    if width == 0 || height == 0 || width > 4096 || height > 4096 {
        return Err(format!("The {asset_id} DDS dimensions are invalid."));
    }
    let pixel_bytes = width
        .checked_mul(height)
        .and_then(|value| value.checked_mul(4))
        .ok_or_else(|| format!("The {asset_id} DDS dimensions are invalid."))?;
    let source = dds
        .get(128..)
        .ok_or_else(|| format!("The {asset_id} DDS pixel data is truncated."))?;
    let pixels = if matches!(&four_cc, b"DXT1" | b"DXT3" | b"DXT5") {
        decode_dxt_pixels(source, width, height, &four_cc, asset_id)?
    } else if rgb_bits == 32
        && masks[0..3] == [0x00ff0000, 0x0000ff00, 0x000000ff]
        && matches!(masks[3], 0 | 0xff000000)
    {
        let source = source
            .get(..pixel_bytes)
            .ok_or_else(|| format!("The {asset_id} DDS pixel data is truncated."))?;
        let mut pixels = source.to_vec();
        if masks[3] == 0 {
            for pixel in pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
        }
        pixels
    } else if rgb_bits == 24 && masks == [0x00ff0000, 0x0000ff00, 0x000000ff, 0] {
        let source_bytes = width
            .checked_mul(height)
            .and_then(|value| value.checked_mul(3))
            .ok_or_else(|| format!("The {asset_id} DDS dimensions are invalid."))?;
        let source = source
            .get(..source_bytes)
            .ok_or_else(|| format!("The {asset_id} DDS pixel data is truncated."))?;
        let mut pixels = Vec::with_capacity(pixel_bytes);
        for pixel in source.chunks_exact(3) {
            pixels.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
        }
        pixels
    } else {
        return Err(format!(
            "The {asset_id} asset uses an unsupported DDS pixel format."
        ));
    };
    let file_size = 54usize
        .checked_add(pixel_bytes)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| format!("The {asset_id} asset is too large."))?;

    let mut bmp = Vec::with_capacity(file_size as usize);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&54u32.to_le_bytes());
    bmp.extend_from_slice(&40u32.to_le_bytes());
    bmp.extend_from_slice(&(width as i32).to_le_bytes());
    bmp.extend_from_slice(&(-(height as i32)).to_le_bytes());
    bmp.extend_from_slice(&1u16.to_le_bytes());
    bmp.extend_from_slice(&32u16.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    bmp.extend_from_slice(&0i32.to_le_bytes());
    bmp.extend_from_slice(&0i32.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&pixels);
    Ok(bmp)
}

fn attach_commander_portraits(
    result: &mut Value,
    project_root: &Path,
    sc2_root: Option<&Path>,
) -> Result<(), String> {
    let build = result
        .pointer("/database/sc2Build")
        .and_then(Value::as_str)
        .filter(|value| safe_portrait_cache_key(value))
        .map(str::to_string)
        .ok_or_else(|| "Commander database did not return a valid SC2 build.".to_string())?;
    let items = result
        .get_mut("items")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Commander database did not return a commander list.".to_string())?;
    let local_data_root = coopagent_local_data_root()?;
    let cache_root = local_data_root.join("portraits").join(&build);
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Unable to create the commander portrait cache: {error}"))?;

    let mut requests = Vec::new();
    for item in items.iter() {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_cache_key(value))
            .ok_or_else(|| "Commander database returned an invalid commander ID.".to_string())?;
        let casc_path = item
            .get("portraitCascPath")
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_casc_path(value))
            .ok_or_else(|| format!("Commander {id} has no usable game portrait."))?;
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() && !dds_path.is_file() {
            requests.push((casc_path.to_string(), format!("{id}.dds")));
        }
    }

    if !requests.is_empty() {
        let sc2_root = sc2_root.ok_or_else(|| {
            "Some commander portraits are not cached, and StarCraft II is not configured."
                .to_string()
        })?;
        let casc_manifest_path = local_data_root
            .join("casc")
            .join(&build)
            .join("manifest.json");
        let casc_manifest = fs::read_to_string(&casc_manifest_path)
            .map_err(|error| format!("Unable to read the CASC manifest: {error}"))
            .and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("CASC manifest is invalid: {error}"))
            })?;
        let casc_library = casc_manifest
            .pointer("/source/cascLibrary")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                "The CASC library recorded by the local extract is unavailable.".to_string()
            })?;
        let extractor = project_root.join("scripts/extract-casc-files.py");
        if !extractor.is_file() {
            return Err("The commander portrait extractor is missing.".to_string());
        }

        let mut command = Command::new("python");
        command
            .current_dir(project_root)
            .env("PATH", runtime_path(project_root)?)
            .arg(extractor)
            .arg("--sc2")
            .arg(sc2_root)
            .arg("--dll")
            .arg(casc_library)
            .arg("--output")
            .arg(&cache_root);
        for (source, file) in &requests {
            command.arg("--file").arg(format!("{source}={file}"));
        }
        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| {
                format!("Unable to start the commander portrait extractor: {error}")
            })?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                format!(
                    "Commander portrait extraction exited with {}.",
                    output.status
                )
            } else {
                error
            });
        }
    }

    for item in items.iter_mut() {
        let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() {
            let dds = fs::read(&dds_path)
                .map_err(|error| format!("Unable to read the {id} portrait: {error}"))?;
            let bmp = dds_to_bmp(&dds, id)?;
            fs::write(&bmp_path, bmp)
                .map_err(|error| format!("Unable to cache the {id} portrait: {error}"))?;
        }
        let bytes = fs::read(&bmp_path)
            .map_err(|error| format!("Unable to read the cached {id} portrait: {error}"))?;
        let data_url = format!("data:image/bmp;base64,{}", base64_encode(&bytes));
        item.as_object_mut()
            .ok_or_else(|| "Commander database returned an invalid item.".to_string())?
            .insert("portraitDataUrl".to_string(), Value::String(data_url));
    }
    Ok(())
}

fn attach_commander_perk_icons(
    result: &mut Value,
    project_root: &Path,
    sc2_root: Option<&Path>,
) -> Result<(), String> {
    let build = result
        .pointer("/database/sc2Build")
        .and_then(Value::as_str)
        .filter(|value| safe_portrait_cache_key(value))
        .map(str::to_string)
        .ok_or_else(|| "Commander database did not return a valid SC2 build.".to_string())?;
    let perks = result
        .get_mut("levelPerks")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| "Commander database did not return level perks.".to_string())?;
    let local_data_root = coopagent_local_data_root()?;
    let cache_root = local_data_root.join("perk-icons").join(&build);
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Unable to create the commander perk icon cache: {error}"))?;

    let mut requests = Vec::new();
    for perk in perks.iter() {
        let id = perk
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_cache_key(value))
            .ok_or_else(|| "Commander database returned an invalid perk ID.".to_string())?;
        let casc_path = perk
            .get("iconCascPath")
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_casc_path(value))
            .ok_or_else(|| format!("Commander perk {id} has no usable game icon."))?;
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() && !dds_path.is_file() {
            requests.push((casc_path.to_string(), format!("{id}.dds")));
        }
    }

    if !requests.is_empty() {
        let sc2_root = sc2_root.ok_or_else(|| {
            "Some commander perk icons are not cached, and StarCraft II is not configured."
                .to_string()
        })?;
        let casc_manifest_path = local_data_root
            .join("casc")
            .join(&build)
            .join("manifest.json");
        let casc_manifest = fs::read_to_string(&casc_manifest_path)
            .map_err(|error| format!("Unable to read the CASC manifest: {error}"))
            .and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("CASC manifest is invalid: {error}"))
            })?;
        let casc_library = casc_manifest
            .pointer("/source/cascLibrary")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                "The CASC library recorded by the local extract is unavailable.".to_string()
            })?;
        let extractor = project_root.join("scripts/extract-casc-files.py");
        if !extractor.is_file() {
            return Err("The commander perk icon extractor is missing.".to_string());
        }

        let mut command = Command::new("python");
        command
            .current_dir(project_root)
            .env("PATH", runtime_path(project_root)?)
            .arg(extractor)
            .arg("--sc2")
            .arg(sc2_root)
            .arg("--dll")
            .arg(casc_library)
            .arg("--output")
            .arg(&cache_root);
        for (source, file) in &requests {
            command.arg("--file").arg(format!("{source}={file}"));
        }
        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Unable to start the perk icon extractor: {error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                format!("Perk icon extraction exited with {}.", output.status)
            } else {
                error
            });
        }
    }

    for perk in perks.iter_mut() {
        let id = perk.get("id").and_then(Value::as_str).unwrap_or_default();
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() {
            let dds = fs::read(&dds_path)
                .map_err(|error| format!("Unable to read the {id} perk icon: {error}"))?;
            let bmp = dds_to_bmp(&dds, id)?;
            fs::write(&bmp_path, bmp)
                .map_err(|error| format!("Unable to cache the {id} perk icon: {error}"))?;
        }
        let bytes = fs::read(&bmp_path)
            .map_err(|error| format!("Unable to read the cached {id} perk icon: {error}"))?;
        let data_url = format!("data:image/bmp;base64,{}", base64_encode(&bytes));
        perk.as_object_mut()
            .ok_or_else(|| "Commander database returned an invalid perk.".to_string())?
            .insert("iconDataUrl".to_string(), Value::String(data_url));
    }
    Ok(())
}

fn attach_commander_roster_icons(
    result: &mut Value,
    project_root: &Path,
    sc2_root: Option<&Path>,
    roster_kind: &str,
) -> Result<(), String> {
    let (collection_pointer, id_field) = match roster_kind {
        "units" => ("/roster/units", "unitId"),
        "buildings" => ("/roster/buildings", "unitId"),
        "panel" => ("/panel/abilities", "id"),
        "panel-summons" => ("/panel/summonedUnits", "unitId"),
        _ => return Err("Commander icon collection type is invalid.".to_string()),
    };
    let build = result
        .pointer("/database/sc2Build")
        .and_then(Value::as_str)
        .filter(|value| safe_portrait_cache_key(value))
        .map(str::to_string)
        .ok_or_else(|| "Commander database did not return a valid SC2 build.".to_string())?;
    let commander_id = result
        .pointer("/commander/id")
        .and_then(Value::as_str)
        .filter(|value| safe_portrait_cache_key(value))
        .map(str::to_string)
        .ok_or_else(|| "Commander database did not return a valid commander ID.".to_string())?;
    let items = result
        .pointer_mut(collection_pointer)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("Commander database did not return {roster_kind} icons."))?;
    let local_data_root = coopagent_local_data_root()?;
    let cache_root = local_data_root
        .join("roster-icons")
        .join(&build)
        .join(&commander_id)
        .join(roster_kind);
    fs::create_dir_all(&cache_root)
        .map_err(|error| format!("Unable to create the commander roster icon cache: {error}"))?;

    let mut requests = Vec::new();
    for item in items.iter() {
        let id = item
            .get(id_field)
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_cache_key(value))
            .ok_or_else(|| "Commander database returned an invalid roster item ID.".to_string())?;
        let casc_path = item
            .get("iconCascPath")
            .and_then(Value::as_str)
            .filter(|value| safe_portrait_casc_path(value))
            .ok_or_else(|| format!("Commander roster item {id} has no usable game icon."))?;
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() && !dds_path.is_file() {
            requests.push((casc_path.to_string(), format!("{id}.dds")));
        }
    }

    if !requests.is_empty() {
        let sc2_root = sc2_root.ok_or_else(|| {
            "Some commander roster icons are not cached, and StarCraft II is not configured."
                .to_string()
        })?;
        let casc_manifest_path = local_data_root
            .join("casc")
            .join(&build)
            .join("manifest.json");
        let casc_manifest = fs::read_to_string(&casc_manifest_path)
            .map_err(|error| format!("Unable to read the CASC manifest: {error}"))
            .and_then(|text| {
                serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("CASC manifest is invalid: {error}"))
            })?;
        let casc_library = casc_manifest
            .pointer("/source/cascLibrary")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .ok_or_else(|| {
                "The CASC library recorded by the local extract is unavailable.".to_string()
            })?;
        let extractor = project_root.join("scripts/extract-casc-files.py");
        if !extractor.is_file() {
            return Err("The commander roster icon extractor is missing.".to_string());
        }

        let mut command = Command::new("python");
        command
            .current_dir(project_root)
            .env("PATH", runtime_path(project_root)?)
            .arg(extractor)
            .arg("--sc2")
            .arg(sc2_root)
            .arg("--dll")
            .arg(casc_library)
            .arg("--output")
            .arg(&cache_root);
        for (source, file) in &requests {
            command.arg("--file").arg(format!("{source}={file}"));
        }
        let output = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Unable to start the roster icon extractor: {error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                format!("Roster icon extraction exited with {}.", output.status)
            } else {
                error
            });
        }
    }

    for item in items.iter_mut() {
        let id = item
            .get(id_field)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let dds_path = cache_root.join(format!("{id}.dds"));
        let bmp_path = cache_root.join(format!("{id}.bmp"));
        if !bmp_path.is_file() {
            let dds = fs::read(&dds_path)
                .map_err(|error| format!("Unable to read the {id} roster icon: {error}"))?;
            let bmp = dds_to_bmp(&dds, id)?;
            fs::write(&bmp_path, bmp)
                .map_err(|error| format!("Unable to cache the {id} roster icon: {error}"))?;
        }
        let bytes = fs::read(&bmp_path)
            .map_err(|error| format!("Unable to read the cached {id} roster icon: {error}"))?;
        let data_url = format!("data:image/bmp;base64,{}", base64_encode(&bytes));
        item.as_object_mut()
            .ok_or_else(|| "Commander database returned an invalid roster item.".to_string())?
            .insert("iconDataUrl".to_string(), Value::String(data_url));
    }
    Ok(())
}

#[tauri::command]
async fn commander_list( project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    let sc2_root = optional_sc2_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root()?;
        let executable = node_path(&project_root)?;
        let bridge = project_root.join("runtime/coop-mcp/list-commanders.mjs");
        if !bridge.is_file() {
            return Err("The commander database bridge is missing.".to_string());
        }

        let output = Command::new(executable)
            .envs(projects::environment()?)
            .current_dir(&project_root)
            .env("PATH", runtime_path(&project_root)?)
            .arg(bridge)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Unable to query the commander database: {error}"))?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                format!("Commander database query exited with {}.", output.status)
            } else {
                error
            });
        }

        let mut result = serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|error| format!("Commander database returned invalid JSON: {error}"))?;
        attach_commander_portraits(
            &mut result,
            &project_root,
            sc2_root.as_deref().map(Path::new),
        )?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("Commander database task failed: {error}"))?
}

#[tauri::command]
async fn commander_get(commander_id: String, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    if !safe_portrait_cache_key(&commander_id) {
        return Err("Commander ID is invalid.".to_string());
    }
    let sc2_root = optional_sc2_root()?;

    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root()?;
        let executable = node_path(&project_root)?;
        let bridge = project_root.join("runtime/coop-mcp/get-commander.mjs");
        if !bridge.is_file() {
            return Err("The commander database bridge is missing.".to_string());
        }

        let output = Command::new(executable)
            .envs(projects::environment()?)
            .current_dir(&project_root)
            .env("PATH", runtime_path(&project_root)?)
            .arg(bridge)
            .arg(commander_id)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Unable to query the commander database: {error}"))?;

        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if error.is_empty() {
                format!("Commander database query exited with {}.", output.status)
            } else {
                error
            });
        }

        let mut result = serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|error| format!("Commander database returned invalid JSON: {error}"))?;
        let sc2_root = sc2_root.as_deref().map(Path::new);
        attach_commander_perk_icons(&mut result, &project_root, sc2_root)?;
        attach_commander_roster_icons(&mut result, &project_root, sc2_root, "units")?;
        attach_commander_roster_icons(
            &mut result,
            &project_root,
            sc2_root,
            "buildings",
        )?;
        attach_commander_roster_icons(&mut result, &project_root, sc2_root, "panel")?;
        attach_commander_roster_icons(
            &mut result,
            &project_root,
            sc2_root,
            "panel-summons",
        )?;
        Ok(result)
    })
    .await
    .map_err(|error| format!("Commander database task failed: {error}"))?
}

#[tauri::command]
async fn change_summary_list( project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let project_root = project_root()?;
        let executable = node_path(&project_root)?;
        let bridge = project_root.join("runtime/coop-mcp/get-change-summaries.mjs");
        if !bridge.is_file() {
            return Err("The change-summary database bridge is missing.".to_string());
        }
        let output = Command::new(executable)
            .envs(projects::environment()?)
            .current_dir(&project_root)
            .env("PATH", runtime_path(&project_root)?)
            .arg(bridge)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("Unable to query applied change summaries: {error}"))?;
        if !output.status.success() {
            let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let diagnostic = error.lines().rev().find_map(|line| serde_json::from_str::<Value>(line).ok().filter(|v| v["message"].is_string()));
            let message = if let Some(diagnostic) = &diagnostic {
                diagnostic["message"].as_str().unwrap().to_string()
            } else if error.is_empty() {
                format!("Change-summary query exited with {}.", output.status)
            } else {
                error
            };
            app_log("error", "change_summary.query_failed", serde_json::json!({
                "message": &message,
                "exitCode": output.status.code(),
                "diagnostic": diagnostic,
                "project": projects::context()?,
            }));
            return Err(message);
        }
        serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|error| format!("Change-summary query returned invalid JSON: {error}"))
    })
    .await
    .map_err(|error| format!("Change-summary task failed: {error}"))?
}

#[tauri::command]
async fn game_a_editor_launch(state: State<'_, AgentState>, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    let busy = AgentBusyGuard::acquire(&state)?;
    let sc2_installation = require_sc2_installation()?;
    let sc2_root = sc2_installation
        .root_path
        .ok_or_else(|| "StarCraft II path is unavailable.".to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let project_root = project_root()?;
        let mut trace = TraceWriter::create()?;
        let run_id = trace.run_id().to_string();
        let trace_path = trace.display_path();
        let _ = trace.append(
            "run.created",
            "ok",
            serde_json::json!({ "source": "manual_game_a_editor_launch", "tracePath": trace_path }),
        );
        let _ = trace.append("game_a.editor_launch.started", "running", serde_json::json!({}));
        match launch_game_a_editor(&project_root, &sc2_root) {
            Ok(mut result) => {
                let _ = trace.append(
                    "game_a.editor_launch.completed",
                    "ok",
                    result.clone(),
                );
                let _ = trace.append("run.completed", "ok", serde_json::json!({}));
                if let Some(object) = result.as_object_mut() {
                    object.insert("runId".to_string(), Value::String(run_id));
                    object.insert("tracePath".to_string(), Value::String(trace_path));
                    if let Some(build) = latest_game_a_build(&project_root) {
                        object.insert("build".to_string(), build);
                    }
                }
                Ok(result)
            }
            Err(error) => {
                let _ = trace.append(
                    "game_a.editor_launch.failed",
                    "error",
                    serde_json::json!({ "message": error }),
                );
                let _ = trace.append(
                    "run.failed",
                    "error",
                    serde_json::json!({ "stage": "game_a_editor_launch", "message": error }),
                );
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| format!("Map Runtime editor launch task failed: {error}"))?
}

fn run_plan_jobs_command(operation: &str, value: Option<&str>) -> Result<Value, String> {
    let root = project_root()?;
    let mut command = Command::new(node_path(&root)?);
    command.current_dir(&root).env("PATH", runtime_path(&root)?)
        .arg(root.join("scripts/plan-submission.mjs")).arg(operation);
    if let Some(value) = value { command.arg(value); }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    projects::configure(&mut command)?;
    let output = command.output().map_err(|error| format!("Cannot access submission jobs: {error}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|error| format!("Invalid submission job result: {error}"))
}

fn run_agent_task_command(operation: &str, value: Value) -> Result<Value, String> {
    let root = project_root()?;
    let mut command = Command::new(node_path(&root)?);
    command.current_dir(&root).env("PATH", runtime_path(&root)?)
        .arg(root.join("scripts/agent-task.mjs")).arg(operation).arg(projects::workspace()?)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    projects::configure(&mut command)?;
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(value.to_string().as_bytes()).map_err(|error| error.to_string())?;
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).trim().to_string()); }
    serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())
}

#[tauri::command]
async fn agent_task_status( project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    tauri::async_runtime::spawn_blocking(|| run_agent_task_command("get", serde_json::json!({})))
        .await.map_err(|error| error.to_string())?
}

struct AgentPhaseGuard { context: Value, ended: bool }
fn phase_session(task: &Value, requested: Option<&str>, first_phase: bool, resumed: bool) -> Option<String> {
    task.get("modelSessionId").and_then(Value::as_str)
        .or_else(|| if first_phase && !resumed { requested } else { None })
        .filter(|id| is_valid_agent_session_id(id)).map(str::to_string)
}
impl AgentPhaseGuard {
    fn finish(&mut self, reason: &str) -> Result<Value, String> {
        let mut input = self.context.clone(); input["reason"] = reason.into();
        let task = run_agent_task_command("finish", input)?;
        self.ended = true; Ok(task)
    }
}
impl Drop for AgentPhaseGuard {
    fn drop(&mut self) { if !self.ended { let _ = self.finish("error"); } }
}

#[tauri::command]
async fn plan_submission_status( project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    tauri::async_runtime::spawn_blocking(|| run_plan_jobs_command("status", None))
        .await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn plan_submission_retry(state: State<'_, AgentState>, preparation_id: String, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    let busy = AgentBusyGuard::acquire(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        retry_plan_submission(&preparation_id)
    }).await.map_err(|error| error.to_string())?
}

fn retry_plan_submission(preparation_id: &str) -> Result<Value, String> {
    if !preparation_id.starts_with("prep-") || preparation_id.len() != 53 ||
        !preparation_id[5..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid preparationId".to_string());
    }
    // The backend only retries already selected jobs, never a mere check.
    run_plan_jobs_command("submit", Some(preparation_id))
}

#[tauri::command]
async fn patch_plan_apply_confirmed(
    state: State<'_, AgentState>,
    plan_path: String,
    approved_plan_sha256: String,
    run_id: String, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    if !is_approved_draft_path(&plan_path) {
        return Err(
            "Only checked PatchPlans under game-a/drafts can be applied from the desktop UI."
                .to_string(),
        );
    }
    if approved_plan_sha256.len() != 64
        || !approved_plan_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("A valid approved PatchPlan SHA-256 is required.".to_string());
    }

    validate_checked_plan_run(&read_trace_records(&run_id)?, &plan_path, &approved_plan_sha256)?;
    let busy = AgentBusyGuard::acquire(&state)?;

    tauri::async_runtime::spawn_blocking(move || {
        let _busy = busy;
        let mut trace = TraceWriter::open(&run_id)?;
        let project_root = project_root()?;
        let executable = node_path(&project_root)?;
        let bridge = project_root.join("runtime/coop-mcp/apply-approved-draft.mjs");
        let _ = trace.append(
            "patch_plan.auto_apply.requested",
            "ok",
            serde_json::json!({
                "planPath": plan_path,
                "approvedFileSha256": approved_plan_sha256,
            }),
        );
        let _ = trace.append(
            "patch_plan.apply.started",
            "running",
            serde_json::json!({ "planPath": plan_path }),
        );
        if !bridge.is_file() {
            let message = "The PatchPlan approval bridge is missing.".to_string();
            let _ = trace.append(
                "patch_plan.apply.failed",
                "error",
                serde_json::json!({ "planPath": plan_path, "message": message }),
            );
            return Err(message);
        }

        let output = match Command::new(executable)
            .envs(projects::environment()?)
            .current_dir(&project_root)
            .env("PATH", runtime_path(&project_root)?)
            .arg(bridge)
            .arg(&plan_path)
            .arg(&approved_plan_sha256)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(output) => output,
            Err(error) => {
                let message = format!("Unable to start the PatchPlan executor: {error}");
                let _ = trace.append(
                    "patch_plan.apply.failed",
                    "error",
                    serde_json::json!({ "planPath": plan_path, "message": message }),
                );
                return Err(message);
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let message = if stderr.is_empty() {
                format!("PatchPlan executor exited with {}.", output.status)
            } else {
                stderr
            };
            let _ = trace.append(
                "patch_plan.apply.failed",
                "error",
                serde_json::json!({
                    "planPath": plan_path,
                    "exitCode": output.status.code(),
                    "message": message,
                }),
            );
            return Err(message);
        }

        let mut result = match serde_json::from_slice::<Value>(&output.stdout) {
            Ok(result) => result,
            Err(error) => {
                let message = format!("PatchPlan executor returned invalid JSON: {error}");
                let _ = trace.append(
                    "patch_plan.apply.failed",
                    "error",
                    serde_json::json!({ "planPath": plan_path, "message": message }),
                );
                return Err(message);
            }
        };
        let _ = trace.append(
            "patch_plan.applied",
            "ok",
            serde_json::json!({
                "planPath": result.get("planPath"),
                "approvedFileSha256": result.get("planSha256"),
                "planId": result.pointer("/report/id"),
                "receiptPath": result.pointer("/report/receiptRecord"),
                "receiptPlanSha256": result.pointer("/report/receipt/planSha256"),
                "coreTreeBeforeSha256": result.pointer("/report/receipt/coreTreeBeforeSha256"),
                "coreTreeAfterSha256": result.pointer("/report/receipt/coreTreeAfterSha256"),
                "changedFiles": result.pointer("/report/changedFiles"),
                "verificationLevel": result.pointer("/review/userSummary/verificationLevel"),
                "runtimeVerified": result.pointer("/review/userSummary/runtimeVerified"),
            }),
        );

        let runtime_launch = serde_json::json!({
            "status": "skipped",
            "reason": "Map Runtime is launched only when the user explicitly requests it."
        });
        let _ = trace.append(
            "run.completed",
            "ok",
            serde_json::json!({
                "patchApplied": true,
                "runtimeLaunched": false,
                "launchPolicy": "manual",
            }),
        );

        if let Some(object) = result.as_object_mut() {
            object.insert("runtimeLaunch".to_string(), runtime_launch);
            object.insert("runId".to_string(), Value::String(run_id));
            object.insert("tracePath".to_string(), Value::String(trace.display_path()));
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("PatchPlan approval task failed: {error}"))?
}

#[tauri::command]
async fn agent_cancel(state: State<'_, AgentState>, run_id: String, project: Option<ProjectToken>) -> Result<Value, String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    let control = active_agent_run(&state, &run_id)?;
    tauri::async_runtime::spawn_blocking(move || cancel_agent_run(&control))
        .await.map_err(|error| error.to_string())?
}

fn active_agent_run(state: &AgentState, run_id: &str) -> Result<AgentRunControl, String> {
    let control = state.active.lock().map_err(|_| "Agent state lock poisoned".to_string())?
        .as_ref().filter(|run| run.run_id == run_id).cloned()
        .ok_or_else(|| "该轮模型任务已结束或已切换；提交结果请查看后端状态。".to_string())?;
    Ok(control)
}

fn cancel_agent_run(control: &AgentRunControl) -> Result<Value, String> {
    control.cancel_with(|| run_plan_jobs_command("cancel-run", Some(&control.run_id)).map(|_| ()))?;
    Ok(serde_json::json!({ "status": "cancel-requested", "runId": control.run_id }))
}

#[tauri::command]
fn agent_start(
    state: State<'_, AgentState>,
    prompt: String,
    session_id: Option<String>,
    task_id: Option<String>,
    on_event: Channel<AgentEvent>, project: Option<ProjectToken>) -> Result<(), String> {
    let _project_lease = projects::acquire(project.as_ref(), false)?;
    start_agent_run(&state, prompt, session_id, task_id, on_event)
}

fn start_agent_run(
    state: &AgentState,
    prompt: String,
    session_id: Option<String>,
    resume_task_id: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Result<(), String> {
    if state.closing.load(Ordering::Acquire) { return Err("CoopAgent 正在停止任务并关闭。".into()); }
    let project_lease = projects::acquire(None, true)?;
    let confirmation_answer = prompt.trim().to_string();
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err("Agent prompt cannot be empty.".to_string());
    }
    if prompt.chars().count() > 20_000 {
        return Err("Agent prompt is too long.".to_string());
    }

    let session_id = session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(existing_session) = session_id.as_deref() {
        load_agent_session(existing_session)?;
    }

    let sc2_root = optional_sc2_root()?;

    let project_root = project_root()?;
    let executable = opencode_path(&project_root)?;
    let path = runtime_path(&project_root)?;
    let project_environment = projects::environment()?;
    let workspace = projects::workspace()?;
    let model_config = model_config_path().ok().filter(|path| path.is_file());
    let selected_model = load_model_catalog()
        .ok()
        .and_then(|catalog| catalog.selected_model);
    if state
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("CoopAgent is already handling another request.".to_string());
    }

    let running = Arc::clone(&state.running);
    let mut trace = match TraceWriter::create() {
        Ok(trace) => trace,
        Err(error) => {
            running.store(false, Ordering::Release);
            return Err(error);
        }
    };
    let run_id = trace.run_id().to_string();
    let task = match run_agent_task_command("begin", serde_json::json!({
        "id": format!("task-{run_id}"), "runId": run_id, "prompt": prompt, "resumeId": resume_task_id,
        "answer": confirmation_answer,
    })) {
        Ok(task) => task,
        Err(error) => { running.store(false, Ordering::Release); return Err(error); }
    };
    let task_id = task["id"].as_str().expect("validated task id").to_string();
    let trace_path = trace.display_path();
    let control = AgentRunControl::new(run_id.clone());
    match state.active.lock() {
        Ok(mut active) => *active = Some(control.clone()),
        Err(_) => { running.store(false, Ordering::Release); return Err("Agent state lock poisoned".to_string()); }
    }
    let active = Arc::clone(&state.active);
    *state.snapshot.lock().unwrap_or_else(|error| error.into_inner()) = Some(AgentRunSnapshot {
        run_id: run_id.clone(), trace_path: trace_path.clone(), prompt: prompt.clone(),
        started_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        session_id: session_id.clone(), state: "starting".into(), text: String::new(),
        activity: "正在启动 Agent…".into(), error: None, sequence: 0, task: Some(task),
    });
    let on_event = AgentEventSink { project: projects::context()?.map(serde_json::from_value).transpose().map_err(|e| e.to_string())?, channel: on_event, run_id: run_id.clone(), snapshot: Arc::clone(&state.snapshot) };

    thread::spawn(move || {
        let _project_lease = project_lease;
        let mut busy = AgentBusyGuard(Some(Arc::clone(&running)));
        let _active_guard = ActiveAgentGuard { active, run_id: run_id.clone() };
        let _ = trace.append(
            "run.created",
            "ok",
            serde_json::json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "tracePath": trace_path,
            }),
        );
        let _ = trace.append(
            "request.received",
            "ok",
            serde_json::json!({
                "prompt": prompt,
                "existingSessionId": session_id,
                "model": selected_model,
            }),
        );
        send_agent_event(
            &on_event,
            AgentEvent::Started {
                run_id: run_id.clone(),
                trace_path: trace_path.clone(),
            },
        );
        let mut first_phase = true;
        loop {
        if control.cancelled.load(Ordering::Acquire) {
            let _ = trace.append("run.cancelled", "cancelled", serde_json::json!({ "betweenPhases": true }));
            send_agent_event(&on_event, AgentEvent::Cancelled { run_id: run_id.clone(), session_id: None,
                message: "任务已停止；已保存的阶段可继续。".into() });
            return;
        }
        let opened = match run_agent_task_command("open", serde_json::json!({ "id": task_id, "runId": run_id })) {
            Ok(value) => value,
            Err(message) => {
                let _ = trace.append("run.failed", "error", serde_json::json!({ "stage": "phase_open", "message": message }));
                send_agent_event(&on_event, AgentEvent::Error { run_id: run_id.clone(), message, session_id: None });
                return;
            }
        };
        let phase = opened["task"]["phase"].as_u64().expect("task phase");
        let mut phase_guard = AgentPhaseGuard { context: serde_json::json!({ "id": task_id, "runId": run_id, "phase": phase }), ended: false };
        let _ = trace.append("task.phase.started", "running", opened["task"].clone());
        send_agent_event(&on_event, AgentEvent::Phase { task: opened["task"].clone() });
        let mut command = Command::new(&executable);
        command.current_dir(&workspace).envs(project_environment.iter().map(|(k,v)| (k,v))).env("PATH", &path).env("COOPAGENT_RUN_ID", &run_id)
            .env("COOPAGENT_TASK_ID", &task_id).env("COOPAGENT_TASK_PHASE", phase.to_string()).args([
                "run",
                "--agent",
                "coop-planner",
                "--format",
                "json",
                "--thinking",
            ]);
        if let Some(sc2_root) = &sc2_root {
            command.env("COOPAGENT_SC2_ROOT", sc2_root);
        }
        if let Some(config_path) = &model_config {
            command.env("OPENCODE_CONFIG", config_path);
        }
        if let Some(model) = selected_model.as_deref() {
            command.args(["--model", model]);
        }
        if let Some(existing_session) = phase_session(&opened["task"], session_id.as_deref(), first_phase, resume_task_id.is_some()) {
            command.args(["--session", &existing_session]);
        }
        command
            .arg(opened["prompt"].as_str().expect("phase prompt"))
            // This is a non-interactive run. Never let the model process read
            // its parent's control stream (the test host uses stdin for RPC).
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }

        let mut child = match command.spawn() {
            Ok(child) => {
                let _ = trace.append(
                    "agent.process.started",
                    "running",
                    serde_json::json!({ "agent": "coop-planner", "processId": child.id() }),
                );
                child
            }
            Err(error) => {
                let message = format!("Unable to start CoopAgent: {error}");
                let _ = trace.append(
                    "agent.process.failed",
                    "error",
                    serde_json::json!({ "message": message }),
                );
                let _ = trace.append(
                    "run.failed",
                    "error",
                    serde_json::json!({ "stage": "agent_start", "message": message }),
                );
                send_agent_event(
                    &on_event,
                    AgentEvent::Error {
                        run_id: run_id.clone(),
                        message,
                        session_id: session_id.clone(),
                    },
                );
                busy.release();
                return;
            }
        };
        let stderr = child.stderr.take();
        let stdout = child.stdout.take();
        {
            let mut slot = control.child.lock().unwrap_or_else(|error| error.into_inner());
            if control.cancelled.load(Ordering::Acquire) { let _ = child.kill(); }
            *slot = Some(child);
        }
        let (output_sender, output_receiver) = mpsc::channel();
        let observer_sender = output_sender.clone();
        let observer_run_id = run_id.clone();
        let stderr_reader = thread::spawn(move || {
            let mut text = String::new();
            if let Some(stream) = stderr {
                for line in BufReader::new(stream).lines().map_while(Result::ok) {
                    if let Some(payload) = line.strip_prefix("COOPAGENT_OBSERVATION ") {
                        if serde_json::from_str::<Value>(payload).ok().is_some_and(|e|
                            e.get("runId").and_then(Value::as_str) == Some(observer_run_id.as_str())) {
                            if observer_sender.send(Ok(payload.to_string())).is_err() { break; }
                        }
                    } else if text.len() < 65536 {
                        // Keep ordinary diagnostics bounded, separate from observations.
                        text.extend(line.chars().take(65536 - text.len()));
                        text.push('\n');
                    }
                }
            }
            text
        });

        let mut discovered_session = None;
        let mut assistant_text = String::new();
        let mut observations = AgentObservationState::default();
        let mut plan_ready = false;
        let mut output_error = None;
        thread::spawn(move || {
            if let Some(stdout) = stdout {
                for line in BufReader::new(stdout).lines() {
                    if output_sender.send(line).is_err() { break; }
                }
            }
        });
        first_phase = false;
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let stop_at = Cell::new(opened["task"]["deadline"].as_u64()
            .map(|deadline| Instant::now() + Duration::from_millis(deadline.saturating_sub(now_ms))));
        let mut timed_out = false;
        let mut phase_task = None;
        let harness_stop = AtomicBool::new(false);
        let mut check_deadline = || {
            if !control.cancelled.load(Ordering::Acquire) && (harness_stop.load(Ordering::Acquire)
                || stop_at.get().is_some_and(|deadline| Instant::now() >= deadline)) {
                timed_out = true;
                // Freeze the phase before stopping only the owned model.
                // A phase yield must not cancel the independent committer.
                match phase_guard.finish("budget") {
                    Ok(task) => {
                        send_agent_event(&on_event, AgentEvent::Phase { task: task.clone() });
                        phase_task = Some(task);
                        if let Some(child) = control.child.lock().unwrap_or_else(|e| e.into_inner()).as_mut() { let _ = child.kill(); }
                    }
                    Err(message) => {
                        let _ = control.cancel_with(|| run_plan_jobs_command("cancel-run", Some(&run_id)).map(|_| ()));
                        send_agent_event(&on_event, AgentEvent::Activity { label: format!("阶段保存失败，正在停止：{message}") });
                    }
                }
                stop_at.set(Some(Instant::now() + Duration::from_secs(5)));
            }
        };
        let mut confirmation_stopped = false;
        loop {
            check_deadline();
            let line = match output_receiver.recv_timeout(Duration::from_millis(200)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            // Drain queued tool/usage observations even after cancellation.
            // They describe facts; they do not authorize or initiate writes.
            let cancelled_text = control.cancelled.load(Ordering::Acquire) && line.as_ref().ok()
                .and_then(|s| serde_json::from_str::<Value>(s).ok())
                .is_some_and(|e| matches!(e.get("type").and_then(Value::as_str), Some("text" | "step_start")));
            if !cancelled_text {
                match line {
                    Ok(line) => handle_agent_json_line(
                        &line,
                        &on_event,
                        &mut discovered_session,
                        &mut assistant_text,
                        &mut observations,
                        &mut plan_ready,
                        &mut trace,
                    ),
                    Err(error) => {
                        let message = format!("Unable to read CoopAgent output: {error}");
                        let _ = trace.append(
                            "agent.output.failed",
                            "error",
                            serde_json::json!({ "message": message }),
                        );
                        // A broken output stream does not prove process exit.
                        output_error = Some(message);
                        break;
                    }
                }
            }
            if observations.harness_stop_requested {
                harness_stop.store(true, Ordering::Release);
            }
            if let Some((waiting, remaining_ms)) = observations.harness_deadline_update.take() {
                // Submission observation is outside the model work budget, but
                // it remains bounded by the MCP/tool timeout instead of waiting
                // forever. Once it returns, only the active remainder is used.
                const SUBMISSION_WAIT_HARD_MS: u64 = 240_000;
                let allowance = if waiting { remaining_ms.saturating_add(SUBMISSION_WAIT_HARD_MS) }
                    else { remaining_ms };
                stop_at.set(Some(Instant::now() + Duration::from_millis(allowance)));
            }
            if observations.confirmation_requested && !confirmation_stopped {
                confirmation_stopped = true;
                // The task is already durably fenced. Stop only this model, not submission jobs.
                if let Some(child) = control.child.lock().unwrap_or_else(|error| error.into_inner()).as_mut() {
                    let _ = child.kill();
                }
            }
        }

        // Never hold the Child mutex across a blocking wait: cancellation needs
        // this exact process handle even when stdout has already closed.
        let status = loop {
            check_deadline();
            let observed = control.child.lock().unwrap_or_else(|error| error.into_inner())
                .as_mut().expect("owned Agent process").try_wait();
            match observed {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
            }
        };
        drop(check_deadline);
        let stderr = stderr_reader.join().unwrap_or_default();
        observations.finish(&mut trace);
        if let Some(id) = discovered_session.as_deref() {
            phase_guard.context["sessionId"] = id.into();
        }
        if !assistant_text.trim().is_empty() {
            phase_guard.context["assistantText"] = assistant_text.clone().into();
        }
        let task = match phase_guard.finish(if control.cancelled.load(Ordering::Acquire) { "cancelled" }
            else if timed_out { "budget" }
            else if observations.confirmation_requested { "completed" }
            else if output_error.is_some() || !status.as_ref().is_ok_and(|s| s.success()) { "error" } else { "completed" }).ok().or(phase_task) {
            Some(task) => task,
            None => {
                let message = "无法保存工作阶段；请保留轨迹检查，不要把它视为完成。".to_string();
                let _ = trace.append("run.failed", "error", serde_json::json!({ "message": message }));
                send_agent_event(&on_event, AgentEvent::Error { run_id: run_id.clone(), message, session_id: discovered_session });
                return;
            }
        };
        let _ = trace.append("task.phase.ended", "ok", serde_json::json!({ "task": task, "sessionId": discovered_session, "budgetExpired": timed_out }));
        send_agent_event(&on_event, AgentEvent::Phase { task: task.clone() });
        // Submission is an explicit backend job; Complete is not write intent.
        if control.cancelled.load(Ordering::Acquire) {
            let message = "模型已停止；已保存的阶段可继续。";
            let _ = trace.append("run.cancelled", "cancelled", serde_json::json!({ "timeout": timed_out }));
            send_agent_event(&on_event, AgentEvent::Cancelled { run_id: run_id.clone(),
                message: format!("{message} 尚未提交的方案不会应用；已进入提交的任务以后台结果为准，不会强杀提交进程。"),
                session_id: discovered_session.or_else(|| session_id.clone()) });
            return;
        }
        if task["status"] == "ready" {
            send_agent_event(&on_event, AgentEvent::Activity { label: "本阶段已保存，正在继续下一阶段…".into() });
            continue;
        }
        if task["status"] == "awaiting_confirmation" || (["paused", "blocked"].iter().any(|s| task["status"] == *s)
            && (timed_out || (output_error.is_none() && status.as_ref().is_ok_and(|s| s.success())))) {
            let _ = trace.append("run.paused", "paused", serde_json::json!({ "taskId": task_id, "sessionId": discovered_session }));
            send_agent_event(&on_event, AgentEvent::Paused { run_id: run_id.clone(), task, session_id: discovered_session });
            return;
        }
        if task["status"] == "submitted" {
            let _ = trace.append("run.completed", "ok", serde_json::json!({ "taskId": task_id, "submissionPolicy": "explicit-backend-job" }));
            send_agent_event(&on_event, AgentEvent::SubmissionChanged {});
            send_agent_event(&on_event, AgentEvent::Complete { run_id: run_id.clone(), session_id: discovered_session });
            return;
        }
        if task["status"] == "ended" {
            let _ = trace.append("run.completed", "ok", serde_json::json!({ "taskId": task_id,
                "turnStatus": "ended", "deliveryOutcome": task.get("deliveryOutcome"), "budgetExpired": timed_out }));
            if timed_out && assistant_text.trim().is_empty() {
                send_agent_event(&on_event, AgentEvent::Paused { run_id: run_id.clone(), task,
                    session_id: discovered_session.or_else(|| session_id.clone()) });
            } else {
                send_agent_event(&on_event, AgentEvent::Complete { run_id: run_id.clone(),
                    session_id: discovered_session.or_else(|| session_id.clone()) });
            }
            return;
        }
        if let Some(message) = output_error {
            let _ = trace.append("run.failed", "error", serde_json::json!({ "stage": "agent_output", "message": message }));
            send_agent_event(&on_event, AgentEvent::Error { run_id: run_id.clone(), message,
                session_id: discovered_session.or_else(|| session_id.clone()) });
            return;
        }
        match status {
            Ok(status) if status.success() => {
                let _ = trace.append(
                    "agent.response.completed",
                    "ok",
                    serde_json::json!({
                        "sessionId": discovered_session,
                        "text": assistant_text,
                    }),
                );
                let _ = trace.append(
                    "agent.completed",
                    "ok",
                    serde_json::json!({ "sessionId": discovered_session }),
                );
                let _ = trace.append(
                    "run.completed",
                    "ok",
                    serde_json::json!({ "planReady": plan_ready, "submissionPolicy": "explicit-backend-job" }),
                );
                send_agent_event(
                    &on_event,
                    AgentEvent::Complete {
                        run_id: run_id.clone(),
                        session_id: discovered_session.or_else(|| session_id.clone()),
                    },
                );
            }
            Ok(status) => {
                let message = if stderr.trim().is_empty() {
                    format!("CoopAgent exited with {status}.")
                } else {
                    stderr.trim().to_string()
                };
                let _ = trace.append(
                    "agent.failed",
                    "error",
                    serde_json::json!({ "message": message, "exitCode": status.code() }),
                );
                let _ = trace.append(
                    "run.failed",
                    "error",
                    serde_json::json!({ "stage": "agent", "message": message }),
                );
                send_agent_event(
                    &on_event,
                    AgentEvent::Error {
                        run_id: run_id.clone(),
                        message,
                        session_id: discovered_session
                            .clone()
                            .or_else(|| session_id.clone()),
                    },
                );
            }
            Err(error) => {
                let message = format!("Unable to wait for CoopAgent: {error}");
                let _ = trace.append(
                    "agent.failed",
                    "error",
                    serde_json::json!({ "message": message }),
                );
                let _ = trace.append(
                    "run.failed",
                    "error",
                    serde_json::json!({ "stage": "agent_wait", "message": message }),
                );
                send_agent_event(
                    &on_event,
                    AgentEvent::Error {
                        run_id: run_id.clone(),
                        message,
                        session_id: discovered_session.or_else(|| session_id.clone()),
                    },
                );
            }
        }
        return;
        }
    });

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_desktop(false);
}

fn run_desktop(_test_stdio: bool) {
    initialize_application_logging();
    tauri::Builder::default()
        .manage(AgentState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if request_agent_shutdown(window.app_handle()) { api.prevent_close(); }
            }
        })
        .setup(move |app| {
            #[cfg(all(feature = "agent-test", debug_assertions))]
            if _test_stdio {
                agent_test_api::attach_desktop(app.handle().clone())?;
                return Ok(());
            }
            if let Err(error) = projects::initialize() {
                app_log("error", "application.setup.failed", serde_json::json!({ "stage": "projects", "message": &error }));
                // Keep the shell available so project_list can report/retry.
                return Ok(());
            }
            if projects::context()?.is_none() {
                app_log("info", "application.ready", serde_json::json!({ "project": null }));
                return Ok(());
            }
            if projects::context()?.is_some_and(|c| !c["openError"].is_null()) { return Ok(()); }
            // Resume only durable selections after restart, independently of
            // which page is mounted. Mere preparations are never submitted.
            let state = app.state::<AgentState>();
            if let Ok(busy) = AgentBusyGuard::acquire(&state) {
                thread::spawn(move || {
                    let _busy = busy;
                    if let Err(error) = run_plan_jobs_command("recover", None) {
                        app_log("error", "submission.recovery.failed", serde_json::json!({ "message": &error }));
                        eprintln!("Submission recovery: {error}");
                    }
                });
            }
            app_log("info", "application.ready", serde_json::json!({ "project": projects::context()? }));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            projects::project_list,
            projects::project_change,
            projects::project_ui,
            clipboard_write,
            open_log_directory,
            sc2_installation_status,
            sc2_installation_set,
            model_list,
            model_save,
            model_select,
            model_delete,
            agent_session_list,
            agent_session_read,
            agent_session_delete,
            commander_list,
            commander_get,
            change_summary_list,
            agent_start,
            agent_cancel,
            agent_snapshot,
            agent_task_status,
            plan_submission_status,
            plan_submission_retry,
            game_a_editor_launch,
            game_a_editor_status,
            patch_plan_apply_confirmed
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                app_log("info", "application.exit_requested", serde_json::json!({}));
                if request_agent_shutdown(app) { api.prevent_exit(); }
            }
            tauri::RunEvent::Exit => app_log("info", "application.exited", serde_json::json!({})),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn desktop_resources_follow_the_executable_checkout_instead_of_the_compile_path() {
        let base = std::env::temp_dir().join(format!("coop-desktop-roots-{}", super::new_run_id()));
        for copy in ["original", "moved copy"] {
            let root = base.join(copy);
            for file in ["src-tauri/tauri.conf.json", "runtime/coop-mcp/server.mjs", "opencode.json"] {
                let path = root.join(file);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, "fixture").unwrap();
            }
            let exe = root.join("src-tauri/target/release/coopagent.exe");
            assert_eq!(super::application_root_from_executable(&exe), Some(root));
        }
        assert_eq!(super::application_root_from_executable(&base.join("unrelated/coopagent.exe")), None);
        assert!(base.parent().is_some_and(|p| p == std::env::temp_dir()));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn editor_launch_requires_document_confirmation_and_keeps_manual_start_guidance() {
        for manual in [false, true] {
            let line = serde_json::json!({"status":"ok", "editor":"opened",
                "documentName":"GameA-Test-abcdef123456.SC2Map", "manualStartRequired":manual});
            let result = super::parse_editor_launch_result(&format!("build output\r\nCOOPAGENT_EDITOR_RESULT {line}\r\n")).unwrap();
            assert_eq!(result["documentName"], "GameA-Test-abcdef123456.SC2Map");
            assert_eq!(result["manualStartRequired"], manual);
        }
        for stdout in ["build completed", "{\"status\":\"ok\",\"editor\":\"launched\"}",
            "COOPAGENT_EDITOR_RESULT broken",
            "COOPAGENT_EDITOR_RESULT {\"status\":\"ok\",\"editor\":\"opened\",\"documentName\":\"\",\"manualStartRequired\":false}"] {
            assert!(super::parse_editor_launch_result(stdout).is_err());
        }
    }

    #[test]
    fn application_log_records_individually_valid_json_lines() {
        let path = std::env::temp_dir().join(format!("coopagent-app-log-{}.jsonl", super::new_run_id()));
        super::write_application_log_record(&path, "info", "test.started", serde_json::json!({ "value": 1 }))
            .expect("first application event should be written");
        super::write_application_log_record(&path, "error", "test.failed", serde_json::json!({ "message": "fixture" }))
            .expect("second application event should be written");
        let records = std::fs::read_to_string(&path).expect("application log should be readable").lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("line should be valid JSON"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["logVersion"], 1);
        assert_eq!(records[0]["event"], "test.started");
        assert_eq!(records[1]["level"], "error");
        std::fs::remove_file(path).expect("test application log should be removable");
    }

    #[test]
    #[cfg(windows)]
    fn setup_selection_is_readable_and_valid_for_the_desktop() {
        let base = std::env::temp_dir().join(format!("coop-sc2-config-{}", super::new_run_id()));
        let root = base.join("StarCraft II");
        for dir in ["SC2Data/data", "SC2Data/indices", "Versions/Base97579"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [".build.info", "StarCraft II Editor_x64.exe", "Versions/Base97579/SC2_x64.exe"] {
            std::fs::write(root.join(file), b"fixture").unwrap();
        }
        let config_base = base.join("config");
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(super::project_root().unwrap().join("scripts/configure-sc2.ps1"))
            .arg("-StarCraftRoot").arg(root.join("Versions/Base97579/SC2_x64.exe"))
            .arg("-NonInteractive").env("APPDATA", &config_base).env_remove("COOPAGENT_SC2_ROOT")
            .output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let config: super::Sc2InstallationConfig = serde_json::from_slice(
            &std::fs::read(config_base.join("CoopAgent/sc2-installation.json")).unwrap()).unwrap();
        assert_eq!(std::path::Path::new(&config.root_path), root);
        let status = super::validate_sc2_installation(Some(config.root_path)).unwrap();
        assert!(status.valid);
        assert_eq!(status.build.as_deref(), Some("Base97579"));
        std::fs::remove_dir_all(base).unwrap();
    }

    use super::{
        agent_session_detail_from_export, base64_encode, dds_to_bmp, phase_session,
        is_approved_draft_path, is_valid_agent_session_id, is_valid_run_id, project_root,
        safe_portrait_casc_path, validate_checked_plan_run, ActiveAgentGuard, AgentBusyGuard, AgentRunControl, AgentState, AgentEvent, TraceWriter,
        AgentRunSnapshot, AgentEventSink, send_agent_event, AgentObservationState, handle_agent_json_line,
    };
    use serde_json::Value;

    #[test]
    fn work_phases_reuse_the_task_session_without_cross_task_fallback() {
        let task = serde_json::json!({ "modelSessionId": "ses_current" });
        assert_eq!(phase_session(&task, Some("ses_old"), false, false).as_deref(), Some("ses_current"));
        assert_eq!(phase_session(&task, Some("ses_old"), true, true).as_deref(), Some("ses_current"));
        assert_eq!(phase_session(&serde_json::json!({}), Some("ses_old"), true, false).as_deref(), Some("ses_old"));
        assert_eq!(phase_session(&serde_json::json!({}), Some("ses_old"), false, true), None);
        assert_eq!(phase_session(&serde_json::json!({ "modelSessionId": "../bad" }), None, false, false), None);
    }

    fn snapshot_fixture() -> AgentRunSnapshot {
        AgentRunSnapshot { run_id: "run-1".into(), trace_path: "trace-1".into(), prompt: "修改生命".into(),
            started_at_ms: 1000, session_id: None, state: "starting".into(), text: String::new(),
            activity: String::new(), error: None, sequence: 0, task: None }
    }

    #[test]
    fn a_closed_page_channel_cannot_discard_backend_run_output_or_completion() {
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot: snapshot.clone(),
            channel: tauri::ipc::Channel::new(|_| Err(std::io::Error::other("page gone").into())) };
        send_agent_event(&sink, AgentEvent::Started { run_id: "run-1".into(), trace_path: "trace-1".into() });
        send_agent_event(&sink, AgentEvent::Text { text: "第一段".into() });
        send_agent_event(&sink, AgentEvent::Text { text: "第二段".into() });
        send_agent_event(&sink, AgentEvent::Complete { run_id: "run-1".into(), session_id: Some("session-1".into()) });
        let current = snapshot.lock().unwrap().clone().unwrap();
        assert_eq!(current.text, "第一段第二段");
        assert_eq!(current.state, "completed");
        assert_eq!(current.sequence, 4);
        let serialized = serde_json::to_value(current).unwrap();
        assert_eq!(serialized["runId"], "run-1");
        assert_eq!(serialized["sessionId"], "session-1");
        assert_eq!(serialized["startedAtMs"], 1000);
    }

    #[test]
    fn an_old_event_sink_cannot_overwrite_a_new_run_snapshot() {
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "old-run".into(), snapshot: snapshot.clone(),
            channel: tauri::ipc::Channel::new(|_| Ok(())) };
        send_agent_event(&sink, AgentEvent::Cancelled { run_id: "old-run".into(), message: "停止".into(), session_id: None });
        let current = snapshot.lock().unwrap().clone().unwrap();
        assert_eq!(current.state, "starting");
        assert_eq!(current.sequence, 0);
    }

    #[test]
    fn cancellation_is_persisted_before_stopping_only_the_owned_process() {
        let control = AgentRunControl::new("run-cancel-test".to_string());
        let root = project_root().unwrap();
        let executable = if cfg!(windows) { root.join(".tools/node/node.exe") } else { root.join(".tools/node/bin/node") };
        let mut command = std::process::Command::new(executable);
        command.args(["-e", "setInterval(()=>{},1000)"]);
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        *control.child.lock().unwrap() = Some(command.spawn().unwrap());
        assert!(control.cancel_with(|| Err("cannot persist".to_string())).is_err());
        assert!(!control.cancelled.load(std::sync::atomic::Ordering::Acquire));
        assert!(control.child.lock().unwrap().as_mut().unwrap().try_wait().unwrap().is_none());
        control.cancel_with(|| Ok(())).unwrap();
        assert!(control.cancelled.load(std::sync::atomic::Ordering::Acquire));
        assert!(!control.child.lock().unwrap().as_mut().unwrap().wait().unwrap().success());
    }

    #[test]
    fn old_run_cleanup_cannot_clear_a_new_run() {
        let active = std::sync::Arc::new(std::sync::Mutex::new(Some(AgentRunControl::new("new".to_string()))));
        drop(ActiveAgentGuard { active: std::sync::Arc::clone(&active), run_id: "old".to_string() });
        assert_eq!(active.lock().unwrap().as_ref().unwrap().run_id, "new");
        drop(ActiveAgentGuard { active: std::sync::Arc::clone(&active), run_id: "new".to_string() });
        assert!(active.lock().unwrap().is_none());
    }

    #[test]
    fn desktop_operations_share_one_busy_guard() {
        let state = AgentState::default();
        let mut first = AgentBusyGuard::acquire(&state).unwrap();
        assert!(AgentBusyGuard::acquire(&state).is_err());
        first.release();
        let second = AgentBusyGuard::acquire(&state).unwrap();
        drop(first);
        assert!(AgentBusyGuard::acquire(&state).is_err());
        drop(second);
        assert!(AgentBusyGuard::acquire(&state).is_ok());
    }

    #[test]
    fn apply_requires_the_final_checked_plan_and_a_completed_run() {
        let check = serde_json::json!({"event":"patch_plan.checked","details":{"planPath":"plan","fileSha256":"abc"}});
        let complete = serde_json::json!({"event":"agent.completed"});
        assert!(validate_checked_plan_run(&[check.clone()], "plan", "abc").is_err());
        assert!(validate_checked_plan_run(&[check.clone(), complete.clone()], "plan", "ABC").is_ok());
        assert!(validate_checked_plan_run(&[check.clone(), complete.clone()], "other", "abc").is_err());
        let revision = serde_json::json!({"event":"agent.tool.completed","details":{"tool":"coop_patch_plan_write"}});
        assert!(validate_checked_plan_run(&[check.clone(), revision, complete.clone()], "plan", "abc").is_err());
        let other = serde_json::json!({"event":"patch_plan.checked","details":{"planPath":"other","fileSha256":"def"}});
        assert!(validate_checked_plan_run(&[check, other, complete], "plan", "abc").is_err());
    }

    #[test]
    fn approval_only_accepts_controlled_draft_paths() {
        assert!(is_approved_draft_path(
            "game-a/drafts/artanis-dragoon-life-300.patch-plan.json"
        ));
        assert!(!is_approved_draft_path(
            "game-a/patches/artanis-dragoon-life-300.patch-plan.json"
        ));
        assert!(!is_approved_draft_path(
            "game-a/drafts/../patches/change.patch-plan.json"
        ));
        assert!(!is_approved_draft_path(
            "game-a/drafts/UPPER.patch-plan.json"
        ));
    }

    #[test]
    fn agent_plan_ready_event_uses_camel_case_fields() {
        let event = serde_json::to_value(AgentEvent::PlanReady {
            run_id: "run-123-456-1".to_string(),
            plan_path: "game-a/drafts/test.patch-plan.json".to_string(),
            plan_sha256: "0".repeat(64),
            plan_id: "test".to_string(),
            operation_count: 1,
            changed_files: vec!["GameA.Core.json".to_string()],
            summary_items: vec!["龙骑士新增闪现。".to_string()],
            verification_level: "static-preflight".to_string(),
            verification_label: "静态预检通过；尚未试玩验证。".to_string(),
            runtime_verified: false,
        })
        .expect("event should serialize");

        assert_eq!(event["type"], "planReady");
        assert_eq!(event["runId"], "run-123-456-1");
        assert_eq!(event["planPath"], "game-a/drafts/test.patch-plan.json");
        assert_eq!(event["planId"], "test");
        assert_eq!(event["operationCount"], 1);
        assert_eq!(event["summaryItems"][0], "龙骑士新增闪现。");
        assert_eq!(event["verificationLevel"], "static-preflight");
        assert_eq!(event["runtimeVerified"], false);
        assert!(event.get("plan_path").is_none());
    }

    #[test]
    fn trace_run_ids_cannot_escape_the_trace_directory() {
        assert!(is_valid_run_id("run-1786253092488-1234-1"));
        assert!(!is_valid_run_id("../run-123"));
        assert!(!is_valid_run_id("run-ABC"));
        assert!(!is_valid_run_id("session-123"));
    }

    #[test]
    fn agent_session_ids_and_exports_stay_inside_the_project() {
        assert!(is_valid_agent_session_id(
            "ses_ff67bd97effeYSc3PT59BfaRER"
        ));
        assert!(!is_valid_agent_session_id("../ses_escape"));
        assert!(!is_valid_agent_session_id("run-1786253092488-1234-1"));

        let root = project_root().expect("project root should resolve");
        let export = serde_json::json!({
            "info": {
                "id": "ses_fixture123",
                "title": "测试会话",
                "directory": root.display().to_string(),
                "model": { "providerID": "fixture", "id": "model" },
                "time": { "created": 100, "updated": 200 }
            },
            "messages": [
                {
                    "info": {
                        "id": "msg_user",
                        "role": "user",
                        "time": { "created": 110 }
                    },
                    "parts": [{ "type": "text", "text": "把枪兵生命值改成75" }]
                },
                {
                    "info": {
                        "id": "msg_assistant",
                        "role": "assistant",
                        "time": { "created": 120 }
                    },
                    "parts": [
                        { "type": "reasoning", "text": "不应暴露" },
                        { "type": "tool", "state": { "output": "不应暴露" } },
                        { "type": "text", "text": "PatchPlan 已生成。" }
                    ]
                }
            ]
        });
        let detail = agent_session_detail_from_export("ses_fixture123", &export, &root)
            .expect("session export should be accepted");
        assert_eq!(detail.title, "测试会话");
        assert_eq!(detail.model.as_deref(), Some("fixture/model"));
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].role, "user");
        assert_eq!(detail.messages[1].text, "PatchPlan 已生成。");
        assert!(!detail.messages[1].text.contains("不应暴露"));
    }

    #[test]
    fn session_usage_sums_every_assistant_step_and_resets_the_last_turn_at_user_messages() {
        let root = project_root().unwrap();
        let export = serde_json::json!({
            "info": {"id":"ses_usage123","directory":root.display().to_string()},
            "messages": [
                {"info":{"role":"user"},"parts":[{"type":"text","text":"第一轮"}]},
                {"info":{"role":"assistant","tokens":{"input":10,"output":2,"cache":{"read":20}}},"parts":[]},
                {"info":{"role":"assistant","tokens":{"input":5,"output":3,"cache":{"read":7}}},"parts":[]},
                {"info":{"role":"user"},"parts":[{"type":"text","text":"第二轮"}]},
                {"info":{"role":"assistant","tokens":{"input":4,"output":1,"cache":{"read":8}}},"parts":[]}
            ]
        });
        let detail = agent_session_detail_from_export("ses_usage123", &export, &root).unwrap();
        assert_eq!(detail.usage.total.input, 19);
        assert_eq!(detail.usage.total.cached, 35);
        assert_eq!(detail.usage.total.output, 6);
        assert_eq!(detail.usage.last_turn.input, 4);
        assert_eq!(detail.usage.last_turn.cached, 8);
        assert_eq!(detail.usage.last_turn.output, 1);
    }

    #[test]
    fn official_mod_and_campaign_dds_paths_are_accepted() {
        assert!(safe_portrait_casc_path(
            "mods\\liberty.sc2mod\\base.sc2assets\\assets\\textures\\unit.dds"
        ));
        assert!(safe_portrait_casc_path(
            "campaigns\\liberty.sc2campaign\\base.sc2assets\\assets\\textures\\unit.dds"
        ));
        assert!(!safe_portrait_casc_path("campaigns\\..\\outside\\unit.dds"));
        assert!(!safe_portrait_casc_path("maps\\custom\\unit.dds"));
    }

    #[test]
    fn sc2_bgra_dds_portrait_converts_to_browser_bmp() {
        let mut dds = vec![0u8; 132];
        dds[0..4].copy_from_slice(b"DDS ");
        dds[12..16].copy_from_slice(&1u32.to_le_bytes());
        dds[16..20].copy_from_slice(&1u32.to_le_bytes());
        dds[88..92].copy_from_slice(&32u32.to_le_bytes());
        dds[92..96].copy_from_slice(&0x00ff0000u32.to_le_bytes());
        dds[96..100].copy_from_slice(&0x0000ff00u32.to_le_bytes());
        dds[100..104].copy_from_slice(&0x000000ffu32.to_le_bytes());
        dds[104..108].copy_from_slice(&0xff000000u32.to_le_bytes());
        dds[128..132].copy_from_slice(&[0x20, 0x40, 0x80, 0xff]);

        let bmp = dds_to_bmp(&dds, "test").expect("DDS should convert");
        assert_eq!(&bmp[0..2], b"BM");
        assert_eq!(bmp.len(), 58);
        assert_eq!(&bmp[54..58], &[0x20, 0x40, 0x80, 0xff]);
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn sc2_bgr24_dds_icon_converts_to_browser_bmp() {
        let mut dds = vec![0u8; 131];
        dds[0..4].copy_from_slice(b"DDS ");
        dds[12..16].copy_from_slice(&1u32.to_le_bytes());
        dds[16..20].copy_from_slice(&1u32.to_le_bytes());
        dds[88..92].copy_from_slice(&24u32.to_le_bytes());
        dds[92..96].copy_from_slice(&0x00ff0000u32.to_le_bytes());
        dds[96..100].copy_from_slice(&0x0000ff00u32.to_le_bytes());
        dds[100..104].copy_from_slice(&0x000000ffu32.to_le_bytes());
        dds[128..131].copy_from_slice(&[0x20, 0x40, 0x80]);

        let bmp = dds_to_bmp(&dds, "test-24").expect("24-bit DDS should convert");
        assert_eq!(&bmp[54..58], &[0x20, 0x40, 0x80, 0xff]);
    }

    #[test]
    fn sc2_dxt5_dds_icon_converts_to_browser_bmp() {
        let mut dds = vec![0u8; 144];
        dds[0..4].copy_from_slice(b"DDS ");
        dds[12..16].copy_from_slice(&4u32.to_le_bytes());
        dds[16..20].copy_from_slice(&4u32.to_le_bytes());
        dds[84..88].copy_from_slice(b"DXT5");
        dds[128] = 255;
        dds[129] = 0;
        dds[136..138].copy_from_slice(&0xf800u16.to_le_bytes());
        dds[138..140].copy_from_slice(&0x0000u16.to_le_bytes());

        let bmp = dds_to_bmp(&dds, "test-dxt5").expect("DXT5 DDS should convert");
        assert_eq!(bmp.len(), 54 + 4 * 4 * 4);
        assert_eq!(&bmp[54..58], &[0, 0, 255, 255]);
    }

    #[test]
    fn trace_writer_appends_individually_valid_json_lines() {
        let run_id = format!("run-test-{}", std::process::id());
        let path = std::env::temp_dir().join(format!("coopagent-{run_id}.jsonl"));
        let mut trace = TraceWriter {
            run_id: run_id.clone(),
            path: path.clone(),
            sequence: 0,
        };
        trace
            .append("run.created", "ok", serde_json::json!({ "source": "test" }))
            .expect("first trace event should be written");
        trace
            .append("run.completed", "ok", serde_json::json!({}))
            .expect("second trace event should be written");

        let records = std::fs::read_to_string(&path)
            .expect("trace should be readable")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("line should be valid JSON"))
            .collect::<Vec<_>>();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["runId"], run_id);
        assert_eq!(records[0]["sequence"], 1);
        assert_eq!(records[1]["sequence"], 2);
        std::fs::remove_file(path).expect("test trace should be removable");
    }

    #[test]
    fn history_uses_saved_answers_and_preserves_followup_turns() {
        let root = project_root().unwrap();
        let answer = "我是 CoopAgent，可以帮你调整合作模式的指挥官数值。";
        let output = serde_json::json!({"status":"delivery-saved","task":{
            "checkpoint":{"disposition":"deliver","summary":answer,"facts":["内部记录"]}}});
        for saved_output in [output.clone(), Value::String(output.to_string())] {
            let export = serde_json::json!({"info":{"id":"ses_reply123","directory":root.display().to_string()},
                "messages":[
                    {"info":{"role":"user"},"parts":[{"type":"text","text":"你是谁"}]},
                    {"info":{"role":"assistant"},"parts":[{"type":"text","text":"正在分析用户意图"}]},
                    {"info":{"role":"assistant"},"parts":[{"type":"tool","tool":"coop_task_checkpoint",
                        "state":{"status":"completed","output":saved_output}}]},
                    {"info":{"role":"assistant"},"parts":[{"type":"text","text":"重复的后续说明"}]},
                    {"info":{"role":"user"},"parts":[{"type":"text","text":"谢谢"}]},
                    {"info":{"role":"assistant"},"parts":[{"type":"tool","tool":"coop_task_checkpoint",
                        "state":{"status":"error","output":output}} ,{"type":"text","text":"不客气。"}]}
                ]});
            let detail = agent_session_detail_from_export("ses_reply123", &export, &root).unwrap();
            assert_eq!(detail.messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
                vec!["你是谁", answer, "谢谢", "不客气。"]);
        }
    }

    #[test]
    fn sealed_answer_replaces_progress_in_snapshot_and_ignores_late_prose() {
        for answer in ["我是 CoopAgent。", "生命已从45改为60；面板仍待同步。"] {
            let path = std::env::temp_dir().join(format!("coop-reply-{}.jsonl", super::new_run_id()));
            let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
            let mut initial = snapshot_fixture(); initial.text = "正在查询".into();
            let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(initial)));
            let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot: snapshot.clone(), channel: tauri::ipc::Channel::new(|_| Ok(())) };
            let (mut session, mut text, mut ready) = (None, String::new(), false);
            let mut observations = AgentObservationState::default();
            let task = serde_json::json!({"status":"running","checkpoint":{"disposition":"deliver","summary":answer}});
            let checkpoint = serde_json::json!({"type":"tool_use","part":{"tool":"coop_task_checkpoint",
                "state":{"status":"completed","output":serde_json::json!({"status":"delivery-saved","task":task}).to_string()}}});
            let late = serde_json::json!({"type":"text","part":{"text":"重复的内部说明"}});
            for event in [checkpoint, late] {
                handle_agent_json_line(&event.to_string(), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
            }
            let current = snapshot.lock().unwrap().clone().unwrap();
            assert_eq!(current.text, answer);
            assert!(observations.delivery_saved && observations.checkpoint_saved);
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn checkpoint_summary_replaces_repeated_phase_prose_on_the_page() {
        let path = std::env::temp_dir().join(format!("coop-phase-{}.jsonl", super::new_run_id()));
        let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot: snapshot.clone(), channel: tauri::ipc::Channel::new(|_| Ok(())) };
        let mut session = None; let mut text = String::new(); let mut ready = false;
        let mut observations = AgentObservationState::default();
        let checkpoint = serde_json::json!({ "type": "tool_use", "sessionID": "s1", "part": {
            "callID": "checkpoint-1", "tool": "coop_task_checkpoint", "state": { "status": "completed",
                "output": serde_json::json!({ "status": "checkpoint-saved", "task": { "id": "task-1", "phase": 1 } }).to_string() } } });
        let prose = serde_json::json!({ "type": "text", "sessionID": "s1", "part": { "text": "重复的长篇阶段叙述" } });
        for event in [checkpoint, prose] {
            handle_agent_json_line(&event.to_string(), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        }
        let current = snapshot.lock().unwrap().clone().unwrap();
        assert!(current.text.is_empty());
        assert_eq!(current.task.unwrap()["phase"], 1);
        assert_eq!(text, "重复的长篇阶段叙述");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn target_confirmation_requests_model_stop_and_preserves_waiting_snapshot() {
        let path = std::env::temp_dir().join(format!("coop-confirm-{}.jsonl", super::new_run_id()));
        let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot: snapshot.clone(), channel: tauri::ipc::Channel::new(|_| Ok(())) };
        let (mut session, mut text, mut ready) = (None, String::new(), false);
        let mut observations = AgentObservationState::default();
        let task = serde_json::json!({ "id": "task-1", "phase": 1, "status": "awaiting_confirmation",
            "confirmation": { "question": "是10级升级吗？" } });
        let event = serde_json::json!({ "type": "tool_use", "sessionID": "s1", "part": {
            "callID": "confirm-1", "tool": "coop_target_confirm", "state": { "status": "completed",
                "output": serde_json::json!({ "status": "awaiting-confirmation", "task": task }).to_string() } } });
        handle_agent_json_line(&event.to_string(), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        assert!(observations.confirmation_requested);
        assert!(observations.checkpoint_saved);
        assert_eq!(snapshot.lock().unwrap().as_ref().unwrap().task.as_ref().unwrap()["status"], "awaiting_confirmation");
        let prose = serde_json::json!({ "type": "text", "sessionID": "s1", "part": { "text": "不应继续显示研究过程" } });
        handle_agent_json_line(&prose.to_string(), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        assert!(snapshot.lock().unwrap().as_ref().unwrap().text.is_empty());
        assert!(!ready);
        assert!(std::fs::read_to_string(&path).unwrap().contains("task.confirmation.requested"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn harness_control_preserves_batch_identity_and_wait_deadline_facts() {
        let path = std::env::temp_dir().join(format!("coop-harness-{}.jsonl", super::new_run_id()));
        let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot,
            channel: tauri::ipc::Channel::new(|_| Ok(())) };
        let (mut session, mut text, mut ready) = (None, String::new(), false);
        let mut observations = AgentObservationState::default();
        let event = serde_json::json!({ "type": "harness_control", "sessionID": "s1",
            "action": "close", "stage": "closing", "reason": "work-steps",
            "elapsedMs": 1234, "toolSteps": 12, "remainingMs": 208000, "waiting": true,
            "instructionInjected": true, "boundary": "tool-step", "eventId": "s1:m12" });
        handle_agent_json_line(&event.to_string(), &sink, &mut session, &mut text,
            &mut observations, &mut ready, &mut trace);
        assert_eq!(observations.harness_stage.as_deref(), Some("closing"));
        assert!(observations.harness_waiting);
        assert_eq!(observations.harness_deadline_update, Some((true, 208000)));
        let raw = std::fs::read_to_string(&path).unwrap();
        let record: Value = serde_json::from_str(raw.lines().last().unwrap()).unwrap();
        assert_eq!(record["event"], "agent.harness.control");
        assert_eq!(record["details"]["eventId"], "s1:m12");
        assert_eq!(record["details"]["sessionId"], "s1");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn observation_records_unfinished_calls_usage_and_deduplicates_two_streams() {
        let path = std::env::temp_dir().join(format!("coop-observer-{}.jsonl", std::process::id()));
        let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
        let sink = AgentEventSink { project: None, run_id: "run-1".into(),
            snapshot: std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture()))),
            channel: tauri::ipc::Channel::new(|_| Ok(())) };
        let mut state = AgentObservationState::default();
        let (mut session, mut text, mut ready) = (None, String::new(), false);
        let running = serde_json::json!({ "type": "tool_use", "sessionID": "s1", "part": {
            "callID": "c1", "tool": "coop_plan_prepare", "state": { "status": "running", "input": { "plan": { "id": "p1", "source": "x".repeat(40000) } } } } });
        let usage = serde_json::json!({ "type": "step_finish", "sessionID": "s1", "part": {
            "id": "f1", "messageID": "m1", "text": "HIDDEN_REASONING", "tokens": {
                "input": 10, "output": 3, "reasoning": 2, "total": 35, "cache": { "read": 20, "write": 0 } } } });
        let completed = serde_json::json!({ "type": "tool_use", "sessionID": "s1", "part": {
            "callID": "c2", "tool": "coop_search", "state": { "status": "completed", "output": "{}" } } });
        let late_start = serde_json::json!({ "type": "tool_use", "sessionID": "s1", "part": {
            "callID": "c2", "tool": "coop_search", "state": { "status": "running" } } });
        let start = serde_json::json!({ "type": "step_start", "sessionID": "s1", "part": { "id": "b1", "messageID": "m1" } });
        let other = serde_json::json!({ "type": "step_finish", "sessionID": "other-session", "part": { "id": "other" } });
        for event in [serde_json::json!({ "type": "observer_ready" }), start.clone(), start,
            serde_json::json!({ "type": "context_projection", "beforeCharacters": 500000, "afterCharacters": 30000,
                "limitCharacters": 64000, "raw": "DO_NOT_RECORD_CONTEXT" }),
            serde_json::json!({ "type": "context_observed", "beforeCharacters": 200000, "afterCharacters": 200000,
                "modified": false, "archiveFailed": false, "raw": "DO_NOT_RECORD_CONTEXT" }),
            running.clone(), running, usage.clone(), usage, completed.clone(), completed, late_start, other] {
            handle_agent_json_line(&event.to_string(), &sink, &mut session, &mut text, &mut state, &mut ready, &mut trace);
        }
        state.finish(&mut trace);
        let raw = std::fs::read_to_string(&path).unwrap();
        let records: Vec<Value> = raw.lines().map(|s| serde_json::from_str(s).unwrap()).collect();
        let count = |name: &str| records.iter().filter(|r| r["event"] == name).count();
        assert_eq!(count("agent.tool.started"), 1);
        assert_eq!(count("agent.tool.completed"), 1);
        assert_eq!(count("agent.tool.unfinished"), 1);
        assert_eq!(count("agent.step.started"), 1);
        assert_eq!(count("agent.usage"), 1);
        assert_eq!(count("agent.context.projected"), 1);
        assert_eq!(count("agent.context.observed"), 1);
        assert!(!raw.contains("DO_NOT_RECORD_CONTEXT"));
        let first_tool = records.iter().find(|r| r["event"] == "agent.tool.started").unwrap();
        assert_eq!(first_tool["details"]["tool"], "coop_plan_prepare");
        assert_eq!(first_tool["details"]["input"]["truncated"], true);
        assert!(raw.contains("p1"));
        assert!(!raw.contains("HIDDEN_REASONING"));
        assert!(!raw.contains("other-session"));
        assert_eq!(session.as_deref(), Some("s1"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn model_reasoning_is_transient_activity_without_becoming_the_answer() {
        let path = std::env::temp_dir().join(format!("coop-activity-{}.jsonl", super::new_run_id()));
        let mut trace = TraceWriter { run_id: "run-1".into(), path: path.clone(), sequence: 0 };
        let snapshot = std::sync::Arc::new(std::sync::Mutex::new(Some(snapshot_fixture())));
        let sink = AgentEventSink { project: None, run_id: "run-1".into(), snapshot: snapshot.clone(),
            channel: tauri::ipc::Channel::new(|_| Ok(())) };
        let (mut session, mut text, mut ready) = (None, String::new(), false);
        let mut observations = AgentObservationState::default();
        let reasoning = |value: &str| serde_json::json!({ "type": "reasoning", "sessionID": "s1", "part": { "text": value } }).to_string();
        handle_agent_json_line(&reasoning("正在核对字段"), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        assert_eq!(snapshot.lock().unwrap().as_ref().unwrap().activity, "正在核对字段");
        assert!(snapshot.lock().unwrap().as_ref().unwrap().text.is_empty());
        assert!(text.is_empty());
        handle_agent_json_line(&reasoning("  "), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        assert_eq!(snapshot.lock().unwrap().as_ref().unwrap().activity, "正在核对字段");
        let answer = serde_json::json!({ "type": "text", "sessionID": "s1", "part": { "text": "当前生命值为45。" } });
        handle_agent_json_line(&answer.to_string(), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        observations.checkpoint_saved = true;
        handle_agent_json_line(&reasoning("交付后到达的旧内容"), &sink, &mut session, &mut text, &mut observations, &mut ready, &mut trace);
        assert_eq!(snapshot.lock().unwrap().as_ref().unwrap().activity, "正在核对字段");
        assert_eq!(snapshot.lock().unwrap().as_ref().unwrap().text, "当前生命值为45。");
        assert_eq!(text, "当前生命值为45。");
        let _ = std::fs::remove_file(path);
    }
}
