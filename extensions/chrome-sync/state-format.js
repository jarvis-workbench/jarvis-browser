(function initChromeSyncSessionFormat(globalScope) {
  "use strict";

  const VERSION = "jarvis-session-sync-v1";
  const VALUE_MARKER = "__jarvisSessionSyncType";
  const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

  function nowIso() {
    return new Date().toISOString();
  }

  function isSupportedPageUrl(url) {
    try {
      return SUPPORTED_PROTOCOLS.has(new URL(url).protocol);
    } catch (_error) {
      return false;
    }
  }

  function normalizeOrigin(url) {
    try {
      const parsed = new URL(url);
      if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
        return "";
      }
      return parsed.origin;
    } catch (_error) {
      return "";
    }
  }

  function createReport() {
    return {
      cookies: { exported: 0, imported: 0, failed: 0, skipped: 0, errors: [] },
      localStorage: { exported: 0, imported: 0, failed: 0, skipped: 0, errors: [] },
      sessionStorage: { exported: 0, imported: 0, failed: 0, skipped: 0, errors: [] },
      indexedDB: { exported: 0, imported: 0, failed: 0, skipped: 0, errors: [] },
      cacheStorage: { exported: 0, imported: 0, failed: 0, skipped: 0, errors: [] },
      unsupported: [],
    };
  }

  function createEmptyState(input) {
    const topOrigin = normalizeOrigin(input.url);
    return {
      version: VERSION,
      metadata: {
        exportedAt: nowIso(),
        exportedBy: input.exportedBy || detectBrowserName(),
        userAgent: input.userAgent || "",
        url: input.url || "",
        topOrigin,
        frameOrigins: topOrigin ? [topOrigin] : [],
      },
      cookies: [],
      origins: {},
      report: createReport(),
    };
  }

  function detectBrowserName() {
    const navigatorObject = globalScope.navigator;
    const userAgent = navigatorObject && navigatorObject.userAgent ? navigatorObject.userAgent : "";
    if (userAgent.includes("Electron")) {
      return "Jarvis Browser";
    }
    if (userAgent.includes("Chrome")) {
      return "Chrome";
    }
    return "Unknown browser";
  }

  function ensureOriginBucket(state, origin) {
    if (!state.origins[origin]) {
      state.origins[origin] = {
        localStorage: [],
        sessionStorage: [],
        indexedDB: [],
        cacheStorage: [],
      };
    }
    return state.origins[origin];
  }

  function validateState(state) {
    const errors = [];
    if (!state || typeof state !== "object") {
      errors.push("State file is not an object.");
      return { ok: false, errors };
    }
    if (state.version !== VERSION) {
      errors.push(`Unsupported state version: ${state.version || "missing"}.`);
    }
    if (!state.metadata || typeof state.metadata !== "object") {
      errors.push("Missing metadata.");
    }
    if (!Array.isArray(state.cookies)) {
      errors.push("cookies must be an array.");
    }
    if (!state.origins || typeof state.origins !== "object") {
      errors.push("origins must be an object.");
    }
    return { ok: errors.length === 0, errors };
  }

  function summarizeState(state) {
    const origins = Object.keys(state.origins || {});
    let localStorage = 0;
    let sessionStorage = 0;
    let indexedDBStores = 0;
    let indexedDBRecords = 0;
    let cacheEntries = 0;

    for (const origin of origins) {
      const bucket = state.origins[origin] || {};
      localStorage += Array.isArray(bucket.localStorage) ? bucket.localStorage.length : 0;
      sessionStorage += Array.isArray(bucket.sessionStorage) ? bucket.sessionStorage.length : 0;
      for (const database of bucket.indexedDB || []) {
        indexedDBStores += Array.isArray(database.objectStores) ? database.objectStores.length : 0;
        for (const store of database.objectStores || []) {
          indexedDBRecords += Array.isArray(store.records) ? store.records.length : 0;
        }
      }
      for (const cache of bucket.cacheStorage || []) {
        cacheEntries += Array.isArray(cache.entries) ? cache.entries.length : 0;
      }
    }

    return {
      origins: origins.length,
      cookies: Array.isArray(state.cookies) ? state.cookies.length : 0,
      localStorage,
      sessionStorage,
      indexedDBStores,
      indexedDBRecords,
      cacheEntries,
    };
  }

  function addReportError(reportSection, message) {
    if (!reportSection) {
      return;
    }
    reportSection.failed = (reportSection.failed || 0) + 1;
    reportSection.errors = reportSection.errors || [];
    reportSection.errors.push(String(message));
  }

  function textToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    return bytesToBase64(bytes);
  }

  function base64ToText(base64) {
    return new TextDecoder().decode(base64ToBytes(base64));
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64 || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function encodeValue(value, seen) {
    const visited = seen || new WeakSet();

    if (value === undefined) {
      return { [VALUE_MARKER]: "undefined" };
    }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "bigint") {
      return { [VALUE_MARKER]: "bigint", value: value.toString() };
    }
    if (value instanceof Date) {
      return { [VALUE_MARKER]: "date", value: value.toISOString() };
    }
    if (value instanceof ArrayBuffer) {
      return { [VALUE_MARKER]: "arrayBuffer", value: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
      return {
        [VALUE_MARKER]: "typedArray",
        constructorName: value.constructor && value.constructor.name ? value.constructor.name : "Uint8Array",
        value: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    }
    if (typeof Blob !== "undefined" && value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      const isFile = typeof File !== "undefined" && value instanceof File;
      return {
        [VALUE_MARKER]: isFile ? "file" : "blob",
        name: isFile ? value.name : undefined,
        lastModified: isFile ? value.lastModified : undefined,
        mimeType: value.type || "",
        value: bytesToBase64(bytes),
      };
    }
    if (value instanceof Map) {
      const entries = [];
      for (const [entryKey, entryValue] of value.entries()) {
        entries.push([await encodeValue(entryKey, visited), await encodeValue(entryValue, visited)]);
      }
      return { [VALUE_MARKER]: "map", entries };
    }
    if (value instanceof Set) {
      const values = [];
      for (const setValue of value.values()) {
        values.push(await encodeValue(setValue, visited));
      }
      return { [VALUE_MARKER]: "set", values };
    }
    if (typeof value === "object") {
      if (visited.has(value)) {
        throw new Error("Cannot export cyclic IndexedDB value.");
      }
      visited.add(value);
      if (Array.isArray(value)) {
        const items = [];
        for (const item of value) {
          items.push(await encodeValue(item, visited));
        }
        visited.delete(value);
        return items;
      }
      const objectValue = {};
      for (const key of Object.keys(value)) {
        objectValue[key] = await encodeValue(value[key], visited);
      }
      visited.delete(value);
      return objectValue;
    }

    return String(value);
  }

  function decodeValue(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => decodeValue(item));
    }

    const marker = value[VALUE_MARKER];
    if (marker === "undefined") {
      return undefined;
    }
    if (marker === "bigint") {
      return BigInt(value.value || "0");
    }
    if (marker === "date") {
      return new Date(value.value);
    }
    if (marker === "arrayBuffer") {
      return base64ToBytes(value.value).buffer;
    }
    if (marker === "typedArray") {
      const bytes = base64ToBytes(value.value);
      const TypedArrayConstructor = globalScope[value.constructorName] || Uint8Array;
      return new TypedArrayConstructor(bytes.buffer);
    }
    if (marker === "blob") {
      return new Blob([base64ToBytes(value.value)], { type: value.mimeType || "" });
    }
    if (marker === "file") {
      if (typeof File === "undefined") {
        return new Blob([base64ToBytes(value.value)], { type: value.mimeType || "" });
      }
      return new File([base64ToBytes(value.value)], value.name || "file", {
        type: value.mimeType || "",
        lastModified: value.lastModified || Date.now(),
      });
    }
    if (marker === "map") {
      return new Map((value.entries || []).map((entry) => [decodeValue(entry[0]), decodeValue(entry[1])]));
    }
    if (marker === "set") {
      return new Set((value.values || []).map((item) => decodeValue(item)));
    }

    const decoded = {};
    for (const key of Object.keys(value)) {
      decoded[key] = decodeValue(value[key]);
    }
    return decoded;
  }

  globalScope.ChromeSyncSession = {
    VERSION,
    addReportError,
    base64ToBytes,
    base64ToText,
    bytesToBase64,
    createEmptyState,
    createReport,
    detectBrowserName,
    decodeValue,
    encodeValue,
    ensureOriginBucket,
    isSupportedPageUrl,
    normalizeOrigin,
    summarizeState,
    textToBase64,
    validateState,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
