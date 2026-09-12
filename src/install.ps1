# =============================================================================
#  caddy-outposts 安裝程式
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
#    5. 把 actiond 降到最小權限的服務帳號 —— 是管理員就停下來什麼都不裝
#    6. 註冊「以使用者身分執行」的橋接排程工作 —— actiond 靠它跑每一支 action
#    7. 安裝 /caddy 技能到 ~\.claude\skills\caddy\
#
#  只有這一步需要管理員。裝完之後所有設定變更都能用 HTTP 完成。
# =============================================================================
# [CmdletBinding()] 不能省：沒有它的話，param() 底下沒列到的參數會安靜地落進
# $args 被忽略。打錯一個旗標卻什麼都不說，是這套工具最不該有的失敗方式。
[CmdletBinding()]
param(
    [string]  $Machine     = $env:COMPUTERNAME,
    [string]  $ActiondUser = '',
    [switch]  $SkipSkill,
    [string]  $BridgeUser  = '',
    [string[]]$Plugins     = @()
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

# ---------------------------------------------------------------- actiond 的執行身分
#
# **這是這支腳本唯一真正重要的權限決定，所以放在動任何東西之前** —— 不合格就停在
# 這裡，不會留下一台裝到一半的機器。
#
# actiond 的工作就是執行 C:\Caddy\actions\ 裡的東西，它本質上是一台 RCE 機器，
# 所以它的權限等級直接等於那個目錄的爆炸半徑 —— 不管是被攻擊還是手滑。
#
# 這裡踩過的坑（2026-09）：本來是問使用者「actiond 要用哪個帳號跑」然後照單全收。
# 但**服務登入不經過 UAC 過濾** —— 分割 token 只在互動式登入的時候造出來，SCM
# 拿到的一律是完整、沒削過的那個。於是填自己的帳號（通常就是管理員）的結果是
# actiond 拿到完整的管理員 token，而訊息只說「將以 <帳號> 執行」：
# 看起來像降權，實際上是提權。
#
# 驗過、都不行的替代方案，不要再試一遍：
#
#   * 服務沒有「用多少權限跑」這個開關。sc config 只有 obj=，沒有權限層級。
#   * 排程工作 -LogonType S4U -RunLevel Limited：實測拿到 High、admin=True。
#     Limited 要有互動式登入造出來的那個「過濾過的伴生 token」才有東西可挑，
#     非互動式登入根本沒有那一對。
#   * 服務裡呼叫 runas /trustlevel:0x20000：實測子行程一樣是 High、admin=True，
#     而且 runas 0.03 秒就回來、不等子行程，nssm 也監管不到。
#   * -LogonType Interactive -RunLevel Limited 真的會降權（user-bridge 就是這個），
#     但它要使用者處於登入狀態 —— 而「人不在家、網站壞了」正是最需要 action 的時候。
#
# 所以唯一能動的是**換帳號**，預設用 Windows 給服務準備的最小權限身分：
# 不用密碼、不用建帳號、不用記住任何東西。
#
# 而且**不相信名字，去查實際的群組成員資格**。「LocalService 不是管理員」是一個
# 機器層級的事實，不是一個常數 —— 開發用的那台上它就被加進 Administrators 過
# （那不是 Windows 預設）：名字一模一樣，權限天差地遠。

# 使用者在 -ActiondUser 打什麼就原樣給什麼 —— alice / .\alice / MYBOX\alice
# 都可能。但 ChangeServiceConfig 對本機帳號要的是 .\帳號：給裸名字會回
# error 1057「帳戶名稱不正確或不存在」。
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

# 帳號名字轉 SID。比對一律用 SID：同一個身分在不同地方會寫成
# NT AUTHORITY\LocalService、NT Authority\LocalService、LOCAL SERVICE，
# 而且本地化的 Windows 上內建帳號與群組的名字還會被翻譯掉。
function Get-AccountSid([string]$name) {
    $n = ($name + '').Trim()
    if (-not $n) { return $null }
    if ($n -eq 'LocalSystem') { return 'S-1-5-18' }         # SCM 自己的寫法，翻譯不了
    if ($n -like '.\*') { $n = $env:COMPUTERNAME + '\' + $n.Substring(2) }
    try {
        return (New-Object Security.Principal.NTAccount($n)
               ).Translate([Security.Principal.SecurityIdentifier]).Value
    } catch { return $null }
}

# 這個 SID 是不是 BUILTIN\Administrators 的成員（含一層巢狀群組）。
# 查不出來回 $null —— **不要把「查不到」當成「不是」**。
function Test-InAdministrators([string]$sid) {
    if (-not $sid) { return $null }
    if ($sid -eq 'S-1-5-18') { return $true }               # LocalSystem 比管理員還大
    # **用 -SID 查，不要用 -Group。** 本地化的 Windows 上群組名字是翻譯過的，
    # 而把 S-1-5-32-544 翻回名字得到的是 "BUILTIN\Administrators" ——
    # Get-LocalGroupMember 不收那個前綴，回的是「找不到群組」。於是整個檢查會
    # 安靜地退化成「查不出來」，而那正是這個檢查存在的理由（實測踩到）。
    try { $members = @(Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop) }
    catch { return $null }
    foreach ($m in $members) {
        if ($m.SID.Value -eq $sid) { return $true }
        # 成員是群組的話再展開一層。不要靠 ObjectClass 判斷它是不是群組 ——
        # 那個欄位是本地化字串（中文 Windows 上是「群組」），拿英文去比會漏掉。
        # 直接當群組展開，不是群組就會丟例外，接住就好。
        try {
            foreach ($n in @(Get-LocalGroupMember -SID $m.SID -ErrorAction Stop)) {
                if ($n.SID.Value -eq $sid) { return $true }
            }
        } catch { }
    }
    return $false
}

Say ''
Say '=== actiond 的執行身分 ==='

$actiondPassword = $null
if ($ActiondUser) {
    $actiondAccount = Resolve-Account $ActiondUser
    if ($actiondAccount -ne $ActiondUser) { Say "  帳號正規化為 $actiondAccount" }
    $cred = Get-Credential -UserName $actiondAccount -Message "actiond 服務要用的帳號（$actiondAccount）"
    if (-not $cred) { throw '取消了 —— 沒有安裝任何東西。' }
    $actiondPassword = $cred.GetNetworkCredential().Password

    # 空密碼的帳號當服務身分有兩道關卡，兩道都不是這支程式該去拆的：
    #   1. nssm 自己就拒絕：Setting "ObjectName" requires both a username and password!
    #   2. 就算繞過 nssm（sc.exe 吃得下空密碼），Windows 預設的「限制本機帳戶使用
    #      空白密碼僅限主控台登入」也會擋掉服務登入 —— 服務登入跟自動登入是不同的
    #      登入類型。要放行得改機器層級的安全性原則，對一台對外的機器不划算。
    if (-not $actiondPassword) {
        throw ("$actiondAccount 沒有設密碼，不能拿來當服務身分。" + [Environment]::NewLine +
               '  不帶 -ActiondUser 直接重跑，就會用不需要密碼的 NT AUTHORITY\LocalService。')
    }
    if ($actiondAccount -like '.\*') {
        $ok = Test-LocalAccount ($actiondAccount -replace '^\.\\', '') $actiondPassword
        if ($ok -eq $false) {
            throw ("這組帳號密碼在本機驗不過：$actiondAccount" + [Environment]::NewLine +
                   '  帳號不存在或密碼不對 —— 這兩種 Windows 回報的是同一個錯誤。' +
                   [Environment]::NewLine + '  在那台自己確認：net user ' +
                   ($actiondAccount -replace '^\.\\', ''))
        }
    }
} else {
    $actiondAccount = 'NT AUTHORITY\LocalService'
}

# 橋接要以誰的身分執行。這個值有兩個地方要用（下面設 actiond 的環境變數、
# 以及最後註冊排程工作），所以在這裡算一次就好。
$bridgeUser = $BridgeUser
if (-not $bridgeUser) {
    $cs = Get-CimInstance Win32_ComputerSystem
    if ($cs.UserName) { $bridgeUser = $cs.UserName }
}

$actiondSid = Get-AccountSid $actiondAccount
if (-not $actiondSid) {
    throw ("查不到這個帳號：$actiondAccount" + [Environment]::NewLine +
           '  本機帳號寫成 .\<帳號>，網域帳號寫成 <網域>\<帳號>。')
}
Say ('  帳號：{0}' -f $actiondAccount)
Say ('  SID ：{0}' -f $actiondSid)

$inAdmins = Test-InAdministrators $actiondSid
if ($inAdmins -eq $true) {
    Say ''
    Say '  這個身分是 BUILTIN\Administrators 的成員。'
    Say ''
    Say '  服務登入不經過 UAC 過濾，所以 actiond 會拿到完整的管理員 token ——'
    Say '  C:\Caddy\actions\ 裡的每一個腳本都會以管理員身分執行。那正是這個設計'
    Say '  要避免的事，所以停在這裡，什麼都不裝。'
    Say ''
    if ($actiondAccount -match 'LocalService|NetworkService') {
        Say '  這台機器把這個內建帳號加進了管理員群組 —— 那不是 Windows 的預設。'
        Say '  先看一眼是誰在裡面：'
        Say '      net localgroup Administrators'
        Say '  確定要移回預設（要重開機，已經在跑的服務才會換成新 token）：'
        Say ("      Remove-LocalGroupMember -Group 'Administrators' -Member '$actiondAccount'")
    } else {
        Say '  換一個不是管理員的帳號：'
        Say '      .\src\install.ps1 -ActiondUser .\<帳號>'
        Say '  或不帶 -ActiondUser 直接重跑，用 NT AUTHORITY\LocalService。'
    }
    Say ''
    throw "actiond 的執行身分是管理員（$actiondAccount）—— 沒有安裝任何東西"
}
if ($null -eq $inAdmins) {
    # 列舉不到群組。不擋安裝 —— 那會為了一個跟安全無關的理由把機器卡住 ——
    # 但一定要講清楚保證沒有成立，不要讓它看起來像通過了。
    Say '  !! 查不出這個身分在不在 Administrators 裡，所以「不是管理員」這件事沒有驗證過。'
    Say '     自己確認：net localgroup Administrators'
} else {
    Say '  不是 Administrators 的成員 —— 每一個 action 都會以這個身分執行'
}

# ---------------------------------------------------------------- 目錄
Say ''
Say '=== 目錄 ==='
foreach ($d in 'apps', 'actions', 'actiond', 'conf', 'logs') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null
}
Say "  $Dir"

# actiond 不再是管理員了，所以它要寫的地方得明著給。
# C:\ 底下新建的目錄通常會繼承到 Authenticated Users: Modify，那樣本來就夠用；
# 但那是「通常」—— 磁碟根目錄的 ACL 被收緊過的機器就不成立，而失敗的樣子很難查：
# 服務起不來，或是 log 永遠是空的。所以直接給，不要靠繼承。
#   logs\       nssm 要在這裡寫 actiond.log
#   Caddyfile   caddy-reload 成功後寫 Caddyfile.last-good，caddy-rollback 寫回來
try {
    $acl = Get-Acl $Dir
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier($actiondSid)),
        [Security.AccessControl.FileSystemRights]::Modify,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
         [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -Path $Dir -AclObject $acl
    Say ('  已授權 {0} 寫入 {1}' -f $actiondAccount, $Dir)
} catch {
    Say ('  授權寫入失敗：' + $_.Exception.Message)
    Say ('  actiond 可能寫不了 log —— 裝完檢查 ' + $Dir + '\logs\actiond.log')
}

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
Copy-Item (Join-Path $repo 'templates\actiond\*') (Join-Path $Dir 'actiond') -Force
Copy-Item (Join-Path $repo 'templates\actions\*') (Join-Path $Dir 'actions') -Force
Copy-Item (Join-Path $repo 'templates\apps\*') (Join-Path $Dir 'apps') -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'actiond\bridge') | Out-Null
Say '  actiond / actions / apps'

# 舊版的單插槽橋留下來的檔案。升級的時候要刪掉 —— 留著的話，看到 _userbridge.ps1
# 還在的人會以為那條路還通，而它已經沒有對應的排程工作了。
foreach ($stale in 'actiond\user-bridge.ps1', 'actiond\user-request.ps1',
                   'actions\_userbridge.ps1', 'actions\_asuser.ps1') {
    $p = Join-Path $Dir $stale
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue; Say "  移除舊版檔案 $stale" }
}

# ---------------------------------------------------------------- 設定
# 設定是 caddyctl 寫的，這裡只確認它在。
if (-not (Test-Path (Join-Path $Dir 'Caddyfile'))) {
    throw "$Dir 裡沒有 Caddyfile。先跑 node src\caddyctl.mjs node init（或 edge init）。"
}

# ---------------------------------------------------------------- 內容目錄
# 位置從 manifest 拿（已經是 Windows 寫法的路徑）。純 edge 的機器沒有 node 這一段，
# 就整段跳過。
$contentRoot = $null
if ($manifest -and $manifest.node) {
    $contentRoot = $manifest.node.content_root
}
if ($contentRoot) {
    Say ''
    Say '=== 內容目錄 ==='
    New-Item -ItemType Directory -Force -Path $contentRoot | Out-Null

    # 內容根目錄給一個起始頁。**它是使用者的，不是產品的。**
    #
    # 空目錄的 / 會是 Caddy 那個灰灰的檔案列表，對剛裝好的人來說沒有任何線索
    # 說明 /_ 在哪。所以給一頁短的，講清楚「這個檔是你的、可以刪」，
    # 並且指向控制面板。已存在就不覆蓋 —— 使用者改過的東西不能動。
    #
    # 樣板是 UTF-8 沒有 BOM，一定要明講編碼：PS 5.1 的 Get-Content 沒有
    # -Encoding 就用系統 ANSI 讀（這幾台是 cp950），中文會被 Big5 解成假字，
    # emoji 更直接變成 ?。寫出去照樣是合法的 UTF-8，所以事後看不出是哪裡壞的。
    # 用 ReadAllText 跟下面的 WriteAllText 對齊，不靠任何預設值。
    $index = Join-Path $contentRoot 'index.html'
    if (Test-Path $index) {
        Say ('  ' + $index + ' 已存在，保留不覆蓋')
    } else {
        $txt = [IO.File]::ReadAllText((Join-Path $repo 'templates\www\index.html'), [Text.UTF8Encoding]::new($false))
        $txt = $txt -replace '__MACHINE__', $Machine
        [IO.File]::WriteAllText($index, $txt, [Text.UTF8Encoding]::new($false))
        Say ('  ' + $index + '   （起始頁，可自由取代或刪除）')
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
# BRIDGE_USER 是 actiond 判斷「要不要過橋」的依據，空的就等於整個橋停用
# （每一支 action 都以服務帳號執行）。CADDY_DIR 讓它找得到 actiond\bridge\。
& $nssm set actiond AppEnvironmentExtra "ACTIONS_DIR=$Dir\actions" "ACTION_HOST=127.0.0.1" `
    "ACTION_PORT=$actionPort" "CADDY_DIR=$Dir" "BRIDGE_USER=$bridgeUser" "BRIDGE_TASK=caddy-bridge" | Out-Null

# 把上面決定好的身分設上去。
#
# nssm 對 LocalSystem / LocalService / NetworkService 這三個不用密碼的內建帳號
# 有特別處理，其餘帳號它會堅持要密碼
# （Setting "ObjectName" requires both a username and password!）。
#
# **設完一定要讀回來確認。** 這裡踩過：原本設完就無條件印「actiond 將以 <帳號>
# 執行」，但 nssm 其實拒絕了（空密碼）—— 訊息報的是「打算」不是「結果」，
# 使用者以為降權了，實際上還是 LOCAL SYSTEM，要等到某個 action 讀到
# systemprofile 的設定才會發現。報告一律以讀回來的實際值為準。
function Get-ActiondAccount {
    # 用 CIM 讀，不要用 nssm get —— nssm 某些版本的 get 輸出是 UTF-16，
    # 透過 cmd 捕捉會夾帶 NUL 之類的字元，還得先濾一輪才看得懂。
    try { return (Get-CimInstance Win32_Service -Filter "Name='actiond'").StartName }
    catch { return '' }
}

if ($actiondPassword) {
    & $nssm set actiond ObjectName $actiondAccount $actiondPassword | Out-Null
} else {
    & $nssm set actiond ObjectName $actiondAccount | Out-Null
}

# nssm 沒吃下去就換 sc.exe —— 它對內建的服務帳號一定收，空密碼也是合法的。
if ((Get-AccountSid (Get-ActiondAccount)) -ne $actiondSid) {
    $pw = ''
    if ($actiondPassword) { $pw = $actiondPassword }
    Invoke-Exe 'sc.exe' ("config actiond obj= `"$actiondAccount`" password= `"$pw`"") | Out-Null
}

$actual = Get-ActiondAccount
if ((Get-AccountSid $actual) -ne $actiondSid) {
    throw ("actiond 的執行身分設不上去：要的是 $actiondAccount，實際是 '$actual'。" +
           [Environment]::NewLine + '  沒有啟動任何服務。')
}
# 再查一次群組。上面那次查的是「打算用的帳號」，這次查的是「真的設上去的那個」——
# 兩者之間隔著 nssm 和 sc.exe，中間出過差錯正是這一段存在的理由。
if ((Test-InAdministrators (Get-AccountSid $actual)) -eq $true) {
    throw ("actiond 最後落在一個管理員身分上（$actual）—— 沒有啟動任何服務。")
}
Say ('  actiond 實際執行身分：{0}（非管理員）' -f $actual)

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
#
# actiond 跑在 Windows session 0，身分是最小權限的服務帳號 —— 不是管理員，也不是
# 使用者。那對安全是對的，但它有兩個使用者看得見的後果：產生的檔案 owner 不是他，
# 而且被明確設過權限的目錄（例如 /_/p/ 指到的專案目錄）寫不進去。
#
# 所以 actiond **預設把每一支 action 都交給這座橋**：一個以登入中的使用者身分執行
# 的排程工作，拿到的是互動式登入那個「過濾過的」token —— 是那個人，但不是管理員。
# 沒有人登入的時候 actiond 退回自己執行，這樣 caddy-reload / host-health 那些不需要
# 使用者的 action 在「人不在家、網站壞了」的時候仍然能用。
#
# RunLevel 是 Limited，不是 Highest。這座橋的用途是「以登入中的使用者身分執行」，
# 不是「以管理員身分執行」—— 那是兩件事，給了 Highest 就把兩件事綁在一起了。
# 而且提權會傳染：橋接跑什麼、什麼就是提權的，它再開出來的程式也是。實測過一次
# —— 用橋接開起來的 Claude Code session 整個變成管理員身分，而它開著 bypass
# permissions。副作用還不只安全：提權的行程，非提權的查詢者讀不到它的 PEB，
# 於是 claude agents --json 驗證不了它，就把它從清單裡拿掉了。
#
# 用 wscript.exe 而不是直接 powershell.exe：排程工作在使用者的互動 session 裡執行，
# powershell 會在那裡配置一個主控台，**而且是在它有機會套用 -WindowStyle Hidden
# 之前** —— 實測 10 個工作閃 10 次。wscript 完全不配置主控台（這台的 pm2 也是這樣
# 藏它的開機腳本）。
Say ''
Say '=== 使用者身分橋接 ==='

# 舊版那個單插槽的橋（一次只能跑一個請求、固定的請求／回應檔）已經被取代。
if (Get-ScheduledTask -TaskName 'caddy-user-bridge' -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName 'caddy-user-bridge' -Confirm:$false -ErrorAction SilentlyContinue
    Say '  移除舊版的 caddy-user-bridge'
}

if ($bridgeUser) {
    try {
        $act = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Dir\actiond\bridge-hidden.vbs`""
        $pri = New-ScheduledTaskPrincipal -UserId $bridgeUser -LogonType Interactive -RunLevel Limited
        # Parallel 不是 IgnoreNew：actiond 每排一個工作就觸發一次，兩個 action 同時
        # 進來的時候第二次觸發不能被丟掉，否則那個工作要等到下一次觸發才有人撿。
        $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                 -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances Parallel
        Register-ScheduledTask -TaskName 'caddy-bridge' -Action $act -Principal $pri -Settings $set -Force | Out-Null

        $svc = New-Object -ComObject 'Schedule.Service'
        $svc.Connect()
        # actiond 不是管理員，所以要明著給它「觸發這個工作」的權限。預設的 DACL
        # 只給 BA（管理員）、SY（SYSTEM）、IU（互動式使用者），而服務登入兩者都不是
        # —— 少了這條 ACE，actiond 呼叫的時候會拿到「存取被拒」，而且**工作只是
        # 安靜地沒有跑**。GRGX = 讀 + 執行：剛好夠觸發，不夠改工作的內容。
        $sd = 'D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GRGX;;;IU)(A;;GRGX;;;' + $actiondSid + ')'
        $svc.GetFolder('\').GetTask('caddy-bridge').SetSecurityDescriptor($sd, 0)

        Say "  已註冊 caddy-bridge，以 $bridgeUser 的身分執行"
        Say '  每一支 action 都會走它 —— 所以產生的檔案 owner 是那個使用者'
        Say '  沒有人登入的時候，actiond 會退回以服務帳號執行，並在輸出裡標明'
    } catch {
        Say "  註冊失敗：$($_.Exception.Message)"
        Say '  actiond 仍然可以用，但每一支 action 都會以服務帳號執行'
    }
} else {
    Say '  找不到登入中的使用者，略過註冊。'
    Say '  之後用 .\src\install.ps1 -BridgeUser <帳號> 重跑就會補上'
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
# 分角色測。edge 沒有 / 和 /_/（那是 node 的路徑），也沒有把 /_/run 掛在 Caddy
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
    foreach ($u in @('/', '/_', '/_/run')) {
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
        Say '  密碼保護的是 /_/ 底下那台機器本身；不給密碼就是內容公開、/_/* 關閉：'
        Say '    --password <密碼>             帳號自動用 <label>'
        Say '    --password <帳號>:<密碼>      要自己指定帳號就加冒號'
        Say '    --password-hash [帳號:]<雜湊> 已經有 bcrypt 雜湊就用這個'
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
