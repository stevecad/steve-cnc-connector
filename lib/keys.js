// Key names for a control's remote screen -> X11 keysyms (what VNC sends).
// A key list is space-separated names; "quoted text" is typed character by character.
'use strict';

const K = {
  F1: 0xFFBE, F2: 0xFFBF, F3: 0xFFC0, F4: 0xFFC1, F5: 0xFFC2, F6: 0xFFC3, F7: 0xFFC4, F8: 0xFFC5,
  F9: 0xFFC6, F10: 0xFFC7, F11: 0xFFC8, F12: 0xFFC9,
  SHIFT: 0xFFE1, CTRL: 0xFFE3, ALT: 0xFFE9,
  RETURN: 0xFF0D, ENTER: 0xFF0D, TAB: 0xFF09, BACKSPACE: 0xFF08, DEL: 0xFFFF, DELETE: 0xFFFF, INSERT: 0xFF63,
  HOME: 0xFF50, END: 0xFF57, LEFT: 0xFF51, UP: 0xFF52, RIGHT: 0xFF53, DOWN: 0xFF54,
  PAGE_UP: 0xFF55, PAGE_DOWN: 0xFF56, ESC: 0xFF1B, ESCAPE: 0xFF1B, SPACE: 0x20,
};
const MODIFIERS = new Set([K.ALT, K.CTRL]);

// The 808D's own names, from Siemens' Access MyMachine manual (F1-F8 horizontal softkeys, Shift+F1-F8 vertical,
// Alt+X to Alt+N the operating areas), the 808D function manual's hot keys (Alt+X machine, Alt+C offset, Alt+V
// program, Alt+B program manager) and the 808D operating manual (Alt+H help, linefeed/Return is INPUT).
// The area keys other than SYSTEM have not been tried at the machine yet.
const NAMED = {
  INPUT: ['RETURN'], HELP: ['ALT', 'H'],
  MACHINE: ['ALT', 'X'], OFFSET: ['ALT', 'C'], PROGRAM: ['ALT', 'V'], PROGRAM_MANAGER: ['ALT', 'B'],
  SYSTEM: ['ALT', 'N'],
};
for (let i = 1; i <= 8; i++) {
  NAMED[`H${i}`] = [`F${i}`];
  NAMED[`V${i}`] = ['SHIFT', `F${i}`];
}

// A letter held with Alt or Ctrl is sent lower case, as a PC keyboard sends it (upper case would mean Shift too).
function keysymOf(name, lower) {
  if (K[name] !== undefined) return K[name];
  if (/^[A-Z]$/.test(name)) return (lower ? name.toLowerCase() : name).charCodeAt(0);
  if (/^[0-9]$/.test(name)) return name.charCodeAt(0);
  return null;
}

// "H3 DOWN DOWN INPUT", "ALT+M", "SHIFT+F2", "\"G0 X10\"" -> [{label, combo: [keysym...]}] (a combo is pressed
// together: modifiers down, key down, all up). Throws on anything it doesn't know, before anything is sent.
function parseKeys(text, { maxPresses = 200 } = {}) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    if (m[1] !== undefined) {
      for (const ch of m[1]) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code > 0x7E) throw new Error(`can't type ${JSON.stringify(ch)}: only plain ASCII text`);
        out.push({ label: ch, combo: [code] });
      }
      continue;
    }
    const token = m[2].toUpperCase();
    const parts = NAMED[token] || token.split('+');
    const lower = parts.some((p) => MODIFIERS.has(K[p]));
    const combo = parts.map((p) => {
      const sym = keysymOf(p, lower);
      if (sym === null) throw new Error(`unknown key "${m[2]}" (see the action's description for key names)`);
      return sym;
    });
    out.push({ label: token, combo });
  }
  if (out.length > maxPresses) throw new Error(`${out.length} key presses; at most ${maxPresses} per run`);
  return out;
}

module.exports = { parseKeys, NAMED, KEYSYMS: K };
