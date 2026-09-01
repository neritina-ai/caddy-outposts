# skill-caddy — 設計

把一組 Windows 機器變成一個小型的自架網站叢集：一台對外的 **edge**（reverse proxy，
負責 DNS、憑證、認證），數台 **node**（提供內容與 app）。每台裝完之後，在那台工作的 AI
就會有一個 `/caddy` 技能，知道怎麼掛新的 app、發佈內容、加自動化動作。

不含任何部署相關的私人資料 —— 主機名稱、IP、網域、金鑰一律放在部署端的設定檔，
不進這個 repo。

---

## 1. 核心概念

| 名詞 | 意思 |
|---|---|
| **edge** | 對外的那台。做 DNS 更新、ACME 憑證、認證，把流量轉給 node |
| **node** | 提供內容與 app 的機器 |
| **app** | 掛在某個路徑下的服務，通常是本機某個埠上的程式 |
| **action** | 可以用 HTTP 觸發的主機腳本 |
| **actiond** | 執行 action 的常駐程式 |

**edge 和 node 不是兩種產品，只是兩組設定。** 一台機器可以兩者都是
（對外轉址，同時自己也服務內容）。

---

## 2. 一台 node 裝好之後長什麼樣

| URL | 對應 | GET（瀏覽器） | 其他 method |
|---|---|---|---|
| `/` | 內容根目錄 | 首頁、目錄列表、`.md` 轉 HTML | WebDAV 讀寫 |
| `/p/…`、`/w/…` | 自訂掛載點 | 同上 | WebDAV 讀寫 |
| `/a/…` | actions 資料夾 | 目錄列表 | WebDAV 讀寫（用來編輯 action） |
| `/run`、`/run/<名稱>` | actiond | 控制面板 / 執行 | — |
| `/pub/…` | 公開目錄 | **不需要密碼**，唯讀 | 一律 405 |
| `/<app>/…` | 各 app | 由 `apps\<app>.caddy` 決定 | 同左 |

### 三個關鍵設計

**同一個 URL 同時是靜態站與 WebDAV。** 用 HTTP method 分流：`GET`/`HEAD` 給
`file_server`（目錄列表、markdown 渲染），其餘方法給 `webdav`。不需要為了可寫入
另開一組網址。

**`.md` 只對瀏覽器渲染。** 條件是 `Accept: text/html`。否則 WebDAV 客戶端 GET
一個 `.md` 會拿到 HTML，一存檔就把原稿蓋掉。加 `?raw=1` 可強制拿原始檔。

**`/pub` 是唯一不需要密碼的路徑。** 存在理由是有些客戶端不會帶認證憑證
（例如聊天軟體內嵌的 webview）。它只服務一個獨立目錄、只收 `GET`/`HEAD`、
不出目錄列表 —— 放進去的東西等於對整個網際網路公開。

---

## 3. 設定：沒有設定檔

**沒有中央的 `fleet.json`，也沒有 `secrets.json`。**

早期的版本兩個都有：一份描述整個叢集的 fleet 設定，加一份被它用 `${…}` 參照的
祕密檔，產生器讀這兩份、輸出 `out\<主機名>\`，再整包複製到那台機器。
那個做法有三個問題：

1. **每次只想改一台，卻要打開描述全部機器的檔案。** 手滑改到隔壁那台的設定，
   要到部署之後才會發現。
2. **那兩個檔不能刪。** 少了任何一個就再也產生不出 `conf\`,所以它們得長期
   活在某個人的硬碟上 —— 包括那份裝著 duckdns token 和所有密碼雜湊的。
   一個永遠不能刪的祕密檔，就是一個永遠可以被偷的祕密檔。
3. 它是**第二份真相**。機器上跑的設定才是真的，fleet.json 只是「應該長這樣」。
   兩邊會漂移。

現在的做法是把這三個問題一起消掉：**讓跑著的設定本身就是狀態。**

    C:\Caddy\conf\sites\<label>.caddy     一個網域一個檔，自給自足
    C:\Caddy\conf\global.caddy            duckdns token 在這裡（Caddy 本來就要用）
    C:\Caddy\conf\manifest.json           這台機器的非祕密描述

`caddyctl` 是對這個目錄做增量修改的工具，一次一個網域：

    caddyctl node init
    caddyctl edge init  --token <duckdns token>
    caddyctl edge set   --name myfiles --ip 10.0.0.2 --password alice:秘密
    caddyctl edge set   --name mysite
    caddyctl edge remove --name myfiles
    caddyctl list

加一個網域**只新增一個檔**，移除就是**刪掉那個檔**。每個指令只需要那一台機器的
資訊，做完沒有東西要留著。token 只輸入一次 —— 之後 caddyctl 從 `global.caddy`
把它讀回來，不會另外存第二份。

### 唯一的跨檔相依

只有一個：**`dynamic_dns` 的網域清單**（在 `global.caddy`）。少一個，那個網域就
不會更新 IP。所以每次加減網域都要重寫 `global.caddy` —— 清單直接從 `conf\sites\`
的**檔名**推出來，不必另外記在任何地方。

`conf\sites\<label>.caddy` 彼此之間**沒有**任何相依：沒有一個網域的檔案會參照
另一個網域。所以 `edge set` 永遠只動兩個檔（那個網域的檔 + `global.caddy`），
`edge remove` 也不必先檢查有沒有別人指著它。

> 曾經有過 `--alias`（「另一個網域，內容完全相同」）。它是唯一「改 A 要跟著重畫
> B」的東西，為了它得多一個 `resyncAliases`、多一種 remove 的擋阻條件、
> 多一條「別名不能串接」的規則。**省下的只是重打一次指令**，所以拿掉了。
> 要兩個網域指到同一台，就 `edge set` 兩次。

### 為什麼還是要產生，不讓人直接寫

Caddyfile 沒有迴圈。而會變動的東西剛好是「一組多筆」：N 個網域 → N 個 site 區塊，
每個網域各自有 serve / proxy / hold 的行為，`dynamic_dns` 還要列出全部網域。
`{$VAR}` 只能塞值，`import` 只能引入固定檔案，snippet 的 `{args[…]}` 一次只能一組。
**只要數量不固定就一定要產生。**

而且產生出來的東西可以被檢查：label 的字元、網域寫成完整網址、`--ip` 指到自己、
`--ip` 沒給密碼 —— 這些都在寫檔之前就擋掉了。

### 未知的旗標一律報錯

`caddyctl` 每個指令都有一張合法旗標表（`SPEC`），對不上就在**做任何事之前**停下來，
還會用編輯距離猜你想打的是哪一個：

    錯誤：不認識的旗標：
      --pasword   <- 是不是要打 --password？

理由是這個工具最不該安靜失敗的那件事：`--pasword 123` 少一個 s，被忽略的話產生出來
的是一個**沒有密碼的站**，而使用者以為自己設了密碼。位置參數同樣擋掉 ——
`edge set mysite` 少了 `--name`，忽略它就會去改到別的東西。

`install.ps1` / `uninstall.ps1` 也是同一件事，做法是 `param()` 上面加
**`[CmdletBinding()]`**。少了它，PowerShell 會把沒列到的參數安靜地丟進 `$args`
（實測過：`uninstall.ps1 -NoSuchFlag` 原本會照常執行）。加了之後就會回
「找不到符合參數名稱 'NoSuchFlag' 的參數」。

代價是這張表要跟著指令一起維護，漏列會讓合法的用法被誤擋 —— 所以每次改旗標，
把每個指令的合法組合都跑過一次。

### 動詞叫 `set` 不叫 `add`

`edge set` 對同一個 label 再下一次，是**整份取代**那個網域的檔案，不是累加也不是
合併。叫 `add` 的話，連下三次 `edge add mysite`（三組不同設定）會有三種同樣合理的
讀法：累加成複合設定、第二次報錯說已存在、或後蓋前。`set` 只有一種讀法，而那正是
實際行為。`auth set` 同理：同一條 path 再下一次是更新那條規則。

取代的代價是「少打一個旗標會安靜地掉東西」：少了 `--password` 會把一個受保護的站
變成公開的，少了 `--content` 會換到預設目錄然後整站 404。所以 `edge set` 覆蓋既有
網域時會**把每一項變動都列出來**（模式、內容目錄、轉發目標、帳號），不是只挑幾種講
—— 使用者少打的剛好是哪一個，事先不知道。密碼沒了另外再大聲說一次，因為其他變動
最多是壞掉，那一項是「還能用，但沒有門鎖」。

動詞誠實只做到一半，另一半是把後果印出來。

> `node init` 相反，它是**合併**的：沒寫的旗標沿用現有設定。因為 node 的旋鈕
> （`--drive` / `--port`）彼此正交，改一個不該被迫重述其他的。而一個網域的定義
> （模式 + 目標 + 密碼）是一個整體，合併它是沒有意義的 ——「保留舊的 `--ip`，
> 但現在也要 `--content`」不對應到任何一種設定。
> 唯一的例外是 `--static`，它是**形狀**不是值，所以也是宣告式的。

### 為什麼不整份產生

`Caddyfile` 骨架是**產品的核心邏輯**（method 分流、prefix 處理、markdown 的 Accept
判斷、`/pub` 的唯讀規則）。那些應該在 repo 裡被 review、被 diff、被寫註解解釋為什麼。
整份產生會把它們變成產生器裡的字串。

所以骨架是靜態的、在 repo 裡（`templates/Caddyfile`，caddyctl 原樣複製過去）；
只有「數量不固定」的片段被產生：

    {
        import "…/conf/global.caddy"       # 產生：ACME、DNS、網域清單
    }

    (fsdav) { … 固定邏輯 … }
    (pubro) { … }

    import "…/conf/sites/*.caddy"          # 產生：一個網域一個檔
    import "…/apps/*.caddy"                # 人／AI 手寫的 drop-in

算繪函式全部放在 `src/render.mjs`,是不碰檔案系統的純函式；`src/caddyctl.mjs`
負責命令列與讀寫磁碟。切開是為了讓算繪能單獨測 —— 實際做過的驗收是「用 caddyctl
重跑一次，跟正在生產環境跑著的設定逐位元組比對」。

### 只釘死一個路徑：`C:\Caddy`

伺服器目錄不可設定。這條規則是被 `/caddy` 技能逼出來的。

技能是裝到機器上、給那台機器上的 AI 讀的。它必須寫得出**可以直接照抄的路徑** ——
「把檔案放進 `C:\Caddy\apps\`」。如果目錄可以設定，那句話就只能寫成
「放進 `<CADDY_DIR>\apps\`」,而讀到 `<CADDY_DIR>` 的 AI 沒有任何辦法解出真實路徑。
文件裡每一個佔位符都是一次「請自己想辦法查」，而查的方法本身又需要先知道路徑。
循環定義。

所以規則是：**釘死的只有「能找到其他一切的那個點」。**

    C:\Caddy\conf\manifest.json     這台機器的事實來源

manifest 由 caddyctl 寫出，內容是那台機器上 AI 需要知道的一切：角色、內容根目錄、
公開目錄、`url_map`（哪個網址對應到哪個實體目錄，也就是哪些前綴已經被佔用）、
log 位置、actiond 的埠、以及安裝時要下載哪些外掛。

內容目錄則是**名稱固定、只有磁碟機可換**：`<槽>\www`、`<槽>\projects`、
`<槽>\workspaces`,預設 `D:`,一個 `--drive E:` 就搬完。

會留這個旋鈕是因為「這台沒有 D: 槽」是真的會發生；不讓每個目錄各自指定，
是因為那會換來四五個旗標、一堆互相矛盾的組合（內容在 F: 但掛載點在 E:），
而且文件會被打回 `<CONTENT_ROOT>` 那種寫不出具體路徑的狀態 ——
跟上面那條規則自相矛盾。要擺得更自由的人寫一個 `apps\*.caddy` 就好。

manifest 有一條額外的硬性規定：**內容必須是純 ASCII**，caddyctl 會檢查。
理由見第 7 節 —— PowerShell 5.1 讀沒有 BOM 的 UTF-8 會當成 Big5，
一個全形括號就足以讓安裝程式的 `ConvertFrom-Json` 整份失敗。

---

## 4. 部署模型：bootstrap 一次，之後這台自己管自己

每台只需要**一次**人工介入 —— 安裝 Windows 服務需要管理員權限。之後這台機器上的
設定變更都不用再提權：

    第一次（人，管理員）        caddyctl <角色> init  +  install.ps1

    之後（那台上的人或 AI）     寫檔案（apps\、內容目錄、conf\auth\）
                                 └─ POST http://127.0.0.1/run/caddy-reload

`actiond` **刻意不放在 Caddy 後面**，自己聽一個獨立的埠。如果它藏在 Caddy 後面，
一旦 Caddy 設定被改壞或服務沒起來，救援管道就跟著不見了。

### 信任邊界畫在 edge 上，不是畫在每一台上

**區網被當成信任範圍之內。** 這是刻意的，而且它是一個已經做過的決定：edge 到 node
是**明文 HTTP**（node 是 `auto_https off`，TLS 是 edge 的事）。接受 `https → http`
就等於宣告「區網內部不設防」——，再為個別路徑加來源限制，只是局部地嚴格，
不會改變整體的安全等級。

> 順帶澄清一個常見的誤解：把那一段改成 `https → https` **不會**讓 edge 看不到內容。
> 反向代理是「解開客戶端的 TLS → 看到明文 → 再開一條新的 TLS」。真正讓中間看不到的
> 是 TLS passthrough，但那樣 edge 就不能做 basic_auth、不能分辨 `/pub/*` 要放行、
> 也不能按路徑分流 —— 跟這個產品的設計根本不相容。

所以 `/run` 在 node 上**區網可達**，這讓「手機也能按 action」成立：

    手機 →（HTTPS + 密碼）→ edge → HTTP → node 的 /run

從 node 看，那個請求來自 edge 的區網位址。把 `/run` 限制成只收本機，就等於把這個
功能拿掉。

**真正不可信的是網際網路那一側，所以擋在那裡**：edge 的站台**沒有密碼時不會把
`/run` 轉過來**（回 404）。要能從外面觸發 action，就給那個網域一組密碼 ——
那組密碼就是這條界線。

edge 自己的 actiond 則是綁 `127.0.0.1`，而且 edge 的站台**沒有** `/run` 路由 ——
把它掛在對外網域上，等於誰都能觸發主機動作（Host header 是可以偽造的）。

### 誰能做什麼

fleet 沒有「中央管理」這回事，也不該有：

| 動作 | 誰做、在哪做 |
|---|---|
| 加一台 node | **人**，在那台上 `node init` + `install.ps1`（要管理員） |
| 把網域指過去 | **人**，在 **edge 那台**上 `edge set` |
| 加 app、發佈內容、加 action、路徑密碼 | **那台上的 AI**，寫檔 + `/run/caddy-reload` |

**AI 拿不到「加一台機器」的能力**，因為那需要管理員權限。裝在每台上的 `/caddy`
技能，寫的是「管理你所在的這一台」—— 但那是**分工的約定，不是技術上的圍牆**：
`/run` 區網可達，所以一台上的 AI 技術上打得到另一台的 `/run`。這跟上面那條
「區網是信任範圍」是同一個決定的兩面。

> **為什麼不用 token 保護 `/run`。** node 的站台是明文 HTTP（`auto_https off`，
> TLS 是 edge 的事），bearer token 會明著在區網上傳 —— 側錄得到、重放得了，
> 比「限制來源」更弱；而且那會多一個必須長期存在的祕密，跟第 3 節
> 「不留永遠不能刪的祕密」直接衝突。`actiond` 支援 `ACTION_TOKEN` 和
> `ACTION_ALLOW`，`install.ps1` 不設 —— 那應該是一個明確的決定，不是預設值。
> 哪天 edge → node 那一段改成加密的，這個結論就要重算。

### 為什麼這樣是安全的

`caddy-reload` 這個 action 的內容是寫死的：驗證**固定路徑**的 Caddyfile，通過才重載。
呼叫端不能指定要載入什麼設定。這跟「把 Caddy 的 admin API 開出去」完全不同 ——
admin API 的 `POST /load` 吃的是請求 body 裡的完整設定，等於任意設定注入。

所以最小權限是三件事一起做：

1. 檔案寫入權只給 `apps\` 與內容目錄，不給 `Caddyfile`
2. actiond 上只放內容寫死的 action
3. 不給 shell、不曝露 Caddy 的 admin 埠

只要對方拿得到 shell，前兩項就都失效了 —— 這三件事是一組，不能只做一部分。

### 壞掉了怎麼救

* `caddy-validate` 失敗時 `caddy-reload` 完全不動作。
* 就算設定檔已經被寫壞，**正在跑的 Caddy 用的是記憶體裡的設定** ——
  壞檔案本身不會讓站台掛掉，只有服務重啟才會。
* `Caddyfile.last-good` 只在 **reload 成功後**才更新，所以它永遠跑得起來。
  `caddy-rollback` 還原它。

### 只有 reload 有 caddyctl 指令，另外三個 action 故意維持 curl

`caddyctl reload`（以及每個改設定的指令都吃的 `--reload`）存在，是因為 reload 在
**每一次**改設定之後都要做 —— 它在主要流程上，而且那個網址的埠會因為角色而不同
（node 打 80、edge 打 9001），是最容易打錯的地方。

`caddy-status` / `caddy-validate` / `caddy-rollback` **刻意不給指令**，維持
`curl.exe -X POST http://…/run/caddy-status` 的寫法。它們有一樣的埠陷阱，所以這
不是漏掉的：**多打幾個字是刻意的摩擦**。這三個不是日常動作，寫起來就該感覺得出來
不是日常動作 —— `caddy-rollback` 尤其，它會丟掉現在這份設定，不該跟 `edge set`
一樣順手。

所以請不要「順手補齊」這三個。少的那三個工具是設計，不是待辦事項。

---

## 4.5 edge 上的網域只有三種，而且預設會服務檔案

`edge set` 要回答的只有一個問題：**這個網址背後是什麼？**

| 模式 | 內容在哪 | 能力 |
|---|---|---|
| `--ip <位址>` | 另一台 node | 完整功能（靜態站、WebDAV、`.md` 渲染、`/pub`、`/run`、app drop-in） |
| 預設 / `--content <目錄>` | edge 自己 | 只有 static file server |
| `--hold` | 還沒有 | 503 佔位，憑證照樣簽發 |

**為什麼 edge 自己只能做 static file server。** WebDAV 是可寫入的，`/run` 會執行
主機動作 —— 兩樣都只裝在 node 上。edge 是叢集裡唯一對著網際網路的機器，把這兩樣
搬上去，等於把可寫入的檔案系統和可執行的動作直接開到外網。這不是做不到，是刻意
不做：要完整功能就多一台機器，那台待在區網裡，只有 edge 連得到它。

所以 caddyctl 會**擋下** `--ip` 指到 edge 自己的 80/443。那個設定除了拿不到 node
的功能之外，還會真的壞掉：Caddy 轉給自己的 80/443，Host header 原樣傳過去，
命中的是同一個 site 區塊 —— 無限迴圈。指到自己的**別的**埠不擋，那是正當用法
（把本機的一個 app 用一個網域開出去）。

**`/run` 永遠不對匿名開放。** node 上的 actiond 沒有 token：`install.ps1` 只設
`ACTION_HOST=127.0.0.1`，而 `server.mjs` 的檢查是「TOKEN 是空字串就跳過」，
`ACTION_ALLOW` 也沒設（`ipAllowed()` 第一行 `if (!ALLOW.length) return true`）。
它唯一的保護是**綁在 loopback** —— 但 `reverse_proxy 127.0.0.1:9001` 送過去的請求
本來就來自 loopback。所以沒有密碼的站如果把 `/run` 轉過去，等於把「在那台機器上
執行指令」開給全世界。

這條和 `/pub/*` 是**對稱的產品不變量**，不是使用者的政策選項：`/pub/*` 永遠免密碼，
`/run*` 永遠不對匿名開放。實作上兩者是同一個機制（catch-all 之前的 `handle` 區塊），
但方向相反 —— 一個是「繞過認證放行」，一個是「完全不通」，所以不能共用同一個旗標。

**為什麼只有 `--ip` 沒給帳號會被擋。** 兩種模式沒密碼的後果不同一個等級：靜態站
是「網頁被看光」，而且很多站本來就要公開；`--ip` 則是把一整台 node 開到網際網路上，
而 node 有**可寫入的 WebDAV** 和**可以執行主機動作的 `/run`**。這不是假設 ——
這套系統自己就這樣裸奔過一次（見第 7 節）。所以 `--ip` 不給 `--password` 直接擋下來，
要公開得加 `--allow-anonymous` 明講。

**路徑密碼為什麼不寫進 `conf\sites\<label>.caddy`。** 那個檔每次 `edge set` 都會被
**整個重寫**。密碼寫在裡面，下次改個 IP 或換個目錄就消失了 —— 而消失的是門鎖，
沒有任何錯誤訊息。這跟第 7 節記的「掛載點會安靜消失」是同一類 bug，只是後果嚴重
得多。所以 `caddyctl auth` 的規則放在 `conf\auth\<站>\`，由站台 `import` 進來：
一條路徑一個檔，`edge set` 碰不到。

`caddyctl auth` **不分 edge / node**，因為「某條路徑要另外一組密碼」跟這台機器
是什麼角色無關。差別只有要不要 `--name`：edge 上有好幾個站要指定，node 只有一個。
`/pub/*` 不適用 —— 它的定義就是「整個目錄公開唯讀」，裡面不會再分路徑上鎖；
而一個 static 網站是有結構的，所以會。

旗標取名刻意避開 `--no-auth`：已經有一個 `--no-public`（意思是「連 `/pub/*` 都要
密碼」，方向是**收緊**），再放一個 `--no-` 開頭卻是**放開**的旗標，遲早有人看反。

**為什麼「不給模式」等於 static file server，而不是「什麼都不要」。**
使用者已經指定了一個網址，那個網址總得有東西回應。把「沒給 `--content`」解讀成
「他不想要 file server」，就會產出一個指向不存在行為的網域 —— 憑證簽好了、DNS
更新了，連進去卻什麼都沒有。所以 `--content` 的語意是**換一個目錄**，不是開關；
不給就用 `D:\www\<label>`。

一台 edge 上會有好幾個網域，所以預設是**一個網域一個子目錄**。node 不必分，
因為一台 node 只服務一個網域。

---

## 5. 尚未指派的網域：DNS 可以，憑證不行

`dynamic_dns` 只更新 DNS A 記錄，跟憑證無關。**Caddy 只會為「有 site 區塊的
hostname」申請憑證。** 所以把一個網域只放進 `dynamic_dns { domains { … } }`，
DNS 會更新但不會有憑證 —— 等哪天指派了主機、第一次有人連進來才臨時申請，
若當下 ACME 有問題就直接爆掉。

**解法**：`caddyctl edge set --name <label> --hold` 產生一個佔位 site 區塊：

    <網域> {
        respond "尚未指派主機" 503
    }

憑證正常申請與續期，訪客看到人話而不是 TLS 錯誤。指派主機時就是
`caddyctl edge set --name <同一個 label> --ip <位址>` 把那個檔換掉，
憑證是現成的，切換瞬間完成。

---

## 6. 只支援 duckdns，以及 Caddy 建置

網域限定 duckdns.org。**這是刻意的範圍限制，不是技術限制** ——
Caddy 支援幾十種 DNS 服務商，但我們只實際驗證過 duckdns。
宣稱「支援任何 DNS 商」會讓使用者以為每一種都會成功，那是把沒驗證過的東西
當成保證。要換服務商就 fork：`src/render.mjs` 頂端的 `DNS_*` 常數，
就是全部要改的地方。

因此網域只寫 **label**，caddyctl 補上 `.duckdns.org`。
寫成完整網址會被擋下來。少一個重複輸入的機會，也少一種寫錯的方式。

### 一個角色一種建置

外掛由角色決定，caddyctl 寫進 `conf/manifest.json`，安裝程式照著下載：

| 角色 | 外掛 |
|---|---|
| edge | `caddy-dns/duckdns`、`mholt/caddy-dynamicdns` |
| node | `mholt/caddy-webdav` |
| 兩者 | 三個都要 |

`caddyserver.com` 的下載 API 可以直接指定外掛（實測可用）：

    https://caddyserver.com/api/download?os=windows&arch=amd64&p=<模組路徑>&p=…

**不要讓不同機器跑不同建置**。實際踩過：純 edge 的機器沒有 webdav 外掛，
但骨架裡寫死了 `order webdav before file_server` —— `order` 對沒註冊的 directive
會直接讓 adapt 失敗。現在那一行改由 caddyctl 只在 node 才輸出到 `global.caddy`。

### 不設 ACME email

Caddy 會註冊匿名 ACME 帳號，憑證照常簽發與續期（實測設定通過）。
Let's Encrypt 早就不寄到期通知了，email 唯一剩下的用途是大規模撤銷事件的通知 ——
不值得為此多一個必填欄位。

## 7. Windows 的坑（都是實際踩到的）

**沒有「1024 以下要管理員」這回事。** 那是 Linux 的 `CAP_NET_BIND_SERVICE`。
Windows 上一般使用者就能綁 80/443。`nssm` 需要管理員是因為要操作服務控制管理員
和寫 HKLM，跟埠號無關。真正會擋人的是**保留埠範圍**（`netsh interface ipv4
show excludedportrange protocol=tcp`），Hyper-V/WinNAT 會整段預留，連管理員都綁不上。

**PowerShell 5.1 讀 `.ps1` 時，沒有 BOM 的 UTF-8 會被當成系統 ANSI。**
非 ASCII 註解裡只要有破折號之類的字，解析就會壞掉，而且是**安靜地壞掉** ——
exit code 還是 0，但後半段程式沒執行。含非 ASCII 的腳本一定要存成 **UTF-8 with BOM**。

**同一個坑也會咬 `Get-Content`。** 讀沒有 BOM 的 UTF-8 檔一樣會被當成系統 ANSI。
`conf\manifest.json` 就中過：值裡面一對全形括號，`ConvertFrom-Json` 就整份失敗，
安裝程式因此拿不到外掛清單。兩端都修：產生器保證 manifest 只寫 ASCII（會檢查），
安裝程式讀的時候明寫 `-Encoding UTF8`。

**子行程的輸出編碼要在讀取端處理。** PowerShell 5.1 在 stdout 被導向時用 OEM
codepage 輸出，`[Console]::OutputEncoding = UTF8` 對它的輸出管線無效。
actiond 的做法是收原始 bytes，先用嚴格 UTF-8 解，失敗才退回系統 OEM codepage。

**孫行程會繼承 stdout 的 pipe。** Windows 的 `CreateProcess` 是把所有可繼承的
handle 一起交給子行程的。所以 action 腳本只要用 `Start-Process` 拉起一個背景服務，
那個孫行程就會一直握著 actiond 給腳本的 stdout pipe —— 即使它自己的 stdout
早就導到別的檔案去了。腳本結束了，管線卻沒人關，Node 的 `'close'` 事件永遠不來，
HTTP 請求就卡到 timeout 為止（實測：一個啟動服務的 action 卡滿 120 秒）。
所以 actiond 是以 **`'exit'`（行程結束）**為準回應，只再留 150ms 把管線裡剩下的
輸出讀完，`'close'` 先到就走原本那條路。

---

## 8. Caddy 行為備忘（都是實測）

* **`path` matcher 大小寫不敏感**，`path_regexp` 才敏感。所以「小寫唯讀、大寫可寫」
  這種設計用 `handle` 做不出來。
* **`handle` 是依路徑精確度排序的**，不是依檔名或行號。所以 drop-in 的 `.caddy`
  檔不用擔心載入順序。
* **`uri strip_prefix` 的預設排序在 `webdav` 之前**，會把 webdav 的 `prefix` 弄壞。
  要包在 `route {}` 裡才照書寫順序執行。
* **前綴要交給 `webdav` 的 `prefix`，不能用 `handle_path` 先剝掉。**
  `handle_path` 不會動 `MOVE`/`COPY` 的 `Destination` header，
  結果在 WebDAV 客戶端裡「重新命名檔案」會 403。
* **`import` 可以寫在 global options 區塊裡**，而且 glob 指到空資料夾、
  甚至不存在的資料夾都不會出錯。
* **路徑正規化發生在 matcher 比對之前**，所以 `/pub/../x` 這類手法無法繞過
  「`/pub` 免認證、其餘要密碼」的規則（`../`、`%2e%2e`、`..%2f`、`//../`、`..;/`
  全部實測擋下）。
* **`webdav` 對目錄的 GET 一律回 405**，所以它本身不能瀏覽 —— 這就是要跟
  `file_server` 用 method 分流搭配的原因。

---

## 9. repo 結構

    skill-caddy\
      README.md               安裝步驟
      docs\DESIGN.md          這一份
      skill\SKILL.md          安裝到 ~\.claude\skills\caddy\
      src\
        caddyctl.mjs          設定這台機器 / 加減網域
        render.mjs            算繪函式（純函式，不碰檔案系統）
        install.ps1           在目標機器上跑（唯一需要管理員的一步）
        uninstall.ps1         把那一步做的事全部還原
        actiond\server.mjs    action daemon
      templates\              安裝時複製到 C:\Caddy 的骨架
        Caddyfile
        actions\ actiond\ apps\ www\
      examples\
        calculator\           純靜態 SPA
        calendar\             純靜態 SPA
        hello-service\        小服務 + apps 片段 + 啟停 action

---

## 10. 這些東西是怎麼驗的

不是靠單元測試，是靠**跟正在跑的東西比對**。

**設定算繪**：拿真實的生產環境設定當基準 —— 用 caddyctl 從零重跑一遍
（`edge init` + 五個 `edge set`），跟那台機器上正在服務流量的
`Caddyfile`、`global.caddy`、五個 `sites\*.caddy` **逐位元組比對**。
一個位元組都不能差。這比任何 assert 都嚴格，因為基準是「已知能跑的東西」。

**增量操作**：每個指令前後對整個 `conf\` 目錄做快照，檢查**動到了哪些檔案**。
`edge set` 和 `edge remove` 都只能動兩個（那個網域的檔 + `global.caddy`），
其他網域的檔案一個位元組都不能變。

**產出物**：兩種角色的設定都丟給對應建置的 `caddy validate` 跑過
（edge 的要用含 duckdns 外掛的建置，node 的要用含 webdav 的）。

**壞輸入**：完整網址當 label、大寫底線、同時給兩種 mode、`--ip` 沒給密碼、
`--ip` 指到自己、不認識的旗標、明文餵給 `--password-hash`、雜湊餵給 `--password`、
移除不存在的網域 —— 每一種都要有看得懂的錯誤訊息。

> `--password` / `--password-hash` 互相擋錯放的值，是因為兩種錯誤**都不會當場失敗**：
> 明文被寫進 `basic_auth` 會產生一個永遠登不進去的站，雜湊被再雜湊一次會產生一組
> 沒人知道原始密碼的憑證。兩者都要等到有人真的去登入才會發現。

**Windows 的坑**：第 7 節每一條都是實際踩到之後才寫進來的，不是從文件抄的。
