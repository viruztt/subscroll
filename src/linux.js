// Linux counterparts of the Windows-only bits: starting at login and asking
// Steam whether a game is installed.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- start at login: a .desktop file in ~/.config/autostart ----
function autostartFile(home = os.homedir(), env = process.env) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(config, 'autostart', 'subscroll.desktop');
}

// The AppImage moves with each download, so the entry is written again on every launch.
function desktopEntry(exe) {
  const quoted = /[\s"'\\$`]/.test(exe) ? `"${exe.replace(/(["\\$`])/g, '\\$1')}"` : exe;
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Subscroll',
    'Comment=Every game you already pay for, in one place.',
    `Exec=${quoted} --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

function setAutostart(on, exe, file = autostartFile()) {
  try {
    if (on && exe) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, desktopEntry(exe));
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Steam: installed games have an appmanifest_<id>.acf in a library's steamapps ----
// Native, Debian/Ubuntu symlink and Flatpak installs.
function steamRoots(home = os.homedir()) {
  return [
    path.join(home, '.steam', 'steam'),
    path.join(home, '.local', 'share', 'Steam'),
    path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
  ].filter((p) => fs.existsSync(path.join(p, 'steamapps')));
}

// Every library folder listed in libraryfolders.vdf ("path" "/mnt/games/SteamLibrary").
function libraries(root) {
  const out = [root];
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) out.push(m[1].replace(/\\\\/g, '\\'));
  } catch {
    // Only the main library then.
  }
  return [...new Set(out)];
}

// true / false when Steam is here, null when it isn't (can't tell).
function steamInstalled(appid, home = os.homedir()) {
  if (!/^\d+$/.test(String(appid))) return null;
  const roots = steamRoots(home);
  if (!roots.length) return null;
  for (const root of roots) {
    for (const lib of libraries(root)) {
      if (fs.existsSync(path.join(lib, 'steamapps', `appmanifest_${appid}.acf`))) return true;
    }
  }
  return false;
}

module.exports = { autostartFile, desktopEntry, setAutostart, steamRoots, libraries, steamInstalled };
