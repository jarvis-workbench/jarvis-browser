import test from "node:test";
import assert from "node:assert/strict";
import { configureLocalRendererSession } from "../../main/renderer-session";

test("local dev renderer bypasses system proxy discovery", async () => {
  for (const url of ["http://127.0.0.1:5180", "http://localhost:5180", "http://[::1]:5180", "https://127.0.0.2"]) {
    const calls: unknown[] = [];
    await configureLocalRendererSession({ setProxy: async (config) => { calls.push(config); } }, url);
    assert.deepEqual(calls, [{ mode: "direct" }], url);
  }
});

test("remote dev servers and non-HTTP URLs retain their proxy configuration", async () => {
  for (const url of ["https://dev.example.com", "http://192.168.1.10:5180", "http://localhost.example.com", "file:///index.html"]) {
    await configureLocalRendererSession({ setProxy: async () => { assert.fail(url); } }, url);
  }
});

test("waits for proxy configuration before allowing the page to load", async () => {
  let release!: () => void;
  let ready = false;
  const configured = new Promise<void>((resolve) => { release = resolve; });
  const result = configureLocalRendererSession({ setProxy: () => configured }, "http://127.0.0.1:5180")
    .then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  release();
  await result;
  assert.equal(ready, true);
});
