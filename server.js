'use strict';
// RFID attendance test system: card registration + time in / time out.
//   Reader 1 -> Time In  -> Relay channel 1
//   Reader 2 -> Time Out -> Relay channel 2
// The server stores data (SQLite), drives the Ethernet relay, and runs a Windows helper
// that tells two USB keyboard-type readers apart.
// Zero npm dependencies: needs Node.js 22.13 or newer (built-in node:sqlite).

const http = require('node:http');
const net = require('node:net');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  console.error(`This app needs Node.js 22.13 or newer (you have ${process.version}). Install the LTS from https://nodejs.org`);
  process.exit(1);
}

// ---------- env (.env is gitignored; see .env.example) ----------
loadDotEnv(path.join(__dirname, '.env'));

const PORT = intEnv('PORT', 8080, 1, 65535);
const BIND = process.env.BIND_ADDRESS || '127.0.0.1';
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || crypto.randomBytes(24).toString('base64url');
const RELAY_HTTP_USER = process.env.RELAY_HTTP_USER || '';
const RELAY_HTTP_PASS = process.env.RELAY_HTTP_PASS || '';
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

if (ACCESS_TOKEN.length < 16) {
  console.error('ACCESS_TOKEN must be at least 16 characters.');
  process.exit(1);
}
if (BIND !== '127.0.0.1' && BIND !== 'localhost' && BIND !== '::1' && !process.env.ALLOWED_HOSTS) {
  console.error('Binding to a non-loopback address requires ALLOWED_HOSTS (e.g. 192.168.1.50:8080).');
  process.exit(1);
}

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // .env is optional
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function intEnv(name, def, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer between ${min} and ${max}.`);
    process.exit(1);
  }
  return n;
}

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- live events to the browser (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
}

// =====================================================================
// Database
// =====================================================================
// data/ holds names and attendance (personal data). It is gitignored.
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(DATA_DIR, 'attendance.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS cards (
    id         INTEGER PRIMARY KEY,
    uid        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id         INTEGER PRIMARY KEY,
    card_id    INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    time_in    TEXT NOT NULL,
    time_out   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attendance_card_time ON attendance(card_id, time_in);
  CREATE INDEX IF NOT EXISTS idx_attendance_time_in ON attendance(time_in);
`);

// All SQL is prepared once with bound parameters: no string-built queries.
const sql = {
  listCards: db.prepare('SELECT id, uid, name, created_at FROM cards ORDER BY created_at DESC LIMIT 2000'),
  cardByUid: db.prepare('SELECT id, uid, name FROM cards WHERE uid = ?'),
  insertCard: db.prepare('INSERT INTO cards (uid, name, created_at) VALUES (?, ?, ?)'),
  deleteCard: db.prepare('DELETE FROM cards WHERE id = ?'),
  openSession: db.prepare(
    'SELECT id, time_in FROM attendance WHERE card_id = ? AND time_out IS NULL AND time_in >= ? ORDER BY time_in DESC LIMIT 1'
  ),
  timeIn: db.prepare('INSERT INTO attendance (card_id, time_in) VALUES (?, ?)'),
  timeOut: db.prepare('UPDATE attendance SET time_out = ? WHERE id = ?'),
  // One JOIN for the whole list, not one query per row.
  today: db.prepare(`
    SELECT a.id, c.uid, c.name, a.time_in, a.time_out
    FROM attendance a JOIN cards c ON c.id = a.card_id
    WHERE a.time_in >= ?
    ORDER BY a.time_in DESC
    LIMIT 500`),
};

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0); // server's local midnight; server and browser run on the same PC
  return d.toISOString();
}

function parseUid(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Card number is required');
  const uid = value.replace(/[\s:\-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{4,32}$/.test(uid)) throw new HttpError(400, 'Card number must be 4-32 letters or digits');
  return uid;
}

function parseName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'Name is required');
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 80) throw new HttpError(400, 'Name must be 1-80 characters');
  return name;
}

// =====================================================================
// Ethernet relay
// =====================================================================
const CONFIG_PATH = path.join(__dirname, 'relay.config.json');
const relay = loadRelayConfig(CONFIG_PATH);

function loadRelayConfig(file) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`Could not read ${path.basename(file)}: ${err.message}`);
    process.exit(1);
  }
  const preset = cfg.presets && cfg.presets[cfg.preset];
  if (!preset) {
    console.error(`relay.config.json: preset "${cfg.preset}" not found in "presets".`);
    process.exit(1);
  }
  const r = { ...preset, host: cfg.host, port: cfg.port ?? preset.port, preset: cfg.preset };
  r.timeoutMs = r.timeoutMs ?? 3000;
  r.replyWaitMs = r.replyWaitMs ?? 300;
  r.pulseMs = cfg.pulseMs ?? r.pulseMs ?? 1000;
  r.serialPort = String(cfg.serialPort ?? 'auto');
  r.baud = cfg.baud ?? r.baud ?? 9600;

  const problems = [];
  if (!['tcp', 'udp', 'http', 'serial'].includes(r.transport)) problems.push('transport must be tcp, udp, http or serial');
  if (r.transport === 'serial') {
    if (!/^(auto|COM\d{1,3})$/i.test(r.serialPort)) problems.push('serialPort must be "auto" or like "COM3"');
    if (![1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].includes(r.baud)) problems.push('baud must be a standard rate, e.g. 9600');
    if (r.encoding !== 'hex') problems.push('serial presets must use hex encoding');
  } else {
    if (typeof r.host !== 'string' || !/^[a-z0-9.\-:]+$/i.test(r.host)) problems.push('host must be an IP or hostname');
    if (!Number.isInteger(r.port) || r.port < 1 || r.port > 65535) problems.push('port must be 1-65535');
  }
  if (r.transport !== 'http' && !['ascii', 'hex'].includes(r.encoding)) problems.push('encoding must be ascii or hex');
  if (!Number.isInteger(r.pulseMs) || r.pulseMs < 100 || r.pulseMs > 10_000) problems.push('pulseMs must be 100-10000');
  if (!r.commands || typeof r.commands.on !== 'string' || typeof r.commands.off !== 'string') {
    problems.push('commands.on and commands.off are required');
  }
  if (problems.length) {
    console.error('relay.config.json problems:\n - ' + problems.join('\n - '));
    process.exit(1);
  }
  return r;
}

// Template tokens: {ch} channel, {ch0} zero-based channel, {chx} channel as hex byte,
// {sum} (hex only) = low byte of the sum of the preceding bytes.
function renderCommand(template, ch) {
  return template
    .replaceAll('{ch}', String(ch))
    .replaceAll('{ch0}', String(ch - 1))
    .replaceAll('{chx}', ch.toString(16).padStart(2, '0').toUpperCase());
}

function encodePayload(text, encoding) {
  if (encoding === 'ascii') {
    return Buffer.from(text.replace(/\\r/g, '\r').replace(/\\n/g, '\n'), 'latin1');
  }
  const bytes = [];
  for (const p of text.trim().split(/[\s,]+/).filter(Boolean)) {
    if (p === '{sum}') {
      bytes.push(bytes.reduce((a, b) => a + b, 0) & 0xff);
      continue;
    }
    const hex = p.replace(/^0x/i, '');
    if (!/^[0-9a-f]{1,2}$/i.test(hex)) throw new Error(`Invalid hex byte "${p}" in relay.config.json`);
    bytes.push(parseInt(hex, 16));
  }
  return Buffer.from(bytes);
}

function friendlyNetError(err) {
  const map = {
    ECONNREFUSED: 'Connection refused: wrong port, or the relay is busy with another app',
    EHOSTUNREACH: 'Relay unreachable: check the IP and that the PC adapter is on the same subnet',
    ENETUNREACH: 'Network unreachable: check the USB Ethernet adapter settings',
    ETIMEDOUT: 'Timed out talking to the relay',
    ECONNRESET: 'The relay closed the connection',
    ENOTFOUND: 'Relay hostname could not be resolved',
  };
  return map[err.code] || err.message || 'Unknown network error';
}

function sendTcp(payload) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    let idleTimer = null;
    const socket = net.createConnection({ host: relay.host, port: relay.port });
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      socket.destroy();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const hardTimer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), relay.timeoutMs);
    socket.once('connect', () => {
      socket.write(payload, (err) => {
        if (err) return finish(err);
        idleTimer = setTimeout(() => finish(), relay.replyWaitMs); // many boards never reply
      });
    });
    socket.on('data', (d) => {
      chunks.push(d);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(), 100);
    });
    socket.once('error', finish);
    socket.once('close', () => finish());
  });
}

function sendUdp(payload) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(relay.host) ? 'udp6' : 'udp4');
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(), relay.replyWaitMs);
    sock.once('error', finish);
    sock.send(payload, relay.port, relay.host, (err) => {
      if (err) finish(err);
    });
  });
}

async function sendHttp(pathAndQuery) {
  // Host is fixed by config; only the path comes from the template.
  const base = `http://${relay.host}:${relay.port}`;
  const url = new URL(pathAndQuery, base);
  if (url.host !== new URL(base).host) throw new Error('HTTP command tried to change the relay host');
  const headers = {};
  if (RELAY_HTTP_USER) {
    headers.Authorization = 'Basic ' + Buffer.from(`${RELAY_HTTP_USER}:${RELAY_HTTP_PASS}`).toString('base64');
  }
  let res;
  try {
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(relay.timeoutMs) });
  } catch (err) {
    const cause = err.cause || err;
    if (err.name === 'TimeoutError') cause.code = 'ETIMEDOUT';
    throw cause;
  }
  await res.arrayBuffer();
  if (!res.ok) throw new Error(`Relay answered HTTP ${res.status}${res.status === 401 ? ' (set RELAY_HTTP_USER/PASS in .env)' : ''}`);
}

// Cheap boards often accept only one TCP client at a time, so every relay command is queued.
let relayQueue = Promise.resolve();
function queued(fn) {
  const run = relayQueue.then(fn, fn);
  relayQueue = run.catch(() => {});
  return run;
}

// ---------- USB (COM port) relays via relay-serial.ps1 ----------
const serialHelper = { child: null, ready: null, port: null, pending: new Map(), nextId: 1, lastError: '' };

function startSerialHelper() {
  if (process.platform !== 'win32') return Promise.reject(new Error('USB relays need Windows (COM port)'));
  if (serialHelper.ready) return serialHelper.ready;
  serialHelper.ready = new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'relay-serial.ps1'),
        '-Port', relay.serialPort, '-Baud', String(relay.baud)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    serialHelper.child = child;
    let buf = '';
    let stderr = '';
    let started = false;
    const startTimer = setTimeout(() => {
      if (!started) child.kill();
    }, 15_000);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      if (buf.length > 65536) buf = '';
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const [kind, a, b] = buf.slice(0, i).replace(/\r$/, '').split('\t');
        buf = buf.slice(i + 1);
        if (kind === 'READY') {
          started = true;
          clearTimeout(startTimer);
          serialHelper.port = a;
          serialHelper.lastError = '';
          console.log(`USB relay opened on ${a}`);
          resolve();
        } else if (kind === 'ERROR') {
          serialHelper.lastError = a;
        } else if (kind === 'OK' || kind === 'FAIL') {
          const p = serialHelper.pending.get(a);
          if (!p) continue;
          serialHelper.pending.delete(a);
          clearTimeout(p.timer);
          if (kind === 'OK') p.resolve();
          else p.reject(new Error(`USB relay write failed: ${b}`));
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) => {
      serialHelper.lastError = `Could not start PowerShell: ${err.message}`;
    });
    child.on('exit', () => {
      clearTimeout(startTimer);
      const why = serialHelper.lastError || stderr.trim().split('\n').pop() || 'USB relay helper stopped';
      serialHelper.child = null;
      serialHelper.ready = null; // next command starts it again (e.g. after re-plugging)
      serialHelper.port = null;
      for (const p of serialHelper.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(why));
      }
      serialHelper.pending.clear();
      if (!started) reject(new Error(why));
    });
  });
  return serialHelper.ready;
}

async function sendSerial(payload) {
  await startSerialHelper();
  const id = String(serialHelper.nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      serialHelper.pending.delete(id);
      reject(new Error('USB relay did not answer in time'));
    }, relay.timeoutMs);
    serialHelper.pending.set(id, { resolve, reject, timer });
    serialHelper.child.stdin.write(`${id}\t${payload.toString('hex').replace(/(..)(?!$)/g, '$1 ')}\n`);
  });
}

// Lists COM ports with their Windows names, e.g. "USB-SERIAL CH340 (COM3)". Fixed script, no user input.
function listComPorts() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new HttpError(400, 'Listing COM ports needs Windows'));
    const script =
      "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | ForEach-Object { $_.Name }";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out = (out + d).slice(0, 20_000)));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('error', (err) => reject(new HttpError(500, err.message)));
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

async function relayCommand(ch, on) {
  const text = renderCommand(on ? relay.commands.on : relay.commands.off, ch);
  if (relay.transport === 'serial') return sendSerial(encodePayload(text, 'hex'));
  try {
    if (relay.transport === 'http') await sendHttp(text);
    else if (relay.transport === 'tcp') await sendTcp(encodePayload(text, relay.encoding));
    else await sendUdp(encodePayload(text, relay.encoding));
  } catch (err) {
    throw new Error(friendlyNetError(err));
  }
}

function relayTarget() {
  if (relay.transport === 'serial') {
    return `USB ${serialHelper.port || (relay.serialPort === 'auto' ? 'COM port (auto)' : relay.serialPort)} @ ${relay.baud} baud`;
  }
  return `${relay.transport}://${relay.host}:${relay.port}`;
}

const relayState = { 1: { state: 'unknown' }, 2: { state: 'unknown' } };
const pulseTimers = {};

function setRelayState(ch, state, error) {
  relayState[ch] = { state, at: new Date().toISOString(), ...(error ? { error } : {}) };
  broadcast({ type: 'relay', channel: ch, ...relayState[ch] });
}

// Switches the channel on, then off after pulseMs. Resolves once "on" succeeded (or failed).
async function pulseRelay(ch) {
  try {
    await queued(() => relayCommand(ch, true));
  } catch (err) {
    setRelayState(ch, 'error', err.message);
    return { ok: false, error: err.message };
  }
  setRelayState(ch, 'on');
  clearTimeout(pulseTimers[ch]);
  pulseTimers[ch] = setTimeout(async () => {
    try {
      await queued(() => relayCommand(ch, false));
      setRelayState(ch, 'off');
    } catch (err) {
      // The relay may be left ON: make that loud in the UI.
      setRelayState(ch, 'error', `Could not switch OFF: ${err.message}`);
    }
  }, relay.pulseMs);
  return { ok: true };
}

// Diagnostic for "connection refused": which common ports are open on the configured relay IP?
const COMMON_PORTS = [23, 80, 502, 1234, 4196, 5000, 6000, 6722, 8080, 8899, 9000, 10000, 10001, 20108, 30000];
function probePort(port) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: relay.host, port });
    const done = (open) => {
      s.destroy();
      resolve(open);
    };
    s.setTimeout(800, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
let probing = false;

// =====================================================================
// Readers: Windows helper that tells keyboard-type readers apart
// =====================================================================
const READERS_PATH = path.join(DATA_DIR, 'readers.json');
let readerMap = loadReaderMap(); // { "1": devicePath, "2": devicePath }
const helper = { state: 'starting', message: '', restarts: 0 };
let assignMode = null; // { reader, until }

function loadReaderMap() {
  try {
    const m = JSON.parse(fs.readFileSync(READERS_PATH, 'utf8'));
    const out = {};
    for (const k of ['1', '2']) if (typeof m[k] === 'string' && m[k].length <= 512) out[k] = m[k];
    return out;
  } catch {
    return {};
  }
}

function saveReaderMap() {
  fs.writeFileSync(READERS_PATH, JSON.stringify(readerMap, null, 2), { mode: 0o600 });
}

// Short, human-readable label so two identical readers can still be told apart.
function deviceLabel(devicePath) {
  if (!devicePath) return null;
  const m = devicePath.match(/VID_([0-9A-F]{4}).*?PID_([0-9A-F]{4})/i);
  const tag = crypto.createHash('sha256').update(devicePath).digest('hex').slice(0, 6);
  return m ? `VID ${m[1].toUpperCase()} · PID ${m[2].toUpperCase()} · #${tag}` : `Device #${tag}`;
}

function readerForDevice(devicePath) {
  if (readerMap['1'] === devicePath) return 1;
  if (readerMap['2'] === devicePath) return 2;
  return null;
}

function setHelper(state, message = '') {
  helper.state = state;
  helper.message = message;
  broadcast({ type: 'helper', state, message });
}

function handleHelperLine(line) {
  if (line === 'READY') {
    helper.restarts = 0;
    return setHelper('running');
  }
  if (line.startsWith('ERROR\t')) return console.error('Reader helper:', line.slice(6));
  const parts = line.split('\t');
  if (parts[0] !== 'SCAN' || parts.length !== 3) return;
  const devicePath = parts[1].slice(0, 512);
  let uid;
  try {
    uid = parseUid(parts[2]);
  } catch {
    return;
  }

  if (assignMode && Date.now() < assignMode.until) {
    const n = String(assignMode.reader);
    const other = n === '1' ? '2' : '1';
    if (readerMap[other] === devicePath) delete readerMap[other]; // one reader can't be both
    readerMap[n] = devicePath;
    saveReaderMap();
    assignMode = null;
    broadcast({ type: 'assigned', reader: Number(n), label: deviceLabel(devicePath), readers: readersStatus() });
    return;
  }
  // Card numbers go only to logged-in pages on this PC, never into server logs.
  broadcast({ type: 'scan', source: 'keyboard', reader: readerForDevice(devicePath), uid, device: deviceLabel(devicePath) });
}

function startHelper() {
  if (process.platform !== 'win32') {
    return setHelper('unavailable', 'Telling two keyboard readers apart needs Windows. Serial readers still work.');
  }
  const script = path.join(__dirname, 'reader-helper.ps1');
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    if (buf.length > 65536) buf = '';
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) handleHelperLine(line);
    }
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.on('error', (err) => setHelper('error', `Could not start PowerShell: ${err.message}`));
  child.on('exit', (code) => {
    helper.restarts += 1;
    const why = stderr.trim().split('\n').pop() || `exit code ${code}`;
    console.error(`Reader helper stopped (${why}).`);
    if (helper.restarts > 5) return setHelper('error', `Reader helper keeps failing: ${why}`);
    setHelper('starting', `Restarting reader helper (${why})`);
    setTimeout(startHelper, 2000 * helper.restarts);
  });
  process.on('exit', () => child.kill());
}

function readersStatus() {
  return {
    1: { device: deviceLabel(readerMap['1']) },
    2: { device: deviceLabel(readerMap['2']) },
  };
}

// =====================================================================
// Rate limiting & HTTP plumbing
// =====================================================================
const buckets = new Map();
const RATE = { capacity: 30, refillPerSec: 5 };
function rateLimited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) {
    b = { tokens: RATE.capacity, last: now };
    buckets.set(ip, b);
  }
  b.tokens = Math.min(RATE.capacity, b.tokens + ((now - b.last) / 1000) * RATE.refillPerSec);
  b.last = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}

const authFailures = new Map();
function tooManyAuthFailures(ip) {
  const f = authFailures.get(ip);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60_000;
}
function recordAuthFailure(ip) {
  const now = Date.now();
  const f = authFailures.get(ip);
  if (!f || now - f.first > 15 * 60_000) authFailures.set(ip, { count: 1, first: now });
  else f.count += 1;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.last > 60_000) buckets.delete(ip);
  for (const [ip, f] of authFailures) if (now - f.first > 15 * 60_000) authFailures.delete(ip);
}, 60_000).unref();

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), serial=(self)',
};

// Fixed whitelist: no filesystem path ever comes from the URL.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      return reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function checkToken(req) {
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(ACCESS_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function parseReader(value) {
  if (value !== 1 && value !== 2) throw new HttpError(400, 'reader must be 1 or 2');
  return value;
}

// Same card on the same reader within a few seconds = one tap (readers and tabs can repeat).
const recentScans = new Map();

// =====================================================================
// API
// =====================================================================
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/events') {
    if (clients.size >= 10) throw new HttpError(503, 'Too many open pages');
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && p === '/api/status') {
    return send(res, 200, {
      ok: true,
      helper: { state: helper.state, message: helper.message },
      readers: readersStatus(),
      relay: {
        label: relay.label || relay.preset,
        target: relayTarget(),
        transport: relay.transport,
        pulseMs: relay.pulseMs,
        channels: relayState,
      },
    });
  }

  if (req.method === 'POST' && p === '/api/readers/assign') {
    const body = await readJson(req);
    const reader = parseReader(body.reader);
    if (helper.state !== 'running') throw new HttpError(409, 'Reader helper is not running');
    assignMode = { reader, until: Date.now() + 20_000 };
    return send(res, 200, { ok: true, reader, seconds: 20 });
  }

  if (req.method === 'POST' && p === '/api/readers/assign/cancel') {
    assignMode = null;
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/relay/test') {
    const body = await readJson(req);
    const ch = parseReader(body.channel);
    const result = await pulseRelay(ch);
    if (!result.ok) throw new HttpError(502, result.error);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/relay/find-port') {
    if (relay.transport === 'serial') {
      if (probing) throw new HttpError(429, 'Already looking, please wait');
      probing = true;
      try {
        return send(res, 200, { ok: true, comPorts: await listComPorts(), using: serialHelper.port || relay.serialPort });
      } finally {
        probing = false;
      }
    }
    if (relay.transport === 'http') throw new HttpError(400, 'Port finder is for tcp/udp relays');
    if (probing) throw new HttpError(429, 'Already scanning, please wait');
    probing = true;
    try {
      const results = await Promise.all(COMMON_PORTS.map(async (port) => ((await probePort(port)) ? port : null)));
      return send(res, 200, { ok: true, host: relay.host, open: results.filter(Boolean), tried: COMMON_PORTS });
    } finally {
      probing = false;
    }
  }

  if (req.method === 'GET' && p === '/api/cards') {
    return send(res, 200, { ok: true, cards: sql.listCards.all() });
  }

  if (req.method === 'POST' && p === '/api/cards') {
    const body = await readJson(req);
    const uid = parseUid(body.uid);
    const name = parseName(body.name);
    const existing = sql.cardByUid.get(uid);
    if (existing) throw new HttpError(409, `Card is already registered to ${existing.name}`);
    const r = sql.insertCard.run(uid, name, new Date().toISOString());
    return send(res, 201, { ok: true, card: { id: Number(r.lastInsertRowid), uid, name } });
  }

  const del = p.match(/^\/api\/cards\/(\d{1,12})$/);
  if (req.method === 'DELETE' && del) {
    const r = sql.deleteCard.run(Number(del[1]));
    if (r.changes === 0) throw new HttpError(404, 'Card not found');
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/scan') {
    const body = await readJson(req);
    const uid = parseUid(body.uid);
    const reader = parseReader(body.reader);
    const direction = reader === 1 ? 'in' : 'out';

    const key = `${reader}:${uid}`;
    const now = Date.now();
    if (now - (recentScans.get(key) || 0) < 3000) throw new HttpError(409, 'Duplicate tap ignored', { code: 'duplicate' });
    recentScans.set(key, now);
    if (recentScans.size > 500) for (const [k, t] of recentScans) if (now - t > 3000) recentScans.delete(k);

    const card = sql.cardByUid.get(uid);
    // Unregistered cards never open the relay.
    if (!card) throw new HttpError(404, 'Card not registered', { code: 'not_registered', uid, direction });

    const nowIso = new Date(now).toISOString();
    const open = sql.openSession.get(card.id, startOfTodayIso());
    let record;
    if (direction === 'in') {
      if (open) {
        throw new HttpError(409, 'Already timed in', { code: 'already_in', uid, name: card.name, direction, time_in: open.time_in });
      }
      sql.timeIn.run(card.id, nowIso);
      record = { time_in: nowIso, time_out: null };
    } else {
      if (!open) throw new HttpError(409, 'No time-in today', { code: 'no_time_in', uid, name: card.name, direction });
      sql.timeOut.run(nowIso, open.id);
      record = { time_in: open.time_in, time_out: nowIso };
    }

    // Recorded first, then the relay: a relay fault never loses the attendance record.
    const relayResult = await pulseRelay(reader);
    return send(res, 200, { ok: true, direction, uid, name: card.name, ...record, relay: relayResult });
  }

  if (req.method === 'GET' && p === '/api/attendance/today') {
    return send(res, 200, { ok: true, records: sql.today.all(startOfTodayIso()) });
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || 'unknown';
  try {
    // Blocks DNS rebinding: other websites can't reach this server through a hostname they control.
    const host = (req.headers.host || '').toLowerCase();
    if (!ALLOWED_HOSTS.has(host)) throw new HttpError(421, 'Host not allowed');
    const url = new URL(req.url, `http://${host}`);

    if (url.pathname.startsWith('/api/')) {
      if (rateLimited(ip)) {
        res.setHeader('Retry-After', '2');
        throw new HttpError(429, 'Too many requests, slow down');
      }
      if (tooManyAuthFailures(ip)) throw new HttpError(429, 'Too many failed logins, try again later');
      if (!checkToken(req)) {
        recordAuthFailure(ip);
        throw new HttpError(401, 'Missing or wrong access token');
      }
      return await handleApi(req, res, url);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    const entry = STATIC[url.pathname];
    if (!entry) throw new HttpError(404, 'Not found');
    const file = await fs.promises.readFile(path.join(__dirname, 'public', entry[0]));
    return send(res, 200, file, entry[1]);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}:`, err);
    // Never leak stack traces or SQL errors to the client.
    const body = { ok: false, error: status === 500 ? 'Internal server error' : err.message, ...(err.extra || {}) };
    if (!res.headersSent) send(res, status, body);
    else res.destroy();
  }
});

server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Set PORT in .env.` : err);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  const shownHost = BIND === '0.0.0.0' || BIND === '::' ? 'localhost' : BIND;
  console.log('RFID attendance system running.');
  console.log(`Relay: ${relay.label || relay.preset} -> ${relayTarget()}`);
  console.log(`Data:  ${DATA_DIR}`);
  console.log(`\nOpen this link in Chrome or Edge (it contains your access token, don't share it):`);
  console.log(`  http://${shownHost}:${PORT}/#token=${ACCESS_TOKEN}\n`);
  if (!process.env.ACCESS_TOKEN) console.log('(Random token generated for this run. Set ACCESS_TOKEN in .env to keep one.)');
  startHelper();
  if (relay.transport === 'serial') {
    startSerialHelper().catch((err) => {
      console.error(`USB relay: ${err.message}`);
      for (const ch of [1, 2]) setRelayState(ch, 'error', err.message);
    });
  }
});

function shutdown() {
  for (const res of clients) res.end();
  server.close();
  try { db.close(); } catch { /* already closed */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
