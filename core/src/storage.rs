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

    let mut rotated = false;
    if target.exists() {
        if bak.exists() {
            fs::remove_file(&bak)
                .map_err(|err| AppError::new("io", format!("无法替换旧备份：{err}")))?;
        }
        fs::rename(&target, &bak)
            .map_err(|err| AppError::new("io", format!("无法备份原文件：{err}")))?;
        rotated = true;
    }

    // 第二步失败（杀软占用、磁盘满）时，原文件已经在 .bak 里，
    // 必须把它搬回去——否则下次启动会把"文件不存在"当成首次运行，显示空库。
    if let Err(err) = fs::rename(&tmp, &target) {
        restore_from_bak(&target, &bak, rotated);
        return Err(AppError::new(
            "io",
            format!("无法写入 {}：{err}", target.display()),
        ));
    }
    Ok(())
}

/// 写盘最后一步失败后，要不要把 `.bak` 搬回 `target`。
///
/// 只有**这次调用自己轮换出来的** `.bak` 才能认领：目录里可能本来就躺着一份别人的
/// `.bak`（迁移刚把 `vault.dat` 改名走就是这个样子），把它搬成 `vault.dat` 等于
/// 毁掉用户的备份，紧接着调用方的回滚还会把这个“新文件”删掉，备份两头落空。
fn restore_from_bak(target: &Path, bak: &Path, rotated: bool) {
    if rotated && bak.exists() {
        let _ = fs::rename(bak, target);
    }
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

/// 把一份不再作为当前库的文件改名留档：`vault.dat.moved-<tag>`。
///
/// 为什么是改名而不是删除或原地不动：
/// - 原地不动，那个目录下次仍会被当成有效位置，切回去就会静默打开一份旧数据；
/// - 直接删掉，搬错地方就没有回头路。
///
/// 源文件不存在时返回 `None`（首次运行时把空库搬到别处是合法操作）。
pub fn retire_in(dir: &Path, name: &str, tag: &str) -> AppResult<Option<PathBuf>> {
    let source = dir.join(name);
    if !source.exists() {
        return Ok(None);
    }

    // 同一秒内连续迁移两次不能互相覆盖留档：加序号，最多试一百次
    let mut target = dir.join(format!("{name}.moved-{tag}"));
    let mut index = 1;
    while target.exists() {
        index += 1;
        if index > 100 {
            return Err(AppError::new(
                "io",
                format!("无法给 {} 留档：同名文件太多了。", source.display()),
            ));
        }
        target = dir.join(format!("{name}.moved-{tag}-{index}"));
    }

    fs::rename(&source, &target)
        .map_err(|err| AppError::new("io", format!("无法改名 {}：{err}", source.display())))?;
    Ok(Some(target))
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

    #[test]
    fn 留档把文件改名并返回新路径() {
        let dir = temp_dir("retire");
        write_atomic_in(&dir, VAULT_NAME, b"payload").unwrap();

        let retired = retire_in(&dir, VAULT_NAME, "20261113-210000")
            .unwrap()
            .expect("应生成留档");

        assert!(!dir.join(VAULT_NAME).exists(), "原名文件不该留下");
        assert_eq!(retired.file_name().unwrap(), "vault.dat.moved-20261113-210000");
        assert_eq!(fs::read(&retired).unwrap(), b"payload");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 同名的留档不会被覆盖() {
        let dir = temp_dir("retire-collide");
        write_atomic_in(&dir, VAULT_NAME, b"first").unwrap();
        let first = retire_in(&dir, VAULT_NAME, "same-tag").unwrap().unwrap();

        write_atomic_in(&dir, VAULT_NAME, b"second").unwrap();
        let second = retire_in(&dir, VAULT_NAME, "same-tag").unwrap().unwrap();

        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), b"first");
        assert_eq!(fs::read(&second).unwrap(), b"second");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 没有源文件时留档返回_none() {
        let dir = temp_dir("retire-missing");
        assert!(retire_in(&dir, VAULT_NAME, "tag").unwrap().is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 没有轮换过就不认领目录里原有的_bak() {
        let dir = temp_dir("foreign-bak");
        let target = dir.join(VAULT_NAME);
        let bak = dir.join(format!("{VAULT_NAME}.bak"));
        // 只有一份别人的 .bak，没有 vault.dat（迁移刚把库改名走就是这个样子）
        fs::write(&bak, b"someone-elses-backup").unwrap();

        // 这次调用没有轮换出 .bak，所以不能认领它
        restore_from_bak(&target, &bak, false);
        assert!(!target.exists(), "不能把别人的 .bak 搬成 vault.dat");
        assert_eq!(fs::read(&bak).unwrap(), b"someone-elses-backup");

        // 反过来：真是自己轮换出来的，就必须搬回去
        restore_from_bak(&target, &bak, true);
        assert_eq!(fs::read(&target).unwrap(), b"someone-elses-backup");
        assert!(!bak.exists());

        fs::remove_dir_all(&dir).ok();
    }
}
