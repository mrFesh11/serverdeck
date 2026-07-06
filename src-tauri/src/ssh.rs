use base64::Engine;
use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub static KNOWN_HOSTS: OnceLock<PathBuf> = OnceLock::new();
static KNOWN_HOSTS_LOCK: Mutex<()> = Mutex::new(());

/// In-memory only, never persisted. Keys: server/jump id for connection
/// passphrase/password, "sudo:<id>" for sudo password.
static SECRETS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn secrets() -> &'static Mutex<HashMap<String, String>> {
    SECRETS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn set_secret(key: String, value: String) {
    secrets().lock().unwrap().insert(key, value);
}

pub fn get_secret(key: &str) -> Option<String> {
    secrets().lock().unwrap().get(key).cloned()
}

pub fn clear_secret(key: &str) {
    let mut m = secrets().lock().unwrap();
    m.remove(key);
    m.remove(&format!("sudo:{key}"));
}

pub fn fingerprint(sess: &Session) -> Result<String, String> {
    let hash = sess
        .host_key_hash(ssh2::HashType::Sha256)
        .ok_or("server did not present a host key")?;
    Ok(format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD_NO_PAD.encode(hash)
    ))
}

/// Persist a trusted fingerprint for `label`, replacing any existing line.
pub fn trust_host(label: &str, fp: &str) -> Result<(), String> {
    let Some(path) = KNOWN_HOSTS.get() else {
        return Ok(());
    };
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap();
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mut out = String::new();
    for line in content.lines() {
        if line.split_once(' ').map(|(h, _)| h != label).unwrap_or(true) {
            out.push_str(line);
            out.push('\n');
        }
    }
    out.push_str(&format!("{label} {fp}\n"));
    std::fs::write(path, &out).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).ok();
    }
    Ok(())
}

fn check_host_key(sess: &Session, label: &str) -> Result<(), String> {
    if KNOWN_HOSTS.get().is_none() {
        return Ok(());
    }
    let path = KNOWN_HOSTS.get().unwrap();
    let fp = fingerprint(sess)?;
    let _guard = KNOWN_HOSTS_LOCK.lock().unwrap();
    let content = std::fs::read_to_string(path).unwrap_or_default();
    for line in content.lines() {
        if let Some((h, known)) = line.split_once(' ') {
            if h == label {
                if known == fp {
                    return Ok(());
                }
                // Machine-parseable: frontend shows accept/reject dialog.
                return Err(format!("HOSTKEY_MISMATCH\t{label}\t{known}\t{fp}"));
            }
        }
    }
    // First contact (TOFU): trust and record silently.
    drop(_guard);
    trust_host(label, &fp)
}

/// Detect whether a private key file is passphrase-encrypted, so we can prompt
/// before ssh2 fails opaquely.
fn key_encrypted(path: &str) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    if content.contains("ENCRYPTED") {
        return true;
    }
    if content.contains("OPENSSH PRIVATE KEY") {
        let b64: String = content
            .lines()
            .filter(|l| !l.contains("-----"))
            .collect::<String>();
        if let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) {
            const MAGIC: &[u8] = b"openssh-key-v1\0";
            if raw.len() > MAGIC.len() + 4 && raw.starts_with(MAGIC) {
                let off = MAGIC.len();
                let len =
                    u32::from_be_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]) as usize;
                if off + 4 + len <= raw.len() {
                    let cipher = &raw[off + 4..off + 4 + len];
                    return cipher != b"none";
                }
            }
        }
    }
    false
}

pub type ControlMap = Arc<Mutex<HashMap<String, Arc<Mutex<Option<Session>>>>>>;
pub type OwnersMap = Arc<Mutex<HashMap<String, HashMap<u32, String>>>>;

fn default_auth() -> String {
    "key".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpCfg {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub key_path: String,
    #[serde(default = "default_auth")]
    pub auth: String,
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
    #[serde(default = "default_auth")]
    pub auth: String,
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

struct AuthParams<'a> {
    user: &'a str,
    auth: &'a str,
    key_path: &'a str,
    secret_key: &'a str,
    label: &'a str,
}

fn session_over(tcp: TcpStream, p: AuthParams) -> Result<Session, String> {
    let mut sess = Session::new().map_err(|e| e.to_string())?;
    sess.set_tcp_stream(tcp);
    sess.set_timeout(20000);
    sess.handshake().map_err(|e| format!("handshake: {e}"))?;
    check_host_key(&sess, p.label)?;

    let secret = get_secret(p.secret_key);
    let mut last_err = String::new();

    match p.auth {
        "password" => {
            let Some(pw) = secret else {
                return Err(format!("AUTH_PASSWORD_REQUIRED\t{}", p.secret_key));
            };
            if let Err(e) = sess.userauth_password(p.user, &pw) {
                return Err(format!("AUTH_PASSWORD_WRONG\t{}\t{e}", p.secret_key));
            }
        }
        "agent" => {
            sess.userauth_agent(p.user).map_err(|e| e.to_string())?;
        }
        _ => {
            let key = expand_tilde(p.key_path.trim());
            if key.is_empty() {
                sess.userauth_agent(p.user).map_err(|e| e.to_string())?;
            } else {
                let encrypted = key_encrypted(&key);
                if encrypted && secret.is_none() {
                    return Err(format!("AUTH_PASSPHRASE_REQUIRED\t{}", p.secret_key));
                }
                if let Err(e) = sess.userauth_pubkey_file(
                    p.user,
                    None,
                    Path::new(&key),
                    secret.as_deref(),
                ) {
                    last_err = e.to_string();
                }
                if !sess.authenticated() && !encrypted {
                    if let Err(e) = sess.userauth_agent(p.user) {
                        if last_err.is_empty() {
                            last_err = e.to_string();
                        }
                    }
                }
                if !sess.authenticated() && encrypted {
                    return Err(format!("AUTH_PASSPHRASE_WRONG\t{}", p.secret_key));
                }
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
    let jlabel = format!("{}:{}", jump.host, jump.port);
    let jsess = session_over(
        jtcp,
        AuthParams {
            user: &jump.user,
            auth: &jump.auth,
            key_path: &jump.key_path,
            secret_key: &format!("jump:{jlabel}"),
            label: &jlabel,
        },
    )
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
    session_over(
        tcp,
        AuthParams {
            user: &cfg.user,
            auth: &cfg.auth,
            key_path: &cfg.key_path,
            secret_key: &cfg.id,
            label: &format!("{}:{}", cfg.host, cfg.port),
        },
    )
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

/// Run a command over a PTY, feeding the cached sudo password when a
/// `[sudo] password` prompt appears. Used by the snippet runner so that
/// `sudo` commands don't hang. `sudo_pw` is looked up under "sudo:<id>".
pub fn exec_pty(sess: &Session, cmd: &str, sudo_key: &str) -> Result<ExecOut, String> {
    let start = Instant::now();
    let mut ch = sess.channel_session().map_err(|e| e.to_string())?;
    ch.request_pty("dumb", None, Some((200, 50, 0, 0)))
        .map_err(|e| e.to_string())?;
    ch.exec(cmd).map_err(|e| e.to_string())?;

    let sudo_pw = get_secret(&format!("sudo:{sudo_key}"));
    let mut sent = false;
    let mut out = String::new();
    let mut buf = [0u8; 8192];
    loop {
        match ch.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let chunk = String::from_utf8_lossy(&buf[..n]);
                out.push_str(&chunk);
                if !sent {
                    let low = out.to_lowercase();
                    if low.contains("[sudo]") || low.contains("password for") || low.contains("password:") {
                        if let Some(pw) = &sudo_pw {
                            use std::io::Write;
                            ch.write_all(pw.as_bytes()).ok();
                            ch.write_all(b"\n").ok();
                            sent = true;
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(8));
            }
            Err(_) => break,
        }
    }
    ch.wait_close().ok();
    let code = ch.exit_status().unwrap_or(-1);
    let out = out.replace('\r', "");
    Ok(ExecOut {
        code,
        ms: start.elapsed().as_millis() as u64,
        out,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedHost {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub key_path: String,
    pub proxy_jump: String,
}

/// Minimal ~/.ssh/config parser: explicit Host blocks with a HostName.
/// Wildcard-only patterns are skipped. ProxyJump is returned as a raw string.
pub fn parse_ssh_config() -> Vec<ParsedHost> {
    let path = expand_tilde("~/.ssh/config");
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut hosts: Vec<ParsedHost> = Vec::new();
    let mut cur: Option<ParsedHost> = None;
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (kw, val) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_start_matches('=').trim()),
            None => continue,
        };
        if kw == "host" {
            if let Some(h) = cur.take() {
                if !h.host.is_empty() {
                    hosts.push(h);
                }
            }
            let alias = val.split_whitespace().next().unwrap_or("").to_string();
            if alias.contains('*') || alias.contains('?') || alias.is_empty() {
                cur = None;
            } else {
                cur = Some(ParsedHost {
                    name: alias,
                    host: String::new(),
                    port: 22,
                    user: String::new(),
                    key_path: String::new(),
                    proxy_jump: String::new(),
                });
            }
            continue;
        }
        let Some(h) = cur.as_mut() else { continue };
        match kw.as_str() {
            "hostname" => h.host = val.to_string(),
            "port" => h.port = val.parse().unwrap_or(22),
            "user" => h.user = val.to_string(),
            "identityfile" => h.key_path = val.to_string(),
            "proxyjump" => h.proxy_jump = val.to_string(),
            _ => {}
        }
    }
    if let Some(h) = cur.take() {
        if !h.host.is_empty() {
            hosts.push(h);
        }
    }
    hosts
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
