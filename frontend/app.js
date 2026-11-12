// 演示模式：没有 Tauri 运行时（浏览器里直接打开预览）时，套一层示意窗口边框并显示目标尺寸。
// 放在这里而不是 index.html 的内联脚本里：应用启用了 CSP，内联脚本会被拦掉。
if (!("__TAURI_INTERNALS__" in window)) document.documentElement.classList.add("demo");

// 界面控制器：视图状态机 + 渲染 + 事件。
// 与 logic.js、api.js 一样用经典脚本（无 import/export），这样 file:// 双击打开也能跑。
const api = globalThis.PassletApi;
const {
  filterOptions,
  filterEntries,
  clampInt,
  maskText,
  normalizeKey,
  validateEntry,
  validateMasterInput,
  validateBackupPassword,
  masterStateLines,
  createGeneratorRegistry,
  loadGeneratorSource,
  validateGeneratorInputs,
  runGenerator,
  shouldAutoCopy,
  clampFieldValue
} = globalThis.PassletLogic;

/* ============================================================
   图标：全部内联 SVG，程序里不出现 emoji
   ============================================================ */
const ICON = {
  eye: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"></path><circle cx="12" cy="12" r="2.8"></circle></svg>',
  eyeOff: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 6.1A9.6 9.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-2.7 3.5"></path><path d="M6.2 7.6A17 17 0 0 0 2 12s3.6 6.5 10 6.5c1.3 0 2.5-.3 3.6-.7"></path></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"></path></svg>',
  edit: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z"></path></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"></path><path d="M9 7V5h6v2"></path><path d="M6.5 7l.8 12.2h9.4L17.5 7"></path><path d="M10.5 11v5M13.5 11v5"></path></svg>'
};

const $ = selector => document.querySelector(selector);

const SIZES = {
  error: [462, 272],
  query: [462, 214],
  list: [840, 474],
  settings: [620, 560],
  generator: [462, 380]
};

// 停止输入多久之后自动写剪贴板。不到一秒会让"边打边算"的中间结果一路刷进剪贴板。
const AUTO_COPY_DELAY = 1000;

// 生成视图结果区在"还没有结果"时显示的占位文案
const GEN_IDLE_HINT = "填写上面的输入后自动生成";

/* ============================================================
   状态
   ============================================================ */
const S = {
  view: "query",
  entries: [],
  config: null,
  plat: null,
  user: null,
  pwdVisible: false,
  filter: "",
  secrets: new Map(),
  revealed: new Set(),
  rowTimers: new Map(),
  pwdTimer: null,
  vaultPathText: "",
  master: null,
  // 换主密码后环境变量没写成功时置位：这一行要一直提醒到下次写入成功
  masterSyncFailed: false,
  // 从查询页还是清单页进设置/生成视图：返回按钮要回同一边
  backTo: "list",
  // 生成器插件：每次进视图都重新扫描，改完插件文件不必重启
  generators: [],
  gen: null,
  genInputs: {},
  genResult: "",
  genCopied: "",
  genTimer: null,
  genSizeTimer: null,
  // 上一次告诉后端的生成视图高度：宽度变了要重量，但只有真的变了才再发一次
  genSentHeight: 0,
  genDir: "",
  genProblems: [],
};

/* ============================================================
   通用小工具
   ============================================================ */
function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function toastError(err) {
  toast(err && err.message ? err.message : String(err));
}

/** 统一把异步操作包起来：出错就提示，不让 Promise 悬着。 */
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    toastError(err);
    return null;
  }
}

function secondsForHide() {
  return S.config ? S.config.hidePasswordSeconds : 30;
}

/* ============================================================
   主题
   ============================================================ */
const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function themeMode() {
  if (S.themeOverride) return S.themeOverride;
  return (S.config && S.config.theme) || "system";
}

/** 把配置里的三态（跟随系统/浅色/深色）解析成实际要用的主题。 */
function resolvedTheme(mode) {
  if (mode === "light" || mode === "dark") return mode;
  return darkQuery && darkQuery.matches ? "dark" : "light";
}

function applyTheme() {
  // daisyUI 靠 html 上的 data-theme 切主题，所以这里只改属性，不碰任何样式规则
  const mode = themeMode();
  document.documentElement.dataset.theme = resolvedTheme(mode);
  // 原生标题栏不归 CSS 管，得让 Rust 侧同步一次（预览环境没有这个命令，忽略失败）
  if (api.setWindowTheme) api.setWindowTheme(mode).catch(() => {});
}

if (darkQuery) {
  const onSchemeChange = () => {
    // 只有“跟随系统”时才响应系统切换；用户手动选了浅/深就不要再被系统带跑
    if (!S.themeOverride && themeMode() === "system") applyTheme();
  };
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", onSchemeChange);
  else if (darkQuery.addListener) darkQuery.addListener(onSchemeChange);
}

/* ============================================================
   视图切换
   ============================================================ */
async function showView(view) {
  // 设置与生成视图有两个入口（查询页 / 清单页），返回时要回到进来那一边
  if ((view === "settings" || view === "generator") && (S.view === "query" || S.view === "list")) {
    S.backTo = S.view;
  }

  if (S.view !== view) {
    S.revealed.clear();
    S.rowTimers.forEach(timer => clearTimeout(timer));
    S.rowTimers.clear();
    clearTimeout(S.pwdTimer);
    // 离开生成视图就把结果丢掉：它不该跟着会话留在内存里
    if (S.view === "generator") resetGenerator();
  }

  S.view = view;
  $("#app").dataset.view = view;
  updateSizeTag();

  if (view !== "query") {
    // 查询页是唯一持有"当前选中"的地方，离开时把明文收起来
    S.pwdVisible = false;
  }
  renderPassword();
  renderQueryCombos();
  if (view === "list") renderList();
  if (view === "settings") renderSettings();
  if (view === "generator") await loadGenerators();

  // 回到查询页只丢掉 WebView 里缓存的明文。
  // 不要在这里 lock()——查询页本身要靠 get_secret 取密码显示，
  // 一旦锁掉会话，眼睛按钮会一直处于禁用态。
  if (view === "query") {
    S.secrets.clear();
    renderPassword();
  }
  const height = view === "generator" ? generatorContentHeight() : null;
  if (height) S.genSentHeight = height;
  await api.setView(view, height);
  // 刚量到的高度是按"上一个视图的宽度"算的（清单页 840 宽），窗口收窄后文字可能多折一行。
  // 等尺寸落地再量一次；比对用的是 showView 自己刚发出去的那个值，没变就不补发。
  if (view === "generator") syncGeneratorSize(60);
}

// 进程退出时尽力通知后端丢弃密钥（收不到也无所谓：进程结束 Zeroizing 会自动清零）
window.addEventListener("pagehide", () => {
  if (api.lock) api.lock().catch(() => {});
});

function updateSizeTag() {
  const size = (S.config && S.config.windowSizes && S.config.windowSizes[S.view]) || SIZES[S.view];
  $("#sizeTag").textContent = `${size[0]} × ${size[1]}`;
}

/* ============================================================
   错误视图
   ============================================================ */
function showError(status) {
  const map = {
    env_missing: {
      title: "没有读到主密码",
      text: "环境变量 PASSLET_MASTER 没有设置，程序无法解开密码库。设置后点“重新读取”。",
      cmd: 'setx PASSLET_MASTER "你的主密码"'
    },
    decrypt_failed: {
      title: "打不开密码库",
      text: "主密码不对，或者数据文件已损坏。如果刚改过环境变量，请确认它和原来的主密码一致。",
      cmd: ""
    },
    corrupt: {
      title: "这个文件不是 Passlet 的数据文件",
      text: "数据文件头部标记不匹配，可能被别的程序改过，或者不是 Passlet 生成的。",
      cmd: ""
    },
    version: {
      title: "数据文件版本比程序新",
      text: "请升级 Passlet 后再打开这个数据文件。",
      cmd: ""
    }
  };
  const info = map[status && status.reason] || map.decrypt_failed;

  $("#errTitle").textContent = info.title;
  $("#errText").textContent = info.text;

  const cmd = $("#errCmd");
  cmd.hidden = !info.cmd;
  cmd.textContent = info.cmd;

  $("#errCopy").hidden = !info.cmd;
  // 没读到主密码、或环境变量里的密码解不开库，都能当场改掉；
  // 文件损坏 / 版本太新这两类改环境变量没用，别给错误的出路
  const canFix = status && (status.reason === "env_missing" || status.reason === "decrypt_failed");
  $("#errSetMaster").hidden = !canFix;
  $("#app").dataset.view = "error";
  S.view = "error";
  updateSizeTag();
  // 错误页比查询页高：窗口按错误页尺寸单独要一次，失败也不影响错误提示本身
  api.setView("error", null).catch(() => {});
}

$("#errCopy").addEventListener("click", async () => {
  await guard(async () => {
    await api.copyText($("#errCmd").textContent);
    toast("命令已复制，粘到命令提示符里执行");
  });
});

$("#errRetry").addEventListener("click", () =>
  guard(async () => {
    const status = await api.bootstrap();
    if (!status.masterLoaded) {
      showError(status);
      return;
    }
    await afterUnlocked();
  })
);

$("#errSetMaster").addEventListener("click", () => guard(() => openMasterModal()));

/* ============================================================
   查询视图：两个联动下拉
   ============================================================ */
const COMBO = {
  plat: { root: "#comboPlat", input: "#platInput", pop: "#popPlat" },
  user: { root: "#comboUser", input: "#userInput", pop: "#popUser" }
};
let openCombo = null;

function platformList() {
  const seen = new Set();
  const list = [];
  for (const entry of S.entries) {
    const key = normalizeKey(entry.platform);
    if (!seen.has(key)) {
      seen.add(key);
      list.push(entry.platform);
    }
  }
  return list;
}

function userList(platform) {
  if (!platform) return [];
  return S.entries
    .filter(entry => normalizeKey(entry.platform) === normalizeKey(platform))
    .map(entry => entry.username);
}

function currentEntry() {
  if (!S.plat || !S.user) return null;
  return S.entries.find(entry =>
    normalizeKey(entry.platform) === normalizeKey(S.plat)
    && normalizeKey(entry.username) === normalizeKey(S.user)
  ) || null;
}

function setComboOpen(which, open) {
  openCombo = open ? which : (openCombo === which ? null : openCombo);
  for (const key of Object.keys(COMBO)) {
    $(COMBO[key].root).classList.toggle("open", openCombo === key);
  }
  if (open) renderPop(openCombo);
}

function renderPop(which) {
  renderPopContent(which);
  if (which) fitPop($(COMBO[which].pop));
}

/**
 * 弹层按可用空间收放。查询页只有 214 高，用户名行的弹层往下放会被窗口切掉，
 * 所以下方放不下就翻到输入框上方，最大高度收到真能放下的量。
 */
function fitPop(pop) {
  const field = pop.parentElement && pop.parentElement.querySelector(".combo-field");
  if (!field) return;

  const fieldRect = field.getBoundingClientRect();
  const appRect = document.getElementById("app").getBoundingClientRect();
  const margin = 12;
  const below = appRect.bottom - fieldRect.bottom - margin;
  const above = fieldRect.top - appRect.top - margin;
  const wanted = Math.min(150, pop.scrollHeight);

  const up = below < wanted && above > below;
  pop.classList.toggle("up", up);
  pop.style.maxHeight = `${Math.max(56, Math.min(150, up ? above : below))}px`;
}

function renderPopContent(which) {
  if (!which) return;
  const conf = COMBO[which];
  const input = $(conf.input);
  const pop = $(conf.pop);
  const disabled = which === "user" && !S.plat;

  if (disabled) {
    pop.innerHTML = '<div class="opt none">请先选择平台</div>';
    return;
  }

  const all = which === "plat" ? platformList() : userList(S.plat);
  const options = filterOptions(all, input.value);
  const selectedValue = which === "plat" ? S.plat : S.user;

  if (!options.length) {
    pop.innerHTML = all.length
      ? `<div class="opt none">没有匹配的${which === "plat" ? "平台" : "用户名"}</div>`
      : `<div class="opt none">${which === "plat" ? "还没有密码，点“打开清单”新增" : "这个平台下没有其他用户名"}</div>`;
    return;
  }

  pop.innerHTML = options.map(value => {
    const selected = selectedValue && normalizeKey(value) === normalizeKey(selectedValue);
    return `<div class="opt${selected ? " sel" : ""}" data-value="${esc(value)}">${esc(value)}</div>`;
  }).join("");
}

function renderQueryCombos() {
  const platInput = $("#platInput");
  const userInput = $("#userInput");

  if (document.activeElement !== platInput) platInput.value = S.plat || "";
  platInput.placeholder = platformList().length ? "请选择平台" : "库里还没有记录";

  const userEnabled = Boolean(S.plat);
  $("#comboUser").classList.toggle("disabled", !userEnabled);
  userInput.disabled = !userEnabled;
  if (document.activeElement !== userInput) userInput.value = S.user || "";
  userInput.placeholder = userEnabled ? "请选择用户名" : "请先选择平台";

  for (const key of Object.keys(COMBO)) {
    $(COMBO[key].root).classList.toggle("open", openCombo === key);
  }
}

function selectPlatform(value) {
  S.plat = value;
  S.user = null;

  const users = userList(value);
  if (users.length === 1) S.user = users[0];

  S.pwdVisible = false;
  openCombo = null;
  renderQueryCombos();
  // 只重绘掩码：明文要等用户点"显示"才从后端取，选中不等于同意展示
  renderPassword();
}

function selectUser(value) {
  S.user = value;
  S.pwdVisible = false;
  openCombo = null;
  renderQueryCombos();
  renderPassword();
}

function renderPassword() {
  const box = $("#pwdBox");
  const entry = currentEntry();
  const secret = entry ? S.secrets.get(entry.id) : null;

  box.classList.toggle("empty", !entry);
  box.classList.toggle("has-value", Boolean(entry));
  box.classList.toggle("revealed", Boolean(entry) && S.pwdVisible && secret != null);

  box.querySelector(".mask").textContent = maskText();
  box.querySelector(".plain").textContent = secret || "";

  const eye = $("#btnEye");
  const copy = $("#btnCopy");
  // 只要选中了记录，眼睛就该可点：密码可能还在路上，点击时再等它
  eye.disabled = !entry;
  copy.disabled = !entry;

  eye.classList.toggle("on", S.pwdVisible && secret != null);
  eye.innerHTML = S.pwdVisible && secret != null ? ICON.eyeOff : ICON.eye;
  eye.title = S.pwdVisible ? "隐藏密码" : "显示密码";
}

function startHideTimer() {
  clearTimeout(S.pwdTimer);
  const seconds = secondsForHide();
  if (!seconds) return;
  S.pwdTimer = setTimeout(() => {
    S.pwdVisible = false;
    renderPassword();
  }, seconds * 1000);
}

// 下拉打开
$("#platInput").addEventListener("focus", () => setComboOpen("plat", true));
$("#platInput").addEventListener("input", () => {
  setComboOpen("plat", true);
  renderPop("plat");
});
$("#userInput").addEventListener("focus", () => {
  if (S.plat) setComboOpen("user", true);
});
$("#userInput").addEventListener("input", () => {
  if (!S.plat) return;
  setComboOpen("user", true);
  renderPop("user");
});

// 选择（用 pointerdown，抢在 blur 之前）
$("#popPlat").addEventListener("pointerdown", event => {
  const opt = event.target.closest(".opt[data-value]");
  if (!opt) return;
  event.preventDefault();
  selectPlatform(opt.dataset.value);
  $("#platInput").blur();
});
$("#popUser").addEventListener("pointerdown", event => {
  const opt = event.target.closest(".opt[data-value]");
  if (!opt) return;
  event.preventDefault();
  selectUser(opt.dataset.value);
  $("#userInput").blur();
});

// 失焦时把输入框还原成"已选值"，避免留下一个看起来像已选、实际没选的字符串
$("#platInput").addEventListener("blur", () => {
  const typed = $("#platInput").value;
  const hit = platformList().find(item => normalizeKey(item) === normalizeKey(typed));
  if (hit) selectPlatform(hit);
  else {
    $("#platInput").value = S.plat || "";
    openCombo = null;
    renderQueryCombos();
  }
});
$("#userInput").addEventListener("blur", () => {
  const typed = $("#userInput").value;
  const hit = S.plat
    ? userList(S.plat).find(item => normalizeKey(item) === normalizeKey(typed))
    : null;
  if (hit) selectUser(hit);
  else {
    $("#userInput").value = S.user || "";
    openCombo = null;
    renderQueryCombos();
  }
});

document.addEventListener("pointerdown", event => {
  if (!openCombo) return;
  if (event.target.closest(".combo")) return;
  openCombo = null;
  renderQueryCombos();
});

// 密码区的眼睛与复制
$("#btnEye").addEventListener("click", () =>
  guard(async () => {
    const entry = currentEntry();
    if (!entry) return;

    // 密码可能还没取回来（选中后是异步拉取的），这里等一下再切，避免"点了没反应"
    let secret = S.secrets.get(entry.id);
    if (secret == null) {
      secret = await guard(() => api.getSecret(entry.id));
      if (secret == null) return;
      S.secrets.set(entry.id, secret);
    }

    S.pwdVisible = !S.pwdVisible;
    renderPassword();
    if (S.pwdVisible) startHideTimer();
    else clearTimeout(S.pwdTimer);
  })
);

$("#btnCopy").addEventListener("click", () =>
  guard(async () => {
    const entry = currentEntry();
    if (!entry) return;
    await api.copySecret(entry.id);
    const tail = S.config && S.config.clipboardClearEnabled
      ? `，${S.config.clipboardClearSeconds} 秒后自动清空`
      : "";
    toast(`已复制“${entry.platform}”的密码${tail}`);
  })
);

$("#btnOpenList").addEventListener("click", () => {
  guard(async () => {
    await showView("list");
  });
});

/* ============================================================
   清单视图
   ============================================================ */
function renderList() {
  const rows = filterEntries(S.entries, S.filter);
  const listEl = $("#list");

  if (!rows.length) {
    listEl.innerHTML = `<div class="empty-state">${
      S.entries.length ? "没有匹配的条目" : "还没有密码，点右上角“＋ 新增”记一条"
    }</div>`;
  } else {
    listEl.innerHTML = rows.map(entry => {
      const revealed = S.revealed.has(entry.id);
      const secret = S.secrets.get(entry.id) || "";
      return `
        <div class="entry-row${revealed ? " revealed" : ""}" data-id="${esc(entry.id)}">
          <div class="cell plat" title="${esc(entry.platform)}">${esc(entry.platform)}</div>
          <div class="cell user" title="${esc(entry.username)}">${esc(entry.username)}</div>
          <div class="cell pwd"><span class="mask">${maskText()}</span><span class="plain">${esc(secret)}</span></div>
          <div class="cell act">
            <button class="btn btn-ghost btn-sm btn-square${revealed ? " on" : ""}" data-act="eye" title="${revealed ? "隐藏" : "显示"}">${revealed ? ICON.eyeOff : ICON.eye}</button>
            <button class="btn btn-ghost btn-sm btn-square" data-act="copy" title="复制密码">${ICON.copy}</button>
            <button class="btn btn-ghost btn-sm btn-square" data-act="edit" title="编辑">${ICON.edit}</button>
            <button class="btn btn-ghost btn-sm btn-square del" data-act="del" title="删除">${ICON.trash}</button>
          </div>
        </div>`;
    }).join("");
  }

  $("#countText").textContent = S.filter
    ? `匹配 ${rows.length} / 共 ${S.entries.length} 条`
    : `共 ${S.entries.length} 条`;
}

function clearRowTimer(id) {
  const timer = S.rowTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    S.rowTimers.delete(id);
  }
}

function startRowTimer(id) {
  clearRowTimer(id);
  const seconds = secondsForHide();
  if (!seconds) return;
  S.rowTimers.set(id, setTimeout(() => {
    S.revealed.delete(id);
    S.rowTimers.delete(id);
    renderList();
  }, seconds * 1000));
}

async function toggleRowSecret(id) {
  if (S.revealed.has(id)) {
    S.revealed.delete(id);
    clearRowTimer(id);
    renderList();
    return;
  }
  if (!S.secrets.has(id)) {
    const secret = await guard(() => api.getSecret(id));
    if (secret == null) return;
    S.secrets.set(id, secret);
  }
  S.revealed.add(id);
  renderList();
  startRowTimer(id);
}

$("#list").addEventListener("click", event => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  const row = button.closest(".entry-row");
  const id = row && row.dataset.id;
  if (!id) return;

  if (button.dataset.act === "eye") {
    guard(() => toggleRowSecret(id));
    return;
  }
  if (button.dataset.act === "copy") {
    guard(async () => {
      await api.copySecret(id);
      const entry = S.entries.find(item => item.id === id);
      const tail = S.config && S.config.clipboardClearEnabled
        ? `，${S.config.clipboardClearSeconds} 秒后自动清空`
        : "";
      toast(`已复制“${entry ? entry.platform : ""}”的密码${tail}`);
    });
    return;
  }
  if (button.dataset.act === "edit") {
    guard(() => openEntryModal(id));
    return;
  }
  if (button.dataset.act === "del") {
    guard(() => confirmDelete(id));
  }
});

$("#list").addEventListener("dblclick", event => {
  const row = event.target.closest(".entry-row");
  if (!row) return;
  guard(() => openEntryModal(row.dataset.id));
});

$("#filterInput").addEventListener("input", event => {
  S.filter = event.target.value;
  renderList();
});

$("#btnAdd").addEventListener("click", () => guard(() => openEntryModal(null)));

$("#btnBackFromList").addEventListener("click", () => guard(() => showView("query")));
$("#btnSettings").addEventListener("click", () => guard(() => showView("settings")));
$("#btnQuerySettings").addEventListener("click", () => guard(() => showView("settings")));
$("#btnQueryGenerator").addEventListener("click", () => guard(() => showView("generator")));
$("#btnBackFromSettings").addEventListener("click", () => guard(() => showView(S.backTo || "list")));

async function refreshEntries() {
  const list = await guard(() => api.listEntries());
  if (!list) return;
  S.entries = list;

  // 选中的记录可能已被删除或改名，收掉悬空的选择
  if (S.plat && !platformList().some(item => normalizeKey(item) === normalizeKey(S.plat))) {
    S.plat = null;
    S.user = null;
  }
  if (S.plat && S.user && !userList(S.plat).some(item => normalizeKey(item) === normalizeKey(S.user))) {
    S.user = null;
  }

  renderQueryCombos();
  renderPassword();
  renderList();
}

/* ============================================================
   弹层
   ============================================================ */
let modalEscHandler = null;
let modalOnClose = null;

function openModal({ title, body, buttons, onClose }) {
  closeModal();
  modalOnClose = onClose || null;
  const root = $("#modalRoot");
  root.innerHTML = `
    <div class="scrim open">
      <div class="dlg" role="dialog" aria-modal="true">
        <div class="dlg-head"></div>
        <div class="dlg-body"></div>
        <div class="dlg-foot"></div>
      </div>
    </div>`;

  root.querySelector(".dlg-head").textContent = title;
  const bodyEl = root.querySelector(".dlg-body");
  bodyEl.innerHTML = body;

  const foot = root.querySelector(".dlg-foot");
  const close = () => closeModal();

  for (const button of buttons) {
    const el = document.createElement("button");
    el.className = `btn${button.primary ? " primary" : ""}${button.danger ? " danger" : ""}`;
    el.textContent = button.label;
    el.addEventListener("click", () => button.onClick(close, el));
    foot.appendChild(el);
  }

  root.querySelector(".scrim").addEventListener("pointerdown", event => {
    if (event.target.classList.contains("scrim")) close();
  });

  modalEscHandler = event => {
    if (event.key === "Escape") closeModal();
  };
  document.addEventListener("keydown", modalEscHandler);

  return { root, body: bodyEl, close };
}

function closeModal() {
  if (modalEscHandler) {
    document.removeEventListener("keydown", modalEscHandler);
    modalEscHandler = null;
  }
  const notify = modalOnClose;
  modalOnClose = null;
  $("#modalRoot").innerHTML = "";
  // 无论是点按钮、按 Esc 还是点遮罩关闭，都要让等待方知道"用户放弃了"
  if (notify) notify();
}

async function openEntryModal(id) {
  const editing = Boolean(id);
  let secret = "";
  let entry = null;

  if (editing) {
    entry = S.entries.find(item => item.id === id);
    if (!entry) throw api.error("not_found", "这条记录已经不在了，可能被删掉了。");
    secret = S.secrets.has(id) ? S.secrets.get(id) : await api.getSecret(id);
  }

  const body = `
    <div class="form-field">
      <label for="fPlat">平台</label>
      <div class="wrap"><input class="input" id="fPlat" type="text" maxlength="200" autocomplete="off" placeholder="例如 GitHub、阿里云"></div>
    </div>
    <div class="form-field">
      <label for="fUser">用户名</label>
      <div class="wrap"><input class="input" id="fUser" type="text" maxlength="200" autocomplete="off" placeholder="账号或邮箱"></div>
    </div>
    <div class="form-field">
      <label for="fPwd">密码</label>
      <div class="wrap">
        <input class="input" id="fPwd" type="password" maxlength="1024" autocomplete="off" spellcheck="false">
        <button class="btn" id="fReveal" type="button">显示</button>
      </div>
    </div>`;

  const modal = openModal({
    title: editing ? "编辑密码" : "新增密码",
    body,
    buttons: [
      { label: "取消", onClick: close => close() },
      {
        label: "保存",
        primary: true,
        onClick: (close, button) =>
          guard(async () => {
            const platform = modal.body.querySelector("#fPlat").value;
            const username = modal.body.querySelector("#fUser").value;
            const password = modal.body.querySelector("#fPwd").value;

            const problem = validateEntry(platform, username, password);
            if (problem) {
              toast(problem);
              return;
            }

            button.disabled = true;
            try {
              if (editing) await api.updateEntry(id, platform, username, password);
              else await api.addEntry(platform, username, password);

              S.secrets.delete(id);
              close();
              await refreshEntries();
              toast(editing ? "已保存" : `已新增“${platform.trim()}”`);
            } finally {
              button.disabled = false;
            }
          })
      }
    ]
  });

  const platInput = modal.body.querySelector("#fPlat");
  const userInput = modal.body.querySelector("#fUser");
  const pwdInput = modal.body.querySelector("#fPwd");
  const reveal = modal.body.querySelector("#fReveal");

  if (editing) {
    platInput.value = entry.platform;
    userInput.value = entry.username;
    pwdInput.value = secret;
    S.secrets.set(id, secret);
  }

  reveal.addEventListener("click", () => {
    const showing = pwdInput.type === "password";
    pwdInput.type = showing ? "text" : "password";
    reveal.textContent = showing ? "隐藏" : "显示";
  });

  setTimeout(() => platInput.focus(), 0);
}

function confirmDelete(id) {
  const entry = S.entries.find(item => item.id === id);
  if (!entry) throw api.error("not_found", "这条记录已经不在了，可能被删掉了。");

  openModal({
    title: "删除这条记录",
    body: `<p>将删除“${esc(entry.platform)}”下的“${esc(entry.username)}”。删除后无法恢复。</p>`,
    buttons: [
      { label: "取消", onClick: close => close() },
      {
        label: "删除",
        danger: true,
        onClick: (close, button) =>
          guard(async () => {
            button.disabled = true;
            try {
              await api.deleteEntry(id);
              S.secrets.delete(id);
              S.revealed.delete(id);
              clearRowTimer(id);
              close();
              await refreshEntries();
              toast("已删除");
            } finally {
              button.disabled = false;
            }
          })
      }
    ]
  });
}

/* ============================================================
   设置视图
   ============================================================ */
function renderSettings() {
  if (!S.config) return;
  $("#selTheme").value = themeMode();
  $("#chkClipboard").checked = S.config.clipboardClearEnabled;
  $("#numClipboardSeconds").value = S.config.clipboardClearSeconds;
  $("#numClipboardSeconds").disabled = !S.config.clipboardClearEnabled;
  $("#numHideSeconds").value = S.config.hidePasswordSeconds;
  updateSizeTag();
  refreshMasterState();

  // 数据文件路径只在第一次进设置页时取，之后复用
  if (!S.vaultPathText) {
    api.vaultPath().then(path => {
      S.vaultPathText = path;
      $("#pathText").textContent = path;
      $("#pathText").title = path;
    }).catch(() => {
      $("#pathText").textContent = "读取失败";
    });
  } else {
    $("#pathText").textContent = S.vaultPathText;
  }
}

async function patchConfig(patch) {
  const next = { ...S.config, ...patch };
  const saved = await guard(() => api.saveConfig(next));
  if (!saved) {
    renderSettings();
    return;
  }
  S.config = saved;
  applyTheme();
  renderSettings();
}

$("#selTheme").addEventListener("change", event => {
  S.themeOverride = null;
  patchConfig({ theme: event.target.value });
});

$("#chkClipboard").addEventListener("change", event =>
  patchConfig({ clipboardClearEnabled: event.target.checked })
);

$("#numClipboardSeconds").addEventListener("change", event =>
  patchConfig({ clipboardClearSeconds: clampInt(event.target.value, 1, 600, 30) })
);

$("#numHideSeconds").addEventListener("change", event =>
  patchConfig({ hidePasswordSeconds: clampInt(event.target.value, 0, 600, 30) })
);

$("#btnCopyPath").addEventListener("click", () =>
  guard(async () => {
    const path = await api.vaultPath();
    await api.copyText(path);
    toast("路径已复制");
  })
);

$("#btnExport").addEventListener("click", event =>
  guard(async () => {
    // 必须在第一个 await 之前取：事件派发结束后 currentTarget 会被置空
    const button = event.currentTarget;
    const password = await askExportPassword();
    if (!password) return;
    button.disabled = true;
    try {
      const result = await api.exportVault(password);
      if (result && result.path) toast(`已导出到 ${result.path}`);
    } finally {
      button.disabled = false;
    }
  })
);

$("#btnImport").addEventListener("click", () =>
  guard(async () => {
    const path = await api.pickImportFile();
    if (!path) return;
    const report = await runImport(path);
    if (!report) return;
    await refreshEntries();
    showImportReport(report);
  })
);

/** 导出前先要一个只属于这份备份的密码：它不参与打开库，换主密码也不会让它失效。 */
function askExportPassword() {
  return new Promise(resolve => {
    const modal = openModal({
      title: "导出加密备份",
      body: `
        <p>给这份备份设一个独立密码，可以和主密码不同。</p>
        <p>它只用来保护导出的文件：以后换主密码不影响它，把备份交给别人也不必交出主密码。</p>
        <div class="form-field">
          <label for="bPass">备份密码</label>
          <div class="wrap"><input class="input" id="bPass" type="password" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="form-field">
          <label for="bPass2">再输一次</label>
          <div class="wrap"><input class="input" id="bPass2" type="password" autocomplete="off" spellcheck="false"></div>
        </div>`,
      buttons: [
        { label: "取消", onClick: close => { resolve(null); close(); } },
        {
          label: "继续",
          primary: true,
          onClick: (close, button) => {
            const value = modal.body.querySelector("#bPass").value;
            const again = modal.body.querySelector("#bPass2").value;
            const problem = validateBackupPassword(value, again);
            if (problem) {
              toast(problem);
              return;
            }
            // 先定型再关闭：close() 会触发 onClose 的 resolve(null)
            resolve(value);
            close();
            button.blur();
          }
        }
      ],
      onClose: () => resolve(null)
    });
    setTimeout(() => modal.body.querySelector("#bPass").focus(), 0);
  });
}

/**
 * 导入弹窗：备份密码与合并方式放在一起，确定之前不需要后端往返。
 * 密码错了就在弹窗里报错并保持打开，用户改一下再试即可。
 */
function runImport(path) {
  return new Promise(resolve => {
    const modal = openModal({
      title: "导入备份",
      body: `
        <p>这份备份由导出时设的密码保护，输入那个密码即可。</p>
        <div class="form-field">
          <label for="iPass">备份密码</label>
          <div class="wrap"><input class="input" id="iPass" type="password" autocomplete="off" spellcheck="false"></div>
          <p class="ferr" id="iErr" hidden></p>
        </div>
        <p>选择这份备份与现有数据如何合并。</p>
        <label class="choice">
          <input type="radio" name="importMode" value="replace">
          <span><span class="t">整库替换</span><span class="d">先用当前库做一份带时间戳的备份，再用备份内容完全替换。</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="importMode" value="skip" checked>
          <span><span class="t">合并 · 跳过重复</span><span class="d">同平台且同用户名的条目跳过，其余追加。</span></span>
        </label>
        <label class="choice">
          <input type="radio" name="importMode" value="overwrite">
          <span><span class="t">合并 · 覆盖重复</span><span class="d">同平台且同用户名的用备份里的密码覆盖，其余追加。</span></span>
        </label>`,
      buttons: [
        { label: "取消", onClick: close => { resolve(null); close(); } },
        {
          label: "导入",
          primary: true,
          onClick: (close, button) => {
            const password = modal.body.querySelector("#iPass").value;
            if (!password.trim()) {
              showFormError(modal, "iErr", "备份密码不能为空。");
              return;
            }
            const picked = modal.body.querySelector('input[name="importMode"]:checked');
            const mode = picked ? picked.value : "skip";
            button.disabled = true;
            api
              .importFrom(path, mode, password)
              .then(report => {
                // 先定型再关闭：close() 会触发 onClose 的 resolve(null)
                resolve(report);
                close();
              })
              .catch(err => {
                showFormError(modal, "iErr", err && err.message ? err.message : String(err));
              })
              .finally(() => {
                button.disabled = false;
              });
          }
        }
      ],
      onClose: () => resolve(null)
    });
    setTimeout(() => modal.body.querySelector("#iPass").focus(), 0);
  });
}

/** 弹窗内的错误行：传空字符串就把它藏起来。 */
function showFormError(modal, id, text) {
  const el = modal.body.querySelector(`#${id}`);
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
}

function showImportReport(report) {
  const modeLabel = { replace: "整库替换", skip: "合并 · 跳过重复", overwrite: "合并 · 覆盖重复" }[report.mode] || report.mode;
  const lines = [`新增 ${report.added} 条`];
  if (report.skipped) lines.push(`跳过 ${report.skipped} 条`);
  if (report.replaced) lines.push(`覆盖 ${report.replaced} 条`);
  const backup = report.backupPath
    ? `<p>替换前的数据已备份为 ${esc(report.backupPath)}。</p>`
    : "";

  openModal({
    title: "导入完成",
    body: `<p>方式：${esc(modeLabel)}；${esc(lines.join("，"))}。</p>${backup}`,
    buttons: [{ label: "确定", primary: true, onClick: close => close() }]
  });
}

/* ---------- 主密码与环境变量 ---------- */

function renderMasterState() {
  const lines = S.masterSyncFailed
    ? { main: "环境变量与库不一致", note: "库密码已更换但环境变量没写成功，请点“设置/更新”重写一次。" }
    : masterStateLines(S.master);
  $("#masterStateMain").textContent = lines.main;
  $("#masterStateNote").textContent = lines.note;
  // 机器级的值本程序改不了、没有值时也没东西可清，这两种情况按钮只会骗人
  const active = S.master && S.master.active;
  $("#btnClearMaster").disabled = !active || active === "none" || active === "machine";
}

async function refreshMasterState() {
  const info = await guard(() => api.masterStatus());
  if (!info) return;
  S.master = info;
  renderMasterState();
}

/** 写入成功后的去向：从错误页进来的，直接把用户带进主界面。 */
async function continueAfterMasterSaved() {
  if (S.view !== "error") return;
  const status = await guard(() => api.bootstrap());
  if (!status) return;
  if (!status.masterLoaded) {
    showError(status);
    return;
  }
  await afterUnlocked();
}

async function openMasterModal() {
  const info = S.master || (await api.masterStatus());
  S.master = info;
  // 库还不存在时后端没法验证密码对不对，只能靠输两次防笔误
  const needsConfirm = !info.vaultExists;
  const confirmField = needsConfirm
    ? `<div class="form-field">
         <label for="mPass2">再输一次</label>
         <div class="wrap"><input class="input" id="mPass2" type="password" autocomplete="off" spellcheck="false"></div>
       </div>`
    : "";

  const modal = openModal({
    title: "设置主密码",
    body: `
      <p>保存后写进你的用户级环境变量，下次启动不必再输入。</p>
      <p>它以明文存在注册表里，任何以你身份运行的程序都能读到。</p>
      <div class="form-field">
        <label for="mPass">主密码</label>
        <div class="wrap"><input class="input" id="mPass" type="password" autocomplete="off" spellcheck="false"></div>
        <p class="ferr" id="mErr" hidden></p>
      </div>
      ${confirmField}`,
    buttons: [
      { label: "取消", onClick: close => close() },
      {
        label: "保存",
        primary: true,
        onClick: (close, button) => {
          (async () => {
            const value = modal.body.querySelector("#mPass").value;
            const again = needsConfirm ? modal.body.querySelector("#mPass2").value : undefined;
            const problem = validateMasterInput(value, again);
            if (problem) {
              showFormError(modal, "mErr", problem);
              return;
            }
            showFormError(modal, "mErr", "");
            button.disabled = true;
            try {
              S.master = await api.setMasterEnv(value);
            } catch (err) {
              // 只有这一步的错误属于“密码不对”，原因要留在弹窗里，别用两秒就消失的提示条
              showFormError(modal, "mErr", err && err.message ? err.message : String(err));
              button.disabled = false;
              return;
            }
            button.disabled = false;
            S.masterSyncFailed = false;
            renderMasterState();
            close();
            toast("已写入环境变量，本次运行立即生效。");
            // 弹窗已经关了，之后的失败只能走提示条；放进 try 里会被写进看不见的错误行
            await guard(() => continueAfterMasterSaved());
          })();
        }
      }
    ]
  });
  setTimeout(() => modal.body.querySelector("#mPass").focus(), 0);
}

function confirmClearMaster() {
  return new Promise(resolve => {
    openModal({
      title: "清除主密码",
      body: "<p>清除后下次启动会停在说明页，要求重新设置主密码。这次运行不受影响。</p>",
      buttons: [
        { label: "取消", onClick: close => { resolve(false); close(); } },
        {
          label: "清除",
          danger: true,
          onClick: close => {
            // 先定型再关闭：close() 会触发 onClose 的 resolve(false)
            resolve(true);
            close();
          }
        }
      ],
      onClose: () => resolve(false)
    });
  });
}

$("#btnSetMaster").addEventListener("click", () => guard(() => openMasterModal()));

$("#btnClearMaster").addEventListener("click", () =>
  guard(async () => {
    if (!(await confirmClearMaster())) return;
    const info = await api.clearMasterEnv();
    S.master = info;
    S.masterSyncFailed = false;
    renderMasterState();
    // 机器级的值删不掉，返回的 active 会照实说明它还在生效
    toast(info.active === "none" ? "环境变量已清除。" : "用户级的值已清除，机器级的值仍在生效。");
  })
);

$("#btnChangeMaster").addEventListener("click", () =>
  guard(async () => {
    const modal = openModal({
      title: "更换主密码",
      body: `
        <p>更换后会自动把新主密码写进环境变量，不需要你再手动改。</p>
        <div class="form-field">
          <label for="mNew">新主密码</label>
          <div class="wrap"><input class="input" id="mNew" type="password" autocomplete="off" spellcheck="false"></div>
        </div>
        <div class="form-field">
          <label for="mConfirm">再输一次</label>
          <div class="wrap"><input class="input" id="mConfirm" type="password" autocomplete="off" spellcheck="false"></div>
        </div>`,
      buttons: [
        { label: "取消", onClick: close => close() },
        {
          label: "更换",
          primary: true,
          onClick: (close, button) =>
            guard(async () => {
              const next = modal.body.querySelector("#mNew").value;
              const confirm = modal.body.querySelector("#mConfirm").value;
              if ([...next].length < 8) {
                toast("新主密码至少 8 位。");
                return;
              }
              if (next !== confirm) {
                toast("两次输入的密码不一样。");
                return;
              }
              button.disabled = true;
              try {
                const result = await api.changeMaster(next);
                close();
                S.masterSyncFailed = Boolean(result && result.synced === false);
                S.master = await api.masterStatus();
                renderMasterState();
                // 库密码这时已经换了，同步失败必须说清楚，否则用户以为一切正常
                toast(result && result.synced === false
                  ? `主密码已更换，但环境变量没写成功，请点“设置/更新”重试。（${result.message || "未知原因"}）`
                  : "主密码已更换，环境变量已同步。");
              } finally {
                button.disabled = false;
              }
            })
        }
      ]
    });
    setTimeout(() => modal.body.querySelector("#mNew").focus(), 0);
  })
);

/* ============================================================
   生成密码视图
   ============================================================ */

/** 每次进视图都重新扫一遍插件目录：改完插件文件切回来就是新结果，不必重启。 */
async function loadGenerators() {
  resetGenerator();
  const scan = await guard(() => api.listGenerators());

  S.generators = [];
  S.genProblems = [];
  S.genDir = scan ? scan.dir : "";

  if (scan) {
    const registry = createGeneratorRegistry();
    for (const file of scan.files) loadGeneratorSource(registry, file.source, file.file);
    S.generators = registry.list();
    S.genProblems = registry.problems();
    for (const warning of scan.warnings) S.genProblems.push({ file: "", message: warning });
  }

  S.gen = S.generators.length ? S.generators[0] : null;
  renderGenerator();
}

function renderGenerator() {
  const hasGenerator = S.generators.length > 0;
  $("#genPickRow").hidden = !hasGenerator;
  $("#genResultRow").hidden = !hasGenerator;
  $("#genEmpty").hidden = hasGenerator;
  $("#genDir").textContent = S.genDir || "—";

  if (hasGenerator) {
    const select = $("#selGenerator");
    const single = S.generators.length === 1;
    select.hidden = single;
    $("#genSingleName").hidden = !single;
    if (single) {
      $("#genSingleName").textContent = S.generators[0].name;
    } else {
      select.innerHTML = S.generators
        .map(item => `<option value="${esc(item.id)}">${esc(item.name)}</option>`)
        .join("");
      select.value = S.gen.id;
    }
  }

  renderGeneratorFields();
  renderGeneratorResult();
  renderGeneratorFoot();
}

/**
 * 生成视图的高度要跟着内容走：插件声明几个输入框是它的事，
 * 窗口不该为"可能的字段数"留一片死白。
 */
function generatorContentHeight() {
  const view = document.querySelector('.view[data-view="generator"]');
  if (!view) return null;
  const body = view.querySelector(".gbody");
  const children = Array.from(body.children).filter(el => !el.hidden);
  if (!children.length) return null;

  const app = document.getElementById("app");
  const top = app.getBoundingClientRect().top;
  const bottom = Math.max(...children.map(el => el.getBoundingClientRect().bottom));
  // 内容被后端上限夹住后 .gbody 会出现滚动条，滚过之后子元素在视口里整体上移，
  // 只靠 bottom - top 会越量越矮，而窗口是 resizable:false，量矮了用户改不回来。
  const scrolled = body.scrollTop || 0;
  // .gbody 的下内边距是 16px：最后一行不能贴着窗口边
  return Math.ceil(bottom - top + scrolled + 16);
}

/**
 * 把当前内容高度同步给后端。
 * 一律与"上一次发出去的高度"比对，值没变就不发——切生成器、提示行显隐都会走到这里，
 * 不该每次都多一条 IPC 和一次窗口重设。
 * `delay` 只用于"等窗口尺寸落地后再量"的场合，不改变比对规则。
 */
function syncGeneratorSize(delay = 0) {
  if (S.view !== "generator") return;
  clearTimeout(S.genSizeTimer);
  // 合并同一轮渲染里的多次调用：量一次、改一次窗口，避免连着重设尺寸
  S.genSizeTimer = setTimeout(async () => {
    S.genSizeTimer = null;
    if (S.view !== "generator") return;
    const height = generatorContentHeight();
    if (!height) return;
    if (height === S.genSentHeight) return;
    S.genSentHeight = height;
    try {
      await api.setView("generator", height);
    } catch {
      // 尺寸没设上不影响生成，下次渲染还会再试
    }
  }, delay);
}

function renderGeneratorFields() {
  const box = $("#genFields");
  const def = S.gen;

  if (!def || !def.fields.length) {
    box.innerHTML = "";
    // 不需要输入的生成器：进视图就出结果，但不自动复制——
    // 打开一个页面就改写用户的剪贴板，代价比省一次点击大。
    runGeneratorNow(false);
    return;
  }

  box.innerHTML = def.fields.map(field => `
    <div class="gfield">
      <label for="gf_${esc(field.key)}">${esc(field.label)}</label>
      <input class="input" id="gf_${esc(field.key)}" data-field="${esc(field.key)}"
        type="text" autocomplete="off" spellcheck="false"
        maxlength="${field.maxLength}"
        placeholder="${esc(field.placeholder)}"
        value="${esc(S.genInputs[field.key] || "")}">
    </div>`).join("");

  // 进视图/切换生成器时不算"用户输入变化"：字段全是选填的插件会在空输入下也算出结果，
  // 这时候改写剪贴板等于把用户刚复制的条目密码顶掉。
  runGeneratorNow(false);
}

/** 结果区占位行：必填没填属于“还没轮到算”，用灰字提示，不要拿红字吓人。 */
function showGeneratorHint(text) {
  const placeholder = $("#genPlaceholder");
  placeholder.textContent = text || GEN_IDLE_HINT;
  // 提示只占位不显示结果，两者不会同时出现
  if (text) renderGeneratorResult();
}

function showGeneratorProblem(text) {
  const box = $("#genProblem");
  const wasHidden = box.hidden;
  box.textContent = text || "";
  box.hidden = !text;
  // 提示行出现/消失会改变内容高度，只在真的变了时重量一次
  if (wasHidden !== box.hidden) syncGeneratorSize();
}

function renderGeneratorResult() {
  const text = S.genResult;
  $("#genResultText").textContent = text;
  $("#genResultBox").classList.toggle("empty", !text);
  $("#btnGenCopy").disabled = !text;
}

function renderGeneratorFoot() {
  const foot = $("#genFoot");
  const lines = S.genProblems.map(problem => esc(problem.message));
  if (S.generators.length) lines.push(`插件目录：<code>${esc(S.genDir)}</code>`);
  foot.innerHTML = lines.join("<br>");
  foot.hidden = lines.length === 0;
}

/** 跑一次并把结果放上界面；防抖交给 scheduleAutoCopy。 */
function runGeneratorNow(autoCopy) {
  clearTimeout(S.genTimer);
  S.genTimer = null;

  const def = S.gen;
  if (!def) {
    S.genResult = "";
    showGeneratorProblem("");
    showGeneratorHint("");
    renderGeneratorResult();
    return;
  }

  const missing = validateGeneratorInputs(def, S.genInputs);
  if (missing) {
    S.genResult = "";
    showGeneratorProblem("");
    showGeneratorHint(missing);
    renderGeneratorResult();
    return;
  }

  const result = runGenerator(def, S.genInputs);
  if (!result.ok) {
    S.genResult = "";
    showGeneratorProblem(result.message);
    renderGeneratorResult();
    return;
  }

  S.genResult = result.value;
  showGeneratorProblem("");
  showGeneratorHint("");
  renderGeneratorResult();
  if (autoCopy) scheduleAutoCopy();
}

/** 停止输入一会儿再写剪贴板：边打边算的中间结果不该进剪贴板。 */
function scheduleAutoCopy() {
  clearTimeout(S.genTimer);
  S.genTimer = null;
  if (!shouldAutoCopy(S.genResult, S.genCopied)) return;
  S.genTimer = setTimeout(() => {
    S.genTimer = null;
    copyGeneratorResult(false);
  }, AUTO_COPY_DELAY);
}

async function copyGeneratorResult(manual) {
  clearTimeout(S.genTimer);
  S.genTimer = null;

  const text = S.genResult;
  if (!text) return;

  try {
    await api.copyGenerated(text);
  } catch (err) {
    showGeneratorProblem(err && err.message ? err.message : String(err));
    return;
  }

  S.genCopied = text;
  showGeneratorProblem("");
  const tail = S.config && S.config.clipboardClearEnabled
    ? `，${S.config.clipboardClearSeconds} 秒后自动清空`
    : "";
  toast(manual ? `已复制生成的密码${tail}` : `已自动复制生成的密码${tail}`);
}

function resetGenerator() {
  clearTimeout(S.genTimer);
  S.genTimer = null;
  S.genInputs = {};
  S.genResult = "";
  S.genCopied = "";
  // 只清状态不清页面的话，明文还留在隐藏视图的节点里；离开视图就该看不见了
  showGeneratorProblem("");
  showGeneratorHint("");
  renderGeneratorResult();
}

$("#btnGenerator").addEventListener("click", () =>
  guard(async () => {
    await showView("generator");
  })
);

$("#btnBackFromGenerator").addEventListener("click", () =>
  guard(async () => {
    await showView(S.backTo || "list");
  })
);

$("#selGenerator").addEventListener("change", event => {
  const def = S.generators.find(item => item.id === event.target.value);
  if (!def) return;
  S.gen = def;
  // 换生成器等于换一套输入：旧结果留着会被误复制
  resetGenerator();
  showGeneratorProblem("");
  renderGeneratorFields();
  renderGeneratorResult();
  syncGeneratorSize();
});

$("#genFields").addEventListener("input", event => {
  const input = event.target.closest("[data-field]");
  if (!input || !S.gen) return;

  const field = S.gen.fields.find(item => item.key === input.dataset.field);
  if (!field) return;

  const value = clampFieldValue(input.value, field.maxLength);
  if (value !== input.value) input.value = value;
  S.genInputs[field.key] = value;
  runGeneratorNow(true);
});

$("#btnGenCopy").addEventListener("click", () => guard(() => copyGeneratorResult(true)));

$("#btnCopyGenDir").addEventListener("click", () =>
  guard(async () => {
    await api.copyText(S.genDir || "");
    toast("插件目录已复制");
  })
);

/* ============================================================
   启动
   ============================================================ */
async function afterUnlocked() {
  S.config = await api.getConfig();
  renderSettings();
  applyTheme();
  await refreshEntries();
  await showView("query");
}

async function boot() {
  // 截图与预览用的 URL 钩子（?view= ?reveal=1 ?modal= …）只在非 Tauri 环境生效。
  // 正式应用里这些参数必须彻底消失，否则 `?reveal=1` 等于"打开即显示明文"。
  const demoMode = !("__TAURI_INTERNALS__" in window);
  const params = new URLSearchParams(location.search);

  if (demoMode) {
    const forcedTheme = params.get("theme");
    if (forcedTheme === "light" || forcedTheme === "dark") S.themeOverride = forcedTheme;
  }

  applyTheme();

  const status = await api.bootstrap();

  if (!status.masterLoaded) {
    showError(status);
    return;
  }

  S.config = await api.getConfig();
  applyTheme();
  renderSettings();
  await refreshEntries();

  if (!demoMode) {
    await showView("query");
    return;
  }

  const start = params.get("view");
  // 预览里也允许直接停在生成视图（styles.css 已有对应的 462×380 演示框）
  const views = ["list", "settings", "generator"];
  await showView(views.includes(start) ? start : "query");

  // 便于截图/演示直接停在某个状态上
  const pick = params.get("pick");
  if (pick) selectPlatform(pick);
  const open = params.get("open");
  if (open === "plat" || open === "user") setComboOpen(open, true);
  if (params.get("reveal") === "1" && !$("#btnEye").disabled) $("#btnEye").click();

  const modal = params.get("modal");
  if (modal === "new") await openEntryModal(null);
  // 截图钩子：导入弹窗现在要一个已选的文件路径，预览里给个假的即可
  if (modal === "import") runImport("C:\\Users\\autod\\Documents\\passlet-backup.pvault");
  if (modal === "export") askExportPassword();
  if (modal === "master") $("#btnChangeMaster").click();
  if (modal === "report") {
    showImportReport({ added: 3, skipped: 1, replaced: 0, mode: "skip", backupPath: null });
  }
  if (modal === "delete" && S.entries.length) {
    await showView("list");
    confirmDelete(S.entries[0].id);
  }
}

boot().catch(err => {
  console.error(err);
  showError({ reason: "decrypt_failed" });
});
