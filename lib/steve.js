// STEVE connector protocol: Ed25519 key, RFC 9421 request signing, enrollment, tokens,
// message polling, run reports, files and events. https://stevecad.studio/docs/developers/connectors/
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function rawPublicKey(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
}

function publicKeyFromRaw(b64) {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(b64, 'base64')]),
    format: 'der',
    type: 'spki',
  });
}

// JSON with keys sorted, no spaces: the form STEVE signs envelopes and key lists in.
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

class SteveError extends Error {
  constructor(status, code, message) {
    super(`${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

class Steve {
  constructor({ baseUrl, dataDir, log }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.basePath = new URL(this.baseUrl).pathname.replace(/\/$/, '');
    this.dataDir = dataDir;
    this.log = log;
    this.token = null;
    this.tokenExpires = 0;
    this.statePath = path.join(dataDir, 'state.json');
    this.state = fs.existsSync(this.statePath)
      ? JSON.parse(fs.readFileSync(this.statePath, 'utf8'))
      : { connector: null, fingerprint: null, steve_keys: [], cursor: 0, nonces: [] };
    // Run id -> 'accepted' (we started acting on it) or 'done' (its end was reported).
    this.state.runs = Array.isArray(this.state.runs) || !this.state.runs ? {} : this.state.runs;
    this.state.steve_keys = Steve.keysFrom(this.state.steve_keys);
    this.loadKey();
  }

  // Enrollment hands over a signed key list ({list: {keys}, signatures}); keep the keys,
  // checking the list is signed by one of its own keys.
  static keysFrom(value) {
    if (Array.isArray(value)) return value;
    const keys = value?.list?.keys || value?.keys || [];
    if (value?.list && value.signatures) {
      const message = Buffer.from(canonical(value.list));
      const ok = value.signatures.some((s) => {
        const k = keys.find((x) => x.kid === s.kid);
        try { return k && crypto.verify(null, message, publicKeyFromRaw(k.public_key), Buffer.from(s.sig, 'base64')); } catch { return false; }
      });
      if (!ok) throw new Error("STEVE's key list from enrollment doesn't verify");
    }
    return keys;
  }

  saveState() {
    this.state.nonces = this.state.nonces.slice(-2000);
    const runIds = Object.keys(this.state.runs);
    for (const id of runIds.slice(0, Math.max(0, runIds.length - 1000))) delete this.state.runs[id];
    // Write a new file and rename it over the old one, so a crash mid-write can't leave broken JSON.
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.statePath);
  }

  loadKey() {
    const keyPath = path.join(this.dataDir, 'key.pem');
    if (!fs.existsSync(keyPath)) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
      this.log('made a new key pair');
    }
    this.privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
    const raw = rawPublicKey(crypto.createPublicKey(this.privateKey));
    this.publicKeyB64 = raw.toString('base64');
    this.fingerprint = 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
  }

  get enrolled() {
    return Boolean(this.state.connector);
  }

  signHeaders(method, url, body) {
    const u = new URL(url);
    const digest = 'sha-256=:' + crypto.createHash('sha256').update(body).digest('base64') + ':';
    const created = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(18).toString('base64url');
    const params = `("@method" "@path" "@query" "content-digest");created=${created};nonce="${nonce}";` +
      `keyid="${this.fingerprint}";alg="ed25519";tag="steve-connect-v1"`;
    const base = [
      `"@method": ${method.toUpperCase()}`,
      `"@path": ${u.pathname}`,
      `"@query": ${u.search || '?'}`,
      `"content-digest": ${digest}`,
      `"@signature-params": ${params}`,
    ].join('\n');
    const sig = crypto.sign(null, Buffer.from(base), this.privateKey).toString('base64');
    const headers = {
      'Content-Digest': digest,
      'Signature-Input': `steve=${params}`,
      Signature: `steve=:${sig}:`,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  // One signed request. body: object (JSON), Buffer (raw, with contentType) or undefined.
  async request(method, endpoint, { body, contentType, timeoutMs = 30000, raw = false, auth = true } = {}) {
    if (auth && this.enrolled && endpoint !== '/token') await this.ensureToken();
    const url = endpoint.startsWith('http') ? endpoint : this.baseUrl + endpoint;
    let payload = Buffer.alloc(0);
    const headers = {};
    if (Buffer.isBuffer(body)) {
      payload = body;
      headers['Content-Type'] = contentType || 'application/octet-stream';
    } else if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json';
    }
    Object.assign(headers, this.signHeaders(method, url, payload));
    const res = await fetch(url, {
      method,
      headers,
      body: payload.length || method !== 'GET' ? payload : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      let code = 'http_error', message = res.statusText;
      try {
        const j = await res.json();
        code = j.detail?.code || code;
        message = j.detail?.message || JSON.stringify(j);
      } catch {}
      if (res.status === 401 || code === 'token_invalid') this.token = null;
      throw new SteveError(res.status, code, message);
    }
    if (raw) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async enroll(code, name, version, catalog) {
    const r = await this.request('POST', '/enroll', {
      auth: false,
      body: { code, public_key: this.publicKeyB64, name, version, catalog },
    });
    this.state.connector = r.connector;
    this.state.fingerprint = r.fingerprint;
    this.state.steve_keys = Steve.keysFrom(r.steve_keys);
    this.saveState();
    if (r.fingerprint && r.fingerprint !== this.fingerprint) {
      this.log(`warning: STEVE reported fingerprint ${r.fingerprint}, ours is ${this.fingerprint}`);
    }
    return r;
  }

  async ensureToken() {
    if (this.token && Date.now() < this.tokenExpires) return;
    this.token = null;
    const r = await this.request('POST', '/token', { auth: false });
    this.token = r.token;
    this.tokenExpires = Date.now() + Math.max(60, (r.expires_in || 900) - 120) * 1000;
  }

  putCatalog(catalog) {
    return this.request('PUT', '/catalog', { body: catalog });
  }

  // Runs and cancels after the saved cursor: {messages, cursor}, where cursor is the "after" for next time.
  async messages(waitSeconds = 30) {
    const r = await this.request('GET', `/messages?after=${this.state.cursor}&wait=${waitSeconds}`, {
      timeoutMs: (waitSeconds + 20) * 1000,
    });
    return { messages: r.messages || [], cursor: typeof r.cursor === 'number' ? r.cursor : null };
  }

  // Publishes (or updates) one of the connector's panels: {title, placement, files}.
  publishPanel(name, panel) {
    return this.request('PUT', `/panels/${encodeURIComponent(name)}`, { body: panel });
  }

  advance(messageId) {
    if (messageId > this.state.cursor) {
      this.state.cursor = messageId;
      this.saveState();
    }
  }

  report(runId, state) {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}`, { body: state });
  }

  uploadFile(runId, name, buffer, contentType) {
    return this.request('PUT', `/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(name)}`, {
      body: buffer, contentType, timeoutMs: 300000,
    });
  }

  event(name, data) {
    return this.request('POST', '/events', { body: { name, data } });
  }

  // Adds keys from GET /keys only when the list is signed by a key we already trust.
  async refreshKeys() {
    const res = await fetch(this.baseUrl + '/keys', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GET /keys ${res.status}`);
    const r = await res.json();
    const message = Buffer.from(canonical(r.list));
    const ok = (r.signatures || []).some((s) => {
      const trusted = this.state.steve_keys.find((k) => k.kid === s.kid);
      try {
        return trusted && crypto.verify(null, message, publicKeyFromRaw(trusted.public_key), Buffer.from(s.sig, 'base64'));
      } catch { return false; }
    });
    if (!ok) throw new Error('the new key list is not signed by a trusted STEVE key');
    this.state.steve_keys = r.list.keys;
    this.saveState();
  }

  // Checks a run or cancel message. Returns an error string, or null when it may be acted on.
  async check(message, actionNames) {
    const env = message.envelope || {};
    let key = this.state.steve_keys.find((k) => k.kid === message.kid);
    if (!key) {
      try { await this.refreshKeys(); } catch (e) { this.log('key refresh failed:', e.message); }
      key = this.state.steve_keys.find((k) => k.kid === message.kid);
    }
    if (!key) return `untrusted signing key ${message.kid}`;
    let valid = false;
    try {
      valid = crypto.verify(null, Buffer.from(canonical(env), 'utf8'), publicKeyFromRaw(key.public_key),
        Buffer.from(message.sig, 'base64'));
    } catch {}
    if (!valid) return 'bad STEVE signature';
    if (env.connector !== this.fingerprint) return 'run is for another connector';
    if (message.kind === 'run' && !actionNames.includes(env.action)) return `unknown action ${env.action}`;
    if (message.kind === 'cancel' && !env.run) return 'cancel names no run';
    if (!env.expires_at || !(Date.parse(env.expires_at) >= Date.now())) return 'expired';
    if (!env.nonce) return 'no nonce';
    if (this.state.nonces.includes(env.nonce)) return 'replayed';
    return null;
  }

  // A run can reach us in more than one message (each freshly signed). Each run id is acted on once:
  // runState is undefined (new), 'accepted' (acting on it, or we stopped mid-run) or 'done'.
  runState(runId) {
    return this.state.runs[runId];
  }

  hasRun(runId) {
    return Boolean(this.state.runs[runId]);
  }

  rememberRun(runId, state = 'accepted') {
    if (!runId || this.state.runs[runId] === state) return;
    this.state.runs[runId] = state;
    this.saveState();
  }

  rememberNonce(nonce) {
    if (nonce) {
      this.state.nonces.push(nonce);
      this.saveState();
    }
  }

  // Downloads a STEVE document input and checks its size and SHA-256.
  async fetchInput(input) {
    let buf;
    if (input.headers && Object.keys(input.headers).length) {
      const res = await fetch(input.url, { headers: input.headers, signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`download of ${input.name} failed: ${res.status}`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      // Signed with our key and token: only ever to STEVE itself.
      if (new URL(input.url).origin !== new URL(this.baseUrl).origin) throw new Error(`${input.name}: not a STEVE download`);
      buf = await this.request('GET', input.url, { raw: true, timeoutMs: 300000 });
    }
    if (input.bytes !== undefined && buf.length !== input.bytes) throw new Error(`${input.name}: size mismatch`);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (input.sha256 && sha !== input.sha256.toLowerCase()) throw new Error(`${input.name}: SHA-256 mismatch`);
    return buf;
  }
}

module.exports = { Steve, SteveError, canonical };
