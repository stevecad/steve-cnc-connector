// Builds the panel the connector publishes to STEVE (PUT /connect/v1/panels/{name}) from the files in panel/.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TEXT = /\.(html|js|css|svg|json|txt|md)$/i;
const LIMITS = { files: 50, bytes: 2 * 1024 * 1024 };

// {title, placement, files}: text files as text, anything else as "base64:<data>". Returns it with a hash of its
// content, so an unchanged panel isn't published again (which would reload the person's open tab).
function buildPanel(dir, { title, placement = ['right'] }) {
  const files = {};
  let bytes = 0;
  const walk = (sub) => {
    for (const entry of fs.readdirSync(path.join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(rel); continue; }
      const buf = fs.readFileSync(path.join(dir, rel));
      bytes += buf.length;
      files[rel] = TEXT.test(entry.name) ? buf.toString('utf8') : 'base64:' + buf.toString('base64');
    }
  };
  walk('');
  if (!files['index.html']) throw new Error(`no index.html in ${dir}`);
  const count = Object.keys(files).length;
  if (count > LIMITS.files) throw new Error(`the panel has ${count} files; STEVE takes at most ${LIMITS.files}`);
  if (bytes > LIMITS.bytes) throw new Error(`the panel is ${bytes} bytes; STEVE takes at most ${LIMITS.bytes}`);
  const panel = { title, placement, files };
  const hash = crypto.createHash('sha256').update(JSON.stringify(panel)).digest('hex');
  return { panel, hash };
}

module.exports = { buildPanel };
