# @title   重啟 OpenClaw Gateway
# @desc    停掉再拉起來，順便印出前後狀態；連線會斷一下
# @group   openclaw
# @confirm

# 為什麼不用走 _userbridge：install.ps1 給了使用者帳號的話，actiond 就是以那個
# 使用者執行（nssm 的 ObjectName），%APPDATA%\npm 底下的 openclaw 直接叫得到。
# actiond 如果是以 LOCAL SYSTEM 執行，這個 action 會找不到 openclaw 而報錯 ——
# 下面的錯誤訊息會講怎麼查，到時候再改成透過橋接。

# -CommandType Application 不能省：npm 同時放了 openclaw.cmd 和 openclaw.ps1，
# Get-Command 預設先回傳 .ps1，而 cmd /c 執行不了 .ps1 —— 會安靜地跑出空輸出
# 加 exit 0，看起來像成功其實什麼都沒做。
$exe = (Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1).Source
if (-not $exe) {
    Write-Output '找不到 openclaw。'
    Write-Output 'actiond 的執行身分是不是安裝 openclaw 的那個使用者？'
    Write-Output '  查：C:\Caddy\nssm.exe get actiond ObjectName'
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
