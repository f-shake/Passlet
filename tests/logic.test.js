// frontend/logic.js 的单测。
// logic.js 是经典脚本（无 export），所以这里用副作用导入把它执行一遍，
// 再从 globalThis.PassletLogic 取函数。
import { describe, expect, it } from "vitest";
import "../frontend/logic.js";

const {
  normalizeKey,
  matchScore,
  filterOptions,
  filterEntries,
  clampInt,
  maskText,
  validateEntry
} = globalThis.PassletLogic;

describe("normalizeKey：判重用的归一化", () => {
  it("去掉首尾空格并转小写", () => {
    expect(normalizeKey("  GitHub ")).toBe("github");
  });

  it("非字符串输入退化为空串", () => {
    expect(normalizeKey(null)).toBe("");
    expect(normalizeKey(undefined)).toBe("");
  });
});

describe("matchScore / filterOptions：AutoComplete 匹配", () => {
  it("前缀命中排在子串命中之前", () => {
    // foobar 是前缀命中（0），barfoo 是子串命中（1）
    expect(filterOptions(["barfoo", "foobar"], "foo")).toEqual(["foobar", "barfoo"]);
  });

  it("忽略大小写", () => {
    expect(filterOptions(["GitHub", "Gitee"], "git")).toEqual(["GitHub", "Gitee"]);
  });

  it("空查询返回全部且保持原顺序", () => {
    expect(filterOptions(["b", "a", "c"], "")).toEqual(["b", "a", "c"]);
  });

  it("没有命中时返回空数组", () => {
    expect(filterOptions(["GitHub", "Gitee"], "zzz")).toEqual([]);
  });

  it("同分时保持原顺序（稳定排序）", () => {
    expect(filterOptions(["beta", "zeta"], "ta")).toEqual(["beta", "zeta"]);
  });

  it("打分：前缀 0、子串 1、不命中 null", () => {
    expect(matchScore("foobar", "foo")).toBe(0);
    expect(matchScore("barfoo", "foo")).toBe(1);
    expect(matchScore("bar", "foo")).toBeNull();
  });
});

describe("filterEntries：清单过滤", () => {
  const entries = [
    { platform: "GitHub", username: "me@example.com" },
    { platform: "Gitee", username: "work@corp.com" },
    { platform: "阿里云", username: "autod" }
  ];

  it("命中平台：git 同时命中 GitHub 与 Gitee", () => {
    expect(filterEntries(entries, "git")).toHaveLength(2);
  });

  it("命中平台：更具体的子串只命中一条", () => {
    expect(filterEntries(entries, "hub")).toHaveLength(1);
  });

  it("命中用户名", () => {
    expect(filterEntries(entries, "corp")).toHaveLength(1);
  });

  it("忽略大小写", () => {
    expect(filterEntries(entries, "GITHUB")).toHaveLength(1);
  });

  it("中文也能匹配", () => {
    expect(filterEntries(entries, "阿里")).toHaveLength(1);
  });

  it("空查询返回全部", () => {
    expect(filterEntries(entries, "  ")).toHaveLength(3);
  });

  it("返回的是副本，不会改到原数组", () => {
    const copy = filterEntries(entries, "");
    copy.pop();
    expect(entries).toHaveLength(3);
  });
});

describe("clampInt：数字输入钳制", () => {
  it("区间内原样返回", () => {
    expect(clampInt(30, 1, 600, 30)).toBe(30);
  });

  it("低于下限取下限", () => {
    expect(clampInt(0, 1, 600, 30)).toBe(1);
  });

  it("高于上限取上限", () => {
    expect(clampInt(9999, 1, 600, 30)).toBe(600);
  });

  it("非数字回落默认值", () => {
    expect(clampInt("abc", 1, 600, 30)).toBe(30);
    expect(clampInt(NaN, 1, 600, 30)).toBe(30);
    expect(clampInt(undefined, 1, 600, 30)).toBe(30);
  });

  it("小数向零取整", () => {
    expect(clampInt(12.9, 1, 600, 30)).toBe(12);
  });

  it("允许 0 表示不自动隐藏", () => {
    expect(clampInt(0, 0, 600, 30)).toBe(0);
  });
});

describe("validateEntry：与服务端一致的三字段校验", () => {
  it("全部填好时通过", () => {
    expect(validateEntry("GitHub", "me", "pw")).toBeNull();
  });

  it("有空字段时给出统一文案", () => {
    expect(validateEntry("", "me", "pw")).toBe("平台、用户名、密码都要填。");
    expect(validateEntry("GitHub", "  ", "pw")).toBe("平台、用户名、密码都要填。");
    expect(validateEntry("GitHub", "me", "")).toBe("平台、用户名、密码都要填。");
  });

  it("超过 200 字被拒绝", () => {
    expect(validateEntry("a".repeat(201), "me", "pw")).toContain("最多 200 字");
  });

  it("密码上限 1024 字", () => {
    expect(validateEntry("GitHub", "me", "a".repeat(1024))).toBeNull();
    expect(validateEntry("GitHub", "me", "a".repeat(1025))).toContain("1024");
  });

  it("密码首尾空格不算空", () => {
    expect(validateEntry("GitHub", "me", "  ")).toBeNull();
  });
});

describe("maskText：掩码固定长度", () => {
  it("固定 8 个圆点，不随密码长度变化", () => {
    expect(maskText()).toHaveLength(8);
    expect(maskText()).toBe("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");
  });
});
