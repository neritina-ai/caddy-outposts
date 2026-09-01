# hello-service 的共用設定與函式。
#
# 檔名開頭是底線 —— actiond 不會把這種檔案列成 action，所以它不會出現在
# /run 面板上，也不能被 HTTP 觸發。共用的東西就放這種檔案裡。
#
# 這個檔含中文，所以必須存成 UTF-8 with BOM。Windows PowerShell 5.1 讀
# 沒有 BOM 的 UTF-8 會當成系統 ANSI（在中文版是 Big5），中文註解裡只要有
# 破折號之類的字元，解析就會壞掉 —— 而且是安靜地壞掉：exit code 還是 0，
# 但後半段根本沒執行。

$CaddyDir = Split-Path $PSScriptRoot -Parent            # actions 的上一層 = C:\Caddy（固定的）
$AppDir   = Join-Path $CaddyDir 'apps\hello-service'    # 服務本身的程式放這裡
$Script   = Join-Path $AppDir 'server.mjs'
$PidFile  = Join-Path $CaddyDir 'logs\hello-service.pid'
$OutLog   = Join-Path $CaddyDir 'logs\hello-service.log'
$ErrLog   = Join-Path $CaddyDir 'logs\hello-service.err.log'
$Port     = 3100                                        # 要跟 apps\hello.caddy 裡的一致

# 讀 pid 檔，回傳那個行程；沒在跑就回 $null。
#
# 不能只看「pid 檔存在」就當作在跑：機器重開、或行程自己掛掉，pid 檔都還會留著。
# 也不能只看「這個 PID 存在」：Windows 會回收 PID 再配給別的程式。
# 所以要再確認它真的是 node。
function Get-HelloProcess {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw -ErrorAction SilentlyContinue)
    if (-not $raw) { return $null }
    $id = 0
    if (-not [int]::TryParse($raw.Trim(), [ref]$id)) { return $null }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'node') { return $p }
    return $null
}

function Test-HelloPort {
    try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) }
    catch { return $false }
}
