// electron-builder runs this after it packs the app. On a Mac it signs the app
// ad hoc ("-"), which needs no Apple certificate: Apple silicon Macs won't open
// an app with no signature at all, and electron-builder signs only with a
// certificate. People still have to allow it once, as the README explains.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
