// 演示模式：没有 Tauri 运行时（浏览器里直接打开预览）时，套一层示意窗口边框并显示目标尺寸。
// 放在这里而不是 index.html 的内联脚本里：应用启用了 CSP，内联脚本会被拦掉。
if (!("__TAURI_INTERNALS__" in window)) document.documentElement.classList.add("demo");

// 界面控制器：视图状态机 + 渲染 + 事件。
// 与 logic.js、api.js 一样用经典脚本（无 import/export），这样 file:// 双击打开也能跑。
const api = globalThis.PassletApi;
const {
  dirLabel,
  showRestoreDefault,
  switchToast,
  filterOptions,
  filterEntries,
  formAccountOptions,
  comboAction,
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
  // 库文件放在哪：{ dir, file, isDefault, defaultDir }
  vaultLocation: null,
  // 最近一次启动失败的状态（错误页要用后端给的完整提示）
  lastStatus: null,
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
    },
    // 位置对不上（配置指向的目录里没有库）：正文要带上具体路径，所以这里只占位
    vault_missing: {
      title: "找不到密码库",
      text: "这个位置里没有 vault.dat。",
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

  // 三种“位置不对”的出路只在缺库时出现：
  // 改回默认 / 去别处选一个 / 就在这里新建空库（空库必须由用户点按钮，绝不自动建）
  const missing = Boolean(status) && status.reason === "vault_missing";
  $("#errResetDir").hidden = !missing;
  $("#errPickDir").hidden = !missing;
  $("#errNewVault").hidden = !missing;
  S.lastStatus = status || null;
  if (missing) showMissingDetail();

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

/** 缺库时把真实路径填进正文：只说“找不到”而说不出在哪找，等于没说。 */
async function showMissingDetail() {
  $("#errText").textContent = "正在读取数据位置…";
  const loc = await refreshVaultLocation();
  // 第一句用后端给的原文（它带着具体路径），避免同一段文案在 Rust 与 JS 各存一份
  const head = (S.lastStatus && S.lastStatus.message) || (loc ? `找不到密码库：${loc.file}。` : "");
  if (!head) {
    $("#errText").textContent = "读取数据位置失败。";
    return;
  }
  $("#errText").textContent =
    head + "可以点下面的按钮换一个位置，或把库放回原处后点“重新读取”。";
}

/** 位置改好之后重新解锁并回到正常界面。 */
async function retryAfterDirChange() {
  const status = await api.bootstrap();
  if (!status.masterLoaded) {
    showError(status);
    return;
  }
  await afterUnlocked();
}

$("#errResetDir").addEventListener("click", event =>
  guard(async () => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const loc = S.vaultLocation || (await api.vaultLocation());
      // 走和设置页同一条流程（要不要确认由后端判定），而不是硬塞 confirm：
      // 缺库状态下这是一次“把指针指回去”，有库可搬时它仍需确认
      await applyDirSwitch(loc.defaultDir, "move", { reload: false });
      await retryAfterDirChange();
    } finally {
      button.disabled = false;
    }
  })
);

$("#errPickDir").addEventListener("click", event =>
  guard(async () => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const dir = await api.pickVaultDir();
      if (!dir) return;
      await applyDirSwitch(dir, "auto", { reload: false });
      await retryAfterDirChange();
    } finally {
      button.disabled = false;
    }
  })
);

$("#errNewVault").addEventListener("click", event =>
  guard(async () => {
    const button = event.currentTarget;
    const loc = (await refreshVaultLocation()) || null;
    if (!(await confirmNewVault(loc))) return;
    button.disabled = true;
    try {
      await api.createVaultHere();
      await retryAfterDirChange();
    } finally {
      button.disabled = false;
    }
  })
);

/** 建空库前的确认。它是唯一能在“非首次运行”状态下创建库文件的入口，所以要问。 */
function confirmNewVault(loc) {
  return new Promise(resolve => {
    openModal({
      title: "在这里新建空库",
      body: `
        <p>将在 ${esc(loc ? loc.file : "当前数据位置")} 用当前主密码新建一个空的密码库。</p>
        <p>如果这个位置本来有一份库、只是还没同步下来，在这里新建会让两份出现在同一个位置。</p>`,
      buttons: [
        { label: "取消", onClick: close => close() },
        {
          label: "新建",
          primary: true,
          onClick: close => {
            resolve(true);
            close();
          }
        }
      ],
      onClose: () => resolve(false)
    });
  });
}

$("#errSetMaster").addEventListener("click", () => guard(() => openMasterModal()));

/* ============================================================
   查询视图：两个联动下拉
   ============================================================ */
const COMBO = {
  plat: { root: "#comboPlat", input: "#platInput", pop: "#popPlat" },
  user: { root: "#comboUser", input: "#userInput", pop: "#popUser" }
};
let openCombo = null;
// 键盘高亮停在候选列表的第几行。与“当前已选值”（.sel）是两件事：
// 已选值是状态，高亮只是光标，按 Enter 之前随时可以换。
const comboActive = { plat: 0, user: 0 };

/**
 * 下拉的按键语义，查询页与表单共用：↑/↓ 移动、Enter 选中、Esc 只收弹层。
 * 决策表在 logic.js 的 comboAction 里（可单测），这里只负责把 DOM 状态喂进去。
 */
function comboKey(event, open, count) {
  return comboAction(event.key, {
    composing: event.isComposing || event.keyCode === 229,
    open,
    count
  });
}

/** 只改高亮类、不重建列表：hover 与 ↑/↓ 共用它，重建会让鼠标下的节点被换掉。 */
function markActiveOption(pop, index) {
  for (const el of pop.querySelectorAll(".opt[data-index]")) {
    el.classList.toggle("active", Number(el.dataset.index) === index);
  }
}

/** 鼠标移到哪一行，高亮就跟到哪一行——否则“鼠标在 A、回车选中 B” */
function bindOptionHover(pop, onHover) {
  pop.addEventListener("pointerover", event => {
    const opt = event.target.closest(".opt[data-index]");
    if (!opt) return;
    onHover(Number(opt.dataset.index));
  });
}

/** 让高亮行留在可视区内。不用 scrollIntoView：它可能连带滚动整个窗口（查询页只有 214 高）。 */
function scrollActiveIntoView(pop, index) {
  const el = pop.querySelector(`.opt[data-index="${index}"]`);
  if (!el) return;
  const top = el.offsetTop;
  const bottom = top + el.offsetHeight;
  if (top < pop.scrollTop) pop.scrollTop = top;
  else if (bottom > pop.scrollTop + pop.clientHeight) pop.scrollTop = bottom - pop.clientHeight;
}

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

function comboOptionsOf(which) {
  if (which === "user" && !S.plat) return [];
  const all = which === "plat" ? platformList() : userList(S.plat);
  return filterOptions(all, $(COMBO[which].input).value);
}

function setComboOpen(which) {
  openCombo = which;
  for (const key of Object.keys(COMBO)) {
    $(COMBO[key].root).classList.toggle("open", openCombo === key);
  }

  // 高亮落在“输入框里那个值”上：刚聚焦时它等于已选值，按 Enter 不会误选到别的同前缀项。
  const options = comboOptionsOf(which);
  const input = $(COMBO[which].input);
  const typed = normalizeKey(input.value);
  const index = typed ? options.findIndex(item => normalizeKey(item) === typed) : -1;
  comboActive[which] = index > 0 ? index : 0;
  renderPop(which);
}

function renderPop(which) {
  renderPopContent(which);
  if (which) fitPop($(COMBO[which].pop));
}

/**
 * 弹层按可用空间收放。查询页只有 214 高，用户名行的弹层往下放会被窗口切掉，
 * 所以下方放不下就翻到输入框上方，最大高度收到真能放下的量。
 * bounds 是“看得见的边界”：查询页是整块应用区，表单里是弹窗正文——不能用整个弹窗，
 * 否则弹层会盖住底部的「保存／取消」，想点按钮先得点两下。
 */
function fitPop(pop, bounds) {
  const field = pop.parentElement && pop.parentElement.querySelector(".combo-field");
  if (!field) return;

  const fieldRect = field.getBoundingClientRect();
  const boxRect = (bounds || document.getElementById("app")).getBoundingClientRect();
  const margin = 12;
  const below = boxRect.bottom - fieldRect.bottom - margin;
  const above = fieldRect.top - boxRect.top - margin;
  const wanted = Math.min(150, pop.scrollHeight);

  const up = below < wanted && above > below;
  pop.classList.toggle("up", up);
  // 下限取一行的高度（29）：硬留 56 会在空间只剩三十几像素时把弹层顶到边界外面
  pop.style.maxHeight = `${Math.max(29, Math.min(150, up ? above : below))}px`;
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
    comboActive[which] = 0;
    pop.innerHTML = all.length
      ? `<div class="opt none">没有匹配的${which === "plat" ? "平台" : "用户名"}</div>`
      : `<div class="opt none">${which === "plat" ? "还没有密码，点“打开清单”新增" : "这个平台下没有其他用户名"}</div>`;
    return;
  }

  if (comboActive[which] >= options.length) comboActive[which] = 0;

  pop.innerHTML = options.map((value, index) => {
    const selected = selectedValue && normalizeKey(value) === normalizeKey(selectedValue);
    const active = index === comboActive[which];
    const cls = `opt${selected ? " sel" : ""}${active ? " active" : ""}`;
    return `<div class="${cls}" data-index="${index}" data-value="${esc(value)}">${esc(value)}</div>`;
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

/**
 * 查询页两个下拉的键盘处理。弹层没开时，↑/↓ 先把弹层叫出来（和地址栏的联想习惯一致）；
 * Esc 只收弹层、保留输入，不碰已选值。
 */
function comboKeydown(which, event) {
  const open = openCombo === which;
  const options = open ? comboOptionsOf(which) : [];
  const action = comboKey(event, open, options.length);
  if (!action) return;
  const input = $(COMBO[which].input);

  if (action === "open") {
    event.preventDefault();
    setComboOpen(which);
    return;
  }

  if (action === "close") {
    event.preventDefault();
    event.stopPropagation();
    openCombo = null;
    renderQueryCombos();
    return;
  }

  if (action === "next" || action === "prev") {
    event.preventDefault();
    const size = options.length;
    comboActive[which] = (comboActive[which] + (action === "next" ? 1 : -1) + size) % size;
    markActiveOption($(COMBO[which].pop), comboActive[which]);
    scrollActiveIntoView($(COMBO[which].pop), comboActive[which]);
    return;
  }

  // accept：选中高亮项，再让输入框失焦——失焦处理器会把内容归位成“已选值”。
  event.preventDefault();
  const value = options[Math.min(comboActive[which], options.length - 1)];
  const picked = which === "plat" ? S.plat : S.user;
  // 选的就是当前那一条：只收弹层。否则 selectPlatform 会把已选用户名清掉，
  // 用户按 Enter“确认一下”反而丢账号，这和改动前「Enter 什么都不做」差得太远。
  if (picked && normalizeKey(picked) === normalizeKey(value)) {
    openCombo = null;
    renderQueryCombos();
  } else if (which === "plat") {
    selectPlatform(value);
  } else {
    selectUser(value);
  }
  input.blur();
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
$("#platInput").addEventListener("focus", () => setComboOpen("plat"));
$("#platInput").addEventListener("input", () => setComboOpen("plat"));
$("#platInput").addEventListener("keydown", event => comboKeydown("plat", event));
$("#userInput").addEventListener("focus", () => {
  if (S.plat) setComboOpen("user");
});
$("#userInput").addEventListener("input", () => {
  if (!S.plat) return;
  setComboOpen("user");
});
$("#userInput").addEventListener("keydown", event => comboKeydown("user", event));

// 鼠标移到哪一行，高亮就跟到哪一行（与 ↑/↓ 共用同一个下标，回车选中的就是看到的那行）
for (const key of Object.keys(COMBO)) {
  bindOptionHover($(COMBO[key].pop), index => {
    if (openCombo !== key || comboActive[key] === index) return;
    comboActive[key] = index;
    markActiveOption($(COMBO[key].pop), index);
  });
}

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
  // 打的还是当前平台就不重选：重选会把已选用户名清空，等于“确认了一下反丢了账号”
  if (hit && (!S.plat || normalizeKey(hit) !== normalizeKey(S.plat))) {
    selectPlatform(hit);
    return;
  }
  $("#platInput").value = S.plat || "";
  openCombo = null;
  renderQueryCombos();
});
$("#userInput").addEventListener("blur", () => {
  const typed = $("#userInput").value;
  const hit = S.plat
    ? userList(S.plat).find(item => normalizeKey(item) === normalizeKey(typed))
    : null;
  if (hit && (!S.user || normalizeKey(hit) !== normalizeKey(S.user))) {
    selectUser(hit);
    return;
  }
  $("#userInput").value = S.user || "";
  openCombo = null;
  renderQueryCombos();
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

/**
 * 表单里的内联下拉（新增/编辑弹窗）。与查询页共用 comboKey 的按键语义，但状态是本地的：
 * 选中只回填输入框，不提交表单、不清空别的字段；用户也可以直接敲一个库里没有的新值。
 */
function setupFormCombo({ root, input, pop, bounds, getOptions, emptyText }) {
  let active = 0;

  function isOpen() {
    return root.classList.contains("open");
  }

  function close() {
    root.classList.remove("open");
  }

  function render() {
    if (!isOpen()) return;
    const options = getOptions();
    if (!options.length) {
      pop.innerHTML = `<div class="opt none">${emptyText()}</div>`;
      return;
    }
    if (active >= options.length) active = 0;
    pop.innerHTML = options.map((value, index) => {
      const cls = `opt${index === active ? " active" : ""}`;
      return `<div class="${cls}" data-index="${index}" data-value="${esc(value)}">${esc(value)}</div>`;
    }).join("");
  }

  function open() {
    root.classList.add("open");
    active = 0;
    render();
    fitPop(pop, bounds);
  }

  input.addEventListener("focus", () => {
    if (!input.disabled) open();
  });
  input.addEventListener("input", () => open());
  input.addEventListener("blur", () => close());

  input.addEventListener("keydown", event => {
    const options = isOpen() ? getOptions() : [];
    const action = comboKey(event, isOpen(), options.length);
    if (!action) return;
    if (action === "open") {
      event.preventDefault();
      open();
      return;
    }
    if (action === "close") {
      // 只收弹层：这里如果让 Esc 冒泡，整个表单会被关掉，已填内容白填
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (action === "next" || action === "prev") {
      event.preventDefault();
      const size = options.length;
      active = (active + (action === "next" ? 1 : -1) + size) % size;
      markActiveOption(pop, active);
      scrollActiveIntoView(pop, active);
      return;
    }
    event.preventDefault();
    input.value = options[Math.min(active, options.length - 1)];
    close();
  });

  // 悬停跟随高亮：与查询页同一套行为
  bindOptionHover(pop, index => {
    if (!isOpen() || active === index) return;
    active = index;
    markActiveOption(pop, index);
  });

  pop.addEventListener("pointerdown", event => {
    const opt = event.target.closest(".opt[data-value]");
    if (!opt) return;
    // 用 pointerdown 抢在 blur 之前，否则点下去弹层先消失、选了个寂寞
    event.preventDefault();
    input.value = opt.dataset.value;
    close();
  });
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

  const chev = '<svg class="chev" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9l7 7 7-7"></path></svg>';
  const body = `
    <div class="form-field">
      <label for="fPlat">平台</label>
      <div class="combo" id="comboFormPlat">
        <div class="combo-field input">
          <input id="fPlat" type="text" maxlength="200" autocomplete="off" placeholder="例如 GitHub、阿里云">
          ${chev}
        </div>
        <div class="combo-pop" id="popFormPlat"></div>
      </div>
    </div>
    <div class="form-field">
      <label for="fUser">用户名</label>
      <div class="combo" id="comboFormUser">
        <div class="combo-field input">
          <input id="fUser" type="text" maxlength="200" autocomplete="off" placeholder="账号或邮箱">
          ${chev}
        </div>
        <div class="combo-pop" id="popFormUser"></div>
      </div>
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

  // 弹层以弹窗正文为边界：`.dlg-body` 自身 overflow-y:auto（窗口被压得很矮时还能滚），
  // 以它为界既不会被裁，也不会盖住下面的「保存／取消」。
  const bounds = modal.body;

  setupFormCombo({
    root: modal.body.querySelector("#comboFormPlat"),
    input: platInput,
    pop: modal.body.querySelector("#popFormPlat"),
    bounds,
    getOptions: () => filterOptions(platformList(), platInput.value),
    emptyText: () => (platformList().length ? "没有匹配的平台" : "库里还没有记录")
  });

  setupFormCombo({
    root: modal.body.querySelector("#comboFormUser"),
    input: userInput,
    pop: modal.body.querySelector("#popFormUser"),
    bounds,
    getOptions: () => filterOptions(formAccountOptions(S.entries, platInput.value), userInput.value),
    emptyText: () => "没有匹配的用户名"
  });

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
  renderDataLocation();
  refreshVaultLocation();
}

/* ---------- 数据位置 ---------- */

function renderDataLocation() {
  const loc = S.vaultLocation;
  const path = $("#pathText");
  if (!loc) {
    // 还没拿到就显示占位符，别让上一台机器的路径留在界面上
    path.textContent = "—";
    path.title = "";
    $("#btnRestoreDir").hidden = true;
    return;
  }
  path.textContent = dirLabel(loc.file, 46);
  path.title = loc.file;
  $("#btnRestoreDir").hidden = !showRestoreDefault(loc.isDefault);
}

async function refreshVaultLocation() {
  try {
    S.vaultLocation = await api.vaultLocation();
  } catch {
    S.vaultLocation = null;
  }
  renderDataLocation();
  return S.vaultLocation;
}

/**
 * 换库位置的完整流程：先问后端“这是连接还是迁移”，迁移再要一次确认。
 * 只有用户点了「继续」才带 confirm 再发一次请求——后端在没拿到 confirm 之前不碰任何文件。
 *
 * `options.reload === false`：调用方在错误页，会话还没有，别去刷条目列表。
 */
async function applyDirSwitch(dir, mode, options) {
  let report = await api.switchVaultDir(dir, mode);
  if (report.kind === "needs_confirm") {
    if (!(await confirmMove(report))) return null;
    report = await api.switchVaultDir(dir, mode, true);
  }
  await afterDirSwitch(report, options);
  return report;
}

/** 迁移前的确认框。返回 true = 用户点了「继续」。 */
function confirmMove(report) {
  return new Promise(resolve => {
    const current = (S.vaultLocation && S.vaultLocation.file) || "—";
    openModal({
      title: "把密码库换个位置？",
      body: `
        <div class="kv"><span>当前位置</span><code>${esc(current)}</code></div>
        <div class="kv"><span>新位置</span><code>${esc(report.file)}</code></div>
        <div class="kv"><span>条目数量</span><code>${Number(report.entries) || 0} 条</code></div>
        <p>只搬 vault.dat 这一个文件；原位置的文件会改名成 vault.dat.moved-时间戳 留着。</p>`,
      buttons: [
        { label: "取消", onClick: close => close() },
        {
          label: "继续",
          primary: true,
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

/** 迁移成功后的回执：新位置和留档文件都得写全，toast 两秒记不住这么长的路径。 */
function showMoveReport(report) {
  // 没有留档就不许提留档：源文件改名失败时只有 warning，源目录本来没库时两者都没有
  const retired = report.retired
    ? `<div class="kv"><span>原位置留档</span><code>${esc(report.retired)}</code></div>
       <p>原位置的那份已改名保留，确认不再需要时可以手动删除。</p>`
    : "";
  openModal({
    title: "数据位置已更改",
    body: `
      <div class="kv"><span>新位置</span><code>${esc(report.file)}</code></div>
      <div class="kv"><span>条目数量</span><code>${Number(report.entries) || 0} 条</code></div>
      ${retired}
      ${report.warning ? `<p>${esc(report.warning)}</p>` : ""}`,
    buttons: [{ label: "确定", primary: true, onClick: close => close() }]
  });
}

async function afterDirSwitch(report, options) {
  const opts = options || {};
  const message = switchToast(report);
  if (message) toast(message);

  // 配置里的 vaultDir 也变了：不重取的话，下一次改主题/剪贴板就会把旧指针整份写回去，
  // 库的位置在那里悄悄被改回上一个目录。
  S.config = await api.getConfig();
  await refreshVaultLocation();

  if (report.kind === "cleared") {
    // 没有库可搬，只改了指针：默认目录空的话，接下来会以“首次运行”的空库进入查询页。
    // 这一点必须当面说清，否则看起来像数据被清空了。
    const loc = S.vaultLocation;
    toast(
      loc && loc.isDefault
        ? "已改回默认位置；那里还没有密码库，会以空库开始。"
        : "已把数据位置改到该目录。"
    );
  }

  if (opts.reload === false) return;

  S.secrets.clear();
  S.revealed.clear();
  S.plat = null;
  S.user = null;
  S.filter = "";
  await refreshEntries();
  renderQueryCombos();
  renderList();

  if (report.kind === "moved") showMoveReport(report);
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
    const loc = S.vaultLocation || (await api.vaultLocation());
    await api.copyText(loc.file);
    toast("路径已复制");
  })
);

$("#btnPickDir").addEventListener("click", event =>
  guard(async () => {
    // 必须在第一个 await 之前取：事件派发结束后 currentTarget 会被置空
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const dir = await api.pickVaultDir();
      if (!dir) return; // 用户取消
      await applyDirSwitch(dir, "auto");
    } finally {
      button.disabled = false;
    }
  })
);

// 默认位置有旧库也强制搬回去：这里的语义是“数据跟着指针走”，
// 不是“打开默认目录里原有的那份”——两份数据混在一起最容易被误解。
$("#btnRestoreDir").addEventListener("click", event =>
  guard(async () => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const loc = S.vaultLocation || (await api.vaultLocation());
      await applyDirSwitch(loc.defaultDir, "move");
    } finally {
      button.disabled = false;
    }
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
  await refreshVaultLocation();
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
  await refreshVaultLocation();
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
  if (open === "plat" || open === "user") setComboOpen(open);
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
