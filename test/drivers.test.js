'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const folder = require('../lib/drivers/folder');
const s808d = require('../lib/drivers/sinumerik808d');
const { buildCatalog } = require('../lib/catalog');
const { ProgramFolder } = require('../lib/programs');
const { tmp, until, fakePlc, fakeVnc, idle808d } = require('./helpers');

const RULES = { extension: '.mpf', uppercase: false, max_name_length: 24, ascii_only: true };
const PROGRAM = Buffer.from('; %_N_BRACKET_MPF\r\nG54 G17 G90\r\nT1 M6\r\nM30\r\n');

// A run's ctx, as connector.js makes it, with the program "downloaded" from memory.
function runCtx(content = PROGRAM) {
  const files = [];
  const progress = [];
  return {
    files, progress, signal: new AbortController().signal,
    progress: async (f, text) => { progress.push([f, text]); },
    input: async () => content,
    file: async (name, buf, type) => { files.push({ name, buf, type }); },
  };
}
const programInput = (over = {}) => ({
  kind: 'file', name: 'Bracket top.nc', document: 'doc_1', revision: 3, bytes: PROGRAM.length,
  sha256: crypto.createHash('sha256').update(PROGRAM).digest('hex'), verification: 'verified', ...over,
});

test('program names: safe for the control, with revision and setup, extension as configured', () => {
  assert.equal(folder.programName(RULES, { name: 'Bracket top.nc', revision: 3 }), 'Bracket_top_R3.mpf');
  assert.equal(folder.programName({ ...RULES, uppercase: true }, { name: 'Bracket top.nc', revision: 3 }), 'BRACKET_TOP_R3.MPF');
  assert.equal(folder.programName(RULES, { name: '2 sides!', revision: 1, setup: 'op2' }), 'P2_sides_op2_R1.mpf');
  assert.equal(folder.programName(RULES, { name: 'A very long program name indeed', revision: 12 }).length, 24);
  assert.equal(folder.programName(RULES, {}, 'MYPART'), 'MYPART.mpf');
  assert.equal(folder.programName(RULES, {}, 'MYPART.MPF'), 'MYPART.MPF');
  assert.throws(() => folder.programName(RULES, {}, '../evil'), /letters, digits and _/);
  assert.throws(() => folder.programName(RULES, {}, 'x'.repeat(30)), /longer than 24/);
});

test('program content: plain ASCII, no byte order mark, not empty', () => {
  assert.deepEqual(folder.checkContent(RULES, PROGRAM), []);
  assert.match(folder.checkContent(RULES, Buffer.from('G0 X1\nG1 Y2 ; café\n')).join(), /line 2 .*0xc3/);
  assert.match(folder.checkContent(RULES, Buffer.from('﻿G0', 'utf8')).join(), /byte order mark/);
  assert.match(folder.checkContent(RULES, Buffer.alloc(0)).join(), /empty/);
});

test('program folder: writes only into its subfolder, never over a different file unless asked, never outside', () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, 'existing.mpf'), 'G0');
  const f = new ProgramFolder({ root, stagingDir: path.join(tmp(), 'staging') });
  const a = f.write('PART.mpf', Buffer.from('one'));
  assert.equal(a.path, 'STEVE/PART.mpf');
  assert.equal(f.write('PART.mpf', Buffer.from('one')).unchanged, true);
  assert.throws(() => f.write('PART.mpf', Buffer.from('two')), /already exists with different content/);
  assert.equal(f.write('PART.mpf', Buffer.from('two'), { replace: true }).unchanged, false);
  assert.equal(fs.readFileSync(path.join(root, 'STEVE', 'PART.mpf'), 'utf8'), 'two');
  assert.throws(() => f.write('../x.mpf', Buffer.from('x')), /not a safe file name/);
  assert.throws(() => f.read('../../etc/passwd'), /outside the program folder/);
  assert.equal(f.read('existing.mpf').toString(), 'G0');
  assert.deepEqual(f.list().files.map((x) => x.path).sort(), ['STEVE/PART.mpf', 'existing.mpf']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'STEVE')), ['PART.mpf'], 'no staging leftovers in the share');
});

test('catalog: actions and events prefixed with the machine key, limits enforced', () => {
  const m = folder.create({ key: 'x7', name: 'Syil X7', programs: { folder: tmp() } }, { dataDir: tmp(), log: () => {} });
  const c = buildCatalog([m], { confirm: ['x7.send_program'] });
  assert.deepEqual(c.actions.map((a) => a.name), ['x7.programs', 'x7.read_program', 'x7.send_program']);
  assert.equal(c.actions[2].title, 'Syil X7: Send program');
  assert.equal(c.actions[2].confirm, true);
  assert.equal(c.actions[0].confirm, false);
  assert.deepEqual(c.events.map((e) => e.name), ['x7.status', 'x7.alert']);
  assert.throws(() => buildCatalog([m, m]), /two machines have the key/);
  assert.throws(() => buildCatalog([{ ...m, key: 'X7', actions: () => [] }]), /lowercase/);
});

// ---- the 808D ----

async function machine808d(t, { screen = false, keys = true, signals, outputs } = {}) {
  const plc = await fakePlc();
  t.after(() => plc.close());
  idle808d(plc);
  const vnc = fakeVnc();
  const root = tmp();
  const logs = [];
  const m = s808d.create({
    key: 'x7', name: 'Syil X7', driver: 'sinumerik808d',
    programs: { folder: root, subfolder: 'STEVE', drive: 'N1', ...RULES },
    plc: { host: '127.0.0.1', port: plc.port, poll_ms: 250, signals, outputs },
    screen: screen ? { host: '192.0.2.2', confirm_seconds: 0, keys } : undefined,
  }, { dataDir: tmp(), log: (...a) => logs.push(a.join(' ')), connectScreen: vnc.connect });
  const statuses = [], alerts = [];
  m.on('status', (s) => statuses.push(s));
  m.on('alert', (a) => alerts.push(a));
  t.after(() => m.stop());
  return { m, plc, vnc, root, logs, statuses, alerts };
}

test('808D: status from the PLC, as read at the Syil', async (t) => {
  const { m, plc } = await machine808d(t);
  await m.poll();
  const s = m.summary();
  assert.deepEqual({ ...s, since: undefined }, {
    machine: 'x7', name: 'Syil X7', control: 'SINUMERIK 808D', connected: true, state: 'idle', mode: 'AUTO',
    program: 'aborted', channel: 'reset', alarm: false, alarm_stop: false, estop: false, referenced: true,
    stationary: true, ready: true, drives: 'ready', door_open: false, door_locked: false, lock_released: false, since: undefined,
    programs_folder: 'ok', drive: 'N1',
  });
  assert.ok(JSON.stringify(s).length < 8000, 'events are at most 8 kB');
  assert.equal(plc.reads.length, 5, 'one request per data block, the outputs and the inputs');
  assert.equal(plc.writes(), 0);
});

test('808D: modes and states', () => {
  const d = (v) => s808d.describe(v);
  assert.equal(d({ jog: true, ref: true }).mode, 'JOG REF');
  assert.equal(d({ mda: true }).mode, 'MDA');
  assert.equal(d({ program_running: true, channel_active: true }).state, 'running');
  assert.equal(d({ program_stopped: true, channel_interrupted: true }).state, 'stopped');
  assert.equal(d({ program_aborted: true, nck_alarm: true }).state, 'alarm');
  assert.equal(d({ program_running: true, estop: true }).state, 'emergency_stop');
  assert.equal(d({ program_running: true, channel_alarm: true }).state, 'running', 'a warning alarm while running');
});

test('808D: alerts when a program starts, stops and ends, alarms and e-stop; none on the first reading', async (t) => {
  const { m, plc, alerts } = await machine808d(t);
  plc.set('DB3300.DBB3', 0b00100001); // already running when the connector starts
  await m.poll();
  assert.deepEqual(alerts, [], 'a program found running did not just start');
  plc.set('DB3300.DBB3', 0b01000100); // stopped (feed hold)
  await m.poll();
  plc.set('DB3300.DBB3', 0b00100001); // running again
  await m.poll();
  plc.set('DB3300.DBX4.6', true); // an alarm while running
  await m.poll();
  plc.set('DB3300.DBB3', 0b10010000); // reset: program aborted
  plc.set('DB3300.DBX4.6', false);
  await m.poll();
  plc.set('DB2700.DBX0.1', true);
  await m.poll();
  plc.set('DB2700.DBX0.1', false);
  await m.poll();
  plc.set('DB3300.DBB3', 0b00100001);
  await m.poll();
  assert.deepEqual(alerts.map((a) => a.kind), ['program_stopped', 'program_resumed', 'alarm', 'program_ended',
    'alarm_cleared', 'emergency_stop', 'emergency_stop_released', 'program_started']);
  assert.equal(alerts.at(-1).mode, 'AUTO');
  assert.equal(alerts.at(-1).machine, 'x7');
});

test('808D: losing the PLC is an alert and an offline status, and it reconnects', async (t) => {
  const { m, plc, alerts, statuses } = await machine808d(t);
  m.plc.timeoutMs = 200;
  m.start();
  await until(() => statuses.find((s) => s.state === 'idle'), { what: 'idle status' });
  plc.silent = true;
  await until(() => alerts.find((a) => a.kind === 'offline'), { what: 'offline alert' });
  assert.equal(m.summary().state, 'offline');
  assert.match(m.summary().plc_error, /did not answer/);
  plc.silent = false;
  await until(() => alerts.find((a) => a.kind === 'online'), { timeoutMs: 8000, what: 'online alert' });
  assert.equal(m.summary().state, 'idle');
});

test('808D: actions, and the screen ones only with a screen', async (t) => {
  const plain = (await machine808d(t)).m;
  assert.deepEqual(plain.actions().map((a) => a.name), ['programs', 'read_program', 'send_program', 'status', 'read_plc']);
  const withScreen = (await machine808d(t, { screen: true })).m;
  assert.deepEqual(withScreen.actions().map((a) => a.name).slice(-2), ['screen', 'press_keys']);
  const noKeys = (await machine808d(t, { screen: true, keys: false })).m;
  assert.equal(noKeys.actions().at(-1).name, 'screen');
  assert.equal(noKeys.handlers.press_keys, undefined);
  for (const a of withScreen.actions()) assert.ok(!/delete/i.test(a.name), 'no delete action, ever');
  const send = withScreen.actions().find((a) => a.name === 'send_program');
  assert.match(send.description, /PROGRAM MANAGER, drive N1, folder STEVE/);
  const c = buildCatalog([withScreen]);
  assert.ok(c.actions.every((a) => a.confirm === false), 'no approvals by default');
});

test('808D: sends a program; replacing one is refused while a program is under way', async (t) => {
  const { m, plc, root } = await machine808d(t);
  await m.poll();
  const r = await m.handlers.send_program({ program: programInput() }, runCtx());
  assert.equal(r.result.path, 'STEVE/Bracket_top_R3.mpf');
  assert.match(r.message, /On N1: STEVE\/Bracket_top_R3.mpf/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'STEVE', 'Bracket_top_R3.mpf')), PROGRAM);
  plc.set('DB3300.DBB3', 0b00100001);
  await m.poll();
  const other = Buffer.from('G0 X0\r\nM30\r\n');
  await assert.rejects(m.handlers.send_program({ program: programInput(), replace: true }, runCtx(other)), /running at the control/);
  const again = await m.handlers.send_program({ program: programInput({ revision: 4 }) }, runCtx(other));
  assert.equal(again.result.path, 'STEVE/Bracket_top_R4.mpf', 'a new file is fine while a program runs');
  await assert.rejects(m.handlers.send_program({ program: programInput() }, runCtx(Buffer.from('G0 X1 ; café'))), /not sent: line 1/);
});

test('808D: status and read_plc actions read the PLC now', async (t) => {
  const { m, plc } = await machine808d(t, { signals: { door_closed: 'I3.0', door_locked: null } });
  plc.set('I3.0', true);
  plc.set('IB8', 0b10100001);
  const st = await m.handlers.status({ raw: true });
  assert.equal(st.message, 'idle, AUTO');
  assert.deepEqual(st.result.status.signals, { door_closed: true });
  assert.equal('door_locked' in st.result.status, false);
  assert.deepEqual(st.result.signals.estop, { address: 'DB2700.DBX0.1', value: false });
  const r = await m.handlers.read_plc({ addresses: 'IB7-9 DB2700.DBX0.1' });
  assert.deepEqual(r.result.values, { IB7: 0, IB8: 161, IB9: null, 'DB2700.DBX0.1': false });
  assert.equal(r.result.bits.IB8, '10100001');
  assert.match(r.result.missing.IB9, /refused/);
  assert.equal(r.message, '3 values, 1 not in this PLC');
  await assert.rejects(m.handlers.read_plc({ addresses: 'IB0 DB1.DBW0' }), /not an address/);
  assert.equal(plc.writes(), 0);
});

test('808D: nothing is written to the PLC unless the owner lists an output', async (t) => {
  const { m, plc } = await machine808d(t);
  assert.equal(m.actions().some((a) => a.name === 'set_output'), false);
  assert.equal(m.handlers.set_output, undefined);
  await m.poll();
  await m.handlers.status({ raw: true });
  await m.handlers.read_plc({ addresses: 'IB0-8 QB0-5' });
  assert.equal('outputs' in m.summary(), false);
  assert.equal(plc.writes(), 0);
});

test('808D: outputs must be single bits, never one of the control\'s signals', async (t) => {
  await assert.rejects(machine808d(t, { outputs: { lamp: 'QB2' } }), /single bit/);
  await assert.rejects(machine808d(t, { outputs: { door: 'Q2.4' } }), /control's door_locked signal/);
  await assert.rejects(machine808d(t, { outputs: { 'Bad Name': 'Q2.2' } }), /not allowed/);
});

test('808D: switches a listed output, reads it back, and shows it in status', async (t) => {
  const { m, plc, logs } = await machine808d(t, { outputs: { lamp: 'Q2.2' } });
  const action = m.actions().find((a) => a.name === 'set_output');
  assert.equal(action.title, 'Switch lamp');
  assert.deepEqual(action.inputs.properties.output.enum, ['lamp']);
  await m.poll();
  assert.deepEqual(m.summary().outputs, { lamp: false });
  const on = await m.handlers.set_output({ output: 'lamp', on: true });
  assert.equal(on.message, 'lamp on');
  assert.deepEqual(plc.written, [{ address: 'Q2.2', value: true }]);
  assert.deepEqual(m.summary().outputs, { lamp: true }, 'status follows at once');
  await m.handlers.set_output({ output: 'lamp', on: false });
  assert.deepEqual(m.summary().outputs, { lamp: false });
  assert.ok(logs.some((l) => /switching lamp \(Q2.2\) on/.test(l)));
  await assert.rejects(m.handlers.set_output({ output: 'coolant', on: true }), /not an output STEVE may switch/);
  assert.equal(plc.written.length, 2, 'nothing written for an output not listed');
});

test('808D: an output the PLC program sets itself fails instead of claiming it switched', async (t) => {
  const { m, plc } = await machine808d(t, { outputs: { lamp: 'Q2.2' } });
  plc.hold['Q2.2'] = false;
  await assert.rejects(m.handlers.set_output({ output: 'lamp', on: true }), /PLC program sets this output itself/);
  assert.deepEqual(m.summary().outputs, { lamp: false });
});

test('808D: screen and keys go through one remote session, keys logged', async (t) => {
  const { m, vnc, logs } = await machine808d(t, { screen: true });
  const ctx = runCtx();
  const shot = await m.handlers.screen({}, ctx);
  assert.equal(shot.result.screen, 'screen.png');
  assert.equal(ctx.files[0].type, 'image/png');
  const ctx2 = runCtx();
  const r = await m.handlers.press_keys({ keys: 'SYSTEM H3 "12"' }, ctx2);
  assert.deepEqual(r.result.pressed, ['SYSTEM', 'H3', '1', '2']);
  assert.equal(ctx2.files[0].name, 'screen.png');
  assert.equal(vnc.connects, 1);
  assert.equal(vnc.keys.length, 10);
  assert.ok(logs.some((l) => /pressing keys: SYSTEM H3 1 2/.test(l)));
  await assert.rejects(m.handlers.press_keys({ keys: 'H1 CYCLE_START' }, runCtx()), /unknown key/);
  assert.equal(vnc.keys.length, 10, 'nothing sent when a key is unknown');
});
