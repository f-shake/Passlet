<#
.SYNOPSIS
    构建 Passlet：命令行 → 图形界面 → 安装包。

.DESCRIPTION
    顺序不能反。安装包会把 passlet-cli.exe 一起打进去，如果 CLI 还是上一次的旧产物，
    装出来的包里 CLI 就是旧的——这个错误不会报错，只能靠最后的时间戳校验发现。

    产物：
      target\release\passlet.exe                     图形界面
      target\release\passlet-cli.exe                 命令行
      target\release\bundle\nsis\Passlet_*-setup.exe 安装包

.PARAMETER SkipTests
    跳过测试。只建议在已经跑过测试的情况下用。

.EXAMPLE
    .\build.ps1
    .\build.ps1 -SkipTests
#>
param(
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Write-Step([string]$text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}

# 失败一律走这里：Write-Host 不会触发 $ErrorActionPreference 的终止行为，
# 后面的 exit 1 才真的能执行到（否则被 & 调用或 try/catch 包住时看不到退出码）。
function Stop-Build([string]$message) {
    Write-Host "错误：$message" -ForegroundColor Red
    exit 1
}

# ---------- 0. 前置检查 ----------

Write-Step "检查环境"

foreach ($tool in @("cargo", "pnpm")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Stop-Build "找不到 $tool，请先安装。"
    }
}

if (-not (Test-Path "node_modules\.bin\tauri.cmd")) {
    Stop-Build "没装前端依赖（缺少 @tauri-apps/cli），先跑：pnpm install"
}

# 运行中的程序会锁住 exe，构建会以"拒绝访问"失败
$running = @(Get-Process passlet, passlet-cli -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $ids = ($running | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join "、"
    Stop-Build "还有 Passlet 进程在运行：$ids。先关掉再构建。"
}

Write-Host "环境 OK"

# ---------- 1. 测试 ----------

if (-not $SkipTests) {
    Write-Step "单元测试（Rust，单线程）"
    # 单线程是刻意的：Argon2 每个用例要 32 MiB，并行会打满内存
    cargo test --workspace -- --test-threads=1
    if ($LASTEXITCODE -ne 0) { Stop-Build "Rust 测试失败，停止构建。" }

    Write-Step "单元测试（前端）"
    pnpm test
    if ($LASTEXITCODE -ne 0) { Stop-Build "前端测试失败，停止构建。" }
}

# ---------- 2. 先出 CLI ----------

Write-Step "构建命令行（release）"
cargo build -p passlet-cli --release
if ($LASTEXITCODE -ne 0) { Stop-Build "CLI 构建失败。" }

# ---------- 3. 再出 GUI 与安装包 ----------

Write-Step "构建图形界面与安装包"
& ".\node_modules\.bin\tauri.cmd" build --bundles nsis
if ($LASTEXITCODE -ne 0) { Stop-Build "GUI 构建失败。" }

# ---------- 4. 校验产物 ----------

Write-Step "校验产物"

$gui = Get-Item "target\release\passlet.exe" -ErrorAction SilentlyContinue
$cli = Get-Item "target\release\passlet-cli.exe" -ErrorAction SilentlyContinue
$installer = Get-ChildItem "target\release\bundle\nsis\*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1

$missing = @()
if (-not $gui) { $missing += "passlet.exe" }
if (-not $cli) { $missing += "passlet-cli.exe" }
if (-not $installer) { $missing += "安装包" }
if ($missing.Count -gt 0) {
    Stop-Build "缺少产物：$($missing -join '、')"
}

# 真正要防的是"产物比源码旧"——也就是这次没重新构建、包里装的是上次的二进制。
# 不能拿安装包和 exe 比大小：tauri 打完包还会给 exe 补 bundle 信息，两者相差几十毫秒。
# frontend\vendor 里的 CSS 会嵌进 exe，必须计入（排除它的后果是：换了样式但 exe 不必重链接，
# 校验会通过，而安装包里是旧样式）。
function Get-NewestSource([string[]]$paths) {
    $files = foreach ($path in $paths) {
        if (Test-Path $path -PathType Leaf) { Get-Item $path }
        else {
            Get-ChildItem $path -Recurse -File -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -notmatch 'node_modules|\\target\\' }
        }
    }
    $files | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

$sharedSource = @(
    "Cargo.toml", "Cargo.lock",
    "core\Cargo.toml", "core\src",
    "cli\Cargo.toml", "cli\src"
)
$cliSource = Get-NewestSource $sharedSource
$guiSource = Get-NewestSource ($sharedSource + @(
    "src-tauri\Cargo.toml", "src-tauri\src",
    "src-tauri\tauri.conf.json", "frontend"
))

foreach ($pair in @(
    @{ artifact = $cli; source = $cliSource },
    @{ artifact = $gui; source = $guiSource },
    @{ artifact = $installer; source = $guiSource }
)) {
    if ($pair.source -and $pair.artifact.LastWriteTime -lt $pair.source.LastWriteTime) {
        Stop-Build "$($pair.artifact.Name) 比源码 $($pair.source.Name) 旧，说明没有重新构建。请清理后重跑。"
    }
}

# ---------- 5. 汇总 ----------

function Format-Size($bytes) {
    if ($bytes -ge 1MB) { return "{0:N2} MB" -f ($bytes / 1MB) }
    return "{0:N0} KB" -f ($bytes / 1KB)
}

Write-Host ""
Write-Host "构建完成：" -ForegroundColor Green
foreach ($item in @($gui, $cli, $installer)) {
    Write-Host ("  {0,-34} {1,10}  {2}" -f $item.Name, (Format-Size $item.Length), $item.LastWriteTime)
}
