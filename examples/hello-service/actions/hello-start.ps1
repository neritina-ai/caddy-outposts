# @title   啟動 hello-service
# @desc    在 127.0.0.1:3100 拉起範例服務。已經在跑就什麼都不做。
# @group   hello

# 這個檔含中文，必須存成 UTF-8 with BOM。理由見 _hello.ps1。

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_hello.ps1"

$existing = Get-HelloProcess
if ($existing) {
    "已經在跑了：PID $($existing.Id)"
    exit 0
}

if (-not (Test-Path $Script)) {
    "找不到 $Script"
    "把 examples\hello-service\ 整個目錄複製到 $AppDir 再試一次。"
    exit 1
}

# actiond 預設是以 LOCAL SYSTEM 執行的服務，只看得到 HKLM 的 PATH。
# Node 如果是「只裝給目前使用者」，SYSTEM 就找不到它。
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    "找不到 node。"
    ""
    "actiond 是以服務身分執行的，看不到裝在使用者層級（%APPDATA%）的 Node。"
    "兩個解法："
    "  1. 把 Node 裝成 all users（PATH 會寫進 HKLM），或"
    "  2. 改走使用者身分橋接 —— 見 actions\_userbridge.ps1"
    exit 1
}

New-Item -ItemType Directory -Force (Split-Path $PidFile -Parent) | Out-Null

$p = Start-Process -FilePath $node.Source `
                   -ArgumentList @($Script) `
                   -WorkingDirectory $AppDir `
                   -WindowStyle Hidden -PassThru `
                   -RedirectStandardOutput $OutLog `
                   -RedirectStandardError  $ErrLog
# 註：stdout 跟 stderr 不能導到同一個檔，Start-Process 會直接報錯。

Set-Content -Path $PidFile -Value $p.Id -Encoding ascii

# 服務起來要一點時間；等到埠真的在聽為止，最多兩秒。
$ok = $false
foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 100
    if ($p.HasExited) { break }
    if (Test-HelloPort) { $ok = $true; break }
}

if ($ok) {
    "已啟動：PID $($p.Id)，127.0.0.1:$Port"
    "網址 /hello/"
    exit 0
}

if ($p.HasExited) {
    "啟動失敗，行程已結束（exit $($p.ExitCode)）："
    Get-Content $ErrLog -Tail 20 -ErrorAction SilentlyContinue
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    exit 1
}

"行程 $($p.Id) 起來了，但兩秒內沒有聽到 $Port —— 埠被別人佔走了？"
Get-Content $ErrLog -Tail 20 -ErrorAction SilentlyContinue
exit 1
