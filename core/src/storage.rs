//! 数据文件的读写。
//!
//! 写盘一律走"临时文件 → 轮换 .bak → 改名"三步：
//! 1. 先写 `vault.dat.tmp` 并 fsync，避免写一半断电留下半个文件；
//! 2. 把现有文件改名成 `vault.dat.bak`（上一版天然可回滚）；
//! 3. 把 tmp 改名成正式文件。
//! Windows 上 rename 不能覆盖已存在文件，所以顺序必须是"先挪走再改名"。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::paths;

pub const VAULT_NAME: &str = "vault.dat";

/// 读整个文件；不存在返回 None（首次运行）。
pub fn read_in(dir: &Path, name: &str) -> AppResult<Option<Vec<u8>>> {
    let path = dir.join(name);
    match fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(AppError::new(
            "io",
            format!("读不到 {}：{err}", path.display()),
        )),
    }
}

pub fn write_atomic_in(dir: &Path, name: &str, bytes: &[u8]) -> AppResult<()> {
    fs::create_dir_all(dir)
        .map_err(|err| AppError::new("io", format!("无法创建 {}：{err}", dir.display())))?;

    let target = dir.join(name);
    let tmp = dir.join(format!("{name}.tmp"));
    let bak = dir.join(format!("{name}.bak"));

    {
        let mut file = File::create(&tmp).map_err(|err| {
            AppError::new("io", format!("无法写入 {}：{err}", tmp.display()))
        })?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }

    if target.exists() {
        if bak.exists() {
            fs::remove_file(&bak)
                .map_err(|err| AppError::new("io", format!("无法替换旧备份：{err}")))?;
        }
        fs::rename(&target, &bak)
            .map_err(|err| AppError::new("io", format!("无法备份原文件：{err}")))?;
    }

    // 第二步失败（杀软占用、磁盘满）时，原文件已经在 .bak 里，
    // 必须把它搬回去——否则下次启动会把"文件不存在"当成首次运行，显示空库。
    if let Err(err) = fs::rename(&tmp, &target) {
        if bak.exists() {
            let _ = fs::rename(&bak, &target);
        }
        return Err(AppError::new(
            "io",
            format!("无法写入 {}：{err}", target.display()),
        ));
    }
    Ok(())
}

/// 导入前留档：`vault.dat.bak.<时间戳>`，与轮换用的 .bak 分开，不会被下一次写盘覆盖。
pub fn backup_with_timestamp_in(dir: &Path, name: &str, tag: &str) -> AppResult<Option<PathBuf>> {
    let source = dir.join(name);
    if !source.exists() {
        return Ok(None);
    }
    let target = dir.join(format!("{name}.bak.{tag}"));
    fs::copy(&source, &target)
        .map_err(|err| AppError::new("io", format!("备份失败：{err}")))?;
    Ok(Some(target))
}

// ---------- 面向真实数据目录的薄包装 ----------

pub fn data_dir() -> AppResult<PathBuf> {
    paths::ensure_data_dir()
}


pub fn write_vault(bytes: &[u8]) -> AppResult<()> {
    let dir = data_dir()?;
    write_atomic_in(&dir, VAULT_NAME, bytes)
}

pub fn vault_path() -> AppResult<PathBuf> {
    paths::vault_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        crate::scratch::scratch_dir(&format!("storage-{tag}"))
    }

    #[test]
    fn 首次运行时文件不存在返回_none() {
        let dir = temp_dir("missing");
        assert!(read_in(&dir, VAULT_NAME).unwrap().is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 写入后能原样读回() {
        let dir = temp_dir("roundtrip");
        write_atomic_in(&dir, VAULT_NAME, b"first").unwrap();
        assert_eq!(read_in(&dir, VAULT_NAME).unwrap().unwrap(), b"first");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 第二次写入把上一版留成_bak() {
        let dir = temp_dir("bak");
        write_atomic_in(&dir, VAULT_NAME, b"v1").unwrap();
        write_atomic_in(&dir, VAULT_NAME, b"v2").unwrap();

        assert_eq!(fs::read(dir.join(VAULT_NAME)).unwrap(), b"v2");
        assert_eq!(fs::read(dir.join("vault.dat.bak")).unwrap(), b"v1");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 多次写入后_bak_始终是上一版() {
        let dir = temp_dir("bak-rotate");
        for content in [b"a".as_slice(), b"b", b"c"] {
            write_atomic_in(&dir, VAULT_NAME, content).unwrap();
        }
        assert_eq!(fs::read(dir.join(VAULT_NAME)).unwrap(), b"c");
        assert_eq!(fs::read(dir.join("vault.dat.bak")).unwrap(), b"b");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 写入不留下临时文件() {
        let dir = temp_dir("tmp-clean");
        write_atomic_in(&dir, VAULT_NAME, b"data").unwrap();
        assert!(!dir.join("vault.dat.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 带时间戳的备份与轮换备份互不影响() {
        let dir = temp_dir("stamped");
        write_atomic_in(&dir, VAULT_NAME, b"current").unwrap();
        write_atomic_in(&dir, VAULT_NAME, b"next").unwrap();

        let backup = backup_with_timestamp_in(&dir, VAULT_NAME, "20261110-120000")
            .unwrap()
            .expect("应生成备份");
        assert_eq!(fs::read(&backup).unwrap(), b"next");
        assert_eq!(fs::read(dir.join("vault.dat.bak")).unwrap(), b"current");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 数据文件不存在时不做带时间戳的备份() {
        let dir = temp_dir("stamped-missing");
        assert!(backup_with_timestamp_in(&dir, VAULT_NAME, "x").unwrap().is_none());
        fs::remove_dir_all(&dir).ok();
    }
}
