import test from "node:test";
import assert from "node:assert/strict";
import { isBrowserCloseTabShortcut } from "../../main/browser-host/navigation";

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
