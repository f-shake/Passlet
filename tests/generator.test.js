// 生成器插件的纯函数层单测。
// 被测对象是 frontend/logic.js：它不认识 DOM、不认识 Tauri，所以这里能直接跑。
import { describe, expect, it } from "vitest";
import "../frontend/logic.js";

const {
  GEN_MAX_LENGTH,
  createGeneratorRegistry,
  loadGeneratorSource,
  normalizeGeneratorDef,
  normalizeGeneratorFields,
  validateGeneratorInputs,
  runGenerator,
  shouldAutoCopy,
  clampFieldValue
} = globalThis.PassletLogic;

/** 一个最小可用的生成器定义，各用例在此基础上改。 */
const baseDef = () => ({
  id: "demo",
  name: "演示",
  fields: [{ key: "feature", label: "特征码", required: true }],
  generate: inputs => `x${inputs.feature}`
});

/** 拼一段插件源码：注册一个官方契约里的生成器。 */
function pluginSource(extra = "") {
  return `
    PassletGenerators.register({
      id: "demo",
      name: "演示",
      fields: [{ key: "feature", label: "特征码", required: true }],
      generate(inputs) { return "x" + inputs.feature; }
    });
    ${extra}
  `;
}

describe("createGeneratorRegistry：登记与校验", () => {
  it("按注册顺序返回，get 能取到", () => {
    const registry = createGeneratorRegistry();
    registry.register({ ...baseDef(), id: "first", name: "甲" });
    registry.register({ ...baseDef(), id: "second", name: "乙" });

    expect(registry.list().map(item => item.id)).toEqual(["first", "second"]);
    expect(registry.get("second").name).toBe("乙");
    expect(registry.get("nope")).toBeNull();
  });

  it("定义缺 id / name / generate 时抛 gen_bad_def", () => {
    const registry = createGeneratorRegistry();
    const noId = { ...baseDef(), id: "" };
    const noName = { ...baseDef(), name: "  " };
    const noGenerate = { ...baseDef(), generate: null };

    expect(() => registry.register(noId)).toThrowError(/id/);
    expect(() => registry.register(noName)).toThrowError(/name/);
    expect(() => registry.register(noGenerate)).toThrowError(/generate/);
    expect(registry.list()).toHaveLength(0);
  });

  it("id 只接受小写字母、数字和短横线", () => {
    const registry = createGeneratorRegistry();
    for (const bad of ["Demo", "de mo", "demo_1", "-demo", "d".repeat(65)]) {
      expect(() => registry.register({ ...baseDef(), id: bad })).toThrowError(/id/);
    }
    expect(() => registry.register({ ...baseDef(), id: "demo-2" })).not.toThrow();
  });

  it("重复的 id 被拒绝，先注册的保留", () => {
    const registry = createGeneratorRegistry();
    registry.register({ ...baseDef(), name: "先来" });

    let error = null;
    try {
      registry.register({ ...baseDef(), name: "后到" });
    } catch (err) {
      error = err;
    }
    expect(error && error.code).toBe("gen_dup_id");
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].name).toBe("先来");
  });

  it("fields 不是数组时算定义不完整", () => {
    expect(() => normalizeGeneratorFields("nope")).toThrowError(/fields/);
  });

  it("fields 缺 key 或 label 时算定义不完整", () => {
    expect(() => normalizeGeneratorFields([{ label: "甲" }])).toThrowError(/key/);
    expect(() => normalizeGeneratorFields([{ key: "a" }])).toThrowError(/label/);
  });

  it("fields 缺省为空数组，maxLength 钳到 1~200", () => {
    expect(normalizeGeneratorFields(undefined)).toEqual([]);
    expect(normalizeGeneratorFields([])).toEqual([]);
    const [field] = normalizeGeneratorFields([
      { key: "a", label: "甲", maxLength: 0 },
      { key: "b", label: "乙", maxLength: 99999 }
    ]);
    expect(field.maxLength).toBe(1);
    expect(normalizeGeneratorFields([{ key: "b", label: "乙", maxLength: 99999 }])[0].maxLength).toBe(200);
  });

  it("规范化后保留 generate 引用，placeholder 缺省为空串", () => {
    const def = normalizeGeneratorDef(baseDef());
    expect(typeof def.generate).toBe("function");
    expect(def.fields[0].placeholder).toBe("");
    expect(def.fields[0].required).toBe(true);
  });
});

describe("loadGeneratorSource：执行插件源码", () => {
  it("正常源码能注册成功", () => {
    const registry = createGeneratorRegistry();
    expect(loadGeneratorSource(registry, pluginSource(), "a.js")).toBe(true);
    expect(registry.list()).toHaveLength(1);
    expect(registry.problems()).toHaveLength(0);
  });

  it("语法错误只记一条问题，不抛出去", () => {
    const registry = createGeneratorRegistry();
    expect(loadGeneratorSource(registry, "PassletGenerators.register({", "bad.js")).toBe(false);
    const problems = registry.problems();
    expect(problems).toHaveLength(1);
    expect(problems[0].file).toBe("bad.js");
    expect(problems[0].message).toContain("加载失败");
  });

  it("注册期抛错被记成加载失败", () => {
    const registry = createGeneratorRegistry();
    const source = 'throw new Error("插件自己炸了");';
    expect(loadGeneratorSource(registry, source, "boom.js")).toBe(false);
    expect(registry.problems()[0].message).toContain("插件自己炸了");
  });

  it("同一个文件里，坏定义不影响已经注册成功的那一个", () => {
    const registry = createGeneratorRegistry();
    const source = `
      PassletGenerators.register({
        id: "good", name: "好的",
        generate() { return "1"; }
      });
      PassletGenerators.register({ id: "bad", name: "坏的" });
    `;
    expect(loadGeneratorSource(registry, source, "mixed.js")).toBe(false);
    expect(registry.list().map(item => item.id)).toEqual(["good"]);
    expect(registry.problems()[0].message).toContain("定义不完整");
  });

  it("重名生成器报重并跳过，不影响前一个文件", () => {
    const registry = createGeneratorRegistry();
    loadGeneratorSource(registry, pluginSource(), "first.js");
    expect(loadGeneratorSource(registry, pluginSource(), "second.js")).toBe(false);
    expect(registry.problems()[0].message).toContain("重名");
    expect(registry.list()).toHaveLength(1);
  });

  it("作用域里只注入 PassletGenerators：插件看不到 logic.js 的内部变量", () => {
    const registry = createGeneratorRegistry();
    // clampInt / createGeneratorRegistry 都是 logic.js 闭包里的名字，不是全局的。
    // 插件里能取到其中任何一个，就说明注入面比设计的宽。
    const source = `
      PassletGenerators.register({
        id: "probe",
        name: "探针",
        generate() {
          return [typeof clampInt, typeof createGeneratorRegistry, typeof window].join(",");
        }
      });
    `;
    expect(loadGeneratorSource(registry, source, "probe.js")).toBe(true);

    const result = runGenerator(registry.get("probe"), {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe("undefined,undefined,undefined");
  });
});

describe("runGenerator：结果校验", () => {
  it("返回字符串就是结果", () => {
    const result = runGenerator(baseDef(), { feature: "abc" });
    expect(result).toEqual({ ok: true, value: "xabc" });
  });

  it("抛错收成 gen_throw", () => {
    const def = { ...baseDef(), generate() { throw new Error("内部错误"); } };
    const result = runGenerator(def, {});
    expect(result.ok).toBe(false);
    expect(result.code).toBe("gen_throw");
    expect(result.message).toContain("内部错误");
  });

  it("返回非字符串或空串收成 gen_empty", () => {
    expect(runGenerator({ ...baseDef(), generate: () => 123 }, {}).code).toBe("gen_empty");
    expect(runGenerator({ ...baseDef(), generate: () => "" }, {}).code).toBe("gen_empty");
    expect(runGenerator({ ...baseDef(), generate: () => undefined }, {}).code).toBe("gen_empty");
  });

  it("1024 个字符允许，1025 个拒绝", () => {
    const ok = runGenerator({ ...baseDef(), generate: () => "a".repeat(GEN_MAX_LENGTH) }, {});
    expect(ok.ok).toBe(true);
    const tooLong = runGenerator({ ...baseDef(), generate: () => "a".repeat(GEN_MAX_LENGTH + 1) }, {});
    expect(tooLong.ok).toBe(false);
    expect(tooLong.code).toBe("gen_too_long");
  });

  it("含换行或控制字符被拒绝", () => {
    expect(runGenerator({ ...baseDef(), generate: () => "a\nb" }, {}).code).toBe("gen_control_chars");
    expect(runGenerator({ ...baseDef(), generate: () => "a\u0000b" }, {}).code).toBe("gen_control_chars");
    expect(runGenerator({ ...baseDef(), generate: () => "a\u007fb" }, {}).code).toBe("gen_control_chars");
  });

  it("找不到生成器时报 gen_missing", () => {
    expect(runGenerator(null, {}).code).toBe("gen_missing");
  });
});

describe("validateGeneratorInputs：必填校验", () => {
  it("必填字段为空时给出字段名", () => {
    expect(validateGeneratorInputs(baseDef(), {})).toBe("请先填写“特征码”。");
    expect(validateGeneratorInputs(baseDef(), { feature: "" })).toBe("请先填写“特征码”。");
  });

  it("填了通过，非必填为空也通过", () => {
    expect(validateGeneratorInputs(baseDef(), { feature: "abc" })).toBeNull();
    const def = { ...baseDef(), fields: [{ key: "opt", label: "可选", required: false }] };
    expect(validateGeneratorInputs(def, {})).toBeNull();
  });

  it("没有字段时直接通过", () => {
    expect(validateGeneratorInputs({ ...baseDef(), fields: [] }, {})).toBeNull();
  });
});

describe("clampFieldValue：输入截断", () => {
  it("超过 maxLength 就截断，未超过原样返回", () => {
    expect(clampFieldValue("abcdef", 3)).toBe("abc");
    expect(clampFieldValue("ab", 3)).toBe("ab");
  });

  it("按字符数而不是字节数截断", () => {
    expect(clampFieldValue("中文汉字", 2)).toBe("中文");
  });

  it("缺省上限是 200，非法值回落 200", () => {
    const long = "a".repeat(300);
    expect(clampFieldValue(long, undefined)).toHaveLength(200);
    expect(clampFieldValue(long, 0)).toHaveLength(1);
  });
});

describe("shouldAutoCopy：什么时候写剪贴板", () => {
  it("有结果且与上次不同才写", () => {
    expect(shouldAutoCopy("abc", "")).toBe(true);
    expect(shouldAutoCopy("abc", "xyz")).toBe(true);
    expect(shouldAutoCopy("abc", "abc")).toBe(false);
  });

  it("空结果不写", () => {
    expect(shouldAutoCopy("", "")).toBe(false);
    expect(shouldAutoCopy("", "abc")).toBe(false);
  });
});
