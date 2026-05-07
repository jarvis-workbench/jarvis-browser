(() => {
  if (window.__jarvisTgDownloaderInstalled) {
    return;
  }
  window.__jarvisTgDownloaderInstalled = true;

  const rangePattern = /^bytes (\d+)-(\d+)\/(\d+)$/;

  document.addEventListener("video_download", (event) => {
    const detail = event.detail;
    if (detail?.type === "single") {
      downloadMedia(detail.video_src);
      return;
    }

    if (detail?.type === "batch" && Array.isArray(detail.video_src)) {
      detail.video_src.forEach((media) => downloadMedia(media));
    }
  });

  document.addEventListener("jarvis_tg_download", (event) => {
    downloadMedia(event.detail);
  });

  hookFetch();
  hookXhr();
  hookObjectUrls();

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
      const blob = await fetchMediaBlob(url, type, (progress) => {
        emitProgress(progressKey, progress, page, downloadId);
      });
      saveBlob(blob, fileName);
      emitProgress(progressKey, "100.00", page, downloadId);
    } catch (error) {
      console.warn("[Jarvis TG Downloader] download failed", error);
    }
  }

  async function fetchMediaBlob(url, fallbackType, onProgress) {
    if (url.startsWith("blob:")) {
      const response = await fetch(url);
      return response.blob();
    }

    const probe = await fetch(url, { headers: { Range: "bytes=0-" } });
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

    const rest = await runPool(tasks, 6);
    return new Blob([...buffers, ...rest], { type: contentType });
  }

  async function fetchRange(url, start, end) {
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (![200, 206].includes(response.status)) {
      throw new Error(`Range request failed: ${response.status}`);
    }
    return response.arrayBuffer();
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
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }

  function hookFetch() {
    const originalFetch = window.fetch;
    if (typeof originalFetch !== "function") {
      return;
    }

    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || response.url;
      reportCandidate(url, response.headers.get("Content-Type") || "", "fetch");
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

  function percent(received, total) {
    if (!total) {
      return "0.00";
    }
    return Math.min(100, (received / total) * 100).toFixed(2);
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
