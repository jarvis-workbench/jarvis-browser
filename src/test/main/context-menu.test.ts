import test from "node:test";
import assert from "node:assert/strict";
import type { MenuItemConstructorOptions } from "electron";
import { createPageContextMenuTemplate, type PageContextMenuActions } from "../../main/browser-host/context-menu";

type MenuParams = Parameters<typeof createPageContextMenuTemplate>[0];

function fixture(overrides: Partial<MenuParams> = {}) {
  const calls: unknown[] = [];
  let alive = true;
  const actions: PageContextMenuActions = {
    isAlive: () => alive,
    canGoBack: false,
    canGoForward: true,
    back: () => { calls.push("back"); },
    forward: () => { calls.push("forward"); },
    reload: () => { calls.push("reload"); },
    edit: (action) => { calls.push(["edit", action]); },
    openLink: (url) => { calls.push(["open", url]); },
    copyText: (text) => { calls.push(["text", text]); },
    download: (url) => { calls.push(["download", url]); },
    copyImage: (x, y) => { calls.push(["image", x, y]); },
    inspect: (x, y) => { calls.push(["inspect", x, y]); },
  };
  const params: MenuParams = {
    x: 12, y: 34, linkURL: "", srcURL: "", mediaType: "none",
    hasImageContents: false, isEditable: false, selectionText: "",
    editFlags: {
      canUndo: false, canRedo: false, canCut: false,
      canCopy: Boolean(overrides.selectionText) && !overrides.isEditable,
      canPaste: true, canDelete: false, canSelectAll: true, canEditRichly: false,
    },
    mediaFlags: {
      inError: false, isPaused: false, isMuted: false, hasAudio: false,
      isLooping: false, isControlsVisible: false, canToggleControls: false,
      canRotate: false, canSave: false, canPrint: false, canShowPictureInPicture: false,
      isShowingPictureInPicture: false, canLoop: false,
    },
    ...overrides,
  };
  const menu = createPageContextMenuTemplate(params, actions);
  const find = (label: string) => {
    const entry = menu.find((entry) => entry.label === label);
    assert.ok(entry, `missing menu item: ${label}`);
    return entry;
  };
  return { menu, find, calls, close: () => { alive = false; } };
}

// These callbacks do not use Electron's menu/window arguments.
function click(entry: MenuItemConstructorOptions) {
  assert.ok(entry.click);
  (entry.click as () => void)();
}

test("background menu uses navigation availability and the clicked inspect coordinates", () => {
  const { find, calls } = fixture();
  assert.equal(find("后退").enabled, false);
  assert.equal(find("前进").enabled, true);
  click(find("前进"));
  click(find("重新加载"));
  click(find("检查元素"));
  assert.deepEqual(calls, ["forward", "reload", ["inspect", 12, 34]]);
});

test("editable menu respects Chromium permissions, including protected selections", () => {
  const { find, calls, menu } = fixture({ isEditable: true, selectionText: "secret" });
  assert.equal(find("剪切").enabled, false);
  assert.equal(find("复制").enabled, false);
  assert.equal(find("撤销").enabled, false);
  assert.equal(find("粘贴").enabled, true);
  click(find("粘贴"));
  click(find("全选"));
  assert.deepEqual(calls, [["edit", "paste"], ["edit", "selectAll"]]);
  assert.equal(menu.some((entry) => entry.label === "重新加载"), false);
});

test("linked images retain link and image actions with the original URL and coordinates", () => {
  const { find, calls, menu } = fixture({
    linkURL: "https://example.com/link", srcURL: "https://example.com/image.png",
    mediaType: "image", hasImageContents: true,
  });
  click(find("在新标签页中打开链接"));
  click(find("复制链接地址"));
  click(find("复制图片"));
  click(find("图片另存为…"));
  assert.deepEqual(calls, [
    ["open", "https://example.com/link"], ["text", "https://example.com/link"],
    ["image", 12, 34], ["download", "https://example.com/image.png"],
  ]);
  assert.notEqual(menu[0].type, "separator");
  assert.notEqual(menu.at(-1)?.type, "separator");
  assert.equal(menu.some((entry, index) => entry.type === "separator" && menu[index + 1]?.type === "separator"), false);
});

test("selected page text offers copy without editable actions", () => {
  const { menu, find, calls } = fixture({ selectionText: "selected" });
  assert.deepEqual(menu.filter((entry) => entry.label).map((entry) => entry.label), ["复制", "检查元素"]);
  assert.equal(find("复制").enabled, true);
  click(find("复制"));
  assert.deepEqual(calls, [["edit", "copy"]]);
});

test("blocked link navigation stays disabled while the address can still be copied", () => {
  const { find, calls } = fixture({ linkURL: "javascript:alert(1)" });
  assert.equal(find("在新标签页中打开链接").enabled, false);
  assert.equal(find("复制链接地址").enabled, true);
  click(find("在新标签页中打开链接"));
  click(find("复制链接地址"));
  assert.deepEqual(calls, [["text", "javascript:alert(1)"]]);
});

test("menu callbacks do nothing after the source tab is closed or deactivated", () => {
  const { menu, calls, close } = fixture({ isEditable: true, linkURL: "https://example.com" });
  close();
  menu.filter((entry) => entry.click).forEach(click);
  assert.deepEqual(calls, []);
});
