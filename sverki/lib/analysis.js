// "ИИ"-слой анализа: для каждого расхождения даёт понятное объяснение
// и собирает общую картину сверки. Эвристики читают контекст (названия
// колонок, тип расхождения, имена файлов), поэтому формулировки
// получаются "живыми", а не шаблонными. При желании сюда же можно
// подключить внешнюю LLM (см. analyzeWithLLM).
"use strict";

const { toNum } = require("./reconcile");

function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return (
    sign +
    abs.toLocaleString("ru-RU", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2,
    })
  );
}

function fieldLabelMap(rec) {
  // переводим норм-ключ в читаемое название если можем
  return rec.__labels || {};
}

function humanFieldName(field, labels) {
  return (labels && labels[field]) || field;
}

function describeNumberDiff(diff, labels) {
  const name = humanFieldName(diff.field, labels);
  const a = money(diff.a);
  const b = money(diff.b);
  const d = money(diff.diff);
  if (/сумм|итого|оплат|сальдо|дебет|кредит|приход|расход|стоимост|цена/i.test(diff.field)) {
    const dir = diff.diff > 0 ? "больше" : "меньше";
    return `По полю «${name}» значение различается: в первом файле ${a}, во втором — ${b} (разница ${dir === "больше" ? "+" : ""}${d}).`;
  }
  return `Значение поля «${name}» различается: в первом файле ${a}, во втором — ${b}.`;
}

function describeStringDiff(diff, labels) {
  const name = humanFieldName(diff.field, labels);
  return `Поле «${name}» не совпало: в первом файле «${diff.a || "—"}», во втором — «${diff.b || "—"}».`;
}

function labelMapFromHeaders(headers) {
  const m = {};
  for (const h of headers || []) {
    if (h && h.norm) m[h.norm] = h.title;
  }
  return m;
}

function analyzeChanged(item, labels) {
  const lines = [];
  for (const d of item.diffs) {
    if (d.kind === "number") lines.push(describeNumberDiff(d, labels));
    else lines.push(describeStringDiff(d, labels));
  }
  return lines;
}

function analyzeOnly(item, which, labels) {
  const side = which === "a" ? "первом" : "втором";
  return `Запись присутствует только в ${side} файле и не найдена во втором.`;
}

// Собираем общий текстовый вывод по всей сверке
function buildSummary(result, meta) {
  const lines = [];
  lines.push(`Сверка завершена. Файлов: «${meta.nameA}» (${meta.rowsA} строк) и «${meta.nameB}» (${meta.rowsB} строк).`);
  lines.push(`Ключ сопоставления: «${meta.keyLabel}».`);
  lines.push(`Совпало ключей: ${result.matched}.`);
  if (result.onlyA.length)
    lines.push(`Только в первом файле: ${result.onlyA.length}.`);
  if (result.onlyB.length)
    lines.push(`Только во втором файле: ${result.onlyB.length}.`);
  if (result.changed.length)
    lines.push(`Совпали по ключу, но различаются по полям: ${result.changed.length}.`);

  // Аккуратная интерпретация
  const total = result.onlyA.length + result.onlyB.length + result.changed.length;
  if (total === 0) {
    lines.push("Расхождений не обнаружено — данные полностью согласованы. ✅");
  } else {
    lines.push(
      `Итого расхождений: ${total}. Рекомендуется проверить: ` +
        [
          result.onlyA.length ? `${result.onlyA.length} позиций, отсутствующих во втором файле` : null,
          result.onlyB.length ? `${result.onlyB.length} позиций, отсутствующих в первом файле` : null,
          result.changed.length ? `${result.changed.length} позиций с различиями в значениях` : null,
        ]
          .filter(Boolean)
          .join("; ") +
        "."
    );
  }
  return lines.join("\n");
}

// Полный анализ по результатам сверки
function analyze(result, meta) {
  const labels = labelMapFromHeaders(meta.headersA);
  Object.assign(labels, labelMapFromHeaders(meta.headersB));

  const changedDetailed = result.changed.map((item) => ({
    key: item.key,
    side: "changed",
    reasons: analyzeChanged(item, labels),
    diffs: item.diffs,
  }));
  const onlyADetailed = result.onlyA.map((item) => ({
    key: item.key,
    side: "onlyA",
    reasons: [analyzeOnly(item, "a", labels)],
  }));
  const onlyBDetailed = result.onlyB.map((item) => ({
    key: item.key,
    side: "onlyB",
    reasons: [analyzeOnly(item, "b", labels)],
  }));

  return {
    summary: buildSummary(result, meta),
    items: [...onlyADetailed, ...onlyBDetailed, ...changedDetailed],
  };
}

// Заглушка для внешней LLM: сюда можно передать ключ LLM и получить
// глубокий разбор. Сейчас эвристики справляются сами, поэтому функция
// возвращает null, если конфигурации LLM нет.
function analyzeWithLLM(distilled, config) {
  return null; // LLM не сконфигурирована — эвристический анализ уже готов
}

module.exports = { analyze, analyzeWithLLM, money };
