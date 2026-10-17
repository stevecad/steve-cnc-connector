// Driver "folder": a machine whose control reads programs from a folder this computer can write to (the 808D's
// network drive, a Centroid or WinCNC PC's job folder, a share). Lists and reads programs, and writes programs
// STEVE posted for this machine into its own subfolder: checked, never over a different file unless asked, never
// deleting anything. It starts nothing: the operator selects and starts the program at the control.
'use strict';
const { EventEmitter } = require('events');
const path = require('path');
const { ProgramFolder } = require('../programs');

// Turns a STEVE program's file name (and revision) into a name the control accepts.
// The extension is written as configured (".mpf" like the programs already on the 808D's drive), or upper case
// with "uppercase".
function programName(rules, { name, revision, setup }, override) {
  const ext = rules.uppercase ? (rules.extension || '').toUpperCase() : rules.extension || '';
  if (override) {
    const n = String(override).trim();
    const withExt = ext && !n.toUpperCase().endsWith(ext.toUpperCase()) ? n + ext : n;
    const problem = checkName(rules, withExt);
    if (problem) throw new Error(problem);
    return rules.uppercase ? withExt.toUpperCase() : withExt;
  }
  let base = String(name || 'PROGRAM').replace(/\.[^.]*$/, '');
  if (setup) base += `_${setup}`;
  base = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'PROGRAM';
  if (!/^[A-Za-z]/.test(base)) base = 'P' + base;
  if (rules.uppercase) base = base.toUpperCase();
  const suffix = revision !== undefined && revision !== null ? `_R${revision}` : '';
  const room = (rules.max_name_length || 64) - ext.length - suffix.length;
  if (room < 1) throw new Error('max_name_length is too short for a name');
  return base.slice(0, room) + suffix + ext;
}

function checkName(rules, name) {
  const max = rules.max_name_length || 64;
  if (name.length > max) return `${name}: longer than ${max} characters`;
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9]+)?$/.test(name)) {
    return `${name}: use letters, digits and _, starting with a letter`;
  }
  const ext = rules.extension || '';
  if (ext && !name.toUpperCase().endsWith(ext.toUpperCase())) return `${name}: must end in ${ext}`;
  return null;
}

// Problems the control would have with the file itself. Returns a list of strings (empty when fine).
function checkContent(rules, buf) {
  const problems = [];
  if (!buf.length) problems.push('the program is empty');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) problems.push('it starts with a UTF-8 byte order mark');
  if (rules.ascii_only !== false) {
    const i = buf.findIndex((b) => b > 0x7E || (b < 0x20 && b !== 0x0A && b !== 0x0D && b !== 0x09));
    if (i >= 0) {
      const line = buf.subarray(0, i).toString('latin1').split('\n').length;
      problems.push(`line ${line} has a character the control may not read (byte 0x${buf[i].toString(16)}); ` +
        'controls like the 808D read plain ASCII');
    }
  }
  if (rules.max_line_length) {
    const lines = buf.toString('latin1').split(/\r?\n/);
    const long = lines.findIndex((l) => l.length > rules.max_line_length);
    if (long >= 0) problems.push(`line ${long + 1} is longer than ${rules.max_line_length} characters`);
  }
  return problems;
}

class FolderMachine extends EventEmitter {
  constructor(config, { dataDir, log }) {
    super();
    this.key = config.key;
    this.name = config.name || config.key;
    this.config = config;
    this.log = (...a) => log(`[${this.key}]`, ...a);
    const p = config.programs || {};
    if (!p.folder) throw new Error(`machine ${this.key}: programs.folder is missing`);
    this.rules = {
      extension: p.extension || '', uppercase: Boolean(p.uppercase), max_name_length: p.max_name_length || 64,
      ascii_only: p.ascii_only !== false, max_line_length: p.max_line_length || 0,
    };
    this.drive = p.drive || null; // what the control calls the folder, e.g. "N1"
    this.folder = new ProgramFolder({
      root: p.folder, subfolder: p.subfolder || 'STEVE', stagingDir: path.join(dataDir, 'staging'), log: this.log,
    });
    this.lastStatus = null;
  }

  start() {
    const check = () => {
      const s = this.summary();
      if (JSON.stringify(s) !== JSON.stringify(this.lastStatus)) {
        this.lastStatus = s;
        this.emit('status', s);
      }
    };
    check();
    this.timer = setInterval(check, 30000);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  summary() {
    const f = this.folder.status();
    return { machine: this.key, name: this.name, programs_folder: f.ok ? 'ok' : f.error, drive: this.drive };
  }

  actions() {
    const where = this.drive ? `the control's ${this.drive} drive` : 'the folder the control reads programs from';
    return [
      { name: 'programs', title: 'List programs',
        description: `Lists the programs on ${where}, newest first.`, inputs: { type: 'object', properties: {} } },
      { name: 'read_program', title: 'Read program',
        description: `Returns one program from ${where} as a file.`,
        inputs: { type: 'object', properties: { path: { type: 'string', maxLength: 300, title: 'Path',
          description: 'As listed by programs, e.g. "STEVE/BRACKET_R3.MPF"' } }, required: ['path'] } },
      { name: 'send_program', title: 'Send program',
        description: `Puts a CAM program STEVE posted for this machine on ${where}, in its ` +
          `${this.folder.subfolder} folder, checked byte for byte. It starts nothing: the person selects and starts it ` +
          'at the control. Tell them the file name, the work offset and tools the program uses, and to prove a new ' +
          'program out carefully (single block, feed override low) before cutting.',
        inputs: { type: 'object', properties: {
          program: { 'x-steve': 'program', title: 'Program' },
          name: { type: 'string', maxLength: 64, title: 'File name',
            description: `Optional; made from the program's name and revision if left out` },
          replace: { type: 'boolean', default: false, title: 'Replace',
            description: `Replace a different file of the same name in ${this.folder.subfolder} (never one that is ` +
              'selected or running at the control)' },
        }, required: ['program'] } },
    ];
  }

  get handlers() {
    return {
      programs: async () => {
        const { files, truncated } = this.folder.list();
        return { result: { files, truncated }, message: `${files.length} programs` };
      },
      read_program: async (inputs, ctx) => {
        const buf = this.folder.read(inputs.path);
        await ctx.file(path.basename(inputs.path), buf, 'text/plain');
        return { result: { path: inputs.path, bytes: buf.length }, message: `${inputs.path} (${buf.length} bytes)` };
      },
      send_program: async (inputs, ctx) => {
        const input = inputs.program;
        if (!input || input.kind !== 'file') throw new Error('no program was sent');
        if (this.config.steve_machine && input.machine && input.machine !== this.config.steve_machine) {
          throw new Error(`this program was posted for machine ${input.machine}, not ${this.config.steve_machine}`);
        }
        const name = programName(this.rules, input, inputs.name);
        await ctx.progress(0.2, 'Downloading the program');
        const buf = await ctx.input(input);
        const problems = checkContent(this.rules, buf);
        if (problems.length) throw new Error(`not sent: ${problems.join('; ')}`);
        if (ctx.signal.aborted) throw new Error('cancelled');
        const out = this.folder.write(name, buf, { replace: Boolean(inputs.replace) });
        const where = this.drive ? `${this.drive}: ${out.path}` : out.path;
        this.log(`program ${out.unchanged ? 'already there' : 'written'}: ${out.path} (${out.bytes} bytes, ` +
          `${input.document ? `document ${input.document} r${input.revision}` : 'no document'}, ${input.verification || 'unknown'})`);
        return {
          result: { ...out, drive: this.drive, verification: input.verification || null, setup: input.setup || null },
          message: out.unchanged ? `Already on ${where}` : `On ${where}: select and start it at the control`,
        };
      },
    };
  }
}

module.exports = { create: (config, ctx) => new FolderMachine(config, ctx), FolderMachine, programName, checkName, checkContent };
