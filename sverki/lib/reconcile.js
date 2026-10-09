// Движок сверки: превращает сырые строки листа в записи,
// автоопределяет ключевое поле, сопоставляет строки двух файлов
// и собирает расхождения.
"use strict";

// Убираем служебные "мусорные" колонки (часто пустые или служебные)
const SKIP_HEADERS = /^(№|номер строки|стр\.|id|#)$/i;

// Слово-найдёныш для распознавания ключевой колонки
const KEY_HINTS = [
  /док/i,
  /номер/i,
  /№/,
  /счет/i,
  /счёт/i,
  /операц/i,
  /наименован/i,
  /назван/i,
  /описание/i,
  /позиц/i,
];

const MONEY_HINTS = /(сумм|стоимост|цена|итого|оплат|сальдо|дебет|кредит|приход|расход)/i;

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[»«"]/g, "")
    .replace(/\s*(\(.*?\)|\[.*?\])\s*/g, " ")
    .trim();
}

// Представление заголовка для поиска
function collapse(h) {
  return normalizeHeader(h).replace(/[^a-zа-я0-9]+/gi, "").toLowerCase();
}

function headerHintsScore(h) {
  const n = collapse(h);
  if (!n) return 0;
  let score = 0;
  for (const hint of KEY_HINTS) {
    if (hint.test(h)) score += 4;
  }
  return score;
}

// Превращаем лист (rows) в массив записей: определяем строку заголовков.
function sheetToRecords(rows) {
  // Ищем первую строку, в которой много текстовых ячеек — это заголовки.
  let headerRowIdx = null;
  let headerCells = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    const cells = rows[r].cells;
    const textCells = cells.filter((c) => c && String(c.value).trim() !== "");
    // Заголовок — это, как правило, строка почти без чисел-значений
    const numericCount = textCells.filter((c) => c.type === "n").length;
    const meaningful = textCells.length;
    if (meaningful >= 2 && numericCount <= Math.ceil(meaningful / 2)) {
      headerRowIdx = r;
      headerCells = cells;
      break;
    }
  }

  if (headerRowIdx === null || !headerCells) {
    return { headers: [], records: [], error: "Не удалось определить строку с заголовками." };
  }

  // Заголовки с номерами колонок
  const headers = headerCells
    .map((c, i) => {
      const raw = c ? c.value : "";
      return {
        col: c ? c.col : i,
        idx: i,
        title: String(raw).trim(),
        norm: normalizeHeader(raw),
      };
    })
    .filter((h) => h.title !== "" && !SKIP_HEADERS.test(h.title));

  const headerByCol = new Map(headers.map((h) => [h.col, h]));

  const records = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const cells = rows[r].cells;
    const rec = {};
    let isEmpty = true;
    for (const h of headers) {
      const cell = cells[h.col];
      if (cell) {
        rec[h.norm || h.title] = {
          value: cell.value,
          num: cell.num,
          type: cell.type,
        };
        if (String(cell.value).trim() !== "") isEmpty = false;
      }
    }
    if (!isEmpty) {
      rec.__row = r + 1; // номер строки реальный (для отчёта)
      records.push(rec);
    }
  }
  return { headers, records };
}

// Автоопределение ключа по двум наборам записей.
// Возвращает { field, label, confidence } или null.
function autoDetectKey(recsA, recsB, headersA, headersB) {
  // все поля через норм-ключи
  function fieldNames(recs) {
    const set = new Set();
    for (const rec of recs) {
      for (const k of Object.keys(rec)) {
        if (k === "__row") continue;
        set.add(k);
      }
    }
    return [...set];
  }

  const fieldsA = fieldNames(recsA);
  const fieldsB = fieldNames(recsB);
  const common = fieldsA.filter((f) => fieldsB.includes(f));

  // Скop: насколько поле подходит как ключ
  function fieldScore(field, recs) {
    let score = 0;
    const headerInfo = [...headersA, ...headersB].find(
      (h) => h.norm === field
    );
    if (headerInfo) {
      score += headerHintsScore(headerInfo.title) * 5;
    } else {
      score += headerHintsScore(field) * 2;
    }
    // уникальность значений
    const values = new Set();
    let blanks = 0;
    for (const rec of recs) {
      const v = rec[field];
      const val = v ? String(v.value).trim() : "";
      if (val === "") blanks++;
      else values.add(val);
    }
    const nonblank = recs.length - blanks;
    const uniqRatio = nonblank === 0 ? 0 : values.size / nonblank;
    score += uniqRatio * 10;
    // числа-суммы — плохой ключ
    if (headerInfo && MONEY_HINTS.test(headerInfo.title)) score -= 8;
    return score;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const f of common) {
    const s = fieldScore(f, recsA) + fieldScore(f, recsB);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }

  if (!best) {
    // не общий — вернём самое "ключевое" из A
    let bBest = null;
    let bs = -Infinity;
    for (const f of fieldsA) {
      const s = fieldScore(f, recsA);
      if (s > bs) {
        bs = s;
        bBest = f;
      }
    }
    return bBest
      ? { field: bBest, label: displayLabel(bBest, headersA), confidence: 0.4 }
      : null;
  }

  const label = displayLabel(best, headersA) || displayLabel(best, headersB);
  const confidence = Math.min(1, bestScore / 40);
  return { field: best, label, confidence };
}

function displayLabel(field, headers) {
  const h = headers.find((x) => x.norm === field);
  return h ? h.title : field;
}

function valToString(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && v !== null) {
    return String(v.value !== undefined ? v.value : v);
  }
  return String(v);
}

function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (typeof v.num === "number") return v.num;
    const n = parseFloat(String(v.value).replace(/[^\d.,-]/g, (m) => (m === "-" ? m : "")));
    return Number.isFinite(n) ? n : null;
  }
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Сравнение: считаем поле "расхождением", если:
//  - числовое: разница по модулю > eps
//  - строковое: не совпадает после нормализации
function compareValue(a, b, eps = 1e-6) {
  const an = toNum(a);
  const bn = toNum(b);
  if (an !== null && bn !== null) {
    const diff = an - bn;
    return Math.abs(diff) > eps ? { kind: "number", a: an, b: bn, diff } : null;
  }
  const as = valToString(a).trim();
  const bs = valToString(b).trim();
  if (as !== bs) return { kind: "string", a: as, b: bs, diff: null };
  return null;
}

// Основная сверка
function reconcile(rowsA, rowsB, keyField) {
  const indexA = new Map();
  for (const rec of rowsA) {
    const k = String(keyField ? rec[keyField]?.value ?? "" : "").trim();
    if (k === "") continue;
    if (!indexA.has(k)) indexA.set(k, []);
    indexA.get(k).push(rec);
  }
  const indexB = new Map();
  for (const rec of rowsB) {
    const k = String(keyField ? rec[keyField]?.value ?? "" : "").trim();
    if (k === "") continue;
    if (!indexB.has(k)) indexB.set(k, []);
    indexB.get(k).push(rec);
  }

  const result = {
    onlyA: [], // есть только в первом файле
    onlyB: [], // есть только во втором
    changed: [], // суммы/поля различаются
    matched: 0,
  };

  const seen = new Set();
  for (const [key, listA] of indexA) {
    const listB = indexB.get(key);
    if (!listB) {
      for (const rec of listA) result.onlyA.push({ key, rec });
      continue;
    }
    // сопоставляем попарно
    for (let i = 0; i < Math.max(listA.length, listB.length); i++) {
      seen.add(key);
      const a = listA[i];
      const b = listB[i];
      if (a && b) {
        result.matched++;
        // сравнить все общие поля
        const fields = new Set([
          ...Object.keys(a).filter((f) => f !== "__row"),
          ...Object.keys(b).filter((f) => f !== "__row"),
        ]);
        const diffs = [];
        for (const f of fields) {
          if (f === keyField) continue;
          if (f === "__row") continue;
          const av = a[f];
          const bv = b[f];
          if (av === undefined || bv === undefined) continue;
          const c = compareValue(av, bv);
          if (c) diffs.push({ field: f, ...c });
        }
        if (diffs.length > 0) {
          result.changed.push({ key, recA: a, recB: b, diffs });
        }
      } else if (a) {
        result.onlyA.push({ key, rec: a });
      } else if (b) {
        result.onlyB.push({ key, rec: b });
      }
    }
  }

  // строки только во втором
  for (const [key, listB] of indexB) {
    if (seen.has(key)) continue;
    for (const rec of listB) result.onlyB.push({ key, rec });
  }

  return result;
}

module.exports = {
  sheetToRecords,
  autoDetectKey,
  reconcile,
  displayLabel,
  toNum,
};
