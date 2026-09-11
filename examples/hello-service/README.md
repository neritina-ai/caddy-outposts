# hello-service

一個「app」的完整範例：跑在本機某個埠上的小服務，被 Caddy 掛到 `/hello/`，
並且有兩個可以用手機按的啟停動作。

沒有相依套件，只要有 Node 就能跑。

```
server.mjs              服務本身
hello.caddy             路由片段  -> C:\Caddy\apps\hello.caddy
actions\_hello.ps1      共用設定（底線開頭 = 不會變成 action）
actions\hello-start.ps1 -> C:\Caddy\actions\
actions\hello-stop.ps1  -> C:\Caddy\actions\
```

---

## 安裝

在裝好 skill-caddy 的 node 機器上。`C:\Caddy` 是固定的；內容根目錄看
`C:\Caddy\conf\manifest.json` 的 `node.content_root`（預設 `D:\www`）。

```powershell
# 1. 服務本身
Copy-Item -Recurse .\examples\hello-service C:\Caddy\apps\hello-service
Remove-Item -Recurse C:\Caddy\apps\hello-service\actions   # 動作要放到別的地方去

# 2. 動作
Copy-Item .\examples\hello-service\actions\*.ps1 C:\Caddy\actions\

# 3. 路由
Copy-Item .\examples\hello-service\hello.caddy C:\Caddy\apps\hello.caddy

# 4. 啟動服務，然後套用路由
curl.exe -X POST http://127.0.0.1:9001/run/hello-start
curl.exe -X POST http://127.0.0.1:9001/run/caddy-reload
```

開 `/hello/` 就看得到。`/run` 面板上會多出一個 **hello** 群組。

> app 的程式放哪裡都可以，`apps\` 只是個順手的地方。要換位置的話，
> 改 `actions\_hello.ps1` 最上面的 `$AppDir` 就好 —— 唯一**必須**放進
> `C:\Caddy\apps\` 的是那個 `.caddy` 路由片段。

## 移除

```powershell
curl.exe -X POST http://127.0.0.1:9001/run/hello-stop
Remove-Item C:\Caddy\apps\hello.caddy
curl.exe -X POST http://127.0.0.1:9001/run/caddy-reload
Remove-Item -Recurse C:\Caddy\apps\hello-service
Remove-Item C:\Caddy\actions\hello-*.ps1, C:\Caddy\actions\_hello.ps1
```

---

## 這個範例在示範什麼

**服務只綁 `127.0.0.1`。** 不綁 `0.0.0.0`。所有流量都應該先經過 Caddy ——
TLS、認證、log 都在那裡做。app 自己不要重做一遍，也不要讓人繞過。

**app 不知道自己被掛在哪。** `handle_path /hello/*` 把前綴剝掉了，服務看到的路徑
是 `/`。頁面上會把「服務看到的路徑」印出來，可以自己對照。代價是頁面裡**不能有
絕對路徑** —— 寫 `api/hits` 可以，寫 `/api/hits` 會打到站台根目錄去。
第三方 app 掛不上子路徑，多半就是踩到這一點。

**`redir /hello /hello/ 308` 不是可有可無的。** 少了尾斜線，相對路徑的基準就整個
差一層。這種壞法很難查，因為首頁看起來是好的。

**`@confirm` 用在會造成破壞的動作上。** `hello-stop` 有加。`/run/<名稱>` 就只是一個
網址，而網址會被瀏覽器預抓、被聊天軟體展開預覽、被 Wi-Fi 登入偵測順手打開。

**底線開頭的檔案不會變成 action。** `_hello.ps1` 放兩個動作共用的路徑與函式，
它不會出現在 `/run` 面板上，也不能被 HTTP 觸發。

**含中文的 `.ps1` 一定要存成 UTF-8 with BOM。** 沒有 BOM 的話，PowerShell 5.1
會用系統 ANSI（中文版是 Big5）去讀，然後**安靜地**解析失敗 —— exit code 還是 0，
但腳本後半段根本沒跑。這裡三個 `.ps1` 都是 BOM 版的。

**pid 檔不能只看存在與否。** 機器重開、行程自己掛掉，pid 檔都還會留著；
而 Windows 會回收 PID 再配給別的程式。所以 `Get-HelloProcess` 會再確認
那個 PID 真的是 node。

---

## 沒做的事

這是範例，不是產品。真的要長期跑的東西，該考慮的還有：

* **開機自動啟動。** 現在要手動按 `hello-start`。要自動的話，用 `nssm` 註冊成
  Windows 服務（skill-caddy 自己就是這樣裝 `caddy` 和 `actiond` 的），
  或做一個開機時觸發的排程工作。
* **掛掉自動重啟。** 沒有。註冊成服務就有了。
* **多人同時寫。** `hits.json` 是整份覆寫的，量大就會掉資料。
* **記錄輸出的輪替。** `hello-service.log` 會一直長。
