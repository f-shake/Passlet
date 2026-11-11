# 把主密码写入用户级环境变量 PASSLET_MASTER。
#
# 注意：Windows 的用户级环境变量以明文存在注册表里（HKCU\Environment）。
# 任何以你的身份运行的程序都能读到，这与 Passlet 本身的设计前提一致，
# 但你必须知道它不等于"加密保存"。
# 不想落到注册表就用 make-launch-script.ps1。

$ErrorActionPreference = "Stop"

Write-Host "设置环境变量 PASSLET_MASTER（用户级，永久生效）" -ForegroundColor Cyan
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

setx PASSLET_MASTER $plain | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "setx 执行失败。"
    exit 1
}

$plain = $null
Write-Host ""
Write-Host "已设置。注意两点：" -ForegroundColor Green
Write-Host "  1. 已经在运行的程序不会自动读到，需要重开一次。"
Write-Host "  2. 主密码现在以明文存在注册表的 HKCU\Environment 里。"
