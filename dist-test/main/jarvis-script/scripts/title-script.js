"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuiltinTitleScript = void 0;
class BuiltinTitleScript {
    options;
    id = "builtin-title";
    name = "标签标题脚本";
    enabled = true;
    constructor(options) {
        this.options = options;
    }
    matches(event) {
        return event.name === "page:title";
    }
    async handle(event) {
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
exports.BuiltinTitleScript = BuiltinTitleScript;
