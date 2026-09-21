//! Debug-only stdio transport over the production desktop Agent lifecycle.
//! Optional WebView shares this exact AgentState. No sockets or fake executor.
use super::*;

const MAX_REQUEST_BYTES: u64 = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartParams { prompt: String, session_id: Option<String>, task_id: Option<String> }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopParams { run_id: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetryParams { preparation_id: String }

#[derive(Clone)]
struct Output(Arc<Mutex<std::io::Stdout>>);
impl Output {
    fn emit(&self, value: Value) -> std::io::Result<()> {
        let mut stdout = self.0.lock().map_err(|_| std::io::Error::other("stdout lock poisoned"))?;
        serde_json::to_writer(&mut *stdout, &value)?;
        stdout.write_all(b"\n")?;
        stdout.flush()
    }
    fn reply(&self, id: &str, result: Result<Value, String>) {
        let value = match result {
            Ok(result) => serde_json::json!({ "id": id, "result": result }),
            Err(message) => serde_json::json!({ "id": id, "error": { "message": message } }),
        };
        let _ = self.emit(value);
    }
    fn channel(&self) -> Channel<AgentEvent> {
        let output = self.clone();
        Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(text) = body else {
                return Err(std::io::Error::other("Expected JSON Agent event").into());
            };
            let event: Value = serde_json::from_str(&text)?;
            output.emit(serde_json::json!({ "event": event })).map_err(Into::into)
        })
    }
}

fn no_params(params: &Value) -> Result<(), String> {
    if params.is_null() || params.as_object().is_some_and(|object| object.is_empty()) { Ok(()) }
    else { Err("This method does not accept parameters".into()) }
}

fn dispatch(state: &AgentState, output: &Output, request: &Request) -> Result<Value, String> {
    match request.method.as_str() {
        "start" => {
            let params: StartParams = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            start_agent_run(state, params.prompt, params.session_id, params.task_id, output.channel())?;
            current_agent_snapshot(state)
        }
        "status" => { no_params(&request.params)?; current_agent_snapshot(state) }
        "task" => { no_params(&request.params)?; run_agent_task_command("get", serde_json::json!({})) }
        "stop" => {
            let params: StopParams = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            cancel_agent_run(&active_agent_run(state, &params.run_id)?)
        }
        "jobs" => { no_params(&request.params)?; run_plan_jobs_command("status", None) }
        "retry" => {
            let params: RetryParams = serde_json::from_value(request.params.clone()).map_err(|error| error.to_string())?;
            let _busy = AgentBusyGuard::acquire(state)?;
            retry_plan_submission(&params.preparation_id)
        }
        _ => Err("Unknown method; use start, status, stop, jobs, retry or shutdown".into()),
    }
}

fn shutdown_model(state: &AgentState) -> Result<(), String> {
    state.closing.store(true, Ordering::Release);
    let control = state.active.lock().map_err(|_| "Agent state lock poisoned".to_string())?.clone();
    if let Some(control) = control {
        cancel_agent_run(&control)?;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if state.active.lock().map_err(|_| "Agent state lock poisoned".to_string())?.is_none() { break; }
            if Instant::now() >= deadline { return Err("Model shutdown not confirmed; inspect the trace and submission jobs".into()); }
            thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(())
}

fn serve(state: &Arc<AgentState>, output: &Output, desktop: Option<&AppHandle>) -> Result<Option<String>, String> {
    let mut reader = BufReader::new(std::io::stdin());
    let in_flight = Arc::new(AtomicU64::new(0));
    loop {
        let mut bytes = Vec::new();
        let length = reader.by_ref().take(MAX_REQUEST_BYTES).read_until(b'\n', &mut bytes).map_err(|error| error.to_string())?;
        if length == 0 { return Ok(None); }
        if length as u64 >= MAX_REQUEST_BYTES { return Err("Test request exceeds 128 KiB".into()); }
        let request = match serde_json::from_slice::<Request>(&bytes) {
            Ok(request) if !request.id.is_empty() && request.id.len() <= 96 => request,
            result => {
                let message = result.err().map(|error| error.to_string()).unwrap_or_else(|| "Request id must contain 1–96 bytes".into());
                output.emit(serde_json::json!({ "id": null, "error": { "message": message } })).map_err(|error| error.to_string())?;
                continue;
            }
        };
        if matches!(request.method.as_str(), "shutdown" | "window.reload") {
            if let Err(error) = no_params(&request.params) { output.reply(&request.id, Err(error)); continue; }
            if let Some(app) = desktop {
                let result = app.get_webview_window("main").ok_or_else(|| "No main window".to_string())
                    .and_then(|window| {
                        if request.method == "window.reload" { window.reload() }
                        else { window.close() } // Same CloseRequested handler as the native X button.
                        .map_err(|error| error.to_string())
                    });
                output.reply(&request.id, result.map(|_| serde_json::json!({ "requested": true })));
                continue;
            }
            if request.method != "shutdown" {
                output.reply(&request.id, Err("window.reload requires desktop mode".into()));
                continue;
            }
            return Ok(Some(request.id));
        }
        // Persistence/committer I/O must not block status observations. Stop
        // checks the exact owned run identity, never whichever run comes next.
        if matches!(request.method.as_str(), "jobs" | "retry" | "stop") {
            if in_flight.load(Ordering::Acquire) >= 8 { output.reply(&request.id, Err("Too many pending test requests".into())); continue; }
            in_flight.fetch_add(1, Ordering::AcqRel);
            let state = Arc::clone(state);
            let output = output.clone();
            let in_flight = Arc::clone(&in_flight);
            thread::spawn(move || {
                output.reply(&request.id, dispatch(&state, &output, &request));
                in_flight.fetch_sub(1, Ordering::AcqRel);
            });
        } else {
            output.reply(&request.id, dispatch(state, output, &request));
        }
    }
}

fn test_root() -> Result<PathBuf, String> {
    if std::env::var_os("COOPAGENT_TEST_PROJECT_ROOT").is_none() {
        return Err("Set COOPAGENT_TEST_PROJECT_ROOT to a marked isolated regression project".into());
    }
    project_root() // Validates the debug-only fixture boundary before any window.
}

fn run_transport(state: Arc<AgentState>, desktop: Option<AppHandle>) -> Result<(), String> {
    let root = test_root()?;
    let output = Output(Arc::new(Mutex::new(std::io::stdout())));
    {
        let _busy = AgentBusyGuard::acquire(&state)?;
        if let Err(error) = run_plan_jobs_command("recover", None) {
            if desktop.is_none() { return Err(error); }
            // Match desktop startup: a live committer can own the lock. Keep
            // the window/status channel available to observe its final result.
            eprintln!("Submission recovery: {error}");
        }
    }
    let mut methods = vec!["start", "status", "task", "stop", "jobs", "retry", "shutdown"];
    if desktop.is_some() { methods.push("window.reload"); }
    output.emit(serde_json::json!({ "ready": true, "protocolVersion": 1, "projectRoot": root,
        "mode": if desktop.is_some() { "desktop" } else { "headless" },
        "methods": methods })).map_err(|error| error.to_string())?;
    let result = serve(&state, &output, desktop.as_ref());
    if let Some(app) = desktop {
        // EOF also requests normal window shutdown. A cancellation failure
        // keeps the window alive with its normal error display.
        app.get_webview_window("main").ok_or_else(|| "No main window".to_string())?
            .close().map_err(|error| error.to_string())?;
        return result.map(|_| ());
    }
    let shutdown = shutdown_model(&state);
    if let Ok(Some(id)) = &result {
        output.reply(id, shutdown.clone().map(|_| serde_json::json!({ "stopped": true })));
    }
    shutdown?;
    result.map(|_| ())
}

pub fn run_agent_test_stdio() -> Result<(), String> {
    run_transport(Arc::new(AgentState::default()), None)
}

pub fn run_agent_test_desktop() -> Result<(), String> {
    test_root()?;
    super::run_desktop(true);
    Ok(())
}

pub(super) fn attach_desktop(app: AppHandle) -> Result<(), String> {
    test_root()?;
    // AgentState clones only Arcs: RPC and the Tauri commands own the same run.
    let state = Arc::new(app.state::<AgentState>().inner().clone());
    thread::spawn(move || {
        if let Err(message) = run_transport(state, Some(app.clone())) {
            eprintln!("Agent test transport: {message}");
            if let Some(window) = app.get_webview_window("main") { let _ = window.close(); }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_transport_does_not_accept_extra_start_parameters() {
        assert!(serde_json::from_value::<StartParams>(serde_json::json!({"prompt":"test","global":true})).is_err());
        assert!(serde_json::from_value::<StartParams>(serde_json::json!({"prompt":"test"})).is_ok());
        assert!(no_params(&serde_json::json!({"projectRoot":"elsewhere"})).is_err());
    }
    #[test]
    fn test_transport_status_and_stop_use_the_desktop_state() {
        let state = AgentState::default();
        let output = Output(Arc::new(Mutex::new(std::io::stdout())));
        let request = Request { id: "status".into(), method: "status".into(), params: Value::Null };
        assert_eq!(dispatch(&state, &output, &request).unwrap()["busy"], false);
        let _busy = AgentBusyGuard::acquire(&state).unwrap();
        assert_eq!(dispatch(&state, &output, &request).unwrap()["busy"], true);
        // Optional desktop transport clones the state's Arcs, not a second run.
        let transport_state = state.clone();
        assert_eq!(dispatch(&transport_state, &output, &request).unwrap()["busy"], true);
        assert!(AgentBusyGuard::acquire(&transport_state).is_err());
        drop(_busy);
        assert_eq!(dispatch(&transport_state, &output, &request).unwrap()["busy"], false);
        let request = Request { id: "stop".into(), method: "stop".into(), params: serde_json::json!({"runId":"not-owned"}) };
        assert!(dispatch(&state, &output, &request).is_err());
    }
}
