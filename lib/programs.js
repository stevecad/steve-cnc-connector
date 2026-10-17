// The folder a control reads programs from (the 808D's network drive is a share of this folder on the Pi).
// Lists and reads anything in it; writes only into its own subfolder, never over a different file unless asked,
// and never deletes. A written file is checked byte for byte against what STEVE sent.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

class ProgramFolder {
  // root: the shared folder. subfolder: where this connector writes (created when first needed).
  // stagingDir: on the same disk as root, for writing a file before it appears in the share.
  constructor({ root, subfolder = 'STEVE', stagingDir, maxBytes = 50 * 1024 * 1024, log = () => {} }) {
    Object.assign(this, { root: path.resolve(root), subfolder, stagingDir, maxBytes, log });
  }

  status() {
    try {
      if (!fs.statSync(this.root).isDirectory()) return { ok: false, error: `${this.root} is not a folder` };
      fs.accessSync(this.root, fs.constants.R_OK);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `${this.root}: ${e.code || e.message}` };
    }
  }

  // A path inside root, from a relative path with / separators. Refuses anything that leaves root.
  resolve(rel) {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(this.root, clean);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`${rel}: outside the program folder`);
    return full;
  }

  relative(full) {
    return path.relative(this.root, full).split(path.sep).join('/');
  }

  list({ max = 1000 } = {}) {
    const files = [];
    const walk = (dir, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.') || files.length >= max) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 6) walk(full, depth + 1); continue; }
        if (!e.isFile()) continue;
        const st = fs.statSync(full);
        files.push({ path: this.relative(full), bytes: st.size, modified: st.mtime.toISOString() });
      }
    };
    walk(this.root, 0);
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return { files, truncated: files.length >= max };
  }

  read(rel) {
    const full = this.resolve(rel);
    const st = fs.statSync(full);
    if (!st.isFile()) throw new Error(`${rel} is not a file`);
    if (st.size > this.maxBytes) throw new Error(`${rel} is ${st.size} bytes; the limit is ${this.maxBytes}`);
    return fs.readFileSync(full);
  }

  // Writes buf as <subfolder>/<name>. Returns {path, bytes, sha256, unchanged}.
  // An existing file with the same content is left as it is; a different one is replaced only with replace: true.
  write(name, buf, { replace = false } = {}) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) throw new Error(`${name}: not a safe file name`);
    const dir = this.resolve(this.subfolder);
    const full = path.join(dir, name);
    const hash = sha256(buf);
    if (fs.existsSync(full)) {
      const existing = fs.readFileSync(full);
      if (sha256(existing) === hash) return { path: this.relative(full), bytes: buf.length, sha256: hash, unchanged: true };
      if (!replace) {
        throw new Error(`${this.relative(full)} already exists with different content; choose another name, or ` +
          'replace it (never while it is selected or running at the control)');
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o777); } catch {}
    // Write it outside the share first, then move it in, so the control never sees a half-written file.
    fs.mkdirSync(this.stagingDir, { recursive: true });
    const tmp = path.join(this.stagingDir, `${process.pid}-${Date.now()}-${name}`);
    const fd = fs.openSync(tmp, 'w', 0o666);
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.chmodSync(tmp, 0o666); // readable and writable through the share's guest account
      try {
        fs.renameSync(tmp, full);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(tmp, full);
        fs.chmodSync(full, 0o666);
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const written = fs.readFileSync(full);
    if (sha256(written) !== hash) throw new Error(`${this.relative(full)}: the file on disk doesn't match what STEVE sent`);
    return { path: this.relative(full), bytes: buf.length, sha256: hash, unchanged: false };
  }
}

module.exports = { ProgramFolder, sha256 };
