//! Passlet 命令行。
//!
//! 设计约定：
//! - stdout 只放数据（便于 `|` 与 `$(...)` 捕获），提示与错误走 stderr；
//! - 密码**永不出现在命令行参数里**（会进 shell 历史与进程列表），只从标准输入读；
//! - 退出码：0 成功 / 1 用法错误 / 2 主密码问题 / 3 条目不存在 / 4 条目重复 / 5 文件读写失败。

use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

use clap::{Parser, Subcommand};
use passlet_core::error::{AppError, AppResult};
use passlet_core::storage;
use passlet_core::store;
use passlet_core::vault::{MergeMode, Vault};
use passlet_core::master;

#[derive(Parser)]
#[command(
    name = "passlet-cli",
    version,
    about = "Passlet 命令行：查看与管理本地密码库",
    after_help = "密码只从标准输入读取，不接受命令行参数。例：\n  echo -n 'mypass' | passlet-cli add GitHub me"
)]
struct Cli {
    /// 覆盖数据目录（默认 %APPDATA%\Passlet）
    #[arg(long, global = true)]
    vault: Option<PathBuf>,

    /// 输出 JSON（便于脚本解析）
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 列出平台与用户名（不含密码）
    List,
    /// 取出某条密码，打印到标准输出
    Get {
        platform: String,
        username: String,
        /// 复制到剪贴板而不是打印
        #[arg(long)]
        copy: bool,
    },
    /// 新增一条（密码从标准输入读）
    Add { platform: String, username: String },
    /// 修改密码（从标准输入读）
    Update { platform: String, username: String },
    /// 删除一条
    Remove {
        platform: String,
        username: String,
        /// 不再询问确认
        #[arg(long)]
        yes: bool,
    },
    /// 导出加密备份
    Export { path: PathBuf },
    /// 导入备份
    Import {
        path: PathBuf,
        /// replace | skip | overwrite（默认 skip，不覆盖现有条目）
        #[arg(long, default_value = "skip")]
        mode: String,
    },
    /// 更换主密码（新密码从标准输入读）
    ChangeMaster,
    /// 打印数据目录、主密码来源与条目数
    Doctor,
}

fn main() {
    // clap 默认在参数错误时 exit(2)，与本项目"2 = 主密码问题"的约定冲突，
    // 所以自己接管解析失败，统一成 1（用法错误）。
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(err) => {
            // --help / --version 是正常请求，退出码必须是 0；其余用法错误才算 1。
            // 用 --version 探测安装状态的脚本依赖这一点。
            let requested_help = matches!(
                err.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            );
            let _ = err.print();
            std::process::exit(if requested_help { 0 } else { 1 });
        }
    };
    match run(&cli) {
        Ok(()) => {}
        Err(err) => {
            eprintln!("{}", err.message);
            std::process::exit(exit_code(&err.code));
        }
    }
}

fn exit_code(code: &str) -> i32 {
    match code {
        "invalid" | "usage" => 1,
        "env_missing" | "decrypt_failed" => 2,
        "not_found" => 3,
        "duplicate" => 4,
        _ => 5,
    }
}

fn data_dir(cli: &Cli) -> AppResult<PathBuf> {
    match &cli.vault {
        Some(dir) => {
            std::fs::create_dir_all(dir)
                .map_err(|err| AppError::new("io", format!("无法创建 {}：{err}", dir.display())))?;
            Ok(dir.clone())
        }
        None => storage::data_dir(),
    }
}

fn run(cli: &Cli) -> AppResult<()> {
    let dir = data_dir(cli)?;

    match &cli.command {
        Command::Doctor => doctor(&dir, cli.json),
        Command::List => list(&dir, cli.json),
        Command::Get {
            platform,
            username,
            copy,
        } => get(&dir, platform, username, *copy, cli.json),
        Command::Add { platform, username } => {
            let password = read_secret("密码")?;
            let (key, salt, mut vault) = open(&dir)?;
            let entry = vault.add(platform, username, &password)?;
            store::persist_in(&dir, &key, &salt, &vault)?;
            if cli.json {
                print_json(&serde_json::json!({
                    "status": "added",
                    "platform": entry.platform,
                    "username": entry.username,
                }))?;
            } else {
                println!("已新增：{}", entry.platform);
            }
            Ok(())
        }
        Command::Update { platform, username } => {
            let password = read_secret("新密码")?;
            let (key, salt, mut vault) = open(&dir)?;
            let id = find_id(&vault, platform, username)?;
            let entry = vault.update(&id, platform, username, &password)?;
            store::persist_in(&dir, &key, &salt, &vault)?;
            if cli.json {
                print_json(&serde_json::json!({
                    "status": "updated",
                    "platform": entry.platform,
                    "username": entry.username,
                }))?;
            } else {
                println!("已更新：{}", entry.platform);
            }
            Ok(())
        }
        Command::Remove {
            platform,
            username,
            yes,
        } => {
            let (key, salt, mut vault) = open(&dir)?;
            let id = find_id(&vault, platform, username)?;
            if !confirm(platform, username, *yes)? {
                eprintln!("已取消。");
                return Ok(());
            }
            vault.remove(&id)?;
            store::persist_in(&dir, &key, &salt, &vault)?;
            if cli.json {
                print_json(&serde_json::json!({ "status": "removed" }))?;
            } else {
                println!("已删除：{platform}");
            }
            Ok(())
        }
        Command::Export { path } => {
            let (key, salt, vault) = open(&dir)?;
            let bytes = store::seal(&key, &salt, &vault)?;
            std::fs::write(path, bytes)
                .map_err(|err| AppError::new("io", format!("写入失败：{err}")))?;
            if cli.json {
                print_json(&serde_json::json!({ "status": "exported", "path": path }))?;
            } else {
                println!("已导出到 {}", path.display());
            }
            Ok(())
        }
        Command::Import { path, mode } => {
            let mode = parse_mode(mode)?;
            let bytes = std::fs::read(path)
                .map_err(|err| AppError::new("io", format!("读不到这个文件：{err}")))?;
            let incoming = store::unseal(&bytes, &master::read()?)?;

            let (key, salt, mut vault) = open(&dir)?;
            if mode == MergeMode::Replace {
                let tag = backup_tag();
                storage::backup_with_timestamp_in(&dir, storage::VAULT_NAME, &tag)?;
            }
            let stats = vault.merge_from(&incoming, mode);
            store::persist_in(&dir, &key, &salt, &vault)?;

            if cli.json {
                print_json(&serde_json::json!({
                    "added": stats.added,
                    "skipped": stats.skipped,
                    "replaced": stats.replaced,
                }))?;
            } else {
                println!(
                    "已导入：新增 {}，跳过 {}，覆盖 {}",
                    stats.added, stats.skipped, stats.replaced
                );
            }
            Ok(())
        }
        Command::ChangeMaster => {
            let new_master = read_secret("新主密码")?;
            let (_, _, vault) = open(&dir)?;
            let (key, salt, bytes) = store::rotate(&new_master, &vault)?;
            storage::write_atomic_in(&dir, storage::VAULT_NAME, &bytes)?;
            let _ = (key, salt);
            eprintln!("主密码已更换。记得同步修改环境变量 PASSLET_MASTER，否则下次打不开。");
            Ok(())
        }
    }
}

fn open(dir: &Path) -> AppResult<store::Opened> {
    store::open_in(dir, &master::read()?)
}

fn find_id(vault: &Vault, platform: &str, username: &str) -> AppResult<String> {
    let want_platform = platform.trim().to_lowercase();
    let want_username = username.trim().to_lowercase();
    vault
        .entries
        .iter()
        .find(|entry| {
            entry.platform.trim().to_lowercase() == want_platform
                && entry.username.trim().to_lowercase() == want_username
        })
        .map(|entry| entry.id.clone())
        .ok_or_else(|| AppError::new("not_found", format!("没有找到 {platform} / {username}。")))
}

fn list(dir: &Path, json: bool) -> AppResult<()> {
    let (_, _, vault) = open(dir)?;
    if json {
        let items: Vec<_> = vault
            .metas()
            .into_iter()
            .map(|meta| {
                serde_json::json!({
                    "id": meta.id,
                    "platform": meta.platform,
                    "username": meta.username,
                })
            })
            .collect();
        print_json(&serde_json::Value::Array(items))?;
    } else {
        for meta in vault.metas() {
            println!("{}\t{}", meta.platform, meta.username);
        }
    }
    Ok(())
}

fn get(dir: &Path, platform: &str, username: &str, copy: bool, json: bool) -> AppResult<()> {
    let (_, _, vault) = open(dir)?;
    let id = find_id(&vault, platform, username)?;
    let entry = vault.find(&id).expect("刚刚找到过");
    if copy {
        let mut clipboard = arboard::Clipboard::new()
            .map_err(|err| AppError::new("clipboard", format!("系统剪贴板不可用：{err}")))?;
        clipboard
            .set_text(entry.password.clone())
            .map_err(|err| AppError::new("clipboard", format!("复制失败：{err}")))?;
        if json {
            print_json(&serde_json::json!({ "status": "copied" }))?;
        } else {
            eprintln!("已复制到剪贴板（本命令不会自动清空，需要时请手动清除）");
        }
        return Ok(());
    }
    if json {
        print_json(&serde_json::json!({
            "platform": entry.platform,
            "username": entry.username,
            "password": entry.password,
        }))?;
    } else {
        println!("{}", entry.password);
    }
    Ok(())
}

fn doctor(dir: &Path, json: bool) -> AppResult<()> {
    let file = dir.join(storage::VAULT_NAME);
    let exists = file.exists();
    let size = std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0);
    let entries = if exists {
        match open(dir) {
            Ok((_, _, vault)) => vault.entries.len(),
            Err(_) => 0,
        }
    } else {
        0
    };

    if json {
        print_json(&serde_json::json!({
            "dataDir": dir.display().to_string(),
            "vaultExists": exists,
            "vaultBytes": size,
            "entries": entries,
            "masterSource": master::source(),
        }))?;
    } else {
        println!("数据目录    {}", dir.display());
        println!("库文件      {}", if exists { format!("{size} 字节") } else { "尚未创建".into() });
        println!("条目数      {entries}");
        println!("主密码来源  {}", match master::source() {
            "env" => "进程环境变量",
            "user-registry" => "用户级环境变量（注册表）",
            "machine-registry" => "机器级环境变量（注册表）",
            _ => "未找到",
        });
    }
    Ok(())
}

fn parse_mode(value: &str) -> AppResult<MergeMode> {
    match value.to_lowercase().as_str() {
        "replace" => Ok(MergeMode::Replace),
        "skip" => Ok(MergeMode::Skip),
        "overwrite" => Ok(MergeMode::Overwrite),
        other => Err(AppError::new(
            "usage",
            format!("未知的合并方式 “{other}”，可用：replace / skip / overwrite"),
        )),
    }
}

fn backup_tag() -> String {
    // 只用秒级时间戳，避免为了格式化时间引入额外依赖
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn confirm(platform: &str, username: &str, assume_yes: bool) -> AppResult<bool> {
    if assume_yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        return Err(AppError::new(
            "usage",
            "标准输入不是终端，删除操作需要显式加 --yes。",
        ));
    }
    eprint!("删除 {platform} / {username}？输入 yes 确认：");
    std::io::stderr().flush().ok();
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .map_err(|err| AppError::new("io", format!("读标准输入失败：{err}")))?;
    Ok(answer.trim().eq_ignore_ascii_case("yes"))
}

/// 密码只从标准输入读：不接受命令行参数，避免进入 shell 历史与进程列表。
fn read_secret(label: &str) -> AppResult<String> {
    let stdin = std::io::stdin();
    let interactive = stdin.is_terminal();

    let mut buffer = String::new();
    if interactive {
        // 终端里等一行就够：之前用 read_to_string，用户按回车不会结束，看起来像卡死
        eprint!("{label}（回车结束，输入内容会显示）：");
        std::io::stderr().flush().ok();
        stdin
            .read_line(&mut buffer)
            .map_err(|err| AppError::new("io", format!("读标准输入失败：{err}")))?;
    } else {
        // 管道里读到结尾，便于 `cat pass.txt | passlet-cli add ...`
        let mut stdin = stdin;
        stdin
            .read_to_string(&mut buffer)
            .map_err(|err| AppError::new("io", format!("读标准输入失败：{err}")))?;
    }

    let value = buffer.trim_end_matches(['\r', '\n']).to_string();
    if value.is_empty() {
        return Err(AppError::new("invalid", "密码不能为空。"));
    }
    Ok(value)
}
fn print_json(value: &serde_json::Value) -> AppResult<()> {
    let text = serde_json::to_string_pretty(value)?;
    println!("{text}");
    Ok(())
}

