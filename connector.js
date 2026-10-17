#!/usr/bin/env node
// STEVE connector for the machines in a shop: each machine is driven by a driver (lib/drivers/<driver>.js) named in
// config.json, which says what it can do (actions) and reports its state (events).
//   First run:  node connector.js --pair <CODE>       (code from STEVE, Settings → Connectors)
//   After that: node connector.js
// Options: --config <file> (default ./config.json), --data <folder> (default ./data).
'use strict';
const fs = require('fs');
const path = require('path');
const { Steve } = require('./lib/steve');
const { buildCatalog } = require('./lib/catalog');
const { buildPanel } = require('./lib/panel');
const { makeLog } = require('./lib/log');
const { version } = require('./package.json');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = __dirname;
const configPath = path.resolve(arg('--config') || path.join(ROOT, 'config.json'));
const DATA = path.resolve(arg('--data') || path.join(ROOT, 'data'));
fs.mkdirSync(DATA, { recursive: true });
const log = makeLog(path.join(DATA, 'connector.log'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(configPath)) {
  console.error(`${configPath} is missing: copy config.example.json to config.json and fill it in.`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!Array.isArray(config.machines) || !config.machines.length) {
  console.error('config: "machines" lists no machines');
  process.exit(1);
}

// One driver instance per machine.
function loadMachines() {
  return config.machines.map((m) => {
    if (!/^[a-z0-9_-]+$/.test(m.driver || '')) throw new Error(`machine ${m.key}: "driver" is missing or not a driver name`);
    const file = path.join(ROOT, 'lib', 'drivers', `${m.driver}.js`);
    if (!fs.existsSync(file)) throw new Error(`machine ${m.key}: there is no driver "${m.driver}" (lib/drivers/${m.driver}.js)`);
    return require(file).create(m, { dataDir: path.join(DATA, m.key), log });
  });
}

const steve = new Steve({ baseUrl: config.steve_url || 'https://stevecad.studio/connect/v1', dataDir: DATA, log });
const machines = loadMachines();
const catalog = buildCatalog(machines, { confirm: Array.isArray(config.confirm) ? config.confirm : [] });
const actionNames = catalog.actions.map((a) => a.name);
const handlerFor = (actionName) => {
  const dot = actionName.indexOf('.');
  const m = machines.find((x) => x.key === actionName.slice(0, dot));
  return m && m.handlers[actionName.slice(dot + 1)];
};
const active = new Map(); // run id -> AbortController

// ---- events: each machine's status as it changes (throttled), and its alerts ----

async function sendEvent(name, data) {
  if (!steve.token) return;
  try {
    await steve.event(name, data);
  } catch (e) {
    log(`event ${name} not sent: ${e.message}`);
  }
}

for (const m of machines) {
  let last = null, lastAt = 0, pending = null;
  const send = (status) => {
    const now = Date.now();
    const wait = 1000 - (now - lastAt);
    if (wait > 0) {
      clearTimeout(pending);
      pending = setTimeout(() => send(m.summary()), wait);
      return;
    }
    last = JSON.stringify(status);
    lastAt = now;
    sendEvent(`${m.key}.status`, status);
  };
  m.on('status', (s) => { if (JSON.stringify(s) !== last) send(s); });
  m.on('alert', (a) => sendEvent(`${m.key}.alert`, a));
  // A heartbeat, so STEVE shows the latest state even when nothing changes.
  setInterval(() => send(m.summary()), 60000).unref();
}

// ---- runs ----

async function handleRun(message) {
  const env = message.envelope;
  const runId = env.id;
  const problem = await steve.check(message, actionNames);
  if (problem) {
    log(`run ${runId} rejected: ${problem}`);
    if (problem !== 'replayed') await steve.report(runId, { state: 'rejected', error: problem }).catch(() => {});
    return;
  }
  steve.rememberNonce(env.nonce);
  const prior = steve.runState(runId);
  if (active.has(runId) || prior === 'done') {
    log(`run ${runId}: delivered again; already handled, ignoring the repeat`);
    return;
  }
  if (prior === 'accepted') {
    // Started before the connector stopped: never repeat it, say what happened.
    log(`run ${runId}: delivered again after a restart; reporting it failed instead of repeating it`);
    await steve.report(runId, { state: 'failed', error: 'the connector restarted during this run; it was not repeated' })
      .catch((e) => log('report:', e.message));
    steve.rememberRun(runId, 'done');
    return;
  }
  steve.rememberRun(runId, 'accepted');
  const handler = handlerFor(env.action);
  const who = env.requested_by?.kind || 'someone';
  const docs = Object.values(env.inputs || {}).filter((v) => v && v.kind === 'file')
    .map((v) => `"${v.name}" (${v.document} r${v.revision})`);
  log(`run ${runId}: ${env.action} by ${who}${docs.length ? ` of ${docs.join(', ')}` : ''}${env.note ? ` (${env.note})` : ''}`);
  await steve.report(runId, { state: 'received' });

  const controller = new AbortController();
  active.set(runId, controller);
  const ctx = {
    signal: controller.signal,
    progress: (progress, msg) => steve.report(runId, { state: 'running', progress, message: msg }).catch((e) => log('progress:', e.message)),
    input: (input) => steve.fetchInput(input),
    file: (name, buf, type) => steve.uploadFile(runId, name, buf, type),
  };
  (async () => {
    try {
      if (!handler) throw new Error(`no handler for ${env.action}`);
      await steve.report(runId, { state: 'running', progress: 0 });
      const out = (await handler(env.inputs || {}, ctx)) || {};
      await steve.report(runId, { state: 'succeeded', result: out.result || {}, message: out.message || 'Done' });
      log(`run ${runId}: ${env.action} succeeded${out.message ? ` (${out.message})` : ''}`);
    } catch (e) {
      const cancelled = controller.signal.aborted;
      log(`run ${runId}: ${env.action} ${cancelled ? 'cancelled' : 'failed'}: ${e.message}`);
      await steve.report(runId, cancelled ? { state: 'cancelled', message: 'Cancelled' } : { state: 'failed', error: e.message })
        .catch((err) => log('report:', err.message));
    } finally {
      active.delete(runId);
      steve.rememberRun(runId, 'done');
    }
  })();
}

async function handleCancel(message) {
  const problem = await steve.check(message, actionNames);
  if (problem) return log(`cancel ignored: ${problem}`);
  steve.rememberNonce(message.envelope.nonce);
  const runId = message.envelope.run;
  const c = active.get(runId);
  if (c) {
    log(`run ${runId}: cancelling`);
    c.abort();
  } else {
    await steve.report(runId, { state: 'cancelled', message: 'Cancelled' }).catch(() => {});
  }
}

// Publishes panel/ when it changed ("panel": false turns this off).
async function publishPanel() {
  if (config.panel === false) return;
  try {
    const { panel, hash } = buildPanel(path.join(ROOT, 'panel'), {
      title: config.panel?.title || config.name || 'Shop',
      placement: config.panel?.placement || ['right'],
    });
    const name = config.panel?.name || 'shop';
    if (steve.state.panel_hash === `${name}:${hash}`) return;
    const r = await steve.publishPanel(name, panel);
    steve.state.panel_hash = `${name}:${hash}`;
    steve.saveState();
    log(`published the panel "${r.name || name}" (version ${r.version ?? '?'})`);
  } catch (e) {
    log(`panel not published: ${e.message}`);
  }
}

// ---- main ----

async function main() {
  const code = arg('--pair');
  if (!steve.enrolled && !code) {
    console.error('Not paired yet. Get a code in STEVE (Settings → Connectors → Pair a connector), then run:\n  node connector.js --pair <CODE>');
    process.exit(1);
  }
  log(`machines: ${machines.map((m) => `${m.key} (${m.config.driver})`).join(', ')}; ${catalog.actions.length} actions`);
  for (const m of machines) m.start();
  if (!steve.enrolled) {
    const r = await steve.enroll(code.trim(), config.name || 'Shop machines', version, catalog);
    log(`enrolled as ${r.connector}`);
  }
  console.log('\n  Connector fingerprint (confirm this exact value in STEVE):\n');
  console.log(`  ${steve.fingerprint}\n`);
  log.fileOnly(`fingerprint ${steve.fingerprint}`);

  for (;;) {
    try {
      await steve.ensureToken();
      break;
    } catch (e) {
      if (e.code === 'pending_confirmation') {
        log('waiting for the connector to be confirmed in STEVE…');
        await sleep(60000);
      } else if (e.status === 403) {
        log(`STEVE refused this connector: ${e.message}. Revoked? Delete ${path.join(DATA, 'state.json')} and ${path.join(DATA, 'key.pem')}, then pair again.`);
        process.exit(1);
      } else {
        log(`token: ${e.message}; retrying`);
        await sleep(15000);
      }
    }
  }
  log('confirmed by STEVE');
  for (let attempt = 1; ; attempt++) {
    try {
      await steve.putCatalog(catalog);
      break;
    } catch (e) {
      if (e.status === 403 || attempt >= 10) throw e;
      log(`catalog not sent (${e.message}); retrying`);
      await sleep(Math.min(60000, 2000 * attempt));
    }
  }
  await publishPanel();
  for (const m of machines) sendEvent(`${m.key}.status`, m.summary());

  let backoff = 1000;
  for (;;) {
    try {
      const { messages, cursor } = await steve.messages(30);
      backoff = 1000;
      for (const msg of messages) {
        try {
          if (msg.kind === 'run') await handleRun(msg);
          else if (msg.kind === 'cancel') await handleCancel(msg);
        } catch (e) {
          log(`message ${msg.id}: ${e.message}`);
          if (msg.kind === 'run' && msg.envelope?.id && !active.has(msg.envelope.id)) {
            await steve.report(msg.envelope.id, { state: 'rejected', error: `connector error: ${e.message}` }).catch(() => {});
          }
        }
        steve.advance(msg.id);
      }
      if (cursor !== null) steve.advance(cursor);
    } catch (e) {
      if (e.status === 403 && e.code !== 'token_invalid' && e.code !== 'signature_invalid') {
        log(`STEVE refused this connector: ${e.message}`);
        process.exit(1);
      }
      log(`poll: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

const stop = () => { log('stopping'); for (const m of machines) m.stop(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
main().catch((e) => { log('fatal:', e.stack || e.message); process.exit(1); });
