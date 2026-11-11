# Passlet

一个很小的桌面密码本：主密码放在环境变量里，条目按「平台 + 用户名」记，界面只有三个视图。

- 目标平台：Windows（Linux / macOS 走同一套 Tauri 代码，未实测）
- 安装包：约 6 MB
- 数据：单个加密文件 `%APPDATA%\Passlet\vault.dat`
- 加密：Argon2id（32 MiB / 3 轮）派生密钥 → XChaCha20-Poly1305 整体加密

---

## 先读这一段：安全模型

Passlet 把主密码交给**环境变量**，这意味着：

1. 任何以你的身份运行的程序都能读到主密码——这是这个设计的前提，不是漏洞，但你必须知道它。
2. 库文件本身是加密的。**别人拿到 `vault.dat` 而没有主密码，打不开。**
3. 主密码**不写在库里**，所以库里没有可供破解的验证值；密码错就是解不开。
4. 只有点“显示密码”时明文才进入界面进程（选中条目本身不会取明文）；看完自动隐藏。
5. 复制密码后默认 30 秒清空剪贴板（可在设置里改），但**程序退出时不会再处理剪贴板**。

想更稳一点：把主密码设得长一点（这一条比其他所有措施都重要）。

---

## 第一次使用

程序启动时会读环境变量 `PASSLET_MASTER`。它没被设置的话，程序会停在一个说明页，不会退出。

### 方式一：设成用户级环境变量（一次设置，之后双击即用）

在 PowerShell 里运行仓库中的脚本：

```powershell
.\scripts\set-user-env.ps1
```

它会把主密码写进 `HKCU\Environment`。**注意这是明文存注册表**，任何以你身份运行的程序都读得到。
设置完要重新打开程序（已经开着的进程读不到新变量）。

也可以手动：

```powershell
setx PASSLET_MASTER "你的主密码"
```

### 方式二：用启动脚本（主密码不写注册表）

```powershell
.\scripts\make-launch-script.ps1 -ExePath "C:\路径\到\Passlet.exe"
```

它会在 `%USERPROFILE%\passlet-launch.bat` 生成一个带主密码的启动脚本，双击即可。
主密码只对这个进程生效。**那个 .bat 是明文文件**，别放到会同步到云端的目录里。

---

## 日常使用

**查询页**（打开就是它）

1. 选平台（可以打字过滤）
2. 选用户名（该平台只有一个账号时会自动选中）
3. 密码默认是掩码，点眼睛看明文，30 秒后自动变回掩码
4. 点复制把密码放进剪贴板

**清单页**（点「打开清单」）

- 搜索平台或用户名
- 每行：显示 / 复制 / 编辑 / 删除；双击行也是编辑
- 「＋ 新增」加一条

**设置页**（清单右上角的齿轮）

- 主题：跟随系统 / 浅色 / 深色
- 剪贴板自动清空的开关与秒数
- 明文密码自动隐藏的秒数（0 = 不隐藏）
- 数据文件路径、导出加密备份、导入备份
- 更换主密码

---

## 数据文件与备份

| 文件 | 位置 | 说明 |
|---|---|---|
| `vault.dat` | `%APPDATA%\Passlet\` | 加密的库 |
| `vault.dat.bak` | 同上 | 上一次写盘的旧版本，出问题可以手动换回来 |
| `config.json` | 同上 | 明文配置（不含密码） |

**导出**：设置页「导出加密备份」→ 存成 `.pvault`。它和 `vault.dat` 是同一种格式，
用**当前**主密码加密，可以直接复制到别的机器。

**导入**：设置页「导入备份」→ 选文件 → 选合并方式：

- **整库替换**：先把现有库备份成 `vault.dat.bak.<时间戳>`，再用备份内容替换
- **合并 · 跳过重复**：同平台同用户名的跳过
- **合并 · 覆盖重复**：同平台同用户名的用备份里的密码覆盖

导入的备份必须能用当前主密码解开，否则会拒绝导入且不动现有数据。

---

## 更换主密码

设置页 →「更换主密码」。成功后**必须同时改环境变量**，否则下次启动会打不开：

```powershell
setx PASSLET_MASTER "新的主密码"
```

程序不会替你改环境变量（它不该去动你的系统设置），所以这一步只能你自己做。

---

## 从源码构建

需要：Rust（含 MSVC 工具链）、Node 18+、pnpm。

```powershell
pnpm install
pnpm build              # 先编 CLI，再打 GUI 安装包
```

产物（工作区共用根目录 `target/`）：

| 文件 | 路径 | 体积 |
|---|---|---|
| 图形界面 | `target/release/passlet.exe` | ~3.6 MB |
| 命令行 | `target/release/passlet-cli.exe` | ~0.5 MB |
| 安装包 | `target/release/bundle/nsis/*.exe` | ~1.5 MB |

开发时：

```powershell
pnpm tauri dev
```

只想看界面（不需要 Rust）：

```powershell
pnpm preview            # 生成 design/ui2a/passlet-preview.html，双击打开
```

预览页用的是内存里的假数据（`frontend/demo-api.js`），不会读写真实库。

---

## 测试

```powershell
pnpm test               # 前端纯函数单测（vitest）
pnpm test:rust          # Rust 单测，单线程跑
```

Rust 侧单线程是刻意的：Argon2 每次要 32 MiB 内存，并行跑几个用例会把内存打满。

---

## 命令行

```powershell
passlet-cli doctor                        # 数据目录、库文件、条目数、主密码来源
passlet-cli list                          # 平台<TAB>用户名
passlet-cli list --json                   # 结构化
passlet-cli get GitHub me                 # 打印密码
passlet-cli get GitHub me --copy          # 复制到剪贴板而不是打印
echo -n "密码" | passlet-cli add GitHub me
echo -n "新密码" | passlet-cli update GitHub me
passlet-cli remove GitHub me --yes
passlet-cli export D:\backup.pvault
passlet-cli import D:\backup.pvault              # 默认 skip：跳过同平台同名用户的条目
passlet-cli import D:\backup.pvault --mode replace  # 整库替换，替换前留 .bak 备份
passlet-cli change-master
```

约定：stdout 只有数据（提示与错误走 stderr）；**密码只从标准输入读**，永不作命令行参数；
全局 `--vault <目录>` 可指向别处的库；退出码 `0/1/2/3/4/5` 分别对应成功、用法或确认问题、
主密码缺失或错误、条目不存在、条目重复、文件读写失败。

## 给 AI 用的 skill

`skill/passlet-cli/` 教 AI 怎么**用**密码而不把明文读进上下文：值只留在某个进程里，
直接交给需要它的程序；禁止 echo、禁止进命令行参数、禁止 tee 落盘。

安装到当前 DSH profile：

```powershell
Copy-Item -Recurse -Force .\skill\passlet-cli "$env:USERPROFILE\.dsh\skills\passlet-cli"
```

## 已知限制

- 同时开两个实例时，**后保存的会覆盖先保存的**（没有做文件锁）
- 新增/编辑弹窗关掉时不会提示"未保存"，改动直接丢弃
- 程序退出不清理剪贴板
- 托盘常驻、密码生成器、密码强度提示都没有（不在 v1 范围内）
- 只有界面语言是中文，没有做多语言

---

## 目录结构

```
frontend/          界面（纯静态 HTML/CSS/JS，无构建）
  index.html
  styles.css       daisyUI 之上的布局与主题变量
  vendor/          daisyUI 5 的完整 CSS（不走 Tailwind，也不需要构建）
  logic.js         纯函数：匹配、过滤、钳制（可单测）
  api.js           调 Rust 命令的薄封装
  app.js           视图状态机与渲染
  demo-api.js      仅预览构建使用
core/              passlet-core：加密、存储、条目模型、配置（不含 GUI 框架）
src-tauri/         GUI 外壳与 Tauri 命令
cli/               passlet-cli：命令行入口（只依赖 core，产物 0.5 MB）
skill/             passlet-cli 的 AI skill
tests/             前端单测（vitest）
scripts/           构建预览、设置环境变量、生成启动脚本
docs/PLAN.md       设计与决策记录
design/            界面原型与截图
```
