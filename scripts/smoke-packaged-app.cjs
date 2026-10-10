const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

async function smokeTest(executable) {
  assert.ok(executable && fs.existsSync(executable), 'Packaged executable is required');
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-package-smoke-'));
  const env = { ...process.env, JARVIS_BROWSER_DATA_ROOT: profile, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  child.stdout.on('data', data => { logs = (logs + data).slice(-16000); });
  child.stderr.on('data', data => { logs = (logs + data).slice(-16000); });
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.ok(child.exitCode === null, `Packaged app exited before startup: ${logs}`);
      assert.doesNotMatch(logs, /Cannot find module|Uncaught Exception|A JavaScript error occurred in the main process/);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
        const pages = (await response.json()).filter(target => target.type === 'page');
        const shell = pages.find(target => target.url.startsWith('file:') && target.url.includes('/dist/renderer/index.html') && target.title);
        const newtab = pages.find(target => target.url.startsWith('jarvis-browser://newtab') && target.title);
        if (shell && newtab) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          assert.equal(child.exitCode, null);
          assert.doesNotMatch(logs, /Cannot find module|Uncaught Exception/);
          console.log('[startup-check] Packaged shell and BrowserView start page opened successfully');
          return;
        }
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`Packaged app did not open its shell and start page: ${logs}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    const exited = await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!exited) {
      child.kill('SIGKILL');
      await closed;
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

smokeTest(process.argv[2]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
