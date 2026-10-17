# SINUMERIK 808D notes

What the `sinumerik808d` driver relies on, as found on a Syil X7 with an 808D (software V04.71.67). Other 808D
machines should be close; check the PLC signals with `read_plc` before trusting them.

## Wiring

The connector runs on a small Linux computer (a Raspberry Pi) wired to the 808D's Ethernet port, with its own
subnet and DHCP for the control (here 172.16.100.1 for the Pi and 172.16.100.2 for the 808D). The Pi joins the shop
network over Wi-Fi and connects out to STEVE.

## Programs: a network drive

The Pi shares a folder over Samba (SMB1, guest, writable) and the 808D mounts it as a network drive (**N1** here).
Programs there are `.mpf` (main) and `.spf` (subroutine) files, plain ASCII with CRLF line ends; the 808D shows them
in PROGRAM MANAGER. The connector writes into its own `STEVE` subfolder, through a staging file renamed into place so
the control never sees half a file. Some shops copy programs from the drive into NC memory instead of running them
from it: that stays with the operator.

## PLC: S7 over TCP 102

Rack 0, slot 2 (TSAP 0x0102), PDU 480. Data blocks are read directly by number. Inputs are **I0-I8**, outputs
**Q0-Q5** and flags **M0-M255**; a request reaching past them is refused whole (error code 10), so `read_plc` falls
back to one address at a time. Data blocks found: 1000 (machine control panel keys), 1100 (its LEDs), 1200, 1400,
1600, 1700, 1800, 1900, 2500-2900, 3000-3500, 3800, 3900-3903, 4700, 4900, 5000, 5300.

| Signal | Address | Notes |
| --- | --- | --- |
| Mode AUTO / MDA / JOG | DB3100.DBX0.0 / 0.1 / 0.2 | seen switching JOG → AUTO |
| 808D ready | DB3100.DBX0.3 | |
| Machine function REF | DB3100.DBX1.2 | on in JOG REF |
| Channel reset / interrupted / active | DB3300.DBX3.7 / 3.6 / 3.5 | reset when idle |
| Program running / waiting / stopped / interrupted / aborted | DB3300.DBX3.0 … 3.4 | aborted when idle, also after M30 |
| All axes referenced / stationary, channel operational | DB3300.DBX4.2 / 4.3 / 4.5 | |
| NCK alarm in the channel / with processing stop | DB3300.DBX4.6 / 4.7 | |
| NCK alarm active | DB2700.DBX3.0 | |
| Emergency stop active | DB2700.DBX0.1 | |
| NC ready, drives ready, drives in cyclic operation | DB2700.DBX2.7 / 2.6 / 2.5 | |
| Door lock (Syil X7) | Q2.4 | on when locked |
| Door lock released (Syil X7) | I4.7 | on while unlocked; likely the lock's own switch |
| Door open (Syil X7) | I4.6 | on while the door is open |

Seen at rest only so far: running, stopped, alarm and e-stop come from Siemens' interface description, not from a
live reading. Machine-specific inputs and outputs (door lock, door switch, air pressure, tool setter) depend on the
machine builder's PLC program: find them with `read_plc` (read, change it at the machine, read again) and add them
under `plc.signals` in the config. The door rows above were found that way: closed and locked, closed and
unlocked, then open.

## Switching things (plc.outputs)

The connector writes only the bits listed under `plc.outputs` in the config (none by default), one bit at a time,
and reads each back 300 ms later: a bit the PLC program sets itself every cycle doesn't hold, and the run says so.
Write the flag the program keeps the state in, not the output: on the Syil X7 the work lamp's output is **Q2.2**,
but the program copies it from **M211.7** every cycle (M211.3 follows it too), so `"lamp": "M211.7"` switches the
lamp, its output and the lamp key's LED (DB1100.DBX1.1), while writing Q2.2 is undone at once. The coolant works
the same way: key DB1000.DBX1.2, pump output Q2.0, state flag **M150.0** (M150.1 follows it), LED DB1100.DBX1.2.
Find such a flag by watching the PLC (sample I, Q, M and DB1000/DB1100 a few times a second and log what changes)
while the thing is switched at the machine, then writing each flag that changed and seeing which one holds.

| Function (Syil X7) | Key | Output | Flag to write | LED |
| --- | --- | --- | --- | --- |
| Work lamp | DB1000.DBX1.1 (inferred) | Q2.2 | M211.7 | DB1100.DBX1.1 |
| Coolant | DB1000.DBX1.2 | Q2.0 | M150.0 | DB1100.DBX1.2 |

The interface bits for mode, NC start, NC stop and reset are written by the machine builder's PLC program from the
machine control panel on every PLC cycle, so an outside write would be overwritten; remote control of those would
need a change to that PLC program. Never list anything that moves the machine, turns the spindle or opens a guard.

## Remote screen: VNC on TCP 5900

Turned on at the 808D under ALARM → Remote diag. ("Permit remote operation"), with a confirmation dialog and its
timeout. The HMI can't type lower-case letters into the password field.

- 800×600, **16-bit RGB565, raw encoding only**. The 808D closes the connection at once if the client asks for any
  other pixel format, so the driver keeps the server's (`pixelFormat: 'server'` in rfb2). A full screen takes under
  a second.
- A new connection may show "Remote control request, accepted or not?" on the control for 10 s, with Cancel and OK
  on the vertical softkeys V7 and V8. A key sent then could answer it, so the driver keeps one session open (closed
  after 15 idle minutes) and sends no key until `confirm_seconds` (11) have passed since connecting.
- The machine control panel (cycle start, feed hold, reset, jog, spindle) is a separate USB device: VNC can't reach
  it, so nothing sent this way starts or moves anything.

## Keys

| Name | PC key | Source |
| --- | --- | --- |
| H1-H8 (horizontal softkeys) | F1-F8 | Access MyMachine manual; checked against the screen |
| V1-V8 (vertical softkeys) | Shift+F1-F8 | Access MyMachine manual; the remote dialog's Cancel/OK sit on V7/V8 |
| SYSTEM (also alarms) | Alt+N | Access MyMachine manual |
| MACHINE, OFFSET, PROGRAM, PROGRAM_MANAGER | Alt+X, Alt+C, Alt+V, Alt+B | 808D function manual, hot keys |
| HELP | Alt+H | 808D operating manual |
| INPUT | Return | 808D operating manual |

A letter held with Alt or Ctrl is sent lower case, as a PC keyboard sends it.
