//! Tauri 命令层：参数校验、会话编排、错误码。
//! 前端只通过这里访问数据，WebView 拿不到密钥，也拿不到整库。

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

use passlet_core::config::{self, Config};
use passlet_core::crypto;
use passlet_core::error::{AppError, AppResult};
use passlet_core::master;
use passlet_core::paths;
use passlet_core::storage;
use passlet_core::store;
use passlet_core::vault::{EntryMeta, MergeMode, Vault};

use crate::session::{AppState, Session};

const LOCKED: &str = "会话已锁定，请重新进入清单。";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub master_loaded: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub skipped: usize,
    pub replaced: usize,
    pub mode: String,
    pub backup_path: Option<String>,
}

fn with_session<T>(state: &AppState, f: impl FnOnce(&Session) -> AppResult<T>) -> AppResult<T> {
    let guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_ref().ok_or_else(|| AppError::new("locked", LOCKED))?;
    f(session)
}

fn unlock() -> AppResult<Session> {
    unlock_from(&paths::data_dir()?)
}

fn unlock_from(dir: &Path) -> AppResult<Session> {
    let (key, salt, vault) = store::open_in(dir, &master::read()?)?;
    Ok(Session { key, salt, vault })
}

fn persist(session: &Session) -> AppResult<()> {
    persist_to(session, &storage::data_dir()?)
}

fn persist_to(session: &Session, dir: &Path) -> AppResult<()> {
    store::persist_in(dir, &session.key, &session.salt, &session.vault)
}

#[tauri::command]
pub async fn bootstrap(state: tauri::State<'_, AppState>) -> AppResult<AppStatus> {
    match unlock() {
        Ok(session) => {
            if let Ok(mut guard) = state.session.lock() {
                *guard = Some(session);
            }
            Ok(AppStatus {
                master_loaded: true,
                reason: None,
            })
        }
        Err(err) => {
            if let Ok(mut guard) = state.session.lock() {
                *guard = None;
            }
            Ok(AppStatus {
                master_loaded: false,
                reason: Some(err.code),
            })
        }
    }
}

#[tauri::command]
pub fn lock(state: tauri::State<'_, AppState>) {
    if let Ok(mut guard) = state.session.lock() {
        *guard = None;
    }
}

#[tauri::command]
pub fn list_entries(state: tauri::State<'_, AppState>) -> AppResult<Vec<EntryMeta>> {
    with_session(state.inner(), |session| Ok(session.vault.metas()))
}

#[tauri::command]
pub fn get_secret(state: tauri::State<'_, AppState>, id: String) -> AppResult<String> {
    with_session(state.inner(), |session| {
        session
            .vault
            .find(&id)
            .map(|entry| entry.password.clone())
            .ok_or_else(|| AppError::new("not_found", "这条记录已经不在了，可能被删掉了。"))
    })
}

/// 复制走 Rust 侧：密码不进 WebView，定时清空也在这里做。
#[tauri::command]
pub fn copy_secret(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let password = with_session(state.inner(), |session| {
        session
            .vault
            .find(&id)
            .map(|entry| entry.password.clone())
            .ok_or_else(|| AppError::new("not_found", "这条记录已经不在了，可能被删掉了。"))
    })?;

    app.clipboard()
        .write_text(password.clone())
        .map_err(|err| AppError::new("clipboard", format!("复制失败：系统剪贴板不可用。（{err}）")))?;

    let config = config::load();
    let seq = {
        let mut guard = state
            .clipboard_seq
            .lock()
            .map_err(|_| AppError::new("internal", "剪贴板状态异常。"))?;
        *guard += 1;
        *guard
    };

    if config.clipboard_clear_enabled {
        let seconds = config.clipboard_clear_seconds;
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(seconds as u64)).await;
            let state = handle.state::<AppState>();
            let current = state.clipboard_seq.lock().map(|g| *g).unwrap_or(u64::MAX);
            if current != seq {
                return; // 期间又复制过，这次任务作废
            }
            if let Ok(text) = handle.clipboard().read_text() {
                if text == password {
                    let _ = handle.clipboard().write_text(String::new());
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
pub fn add_entry(
    state: tauri::State<'_, AppState>,
    platform: String,
    username: String,
    password: String,
) -> AppResult<EntryMeta> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let entry = session.vault.add(&platform, &username, &password)?;
    let meta = EntryMeta {
        id: entry.id.clone(),
        platform: entry.platform,
        username: entry.username,
    };

    // 写盘失败时只撤掉这一次新增，不复制整库
    if let Err(err) = persist(session) {
        let _ = session.vault.remove(&entry.id);
        return Err(err);
    }
    Ok(meta)
}

#[tauri::command]
pub fn update_entry(
    state: tauri::State<'_, AppState>,
    id: String,
    platform: String,
    username: String,
    password: String,
) -> AppResult<EntryMeta> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    // 只留这一条的旧值用于回滚，不复制整库（旧实现会把全部密码一起克隆）
    let previous = session
        .vault
        .find(&id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "这条记录已经不在了，可能被删掉了。"))?;

    let entry = session.vault.update(&id, &platform, &username, &password)?;
    let meta = EntryMeta {
        id: entry.id.clone(),
        platform: entry.platform,
        username: entry.username,
    };

    if let Err(err) = persist(session) {
        let _ = session.vault.update(
            &previous.id,
            &previous.platform,
            &previous.username,
            &previous.password,
        );
        return Err(err);
    }
    Ok(meta)
}

#[tauri::command]
pub fn delete_entry(state: tauri::State<'_, AppState>, id: String) -> AppResult<()> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let removed = session
        .vault
        .find(&id)
        .cloned()
        .ok_or_else(|| AppError::new("not_found", "这条记录已经不在了，可能被删掉了。"))?;
    let index = session
        .vault
        .entries
        .iter()
        .position(|entry| entry.id == id)
        .unwrap_or(0);

    session.vault.remove(&id)?;
    if let Err(err) = persist(session) {
        let at = index.min(session.vault.entries.len());
        session.vault.entries.insert(at, removed);
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
pub fn get_config() -> Config {
    config::load()
}

#[tauri::command]
pub fn save_config(config: Config) -> AppResult<Config> {
    // 形参与模块同名，必须写全路径，否则会被解析成对形参的调用
    config::save(&config)
}

#[tauri::command]
pub fn vault_path_display() -> AppResult<String> {
    Ok(storage::vault_path()?.display().to_string())
}

#[tauri::command]
pub fn set_view(window: tauri::WebviewWindow, view: String) {
    let config = config::load();
    let size = match view.as_str() {
        "list" => config.window_sizes.list,
        "settings" => config.window_sizes.settings,
        _ => config.window_sizes.query,
    };
    let _ = window.set_size(tauri::LogicalSize::new(size[0] as f64, size[1] as f64));
    let _ = window.center();
}

/// 复制任意文本（路径、命令）。与 copy_secret 共用剪贴板通道，
/// 避免前端走 navigator.clipboard 而声明的权限里并没有它。
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> AppResult<()> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| AppError::new("clipboard", format!("复制失败：系统剪贴板不可用。（{err}）")))
}

/// 让原生标题栏跟随主题。页面主题由前端切 data-theme，窗口边框必须走系统 API，
/// 否则会出现"内容浅色、标题栏深色"的割裂。
#[tauri::command]
pub fn apply_theme(window: tauri::WebviewWindow, mode: String) {
    let theme = match mode.as_str() {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None, // 跟随系统
    };
    let _ = window.set_theme(theme);
}

/// 从内存重新加密导出：保证备份就是当前状态，而不是磁盘上可能过期的一份。
#[tauri::command]
pub async fn export_vault(app: AppHandle) -> Result<Option<String>, AppError> {
    let bytes = {
        let state = app.state::<AppState>();
        with_session(state.inner(), |session| {
            store::seal(&session.key, &session.salt, &session.vault)
        })?
    };

    let file_name = format!(
        "passlet-backup-{}.pvault",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(file_name)
        .add_filter("Passlet 备份", &["pvault"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .await
        .map_err(|_| AppError::new("io", "保存对话框被关闭。"))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|err| AppError::new("io", format!("无效的保存路径：{err}")))?;
    std::fs::write(&path, bytes)
        .map_err(|err| AppError::new("io", format!("写入失败：{err}")))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub async fn pick_import_file(app: AppHandle) -> Result<Option<String>, AppError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Passlet 备份", &["pvault"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let picked = rx
        .await
        .map_err(|_| AppError::new("io", "打开对话框被关闭。"))?;
    let Some(file) = picked else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|err| AppError::new("io", format!("无效的文件路径：{err}")))?;
    Ok(Some(path.display().to_string()))
}

fn mode_name(mode: MergeMode) -> &'static str {
    match mode {
        MergeMode::Replace => "replace",
        MergeMode::Skip => "skip",
        MergeMode::Overwrite => "overwrite",
    }
}

#[tauri::command]
pub async fn import_from(
    state: tauri::State<'_, AppState>,
    path: String,
    mode: MergeMode,
) -> AppResult<ImportReport> {
    let bytes = std::fs::read(&path)
        .map_err(|err| AppError::new("io", format!("读不到这个文件：{err}")))?;
    // 换过主密码后环境变量里还是旧值，这时"用旧主密码"会误报解密失败。
    // 先试会话里的密钥（同盐 = 本机导出，含刚换过密码的情形），失败再退回环境变量。
    let container = crypto::decode(&bytes)?;
    let incoming = match state.session.lock() {
        Ok(guard) if guard.as_ref().map(|session| session.salt == container.salt).unwrap_or(false) => {
            let session = guard.as_ref().expect("刚判断过非空");
            let plaintext = crypto::decrypt(&session.key, &container.nonce, container.ciphertext)?;
            let vault: Vault = serde_json::from_slice(&plaintext)?;
            vault.validate()?;
            vault
        }
        _ => store::unseal(&bytes, &master::read()?)?,
    };
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let backup_path = if mode == MergeMode::Replace {
        let tag = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = paths::data_dir()?;
        storage::backup_with_timestamp_in(&dir, storage::VAULT_NAME, &tag)?
            .map(|path| path.display().to_string())
    } else {
        None
    };

    let snapshot = session.vault.entries.clone();
    let stats = session.vault.merge_from(&incoming, mode);
    if let Err(err) = persist(session) {
        session.vault.entries = snapshot;
        return Err(err);
    }

    Ok(ImportReport {
        added: stats.added,
        skipped: stats.skipped,
        replaced: stats.replaced,
        mode: mode_name(mode).to_string(),
        backup_path,
    })
}

/// 换主密码：先写盘成功，再换内存里的密钥——写失败时旧库还完好。
#[tauri::command]
pub async fn change_master(state: tauri::State<'_, AppState>, new_password: String) -> AppResult<()> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let (new_key, new_salt, bytes) = store::rotate(&new_password, &session.vault)?;
    storage::write_vault(&bytes)?;

    session.salt = new_salt;
    session.key = new_key;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! 集成级用例：走"派生密钥 → 加密写盘 → 用主密码重新打开"这条主链路，
    //! 只把数据目录换成临时目录，其余与真实运行完全一致。

    use super::*;
    use std::fs;

    const MASTER: &str = "correct horse battery staple";

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!(
                "passlet-cmd-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session_with(entries: &[(&str, &str, &str)]) -> Session {
        let salt = crypto::new_salt();
        let key = crypto::derive_key(MASTER, &salt).unwrap();
        let mut vault = Vault::new();
        for (platform, username, password) in entries {
            vault.add(platform, username, password).unwrap();
        }
        Session { key, salt, vault }
    }

    fn use_master(value: &str) {
        std::env::set_var(master::ENV_NAME, value);
    }

    #[test]
    fn 写盘后能用同一主密码重新打开并读到相同条目() {
        use_master(MASTER);
        let dir = temp_dir("roundtrip");

        let session = session_with(&[("GitHub", "me", "p1"), ("阿里云", "autod", "p2")]);
        persist_to(&session, &dir).unwrap();

        let reopened = unlock_from(&dir).unwrap();
        assert_eq!(reopened.vault.entries.len(), 2);
        // 新条目排最前
        assert_eq!(reopened.vault.entries[0].platform, "阿里云");
        assert_eq!(reopened.vault.entries[0].password, "p2");
        assert_eq!(reopened.vault.entries[1].platform, "GitHub");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 目录里没有数据文件时解锁出空库() {
        use_master(MASTER);
        let dir = temp_dir("empty");
        let session = unlock_from(&dir).unwrap();
        assert!(session.vault.entries.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 主密码不对时打不开且错误码是_decrypt_failed() {
        use_master(MASTER);
        let dir = temp_dir("wrong-master");
        persist_to(&session_with(&[("GitHub", "me", "p")]), &dir).unwrap();

        use_master("another password");
        let err = unlock_from(&dir).unwrap_err();
        assert_eq!(err.code, "decrypt_failed");

        use_master(MASTER);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 数据文件里不含明文平台名或密码() {
        use_master(MASTER);
        let dir = temp_dir("plaintext");
        persist_to(&session_with(&[("VeryUniquePlatform", "u", "SuperSecretValue")]), &dir).unwrap();

        let raw = fs::read(dir.join(storage::VAULT_NAME)).unwrap();
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("VeryUniquePlatform"));
        assert!(!text.contains("SuperSecretValue"));
        assert!(raw.starts_with(crypto::MAGIC));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 换主密码后用新密码能开用旧密码打不开() {
        use_master(MASTER);
        let dir = temp_dir("rotate");
        let session = session_with(&[("GitHub", "me", "p")]);
        persist_to(&session, &dir).unwrap();

        // 与 change_master 命令同样的动作：新盐、新密钥、重新加密写盘
        let new_master = "a brand new master password";
        let new_salt = crypto::new_salt();
        let new_key = crypto::derive_key(new_master, &new_salt).unwrap();
        let json = serde_json::to_vec(&session.vault).unwrap();
        let (nonce, ciphertext) = crypto::encrypt(&new_key, &json).unwrap();
        storage::write_atomic_in(
            &dir,
            storage::VAULT_NAME,
            &crypto::encode(&new_salt, &nonce, &ciphertext),
        )
        .unwrap();

        use_master(new_master);
        assert_eq!(unlock_from(&dir).unwrap().vault.entries.len(), 1);

        use_master(MASTER);
        assert_eq!(unlock_from(&dir).unwrap_err().code, "decrypt_failed");

        use_master(MASTER);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 导入备份按跳过重复合并后重新打开仍是合并结果() {
        use_master(MASTER);
        let dir = temp_dir("import-skip");

        // 主库：GitHub/me
        let session = session_with(&[("GitHub", "me", "old")]);
        persist_to(&session, &dir).unwrap();

        // 备份文件：同一条 + 一条新的
        let backup_session = session_with(&[("GitHub", "me", "new"), ("Gitee", "me", "x")]);
        let backup_dir = temp_dir("import-skip-backup");
        persist_to(&backup_session, &backup_dir).unwrap();

        let backup_bytes = fs::read(backup_dir.join(storage::VAULT_NAME)).unwrap();
        let container = crypto::decode(&backup_bytes).unwrap();
        let backup_key = crypto::derive_key(MASTER, &container.salt).unwrap();
        let plaintext = crypto::decrypt(&backup_key, &container.nonce, container.ciphertext).unwrap();
        let incoming: Vault = serde_json::from_slice(&plaintext).unwrap();

        let mut current = unlock_from(&dir).unwrap();
        let stats = current.vault.merge_from(&incoming, MergeMode::Skip);
        assert_eq!(stats.added, 1);
        assert_eq!(stats.skipped, 1);
        persist_to(&current, &dir).unwrap();

        let reopened = unlock_from(&dir).unwrap();
        assert_eq!(reopened.vault.entries.len(), 2);
        assert!(reopened
            .vault
            .entries
            .iter()
            .any(|e| e.platform == "GitHub" && e.password == "old"));
        assert!(reopened.vault.entries.iter().any(|e| e.platform == "Gitee"));

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&backup_dir).ok();
    }
}
