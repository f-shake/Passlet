// 下拉按键决策表的单测。
// DOM 部分（弹层开合、pointerdown 抢 blur、Esc 两段）由 temp/e2e-pinyin.ps1 覆盖，
// 但「哪一下该做什么」这段判断被抽成了纯函数，必须在仓库里有测试，否则回归没人拦。
import { describe, expect, it } from "vitest";
import "../frontend/logic.js";

const { comboAction } = globalThis.PassletLogic;

describe("弹层关着的时候", () => {
  it("↓/↑ 先把弹层叫出来", () => {
    expect(comboAction("ArrowDown", { open: false, count: 3 })).toBe("open");
    expect(comboAction("ArrowUp", { open: false, count: 3 })).toBe("open");
  });

  it("Enter/Esc 什么都不做（不抢表单的回车与 Esc）", () => {
    expect(comboAction("Enter", { open: false, count: 3 })).toBeNull();
    expect(comboAction("Escape", { open: false, count: 3 })).toBeNull();
  });

  it("没有候选时 ↓/↑ 仍然可以叫出弹层（好让用户看到“没有匹配”）", () => {
    expect(comboAction("ArrowDown", { open: false, count: 0 })).toBe("open");
  });
});

describe("弹层开着的时候", () => {
  it("↓/↑ 在候选之间移动", () => {
    expect(comboAction("ArrowDown", { open: true, count: 3 })).toBe("next");
    expect(comboAction("ArrowUp", { open: true, count: 3 })).toBe("prev");
  });

  it("Enter 接受当前高亮项", () => {
    expect(comboAction("Enter", { open: true, count: 1 })).toBe("accept");
  });

  it("Esc 只收弹层", () => {
    expect(comboAction("Escape", { open: true, count: 3 })).toBe("close");
  });

  it("没有候选时 Enter/Esc 分工不同：Enter 不动（否则会误回填），Esc 照样收", () => {
    expect(comboAction("Enter", { open: true, count: 0 })).toBeNull();
    expect(comboAction("Escape", { open: true, count: 0 })).toBe("close");
  });
});

describe("不该接管的输入", () => {
  it("输入法组合输入期间一律返回 null（Enter 要留给 IME 上屏）", () => {
    for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
      expect(comboAction(key, { open: true, count: 3, composing: true })).toBeNull();
      expect(comboAction(key, { open: false, count: 3, composing: true })).toBeNull();
    }
  });

  it("其它按键一律不接管（Tab、字母、Home 等）", () => {
    for (const key of ["Tab", "a", "Home", "PageDown", " "]) {
      expect(comboAction(key, { open: true, count: 3 })).toBeNull();
    }
  });
});

describe("入参容错", () => {
  it("缺省 state 当“关着、没有候选”处理，不抛错", () => {
    expect(comboAction("Enter")).toBeNull();
    expect(comboAction("ArrowDown")).toBe("open");
    expect(comboAction("Escape")).toBeNull();
  });

  it("count 为非数字或负数时按 0 处理", () => {
    expect(comboAction("Enter", { open: true, count: "x" })).toBeNull();
    expect(comboAction("ArrowDown", { open: true, count: -2 })).toBeNull();
  });
});
