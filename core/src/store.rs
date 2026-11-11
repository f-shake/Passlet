//! 库文件的读写编排：读主密码 → 派生 → 解密；加密 → 原子写。GUI 与 CLI 共用这一层，
//! 保证两个入口对"数据文件长什么样"的理解不会分叉。

use std::path::Path;


use crate::crypto::{self, Key, SALT_LEN};
use crate::error::{AppError, AppResult};
use crate::storage;
use crate::vault::Vault;

pub type Opened = (Key, [u8; SALT_LEN], Vault);

/// 打开指定目录下的库。文件不存在时返回空库（首次运行），不创建任何文件。
pub fn open_in(dir: &Path, master: &str) -> AppResult<Opened> {
    match storage::read_in(dir, storage::VAULT_NAME)? {
        None => {
            let salt = crypto::new_salt();
            let key = crypto::derive_key(master, &salt)?;
            Ok((key, salt, Vault::new()))
        }
        Some(bytes) => {
            let container = crypto::decode(&bytes)?;
            let key = crypto::derive_key(master, &container.salt)?;
            let plaintext = crypto::decrypt(&key, &container.nonce, container.ciphertext)?;
            let vault: Vault = serde_json::from_slice(&plaintext)?;
            vault.validate()?;
            Ok((key, container.salt, vault))
        }
    }
}

/// 用给定密钥加密并原子写盘。写入失败时抛错，调用方负责回滚内存状态。
pub fn persist_in(dir: &Path, key: &Key, salt: &[u8; SALT_LEN], vault: &Vault) -> AppResult<()> {
    let bytes = seal(key, salt, vault)?;
    storage::write_atomic_in(dir, storage::VAULT_NAME, &bytes)
}

/// 生成导出用的字节（与 `vault.dat` 完全同构）。
pub fn seal(key: &Key, salt: &[u8; SALT_LEN], vault: &Vault) -> AppResult<Vec<u8>> {
    let json = serde_json::to_vec(vault)?;
    let (nonce, ciphertext) = crypto::encrypt(key, &json)?;
    Ok(crypto::encode(salt, &nonce, &ciphertext))
}

/// 解开一份备份文件。备份可能用了另一套盐，所以必须重新派生。
pub fn unseal(bytes: &[u8], master: &str) -> AppResult<Vault> {
    let container = crypto::decode(bytes)?;
    let key = crypto::derive_key(master, &container.salt)?;
    let plaintext = crypto::decrypt(&key, &container.nonce, container.ciphertext)?;
    let vault: Vault = serde_json::from_slice(&plaintext)?;
    vault.validate()?;
    Ok(vault)
}

/// 解不开备份时给用户看的那句话。GUI 与 CLI 共用，免得两处文案各走各的。
pub const BACKUP_DECRYPT_MESSAGE: &str = "这个密码解不开这份备份；文件也可能已损坏。";

/// 解开备份文件，并把“密码不对”统一成 [`BACKUP_DECRYPT_MESSAGE`]。
/// 只改这一个错误码：corrupt / version 是文件本身的问题，原样往上抛才对。
pub fn unseal_backup(bytes: &[u8], password: &str) -> AppResult<Vault> {
    unseal(bytes, password).map_err(|err| {
        if err.code == "decrypt_failed" {
            AppError::new("decrypt_failed", BACKUP_DECRYPT_MESSAGE)
        } else {
            err
        }
    })
}

/// 换主密码：生成新盐、新密钥，返回可直接写盘的新材料。
pub fn rotate(master: &str, vault: &Vault) -> AppResult<(Key, [u8; SALT_LEN], Vec<u8>)> {
    if master.chars().count() < 8 {
        return Err(AppError::new("invalid", "新主密码至少 8 位。"));
    }
    let salt = crypto::new_salt();
    let key = crypto::derive_key(master, &salt)?;
    let bytes = seal(&key, &salt, vault)?;
    Ok((key, salt, bytes))
}

/// 备份密码的规则。它与主密码分开，但同样是这份文件唯一的凭据，所以不许太短。
pub fn validate_backup_password(password: &str) -> AppResult<()> {
    if password.trim().is_empty() {
        return Err(AppError::new("invalid", "备份密码不能为空。"));
    }
    if password.chars().count() < 8 {
        return Err(AppError::new("invalid", "备份密码至少 8 位。"));
    }
    Ok(())
}

/// 用调用方给的密码封包（导出备份用），每次新盐。
/// 与 [`seal`] 的差别只在密钥从哪来：这里由备份密码派生，因此备份与主密码解耦，
/// 换主密码不会让已导出的备份作废，把备份交给别人也不必交出主密码。
pub fn seal_with_password(password: &str, vault: &Vault) -> AppResult<Vec<u8>> {
    validate_backup_password(password)?;
    let salt = crypto::new_salt();
    let key = crypto::derive_key(password, &salt)?;
    seal(&key, &salt, vault)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch;

    const MASTER: &str = "correct horse battery staple";

    fn vault_with(items: &[(&str, &str, &str)]) -> Vault {
        let mut vault = Vault::new();
        for (platform, username, password) in items {
            vault.add(platform, username, password).unwrap();
        }
        vault
    }

    #[test]
    fn 首次打开返回空库且不创建文件() {
        let dir = scratch::scratch_dir("store-empty");
        let (_, _, vault) = open_in(&dir, MASTER).unwrap();
        assert!(vault.entries.is_empty());
        assert!(!dir.join(storage::VAULT_NAME).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 存盘后能用同一主密码读回() {
        let dir = scratch::scratch_dir("store-roundtrip");
        let vault = vault_with(&[("GitHub", "me", "p1"), ("阿里云", "autod", "p2")]);
        let (key, salt, _) = open_in(&dir, MASTER).unwrap();
        persist_in(&dir, &key, &salt, &vault).unwrap();

        let (_, _, reopened) = open_in(&dir, MASTER).unwrap();
        assert_eq!(reopened.entries.len(), 2);
        assert_eq!(reopened.entries[0].platform, "阿里云");

        assert_eq!(open_in(&dir, "wrong").unwrap_err().code, "decrypt_failed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 导出的字节能被同一主密码解开() {
        let dir = scratch::scratch_dir("store-seal");
        let vault = vault_with(&[("Gitee", "me", "x")]);
        let (key, salt, _) = open_in(&dir, MASTER).unwrap();
        let bytes = seal(&key, &salt, &vault).unwrap();

        let reopened = unseal(&bytes, MASTER).unwrap();
        assert_eq!(reopened.entries.len(), 1);
        assert_eq!(unseal(&bytes, "nope").unwrap_err().code, "decrypt_failed");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 换主密码后新密码可开旧密码不可开() {
        let vault = vault_with(&[("GitHub", "me", "p")]);
        let (new_key, new_salt, bytes) = rotate("a brand new master password", &vault).unwrap();
        assert!(unseal(&bytes, "a brand new master password").is_ok());
        assert_eq!(unseal(&bytes, MASTER).unwrap_err().code, "decrypt_failed");
        // rotate 返回的材料能直接写盘并读回
        let dir = scratch::scratch_dir("store-rotate");
        persist_in(&dir, &new_key, &new_salt, &vault).unwrap();
        assert!(open_in(&dir, "a brand new master password").is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 新主密码不足八位被拒绝() {
        let vault = Vault::new();
        assert_eq!(rotate("short", &vault).unwrap_err().code, "invalid");
    }

    #[test]
    fn 用备份密码封包的字节能被同一密码解开() {
        let vault = vault_with(&[("GitHub", "me", "p1"), ("NAS", "admin", "p2")]);
        let bytes = seal_with_password("backup-pw-2026", &vault).unwrap();

        let reopened = unseal(&bytes, "backup-pw-2026").unwrap();
        assert_eq!(reopened.entries.len(), 2);
        // 与主密码无关：主密码解不开这份备份
        assert_eq!(unseal(&bytes, MASTER).unwrap_err().code, "decrypt_failed");
    }

    #[test]
    fn 备份密码太短或全空白被拒绝() {
        let vault = Vault::new();
        for bad in ["", "   ", "short", "1234567"] {
            assert_eq!(
                seal_with_password(bad, &vault).unwrap_err().code,
                "invalid",
                "应当拒绝：{bad:?}"
            );
        }
        // 边界：正好 8 位放行
        assert!(seal_with_password("12345678", &vault).is_ok());
    }

    #[test]
    fn 同一份库两次导出得到不同的盐() {
        let vault = vault_with(&[("GitHub", "me", "p")]);
        let first = seal_with_password("backup-pw-2026", &vault).unwrap();
        let second = seal_with_password("backup-pw-2026", &vault).unwrap();
        // 盐复用会让两份密文相同，也让“同一个密码”更容易被批量比对
        assert_ne!(
            crypto::decode(&first).unwrap().salt,
            crypto::decode(&second).unwrap().salt
        );
    }

    #[test]
    fn 换主密码后已导出的备份照样能用原备份密码打开() {
        let vault = vault_with(&[("GitHub", "me", "p")]);
        let backup = seal_with_password("backup-pw-2026", &vault).unwrap();

        // 换主密码只影响库文件，备份里的盐与密钥跟主密码没有关系
        let (_, _, rotated) = rotate("a brand new master password", &vault).unwrap();
        assert!(unseal(&backup, "backup-pw-2026").is_ok());
        // 反过来：主密码换了之后，旧主密码也打不开新库
        assert_eq!(unseal(&rotated, MASTER).unwrap_err().code, "decrypt_failed");
    }
}
