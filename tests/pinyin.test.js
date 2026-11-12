// 拼音匹配的单测。用一张假表注入，不依赖 frontend/pinyin-data.js 那张 155 KB 的真表：
// 真表的内容归 pinyin-data.test.js 管，这里只管规则。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../frontend/logic.js";

const {
  matchScore,
  filterOptions,
  filterEntries,
  pinyinMatch,
  setPinyinTable,
  formAccountOptions
} = globalThis.PassletLogic;

const FAKE = new Map(Object.entries({
  小: ["xiao"],
  米: ["mi"],
  大: ["da"],
  华: ["hua"],
  为: ["wei"],
  长: ["chang", "zhang"],
  城: ["cheng"],
  乐: ["le", "yue"],
  银: ["yin"],
  行: ["xing", "hang"],
  手: ["shou"],
  机: ["ji"],
  网: ["wang"],
  盘: ["pan"],
  张: ["zhang"],
  三: ["san"]
}));

beforeEach(() => setPinyinTable(FAKE));

afterEach(() => {
  setPinyinTable(undefined);
  delete globalThis.PassletPinyin;
});

describe("R1 平台框拼音命中", () => {
  it("首字母、全拼、半截全拼、大写、带空格都算命中", () => {
    for (const query of ["xm", "xiaom", "xiaomi", "XIAO", "xiaomi", "xiao mi", "XIAOMI"]) {
      expect(matchScore("小米", query)).toBe(2);
    }
  });

  it("拼音命中的档位是 2（拼音开头），与字面 0/1 区分开", () => {
    expect(matchScore("小米", "小米")).toBe(0);
    expect(matchScore("小米", "米")).toBe(1);
    expect(matchScore("小米", "xm")).toBe(2);
  });
});

describe("R2 账号框同样适用", () => {
  it("中文用户名按拼音/首字母命中", () => {
    expect(matchScore("张三", "zs")).toBe(2);
    expect(matchScore("张三", "zhangsan")).toBe(2);
    expect(matchScore("张三", "zhangs")).toBe(2);
  });
});

describe("R3 打分的先后顺序", () => {
  it("字面前缀 > 字面子串 > 拼音开头 > 拼音中间", () => {
    const options = ["大小米", "小米", "xm", "小米手机"];
    // xm: 字面前缀(xm) 0 → 小米 拼音开头 2 → 小米手机 拼音开头 2 → 大小米 拼音中间 3
    expect(filterOptions(options, "xm")).toEqual(["xm", "小米", "小米手机", "大小米"]);
  });

  it("同档保持原顺序（稳定排序）", () => {
    expect(filterOptions(["小米", "大米", "小米手机"], "xm")).toEqual(["小米", "小米手机"]);
    // 从中间的字命中也算命中，同样按原顺序输出：大米、小米、糯米 都由「米」命中，档位都是 3
    expect(filterOptions(["大米", "小米", "糯米"], "m")).toEqual(["大米", "小米", "糯米"]);
  });

  it("空查询返回全部且顺序不变", () => {
    expect(filterOptions(["小米", "华为", "GitHub"], "")).toEqual(["小米", "华为", "GitHub"]);
  });
});

describe("R4 混拼", () => {
  it("同一个字既可以全拼也可以只出首字母", () => {
    for (const query of ["xmsj", "xiaomishouji", "xiaomsj", "xiaomishouj"]) {
      expect(matchScore("小米手机", query)).toBe(2);
    }
  });
});

describe("R5 尾部没打完", () => {
  it("查询是某个音节的前缀就算命中", () => {
    for (const query of ["xia", "xiao", "xiaom", "xiaomish"]) {
      expect(matchScore("小米手机", query)).toBe(2);
    }
  });

  it("打错一个字母就不命中（xian 不是 xiao 的前缀）", () => {
    expect(matchScore("小米", "xian")).toBeNull();
    expect(matchScore("小米手机", "xianmi")).toBeNull();
  });

  it("一长串全是首字母也算命中，且不会因为半截规则放松成任意子串", () => {
    expect(matchScore("小米手机网盘", "xmsjwp")).toBe(2);
    expect(matchScore("小米手机网盘", "xmsjwq")).toBeNull();
  });
});

describe("R6 多音字全部读音参与", () => {
  it("长城可用 chang 也可用 zhang", () => {
    expect(matchScore("长城", "cc")).toBe(2);
    expect(matchScore("长城", "changcheng")).toBe(2);
    expect(matchScore("长城", "zhangcheng")).toBe(2);
  });

  it("乐 有 le 与 yue 两个读音", () => {
    expect(matchScore("乐", "le")).toBe(2);
    expect(matchScore("乐", "yue")).toBe(2);
  });

  it("银行 的 行 有 xing 与 hang", () => {
    expect(matchScore("银行", "yh")).toBe(2);
    expect(matchScore("银行", "yinhang")).toBe(2);
    expect(matchScore("银行", "yinxing")).toBe(2);
  });
});

describe("R7 非拼音查询不受影响", () => {
  it("查询里出现标点时不走拼音，只做字面匹配", () => {
    expect(pinyinMatch("小米", "xm@")).toBeNull();
    expect(matchScore("xm@qq.com", "xm@")).toBe(0);
    expect(matchScore("小米", "xm@")).toBeNull();
  });

  it("查询是中文时只做字面包含", () => {
    expect(matchScore("小米商城", "商城")).toBe(1);
    expect(matchScore("小米商城", "小米")).toBe(0);
    expect(matchScore("小米商城", "华为")).toBeNull();
  });

  it("标签里没有汉字时拼音路径直接跳过", () => {
    expect(pinyinMatch("GitHub", "git")).toBeNull();
    expect(matchScore("GitHub", "git")).toBe(0);
  });
});

describe("R9 表不可用时降级", () => {
  it("没有表就只剩字面匹配，不抛错", () => {
    setPinyinTable(null);
    expect(matchScore("小米", "xm")).toBeNull();
    expect(matchScore("小米", "小米")).toBe(0);
    expect(filterOptions(["小米"], "xm")).toEqual([]);
  });

  it("表结构损坏（字与读音段数不符）时自动关闭拼音，且只警告一次", () => {
    const warns = [];
    const original = console.warn;
    console.warn = message => warns.push(message);
    try {
      globalThis.PassletPinyin = { count: 2, chars: "小米", readings: "xiao" };
      setPinyinTable(undefined);
      // 连调两次：第二次必须走缓存，不能每次都警告（否则控制台会被刷满）
      expect(matchScore("小米", "xm")).toBeNull();
      expect(matchScore("小米", "xm")).toBeNull();
      expect(matchScore("华为", "hw")).toBeNull();
      expect(warns.length).toBe(1);
    } finally {
      console.warn = original;
    }
  });

  it("表里出现非法音节时同样判为损坏", () => {
    globalThis.PassletPinyin = { count: 1, chars: "小", readings: "xi ao" };
    setPinyinTable(undefined);
    expect(matchScore("小米", "xm")).toBeNull();
  });
});

describe("清单过滤接拼音", () => {
  it("平台或用户名任一拼音命中即保留", () => {
    const entries = [
      { platform: "小米", username: "a@example.com" },
      { platform: "GitHub", username: "张三" },
      { platform: "华为", username: "b@example.com" }
    ];
    expect(filterEntries(entries, "xm").map(item => item.platform)).toEqual(["小米"]);
    expect(filterEntries(entries, "zs").map(item => item.platform)).toEqual(["GitHub"]);
    expect(filterEntries(entries, "hw").map(item => item.platform)).toEqual(["华为"]);
    expect(filterEntries(entries, "github").map(item => item.platform)).toEqual(["GitHub"]);
  });

  it("空查询返回副本，不返回同一数组", () => {
    const entries = [{ platform: "小米", username: "a" }];
    const result = filterEntries(entries, "   ");
    expect(result).toEqual(entries);
    expect(result).not.toBe(entries);
  });
});

describe("边界条件", () => {
  it("单字标签：整字打完才命中", () => {
    expect(matchScore("米", "m")).toBe(2);
    expect(matchScore("米", "mi")).toBe(2);
    expect(matchScore("米", "mix")).toBeNull();
  });

  it("查询超过 64 字符时跳过拼音（只留字面）", () => {
    expect(pinyinMatch("小米", "x".repeat(65))).toBeNull();
  });

  it("标签超过 128 字符时跳过拼音", () => {
    expect(pinyinMatch(`小米${"啊".repeat(200)}`, "xm")).toBeNull();
  });

  it("空标签、非字符串输入返回 null", () => {
    expect(matchScore("", "xm")).toBeNull();
    expect(pinyinMatch(null, "xm")).toBeNull();
    expect(pinyinMatch("小米", null)).toBeNull();
    expect(matchScore("小米", "   ")).toBe(1);
  });

  it("标签里的空格被忽略（“小米 Mi” 也能用 xiaomi 命中）", () => {
    expect(matchScore("小米 Mi", "xiaomi")).toBe(2);
  });

  it("标签里的 ASCII 与汉字可以混着打", () => {
    expect(matchScore("小米App", "xiaomiapp")).toBe(2);
    expect(matchScore("小米App", "xmapp")).toBe(2);
  });

  it("拼音匹配不修改传入的标签或表", () => {
    const label = "小米";
    pinyinMatch(label, "xm");
    expect(label).toBe("小米");
    expect(FAKE.get("小")).toEqual(["xiao"]);
  });
});

describe("formAccountOptions：表单账号候选", () => {
  const entries = [
    { platform: "小米", username: "a@example.com" },
    { platform: "小米", username: "A@example.com" },
    { platform: "华为", username: "b@example.com" },
    { platform: "小米", username: "  " }
  ];

  it("平台精确命中时只列该平台的用户名，并按 normalizeKey 去重", () => {
    expect(formAccountOptions(entries, "小米")).toEqual(["a@example.com"]);
  });

  it("平台名大小写与首尾空格不影响命中", () => {
    expect(formAccountOptions(entries, "  小米 ")).toEqual(["a@example.com"]);
  });

  it("空平台或库里没有的新平台时列全部用户名（去重、保序）", () => {
    expect(formAccountOptions(entries, "")).toEqual(["a@example.com", "b@example.com"]);
    expect(formAccountOptions(entries, "新平台")).toEqual(["a@example.com", "b@example.com"]);
  });

  it("空用户名被跳过，空库返回空数组", () => {
    expect(formAccountOptions([{ platform: "小米", username: "  " }], "小米")).toEqual([]);
    expect(formAccountOptions([], "小米")).toEqual([]);
  });

  it("不修改传入的条目", () => {
    const snapshot = JSON.stringify(entries);
    formAccountOptions(entries, "小米");
    expect(JSON.stringify(entries)).toBe(snapshot);
  });
});
