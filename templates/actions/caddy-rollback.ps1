# @title   還原上一份可用的設定
# @desc    把 Caddyfile.last-good 蓋回 Caddyfile 並重載
# @group   caddy
# @confirm
$dir = Split-Path $PSScriptRoot -Parent
$lg  = Join-Path $dir 'Caddyfile.last-good'
if (-not (Test-Path $lg)) { "找不到 $lg，無法還原"; exit 1 }
Copy-Item $lg (Join-Path $dir 'Caddyfile') -Force
$out  = cmd /c "`"$dir\caddy.exe`" reload --config `"$dir\Caddyfile`" --adapter caddyfile 2>&1"
$code = $LASTEXITCODE
if ($code -eq 0) { "已還原並重載" } else { "還原後 reload 失敗"; $out }
exit $code
