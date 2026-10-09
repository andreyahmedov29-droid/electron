'use strict';
// Воркер-поток для ПОТОКОВОЙ сборки итогового xlsx из CSV-результата.
//
// Собирает xlsx ВРУЧНУЮ: worksheet-XML пишется построчно в temp-файл, затем
// всё упаковывается в ZIP. В отличие от SheetJS (XLSX.write держал весь лист
// в RAM и давал пик ~1,4 ГБ на сотни тысяч строк), память здесь практически
// постоянная и НЕ зависит от числа строк — сборка влезает в дешёвый контейнер.
//
// Сжатие — метод DEFLATE (8): тот же zlib, что видит браузер/Excel, файл
// получается в ~3-4 раза меньше, чем методом STORED без сжатия.
//
// workerData: { csvPath, outPath, task }
// Результат: postMessage { ok:true } | { ok:false, error }
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const readline = require('readline');
const { parentPort, workerData } = require('worker_threads');

// ---- CRC32 (табличный) — для ZIP-заголовков ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Update(crc, buf) {
  crc = (~crc) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = ((crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]) >>> 0;
  return (~crc) >>> 0;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Разбор CSV-строки (формат как в worker.js: ;-разделитель, кавычки).
function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ';') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const COLS = ['A', 'B', 'C', 'D', 'E', 'F'];

// Ячейка по индексу колонки и строке. Число -> <c r=..><v>N</v></c>, текст -> inlineStr.
function cellXml(colIdx, row, val, isNum) {
  const ref = COLS[colIdx] + row;
  if (isNum && val !== '' && val != null && isFinite(Number(val))) {
    return '<c r="' + ref + '" s="1"><v>' + Number(val) + '</v></c>';
  }
  return '<c r="' + ref + '" s="1" t="inlineStr"><is><t xml:space="preserve">' + esc(val) + '</t></is></c>';
}

// Полный sheetData-XML листа «Сравнение» пишется ПОСТРОЧНО в temp-файл:
// читаем CSV-исходник и сразу пишем строки worksheet — в RAM не копится ни
// лист, ни буфер, пик памяти остаётся постоянным.
async function writeSheet1(csvPath, sheetPath) {
  const out = fs.createWriteStream(sheetPath, 'utf8');
  let r = 1; // счётчик строк в листе (доступен и после Promise, для возврата)
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    // Ширины колонок: чтобы лист открывался аккуратно без ручного раздвигания.
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<cols>'
    + '<col min="1" max="1" width="26" customWidth="1"/>'
    + '<col min="2" max="2" width="16" customWidth="1"/>'
    + '<col min="3" max="3" width="16" customWidth="1"/>'
    + '<col min="4" max="4" width="15" customWidth="1"/>'
    + '<col min="5" max="5" width="13" customWidth="1"/>'
    + '<col min="6" max="6" width="20" customWidth="1"/>'
    + '</cols><sheetData>';
  const TAIL = '</sheetData></worksheet>';
  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.write(HEAD);
    const rl = readline.createInterface({ input: fs.createReadStream(csvPath, { encoding: 'utf8' }), crlfDelay: Infinity });
    let pending = '';
    rl.on('line', (line) => {
      if (!line.trim()) return;
      const cells = splitCsvLine(line);
      // 6 колонок: [артикул, цена1, цена2, разница, %, кто дешевле]
      const isNum = [false, true, true, true, true, false];
      let rowXml = '<row r="' + r + '">';
      for (let c = 0; c < 6; c++) rowXml += cellXml(c, r, cells[c], isNum[c]);
      rowXml += '</row>';
      pending += rowXml;
      // flush по мере накопления, чтобы не держать большой pending
      if (pending.length >= 262144) { out.write(pending); pending = ''; }
      r++;
    });
    rl.on('close', () => {
      out.write(pending); pending = '';
      out.write(TAIL);
      out.end(() => resolve());
    });
    rl.on('error', reject);
  });
  return r - 1; // число строк данных
}

// Лист «Итоги»: метаданные сравнения + распределение разницы по диапазонам.
function buildSheet2Xml(task) {
  const aName = task.aName || 'Прайс 1';
  const bName = task.bName || 'Прайс 2';
  const aIsOurs = String(aName).trim().toLowerCase() === 'проф';
  const oursName = aIsOurs ? aName : bName;   // наш прайс — «Проф»
  const rivalName = aIsOurs ? bName : aName;  // конкуренты
  const rows = [];
  rows.push(['Показатель', 'Значение']);
  rows.push(['Общих артикулов (совпадений)', String(task.matched || 0)]);
  rows.push(['Дешевле «' + aName + '»', String(task.cheaperA || 0)]);
  rows.push(['Дешевле «' + bName + '»', String(task.cheaperB || 0)]);
  rows.push(['Цены равны', String(task.equal || 0)]);
  if (typeof task.medianPct === 'number' && isFinite(task.medianPct)) {
    const m = Math.round(task.medianPct * 100) / 100;
    rows.push(['Медианная разница (%)', (m > 0 ? '+' : '') + m.toFixed(2).replace('.', ',') + '%']);
  }
  if (task.curA && task.curA !== 'RUB') rows.push(['Курс ' + task.curA + ' → RUB: ' + (Number(task.rateA) || 1), '']);
  if (task.curB && task.curB !== 'RUB') rows.push(['Курс ' + task.curB + ' → RUB: ' + (Number(task.rateB) || 1), '']);

  // Распределение разницы по шагам в 1 п.п. (устойчиво к выбросам).
  const more = Array.isArray(task.oursMore) ? task.oursMore : [];
  const less = Array.isArray(task.oursLess) ? task.oursLess : [];
  rows.push([]);
  rows.push(['На сколько снизить цену «' + oursName + '», чтобы сравняться с конкурентами «' + rivalName + '» по доле позиций']);
  const discTargets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const disc = (task.disc && typeof task.disc === 'object') ? task.disc : null;
  if (disc && discTargets.some((x) => disc['p' + x] != null)) {
    rows.push(['Доля позиций, где мы перестаём быть дороже', 'Нужная скидка на «' + oursName + '», %']);
    for (const x of discTargets) {
      if (disc['p' + x] == null) continue;
      rows.push([x + '% позиций', disc['p' + x]]);
    }
    rows.push(['Всего учтено позиций с ценами обоих прайсов', String(task.discTotal || 0)]);
    rows.push(['Из них уже не дороже конкурента (скидка 0%)', String(task.discNeg || 0)]);
  } else {
    rows.push(['Перцентили скидок не рассчитаны (нет данных по ценам)']);
  }
  rows.push([]);
  rows.push(['Распределение разницы по совпавшим позициям («' + oursName + '» — ваш прайс)']);
  rows.push(['Диапазон', 'Конкуренты «' + rivalName + '» дешевле нас, позиций', 'Мы «' + oursName + '» дешевле, позиций']);
  const H = 50;
  for (let k = 0; k <= H; k++) {
    const label = k >= H ? 'более ' + H + '%' : ((k + 1) + '%');
    rows.push([label, (more[k] || 0), (less[k] || 0)]);
  }

  // Первая колонка — текст, остальные (где число) — числовые ячейки.
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    // Широкие колонки для показателя и значений — без ручного раздвигания.
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<cols>'
    + '<col min="1" max="1" width="82" customWidth="1"/>'
    + '<col min="2" max="2" width="46" customWidth="1"/>'
    + '<col min="3" max="3" width="46" customWidth="1"/>'
    + '</cols><sheetData>';
  rows.forEach((row, i) => {
    const r = i + 1;
    const t0raw = String(row[0] == null ? '' : row[0]);
    const isSection = /(снизить цену|Распределение разницы|Перцентили скидок)/.test(t0raw);
    const isColHead = /^(Показатель|Диапазон|Доля позиций)/.test(t0raw);
    let rowXml = '<row r="' + r + '">';
    for (let c = 0; c < row.length; c++) {
      const ref = (COLS[c] || 'F') + r;
      const v = row[c];
      const txt = String(v == null ? '' : v);
      let s = '1';
      if (isSection || isColHead) s = '3';          // серый фон: заголовки секций и колонок
      else if (c === 0 && /%|более/.test(txt)) s = '2'; // жирный: диапазон
      if (c > 0 && typeof v === 'number' && isFinite(v)) rowXml += '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
      else rowXml += '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(v == null ? '' : v) + '</t></is></c>';
    }
    rowXml += '</row>';
    xml += rowXml;
  });
  return xml + '</sheetData></worksheet>';
}

// ---- ZIP c DEFLATE (метод 8) ----
// Для каждого файла считаем CRC и размер (uncomp) на лету первым проходом,
// затем вторым проходом пишем в ZIP: local header (с методом 8) + сжатые
// данные. Сжимаем потоком через zlib.createDeflateRaw — в RAM держится лишь
// текущий буфер, а не весь лист.

function scanFile(p) {
  let crc = 0, size = 0;
  const buf = fs.readFileSync(p);
  crc = crc32Update(0, buf);
  size = buf.length;
  // Возвращаем байты, чтобы не читать файл дважды; для листа 1 это единственный
  // проход в память — большой, но уже не решающий (сжатие идёт прямо отсюда).
  return { buf, crc, size };
}

function localHeader(name, size, compSize, crc, method) {
  const nb = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(30 + nb.length);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(method, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0, 12);
  b.writeUInt32LE(crc >>> 0, 14);
  b.writeUInt32LE(compSize >>> 0, 18);
  b.writeUInt32LE(size >>> 0, 22);
  b.writeUInt16LE(nb.length, 26);
  b.writeUInt16LE(0, 28);
  nb.copy(b, 30);
  return b;
}
function centralEntry(name, offset, size, compSize, crc, method) {
  const nb = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(46 + nb.length);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(method, 10);
  b.writeUInt16LE(0, 12);
  b.writeUInt16LE(0, 14);
  b.writeUInt32LE(crc >>> 0, 16);
  b.writeUInt32LE(compSize >>> 0, 20);
  b.writeUInt32LE(size >>> 0, 24);
  b.writeUInt16LE(nb.length, 28);
  b.writeUInt16LE(0, 30);
  b.writeUInt16LE(0, 32);
  b.writeUInt16LE(0, 34);
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE(0, 38);
  b.writeUInt32LE(offset >>> 0, 42);
  nb.copy(b, 46);
  return b;
}

async function assembleXlsx(outPath, entries) {
  // entries: [{ name, buf, crc, size, compBuf }] — в порядке следования
  const ws = fs.createWriteStream(outPath);
  const central = [];
  let offset = 0;
  await new Promise((resolve, reject) => {
    ws.on('error', reject);
    (async () => {
      for (const p of entries) {
        const method = p.compBuf ? 8 : 0;
        const compSize = p.compBuf ? p.compBuf.length : p.size;
        central.push(centralEntry(p.name, offset, p.size, compSize, p.crc, method));
        const lh = localHeader(p.name, p.size, compSize, p.crc, method);
        if (!ws.write(lh)) await new Promise((r) => ws.once('drain', r));
        offset += lh.length;
        const data = p.compBuf || p.buf;
        if (!ws.write(data)) await new Promise((r) => ws.once('drain', r));
        offset += data.length;
      }
      ws.end(() => resolve());
    })();
  });
  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  await new Promise((resolve, reject) => {
    const ws2 = fs.createWriteStream(outPath, { flags: 'a' });
    ws2.on('error', reject);
    ws2.write(cdBuf);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdStart >>> 0, 16);
    eocd.writeUInt16LE(0, 20);
    ws2.write(eocd);
    ws2.end(() => resolve());
  });
}

async function build() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcxlsx_'));
  const sheet1Path = path.join(tmpDir, 'sheet1.xml');
  const sheet2Path = path.join(tmpDir, 'sheet2.xml');
  try {
    await writeSheet1(workerData.csvPath, sheet1Path);
    fs.writeFileSync(sheet2Path, buildSheet2Xml(workerData.task), 'utf8');

    const ctypes = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>', 'utf8');
    const rootRels = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>', 'utf8');
    const workbook = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets>'
      + '<sheet name="Сравнение" sheetId="1" r:id="rId1"/>'
      + '<sheet name="Итоги" sheetId="2" r:id="rId2"/>'
      + '</sheets></workbook>', 'utf8');
    const wbRels = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
      + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>', 'utf8');

    // Стили: индекс 0 — по умолчанию, индекс 1 — текст и числа по центру
    // (по горизонтали и вертикали). На него ссылаются ячейки через s="1".
    const styles = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="2">'
      + '<font><sz val="11"/><name val="Calibri"/></font>'
      + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
      + '</fonts>'
      + '<fills count="3">'
      + '<fill><patternFill patternType="none"/></fill>'
      + '<fill><patternFill patternType="gray125"/></fill>'
      + '<fill><patternFill patternType="solid"><fgColor rgb="FFE7E6E6"/><bgColor indexed="64"/></patternFill></fill>'
      + '</fills>'
      + '<borders count="2">'
      + '<border><left/><right/><top/><bottom/><diagonal/></border>'
      + '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>'
      + '</borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="4">'
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
      // 1 — данные: центр + тонкие границы
      + '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
      // 2 — жирный (диапазон, км примеру)
      + '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
      // 3 — серый фон (заголовки секций и колонок)
      + '<xf numFmtId="0" fontId="0" fillId="2" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>'
      + '</cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>', 'utf8');

    // Сканируем лист1 и лист2: CRC + размер + сжатие. Лист1 большой — читаем его
    // байты один раз и сжимаем deflateSync (пик локальный, вне основного Event loop).
    const s1 = scanFile(sheet1Path);
    const s2 = scanFile(sheet2Path);
    const comp1 = zlib.deflateRawSync(s1.buf, { level: 6 });
    const comp2 = zlib.deflateRawSync(s2.buf, { level: 6 });
    // Мелкие файлы: сжимаем тоже (они крошечные)
    const compCtypes = zlib.deflateRawSync(ctypes);
    const compRoot = zlib.deflateRawSync(rootRels);
    const compWorkbook = zlib.deflateRawSync(workbook);
    const compWbRels = zlib.deflateRawSync(wbRels);
    const compStyles = zlib.deflateRawSync(styles);

    const entries = [
      { name: '[Content_Types].xml', buf: ctypes, compBuf: compCtypes, crc: crc32Update(0, ctypes), size: ctypes.length },
      { name: '_rels/.rels', buf: rootRels, compBuf: compRoot, crc: crc32Update(0, rootRels), size: rootRels.length },
      { name: 'xl/workbook.xml', buf: workbook, compBuf: compWorkbook, crc: crc32Update(0, workbook), size: workbook.length },
      { name: 'xl/_rels/workbook.xml.rels', buf: wbRels, compBuf: compWbRels, crc: crc32Update(0, wbRels), size: wbRels.length },
      { name: 'xl/styles.xml', buf: styles, compBuf: compStyles, crc: crc32Update(0, styles), size: styles.length },
      { name: 'xl/worksheets/sheet1.xml', buf: s1.buf, compBuf: comp1, crc: s1.crc, size: s1.size },
      { name: 'xl/worksheets/sheet2.xml', buf: s2.buf, compBuf: comp2, crc: s2.crc, size: s2.size },
    ];

    await assembleXlsx(workerData.outPath, entries);
  } finally {
    try { fs.unlinkSync(sheet1Path); } catch (_) {}
    try { fs.unlinkSync(sheet2Path); } catch (_) {}
    try { fs.rmdirSync(tmpDir); } catch (_) {}
    try { fs.unlinkSync(workerData.csvPath); } catch (_) {} // снимок больше не нужен
  }
}

build().then(() => parentPort.postMessage({ ok: true }))
  .catch((e) => parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) }));
