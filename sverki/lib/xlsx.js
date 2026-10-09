// Минимальный парсер XLSX ("настоящий" формат .xlsx — архив OOXML).
// Реализован на стандартной библиотеке Node без внешних зависимостей,
// чтобы сборка платформы не зависела от доступности реестра пакетов.
"use strict";

const zlib = require("zlib");

// ---------- ZIP (чтение без внешних библиотек) ----------
function u16(buf, off) {
  return buf.readUInt16LE(off);
}

function parseZip(buffer) {
  // Ищем End of Central Directory (EOCD) — сигнатура 0x06054b50.
  let eocd = -1;
  let min = buffer.length - 65557;
  if (min < 0) min = 0;
  for (let i = buffer.length - 22; i >= min; i--) {
    if (u16(buffer, i) === 0x4b50 && u16(buffer, i + 2) === 0x0605) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) {
    throw new Error("Не похоже на ZIP-архив (XLSX).");
  }

  const entryCount = u16(buffer, eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);

  // Читаем центральный каталог.
  const entries = new Map();
  let off = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (u16(buffer, off) !== 0x4b50 || u16(buffer, off + 2) !== 0x0201) {
      break; // конец каталога
    }
    const method = u16(buffer, off + 10);
    const compSize = buffer.readUInt32LE(off + 20);
    const uncompSize = buffer.readUInt32LE(off + 24);
    const nameLen = u16(buffer, off + 28);
    const extraLen = u16(buffer, off + 30);
    const commentLen = u16(buffer, off + 32);
    const localOffset = buffer.readUInt32LE(off + 42);
    const name = buffer
      .subarray(off + 46, off + 46 + nameLen)
      .toString("utf8");
    entries.set(name, {
      method,
      compSize,
      uncompSize,
      localOffset,
      name,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }

  const store = new Map();
  for (const [name, e] of entries) {
    let data;
    // local file header: сигнатура 0x04034b50
    let lo = e.localOffset;
    const lnameLen = u16(buffer, lo + 26);
    const lextraLen = u16(buffer, lo + 28);
    let start = lo + 30 + lnameLen + lextraLen;
    const raw = buffer.subarray(start, start + e.compSize);
    if (e.method === 0) {
      data = Buffer.from(raw);
    } else if (e.method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      data = Buffer.from(raw);
    }
    store.set(name, data);
  }
  return store;
}

// ---------- XML (лёгкий парсер для нашей структуры) ----------
// Итерируем по вхождениям тега. Поддерживаем и открывающий+закрывающий,
// и самозакрывающийся (<name ... /> — для тегов с атрибутами без тела).
function* iterTags(xml, name) {
  const re = new RegExp(`<${name}\\b[^>]*>`, "g");
  let m;
  while ((m = re.exec(xml)) !== null) {
    const full = m[0];
    if (/\/\s*>$/.test(full)) {
      // самозакрывающийся тег — тела нет, только атрибуты
      yield { start: m, end: m, inner: "" };
      continue;
    }
    const endTag = new RegExp(`</${name}\\s*>`, "g");
    endTag.lastIndex = m.index + full.length;
    const e = endTag.exec(xml);
    if (e) {
      yield {
        start: m,
        end: e,
        inner: xml.slice(m.index + full.length, e.index),
      };
    }
  }
}

function attrs(tag) {
  const res = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) res[m[1]] = m[2];
  return res;
}

function decodeEnts(str) {
  return str
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---------- Разбор книги ----------
function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  for (const si of iterTags(xml, "si")) {
    // Объединяем весь текст внутри <si>
    let text = "";
    for (const t of iterTags(si.inner, "t")) {
      text += decodeEnts(t.inner);
    }
    // если есть <phoneticPr> и пр. — не критично
    out.push(text);
  }
  return out;
}

function columnIndex(ref) {
  // ref вида "A1", "AB12"
  let col = 0;
  const r = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!r) return null;
  for (const ch of r[1]) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { col: col - 1, row: parseInt(r[2], 10) - 1 };
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rowNode of iterTags(xml, "row")) {
    const rowIdx = parseInt(attrs(rowNode.start[0]).r, 10) || rows.length;
    const cells = [];
    for (const c of iterTags(rowNode.inner, "c")) {
      const tag = c.start[0];
      const a = attrs(tag);
      const ref = columnIndex(a.r);
      let value = "";
      let type = a.t;
      let num = null;
      for (const v of iterTags(c.inner, "v")) {
        value = decodeEnts(v.inner);
      }
      for (const is of iterTags(c.inner, "is")) {
        // inline string
        for (const t of iterTags(is.inner, "t")) value += decodeEnts(t.inner);
      }
      if (type === "s") {
        const idx = parseInt(value, 10);
        value = Number.isFinite(idx) ? shared[idx] || "" : "";
        type = "s";
      } else if (type === "inlineStr") {
        type = "s";
      } else if (type === "b") {
        value = value === "1" ? "ИСТИНА" : "ЛОЖЬ";
        type = "b";
      } else if (type === "e") {
        type = "e";
      } else if (type === "str") {
        type = "s";
      } else {
        // число
        const parsed = parseFloat(value);
        if (Number.isFinite(parsed)) {
          num = parsed;
          type = "n";
        } else {
          type = "n";
        }
      }
      if (ref) {
        cells[ref.col] = { value: String(value), num, type, col: ref.col };
      }
    }
    rows.push({ idx: rowIdx, cells });
  }
  return rows;
}

// Точка входа: Buffer с данными xlsx -> { sheets: [...], rows: [...] }
function parseWorkbook(buffer) {
  const store = parseZip(buffer);
  const wbXml = store
    .get("xl/workbook.xml") || store.get("xl/workbook.bin");
  if (!wbXml) {
    // может быть плоское имя — поищем
    for (const k of store.keys()) {
      if (/^xl\/workbook\./.test(k)) {
        return parseWorkbookProxy(store, k);
      }
    }
    throw new Error("Не найден xl/workbook.xml в архиве.");
  }

  const xml = wbXml.toString("utf8");

  // Имена листов
  const sheetNames = [];
  for (const s of iterTags(xml, "sheet")) {
    const a = attrs(s.start[0]);
    sheetNames.push(a.name || "");
  }

  // Карта sheetId -> r:id
  const rels = new Map();
  const wbRelsXml =
    (store.get("xl/_rels/workbook.xml.rels") || Buffer.from("")).toString(
      "utf8"
    );
  for (const rel of iterTags(wbRelsXml, "Relationship")) {
    const a = attrs(rel.start[0]);
    rels.set(a.Id, a.Target);
  }

  // sheet r:id -> имя файла
  const sheetIdToFile = [];
  let k = 0;
  for (const s of iterTags(xml, "sheet")) {
    const a = attrs(s.start[0]);
    const rid = a["r:id"] || a.id;
    let target = rels.get(rid);
    const name = a.name || `Лист${k + 1}`;
    sheetIdToFile.push({ rid, target, name });
    k++;
  }

  // Собираем листы
  const sheets = [];
  for (const idx in sheetIdToFile) {
    const { target, name } = sheetIdToFile[idx];
    if (!target) {
      sheets.push({ name, rows: [] });
      continue;
    }
    let filePath = target;
    if (!filePath.startsWith("xl/") && !filePath.startsWith("/")) {
      filePath = "xl/" + filePath;
    }
    filePath = filePath.replace(/^\//, "");
    let sheetBuf = store.get(filePath);
    if (!sheetBuf) {
      // возможно путь с ../ — упростим
      const norm = filePath.replace(/^xl\//, "");
      sheetBuf = store.get("xl/" + norm);
    }
    if (!sheetBuf) {
      sheets.push({ name, rows: [] });
      continue;
    }
    const sheetXml = sheetBuf.toString("utf8");
    sheets.push({ name, rows: parseSheet(sheetXml, sharedStrings(store)) });
  }
  return { sheets };
}

function sharedStrings(store) {
  const buf = store.get("xl/sharedStrings.xml");
  if (!buf) return [];
  return parseSharedStrings(buf.toString("utf8"));
}

function parseWorkbookProxy(store, k) {
  const xml = store.get(k).toString("utf8");
  const sheetNames = [];
  for (const s of iterTags(xml, "sheet")) {
    sheetNames.push(attrs(s.start[0]).name || "");
  }
  const sheets = [];
  // ищем любые листы в архив
  const keys = [...store.keys()].filter((x) => /^xl\/worksheets\/sheet/.test(x));
  keys.sort();
  for (let i = 0; i < keys.length; i++) {
    const buf = store.get(keys[i]);
    sheets.push({
      name: sheetNames[i] || `Лист${i + 1}`,
      rows: parseSheet(buf.toString("utf8"), sharedStrings(store)),
    });
  }
  return { sheets };
}

module.exports = { parseWorkbook };
