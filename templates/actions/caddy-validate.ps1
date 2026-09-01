# @title   驗證 Caddyfile
# @desc    只檢查語法，不套用。改完設定先跑這個。
# @group   caddy
$dir = Split-Path $PSScriptRoot -Parent
$out = cmd /c "`"$dir\caddy.exe`" validate --config `"$dir\Caddyfile`" --adapter caddyfile 2>&1"
$code = $LASTEXITCODE
$out | Where-Object { $_ -notmatch '"level":"(info|warn|debug)"' }
if ($code -eq 0) { "OK" }
exit $code
