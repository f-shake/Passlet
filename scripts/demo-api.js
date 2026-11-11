// 预览用的后端替身：只在浏览器里直接打开预览页时加载（由 scripts/build-preview.mjs 内联）。
// 正常运行时 index.html 不引用这个文件——真实数据一律走 Rust。
// 行为对齐 docs/PLAN.md 的契约：同样的命令名、同样的错误码、同样的校验规则。
(function (root) {
  "use strict";

  const { validateEntry, normalizeKey, clampInt } = root.PassletLogic;

  const fail = (code, message) => Promise.reject({ code, message });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const DEFAULT_CONFIG = {
    version: 1,
    theme: "system",
    clipboardClearEnabled: true,
    clipboardClearSeconds: 30,
    hidePasswordSeconds: 30,
    rememberWindowSize: true,
    windowSizes: { query: [462, 272], list: [840, 474], settings: [620, 560] }
  };

  let nextId = 100;
  let entries = [
    { id: "e1", platform: "GitHub", username: "me@example.com", password: "gh_9fK2!mQx7Lp" },
    { id: "e2", platform: "GitHub", username: "work@corp.com", password: "gh-work#2026" },
    { id: "e3", platform: "Google", username: "me@gmail.com", password: "Tr0ub4dor&3xyz" },
    { id: "e4", platform: "阿里云", username: "autod", password: "aliyun@2026#QQ" },
    { id: "e5", platform: "Steam", username: "autod_play", password: "S7eam_n1ce" },
    { id: "e6", platform: "NAS", username: "admin", password: "n@s-Passw0rd" },
    { id: "e7", platform: "某银行", username: "6222 **** 8888", password: "Bank!2026ok" }
  ];
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  const find = id => entries.find(item => item.id === id) || null;

  function sanitize(raw) {
    const merged = Object.assign({}, DEFAULT_CONFIG, raw || {});
    return {
      version: 1,
      theme: ["system", "light", "dark"].includes(merged.theme) ? merged.theme : "system",
      clipboardClearEnabled: Boolean(merged.clipboardClearEnabled),
      clipboardClearSeconds: clampInt(merged.clipboardClearSeconds, 1, 600, 30),
      hidePasswordSeconds: clampInt(merged.hidePasswordSeconds, 0, 600, 30),
      rememberWindowSize: Boolean(merged.rememberWindowSize),
      windowSizes: Object.assign({}, DEFAULT_CONFIG.windowSizes, merged.windowSizes || {})
    };
  }

  function assertUnique(platform, username, skipId) {
    const p = normalizeKey(platform);
    const u = normalizeKey(username);
    const hit = entries.find(item =>
      item.id !== skipId && normalizeKey(item.platform) === p && normalizeKey(item.username) === u
    );
    if (hit) throw { code: "duplicate", message: "这个平台下已经有同名用户名了。" };
  }

  const meta = entry => ({ id: entry.id, platform: entry.platform, username: entry.username });

  const handlers = {
    async bootstrap() {
      await sleep(60);
      const forced = new URLSearchParams(location.search).get("demo");
      if (forced === "error") return { masterLoaded: false, reason: "env_missing" };
      if (forced === "decrypt") return { masterLoaded: false, reason: "decrypt_failed" };
      if (forced === "corrupt") return { masterLoaded: false, reason: "corrupt" };
      if (forced === "empty") entries = [];
      return { masterLoaded: true };
    },

    async lock() {},

    async set_view() {},

    async apply_theme() {},

    async list_entries() {
      await sleep(20);
      return entries.map(meta);
    },

    async get_secret({ id }) {
      await sleep(20);
      const entry = find(id);
      if (!entry) throw { code: "not_found", message: "这条记录已经不在了，可能被删掉了。" };
      return entry.password;
    },

    async copy_secret({ id }) {
      const entry = find(id);
      if (!entry) throw { code: "not_found", message: "这条记录已经不在了，可能被删掉了。" };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(entry.password);
        }
      } catch {
        throw { code: "clipboard", message: "复制失败：系统剪贴板不可用。" };
      }
      return null;
    },

    async copy_text({ text }) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      } catch {
        throw { code: "clipboard", message: "复制失败：系统剪贴板不可用。" };
      }
      return null;
    },

    async add_entry({ platform, username, password }) {
      await sleep(40);
      const problem = validateEntry(platform, username, password);
      if (problem) throw { code: "invalid", message: problem };
      assertUnique(platform, username, null);
      const entry = {
        id: `e${nextId++}`,
        platform: String(platform).trim(),
        username: String(username).trim(),
        password: String(password)
      };
      entries = [entry].concat(entries);
      return meta(entry);
    },

    async update_entry({ id, platform, username, password }) {
      await sleep(40);
      const problem = validateEntry(platform, username, password);
      if (problem) throw { code: "invalid", message: problem };
      const entry = find(id);
      if (!entry) throw { code: "not_found", message: "这条记录已经不在了，可能被删掉了。" };
      assertUnique(platform, username, id);
      entry.platform = String(platform).trim();
      entry.username = String(username).trim();
      entry.password = String(password);
      return meta(entry);
    },

    async delete_entry({ id }) {
      await sleep(40);
      const before = entries.length;
      entries = entries.filter(item => item.id !== id);
      if (entries.length === before) throw { code: "not_found", message: "这条记录已经不在了，可能被删掉了。" };
      return null;
    },

    async get_config() {
      return JSON.parse(JSON.stringify(config));
    },

    async save_config({ config: next }) {
      config = sanitize(next);
      return JSON.parse(JSON.stringify(config));
    },

    async vault_path_display() {
      return "C:\\Users\\autod\\AppData\\Roaming\\Passlet\\vault.dat";
    },

    async export_vault() {
      await sleep(120);
      return "C:\\Users\\autod\\Documents\\passlet-backup-20261110-214500.pvault";
    },

    async pick_import_file() {
      await sleep(120);
      return "C:\\Users\\autod\\Documents\\passlet-backup.pvault";
    },

    async import_from({ path, mode }) {
      await sleep(150);
      if (!path) throw { code: "invalid", message: "读不到这个文件。" };
      const incoming = [
        { id: `i${nextId++}`, platform: "GitHub", username: "me@example.com", password: "imported-gh" },
        { id: `i${nextId++}`, platform: "Docker Hub", username: "autod", password: "docker!2026" },
        { id: `i${nextId++}`, platform: "KeyCDN", username: "ops@example.com", password: "cdn_9xY" }
      ];

      if (mode === "replace") {
        entries = incoming;
        return {
          added: incoming.length,
          skipped: 0,
          replaced: 0,
          mode,
          backupPath: "vault.dat.bak.20261110-214515"
        };
      }

      let added = 0;
      let skipped = 0;
      let replaced = 0;
      for (const item of incoming) {
        const hit = entries.find(existing =>
          normalizeKey(existing.platform) === normalizeKey(item.platform)
          && normalizeKey(existing.username) === normalizeKey(item.username)
        );
        if (hit) {
          if (mode === "overwrite") {
            hit.password = item.password;
            replaced += 1;
          } else {
            skipped += 1;
          }
        } else {
          entries = entries.concat([item]);
          added += 1;
        }
      }
      return { added, skipped, replaced, mode, backupPath: null };
    },

    async change_master({ newPassword }) {
      await sleep(120);
      if ([...String(newPassword)].length < 8) throw { code: "invalid", message: "新主密码至少 8 位。" };
      return null;
    }
  };

  root.PassletDemo = {
    invoke(command, args) {
      const handler = handlers[command];
      if (!handler) return fail("no_command", `预览里没有实现命令 ${command}。`);
      return Promise.resolve()
        .then(() => handler(args || {}))
        .catch(err => {
          if (err && err.code) return Promise.reject(err);
          return fail("internal", String((err && err.message) || err));
        });
    }
  };
})(window);
