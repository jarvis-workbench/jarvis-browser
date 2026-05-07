const state = {
  tabId: undefined,
  items: [],
};

const rowsElement = document.getElementById("rows");
const statusElement = document.getElementById("status");
const selectAllElement = document.getElementById("select-all");
const downloadSelectedElement = document.getElementById("download-selected");
const copySelectedElement = document.getElementById("copy-selected");
const clearElement = document.getElementById("clear");

init();

async function init() {
  const tab = await queryActiveTab();
  state.tabId = tab?.id;

  if (!state.tabId || !isTelegramUrl(tab?.url || "")) {
    setStatus("Open https://web.telegram.org/k/ to collect Telegram media.");
    render([]);
    return;
  }

  await refreshRows();
}

selectAllElement?.addEventListener("change", () => {
  document.querySelectorAll(".row-check").forEach((checkbox) => {
    checkbox.checked = selectAllElement.checked;
  });
  updateActionState();
});

downloadSelectedElement?.addEventListener("click", async () => {
  const ids = selectedIds();
  if (!ids.length) {
    return;
  }
  await sendToTab({ type: "jarvis-tg-download-items", ids });
  setStatus(`Download started for ${ids.length} item(s).`);
});

copySelectedElement?.addEventListener("click", async () => {
  const links = selectedItems().map((item) => item.url).filter(Boolean);
  if (!links.length) {
    setStatus("Selected items do not have direct links yet.");
    return;
  }

  await navigator.clipboard?.writeText(links.join("\n"));
  setStatus(`Copied ${links.length} link(s).`);
});

clearElement?.addEventListener("click", () => {
  render([]);
  setStatus("List cleared.");
});

async function refreshRows() {
  setStatus("Scanning Telegram media...");
  const response = await sendToTab({ type: "popupSendData" });
  const items = Array.isArray(response?.items) ? response.items : [];
  render(items);
  setStatus(items.length ? `Detected ${items.length} Telegram media item(s).` : "No Telegram message media detected on this tab.");
}

function render(items) {
  state.items = items;
  rowsElement.replaceChildren();
  document.body.classList.toggle("is-empty", !items.length);

  items.forEach((item) => {
    const row = document.createElement("tr");

    const checkCell = document.createElement("td");
    checkCell.className = "check-cell";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "row-check";
    checkbox.dataset.id = item.id;
    checkbox.checked = true;
    checkbox.addEventListener("change", updateActionState);
    checkCell.appendChild(checkbox);

    const fileCell = document.createElement("td");
    const fileName = document.createElement("div");
    fileName.className = "file-name";
    fileName.title = item.fileName || item.title || item.url || "";
    fileName.textContent = item.fileName || item.title || "Telegram media";
    fileCell.appendChild(fileName);

    const typeCell = document.createElement("td");
    typeCell.className = "type-cell";
    typeCell.textContent = item.type || "media";

    const actionCell = document.createElement("td");
    actionCell.className = "action-cell";
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Download";
    download.addEventListener("click", async () => {
      await sendToTab({ type: "jarvis-tg-download-items", ids: [item.id] });
      setStatus("Download started.");
    });

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "Copy";
    copy.disabled = !item.url;
    copy.addEventListener("click", async () => {
      if (!item.url) {
        return;
      }
      await navigator.clipboard?.writeText(item.url);
      setStatus("Link copied.");
    });

    actions.append(download, copy);
    actionCell.appendChild(actions);
    row.append(checkCell, fileCell, typeCell, actionCell);
    rowsElement.appendChild(row);
  });

  if (selectAllElement) {
    selectAllElement.checked = true;
    selectAllElement.disabled = !items.length;
  }
  updateActionState();
}

function selectedIds() {
  return Array.from(document.querySelectorAll(".row-check"))
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.dataset.id)
    .filter(Boolean);
}

function selectedItems() {
  const ids = new Set(selectedIds());
  return state.items.filter((item) => ids.has(item.id));
}

function updateActionState() {
  const ids = selectedIds();
  const hasItems = state.items.length > 0;
  const hasSelection = ids.length > 0;

  if (downloadSelectedElement) {
    downloadSelectedElement.disabled = !hasSelection;
    downloadSelectedElement.textContent = `Download Selected (${ids.length})`;
  }
  if (copySelectedElement) {
    copySelectedElement.disabled = !hasSelection;
  }
  if (clearElement) {
    clearElement.disabled = !hasItems;
  }
  if (selectAllElement) {
    selectAllElement.checked = hasItems && ids.length === state.items.length;
    selectAllElement.indeterminate = hasSelection && ids.length < state.items.length;
  }
}

function setStatus(text) {
  if (statusElement) {
    statusElement.textContent = text;
  }
}

function isTelegramUrl(url) {
  return /^https:\/\/web\.telegram\.org\//.test(url);
}

function queryActiveTab() {
  return new Promise((resolve) => {
    if (!chrome.tabs?.query) {
      resolve(undefined);
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]);
    });
  });
}

function sendToTab(message) {
  return new Promise((resolve) => {
    if (!state.tabId || !chrome.tabs?.sendMessage) {
      resolve(undefined);
      return;
    }

    chrome.tabs.sendMessage(state.tabId, message, (response) => {
      void chrome.runtime?.lastError;
      resolve(response);
    });
  });
}
