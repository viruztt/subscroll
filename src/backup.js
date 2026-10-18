// Profile files: everything Subscroll keeps about you in one JSON file, to
// move to another PC or keep safe. That is your plans, marks, own services
// and games, settings, Value page costs, Steam link, free-game claims, what
// each list's history noticed (join dates, departed games), and optionally
// the looked-up scores, prices, descriptions and covers, so the other PC
// needn't look them all up again. Catalogues themselves aren't included; the
// app fetches those again.
const FORMAT = 'subscroll-backup';
const VERSION = 2;
const MARKS = new Set(['played', 'completed', 'ignored', 'wishlist']);
const FREE_MARKS = new Set(['claimed', 'skip']);
const FIELDS = [
  'subscriptions', 'marks', 'leaveDates', 'customServices', 'customGames', 'settings', 'costs', 'priceOverrides', 'viaSub',
  'freebies', 'steam', 'alertedLeaving', 'freeKnown', 'freeReminded', 'trayHintShown',
];
// Looked-up data, each a map of key -> entry.
const LOOKUPS = ['ratings', 'prices', 'wikipedia', 'details', 'appstore'];

// history: { service: { firstSeen, departed } }; lookups: { ratings: {...}, ... } or null
function makeBackup(state, now = new Date(), { history = null, lookups = null } = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: now.toISOString(),
    state: Object.fromEntries(FIELDS.filter((k) => state[k] !== undefined).map((k) => [k, state[k]])),
    ...(history ? { history } : {}),
    ...(lookups ? { lookups } : {}),
  };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const mapOf = (v, ok) => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) : {});
const stringMap = (v) => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) : {});
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function parseHistory(h) {
  if (!isObject(h)) return {};
  const out = {};
  for (const [service, v] of Object.entries(h)) {
    if (!isObject(v)) continue;
    out[service] = {
      firstSeen: stringMap(v.firstSeen),
      departed: Array.isArray(v.departed) ? v.departed.filter((g) => isObject(g) && typeof g.id === 'string' && typeof g.title === 'string') : [],
    };
  }
  return out;
}

// Returns what to restore, or throws with a message for the user.
function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file isn't a Subscroll profile (it isn't valid JSON).");
  }
  if (!isObject(data) || data.format !== FORMAT || !isObject(data.state)) {
    throw new Error("This file isn't a Subscroll profile.");
  }
  if (data.version > VERSION) {
    throw new Error('This profile was exported by a newer version of Subscroll. Update the app, then import it.');
  }
  const s = data.state;
  const state = {
    subscriptions: stringMap(s.subscriptions),
    marks: Object.fromEntries(Object.entries(stringMap(s.marks)).filter(([, m]) => MARKS.has(m))),
    leaveDates: stringMap(s.leaveDates),
    customServices: Array.isArray(s.customServices) ? s.customServices.filter(isObject) : [],
    customGames: Array.isArray(s.customGames) ? s.customGames.filter(isObject) : [],
    costs: mapOf(s.costs, (c) => isObject(c) && Number(c.monthly) >= 0),
    priceOverrides: mapOf(s.priceOverrides, (x) => typeof x === 'number' && x >= 0),
    viaSub: mapOf(s.viaSub, (x) => typeof x === 'boolean'),
    ...(isObject(s.settings) ? { settings: s.settings } : {}),
  };
  // Added in version 2; a version 1 file leaves these as they are.
  if ('freebies' in s) state.freebies = Object.fromEntries(Object.entries(stringMap(s.freebies)).filter(([, m]) => FREE_MARKS.has(m)));
  if ('steam' in s) state.steam = isObject(s.steam) ? s.steam : null;
  if ('alertedLeaving' in s) state.alertedLeaving = strings(s.alertedLeaving);
  if ('freeKnown' in s) state.freeKnown = Array.isArray(s.freeKnown) ? strings(s.freeKnown) : null;
  if ('freeReminded' in s) state.freeReminded = strings(s.freeReminded);
  if (typeof s.trayHintShown === 'boolean') state.trayHintShown = s.trayHintShown;
  const lookups = {};
  for (const k of LOOKUPS) if (data.lookups && isObject(data.lookups[k])) lookups[k] = mapOf(data.lookups[k], isObject);
  return {
    version: Number(data.version) || 1,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    state,
    history: parseHistory(data.history),
    lookups,
  };
}

// A list's history after import: the earliest join date wins, and departed
// games from both are kept.
function mergeHistory(local = {}, incoming = {}, max = 300) {
  const firstSeen = { ...(local.firstSeen || {}) };
  for (const [id, day] of Object.entries(incoming.firstSeen || {})) {
    if (!firstSeen[id] || day < firstSeen[id]) firstSeen[id] = day;
  }
  const ids = new Set((local.departed || []).map((g) => g.id));
  const departed = [...(local.departed || []), ...(incoming.departed || []).filter((g) => !ids.has(g.id))]
    .sort((a, b) => (b.leftOn || '').localeCompare(a.leftOn || ''))
    .slice(0, max);
  return { firstSeen, departed };
}

// Looked-up entries this PC doesn't have yet; what it has stays.
function mergeLookups(local, incoming) {
  let added = 0;
  for (const [k, v] of Object.entries(incoming || {})) {
    if (local[k]) continue;
    local[k] = v;
    added++;
  }
  return added;
}

const backupName = (now = new Date()) => `subscroll-profile-${now.toISOString().slice(0, 10)}.json`;

module.exports = { makeBackup, parseBackup, mergeHistory, mergeLookups, backupName, LOOKUPS };
