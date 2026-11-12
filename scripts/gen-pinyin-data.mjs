// 生成 frontend/pinyin-data.js：汉字 → 无声调拼音读音表。
//
// 为什么要生成而不是运行时依赖：前端没有构建步骤（index.html 直接引脚本，file:// 双击也能跑），
// 也不该为了补全去加载一个 1 MB 的库。把字典压成两条字符串（字 + 读音）进仓库，
// 运行时零依赖、离线可用，生成脚本只在想升级字典时手动跑：
//
//     node scripts/gen-pinyin-data.mjs
//
// 数据来源：pinyin-pro（MIT，https://github.com/zh-lx/pinyin-pro）。
// 读音一律去声调、ü→v，并把一字多音全部保留（长 = chang/zhang）；
// 用户打拼音不会打声调，留着声调只是白占体积。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "frontend", "pinyin-data.js");

// 版本号从装好的包读，不写死：升级字典后重新生成，来源标注才会跟着变，
// 否则溯源信息会静默失真（tests/pinyin-data.test.js 会比对这一行）。
const pkg = JSON.parse(
  readFileSync(resolve(root, "node_modules", "pinyin-pro", "package.json"), "utf8")
);
const source = `pinyin-pro@${pkg.version}`;

// 只收 CJK 统一汉字基本区：扩展区（A/B/C…）在本产品的候选名里几乎不出现，
// 收进来只会让表体积翻几倍。
const FIRST = 0x4e00;
const LAST = 0x9fff;
const SYLLABLE = /^[a-z]+$/;

const chars = [];
const readings = [];
const syllableSet = new Set();

for (let code = FIRST; code <= LAST; code += 1) {
  const ch = String.fromCharCode(code);
  const list = pinyin(ch, { multiple: true, toneType: "none", type: "array", v: true });
  const uniq = [];
  for (const raw of list || []) {
    const syl = String(raw).toLowerCase();
    if (!SYLLABLE.test(syl)) continue;
    if (!uniq.includes(syl)) uniq.push(syl);
  }
  if (uniq.length === 0) continue;
  chars.push(ch);
  readings.push(uniq.join("/"));
  for (const syl of uniq) syllableSet.add(syl);
}

// 自检：生成器出错时宁可直接失败，也不要把坏表写进仓库。
const problems = [];
if (chars.length < 20000) problems.push(`字数偏少：${chars.length}`);
if (chars.length !== readings.length) problems.push("字串与读音串长度不一致");
const allChars = chars.join("");
if (allChars.length !== chars.length) problems.push("出现基本区之外的代理对字符");
for (const entry of readings) {
  for (const syl of entry.split("/")) {
    if (!SYLLABLE.test(syl)) problems.push(`非法音节：${syl}`);
  }
}
if (problems.length > 0) {
  console.error(`生成失败：\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

const body = `// 生成物，不要手改。改字典或规则请改 scripts/gen-pinyin-data.mjs 后重新生成：
//     node scripts/gen-pinyin-data.mjs
// 数据来源 ${source}（MIT）。读音已去声调、ü 写作 v，一字多音全部保留（"chang/zhang"）。
globalThis.PassletPinyin = {
  source: ${JSON.stringify(source)},
  count: ${chars.length},
  chars: ${JSON.stringify(allChars)},
  readings: ${JSON.stringify(readings.join(","))}
};
`;

writeFileSync(target, body, "utf8");

const kb = (Buffer.byteLength(body, "utf8") / 1024).toFixed(1);
const multi = readings.filter(entry => entry.includes("/")).length;
console.log(`已生成 ${target}`);
console.log(`  字数 ${chars.length}（多音字 ${multi}）、音节 ${syllableSet.size} 个、文件 ${kb} KB`);
