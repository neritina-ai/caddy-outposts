# @title   驗證並重載 Caddy
# @desc    先 validate，通過才 reload；成功後把設定存成 last-good
# @group   caddy
#
# 安全性質：validate 失敗時完全不動作。而且就算 Caddyfile 已經被寫壞，
# 正在跑的 Caddy 仍然用記憶體裡的舊設定服務中 —— 壞掉的檔案本身不會讓站台掛掉，
# 只有服務重啟才會。所以寫壞是救得回來的，用 caddy-rollback。
$dir = Split-Path $PSScriptRoot -Parent
$cf  = Join-Path $dir 'Caddyfile'

$out  = cmd /c "`"$dir\caddy.exe`" validate --config `"$cf`" --adapter caddyfile 2>&1"
$code = $LASTEXITCODE
if ($code -ne 0) {
    "VALIDATE FAILED - 沒有套用任何變更，站台仍在跑舊設定"
    $out | Where-Object { $_ -notmatch '"level":"(info|warn|debug)"' }
    exit $code
}

$out  = cmd /c "`"$dir\caddy.exe`" reload --config `"$cf`" --adapter caddyfile 2>&1"
$code = $LASTEXITCODE
if ($code -eq 0) {
    Copy-Item $cf (Join-Path $dir 'Caddyfile.last-good') -Force
    "reload OK（已更新 Caddyfile.last-good）"
} else {
    "RELOAD FAILED"
    $out | Where-Object { $_ -notmatch '"level":"(info|debug)"' }
}
exit $code
