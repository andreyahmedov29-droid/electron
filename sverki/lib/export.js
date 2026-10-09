// Экспорт отчёта о расхождениях в настоящий .xlsx (OOXML + ZIP)
// на стандартной библиотеке Node. Генерируем простую книгу с одним
// листом: столбцы — ключ, тип расхождения, поля, значения двух файлов,
// объяснение.
"use strict";

const zlib = require("zlib");

function xmlEscape(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function colName(n) {
  // 1 -> A
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellRef(row, col) {
  return colName(col + 1) + (row + 1);
}

// Простой CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// Пишем ZIP-архив (метод store — без сжатия, чтобы не тратить время;
// Excel открывает и store, и deflate). Для больших отчётов включим deflate.
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    let data = f.data;
    let method = 0;
    let comp = Buffer.from(data);
    // deflate для непустых
    if (data.length > 0) {
      comp = zlib.deflateRawSync(data);
      if (comp.length < data.length) {
        method = 8;
      } else {
        comp = data;
        method = 0;
      }
    }
    const crc = crc32(data);
    const compSize = comp.length;
    const uncompSize = data.length;
    const nameLen = nameBuf.length;

    // local file header
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(compSize, 18);
    lfh.writeUInt32LE(uncompSize, 22);
    lfh.writeUInt16LE(nameLen, 26);
    lfh.writeUInt16LE(0, 28); // extra len

    chunks.push(lfh, nameBuf, comp);
    central.push({
      nameBuf,
      method,
      crc,
      compSize,
      uncompSize,
      localOffset: offset,
    });
    offset += lfh.length + nameLen + compSize;
  }

  const centralStart = offset;
  const centralChunks = [];
  for (const c of central) {
    const rec = Buffer.alloc(46);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(20, 4); // version made by
    rec.writeUInt16LE(20, 6); // version needed
    rec.writeUInt16LE(0, 8); // flags
    rec.writeUInt16LE(c.method, 10);
    rec.writeUInt16LE(0, 12); // time
    rec.writeUInt16LE(0x21, 14); // date
    rec.writeUInt32LE(c.crc, 16);
    rec.writeUInt32LE(c.compSize, 20);
    rec.writeUInt32LE(c.uncompSize, 24);
    rec.writeUInt16LE(c.nameBuf.length, 28);
    rec.writeUInt16LE(0, 30);
    rec.writeUInt16LE(0, 32);
    rec.writeUInt16LE(0, 34);
    rec.writeUInt16LE(0, 36);
    rec.writeUInt32LE(0, 38); // external attr
    rec.writeUInt32LE(c.localOffset, 42);
    centralChunks.push(rec, c.nameBuf);
  }
  const centralSize = centralChunks.reduce((s, c) => s + c.length, 0);
  const centralEnd = centralStart + centralSize;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...centralChunks, eocd]);
}

function sheetXml(props) {
  const { headerRow, rows } = props;
  const all = [headerRow, ...rows];
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  xml += '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  xml += "<sheetData>";
  for (let r = 0; r < all.length; r++) {
    const rowData = all[r];
    xml += `<row r="${r + 1}">`;
    for (let c = 0; c < rowData.length; c++) {
      const v = rowData[c];
      const ref = cellRef(r, c);
      if (typeof v === "number") {
        xml += `<c r="${ref}"><v>${v}</v></c>`;
      } else {
        xml += `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(
          v === null || v === undefined ? "" : v
        )}</t></is></c>`;
      }
    }
    xml += "</row>";
  }
  xml += "</sheetData></worksheet>";
  return Buffer.from(xml, "utf8");
}

function buildXlsx(sheetTitle, headerRow, rows) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
        "utf8"
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        "utf8"
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEscape(sheetTitle)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
        "utf8"
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
        "utf8"
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: sheetXml({ headerRow, rows }),
    },
  ];
  return buildZip(files);
}

// Многолистовой XLSX: sheets = [{ title, header, rows }]
function buildXlsxMulti(sheets) {
  const files = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
${sheets
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("\n")}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`,
        "utf8"
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
        "utf8"
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
${sheets
  .map(
    (s, i) =>
      `<sheet name="${xmlEscape(s.title)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  )
  .join("\n")}
</sheets>
</workbook>`,
        "utf8"
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join("\n")}
</Relationships>`,
        "utf8"
      ),
    },
  ];
  sheets.forEach((s, i) => {
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml({ headerRow: s.header, rows: s.rows }),
    });
  });
  return buildZip(files);
}

function escapeExcel(value) {
  return value;
}

module.exports = { buildXlsx, buildXlsxMulti, colName, cellRef, xmlEscape };
