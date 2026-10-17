'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Steve, canonical } = require('../lib/steve');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'steve-test-'));
const rawPub = (key) => key.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

test('canonical JSON: sorted keys, no spaces', () => {
  assert.equal(canonical({ b: 1, a: [true, null, { d: 'x', c: 2 }] }), '{"a":[true,null,{"c":2,"d":"x"}],"b":1}');
});

test("verifies STEVE's real published key list (canonical form matches STEVE's)", () => {
  const keys = Steve.keysFrom(fixture('steve-keys.json'));
  assert.equal(keys[0].kid, 'steve-1');
});

test('rejects a tampered key list', () => {
  const list = fixture('steve-keys.json');
  list.list.keys[0].kid = 'evil';
  assert.throws(() => Steve.keysFrom(list), /doesn't verify/);
});

test('makes a key pair once and derives the fingerprint from the raw public key', () => {
  const dir = tmp();
  const a = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: dir, log: () => {} });
  const b = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: dir, log: () => {} });
  assert.equal(a.fingerprint, b.fingerprint);
  const raw = Buffer.from(a.publicKeyB64, 'base64');
  assert.equal(raw.length, 32);
  assert.equal(a.fingerprint, 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, ''));
});

test('signs requests as RFC 9421 with the documented signature base', () => {
  const s = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: tmp(), log: () => {} });
  const body = Buffer.from('{"a":1}');
  const h = s.signHeaders('get', 'https://example.test/connect/v1/messages?after=41&wait=30', body);
  assert.equal(h['Content-Digest'], `sha-256=:${crypto.createHash('sha256').update(body).digest('base64')}:`);
  const params = h['Signature-Input'].replace(/^steve=/, '');
  assert.match(params, /^\("@method" "@path" "@query" "content-digest"\);created=\d+;nonce="[A-Za-z0-9_-]{16,64}";keyid="SHA256:[^"]+";alg="ed25519";tag="steve-connect-v1"$/);
  const base = ['"@method": GET', '"@path": /connect/v1/messages', '"@query": ?after=41&wait=30',
    `"content-digest": ${h['Content-Digest']}`, `"@signature-params": ${params}`].join('\n');
  const sig = Buffer.from(h.Signature.match(/^steve=:(.*):$/)[1], 'base64');
  assert.ok(crypto.verify(null, Buffer.from(base), crypto.createPublicKey(s.privateKey), sig));
  const noQuery = s.signHeaders('POST', 'https://example.test/connect/v1/token', Buffer.alloc(0));
  assert.ok(noQuery['Signature-Input'].length > 0);
});

// A STEVE stand-in that signs run envelopes with its own key.
function setup() {
  const steveKey = crypto.generateKeyPairSync('ed25519');
  const s = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: tmp(), log: () => {} });
  s.state.steve_keys = [{ kid: 'k1', public_key: rawPub(steveKey.publicKey) }];
  const message = (envelope, kid = 'k1', key = steveKey.privateKey) => ({
    id: 1, kind: 'run', kid, envelope,
    sig: crypto.sign(null, Buffer.from(canonical(envelope)), key).toString('base64'),
  });
  const envelope = (over = {}) => ({
    id: 'run_1', action: 'status', inputs: {}, note: null, requested_by: { kind: 'person' }, confirmed_by: null,
    connector: s.fingerprint, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
    nonce: crypto.randomUUID(), ...over,
  });
  s.refreshKeys = async () => { throw new Error('offline'); };
  return { s, message, envelope };
}

test('accepts a run signed by a trusted STEVE key', async () => {
  const { s, message, envelope } = setup();
  assert.equal(await s.check(message(envelope()), ['status']), null);
});

test('refuses runs that fail any check', async () => {
  const { s, message, envelope } = setup();
  const other = crypto.generateKeyPairSync('ed25519');
  const e = envelope();
  const tampered = message(e);
  tampered.envelope = { ...e, action: 'stop' };
  assert.match(await s.check(tampered, ['status', 'stop']), /bad STEVE signature/);
  assert.match(await s.check(message(envelope(), 'k1', other.privateKey), ['status']), /bad STEVE signature/);
  assert.match(await s.check(message(envelope(), 'k2'), ['status']), /untrusted signing key/);
  assert.match(await s.check(message(envelope({ connector: 'SHA256:someone-else' })), ['status']), /another connector/);
  assert.match(await s.check(message(envelope({ action: 'format_disk' })), ['status']), /unknown action/);
  assert.match(await s.check(message(envelope({ expires_at: new Date(Date.now() - 1000).toISOString() })), ['status']), /expired/);
  assert.match(await s.check(message(envelope({ expires_at: undefined })), ['status']), /expired/, 'no expiry is not "never expires"');
  assert.match(await s.check(message(envelope({ nonce: undefined })), ['status']), /no nonce/);
  const seen = envelope();
  s.rememberNonce(seen.nonce);
  assert.match(await s.check(message(seen), ['status']), /replayed/);
});

test('remembers handled runs, across restarts', () => {
  const dir = tmp();
  const a = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: dir, log: () => {} });
  assert.equal(a.hasRun('run_1'), false);
  a.rememberRun('run_1');
  assert.equal(a.hasRun('run_1'), true);
  const b = new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: dir, log: () => {} });
  assert.equal(b.hasRun('run_1'), true, 'a restart does not forget a run it already acted on');
  assert.equal(b.runState('run_1'), 'accepted');
  b.rememberRun('run_1', 'done');
  assert.equal(new Steve({ baseUrl: 'https://example.test/connect/v1', dataDir: dir, log: () => {} }).runState('run_1'), 'done');
  assert.ok(!fs.existsSync(path.join(dir, 'state.json.tmp')), 'state is written through a temp file that is renamed away');
});
