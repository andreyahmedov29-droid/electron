'use strict';
// Собственный лёгкий парсер .xlsx без внешних зависимостей (только node:zlib,
// node:fs). Замена SheetJS-воркера для нарезки входного прайса: SheetJS держал
// весь workbook в памяти (пик 600+ МБ на больших прайсах) и в отдельном
// воркер-потоке на проде зависал. Здесь мы распаковываем только два нужных
// XML (xl/worksheets/sheet1.xml и xl/sharedStrings.xml), читаем строки ПОТОКОМ
// и режем на JSON-чанки по chunkRows строк — пик памяти сопоставим с CSV-путем.
//
// Формат возврата совпадает с chunk-worker.js: { chunkPaths, head, rows, type, delim }.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const DEFLATE = 8;

// ---- Чтение центрального каталога ZIP ----
function readCentralDirectory(filePath) {
  const fd = fs.openSync(filePath, 'r');
  let size;
  try { size = fs.fstatSync(fd).size; } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
  // Ищем EOCD в хвосте файла (максимум 65536 байт + 22 байта записи).
  const maxLen = Math.min(size, 65536 + 22);
  if (maxLen < 22) throw new Error('файл слишком мал для ZIP');
  const tail = Buffer.alloc(maxLen);
  const fd2 = fs.openSync(filePath, 'r');
  try { fs.readSync(fd2, tail, 0, maxLen, size - maxLen); }
  finally { try { fs.closeSync(fd2); } catch (_) {} }

  let eocdLocal = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === ZIP_EOCD) { eocdLocal = i; break; }
  }
  if (eocdLocal === -1) throw new Error('не найден конец ZIP-архива');
  const cdSize = tail.readUInt32LE(eocdLocal + 12);
  const cdOffset = tail.readUInt32LE(eocdLocal + 16);

  const fd3 = fs.openSync(filePath, 'r');
  let cd;
  try {
    cd = Buffer.alloc(cdSize);
    // читаем по частям, чтобы не упираться в память на очень большом каталоге
    let read = 0;
    while (read < cdSize) {
      const chunk = Buffer.alloc(1 << 20);
      const r = fs.readSync(fd3, chunk, 0, Math.min(chunk.length, cdSize - read), cdOffset + read);
      chunk.copy(cd, read, 0, r);
      read += r;
    }
  } finally { try { fs.closeSync(fd3); } catch (_) {} }

  const entries = {};
  let pos = 0;
  while (pos + 46 <= cd.length) {
    if (cd.readUInt32LE(pos) !== ZIP_CENTRAL) break;
    const method = cd.readUInt16LE(pos + 10);
    const compSize = cd.readUInt32LE(pos + 20);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const localOffset = cd.readUInt32LE(pos + 42);
    const name = cd.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries[name] = { method, compSize, localOffset };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Смещение данных записи = локальный заголовок + имена/extra
function entryDataOffset(filePath, localOffset) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(30);
    fs.readSync(fd, buf, 0, 30, localOffset);
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    return localOffset + 30 + nameLen + extraLen;
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

// Потоковая распаковка deflate-записи: читаем сжатые байты по ~1 МБ и кормим
// inflateRaw. onData получает БУФЕРЫ (UTF-8 может разрываться на границе —
// собирает вызывающий через StringDecoder).
function streamDeflate(filePath, entry, onData) {
  return new Promise((resolve, reject) => {
    const dataOffset = entryDataOffset(filePath, entry.localOffset);
    const inf = zlib.createInflateRaw();
    const fd = fs.openSync(filePath, 'r');
    let pos = dataOffset;
    let remaining = entry.compSize;
    inf.on('data', onData);
    inf.on('end', () => { try { fs.closeSync(fd); } catch (_) {} resolve(); });
    inf.on('error', (e) => { try { fs.closeSync(fd); } catch (_) {} reject(e); });
    const feed = () => {
      if (remaining <= 0) { inf.end(); return; }
      const len = Math.min(remaining, 1 << 20);
      const buf = Buffer.alloc(len);
      const r = fs.readSync(fd, buf, 0, len, pos);
      pos += r; remaining -= r;
      if (r <= 0) { inf.end(); return; }
      const ok = inf.write(buf.subarray(0, r));
      if (ok) setImmediate(feed);
      else inf.once('drain', feed);
    };
    feed();
  });
}

// Полная распаковка записи в строку (для sharedStrings — он в памяти целиком).
function inflateToString(filePath, entry) {
  const chunks = [];
  const dec = new StringDecoder('utf8');
  return streamDeflate(filePath, entry, (b) => chunks.push(dec.write(b)))
    .then(() => chunks.join('') + dec.end());
}

function unescapeXml(s) {
  if (!s) return '';
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return _; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return _; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Адрес столбца: A=0, B=1, ..., AA=26
function colToIdx(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// Разбор sharedStrings.xml -> массив строк по индексу
function parseSharedStrings(xml) {
  const list = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const inner = m[1];
    // текст может быть в <t> напрямую либо в нескольких <t> внутри <r> (rich text)
    let s = '';
    const reT = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = reT.exec(inner))) s += tm[1];
    list.push(unescapeXml(s));
  }
  return list;
}

// Разбор одной строки <row ...>...</row> в массив ячеек.
function parseRowXml(rowXml, sharedStrings) {
  const map = {};
  let maxCol = -1;
  const re = /<c\b([^>]*)\/?>(?:([\s\S]*?)<\/c>)?/g;
  let m;
  while ((m = re.exec(rowXml))) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const rmatch = /r="([A-Z]+)\d+"/.exec(attrs);
    const colIdx = rmatch ? colToIdx(rmatch[1]) : maxCol + 1;
    const t = (/t="([^"]*)"/.exec(attrs) || [])[1] || 'n';
    let cellValue = '';
    if (t === 'inlineStr') {
      const tt = /<is>\s*<t[^>]*>([\s\S]*?)<\/t>\s*<\/is>/.exec(inner);
      cellValue = unescapeXml(tt ? tt[1] : '');
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const val = unescapeXml(v ? v[1] : '');
      if (t === 's') {
        const idx = parseInt(val, 10);
        cellValue = Number.isFinite(idx) && sharedStrings[idx] != null ? sharedStrings[idx] : '';
      } else if (t === 'str' || t === 'inlineStr') {
        cellValue = val;
      } else if (t === 'b') {
        cellValue = val === '1' ? true : (val === '0' ? false : val);
      } else {
        // число: оставляем числом (как делал SheetJS, cell.v)
        if (val === '') cellValue = '';
        else { const n = Number(val); cellValue = isFinite(n) ? n : val; }
      }
    }
    map[colIdx] = cellValue;
    if (colIdx > maxCol) maxCol = colIdx;
  }
  const row = [];
  for (let i = 0; i <= maxCol; i++) row.push(map[i] !== undefined ? map[i] : '');
  return row;
}

function writeChunkFile(chunksDir, fileId, idx, rows) {
  const p = path.join(chunksDir, fileId + '.' + idx + '.json');
  fs.writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}

// Выбор листа: предпочитаем первый лист; ищем по порядку xl/worksheets/sheetN.xml
function pickSheet(entries) {
  const names = Object.keys(entries);
  const sorted = names
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(/sheet(\d+)/.exec(a)[1], 10);
      const nb = parseInt(/sheet(\d+)/.exec(b)[1], 10);
      return na - nb;
    });
  if (sorted.length) return sorted[0];
  // запасной: лист с префиксом sheetN в любом каталоге
  const anySheet = names.find((n) => /\/sheet\d+\.xml$/.test(n));
  if (anySheet) return anySheet;
  throw new Error('в архиве не найден лист xl/worksheets/sheet1.xml');
}

// Проверка, что файл действительно OPC/ZIP (.xlsx). Для .xls возвращаем false.
function isXlsxZip(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    return b[0] === 0x50 && b[1] === 0x4b; // PK..
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

// Главная функция нарезки. Сигнатура совместима с воркером: возвращает
// Promise<{ chunkPaths, head, rows, type, delim }>.
async function chunkXlsx({ filePath, fileId, chunkRows, chunksDir, onProgress }) {
  if (!isXlsxZip(filePath)) {
    const err = new Error('XLSX_NOT_ZIP');
    err.code = 'XLSX_NOT_ZIP';
    throw err;
  }
  const chunkRowsN = chunkRows || 50000;
  const entries = readCentralDirectory(filePath);
  const sheetName = pickSheet(entries);
  const hasShared = Object.prototype.hasOwnProperty.call(entries, 'xl/sharedStrings.xml');
  let sharedStrings = [];
  if (hasShared) {
    const xml = entries['xl/sharedStrings.xml'].method === DEFLATE
      ? await inflateToString(filePath, entries['xl/sharedStrings.xml'])
      : readStored(filePath, entries['xl/sharedStrings.xml']);
    sharedStrings = parseSharedStrings(xml);
  }

  const chunkPaths = [];
  const head = [];
  let cur = [];
  let rows = 0;
  let idx = 0;
  const flush = () => {
    if (cur.length) { chunkPaths.push(writeChunkFile(chunksDir, fileId, idx, cur)); idx++; cur = []; }
  };

  const processor = makeRowProcessor((rowXml) => {
    const row = parseRowXml(rowXml, sharedStrings);
    if (head.length < 12) head.push(row);
    cur.push(row);
    rows++;
    if (cur.length >= chunkRowsN) flush();
    if (rows % 50000 === 0 && onProgress) onProgress(rows);
  });

  if (entries[sheetName].method === DEFLATE) {
    const dec = new StringDecoder('utf8');
    await streamDeflate(filePath, entries[sheetName], (b) => processor.push(dec.write(b)));
    processor.finish(dec.end());
  } else {
    processor.finish(readStored(filePath, entries[sheetName]));
  }
  flush();
  return { chunkPaths, head, rows, type: 'xlsx', delim: ';' };
}

// Поточный извлекатель строк <row ...>...</row> из XML-потока
function makeRowProcessor(onRow) {
  let pending = '';
  return {
    push(str) {
      if (!str) return;
      pending += str;
      this.drain();
    },
    finish(tail) {
      if (tail) pending += tail;
      this.drain();
    },
    drain() {
      let guard = 0;
      while (guard++ < 100000) {
        const s = pending.indexOf('<row');
        if (s === -1) break;
        const e = pending.indexOf('</row>', s);
        if (e === -1) break; // незавершённая строка на границе буфера
        const seg = e + '</row>'.length;
        try { onRow(pending.slice(s, seg)); } catch (_) {}
        pending = pending.slice(seg);
      }
    }
  };
}

// Чтение записи в STORE-режиме (без сжатия)
function readStored(filePath, entry) {
  const dataOffset = entryDataOffset(filePath, entry.localOffset);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(entry.compSize);
    fs.readSync(fd, buf, 0, entry.compSize, dataOffset);
    return buf.toString('utf8');
  } finally { try { fs.closeSync(fd); } catch (_) {} }
}

// Потоковая нарезка CSV/TXT В ГЛАВНОМ ПРОЦЕССЕ (без worker_threads).
// Причина: worker-нарезка CSV на проде могла «молчать» (не давать прогресс и
// не завершаться в разумный срок). Здесь readline построчно пишет чанки-файлы
// и шлёт onProgress каждые 5000 строк — задержек загрузки нет, прогресс виден.
function detectDelim(firstLine) {
  const counts = [';', ',', '\t'].map((d) => [d, (firstLine.match(new RegExp('\\' + d, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}
function splitCsvLine(line, delim) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  if (out[0] && out[0].charCodeAt(0) === 0xFEFF) out[0] = out[0].slice(1);
  return out;
}
async function chunkCsv({ filePath, fileId, chunkRows, chunksDir, onProgress, maxRows }) {
  const chunkRowsN = chunkRows || 50000;
  const MAX = maxRows || Infinity;
  // первый блок — чтобы узнать разделитель
  const fd = fs.openSync(filePath, 'r');
  let firstBuf = Buffer.alloc(4096);
  const n = fs.readSync(fd, firstBuf, 0, 4096, 0);
  fs.closeSync(fd);
  const firstLine = firstBuf.toString('utf8', 0, n).split(/\r?\n/)[0] || '';
  const delim = detectDelim(firstLine);

  const readline = require('readline');
  const chunkPaths = [];
  const head = [];
  let cur = [];
  let idx = 0;
  let rows = 0;
  // ОЧЕРЕДЬ записей чанков. Каждая запись берёт СНИМОК cur, поэтому порядок и
  // полнота данных гарантированы даже если строки приходят быстрее, чем пишется
  // диск. Запись асинхронная (fs.promises.writeFile) + setImmediate между ними —
  // главный процесс не блокируется на больших прайсах (раньше синхронный
  // writeFileSync на 30 чанков по 50к строк «замораживал» страницу на проде).
  let flushChain = Promise.resolve();
  const enqueueFlush = () => {
    if (!cur.length) return;
    const snap = cur; cur = [];
    flushChain = flushChain.then(async () => {
      const json = JSON.stringify(snap);
      await new Promise((r) => setImmediate(r));
      await fs.promises.writeFile(path.join(chunksDir, fileId + '.' + idx + '.json'), json, 'utf8');
      chunkPaths.push(path.join(chunksDir, fileId + '.' + idx + '.json'));
      idx++;
      await new Promise((r) => setImmediate(r));
    });
  };
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  await new Promise((resolve, reject) => {
    rl.on('line', (line) => {
      const row = splitCsvLine(line, delim);
      if (head.length < 12) head.push(row);
      cur.push(row);
      rows++;
      if (rows > MAX) {
        const e = new Error('Файл слишком большой для обработки в памяти: превышен лимит ' + MAX.toLocaleString('ru-RU') + ' строк на прайс. Разделите файл на части и загрузите по очереди.');
        rl.close();
        reject(e);
        return;
      }
      if (cur.length >= chunkRowsN) enqueueFlush();
      if (rows % 5000 === 0 && onProgress) onProgress(rows);
    });
    rl.on('close', () => {
      enqueueFlush(); // остаток
      flushChain.then(resolve).catch((e) => reject(e));
    });
    rl.on('error', reject);
  });
  await flushChain;
  return { chunkPaths, head, rows, type: 'csv', delim };
}

module.exports = { chunkXlsx, isXlsxZip, chunkCsv };
