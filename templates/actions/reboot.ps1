# @title   重新開機
# @desc    20 秒後重開。設了自動登入的機器，開機後會自己登入。
# @group   system
# @confirm

# 這支**刻意不標 @only-when-logged-on**：沒有人登入的時候正是最需要它的時候。
# actiond 以服務帳號執行也叫得動 shutdown（LOCAL SERVICE 的 token 裡有
# SeShutdownPrivilege，預設停用但可以自己啟用；實測 shutdown /r 回傳 0）。
#
# 延遲 20 秒不是禮貌，是必要的：actiond 要先把 HTTP 回應送回手機，你才看得到
# 「已排定」跟取消的方法。立刻重開的話連線會在回應之前就斷掉。
$delay = 20

$out = cmd /c "shutdown /r /t $delay 2>&1"
$code = $LASTEXITCODE

if ($code -ne 0) {
    Write-Output '排定重開機失敗。'
    $out | ForEach-Object { $_ }
    Write-Output ''
    Write-Output "離開碼 $code（5 = 存取被拒）"
    exit $code
}

Write-Output "已排定 $delay 秒後重新開機。"
Write-Output ''
Write-Output '反悔的話，在倒數結束前執行「取消重新開機」那個 action。'
Write-Output ''
Write-Output '開機之後：'
Write-Output '  - 設了自動登入的話，使用者會自己登入，需要登入才能跑的 action 就會恢復'
Write-Output '  - 沒設自動登入的話，要有人去那台登入，那些 action 才會恢復'
Write-Output '  - caddy 和 actiond 都是開機自動啟動，網站會自己回來'
exit 0
