// Shared test helpers: a fake S7 PLC (sized like the 808D: I0-I8, Q0-Q5) and a fake VNC client.
'use strict';
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { parseAddress } = require('../lib/s7');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'steve-cnc-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Waits until check() returns something truthy.
async function until(check, { timeoutMs = 5000, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

// The Syil's 808D at rest, as read on 2026-10-16: AUTO, channel reset, program aborted, referenced, drives ready.
function idle808d(plc) {
  plc.set('DB3100.DBB0', 0b00001001); // AUTO, 808D ready
  plc.set('DB3300.DBB3', 0b10010000); // channel reset, program aborted
  plc.set('DB3300.DBB4', 0b00101100); // referenced, stationary, channel operational
  plc.set('DB2700.DBB2', 0b11100000); // NC ready, drives ready, drives cyclic
}

// A PLC answering S7 reads and bit writes. Records every request's function code (0x05 is a write) and each write.
// plc.hold = {"Q2.2": false} plays a PLC program that sets that bit itself, putting it back 50 ms after a write.
async function fakePlc() {
  const memory = {
    I: Buffer.alloc(9), Q: Buffer.alloc(6), M: Buffer.alloc(16),
    DB: { 2700: Buffer.alloc(8), 3100: Buffer.alloc(8), 3200: Buffer.alloc(16), 3300: Buffer.alloc(8) },
  };
  const AREA = { 0x81: 'I', 0x82: 'Q', 0x83: 'M', 0x84: 'DB' };
  const plc = { functions: [], reads: [], written: [], hold: {}, sockets: new Set(), silent: false };
  const area = (a, db) => (a === 'DB' ? memory.DB[db] : memory[a]);
  plc.set = (address, value) => {
    const a = parseAddress(address);
    const buf = area(a.area, a.db);
    if (a.bit === null) buf[a.byte] = value;
    else buf[a.byte] = value ? buf[a.byte] | (1 << a.bit) : buf[a.byte] & ~(1 << a.bit);
  };
  const reply = (socket, body) => {
    const head = Buffer.from([3, 0, 0, 0]);
    head.writeUInt16BE(body.length + 4, 2);
    socket.write(Buffer.concat([head, body]));
  };
  const server = net.createServer((socket) => {
    plc.sockets.add(socket);
    socket.on('close', () => plc.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt16BE(2)) {
        const n = buffer.readUInt16BE(2);
        const body = buffer.subarray(4, n);
        buffer = buffer.subarray(n);
        if (plc.silent) continue;
        if (body[1] === 0xE0) { // COTP connection request
          reply(socket, Buffer.from([0x11, 0xD0, 0, 1, 0, 1, 0, 0xC0, 1, 0x0A, 0xC1, 2, 1, 0, 0xC2, 2, 1, 2]));
          continue;
        }
        const s7 = body.subarray(3);
        const ref = s7.readUInt16BE(4);
        const fn = s7[10];
        plc.functions.push(fn);
        const head = (paramLen, dataLen) => {
          const h = Buffer.from([2, 0xF0, 0x80, 0x32, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
          h.writeUInt16BE(ref, 7);
          h.writeUInt16BE(paramLen, 9);
          h.writeUInt16BE(dataLen, 11);
          return h;
        };
        if (fn === 0xF0) {
          reply(socket, Buffer.concat([head(8, 0), Buffer.from([0xF0, 0, 0, 1, 0, 1, 0x01, 0xE0])]));
        } else if (fn === 0x04) {
          const item = s7.subarray(12, 24);
          const count = item.readUInt16BE(4), db = item.readUInt16BE(6), code = item[8];
          const start = item.readUIntBE(9, 3) / 8;
          const buf = area(AREA[code], db);
          plc.reads.push({ area: AREA[code], db, start, count });
          let data;
          if (!buf || start + count > buf.length) {
            data = Buffer.from([0x0A, 0, 0, 0]); // object does not exist
          } else {
            data = Buffer.concat([Buffer.from([0xFF, 0x04, 0, 0]), buf.subarray(start, start + count)]);
            data.writeUInt16BE(count * 8, 2);
          }
          reply(socket, Buffer.concat([head(2, data.length), Buffer.from([0x04, 1]), data]));
        } else if (fn === 0x05) {
          const item = s7.subarray(12, 24);
          const db = item.readUInt16BE(6), a = AREA[item[8]], bitAddress = item.readUIntBE(9, 3);
          const byte = bitAddress >> 3, bit = bitAddress & 7;
          const address = a === 'DB' ? `DB${db}.DBX${byte}.${bit}` : `${a}${byte}.${bit}`;
          const buf = area(a, db);
          let code = 0x0A;
          if (item[3] === 0x01 && s7[25] === 0x03 && buf && byte < buf.length) {
            plc.written.push({ address, value: Boolean(s7[28]) });
            plc.set(address, Boolean(s7[28]));
            if (address in plc.hold) setTimeout(() => plc.set(address, plc.hold[address]), 50);
            code = 0xFF;
          }
          reply(socket, Buffer.concat([head(2, 1), Buffer.from([0x05, 1, code])]));
        } else {
          const h = head(0, 0);
          h[13] = 0x85; // anything else, a write included, is refused
          reply(socket, h);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  plc.port = server.address().port;
  plc.writes = () => plc.functions.filter((f) => f === 0x05).length;
  plc.close = () => {
    for (const s of plc.sockets) s.destroy();
    return new Promise((r) => server.close(r));
  };
  return plc;
}

// A VNC client like rfb2's, for lib/screen.js: a tiny grey screen, recording the keys it is sent.
function fakeVnc({ firstFrame = true } = {}) {
  const vnc = { keys: [], connects: 0, clients: [] };
  const connect = async (options) => {
    vnc.connects++;
    vnc.options = options;
    const c = new EventEmitter();
    Object.assign(c, { width: 4, height: 2, name: 'fake 808D' });
    const waiters = [];
    c.nextUpdate = () => new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    const update = () => setImmediate(() => { for (const w of waiters.splice(0)) w.resolve({ rects: [] }); });
    c.requestUpdate = update;
    c.keyEvent = (sym, down) => vnc.keys.push([sym, down]);
    c.close = async () => {
      for (const w of waiters.splice(0)) w.reject(new Error('closed'));
      c.emit('close', false);
    };
    if (firstFrame) update(); // the first full screen, as rfb2 asks for it on connecting
    vnc.clients.push(c);
    return c;
  };
  connect.Framebuffer = { attach: (c) => ({ toRgba: () => Buffer.alloc(c.width * c.height * 4, 0x80) }) };
  vnc.connect = connect;
  return vnc;
}

module.exports = { tmp, sleep, until, fakePlc, fakeVnc, idle808d };
