# @title   Caddy 狀態
# @desc    版本、服務啟動參數、監聽的埠、設定檔是否有未套用的變更
# @group   caddy
$dir = Split-Path $PSScriptRoot -Parent
"version : " + (cmd /c "`"$dir\caddy.exe`" version 2>&1")

$svc = Get-Service caddy -ErrorAction SilentlyContinue
"service : " + $(if ($svc) { $svc.Status } else { '(沒有名為 caddy 的服務)' })

# 確認服務是用 --config 讀磁碟上的檔案，而不是 --resume 讀 autosave。
# 如果是 --resume，重開機後套用的會是 autosave.json 而不是 Caddyfile，
# 「改檔案 + reload」的模型就失效了。
$reg = 'HKLM:\SYSTEM\CurrentControlSet\Services\caddy'
if (Test-Path $reg) {
    $img = (Get-ItemProperty $reg -Name ImagePath -ErrorAction SilentlyContinue).ImagePath
    $p = Get-ItemProperty "$reg\Parameters" -ErrorAction SilentlyContinue
    if ($p) { "args    : " + $p.AppParameters }
    $all = "$img " + $p.AppParameters
    if ($all -match '--resume') {
        "設定來源: --resume（讀 autosave.json）—— 重開機不會套用檔案的修改 [注意]"
    } elseif ($all -match '--config') {
        "設定來源: --config（讀磁碟上的 Caddyfile）—— 重開機會套用檔案的修改 [OK]"
    } else {
        "設定來源: 沒有指定 --config，Caddy 會用工作目錄裡的 Caddyfile"
    }
}

"listen  : " + ((Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in 80,443,2019 } |
    ForEach-Object { $_.LocalAddress + ':' + $_.LocalPort } | Sort-Object -Unique) -join '  ')

foreach ($f in 'Caddyfile','Caddyfile.last-good') {
    $p2 = Join-Path $dir $f
    if (Test-Path $p2) { "{0,-22} {1}" -f $f, (Get-Item $p2).LastWriteTime }
    else { "{0,-22} (不存在)" -f $f }
}
$lg = Join-Path $dir 'Caddyfile.last-good'
"diff    : " + $(
    if (-not (Test-Path $lg)) { '尚未有 last-good（第一次 reload 成功後才會產生）' }
    elseif ((Get-FileHash (Join-Path $dir 'Caddyfile')).Hash -ne (Get-FileHash $lg).Hash)
        { 'Caddyfile 與 last-good 不同 - 有尚未套用或未驗證的變更' }
    else { '一致' })
exit 0
