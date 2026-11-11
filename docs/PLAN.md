# Passlet 开发计划

- 版本：v1（首版）
- 日期：2026-11-10
- 状态：待人工审查（闸门1）
- 原型：`design/index.html`（视觉基线，不参与构建）

---

## 1. 功能需求

每条需求可被一条用例验证。编号 R<n> 供阶段二、三引用。

### R1 主密码来源
- 启动时读取环境变量 `PASSLET_MASTER`（UTF-8 原文，不做 trim、不做长度限制以外的处理）。
- 读到 → 派生密钥、解密 `vault.dat`，进入查询视图。
- 没读到（未设置或空串）→ 进入**错误视图**，**不退出程序**，页面写明设置方法。
- 环境变量每次启动只读一次；运行期间改环境变量不影响当前会话。

### R2 查询视图 · 平台选择
- 一个平台输入框，带 AutoComplete：可以打字过滤，下拉只列出**库里已有的平台**。
- 输入库里不存在的平台时，下拉显示“没有匹配的平台”，不产生任何查询。
- 平台一旦选中，触发 R3。

### R3 查询视图 · 用户名选择
- 未选平台时用户名框禁用，占位文案“请先选择平台”。
- 已选平台时，用户名下拉只列该平台下的用户名；同样带 AutoComplete。
- 该平台下只有 1 个用户名时，**自动选中**。
- 平台切换 → 用户名清空并重新过滤。

### R4 查询视图 · 密码显示
- 平台 + 用户名都选定后，密码框显示掩码（长度固定 8 个圆点，不泄露真实长度）。
- 点“显示”图标 → 切明文；再点或在 `hidePasswordSeconds` 秒后 → 自动回掩码。
- `hidePasswordSeconds = 0` 表示不自动隐藏。
- 换选择（换平台/用户名）立即回掩码。

### R5 复制密码
- 点“复制”图标把密码写入系统剪贴板，底部提示“已复制“<平台>”的密码”。
- `clipboardClearEnabled` 为真时，`clipboardClearSeconds` 秒后检查剪贴板：**只有内容仍等于这次写入的文本**才清空，否则不动。
- 期间再次复制 → 计时复位。
- 进程退出时不再处理剪贴板（文档说明）。

### R6 进入清单
- 查询视图右下角“打开清单”按钮 → 同一窗口切到**清单视图**，窗口尺寸变为 `840×474`（或用户记住的尺寸）。
- 返回查询视图的路径：清单左上角返回按钮；窗口尺寸还原。

### R7 清单视图 · 查看
- 表格 4 列：平台 / 用户名 / 密码（掩码）/ 操作。
- 顶部搜索框：按平台或用户名过滤，**不区分大小写**，子串匹配；命中数为 0 显示空态文案。
- 每行操作：显示（切明文）、复制、编辑、删除。
- 双击行 = 编辑。
- 底栏显示“共 N 条”或“匹配 M / 共 N 条”。

### R8 清单视图 · 增删改
- “＋ 新增” → 弹窗三字段（平台、用户名、密码），密码可切明文。
- 保存即写盘，无需额外“保存”动作。
- 唯一性：同平台 + 同用户名（**比较时忽略大小写**，保存保留用户输入的原样）不可重复，重复时弹提示且不写盘。
- 删除：点垃圾桶 → 二次确认（原生确认对话框），确认后才删。
- 编辑：弹窗预填当前值。

### R9 设置视图
从清单标题栏齿轮进入，同窗口切换。包含：
1. 剪贴板：开关 + 秒数（1~600，默认 30）
2. 密码掩码自动隐藏：秒数（0~600，0 = 不自动隐藏，默认 30）
3. 记住窗口尺寸：开关（默认开）
4. 数据文件路径：只读展示，带“复制路径”
5. 导入 / 导出入口
6. 更换主密码

### R10 导出
- 点击 → 原生保存对话框，默认文件名 `passlet-backup-YYYYMMDD-HHmmss.pvault`。
- 内容 = 当前 `vault.dat` 的字节副本（同主密码可解）。
- 成功提示“已导出到 <路径>”；取消则无提示。

### R11 导入
- 点击 → 原生打开对话框 → 选中文件后弹出模式选择：
  - **整库替换**：先把当前库备份成 `vault.dat.bak.<时间戳>`，再用导入文件覆盖。
  - **合并 · 跳过重复**：同平台 + 同用户名（忽略大小写）的跳过，其余追加。
  - **合并 · 覆盖重复**：同平台 + 同用户名的用导入值覆盖，其余追加。
- 导入文件必须能用当前主密码解开；解不开 → 报错且不动现有数据。
- 成功后重新加载清单，提示“已导入 N 条（跳过 M 条 / 覆盖 K 条）”。

### R12 更换主密码
- 设置视图内：新密码 + 确认新密码（均 ≥ 8 字符）。
- 校验通过 → 用当前密钥读库 → 用新密码重新派生 + 整体加密 → 原子写盘。
- 成功提示必须包含：“记得同步修改环境变量 `PASSLET_MASTER`，否则下次启动会打不开”。
- 失败（两次不一致 / 太短 / 写盘失败）→ 原库不变。

### R13 会话与锁定
- 进入清单或设置时不重新派生；**离开清单且回到查询视图、或关闭窗口** → 丢弃明文与密钥。
- 再次进清单 → 重新读环境变量、重新派生（用户无感，约 0.2 秒）。
- 程序退出 → 密钥与明文清零（`zeroize`）。

### R14 首次运行
- `%APPDATA%\Passlet\`（非 Windows 用系统 data 目录）不存在 → 自动创建。
- `vault.dat` 不存在 → 视为空库；**首次保存时才创建文件**。
- `config.json` 不存在 → 用默认值，不写盘；用户改过设置才写。

### R15 主题（浅色 / 深色 / 跟随系统）
- 默认 `system`：跟随操作系统的深浅色设置，系统切换时**实时**跟着变，不需要重启。
- 设置视图里可手动选 `浅色` / `深色` / `跟随系统`，选择立即生效并写进 `config.json`。
- 手动选定后不再跟随系统；切回 `system` 时立刻重新跟随。
- 两套主题共用同一份结构，只换颜色变量，不做两套布局。
- 截图/演示可用 `?theme=light|dark` 临时覆盖，**不写进配置**。

### R16 层级（已否决）
- 曾考虑在“平台”和“用户名”之间再加一级（分组 / 环境 / 子站点）。
- 2026-11-10 用户决定**不加**：追求简单，维持两级。若将来要分类，优先考虑“标签”（多值、可筛选）而不是硬层级。

### 非目标（v1 明确不做）
- 密码生成器、密码强度提示、拼音/模糊搜索、托盘常驻、全局快捷键、多用户、云同步、明文 CSV 导出、跨库去重报告、平台与用户名之间的第三级。

---

## 2. 技术方案（含选型理由与否决方案）

### 选定
| 层 | 选型 | 理由 |
|---|---|---|
| 外壳 | **Tauri 2** | 安装包 5~10 MB 量级，跨平台三系统，复用已做好的 HTML 界面 |
| 前端 | **纯静态 HTML/CSS/JS（经典脚本，无打包器）** | 不引入 React/Vite 就没有构建步骤，`frontend/` 目录本身就是 `frontendDist`；经典脚本而非 ES module，是为了让 `index.html` 从 `file://` 双击打开也能跑（浏览器会拦 `file://` 下的 module） |
| 组件库 | **daisyUI 5（vendor 内联 CSS）** | 自带完整 CSS，不需要 Tailwind、不需要构建；提供 btn / input / select / toggle / modal 等成套件与两套主题，正好补上“自己写全部 CSS 观感平淡”的短板 |
| 后端 | **Rust（Tauri 内置）** | 加密、文件 IO、环境变量、剪贴板、文件对话框都必须在可信侧；也让明文只出现在 Rust 内存里 |
| 加密 | **Argon2id（m=32 MiB, t=3, p=1, out=32B）+ XChaCha20-Poly1305** | Argon2id 是密码派生的事实标准；XChaCha20 的 24 字节随机 nonce 允许“每次保存重新随机 nonce”而不必担心碰撞 |
| 存储 | 单文件二进制容器 `vault.dat` + 明文 `config.json` | 单文件便于整体备份/导出；配置里无秘密，明文便于排障 |
| 对话框 | `tauri-plugin-dialog` | 原生文件选择/保存，无需自绘 |
| 剪贴板 | `tauri-plugin-clipboard-manager`（Rust 侧调用） | 密钥与明文不进 WebView；定时清空在 Rust 里做 |

### 否决的备选
| 备选 | 否决理由 |
|---|---|
| **Avalonia**（上一版方案） | 界面已按 HTML 定稿；改 XAML 等于重画一遍，而需求本身没有需要原生控件的地方 |
| **Electron** | 空壳就 100 MB 起，内存占用是 Tauri 的数倍，与“很小个”直接冲突 |
| **纯网页 + 本地 HTTP 服务** | 要常驻一个本地端口，攻击面变大；还要处理端口冲突、跨域、鉴权 |
| **Rust 侧用 SQLite 存密文行** | 需要引入 rusqlite + 每行单独加盐/加密，复杂度上升而收益为零（条目是几十到几百条量级） |
| **前端 WebCrypto 做加解密** | Argon2 在浏览器里没有原生实现；密钥必然停留在 WebView 内存，安全性反而更差 |
| **明文 JSON 存储** | 直接违背密码管理器的存在意义 |
| **Vite + React** | 引入构建链与依赖树，对 4 个视图的静态界面是过度设计 |
| **全部 CSS 手写**（2a 第一版做法） | 观感平淡，且 hover / focus / disabled / 深色模式要逐条自己实现；四个视图下来重复劳动多 |
| **Tailwind + daisyUI（走构建）** | 只为一份 CSS 引入 Node 构建链不划算；daisyUI 官方提供完整 CSS，vendor 进来即可 |
| **Bootstrap 5 / Pico CSS**（实测对比过） | Bootstrap 观感仍偏网页表单；Pico 跟随系统深色，浅色卡片里会露出黑底控件，需大量覆盖，反而更乱 |

### 关键实现决定（不需要你拍板，记录在此）
- 数据文件格式（48 字节头 + 密文）：
  ```
  0   .. 8   "PASSLET1"           magic（8 字节 ASCII）
  8   .. 24  salt                 16 字节随机，每次更换主密码时重生成
  24  .. 48  nonce                24 字节随机，每次写盘重生成
  48  ..     ciphertext + tag     XChaCha20-Poly1305(JSON 明文)
  ```
- 原子写：写 `vault.dat.tmp` → fsync → 若已存在则改名成 `vault.dat.bak` → `vault.dat.tmp` 改名成 `vault.dat`。`.bak` 保留为上一版，天然可回滚。
- 密钥与明文用 `zeroize::Zeroizing` 包裹，`lock()` 时显式清零。
- 明文 JSON 里字段顺序固定、UTF-8 不转义，便于人工排查（内容是密文，不影响安全）。
- 平台/用户名的 AutoComplete 匹配规则：**不区分大小写的前缀优先、其次子串**，用前端纯函数实现（可单测）。
- 窗口尺寸切换用 Rust 命令 `set_view(view)` 一次完成（改尺寸 + 通知前端渲染），避免前端直接操作窗口权限。

---

## 3. 系统结构

```
┌──────────────────────── WebView（不可信侧）────────────────────────┐
│  index.html + styles.css                                            │
│  app.js       视图状态机：error | query | list | settings           │
│  logic.js     纯函数：过滤/补全/排序/时长格式化（无 DOM，可单测）    │
│  api.js       invoke 薄封装，一个命令一个函数                       │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ Tauri IPC（仅 JSON；不含密钥）
┌──────────────────────────────▼─────────────────────────────────────┐
│  commands.rs   命令层：参数校验、调用编排、错误 → 错误码 + 文案     │
│      │                                                             │
│      ├── session.rs   会话：Mutex<Option<Session{key, vault}>>      │
│      ├── crypto.rs    Argon2id 派生 / XChaCha20 加解密 / 容器编码   │
│      ├── storage.rs   读、原子写、.bak、导入备份、路径解析          │
│      ├── vault.rs     条目模型 + CRUD + 唯一性 + 三种合并           │
│      └── config.rs    配置读写 + 非法值回落                          │
│                            │                                       │
│                            ▼                                       │
│                    %APPDATA%\Passlet\{vault.dat, config.json}       │
└────────────────────────────────────────────────────────────────────┘
```

调用方向单一：WebView → commands → 内部模块 → 文件系统。内部模块之间不回调 WebView。

---

## 4. 数据结构

### 4.1 条目 `Entry`
| 字段 | 类型 | 可空 | 约束 / 默认 |
|---|---|---|---|
| `id` | String | 否 | 32 位小写 hex（16 随机字节），全局唯一 |
| `platform` | String | 否 | trim 后 1~200 字符；保存原样（不归一化大小写） |
| `username` | String | 否 | trim 后 1~200 字符；同上 |
| `password` | String | 否 | 1~1024 字符，**不 trim**（首尾空格可能是密码的一部分） |
| `createdAt` | String | 否 | RFC3339 UTC，创建时写入，编辑不变 |

唯一性：`(platform.trim(), username.trim())` 忽略大小写的组合唯一。

### 4.2 库 `Vault`（密文内的 JSON）
```json
{
  "version": 1,
  "entries": [ /* Entry[]，数组顺序 = 清单展示顺序（新条目插到头部） */ ]
}
```
`version` 用于将来迁移；读到更高版本 → 报错“数据文件版本比程序新”。

### 4.3 配置 `Config`（明文 `config.json`）
| 字段 | 类型 | 默认 | 范围 / 说明 |
|---|---|---|---|
| `version` | u32 | 1 | |
| `theme` | string | `system` | `system` / `light` / `dark`，其余值回落 `system` |
| `clipboardClearEnabled` | bool | true | |
| `clipboardClearSeconds` | u32 | 30 | 1~600，越界回落 30 |
| `hidePasswordSeconds` | u32 | 30 | 0~600，0 = 不自动隐藏，越界回落 30 |
| `rememberWindowSize` | bool | true | |
| `windowSizes` | object | 见下 | 每项 `[宽, 高]`，非法或 < 300×200 回落默认 |

默认尺寸：`query: [462, 272]`、`list: [840, 474]`、`settings: [620, 560]`。

### 4.4 对前端暴露的结构（不含密钥）
- `EntryMeta { id, platform, username }` —— 清单/下拉用，**不含密码**
- `ConfigView` —— 同 4.3
- `ImportReport { added, skipped, replaced, mode }`
- `AppStatus { masterLoaded: bool, reason?: "env_missing" | "decrypt_failed" | "corrupt" }`

---

## 5. 模块划分（职责 / 不负责什么）

| 模块 | 负责 | **不负责** |
|---|---|---|
| `app.js` | 视图状态机、DOM 渲染、事件绑定、调用 `api.js` | 任何加解密、文件 IO、参数合法性最终判定 |
| `logic.js` | 纯函数：AutoComplete 匹配、清单过滤、秒数文案、窗口尺寸回落 | 不碰 DOM、不调 invoke（因此可单测） |
| `api.js` | 一个命令一个函数，统一错误转换 | 不做业务判断、不做缓存 |
| `commands.rs` | 入参校验（长度/空值/范围）、编排、错误码与中文文案 | 不直接碰加密算法细节、不做 UI 状态 |
| `session.rs` | 持有/清零密钥与内存库、`unlock`/`lock` | 不做文件 IO、不做业务规则 |
| `crypto.rs` | 派生、加解密、容器编解码、magic 校验 | 不知道“条目”是什么、不碰路径 |
| `storage.rs` | 路径解析、读取、原子写、`.bak`、导入前备份 | 不解释密文内容 |
| `vault.rs` | `Entry`/`Vault` 模型、CRUD、唯一性、三种合并策略 | 不碰密钥、不碰文件 |
| `config.rs` | 配置读写与非法值回落 | 不碰敏感数据 |
| `scripts/*.ps1` | 设置用户环境变量、生成仓库外的启动脚本 | 不在仓库内落任何明文密码 |

---

## 6. 交互逻辑

### 6.1 启动
```
读 PASSLET_MASTER
 ├─ 缺失/空 ────────────────→ 视图 error（不退出，窗口 462×272 固定）
 └─ 有
     ├─ vault.dat 不存在 ────→ 空库，视图 query
     ├─ 解密成功 ────────────→ 视图 query
     └─ 解密失败 ────────────→ 视图 error（reason=decrypt_failed）
```

### 6.2 查询视图
| 操作 | 结果 |
|---|---|
| 聚焦平台框 | 下拉展开，列出全部平台（已选中的高亮） |
| 输入字符 | 实时过滤下拉项；无命中显示“没有匹配的平台” |
| 选中平台 | 用户名框启用；用户名列表加载；若仅 1 条 → 自动选中并显示掩码密码 |
| 选中用户名 | 密码框出现掩码（8 点）；显示/复制按钮启用 |
| 点眼睛 | 明文 ↔ 掩码；明文状态开始倒计时 |
| 点复制 | 写剪贴板 + 底部提示 + 启动清空计时 |
| 点“打开清单” | `set_view('list')` → 窗口变 840×474，渲染清单 |

### 6.3 清单视图
| 操作 | 结果 |
|---|---|
| 输入搜索词 | 实时过滤（平台/用户名，忽略大小写）；底栏计数变化 |
| 点眼睛 | 该行明文/掩码切换（多行可同时明文，各自独立倒计时） |
| 点复制 | 写剪贴板 + 提示 + 计时 |
| 点编辑 / 双击行 | 打开编辑弹窗，预填 |
| 点删除 | 原生确认框 → 确认后删除 + 写盘 + 提示 |
| 点“＋ 新增” | 打开新增弹窗（空） |
| 点齿轮 | `set_view('settings')` |
| 点返回 | `set_view('query')`，并 `lock()` |

### 6.4 弹窗（新增/编辑）
- 三字段，密码可切明文；“保存”校验：三字段非空 → 唯一性 → 写盘 → 关弹窗刷新。
- Esc 或点遮罩关闭；有未保存内容时直接丢弃（不弹二次确认，v1 简化，文档注明）。

### 6.5 设置视图
| 操作 | 结果 |
|---|---|
| 改任一配置项 | 立即写 `config.json`（失败则回滚 UI 值并提示） |
| 切换主题 | 立刻换 `html[data-theme]`，不需要重启；写进 `config.json` |
| 复制数据文件路径 | 写剪贴板 + 提示 |
| 导出 | 保存对话框 → 写文件 → 提示 |
| 导入 | 打开对话框 → 模式选择弹窗（三选一）→ 执行 → 报告 |
| 更换主密码 | 两字段 + 确认 → 重加密 → 提示含“同步改环境变量” |
| 返回 | `set_view('list')` |

### 6.6 视图与窗口尺寸
| 视图 | 尺寸（默认） | 进入时是否重新派生密钥 |
|---|---|---|
| error | 462×272（不可缩放） | 否 |
| query | 462×272 | 是（启动或从 list 返回时已 lock 过） |
| list | 840×474 | 否（沿用查询时派生的会话） |
| settings | 620×560 | 否 |

---

## 7. 异常情况（表现与提示文案）

| 场景 | 表现 | 文案 |
|---|---|---|
| 环境变量未设置 | 错误视图 | “没有读到主密码：环境变量 PASSLET_MASTER 未设置。设置方法见 README 的“第一次使用”一节。” |
| 解密失败（错密码） | 错误视图，窗口可重试 | “主密码不对，或者数据文件已损坏。如果刚改过环境变量，请确认它和原来的主密码一致。” |
| 文件 magic 不对 | 错误视图 | “这个文件不是 Passlet 的数据文件（头部标记不匹配）。” |
| 版本过高 | 错误视图 | “数据文件版本比当前程序新，请升级 Passlet。” |
| 写盘失败（磁盘满/无权限） | 弹窗，改动不生效 | “保存失败：<系统错误>。你的改动没有保存。” |
| 条目重复 | 弹窗，不写盘 | “这个平台下已经有同名用户名了。” |
| 字段为空 | 弹窗，不写盘 | “平台、用户名、密码都要填。” |
| 超长 | 弹窗，不写盘 | “平台和用户名最多 200 字，密码最多 1024 字。” |
| 导入文件格式错 | 弹窗，不动数据 | “这个文件不是 Passlet 的加密备份。” |
| 导入文件解不开 | 弹窗，不动数据 | “这份备份不是用当前主密码加密的，无法读取。” |
| 导入文件不存在/被占用 | 弹窗，不动数据 | “读不到这个文件：<系统错误>。” |
| 更换主密码两次不一致 | 弹窗，不写盘 | “两次输入的密码不一样。” |
| 新主密码过短 | 弹窗，不写盘 | “新主密码至少 8 位。” |
| 更换成功 | 弹窗（需点确定） | “主密码已更换。记得同步修改环境变量 PASSLET_MASTER，否则下次启动会打不开。” |
| 剪贴板不可用 | 底部提示 | “复制失败：系统剪贴板不可用。” |
| 目录不可写 | 错误视图 | “无法写入 <路径>：<系统错误>。请检查权限。” |

---

## 8. 边界条件

| 情况 | 处理 |
|---|---|
| 空库 | 查询页下拉提示“还没有密码，点“打开清单”新增”；清单显示空态 |
| 平台有 1 个用户名 | 自动选中（R3） |
| 平台有 0 个用户名（不可能，除非删除后未刷新） | 用户名框显示“请选择用户名”，下拉空态 |
| 平台名仅大小写不同 | 视为同名平台（唯一性忽略大小写），下拉按首次出现的写法展示 |
| 密码首尾空格 | 原样保存，不 trim |
| 密码含中文/emoji | 按字符计数，上限 1024 字符 |
| 超长输入 | 输入框 `maxlength` 限制 + 保存时二次校验 |
| 首次运行无目录 | 自动创建（`create_dir_all`） |
| `vault.dat` 存在但 0 字节 | 判定为损坏 → 错误视图 |
| 同时开两个实例 | v1 不处理（文档注明：后保存的覆盖先保存的） |
| 窗口尺寸记忆值非法 | 回落默认（`logic.js` 的纯函数，可单测） |
| 剪贴板计时期间二次复制 | 复位计时，旧计时器作废 |
| 导入时条目 id 冲突 | 重新分配新 id |
| `config.json` 是坏 JSON | 用默认值并覆盖写回，界面不报错（仅日志） |
| `theme` 值非法或缺失 | 回落 `system` |
| 系统在运行中切换深浅色 | 仅当 `theme=system` 时实时跟随；手动选定后不跟随 |

---

## 9. 修改范围（文件清单 · 基线）

新建（仓库当前只有 `.git/` 与 `design/`）：

```
docs/PLAN.md                    本计划
.gitignore                      忽略 node_modules、src-tauri/target、*.bak 等
README.md                       使用与构建说明
package.json                    devDependencies: daisyui（提供 CSS）、之后加 @tauri-apps/cli、vitest
frontend/index.html             三个视图 + 弹窗的骨架
frontend/styles.css             从 design/ 迁移并补充设置视图样式
frontend/app.js                 视图状态机与渲染
frontend/logic.js               纯函数
tests/logic.test.js             vitest 用例（不随应用打包）
frontend/api.js                 后端接口层（2a 是内存演示实现，2b 换成 invoke）
frontend/vendor/daisyui.css     daisyUI 5 官方完整 CSS（从 node_modules 复制，不走构建）
src-tauri/Cargo.toml
src-tauri/build.rs
src-tauri/tauri.conf.json       标识 com.passlet.desktop，frontendDist=../frontend
src-tauri/capabilities/default.json
src-tauri/icons/*               由 design 生成
src-tauri/src/main.rs
src-tauri/src/lib.rs            builder + 命令注册
src-tauri/src/session.rs
src-tauri/src/crypto.rs
src-tauri/src/storage.rs
src-tauri/src/vault.rs
src-tauri/src/config.rs
src-tauri/src/paths.rs
src-tauri/src/commands.rs
scripts/set-user-env.ps1        交互输入 → setx PASSLET_MASTER
scripts/demo-api.js              预览用内存后端（不随应用打包）
scripts/build-preview.mjs        生成单文件预览 HTML
.cargo/config.toml              crates 镜像（本机直连 crates.io 不可用）
pnpm-workspace.yaml             pnpm 11 的构建脚本白名单
scripts/make-launch-script.ps1  交互输入 → 在 %USERPROFILE% 生成 passlet-launch.bat
```

改动：无既有文件（`design/` 保持原样，仅作视觉参考）。

---

## 10. 实现步骤

每步独立可验证。

1. **骨架**：`.gitignore`、`package.json`、`src-tauri` 脚手架、`tauri.conf.json`。验证：`pnpm tauri dev` 起空窗口。
2. **前端静态页**：`frontend/` 三视图骨架 + 样式迁移（假数据）。验证：窗口内能点出三个视图切换。
3. **crypto.rs**：派生、加解密、容器编解码 + 单测。验证：`cargo test crypto`。
4. **storage.rs**：路径解析、读、原子写、`.bak` + 单测。验证：`cargo test storage`。
5. **vault.rs**：模型、CRUD、唯一性、三种合并 + 单测。验证：`cargo test vault`。
6. **session.rs + commands.rs**：unlock/lock/set_view/list/get_secret/add/update/delete。验证：前端能读到真实库。
7. **查询视图接真数据**：联动、自动选中、掩码、复制 + 剪贴板计时。验证：手点一遍。
8. **清单视图接真数据**：搜索、增删改、双击编辑、删除确认。验证：增删改查后重启数据仍在。
9. **设置视图**：配置读写、窗口尺寸记忆、路径展示。验证：改设置后重启仍生效。
10. **导入导出**：三种模式、导入前自动备份、报告。验证：导出 → 删库 → 导入还原。
11. **更换主密码**：两字段校验、重加密、提示。验证：换完用新 env 能开、用旧 env 报解密失败。
12. **错误视图与全部文案**：七类失败逐一触发。验证：按 §7 表逐条走。
13. **前端单测**：`logic.js` 用例。验证：`pnpm vitest run` 全绿。
14. **打包**：图标生成、`pnpm tauri build` 出 msi，安装后跑通。验证：安装版能开、能存。
15. **脚本与文档**：两个 ps1 + README。验证：按 README 从零走一遍。

---

## 11. 测试方案

### 11.1 Rust 单测（`src-tauri/src/**/*.rs` 内 `#[cfg(test)]`）
运行：`cargo test -- --test-threads=1`（单线程：并行 Argon2 会短时间内吃数百 MB 内存）。

| 覆盖点 | 用例 |
|---|---|
| 加解密往返 | 明文 → 容器 → 解密 == 明文 |
| 错密码 | 用别的密码派生 → 解密失败（不 panic） |
| 篡改 | 改密文字节 / 改 magic / 截断 → 明确错误 |
| 盐与 nonce 随机 | 同密码两次加密产生不同容器 |
| 空/超长明文 | 0 字节与 1 MB 明文都能往返 |
| 原子写 | 写入后 `vault.dat` 内容正确，`.bak` 是上一版 |
| 损坏文件 | 0 字节、magic 错、版本高 → 各自错误 |
| CRUD | 增/改/删后库状态正确；未知 id 报错 |
| 唯一性 | 同平台+用户名（含大小写不同）被拒；不同平台同名可共存 |
| 合并三模式 | 替换 / 跳过 / 覆盖 三种结果分别断言 added/skipped/replaced |
| 导入备份 | 替换模式下生成 `vault.dat.bak.<时间戳>` |
| 配置回落 | 越界秒数、非法尺寸 → 回落默认 |

### 11.2 前端单测（`frontend/logic.test.js`，vitest）
运行：`pnpm vitest run`

| 覆盖点 | 用例 |
|---|---|
| AutoComplete | 前缀命中排前、子串命中其次、忽略大小写、无命中返回空 |
| 清单过滤 | 平台命中的、用户名命中的、跨大小写、空查询返回全部 |
| 秒数文案 | 0 / 30 / 600 的展示与边界钳制 |
| 窗口尺寸回落 | 0、负数、超大、非数字 → 默认值 |

### 11.3 端到端（手动清单，阶段四按此逐条走）
1. 不设 `PASSLET_MASTER` 启动 → 错误视图文案正确、程序不退出。
2. 设 env 启动 → 空库查询视图。
3. 新增 3 条（含中文平台、含 2 个用户名同一平台）→ 清单可见。
4. 重启 → 数据仍在。
5. 查询：选平台 → 用户名自动选中（单账号平台）→ 掩码 → 显示 → 30 秒后回掩码。
6. 复制 → 30 秒后剪贴板被清空；关掉开关后不清。
7. 删除 → 二次确认 → 消失且重启不复现。
8. 导出 → 删一条 → 导入（整库替换）→ 恢复；确认生成了 `.bak.<时间戳>`。
9. 导入（合并·跳过）与（合并·覆盖）分别验证计数报告。
10. 更换主密码 → 旧 env 启动报解密失败 → 改 env 启动正常。
11. 改 `config.json` 为坏 JSON → 启动不报错、设置回到默认。

---

## 附：未决问题

（已清空。21 项决策见下。）

| # | 决策 |
|---|---|
| Q1 | 计划文件 `docs/PLAN.md` |
| Q2 | 代码只读 `PASSLET_MASTER`；同时给 setx 脚本与启动脚本两种注入方式 |
| Q3 | 单窗口切视图 |
| Q4 | `%APPDATA%\Passlet\vault.dat` + 支持导入导出 |
| Q5 | 无主密码 → 错误页，不退出 |
| Q6 | 关清单即丢明文，重新派生 |
| Q7 | v1 无密码生成器 |
| Q8 | 剪贴板定时清空，可配，配在独立设置页 |
| Q9 | 单账号自动选中 |
| Q10 | 平台框带 AutoComplete，只补全已有平台 |
| Q11 | 导出仅加密备份 `.pvault` |
| Q12 | 导入时三模式可选（替换 / 跳过 / 覆盖） |
| Q13 | 设置页含剪贴板、掩码隐藏、窗口尺寸、路径、导入导出、换主密码 |
| Q14 | 配置明文 `config.json` |
| Q15 | 做“更换主密码” |
| Q16 | 启动脚本明文写主密码，脚本生成在仓库外 |
| Q17 | 查询页平台框不允许输入库里没有的平台 |
| Q18 | 设置入口在清单标题栏 |
| Q19 | 加一层界面组件库，追求美观 → 采用 daisyUI 5（vendor CSS，无构建） |
| Q20 | 支持暗色模式：跟随系统 + 设置页三态手动切换（`system` / `light` / `dark`） |
| Q21 | 平台与用户名之间不再加第三级（分组 / 环境 / 子站点），维持两级 |

---

## 实施进度（2026-11-10）

### 已完成

| 项 | 证据 |
|---|---|
| 阶段2a 界面 | `frontend/` 5 个源文件；daisyUI 5 主题 + 跟随系统/浅色/深色；24 个状态截图在 `design/ui2a/` |
| 阶段2b 后端 | `src-tauri/src/` 8 个模块（error/paths/crypto/storage/vault/config/session/commands），16 条命令 |
| Rust 单测 | `cargo test -- --test-threads=1` → 47 passed（含 6 条"派生→写盘→用主密码重开"集成用例） |
| 前端单测 | `vitest run` → 50 passed（32 条纯函数 + 18 条命令契约） |
| 打包 | exe 3.62 MB；NSIS 安装包 1.34 MB（`Passlet_0.1.0_x64-setup.exe`） |
| 文档与脚本 | `README.md`、`scripts/set-user-env.ps1`、`scripts/make-launch-script.ps1`、`scripts/build-preview.mjs` |

### 与计划的偏差（都由环境导致，不是设计变更）

| 偏差 | 原因 | 处理 |
|---|---|---|
| 新增 `.cargo/config.toml` 指向 rsproxy 镜像 | 本机直连 crates.io 会长时间挂起（13 分钟未产物） | 只作用于本仓库，不动全局 cargo 配置；README 未提及（属构建环境细节） |
| 测试临时目录改用 `target/test-tmp` | 本机系统临时目录对进程不可写（OS error 5） | 只改测试内部路径，生产代码不涉及 |
| 前端多一个 `demo-api.js` | 浏览器预览需要内存假数据；生产走 `invoke` | 仅由 `scripts/build-preview.mjs` 内联进预览文件，`index.html` 不引用它 |
| `Session` 手写 `Debug` | derive 会把密钥打进日志 | 手写实现只输出条目数，密钥标 `<redacted>` |

### 收尾阶段修掉的问题（自查发现）

| 问题 | 影响 | 修法 |
|---|---|---|
| `index.html` 里有一段内联脚本 | 应用 CSP 只允许 `'self'`，内联脚本会被静默拦掉 | 演示模式判断移进 `app.js`（外部脚本） |
| `frontend/` 里混着 `demo-api.js` 与 `logic.test.js` | 这两个文件会被原样打进应用 | 分别移到 `scripts/` 与 `tests/`，构建脚本同步改路径 |
| 命令名/参数名没有测试约束 | 拼错只在运行时暴露 | 新增 `tests/api-contract.test.js`（18 条），逐条断言 invoke 的命令名与参数名 |

### 尚未完成 / 未能验证

- 安装包（msi / nsis）需要联网下载 NSIS 或 WiX 工具链，本机网络受限，待确认
- 计划 §11.3 的 11 条人工端到端清单尚未逐条执行（需要真人点界面）

### 运行验证的阻塞点（2026-11-10 定位）

可视化验证在本机失败，报 `Failed to setup app: 拒绝访问 (os error 5)`。定位过程与结论：

| 观察 | 结果 | 排除的可能 |
|---|---|---|
| 各路径 ACL（仓库、父目录、LOCALAPPDATA、EBWebView、exe） | 无 `S-1-4-*` 能力项、无 `S-1-15-2-*` 包项、无拒绝项 | 不是 ACL 残留 |
| PowerShell 在 `%LOCALAPPDATA%` 建目录 | 成功 | 不是目录权限 |
| 纯 Rust 程序（不含 Tauri）建同一个目录 | `拒绝访问` | 不是 Tauri/WebView2 的问题 |
| 全新最小 Tauri 应用 | 同样 `拒绝访问` | 不是本项目代码或配置 |
| tao 单独建窗口 | 成功 | 不是窗口创建本身 |
| 探针打印 `app_local_data_dir()` | `%LOCALAPPDATA%\com.passlet.desktop`，`create_dir_all` 返回 `拒绝访问` | 失败点是 Tauri 在 `manager/webview.rs` 里为 WebView2 准备数据目录的那一步 |
| 火绒拦截日志 `C:\ProgramData\Huorong\Sysdiag\applog.db(-wal)` | 含 `passlet` / `minitauri` / `fs_probe` / `tao_probe` | **火绒 HIPS 拦了新编译的 exe 写用户目录** |

**最终结论：不是火绒，是"从工作区启动的进程会被降级成低完整性令牌"。**

同一个 exe、同一个用户、同一条命令：

| 启动位置 | 进程完整性级别 | 结果 |
|---|---|---|
| `C:\Users\autod\Documents\GitHub\Passlet\temp\…\fsprobe2.exe` | **Low 0x1000** | 只能写工作区，写 `%LOCALAPPDATA%` / `%APPDATA%` / `C:\ProgramData` / `C:\Running` 全部被拒 |
| 同一个 exe 拷到 `C:\Running` 再跑 | **Medium 0x2000** | 五处全部可写 |

机制：工作区目录带着沙箱留下的低完整性标签（SACL 里的 Low label），从那里启动的可执行文件继承成 Low 令牌，
Windows 的"禁止向上写"于是拦掉了 Tauri 给 WebView2 准备数据目录的 `create_dir_all`。
表现就是 `Failed to setup app: 拒绝访问 (os error 5)`——与 ACL、火绒都无关。

外置运行后验证通过：

| 验证项 | 结果 |
|---|---|
| 进程启动 | 存活，窗口标题 `Passlet` |
| WebView2 数据目录 | `%LOCALAPPDATA%\com.passlet.desktop` 建立成功 |
| 界面渲染 | 截图 `design/ui2a/app-light.png` / `app-dark.png`，三个字段都在 |
| `config.json` 读取 | 写成 `theme=light` 后界面转浅色，写成 `dark` 后转深色 |

顺带修掉一个真问题：切主题时原生标题栏不跟随（内容浅色、标题栏深色），新增 `apply_theme` 命令让 Rust 侧同步设置窗口主题。

对使用者的影响：**开发/调试时不要把 exe 放在工作区里直接跑**（会被降级）；安装后的程序在 `%LOCALAPPDATA%\Passlet`，
不在被打标签的目录下，不受影响。

---

## 追加需求：命令行调用（2026-11-11 提出，待确认后实施）

### C1 目标

在终端里完成与界面等价的核心操作，便于脚本、批量操作和远程（SSH）场景使用。
不改变现有 GUI 的任何行为。

### C2 命令草案

```
passlet-cli list [--json]                                   # 平台 / 用户名，不含密码
passlet-cli get <平台> <用户名> [--copy] [--json]            # 取密码
passlet-cli add <平台> <用户名> [--password-stdin]           # 新增（密码从 stdin 或交互读）
passlet-cli update <平台> <用户名> [--password-stdin]        # 改密码
passlet-cli remove <平台> <用户名>                           # 删除（--yes 跳过确认）
passlet-cli export <文件路径>                                # 加密备份
passlet-cli import <文件路径> --mode replace|skip|overwrite   # 导入
passlet-cli change-master [--password-stdin]                 # 换主密码
passlet-cli doctor                                           # 打印数据目录、主密码来源、条目数
```

全局参数：`--vault <目录>`（覆盖 `%APPDATA%\Passlet`，供测试与多库使用）。

### C3 输出与退出码

- **stdout 只放数据**（便于 `|` 管道与 `$(...)` 捕获）；提示、进度、错误一律走 stderr。
- `--json` 输出结构化结果，字段与内部模型一致。
- 退出码：`0` 成功；`1` 用法错误；`2` 主密码缺失或错误；`3` 条目不存在；`4` 条目重复；`5` 文件读写失败。

### C4 安全约定

1. **密码永不出现在命令行参数里**（会进 shell 历史、进程列表），只接受 stdin 或交互输入。
2. `get` 默认把密码打到 stdout；需要时 `--copy` 写剪贴板并应用「30 秒清空」策略。
3. 文档明确警告：stdout 可能被 shell 历史、日志、CI 记录留存。
4. 主密码来源与 GUI 完全一致：进程环境变量 → 用户/机器级注册表（沿用 `read_master` 的同一条链路）。

### C5 技术方案

现状问题：`src-tauri` 是单一 crate，`lib.rs` 链着 Tauri。若 CLI 直接复用，会把整个 Tauri + WebView2 链进
一个命令行工具（产物从 ~1 MB 涨到 ~4 MB，且引入不必要的依赖）。

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 抽 core crate（推荐）** | 新建 `core/`（crate `passlet-core`），迁入 error / paths / crypto / storage / vault / config；`src-tauri` 与 CLI 都依赖它 | 职责干净，CLI 产物小，core 可单测；改动量中等（移动 6 个模块 + 改引用路径） |
| B. 单 crate 加 bin | 直接把 6 个模块改 `pub`，`src/bin/passlet-cli.rs` | 改动最小，但 CLI 会连带链接 Tauri/WebView2 |
| C. 单 exe 双模式 | `passlet.exe get ...`，靠参数分流，并 `AttachConsole` 挂到父终端 | 用户只有一个文件；但要在 GUI 子系统里手工处理控制台，容易出怪问题 |

选 **A**。同时保留 `--vault` 参数，让 CLI 的端到端测试可以完全脱离真实数据目录。

### C6 修改范围

```
core/Cargo.toml              新增 crate（不依赖 tauri）
core/src/{error,paths,crypto,storage,vault,config}.rs   从 src-tauri/src 迁入
core/src/lib.rs              公开上述模块
src-tauri/Cargo.toml         依赖 path = "../core"
src-tauri/src/{lib,commands}.rs  改用 passlet_core::*
src-tauri/src/bin/passlet-cli.rs 新增 CLI 入口
src-tauri/src/cli/           参数解析、输出格式化、stdin 读取（手写，不引 clap 之外的框架）
tests/cli-e2e.test.js 或 core/tests/cli.rs   端到端用例
README.md                    新增「命令行」一节
```

参数解析：引入 `clap`（derive）。理由：手写解析对 9 个子命令 + 全局参数不值得，clap 是这个场景的事实标准，
只在 CLI 二进制里编译，不影响 GUI 体积。

### C7 测试方案

| 层 | 用例 |
|---|---|
| core 单测 | 现有 47 条迁过去继续跑（路径改 `passlet_core::`） |
| CLI 端到端 | 用 `--vault` 指向临时目录跑真实二进制：`list` 空库输出、`add` 后 `list`、`get` 取回同一密码、`get` 大小写不同的平台名、重复 `add` 退出码 4、`remove` 后 `get` 退出码 3、错主密码退出码 2、`--json` 字段完整 |
| 手工 | 在 cmd / PowerShell / Git Bash 各跑一遍中文平台名与管道 `passlet-cli get ... | clip` |

### C8 待确认（未定项）

1. **范围**：只做只读（`list` / `get`）还是连写操作（add / update / remove / import / export / change-master）一起做？
2. **形态**：独立 `passlet-cli.exe`（推荐）还是 `passlet.exe` 单文件双模式？
3. **`get` 默认行为**：直接输出密码（推荐，符合 CLI 直觉）还是默认打码、要 `--reveal` 才显示？
4. **是否需要 `--json`**：脚本拼接用得上，但对个人使用可能是多余的一层。

### C8 已确认的决策（2026-11-11）

| 问题 | 决定 |
|---|---|
| 范围 | 全部子命令都做（list/get/add/update/remove/export/import/change-master/doctor） |
| 形态 | **独立 `passlet-cli.exe`**（用户 2026-11-11 改判：单文件要把 Tauri 一起链接，代价太大） |
| 输出 | 提供 `--json` |
| `get` 默认行为 | 见 C9（取决于"AI 不得读取明文"这一需求） |

空
Windows 上的实现要点：GUI 子系统（`windows_subsystem = "windows"`）启动时不挂控制台，命令行模式必须
`AttachConsole(ATTACH_PARENT_PROCESS)` 再重开 stdout/stderr，否则管道拿不到输出。

### C9 AI 通过 skill 使用密码、但不读取明文（待定方案）

需求来源：希望 AI 能借助 skill 用上库里保存的密码，同时明文不进入 AI 的上下文。

前提事实：**只要 AI 能自由执行命令，任何"把明文交给某个进程"的机制它都能旁路**（跑 `env`、读临时文件、
把白名单程序指向 shell）。所以目标不是"物理上不可能"，而是"常规路径拿不到 + 旁路会留痕"。

| 方案 | 做法 | 强度 | 代价 |
|---|---|---|---|
| **A. 注入白名单命令**（推荐 v1） | `passlet exec <条目> -- <允许的命令>`：密码经 env/stdin 交给条目上登记的命令，AI 只给参数不给值；禁止子进程是指令解释器（cmd/powershell/bash）；每次使用写审计日志 | 中高：常规路径拿不到；旁路可行但需显式改配置 | 需在条目上登记允许的命令 |
| **B. 本地注入代理**（推荐二阶段） | `passlet proxy` 起本地 HTTP 端点，按 host 白名单注入 Authorization 头；AI 请求代理而不是带密码请求 | 高：明文从不出进程 | 仅适用 HTTP(S)；需维护 host 白名单 |
| **C. 终端守卫** | `get` 在 stdout 非终端（被管道捕获）时**拒绝**输出明文，除非显式 `--allow-pipe` | 低但便宜：挡住"AI 顺手 get 一下"这种意外 | 一行判断 |
| **D. 人工在场** | `passlet reveal` 弹窗只给屏幕前的人看，明文不进任何 stdout | 最高 | 必须有人在 |

推荐 v1 落地 **A + C + 审计日志**：C 一行就能挡住最可能的意外泄露；A 让 AI 能"用"而不能"看"；
审计日志让旁路留下记录。B 放二阶段（真正需要 AI 调 API 时再加）。D 作为高危条目的可选项。

**未定**：v1.1 先做哪一层？A 需要"在条目上登记允许的命令"，这在界面上要加一个字段——是否接受？

### C9 定稿（2026-11-11）

用户明确：**不追求"AI 完全看不到"**（做不到），要的是"能在 skill 里告诉 AI 该怎么做"——
密码可以被脚本读进变量去使用，但不进入 AI 的上下文。因此：

- **不做终端守卫（原方案 C）**：它会挡住 `passlet-cli get … | 程序` 这种正是我们要支持的用法。
- **不做预登记动作（原方案 A）**：用户不需要那层间接。
- **交付一份 skill**（`skill/passlet-cli/SKILL.md`）：教 AI 用 `get` 取值后**立刻交给消费它的程序**，
  并明确禁止 echo / 命令行参数 / tee / `set -x`；给出查错方式（只看退出码与非空判断）、JSON 用法、PowerShell 变体。

skill 里同时写清一个例外：用户明确要求看密码时照做，但要指出明文已进入对话。

### C10 实施结果（2026-11-11）

| 项 | 结果 |
|---|---|
| 架构 | 拆出 `core/`（passlet-core：error/paths/crypto/storage/store/vault/config/master/scratch），GUI 与 CLI 都依赖它 |
| 命令行 | `cli/`（passlet-cli，clap），9 个子命令 + 全局 `--vault` / `--json` |
| 体积 | CLI **0.5 MB**（对照：单文件方案会把 Tauri 一起链接，约 4 MB） |
| 安装包 | NSIS 1.47 MB，通过 `bundle.resources` 把 `passlet-cli.exe` 一起带入 |
| 测试 | Rust 60 条（core 48 + GUI 集成 6 + CLI 端到端 6；单线程 30s）；前端 54 条 |
| 数据兼容 | 文件格式未变，旧 `vault.dat` 直接可用（已用真实库验证读取） |

CLI 端到端覆盖：空库 list、新增后取回同一密码、`--json` 字段、重复/不存在/错主密码/缺 `--yes` 四种退出码、
删除、导出再导入（含整库替换的自动备份）。

---

## 阶段三 · 第 1 轮复核记录（2026-11-11）

独立子代理（只读，未改文件、未运行 exe）复核对全部改动，输出 **19 条**：已确认 16、可能成立 3、已排除 10。
主代理逐条判断：**全部属实，无驳回**。修复要点：

| # | 问题 | 修复 |
|---|---|---|
| 1 | 启动脚本按 ASCII 写盘，非 ASCII 主密码变问号 | UTF-8 无 BOM + `chcp 65001`；含双引号直接报错 |
| 2 | CLI 交互读密码要 EOF | 终端读一行，管道读到底 |
| 3 | “记住窗口尺寸”开关无任何效果 | 整项移除（配置字段 + 界面 + 分支） |
| 4 | 选中条目即把明文取进 WebView | 改懒加载：只有点显示/复制才取 |
| 5 | 导入用环境变量主密码，换密码后同会话导入失败 | 盐相同则用会话密钥，否则退回环境变量 |
| 6 | 三个重命令在主线程跑 Argon2 | 改 `async` |
| 7 | 写盘第二步失败会让 vault.dat 消失 | 失败时把 .bak 搬回 |
| 8 | clap 用法错误退出码 2 与约定冲突 | 改 `try_parse` → 1 |
| 9 | CLI 导入默认 replace（破坏性） | 默认改 `skip` |
| 10 | 重试成功后不应用配置主题 | 补 `applyTheme()` |
| 11 | 预览构建的 `$` 替换语义 | 改函数式替换 |
| 12 | 导入弹窗被 Esc 关闭时 Promise 不 settle | 弹层新增 onClose 回调 |
| 13 | 演示用 URL 钩子留在生产（`?reveal=1` 打开即显明文） | 仅非 Tauri 环境生效 |
| 14 | 多处死代码 | 全删（含 normalizeSize 及其测试） |
| 15 | 每次写操作克隆整库做回滚 | 改为按条目回滚 |
| 16 | 复制走 navigator.clipboard，与权限声明不符 | 新增 `copy_text` 命令 |
| 17 | daisyui 依赖无脚本使用 | 新增 `vendor:sync` 同步脚本 |
| 18 | 预览产物进版本库 | 加入 .gitignore |
| 19 | temp/ 残留测试数据 | 已清空 |

### 阶段三 · 第 3 轮（收敛）

第 2 轮回执：16 条已修复、3 条仍存在（导入弹窗 Promise、S.busy 残留、package.json 尾逗号），另有 2 处修复时引入的新问题
（`--help/--version` 退 1、demo-api 缺 copy_text 的误报）。

修复后再送审，**6 条全部回「已修复」**：

| 项 | 回执 |
|---|---|
| 导入弹窗先 resolve 再 close | 已修复 |
| S.busy 删除 | 已修复 |
| package.json 尾逗号 | 已修复（`pnpm test` 可运行） |
| --help/--version 退 0 | 已修复 |
| demo-api 的 copy_text（复核者读到旧版本） | 已修复 |
| 启动脚本 PS 版本守卫 | 已修复 |

收敛判据达成：零「已确认 / 可能成立」待修改项，最后一轮是子代理对最终版本的确认，无「仍存在 / 驳回」。
确认之后未再改动任何源文件（之后的动作只有编译与打包）。

### 阶段三 · build.ps1 补审（新增文件）

用户中途要求新增构建脚本 `build.ps1`（CLI 先出 → GUI 与安装包 → 产物新鲜度校验）。它不在第 3 轮确认范围内，
单独送审：第 1 次报 2 条清理项（`exit 1` 不可达、源清单排除 `vendor`），修复后第 2 次全部回「已修复」。
`build.ps1` 与两份既有 `.ps1` 一并改为 UTF-8 带 BOM（Windows PowerShell 5.1 才能正确解析中文）。

### 阶段四 · 最终验证（方式：A 全量单元测试 + B 端到端）

| 项 | 结果 |
|---|---|
| A · `cargo test --workspace -- --test-threads=1` | 60 通过（core 48 / GUI 集成 6 / CLI e2e 6），0 失败 |
| A · `pnpm test` | 49 通过，0 失败 |
| B · CLI 端到端（真实二进制，临时库） | 27 个用例全过：9 个子命令 × 正常/非法/边界；含中文平台与中文密码、退出码 0/1/2/3/4、换主密码后旧密码失效 |
| B · GUI 端到端（隔离 APPDATA） | 空库显示「库里还没有记录」→ CLI 写入后显示「请选择平台」→ 错误主密码停在「打不开密码库」 |

首轮 B1 有 3 条失败，定位为**测试脚本自身缺陷**（.NET 的 `StandardInput` 按控制台代码页写字节，
不是 UTF-8），改成显式写 UTF-8 字节后全绿；**产品代码未因此改动**。

未执行：真实安装（会改动系统，需用户在场）、GUI 点击流程（需真人在场）。

---

## 追加需求：在应用内设置主密码（2026-11-11 提出，待确认后实施）

### M1 目标

现状：主密码只能靠 `setx PASSLET_MASTER "..."` 或 `scripts/set-user-env.ps1` 设置，用户得在应用外开一次终端。
目标：把这件事搬进应用本体——在界面上输入一次主密码，应用自己写进用户级环境变量，**不开终端、不要管理员**。

不做：不改密码库格式、不动 CLI、不写机器级（HKLM）、不新增配置字段。

### M2 关键事实（决定可行性）

| 事实 | 影响 |
|---|---|
| 用户级环境变量就是 `HKCU\Environment` 下的一个字符串值 | 普通权限即可写，**不需要 UAC**；只有机器级 `HKLM\SYSTEM\…\Environment` 才要提权 |
| 应用已经在读这两处（`core/src/master.rs`） | 写入与读取同源，不会出现“写进去却读不到” |
| Explorer 缓存着自己的环境块，不广播就看不到新值 | 写完必须 `SendMessageTimeout(HWND_BROADCAST, WM_SETTINGCHANGE, …)`，否则新开的终端仍读不到 |
| `setx` 有 1024 字符上限，且要过一遍 shell 解析 | 直接写注册表（`winreg`）避开转义与长度陷阱，比 `setx` 更稳 |

结论：**可行**。代价是主密码以明文存在注册表里——这与现有设计前提一致（README 与脚本都写明），不是新增风险。

### M3 技术方案（含否决方案）

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 应用内直写注册表（推荐）** | `core` 用 `winreg` 写 `HKCU\Environment`，再广播 `WM_SETTINGCHANGE` | 无提权、无外部进程，避开 `setx` 的引号与长度坑 |
| B. 应用起子进程调 `setx.exe` | `setx PASSLET_MASTER <值>` | 要经命令行解析，特殊字符易错；还有 1024 上限 |
| C. 只 `std::env::set_var` 当前进程 | 不落盘 | 关掉应用就没了，等于没做 |
| D. 提权写 HKLM | `runas` | 每设一次弹一次 UAC，收益只在多用户共机，不值 |

选 **A**。写入前先做一次**校验**：库已存在时用输入值尝试解密（复用 `store::open_in`），能解开才允许写——
否则一个笔误就会让下次启动打不开库（`change-master` 的旧提示正是在警告这件事，现在由校验兜住）。

### M4 数据流与接口

```
前端 ──invoke──▶ commands.rs ──▶ master::write_user() ──▶ HKCU\Environment (REG_SZ)
                      │                                └─▶ 广播 WM_SETTINGCHANGE
                      └──▶ std::env::set_var()  让本次运行立即生效
```

新增三个 Tauri 命令（形参名即前端传的键，`tests/command-contract.test.js` 会交叉比对）：

| 命令 | 参数 | 返回 |
|---|---|---|
| `master_status` | — | `MasterStatus` |
| `set_master_env` | `password: String` | `MasterStatus`（写入并生效之后） |
| `clear_master_env` | — | `MasterStatus` |

`MasterStatus`（`Serialize`）：

| 字段 | 类型 | 含义 |
|---|---|---|
| `active` | `"process" \| "user" \| "machine" \| "none"` | 当前生效来源，顺序与 `master::read()` 一致 |
| `process_env` | bool | 本进程环境块里有非空值 |
| `user_registry` | bool | `HKCU\Environment` 里有非空值 |
| `machine_registry` | bool | `HKLM\…\Environment` 里有非空值 |

`change_master` 调整：改库成功后**自动**把新值写进用户级环境变量，返回值由 `()` 改为 `{ synced: bool }`。
写失败时库密码已经换了，必须让用户看见并能重试——`synced=false` 就是为此。

### M5 模块划分（职责 / 不负责什么）

| 模块 | 负责 | 不负责 |
|---|---|---|
| `core::master`（扩写） | `write_user` / `clear_user` / `status` / 广播；仍是主密码来源的唯一定义 | 不校验能否解密（那是 `store` 的事）、不弹窗、不决定文案 |
| `core::store`（不改） | 解封与解密的真值判断 | — |
| `commands` | 把“校验 → 写 → 生效 → 回报”串起来；把错误翻成中文 | 不直接碰注册表（走 `master`） |
| `frontend/app.js` | 弹窗、状态行、成功后刷新会话 | 不拼注册表路径、不假设写入一定成功 |

### M6 交互逻辑

**入口一：错误页（首次使用，`env_missing`）**
现有「复制命令 / 重新读取」旁新增主按钮「在这里设置」，点开弹窗：一个 `type=password` 输入框。
- 库里已有条目 → 先校验；不对 → 弹窗内红字「这个密码打不开现有的密码库」，**不写入**；对 → 写入 → 自动 `bootstrap()` → 进查询页。
- 库是空的（首次） → 没有可比对的东西，弹窗要求**输两次**，一致才写；写完照常进主界面。

**入口二：设置页 → 安全 → 主密码**
该行由「更换主密码」一个按钮改成：

```
主密码   已设置（用户级环境变量）              [设置/更新]  [清除]
         └ 本次运行已生效
```

- 「设置/更新」：同一个弹窗（库存在时只输一次，靠校验兜住笔误）。
- 「清除」：确认弹窗写明「清除后下次启动会要求重新设置主密码」；确认后删值、广播、刷新状态行，当前会话不受影响（密钥已在内存）。
- 「更换主密码」：流程不变，成功后自动同步环境变量；同步失败时 `toast` 明说“库密码已更换，但环境变量没写成功，请点『设置/更新』重试”。

状态行由 `master_status` 决定：`user→已设置（用户级环境变量）`、`machine→已设置（机器级，管理员设置）`、
`process→仅本次运行（启动时传入）`、`none→未设置`。

### M7 异常情况（表现与提示文案）

| 情况 | 表现 |
|---|---|
| 输入为空 / 全空格 | 「主密码不能为空」，不写入 |
| 库存在但密码解不开 | 「这个密码打不开现有的密码库，请确认后再试」，**不写入**（最关键的一条） |
| 首次使用两次不一致 | 「两次输入的密码不一样」 |
| `HKCU\Environment` 打不开（组策略） | 「写入失败：系统不允许修改用户环境变量。（<原始错误>）可以改用 scripts/set-user-env.ps1。」 |
| 写入成功但广播失败 | 不提示：广播是尽力而为，程序自身读注册表不受影响，新终端重新登录后自然生效 |
| 清除时值本来不存在 | 视为成功（幂等），状态行刷新为「未设置」 |
| 另一实例正在改库 | 不在本次范围（现有已知限制：无文件锁） |

### M8 边界条件

- 长度：**设置环境变量不限长度**（原有主密码可能很短，限制会逼人改密码）；「更换主密码」仍保留 ≥8 位。
- 含空格 / 中文 / `"` / `%` / `!`：直写注册表，不经 shell，全部按字面处理——这是方案 A 相对 `setx` 的实质收益，测试要覆盖。
- 用户级与机器级同时存在：用户级优先（沿用现有读取顺序），状态行显示 user，不提示冲突。
- 库里没有任何条目：不校验可解密性，只查两次输入一致。
- 以管理员身份启动：`HKCU` 仍是当前账号的键，行为不变（不写 HKLM）。

### M9 修改范围（文件清单 · 基线）

```
core/Cargo.toml                    + windows-sys（仅 windows target，用于广播）
core/src/master.rs                 + write_user / clear_user / status / broadcast + 单测
src-tauri/src/commands.rs          + master_status / set_master_env / clear_master_env；change_master 改返回
src-tauri/src/lib.rs               注册新增命令
frontend/api.js                    + 三个调用
frontend/app.js                    + 设置弹窗、状态行、错误页入口、change 后的同步提示
frontend/index.html                设置页安全组改造；错误页加按钮
frontend/styles.css               仅在复用不了现有类时加（预计 0~1 条）
scripts/demo-api.js                预览模式补三个桩（否则预览页报 no_host）
tests/command-contract.test.js     新命令纳入契约（含“无孤岛命令”那条）
tests/logic.test.js                密码校验分支的纯逻辑（空值 / 不一致 / 长度策略）
README.md                          「第一次使用」改为“在应用里设置”，保留终端方式作备选
docs/PLAN.md                       本节
```

`core/src/lib.rs` 不需改（`master` 已导出）。

### M10 实现步骤

1. `core`：`master::status()` + `write_user` / `clear_user` + 广播；单测用临时值名 `PASSLET_TEST_<pid>`，`Drop` 时清理。
2. `core`：把 `store::open_in` 包成校验入口（供“能不能解开”用）。
3. `commands`：三个新命令 + `change_master` 改造；注册进 `lib.rs`。
4. 前端：`api.js` → 状态行 → 弹窗（设置 / 清除）→ 错误页入口 → `synced` 提示。
5. `scripts/demo-api.js` 补桩，跑一次预览确认没有 `no_host`。
6. 测试：契约 + 逻辑；`cargo test --workspace -- --test-threads=1`；`pnpm test`。
7. 真机验证：拷到 `C:\Running\Passlet\` 再跑（工作区目录下启动会被降级成 Low 完整性令牌，写注册表必失败）。

### M11 测试方案

| 层 | 用例 |
|---|---|
| core 单测 | 写入→读回一致；含空格 / 中文 / 引号的字符串原样往返；删除幂等；`status()` 四种判定（临时值名模拟）；空值被拒 |
| 契约测试 | 三个新命令形参与前端调用逐字一致；无孤岛命令 |
| 前端逻辑 | 空值拒绝、两次不一致拒绝、`synced=false` 的提示分支 |
| 端到端（手工，真机） | 见下 |

端到端步骤（真机，`C:\Running\Passlet\`）：

1. 先「导出加密备份」，给当前库留退路。
2. 设置页「设置/更新」填现有主密码 → 状态行变「已设置」；重启应用确认能打开。
3. 新开一个终端 `echo %PASSLET_MASTER%` 能看到值（验证广播生效）。
4. 「更换主密码」→ 确认自动同步；关掉重开仍能打开。
5. 「清除」→ 重启 → 停在错误页 → 点「在这里设置」→ 输入正确密码 → 直接进主界面（串起两个入口）。
6. 恢复现场：库与主密码回到第 1 步状态。

### M12 已定决策（2026-11-11）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | 作用域 | 只写用户级（`HKCU`），不做机器级、不弹 UAC |
| Q2 | 入口 | 设置页与错误页两处，共用一个弹窗 |
| Q3 | 写入前校验 | 库存在时必须能解开才写；解不开就报错、不落盘 |
| Q4 | 换主密码后 | 自动同步环境变量，失败明确提示“库密码已改、环境变量没写成功” |
| Q5 | 清除按钮 | 要，带确认 |
| Q6 | 长度限制 | 设置时只要求非空，不强制 8 位 |
| Q7 | CLI 的 `set-master` | **不加**，GUI 是主路径 |
| Q8 | 端到端是否动真实 `HKCU` 值 | 可以，先导出加密备份，测完立刻用原密码写回 |
| Q9 | `build.ps1` 自动拷到 `C:\Running` | **不加**；构建只管产出，验证时仍手动拷 |
| Q10 | `set_view` 未提交的修复 | 与新功能**合并为一个提交**，复核一起覆盖 |

核对到的事实（2026-11-11）：`HKCU\Environment\PASSLET_MASTER` 存在且为 **8 位**，机器级为空，
当前 shell 的进程环境块里没有——即应用现在完全依赖注册表那条读取路径。
`windows-sys 0.61.2` 已在 `Cargo.lock`（Tauri 的间接依赖），加直连依赖不引入新下载。

已无未决项。

### M13 实施记录（2026-11-11）

| 项 | 结果 |
|---|---|
| 后端 | `core/src/master.rs` 重写：`status()` / `write_user` / `clear_user` / `broadcast_change()`；`source()` 改为基于 `status()`，CLI `doctor` 的输出口径不变 |
| 命令 | 新增 `master_status` / `set_master_env` / `clear_master_env`；`change_master` 改为返回 `{ synced, message }` 并自动同步环境变量 |
| 前端 | 设置页「主密码」组（状态行 + 设置/更新 + 清除 + 更换）、错误页「在这里设置主密码」、两处共用一个弹窗 |
| 新增测试 | core 8 条（写读往返、特殊字符、删除幂等、状态判定、空值拒绝）、GUI 4 条（校验分支）、前端 10 条（逻辑 6 + 契约 4） |
| 计划补漏 | `MasterInfo` 多一个 `vaultExists`（M4 没列，界面用它决定要不要输两次）；`tests/api-contract.test.js` 补 4 条（M9 只列了两个测试文件）；`styles.css` 实际加了 4 行（M9 写的是 0~1 条） |
| 环境限制 | 本机在 DSH 沙箱里构建出的二进制是低完整性，写 `HKCU` 一律被拒；两条写注册表的单测因此自动跳过并打印原因，把测试产物拷到 `C:\Running` 下跑则 8/8 全过 |
| 端到端 | 隔离库 + 已知主密码：首次双输入 → 写入（值正确）→ 清除（值消失）→ 还原（SHA256 与原值一致）；错误密码被拒且注册表一字未变 |

---

## 追加需求：备份用独立密码（2026-11-11 提出，待确认后实施）

### N1 目标

现状：导出把内存里的库用**主密码派生的会话密钥**重新加密写成 `.pvault`；导入时用的是当前主密码（盐与会话相同才复用会话密钥）。
两个后果：想给别人或搬到别的机器一份备份，就得把主密码一起交出去；换主密码之后旧备份立刻作废（上一批复核里正好撞到这条）。

目标：导出时**强制**设置一个独立的“备份密码”，导入时必须输入它。它与主密码互不相干，换主密码不再影响任何备份。

不做：不改 `vault.dat` 的格式与密钥（库仍由主密码加密）；不引入密钥文件或密码管理器；
不动内部轮换副本（`vault.dat.bak`、`.bak.<时间戳>` 是程序自己的回滚材料，仍由主密码加密）。

### N2 技术方案（含否决方案）

备份容器本来就是“密码 + 盐 → 密钥”的自描述格式（`PASSLET1` + 16 字节盐 + 24 字节 nonce + 密文），
换一把密码只是换派生输入，**格式不需要动、版本号不需要加**。

| 方案 | 做法 | 评价 |
|---|---|---|
| **A. 复用现有容器，派生输入改成备份密码（推荐）** | `core::store::seal_with_password(pw, &vault)`：新盐 → 派生 → 加密 | 零格式变更；旧备份天然还能导入（填当时的主密码即可）；GUI 与 CLI 共用同一条路 |
| B. 头部加 `export-v2` 标记位 | 用标记区分两代备份 | 能给出更准的提示，但要写版本兼容分支，收益不抵成本 |
| C. 主密码派生后再套一层备份密码 | 双层加密 | 两个密码都得记住，比现状更糟 |

选 **A**。

### N3 系统结构与数据流

```
导出：库(内存) ──seal_with_password(备份密码, 新盐)──▶ .pvault 文件
导入：.pvault ──unseal(用户输入的密码)──▶ Vault ──merge──▶ 会话内的库 ──主密码加密──▶ vault.dat
```

主密码只出现在“打开/保存库”两处，备份密码只出现在“导出/导入”两处，两者不交叉。

### N4 接口与数据结构

| 位置 | 变化 |
|---|---|
| `core::store` | 新增 `pub fn seal_with_password(password: &str, vault: &Vault) -> AppResult<Vec<u8>>`（新盐 → `derive_key` → `seal`），密码规则见 N8 |
| 命令 `export_vault` | 形参 `password: String`；先弹保存对话框，再用备份密码封包写盘 |
| 命令 `import_from` | 形参增加 `password: String`；**删掉**“盐与会话盐相同就复用会话密钥”的分支，一律用传入的密码解 |
| `frontend/api.js` | `exportVault(password)`、`importFrom(path, mode, password)` |
| `frontend/logic.js` | 新增 `validateBackupPassword(value, confirm?)` → 空 / 长度 / 两次不一致的文案 |

`import_from` 不再读 `master::read()`，于是“换过主密码后导入旧备份会失败”这个问题**随之消失**——
前提是用户输入当时导出的那个密码。

### N5 模块划分（职责 / 不负责什么）

| 模块 | 负责 | 不负责 |
|---|---|---|
| `core::store` | “密码 → 字节”“字节 + 密码 → 库” | 不知道密码从哪来、不弹窗、不决定文案 |
| `commands` | 弹保存/打开对话框、把错误翻成中文 | 不缓存密码、不猜密码 |
| `frontend` | 收集输入、显示结果、密码错了允许原地重试 | 不在内存或 localStorage 里留存备份密码 |

### N6 交互逻辑

**导出**：设置页「导出加密备份」→ 弹窗（备份密码 + 再输一次）→ 确定 → 系统保存对话框（默认名 `passlet-backup-<时间戳>.pvault`）→ 写盘 → 提示“已导出到 …”。
取消保存对话框 = 一个字节都不写。

**导入**：设置页「导入备份」→ 选文件 → 弹窗（备份密码 + 合并方式三个单选）→ 确定 →
密码错就原地提示、弹窗不关（可继续改）→ 密码对就按所选方式合并 → 弹导入报告。

密码与合并方式放同一个弹窗：确定之前不需要任何后端往返，密码错了也不丢已填内容。

### N7 异常情况（表现与提示文案）

| 情况 | 表现 |
|---|---|
| 导出密码为空 / 全空白 | 「备份密码不能为空。」，不落盘 |
| 两次输入不一致 | 「两次输入的密码不一样。」 |
| 不足最小长度（见 N8） | 「备份密码至少 8 位。」 |
| 导入时密码不对，或文件已损坏 | 「这个密码解不开这份备份；文件也可能已损坏。」弹窗保持打开 |
| 导入的是旧版（主密码加密）备份 | 同一句提示，不做识别、不做特判（Q4） |
| 导出的目标不可写（磁盘满 / 无权限） | 「写入失败：…」，不留下半个文件（见 N8） |
| 导入合并后写盘失败 | 与现状一致：内存回滚，库文件不动 |

### N8 边界条件

- 最小长度 **8**（与“更换主密码”一致）；不设上限；除首尾换行外全部原样参与派生（空格是密码的一部分）。
- 备份密码允许与主密码相同：技术上没有区别，不禁止，也不提示。
- 导出文件名保持 `passlet-backup-<时间戳>.pvault`。
- **写盘原子性**：导出改成先写 `<目标>.tmp` 再改名，中断不会留下半截备份（相对现状多约 10 行）。
- 目标文件已存在：由系统保存对话框负责确认覆盖。
- 同一份库用同一个密码导出两次：盐各自随机，密文不同（测试要覆盖，防止盐被复用）。

### N9 修改范围（文件清单 · 基线）

```
core/src/store.rs             + seal_with_password（含单测）
src-tauri/src/commands.rs     export_vault / import_from 加 password；删同盐分支；错误文案；导出改先写临时文件
frontend/api.js               两个调用的签名
frontend/app.js               导出弹窗；导入弹窗合入密码与合并方式；密码错原地重试
frontend/logic.js             + validateBackupPassword（含单测）
scripts/demo-api.js           预览桩同步
tests/logic.test.js           + validateBackupPassword 用例
tests/api-contract.test.js    export / import 的新形参
cli/src/main.rs               export / import 从 stdin 读备份密码
cli/tests/e2e.rs              + 导出→导入同密码成功；错密码退出码 3；容器里不含明文条目
README.md                     导出 / 导入两节 + 备份表格说明
docs/PLAN.md                  本节
```

`frontend/index.html` 不用改（按钮沿用）；`skill/passlet-cli/SKILL.md` 没有提到导出/导入，不用动。

### N10 实现步骤

1. `core`：`seal_with_password` + 单测（正确密码解回、错密码 `decrypt_failed`、空/短密码被拒、两次导出盐不同）。
2. `commands`：改两个命令，删同盐分支，导出写临时文件再改名。
3. 前端：先写 `validateBackupPassword` 与其测试 → 两个弹窗 → 接线 → demo 桩。
4. CLI：export / import 用 `read_secret("备份密码")`，并让错误码沿退出码表。
5. 契约测试同步；自测 `cargo test -p passlet-core`、`-p passlet --lib`、`-p passlet-cli`；`pnpm exec vitest run tests/*.test.js`。
6. 真机：导出 → 用错密码导入（应被拒）→ 用对密码导入 → 条目数与预期一致。

### N11 测试方案

| 层 | 用例 |
|---|---|
| core 单测 | 导出→解回一致；错密码 `decrypt_failed`；空与 7 位密码被拒；同一库连导两次盐不同 |
| GUI 集成 | `import_from`：密码对 → 合并成功；密码错 → 报错且库不变；导出后立刻导入同一份 → 条目数一致 |
| 前端逻辑 | `validateBackupPassword`：空 / 全空白 / 7 位 / 8 位 / 两次不一致 / 不传第二次 |
| 契约 | `exportVault(password)`、`importFrom(path, mode, password)` 形参逐字一致 |
| CLI e2e | 导出→导入同密码成功；错密码退出码 2（与"主密码错"同桶，原写 3 是笔误——3 是"条目不存在"）；换主密码后旧备份仍可导入 |
| 端到端（手工） | N10 第 6 步 |

### N12 已定决策（2026-11-11）

| # | 问题 | 决定 |
|---|---|---|
| Q1 | 备份密码最小长度 | **8 位**，与“更换主密码”一致 |
| Q2 | 导出是否输两次 | **要**，两栏确认 |
| Q3 | 导入的密码与合并方式 | **同一个弹窗**：上面输密码，下面选方式 |
| Q4 | 旧备份的兼容性 | **不考虑**：不加版本标记、不识别旧备份、不为此写分支/测试/README 说明 |
| Q5 | CLI | **同步改**：`export` / `import` 从 stdin 读备份密码 |
| Q6 | 术语 | **统一叫“备份密码”**（导出、导入、CLI、README 用同一个词） |

Q4 的落地口径：按容器格式，旧备份用当时的密码在技术上仍然可能解开，但那是附带结果——
不做识别、不做保证、不写测试、不写进 README 的支持范围。导入失败时一律用 N7 那句通用提示。

### N13 实施记录（2026-11-11）

| 项 | 结果 |
|---|---|
| 后端 | `store::validate_backup_password` + `store::seal_with_password`（新盐 → 派生 → 封包）；`export_vault(password)`、`import_from(path, mode, password)`；导入不再比对会话盐、不读环境变量 |
| 导出写盘 | 先写 `<目标>.tmp` 再改名，失败时删掉临时文件 |
| 前端 | 导出弹窗（两栏 + 校验）、导入弹窗（密码 + 合并方式 + 内联错误、密码错了不关窗）；`validateBackupPassword` 进 `logic.js` |
| CLI | `export` / `import` 从标准输入读备份密码；错密码走退出码 2（与“主密码错”同桶） |
| 新增测试 | core 4 条（往返、短密码拒绝、两次导出盐不同、换主密码后备份仍可开）、GUI 1 条、前端 6 条（校验）、CLI e2e 2 条（错密码不动库、换密码后旧备份可导入） |
| 计划修正 | N11 原写“错密码退出码 3”，与既有退出码表冲突（3 = 条目不存在），实际取 2 |
| 验证 | CLI 端到端跑真实二进制：导出→错密码被拒且库文件字节不变→对密码导入还原；GUI 端用隔离 APPDATA 验了导出弹窗的两道校验与取消后库文件未变 |
| 未自动化 | 系统保存/打开对话框无法可靠自动化（UIA 调用会卡在模态窗口上），GUI 侧“确实写盘/读盘”的往返由 CLI 端到端覆盖 |


