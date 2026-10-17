// End to end: connector.js against a STEVE stand-in (enrollment, token, catalog, panel, events, runs, files) and
// the fake 808D PLC.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { canonical } = require('../lib/steve');
const { tmp, until, fakePlc, idle808d } = require('./helpers');

const PROGRAM = Buffer.from('; %_N_BRACKET_MPF\r\nG54 G17 G90\r\nT1 M6\r\nM30\r\n');
const rawPub = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

// What STEVE would do, recorded: requests by endpoint, run reports, files and events.
async function fakeSteve() {
  const key = crypto.generateKeyPairSync('ed25519');
  const steve = { reports: [], files: [], events: [], queue: [], panels: {}, catalogs: [], unsigned: [], nextId: 1 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const route = url.pathname.replace(/^\/connect\/v1/, '');
      const json = (status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (!req.headers.signature || !req.headers['content-digest']) steve.unsigned.push(route);
      const parsed = () => JSON.parse(body.toString() || '{}');
      let m;
      if (req.method === 'POST' && route === '/enroll') {
        const b = parsed();
        steve.enroll = b;
        steve.fingerprint = 'SHA256:' + crypto.createHash('sha256').update(Buffer.from(b.public_key, 'base64'))
          .digest('base64').replace(/=+$/, '');
        return json(200, { connector: 'con_test', fingerprint: steve.fingerprint,
          steve_keys: [{ kid: 'k1', alg: 'ed25519', public_key: rawPub(key.publicKey) }] });
      }
      if (req.method === 'POST' && route === '/token') return json(200, { token: 'tok', expires_in: 900 });
      if (req.headers.authorization !== 'Bearer tok') return json(401, { detail: { code: 'token_invalid', message: 'no' } });
      if (req.method === 'PUT' && route === '/catalog') { steve.catalogs.push(parsed()); return json(200, {}); }
      if (req.method === 'PUT' && (m = route.match(/^\/panels\/(.+)$/))) {
        steve.panels[m[1]] = parsed();
        return json(200, { name: m[1], version: 1 });
      }
      if (req.method === 'POST' && route === '/events') { steve.events.push(parsed()); return json(200, {}); }
      if (req.method === 'GET' && route === '/messages') {
        const after = Number(url.searchParams.get('after'));
        const send = () => {
          const messages = steve.queue.filter((x) => x.id > after);
          return json(200, { messages, cursor: messages.length ? messages.at(-1).id : after });
        };
        return steve.queue.some((x) => x.id > after) ? send() : setTimeout(send, 100);
      }
      if (req.method === 'POST' && (m = route.match(/^\/runs\/([^/]+)$/))) {
        steve.reports.push({ run: m[1], ...parsed() });
        return json(200, {});
      }
      if (req.method === 'PUT' && (m = route.match(/^\/runs\/([^/]+)\/files\/(.+)$/))) {
        steve.files.push({ run: m[1], name: decodeURIComponent(m[2]), type: req.headers['content-type'], body });
        return json(200, {});
      }
      if (req.method === 'GET' && route === '/runs/run_send/inputs/program') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(PROGRAM);
      }
      json(404, { detail: { code: 'not_found', message: route } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  steve.base = `http://127.0.0.1:${server.address().port}/connect/v1`;
  // Queues a run (or cancel) signed like STEVE signs them.
  steve.send = (kind, envelope, { signWith = key.privateKey } = {}) => {
    const env = {
      note: null, requested_by: { kind: 'agent' }, confirmed_by: null, connector: steve.fingerprint,
      issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
      nonce: crypto.randomUUID(), ...envelope,
    };
    steve.queue.push({ id: steve.nextId++, kind, kid: 'k1', envelope: env,
      sig: crypto.sign(null, Buffer.from(canonical(env)), signWith).toString('base64') });
  };
  steve.runReports = (run) => steve.reports.filter((r) => r.run === run);
  steve.ended = (run) => steve.runReports(run).find((r) => ['succeeded', 'failed', 'rejected', 'cancelled'].includes(r.state));
  steve.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return steve;
}

test('connector.js: pairs, publishes, reports the machine and runs its actions', { timeout: 60000 }, async (t) => {
  const steve = await fakeSteve();
  const plc = await fakePlc();
  idle808d(plc);
  const dir = tmp();
  const programs = path.join(dir, 'cnc');
  fs.mkdirSync(programs);
  fs.writeFileSync(path.join(programs, 'existing.mpf'), 'G0 X0\r\nM30\r\n');
  const config = {
    name: 'Test shop', steve_url: steve.base, confirm: [], panel: { name: 'shop', title: 'Shop' },
    machines: [{
      key: 'x7', name: 'Syil X7', driver: 'sinumerik808d',
      programs: { folder: programs, subfolder: 'STEVE', drive: 'N1', extension: '.mpf', max_name_length: 24 },
      plc: { host: '127.0.0.1', port: plc.port, poll_ms: 250 },
    }],
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const output = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'connector.js'), '--config', path.join(dir, 'config.json'),
    '--data', path.join(dir, 'data'), '--pair', 'ABCD-1234'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (c) => output.push(c.toString()));
  child.stderr.on('data', (c) => output.push(c.toString()));
  t.after(async () => {
    child.kill();
    await plc.close();
    await steve.close();
  });
  const log = () => output.join('');

  // Enrollment, the catalog and the panel.
  await until(() => steve.catalogs.length && steve.panels.shop, { timeoutMs: 15000, what: `catalog and panel\n${log()}` });
  assert.equal(steve.enroll.code, 'ABCD-1234');
  assert.match(log(), new RegExp(steve.fingerprint.replace(/[+/]/g, '\\$&')), 'prints the fingerprint to confirm');
  const names = steve.catalogs[0].actions.map((a) => a.name);
  assert.deepEqual(names, ['x7.programs', 'x7.read_program', 'x7.send_program', 'x7.status', 'x7.read_plc']);
  assert.deepEqual(steve.catalogs[0].events.map((e) => e.name), ['x7.status', 'x7.alert']);
  assert.equal(steve.catalogs[0].actions.find((a) => a.name === 'x7.send_program').inputs.properties.program['x-steve'], 'program');
  assert.deepEqual(Object.keys(steve.panels.shop.files).sort(), ['index.html', 'panel.css', 'panel.js']);
  assert.equal(steve.panels.shop.title, 'Shop');
  assert.deepEqual(steve.unsigned, [], 'every request is signed');

  // The machine's state.
  const status = await until(() => steve.events.find((e) => e.name === 'x7.status' && e.data.state === 'idle'),
    { what: 'an idle status event' });
  assert.equal(status.data.mode, 'AUTO');

  // Send a program, as STEVE hands it over.
  steve.send('run', { id: 'run_send', action: 'x7.send_program', inputs: { program: {
    kind: 'file', format: 'gcode', name: 'Bracket.nc', document: 'doc_1', revision: 3, machine: 'mch_1',
    verification: 'verified', url: `${steve.base}/runs/run_send/inputs/program`, bytes: PROGRAM.length,
    sha256: crypto.createHash('sha256').update(PROGRAM).digest('hex'),
  } } });
  const sent = await until(() => steve.ended('run_send'), { what: `send_program to end\n${log()}` });
  assert.equal(sent.state, 'succeeded', JSON.stringify(sent));
  assert.deepEqual(steve.runReports('run_send').map((r) => r.state).filter((s, i, a) => a.indexOf(s) === i),
    ['received', 'running', 'succeeded']);
  assert.equal(sent.result.path, 'STEVE/Bracket_R3.mpf');
  assert.deepEqual(fs.readFileSync(path.join(programs, 'STEVE', 'Bracket_R3.mpf')), PROGRAM);

  // The same run delivered again (after its envelope expired) is not acted on twice.
  const before = steve.reports.length;
  steve.send('run', { id: 'run_send', action: 'x7.send_program', inputs: {} });
  steve.send('run', { id: 'run_list', action: 'x7.programs', inputs: {} });
  const listed = await until(() => steve.ended('run_list'), { what: 'programs to end' });
  assert.equal(steve.reports.slice(before).filter((r) => r.run === 'run_send').length, 0);
  assert.deepEqual(listed.result.files.map((f) => f.path).sort(), ['STEVE/Bracket_R3.mpf', 'existing.mpf']);

  // A run STEVE didn't sign is refused.
  steve.send('run', { id: 'run_forged', action: 'x7.read_plc', inputs: { addresses: 'IB0' } },
    { signWith: crypto.generateKeyPairSync('ed25519').privateKey });
  const forged = await until(() => steve.ended('run_forged'), { what: 'the forged run to be refused' });
  assert.equal(forged.state, 'rejected');
  assert.match(forged.error, /bad STEVE signature/);

  // Reading the PLC, and an alert when a program starts at the machine.
  steve.send('run', { id: 'run_plc', action: 'x7.read_plc', inputs: { addresses: 'DB3300.DBB3 Q2.4' } });
  const read = await until(() => steve.ended('run_plc'), { what: 'read_plc to end' });
  assert.deepEqual(read.result.values, { 'DB3300.DBB3': 0b10010000, 'Q2.4': false });
  plc.set('DB3300.DBB3', 0b00100001);
  const alert = await until(() => steve.events.find((e) => e.name === 'x7.alert'), { what: 'a program_started alert' });
  assert.equal(alert.data.kind, 'program_started');
  await until(() => steve.events.find((e) => e.name === 'x7.status' && e.data.state === 'running'), { what: 'a running status' });

  // Cancelling a run that already ended just says so.
  steve.send('cancel', { run: 'run_gone' });
  await until(() => steve.runReports('run_gone').find((r) => r.state === 'cancelled'), { what: 'the cancel report' });

  assert.equal(plc.writes(), 0, 'the PLC was only ever read');
  assert.match(fs.readFileSync(path.join(dir, 'data', 'connector.log'), 'utf8'), /run run_send: x7.send_program by agent of "Bracket.nc" \(doc_1 r3\)/);
});
