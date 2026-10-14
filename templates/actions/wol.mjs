// @title   Wake-on-LAN：叫醒區網上的電腦
// @desc    輸入 IP 的最後一段就送出魔術封包；叫醒過的會記住，下次按一下就好
// @group   network
// @page
//
// Type the last part of an IP ("8" for 10.0.0.8 when this machine is on
// 10.0.0.x), or a whole IP, and this page sends a magic packet to it.
// Every machine woken once stays on the page as a one-tap button, and can be
// deleted from there when it was a typo. Each button shows whether that machine
// answers right now, refreshed while the page is open -- so you can see it is
// already up before sending anything, and see it come up after you did,
// instead of tapping again and again.
//
// Remembering is not a convenience here, it is the whole point. A magic packet
// is addressed to the target's MAC, not its IP, and a machine that is off
// answers nothing -- at the moment you want to wake it, its MAC cannot be
// looked up. So the MAC has to be learned while the machine is (or recently
// was) awake and kept until then.
//
// The only live source is this machine's ARP table, and it forgets: a machine
// that went off leaves a stale entry with its MAC behind, but the first time
// anything tries to reach that IP -- a ping, a file share, this page's own
// status check -- Windows asks again, gets no answer, and replaces the MAC
// with zeros (state Unreachable). So every page load copies the table's
// entries for this machine's subnets into _wol-seen.json, and that copy is
// what still knows a MAC after the table forgot it.
//
// Two files, because they answer different questions. _wol.json is the
// buttons: what the user chose to keep. _wol-seen.json is every machine this
// one has seen on the LAN. Deleting a button does not forget the machine --
// typing its number again finds it in _wol-seen.json.
//
// Learning, in this order:
//   1. the ARP table as it is now.
//   2. _wol-seen.json.
//   3. only when neither knows: one ping, then the ARP table again. The ping
//      is not for the reply (ICMP is commonly firewalled); it is for the ARP
//      request Windows sends before it. Never probe first: probing a machine
//      that is off erases the stale entry step 1 would have found.
//   4. the user types it. A typed MAC goes on the button only, never into
//      _wol-seen.json: it may be wrong, and then deleting the button has to
//      really forget it -- otherwise typing the number again would keep using
//      the wrong MAC without ever asking again.
//
// Sending: the packet is a layer-2 broadcast, so it only reaches machines on
// one of this machine's own subnets. The socket is bound to this machine's
// address on the target's subnet and sends to that subnet's broadcast and to
// 255.255.255.255. Without the bind, a machine with several adapters (a
// Hyper-V switch, a VPN) sends the limited broadcast out of whichever one
// Windows picks.
//
// No @only-when-logged-on: nothing here belongs to the user. arp, ping and a
// broadcast work the same under actiond's own account, and both files sit next
// to this script under C:\Caddy, which install.ps1 makes writable for both
// that account and the user. They are also reachable over WebDAV at /_/a/.

import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ENT[c]);

const SELF   = process.env.ACTION_SELF || '/_/run/wol';
const METHOD = (process.env.ACTION_METHOD || 'GET').toUpperCase();
const QUERY  = new URLSearchParams(process.env.ACTION_QUERY || '');

// The action panel is this page's own URL minus its last segment. Derived, not
// hard-coded: the prefix is /_/run through Caddy and /run on actiond's own port.
const PANEL = SELF.replace(/\/[^/]*$/, '') || '/';

const STORE = path.join(path.dirname(process.argv[1]), '_wol.json');
const SEEN  = path.join(path.dirname(process.argv[1]), '_wol-seen.json');

const ROUNDS = 3;

// =============================================================================
//  Addresses
// =============================================================================

// IPv4 as an unsigned 32-bit number. Bitwise results go through >>> 0 because
// JavaScript's & and | return signed 32-bit values.
const ip2n = ip => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const n2ip = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isQuad = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every(o => Number(o) <= 255);
const isPrivate = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

// This machine's IPv4 subnets that a broadcast can go out on.
function localNets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      const mask = ip2n(a.netmask);
      if (mask === 0xffffffff) continue;            // point-to-point: no one to broadcast to
      const net = (ip2n(a.address) & mask) >>> 0;
      out.push({
        address: a.address,
        mask,
        net,
        bcast: (net | ~mask) >>> 0,
        cidr: n2ip(net) + '/' + (a.cidr ? a.cidr.split('/')[1] : '?'),
      });
    }
  }
  return out;
}

// The subnet a bare number like "8" refers to: the one the default route goes
// out of. A connected UDP socket asks the routing table without sending
// anything; 192.0.2.1 is a documentation address, so no real host is implied.
async function primaryNet(nets) {
  const s = dgram.createSocket('udp4');
  let addr = null;
  try {
    await new Promise((res, rej) => {
      s.once('error', rej);
      s.connect(9, '192.0.2.1', err => (err ? rej(err) : res()));
    });
    addr = s.address().address;
  } catch { /* no default route; fall back below */ }
  try { s.close(); } catch { /* already closed */ }
  return nets.find(n => n.address === addr) || nets.find(n => isPrivate(n.address)) || nets[0] || null;
}

const prefixOf = net => net.address.split('.').slice(0, 3).join('.') + '.';

// What the user typed -> an IP on one of this machine's subnets, or why not.
function resolveTarget(raw, nets, primary) {
  const s = String(raw || '').trim();
  let ip;
  if (s === '') return { error: '沒有輸入要叫醒哪一台。' };
  if (/^\d{1,3}$/.test(s)) {
    const n = Number(s);
    if (n < 1 || n > 254) return { error: '「' + s + '」不行：最後一段是 1 到 254。' };
    ip = prefixOf(primary) + n;
  } else if (isQuad(s)) {
    ip = n2ip(ip2n(s));                             // also drops leading zeros
  } else {
    return { error: '看不懂「' + s + '」：輸入 IP 的最後一段（例如 8），或完整的 IP。' };
  }
  const x = ip2n(ip);
  const net = nets.find(n => ((x & n.mask) >>> 0) === n.net);
  if (!net) {
    return { ip, error: ip + ' 不在這台機器的區網上（' + nets.map(n => n.cidr).join('、') +
      '）。魔術封包是區網裡的廣播，過不了路由器。' };
  }
  if (x === net.net || x === net.bcast) return { ip, error: ip + ' 是網段本身的位址，不是一台機器。' };
  if (nets.some(n => n.address === ip)) return { ip, error: ip + ' 就是這台機器自己。' };
  return { ip, net };
}

// Any common spelling -> AA-BB-CC-DD-EE-FF, the way `ipconfig /all` shows it.
// All-zero and group addresses (broadcast, multicast) are never a machine.
function normMac(raw) {
  const hex = String(raw || '').replace(/[\s:.-]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(hex)) return null;
  if (/^0+$/.test(hex) || (parseInt(hex.slice(0, 2), 16) & 1)) return null;
  return hex.toUpperCase().match(/../g).join('-');
}

// =============================================================================
//  Learning a MAC
// =============================================================================

// `arp -a`: every IP -> MAC pair on one of this machine's subnets. The headers
// and the type column are localized and printed in the OEM code page, so only
// the ASCII address pair on each entry line is read. Entries Windows has marked
// unreachable are not listed; broadcast and multicast addresses fail normMac.
function arpTable(nets) {
  const r = spawnSync('arp', ['-a'], { encoding: 'latin1', windowsHide: true, timeout: 5000 });
  const out = new Map();
  for (const m of (r.stdout || '').matchAll(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s/gim)) {
    const mac = normMac(m[2]);
    const x = isQuad(m[1]) ? ip2n(m[1]) : null;
    const net = x === null ? null : nets.find(n => ((x & n.mask) >>> 0) === n.net);
    if (mac && net && x !== net.net && x !== net.bcast) out.set(n2ip(x), mac);
  }
  return out;
}

// _wol-seen.json: { "<ip>": "<MAC>" }. Missing means empty. Unreadable means
// null -- read-only for this run, like _wol.json, so a hand edit with a typo
// does not wipe what it knew.
function loadSeen() {
  if (!existsSync(SEEN)) return {};
  try {
    const o = JSON.parse(readFileSync(SEEN, 'utf8').replace(/^﻿/, ''));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

// Writes only when something changed. Best effort: when it cannot be written,
// the page still works from the ARP table and the buttons.
function rememberSeen(seen, pairs) {
  if (!seen) return;
  let changed = false;
  for (const [ip, mac] of pairs) {
    if (seen[ip] !== mac) { seen[ip] = mac; changed = true; }
  }
  if (!changed) return;
  const key = s => (isQuad(s) ? ip2n(s) : Infinity);
  try {
    writeJson(SEEN, Object.fromEntries(Object.entries(seen).sort(([a], [b]) => key(a) - key(b))));
  } catch { /* see above */ }
}

// See the header for the order, and why nothing is sent before the table and
// the record have been asked.
function findMac(ip, nets, live, seen) {
  if (live.has(ip)) return { mac: live.get(ip), how: 'arp' };
  const old = seen && normMac(seen[ip]);
  if (old) return { mac: old, how: 'seen' };
  spawnSync('ping', ['-n', '1', '-w', '1000', ip], { windowsHide: true, timeout: 4000 });
  const asked = arpTable(nets).get(ip);
  if (!asked) return null;
  rememberSeen(seen, [[ip, asked]]);
  return { mac: asked, how: 'probe' };
}

// =============================================================================
//  Sending
// =============================================================================

// Six 0xFF bytes, then the MAC sixteen times, to UDP port 9 (discard).
async function sendMagic(mac, net) {
  const hw = Buffer.from(mac.split('-').map(h => parseInt(h, 16)));
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(hw)]);
  const s = dgram.createSocket('udp4');
  let fail = null;
  s.on('error', e => fail && fail(e));
  try {
    await new Promise((res, rej) => { fail = rej; s.bind({ address: net.address, port: 0 }, res); });
    s.setBroadcast(true);
    for (let i = 0; i < ROUNDS; i++) {
      for (const to of [n2ip(net.bcast), '255.255.255.255']) {
        await new Promise((res, rej) => s.send(pkt, 9, to, e => (e ? rej(e) : res())));
      }
    }
  } finally {
    try { s.close(); } catch { /* never bound */ }
  }
}

// =============================================================================
//  Is it awake?
// =============================================================================

// A machine counts as awake when something on it answers. Ping first: most
// machines answer it, it is one packet, and on a LAN the reply arrives in tens
// of milliseconds. Only when ping gets no reply are the ports tried -- a TCP
// connection accepted on one a machine commonly listens on (Windows file
// sharing and RPC, Remote Desktop, ssh, web) -- because a Windows firewall
// often drops ping while file sharing or Remote Desktop still answers. Doing
// it in that order means a machine that answers ping does not get a burst of
// connection attempts in its logs every few seconds (sshd logs each one).
// Each step is capped at PROBE_MS; anything slower is "no answer".
//
// "No answer" is not "off": a Windows firewall drops what it does not allow
// without replying, and a refused connection is no help either -- Windows
// retries the SYN after a reset and reports the refusal only after about two
// seconds. The page says "沒有回應", not "關機".
//
// ARP is deliberately not a signal: a sleeping network card answers ARP on its
// host's behalf (ARP offload), so ARP says yes to machines that are asleep.
//
// Only machines already on the list are probed, so their MACs are already
// saved; the "never probe first" rule in the header is about learning one.
const PROBE_PORTS = [445, 139, 135, 3389, 22, 80, 443];
const PROBE_MS = 1000;

// `ping` prints localized text in the OEM code page, but an echo reply always
// carries the ASCII "TTL=". The exit code is not used: Windows ping counts a
// "destination host unreachable" reply as received and exits 0 for it.
function pingProbe(ip) {
  return new Promise(res => {
    let out = '';
    const c = spawn('ping', ['-n', '1', '-w', String(PROBE_MS), ip], { windowsHide: true });
    c.stdout.on('data', d => { out += d.toString('latin1'); });
    c.on('error', () => res(false));
    c.on('close', () => res(/TTL=/i.test(out)));
  });
}

function tcpProbe(ip, port) {
  return new Promise(res => {
    const s = net.connect({ host: ip, port });
    const done = ok => { s.destroy(); res(ok); };
    s.setTimeout(PROBE_MS, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', e => done(e.code === 'ECONNREFUSED'));
  });
}

// The ports in parallel: true as soon as one answers, false once all gave up.
async function isAwake(ip) {
  if (await pingProbe(ip)) return true;
  const probes = PROBE_PORTS.map(p => tcpProbe(ip, p));
  return new Promise(res => {
    let left = probes.length;
    for (const p of probes) p.then(ok => (ok ? res(true) : --left || res(false)));
  });
}

// =============================================================================
//  The list
// =============================================================================

// A JSON array of { ip, mac }. Other fields someone adds by hand over WebDAV
// are kept. Anything unreadable makes the list read-only for this run rather
// than being dropped on the next save: a hand edit with a typo must not cost
// the other entries.
function loadStore() {
  if (!existsSync(STORE)) return { hosts: [] };
  try {
    const raw = JSON.parse(readFileSync(STORE, 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(raw)) throw new Error('最外層要是一個陣列 [ ... ]');
    const hosts = raw.map((h, i) => {
      const ip = h && typeof h.ip === 'string' && isQuad(h.ip) ? n2ip(ip2n(h.ip)) : null;
      const mac = h && normMac(h.mac);
      if (!ip || !mac) throw new Error('第 ' + (i + 1) + ' 筆要有 ip 和 mac：' + JSON.stringify(h));
      return { ...h, ip, mac };
    });
    return { hosts };
  } catch (e) {
    return { hosts: [], error: e.message };
  }
}

// Written beside and renamed over, so a page opened meanwhile never reads half
// a file.
function writeJson(file, value) {
  const tmp = file + '.' + process.pid;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}

function saveStore(hosts) {
  hosts.sort((a, b) => ip2n(a.ip) - ip2n(b.ip));
  writeJson(STORE, hosts);
}

// =============================================================================
//  Page
// =============================================================================

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--link:#0969da;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#9198a1;--line:#3d444d;--card:#151b23;--link:#4493f8;--ok:#3fb950;--bad:#f85149;--warn:#d29922}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,"Segoe UI","Noto Sans TC",system-ui,sans-serif}
main{max-width:44rem;margin:0 auto;padding:1.2rem 1rem 4rem}
h1{font-size:1.3rem;margin:.2em 0 .6em}
h2{font-size:.95rem;margin:0}
.hd{display:flex;justify-content:space-between;align-items:baseline;margin:2em 0 .6em}
a{color:var(--link)}
code{font-size:.9em}
form{margin:0}
.bar{display:flex;gap:.8rem;align-items:center;font-size:.85rem;color:var(--mut);margin-bottom:1rem;flex-wrap:wrap}
.note{font-size:.85rem;color:var(--mut);margin:.5rem 0}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.warn{color:var(--warn);font-weight:600}
.mono{font-family:ui-monospace,Consolas,monospace}
button{font:inherit;font-size:1rem;padding:.6rem 1.2rem;border-radius:10px;border:1px solid var(--link);background:var(--link);color:#fff;cursor:pointer;white-space:nowrap}
.go{display:flex;gap:.5rem;align-items:stretch}
.field{flex:1;min-width:0;display:flex;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--card);padding:0 .8rem;font-size:1.2rem}
.field:focus-within{border-color:var(--link)}
.field span{color:var(--mut);white-space:nowrap}
.field input{flex:1;min-width:3ch;border:0;background:transparent;color:var(--fg);font:inherit;padding:.55rem 0 .55rem .1rem;outline:none}
.field.mac{font-size:1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(10rem,1fr));gap:.5rem}
.host{position:relative;width:100%;text-align:left;background:var(--card);color:var(--fg);border-color:var(--line);padding:.75rem .9rem}
.host .n{display:block;font-size:1.1rem;font-weight:600;color:var(--link)}
.host .d{display:block;font-size:.75rem;color:var(--mut)}
.host .s{display:flex;align-items:center;gap:.4rem;font-size:.8rem;color:var(--mut);margin-top:.3rem}
.host .s::before{content:'';flex:none;width:.6rem;height:.6rem;border-radius:50%;background:var(--line)}
.host.wait .s::before{animation:blink 1.2s ease-in-out infinite}
.host.down .s::before{background:var(--mut)}
.host.up{border-color:var(--ok)}
.host.up .s{color:var(--ok);font-weight:600}
.host.up .s::before{background:var(--ok);box-shadow:0 0 0 3px rgba(46,160,67,.25)}
@keyframes blink{50%{opacity:.3}}
.row{display:flex;gap:.8rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.6rem .9rem;margin-bottom:.5rem}
.row .t{flex:1;min-width:0}
.row .n{display:block;font-weight:600}
.row .d{display:block;font-size:.75rem;color:var(--mut)}
.del{background:var(--bg);color:var(--bad);border-color:var(--bad);padding:.4rem .9rem;font-size:.9rem}
.alt{background:var(--bg);color:var(--link);padding:.4rem .9rem;font-size:.9rem}
.box{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.8rem .9rem;margin-bottom:1rem}
.box p{margin:.2rem 0 .5rem}
@keyframes spin{to{transform:rotate(1turn)}}
.busy{opacity:.85;pointer-events:none}
.busy::before{content:'';display:inline-block;width:.75em;height:.75em;margin-right:.45em;vertical-align:-.05em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
.host.busy::before{position:absolute;top:.8rem;right:.8rem;margin:0;color:var(--link)}
`;

// Something has to move the moment a tap lands: through the bridge a page takes
// about a second. Same pattern as git-status.mjs (pointer-events, not disabled;
// pageshow undoes it after the back button).
const BUSY_JS = `
document.addEventListener('submit', e => {
  const f = e.target;
  if (f.dataset.busy) { e.preventDefault(); return; }
  f.dataset.busy = '1';
  const b = f.querySelector('button');
  if (b) b.classList.add('busy');
});
addEventListener('pageshow', () => {
  document.querySelectorAll('[data-busy]').forEach(f => {
    delete f.dataset.busy;
    f.querySelectorAll('.busy').forEach(x => x.classList.remove('busy'));
  });
});
`;

// Live status of the saved machines: the page asks ?status every few seconds
// while it is visible and paints each button. Each ask is one run of this
// script (through the bridge when someone is logged on), so it stops while the
// tab is hidden and slows down after a few minutes -- a page left open on a
// desk should not keep the host busy forever. The pace is set from the last
// load, which a wake also is.
const STATUS_JS = `
(() => {
  const grid = document.querySelector('[data-status]');
  if (!grid) return;
  const t0 = Date.now();
  const TEXT = { up: '醒著', down: '沒有回應' };
  let timer = null, asking = false;
  const paint = map => {
    grid.querySelectorAll('.host[data-ip]').forEach(b => {
      const v = map[b.dataset.ip];
      if (typeof v !== 'boolean') return;
      const st = v ? 'up' : 'down';
      b.classList.remove('wait', 'up', 'down');
      b.classList.add(st);
      b.querySelector('.s').textContent = TEXT[st];
    });
    const w = document.getElementById('waiting');
    if (w && map[w.dataset.ip] === true) {
      w.removeAttribute('id');
      w.className = 'ok';
      w.textContent = w.dataset.ip + ' 有回應了（送出後 ' + Math.round((Date.now() - t0) / 1000) + ' 秒）。';
    }
  };
  const schedule = () => {
    if (timer || asking || document.hidden) return;
    timer = setTimeout(ask, Date.now() - t0 < 300000 ? 4000 : 30000);
  };
  const ask = async () => {
    timer = null;
    if (document.hidden) return;
    asking = true;
    try {
      const r = await fetch(grid.dataset.status, { cache: 'no-store' });
      if (r.ok) paint(await r.json());
    } catch { /* keep the last answer; try again next round */ }
    asking = false;
    schedule();
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !timer && !asking) ask(); });
  ask();
})();
`;

const page = body =>
  '<!doctype html><html lang="zh-Hant"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Wake-on-LAN</title><style>' + CSS + '</style><main>' + body + '</main>' +
  '<script>' + BUSY_JS + STATUS_JS + '</script></html>';

const hidden = (name, value) =>
  '<input type="hidden" name="' + name + '" value="' + esc(value) + '">';

const postForm = (fields, inner, cls) =>
  '<form method="POST" action="' + esc(SELF) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' +
  Object.entries(fields).map(([k, v]) => hidden(k, v)).join('') + inner + '</form>';

function top(primary) {
  return '<h1>Wake-on-LAN</h1>' +
    '<div class="bar"><a href="' + esc(PANEL) + '">← 所有 action</a>' +
    (primary ? '<span>這台在 ' + esc(primary.address) + '（' + esc(primary.cidr) + '）</span>' : '') +
    '</div>';
}

function storeError(store) {
  return store.error
    ? '<p class="bad">記住的清單讀不懂，這一頁不會去改它：</p>' +
      '<p class="note mono">' + esc(STORE) + '<br>' + esc(store.error) + '</p>'
    : '';
}

// Asked when a MAC is needed and none could be found, or the typed one was bad.
function macForm(ip, typed, headline) {
  return '<div class="box">' +
    (headline || '<p class="warn">不知道 ' + esc(ip) + ' 的 MAC，沒辦法叫醒它。</p>') +
    '<p class="note">魔術封包要寫上對方網卡的 MAC，而關著的機器不會回應任何詢問。' +
    '它開著的時候再按一次，這裡就會記住；或是直接輸入 —— 在那台機器上 ' +
    '<code>ipconfig /all</code> 的「實體位址」，或路由器的 DHCP 用戶端清單裡查得到。</p>' +
    postForm({ op: 'wake', ip },
      '<label class="field mac"><input class="mono" name="mac" autocomplete="off" required ' +
      'placeholder="AA-BB-CC-DD-EE-FF" value="' + esc(typed || '') + '"></label>' +
      '<button>記住並叫醒</button>', 'go') +
    '</div>';
}

function mainBody(ctx, lead, typed) {
  const { primary, store } = ctx;
  const input = postForm({ op: 'wake' },
    '<label class="field"><span>' + esc(prefixOf(primary)) + '</span>' +
    '<input name="ip" inputmode="decimal" enterkeyhint="go" autocomplete="off" required ' +
    'value="' + esc(typed || '') + '"></label><button>叫醒</button>', 'go');

  const hosts = store.hosts.map(h => postForm({ op: 'wake', ip: h.ip },
    '<button class="host wait" data-ip="' + esc(h.ip) + '"><span class="n">' + esc(h.ip) + '</span>' +
    '<span class="d mono">' + esc(h.mac) + '</span><span class="s">檢查中…</span></button>')).join('');

  return top(primary) + (lead || '') + input +
    '<p class="note">輸入 IP 的最後一段就好，或是完整的 IP。</p>' +
    '<div class="hd"><h2>一鍵叫醒記住的機器</h2>' +
    (store.hosts.length ? '<a href="' + esc(SELF + '?edit=1') + '">管理</a>' : '') + '</div>' +
    storeError(store) +
    (store.hosts.length
      ? '<div class="grid" data-status="' + esc(SELF + '?status') + '">' + hosts + '</div>' +
        '<p class="note">綠色的是現在有回應的機器，不必再叫。沒有回應多半是關著或睡著，' +
        '也可能是那台的防火牆不回應詢問。</p>'
      : store.error ? '' : '<p class="note">還沒有。叫醒過一次的機器會留在這裡，下次按一下就好。</p>');
}

function editBody(ctx, lead) {
  const { primary, store } = ctx;
  const rows = store.hosts.map(h =>
    '<div class="row"><span class="t"><span class="n">' + esc(h.ip) + '</span>' +
    '<span class="d mono">' + esc(h.mac) + '</span></span>' +
    (store.error ? '' : postForm({ op: 'del', ip: h.ip }, '<button class="del">刪除</button>')) +
    '</div>').join('');
  return top(primary) + (lead || '') +
    '<div class="hd"><h2>管理記住的機器</h2><a href="' + esc(SELF) + '">完成</a></div>' +
    storeError(store) +
    (store.hosts.length || store.error ? rows : '<p class="note">清單是空的。</p>') +
    '<p class="note">刪掉的只是按鈕：這台在區網上看過的機器，再輸入一次號碼就回來了。' +
    '手動輸入 MAC 的不會，要再輸入一次。</p>';
}

const out = html => { process.stdout.write(page(html)); process.exit(0); };

// =============================================================================
//  Request
// =============================================================================

const nets = localNets();
const primary = await primaryNet(nets);
if (!primary) {
  out(top(null) + '<p class="bad">這台機器沒有連在任何 IPv4 區網上，沒有地方可以送魔術封包。</p>');
}
const store = loadStore();
const ctx = { primary, store };

// ?status: { "<ip>": true|false } for the machines on the list, read by
// STATUS_JS. Nothing else can be asked about -- a request does not get to
// choose what this machine probes.
if (METHOD !== 'POST' && QUERY.has('status')) {
  const up = await Promise.all(store.hosts.map(h => isAwake(h.ip)));
  process.stdout.write(JSON.stringify(Object.fromEntries(store.hosts.map((h, i) => [h.ip, up[i]]))));
  process.exit(0);
}

// Every page load and every POST copies what the ARP table knows right now,
// before anything here gets a chance to make Windows forget it (see header).
const live = arpTable(nets);
const seen = loadSeen();
rememberSeen(seen, live);

if (METHOD !== 'POST') {
  out(QUERY.has('edit') ? editBody(ctx) : mainBody(ctx));
}

let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { /* no body, treat as empty */ }
// A BOM from a PowerShell caller would stick to the first field name.
const form = new URLSearchParams(raw.replace(/^\uFEFF/, '').trim());
const op = form.get('op') || 'wake';

// Every change to the list goes through here. Returns '' once it is on disk,
// or a paragraph starting with `failed` saying why not -- and then the list in
// memory is left as it was, so the page never shows an entry the file lacks.
function change(mutate, failed) {
  if (store.error) return '<p class="warn">' + failed + '：清單讀不懂，見下面。</p>';
  const before = store.hosts.map(h => ({ ...h }));
  mutate(store.hosts);
  try {
    saveStore(store.hosts);
    return '';
  } catch (e) {
    store.hosts = before;
    return '<p class="warn">' + failed + '：' + esc(e.message) + '</p>';
  }
}

// ---------------------------------------------------------------- delete

if (op === 'del') {
  const want = String(form.get('ip') || '');
  const gone = store.hosts.find(h => h.ip === want);
  if (!gone && !store.error) out(editBody(ctx, '<p class="warn">清單裡沒有 ' + esc(want) + '。</p>'));
  const err = change(hosts => hosts.splice(hosts.indexOf(gone), 1), '沒有刪掉');
  if (err) out(editBody(ctx, err));
  out(editBody(ctx,
    '<div class="box"><p class="ok">刪掉了 ' + esc(gone.ip) + '（<span class="mono">' + esc(gone.mac) +
    '</span>）。</p>' +
    postForm({ op: 'keep', ip: gone.ip, mac: gone.mac }, '<button class="alt">刪錯了，復原</button>') +
    '</div>'));
}

// ---------------------------------------------------------------- undo a delete

if (op === 'keep') {
  const t = resolveTarget(form.get('ip'), nets, primary);
  const mac = normMac(form.get('mac'));
  if (t.error || !mac) out(editBody(ctx, '<p class="bad">沒有復原：' + esc(t.error || 'MAC 看不懂。') + '</p>'));
  const err = change(hosts => {
    if (!hosts.some(h => h.ip === t.ip)) hosts.push({ ip: t.ip, mac });
  }, '沒有復原');
  out(editBody(ctx, err || '<p class="ok">復原了 ' + esc(t.ip) + '。</p>'));
}

// ---------------------------------------------------------------- wake

if (op !== 'wake') out(mainBody(ctx, '<p class="bad">不認得的操作：' + esc(op) + '</p>'));

const typed = form.get('ip');
const t = resolveTarget(typed, nets, primary);
if (t.error) out(mainBody(ctx, '<p class="bad">' + esc(t.error) + '</p>', typed));

const host = store.hosts.find(h => h.ip === t.ip);
let mac = null;
let how = null;                                       // how a new MAC was learned
if (form.has('mac')) {
  mac = normMac(form.get('mac'));
  if (!mac) {
    out(mainBody(ctx, macForm(t.ip, form.get('mac'),
      '<p class="bad">「' + esc(form.get('mac')) + '」不是一個 MAC。</p>')));
  }
  how = 'typed';
} else if (host) {
  mac = host.mac;
} else {
  const found = findMac(t.ip, nets, live, seen);
  if (!found) out(mainBody(ctx, macForm(t.ip)));
  ({ mac, how } = found);
}

let failure = null;
try {
  await sendMagic(mac, t.net);
} catch (e) {
  failure = e.message;
}

const KEPT = '記下來了：之後它關機也叫得醒，下面按一下就好。';
const LEARNED = {
  arp: 'MAC 是從這台機器的 ARP 表查到的，' + KEPT,
  seen: 'MAC 是這台之前在區網上看到它時留下的紀錄，按鈕加回來了，下面按一下就好。',
  probe: 'MAC 是剛剛問它本人問到的，' + KEPT,
  typed: 'MAC ' + KEPT,
};
const learned = !how ? '' : change(hosts => {
  const h = hosts.find(x => x.ip === t.ip);
  if (h) h.mac = mac;
  else hosts.push({ ip: t.ip, mac });
}, '但是沒有記下來') || '<p class="note">' + LEARNED[how] + '</p>';

// The "waiting" line is turned into "有回應了" by STATUS_JS, which only hears
// about machines on the list.
const listed = store.hosts.some(h => h.ip === t.ip);
out(mainBody(ctx, failure
  ? '<p class="bad">魔術封包送不出去：' + esc(failure) + '</p>' + learned
  : '<p class="ok">送出了：叫醒 ' + esc(t.ip) + '（<span class="mono">' + esc(mac) + '</span>）。</p>' +
    (listed
      ? '<p class="note" id="waiting" data-ip="' + esc(t.ip) + '">開機通常要幾十秒；它一有回應，' +
        '這一行和下面的按鈕都會變成綠色。</p>'
      : '<p class="note">封包送出去不會有回音 —— 醒了沒有，要等它開完機自己看。</p>') +
    learned));
