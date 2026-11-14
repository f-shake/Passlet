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
use passlet_core::generators::{self, GeneratorScan};
use passlet_core::location;
use passlet_core::master;
use passlet_core::paths;
use passlet_core::storage;
use passlet_core::store;
use passlet_core::vault::{EntryMeta, MergeMode};

use crate::session::{AppState, Session};

const LOCKED: &str = "会话已锁定，请重新进入清单。";

/// 按内容自适应时允许的高度范围：太低连一行输入框都放不下，太高就失去"小窗口"的意义。
const MIN_CONTENT_HEIGHT: u32 = 200;
const MAX_CONTENT_HEIGHT: u32 = 700;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub master_loaded: bool,
    pub reason: Option<String>,
    /// 失败的完整提示。`vault_missing` 要带上具体路径，前端不该再拼一遍同样的句子
    pub message: Option<String>,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterInfo {
    /// "process" / "user" / "machine" / "none"，与 `master::read()` 的查找顺序一致
    pub active: &'static str,
    pub process_env: bool,
    pub user_registry: bool,
    pub machine_registry: bool,
    /// 库文件是否存在：没有库就没法校验密码，界面因此要求输两次
    pub vault_exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeMasterReport {
    /// 环境变量是否同步成功。库密码这时已经换了，这一步失败必须让用户看见
    pub synced: bool,
    pub message: Option<String>,
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
    unlock_at(&location::vault_dir()?)
}

/// 在指定目录解锁。
///
/// 非默认目录里没有库文件时报 `vault_missing`，绝不退化成“首次运行的空库”：
/// 那个空库一旦被写回同一个目录，用户就真的看不到自己的数据了。
fn unlock_at(dir: &Path) -> AppResult<Session> {
    if !location::has_vault(dir) && !location::is_default(dir) {
        return Err(AppError::new("vault_missing", vault_missing_message(dir)));
    }
    unlock_from(dir)
}

fn vault_missing_message(dir: &Path) -> String {
    format!(
        "找不到密码库：{}。这个位置可能还没同步下来，或者目录被改名了。",
        dir.join(storage::VAULT_NAME).display()
    )
}

fn unlock_from(dir: &Path) -> AppResult<Session> {
    let (key, salt, vault) = store::open_in(dir, &master::read()?)?;
    Ok(Session { key, salt, vault })
}

fn persist(session: &Session) -> AppResult<()> {
    persist_to(session, &location::ensure_vault_dir()?)
}

fn persist_to(session: &Session, dir: &Path) -> AppResult<()> {
    store::persist_in(dir, &session.key, &session.salt, &session.vault)
}

fn master_info() -> MasterInfo {
    let status = master::status();
    MasterInfo {
        active: status.active,
        process_env: status.process_env,
        user_registry: status.user_registry,
        machine_registry: status.machine_registry,
        vault_exists: location::vault_file()
            .map(|path| path.exists())
            .unwrap_or(false),
    }
}

/// 候选主密码能不能解开现有的库。
///
/// 库文件不存在时不能一律放行：首次从说明页设置完之后，内存里已经有会话了，
/// 这时再改成一个别的值，就会出现“环境变量是 B、内存还是 A、重启再也打不开”的死路。
/// 有会话就拿它比：会话的盐与密钥就是当前主密码的凭据。
fn verify_master(state: &AppState, dir: &Path, candidate: &str) -> AppResult<()> {
    if dir.join(storage::VAULT_NAME).exists() {
        return match store::open_in(dir, candidate) {
            Ok(_) => Ok(()),
            // 只有“解密失败”才是密码不对；corrupt / version 是文件本身的问题，原样往上抛
            Err(err) if err.code == "decrypt_failed" => Err(AppError::new(
                "wrong_master",
                "这个密码打不开现有的密码库，请确认后再试。",
            )),
            Err(err) => Err(err),
        };
    }

    let guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    if let Some(session) = guard.as_ref() {
        let key = crypto::derive_key(candidate, &session.salt)?;
        if *key != *session.key {
            return Err(AppError::new(
                "wrong_master",
                "这个密码跟当前正在用的主密码不一致。要改主密码请用“更换主密码”，那会连库一起换。",
            ));
        }
    }
    Ok(())
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
                message: None,
            })
        }
        Err(err) => {
            if let Ok(mut guard) = state.session.lock() {
                *guard = None;
            }
            Ok(AppStatus {
                master_loaded: false,
                reason: Some(err.code),
                message: Some(err.message),
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
    copy_with_autoclear(&app, state.inner(), password)
}

/// 写剪贴板，并按配置安排自动清空。
/// 条目密码与生成的密码共用这一条路径，免得"自动清空"在两处各写一遍、行为慢慢跑偏。
fn copy_with_autoclear(app: &AppHandle, state: &AppState, text: String) -> AppResult<()> {
    app.clipboard()
        .write_text(text.clone())
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
            if let Ok(now) = handle.clipboard().read_text() {
                if now == text {
                    let _ = handle.clipboard().write_text(String::new());
                }
            }
        });
    }
    Ok(())
}

/// 复制生成器算出的密码。它不来自库，所以单独一个口子，而不是硬塞进 copy_secret。
#[tauri::command]
pub fn copy_generated(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    text: String,
) -> AppResult<()> {
    if text.is_empty() {
        return Err(AppError::new("invalid", "没有可复制的密码。"));
    }
    copy_with_autoclear(&app, state.inner(), text)
}

/// 列出插件目录里的生成器源码。只读磁盘、不执行脚本。
#[tauri::command]
pub fn list_generators() -> GeneratorScan {
    generators::scan()
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultLocation {
    /// 库目录（不含文件名）
    pub dir: String,
    /// 库文件完整路径——设置页显示的是这一行
    pub file: String,
    /// 是不是默认位置（决定「恢复默认位置」按钮是否出现）
    pub is_default: bool,
    pub default_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSwitchReport {
    /// "needs_confirm" | "moved" | "connected" | "created" | "cleared" | "unchanged"
    pub kind: String,
    pub dir: String,
    pub file: String,
    pub entries: usize,
    /// 被改名留档的源文件（只有迁移成功且源文件确实存在时才有）
    pub retired: Option<String>,
    /// 迁移成功但源文件没改名时的补充提示
    pub warning: Option<String>,
}

fn location_info() -> AppResult<VaultLocation> {
    let dir = location::vault_dir()?;
    let default = location::default_vault_dir()?;
    Ok(VaultLocation {
        file: dir.join(storage::VAULT_NAME).display().to_string(),
        // 用物理比较：指针是默认目录的 junction / 别名时也算“就在默认位置”，
        // 否则会显示一个点了只回执 unchanged 的按钮
        is_default: same_physical(&dir, &default),
        default_dir: default.display().to_string(),
        dir: dir.display().to_string(),
    })
}

fn switch_report(kind: &str, dir: &Path, entries: usize) -> VaultSwitchReport {
    VaultSwitchReport {
        kind: kind.to_string(),
        dir: dir.display().to_string(),
        file: dir.join(storage::VAULT_NAME).display().to_string(),
        entries,
        retired: None,
        warning: None,
    }
}

fn session_entries(state: &AppState) -> usize {
    with_session(state, |session| Ok(session.vault.entries.len())).unwrap_or(0)
}

#[tauri::command]
pub fn vault_location() -> AppResult<VaultLocation> {
    location_info()
}

/// 弹出系统文件夹选择框，初始位置是当前库目录。用户取消返回 null。
#[tauri::command]
pub async fn pick_vault_dir(app: AppHandle) -> AppResult<Option<String>> {
    let current = location::vault_dir()?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择数据位置")
        .set_directory(&current)
        .pick_folder(move |picked| {
            let _ = tx.send(picked);
        });

    let picked = rx
        .await
        .map_err(|_| AppError::new("io", "目录选择框被关闭。"))?;
    let Some(folder) = picked else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|err| AppError::new("io", format!("无效的目录路径：{err}")))?;
    Ok(Some(path.display().to_string()))
}

/// 换库位置。
///
/// - 目标目录里已经有库 → **连接**（它的主密码必须能解开，否则拒绝）；
/// - 目标目录里没有库 → **迁移**（把当前库搬过去）。迁移会动用户唯一的那份数据，
///   所以没带 `confirm` 时只回执 `needs_confirm`，让界面先问一次。
/// - `mode = "move"`：即使目标已有库也强制迁移（「恢复默认位置」用它，
///   语义是“数据跟着指针走”，而不是“打开那个位置里原有的东西”）。
#[tauri::command]
pub fn switch_vault_dir(
    state: tauri::State<'_, AppState>,
    dir: String,
    mode: Option<String>,
    confirm: Option<bool>,
) -> AppResult<VaultSwitchReport> {
    let target = absolute_dir(&dir)?;
    switch_inner(
        state.inner(),
        &location::config_home()?,
        &target,
        mode.as_deref() == Some("move"),
        confirm.unwrap_or(false),
    )
}

/// 在当前指针位置新建一个空库。只给 `vault_missing` 的错误页用：
/// 这是唯一允许在“非首次运行”状态下创建库文件的入口，因此要求用户显式点按钮。
#[tauri::command]
pub fn create_vault_here(state: tauri::State<'_, AppState>) -> AppResult<VaultSwitchReport> {
    create_vault_in(state.inner(), &location::config_home()?)
}

fn create_vault_in(state: &AppState, home: &Path) -> AppResult<VaultSwitchReport> {
    let dir = location::vault_dir_in(&config::load_in(home))?;
    if location::has_vault(&dir) {
        return Err(AppError::new(
            "invalid",
            "这个位置已经有密码库了，不需要新建。",
        ));
    }

    let master = master::read()?;
    let (key, salt, vault) = store::open_in(&dir, &master)?;
    store::persist_in(&dir, &key, &salt, &vault)?;

    let entries = vault.entries.len();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    *guard = Some(Session { key, salt, vault });

    Ok(switch_report("created", &dir, entries))
}

fn absolute_dir(raw: &str) -> AppResult<std::path::PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::new("invalid", "没有选到目录。"));
    }
    let path = std::path::PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err(AppError::new(
            "invalid",
            format!("这个路径用不了：{trimmed} 不是绝对路径。"),
        ));
    }
    if path.exists() && !path.is_dir() {
        return Err(AppError::new(
            "invalid",
            format!("这个路径用不了：{trimmed} 不是一个目录。"),
        ));
    }
    Ok(path)
}

/// 两个路径是不是同一个**物理**目录。
///
/// 先比字符串，再比 `canonicalize` 之后的结果：junction / symlink、`subst` 映射盘、
/// 盘符与 UNC 两种写法都会让字符串不同而物理相同。漏掉这一层，迁移就会把唯一的库
/// 改名成 `.moved-*`，目录里一个 `vault.dat` 都不剩。
fn same_physical(left: &Path, right: &Path) -> bool {
    if paths::same_dir(left, right) {
        return true;
    }
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => paths::same_dir(&a, &b),
        _ => false,
    }
}

/// 写之前先确认这个位置能写。真的写进去再报错，用户拿到的是一句 io 错误，
/// 分不清是“目录不可写”还是“文件被占用”。
fn ensure_writable(dir: &Path) -> AppResult<()> {
    location::ensure_dir(dir)?;
    let probe = dir.join(".passlet-write-test");
    let result = std::fs::write(&probe, b"passlet");
    let _ = std::fs::remove_file(&probe);
    result.map_err(|err| {
        AppError::new(
            "not_writable",
            format!("这个位置不可写，换一个目录试试。（{err}）"),
        )
    })
}

fn session_present(state: &AppState) -> bool {
    with_session(state, |_| Ok(())).is_ok()
}

fn switch_inner(
    state: &AppState,
    home: &Path,
    target: &Path,
    force_move: bool,
    confirmed: bool,
) -> AppResult<VaultSwitchReport> {
    let current = location::vault_dir_in(&config::load_in(home))?;
    if same_physical(&current, target) {
        return Ok(switch_report("unchanged", target, session_entries(state)));
    }

    let target_file = target.join(storage::VAULT_NAME);
    let target_has_vault = target_file.exists();
    if target_has_vault && !force_move {
        return connect_at(state, home, target);
    }

    // 当前位置没有库可搬（错误页“改回默认位置”正是这种状态：指针指向的目录里没有库）：
    // 这一步只能是“把指针指过去”，不能在缺库的位置上假装迁移——那只会报一句
    // “当前位置还没有密码库文件”，把用户困在错误页里。
    if !location::has_vault(&current) && !session_present(state) {
        if target_has_vault {
            return connect_at(state, home, target);
        }
        location::set_vault_dir_in(home, Some(target))?;
        return Ok(switch_report("cleared", target, 0));
    }

    if !confirmed {
        // 只是回执一次“要迁移了”，不碰任何文件
        return Ok(switch_report(
            "needs_confirm",
            target,
            session_entries(state),
        ));
    }

    migrate_to(state, home, &current, target)
}

fn connect_at(state: &AppState, home: &Path, target: &Path) -> AppResult<VaultSwitchReport> {
    let master = master::read()?;
    let (key, salt, vault) = store::open_in(target, &master).map_err(|err| match err.code.as_str() {
        "decrypt_failed" => AppError::new(
            "wrong_master",
            "这个位置里的密码库打不开：它的主密码和当前的不一致。先在那边导出备份、再导入这边，或者把主密码换成它那个。",
        ),
        "corrupt" => AppError::new(
            "corrupt",
            "这个位置里的 vault.dat 不是 Passlet 的密码库文件，换一个位置。",
        ),
        _ => err,
    })?;

    // 先写指针再换会话：写盘失败时内存里的会话还在原库上，界面刷新后一切照旧
    location::set_vault_dir_in(home, Some(target))?;

    let entries = vault.entries.len();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    *guard = Some(Session { key, salt, vault });

    Ok(switch_report("connected", target, entries))
}

/// 当前库的密文字节。**优先复制磁盘上那一份**：每次修改都立即落盘，
/// 所以磁盘就是最新状态，原样复制还能保证两边逐字节相同，不必重新加密一次。
/// 只有在“有会话、但文件被别人删了”的边角情况才退回用会话内容封包。
fn current_bytes(state: &AppState, dir: &Path) -> AppResult<Option<Vec<u8>>> {
    if let Some(bytes) = storage::read_in(dir, storage::VAULT_NAME)? {
        return Ok(Some(bytes));
    }
    let guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    match guard.as_ref() {
        Some(session) => Ok(Some(store::seal(&session.key, &session.salt, &session.vault)?)),
        None => Ok(None),
    }
}

fn migrate_to(
    state: &AppState,
    home: &Path,
    source: &Path,
    target: &Path,
) -> AppResult<VaultSwitchReport> {
    let Some(bytes) = current_bytes(state, source)? else {
        return Err(AppError::new(
            "invalid",
            "当前位置还没有密码库文件，可以在这个位置直接新建一个。",
        ));
    };

    ensure_writable(target)?;
    let tag = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();

    // 目标位置可能已有库（「恢复默认位置」就是强制迁移）：先把那份**改名留档**，
    // 而不是让原子写把它顶成 vault.dat.bak——那会顺带删掉目标目录原有的 .bak，
    // 而且回滚时再也拿不回来。
    let target_backup = if location::has_vault(target) {
        storage::retire_in(target, storage::VAULT_NAME, &tag)?
    } else {
        None
    };

    // 回滚一律走这里：把刚才写的删掉，再把目标原有的库改回原名。
    let rollback = |target: &Path, backup: &Option<std::path::PathBuf>| {
        let _ = std::fs::remove_file(target.join(storage::VAULT_NAME));
        if let Some(path) = backup {
            let _ = std::fs::rename(path, target.join(storage::VAULT_NAME));
        }
    };

    // 顺序是“先写新位置 → 校验 → 再写指针 → 最后改名源文件”：
    // 任何一步失败，用户真正的库都还完整地待在原处。
    if let Err(err) = storage::write_atomic_in(target, storage::VAULT_NAME, &bytes) {
        rollback(target, &target_backup);
        return Err(AppError::new(
            "io",
            format!(
                "复制到 {} 失败：{}。数据仍在原位置。",
                target.display(),
                err.message
            ),
        ));
    }

    let written = storage::read_in(target, storage::VAULT_NAME)?.unwrap_or_default();
    if written != bytes {
        rollback(target, &target_backup);
        return Err(AppError::new(
            "io",
            format!(
                "写入 {} 后校验没通过，已撤销，数据仍在原位置。",
                target.display()
            ),
        ));
    }

    if let Err(err) = location::set_vault_dir_in(home, Some(target)) {
        rollback(target, &target_backup);
        return Err(AppError::new(
            "io",
            format!("保存设置失败：{}，数据仍在原位置。", err.message),
        ));
    }

    let had_source = location::has_vault(source);
    let retired = storage::retire_in(source, storage::VAULT_NAME, &tag).ok().flatten();
    let warning = if had_source && retired.is_none() {
        Some("原位置的 vault.dat 没能改名，你可以手动删除。".to_string())
    } else {
        None
    };

    let entries = current_entries(state, &bytes)?;
    let mut report = switch_report("moved", target, entries);
    report.retired = retired.map(|path| path.display().to_string());
    report.warning = warning;
    Ok(report)
}

/// 迁移后库里有多少条：优先问会话，没有会话就把字节解开数一遍。
fn current_entries(state: &AppState, bytes: &[u8]) -> AppResult<usize> {
    if let Ok(entries) = with_session(state, |session| Ok(session.vault.entries.len())) {
        return Ok(entries);
    }
    Ok(store::unseal(bytes, &master::read()?)
        .map(|vault| vault.entries.len())
        .unwrap_or(0))
}

#[tauri::command]
pub fn master_status() -> MasterInfo {
    master_info()
}

/// 把用户输入的主密码写进用户级环境变量。
/// 写之前先验一次：能解开现有库才允许写，否则一个笔误就让人下次启动打不开。
#[tauri::command]
pub async fn set_master_env(
    state: tauri::State<'_, AppState>,
    password: String,
) -> AppResult<MasterInfo> {
    let dir = location::vault_dir()?;
    verify_master(state.inner(), &dir, &password)?;
    master::write_user(&password)?;
    Ok(master_info())
}

#[tauri::command]
pub fn clear_master_env() -> AppResult<MasterInfo> {
    master::clear_user()?;
    Ok(master_info())
}

#[tauri::command]
pub fn set_view(window: tauri::WebviewWindow, view: String, height: Option<u32>) {
    let config = config::load();
    let fallback = match view.as_str() {
        "list" => config.window_sizes.list,
        "settings" => config.window_sizes.settings,
        "generator" => config.window_sizes.generator,
        // 错误页内容比查询页高，不能跟着查询页一起收小
        "error" => config::DEFAULT_ERROR,
        _ => config.window_sizes.query,
    };

    // 生成视图的高度取决于插件声明了几个输入框，前端量完内容再传上来；
    // 其它视图传 null，仍用 config 里记住的尺寸。
    let size = match height {
        Some(value) => [fallback[0], value.clamp(MIN_CONTENT_HEIGHT, MAX_CONTENT_HEIGHT)],
        None => fallback,
    };

    // 记住当前窗口中心，换尺寸后仍用这个中心。
    // 之前这里每切一次视图就 center()，三个视图尺寸不同，看起来就是窗口"瞬移"。
    let previous_center = window.outer_position().ok().and_then(|position| {
        let outer = window.outer_size().ok()?;
        Some((
            position.x as f64 + outer.width as f64 / 2.0,
            position.y as f64 + outer.height as f64 / 2.0,
        ))
    });

    let _ = window.set_size(tauri::LogicalSize::new(size[0] as f64, size[1] as f64));

    let (Some((center_x, center_y)), Ok(outer)) = (previous_center, window.outer_size()) else {
        return;
    };

    let mut x = (center_x - outer.width as f64 / 2.0).round() as i32;
    let mut y = (center_y - outer.height as f64 / 2.0).round() as i32;

    // 夹到当前显示器工作区，避免大窗口的中心落在屏幕边缘时跑出去
    if let Ok(Some(monitor)) = window.current_monitor() {
        let area = monitor.work_area();
        let min_x = area.position.x;
        let min_y = area.position.y;
        let max_x = (area.position.x + area.size.width as i32 - outer.width as i32).max(min_x);
        let max_y = (area.position.y + area.size.height as i32 - outer.height as i32).max(min_y);
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
    }

    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
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
/// 加密用的是用户现设的备份密码，与主密码无关——备份可以拿给别人，也不必在换主密码后重导。
#[tauri::command]
pub async fn export_vault(app: AppHandle, password: String) -> Result<Option<String>, AppError> {
    // 先校验再弹保存对话框：让用户选完路径才被告知“密码太短”太蠢
    store::validate_backup_password(&password)?;

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

    let bytes = {
        let state = app.state::<AppState>();
        with_session(state.inner(), |session| {
            store::seal_with_password(&password, &session.vault)
        })?
    };

    // 写盘顺序与 storage.rs 的口径一致：临时文件 → 旧文件挪成 .bak → 改名。
    // 这样任何一步失败都能把旧的放回去；"先删旧的再改名"一旦改名失败就会两头落空。
    let mut tmp_name = path.clone().into_os_string();
    tmp_name.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp_name);
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp)
            .map_err(|err| AppError::new("io", format!("写入失败：{err}")))?;
        let failed = file.write_all(&bytes).and_then(|()| {
            // 断电时"改名成功但内容没落盘"是备份最不该有的失败方式
            file.sync_all()
        });
        if let Err(err) = failed {
            // 半截临时文件别留着：下次导出会 truncate 覆盖，但它会让人误以为有备份
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::new("io", format!("写入失败：{err}")));
        }
    }

    let mut bak_name = path.clone().into_os_string();
    bak_name.push(".bak");
    let bak = std::path::PathBuf::from(bak_name);
    if path.exists() {
        if bak.exists() {
            let _ = std::fs::remove_file(&bak);
        }
        std::fs::rename(&path, &bak).map_err(|err| {
            let _ = std::fs::remove_file(&tmp);
            AppError::new("io", format!("写入失败：目标文件无法覆盖。（{err}）"))
        })?;
    }
    if let Err(err) = std::fs::rename(&tmp, &path) {
        if bak.exists() {
            let _ = std::fs::rename(&bak, &path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new("io", format!("写入失败：{err}")));
    }
    if bak.exists() {
        let _ = std::fs::remove_file(&bak);
    }
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
    password: String,
) -> AppResult<ImportReport> {
    let bytes = std::fs::read(&path)
        .map_err(|err| AppError::new("io", format!("读不到这个文件：{err}")))?;
    // 备份只认导出时设的那个密码，与主密码无关：所以这里既不比对会话盐，也不读环境变量
    let incoming = store::unseal_backup(&bytes, &password)?;
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let backup_path = if mode == MergeMode::Replace {
        let tag = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        let dir = location::vault_dir()?;
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
/// 换完顺手同步环境变量，否则下次启动读到旧值，库就打不开了。
#[tauri::command]
pub async fn change_master(
    state: tauri::State<'_, AppState>,
    new_password: String,
) -> AppResult<ChangeMasterReport> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("internal", "会话状态异常。"))?;
    let session = guard.as_mut().ok_or_else(|| AppError::new("locked", LOCKED))?;

    let (new_key, new_salt, bytes) = store::rotate(&new_password, &session.vault)?;
    storage::write_atomic_in(&location::ensure_vault_dir()?, storage::VAULT_NAME, &bytes)?;

    session.salt = new_salt;
    session.key = new_key;

    // 库已经换好了，同步失败不能把整个操作判失败——但要把原因交回界面，
    // 让用户知道现在库和环境变量不一致、需要点“设置/更新”重试。
    let sync = master::write_user(&new_password);
    Ok(ChangeMasterReport {
        synced: sync.is_ok(),
        message: sync.err().map(|err| err.message),
    })
}

#[cfg(test)]
mod tests {
    //! 集成级用例：走"派生密钥 → 加密写盘 → 用主密码重新打开"这条主链路，
    //! 只把数据目录换成临时目录，其余与真实运行完全一致。

    use super::*;
    use passlet_core::crypto;
    use passlet_core::vault::Vault;
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

    #[test]
    fn 没有库文件也没有会话时任何主密码都算通过校验() {
        let dir = temp_dir("verify-novault");
        let state = AppState::default();
        // 真正的首次使用：没库、也没有内存会话，没得比；界面靠“输两次”防笔误
        verify_master(&state, &dir, "").unwrap();
        verify_master(&state, &dir, "随便什么").unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 没有库文件但已有会话时改密码要跟会话对得上() {
        let dir = temp_dir("verify-session");
        let state = AppState::default();
        {
            // 模拟“从说明页设置完之后、还没写盘”的状态：会话已建立，库文件不存在
            let mut guard = state.session.lock().unwrap();
            *guard = Some(session_with(&[]));
        }

        verify_master(&state, &dir, MASTER).unwrap();
        let err = verify_master(&state, &dir, "another password").unwrap_err();
        assert_eq!(err.code, "wrong_master");
        // 提示要把人引到“更换主密码”，否则用户会以为是自己记错了
        assert!(err.message.contains("更换主密码"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 库存在时错密码报_wrong_master_而正确密码通过() {
        let dir = temp_dir("verify");
        let state = AppState::default();
        persist_to(&session_with(&[("GitHub", "me", "p")]), &dir).unwrap();

        let err = verify_master(&state, &dir, "another password").unwrap_err();
        assert_eq!(err.code, "wrong_master");
        // 提示要能直接给用户看，不能是底层错误
        assert!(err.message.contains("打不开现有的密码库"));

        verify_master(&state, &dir, MASTER).unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 库文件损坏时报文件问题而不是密码不对() {
        let dir = temp_dir("verify-corrupt");
        let state = AppState::default();
        fs::write(dir.join(storage::VAULT_NAME), b"not a vault at all").unwrap();
        let err = verify_master(&state, &dir, MASTER).unwrap_err();
        // 报成“密码不对”会让用户白改密码，所以必须区分开
        assert_ne!(err.code, "wrong_master");
        fs::remove_dir_all(&dir).ok();
    }

    /// `import_from` 需要 Tauri 的 `State`，单测里拿不到，所以这里复刻它的动作序列：
    /// 读字节 → 用备份密码解 → 合并 → 写盘。命令壳的形参由契约测试盯，加密与合并由这里盯。
    #[test]
    fn 导出用备份密码封包导入同一密码才解得开() {
        use_master(MASTER);
        let dir = temp_dir("backup-import");
        let session = session_with(&[("GitHub", "me", "p1")]);
        persist_to(&session, &dir).unwrap();

        // 备份里放一条当前库没有的条目，才能看出合并真的发生了
        let other = session_with(&[("Gitee", "me", "p2")]);
        let backup = store::seal_with_password("backup-pw-2026", &other.vault).unwrap();

        // 密码错：在合并之前就失败，库文件一个字节都不该动
        let before = fs::read(dir.join(storage::VAULT_NAME)).unwrap();
        let err = store::unseal_backup(&backup, "wrong-backup-pw").unwrap_err();
        assert_eq!(err.code, "decrypt_failed");
        assert_eq!(err.message, store::BACKUP_DECRYPT_MESSAGE);
        assert_eq!(fs::read(dir.join(storage::VAULT_NAME)).unwrap(), before);

        // 拿主密码当备份密码：解不开——两条密码通道彻底分开
        assert_eq!(
            store::unseal_backup(&backup, MASTER).unwrap_err().code,
            "decrypt_failed"
        );

        // 密码对：合并进当前库并写盘，重开后两条都在
        let incoming = store::unseal_backup(&backup, "backup-pw-2026").unwrap();
        let mut current = unlock_from(&dir).unwrap();
        let stats = current.vault.merge_from(&incoming, MergeMode::Skip);
        assert_eq!(stats.added, 1);
        persist_to(&current, &dir).unwrap();
        assert_ne!(fs::read(dir.join(storage::VAULT_NAME)).unwrap(), before);
        let reopened = unlock_from(&dir).unwrap();
        assert_eq!(reopened.vault.entries.len(), 2);
        assert!(reopened.vault.entries.iter().any(|e| e.platform == "Gitee"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 主密码状态报告与_active_判定一致() {
        let info = master_info();
        assert!(["process", "user", "machine", "none"].contains(&info.active));
        let any = info.process_env || info.user_registry || info.machine_registry;
        assert_eq!(info.active == "none", !any);
        if info.active == "process" {
            assert!(info.process_env);
        }
    }

    /// 造一个“配置目录在 home、库里指针指向 dir”的环境。
    /// 所有换位置相关的用例都靠它把配置写进临时目录，绝不碰真实的 %APPDATA%。
    fn home_with(dir: &Path) -> std::path::PathBuf {
        let home = temp_dir("switch-home");
        location::set_vault_dir_in(&home, Some(dir)).unwrap();
        home
    }

    #[test]
    fn 迁移到空目录后新位置有库原位置留档() {
        use_master(MASTER);
        let a = temp_dir("move-a");
        let b = temp_dir("move-b");
        let home = home_with(&a);

        persist_to(&session_with(&[("GitHub", "me", "p1"), ("阿里云", "autod", "p2")]), &a).unwrap();
        let original = fs::read(a.join(storage::VAULT_NAME)).unwrap();
        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(unlock_from(&a).unwrap());
        }

        // 没带确认时只回执，一个文件都不许动
        let first = switch_inner(&state, &home, &b, false, false).unwrap();
        assert_eq!(first.kind, "needs_confirm");
        assert_eq!(first.entries, 2);
        assert!(!b.join(storage::VAULT_NAME).exists());
        assert!(a.join(storage::VAULT_NAME).exists());

        let report = switch_inner(&state, &home, &b, false, true).unwrap();
        assert_eq!(report.kind, "moved");
        assert_eq!(report.entries, 2);
        // 原样复制：不重新加密，两边逐字节相同
        assert_eq!(fs::read(b.join(storage::VAULT_NAME)).unwrap(), original);
        // 原位置不再有 vault.dat，但留了一份带时间戳的留档
        assert!(!a.join(storage::VAULT_NAME).exists());
        let retired = report.retired.expect("迁移应留下留档");
        assert!(retired.contains("vault.dat.moved-"), "留档名不对：{retired}");
        assert!(Path::new(&retired).exists());
        // 指针已经改了，新位置能用同一个主密码打开
        assert_eq!(
            location::vault_dir_in(&config::load_in(&home)).unwrap(),
            b
        );
        assert_eq!(unlock_from(&b).unwrap().vault.entries.len(), 2);

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 目标已有可解的库时走连接() {
        use_master(MASTER);
        let a = temp_dir("connect-a");
        let c = temp_dir("connect-c");
        let home = home_with(&a);

        persist_to(&session_with(&[("GitHub", "me", "p1")]), &a).unwrap();
        persist_to(&session_with(&[("Gitee", "me", "x")]), &c).unwrap();
        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(unlock_from(&a).unwrap());
        }

        // 连接不需要确认：它不改动任何文件
        let report = switch_inner(&state, &home, &c, false, false).unwrap();
        assert_eq!(report.kind, "connected");
        assert_eq!(report.entries, 1);
        assert!(a.join(storage::VAULT_NAME).exists(), "连接不搬文件");
        assert_eq!(
            location::vault_dir_in(&config::load_in(&home)).unwrap(),
            c
        );
        let entries = {
            let guard = state.session.lock().unwrap();
            guard.as_ref().unwrap().vault.entries.len()
        };
        assert_eq!(entries, 1, "会话应换成目标位置的库");

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&c).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 目标库的主密码不一致时拒绝且指针不变() {
        use_master(MASTER);
        let a = temp_dir("reject-a");
        let d = temp_dir("reject-d");
        let home = home_with(&a);

        persist_to(&session_with(&[("GitHub", "me", "p1")]), &a).unwrap();
        let other = session_with(&[("Gitee", "me", "x")]);
        let (_, _, bytes) = store::rotate("another master password", &other.vault).unwrap();
        storage::write_atomic_in(&d, storage::VAULT_NAME, &bytes).unwrap();

        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(unlock_from(&a).unwrap());
        }

        let err = switch_inner(&state, &home, &d, false, false).unwrap_err();
        assert_eq!(err.code, "wrong_master");
        assert!(err.message.contains("主密码和当前的不一致"));
        // 指针与两个目录都不能被动过
        assert_eq!(
            location::vault_dir_in(&config::load_in(&home)).unwrap(),
            a
        );
        assert!(a.join(storage::VAULT_NAME).exists());

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&d).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 目标位置的_vault_dat_不是库时报_corrupt() {
        use_master(MASTER);
        let a = temp_dir("corrupt-a");
        let e = temp_dir("corrupt-e");
        let home = home_with(&a);

        persist_to(&session_with(&[("GitHub", "me", "p1")]), &a).unwrap();
        fs::write(e.join(storage::VAULT_NAME), b"not a vault at all").unwrap();
        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(unlock_from(&a).unwrap());
        }

        let err = switch_inner(&state, &home, &e, false, false).unwrap_err();
        assert_eq!(err.code, "corrupt");
        assert!(err.message.contains("不是 Passlet 的密码库文件"));

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&e).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 选到的就是当前位置时不做任何事() {
        use_master(MASTER);
        let a = temp_dir("same-a");
        let home = home_with(&a);
        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(session_with(&[("GitHub", "me", "p1")]));
        }

        let report = switch_inner(&state, &home, &a, false, true).unwrap();
        assert_eq!(report.kind, "unchanged");
        assert_eq!(report.entries, 1);
        assert!(!a.join(storage::VAULT_NAME).exists(), "不该顺手写盘");

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 强制迁移会把目标原有库改名留档且不碰那里原有的_bak() {
        use_master(MASTER);
        let a = temp_dir("force-a");
        let b = temp_dir("force-b");
        let home = home_with(&a);

        persist_to(&session_with(&[("GitHub", "me", "p1")]), &a).unwrap();
        persist_to(&session_with(&[("Gitee", "me", "old")]), &b).unwrap();
        let old_bytes = fs::read(b.join(storage::VAULT_NAME)).unwrap();
        // 目标目录里还有一份更早的 .bak：它是用户自己的东西，迁移不许碰
        let older_bak = b"older-backup-bytes";
        fs::write(b.join("vault.dat.bak"), older_bak).unwrap();

        let state = AppState::default();
        {
            let mut guard = state.session.lock().unwrap();
            *guard = Some(unlock_from(&a).unwrap());
        }

        // 「恢复默认位置」用的就是这条路：即使目标里已经有库也照样搬
        let report = switch_inner(&state, &home, &b, true, true).unwrap();
        assert_eq!(report.kind, "moved");
        assert_eq!(unlock_from(&b).unwrap().vault.entries.len(), 1);

        // 被顶掉的旧库进了 .moved-*，没有凭空消失
        let moved: Vec<_> = fs::read_dir(&b)
            .unwrap()
            .filter_map(|item| item.ok())
            .filter(|item| item.file_name().to_string_lossy().contains("vault.dat.moved-"))
            .collect();
        assert_eq!(moved.len(), 1, "旧库应留档一份");
        assert_eq!(fs::read(moved[0].path()).unwrap(), old_bytes);
        // 原来那份 .bak 一个字节都没动
        assert_eq!(fs::read(b.join("vault.dat.bak")).unwrap(), older_bak);

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 位置里没有库时改指针不算迁移() {
        use_master(MASTER);
        let a = temp_dir("point-a");
        let b = temp_dir("point-b");
        let home = home_with(&a);
        let state = AppState::default();

        // 指针指向 A，但 A 里没有库、也没有会话——错误页「改回默认位置」正是这个状态
        let report = switch_inner(&state, &home, &b, true, true).unwrap();
        assert_eq!(report.kind, "cleared");
        assert_eq!(report.entries, 0);
        assert_eq!(location::vault_dir_in(&config::load_in(&home)).unwrap(), b);
        assert!(!b.join(storage::VAULT_NAME).exists(), "不许顺手建库文件");
        assert!(!a.join(storage::VAULT_NAME).exists());

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 位置里没有库但目标有库时直接连接() {
        use_master(MASTER);
        let a = temp_dir("connect-empty-a");
        let b = temp_dir("connect-empty-b");
        let home = home_with(&a);
        persist_to(&session_with(&[("Gitee", "me", "x")]), &b).unwrap();
        let state = AppState::default();

        let report = switch_inner(&state, &home, &b, true, true).unwrap();
        assert_eq!(report.kind, "connected");
        assert_eq!(report.entries, 1);
        assert_eq!(location::vault_dir_in(&config::load_in(&home)).unwrap(), b);

        fs::remove_dir_all(&a).ok();
        fs::remove_dir_all(&b).ok();
        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 可写性预检会清掉探针文件() {
        let dir = temp_dir("writable");
        ensure_writable(&dir).unwrap();
        assert!(!dir.join(".passlet-write-test").exists(), "探针文件不能留下");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 同一物理目录的两种写法判为同一个位置() {
        let dir = temp_dir("same-physical");
        let sub = dir.join("sub");
        fs::create_dir_all(&sub).unwrap();
        // 绕一层 .. 的写法与直接指向必须等价
        let roundabout = sub.join("..");

        assert!(same_physical(&dir, &roundabout));
        assert!(same_physical(&dir, &dir.join(".")));

        let other = temp_dir("same-physical-other");
        assert!(!same_physical(&dir, &other));

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn 非默认目录缺库时报_vault_missing_且不建空库() {
        use_master(MASTER);
        let dir = temp_dir("missing-vault");

        let err = unlock_at(&dir).unwrap_err();
        assert_eq!(err.code, "vault_missing");
        assert!(err.message.contains("找不到密码库"));
        assert!(!dir.join(storage::VAULT_NAME).exists(), "不能顺手建出空库");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 缺库的位置能新建空库且不覆盖已有的库() {
        use_master(MASTER);
        let dir = temp_dir("create-here");
        let home = home_with(&dir);
        let state = AppState::default();

        let report = create_vault_in(&state, &home).unwrap();
        assert_eq!(report.kind, "created");
        assert_eq!(report.entries, 0);
        assert!(dir.join(storage::VAULT_NAME).exists());
        assert_eq!(unlock_from(&dir).unwrap().vault.entries.len(), 0);

        // 已经有库了再点一次：拒绝，且不动那份库
        let before = fs::read(dir.join(storage::VAULT_NAME)).unwrap();
        assert_eq!(create_vault_in(&state, &home).unwrap_err().code, "invalid");
        assert_eq!(fs::read(dir.join(storage::VAULT_NAME)).unwrap(), before);

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&home).ok();
    }
}
