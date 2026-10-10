const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

const [input, output, version] = process.argv.slice(2);
assert.match(version, /^\d+\.\d+\.\d+$/);
const prefix = `Jarvis-Browser-${version}`;
const macFiles = (arch) => ['dmg', 'zip'].flatMap(extension => [
  `${prefix}-mac-${arch}.${extension}`, `${prefix}-mac-${arch}.${extension}.blockmap`,
]);
const artifacts = [
  { name: 'jarvis-browser-mac-x64', files: macFiles('x64'), feed: 'latest-mac.yml' },
  { name: 'jarvis-browser-mac-arm64', files: macFiles('arm64'), feed: 'latest-mac.yml' },
  { name: 'jarvis-browser-win-x64', files: [`${prefix}-win-x64-setup.exe`, `${prefix}-win-x64-setup.exe.blockmap`], feed: 'latest.yml' },
  { name: 'jarvis-browser-linux-x64', files: [`${prefix}-linux-x64.zip`, `${prefix}-linux-x86_64.AppImage`], feed: 'latest-linux.yml' },
];
fs.mkdirSync(output, { recursive: true });
const feeds = new Map();

function findFiles(directory, wanted, found = new Map()) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      findFiles(file, wanted, found);
    } else if (entry.isFile() && wanted.has(entry.name)) {
      assert.ok(!found.has(entry.name), `Duplicate file: ${entry.name}`);
      found.set(entry.name, file);
    }
  }
  return found;
}

for (const artifact of artifacts) {
  const found = findFiles(path.join(input, artifact.name), new Set([...artifact.files, artifact.feed]));
  for (const name of artifact.files) {
    assert.ok(found.has(name), `Missing asset: ${name}`);
    assert.ok(fs.statSync(found.get(name)).size > 0, `Empty asset: ${name}`);
    fs.copyFileSync(found.get(name), path.join(output, name));
  }
  assert.ok(found.has(artifact.feed), `Missing feed: ${artifact.feed}`);
  const info = yaml.load(fs.readFileSync(found.get(artifact.feed), 'utf8'));
  assert.equal(info.version, version, `Incorrect version: ${artifact.feed}`);
  // Each macOS runner may emit both architectures; retain its own architecture.
  info.files = info.files.filter(file => artifact.files.includes(file.url));
  assert.ok(info.files.length > 0, `Empty feed: ${artifact.feed}`);
  const existing = feeds.get(artifact.feed);
  if (existing) {
    existing.files.push(...info.files);
  } else {
    feeds.set(artifact.feed, info);
  }
}

const macFeed = feeds.get('latest-mac.yml');
for (const arch of ['arm64', 'x64']) {
  assert.ok(macFeed.files.some(file => file.url === `${prefix}-mac-${arch}.zip`), `Missing macOS update ZIP: ${arch}`);
}
for (const [name, info] of feeds) {
  const primary = info.files.find(file => file.url === info.path) || info.files[0];
  info.path = primary.url;
  info.sha512 = primary.sha512;
  const seen = new Set();
  for (const file of info.files) {
    assert.ok(!seen.has(file.url), `Duplicate feed entry: ${file.url}`);
    seen.add(file.url);
    const data = fs.readFileSync(path.join(output, file.url));
    assert.equal(data.length, file.size, `Size mismatch: ${file.url}`);
    assert.equal(crypto.createHash('sha512').update(data).digest('base64'), file.sha512, `Checksum mismatch: ${file.url}`);
    console.log('Verified', file.url, data.length);
  }
  fs.writeFileSync(path.join(output, name), yaml.dump(info, { lineWidth: -1 }));
}
assert.equal(fs.readdirSync(output).length, artifacts.reduce((count, artifact) => count + artifact.files.length, 0) + feeds.size);
console.log(`Prepared ${fs.readdirSync(output).length} verified release files`);
