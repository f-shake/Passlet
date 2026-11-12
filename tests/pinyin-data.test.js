// 真表（frontend/pinyin-data.js）的体检：内容对不对、体积有没有失控。
// 规则本身在 pinyin.test.js 里用假表验，这里只验“这张表能不能支撑那些规则”。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../frontend/pinyin-data.js";
import "../frontend/logic.js";

const { matchScore, pinyinMatch, setPinyinTable } = globalThis.PassletLogic;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const table = globalThis.PassletPinyin;
const readings = table.readings.split(",");
const chars = Array.from(table.chars);

function readingsOf(ch) {
  const index = chars.indexOf(ch);
  return index < 0 ? null : readings[index].split("/");
}

describe("结构完整性", () => {
  it("声明字数与实际字数一致", () => {
    expect(table.count).toBe(chars.length);
    expect(table.count).toBe(readings.length);
  });

  it("覆盖两万字以上（少了说明生成脚本被截断）", () => {
    expect(table.count).toBeGreaterThan(20000);
  });

  it("全部字符都在 CJK 基本区（U+4E00–U+9FFF）", () => {
    const outOfRange = chars.filter(ch => {
      const code = ch.codePointAt(0);
      return code < 0x4e00 || code > 0x9fff;
    });
    expect(outOfRange).toEqual([]);
  });

  it("没有重复收录的汉字", () => {
    expect(new Set(chars).size).toBe(chars.length);
  });

  it("每个读音都只含小写字母（去声调、ü 写作 v）", () => {
    const bad = [];
    for (const entry of readings) {
      for (const syllable of entry.split("/")) {
        if (!/^[a-z]+$/.test(syllable)) bad.push(syllable);
      }
    }
    expect(bad).toEqual([]);
  });

  it("source 记录的是真正用到的 pinyin-pro 版本（不是写死的旧版本号）", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, "node_modules", "pinyin-pro", "package.json"), "utf8")
    );
    expect(table.source).toBe(`pinyin-pro@${pkg.version}`);
  });
});

describe("抽查读音", () => {
  it("小米 = xiao / mi", () => {
    expect(readingsOf("小")).toEqual(["xiao"]);
    expect(readingsOf("米")).toEqual(["mi"]);
  });

  it("长 同时有 chang 与 zhang", () => {
    expect(readingsOf("长")).toEqual(expect.arrayContaining(["chang", "zhang"]));
  });

  it("乐 同时有 le 与 yue", () => {
    expect(readingsOf("乐")).toEqual(expect.arrayContaining(["le", "yue"]));
  });

  it("行 同时有 xing 与 hang", () => {
    expect(readingsOf("行")).toEqual(expect.arrayContaining(["xing", "hang"]));
  });

  it("ü 写成 v，用户敲得出（女 = nv）", () => {
    expect(readingsOf("女")).toContain("nv");
  });

  it("常用平台名都能拆出读音", () => {
    for (const ch of "阿里云腾讯京东淘宝微博知乎小红书哔哩哔哩") {
      expect(readingsOf(ch)).not.toBeNull();
    }
  });
});

describe("真表驱动的匹配", () => {
  it("常用平台名：首字母、全拼、半截都命中", () => {
    expect(matchScore("小米", "xm")).toBe(2);
    expect(matchScore("华为", "hw")).toBe(2);
    expect(matchScore("小红书", "xhs")).toBe(2);
    expect(matchScore("哔哩哔哩", "blbl")).toBe(2);
    expect(matchScore("阿里云", "aliyun")).toBe(2);
    expect(matchScore("阿里云", "ali")).toBe(2);
    expect(matchScore("知乎", "zhi")).toBe(2);
  });

  it("多音字在真表上也成立", () => {
    expect(matchScore("长城", "cc")).toBe(2);
    expect(matchScore("长城", "changcheng")).toBe(2);
    expect(matchScore("长城", "zhangcheng")).toBe(2);
    expect(matchScore("银行", "yinhang")).toBe(2);
    expect(matchScore("银行", "yinxing")).toBe(2);
  });

  it("真表加载后不会自己失活", () => {
    setPinyinTable(undefined);
    expect(pinyinMatch("小米", "xm")).toBe(2);
    expect(globalThis.PassletLogic.getPinyinMap()).toBeInstanceOf(Map);
  });
});

describe("体积预算", () => {
  it("数据文件不超过 200 KB", () => {
    const bytes = readFileSync(resolve(root, "frontend", "pinyin-data.js")).length;
    expect(bytes).toBeLessThan(200 * 1024);
  });

  it("读音串不超过 130 KB", () => {
    expect(Buffer.byteLength(table.readings, "utf8")).toBeLessThan(130 * 1024);
  });
});
