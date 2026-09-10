# skill-caddy

把一組 Windows 機器變成一個小型的自架網站叢集，並且讓在那些機器上工作的 AI
知道怎麼管理它。

* 一台 **edge** —— 對外的 reverse proxy，負責 DNS、憑證、認證
* 數台 **node** —— 提供內容與 app

每台裝完之後：

* 同一個網址同時是**可瀏覽的靜態站**與**可讀寫的 WebDAV**（用 HTTP method 分流）
* `.md` 在瀏覽器裡自動渲染成 HTML，WebDAV 客戶端拿到的仍是原始檔
* 掛一個新 app = 丟一個 `.caddy` 檔 + 重載，不用改主設定
* 主機上的動作（重啟服務、查狀態…）可以用 HTTP 觸發，手機也能按
* 裝一個 `/caddy` 技能，讓那台機器上的 AI 知道以上這些怎麼做

---

## 沒有設定檔

這一點是刻意的，也是整個工具的形狀。

**沒有中央的 `fleet.json`，也沒有 `secrets.json`。** 你不必維護一份描述整個叢集的
檔案，也沒有一份長期躺在硬碟上的密碼檔要保護。

狀態就是**跑著的設定本身**：

```
C:\Caddy\conf\sites\<label>.caddy     一個網域一個檔，自給自足
C:\Caddy\conf\global.caddy            duckdns token 在這裡（Caddy 本來就要用）
C:\Caddy\conf\manifest.json           這台機器的非祕密描述
C:\Caddy\conf\_panel.html            控制面板（/panel），caddyctl 產生
C:\Caddy\conf\_configs.html          /c/ 的索引，caddyctl 產生
```

所以每個指令只需要**一台機器的資訊**，做完就沒有東西要留著：

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --password alice:秘密
node src\caddyctl.mjs edge set --name mysite
node src\caddyctl.mjs edge remove --name myfiles
```

加一個網域只會**新增一個檔**，移除就是**刪掉那個檔** —— 不會碰到其他網域的設定，
也不必回頭去看別台機器的資料。

> 唯一跨網域的東西是 `global.caddy` 裡 `dynamic_dns` 的網域清單（少一個，那個網域
> 就不會更新 IP）。它是從 `conf\sites\` 的**檔名**推出來的，所以也不必另外記在哪裡。

---

## 只支援 duckdns

網域必須是 [duckdns.org](https://www.duckdns.org) 的（免費）。

這是刻意的限制，不是技術限制。Caddy 支援幾十種 DNS 服務商，但**我們只實際驗證過
duckdns**。寫成「支援任何 DNS 商」會讓人以為每一種都會成功，那不誠實。
需要別的服務商就 fork 去改 —— `src/render.mjs` 最上面那幾個常數，
就是全部要改的地方。

設定裡的網域只寫 **label**，不寫完整網址：`myfiles`,不是 `myfiles.duckdns.org`。
寫成完整網址會被擋下來並告訴你只要寫 label。

---

## 只有一個固定路徑

**`C:\Caddy`。** 伺服器本身一定裝在這裡，不能改。

理由跟上一節是同一種：這套東西會在每台機器上裝一個 `/caddy` 技能，讓那台機器上的
AI 知道怎麼管理站台。而技能文件必須寫得出**可以直接照抄的路徑**。如果 caddy 目錄
可以自己訂，文件就只能寫成 `<CADDY_DIR>\apps\`，而讀到 `<CADDY_DIR>` 的 AI 是解不
出真實路徑的 —— 那份技能等於是廢的。

所以整套系統只釘死**一個**點，而且釘死的是「能找到其他一切的那個點」：

```
C:\Caddy\conf\manifest.json      這台機器的事實來源
```

網站內容放哪、log 在哪、actiond 聽哪個埠、哪些網址已經被佔用，全都寫在裡面。

至於內容目錄，規則是：**名稱固定，只有磁碟機可以換。**

| 網址 | 目錄 |
|---|---|
| `/` | `<槽>\www` |
| `/pub/` | `<槽>\www\public` |
| `/p/` | `<槽>\projects` |
| `/w/` | `<槽>\workspaces` |

預設是 `D:`,沒有 D: 槽就 `--drive E:`。就這一個旋鈕。

讓每個目錄各自指定聽起來比較彈性，代價是四五個旗標、一堆互相矛盾的組合，
而且文件裡再也寫不出具體路徑（又變回 `<CONTENT_ROOT>` 那種東西）。
要擺得更自由，寫一個 `apps\*.caddy` 掛自己的目錄就好 —— 那條路一直都在。

嫌這些規定難用就 fork —— `src/render.mjs` 和 `src/install.ps1`
最上面各有一個常數。

---

## 需要什麼

| | |
|---|---|
| 作業系統 | Windows 10 / 11 / Server |
| Node.js | caddyctl 與 action daemon 需要 |
| 管理員權限 | **只有安裝服務那一步需要**，每台一次 |
| duckdns 帳號 | edge 需要。免費，註冊完就有 token |

`caddy.exe` 和 `nssm.exe` 安裝程式會自己下載，而且會**按角色下載對的建置**：

| 角色 | 外掛 |
|---|---|
| edge | `caddy-dns/duckdns` + `mholt/caddy-dynamicdns` |
| node | `mholt/caddy-webdav` |
| 兩者都是 | 三個都要 |

這是 caddyctl 寫在 `conf\manifest.json` 裡的，安裝程式照著抓 —— 你不用自己選。

### `/caddy` 技能裝到哪

安裝程式會把技能裝給**這台機器上找得到的每一種 AI 工具**：

| 工具 | 裝到哪 | 沒裝這個工具的話 |
|---|---|---|
| Claude Code | `~\.claude\skills\caddy`（直接複製） | 一律會裝 |
| OpenClaw | `openclaw skills install <repo>\skill --as caddy` | 偵測不到 `openclaw` 就跳過 |

不想裝技能就 `.\src\install.ps1 -SkipSkill`。

> OpenClaw 通常裝在使用者層級的 npm 目錄（`%APPDATA%\npm`）。如果你提權用的是
> **另一個**管理員帳號，`openclaw` 就不在 PATH 上 —— 安裝程式會跳過並把指令印出來，
> 你用自己的帳號補跑一次就好。

---

## 裝 edge

**先裝這一台。** 網域、憑證、認證都在 edge 上 —— node 要等 edge 把網域指過來，
才會有人連得到它。

裝一台機器是**兩步，而且要開兩個不同權限的 PowerShell 視窗**：

| | 做什麼 | 要什麼權限 |
|---|---|---|
| 第一步 `caddyctl edge init` | 寫設定檔到 `C:\Caddy\conf\` | **一般使用者**就好 |
| 第二步 `install.ps1` | 下載執行檔、建目錄、**裝 Windows 服務** | **要系統管理員** |

順序不能反，也不要想用一個視窗跑完 —— 第二步一定要是提權過的視窗。

> **為什麼是「先寫設定，再裝服務」而不是反過來？** `install.ps1` 要靠第一步寫出來的
> `conf\manifest.json` 才知道這台是什麼角色、該下載哪個 caddy 建置（edge 要
> duckdns + dynamicdns，node 要 webdav）。角色只有這一個來源，就不會發生
> 「裝了 edge 的建置卻設定成 node」這種對不上的情況。
>
> 而且第一步寫的設定**不會懸在那裡** —— `install.ps1` 會先 `caddy validate`
> 再啟動服務，所以它是被服務啟動時套用的。整套系統其實只有一個模式：
> **寫設定 → 先驗證 → 才生效**；差別只在第一次是「啟動服務」讓它生效，
> 之後都是「reload」讓它生效。

### 第一步：寫設定（一般使用者）

在那台機器上開一個**普通的** PowerShell：

```powershell
git clone <這個 repo> C:\skill-caddy
cd C:\skill-caddy

node src\caddyctl.mjs edge init --token <duckdns 的 token>
```

放哪裡都可以，**但不要放進 `C:\Caddy`** —— 那是安裝目的地，移除時會整個刪掉。

token 只輸入這一次。之後 caddyctl 會從 `conf\global.caddy` 把它讀回來
（Caddy 本來就要用它），不會另外存第二份。

會看到：

```
edge 設定好了 -> C:\Caddy

這台還沒裝服務。接下來用「系統管理員」開 PowerShell：
    .\src\install.ps1
  它會下載 caddy.exe、裝服務，並用你剛寫的這份設定啟動。
```

caddyctl 每個指令結尾都會講下一步是什麼，而且會看情況：還沒裝服務就叫你去裝，
裝好了就給你 reload 的指令，`--dir` 產到暫存目錄就叫你複製過去。

### 第二步：裝服務（要系統管理員）

**另外開一個「以系統管理員身分執行」的 PowerShell**,`cd` 到同一個目錄：

```powershell
cd C:\skill-caddy
.\src\install.ps1
```

> 沒提權的話它會直接停下來說要管理員 —— 不會裝到一半才失敗。

它會下載 `caddy.exe` 與 `nssm.exe`、建目錄、放樣板、**先驗證再安裝服務**、
註冊使用者身分橋接、安裝 `/caddy` 技能，最後自我測試。

> 為什麼順序不能反：`install.ps1` 要靠第一步寫出來的 `conf\manifest.json`
> 才知道這台是什麼角色、該下載哪個建置（edge 要 duckdns + dynamicdns）。

過程中會問 actiond 要用哪個帳號跑。想跳過就按取消（會用 LOCAL SYSTEM），
或加 `-SystemAccount` 一開始就不問。

> 帳號選擇不是權限問題，是 **profile** 問題：如果你的 action 會用到裝在
> 使用者層級的工具（`%APPDATA%` 底下的 npm 全域套件、使用者自己的排程工作），
> 用 LOCAL SYSTEM 跑會讀到 systemprofile 的設定、操作到錯的東西。
> 不想存密碼的話，可以留 LOCAL SYSTEM，用 `_userbridge.ps1` 把那些指令
> 交給橋接執行（見 `skill/SKILL.md`）。

裝完應該看到：

```
=== 自我測試 ===
  actiond :9001  HTTP 200
  還沒有任何網域，所以 Caddy 還沒有在聽任何埠 —— 這是正常的。

  接著加網域。一個網域只要決定「背後是什麼」，三選一：
    node src\caddyctl.mjs edge set --name <label>              這台自己服務靜態內容
    node src\caddyctl.mjs edge set --name <label> --ip <位址>  轉給另一台 node（完整功能）
    node src\caddyctl.mjs edge set --name <label> --hold       先佔著，之後再指派主機

  然後套用：
    node src\caddyctl.mjs reload
```

> **「還沒有在聽任何埠」不是壞掉。** 一個網域都沒有 = 一個 site 區塊都沒有 =
> Caddy 沒有東西可以綁。加了第一個網域並 reload 之後，80 和 443 就會起來。

### 加網域（一般使用者）

**管理員的部分到此為止。`install.ps1` 每台一輩子只跑這一次。**
之後所有的異動 —— 加網域、改密碼、換 IP、移除網域 —— 都是這兩步：

```
caddyctl 改設定（普通視窗）  →  caddy-reload（HTTP 打一下）
```

| 你要做什麼 | 用什麼 |
|---|---|
| 第一次把這台變成 edge / node | `install.ps1`（**要管理員，只有這一次**） |
| 加、改、移除網域 | `caddyctl edge set` / `edge remove` + reload |
| 掛一個 app、改 app 路由 | 丟一個 `.caddy` 檔進 `apps\` + reload |
| 更新 skill-caddy 本身（`git pull`） | 重跑一次產生設定的指令 —— 見[更新之後](#更新-skill-caddy-之後要重新產生設定檔) |
| 換 Caddy 版本、修好壞掉的服務 | 才需要再動 `install.ps1` |

> **不要為了套用設定而重跑 `install.ps1`。** 它是「裝服務」，不是「套設定」——
> reload 是不中斷的（Caddy 換掉記憶體裡的設定，連線不會斷），
> 重裝服務會讓站台真的斷線。

一次加一個網域。**每個網域要決定的只有一件事：這個網址背後是什麼？** 三選一：

| | 內容在哪 | 這個網址有什麼功能 |
|---|---|---|
| **1. 轉給一台 node**<br>`--ip <位址>` | 另一台機器 | **完整功能**：靜態站 + WebDAV 讀寫 + `.md` 自動渲染 + `/pub` 公開區 + app drop-in（`/run` 除外 —— 那只有那台自己打得到） |
| **2. 這台自己服務**<br>（預設，或 `--content`） | edge 這台 | **只有 static file server**（可加密碼、可加 app drop-in） |
| **3. 先佔著**<br>`--hold` | 還沒有 | 回 503，但**憑證照樣簽發與續期** |

```powershell
# 1. 轉給某台 node，要密碼；/pub/* 例外（那是唯讀公開區）
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --password alice:秘密

# 2. 這台自己服務 —— 不給模式就是這個，目錄預設 D:\www\<label>
node src\caddyctl.mjs edge set --name mysite
node src\caddyctl.mjs edge set --name docs --content C:\Web    # 想換目錄才給

# 3. 網域先佔著，還沒指派主機
node src\caddyctl.mjs edge set --name later --hold
```

### 要不要密碼

**前兩種模式不加 `--password` 就是公開的 —— 任何人連上那個網址都看得到。** 這是刻意的
（有些站本來就是要公開），但它是你每加一個網域都該想一次的事，不是預設值幫你決定的。

```powershell
node src\caddyctl.mjs edge set --name mysite --password 123
```

**只有一個 `--password`,沒有 `--user`。** 帳號預設就是網域的 label（上面那行等同
帳號 `mysite`、密碼 `123`）。要自己指定帳號就在前面加冒號分隔：

```powershell
node src\caddyctl.mjs edge set --name recordings --password police:123
#   帳號 police，密碼 123
```

> 瀏覽器還是會跳出**兩個**欄位 —— HTTP Basic Auth 送出去的就是
> `base64(帳號:密碼)`，帳號是協定的一部分，拿不掉。能簡化的是**你打指令時**要想
> 幾件事。訪客那格的答案也很好記：**網址叫什麼，帳號就填什麼**。

| 旗標 | 做什麼 |
|---|---|
| `--password [帳號:]<密碼>` | 可重複，一組帳號一個旗標 |
| `--password-hash [帳號:]<雜湊>` | 同上，但直接給 `caddy hash-password` 算好的 bcrypt 雜湊 |

> 兩個旗標會互相擋錯放的值：明文餵給 `--password-hash` 會被拒絕（不擋的話它會被
> 原樣寫進設定，變成一個**永遠登不進去的站**，而且沒有任何錯誤訊息）；
> 雜湊餵給 `--password` 也會被拒絕（它會被再雜湊一次，產生一組沒有人知道
> 原始密碼的憑證）。兩種錯誤都會告訴你該改用哪一個旗標。
| `--public <路徑>` | 這些路徑免密碼，可重複。預設 `/pub/*` |
| `--no-public` | 連 `/pub/*` 都要密碼 |
| `--allow-anonymous` | `--ip` 不給密碼時要明講（見下） |

> 分隔符號用冒號不是斜線，兩個理由：跟 `--password-hash 帳號:雜湊` 同一個形狀，
> 而且 base64 的字元集含 `/` 不含 `:` —— 貼一組隨機密碼進來不會被誤切成帳號。

> **`--ip` 沒給帳號會被擋下來。** 靜態站沒密碼只是「網頁被看光」，而且很多站本來
> 就要公開；但 `--ip` 是把**一整台 node** 開到網際網路上，而 node 有可寫入的
> WebDAV 和可以執行主機動作的 `/run` —— 沒有密碼等於任何人都能寫你的檔案、
> 觸發你的 action。真的要公開就加 `--allow-anonymous` 明講。
>
> 注意 `--no-public` 和 `--allow-anonymous` 方向相反：前者是**收緊**
> （連 `/pub/*` 都要密碼），後者是**放開**。

**沒有密碼的站，edge 不會把 `/run` 轉過去**（直接回 404）。`/run` 執行的是主機腳本
—— 那是這整套系統裡最強的介面。而 node 上的 actiond 沒有 token（它的保護是綁在
loopback，但 `reverse_proxy` 送過去的請求來源正好是 loopback，於是 Caddy 自己會
變成一座橋）。所以沒有密碼卻轉 `/run`，等於把「在那台機器上執行指令」開給全世界。

換句話說：**那組密碼就是網際網路和你的機器之間的界線。** 想從手機按 action，
就給那個網域一組密碼；`--allow-anonymous` 的意思是「這個站的內容我要公開」，
不會連帶把 `/run` 也開出去。

和 `/pub/*` 剛好是對稱的一組產品規則，都不是可調的選項：

| 路徑 | 規則 |
|---|---|
| `/pub/*` | **永遠**免密碼（除非 `--no-public`） |
| `/run` | **永遠**不對匿名開放 |

> **區網內部是信任範圍。** node 的 `/run` 在區網裡是打得到的 —— 那讓
> 「手機 →（HTTPS + 密碼）→ edge → node 的 `/run`」這條路成立。這是刻意的決定，
> 理由見 [`docs/DESIGN.md`](docs/DESIGN.md) 的「信任邊界畫在 edge 上」。

```powershell
# 靜態站也可以要密碼
node src\caddyctl.mjs edge set --name docs --content C:\Web --password 123

# 多個帳號 —— 一組一個旗標
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 `
    --password alice:秘密1 --password bob:秘密2

# 只切第一個冒號，所以密碼後半含冒號沒問題
node src\caddyctl.mjs edge set --name docs --password "alice:a:b:c"
#   帳號 alice，密碼 a:b:c
```

> 唯一表達不出來的組合是「帳號要用 label，而密碼的第一段又剛好含冒號」。
> 那種情況用 `--password-hash`：自己跑一次 `caddy hash-password`（它從 stdin 讀，
> 什麼字元都吃），再寫成 `<label>:<雜湊>` —— bcrypt 雜湊不含冒號，永遠切得乾淨。

`--hold` 沒有密碼可設 —— 它只回 503，沒有內容可以保護。

### 某條路徑另外一組密碼

`--password` 管的是**整個站**。站裡面某條路徑要另外一組密碼（例如公開的網站底下
有個目錄只給特定的人看），用 `caddyctl auth` —— 這組指令**不分 edge / node**：

```powershell
node src\caddyctl.mjs auth set    --path /reports/* --password police:123
node src\caddyctl.mjs auth list
node src\caddyctl.mjs auth remove --path /reports/*
```

edge 上有好幾個站，所以要加 `--name <label>` 指定是哪個網域；node 只有一個站，
可以省。

規則存在 `C:\Caddy\conf\auth\<站>\`，一條路徑一個檔，由那個站 `import` 進去。
**它刻意跟 `conf\sites\<label>.caddy` 分開** —— 那個檔每次 `edge set` 都會整個
重寫，密碼寫在裡面，下次改個 IP 就安靜消失了。

> **整站已經有密碼時要小心。** 再加路徑密碼會變成「兩組都要過」，不是
> 「改用這一組」—— HTTP Basic Auth 對兩層挑戰的處理，瀏覽器行為很難預期。
> 想讓某個區域用不同的密碼，比較乾淨的做法是另開一個網域。caddyctl 偵測到
> 這種情況會提醒你。

**為什麼「不給模式」是 static file server，而不是什麼都不做？** 因為你已經指定
一個網址了 —— 那個網址總得有東西回應。`--content` 是「換一個目錄」，不是
「要不要開 file server」的開關。

**為什麼 edge 自己只能做 static file server？** WebDAV（可寫入）和 `/run`
（可執行主機動作）只裝在 node 上。edge 是唯一對著網際網路的機器，把這兩樣裝上去
等於把可寫入的檔案系統和可執行的動作開到外網 —— 所以要完整功能，就在**另一台**
跑 `node init`,再用 `--ip` 指過去。

> caddyctl 會擋下 `--ip` 指到 edge 自己的 80/443：那會讓請求繞回同一個 Caddy
> 變成無限迴圈，而且也拿不到 node 的功能。錯誤訊息會直接告訴你改用模式 2。
> （指到自己的**別的**埠是正當用法 —— 把本機一個 app 開一個網域出去 ——
> 不會被擋。）

`--hold` 不是可有可無的：Caddy 只為**有 site 區塊**的網域申請憑證，
只放進 DNS 設定是拿不到憑證的。佔位站台會回 503，但憑證會正常簽發與續期，
之後指派主機是瞬間切換，不必等 ACME。

改完要套用。**只改一個地方的話，加 `--reload` 就好，不用第二個指令**：

```powershell
node src\caddyctl.mjs edge set --name mysite --password 123 --reload
```

分好幾步改的話，就只在最後一步加 `--reload`：

```powershell
node src\caddyctl.mjs edge set --name a --ip 10.0.0.2 --password 1
node src\caddyctl.mjs edge set --name b --ip 10.0.0.3 --password 2
node src\caddyctl.mjs edge set --name c --hold --reload      # 最後一個順便套用
```

不確定還要改幾次，就都不加，最後單獨跑：

```powershell
node src\caddyctl.mjs reload
```

三種寫法做的事完全一樣。`--reload` 每個會改設定的指令都吃
（`edge set` / `edge remove` / `node init` / `auth set` / `auth remove`）。

套用時會先 `caddy validate`，**沒過就完全不動作** —— 站台繼續跑舊設定。過了才優雅
重載（不斷線），並把這份設定存成 `Caddyfile.last-good`。

> 這個指令存在的理由就是「不要在流程中間換工具」。它底下叫的是
> `POST /run/caddy-reload`，而**那個網址會因為角色而不同** —— node 是
> `http://127.0.0.1/run/...`，edge 是 `http://127.0.0.1:9001/run/...`。
> caddyctl 從 manifest 知道這台是什麼，所以你不用記。
>
> 為什麼兩種角色不一樣：node 的站台設定裡有一條 `/run` 轉給 actiond，
> 所以 node 可以打 80。edge 沒有 —— 它服務的是一個個
> 對外的網域，把 `/run` 掛上去等於讓任何人都能觸發主機動作
> （Host header 是可以偽造的，綁 `127.0.0.1` 那種 site block 擋不住）。
> 所以 edge 就直接打 actiond，而它只聽 loopback，只有這台機器上的人叫得動。

看目前有什麼：

```powershell
node src\caddyctl.mjs list
```

### 密碼

`--password` 會被 caddyctl 用 stdin 餵給 `caddy.exe hash-password`,**不會出現在
行程清單裡**（Windows 上任何本機使用者都看得到別人的 argv）。但它還是會留在你的
指令歷史裡 —— 在意的話就先自己算好，用 `--password-hash`：

```powershell
caddy hash-password
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --password-hash 'alice:$2a$14$...'
```

`--password-hash` 跟 `--password` 是同一個形狀（`[帳號:]值`），也一樣可以重複：

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 `
  --password-hash 'alice:$2a$14$...' --password-hash 'bob:$2a$14$...'
```

### 移除網域（後悔了）

指令叫 `edge remove`，沒有 `unset`：

```powershell
node src\caddyctl.mjs list                        # 先看有哪些
node src\caddyctl.mjs edge remove --name myfiles --reload
```

`--name` 是唯一必要的旗標。跟其他指令一樣吃 `--dir` 和 `--reload`。

**它會動的：**

- 刪掉 `conf\sites\<label>.caddy`
- 從 `conf\manifest.json` 的 `edge.domains` 拿掉那一筆
- 重寫 `conf\global.caddy` —— 那個網域一併退出 `dynamic_dns`，**DNS 紀錄不會再更新**。
  如果它是最後一個網域，整個 `dynamic_dns` 區塊會消失（沒有網域就沒有東西要更新）

**它不會動的**，這幾樣要自己處理：

| 留下來的 | 怎麼辦 |
|---|---|
| `conf\auth\<label>\` 個別路徑的密碼 | 見下面那則警告 —— 建議先清再移除 |
| `apps\<label>\` 底下的 app 路由（只有 serve 模式會有） | 不再被 import，要清就自己刪目錄 |
| 內容目錄（例如 `D:\www\<label>`） | 那是你的資料，本來就不該由這個指令刪 |
| duckdns.org 上的那個子網域 | caddyctl 只是不再更新它的 IP，紀錄還在。要真的退掉得去 duckdns 網站砍 |
| 已經簽發的憑證 | 留在 Caddy 的 data 目錄，過期就自然失效 |

> **同名加回來，舊的路徑密碼會復活。** `edge remove` 不刪 `conf\auth\<label>\`，
> 而 `edge set` 產生的站台設定固定會 `import "C:/Caddy/conf/auth/<label>/*.caddy"`。
> 所以拿同一個 label 重新開站，之前設過的個別路徑密碼會原封不動回來 ——
> 你以為是全新的站，實際上 `/reports/*` 還是要舊密碼。
>
> 更麻煩的是**順序**：網域一旦移除，`auth remove` 就會回「這台沒有名叫 <label>
> 的網域」而拒絕動作，孤兒檔只能自己去刪目錄。要清乾淨就**先 `auth remove`
> 再 `edge remove`**，或事後手動 `Remove-Item C:\Caddy\conf\auth\<label> -Recurse`。

`edge remove` 不會去檢查有沒有別的東西指著這個網域，也不需要 —— 一個網域一個檔，
移除就是刪那個檔加重寫 `global.caddy`，不會牽動其他站。

### 幫還沒裝好的機器先備設定

`--dir` 指到別的目錄就好，弄完整包複製到那台的 `C:\Caddy`：

```powershell
node src\caddyctl.mjs edge init --token <token> --dir .\staging
node src\caddyctl.mjs edge set --name myfiles --ip 10.0.0.2 --dir .\staging
```

設定內容裡的路徑一律是 `C:\Caddy`,跟你暫存在哪無關。

每個 caddyctl 指令都吃 `--dir`,包括下一章的 `node init` —— 所以也可以在自己的
工作機上把一台 node 的設定備好再送過去。

---

## 裝一台 node

跟 edge 一樣是兩步、兩個不同權限的視窗：

| | 做什麼 | 要什麼權限 |
|---|---|---|
| 第一步 `caddyctl node init` | 寫設定檔到 `C:\Caddy\conf\` | **一般使用者**就好 |
| 第二步 `install.ps1` | 下載執行檔、建目錄、**裝 Windows 服務** | **要系統管理員** |

### 第一步：寫設定（一般使用者）

在那台機器上開一個**普通的** PowerShell：

```powershell
git clone <這個 repo> C:\skill-caddy
cd C:\skill-caddy

node src\caddyctl.mjs node init
```

一樣不要放進 `C:\Caddy`。

**沒有必填參數。** 一台 node 的設定不依賴叢集裡的任何其他東西 ——
它不需要知道 edge 在哪、有哪些網域、別台叫什麼。edge 那邊也只需要這台的 IP，
所以兩邊各裝各的，沒有先後順序上的相依。

沒有 D: 槽的話就這樣：

```powershell
node src\caddyctl.mjs node init --drive E:
```

再跑一次是安全的：沒寫的旗標沿用現有設定。

**只想當靜態網站伺服器**（不要可寫入的 WebDAV）：

```powershell
node src\caddyctl.mjs node init --static
```

| | 完整功能 | `--static` |
|---|---|---|
| `/` | 靜態站 + **可寫入的 WebDAV** + `.md` 渲染 | 靜態站 + `.md` 渲染，**唯讀** |
| `/p/` `/w/` `/a/` | 可寫入的 WebDAV 掛載點 | **沒有** |
| `/pub/` | 公開唯讀區 | 一樣 |
| `/run` | 主機動作 | 一樣（**保留,才變得回去**） |

`--static` 是**宣告式**的 —— 沒帶它重跑 `node init` 就會變回完整功能。
兩邊都改得回去，只要 `node init [--static]` 再 reload，不用管理員：因為
兩種形狀下載的是**同一個** caddy 建置，差別只在產生出來的設定。

> 形狀真的變了的時候 caddyctl 會明講（「WebDAV 掛載點回來了，根目錄可寫入」），
> 所以不會安靜地把一台唯讀機器變成可寫入。只是想改別的設定時，記得把
> `--static` 一起帶上。

### 第二步：裝服務（要系統管理員）

**另外開一個「以系統管理員身分執行」的 PowerShell**,`cd` 到同一個目錄：

```powershell
cd C:\skill-caddy
.\src\install.ps1
```

跟 edge 那一步完全相同（下載對的建置 —— node 是 webdav、建目錄、先驗證再裝服務、
裝 `/caddy` 技能、自我測試），一樣會問 actiond 要用哪個帳號跑。
額外的是：**掛載點的目錄不存在會講一聲**。

裝完應該看到：

```
=== 自我測試 ===
  actiond :9001  HTTP 200
  /        HTTP 200
  /run     HTTP 200
  /pub/    HTTP 200
```

最後回到 edge 那台，把網域指過來：

```powershell
node src\caddyctl.mjs edge set --name myfiles --ip <這台的 IP> --password alice:秘密
node src\caddyctl.mjs reload
```

---

## 之後怎麼用

**掛一個 app：**

```powershell
# C:\Caddy\apps\myapp.caddy
redir /myapp /myapp/ 308
handle_path /myapp/* {
	reverse_proxy 127.0.0.1:3000
}
```

```powershell
node src\caddyctl.mjs reload
```

**發佈內容：** 檔案丟進內容根目錄（預設 `D:\www`），馬上就看得到，不用 reload。
`.md` 會自動渲染。放進底下的 `public\` 的東西**不需要密碼就能看**。

**新增動作：** 丟一個 `.ps1` 進 `C:\Caddy\actions\`，立即出現在 `/run` 面板上。

**那台機器上實際的路徑與網址：** 看 `C:\Caddy\conf\manifest.json`。

現成的例子在 [`examples/`](examples/) —— 兩個純靜態 SPA，加一個「小服務 +
路由片段 + 啟停動作」的完整 app 範例。

細節都在 `skill/SKILL.md` —— 那份也是裝到機器上給 AI 看的。

---

## 用 WebDAV 直接編輯檔案

node 上的每個內容路徑（`/`、`/p/`、`/w/`、`/a/`）**同一個網址就是可讀寫的 WebDAV**。
掛起來之後就是一台網路磁碟機，用什麼編輯器都行。

網址就是你平常瀏覽的那一個：

```
在區網裡     http://<node 的 IP>/w/
從外面       https://<label>.duckdns.org/w/     （要帳號密碼）
```

### Windows

**不需要任何外掛。** 掛成磁碟機，然後用 VS Code 開那個資料夾就好 ——
對 VS Code 來說它就是一個本機目錄，存檔即上傳。

```powershell
# 區網裡直接連 node（不用密碼 —— 認證在 edge 那一層）
net use V: http://10.0.0.2/w/

# 從外面經過 edge
net use V: https://myfiles.duckdns.org/w/ /user:myfiles <密碼>

code V:\        # 或在 VS Code 裡「開啟資料夾」
```

`WebClient` 服務不用手動啟動，第一次連的時候會自己被觸發。

> **兩個 Windows 內建的限制**，都在
> `HKLM:\SYSTEM\CurrentControlSet\Services\WebClient\Parameters`：
>
> | 設定 | 預設 | 意思 |
> |---|---|---|
> | `BasicAuthLevel` | `1` | **HTTP + 密碼會被 Windows 直接擋掉**，只允許 HTTPS |
> | `FileSizeLimitInBytes` | `50000000` | 單檔約 50MB 上限 |
>
> 第一項是最常見的「WebDAV 壞掉」原因，但這個架構下不會遇到：區網直連 node 是
> HTTP **但不需要密碼**，從外面經過 edge 是 **HTTPS**。唯一會失敗的組合
> （HTTP + 密碼）不會出現。改了要重啟 `WebClient` 服務。

Windows 內建的客戶端出了名的挑剔（偶爾會卡、大檔案慢）。覺得不好用就換
**RaiDrive** 或 **NetDrive**（一樣掛成磁碟機），或用 **WinSCP**
（有「用外部編輯器開啟」的整合，適合偶爾改一個檔）。

### macOS

Finder 的「前往 → 連接伺服器」（<kbd>⌘K</kbd>）內建支援：

```
https://myfiles.duckdns.org/w/
```

### iPhone / iPad

**內建的「檔案」App 不支援 WebDAV** —— 它的「連接伺服器」只吃 `smb://`。
這是最容易踩的誤會。要用第三方 App，而它們多半會註冊成「檔案」App 裡的一個位置，
所以裝完之後還是可以從「檔案」進去。

| App | 適合 | 要注意 |
|---|---|---|
| **Koder** | 程式碼編輯器，介面清爽 | 實測可用 |
| **Owlfiles** | 檔案管理為主，支援多種協定 | 免費版**只能建一個連線** |
| **FE File Explorer** | 檔案管理 | 付費，約 NT$150 |
| **Obsidian** | 寫筆記 | **只能建一個連線**，而且**只能建 `.md` 筆記** |

設定時填完整網址 `https://<label>.duckdns.org/w/` 加帳號密碼。

> App Store 上的 App 會改版、改價、甚至下架，裝之前先看一下商店頁面確認它現在
> 還支援 WebDAV。

### 順帶一提

`/pub/` **不是** WebDAV —— 它是唯讀的，`GET`/`HEAD` 以外一律 405。
那是刻意的：它是整個站唯一不需要密碼的路徑，存在理由是有些客戶端不會帶認證憑證
（例如聊天軟體內嵌的 webview）。要放可以編輯的東西，用 `/`、`/p/`、`/w/`。

---

## 更新 skill-caddy 之後：要重新產生設定檔

`C:\Caddy\conf\` 底下的檔案是 caddyctl **產生出來的快照**。`git pull` 拿到新版之後，
那些檔案不會自己跟著變 —— 也不會有任何錯誤訊息，舊版的行為就這樣安靜地繼續跑。
所以每次更新完，把產生設定的指令重跑一次：

**node —— 一行就好：**

```powershell
node src\caddyctl.mjs node init --reload
```

沒帶的旗標會沿用現有設定，所以重跑是安全的。唯一的例外是 `--static`：
它是宣告式的，原本是 static 的機器要記得把 `--static` 一起帶上。

**edge —— 每個網域各重打一次完整的指令：**

```powershell
node src\caddyctl.mjs list                      # 先看每個網域現在是什麼設定
node src\caddyctl.mjs edge set --name <label> ... --reload
```

> **`edge set` 是取代，不是修改。** 只帶 `--name` 重跑會把那個網域的密碼和模式
> 一起清掉，變成一個沒有密碼的靜態站。一定要把原本的旗標整組打完。
>
> 忘記密碼也沒關係 —— bcrypt 雜湊就在 `conf\sites\<label>.caddy` 的 `basic_auth`
> 區塊裡，原樣複製出來餵回 `--password-hash <帳號>:<雜湊>` 即可，不必重設密碼。

`conf\auth\` 底下的個別路徑密碼、和 `apps\` 底下的 drop-in 不受影響 ——
那些是 `import` 進去的獨立檔案，不會被重新產生的過程蓋掉。

### 內容根目錄是你的，產品的檔案不放在那裡

`<槽>\www`（以及 `\projects`、`\workspaces`）**完全屬於你**。產品自己的頁面
一個都不住在那裡：

| 檔案 | 誰的 | 誰在維護 |
|---|---|---|
| `C:\Caddy\conf\_panel.html` | 產品 | caddyctl 產生，每次 `node init` 重寫 |
| `C:\Caddy\conf\_configs.html` | 產品 | 同上 |
| `C:\Caddy\conf\_md.html` | 產品 | `install.ps1` 直接覆蓋 |
| `<槽>\www\index.html` | **你的** | 只在不存在時給一頁起始頁 |
| `<槽>\www\public\index.html` | **你的** | 同上 |

所以 `install.ps1` 對內容目錄只做兩件事：把目錄建出來，以及在**檔案不存在時**
放一頁可以直接刪掉的起始頁。你改過的東西它不會碰。

> **這件事以前不是這樣。** 控制面板原本就是 `<槽>\www\index.html` 本身 ——
> 也就是「這台的首頁」跟「你自己的首頁」是同一個檔，只能活一個。放自己的
> `index.html` 就等於把面板刪掉，而且看起來像產品壞了、不像自己覆蓋了什麼。
> 面板改成獨立的 `/panel` 之後，你怎麼動內容目錄都不會弄丟它。

`conf\` 底下那幾個是產品的地盤（`_panel.html`、`_configs.html`、`_md.html`），
標題也都寫著「不要手動編輯」—— 改了下次 `node init` 或 `install.ps1` 會蓋掉。
要改 Markdown 的樣式，改 repo 裡的 `templates\www\_md.html` 再重跑安裝。

---

## 移除（或重裝）

用**系統管理員**開 PowerShell：

```powershell
.\src\uninstall.ps1                  # 拔掉全部，刪掉 C:\Caddy
.\src\uninstall.ps1 -WhatIf          # 只看會做什麼，不動手
.\src\uninstall.ps1 -KeepFiles       # 只拔註冊項目，C:\Caddy 留著
.\src\uninstall.ps1 -PurgeFirewall   # 連 Windows 自己建的殘留規則也刪
```

它會拔掉 `install.ps1` 建的那五樣：兩個服務、防火牆規則、排程工作、
`/caddy` 技能、`C:\Caddy` 目錄。

**網站內容不會被刪** —— `<槽>\www`、`<槽>\projects`、`<槽>\workspaces`
一律留著。那是你的資料，不是這個產品的東西。

跑完就是一台乾淨的機器，可以重新 `caddyctl ... init` + `install.ps1`。

### OpenClaw 的那一份技能不會被刪

移除程式對 OpenClaw **只檢查，不動手**：

```
=== /caddy 技能 ===
  Claude Code  移除 C:\Users\你\.claude\skills\caddy
  OpenClaw     還有一份 caddy 技能 —— 這支腳本不會動它。
```

因為 `openclaw skills` 沒有 uninstall / remove 指令，技能放在它自己管理的目錄和
登錄裡。沒有支援的移除方式就去砍別人的目錄，只會把對方的狀態弄壞。要清請用
OpenClaw 自己的方式（`openclaw skills list` 看它在哪個 agent workspace）。

### Windows 自己建的防火牆規則

移除程式最後可能列出這種東西：

```
  另外有 2 條不是 install.ps1 建的規則，綁在 C:\Caddy 的執行檔上：
    Caddy  (C:\Caddy\caddy.exe)
    Caddy  (C:\Caddy\caddy.exe)
  這是 Windows 的「安全性警訊」彈窗按下允許時建的，範圍是該程式的所有埠。
  沒有動它。要一併清掉就加 -PurgeFirewall 再跑一次。
```

那是 Windows 跳「安全性警訊」時按下「允許存取」留下的 **Query User 規則**：
TCP + UDP、**該程式的所有埠**、Private + Public —— 比 `install.ps1` 開的那一兩個
埠寬得多。而且它綁在**程式路徑**上，所以 `caddy.exe` 重裝回同一個位置就又生效。

**預設不刪**，因為那不是這個產品建的東西。確定要清就加 `-PurgeFirewall`。

> 舊版才會產生這種殘留 —— 那時候服務先啟動、防火牆規則後建，中間那段空窗
> `caddy.exe` 一開始 listen 就會觸發彈窗。現在 `install.ps1` 先建規則再啟動服務，
> 彈窗不會出現。

### 「檔案正由另一個程序使用」

刪 `C:\Caddy` 時如果卡在 `nssm.exe` 或 `logs\`,原因是**`nssm.exe` 本身就是
那兩個服務的執行檔** —— 服務還在跑，檔案就一直被鎖著。手動處理的話：

```powershell
Stop-Service caddy, actiond -Force
sc.exe delete caddy
sc.exe delete actiond
```

順序不能反。停完服務檔案就解鎖了。`uninstall.ps1` 就是照這個順序做的，
而且會等行程真的結束、必要時再 `Stop-Process` 收尾；還刪不掉的話它會
**列出到底是哪幾個檔案還被鎖著**,而不是只丟一句「拒絕存取」。

---

## 網址對照

| URL | 是什麼 |
|---|---|
| `/panel` | **控制面板** —— 這台有哪些網址，一頁看完 |
| `/` | 內容根目錄（瀏覽 + WebDAV 讀寫）—— **這是你的**，放什麼都行 |
| `/p/`、`/w/` | `<槽>\projects`、`<槽>\workspaces` |
| `/a/` | actions 資料夾（可用 WebDAV 編輯 action） |
| `/c/` | **這台裝了哪些工具** —— 家目錄裡的設定檔，改過名字集中在一起 |
| `/run` | action 面板 |
| `/run/<名稱>` | 執行某個 action |
| `/pub/` | **公開唯讀，不需要密碼** |
| `/<app>/` | 你掛的 app |

某一台上實際的對應關係，看那台的 `C:\Caddy\conf\manifest.json`（`node.url_map`）。

`/panel` 是產生出來的，所以不會說謊：static 的機器不會列出 `/p/ /w/ /a/`，
沒有家目錄設定的機器不會列出 `/c/`。

---

## `/c/` —— 這台裝了哪些工具

家目錄裡的設定檔，集中在一個網址，而且**改過名字**：

```
/c/openclaw.json   ->  ~\.openclaw\openclaw.json
/c/claude.json     ->  ~\.claude\settings.json
/c/codex.toml      ->  ~\.codex\config.toml
```

改名是必要的 —— 好幾個工具的設定檔都叫 `settings.json`，擺在一起分不出誰是誰。

**只列出這台真的存在的檔案**，而且是每次瀏覽時即時判斷的。所以之後在這台裝了
新工具，不必 reload、不必重跑 caddyctl，`/c/` 自己就會多一行。也就是說這一頁
等於「這台裝了哪些東西」的清單。

可以直接用 WebDAV 編輯（`PUT`）。改完通常還要重啟對應的服務，看 `/run`。

**清單是 `src\render.mjs` 裡的 `CONFIG_FILES`。** 沒有排除邏輯，也刻意不做 ——
一個檔案要不要出現在 `/c/`，就看它有沒有寫在那張表裡。加行之前想一下那個檔裡
有沒有金鑰：`.npmrc`、`.aws\credentials`、`.ssh\id_*`、`.claude\.credentials.json`
這類純憑證檔就是為此不在表上。

> **同目錄的鄰居打不到。** 每個檔案各自一個確切路徑的 `handle`（不是 `/c/*`），
> 所以 `/c/.credentials.json` 是 404，即使那個檔就在 `.claude\` 底下。
> 這是安全性的關鍵 —— 改成萬用字元就等於把整個家目錄開出去。

家目錄是 `caddyctl node init` 當下抓的（`os.homedir()`），寫進 manifest。
**不能留給 Caddy 去解**：它是以服務身分執行的，`%USERPROFILE%` 指到別的地方。
要改用 `--home <路徑>`，不要這個功能用 `--no-home`。

---

## 出問題時

```powershell
curl.exe -X POST http://127.0.0.1/run/caddy-status     # 先看這個
curl.exe -X POST http://127.0.0.1/run/caddy-validate   # 設定語法
curl.exe -X POST http://127.0.0.1/run/caddy-rollback   # 還原上一份可用的設定
```

**寫壞設定不會讓站台掛掉。** `caddy-reload` 驗證失敗時完全不動作，而且正在跑的
Caddy 用的是記憶體裡的設定 —— 只有服務重啟才會吃到壞檔案。
`Caddyfile.last-good` 只在 reload 成功後更新，所以它永遠跑得起來。

> **設定沒改的話，`caddy-reload` 其實什麼都不做，但還是回報成功。**
> Caddy 的 `Load()` 在新設定跟目前完全相同時直接回 `errSameConfig`，而那被當成
> 成功吞掉（`caddy.go:112-142`）。所以你會看到「reload OK」，但沒有任何東西
> 重新 provision —— `dynamic_dns` 也不會重新查一次 IP。
>
> 真的要強制（例如想立刻推一次 DNS 更新）：
>
> ```powershell
> C:\Caddy\caddy.exe reload --config C:\Caddy\Caddyfile --adapter caddyfile --force
> ```
>
> 或直接重啟服務。順帶一提，`dynamic_dns` 在**服務啟動時就會檢查一次**，
> 不是等 `check_interval` 到期，所以剛裝好、剛重啟的機器不必等。

log 在 `C:\Caddy\logs\`。

---

## 設計

為什麼是這些取捨、以及一路上實測出來的 Caddy 與 Windows 行為，
都記在 [docs/DESIGN.md](docs/DESIGN.md)。

---

## 這份程式是怎麼寫出來的

由人設計、決定取捨並驗收，程式與文件用 **Claude Opus 5**（Claude Code）寫成。
上線前做過一次完整的驗收：兩台 Windows 機器從空機裝起，edge 與 node 各一台，
一路測到公網 HTTPS、憑證簽發、WebDAV 讀寫與遠端執行 action。
