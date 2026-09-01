# 給需要「使用者身分」的 action 用的共用函式。
# 底線開頭 -> actiond 不會把它列成一個 action。
#
# 為什麼需要這個：actiond 是以 LOCAL SYSTEM 執行的服務（安裝時不必存密碼）。
# 但有些工具裝在使用者層級（%APPDATA% 底下的 npm 全域套件、使用者自己的
# 排程工作），用 SYSTEM 跑會讀到 systemprofile 的設定、操作到錯的東西。
#
# 用法：
#     . "$PSScriptRoot\_userbridge.ps1"
#     Invoke-AsUser 'mytool do-something'
#     exit $global:UserExitCode
#
# 限制：使用者必須處於登入狀態（橋接用的是 Interactive 排程工作）。

function Invoke-AsUser {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [int]$TimeoutSec = 90
    )
    $root = Split-Path $PSScriptRoot -Parent
    $req  = Join-Path $root 'actiond\user-request.ps1'
    $out  = Join-Path $root 'logs\user-request.out'
    $lock = Join-Path $root 'logs\user-bridge.lock'

    # 這條橋一次只能跑一個請求（輸入輸出檔是固定路徑），用鎖檔序列化
    $acquired = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $fs = [IO.File]::Open($lock, 'CreateNew', 'Write', 'None')
            $fs.Close(); $acquired = $true; break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $acquired) {
        Write-Output '使用者身分橋接忙碌中，稍後再試'
        $global:UserExitCode = 1
        return
    }

    try {
        Remove-Item $out -ErrorAction SilentlyContinue
        # 用 UTF-8 with BOM 寫，PowerShell 5.1 才不會把中文當成系統編碼
        [IO.File]::WriteAllText($req, $Command, [Text.UTF8Encoding]::new($true))

        Start-ScheduledTask -TaskName 'caddy-user-bridge' -ErrorAction Stop

        $deadline = (Get-Date).AddSeconds($TimeoutSec)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path $out) {
                $txt = Get-Content $out -Raw -ErrorAction SilentlyContinue
                if ($txt -match '__EXIT__=(-?\d+)\s*$') {
                    $global:UserExitCode = [int]$Matches[1]
                    Write-Output ($txt -replace '__EXIT__=-?\d+\s*$', '').TrimEnd()
                    return
                }
            }
            Start-Sleep -Milliseconds 400
        }
        Write-Output "逾時（${TimeoutSec}s）—— 使用者可能沒有登入。"
        Write-Output '這條橋用的是 Interactive 排程工作，需要使用者處於登入狀態。'
        $global:UserExitCode = 1
    } finally {
        Remove-Item $lock -ErrorAction SilentlyContinue
    }
}
