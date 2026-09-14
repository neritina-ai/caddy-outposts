---
name: caddy
description: 管理這台機器上的 Caddy 網站 —— 掛新的 app、發佈靜態內容、新增可用 HTTP 觸發的 action、套用設定變更。當使用者要「架一個服務／網站」「把某個 port 開出去」「發佈一份文件或 demo」「加一個可以用手機按的動作」「改完設定要生效」時使用。
---

# caddy

這台機器用 caddy-outposts 管理網站。這份技能告訴你**怎麼改**、以及**哪些東西不能碰**。

## 版面

伺服器一定在 **`C:\Caddy`**。內容目錄的名稱也是固定的，只有磁碟機代號會變 ——
預設 `D:`,沒有 D: 槽的機器會裝在別的槽：

| 網址 | 目錄 | 是什麼 |
|---|---|---|
| `/` | `<槽>\www` | **你的公開網站，唯讀，不需要密碼** |
| `/_` | — | 控制面板 |
| `/_/p/` | `<槽>\projects` | |
| `/_/w/` | `<槽>\workspaces` | |
| `/_/a/` | `C:\Caddy\actions` | 用 WebDAV 編輯 action |
| `/_/c/` | 家目錄裡的設定檔 | 這台裝了哪些工具 |
| `/_/run` | action daemon | 執行動作 |

**規則只有一條：`/_/` 底下是這台機器本身，其餘是使用者的公開網站。**
edge 只保護 `/_/*`，所以放進 `<槽>\www` 的東西等於對整個網際網路公開。

**這台是哪個槽、還有哪些網址被佔用了，看這個檔：**

```powershell
Get-Content C:\Caddy\conf\manifest.json | ConvertFrom-Json
```

裡面的 `node.url_map` 就是**已經被佔用的網址對照表**，
`node.content_root` 是內容根目錄的絕對路徑。新的 app 不要撞到那些前綴 ——
產品的東西全在 `/_` 底下，所以只要不叫 `_` 就不會撞到。
不要猜，也不要靠翻設定檔反推。

## 目錄

    C:\Caddy\                 伺服器本身，不放網頁內容
      conf\manifest.json      這台機器的事實來源      ← 先讀這個
      Caddyfile               產品提供的骨架          ← 不要編輯
      conf\                   caddyctl 產生的         ← 不要編輯
      apps\*.caddy            app 路由                ← 你在這裡新增
      actions\*.ps1           可觸發的動作            ← 你在這裡新增
      logs\

    <槽>:\www\                使用者的公開網站，對應網址 /   ← 看 manifest 的 content_root

> **這台如果是 edge**（`roles` 含 `"edge"`）：它服務的是好幾個網域，所以 app 路由
> 是一個網域一個資料夾 —— `C:\Caddy\apps\<label>\*.caddy`，實際路徑看 manifest 裡
> `edge.domains.<label>.apps_dir`。`mode` 是 `proxy` 或 `unassigned` 的網域沒有
> app 資料夾（前者的內容在被轉送的那台上，該去那台做）。

---

## 掛一個新的 app

app = 跑在本機某個埠上的服務，掛在一個路徑下面。

**1. 寫 `C:\Caddy\apps\<名稱>.caddy`：**

```
redir /myapp /myapp/ 308
handle_path /myapp/* {
	reverse_proxy 127.0.0.1:3000
}
```

**2. 套用：**

```
POST http://127.0.0.1:9001/run/caddy-reload
```

（有 caddyctl 可用的話，`node <caddy-outposts>\src\caddyctl.mjs reload` 一樣，
而且不必記這台是哪個埠。）

網址就是 `http://<這台>/myapp`。刪掉那個檔再 reload 就移除。

不用改 `Caddyfile`，不用管檔案順序 —— Caddy 是依**路徑精確度**排序 `handle`，
不是依檔名或行號，所以 `/myapp/deep/*` 一定排在 `/myapp/*` 前面。

**`redir /myapp /myapp/ 308` 那一行不要省。** 少了尾斜線，頁面裡的相對路徑
（`api/x`）會解析成 `/api/x` 而不是 `/myapp/api/x`。這種壞法很難查，
因為首頁看起來是好的。

**app 要能在子路徑下運作。** `handle_path` 會把前綴剝掉，所以服務自己看到的路徑
是 `/`。如果那個服務寫死了以 `/` 為根（絕對路徑的 `/static/...`、`/api/...`），
掛在 `/myapp` 底下會壞掉。要嘛讓它支援 base path，要嘛給它自己的埠再由使用者
決定怎麼對外。

**服務只綁 `127.0.0.1`，不要綁 `0.0.0.0`。** TLS、認證、log 都在 Caddy 這一層做，
app 不必自己重做一遍，也不該讓人繞過。

---

## 發佈靜態內容

**要密碼保護的**（大多數情況）：放進內容根目錄，馬上就能看，不用 reload。

    D:\www\notes\index.html   ->   /notes/

（`D:` 是預設值；這台實際是哪個槽看 manifest 的 `node.content_root`。）

`.md` 檔在瀏覽器裡會自動渲染成 HTML；加 `?raw=1` 看原始碼。

**內容根目錄整個是公開的。** edge 只保護 `/_/*`，所以放進 `<槽>\www` 的任何東西
都不需要密碼就看得到 —— 那就是使用者的公開網站。

> ⚠ **不要把祕密放進內容根目錄。** 要放不公開的東西，放 `<槽>\projects` 或
> `<槽>\workspaces`（網址在 `/_/p/`、`/_/w/`，在密碼後面）。
> 要把公開網站底下某一條路徑關起來，用 `caddyctl auth set --path`。


---

## 某個目錄要另外一組密碼

例如整個網站是公開的，但底下有一個目錄只給特定的人看。

**用工具，不要自己寫 `.caddy` 檔**：

    node D:\projects\caddy-outposts\src\caddyctl.mjs auth set --path /reports/* --password police:123
    node D:\projects\caddy-outposts\src\caddyctl.mjs auth list
    node D:\projects\caddy-outposts\src\caddyctl.mjs auth remove --path /reports/*

（caddyctl 的位置看 manifest 沒有寫 —— 它在使用者放 repo 的地方，
問使用者，或找 `caddyctl.mjs`。）

`--password` 的格式是 `[帳號:]<密碼>`：沒有冒號就用這個站的名字當帳號。
瀏覽器會問帳號和密碼兩格 —— HTTP Basic Auth 的帳號是協定的一部分，拿不掉。

改完要套用 —— **加 `--reload` 就順便做掉了**：

    node D:\projects\caddy-outposts\src\caddyctl.mjs auth set --path /reports/* --password police:123 --reload

**這台是 edge 的話要加 `--name <網域 label>`**，因為 edge 上有好幾個站。
node 只有一個站，可以省。

規則存在 `C:\Caddy\conf\auth\<站>\`，一條路徑一個檔。**不要手動編輯那些檔**，
也不要把密碼寫進 `C:\Caddy\conf\sites\*.caddy` —— 那些檔案由 caddyctl 產生，
下次執行會被整個覆蓋，寫進去的密碼會安靜消失。

> 這台如果整站已經有密碼，再加路徑密碼會變成「兩組都要過」，不是「改用這一組」。
> 想讓某個區域用不同的密碼，比較乾淨的做法是請使用者另開一個網域。

---

## 新增一個 action

action = 可以用 HTTP 觸發的主機腳本。使用者可以在瀏覽器面板上按，也能用手機書籤。

**寫 `C:\Caddy\actions\<名稱>.ps1`：**

```powershell
# @title   重啟我的服務
# @desc    停掉再拉起來
# @group   myapp
# @confirm

Restart-Service myservice
"done"
exit 0
```

丟進去**立即生效，不用 reload**。`GET /_/run` 會列出全部。

### 四條規則

1. **會造成破壞或不可逆的一定要加 `@confirm`。** 否則瀏覽器預抓、聊天軟體展開
   連結預覽、Wi-Fi 入口偵測都可能把它觸發掉。加了之後，用 GET 開網址只會出確認頁，
   真正執行要送 POST。

2. **含非 ASCII 字元的 `.ps1` 必須存成 UTF-8 with BOM。** Windows PowerShell 5.1
   讀沒有 BOM 的 UTF-8 會當成系統 ANSI，中文註解裡的破折號之類會讓腳本
   **安靜地解析失敗** —— exit code 還是 0，但後半段根本沒執行。

3. **底線開頭的檔案不會被列成 action**，可以拿來放範本或共用函式。

4. **actiond 會自動以「登入中的使用者」身分執行你的 action。** 它自己跑在
   Windows session 0，身分是 `NT AUTHORITY\LocalService` —— 不是管理員，也不是你。
   但它**預設把每一支 action 都交給使用者身分的橋**，所以你的腳本實際上是以那個
   使用者、在他的互動 session 裡跑的：工具找得到（`%APPDATA%\npm` 那些）、profile
   是對的、**產生的檔案 owner 就是那個使用者**、寫得進他的專案目錄。

   你什麼都不用做，這是預設行為。

   **沒有人登入的時候**，actiond 退回自己執行（服務帳號），並在輸出上標一句
   「某某尚未登入，這個結果可能不完整」。這是刻意的：`caddy-reload`、
   `caddy-rollback`、`caddy-validate`、`caddy-status`、`host-health` 都不需要使用者，
   而「人不在家、網站壞了」正是最需要它們的時候。

   **你的 action 沒有使用者就沒有意義的話，加這一行：**

   ```powershell
   # @only-when-logged-on
   ```

   那樣沒人登入時 actiond 會**直接回錯誤，不執行**，並且告訴使用者可以去登入或
   重新開機（設了自動登入的機器，重開就會自己登入）。什麼時候該加：

   * 要開使用者看得見的視窗（服務開的視窗在 session 0，他看不到）
   * 要讀他的設定或憑證（`~/.claude`、瀏覽器、SSH key）
   * 要用只裝在使用者層級的工具
   * **要寫進只有他有權限的目錄**

   為什麼寧可擋掉也不要跑：那些 action 在服務身分底下不會報錯，會回一個**看起來
   成功的空答案** —— 使用者分不出「真的沒東西」和「我看不到你的東西」。

   代價：橋需要那個使用者處於登入狀態。它不會閃視窗（用 `wscript.exe` 啟動，
   完全不配置主控台），每支 action 多約 0.4 秒。

### 一頁網頁：`@page`

腳本開頭加 `# @page`，它就不是一個動作，而是一頁網頁 —— 需要「勾選」「填一個
名字」這種**要收使用者輸入**的東西時用它。

| | 一般的 action | `@page` |
|---|---|---|
| 面板上 | 「執行」按鈕（POST） | 「開啟」連結（GET） |
| 腳本拿到什麼 | 什麼都沒有 | `ACTION_METHOD`、`ACTION_QUERY`、`ACTION_SELF`，表單 body 從 stdin |
| 輸出怎麼處理 | esc 進 `<pre>`，加上 exit code | **原樣當 HTML 送出去** |

`ACTION_SELF` 是這一頁自己的網址，拿它組 `<form action>` —— 不要寫死
`/_/run/…`，直接打 actiond 的埠時前綴是 `/run/…`，寫死會有一邊 404。

**輸入的驗證是腳本自己的責任。** actiond 只負責轉交，它不知道那支腳本收什麼形狀
的東西。收到的一律當成不可信的：只收自己認得的欄位、比對格式，而且**不要相信
呼叫端送來的其他值** —— `cc-rc.mjs` 的表單只送 session id，pid 和工作目錄一律
回頭跟 `claude agents --json` 要，否則那個 pid 就成了「請幫我砍掉這個行程」的
任意參數。

例子看 `actions\cc-rc.mjs`（一張勾選清單）和 `actions\cc-open.mjs`（挑一個現有的
目錄，或輸入一個名字建新的）。`cc-open` 的兩種輸入示範了同一條規則的兩面：
**要拿去建目錄的名字**嚴格檢查字元，**從清單上挑的名字**則必須對得上剛剛從磁碟
讀出來的那一筆，而且真正拿去組路徑的是磁碟上那個名字，不是表單送來的字串。

### 用 action 啟動背景服務

可以，`Start-Process` 就好，HTTP 請求不會被卡住（actiond 是以「腳本行程結束」
為準回應的，不是等管線關閉 —— 因為 Windows 的子行程會繼承 stdout handle，
等管線就會卡到 timeout）。

要注意的是**別只靠 pid 檔判斷有沒有在跑**：機器重開、行程自己掛掉，pid 檔都還會
留著，而且 Windows 會回收 PID 再配給別的程式。要再確認那個 PID 真的是你的程式：

```powershell
$p = Get-Process -Id $id -ErrorAction SilentlyContinue
if ($p -and $p.ProcessName -eq 'node') { <# 真的在跑 #> }
```

要開機自動啟動、掛掉自動重啟的話，別用 action —— 用 `nssm` 註冊成 Windows 服務
（`C:\Caddy\nssm.exe`，caddy 和 actiond 自己就是這樣裝的），action 只負責啟停。

---

## 套用設定變更

| 動作 | 需要 reload？ |
|---|---|
| 內容檔案（`<槽>\www` 底下的東西） | 不用 |
| 新增／修改 action | 不用 |
| 新增／修改／刪除 `C:\Caddy\apps\*.caddy` | **要** |

```
POST /_/run/caddy-validate    只檢查語法，不套用
POST /_/run/caddy-reload      先 validate，通過才套用（優雅重載，不斷線）
POST /_/run/caddy-rollback    還原上一份可用的設定
POST /_/run/caddy-status      版本、服務狀態、是否有未套用的變更
```

**用 caddyctl 的話更簡單 —— 改設定的指令加 `--reload` 就順便套用了：**

```powershell
node <caddy-outposts>\src\caddyctl.mjs auth set --path /reports/* --password police:123 --reload
```

改好幾個地方就只在**最後一個**指令加 `--reload`。不確定還要改幾次就都不加，
最後單獨跑：

```powershell
node <caddy-outposts>\src\caddyctl.mjs reload
```

> **叫 action 一律直接打 actiond 的埠**（`http://127.0.0.1:9001/run/...`），
> 不要繞過 Caddy。經過 Caddy 的話，能不能通取決於現在跑著的那份設定 ——
> 而需要 reload 的時候，那份設定往往正是有問題的那一份。
>
> 從瀏覽器按按鈕是另一回事，那是 `/_/run`（要密碼）。

**你負責的是這一台。** 別台上的設定請使用者去那台處理，或交給那台上的 AI ——
需要別台配合的事（例如把一個網域指到這台）不是你的工作。

> 技術上 `/_/run` 在區網內是打得到的（那讓「手機經過 edge 按 action」成立），
> 但那不是給你跨機器操作用的。改別台的設定而不讓那台上的人知道，
> 是製造事故的好方法。

**改完設定一定要先 validate。** `caddy-reload` 本身會先驗證，validate 失敗時
完全不動作 —— 而且就算檔案已經寫壞，正在跑的 Caddy 用的是記憶體裡的舊設定，
站台不會掛掉。所以寫壞是救得回來的。

### 更新 caddy-outposts 之後要重跑一次

`C:\Caddy\conf\` 底下是**產生出來的快照**。`git pull` 拿到新版之後那些檔案不會
自己跟著變，也不會有任何錯誤訊息 —— 舊版的行為會安靜地繼續跑。更新完就重跑：

```powershell
node <caddy-outposts>\src\caddyctl.mjs node init --reload
```

沒帶的旗標沿用現有設定，所以重跑是安全的。這台原本是 static 的話，記得把
`--static` 一起帶上，否則會變回完整功能。

**但只跑 `node init` 是不夠的。** 它只管 `Caddyfile` 和 `conf\` —— 不碰
`actions\` 也不碰 `actiond\server.mjs`，那兩塊會安靜地繼續跑舊版。要更新那些
得再跑一次 `install.ps1`，而**那要管理員，你不是**：

```powershell
# 請使用者用系統管理員 PowerShell 執行
<caddy-outposts>\src\install.ps1
```

它會重新複製 `actions\`、`actiond\`、`apps\`，重設 ACL、防火牆、使用者身分橋接，
並重裝兩個服務（等於重啟，有幾秒中斷）。使用者自己寫的 action 不會被動到。

edge 那台又是另一回事（`edge set` 是取代，每個網域要重打完整指令，
**漏掉 `--password-hash` 會把那個網域的密碼清掉**），但那是 edge 上的人的事，
不是你的。

---

## 不要做的事

* **不要編輯 `C:\Caddy\Caddyfile` 或 `C:\Caddy\conf\`。** 前者是產品的骨架，
  後者是 `caddyctl` 產生的 —— 手動改了會在下次執行時被蓋掉。
  要改的話用 caddy-outposts 的 CLI（`node init` 可以重跑，沒寫的旗標沿用現有設定）：

  ```powershell
  node <caddy-outposts>\src\caddyctl.mjs node init --port 9500
  node <caddy-outposts>\src\caddyctl.mjs reload
  ```

  node 能調的只有 `--drive`（整組內容目錄換一個槽）和 `--port`（actiond 的埠）——
  目錄名稱是固定的。edge 的網域是 `caddyctl edge set / edge remove`。

  **想把某個別的目錄開出來，不要動這些** —— 寫一個 `apps\*.caddy` 就好，
  那是設計上留給你的做法。
* **不要改 `C:\Caddy` 這個路徑。** 整套系統就靠它當固定點，包括這份技能。
* **不要把 Caddy 的 admin 端點（2019）綁到 loopback 以外。** 它沒有任何認證，
  誰連得到誰就能叫 Caddy 載入任意設定。
* **不要把 actiond 的埠（預設 9001）開到 loopback 以外**，除非同時設好
  `ACTION_TOKEN` 與 `ACTION_ALLOW`。
* **不要在 reverse proxy 上改 `Host` header。** WebDAV 的 `MOVE`／`COPY` 會拿
  `Destination` 的 host 去比對後端看到的 `r.Host`，改了就 502 ——
  等於把「重新命名檔案」關掉。
* **不要把祕密放進內容根目錄 —— 那整個是公開的。**

---

## 除錯

```
POST /_/run/caddy-status                    先看這個
POST /_/run/caddy-validate                  設定語法有沒有問題
C:\Caddy\logs\access.log                  誰打了什麼
C:\Caddy\logs\actiond.log                 action daemon 的問題
C:\Caddy\logs\caddy.log                   Caddy 服務本身的問題
```

（log 位置以 manifest 的 `log_dir` 為準，預設就是 `C:\Caddy\logs`。）

**404 但檔案明明在**：路徑撞到 `url_map` 裡的東西了，或 app 的 `.caddy` 檔還沒
reload。

**502**：Caddy 還在，只是後面那個服務沒起來 —— 去看那個 app 自己的 log。

**WebDAV 客戶端可以讀不能改名**：中間有人改了 `Host` header。

**`.md` 在編輯器裡變成 HTML**：那個客戶端送了 `Accept: text/html`。
用 `?raw=1`，或改用會送 `Accept: */*` 的客戶端。

**action 回 exit 0 但沒有輸出**：那個 `.ps1` 八成是沒有 BOM 的 UTF-8，
中文把解析弄壞了。存成 UTF-8 with BOM。
