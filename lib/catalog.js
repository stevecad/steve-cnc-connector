// Builds the connector's catalog from its machines: each machine's actions and events, named "<key>.<name>".
'use strict';

const KEY = /^[a-z][a-z0-9_]{0,15}$/;
const NAME = /^[a-z][a-z0-9_.-]*$/;

function buildCatalog(machines, { confirm = [] } = {}) {
  const actions = [], events = [], seen = new Set();
  for (const m of machines) {
    if (!KEY.test(m.key)) throw new Error(`machine key "${m.key}": lowercase letters, digits and _, starting with a letter, at most 16`);
    if (seen.has(m.key)) throw new Error(`two machines have the key "${m.key}"`);
    seen.add(m.key);
    for (const a of m.actions()) {
      const name = `${m.key}.${a.name}`;
      if (!NAME.test(name) || name.length > 40) throw new Error(`action name "${name}" is not allowed (at most 40 characters)`);
      actions.push({
        ...a, name, title: `${m.name}: ${a.title}`,
        confirm: Boolean(a.confirm) || confirm.includes(name) || confirm.includes(a.name),
      });
    }
    events.push({ name: `${m.key}.status`, description: `${m.name}: state, as it changes` });
    events.push({ name: `${m.key}.alert`, description: `${m.name}: things to know about (a program started or ended, an alarm)` });
  }
  if (actions.length > 100) throw new Error(`${actions.length} actions; STEVE takes at most 100`);
  if (events.length > 50) throw new Error(`${events.length} events; STEVE takes at most 50`);
  return { actions, events };
}

module.exports = { buildCatalog };
