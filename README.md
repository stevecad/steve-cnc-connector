# steve-cnc-connector

> [!CAUTION]
> # ⚠️ EXPERIMENTAL SOFTWARE ⚠️
>
> **This connects AI and remote software to real CNC machines. It is experimental, incomplete and tested on one
> machine (a Syil X7 with a SINUMERIK 808D) by its author. It can be wrong, and a wrong program, offset or signal on
> a machine tool can destroy the machine, the part, the tooling, or hurt someone.**
>
> - **Use it at your own risk.** There is no warranty of any kind (see [LICENSE](LICENSE)).
> - **Your machine's own safety systems stay in charge**: emergency stop, door interlocks, guarding and the machine
>   builder's PLC program. This software does not replace or bypass any of them, and must never be used to.
> - **A person qualified to run the machine must be at it** whenever it is powered, and must prove out every program
>   (single block, feed override low, hand on feed hold) before cutting.
> - PLC addresses, key mappings and signal meanings here were found on **one** machine. Yours will differ. Check
>   every one before trusting it.
> - Writing to a PLC (`plc.outputs`) changes how the machine behaves. Only list things that are safe to switch
>   remotely, and test each one with someone watching.

A [STEVE connector](https://stevecad.studio/docs/developers/connectors/) for the machines in a shop. One process
serves several machines, each through a driver (`lib/drivers/<driver>.js`) named in `config.json`. Each machine's
actions and events are named `<machine>.<name>` (`x7.send_program`, `x7.status`), and one panel ("Shop") shows them all.

| Driver | For | What it does |
| --- | --- | --- |
| `sinumerik808d` | SIEMENS SINUMERIK 808D (Syil X7), through a computer wired to it | Programs on the control's network drive, state and alerts from the PLC (read-only), the HMI screen and its keys |
| `folder` | Any control that reads programs from a folder (WinCNC, Centroid, a share) | Programs only |

Nothing in this connector can start a program, move an axis or turn the spindle. On the 808D those keys are on the
machine control panel, a USB device that only the person at the machine can reach. The connector has no delete
action, and it writes to the PLC only the bits listed under `plc.outputs` (none by default). See
[docs/sinumerik-808d.md](docs/sinumerik-808d.md) for what was found on the machine.

## Actions (808D)

| Action | What it does |
| --- | --- |
| `status` | State (idle, running, stopped, waiting, interrupted, alarm, emergency_stop, offline), mode, program and channel state, alarms, e-stop, axes, drives, door lock; `raw` adds every PLC signal |
| `programs`, `read_program` | Lists the programs on the drive (newest first), returns one as a file |
| `send_program` | Puts a CAM program STEVE posted for this machine in the drive's `STEVE` folder, checked byte for byte; never over a different file unless `replace`, never while a program is under way |
| `read_plc` | Reads PLC addresses (`IB0-8 QB0-5 DB3300.DBX4.7`), read-only, to find new signals |
| `set_output` | Switches a bit listed under `plc.outputs` (the work lamp: `"lamp": "M211.7"`), and reads it back; only offered when some are listed |
| `screen` | The control's screen as `screen.png` |
| `press_keys` | Presses HMI keys (softkeys `H1`-`H8`, `V1`-`V8`, areas `MACHINE` `OFFSET` `PROGRAM` `PROGRAM_MANAGER` `SYSTEM`, `INPUT`, arrows, `"typed text"`), then returns the screen. `"keys": false` in the config leaves it out |

Events: `x7.status` (when it changes, at most once a second, plus once a minute) and `x7.alert` (program started,
stopped, resumed, ended; alarm and cleared; e-stop pressed and released; PLC lost and back).

## Install (Raspberry Pi beside the 808D)

Needs Node 22.12 or later (the remote screen library is an ES module).

```sh
# on the Pi, in ~/steve-cnc-connector (copied there without node_modules, data or config.json)
npm ci --omit=dev
cp config.example.json config.json         # then check the addresses and folders
node connector.js --pair <CODE>            # code from STEVE: Settings → Connectors → Pair a connector
# confirm the printed fingerprint in STEVE, then Ctrl+C
./service/linux/install.sh                 # systemd service, starts at boot; logs: journalctl -u steve-cnc-connector -f
```

In STEVE allow the actions (Settings → Connectors), and for `send_program` choose the shop machine programs are posted
for. The VNC password lives only on the Pi (`screen.password_file`, mode 600).

## Config

See `config.example.json`. Per machine: `key` (a short name, the action prefix), `name`, `driver`, `programs`
(the folder, the subfolder the connector writes to, the control's name for the drive, file name rules), and for the
808D `plc` (address, rack/slot, poll interval, extra `signals` by name such as `"door_closed": "I1.3"`, or
`"door_locked": null` to leave one out), `outputs` (bits STEVE may switch, by name; only things safe to switch
remotely, like a lamp) and `screen` (VNC address, password file, `keys`). `confirm` lists
actions that wait for a person on every run (none by default).

## Tests

`npm test` runs everything against stand-ins: a fake S7 PLC sized like the 808D, a fake VNC client, a fake STEVE
(the end-to-end test starts `connector.js` itself), and the panel in jsdom.
