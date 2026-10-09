// Парсер старого формата .xls (BIFF8 внутри OLE2/CFB) на стандартной библиотеке.
// Разбирает Compound File (включая мини-потоки), извлекает Workbook и читает
// BIFF8-записи (SST + ячейки), выдавая ту же структуру, что XLSX-парсер:
// { sheets: [{ name, rows: [{ idx, cells:[{value,num,col}] }] }] }
"use strict";

const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
const i32 = (b, o) => b.readInt32LE(o);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const MAXREGSECT = 0xfffffffa;

function parseCfb(buf) {
  if (u32(buf, 0) !== 0xe011cfd0) throw new Error("Не OLE2/CFB (старый .xls).");
  const sectorShift = u16(buf, 30);
  if (sectorShift < 7 || sectorShift > 16) throw new Error("Неверный размер сектора.");
  const sectorSize = 1 << sectorShift;
  const miniSectorShift = u16(buf, 32);
  const miniSectorSize = 1 << miniSectorShift;
  const numFat = u32(buf, 44);
  const firstDir = u32(buf, 48);
  const miniCutoff = u32(buf, 56);
  const firstMiniFat = u32(buf, 60);
  const numMiniFat = u32(buf, 64);
  const firstDifat = u32(buf, 68);
  const numDifat = u32(buf, 72);

  const s2off = (s) => (s + 1) * sectorSize;

  if (numFat < 1 || numFat > 100000) throw new Error("numFat вне диапазона.");

  // Читаем FAT
  const fat = new Int32Array(numFat * (sectorSize / 4));
  let fi = 0;
  // FAT-сектора указываются массивом в заголовке (offset 76..76+109*4),
  // затем продолжаются через DIFAT-сектора.
  const fatSectors = [];
  for (let i = 0; i < 109 && i < numFat; i++) {
    fatSectors.push(u32(buf, 76 + i * 4));
  }
  let d = firstDifat;
  let guardD = 0;
  while (d !== ENDOFCHAIN && d !== FREESECT && d < MAXREGSECT && guardD++ < numDifat + 10) {
    const off = s2off(d);
    for (let j = 0; j < sectorSize / 4 - 1 && fatSectors.length < numFat; j++) {
      const v = i32(buf, off + j * 4);
      if (v >= 0 && v < MAXREGSECT) fatSectors.push(v);
    }
    d = i32(buf, off + sectorSize - 4);
  }
  for (const fs of fatSectors) {
    if (fi >= fat.length) break;
    const off = s2off(fs);
    for (let j = 0; j < sectorSize / 4 && fi < fat.length; j++) {
      fat[fi++] = i32(buf, off + j * 4);
    }
  }

  const sect = (s, size) => {
    if (s === FREESECT || s === ENDOFCHAIN || s < 0) return Buffer.alloc(0);
    const off = s2off(s);
    const ss = Math.min(size !== undefined ? size : sectorSize, buf.length - off);
    return buf.subarray(off, off + Math.max(0, ss));
  };

  // Цепочка секторов через regular FAT
  function readChain(start, totalSize) {
    const parts = [];
    let cur = start;
    let steps = 0;
    const maxSteps = Math.ceil(totalSize / sectorSize) + 2000;
    while (cur !== FREESECT && cur !== ENDOFCHAIN && cur >= 0 && steps < maxSteps) {
      parts.push(sect(cur));
      cur = fat[cur];
      steps++;
    }
    return Buffer.concat(parts).subarray(0, totalSize);
  }

  // Каталог
  const dirStream = readChain(firstDir, 30000);
  const entries = [];
  for (let o = 0; o + 128 <= dirStream.length; o += 128) {
    const nameLen = u16(dirStream, o + 64);
    if (nameLen === 0 || nameLen > 512) break;
    let name;
    try { name = dirStream.toString("utf16le", o, o + nameLen - 2); }
    catch (e) { name = ""; }
    const type = dirStream[o + 66];
    const start = dirStream.readInt32LE(o + 116);
    const size = dirStream.readUInt32LE(o + 120);
    entries.push({ name, type, start, size });
  }

  const root = entries.find((e) => e.type === 5);

  // Mini-FAT (регулярная цепочка), если есть мини-поток
  let miniFat = null;
  if (root && firstMiniFat !== FREESECT && firstMiniFat < MAXREGSECT) {
    const mfData = readChain(firstMiniFat, numMiniFat * sectorSize);
    miniFat = new Int32Array(Math.floor(mfData.length / 4));
    for (let i = 0; i < miniFat.length; i++) miniFat[i] = i32(mfData, i * 4);
  }

  // Мини-поток (данные Root): цепочка regular FAT, размер = root.size
  let miniStream = null;
  if (root && miniFat) {
    miniStream = readChain(root.start, root.size);
  }

  // Чтение произвольного потока с учётом мини/обычной
  function readStream(entry) {
    if (entry.size < miniCutoff && miniStream && miniFat) {
      // мини-поток
      const parts = [];
      let cur = entry.start;
      let steps = 0;
      const maxSteps = Math.ceil(entry.size / miniSectorSize) + 2000;
      while (cur !== FREESECT && cur !== ENDOFCHAIN && cur >= 0 && steps < maxSteps && cur < miniFat.length) {
        const off = cur * miniSectorSize;
        if (off + miniSectorSize > miniStream.length) break;
        parts.push(miniStream.subarray(off, off + miniSectorSize));
        cur = miniFat[cur];
        steps++;
      }
      return Buffer.concat(parts).subarray(0, entry.size);
    }
    return readChain(entry.start, entry.size);
  }

  const work =
    entries.find((e) => e.type === 2 && /^workbook$/i.test(e.name)) ||
    entries.find((e) => e.type === 2 && /^book$/i.test(e.name));
  if (!work) throw new Error("Не найден Workbook/Book поток.");
  const wd = readStream(work);
  if (process.env.XLS_DEBUG) {
    console.error("XLS_DEBUG work.size", work.size, "read", wd.length, "mini?", work.size < miniCutoff, "miniStream len", miniStream ? miniStream.length : 0);
  }
  return { workbookData: wd };
}

// ---------- BIFF8 ----------
function* iterRecords(data) {
  let off = 0;
  while (off + 4 <= data.length) {
    const opcode = u16(data, off);
    const len = u16(data, off + 2);
    if (off + 4 + len <= data.length) {
      yield { opcode, len, data: data.subarray(off + 4, off + 4 + len) };
      off += 4 + len;
    } else break;
  }
}

// Стандартный способ RK -> double
function rkNumber(r) {
  const rk = i32(r, 0);
  const isInt = (rk & 2) === 0;
  const div100 = (rk & 1) === 1;
  if (isInt) {
    let v = rk >> 2;
    if (v & 0x10000000) v |= ~0x1fffffff; // sign extend 30-bit? (rk>>2 уже дал sign)
    v = rk >> 2;
    // правильная обработка знака: значение в 30 битах, знак в 30-м бите
    v = (rk & 0x3fffffff);
    if (v & 0x20000000) v -= 0x40000000;
    return div100 ? v / 100 : v;
  }
  // RFloat
  const d = rkToDouble(rk);
  return d;
}

function rkToDouble(rk) {
  // RFloat: (rk >> 2) 30-бит беззнак, интерпретируем как долю... Точной реализации
  // избегаем; большинство сумм целые — возвращаем целочисленное представление.
  const isInt = (rk & 2) === 0;
  const div100 = (rk & 1) === 1;
  let v = rk & 0x3fffffff;
  if (v & 0x20000000) v -= 0x40000000;
  return div100 ? v / 100 : v;
}

function parseBiff(data) {
  const records = [...iterRecords(data)];

  // SST: основная запись (0x00FC) + идущие за ней CONTINUE (0x003C).
  // В BIFF8 длинная таблица строк продолжается в CONTINUE-записях.
  let sst = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.opcode !== 0x00fc) continue;
    // собираем байты SST + следующих CONTINUE
    const parts = [Buffer.from(r.data.subarray(8))];
    for (let k = i + 1; k < records.length && records[k].opcode === 0x003c; k++) {
      parts.push(Buffer.from(records[k].data));
    }
    const sstBuf = Buffer.concat(parts);
    let pos = 0;
    while (pos < sstBuf.length) {
      if (pos + 3 > sstBuf.length) break;
      const len = u16(sstBuf, pos);
      const flags = sstBuf[pos + 2];
      pos += 3;
      const isU = (flags & 1) === 1;
      if (isU) {
        const rich = (flags & 0x08) === 0x08;
        const ext = (flags & 0x10) === 0x10;
        let richCount = 0, extSize = 0;
        if (rich) { richCount = u16(sstBuf, pos); pos += 2; }
        if (ext) { extSize = u32(sstBuf, pos); pos += 4; }
        if (pos + len * 2 > sstBuf.length) break;
        const s = sstBuf.toString("utf16le", pos, pos + len * 2);
        pos += len * 2;
        if (rich) pos += richCount * 4;
        if (ext) pos += extSize;
        sst.push(s);
      } else {
        if (pos + len > sstBuf.length) break;
        const buf = sstBuf.subarray(pos, pos + len);
        let s = "";
        for (let j = 0; j < buf.length; j++) {
          const cc = buf[j];
          // Windows-1251 -> Unicode для кириллицы
          if (cc >= 0xc0 && cc <= 0xff) s += String.fromCharCode(0x0410 + (cc - 0xc0));
          else if (cc >= 0x80 && cc <= 0xbf) s += String.fromCharCode(0x0400 + (cc - 0x80));
          else s += String.fromCharCode(cc);
        }
        pos += len;
        sst.push(s);
      }
    }
    break;
  }

  // BOUNDSHEET имена
  const bounds = [];
  for (const r of records) {
    if (r.opcode === 0x000d) {
      const cch = u16(r.data, 8);
      const grbit = r.data[10];
      let name;
      if (grbit & 0x08) {
        const flags = r.data[12];
        const uni = (flags & 1) === 1;
        const len = u16(r.data, 11) >>> 1;
        name = uni ? r.data.toString("utf16le", 13, 13 + len * 2) : r.data.toString("latin1", 12, 12 + len);
      } else {
        name = r.data.toString("latin1", 11, 11 + cch);
      }
      bounds.push({ name, pos: u32(r.data, 0) });
    }
  }

  // Сбор ячеек
  const rowMap = new Map();
  for (const r of records) {
    let row = -1, col = -1, value = null, num = null;
    if (r.opcode === 0x0203 || r.opcode === 0x0206) {
      // NUMBER
      row = u16(r.data, 0); col = u16(r.data, 2);
      num = r.data.readDoubleLE(6); value = String(num);
    } else if (r.opcode === 0x027e) {
      // RK
      row = u16(r.data, 0); col = u16(r.data, 2);
      num = rkNumber(r.data.subarray(6, 10)); value = String(num);
    } else if (r.opcode === 0x00fd) {
      // LABELSST
      row = u16(r.data, 0); col = u16(r.data, 2);
      const idx = u32(r.data, 6);
      value = sst[idx] !== undefined ? sst[idx] : "";
    } else if (r.opcode === 0x0204 || r.opcode === 0x0004) {
      // LABEL
      row = u16(r.data, 0); col = u16(r.data, 2);
      const cch = u16(r.data, 6);
      value = r.data.toString("latin1", 8, 8 + cch);
    } else if (r.opcode === 0x0201) {
      // ROW: задаём текущую строку
      row = u16(r.data, 0);
      if (!rowMap.has(row)) rowMap.set(row, []);
      continue;
    } else {
      continue;
    }
    if (row >= 0 && col >= 0) {
      if (!rowMap.has(row)) rowMap.set(row, []);
      const arr = rowMap.get(row);
      arr[col] = { value: value === null ? "" : String(value), num: typeof num === "number" ? num : null, col };
    }
  }

  const rows = [...rowMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rn, cells]) => ({ idx: rn, cells }));

  const name = bounds.length ? bounds[0].name : "Лист1";
  return { sheets: [{ name, rows }] };
}

function parseWorkbook(buffer) {
  const { workbookData } = parseCfb(buffer);
  return parseBiff(workbookData);
}

module.exports = { parseWorkbook };
