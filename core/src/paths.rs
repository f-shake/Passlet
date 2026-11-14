use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// 配置目录：Windows 用 `%APPDATA%\Passlet`，其它平台用系统 data 目录。
///
/// 它同时是**默认的库目录**。库文件可以被 `config.json` 里的 `vaultDir` 指到别处
/// （比如 OneDrive 里的同步目录），但配置本身永远留在这里——配置文件是“库在哪”的
/// 指针的宿主，跟着库一起搬会变成鸡生蛋。
///
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

/// 默认库目录。今天与配置目录是同一个，单独留一个名字是为了让调用点的意图清楚：
/// 拿“配置在哪”和拿“库在哪”是两件事。
pub fn default_vault_dir() -> AppResult<PathBuf> {
    data_dir()
}

/// 确保配置目录存在，返回它。
pub fn ensure_data_dir() -> AppResult<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|err| AppError::new("io", format!("无法创建 {}：{err}", dir.display())))?;
    Ok(dir)
}

/// 判断两个路径是不是同一个目录。
///
/// 只做字符串归一（分隔符、大小写、末尾分隔符），不解析符号链接也不查 inode：
/// 写进配置的都是我们自己拿到的绝对路径，这个强度够用，且不会因为网络盘
/// 或 OneDrive 占位符而卡住。
pub fn same_dir(left: &Path, right: &Path) -> bool {
    fn norm(path: &Path) -> String {
        let text = path.to_string_lossy().replace('/', "\\");
        text.trim_end_matches('\\').to_lowercase()
    }
    norm(left) == norm(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 同一路径的大小写与末尾分隔符不算差异() {
        assert!(same_dir(Path::new(r"C:\Users\a\OneDrive\Passlet"), Path::new(r"c:\users\A\onedrive\passlet")));
        assert!(same_dir(Path::new(r"C:\Users\a\Passlet\"), Path::new(r"C:\Users\a\Passlet")));
        assert!(same_dir(Path::new("C:/Users/a/Passlet"), Path::new(r"C:\Users\a\Passlet")));
    }

    #[test]
    fn 不同路径判定为不同() {
        assert!(!same_dir(Path::new(r"C:\Users\a\Passlet"), Path::new(r"C:\Users\a\Passlet2")));
        assert!(!same_dir(Path::new(r"C:\Users\a\Passlet"), Path::new(r"D:\Passlet")));
    }
}
