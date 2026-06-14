import test from "node:test";
import assert from "node:assert/strict";
import { resolveNavigationTarget } from "../../main/browser-host/navigation-target";

test("adds https prefix for bare hostnames", () => {
  assert.deepEqual(resolveNavigationTarget("example.com"), {
    kind: "browser",
    url: "https://example.com/",
  });
});

test("adds https prefix for localhost with port", () => {
  assert.deepEqual(resolveNavigationTarget("localhost:3000"), {
    kind: "browser",
    url: "https://localhost:3000/",
  });
});

test("blocks data urls in browser navigation", () => {
  const result = resolveNavigationTarget("data:image/png;base64,AAAA");
  assert.equal(result.kind, "blocked");
  assert.equal(result.url, "data:image/png;base64,AAAA");
  assert.match(result.errorText, /data:/);
});

test("blocks blob urls in browser navigation", () => {
  const result = resolveNavigationTarget("blob:https://example.com/1234");
  assert.equal(result.kind, "blocked");
  assert.match(result.errorText, /blob:/);
});

test("blocks javascript urls in browser navigation", () => {
  const result = resolveNavigationTarget("javascript:alert(1)");
  assert.equal(result.kind, "blocked");
  assert.match(result.errorText, /javascript:/);
});

test("keeps file urls in browser navigation", () => {
  assert.deepEqual(resolveNavigationTarget("file:///tmp/a.png"), {
    kind: "browser",
    url: "file:///tmp/a.png",
  });
});

test("keeps about blank in browser navigation", () => {
  assert.deepEqual(resolveNavigationTarget("about:blank"), {
    kind: "browser",
    url: "about:blank",
  });
});

test("blocks other about pages in browser navigation", () => {
  const result = resolveNavigationTarget("about:srcdoc");
  assert.equal(result.kind, "blocked");
  assert.match(result.errorText, /about:srcdoc/);
});

test("routes mailto to external handler", () => {
  assert.deepEqual(resolveNavigationTarget("mailto:test@example.com"), {
    kind: "external",
    url: "mailto:test@example.com",
  });
});

test("routes custom schemes to external handler", () => {
  assert.deepEqual(resolveNavigationTarget("weixin://dl/chat"), {
    kind: "external",
    url: "weixin://dl/chat",
  });
});

test("blocks malformed urls", () => {
  const result = resolveNavigationTarget("not a real url %%");
  assert.equal(result.kind, "blocked");
  assert.match(result.errorText, /无法识别/);
});
