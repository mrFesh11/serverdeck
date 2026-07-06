#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;
mod term;
mod vault;

use base64::Engine;
use serde::Serialize;
use ssh::{ControlMap, ExecOut, OwnersMap, ServerCfg};
use ssh2::FileStat;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use term::{TermMap, TermMsg};

struct AppState {
    controls: ControlMap,
    owners: OwnersMap,
    terms: TermMap,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    name: String,
    ftype: String,
    size: u64,
    perms: String,
    owner: String,
    mtime: u64,
    hidden: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewOut {
    text: Option<String>,
    size: u64,
}

fn stat_entry(name: String, st: &FileStat, owners: &HashMap<u32, String>) -> FileEntry {
    let perm = st.perm.unwrap_or(0);
    let is_link = perm & 0o170000 == 0o120000;
    let is_dir = st.is_dir();
    let hidden = name.starts_with('.');
    FileEntry {
        ftype: if is_dir {
            "dir".into()
        } else if is_link {
            "link".into()
        } else {
            "file".into()
        },
        size: st.size.unwrap_or(0),
        perms: ssh::perms_string(perm & 0o777, is_dir, is_link),
        owner: st
            .uid
            .map(|u| owners.get(&u).cloned().unwrap_or_else(|| u.to_string()))
            .unwrap_or_default(),
        mtime: st.mtime.unwrap_or(0),
        hidden,
        name,
    }
}

fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    async move {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
async fn ssh_exec(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    cmd: String,
) -> Result<ExecOut, String> {
    let controls = state.controls.clone();
    blocking(move || ssh::with_session(&controls, &cfg, |s| ssh::exec(s, &cmd))).await
}

#[tauri::command]
async fn ssh_exec_pty(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    cmd: String,
) -> Result<ExecOut, String> {
    let controls = state.controls.clone();
    let id = cfg.id.clone();
    blocking(move || ssh::with_session(&controls, &cfg, |s| ssh::exec_pty(s, &cmd, &id))).await
}

#[tauri::command]
fn provide_secret(key: String, value: String) {
    ssh::set_secret(key, value);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[tauri::command]
fn vault_status() -> VaultStatus {
    VaultStatus {
        exists: vault::exists(),
        unlocked: vault::is_unlocked(),
    }
}

#[tauri::command]
fn vault_create(password: String) -> Result<(), String> {
    vault::create(&password)
}

#[tauri::command]
fn vault_unlock(password: String) -> Result<(), String> {
    let secrets = vault::unlock(&password)?;
    for (k, v) in secrets {
        ssh::set_secret(k, v);
    }
    Ok(())
}

#[tauri::command]
fn vault_store(id: String, value: String) -> Result<(), String> {
    ssh::set_secret(id.clone(), value.clone());
    vault::store(&id, &value)
}

#[tauri::command]
fn vault_forget(id: String) -> Result<(), String> {
    vault::forget(&id)
}

#[tauri::command]
fn vault_lock() {
    vault::lock();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceUnit {
    name: String,
    load: String,
    active: String,
    sub: String,
    desc: String,
}

#[tauri::command]
async fn list_services(
    state: State<'_, AppState>,
    cfg: ServerCfg,
) -> Result<Vec<ServiceUnit>, String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |s| {
            let res = ssh::exec(
                s,
                "systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null",
            )?;
            Ok(res
                .out
                .lines()
                .filter_map(|l| {
                    let p: Vec<&str> = l.split_whitespace().collect();
                    if p.len() < 4 || !p[0].ends_with(".service") {
                        return None;
                    }
                    Some(ServiceUnit {
                        name: p[0].trim_end_matches(".service").to_string(),
                        load: p[1].to_string(),
                        active: p[2].to_string(),
                        sub: p[3].to_string(),
                        desc: p[4..].join(" "),
                    })
                })
                .collect())
        })
    })
    .await
}

#[tauri::command]
async fn systemd_action(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    action: String,
    unit: String,
) -> Result<ExecOut, String> {
    let allowed = ["start", "stop", "restart", "reload", "status", "enable", "disable"];
    if !allowed.contains(&action.as_str()) {
        return Err(format!("недопустимое действие: {action}"));
    }
    let quoted = format!("'{}'", unit.replace('\'', r"'\''"));
    let flags = if action == "status" { " --no-pager -l" } else { "" };
    let cmd = format!("systemctl {action} {quoted}{flags} 2>&1");
    let controls = state.controls.clone();
    blocking(move || ssh::with_session(&controls, &cfg, |s| ssh::exec(s, &cmd))).await
}

#[tauri::command]
async fn docker_action(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    action: String,
    name: String,
) -> Result<ExecOut, String> {
    let allowed = ["start", "stop", "restart", "pause", "unpause", "kill", "rm"];
    if !allowed.contains(&action.as_str()) {
        return Err(format!("недопустимое действие: {action}"));
    }
    let quoted = format!("'{}'", name.replace('\'', r"'\''"));
    let cmd = if action == "rm" {
        format!("docker rm -f {quoted} 2>&1")
    } else {
        format!("docker {action} {quoted} 2>&1")
    };
    let controls = state.controls.clone();
    blocking(move || ssh::with_session(&controls, &cfg, |s| ssh::exec(s, &cmd))).await
}

#[tauri::command]
fn trust_host_key(label: String, fingerprint: String) -> Result<(), String> {
    ssh::trust_host(&label, &fingerprint)
}

#[tauri::command]
async fn import_ssh_config() -> Result<Vec<ssh::ParsedHost>, String> {
    blocking(|| Ok(ssh::parse_ssh_config())).await
}

#[tauri::command]
async fn test_connection(cfg: ServerCfg) -> Result<u64, String> {
    blocking(move || {
        let start = std::time::Instant::now();
        let sess = ssh::connect(&cfg)?;
        ssh::exec(&sess, "true")?;
        Ok(start.elapsed().as_millis() as u64)
    })
    .await
}

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let controls = state.controls.clone();
    let owners = state.owners.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let names = ssh::owners_for(&owners, sess, &cfg.id);
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let list = sftp.readdir(Path::new(&path)).map_err(|e| e.to_string())?;
            Ok(list
                .into_iter()
                .map(|(p, st)| {
                    stat_entry(
                        p.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        &st,
                        &names,
                    )
                })
                .collect())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_preview(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
) -> Result<PreviewOut, String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let mut f = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
            let size = f.stat().map(|s| s.size.unwrap_or(0)).unwrap_or(0);
            let mut buf = vec![0u8; 16384];
            let mut read = 0;
            while read < buf.len() {
                match f.read(&mut buf[read..]) {
                    Ok(0) => break,
                    Ok(n) => read += n,
                    Err(e) => return Err(e.to_string()),
                }
            }
            buf.truncate(read);
            let text = if buf.contains(&0) {
                None
            } else {
                Some(String::from_utf8_lossy(&buf).into_owned())
            };
            Ok(PreviewOut { text, size })
        })
    })
    .await
}

#[tauri::command]
async fn sftp_read_text(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
) -> Result<String, String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let mut f = sftp.open(Path::new(&path)).map_err(|e| e.to_string())?;
            let size = f.stat().map(|s| s.size.unwrap_or(0)).unwrap_or(0);
            if size > 4 * 1024 * 1024 {
                return Err("Файл слишком большой для редактора (> 4 МБ)".into());
            }
            let mut buf = Vec::new();
            f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            if buf.contains(&0) {
                return Err("Бинарный файл — редактирование недоступно".into());
            }
            Ok(String::from_utf8_lossy(&buf).into_owned())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_write_text(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
    content: String,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let mut f = sftp.create(Path::new(&path)).map_err(|e| e.to_string())?;
            f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
            f.flush().ok();
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_download(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    remote: String,
    local: String,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let mut src = sftp.open(Path::new(&remote)).map_err(|e| e.to_string())?;
            let mut dst = std::fs::File::create(&local).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_upload(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    local: String,
    remote: String,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let mut src = std::fs::File::open(&local).map_err(|e| e.to_string())?;
            let mut dst = sftp.create(Path::new(&remote)).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
            dst.flush().ok();
            Ok(())
        })
    })
    .await
}

fn count_local_files(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += count_local_files(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}

fn upload_dir_rec(
    app: &AppHandle,
    sftp: &ssh2::Sftp,
    local: &Path,
    remote: &str,
    total: usize,
    done: &mut usize,
) -> Result<(), String> {
    sftp.mkdir(Path::new(remote), 0o755).ok();
    for entry in std::fs::read_dir(local).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_remote = format!("{}/{}", remote.trim_end_matches('/'), name);
        if entry.path().is_dir() {
            upload_dir_rec(app, sftp, &entry.path(), &child_remote, total, done)?;
        } else {
            let mut src = std::fs::File::open(entry.path()).map_err(|e| e.to_string())?;
            let mut dst = sftp.create(Path::new(&child_remote)).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
            *done += 1;
            let _ = app.emit("transfer-progress", (done.clone(), total, name));
        }
    }
    Ok(())
}

fn download_dir_rec(
    app: &AppHandle,
    sftp: &ssh2::Sftp,
    remote: &str,
    local: &Path,
    total: usize,
    done: &mut usize,
) -> Result<(), String> {
    std::fs::create_dir_all(local).map_err(|e| e.to_string())?;
    let list = sftp.readdir(Path::new(remote)).map_err(|e| e.to_string())?;
    for (p, st) in list {
        let name = match p.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => continue,
        };
        let child_remote = format!("{}/{}", remote.trim_end_matches('/'), name);
        let child_local = local.join(&name);
        if st.is_dir() {
            download_dir_rec(app, sftp, &child_remote, &child_local, total, done)?;
        } else {
            let mut src = sftp.open(Path::new(&child_remote)).map_err(|e| e.to_string())?;
            let mut dst = std::fs::File::create(&child_local).map_err(|e| e.to_string())?;
            std::io::copy(&mut src, &mut dst).map_err(|e| e.to_string())?;
            *done += 1;
            let _ = app.emit("transfer-progress", (done.clone(), total, name));
        }
    }
    Ok(())
}

fn count_remote_files(sftp: &ssh2::Sftp, remote: &str) -> usize {
    let mut n = 0;
    if let Ok(list) = sftp.readdir(Path::new(remote)) {
        for (p, st) in list {
            let name = p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if st.is_dir() {
                n += count_remote_files(sftp, &format!("{}/{}", remote.trim_end_matches('/'), name));
            } else {
                n += 1;
            }
        }
    }
    n
}

#[tauri::command]
async fn sftp_upload_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: ServerCfg,
    local: String,
    remote: String,
) -> Result<usize, String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let total = count_local_files(Path::new(&local));
            let mut done = 0;
            upload_dir_rec(&app, &sftp, Path::new(&local), &remote, total, &mut done)?;
            Ok(done)
        })
    })
    .await
}

#[tauri::command]
async fn sftp_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: ServerCfg,
    remote: String,
    local: String,
) -> Result<usize, String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            let total = count_remote_files(&sftp, &remote);
            let mut done = 0;
            download_dir_rec(&app, &sftp, &remote, Path::new(&local), total, &mut done)?;
            Ok(done)
        })
    })
    .await
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    from: String,
    to: String,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            sftp.rename(Path::new(&from), Path::new(&to), None)
                .map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_delete(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            if is_dir {
                let quoted = format!("'{}'", path.replace('\'', r"'\''"));
                let res = ssh::exec(sess, &format!("rm -rf -- {quoted}"))?;
                if res.code != 0 {
                    return Err(res.out);
                }
                Ok(())
            } else {
                let sftp = sess.sftp().map_err(|e| e.to_string())?;
                sftp.unlink(Path::new(&path)).map_err(|e| e.to_string())
            }
        })
    })
    .await
}

#[tauri::command]
async fn sftp_chmod(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            sftp.setstat(
                Path::new(&path),
                FileStat {
                    size: None,
                    uid: None,
                    gid: None,
                    perm: Some(mode),
                    atime: None,
                    mtime: None,
                },
            )
            .map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, AppState>,
    cfg: ServerCfg,
    path: String,
) -> Result<(), String> {
    let controls = state.controls.clone();
    blocking(move || {
        ssh::with_session(&controls, &cfg, |sess| {
            let sftp = sess.sftp().map_err(|e| e.to_string())?;
            sftp.mkdir(Path::new(&path), 0o755).map_err(|e| e.to_string())
        })
    })
    .await
}

#[tauri::command]
fn local_list(path: String) -> Result<Vec<FileEntry>, String> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let mtime = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        #[cfg(unix)]
        let (perms, owner) = {
            use std::os::unix::fs::MetadataExt;
            use std::os::unix::fs::PermissionsExt;
            (
                ssh::perms_string(md.permissions().mode() & 0o777, md.is_dir(), false),
                md.uid().to_string(),
            )
        };
        #[cfg(not(unix))]
        let (perms, owner) = (String::from("—"), String::new());
        out.push(FileEntry {
            ftype: if md.is_dir() { "dir".into() } else { "file".into() },
            size: md.len(),
            perms,
            owner,
            mtime,
            hidden: name.starts_with('.'),
            name,
        });
    }
    Ok(out)
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into())
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = config_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!(null)),
    }
}

#[tauri::command]
fn save_config(app: AppHandle, cfg: serde_json::Value) -> Result<(), String> {
    let path = config_path(&app)?;
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).ok();
    }
    Ok(())
}

#[tauri::command]
fn term_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cfg: ServerCfg,
    termId: String,
    cols: u32,
    rows: u32,
) {
    term::open(app, state.terms.clone(), cfg, termId, cols, rows);
}

#[tauri::command]
fn term_write(state: State<'_, AppState>, termId: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    if let Some(tx) = state.terms.lock().unwrap().get(&termId) {
        tx.send(TermMsg::Data(bytes)).ok();
    }
    Ok(())
}

#[tauri::command]
fn term_resize(state: State<'_, AppState>, termId: String, cols: u32, rows: u32) {
    if let Some(tx) = state.terms.lock().unwrap().get(&termId) {
        tx.send(TermMsg::Resize(cols, rows)).ok();
    }
}

#[tauri::command]
fn term_close(state: State<'_, AppState>, termId: String) {
    if let Some(tx) = state.terms.lock().unwrap().remove(&termId) {
        tx.send(TermMsg::Close).ok();
    }
}

#[tauri::command]
fn disconnect_server(state: State<'_, AppState>, serverId: String) {
    state.controls.lock().unwrap().remove(&serverId);
    state.owners.lock().unwrap().remove(&serverId);
    ssh::clear_secret(&serverId);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItem::with_id(app, "show", "Показать ServerDeck", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("ServerDeck")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(win) = app.get_webview_window("main") {
                    win.show().ok();
                    win.unminimize().ok();
                    win.set_focus().ok();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            setup_tray(app)?;
            if let Ok(dir) = app.path().app_config_dir() {
                std::fs::create_dir_all(&dir).ok();
                let _ = ssh::KNOWN_HOSTS.set(dir.join("known_hosts"));
                let _ = vault::VAULT_PATH.set(dir.join("vault.bin"));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window.hide().ok();
                api.prevent_close();
            }
        })
        .manage(AppState {
            controls: Arc::new(Mutex::new(HashMap::new())),
            owners: Arc::new(Mutex::new(HashMap::new())),
            terms: Arc::new(Mutex::new(HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            ssh_exec,
            ssh_exec_pty,
            docker_action,
            systemd_action,
            list_services,
            provide_secret,
            vault_status,
            vault_create,
            vault_unlock,
            vault_store,
            vault_forget,
            vault_lock,
            trust_host_key,
            import_ssh_config,
            test_connection,
            sftp_list,
            sftp_preview,
            sftp_read_text,
            sftp_write_text,
            sftp_download,
            sftp_upload_dir,
            sftp_download_dir,
            sftp_upload,
            sftp_rename,
            sftp_delete,
            sftp_chmod,
            sftp_mkdir,
            local_list,
            home_dir,
            load_config,
            save_config,
            term_open,
            term_write,
            term_resize,
            term_close,
            disconnect_server
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
