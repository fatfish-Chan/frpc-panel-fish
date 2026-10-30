// 内置后端：规则读写、生成 frpc 配置、重启 frpc
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const isWin = process.platform === 'win32';
const EXE = isWin ? 'frpc.exe' : 'frpc';

// 打包后 frp/ 跟 exe 放一起；开发时跟 main.js 放一起
const BASE = process.env.FRPC_PANEL_BASE ||
  process.env.PORTABLE_EXECUTABLE_DIR ||        // electron-builder portable：exe 所在目录
  (process.resourcesPath && !process.env.ELECTRON_DEV
    ? path.dirname(process.execPath)
    : __dirname);
const FRP_DIR = process.env.FRPC_DIR || path.join(BASE, 'frp');
const DATA = path.join(process.env.FRPC_PANEL_DATA || BASE, 'data');
const RULES = path.join(DATA, 'rules.json');
const SETTINGS = path.join(DATA, 'settings.json');

function ensureDirs() {
  fs.mkdirSync(DATA, { recursive: true });
}
function readJson(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return def; }
}
function writeJson(p, v) {
  ensureDirs();
  fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
}

function detect() {
  const hit = {};
  for (const n of EXE === 'frpc' ? ['frpc', 'frpc.exe'] : ['frpc.exe', 'frpc']) {
    const p = path.join(FRP_DIR, n);
    if (fs.existsSync(p)) { hit.frpc_path = p; break; }
  }
  for (const [n, fmt] of [['frpc.toml', 'toml'], ['frpc.ini', 'ini']]) {
    const p = path.join(FRP_DIR, n);
    if (fs.existsSync(p)) { hit.config_path = p; hit.format = fmt; break; }
  }
  return hit;
}

const DEFAULTS = () => ({
  frpc_path: path.join(FRP_DIR, EXE),
  config_path: path.join(FRP_DIR, 'frpc.toml'),
  format: 'toml',
  server_addr: '',
  server_port: 7000,
  token: '',
  log_file: path.join(FRP_DIR, 'frpc.log'),
});

function getSettings() {
  const s = Object.assign(DEFAULTS(), detect());
  const saved = readJson(SETTINGS, {});
  for (const k of Object.keys(saved)) {
    if (saved[k] !== '' && saved[k] !== null && saved[k] !== undefined) s[k] = saved[k];
  }
  return s;
}
const getRules = () => readJson(RULES, []);

// ---------- 解析现有配置 ----------
function parseToml(text) {
  const st = { server_addr: '', server_port: 7000, token: '' };
  const rules = [];
  let cur = null;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[[proxies]]') || line.startsWith('[[proxies.')) {
      cur = { name: '', type: 'tcp', local_ip: '127.0.0.1', local_port: 0, remote_port: 0, comment: '', enabled: true };
      rules.push(cur);
      continue;
    }
    if (line.startsWith('[')) { if (!line.startsWith('[[proxies')) cur = null; continue; }
    const m = line.match(/^([\w.]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (cur) {
      if (key === 'name') cur.name = val;
      else if (key === 'type') cur.type = val;
      else if (key === 'localIP' || key === 'localIp') cur.local_ip = val;
      else if (key === 'localPort') cur.local_port = parseInt(val, 10) || 0;
      else if (key === 'remotePort') cur.remote_port = parseInt(val, 10) || 0;
      else if (key === 'comment') cur.comment = val;
    } else {
      if (key === 'serverAddr') st.server_addr = val;
      else if (key === 'serverPort') st.server_port = parseInt(val, 10) || 7000;
      else if (key === 'auth.token') st.token = val;
    }
  }
  return { st, rules };
}

function parseIni(text) {
  const st = { server_addr: '', server_port: 7000, token: '' };
  const rules = [];
  let sec = null;
  let cur = null;
  for (let raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sm = line.match(/^\[(.+)\]$/);
    if (sm) {
      sec = sm[1];
      if (sec === 'common') { cur = null; }
      else {
        cur = { name: sec, type: 'tcp', local_ip: '127.0.0.1', local_port: 0, remote_port: 0, comment: '', enabled: true };
        rules.push(cur);
      }
      continue;
    }
    const m = line.match(/^([\w.]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (sec === 'common') {
      if (key === 'server_addr') st.server_addr = val;
      else if (key === 'server_port') st.server_port = parseInt(val, 10) || 7000;
      else if (key === 'token') st.token = val;
    } else if (cur) {
      if (key === 'type') cur.type = val;
      else if (key === 'local_ip') cur.local_ip = val;
      else if (key === 'local_port') cur.local_port = parseInt(val, 10) || 0;
      else if (key === 'remote_port') cur.remote_port = parseInt(val, 10) || 0;
      else if (key === 'comment') cur.comment = val;
    }
  }
  return { st, rules };
}

function parseConfig(file, fmt) {
  if (!fs.existsSync(file)) throw new Error('找不到配置文件：' + file);
  const text = fs.readFileSync(file, 'utf8');
  const f = fmt || (file.toLowerCase().endsWith('.ini') ? 'ini' : 'toml');
  return f === 'ini' ? parseIni(text) : parseToml(text);
}

// ---------- 生成配置 ----------
function tomlStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
function renderConfig(s, rules, mask) {
  const live = rules.filter(r => r.enabled !== false);
  const token = mask && s.token ? maskToken(s.token) : s.token;
  if ((s.format || 'toml') === 'ini') {
    let out = '[common]\nserver_addr = ' + (s.server_addr || '') + '\nserver_port = ' + (s.server_port || 7000) + '\n';
    if (token) out += 'token = ' + token + '\n';
    if (s.log_file) out += 'log_file = ' + s.log_file + '\nlog_level = info\n';
    for (const r of live) {
      out += '\n[' + r.name + ']\ntype = ' + (r.type || 'tcp') + '\nlocal_ip = ' + (r.local_ip || '127.0.0.1') +
        '\nlocal_port = ' + r.local_port + '\nremote_port = ' + r.remote_port + '\n';
      if (r.comment) out += 'comment = ' + r.comment + '\n';
    }
    return out;
  }
  let out = 'serverAddr = ' + tomlStr(s.server_addr || '') + '\nserverPort = ' + (s.server_port || 7000) + '\n';
  if (token) out += 'auth.method = "token"\nauth.token = ' + tomlStr(token) + '\n';
  if (s.log_file) out += 'log.to = ' + tomlStr(s.log_file) + '\nlog.level = "info"\n';
  for (const r of live) {
    out += '\n[[proxies]]\nname = ' + tomlStr(r.name) + '\ntype = ' + tomlStr(r.type || 'tcp') +
      '\nlocalIP = ' + tomlStr(r.local_ip || '127.0.0.1') + '\nlocalPort = ' + r.local_port +
      '\nremotePort = ' + r.remote_port + '\n';
    if (r.comment) out += 'comment = ' + tomlStr(r.comment) + '\n';
  }
  return out;
}
function maskToken(t) {
  t = String(t || '');
  if (t.length <= 6) return '*'.repeat(t.length);
  return t.slice(0, 3) + '*'.repeat(t.length - 6) + t.slice(-3);
}

// ---------- 进程 ----------
function frpcRunning() {
  return new Promise(resolve => {
    if (isWin) {
      execFile('tasklist', ['/FI', 'IMAGENAME eq frpc.exe'], (e, out) => {
        resolve(!e && /frpc\.exe/i.test(out || ''));
      });
    } else {
      execFile('pgrep', ['-x', 'frpc'], (e, out) => resolve(!e && !!out.trim()));
    }
  });
}

function killFrpc() {
  return new Promise(resolve => {
    if (isWin) execFile('taskkill', ['/IM', 'frpc.exe', '/F'], () => resolve());
    else execFile('pkill', ['-x', 'frpc'], () => resolve());
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function restartFrpc(s) {
  const exe = s.frpc_path;
  if (!fs.existsSync(exe)) return { ok: false, message: '找不到 frpc 程序：' + exe };
  await killFrpc();
  await sleep(800);
  try {
    const child = spawn(exe, ['-c', s.config_path], {
      cwd: path.dirname(exe),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return { ok: false, message: '启动失败：' + e.message };
  }
  await sleep(1500);
  const up = await frpcRunning();
  return up ? { ok: true, message: 'frpc 已重载' } : { ok: false, message: '配置写好了，但 frpc 没起来，看看日志' };
}

// 开机就把 frpc 拉起来：已经在跑就不动，没跑就按当前配置启一个
async function ensureFrpcRunning() {
  const s = getSettings();
  if (!s.frpc_path || !fs.existsSync(s.frpc_path)) return { ok: false, message: '找不到 frpc 程序：' + s.frpc_path };
  if (await frpcRunning()) return { ok: true, message: 'frpc 本来就在跑' };
  if (!fs.existsSync(s.config_path)) return { ok: false, message: '还没有配置文件：' + s.config_path };
  try {
    const child = spawn(s.frpc_path, ['-c', s.config_path], {
      cwd: path.dirname(s.frpc_path), detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch (e) {
    return { ok: false, message: '启动失败：' + e.message };
  }
  await sleep(1200);
  const up = await frpcRunning();
  return { ok: up, message: up ? 'frpc 已自动启动' : 'frpc 没起来，看看日志' };
}

function backup(file) {
  try {
    if (!fs.existsSync(file)) return;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    fs.copyFileSync(file, file + '.bak_' + stamp);
  } catch (e) { /* ignore */ }
}

function applyConfig() {
  const s = getSettings();
  const rules = getRules();
  fs.mkdirSync(path.dirname(s.config_path) || '.', { recursive: true });
  backup(s.config_path);
  const text = renderConfig(s, rules, false);
  fs.writeFileSync(s.config_path, text, 'utf8');
  return restartFrpc(s).then(r => Object.assign({ config: text }, r));
}

// ---------- HTTP ----------
function send(res, code, body, ctype) {
  let raw;
  if (Buffer.isBuffer(body)) raw = body;
  else if (typeof body === 'string') raw = Buffer.from(body, 'utf8');
  else raw = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': ctype || 'application/json; charset=utf-8',
    'Content-Length': raw.length,
    'Cache-Control': 'no-store',
  });
  res.end(raw);
}

function staticFile(res, rel) {
  const root = path.join(__dirname, 'renderer');
  const fp = path.normalize(path.join(root, rel));
  if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) return false;
  const ext = path.extname(fp).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  send(res, 200, fs.readFileSync(fp), types[ext] || 'application/octet-stream');
  return true;
}

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { if (d.length < 1e6) d += c; });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({}); }
    });
  });
}

function normalizeRule(b, enabledDefault) {
  return {
    name: String(b.name || '').trim(),
    type: (b.type || 'tcp').trim(),
    local_ip: (b.local_ip || '127.0.0.1').trim(),
    local_port: parseInt(b.local_port, 10) || 0,
    remote_port: parseInt(b.remote_port, 10) || 0,
    comment: (b.comment || '').trim(),
    enabled: b.enabled === undefined ? enabledDefault : !!b.enabled,
  };
}

function createServer() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = decodeURIComponent(u.pathname);

    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') return staticFile(res, 'index.html');
      if (p.startsWith('/img/') || p.startsWith('/static/')) {
        const rel = p.startsWith('/static/') ? p.slice(8) : p.slice(1);
        if (staticFile(res, rel)) return;
        return send(res, 404, { error: 'not found' });
      }
      if (p === '/api/state') {
        const s = getSettings();
        let rules = getRules();
        if (!rules.length) {
          try {
            const { st, rules: pr } = parseConfig(s.config_path, s.format);
            for (const k of Object.keys(st)) if (st[k] && !s[k]) s[k] = st[k];
            rules = pr;
            writeJson(RULES, rules);
            writeJson(SETTINGS, s);
          } catch (e) { /* 没配置就先空着 */ }
        }
        return send(res, 200, {
          settings: s,
          rules,
          frpc_running: await frpcRunning(),
          preview: renderConfig(s, rules, true),
        });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST') {
      if (p === '/api/rules') {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: 'name 必填' });
        const rules = getRules();
        const rule = normalizeRule(b, true);
        const i = rules.findIndex(r => r.name === rule.name);
        if (i >= 0) rules[i] = rule; else rules.push(rule);
        writeJson(RULES, rules);
        const r = await applyConfig();
        return send(res, 200, { ok: true, rules, reloaded: r.ok, message: r.message });
      }
      if (p === '/api/settings') {
        const b = await readBody(req);
        const s = getSettings();
        for (const k of ['frpc_path', 'config_path', 'format', 'server_addr', 'server_port', 'token', 'log_file']) {
          if (k in b) s[k] = b[k];
        }
        s.server_port = parseInt(s.server_port, 10) || 7000;
        writeJson(SETTINGS, s);
        const r = await applyConfig();
        return send(res, 200, { ok: true, settings: s, reloaded: r.ok, message: r.message });
      }
      if (p === '/api/import') {
        const s = getSettings();
        try {
          const { st, rules } = parseConfig(s.config_path, s.format);
          for (const k of Object.keys(st)) if (st[k]) s[k] = st[k];
          writeJson(SETTINGS, s);
          writeJson(RULES, rules);
          return send(res, 200, { ok: true, rules, settings: s });
        } catch (e) {
          return send(res, 400, { error: '读配置失败：' + e.message });
        }
      }
      if (p === '/api/apply') {
        const r = await applyConfig();
        return send(res, 200, r);
      }
      const mt = p.match(/^\/api\/rules\/(.+)\/toggle$/);
      if (mt) {
        const name = mt[1];
        const rules = getRules();
        const r0 = rules.find(x => x.name === name);
        if (!r0) return send(res, 404, { error: '没有这条规则' });
        r0.enabled = r0.enabled === false;
        writeJson(RULES, rules);
        const r = await applyConfig();
        return send(res, 200, { ok: true, rules, reloaded: r.ok, message: r.message });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'DELETE') {
      const m = p.match(/^\/api\/rules\/(.+)$/);
      if (!m) return send(res, 404, { error: 'not found' });
      const rules = getRules().filter(r => r.name !== m[1]);
      writeJson(RULES, rules);
      const r = await applyConfig();
      return send(res, 200, { ok: true, rules, reloaded: r.ok, message: r.message });
    }

    send(res, 404, { error: 'not found' });
  });
}

function start(port = 8899) {
  ensureDirs();
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

module.exports = { start, getSettings, getRules, parseConfig, renderConfig, frpcRunning, ensureFrpcRunning, FRP_DIR, DATA };
