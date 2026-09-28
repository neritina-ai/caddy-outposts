// @title   Git 狀態：某個專案 push 了沒有
// @desc    挑一個專案，看 git status、remote 網址，以及最近五代的 commit 樹
// @group   git
// @page
// @only-when-logged-on
//
// Pick a project under the projects root and see where it stands against its
// remote: what `git status` says about pushing, the remote's web address, and
// the last five commits drawn as a tree -- enough to tell, from a phone,
// whether this machine or GitHub has the newer version.
//
// "Ahead 2, behind 0" is only as fresh as the remote-tracking ref it was
// computed from, and that ref moves only when this repo fetches or pushes.
// So the page says when that last happened, and offers a fetch as a separate
// POST button instead of doing one on every view: a fetch is a network round
// trip that can take seconds, it writes into .git, and it needs the user's
// credentials. Viewing stays read-only and fast; asking GitHub is one tap away.
//
// Why @only-when-logged-on: git reads the user's ~/.gitconfig, and under
// actiond's own account (NT AUTHORITY\LocalService) there is none. Without it
// the answer is quietly different -- a different core.autocrlf can list every
// file as modified, and repos owned by the user are refused as "dubious
// ownership". Credentials for the fetch live in the user's profile too.
// actiond hands this whole script to the bridge when someone is logged on, so
// the code below already runs as the user.
//
// Time budget: when the bridge runs a page, actiond waits BRIDGE_WAIT_MS
// (15 s by default) for the whole script and then gives up. The fetch timeout
// below is set so a slow network still leaves room for the rest of the page.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

const SELF   = process.env.ACTION_SELF || '/_/run/git-status';
const METHOD = (process.env.ACTION_METHOD || 'GET').toUpperCase();
const QUERY  = new URLSearchParams(process.env.ACTION_QUERY || '');

// The action panel is this page's own URL minus its last segment. Derived, not
// hard-coded: the prefix is /_/run through Caddy and /run on actiond's own port.
const PANEL = SELF.replace(/\/[^/]*$/, '') || '/';

const GRAPH_DEPTH      = 5;
const FETCH_TIMEOUT_MS = 10000;
const MAX_FILES        = 40;

// =============================================================================
//  Where the projects live
// =============================================================================

// Same source as cc-open.mjs: the node's manifest, mount `p` (`/_/p/`).
function projectsRoot() {
  const here = path.dirname(process.argv[1]);            // <caddy>\actions
  try {
    const m = JSON.parse(readFileSync(path.resolve(here, '..', 'conf', 'manifest.json'), 'utf8'));
    const mounts = (m.node && m.node.mounts) || {};
    return mounts.p || null;
  } catch {
    return null;
  }
}

// Directory names, newest first. `.git` may be a directory or, in a worktree
// or submodule checkout, a file -- existsSync covers both.
function listProjects(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => {
      const dir = path.join(root, d.name);
      let mtime = 0;
      try { mtime = statSync(dir).mtimeMs; } catch { /* keep 0 */ }
      return { name: d.name, mtime, isRepo: existsSync(path.join(dir, '.git')) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// =============================================================================
//  git
// =============================================================================

// Never prompt. A credential dialog would open on the desk of a machine nobody
// is looking at, and the page would hang until the bridge gives up on it.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

// --no-optional-locks: a Claude Code session may be committing in this very
// repo, and a plain `git status` takes index.lock to refresh the index as a
// side effect. This page only looks, so it must never be the one holding it.
// The -c overrides keep the output parseable whatever the user's config says.
function git(dir, args, timeout = 8000) {
  const r = spawnSync('git', [
    '--no-optional-locks',
    '-c', 'core.quotepath=off',
    '-c', 'color.ui=never',
    '-c', 'log.showSignature=false',
    ...args,
  ], {
    cwd: dir, encoding: 'utf8', windowsHide: true, env: GIT_ENV,
    timeout, maxBuffer: 16 * 1024 * 1024,
  });
  const timedOut = r.error && r.error.code === 'ETIMEDOUT';
  return {
    ok: r.status === 0,
    out: (r.stdout || '').replace(/\s+$/, ''),
    err: timedOut ? (timeout / 1000) + ' 秒內沒有回應，放棄了。'
       : r.error ? 'git 叫不起來：' + r.error.message
       : (r.stderr || '').trim(),
  };
}

// `git status --porcelain=v2 --branch`: the header lines give the branch and
// ahead/behind, the rest are entries turned back into the familiar short
// format ("XY path") for display.
function readStatus(dir) {
  const r = git(dir, ['status', '--porcelain=v2', '--branch']);
  if (!r.ok) return { error: r.err || 'git status 失敗' };
  const st = { oid: '', head: '', upstream: '', ahead: null, behind: null, files: [] };
  for (const line of r.out.split(/\r?\n/)) {
    let m;
    if (!line) continue;
    if (line.startsWith('# branch.oid '))           st.oid = line.slice(13);
    else if (line.startsWith('# branch.head '))     st.head = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) st.upstream = line.slice(18);
    else if ((m = /^# branch\.ab \+(\d+) -(\d+)/.exec(line))) {
      st.ahead = +m[1];
      st.behind = +m[2];
    }
    else if (line.startsWith('#')) continue;
    else st.files.push(shortEntry(line));
  }
  return st;
}

function shortEntry(line) {
  const xy = s => s.replace(/\./g, ' ');
  let m;
  if ((m = /^1 (..) (?:\S+ ){6}(.*)$/.exec(line))) return xy(m[1]) + ' ' + m[2];
  if ((m = /^2 (..) (?:\S+ ){7}(.*)$/.exec(line))) {
    const [to, from] = m[2].split('\t');
    return xy(m[1]) + ' ' + from + ' -> ' + to;
  }
  if ((m = /^u (..) (?:\S+ ){8}(.*)$/.exec(line))) return xy(m[1]) + ' ' + m[2];
  if (line.startsWith('? ')) return '?? ' + line.slice(2);
  return line;
}

// Fetch URLs, one per remote. Anything that looks like a credential in the URL
// (https://user:token@host/...) is removed before it goes anywhere near a page.
function readRemotes(dir) {
  const r = git(dir, ['remote', '-v']);
  const seen = new Map();
  for (const line of r.ok ? r.out.split(/\r?\n/) : []) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (m && m[3] === 'fetch' && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen]
    .sort(([a], [b]) => (b === 'origin') - (a === 'origin'))
    .map(([name, url]) => ({ name, url: hideSecret(url), web: webUrl(url) }));
}

function hideSecret(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/@]*)@/i, (all, scheme, auth) =>
    /^https?:/i.test(scheme) ? scheme : scheme + auth.replace(/:.*$/, '') + '@');
}

// The web page for a remote, or '' when there is none to link to. Handles
// https://host/owner/repo(.git), ssh://git@host/owner/repo.git and the scp-like
// git@host:owner/repo.git. A host without a dot is an ssh alias from
// ~/.ssh/config or a drive letter -- neither is a web address.
function webUrl(raw) {
  let scheme = 'https://';
  let m = /^(https?|ssh|git):\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(raw);
  if (m) {
    if (m[1].toLowerCase() === 'http') scheme = 'http://';
    m = [null, m[2], m[3]];
  } else {
    m = /^(?:[^@/\\]+@)?([^/:\\]+):(?!\/)(.+)$/.exec(raw);
  }
  if (!m) return '';
  let host = m[1].toLowerCase();
  if (host === 'ssh.github.com') host = 'github.com';
  if (!host.includes('.')) return '';
  const p = m[2].replace(/\/+$/, '').replace(/\.git$/, '');
  return scheme + host + '/' + p;
}

// What to compare HEAD against. The configured upstream when it exists;
// otherwise <remote>/<branch>, because a branch pushed without -u has no
// upstream but is still very much on GitHub.
function compareBase(dir, st, remotes) {
  if (!st.head || st.head === '(detached)') return null;
  if (st.upstream) {
    return st.ahead === null
      ? { name: st.upstream, gone: true }
      : { name: st.upstream, rev: '@{u}', ahead: st.ahead, behind: st.behind };
  }
  for (const { name: remote } of remotes) {
    const ref = 'refs/remotes/' + remote + '/' + st.head;
    if (!git(dir, ['rev-parse', '--verify', '--quiet', ref]).ok) continue;
    const c = git(dir, ['rev-list', '--left-right', '--count', 'HEAD...' + ref, '--']);
    const m = /^(\d+)\s+(\d+)$/.exec(c.out);
    if (!m) continue;
    return { name: remote + '/' + st.head, rev: ref, ahead: +m[1], behind: +m[2], implicit: true };
  }
  return null;
}

// When the remote-tracking ref last heard from the remote: the later of the
// last fetch (FETCH_HEAD) and the last time the ref itself moved (its reflog,
// which a push also writes). null when neither exists.
function lastContact(dir, base) {
  let t = 0;
  const fh = git(dir, ['rev-parse', '--git-path', 'FETCH_HEAD']);
  if (fh.ok) {
    try { t = statSync(path.resolve(dir, fh.out)).mtimeMs; } catch { /* never fetched */ }
  }
  const rl = git(dir, ['reflog', 'show', '--date=unix', '-n', '1', '--format=%gd', base.rev, '--']);
  const m = /@\{(\d+)\}/.exec(rl.out);
  if (m) t = Math.max(t, +m[1] * 1000);
  return t || null;
}

// The tree. A two-line format on purpose: with --graph, git prefixes the
// second line with the right continuation ("| "), so the drawing stays
// connected however long the subject is.
function readGraph(dir, base) {
  const revs = ['HEAD'];
  if (base && base.rev) revs.push(base.rev);
  const r = git(dir, ['log', '--graph', '-n', String(GRAPH_DEPTH),
    '--format=%x1fM%x1f%h%x1f%H%x1f%D%x1f%ct%n%x1fS%x1f%s', ...revs, '--']);
  if (!r.ok) return { error: r.err };
  const rows = r.out.split(/\r?\n/).map(line => {
    const i = line.indexOf('\x1f');
    if (i < 0) return { graph: line };
    const [kind, ...f] = line.slice(i + 1).split('\x1f');
    return kind === 'M'
      ? { graph: line.slice(0, i), hash: f[0], full: f[1], deco: f[2], ct: +f[3] }
      : { graph: line.slice(0, i), subject: f.join('\x1f') };
  });
  const n = git(dir, ['rev-list', '--count', ...revs, '--']);
  const total = n.ok ? +n.out : null;

  // Which of the drawn commits exist on only one side.
  const side = new Map();
  if (base && base.rev && (base.ahead || base.behind)) {
    const lr = git(dir, ['rev-list', '--left-right', 'HEAD...' + base.rev, '--']);
    for (const l of lr.ok ? lr.out.split(/\r?\n/) : []) side.set(l.slice(1), l[0]);
  }
  return { rows, total, shown: rows.filter(x => x.hash).length, side };
}

// =============================================================================
//  Page
// =============================================================================

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--dim:#8c959f;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--dim:#6e7681;--line:#3d444d;--card:#151b23;--link:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.2rem 1rem 4rem}
h1{font-size:1.3rem;margin:.2em 0 .6em;word-break:break-all}
h2{font-size:.95rem;margin:2em 0 .6em}
a{color:var(--link)}
code{font-size:.9em}
.bar{display:flex;gap:.8rem;align-items:center;font-size:.85rem;color:var(--mut);margin-bottom:1rem;flex-wrap:wrap}
.note{font-size:.85rem;color:var(--mut);margin:.5rem 0}
.p{display:flex;gap:.8rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem;margin-bottom:.5rem;text-decoration:none;color:inherit}
.p .t{flex:1;min-width:0}
.p .n{display:block;font-weight:600;word-break:break-all;color:var(--link)}
.p .d{display:block;font-size:.8rem;color:var(--mut)}
.p.off .n{color:var(--mut)}
.tag{font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:.1rem .55rem;white-space:nowrap;flex:none;color:var(--mut)}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;margin-bottom:.55rem}
.box p{margin:.2rem 0}
.url{word-break:break-all}
button{font:inherit;font-size:.9rem;padding:.5rem 1rem;border-radius:8px;border:1px solid var(--link);background:var(--bg);color:var(--link);cursor:pointer;margin-top:.5rem}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;overflow-x:auto;font-size:.82rem;margin:.4rem 0}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.warn{color:var(--warn);font-weight:600}
.gr{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem .8rem;font-size:.88rem;line-height:1.55}
.r{display:flex;align-items:stretch}
.g{display:flex;flex:none;font-family:ui-monospace,Consolas,monospace;color:var(--dim)}
.g i{font-style:normal;width:1ch;flex:none;text-align:center;position:relative}
.g i.v{background:linear-gradient(var(--dim),var(--dim)) center/1.5px 100% no-repeat}
.g i.dn{background:linear-gradient(var(--dim),var(--dim)) center bottom/1.5px calc(100% - .73em) no-repeat}
.g i.up::before{content:'';position:absolute;left:50%;top:0;width:1.5px;height:.73em;margin-left:-.75px;background:var(--dim)}
.g i.o::after{content:'';position:absolute;left:50%;top:.42em;width:.62em;height:.62em;margin-left:-.31em;border-radius:50%;background:var(--link)}
.g i.sl::before,.g i.bs::before{content:'';position:absolute;top:0;bottom:0;left:-.5ch;right:-.5ch}
.g i.sl::before{background:linear-gradient(to top left,transparent calc(50% - .8px),var(--dim) calc(50% - .8px),var(--dim) calc(50% + .8px),transparent calc(50% + .8px))}
.g i.bs::before{background:linear-gradient(to top right,transparent calc(50% - .8px),var(--dim) calc(50% - .8px),var(--dim) calc(50% + .8px),transparent calc(50% + .8px))}
.c{flex:1;min-width:0;padding-left:.35rem;word-break:break-word}
.h{font-family:ui-monospace,Consolas,monospace;font-size:.92em;color:var(--mut)}
.w{font-size:.8rem;color:var(--mut)}
.pill{display:inline-block;font-size:.72rem;line-height:1.5;border:1px solid var(--line);border-radius:999px;padding:0 .45rem;margin:0 .2rem 0 .1rem;white-space:nowrap}
.pill.head{color:var(--ok);border-color:var(--ok)}
.pill.remote{color:var(--link);border-color:var(--link)}
.pill.tagref{color:var(--warn);border-color:var(--warn)}
.only{font-size:.72rem;color:var(--warn);white-space:nowrap}
.more{font-size:.85rem;color:var(--mut);margin:.45rem 0 0}
@keyframes spin{to{transform:rotate(1turn)}}
.busy{opacity:.85;pointer-events:none}
.busy::before{content:'';display:inline-block;width:.75em;height:.75em;margin-right:.45em;vertical-align:-.05em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
`;

// Something has to move the moment a tap lands: through the bridge a page takes
// about a second, and a fetch can take several. Same pattern as cc-open.mjs
// (pointer-events, not disabled; pageshow undoes it after the back button).
const BUSY_JS = `
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.dataset.busy) { e.preventDefault(); return; }
  f.dataset.busy = '1';
  const b = f.querySelector('button');
  if (!b) return;
  b.dataset.label = b.textContent;
  b.textContent = '連線中…';
  b.classList.add('busy');
});
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a.p');
  if (!a || a.dataset.busy) return;
  a.dataset.busy = '1';
  const n = a.querySelector('.n');
  if (n) n.classList.add('busy');
});
addEventListener('pageshow', () => {
  document.querySelectorAll('[data-busy]').forEach(el => {
    delete el.dataset.busy;
    el.querySelectorAll('.busy').forEach(x => x.classList.remove('busy'));
    const b = el.tagName === 'FORM' && el.querySelector('button');
    if (b && b.dataset.label) b.textContent = b.dataset.label;
  });
});
`;

const page = (title, body) =>
  '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>' + esc(title) + '</title><style>' + CSS + '</style><main>' + body + '</main>' +
  '<script>' + BUSY_JS + '</script></html>';

const ago = ms => {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分鐘前';
  if (s < 86400) return Math.round(s / 3600) + ' 小時前';
  return Math.round(s / 86400) + ' 天前';
};

const when = ms => new Date(ms).toLocaleString('zh-TW', { hour12: false });

const selfFor = name => SELF + '?p=' + encodeURIComponent(name);

function listBody(root, list, lead) {
  const rows = list.map(p => {
    const d = p.mtime ? '<span class="d">最後變動 ' + esc(ago(p.mtime)) + '</span>' : '';
    return p.isRepo
      ? '<a class="p" href="' + esc(selfFor(p.name)) + '"><span class="t">' +
        '<span class="n">' + esc(p.name) + '</span>' + d + '</span></a>'
      : '<div class="p off"><span class="t"><span class="n">' + esc(p.name) + '</span>' + d +
        '</span><span class="tag">不是 git repo</span></div>';
  }).join('');
  return '<h1>Git 狀態</h1>' +
    '<div class="bar"><a href="' + esc(PANEL) + '">← 所有 action</a>' +
    '<span>' + esc(root) + '，' + list.filter(p => p.isRepo).length + ' 個 git repo</span></div>' +
    (lead || '') +
    (list.length ? rows : '<p class="note">' + esc(root) + ' 底下還沒有任何專案目錄。</p>');
}

// ---------------------------------------------------------------- one project

function verdict(st, base, remotes) {
  if (st.oid === '(initial)') return '<p class="warn">還沒有任何 commit。</p>';
  if (st.head === '(detached)') {
    return '<p class="warn">HEAD 沒有在任何分支上（detached），沒有分支可以跟 remote 比。</p>';
  }
  if (!remotes.length) return '<p class="warn">這個專案沒有 remote —— 它只存在這台機器上。</p>';
  if (!base) {
    return '<p class="warn">remote 上找不到 <code>' + esc(st.head) + '</code> 這個分支 —— ' +
      '多半是還沒 push 過。</p>';
  }
  if (base.gone) {
    return '<p class="warn">upstream 設的是 <code>' + esc(base.name) + '</code>，但這裡沒有那個分支 —— ' +
      '可能還沒 push 過，或 remote 上已經刪掉了。</p>';
  }
  const vs = '<code>' + esc(base.name) + '</code>';
  const { ahead, behind } = base;
  let line;
  if (!ahead && !behind) line = '<p class="ok">已經 push 了：和 ' + vs + ' 一致。</p>';
  else if (ahead && !behind) line = '<p class="warn">有 ' + ahead + ' 個 commit 還沒 push 到 ' + vs + '。</p>';
  else if (!ahead) {
    line = '<p class="warn">' + vs + ' 比這裡多 ' + behind + ' 個 commit —— remote 上的比較新，這裡還沒 pull。</p>';
  } else {
    line = '<p class="bad">分岔了：這裡有 ' + ahead + ' 個 commit 還沒 push，' +
      vs + ' 也有 ' + behind + ' 個是這裡沒有的。</p>';
  }
  if (base.implicit) {
    line += '<p class="note">這個分支沒有設定 upstream，所以拿 ' + vs + ' 來比。</p>';
  }
  return line;
}

function contactNote(dir, base) {
  if (!base || !base.rev) return '';
  const t = lastContact(dir, base);
  return '<p class="note">' + (t
    ? '上面是跟 ' + esc(ago(t)) + '（' + esc(when(t)) + '）那一次 fetch／push 拿到的 <code>' +
      esc(base.name) + '</code> 比的。remote 後來有沒有新的 commit，要再 fetch 一次才知道。'
    : '不知道 <code>' + esc(base.name) + '</code> 是什麼時候拿到的。要知道 remote 現在的樣子，fetch 一次。') +
    '</p>';
}

function fetchForm(name) {
  return '<form method="POST" action="' + esc(SELF) + '">' +
    '<input type="hidden" name="p" value="' + esc(name) + '">' +
    '<button>向 remote 確認一次（git fetch）</button></form>';
}

function filesBlock(st) {
  if (!st.files.length) return '<p class="note">工作目錄是乾淨的：沒有還沒 commit 的變更。</p>';
  const shown = st.files.slice(0, MAX_FILES).join('\n');
  const rest = st.files.length - MAX_FILES;
  return '<p class="note">' + st.files.length + ' 個檔案有變更還沒 commit：</p>' +
    '<pre>' + esc(shown) + (rest > 0 ? '\n… 還有 ' + rest + ' 個' : '') + '</pre>';
}

function remotesBlock(remotes, base) {
  if (!remotes.length) return '';
  const branch = base && !base.gone ? base.name.split('/').slice(1).join('/') : '';
  return '<h2>Remote</h2>' + remotes.map(r => {
    const link = r.web
      ? '<a class="url" href="' + esc(r.web) + '">' + esc(r.web) + '</a>'
      : '<span class="url">' + esc(r.url) + '</span>';
    // GitHub's commit list is the page to hold this tree against.
    const commits = r.web && /^https:\/\/github\.com\//.test(r.web) && branch &&
      base.name.startsWith(r.name + '/')
      ? ' <span class="w">·</span> <a href="' + esc(r.web + '/commits/' +
          branch.split('/').map(encodeURIComponent).join('/')) + '">commits</a>'
      : '';
    return '<div class="box"><p><span class="w">' + esc(r.name) + '</span></p>' +
      '<p>' + link + commits + '</p>' +
      (r.web && !/^https?:/i.test(r.url) ? '<p class="w url">' + esc(r.url) + '</p>' : '') + '</div>';
  }).join('');
}

// One graph character per cell, drawn rather than typed so the picture stays
// connected: `|` is a line across the full row height (so it keeps going
// beside a subject that wraps), and `*` is a dot joined to whatever arrives
// from above and leaves below. A `/` or `\` in column j is drawn from the
// centre of column j-1 to the centre of column j+1 (git's lanes are two
// columns apart), so `/` leaves the lane on its right at the top and `\` the
// lane on its left. Anything else (`_`, the `-.` of an octopus merge) stays a
// character.
function cells(rows, k) {
  const at = (j, i) => (rows[j] ? rows[j].graph[i] : '') || ' ';
  return [...rows[k].graph].map((ch, i) => {
    if (ch === '|') return '<i class="v"></i>';
    if (ch === '/') return '<i class="sl"></i>';
    if (ch === '\\') return '<i class="bs"></i>';
    if (ch !== '*') return '<i>' + esc(ch) + '</i>';
    const cls = ['o'];
    if ('|*'.includes(at(k - 1, i)) || at(k - 1, i + 1) === '/' || at(k - 1, i - 1) === '\\') {
      cls.push('up');
    }
    if (at(k + 1, i) === '|' || at(k + 1, i - 1) === '/' || at(k + 1, i + 1) === '\\') {
      cls.push('dn');
    }
    return '<i class="' + cls.join(' ') + '"></i>';
  }).join('');
}

function pills(deco, remotes) {
  if (!deco) return '';
  const remotePrefixes = remotes.map(r => r.name + '/');
  return deco.split(', ').filter(d => !/\/HEAD$/.test(d)).map(d => {
    if (d.startsWith('HEAD -> ')) return '<span class="pill head">HEAD → ' + esc(d.slice(8)) + '</span>';
    if (d === 'HEAD') return '<span class="pill head">HEAD</span>';
    if (d.startsWith('tag: ')) return '<span class="pill tagref">' + esc(d.slice(5)) + '</span>';
    const cls = remotePrefixes.some(p => d.startsWith(p)) ? 'remote' : '';
    return '<span class="pill ' + cls + '">' + esc(d) + '</span>';
  }).join('');
}

function graphBlock(gr, remotes, base) {
  if (gr.error) return '<h2>最近 ' + GRAPH_DEPTH + ' 代</h2><pre>' + esc(gr.error) + '</pre>';
  const html = gr.rows.map((x, k) => {
    let c = '';
    if (x.hash) {
      const s = gr.side.get(x.full);
      const only = s === '<' ? ' <span class="only">還沒 push</span>'
                 : s === '>' ? ' <span class="only">只在 ' + esc(base.name) + '</span>' : '';
      c = '<span class="h">' + esc(x.hash) + '</span> ' + pills(x.deco, remotes) +
          '<span class="w" title="' + esc(when(x.ct * 1000)) + '">' + esc(ago(x.ct * 1000)) + '</span>' + only;
    } else if (x.subject !== undefined) {
      c = esc(x.subject);
    }
    return '<div class="r"><span class="g">' + cells(gr.rows, k) + '</span><span class="c">' + c + '</span></div>';
  }).join('');

  const hidden = gr.total === null ? null : gr.total - gr.shown;
  const tail = hidden === null ? ''
    : hidden > 0 ? '↓ 更早還有 ' + hidden + ' 個 commit，沒有列出來。'
    : '全部就這 ' + gr.shown + ' 個 commit，沒有更早的了。';
  return '<h2>最近 ' + GRAPH_DEPTH + ' 代</h2>' +
    '<p class="note">最新的在最上面。</p>' +
    '<div class="gr">' + html + '</div>' +
    (tail ? '<p class="more">' + esc(tail) + '</p>' : '');
}

function projectBody(root, proj, lead) {
  const dir = path.join(root, proj.name);
  const bar = '<div class="bar"><a href="' + esc(SELF) + '">← 所有專案</a>' +
    '<a href="' + esc(PANEL) + '">所有 action</a><span>' + esc(dir) + '</span></div>';
  const top = '<h1>' + esc(proj.name) + '</h1>' + bar + (lead || '');

  if (!proj.isRepo) return top + '<p class="warn">這個目錄不是 git repo（裡面沒有 .git）。</p>';

  const st = readStatus(dir);
  if (st.error) return top + '<p class="bad">git status 失敗：</p><pre>' + esc(st.error) + '</pre>';

  const remotes = readRemotes(dir);
  const base = compareBase(dir, st, remotes);
  const branchLine = st.head && st.head !== '(detached)'
    ? '<p class="note">分支 <code>' + esc(st.head) + '</code></p>' : '';

  let out = top + '<h2>git status</h2>' + branchLine +
    verdict(st, base, remotes) + contactNote(dir, base) +
    (remotes.length ? fetchForm(proj.name) : '') +
    filesBlock(st) +
    remotesBlock(remotes, base);
  if (st.oid !== '(initial)') out += graphBlock(readGraph(dir, base), remotes, base);
  return out;
}

// ---------------------------------------------------------------- shared setup

const errPage = (why, detail) => page('Git 狀態',
  '<h1>Git 狀態</h1><p class="bad">' + esc(why) + '</p>' +
  (detail ? '<pre>' + esc(detail) + '</pre>' : '') +
  '<div class="bar"><a href="' + esc(PANEL) + '">← 所有 action</a></div>');

const ROOT = projectsRoot();
if (!ROOT) {
  process.stdout.write(errPage(
    '讀不到這台機器的 manifest.json，所以不知道 projects 在哪裡。',
    '預期位置：<caddy>\\conf\\manifest.json（node.mounts.p）'));
  process.exit(0);
}

const projects = listProjects(ROOT);
if (!projects) {
  process.stdout.write(errPage('打不開 ' + ROOT + '。'));
  process.exit(0);
}

// A name from the request is only ever used to look up an entry just read from
// the disk; what reaches git as a working directory is that entry's name.
const findProject = name =>
  projects.find(p => p.name.toLowerCase() === String(name || '').toLowerCase());

// ---------------------------------------------------------------- GET

if (METHOD !== 'POST') {
  const want = QUERY.get('p');
  if (!want) {
    process.stdout.write(page('Git 狀態', listBody(ROOT, projects)));
  } else {
    const proj = findProject(want);
    process.stdout.write(proj
      ? page(proj.name + ' · Git 狀態', projectBody(ROOT, proj))
      : page('Git 狀態', listBody(ROOT, projects,
          '<p class="bad">' + esc(ROOT) + ' 底下沒有「' + esc(want) + '」這個專案。</p>')));
  }
  process.exit(0);
}

// ---------------------------------------------------------------- POST: fetch

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no body, treat as empty */ }
// A BOM from a PowerShell caller would stick to the first field name.
raw = raw.replace(/^﻿/, '').trim();

const proj = findProject(new URLSearchParams(raw).get('p'));
if (!proj || !proj.isRepo) {
  process.stdout.write(page('Git 狀態', listBody(ROOT, projects,
    '<p class="bad">沒有選到一個 git repo，沒有執行 fetch。</p>')));
  process.exit(0);
}

const started = Date.now();
const f = git(path.join(ROOT, proj.name), ['fetch', '--quiet'], FETCH_TIMEOUT_MS);
const secs = ((Date.now() - started) / 1000).toFixed(1);
const lead = f.ok
  ? '<p class="ok">剛剛 fetch 過（' + secs + ' 秒），下面是 remote 現在的樣子。</p>'
  : '<p class="bad">git fetch 失敗（' + secs + ' 秒），下面仍是上一次拿到的狀態：</p>' +
    // git redacts credentials in its own messages; this is for any it misses.
    '<pre>' + esc((f.err || '(沒有訊息)').replace(/(:\/\/)[^/@\s]*@/g, '$1')) + '</pre>';
process.stdout.write(page(proj.name + ' · Git 狀態', projectBody(ROOT, proj, lead)));
