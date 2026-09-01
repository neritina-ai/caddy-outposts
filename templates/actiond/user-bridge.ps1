# =============================================================================
#  以「登入中的使用者」身分執行請求 —— 由排程工作 caddy-user-bridge 觸發。
#
#  協定：
#    輸入  <caddy 目錄>\actiond\user-request.ps1
#    輸出  <caddy 目錄>\logs\user-request.out   最後一行是 __EXIT__=<code>
#
#  限制：使用者必須是登入狀態（工作用 Interactive logon）。
#        SYSTEM 沒有權限註冊 S4U 工作，所以做不到「登出也能跑」。
# =============================================================================
$root = Split-Path $PSScriptRoot -Parent
$req = Join-Path $root 'actiond\user-request.ps1'
$out = Join-Path $root 'logs\user-request.out'

New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Remove-Item $out -ErrorAction SilentlyContinue

if (-not (Test-Path $req)) {
    "沒有找到請求檔 $req" | Out-File $out -Encoding utf8
    "__EXIT__=1" | Out-File $out -Append -Encoding utf8
    exit 1
}

try {
    & $req *>&1 | Out-File $out -Encoding utf8
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
} catch {
    $_ | Out-String | Out-File $out -Encoding utf8
    $code = 1
}
"__EXIT__=$code" | Out-File $out -Append -Encoding utf8
