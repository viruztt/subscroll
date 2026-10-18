const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const linux = require('../src/linux');
const Play = require('../renderer/play');

test('Linux: start at login writes and removes an autostart entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));
  const file = linux.autostartFile(dir, { XDG_CONFIG_HOME: path.join(dir, 'cfg') });
  assert.strictEqual(file, path.join(dir, 'cfg', 'autostart', 'subscroll.desktop'));
  assert.ok(linux.setAutostart(true, '/home/me/Apps/Subscroll 0.4.0.AppImage', file));
  const entry = fs.readFileSync(file, 'utf8');
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /\nExec="\/home\/me\/Apps\/Subscroll 0\.4\.0\.AppImage" --hidden\n/);
  assert.ok(linux.setAutostart(false, null, file));
  assert.ok(!fs.existsSync(file));
  assert.match(linux.desktopEntry('/opt/Subscroll.AppImage'), /\nExec=\/opt\/Subscroll\.AppImage --hidden\n/);
});

test('Linux: Steam installed games from appmanifest files in every library', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-'));
  assert.strictEqual(linux.steamInstalled(620, home), null); // no Steam
  const root = path.join(home, '.local', 'share', 'Steam');
  const extra = path.join(home, 'games', 'SteamLibrary');
  fs.mkdirSync(path.join(root, 'steamapps'), { recursive: true });
  fs.mkdirSync(path.join(extra, 'steamapps'), { recursive: true });
  fs.writeFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${root}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${extra}"\n\t}\n}\n`);
  fs.writeFileSync(path.join(root, 'steamapps', 'appmanifest_620.acf'), '"AppState" {}');
  fs.writeFileSync(path.join(extra, 'steamapps', 'appmanifest_1145360.acf'), '"AppState" {}');
  assert.strictEqual(linux.steamInstalled(620, home), true);
  assert.strictEqual(linux.steamInstalled(1145360, home), true);
  assert.strictEqual(linux.steamInstalled(400, home), false);
  assert.strictEqual(linux.steamInstalled('x', home), null);
});

test('Play buttons: no Xbox app button outside Windows', () => {
  const g = { offers: [{ id: 'gamepass:9NBLGGH4R315', service: 'gamepass', platforms: ['pc'] }] };
  assert.strictEqual(Play.playActions(g).length, 1);
  assert.strictEqual(Play.playActions(g, { platform: 'linux' }).length, 0);
});
