# @title   取消重新開機
# @desc    中止還在倒數的重開機
# @group   system

# 這支**刻意不加 @confirm**：它是那顆煞車。在倒數的時候還要多按一次確認，
# 等於把煞車放到後車廂。它本身不會造成任何破壞 —— 最壞的情況是取消掉一個
# 本來就想要的重開機，那再按一次「重新開機」就好。
$out = cmd /c "shutdown /a 2>&1"
$code = $LASTEXITCODE

if ($code -eq 0) {
    Write-Output '已取消，這台不會重開了。'
    exit 0
}

# 1116 = 沒有任何進行中的關機。那不是錯誤，是「本來就沒東西要取消」。
if ($code -eq 1116) {
    Write-Output '目前沒有排定中的重開機，沒有東西需要取消。'
    exit 0
}

Write-Output '取消失敗。'
$out | ForEach-Object { $_ }
Write-Output ''
Write-Output "離開碼 $code"
exit $code
