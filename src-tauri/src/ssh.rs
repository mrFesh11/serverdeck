use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub type ControlMap = Arc<Mutex<HashMap<String, Arc<Mutex<Option<Session>>>>>>;
pub type OwnersMap = Arc<Mutex<HashMap<String, HashMap<u32, String>>>>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpCfg {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerCfg {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default)]
    pub jump: Option<JumpCfg>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOut {
    pub code: i32,
    pub ms: u64,
    pub out: String,
}

pub fn expand_tilde(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default();
        format!("{}{}", home, rest)
    } else {
        p.to_string()
    }
}

fn tcp_connect(host: &str, port: u16) -> Result<TcpStream, String> {
    let sock = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve {host}: {e}"))?
        .next()
        .ok_or_else(|| format!("cannot resolve {host}"))?;
    let tcp = TcpStream::connect_timeout(&sock, Duration::from_secs(8))
        .map_err(|e| format!("connect {host}:{port}: {e}"))?;
    tcp.set_nodelay(true).ok();
    Ok(tcp)
}

fn session_over(tcp: TcpStream, user: &str, key_path: &str) -> Result<Session, String> {
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(20000);
    sess.handshake().map_err(|e| format!("handshake: {e}"))?;

    let key = expand_tilde(key_path.trim());
    let mut last_err = String::new();
    if !key.is_empty() {
        if let Err(e) = sess.userauth_pubkey_file(user, None, Path::new(&key), None) {
            last_err = e.to_string();
        }
    }
    if !sess.authenticated() {
        if let Err(e) = sess.userauth_agent(user) {
            if last_err.is_empty() {
                last_err = e.to_string();
            }
        }
    }
    if !sess.authenticated() {
        return Err(format!("auth failed: {last_err}"));
    }
    Ok(sess)
}

fn tunnel_via_jump(jump: &JumpCfg, target_host: &str, target_port: u16) -> Result<TcpStream, String> {
    use std::io::{ErrorKind, Write};
    use std::net::TcpListener;

    let jtcp = tcp_connect(&jump.host, jump.port)?;
    let jsess = session_over(jtcp, &jump.user, &jump.key_path)
        .map_err(|e| format!("jump {}: {e}", jump.host))?;
    let mut channel = jsess
        .channel_direct_tcpip(target_host, target_port, None)
        .map_err(|e| format!("jump tunnel: {e}"))?;

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let (mut local, _) = match listener.accept() {
            Ok(v) => v,
            Err(_) => return,
        };
        drop(listener);
        local.set_nodelay(true).ok();
        local.set_nonblocking(true).ok();
        jsess.set_blocking(false);
        let mut buf = [0u8; 32768];
        let mut to_local: Vec<u8> = Vec::new();
        let mut to_remote: Vec<u8> = Vec::new();
        let mut local_eof = false;
        loop {
            let mut progress = false;
            if to_local.is_empty() {
                match channel.read(&mut buf) {
                    Ok(0) => {
                        if to_remote.is_empty() {
                            return;
                        }
                    }
                    Ok(n) => {
                        to_local.extend_from_slice(&buf[..n]);
                        progress = true;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => return,
                }
            }
            if !to_local.is_empty() {
                match local.write(&to_local) {
                    Ok(n) if n > 0 => {
                        to_local.drain(..n);
                        progress = true;
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => return,
                }
            }
            if !local_eof && to_remote.is_empty() {
                match local.read(&mut buf) {
                    Ok(0) => local_eof = true,
                    Ok(n) => {
                        to_remote.extend_from_slice(&buf[..n]);
                        progress = true;
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => return,
                }
            }
            if !to_remote.is_empty() {
                match channel.write(&to_remote) {
                    Ok(n) if n > 0 => {
                        to_remote.drain(..n);
                        progress = true;
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                    Err(_) => return,
                }
            }
            if channel.eof() && to_local.is_empty() {
                return;
            }
            if local_eof && to_remote.is_empty() {
                channel.send_eof().ok();
                return;
            }
            if !progress {
                std::thread::sleep(Duration::from_millis(4));
            }
        }
    });

    TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())
}

pub fn connect(cfg: &ServerCfg) -> Result<Session, String> {
    let tcp = match &cfg.jump {
        Some(jump) => tunnel_via_jump(jump, &cfg.host, cfg.port)?,
        None => tcp_connect(&cfg.host, cfg.port)?,
    };
    session_over(tcp, &cfg.user, &cfg.key_path)
}

pub fn exec(sess: &Session, cmd: &str) -> Result<ExecOut, String> {
    let start = Instant::now();
    let mut ch = sess.channel_session().map_err(|e| e.to_string())?;
    ch.exec(cmd).map_err(|e| e.to_string())?;
    let mut out = String::new();
    ch.read_to_string(&mut out).map_err(|e| e.to_string())?;
    let mut err = String::new();
    ch.stderr().read_to_string(&mut err).ok();
    ch.wait_close().ok();
    let code = ch.exit_status().unwrap_or(-1);
    if !err.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&err);
    }
    Ok(ExecOut {
        code,
        ms: start.elapsed().as_millis() as u64,
        out,
    })
}

pub fn with_session<T>(
    controls: &ControlMap,
    cfg: &ServerCfg,
    f: impl Fn(&Session) -> Result<T, String>,
) -> Result<T, String> {
    let arc = {
        let mut map = controls.lock().unwrap();
        map.entry(cfg.id.clone())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let mut guard = arc.lock().unwrap();
    if guard.is_none() {
        *guard = Some(connect(cfg)?);
    }
    match f(guard.as_ref().unwrap()) {
        Ok(v) => Ok(v),
        Err(_) => {
            *guard = None;
            *guard = Some(connect(cfg)?);
            f(guard.as_ref().unwrap())
        }
    }
}

pub fn owners_for(
    owners: &OwnersMap,
    sess: &Session,
    server_id: &str,
) -> HashMap<u32, String> {
    {
        let cache = owners.lock().unwrap();
        if let Some(m) = cache.get(server_id) {
            return m.clone();
        }
    }
    let mut map = HashMap::new();
    if let Ok(res) = exec(sess, "getent passwd 2>/dev/null | cut -d: -f1,3") {
        for line in res.out.lines() {
            if let Some((name, uid)) = line.split_once(':') {
                if let Ok(uid) = uid.trim().parse::<u32>() {
                    map.insert(uid, name.to_string());
                }
            }
        }
    }
    owners
        .lock()
        .unwrap()
        .insert(server_id.to_string(), map.clone());
    map
}

pub fn perms_string(mode: u32, is_dir: bool, is_link: bool) -> String {
    let t = if is_link {
        'l'
    } else if is_dir {
        'd'
    } else {
        '-'
    };
    let mut s = String::with_capacity(10);
    s.push(t);
    for shift in [6u32, 3, 0] {
        let bits = (mode >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}
