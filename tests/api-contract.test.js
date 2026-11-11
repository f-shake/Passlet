// 前后端契约测试：锁住"前端调了什么命令、传了什么参数名"。
//
// 这类错误（命令名拼错、参数名从 camelCase 写成 snake_case）在编译期查不出来，
// 只有真正点界面才会暴露。这里用一个假的 invoke 把调用录下来逐条断言，
// 命令名与参数名必须和 src-tauri/src/commands.rs 里的签名一致。
import { beforeEach, describe, expect, it } from "vitest";

const calls = [];
let nextResult = null;
let nextError = null;

// api.js 在加载时会读取 __TAURI__.core.invoke，所以先装好再导入。
globalThis.__TAURI__ = {
  core: {
    invoke(command, args) {
      calls.push({ command, args });
      if (nextError) return Promise.reject(nextError);
      return Promise.resolve(nextResult);
    }
  }
};
delete globalThis.PassletDemo;

await import("../frontend/api.js");
const api = globalThis.PassletApi;

beforeEach(() => {
  calls.length = 0;
  nextResult = null;
  nextError = null;
});

const lastCall = () => calls[calls.length - 1];

describe("会话命令", () => {
  it("bootstrap 不带参数", async () => {
    nextResult = { masterLoaded: true };
    await api.bootstrap();
    expect(lastCall()).toEqual({ command: "bootstrap", args: {} });
  });

  it("lock 不带参数", async () => {
    await api.lock();
    expect(lastCall()).toEqual({ command: "lock", args: {} });
  });

  it("setView 传 view", async () => {
    await api.setView("list");
    expect(lastCall()).toEqual({ command: "set_view", args: { view: "list" } });
  });
});

describe("条目命令", () => {
  it("listEntries 不带参数", async () => {
    nextResult = [];
    await api.listEntries();
    expect(lastCall()).toEqual({ command: "list_entries", args: {} });
  });

  it("getSecret 传 id", async () => {
    nextResult = "p";
    await api.getSecret("abc");
    expect(lastCall()).toEqual({ command: "get_secret", args: { id: "abc" } });
  });

  it("copySecret 传 id", async () => {
    await api.copySecret("abc");
    expect(lastCall()).toEqual({ command: "copy_secret", args: { id: "abc" } });
  });

  it("addEntry 传 platform / username / password", async () => {
    nextResult = { id: "1", platform: "GitHub", username: "me" };
    await api.addEntry("GitHub", "me", "pw");
    expect(lastCall()).toEqual({
      command: "add_entry",
      args: { platform: "GitHub", username: "me", password: "pw" }
    });
  });

  it("updateEntry 带上 id", async () => {
    nextResult = { id: "1", platform: "GitHub", username: "me" };
    await api.updateEntry("1", "GitHub", "me", "pw2");
    expect(lastCall()).toEqual({
      command: "update_entry",
      args: { id: "1", platform: "GitHub", username: "me", password: "pw2" }
    });
  });

  it("deleteEntry 传 id", async () => {
    await api.deleteEntry("1");
    expect(lastCall()).toEqual({ command: "delete_entry", args: { id: "1" } });
  });
});

describe("配置与备份命令", () => {
  it("getConfig 不带参数", async () => {
    nextResult = { theme: "system" };
    await api.getConfig();
    expect(lastCall()).toEqual({ command: "get_config", args: {} });
  });

  it("saveConfig 把对象塞在 config 字段里", async () => {
    const payload = { theme: "dark", clipboardClearSeconds: 5 };
    nextResult = payload;
    await api.saveConfig(payload);
    expect(lastCall()).toEqual({ command: "save_config", args: { config: payload } });
  });

  it("vaultPath 对应 vault_path_display", async () => {
    nextResult = "C:\\vault.dat";
    await api.vaultPath();
    expect(lastCall()).toEqual({ command: "vault_path_display", args: {} });
  });

  it("pickImportFile 对应 pick_import_file", async () => {
    nextResult = "C:\\b.pvault";
    await api.pickImportFile();
    expect(lastCall()).toEqual({ command: "pick_import_file", args: {} });
  });

  it("importFrom 传 path 与 mode", async () => {
    nextResult = { added: 1, skipped: 0, replaced: 0, mode: "skip", backupPath: null };
    await api.importFrom("C:\\b.pvault", "skip");
    expect(lastCall()).toEqual({
      command: "import_from",
      args: { path: "C:\\b.pvault", mode: "skip" }
    });
  });

  it("changeMaster 的参数名是 camelCase 的 newPassword", async () => {
    await api.changeMaster("new-master-pw");
    expect(lastCall()).toEqual({ command: "change_master", args: { newPassword: "new-master-pw" } });
  });
});

describe("返回值形状", () => {
  it("exportVault 把路径字符串包成 { path }", async () => {
    nextResult = "C:\\backup.pvault";
    await expect(api.exportVault()).resolves.toEqual({ path: "C:\\backup.pvault" });
  });

  it("用户取消导出时返回 null", async () => {
    nextResult = null;
    await expect(api.exportVault()).resolves.toBeNull();
  });

  it("后端错误对象原样抛给调用方", async () => {
    nextError = { code: "duplicate", message: "这个平台下已经有同名用户名了。" };
    await expect(api.addEntry("a", "b", "c")).rejects.toMatchObject({ code: "duplicate" });
  });
});
