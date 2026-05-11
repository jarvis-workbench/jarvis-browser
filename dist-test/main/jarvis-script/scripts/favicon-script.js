"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BuiltinFaviconScript = void 0;
const favicon_cache_1 = require("../../favicon-cache");
class BuiltinFaviconScript {
    options;
    id = "builtin-favicon";
    name = "站点图标脚本";
    enabled = true;
    declaredLinks = new Map();
    cachedUrls = new Map();
    viewCapturePages = new Map();
    completedSites = new Set();
    constructor(options) {
        this.options = options;
    }
    matches(event) {
        return event.name === "page:html"
            || event.name === "network:response"
            || event.name === "network:responseBody";
    }
    needsResponseBody(event) {
        const siteId = event.context.siteId;
        if (!siteId || this.shouldSkipSite(siteId)) {
            return false;
        }
        const capturePageUrl = this.viewCapturePages.get(event.context.viewKey);
        if (!capturePageUrl || !sameUrl(capturePageUrl, event.context.pageUrl)) {
            return false;
        }
        if (!this.options.isPageSuccessful(event.context.viewKey, capturePageUrl)) {
            return false;
        }
        return this.findDeclaredLink(event.context.viewKey, event.payload.url) !== undefined;
    }
    getResponseBodyRequests(event) {
        if (event.name !== "page:html") {
            return [];
        }
        const siteId = event.context.siteId;
        if (!siteId || this.shouldSkipSite(siteId)) {
            return [];
        }
        const capturePageUrl = this.viewCapturePages.get(event.context.viewKey);
        if (!capturePageUrl || !sameUrl(capturePageUrl, event.context.pageUrl)) {
            return [];
        }
        const links = this.declaredLinks.get(event.context.viewKey);
        if (!links) {
            return [];
        }
        return [...links.values()]
            .filter((link) => this.cachedUrls.get(event.context.viewKey) !== link.url)
            .map((link) => ({
            requestId: `declared:${link.url}`,
            url: link.url,
            resourceType: "Image",
        }));
    }
    async handle(event) {
        if (event.name === "page:html") {
            await this.handlePageHtml(event);
            return;
        }
        if (event.name === "network:response") {
            return;
        }
        if (event.name === "network:responseBody") {
            await this.handleResponseBody(event);
        }
    }
    async handlePageHtml(event) {
        const siteId = event.context.siteId;
        if (!siteId || this.shouldSkipSite(siteId)) {
            this.clearView(event.context.viewKey);
            return;
        }
        if (!this.options.isPageSuccessful(event.context.viewKey, event.payload.pageUrl)) {
            return;
        }
        const capturePageUrl = this.viewCapturePages.get(event.context.viewKey);
        if (capturePageUrl && !sameUrl(capturePageUrl, event.payload.pageUrl)) {
            return;
        }
        this.viewCapturePages.set(event.context.viewKey, event.payload.pageUrl);
        for (const declaredHref of extractDeclaredFaviconHrefs(event.payload.html)) {
            const normalized = normalizeFaviconUrl(declaredHref, event.payload.pageUrl);
            if (!normalized) {
                continue;
            }
            if (/^data:/i.test(normalized)) {
                const faviconPath = await (0, favicon_cache_1.cacheSiteFaviconDataUrl)(siteId, normalized);
                await this.options.store.updateSiteMetadata(siteId, { faviconUrl: normalized, faviconPath });
                this.completeSite(siteId, event.context.viewKey);
                this.options.emitMetadataUpdate();
                return;
            }
            this.trackDeclaredLink(event.context.viewKey, normalized, event.payload.pageUrl);
        }
    }
    async handleResponseBody(event) {
        const siteId = event.context.siteId;
        if (!siteId || this.shouldSkipSite(siteId)) {
            this.clearView(event.context.viewKey);
            return;
        }
        const declaredLink = this.findDeclaredLink(event.context.viewKey, event.payload.url);
        if (!declaredLink || this.cachedUrls.get(event.context.viewKey) === event.payload.url) {
            return;
        }
        const capturePageUrl = this.viewCapturePages.get(event.context.viewKey);
        if (!capturePageUrl || !sameUrl(capturePageUrl, declaredLink.pageUrl)) {
            return;
        }
        if (!this.options.isPageSuccessful(event.context.viewKey, declaredLink.pageUrl)) {
            return;
        }
        const faviconPath = await (0, favicon_cache_1.cacheSiteFaviconBytes)(siteId, event.payload.url, event.payload.bytes, event.payload.mimeType);
        if (!this.options.isPageSuccessful(event.context.viewKey, declaredLink.pageUrl)) {
            return;
        }
        this.cachedUrls.set(event.context.viewKey, event.payload.url);
        await this.options.store.updateSiteMetadata(siteId, {
            faviconUrl: event.payload.url,
            faviconPath,
        });
        this.completeSite(siteId, event.context.viewKey);
        this.options.emitMetadataUpdate();
    }
    trackDeclaredLink(viewKey, url, pageUrl) {
        if (this.cachedUrls.get(viewKey) === url) {
            return;
        }
        const declaredLinks = this.declaredLinks.get(viewKey) ?? new Map();
        declaredLinks.set(url, { url, pageUrl });
        while (declaredLinks.size > 60) {
            const firstKey = declaredLinks.keys().next().value;
            if (!firstKey) {
                break;
            }
            declaredLinks.delete(firstKey);
        }
        this.declaredLinks.set(viewKey, declaredLinks);
    }
    findDeclaredLink(viewKey, url) {
        const declaredLinks = this.declaredLinks.get(viewKey);
        if (!declaredLinks) {
            return undefined;
        }
        const exact = declaredLinks.get(url);
        if (exact) {
            return exact;
        }
        const normalized = normalizeComparableUrl(url);
        for (const [declaredUrl, declaredLink] of declaredLinks) {
            if (normalizeComparableUrl(declaredUrl) === normalized) {
                return declaredLink;
            }
        }
        return undefined;
    }
    shouldSkipSite(siteId) {
        if (this.completedSites.has(siteId)) {
            return true;
        }
        const site = this.options.store.getSite(siteId);
        if (!site || site.faviconPath || site.faviconUrl) {
            this.completedSites.add(siteId);
            return true;
        }
        return false;
    }
    completeSite(siteId, viewKey) {
        this.completedSites.add(siteId);
        this.clearView(viewKey);
    }
    clearView(viewKey) {
        this.declaredLinks.delete(viewKey);
        this.cachedUrls.delete(viewKey);
        this.viewCapturePages.delete(viewKey);
    }
}
exports.BuiltinFaviconScript = BuiltinFaviconScript;
function sameUrl(left, right) {
    return normalizeComparableUrl(left) === normalizeComparableUrl(right);
}
function normalizeComparableUrl(url) {
    try {
        return new URL(url).toString();
    }
    catch {
        return url;
    }
}
function normalizeFaviconUrl(faviconUrl, pageUrl) {
    if (/^data:/i.test(faviconUrl)) {
        return faviconUrl;
    }
    try {
        return new URL(faviconUrl, pageUrl).toString();
    }
    catch {
        return undefined;
    }
}
function extractDeclaredFaviconHrefs(html) {
    const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
    const headHtml = headMatch?.[1] ?? "";
    const hrefs = [];
    for (const match of headHtml.matchAll(/<link\b[^>]*>/gi)) {
        const tag = match[0];
        const rels = getHtmlAttribute(tag, "rel")?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        if (!rels.includes("icon")
            && !rels.includes("apple-touch-icon")
            && !rels.includes("apple-touch-icon-precomposed")
            && !rels.includes("mask-icon")) {
            continue;
        }
        const href = getHtmlAttribute(tag, "href");
        if (href) {
            hrefs.push(href);
        }
    }
    return hrefs;
}
function getHtmlAttribute(tag, name) {
    const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
    const match = tag.match(pattern);
    return match?.[1] ?? match?.[2] ?? match?.[3];
}
