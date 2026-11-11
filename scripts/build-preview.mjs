// 把 frontend/ 下的资源内联成一个可双击打开的预览文件。
// 用途：在没有 Tauri 的浏览器里看界面（数据来自 demo-api.js 的内存假数据）。
// 产物：design/ui2a/passlet-preview.html
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frontend = resolve(root, "frontend");
const target = resolve(root, "design", "ui2a", "passlet-preview.html");

const read = name => readFileSync(resolve(frontend, name), "utf8");
// 演示替身放在 scripts/：它是预览专用的，不该跟着应用一起打包。
const readScript = name => readFileSync(resolve(root, "scripts", name), "utf8");

function inline(html, from, to) {
  if (!html.includes(from)) {
    throw new Error(`预览构建失败：index.html 里找不到 ${from}`);
  }
  // 传函数而不是字符串：替换串里的 $& / $1 / $$ 否则会被当成模式展开
  return html.replace(from, () => to);
}

let html = read("index.html");

html = inline(
  html,
  '<link rel="stylesheet" href="vendor/daisyui.css">',
  `<style>\n${read("vendor/daisyui.css")}\n</style>`
);
html = inline(
  html,
  '<link rel="stylesheet" href="styles.css">',
  `<style>\n${read("styles.css")}\n</style>`
);
html = inline(html, '<script src="logic.js"></script>', `<script>\n${read("logic.js")}\n</script>`);
// demo-api 必须在 api.js 之前注入，api.js 靠它兜底
html = inline(
  html,
  '<script src="api.js"></script>',
  `<script>\n${readScript("demo-api.js")}\n</script>\n<script>\n${read("api.js")}\n</script>`
);
html = inline(html, '<script src="app.js"></script>', `<script>\n${read("app.js")}\n</script>`);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, html, "utf8");

const kb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(0);
console.log(`预览已生成：${target}（${kb} KB）`);
