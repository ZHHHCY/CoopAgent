use super::*;
use std::sync::OnceLock;

#[derive(Clone, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectToken { pub project_id: String, pub context_generation: u64 }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    active: Value, recent: Vec<Value>, generation: u64, #[serde(skip)] readers: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")] recovery_notice: Option<String>,
}
impl Registry {
    fn empty() -> Self { Self { active: Value::Null, recent: vec![], generation: 1, readers: 0, recovery_notice: None } }
    fn validate(&self, token: Option<&ProjectToken>) -> Result<(), String> {
        if self.active.is_null() && token.is_none() { return Ok(()); }
        if token.is_some_and(|t| t.project_id == self.active["projectId"] && t.context_generation == self.generation) { Ok(()) }
        else { Err("项目已切换，请刷新后重试".into()) }
    }
    fn ensure_idle(&self, busy: bool) -> Result<(), String> {
        if self.readers == 0 && !busy { Ok(()) } else { Err("请等待模型、提交或构建结束后切换项目".into()) }
    }
}

fn read_registry(file: &Path) -> Result<Registry, String> {
    let bytes = fs::read(file).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_slice::<Registry>(&bytes).map_err(|e| e.to_string()).and_then(|r| {
        let valid_project = |v: &Value| v["projectId"].as_str().is_some_and(|s| !s.is_empty())
            && v["workspaceRoot"].as_str().is_some_and(|s| !s.is_empty());
        if (!r.active.is_null() && !valid_project(&r.active)) || r.recent.iter().any(|v| !valid_project(v)) {
            return Err("项目列表格式不完整".into());
        }
        Ok(r)
    });
    match parsed {
        Ok(value) => Ok(value),
        Err(error) => {
            let backup = file.with_file_name(format!("projects.corrupt-{}.json", new_run_id()));
            fs::rename(file, &backup).map_err(|e| format!("无法备份损坏的项目列表：{e}"))?;
            let mut value = Registry::empty();
            value.recovery_notice = Some(format!("项目列表无法读取，已备份到 {}。请重新打开已有项目或新建项目。", backup.display()));
            app_log("error", "project.registry_recovered", serde_json::json!({ "message": error, "backup": display_path(&backup) }));
            Ok(value)
        }
    }
}
static REGISTRY: OnceLock<Mutex<Option<Registry>>> = OnceLock::new();
fn registry() -> &'static Mutex<Option<Registry>> { REGISTRY.get_or_init(|| Mutex::new(None)) }
fn project_state_root() -> Result<PathBuf, String> { Ok(project_root()?.join(".coopagent")) }
fn default_project_directory() -> Result<PathBuf, String> { Ok(project_root()?.join("projects")) }
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key].as_str().ok_or_else(|| format!("项目缺少 {key}"))
}
fn manager(operation: &str, directory: Option<&str>, name: Option<&str>) -> Result<Value, String> {
    let root = project_root()?;
    let mut command = Command::new(node_path(&root)?);
    command.arg(root.join("scripts/project-workspaces.mjs")).arg(operation);
    if let Some(value) = directory { command.arg(value); }
    if let Some(value) = name { command.arg(value); }
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let output = command.output().map_err(|error| {
        app_log("error", "project.manager.spawn_failed", serde_json::json!({
            "operation": operation, "directory": directory, "message": error.to_string()
        }));
        error.to_string()
    })?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        app_log("error", "project.manager.failed", serde_json::json!({
            "operation": operation, "directory": directory, "exitCode": output.status.code(), "message": message
        }));
        return Err(message);
    }
    let result: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        app_log("error", "project.manager.invalid_output", serde_json::json!({
            "operation": operation, "directory": directory, "message": error.to_string()
        }));
        error.to_string()
    })?;
    app_log("info", "project.manager.completed", serde_json::json!({
        "operation": operation, "directory": directory, "projectId": result.get("projectId")
    }));
    Ok(result)
}
fn save(value: &Registry) -> Result<(), String> {
    let directory = project_state_root()?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let target = directory.join("projects.json");
    let temp = directory.join("projects.json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Windows rename cannot replace an existing file. Use the existing atomic
    // JSON writer in Node, also used for project manifests.
    let mut command = Command::new(node_path(&project_root()?)?);
    command.args(["--input-type=module", "-e", "import {rename} from 'node:fs/promises'; await rename(process.argv[1],process.argv[2]);"])
        .arg(&temp).arg(&target);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    if !command.status().map_err(|e| e.to_string())?.success() { return Err("无法保存最近项目".into()); }
    Ok(())
}
pub(crate) fn initialize() -> Result<(), String> {
    let mut slot = registry().lock().map_err(|e| e.to_string())?;
    if slot.is_some() { return Ok(()); }
    let file = project_state_root()?.join("projects.json");
    let value = if file.is_file() {
        let mut value = read_registry(&file)?;
        if !value.active.is_null() {
            match manager("open", Some(string(&value.active, "workspaceRoot")?), None) {
                Ok(active) => value.active = active,
                Err(error) => value.active["openError"] = error.into(),
            }
        }
        value.generation += 1;
        value
    } else {
        let mut value = Registry::empty();
        // Only preserve a previously registered compatibility workspace.
        // Fresh installations begin without making the source tree editable.
        if project_root()?.join("coop-project.json").is_file() {
            match manager("open", project_root()?.to_str(), None) {
                Ok(active) => { value.active = active.clone(); value.recent.push(active); }
                Err(error) => value.recovery_notice = Some(format!("已有工程未能打开：{error}。请重新选择项目。")),
            }
        }
        value
    };
    save(&value)?;
    *slot = Some(value);
    Ok(())
}
pub(crate) fn context() -> Result<Option<Value>, String> {
    Ok(registry().lock().map_err(|e| e.to_string())?.as_ref().filter(|r| !r.active.is_null()).map(|r| {
        let mut value = r.active.clone(); value["contextGeneration"] = r.generation.into(); value
    }))
}
pub(crate) fn workspace() -> Result<PathBuf, String> {
    match context()? { Some(c) => Ok(PathBuf::from(string(&c, "workspaceRoot")?)), None => project_root() }
}
pub(crate) struct Lease(bool);
impl Drop for Lease {
    fn drop(&mut self) { if self.0 { if let Ok(mut r) = registry().lock() { if let Some(r) = r.as_mut() { r.readers -= 1; } } } }
}
pub(crate) fn acquire(token: Option<&ProjectToken>, internal: bool) -> Result<Lease, String> {
    let mut slot = registry().lock().map_err(|e| e.to_string())?;
    let Some(r) = slot.as_mut() else { return Ok(Lease(false)); };
    if r.active.is_null() { return Err("请先新建或打开项目".into()); }
    if !internal { r.validate(token)?; }
    if let Some(error) = r.active["openError"].as_str() { return Err(error.into()); }
    r.readers += 1;
    Ok(Lease(true))
}
pub(crate) fn environment() -> Result<Vec<(String, String)>, String> {
    let Some(c) = context()? else { return Ok(vec![]); };
    environment_for(&c)
}
fn environment_for(c: &Value) -> Result<Vec<(String, String)>, String> {
    let root = PathBuf::from(string(&c, "workspaceRoot")?);
    let app = project_root()?;
    let mut pairs = vec![
        ("COOPAGENT_WORKSPACE_ROOT".into(), root.display().to_string()),
        ("COOPAGENT_TEMPLATE_ROOT".into(), string(&c, "templateRoot")?.into()),
        ("COOPAGENT_PROJECT_ID".into(), string(&c, "projectId")?.into()),
        ("COOPAGENT_CONTEXT_GENERATION".into(), c["contextGeneration"].to_string()),
        ("COOPAGENT_DATABASE".into(), string(&c, "databaseFile")?.into()),
        ("COOPAGENT_CATALOG_ROOT".into(), Path::new(string(&c, "databaseFile")?).parent().unwrap().join("merged/GameData").display().to_string()),
    ];
    if c["legacy"] != true {
        for (key, dir) in [("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache")] {
            pairs.push((key.into(), root.join(".coopagent/opencode").join(dir).display().to_string()));
        }
        let mut config: Value = serde_json::from_slice(&fs::read(app.join("opencode.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        config["agent"]["coop-planner"]["prompt"] = fs::read_to_string(app.join("runtime/coop-mcp/prompts/planner.md")).map_err(|e| e.to_string())?
            .replace(".opencode/skills/", &format!("{}/.opencode/skills/", app.display().to_string().replace('\\', "/"))).into();
        config["mcp"]["coop"]["command"] = serde_json::json!([node_path(&app)?, app.join("runtime/coop-mcp/server.mjs")]);
        // OpenCode discovers the installation's skills/plugins, while its data
        // and working directory are private to this project. Credentials stay
        // in the application OPENCODE_CONFIG, never in the project config.
        pairs.push(("OPENCODE_CONFIG_DIR".into(), app.join(".opencode").display().to_string()));
        let read = config["agent"]["coop-planner"]["permission"]["read"].as_object_mut().ok_or("Missing read permissions")?;
        for relative in ["docs/scalar-only.md", "docs/patch-plan.md", "docs/schemas/*", ".opencode/skills/coop-scalar-change/*", ".opencode/skills/coop-query/*"] {
            read.insert(app.join(relative).display().to_string().replace('\\', "/"), "allow".into());
        }
        config["agent"]["coop-planner"]["permission"]["external_directory"] = serde_json::json!({"*":"deny", format!("{}/*", app.display().to_string().replace('\\', "/")): "allow"});
        let models = read_json_object(&model_config_path()?)?;
        let auth = read_json_object(&opencode_auth_path()?)?;
        if let Some(providers) = models["provider"].as_object() {
            config["provider"] = serde_json::json!({});
            for (id, provider) in providers {
                config["provider"][id] = provider.clone();
                if let Some(key) = auth[id]["key"].as_str() {
                    config["provider"][id]["options"]["apiKey"] = key.into();
                }
            }
        }
        if let Some(model) = models["model"].as_str() { config["model"] = model.into(); }
        pairs.push(("OPENCODE_CONFIG_CONTENT".into(), config.to_string()));
    }
    Ok(pairs)
}
pub(crate) fn configure(command: &mut Command) -> Result<(), String> {
    command.current_dir(workspace()?).envs(environment()?);
    Ok(())
}

#[tauri::command]
pub(crate) fn project_list() -> Result<Value, String> {
    initialize()?;
    let slot = registry().lock().map_err(|e| e.to_string())?;
    let r = slot.as_ref().ok_or("项目尚未初始化")?;
    project_summary(r)
}
fn project_summary(r: &Registry) -> Result<Value, String> {
    let mut active = r.active.clone();
    if !active.is_null() { active["contextGeneration"] = r.generation.into(); }
    Ok(serde_json::json!({"active":active,"recent":r.recent,"defaultDirectory":default_project_directory()?,"recoveryNotice":r.recovery_notice}))
}
#[tauri::command]
pub(crate) fn project_change(operation: String, directory: Option<String>, name: Option<String>,
    project: Option<ProjectToken>, state: State<'_, AgentState>) -> Result<Value, String> {
    let mut slot = registry().lock().map_err(|e| e.to_string())?;
    let r = slot.as_mut().ok_or("项目尚未初始化")?;
    r.validate(project.as_ref())?;
    r.ensure_idle(state.running.load(Ordering::Acquire) || state.closing.load(Ordering::Acquire))?;
    if !r.active.is_null() && r.active["openError"].is_null() { manager("idle", Some(string(&r.active, "workspaceRoot")?), None)?; }
    let target = match operation.as_str() {
        "create" => manager("create", Some(directory.as_deref().ok_or("请选择新目录")?), Some(name.as_deref().ok_or("请输入名称")?))?,
        "open" => manager("open", Some(directory.as_deref().ok_or("请选择项目目录")?), None)?,
        "rename" => manager("rename", Some(string(&r.active, "workspaceRoot")?), Some(name.as_deref().ok_or("请输入名称")?))?,
        _ => return Err("未知项目操作".into()),
    };
    let mut next = r.clone(); next.active = target.clone(); next.generation += 1;
    next.recovery_notice = None;
    next.recent.retain(|p| p["projectId"] != target["projectId"]); next.recent.insert(0, target); next.recent.truncate(20);
    let recovery_busy = AgentBusyGuard::acquire(&state)?;
    save(&next)?;
    *state.snapshot.lock().map_err(|e| e.to_string())? = None;
    *r = next;
    thread::spawn(move || {
        let _busy = recovery_busy;
        if let Err(error) = run_plan_jobs_command("recover", None) {
            app_log("error", "project.submission_recovery.failed", serde_json::json!({ "message": &error }));
            eprintln!("Project submission recovery: {error}");
        }
    });
    project_summary(r)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_registry_is_preserved_and_leaves_a_usable_empty_selection() {
        let directory = std::env::temp_dir().join(format!("coop-registry-{}", new_run_id()));
        fs::create_dir(&directory).unwrap();
        for bytes in [b"{broken".as_slice(), b"{\"active\":{},\"recent\":[],\"generation\":1}".as_slice()] {
            let file = directory.join("projects.json"); fs::write(&file, bytes).unwrap();
            let value = read_registry(&file).unwrap();
            assert!(value.active.is_null()); assert!(value.recovery_notice.is_some());
            assert!(value.validate(None).is_ok()); assert!(!file.exists());
            assert!(fs::read_dir(&directory).unwrap().flatten().any(|e| fs::read(e.path()).unwrap() == bytes));
        }
        let file = directory.join("projects.json");
        let original = serde_json::json!({"active":{"projectId":"A","workspaceRoot":"somewhere"},"recent":[],"generation":7});
        fs::write(&file, serde_json::to_vec(&original).unwrap()).unwrap();
        let value = read_registry(&file).unwrap();
        assert_eq!(value.active["projectId"], "A"); assert!(value.validate(None).is_err());
        assert!(value.recovery_notice.is_none()); assert!(file.exists());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn a_fresh_registry_has_no_editable_source_workspace() {
        let value = Registry::empty();
        let summary = project_summary(&value).unwrap();
        assert!(summary["active"].is_null());
        assert_eq!(summary["recent"].as_array().unwrap().len(), 0);
        assert!(value.validate(None).is_ok());
        assert!(value.validate(Some(&ProjectToken {project_id:"old".into(),context_generation:1})).is_err());
    }
    #[test]
    fn identity_generation_and_busy_leases_are_backend_boundaries() {
        let mut registry = Registry { active: serde_json::json!({"projectId":"A"}), generation: 4, ..Registry::empty() };
        let current = ProjectToken { project_id: "A".into(), context_generation: 4 };
        assert!(registry.validate(Some(&current)).is_ok());
        assert!(registry.validate(None).is_err());
        assert!(registry.validate(Some(&ProjectToken {project_id:"B".into(), ..current.clone()})).is_err());
        registry.generation += 1;
        assert!(registry.validate(Some(&current)).is_err());
        assert!(registry.ensure_idle(false).is_ok());
        assert!(registry.ensure_idle(true).is_err());
        registry.readers = 1;
        assert!(registry.ensure_idle(false).is_err());
    }
    #[test]
    fn project_registry_and_default_projects_are_local_to_this_checkout() {
        let root = project_root().unwrap();
        assert_eq!(project_state_root().unwrap(), root.join(".coopagent"));
        assert_eq!(default_project_directory().unwrap(), root.join("projects"));
    }
    #[test]
    fn bundled_opencode_resolves_installation_tools_and_skills_in_private_workspace() {
        let root = project_root().unwrap();
        let Ok(executable) = opencode_path(&root) else { return; };
        let directory = std::env::temp_dir().join(format!("coop-project-config-{}", new_run_id()));
        let mut context = manager("create", directory.to_str(), Some("配置验收")).unwrap();
        context["contextGeneration"] = 7.into();
        let environment = environment_for(&context).unwrap();
        let mut command = Command::new(&executable);
        command.current_dir(&directory).envs(environment.iter().map(|(k,v)|(k,v))).args(["debug", "config"]);
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let output = command.output().unwrap();
        assert!(output.status.success(), "OpenCode could not resolve project configuration");
        // Never print the resolved configuration: it contains injected credentials.
        let config: Value = serde_json::from_slice(&output.stdout).expect("valid OpenCode config");
        assert!(config["mcp"]["coop"]["command"][1].as_str().unwrap().contains("runtime"));
        assert!(config["agent"]["coop-planner"]["prompt"].as_str().unwrap().contains(&root.display().to_string().replace('\\', "/")));
        let output = Command::new(&executable).current_dir(&directory).envs(environment).args(["debug", "skill"]).output().unwrap();
        assert!(output.status.success());
        let skills: Value = serde_json::from_slice(&output.stdout).expect("valid skill catalog");
        for name in ["coop-query", "coop-scalar-change"] {
            assert!(skills.as_array().unwrap().iter().any(|skill| skill["name"] == name), "Missing installed skill: {name}");
        }
        assert!(!directory.join(".coopagent/opencode/data/opencode/auth.json").exists());
        fs::remove_dir_all(&directory).unwrap();
    }
}

#[tauri::command]
pub(crate) fn project_ui(project: ProjectToken, value: Option<Value>) -> Result<Value, String> {
    let _lease = acquire(Some(&project), false)?;
    let root = workspace()?;
    let file = root.join(".coopagent/ui.json");
    if let Some(value) = value {
        // UI data only: never an arbitrary filesystem write endpoint.
        if value.to_string().len() > 256_000 { return Err("项目界面状态过大".into()); }
        let mut command = Command::new(node_path(&project_root()?)?);
        command.arg(project_root()?.join("scripts/project-workspaces.mjs")).arg("ui-write").arg(&root)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        child.stdin.take().ok_or("UI input unavailable")?.write_all(value.to_string().as_bytes()).map_err(|e| e.to_string())?;
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).into()); }
        return Ok(value);
    }
    if !file.exists() { return Ok(serde_json::json!({})); }
    serde_json::from_slice(&fs::read(file).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}
