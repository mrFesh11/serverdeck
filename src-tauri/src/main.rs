#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ssh;
mod term;

use base64::Engine;
use serde::Serialize;
use ssh::{ControlMap, ExecOut, OwnersMap, ServerCfg};
use ssh2::FileStat;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
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
        .setup(|app| {
            setup_tray(app)?;
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
            test_connection,
            sftp_list,
            sftp_preview,
            sftp_download,
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
