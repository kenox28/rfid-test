'use strict';
// All DOM writes use textContent: card numbers and names are untrusted input.

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN_KEY = 'rfidAttendanceToken';
const SETTINGS_KEY = 'rfidAttendanceSettings';

// ---------- token ----------
function readToken() {
  const m = location.hash.match(/token=([A-Za-z0-9_\-]+)/);
  if (m) {
    try { sessionStorage.setItem(TOKEN_KEY, m[1]); } catch { /* private mode */ }
    history.replaceState(null, '', location.pathname + '#register'); // don't leave the token in the address bar
    return m[1];
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
let token = readToken();

$('token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token-input').value.trim();
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
  $('token-input').value = '';
  $('token-panel').classList.add('hidden');
});

// ---------- per-browser settings (reader types only; never card data) ----------
function loadSettings() {
  const def = { r1: 'keyboard', r2: 'keyboard', baud: 9600, pulseMs: 1000, relayUsb: '' };
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (const k of ['r1', 'r2']) if (s[k] === 'keyboard' || s[k] === 'serial') def[k] = s[k];
    if (s.baud === 9600 || s.baud === 115200) def.baud = s.baud;
    if (Number.isInteger(s.pulseMs) && s.pulseMs >= 200 && s.pulseMs <= 10000) def.pulseMs = s.pulseMs;
    if (typeof s.relayUsb === 'string' && /^(\d{1,5}:\d{1,5})?$/.test(s.relayUsb)) def.relayUsb = s.relayUsb;
  } catch { /* storage unavailable */ }
  return def;
}
const settings = loadSettings();
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

// ---------- API ----------
class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new ApiError(err.name === 'TimeoutError' ? 'Server did not respond in time' : 'Cannot reach the server. Is it running?', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401) showTokenPanel();
  if (!res.ok || !data || data.ok === false) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data;
}

function showTokenPanel() {
  $('token-panel').classList.remove('hidden');
  setServerStatus('locked', 'warn');
}

function setServerStatus(text, kind) {
  $('server-status').textContent = text;
  $('server-status').className = `pill ${kind || ''}`;
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString() : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = `msg ${kind || ''}`;
}

// ---------- pages ----------
let page = 'register';
function showPage() {
  page = location.hash === '#attendance' ? 'attendance' : 'register';
  $('page-register').classList.toggle('hidden', page !== 'register');
  $('page-attendance').classList.toggle('hidden', page !== 'attendance');
  $('nav-register').classList.toggle('active', page === 'register');
  $('nav-attendance').classList.toggle('active', page === 'attendance');
  if (page === 'register') loadCards();
  else loadToday();
}
window.addEventListener('hashchange', showPage);

// ---------- live events from the server ----------
async function streamEvents() {
  for (;;) {
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 401) {
        showTokenPanel();
        await sleep(3000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { handleEvent(JSON.parse(line.slice(6))); } catch (err) { console.error('Bad event', err); }
        }
      }
    } catch { /* fall through to retry */ }
    setServerStatus('server offline', 'bad');
    await sleep(3000);
  }
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'hello':
      setServerStatus('server online', 'good');
      $('token-panel').classList.add('hidden');
      refreshStatus();
      showPage();
      break;
    case 'helper':
      helper = { state: ev.state, message: ev.message };
      renderDevices();
      break;
    case 'assigned':
      readers = ev.readers;
      assigning = null;
      clearTimeout(assignTimer);
      renderDevices();
      break;
    case 'scan':
      onScan(ev.uid, ev.reader, ev.device);
      break;
  }
}

// ---------- devices ----------
let helper = { state: 'starting', message: '' };
let readers = { 1: { device: null }, 2: { device: null } };
let assigning = null;
let assignTimer = null;
const lastSeen = {};

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    helper = s.helper;
    readers = s.readers;
    renderDevices();
  } catch (err) {
    $('helper-status').textContent = err.message;
  }
}

function renderDevices() {
  for (const n of [1, 2]) {
    const src = settings[`r${n}`];
    const btn = $(`r${n}-action`);
    const chip = $(`r${n}-conn`);
    $(`r${n}-source`).value = src;
    let ok = false;
    if (src === 'keyboard') {
      const dev = readers[n] && readers[n].device;
      btn.disabled = helper.state !== 'running';
      if (assigning === n) {
        btn.textContent = 'Cancel';
        chip.textContent = `Tap a card on Reader ${n} now…`;
        chip.className = 'chip warn';
      } else {
        btn.textContent = dev ? `Change Reader ${n}` : `Set Reader ${n}`;
        chip.textContent = dev || 'not set';
        chip.className = `chip ${dev ? 'good' : 'warn'}`;
        ok = !!dev;
      }
    } else {
      const sr = serialReaders[n];
      btn.disabled = false;
      btn.textContent = sr ? 'Disconnect' : 'Connect';
      chip.textContent = sr ? 'COM port connected' : 'not connected';
      chip.className = `chip ${sr ? 'good' : 'warn'}`;
      ok = !!sr;
    }
    if (ok && lastSeen[n]) chip.textContent += ` · last scan ${lastSeen[n].toLocaleTimeString()}`;

    const st = $(`st-${n}-reader`);
    st.textContent = `Reader ${n}: ${ok ? (lastSeen[n] ? 'working ✓' : 'ready') : 'not set up'}`;
    st.className = `chip ${ok ? 'good' : 'warn'}`;
  }

  const needsHelper = settings.r1 === 'keyboard' || settings.r2 === 'keyboard';
  const hs = $('helper-status');
  if (!needsHelper) {
    hs.textContent = '';
  } else if (helper.state === 'running') {
    hs.textContent = '✓ Reader helper running: the two USB readers are told apart by their USB device.';
    hs.className = 'small good-text';
  } else {
    hs.textContent = `Reader helper: ${helper.state}. ${helper.message || ''}`;
    hs.className = 'small warn-text';
  }

  const rc = $('relay-conn');
  rc.textContent = relay.port ? `connected · ${settings.baud} baud` : 'not connected';
  rc.className = `chip ${relay.port ? 'good' : 'warn'}`;
  $('relay-connect').textContent = relay.port ? 'Disconnect' : 'Connect relay';
  $('relay-baud').value = String(settings.baud);
  $('relay-baud').disabled = !!relay.port;
  $('pulse-ms').value = String(settings.pulseMs);

  const r1 = $('r1-conn').classList.contains('good');
  const r2 = $('r2-conn').classList.contains('good');
  const rl = !!relay.port;
  $('devices-summary').textContent = `Relay ${rl ? '✓' : '✗'} · Reader 1 ${r1 ? '✓' : '✗'} · Reader 2 ${r2 ? '✓' : '✗'}`;
  $('devices-summary').className = `small ${r1 && r2 && rl ? 'good-text' : 'warn-text'}`;
  if (!(r1 && r2 && rl)) $('devices').open = true;
}

for (const n of [1, 2]) {
  $(`r${n}-source`).addEventListener('change', async (e) => {
    if (serialReaders[n]) await serialReaders[n].close();
    settings[`r${n}`] = e.target.value;
    saveSettings();
    renderDevices();
  });
  $(`r${n}-action`).addEventListener('click', async () => {
    if (settings[`r${n}`] === 'serial') {
      if (serialReaders[n]) await serialReaders[n].close();
      else await connectSerialReader(n);
      return renderDevices();
    }
    try {
      if (assigning === n) {
        await api('/api/readers/assign/cancel', { method: 'POST', body: {} });
        assigning = null;
      } else {
        const r = await api('/api/readers/assign', { method: 'POST', body: { reader: n } });
        assigning = n;
        clearTimeout(assignTimer);
        assignTimer = setTimeout(() => { assigning = null; renderDevices(); }, r.seconds * 1000);
      }
    } catch (err) {
      $('helper-status').textContent = err.message;
    }
    renderDevices();
  });
}

// ---------- relay: LCUS-X2 USB relay, switched from this page via Web Serial ----------
// Same protocol and write method as the working lcus-relay-test page.
const relay = { port: null, reader: null, queue: Promise.resolve(), timers: {} };

// LC Technology frame: A0, channel, 01 = on / 00 = off, checksum (sum of the first three bytes)
function lcFrame(ch, on) {
  const s = on ? 1 : 0;
  return Uint8Array.from([0xa0, ch, s, (0xa0 + ch + s) & 0xff]);
}

function relayHelp(text, kind) {
  $('relay-help').textContent = text;
  $('relay-help').className = `small ${kind === 'warn' ? 'warn-text' : 'muted'}`;
}

// One write at a time: the port has a single writer lock.
function relayWrite(bytes) {
  const run = relay.queue.then(async () => {
    if (!relay.port || !relay.port.writable) throw new Error('Relay not connected. Open Devices and click "Connect relay".');
    const w = relay.port.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  });
  relay.queue = run.catch(() => {});
  return run;
}

// Channel on, then off after the "On for" time. Resolves once the ON command was written.
async function pulseRelay(ch) {
  try {
    await relayWrite(lcFrame(ch, true));
  } catch (err) {
    renderRelay(ch, { state: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
  renderRelay(ch, { state: 'on' });
  clearTimeout(relay.timers[ch]);
  relay.timers[ch] = setTimeout(async () => {
    try {
      await relayWrite(lcFrame(ch, false));
      renderRelay(ch, { state: 'off', at: new Date().toISOString() });
    } catch (err) {
      renderRelay(ch, { state: 'error', error: `Could not switch OFF: ${err.message}` });
    }
  }, settings.pulseMs);
  return { ok: true };
}

async function connectRelay(port) {
  if (!('serial' in navigator)) {
    relayHelp('This browser cannot use USB serial. Open the page in Google Chrome or Microsoft Edge.', 'warn');
    return;
  }
  try {
    if (!port) port = await navigator.serial.requestPort();
    await port.open({ baudRate: settings.baud });
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      relayHelp(`Could not open the relay's COM port: ${err.message}. Close lcus-relay-test.html or any other relay program, then try again.`, 'warn');
    }
    return;
  }
  relay.port = port;
  const info = port.getInfo();
  settings.relayUsb = info.usbVendorId ? `${info.usbVendorId}:${info.usbProductId}` : '';
  saveSettings();
  relayHelp('Relay connected. Click "Test relay 1" on the Time In / Time Out page.');
  renderDevices();
  relayReadLoop(port);
}

// Keep reading so an unplugged relay is noticed straight away.
async function relayReadLoop(port) {
  while (relay.port === port && port.readable) {
    relay.reader = port.readable.getReader();
    try {
      for (;;) {
        const { done } = await relay.reader.read();
        if (done) break;
      }
    } catch (err) {
      relayHelp(`Relay connection lost: ${err.message}. Was it unplugged?`, 'warn');
      break;
    } finally {
      relay.reader.releaseLock();
      relay.reader = null;
    }
  }
  if (relay.port === port) await disconnectRelay();
}

async function disconnectRelay() {
  const port = relay.port;
  relay.port = null;
  try { if (relay.reader) await relay.reader.cancel(); } catch { /* closed */ }
  try { if (port) await port.close(); } catch { /* closed */ }
  renderDevices();
}

// Reopen the relay without a click if Chrome already has permission for exactly that device.
async function autoConnectRelay() {
  if (!('serial' in navigator) || !settings.relayUsb) return;
  const ports = (await navigator.serial.getPorts()).filter((p) => {
    const i = p.getInfo();
    return `${i.usbVendorId}:${i.usbProductId}` === settings.relayUsb && !Object.values(serialReaders).some((r) => r && r.port === p);
  });
  if (ports.length === 1) await connectRelay(ports[0]);
}

$('relay-connect').addEventListener('click', () => (relay.port ? disconnectRelay() : connectRelay()));
$('relay-baud').addEventListener('change', (e) => {
  settings.baud = Number(e.target.value);
  saveSettings();
});
$('pulse-ms').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (Number.isInteger(v) && v >= 200 && v <= 10000) {
    settings.pulseMs = v;
    saveSettings();
  }
  renderDevices();
});
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (e.target === relay.port) {
      relayHelp('Relay unplugged.', 'warn');
      disconnectRelay();
    }
  });
}

function renderRelay(ch, s) {
  const chip = $(`st-${ch}-relay`);
  const txt = chip.querySelector('.txt');
  const state = (s && s.state) || 'unknown';
  chip.className = `chip relay ${state}`;
  if (state === 'on') txt.textContent = `Relay ${ch}: ON`;
  else if (state === 'off') txt.textContent = `Relay ${ch}: OFF · worked at ${fmtTime(s.at)} ✓`;
  else if (state === 'error') txt.textContent = `Relay ${ch}: ERROR · ${s.error}`;
  else txt.textContent = `Relay ${ch}: not used yet`;
}

for (const ch of [1, 2]) {
  $(`test-relay-${ch}`).addEventListener('click', async () => {
    const r = await pulseRelay(ch);
    setMsg($(`st-${ch}-msg`), r.ok ? `Relay ${ch} test sent: the channel ${ch} LED should light now` : `Relay test failed: ${r.error}`, r.ok ? 'ok' : 'bad');
  });
}

// ---------- scans ----------
function onScan(uid, reader, device) {
  if (reader) {
    lastSeen[reader] = new Date();
    renderDevices();
  }
  if (page === 'register') return fillRegistration(uid);
  if (!reader) {
    const hs = $('helper-status');
    hs.textContent = `A card was tapped on a reader that isn't set (${device || 'unknown device'}). Click "Set Reader 1" or "Set Reader 2" above, then tap it again.`;
    hs.className = 'small warn-text';
    $('devices').open = true;
    return;
  }
  recordAttendance(uid, reader);
}

async function recordAttendance(uid, reader) {
  const el = (k) => $(`st-${reader}-${k}`);
  try {
    const r = await api('/api/scan', { method: 'POST', body: { uid, reader } });
    el('uid').textContent = r.uid;
    el('name').textContent = r.name;
    el('time').textContent = reader === 1 ? `Time in ${fmtTime(r.time_in)}` : `Time in ${fmtTime(r.time_in)} · Time out ${fmtTime(r.time_out)}`;
    // Saved first; the relay switches only for a successfully recorded, registered card.
    const rr = await pulseRelay(reader);
    if (rr.ok) setMsg(el('msg'), reader === 1 ? '✔ Time in recorded' : '✔ Time out recorded', 'ok');
    else setMsg(el('msg'), `✔ Recorded, but relay ${reader} did not switch: ${rr.error}`, 'warn');
    flash($(`st-${reader}`));
    loadToday();
  } catch (err) {
    const d = err.data || {};
    if (d.code === 'duplicate') return; // same tap reported twice
    el('uid').textContent = uid;
    el('name').textContent = d.name || '';
    el('time').textContent = d.time_in ? `Time in ${fmtTime(d.time_in)}` : '';
    if (d.code === 'not_registered') setMsg(el('msg'), '✖ Card not registered. Relay not activated.', 'bad');
    else if (d.code === 'already_in') setMsg(el('msg'), '⚠ Already timed in today. Use Reader 2 to time out.', 'warn');
    else if (d.code === 'no_time_in') setMsg(el('msg'), '⚠ No time-in today. Tap on Reader 1 first.', 'warn');
    else setMsg(el('msg'), `✖ ${err.message}`, 'bad');
  }
}

function flash(node) {
  node.classList.remove('flash');
  void node.offsetWidth; // restart animation
  node.classList.add('flash');
}

// ---------- page 1: registration ----------
let cardsByUid = new Map();

function normaliseUid(s) {
  return s.replace(/[\s:\-]/g, '').toUpperCase();
}

function fillRegistration(uid) {
  $('reg-uid').textContent = uid;
  $('reg-uid-input').value = uid;
  const existing = cardsByUid.get(uid);
  if (existing) {
    setMsg($('reg-hint'), `Already registered to ${existing.name}`, 'warn');
  } else {
    setMsg($('reg-hint'), 'New card. Type the name and click Register.', 'ok');
    $('reg-name').focus();
  }
  flash($('reg-uid'));
}

$('reg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const uid = normaliseUid($('reg-uid-input').value);
  const name = $('reg-name').value.trim();
  try {
    const r = await api('/api/cards', { method: 'POST', body: { uid, name } });
    setMsg($('reg-msg'), `✔ Registered ${r.card.name} (${r.card.uid})`, 'ok');
    $('reg-form').reset();
    $('reg-uid').textContent = '—';
    setMsg($('reg-hint'), '');
    loadCards();
  } catch (err) {
    setMsg($('reg-msg'), `✖ ${err.message}`, 'bad');
  }
});

async function loadCards() {
  try {
    const { cards } = await api('/api/cards');
    cardsByUid = new Map(cards.map((c) => [c.uid, c]));
    $('card-count').textContent = `(${cards.length})`;
    const body = $('card-rows');
    body.replaceChildren();
    if (!cards.length) body.append(emptyRow(4, 'No cards yet. Tap a card above to register it.'));
    for (const c of cards) {
      const tr = document.createElement('tr');
      for (const v of [c.uid, c.name, fmtDate(c.created_at)]) tr.append(td(v));
      const del = document.createElement('button');
      del.className = 'small-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', () => deleteCard(c));
      const cell = document.createElement('td');
      cell.append(del);
      tr.append(cell);
      body.append(tr);
    }
  } catch (err) {
    setMsg($('reg-msg'), `✖ Could not load cards: ${err.message}`, 'bad');
  }
}

async function deleteCard(c) {
  if (!confirm(`Delete ${c.name} (${c.uid})?\nTheir time in / time out records are deleted too.`)) return;
  try {
    await api(`/api/cards/${encodeURIComponent(c.id)}`, { method: 'DELETE' });
    setMsg($('reg-msg'), `Deleted ${c.name}`, 'ok');
    loadCards();
  } catch (err) {
    setMsg($('reg-msg'), `✖ ${err.message}`, 'bad');
  }
}

// ---------- page 2: today's records ----------
async function loadToday() {
  try {
    const { records } = await api('/api/attendance/today');
    const body = $('today-rows');
    body.replaceChildren();
    if (!records.length) body.append(emptyRow(4, 'No time in / time out yet today.'));
    for (const r of records) {
      const tr = document.createElement('tr');
      for (const v of [r.uid, r.name, fmtTime(r.time_in), r.time_out ? fmtTime(r.time_out) : '—']) tr.append(td(v));
      body.append(tr);
    }
  } catch (err) {
    setMsg($('st-1-msg'), `✖ Could not load today's records: ${err.message}`, 'bad');
  }
}

function td(text) {
  const cell = document.createElement('td');
  cell.textContent = text;
  return cell;
}

function emptyRow(cols, text) {
  const tr = document.createElement('tr');
  const cell = td(text);
  cell.colSpan = cols;
  cell.className = 'muted';
  tr.append(cell);
  return tr;
}

// ---------- keyboard-type readers inside the browser ----------
// The readers also "type" into this page. Swallow those fast bursts so they don't end up
// in text boxes. If the Windows helper isn't running, use them as scans (cannot tell readers apart).
const kb = { buf: '', times: [], timer: null };

function finishBurst() {
  clearTimeout(kb.timer);
  const code = kb.buf;
  const t = kb.times;
  kb.buf = '';
  kb.times = [];
  if (code.length < 4) return false;
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avg > 35) return false; // a person typing
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.value.endsWith(code)) {
    a.value = a.value.slice(0, -code.length);
  }
  if (helper.state !== 'running') {
    const fallback = settings.r1 === 'keyboard' ? 1 : settings.r2 === 'keyboard' ? 2 : null;
    onScan(normaliseUid(code), fallback);
  }
  return true;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (finishBurst()) e.preventDefault();
    return;
  }
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
  const now = performance.now();
  if (kb.times.length && now - kb.times[kb.times.length - 1] > 80) {
    kb.buf = '';
    kb.times = [];
  }
  if (kb.buf.length < 64) {
    kb.buf += e.key;
    kb.times.push(now);
  }
  clearTimeout(kb.timer);
  kb.timer = setTimeout(finishBurst, 300); // some readers send no Enter
}, true);

// ---------- serial (COM port) readers via Web Serial ----------
const serialReaders = { 1: null, 2: null };

// RDM6300 frame: 0x02, 10 hex chars data, 2 hex chars checksum, 0x03
function parseRdm6300(ascii) {
  if (!/^[0-9A-F]{12}$/i.test(ascii)) return null;
  const bytes = ascii.match(/../g).map((h) => parseInt(h, 16));
  const xor = bytes.slice(0, 5).reduce((a, b) => a ^ b, 0);
  if (xor !== bytes[5]) return null;
  // Same 10-digit number USB keyboard readers print for EM4100 cards
  return String(parseInt(ascii.slice(2, 10), 16)).padStart(10, '0');
}

async function connectSerialReader(n) {
  const hs = $('helper-status');
  if (!('serial' in navigator)) {
    hs.textContent = 'Serial readers need Chrome or Edge on a PC.';
    hs.className = 'small warn-text';
    return;
  }
  let port;
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      hs.textContent = `Reader ${n}: could not open COM port (${err.message}). Is another program using it?`;
      hs.className = 'small warn-text';
    }
    return;
  }
  const sr = { port, reader: null, buf: [], last: '', lastAt: 0 };
  sr.close = async () => {
    serialReaders[n] = null;
    try { if (sr.reader) await sr.reader.cancel(); } catch { /* closed */ }
    try { await port.close(); } catch { /* closed */ }
    renderDevices();
  };
  serialReaders[n] = sr;
  readSerial(n, sr);
}

async function readSerial(n, sr) {
  while (serialReaders[n] === sr && sr.port.readable) {
    sr.reader = sr.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await sr.reader.read();
        if (done) break;
        for (const b of value) handleSerialByte(n, sr, b);
      }
    } catch (err) {
      $('helper-status').textContent = `Reader ${n}: ${err.message} (unplugged?)`;
      break;
    } finally {
      sr.reader.releaseLock();
      sr.reader = null;
    }
  }
  if (serialReaders[n] === sr) await sr.close();
}

function handleSerialByte(n, sr, b) {
  if (b === 0x02) { sr.buf = []; return; }
  if (b !== 0x03 && b !== 0x0a && b !== 0x0d) {
    if (sr.buf.length < 128) sr.buf.push(b);
    return;
  }
  const text = String.fromCharCode(...sr.buf).trim();
  sr.buf = [];
  if (!text) return;
  let uid = b === 0x03 ? parseRdm6300(text) : null;
  if (!uid) {
    // e.g. Arduino + RC522 printing "UID: 04 A2 1B 3C"
    const m = text.match(/([0-9A-F]{2}(?:[\s:]?[0-9A-F]{2}){3,9})\s*$/i) || text.match(/(\d{4,20})\s*$/);
    if (!m) return;
    uid = normaliseUid(m[1]);
  }
  const now = Date.now();
  if (uid === sr.last && now - sr.lastAt < 2000) { sr.lastAt = now; return; } // card resting on the antenna
  sr.last = uid;
  sr.lastAt = now;
  onScan(uid, n);
}

// ---------- start ----------
for (const ch of [1, 2]) renderRelay(ch, null);
renderDevices();
showPage();
streamEvents();
autoConnectRelay().catch(() => { /* user can click Connect relay */ });
