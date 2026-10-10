const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { verifyPackagedApp } = require('./verify-packaged-app.cjs');

test('packaged checks reject missing shared modules and default macOS icons', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-package-check-'));
  const source = path.join(root, 'source');
  const resources = path.join(root, 'App.app/Contents/Resources');
  const files = {
    'package.json': JSON.stringify({ version: '0.1.8', main: 'dist/main/main.js' }),
    'dist/main/main.js': 'require("../shared/utils");',
    'dist/preload/preload.js': '',
    'dist/preload/web-page-preload.js': '',
    'dist/shared/utils.js': '',
    'dist/shared/session-partitions.js': '',
    'dist/renderer/index.html': '<html></html>',
    'assets/app-icon.png': 'png',
  };
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(source, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    fs.mkdirSync(path.join(resources, 'internal-pages'), { recursive: true });
    for (const name of ['error.html', 'overlay.html']) fs.writeFileSync(path.join(resources, 'internal-pages', name), '<html></html>');
    const plist = path.join(resources, '..', 'Info.plist');
    fs.writeFileSync(plist, '<plist><key>CFBundleIconFile</key><string>icon.icns</string></plist>');
    fs.copyFileSync(path.join(__dirname, '../assets/app-icon.icns'), path.join(resources, 'icon.icns'));
    const archive = path.join(resources, 'app.asar');
    await asar.createPackage(source, archive);
    assert.doesNotThrow(() => verifyPackagedApp(resources, 'darwin', path.join(__dirname, '..')));

    fs.writeFileSync(plist, '<plist><key>CFBundleIconFile</key><string>electron.icns</string></plist>');
    assert.throws(() => verifyPackagedApp(resources, 'darwin', path.join(__dirname, '..')), /bundle must use the application icon/);

    fs.unlinkSync(path.join(source, 'dist/shared/utils.js'));
    await asar.createPackage(source, archive);
    assert.throws(() => verifyPackagedApp(resources, 'darwin', path.join(__dirname, '..')), /Missing packaged runtime file: dist\/shared\/utils\.js/);

    fs.writeFileSync(path.join(source, 'dist/shared/utils.js'), '');
    fs.writeFileSync(path.join(source, 'dist/main/main.js'), 'require("./missing-module");');
    await asar.createPackage(source, archive);
    assert.throws(() => verifyPackagedApp(resources, 'linux', path.join(__dirname, '..')), /Unresolved packaged import/);
  } finally {
    asar.uncacheAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
