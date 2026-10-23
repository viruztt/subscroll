// Sync between devices through a folder that Google Drive, OneDrive, Dropbox,
// iCloud or Syncthing keeps the same everywhere. Nothing is hosted: each
// device writes its own file into the folder (subscroll-<device>.sync.json),
// so the drive never sees two devices writing one file, and reads everyone
// else's.
//
// Every value carries the time it last changed on any device. When devices
// disagree, the newest change wins, one item at a time: each game's mark, note,
// hours and finish date, each plan, each setting. Removing something is a
// change too, kept as "removed at <time>", so it syncs like any other.
//
// Synced: plans, marks, notes, Value page costs, finish dates, goals, own
// services and games, settings (apart from ones about this device) and the
// prediction log. Steam, Xbox and PlayStation links hold keys, so they sync
// only when you ask. Catalogues and looked-up scores and prices aren't synced:
// each device fetches its own.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'subscroll-sync';
const VERSION = 1;
// Fields whose items merge one by one.
const PER_KEY = ['subscriptions', 'marks', 'leaveDates', 'costs', 'priceOverrides', 'viaSub', 'notes', 'finishedOn', 'freebies', 'predictionLog', 'settings'];
// Fields that merge as a whole.
const WHOLE = ['customServices', 'customGames', 'goals'];
// Links with keys in them: only when the user ticks the box.
const ACCOUNTS = ['steam', 'xbox', 'psn'];
// Settings that belong to one device.
const DEVICE_SETTINGS = new Set(['startWithWindows', 'closeToTray', 'autoUpdate', 'syncFolder', 'syncAccounts']);
const EPOCH = '1970-01-01T00:00:00.000Z';
const FILE = /^subscroll-([a-z0-9]{6,40})\.sync\.json$/;
// Removed items are remembered this long, so a device that's been away a while still hears of them.
const KEEP_REMOVED_DAYS = 400;
const POLL_MS = 60000;
const WRITE_DELAY_MS = 2000;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fieldOf = (key) => key.slice(0, key.indexOf('|'));
const synced = (field, accounts) => PER_KEY.includes(field) || WHOLE.includes(field) || (accounts && ACCOUNTS.includes(field));
const emptyWhole = (field) => (ACCOUNTS.includes(field) ? null : []);

// The synced items of some fields, as "field|item" -> value.
function itemsOf(state, fields) {
  const out = new Map();
  for (const f of fields) {
    if (PER_KEY.includes(f)) {
      for (const [k, v] of Object.entries(isObject(state[f]) ? state[f] : {})) {
        if (v === undefined || v === null || (f === 'settings' && DEVICE_SETTINGS.has(k))) continue;
        out.set(`${f}|${k}`, v);
      }
    } else if (WHOLE.includes(f) || ACCOUNTS.includes(f)) {
      const v = state[f];
      if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) out.set(`${f}|`, v);
    }
  }
  return out;
}

// After a change: the new stamps. Items that changed get `at` (or, for items
// that came from another device, the time they changed there).
function stamp(prev, next, fields, stamps, at, from = new Map()) {
  const out = { ...stamps };
  const before = itemsOf(prev, fields);
  const after = itemsOf(next, fields);
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (!same(before.get(key), after.get(key))) out[key] = from.get(key) || at;
  }
  return out;
}

// What this device writes into the folder.
function makeFile(state, stamps, device, { accounts = false, now = new Date() } = {}) {
  const fields = [...PER_KEY, ...WHOLE, ...(accounts ? ACCOUNTS : [])];
  const items = itemsOf(state, fields);
  const cutoff = new Date(now - KEEP_REMOVED_DAYS * 86400000).toISOString();
  const entries = {};
  for (const [key, v] of items) entries[key] = { v, at: stamps[key] || EPOCH };
  for (const [key, at] of Object.entries(stamps)) {
    if (items.has(key) || !synced(fieldOf(key), accounts) || at < cutoff) continue;
    if (fieldOf(key) === 'settings' && DEVICE_SETTINGS.has(key.slice(9))) continue;
    entries[key] = { removed: true, at };
  }
  return { format: FORMAT, version: VERSION, device, writtenAt: now.toISOString(), accounts, entries };
}

function parseFile(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.format !== FORMAT || data.version > VERSION || !isObject(data.entries) || !isObject(data.device)) return null;
  return data;
}

// Another device's items that are newer than this one's. Returns the patch to
// apply and the times those items changed. When both changed an item at the
// same moment (or neither knows when, as with data from before syncing), a
// device joining the folder takes the folder's version, and otherwise the
// device with the larger id wins, so every device settles on the same one.
function merge(state, stamps, files, { device, accounts = false, joining = false } = {}) {
  const fields = [...PER_KEY, ...WHOLE, ...(accounts ? ACCOUNTS : [])];
  const mine = itemsOf(state, fields);
  const times = { ...stamps };
  const values = new Map(mine);
  const from = new Map();
  for (const file of files) {
    if (!file || file.device?.id === device) continue;
    for (const [key, e] of Object.entries(file.entries)) {
      if (!isObject(e) || typeof e.at !== 'string' || !key.includes('|')) continue;
      const field = fieldOf(key);
      if (!synced(field, accounts) || (field === 'settings' && DEVICE_SETTINGS.has(key.slice(9)))) continue;
      const theirs = e.removed ? undefined : e.v;
      if (theirs === undefined && !e.removed) continue;
      if (same(values.get(key), theirs)) continue;
      const ours = times[key] || (values.has(key) ? EPOCH : null);
      const newer = ours === null || e.at > ours || (e.at === ours && (joining || String(file.device.id) > String(device)));
      if (!newer) continue;
      if (theirs === undefined) values.delete(key);
      else values.set(key, theirs);
      times[key] = e.at;
      from.set(key, e.at);
    }
  }
  if (!from.size) return { patch: null, from };
  const patch = {};
  for (const key of from.keys()) {
    const field = fieldOf(key);
    const item = key.slice(field.length + 1);
    if (PER_KEY.includes(field)) {
      if (!patch[field]) patch[field] = { ...(isObject(state[field]) ? state[field] : {}) };
      if (values.has(key)) patch[field][item] = values.get(key);
      else delete patch[field][item];
    } else {
      patch[field] = values.has(key) ? values.get(key) : emptyWhole(field);
    }
  }
  return { patch, from };
}

const SYNC_FIELDS = new Set([...PER_KEY, ...WHOLE, ...ACCOUNTS]);

class Sync {
  // store: src/store.js; onApplied(state, count) after other devices' changes came in;
  // onStatus(status) whenever the status changes.
  constructor(store, { onApplied = () => {}, onStatus = () => {}, name = os.hostname() } = {}) {
    this.store = store;
    this.onApplied = onApplied;
    this.onStatus = onStatus;
    this.name = name;
    this.from = new Map();
    this.seen = new Map();
    this.devices = [];
    this.lastSync = null;
    this.error = null;
    this.timer = null;
    this.writeTimer = null;
    // Every change gets its time, synced or not, so turning sync on later knows which is newer.
    store.beforeWrite = (prev, next, patch) => {
      const fields = Object.keys(patch).filter((f) => SYNC_FIELDS.has(f));
      if (!fields.length) return;
      next.syncStamps = stamp(prev, next, fields, prev.syncStamps || {}, new Date().toISOString(), this.from);
      if (this.folder() && !this.applying) this.scheduleWrite();
    };
  }

  folder() {
    return this.store.get().settings.syncFolder || null;
  }

  device() {
    let id = this.store.get().syncDevice;
    if (!id) {
      id = crypto.randomBytes(8).toString('hex');
      this.store.update({ syncDevice: id });
    }
    return id;
  }

  fileFor(id) {
    return path.join(this.folder(), `subscroll-${id}.sync.json`);
  }

  status() {
    return { folder: this.folder(), accounts: !!this.store.get().settings.syncAccounts, lastSync: this.lastSync, devices: this.devices, error: this.error, name: this.name };
  }

  start() {
    clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
    this.devices = [];
    this.error = null;
    if (!this.folder()) {
      this.onStatus(this.status());
      return;
    }
    this.timer = setInterval(() => this.pull(), POLL_MS);
    this.pull();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.writeTimer);
    this.timer = null;
  }

  // A couple of seconds after the first change, so a burst of changes is one write.
  scheduleWrite() {
    if (!this.writeTimer) this.writeTimer = setTimeout(() => this.write(), WRITE_DELAY_MS);
  }

  write() {
    clearTimeout(this.writeTimer);
    this.writeTimer = null;
    if (!this.folder()) return false;
    const state = this.store.get();
    const data = makeFile(state, state.syncStamps || {}, { id: this.device(), name: this.name }, { accounts: !!state.settings.syncAccounts });
    try {
      fs.mkdirSync(this.folder(), { recursive: true });
      const file = this.fileFor(this.device());
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
      this.seen.set(path.basename(file), fs.statSync(file).mtimeMs);
      this.error = null;
      return true;
    } catch (e) {
      this.error = e.message;
      this.onStatus(this.status());
      return false;
    }
  }

  // Reads the other devices' files that changed since last time, and takes
  // what's newer. Then writes this device's file.
  pull() {
    const dir = this.folder();
    if (!dir) return 0;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      this.error = e.code === 'ENOENT' ? `Folder not found: ${dir}` : e.message;
      this.onStatus(this.status());
      return 0;
    }
    const me = this.device();
    const files = [];
    const devices = [];
    for (const name of names) {
      const m = name.match(FILE);
      if (!m || m[1] === me) continue;
      let text;
      let mtime;
      try {
        mtime = fs.statSync(path.join(dir, name)).mtimeMs;
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const data = parseFile(text);
      // Half-synced or from a newer Subscroll: try again next time.
      if (!data) continue;
      devices.push({ id: m[1], name: String(data.device.name || m[1]), writtenAt: data.writtenAt || null });
      if (this.seen.get(name) === mtime) continue;
      this.seen.set(name, mtime);
      files.push(data);
    }
    const state = this.store.get();
    const joining = !state.syncJoined;
    const { patch, from } = merge(state, state.syncStamps || {}, files, { device: me, accounts: !!state.settings.syncAccounts, joining });
    let count = 0;
    if (patch) {
      count = from.size;
      this.from = from;
      this.applying = true;
      try {
        this.store.update(patch);
      } finally {
        this.applying = false;
        this.from = new Map();
      }
    }
    if (joining && devices.length) this.store.update({ syncJoined: true });
    this.devices = devices.sort((a, b) => a.name.localeCompare(b.name));
    if (this.write()) this.lastSync = new Date().toISOString();
    if (count) this.onApplied(this.store.get(), count);
    this.onStatus(this.status());
    return count;
  }
}

module.exports = { Sync, stamp, makeFile, parseFile, merge, itemsOf, EPOCH, DEVICE_SETTINGS };
