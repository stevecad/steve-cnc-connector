// Driver "sinumerik808d": a SIEMENS SINUMERIK 808D (the Syil X7's control), through the computer wired to it.
// - Programs: the control's network drive is a folder on this computer (the "folder" driver's actions).
// - State: read from the PLC over S7 once a second, as the status event, with alerts when a program starts or
//   ends, an alarm comes or the emergency stop is pressed.
// - Outputs: the only PLC writes, and only for bits the owner listed in plc.outputs (e.g. the work lamp); none
//   by default.
// - Screen: the HMI over VNC, to look at, and to press its keys when the person allows it.
// Nothing here can start a program, move an axis or turn the spindle: cycle start, feed hold, jog and the spindle
// are on the machine control panel, a separate USB device only the person at the machine can reach.
'use strict';
const { FolderMachine } = require('./folder');
const { S7, expandAddresses, parseAddress } = require('../s7');
const { RemoteScreen } = require('../screen');
const { parseKeys } = require('../keys');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PLC signals, each checked on a Syil X7 (see docs/sinumerik-808d.md). config.plc.signals adds more by name
// (e.g. "door_closed": "I1.3" once found) or leaves one out ("door_locked": null).
const SIGNALS = {
  auto: 'DB3100.DBX0.0', mda: 'DB3100.DBX0.1', jog: 'DB3100.DBX0.2', control_ready: 'DB3100.DBX0.3',
  ref: 'DB3100.DBX1.2',
  program_running: 'DB3300.DBX3.0', program_waiting: 'DB3300.DBX3.1', program_stopped: 'DB3300.DBX3.2',
  program_interrupted: 'DB3300.DBX3.3', program_aborted: 'DB3300.DBX3.4',
  channel_active: 'DB3300.DBX3.5', channel_interrupted: 'DB3300.DBX3.6', channel_reset: 'DB3300.DBX3.7',
  referenced: 'DB3300.DBX4.2', stationary: 'DB3300.DBX4.3', channel_operational: 'DB3300.DBX4.5',
  channel_alarm: 'DB3300.DBX4.6', alarm_stop: 'DB3300.DBX4.7',
  estop: 'DB2700.DBX0.1', drives_cyclic: 'DB2700.DBX2.5', drives_ready: 'DB2700.DBX2.6', nc_ready: 'DB2700.DBX2.7',
  nck_alarm: 'DB2700.DBX3.0',
  // The door (2026-10-17, read closed and locked, closed and unlocked, open): Q2.4 on when locked, I4.7 (likely the
  // lock's own switch) on while it is released, I4.6 on while the door is open.
  door_locked: 'Q2.4', lock_released: 'I4.7', door_open: 'I4.6',
};

const ACTIVE = ['running', 'stopped', 'waiting', 'interrupted']; // a program is under way
const PROGRAM = ['running', 'waiting', 'stopped', 'interrupted', 'aborted'];
const CHANNEL = ['reset', 'interrupted', 'active'];

// The machine's state from the signals' values ({name: value}).
function describe(v) {
  const mode = v.auto ? 'AUTO' : v.mda ? 'MDA' : v.jog ? (v.ref ? 'JOG REF' : 'JOG') : null;
  const program = PROGRAM.find((p) => v[`program_${p}`]) || null;
  const alarm = Boolean(v.channel_alarm || v.nck_alarm);
  let state = 'idle';
  if (v.estop) state = 'emergency_stop';
  else if (ACTIVE.includes(program)) state = program;
  else if (alarm) state = 'alarm';
  const out = {
    state, mode, program, channel: CHANNEL.find((c) => v[`channel_${c}`]) || null,
    alarm, alarm_stop: Boolean(v.alarm_stop), estop: Boolean(v.estop),
    referenced: Boolean(v.referenced), stationary: Boolean(v.stationary),
    ready: Boolean(v.control_ready && v.nc_ready && v.drives_ready && v.channel_operational),
    drives: v.drives_ready ? (v.drives_cyclic ? 'ready' : 'ready, not cyclic') : 'not ready',
  };
  if ('door_open' in v) out.door_open = Boolean(v.door_open);
  if ('door_locked' in v) out.door_locked = Boolean(v.door_locked);
  if ('lock_released' in v) out.lock_released = Boolean(v.lock_released);
  return out;
}

// What changed between two states that someone should hear about. The first reading after starting says nothing:
// a program found running then didn't just start.
function alertsBetween(prev, next) {
  if (!prev || prev.state === 'connecting') return [];
  if (prev.state === 'offline' || next.state === 'offline') {
    if (prev.state === next.state) return [];
    return [next.state === 'offline'
      ? { kind: 'offline', message: `lost the connection to the control's PLC: ${next.plc_error}` }
      : { kind: 'online', message: 'connected to the control again' }];
  }
  const out = [];
  if (!prev.estop && next.estop) out.push({ kind: 'emergency_stop', message: 'emergency stop pressed' });
  if (prev.estop && !next.estop) out.push({ kind: 'emergency_stop_released', message: 'emergency stop released' });
  if (ACTIVE.includes(prev.state) && !ACTIVE.includes(next.state)) {
    out.push({ kind: 'program_ended', message: `the program ended (${next.program || 'no program state'})`, was: prev.state });
  } else if (next.state === 'running' && prev.state !== 'running') {
    out.push(ACTIVE.includes(prev.state)
      ? { kind: 'program_resumed', message: 'the program carries on' }
      : { kind: 'program_started', message: `a program started (${next.mode})` });
  } else if (prev.state === 'running' && next.state === 'stopped') {
    out.push({ kind: 'program_stopped', message: 'the program stopped (feed hold, NC stop or M0/M1)' });
  }
  if (!prev.alarm && next.alarm) {
    out.push({ kind: 'alarm', message: next.alarm_stop ? 'alarm, processing stopped' : 'alarm', stop: next.alarm_stop });
  }
  if (prev.alarm && !next.alarm) out.push({ kind: 'alarm_cleared', message: 'alarms cleared' });
  return out;
}

const KEY_HELP = 'Key names: H1-H8 the horizontal softkeys (under the screen), V1-V8 the vertical ones (right of it), ' +
  'MACHINE, OFFSET, PROGRAM, PROGRAM_MANAGER and SYSTEM (also alarms) the operating areas, INPUT, UP, DOWN, LEFT, ' +
  'RIGHT, PAGE_UP, PAGE_DOWN, HOME, END, TAB, BACKSPACE, DEL, ESC, HELP, letters and digits, combinations like ' +
  'ALT+X, and "quoted text" typed as it is.';

class Sinumerik808D extends FolderMachine {
  constructor(config, ctx) {
    super(config, ctx);
    const plc = config.plc || {};
    if (!plc.host) throw new Error(`machine ${this.key}: plc.host is missing (the 808D's address)`);
    this.pollMs = Math.max(250, plc.poll_ms || 1000);
    this.plc = new S7({ host: plc.host, port: plc.port || 102, rack: plc.rack ?? 0, slot: plc.slot ?? 2 });
    this.signals = { ...SIGNALS };
    this.extraSignals = [];
    for (const [name, address] of Object.entries(plc.signals || {})) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`machine ${this.key}: signal name "${name}" is not allowed`);
      if (address === null) { delete this.signals[name]; continue; }
      expandAddresses(address); // checks it
      if (!(name in SIGNALS)) this.extraSignals.push(name);
      this.signals[name] = String(address).toUpperCase();
    }
    // Bits STEVE may switch (plc.outputs: {"lamp": "Q2.2"}). Never one of the control's own signals above.
    this.outputs = {};
    for (const [name, address] of Object.entries(plc.outputs || {})) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) throw new Error(`machine ${this.key}: output name "${name}" is not allowed`);
      const a = parseAddress(address);
      if (a.bit === null) throw new Error(`machine ${this.key}: output ${name} must be a single bit, like Q2.2`);
      const text = String(address).toUpperCase();
      const owned = Object.entries(this.signals).find(([, addr]) => addr === text);
      if (owned) throw new Error(`machine ${this.key}: ${text} is the control's ${owned[0]} signal; it can't be an output`);
      this.outputs[name] = text;
    }
    const s = config.screen;
    this.screen = s && s.host ? new RemoteScreen({
      host: s.host, port: s.port || 5900, passwordFile: s.password_file, confirmSeconds: s.confirm_seconds ?? 11,
      idleMinutes: s.idle_minutes ?? 15, connect: ctx.connectScreen, log: this.log,
    }) : null;
    this.keysAllowed = Boolean(this.screen) && s.keys !== false;
    this.values = null;     // the signals' latest values, null while the PLC can't be read
    this.plcError = null;
    this.polled = false;
    this.view = null;       // the state the last status was made from
    this.since = null;      // when the state last changed
    this.folderStatus = null;
    this.folderCheckedAt = 0;
  }

  start() {
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      await this.poll();
      if (this.running) this.timer = setTimeout(loop, this.values ? this.pollMs : Math.max(this.pollMs, 5000));
    };
    loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.plc.close();
    this.screen?.close('stopping');
  }

  // The signals' values by name, and the outputs' under "output:<name>".
  async readSignals() {
    const all = { ...this.signals };
    for (const [name, address] of Object.entries(this.outputs)) all[`output:${name}`] = address;
    const values = await this.plc.readAddresses(Object.values(all));
    return Object.fromEntries(Object.entries(all).map(([n, address]) => [n, values.get(address)]));
  }

  async poll() {
    try {
      this.update(await this.readSignals(), null);
    } catch (e) {
      this.plc.close();
      this.update(null, e.message);
    }
  }

  // Takes a reading (or the error that stopped it), and sends status and alerts for what changed.
  update(values, error) {
    if (!values && this.values) this.log(`PLC: ${error}`);
    if (values && !this.values && this.polled) this.log('PLC: reading again');
    if (!values && !this.polled) this.log(`PLC: can't read it yet: ${error}`);
    this.values = values;
    this.plcError = values ? null : error;
    this.polled = true;
    const next = this.state();
    if (!this.view || this.view.state !== next.state) this.since = new Date().toISOString();
    for (const a of alertsBetween(this.view, next)) {
      this.log(`alert: ${a.message}`);
      this.emit('alert', { ...a, machine: this.key, state: next.state, mode: next.mode ?? null, at: new Date().toISOString() });
    }
    this.view = next;
    const s = this.summary();
    const json = JSON.stringify(s);
    if (json !== this.lastJson) {
      this.lastJson = json;
      this.emit('status', s);
    }
  }

  state() {
    if (!this.values) return { state: this.polled ? 'offline' : 'connecting', plc_error: this.plcError };
    const out = describe(this.values);
    if (this.extraSignals.length) out.signals = Object.fromEntries(this.extraSignals.map((n) => [n, this.values[n]]));
    const outputs = Object.keys(this.outputs);
    if (outputs.length) out.outputs = Object.fromEntries(outputs.map((n) => [n, Boolean(this.values[`output:${n}`])]));
    return out;
  }

  summary() {
    if (!this.folderStatus || Date.now() - this.folderCheckedAt > 10000) {
      this.folderStatus = this.folder.status();
      this.folderCheckedAt = Date.now();
    }
    const out = {
      machine: this.key, name: this.name, control: 'SINUMERIK 808D', connected: Boolean(this.values),
      ...(this.view || this.state()), since: this.since,
      programs_folder: this.folderStatus.ok ? 'ok' : this.folderStatus.error, drive: this.drive,
    };
    if (this.screen) out.screen = this.screen.connected ? 'open' : this.screen.lastError ? `closed: ${this.screen.lastError}` : 'closed';
    return out;
  }

  // While a program is under way (running, stopped, waiting or interrupted).
  get busy() {
    return Boolean(this.view && ACTIVE.includes(this.view.state));
  }

  actions() {
    const drive = this.drive ? `${this.drive}` : 'its network drive';
    const base = super.actions().map((a) => (a.name !== 'send_program' ? a : {
      ...a,
      description: `${a.description} At the 808D the program is in PROGRAM MANAGER, drive ${drive}, folder ` +
        `${this.folder.subfolder}. Replacing a file is refused while a program is under way at the control.`,
    }));
    const out = [
      ...base,
      { name: 'status', title: 'Machine status',
        description: 'The machine as its PLC reports it: state (idle, running, stopped, waiting, interrupted, alarm, ' +
          'emergency_stop, offline), mode (AUTO, MDA, JOG, JOG REF), program and channel state, alarms, emergency ' +
          'stop, axes referenced and stationary, drives, door open and locked. Read it before anything at the machine.',
        inputs: { type: 'object', properties: {
          raw: { type: 'boolean', default: false, title: 'Every signal', description: 'Also each PLC signal by name and address' },
        } } },
      { name: 'read_plc', title: 'Read PLC',
        description: 'Reads PLC addresses, read-only: bits like DB3300.DBX4.7 or Q2.4 as true/false, bytes like IB0 ' +
          'or DB3300.DBB3 as numbers (with their bits, 7 to 0), ranges like IB0-15. To find a signal (the door switch, ' +
          'air pressure), read the inputs, have the person change it at the machine, and read again.',
        inputs: { type: 'object', properties: {
          addresses: { type: 'string', maxLength: 1000, title: 'Addresses', description: 'e.g. "IB0-15 QB0-3 DB2700.DBX0.1"' },
        }, required: ['addresses'] } },
    ];
    const outputs = Object.keys(this.outputs);
    if (outputs.length) {
      // Acts on the machine (a pump, a lamp): a person confirms each run unless the owner's config says otherwise.
      out.push({ name: 'set_output', title: `Switch ${outputs.join(', ').replace(/_/g, ' ')}`, confirm: true,
        description: `Switches ${outputs.join(', ')} on or off: the outputs the owner allowed in the connector's ` +
          'config, and nothing else on the PLC. It reads the output back: if the machine\'s PLC program sets it ' +
          'itself, the switch does not hold and the run fails. The state is in status (outputs).',
        inputs: { type: 'object', properties: {
          output: { type: 'string', enum: outputs, title: 'Output' },
          on: { type: 'boolean', title: 'On' },
        }, required: ['output', 'on'] } });
    }
    if (!this.screen) return out;
    out.push({ name: 'screen', title: 'Control screen',
      description: "The 808D's screen as screen.png. Look at it before and after pressing keys. A new remote " +
        'session (after 15 minutes without one) may show "Remote control request" on the control for about 10 s; ' +
        'it accepts itself.',
      inputs: { type: 'object', properties: {} } });
    if (this.keysAllowed) {
      // Changes what the control does next: a person confirms each run unless the owner's config says otherwise.
      out.push({ name: 'press_keys', title: 'Press keys', confirm: true,
        description: "Presses keys on the 808D's operator panel through its remote screen, then returns the screen " +
          'as screen.png. It can change what the control does next (modes, offsets, tool data, settings): look at ' +
          'the screen first, tell the person what you will change at the machine before pressing, and check the ' +
          'screen after. Never delete anything on the control, and never change offsets, tool data or machine data ' +
          'unless the person asked for that exact value. Keys cannot start a program, move an axis or turn the ' +
          `spindle: those stay with the person at the machine. ${KEY_HELP}`,
        inputs: { type: 'object', properties: {
          keys: { type: 'string', maxLength: 1000, title: 'Keys', description: 'Space-separated, e.g. "PROGRAM_MANAGER H2 DOWN INPUT"' },
          screen: { type: 'boolean', default: true, title: 'Screen after', description: 'Return the screen after the keys' },
        }, required: ['keys'] } });
    }
    return out;
  }

  get handlers() {
    const base = super.handlers;
    const out = {
      ...base,
      send_program: async (inputs, ctx) => {
        if (inputs.replace && this.busy) {
          throw new Error(`a program is ${this.view.state} at the control; a file is never replaced while one is ` +
            'under way (send it under another name, or replace it once the control is reset)');
        }
        return base.send_program(inputs, ctx);
      },
      status: async (inputs) => {
        await this.poll();
        const result = { status: this.summary() };
        if (inputs.raw) {
          result.signals = Object.fromEntries(Object.entries(this.signals)
            .map(([name, address]) => [name, { address, value: this.values ? this.values[name] : null }]));
        }
        const s = result.status;
        return { result, message: s.connected ? `${s.state}${s.mode ? `, ${s.mode}` : ''}` : `PLC not reachable: ${s.plc_error}` };
      },
      read_plc: async (inputs) => {
        const list = expandAddresses(inputs.addresses);
        if (!list.length) throw new Error('no addresses');
        let read;
        const missing = {};
        try {
          read = await this.plc.readAddresses(list);
        } catch (e) {
          // The PLC refuses a whole request when part of it doesn't exist (the 808D has I0-I8 and Q0-Q5):
          // read one address at a time, so what exists still comes back.
          if (!/refused reading/.test(e.message)) throw e;
          read = new Map();
          for (const a of list) {
            try { read.set(a, await this.plc.readAddress(a)); } catch (err) { read.set(a, null); missing[a] = err.message; }
          }
        }
        const values = {}, bits = {};
        for (const a of list) {
          values[a] = read.get(a);
          if (typeof values[a] === 'number') bits[a] = values[a].toString(2).padStart(8, '0');
        }
        const n = list.length - Object.keys(missing).length;
        const result = { values, bits };
        if (Object.keys(missing).length) result.missing = missing;
        return { result, message: `${n} value${n === 1 ? '' : 's'}${result.missing ? `, ${list.length - n} not in this PLC` : ''}` };
      },
    };
    if (Object.keys(this.outputs).length) {
      out.set_output = async (inputs) => {
        const address = this.outputs[inputs.output];
        if (!address) throw new Error(`"${inputs.output}" is not an output STEVE may switch (${Object.keys(this.outputs).join(', ')})`);
        const on = Boolean(inputs.on);
        this.log(`switching ${inputs.output} (${address}) ${on ? 'on' : 'off'}`);
        await this.plc.writeBit(address, on);
        await sleep(300); // long enough for the PLC program to have set it back, if it sets this output itself
        const now = await this.plc.readAddress(address);
        await this.poll();
        if (now !== on) {
          throw new Error(`wrote ${address} ${on ? 'on' : 'off'} but it reads ${now ? 'on' : 'off'}: the machine's PLC ` +
            'program sets this output itself, so it can\'t be switched from here');
        }
        return { result: { output: inputs.output, address, on }, message: `${inputs.output.replace(/_/g, ' ')} ${on ? 'on' : 'off'}` };
      };
    }
    if (!this.screen) return out;
    const shot = async (ctx) => {
      const s = await this.screen.capture();
      await ctx.file('screen.png', s.png, 'image/png');
      return { screen: 'screen.png', width: s.width, height: s.height, taken_at: new Date().toISOString(),
        dialog_seconds_left: s.dialog_seconds_left };
    };
    out.screen = async (inputs, ctx) => {
      const result = await shot(ctx);
      return { result, message: result.dialog_seconds_left
        ? `New remote session: the control may show its remote-control dialog for about ${result.dialog_seconds_left} s ` +
          '(keys wait for it)' : 'Screen' };
    };
    if (this.keysAllowed) {
      out.press_keys = async (inputs, ctx) => {
        const presses = parseKeys(inputs.keys); // refuses unknown keys before any is sent
        if (!presses.length) throw new Error('no keys given');
        await this.screen.session();
        const wait = Math.ceil(this.screen.dialogSecondsLeft);
        await ctx.progress(0.1, wait ? `Waiting ${wait} s for the control's remote-control dialog to close` : 'Pressing keys');
        const labels = presses.map((p) => p.label).join(' ');
        this.log(`pressing keys: ${labels}`);
        await this.screen.press(presses, { signal: ctx.signal });
        const result = { pressed: presses.map((p) => p.label) };
        if (inputs.screen !== false) {
          await sleep(600); // let the control draw what the keys did
          Object.assign(result, await shot(ctx));
        }
        return { result, message: `Pressed ${labels}` };
      };
    }
    return out;
  }
}

module.exports = { create: (config, ctx) => new Sinumerik808D(config, ctx), Sinumerik808D, SIGNALS, describe, alertsBetween };
