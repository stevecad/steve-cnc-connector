'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { S7, parseAddress, expandAddresses } = require('../lib/s7');
const { fakePlc } = require('./helpers');

test('parses PLC addresses', () => {
  assert.deepEqual(parseAddress('DB3300.DBX4.7'), { area: 'DB', db: 3300, byte: 4, bit: 7 });
  assert.deepEqual(parseAddress('db3300.dbb3'), { area: 'DB', db: 3300, byte: 3, bit: null });
  assert.deepEqual(parseAddress('Q2.4'), { area: 'Q', db: 0, byte: 2, bit: 4 });
  assert.deepEqual(parseAddress('IB0'), { area: 'I', db: 0, byte: 0, bit: null });
  assert.throws(() => parseAddress('DB3300.DBX4'), /needs .0 to .7/);
  assert.throws(() => parseAddress('Q2.8'), /not an address/);
  assert.throws(() => parseAddress('DB1.DBW0'), /not an address/);
});

test('expands byte ranges and checks every address first', () => {
  assert.deepEqual(expandAddresses('IB0-2, Q2.4;DB3300.DBB3-4'),
    ['IB0', 'IB1', 'IB2', 'Q2.4', 'DB3300.DBB3', 'DB3300.DBB4']);
  assert.throws(() => expandAddresses('IB3-1'), /backwards/);
  assert.throws(() => expandAddresses('IB0 nonsense'), /not an address/);
  assert.throws(() => expandAddresses('MB0-999'), /more than/);
});

test('reads bits and bytes, one request per data block', async (t) => {
  const plc = await fakePlc();
  const s7 = new S7({ host: '127.0.0.1', port: plc.port });
  t.after(() => { s7.close(); return plc.close(); });
  plc.set('DB3300.DBB3', 0b10010000);
  plc.set('Q2.4', true);
  plc.set('IB8', 200);
  assert.equal(await s7.readAddress('DB3300.DBX3.7'), true);
  assert.equal(await s7.readAddress('DB3300.DBX3.0'), false);
  plc.reads.length = 0;
  const v = await s7.readAddresses(['DB3300.DBX3.7', 'DB3300.DBX3.4', 'DB3300.DBX4.2', 'Q2.4', 'IB8']);
  assert.deepEqual([...v], [['DB3300.DBX3.7', true], ['DB3300.DBX3.4', true], ['DB3300.DBX4.2', false],
    ['Q2.4', true], ['IB8', 200]]);
  assert.deepEqual(plc.reads, [
    { area: 'DB', db: 3300, start: 3, count: 2 }, { area: 'Q', db: 0, start: 2, count: 1 }, { area: 'I', db: 0, start: 8, count: 1 },
  ]);
});

test('reports what the PLC refuses, and stays connected', async (t) => {
  const plc = await fakePlc();
  const s7 = new S7({ host: '127.0.0.1', port: plc.port });
  t.after(() => { s7.close(); return plc.close(); });
  await assert.rejects(s7.readAddresses(['IB0', 'IB15']), /refused reading I at 0 \(code 10\)/);
  assert.equal(s7.connected, true);
  assert.equal(await s7.readAddress('IB0'), 0);
});

test('a PLC that stops answering times out instead of hanging', async (t) => {
  const plc = await fakePlc();
  const s7 = new S7({ host: '127.0.0.1', port: plc.port, timeoutMs: 200 });
  t.after(() => { s7.close(); return plc.close(); });
  await s7.readAddress('IB0');
  plc.silent = true;
  await assert.rejects(s7.readAddress('IB0'), /did not answer in time/);
  assert.equal(s7.connected, false);
});

test('reading never writes; writeBit writes exactly one bit', async (t) => {
  const plc = await fakePlc();
  const s7 = new S7({ host: '127.0.0.1', port: plc.port });
  t.after(() => { s7.close(); return plc.close(); });
  await s7.readAddresses(['IB0', 'QB0', 'MB0', 'DB3100.DBB0', 'DB3300.DBB3']);
  await s7.readAddress('Q2.2');
  assert.ok(plc.functions.length > 0);
  assert.equal(plc.writes(), 0, 'no write request while reading');
  plc.set('QB2', 0b00010000);
  await s7.writeBit('Q2.2', true);
  assert.deepEqual(plc.written, [{ address: 'Q2.2', value: true }]);
  assert.equal(await s7.readAddress('QB2'), 0b00010100, 'only that bit changed');
  await s7.writeBit('q2.2', false);
  assert.equal(await s7.readAddress('QB2'), 0b00010000);
  assert.throws(() => s7.writeBit('QB2', 1), /only single bits/);
  await assert.rejects(s7.writeBit('Q9.0', true), /refused writing Q9.0 \(code 10\)/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 's7.js'), 'utf8');
  assert.equal(source.match(/WRITE_VAR/g).length, 2, 'one write request in the client: writeBit');
});
