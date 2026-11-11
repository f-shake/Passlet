use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// 数据根目录：Windows 用 %APPDATA%\Passlet，其它平台用系统 data 目录。
/// 不用 exe 同目录：装到 Program Files 后那里不可写。
pub fn data_dir() -> AppResult<PathBuf> {
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return Ok(PathBuf::from(appdata).join("Passlet"));
        }
    }
    dirs::data_dir()
        .map(|dir| dir.join("Passlet"))
        .ok_or_else(|| AppError::new("io", "找不到可用的数据目录。"))
}

/// 确保数据目录存在，返回它。
pub fn ensure_data_dir() -> AppResult<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::new("io", format!("无法创建 {}：{err}", dir.display())))?;
    Ok(dir)
}

pub fn vault_file() -> AppResult<PathBuf> {
    Ok(data_dir()?.join("vault.dat"))
}

