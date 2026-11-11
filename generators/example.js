// 示例插件：演示一个生成器由哪三部分组成。
//
// 它不是任何人的真实规则，只是把接口用满一次：
//   id/name —— 界面上选的是哪一个
//   fields  —— 这个算法需要哪些输入
//   generate —— 怎么算（必须返回非空字符串）
//
// 自己的规则请不要写在这个文件里，而是另建一个 .js 放在同一目录：
// 本目录除 example.js 之外都被 .gitignore 排除。
PassletGenerators.register({
  id: "example-prefix",
  name: "示例：前缀拼接",
  fields: [
    { key: "prefix", label: "前缀", placeholder: "例如 acme", required: true, maxLength: 40 },
    { key: "times", label: "重复次数", placeholder: "1 到 8，留空按 3", maxLength: 2 }
  ],
  generate(inputs) {
    const times = Math.min(8, Math.max(1, Number(inputs.times || 3) || 3));
    return (inputs.prefix.trim() + "-").repeat(times).replace(/-$/, "");
  }
});
