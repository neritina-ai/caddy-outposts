// ===========================================================================
//  hello-service  ——  skill-caddy 的「app」範例
//
//  一個沒有任何相依套件的小服務，用來示範怎麼把跑在本機某個埠上的東西
//  掛到站台的某個路徑下面。
//
//      node server.mjs
//
//  環境變數：
//      HELLO_PORT   監聽的埠（預設 3100）
//      HELLO_DATA   計數器存檔的位置（預設是這個檔旁邊的 hits.json）
//
//  三個重點，寫自己的 app 時照抄：
//
//  1. 只綁 127.0.0.1。這個服務不該被 LAN 或外網直接連到 ——
//     所有進來的流量都應該先經過 Caddy（認證、TLS、log 都在那裡做）。
//
//  2. 頁面裡不要用絕對路徑。這個服務被掛在 /hello/ 底下，但它自己
//     看到的路徑是 /（Caddy 的 handle_path 把前綴剝掉了）。
//     所以 HTML 裡寫 "api/hits" 可以，寫 "/api/hits" 會打到站台根目錄去。
//
//  3. 別自己做認證。edge 已經把整個網域擋在 basic auth 後面了。
// ===========================================================================
import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const PORT = Number(process.env.HELLO_PORT || 3100);
const HOST = '127.0.0.1';                        // 見上面第 1 點
const DATA = process.env.HELLO_DATA ||
             path.join(path.dirname(fileURLToPath(import.meta.url)), 'hits.json');

const started = new Date();

let hits = 0;
try { hits = JSON.parse(await readFile(DATA, 'utf8')).hits || 0; }
catch { /* 第一次跑，還沒有檔案 */ }

let saving = null;
function save() {
  // 連點很快時不要疊一堆寫檔；有一個在寫就等它寫完再說。
  if (saving) return saving;
  saving = writeFile(DATA, JSON.stringify({ hits }), 'utf8')
    .catch(err => console.error('[hello] 存不進 ' + DATA + '：' + err.message))
    .finally(() => { saving = null; });
  return saving;
}

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
};

function state(req) {
  const up = Math.floor((Date.now() - started.getTime()) / 1000);
  return {
    hits,
    host: os.hostname(),
    pid: process.pid,
    node: process.version,
    uptime: `${Math.floor(up / 3600)}h ${Math.floor(up / 60) % 60}m ${up % 60}s`,
    // Caddy 的 reverse_proxy 預設會補上這幾個 header，後端看到的才不是 127.0.0.1
    forwarded: {
      for: req.headers['x-forwarded-for'] || null,
      host: req.headers['x-forwarded-host'] || null,
      proto: req.headers['x-forwarded-proto'] || null,
    },
    // 前綴被 handle_path 剝掉之後，服務自己看到的路徑
    seenPath: req.url,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/hits') {
    if (req.method === 'POST') { hits++; await save(); }
    else if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, { error: 'method not allowed' }, 405);
    }
    return json(res, state(req));
  }

  if (p === '/healthz') {
    return json(res, { ok: true, uptime: state(req).uptime });
  }

  if (p === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PAGE);
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 —— hello-service 只有 / 、 api/hits 、 healthz\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[hello] http://${HOST}:${PORT}  pid=${process.pid}  data=${DATA}`);
});

// 被 action 停掉時（Stop-Process）不一定跑得到，但正常結束時要把數字寫回去
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { save().finally(() => process.exit(0)); });
}

// ---------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="zh-Hant">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>hello-service</title>
<style>
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--accent:#0969da}
@media(prefers-color-scheme:dark){
  :root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--card:#151b23;--accent:#4493f8}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
     font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
main{max-width:34rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font-size:1.3rem;margin:0 0 .2em}
.sub{color:var(--mut);font-size:.85rem;margin-bottom:1.8rem}
.big{background:var(--card);border:1px solid var(--line);border-radius:14px;
     padding:1.4rem;text-align:center;margin-bottom:1rem}
.big .n{font-size:2.6rem;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}
.big .l{color:var(--mut);font-size:.8rem;margin-top:.3rem}
button{font:inherit;font-size:.95rem;background:var(--accent);color:#fff;border:0;
       border-radius:11px;padding:.6rem 1.4rem;cursor:pointer;margin-top:1rem}
button:active{transform:scale(.97)}
table{width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.5rem}
td{padding:.4rem .2rem;border-bottom:1px solid var(--line);vertical-align:top}
td:first-child{color:var(--mut);white-space:nowrap;width:9rem}
code{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.85em;
     background:var(--card);border:1px solid var(--line);padding:.1em .4em;border-radius:6px}
footer{margin-top:2rem;font-size:.8rem;color:var(--mut);line-height:1.9}
a{color:var(--accent)}
</style>
<main>
  <h1>hello-service</h1>
  <div class="sub">skill-caddy 的 app 範例 —— 一個跑在本機埠上、被 Caddy 掛到子路徑的服務</div>

  <div class="big">
    <div class="n" id="hits">–</div>
    <div class="l">按鈕被按過幾次（存在伺服器上）</div>
    <button id="go">按我</button>
  </div>

  <table id="info"></table>

  <footer>
    這一頁是服務自己吐出來的，不是靜態檔。<br>
    停掉服務之後這個網址會變成 <code>502</code> —— 那表示 Caddy 還在，只是後面沒人接。<br>
    <a href="../">回站台根目錄</a>
  </footer>
</main>
<script>
// 注意：是 "api/hits" 不是 "/api/hits"。
// 這一頁的網址是 /hello/，相對路徑才會打到 /hello/api/hits。
const $ = id => document.getElementById(id);
const ROWS = {
  host: '主機', pid: '行程 PID', node: 'Node 版本', uptime: '已執行',
  seenPath: '服務看到的路徑',
};

function render(s) {
  $('hits').textContent = s.hits.toLocaleString();
  const rows = Object.entries(ROWS)
    .map(([k, label]) => [label, s[k]])
    .concat([
      ['X-Forwarded-For', s.forwarded.for || '（沒有 —— 你是直連的？）'],
      ['X-Forwarded-Host', s.forwarded.host || '—'],
      ['X-Forwarded-Proto', s.forwarded.proto || '—'],
    ]);
  $('info').textContent = '';
  for (const [k, v] of rows) {
    const tr = $('info').insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().appendChild(Object.assign(document.createElement('code'), { textContent: String(v) }));
  }
}

const load = (method = 'GET') =>
  fetch('api/hits', { method }).then(r => r.json()).then(render)
    .catch(e => { $('hits').textContent = '連不上'; console.error(e); });

$('go').onclick = () => load('POST');
load();
</script>
</html>
`;
