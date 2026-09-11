# 給 .mjs 用的使用者身分橋接。底線開頭 -> actiond 不會把它列成一個 action。
#
# 為什麼需要這一層：使用者身分的橋（_userbridge.ps1）是 PowerShell 的函式，
# .mjs 沒辦法直接呼叫。這支就是那個轉接頭。
#
# 指令和輸出都走檔案，不走管線 —— PowerShell 5.1 的 stdout 在被導向時是用
# 系統 OEM codepage 寫出去的（這台是 Big5），中文會在管線上壞掉。走檔案就能
# 兩邊都指定 UTF-8，誰都不用猜。
#
# 用法（呼叫端負責建立 -In、讀完後刪掉兩個檔）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File _asuser.ps1 -In <指令檔> -Out <輸出檔>
#
# 離開碼就是使用者那端指令的離開碼。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out
)

. "$PSScriptRoot\_userbridge.ps1"

$cmd  = Get-Content -Raw -Encoding UTF8 $In
$text = Invoke-AsUser $cmd | Out-String

# 不要用 Out-File：它在 PS 5.1 的 utf8 是帶 BOM 的，JSON.parse 會被那三個
# byte 噎到。WriteAllText 配 UTF8Encoding($false) 才是沒有 BOM 的 UTF-8。
[IO.File]::WriteAllText($Out, $text, [Text.UTF8Encoding]::new($false))

exit $global:UserExitCode
