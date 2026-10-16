// Backup files: everything the user has set (plans, marks, their own
// services and games, settings) in one JSON file, to move to another PC or
// keep safe. Catalogues and cached lookups aren't included; the app fetches
// those again.
const FORMAT = 'subscroll-backup';
const VERSION = 1;
const MARKS = new Set(['played', 'completed', 'ignored', 'wishlist']);
const FIELDS = ['subscriptions', 'marks', 'leaveDates', 'customServices', 'customGames', 'settings'];

function makeBackup(state, now = new Date()) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    state: Object.fromEntries(FIELDS.map((k) => [k, state[k]])),
  };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stringMap = (v) => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {});

// Returns the state to restore, or throws with a message for the user.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file isn't a Subscroll backup (it isn't valid JSON).");
  }
  if (!isObject(data) || data.format !== FORMAT || !isObject(data.state)) {
    throw new Error("This file isn't a Subscroll backup.");
  }
  if (data.version > VERSION) {
    throw new Error('This backup was made by a newer version of Subscroll. Update the app, then restore it.');
  }
  const s = data.state;
  return {
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    state: {
      subscriptions: stringMap(s.subscriptions),
      marks: Object.fromEntries(Object.entries(stringMap(s.marks)).filter(([, m]) => MARKS.has(m))),
      leaveDates: stringMap(s.leaveDates),
      customServices: Array.isArray(s.customServices) ? s.customServices.filter(isObject) : [],
      customGames: Array.isArray(s.customGames) ? s.customGames.filter(isObject) : [],
      ...(isObject(s.settings) ? { settings: s.settings } : {}),
    },
  };
}

const backupName = (now = new Date()) => `subscroll-backup-${now.toISOString().slice(0, 10)}.json`;

module.exports = { makeBackup, parseBackup, backupName };
