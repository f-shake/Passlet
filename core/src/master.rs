//! 主密码的来源与写入。
//!
//! 读取顺序：进程环境变量 → Windows 用户级注册表 → 机器级注册表。
//!
//! 为什么要读注册表：`setx` 只改注册表，**不会更新已经在运行的进程的环境块**。
//! 少了这一步，运行中的程序点“重新读取”永远读不到刚设置的值，只能关掉重开。
//!
//! 写入只碰用户级（`HKCU`）：它属于当前账户，不需要管理员。机器级要提权，
//! 而且会影响到这台机器上的所有账户，不归本程序管。

use crate::error::{AppError, AppResult};

pub const ENV_NAME: &str = "PASSLET_MASTER";

pub const MISSING_MESSAGE: &str =
    "没有读到主密码：环境变量 PASSLET_MASTER 未设置。设置方法见 README 的“第一次使用”一节。";

#[cfg(windows)]
const USER_KEY: &str = "Environment";
#[cfg(windows)]
const MACHINE_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

/// 主密码当前从哪里来。`active` 与 [`read`] 的查找顺序一致。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MasterStatus {
    /// `"process"` / `"user"` / `"machine"` / `"none"`
    pub active: &'static str,
    /// 本进程环境块里有非空值
    pub process_env: bool,
    /// `HKCU\Environment` 里有非空值
    pub user_registry: bool,
    /// `HKLM\…\Environment` 里有非空值
    pub machine_registry: bool,
}

pub fn read() -> AppResult<String> {
    if let Ok(value) = std::env::var(ENV_NAME) {
        if !value.is_empty() {
            return Ok(value);
        }
    }

    if let Some(value) = read_from_registry() {
        return Ok(value);
    }

    Err(AppError::new("env_missing", MISSING_MESSAGE))
}

/// 主密码来源的三种展示口径（命令行 `doctor` 与界面共用）。
/// `"env"` / `"user-registry"` / `"machine-registry"` / `"none"`
pub fn source() -> &'static str {
    match status().active {
        "process" => "env",
        "user" => "user-registry",
        "machine" => "machine-registry",
        _ => "none",
    }
}

pub fn status() -> MasterStatus {
    let process_env = std::env::var(ENV_NAME)
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let (user_registry, machine_registry) = registry_presence();
    MasterStatus {
        active: active_kind(process_env, user_registry, machine_registry),
        process_env,
        user_registry,
        machine_registry,
    }
}

/// 查找顺序即优先级：本进程 > 用户级 > 机器级。
fn active_kind(process_env: bool, user_registry: bool, machine_registry: bool) -> &'static str {
    if process_env {
        "process"
    } else if user_registry {
        "user"
    } else if machine_registry {
        "machine"
    } else {
        "none"
    }
}

/// 把主密码写进用户级环境变量，并让本次运行立刻用它。
///
/// 写注册表不会更新本进程的环境块，所以这里补一次 `set_env`——
/// 少了它，“设置完还得重启程序”就成了必然，而用户刚输入的正是要生效的值。
pub fn write_user(value: &str) -> AppResult<()> {
    // 只拒绝空白：主密码可能确实很短，长度是“更换主密码”那条路的规则，不该套用在这里
    if value.trim().is_empty() {
        return Err(AppError::new("invalid", "主密码不能为空。"));
    }
    write_value(ENV_NAME, value)?;
    std::env::set_var(ENV_NAME, value);
    broadcast_change();
    Ok(())
}

/// 删除用户级环境变量。本来就没有也算成功——清除是幂等的。
pub fn clear_user() -> AppResult<()> {
    delete_value(ENV_NAME)?;
    std::env::remove_var(ENV_NAME);
    broadcast_change();
    Ok(())
}

#[cfg(windows)]
fn registry_presence() -> (bool, bool) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let present = |root: winreg::HKEY, subkey: &str| {
        RegKey::predef(root)
            .open_subkey_with_flags(subkey, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok())
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    };
    (
        present(HKEY_CURRENT_USER, USER_KEY),
        present(HKEY_LOCAL_MACHINE, MACHINE_KEY),
    )
}

#[cfg(not(windows))]
fn registry_presence() -> (bool, bool) {
    (false, false)
}

#[cfg(windows)]
fn read_from_registry() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let read = |root: winreg::HKEY, subkey: &str| {
        RegKey::predef(root)
            .open_subkey_with_flags(subkey, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok())
            .filter(|value| !value.is_empty())
    };
    read(HKEY_CURRENT_USER, USER_KEY).or_else(|| read(HKEY_LOCAL_MACHINE, MACHINE_KEY))
}

#[cfg(not(windows))]
fn read_from_registry() -> Option<String> {
    None
}

#[cfg(windows)]
fn write_value(name: &str, value: &str) -> AppResult<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    let hint = "可以改用 scripts/set-user-env.ps1";
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(USER_KEY, KEY_SET_VALUE)
        .map_err(|err| {
            AppError::new(
                "io",
                format!("写入失败：打不开用户环境变量。（{err}）{hint}。"),
            )
        })?;
    key.set_value(name, &value.to_string()).map_err(|err| {
        AppError::new(
            "io",
            format!("写入失败：系统不允许修改用户环境变量。（{err}）{hint}。"),
        )
    })
}

#[cfg(not(windows))]
fn write_value(_name: &str, _value: &str) -> AppResult<()> {
    Err(AppError::new(
        "unsupported",
        "设置环境变量目前只在 Windows 上实现。",
    ))
}

#[cfg(windows)]
fn delete_value(name: &str) -> AppResult<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(USER_KEY, KEY_SET_VALUE)
        .map_err(|err| {
            AppError::new(
                "io",
                format!("清除失败：打不开用户环境变量。（{err}）"),
            )
        })?;
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        // 本来就没有这个值：清除是幂等的，不该报错
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::new(
            "io",
            format!("清除失败：系统不允许修改用户环境变量。（{err}）"),
        )),
    }
}

#[cfg(not(windows))]
fn delete_value(_name: &str) -> AppResult<()> {
    Err(AppError::new(
        "unsupported",
        "清除环境变量目前只在 Windows 上实现。",
    ))
}

/// 通知系统环境变量变了。不广播的话 Explorer 仍用启动时缓存的环境块，
/// 新开的终端读不到这个值（本程序自己不受影响，它读注册表）。
/// 纯属尽力而为：送不出去也不影响写入本身，所以不回报结果。
fn broadcast_change() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };

        let text: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result: usize = 0;
        // SAFETY: 字符串在本函数内有效且以 NUL 结尾；超时 5 秒，避免被卡死的窗口拖住
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                text.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 查找顺序是进程大于用户级大于机器级() {
        assert_eq!(active_kind(true, true, true), "process");
        assert_eq!(active_kind(false, true, true), "user");
        assert_eq!(active_kind(false, false, true), "machine");
        assert_eq!(active_kind(false, false, false), "none");
    }

    #[test]
    fn 进程环境变量优先于注册表() {
        let previous = std::env::var(ENV_NAME).ok();
        std::env::set_var(ENV_NAME, "from-process-env");
        assert_eq!(read().unwrap(), "from-process-env");
        restore(previous);
    }

    #[test]
    fn 空字符串视为没有设置() {
        let previous = std::env::var(ENV_NAME).ok();
        std::env::set_var(ENV_NAME, "");
        let result = read();
        // 注册表里可能真有值（开发机上设过），所以只断言“不能返回空串”
        if let Ok(value) = result {
            assert!(!value.is_empty());
        }
        restore(previous);
    }

    #[test]
    fn 设了进程环境变量时_status_报告_process() {
        let previous = std::env::var(ENV_NAME).ok();
        std::env::set_var(ENV_NAME, "from-process-env");
        let status = status();
        assert_eq!(status.active, "process");
        assert!(status.process_env);
        restore(previous);
    }

    #[test]
    fn 空白主密码被拒绝() {
        for bad in ["", " ", "\t\n"] {
            let err = write_user(bad).unwrap_err();
            assert_eq!(err.code, "invalid");
        }
    }

    /// 测试不能碰真实的 `PASSLET_MASTER`——写在开发机的值上一旦删错，库就打不开了。
    /// 改用带进程号与纳秒的唯一值名写同一个键，`Drop` 时删掉。
    #[cfg(windows)]
    struct TempValue(String);

    #[cfg(windows)]
    impl TempValue {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(format!("PASSLET_TEST_{}_{nanos}", std::process::id()))
        }
    }

    #[cfg(windows)]
    impl Drop for TempValue {
        fn drop(&mut self) {
            let _ = delete_value(&self.0);
        }
    }

    #[cfg(windows)]
    fn read_value(name: &str) -> Option<String> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(USER_KEY, KEY_READ)
            .ok()
            .and_then(|key| key.get_value::<String, _>(name).ok())
    }

    /// 在 DSH 沙箱里构建出的二进制是“低完整性”（继承了工作区目录的完整性标签），
    /// 那里写 `HKCU` 一律被拒。这时不把用例判失败，而是显式跳过并打印原因；
    /// 真正写注册表那条路径由端到端验证覆盖——把 exe 拷到 `C:\Running` 下运行即可。
    #[cfg(windows)]
    fn can_write_registry() -> bool {
        write_value(&TempValue::new().0, "probe").is_ok()
    }

    #[test]
    #[cfg(windows)]
    fn 写入后能原样读回包括引号和百分号() {
        if !can_write_registry() {
            eprintln!("跳过：当前进程写不了注册表（工作区构建的二进制是低完整性）");
            return;
        }
        let temp = TempValue::new();
        // 这些字符走 setx 会被引号与百分号展开坑到，直写注册表必须原样保留
        let value = " a b\"c%d!e 中文 ";
        write_value(&temp.0, value).unwrap();
        assert_eq!(read_value(&temp.0).as_deref(), Some(value));
    }

    #[test]
    #[cfg(windows)]
    fn 删除后读不到而且重复删除不报错() {
        if !can_write_registry() {
            eprintln!("跳过：当前进程写不了注册表（工作区构建的二进制是低完整性）");
            return;
        }
        let temp = TempValue::new();
        write_value(&temp.0, "x").unwrap();
        delete_value(&temp.0).unwrap();
        assert_eq!(read_value(&temp.0), None);
        // 第二次删除：本来就没有，仍然算成功
        delete_value(&temp.0).unwrap();
    }

    #[test]
    fn 广播调用不会崩溃() {
        broadcast_change();
    }

    fn restore(previous: Option<String>) {
        match previous {
            Some(value) => std::env::set_var(ENV_NAME, value),
            None => std::env::remove_var(ENV_NAME),
        }
    }
}
