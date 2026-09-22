# caddy-outposts

把幾台 Windows 機器變成一個自架的小型網站叢集：對外有 HTTPS 網域，對內可以用
WebDAV 直接編輯檔案、用手機按一下就在主機上執行動作。

叢集裡有兩種角色：

```
        網際網路
            │  HTTPS + 憑證自動續期
            ▼
        ┌────────┐         ┌────────┐
        │  edge  │ ──HTTP─▶│  node  │   內容、WebDAV、執行動作
        └────────┘  區網    └────────┘
     唯一對外的機器                     可以有很多台
```

一台機器可以同時是兩種角色。

---

## 快速開始

每台機器都是同樣的兩步，差別只有第一步的指令。

**node**（放內容、跑動作的機器）：

```powershell
# 1. 普通 PowerShell
git clone <這個 repo> C:\caddy-outposts
cd C:\caddy-outposts
node src\caddyctl.mjs node init

# 2. 系統管理員 PowerShell
cd C:\caddy-outposts
.\src\install.ps1
```

**edge**（唯一對外的機器）：

```powershell
# 1. 普通 PowerShell
git clone <這個 repo> C:\caddy-outposts
cd C:\caddy-outposts
node src\caddyctl.mjs edge init --token <duckdns 的 token>

# 2. 系統管理員 PowerShell
cd C:\caddy-outposts
.\src\install.ps1

# 3. 加一個網域，指到那台 node
node src\caddyctl.mjs edge set --name myfiles --ip <node 的 IP> --password alice:秘密 --reload
```

打開 `https://myfiles.duckdns.org` 就會看到那台 node 的網站。

**第 2 步每台一輩子只跑這一次**，之後所有設定變更都不需要管理員。

---

## 目錄

- [裝一台 node](#裝一台-node)
- [裝 edge](#裝-edge)
- [加一個網域](#加一個網域)
- [密碼](#密碼)
- [網址對照](#網址對照)
- [日常操作](#日常操作)
- [用 WebDAV 編輯檔案](#用-webdav-編輯檔案)
- [更新 caddy-outposts](#更新-caddy-outposts)
- [移除（或重裝）](#移除或重裝)
- [出問題時](#出問題時)
- [指令速查](#指令速查)

---

## 裝一台 node

### 步驟 1 — 寫設定（普通 PowerShell）

```powershell
git clone <這個 repo> C:\caddy-outposts
cd C:\caddy-outposts
node src\caddyctl.mjs node init
```

沒有 `D:` 槽就 `--drive E:`；只要服務檔案、不要 WebDAV 掛載點就 `--static`。

> repo 放哪裡都可以，**但不要放進 `C:\Caddy`** —— 那是安裝目的地，移除時會整個刪掉。

### 步驟 2 — 裝服務（**系統管理員** PowerShell）

```powershell
cd C:\caddy-outposts
.\src\install.ps1
```

actiond 會被裝成以 `NT AUTHORITY\LocalService` 執行 —— 那是 Windows 給服務用的
最小權限身分，不用密碼、不用建帳號。裝完應該看到：

```
=== 自我測試 ===
  actiond :9001  HTTP 200
  /        HTTP 200
  /_       HTTP 200
  /_/run   HTTP 200
```

它做的事：下載 `caddy.exe` 與 `nssm.exe`（按角色抓對的建置）、建目錄、
**先驗證設定再裝服務**、裝 `/caddy` 技能、自我測試。

### 步驟 3 — 回到 edge，把網域指過來

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip <node 的 IP> --password alice:秘密 --reload
```

---

## 裝 edge

### 步驟 1 — 寫設定（普通 PowerShell）

```powershell
git clone <這個 repo> C:\caddy-outposts
cd C:\caddy-outposts
node src\caddyctl.mjs edge init --token <duckdns 的 token>
```

token 只輸入這一次，之後 caddyctl 會自己讀回來。

### 步驟 2 — 裝服務（**系統管理員** PowerShell）

```powershell
cd C:\caddy-outposts
.\src\install.ps1
```

還沒加網域的話，Caddy 不會綁任何埠 —— 這是正常的，加了網域才會。

### 步驟 3 — 路由器把 80 和 443 轉進來

edge 是唯一對外的機器。兩個埠都要：**80** 讓 Let's Encrypt 驗證、
**443** 才是實際的流量。

### 需要什麼

| | |
|---|---|
| 作業系統 | Windows 10 / 11 / Server |
| Node.js | caddyctl 與 action daemon 需要 |
| 管理員權限 | **只有步驟 2 需要**，每台一次 |
| duckdns 帳號 | 只有 edge 需要。免費，註冊完就有 token |

網域必須是 [duckdns.org](https://www.duckdns.org) 的，而且只要寫 **label**
（`myfiles`），不要寫完整網域（`myfiles.duckdns.org`）。

---

## 加一個網域

```powershell
# 1. 轉給另一台 node
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --password alice:秘密

# 2. edge 自己服務靜態內容（不給模式就是這個，目錄預設 D:\www\<label>）
node src\caddyctl.mjs edge set --name mysite
node src\caddyctl.mjs edge set --name docs --content C:\Web

# 3. 先佔著，之後再指派（回 503，但憑證照樣簽發與續期）
node src\caddyctl.mjs edge set --name later --hold

# 改完套用
node src\caddyctl.mjs reload
```

加 `--reload` 可以一行做完：

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --password alice:秘密 --reload
```

> ⚠ **`edge set` 是取代，不是修改。** 只帶 `--name` 重跑會把那個網域的密碼和模式
> 一起清掉。要改任何一項，就把原本的旗標整組打完。
>
> 忘記密碼也沒關係 —— bcrypt 雜湊就在 `conf\sites\<label>.caddy` 的 `basic_auth`
> 區塊裡，複製出來餵回 `--password-hash <帳號>:<雜湊>` 即可。

### 看現在有哪些

```powershell
node src\caddyctl.mjs list
```

### 移除網域

```powershell
node src\caddyctl.mjs edge remove --name myfiles --reload
```

它會刪掉那個網域的設定檔，並把它退出 `dynamic_dns`（DNS 紀錄不再更新）。

**不會動的**：duckdns.org 上的子網域（要真的退掉得去官網砍）、已簽發的憑證、
`apps\<label>\`、內容目錄，以及 `conf\auth\<label>\` 的路徑密碼。

> 最後那一項有個陷阱：**同名加回來，舊的路徑密碼會復活**。而且網域一旦移除，
> `auth remove` 就會說「這台沒有名叫 `<label>` 的網域」而拒絕動作。
> 要清乾淨就**先 `auth remove` 再 `edge remove`**，或事後手動
> `Remove-Item C:\Caddy\conf\auth\<label> -Recurse`。

---

## 密碼

```powershell
--password <密碼>                 帳號自動用 <label>
--password <帳號>:<密碼>          要自己指定帳號就加冒號
--password-hash [帳號:]<雜湊>     已經有 bcrypt 雜湊就用這個
```

可以重複，一組帳號一個旗標：

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 `
    --password alice:秘密1 --password bob:秘密2
```

只切第一個冒號，所以密碼後半含冒號沒問題（`--password alice:a:b:c` → 帳號
`alice`，密碼 `a:b:c`）。

### 密碼保護的是什麼

**一條規則：`/_/` 底下要密碼，其餘公開。**

| 路徑 | |
|---|---|
| `/` 以及底下所有東西 | 公開，唯讀 —— 那是你的網站 |
| `/_/*` | 那台機器本身：WebDAV 掛載點、編輯 action、執行動作 |

所以「不給密碼」的意思就是**那個網域的內容要公開**，不會順帶把機器也開出去 ——
沒有密碼的網域，`/_/*` 整段不路由（直接 404）。

### 某條路徑另外一組密碼

要把公開網站底下某一條路徑關起來：

```powershell
node src\caddyctl.mjs auth set    --path /reports/* --password police:123 [--name <label>]
node src\caddyctl.mjs auth list   [--name <label>]
node src\caddyctl.mjs auth remove --path /reports/* [--name <label>]
```

`--name` 在 node 上可以省（只有一個站），edge 上要指定是哪個網域。
規則存在 `conf\auth\<站>\`，`edge set` 碰不到。

它加的是**加密碼的瀏覽**，不是 WebDAV。

### 記住登入

網域有密碼時，第一次通過之後會發一個 **30 天**的 cookie，所以手機不必每次重輸。
30 天是絕對的，不會因為你一直在用而延長。

要讓**所有裝置立刻登出**：

```powershell
# 換掉 conf\sites\<label>.caddy 裡那串 sc_auth 的亂數
Select-String sc_auth C:\Caddy\conf\sites\<label>.caddy
node src\caddyctl.mjs reload
```

---

## 網址對照

| URL | 是什麼 | 密碼 |
|---|---|---|
| `/` | 你的公開網站（`<槽>\www`），唯讀 | 不用 |
| `/<app>/` | 你掛的 app | 不用 |
| `/_` | 控制面板 —— 這台有哪些網址，一頁看完 | 要 |
| `/_/c/` | 這台裝了哪些工具（家目錄裡的設定檔） | 要 |
| `/_/run` | action 面板 | 要 |
| `/_/run/<名稱>` | 執行某個 action | 要 |
| `/_/run/cc-open` | 挑一個專案（或建一個新的），開一個帶 Remote Control 的 Claude Code | 要 |
| `/_/run/cc-rc` | 幫這台上的 Claude Code session 開 Remote Control | 要 |
| `/_/p/`、`/_/w/` | `<槽>\projects`、`<槽>\workspaces` | 要 |
| `/_/a/` | actions 資料夾 | 要 |

**`/_/` 底下是這台機器本身，其餘是你的公開網站。** `--static` 的機器就是把最後
兩列拿掉，其餘完全一樣。

某一台實際的對應關係，看那台的 `C:\Caddy\conf\manifest.json`（`node.url_map`）。

內容目錄的規則是**名稱固定，只有磁碟機可以換**（`--drive E:`）：

| 網址 | 目錄 |
|---|---|
| `/` | `<槽>\www` |
| `/_/p/` | `<槽>\projects` |
| `/_/w/` | `<槽>\workspaces` |

---

## 日常操作

裝完之後所有異動都是這兩步，**不需要管理員**：

```
caddyctl 改設定（普通視窗）  →  reload
```

### 發佈內容

把檔案丟進 `<槽>\www`，網址就是 `/...`。**不用 reload** —— 內容檔案是即時的。

`.md` 在瀏覽器裡會自動渲染成 HTML，加 `?raw=1` 看原始碼。

> ⚠ **`<槽>\www` 整個是公開的**，不需要密碼就看得到。要放不公開的東西，
> 放 `<槽>\projects` 或 `<槽>\workspaces`。

### 掛一個 app

一個 app 一個檔，丟進 `C:\Caddy\apps\`：

```caddy
# C:\Caddy\apps\myapp.caddy
redir /myapp /myapp/ 308
handle_path /myapp/* {
    reverse_proxy 127.0.0.1:3000
}
```

```powershell
curl.exe -X POST http://127.0.0.1:9001/run/caddy-reload
```

路徑不要叫 `_`，其餘隨便取 —— 產品的東西全在 `/_` 底下。

### 加一個 action

一個 action 一個腳本，丟進 `C:\Caddy\actions\`，**立即生效不用 reload**。
`/_/run` 會列出全部。

> 含中文的 `.ps1` 一定要存成 **UTF-8 with BOM**，否則 PowerShell 5.1 會當成
> 系統 ANSI 讀，然後安靜地解析失敗。樣板在 `actions\_template.ps1`。

腳本開頭加 `# @page`，它就不是一個動作，而是**一頁網頁**：method、query
string 和表單 body 交給腳本，stdout 原樣當 HTML 送出去。一個檔案一個網址，
不用開埠、不用寫 `.caddy` 片段、不用 reload。`actions\cc-rc.mjs` 是現成的例子。

### 在手機上開一個新的 Claude Code session

打開 `/_/run/cc-open`：挑一個 `<槽>\projects` 底下的專案，或在文字框輸入一個名字
建一個新的，按下去這台機器就在那個目錄開一個 Claude Code，**帶著 Remote Control**
——手機上馬上看得到，直接開始講話。

- 建新專案時可以勾「同時建立 `genesis/FIATLUX.md`」，內容只有一行標題：`# 專案名稱`
- 輸入的名字剛好已經存在的話，它會先問你是不是要連到那個現有的專案，不會自己決定
- session 的名字就是專案名稱；同一個專案已經有 session 的話，新的那個會加編號
  （`myproj-2`）
- 電腦那端的視窗開在你系統設定的那個終端機裡，而且是**最小化**的：正在用電腦的人
  不會被打擾，回到電腦前從工作列點開就能接手（標題 `✳ 名字`）
- 這一頁只負責把它開起來，不會替你送出第一句話 —— 要說什麼在手機上打

> 第一次在某個目錄開 Claude Code，它本來會先問「是否信任這個資料夾」，而那種
> session 沒有輸入框、也不會有 Remote Control，手機上救不回來。這一頁會在啟動前
> 先替那個目錄記下信任，所以那個問題不會出現。萬一哪天還是出現了，頁面會直說
> session 沒起來，要有人在那台電腦前按一次 Yes。

### 忘記開 Remote Control 的時候

人在外面才想起來某個 Claude Code session 沒開 `/rc`，打開 `/_/run/cc-rc`：

它列出這台機器上所有的 session，每一列是**專案目錄、那個對話的最後一句話、最後
活動時間**——最後一句話是為了核對：在手機上點進某個 session，第一眼看到的就是
它。勾選的會**結束後用同一份對話重新開啟**，新的那個帶著 Remote Control，
手機上就看得到。同一個 session、同一份對話。

- 執行中的不給勾 —— 重開會把正在跑的那一輪丟掉。停在對話框上的可以勾，
  它沒有在做事，而且在外面的時候那正是最需要救的一種
- 開啟時給的 `--model`／`--effort`／`--add-dir` 不會跟著回來，輸入框裡沒送出的字也是
- 頁面上看不出哪些已經有 Remote Control（沒有指令問得到）。用手機上看不看得到
  來判斷就好，勾到已經有的也不會怎麼樣，就是斷線重連

### 套用設定變更

```powershell
node src\caddyctl.mjs reload
```

驗證失敗時完全不動作，而且正在跑的 Caddy 用的是記憶體裡的設定 ——
**寫壞設定不會讓站台掛掉**。

---

## 用 WebDAV 編輯檔案

`/_/p/`、`/_/w/`、`/_/a/` **同一個網址就是可讀寫的 WebDAV**。掛起來就是一台網路
磁碟機，用什麼編輯器都行。

```
在區網裡     http://<node 的 IP>/_/w/
從外面       https://<label>.duckdns.org/_/w/     （要帳號密碼）
```

> **WebDAV 是管理員的工具。** 公開網站那一側沒有寫入能力 —— 不是靠權限擋，
> 是那個能力不存在。`--static` 的機器則整台都沒有 WebDAV。

### Windows

不需要任何外掛。掛成磁碟機，然後用 VS Code 開那個資料夾：

```powershell
# 區網裡直接連 node
net use V: http://10.0.0.2/_/w/

# 從外面經過 edge
net use V: https://myfiles.duckdns.org/_/w/ /user:myfiles <密碼>

code V:\
```

`WebClient` 服務不用手動啟動，第一次連的時候會自己被觸發。

> 兩個 Windows 內建的限制，都在
> `HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`：
> `BasicAuthLevel`（預設 `1`，**HTTP + 密碼會被直接擋掉**）和
> `FileSizeLimitInBytes`（單檔約 50MB）。改了要重啟 `WebClient`。
>
> 第一項是最常見的「WebDAV 壞掉」原因，但這個架構下不會遇到：區網直連是 HTTP
> 但不需要密碼，從外面是 HTTPS。唯一會失敗的組合不會出現。

覺得內建客戶端不好用就換 **RaiDrive**、**NetDrive**（一樣掛成磁碟機）或
**WinSCP**（適合偶爾改一個檔）。

### macOS

Finder 的「前往 → 連接伺服器」（<kbd>⌘K</kbd>）內建支援：

```
https://myfiles.duckdns.org/_/w/
```

### iPhone / iPad

**內建的「檔案」App 不支援 WebDAV** —— 它的「連接伺服器」只吃 `smb://`。
要用第三方 App，而它們多半會註冊成「檔案」App 裡的一個位置。

| App | 適合 | 要注意 |
|---|---|---|
| **Koder** | 程式碼編輯器，介面清爽 | 實測可用 |
| **Owlfiles** | 檔案管理為主 | 免費版**只能建一個連線** |
| **FE File Explorer** | 檔案管理 | 付費，約 NT$150 |
| **Obsidian** | 寫筆記 | 只能建一個連線，而且只能建 `.md` |

設定時填完整網址加帳號密碼。

---

## 更新 caddy-outposts

`git pull` 之後，每台兩步：

```powershell
# 1. 重新產生設定（普通視窗）—— node 用上面那行，edge 用下面那行
node src\caddyctl.mjs node init --reload
node src\caddyctl.mjs edge init --reload

# 2. 其餘全部（系統管理員）
.\src\install.ps1
```

**兩步都要做，而且都不用帶參數** —— 現有設定會沿用，包括 edge 每個網域的密碼。
只做第 1 步的話，`actions\` 和 `actiond\` 會安靜地繼續跑舊版。

你的東西一個都不會動到：`<槽>\www`、`<槽>\projects`、`<槽>\workspaces`、
你自己寫在 `actions\` 裡的腳本、`conf\auth\` 的路徑密碼、`apps\` 底下的 app 路由。

第 2 步會重裝服務，所以有幾秒的中斷。跑完看一眼 `C:\Caddy\logs\actiond.log`
最後一行是不是「登入偵測：<你的帳號> 登入中」。

---

## 移除（或重裝）

用**系統管理員**開 PowerShell：

```powershell
.\src\uninstall.ps1                  # 拔掉全部，刪掉 C:\Caddy
.\src\uninstall.ps1 -WhatIf          # 只看會做什麼，不動手
.\src\uninstall.ps1 -KeepFiles       # 只拔註冊項目，C:\Caddy 留著
.\src\uninstall.ps1 -PurgeFirewall   # 連 Windows 自己建的殘留規則也刪
```

它會拔掉 `install.ps1` 建的那五樣：兩個服務、防火牆規則、排程工作、`/caddy` 技能、
`C:\Caddy` 目錄。

**網站內容不會被刪** —— `<槽>\www`、`<槽>\projects`、`<槽>\workspaces` 一律留著。

跑完就是一台乾淨的機器，可以重新 `caddyctl ... init` + `install.ps1`。

> **OpenClaw 的那一份技能不會被刪**（只檢查，不動手）。`openclaw skills` 沒有
> uninstall 指令，技能在它自己管理的目錄和登錄裡，硬砍只會弄壞它的狀態。
> 要清請用 `openclaw skills list` 找到位置自己處理。

> **`-PurgeFirewall` 是幹嘛的**：Windows 跳「安全性警訊」時按下「允許存取」會留下
> Query User 規則 —— TCP + UDP、該程式的**所有埠**、Private + Public，比
> `install.ps1` 開的那一兩個埠寬得多，而且綁在程式路徑上。預設不刪，因為那不是
> 這個產品建的東西。

### 卡在「檔案正由另一個程序使用」

`nssm.exe` 本身就是那兩個服務的執行檔，服務還在跑檔案就一直被鎖著：

```powershell
Stop-Service caddy, actiond -Force
sc.exe delete caddy
sc.exe delete actiond
```

順序不能反。

---

## 出問題時

```powershell
curl.exe -X POST http://127.0.0.1:9001/run/caddy-status     # 先看這個
curl.exe -X POST http://127.0.0.1:9001/run/caddy-validate   # 設定語法
curl.exe -X POST http://127.0.0.1:9001/run/caddy-rollback   # 還原上一份可用的設定
```

**一律打 actiond 自己的埠，不要繞過 Caddy。** 需要排錯的時候，現在跑著的那份
設定往往正是有問題的那一份 —— 繞過去就不會被它影響。`9001` 只聽 loopback，
所以這是本機專用的入口；從瀏覽器按按鈕走的是 `/_/run`（要密碼）。

log 在 `C:\Caddy\logs\`。

**寫壞設定不會讓站台掛掉。** `caddy-reload` 驗證失敗時完全不動作，而且正在跑的
Caddy 用的是記憶體裡的設定 —— 只有服務重啟才會吃到壞檔案。`Caddyfile.last-good`
只在 reload 成功後更新，所以它永遠跑得起來。

> **設定沒改的話，`caddy-reload` 其實什麼都不做，但還是回報成功。** Caddy 在新設定
> 跟目前完全相同時直接當成功處理。真的要強制（例如想立刻推一次 DNS 更新）：
>
> ```powershell
> C:\Caddy\caddy.exe reload --config C:\Caddy\Caddyfile --adapter caddyfile --force
> ```
>
> 順帶一提，`dynamic_dns` 在**服務啟動時就會檢查一次**，不是等 `check_interval`
> 到期，所以剛裝好、剛重啟的機器不必等。

### 從外面連不進來

依序確認：

1. `Resolve-DnsName <label>.duckdns.org -Server 8.8.8.8` —— 解析到哪個 IP
   （一定要指定 `-Server`，不然會讀到本機快取）
2. `curl.exe -s https://icanhazip.com` —— 這台的對外 IP
3. 兩個一樣嗎？不一樣才是 DNS 問題
4. **一樣但還是連不進來 → 不是 DNS。** 往 port forwarding、ISP 擋 80/443
   那邊找
5. `Get-NetTCPConnection -LocalPort 80,443 -State Listen` —— Caddy 有在聽嗎

> 在自己家裡連自己的網域常常會失敗（路由器不支援 hairpin NAT），但外面的人完全
> 正常。要確認就拿手機關掉 Wi-Fi 用行動網路試。

---

## 指令速查

```powershell
# 設定這台機器（普通視窗。更新時跑的也是這兩行的第一行）
node src\caddyctl.mjs node init [--drive E:] [--static] [--home <路徑>]
node src\caddyctl.mjs edge init --token <duckdns token>

# 裝服務（要管理員。git pull 之後再跑一次就是一次更新）
.\src\install.ps1 [-SkipSkill] [-SystemAccount] [-ActiondUser .\<帳號>]

# 網域
node src\caddyctl.mjs list
node src\caddyctl.mjs edge set --name <label> --ip <位址[:埠]> [--password …]
node src\caddyctl.mjs edge set --name <label> [--content <目錄>] [--password …]
node src\caddyctl.mjs edge set --name <label> --hold [--message <字串>]
node src\caddyctl.mjs edge remove --name <label>

# 路徑密碼
node src\caddyctl.mjs auth set    --path <路徑> --password [帳號:]<密碼> [--name <label>]
node src\caddyctl.mjs auth list   [--name <label>]
node src\caddyctl.mjs auth remove --path <路徑> [--name <label>]

# 套用
node src\caddyctl.mjs reload

# 移除（要管理員）
.\src\uninstall.ps1 [-WhatIf] [-KeepFiles] [-PurgeFirewall]

# 服務（要管理員）
Restart-Service actiond          # 換過 actiond\server.mjs 之後
Restart-Service caddy            # 幾乎用不到，改設定用 reload 就好
Get-Service caddy, actiond       # 看狀態
```

每個改設定的指令都吃 `--reload`（做完直接套用）和 `--dir <目錄>`
（產生到別的地方，用來幫還沒裝好的機器先備設定）。

完整說明：`node src\caddyctl.mjs --help`

---

## 設計

為什麼是這些取捨、以及一路上實測出來的 Caddy 與 Windows 行為，
都記在 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 這份程式是怎麼寫出來的

由人設計、決定取捨並驗收，程式與文件用 **Claude Opus 5**（Claude Code）寫成。
上線前做過一次完整的驗收：兩台 Windows 機器從空機裝起，edge 與 node 各一台，
一路測到公網 HTTPS、憑證簽發、WebDAV 讀寫與遠端執行 action。
