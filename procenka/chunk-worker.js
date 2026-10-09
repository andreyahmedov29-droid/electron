'use strict';
// Воркер-поток для НАРЕЗКИ файла на чанки-файлы. Запускается из server.js.
// Причина: XLSX.readFile держит весь workbook в памяти главного процесса
// (пик 600+ МБ на больших прайсах) и ронял контейнер. В отдельном воркере
// пик памяти изолирован, а после завершения воркера V8 освобождает её.
//
// Вход через workerData: { filePath, fileId, chunkRows }
// Выход через postMessage: { ok, chunkPaths, head, rows, type, delim } | { ok:false, error }
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const os = require('os');
const { parentPort, workerData } = require('worker_threads');

const CHUNKS_DIR = workerData.chunksDir;
const CHUNK_ROWS = workerData.chunkRows || 50000;
const filePath = workerData.filePath;
const fileId = workerData.fileId;
// Предохранитель на число строк: если в воркере уже собрано больше лимита,
// продолжать нарезку бессмысленно (сервер всё равно откажет в конце) — а файл
// на миллионы строк мололся бы минуты с виду «ничего не происходит». Ранний
// выход сразу сообщает ошибку. Лимит спускается из server.js (MAX_FILE_ROWS).
const MAX_ROWS = workerData.maxRows || 2500000;

function writeChunkFile(idx, rows) {
  const p = path.join(CHUNKS_DIR, fileId + '.' + idx + '.json');
  fs.writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}

function splitCSVLine(line, delim) {
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

function detectFileType(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xlsx';
  } catch (_) {}
  return 'csv';
}

function detectDelim(p) {
  let first = '';
  try {
    const buf = fs.readFileSync(p, { encoding: 'utf8' });
    first = buf.split(/\r?\n/)[0] || '';
    if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1);
  } catch (_) {}
  const counts = [';', ',', '\t'].map((d) => [d, (first.match(new RegExp('\\' + d, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

async function chunkCsv() {
  const delim = detectDelim(filePath);
  // Мгновенный стартовый тик: фронт сразу видит «Обрабатываю… 0 строк» и
  // понимает, что нарезка запущена (а не «застыло» до первого порога строк).
  parentPort.postMessage({ type: 'progress', rows: 0 });
  const chunkPaths = [];
  const head = [];
  let cur = [];
  let rows = 0;
  let idx = 0;
  const flush = () => {
    if (cur.length) { chunkPaths.push(writeChunkFile(idx, cur)); idx++; cur = []; }
  };
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const row = splitCSVLine(line, delim);
      if (head.length < 12) head.push(row);
      cur.push(row);
      rows++;
      if (rows > MAX_ROWS) throw new Error('Файл слишком большой для обработки в памяти: превышен лимит ' + MAX_ROWS.toLocaleString('ru-RU') + ' строк на прайс. Разделите файл на части и загрузите по очереди.');
      if (cur.length >= CHUNK_ROWS) flush();
      if (rows % 5000 === 0) parentPort.postMessage({ type: 'progress', rows });
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  flush();
  return { chunkPaths, head, rows, type: 'csv', delim };
}

async function chunkXlsx() {
  let _XLSX;
  try { _XLSX = require(path.join(workerData.vendorDir, 'xlsx')); }
  catch (e) { throw new Error('не найден модуль xlsx'); }
  const XLSX = _XLSX;
  parentPort.postMessage({ type: 'progress', rows: 0 });
  const wb = XLSX.readFile(filePath); // пик памяти — здесь, НО только в этом воркере
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rng = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!rng) return { chunkPaths: [], head: [], rows: 0, type: 'xlsx', delim: ';' };
  const chunkPaths = [];
  const head = [];
  let cur = [];
  let rows = 0;
  let idx = 0;
  const flush = () => {
    if (cur.length) { chunkPaths.push(writeChunkFile(idx, cur)); idx++; cur = []; }
  };
  const STEP = 15000;
  let R = rng.s.r;
  while (R <= rng.e.r) {
    const end = Math.min(rng.e.r, R + STEP - 1);
    for (let curRow = R; curRow <= end; curRow++) {
      const row = [];
      for (let C = rng.s.c; C <= rng.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: curRow, c: C })];
        row.push(cell && cell.v != null ? cell.v : '');
      }
      if (head.length < 12) head.push(row);
      cur.push(row);
      rows++;
      if (rows > MAX_ROWS) throw new Error('Файл слишком большой для обработки в памяти: превышен лимит ' + MAX_ROWS.toLocaleString('ru-RU') + ' строк на прайс. Разделите файл на части и загрузите по очереди.');
      if (cur.length >= CHUNK_ROWS) flush();
      if (rows % 5000 === 0) parentPort.postMessage({ type: 'progress', rows });
    }
    await new Promise((resolve) => setImmediate(resolve));
    R = end + 1;
  }
  flush();
  // освобождаем workbook перед выходом
  try { wb.Sheets = null; } catch (_) {}
  return { chunkPaths, head, rows, type: 'xlsx', delim: ';' };
}

(async () => {
  try {
    let info;
    if (detectFileType(filePath) === 'xlsx') info = await chunkXlsx();
    else info = await chunkCsv();
    parentPort.postMessage({ ok: true, ...info });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
})();
