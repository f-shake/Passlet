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
   * 自动补全的匹配打分：字面前缀命中(0) 优于字面子串(1)，
   * 再往后才是拼音开头(2) 与拼音中间(3)；都不命中返回 null。
   * 前缀优先是为了让“打两个字母就能选到”成立，否则子串命中会把目标挤下去；
   * 拼音两档垫底，是为了让“明明有字面同名项”时不会被拼音结果抢到前面。
   */
  function matchScore(label, query) {
    const q = normalizeKey(query);
    if (!q) return 1;
    const l = normalizeKey(label);
    if (!l) return null;
    if (l.startsWith(q)) return 0;
    if (l.includes(q)) return 1;
    return pinyinMatch(label, query);
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

  /** 清单过滤：平台或用户名任一命中即保留（字面或拼音），忽略大小写。 */
  function filterEntries(entries, query) {
    const q = normalizeKey(query);
    if (!q) return entries.slice();
    return entries.filter(entry =>
      matchScore(entry.platform, query) !== null || matchScore(entry.username, query) !== null
    );
  }

  /* ---------------- 拼音匹配 ----------------
     字表在 frontend/pinyin-data.js（生成物，见 scripts/gen-pinyin-data.mjs）。
     只在第一次真要匹配时才解析成 Map：启动路径不碰它，开机不变慢。
     测试用 setPinyinTable 注入假表，因此单测不依赖那张 155 KB 的真表。 */

  let pinyinIndex = null;
  let pinyinProbed = false;

  // 上限只为挡病态输入：真实平台名远短于这两个值，超了就走纯字面匹配，不影响正确性。
  const PINYIN_MAX_QUERY = 64;
  const PINYIN_MAX_LABEL = 128;
  const PINYIN_QUERY_RE = /^[a-z0-9]+$/;
  const PINYIN_SYLLABLE_RE = /^[a-z]+$/;

  /** 两串原始数据 → Map<char, string[]>；结构不对返回 null，调用方据此整体关掉拼音路径。 */
  function parsePinyinTable(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.chars !== "string" || typeof raw.readings !== "string") return null;
    const chars = Array.from(raw.chars);
    const readings = raw.readings.split(",");
    if (chars.length === 0 || chars.length !== readings.length) return null;
    if (typeof raw.count === "number" && raw.count !== chars.length) return null;
    const map = new Map();
    for (let i = 0; i < chars.length; i += 1) {
      const list = readings[i].split("/");
      for (const syllable of list) {
        if (!PINYIN_SYLLABLE_RE.test(syllable)) return null;
      }
      map.set(chars[i], list);
    }
    return map;
  }

  function getPinyinMap() {
    if (pinyinProbed) return pinyinIndex;
    pinyinProbed = true;
    const raw = root.PassletPinyin;
    pinyinIndex = parsePinyinTable(raw);
    if (raw && !pinyinIndex && typeof console !== "undefined" && console.warn) {
      console.warn("拼音表已损坏，已关闭拼音匹配");
    }
    return pinyinIndex;
  }

  /**
   * 注入或清空拼音表。传 undefined 恢复成「下次自动从全局读」，
   * 免得多条用例之间互相污染。
   */
  function setPinyinTable(map) {
    if (map === undefined) {
      pinyinProbed = false;
      pinyinIndex = null;
      return;
    }
    pinyinProbed = true;
    pinyinIndex = map instanceof Map ? map : null;
  }

  /**
   * 标签 → 匹配用的字序列。
   * 空白直接跳过（「Xiao Mi」也能用 xiaomi 命中）；汉字给全部读音；
   * 其它字符原样当一个「音节」，只能整字符命中——把标点当分隔符会让跨边界的误命中变多。
   */
  function labelTokens(text, map) {
    const tokens = [];
    for (const ch of String(text)) {
      if (/\s/.test(ch)) continue;
      const readings = map.get(ch);
      tokens.push(readings ? readings.slice() : [ch.toLowerCase()]);
    }
    return tokens;
  }

  /**
   * 从 tokens[start] 起，查询能否被完全消耗掉。
   * 每个字有三条走法：出全拼、只出首字母、查询在音节中间用完（尾部未打完）；
   * 只有最后一条允许「没打完」，因为查询确实到头了。
   */
  function matchTokens(tokens, start, q) {
    let states = new Set([0]);
    for (let t = start; t < tokens.length; t += 1) {
      const next = new Set();
      for (const j of states) {
        for (const syllable of tokens[t]) {
          const rest = q.length - j;
          if (rest >= syllable.length && q.startsWith(syllable, j)) {
            if (rest === syllable.length) return true;
            next.add(j + syllable.length);
          }
          if (q[j] === syllable[0]) {
            if (rest === 1) return true;
            next.add(j + 1);
          }
          if (rest < syllable.length && syllable.startsWith(q.slice(j))) return true;
        }
      }
      if (next.size === 0) return false;
      states = next;
    }
    return false;
  }

  /**
   * 拼音命中：2 = 从标签第一个字开始命中，3 = 从中间某个字开始。
   * 只有纯字母数字查询才走这里；带 @ 、空格以外标点的查询照旧走字面，
   * 免得「xiao@」这种半截输入被拼音规则猜出奇怪结果。
   */
  function pinyinMatch(label, query) {
    const q = String(query == null ? "" : query).trim().toLowerCase().replace(/\s+/g, "");
    if (!q || q.length > PINYIN_MAX_QUERY || !PINYIN_QUERY_RE.test(q)) return null;
    const text = String(label == null ? "" : label);
    if (!text || text.length > PINYIN_MAX_LABEL) return null;
    const map = getPinyinMap();
    if (!map) return null;
    let hasHanzi = false;
    for (const ch of text) {
      if (map.has(ch)) {
        hasHanzi = true;
        break;
      }
    }
    if (!hasHanzi) return null;

    const tokens = labelTokens(text, map);
    if (!tokens.length) return null;
    if (matchTokens(tokens, 0, q)) return 2;
    for (let start = 1; start < tokens.length; start += 1) {
      // 从中间开始时，查询首字母必须能对上那个字的某个读音，否则整段跳过——
      // 少了这一步，长标签会被逐字试探，白跑几十次不可能命中的匹配。
      if (!tokens[start].some(syllable => syllable[0] === q[0])) continue;
      if (matchTokens(tokens, start, q)) return 3;
    }
    return null;
  }

  /**
   * 表单里账号框的候选（Q7=A）：平台精确命中已有平台时只列该平台的用户名，
   * 否则（空、或正在敲一个库里没有的新平台）列全部用户名。
   * 去重按 normalizeKey，保留首次出现顺序。
   */
  function formAccountOptions(entries, platformText) {
    const key = normalizeKey(platformText);
    const scoped = key
      ? entries.filter(entry => normalizeKey(entry.platform) === key)
      : [];
    const source = scoped.length > 0 ? scoped : entries;
    const seen = new Set();
    const list = [];
    for (const entry of source) {
      const username = String(entry.username == null ? "" : entry.username).trim();
      if (!username) continue;
      const dedupeKey = normalizeKey(username);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      list.push(username);
    }
    return list;
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

  /* ============================================================
     生成器插件
     插件 = 一段 JS + 一个 register 调用。这里只做登记、校验、执行，
     不碰 DOM、不碰文件系统，因此可以在 Node 里直接单测。
     ============================================================ */

  const GEN_MAX_LENGTH = 1024;
  const GEN_MAX_FIELD = 200;
  const GEN_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const GEN_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function genError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  function messageOf(err) {
    if (err == null) return "未知错误";
    if (typeof err === "string") return err;
    return err.message ? String(err.message) : String(err);
  }

  /**
   * 规范化插件声明的输入字段。
   * 不同算法输入不同，字段由插件自己定；这里只保证渲染所需的最小契约。
   * 缺 key/label 一律算定义不完整——错误要停在加载阶段，别等用户点开视图才炸。
   */
  function normalizeGeneratorFields(fields) {
    if (fields == null) return [];
    if (!Array.isArray(fields)) throw genError("gen_bad_def", "fields 必须是数组。");
    return fields.map((field, index) => {
      const where = `第 ${index + 1} 个输入字段`;
      if (!field || typeof field !== "object") throw genError("gen_bad_def", `${where}不是对象。`);
      const key = String(field.key == null ? "" : field.key).trim();
      if (!GEN_KEY_RE.test(key)) throw genError("gen_bad_def", `${where}的 key 不合法。`);
      const label = String(field.label == null ? "" : field.label).trim();
      if (!label) throw genError("gen_bad_def", `${where}缺少 label。`);
      return {
        key,
        label,
        placeholder: typeof field.placeholder === "string" ? field.placeholder : "",
        required: Boolean(field.required),
        maxLength: clampInt(
          field.maxLength == null ? GEN_MAX_FIELD : field.maxLength,
          1,
          GEN_MAX_FIELD,
          GEN_MAX_FIELD
        )
      };
    });
  }

  /** 校验并规范化一个生成器定义。不合法就抛 gen_bad_def，原因直接给用户看。 */
  function normalizeGeneratorDef(def) {
    if (!def || typeof def !== "object") throw genError("gen_bad_def", "缺少生成器定义。");
    const id = String(def.id == null ? "" : def.id).trim();
    if (!GEN_ID_RE.test(id)) throw genError("gen_bad_def", "id 只能用小写字母、数字和短横线。");
    const name = String(def.name == null ? "" : def.name).trim();
    if (!name) throw genError("gen_bad_def", "缺少 name。");
    if (typeof def.generate !== "function") throw genError("gen_bad_def", "缺少 generate 函数。");
    return { id, name, fields: normalizeGeneratorFields(def.fields), generate: def.generate };
  }

  /**
   * 注册表。插件里调 PassletGenerators.register(...) 就是调它。
   * 重名直接拒绝：界面要靠 id 认生成器，允许重名会出现“复制的不是看到的那个”。
   */
  function createGeneratorRegistry() {
    const items = [];
    const problems = [];
    return {
      register(def) {
        const item = normalizeGeneratorDef(def);
        if (items.some(existing => existing.id === item.id)) {
          throw Object.assign(
            genError("gen_dup_id", `生成器 “${item.id}” 与已有生成器重名，已跳过。`),
            { generatorId: item.id }
          );
        }
        items.push(item);
        return item;
      },
      list() {
        return items.slice();
      },
      get(id) {
        for (const item of items) if (item.id === id) return item;
        return null;
      },
      addProblem(file, message) {
        problems.push({ file, message });
      },
      problems() {
        return problems.slice();
      }
    };
  }

  /**
   * 执行一份插件源码。用 new Function 而不是 eval：作用域里只注入 PassletGenerators，
   * 插件拿不到本文件的任何变量。
   * 返回 true 只说明这段代码没抛错，不代表它真的注册了能用生成器。
   */
  function loadGeneratorSource(registry, source, file) {
    let factory;
    try {
      factory = new Function("PassletGenerators", source);
    } catch (err) {
      registry.addProblem(file, `“${file}”加载失败：${messageOf(err)}`);
      return false;
    }
    try {
      factory(registry);
    } catch (err) {
      if (err && err.code === "gen_dup_id") {
        registry.addProblem(file, `“${file}”里的${err.message}`);
      } else if (err && err.code === "gen_bad_def") {
        registry.addProblem(file, `“${file}”里的生成器定义不完整：${err.message}`);
      } else {
        registry.addProblem(file, `“${file}”加载失败：${messageOf(err)}`);
      }
      return false;
    }
    return true;
  }

  /** 必填字段没填就不算，返回提示文案；通过返回 null。 */
  function validateGeneratorInputs(def, inputs) {
    if (!def) return null;
    for (const field of def.fields) {
      if (!field.required) continue;
      const value = inputs && inputs[field.key];
      if (!value) return `请先填写“${field.label}”。`;
    }
    return null;
  }

  /**
   * 跑一次生成器。插件是外部代码，所以"返回得不对"和"抛错"都在这里收成结构体，
   * 调用方不需要 try/catch。
   */
  function runGenerator(def, inputs) {
    if (!def) return { ok: false, code: "gen_missing", message: "找不到这个生成器。" };
    let output;
    try {
      output = def.generate(inputs || {});
    } catch (err) {
      return { ok: false, code: "gen_throw", message: `生成失败：${messageOf(err)}` };
    }
    if (typeof output !== "string" || !output) {
      return { ok: false, code: "gen_empty", message: "这个生成器没有返回密码。" };
    }
    if ([...output].length > GEN_MAX_LENGTH) {
      return {
        ok: false,
        code: "gen_too_long",
        message: `生成结果超过 ${GEN_MAX_LENGTH} 个字符，请检查规则。`
      };
    }
    if (/[\u0000-\u001f\u007f]/.test(output)) {
      return { ok: false, code: "gen_control_chars", message: "生成结果里有换行或控制字符，无法使用。" };
    }
    return { ok: true, value: output };
  }

  /**
   * 实时生成时每敲一下都会重算，结果没变就不能再写剪贴板——
   * 否则用户刚复制的东西会被同一串字符反复刷掉。
   */
  function shouldAutoCopy(value, lastCopied) {
    return Boolean(value) && value !== lastCopied;
  }

  /** 输入长度上限。不靠 input 的 maxlength：粘贴时它管不住。 */
  function clampFieldValue(value, maxLength) {
    const text = String(value == null ? "" : value);
    const limit = clampInt(maxLength, 1, GEN_MAX_FIELD, GEN_MAX_FIELD);
    const chars = [...text];
    return chars.length > limit ? chars.slice(0, limit).join("") : text;
  }

  /**
   * 下拉的按键决策（纯函数，便于单测；DOM 部分留给 app.js）。
   * 输入：按键名 + 当前状态（弹层是否打开、候选数、是否在输入法组合输入中）。
   * 输出：open（把弹层叫出来）/ close（只收弹层）/ next / prev / accept，或 null（不接管）。
   *
   * 组合输入期间一律返回 null：那时 Enter 是给输入法上屏的，接管会把中文打不出来。
   */
  function comboAction(key, state) {
    const s = state || {};
    if (s.composing) return null;
    const open = Boolean(s.open);
    const count = Number(s.count) > 0 ? Number(s.count) : 0;
    if (key === "Enter") return open && count > 0 ? "accept" : null;
    if (key === "Escape") return open ? "close" : null;
    if (key !== "ArrowDown" && key !== "ArrowUp") return null;
    if (!open) return "open";
    if (count === 0) return null;
    return key === "ArrowDown" ? "next" : "prev";
  }

  root.PassletLogic = {
    normalizeKey,
    matchScore,
    filterOptions,
    filterEntries,
    setPinyinTable,
    getPinyinMap,
    pinyinMatch,
    formAccountOptions,
    comboAction,
    clampInt,
    maskText,
    validateEntry,
    validateMasterInput,
    validateBackupPassword,
    masterStateLines,
    GEN_MAX_LENGTH,
    createGeneratorRegistry,
    loadGeneratorSource,
    normalizeGeneratorDef,
    normalizeGeneratorFields,
    validateGeneratorInputs,
    runGenerator,
    shouldAutoCopy,
    clampFieldValue
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
