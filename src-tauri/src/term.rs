use crate::ssh::{self, ServerCfg};
use base64::Engine;
use std::collections::HashMap;
use std::io::{ErrorKind, Read, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub enum TermMsg {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

pub type TermMap = Arc<Mutex<HashMap<String, Sender<TermMsg>>>>;

pub fn open(
    app: AppHandle,
    terms: TermMap,
    cfg: ServerCfg,
    id: String,
    cols: u32,
    rows: u32,
) {
    let (tx, rx) = mpsc::channel();
    terms.lock().unwrap().insert(id.clone(), tx);
    thread::spawn(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let result: Result<(), String> = (|| {
            let sess = ssh::connect(&cfg)?;
            let mut ch = sess.channel_session().map_err(|e| e.to_string())?;
            ch.request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
                .map_err(|e| e.to_string())?;
            ch.shell().map_err(|e| e.to_string())?;
            let _ = app.emit(&format!("term-ready-{id}"), ());
            sess.set_blocking(false);
            let mut buf = [0u8; 16384];
            let mut pending: Vec<u8> = Vec::new();
            loop {
                while let Ok(m) = rx.try_recv() {
                    match m {
                        TermMsg::Data(d) => pending.extend_from_slice(&d),
                        TermMsg::Resize(c, r) => {
                            let _ = ch.request_pty_size(c, r, None, None);
                        }
                        TermMsg::Close => return Ok(()),
                    }
                }
                if !pending.is_empty() {
                    match ch.write(&pending) {
                        Ok(n) => {
                            pending.drain(..n);
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(e) => return Err(e.to_string()),
                    }
                }
                let mut got = false;
                match ch.read(&mut buf) {
                    Ok(0) => return Ok(()),
                    Ok(n) => {
                        got = true;
                        let _ = app.emit(&format!("term-out-{id}"), b64.encode(&buf[..n]));
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e.to_string()),
                }
                if ch.eof() {
                    return Ok(());
                }
                if !got && pending.is_empty() {
                    thread::sleep(Duration::from_millis(12));
                }
            }
        })();
        let _ = app.emit(&format!("term-closed-{id}"), result.err());
        terms.lock().unwrap().remove(&id);
    });
}
