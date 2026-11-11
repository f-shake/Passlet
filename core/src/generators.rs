//! 生成器插件目录。
//!
//! 这里只做一件事：把目录里的 `*.js` 读成文本交给前端。解析与执行都在 WebView 里，
//! 所以本模块不引入 JS 引擎、不校验脚本内容——插件写坏了由前端报错，不是这里的事。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 目录名。仓库根与可执行文件同级都用这个名字。
pub const DIR_NAME: &str = "generators";

/// 单个插件源码上限。插件是给自己写的小脚本，超过这个体积多半是把别的文件放进来了。
pub const MAX_SOURCE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorFile {
    pub file: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorScan {
    /// 当前生效目录的绝对路径。界面要显示它，用户才知道该把文件放哪。
    pub dir: String,
    /// 目录是否存在。不存在不算错误：没装插件时应用照常可用。
    pub present: bool,
    pub files: Vec<GeneratorFile>,
    /// 逐个文件的跳过原因，按读取顺序排列。
    pub warnings: Vec<String>,
}

/// 目录解析顺序：环境变量 → 可执行文件同级 → 调试构建回落仓库根。
///
/// 为什么不是"只认环境变量"：装好就能用，不必先设一个变量。
/// 为什么还留环境变量：仓库里的插件是唯一真源，指过去就不用每次往部署目录拷贝。
pub fn resolve_dir(
    env_value: Option<&str>,
    exe_dir: Option<&Path>,
    dev_dir: Option<&Path>,
) -> PathBuf {
    if let Some(value) = env_value {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(base) = exe_dir {
        let beside = base.join(DIR_NAME);
        // 存在才用：调试构建的可执行文件在 target/debug 下，那里不会放插件
        if beside.is_dir() {
            return beside;
        }
        if dev_dir.is_none() {
            return beside;
        }
    }

    if let Some(dev) = dev_dir {
        return dev.to_path_buf();
    }

    PathBuf::from(DIR_NAME)
}

pub fn dir() -> PathBuf {
    let env_value = std::env::var("PASSLET_GENERATOR_DIR").ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|base| base.to_path_buf()));
    let dev = dev_dir();
    resolve_dir(env_value.as_deref(), exe_dir.as_deref(), dev.as_deref())
}

/// 仓库根的 `generators/`，只在调试构建里参与解析。
///
/// 发布版不能带上编译机的源码路径：那是构建环境的偶然属性，换台机器就不成立。
fn dev_dir() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|root| root.join(DIR_NAME))
}

pub fn scan() -> GeneratorScan {
    scan_in(&dir())
}

pub fn scan_in(dir: &Path) -> GeneratorScan {
    let mut scan = GeneratorScan {
        dir: dir.display().to_string(),
        present: dir.is_dir(),
        files: Vec::new(),
        warnings: Vec::new(),
    };
    if !scan.present {
        return scan;
    }

    let read = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            scan.warnings.push(format!("无法读取插件目录：{err}"));
            return scan;
        }
    };

    let mut paths: Vec<PathBuf> = read
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| is_plugin_file(path))
        .collect();
    // 按文件名排序：前端按读取顺序注册，顺序稳定用户才找得到自己的插件。
    paths.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

    for path in paths {
        let name = path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();

        let meta = match std::fs::metadata(&path) {
            Ok(meta) => meta,
            Err(err) => {
                scan.warnings.push(format!("“{name}”读取失败：{err}"));
                continue;
            }
        };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > MAX_SOURCE_BYTES {
            scan.warnings.push(format!(
                "“{name}”太大（超过 {} KB），已跳过。",
                MAX_SOURCE_BYTES / 1024
            ));
            continue;
        }

        match std::fs::read_to_string(&path) {
            Ok(source) => scan.files.push(GeneratorFile { file: name, source }),
            Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                scan.warnings.push(format!("“{name}”不是 UTF-8 文本，已跳过。"));
            }
            Err(err) => scan.warnings.push(format!("“{name}”读取失败：{err}")),
        }
    }

    scan
}

fn is_plugin_file(path: &Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case("js"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(tag: &str) -> PathBuf {
        crate::scratch::scratch_dir(&format!("gen-{tag}"))
    }

    fn dir_with_js(tag: &str, files: &[(&str, &str)]) -> PathBuf {
        let dir = temp(tag);
        for (name, content) in files {
            fs::write(dir.join(name), content).unwrap();
        }
        dir
    }

    #[test]
    fn 环境变量优先于其它来源() {
        let exe = temp("exe-priority");
        let beside = exe.join(DIR_NAME);
        fs::create_dir_all(&beside).unwrap();

        let resolved = resolve_dir(Some("D:\\my-plugins"), Some(&exe), Some(&exe));
        assert_eq!(resolved, PathBuf::from("D:\\my-plugins"));

        fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn 环境变量是空白时忽略() {
        let exe = temp("blank-env");
        let beside = exe.join(DIR_NAME);
        fs::create_dir_all(&beside).unwrap();

        let resolved = resolve_dir(Some("   "), Some(&exe), None);
        assert_eq!(resolved, beside);

        fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn exe_同级目录存在时用它() {
        let exe = temp("beside");
        let beside = exe.join(DIR_NAME);
        fs::create_dir_all(&beside).unwrap();
        let dev = temp("beside-dev");

        assert_eq!(resolve_dir(None, Some(&exe), Some(&dev)), beside);

        fs::remove_dir_all(&exe).ok();
        fs::remove_dir_all(&dev).ok();
    }

    #[test]
    fn exe_同级不存在时用调试回落的仓库根() {
        let exe = temp("fallback-exe");
        let dev = temp("fallback-dev");

        assert_eq!(resolve_dir(None, Some(&exe), Some(&dev)), dev);

        fs::remove_dir_all(&exe).ok();
        fs::remove_dir_all(&dev).ok();
    }

    #[test]
    fn 没有仓库根回落时仍指向_exe_同级() {
        let exe = temp("no-dev");

        assert_eq!(resolve_dir(None, Some(&exe), None), exe.join(DIR_NAME));

        fs::remove_dir_all(&exe).ok();
    }

    #[test]
    fn 目录不存在时_present_为假且不报错() {
        let dir = temp("missing");
        let target = dir.join("nope");

        let scan = scan_in(&target);
        assert_eq!(scan.present, false);
        assert!(scan.files.is_empty());
        assert!(scan.warnings.is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 只收_js_文件并跳过子目录() {
        let dir = dir_with_js(
            "only-js",
            &[("a.js", "AAAA"), ("b.md", "BBBB"), ("c.txt", "CCCC")],
        );
        fs::create_dir_all(dir.join("sub.js")).unwrap();

        let scan = scan_in(&dir);
        let names: Vec<&str> = scan.files.iter().map(|item| item.file.as_str()).collect();
        assert_eq!(names, vec!["a.js"]);
        assert_eq!(scan.files[0].source, "AAAA");

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 按文件名排序() {
        let dir = dir_with_js("sorted", &[("zeta.js", "Z"), ("alpha.js", "A")]);

        let scan = scan_in(&dir);
        let names: Vec<&str> = scan.files.iter().map(|item| item.file.as_str()).collect();
        assert_eq!(names, vec!["alpha.js", "zeta.js"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 超过上限的文件被跳过并提示() {
        let dir = temp("too-large");
        let big = vec![b'a'; (MAX_SOURCE_BYTES + 1) as usize];
        fs::write(dir.join("huge.js"), big).unwrap();
        fs::write(dir.join("ok.js"), "OK").unwrap();

        let scan = scan_in(&dir);
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].file, "ok.js");
        assert_eq!(scan.warnings.len(), 1);
        assert!(scan.warnings[0].contains("太大"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 非_utf8_文件被跳过并提示() {
        let dir = temp("not-utf8");
        fs::write(dir.join("bad.js"), [0xff, 0xfe, 0x41]).unwrap();

        let scan = scan_in(&dir);
        assert!(scan.files.is_empty());
        assert_eq!(scan.warnings.len(), 1);
        assert!(scan.warnings[0].contains("不是 UTF-8"));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 目录里的普通文件都能读到时没有告警() {
        let dir = dir_with_js("clean", &[("one.js", "1"), ("two.js", "2")]);

        let scan = scan_in(&dir);
        assert_eq!(scan.present, true);
        assert_eq!(scan.files.len(), 2);
        assert!(scan.warnings.is_empty());

        fs::remove_dir_all(&dir).ok();
    }
}
