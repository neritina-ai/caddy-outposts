// =============================================================================
//  action daemon  —  把 C:/Caddy/actions/ 裡的每個腳本變成一個 URL
//
//  跑法：  node C:/Caddy/actiond/server.mjs        (bun 也可以)
//  Caddy 用 reverse_proxy 127.0.0.1:9001 把 /run* 轉進來。
//
//  新增一個 action = 在 C:/Caddy/actions 放一個檔案，馬上生效，不用 reload Caddy。
//  支援 .ps1 .cmd .bat .sh .mjs .js .ts；底線開頭的檔案會被忽略。
//
//  腳本開頭的註解可以放 metadata：
//      # @title   重啟 hello-service
//      # @desc    停掉再重新拉起來
//      # @group   hello
//      # @confirm            <- 用 GET 開網址時先出確認頁，避免誤觸／預抓
//      # @page               <- 這支腳本自己就是一個網頁，見下面 @page 那段
//
//  @page：一個檔案 = 一個動態網頁。腳本從環境變數拿到 ACTION_METHOD、
//  ACTION_QUERY、ACTION_SELF，從 stdin 拿到表單 body，stdout 原樣當 HTML 送出。
//  輸入的驗證是腳本自己的責任 —— actiond 只負責轉交。
//
//  環境變數：ACTIONS_DIR ACTION_PORT ACTION_HOST ACTION_TOKEN ACTION_TIMEOUT_MS
//            ACTION_ALLOW  逗號分隔的 CIDR 白名單 —— HOST 不綁 loopback 時務必設定
//            ACTION_DRAIN_MS
// =============================================================================
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// 系統的 OEM codepage，用來當子行程輸出的 UTF-8 解碼失敗時的退路
const CP_LABELS = {
  '932': 'shift_jis', '936': 'gbk', '949': 'euc-kr', '950': 'big5',
  '1250': 'windows-1250', '1251': 'windows-1251', '1252': 'windows-1252',
  '65001': 'utf-8',
};
let OEM_LABEL = 'windows-1252';
try {
  const m = /(\d+)\s*$/.exec(execSync('chcp.com', { encoding: 'utf8' }).trim());
  if (m && CP_LABELS[m[1]]) OEM_LABEL = CP_LABELS[m[1]];
} catch { /* 拿不到就用預設 */ }

function decodeOutput(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder(OEM_LABEL).decode(buf); }
    catch { return buf.toString('latin1'); }
  }
}

const ACTIONS_DIR = process.env.ACTIONS_DIR || 'C:/Caddy/actions';
const PORT      = Number(process.env.ACTION_PORT || 9001);
const HOST      = process.env.ACTION_HOST || '127.0.0.1';
const TOKEN     = process.env.ACTION_TOKEN || '';        // 空字串 = 不驗
const TIMEOUT   = Number(process.env.ACTION_TIMEOUT_MS || 120000);
// 腳本結束後，再等多久把管線裡剩下的輸出讀完才回應。見 run() 裡的說明。
const DRAIN_MS  = Number(process.env.ACTION_DRAIN_MS || 150);
// 逗號分隔的 IPv4 CIDR 白名單。空字串 = 不限制（只有在 HOST 綁 loopback 時才安全）。
// 一旦 ACTION_HOST 不是 127.0.0.1，就一定要設這個。
const ALLOW     = (process.env.ACTION_ALLOW || '').split(',').map(x => x.trim()).filter(Boolean);

const ip2int = ip => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0;
function ipAllowed(raw) {
  if (!ALLOW.length) return true;
  const ip = String(raw || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const v = ip2int(ip);
  return ALLOW.some(cidr => {
    const [net, bitsRaw] = cidr.split('/');
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(net)) return false;
    const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
    if (!(bits >= 0 && bits <= 32)) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) >>> 0 === (ip2int(net) & mask) >>> 0;
  });
}

// Windows 的編碼有兩個各自獨立的坑，兩個都要處理：
//
//  1. 讀腳本（腳本作者要負責）：Windows PowerShell 5.1 讀 .ps1 時，沒有 BOM 的
//     UTF-8 會被當成系統 ANSI（這台是 Big5）。中文註解裡只要有破折號之類的字，
//     解析就會壞掉，而且是**安靜地壞掉** —— exit code 還是 0，但後半段沒跑。
//     所以含中文的 .ps1 一定要存成 UTF-8 with BOM。見 _template.ps1。
//
//  2. 讀輸出（這裡負責）：PowerShell 5.1 在 stdout 被導向時是用 OEM codepage
//     輸出的，`[Console]::OutputEncoding = UTF8` 對它的輸出管線沒有效果
//     （實測輸出裡會出現 U+FFFD）。所以不在子行程那端硬扭，改在這端解碼：
//     先用嚴格 UTF-8 試，失敗才退回系統 OEM codepage。
//     這樣 PowerShell/cmd（OEM）與 node/bun（UTF-8）都能正確處理。
const RUNNERS = {
  '.ps1': f => ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f]],
  '.cmd': f => [process.env.ComSpec || 'cmd.exe', ['/c', f]],
  '.bat': f => [process.env.ComSpec || 'cmd.exe', ['/c', f]],
  '.sh':  f => ['bash', [f]],
  '.mjs': f => ['node', [f]],
  '.js':  f => ['node', [f]],
  '.ts':  f => ['bun', ['run', f]],
};

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

const running = new Set();

async function listActions() {
  let names;
  try { names = await readdir(ACTIONS_DIR); } catch { return []; }
  const out = [];
  for (const f of names) {
    const ext = path.extname(f).toLowerCase();
    if (!RUNNERS[ext] || f.startsWith('_') || f.startsWith('.')) continue;
    const id = path.basename(f, ext);
    const meta = { id, file: f, ext, title: id, desc: '', group: '', confirm: false, page: false };
    try {
      const head = (await readFile(path.join(ACTIONS_DIR, f), 'utf8')).split(/\r?\n/).slice(0, 25);
      for (const line of head) {
        const m = /^\s*(?:#|\/\/|rem)\s*@(title|desc|group|confirm|page)\b[ \t]*(.*)$/i.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === 'confirm' || k === 'page') meta[k] = v === '' || /^(1|true|yes)$/i.test(v);
        else meta[k] = v;
      }
    } catch { /* 讀不到就用預設值 */ }
    out.push(meta);
  }
  return out.sort((a, b) => (a.group + a.id).localeCompare(b.group + b.id));
}

// 讀請求的 body，@page 的腳本從 stdin 拿到它。
// 有上限：這是一個控制台，不是上傳空間。超過就回 413，不要默默截斷 ——
// 截斷過的表單資料看起來仍然像合法的表單資料。
function readBody(req, limit = 1000000) {
  return new Promise(resolve => {
    if (req.method === 'GET' || req.method === 'HEAD') return resolve('');
    const parts = [];
    let n = 0, over = false;
    req.on('data', d => {
      n += d.length;
      if (n > limit) { over = true; req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(parts).toString('utf8')));
    req.on('error', () => resolve(over ? null : ''));
  });
}

function run(act, ctx) {
  return new Promise(resolve => {
    const file = path.join(ACTIONS_DIR, act.file);
    const [cmd, args] = RUNNERS[act.ext](file);
    const started = Date.now();
    let killed = false, child;
    try {
      child = spawn(cmd, args, {
        cwd: ACTIONS_DIR,
        windowsHide: true,
        env: ctx ? { ...process.env, ...ctx.env } : process.env,
      });
    } catch (e) {
      return resolve({ code: -1, ms: 0, output: 'spawn failed: ' + e.message });
    }
    // 只有 @page 才餵 stdin。一般的 action 維持原樣（管線開著沒人寫），
    // 改掉會讓「腳本自己讀 stdin」這件事的行為在升級後不一樣。
    if (ctx) child.stdin.end(ctx.body || '');
    const timer = setTimeout(() => { killed = true; child.kill(); }, TIMEOUT);

    // 收原始 bytes，最後才一次解碼 —— 中間切開解碼會把多位元組字元切壞。
    //
    // stdout 另外留一份：@page 是拿 stdout 當網頁送出去的，
    // 混進 stderr 就會把 HTML 弄壞（PowerShell 的 Write-Error、node 的 warning
    // 都會跑到 stderr 去）。log 模式要的仍然是兩條合在一起、照時間順序的那份。
    const chunks = [], outChunks = [];
    let bytes = 0, outBytes = 0;
    const trim = (arr, n) => {
      while (n > 200000 && arr.length > 1) n -= arr.shift().length;
      return n;
    };
    const cap = (d, isOut) => {
      const b = Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8');
      chunks.push(b);
      bytes = trim(chunks, bytes + b.length);
      if (!isOut) return;
      outChunks.push(b);
      outBytes = trim(outChunks, outBytes + b.length);
    };
    child.stdout.on('data', d => cap(d, true));
    child.stderr.on('data', d => cap(d, false));
    child.on('error', e => cap('\n[spawn error] ' + e.message, false));

    // 以 'exit'（行程結束）為準，不是 'close'（管線關閉）。
    //
    // 為什麼：Windows 的 CreateProcess 是把「所有可繼承的 handle」一起給子行程的。
    // 所以只要 action 腳本自己又拉起一個背景行程（Start-Process 啟動服務之類），
    // 那個孫行程就會**一直握著 actiond 給腳本的 stdout pipe**，即使它自己的
    // stdout 早就導到別的檔案去了。腳本結束了，管線卻沒有人關 —— 'close' 永遠不來，
    // 於是 HTTP 請求會一直卡到 timeout 為止。（實測：hello-start 卡滿 120 秒。）
    //
    // 所以：行程一結束就準備回應，只再留一小段時間把還躺在管線裡的輸出讀完。
    // 正常情況下 'close' 會在 'exit' 之後幾毫秒內就到，走的還是原本那條路。
    let done = false;
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({
        code, ms: Date.now() - started,
        output: decodeOutput(Buffer.concat(chunks))
          + (killed ? '\n[timeout ' + TIMEOUT + 'ms — killed]' : ''),
        stdout: decodeOutput(Buffer.concat(outChunks)),
      });
    };
    child.on('close', finish);
    child.on('exit', code => setTimeout(() => finish(code), DRAIN_MS));
  });
}

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da;--ok:#1a7f37;--bad:#cf222e}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--card:#151b23;--link:#4493f8;--ok:#3fb950;--bad:#f85149}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.2rem 1rem 4rem}
h1{font-size:1.3rem;margin:.2em 0 1em}
h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:1.8em 0 .6em}
a{color:var(--link)}
.act{display:flex;gap:.75rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.75rem .9rem;margin-bottom:.55rem}
.act .t{flex:1;min-width:0}
.act .n{font-weight:600}
.act .d{font-size:.83rem;color:var(--mut)}
button,.btn{font:inherit;font-size:.9rem;padding:.45rem 1rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;white-space:nowrap}
button:active{transform:translateY(1px)}
.go{background:var(--link);border-color:var(--link);color:#fff}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.bar{display:flex;gap:.8rem;align-items:center;font-size:.85rem;color:var(--mut);margin-bottom:1rem;flex-wrap:wrap}
.bar form{margin:0}
`;

const PAGE = (title, body) =>
  '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(title) + '</title><style>' + CSS + '</style><main>' + body + '</main></html>';

// 這支 daemon 被掛在哪個前綴底下，是**由請求告訴它的**，不是寫死的。
//
// 經過 Caddy 進來的是 /_/run/...（node 的站台設定把 /_/run 轉過來），
// 直接打它自己的埠則是 /run/...（edge 沒有把它掛在 Caddy 底下）。
// 同一支程式要在兩種入口下都產生正確的連結，唯一可靠的來源就是 req 自己。
//
// 寫死成 /_/run 會讓「直接打 9001」那條路徑的頁面連結全部 404；
// 寫死成 /run 則是經過 Caddy 那條全部 404。所以兩個都不能寫死。
const BASE_RE = /^(?:\/_)?\/run/;
const baseOf = (pathname) => (BASE_RE.exec(pathname) || ['/run'])[0];

const runForm = (base, id, label, cls) =>
  '<form method="POST" action="' + base + '/' + encodeURIComponent(id) + '">' +
  '<button class="' + (cls || '') + '">' + label + '</button></form>';

async function panel(base) {
  const acts = await listActions();
  if (!acts.length) {
    return PAGE('Actions', '<h1>Actions</h1><p>' + esc(ACTIONS_DIR) + ' 裡還沒有腳本。</p>' +
      '<p class="bar"><a href="/_/a/">用 WebDAV 編輯 actions 目錄 →</a></p>');
  }
  let body = '<h1>Actions</h1><div class="bar"><a href="/">🏠 首頁</a>' +
    '<a href="/_/a/">📝 編輯 actions</a><span>' + acts.length + ' 個</span></div>';
  let group = null;
  for (const h of acts) {
    if (h.group !== group) { group = h.group; if (group) body += '<h2>' + esc(group) + '</h2>'; }
    // @page 的是一頁，不是一個動作 —— 給連結，不要給「執行」按鈕。
    // 按鈕會 POST，而一支頁面腳本第一次被打開時該收到的是 GET。
    const go = h.page
      ? '<a class="btn go" href="' + base + '/' + encodeURIComponent(h.id) + '">開啟</a>'
      : runForm(base, h.id, '執行', 'go');
    body += '<div class="act"><div class="t"><div class="n">' + esc(h.title) + '</div>' +
      '<div class="d">' + esc(h.desc || h.file) + '</div></div>' + go + '</div>';
  }
  return PAGE('Actions', body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, type, body) =>
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);

  if (!ipAllowed(req.socket.remoteAddress)) {
    return send(403, 'text/plain; charset=utf-8', 'forbidden');
  }
  if (TOKEN && url.searchParams.get('token') !== TOKEN && req.headers['x-action-token'] !== TOKEN) {
    return send(403, 'text/plain; charset=utf-8', 'bad token');
  }

  const base = baseOf(url.pathname);
  const seg = decodeURIComponent(url.pathname.replace(BASE_RE, '').replace(/^\//, '')).replace(/\/+$/, '');
  if (!seg) return send(200, 'text/html; charset=utf-8', await panel(base));

  const act = (await listActions()).find(h => h.id === seg || h.file === seg);
  if (!act) return send(404, 'text/plain; charset=utf-8', 'no such action: ' + seg);

  const wantsJson = url.searchParams.has('json');
  const wantsHtml = !wantsJson && /text\/html/.test(req.headers.accept || '');

  // @page 的 action：它自己就是一個網頁。
  //
  // actiond 平常做的是「跑完把 log 貼出來」—— 輸出會被 esc 進 <pre>，而請求裡
  // 的任何東西都不給腳本。@page 把這兩件事都反過來：method、query string 和
  // 表單 body 交給腳本，stdout 原樣當 HTML 送出去。
  //
  // 於是「一個檔案 = 一個網址」對動態頁也成立：丟一支 .mjs 進 actions 目錄就
  // 有一頁，不用開埠、不用寫 .caddy 片段、不用 reload，也沒有常駐行程要顧。
  //
  // 代價要講明白：**輸入的驗證變成腳本自己的責任**。actiond 只負責轉交，
  // 它不知道那支腳本收什麼形狀的東西。所以 @page 的腳本要把收到的東西
  // 一律當成不可信的。這條在 DESIGN.md 的「為什麼這樣是安全的」裡。
  if (act.page) {
    const body = await readBody(req);
    if (body === null) return send(413, 'text/plain; charset=utf-8', '請求太大');
    // 單飛鎖（running）不套用在頁面上：兩個 GET 不該互相 409。
    const r = await run(act, {
      body,
      env: {
        ACTION_METHOD: req.method,
        ACTION_QUERY: url.search.replace(/^\?/, ''),
        // 腳本要拿這個組自己的 <form action>。前綴是請求告訴我們的，
        // 不是寫死的 —— 理由見上面 BASE_RE 那段。
        ACTION_SELF: base + '/' + act.id,
      },
    });
    if (r.code !== 0) {
      return send(500, 'text/html; charset=utf-8', PAGE(act.title,
        '<h1>' + esc(act.title) + '</h1>' +
        '<p class="bad">這一頁的腳本以 exit ' + r.code + ' 結束。</p>' +
        '<pre>' + esc(r.output || '(沒有輸出)') + '</pre>' +
        '<p class="bar"><a href="' + base + '">← 所有 action</a></p>'));
    }
    return send(200, 'text/html; charset=utf-8', r.stdout);
  }

  // @confirm 的 action：用 GET 開網址時只給確認頁，
  // 避免瀏覽器預抓／聊天軟體展開連結預覽就把它觸發掉。
  if (req.method === 'GET' && act.confirm && !url.searchParams.has('force')) {
    return send(200, 'text/html; charset=utf-8', PAGE(act.title,
      '<h1>' + esc(act.title) + '</h1><p>' + esc(act.desc || act.file) + '</p><p>' +
      runForm(base, act.id, '確定執行', 'go') + '</p><p class="bar"><a href="' + base + '">← 返回</a></p>'));
  }

  if (running.has(act.id)) {
    return send(409, 'text/plain; charset=utf-8', act.id + ' 還在執行中');
  }

  running.add(act.id);
  const r = await run(act).finally(() => running.delete(act.id));
  const ok = r.code === 0;

  if (wantsJson) {
    return send(ok ? 200 : 500, 'application/json; charset=utf-8',
      JSON.stringify({ action: act.id, exit: r.code, ms: r.ms, output: r.output }, null, 2));
  }
  if (wantsHtml) {
    return send(ok ? 200 : 500, 'text/html; charset=utf-8', PAGE(act.title,
      '<h1>' + esc(act.title) + '</h1><div class="bar">' +
      '<span class="' + (ok ? 'ok' : 'bad') + '">exit ' + r.code + '</span>' +
      '<span>' + r.ms + ' ms</span><a href="' + base + '">← 所有 action</a>' +
      runForm(base, act.id, '再跑一次') + '</div>' +
      '<pre>' + esc(r.output || '(沒有輸出)') + '</pre>'));
  }
  return send(ok ? 200 : 500, 'text/plain; charset=utf-8',
    act.id + ' exit=' + r.code + ' ' + r.ms + 'ms\n\n' + r.output);
});

server.listen(PORT, HOST, () =>
  console.log('actiond listening on http://' + HOST + ':' + PORT + '  actions=' + ACTIONS_DIR));
