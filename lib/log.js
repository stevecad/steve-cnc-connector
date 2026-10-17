// A log to stdout and a file, kept to the current file plus one older one.
'use strict';
const fs = require('fs');

function makeLog(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  let stream = null, bytes = 0;
  const open = () => {
    try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
    if (bytes > maxBytes) {
      fs.renameSync(file, file + '.1');
      bytes = 0;
    }
    stream = fs.createWriteStream(file, { flags: 'a' });
  };
  open();
  const log = (...args) => {
    const line = `${new Date().toISOString()} ${args.join(' ')}\n`;
    process.stdout.write(line);
    stream.write(line);
    bytes += Buffer.byteLength(line);
    if (bytes > maxBytes) {
      stream.end();
      open();
    }
  };
  log.fileOnly = (text) => stream.write(`${new Date().toISOString()} ${text}\n`);
  return log;
}

module.exports = { makeLog };
