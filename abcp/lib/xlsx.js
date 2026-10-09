// Минимальный генератор .xlsx (OOXML) без внешних зависимостей.
// XML-части кладутся в ZIP-контейнер без сжатия (метод 0) — Excel и LibreOffice открывают.

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function colLetters(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    let c = '';
    let v = i;
    while (v > 0) { const r = (v - 1) % 26; c = String.fromCharCode(65 + r) + c; v = Math.floor((v - 1) / 26); }
    out.push(c);
  }
  return out;
}

function crc32(bytes) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function worksheetXml(cols, rows, title) {
  const n = Math.max(1, cols.length);
  const letters = colLetters(n);
  const moneyCols = cols.map((c, i) => (/Сумма/.test(String(c)) ? i : -1)).filter((i) => i >= 0);
  // Ширины колонок по самой длинной строке. Для денежных считаем ширину так,
  // как значение будет ОТОБРАЖЕНО в формате «#,##0.00 ₽» (разделители + десятичные + ₽),
  // иначе колонка показывает «#######».
  const widths = [];
  for (let ci = 0; ci < n; ci++) {
    const mon = moneyCols.includes(ci);
    let maxLen = String(cols[ci] == null ? '' : cols[ci]).length;
    for (const r of rows || []) {
      const v = r && r[ci];
      let len;
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (mon) {
          const ints = String(Math.round(Math.abs(v))).length;
          const seps = Math.floor(Math.max(0, ints - 1) / 3);
          len = ints + seps + 2 + 2; // целые + разделители + десятичные + « ₽»
        } else {
          len = String(v).length;
        }
      } else {
        len = String(v == null ? '' : v).length;
      }
      if (len > maxLen) maxLen = len;
    }
    widths.push(Math.min(70, Math.max(mon ? 18 : 10, maxLen + 2)));
  }
  const colXml = '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
  const parts = [`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colXml}<sheetData>`];
  let rn = 1;
  if (title) {
    parts.push(`<row r="1"><c r="A1" t="inlineStr" s="1"><is><t>${escXml(title)}</t></is></c></row>`);
    rn = 2;
  }
  const head = cols.map((c, i) => `<c r="${letters[i]}${rn}" t="inlineStr" s="1"><is><t>${escXml(c)}</t></is></c>`).join('');
  parts.push(`<row r="${rn}">${head}</row>`);
  rn++;
  rows.forEach((r, ri) => {
    const rowNum = rn + ri;
    const cells = cols.map((_, ci) => {
      const ref = letters[ci] + rowNum;
      const v = r[ci];
      if (typeof v === 'number' && Number.isFinite(v)) {
        const s = moneyCols.includes(ci) ? ' s="2"' : '';
        return `<c r="${ref}"${s}><v>${v}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${escXml(v == null ? '' : v)}</t></is></c>`;
    }).join('');
    parts.push(`<row r="${rowNum}">${cells}</row>`);
  });
  parts.push('</sheetData>');
  if (title && n > 1) parts.push(`<mergeCells count="1"><mergeCell ref="A1:${letters[n - 1]}1"/></mergeCells>`);
  parts.push('</worksheet>');
  return parts.join('');
}

function zipStore(parts) {
  const enc = new TextEncoder();
  const body = [];
  const cb = [];
  let offset = 0;
  for (const p of parts) {
    const nameB = enc.encode(p.name);
    const data = p.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    body.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    cb.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const central = cb.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, parts.length, true); eocd.setUint16(10, parts.length, true);
  eocd.setUint32(12, central, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
  const chunks = body.concat(cb).concat([new Uint8Array(eocd.buffer)]);
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
const WB_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00&quot; ₽&quot;"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF1F4E78"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>';

// cols: string[], rows: array of arrays, sheetName: string. Returns Buffer (.xlsx).
function buildXlsx(cols, rows, sheetName, title) {
  const enc = new TextEncoder();
  const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + escXml(sheetName || 'Лист1') + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const parts = [
    { name: '[Content_Types].xml', data: enc.encode(CT) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: 'xl/workbook.xml', data: enc.encode(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(WB_RELS) },
    { name: 'xl/styles.xml', data: enc.encode(STYLES) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(worksheetXml(cols || [], rows || [], title)) },
  ];
  return zipStore(parts);
}

module.exports = { buildXlsx };
