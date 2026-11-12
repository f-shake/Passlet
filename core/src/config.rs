//! 明文配置（`config.json`）。里面没有秘密，所以不加密：
//! 出问题时能直接打开看，也方便排障。

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::paths;

pub const CONFIG_NAME: &str = "config.json";
pub const DEFAULT_QUERY: [u32; 2] = [462, 214];
/// 上一版的查询页默认高度。内容只占约 203，272 会让“打开清单”上方空出 70px。
const LEGACY_QUERY: [u32; 2] = [462, 272];
pub const DEFAULT_LIST: [u32; 2] = [840, 474];
pub const DEFAULT_SETTINGS: [u32; 2] = [620, 560];
pub const DEFAULT_GENERATOR: [u32; 2] = [462, 380];
/// 错误页：内容比查询页高，尺寸不跟随查询页
pub const DEFAULT_ERROR: [u32; 2] = [462, 272];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSizes {
    pub query: [u32; 2],
    pub list: [u32; 2],
    pub settings: [u32; 2],
    /// 后面才加的字段：老 config.json 里没有它。
    /// 缺字段时只补这一项默认值，不能让整份配置回落默认——否则主题、剪贴板设置会被一起重置。
    #[serde(default = "default_generator_size")]
    pub generator: [u32; 2],
}

fn default_generator_size() -> [u32; 2] {
    DEFAULT_GENERATOR
}

impl Default for WindowSizes {
    fn default() -> Self {
        Self {
            query: DEFAULT_QUERY,
            list: DEFAULT_LIST,
            settings: DEFAULT_SETTINGS,
            generator: DEFAULT_GENERATOR,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub version: u32,
    /// "system" | "light" | "dark"
    pub theme: String,
    pub clipboard_clear_enabled: bool,
    pub clipboard_clear_seconds: u32,
    pub hide_password_seconds: u32,
    pub window_sizes: WindowSizes,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            version: 1,
            theme: "system".to_string(),
            clipboard_clear_enabled: true,
            clipboard_clear_seconds: 30,
            hide_password_seconds: 30,
            window_sizes: WindowSizes::default(),
        }
    }
}

fn clamp_seconds(value: u32, min: u32, max: u32, fallback: u32) -> u32 {
    if value < min || value > max {
        fallback
    } else {
        value
    }
}

fn clamp_size(size: [u32; 2], fallback: [u32; 2]) -> [u32; 2] {
    let [w, h] = size;
    if !(300..=4000).contains(&w) || !(200..=3000).contains(&h) {
        fallback
    } else {
        size
    }
}

impl Config {
    /// 把越界值拉回默认值。配置被手改坏时不能让窗口变成 0×0，也不能让清空间隔变 0 秒。
    pub fn sanitized(mut self) -> Self {
        if self.theme != "system" && self.theme != "light" && self.theme != "dark" {
            self.theme = "system".to_string();
        }
        self.clipboard_clear_seconds = clamp_seconds(self.clipboard_clear_seconds, 1, 600, 30);
        self.hide_password_seconds = clamp_seconds(self.hide_password_seconds, 0, 600, 30);
        self.window_sizes.query = clamp_size(self.window_sizes.query, DEFAULT_QUERY);
        self.window_sizes.list = clamp_size(self.window_sizes.list, DEFAULT_LIST);
        self.window_sizes.settings = clamp_size(self.window_sizes.settings, DEFAULT_SETTINGS);
        self.window_sizes.generator = clamp_size(self.window_sizes.generator, DEFAULT_GENERATOR);
        self.version = 1;
        self
    }
}

/// 读配置。文件不存在或内容坏了都回落默认值；
/// 坏文件会被覆盖写回，避免每次启动都读一次坏 JSON。
pub fn load_in(dir: &std::path::Path) -> Config {
    let path = dir.join(CONFIG_NAME);
    let raw = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Config::default(),
    };
    match serde_json::from_str::<Config>(&raw) {
        // 老版本写出的配置里一定没有 windowSizes.generator；只有那种文件才做一次
        // “旧默认高度 → 新默认高度”的升级，新版本写出的 272 视为用户自己的选择。
        Ok(config) => {
            let legacy_file = !raw.contains("\"generator\"");
            let mut config = config;
            if legacy_file && config.window_sizes.query == LEGACY_QUERY {
                config.window_sizes.query = DEFAULT_QUERY;
            }
            config.sanitized()
        }
        Err(_) => {
            let fallback = Config::default();
            let _ = save_in(dir, &fallback);
            fallback
        }
    }
}

pub fn save_in(dir: &std::path::Path, config: &Config) -> AppResult<()> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(&config.clone().sanitized())?;
    std::fs::write(dir.join(CONFIG_NAME), text)?;
    Ok(())
}

pub fn load() -> Config {
    match paths::data_dir() {
        Ok(dir) => load_in(&dir),
        Err(_) => Config::default(),
    }
}

pub fn save(config: &Config) -> AppResult<Config> {
    let dir = paths::ensure_data_dir()?;
    let sanitized = config.clone().sanitized();
    save_in(&dir, &sanitized)?;
    Ok(sanitized)
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        crate::scratch::scratch_dir(&format!("config-{tag}"))
    }

    #[test]
    fn 默认值符合约定() {
        let config = Config::default();
        assert_eq!(config.theme, "system");
        assert_eq!(config.clipboard_clear_seconds, 30);
        assert_eq!(config.hide_password_seconds, 30);
        assert_eq!(config.window_sizes.query, [462, 214]);
        assert_eq!(config.window_sizes.list, [840, 474]);
        assert_eq!(config.window_sizes.settings, [620, 560]);
        assert_eq!(config.window_sizes.generator, [462, 380]);
    }

    #[test]
    fn 老配置缺少生成视图尺寸时只补这一项() {
        // 这是真实会遇到的升级场景：用户的 config.json 是上个版本写的，没有 generator
        let dir = temp_dir("legacy-sizes");
        fs::write(
            dir.join("config.json"),
            r#"{"version":1,"theme":"dark","clipboardClearEnabled":false,"clipboardClearSeconds":5,"hidePasswordSeconds":0,"windowSizes":{"query":[462,272],"list":[840,474],"settings":[620,560]}}"#,
        )
        .unwrap();

        let loaded = load_in(&dir);
        assert_eq!(loaded.window_sizes.generator, DEFAULT_GENERATOR);
        // 整份配置不能被重置：这几项都必须活着
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.clipboard_clear_enabled, false);
        assert_eq!(loaded.clipboard_clear_seconds, 5);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 旧查询页默认高度只对上一版写出的配置升级() {
        let dir = temp_dir("legacy-query");

        // 上一版写出的配置（没有 generator 字段）：272 是旧默认值，升级成 214
        fs::write(
            dir.join("config.json"),
            r#"{"version":1,"theme":"system","clipboardClearEnabled":true,"clipboardClearSeconds":30,"hidePasswordSeconds":30,"windowSizes":{"query":[462,272],"list":[840,474],"settings":[620,560]}}"#,
        )
        .unwrap();
        assert_eq!(load_in(&dir).window_sizes.query, DEFAULT_QUERY);

        // 新版本写出的配置（有 generator 字段）：272 是用户自己的选择，不动
        fs::write(
            dir.join("config.json"),
            r#"{"version":1,"theme":"system","clipboardClearEnabled":true,"clipboardClearSeconds":30,"hidePasswordSeconds":30,"windowSizes":{"query":[462,272],"list":[840,474],"settings":[620,560],"generator":[462,380]}}"#,
        )
        .unwrap();
        assert_eq!(load_in(&dir).window_sizes.query, [462, 272]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 生成视图尺寸越界回落默认() {
        let mut config = Config::default();
        config.window_sizes.generator = [10, 10000];
        assert_eq!(config.sanitized().window_sizes.generator, DEFAULT_GENERATOR);
    }

    #[test]
    fn 越界值回落默认() {
        let mut config = Config::default();
        config.clipboard_clear_seconds = 0;
        config.hide_password_seconds = 9999;
        config.window_sizes.query = [0, 0];
        config.window_sizes.list = [9999, 9999];
        let config = config.sanitized();

        assert_eq!(config.clipboard_clear_seconds, 30);
        assert_eq!(config.hide_password_seconds, 30);
        assert_eq!(config.window_sizes.query, DEFAULT_QUERY);
        assert_eq!(config.window_sizes.list, DEFAULT_LIST);
    }

    #[test]
    fn 隐藏秒数允许为零表示不隐藏() {
        let mut config = Config::default();
        config.hide_password_seconds = 0;
        assert_eq!(config.sanitized().hide_password_seconds, 0);
    }

    #[test]
    fn 非法主题回落_system() {
        let mut config = Config::default();
        config.theme = "紫色".to_string();
        assert_eq!(config.sanitized().theme, "system");
    }

    #[test]
    fn 保存后能读回且经过净化() {
        let dir = temp_dir("roundtrip");
        let mut config = Config::default();
        config.theme = "dark".to_string();
        config.clipboard_clear_seconds = 5;
        save_in(&dir, &config).unwrap();

        let loaded = load_in(&dir);
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.clipboard_clear_seconds, 5);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 配置文件不存在时返回默认值() {
        let dir = temp_dir("missing");
        let loaded = load_in(&dir);
        assert_eq!(loaded, Config::default());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 坏_json_回落默认值并写回() {
        let dir = temp_dir("broken");
        fs::write(dir.join("config.json"), "{ this is not json").unwrap();

        let loaded = load_in(&dir);
        assert_eq!(loaded, Config::default());

        let text = fs::read_to_string(dir.join("config.json")).unwrap();
        assert!(serde_json::from_str::<Config>(&text).is_ok());
        fs::remove_dir_all(&dir).ok();
    }
}
