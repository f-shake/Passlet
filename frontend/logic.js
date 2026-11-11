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

  root.PassletLogic = {
    normalizeKey,
    matchScore,
    filterOptions,
    filterEntries,
    clampInt,
    maskText,
    validateEntry
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
