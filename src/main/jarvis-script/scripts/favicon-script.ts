import type { MetadataStore } from "../../store";
import { cacheSiteFaviconBytes, cacheSiteFaviconDataUrl } from "../../favicon-cache";
import type {
  JarvisMonitorEvent,
  JarvisMonitorScript,
  NetworkResponseBodyPayload,
  NetworkResponsePayload,
  PageHtmlPayload,
} from "../../browser-host/monitor/types";

interface FaviconScriptOptions {
  store: MetadataStore;
  emitMetadataUpdate: () => void;
  isPageSuccessful: (viewKey: string, pageUrl: string) => boolean;
}

interface DeclaredFaviconLink {
  url: string;
  pageUrl: string;
}

export class BuiltinFaviconScript implements JarvisMonitorScript {
  readonly id = "builtin-favicon";
  readonly name = "站点图标脚本";
  readonly enabled = true;
  private readonly declaredLinks = new Map<string, Map<string, DeclaredFaviconLink>>();
  private readonly cachedUrls = new Map<string, string>();
  private readonly viewCapturePages = new Map<string, string>();
  private readonly completedSites = new Set<string>();

  constructor(private readonly options: FaviconScriptOptions) {}

  matches(event: JarvisMonitorEvent) {
    return event.name === "page:html"
      || event.name === "network:response"
      || event.name === "network:responseBody";
  }

  needsResponseBody(event: JarvisMonitorEvent<NetworkResponsePayload>) {
    if (this.shouldSkipSite(event.context.siteId)) {
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

  getResponseBodyRequests(event: JarvisMonitorEvent) {
    if (event.name !== "page:html") {
      return [];
    }

    if (this.shouldSkipSite(event.context.siteId)) {
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

  async handle(event: JarvisMonitorEvent<PageHtmlPayload | NetworkResponseBodyPayload>) {
    if (event.name === "page:html") {
      await this.handlePageHtml(event as JarvisMonitorEvent<PageHtmlPayload>);
      return;
    }

    if (event.name === "network:response") {
      return;
    }

    if (event.name === "network:responseBody") {
      await this.handleResponseBody(event as JarvisMonitorEvent<NetworkResponseBodyPayload>);
    }
  }

  private async handlePageHtml(event: JarvisMonitorEvent<PageHtmlPayload>) {
    if (this.shouldSkipSite(event.context.siteId)) {
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
        const faviconPath = await cacheSiteFaviconDataUrl(event.context.siteId, normalized);
        await this.options.store.updateSiteMetadata(event.context.siteId, { faviconUrl: normalized, faviconPath });
        this.completeSite(event.context.siteId, event.context.viewKey);
        this.options.emitMetadataUpdate();
        return;
      }

      this.trackDeclaredLink(event.context.viewKey, normalized, event.payload.pageUrl);
    }
  }

  private async handleResponseBody(event: JarvisMonitorEvent<NetworkResponseBodyPayload>) {
    if (this.shouldSkipSite(event.context.siteId)) {
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

    const faviconPath = await cacheSiteFaviconBytes(
      event.context.siteId,
      event.payload.url,
      event.payload.bytes,
      event.payload.mimeType,
    );
    if (!this.options.isPageSuccessful(event.context.viewKey, declaredLink.pageUrl)) {
      return;
    }

    this.cachedUrls.set(event.context.viewKey, event.payload.url);
    await this.options.store.updateSiteMetadata(event.context.siteId, {
      faviconUrl: event.payload.url,
      faviconPath,
    });
    this.completeSite(event.context.siteId, event.context.viewKey);
    this.options.emitMetadataUpdate();
  }

  private trackDeclaredLink(viewKey: string, url: string, pageUrl: string) {
    if (this.cachedUrls.get(viewKey) === url) {
      return;
    }

    const declaredLinks = this.declaredLinks.get(viewKey) ?? new Map<string, DeclaredFaviconLink>();
    declaredLinks.set(url, { url, pageUrl });
    while (declaredLinks.size > 60) {
      const firstKey = declaredLinks.keys().next().value as string | undefined;
      if (!firstKey) {
        break;
      }
      declaredLinks.delete(firstKey);
    }
    this.declaredLinks.set(viewKey, declaredLinks);
  }

  private findDeclaredLink(viewKey: string, url: string) {
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

  private shouldSkipSite(siteId: string) {
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

  private completeSite(siteId: string, viewKey: string) {
    this.completedSites.add(siteId);
    this.clearView(viewKey);
  }

  private clearView(viewKey: string) {
    this.declaredLinks.delete(viewKey);
    this.cachedUrls.delete(viewKey);
    this.viewCapturePages.delete(viewKey);
  }
}

function sameUrl(left: string, right: string) {
  return normalizeComparableUrl(left) === normalizeComparableUrl(right);
}

function normalizeComparableUrl(url: string) {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

function normalizeFaviconUrl(faviconUrl: string, pageUrl: string) {
  if (/^data:/i.test(faviconUrl)) {
    return faviconUrl;
  }

  try {
    return new URL(faviconUrl, pageUrl).toString();
  } catch {
    return undefined;
  }
}

function extractDeclaredFaviconHrefs(html: string) {
  const headMatch = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const headHtml = headMatch?.[1] ?? "";
  const hrefs: string[] = [];
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

function getHtmlAttribute(tag: string, name: string) {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + "`" + `]+))`, "i");
  const match = tag.match(pattern);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
