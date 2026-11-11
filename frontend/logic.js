// 纯函数层：不碰 DOM、不调后端，因此可以直接单测。
// 用 IIFE 挂到 globalThis 而不是 ES module，是为了让 index.html 从 file:// 直接双击打开也能跑
// （浏览器会以 null 源拦截 file:// 下的 module 脚本）。本文件没有 import/export，
// 因此在 Node 里也能被 import 后执行，单测用 globalThis.PassletLogic 取函数。
(function (root) {
  "use strict";

  /**
   * 归一化用于“是否同一个平台/用户名”的比较。
   * 大小写不敏感：用户容易把 GitHub 写成 github，视觉上重复比“尊重原样”更糟。
   * 保存时仍保留用户输入的原始写法。
   */
  function normalizeKey(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  /**
   * 自动补全的匹配打分：前缀命中(0) 优于子串命中(1)，不命中返回 null。
   * 前缀优先是为了让“打两个字母就能选到”成立，否则子串命中会把目标挤下去。
   */
  function matchScore(label, query) {
    const q = normalizeKey(query);
    if (!q) return 1;
    const l = normalizeKey(label);
    if (!l) return null;
    if (l.startsWith(q)) return 0;
    if (l.includes(q)) return 1;
    return null;
  }

  /** 过滤下拉选项：命中的按打分升序，同分保持原顺序（稳定排序）。 */
  function filterOptions(options, query) {
    const scored = [];
    for (let i = 0; i < options.length; i += 1) {
      const score = matchScore(options[i], query);
      if (score !== null) scored.push({ value: options[i], score, index: i });
    }
    scored.sort((a, b) => (a.score - b.score) || (a.index - b.index));
    return scored.map(item => item.value);
  }

  /** 清单过滤：平台或用户名任一命中即保留，忽略大小写。 */
  function filterEntries(entries, query) {
    const q = normalizeKey(query);
    if (!q) return entries.slice();
    return entries.filter(entry =>
      normalizeKey(entry.platform).includes(q) || normalizeKey(entry.username).includes(q)
    );
  }

  /** 数字输入钳制：非数字/越界一律回落到默认值，避免把 NaN 写进配置。 */
  function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const int = Math.trunc(n);
    if (int < min) return min;
    if (int > max) return max;
    return int;
  }

  /** 密码掩码固定 8 个点：长度本身也是信息，不泄露。 */
  function maskText() {
    return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
  }

  /** 校验一条记录，返回错误文案；通过则返回 null。文案与后端保持一致。 */
  function validateEntry(platform, username, password) {
    const p = String(platform == null ? "" : platform).trim();
    const u = String(username == null ? "" : username).trim();
    const w = String(password == null ? "" : password);
    if (!p || !u || !w) return "平台、用户名、密码都要填。";
    if ([...p].length > 200 || [...u].length > 200) return "平台和用户名最多 200 字，密码最多 1024 字。";
    if ([...w].length > 1024) return "平台和用户名最多 200 字，密码最多 1024 字。";
    return null;
  }

  /**
   * 校验“设置主密码”弹窗的输入，返回错误文案；通过则返回 null。
   * 只拒绝空白，不限制长度：这里填的往往是已有主密码，长度规则属于“更换主密码”。
   * `confirm` 传 undefined 表示不做两次一致性检查（库已存在时后端会先验证能不能解开）。
   */
  function validateMasterInput(value, confirm) {
    const text = String(value == null ? "" : value);
    if (!text.trim()) return "主密码不能为空。";
    if (confirm !== undefined && text !== String(confirm == null ? "" : confirm)) {
      return "两次输入的密码不一样。";
    }
    return null;
  }

  /**
   * 设置页「主密码」那一行显示什么。
   * 只说“值在哪里”，不说“下次一定打得开”——状态查不到库密码与这些值是否一致，
   * 承诺得越具体，越容易在换密码同步失败之类的场合变成假话。
   */
  function masterStateLines(info) {
    if (!info) return { main: "正在读取…", note: "" };
    if (info.active === "process") {
      return info.userRegistry
        ? { main: "已设置（本次运行 + 用户级）", note: "本次用的是进程环境里的值，用户级环境变量里也存了一份。" }
        : { main: "仅本次运行", note: "进程环境里的值；不用启动脚本直接打开时会读不到。" };
    }
    if (info.active === "user") {
      return { main: "已设置（用户级环境变量）", note: "程序下次启动会从这里读取。" };
    }
    if (info.active === "machine") {
      return { main: "已设置（机器级）", note: "来自系统级环境变量，本程序只读不改。" };
    }
    return { main: "未设置", note: "直接打开程序会停在说明页。" };
  }

  /**
   * 校验“导出备份”弹窗的备份密码，返回错误文案；通过则返回 null。
   * 它与主密码是两回事：备份密码只保护导出的文件，导出之后换主密码也不影响它。
   * 导入时只校验非空——长度是不是够，后端解一次就知道，不必在这里先挡一道。
   */
  function validateBackupPassword(value, confirm) {
    const text = String(value == null ? "" : value);
    if (!text.trim()) return "备份密码不能为空。";
    if ([...text].length < 8) return "备份密码至少 8 位。";
    if (confirm !== undefined && text !== String(confirm == null ? "" : confirm)) {
      return "两次输入的密码不一样。";
    }
    return null;
  }

  root.PassletLogic = {
    normalizeKey,
    matchScore,
    filterOptions,
    filterEntries,
    clampInt,
    maskText,
    validateEntry,
    validateMasterInput,
    validateBackupPassword,
    masterStateLines
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
