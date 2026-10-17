'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { parseKeys, KEYSYMS } = require('../lib/keys');
const { encodePng, crc32 } = require('../lib/png');
const { RemoteScreen } = require('../lib/screen');
const { fakeVnc } = require('./helpers');

test('key names: softkeys, areas, combos and typed text', () => {
  const k = (text) => parseKeys(text).map((p) => p.combo);
  assert.deepEqual(k('H1 V8'), [[KEYSYMS.F1], [KEYSYMS.SHIFT, KEYSYMS.F8]]);
  assert.deepEqual(k('INPUT SYSTEM'), [[KEYSYMS.RETURN], [KEYSYMS.ALT, 'n'.charCodeAt(0)]]);
  assert.deepEqual(k('PROGRAM_MANAGER MACHINE OFFSET PROGRAM'),
    [[KEYSYMS.ALT, 0x62], [KEYSYMS.ALT, 0x78], [KEYSYMS.ALT, 0x63], [KEYSYMS.ALT, 0x76]]);
  assert.deepEqual(k('alt+x SHIFT+A'), [[KEYSYMS.ALT, 0x78], [KEYSYMS.SHIFT, 0x41]], 'Alt+letter goes lower case');
  assert.deepEqual(k('"G54 X1"'), [..."G54 X1"].map((c) => [c.charCodeAt(0)]));
  assert.deepEqual(parseKeys('down').map((p) => p.label), ['DOWN']);
});

test('unknown keys and too many presses are refused before anything is sent', () => {
  assert.throws(() => parseKeys('H1 CYCLE_START'), /unknown key "CYCLE_START"/);
  assert.throws(() => parseKeys('"Ä"'), /only plain ASCII/);
  assert.throws(() => parseKeys('"' + 'x'.repeat(201) + '"'), /at most 200/);
});

test('PNG: valid signature, chunk CRCs and pixels', () => {
  const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 9, 9, 255]);
  const png = encodePng(2, 2, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const chunks = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString('latin1');
    assert.equal(png.readUInt32BE(o + 8 + len), crc32(png.subarray(o + 4, o + 8 + len)), `${type} CRC`);
    chunks.push({ type, data: png.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.deepEqual([...zlib.inflateSync(chunks[1].data)], [0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 9, 9, 9]);
});

test('screen: asks for the server pixel format and raw only, keeps one session', async () => {
  const vnc = fakeVnc();
  const s = new RemoteScreen({ host: '192.0.2.2', confirmSeconds: 0, idleMinutes: 0, connect: vnc.connect });
  const a = await s.capture();
  assert.equal(vnc.options.pixelFormat, 'server');
  assert.deepEqual(vnc.options.encodings, [0]);
  assert.equal(a.width, 4);
  assert.equal(a.png.subarray(1, 4).toString(), 'PNG');
  await s.capture({ waitMs: 50 });
  assert.equal(vnc.connects, 1, 'the second look reuses the session');
  s.close();
});

test("screen: no key is sent while the control's accept dialog may be showing", async () => {
  const vnc = fakeVnc();
  const s = new RemoteScreen({ host: '192.0.2.2', confirmSeconds: 0.3, idleMinutes: 0, connect: vnc.connect });
  const t0 = Date.now();
  await s.press(parseKeys('H1'), { gapMs: 0 });
  assert.ok(Date.now() - t0 >= 290, 'waited for the dialog');
  assert.deepEqual(vnc.keys, [[KEYSYMS.F1, true], [KEYSYMS.F1, false]]);
  vnc.keys.length = 0;
  const t1 = Date.now();
  await s.press(parseKeys('ALT+N'), { gapMs: 0 });
  assert.ok(Date.now() - t1 < 250, 'the same session does not wait again');
  assert.deepEqual(vnc.keys, [[KEYSYMS.ALT, true], [0x6E, true], [0x6E, false], [KEYSYMS.ALT, false]]);
  s.close();
});

test('screen: a session opened for keys that then closes does not crash the process', async () => {
  const vnc = fakeVnc({ firstFrame: false });
  const s = new RemoteScreen({ host: '192.0.2.2', confirmSeconds: 0, idleMinutes: 0, connect: vnc.connect });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const client = await s.session(); // its first frame is still on the way, and nobody waits for it
    await client.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(s.connected, false);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  s.close();
});

test('screen: a cancelled run stops between keys', async () => {
  const vnc = fakeVnc();
  const s = new RemoteScreen({ host: '192.0.2.2', confirmSeconds: 0, idleMinutes: 0, connect: vnc.connect });
  const c = new AbortController();
  c.abort();
  await assert.rejects(s.press(parseKeys('H1 H2'), { signal: c.signal }), /cancelled/);
  assert.equal(vnc.keys.length, 0);
  s.close();
});
