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

**一條規則：`/_/` 底下是這台機器，其餘是使用者的公開網站。**

| URL | 對應 | 密碼 | 能做什麼 |
|---|---|---|---|
| `/` | 內容根目錄 | 不用 | 目錄列表、`.md` 轉 HTML，**唯讀** |
| `/<app>/…` | 各 app | 不用 | 由 `apps\<app>.caddy` 決定 |
| `/_` | 控制面板 | 要 | 這台有哪些網址，一頁看完 |
| `/_/c/` | 家目錄裡的設定檔 | 要 | 這台裝了哪些工具 |
| `/_/run`、`/_/run/<名稱>` | actiond | 要 | 面板 / 執行 |
| `/_/p/…`、`/_/w/…` | `<槽>\projects`、`<槽>\workspaces` | 要 | 瀏覽 + WebDAV 讀寫 |
| `/_/a/…` | actions 資料夾 | 要 | 瀏覽 + WebDAV 讀寫（編輯 action 本身） |

`--static` 的機器就是把最後兩列拿掉，其餘完全一樣。所以兩種形狀的差別只有一句話：
**`/_/` 底下有沒有那幾個可寫入的掛載點。**

### 四個關鍵設計

**WebDAV 是管理員的工具，只出現在 `/_/` 底下。** 公開網站那一側根本沒有 `webdav`
directive —— 不是靠權限擋，是那個能力不存在。所以「知道某條路徑密碼的人可以改
檔案」不可能發生：能寫入的人 = 知道整個網域密碼的人 = 管理員。

公開網站因此只有三種能力：瀏覽、加密碼的瀏覽（`caddyctl auth set --path`）、
`.md` 渲染。要放會被人改的東西，放 `<槽>\projects` 或 `<槽>\workspaces`。

**在 `/_/` 底下，同一個 URL 同時是靜態站與 WebDAV。** 用 HTTP method 分流：
`GET`/`HEAD` 給 `file_server`（目錄列表、markdown 渲染），其餘方法給 `webdav`。
不必為了可寫入另開一組網址。

**`.md` 只對瀏覽器渲染。** 條件是 `Accept: text/html`。否則 WebDAV 客戶端 GET
一個 `.md` 會拿到 HTML，一存檔就把原稿蓋掉。加 `?raw=1` 可強制拿原始檔。

**產品的東西只佔用一個名字。** 面板、設定檔、掛載點全部收在 `/_` 底下，所以
`<槽>\www\panel\`、`<槽>\www\c\` 這些都還是使用者的。底線在這個專案裡一律代表
「不是使用者的東西」—— `conf\sites\_node.caddy` 也是同一個意思。

掛載點沒辦法收進 query string（例如 `/?w/main`）：WebDAV 完全是路徑導向的
（PROPFIND、`MOVE`/`COPY` 的 `Destination`、LOCK token），目錄列表產生的是相對
連結，`.md` 渲染也是拿路徑去發內部子請求。所以它們必須是真的路徑前綴。

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
判斷、`/_/*` 的授權規則）。那些應該在 repo 裡被 review、被 diff、被寫註解解釋為什麼。
整份產生會把它們變成產生器裡的字串。

所以骨架是靜態的、在 repo 裡（`templates/Caddyfile`，caddyctl 原樣複製過去）；
只有「數量不固定」的片段被產生：

    {
        import "…/conf/global.caddy"       # 產生：ACME、DNS、網域清單
    }

    (fsdav) { … 固定邏輯 … }

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
                                 └─ POST http://127.0.0.1:9001/run/caddy-reload

`actiond` **刻意不放在 Caddy 後面**，自己聽一個獨立的埠。如果它藏在 Caddy 後面，
一旦 Caddy 設定被改壞或服務沒起來，救援管道就跟著不見了。

### 信任邊界畫在 edge 上，不是畫在每一台上

**區網被當成信任範圍之內。** 這是刻意的，而且它是一個已經做過的決定：edge 到 node
是**明文 HTTP**（node 是 `auto_https off`，TLS 是 edge 的事）。接受 `https → http`
就等於宣告「區網內部不設防」——，再為個別路徑加來源限制，只是局部地嚴格，
不會改變整體的安全等級。

> 順帶澄清一個常見的誤解：把那一段改成 `https → https` **不會**讓 edge 看不到內容。
> 反向代理是「解開客戶端的 TLS → 看到明文 → 再開一條新的 TLS」。真正讓中間看不到的
> 是 TLS passthrough，但那樣 edge 就不能做 basic_auth、不能分辨 `/_/*` 要保護、
> 也不能按路徑分流 —— 跟這個產品的設計根本不相容。

所以 `/_/run` 在 node 上**區網可達**，這讓「手機也能按 action」成立：

    手機 →（HTTPS + 密碼）→ edge → HTTP → node 的 /_/run

從 node 看，那個請求來自 edge 的區網位址。把 `/_/run` 限制成只收本機，就等於把這個
功能拿掉。

**真正不可信的是網際網路那一側，所以擋在那裡**：edge 的站台**沒有密碼時不會把
`/_/*` 轉過來**（回 404）。要能從外面觸發 action，就給那個網域一組密碼 ——
那組密碼就是這條界線。

edge 自己的 actiond 則是綁 `127.0.0.1`，而且 edge 自己服務的站**沒有** `/_/run` 路由 ——
把它掛在對外網域上，等於誰都能觸發主機動作（Host header 是可以偽造的）。

### 誰能做什麼

fleet 沒有「中央管理」這回事，也不該有：

| 動作 | 誰做、在哪做 |
|---|---|
| 加一台 node | **人**，在那台上 `node init` + `install.ps1`（要管理員） |
| 把網域指過去 | **人**，在 **edge 那台**上 `edge set` |
| 加 app、發佈內容、加 action、路徑密碼 | **那台上的 AI**，寫檔 + `/_/run/caddy-reload` |

**AI 拿不到「加一台機器」的能力**，因為那需要管理員權限。裝在每台上的 `/caddy`
技能，寫的是「管理你所在的這一台」—— 但那是**分工的約定，不是技術上的圍牆**：
`/_/run` 區網可達，所以一台上的 AI 技術上打得到另一台的 `/_/run`。這跟上面那條
「區網是信任範圍」是同一個決定的兩面。

> **為什麼不用 token 保護 `/_/run`。** node 的站台是明文 HTTP（`auto_https off`，
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

第 2 項在 `@page` 之後要講得更精確一點：`@page` 的 action 會拿到請求裡的 method、
query string 和表單 body（見下一節）。**腳本本身仍然是寫死的**，變的是它收不收
輸入。所以那一項現在的完整說法是「內容寫死的 action，而收輸入的那些自己負責驗證」
—— 驗證的責任在腳本，不在 actiond，因為 actiond 不可能知道每支腳本收什麼形狀的
東西。`cc-rc.mjs` 的做法可以照抄：表單只送 session id，pid 和工作目錄一律回頭跟
`claude agents --json` 要，呼叫端說什麼就信什麼的話，那個 pid 就成了「請幫我砍掉
這個行程」的任意參數。

> **一件現在還不對的事。** actiond 是用 nssm 註冊的 Windows 服務，而**服務登入
> 不經過 UAC 過濾** —— 安裝時指定的帳號如果是管理員，actiond 拿到的就是完整的
> 管理員 token，於是每一個 action 都是以管理員身分在跑（實測：actiond 殺得掉
> 普通身分殺不掉的行程）。這跟「除了安裝之外都是普通使用者」的意圖相反。
> 要修的話是讓 actiond 不要當服務 —— 改成登入時啟動、`RunLevel Limited` 的
> 排程工作，它就是一個普通的使用者行程，而且跑在使用者的 session 1 裡。
> caddy 不動：它是這台對外的樣子，要開機就在，跟誰登入無關。

### `@page`：一個檔案 = 一個動態網頁

要收使用者輸入的時候（勾選哪幾個、填一個名字），需要的是一頁網頁，不是一個
「按了就跑」的按鈕。做法有兩條：讓 action 收宣告過的參數，或者讓 action 自己
**就是**一頁。選了後者。

理由是它更貼 actiond 本來的模型。actiond 的整個介面就是「一個檔案 = 一個網址」，
`@page` 只是把那個網址的行為換掉：method、query string 和表單 body 交給腳本，
stdout 原樣當 HTML 送出去，不 esc、不包 `<pre>`、不加 exit code 那排東西。
於是丟一支 `.mjs` 進 `actions\` 就有一頁動態網頁 —— 不用開埠、不用寫 `.caddy`
片段、不用 reload，也沒有常駐行程要顧。（代價是每次請求 spawn 一次 node，
實測 34ms；請求之間沒有共用狀態。控制台夠用，真的要做應用還是走常駐服務那條。）

如果走「宣告參數」那條，actiond 就得長出一套參數的型別與驗證語法，而每多一種
需求就要再長一點。`@page` 把那整件事留在腳本裡，actiond 只多了一個轉交的分支。

實作上有兩個地方不能省：

* **stdout 和 stderr 要分開收。** 平常那份「跑完貼出來的 log」要的是兩條合在一起、
  照時間順序的輸出；但 `@page` 是拿 stdout 當網頁送出去的，混進一行 stderr
  （PowerShell 的 `Write-Error`、node 的 warning）就會把 HTML 弄壞。
* **單飛鎖不套用在頁面上。** 一般 action 同時只准跑一個（第二個回 409），
  但那對網頁是錯的 —— 兩個 GET 不該互相 409。

### `cc-rc`：偵測不到就不要假裝偵測得到

人在外面才想起來某個 Claude Code session 沒開 `/rc`。`/_/run/cc-rc` 是補開的辦法。

問題是**沒有任何官方指令問得到「這個 session 的 Remote Control 開了沒有」**。
`claude agents --json` 給 pid、cwd、sessionId、name、status，就是沒有這一項；
設定檔裡也沒有「一律開著 RC」這種設定。官方文件裡唯一的訊號是
`CLAUDE_CODE_BRIDGE_SESSION_ID`，而它只在**那個 session 自己的子行程**裡看得到，
從外面問不到。

所以選了一個**不需要知道**的做法：把那個行程結束掉，用同一個 sessionId
`--resume` 回來，帶上 `--remote-control`。重開的一定帶著 RC，做一次跟做三次
結果一樣，誤勾到本來就開著的也只是斷線重連（會接回同一筆，手機上不會多一個）。

另一條路是把 `/rc` 打進那個視窗（需要 ccrun 之類的工具）。它保住的東西比較多，
但 `/rc` 對已經開著 RC 的 session 會跳一個選單，於是那個 session 會停在對話框上
等人按 —— 而「哪些已經開著」正是問不到的那一件事。

代價要寫在頁面上，不是藏在文件裡：重開會丟掉正在跑的那一輪、開啟時給的
`--model`／`--effort`／`--add-dir` 不會回來、輸入框裡沒送出的字也沒了。至於
「哪些已經有 RC」，頁面直接說它不知道，請使用者用手機上看不看得到來判斷 ——
那比猜一個會錯的標記好。

**只有「執行中」不給勾。** 停在對話框上的（`status: waiting`）可以勾 —— 它沒有在
做事，是在等人按，而人在外面的時候那正是最需要救的一種。不給勾的話它就永遠卡在
那裡，這一頁對它完全沒有用。

**送出之後用輪詢等，不要固定等幾秒。** 固定秒數兩邊都不對：順利的時候大約 2 秒
就好了，手機上乾等十幾秒沒有意義；不順的時候那個數字又不一定夠，於是會把
「還沒起來」講成「已經好了」。而條件其實很明確 —— 那個 `sessionId` 又出現了，
而且 pid 換了一個。等到逾時還沒回來的，就照實說它沒回來，並且指出最可能的原因：
卡在工作區信任的對話框上（那種 session 沒有輸入框，也不會有 Remote Control）。
實測 14.7 秒 → 2.5 秒。

### 清單上要放什麼，人才選得出來

第一版把官方欄位原樣列出來（pid、`interactive`、行程開始時間）。結果是六列長得
幾乎一樣，看完不知道要選哪一個 —— 那些是**機器的識別碼，不是人的辨識資訊**。

改成三件事：

1. **工作目錄**當標題，而且照 `manifest.json` 的 `node.mounts` 縮短 ——
   `D:\projects\wall-audio` 顯示成 `wall-audio`。不要寫死磁碟機，那是
   `caddyctl node init --drive` 決定的。
2. **那個對話的最後一句話**。這是唯一能讓人認出「喔，是那個」的東西。
   來源是 `~/.claude/projects/…/<sessionId>.jsonl` —— 內部檔案，所以整段是
   best-effort：找不到、讀不懂就顯示「還沒有對話」，這一頁照常運作。
   要跳過的噪音不少（`isMeta` 的 caveat、`<command-name>`、
   `<local-command-stdout>`），不跳的話六個 session 會有五個標籤一樣。

   **最後一句，不是第一句**，而且這個差別是這個欄位有沒有用的關鍵：使用者拿它
   去跟手機上的 session 核對，而在手機上點進去第一眼看到的就是最後一句話。
   顯示第一句的話，他得在手機上一路往回捲才能確認是不是同一個。
   實作上因此是從**檔尾**切一段回頭找 —— 對話紀錄可以有好幾 MB，不能整份讀。
   切點落在多位元組字元中間會壞掉第一行，而那一行本來就是被切斷的 JSON，要丟。
3. **最後活動時間**，取對話紀錄的 mtime。**不要用行程的開始時間** ——
   被這一頁重開過的 session，行程是幾秒前才起來的，對話卻可能是三天前的，
   印成「開始於 3 秒前」是在誤導。讀不到對話紀錄才退回去用行程時間，
   而且標籤要改成「這個視窗開啟於」。

pid 拿掉了。使用者不需要它，而且它在畫面上唯一的作用是把那一列變得更難讀。

### 重開之後，人要怎麼接手

這一頁是在手機上按的，但按完之後桌面上發生的事使用者看不到，而他下一次想起這件
事，是幾個小時後坐在電腦前面的時候。所以結果頁要把接手的辦法講完：

* **最簡單**：工作列上會多一個**最小化的終端機視窗**，標題是 `✳ 名字`。
  點開就是它 —— 同一個 session，手機上講過的話都在裡面。
* **想拿回自己的終端機分頁**：先在那個視窗裡 `/exit`，再到自己的分頁跑
  `claude --resume <sessionId> --remote-control <名字> --name <名字>`。
  不先結束的話會有兩個行程寫同一份對話紀錄（Claude Code 不會攔，也不會警告）。

還有一件會讓人以為壞掉的事：**原本用來啟動它的那個終端機分頁會退回命令提示字元**。
那個分頁的主人是 shell，不是 Claude Code —— 我們殺掉的是 `claude.exe`，shell 沒事，
於是看起來像「Claude Code 自己跳出去了」。這件事不先講，使用者只能自己撞到。

`claude --teleport` 也列得出這些 session（它列的正是有 Remote Control 的那些），
但它開的是**本機的一份副本**：新的 session id，之後的對話不會回到手機上，
它自己也會這樣講。要同一個 session 就用 `--resume`。

> **試過但做不到：標出「這個 session 有沒有自己的視窗」。** 那正是使用者最需要
> 知道的一件事（沒有自己的視窗 = 它住在你開的終端機分頁裡，重開等於搬家）。
> 但 `MainWindowTitle` 和 `tasklist /v` 的視窗標題**都拿不到跨 Windows session 的
> 結果** —— actiond 在 session 0，使用者的視窗在 session 1，兩個查詢都回報
> 「沒有視窗」。走橋接問得到，但那會把每次開頁面的幽靈視窗又裝回來。
> 等 actiond 搬進使用者的 session 之後，這一項就是免費的。

### 橋接是退路，不是預設路

第一版每一件事都走使用者身分的橋，理由是「actiond 可能是 LOCAL SYSTEM，那個身分
看不到使用者的東西」。那個理由沒錯，但代價使用者看得見：橋是一個**在使用者互動
session 裡執行的排程工作**，Windows 會給它一個 console —— 每開一次那一頁，
桌面上就閃過一個約 0.3 秒的黑視窗。

所以改成：**先自己問，問不到才走橋。** 撈到空清單正好就是「這個身分看不到使用者
的東西」的樣子，那時候才叫橋。代價是「真的一個 session 都沒有」的時候會白走一趟，
但那一趟的答案一樣是空的 —— 慢一點、閃一下，結論不變。

實測差別：1.2 秒且閃一個視窗 → 0.23 秒且什麼都不閃。

**開視窗那一步沒有這個選擇。** 服務跑在 Windows session 0，那裡開的視窗使用者在
桌面上看不到，所以「殺掉再 resume」非走橋不可，送出的時候還是會閃一下。那是一個
明確的、使用者剛按下去的動作，不是每次開頁面 —— 可以接受。真要連那一下都沒有，
就是把 actiond 搬進使用者的 session（見本節開頭那個提權的註記），那之後整座橋都
不需要了。

`--name` 不能省。`--remote-control` 後面那個名字不管 session 的顯示名稱，少了它
重開之後名字會變（`myproject-4b` → `myproject-1a`），於是頁面上列的
名字跟手機上看到的就對不起來，而那正是使用者用來判斷的東西。

### 壞掉了怎麼救

* `caddy-validate` 失敗時 `caddy-reload` 完全不動作。
* 就算設定檔已經被寫壞，**正在跑的 Caddy 用的是記憶體裡的設定** ——
  壞檔案本身不會讓站台掛掉，只有服務重啟才會。
* `Caddyfile.last-good` 只在 **reload 成功後**才更新，所以它永遠跑得起來。
  `caddy-rollback` 還原它。

### 只有 reload 有 caddyctl 指令，另外三個 action 故意維持 curl

`caddyctl reload`（以及每個改設定的指令都吃的 `--reload`）存在，是因為 reload 在
**每一次**改設定之後都要做 —— 它在主要流程上。

它**直接打 actiond 的埠**，不繞過 Caddy：reload 不能依賴「正要被換掉的那份
設定」。經過 Caddy 的話，這個網址能不能通取決於現在跑著的設定有沒有那條路由，
而需要 reload 的時候那份設定往往正是有問題的那一份 —— 升級改了路由、或路由被
改壞的時候，最需要它的那一刻反而叫不動。

`caddy-status` / `caddy-validate` / `caddy-rollback` **刻意不給指令**，維持
`curl.exe -X POST http://127.0.0.1:9001/run/caddy-status` 的寫法。
這不是漏掉的：**多打幾個字是刻意的摩擦**。這三個不是日常動作，寫起來就該感覺得出來
不是日常動作 —— `caddy-rollback` 尤其，它會丟掉現在這份設定，不該跟 `edge set`
一樣順手。

所以請不要「順手補齊」這三個。少的那三個工具是設計，不是待辦事項。

---

## 4.5 edge 上的網域只有三種，而且預設會服務檔案

`edge set` 要回答的只有一個問題：**這個網址背後是什麼？**

| 模式 | 內容在哪 | 能力 |
|---|---|---|
| `--ip <位址>` | 另一台 node | 公開網站 + `/_/` 底下的管理介面 |
| 預設 / `--content <目錄>` | edge 自己 | 只有 static file server |
| `--hold` | 還沒有 | 503 佔位，憑證照樣簽發 |

**為什麼 edge 自己只能做 static file server。** WebDAV 是可寫入的，`/_/run` 會執行
主機動作 —— 兩樣都只裝在 node 上。edge 是叢集裡唯一對著網際網路的機器，把這兩樣
搬上去，等於把可寫入的檔案系統和可執行的動作直接開到外網。這不是做不到，是刻意
不做：要完整功能就多一台機器，那台待在區網裡，只有 edge 連得到它。

所以 caddyctl 會**擋下** `--ip` 指到 edge 自己的 80/443。那個設定除了拿不到 node
的功能之外，還會真的壞掉：Caddy 轉給自己的 80/443，Host header 原樣傳過去，
命中的是同一個 site 區塊 —— 無限迴圈。指到自己的**別的**埠不擋，那是正當用法
（把本機的一個 app 用一個網域開出去）。

### 密碼保護的是機器，不是內容

edge 的授權只有一條規則：**保護 `/_/*`，其餘公開。**

| 路徑 | |
|---|---|
| `/` 以及底下所有東西 | 公開，唯讀 —— 那是使用者的網站 |
| `/_/*` | 那台機器本身：WebDAV 掛載點、`/_/a/`（編輯 action 的腳本）、`/_/run`（執行它們） |

所以「不給密碼」的意思很單純：**那個網域的內容要公開**。它不會順帶把機器也開出去
—— **沒有密碼的網域，`/_/*` 整段不路由**（直接 404）。那不是使用者的政策選項，
是產品的不變量。

理由在 actiond 身上：它沒有 token。`install.ps1` 只設 `ACTION_HOST=127.0.0.1`，
而 `server.mjs` 的檢查是「TOKEN 是空字串就跳過」，`ACTION_ALLOW` 也沒設
（`ipAllowed()` 第一行 `if (!ALLOW.length) return true`）。它唯一的保護是**綁在
loopback** —— 但 `reverse_proxy 127.0.0.1:9001` 送過去的請求本來就來自 loopback。
沒有密碼卻把 `/_/run` 轉過去，等於把「在那台機器上執行指令」開給全世界。

這也是為什麼公開和可寫必須是**不同的網址**：不需要密碼的可寫入 WebDAV 等於把
機器送人，所以內容根目錄的公開視圖（`/`）是唯讀的，而 WebDAV 只在 `/_/` 底下。

`edge set` 因此不需要任何「開洞」或「補洞」的旗標 —— 那條界線畫在網址上，
不是畫在旗標上。

**edge 自己服務的 serve 站是例外。** 它背後沒有「機器」那一層（不是 node，
沒有 `/_/run`），所以 `/_` 在那裡只是保留字（一律 404），而密碼保護的是內容本身。
那是唯一說得通的解釋，也保住了「我要一個只有我看得到的靜態站」這個需求。

### 路徑密碼

**為什麼不寫進 `conf\sites\<label>.caddy`。** 那個檔每次 `edge set` 都會被
**整個重寫**。密碼寫在裡面，下次改個 IP 或換個目錄就消失了 —— 而消失的是門鎖，
沒有任何錯誤訊息。這跟第 7 節記的「掛載點會安靜消失」是同一類 bug，只是後果嚴重
得多。所以 `caddyctl auth` 的規則放在 `conf\auth\<站>\`，由站台 `import` 進來：
一條路徑一個檔，`edge set` 碰不到。

`caddyctl auth` **不分 edge / node**，因為「某條路徑要另外一組密碼」跟這台機器
是什麼角色無關。差別只有要不要 `--name`：edge 上有好幾個站要指定，node 只有一個。

它加的是**加密碼的瀏覽**，不是 WebDAV —— 公開網站那一側沒有寫入能力可以解鎖。

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

**提權會傳染，而且症狀跟權限看起來無關。** 橋接的排程工作本來是用
`-RunLevel Highest` 註冊的，於是它跑的東西全是提權的，它開出來的程式也是。
第一個症狀不是「權限太大」，是**列不出來**：高完整性的行程，非提權的查詢者
讀不到它的 PEB（WMI 的 `CommandLine` 和 `ExecutablePath` 會是空的），
`claude agents --json` 因此驗證不了它，就把它從清單裡拿掉 —— 一個開得起來、
Remote Control 也連上了、但是查不到的 session。改成 `-RunLevel Limited` 之後
四個症狀一起消失。順帶一提 `Highest` 的語意是「**能提就提**」：帳號是管理員就
提權，不是就用普通權限跑，同一份程式碼在不同機器上行為不一樣，而且不會有訊息。

**`Start-Process` 一旦給了 `-WindowStyle`，就繞過「預設終端機應用程式」。**
給了（`Minimized` 或 `Normal` 都一樣）會走 ShellExecute 那條路，自己生一個獨立的
conhost 視窗；最小化的那種在工作列上是一個沒有特徵的圖示，實測的結論是**使用者
找不到**，他以為 session 不見了。不給這個參數，console 就交給使用者系統設定的
終端機 —— 在 Windows 11 預設是 Windows Terminal，於是工作列上那個圖示是他認得的。
要開一個「使用者之後會回來用」的 console，就不要替他挑視窗樣式。

**要最小化的話，開完再自己縮，不要靠 `-WindowStyle`。** 用 `EnumWindows` 找標題
結尾符合的那個視窗，然後 `ShowWindow(h, SW_MINIMIZE)`。標題比對要用「結尾符合」
——開頭那個字元是 Claude Code 的狀態符號，它會動。這樣才同時拿到兩件事：
視窗歸使用者的終端機管，而且開起來不打擾正在用電腦的人（ccrun 也是這個做法，
最小化的 session 照樣收得到注入的訊息）。

**console 視窗的擁有者是終端機，不是那支程式。** 所以 `Process.MainWindowHandle`
會是 0 而視窗確實存在（上面那個情況下，視窗屬於 `WindowsTerminal.exe`）。
要找得列舉所有頂層視窗再用 `GetWindowThreadProcessId` 反查。

**視窗是分 Windows session 的，服務看不到桌面上的視窗。** 從 session 0 查
session 1 的行程，`Get-Process` 的 `MainWindowTitle` 是空字串，`tasklist /v` 的
視窗標題欄也是「沒有視窗」—— 兩個都不會報錯，只會安靜地說那個行程沒有視窗。
所以「這個行程有沒有自己的視窗」這種問題，服務答不出來。

**`tasklist` 的輸出是在地化的。** 中文 Windows 上「沒有視窗」印的是「不適用」，
不是 `N/A`；欄位標題也全是中文。拿 `N/A` 去比對會永遠不成立，而且不會有任何錯誤 ——
每一筆都被判成有視窗。更陰險的是它在某些 console 設定下又真的印英文，
於是這個 bug 在開發機上看起來是好的。要語言中立就別解析它的文字欄位。

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

**同一個坑，PowerShell 當「讀取端」的時候也會咬。** 使用者身分的橋是 PowerShell，
它讀子行程的 stdout 一樣是用 OEM codepage 解。所以「node 印 UTF-8 的 JSON →
PowerShell 收 → 再交出來」這條路上，中文會整片變成亂碼，而且亂碼**剛好會吃掉
JSON 的引號**，於是連 `JSON.parse` 都過不了 —— 症狀看起來像資料壞掉，不像編碼問題。
辦法是**別讓 PowerShell 碰那些 bytes**：兩端各自指定 UTF-8 走檔案交換。
`_asuser.ps1` 的指令與輸出、`cc-rc.mjs` 的 `--collect` 都是為了這件事走檔案的。

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
* **路徑正規化發生在 matcher 比對之前**，所以 `/../_/run` 這類手法無法繞過
  「`/_/*` 要密碼、其餘公開」的規則（`../`、`%2e%2e`、`..%2f`、`//../`、`..;/`
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
