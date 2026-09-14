# =============================================================================
#  caddy-outposts 移除程式
#
#  用「系統管理員」身分執行：
#
#      .\src\uninstall.ps1              停服務、拔掉所有註冊項目、刪 C:\Caddy
#      .\src\uninstall.ps1 -KeepFiles   只拔註冊項目，C:\Caddy 留著
#      .\src\uninstall.ps1 -WhatIf      只列出會做什麼，不動手
#      .\src\uninstall.ps1 -PurgeFirewall  連 Windows 自己建的殘留規則也刪
#
#  拔掉的東西（就是 install.ps1 建的那五樣）：
#      1. caddy 與 actiond 兩個 Windows 服務
#      2. 防火牆規則 "Caddy HTTP 80"（edge 還有 "Caddy HTTPS 443"）
#      3. 排程工作 caddy-bridge（以及舊版的 caddy-user-bridge）
#      4. ~\.claude\skills\caddy 技能
#      5. C:\Caddy —— 但 actions\ 裡你自己寫的腳本留在原地，見下面
#
#  **你的東西不會被刪。** 網站內容（<槽>\www、<槽>\projects、<槽>\workspaces）
#  一律留著。`C:\Caddy\actions\` 裡不是範本裝的那些腳本也留著 —— 技能教的就是
#  「往那個目錄丟一個檔案就多一個 action」，所以那裡本來就混著你寫的東西，
#  而它只存在那一份。跑完會列出留下了哪些，要清請自己手動刪。
#
#  為什麼需要這支程式：nssm.exe 本身就是那兩個服務的執行檔，所以只要服務還在跑，
#  nssm.exe 和 logs\ 就刪不掉（「檔案正由另一個程序使用」）。順序一定是
#  先停服務、確認行程真的死了、再刪檔案。
# =============================================================================
# [CmdletBinding()] 不能省：沒有它的話，param() 底下沒列到的參數會安靜地落進
# $args 被忽略。這支程式會刪東西，更不該把「你打錯了」當成「你沒打」。
[CmdletBinding()]
param(
    [switch] $KeepFiles,
    [switch] $WhatIf,
    [switch] $PurgeFirewall
)
$ErrorActionPreference = 'Stop'

# C:\Caddy 是釘死的，跟 install.ps1 一致。
$Dir = 'C:\Caddy'

function Say($m) { Write-Host $m }

# 不要用 PowerShell 的 2>&1 去接原生程式的 stderr：PS 5.1 會把每一行包成
# ErrorRecord，配上 ErrorActionPreference=Stop 會直接中止腳本，即使 exit code 是 0。
function Invoke-Exe([string]$Exe, [string]$Arguments) {
    $out = cmd /c "`"$Exe`" $Arguments 2>&1"
    [pscustomobject]@{ Output = $out; ExitCode = $LASTEXITCODE }
}

function Do-It([string]$What, [scriptblock]$Action) {
    if ($WhatIf) { Say ("  [WhatIf] " + $What); return }
    try { & $Action; Say ("  " + $What) }
    catch { Say ("  失敗：" + $What + " -> " + $_.Exception.Message) }
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '請用系統管理員身分執行（移除 Windows 服務需要）'
}

Say ''
Say '=== 服務 ==='
foreach ($n in 'caddy', 'actiond') {
    $svc = Get-Service $n -ErrorAction SilentlyContinue
    if (-not $svc) { Say "  $n 本來就不存在"; continue }

    if ($svc.Status -ne 'Stopped') {
        Do-It "停止 $n" { Stop-Service $n -Force -ErrorAction Stop }
        # 等它真的停 —— 服務回報 Stopped 之後，行程還可能要一下才收乾淨
        if (-not $WhatIf) {
            for ($i = 0; $i -lt 20; $i++) {
                $s = Get-Service $n -ErrorAction SilentlyContinue
                if (-not $s -or $s.Status -eq 'Stopped') { break }
                Start-Sleep -Milliseconds 500
            }
        }
    }
    # 用 sc.exe 而不是 nssm —— nssm.exe 可能已經被刪掉了，而服務登錄還在。
    #
    # 不要寫成 `& sc.exe ... 2>&1`：PS 5.1 會把原生程式的 stderr 每一行包成
    # ErrorRecord，配上 $ErrorActionPreference='Stop' 就算 exit code 是 0 也會
    # 變成終止錯誤。改用 cmd /c 讓重導在 cmd 那一層做完。
    Do-It "移除服務 $n" {
        $r = cmd /c "sc.exe delete $n 2>&1"
        if ($LASTEXITCODE -ne 0) { throw ($r -join ' ') }
    }
}

# 服務登錄拔掉之後，行程有時還在。它們鎖著 nssm.exe 和 logs\，一定要收乾淨。
if (-not $WhatIf) {
    Say ''
    Say '=== 殘留行程 ==='
    $stuck = Get-CimInstance Win32_Process -Filter "Name='nssm.exe' or Name='caddy.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Dir, 'OrdinalIgnoreCase') }
    if (-not $stuck) {
        Say '  沒有'
    } else {
        foreach ($p in $stuck) {
            Do-It ("結束 " + $p.Name + " (PID " + $p.ProcessId + ")") {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
            }
        }
        Start-Sleep -Seconds 1
    }
}

Say ''
Say '=== 防火牆 ==='
# 兩條都要試 —— edge 會多開 443，node 只有 80。
foreach ($fw in 'Caddy HTTP 80', 'Caddy HTTPS 443') {
    if ($WhatIf) {
        if (Get-NetFirewallRule -DisplayName $fw -ErrorAction SilentlyContinue) { Say "  [WhatIf] 移除規則 $fw" }
    } elseif (Get-NetFirewallRule -DisplayName $fw -ErrorAction SilentlyContinue) {
        Do-It "移除規則 $fw" { Get-NetFirewallRule -DisplayName $fw | Remove-NetFirewallRule }
    }
}
Say '  （沒列出來的就是本來就沒有）'

# Windows 自己建的殘留規則。
#
# caddy.exe 如果在規則還沒建好時就開始 listen，Windows 會跳「安全性警訊」彈窗，
# 使用者按下「允許存取」就留下兩條 Query User 規則：TCP + UDP、**所有埠**、
# Private + Public。範圍遠大於 install.ps1 開的那一兩個埠，而且它們是綁在
# 「程式路徑」上的 —— caddy.exe 重裝回同一個位置，它們就又生效了。
#
# install.ps1 現在會先建規則再啟動服務，所以新裝的機器不會再產生這種東西；
# 這一段是為了清掉舊版留下來的。
#
# **預設只列出來不刪**：這不是我們建的規則，使用者可能是刻意允許的，
# 也可能有別的程式共用。要刪就明講 -PurgeFirewall。
$strays = @()
foreach ($r in (Get-NetFirewallRule -Direction Inbound -ErrorAction SilentlyContinue)) {
    $prog = ($r | Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue).Program
    if ($prog -and $prog -like "$Dir\*.exe") { $strays += [pscustomobject]@{ Rule = $r; Program = $prog } }
}
if ($strays.Count) {
    Say ''
    Say ('  另外有 {0} 條不是 install.ps1 建的規則，綁在 {1} 的執行檔上：' -f $strays.Count, $Dir)
    foreach ($s in $strays) {
        Say ('    {0}  ({1})' -f $s.Rule.DisplayName, $s.Program)
    }
    if ($PurgeFirewall) {
        foreach ($s in $strays) {
            Do-It ('移除殘留規則 ' + $s.Rule.DisplayName) { $s.Rule | Remove-NetFirewallRule }
        }
    } else {
        Say '  這是 Windows 的「安全性警訊」彈窗按下允許時建的，範圍是該程式的所有埠。'
        Say '  沒有動它。要一併清掉就加 -PurgeFirewall 再跑一次。'
    }
}

Say ''
Say '=== 排程工作 ==='
# caddy-user-bridge 是舊版那個單插槽的橋。升級過的機器上不會有它，
# 但沒升級就直接移除的機器上會，所以兩個都要處理。
$removed = $false
foreach ($t in 'caddy-bridge', 'caddy-user-bridge') {
    if ($WhatIf) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Say ('  [WhatIf] 移除 ' + $t); $removed = $true
        }
    } elseif (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Do-It ('移除 ' + $t) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
        }
        $removed = $true
    }
}
if (-not $removed) { Say '  本來就沒有' }

Say ''
Say '=== /caddy 技能 ==='
# 服務是以 SYSTEM 跑的，但技能是裝在「當初執行 install.ps1 的那個使用者」家目錄。
# 提權執行時 $env:USERPROFILE 會是管理員的，所以每個使用者都掃一遍。
$skills = @()
foreach ($prof in (Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue)) {
    $p = Join-Path $prof.FullName '.claude\skills\caddy'
    if (Test-Path $p) { $skills += $p }
}
if (-not $skills) {
    Say '  Claude Code  找不到（可能裝在別的地方，或當初用了 -SkipSkill）'
} else {
    foreach ($p in $skills) {
        Do-It "移除 $p" { Remove-Item $p -Recurse -Force -ErrorAction Stop }
    }
}

# OpenClaw 那一份**只檢查，不刪**。
#
# `openclaw skills` 沒有 uninstall/remove 子命令，技能是放在它自己管理的目錄與
# 登錄裡。沒有支援的移除指令就去砍別人的目錄，是會把對方的狀態弄壞的做法 ——
# 所以這裡只負責告訴你它還在，怎麼處理由你決定。
#
# 另外：openclaw 通常裝在使用者層級的 npm 目錄，提權執行時 PATH 上不一定有它。
# 找不到就當作沒裝，不要報成錯誤。
#
# -CommandType Application 不能省：npm 同時放了 openclaw.cmd 和 openclaw.ps1，
# Get-Command 預設先給 .ps1，而 cmd /c 執行不了 .ps1 —— 會得到空輸出加 exit 0，
# 於是「找不到 not found」就變成「技能還在」的誤判。（實測踩到。）
$oc = Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
if (-not $oc) {
    Say '  OpenClaw     PATH 上沒有 openclaw，沒得檢查'
} else {
    $info = (Invoke-Exe $oc.Source 'skills info caddy').Output -join "`n"
    if ($info -match 'not found') {
        Say '  OpenClaw     沒有 caddy 技能'
    } else {
        Say '  OpenClaw     還有一份 caddy 技能 —— 這支腳本不會動它。'
        Say '    openclaw skills 沒有 uninstall 指令，要清請用 openclaw 自己的方式'
        Say '    （openclaw skills list 看它在哪個 agent workspace）。'
    }
}

Say ''
Say "=== $Dir ==="

# actions\ 是唯一一個「產品的東西和使用者的東西混在同一個目錄」的地方 —— 技能教的
# 就是往那裡丟一個檔案。所以刪之前先分辨：範本裝的那幾支照刪，剩下的是使用者寫的，
# 原地留著不動。那些腳本只存在那一份，刪掉就沒了。
#
# 依據是 repo 裡的 templates\actions\。這支腳本被複製到別的地方執行時（從
# \\主機\Caddy\uninstall.ps1 跑就是這種情況）拿不到那份清單 —— 那就整個 actions\
# 都留著。寧可留下幾支我們自己的檔案，也不要誤刪使用者寫的東西。
$repo        = Split-Path $PSScriptRoot -Parent
$tplActions  = Join-Path $repo 'templates\actions'
$actionsDir  = Join-Path $Dir 'actions'
$fromTemplate = $null
if (Test-Path $tplActions) {
    $fromTemplate = @(Get-ChildItem $tplActions -File -ErrorAction SilentlyContinue |
                      ForEach-Object { $_.Name })
}
# 子目錄一律算使用者的 —— 範本裡沒有任何子目錄。
$keep = @()
if (Test-Path $actionsDir) {
    $keep = @(Get-ChildItem $actionsDir -Force -ErrorAction SilentlyContinue | Where-Object {
        $null -eq $fromTemplate -or $_.PSIsContainer -or $fromTemplate -notcontains $_.Name
    })
}

if ($KeepFiles) {
    Say '  -KeepFiles：保留不刪'
} elseif (-not (Test-Path $Dir)) {
    Say '  本來就不存在'
} elseif ($WhatIf) {
    if ($keep.Count) {
        Say ("  [WhatIf] 刪除 $Dir，但留下 actions\ 裡那 {0} 個不是範本裝的東西" -f $keep.Count)
    } else {
        Say "  [WhatIf] 刪除 $Dir 整個目錄"
    }
} else {
    # 工作目錄如果在 C:\Caddy 裡面，Windows 不會讓你刪掉它 —— 而這支腳本本身
    # 就可能被放在那裡執行（從 \\主機\Caddy\uninstall.ps1 跑就是這種情況）。
    # 先走出去。腳本檔本身不會鎖住：PowerShell 是一次讀完才執行的。
    $here = (Get-Location).Path
    if ($here.StartsWith($Dir, 'OrdinalIgnoreCase')) {
        Set-Location $env:SystemRoot
        Say "  （工作目錄原本在 $Dir 裡面，已切到 $env:SystemRoot）"
    }

    # 一次刪不掉多半是還有 handle 沒放開。報出到底是哪個檔，比丟一句
    # 「拒絕存取」有用得多。
    try {
        if ($keep.Count) {
            # actions\ 以外的全刪，actions\ 裡只刪範本裝的那幾支。
            foreach ($item in (Get-ChildItem $Dir -Force -ErrorAction Stop)) {
                if ($item.FullName -eq $actionsDir) { continue }
                Remove-Item $item.FullName -Recurse -Force -ErrorAction Stop
            }
            if ($fromTemplate) {
                foreach ($n in $fromTemplate) {
                    $p = Join-Path $actionsDir $n
                    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
                }
            }
            Say "  已清空 $Dir，但留下 actions\（見最後一段）"
        } else {
            Remove-Item $Dir -Recurse -Force -ErrorAction Stop
            Say "  已刪除 $Dir"
        }
    } catch {
        Say ("  刪不掉：" + $_.Exception.Message)
        Say ''
        Say '  還被鎖住的檔案：'
        foreach ($f in (Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue)) {
            try {
                $s = [IO.File]::Open($f.FullName, 'Open', 'ReadWrite', 'None')
                $s.Close()
            } catch {
                Say ("    " + $f.FullName)
            }
        }
        Say ''
        Say '  通常是還有行程開著它們。找出是誰：'
        Say '    Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "C:\Caddy\*" }'
        exit 1
    }
}

Say ''
Say '=== 沒有動到的東西 ==='
Say '  網站內容（<槽>\www、<槽>\projects、<槽>\workspaces）一律保留 —— 那是你的資料。'
Say '  Node.js 也留著。'
if ($keep.Count -and -not $KeepFiles) {
    Say ''
    if ($null -eq $fromTemplate) {
        Say ("  {0} 整個留著。" -f $actionsDir)
        Say '  這支腳本不是從 repo 裡跑的，比對不到 templates\actions\ 那份清單，'
        Say '  分不出哪幾支是你寫的 —— 所以一個都沒刪，裡面混著我們裝的 caddy-* 。'
    } else {
        Say ('  {0} 底下有 {1} 個不是範本裝的東西，那是你寫的 action，留在原地：' -f $actionsDir, $keep.Count)
        foreach ($k in $keep) { Say ('    ' + $k.Name + $(if ($k.PSIsContainer) { '\' } else { '' })) }
    }
    Say ''
    Say '  確定不要了就自己刪：'
    Say ("      Remove-Item '$Dir' -Recurse -Force")
}
Say ''
Say '完成。這台現在可以當成空機重新安裝：'
Say '    node src\caddyctl.mjs node init      （或 edge init --token <token>）'
Say '    .\src\install.ps1'
