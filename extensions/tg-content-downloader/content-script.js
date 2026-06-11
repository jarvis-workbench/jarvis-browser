(() => {
  if (window.__jarvisTgContentDownloader) {
    return;
  }
  window.__jarvisTgContentDownloader = true;

  const BATCH_CLASS = "jarvis-tg-batch-button";
  const CHECK_CLASS = "jarvis-tg-check-item";
  const RIGHT_ALL_ID = "jarvis-tg-right-download-all";
  const mediaById = new Map();
  const mediaByUrl = new Map();
  const mediaByKey = new Map();
  const elementIds = new WeakMap();
  const recentRuntimeMedia = [];
  const pendingDownloadIds = new Set();
  const mediaProgress = new Map();
  const pageDownloadListeners = new Map();
  const videoDownloadStartTimeoutMs = 8000;
  const videoDownloadFinishTimeoutMs = 6 * 60 * 60 * 1000;
  let downloadQueueTail = Promise.resolve();
  let sequence = 0;
  let scanTimer = 0;

  injectPageRuntime();
  installStyles();
  scan();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  window.addEventListener("jarvis-tg-media-source", (event) => {
    const detail = event.detail;
    if (!detail?.url || !isUsefulRuntimeMedia(detail)) {
      return;
    }

    recentRuntimeMedia.unshift({
      url: detail.url,
      type: detail.type || "application/octet-stream",
      fileName: detail.fileName || "",
      source: detail.source || "runtime",
      createdAt: Date.now(),
    });
    recentRuntimeMedia.splice(40);
  });

  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (message?.type === "jarvis-tg-scan") {
      scan();
      sendResponse?.({ ok: true, items: getPopupRows() });
      return false;
    }

    if (message?.type === "popupSendData" || message?.type === "jarvis-tg-popup-data") {
      scan();
      sendResponse?.({ ok: true, items: getPopupRows() });
      return false;
    }

    if (message?.type === "executeScript") {
      handleOriginalPopupDownload(message).then(
        () => sendResponse?.({ ok: true }),
        (error) => sendResponse?.({ ok: false, error: String(error?.message || error) }),
      );
      return true;
    }

    if (message?.type === "jarvis-tg-download-items") {
      downloadByIds(message.ids || []).then(
        () => sendResponse?.({ ok: true }),
        (error) => sendResponse?.({ ok: false, error: String(error?.message || error) }),
      );
      return true;
    }

    return false;
  });

  window.addEventListener("jarvis-tg-automation", (event) => {
    const detail = event.detail || {};
    const requestId = detail.requestId || `${Date.now()}-${Math.random()}`;

    handleAutomationRequest(detail).then(
      (result) => {
        window.dispatchEvent(new CustomEvent("jarvis-tg-automation-result", {
          detail: { requestId, ok: true, result },
        }));
      },
      (error) => {
        window.dispatchEvent(new CustomEvent("jarvis-tg-automation-result", {
          detail: {
            requestId,
            ok: false,
            error: String(error?.message || error),
          },
        }));
      },
    );
  });

  function injectPageRuntime() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("injected.js");
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  function installStyles() {
    if (document.getElementById("jarvis-tg-download-style")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "jarvis-tg-download-style";
    style.textContent = `
      .${BATCH_CLASS} {
        z-index: 2147483646;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        height: 28px;
        padding: 0 9px;
        border: 0;
        border-radius: 6px;
        color: #172033;
        background: #7ed957;
        box-shadow: 0 8px 22px rgba(15, 23, 42, 0.18);
        font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }

      .${BATCH_CLASS}:hover {
        background: #92eb69;
      }

      .${CHECK_CLASS} {
        -webkit-appearance: none !important;
        appearance: none !important;
        position: absolute;
        right: 0;
        bottom: 0;
        z-index: 2147483647;
        display: inline-block;
        width: 23px;
        height: 23px;
        margin: 2px;
        box-sizing: border-box;
        border: 2px solid #7ed957;
        border-radius: 3px;
        opacity: 1;
        background-color: #ffffff !important;
        background-image: none !important;
        background-repeat: no-repeat;
        background-position: center;
        background-size: 17px 17px;
        box-shadow: 0 1px 5px rgba(15, 23, 42, 0.25);
        cursor: pointer;
      }

      .${CHECK_CLASS}:checked {
        border-color: #7ed957;
        background-color: #7ed957 !important;
        background-image: url("data:image/svg+xml,%3Csvg%20width%3D%2717%27%20height%3D%2717%27%20viewBox%3D%270%200%2017%2017%27%20fill%3D%27none%27%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%3E%3Cpath%20d%3D%27M4%208.5L7.1%2011.6L13.2%205.2%27%20stroke%3D%27white%27%20stroke-width%3D%272.4%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27/%3E%3C/svg%3E") !important;
      }

      .${CHECK_CLASS}:focus-visible {
        outline: 2px solid #ffffff;
        outline-offset: 1px;
      }

      input[type="checkbox"].${CHECK_CLASS} {
        opacity: 1;
        z-index: 2147483647;
        pointer-events: auto;
      }

      .jarvis-tg-progress {
        position: absolute;
        right: 4px;
        bottom: 4px;
        z-index: 2147483646;
        display: none;
        min-width: 54px;
        max-width: calc(100% - 8px);
        padding: 3px 5px 4px;
        box-sizing: border-box;
        border-radius: 5px;
        color: #172033;
        background: rgba(126, 217, 87, 0.94);
        box-shadow: 0 1px 5px rgba(15, 23, 42, 0.24);
        font: 800 10px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: none;
      }

      .jarvis-tg-progress.is-active {
        display: block;
      }

      .jarvis-tg-progress.is-failed {
        color: #ffffff;
        background: rgba(220, 38, 38, 0.94);
      }

      .album-item > .jarvis-tg-progress {
        bottom: 29px;
      }

      .jarvis-tg-progress__bar {
        display: block;
        width: 100%;
        height: 3px;
        margin-top: 3px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(23, 32, 51, 0.22);
      }

      .jarvis-tg-progress__fill {
        display: block;
        width: var(--jarvis-tg-progress, 0%);
        height: 100%;
        border-radius: inherit;
        background: #172033;
      }

      .jarvis-tg-album-actions {
        display: flex;
        flex-wrap: nowrap;
        align-items: center;
        justify-content: center;
        width: fit-content;
        max-width: 100%;
        box-sizing: border-box;
        gap: 8px;
        margin: 6px auto 8px;
        padding: 0;
        background: transparent;
      }

      .jarvis-tg-album-actions label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #e5f7df;
        font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
        cursor: pointer;
      }

      .jarvis-tg-album-actions input {
        width: 15px;
        height: 15px;
        accent-color: #7ed957;
      }

      .jarvis-tg-album-actions .jarvis-tg-album-download {
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .jarvis-tg-select-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 42px;
        height: 28px;
        padding: 0 8px;
        box-sizing: border-box;
        border: 1px solid rgba(126, 217, 87, 0.74);
        border-radius: 6px;
        color: #eaffdf;
        background: rgba(15, 23, 42, 0.76);
        font: 800 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap;
        cursor: pointer;
      }

      .jarvis-tg-select-action:hover:not(:disabled) {
        background: rgba(30, 41, 59, 0.9);
      }

      .jarvis-tg-select-action:disabled {
        opacity: 0.45;
        cursor: default;
      }

      #${RIGHT_ALL_ID} {
        position: sticky;
        top: 32px;
        z-index: 2147483646;
        display: flex;
        justify-content: center;
        padding: 8px;
        background: rgba(255, 255, 255, 0.88);
      }

      .jarvis-tg-month-button {
        margin-left: 8px;
        vertical-align: middle;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 300);
  }

  function scan() {
    scanMainMessages();
    scanRightMediaPanel();
    scanStoryViewer();
  }

  function scanMainMessages() {
    document.querySelectorAll(".bubble-content-wrapper").forEach((bubble) => {
      const mediaItems = uniqueMediaItems([
        ...scanAlbumBubble(bubble),
        ...scanBubbleVideos(bubble),
        ...scanBubblePhotos(bubble),
        ...scanBubbleAudio(bubble),
      ]);

      if (mediaItems.length) {
        ensureBubbleActions(bubble, mediaItems);
      }
    });
  }

  function uniqueMediaItems(items) {
    const seen = new Set();
    return items.filter((media) => {
      if (!media?.id || seen.has(media.id)) {
        return false;
      }
      seen.add(media.id);
      return true;
    });
  }

  function scanAlbumBubble(bubble) {
    const items = Array.from(bubble.querySelectorAll(".album-item"));
    if (!items.length) {
      return [];
    }

    const mediaItems = [];
    items.forEach((item, index) => {
      const media = mediaFromAlbumItem(item, index);
      if (!media) {
        return;
      }

      ensureItemCheckbox(item, media.id);
      ensureMediaProgress(item, media.id);
      mediaItems.push(media);
    });

    return mediaItems;
  }

  function scanBubblePhotos(bubble) {
    const mediaItems = [];
    bubble.querySelectorAll(".media-photo").forEach((photo) => {
      if (photo.closest(".album-item")) {
        return;
      }

      const host = photo.closest(".media-container, .media-video, .bubble-content") || photo.parentElement;
      const contentHost = photo.closest(".bubble-content, .media-container") || host;
      if (hasVideoMarker(contentHost)) {
        return;
      }

      const url = elementSource(photo);
      if (!hasMediaUrl(url)) {
        return;
      }

      const media = rememberMedia({
        key: elementKey(photo, "photo"),
        url,
        type: inferImageType(url),
        kind: "image",
        title: "Photo",
        fileName: inferFileName(url, "image/jpeg", "telegram-photo"),
        page: location.href,
        context: "chat",
        triggerElement: host || photo,
      });
      ensureMediaProgress(host || photo, media.id);
      mediaItems.push(media);
    });
    return mediaItems;
  }

  function scanBubbleVideos(bubble) {
    const containers = new Set();
    const mediaItems = [];
    bubble.querySelectorAll(".media-video, .video-time, video").forEach((node) => {
      if (node.closest(".album-item")) {
        return;
      }
      containers.add(node.closest(".media-video, .media-container, .bubble-content") || node.parentElement || node);
    });

    containers.forEach((container) => {
      const video = container.querySelector?.("video") || (container instanceof HTMLVideoElement ? container : null);
      const sourceUrl = video ? elementSource(video) : "";
      const url = hasNetworkMediaUrl(sourceUrl) ? sourceUrl : "";
      const triggerElement = activationTargetFor(container)
        || video
        || container;
      const media = rememberMedia({
        key: elementKey(container, "video"),
        url,
        previewUrl: url ? "" : sourceUrl,
        type: "video/mp4",
        kind: "video",
        title: "Video",
        fileName: inferFileName(url, "video/mp4", "telegram-video"),
        page: location.href,
        context: "chat",
        needsViewer: !url,
        triggerElement,
        sourceElement: container,
      });
      ensureMediaProgress(container, media.id);
      mediaItems.push(media);
    });
    return mediaItems;
  }

  function scanBubbleAudio(bubble) {
    const mediaItems = [];
    bubble.querySelectorAll(".document-container").forEach((container) => {
      if (!container.querySelector(".audio-title, .audio-play-icon")) {
        return;
      }

      const title = textOf(container.querySelector(".audio-title")) || "Telegram audio";
      const audio = container.querySelector("audio");
      const sourceUrl = audio ? elementSource(audio) : "";
      const url = hasNetworkMediaUrl(sourceUrl) ? sourceUrl : "";
      const media = rememberMedia({
        key: elementKey(container, "audio"),
        url,
        previewUrl: url ? "" : sourceUrl,
        type: "audio/mpeg",
        kind: "audio",
        title,
        fileName: inferFileName(url, "audio/mpeg", title || "telegram-audio"),
        page: location.href,
        context: "chat",
        needsAudioResolve: !url,
        triggerElement: container.querySelector(".audio-play-icon") || container,
      });
      ensureMediaProgress(container, media.id);
      mediaItems.push(media);
    });
    return mediaItems;
  }

  function scanRightMediaPanel() {
    const roots = Array.from(document.querySelectorAll(
      "#column-right .search-super-container-media.active, #column-right .search-super-container-stories.active",
    ));

    roots.forEach((root) => {
      ensureRightAllButton(root);
      root.querySelectorAll(".media-container").forEach((container) => {
        const media = mediaFromRightContainer(container);
        if (media) {
          ensureMediaProgress(container, media.id);
        }
      });
      ensureMonthButtons(root);
    });
  }

  function scanStoryViewer() {
    const viewer = document.querySelector("#stories-viewer");
    if (!viewer) {
      return;
    }

    const media = mediaFromStoryViewer(viewer);
    if (!media) {
      return;
    }

    const host = viewer.querySelector(".media-viewer-buttons, .story-viewer, .media-viewer") || viewer;
    ensureMediaProgress(host, media.id);
    ensureBubbleActions(host, [media]);
  }

  function mediaFromAlbumItem(item, index) {
    if (hasVideoMarker(item)) {
      const video = item.querySelector("video");
      const previewUrl = video ? elementSource(video) : "";
      const triggerElement = activationTargetFor(item);
      return rememberMedia({
        key: elementKey(item, `album-video-${index}`),
        previewUrl,
        type: "video/mp4",
        kind: "video",
        title: "Album video",
        fileName: inferFileName(previewUrl, "video/mp4", "telegram-album-video"),
        page: location.href,
        context: "album",
        needsViewer: true,
        triggerElement,
        sourceElement: item,
      });
    }

    const photo = item.querySelector(".media-photo");
    if (photo) {
      const url = elementSource(photo);
      if (!hasMediaUrl(url)) {
        return undefined;
      }

      return rememberMedia({
        key: elementKey(item, `album-photo-${index}`),
        url,
        type: inferImageType(url),
        kind: "image",
        title: "Album photo",
        fileName: inferFileName(url, "image/jpeg", "telegram-album-photo"),
        page: location.href,
        context: "album",
        triggerElement: item,
      });
    }

    return undefined;
  }

  function mediaFromRightContainer(container) {
    if (hasVideoMarker(container)) {
      const video = container.querySelector("video");
      const previewUrl = video ? elementSource(video) : "";
      const triggerElement = activationTargetFor(container);
      return rememberMedia({
        key: elementKey(container, "right-video"),
        previewUrl,
        type: "video/mp4",
        kind: "video",
        title: "Media video",
        fileName: inferFileName(previewUrl, "video/mp4", "telegram-media-video"),
        page: location.href,
        context: "right-panel",
        needsViewer: true,
        triggerElement,
        sourceElement: container,
      });
    }

    const photo = container.querySelector(".media-photo");
    if (photo) {
      const url = elementSource(photo);
      if (!hasMediaUrl(url)) {
        return undefined;
      }

      return rememberMedia({
        key: elementKey(container, "right-photo"),
        url,
        type: inferImageType(url),
        kind: "image",
        title: "Media photo",
        fileName: inferFileName(url, "image/jpeg", "telegram-media-photo"),
        page: location.href,
        context: "right-panel",
        triggerElement: container,
      });
    }

    return undefined;
  }

  function mediaFromStoryViewer(viewer) {
    const video = viewer.querySelector("video");
    if (video) {
      const sourceUrl = elementSource(video);
      const url = hasNetworkMediaUrl(sourceUrl) ? sourceUrl : "";
      return rememberMedia({
        key: elementKey(viewer, "story-video"),
        url,
        previewUrl: url ? "" : sourceUrl,
        type: "video/mp4",
        kind: "video",
        title: "Story video",
        fileName: inferFileName(url, "video/mp4", "telegram-story-video"),
        page: location.href,
        context: "story",
        needsViewer: !url,
        triggerElement: viewer,
      });
    }

    const photo = viewer.querySelector(".media-photo");
    if (!photo) {
      return undefined;
    }

    const url = elementSource(photo);
    if (!hasMediaUrl(url)) {
      return undefined;
    }

    return rememberMedia({
      key: elementKey(viewer, "story-photo"),
      url,
      type: inferImageType(url),
      kind: "image",
      title: "Story photo",
      fileName: inferFileName(url, "image/jpeg", "telegram-story-photo"),
      page: location.href,
      context: "story",
      triggerElement: viewer,
    });
  }

  function ensureItemCheckbox(item, mediaId) {
    item.dataset.jarvisTgMediaId = mediaId;
    const existing = item.querySelector(`:scope > input.${CHECK_CLASS}`);
      if (existing) {
        existing.dataset.mediaId = mediaId;
        existing.dataset.checked = existing.checked ? "true" : "false";
        return;
      }

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = `${CHECK_CLASS} download-check-item`;
    checkbox.name = "checkbox-down";
    checkbox.value = "down_btn_checkbox";
    checkbox.checked = true;
    checkbox.dataset.mediaId = mediaId;
    checkbox.dataset.checked = "true";
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("mousedown", (event) => event.stopPropagation());
    checkbox.addEventListener("change", () => {
      checkbox.dataset.checked = checkbox.checked ? "true" : "false";
    });

    if (getComputedStyle(item).position === "static" && !item.style.position) {
      item.style.position = "relative";
    }
    item.appendChild(checkbox);
  }

  function ensureMediaProgress(host, mediaId) {
    if (!host || !mediaId) {
      return;
    }

    host.dataset.jarvisTgMediaId = mediaId;
    if (getComputedStyle(host).position === "static" && !host.style.position) {
      host.style.position = "relative";
    }

    let progress = host.querySelector(":scope > .jarvis-tg-progress");
    if (!progress) {
      progress = document.createElement("div");
      progress.className = "jarvis-tg-progress";
      progress.append(document.createElement("span"), document.createElement("i"));
      progress.querySelector("i").className = "jarvis-tg-progress__bar";
      progress.querySelector("i").appendChild(document.createElement("b"));
      progress.querySelector("b").className = "jarvis-tg-progress__fill";
      host.appendChild(progress);
    }

    progress.dataset.mediaId = mediaId;
    renderMediaProgress(mediaId);
  }

  function ensureBubbleActions(bubble, mediaItems) {
    const host = bubble.querySelector(":scope .bubble-content") || bubble;
    if (!host) {
      return;
    }

    bubble.querySelectorAll(".jarvis-tg-album-actions").forEach((node) => {
      if (node.parentElement !== host) {
        node.remove();
      }
    });

    let actions = host.querySelector(":scope > .jarvis-tg-album-actions");

    if (!actions) {
      actions = document.createElement("div");
      actions.className = "jarvis-tg-album-actions";

      const selectAll = document.createElement("button");
      selectAll.type = "button";
      selectAll.className = "jarvis-tg-select-action jarvis-tg-select-all-action";

      const clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.className = "jarvis-tg-select-action jarvis-tg-clear-all-action";

      const download = document.createElement("button");
      download.type = "button";
      download.className = `${BATCH_CLASS} jarvis-tg-album-download`;

      actions.append(selectAll, clearAll, download);
      host.appendChild(actions);
    } else {
      upgradeBubbleActions(actions);
    }

    bindBubbleActions(actions, bubble, mediaItems);
  }

  function upgradeBubbleActions(actions) {
    actions.querySelectorAll("label").forEach((label) => {
      if (label.querySelector(".jarvis-tg-select-all")) {
        label.remove();
      }
    });

    let selectAll = actions.querySelector(".jarvis-tg-select-all-action");
    if (!selectAll) {
      selectAll = document.createElement("button");
      selectAll.type = "button";
      selectAll.className = "jarvis-tg-select-action jarvis-tg-select-all-action";
      actions.prepend(selectAll);
    }

    let clearAll = actions.querySelector(".jarvis-tg-clear-all-action");
    if (!clearAll) {
      clearAll = document.createElement("button");
      clearAll.type = "button";
      clearAll.className = "jarvis-tg-select-action jarvis-tg-clear-all-action";
      selectAll.after(clearAll);
    }
  }

  function bindBubbleActions(actions, bubble, mediaItems) {
    const selectAll = actions.querySelector(".jarvis-tg-select-all-action");
    const clearAll = actions.querySelector(".jarvis-tg-clear-all-action");
    const download = actions.querySelector(".jarvis-tg-album-download");
    actions.jarvisTgBatchState = {
      bubble,
      mediaIds: mediaItems.map((media) => media.id).filter(Boolean),
    };
    actions.jarvisTgBatchState.mediaIdSet = new Set(actions.jarvisTgBatchState.mediaIds);
    const currentMediaIds = () => actions.jarvisTgBatchState?.mediaIds || [];
    const checkboxes = () => Array.from(bubble.querySelectorAll(`.album-item > input.${CHECK_CLASS}`))
      .filter((checkbox) => actions.jarvisTgBatchState?.mediaIdSet?.has(checkbox.dataset.mediaId));
    const selectedIds = () => checkboxes()
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.dataset.mediaId)
      .filter(Boolean);
    const update = () => {
      const boxes = checkboxes();
      const selectedCount = boxes.filter((checkbox) => checkbox.checked).length;
      const hasOverlayCheckboxes = boxes.length > 0;
      if (selectAll) {
        selectAll.textContent = "全选";
        selectAll.hidden = !hasOverlayCheckboxes;
        selectAll.disabled = !hasOverlayCheckboxes || selectedCount === boxes.length;
      }
      if (clearAll) {
        clearAll.textContent = "取消全选";
        clearAll.hidden = !hasOverlayCheckboxes;
        clearAll.disabled = !hasOverlayCheckboxes || selectedCount === 0;
      }
      if (download) {
        if (hasOverlayCheckboxes) {
          download.textContent = `下载已选 (${selectedCount}/${boxes.length})`;
          download.disabled = selectedCount === 0;
        } else {
          download.textContent = `下载 (${currentMediaIds().length})`;
          download.disabled = currentMediaIds().length === 0;
        }
      }
      renderBatchProgress();
    };

    checkboxes().forEach((checkbox) => {
      if (checkbox.dataset.jarvisTgBound) {
        return;
      }
      checkbox.dataset.jarvisTgBound = "1";
      checkbox.addEventListener("change", update);
    });

    if (selectAll && !selectAll.dataset.jarvisTgBound) {
      selectAll.dataset.jarvisTgBound = "1";
      selectAll.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        checkboxes().forEach((checkbox) => {
          checkbox.checked = true;
          checkbox.dataset.checked = "true";
        });
        update();
      });
    }

    if (clearAll && !clearAll.dataset.jarvisTgBound) {
      clearAll.dataset.jarvisTgBound = "1";
      clearAll.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        checkboxes().forEach((checkbox) => {
          checkbox.checked = false;
          checkbox.dataset.checked = "false";
        });
        update();
      });
    }

    if (download && !download.dataset.jarvisTgBound) {
      download.dataset.jarvisTgBound = "1";
      download.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        scan();
        const ids = checkboxes().length ? selectedIds() : currentMediaIds();
        if (ids.length) {
          download.disabled = true;
          download.textContent = `准备下载 (${ids.length})`;
          downloadByIds(ids).finally(update);
        }
      });
    }

    update();
  }

  function ensureRightAllButton(root) {
    if (root.querySelector(`#${RIGHT_ALL_ID}`)) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.id = RIGHT_ALL_ID;
    const button = document.createElement("button");
    button.type = "button";
    button.className = BATCH_CLASS;
    const updateText = () => {
      const count = Array.from(root.querySelectorAll(".media-container"))
        .map((container) => mediaFromRightContainer(container)?.id)
        .filter(Boolean).length;
      button.textContent = `Download visible (${count})`;
      button.disabled = count === 0;
    };
    updateText();
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ids = Array.from(root.querySelectorAll(".media-container"))
        .map((container) => mediaFromRightContainer(container)?.id)
        .filter(Boolean);
      downloadByIds(ids);
    });
    wrapper.appendChild(button);
    root.prepend(wrapper);
  }

  function ensureMonthButtons(root) {
    root.querySelectorAll(".search-super-month, .search-super-month-name").forEach((header) => {
      if (header.querySelector?.(".jarvis-tg-month-button")) {
        return;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = `${BATCH_CLASS} jarvis-tg-month-button`;
      const updateText = () => {
        const count = getMonthMediaIds(root, header).length;
        button.textContent = `Month (${count})`;
        button.disabled = count === 0;
      };
      updateText();
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        downloadByIds(getMonthMediaIds(root, header));
      });
      header.appendChild(button);
    });
  }

  function getMonthMediaIds(root, header) {
    const month = header.classList?.contains("search-super-month")
      ? header
      : header.closest(".search-super-month");
    if (month) {
      const ids = Array.from(month.querySelectorAll(".media-container"))
        .map((container) => mediaFromRightContainer(container)?.id)
        .filter(Boolean);
      if (ids.length) {
        return ids;
      }
    }

    const nodes = Array.from(root.querySelectorAll(".search-super-month, .search-super-month-name, .media-container"));
    const start = nodes.indexOf(header);
    if (start < 0) {
      return [];
    }

    const ids = [];
    for (let index = start + 1; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node.matches(".search-super-month, .search-super-month-name")) {
        break;
      }
      const media = mediaFromRightContainer(node);
      if (media) {
        ids.push(media.id);
      }
    }
    return ids;
  }

  async function handleOriginalPopupDownload(message) {
    if (message.id_tent && mediaById.has(message.id_tent)) {
      await downloadMedia(message.id_tent);
      return;
    }

    const sourceUrl = message.url_tent;
    if (!sourceUrl) {
      return;
    }
    const url = hasMediaUrl(sourceUrl) ? sourceUrl : "";
    const kind = kindFromType(message.type_tent || "", sourceUrl);
    const directUrl = hasDirectDownloadUrl(kind, sourceUrl) ? sourceUrl : "";

    const media = rememberMedia({
      url: directUrl,
      previewUrl: directUrl ? "" : sourceUrl,
      type: message.type_tent || "application/octet-stream",
      kind,
      title: "Popup media",
      fileName: inferFileName(directUrl || sourceUrl, message.type_tent || "", "telegram-media"),
      page: message.current_url_tent || location.href,
      context: "popup",
      needsViewer: kind === "video" && !directUrl,
      needsAudioResolve: kind === "audio" && !directUrl,
    });
    await dispatchDownload(media);
  }

  async function downloadByIds(ids) {
    scan();
    const uniqueIds = [...new Set(ids)]
      .filter((id) => mediaById.has(id) && !pendingDownloadIds.has(id) && !isMediaDownloadActive(id));
    uniqueIds.forEach((id) => pendingDownloadIds.add(id));
    uniqueIds.forEach((id) => setMediaProgress(id, { status: "queued", progress: 0 }));
    if (!uniqueIds.length) {
      return;
    }

    const run = async () => {
      for (const id of uniqueIds) {
        const media = mediaById.get(id);
        try {
          if (media) {
            await dispatchDownload(media);
            await delay(media.kind === "video" ? 700 : 150);
          }
        } catch (error) {
          console.warn("[Jarvis TG Downloader] item skipped", error);
        } finally {
          pendingDownloadIds.delete(id);
        }
      }
    };

    const task = downloadQueueTail.catch(() => undefined).then(run);
    downloadQueueTail = task.catch(() => undefined);
    await task;
  }

  async function downloadMedia(id) {
    await downloadByIds([id]);
  }

  async function handleAutomationRequest(detail) {
    scan();
    const action = detail.action || "scan";
    if (action === "download") {
      await downloadByIds(Array.isArray(detail.ids) ? detail.ids : []);
    }

    return {
      action,
      items: getPopupRows(),
      debug: getAutomationDebugInfo(),
    };
  }

  async function dispatchDownload(media) {
    const currentMedia = refreshMediaForDownload(media);
    const resolved = await resolveMedia(currentMedia);
    if (!hasDirectDownloadUrl(resolved?.kind || media.kind, resolved?.url)) {
      setMediaProgress(media.id, { status: "failed", progress: 0, label: "失败" });
      clearMediaProgressLater(media.id, 4000, "failed");
      rememberMedia({
        ...currentMedia,
        url: "",
        needsViewer: currentMedia.kind === "video" ? true : currentMedia.needsViewer,
        needsAudioResolve: currentMedia.kind === "audio" ? true : currentMedia.needsAudioResolve,
      });
      console.warn("[Jarvis TG Downloader] media request URL was not captured", {
        id: media.id,
        kind: currentMedia.kind,
        context: currentMedia.context,
        debug: mediaDebugInfo(currentMedia),
      });
      return false;
    }

    const updated = rememberMedia({ ...currentMedia, ...resolved, url: resolved.url });
    setMediaProgress(updated.id, { status: "starting", progress: 0 });
    const stopProgressListener = ensurePageDownloadProgressListener(updated.id);
    const shouldWaitForPageDownload = updated.kind === "video" && hasNetworkMediaUrl(updated.url);
    const started = shouldWaitForPageDownload
      ? waitForPageDownloadStatus(updated.id, new Set(["queued", "downloading", "completed", "failed"]), videoDownloadStartTimeoutMs)
      : undefined;

    document.dispatchEvent(new CustomEvent("video_download", {
      detail: {
        type: "single",
        video_src: toDownloadPayload(updated),
      },
    }));

    const startedStatus = started ? await started : undefined;
    if (resolved.closeViewerAfterDispatch && (startedStatus || !shouldWaitForPageDownload)) {
      await delay(600);
      await closeViewer();
    }
    if (startedStatus?.status === "failed") {
      setMediaProgress(updated.id, { status: "failed", progress: 0, label: "失败" });
      clearMediaProgressLater(updated.id, 4000, "failed");
      console.warn("[Jarvis TG Downloader] page download failed", startedStatus.error || startedStatus);
      return false;
    }

    if (!shouldWaitForPageDownload) {
      setMediaProgress(updated.id, { status: "completed", progress: 100 });
      clearMediaProgressLater(updated.id, 1800, "completed");
      stopProgressListener();
    }
    return true;
  }

  function refreshMediaForDownload(media) {
    scan();
    const latest = mediaById.get(media.id) || media;
    const host = document.querySelector(`[data-jarvis-tg-media-id="${cssEscape(media.id)}"]`);
    if (!host) {
      return latest;
    }

    const albumItem = host.closest?.(".album-item");
    if (albumItem) {
      const siblings = Array.from(albumItem.parentElement?.querySelectorAll(".album-item") || []);
      const refreshed = mediaFromAlbumItem(albumItem, Math.max(0, siblings.indexOf(albumItem)));
      return refreshed?.id === media.id ? refreshed : latest;
    }

    const rightContainer = host.closest?.("#column-right .media-container");
    if (rightContainer) {
      const refreshed = mediaFromRightContainer(rightContainer);
      return refreshed?.id === media.id ? refreshed : latest;
    }

    const bubble = host.closest?.(".bubble-content-wrapper");
    if (bubble) {
      const refreshed = uniqueMediaItems([
        ...scanAlbumBubble(bubble),
        ...scanBubbleVideos(bubble),
        ...scanBubblePhotos(bubble),
        ...scanBubbleAudio(bubble),
      ]).find((item) => item.id === media.id);
      return refreshed || latest;
    }

    return latest;
  }

  async function resolveMedia(media) {
    const hasUrl = hasDirectDownloadUrl(media.kind, media.url);

    if (media.kind === "video" && (media.needsViewer || !hasUrl)) {
      return resolveViewerVideo(media);
    }

    if (media.kind === "audio" && (media.needsAudioResolve || !hasUrl)) {
      return resolveAudio(media);
    }

    if (hasUrl) {
      return media;
    }

    return { ...media, url: "" };
  }

  async function resolveViewerVideo(media) {
    await closeViewer();
    const before = new Set(currentVideoSources());
    const ignoredUrls = new Set([...before, media.previewUrl].filter(Boolean));
    const startedAt = Date.now();
    activateMediaElement(media.triggerElement || media.sourceElement);

    const source = await waitFor(() => {
      const runtime = newestRuntimeMedia("video", startedAt, ignoredUrls);
      if (runtime?.url) {
        return runtime;
      }

      const viewerVideo = activeViewerVideo()
        || activeVideoIn(media.sourceElement);
      const url = viewerVideo ? elementSource(viewerVideo) : "";
      return hasNetworkMediaUrl(url)
        ? { element: viewerVideo, url, type: "video/mp4" }
        : undefined;
    }, 10000);

    const url = source?.url || "";
    if (!url) {
      return media;
    }

    const resolved = {
      ...media,
      url,
      type: source.type || "video/mp4",
      fileName: inferFileName(url, "video/mp4", media.fileName || "telegram-video"),
      needsViewer: false,
      closeViewerAfterDispatch: true,
    };

    return resolved;
  }

  async function resolveAudio(media) {
    const before = new Set(currentAudioSources());
    const startedAt = Date.now();
    media.triggerElement?.click?.();

    const source = await waitFor(() => {
      const runtime = newestRuntimeMedia("audio", startedAt, before);
      if (runtime?.url) {
        return runtime;
      }

      const found = newestAudioNotIn(before);
      const url = found ? elementSource(found) : "";
      return hasMediaUrl(url) ? { element: found, url, type: "audio/mpeg" } : undefined;
    }, 6000);

    const url = source?.url || "";
    if (!url) {
      return media;
    }

    return {
      ...media,
      url,
      type: source.type || "audio/mpeg",
      fileName: inferFileName(url, source.type || "audio/mpeg", media.title || "telegram-audio"),
      needsAudioResolve: false,
    };
  }

  async function closeViewer() {
    const close = document.querySelector(".media-viewer-buttons .btn-icon.close, .media-viewer-close, .popup-close");
    if (!close && !document.querySelector(".media-viewer-movers, .media-viewer")) {
      return;
    }

    if (close) {
      close.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }

    await waitFor(() => !document.querySelector(".media-viewer-movers .media-viewer-aspecter video, .media-viewer video"), 3000);
    await delay(250);
  }

  function waitFor(fn, timeoutMs) {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const value = fn();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(undefined);
          return;
        }
        window.setTimeout(tick, 150);
      };
      tick();
    });
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function listenForPageDownloadProgress(mediaId) {
    const progressEventName = `${mediaId}_video_download_progress`;
    const statusEventName = `${mediaId}_video_download_status`;

    function handleProgress(event) {
      const percent = clampProgress(event.detail?.progress);
      setMediaProgress(mediaId, { status: "downloading", progress: percent });
    }

    function handleStatus(event) {
      const status = event.detail?.status || "";
      if (status === "queued" || status === "starting") {
        setMediaProgress(mediaId, { status: "queued", progress: mediaProgress.get(mediaId)?.progress ?? 0 });
      } else if (status === "downloading") {
        setMediaProgress(mediaId, { status, progress: mediaProgress.get(mediaId)?.progress ?? 0 });
      } else if (status === "completed") {
        setMediaProgress(mediaId, { status, progress: 100 });
        clearMediaProgressLater(mediaId, 1800, "completed");
      } else if (status === "failed") {
        setMediaProgress(mediaId, { status, progress: mediaProgress.get(mediaId)?.progress ?? 0, label: "失败" });
        markMediaForResolveRetry(mediaId);
        clearMediaProgressLater(mediaId, 4000, "failed");
      }
    }

    document.addEventListener(progressEventName, handleProgress);
    document.addEventListener(statusEventName, handleStatus);
    return () => {
      document.removeEventListener(progressEventName, handleProgress);
      document.removeEventListener(statusEventName, handleStatus);
    };
  }

  function ensurePageDownloadProgressListener(mediaId) {
    const existing = pageDownloadListeners.get(mediaId);
    if (existing) {
      return existing.stop;
    }

    const stopRaw = listenForPageDownloadProgress(mediaId);
    const timeout = window.setTimeout(() => {
      const current = mediaProgress.get(mediaId);
      if (current && ["starting", "downloading"].includes(current.status)) {
        stopPageDownloadProgressListener(mediaId);
      }
    }, videoDownloadFinishTimeoutMs);
    const stop = () => {
      window.clearTimeout(timeout);
      stopRaw();
      pageDownloadListeners.delete(mediaId);
    };
    pageDownloadListeners.set(mediaId, { stop });
    return stop;
  }

  function stopPageDownloadProgressListener(mediaId) {
    pageDownloadListeners.get(mediaId)?.stop?.();
  }

  function isMediaDownloadActive(mediaId) {
    const status = mediaProgress.get(mediaId)?.status;
    return status === "queued" || status === "starting" || status === "downloading";
  }

  function markMediaForResolveRetry(mediaId) {
    const media = mediaById.get(mediaId);
    if (!media) {
      return;
    }

    rememberMedia({
      ...media,
      url: "",
      needsViewer: media.kind === "video" ? true : media.needsViewer,
      needsAudioResolve: media.kind === "audio" ? true : media.needsAudioResolve,
    });
  }

  function setMediaProgress(mediaId, patch) {
    if (!mediaId) {
      return;
    }

    const previous = mediaProgress.get(mediaId);
    const next = {
      status: "queued",
      progress: 0,
      ...previous,
      ...patch,
    };
    if (!Object.prototype.hasOwnProperty.call(patch, "label") && patch.status !== "failed") {
      delete next.label;
    }
    if (patch.status === "completed" || patch.status === "failed") {
      stopPageDownloadProgressListener(mediaId);
    }
    mediaProgress.set(mediaId, next);
    renderMediaProgress(mediaId);
    renderBatchProgress();
  }

  function clearMediaProgressLater(mediaId, timeoutMs, status) {
    window.setTimeout(() => {
      if (!status || mediaProgress.get(mediaId)?.status === status) {
        mediaProgress.delete(mediaId);
        renderMediaProgress(mediaId);
        renderBatchProgress();
      }
    }, timeoutMs);
  }

  function renderMediaProgress(mediaId) {
    const state = mediaProgress.get(mediaId);
    document.querySelectorAll(`.jarvis-tg-progress[data-media-id="${cssEscape(mediaId)}"]`).forEach((node) => {
      const label = node.querySelector("span");
      const fill = node.querySelector(".jarvis-tg-progress__fill");
      const progress = clampProgress(state?.progress ?? 0);
      node.classList.toggle("is-active", Boolean(state));
      node.classList.toggle("is-failed", state?.status === "failed");
      node.style.setProperty("--jarvis-tg-progress", `${progress}%`);
      if (label) {
        label.textContent = state?.label || progressLabel(state?.status, progress);
      }
      if (fill) {
        fill.style.width = `${progress}%`;
      }
    });
  }

  function renderBatchProgress() {
    document.querySelectorAll(".jarvis-tg-album-actions").forEach((actions) => {
      const state = actions.jarvisTgBatchState;
      const download = actions.querySelector(".jarvis-tg-album-download");
      if (!state || !download) {
        return;
      }

      const ids = state.mediaIds || [];
      const active = ids
        .map((id) => ({ id, state: mediaProgress.get(id) }))
        .filter((item) => ["queued", "starting", "downloading"].includes(item.state?.status));
      if (!active.length) {
        const boxes = Array.from(state.bubble?.querySelectorAll?.(`.album-item > input.${CHECK_CLASS}`) || [])
          .filter((checkbox) => state.mediaIdSet?.has(checkbox.dataset.mediaId));
        const selectedCount = boxes.filter((checkbox) => checkbox.checked).length;
        if (boxes.length) {
          download.textContent = `下载已选 (${selectedCount}/${boxes.length})`;
          download.disabled = selectedCount === 0;
        } else {
          download.textContent = `下载 (${ids.length})`;
          download.disabled = ids.length === 0;
        }
        return;
      }

      const done = ids.filter((id) => mediaProgress.get(id)?.status === "completed").length;
      const current = active[0].state;
      const percent = clampProgress(current?.progress ?? 0);
      download.disabled = true;
      download.textContent = `下载中 ${Math.min(done + 1, ids.length)}/${ids.length} · ${Math.round(percent)}%`;
    });
  }

  function progressLabel(status, progress) {
    if (status === "queued" || status === "starting") {
      return "排队";
    }
    if (status === "completed") {
      return "完成";
    }
    if (status === "failed") {
      return "失败";
    }
    return `${Math.round(progress)}%`;
  }

  function clampProgress(value) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
      return 0;
    }
    return Math.min(100, Math.max(0, numberValue));
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\#.:,[\]>+~*^$|=\s]/g, "\\$&");
  }

  function waitForPageDownloadStatus(mediaId, statuses, timeoutMs) {
    return new Promise((resolve) => {
      const eventName = `${mediaId}_video_download_status`;
      const timeout = window.setTimeout(() => {
        document.removeEventListener(eventName, handleStatus);
        resolve(undefined);
      }, timeoutMs);

      function handleStatus(event) {
        const detail = event.detail || {};
        if (!statuses.has(detail.status)) {
          return;
        }

        window.clearTimeout(timeout);
        document.removeEventListener(eventName, handleStatus);
        resolve(detail);
      }

      document.addEventListener(eventName, handleStatus);
    });
  }

  function currentVideoSources() {
    return Array.from(document.querySelectorAll("video")).map(elementSource).filter(Boolean);
  }

  function currentAudioSources() {
    return Array.from(document.querySelectorAll("audio")).map(elementSource).filter(Boolean);
  }

  function newestVideoNotIn(before) {
    return Array.from(document.querySelectorAll("video")).reverse().find((video) => {
      const url = elementSource(video);
      return hasNetworkMediaUrl(url) && !before.has(url);
    });
  }

  function activeViewerVideo() {
    const candidates = Array.from(document.querySelectorAll(
      ".media-viewer-movers .media-viewer-aspecter video, .media-viewer video",
    ));
    return candidates.find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 1
        && rect.height > 1
        && rect.left < window.innerWidth
        && rect.right > 0
        && rect.top < window.innerHeight
        && rect.bottom > 0;
    }) || candidates.at(-1);
  }

  function activeVideoIn(root) {
    if (!root) {
      return undefined;
    }

    const candidates = Array.from(root.querySelectorAll?.("video") || []);
    return candidates.find((video) => {
      const rect = video.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }) || candidates.at(-1);
  }

  function newestAudioNotIn(before) {
    return Array.from(document.querySelectorAll("audio")).reverse().find((audio) => {
      const url = elementSource(audio);
      return hasMediaUrl(url) && !before.has(url);
    });
  }

  function newestRuntimeMedia(kind, minCreatedAt = 0, ignoredUrls = new Set()) {
    const prefix = `${kind}/`;
    return recentRuntimeMedia.find((item) => {
      if (item.createdAt < minCreatedAt || ignoredUrls.has(item.url)) {
        return false;
      }
      if ((kind === "video" || kind === "audio") && !hasNetworkMediaUrl(item.url)) {
        return false;
      }
      return item.type.startsWith(prefix) || kindFromType(item.type, item.url) === kind;
    });
  }

  function toDownloadPayload(media) {
    return {
      video_url: media.url,
      video_id: media.id,
      page: media.page || location.href,
      download_id: media.id,
      file_name: media.fileName || inferFileName(media.url, media.type, "telegram-media"),
      content_type: media.type || "application/octet-stream",
    };
  }

  function getPopupRows() {
    return Array.from(mediaById.values())
      .filter((media) => media.context !== "runtime")
      .map((media, index) => ({
        id: media.id,
        index: index + 1,
        title: media.title || media.fileName || "Telegram media",
        fileName: media.fileName || "",
        type: media.kind || kindFromType(media.type, media.url),
        contentType: media.type || "",
        url: hasDirectDownloadUrl(media.kind, media.url) ? media.url : "",
        page: media.page || location.href,
        context: media.context || "",
        downloadable: Boolean(hasDirectDownloadUrl(media.kind, media.url) || media.needsViewer || media.needsAudioResolve),
      }));
  }

  function rememberMedia(input) {
    const existingId = hasDirectDownloadUrl(input.kind, input.url) && !input.needsViewer ? mediaByUrl.get(input.url) : "";
    const keyedId = input.key ? mediaByKey.get(input.key) : "";
    const id = input.id || existingId || keyedId || `jarvis-tg-${++sequence}`;
    const existing = mediaById.get(id) || {};
    const media = { ...existing, ...input, id };

    if (hasDirectDownloadUrl(media.kind, media.url) && !media.needsViewer) {
      mediaByUrl.set(media.url, id);
    }
    if (media.key) {
      mediaByKey.set(media.key, id);
    }
    mediaById.set(id, media);
    return media;
  }

  function elementKey(element, prefix) {
    if (!elementIds.has(element)) {
      elementIds.set(element, `${prefix}-${++sequence}`);
    }
    return elementIds.get(element);
  }

  function elementSource(element) {
    if (!element) {
      return "";
    }

    if (element instanceof HTMLVideoElement || element instanceof HTMLAudioElement) {
      return element.currentSrc || element.src || element.querySelector("source")?.src || "";
    }

    if (element instanceof HTMLImageElement) {
      return element.currentSrc || element.src || "";
    }

    return "";
  }

  function activateMediaElement(element) {
    if (!element) {
      return;
    }

    const target = clickableMediaElement(element);
    target.click?.();
  }

  function clickableMediaElement(element) {
    return activationTargetFor(element) || element;
  }

  function activationTargetFor(element) {
    if (!element) {
      return undefined;
    }

    if (element.matches?.(".album-item-media, .media-container, .media-video")) {
      return element;
    }

    return element.querySelector?.(".album-item-media")
      || element.querySelector?.(".media-container")
      || element.querySelector?.(".media-video")
      || element.querySelector?.("video")
      || element.querySelector?.(".media-photo")
      || element.querySelector?.("img");
  }

  function mediaDebugInfo(media) {
    return {
      trigger: describeElement(media.triggerElement),
      source: describeElement(media.sourceElement),
      previewUrl: media.previewUrl || "",
      videoCount: document.querySelectorAll("video").length,
      viewerVideoCount: document.querySelectorAll(".media-viewer-movers .media-viewer-aspecter video, .media-viewer video").length,
      recentRuntimeMedia: recentRuntimeMedia.slice(0, 5).map((item) => ({
        type: item.type,
        source: item.source,
        ageMs: Date.now() - item.createdAt,
        url: String(item.url || "").slice(0, 120),
      })),
    };
  }

  function getAutomationDebugInfo() {
    return {
      url: location.href,
      title: document.title,
      mediaCount: mediaById.size,
      rows: getPopupRows().length,
      videoCount: document.querySelectorAll("video").length,
      audioCount: document.querySelectorAll("audio").length,
      viewerVideoCount: document.querySelectorAll(".media-viewer-movers .media-viewer-aspecter video, .media-viewer video").length,
      recentRuntimeMedia: recentRuntimeMedia.slice(0, 10).map((item) => ({
        type: item.type,
        source: item.source,
        ageMs: Date.now() - item.createdAt,
        url: String(item.url || "").slice(0, 180),
      })),
    };
  }

  function describeElement(element) {
    if (!element) {
      return "";
    }

    const classes = String(element.className || "").replace(/\s+/g, ".").slice(0, 120);
    return `${element.tagName?.toLowerCase?.() || "node"}${classes ? `.${classes}` : ""}`;
  }

  function inferFileName(url, type, fallbackBase) {
    const fromUrl = decodeFileNameFromUrl(url);
    const extension = extensionFor(type, url);
    const base = sanitizeFileName(fromUrl || fallbackBase || `telegram-${Date.now()}`);
    return hasExtension(base) ? base : `${base}.${extension}`;
  }

  function decodeFileNameFromUrl(url) {
    if (!url) {
      return "";
    }

    try {
      const tail = decodeURIComponent(url.split("/").pop()?.split("?")[0] || "");
      if (!tail || tail.startsWith("blob:")) {
        return "";
      }
      if (tail.startsWith("{")) {
        const parsed = JSON.parse(tail);
        return parsed.fileName || parsed.location?.id || "";
      }
      return tail;
    } catch {
      return "";
    }
  }

  function inferImageType(url) {
    const lower = String(url).toLowerCase();
    if (lower.includes(".webp")) {
      return "image/webp";
    }
    if (lower.includes(".png")) {
      return "image/png";
    }
    return "image/jpeg";
  }

  function kindFromType(type, url) {
    const value = `${type || ""} ${url || ""}`.toLowerCase();
    if (value.includes("audio")) {
      return "audio";
    }
    if (value.includes("image") || value.match(/\.(png|jpe?g|webp|gif)(\?|#|$)/)) {
      return "image";
    }
    return "video";
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

  function hasExtension(name) {
    return /\.[a-z0-9]{2,5}$/i.test(name);
  }

  function sanitizeFileName(name) {
    return String(name).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim() || `telegram-${Date.now()}`;
  }

  function textOf(element) {
    return element?.textContent?.trim() || "";
  }

  function isUsefulRuntimeMedia(detail) {
    const type = String(detail.type || "").toLowerCase();
    const url = String(detail.url || "").toLowerCase();
    if (!hasMediaUrl(url)) {
      return false;
    }

    return type.startsWith("video/")
      || type.startsWith("audio/")
      || url.includes("stream/")
      || url.includes("progressive/")
      || url.startsWith("blob:");
  }

  function hasVideoMarker(container) {
    return Boolean(container?.matches?.(".media-video, .video-time, video")
      || container?.querySelector?.(".media-video, .video-time, video"));
  }

  function hasMediaUrl(url) {
    return Boolean(url);
  }

  function hasNetworkMediaUrl(url) {
    if (!url || String(url).startsWith("blob:")) {
      return false;
    }

    try {
      const parsed = new URL(url, location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function hasDirectDownloadUrl(kind, url) {
    if (kind === "video" || kind === "audio") {
      return hasNetworkMediaUrl(url);
    }

    return hasMediaUrl(url);
  }

})();
