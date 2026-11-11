// Rust 命令与前端调用之间的"契约测试"。
// Tauri 按参数名把 JS 对象映射到 Rust 形参，名字对不上只会在运行时炸，
// 编译器完全不管。这里直接把两侧的源码读出来做交叉比对。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rustSource = readFileSync(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8");
const jsSource = readFileSync(new URL("../frontend/api.js", import.meta.url), "utf8");

/** 这几个参数由 Tauri 自己注入，前端不需要（也不能）传。 */
const INJECTED = new Set(["app", "state", "window"]);

const toCamel = name => name.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

function parseRustCommands() {
  const commands = new Map();
  const pattern = /#\[tauri::command\]\s*pub (?:async )?fn (\w+)\s*\(([\s\S]*?)\)\s*(?:->\s*[^{]+)?\{/g;
  let match;
  while ((match = pattern.exec(rustSource)) !== null) {
    const name = match[1];
    // (?!:) 用来排除 `tauri::State` 这类路径——否则会被当成名叫 tauri 的参数
    const params = [...match[2].matchAll(/(\w+)\s*:(?!:)/g)]
      .map(item => item[1])
      .filter(param => !INJECTED.has(param))
      .map(toCamel);
    commands.set(name, params);
  }
  return commands;
}

function parseJsCalls() {
  const calls = new Map();
  const pattern = /call\(\s*"([a-z_]+)"\s*(?:,\s*\{([^}]*)\})?\s*\)/g;
  let match;
  while ((match = pattern.exec(jsSource)) !== null) {
    const keys = (match[2] || "")
      .split(",")
      .map(piece => piece.split(":")[0].trim())
      .filter(Boolean);
    calls.set(match[1], keys);
  }
  return calls;
}

const rustCommands = parseRustCommands();
const jsCalls = parseJsCalls();

describe("命令契约：前端调用与 Rust 形参一致", () => {
  it("能解析出两侧的清单（防止正则悄悄失效导致测试形同虚设）", () => {
    expect(rustCommands.size).toBeGreaterThanOrEqual(14);
    expect(jsCalls.size).toBeGreaterThanOrEqual(14);
  });

  it("前端调用的每个命令都在 Rust 侧存在", () => {
    const missing = [...jsCalls.keys()].filter(name => !rustCommands.has(name));
    expect(missing).toEqual([]);
  });

  it("Rust 侧的每个命令都被前端调用（没有孤岛命令）", () => {
    const unused = [...rustCommands.keys()].filter(name => !jsCalls.has(name));
    expect(unused).toEqual([]);
  });

  it("每条命令的参数名逐一对齐（含大小写转换）", () => {
    const mismatched = [];
    for (const [name, rustParams] of rustCommands) {
      if (!jsCalls.has(name)) continue;
      const jsParams = jsCalls.get(name);
      if (jsParams.length !== rustParams.length || jsParams.some((param, i) => param !== rustParams[i])) {
        mismatched.push(`${name}: JS 传 [${jsParams}] / Rust 要 [${rustParams}]`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
