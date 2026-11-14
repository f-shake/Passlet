// 冷启动不闪白底的几条约不变量。
//
// 这些问题没法靠单测渲染窗口来验证，只能对“配置”和“源码里的调用顺序”做断言；
// 真正的像素级证据在 temp/e2e-theme.ps1 里。
//
// 断言写法说明：这里按花括号配对截出函数体再判定，而不是“从函数名截到文件末尾”。
// 后者会被“把调用挪进 if (false) 或挪到别的函数里”骗过——那正是上一版的问题。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = name => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const appSrc = read("frontend/app.js");
const cssSrc = read("frontend/styles.css");

/** 截出 `signature` 那个函数的函数体（按花括号配对，字符串里的括号不处理——本文件用不到）。 */
function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/** 文本里第 index 个字符处于第几层花括号内（0 = 函数体顶层）。 */
function depthAt(text, index) {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
  }
  return depth;
}

const bootBody = bodyOf(appSrc, "async function boot()");
const revealBody = bodyOf(appSrc, "function revealWindow()");
const themeBody = bodyOf(appSrc, "function applyTheme()");

describe("冷启动不闪白底", () => {
  it("主窗口是隐藏创建的，主题就绪前用户看不到任何一帧", () => {
    const main = conf.app.windows.find(window => window.label === "main");
    expect(main).toBeTruthy();
    expect(main.visible).toBe(false);
  });

  it("boot 的顺序是：读配置 → 应用主题 → 显示窗口 → 解锁", () => {
    expect(bootBody.length).toBeGreaterThan(0);

    const readConfig = bootBody.indexOf("await api.getConfig()");
    const theme = bootBody.indexOf("applyTheme();");
    const reveal = bootBody.indexOf("revealWindow();");
    const unlock = bootBody.indexOf("await api.bootstrap()");

    expect(readConfig).toBeGreaterThan(-1);
    expect(theme).toBeGreaterThan(readConfig);
    expect(reveal).toBeGreaterThan(theme);
    // 解锁要 Argon2 几百毫秒，必须排在显示窗口之后：别让人对着看不见的窗口干等
    expect(unlock).toBeGreaterThan(reveal);
  });

  it("显示窗口这一步不在 try 里，读配置失败也不会漏掉它", () => {
    // 上一版的 try/catch 把 getConfig 包住了；如果连 revealWindow() 也放进同一个 try，
    // getConfig 一 reject 就跳 catch，窗口永远不显示——而那正是这条用例要防的。
    const index = bootBody.indexOf("revealWindow();");
    expect(index).toBeGreaterThan(-1);
    expect(depthAt(bootBody, index)).toBe(0);
    // 还要钉住“紧跟在 applyTheme 之后”这个位置：写成 if (false) revealWindow()
    // 或挪进某个不会执行的分支，深度断言拦不住，位置断言可以。
    expect(bootBody).toContain("applyTheme();\n  revealWindow();");
  });

  it("revealWindow 等主题标记到位才显示，并且有帧回调之外的退路", () => {
    expect(revealBody).toContain("themeReady");
    expect(revealBody).toContain("setTimeout(whenThemed, 300)");
    // 只执行一次：show_window 被调用两次会二次抢焦点
    expect(revealBody).toContain("if (shown) return;");
  });

  it("applyTheme 会打上“主题已就绪”的标记", () => {
    expect(themeBody).toContain('dataset.themeReady = "1"');
  });

  it("根元素有底色，加载瞬间露出的是主题色而不是默认白", () => {
    expect(cssSrc).toMatch(/html\s*\{[^}]*background\s*:\s*var\(--color-base-100\)/);
  });

  it("后端兜底不会因为“查不到可见性”就放弃显示", () => {
    const libSrc = read("src-tauri/src/lib.rs");
    expect(libSrc).toContain("is_visible().unwrap_or(false)");
    // 兜底也要按配置上标题栏颜色，否则深色用户看到的仍是浅色外壳
    expect(libSrc).toContain("fn apply_config_theme(");
  });
});
