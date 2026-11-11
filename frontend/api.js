// 后端接口层：一个函数对应一个 Rust 命令，参数与返回值都按 docs/PLAN.md 的契约走。
//
// 两条通道：
//  1. 正常情况走 Tauri 的 invoke（tauri.conf.json 里已开 withGlobalTauri）；
//  2. 浏览器里直接打开预览页时没有 Tauri，走 window.PassletDemo（只在预览构建里注入）。
// 业务代码只认下面这些函数名，不关心通道。
(function (root) {
  "use strict";

  const bridge = root.__TAURI__ && root.__TAURI__.core;
  const demo = root.PassletDemo || null;

  function call(command, args) {
    if (bridge) return bridge.invoke(command, args || {});
    if (demo) return demo.invoke(command, args || {});
    return Promise.reject({
      code: "no_host",
      message: "需要在 Passlet 应用里运行：当前页面没有后端通道。"
    });
  }

  function error(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  /* ---------- 会话 ---------- */

  // { masterLoaded: boolean, reason?: "env_missing" | "decrypt_failed" | "corrupt" | "version" }
  const bootstrap = () => call("bootstrap");

  const lock = () => call("lock");

  const setView = view => call("set_view", { view });

  // mode: "system" | "light" | "dark"；让原生标题栏一起变
  const setWindowTheme = mode => call("apply_theme", { mode });

  /* ---------- 条目 ---------- */

  const listEntries = () => call("list_entries");

  const getSecret = id => call("get_secret", { id });

  const copySecret = id => call("copy_secret", { id });

  // 复制任意文本（路径、命令）；与 copySecret 共用 Rust 侧剪贴板通道
  const copyText = text => call("copy_text", { text });

  const addEntry = (platform, username, password) =>
    call("add_entry", { platform, username, password });

  const updateEntry = (id, platform, username, password) =>
    call("update_entry", { id, platform, username, password });

  const deleteEntry = id => call("delete_entry", { id });

  /* ---------- 配置 ---------- */

  const getConfig = () => call("get_config");

  const saveConfig = config => call("save_config", { config });

  const vaultPath = () => call("vault_path_display");

  /* ---------- 备份 ---------- */

  // 返回 { path } 或 null（用户取消）。命令返回的是字符串或 null。
  const exportVault = async () => {
    const path = await call("export_vault");
    return path ? { path } : null;
  };

  const pickImportFile = () => call("pick_import_file");

  // mode: "replace" | "skip" | "overwrite"
  const importFrom = (path, mode) => call("import_from", { path, mode });

  const changeMaster = newPassword => call("change_master", { newPassword });

  root.PassletApi = {
    error,
    bootstrap,
    lock,
    setView,
    setWindowTheme,
    listEntries,
    getSecret,
    copySecret,
    copyText,
    addEntry,
    updateEntry,
    deleteEntry,
    getConfig,
    saveConfig,
    vaultPath,
    exportVault,
    pickImportFile,
    importFrom,
    changeMaster
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
