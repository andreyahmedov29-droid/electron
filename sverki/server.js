"use strict";

const http = require("http");
const { parse: parseUrl } = require("url");
const fs = require("fs");
const path = require("path");
const { parseWorkbook } = require("./lib/xlsx");
const { parseWorkbook: parseWorkbookXls } = require("./lib/xls");
const {
  sheetToRecords,
  autoDetectKey,
  reconcile,
  displayLabel,
} = require("./lib/reconcile");
const { analyze } = require("./lib/analysis");
const { buildXlsx } = require("./lib/export");
const { buildXlsxMulti } = require("./lib/export");
const { parseAct, analyze: analyzeActs } = require("./lib/actrecon");
const {
  analyzeWithLLM,
  chatWithLLM,
  isConfigured: llmConfigured,
  getBalance,
} = require("./lib/llm");

// Хранилище сессий чата по сверке (в памяти). Ключ — sessionId, значение —
// { blocks, meta, history }.
const chatSessions = new Map();
const CHAT_MAX_SESSIONS = 50; // лимит памяти
let chatSessionSeq = 1;

// Безопасная загрузка .env (только локально; без внешних пакетов).
// Ищем .env от каталога сервера вверх — так один и тот же код работает
// и из подпапки, и из корня сессии. Значения уже заданные в окружении
// не перезаписываем.
function loadEnv() {
  let dir = __dirname;
  for (;;) {
    const f = path.join(dir, ".env");
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, "utf8");
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1];
        if (key in process.env) continue; // окружение в приоритете
        let val = m[2].trim();
        // снимаем кавычки (одинарные/двойные)
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const MAX_UPLOAD = 50 * 1024 * 1024; // 50 МБ на файл

const STATIC_DIR = path.join(__dirname, "public");

// Выбирает парсер по магическим байтам: OLE2 (.xls) или OOXML (.xlsx)
function parseAnyWorkbook(buffer) {
  const ooxml = Buffer.from("504b", "hex"); // PK\x03\x04 (zip)
  if (buffer.length > 4 && buffer[0] === 0xd0 && buffer[1] === 0xcf) {
    return parseWorkbookXls(buffer);
  }
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return parseWorkbook(buffer);
  }
  // fallback: попробуем xlsx
  try {
    return parseWorkbook(buffer);
  } catch (e) {
    try {
      return parseWorkbookXls(buffer);
    } catch (e2) {
      throw new Error("Формат файла не распознан (не .xlsx и не .xls).");
    }
  }
}

function send(res, status, body, type = "application/json") {
  if (typeof body === "object" && type === "application/json") {
    body = JSON.stringify(body);
  }
  res.writeHead(status, {
    "Content-Type": type + "; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Файл слишком большой (лимит 50 МБ)."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Простой multipart/form-data парсер только для двух файловых полей
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const boundary = (m[1] || m[2]).trim();
  const delim = Buffer.from("--" + boundary);
  const parts = [];
  let start = buffer.indexOf(delim);
  while (start !== -1) {
    const lineEnd = buffer.indexOf("\r\n", start + delim.length);
    if (lineEnd === -1) break;
    const headersStart = lineEnd + 2;
    const headersEnd = buffer.indexOf("\r\n\r\n", headersStart);
    if (headersEnd === -1) break;
    const headerBlock = buffer.subarray(headersStart, headersEnd).toString("utf8");
    // конец этого парта — следующая граница
    const next = buffer.indexOf(delim, headersEnd + 4);
    const data = buffer.subarray(
      headersEnd + 4,
      next === -1 ? buffer.length : next
    );
    // убираем завершающий \r\n перед границей
    let body = data;
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    }
    parts.push({ headerBlock, body });
    if (next === -1) break;
    start = next;
  }

  const fields = {};
  const files = {};
  for (const p of parts) {
    const nameM = /name="([^"]*)"/.exec(p.headerBlock);
    const fnameM = /filename="([^"]*)"/.exec(p.headerBlock);
    if (!nameM) continue;
    const name = nameM[1];
    if (fnameM) {
      files[name] = { filename: fnameM[1], data: p.body };
    } else {
      fields[name] = p.body.toString("utf8").trim();
    }
  }
  return { fields, files };
}

function readSheetOfFile(buf) {
  const { sheets } = parseAnyWorkbook(buf);
  // берём первый непустой лист (или первый)
  const active = sheets.find((s) => s.rows.length > 0) || sheets[0];
  return { sheets, active };
}

function getHeaderOfSheet(active) {
  return active ? active.headers || [] : [];
}

function handleCompare(req, res) {
  readBody(req, MAX_UPLOAD * 2 + 1024 * 1024)
    .then((buf) => {
      const ct = req.headers["content-type"] || "";
      const parsed = parseMultipart(buf, ct);
      if (!parsed || !parsed.files.fileA || !parsed.files.fileB) {
        send(res, 400, { ok: false, error: "Загрузите оба файла." });
        return;
      }

      const fileA = parsed.files.fileA;
      const fileB = parsed.files.fileB;
      const fields = parsed.fields || {};
      const cpA = (fields.counterpartyA || "").trim();
      const cpB = (fields.counterpartyB || "").trim();

      // Валидация расширений
      const extA = path.extname(fileA.filename || "").toLowerCase();
      const extB = path.extname(fileB.filename || "").toLowerCase();
      if (extA !== ".xlsx" && extA !== ".xls") {
        send(res, 400, {
          ok: false,
          error: `Файл «${fileA.filename}» не является Excel (нужен .xlsx или .xls).`,
        });
        return;
      }
      if (extB !== ".xlsx" && extB !== ".xls") {
        send(res, 400, {
          ok: false,
          error: `Файл «${fileB.filename}» не является Excel (нужен .xlsx или .xls).`,
        });
        return;
      }

      // Разбор
      let dataA, dataB;
      try {
        dataA = readSheetOfFile(fileA.data);
        dataB = readSheetOfFile(fileB.data);
      } catch (e) {
        console.error("[xlsx] ошибка разбора:", e && e.message ? e.message : e);
        send(res, 400, {
          ok: false,
          error:
            "Не удалось прочитать Excel. Проверьте, что файл не повреждён и имеет формат .xlsx.",
        });
        return;
      }

      const rowsA = sheetToRecords(dataA.active.rows);
      const rowsB = sheetToRecords(dataB.active.rows);

      if (rowsA.error || rowsB.error) {
        send(res, 400, {
          ok: false,
          error: rowsA.error || rowsB.error,
        });
        return;
      }

      const key = autoDetectKey(
        rowsA.records,
        rowsB.records,
        rowsA.headers,
        rowsB.headers
      );

      const result = reconcile(rowsA.records, rowsB.records, key ? key.field : undefined);

      // Анализ
      const meta = {
        nameA: fileA.filename,
        nameB: fileB.filename,
        rowsA: rowsA.records.length,
        rowsB: rowsB.records.length,
        keyLabel: key ? key.label : "—",
        headersA: rowsA.headers,
        headersB: rowsB.headers,
      };
      const analysis = analyze(result, meta);

      send(res, 200, {
        ok: true,
        meta,
        key,
        result: {
          matched: result.matched,
          onlyA: result.onlyA.length,
          onlyB: result.onlyB.length,
          changed: result.changed.length,
        },
        analysis,
        items: buildItems(result, meta),
        headersA: rowsA.headers.map((h) => ({ title: h.title, col: h.col })),
        headersB: rowsB.headers.map((h) => ({ title: h.title, col: h.col })),
      });
    })
    .catch((err) => {
      // Обобщённое сообщение пользователю — технические детали только в лог
      console.error("[compare] ошибка:", err && err.message ? err.message : err);
      send(res, 400, {
        ok: false,
        error: "Не удалось обработать файлы. Проверьте, что это корректные Excel-файлы.",
      });
    });
}

// Детализированные строки для интерфейса и экспорта
function buildItems(result, meta) {
  const items = [];
  const add = (kind, key, rec) => {
    // объединяем значения полей из записи
    const row = { kind, key };
    row.values = {};
    for (const [f, v] of Object.entries(rec || {})) {
      if (f === "__row") {
        row.sourceRow = v;
        continue;
      }
      row.values[f] = v && v.value !== undefined ? v.value : v;
    }
    items.push(row);
  };
  for (const it of result.onlyA) add("onlyA", it.key, it.rec);
  for (const it of result.onlyB) add("onlyB", it.key, it.rec);
  for (const it of result.changed) {
    const row = { kind: "changed", key: it.key };
    row.valuesA = {};
    row.valuesB = {};
    row.diffs = it.diffs.map((d) => ({
      field: d.field,
      kind: d.kind,
      a: d.kind === "number" ? d.a : d.a,
      b: d.kind === "number" ? d.b : d.b,
      diff: d.diff,
    }));
    for (const [f, v] of Object.entries(it.recA || {})) {
      if (f === "__row") continue;
      row.valuesA[f] = v && v.value !== undefined ? v.value : v;
    }
    for (const [f, v] of Object.entries(it.recB || {})) {
      if (f === "__row") continue;
      row.valuesB[f] = v && v.value !== undefined ? v.value : v;
    }
    items.push(row);
  }
  return items;
}

// Обработчик сверки двух АКТОВ взаиморасчётов.
// Распознаёт структуру акта (сальдо, дебет/кредит, операции),
// сравнивает и возвращает бухгалтерский анализ.
function handleActCompare(req, res) {
  readBody(req, MAX_UPLOAD * 2 + 1024 * 1024)
    .then((buf) => {
      const ct = req.headers["content-type"] || "";
      const parsed = parseMultipart(buf, ct);
      if (!parsed || !parsed.files.fileA || !parsed.files.fileB) {
        send(res, 400, { ok: false, error: "Загрузите оба файла." });
        return;
      }
      const fileA = parsed.files.fileA;
      const fileB = parsed.files.fileB;
      const fields = parsed.fields || {};
      const cpA = (fields.counterpartyA || "").trim();
      const cpB = (fields.counterpartyB || "").trim();

      // Разбор каждого файла как акта
      let actA, actB;
      try {
        const wbA = parseAnyWorkbook(fileA.data);
        const wbB = parseAnyWorkbook(fileB.data);
        const sA = wbA.sheets.find((x) => x.rows.length) || wbA.sheets[0];
        const sB = wbB.sheets.find((x) => x.rows.length) || wbB.sheets[0];
        actA = parseAct(sA);
        actB = parseAct(sB);
      } catch (e) {
        console.error("[act] ошибка разбора:", e && e.message ? e.message : e);
        send(res, 400, {
          ok: false,
          error:
            "Не удалось прочитать один из файлов. Проверьте, что это корректные .xlsx или .xls акты сверки.",
        });
        return;
      }

      if (!actA.ok || !actB.ok) {
        send(res, 400, {
          ok: false,
          error: (actA.error || actB.error) || "Не удалось распознать акты сверки.",
        });
        return;
      }

      const meta = {
        // В качестве отображаемого имени берём контрагента, если он указан,
        // иначе — имя файла (фолбэк для совместимости)
        nameA: "ПрофМаркетСистем", // файл №1 всегда наш акт (компания фиксирована)
        nameB: cpB || fileB.filename,
        cpA: "ПрофМаркетСистем",
        cpB: cpB || null,
        opsA: actA.ops.length,
        opsB: actB.ops.length,
        saldoStartA: actA.saldoStart,
        saldoEndA: actA.saldoEnd,
        saldoStartB: actB.saldoStart,
        saldoEndB: actB.saldoEnd,
      };
      const analysis = analyzeActs(actA, actB, meta);

      send(res, 200, {
        ok: true,
        meta,
        analysis: {
          summary: analysis.summary,
        },
        blocks: analysis.blocks,
        result: {
          onlyA: analysis.result.onlyA.map((o) => ({
            key: o.key, sum: o.sum, side: o.side, doc: o.doc, date: o.date,
          })),
          onlyB: analysis.result.onlyB.map((o) => ({
            key: o.key, sum: o.sum, side: o.side, doc: o.doc, date: o.date,
          })),
          sumDiff: analysis.result.sumDiff,
          matched: analysis.result.matched,
        },
        saldo: analysis.saldoDiff,
      });
    })
    .catch((err) => {
      console.error("[act] ошибка:", err && err.message ? err.message : err);
      send(res, 400, {
        ok: false,
        error:
          "Не удалось обработать акты. Проверьте, что это корректные Excel-файлы.",
      });
    });
}

// Экспорт отчёта в .xlsx: принимает полный payload сравнения (JSON)
function handleExport(req, res) {
  readBody(req, 20 * 1024 * 1024)
    .then((buf) => {
      let payload;
      try {
        payload = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        send(res, 400, { ok: false, error: "Некорректные данные." });
        return;
      }
      const { meta, items, headersA, headersB } = payload || {};
      if (!Array.isArray(items) || !meta) {
        send(res, 400, { ok: false, error: "Нет данных для экспорта." });
        return;
      }

      // Строим заголовки и строки
      const headerRow = [
        "Тип",
        "Ключ",
        "Поле",
        "Значение (файл 1)",
        "Значение (файл 2)",
        "Объяснение",
      ];
      const rows = [];
      const kindLabel = {
        onlyA: "Только в файле 1",
        onlyB: "Только в файле 2",
        changed: "Различаются",
      };
      for (const it of items) {
        if (it.kind === "changed") {
          for (const d of it.diffs) {
            rows.push([
              kindLabel[it.kind],
              it.key,
              d.field,
              d.kind === "number" ? d.a : String(d.a ?? ""),
              d.kind === "number" ? d.b : String(d.b ?? ""),
              numberDesc(d, it),
            ]);
          }
        } else {
          const val = it.values ? Object.values(it.values).join("; ") : "";
          rows.push([
            kindLabel[it.kind],
            it.key,
            "",
            it.kind === "onlyA" ? val : "",
            it.kind === "onlyB" ? val : "",
            kindLabel[it.kind] + ` (ключ «${it.key}»).`,
          ]);
        }
      }

      const bufOut = buildXlsx("Расхождения", headerRow, rows);
      const fname = `sverka_rashozhdeniya_${Date.now()}.xlsx`;
      res.writeHead(200, {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(
          "расхождения.xlsx"
        )}`,
        "Content-Length": bufOut.length,
        "Cache-Control": "no-store",
      });
      res.end(bufOut);
    })
    .catch((err) => {
      console.error("[export] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось сформировать отчёт." });
    });
}

// Пакетная сверка: принимает эталон (master) + массив файлов контрагентов (docs).
// Возвращает сводную таблицу: по каждому контрагенту разница сальдо, кол-во
// непарных операций и вердикт «сходится/не сходится».
function handleBatchCompare(req, res) {
  readBody(req, 60 * 1024 * 1024)
    .then((buf) => {
      const parsed = parseMultipart(buf, req.headers["content-type"]);
      if (!parsed) {
        send(res, 400, { ok: false, error: "Некорректный multipart-запрос." });
        return;
      }
      const fields = parsed.fields || {};
      const masterFile = parsed.files.master;
      if (!masterFile || !masterFile.data) {
        send(res, 400, { ok: false, error: "Не передан эталонный акт (master)." });
        return;
      }
      // файлы контрагентов: могут приходить как docs (массив) или doc1..docN
      const docFiles = [];
      for (const [k, v] of Object.entries(parsed.files || {})) {
        if (/^doc/.test(k) && v.data && k !== "master") docFiles.push({ key: k, data: v.data, name: v.filename });
      }
      // имена контрагентов: fields.name (массив) или name1..nameN
      const names = [];
      for (const [k, v] of Object.entries(fields)) {
        if (/^name/.test(k)) names.push(String(v).trim());
      }
      if (!docFiles.length) {
        send(res, 400, { ok: false, error: "Не переданы документы контрагентов." });
        return;
      }

      // Разбираем эталон
      let masterAct;
      try {
        const wbM = parseAnyWorkbook(masterFile.data);
        const sM = wbM.sheets.find((x) => x.rows.length) || wbM.sheets[0];
        masterAct = parseAct(sM);
      } catch (e) {
        send(res, 400, { ok: false, error: "Не удалось прочитать эталонный акт." });
        return;
      }
      if (!masterAct || !masterAct.ok) {
        send(res, 400, { ok: false, error: (masterAct && masterAct.error) || "Эталон не распознан." });
        return;
      }

      const rows = [];
      docFiles.forEach((df, i) => {
        const name = (names[i] || df.name || "Контрагент " + (i + 1)).replace(/\.[^.]+$/, "");
        let docAct = null;
        let error = null;
        try {
          const wbD = parseAnyWorkbook(df.data);
          const sD = wbD.sheets.find((x) => x.rows.length) || wbD.sheets[0];
          docAct = parseAct(sD);
        } catch (e) {
          error = "не прочитан";
        }
        if (!docAct || !docAct.ok) {
          rows.push({
            name,
            error: (docAct && docAct.error) || "не распознан",
            saldoDiff: null,
            unmatched: null,
            status: "error",
          });
          return;
        }
        const resAn = analyzeActs(masterAct, docAct, { nameA: "Эталон", nameB: name });
        const bl = resAn.blocks || {};
        const status =
          bl.plain && bl.plain.status === "ok"
            ? "ok"
            : bl.onlyA.length || bl.onlyB.length
            ? "diff"
            : "ok";
        rows.push({
          name,
          error: null,
          saldoDiff: bl.saldoDiff != null ? bl.saldoDiff : 0,
          unmatched: (bl.onlyA.length || 0) + (bl.onlyB.length || 0),
          status,
        });
      });

      send(res, 200, { ok: true, master: masterFile.filename || "эталон", rows });
    })
    .catch((err) => {
      console.error("[batch] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось выполнить пакетную сверку." });
    });
}

// Экспорт итогового отчёта по ИИ-разбору в .xlsx (читаемый, не сырой дамп).
// Принимает blocks/meta/ai (JSON ответа DeepSeek) и отдаёт файл
// с Content-Disposition: attachment — скачивание без перехода на blob-страницу.
function handleAiExport(req, res) {
  readBody(req, 20 * 1024 * 1024)
    .then((buf) => {
      let payload;
      const raw = buf.toString("utf8");
      const ct = req.headers["content-type"] || "";
      if (/application\/json/i.test(ct)) {
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          send(res, 400, { ok: false, error: "Некорректные данные." });
          return;
        }
      } else if (/application\/x-www-form-urlencoded/i.test(ct)) {
        const m = /(?:^|&)payload=([^&]*)/.exec(raw);
        if (!m) {
          send(res, 400, { ok: false, error: "Нет данных для отчёта." });
          return;
        }
        try {
          // в form-urlencoded «+» означает пробел — заменяем перед декодом
          payload = JSON.parse(decodeURIComponent(m[1].replace(/\+/g, "%20")));
        } catch (e) {
          send(res, 400, { ok: false, error: "Некорректные данные." });
          return;
        }
      } else {
        send(res, 400, { ok: false, error: "Некорректный формат запроса." });
        return;
      }
      const { blocks, meta, ai } = payload || {};
      const nameA = (meta && meta.nameA) || "Файл №1";
      const nameB = (meta && meta.nameB) || "Файл №2";
      const aiParsed = (typeof ai === "string") ? safeJson(ai) : (ai || {});
      // Нормализация названия компании: модель могла написать иначе —
      // приводим к единому «ПрофМаркетСистем» везде в отчёте и письме.
      const normalizeCompany = (s) =>
        s == null ? s : String(s).replace(/ПрофмаркетСистем|ПрофМаркетСистем|Профмаркетсистем/gi, "ПрофМаркетСистем");
      for (const k of ["executiveSummary", "verdict", "mainReason", "analysis", "solution", "impact"]) {
        if (aiParsed[k] && typeof aiParsed[k] === "string") aiParsed[k] = normalizeCompany(aiParsed[k]);
      }
      for (const arrKey of ["steps", "warnings", "askCounterparty"]) {
        if (Array.isArray(aiParsed[arrKey])) aiParsed[arrKey] = aiParsed[arrKey].map(normalizeCompany);
      }
      if (Array.isArray(aiParsed.discrepancies)) {
        aiParsed.discrepancies = aiParsed.discrepancies.map((d) => ({
          ...d,
          doc: normalizeCompany(d.doc),
          reason: normalizeCompany(d.reason),
          action: normalizeCompany(d.action),
          side: normalizeCompany(d.side),
        }));
      }

      // Лист 1: Итог (сводка для руководителя)
      const sheet1 = {
        title: "Итог",
        header: ["Параметр", "Значение"],
        rows: [
          ["Вывод для директора", aiParsed.executiveSummary || "—"],
          ["Вердикт", aiParsed.verdict || "—"],
          ["Уровень риска", aiParsed.riskLevel || "—"],
          ["Главная причина", aiParsed.mainReason || "—"],
          ["Решение", aiParsed.solution || "—"],
          ["Контрагент 1", nameA],
          ["Контрагент 2", nameB],
        ],
      };
      // Обратить внимание (риски от ИИ)
      if (Array.isArray(aiParsed.warnings) && aiParsed.warnings.length) {
        aiParsed.warnings.forEach((w) => sheet1.rows.push(["Обратить внимание", w || "—"]));
      }

      // Лист 2: Расхождения и решения
      const disc = Array.isArray(aiParsed.discrepancies)
        ? aiParsed.discrepancies
        : (Array.isArray(blocks && blocks.onlyA) || Array.isArray(blocks && blocks.onlyB)
          ? [
              ...((blocks.onlyA || []).map((o) => ({
                doc: o.doc || o.key,
                side: nameA,
                amount: (o.sumAbs ?? o.sum) || "",
                reason: "Документ есть только в этом акте",
                action: "Проверить наличие у второй стороны / запросить первичку",
              }))),
              ...((blocks.onlyB || []).map((o) => ({
                doc: o.doc || o.key,
                side: nameB,
                amount: (o.sumAbs ?? o.sum) || "",
                reason: "Документ есть только в этом акте",
                action: "Проверить наличие у первой стороны / запросить первичку",
              }))),
            ]
          : []);
      const sheet2 = {
        title: "Расхождения",
        header: ["Документ", "Сторона", "Сумма", "Вероятная причина", "Что сделать"],
        rows: disc.map((d) => [
          d.doc || "—",
          d.side || "—",
          d.amount != null ? d.amount : "—",
          d.reason || "—",
          d.action || "—",
        ]),
      };

      // Лист 3: Шаги и вопросы контрагенту
      const sheet3 = {
        title: "Что делать",
        header: ["Тип", "Содержание"],
        rows: [
          ...(Array.isArray(aiParsed.steps)
            ? aiParsed.steps.map((s, i) => [`Шаг ${i + 1}`, s])
            : []),
          ...(Array.isArray(aiParsed.askCounterparty)
            ? aiParsed.askCounterparty.map((q, i) => [`Вопрос контрагенту ${i + 1}`, q])
            : []),
        ],
      };

      // Лист 4: Письмо контрагенту — готовый текст для вставки в почту
      const emailLines = [];
      emailLines.push("Добрый день!");
      emailLines.push("");
      emailLines.push(`При проведении сверки взаиморасчётов между «${nameA}» и «${nameB}» были выявлены расхождения. Просим вас проверить по нашей документации следующие операции:`);
      const onlyA = (blocks && blocks.onlyA) || [];
      const onlyB = (blocks && blocks.onlyB) || [];
      if (onlyA.length || onlyB.length) {
        emailLines.push("");
        // Группируем по сторонам
        if (onlyA.length) {
          emailLines.push(`В нашем акте (${nameA}) отражены операции, которых нет в вашем акте (${nameB}):`);
          onlyA.forEach((d) => {
            const s = Math.abs(d.sumAbs ?? d.sum ?? 0);
            emailLines.push(`- ${d.doc || d.key || "?"}${s ? " на " + s.toLocaleString("ru-RU") + " руб" : ""}`);
          });
          emailLines.push("");
        }
        if (onlyB.length) {
          emailLines.push(`В вашем акте (${nameB}) отражены операции, которых нет в нашем акте (${nameA}):`);
          onlyB.forEach((d) => {
            const s = Math.abs(d.sumAbs ?? d.sum ?? 0);
            emailLines.push(`- ${d.doc || d.key || "?"}${s ? " на " + s.toLocaleString("ru-RU") + " руб" : ""}`);
          });
          emailLines.push("");
        }
        emailLines.push("");
        emailLines.push("Будем признательны, если вы проверите и подтвердите отражение указанных документов в вашем учёте либо направите пояснения.");
      }
      if (Array.isArray(aiParsed.askCounterparty) && aiParsed.askCounterparty.length) {
        emailLines.push("");
        emailLines.push("Просим уточнить:");
        aiParsed.askCounterparty.forEach((q, i) => emailLines.push(`${i + 1}. ${String(q).replace(/[*_#]/g, "")}`));
      }
      emailLines.push("");
      emailLines.push("Будем признательны за прояснение ситуации по перечисленным операциям.");
      const sheet4 = {
        title: "Письмо контрагенту",
        header: ["Строка"],
        rows: emailLines.map((l) => [l]),
      };

      const bufOut = buildXlsxMulti([sheet1, sheet2, sheet3, sheet4]);
      res.writeHead(200, {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          `attachment; filename="ii-razbor-sverki.xlsx"; filename*=UTF-8''${encodeURIComponent(
            "ИИ-разбор сверки.xlsx"
          )}`,
        "Content-Length": bufOut.length,
        "Cache-Control": "no-store",
      });
      res.end(bufOut);
    })
    .catch((err) => {
      console.error("[ai-export] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось сформировать отчёт." });
    });
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

// Сверяет суммы, названные ИИ в discrepancies и итоговой разнице, с реальными
// данными из blocks. Галлюцинированные записи помечаем verification:"? ".
// Возвращает объект (нормализованный). Всё детерминированно, без дозапроса.
function verifyAiDigits(blocks, json) {
  const out = { ...json };
  const realOnly = [];
  (blocks.onlyA || []).forEach((o) => realOnly.push({ doc: o.doc || o.key, sumAbs: Math.abs(o.sumAbs ?? o.sum ?? 0) }));
  (blocks.onlyB || []).forEach((o) => realOnly.push({ doc: o.doc || o.key, sumAbs: Math.abs(o.sumAbs ?? o.sum ?? 0) }));

  if (Array.isArray(out.discrepancies)) {
    out.discrepancies = out.discrepancies.map((d) => {
      const dd = { ...d };
      const amt = parseNum(dd.amount);
      // ищем реальный документ по номеру (частичное совпадение)
      const docStr = String(dd.doc || "");
      const real = realOnly.find((r) => {
        const rd = String(r.doc || "").toLowerCase();
        const q = docStr.toLowerCase();
        // совпадение по числовой части номера
        const m = q.match(/([0-9]{4,})/);
        return m ? rd.includes(m[1]) : rd.includes(q.slice(0, 8));
      });
      if (real && amt !== null && Math.abs(amt - real.sumAbs) > 1) {
        dd.verified = "mismatch";
        dd.realAmount = real.sumAbs;
      } else if (amt === null) {
        dd.verified = "no-amount";
      } else {
        dd.verified = "ok";
      }
      return dd;
    });
  }
  return out;
}

// аккуратное извлечение числа из строки вида "97 044,00 руб" / "97044"
function parseNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const s = String(v).replace(/[^\d.,-]/g, "").replace(/\s/g, "");
  if (!s) return null;
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

// Осмысленные, конкретные вопросы контрагенту по РЕАЛЬНЫМ данным сверки
// (не сочинённые моделью «почему обороты отличаются»). Вопросы про наши и
// их документы без пары + начальное сальдо — на понятном языке.
function buildCounterpartyQuestions(blocks, nameA, nameB) {
  const q = [];
  const onlyA = (blocks && blocks.onlyA) || [];
  const onlyB = (blocks && blocks.onlyB) || [];
  const fmt = (n) => Number(n || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 });

  if (onlyA.length) {
    const sum = (blocks.onlyASum || 0);
    q.push(`В нашем акте (${nameA}) отражены документы, которых нет в вашем акте (${nameB}): перечислены ниже (${onlyA.length} шт. на ${fmt(sum)} руб.). Просим подтвердить, что вы их получили и отразили в своём учёте.`);
  }
  if (onlyB.length) {
    const sum = (blocks.onlyBSum || 0);
    q.push(`В вашем акте (${nameB}) есть документы, отсутствующие в нашем акте (${nameA}) (${onlyB.length} шт. на ${fmt(sum)} руб.). Просим уточнить, на каком основании они оформлены.`);
  }
  if (blocks.saldoStartDiff && Math.abs(blocks.saldoStartDiff) > 0.005) {
    q.push(`Начальное сальдо по данным ${nameA} на ${fmt(blocks.saldoStartDiff)} руб. отличается от нашего — просим уточнить, каким документом (актом за прошлый период) это сальдо подтверждается.`);
  }
  if (!q.length) {
    q.push("Просим подтвердить, что операции за отчётный период отражены в вашем учёте в полном объёме.");
  }
  return q;
}

// ИИ-разбор сверки через OpenAI-совместимый API (DeepSeek).
// Принимает уже посчитанные блоки (data.blocks) с клиента, собирает из них
// промпт и возвращает текст разбора. Ключ остаётся на сервере.
// Если ключ не задан — отвечаем ошибкой с понятным сообщением,
// сервер не падает, а фронт показывает справку (эвристики работают).
function handleAiAnalysis(req, res) {
  readBody(req, 1024 * 1024)
    .then(async (buf) => {
      let payload;
      try {
        payload = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        send(res, 400, { ok: false, error: "Некорректный запрос." });
        return;
      }
      const { blocks, meta } = payload || {};
      if (!blocks || typeof blocks !== "object") {
        send(res, 400, { ok: false, error: "Нет данных для анализа." });
        return;
      }
      if (!llmConfigured()) {
        send(res, 200, {
          ok: false,
          error:
            "ИИ не подключён: на сервере не задан ключ DEEPSEEK_API_KEY.",
          keyMissing: true,
        });
        return;
      }
      let r = await analyzeWithLLM(blocks, meta);
      if (!r.ok) {
        send(res, 200, { ok: false, error: r.error });
        return;
      }
      // Двойной проход ПО УМОЛЧАНИЮ: первый — найти расхождения,
      // второй — уточнить причину/решение (трикль actionPlan/impact).
      // Выключается env DEEPSEEK_TWO_PASS=0 (для экономии токенов).
      if (process.env.DEEPSEEK_TWO_PASS !== "0") {
        const firstJson = safeJson(r.text);
        if (firstJson && typeof firstJson === "object") {
          const refineMeta = {
            ...(meta || {}),
            twoPassRefine: true,
            priorAnalysis: r.text,
          };
          const refine = await analyzeWithLLM(blocks, refineMeta, { forceFresh: true });
          if (refine.ok && safeJson(refine.text)) {
            const fj = safeJson(refine.text);
            if (fj && (fj.mainReason || fj.solution || fj.discrepancies)) {
              r = { ...refine, tokensUsed: (r.tokensUsed || 0) + (refine.tokensUsed || 0) };
            }
          }
        }
      }
      // Фолбэк: если модель вернула невалидный JSON — делаем ОДНУ повторную
      // попытку (устойчивость к сбоям модели/формата).
      if (!safeJson(r.text)) {
        const retry = await analyzeWithLLM(blocks, meta, { forceFresh: true, temperature: 0.5 });
        if (retry.ok && safeJson(retry.text)) {
          r = retry;
        }
      }
      // Контроль цифр: сверяем названные ИИ суммы с реальными из blocks.
      // Галлюцинированные значения выбрасываем/помечаем — без повторного запроса.
      let verified = null;
      let verifiedJson = null;
      const parsed = safeJson(r.text);
      if (parsed && typeof parsed === "object") {
        verifiedJson = verifyAiDigits(blocks, parsed);
        verified = true;
        // Заменяем «вопросы контрагенту» из LLM на осмысленные, из реальных
        // данных (модель часто сочиняет абстрактные «почему обороты отличаются»).
        const cpNameA = (meta && meta.nameA) || "Сторона 1";
        const cpNameB = (meta && meta.nameB) || "Сторона 2";
        verifiedJson.askCounterparty = buildCounterpartyQuestions(blocks, cpNameA, cpNameB);
        r.text = typeof verifiedJson === "string"
          ? verifiedJson
          : JSON.stringify(verifiedJson);
      }
      send(res, 200, {
        ok: true,
        text: r.text,
        tokensUsed: r.tokensUsed,
        cached: !!r.cached,
        verified: !!verified,
      });
    })
    .catch((err) => {
      console.error("[ai-analysis] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось выполнить ИИ-разбор." });
    });
}

// Остаток баланса ИИ-провайдера (DeepSeek). Ключ в браузер не уходит —
// только суммы по валютам.
function handleAiBalance(req, res) {
  if (!llmConfigured()) {
    send(res, 200, {
      ok: false,
      error: "ИИ не подключён: на сервере не задан ключ.",
      keyMissing: true,
    });
    return;
  }
  getBalance()
    .then((r) => send(res, 200, { ok: r.ok, balance: r.balance, error: r.error }))
    .catch((err) => {
      console.error("[ai-balance] ошибка:", err && err.message ? err.message : err);
      send(res, 200, { ok: false, error: "Не удалось получить баланс." });
    });
}

// Начало чата по сверке: принимает blocks/meta, создаёт сессию с пустой
// историей и возвращает sessionId. Контекст сверки привязывается к сессии.
function handleChatStart(req, res) {
  readBody(req, 1024 * 1024)
    .then(async (buf) => {
      let payload;
      try {
        payload = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        send(res, 400, { ok: false, error: "Некорректный запрос." });
        return;
      }
      const { blocks, meta } = payload || {};
      if (!blocks || typeof blocks !== "object") {
        send(res, 400, { ok: false, error: "Нет данных для чата." });
        return;
      }
      if (!llmConfigured()) {
        send(res, 200, {
          ok: false,
          error: "ИИ не подключён: на сервере не задан ключ.",
          keyMissing: true,
        });
        return;
      }
      const sessionId = "chat" + chatSessionSeq++;
      chatSessions.set(sessionId, { blocks, meta, history: [], createdAt: Date.now() });
      if (chatSessions.size > CHAT_MAX_SESSIONS) {
        const first = chatSessions.keys().next().value;
        chatSessions.delete(first);
      }
      // периодическая очистка старых сессий (TTL 30 минут)
      const now = Date.now();
      for (const [k, v] of chatSessions) {
        if (now - v.createdAt > 30 * 60 * 1000) chatSessions.delete(k);
      }
      send(res, 200, { ok: true, sessionId });
    })
    .catch((err) => {
      console.error("[chat-start] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось начать чат." });
    });
}

// Отправка сообщения в чат по сверке. message — { sessionId, question }.
// Модель отвечает ТОЛЬКО в рамках данных сверки (ограничение в промпте).
function handleChatMessage(req, res) {
  readBody(req, 1024 * 1024)
    .then(async (buf) => {
      let payload;
      try {
        payload = JSON.parse(buf.toString("utf8"));
      } catch (e) {
        send(res, 400, { ok: false, error: "Некорректный запрос." });
        return;
      }
      const { sessionId, question } = payload || {};
      if (!sessionId || typeof question !== "string" || !question.trim()) {
        send(res, 400, { ok: false, error: "Нет сообщения или сессии." });
        return;
      }
      // Лимит длины вопроса (защита от перегруза токенов и абьюза)
      const trimmed = question.trim();
      if (trimmed.length > 2000) {
        send(res, 400, { ok: false, error: "Вопрос слишком длинный (максимум 2000 символов)." });
        return;
      }
      const sess = chatSessions.get(sessionId);
      if (!sess) {
        send(res, 404, { ok: false, error: "Сессия чата не найдена." });
        return;
      }
      // Сессия устарела (TTL 30 минут) — удаляем и просим начать заново
      if (Date.now() - sess.createdAt > 30 * 60 * 1000) {
        chatSessions.delete(sessionId);
        send(res, 404, { ok: false, error: "Сессия чата устарела. Начните разбор заново." });
        return;
      }
      const r = await chatWithLLM({
        blocks: sess.blocks,
        meta: sess.meta,
        history: sess.history,
        question: trimmed,
      });
      if (!r.ok) {
        send(res, 200, { ok: false, error: r.error });
        return;
      }
      // сохраняем обмен в историю сессии (ограничиваем длину)
      sess.history.push({ role: "user", content: trimmed });
      sess.history.push({ role: "assistant", content: r.text });
      if (sess.history.length > 40) {
        sess.history.splice(0, sess.history.length - 40);
      }
      send(res, 200, { ok: true, text: r.text, tokensUsed: r.tokensUsed });
    })
    .catch((err) => {
      console.error("[chat] ошибка:", err && err.message ? err.message : err);
      send(res, 400, { ok: false, error: "Не удалось выполнить запрос." });
    });
}

function numberDesc(d, it) {
  const diff = d.diff;
  if (d.kind !== "number" || diff === null || diff === undefined) return "";
  const dir = diff > 0 ? "больше в файле 1" : "меньше в файле 1";
  return `Разница: ${Math.abs(diff)} (${dir}).`;
}

function handleServe(res, filePath) {
  const abs = path.join(STATIC_DIR, filePath);
  // защита от path traversal
  const resolved = path.resolve(abs);
  if (!resolved.startsWith(path.resolve(STATIC_DIR))) {
    send(res, 403, { ok: false, error: "Forbidden" });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      send(res, 404, { ok: false, error: "Not found" });
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const types = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".woff2": "font/woff2",
    };
    // index.html и другие HTML — НИКОГДА не кэшируем: после деплоя браузер
    // обязан взять свежую разметку (со свежими ссылками app.js?v=…).
    // Статика (css/js с версией в ?v=) кэшируется долго — версия и так меняется.
    const isHtml = ext === ".html";
    res.writeHead(200, {
      "Content-Type": (types[ext] || "application/octet-stream") + "; charset=utf-8",
      "Content-Length": data.length,
      "Cache-Control": isHtml ? "no-store, no-cache, must-revalidate, max-age=0" : "public, max-age=31536000, immutable",
    });
    res.end(data);
  });
}

// Смонтированный в BIOTIME модуль: request-функция вместо самостоятельного
// http-сервера. Порт/запуск даёт BIOTIME; префикс /sverki срезается, чтобы
// внутренние /api/* и статика матчились как у отдельного приложения.
function handleRequest(req, res) {
  const url = parseUrl(req.url || "/");
  const p = (url.pathname || "/").replace(/^\/sverki/, "") || "/";

  if (req.method === "POST" && p === "/api/compare") {
    handleCompare(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/actcompare") {
    handleActCompare(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/batch-compare") {
    handleBatchCompare(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/export") {
    handleExport(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/ai-export") {
    handleAiExport(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/ai-analysis") {
    handleAiAnalysis(req, res);
    return;
  }

  if (req.method === "GET" && p === "/api/ai-balance") {
    handleAiBalance(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/ai-chat/start") {
    handleChatStart(req, res);
    return;
  }

  if (req.method === "POST" && p === "/api/ai-chat") {
    handleChatMessage(req, res);
    return;
  }

  if (req.method === "GET" && p === "/api/health") {
    send(res, 200, { ok: true });
    return;
  }

  // статика
  if (req.method === "GET") {
    let file = p === "/" ? "index.html" : p.slice(1);
    if (!file) file = "index.html";
    handleServe(res, file);
    return;
  }

  send(res, 405, { ok: false, error: "Method Not Allowed" });
}

module.exports = handleRequest;
