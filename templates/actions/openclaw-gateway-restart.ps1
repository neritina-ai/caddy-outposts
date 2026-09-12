# @title   重啟 OpenClaw Gateway
# @desc    停掉再拉起來，順便印出前後狀態；連線會斷一下
# @group   openclaw
# @confirm
# @only-when-logged-on

# 為什麼標 @only-when-logged-on：openclaw 裝在使用者層級的 %APPDATA%\npm 底下，
# actiond 的服務帳號 PATH 上沒有它，而且就算找得到執行檔，讀到的也會是錯的
# profile。有人登入的時候 actiond 會把這支腳本交給使用者身分的橋，所以下面直接
# 呼叫就好；沒有人登入的時候 actiond 會擋在前面，不會讓它跑出一個「找不到
# openclaw」的假失敗。

# -CommandType Application 不能省：npm 同時放了 openclaw.cmd 和 openclaw.ps1，
# Get-Command 預設先回傳 .ps1，而 cmd /c 執行不了 .ps1 —— 會安靜地跑出空輸出
# 加 exit 0，看起來像成功其實什麼都沒做。
$exe = (Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
if (-not $exe) {
    Write-Output '在這個使用者的環境裡找不到 openclaw。'
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
