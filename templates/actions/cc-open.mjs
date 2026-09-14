// @title   新的 session：在某個專案上開一個
// @desc    挑一個現有的專案，或建一個新的；開起來的那個帶著 Remote Control
// @group   claude
// @page
// @only-when-logged-on
//
// This page starts a *new* Claude Code session on a project directory, with
// Remote Control on, so the phone can pick it up. Its sibling cc-rc.mjs does
// the other half: re-opening sessions that are already running without RC.
//
// Why this can be a plain `Start-Process claude.exe` and nothing more:
//
//   A session that stops on the workspace-trust question ("Is this a project
//   you created or one you trust?") has no input box and never registers with
//   `claude agents --json` -- so it cannot be answered from the phone either.
//   That question is what a launcher like ccrun exists to answer by typing.
//   But the answer is also just a flag in the user's Claude Code config, and
//   it is inherited: a directory under an already-trusted parent is never
//   asked about (measured: a fresh dir under a trusted D:\projects starts
//   straight into the prompt, the same dir under an untrusted D:\ stops on the
//   dialog). So writing that flag ourselves, when nothing above the target is
//   trusted yet, removes the question entirely.
//
//   That write is the one place this file touches a Claude Code internal file,
//   so it is best-effort by construction: it is skipped when a trusted parent
//   already covers the directory, any failure is swallowed, and the launch is
//   verified afterwards through `claude agents --json` -- the official answer.
//   If the flag ever stops working, the session stops on the dialog, the
//   verification says so, and the page tells the user to click Yes on the PC.
//
// Why @only-when-logged-on: same as cc-rc.mjs. actiond runs as
// NT AUTHORITY\LocalService, and a window opened from session 0 is invisible
// to the person at the desk; `claude agents --json` under that account also
// answers with an empty list that looks exactly like "no sessions". actiond
// hands this whole script to the bridge when someone is logged on, so the code
// below already runs as the user -- it never has to cross a bridge itself.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync,
         readdirSync, statSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

// Text going into a PowerShell single-quoted string: double the quotes.
const ps = s => "'" + String(s).replace(/'/g, "''") + "'";

const SELF   = process.env.ACTION_SELF || '/_/run/cc-open';
const METHOD = (process.env.ACTION_METHOD || 'GET').toUpperCase();
const QUERY  = new URLSearchParams(process.env.ACTION_QUERY || '');

// =============================================================================
//  Where the projects live
// =============================================================================

// From the node's own manifest, never hard-coded: the drive is whatever
// `caddyctl node init --drive` was given, and the mount table already says it.
// Mount `p` is the projects root (`/_/p/`).
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

// Directory names only, newest first. The mtime is a proxy for "what I touched
// recently", which is the order a person scans a list of their own projects in.
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
      let mtime = 0;
      try { mtime = statSync(path.join(root, d.name)).mtimeMs; } catch { /* keep 0 */ }
      return { name: d.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// A project name is used to build a path and a session name, and it arrives
// from a web form, so it is checked against what we accept rather than against
// what we fear: letters, digits, dot, dash, underscore, starting on a letter or
// digit. That leaves out every separator, every device name trick that needs a
// colon, and anything starting with a dot or a dash.
const NAME_RE  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function nameProblem(name) {
  if (!name) return '請輸入專案名稱。';
  if (!NAME_RE.test(name)) {
    return '專案名稱只能用英文字母、數字、「.」「-」「_」，開頭要是字母或數字，最多 64 個字。';
  }
  if (RESERVED.test(name)) return '「' + name + '」是 Windows 保留的裝置名稱，不能當目錄名。';
  if (name.endsWith('.')) return '專案名稱的結尾不能是「.」。';
  return '';
}

// =============================================================================
//  Sessions -- the official answer to "what is running"
// =============================================================================

function sessions() {
  const r = spawnSync('claude', ['agents', '--json'], { encoding: 'utf8', windowsHide: true });
  const m = /\[[\s\S]*\]/.exec((r.stdout || '') + (r.stderr || ''));
  if (!m) return { error: (r.stderr || r.stdout || '叫不動 claude agents --json').trim(), list: [] };
  try {
    return { list: JSON.parse(m[0]) };
  } catch (e) {
    return { error: '看不懂 claude agents --json 的輸出：' + e.message, list: [] };
  }
}

const samePath = (a, b) =>
  String(a || '').replace(/[\\/]+$/, '').toLowerCase() ===
  String(b || '').replace(/[\\/]+$/, '').toLowerCase();

// The session name is what the phone list shows, so it should be the project
// name. Two sessions on the same project would then carry the same label, and
// the point of the label is telling them apart -- so the second one gets a
// number. (Claude Code's own auto-generated names do the same with a suffix.)
function pickSessionName(project, list) {
  const taken = new Set((list || []).map(a => String(a.name || '').toLowerCase()));
  if (!taken.has(project.toLowerCase())) return project;
  for (let i = 2; i < 100; i++) {
    if (!taken.has((project + '-' + i).toLowerCase())) return project + '-' + i;
  }
  return project + '-' + Date.now().toString(36).slice(-3);
}

// =============================================================================
//  Workspace trust
// =============================================================================
//
// Claude Code keeps one entry per project directory in ~/.claude.json, and
// `hasTrustDialogAccepted` on it is what pressing "Yes, I trust this folder"
// writes. Trust is inherited downwards, so the flag is only worth writing when
// nothing above the target has it -- which on a node whose projects root has
// been opened once is never.
//
// Everything here is wrapped: this is an internal file, the format is Claude
// Code's business, and the launch is verified through the CLI afterwards.

const CLAUDE_CONFIG = path.join(homedir(), '.claude.json');

// Claude Code writes these keys with forward slashes ("D:/projects/foo").
const trustKey = dir => dir.split('\\').join('/').replace(/\/+$/, '');

// **Keys are compared as they are stored, not normalized.** Old versions wrote
// the same directory with backslashes, so a config can hold both "D:/projects"
// and "D:\projects" -- and Claude Code honours only the forward-slash one
// (measured: with "D:\projects" trusted and "D:/projects" not, a new directory
// under it still stopped on the dialog). Folding backslashes in here would make
// this function answer "already trusted" for a directory that is about to be
// asked about, and then we would skip the one write that avoids the question.
const stored = k => String(k).replace(/\/+$/, '').toLowerCase();

// **The directory's own entry wins.** Inheritance only fills in for directories
// that have no entry at all: an explicit `false` is NOT overridden by a trusted
// parent (measured on pc-b 2026-09-14 -- "D:/projects" true,
// "D:/projects/myproj" false, and the session still stopped on the
// dialog). Treating the parent as sufficient there is exactly the case where we
// skip the one write that would have helped, which is how this went unnoticed:
// the machine where it was first written had no `false` entries to trip over.
function coveredByTrust(projects, dir) {
  const want = trustKey(dir).toLowerCase();
  let inherited = false;
  for (const [k, v] of Object.entries(projects || {})) {
    const have = stored(k);
    if (have.includes('\\')) continue;                   // legacy key, not honoured
    if (have === want) return v?.hasTrustDialogAccepted === true;
    if (v?.hasTrustDialogAccepted === true && want.startsWith(have + '/')) inherited = true;
  }
  return inherited;
}

// Returns a short status for the diagnostics on the result page:
//   'covered' -- something above it (or itself) is already trusted
//   'seeded'  -- we wrote the flag for this directory
//   anything else is the reason we could not, in the user's words.
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

  // Write beside the real file and rename over it: a reader never sees half a
  // config, and the window in which a concurrent write by another session
  // could be lost is one rename wide.
  const tmp = CLAUDE_CONFIG + '.cc-open-' + randomUUID().slice(0, 8);
  try {
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    renameSync(tmp, CLAUDE_CONFIG);
    return 'seeded';
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
    return '寫不進 Claude Code 的設定（' + e.code + '）';
  }
}

// =============================================================================
//  Launching
// =============================================================================

// Run a piece of PowerShell. No bridge -- this process is already the user.
//
// Script in and output out both go through files, never a pipe: PowerShell 5.1
// writes a redirected stdout in the system OEM codepage (Big5 here) and the
// Chinese comes back as mojibake. The input file needs a BOM (UTF-8 without one
// is read as system ANSI); the output file must not have one.
function runPs(script) {
  const id   = randomUUID();
  const inf  = path.join(tmpdir(), 'cc-open-' + id + '.ps1');
  const outf = path.join(tmpdir(), 'cc-open-' + id + '.out');
  const wrapper =
    "$ErrorActionPreference = 'Continue'\n" +
    '$text = & {\n' + script + '\n} *>&1 | Out-String\n' +
    '[IO.File]::WriteAllText(' + ps(outf) + ', $text, [Text.UTF8Encoding]::new($false))\n';
  writeFileSync(inf, '\ufeff' + wrapper, 'utf8');
  try {
    // windowsHide covers this powershell's own console only. The claude window
    // it starts is meant to be visible on the taskbar.
    const r = spawnSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', inf],
      { cwd: process.cwd(), windowsHide: true, timeout: 60000 });
    let text = '';
    try { text = readFileSync(outf, 'utf8'); } catch { /* never ran */ }
    return { code: r.status === null ? -1 : r.status, text: text.trim() };
  } finally {
    rmSync(inf, { force: true });
    rmSync(outf, { force: true });
  }
}

// Find the new console window by title and minimize it. Copied from cc-rc.mjs
// on purpose -- an action is one self-contained file, and both files need the
// same trick for the same reason. The title is "<status symbol> <name>", and
// the symbol changes, so the match is EndsWith. The window belongs to the
// terminal (WindowsTerminal.exe), not to claude.exe, so a pid is no use here.
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
    for ($i = 0; $i -lt 24; $i++) {
        $h = [CcWin]::Find($Suffix)
        if ($h -ne [IntPtr]::Zero) { [void][CcWin]::ShowWindow($h, 6); return $true }
        Start-Sleep -Milliseconds 250
    }
    return $false
}
`;

// A Claude Code session marks its own children with these, and a claude.exe
// that inherits the marker starts with transcript saving off and never
// registers itself -- it looks like a session that failed to start. actiond
// never has them, but this script is also the thing someone runs by hand from
// a session while working on it, and that failure is invisible until you read
// the new window. Clearing them costs nothing.
const ENV_SCRUB = `
foreach ($n in 'CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_BRIDGE_SESSION_ID',
               'CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN','CLAUDE_CODE_ENTRYPOINT',
               'CLAUDE_CODE_SESSION_ATTENDED','CLAUDE_CODE_USE_POWERSHELL_TOOL','CLAUDE_PID','CLAUDECODE') {
    if (Test-Path "Env:$n") { Remove-Item "Env:$n" }
}
`;

function launch(dir, name) {
  // **No -WindowStyle.** Giving one sends Start-Process down the ShellExecute
  // path, which bypasses the Windows 11 "default terminal application" setting
  // and spawns a bare conhost window -- minimized, that is an anonymous icon on
  // the taskbar that people do not find. Without it the console belongs to the
  // terminal the user actually uses, with their icon, font and theme. Minimize
  // afterwards instead: open but not in the way.
  const script = [
    WINDOW_HELPER,
    ENV_SCRUB,
    'Start-Process claude.exe -WorkingDirectory ' + ps(dir) + ' -ArgumentList ' +
      ['--remote-control', name, '--name', name].map(ps).join(','),
    '$hid = Hide-CcWindow ' + ps(name),
    // The parentheses matter: Write-Output 'a' + $(...) is read as three
    // arguments and prints a stray +.
    'Write-Output (' + ps('已開啟：' + name) +
      " + $(if ($hid) { '（視窗已最小化）' } else { '（視窗沒縮成，它開著）' }))",
  ].join('\n');
  return runPs(script);
}

// Wait for the new session to register itself, by polling rather than sleeping
// a fixed number of seconds: it is usually about 1.5 s, and the condition is
// exact -- a session in that directory whose pid was not there before.
async function waitForSession(dir, beforePids, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    const { list } = sessions();
    const found = (list || []).find(a => samePath(a.cwd, dir) && !beforePids.has(a.pid));
    if (found || Date.now() >= deadline) return found || null;
    await new Promise(r => setTimeout(r, 700));
  }
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
h1{font-size:1.3rem;margin:.2em 0 .6em}
h2{font-size:.95rem;margin:2em 0 .6em}
a{color:var(--link)}
code{font-size:.9em}
.bar{display:flex;gap:.8rem;align-items:center;font-size:.85rem;color:var(--mut);margin-bottom:1rem;flex-wrap:wrap}
.note{font-size:.85rem;color:var(--mut);margin-bottom:1.2rem}
.note details{margin-top:.4rem}
.note summary{cursor:pointer;color:var(--link)}
.note ul{margin:.5rem 0;padding-left:1.2rem}
.s{display:flex;gap:.8rem;align-items:flex-start;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;margin-bottom:.55rem}
.s input{margin:.35rem 0 0;width:1.15rem;height:1.15rem;flex:none}
.s .t{flex:1;min-width:0}
.s .n{display:block;font-weight:600;word-break:break-all}
.s .d{display:block;font-size:.8rem;color:var(--mut);word-break:break-all}
.tag{font-size:.72rem;border:1px solid var(--line);border-radius:999px;padding:.1rem .55rem;white-space:nowrap;flex:none;color:var(--mut)}
.tag.on{color:var(--ok);border-color:var(--ok)}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem;margin-bottom:.55rem}
.box input[type=text]{width:100%;font:inherit;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.box label.chk{display:flex;gap:.6rem;align-items:flex-start;margin-top:.7rem;font-size:.9rem}
.box label.chk input{width:1.15rem;height:1.15rem;margin:.2rem 0 0;flex:none}
.box .d{font-size:.8rem;color:var(--mut);display:block;margin-top:.15rem}
button{font:inherit;font-size:.95rem;padding:.6rem 1.2rem;border-radius:8px;border:1px solid var(--link);background:var(--link);color:#fff;cursor:pointer;width:100%;margin-top:.4rem}
button:disabled{background:var(--card);color:var(--mut);border-color:var(--line);cursor:not-allowed}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap;word-break:break-word}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
@keyframes spin{to{transform:rotate(1turn)}}
.busy{opacity:.85;pointer-events:none}
.busy::before{content:'';display:inline-block;width:.75em;height:.75em;margin-right:.45em;vertical-align:-.05em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
`;

// 送出之後畫面要立刻有變化 —— 開一個 session 要跑好幾秒，中間完全不動的話使用者會
// 以為沒按到、再按一次，而那會開出兩個 session。
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
  b.textContent = '開啟中…';
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
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.round(s / 60) + ' 分鐘前';
  if (s < 86400) return Math.round(s / 3600) + ' 小時前';
  return Math.round(s / 86400) + ' 天前';
};

const TOP = '<h1>新的 session</h1>';
const barLine = extra =>
  '<div class="bar"><a href="..">← 所有 action</a>' + (extra || '') + '</div>';

const NOTE =
  '<div class="note">挑一個專案（或建一個新的），這台機器就在那個目錄開一個 Claude Code，' +
  '<strong>帶著 Remote Control</strong>，手機上馬上看得到。' +
  '<details><summary>電腦那端會發生什麼</summary><ul>' +
  '<li>視窗開在你系統設定的那個終端機裡，而且是<strong>最小化</strong>的 —— ' +
  '正在用電腦的人不會被打擾，回到電腦前從工作列點開就能接手。</li>' +
  '<li>標題是 <code>✳ 名字</code>，名字就是專案名稱；' +
  '同一個專案已經有 session 的話，新的那個後面會加編號。</li>' +
  '<li>這一頁只負責把它開起來，不會替你送出第一句話 —— 要說什麼在手機上打。</li>' +
  '</ul></details></div>';

function projectRow(p, sessionCount) {
  const when = p.mtime ? '最後變動 ' + ago(p.mtime) : '';
  return '<label class="s">' +
    '<input type="radio" name="name" value="' + esc(p.name) + '">' +
    '<span class="t"><span class="n">' + esc(p.name) + '</span>' +
      (when ? '<span class="d">' + esc(when) + '</span>' : '') +
    '</span>' +
    (sessionCount
      ? '<span class="tag on">已有 ' + sessionCount + ' 個 session</span>'
      : '') +
    '</label>';
}

function pickerBody(root, list, sessionList, lead) {
  const counts = new Map();
  for (const a of sessionList || []) {
    for (const p of list) {
      if (samePath(a.cwd, path.join(root, p.name))) {
        counts.set(p.name, (counts.get(p.name) || 0) + 1);
      }
    }
  }
  const rows = list.map(p => projectRow(p, counts.get(p.name) || 0)).join('');

  const existing = list.length
    ? '<h2>現有的專案</h2>' +
      '<form method="POST" action="' + esc(SELF) + '">' +
      '<input type="hidden" name="mode" value="pick">' + rows +
      '<button>在這個專案開一個 session</button></form>'
    : '<h2>現有的專案</h2><div class="note">' + esc(root) + ' 底下還沒有任何專案目錄。</div>';

  const fresh =
    '<h2>建立新的專案</h2>' +
    '<form method="POST" action="' + esc(SELF) + '">' +
    '<input type="hidden" name="mode" value="new">' +
    '<div class="box">' +
      '<input type="text" name="name" placeholder="專案名稱" required maxlength="64" ' +
        'pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" ' +
        'autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">' +
      '<span class="d">會建在 ' + esc(root) + ' 底下。英文字母、數字、「.」「-」「_」。</span>' +
      '<label class="chk"><input type="checkbox" name="genesis" value="1">' +
      '<span>同時建立空的 <code>genesis/</code> 子目錄</span></label>' +
    '</div>' +
    '<button>建立並開一個 session</button></form>';

  return (lead || '') + NOTE + existing + fresh;
}

const errPage = (why, detail) => page('新的 session',
  TOP + '<p class="bad">' + esc(why) + '</p>' +
  (detail ? '<pre>' + esc(detail) + '</pre>' : '') + barLine());

// ---------------------------------------------------------------- shared setup
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

const findProject = name =>
  projects.find(p => p.name.toLowerCase() === String(name).toLowerCase());

// ---------------------------------------------------------------- GET
if (METHOD !== 'POST') {
  const { list, error } = sessions();

  // ?check=<name> is the follow-up from a launch that had not registered yet
  // when the result page was rendered.
  let lead = '';
  const check = QUERY.get('check');
  if (check && findProject(check)) {
    const dir = path.join(ROOT, findProject(check).name);
    const n = (list || []).filter(a => samePath(a.cwd, dir)).length;
    lead = n
      ? '<p class="ok">' + esc(check) + ' 現在有 ' + n + ' 個 session 在跑，手機上應該看得到。</p>'
      : '<p class="bad">' + esc(check) + ' 上還是沒有 session。' +
        '那台電腦上多半有一個 Claude Code 停在「是否信任這個資料夾」的問題上 —— ' +
        '要有人在電腦前選「Yes, I trust this folder」它才會繼續。</p>';
  }

  const body = TOP +
    barLine('<span>' + projects.length + ' 個專案</span>') +
    (error ? '<p class="bad">列不出正在跑的 session：' + esc(error) + '</p>' : '') +
    pickerBody(ROOT, projects, list, lead);
  process.stdout.write(page('新的 session', body));
  process.exit(0);
}

// ---------------------------------------------------------------- POST
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no body, treat as empty */ }
// PowerShell 5.1 puts a BOM on anything it writes to a pipe, and a BOM sticks
// to the first field name: sid becomes <BOM>sid and reads back as absent, with
// no error anywhere. Browsers never send one; hand-driven callers do.
raw = raw.replace(/^\ufeff/, '').trim();

const form    = new URLSearchParams(raw);
const mode    = form.get('mode') === 'new' ? 'new' : 'pick';
const typed   = (form.get('name') || '').trim();
const genesis = form.get('genesis') === '1';

const bail = why => {
  process.stdout.write(page('新的 session', TOP +
    '<p class="bad">' + esc(why) + '</p>' + barLine() +
    pickerBody(ROOT, projects, sessions().list, '')));
  process.exit(0);
};

// The name rules apply to **creating** a directory, not to picking one that is
// already there: a project called `我的筆記` or `old stuff` is perfectly legal
// on disk, and refusing to open it would be this page inventing a rule about
// someone else's directory. What makes picking safe is not the charset, it is
// that the chosen name has to match an entry we just read from the disk, and
// the name that goes on to build the path is that entry's, not the form's.
const hit = findProject(typed);
if (mode === 'new') {
  const problem = nameProblem(typed);
  if (problem) bail(problem);
} else if (!typed) {
  bail('還沒有選到專案。');
}

// Typing the name of a project that is already there is not an error -- it is
// almost always someone who wants that project. Ask, do not guess, and do not
// silently open a session somewhere they did not mean.
if (mode === 'new' && hit) {
  const dir = path.join(ROOT, hit.name);
  const running = (sessions().list || []).filter(a => samePath(a.cwd, dir)).length;
  process.stdout.write(page('新的 session', TOP +
    '<div class="note"><strong>' + esc(hit.name) + ' 已經存在了。</strong><br>' +
    esc(dir) + (hit.mtime ? '，最後變動 ' + esc(ago(hit.mtime)) : '') +
    (running ? '，而且已經有 ' + running + ' 個 session 在跑' : '') + '。</div>' +
    '<p>要在這個現有的專案上開一個 session 嗎？</p>' +
    '<form method="POST" action="' + esc(SELF) + '">' +
    '<input type="hidden" name="mode" value="pick">' +
    '<input type="hidden" name="name" value="' + esc(hit.name) + '">' +
    (genesis ? '<input type="hidden" name="genesis" value="1">' : '') +
    '<button>好，連到現有的 ' + esc(hit.name) + '</button></form>' +
    (genesis ? '<div class="note">裡面沒有 <code>genesis/</code> 的話會一併建起來。</div>' : '') +
    barLine('<span>或回上一頁改一個名字</span>')));
  process.exit(0);
}

if (mode === 'pick' && !hit) bail(ROOT + ' 底下沒有「' + typed + '」這個專案。');

// The name that reaches the filesystem is the one on disk (for an existing
// project) or the one that just passed NAME_RE -- never the raw form value.
const project = hit ? hit.name : typed;
const dir = path.join(ROOT, project);

// Belt and braces: whatever happened above, the target has to be a direct child
// of the projects root.
if (!samePath(path.dirname(path.resolve(dir)), path.resolve(ROOT))) {
  process.stdout.write(errPage('目標目錄不在 ' + ROOT + ' 底下，沒有執行。'));
  process.exit(0);
}

const made = [];
try {
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); made.push(dir); }
  if (genesis) {
    const g = path.join(dir, 'genesis');
    if (!existsSync(g)) { mkdirSync(g); made.push(g); }
  }
} catch (e) {
  process.stdout.write(errPage('建立目錄失敗，沒有開 session。', e.message));
  process.exit(0);
}

const before = sessions();
const beforePids = new Set((before.list || []).map(a => a.pid));
const name = pickSessionName(project, before.list);

const trust = ensureTrusted(dir);
const started = Date.now();
const run = launch(dir, name);
const session = run.code === 0 ? await waitForSession(dir, beforePids, 6000) : null;
const waited = Math.round((Date.now() - started) / 1000);

// How to take over at the desk. This belongs on the page, not in the docs:
// the button was pressed on a phone, and the next time the user thinks about
// it they are sitting in front of the machine with only this page in hand.
const backHome = sid =>
  '<div class="note"><strong>回到電腦前怎麼接手</strong><ul>' +
  '<li>工作列上會多一個<strong>最小化的終端機視窗</strong>，標題是 <code>✳ ' + esc(name) + '</code>。' +
  '點開就是它 —— 同一個 session，手機上講過的話都在裡面，直接接著打就好。</li>' +
  '<li>想把它拿回自己的終端機分頁：<strong>先在那個視窗裡 <code>/exit</code></strong>，' +
  '再到你的分頁跑 <code>claude --resume ' + esc(sid || '<session-id>') +
  ' --remote-control ' + esc(name) + ' --name ' + esc(name) + '</code>。' +
  '不先結束的話會有兩個行程寫同一份對話紀錄。</li></ul></div>';

const madeNote = made.length
  ? '<div class="note">建立了 ' + made.map(m => '<code>' + esc(m) + '</code>').join('、') + '。</div>'
  : '';

const ok = run.code === 0 && !!session;
let head;
if (run.code !== 0) {
  head = '<p class="bad">PowerShell 回報 exit ' + run.code + '，session 沒有開成。</p>';
} else if (session) {
  head = '<p class="ok">' + esc(project) + ' 開好了（' + waited + ' 秒），' +
         '手機上應該看得到 <code>' + esc(name) + '</code>。</p>';
} else {
  head = '<p class="bad">claude 起來了，但 ' + waited + ' 秒內還沒登記自己。</p>';
}

const why = !session && run.code === 0
  ? '<div class="note">兩種可能：它只是起得比較慢，或者它停在<strong>「是否信任這個資料夾」' +
    '</strong>的問題上 —— 那種 session 沒有輸入框，也不會有 Remote Control，' +
    '要有人在那台電腦前選「Yes, I trust this folder」。' +
    (trust === 'seeded' ? '（這一次已經先替它記下信任了。）'
      : trust === 'covered' ? '（這個目錄本來就在信任範圍內。）'
      : '（而且這一次沒能先替它記下信任：' + esc(trust) + '）') +
    '<br><a href="' + esc(SELF) + '?check=' + encodeURIComponent(project) + '">再看一次 →</a></div>'
  : '';

process.stdout.write(page('新的 session', TOP + head + madeNote +
  (run.text ? '<pre>' + esc(run.text) + '</pre>' : '') +
  (ok ? backHome(session.sessionId) : '') + why +
  barLine('<a href="' + esc(SELF) + '">再開一個</a>')));
