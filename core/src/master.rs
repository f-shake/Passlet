//! 主密码的来源。
//!
//! 顺序：进程环境变量 → Windows 用户级注册表 → 机器级注册表。
//!
//! 为什么要读注册表：`setx` 只改注册表，**不会更新已经在运行的进程的环境块**。
//! 少了这一步，运行中的程序点"重新读取"永远读不到刚设置的值，只能关掉重开。

use crate::error::{AppError, AppResult};

pub const ENV_NAME: &str = "PASSLET_MASTER";

pub const MISSING_MESSAGE: &str =
    "没有读到主密码：环境变量 PASSLET_MASTER 未设置。设置方法见 README 的“第一次使用”一节。";

pub fn read() -> AppResult<String> {
    if let Ok(value) = std::env::var(ENV_NAME) {
        if !value.is_empty() {
            return Ok(value);
        }
    }

    #[cfg(windows)]
    if let Some(value) = read_from_registry() {
        return Ok(value);
    }

    Err(AppError::new("env_missing", MISSING_MESSAGE))
}

/// 主密码当前来自哪里："env" / "user-registry" / "machine-registry" / "none"
pub fn source() -> &'static str {
    if std::env::var(ENV_NAME).map(|value| !value.is_empty()).unwrap_or(false) {
        return "env";
    }
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        let non_empty = |value: Option<String>| value.filter(|text| !text.is_empty());
        if non_empty(
            RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey_with_flags("Environment", KEY_READ)
                .ok()
                .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok()),
        )
        .is_some()
        {
            return "user-registry";
        }
        if non_empty(
            RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey_with_flags(
                    r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                    KEY_READ,
                )
                .ok()
                .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok()),
        )
        .is_some()
        {
            return "machine-registry";
        }
    }
    "none"
}

#[cfg(windows)]
fn read_from_registry() -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let machine_environment = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

    let user = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags("Environment", KEY_READ)
        .ok()
        .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok());
    if let Some(value) = user.filter(|value| !value.is_empty()) {
        return Some(value);
    }

    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(machine_environment, KEY_READ)
        .ok()
        .and_then(|key| key.get_value::<String, _>(ENV_NAME).ok())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 进程环境变量优先于注册表() {
        // 注册表里已经有值（用户手工设过），这里验证进程环境变量能盖过它
        std::env::set_var(ENV_NAME, "from-process-env");
        assert_eq!(read().unwrap(), "from-process-env");
        std::env::remove_var(ENV_NAME);
    }

    #[test]
    fn 空字符串视为没有设置() {
        std::env::set_var(ENV_NAME, "");
        let result = read();
        std::env::remove_var(ENV_NAME);
        // 注册表里可能真有值（开发机上设过），所以只断言"不能返回空串"
        if let Ok(value) = result {
            assert!(!value.is_empty());
        }
    }
}
