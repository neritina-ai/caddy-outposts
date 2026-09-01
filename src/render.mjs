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
    if (d.users && Object.keys(d.users).length) {
      body.push('');
      body.push('basic_auth {');
      for (const [u, h] of Object.entries(d.users)) body.push('\t' + u + ' ' + h);
      body.push('}');
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
    body.push('handle {');
    if (d.users && Object.keys(d.users).length) {
      body.push('\tbasic_auth {');
      for (const [u, h] of Object.entries(d.users)) body.push('\t\t' + u + ' ' + h);
      body.push('\t}');
    }
    // 不要動 Host header —— WebDAV 的 MOVE/COPY 會拿 Destination 的 host 去比對
    // 後端看到的 r.Host，改了就 502。Caddy 預設就是原樣傳。
    body.push('\treverse_proxy ' + d.target);
    body.push('}');
    return wrap(body);
  }

  throw new Error('不認識的 mode "' + d.mode + '"');
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
  body.push('# 執行 action（由 action daemon 派送）');
  body.push('handle /run {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('handle /run/* {');
  body.push('\treverse_proxy 127.0.0.1:' + n.actiond_port);
  body.push('}');
  body.push('');

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

  // fsdav 的第三個參數是 markdown 樣板（_md.html）所在的目錄。放在內容根目錄，
  // 才不會為了渲染而去汙染 projects 那種地方。
  const tpl = q(win(L.content_root));

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
  m['/run'] = 'action daemon (reverse_proxy 127.0.0.1:' + n.actiond_port + ')';
  return m;
}
