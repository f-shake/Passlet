use std::sync::Mutex;

use passlet_core::crypto::{Key, SALT_LEN};
use passlet_core::vault::Vault;

/// 一次解锁会话：派生出的密钥、盐（写盘要继续用）、内存里的库。
/// 离开清单即丢弃，[`Key`] 是 `Zeroizing`，drop 时自动清零。
pub struct Session {
    pub key: Key,
    pub salt: [u8; SALT_LEN],
    pub vault: Vault,
}

#[derive(Default)]
pub struct AppState {
    pub session: Mutex<Option<Session>>,
    /// 剪贴板清空任务的序号：再次复制会自增，旧任务发现序号变了就放弃清空。
    pub clipboard_seq: Mutex<u64>,
}

// 手写 Debug 而不是 derive：密钥绝不能因为一行日志或一个 unwrap 报错被打印出来。
impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("entries", &self.vault.entries.len())
            .field("key", &"<redacted>")
            .finish()
    }
}