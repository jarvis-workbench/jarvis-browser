export type JarvisMonitorEventName =
  | "page:title"
  | "page:html"
  | "network:request"
  | "network:response"
  | "network:responseBody"
  | "dom:message";

export interface JarvisMonitorContext {
  viewKey: string;
  siteId: string;
  sessionId: string;
  pageUrl: string;
}

export interface JarvisMonitorEvent<TPayload = unknown> {
  name: JarvisMonitorEventName;
  context: JarvisMonitorContext;
  payload: TPayload;
}

export interface PageTitlePayload {
  title: string;
}

export interface PageHtmlPayload {
  pageUrl: string;
  html: string;
}

export interface NetworkRequestPayload {
  requestId: string;
  url: string;
  method?: string;
  resourceType?: string;
}

export interface NetworkResponsePayload {
  requestId: string;
  url: string;
  status?: number;
  mimeType?: string;
  resourceType?: string;
}

export interface NetworkResponseBodyPayload extends NetworkResponsePayload {
  bytes: Buffer;
  base64Encoded: boolean;
}

export interface DomMessagePayload {
  channel: string;
  data: unknown;
}

export interface JarvisMonitorHandleResult {
  needsResponseBody?: boolean;
  replayRecentNetworkResponses?: boolean;
  responseBodyRequests?: NetworkResponsePayload[];
}

export type JarvisMonitorHandler = (
  event: JarvisMonitorEvent,
) => Promise<JarvisMonitorHandleResult | void> | JarvisMonitorHandleResult | void;

export interface JarvisContentScriptAsset {
  id: string;
  js?: string;
  css?: string;
}

export type JarvisContentScriptProvider = () => Promise<JarvisContentScriptAsset[]> | JarvisContentScriptAsset[];

export interface JarvisMonitorScript {
  id: string;
  name: string;
  enabled: boolean;
  matches(event: JarvisMonitorEvent): boolean;
  needsResponseBody?(event: JarvisMonitorEvent<NetworkResponsePayload>): boolean;
  getResponseBodyRequests?(event: JarvisMonitorEvent): NetworkResponsePayload[];
  handle(event: JarvisMonitorEvent): Promise<void> | void;
}
