// 新增/编辑表单里两个内联下拉的纯函数部分：
// 账号候选范围怎么算、去重与顺序、以及“自由输入”不受影响的回归守卫。
// DOM 行为（展开、键盘、Esc）由端到端脚本覆盖，这里只管能算的部分。
import { describe, expect, it } from "vitest";
import "../frontend/logic.js";

const { formAccountOptions, validateEntry, filterOptions } = globalThis.PassletLogic;

const entries = [
  { platform: "小米", username: "xiaomi@example.com" },
  { platform: "小米", username: "backup@example.com" },
  { platform: "华为", username: "huawei@example.com" },
  { platform: "小米", username: "XIAOMI@example.com" },
  { platform: "华为", username: "" }
];

describe("Q7 候选范围", () => {
  it("平台精确命中时只列该平台的用户名", () => {
    expect(formAccountOptions(entries, "小米")).toEqual([
      "xiaomi@example.com",
      "backup@example.com"
    ]);
  });

  it("平台是库里没有的新名字时列全部用户名", () => {
    expect(formAccountOptions(entries, "豆瓣")).toEqual([
      "xiaomi@example.com",
      "backup@example.com",
      "huawei@example.com"
    ]);
  });

  it("平台空串同样列全部", () => {
    expect(formAccountOptions(entries, "")).toHaveLength(3);
  });

  it("平台名只差大小写或首尾空格仍算命中", () => {
    expect(formAccountOptions(entries, " 小米 ")).toHaveLength(2);
  });
});

describe("去重与顺序", () => {
  it("同一账号按 normalizeKey 去重，保留首次出现的写法", () => {
    const list = formAccountOptions(entries, "小米");
    expect(list).toContain("xiaomi@example.com");
    expect(list).not.toContain("XIAOMI@example.com");
    expect(list).toHaveLength(2);
  });

  it("全量候选里跨平台重复也只出现一次", () => {
    const duplicated = [
      { platform: "小米", username: "shared@example.com" },
      { platform: "华为", username: "shared@example.com" }
    ];
    expect(formAccountOptions(duplicated, "")).toEqual(["shared@example.com"]);
  });

  it("空用户名与纯空格用户名被跳过", () => {
    expect(formAccountOptions([{ platform: "华为", username: "   " }], "华为")).toEqual([]);
  });

  it("保持条目原有顺序", () => {
    const ordered = [
      { platform: "A", username: "z@example.com" },
      { platform: "A", username: "a@example.com" }
    ];
    expect(formAccountOptions(ordered, "A")).toEqual(["z@example.com", "a@example.com"]);
  });
});

describe("边界与回归", () => {
  it("空库返回空数组，不抛错", () => {
    expect(formAccountOptions([], "小米")).toEqual([]);
  });

  it("不修改传入的条目", () => {
    const snapshot = JSON.stringify(entries);
    formAccountOptions(entries, "小米");
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  it("每次返回新数组（调用方可以随意改）", () => {
    const first = formAccountOptions(entries, "小米");
    first.push("x");
    expect(formAccountOptions(entries, "小米")).toHaveLength(2);
  });

  it("候选只是建议：自由输入的新账号仍然能过校验", () => {
    expect(validateEntry("豆瓣", "brand-new@example.com", "secret")).toBeNull();
  });

  it("候选列表本身可以再过一遍字面过滤（输入框里继续敲字）", () => {
    const options = formAccountOptions(entries, "小米");
    expect(filterOptions(options, "backup")).toEqual(["backup@example.com"]);
  });
});
