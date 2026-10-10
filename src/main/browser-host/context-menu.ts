import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { resolveNavigationTarget } from "./navigation-target";

type EditAction = "undo" | "redo" | "cut" | "copy" | "paste" | "delete" | "selectAll";

export interface PageContextMenuActions {
  isAlive(): boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  back(): void;
  forward(): void;
  reload(): void;
  edit(action: EditAction): void;
  openLink(url: string): void;
  copyText(text: string): void;
  download(url: string): void;
  copyImage(x: number, y: number): void;
  inspect(x: number, y: number): void;
}

export function createPageContextMenuTemplate(
  params: Pick<ContextMenuParams,
    "x" | "y" | "linkURL" | "srcURL" | "mediaType" | "hasImageContents"
    | "isEditable" | "selectionText" | "editFlags" | "mediaFlags">,
  actions: PageContextMenuActions,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  const item = (label: string, action: () => void, enabled = true): MenuItemConstructorOptions => ({
    label,
    enabled,
    click: () => {
      if (enabled && actions.isAlive()) {
        action();
      }
    },
  });
  const group = (...items: MenuItemConstructorOptions[]) => {
    if (template.length) {
      template.push({ type: "separator" });
    }
    template.push(...items);
  };

  if (params.linkURL) {
    group(
      item("在新标签页中打开链接", () => actions.openLink(params.linkURL),
        resolveNavigationTarget(params.linkURL).kind !== "blocked"),
      item("复制链接地址", () => actions.copyText(params.linkURL)),
    );
  }

  if (params.mediaType === "image" || params.mediaType === "canvas") {
    const imageItems = [
      item("复制图片", () => actions.copyImage(params.x, params.y), params.hasImageContents),
    ];
    if (params.srcURL) {
      imageItems.push(
        item("图片另存为…", () => actions.download(params.srcURL), params.hasImageContents),
        item("复制图片地址", () => actions.copyText(params.srcURL)),
      );
    }
    group(...imageItems);
  } else if ((params.mediaType === "video" || params.mediaType === "audio") && params.srcURL) {
    const mediaName = params.mediaType === "video" ? "视频" : "音频";
    group(
      item(`${mediaName}另存为…`, () => actions.download(params.srcURL), params.mediaFlags.canSave),
      item(`复制${mediaName}地址`, () => actions.copyText(params.srcURL)),
    );
  }

  const flags = params.editFlags;
  if (params.isEditable) {
    group(
      item("撤销", () => actions.edit("undo"), flags.canUndo),
      item("重做", () => actions.edit("redo"), flags.canRedo),
    );
    group(
      item("剪切", () => actions.edit("cut"), flags.canCut),
      item("复制", () => actions.edit("copy"), flags.canCopy),
      item("粘贴", () => actions.edit("paste"), flags.canPaste),
      item("删除", () => actions.edit("delete"), flags.canDelete),
      item("全选", () => actions.edit("selectAll"), flags.canSelectAll),
    );
  } else if (params.selectionText) {
    group(item("复制", () => actions.edit("copy"), flags.canCopy));
  }

  if (!template.length) {
    group(
      item("后退", () => actions.back(), actions.canGoBack),
      item("前进", () => actions.forward(), actions.canGoForward),
      item("重新加载", () => actions.reload()),
    );
  }

  group(item("检查元素", () => actions.inspect(params.x, params.y)));
  return template;
}
