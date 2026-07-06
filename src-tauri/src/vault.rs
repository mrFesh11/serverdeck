use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;
use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub static VAULT_PATH: OnceLock<PathBuf> = OnceLock::new();
static UNLOCKED: OnceLock<Mutex<Option<VaultState>>> = OnceLock::new();

fn state() -> &'static Mutex<Option<VaultState>> {
    UNLOCKED.get_or_init(|| Mutex::new(None))
}

struct VaultState {
    key: [u8; 32],
    secrets: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct VaultFile {
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn derive(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| e.to_string())?;
    Ok(key)
}

fn write_encrypted(path: &PathBuf, key: &[u8; 32], salt: &[u8], secrets: &HashMap<String, String>) -> Result<(), String> {
    let plain = serde_json::to_vec(secrets).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_ref())
        .map_err(|e| e.to_string())?;
    let file = VaultFile {
        salt: b64().encode(salt),
        nonce: b64().encode(nonce_bytes),
        ciphertext: b64().encode(ct),
    };
    std::fs::write(path, serde_json::to_vec_pretty(&file).unwrap()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).ok();
    }
    Ok(())
}

pub fn exists() -> bool {
    VAULT_PATH.get().map(|p| p.exists()).unwrap_or(false)
}

pub fn is_unlocked() -> bool {
    state().lock().unwrap().is_some()
}

pub fn create(password: &str) -> Result<(), String> {
    let path = VAULT_PATH.get().ok_or("vault path not set")?;
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let key = derive(password, &salt)?;
    let secrets = HashMap::new();
    write_encrypted(path, &key, &salt, &secrets)?;
    *state().lock().unwrap() = Some(VaultState { key, secrets });
    Ok(())
}

/// Unlock existing vault, returning the decrypted secrets (to load into the
/// in-memory secret store).
pub fn unlock(password: &str) -> Result<HashMap<String, String>, String> {
    let path = VAULT_PATH.get().ok_or("vault path not set")?;
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let file: VaultFile = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let salt = b64().decode(&file.salt).map_err(|e| e.to_string())?;
    let nonce = b64().decode(&file.nonce).map_err(|e| e.to_string())?;
    let ct = b64().decode(&file.ciphertext).map_err(|e| e.to_string())?;
    let key = derive(password, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "WRONG_PASSWORD".to_string())?;
    let secrets: HashMap<String, String> = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    *state().lock().unwrap() = Some(VaultState { key, secrets: secrets.clone() });
    Ok(secrets)
}

fn persist() -> Result<(), String> {
    let path = VAULT_PATH.get().ok_or("vault path not set")?;
    let guard = state().lock().unwrap();
    let st = guard.as_ref().ok_or("vault locked")?;
    let raw = std::fs::read(path).map_err(|e| e.to_string())?;
    let file: VaultFile = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    let salt = b64().decode(&file.salt).map_err(|e| e.to_string())?;
    write_encrypted(path, &st.key, &salt, &st.secrets)
}

pub fn store(id: &str, value: &str) -> Result<(), String> {
    {
        let mut guard = state().lock().unwrap();
        let st = guard.as_mut().ok_or("vault locked")?;
        st.secrets.insert(id.to_string(), value.to_string());
    }
    persist()
}

pub fn forget(id: &str) -> Result<(), String> {
    {
        let mut guard = state().lock().unwrap();
        let st = guard.as_mut().ok_or("vault locked")?;
        st.secrets.remove(id);
    }
    persist()
}

pub fn lock() {
    *state().lock().unwrap() = None;
}
