//! 条目模型与业务规则：校验、唯一性、增删改、三种合并方式。
//!
//! 这一层不碰密钥、不碰文件，纯粹对内存里的结构做操作，因此可以直接单测。

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const MAX_TEXT_CHARS: usize = 200;
const MAX_PASSWORD_CHARS: usize = 1024;

/// 比较"是不是同一个平台/用户名"时用：去空格 + 忽略大小写。
/// 保存时仍保留用户输入的原始写法，只是判重不看大小写。
pub fn normalize_key(value: &str) -> String {
    value.trim().to_lowercase()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub platform: String,
    pub username: String,
    pub password: String,
    pub created_at: String,
}

/// 给前端列表用的轻量结构：不含密码。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryMeta {
    pub id: String,
    pub platform: String,
    pub username: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Vault {
    pub version: u32,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMode {
    Replace,
    Skip,
    Overwrite,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeStats {
    pub added: usize,
    pub skipped: usize,
    pub replaced: usize,
}

impl Default for Vault {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
        }
    }
}

pub fn new_id() -> String {
    let bytes: [u8; 16] = crate::crypto::random_bytes();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn check_label(field: &str, value: &str) -> AppResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::new(
            "invalid",
            "平台、用户名、密码都要填。".to_string(),
        ));
    }
    if trimmed.chars().count() > MAX_TEXT_CHARS {
        return Err(AppError::new(
            "invalid",
            format!("{field}最多 {MAX_TEXT_CHARS} 字。"),
        ));
    }
    Ok(trimmed.to_string())
}

fn check_password(value: &str) -> AppResult<String> {
    // 密码不 trim：首尾空格可能真的是密码的一部分。
    if value.is_empty() {
        return Err(AppError::new("invalid", "平台、用户名、密码都要填。"));
    }
    if value.chars().count() > MAX_PASSWORD_CHARS {
        return Err(AppError::new(
            "invalid",
            format!("密码最多 {MAX_PASSWORD_CHARS} 字。"),
        ));
    }
    Ok(value.to_string())
}

impl Vault {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn validate(&self) -> AppResult<()> {
        if self.version > 1 {
            return Err(AppError::new(
                "version",
                "数据文件版本比当前程序新，请升级 Passlet。",
            ));
        }
        Ok(())
    }

    pub fn metas(&self) -> Vec<EntryMeta> {
        self.entries
            .iter()
            .map(|entry| EntryMeta {
                id: entry.id.clone(),
                platform: entry.platform.clone(),
                username: entry.username.clone(),
            })
            .collect()
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn find_by_key(&self, platform: &str, username: &str, skip_id: Option<&str>) -> Option<usize> {
        let p = normalize_key(platform);
        let u = normalize_key(username);
        self.entries.iter().position(|entry| {
            Some(entry.id.as_str()) != skip_id
                && normalize_key(&entry.platform) == p
                && normalize_key(&entry.username) == u
        })
    }

    pub fn add(&mut self, platform: &str, username: &str, password: &str) -> AppResult<Entry> {
        let platform = check_label("平台", platform)?;
        let username = check_label("用户名", username)?;
        let password = check_password(password)?;

        if self.find_by_key(&platform, &username, None).is_some() {
            return Err(AppError::new(
                "duplicate",
                "这个平台下已经有同名用户名了。",
            ));
        }

        let entry = Entry {
            id: new_id(),
            platform,
            username,
            password,
            created_at: now_rfc3339(),
        };
        // 新条目放最前面：用户刚记完就想看到它。
        self.entries.insert(0, entry.clone());
        Ok(entry)
    }

    pub fn update(
        &mut self,
        id: &str,
        platform: &str,
        username: &str,
        password: &str,
    ) -> AppResult<Entry> {
        let platform = check_label("平台", platform)?;
        let username = check_label("用户名", username)?;
        let password = check_password(password)?;

        if self.find_by_key(&platform, &username, Some(id)).is_some() {
            return Err(AppError::new(
                "duplicate",
                "这个平台下已经有同名用户名了。",
            ));
        }

        let entry = self
            .entries
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| {
                AppError::new("not_found", "这条记录已经不在了，可能被删掉了。")
            })?;

        entry.platform = platform;
        entry.username = username;
        entry.password = password;
        Ok(entry.clone())
    }

    pub fn remove(&mut self, id: &str) -> AppResult<()> {
        let before = self.entries.len();
        self.entries.retain(|entry| entry.id != id);
        if self.entries.len() == before {
            return Err(AppError::new(
                "not_found",
                "这条记录已经不在了，可能被删掉了。",
            ));
        }
        Ok(())
    }

    /// 把 `other` 合并进来。Replace 由调用方负责先备份，这里只做内存替换。
    pub fn merge_from(&mut self, other: &Vault, mode: MergeMode) -> MergeStats {
        let mut stats = MergeStats {
            added: 0,
            skipped: 0,
            replaced: 0,
        };

        if mode == MergeMode::Replace {
            let mut incoming = other.entries.clone();
            for entry in incoming.iter_mut() {
                entry.id = new_id();
            }
            stats.added = incoming.len();
            self.entries = incoming;
            return stats;
        }

        for source in &other.entries {
            match self.find_by_key(&source.platform, &source.username, None) {
                Some(index) => {
                    if mode == MergeMode::Overwrite {
                        // 覆盖只换密码：平台与用户名的写法以现有条目为准，避免同一条记录出现两种拼写。
                        self.entries[index].password = source.password.clone();
                        stats.replaced += 1;
                    } else {
                        stats.skipped += 1;
                    }
                }
                None => {
                    let mut copy = source.clone();
                    // 导入文件里的 id 可能与本库撞车，统一重发。
                    copy.id = new_id();
                    self.entries.push(copy);
                    stats.added += 1;
                }
            }
        }
        stats
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with(items: &[(&str, &str, &str)]) -> Vault {
        let mut vault = Vault::new();
        for (platform, username, password) in items {
            vault.add(platform, username, password).unwrap();
        }
        vault
    }

    #[test]
    fn 新增会去掉首尾空格但保留密码原样() {
        let mut vault = Vault::new();
        let entry = vault.add("  GitHub  ", " me@example.com ", "  pass  ").unwrap();
        assert_eq!(entry.platform, "GitHub");
        assert_eq!(entry.username, "me@example.com");
        assert_eq!(entry.password, "  pass  ");
        assert_eq!(entry.id.len(), 32);
    }

    #[test]
    fn 新条目排在列表最前面() {
        let vault = vault_with(&[("A", "u1", "p"), ("B", "u2", "p")]);
        assert_eq!(vault.entries[0].platform, "B");
    }

    #[test]
    fn 三个字段有空值时报_invalid() {
        let mut vault = Vault::new();
        assert_eq!(vault.add("", "u", "p").unwrap_err().code, "invalid");
        assert_eq!(vault.add("p", "  ", "p").unwrap_err().code, "invalid");
        assert_eq!(vault.add("p", "u", "").unwrap_err().code, "invalid");
    }

    #[test]
    fn 平台或用户名超长被拒绝() {
        let mut vault = Vault::new();
        let long = "a".repeat(201);
        assert_eq!(vault.add(&long, "u", "p").unwrap_err().code, "invalid");
        assert_eq!(vault.add("p", &long, "p").unwrap_err().code, "invalid");
    }

    #[test]
    fn 密码超长被拒绝但允许一千零二十四字() {
        let mut vault = Vault::new();
        let ok = "a".repeat(1024);
        assert!(vault.add("p", "u", &ok).is_ok());

        let too_long = "a".repeat(1025);
        assert_eq!(vault.add("p2", "u", &too_long).unwrap_err().code, "invalid");
    }

    #[test]
    fn 同平台同名用户名即使大小写不同也算重复() {
        let mut vault = vault_with(&[("GitHub", "me@example.com", "p")]);
        let err = vault.add("github", "ME@example.com", "p2").unwrap_err();
        assert_eq!(err.code, "duplicate");
        assert_eq!(vault.entries.len(), 1);
    }

    #[test]
    fn 不同平台可以有同名用户名() {
        let mut vault = vault_with(&[("GitHub", "me", "p")]);
        assert!(vault.add("Gitee", "me", "p2").is_ok());
        assert_eq!(vault.entries.len(), 2);
    }

    #[test]
    fn 编辑保留原_id_与创建时间() {
        let mut vault = vault_with(&[("GitHub", "me", "old")]);
        let id = vault.entries[0].id.clone();
        let created = vault.entries[0].created_at.clone();

        let updated = vault.update(&id, "GitHub", "me", "new").unwrap();
        assert_eq!(updated.id, id);
        assert_eq!(updated.created_at, created);
        assert_eq!(updated.password, "new");
    }

    #[test]
    fn 编辑时撞到别的条目报_duplicate() {
        let mut vault = vault_with(&[("GitHub", "a", "p"), ("GitHub", "b", "p")]);
        let id_b = vault.entries[0].id.clone();
        let err = vault.update(&id_b, "GitHub", "a", "p").unwrap_err();
        assert_eq!(err.code, "duplicate");
    }

    #[test]
    fn 编辑不存在的_id_报_not_found() {
        let mut vault = Vault::new();
        assert_eq!(
            vault.update("nope", "p", "u", "p").unwrap_err().code,
            "not_found"
        );
    }

    #[test]
    fn 删除后条目消失且再删报_not_found() {
        let mut vault = vault_with(&[("GitHub", "me", "p")]);
        let id = vault.entries[0].id.clone();
        vault.remove(&id).unwrap();
        assert!(vault.entries.is_empty());
        assert_eq!(vault.remove(&id).unwrap_err().code, "not_found");
    }

    #[test]
    fn 合并_跳过重复_只追加新条目() {
        let mut base = vault_with(&[("GitHub", "me", "old")]);
        let incoming = vault_with(&[("GitHub", "me", "new"), ("Gitee", "me", "x")]);

        let stats = base.merge_from(&incoming, MergeMode::Skip);
        assert_eq!(stats.added, 1);
        assert_eq!(stats.skipped, 1);
        assert_eq!(stats.replaced, 0);
        assert_eq!(base.entries.len(), 2);
        // 被跳过的条目保持原值
        assert!(base.entries.iter().any(|e| e.platform == "GitHub" && e.password == "old"));
    }

    #[test]
    fn 合并_覆盖重复_替换密码并追加新条目() {
        let mut base = vault_with(&[("GitHub", "me", "old")]);
        let incoming = vault_with(&[("GitHub", "me", "new"), ("Gitee", "me", "x")]);

        let stats = base.merge_from(&incoming, MergeMode::Overwrite);
        assert_eq!(stats.added, 1);
        assert_eq!(stats.skipped, 0);
        assert_eq!(stats.replaced, 1);
        assert!(base.entries.iter().any(|e| e.platform == "GitHub" && e.password == "new"));
    }

    #[test]
    fn 合并_整库替换_丢弃原有条目并重发_id() {
        let mut base = vault_with(&[("GitHub", "me", "old")]);
        let incoming = vault_with(&[("Gitee", "me", "x")]);
        let old_id = incoming.entries[0].id.clone();

        let stats = base.merge_from(&incoming, MergeMode::Replace);
        assert_eq!(stats.added, 1);
        assert_eq!(base.entries.len(), 1);
        assert_eq!(base.entries[0].platform, "Gitee");
        // id 必须重发，避免与旧库里的 id 撞车
        assert_ne!(base.entries[0].id, old_id);
    }

    #[test]
    fn 版本号更高时_validate_报_version() {
        let mut vault = Vault::new();
        vault.version = 2;
        assert_eq!(vault.validate().unwrap_err().code, "version");
    }

    #[test]
    fn 序列化字段名是驼峰() {
        let mut vault = Vault::new();
        let entry = vault.add("p", "u", "pw").unwrap();
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"createdAt\""));
    }

    #[test]
    fn merge_mode_反序列化() {
        let mode: MergeMode = serde_json::from_str("\"skip\"").unwrap();
        assert_eq!(mode, MergeMode::Skip);
        let mode: MergeMode = serde_json::from_str("\"overwrite\"").unwrap();
        assert_eq!(mode, MergeMode::Overwrite);
        let mode: MergeMode = serde_json::from_str("\"replace\"").unwrap();
        assert_eq!(mode, MergeMode::Replace);
    }
}
