// @title   Remote Control：把 session 開起來
// @desc    列出這台機器上的 Claude Code session，選中的重開成帶 Remote Control 的
// @group   claude
// @page
// @only-when-logged-on
//
// 為什麼是「殺掉再 resume」，不是「把 /rc 打進那個視窗」：
//
// 沒有任何官方指令問得到「這個 session 的 Remote Control 開了沒有」——
// claude agents --json 沒有這個欄位，設定檔裡也沒有對應的設定。所以這裡選了一個
// **不需要知道**的做法：重開的行程一定帶著 RC，做一次跟做三次結果一樣，
// 誤勾到本來就開著的也只是斷線重連（會接回同一筆，手機上不會多一個）。
//
// 代價是那個行程被換掉了，所以這些東西不會回來：正在跑的那一輪、啟動時給的
// --model / --effort / --add-dir、輸入框裡還沒送出的字。
//
// 為什麼標 @only-when-logged-on：actiond 以 NT AUTHORITY\LocalService 執行，
// 那個身分的 %USERPROFILE% 不是使用者的，claude agents --json 會回一個空陣列
// —— 而空陣列看起來跟「真的沒有 session」一模一樣。與其安靜地說謊，不如讓
// actiond 在沒人登入的時候就直接擋下來。而且開視窗本來就需要使用者的 session：
// 服務在 session 0，那裡開的視窗使用者在桌面上看不到。
//
// 有人登入的時候 actiond 會把這支程式整個交給橋，所以下面的程式碼就是以使用者
// 的身分、在他的 session 1 裡跑的 —— 不需要再自己過一次橋。
//
// 這支檔案有兩個模式。頁面模式（actiond 呼叫）負責畫面與動作；--collect 模式
// 由橋接以使用者身分執行，只負責把資料撈出來印成 JSON。同一個檔案，因為那兩件事
// 共用同一份對「什麼算一個 session」的認知，拆成兩個檔會立刻開始各自漂移。

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, renameSync, rmSync, statSync, openSync, readSync,
         closeSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

// 要放進 PowerShell 單引號字串的東西：裡面的單引號要變成兩個。
const ps = s => "'" + String(s).replace(/'/g, "''") + "'";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// =============================================================================
//  --collect —— 由橋接以使用者身分執行，印出一份加料過的 session 清單
// =============================================================================

// 對話紀錄的位置：~/.claude/projects/<把 cwd 的 : \ / 換成 -\>/<sessionId>.jsonl
//
// 那個目錄名的轉換規則是 Claude Code 的內部細節，所以不要只靠它：算出來的路徑
// 不在，就退回去掃一遍 projects 目錄找同名檔案。掃不到就算了 —— 這一段全部是
// 錦上添花，少了它這一頁照樣可以用，只是難挑而已。
function findTranscript(sessionId, cwd) {
  const root = path.join(homedir(), '.claude', 'projects');
  const guess = path.join(root, String(cwd).replace(/[:\\/]/g, '-'), sessionId + '.jsonl');
  if (existsSync(guess)) return guess;
  let dirs;
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = path.join(root, d, sessionId + '.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

// 只讀一段就好，有些對話紀錄好幾 MB。從檔尾切一段讀 —— 切點落在多位元組字元
// 中間的話，壞掉的是第一行，而那一行本來就要丟（它是被切斷的 JSON）。
function sliceOf(file, bytes, fromEnd) {
  let fd;
  try {
    const size = statSync(file).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const len = Math.min(bytes, size - start);
    if (len <= 0) return { text: '', partial: false };
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return { text: buf.subarray(0, n).toString('utf8'), partial: start > 0 };
  } catch {
    return { text: '', partial: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 關不掉就算了 */ } }
  }
}

// 一句真的是人打的話。要跳過的東西不少：斜線指令的展開、指令的輸出、系統提醒、
// hook 的輸出。這些都是 user 型別，但都不是使用者「說」的 —— 拿它們當標籤，
// 六個 session 會有五個長得一樣。
const NOISE = /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args|system-reminder|user-prompt-submit-hook)/;
function promptOf(line) {
  if (!line.trim() || !line.includes('"user"')) return '';
  let o;
  try { o = JSON.parse(line); } catch { return ''; }    // 切斷的那一行
  if (o.type !== 'user' || o.isMeta) return '';
  const c = o.message && o.message.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) ? ((c.find(x => x && x.type === 'text') || {}).text || '') : '';
  if (!text || NOISE.test(text)) return '';
  const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 100) : '';
}

// **最後**一句，不是第一句。這個標籤的用途是核對 —— 使用者在手機上點進那個
// session，第一眼看到的就是最後一句話，兩邊對得起來才有意義。顯示第一句的話，
// 他得在手機上一路往回捲才能確認是不是同一個。
function lastPrompt(file) {
  const tail = sliceOf(file, 524288, true);
  const lines = tail.text.split('\n');
  if (tail.partial) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const got = promptOf(lines[i]);
    if (got) return got;
  }
  // 尾巴那一段裡一句人話都沒有（最後可能是一長串工具輸出）—— 退回開頭找。
  if (!tail.partial) return '';
  for (const line of sliceOf(file, 262144, false).text.split('\n')) {
    const got = promptOf(line);
    if (got) return got;
  }
  return '';
}

// 在「執行這支程式的身分」底下，把清單撈出來。頁面模式會直接呼叫它一次；
// 撈不到東西才會透過橋接再叫一次（那時候跑的是下面的 --collect）。
function collect() {
  const r = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', windowsHide: true });
  const m = /\[[\s\S]*\]/.exec((r.stdout || '') + (r.stderr || ''));
  if (!m) return { error: (r.stderr || r.stdout || '叫不動 claude agents --json').trim() };
  let list;
  try {
    list = JSON.parse(m[0]);
  } catch (e) {
    return { error: '看不懂 claude agents --json 的輸出：' + e.message };
  }
  for (const a of list) {
    const t = findTranscript(a.sessionId, a.cwd);
    if (!t) continue;
    a.prompt = lastPrompt(t);
    try {
      const st = statSync(t);
      a.lastActivity = st.mtimeMs;
      // birthtime 在有些檔案系統上會等於 mtime 或是 0，那就當作不知道。
      if (st.birthtimeMs && st.birthtimeMs < st.mtimeMs) a.conversationStartedAt = st.birthtimeMs;
    } catch { /* 讀不到就不加這幾項 */ }
  }
  return { list };
}

// 結果寫檔，不寫 stdout。
//
// 這個模式是橋接以使用者身分執行的，而橋接是 PowerShell —— 它讀子行程的 stdout
// 時用的是系統 OEM codepage（這台是 Big5），UTF-8 的中文會整片變成亂碼，而且亂碼
// 剛好會吃掉 JSON 的引號，於是連 parse 都過不了。走檔案兩端都指定 UTF-8，
// PowerShell 全程不碰那些 bytes。（踩過，這是第二次。）
const collectAt = process.argv.indexOf('--collect');
if (collectAt >= 0) {
  const out = process.argv[collectAt + 1];
  const json = JSON.stringify(collect());
  if (out) writeFileSync(out, json, 'utf8'); else process.stdout.write(json);
  process.exit(0);
}

// =============================================================================
//  頁面模式
// =============================================================================

const SELF   = process.env.ACTION_SELF || '/_/run/cc-rc';
const METHOD = (process.env.ACTION_METHOD || 'GET').toUpperCase();

// 跑一段 PowerShell。**不經過任何橋** —— 這支程式已經是以使用者的身分在跑了。
//
// 指令和輸出都走檔案，不走管線：PowerShell 5.1 的 stdout 在被導向時是用系統
// OEM codepage 寫出去的（這台是 Big5），中文會在管線上壞掉。兩端都指定 UTF-8
// 誰都不用猜。輸入檔要帶 BOM（沒有 BOM 的 UTF-8 會被當成系統 ANSI 解析），
// 輸出檔不要帶（帶了的話 JSON.parse 會被那三個 byte 噎到）。
function runPs(script) {
  const id   = randomUUID();
  const inf  = path.join(tmpdir(), 'cc-rc-' + id + '.ps1');
  const outf = path.join(tmpdir(), 'cc-rc-' + id + '.out');
  const wrapper =
    "$ErrorActionPreference = 'Continue'\n" +
    '$text = & {\n' + script + '\n} *>&1 | Out-String\n' +
    '[IO.File]::WriteAllText(' + ps(outf) + ', $text, [Text.UTF8Encoding]::new($false))\n';
  writeFileSync(inf, '\ufeff' + wrapper, 'utf8');
  try {
    // windowsHide 只蓋住這個 powershell 自己的主控台。腳本裡 Start-Process 開出來
    // 的 claude 視窗不受影響 —— 那本來就是要讓使用者看得見的東西。
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inf],
      { cwd: process.cwd(), windowsHide: true, timeout: 110000 });
    let text = '';
    try { text = readFileSync(outf, 'utf8'); } catch { /* 沒跑成就是空的 */ }
    return { code: r.status === null ? -1 : r.status, text: text.trim() };
  } finally {
    rmSync(inf, { force: true });
    rmSync(outf, { force: true });
  }
}

// actiond 會把這支程式交給橋，所以 collect() 已經是以使用者的身分問的。
// 原本「先自己問，問不到才走橋」那兩條路的分岐就沒有意義了。
const sessions = collect;

// 工作目錄照 manifest 的掛載點縮短：D:\projects\wall-audio 顯示成 wall-audio。
// 不要寫死磁碟機 —— 那是 caddyctl node init --drive 決定的，而且 mounts 本來就在
// manifest 裡。讀不到 manifest 就原樣顯示完整路徑，不要猜。
function mountsOf() {
  const here = path.dirname(process.argv[1]);            // <caddy>\actions
  try {
    const m = JSON.parse(readFileSync(path.resolve(here, '..', 'conf', 'manifest.json'), 'utf8'));
    return Object.values((m.node && m.node.mounts) || {});
  } catch {
    return [];
  }
}
const MOUNTS = mountsOf();
function shortCwd(cwd) {
  const c = String(cwd || '');
  for (const base of MOUNTS) {
    const b = base.replace(/[\\/]+$/, '');
    if (c.toLowerCase() === b.toLowerCase()) return b;
    if (c.toLowerCase().startsWith(b.toLowerCase() + '\\')) return c.slice(b.length + 1);
  }
  return c;
}

// ---------------------------------------------------------------- 畫面
const CSS = `
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--dim:#8c959f;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--dim:#6e7681;--line:#3d444d;--card:#151b23;--link:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.2rem 1rem 4rem}
h1{font-size:1.3rem;margin:.2em 0 .6em}
h2{font-size:.95rem;margin:2em 0 .6em}
a{color:var(--link)}
.bar{display:flex;gap:.8rem;align-items:center;font-size:.85rem;color:var(--mut);margin-bottom:1rem;flex-wrap:wrap}
.note{font-size:.85rem;color:var(--mut);margin-bottom:1.2rem}
.note details{margin-top:.4rem}
.note summary{cursor:pointer;color:var(--link)}
.note ul{margin:.5rem 0;padding-left:1.2rem}
.s{display:flex;gap:.8rem;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;margin-bottom:.55rem}
.s.off{opacity:.6}
.s input{margin:.35rem 0 0;width:1.15rem;height:1.15rem;flex:none}
.s .t{flex:1;min-width:0}
.s .n{display:block;font-weight:600;word-break:break-all}
.s .q{display:block;font-size:.9rem;margin:.2rem 0;word-break:break-word}
.s .q.none{color:var(--dim)}
.s .d{display:block;font-size:.8rem;color:var(--mut);word-break:break-all}
.tag{font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:.1rem .55rem;white-space:nowrap;flex:none}
.tag.idle{color:var(--ok);border-color:var(--ok)}
.tag.busy{color:var(--bad);border-color:var(--bad)}
.tag.wait{color:var(--warn);border-color:var(--warn)}
button{font:inherit;font-size:.95rem;padding:.6rem 1.2rem;border-radius:8px;border:1px solid var(--link);background:var(--link);color:#fff;cursor:pointer;width:100%;margin-top:.4rem}
button:disabled{background:var(--card);color:var(--mut);border-color:var(--line);cursor:not-allowed}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
@keyframes spin{to{transform:rotate(1turn)}}
.busy{opacity:.85;pointer-events:none}
.busy::before{content:'';display:inline-block;width:.75em;height:.75em;margin-right:.45em;vertical-align:-.05em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
`;

// 送出之後畫面要立刻有變化 —— 重開一個 session 要跑十幾秒，中間完全不動的話使用者
// 會以為沒按到、再按一次，而那會把剛起來的東西又殺一遍。
//
// 擋第二次按用 pointer-events:none，**不是 disabled**：在 submit 處理器裡把按鈕設成
// disabled，有些瀏覽器會連帶把這次送出一起取消掉。pageshow 那段是給「按返回鍵回到
// 這一頁」用的，bfcache 會把忙碌狀態一起還原。
//
// actiond 的面板有一份一樣的。@page 的 HTML 是這支腳本自己送出的，不經過 actiond
// 的樣板，所以要自己帶 —— 就跟上面那整份 CSS 一樣。
const BUSY_JS = `
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.dataset.busy) { e.preventDefault(); return; }
  f.dataset.busy = '1';
  const b = f.querySelector('button');
  if (!b) return;
  b.dataset.label = b.textContent;
  b.textContent = '重開中…';
  b.classList.add('busy');
});
addEventListener('pageshow', () => {
  document.querySelectorAll('form[data-busy]').forEach(f => {
    delete f.dataset.busy;
    const b = f.querySelector('button');
    if (!b) return;
    b.classList.remove('busy');
    if (b.dataset.label) b.textContent = b.dataset.label;
  });
});
`;

const page = (title, body) =>
  '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(title) + '</title><style>' + CSS + '</style><main>' + body + '</main>' +
  '<script>' + BUSY_JS + '</script></html>';

const ago = ms => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分鐘前';
  if (s < 86400) return Math.round(s / 3600) + ' 小時前';
  return Math.round(s / 86400) + ' 天前';
};

function tag(a) {
  if (a.status === 'idle') return '<span class="tag idle">閒置</span>';
  if (a.status === 'busy') return '<span class="tag busy">執行中</span>';
  if (a.waitingFor === 'dialog open') return '<span class="tag wait">停在對話框</span>';
  const extra = a.waitingFor ? '：' + a.waitingFor : '';
  return '<span class="tag wait">' + esc((a.status || '?') + extra) + '</span>';
}

// 只有「執行中」不給勾 —— 重開會把正在跑的那一輪丟掉。
//
// 停在對話框上的（waiting）可以勾：它沒有在做事，是在等人按。而人在外面的時候，
// 那正是最需要救的一種 —— 不給勾的話它就永遠卡在那裡。
const selectable = a => a.status !== 'busy';

function row(a) {
  const on = selectable(a);

  // 「開始於」有兩個意思，不能混。被這一頁重開過的 session，行程是幾秒前才起來的，
  // 對話卻可能是三天前的 —— 印成「開始於 3 秒前」是在誤導。所以優先用對話紀錄的
  // 時間，讀不到才退回行程的時間，而且名字要講清楚是哪一個。
  const when = [];
  if (a.lastActivity) when.push('最後活動 ' + ago(a.lastActivity));
  if (a.conversationStartedAt) when.push('對話開始於 ' + ago(a.conversationStartedAt));
  if (!when.length && a.startedAt) when.push('這個視窗開啟於 ' + ago(a.startedAt));

  return '<label class="s' + (on ? '' : ' off') + '">' +
    '<input type="checkbox" name="sid" value="' + esc(a.sessionId) + '"' + (on ? '' : ' disabled') + '>' +
    '<span class="t">' +
      '<span class="n">' + esc(shortCwd(a.cwd)) + '</span>' +
      (a.prompt ? '<span class="q">「' + esc(a.prompt) + '」</span>'
                : '<span class="q none">還沒有對話</span>') +
      '<span class="d">' + esc(a.name || a.sessionId) +
        (when.length ? ' · ' + esc(when.join(' · ')) : '') + '</span>' +
    '</span>' + tag(a) + '</label>';
}

const NOTE =
  '<div class="note">勾選的會<strong>關掉再用同一份對話重新開啟</strong>，' +
  '新的那個帶著 Remote Control，手機上就看得到。' +
  '<details><summary>會失去什麼、怎麼選</summary><ul>' +
  '<li><strong>那個 session 會搬到一個新視窗</strong>（標題 <code>✳ 名字</code>，' +
  '開在你系統設定的那個終端機裡，而且是<strong>最小化</strong>的，不會打擾正在用電腦的人）。' +
  '回到電腦前就從工作列點開它接手，手機上講過的話都在裡面。' +
  '而你原本用來啟動它的那個終端機視窗會退回命令提示字元 —— ' +
  '看起來像 Claude Code 跳出去了，其實是那個視窗的主人本來就是 shell，不是它。</li>' +
  '<li>正在跑的那一輪會丟掉 —— 所以「執行中」的不給勾。</li>' +
  '<li>開啟時給的 <code>--model</code>／<code>--effort</code>／<code>--add-dir</code> 不會回來，' +
  '輸入框裡沒送出的字也不會。</li>' +
  '<li>這裡看不出哪些已經有 Remote Control —— 沒有指令問得到。' +
  '<strong>手機上看不到的就是還沒開的。</strong>勾到已經有的也沒差，就是斷線重連。</li>' +
  '<li>小字那個名字（<code>wall-audio-e4</code>）是 Claude Code 自己編的，' +
  '後面兩個字用來分辨同一個目錄下的多個 session。</li>' +
  '</ul></details></div>';

function listBody(list, lead) {
  const rows = list.map(row).join('');
  const anyOn = list.some(selectable);
  return lead +
    '<form method="POST" action="' + esc(SELF) + '">' + rows +
    '<button' + (anyOn ? '' : ' disabled') + '>把勾選的重開成有 Remote Control 的</button>' +
    '</form>';
}

const errPage = (why, text) => page('Remote Control',
  '<h1>Remote Control</h1><p class="bad">' + esc(why) + '</p><pre>' + esc(text) + '</pre>');

// ---------------------------------------------------------------- GET
if (METHOD !== 'POST') {
  const { list, error } = sessions();
  if (error) { process.stdout.write(errPage('列不出 session。', error)); process.exit(0); }
  const body = '<h1>Remote Control</h1>' +
    '<div class="bar"><a href="..">← 所有 action</a><span>' + list.length + ' 個 session</span></div>' +
    (list.length ? listBody(list, NOTE)
                 : '<div class="note">這台機器上沒有正在跑的 Claude Code session。</div>');
  process.stdout.write(page('Remote Control', body));
  process.exit(0);
}

// =============================================================================
//  工作區信任
// =============================================================================
//
// 停在「是否信任這個資料夾」的 session 沒有輸入框，也不會登記到
// `claude agents --json` 裡 —— 所以手機上既看不到它，也答不了那個問題。
//
// **resume 一樣會被問。** 而且比開新的更糟：走到那一步的時候，原本那個 session
// 已經被殺掉了，於是使用者按一下的結果是「本來在跑的東西不見了，換來一個卡住的
// 視窗」。cc-open 有同一段邏輯 —— 兩支是各自獨立的 action，有人只裝其中一支，
// 所以寧可重複也不共用一個檔案。
//
// 答案其實只是使用者設定裡的一個旗標，而且會繼承：已經信任的目錄底下新開一個
// 子目錄不會再問（實測：信任 D:\projects 之後，它底下的新目錄直接進提示；
// 同一個目錄放在沒信任的 D:\ 底下就會停在對話框）。所以上面沒有東西涵蓋它的
// 時候，自己把那個旗標寫進去，問題就不存在了。
//
// 這是這個檔案唯一碰 Claude Code 內部檔案的地方，所以做成盡力而為：有信任的
// 上層就跳過，失敗就吞掉並回報，而重開的結果一律回頭用 `claude agents --json`
// 驗證（那才是官方答案）。哪天這個旗標失效了，session 會停在對話框上、驗證會
// 說它沒回來，頁面也會告訴使用者去電腦前按 Yes。
const CLAUDE_CONFIG = path.join(homedir(), '.claude.json');

// Claude Code 寫進去的鍵是正斜線的（"D:/projects/foo"）。
const trustKey = dir => dir.split('\\').join('/').replace(/\/+$/, '');

// **鍵是照它存的樣子比對，不做正規化。** 舊版會用反斜線寫同一個目錄，所以一份
// 設定裡可能同時有 "D:/projects" 和 "D:\projects"，而 Claude Code 只認正斜線
// 那筆（實測：信任 "D:\projects"、沒信任 "D:/projects" 時，它底下的新目錄照樣
// 停在對話框）。在這裡把反斜線折進來，會讓一個即將被問的目錄被判成「已經信任」，
// 於是就跳過了那一次唯一有用的寫入。
const stored = k => String(k).replace(/\/+$/, '').toLowerCase();

// **那個目錄自己那一筆說了算。** 繼承只補「完全沒有記錄」的目錄：明確的 `false`
// **不會**被上層的 `true` 蓋過去（2026-09-14 在 pc-b 實測：`D:/projects` 是
// true、`D:/projects/myproj` 是 false，session 照樣停在對話框上）。把上層
// 當成足夠，剛好就是「跳過那一次唯一有用的寫入」的情況 —— 而這也是它一直沒被
// 發現的原因：當初寫這段的那台機器上沒有任何一筆 false 可以踩到。
function coveredByTrust(projects, dir) {
  const want = trustKey(dir).toLowerCase();
  let inherited = false;
  for (const [k, v] of Object.entries(projects || {})) {
    const have = stored(k);
    if (have.includes('\\')) continue;                   // 舊格式的鍵，不被採用
    if (have === want) return v?.hasTrustDialogAccepted === true;
    if (v?.hasTrustDialogAccepted === true && want.startsWith(have + '/')) inherited = true;
  }
  return inherited;
}

// 回傳一個短字串給結果頁：
//   'covered' —— 它自己或上層已經在信任範圍內
//   'seeded'  —— 這次替它寫了旗標
//   其他都是「為什麼沒能寫」，用使用者看得懂的話。
function ensureTrusted(dir) {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CLAUDE_CONFIG, 'utf8'));
  } catch (e) {
    return '讀不到 Claude Code 的設定（' + e.code + '）';
  }
  if (coveredByTrust(cfg.projects, dir)) return 'covered';

  const key = trustKey(dir);
  cfg.projects = cfg.projects || {};
  cfg.projects[key] = { ...(cfg.projects[key] || {}), hasTrustDialogAccepted: true };

  // 寫在真的那個檔旁邊再 rename 蓋過去：讀的人不會看到半份設定，而另一個 session
  // 同時寫入可能被蓋掉的窗口，只有一次 rename 那麼寬。
  const tmp = CLAUDE_CONFIG + '.cc-rc-' + randomUUID().slice(0, 8);
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    renameSync(tmp, CLAUDE_CONFIG);
    return 'seeded';
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* 沒東西要收 */ }
    return '寫不進 Claude Code 的設定（' + e.code + '）';
  }
}

// ---------------------------------------------------------------- POST
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* 沒有 body 就當成空的 */ }
// 瀏覽器送來的表單兩樣都不會有，但用 curl 或 PowerShell 手動送的時候會 ——
// PS 5.1 往管線寫東西會加 BOM，而 BOM 會黏在第一個欄位的名字上，
// 於是 sid 變成 <BOM>sid，getAll('sid') 拿到空陣列，而且不會有任何錯誤訊息。
raw = raw.replace(/^\ufeff/, '').trim();

// 表單只送 sessionId，其餘（pid、cwd、名字）一律回頭跟 claude agents --json 要。
// 呼叫端說什麼就信什麼的話，那個 pid 會變成「請幫我砍掉這個行程」的任意參數。
const wanted = new URLSearchParams(raw).getAll('sid').filter(s => UUID_RE.test(s));

const { list, error } = sessions();
if (error) { process.stdout.write(errPage('列不出 session，什麼都沒有做。', error)); process.exit(0); }

const picked  = list.filter(a => wanted.includes(a.sessionId) && selectable(a));
const skipped = wanted.filter(s => !picked.some(a => a.sessionId === s));

if (!picked.length) {
  process.stdout.write(page('Remote Control', '<h1>Remote Control</h1>' +
    '<div class="note">沒有可以處理的 session' +
    (skipped.length ? '（選到的已經不在了，或是變成執行中）' : '') + '，什麼都沒有做。</div>' +
    listBody(list, '')));
  process.exit(0);
}

// 使用者那端要跑的東西。每個 session：停掉 -> 等它真的不見 -> 用同一個
// sessionId resume 回來，帶上 --remote-control。
//
// --name 不能省：--remote-control 後面那個名字不管 session 的顯示名稱，
// 少了它重開之後名字會變（myproject-4b -> myproject-1a），
// 於是這一頁列的名字跟手機上看到的就對不起來 —— 而那正是使用者用來判斷的東西。
// 視窗開起來之後要縮下去，所以需要 ShowWindow。用標題找，不是用 pid ——
// console 視窗的擁有者是終端機（WindowsTerminal.exe），不是 claude.exe。
//
// 標題比對用 EndsWith，因為前面那個字元是 Claude Code 的狀態符號，它會動。
const WINDOW_HELPER = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class CcWin {
  delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  public static IntPtr Find(string suffix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      StringBuilder sb = new StringBuilder(300);
      GetWindowText(h, sb, 300);
      string t = sb.ToString();
      if (t.Length > 0 && IsWindowVisible(h) && t.EndsWith(suffix)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@ -ErrorAction SilentlyContinue

function Hide-CcWindow([string]$Suffix) {
    for ($i = 0; $i -lt 40; $i++) {
        $h = [CcWin]::Find($Suffix)
        if ($h -ne [IntPtr]::Zero) { [void][CcWin]::ShowWindow($h, 6); return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
`;

// 先把信任處理掉，再殺任何東西 —— 見上面那一段。同一個目錄只問一次（勾了兩個
// 同專案的 session 是常態）。
const trust = new Map();
for (const a of picked) {
  if (!trust.has(a.cwd)) trust.set(a.cwd, ensureTrusted(a.cwd));
}

const script = ['$ErrorActionPreference = "Continue"', WINDOW_HELPER];
for (const a of picked) {
  const name = a.name || path.basename(a.cwd || 'claude');
  script.push('Stop-Process -Id ' + a.pid + ' -Force -ErrorAction SilentlyContinue');
  script.push('for ($i = 0; $i -lt 40 -and (Get-Process -Id ' + a.pid +
              ' -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }');
  // **不要給 -WindowStyle，開起來之後再自己縮。** 兩件事都重要：
  //
  // 給了 -WindowStyle（Minimized 或 Normal 都一樣），Start-Process 會走
  // ShellExecute 那條路，於是**繞過 Windows 11 的「預設終端機應用程式」設定**，
  // 自己生一個獨立的 conhost 視窗。最小化的那種在工作列上是一個沒有特徵的圖示，
  // 混在一排裡面認不出來 —— 實測的結論是使用者找不到，他以為 session 不見了。
  // （視窗本身好端端的：visible=True、沒有 WS_EX_TOOLWINDOW，是人找不到。）
  //
  // 不給，console 就交給使用者系統設定的那個終端機 —— 在這台是 Windows Terminal。
  // 那個視窗在工作列上有終端機自己的圖示，而且字體主題都跟他平常用的一樣。
  //
  // 然後才縮起來。這是 ccrun 的做法：開了但不打擾 —— 人在電腦前工作的時候不會
  // 有東西跳到臉上，而最小化的 session 照樣收得到手機來的訊息。回到電腦前，
  // 工作列上那幾個終端機圖示點開就是了。
  script.push('Start-Process claude.exe -WorkingDirectory ' + ps(a.cwd) +
              ' -ArgumentList ' +
              ['--resume', a.sessionId, '--remote-control', name, '--name', name].map(ps).join(','));
  script.push('$hid = Hide-CcWindow ' + ps(name));
  // 括號不能省：Write-Output 'a' + $(...) 會被當成三個參數（'a'、'+'、結果），
  // 於是輸出裡會冒出一個孤零零的 +。
  script.push('Write-Output (' + ps('已重開：' + name) +
              " + $(if ($hid) { '' } else { '（視窗沒縮成，它開著）' }))");
}

const run = runPs(script.join('\n'));

// 等新的行程登記自己 —— 輪詢，不要用固定秒數。
//
// 固定秒數兩邊都不對：順利的時候大約 2 秒就好了，手機上乾等十幾秒沒有意義；
// 不順的時候那個數字又不一定夠，於是會把「還沒起來」講成「已經好了」。
// 而條件其實很明確：那個 sessionId 又出現了，而且 pid 換了一個。
const before = new Map(picked.map(a => [a.sessionId, a.pid]));
const started = Date.now();
const deadline = started + 25000;
let after = { list: [] };
let pending = [...before.keys()];
for (;;) {
  after = sessions();
  pending = [...before.keys()].filter(sid =>
    !(after.list || []).some(a => a.sessionId === sid && a.pid !== before.get(sid)));
  if (!pending.length || Date.now() >= deadline) break;
  await new Promise(r => setTimeout(r, 700));
}
const waited = Math.round((Date.now() - started) / 1000);

// 回到電腦前怎麼接手。這一段不能只寫在文件裡 —— 使用者是在手機上按下去的，
// 而他下一次想起這件事，是幾個小時後坐在電腦前面、看著一個退回命令提示字元的
// 舊分頁的時候。那時候他手上只有這一頁。
const backHome = () => {
  const rows = picked.map(a => {
    const name = a.name || path.basename(a.cwd || 'claude');
    return '<li><code>✳ ' + esc(name) + '</code> —— 或 ' +
      '<code>claude --resume ' + esc(a.sessionId) +
      ' --remote-control ' + esc(name) + ' --name ' + esc(name) + '</code></li>';
  }).join('');
  return '<div class="note"><strong>回到電腦前怎麼接手</strong>' +
    '<ul><li><strong>工作列上會多一個最小化的終端機視窗，標題是 <code>✳ 名字</code></strong>' +
    '。點開就是它 —— 同一個 session，手機上講過的話都在裡面，直接接著打就好。</li>' +
    '<li>想把它拿回自己的終端機分頁：<strong>先在那個視窗裡 <code>/exit</code></strong>，' +
    '再到你的分頁跑下面對應的指令。不先結束的話會有兩個行程寫同一份對話紀錄。</li></ul>' +
    '<details><summary>每一個的指令</summary><ul>' + rows + '</ul>' +
    '<p><code>claude --teleport</code> 也列得出這些 session，但它開的是一份' +
    '<strong>本機副本</strong>（新的 session id），之後的對話不會回到手機上。' +
    '要同一個 session 就用 <code>--resume</code>。</p></details></div>';
};

// 信任只在「做了什麼」或「沒能做」的時候講。全部都在信任範圍內是常態，
// 每次都報一次沒發生的事，只會教會使用者跳過這一頁。
const trustNote = () => {
  const rows = [...trust.entries()].filter(([, s]) => s !== 'covered');
  if (!rows.length) return '';
  const names = list => list.map(([d]) => '<code>' + esc(shortCwd(d)) + '</code>').join('、');
  const seeded = rows.filter(([, s]) => s === 'seeded');
  const failed = rows.filter(([, s]) => s !== 'seeded');
  let out = '';
  if (seeded.length) {
    out += '<div class="note">先替 ' + names(seeded) + ' 記下了「信任這個資料夾」' +
      '—— 沒有這一步，resume 會停在那個對話框上，而原本的 session 已經關掉了。</div>';
  }
  if (failed.length) {
    out += '<div class="note"><span class="bad">沒能先記下信任</span>：' +
      failed.map(([d, s]) => '<code>' + esc(shortCwd(d)) + '</code>（' + esc(s) + '）').join('、') +
      '。這幾個可能停在「是否信任這個資料夾」上，要有人在電腦前按 Yes。</div>';
  }
  return out;
};

const ok = run.code === 0 && !pending.length;
const result =
  '<h1>Remote Control</h1>' +
  '<p class="' + (ok ? 'ok' : 'bad') + '">' +
  (run.code !== 0 ? 'PowerShell 回報 exit ' + run.code
    : pending.length ? pending.length + ' 個等了 ' + waited + ' 秒還沒回來'
    : (picked.length - pending.length) + ' 個已經重開好了（' + waited + ' 秒），手機上應該看得到') +
  '</p>' +
  (run.text ? '<pre>' + esc(run.text) + '</pre>' : '') +
  trustNote() +
  (run.code === 0 ? backHome() : '') +
  (pending.length ? '<div class="note">沒回來的那些：行程停掉了，但新的還沒登記自己。' +
    '重新整理這一頁看看 —— 它們可能只是起得比較慢，' +
    '也可能是卡在工作區信任的對話框上（那種情況下沒有輸入框，也不會有 Remote Control）。</div>' : '') +
  (skipped.length ? '<div class="note">有 ' + skipped.length +
    ' 個勾選被跳過：送出的時候它已經不在清單上，或變成執行中了。</div>' : '') +
  '<h2>現在</h2>' +
  (after.error ? '<pre>' + esc(after.error) + '</pre>' : listBody(after.list, ''));

process.stdout.write(page('Remote Control', result));
