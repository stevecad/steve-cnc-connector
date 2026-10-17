// The panel in a DOM (jsdom), talking to a STEVE bridge stand-in through window.parent.postMessage.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { buildPanel } = require('../lib/panel');
const { until } = require('./helpers');

let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch {}
const PANEL = path.join(__dirname, '..', 'panel');
const plain = (v) => JSON.parse(JSON.stringify(v)); // objects made in the panel's window, compared here

const IDLE = {
  machine: 'x7', name: 'Syil X7', control: 'SINUMERIK 808D', connected: true, state: 'idle', mode: 'AUTO',
  program: 'aborted', channel: 'reset', alarm: false, alarm_stop: false, estop: false, referenced: true,
  stationary: true, ready: true, drives: 'ready', door_open: false, door_locked: true, lock_released: false,
  outputs: { lamp: false },
  since: '2026-10-16T23:56:13.570Z', programs_folder: 'ok', drive: 'N1',
};
const ACTIONS = ['programs', 'read_program', 'send_program', 'status', 'read_plc', 'set_output', 'screen', 'press_keys']
  .map((n, i) => ({ id: `act_${i}`, name: `x7.${n}`, title: `Syil X7: ${n}`, allowed: true, needs_confirmation: false,
    sends_open_document_on_click: n === 'send_program' ? false : undefined }));

function openPanel({ document = { id: 'doc_cam', kind: 'cam', revision: 3 }, actions = ACTIONS } = {}) {
  const html = fs.readFileSync(path.join(PANEL, 'index.html'), 'utf8').replace('<script src="panel.js"></script>', '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const bridge = { calls: [], runs: [], n: 0 };
  // Results for runs this panel starts: what the connector would report.
  const results = {
    'x7.programs': { files: [{ path: 'STEVE/Bracket_R3.mpf', bytes: 40, modified: '2026-10-16T23:00:00Z' }] },
    'x7.screen': { screen: 'screen.png', taken_at: '2026-10-16T23:57:00Z', dialog_seconds_left: 0 },
    'x7.press_keys': { pressed: ['H1'], screen: 'screen.png', taken_at: '2026-10-16T23:57:05Z' },
    'x7.send_program': { path: 'STEVE/Bracket_R3.mpf' },
    'x7.set_output': { output: 'lamp', address: 'Q2.2', on: true },
  };
  const parent = {
    postMessage(message) {
      bridge.calls.push(message);
      const answer = (result) => bridge.push({ steve: 1, id: message.id, result });
      if (message.method === 'context') answer({ theme: 'dark', document, panel: 'pnl_1', connector: 'con_1' });
      else if (message.method === 'events') answer([{ name: 'x7.status', data: IDLE, at: IDLE.since }]);
      else if (message.method === 'actions') answer(actions);
      else if (message.method === 'run') {
        const id = `run_${++bridge.n}`;
        bridge.runs.push({ id, ...message.params });
        answer({ id, state: 'queued' });
        bridge.finish = bridge.finish || {};
        bridge.finish[id] = () => bridge.push({ steve: 1, event: 'run', run: { id, state: 'succeeded',
          message: message.params.action === 'x7.send_program' ? 'On N1: STEVE/Bracket_R3.mpf' : 'Done',
          result: results[message.params.action] || {} } });
      } else if (message.method === 'run.file') answer({ name: 'screen.png', media_type: 'image/png', bytes: 3, blob: new window.Blob(['png']) });
      else if (message.method === 'run.get') answer({ state: 'running' });
    },
  };
  bridge.push = (data) => setTimeout(() => {
    const event = new window.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: parent });
    window.dispatchEvent(event);
  }, 0);
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  window.URL.createObjectURL = () => 'blob:screen';
  window.URL.revokeObjectURL = () => {};
  window.eval(fs.readFileSync(path.join(PANEL, 'panel.js'), 'utf8'));
  const $ = (sel) => window.document.querySelector(sel);
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return { window, bridge, $, click, close: () => window.close() };
}

test('panel: publishes as files STEVE takes', () => {
  const { panel } = buildPanel(PANEL, { title: 'Shop' });
  assert.deepEqual(Object.keys(panel.files).sort(), ['index.html', 'panel.css', 'panel.js']);
  for (const text of Object.values(panel.files)) assert.doesNotMatch(text, /https?:\/\/(?!www\.w3\.org)/, 'no network: bundle everything');
});

test('panel: draws the machine, lists programs, sends the open CAM program on a click', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const p = openPanel();
  t.after(p.close);
  await until(() => p.$('.machine .name')?.textContent === 'Syil X7', { what: 'the machine card' });
  assert.equal(p.window.document.documentElement.dataset.theme, 'dark');
  assert.equal(p.$('.state').textContent, 'Idle');
  const rows = [...p.window.document.querySelectorAll('.status dt')].map((dt) => `${dt.textContent}=${dt.nextSibling.textContent}`);
  assert.ok(rows.includes('Mode=AUTO'), rows.join());
  assert.ok(rows.includes('E-stop=released'), rows.join());
  assert.ok(rows.includes('Programs=on drive N1'), rows.join());
  assert.ok(rows.includes('Door=closed'), rows.join());
  assert.ok(rows.includes('Door lock=locked'), rows.join());

  // Programs are listed when it opens.
  await until(() => p.bridge.runs.find((r) => r.action === 'x7.programs'), { what: 'a programs run' });
  p.bridge.finish.run_1();
  await until(() => p.$('.programs li')?.textContent.includes('STEVE/Bracket_R3.mpf'), { what: 'the program list' });

  // The open CAM program goes to the machine on a click, once.
  assert.equal(p.$('.send-card').hidden, false);
  assert.equal(p.$('.ask-hint').hidden, false, 'says STEVE will ask, since the panel may not send it without asking');
  p.$('.setup').value = 'op2';
  p.click(p.$('.send'));
  p.click(p.$('.send'));
  await until(() => p.bridge.runs.find((r) => r.action === 'x7.send_program'), { what: 'a send_program run' });
  const sends = p.bridge.runs.filter((r) => r.action === 'x7.send_program');
  assert.equal(sends.length, 1, 'a second click does not queue a second run');
  assert.deepEqual(plain(sends[0].inputs), { program: { document_id: 'doc_cam', revision: 3, setup: 'op2' } });
  assert.equal(p.$('.send').disabled, true);
  p.bridge.finish[sends[0].id]();
  await until(() => p.$('.message').textContent.includes('On N1'), { what: 'the send message' });
  assert.equal(p.$('.send').disabled, false);
});

test('panel: screen, keys and an e-stop banner', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const p = openPanel();
  t.after(p.close);
  await until(() => p.$('.screen-card') && !p.$('.screen-card').hidden, { what: 'the screen card' });
  assert.equal(p.$('.keys').hidden, false);
  assert.equal(p.$('.screen').hidden, true, 'no screen until asked: a look shows a dialog at the control');
  assert.equal(p.bridge.runs.some((r) => r.action === 'x7.screen'), false);

  p.click(p.$('.refresh-screen'));
  const shot = await until(() => p.bridge.runs.find((r) => r.action === 'x7.screen'), { what: 'a screen run' });
  p.bridge.finish[shot.id]();
  await until(() => p.$('.screen').getAttribute('src') === 'blob:screen' && !p.$('.screen').hidden, { what: 'the screen image' });

  const h1 = [...p.window.document.querySelectorAll('.keyrow button')].find((b) => b.title === 'H1');
  p.click(h1);
  const press = await until(() => p.bridge.runs.find((r) => r.action === 'x7.press_keys'), { what: 'a press_keys run' });
  assert.deepEqual(plain(press.inputs), { keys: 'H1' });
  assert.equal(h1.disabled, true, 'keys wait for the run before the next press');
  p.bridge.finish[press.id]();
  await until(() => !h1.disabled, { what: 'keys enabled again' });

  // The lamp: a button showing its state, switching it to the other.
  const lamp = () => p.$('.outputs button');
  assert.equal(p.$('.outputs').hidden, false);
  assert.equal(lamp().textContent, 'Lamp: off');
  p.click(lamp());
  const sw = await until(() => p.bridge.runs.find((r) => r.action === 'x7.set_output'), { what: 'a set_output run' });
  assert.deepEqual(plain(sw.inputs), { output: 'lamp', on: true });
  assert.equal(lamp().disabled, true);
  p.bridge.finish[sw.id]();
  await until(() => lamp().textContent === 'Lamp: on' && !lamp().disabled, { what: 'the lamp shown on' });

  p.bridge.push({ steve: 1, event: 'event', name: 'x7.status', data: { ...IDLE, estop: true, state: 'emergency_stop' } });
  await until(() => !p.$('.banner').hidden, { what: 'the e-stop banner' });
  assert.match(p.$('.banner').textContent, /Emergency stop/);
  assert.equal(p.$('.state').textContent, 'E-stop');
  assert.match(p.$('.state').className, /bad/);
  p.bridge.push({ steve: 1, event: 'event', name: 'x7.alert', data: { kind: 'program_ended', message: 'the program ended (aborted)', at: '2026-10-16T23:58:00Z' } });
  await until(() => p.$('.message').textContent.includes('the program ended'), { what: 'the alert line' });
  assert.equal(p.$('#error').hidden, true, 'no panel errors');
});

test('panel: without a CAM program open, or actions not allowed, it says so', { skip: !JSDOM && 'jsdom not installed' }, async (t) => {
  const p = openPanel({ document: { id: 'doc_part', kind: 'part', revision: 1 }, actions: ACTIONS.map((a) => ({ ...a, allowed: false })) });
  t.after(p.close);
  await until(() => p.$('.machine .message')?.textContent.includes('Allow'), { what: 'the allow hint' });
  assert.equal(p.$('.send-card').hidden, true);
  assert.equal(p.$('.screen-card').hidden, true);
  assert.equal(p.$('.programs-card').hidden, true);
  assert.equal(p.bridge.runs.length, 0);
});
