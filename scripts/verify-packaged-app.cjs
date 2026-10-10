const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

function verifyPackagedApp(resources, platform, projectDir) {
  const archive = path.join(resources, 'app.asar');
  asar.uncache(archive);
  const entries = new Set(asar.listPackage(archive).map(entry => entry.replaceAll('\\', '/').replace(/^\//, '')));
  const read = name => asar.extractFile(archive, name);
  for (const name of [
    'package.json', 'dist/main/main.js', 'dist/preload/preload.js',
    'dist/preload/web-page-preload.js', 'dist/shared/utils.js',
    'dist/shared/session-partitions.js', 'dist/renderer/index.html', 'assets/app-icon.png',
  ]) {
    assert.ok(entries.has(name), `Missing packaged runtime file: ${name}`);
  }
  const metadata = JSON.parse(read('package.json'));
  assert.ok(entries.has(metadata.main), `Missing application entry: ${metadata.main}`);

  // Check the compiled application imports inside ASAR, rather than the build folder.
  for (const entry of entries) {
    if (!/^dist\/(main|preload|shared)\/.*\.js$/.test(entry)) continue;
    const source = read(entry).toString('utf8');
    for (const match of source.matchAll(/\brequire\(["'](\.[^"']*)["']\)/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry), match[1]));
      const candidates = [target, `${target}.js`, `${target}.json`, `${target}/index.js`];
      assert.ok(candidates.some(candidate => entries.has(candidate)), `Unresolved packaged import: ${entry} -> ${match[1]}`);
    }
  }
  for (const name of ['error.html', 'overlay.html']) {
    assert.ok(fs.existsSync(path.join(resources, 'internal-pages', name)), `Missing internal page: ${name}`);
  }
  if (platform === 'darwin') {
    const plist = fs.readFileSync(path.join(resources, '..', 'Info.plist'), 'utf8');
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/, 'macOS bundle must use the application icon');
    assert.ok(fs.readFileSync(path.join(resources, 'icon.icns')).equals(
      fs.readFileSync(path.join(projectDir, 'assets', 'app-icon.icns')),
    ), 'macOS bundle icon differs from the project icon');
  }
  console.log(`[package-check] Verified runtime imports, resources and icon for ${platform} ${metadata.version}`);
}

module.exports = async context => {
  verifyPackagedApp(
    context.packager.getResourcesDir(context.appOutDir),
    context.electronPlatformName,
    context.packager.projectDir,
  );
};
module.exports.verifyPackagedApp = verifyPackagedApp;
