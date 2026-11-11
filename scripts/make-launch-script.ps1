# 生成一个"双击即用"的启动脚本，里面带着主密码。
#
# 生成物默认放在 %USERPROFILE%\passlet-launch.bat —— 仓库之外，
# 不会被提交，也不会跟着源码走。这个文件是明文的，谁能读到文件谁就能开库。
#
# 用法：
#   .\make-launch-script.ps1
#   .\make-launch-script.ps1 -ExePath "D:\Apps\Passlet\Passlet.exe"


param(
    [string]$ExePath = "$env:LOCALAPPDATA\Passlet\Passlet.exe",
    [string]$OutFile = "$env:USERPROFILE\passlet-launch.bat"
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -lt 6) {
    Write-Error "这个脚本需要 PowerShell 7 及以上（-Encoding utf8NoBOM 在 5.1 里不存在）。请用 pwsh 运行。"
    exit 1
}

if (-not (Test-Path $ExePath)) {
    Write-Warning "没找到 $ExePath。可以先装好 Passlet，或用 -ExePath 指定 exe 的位置。"
}

Write-Host "生成启动脚本" -ForegroundColor Cyan
Write-Host "  exe   ：$ExePath"
Write-Host "  脚本  ：$OutFile"
Write-Host ""

$secure = Read-Host -AsSecureString -Prompt "请输入主密码"
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

if ([string]::IsNullOrEmpty($plain)) {
    Write-Error "主密码不能为空。"
    exit 1
}

if ($plain.Contains('"')) {
    Write-Error "主密码里含双引号，批处理无法安全传递，请改用 set-user-env.ps1 的方式。"
    exit 1
}

# 批处理里 % 会被当成变量前缀，必须写成 %%
$escaped = $plain.Replace('%', '%%')

# 第一行先切代码页：cmd 默认按本地 ANSI 读批处理，UTF-8 里的中文会被打乱
$content = @"
@echo off
chcp 65001 >nul
rem 由 Passlet 的 make-launch-script.ps1 生成。这个文件里有明文主密码，不要提交到仓库。
set "PASSLET_MASTER=$escaped"
start "" "$ExePath"
"@

Set-Content -LiteralPath $OutFile -Value $content -Encoding utf8NoBOM
$plain = $null

Write-Host "已生成：$OutFile" -ForegroundColor Green
Write-Host "双击它即可启动 Passlet（主密码只对这个进程生效，不写注册表）。"
Write-Host "提醒：文件是明文的，注意别放进会同步到云端的目录。"
