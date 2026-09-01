# @title   停止 hello-service
# @desc    停掉範例服務。停掉之後 /hello/ 會變成 502。
# @group   hello
# @confirm

# 為什麼要 @confirm？
#
# 因為 /run/<名稱> 就只是一個網址，而網址會被各種東西「順手打開」：
# 瀏覽器的預抓、聊天軟體展開連結預覽、Wi-Fi 登入頁偵測。
# 加了 @confirm 之後，用 GET 開這個網址只會得到一頁確認畫面，
# 真正執行需要按下去（送 POST）。
#
# 判準很簡單：**會造成破壞或不可逆的，就加。**
#
# 這個檔含中文，必須存成 UTF-8 with BOM。理由見 _hello.ps1。

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\_hello.ps1"

$p = Get-HelloProcess
if (-not $p) {
    "沒有在跑。"
    Remove-Item $PidFile -ErrorAction SilentlyContinue   # 清掉沒用的 pid 檔
    exit 0
}

$id = $p.Id
Stop-Process -Id $id -Force

foreach ($i in 1..20) {
    Start-Sleep -Milliseconds 100
    if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { break }
}

Remove-Item $PidFile -ErrorAction SilentlyContinue

if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
    "停不掉：PID $id 還在。"
    exit 1
}

"已停止：PID $id"
exit 0
