import test from "node:test";
import assert from "node:assert/strict";
import type { BrowserTab } from "../../shared/types";
import { isBrowserCloseTabShortcut, resolveNextActiveTabIdAfterClose } from "../../main/browser-host/navigation";

test("recognizes ctrl or meta w as close tab shortcut", () => {
  assert.equal(isBrowserCloseTabShortcut({
    type: "keyDown",
    key: "w",
    code: "KeyW",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  } as Electron.Input), true);

  assert.equal(isBrowserCloseTabShortcut({
    type: "keyDown",
    key: "W",
    code: "KeyW",
    control: false,
    meta: true,
    shift: false,
    alt: false,
  } as Electron.Input), true);
});

test("does not treat modified or keyup w as close tab shortcut", () => {
  assert.equal(isBrowserCloseTabShortcut({
    type: "keyDown",
    key: "w",
    code: "KeyW",
    control: true,
    meta: false,
    shift: true,
    alt: false,
  } as Electron.Input), false);

  assert.equal(isBrowserCloseTabShortcut({
    type: "keyUp",
    key: "w",
    code: "KeyW",
    control: true,
    meta: false,
    shift: false,
    alt: false,
  } as Electron.Input), false);
});

test("closing a session page tab keeps activation inside the same session before same-site tabs", () => {
  const root = createTab("root", { siteId: "site-1", sessionId: "session-1" });
  const child = createTab("child", { siteId: "site-1", sessionId: "session-1", parentTabId: "root" });
  const otherSession = createTab("other-session", { siteId: "site-1", sessionId: "session-2" });
  const tabValues = new Map([root, child, otherSession].map((tab) => [tab.id, tab])).values();

  assert.equal(resolveNextActiveTabIdAfterClose(child, tabValues), root.id);
});

test("closing a session page tab prefers the nearest remaining tab in that session", () => {
  const root = createTab("root", { siteId: "site-1", sessionId: "session-1" });
  const child = createTab("child", { siteId: "site-1", sessionId: "session-1", parentTabId: "root" });
  const sibling = createTab("sibling", { siteId: "site-1", sessionId: "session-1", parentTabId: "root" });
  const otherSession = createTab("other-session", { siteId: "site-1", sessionId: "session-2" });

  assert.equal(resolveNextActiveTabIdAfterClose(child, [root, child, sibling, otherSession]), sibling.id);
});

function createTab(id: string, input: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    kind: "site",
    url: `https://example.com/${id}`,
    title: id,
    partition: "persist:test",
    pinnedExtensionIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
  };
}
