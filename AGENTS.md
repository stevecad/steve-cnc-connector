# AGENTS.md

Guidance for AI agents (and people) working on **steve-cnc-connector**: a STEVE connector that lets STEVE see and
work the machines in a shop.

**This is experimental software** (see the warning at the top of the README): it runs next to real machine tools.
Whoever runs it is responsible for making sure it works correctly with their machine. Keep that warning in the
README, and never weaken it.

## What it is

A small Node.js program (CommonJS, Node 22.12+, one dependency: `rfb2`, an ES module loaded with `require()`) that
runs on a computer beside the machines. One process serves several machines, each through a driver named in
`config.json`. It talks to:

- **STEVE** over HTTPS, outbound only (`https://stevecad.studio/connect/v1`): signed requests, long-polled runs,
  run reports, files, events, its panel. Protocol: https://stevecad.studio/docs/developers/connectors/
- **A SINUMERIK 808D** (driver `sinumerik808d`, first machine: a Syil X7), from a Raspberry Pi wired to it:
  - its **PLC over S7** (ISO-on-TCP, port 102): read once a second for status and alerts; bit writes only for
    the outputs the owner lists;
  - its **network drive**: a Samba share on the Pi that the 808D mounts (as N1); programs are files there;
  - its **screen over VNC** (port 5900): captures and HMI keys.
- **Any control that reads programs from a folder** (driver `folder`: WinCNC, Centroid, a share).

## Rules for operating a machine through it

These are in the action descriptions too, because agents read those. Keep them there.

- **Read before acting**: `status` (state, mode, alarms, e-stop, door) and, for anything on the HMI, `screen`.
- **Tell the person what will happen at the machine before anything that changes it** (a key press, a switched
  output, a program sent), and check the result after (`status`, `screen`, the run's read-back).
- **Never delete anything on the control** or the programs it runs. There is no delete action; don't add one.
- **Starting a program, jogging, the spindle and mode stay with the person at the machine.** On the 808D those
  are keys on the machine control panel, a USB device. This connector does not imitate those keys or write the
  NC's mode, start or stop signals, and must not: that would go around the machine's own safety design. Remote
  operation belongs in the machine builder's PLC program (for example a key-switched "remote enabled" input with
  interlocks), which the connector could then switch like any other listed output.
- E-stops, door interlocks and guarding belong to the machine. Nothing here may bypass them.

## Layout

| Path | What |
| --- | --- |
| `connector.js` | Entry point: config, one driver per machine, catalog, pairing, the run loop (each run id acted on once, never repeated after a restart), cancels, events (throttled to 1/s per machine, heartbeat each minute), panel publishing |
| `lib/steve.js`, `lib/panel.js` | STEVE protocol and panel publishing, shared with steve-bambu-connector (keep them identical) |
| `lib/catalog.js` | Prefixes each machine's actions and events with its key (`x7.status`); limits |
| `lib/drivers/folder.js`, `lib/programs.js` | Programs: list, read, write into the share's `STEVE` subfolder (staged then renamed, SHA-256 checked, never over a different file unless asked, never deletes) |
| `lib/drivers/sinumerik808d.js` | The 808D: the folder actions + PLC status and alerts + `status`, `read_plc`, `set_output`, `screen`, `press_keys` |
| `lib/s7.js` | S7 client: grouped reads (one request per area or data block), and `writeBit`, its only write |
| `lib/screen.js`, `lib/keys.js`, `lib/png.js` | One shared VNC session (rfb2), key names → keysyms, PNG encoder |
| `panel/` | The "Shop" panel: a card per machine (state, status, banner, outputs, screen and key pad, send the open CAM program, program list) |
| `service/linux/` | systemd system service (starts at boot, runs as the installing user) |
| `docs/sinumerik-808d.md` | What was found on the 808D: signals, areas, screen, keys, outputs |
| `test/` | Stand-ins for STEVE, the PLC and VNC; the panel in jsdom |

### Driver interface

`lib/drivers/<name>.js` exports `create(machineConfig, { dataDir, log })` returning an EventEmitter with `key`,
`name`, `config`, `start()`, `stop()`, `summary()` (the status, under 8 kB), `actions()` (names without the machine
prefix), `handlers` (`{ name: async (inputs, ctx) => ({ result, message }) }`, where `ctx` has `signal`,
`progress(fraction, text)`, `input(fileInput)` and `file(name, buffer, type)`), and emits `status` (when it changes)
and `alert` (`{ kind, message, ... }`). A driver for another control should compose `FolderMachine` for programs, as
the 808D driver does.

## How the 808D was made to work

The method matters more than the addresses, because another machine's PLC program will differ.

1. **Network.** The Pi gets the 808D on its own Ethernet subnet with DHCP, shares a folder over Samba (SMB1,
   guest, writable), and the 808D mounts it as a network drive. The Pi reaches STEVE over Wi-Fi.
2. **PLC.** Read-only first, from a script on the Pi: rack 0 slot 2, then the NC/PLC interface data blocks by
   number (DB2700, DB3100, DB3300 for state). The 808D refuses a whole request that reaches past an area's end
   (error code 10): I0-I8, Q0-Q5 and M0-M255 here.
3. **Finding a signal: change it and compare.** Read everything (`read_plc`, or a scan of I, Q, M and the data
   blocks), have the person change one thing at the machine (lock the door, switch the lamp), read again, diff.
   For momentary things (a key), sample a few times a second while the person presses it and log the bits that
   change.
4. **Switching something: write the flag, not the output.** The machine builder's PLC program writes outputs every
   cycle, so writing an output (the lamp's Q2.2) is undone within a cycle. Find the flag the program keeps the
   state in (bits that changed with it), write each candidate, and keep the one that holds: on the Syil, M211.7 for
   the lamp and M150.0 for the coolant. `set_output` always reads the bit back after 300 ms and fails the run if
   it didn't hold. Add outputs only with the owner's say, and test each one with someone watching.
5. **Screen.** The 808D's VNC server sends only 16-bit RGB565 raw and drops clients that ask for another pixel
   format. A new session may show an accept dialog on the control for 10 s, so keys wait 11 s after connecting.
   Softkeys are F1-F8 and Shift+F1-F8; the operating areas Alt+X/C/V/B/N.

Details and the signal tables: `docs/sinumerik-808d.md`.

## Deploying (a Pi beside an 808D)

1. **The Pi**: Node 22.12+ (rfb2 needs it), the Samba share the 808D mounts, its Ethernet to the 808D. On the 808D,
   ALARM → Remote diag.: permit remote operation; put the VNC password in a file on the Pi only (mode 600) and
   point `screen.password_file` at it.
2. **Copy** the repo to the Pi without `node_modules`, `data/` or `config.json`, then `npm ci --omit=dev`.
3. **Config**: `cp config.example.json config.json`; set the 808D's address, the share's folder and drive name,
   `outputs` (only what the owner wants switchable), `screen`.
4. **Check before pairing** with one read-only reading through the driver:
   ```sh
   node -e "const m = require('./lib/drivers/sinumerik808d').create(require('./config.json').machines[0], { dataDir: 'data/check', log: console.log }); m.poll().then(() => { console.log(m.summary()); m.stop(); })"
   ```
   It should print `connected: true`, the mode and `programs_folder: 'ok'`.
5. **Pair**: a code from STEVE (Settings → Connectors → Pair, or `manage_connectors(op="pair")`), then
   `node connector.js --pair <CODE>`. Confirm the fingerprint **exactly as printed** (`manage_connectors(op=
   "confirm")`), never one copied from STEVE. Ctrl+C.
6. **Service**: `./service/linux/install.sh` (needs sudo). Logs: `journalctl -u steve-cnc-connector -f` and
   `data/connector.log`.
7. **Allow** the actions in STEVE (`manage_connectors(op="allow")`). `send_program` takes a CAM program, so it needs
   the shop machine: `machine_id` is that machine's **library UUID** (generate the shop document; its `library`
   lists each item's `library_id`), not its key.
8. **Test** with `list_actions` and `run_action`: `status`, `programs`, `read_plc`, then `screen`, then anything that
   changes the machine, with the person watching.

**Updating**: copy the changed files over (never `data/` or `config.json`: they hold the Pi's key and settings),
`sudo systemctl restart steve-cnc-connector`.

## Gotchas found the hard way

- **After restarting the connector, wait about 40 s before starting a run.** Runs sent within ~30 s of a restart
  sat "queued" in STEVE and weren't delivered (likely handed to the killed process's open long poll); runs sent
  later went straight through.
- **Changing an action's inputs takes its permission away** (adding an output changes `set_output`'s enum): allow
  it again.
- **Only fully verified CAM programs are accepted by default.** Accepting "checked" ones is the owner's choice in
  STEVE's app; neither the catalog nor `manage_connectors` can set it. With estimated shop data (tool holders,
  machine geometry), programs come out "checked".
- **Program files**: plain ASCII; the existing programs on the 808D's drive are lower-case `.mpf`, so the example
  config keeps that case. STEVE's 808D posts may be for the control's ISO mode: check the control has it.
- **systemd 245 (Ubuntu 20.04) refuses a quoted `WorkingDirectory=`**; the install script writes it unquoted.
- **rfb2 1.x is ESM-only**: `require('rfb2')` works on Node 22.12+ only.

## Testing

`npm test` (Node's test runner, spec reporter) and `npm run check` (syntax). The tests need no hardware:

- `test/helpers.js`: a fake S7 PLC sized like the 808D (reads, bit writes, a `hold` that plays a PLC program
  overwriting a bit), a fake VNC client.
- `test/connector.test.js` starts `connector.js` against a stand-in STEVE: enrollment, catalog, panel, events,
  runs, a forged run refused, a repeated run ignored.
- `test/panel.test.js` runs the panel in jsdom with a stand-in bridge.

CI runs both on Linux, Windows and macOS with Node 22 and 24.

## Keep this file current

When you learn something about a machine, a STEVE behaviour or the deployment, put it here or in
`docs/sinumerik-808d.md`. Never put a shop's addresses, accounts, passwords or STEVE ids in this repo.
