//! 测试用的临时目录。
//!
//! 不用 `std::env::temp_dir()`：这台机器的系统临时目录对进程不可写（Access denied），
//! 测试会整片失败。放在 workspace 的 `target/test-tmp/` 下，既不进版本库也一定可写。

use std::path::PathBuf;

pub fn scratch_dir(tag: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let dir = target_dir()
        .join("test-tmp")
        .join(format!("{tag}-{}-{unique}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("创建测试目录失败");
    dir
}

/// 从当前测试二进制的位置往上找 `target` 目录。
/// 目录布局可能是 `target/debug/deps/xxx.exe`，也可能是 `target/debug/passlet-cli.exe`。
fn target_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let mut current = exe.as_path();
    while let Some(parent) = current.parent() {
        if let Some(name) = current.file_name() {
            if name == "debug" || name == "release" {
                return parent.to_path_buf();
            }
        }
        current = parent;
    }
    PathBuf::from("target")
}
