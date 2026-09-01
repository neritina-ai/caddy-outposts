# 範例

三個可以直接裝起來用的東西，順便示範這套系統的三種擺法。

| | 是什麼 | 學到什麼 |
|---|---|---|
| [`calculator/`](calculator/) | 計算機，單一 HTML 檔 | 靜態內容怎麼發佈 —— 複製過去就好，不用 reload |
| [`calendar/`](calendar/) | 行事曆，會記東西 | 同上，外加「狀態存在瀏覽器」的極限在哪 |
| [`hello-service/`](hello-service/) | 小服務 + 路由 + 啟停動作 | app 怎麼掛、動作怎麼寫 |

前兩個沒有 build、沒有相依套件、沒有絕對路徑，所以掛在哪個子路徑下都能跑。
第三個需要 Node。

---

## 靜態的那兩個

複製到內容根目錄底下，馬上就看得到（內容根目錄預設是 `D:\www`，實際位置看
`C:\Caddy\conf\manifest.json` 的 `node.content_root`）：

```powershell
Copy-Item -Recurse .\examples\calculator D:\www\calculator
Copy-Item -Recurse .\examples\calendar   D:\www\calendar
```

→ `/calculator/`、`/calendar/`

**不用 reload Caddy。** 內容檔案是即時的，只有 `apps\*.caddy` 改了才要 reload。

放進 `public\` 的話，網址變成 `/pub/...`，而且**不需要密碼就能看**：

```powershell
Copy-Item -Recurse .\examples\calculator D:\www\public\calculator
```

→ `/pub/calculator/`，任何人都打得開。要放進去之前先確定那是可以公開的東西。

這兩個都可以直接用 WebDAV 編輯 —— 用手機的檔案 app 掛上站台網址，
打開 `calculator/index.html` 改一行存檔，重新整理就生效了。

### 記事存在哪

`calendar/` 的記事是存在瀏覽器的 `localStorage` 裡的，也就是**只存在那一台裝置上**。
換一支手機就看不到，清掉瀏覽器資料就沒了，無痕視窗裡連存都存不進去
（程式碼裡每一個 `localStorage` 呼叫都包了 `try`，就是為了這個）。

要跨裝置的話，那就不是靜態站了，需要一個會把東西存在伺服器上的服務 ——
也就是隔壁的 `hello-service`。

---

## app 那個

看 [`hello-service/README.md`](hello-service/README.md)。

一句話版本：`server.mjs` 只綁 `127.0.0.1:3100`，`hello.caddy` 用
`handle_path /hello/*` 把它掛到 `/hello/`，兩個 `.ps1` 讓你可以在
`/run` 面板上（或手機書籤）啟動、停止它。
