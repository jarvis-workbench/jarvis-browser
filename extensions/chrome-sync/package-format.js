(function initChromeSyncPackage(globalScope) {
  "use strict";

  const PACKAGE_TYPE = "jarvis-session-sync";
  const MANIFEST_FILE = "manifest.json";
  const WEB_STATE_FILE = "web-state.json";
  const ZIP_EOCD_SIGNATURE = 0x06054b50;
  const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
  const ZIP_LOCAL_SIGNATURE = 0x04034b50;

  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();

  async function createZipPackage(state, summary) {
    const manifest = createPackageManifest(state, summary);
    return createUncompressedZip({
      [MANIFEST_FILE]: JSON.stringify(manifest, null, 2),
      [WEB_STATE_FILE]: JSON.stringify(state, null, 2),
    });
  }

  function createPackageManifest(state, summary) {
    return {
      packageType: PACKAGE_TYPE,
      formatVersion: globalScope.ChromeSyncSession.VERSION,
      createdAt: new Date().toISOString(),
      files: {
        webState: WEB_STATE_FILE,
      },
      source: {
        exportedBy: state.metadata && state.metadata.exportedBy ? state.metadata.exportedBy : "",
        topOrigin: state.metadata && state.metadata.topOrigin ? state.metadata.topOrigin : "",
        url: state.metadata && state.metadata.url ? state.metadata.url : "",
      },
      summary: summary || globalScope.ChromeSyncSession.summarizeState(state),
    };
  }

  async function readZipPackage(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = parseUncompressedZip(bytes);
    const manifestText = entries.get(MANIFEST_FILE);
    const stateText = entries.get(WEB_STATE_FILE);
    if (!manifestText || !stateText) {
      throw new Error("压缩包缺少 manifest.json 或 web-state.json。");
    }

    const manifest = JSON.parse(manifestText);
    if (
      !manifest ||
      manifest.packageType !== PACKAGE_TYPE ||
      manifest.formatVersion !== globalScope.ChromeSyncSession.VERSION
    ) {
      throw new Error("文件格式版本不受支持。");
    }

    return {
      manifest,
      state: JSON.parse(stateText),
    };
  }

  function createUncompressedZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, text] of Object.entries(files)) {
      const nameBytes = textEncoder.encode(name);
      const contentBytes = textEncoder.encode(text);
      const crc = crc32(contentBytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const localView = new DataView(localHeader.buffer);

      writeUint32(localView, 0, ZIP_LOCAL_SIGNATURE);
      writeUint16(localView, 4, 20);
      writeUint16(localView, 6, 0x0800);
      writeUint16(localView, 8, 0);
      writeUint16(localView, 10, 0);
      writeUint16(localView, 12, 0);
      writeUint32(localView, 14, crc);
      writeUint32(localView, 18, contentBytes.length);
      writeUint32(localView, 22, contentBytes.length);
      writeUint16(localView, 26, nameBytes.length);
      writeUint16(localView, 28, 0);
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, contentBytes);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const centralView = new DataView(centralHeader.buffer);
      writeUint32(centralView, 0, ZIP_CENTRAL_SIGNATURE);
      writeUint16(centralView, 4, 20);
      writeUint16(centralView, 6, 20);
      writeUint16(centralView, 8, 0x0800);
      writeUint16(centralView, 10, 0);
      writeUint16(centralView, 12, 0);
      writeUint16(centralView, 14, 0);
      writeUint32(centralView, 16, crc);
      writeUint32(centralView, 20, contentBytes.length);
      writeUint32(centralView, 24, contentBytes.length);
      writeUint16(centralView, 28, nameBytes.length);
      writeUint16(centralView, 30, 0);
      writeUint16(centralView, 32, 0);
      writeUint16(centralView, 34, 0);
      writeUint16(centralView, 36, 0);
      writeUint32(centralView, 38, 0);
      writeUint32(centralView, 42, offset);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + contentBytes.length;
    }

    const centralSize = totalLength(centralParts);
    const centralOffset = offset;
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    const fileCount = Object.keys(files).length;
    writeUint32(eocdView, 0, ZIP_EOCD_SIGNATURE);
    writeUint16(eocdView, 8, fileCount);
    writeUint16(eocdView, 10, fileCount);
    writeUint32(eocdView, 12, centralSize);
    writeUint32(eocdView, 16, centralOffset);

    return concatBytes([...localParts, ...centralParts, eocd]);
  }

  function parseUncompressedZip(bytes) {
    const eocdOffset = findEndOfCentralDirectory(bytes);
    const eocdView = new DataView(bytes.buffer, bytes.byteOffset + eocdOffset, 22);
    const entryCount = readUint16(eocdView, 10);
    const centralOffset = readUint32(eocdView, 16);
    const entries = new Map();
    let offset = centralOffset;

    for (let index = 0; index < entryCount; index += 1) {
      const headerView = new DataView(bytes.buffer, bytes.byteOffset + offset, 46);
      if (readUint32(headerView, 0) !== ZIP_CENTRAL_SIGNATURE) {
        throw new Error("压缩包目录结构无效。");
      }

      const method = readUint16(headerView, 10);
      const compressedSize = readUint32(headerView, 20);
      const uncompressedSize = readUint32(headerView, 24);
      const nameLength = readUint16(headerView, 28);
      const extraLength = readUint16(headerView, 30);
      const commentLength = readUint16(headerView, 32);
      const localOffset = readUint32(headerView, 42);
      const nameStart = offset + 46;
      const name = textDecoder.decode(bytes.subarray(nameStart, nameStart + nameLength));

      if (method !== 0) {
        throw new Error("当前插件只能读取未压缩 ZIP 包。");
      }
      if (compressedSize !== uncompressedSize) {
        throw new Error("压缩包条目大小不一致。");
      }

      const localView = new DataView(bytes.buffer, bytes.byteOffset + localOffset, 30);
      if (readUint32(localView, 0) !== ZIP_LOCAL_SIGNATURE) {
        throw new Error("压缩包本地条目无效。");
      }
      const localNameLength = readUint16(localView, 26);
      const localExtraLength = readUint16(localView, 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + compressedSize;
      entries.set(name, textDecoder.decode(bytes.subarray(dataStart, dataEnd)));

      offset += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
  }

  function findEndOfCentralDirectory(bytes) {
    for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
      if (
        bytes[offset] === 0x50 &&
        bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x05 &&
        bytes[offset + 3] === 0x06
      ) {
        return offset;
      }
    }
    throw new Error("未找到 ZIP 结束目录。");
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = (crc >>> 8) ^ crcTable()[(crc ^ byte) & 0xff];
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  let cachedCrcTable = null;
  function crcTable() {
    if (cachedCrcTable) {
      return cachedCrcTable;
    }
    cachedCrcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      cachedCrcTable[index] = value >>> 0;
    }
    return cachedCrcTable;
  }

  function concatBytes(parts) {
    const output = new Uint8Array(totalLength(parts));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function totalLength(parts) {
    return parts.reduce((sum, part) => sum + part.length, 0);
  }

  function readUint16(view, offset) {
    return view.getUint16(offset, true);
  }

  function readUint32(view, offset) {
    return view.getUint32(offset, true);
  }

  function writeUint16(view, offset, value) {
    view.setUint16(offset, value, true);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value, true);
  }

  globalScope.ChromeSyncPackage = {
    MANIFEST_FILE,
    PACKAGE_TYPE,
    WEB_STATE_FILE,
    createZipPackage,
    readZipPackage,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
