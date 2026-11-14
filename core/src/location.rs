//! 库目录的唯一真相：配置里的 `vaultDir` > 默认目录。
//!
//! 只有这里知道“库在哪”。`storage` 仍只认一个目录参数（不碰配置），
//! `commands` 与 `cli` 都向这里要目录，谁都不再自己拼 `%APPDATA%`——
//! 两处拼路径就会有两套真相，迟早对不上。
//!
//! 约定：**默认目录里没有库 = 首次运行；非默认目录里没有库 = 库不见了**。
//! 后者绝不能当成首次运行，否则界面会安静地显示一个空库，让用户以为数据没了。

use std::path::{Path, PathBuf};

use crate::config::{self, Config};
use crate::error::{AppError, AppResult};
use crate::paths;
use crate::storage;

/// 配置目录（`config.json` 的家），也是默认库目录。
pub fn config_home() -> AppResult<PathBuf> {
    paths::data_dir()
}

/// 默认库目录。
pub fn default_vault_dir() -> AppResult<PathBuf> {
    paths::default_vault_dir()
}

/// 当前库目录。配置里没有就回落到默认目录。
pub fn vault_dir() -> AppResult<PathBuf> {
    vault_dir_in(&config::load())
}

/// 从一份已经读进内存的配置里算出库目录。
pub fn vault_dir_in(config: &Config) -> AppResult<PathBuf> {
    match config.vault_dir.as_deref() {
        Some(dir) if !dir.trim().is_empty() => Ok(PathBuf::from(dir)),
        _ => default_vault_dir(),
    }
}

/// 当前库文件的完整路径（设置页显示的那一行）。
pub fn vault_file() -> AppResult<PathBuf> {
    Ok(vault_dir()?.join(storage::VAULT_NAME))
}

/// 目录里有没有库文件。
pub fn has_vault(dir: &Path) -> bool {
    dir.join(storage::VAULT_NAME).exists()
}

/// 这个目录是不是默认目录（决定「恢复默认位置」按钮是否出现）。
pub fn is_default(dir: &Path) -> bool {
    default_vault_dir()
        .map(|default| is_default_in(dir, &default))
        .unwrap_or(false)
}

pub fn is_default_in(dir: &Path, default: &Path) -> bool {
    paths::same_dir(dir, default)
}

/// 写盘前确保目录存在。
///
/// **只在真要写的时候调用**：打开库时绝不创建目录，否则“OneDrive 目录被删了”
/// 会变成“悄悄建个空目录，再告诉你里面没有库”，两个错误叠在一起更难查。
pub fn ensure_vault_dir() -> AppResult<PathBuf> {
    let dir = vault_dir()?;
    ensure_dir(&dir)
}

pub fn ensure_dir(dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(dir)
        .map_err(|err| AppError::new("io", format!("无法创建 {}：{err}", dir.display())))?;
    Ok(dir.to_path_buf())
}

/// 改指针。`None` = 回到默认目录。
pub fn set_vault_dir(dir: Option<&Path>) -> AppResult<()> {
    set_vault_dir_in(&config_home()?, dir)
}

/// 改指针的可测版本：配置目录由调用方给，测试因此不碰真实配置。
pub fn set_vault_dir_in(config_home: &Path, dir: Option<&Path>) -> AppResult<()> {
    let mut config = config::load_in(config_home);
    config.vault_dir = dir.map(|path| path.to_string_lossy().to_string());
    // save_in 会走 sanitized：指向默认目录的值在那里被归一成 None，
    // 于是“配着默认目录”和“没配”永远只有一种表示。
    config::save_in(config_home, &config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch;

    #[test]
    fn 没有配置时用默认目录() {
        let config = Config::default();
        assert_eq!(vault_dir_in(&config).unwrap(), default_vault_dir().unwrap());
    }

    #[test]
    fn 配了目录就用配置里的目录() {
        let custom = scratch::scratch_dir("location-custom");
        let mut config = Config::default();
        config.vault_dir = Some(custom.display().to_string());

        assert_eq!(vault_dir_in(&config).unwrap(), custom);
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn 空字符串按没配处理() {
        let mut config = Config::default();
        config.vault_dir = Some("   ".to_string());
        assert_eq!(vault_dir_in(&config).unwrap(), default_vault_dir().unwrap());
    }

    #[test]
    fn 指针能写入配置并被读回() {
        let home = scratch::scratch_dir("location-pointer");
        let custom = scratch::scratch_dir("location-target");

        set_vault_dir_in(&home, Some(&custom)).unwrap();
        let config = config::load_in(&home);
        assert_eq!(config.vault_dir.as_deref(), Some(custom.to_string_lossy().as_ref()));
        assert_eq!(vault_dir_in(&config).unwrap(), custom);

        // 清掉指针：配置回到“没配”这一种表示
        set_vault_dir_in(&home, None).unwrap();
        let config = config::load_in(&home);
        assert_eq!(config.vault_dir, None);
        assert_eq!(vault_dir_in(&config).unwrap(), default_vault_dir().unwrap());

        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn 改指针不动其它配置项() {
        let home = scratch::scratch_dir("location-keep");
        let custom = scratch::scratch_dir("location-keep-target");

        let mut config = Config::default();
        config.theme = "dark".to_string();
        config.hide_password_seconds = 5;
        config.window_sizes.list = [900, 500];
        config::save_in(&home, &config).unwrap();

        set_vault_dir_in(&home, Some(&custom)).unwrap();
        let loaded = config::load_in(&home);
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.hide_password_seconds, 5);
        assert_eq!(loaded.window_sizes.list, [900, 500]);

        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&custom).ok();
    }

    #[test]
    fn 指向默认目录的指针被归一成没配() {
        let home = scratch::scratch_dir("location-default-collapse");
        let Ok(default) = default_vault_dir() else {
            return;
        };

        set_vault_dir_in(&home, Some(&default)).unwrap();
        assert_eq!(config::load_in(&home).vault_dir, None);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn 确保目录会真的创建出来() {
        let dir = scratch::scratch_dir("location-ensure");
        let nested = dir.join("a").join("b");
        assert!(!nested.exists());

        assert_eq!(ensure_dir(&nested).unwrap(), nested);
        assert!(nested.is_dir());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 有没有库文件按文件判断() {
        let dir = scratch::scratch_dir("location-has");
        assert!(!has_vault(&dir));

        std::fs::write(dir.join(storage::VAULT_NAME), b"x").unwrap();
        assert!(has_vault(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 默认目录判定与路径写法无关() {
        let default = Path::new(r"C:\Users\a\AppData\Roaming\Passlet");
        assert!(is_default_in(Path::new(r"c:\users\a\appdata\roaming\passlet\"), default));
        assert!(!is_default_in(Path::new(r"C:\OneDrive\Passlet"), default));
    }
}
