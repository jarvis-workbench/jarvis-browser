(() => {
  if (window.__jarvisTgDownloaderInstalled) {
    return;
  }
  window.__jarvisTgDownloaderInstalled = true;

  const rangePattern = /^bytes (\d+)-(\d+)\/(\d+)$/;
  const downloadFetch = typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  const rangeConcurrency = 1;
  const downloadConcurrency = 2;
  const fetchRetryCount = 2;
  const downloadQueue = [];
  const objectUrls = new Set();
  let activeDownloadCount = 0;

  document.addEventListener("video_download", (event) => {
    const detail = event.detail;
    if (detail?.type === "single") {
      enqueueDownload(detail.video_src);
      return;
    }

    if (detail?.type === "batch" && Array.isArray(detail.video_src)) {
      detail.video_src.forEach((media) => enqueueDownload(media));
    }
  });

  document.addEventListener("jarvis_tg_download", (event) => {
    enqueueDownload(event.detail);
  });

  hookFetch();
  hookXhr();
  hookObjectUrls();
  window.addEventListener("pagehide", revokeObjectUrls);

  function enqueueDownload(media) {
    const url = media?.video_url || media?.url;
    if (!url) {
      return;
    }

    const progressKey = media.video_id || media.id || "";
    const page = media.page || location.href;
    const downloadId = media.download_id || progressKey;

    if (canUseNativeDownload(url)) {
      void downloadMedia(media);
      return;
    }

    emitStatus(progressKey, "queued", page, downloadId);
    downloadQueue.push(media);
    void drainDownloadQueue();
  }

  async function drainDownloadQueue() {
    while (activeDownloadCount < downloadConcurrency && downloadQueue.length) {
      const media = downloadQueue.shift();
      activeDownloadCount += 1;
      void downloadMedia(media).finally(() => {
        activeDownloadCount = Math.max(0, activeDownloadCount - 1);
        window.setTimeout(() => {
          void drainDownloadQueue();
        }, 250);
      });
    }
  }

  async function downloadMedia(media) {
    const url = media?.video_url || media?.url;
    if (!url) {
      return;
    }

    const type = media.content_type || media.type || "application/octet-stream";
    const fileName = sanitizeFileName(media.file_name || media.fileName || inferFileName(url, type));
    const progressKey = media.video_id || media.id || "";
    const page = media.page || location.href;
    const downloadId = media.download_id || progressKey;

    try {
      emitStatus(progressKey, "downloading", page, downloadId);
      if (canUseNativeDownload(url)) {
        saveUrl(url, fileName);
        emitProgress(progressKey, "100.00", page, downloadId);
        emitStatus(progressKey, "completed", page, downloadId);
        return;
      }

      const blob = await fetchMediaBlob(url, type, (progress) => {
        emitProgress(progressKey, progress, page, downloadId);
      });
      saveBlob(blob, fileName);
      emitProgress(progressKey, "100.00", page, downloadId);
      emitStatus(progressKey, "completed", page, downloadId);
    } catch (error) {
      emitStatus(progressKey, "failed", page, downloadId, error);
      console.warn("[Jarvis TG Downloader] download failed", error);
    }
  }

  async function fetchMediaBlob(url, fallbackType, onProgress) {
    if (!downloadFetch) {
      throw new Error("Fetch is unavailable");
    }

    const probe = await fetchWithRetry(url, { headers: { Range: "bytes=0-" } });

    if (!probe.ok) {
      throw new Error(`HTTP error ${probe.status}`);
    }

    const contentRange = probe.headers.get("Content-Range");
    const contentType = probe.headers.get("Content-Type") || fallbackType || "application/octet-stream";
    const length = Number(probe.headers.get("Content-Length") || 0);

    if (probe.status !== 206 || !contentRange || !rangePattern.test(contentRange)) {
      const blob = await probe.blob();
      return blob.type ? blob : new Blob([blob], { type: contentType });
    }

    const [, , endText, totalText] = contentRange.match(rangePattern);
    const segmentSize = Math.max(length, 512 * 1024);
    const totalSize = Number(totalText);
    const firstEnd = Number(endText);
    const buffers = [await probe.arrayBuffer()];
    let received = firstEnd + 1;
    onProgress(percent(received, totalSize));

    const tasks = [];
    for (let start = firstEnd + 1; start < totalSize; start += segmentSize) {
      const end = Math.min(start + segmentSize - 1, totalSize - 1);
      tasks.push(() => fetchRange(url, start, end).then((buffer) => {
        received += buffer.byteLength;
        onProgress(percent(received, totalSize));
        return buffer;
      }));
    }

    const rest = await runPool(tasks, rangeConcurrency);
    return new Blob([...buffers, ...rest], { type: contentType });
  }

  async function fetchRange(url, start, end) {
    const response = await fetchWithRetry(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206) {
      throw new Error(`Range request failed: ${response.status}`);
    }
    return response.arrayBuffer();
  }

  async function fetchWithRetry(url, options = {}) {
    let lastError;

    for (let attempt = 0; attempt <= fetchRetryCount; attempt += 1) {
      try {
        const response = await downloadFetch(url, options);
        if (!shouldRetryResponse(response) || attempt === fetchRetryCount) {
          return response;
        }
        lastError = new Error(`HTTP error ${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === fetchRetryCount) {
          throw error;
        }
      }

      await delay(250 * (attempt + 1));
    }

    throw lastError;
  }

  function shouldRetryResponse(response) {
    return response.status === 429 || response.status >= 500;
  }

  async function runPool(tasks, concurrency) {
    const results = new Array(tasks.length);
    let index = 0;

    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (index < tasks.length) {
        const current = index++;
        results[current] = await tasks[current]();
      }
    }));

    return results;
  }

  function saveBlob(blob, fileName) {
    if (!blob.size) {
      return;
    }

    const href = URL.createObjectURL(blob);
    objectUrls.add(href);
    saveUrl(href, fileName);
  }

  function saveUrl(href, fileName) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function revokeObjectUrls() {
    objectUrls.forEach((href) => URL.revokeObjectURL(href));
    objectUrls.clear();
  }

  function hookFetch() {
    if (typeof window.fetch !== "function") {
      return;
    }

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || response.url;
        reportCandidate(url, response.headers.get("Content-Type") || "", "fetch");
      } catch {
        // Fetch instrumentation must not change page request behavior.
      }
      return response;
    };
  }

  function hookXhr() {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function open(method, url, ...rest) {
      this.__jarvisTgUrl = url;
      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function send(...args) {
      this.addEventListener("load", () => {
        reportCandidate(this.responseURL || this.__jarvisTgUrl, this.getResponseHeader("Content-Type") || "", "xhr");
      });
      return originalSend.apply(this, args);
    };
  }

  function hookObjectUrls() {
    const originalCreateObjectURL = URL.createObjectURL;
    if (typeof originalCreateObjectURL !== "function") {
      return;
    }

    URL.createObjectURL = function createObjectURL(value) {
      const url = originalCreateObjectURL.call(URL, value);
      if (value instanceof Blob) {
        reportCandidate(url, value.type || "application/octet-stream", "blob");
      }
      return url;
    };
  }

  function reportCandidate(url, type, source) {
    if (!url || !isLikelyMedia(url, type)) {
      return;
    }

    window.dispatchEvent(new CustomEvent("jarvis-tg-media-source", {
      detail: {
        url,
        type: type || "application/octet-stream",
        source,
        fileName: inferFileName(url, type),
      },
    }));
  }

  function isLikelyMedia(url, type) {
    return type.startsWith("video/")
      || type.startsWith("audio/")
      || type.startsWith("image/")
      || /file|document|photo|video|audio|progressive/i.test(url);
  }

  function emitProgress(videoId, progress, page, downloadId) {
    if (!videoId) {
      return;
    }

    document.dispatchEvent(new CustomEvent(`${videoId}_video_download_progress`, {
      detail: {
        video_id: videoId,
        progress,
        page,
        download_id: downloadId,
      },
    }));
  }

  function emitStatus(videoId, status, page, downloadId, error) {
    if (!videoId) {
      return;
    }

    document.dispatchEvent(new CustomEvent(`${videoId}_video_download_status`, {
      detail: {
        video_id: videoId,
        status,
        page,
        download_id: downloadId,
        error: error ? String(error?.message || error) : "",
      },
    }));
  }

  function percent(received, total) {
    if (!total) {
      return "0.00";
    }
    return Math.min(100, (received / total) * 100).toFixed(2);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function canUseNativeDownload(url) {
    return String(url).startsWith("blob:");
  }

  function inferFileName(url, type) {
    try {
      const tail = decodeURIComponent(url.split("/").pop()?.split("?")[0] || "");
      if (tail.startsWith("{")) {
        const parsed = JSON.parse(tail);
        if (parsed.fileName) {
          return parsed.fileName;
        }
        if (parsed.location?.id) {
          return `${parsed.location.id}.${extensionFor(type, url)}`;
        }
      }
      if (tail && !tail.startsWith("blob:")) {
        return tail.includes(".") ? tail : `${tail}.${extensionFor(type, url)}`;
      }
    } catch {
      // Fall through to timestamp file name.
    }
    return `telegram-${Date.now()}.${extensionFor(type, url)}`;
  }

  function extensionFor(type, url) {
    const urlMatch = String(url).toLowerCase().match(/\.([a-z0-9]{2,5})(\?|#|$)/);
    if (urlMatch) {
      return urlMatch[1];
    }
    if (type.includes("png")) {
      return "png";
    }
    if (type.includes("jpeg") || type.includes("jpg")) {
      return "jpg";
    }
    if (type.includes("webp")) {
      return "webp";
    }
    if (type.startsWith("audio")) {
      return "mp3";
    }
    return "mp4";
  }

  function sanitizeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || `telegram-${Date.now()}.mp4`;
  }
})();
