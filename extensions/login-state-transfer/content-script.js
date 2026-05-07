(function initJarvisLoginStateContentScript() {
  "use strict";

  const format = globalThis.JarvisLoginState;
  const MESSAGE_PREFIX = "jarvis-login-state:";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string" || !message.type.startsWith(MESSAGE_PREFIX)) {
      return false;
    }

    if (message.type === `${MESSAGE_PREFIX}collect-origin`) {
      collectCurrentOrigin()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: stringifyError(error) }));
      return true;
    }

    if (message.type === `${MESSAGE_PREFIX}import-origin`) {
      importCurrentOrigin(message.state, message.options || {})
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: stringifyError(error) }));
      return true;
    }

    return false;
  });

  async function collectCurrentOrigin() {
    const origin = location.origin;
    const bucket = {
      localStorage: [],
      sessionStorage: [],
      indexedDB: [],
      cacheStorage: [],
    };
    const report = format.createReport();

    collectWebStorage(localStorage, bucket.localStorage, report.localStorage, "localStorage");
    collectWebStorage(sessionStorage, bucket.sessionStorage, report.sessionStorage, "sessionStorage");
    bucket.indexedDB = await collectIndexedDB(report.indexedDB);
    bucket.cacheStorage = await collectCacheStorage(report.cacheStorage);

    return {
      origin,
      url: location.href,
      title: document.title || "",
      bucket,
      report,
    };
  }

  async function importCurrentOrigin(state, options) {
    const validation = format.validateState(state);
    if (!validation.ok) {
      throw new Error(validation.errors.join(" "));
    }

    const origin = location.origin;
    const bucket = state.origins && state.origins[origin];
    const report = format.createReport();
    if (!bucket) {
      report.unsupported.push(`No state bucket for ${origin}.`);
      return { origin, report };
    }

    importWebStorage(localStorage, bucket.localStorage, report.localStorage, "localStorage", options);
    importWebStorage(sessionStorage, bucket.sessionStorage, report.sessionStorage, "sessionStorage", options);
    await importIndexedDB(bucket.indexedDB || [], report.indexedDB, options);
    await importCacheStorage(bucket.cacheStorage || [], report.cacheStorage, options);

    return { origin, report };
  }

  function collectWebStorage(storage, output, reportSection, label) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) {
          continue;
        }
        output.push({ key, value: storage.getItem(key) });
      }
      reportSection.exported += output.length;
    } catch (error) {
      format.addReportError(reportSection, `${label}: ${stringifyError(error)}`);
    }
  }

  function importWebStorage(storage, entries, reportSection, label, options) {
    if (!Array.isArray(entries)) {
      return;
    }
    try {
      if (options.clearBeforeImport) {
        storage.clear();
      }
      for (const entry of entries) {
        if (!entry || typeof entry.key !== "string") {
          reportSection.skipped += 1;
          continue;
        }
        storage.setItem(entry.key, entry.value == null ? "" : String(entry.value));
        reportSection.imported += 1;
      }
    } catch (error) {
      format.addReportError(reportSection, `${label}: ${stringifyError(error)}`);
    }
  }

  async function collectIndexedDB(reportSection) {
    if (!("indexedDB" in globalThis)) {
      reportSection.skipped += 1;
      reportSection.errors.push("indexedDB is not available in this frame.");
      return [];
    }
    if (typeof indexedDB.databases !== "function") {
      reportSection.skipped += 1;
      reportSection.errors.push("indexedDB.databases() is not available in this browser context.");
      return [];
    }

    let databaseInfos;
    try {
      databaseInfos = await indexedDB.databases();
    } catch (error) {
      format.addReportError(reportSection, `indexedDB.databases: ${stringifyError(error)}`);
      return [];
    }

    const exported = [];
    for (const databaseInfo of databaseInfos || []) {
      if (!databaseInfo || !databaseInfo.name) {
        continue;
      }
      try {
        const databaseExport = await exportDatabase(databaseInfo);
        exported.push(databaseExport);
        for (const store of databaseExport.objectStores) {
          reportSection.exported += store.records.length;
        }
      } catch (error) {
        format.addReportError(reportSection, `${databaseInfo.name}: ${stringifyError(error)}`);
      }
    }
    return exported;
  }

  async function exportDatabase(databaseInfo) {
    const database = await openDatabase(databaseInfo.name);
    try {
      const storeNames = Array.from(database.objectStoreNames);
      const databaseExport = {
        name: database.name,
        version: database.version || databaseInfo.version || 1,
        objectStores: [],
      };
      if (storeNames.length === 0) {
        return databaseExport;
      }

      const transaction = database.transaction(storeNames, "readonly");
      const done = transactionDone(transaction);
      for (const storeName of storeNames) {
        const store = transaction.objectStore(storeName);
        const storeExport = {
          name: store.name,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: Array.from(store.indexNames).map((indexName) => {
            const index = store.index(indexName);
            return {
              name: index.name,
              keyPath: index.keyPath,
              multiEntry: index.multiEntry,
              unique: index.unique,
            };
          }),
          records: [],
        };

        await readObjectStoreRecords(store, storeExport.records);
        databaseExport.objectStores.push(storeExport);
      }
      await done;
      return databaseExport;
    } finally {
      database.close();
    }
  }

  function readObjectStoreRecords(store, output) {
    return new Promise((resolve, reject) => {
      const request = store.openCursor();
      request.onerror = () => reject(request.error || new Error(`Cannot read ${store.name}.`));
      request.onsuccess = async () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          output.push({
            key: await format.encodeValue(cursor.key),
            primaryKey: await format.encodeValue(cursor.primaryKey),
            value: await format.encodeValue(cursor.value),
          });
          cursor.continue();
        } catch (error) {
          reject(error);
        }
      };
    });
  }

  async function importIndexedDB(databases, reportSection, options) {
    if (!Array.isArray(databases) || databases.length === 0) {
      return;
    }
    if (!("indexedDB" in globalThis)) {
      reportSection.skipped += databases.length;
      reportSection.errors.push("indexedDB is not available in this frame.");
      return;
    }

    for (const databaseData of databases) {
      if (!databaseData || !databaseData.name) {
        reportSection.skipped += 1;
        continue;
      }
      try {
        await importDatabase(databaseData, options);
        for (const store of databaseData.objectStores || []) {
          reportSection.imported += Array.isArray(store.records) ? store.records.length : 0;
        }
      } catch (error) {
        format.addReportError(reportSection, `${databaseData.name}: ${stringifyError(error)}`);
      }
    }
  }

  async function importDatabase(databaseData, options) {
    const currentVersion = await getDatabaseVersion(databaseData.name);
    const exportedVersion = Math.max(Number(databaseData.version) || 1, 1);
    const targetVersion = currentVersion ? Math.max(currentVersion + 1, exportedVersion) : exportedVersion;
    const database = await openDatabase(databaseData.name, targetVersion, (event) => {
      const upgradeDatabase = event.target.result;
      for (const storeData of databaseData.objectStores || []) {
        let store;
        if (upgradeDatabase.objectStoreNames.contains(storeData.name)) {
          store = event.target.transaction.objectStore(storeData.name);
        } else {
          const createOptions = {};
          if (storeData.keyPath !== null && storeData.keyPath !== undefined) {
            createOptions.keyPath = storeData.keyPath;
          }
          if (storeData.autoIncrement) {
            createOptions.autoIncrement = true;
          }
          store = upgradeDatabase.createObjectStore(storeData.name, createOptions);
        }

        for (const indexData of storeData.indexes || []) {
          if (!store.indexNames.contains(indexData.name)) {
            store.createIndex(indexData.name, indexData.keyPath, {
              multiEntry: Boolean(indexData.multiEntry),
              unique: Boolean(indexData.unique),
            });
          }
        }
      }
    });

    try {
      const storeNames = (databaseData.objectStores || [])
        .map((store) => store.name)
        .filter((storeName) => database.objectStoreNames.contains(storeName));
      if (storeNames.length === 0) {
        return;
      }

      const transaction = database.transaction(storeNames, "readwrite");
      const done = transactionDone(transaction);
      for (const storeData of databaseData.objectStores || []) {
        if (!database.objectStoreNames.contains(storeData.name)) {
          continue;
        }
        const store = transaction.objectStore(storeData.name);
        if (options.clearBeforeImport) {
          await requestToPromise(store.clear());
        }
        for (const record of storeData.records || []) {
          const value = format.decodeValue(record.value);
          if (store.keyPath === null || store.keyPath === undefined) {
            const key = format.decodeValue(record.key);
            await requestToPromise(store.put(value, key));
          } else {
            await requestToPromise(store.put(value));
          }
        }
      }
      await done;
    } finally {
      database.close();
    }
  }

  async function getDatabaseVersion(databaseName) {
    try {
      const database = await openDatabase(databaseName);
      const version = database.version || 0;
      database.close();
      return version;
    } catch (_error) {
      return 0;
    }
  }

  function openDatabase(name, version, onUpgradeNeeded) {
    return new Promise((resolve, reject) => {
      const request = version ? indexedDB.open(name, version) : indexedDB.open(name);
      request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another open tab.`));
      request.onerror = () => reject(request.error || new Error(`Cannot open IndexedDB ${name}.`));
      request.onupgradeneeded = (event) => {
        if (onUpgradeNeeded) {
          onUpgradeNeeded(event);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function collectCacheStorage(reportSection) {
    if (!("caches" in globalThis)) {
      reportSection.skipped += 1;
      reportSection.errors.push("CacheStorage is not available in this frame.");
      return [];
    }

    const output = [];
    let cacheNames;
    try {
      cacheNames = await caches.keys();
    } catch (error) {
      format.addReportError(reportSection, `caches.keys: ${stringifyError(error)}`);
      return output;
    }

    for (const cacheName of cacheNames) {
      try {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        const cacheExport = { name: cacheName, entries: [] };
        for (const request of requests) {
          try {
            const response = await cache.match(request);
            if (!response) {
              continue;
            }
            const responseClone = response.clone();
            const body = await responseClone.arrayBuffer();
            cacheExport.entries.push({
              request: {
                url: request.url,
                method: request.method,
                headers: Array.from(request.headers.entries()),
              },
              response: {
                status: response.status,
                statusText: response.statusText,
                headers: Array.from(response.headers.entries()),
                body: format.bytesToBase64(new Uint8Array(body)),
              },
            });
            reportSection.exported += 1;
          } catch (error) {
            format.addReportError(reportSection, `${cacheName}: ${stringifyError(error)}`);
          }
        }
        output.push(cacheExport);
      } catch (error) {
        format.addReportError(reportSection, `${cacheName}: ${stringifyError(error)}`);
      }
    }
    return output;
  }

  async function importCacheStorage(cacheList, reportSection, options) {
    if (!Array.isArray(cacheList) || cacheList.length === 0) {
      return;
    }
    if (!("caches" in globalThis)) {
      reportSection.skipped += cacheList.length;
      reportSection.errors.push("CacheStorage is not available in this frame.");
      return;
    }

    for (const cacheData of cacheList) {
      if (!cacheData || !cacheData.name) {
        reportSection.skipped += 1;
        continue;
      }
      try {
        if (options.clearBeforeImport) {
          await caches.delete(cacheData.name);
        }
        const cache = await caches.open(cacheData.name);
        for (const entry of cacheData.entries || []) {
          const request = new Request(entry.request.url, {
            method: entry.request.method || "GET",
            headers: entry.request.headers || [],
          });
          const response = new Response(format.base64ToBytes(entry.response.body || ""), {
            status: entry.response.status || 200,
            statusText: entry.response.statusText || "",
            headers: entry.response.headers || [],
          });
          await cache.put(request, response);
          reportSection.imported += 1;
        }
      } catch (error) {
        format.addReportError(reportSection, `${cacheData.name}: ${stringifyError(error)}`);
      }
    }
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
      request.onsuccess = () => resolve(request.result);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    });
  }

  function stringifyError(error) {
    return error && error.message ? error.message : String(error);
  }
})();
