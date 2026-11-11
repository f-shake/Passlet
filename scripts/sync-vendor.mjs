// 把 daisyui 包里的 CSS 同步到 frontend/vendor/。
// 项目没有构建步骤，vendor 里那份是手工落盘的；这个脚本让 package.json 里的版本号
// 和真正生效的 CSS 不至于静默分叉。
import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules", "daisyui", "daisyui.css");
const target = resolve(root, "frontend", "vendor", "daisyui.css");

try {
  statSync(source);
} catch {
  console.error("找不到 node_modules/daisyui/daisyui.css，先跑 pnpm install。");
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);

const kb = (statSync(target).size / 1024).toFixed(0);
console.log(`vendor 已同步：${target}（${kb} KB）`);
