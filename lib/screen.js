// A control's remote screen over VNC (rfb2): one shared session kept open while it's used, the framebuffer as
// a PNG, and key presses. A control that asks the operator to accept each connection (the 808D's "Remote
// connection" dialog) gets confirmSeconds before any key is sent, so a key can never answer that dialog.
'use strict';
const fs = require('fs');
const os = require('os');
const { encodePng } = require('./png');

let rfb2 = null;
const loadRfb2 = () => (rfb2 = rfb2 || require('rfb2')); // an ES module: require() needs Node 22.12 or later
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAW = 0; // RFB's raw encoding: the only one the 808D sends

class RemoteScreen {
  constructor({ host, port = 5900, passwordFile, confirmSeconds = 11, idleMinutes = 15, connect, log = () => {} }) {
    Object.assign(this, { host, port, confirmSeconds, idleMinutes, log });
    this.passwordFile = passwordFile ? passwordFile.replace(/^~(?=\/|\\|$)/, os.homedir()) : null;
    this.connectFn = connect; // for tests
    this.client = null;
    this.fb = null;
    this.connectedAt = 0;
    this.opening = null;
    this.idleTimer = null;
    this.lastError = null;
  }

  get connected() {
    return Boolean(this.client);
  }

  password() {
    if (!this.passwordFile) return undefined;
    return fs.readFileSync(this.passwordFile, 'utf8').trim();
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = this.idleMinutes > 0 ? setTimeout(() => this.close('idle'), this.idleMinutes * 60000) : null;
    this.idleTimer?.unref?.();
  }

  async session() {
    this.touch();
    if (this.client) return this.client;
    if (!this.opening) {
      this.opening = (async () => {
        // The 808D closes the connection at once if asked for any pixel format but its own (16-bit RGB565).
        const options = {
          host: this.host, port: this.port, password: this.password(), timeout: 30000,
          pixelFormat: 'server', encodings: [RAW],
        };
        const lib = this.connectFn ? { connect: this.connectFn, Framebuffer: this.connectFn.Framebuffer } : loadRfb2();
        const client = await lib.connect(options);
        this.fb = lib.Framebuffer.attach(client);
        this.connectedAt = Date.now();
        this.firstFrame = client.nextUpdate();
        this.firstFrame.catch(() => {}); // a session opened for keys may close before anyone waits for it
        client.on('close', () => {
          if (this.client === client) {
            this.client = null;
            this.log('remote screen: disconnected');
          }
        });
        client.on('error', (e) => { this.lastError = e.message; });
        this.client = client;
        this.lastError = null;
        this.log(`remote screen: connected to ${client.name || this.host} (${client.width}x${client.height})`);
        return client;
      })().finally(() => { this.opening = null; });
    }
    try {
      return await this.opening;
    } catch (e) {
      this.lastError = e.message;
      throw new Error(`remote screen: ${e.message}`);
    }
  }

  // Seconds until keys may be sent on this session (the control's accept dialog is showing until then).
  get dialogSecondsLeft() {
    if (!this.client) return this.confirmSeconds;
    return Math.max(0, this.confirmSeconds - (Date.now() - this.connectedAt) / 1000);
  }

  // The current screen as a PNG. Waits briefly for changes; an unchanged screen sends nothing, so a timeout
  // just means "as it was".
  async capture({ waitMs = 1200 } = {}) {
    const client = await this.session();
    const first = this.firstFrame;
    this.firstFrame = null;
    if (first) {
      await Promise.race([first.catch(() => {}), sleep(15000)]);
    } else {
      const next = client.nextUpdate();
      client.requestUpdate(true);
      await Promise.race([next.catch(() => {}), sleep(waitMs)]);
    }
    if (!this.client) throw new Error('remote screen: the control closed the connection');
    return {
      png: encodePng(client.width, client.height, this.fb.toRgba()),
      width: client.width, height: client.height,
      dialog_seconds_left: Math.ceil(this.dialogSecondsLeft),
    };
  }

  // Presses each combo (from keys.parseKeys) in turn: all keys down in order, then up in reverse.
  async press(presses, { gapMs = 150, signal } = {}) {
    const client = await this.session();
    const wait = this.dialogSecondsLeft;
    if (wait > 0) {
      this.log(`remote screen: waiting ${Math.ceil(wait)} s for the control's accept dialog before sending keys`);
      await sleep(wait * 1000);
    }
    for (const p of presses) {
      if (signal?.aborted) throw new Error('cancelled');
      if (!this.client) throw new Error('remote screen: the control closed the connection');
      for (const sym of p.combo) client.keyEvent(sym, true);
      await sleep(40);
      for (const sym of [...p.combo].reverse()) client.keyEvent(sym, false);
      await sleep(gapMs);
    }
    this.touch();
  }

  close(reason = 'closed') {
    clearTimeout(this.idleTimer);
    const c = this.client;
    this.client = null;
    if (c) {
      this.log(`remote screen: ${reason}`);
      c.close().catch(() => {});
    }
  }
}

module.exports = { RemoteScreen };
