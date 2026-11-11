//! 命令行端到端测试：跑真实二进制，用 `--vault` 指到临时目录，不碰用户的真实数据。
//!
//! 覆盖的是"脚本会依赖的行为"：输出格式、退出码、备份往返。

use std::path::Path;
use std::process::{Command, Output, Stdio};

use passlet_core::scratch;

const MASTER: &str = "cli-e2e-master-password";
/// 备份密码与主密码是两回事，这里刻意取一个明显不同的值
const BACKUP_PW: &str = "cli-backup-password-2026";

fn run(dir: &Path, args: &[&str], stdin: Option<&str>, master: &str) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_passlet-cli"));
    command
        .arg("--vault")
        .arg(dir)
        .args(args)
        .env("PASSLET_MASTER", master)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().expect("启动 passlet-cli");
    if let Some(text) = stdin {
        use std::io::Write;
        child
            .stdin
            .as_mut()
            .expect("stdin")
            .write_all(text.as_bytes())
            .expect("写入标准输入");
    }
    child.wait_with_output().expect("等待进程结束")
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

#[test]
fn 空库时_list_无输出且退出码为零() {
    let dir = scratch::scratch_dir("cli-empty");
    let output = run(&dir, &["list"], None, MASTER);
    assert!(output.status.success());
    assert!(text(&output.stdout).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 新增后能列出并取回同一密码() {
    let dir = scratch::scratch_dir("cli-add-get");

    let added = run(&dir, &["add", "GitHub", "me"], Some("secret-one"), MASTER);
    assert!(added.status.success(), "{}", text(&added.stderr));

    let listed = run(&dir, &["list"], None, MASTER);
    assert!(text(&listed.stdout).contains("GitHub"));
    assert!(text(&listed.stdout).contains("me"));

    let fetched = run(&dir, &["get", "GitHub", "me"], None, MASTER);
    assert_eq!(text(&fetched.stdout), "secret-one");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn json_输出可被解析且字段齐全() {
    let dir = scratch::scratch_dir("cli-json");
    run(&dir, &["add", "阿里云", "autod"], Some("pw"), MASTER);

    let output = run(&dir, &["--json", "get", "阿里云", "autod"], None, MASTER);
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).expect("合法 JSON");
    assert_eq!(parsed["platform"], "阿里云");
    assert_eq!(parsed["username"], "autod");
    assert_eq!(parsed["password"], "pw");

    let listed = run(&dir, &["--json", "list"], None, MASTER);
    let array: serde_json::Value = serde_json::from_slice(&listed.stdout).expect("合法 JSON");
    assert_eq!(array.as_array().expect("数组").len(), 1);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 退出码对应不同的失败原因() {
    let dir = scratch::scratch_dir("cli-codes");
    run(&dir, &["add", "GitHub", "me"], Some("pw"), MASTER);

    // 4：重复
    let duplicate = run(&dir, &["add", "github", "ME"], Some("pw2"), MASTER);
    assert_eq!(duplicate.status.code(), Some(4), "{}", text(&duplicate.stderr));

    // 3：不存在
    let missing = run(&dir, &["get", "Nowhere", "nobody"], None, MASTER);
    assert_eq!(missing.status.code(), Some(3));

    // 2：主密码错误
    let wrong_master = run(&dir, &["list"], None, "another-master-password");
    assert_eq!(wrong_master.status.code(), Some(2));

    // 1：非终端下删除未加 --yes
    let need_yes = run(&dir, &["remove", "GitHub", "me"], None, MASTER);
    assert_eq!(need_yes.status.code(), Some(1));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 删除带_yes_后条目消失() {
    let dir = scratch::scratch_dir("cli-remove");
    run(&dir, &["add", "GitHub", "me"], Some("pw"), MASTER);

    let removed = run(&dir, &["remove", "GitHub", "me", "--yes"], None, MASTER);
    assert!(removed.status.success(), "{}", text(&removed.stderr));

    let fetched = run(&dir, &["get", "GitHub", "me"], None, MASTER);
    assert_eq!(fetched.status.code(), Some(3));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 导出再导入能还原条目() {
    let dir = scratch::scratch_dir("cli-export");
    run(&dir, &["add", "Gitee", "me"], Some("keep-me"), MASTER);
    let backup = dir.join("backup.pvault");

    let exported = run(
        &dir,
        &["export", backup.to_str().unwrap()],
        Some(BACKUP_PW),
        MASTER,
    );
    assert!(exported.status.success(), "{}", text(&exported.stderr));

    // 清空后再导入
    run(&dir, &["remove", "Gitee", "me", "--yes"], None, MASTER);
    let imported = run(
        &dir,
        &["import", backup.to_str().unwrap(), "--mode", "replace"],
        Some(BACKUP_PW),
        MASTER,
    );
    assert!(imported.status.success(), "{}", text(&imported.stderr));

    let fetched = run(&dir, &["get", "Gitee", "me"], None, MASTER);
    assert_eq!(text(&fetched.stdout), "keep-me");
    // 整库替换会留一份带时间戳的备份
    let has_backup = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|item| item.ok())
        .any(|item| item.file_name().to_string_lossy().contains(".bak."));
    assert!(has_backup, "整库替换应留下备份文件");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 备份密码错时导入失败且库文件一个字节都不动() {
    let dir = scratch::scratch_dir("cli-import-wrong-pw");
    run(&dir, &["add", "Gitee", "me"], Some("keep-me"), MASTER);
    let backup = dir.join("backup.pvault");
    let exported = run(
        &dir,
        &["export", backup.to_str().unwrap()],
        Some(BACKUP_PW),
        MASTER,
    );
    assert!(exported.status.success(), "{}", text(&exported.stderr));

    let before = std::fs::read(dir.join(passlet_core::VAULT_NAME)).unwrap();
    let failed = run(
        &dir,
        &["import", backup.to_str().unwrap()],
        Some("definitely-wrong-pw"),
        MASTER,
    );
    // 退出码 2 = 密码问题（与主密码不对同一个桶）
    assert_eq!(failed.status.code(), Some(2));
    assert!(
        text(&failed.stderr).contains("解不开"),
        "提示应说明是密码问题：{}",
        text(&failed.stderr)
    );
    assert_eq!(
        std::fs::read(dir.join(passlet_core::VAULT_NAME)).unwrap(),
        before,
        "密码错时不该动库文件"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn 换主密码后旧备份照样能用原备份密码导入() {
    const NEW_MASTER: &str = "cli-new-master-password";
    let dir = scratch::scratch_dir("cli-backup-independent");
    run(&dir, &["add", "Gitee", "me"], Some("keep-me"), MASTER);
    let backup = dir.join("backup.pvault");
    let exported = run(
        &dir,
        &["export", backup.to_str().unwrap()],
        Some(BACKUP_PW),
        MASTER,
    );
    assert!(exported.status.success(), "{}", text(&exported.stderr));

    let rotated = run(&dir, &["change-master"], Some(NEW_MASTER), MASTER);
    assert!(rotated.status.success(), "{}", text(&rotated.stderr));

    // 换完密码清空库，再用旧备份 + 备份密码导入：备份与主密码无关，应当成功
    run(&dir, &["remove", "Gitee", "me", "--yes"], None, NEW_MASTER);
    let imported = run(
        &dir,
        &["import", backup.to_str().unwrap(), "--mode", "replace"],
        Some(BACKUP_PW),
        NEW_MASTER,
    );
    assert!(imported.status.success(), "{}", text(&imported.stderr));

    let fetched = run(&dir, &["get", "Gitee", "me"], None, NEW_MASTER);
    assert_eq!(text(&fetched.stdout), "keep-me");
    std::fs::remove_dir_all(&dir).ok();
}
