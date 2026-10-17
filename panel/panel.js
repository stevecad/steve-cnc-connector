'use strict';
// Shop panel: a card per machine, drawn from the connector's "<machine>.status" events, running the machine's
// actions ("<machine>.<action>") through STEVE's bridge.

const ENDED = ['succeeded', 'failed', 'rejected', 'cancelled', 'expired'];
const SCREEN_EVERY_MS = 5000; // "Auto" screen refresh; STEVE takes at most 20 panel runs a minute
const STATES = {
  idle: ['Idle', ''], running: ['Running', 'ok'], stopped: ['Stopped', 'warn'], waiting: ['Waiting', 'warn'],
  interrupted: ['Interrupted', 'warn'], alarm: ['Alarm', 'bad'], emergency_stop: ['E-stop', 'bad'],
  offline: ['Offline', 'bad'], connecting: ['Connecting', 'warn'],
};
const KEY_LABELS = {
  PROGRAM_MANAGER: 'Prog. mgr', MACHINE: 'Machine', OFFSET: 'Offset', PROGRAM: 'Program', SYSTEM: 'System',
  UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→', PAGE_UP: 'PgUp', PAGE_DOWN: 'PgDn', TAB: 'Tab', INPUT: 'Input',
};

let next = 0;
const waiting = new Map();
const machines = new Map(); // key -> machine card state
const runs = new Map();     // run id -> {key, action}, for every run this panel started
const finished = new Set(); // run ids whose end was already handled
let doc = null;             // the STEVE document open now, when the panel may send it

const $ = (id) => document.getElementById(id);

// Asks STEVE something; gives up after timeoutMs so a lost answer can't leave a button stuck.
function call(method, params = {}, timeoutMs = 30000) {
  const id = ++next;
  window.parent.postMessage({ steve: 1, id, method, params }, '*');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (waiting.delete(id)) reject({ code: 'timeout', message: `STEVE didn't answer (${method})` });
    }, timeoutMs);
    waiting.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.steve !== 1) return;
  if (message.id !== undefined && waiting.has(message.id)) {
    const { resolve, reject } = waiting.get(message.id);
    waiting.delete(message.id);
    message.error ? reject(message.error) : resolve(message.result);
  } else if (message.event === 'event') {
    guarded(() => onEvent(message.name, message.data));
  } else if (message.event === 'run') {
    guarded(() => showRun(message.run));
  } else if (message.event === 'context') {
    applyTheme(message.context.theme);
    setDocument(message.context.document);
  }
});

// Runs a UI update and shows any error at the foot of the panel instead of failing silently.
function guarded(fn) {
  try {
    fn();
  } catch (e) {
    $('error').textContent = `Panel error: ${e.message || e}`;
    $('error').hidden = false;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
}

// ---- machines ----

function machine(key, title) {
  if (machines.has(key)) return machines.get(key);
  const el = $('machine').content.firstElementChild.cloneNode(true);
  const m = { key, el, name: title || key, status: null, defs: new Map(), allowed: new Set(), busy: new Map(), auto: false };
  m.q = (sel) => el.querySelector(sel);
  m.q('.name').textContent = m.name;
  machines.set(key, m);
  const list = $('machines');
  if (!list.querySelector('.machine')) list.textContent = '';
  list.appendChild(el);
  wire(m);
  return m;
}

function onEvent(name, data) {
  const dot = name.indexOf('.');
  if (dot < 1 || !data) return;
  const m = machine(name.slice(0, dot));
  const kind = name.slice(dot + 1);
  if (kind === 'status') draw(m, data);
  else if (kind === 'alert' && data.message) say(m, `${new Date(data.at || Date.now()).toLocaleTimeString()}: ${data.message}`);
}

function rows(s) {
  const out = [];
  if (s.connected === false) out.push(['PLC', s.plc_error ? `not reachable: ${s.plc_error}` : 'connecting…']);
  if (s.mode) out.push(['Mode', s.mode]);
  if (s.program) out.push(['Program', s.program + (s.channel ? ` · channel ${s.channel}` : '')]);
  if ('alarm' in s) out.push(['Alarm', s.alarm ? (s.alarm_stop ? 'active, processing stopped' : 'active') : 'none']);
  if ('estop' in s) out.push(['E-stop', s.estop ? 'PRESSED' : 'released']);
  if ('referenced' in s) out.push(['Axes', `${s.referenced ? 'referenced' : 'not referenced'}, ${s.stationary ? 'stationary' : 'moving'}`]);
  if (s.drives) out.push(['Drives', s.drives]);
  if ('door_open' in s) out.push(['Door', s.door_open ? 'open' : 'closed']);
  if ('door_locked' in s) {
    const disagree = 'lock_released' in s && s.lock_released === s.door_locked;
    out.push(['Door lock', `${s.door_locked ? 'locked' : 'unlocked'}${disagree ? ' (its switch disagrees)' : ''}`]);
  }
  for (const [k, v] of Object.entries(s.signals || {})) out.push([k.replace(/_/g, ' '), String(v)]);
  if (s.programs_folder) {
    out.push(['Programs', s.programs_folder === 'ok' ? (s.drive ? `on drive ${s.drive}` : 'ok') : s.programs_folder]);
  }
  if (s.since) out.push(['Since', new Date(s.since).toLocaleTimeString()]);
  return out;
}

function draw(m, s) {
  m.status = s;
  if (s.name) m.q('.name').textContent = m.name = s.name;
  const [label, cls] = STATES[s.state] || [s.programs_folder === 'ok' ? 'Ready' : s.state || '—', ''];
  const pill = m.q('.state');
  pill.textContent = label;
  pill.className = `state pill ${cls}`;
  const dl = m.q('.status');
  dl.textContent = '';
  for (const [k, v] of rows(s)) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  // A button per output STEVE may switch (the lamp): it shows the state and switches to the other.
  const box = m.q('.outputs');
  box.textContent = '';
  for (const [name, on] of Object.entries(s.outputs || {})) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `output${on ? ' on' : ''}`;
    const label = name.replace(/_/g, ' ');
    b.textContent = `${label[0].toUpperCase()}${label.slice(1)}: ${on ? 'on' : 'off'}`;
    b.title = `Switch ${label} ${on ? 'off' : 'on'}`;
    b.addEventListener('click', () => run(m, 'set_output', { output: name, on: !on }));
    box.appendChild(b);
  }
  const banner = s.estop ? 'Emergency stop pressed.' : s.alarm ? 'Alarm at the control: see its alarm screen (System).' : '';
  m.q('.banner').hidden = !banner;
  m.q('.banner').textContent = banner;
  refresh(m);
}

function say(m, text, error = false) {
  const p = m.q('.message');
  p.textContent = text || '';
  p.classList.toggle('error', Boolean(error && text));
}

// Shows a run's file (the screen) in an <img>.
const objectUrls = new Map();
async function showRunFile(m, runId, name, img) {
  try {
    const f = await call('run.file', { id: runId, name });
    if (objectUrls.has(img)) URL.revokeObjectURL(objectUrls.get(img));
    const url = URL.createObjectURL(f.blob);
    objectUrls.set(img, url);
    img.src = url;
    img.hidden = false;
    return true;
  } catch (e) {
    say(m, `Couldn't show ${name}: ${e.message || e}`, true);
    return false;
  }
}

// ---- the open document ----

function setDocument(d) {
  doc = d && d.kind === 'cam' ? d : null;
  for (const m of machines.values()) refresh(m);
}

// ---- buttons ----

function refresh(m) {
  const can = (a) => m.allowed.has(a);
  m.q('.outputs').hidden = !(can('set_output') && Object.keys(m.status?.outputs || {}).length);
  for (const b of m.el.querySelectorAll('.outputs button')) b.disabled = m.busy.has('set_output');
  const screenBusy = m.busy.has('screen') || m.busy.has('press_keys');
  m.q('.screen-card').hidden = !can('screen');
  m.q('.refresh-screen').disabled = screenBusy;
  m.q('.keys').hidden = !can('press_keys');
  for (const b of m.el.querySelectorAll('.keys button')) b.disabled = m.busy.has('press_keys');

  m.q('.send-card').hidden = !(doc && can('send_program'));
  if (doc) m.q('.doc').textContent = `The open CAM program, revision ${doc.revision}.`;
  m.q('.send').disabled = !doc || m.busy.has('send_program');
  m.q('.ask-hint').hidden = m.defs.get('send_program')?.sends_open_document_on_click !== false;

  m.q('.programs-card').hidden = !can('programs');
  m.q('.refresh-programs').disabled = m.busy.has('programs');
}

function wire(m) {
  for (const row of m.el.querySelectorAll('.keyrow')) {
    for (const k of row.dataset.keys.split(' ')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = KEY_LABELS[k] || k;
      b.title = k;
      b.addEventListener('click', () => run(m, 'press_keys', { keys: k }));
      row.appendChild(b);
    }
  }
  m.q('.key-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const keys = m.q('.key-text').value.trim();
    if (keys) run(m, 'press_keys', { keys }).then((r) => { if (r) m.q('.key-text').value = ''; });
  });
  m.q('.refresh-screen').addEventListener('click', () => run(m, 'screen'));
  m.q('.auto-on').addEventListener('change', (e) => {
    m.auto = e.target.checked;
    if (m.auto) run(m, 'screen', {}, { quiet: true });
  });
  m.q('.refresh-programs').addEventListener('click', () => run(m, 'programs'));
  // Started in the click itself: STEVE sends the open document at once only for the person's own click.
  m.q('.send').addEventListener('click', () => {
    if (!doc) return;
    const program = { document_id: doc.id, revision: doc.revision };
    const setup = m.q('.setup').value.trim();
    if (setup) program.setup = setup;
    run(m, 'send_program', { program });
  });
}

// ---- runs ----

async function run(m, action, inputs = {}, { quiet = false } = {}) {
  if (m.busy.has(action)) return null;
  m.busy.set(action, null);
  refresh(m);
  try {
    const r = await call('run', { action: `${m.key}.${action}`, inputs });
    m.busy.set(action, r.id);
    runs.set(r.id, { key: m.key, action, quiet });
    showRun(r);
    if (!ENDED.includes(r.state)) watchRun(r.id);
    return r;
  } catch (e) {
    m.busy.delete(action);
    if (e.code === 'rate_limited' && m.auto) {
      m.auto = false;
      m.q('.auto-on').checked = false;
    }
    say(m, e.code === 'caller_not_allowed' ? `"${action}" isn't allowed for this panel yet (Settings → Connectors).`
      : e.code === 'rate_limited' ? 'Too many runs this minute: wait a moment.' : e.message || String(e), true);
    refresh(m);
    return null;
  }
}

// Follows a run until it ends, in case a pushed update is missed.
function watchRun(id) {
  const timer = setInterval(async () => {
    if (finished.has(id) || !runs.has(id)) { clearInterval(timer); return; }
    try {
      const r = await call('run.get', { id });
      guarded(() => showRun({ ...r, id }));
    } catch {}
  }, 2000);
}

function showRun(r) {
  const info = runs.get(r.id);
  if (!info || finished.has(r.id)) return;
  const m = machines.get(info.key);
  const { action, quiet } = info;
  if (r.state === 'awaiting_confirmation') say(m, 'Waiting for you to confirm in STEVE');
  else if (r.state === 'failed' || r.state === 'rejected') say(m, r.error || r.message || `${action} failed`, true);
  else if (r.state === 'cancelled' || r.state === 'expired') say(m, `${action} ${r.state}`);
  else if (r.message && !quiet && r.state !== 'succeeded') say(m, r.message);
  if (r.state === 'succeeded') succeeded(m, action, r, quiet);
  if (ENDED.includes(r.state)) {
    finished.add(r.id);
    runs.delete(r.id);
    if (m.busy.get(action) === r.id) m.busy.delete(action);
    refresh(m);
  }
}

function succeeded(m, action, r, quiet) {
  const result = r.result || {};
  if (result.screen) {
    showRunFile(m, r.id, result.screen, m.q('.screen')).then((ok) => {
      if (!ok) return;
      const at = new Date(result.taken_at || Date.now()).toLocaleTimeString();
      m.q('.screen-note').textContent = result.dialog_seconds_left
        ? `${at}: new remote session; the control may show its remote-control dialog for about ${result.dialog_seconds_left} s.`
        : `${at}`;
    });
  }
  if (action === 'programs') showPrograms(m, result.files || []);
  if (action === 'status' && result.status) draw(m, result.status);
  if (action === 'set_output' && m.status?.outputs && result.output in m.status.outputs) {
    draw(m, { ...m.status, outputs: { ...m.status.outputs, [result.output]: result.on } });
  }
  if (action === 'send_program' && m.allowed.has('programs')) run(m, 'programs', {}, { quiet: true });
  if (!quiet && action !== 'programs' && action !== 'screen') say(m, r.message || 'Done');
}

function showPrograms(m, files) {
  const ul = m.q('.programs');
  ul.textContent = '';
  for (const f of files.slice(0, 50)) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = f.path;
    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = new Date(f.modified).toLocaleDateString();
    li.append(name, when);
    ul.appendChild(li);
  }
  if (!files.length) ul.innerHTML = '<li class="muted">No programs</li>';
}

setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  for (const m of machines.values()) {
    if (m.auto && m.allowed.has('screen') && !m.busy.has('screen') && !m.busy.has('press_keys')) {
      run(m, 'screen', {}, { quiet: true });
    }
  }
}, SCREEN_EVERY_MS);

(async function init() {
  try {
    const ctx = await call('context');
    applyTheme(ctx.theme);
    const events = await call('events');
    for (const e of events || []) guarded(() => onEvent(e.name, e.data));
    const actions = await call('actions');
    for (const a of actions || []) {
      const dot = a.name.indexOf('.');
      if (dot < 1) continue;
      const m = machine(a.name.slice(0, dot), (a.title || '').split(': ')[0]);
      const name = a.name.slice(dot + 1);
      m.defs.set(name, a);
      if (a.allowed) m.allowed.add(name);
    }
    setDocument(ctx.document);
    if (!machines.size) $('machines').innerHTML = '<p class="muted">This connector has no machines yet.</p>';
    for (const m of machines.values()) {
      refresh(m);
      if (!m.allowed.size) say(m, "Allow this machine's actions for its panel in Settings → Connectors.");
      if (m.allowed.has('programs')) run(m, 'programs', {}, { quiet: true });
    }
  } catch (e) {
    $('machines').textContent = e.message || String(e);
  }
})();
