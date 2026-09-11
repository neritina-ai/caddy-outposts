#!/usr/bin/env node
// =============================================================================
//  caddyctl —— 一次設定一台機器，或一個網域
//
//    node src/caddyctl.mjs node init
//    node src/caddyctl.mjs edge init  --token <duckdns token>
//    node src/caddyctl.mjs edge set   --name myfiles --ip 10.0.0.2 --password alice:秘密
//    node src/caddyctl.mjs edge set   --name mysite
//    node src/caddyctl.mjs edge set   --name mysite --content C:\Web
//    node src/caddyctl.mjs edge set   --name later  --hold
//    node src/caddyctl.mjs edge remove --name myfiles
//    node src/caddyctl.mjs list
//
//  沒有中央設定檔，也沒有祕密檔。
//
//  狀態就是「跑著的設定」本身：一個網域一個 conf\sites\<label>.caddy，
//  非祕密的描述放 conf\manifest.json，duckdns token 只存在 conf\global.caddy 裡
//  （它本來就得在那裡，Caddy 要用）。所以：
//
//    * 加一台機器只會新增一個檔，不會動到別台的設定
//    * 移除一台就是刪掉那個檔
//    * 你的工作機上不留任何東西 —— 沒有 fleet.json 要維護，沒有 secrets.json 要保護
//
//  唯一跨網域的東西是 global.caddy 裡 dynamic_dns 的網域清單（少一個那個網域就
//  不會更新 IP），而它是從 conf\sites\ 的檔名推出來的，不必另外記。
//
//  --dir 預設 C:\Caddy。要幫「還沒安裝的機器」先備好設定，就指到一個暫存目錄，
//  弄好之後整包複製過去。
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import {
  CADDY_DIR, DNS_PROVIDER, DNS_SUFFIX, fqdn, NODE_DEFAULTS, nodeLayout,
  renderGlobal, renderEdgeSite, renderNodeSite, pluginsFor, urlMap, edgeContentDefault, NODE_SITE,
  posix, win, LOG_DIR, CONFIG_FILES, renderConfigIndex, renderPanel, REMEMBER_COOKIE,
} from './render.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 參數
const argv = process.argv.slice(2);

function die(msg) {
  console.error('錯誤：' + msg);
  process.exit(1);
}

// 支援重複出現的旗標（--password、--password-hash）
function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    const next = args[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (out[name] === undefined) out[name] = value;
    else if (Array.isArray(out[name])) out[name].push(value);
    else out[name] = [out[name], value];
  }
  return out;
}
const many = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------- 旗標檢查
//
// 未知的旗標一律報錯，不要安靜忽略。
//
// 理由是這個工具最不該安靜失敗的那件事：`--pasword 123` 少一個 s，如果被忽略，
// 產生出來的是一個**沒有密碼的站**，而使用者以為自己設了密碼。錯字要當場知道，
// 不是上線之後才發現。
//
// 每個指令的合法旗標寫在下面這張表，改指令時記得一起改 —— 漏列會讓合法的用法
// 被誤擋，所以這張表本身也要跟著測。
const MUTATING = ['dir', 'reload'];
const CRED = ['password', 'password-hash'];
const SPEC = {
  'list':        ['dir'],
  'reload':      ['dir'],
  'node init':   [...MUTATING, 'drive', 'port', 'listen', 'machine', 'static', 'home', 'no-home'],
  'edge init':   [...MUTATING, 'token', 'machine'],
  'edge set':    [...MUTATING, ...CRED, 'name', 'ip', 'content', 'hold', 'message'],
  'edge remove': [...MUTATING, 'name'],
  'auth set':    [...MUTATING, ...CRED, 'name', 'path'],
  'auth list':   ['dir', 'name'],
  'auth remove': [...MUTATING, 'name', 'path'],
};

// 編輯距離，只用來猜「你是不是要打這個」。夠短就自己寫，不值得多一個相依。
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                         d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function checkFlags(cmd, f) {
  const known = SPEC[cmd];
  if (!known) return;
  const bad = Object.keys(f).filter((k) => k !== '_' && !known.includes(k));
  if (f._.length) {
    die('這個指令不吃位置參數：' + f._.join(' ') + '\n'
      + '  每個值都要跟著旗標，例如 --name ' + f._[0]);
  }
  if (!bad.length) return;
  const lines = bad.map((k) => {
    const near = known
      .map((g) => [g, editDistance(k, g)])
      .filter(([, d]) => d <= 2)
      .sort((x, y) => x[1] - y[1])[0];
    return '  --' + k + (near ? '   <- 是不是要打 --' + near[0] + '？' : '');
  });
  die('不認識的旗標：\n' + lines.join('\n')
    + '\n\n  ' + cmd + ' 認得的是：\n    '
    + known.map((k) => '--' + k).join('  '));
}

// ---------------------------------------------------------------- 狀態
const manifestPath = (dir) => join(dir, 'conf', 'manifest.json');
const globalPath = (dir) => join(dir, 'conf', 'global.caddy');
const sitesDir = (dir) => join(dir, 'conf', 'sites');
const sitePath = (dir, label) => join(sitesDir(dir), label + '.caddy');

function loadState(dir) {
  const p = manifestPath(dir);
  if (!existsSync(p)) {
    return { machine: os.hostname(), roles: [], node: null, edge: null };
  }
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    die(p + ' 讀不了：' + e.message);
  }
}

// duckdns token 只有一份，就在 global.caddy 裡 —— Caddy 本來就要用它。
// 不另外存一份，就沒有第二個地方會外洩。
function readToken(dir) {
  const p = globalPath(dir);
  if (!existsSync(p)) return null;
  const m = new RegExp('^acme_dns ' + DNS_PROVIDER + ' (\\S+)$', 'm').exec(readFileSync(p, 'utf8'));
  return m ? m[1] : null;
}

// conf/sites/ 裡有哪些網域 —— 底線開頭的是 node 自己的站，不是網域
const labelsOnDisk = (dir) =>
  existsSync(sitesDir(dir))
    ? readdirSync(sitesDir(dir))
        .filter((f) => f.endsWith('.caddy') && !f.startsWith('_'))
        .map((f) => f.slice(0, -6))
    : [];

// 先檢查存不存在，再 mkdir。
//
// recursive:true 只吞得下 EEXIST。對一個**已經存在但沒有寫入權**的目錄呼叫
// mkdir，拿到的是 EPERM，於是使用者看到的是一句「mkdir 失敗」，而真正的問題是
// 權限 —— 訊息指錯地方。先檢查存在性，錯誤就會落在真正寫檔的那一行。
// （--dir 指到一台唯讀的 SMB 分享時實際遇到。）
function ensureDir(p) {
  if (existsSync(p)) return;
  mkdirSync(p, { recursive: true });
}

function writeText(p, text) {
  ensureDir(dirname(p));
  writeFileSync(p, text, 'utf8');
}

// nodeLayout 回傳的是 posix 寫法，manifest 要 Windows 寫法。
//
// static 的機器沒有掛載點。這裡一定要如實反映 —— manifest 是給機器上的 AI 讀的，
// 留著 p / w 等於告訴它「可以往 D:\projects 寫」，而那些路由根本不存在。
function winPaths(L, isStatic) {
  return {
    content_root: win(L.content_root),
    actions_mount: isStatic ? null : L.actions_mount,
    mounts: isStatic
      ? {}
      : Object.fromEntries(Object.entries(L.mounts).map(([k, v]) => [k, win(v)])),
  };
}

function saveState(dir, state) {
  const roles = state.roles;
  const full = {
    machine: state.machine,
    roles,
    // 一律寫機器上的真實路徑。--dir 只是「現在把檔案產生到哪」，
    // 產生到暫存目錄再整包複製過去的話，內容必須已經是對的。
    caddy_dir: win(CADDY_DIR),
    conf_dir: win(CADDY_DIR + '/conf'),
    apps_dir: win(CADDY_DIR + '/apps'),
    actions_dir: win(CADDY_DIR + '/actions'),
    log_dir: win(LOG_DIR),
    // 版面是從 drive 算出來的，但還是整份寫進 manifest —— 讀的人（AI、安裝程式）
    // 要的是可以直接用的絕對路徑，不是一條要自己套的規則。
    node: state.node
      ? { ...state.node, ...winPaths(nodeLayout(state.node.drive), state.node.static),
          url_map: urlMap(state.node) }
      : null,
    edge: state.edge,
    plugins: pluginsFor(roles),
    dns: { provider: DNS_PROVIDER, suffix: DNS_SUFFIX },
  };
  // 非 ASCII 一律寫成 \uXXXX。**檔案位元組必須是純 ASCII**：PowerShell 5.1 的
  // Get-Content 讀沒有 BOM 的 UTF-8 會當成系統 ANSI（中文版是 Big5），一個全形
  // 字元就足以讓 ConvertFrom-Json 整份失敗 —— 而安裝程式正是靠這個檔決定要下載
  // 哪個建置。JSON 的 \uXXXX 逃脫剛好兩全：檔案是 ASCII，值仍然是原字
  // （PS 5.1 的 ConvertFrom-Json 解得回來，實測過）。
  //
  // 沒有這一段的話，家目錄或機器名有中文的人（C:\Users\陳大文）會被擋在
  // node init 之外，而且錯誤訊息看起來像是我們不支援他。
  const json = JSON.stringify(full, null, 2)
    .replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';

  // 逃脫之後理論上不可能再有非 ASCII，但還是留著這道守衛 —— 它擋的是
  // 「將來有人改了序列化方式」，那種錯誤安靜起來代價很大。
  const bad = json.split('\n').filter((l) => /[^\x00-\x7F]/.test(l));
  if (bad.length) {
    die('manifest.json 不能有非 ASCII 字元（PowerShell 5.1 會讀成 Big5）：\n  ' + bad.join('\n  '));
  }
  writeText(manifestPath(dir), json);
}

// global.caddy 每次加減網域都要重寫 —— dynamic_dns 要列出全部網域。
function rewriteGlobal(dir, state, token) {
  const t = token || readToken(dir);
  if (state.roles.includes('edge') && !t) {
    die('找不到 duckdns token。先執行：caddyctl edge init --token <token>');
  }
  writeText(globalPath(dir), renderGlobal({ roles: state.roles, token: t, labels: labelsOnDisk(dir) }));
}

// Caddyfile 骨架是產品的固定邏輯，直接從 repo 複製，不產生。
// /c/ 的索引頁。放在 conf\ 而不是內容根目錄，因為它是**產生出來的**，
// 跟 global.caddy、sites\*.caddy 同一類 —— 每次 node init 重寫，不是使用者的內容。
// （放進 D:\www 的話會落進 install.ps1 那條「已存在就保留不覆蓋」的規則裡，
// 從此再也不會更新。）
//
// 頁面裡每一行都包在 {{if fileExists}} 裡，由 Caddy 在瀏覽時判斷，所以在這台
// 裝了新工具不必重跑這裡 —— 只有「產品的清單本身變長了」才需要重新產生。
function writeConfigIndex(dir, state, node) {
  const p = join(dir, 'conf', 'configs.html');
  if (!node.home) {
    if (existsSync(p)) rmSync(p);
    return;
  }
  writeText(p, renderConfigIndex(state.machine));
}

// Caddyfile 骨架 —— **一律覆蓋，不是「不存在才寫」。**
//
// 這個檔是產品提供的（開頭就寫著「不要編輯」），裡面是 snippet 定義，
// 所有跟這台機器有關的東西都在 conf\ 底下。**不能寫成 if (exists) return**：
// 那樣的話產品加了新的 snippet，既有機器永遠拿不到 —— install.ps1 也只檢查
// 它在不在，不會更新。git pull 之後重跑 node init 看起來成功，實際上還在用
// 舊骨架。（實測踩到：加了 (cfgfile) 之後 reload 直接報 "File to import not
// found: cfgfile"。硬錯誤算幸運的，換成別種改動就是安靜地跑舊行為。）
// Markdown 渲染樣板。**由 caddyctl 寫，不是 install.ps1。**
//
// conf\ 底下的東西全是 caddyctl 的產物，這個不該是例外。放在 install.ps1 的話，
// 更新它就要管理員 + 重跑安裝 —— 而 install.ps1 的設計是「一台機器一輩子只跑
// 這一次」，之後所有變更都該能用 caddyctl 完成。放這裡，git pull 之後
// node init --reload 就更新到了。
//
// 一律覆蓋：它是產品的檔案。要改樣式就改 repo 裡的 templates\www\md.html。
function writeMdTemplate(dir) {
  writeText(join(dir, 'conf', 'md.html'),
            readFileSync(join(REPO, 'templates', 'www', 'md.html'), 'utf8'));
}

function writeSkeleton(dir) {
  writeText(join(dir, 'Caddyfile'), readFileSync(join(REPO, 'templates', 'Caddyfile'), 'utf8'));
}

const addRole = (state, role) => {
  if (!state.roles.includes(role)) state.roles = [...state.roles, role].sort();
};

// ---------------------------------------------------------------- 密碼
// 密碼用 stdin 餵給 caddy.exe，不放在 argv —— argv 在 Windows 上任何一個本機
// 使用者都看得到（Get-CimInstance Win32_Process）。
function hashPassword(dir, plaintext) {
  // C:\Caddy\caddy.exe 一定要找 —— 用 --dir 產到暫存目錄時，那個目錄裡是沒有
  // caddy.exe 的，但這台機器上（裝過的話）一定有一份在釘死的位置。
  const candidates = [join(dir, 'caddy.exe'), win(CADDY_DIR) + '\\caddy.exe',
                      join(REPO, 'caddy.exe'), 'caddy'];
  for (const exe of candidates) {
    if (exe !== 'caddy' && !existsSync(exe)) continue;
    try {
      // 結尾的換行不能省 —— caddy 是讀「一行」，沒有換行它會等到 EOF
      // 然後直接 `Error: EOF` 失敗（實測過）。
      const out = execFileSync(exe, ['hash-password'],
        { input: plaintext + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const hash = out.trim().split(/\r?\n/).pop();
      if (hash && hash.startsWith('$')) return hash;
    } catch { /* 換下一個 */ }
  }
  die('找不到能用的 caddy.exe 來算密碼雜湊。\n'
    + '  改用 --password-hash <雜湊>，或先在有 caddy.exe 的機器上跑 caddy hash-password。');
}

// ---------------------------------------------------------------- 指到自己
// 這台機器所有的名字與位址。用來認出「--ip 指到 edge 自己」。
function selfAddresses() {
  const s = new Set(['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase()]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) s.add(a.address.toLowerCase());
  }
  return s;
}

// edge 把一個網域轉給「自己的 80/443」= 請求繞回同一個 Caddy，同一個 site 區塊，
// 無限迴圈。而且就算不迴圈也拿不到想要的東西：WebDAV、.md 渲染、/_/run
// 都在 node 那一側，edge 上根本沒有那些 directive。
//
// 指到自己的**別的埠**是正當用法（把本機的一個 app 開一個網域出去），不擋。
function refuseSelfProxy(target, label, defaultContent) {
  const i = target.lastIndexOf(':');
  const [host, port] = [target.slice(0, i), target.slice(i + 1)];
  if (port !== '80' && port !== '443') return;
  if (!selfAddresses().has(host.toLowerCase())) return;
  die(target + ' 是這台機器自己 —— 轉過去會繞回同一個 Caddy，變成無限迴圈。\n\n'
    + '  edge 這台沒有 node 的功能：WebDAV、.md 自動渲染、/_/run 都在 node\n'
    + '  那一側。edge 自己能提供的只有 static file server。\n\n'
    + '  要在這台服務內容：\n'
    + '    caddyctl edge set --name ' + label + '\n'
    + '        （預設 ' + defaultContent + '）\n'
    + '    caddyctl edge set --name ' + label + ' --content <目錄>\n\n'
    + '  要完整功能：在另一台機器跑 caddyctl node init + install.ps1,\n'
    + '  再用 --ip 指到那一台。');
}

// 憑證一律寫成 [帳號:]值。
//
// HTTP Basic Auth 的帳號是協定的一部分（送出去的是 base64(帳號:密碼)），拿不掉。
// 但「帳號」對自己架站的人幾乎沒有意義 —— 逼他每次想一次「這個 user 是什麼」，
// 換來的只是把一個字拆成兩個旗標。所以：
//
//   --password 123              -> 帳號用 label，密碼 123
//   --password police:123       -> 帳號 police，密碼 123
//
// 分隔符號用冒號而不是斜線，兩個理由：跟 --password-hash 帳號:雜湊 同一個形狀，
// 而且 base64 的字元集含 / 不含 : —— 貼一組隨機密碼進來不會被誤切。
//
// 只切第一個冒號，所以密碼裡後面還有冒號是沒問題的（alice:a:b -> alice / a:b）。
//
// 唯一表達不出來的是「帳號用 label，而密碼的第一段又剛好含冒號」。那種情況用
// --password-hash：自己跑 caddy hash-password（它從 stdin 讀，什麼字元都吃），
// 再寫成 <label>:<雜湊> —— bcrypt 雜湊不含冒號，所以永遠切得乾淨。
// 為了這個少見的情況多留一個 --user，等於把「帳號是什麼」這個問題又搬回檯面上。
function splitCred(raw, label) {
  const s = String(raw);
  const i = s.indexOf(':');
  return i < 0 ? [label, s] : [s.slice(0, i), s.slice(i + 1)];
}

// caddy hash-password 產出的形狀：$2<變體>$<成本>$<22 字元 salt + 31 字元雜湊>。
// 兩種變體都收（2a / 2b / 2y），總長固定 60。
const BCRYPT = /^\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}$/;

function usersFrom(f, dir, label) {
  const users = {};
  for (const raw of many(f['password-hash'])) {
    if (typeof raw !== 'string') die('--password-hash 要給值，格式是 [帳號:]<雜湊>');
    const [u, h] = splitCred(raw, label);
    if (!u || !h) die('--password-hash 格式不對（要 [帳號:]<雜湊>）：' + raw);
    // 不檢查的話，明文會被原樣寫進 basic_auth，變成一個**永遠登不進去的站**，
    // 而且沒有任何錯誤訊息 —— 要等到有人真的去登入才會發現。
    if (!BCRYPT.test(h)) {
      die('--password-hash 的值不是 bcrypt 雜湊：' + h + '\n\n'
        + '  bcrypt 長這樣（60 個字元）：\n'
        + '    $2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG\n\n'
        + (h.includes('$')
            ? '  看起來像雜湊但格式不對。用 caddy hash-password 重新產一次。'
            : '  這看起來是明文密碼 —— 那要用 --password：\n'
              + '    --password ' + (raw.includes(':') ? raw : label + ':' + raw)));
    }
    users[u] = h;
  }
  for (const raw of many(f.password)) {
    if (typeof raw !== 'string') die('--password 要給值，格式是 [帳號:]<密碼>');
    const [u, p] = splitCred(raw, label);
    if (!u || !p) die('--password 格式不對（要 [帳號:]<密碼>）：' + raw);
    // 反過來也擋：把算好的雜湊餵給 --password 會再雜湊一次，
    // 產生一個「可以驗證但沒人知道密碼」的憑證。
    if (BCRYPT.test(p)) {
      die('--password 收到的是一個 bcrypt 雜湊，不是密碼。\n'
        + '  它會被再雜湊一次，產生一組沒有人知道原始密碼的憑證。\n'
        + '  已經有雜湊的話用：--password-hash ' + raw);
    }
    users[u] = hashPassword(dir, p);
  }
  return users;
}

// ---------------------------------------------------------------- 指令
async function cmdNodeInit(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);

  // 目錄名稱是固定的（www / projects / workspaces），只有磁碟機代號可以換。
  // 唯一真實存在的需求是「這台沒有 D: 槽」，所以就只給這一個旋鈕。
  let drive = state.node?.drive || NODE_DEFAULTS.drive;
  if (f.drive) {
    drive = String(f.drive).replace(/[:\\/]+$/, '').toUpperCase();
    if (!/^[A-Z]$/.test(drive)) die('--drive 要給一個磁碟機代號，例如 --drive E:');
    if (!existsSync(drive + ':\\')) die('這台機器沒有 ' + drive + ': 槽');
  }

  // 沒給的旗標沿用現有設定，所以再跑一次 node init 是安全的。
  //
  // --static 是例外，而且是刻意的：它不是一個「值」，是這台機器的**形狀**。
  // 形狀用宣告的 —— 指令說什麼就是什麼，沒說 --static 就是完整功能。
  // 兩個互斥的旗標（--static / --full）只是把同一個布林拆成兩個要記的名字。
  // 代價是「原本 static 的機器跑一次沒帶旗標的 node init 會變回全功能」，
  // 所以下面會把形狀的變化明講出來，不讓它安靜發生。
  const wasStatic = Boolean(state.node?.static);
  const isStatic = Boolean(f.static);
  const node = {
    drive,
    listen: String(f.listen || state.node?.listen || NODE_DEFAULTS.listen),
    actiond_port: Number(f.port || state.node?.actiond_port || NODE_DEFAULTS.actiond_port),
    static: isStatic,
    // /c/ 要用的家目錄。**一定要在這裡抓，不能留給安裝程式或 Caddy 去解。**
    // caddyctl 是使用者自己跑的，os.homedir() 就是那個人的家目錄；而 Caddy 是以
    // 服務身分執行的，它的 %USERPROFILE% 是 LOCAL SYSTEM 或那個服務帳號的，
    // 指到別的地方去。所以在這裡定案，寫進設定檔。
    //
    // --home 是給例外情況的（把設定備給另一台、或家目錄不在預設位置）。
    // --no-home 則是不要 /c/ 這個功能。
    home: f['no-home'] ? null : posix(String(f.home || state.node?.home || os.homedir())),
  };

  addRole(state, 'node');
  state.node = node;
  if (f.machine) state.machine = String(f.machine);

  writeSkeleton(dir);
  writeText(join(sitesDir(dir), '_node.caddy'), renderNodeSite(node));
  writeConfigIndex(dir, state, node);
  writeMdTemplate(dir);
  writeText(join(dir, 'conf', 'panel.html'), renderPanel(state.machine, node));
  rewriteGlobal(dir, state);
  saveState(dir, state);

  console.log('node 設定好了 -> ' + dir + (isStatic ? '  [static]' : ''));
  // 形狀變了就明講。--static 是宣告式的，所以沒帶旗標重跑會把 static 變回
  // 全功能 —— 那等於把 /p/ /w/ 和根目錄重新變成可寫入，不能安靜發生。
  if (state.node && wasStatic !== isStatic) {
    console.log(isStatic
      ? '\n⚠ 這台從「完整功能」改成 static：/p/ /w/ /a/ 的 WebDAV 掛載點沒有了，根目錄變唯讀。'
      : '\n⚠ 這台從 static 改回「完整功能」：/p/ /w/ /a/ 的 WebDAV 掛載點回來了，根目錄可寫入。'
        + '\n  只是想改別的設定的話，記得把 --static 一起帶上。');
  }
  for (const [u, p] of Object.entries(urlMap(node))) console.log('  ' + u.padEnd(8) + ' ' + p);
  // 掛載點的目錄不存在 = 那個網址安靜地變成 404。現在講一聲，比之後對著
  // 空白頁面查半天好 —— 尤其是換過磁碟機的情況。
  // 只檢查真的是路徑的東西：actions_mount 是前綴名稱不是路徑。
  const L = nodeLayout(drive);
  const watched = isStatic ? [L.content_root] : [L.content_root, ...Object.values(L.mounts)];
  const missing = watched.filter((p) => !existsSync(win(p)));
  if (missing.length) {
    console.log('\n這些目錄還不存在（install.ps1 會建內容根目錄，其餘要自己建）：');
    for (const m of missing) console.log('  ' + win(m));
  }
  await after(dir, state, f);
}

async function cmdEdgeInit(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  const token = f.token ? String(f.token) : readToken(dir);
  if (!token) die('第一次設定 edge 要給 token：--token <duckdns token>');

  addRole(state, 'edge');
  if (!state.edge) state.edge = { domains: {} };
  if (f.machine) state.machine = String(f.machine);

  writeSkeleton(dir);
  ensureDir(sitesDir(dir));
  rewriteGlobal(dir, state, token);
  saveState(dir, state);

  console.log('edge 設定好了 -> ' + dir);
  // 加網域的說明只有在「已經裝好、可以馬上做」的時候才印。
  // 還沒裝服務的機器下一步是 install.ps1 —— 這時候丟一大段 edge set 出來，
  // 讀的人會以為那才是下一步（實際踩到過）。
  if (isInstalled()) edgeAddHelp();
  await after(dir, state, f);
}

function edgeAddHelp() {
  console.log('\n加網域。一個網域只要決定「背後是什麼」，三選一：');
  console.log('  caddyctl edge set --name <label> [--content <目錄>]');
  console.log('      這台自己服務靜態內容。不給 --content 就用 '
    + win(edgeContentDefault(NODE_DEFAULTS.drive, '<label>')));
  console.log('  caddyctl edge set --name <label> --ip <位址[:埠]>');
  console.log('      轉給另一台 node（公開網站、WebDAV、.md 渲染都在那一側）');
  console.log('  caddyctl edge set --name <label> --hold');
  console.log('      先佔著，之後再指派主機（回 503，但憑證照樣簽發與續期）');
  console.log('\n前兩種可以要密碼：');
  console.log('  --password <密碼>                 帳號自動用 <label>');
  console.log('  --password <帳號>:<密碼>          要自己指定帳號就加冒號');
  console.log('  --password-hash [帳號:]<雜湊>     已經有 bcrypt 雜湊就用這個');
  console.log('  （可重複，一組帳號一個旗標）');
  console.log('\n密碼保護的是 /_/ 底下那台機器本身（可寫入的 WebDAV、/_/run）。');
  console.log('不給密碼就是「內容公開」—— 那個網域的 /_/* 會整段關閉，不會裸奔。');
  console.log('要把 / 底下某一條路徑關起來，用 caddyctl auth set --path。');
  console.log('\n完整說明：caddyctl --help');
}

// 記住登入用的祕密。
//
// **只存在 conf\sites\<label>.caddy 裡，不進 manifest.json。** 跟 bcrypt 雜湊
// 同一條規則：manifest 是要給機器上的 AI 讀的（見 skill/SKILL.md），裡面只放
// 非祕密的描述。
//
// 所以要沿用舊值就從那個檔讀回來 —— 這也是 README 教人救回忘記的密碼雜湊的
// 同一招。edge set 是「整份取代」，但這串亂數不是使用者指定的設定，
// 每次改個 IP 就把所有裝置踢出去說不過去，所以有就沿用。
function readRemember(dir, label) {
  const p = sitePath(dir, label);
  if (!existsSync(p)) return null;
  const m = new RegExp(REMEMBER_COOKIE + '=([0-9a-f]{64})').exec(readFileSync(p, 'utf8'));
  return m ? m[1] : null;
}

// 32 bytes 的 CSPRNG，寫成 hex —— cookie 值和 Caddyfile 字串都不必跳脫。
const newRemember = () => randomBytes(32).toString('hex');

async function cmdEdgeSet(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  if (!state.roles.includes('edge')) die('這台還不是 edge。先執行：caddyctl edge init --token <token>');

  const label = String(f.name || '');
  if (!label) die('要給 --name <label>');
  if (label.includes('.')) {
    die('網域只要寫 label（例如 "myfiles"），不要寫完整的 ' + fqdn('myfiles') + '。收到的是 "' + label + '"');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) die('label 只能用小寫英數字和連字號：' + label);

  const modes = ['ip', 'content', 'hold'].filter((k) => f[k] !== undefined);
  if (modes.length > 1) {
    die('--ip / --content / --hold 只能給一個，收到：' + modes.map((m) => '--' + m).join(' '));
  }

  // 預設的內容目錄。這台如果也是 node 就沿用它的磁碟機，否則用預設的 D:。
  const drive = state.node?.drive || NODE_DEFAULTS.drive;
  const defaultContent = win(edgeContentDefault(drive, label));

  let def;
  if (f.ip) {
    const target = String(f.ip).includes(':') ? String(f.ip) : String(f.ip) + ':80';
    refuseSelfProxy(target, label, defaultContent);
    // 不給密碼是合法的，而且不危險：那台機器本身在 /_/ 底下，而沒有密碼的
    // 網域**不路由 /_/***（見 renderEdgeSite）。所以「沒給密碼」的意思很單純
    // —— 那台的公開網站要公開。
    def = { mode: 'proxy', target, users: usersFrom(f, dir, label) };
  } else if (f.hold) {
    def = { mode: 'hold' };
    if (f.message) def.message = String(f.message);
  } else {
    // 什麼模式都沒給 = 這台自己服務靜態內容。
    //
    // 「沒給 --content」不代表「不要 file server」—— 都已經指定一個網域了，
    // 那個網址總得有東西回應。所以預設是 serve，只是目錄用預設值；
    // --content 只是換一個目錄，不是開關。
    const content = typeof f.content === 'string' ? win(f.content) : defaultContent;
    def = { mode: 'serve', content, users: usersFrom(f, dir, label) };
  }

  // 有密碼才需要記住登入。沿用舊的祕密，沒有就產生一個 —— 不然每次
  // edge set（改 IP、換目錄）都會把所有裝置踢出去。
  if (Object.keys(def.users || {}).length) def.remember = readRemember(dir, label) || newRemember();
  writeText(sitePath(dir, label), renderEdgeSite(label, def));

  state.edge.domains = state.edge.domains || {};
  const before = state.edge.domains[label] || null;
  // 這裡**只放非祕密的描述**。密碼雜湊只存在 conf\sites\<label>.caddy 裡，
  // 因為 manifest.json 是要給機器上的 AI 讀的（見 skill/SKILL.md）。
  state.edge.domains[label] = {
    fqdn: fqdn(label),
    mode: def.mode,
    target: def.target || null,
    content: def.content || null,
    apps_dir: def.mode === 'serve' ? win(CADDY_DIR + '/apps/' + label) : null,
    auth: Object.keys(def.users || {}),
  };
  rewriteGlobal(dir, state);
  saveState(dir, state);

  const now = state.edge.domains[label];
  console.log((before ? '取代了 ' : '加上了 ') + fqdn(label) + '  ' + describe(now));
  // 目錄不存在 = 那個網址安靜地變成 404。跟著上面那行講，它是在描述同一件事。
  if (def.mode === 'serve' && !existsSync(def.content)) {
    console.log('  這個目錄還不存在，先建起來再放內容：' + def.content);
  }

  // set 是「整份取代」，不是合併 —— 這次沒給的旗標就是沒有，不會沿用上次的。
  // 所以少打一個旗標會安靜地換掉一件事：少 --password 會變成公開的，
  // 少 --content 會換到預設目錄（然後整站 404）。
  //
  // 每一項變動都列出來，不要只挑「我覺得重要的」那幾種講 —— 使用者少打的
  // 剛好是哪一個，事先不知道。這是這個動詞叫 set 而不是 add 的另一半責任。
  if (before) {
    const was = (v) => v || '無';
    const who = (a) => (a.length ? a.join('、') : '無（公開）');
    const changes = [];
    if (before.mode !== now.mode) changes.push('模式    ' + before.mode + ' -> ' + now.mode);
    if (before.content !== now.content) {
      changes.push('內容目錄  ' + was(before.content) + ' -> ' + was(now.content));
    }
    if (before.target !== now.target) {
      changes.push('轉給    ' + was(before.target) + ' -> ' + was(now.target));
    }
    if (who(before.auth) !== who(now.auth)) {
      changes.push('帳號    ' + who(before.auth) + ' -> ' + who(now.auth));
    }
    if (changes.length) {
      console.log('\n這些地方跟原本不一樣：');
      for (const c of changes) console.log('  ' + c);
    }
    // 密碼沒了要更大聲：其他變動最多是壞掉，這一項是「還能用，但沒有門鎖」。
    if (before.auth.length && !now.auth.length) {
      console.log('\n⚠ 這個網域原本要密碼，現在是公開的 —— 任何人都看得到。');
      console.log('  set 是整份取代，不是合併。重下的時候要把原本的旗標都帶上。');
    }
  }

  await after(dir, state, f);
}

// ---------------------------------------------------------------- 個別路徑的密碼
//
// 整站的密碼是 edge set --password。這一組是「站裡面某條路徑另外要一組密碼」——
// 例如一個公開的網站底下，有一個目錄只給特定的人看。
//
// 不分 edge / node：edge 上是某個網域，node 上是它自己那個站。差別只有要不要
// --name，因為 node 只有一個站。
const authDirFor = (dir, label) => join(dir, 'conf', 'auth', label);
const AUTH_HEAD = '# 這個檔案是 caddyctl auth 產生的 —— 不要手動編輯。\n';

// 檔名只求穩定好認，真正的來源是檔案裡的 "# path:" 那一行 ——
// 所以 slug 撞到也不會弄錯是哪條路徑。
function pathSlug(p) {
  const s = p.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s || 'root';
}

// 這台的哪一個站。node 只有一個，所以 --name 可以省。
function authTarget(f, state) {
  if (typeof f.name === 'string') {
    const label = f.name;
    if (state.roles.includes('edge') && !state.edge?.domains?.[label]) {
      const have = Object.keys(state.edge?.domains || {});
      die('這台沒有名叫 "' + label + '" 的網域。'
        + (have.length ? '\n  有的是：' + have.join('、') : '\n  用 caddyctl edge set 先加一個。'));
    }
    return label;
  }
  if (state.roles.includes('node')) return NODE_SITE;
  const have = Object.keys(state.edge?.domains || {});
  die('這台是 edge，有好幾個網域，要用 --name 指定是哪一個。'
    + (have.length ? '\n  有的是：' + have.join('、') : ''));
}

// 一個路徑一個檔。回傳 [{ file, path, users: [帳號…] }]
function readAuthRules(dir, label) {
  const d = authDirFor(dir, label);
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith('.caddy'))
    .map((file) => {
      const text = readFileSync(join(d, file), 'utf8');
      const m = /^# path: (.+)$/m.exec(text);
      // 帳號在 basic_auth 區塊裡，一行一組「帳號 雜湊」。只取帳號 ——
      // 雜湊絕不往外印，它跟 manifest 一樣屬於「不該進 AI 上下文」的東西。
      const users = [...text.matchAll(/^\t(\S+) \S+$/gm)].map((x) => x[1]);
      return { file, path: m ? m[1] : null, users };
    })
    .filter((r) => r.path);
}

async function cmdAuthSet(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  const label = authTarget(f, state);

  const path = String(f.path || '');
  if (!path) die('要給 --path <路徑>，例如 --path /reports/*');
  // Git Bash（MSYS）會把看起來像 Unix 絕對路徑的參數轉成 Windows 路徑，
  // 所以 --path /reports 會變成 C:/Program Files/Git/reports 送進來。
  // 直接說出來，不然使用者會盯著自己明明打對的指令發呆。（實測踩到。）
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    die('--path 收到的是一個 Windows 路徑：' + path + '\n'
      + '  這是 Git Bash 的路徑轉換造成的 —— 它會把 /reports 這種參數改寫成\n'
      + '  C:/Program Files/Git/reports。三種解法：\n'
      + '    * 改用 PowerShell 執行\n'
      + '    * 或在前面多加一個斜線：--path //reports\n'
      + '    * 或設 MSYS_NO_PATHCONV=1');
  }
  if (!path.startsWith('/')) die('--path 要以 / 開頭：' + path);

  const users = usersFrom(f, dir, label === NODE_SITE ? state.machine : label);
  if (!Object.keys(users).length) {
    die('要給密碼：--password [帳號:]<密碼>\n'
      + '  沒有密碼的「個別路徑規則」沒有意義 —— 那就是不要加這條規則。');
  }

  const rules = readAuthRules(dir, label);
  const existing = rules.find((r) => r.path === path);
  let file = existing ? existing.file : pathSlug(path) + '.caddy';
  // slug 撞到別條路徑就往後加號碼。真正認路徑靠檔案裡的 "# path:"。
  for (let n = 2; !existing && rules.some((r) => r.file === file); n++) {
    file = pathSlug(path) + '-' + n + '.caddy';
  }

  const lines = [AUTH_HEAD + '# path: ' + path, '', 'basic_auth ' + path + ' {'];
  for (const [u, h] of Object.entries(users)) lines.push('\t' + u + ' ' + h);
  lines.push('}', '');
  writeText(join(authDirFor(dir, label), file), lines.join('\n'));

  console.log((existing ? '更新了 ' : '加上了 ') + where(label, state)
    + '  ' + path + '  帳號：' + Object.keys(users).join('、'));

  // 整站已經有密碼的話，訪客會遇到兩層挑戰 —— 瀏覽器對這種情況的行為很難預期。
  const siteUsers = label === NODE_SITE ? [] : (state.edge?.domains?.[label]?.auth || []);
  if (siteUsers.length) {
    console.log('\n注意：這個網域整站已經有密碼了（' + siteUsers.join('、') + '）。');
    console.log('  這條路徑會變成「兩組都要過」，而不是「改用這一組」。');
    console.log('  想讓某條路徑用不同的密碼，比較乾淨的做法是另開一個網域。');
  }
  await after(dir, state, f);
}

function cmdAuthList(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  const labels = typeof f.name === 'string'
    ? [authTarget(f, state)]
    : [...(state.roles.includes('node') ? [NODE_SITE] : []),
       ...Object.keys(state.edge?.domains || {})];

  let found = 0;
  for (const label of labels) {
    const rules = readAuthRules(dir, label);
    if (!rules.length) continue;
    found += rules.length;
    console.log(where(label, state));
    for (const r of rules) console.log('  ' + r.path.padEnd(24) + ' 帳號：' + r.users.join('、'));
  }
  if (!found) console.log('沒有任何個別路徑的密碼規則。用 caddyctl auth set 加一條。');
}

async function cmdAuthRemove(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  const label = authTarget(f, state);
  const path = String(f.path || '');
  if (!path) die('要給 --path <路徑>');

  const rules = readAuthRules(dir, label);
  const hit = rules.find((r) => r.path === path);
  if (!hit) {
    die('這個站沒有 "' + path + '" 的規則。'
      + (rules.length ? '\n  有的是：' + rules.map((r) => r.path).join('、')
                      : '\n  它本來就沒有任何個別路徑的密碼。'));
  }
  rmSync(join(authDirFor(dir, label), hit.file));
  console.log('移除了 ' + where(label, state) + '  ' + path);
  console.log('  那條路徑現在跟這個站的其他地方一樣了。');
  await after(dir, state, f);
}

const where = (label, state) =>
  label === NODE_SITE ? state.machine + ' 自己的站' : fqdn(label);

async function cmdEdgeRemove(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  const label = String(f.name || '');
  if (!label) die('要給 --name <label>');
  if (!existsSync(sitePath(dir, label))) die('沒有這個網域：' + label);

  rmSync(sitePath(dir, label));
  if (state.edge?.domains) delete state.edge.domains[label];
  rewriteGlobal(dir, state);
  saveState(dir, state);

  console.log('移除了 ' + fqdn(label));
  console.log('  注意：它也一併退出 dynamic_dns 了，DNS 紀錄不會再更新。');
  await after(dir, state, f);
}

const nUsers = (d) => (d.auth ? d.auth.length : Object.keys(d.users || {}).length);
const describe = (d) =>
  d.mode === 'proxy' ? '-> ' + d.target + (nUsers(d) ? '（要密碼）' : '（公開，不需要密碼）')
  : d.mode === 'serve' ? '本機服務 ' + d.content + (nUsers(d) ? '（要密碼）' : '（公開，不需要密碼）')
  : d.mode === 'hold' ? '佔位（503，但憑證會正常簽發與續期）'
  : d.mode;

// ---------------------------------------------------------------- 套用
//
// 為什麼要有這個指令：改設定的每一步都有工具，只有最後「讓它生效」要人去打一串
// curl.exe -X POST http://127.0.0.1:9001/run/caddy-reload —— 那個埠還會因為角色
// 而不同。長、容易打錯，而且對讀 SKILL.md 的 AI 來說是流程裡唯一的斷點。
//
// 這裡不自己做 validate 或 reload：那兩件事是 caddy-reload 這個 action 做的
// （先 validate，失敗就完全不動作）。這個指令只負責「叫對的那個網址」。
async function cmdReload(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);

  if (resolve(dir).toLowerCase() !== resolve(win(CADDY_DIR)).toLowerCase()) {
    die('--dir 指到的是暫存目錄，不是這台正在跑的設定。\n'
      + '  先把 ' + dir + ' 的內容複製到那台的 ' + win(CADDY_DIR) + '，再到那台執行 reload。');
  }
  if (!isInstalled()) {
    die('這台還沒裝服務，沒有東西可以 reload。\n'
      + '  先用「系統管理員」執行：.\\src\\install.ps1');
  }
  await doReload(state);
}

async function doReload(state) {
  const url = reloadUrl(state);
  console.log('POST ' + url);
  let res;
  try {
    res = await fetch(url, { method: 'POST' });
  } catch (e) {
    // Node 的 fetch 對外一律只說 "fetch failed"，真正的原因（ECONNREFUSED…）
    // 包在 cause 裡。不挖出來的話這個錯誤訊息等於沒說。
    const why = e.cause?.message || e.cause?.code || e.message;
    die('叫不到 action daemon：' + why + '\n'
      + '  它跑著嗎？  Get-Service actiond\n'
      + '  看 log：    ' + win(CADDY_DIR) + '\\logs\\actiond.log');
  }
  const body = (await res.text()).trim();
  if (body) console.log(body);
  // action 用 exit code 表示成敗，actiond 把它轉成 HTTP 狀態碼。
  // validate 沒過的話上面那段 body 就是 caddy 的錯誤訊息 —— 原樣印出來最有用。
  if (!res.ok) {
    console.error('\n沒有套用任何變更，站台仍在跑舊設定。');
    process.exit(1);
  }
}

function cmdList(f) {
  const dir = resolve(f.dir ? String(f.dir) : win(CADDY_DIR));
  const state = loadState(dir);
  console.log(state.machine + '  [' + (state.roles.join(', ') || '還沒設定') + ']  ' + dir);
  if (state.node) {
    console.log('\nnode：');
    for (const [u, p] of Object.entries(urlMap(state.node))) console.log('  ' + u.padEnd(8) + ' ' + p);
  }
  if (state.edge) {
    const doms = Object.entries(state.edge.domains || {});
    console.log('\nedge：' + doms.length + ' 個網域');
    for (const [label, d] of doms) {
      console.log('  ' + fqdn(label).padEnd(28) + describe(d));
    }
  }
}

// install.ps1 跑過了沒有 —— caddy.exe 是它下載的，服務也是它裝的。
// 只看釘死的 C:\Caddy：--dir 指到暫存目錄的情況由 after() 的另一條分支處理。
const isInstalled = () => existsSync(join(win(CADDY_DIR), 'caddy.exe'));

// 套用設定要打哪個網址。
//
// node 的站台設定裡有一條 /_/run 轉給 actiond，所以打 80 就行。
// **純 edge 沒有那條** —— 它服務的是一個個對外網域，而 /_/* 只在那個網域
// 有密碼時才路由。所以 edge 要直接打 actiond 自己的埠，而它只聽 loopback。
//
// 兩個入口的路徑不同：經過 Caddy 是 /_/run（node 的掛載點），直接打埠是
// /run（actiond 自己的根）。actiond 兩種都認得（見 server.mjs 的 BASE_RE），
// 但這裡還是要給對，因為 Caddy 那一側只有 /_/run 這條 handle。
function reloadUrl(state) {
  if (state.roles.includes('node')) return 'http://127.0.0.1/_/run/caddy-reload';
  const port = state.node?.actiond_port || NODE_DEFAULTS.actiond_port;
  return 'http://127.0.0.1:' + port + '/run/caddy-reload';
}

// 「下一步做什麼」只有這一個地方講，因為答案取決於三種狀態，
// 而每個指令結束時使用者要的都是同一句話。
//
// --reload 也在這裡處理：改設定的指令大多只有一個，「改一次 + 套用」本來就該是
// 一個動作。分好幾步改的話就最後一步加 --reload，或最後單獨跑 caddyctl reload。
// 放在這裡的好處是每個會改設定的指令自動都有，不必各自實作一次。
async function after(dir, state, f) {
  const local = resolve(dir).toLowerCase() === resolve(win(CADDY_DIR)).toLowerCase();
  if (!local) {
    console.log('\n把 ' + dir + ' 的內容複製到那台的 ' + win(CADDY_DIR) + '，然後在那台 reload。');
    if (f?.reload) console.log('（--reload 這裡沒有作用：要套用的是那台，不是這台。）');
    return;
  }
  // 還沒裝服務就沒有東西可以 reload。這時候的下一步是 install.ps1，
  // 而它會用這份設定啟動服務 —— 設定不會白寫。
  if (!isInstalled()) {
    console.log('\n這台還沒裝服務。接下來用「系統管理員」開 PowerShell：');
    console.log('    .\\src\\install.ps1');
    console.log('  它會下載 caddy.exe、裝服務，並用你剛寫的這份設定啟動。');
    if (f?.reload) console.log('（--reload 這裡沒有作用：服務還沒裝，沒有東西可以重載。）');
    return;
  }
  if (!f?.reload) {
    console.log('\n要生效：node src\\caddyctl.mjs reload');
    return;
  }
  console.log('');
  await doReload(state);
}

const USAGE = `caddyctl —— 一次設定一台機器，或一個網域

  node src/caddyctl.mjs node init [選項]
      --drive <代號>   放在哪個槽，預設 ${NODE_DEFAULTS.drive}:
                       目錄名稱是固定的：<槽>\\www <槽>\\projects <槽>\\workspaces
      --static         這台只服務靜態檔：沒有 /p/ /w/ /a/ 的 WebDAV 掛載點，
                       根目錄唯讀。/run 保留，所以隨時可以改回來。
                       **這是宣告式的**：沒帶 --static 重跑就是完整功能。
      --port <n>       actiond 的埠，預設 ${NODE_DEFAULTS.actiond_port}
      --machine <名稱> 這台在 manifest 裡的名字，預設是電腦名稱

    通常什麼都不用給。再跑一次是安全的：沒寫的旗標沿用現有設定。

  node src/caddyctl.mjs edge init --token <duckdns token>

  node src/caddyctl.mjs edge set --name <label> [模式]
      （不給）                  這台自己服務靜態內容，目錄預設
                                ${win(edgeContentDefault(NODE_DEFAULTS.drive, '<label>'))}
      --content <目錄>          同上，但自己指定目錄
      --ip <位址[:埠]>          轉給另一台 node —— WebDAV、.md 渲染、
                                /run 只有 node 那一側有
      --hold                    還沒指派主機（503 佔位，但憑證照樣簽發）
    加上（可選）—— 不加就是公開的，任何人都看得到：
      --password [帳號:]<密碼>  可重複，一組帳號一個旗標。
                                沒有冒號就用 <label> 當帳號：
                                  --password 123        -> <label> / 123
                                  --password police:123 -> police  / 123
      --password-hash [帳號:]<雜湊>
                                同上，但直接給 caddy hash-password 算好的
                                bcrypt 雜湊（$2a$…，60 個字元）。餵明文會被擋。
                                只切第一個冒號，所以密碼後半含冒號沒問題

  node src/caddyctl.mjs edge remove --name <label>

  站裡面某條路徑要另外一組密碼（不分 edge / node）：

  node src/caddyctl.mjs auth set    --path <路徑> --password [帳號:]<密碼> [--name <label>]
  node src/caddyctl.mjs auth list   [--name <label>]
  node src/caddyctl.mjs auth remove --path <路徑> [--name <label>]

    例：一個公開的網站，底下有個目錄只給特定的人看
      caddyctl auth set --path /reports/* --password police:123

    --name 在 node 上可以省（只有一個站）；edge 上要指定是哪個網域。
    規則存在 conf\\auth\\<站>\\，跟站台設定分開 ——
    conf\\sites\\<label>.caddy 每次 edge set 都會重寫，密碼放那裡會消失。

  node src/caddyctl.mjs reload      套用設定變更（先 validate，沒過就完全不動作）
  node src/caddyctl.mjs list        這台現在長怎樣

  全域：
    --dir <目錄>    預設 ${win(CADDY_DIR)}。指到暫存目錄就能先幫別台備好設定。
    --reload        改完順便套用，等同接著跑一次 caddyctl reload。
                    只改一個地方時用它，兩個指令併成一個。分好幾步改就
                    只在最後一步加，或最後單獨跑 caddyctl reload。

密碼會用 stdin 餵給 caddy.exe 去算雜湊，不會出現在行程清單裡；
但 --password 本身會留在你的指令歷史裡，在意的話就用 --password-hash。`;

// ---------------------------------------------------------------- 進入點
const [group, verb] = argv;
const f = flags(argv.slice(2));

if (!group || group === '--help' || group === '-h' || group === 'help') {
  console.log(USAGE);
  process.exit(0);
}
// 指令名稱先解出來，旗標檢查才有依據 —— 而且檢查一定在做事之前，
// 打錯字的話一個檔案都不會被寫。
const single = ['list', 'reload'].includes(group);
const cmd = single ? group : [group, verb].filter(Boolean).join(' ');
const args = single ? flags(argv.slice(1)) : f;

if (!SPEC[cmd]) {
  console.error('不認識的指令：' + argv.join(' ') + '\n');
  console.error(USAGE);
  process.exit(1);
}
checkFlags(cmd, args);

if (cmd === 'list') cmdList(args);
else if (cmd === 'reload') await cmdReload(args);
else if (cmd === 'node init') await cmdNodeInit(args);
else if (cmd === 'edge init') await cmdEdgeInit(args);
else if (cmd === 'edge set') await cmdEdgeSet(args);
else if (cmd === 'edge remove') await cmdEdgeRemove(args);
else if (cmd === 'auth set') await cmdAuthSet(args);
else if (cmd === 'auth list') cmdAuthList(args);
else if (cmd === 'auth remove') await cmdAuthRemove(args);
