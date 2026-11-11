---
name: passlet-cli
description: 用 passlet-cli 读取本机 Passlet 密码库里的密码，并在不把明文带进上下文的前提下使用它——把密码只留在某个进程的变量或管道里，直接交给需要它的程序。当用户要求“用保存的密码登录 / 调用接口 / 配置某个工具”，或需要查询库里有哪些平台与账号时使用。
---

# 用 Passlet 里的密码，而不把明文读进上下文

`passlet-cli` 是本机密码库的命令行入口。密码库由主密码加密，主密码来自环境变量
`PASSLET_MASTER`（取不到时会回落到 Windows 用户/机器级环境变量）。

这个 skill 的全部意义在于：**你能让程序用上密码，但你自己不要看到它**。

## 先确认环境

```bash
passlet-cli doctor          # 数据目录、库文件、条目数、主密码来源
passlet-cli doctor --json   # 需要结构化结果时
```

`masterSource` 是 `none` 就说明主密码没配好，直接告诉用户去设置，不要尝试猜。

## 铁律（违反其中任何一条，这个 skill 就失去意义）

1. **绝不把密码打到你会读回来的地方**：不要 `echo`、`cat`、`Write-Output`、`console.log`、`print`。
2. **绝不把密码写进命令行参数**：它会进 shell 历史、进程列表（`ps`/任务管理器可见）。
3. **绝不开 `set -x` / `bash -x` / `Set-PSDebug`**：那会把每条命令连同变量值打印出来。
4. **绝不给密码加日志**：包括 `>> log`、`tee`、CI 输出。
5. **一次只在一个进程里用它**：取出来 → 立刻交给消费它的程序 → 进程结束。

## 标准姿势

核心模式是「在同一条命令里取值并使用」，让值只存在于那个子进程的内存中：

```bash
# 程序从 stdin 读密码
passlet-cli get GitHub me | gh auth login --with-token

# 程序接受密码文件时：写临时文件、限权、用完删
umask 077
passlet-cli get GitHub me > "$TMPDIR/.p" && chmod 600 "$TMPDIR/.p"
curl -sS --netrc-file "$TMPDIR/.p" https://api.example.com/endpoint
rm -f "$TMPDIR/.p"
```

需要先确认取到了、又不想暴露值时，只检查「非空」或退出码：

```bash
PW="$(passlet-cli get GitHub me)" || exit 1
[ -n "$PW" ] || { echo "没取到密码" >&2; exit 1; }
some-program --password-stdin <<<"$PW"
unset PW
```

**关于 `curl -u user:pass`**：那会把密码放进 `curl` 的 argv，同机其他进程能看到。宁可写
`--netrc-file` 或让程序从 stdin 读。

## 查询（不涉及密码）

```bash
passlet-cli list                 # 每行「平台<TAB>用户名」
passlet-cli list --json          # [{id, platform, username}, ...]
```

拿到 `list` 结果后按平台/用户名挑一条即可，**不要**为了找某条记录去 `get` 一堆条目。

## 退出码（用它判断，而不是解析文案）

| 码 | 含义 | 你该做什么 |
|---|---|---|
| 0 | 成功 | — |
| 1 | 用法错误 | 检查参数；删除操作在非终端下必须加 `--yes` |
| 2 | 主密码缺失或错误 | 告诉用户设置 `PASSLET_MASTER`，不要重试 |
| 3 | 条目不存在 | 用 `list` 看真实写法（平台名大小写不敏感，但拼写要对） |
| 4 | 条目重复 | 改用 `update` |
| 5 | 文件读写失败 | 报告路径与错误原文 |

## Windows / PowerShell

```powershell
$pw = & passlet-cli get GitHub me
if (-not $pw) { throw "没取到密码" }
$pw | some-program.exe --password-stdin
Remove-Variable pw
```

同样禁止 `Write-Host $pw`、`$pw` 单独成行（那等于打印）、`Set-PSDebug -Trace 1`。

## 写入类操作

只有用户明确要求时才改库。密码一律通过标准输入传，不放参数：

```bash
echo -n "新的密码" | passlet-cli add GitHub me
echo -n "新的密码" | passlet-cli update GitHub me
passlet-cli remove GitHub me --yes
```

## 反例（一律不要写）

```bash
passlet-cli get GitHub me                 # 直接把密码打到 stdout，你就读到了
P=$(passlet-cli get GitHub me); echo $P   # 同上，还多一层
curl -u me:$(passlet-cli get GitHub me) …  # 密码进了 argv
passlet-cli get GitHub me | tee out.txt    # 明文落盘
set -x; passlet-cli get GitHub me          # 调试输出暴露全部
```

## 例外：用户就是要看

如果用户明确说「把密码告诉我」「显示出来」，那按他的要求打印即可——但要在同一条回复里点明
“明文已经出现在对话里”。这是用户的决定，不是你的失误；静默照做才是失误。
