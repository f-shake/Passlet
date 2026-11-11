//! Passlet 的核心逻辑：加密、存储、条目模型、配置、主密码来源。
//!
//! 这里不依赖 Tauri、不碰窗口，因此 GUI 和命令行两个前端都能复用它，
//! 命令行产物也就不会把整个 WebView2 栈一起链接进去。

pub mod config;
pub mod crypto;
pub mod error;
pub mod generators;
pub mod master;
pub mod paths;
pub mod scratch;
pub mod storage;
pub mod store;
pub mod vault;

pub use error::{AppError, AppResult};

/// 数据文件名，GUI 与 CLI 都用这一个常量。
pub use storage::VAULT_NAME;
