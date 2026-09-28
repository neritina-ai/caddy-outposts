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
//      # @only-when-logged-on <- 沒有人登入就不要執行，見下面「執行身分」那段
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
import { spawn, spawnSync, execSync, execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
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

// =============================================================================
//  執行身分：有人登入就以那個人的身分跑，沒有就以服務帳號跑
//
//  actiond 自己是 NT AUTHORITY\LocalService —— 不是管理員，也不是使用者。那是
//  刻意的（actions 目錄等於可以用 HTTP 觸發的程式碼），但它有兩個使用者看得見的
//  後果：產生的檔案 owner 不是他，而且被明確設過權限的目錄寫不進去。
//
//  所以預設**盡量過橋**：橋是一個以登入中的使用者身分執行的排程工作，拿到的是
//  互動式登入那個「過濾過的」token —— 是那個人，但不是管理員。沒有人登入的時候
//  就退回直接執行，這樣 caddy-reload / host-health 這些不需要使用者的 action
//  在「人不在家、網站壞了」的時候仍然能用。需要使用者才有意義的 action 自己標
//  @only-when-logged-on，沒人登入時直接回錯誤，不要跑出一個看起來成功的空答案。
//
//  BRIDGE_USER 空字串 = 整個橋停用，一律直接執行（沒有註冊橋的機器就是這樣）。
const BRIDGE_USER = (process.env.BRIDGE_USER || '').split('\\').pop().trim();
const BRIDGE_TASK = process.env.BRIDGE_TASK || 'caddy-bridge';
const CADDY_DIR   = process.env.CADDY_DIR || path.resolve(ACTIONS_DIR, '..');
const BRIDGE_DIR  = process.env.BRIDGE_DIR || path.join(CADDY_DIR, 'actiond', 'bridge');
// 橋接排出去之後等多久算它沒回應。偵測說有人登入卻等不到，多半是 session 剛好在
// 登出的路上 —— 退回直接執行比卡住好。
const BRIDGE_WAIT = Number(process.env.BRIDGE_WAIT_MS || 15000);

// reg 問一次約 12ms，但一個頁面可能連續問好幾次，所以短暫快取。
// 快取太久會在使用者剛登出時把工作往一個不存在的 session 丟（那會靜靜地逾時）。
let loginCache = { at: 0, value: false };
const LOGIN_CACHE_MS = 2000;

// 一支 SID 對到哪個 profile 目錄不會變，所以查過就記住。
const sidProfiles = new Map();

const REG_EXE = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\reg.exe';
const PROFILE_LIST = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList';

function regQuery(args) {
  try {
    return decodeOutput(execFileSync(REG_EXE, args,
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch (e) {
    // 機碼不存在的時候離開碼是非零，訊息在 stdout 上
    return e && e.stdout ? decodeOutput(e.stdout) : '';
  }
}

// 「那個使用者的 session 還在不在」——問的不是「有沒有人登入」。
//
// 問法是「他的登錄 hive 還掛著嗎」：互動式登入的時候 Windows 把那個人的 hive 掛進
// HKEY_USERS\<SID>，登出就卸載。橋是綁在特定帳號上的排程工作，所以「主控台現在是
// 誰」不是我們要的問題 —— 切換使用者之後原本的 session 還在，橋照樣跑得動。
//
// **不要換回 quser**：Windows 家庭版根本沒有那支程式（qwinsta 也沒有，同一個 RDS
// 元件）。少了它，execSync 丟 ENOENT、stdout 是空的，於是偵測一口咬定沒有人登入，
// 那台機器的每一支 action 都退回服務帳號執行 —— 而且是安靜地退，只有輸出末尾那句
// 「尚未登入」會透露。reg.exe 每一版 Windows 都有。
//
// 前置偵測是必要的，不是最佳化：**沒有人登入時 Start-ScheduledTask 照樣回報成功**
// （實測 108ms、不報錯），工作只是安靜地沒有跑，所以事後看結果是問不出來的。
//
// 其他實測淘汰掉的做法見 DESIGN.md。共通點是它們都必須用 actiond 真正的身分
// （LocalService）去測才算數 —— 拿自己的帳號測會得到相反的結論。
function userLoggedOn() {
  if (!BRIDGE_USER) return false;
  const now = Date.now();
  if (now - loginCache.at < LOGIN_CACHE_MS) return loginCache.value;
  const want = BRIDGE_USER.toLowerCase();
  const found = mountedHives().some(sid => {
    const leaf = profileLeaf(sid);
    // 改過名的帳號，profile 目錄可能留著 alice.MYPC 或 alice.000 這種尾巴
    return leaf === want || leaf.startsWith(want + '.');
  });
  loginCache = { at: now, value: found };
  return found;
}

// 現在掛在 HKEY_USERS 底下的使用者 hive。S-1-5-21 開頭的才是真人帳號（服務帳號是
// S-1-5-18/19/20），而每個 hive 旁邊還有一個 <SID>_Classes 要濾掉。
function mountedHives() {
  return regQuery(['query', 'HKU']).split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => /\\S-1-5-21-[\d-]+$/.test(l))
    .map(l => l.split('\\').pop());
}

// SID -> profile 目錄的名字。讀的是 HKLM 底下的 ProfileList，不是那個人自己的
// hive —— 服務進得去前者、進不去後者（讀 HKU\<SID>\Volatile Environment 拿到的是
// SecurityException，實測）。所以這裡只能拿到目錄名，拿不到帳號名。
function profileLeaf(sid) {
  if (sidProfiles.has(sid)) return sidProfiles.get(sid);
  const out = regQuery(['query', PROFILE_LIST + '\\' + sid, '/v', 'ProfileImagePath']);
  // 路徑可能有空白（C:\Users\John Smith），所以不能照空白切最後一段
  const m = /ProfileImagePath\s+REG_\w+\s+(.+?)\s*$/mi.exec(out);
  const leaf = m ? m[1].split(/[\\/]/).pop().toLowerCase() : '';
  sidProfiles.set(sid, leaf);
  return leaf;
}

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
    const meta = { id, file: f, ext, title: id, desc: '', group: '', confirm: false,
                   page: false, needsLogin: false };
    try {
      const head = (await readFile(path.join(ACTIONS_DIR, f), 'utf8')).split(/\r?\n/).slice(0, 25);
      for (const line of head) {
        const m = /^\s*(?:#|\/\/|rem)\s*@(title|desc|group|confirm|page|only-when-logged-on)\b[ \t]*(.*)$/i.exec(line);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        const on = v === '' || /^(1|true|yes)$/i.test(v);
        if (k === 'only-when-logged-on') meta.needsLogin = on;
        else if (k === 'confirm' || k === 'page') meta[k] = on;
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

function runDirect(cmd, args, ctx) {
  return new Promise(resolve => {
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

// 排一個工作給橋，等它回來。協定寫在 actiond\bridge-runner.ps1 的檔頭。
//
// 這裡跟 runDirect 有一個講清楚的差別：**stdout 和 stderr 的交錯順序會消失**。
// 橋把兩條管線分別寫成兩個檔（@page 要拿 stdout 當網頁送出去，混到 stderr 就
// 壞了），所以合起來給 log 看的那份只能是「先全部 stdout、再全部 stderr」。
// 直接執行那條路仍然保留真正的時間順序。
async function runViaBridge(cmd, args, ctx) {
  const started = Date.now();
  const id  = randomUUID().replace(/-/g, '').slice(0, 12);
  const tmp = path.join(BRIDGE_DIR, '.tmp-' + id);
  const dir = path.join(BRIDGE_DIR, id);

  try {
    await mkdir(tmp, { recursive: true });
    if (ctx) await writeFile(path.join(tmp, 'stdin.bin'), ctx.body || '', 'utf8');
    await writeFile(path.join(tmp, 'job.json'), JSON.stringify({
      exe: cmd, args, cwd: ACTIONS_DIR,
      env: ctx ? ctx.env : null,
      hasStdin: !!ctx,
    }), 'utf8');
    // 改名是不可分割的：runner 永遠不會看到寫到一半的工作。
    await rename(tmp, dir);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { failed: true, code: -1, ms: Date.now() - started,
             output: '排入橋接失敗：' + e.message, stdout: '' };
  }

  // schtasks 比 powershell 輕。它的離開碼**不能當作「工作真的跑了」**——
  // 沒有人登入的時候它照樣回報成功（實測），所以下面靠 done.json 為準。
  try { spawnSync('schtasks.exe', ['/run', '/tn', BRIDGE_TASK], { windowsHide: true }); } catch { /* 下面會逾時 */ }

  const donePath = path.join(dir, 'done.json');
  const deadline = Date.now() + Math.min(BRIDGE_WAIT, TIMEOUT);
  let done = null;
  while (Date.now() < deadline) {
    try { done = JSON.parse(await readFile(donePath, 'utf8')); break; } catch { /* 還沒好 */ }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!done) {
    // 工作可能還在跑；讓掃除機制去收，不要現在刪掉它正在寫的檔。
    return { failed: true, code: -1, ms: Date.now() - started,
             output: '橋接沒有在 ' + Math.min(BRIDGE_WAIT, TIMEOUT) + 'ms 內回應', stdout: '' };
  }

  let out = Buffer.alloc(0), err = Buffer.alloc(0);
  try { out = await readFile(path.join(dir, 'stdout.bin')); } catch { /* 空的 */ }
  try { err = await readFile(path.join(dir, 'stderr.bin')); } catch { /* 空的 */ }
  await rm(dir, { recursive: true, force: true }).catch(() => {});

  return {
    code: done.exit, ms: Date.now() - started,
    output: decodeOutput(Buffer.concat([out, err])),
    stdout: decodeOutput(out),
  };
}

// 逾時或 actiond 重啟會留下沒人收的工作目錄。半小時後掃掉，免得無限長大。
async function sweepBridge() {
  let names;
  try { names = await readdir(BRIDGE_DIR); } catch { return; }
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const n of names) {
    const p = path.join(BRIDGE_DIR, n);
    try {
      const st = await stat(p);
      if (st.mtimeMs < cutoff) await rm(p, { recursive: true, force: true });
    } catch { /* 別人正在動它就下次再說 */ }
  }
}

// 選一條路執行。`online` 由呼叫端決定並傳進來，因為同一個請求裡要用同一個答案
// （先拿它擋掉 @only-when-logged-on，再拿它選路，兩處必須一致）。
async function run(act, ctx, online) {
  const file = path.join(ACTIONS_DIR, act.file);
  const [cmd, args] = RUNNERS[act.ext](file);
  if (online) {
    const r = await runViaBridge(cmd, args, ctx);
    if (!r.failed) return { ...r, viaBridge: true };
    // 偵測說有人登入，橋卻沒回應 —— 多半是 session 正在登出的路上。
    // 標記過的 action 不能退回去用服務身分跑（那正是它標記的原因）。
    if (act.needsLogin) return { ...r, viaBridge: false };
  }
  const r = await runDirect(cmd, args, ctx);
  return { ...r, viaBridge: false };
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
@keyframes spin{to{transform:rotate(1turn)}}
.busy{opacity:.85;pointer-events:none}
.busy::before{content:'';display:inline-block;width:.75em;height:.75em;margin-right:.45em;vertical-align:-.05em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
`;

// 按下去到結果回來之間可能隔很久 —— 腳本本身最長跑 ACTION_TIMEOUT（預設兩分鐘），
// 走橋的還要加上派工往返，而失敗的那種往往是等好等滿才放棄。這段時間頁面完全沒有
// 變化，手機上連分頁那個載入指示都幾乎看不見，於是使用者以為沒按到、再按一次 ——
// 變成同一支 action 跑兩遍。
//
// 所以送出的當下就把按鈕換成轉圈的「執行中…」，並且擋掉後續的送出。
//
// 兩個細節：
//   * 擋第二次按用的是 CSS 的 pointer-events:none，**不是 disabled**。在 submit
//     事件處理器裡把按鈕設成 disabled，有些瀏覽器會連帶把這次送出一起取消掉 ——
//     那會變成按鈕轉著圈、action 卻根本沒跑，比原本的問題更糟。鍵盤送出繞得過
//     pointer-events，所以 data-busy 那個旗標是第二道。
//   * pageshow 那段是給「看完結果按返回鍵」用的：bfcache 把頁面連同忙碌狀態一起
//     還原，沒有這段的話回到面板會看到一排轉著圈、按不下去的按鈕。
const BUSY_JS = `
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.dataset.busy) { e.preventDefault(); return; }
  f.dataset.busy = '1';
  const b = f.querySelector('button');
  if (!b) return;
  b.dataset.label = b.textContent;
  b.textContent = '執行中…';
  b.classList.add('busy');
});
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a.btn');
  if (!a || a.dataset.busy) return;
  a.dataset.busy = '1';
  a.dataset.label = a.textContent;
  a.textContent = '開啟中…';
  a.classList.add('busy');
});
addEventListener('pageshow', () => {
  document.querySelectorAll('[data-busy]').forEach(el => {
    delete el.dataset.busy;
    const t = el.tagName === 'FORM' ? el.querySelector('button') : el;
    if (!t) return;
    t.classList.remove('busy');
    if (t.dataset.label) t.textContent = t.dataset.label;
  });
});
`;

const PAGE = (title, body) =>
  '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(title) + '</title><style>' + CSS + '</style><main>' + body + '</main>' +
  '<script>' + BUSY_JS + '</script></html>';

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

// 使用者看得懂的話，不是機制。「這個結果是 LocalService 執行的」對按按鈕的人
// 是廢話 —— 他不知道 LocalService 是誰，也不該需要知道。講後果就好。
const OFFLINE_NOTE = user =>
  user + ' 尚未登入，這個結果可能不完整';
const OFFLINE_REFUSED = user =>
  '這個動作需要 ' + user + ' 登入才有意義，目前沒有人登入，所以沒有執行。';

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

  // 整個請求只問一次，兩個地方用同一個答案：擋 @only-when-logged-on，以及選路。
  const online = userLoggedOn();

  // 標記過的 action：沒有人登入就不要跑。跑得出來的會是一個「看起來成功的空答案」
  // ——那比明講錯誤更糟，因為使用者分不出「真的沒東西」和「我看不到你的東西」。
  if (act.needsLogin && !online) {
    const why = OFFLINE_REFUSED(BRIDGE_USER || '使用者');
    if (wantsJson) {
      return send(503, 'application/json; charset=utf-8', JSON.stringify(
        { action: act.id, error: 'not-logged-on', message: why }, null, 2));
    }
    if (wantsHtml || act.page) {
      // 兩個選項，便宜的先講。**重開機不做成主要按鈕**：那是一把大槌子，放在一則
      // 小錯誤旁邊會教出「不能用就重開」的習慣，而且手機上很容易誤觸。
      // （真的點下去也還有一層 —— reboot 帶 @confirm，GET 只會拿到確認頁。）
      //
      // 而且只有那支 action 真的存在才給連結。寫死一個不存在的網址，使用者點下去
      // 得到 404，比不給連結更糟。
      const hasReboot = (await listActions()).some(h => h.id === 'reboot');
      const opts =
        '<li>在那台機器上登入 —— 你人在旁邊的話這個最快，而且不會打斷別的東西</li>' +
        (hasReboot
          ? '<li>沒辦法碰到那台機器的話，<a href="' + base + '/reboot">重新開機</a>' +
            '（這台設了自動登入，開機後會自己登入；會先出確認頁）</li>'
          : '');
      return send(503, 'text/html; charset=utf-8', PAGE(act.title,
        '<h1>' + esc(act.title) + '</h1><p class="bad">' + esc(why) + '</p>' +
        '<p>要讓它能用：</p><ul>' + opts + '</ul>' +
        '<p class="bar"><a href="' + base + '">← 所有 action</a>' +
        '<span>不需要使用者的 action 現在照樣能用</span></p>'));
    }
    return send(503, 'text/plain; charset=utf-8', why);
  }

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
    }, online);
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
  const r = await run(act, null, online).finally(() => running.delete(act.id));
  const ok = r.code === 0;
  // 沒走成橋 = 這次是以服務身分跑的，看不到使用者的東西。講一聲，不要讓差異是安靜的。
  const note = (BRIDGE_USER && !r.viaBridge) ? OFFLINE_NOTE(BRIDGE_USER) : '';

  if (wantsJson) {
    return send(ok ? 200 : 500, 'application/json; charset=utf-8',
      JSON.stringify({ action: act.id, exit: r.code, ms: r.ms,
                       viaBridge: !!r.viaBridge, note: note || undefined,
                       output: r.output }, null, 2));
  }
  if (wantsHtml) {
    return send(ok ? 200 : 500, 'text/html; charset=utf-8', PAGE(act.title,
      '<h1>' + esc(act.title) + '</h1><div class="bar">' +
      '<span class="' + (ok ? 'ok' : 'bad') + '">exit ' + r.code + '</span>' +
      '<span>' + r.ms + ' ms</span><a href="' + base + '">← 所有 action</a>' +
      runForm(base, act.id, '再跑一次') + '</div>' +
      (note ? '<p class="bad">' + esc(note) + '</p>' : '') +
      '<pre>' + esc(r.output || '(沒有輸出)') + '</pre>'));
  }
  return send(ok ? 200 : 500, 'text/plain; charset=utf-8',
    act.id + ' exit=' + r.code + ' ' + r.ms + 'ms' +
    (note ? '\n' + note : '') + '\n\n' + r.output);
});

server.listen(PORT, HOST, () => {
  console.log('actiond listening on http://' + HOST + ':' + PORT + '  actions=' + ACTIONS_DIR);
  if (BRIDGE_USER) {
    console.log('  使用者身分橋接：' + BRIDGE_USER + ' 透過排程工作 ' + BRIDGE_TASK +
                '（' + BRIDGE_DIR + '）');
    // 偵測要是壞了，它會安靜地把每一支 action 都退回服務帳號執行，所以啟動時先講
    // 一次現在看到什麼 —— 這一行對不對，開機當下就能發現。
    console.log('  登入偵測：' + (userLoggedOn() ? BRIDGE_USER + ' 登入中' : '目前沒有人登入'));
  } else {
    console.log('  沒有設定 BRIDGE_USER —— 每個 action 都以服務帳號執行');
  }
  sweepBridge().catch(() => {});
  setInterval(() => { sweepBridge().catch(() => {}); }, 10 * 60 * 1000).unref();
});
