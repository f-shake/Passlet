// 与“数据位置”有关的纯函数（frontend/logic.js）。
//
// 这些判断如果直接写在 app.js 里就只能靠手点验证：路径该省成什么样、
// 「恢复默认位置」何时出现、三种回执分别说什么。抽成纯函数后行为被锁在这里。
import { describe, expect, it } from "vitest";
import "../frontend/logic.js";

const { dirLabel, showRestoreDefault, switchToast } = globalThis.PassletLogic;

const ONEDRIVE = "C:\\Users\\autod\\OneDrive\\Passlet\\vault.dat";

describe("dirLabel：设置页那行路径怎么显示", () => {
  it("短路径原样返回", () => {
    expect(dirLabel("C:\\vault.dat", 46)).toBe("C:\\vault.dat");
  });

  it("正好等于上限时不做省略", () => {
    const path = "C:\\" + "a".repeat(20);
    expect(dirLabel(path, path.length)).toBe(path);
  });

  it("超过上限时中间省略，盘符与文件名都保住", () => {
    const shown = dirLabel(ONEDRIVE, 24);
    expect(shown.length).toBeLessThanOrEqual(24);
    expect(shown.startsWith("C:\\")).toBe(true);
    expect(shown.endsWith("vault.dat")).toBe(true);
    expect(shown).toContain("...");
  });

  it("省略后尾巴从分隔符开始，不切出半个目录名", () => {
    const shown = dirLabel(ONEDRIVE, 30);
    // 省略号之后必须是 "\Passlet\vault.dat" 这种完整层级
    const tail = shown.slice(shown.indexOf("...") + 3);
    expect(tail.startsWith("\\")).toBe(true);
    expect(tail).toContain("Passlet");
  });

  it("两个不同的长路径省略后仍然可区分", () => {
    const other = "C:\\Users\\autod\\OneDrive\\Backup\\vault.dat";
    expect(dirLabel(ONEDRIVE, 30)).not.toBe(dirLabel(other, 30));
  });

  it("极窄时只留尾巴，不抛错", () => {
    const path = "C:\\a\\b\\vault.dat";
    expect(dirLabel(path, 5)).toBe(path.slice(-5));
  });

  it("没有上限时原样返回", () => {
    expect(dirLabel(ONEDRIVE, 0)).toBe(ONEDRIVE);
    expect(dirLabel(ONEDRIVE, null)).toBe(ONEDRIVE);
    expect(dirLabel(ONEDRIVE, undefined)).toBe(ONEDRIVE);
  });

  it("空值不炸", () => {
    expect(dirLabel(null, 10)).toBe("");
    expect(dirLabel(undefined, 10)).toBe("");
  });
});

describe("showRestoreDefault：什么时候给「恢复默认位置」", () => {
  it("库就在默认目录时不显示", () => {
    expect(showRestoreDefault(true)).toBe(false);
  });

  it("库在别处时显示", () => {
    expect(showRestoreDefault(false)).toBe(true);
  });
});

describe("switchToast：换位置的几种回执", () => {
  it("迁移成功说清楚搬到了这里、有几条", () => {
    expect(switchToast({ kind: "moved", entries: 42 })).toBe("密码库已搬到这里，共 42 条记录。");
  });

  it("迁移成功但源文件没改名时把那句警告接在后面", () => {
    const message = switchToast({
      kind: "moved",
      entries: 3,
      warning: "原位置的 vault.dat 没能改名，你可以手动删除。"
    });
    expect(message).toContain("3 条记录");
    expect(message).toContain("没能改名");
  });

  it("连接时说切换到该位置的库", () => {
    expect(switchToast({ kind: "connected", entries: 7 })).toBe("已切换到该位置的密码库，共 7 条记录。");
  });

  it("空库也照样报条目数", () => {
    expect(switchToast({ kind: "moved", entries: 0 })).toContain("0 条记录");
  });

  it("新建空库", () => {
    expect(switchToast({ kind: "created" })).toBe("已在这个位置新建空的密码库。");
  });

  it("只把指针指过去（cleared）不在这里出文案，由 app.js 按是不是默认目录分两种说法", () => {
    expect(switchToast({ kind: "cleared", entries: 0 })).toBe("");
  });

  it("选到的就是当前位置", () => {
    expect(switchToast({ kind: "unchanged" })).toBe("已经在这个位置。");
  });

  it("未知或需确认的回执返回空串，调用方据此不弹提示", () => {
    expect(switchToast({ kind: "needs_confirm", entries: 2 })).toBe("");
    expect(switchToast(null)).toBe("");
  });
});
