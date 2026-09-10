# =============================================================================
#  skill-caddy 安裝程式
#
#  在目標機器上，兩個步驟：
#
#      node src\caddyctl.mjs node init            <- 先寫設定（不用管理員）
#      .\src\install.ps1                          <- 再裝服務（要管理員）
#
#  edge 的話第一步換成：
#
#      node src\caddyctl.mjs edge init --token <duckdns token>
#
#  順序不能反：這支程式要靠 C:\Caddy\conf\manifest.json 才知道這台是什麼角色、
#  該下載哪個 caddy 建置。那個檔是 caddyctl 寫的。
#
#  它會：
#    1. 抓 caddy.exe（帶對的外掛）與 nssm.exe —— 已經有就跳過
#    2. 建立目錄、複製樣板（不會覆蓋已存在的內容檔）
#    3. 驗證設定 —— 不通過就停，不會裝出一個起不來的服務
#    4. 安裝 caddy 與 actiond 兩個服務（開機自動啟動）
#    5. 註冊「以使用者身分執行」的橋接排程工作
#    6. 安裝 /caddy 技能到 ~\.claude\skills\caddy\
#
#  只有這一步需要管理員。裝完之後所有設定變更都能用 HTTP 完成。
# =============================================================================
# [CmdletBinding()] 不能省：沒有它的話，param() 底下沒列到的參數會安靜地落進
# $args 被忽略。打錯一個旗標卻什麼都不說，是這套工具最不該有的失敗方式。
[CmdletBinding()]
param(
    [string]  $Machine    = $env:COMPUTERNAME,
    [switch]  $SystemAccount,
    [switch]  $SkipSkill,
    [string]  $BridgeUser = '',
    [string[]]$Plugins    = @()
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

# C:\Caddy 是硬性規定，不是可以調的參數。
# 整套系統只有這一個固定點 —— 裝到機器上的 /caddy 技能才寫得出可以直接照抄的
# 路徑，而不是滿篇 <CADDY_DIR>。內容目錄的名稱同樣是固定的，只有磁碟機代號可換
# （caddyctl node init --drive），實際是哪個槽寫在 C:\Caddy\conf\manifest.json 裡。
$Dir = 'C:\Caddy'

function Say($m) { Write-Host $m }

# 不要用 PowerShell 的 2>&1 去接原生程式的 stderr：PS 5.1 會把每一行包成
# ErrorRecord，配上 ErrorActionPreference=Stop 會直接中止腳本，即使 exit code 是 0。
function Invoke-Exe([string]$Exe, [string]$Arguments) {
    $out = cmd /c "`"$Exe`" $Arguments 2>&1"
    [pscustomobject]@{ Output = $out; ExitCode = $LASTEXITCODE }
}

function Wait-Svc([string]$Name, [string]$Want = 'Running', [int]$Seconds = 25) {
    for ($i = 0; $i -lt $Seconds; $i++) {
        $s = Get-Service $Name -ErrorAction SilentlyContinue
        if ($Want -eq 'Stopped' -and -not $s) { return $true }
        if ($s -and $s.Status -eq $Want) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '請用系統管理員身分執行（安裝 Windows 服務需要）'
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---------------------------------------------------------------- manifest
# caddyctl 會在 conf\manifest.json 寫下這台的角色與需要的外掛。
# 讓它當唯一的來源，安裝程式就不必自己維護一份清單 ——
# edge 需要 duckdns + dynamicdns，node 需要 webdav，兩者都是就三個都要。
$manifest = $null
foreach ($m in @((Join-Path $Dir 'conf\manifest.json'))) {
    # -Encoding UTF8 不能省：PS 5.1 的 Get-Content 讀沒有 BOM 的 UTF-8 會當成
    # 系統 ANSI，非 ASCII 字元一被扭曲，ConvertFrom-Json 就整份失敗。
    # （產生器那端也保證只寫 ASCII，兩邊都做。）
    if ($m -and (Test-Path $m)) { $manifest = Get-Content $m -Raw -Encoding UTF8 | ConvertFrom-Json; break }
}
if (-not $Plugins -or $Plugins.Count -eq 0) {
    if ($manifest) {
        $Plugins = @($manifest.plugins)
        Say ''
        Say ('=== manifest ===')
        Say ('  機器：' + $manifest.machine + '   角色：' + ($manifest.roles -join ', '))
    } else {
        throw ("找不到 $Dir\conf\manifest.json。先產生設定再回來裝服務：" + [Environment]::NewLine +
               "    node src\caddyctl.mjs node init" + [Environment]::NewLine +
               "  或 node src\caddyctl.mjs edge init --token <duckdns token>")
    }
}

# ---------------------------------------------------------------- 目錄
Say ''
Say '=== 目錄 ==='
foreach ($d in 'apps', 'actions', 'actiond', 'conf', 'logs') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null
}
Say "  $Dir"

# ---------------------------------------------------------------- caddy.exe
Say ''
Say '=== caddy.exe ==='
$caddy = Join-Path $Dir 'caddy.exe'
if (Test-Path $caddy) {
    Say ('  已存在：' + (Invoke-Exe $caddy 'version').Output)
} else {
    $qs = ($Plugins | ForEach-Object { 'p=' + [Uri]::EscapeDataString($_) }) -join '&'
    $url = "https://caddyserver.com/api/download?os=windows&arch=amd64&$qs"
    Say '  從 caddyserver.com 下載（含外掛）：'
    foreach ($p in $Plugins) { Say "    $p" }
    Invoke-WebRequest -Uri $url -OutFile $caddy -UseBasicParsing
    Say ('  ' + (Invoke-Exe $caddy 'version').Output)
}

# ---------------------------------------------------------------- nssm.exe
Say ''
Say '=== nssm.exe ==='
$nssm = Join-Path $Dir 'nssm.exe'
if (Test-Path $nssm) {
    Say '  已存在'
} else {
    $zip = Join-Path $env:TEMP 'nssm.zip'
    $ex = Join-Path $env:TEMP 'nssm-extract'
    Say '  從 nssm.cc 下載'
    Invoke-WebRequest -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
    Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zip -DestinationPath $ex -Force
    $found = Get-ChildItem $ex -Recurse -Filter 'nssm.exe' |
             Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1
    if (-not $found) { throw 'nssm 壓縮檔裡找不到 win64 的 nssm.exe' }
    Copy-Item $found.FullName $nssm
    Remove-Item $zip, $ex -Recurse -Force -ErrorAction SilentlyContinue
    Say '  完成'
}

# ---------------------------------------------------------------- 樣板
Say ''
Say '=== 樣板 ==='
Copy-Item (Join-Path $repo 'src\actiond\server.mjs') (Join-Path $Dir 'actiond') -Force
Copy-Item (Join-Path $repo 'templates\actiond\user-bridge.ps1') (Join-Path $Dir 'actiond') -Force
Copy-Item (Join-Path $repo 'templates\actions\*') (Join-Path $Dir 'actions') -Force
Copy-Item (Join-Path $repo 'templates\apps\*') (Join-Path $Dir 'apps') -Force
Say '  actiond / actions / apps'

# ---------------------------------------------------------------- 設定
# 設定是 caddyctl 寫的，這裡只確認它在。
if (-not (Test-Path (Join-Path $Dir 'Caddyfile'))) {
    throw "$Dir 裡沒有 Caddyfile。先跑 node src\caddyctl.mjs node init（或 edge init）。"
}

# ---------------------------------------------------------------- 內容目錄
# 位置從 manifest 拿（已經是 Windows 寫法的路徑）。純 edge 的機器沒有 node 這一段，
# 就整段跳過。
$contentRoot = $null
$publicDir   = $null
if ($manifest -and $manifest.node) {
    $contentRoot = $manifest.node.content_root
    $publicDir   = $manifest.node.public_dir
}
if ($contentRoot) {
    Say ''
    Say '=== 內容目錄 ==='
    New-Item -ItemType Directory -Force -Path $contentRoot, $publicDir | Out-Null
    # public_dir 不一定是 content_root\public，所以目的地寫完整路徑
    $files = @(
        @{ s = 'templates\www\index.html';        d = (Join-Path $contentRoot 'index.html') },
        @{ s = 'templates\www\_md.html';          d = (Join-Path $contentRoot '_md.html') },
        @{ s = 'templates\www\public\index.html'; d = (Join-Path $publicDir  'index.html') }
    )
    foreach ($f in $files) {
        if (Test-Path $f.d) {
            Say ('  ' + $f.d + ' 已存在，保留不覆蓋')
        } else {
            # 樣板是 UTF-8 沒有 BOM，一定要明講編碼：PS 5.1 的 Get-Content 沒有
            # -Encoding 就用系統 ANSI 讀（這幾台是 cp950），中文會被 Big5 解成假字，
            # emoji 更直接變成 ?。寫出去照樣是合法的 UTF-8，所以事後看不出是哪裡壞的。
            # 用 ReadAllText 跟下面的 WriteAllText 對齊，不靠任何預設值。
            $txt = [IO.File]::ReadAllText((Join-Path $repo $f.s), [Text.UTF8Encoding]::new($false))
            $txt = $txt -replace '__MACHINE__', $Machine
            [IO.File]::WriteAllText($f.d, $txt, [Text.UTF8Encoding]::new($false))
            Say ('  ' + $f.d)
        }
    }

    # 掛載點只要目錄不在就是 404，而且是安靜的 404。裝的時候講一聲，
    # 比之後對著空白頁面查半天好 —— 尤其是機器沒有 D: 槽這種情況。
    Say ''
    Say '=== 掛載點 ==='
    foreach ($p in $manifest.node.url_map.PSObject.Properties) {
        if ($p.Value -notmatch '^[A-Za-z]:\\') { continue }     # /run 那種不是路徑
        if (Test-Path $p.Value) {
            Say ('  {0,-8} {1}' -f $p.Name, $p.Value)
        } else {
            Say ('  {0,-8} {1}   <- 目錄不存在，這個網址會是 404' -f $p.Name, $p.Value)
            Say ('           整組換一個槽：node src\caddyctl.mjs node init --drive <代號>')
        }
    }
}

# ---------------------------------------------------------------- 驗證
Say ''
Say '=== 驗證設定 ==='
$cf = Join-Path $Dir 'Caddyfile'
$v = Invoke-Exe $caddy "validate --config `"$cf`" --adapter caddyfile"
if ($v.ExitCode -ne 0) {
    $v.Output | Where-Object { $_ -notmatch '"level":"(info|warn|debug)"' }
    throw 'Caddyfile 驗證失敗 —— 沒有安裝任何服務'
}
Say '  通過'

# ---------------------------------------------------------------- 服務
Say ''
Say '=== 服務 ==='
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*actiond*server.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    $c = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $c) { $node = $c }
}
if (-not $node) { throw '找不到 node.exe —— actiond 需要 Node.js' }

function Install-Svc($Name, $Exe, $Arguments) {
    if (Get-Service $Name -ErrorAction SilentlyContinue) {
        Stop-Service $Name -Force -ErrorAction SilentlyContinue
        Wait-Svc $Name 'Stopped' 15 | Out-Null
        & $nssm remove $Name confirm | Out-Null
        Start-Sleep -Seconds 2
    }
    & $nssm install $Name $Exe $Arguments | Out-Null
    & $nssm set $Name AppDirectory $Dir | Out-Null
    & $nssm set $Name AppStdout "$Dir\logs\$Name.log" | Out-Null
    & $nssm set $Name AppStderr "$Dir\logs\$Name.log" | Out-Null
    & $nssm set $Name AppRotateFiles 1 | Out-Null
    & $nssm set $Name Start SERVICE_AUTO_START | Out-Null
}

# 一定要 --config 指到磁碟上的檔案。不要用 --resume ——
# 那會讀 autosave.json，於是「改檔案 + reload」的模型重開機後就失效了。
Install-Svc 'caddy' $caddy "run --config $cf --adapter caddyfile"
Install-Svc 'actiond' $node "$Dir\actiond\server.mjs"
# 埠要跟產生出來的站台設定一致 —— 那邊 reverse_proxy 指到哪，這邊就得聽哪。
$actionPort = 9001
if ($manifest -and $manifest.node -and $manifest.node.actiond_port) {
    $actionPort = $manifest.node.actiond_port
}
& $nssm set actiond AppEnvironmentExtra "ACTIONS_DIR=$Dir\actions" "ACTION_HOST=127.0.0.1" "ACTION_PORT=$actionPort" | Out-Null

# 使用者在 Get-Credential 的對話框裡打什麼，PSCredential 就原樣給什麼 ——
# alice / .\alice / MYBOX\alice 都可能。但 ChangeServiceConfig 對本機帳號
# 要的是 .\帳號：給裸名字會回 error 1057「帳戶名稱不正確或不存在」。
function Resolve-Account([string]$u) {
    $n = $u.Trim()
    if ($n -like '.\*') { return $n }
    if ($n -like '*@*') { return $n }                       # UPN，原樣
    if ($n -match '^([^\\]+)\\(.+)$') {
        if ($Matches[1] -eq $env:COMPUTERNAME) { return '.\' + $Matches[2] }
        return $n                                            # 網域帳號，原樣
    }
    return '.\' + $n
}

# error 1057 把「帳號不存在」和「密碼不對」講成同一句話，使用者只能亂猜。
# 先自己驗一次，就能明確講是哪一種。驗不了（例如網域帳號）就回 $null，不擋。
function Test-LocalAccount([string]$bare, [string]$pass) {
    try {
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement -ErrorAction Stop
        $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine')
        return $ctx.ValidateCredentials($bare, $pass)
    } catch { return $null }
}

if (-not $SystemAccount) {
    Say ''
    Say 'actiond 要用哪個帳號跑？（取消就是用 LOCAL SYSTEM）'
    Say '帳號填  .\你的帳號'
    try {
        $cred = Get-Credential -Message 'actiond 服務要用的帳號'
        if ($cred) {
            $pw = $cred.GetNetworkCredential().Password
            if (-not $pw) {
                # 空密碼帳號當服務身分有兩道關卡，而且都不是這支程式該去拆的：
                #   1. nssm 自己就拒絕：
                #      Setting "ObjectName" requires both a username and password!
                #   2. 就算繞過 nssm（sc.exe config 吃得下空密碼），Windows 預設的
                #      「限制本機帳戶使用空白密碼僅限主控台登入」會擋掉服務登入 ——
                #      服務登入跟自動登入是不同的登入類型。
                # 要放行得改機器層級的安全性原則，那對一台對外的機器是不划算的交易。
                #
                # 而且通常根本不需要：要使用者身分的 action 走下面的橋接就好，
                # 那條路一份密碼都不用存。
                Say '  這個帳號沒有設密碼，不能拿來當服務身分。'
                Say '  （nssm 不收空密碼；Windows 預設也只讓空密碼帳號從主控台登入，'
                Say '   服務登入是另一種登入類型 —— 跟你開機自動登入不衝突。）'
                Say '  這次用 LOCAL SYSTEM。要用使用者層級的工具，走下面的「使用者身分橋接」，'
                Say '  它以互動式身分執行，不必在任何地方存密碼。'
            } else {
                $acct = Resolve-Account $cred.UserName
                if ($acct -ne $cred.UserName) { Say "  帳號正規化為 $acct" }

                # 本機帳號才驗得了。網域帳號 / UPN 交給 nssm 自己去試。
                $ok = $null
                if ($acct -like '.\*') { $ok = Test-LocalAccount ($acct -replace '^\.\\', '') $pw }

                if ($ok -eq $false) {
                    Say "  這組帳號密碼在本機驗不過：$acct"
                    Say '  可能是帳號不存在，也可能是密碼不對 —— 這兩種 Windows 回報的是同一個錯誤。'
                    Say '  在那台自己確認：net user ' + ($acct -replace '^\.\\', '')
                    Say '  這次用 LOCAL SYSTEM。'
                } else {
                    & $nssm set actiond ObjectName $acct $pw | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        Say '  設定帳號失敗（上面那行是 nssm 的訊息）—— 這次用 LOCAL SYSTEM。'
                    }
                }
            }
        }
    } catch {
        Say '  略過，使用 LOCAL SYSTEM'
    }
}

# 不管上面走哪一條，都把「實際上是誰」讀回來再報告。
#
# 這裡踩過的坑：原本設完就無條件印「actiond 將以 <帳號> 執行」，但 nssm 其實
# 拒絕了空密碼。訊息報的是「打算」，使用者以為 action 跑得到使用者層級的工具，
# 實際上是 LOCAL SYSTEM —— 要等到某個 action 讀到 systemprofile 的設定才會發現。
# 報告一律以讀回來的實際值為準。
$objName = ''
try {
    # nssm 的 get 在某些版本輸出 UTF-16，透過 cmd 捕捉會夾帶 NUL 之類的字元。
    # 濾掉不可列印的東西：濾完是空的就走下面「讀不到」那條，不要印一串亂碼。
    $raw = (Invoke-Exe $nssm 'get actiond ObjectName').Output -join ''
    $objName = ($raw -replace '[^\x20-\x7E]', '').Trim()
} catch { }
if ($objName) {
    Say "  actiond 實際執行身分：$objName"
} else {
    Say '  讀不到 actiond 的執行身分，請自己確認：nssm get actiond ObjectName'
}

# ---------------------------------------------------------------- 防火牆
# **一定要在 Start-Service 之前。** 服務先起來的話，caddy.exe 會在還沒有規則的
# 情況下開始 listen，Windows 就跳出「安全性警訊」彈窗；使用者按下「允許存取」
# 留下的是兩條 Query User 規則（TCP + UDP、**所有埠**、Private + Public），
# 範圍遠大於這裡想開的那一個埠，而且 uninstall 拔不掉（那不是我們建的）。
# 先把規則建好，那個彈窗就不會出現。（實測踩到過。）
#
# node 只收 80（auto_https off，TLS 是 edge 的事）。
# edge 還要 443 —— 憑證在那裡談，少開這個埠等於整台從外面連不進來。
$isEdge = $manifest -and ($manifest.roles -contains 'edge')
$ports = @(@{ n = 'Caddy HTTP 80'; p = 80 })
if ($isEdge) { $ports += @{ n = 'Caddy HTTPS 443'; p = 443 } }
foreach ($r in $ports) {
    Get-NetFirewallRule -DisplayName $r.n -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $r.n -Direction Inbound -Protocol TCP -LocalPort $r.p -Action Allow | Out-Null
    Say ('  防火牆 已允許連入 ' + $r.p)
}

foreach ($n in 'caddy', 'actiond') {
    Start-Service $n -ErrorAction SilentlyContinue
    if (Wait-Svc $n) {
        Say ('  {0,-8} Running' -f $n)
    } else {
        Say ('  {0,-8} 啟動失敗' -f $n)
        Get-Content "$Dir\logs\$n.log" -Tail 10 -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 使用者身分橋接
Say ''
Say '=== 使用者身分橋接 ==='
$bu = $BridgeUser
if (-not $bu) {
    $cs = Get-CimInstance Win32_ComputerSystem
    if ($cs.UserName) { $bu = $cs.UserName }
}
if ($bu) {
    try {
        $act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Dir\actiond\user-bridge.ps1`""
        $pri = New-ScheduledTaskPrincipal -UserId $bu -LogonType Interactive -RunLevel Highest
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName 'caddy-user-bridge' -Action $act -Principal $pri -Settings $set -Force | Out-Null
        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        $svc.GetFolder('\').GetTask('caddy-user-bridge').SetSecurityDescriptor('D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GRGX;;;IU)', 0)
        Say "  已註冊，以 $bu 的身分執行"
        Say '  （需要該使用者處於登入狀態；只有用到使用者層級工具的 action 才需要它）'
    } catch {
        Say "  註冊失敗：$($_.Exception.Message)"
        Say '  只有需要使用者層級工具的 action 會受影響'
    }
} else {
    Say '  找不到登入中的使用者，略過。之後可用 -BridgeUser 重跑'
}

# ---------------------------------------------------------------- 技能
# 這台機器上會有哪些 AI 工具，事先不知道。所以每一種都試著裝一份 ——
# 裝了才有用，沒裝的那種就跳過，不要因為少一個工具就整支腳本失敗。
if (-not $SkipSkill) {
    Say ''
    Say '=== /caddy 技能 ==='

    # Claude Code：直接複製到家目錄。
    $sk = Join-Path $env:USERPROFILE '.claude\skills\caddy'
    New-Item -ItemType Directory -Force -Path $sk | Out-Null
    Copy-Item (Join-Path $repo 'skill\*') $sk -Recurse -Force
    Say "  Claude Code  $sk"

    # OpenClaw：有它自己的技能目錄與登錄，所以要用它的 CLI 裝，不能直接複製檔案。
    #
    # openclaw 通常裝在「使用者層級」的 npm 目錄（%APPDATA%\npm）。這支腳本是
    # 提權執行的 —— 如果提權用的是另一個管理員帳號，PATH 上就找不到 openclaw。
    # 那不是錯誤，只是這一步得由那個使用者自己跑，所以印出指令請他補。
    # **一定要 -CommandType Application。** npm 會同時放 openclaw.cmd 和
    # openclaw.ps1，而 Get-Command 預設先回傳 .ps1（ExternalScript）——
    # 那個路徑丟給 cmd /c 是執行不了的，會安靜地跑出空輸出加 exit 0，
    # 看起來像成功其實什麼都沒做。要的是 .cmd 那個 shim。（實測踩到。）
    $oc = Get-Command openclaw -CommandType Application -ErrorAction SilentlyContinue |
          Select-Object -First 1
    $skillSrc = Join-Path $repo 'skill'
    if ($oc) {
        $r = Invoke-Exe $oc.Source "skills install `"$skillSrc`" --as caddy --force"
        if ($r.ExitCode -eq 0) {
            Say '  OpenClaw     已安裝（openclaw skills install --as caddy）'
        } else {
            Say '  OpenClaw     安裝失敗：'
            $r.Output | ForEach-Object { Say "    $_" }
            Say '    可以自己重跑：'
            Say "    openclaw skills install `"$skillSrc`" --as caddy --force"
        }
    } else {
        Say '  OpenClaw     PATH 上沒有 openclaw，略過。'
        Say '    這台如果有裝 OpenClaw，用你自己的帳號跑一次：'
        Say "    openclaw skills install `"$skillSrc`" --as caddy --force"
    }
}

# ---------------------------------------------------------------- 自我測試
# 分角色測。edge 沒有 / 和 /pub/（那是 node 的路徑），也沒有把 /run 掛在 Caddy
# 底下 —— 它的 actiond 只聽 127.0.0.1:9001。拿 node 那組去測 edge 會得到三個
# 失敗，看起來像裝壞了，其實是測錯東西。
Say ''
Say '=== 自我測試 ==='

# actiond 兩種角色都有，而且都是直接打它自己的埠
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$actionPort/run" -UseBasicParsing -TimeoutSec 5
    Say ('  actiond :{0}  HTTP {1}' -f $actionPort, $r.StatusCode)
} catch {
    Say ('  actiond :{0}  失敗：{1}' -f $actionPort, $_.Exception.Message)
}

if ($manifest.node) {
    foreach ($u in @('/', '/run', '/pub/')) {
        try {
            $r = Invoke-WebRequest "http://127.0.0.1$u" -UseBasicParsing -TimeoutSec 5
            Say ('  {0,-8} HTTP {1}' -f $u, $r.StatusCode)
        } catch {
            Say ('  {0,-8} 失敗：{1}' -f $u, $_.Exception.Message)
        }
    }
}

if ($isEdge) {
    $doms = @()
    if ($manifest.edge -and $manifest.edge.domains) {
        $doms = @($manifest.edge.domains.PSObject.Properties | ForEach-Object { $_.Value.fqdn })
    }

    if (-not $doms.Count) {
        # 一個網域都沒有 = 一個 site block 都沒有 = Caddy 不會綁任何埠。
        # 這是正常的，不要在這裡報「埠沒在聽」嚇人（實測過：零 site 就零 listener）。
        Say '  還沒有任何網域，所以 Caddy 還沒有在聽任何埠 —— 這是正常的。'
        Say ''
        Say '  接著加網域。一個網域只要決定「背後是什麼」，三選一：'
        Say '    node src\caddyctl.mjs edge set --name <label> [--content <目錄>]   這台自己服務靜態內容'
        Say '    node src\caddyctl.mjs edge set --name <label> --ip <位址[:埠]>     轉給另一台 node'
        Say '    node src\caddyctl.mjs edge set --name <label> --hold               先佔著，之後再指派'
        Say ''
        Say '  前兩種可以要密碼。不加就是公開的，任何人都看得到：'
        Say '    --password <密碼>             帳號自動用 <label>'
        Say '    --password <帳號>:<密碼>      要自己指定帳號就加冒號'
        Say '    --password-hash [帳號:]<雜湊> 已經有 bcrypt 雜湊就用這個'
        Say '    --public <路徑>               這些路徑免密碼，可重複，預設 /pub/*'
        Say ''
        Say '  然後套用：'
        Say "    node src\caddyctl.mjs reload"
    } else {
        # edge 服務的是一個個 hostname，用 127.0.0.1 打不到任何 site block，
        # 所以改成確認「該聽的埠有在聽」。
        foreach ($p in 80, 443) {
            $listening = $false
            try { $listening = [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop) } catch { }
            Say ('  埠 {0,-5} {1}' -f $p, $(if ($listening) { '有在聽' } else { '沒在聽 <- 有問題' }))
        }
        Say ('  網域    ' + ($doms -join ', '))
        Say '  憑證第一次簽發要一兩分鐘，之後從外面連 https:// 就會通。'
    }
}

Say ''
Say "完成。log 在 $Dir\logs\"

if ($isEdge) {
    Say ''
    Say 'edge 套用設定變更要打 actiond 自己的埠（它沒有掛在 Caddy 底下）：'
    Say "    node src\caddyctl.mjs reload"
}
