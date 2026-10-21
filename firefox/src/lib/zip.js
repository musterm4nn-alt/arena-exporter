/* Dependency-free ZIP writer (stored entries, UTF-8 names).
 *
 * Bulk library export needs a single downloadable artifact with a manifest,
 * so the workspace builds a ZIP in the page instead of asking the download
 * folder for hundreds of separate files. Stored entries keep the code small
 * and the output byte-deterministic; conversation text is already compressed
 * by the transport and the files are usually small.
 */
var AE = AE || {};
(function () {
  "use strict";

  const MAX_FILES = 60000;
  const MAX_BYTES = 0xffffffff;

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function bytesOf(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof value === "string") return new TextEncoder().encode(value);
    if (value && value.buffer instanceof ArrayBuffer) return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
    return new TextEncoder().encode(String(value == null ? "" : value));
  }

  function safeName(value) {
    const name = String(value == null ? "" : value).replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.length > 65000) throw new Error("A ZIP entry has an invalid name.");
    const parts = name.split("/");
    for (let i = 0; i < parts.length; i++) {
      if (!parts[i] || parts[i] === "." || parts[i] === "..") throw new Error("A ZIP entry has an unsafe path: " + name);
    }
    return name;
  }

  function dosDateTime(value) {
    const date = value instanceof Date && Number.isFinite(value.getTime()) ? value : new Date(Date.UTC(1980, 0, 1));
    const year = Math.max(1980, date.getUTCFullYear());
    const time = ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | ((Math.floor(date.getUTCSeconds() / 2)) & 0x1f);
    const day = ((year - 1980) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f);
    return { time: time, date: day };
  }

  function buildZip(files, options) {
    options = options || {};
    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw new Error("There is nothing to export.");
    if (list.length > MAX_FILES) throw new Error("Too many files for one ZIP archive.");
    const stamp = dosDateTime(options.date);
    const entries = [];
    let offset = 0;
    list.forEach(function (file) {
      const nameBytes = new TextEncoder().encode(safeName(file && file.name));
      const data = bytesOf(file && file.data);
      const crc = crc32(data);
      if (offset + data.length > MAX_BYTES) throw new Error("The ZIP archive would exceed 4 GiB.");
      entries.push({ nameBytes: nameBytes, data: data, crc: crc, offset: offset });
      offset += 30 + nameBytes.length + data.length;
    });
    let centralSize = 0;
    entries.forEach(function (entry) { centralSize += 46 + entry.nameBytes.length; });
    const total = offset + centralSize + 22;
    if (total > MAX_BYTES) throw new Error("The ZIP archive would exceed 4 GiB.");
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    let cursor = 0;
    entries.forEach(function (entry) {
      view.setUint32(cursor, 0x04034b50, true);
      view.setUint16(cursor + 4, 20, true);
      view.setUint16(cursor + 6, 0x0800, true);
      view.setUint16(cursor + 8, 0, true);
      view.setUint16(cursor + 10, stamp.time, true);
      view.setUint16(cursor + 12, stamp.date, true);
      view.setUint32(cursor + 14, entry.crc, true);
      view.setUint32(cursor + 18, entry.data.length, true);
      view.setUint32(cursor + 22, entry.data.length, true);
      view.setUint16(cursor + 26, entry.nameBytes.length, true);
      view.setUint16(cursor + 28, 0, true);
      out.set(entry.nameBytes, cursor + 30);
      out.set(entry.data, cursor + 30 + entry.nameBytes.length);
      cursor += 30 + entry.nameBytes.length + entry.data.length;
    });
    const centralStart = cursor;
    entries.forEach(function (entry) {
      view.setUint32(cursor, 0x02014b50, true);
      view.setUint16(cursor + 4, 20, true);
      view.setUint16(cursor + 6, 20, true);
      view.setUint16(cursor + 8, 0x0800, true);
      view.setUint16(cursor + 10, 0, true);
      view.setUint16(cursor + 12, stamp.time, true);
      view.setUint16(cursor + 14, stamp.date, true);
      view.setUint32(cursor + 16, entry.crc, true);
      view.setUint32(cursor + 20, entry.data.length, true);
      view.setUint32(cursor + 24, entry.data.length, true);
      view.setUint16(cursor + 28, entry.nameBytes.length, true);
      view.setUint16(cursor + 30, 0, true);
      view.setUint16(cursor + 32, 0, true);
      view.setUint16(cursor + 34, 0, true);
      view.setUint16(cursor + 36, 0, true);
      view.setUint32(cursor + 38, 0, true);
      view.setUint32(cursor + 42, entry.offset, true);
      out.set(entry.nameBytes, cursor + 46);
      cursor += 46 + entry.nameBytes.length;
    });
    view.setUint32(cursor, 0x06054b50, true);
    view.setUint16(cursor + 4, 0, true);
    view.setUint16(cursor + 6, 0, true);
    view.setUint16(cursor + 8, entries.length, true);
    view.setUint16(cursor + 10, entries.length, true);
    view.setUint32(cursor + 12, cursor - centralStart, true);
    view.setUint32(cursor + 16, centralStart, true);
    view.setUint16(cursor + 20, 0, true);
    return out;
  }

  AE.zip = { crc32: crc32, build: buildZip, MAX_FILES: MAX_FILES };
  if (typeof module !== "undefined" && module.exports) module.exports = AE.zip;
})();
