# @title   重啟 OpenClaw Gateway
# @desc    停掉再拉起來，順便印出前後狀態；連線會斷一下
# @group   openclaw
# @confirm

# 為什麼走 _userbridge：actiond 是以最小權限的服務帳號執行的（2026-09 之後不再是
# 安裝者的帳號），而 openclaw 裝在使用者層級的 %APPDATA%\npm 底下 —— 服務帳號的
# PATH 上沒有它，就算找得到執行檔，讀到的也會是錯的 profile。
#
# 代價要講明白：**這條橋要使用者處於登入狀態**，人不在的時候這個 action 會逾時，
# 下面的訊息會說清楚原因。caddy 那幾個 action 不受影響 —— 它們不需要橋。
#
# 三個步驟包成同一個字串送過去，不是叫三次 Invoke-AsUser：那條橋一次只跑一個
# 請求（輸入輸出是固定路徑，用鎖檔序列化），叫三次就是三趟排程工作、三個閃過去
# 的視窗，中間還可能被別的請求插隊。
. "$PSScriptRoot\_userbridge.ps1"

Invoke-AsUser @'
# -CommandType Application 不能省：npm 同時放了 openclaw.cmd 和 openclaw.ps1，
# Get-Command 預設先回傳 .ps1，而 cmd /c 執行不了 .ps1 —— 會安靜地跑出空輸出
# 加 exit 0，看起來像成功其實什麼都沒做。
$exe = (Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
if (-not $exe) {
    Write-Output '在使用者的環境裡找不到 openclaw。'
    Write-Output '在那台自己確認它裝在哪：where.exe openclaw'
    exit 1
}
Write-Output "openclaw: $exe"
Write-Output ''

# 不要用 PowerShell 的 2>&1 去接原生程式的 stderr：PS 5.1 會把每一行包成
# ErrorRecord，配上 ErrorActionPreference=Stop 會直接中止腳本。用 cmd /c。
Write-Output '=== 重啟前 ==='
cmd /c "`"$exe`" gateway status 2>&1"

Write-Output ''
Write-Output '=== 重啟 ==='
cmd /c "`"$exe`" gateway restart 2>&1"
$code = $LASTEXITCODE

Write-Output ''
Write-Output '=== 重啟後 ==='
cmd /c "`"$exe`" gateway status 2>&1"

exit $code
'@

exit $global:UserExitCode
