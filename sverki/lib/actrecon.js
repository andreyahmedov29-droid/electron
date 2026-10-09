// Акт-анализатор сверки взаиморасчётов.
//
// Понимает структуру акта сверки: шапку, таблицу операций с колонками
// Дебет/Кредит (и часто "Сумма документа"), строки "Сальдо начальное",
// "Обороты за период", "Сальдо конечное". Извлекает операции и выводит
// бухгалтерский анализ по двум актам.
//
// Операции идентифицируются по номеру документа (УПД/Платежное поручение/
// Приобретение/УТ-...). Сравнение: какие операции есть в одном акте и нет
// в другом, разница по суммам совпадающих документов, и сверка конечного
// сальдо (разница и в чью пользу).
"use strict";

function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    if (typeof v.num === "number") return v.num;
    v = v.value;
  }
  if (typeof v === "number") return v;
  const s = String(v).replace(/\s+/g, "").replace(/,/g, ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function normNumStr(s) {
  return String(s || "").replace(/\s+/g, "").replace(/\u00a0/g, "").trim();
}

// Извлечь номер документа из строки вида
// "УПД №124707 от 03.08.2026 (Счет-фактура №124707 ...)" / "Платежное поручение №БП-4771 ..."
function docKey(text) {
  if (!text) return "";
  const t = String(text);
  // 1) Классический вид "... № БП-4771 ..." / "№ 124707" / "№УТ-4135"
  let m = /№\s*([^\s()№,;]+)/u.exec(t);
  let raw = m ? m[1] : null;
  if (!raw) {
    // 2) Вид "(РТ00006518 от 01.07.2026)" / "(РТР0039132 от ...)" — номер в скобках,
    //    где токен начинается с кода и содержит цифры.
    const m2 = /\(\s*([A-Za-zА-Яа-я]*\d[\d-]*)/u.exec(t);
    raw = m2 ? m2[1] : null;
  }
  if (!raw) {
    // 3) Общее: первый токен с цифрами и буквами, похожий на код документа
    const m3 = /([A-Za-zА-Яа-я]{0,4}\d[\w-]*)/u.exec(t);
    raw = m3 ? m3[1] : null;
  }
  if (!raw) return "";
  let key = raw.toLowerCase().replace(/\s+/g, "");
  // нормализуем: БП-4771 -> 4771, УТ-4135 -> ут4135, 124707 -> 124707
  key = key.replace(/^бп-?/, "").replace(/^ут-?/, "ут");
  return key;
}

// Нормализация даты "01.07.2026", "01.07.26", "1.7.2026" -> "01.07.2026"
function normDate(s) {
  const t = String(s || "").trim().replace(/\//g, ".");
  const m = /^(\d{1,2})[.](\d{1,2})[.](\d{2,4})$/.exec(t);
  if (!m) return t.toLowerCase();
  let yy = m[3];
  if (yy.length === 2) yy = "20" + yy;
  const dd = ("0" + m[1]).slice(-2);
  const mm = ("0" + m[2]).slice(-2);
  return dd + "." + mm + "." + yy;
}

const LABELS = {
};

function rowLabel(row) {
  for (const c of row.cells || []) {
    if (!c) continue;
    const s = String(c.value || "").trim().toLowerCase();
    if (!s) continue;
    if (/сальдо начальн/.test(s)) return "сальдо начальное";
    if (/сальдо конечн/.test(s)) return "сальдо конечное";
    if (/оборот/.test(s)) return "обороты за период";
    if (/^итого\b/.test(s)) return "итого";
    // "задолженность по состоянию на 01.08" ~ сальдо начальное;
    // "задолженность по состоянию на 31.08" ~ сальдо конечное
    if (/задолженность по состоянию/.test(s)) {
      if (/01|начальн/.test(s)) return "сальдо начальное";
      if (/31|конечн/.test(s)) return "сальдо конечное";
    }
    if (/задолженность на 01|на 01\.\d/.test(s)) return "сальдо начальное";
    if (/задолженность на 31|на 31\.\d/.test(s)) return "сальдо конечное";
  }
  return null;
}

// Определяем колонки: Дебет и Кредит.
// Способ: ищем строку в секции операций, где в ячейках есть тексты
// "Дебет" и "Кредит" (заголовки). Это надёжнее, чем по позициям.
function findDebitCredit(rows) {
  let startIdx = -1; // строка заголовков с колонками
  let debitCol = -1;
  let creditCol = -1;
  let dateCol = -1;
  let docCol = -1;

  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r].cells || [];
    let hasDebit = -1;
    let hasCredit = -1;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      const v = String(c.value || "").trim().toLowerCase();
      // берём ПЕРВУЮ (левая пара Дебет/Кредит) — данные левой стороны акта
      if (v === "дебет" && hasDebit === -1) hasDebit = i;
      else if (v === "кредит" && hasCredit === -1) hasCredit = i;
    }
    if (hasDebit !== -1 && hasCredit !== -1) {
      startIdx = r;
      debitCol = hasDebit;
      creditCol = hasCredit;
      break;
    }
  }

  // колонка даты и документа — обычно слева от дебета/кредита
  // эвристика: ищем в соседних строках
  // Попробуем определить по самому акту: дата — крайняя левая, документ — вторая.
  // Уточним позже по строкам данных.
  return { startIdx, debitCol, creditCol };
}

// Главная функция: распарсить акт (лист) в структуру
function parseAct(sheet) {
  const rows = (sheet && sheet.rows) || [];
  const { startIdx, debitCol, creditCol } = findDebitCredit(rows);
  if (startIdx === -1) {
    return { ok: false, error: "Не найдены колонки Дебет/Кредит в акте." };
  }

  const header = rows[startIdx].cells || [];
  // Определяем колонки даты и документа: ищем в заголовочной строке тексты "Дата" и "Документ"
  // Они могут быть на пару строк ВЫШЕ строки с Дебет/Кредит (в актах "Дата | Документ" —
  // отдельная строка). Ищем до 5 строк выше.
  let dateCol = -1;
  let docCol = -1;
  for (let rr = startIdx; rr >= Math.max(0, startIdx - 5); rr--) {
    const hdr = (rows[rr] && rows[rr].cells) || [];
    for (let i = 0; i < hdr.length; i++) {
      const c = hdr[i];
      if (!c) continue;
      const v = String(c.value || "").trim().toLowerCase();
      if (v === "дата" && dateCol === -1) dateCol = i;
      else if (v === "документ" && docCol === -1) docCol = i;
    }
    if (dateCol !== -1 && docCol !== -1) break;
  }
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (!c) continue;
    const v = String(c.value || "").trim().toLowerCase();
    if (v === "дата" && dateCol === -1) dateCol = i;
    else if (v === "документ" && docCol === -1) docCol = i;
  }

  const ops = [];
  let saldoStart = null;
  let saldoEnd = null;
  let oborotyDebit = null;
  let oborotyCredit = null;
  let seenOboroty = false;

  const valueAt = (row, col) => {
    const cells = row.cells || [];
    return cells[col];
  };

  for (let r = startIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const label = rowLabel(row);
    if (label) {
      const deb = num(valueAt(row, debitCol));
      const cred = num(valueAt(row, creditCol));
      if (label === "сальдо начальное" && (deb !== null || cred !== null)) {
        saldoStart = deb !== null ? deb : cred;
      } else if (label === "сальдо конечное" && (deb !== null || cred !== null)) {
        saldoEnd = deb !== null ? deb : cred;
      } else if (label === "обороты за период") {
        oborotyDebit = deb;
        oborotyCredit = cred;
      }
      continue;
    }

    const deb = num(valueAt(row, debitCol));
    const cred = num(valueAt(row, creditCol));
    if (deb === null && cred === null) continue; // пустая/служебная

    const docCell =
      docCol !== -1 ? valueAt(row, docCol) : null;
    const docText = (docCell && docCell.value) || "";
    const dateCell = dateCol !== -1 ? valueAt(row, dateCol) : null;
    const date = (dateCell && String(dateCell.value || "").trim()) || "";

    // Строка с ОБОИМИ дебетом и кредитом — это итоги «обороты за период»
    // (операции всегда попадают в одну из сторон).
    if (deb !== null && cred !== null) {
      oborotyDebit = deb;
      oborotyCredit = cred;
      seenOboroty = true;
      continue;
    }

    // Строка с числом, но без даты и без документа:
    //  - до строки "обороты" — это операция, у которой в исходном файле выпали
    //    реквизиты (случается в .xls), сохраняем её с пустым номером;
    //  - после "обороты" — это итоговое сальдо конечное.
    if (!date && !docText) {
      const v = deb !== null ? deb : cred;
      if (seenOboroty && saldoEnd === null) {
        saldoEnd = v;
        continue;
      }
      if (!seenOboroty) {
        ops.push({ key: "", sum: v, side: deb !== null ? "д" : "к", date: "", doc: "(без реквизитов)" });
        continue;
      }
    }

    const key = docKey(docText);
    const sum = deb !== null ? deb : cred;
    const side = deb !== null ? "д" : "к";
    // Операция: есть дата/сумма/документ. Номер может быть оборван (в .xls),
    // но операцию сохраняем — по ней всё равно идёт сверка по дате и сумме.
    ops.push({ key, sum, side, date, doc: docText });
  }

  // Автодорасчёт, если итоговые строки не распознаны (бывает в .xls):
  // обороты считаем из операций, конечное сальдо — по формуле
  // сальдоКон = сальдоНач + дебетОборот − кредитОборот.
  if (oborotyDebit === null || oborotyCredit === null) {
    let d = 0, c = 0;
    for (const o of ops) {
      if (o.side === "д") d += o.sum;
      else c += o.sum;
    }
    if (Math.abs(d) > 0) oborotyDebit = d;
    if (Math.abs(c) > 0) oborotyCredit = c;
  }
  if (saldoEnd === null && saldoStart !== null && oborotyDebit !== null && oborotyCredit !== null) {
    saldoEnd = saldoStart + oborotyDebit - oborotyCredit;
  }

  return {
    ok: true,
    ops,
    saldoStart,
    saldoEnd,
    oborotyDebit,
    oborotyCredit,
  };
}

// Сверка двух актов.
// В актах разных сторон один и тот же документ часто имеет разные номера
// (разные системы нумерации: у продавца РТ000…, у покупателя РТР003…).
// Поэтому операции сопоставляются по ДАТЕ и СУММЕ (по модулю — знак у сторон
// зеркальный), а номер служит для отображения. Это убирает ложные расхождения
// из-за разных номеров.
function reconcileActs(actA, actB) {
  const result = { onlyA: [], onlyB: [], sumDiff: [], matched: 0 };
  const ep = 0.005;

  // Сопоставление двух списков с двумя проходами:
  //   pass 1 — по (дата, |сумма|);
  //   pass 2 — остатки по |сумма| (даты у сторон могут различаться на день).
  // Каждая запись используется один раз.
  function matchSets(listA, listB, needDate) {
    const usedB = new Array(listB.length).fill(false);
    const matched = [];
    const onlyA = [];
    for (let i = 0; i < listA.length; i++) {
      const a = listA[i];
      let found = -1;
      let foundB = null;
      for (let j = 0; j < listB.length; j++) {
        if (usedB[j]) continue;
        const b = listB[j];
        const sameDate = needDate
          ? !a.date || !b.date || normDate(a.date) === normDate(b.date)
          : true;
        const sameSum = Math.abs(Math.abs(a.sum) - Math.abs(b.sum)) <= ep;
        if (sameDate && sameSum) {
          found = j;
          foundB = b;
          break;
        }
      }
      if (found !== -1) {
        usedB[found] = true;
        matched.push({ a, b: foundB });
      } else {
        onlyA.push(a);
      }
    }
    const onlyB = [];
    for (let j = 0; j < listB.length; j++) {
      if (!usedB[j]) onlyB.push(listB[j]);
    }
    return { matched, onlyA, onlyB };
  }

  const pass1 = matchSets(actA.ops, actB.ops, true);
  // второй проход: остатки по сумме
  const pass2 = matchSets(pass1.onlyA, pass1.onlyB, false);

  result.matched = pass1.matched.length + pass2.matched.length;
  result.onlyA = pass2.onlyA;
  result.onlyB = pass2.onlyB;
  const allMatched = pass1.matched.concat(pass2.matched);
  // Согласованная сумма: сумма модулей совпавших пар (сторона A)
  result.matchedSum = allMatched.reduce(
    (x, mi) => x + Math.abs(mi.a.sum),
    0
  );
  for (const mi of allMatched) {
    // знаки у сторон зеркальны, поэтому сравниваем по модулю
    const absDiff = Math.abs(Math.abs(mi.a.sum) - Math.abs(mi.b.sum));
    if (absDiff > ep) {
      result.sumDiff.push({
        key: mi.a.key + "/" + mi.b.key,
        a: mi.a,
        b: mi.b,
        diff: absDiff,
      });
    }
  }
  return result;
}

function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Собираем текст бухгалтерского анализа
function analyze(actA, actB, meta) {
  const r = reconcileActs(actA, actB);
  const lines = [];
  const nameA = (meta && meta.nameA) || "Файл 1";
  const nameB = (meta && meta.nameB) || "Файл 2";

  const sA = actA.saldoEnd;
  const sB = actB.saldoEnd;

  // Структурированные блоки для подробного вывода
  const blocks = {
    opsA: actA.ops.length,
    opsB: actB.ops.length,
    onlyA: r.onlyA.map((o) => ({
      key: o.key,
      doc: o.doc,
      date: o.date,
      sum: o.sum,
      side: o.side,
      sumAbs: Math.abs(o.sum),
    })),
    onlyB: r.onlyB.map((o) => ({
      key: o.key,
      doc: o.doc,
      date: o.date,
      sum: o.sum,
      side: o.side,
      sumAbs: Math.abs(o.sum),
    })),
    onlyASum: r.onlyA.reduce((x, o) => x + Math.abs(o.sum), 0),
    onlyBSum: r.onlyB.reduce((x, o) => x + Math.abs(o.sum), 0),
    sumDiff: r.sumDiff.map((d) => ({
      key: d.key,
      aSum: Math.abs(d.a.sum),
      bSum: Math.abs(d.b.sum),
      diff: d.diff,
      docA: d.a.doc,
      docB: d.b.doc,
    })),
    matched: r.matched,
    matchedSum: r.matchedSum || 0,
    // Обороты сторон по дебету/кредиту (для «кто кому должен» и масштаба)
    opsDebitA: actA.ops.reduce((x, o) => x + (o.side === "д" ? Math.abs(o.sum) : 0), 0) || 0,
    opsCreditA: actA.ops.reduce((x, o) => x + (o.side === "к" ? Math.abs(o.sum) : 0), 0) || 0,
    opsDebitB: actB.ops.reduce((x, o) => x + (o.side === "д" ? Math.abs(o.sum) : 0), 0) || 0,
    opsCreditB: actB.ops.reduce((x, o) => x + (o.side === "к" ? Math.abs(o.sum) : 0), 0) || 0,
    saldoA: sA,
    saldoB: sB,
    saldoStartA: actA.saldoStart,
    saldoStartB: actB.saldoStart,
    saldoStartDiff: null,
    saldoDiff: null,
  };
  const ssA = actA.saldoStart;
  const ssB = actB.saldoStart;
  if (ssA !== null && ssB !== null) {
    blocks.saldoStartDiff = Math.abs(ssB - ssA);
    blocks.saldoStartFavor = ssB > ssA ? nameA : ssA > ssB ? nameB : null;
  }
  if (sA !== null && sB !== null) {
    blocks.saldoDiff = Math.abs(sB - sA);
    blocks.saldoDiffAbs = Math.abs(sB - sA);
    blocks.favorName = sB > sA ? nameB : sA > sB ? nameA : null;
    blocks.favorSide = sB > sA ? "B" : sA > sB ? "A" : null;
  }

  // ── Разложение разницы конечного сальдо на составляющие ────────────────
  // Ключевая эвристика для бухгалтера: разница конечных сальдо (B − A)
  // распадается на разницу начальных сальдо (переносится из прошлого
  // периода) и разницу оборотов за период. Это сразу показывает, какая
  // часть расхождения «пришла из прошлого», а какая образовалась
  // операциями текущего периода.
  const diffEnd = sA !== null && sB !== null ? sB - sA : null;       // со знаком
  const diffStart = ssA !== null && ssB !== null ? ssB - ssA : null; // со знаком
  const netOps = diffEnd !== null && diffStart !== null ? diffEnd - diffStart : null;
  blocks.saldoDiffSigned = diffEnd;
  blocks.saldoStartDiffSigned = diffStart;
  blocks.netOpsDiff = netOps;
  if (diffEnd !== null && Math.abs(diffEnd) > 0.005) {
    const base = Math.abs(diffEnd);
    const startPart = Math.abs(diffStart || 0);
    blocks.shareStartPct = Math.round((startPart / base) * 100);
    blocks.shareOpsPct = 100 - blocks.shareStartPct;
  }

  // Сальдированный вклад непарных операций каждой стороны (сальдо считается
  // как «начальное + дебет − кредит», поэтому дебет даёт +, кредит −).
  const sideSigned = (side, sum) => (side === "д" ? 1 : -1) * Math.abs(sum);
  let inA = 0;
  let inB = 0;
  for (const o of r.onlyA) inA += sideSigned(o.side, o.sum);
  for (const o of r.onlyB) inB += sideSigned(o.side, o.sum);
  blocks.unmatchedNetSigned = inB - inA;
  if (netOps !== null) {
    // Диагностика: разница оборотов должна объясняться непарными операциями.
    // Если сходится — «математика сверки бьётся» до копеек.
    blocks.unmatchedMatchesOps = Math.abs(netOps - (inB - inA)) <= 0.06;
  }

  // ── Человеческие формулировки для менеджера (без бухгалтерских терминов) ──
  const diffOk = diffEnd !== null && Math.abs(diffEnd) <= 0.005;
  blocks.plain = {
    status: diffOk
      ? "ok"
      : (typeof blocks.shareStartPct === "number" && blocks.shareStartPct >= 51)
      ? "warn-start"
      : "warn-ops",
    summary: diffOk
      ? `Сверка между «${nameA}» и «${nameB}» сошлась: задолженности по итогам совпадают.`
      : `Сверка между «${nameA}» и «${nameB}» не сошлась: по данным «${blocks.favorName}» задолженность выше на ${Math.abs(diffEnd).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽.`,
    whoOwes:
      diffOk
        ? "—"
        : `«${blocks.favorName}» показывает сумму на ${Math.abs(diffEnd).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽ больше, чем «${blocks.favorName === nameA ? nameB : nameA}». Это значит, что данные сторон расходятся — нужно разобраться, кто прав.`,
    reason:
      diffOk
        ? "Разногласий по суммам нет, расхождений не выявлено."
        : (typeof blocks.shareStartPct === "number" && blocks.shareStartPct >= 51)
        ? `Главное расхождение (${blocks.shareStartPct}%) идёт «из прошлого периода»: начальные остатки уже различались до этого отчётного периода. Дальше стоит сверить, откуда расхождение пришло.`
        : `Расхождение образовалось операциями ЗА этот период (${blocks.shareOpsPct || 100}%) — начальные остатки совпадали. Стоит проверить документы этого периода.`,
    firstAction:
      diffOk
        ? "Ничего делать не нужно — сверка сошлась."
        : (typeof blocks.shareStartPct === "number" && blocks.shareStartPct >= 51)
        ? `Сверить входящие остатки на начало периода — именно там (${blocks.shareStartPct}% разницы) корень расхождения.`
        : "Сверить документы и операции этого периода — расхождение возникло в нём.",
    termsPlain: {
      saldo: "«Сальдо» — это сколько сторона должна другой на конец периода (итог взаиморасчётов).",
      debitCredit: "«Дебет» и «кредит» — направления движения по счёту; в нашем контексте это приход и расход стороны.",
      unmatched: "«Непарные операции» — документы, которые есть только у одной стороны в сверке, а у другой отсутствуют.",
      обороты: "«Обороты за период» — все движения (документы) за отчётный месяц.",
    },
  };

  lines.push(`Сверка актов: «${nameA}» и «${nameB}».`);
  lines.push(`Операций: в первом — ${actA.ops.length}, во втором — ${actB.ops.length}.`);

  if (r.onlyA.length) {
    const s = r.onlyA.reduce((x, o) => x + Math.abs(o.sum), 0);
    lines.push(
      `В первом акте есть операции, отсутствующие во втором (${r.onlyA.length} шт, на ${money(
        s
      )} руб): ` +
        r.onlyA.map((o) => `${docName(o)} (${o.sum} руб, ${o.side === "д" ? "дебет" : "кредит"})`).join("; ") +
        "."
    );
  }
  if (r.onlyB.length) {
    const s = r.onlyB.reduce((x, o) => x + Math.abs(o.sum), 0);
    lines.push(
      `Во втором акте есть операции, отсутствующие в первом (${r.onlyB.length} шт, на ${money(
        s
      )} руб): ` +
        r.onlyB.map((o) => `${docName(o)} (${o.sum} руб)`).join("; ") +
        "."
    );
  }
  if (r.sumDiff.length) {
    lines.push(
      "Различаются суммы по совпадающим документам: " +
        r.sumDiff
          .map((d) => `${docName(d.a)}: ${money(d.a.sum)} vs ${money(d.b.sum)} (разница ${money(Math.abs(d.diff))})`)
          .join("; ") +
        "."
    );
  } else {
    lines.push("По всем совпадающим документам суммы сходятся.");
  }

  // Сверка сальдо
  lines.push("Сальдо конечное (долг/задолженность):");
  if (sA !== null) lines.push(`  по первому акту — ${money(sA)} руб;`);
  if (sB !== null) lines.push(`  по второму акту — ${money(sB)} руб;`);
  if (sA !== null && sB !== null) {
    const diff = sB - sA;
    const favor =
      diff > 0 ? nameB : diff < 0 ? nameA : "—";
    if (Math.abs(diff) <= 0.005) {
      lines.push("Сальдо сходится — расхождений по итогу нет.");
    } else {
      lines.push(
        `Разница сальдо: ${money(Math.abs(diff))} руб в пользу ${favor} ` +
          `(${favor} показывает на ${money(Math.abs(diff))} руб больше). Требуется уточнение.`
      );
    }
  }

  // Расхождение начального сальдо — переносится из прошлого периода и формирует
  // часть (часто основную) разницы конечного сальдо.
  if (ssA !== null && ssB !== null && Math.abs(ssB - ssA) > 0.005) {
    const dStart = Math.abs(ssB - ssA);
    const favorStart = ssB > ssA ? nameB : nameA;
    lines.push(
      `Внимание: расходится начальное сальдо — ${money(dStart)} руб ` +
        `(${nameA}: ${money(ssA)} руб, ${nameB}: ${money(ssB)} руб). ` +
        `Это расхождение переносится из прошлого периода и составляет основную часть ` +
        `(${money(dStart)} из ${sA !== null && sB !== null ? money(Math.abs(sB - sA)) : "0"} руб общей разницы) ` +
        `итоговой разницы сальдо. Рекомендуется отдельно сверить входящие остатки на начало периода.`
    );
  }

  return {
    summary: lines.join("\n"),
    result: r,
    blocks,
    saldoDiff:
      sA !== null && sB !== null
        ? { diff: sB - sA, favorA: sB > sA, favorB: sA > sB, sA, sB }
        : null,
  };
}

function docName(o) {
  // короткое имя: номер документа
  const m = /№\s*([\w-]+)/i.exec(o.doc || "");
  return m ? "док №" + m[1] : o.key;
}

module.exports = { parseAct, reconcileActs, analyze, money, docKey };
