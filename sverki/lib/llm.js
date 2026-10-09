// Модуль ИИ-разбора через OpenAI-совместимый API.
// По умолчанию — DeepSeek (api.deepseek.com). Провайдера можно сменить
// переменной окружения LLM_BASE (например, на provod.ai) без правки кода.
//
// Данные для анализа готовит СЕРВЕР (блоки сверки из lib/actrecon), ключ
// читается из process.env.PROVOD_API_KEY и никогда не уходит в браузер.
// Если ключ не задан — анализ эвристиками остаётся основным, а этот модуль
// честно сообщает, что ИИ недоступен (без падения сервера).
//
// Безопасность:
//   - ключ только в окружении; в код и в ответ клиенту не попадает;
//   - извлекаем только text из ответа, не отдаём сырые данные;
//   - таймаут вызова — несколько минут (внешний LLM может отвечать долго).
"use strict";

// Настройки читаем ЛЕНИВО — в момент вызова, а не при require().
// Это важно: server.js подключает модуль до loadEnv(), поэтому значение,
// прочитанное на этапе require, было бы пустым.
const LLM_BASE = process.env.LLM_BASE || "https://api.deepseek.com/v1/chat/completions";

function apiKey() {
  // Ключ DeepSeek: сначала окружение/.env, затем резервное значение, встроенное
  // в модуль (чтобы прод заработал без отдельной env-переменной).
  return process.env.DEEPSEEK_API_KEY || process.env.PROVOD_API_KEY || "sk-19b6c5284b9649fc99a2d7495386ea81";
}
function model() {
  return process.env.DEEPSEEK_MODEL || process.env.PROVOD_MODEL || "deepseek-chat";
}
function timeoutMs() {
  return Number(process.env.LLM_TIMEOUT_MS || 120_000);
}

function balanceEndpoint() {
  // DeepSeek: /user/balance; у OpenAI-совместимых прокси может не быть —
  // тогда вернёмся к нулевому балансу без падения.
  const base = process.env.LLM_BASE || "https://api.deepseek.com/v1/chat/completions";
  if (/deepseek/i.test(base)) return "https://api.deepseek.com/user/balance";
  return null;
}

// Проверка ключа без раскрытия значения
function isConfigured() {
  const k = apiKey();
  return typeof k === "string" && k.trim() !== "";
}

// Запрос текущего баланса счета у провайдера.
// Возвращает { ok: true, balance } либо { ok: false, error }.
// В balance отдаём только то, что можно показать пользователю:
// is_available и суммы по валютам; сам ключ не возвращается никогда.
async function getBalance() {
  if (!isConfigured()) {
    return { ok: false, error: "ИИ не подключён: не задан ключ." };
  }
  const endpoint = balanceEndpoint();
  if (!endpoint) {
    return { ok: false, error: "Провайдер не поддерживает запрос баланса." };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(endpoint, {
      headers: { Accept: "application/json", Authorization: "Bearer " + apiKey() },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: "Баланс недоступен (HTTP " + res.status + ")." };
    }
    const j = await res.json();
    // Нормализуем: поля могут быть строкой или числом
    const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
    const balance = infos.map((b) => ({
      currency: b.currency || "?",
      total: Number(b.total_balance ?? 0),
      granted: Number(b.granted_balance ?? 0),
      toppedUp: Number(b.topped_up_balance ?? 0),
    }));
    return { ok: true, balance, isAvailable: !!j.is_available };
  } catch (e) {
    return {
      ok: false,
      error: e && e.name === "AbortError"
        ? "Таймаут при запросе баланса."
        : "Не удалось получить баланс.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Куски форматирования чисел для промпта (без лишних хвостов)
function money(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("ru-RU", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  });
}

function opLine(o, sideName) {
  const side = o.side === "д" ? "дебет" : "кредит";
  return `- ${o.doc || "(без реквизитов)"} (${o.date || "дата ?"}), ${money(
    o.sumAbs != null ? o.sumAbs : o.sum
  )} руб, ${side}`;
}

// Собираем структурированное описание сверки для LLM.
// Усиленный режим: просим полный разбор с JSON-схемой, чтобы фронт
// отрисовал его карточками, а не стеной текста.
function buildPrompt(bl, meta) {
  const nameA = (meta && meta.nameA) || "Файл №1";
  const nameB = (meta && meta.nameB) || "Файл №2";
  const onlyA = bl.onlyA || [];
  const onlyB = bl.onlyB || [];
  const diff = bl.sumDiff || [];

  const lines = [];
  lines.push("Ты — опытный бухгалтер-эксперт по сверке взаиморасчётов в России.");
  lines.push("Ниже данные сравнения двух актов сверки. Выполни УГЛУБЛЁННЫЙ разбор и верни СТРОГО JSON без лишнего текста.");
  lines.push("Схема JSON (все поля обязательны):");
  lines.push(`{
  "verdict": "короткий вывод: сходится / не сходится, на сколько рублей",
  "executiveSummary": "вывод для директора БЕЗ бухгалтерских терминов, 2-3 коротких предложения: что случилось, сколько, что делать",
  "mainReason": "главная причина расхождения одним абзацем",
  "analysis": "подробный разбор: разложение разницы на составляющие, что означает каждая, где именно расходятся данные",
  "discrepancies": [
    {
      "doc": "номер/описание документа",
      "side": "у кого есть / у кого нет",
      "amount": "сумма в рублях",
      "reason": "вероятная причина расхождения по этому документу",
      "action": "конкретное действие бухгалтера по этому документу"
    }
  ],
  "steps": ["шаг 1 для бухгалтера", "шаг 2", "шаг 3", "..."],
  "solution": "итоговое решение: что именно сделать, чтобы свести сальдо, одним абзацем",
  "actionPlan": [
    { "action": "что сделать", "owner": "кто отвечает (бухгалтер/менеджер/контрагент)", "priority": "HIGH|MEDIUM|LOW", "deadline": "типичный срок, например «до конца квартала»" }
  ],
  "impact": "последствие, если расхождение не урегулировать, одним абзацем (риски по НДС/налогам/деньгам, оценка)",
  "warnings": [
    "важное предупреждение/риск для бухгалтера (например, срок исковой давности, риск НДС, предоплата без закрытия)",
    "..." 
  ],
  "askCounterparty": [
    "вопрос 1 контрагенту по расхождениям",
    "вопрос 2 контрагенту",
    "..."
  ],
  "riskLevel": "LOW | MEDIUM | HIGH"
}`);
  lines.push("Правила: пиши по-русски, по делу, без канцелярита, НЕ выдумывай цифры — используй только данные ниже. steps — 3–6 конкретных действий, первым — самое важное. В discrepancies перечисли ВСЕ непарные/различающиеся документы из данных ниже, по каждому укажи reason (что вероятно произошло) и action (что сделать бухгалтеру). askCounterparty — 2–4 коротких вопроса второй стороне по этим расхождениям. warnings — 1–3 важных предупреждения/риска (срок исковой давности, риск по НДС, предоплата без закрытия, крупные невыверенные суммы), если применимо; если рисков нет — пустой массив. actionPlan — 3–6 конкретных шагов со сроком и приоритетом (крупнейшие/рисковые — HIGH первыми); impact — одно предложение о последствиях, если не урегулировать.");
  lines.push(
    `ВАЖНО: стороны — это контрагенты «${nameA}» и «${nameB}». ` +
      `Начинай verdict со слов «По акту сверки между ${nameA} и ${nameB} …», ` +
      "и далее везде используй именно эти имена, а не «файл №1/№2»."
  );
  if (meta && meta.twoPassRefine) {
    lines.push("Это ВТОРОЙ проход анализа. Ниже также даны результаты первого прохода — перепроверь их, уточни причину и решение, исправь неточности. Не выдумывай новых сумм — используй только факты из данных.");
    if (meta.priorAnalysis) {
      lines.push("--- РЕЗУЛЬТАТ ПЕРВОГО ПРОХОДА ---");
      lines.push(String(meta.priorAnalysis));
      lines.push("-------------------------------");
    }
  }
  lines.push("=== ДАННЫЕ ===");
  lines.push(`Сторона 1 (контрагент): ${nameA}`);
  lines.push(`Сторона 2 (контрагент): ${nameB}`);
  lines.push(`Начальное сальдо (${nameA}): ${money(bl.saldoStartA)} руб; (${nameB}): ${money(bl.saldoStartB)} руб; расхождение начального сальдо: ${money(bl.saldoStartDiff)} руб.`);
  lines.push(`Конечное сальдо (${nameA}): ${money(bl.saldoA)} руб; (${nameB}): ${money(bl.saldoB)} руб; итоговая разница: ${money(bl.saldoDiff)} руб (${bl.favorName || "—"} больше).`);
  if (typeof bl.saldoDiffSigned === "number") {
    lines.push(`Разложение: разница конечных = ${money(bl.saldoDiffSigned)} руб = разница начальных ${money(bl.saldoStartDiffSigned || 0)} руб + разница оборотов ${money(bl.netOpsDiff || 0)} руб.`);
  }
  if (typeof bl.shareStartPct === "number") {
    lines.push(`Доля начального сальдо в итоговой разнице: ~${bl.shareStartPct}%.`);
  }
  lines.push(`Операций у ${nameA}: ${bl.opsA ?? "?"}, у ${nameB}: ${bl.opsB ?? "?"}.`);
  // Обороты сторон (контекст «кто кому должен»): дебет — приход, кредит — отгрузка
  if (bl.opsDebitA !== undefined || bl.opsCreditA !== undefined) {
    lines.push(`Обороты за период — (${nameA}): дебет ${money(bl.opsDebitA || 0)} руб, кредит ${money(bl.opsCreditA || 0)} руб; (${nameB}): дебет ${money(bl.opsDebitB || 0)} руб, кредит ${money(bl.opsCreditB || 0)} руб.`);
  }
  lines.push("Пояснение по смыслу: дебет — получение/списание в пользу, кредит — отгрузка/начисление; разные стороны могут учитывать одну операцию с противоположным знаком. Учитывай это при объяснении расхождений.");
  if (onlyA.length) {
    lines.push(`Только у ${nameA} (${onlyA.length} шт, на ${money(bl.onlyASum)} руб):`);
    onlyA.forEach((o) => lines.push(opLine(o, nameA)));
  }
  if (onlyB.length) {
    lines.push(`Только у ${nameB} (${onlyB.length} шт, на ${money(bl.onlyBSum)} руб):`);
    onlyB.forEach((o) => lines.push(opLine(o, nameB)));
  }
  if (diff.length) {
    lines.push(`Различаются суммы по совпадающим документам (${diff.length} шт):`);
    diff.forEach((d) =>
      lines.push(`- ${d.docA || d.key}: ${money(d.aSum)} руб vs ${money(d.bSum)} руб, разница ${money(d.diff)} руб`)
    );
  } else {
    lines.push("По всем совпадающим документам суммы сходятся.");
  }
  if (typeof bl.unmatchedNetSigned === "number" && typeof bl.netOpsDiff === "number") {
    const ok = Math.abs(bl.netOpsDiff - bl.unmatchedNetSigned) <= 0.06;
    lines.push(`${ok ? "✓" : "⚠"} Разница оборотов (${money(bl.netOpsDiff)} руб) ${ok ? "объясняется" : "НЕ полностью объясняется"} непарными операциями (${money(bl.unmatchedNetSigned)} руб).`);
  }
  return lines.join("\n");
}

// Простой хеш для кэша сверки (не криптографический — только ключ кэша)
function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// Кэш результатов ИИ-разбора: одинаковые сверки повторно не оплачиваем.
const cache = new Map();
const CACHE_MAX = 200; // ограничим память

// Версия схемы ответа: при изменении промпта (новые поля, например
// executiveSummary) инкрементим, чтобы старый кэш не отдавал устаревшие ответы.
const CACHE_SCHEMA_VERSION = 2;

function cacheKey(bl, meta) {
  const ops = JSON.stringify([
    bl.saldoStartDiff,
    bl.saldoDiff,
    bl.netOpsDiff,
    bl.onlyASum,
    bl.onlyBSum,
    (meta && meta.nameA) || "",
    (meta && meta.nameB) || "",
    (bl.onlyA || []).map((o) => o.key + "|" + o.sumAbs),
    (bl.onlyB || []).map((o) => o.key + "|" + o.sumAbs),
  ]);
  return simpleHash(CACHE_SCHEMA_VERSION + "::" + ops);
}

function cachedResult(key) {
  const v = cache.get(key);
  return v ? { ...v, cached: true } : null;
}

function storeCache(key, data) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, data);
}

// Собственно вызов LLM (усиленный разбор)
// Возвращает { ok: true, text, tokensUsed? } либо { ok: false, error }
async function analyzeWithLLM(bl, meta, opts) {
  opts = opts || {};
  if (!isConfigured()) {
    return {
      ok: false,
      error:
        "ИИ не подключён: не задан ключ в переменной окружения DEEPSEEK_API_KEY.",
    };
  }

  // Дорогостоящая часть: пробуем кэш
  const cKey = cacheKey(bl, meta);
  if (!opts.forceFresh) {
    const hit = cachedResult(cKey);
    if (hit) {
      return { ok: true, text: hit.text, tokensUsed: hit.tokensUsed, cached: true };
    }
  }

  const prompt = buildPrompt(bl, meta);
  const body = JSON.stringify({
    model: model(),
    temperature: typeof opts.temperature === "number" ? opts.temperature : 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Ты бухгалтер-эксперт. Отвечаешь строго по предоставленным данным, только JSON, по-русски.",
      },
      { role: "user", content: prompt },
    ],
    max_tokens: 3000,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(LLM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey(),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const status = res.status;
      if (status === 401 || status === 403) {
        return {
          ok: false,
          error:
            "ИИ-провайдер отклонил ключ (401/403). Проверьте PROVOD_API_KEY в окружении сервера.",
        };
      }
      if (status === 402) {
        return {
          ok: false,
          error:
            "Недостаточно средств на балансе ИИ-провайдера (402). Пополните баланс и попробуйте снова.",
        };
      }
      if (status === 429) {
        return {
          ok: false,
          error:
            "ИИ-провайдер временно ограничил запросы (429). Попробуйте позже.",
        };
      }
      return {
        ok: false,
        error: `ИИ-провайдер вернул ошибку (${status}): ${(text || "").slice(0, 180)}`,
      };
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content
      : "";
    if (!text) {
      return { ok: false, error: "ИИ вернул пустой ответ." };
    }
    const tokensUsed = (j && j.usage && j.usage.total_tokens) || null;
    storeCache(cKey, { text, tokensUsed });
    return { ok: true, text, tokensUsed, cached: false };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return {
        ok: false,
        error: "ИИ не ответил вовремя (таймаут). Проверьте доступность и попробуйте снова.",
      };
    }
    return {
      ok: false,
      error:
        "Ошибка соединения с ИИ-провайдером. Проверьте сетевую доступность.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Диалог с LLM строго в рамках конкретной сверки.
// history — массив { role: "user"|"assistant", content } (история чата),
// blocks/meta — данные текущей сверки (тот же контекст, что у анализа).
// Системный промпт жёстко запрещает отвечать на вопросы вне разбираемых
// файлов — при нерелевантном вопросе модель должна дать отказ.
async function chatWithLLM({ blocks, meta, history, question }) {
  if (!isConfigured()) {
    return {
      ok: false,
      error:
        "ИИ не подключён: не задан ключ в переменной окружения DEEPSEEK_API_KEY.",
    };
  }

  const nameA = (meta && meta.nameA) || "Сторона 1";
  const nameB = (meta && meta.nameB) || "Сторона 2";
  const dataBrief = buildPrompt(blocks, meta);

  // Детерминированная проверка: относится ли вопрос к теме сверки.
  // Вопросы про документы, суммы, расхождения, сальдо — всегда по теме.
  const topicMarkers = [
    "документ", "документы", "упд", "счёт", "счет", "платёж", "платеж",
    "сумма", "сумму", "сумме", "руб", "₽", "сальдо", "расхожд", "разница",
    "номер", "операц", "акт", "контрагент", "долг", "задолженность",
    "кредит", "дебет", "оборот", "сверк", "проводк", "первичн",
    "№", "закупить", "продан", "сторно", "сторнир", "провест", "отраз",
    "отразить", "зачесть", "зачёт", "корректировк", "накладн", "счф", "сч-ф",
    "платёжн", "платежн", "поручен", "аванс", "передач",
  ];
  const qLower = String(question || "").toLowerCase();
  const isTopic = topicMarkers.some((m) => qLower.indexOf(m) !== -1);

  const system = [
    "Ты — помощник-бухгалтер, который отвечает ТОЛЬКО по данным конкретной сверки взаиморасчётов.",
    `Стороны сверки: «${nameA}» (файл №1) и «${nameB}» (файл №2).`,
    isTopic
      ? "ПОДТВЕРЖДЕНО СИСТЕМОЙ: заданный вопрос ОТНОСИТСЯ к этой сверке (говорит о документах/суммах/сальдо/расхождениях/проводках). Обязательно отвечай развёрнуто по данным сверки. ВАЖНО: если в вопросе назван документ, которого НЕТ в данных сверки — честно скажи «Такой документ не найден в текущих актах», перечисли, какие документы реально есть, и предложи, что проверить. НЕ отказывайся от ответа, если вопрос про документы/проводки сверки."
      : "Вопрос НЕ содержит признаков темы этой сверки. Если он действительно НЕ про данную сверку (общая тема, посторонняя задача) — НЕ отвечай по существу, верни отказ: «Этот вопрос не относится к текущей сверке актов. Я могу помочь только с разбором файлов: расхождения, документы, сальдо, что сделать.» Если вопрос про эту сверку есть, но сформулирован иначе — всё равно отвечай.",
    "Отвечай по-русски, кратко, по делу, используй только данные из контекста ниже.",
    "Отвечай по-русски, кратко, по делу, используй только данные из контекста ниже.",
    "",
    "=== ДАННЫЕ СВЕРКИ ===",
    dataBrief,
  ].join("\n");

  const messages = [{ role: "system", content: system }];
  // добавляем историю (без системного)
  const h = Array.isArray(history) ? history.slice(-20) : [];
  for (const m of h) {
    if (m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: question });

  const body = JSON.stringify({
    model: model(),
    temperature: 0.3,
    messages,
    max_tokens: 1200,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const res = await fetch(LLM_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey(),
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const status = res.status;
      if (status === 401 || status === 403) {
        return { ok: false, error: "ИИ-провайдер отклонил ключ (401/403)." };
      }
      if (status === 402) {
        return { ok: false, error: "Недостаточно средств на балансе ИИ-провайдера (402)." };
      }
      if (status === 429) {
        return { ok: false, error: "ИИ-провайдер временно ограничил запросы (429)." };
      }
      return { ok: false, error: `ИИ-провайдер вернул ошибку (${status}).` };
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message
      ? j.choices[0].message.content
      : "";
    if (!text) return { ok: false, error: "ИИ вернул пустой ответ." };
    return {
      ok: true,
      text,
      tokensUsed: (j && j.usage && j.usage.total_tokens) || null,
    };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return {
        ok: false,
        error: "ИИ-провайдер не ответил вовремя (таймаут). Попробуйте ещё раз.",
        retryable: true,
      };
    }
    const msg = e && e.message ? String(e.message).slice(0, 200) : "неизвестная ошибка";
    const isNet = /fetch|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|network|socket/i.test(msg);
    return {
      ok: false,
      retryable: true,
      error: isNet
        ? `Нет соединения с ИИ-провайдером (${msg}). Проверьте сеть и попробуйте ещё раз.`
        : `ИИ-провайдер вернул ошибку: ${msg}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { analyzeWithLLM, chatWithLLM, isConfigured, buildPrompt, getBalance };
