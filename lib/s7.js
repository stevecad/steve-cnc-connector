// A small S7 client (ISO-on-TCP, port 102) for reading a PLC: inputs, outputs, flags and data blocks.
// Its one write, writeBit, sets a single bit; the drivers use it only for the outputs the owner listed in the config.
// One request at a time, each with a timeout.
'use strict';
const net = require('net');

const AREAS = { I: 0x81, Q: 0x82, M: 0x83, DB: 0x84 };
const READ_VAR = 0x04, WRITE_VAR = 0x05;

// "DB3300.DBX4.7", "DB3300.DBB3", "Q2.4", "I0", "M10.1", "QB2" -> {area, db, byte, bit}
function parseAddress(text) {
  const s = String(text).trim().toUpperCase();
  let m = s.match(/^DB(\d+)\.DB([XB])(\d+)(?:\.([0-7]))?$/);
  if (m) {
    if (m[2] === 'X' && m[4] === undefined) throw new Error(`${text}: a bit address needs .0 to .7`);
    return { area: 'DB', db: Number(m[1]), byte: Number(m[3]), bit: m[2] === 'X' ? Number(m[4]) : null };
  }
  m = s.match(/^([IQM])B?(\d+)(?:\.([0-7]))?$/);
  if (m) return { area: m[1], db: 0, byte: Number(m[2]), bit: m[3] === undefined ? null : Number(m[3]) };
  throw new Error(`${text}: not an address like DB3300.DBX4.7, DB3300.DBB3, Q2.4 or IB0`);
}

// "IB0-3 DB3300.DBX4.7, Q2.4" -> ["IB0", "IB1", "IB2", "IB3", "DB3300.DBX4.7", "Q2.4"]: byte ranges are written
// first-last. Every address is checked before anything is read.
function expandAddresses(text, { max = 256 } = {}) {
  const out = [];
  for (const token of String(text || '').split(/[\s,;]+/).filter(Boolean)) {
    const range = token.toUpperCase().match(/^(DB\d+\.DBB|[IQM]B)(\d+)-(\d+)$/);
    if (range) {
      const [first, last] = [Number(range[2]), Number(range[3])];
      if (last < first) throw new Error(`${token}: the range runs backwards`);
      if (last - first >= max) throw new Error(`${token}: more than ${max} addresses`);
      for (let b = first; b <= last; b++) out.push(`${range[1]}${b}`);
    } else {
      parseAddress(token);
      out.push(token.toUpperCase());
    }
    if (out.length > max) throw new Error(`more than ${max} addresses`);
  }
  return out;
}

function tpkt(payload) {
  const head = Buffer.from([3, 0, 0, 0]);
  head.writeUInt16BE(payload.length + 4, 2);
  return Buffer.concat([head, payload]);
}

class S7 {
  constructor({ host, port = 102, rack = 0, slot = 2, timeoutMs = 3000 }) {
    Object.assign(this, { host, port, rack, slot, timeoutMs });
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiting = null; // {resolve, reject, timer}
    this.queue = Promise.resolve();
    this.pduRef = 1;
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed && this.ready);
  }

  close() {
    this.ready = false;
    if (this.socket) this.socket.destroy();
    this.socket = null;
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      this.waiting.reject(new Error('PLC connection closed'));
      this.waiting = null;
    }
  }

  // Sends one TPKT and waits for the next one back.
  exchange(payload) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('not connected to the PLC'));
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('PLC did not answer in time'));
        this.close();
      }, this.timeoutMs);
      this.waiting = { resolve, reject, timer };
      this.socket.write(tpkt(payload));
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const n = this.buffer.readUInt16BE(2);
      if (n < 4 || this.buffer[0] !== 3) { this.close(); return; }
      if (this.buffer.length < n) return;
      const body = this.buffer.subarray(4, n);
      this.buffer = this.buffer.subarray(n);
      const w = this.waiting;
      this.waiting = null;
      if (w) { clearTimeout(w.timer); w.resolve(body); }
    }
  }

  async connect() {
    this.close();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const fail = (e) => { socket.destroy(); reject(e); };
      socket.setTimeout(this.timeoutMs, () => fail(new Error(`no answer from the PLC at ${this.host}:${this.port}`)));
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.setTimeout(0);
        socket.removeListener('error', fail);
        socket.on('error', () => this.close());
        socket.on('close', () => { if (this.socket === socket) this.close(); });
        socket.on('data', (c) => this.onData(c));
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        resolve();
      });
    });
    // COTP connection request: our TSAP 0x0100, the PLC's 0x01 (rack*32 + slot).
    const cr = await this.exchange(Buffer.from([0x11, 0xE0, 0, 0, 0, 1, 0, 0xC0, 1, 0x0A, 0xC1, 2, 0x01, 0x00,
      0xC2, 2, 0x01, this.rack * 32 + this.slot]));
    if (cr[1] !== 0xD0) { this.close(); throw new Error('the PLC refused the connection'); }
    const setup = await this.exchange(Buffer.from([2, 0xF0, 0x80, 0x32, 1, 0, 0, 0, 1, 0, 8, 0, 0,
      0xF0, 0, 0, 1, 0, 1, 0x01, 0xE0]));
    if (setup[3] !== 0x32 || setup[4] !== 3 || setup.readUInt16BE(13) !== 0) {
      this.close();
      throw new Error('the PLC refused S7 communication');
    }
    this.pdu = setup.readUInt16BE(setup.length - 2);
    this.ready = true;
  }

  // Runs one request after the one before it, so only one is in flight.
  enqueue(run) {
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // One S7 job (read or write variable): its parameters and data, and the reply with the S7 header checked.
  async job(param, data = Buffer.alloc(0)) {
    if (!this.connected) await this.connect();
    const head = Buffer.from([2, 0xF0, 0x80, 0x32, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    head.writeUInt16BE((this.pduRef = (this.pduRef % 65535) + 1), 7);
    head.writeUInt16BE(param.length, 9);
    head.writeUInt16BE(data.length, 11);
    const r = (await this.exchange(Buffer.concat([head, param, data]))).subarray(3);
    if (r[0] !== 0x32 || r[1] !== 3) throw new Error('unexpected PLC reply');
    if (r[10] || r[11]) throw new Error(`PLC error class ${r[10]} code ${r[11]}`);
    return r.subarray(14);
  }

  // The 12-byte item that addresses a variable: transport size, count, data block, area, bit address.
  static item(area, db, bitAddress, size, count) {
    const code = AREAS[area];
    if (!code) throw new Error(`unknown area ${area}`);
    const item = Buffer.alloc(12);
    item.set([0x12, 0x0A, 0x10, size]);
    item.writeUInt16BE(count, 4);
    item.writeUInt16BE(db, 6);
    item[8] = code;
    item.writeUIntBE(bitAddress, 9, 3);
    return item;
  }

  // Reads count bytes from an area.
  read(area, db, start, count) {
    return this.enqueue(async () => {
      const item = S7.item(area, db, start * 8, 0x02, count);
      const data = await this.job(Buffer.concat([Buffer.from([READ_VAR, 1]), item]));
      if (data[0] !== 0xFF) throw new Error(`PLC refused reading ${area}${db ? db : ''} at ${start} (code ${data[0]})`);
      const n = data[1] === 0x04 ? data.readUInt16BE(2) / 8 : data.readUInt16BE(2);
      return Buffer.from(data.subarray(4, 4 + n));
    });
  }

  // Writes one bit ("Q2.2") to true or false: the only write this client makes.
  writeBit(text, value) {
    const a = parseAddress(text);
    if (a.bit === null) throw new Error(`${text}: only single bits are written`);
    return this.enqueue(async () => {
      const item = S7.item(a.area, a.db, a.byte * 8 + a.bit, 0x01, 1);
      const data = await this.job(Buffer.concat([Buffer.from([WRITE_VAR, 1]), item]), Buffer.from([0, 0x03, 0, 1, value ? 1 : 0]));
      if (data[0] !== 0xFF) throw new Error(`PLC refused writing ${text} (code ${data[0]})`);
    });
  }

  // Reads a named address: a bit as true/false, a byte as a number.
  async readAddress(text) {
    const a = parseAddress(text);
    const [b] = await this.read(a.area, a.db, a.byte, 1);
    return a.bit === null ? b : Boolean(b & (1 << a.bit));
  }

  // Reads many addresses with as few requests as it can: one per area or data block, covering the bytes asked for.
  // Returns a Map from each address as given to its value (a bit as true/false, a byte as a number).
  async readAddresses(list, { maxSpan = 200 } = {}) {
    const groups = new Map();
    for (const text of list) {
      const a = { text, ...parseAddress(text) };
      const key = `${a.area}${a.db}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const out = new Map();
    for (const items of groups.values()) {
      items.sort((x, y) => x.byte - y.byte);
      for (let i = 0; i < items.length;) {
        const start = items[i].byte;
        let j = i;
        while (j + 1 < items.length && items[j + 1].byte - start < maxSpan) j++;
        const count = items[j].byte - start + 1;
        const buf = await this.read(items[i].area, items[i].db, start, count);
        if (buf.length < count) throw new Error(`the PLC sent ${buf.length} of ${count} bytes from ${items[i].text}`);
        for (const a of items.slice(i, j + 1)) {
          const b = buf[a.byte - start];
          out.set(a.text, a.bit === null ? b : Boolean(b & (1 << a.bit)));
        }
        i = j + 1;
      }
    }
    return out;
  }
}

module.exports = { S7, parseAddress, expandAddresses, AREAS };
