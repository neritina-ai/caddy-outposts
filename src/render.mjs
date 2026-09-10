// =============================================================================
//  設定檔算繪器 —— 純函式，不碰檔案系統。
//
//  這裡是「產品的固定邏輯」跟「這台機器的資料」交會的地方。caddyctl.mjs 負責
//  讀寫磁碟與命令列，這裡只負責把資料變成 Caddyfile 片段。
//
//  切開的理由：算繪要能單獨測，而且 edge 的每個網域都必須是**自給自足**的一個
//  檔案 —— 加一台機器不會動到別台的檔案，這是整個設計的前提。
// =============================================================================

// ---------------------------------------------------------------------------
//  C:\Caddy 是硬性規定，不是預設值。
//
//  這套東西會裝一個 /caddy 技能到機器上，給在那裡工作的 AI 看，而技能文件必須
//  寫得出可以直接照抄的路徑。如果 caddy 目錄可以自己訂，文件就只能寫成
//  <CADDY_DIR>\apps\ —— 讀到佔位符的 AI 是解不出真實路徑的。
//
//  所以整套系統只釘死一個點，而且釘死的是「能找到其他一切的那個點」：
//      C:\Caddy\conf\manifest.json
//  其餘位置（內容根目錄、掛載點、log）都還能自訂，因為從固定點查得到。
// ---------------------------------------------------------------------------
export const CADDY_DIR = 'C:/Caddy';

// 只支援 duckdns。不是因為 Caddy 只能用 duckdns，而是因為我們只實際驗證過它 ——
// 假裝支援所有 DNS 商是不誠實的。要換就 fork 去改這三個常數，以及安裝時下載的
// caddy-dns 外掛。
export const DNS_SUFFIX = '.duckdns.org';
export const DNS_PROVIDER = 'duckdns';
export const DNS_PLUGIN = 'github.com/caddy-dns/duckdns';
export const fqdn = (label) => label + DNS_SUFFIX;

// node 的版面：**目錄名稱是固定的，只有磁碟機代號可以換。**
//
// 唯一真實存在的需求是「這台沒有 D: 槽」，那用一個 --drive 就解決了。
// 讓每個目錄都能各自指定，換來的是四五個旗標、一堆互相矛盾的組合
// （內容在 F: 但掛載點在 E:），以及文件裡再也寫不出具體路徑。不划算。
//
// 想擺得更自由的人可以 fork，或直接手寫一個 apps\*.caddy 掛自己的目錄 ——
// 那條路一直都在，而且不必動這裡。
export const NODE_DEFAULTS = { drive: 'D', listen: ':80', actiond_port: 9001 };

export function nodeLayout(drive) {
  const d = String(drive).replace(/[:\\/]+$/, '').toUpperCase() + ':';
  return {
    content_root: d + '/www',
    public_dir: d + '/www/public',
    mounts: { p: d + '/projects', w: d + '/workspaces' },
    actions_mount: 'a',
  };
}

// 個別路徑的密碼（caddyctl auth）。
//
// 為什麼獨立成檔，不寫進 conf/sites/<label>.caddy：**那個檔每次 edge set 都會被
// 整個重寫**。密碼寫在裡面，下次改個 IP 或換個目錄就安靜消失了 —— 而消失的是門鎖。
//
// glob 匹配不到任何檔案不會出錯：node 的樣板本來就 import "…/apps/*.caddy"，
// 而空的 apps 目錄一直跑得好好的。
//
// node 自己的站用 _node —— 底線開頭在這個產品裡一律代表「不是網域」。
export const AUTH_DIR = CADDY_DIR + '/conf/auth';
export const NODE_SITE = '_node';
export const authImport = (label) => 'import ' + q(AUTH_DIR + '/' + label + '/*.caddy');

// edge 自己服務的網域，預設的內容目錄。
//
// 一台 edge 上會有好幾個網域，所以**一個網域一個子目錄** —— 全部共用一個
// D:\www 會互相蓋掉。node 不用分是因為一台 node 只服務一個網域。
export const edgeContentDefault = (drive, label) =>
  nodeLayout(drive).content_root + '/' + label;

// ---------------------------------------------------------------- 小工具
export const posix = (p) => String(p).replace(/\\/g, '/');
export const win = (p) => String(p).replace(/\//g, '\\');
const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
const indent = (text, n = 1) =>
  text.split('\n').map((l) => (l.trim() ? '\t'.repeat(n) + l : l)).join('\n');

const GENERATED =
  '# 這個檔案是 caddyctl 產生的 —— 不要手動編輯，下次執行會被蓋掉。\n';

// log 目錄。C:\Caddy 是釘死的，所以這裡不接參數 —— 設定檔裡寫的一律是機器上的
// 真實路徑，跟「現在把檔案產生到哪裡」無關（--dir 只影響後者）。
export const LOG_DIR = CADDY_DIR + '/logs';

// ---------------------------------------------------------------- 全域選項
//
// global.caddy 是唯一「一台機器一份、內容跟其他網域有關」的檔案：dynamic_dns
// 要列出全部網域，少一個那個網域就不會更新 IP。所以每次加減網域都要重寫它 ——
// 網域清單直接從 conf/sites/ 的檔名推出來，不必另外記在哪裡。
export function renderGlobal({ roles, token, labels = [], checkInterval = '60m' }) {
  const lines = [];
  if (roles.includes('edge')) {
    if (!token) throw new Error('edge 需要 duckdns token');
    // 不設 ACME email。Caddy 會註冊匿名帳號，憑證照常簽發與續期；
    // Let's Encrypt 早就不寄到期通知了，不值得為此多一個必填欄位。
    lines.push('acme_dns ' + DNS_PROVIDER + ' ' + token);
    if (labels.length) {
      lines.push('dynamic_dns {');
      lines.push('\tprovider ' + DNS_PROVIDER + ' ' + token);
      // domains 區塊的每一行是「<zone> <名稱…>」——
      // **第一個 token 是 zone，後面才是那個 zone 底下要更新的名稱。**
      //
      // 一行只寫 mysite.duckdns.org 的話，模組讀到的是「zone = mysite.duckdns.org，
      // 要更新的名稱：一個都沒有」，於是它什麼都不做，而且不會報錯 ——
      // 設定看起來完全正常，DNS 卻永遠不會更新。（實測踩到：兩個網域的 A 記錄
      // 都停在舊 IP，log 一片安靜。）
      //
      // duckdns 的 zone 一律是 duckdns.org，名稱就是 label。
      lines.push('\tdomains {');
      lines.push('\t\t' + DNS_SUFFIX.replace(/^\./, '') + ' ' + [...labels].sort().join(' '));
      lines.push('\t}');
      // versions ipv4 不能省。
      //
      // 不指定的話 dynamic_dns 會同時偵測 IPv4 和 IPv6，而一般家用網路沒有
      // IPv6 —— 偵測不到那一版，整輪就停在
      //   "dynamic_dns.ip_sources.simple_http: no IP found"
      // 什麼都不更新。
      //
      // 這個 bug 平常看不出來：只有在對外 IP 變動的那一刻，站台才會從網際網路上
      // 消失，而使用者看到的只有那一行看不懂的警告。（實測踩到：路由器重開之後
      // IP 變了，A 記錄整整一小時沒跟上。）
      //
      // 這個產品本來就只支援 duckdns 的 A 記錄，IPv4-only 是設計的一部分，
      // 所以明講出來，不要依賴預設值。
      lines.push('\tversions ipv4');
      lines.push('\tcheck_interval ' + checkInterval);
      lines.push('}');
    }
  } else {
    // node 不對外談 TLS —— 憑證是 edge 的事
    lines.push('auto_https off');
  }
  if (roles.includes('node')) {
    // 只有 node 需要 webdav。這條不能放進 Caddyfile 骨架：純 edge 的機器裝的是
    // 不含 webdav 外掛的建置，order 指到沒註冊的 directive 會讓 adapt 直接失敗。
    lines.push('order webdav before file_server');
  }
  return GENERATED + '\n' + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------- 記住登入
//
// iOS Safari 會把背景分頁從記憶體裡丟掉，回來時重新載入、收到 401、再問一次
// 密碼 —— 分頁看起來沒關，內容其實早就沒了。而 basic_auth **沒有任何設定**
// 可以改善這件事，也不可能有：HTTP Basic 的設計就是伺服器不發 session，
// 瀏覽器每個請求重送 Authorization 標頭，「要不要記住」100% 是瀏覽器的決定。
//
// 所以密碼通過之後補發一個 cookie，之後帶 cookie 就放行。
//
// 30 天，而且是**絕對窗口**不是滑動窗口。滑動（每次通過都重發 cookie）對使用者
// 更方便，但那等於「只要有人在用這把鑰匙它就永遠不過期」，而「有人」包括拿到
// cookie 的攻擊者 —— 那會把「風險有上界」這個唯一的安全保證拿掉。絕對窗口的
// 代價只是每個月在手機上重打一次密碼。
const REMEMBER_DAYS = 30;
const REMEMBER_MAX_AGE = REMEMBER_DAYS * 24 * 60 * 60;
export const REMEMBER_COOKIE = 'sc_auth';

// cookie 比對用子字串匹配。要命中就得讓 Cookie 標頭裡含有
// "sc_auth=<那串亂數>"，而那串亂數是 32 bytes 的 CSPRNG —— 不知道它就構造不出來。
export const rememberMatcher = (secret) =>
  '*' + REMEMBER_COOKIE + '=' + secret + '*';

export const rememberSetCookie = (secret) =>
  'header @sc_nocookie +Set-Cookie ' +
  q(REMEMBER_COOKIE + '=' + secret + '; Path=/; Max-Age=' + REMEMBER_MAX_AGE +
    '; Secure; HttpOnly; SameSite=Lax');

// 密碼區塊。users 空的就整段不產生。
//
// **Set-Cookie 一定要包在 route 裡面，這不是風格問題。**
//
// Caddy 預設的 directive 順序把 header(60) 排在 basic_auth(75) **前面**
// （caddyconfig/httpcaddyfile/directives.go）。直接寫成同一層的話，header 會先
// 掛上 ResponseWriter，然後把 Set-Cookie 加到 basic_auth 吐出的 **401** 上面 ——
// 等於把祕密送給任何一個亂試密碼的人，一次就拿到通行證。
//
// 實測確認過：不包 route 時 `curl -u alice:WRONG` 拿到的是
//     HTTP/1.1 401 Unauthorized
//     Set-Cookie: sc_auth=<祕密>
// 包進 route 之後 401 就乾淨了 —— route 保證照書寫順序執行，basic_auth 失敗
// 直接短路，header 根本跑不到。
function authLines(users, secret, inRoute) {
  const names = Object.keys(users || {});
  if (!names.length) return [];
  const lines = [];
  if (!secret) {
    // 沒有祕密就退回純 basic_auth。少了便利，不會少了安全。
    lines.push('basic_auth {');
    for (const u of names) lines.push('\t' + u + ' ' + users[u]);
    lines.push('}');
    return lines;
  }
  lines.push('# 記住登入 ' + REMEMBER_DAYS + ' 天：通過密碼之後補發 cookie，之後帶 cookie 就放行');
  lines.push('@sc_nocookie not header Cookie ' + q(rememberMatcher(secret)));
  lines.push('basic_auth @sc_nocookie {');
  for (const u of names) lines.push('\t' + u + ' ' + users[u]);
  lines.push('}');
  if (inRoute) {
    // proxy 模式整段本來就在 route 裡，順序已經有保證。
    lines.push(rememberSetCookie(secret));
  } else {
    // serve 模式不能把 basic_auth 移進 route —— 那會讓它從 75 掉到 87，
    // 排到 app drop-in 的 handle(85) 後面，等於 apps\<label>\*.caddy 裡的
    // 路由不再受密碼保護。所以只把 header 包進 route：它跑在 basic_auth
    // 成功之後、file_server（順序表最後）寫出回應之前。
    lines.push('route {');
    lines.push('\t' + rememberSetCookie(secret));
    lines.push('}');
  }
  return lines;
}

// ---------------------------------------------------------------- edge 的網域
//
// 一個網域一個檔，而且**自給自足** —— 裡面不參照任何其他網域的東西。
// 所以加一台、移除一台都只動一個檔。
//
// d = { mode, target, content, public_paths, users: {name: bcrypt}, message }
export function renderEdgeSite(label, d) {
  const host = fqdn(label);
  const wrap = (lines) => host + ' {\n' + indent(lines.join('\n')) + '\n}\n';
  const body = [];
  body.push('import sitelog ' + q(win(LOG_DIR + '/' + label + '_access.log')));
  body.push('');

  if (d.mode === 'hold') {
    // 只放進 dynamic_dns 的網域「拿不到憑證」—— Caddy 只為有 site 區塊的
    // hostname 申請。給它一個佔位站台，憑證才會正常簽發與續期，
    // 之後指派主機時是瞬間切換，不必等 ACME。
    body.push('respond ' + q(d.message || host + ' 尚未指派主機') + ' 503');
    return wrap(body);
  }

  // 個別路徑的密碼（caddyctl auth）。hold 沒有內容可以保護，所以不給。
  body.push('# 個別路徑的密碼：caddyctl auth set / list / remove');
  body.push(authImport(label));
  body.push('');

  if (d.mode === 'serve') {
    // 這台自己服務的站也支援 drop-in 的 app 路由，跟 node 一致。
    // 一個 hostname 一個資料夾，因為 edge 上會有好幾個站。
    body.push('# 這個站的 app 路由：一個 app 一個檔，丟進去 reload 就生效');
    body.push('import ' + q(CADDY_DIR + '/apps/' + label + '/*.caddy'));
    body.push('');
    if (d.content) body.push('import webroot ' + q(win(d.content)));
    // 整站的密碼。某條路徑要另外一組密碼是 caddyctl auth 的事 ——
    // 那條規則放在 conf/auth/<label>/，上面已經 import 進來了。
    const auth = authLines(d.users, d.remember, false);
    if (auth.length) {
      body.push('');
      body.push(...auth);
    }
    return wrap(body);
  }

  if (d.mode === 'proxy') {
    // node 的 actiond 沒有 token —— install.ps1 只設 ACTION_HOST=127.0.0.1，
    // 而 server.mjs 的 token 檢查是「TOKEN 是空的就跳過」。它唯一的保護是綁在
    // loopback，但 reverse_proxy 送過去的請求本來就來自 loopback。
    // 所以沒有密碼的站，/run 等於把「執行主機動作」開給全世界。
    //
    // 這條跟 /pub/* 是對稱的產品不變量，不是使用者的政策選項：
    // /pub/* 永遠免密碼，/run* 永遠不對匿名開放。--allow-anonymous 的意思是
    // 「內容我要公開」，不是「讓網際網路在我機器上跑指令」。
    if (!d.users || !Object.keys(d.users).length) {
      body.push('# 這個站沒有密碼，所以不轉 /run —— 那是執行主機動作的入口');
      body.push('handle /run* {');
      body.push('\trespond "not exposed" 404');
      body.push('}');
    }
    for (const p of d.public_paths || []) {
      // 免認證的路徑。後端負責把它限制成唯讀、且只服務公開目錄。
      body.push('handle ' + p + ' {');
      body.push('\treverse_proxy ' + d.target);
      body.push('}');
    }
    // proxy 模式整段包在 route 裡：這是 Set-Cookie 不會漏到 401 上的保證。
    body.push('handle {');
    body.push('	route {');
    for (const l of authLines(d.users, d.remember, true)) body.push('		' + l);
    // 不要動 Host header —— WebDAV 的 MOVE/COPY 會拿 Destination 的 host 去比對
    // 後端看到的 r.Host，改了就 502。Caddy 預設就是原樣傳。
    body.push('		reverse_proxy ' + d.target);
    body.push('	}');
    body.push('}');
    return wrap(body);
  }

  throw new Error('不認識的 mode "' + d.mode + '"');
}

// ---------------------------------------------------------------- 控制面板
//
// **控制面板不住在內容根目錄裡。**
//
// 原本它是 D:\www\index.html —— 也就是說「這台的首頁」跟「使用者自己的首頁」
// 是同一個檔，兩者只能活一個。使用者放自己的 index.html 就等於把面板刪掉，
// 而且看起來像產品壞了，不像自己覆蓋了什麼。（實際踩過兩次。）
//
// 現在面板產生到 conf\_panel.html，掛在 /panel。內容根目錄從此完全是使用者的：
// 放什麼都行，不放就是目錄列表。
//
// 順帶一個好處：面板改成從設定算出來，就不會說謊了 —— static 的機器沒有
// /p/ /w/ /a/，沒設家目錄的機器沒有 /c/，這些以前在靜態樣板裡是寫死的。
const CSS = [
  ':root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da}',
  '@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--card:#151b23;--link:#4493f8}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}',
  'main{max-width:40rem;margin:0 auto;padding:2rem 1rem 4rem}',
  'h1{font-size:1.4rem;margin:0 0 .2em}',
  '.sub{color:var(--mut);font-size:.9rem;margin-bottom:2rem}',
  'a.card{display:flex;gap:1rem;align-items:center;background:var(--card);border:1px solid var(--line);',
  'border-radius:12px;padding:1rem;margin-bottom:.7rem;text-decoration:none;color:inherit}',
  'a.card:active{transform:translateY(1px)}',
  '.ico{font-size:1.6rem;line-height:1}',
  '.n{font-weight:600}',
  '.d{font-size:.85rem;color:var(--mut)}',
  'code{background:var(--card);border:1px solid var(--line);padding:.1em .4em;border-radius:6px;font-size:.85em}',
  'footer{margin-top:2.5rem;font-size:.8rem;color:var(--mut);line-height:1.8}',
];

const card = (href, ico, name, desc) =>
  '  <a class="card" href="' + href + '">' +
  '<span class="ico">' + ico + '</span>' +
  '<span><span class="n">' + name + '</span><br><span class="d">' + desc + '</span></span></a>';

export function renderPanel(machine, n) {
  const L = nodeLayout(n.drive);
  const cards = [];

  // 內容根目錄排第一 —— 那是使用者的地方，面板只是客人。
  cards.push(card('/', '🏠', '/', win(L.content_root) + ' —— 你的內容根目錄' +
    (n.static ? '（唯讀）' : '，可用 WebDAV 讀寫')));

  if (!n.static) {
    const desc = { p: 'projects', w: 'workspaces' };
    for (const [prefix, root] of Object.entries(L.mounts)) {
      cards.push(card('/' + prefix + '/', prefix === 'p' ? '📦' : '🗂️', '/' + prefix + '/',
        (desc[prefix] || prefix) + ' — ' + win(root) + '，瀏覽 / .md 渲染 / WebDAV 讀寫'));
    }
  }

  cards.push(card('/run', '⚡', '/run', '執行主機上的動作'));

  if (!n.static) {
    cards.push(card('/' + L.actions_mount + '/', '📝', '/' + L.actions_mount + '/',
      win(CADDY_DIR + '/actions') + ' —— 編輯 action 本身'));
  }

  if (n.home) {
    cards.push(card('/c/', '⚙️', '/c/', '這台裝了哪些工具，以及它們的設定檔'));
  }

  cards.push(card('/pub/', '🌐', '/pub/', '對外公開唯讀，<b>不需要密碼</b>'));

  return [
    '<!doctype html>',
    '<html lang="zh-Hant">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + machine + '</title>',
    '<style>',
    ...CSS,
    '</style>',
    '<main>',
    '  <h1>' + machine + '</h1>',
    '  <div class="sub">瀏覽 · Markdown 渲染 · WebDAV 讀寫，同一組網址</div>',
    '',
    ...cards,
    '',
    '  <footer>',
    '    這一頁是 caddyctl 產生的（<code>' + win(CADDY_DIR + '/conf/_panel.html') + '</code>），',
    '    每次 <code>node init</code> 會重寫 —— 不要手動編輯。<br>',
    '    <code>' + win(L.content_root) + '</code> 是你的：放自己的 <code>index.html</code>',
    '    不會影響這一頁。<br>',
    '    每個網址實際對應到哪個目錄，看 <code>' + win(CADDY_DIR + '/conf/manifest.json') + '</code>',
    '    的 <code>url_map</code>。<br>',
    '    看 .md 原始碼：網址後面加 <code>?raw=1</code>',
    '  </footer>',
    '</main>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- /c/ 設定檔
//
// 把散在家目錄各處的設定檔集中成一個網址，並且**改名**成看得懂的名字 ——
// 三個工具的設定檔都叫 settings.json，擺在一起是分不出來的。
//
// 清單就是這張表，沒有別的機制：一行 = 一個會出現在 /c/ 的檔案。
//
// **這張表決定了什麼東西會被公開。** 沒有排除邏輯，也刻意不做 ——
// 要一個檔案不出現在 /c/，就是不要把它寫進這裡。所以加行之前先想一下：
// 這個檔裡有沒有金鑰？.npmrc、.aws/credentials、.ssh/id_*、
// .claude/.credentials.json 這類純憑證檔就是為此不在表上。
// （openclaw.json 本身可能含金鑰，它在表上是使用者明確要求的取捨。）
//
// 路徑一律是**家目錄底下的相對路徑**，用正斜線。猜錯的路徑不會壞掉，
// 只會安靜地不顯示 —— 所以表可以寫寬一點，涵蓋還沒裝的工具。
export const CONFIG_FILES = [
  // 顯示名                相對於家目錄的真實路徑                        說明
  ['openclaw.json',      '.openclaw/openclaw.json',                    'OpenClaw'],
  ['claude.json',        '.claude/settings.json',                      'Claude Code'],
  ['claude-local.json',  '.claude/settings.local.json',                'Claude Code（這台專用）'],
  ['claude.md',          '.claude/CLAUDE.md',                          'Claude Code 的全域指示'],
  ['codex.toml',         '.codex/config.toml',                         'Codex CLI'],
  ['gemini.json',        '.gemini/settings.json',                      'Gemini CLI'],
  ['continue.json',      '.continue/config.json',                      'Continue'],
  ['aider.yml',          '.aider.conf.yml',                            'Aider'],
  ['git.config',         '.gitconfig',                                 'Git'],
  ['vscode.json',        'AppData/Roaming/Code/User/settings.json',    'VS Code'],
  ['powershell.ps1',     'Documents/PowerShell/Microsoft.PowerShell_profile.ps1', 'PowerShell 7 profile'],
  ['powershell5.ps1',    'Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1', 'Windows PowerShell 5.1 profile'],
];

// 把 "a/b/c.json" 拆成「所在目錄」與「/檔名」—— cfgfile snippet 要這兩個。
// 沒有斜線的（.gitconfig）目錄就是家目錄本身。
export function splitConfigPath(home, rel) {
  const i = rel.lastIndexOf('/');
  return i < 0
    ? { dir: home, file: '/' + rel }
    : { dir: home + '/' + rel.slice(0, i), file: '/' + rel.slice(i + 1) };
}

// /c/ 的索引頁。
//
// 關鍵在 fileExists 是**每次瀏覽即時判斷**的（Caddy 的 templates 模組），
// 不是產生設定當下的快照。所以之後在這台裝了新工具，不必 reload 也不必重跑
// caddyctl，/c/ 自己就會多一行。這正好避開這個專案其他地方的快照問題。
//
// fileExists 的相對基準是 templates 的 root，設定裡會指到家目錄。
export function renderConfigIndex(machine) {
  const rows = CONFIG_FILES.map(([name, rel, desc]) =>
    '{{if fileExists ' + JSON.stringify(rel) + '}}<a class="card" href="/c/' + name + '">' +
    '<span><span class="n">' + name + '</span><br>' +
    '<span class="d">' + desc + ' —— <code>~/' + rel + '</code></span></span></a>{{end}}'
  );
  return [
    '<!doctype html>',
    '<html lang="zh-Hant">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + machine + ' 的設定檔</title>',
    '<style>',
    ':root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da}',
    '@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--card:#151b23;--link:#4493f8}}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}',
    'main{max-width:40rem;margin:0 auto;padding:2rem 1rem 4rem}',
    'h1{font-size:1.4rem;margin:0 0 .2em}',
    '.sub{color:var(--mut);font-size:.9rem;margin-bottom:2rem}',
    'a.card{display:block;background:var(--card);border:1px solid var(--line);',
    'border-radius:12px;padding:.8rem 1rem;margin-bottom:.6rem;text-decoration:none;color:inherit}',
    '.n{font-weight:600}',
    '.d{font-size:.85rem;color:var(--mut)}',
    'code{background:var(--bg);border:1px solid var(--line);padding:.1em .4em;border-radius:6px;font-size:.85em}',
    'footer{margin-top:2.5rem;font-size:.8rem;color:var(--mut);line-height:1.8}',
    '</style>',
    '<main>',
    '  <h1>' + machine + ' 的設定檔</h1>',
    '  <div class="sub">只列出這台實際存在的檔案 —— 這份清單就是「這台裝了哪些工具」。</div>',
    ...rows.map((r) => '  ' + r),
    '  <footer>',
    '    名稱是顯示用的：三個工具的設定檔都叫 <code>settings.json</code>，擺在一起分不出來，所以在這裡改了名。<br>',
    '    可以直接用 WebDAV 編輯（PUT）。改完通常還要重啟對應的服務，看 <a href="/run">/run</a>。<br>',
    '    這裡只列設定，不列憑證。清單在 <code>render.mjs</code> 的 <code>CONFIG_FILES</code>。',
    '  </footer>',
    '</main>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------- node 的站
export function renderNodeSite(n) {
  const L = nodeLayout(n.drive);
  const body = [];
  body.push('import sitelog ' + q(win(LOG_DIR + '/access.log')));
  body.push('');
  body.push('encode zstd gzip');
  body.push('');

  body.push('# 個別路徑的密碼：caddyctl auth set / list / remove');
  body.push(authImport(NODE_SITE));
  body.push('');

  // 執行 action。**區網上就打得到，這是刻意的。**
  //
  // 「手機也能按」是這個產品的功能之一，而手機的路徑是
  //     手機 →（HTTPS + 密碼）→ edge → HTTP → 這台的 /run
  // 從這台看，那個請求的來源是 edge 的區網位址，不是 loopback。所以把 /run
  // 限制成只收本機，等於把那個功能拿掉。
  //
  // 那區網上的其他機器呢？—— 信任邊界刻意畫在 edge 上，不是畫在每一台上：
  //
  //   * edge 到這裡是**明文 HTTP**（node 是 auto_https off，TLS 是 edge 的事）。
  //     接受這件事，就等於已經宣告區網內部不設防 —— 再為 /run 單獨設一道
  //     來源限制，只是局部地嚴格，不會改變整體的安全等級。
  //   * 也不用 token：明文通道上的 bearer token 側錄得到、重放得了，
  //     比來源限制更弱，還多一個必須長期存在的祕密。
  //
  // 真正不可信的是網際網路那一側，所以擋在那裡：**沒有密碼的 edge 站台不會把
  // /run 轉過來**（見 renderEdgeSite）。要遠端管理就給那個網域一組密碼。
  // 控制面板。產生出來的頁面，掛在自己的網址 —— 不占用內容根目錄的 index.html。
  body.push('# 控制面板（caddyctl 產生的 conf\\_panel.html）');
  body.push('redir /panel/ /panel 308');
  body.push('handle /panel {');
  body.push('\troot * ' + q(win(CADDY_DIR + '/conf')));
  body.push('\trewrite * /_panel.html');
  body.push('\tfile_server');
  body.push('}');
  body.push('');

  body.push('# 執行 action（由 action daemon 派送）');
  body.push('handle /run {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('handle /run/* {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('');

  // /c/ —— 家目錄裡的設定檔，改名之後集中在一個網址。
  //
  // 每個檔案一個 handle，而且是**確切路徑**（不是 /c/*）。這一點是安全性的關鍵：
  // handle 的路徑比對就是唯一的閘門，所以同一個目錄裡的鄰居（.claude 底下的
  // .credentials.json 之類）從 /c/ 完全打不到 —— 只有 CONFIG_FILES 明列的那幾個
  // 路徑存在，其餘一律落到後面的 handle 去。（實測驗過。）
  //
  // 索引頁是 caddyctl 產生的 conf/_configs.html，裡面每一行都包在 fileExists 裡，
  // 由 Caddy 在**每次瀏覽時**判斷，所以裝了新工具不必重新產生設定。
  if (n.home) {
    const home = posix(n.home);
    body.push('# 家目錄裡的設定檔（清單見 render.mjs 的 CONFIG_FILES）');
    body.push('redir /c /c/ 308');
    body.push('handle /c/ {');
    body.push('\troot * ' + q(win(CADDY_DIR + '/conf')));
    body.push('\trewrite * /_configs.html');
    // templates 的 root 跟 file_server 的 root 是分開的兩件事：樣板檔在 conf\，
    // 但 fileExists 要以家目錄為基準去判斷那些設定檔在不在。
    body.push('\ttemplates {');
    body.push('\t\troot ' + q(win(home)));
    body.push('\t}');
    body.push('\tfile_server');
    body.push('}');
    for (const [name, rel] of CONFIG_FILES) {
      const { dir, file } = splitConfigPath(home, rel);
      body.push('handle /c/' + name + ' {');
      body.push('\timport cfgfile ' + q(win(dir)) + ' ' + file);
      body.push('}');
    }
    body.push('');
  }

  body.push('# 各 app 的路由：一個 app 一個檔，丟進去 reload 就生效');
  body.push('import ' + q(CADDY_DIR + '/apps/*.caddy'));
  body.push('');

  body.push('# 唯一不需要密碼的路徑 —— 放進去的東西等於對整個網際網路公開');
  body.push('handle /pub/* {');
  body.push('\timport pubro ' + q(win(L.public_dir)) + ' /pub');
  body.push('}');
  body.push('');

  // static 的機器只服務檔案：沒有掛載點，根目錄也是唯讀的 webroot 而不是
  // 可讀寫的 fsdav。/run 兩種都保留 —— 少了它就沒有遠端管理通道，
  // 也就變不回全功能了。
  const mounts = n.static
    ? []
    : [...Object.entries(L.mounts), [L.actions_mount, CADDY_DIR + '/actions']];

  body.push('# 少了尾斜線的入口導正');
  for (const [prefix] of mounts) body.push('redir /' + prefix + ' /' + prefix + '/ 308');
  body.push('redir /pub /pub/ 308');
  body.push('');

  // Markdown 樣板（_md.html）所在的目錄。
  //
  // 放 conf\ 而不是內容根目錄：它是產品的檔案，不是使用者的內容。擺在 D:\www
  // 會出現在目錄列表裡、會被使用者誤刪、而且會落進 install.ps1 那條
  // 「已存在就保留不覆蓋」的規則 —— 從此永遠不更新。
  // 內容根目錄現在完全屬於使用者，這是那個決定的一部分。
  const tpl = q(win(CADDY_DIR + '/conf'));

  for (const [prefix, root] of mounts) {
    body.push('handle /' + prefix + '/* {');
    body.push('\timport fsdav ' + q(win(root)) + ' /' + prefix + ' ' + tpl);
    body.push('}');
    body.push('');
  }

  if (n.static) {
    body.push('# 站台根目錄（唯讀 —— 這台是 static，沒有 WebDAV）');
    body.push('handle {');
    body.push('\timport webroot ' + q(win(L.content_root)));
    body.push('}');
  } else {
    body.push('# 站台根目錄（前綴傳空字串就是掛在根目錄）');
    body.push('handle {');
    body.push('\timport fsdav ' + q(win(L.content_root)) + ' "" ' + tpl);
    body.push('}');
  }

  return GENERATED + '\n' + n.listen + ' {\n' + indent(body.join('\n')) + '\n}\n';
}

// ---------------------------------------------------------------- 外掛
// 角色決定建置。安裝程式讀 manifest 的 plugins，不必自己維護一份清單。
export function pluginsFor(roles) {
  const p = [];
  if (roles.includes('edge')) p.push(DNS_PLUGIN, 'github.com/mholt/caddy-dynamicdns');
  if (roles.includes('node')) p.push('github.com/mholt/caddy-webdav');
  return p;
}

// ---------------------------------------------------------------- node 的 url_map
// 網址 -> 實體位置。新的 app 不能撞到這裡面任何一個前綴。
// 必須跟 renderNodeSite 產生的設定一致 —— 改了那邊就要改這邊，
// 說謊的 manifest 比沒有 manifest 更糟。
export function urlMap(n) {
  const L = nodeLayout(n.drive);
  // 值一律是「乾淨的路徑」—— install.ps1 會對 X:\ 開頭的值做 Test-Path，
  // 在後面附註「(read-only)」會讓它誤報成目錄不存在。唯讀與否看 node.static。
  const m = { '/': win(L.content_root) };
  if (!n.static) {
    for (const [prefix, root] of Object.entries(L.mounts)) m['/' + prefix + '/'] = win(root);
    m['/' + L.actions_mount + '/'] = win(CADDY_DIR + '/actions');
  }
  m['/pub/'] = win(L.public_dir);
  m['/panel'] = 'control panel (' + win(CADDY_DIR + '/conf/_panel.html') + ')';
  if (n.home) m['/c/'] = 'home config files (' + win(n.home) + ')';
  m['/run'] = 'action daemon (reverse_proxy 127.0.0.1:' + n.actiond_port + ')';
  return m;
}
