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
// 實測確認過：不包 route 時 `curl -u admin:WRONG` 拿到的是
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
// 授權只有一條規則：**保護 /_/*，其餘公開。**
//
// node 端把「機器」全部收進 /_/ 底下（見 renderNodeSite），所以這裡只要守住
// 那一個前綴就夠了。密碼的意思因此很單純：它是網際網路和那台機器之間的界線，
// 不是內容的門鎖。
//
// **沒有密碼的網域不路由 /_/*。** 那不是使用者的政策選項，是產品的不變量：
// /_/p/ /_/w/ 是可寫入的 WebDAV，/_/a/ 可以編輯 action 的腳本本身，
// /_/run 會執行它們。沒有密碼就把這些開到網際網路上，等於交出那台機器。
export function renderEdgeSite(label, d) {
  const host = fqdn(label);
  const wrap = (lines) => host + ' {\n' + indent(lines.join('\n')) + '\n}\n';
  const conf = q(win(CADDY_DIR + '/conf'));
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

  // 個別路徑的密碼（caddyctl auth）。這是「把 / 底下某一條路徑關起來」的辦法。
  body.push('# 個別路徑的密碼：caddyctl auth set / list / remove');
  body.push(authImport(label));
  body.push('');

  const hasPassword = Boolean(d.users && Object.keys(d.users).length);

  if (d.mode === 'proxy') {
    // 後面是一台 node。密碼保護的是**那台機器**，也就是 /_/* ——
    // 可寫入的 WebDAV、可編輯 action 的 /_/a/、會執行它們的 /_/run。
    // 內容（/）一律公開，跟那台自己在區網上的樣子一致。
    body.push('# /_/ 底下是那台機器本身');
    if (hasPassword) {
      body.push('handle /_* {');
      body.push('\troute {');
      for (const l of authLines(d.users, d.remember, true)) body.push('\t\t' + l);
      body.push('\t\treverse_proxy ' + d.target);
      body.push('\t}');
      body.push('}');
    } else {
      // 沒有密碼就整段不路由。這不是使用者的政策選項，是產品的不變量 ——
      // 沒有密碼還把可寫入的 WebDAV 和 /_/run 開到網際網路上，等於交出那台機器。
      // 這不是假設：這套系統自己就這樣裸奔過一次。
      body.push('# 這個網域沒有密碼，所以整段關閉');
      body.push('handle /_* {');
      body.push('\trespond "not exposed" 404');
      body.push('}');
    }
    body.push('');
    // 不要動 Host header —— WebDAV 的 MOVE/COPY 會拿 Destination 的 host 去比對
    // 後端看到的 r.Host，改了就 502。Caddy 預設就是原樣傳。
    body.push('handle {');
    body.push('\treverse_proxy ' + d.target);
    body.push('}');
    return wrap(body);
  }

  if (d.mode === 'serve') {
    // edge 自己服務的靜態站。**這裡沒有「機器」那一層** —— 它不是 node，
    // 沒有 /_/p/ /_/run 那些東西。所以 /_ 只是保留字，一律 404。
    //
    // 於是密碼在這個模式下的意思跟 proxy 不同：沒有機器可以保護，它保護的
    // 就是內容本身。那是唯一說得通的解釋，也保住了「我要一個只有我看得到的
    // 靜態站」這個正當需求。
    body.push('# 這個站的 app 路由：一個 app 一個檔，丟進去 reload 就生效');
    body.push('import ' + q(CADDY_DIR + '/apps/' + label + '/*.caddy'));
    body.push('');
    body.push('# /_ 是保留字：edge 自己服務的站沒有「機器」那一層');
    body.push('handle /_* {');
    body.push('\trespond "not exposed" 404');
    body.push('}');
    body.push('');
    if (hasPassword) {
      body.push('# 這個站要密碼（保護的是內容 —— 這裡沒有機器可以保護）');
      body.push(...authLines(d.users, d.remember, false));
      body.push('');
    }
    if (d.content) body.push('import webroot ' + q(win(d.content)) + ' ' + conf);
    return wrap(body);
  }

  throw new Error('不認識的 mode "' + d.mode + '"');
}

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
  const pub = [];
  const priv = [];

  // 公開區在前，機器區在後 —— 面板本身就該把那條界線畫出來。
  pub.push(card('/', '🌐', '/', win(L.content_root) + ' —— 你的公開網站，唯讀'));

  priv.push(card('/_/run', '⚡', '/_/run', '執行主機上的動作'));
  if (n.home) priv.push(card('/_/c/', '⚙️', '/_/c/', '這台裝了哪些工具，以及它們的設定檔'));
  if (!n.static) {
    const desc = { p: 'projects', w: 'workspaces' };
    for (const [prefix, root] of Object.entries(L.mounts)) {
      priv.push(card('/_/' + prefix + '/', prefix === 'p' ? '📦' : '🗂️', '/_/' + prefix + '/',
        (desc[prefix] || prefix) + ' — ' + win(root)));
    }
    priv.push(card('/_/' + L.actions_mount + '/', '📝', '/_/' + L.actions_mount + '/',
      win(CADDY_DIR + '/actions') + ' —— 編輯 action 本身'));
  }

  return [
    '<!doctype html>',
    '<html lang="zh-Hant">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + machine + '</title>',
    '<style>',
    ...CSS,
    'h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:2em 0 .8em}',
    '</style>',
    '<main>',
    '  <h1>' + machine + '</h1>',
    '  <div class="sub">瀏覽 · Markdown 渲染 · WebDAV 讀寫</div>',
    '',
    '  <h2>公開 —— 不需要密碼</h2>',
    ...pub.map((c) => c),
    '',
    '  <h2>要密碼</h2>',
    ...priv.map((c) => c),
    '',
    '  <footer>',
    '    這一頁是 caddyctl 產生的（<code>' + win(CADDY_DIR + '/conf/panel.html') + '</code>），',
    '    每次 <code>node init</code> 會重寫 —— 不要手動編輯。<br>',
    '    規則只有一條：<code>/_/</code> 底下是這台機器，其餘是你的公開網站。<br>',
    '    <code>' + win(L.content_root) + '</code> 是你的：放自己的 <code>index.html</code>',
    '    不會影響這一頁。<br>',
    '    看 .md 原始碼：網址後面加 <code>?raw=1</code>',
    '  </footer>',
    '</main>',
    '',
  ].join('\n');
}

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
    '{{if fileExists ' + JSON.stringify(rel) + '}}<a class="card" href="/_/c/' + name + '">' +
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
//
// **一條規則：`/_/` 底下是機器，其餘是使用者的公開網站。**
//
//     /            內容根目錄，唯讀公開
//     /_/          這台機器：面板、設定檔、掛載點、執行動作
//
// 於是 node = static + /_/ 底下多幾個可寫入的掛載點，兩者的 / 完全一樣。
//
// **WebDAV 只出現在 /_/ 底下。** 公開網站沒有 webdav directive —— 不是靠權限
// 擋，是那個能力不存在。所以「知道某條路徑密碼的人可以改檔案」在這個架構下
// 不可能發生；能寫入的人 = 知道整個網域密碼的人 = 管理員。
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

  // Markdown 樣板所在的目錄。放 conf\ 而不是內容根目錄：它是產品的檔案。
  const tpl = q(win(CADDY_DIR + '/conf'));
  const conf = q(win(CADDY_DIR + '/conf'));

  // ---- /_ 控制面板 ----
  body.push('# 控制面板（caddyctl 產生的 conf\\panel.html）');
  body.push('redir /_/ /_ 308');
  body.push('handle /_ {');
  body.push('\troot * ' + conf);
  body.push('\trewrite * /panel.html');
  body.push('\tfile_server');
  body.push('}');
  body.push('');

  // ---- /_/run 執行動作 ----
  //
  // 搬進 /_/ 之後就不必再有「沒密碼的站不轉 /run」那條特例了 ——
  // 整個 /_/* 本來就只在有密碼時才路由（見 renderEdgeSite）。
  body.push('# 執行 action（由 action daemon 派送）');
  body.push('handle /_/run {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('handle /_/run/* {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('');

  // ---- /_/c/ 家目錄裡的設定檔 ----
  if (n.home) {
    const home = posix(n.home);
    body.push('# 家目錄裡的設定檔（清單見 CONFIG_FILES）');
    body.push('redir /_/c /_/c/ 308');
    body.push('handle /_/c/ {');
    body.push('\troot * ' + conf);
    body.push('\trewrite * /configs.html');
    body.push('\ttemplates {');
    body.push('\t\troot ' + q(win(home)));
    body.push('\t}');
    body.push('\tfile_server');
    body.push('}');
    for (const [name, rel] of CONFIG_FILES) {
      const { dir, file } = splitConfigPath(home, rel);
      body.push('handle /_/c/' + name + ' {');
      body.push('\timport cfgfile ' + q(win(dir)) + ' ' + file);
      body.push('}');
    }
    body.push('');
  }

  // ---- /_/p/ /_/w/ /_/a/ 可寫入的掛載點（static 沒有）----
  const mounts = n.static ? [] : [
    ...Object.entries(L.mounts),
    [L.actions_mount, CADDY_DIR + '/actions'],
  ];
  if (mounts.length) {
    body.push('# 少了尾斜線的入口導正');
    for (const [prefix] of mounts) body.push('redir /_/' + prefix + ' /_/' + prefix + '/ 308');
    body.push('');
    for (const [prefix, root] of mounts) {
      body.push('handle /_/' + prefix + '/* {');
      body.push('\timport fsdav ' + q(win(root)) + ' /_/' + prefix + ' ' + tpl);
      body.push('}');
      body.push('');
    }
  }

  body.push('# 各 app 的路由：一個 app 一個檔，丟進去 reload 就生效');
  body.push('import ' + q(CADDY_DIR + '/apps/*.caddy'));
  body.push('');

  // ---- / 你的公開網站（static 和 node 完全一樣）----
  body.push('# 站台根目錄 —— 你的公開網站，唯讀');
  body.push('handle {');
  body.push('\timport webroot ' + q(win(L.content_root)) + ' ' + tpl);
  body.push('}');

  return GENERATED + '\n' + n.listen + ' {\n' + indent(body.join('\n')) + '\n}\n';
}

// ---------------------------------------------------------------- node 的 url_map
// 網址 -> 實體位置。新的 app 不能撞到這裡面任何一個前綴。
// 必須跟 renderNodeSite 產生的設定一致 —— 改了那邊就要改這邊，
// 說謊的 manifest 比沒有 manifest 更糟。
// ---------------------------------------------------------------- 外掛
// 角色決定建置。安裝程式讀 manifest 的 plugins，不必自己維護一份清單。
export function pluginsFor(roles) {
  const p = [];
  if (roles.includes('edge')) p.push(DNS_PLUGIN, 'github.com/mholt/caddy-dynamicdns');
  if (roles.includes('node')) p.push('github.com/mholt/caddy-webdav');
  return p;
}


export function urlMap(n) {
  const L = nodeLayout(n.drive);
  // 值一律是「乾淨的路徑」—— install.ps1 會對 X:\ 開頭的值做 Test-Path，
  // 在後面附註「(read-only)」會讓它誤報成目錄不存在。
  //
  // 順序就是「公開的在前，要密碼的在後」—— 讀這份 manifest 的人（AI、安裝
  // 程式）第一眼就該看出這條界線。
  const m = {
    '/': win(L.content_root),
    '/_': 'control panel (' + win(CADDY_DIR + '/conf/panel.html') + ')',
  };
  if (n.home) m['/_/c/'] = 'home config files (' + win(n.home) + ')';
  m['/_/run'] = 'action daemon (reverse_proxy 127.0.0.1:' + n.actiond_port + ')';
  if (!n.static) {
    for (const [prefix, root] of Object.entries(L.mounts)) m['/_/' + prefix + '/'] = win(root);
    m['/_/' + L.actions_mount + '/'] = win(CADDY_DIR + '/actions');
  }
  return m;
}
