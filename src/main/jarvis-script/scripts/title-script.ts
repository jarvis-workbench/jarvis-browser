import type { MetadataStore } from "../../store";
import type { JarvisMonitorEvent, JarvisMonitorScript, PageTitlePayload } from "../../browser-host/monitor/types";

interface TitleScriptOptions {
  store: MetadataStore;
  emitMetadataUpdate: () => void;
  emitBrowserState: (viewKey?: string, errorText?: string) => void;
}

export class BuiltinTitleScript implements JarvisMonitorScript {
  readonly id = "builtin-title";
  readonly name = "标签标题脚本";
  readonly enabled = true;

  constructor(private readonly options: TitleScriptOptions) {}

  matches(event: JarvisMonitorEvent) {
    return event.name === "page:title";
  }

  async handle(event: JarvisMonitorEvent<PageTitlePayload>) {
    if (!event.context.siteId) {
      return;
    }

    const title = event.payload.title.trim();
    if (!title) {
      return;
    }

    await this.options.store.fillMissingSiteTitle(event.context.siteId, title);
    this.options.emitMetadataUpdate();
    this.options.emitBrowserState(event.context.viewKey);
  }
}
