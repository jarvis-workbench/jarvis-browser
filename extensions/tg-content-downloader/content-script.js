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

      .jarvis-tg-album-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        width: 100%;
        max-width: 100%;
        box-sizing: border-box;
        clear: both;
        gap: 10px;
        margin-top: 6px;
        margin-right: 0;
        margin-bottom: 16px;
        margin-left: 0;
        padding: 4px 0 0;
        background: transparent;
      }

      .jarvis-tg-album-actions label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #172033;
        font: 700 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        cursor: pointer;
      }

      .jarvis-tg-album-actions input {
        width: 15px;
        height: 15px;
        accent-color: #7ed957;
      }

      .jarvis-tg-album-actions .jarvis-tg-album-download {
        margin-right: auto;
        margin-left: auto;
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
      if (!url) {
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
      const url = video ? elementSource(video) : "";
      const media = rememberMedia({
        key: elementKey(container, "video"),
        url,
        type: "video/mp4",
        kind: "video",
        title: "Video",
        fileName: inferFileName(url, "video/mp4", "telegram-video"),
        page: location.href,
        context: "chat",
        needsViewer: !url,
        triggerElement: container,
      });
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
      const url = audio ? elementSource(audio) : "";
      const media = rememberMedia({
        key: elementKey(container, "audio"),
        url,
        type: "audio/mpeg",
        kind: "audio",
        title,
        fileName: inferFileName(url, "audio/mpeg", title || "telegram-audio"),
        page: location.href,
        context: "chat",
        needsAudioResolve: !url,
        triggerElement: container.querySelector(".audio-play-icon") || container,
      });
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
        mediaFromRightContainer(container);
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
    ensureBubbleActions(host, [media]);
  }

  function mediaFromAlbumItem(item, index) {
    if (hasVideoMarker(item)) {
      const video = item.querySelector("video");
      const url = video ? elementSource(video) : "";
      return rememberMedia({
        key: elementKey(item, `album-video-${index}`),
        url,
        type: "video/mp4",
        kind: "video",
        title: "Album video",
        fileName: inferFileName(url, "video/mp4", "telegram-album-video"),
        page: location.href,
        context: "album",
        needsViewer: !url,
        triggerElement: item,
      });
    }

    const photo = item.querySelector(".media-photo");
    if (photo) {
      const url = elementSource(photo);
      if (!url) {
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
      const url = video ? elementSource(video) : "";
      return rememberMedia({
        key: elementKey(container, "right-video"),
        url,
        type: "video/mp4",
        kind: "video",
        title: "Media video",
        fileName: inferFileName(url, "video/mp4", "telegram-media-video"),
        page: location.href,
        context: "right-panel",
        needsViewer: !url,
        triggerElement: container,
      });
    }

    const photo = container.querySelector(".media-photo");
    if (photo) {
      const url = elementSource(photo);
      if (!url) {
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
      const url = elementSource(video);
      return rememberMedia({
        key: elementKey(viewer, "story-video"),
        url,
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
    if (!url) {
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

  function ensureBubbleActions(bubble, mediaItems) {
    const host = bubble.querySelector(":scope .bubble-content");
    if (!host) {
      return;
    }

    let actions = host.querySelector(":scope > .jarvis-tg-album-actions");

    if (!actions) {
      actions = document.createElement("div");
      actions.className = "jarvis-tg-album-actions";

      const label = document.createElement("label");
      const all = document.createElement("input");
      all.type = "checkbox";
      all.className = "jarvis-tg-select-all";
      all.checked = true;
      all.addEventListener("click", (event) => event.stopPropagation());
      label.append(all, document.createTextNode("All"));

      const download = document.createElement("button");
      download.type = "button";
      download.className = `${BATCH_CLASS} jarvis-tg-album-download`;

      actions.append(label, download);
      host.appendChild(actions);
    }

    bindBubbleActions(actions, bubble, mediaItems);
  }

  function bindBubbleActions(actions, bubble, mediaItems) {
    const all = actions.querySelector(".jarvis-tg-select-all");
    const allLabel = all?.closest("label");
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
      if (all) {
        all.checked = hasOverlayCheckboxes && selectedCount === boxes.length;
        all.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
      }
      if (allLabel) {
        allLabel.hidden = !hasOverlayCheckboxes;
      }
      if (download) {
        if (hasOverlayCheckboxes) {
          download.textContent = `Download selected (${selectedCount}/${boxes.length})`;
          download.disabled = selectedCount === 0;
        } else {
          download.textContent = `Download (${currentMediaIds().length})`;
          download.disabled = currentMediaIds().length === 0;
        }
      }
    };

    checkboxes().forEach((checkbox) => {
      if (checkbox.dataset.jarvisTgBound) {
        return;
      }
      checkbox.dataset.jarvisTgBound = "1";
      checkbox.addEventListener("change", update);
    });

    if (all && !all.dataset.jarvisTgBound) {
      all.dataset.jarvisTgBound = "1";
      all.addEventListener("change", () => {
        checkboxes().forEach((checkbox) => {
          checkbox.checked = all.checked;
          checkbox.dataset.checked = checkbox.checked ? "true" : "false";
        });
        update();
      });
    }

    if (download && !download.dataset.jarvisTgBound) {
      download.dataset.jarvisTgBound = "1";
      download.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const ids = checkboxes().length ? selectedIds() : currentMediaIds();
        if (ids.length) {
          downloadByIds(ids);
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

    const url = message.url_tent;
    if (!url) {
      return;
    }

    const media = rememberMedia({
      url,
      type: message.type_tent || "application/octet-stream",
      kind: kindFromType(message.type_tent || "", url),
      title: "Popup media",
      fileName: inferFileName(url, message.type_tent || "", "telegram-media"),
      page: message.current_url_tent || location.href,
      context: "popup",
    });
    await dispatchDownload(media);
  }

  async function downloadByIds(ids) {
    for (const id of ids) {
      const media = mediaById.get(id);
      if (!media) {
        continue;
      }

      await dispatchDownload(media);
    }
  }

  async function downloadMedia(id) {
    const media = mediaById.get(id);
    if (!media) {
      return;
    }

    await dispatchDownload(media);
  }

  async function dispatchDownload(media) {
    const resolved = await resolveMedia(media);
    if (!resolved?.url) {
      return;
    }

    const updated = rememberMedia({ ...media, ...resolved, url: resolved.url });
    document.dispatchEvent(new CustomEvent("video_download", {
      detail: {
        type: "single",
        video_src: toDownloadPayload(updated),
      },
    }));
  }

  async function resolveMedia(media) {
    if (media.url) {
      return media;
    }

    if (media.kind === "audio") {
      return resolveAudio(media);
    }

    if (media.kind === "video") {
      return resolveViewerVideo(media);
    }

    return media;
  }

  async function resolveViewerVideo(media) {
    await closeViewer();
    const before = new Set(currentVideoSources());
    const startedAt = Date.now();
    media.triggerElement?.click?.();

    const video = await waitFor(() => {
      const viewerVideo = document.querySelector(".media-viewer-movers .media-viewer-aspecter video")
        || document.querySelector(".media-viewer video")
        || newestVideoNotIn(before);
      const url = viewerVideo ? elementSource(viewerVideo) : "";
      return url && !before.has(url) ? { element: viewerVideo, url } : undefined;
    }, 8000);

    const runtime = newestRuntimeMedia("video", startedAt, before);
    const url = video?.url || runtime?.url || "";
    if (!url) {
      return media;
    }

    const resolved = {
      ...media,
      url,
      type: "video/mp4",
      fileName: inferFileName(url, "video/mp4", media.fileName || "telegram-video"),
      needsViewer: false,
    };

    await closeViewer();
    return resolved;
  }

  async function resolveAudio(media) {
    const before = new Set(currentAudioSources());
    media.triggerElement?.click?.();

    const audio = await waitFor(() => {
      const found = newestAudioNotIn(before);
      const url = found ? elementSource(found) : "";
      return url ? { element: found, url } : undefined;
    }, 6000);

    const runtime = newestRuntimeMedia("audio", Date.now() - 6000, before);
    const url = audio?.url || runtime?.url || "";
    if (!url) {
      return media;
    }

    return {
      ...media,
      url,
      type: "audio/mpeg",
      fileName: inferFileName(url, "audio/mpeg", media.title || "telegram-audio"),
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

  function currentVideoSources() {
    return Array.from(document.querySelectorAll("video")).map(elementSource).filter(Boolean);
  }

  function currentAudioSources() {
    return Array.from(document.querySelectorAll("audio")).map(elementSource).filter(Boolean);
  }

  function newestVideoNotIn(before) {
    return Array.from(document.querySelectorAll("video")).reverse().find((video) => {
      const url = elementSource(video);
      return url && !before.has(url);
    });
  }

  function newestAudioNotIn(before) {
    return Array.from(document.querySelectorAll("audio")).reverse().find((audio) => {
      const url = elementSource(audio);
      return url && !before.has(url);
    });
  }

  function newestRuntimeMedia(kind, minCreatedAt = 0, ignoredUrls = new Set()) {
    const prefix = `${kind}/`;
    return recentRuntimeMedia.find((item) => {
      if (item.createdAt < minCreatedAt || ignoredUrls.has(item.url)) {
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
        url: media.url || "",
        page: media.page || location.href,
        context: media.context || "",
        downloadable: Boolean(media.url || media.needsViewer || media.needsAudioResolve),
      }));
  }

  function rememberMedia(input) {
    const existingId = input.url ? mediaByUrl.get(input.url) : "";
    const keyedId = input.key ? mediaByKey.get(input.key) : "";
    const id = input.id || existingId || keyedId || `jarvis-tg-${++sequence}`;
    const existing = mediaById.get(id) || {};
    const media = { ...existing, ...input, id };

    if (media.url) {
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

})();
