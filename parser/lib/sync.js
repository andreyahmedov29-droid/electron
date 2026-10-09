// Логика синхронизации: письма Яндекса -> статусы в Google Таблице.
const { ImapClient } = require('./imap');
const { SheetsClient, findRowForArticleDetailed, findAllRowsForArticle, findAllRowsForArticleIndexed, buildArticleIndex, columnValues, columnLetterToIndex } = require('./sheets');
const matcher = require('./matcher');

// Обратная совместимость: функции делегируют в детерминированный матчер
// (lib/matcher), который ловит падежи, глаголы и опечатки в ключевых словах.
function determineStatusDetail(body, keywordsArr) {
  return matcher.determineStatusDetail(body, keywordsArr);
}

// Обратная совместимость: возвращает только статус.
function determineStatus(body, rules) {
  return matcher.determineStatus(body, rules);
}

// Извлечь артикул из темы письма.
// Если задан pattern (regex) — применяем его: берётся первая захватывающая
// группа, либо весь match, если групп нет. Не найдено — null.
// Без pattern работает авто-эвристика: #N / [N] / {N} / (N), затем токен,
// похожий на артикул (содержит цифру, либо заглавный/символьный код).
function extractArticle(subject, pattern) {
  if (!subject) return null;

  if (pattern && String(pattern).trim()) {
    try {
      const re = new RegExp(String(pattern).trim());
      const m = subject.match(re);
      if (m) {
        // первая захватывающая группа, иначе весь match
        for (let i = 1; i < m.length; i++) {
          if (m[i] !== undefined && m[i] !== null && String(m[i]).trim() !== '') {
            return String(m[i]).trim();
          }
        }
        if (m[0]) return String(m[0]).trim();
      }
      // паттерн не совпал — не теряем письмо, пробуем эвристику ниже
    } catch (e) {
      // невалидный regex — игнорируем и переходим к эвристике
    }
  }

  // 1) явные маркеры
  const markers = [
    /(?:^|\s|\(|\[|{)#([A-Za-z0-9][A-Za-z0-9.\-_]*)/g,
    /[\[{\(]([A-Za-z0-9][A-Za-z0-9.\-_]*)[\]}\)]/g
  ];
  for (const re of markers) {
    const m = subject.match(re);
    if (m) return m[0].replace(/[\[{\]#()]/g, '').trim();
  }

  // 2) токены
  const tokens = subject.split(/[\s,;:]+/).map((t) => t.replace(/[^\w.\-]+/g, '')).filter(Boolean);
  for (const t of tokens) {
    const clean = t.replace(/[^A-Za-zА-Яа-я0-9.\-_]/g, '');
    if (!clean || clean.length < 2) continue;
    const hasDigit = /\d/.test(clean);
    const allUpper = clean === clean.toUpperCase() && /[A-ZА-Я]/.test(clean);
    const hasDashOrDot = /[.\-_]/.test(clean);
    if (hasDigit || allUpper || hasDashOrDot) return clean;
  }
  return null;
}

// Найти артикул в письме: сначала в теме, потом в теле (фолбэк).
// Возвращает { article, source } — где был найден: 'subject' | 'body' | null.
// Если pattern задан и ни тема, ни тело не совпали — article остаётся null.
function extractArticleFromEmail(subject, body, pattern) {
  const fromSubject = extractArticle(subject, pattern);
  if (fromSubject) return { article: fromSubject, source: 'subject' };
  // Если у пользователя задан явный шаблон (regex), применяем его и к телу.
  const fromBody = extractArticle(body, pattern);
  if (fromBody) return { article: fromBody, source: 'body' };
  return { article: null, source: null };
}

// Извлечь номер инвойса из письма (тема + тело).
// Если задан invoicePattern (regex) — применяем его в первую очередь.
// Иначе — эвристика по меткам INV / INVOICE / ИНВОЙС с номером.
// Возвращает { invoice, source } или { invoice: null, source: null }.
function extractInvoiceFromEmail(subject, body, pattern) {
  const haystack = [String(subject || ''), String(body || '')];
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sources = haystack.map(norm);

  // Явный regex-паттерн: пробуем на теме, затем на теле.
  if (pattern && String(pattern).trim()) {
    try {
      const re = new RegExp(String(pattern).trim(), 'i');
      for (const [i, text] of sources.entries()) {
        if (!text) continue;
        const m = text.match(re);
        if (m) return { invoice: (m[1] || m[0]).trim(), source: i === 0 ? 'subject' : 'body' };
      }
    } catch (e) { /* невалидный regex — переходим к эвристике */ }
  }

  // Эвристика: ищем номер инвойса.
  for (const [i, text] of sources.entries()) {
    if (!text) continue;
    // 1) слово invoice/инвойс/счёт + номер после него (Invoice #F-90711, инвойс 12345)
    const word = text.match(/(?:invoice|инвойс|счёт|счет)[\s#№:.\-]*([A-Z0-9][A-Z0-9.\-]{2,})\b/i);
    if (word) return { invoice: word[1].trim(), source: i === 0 ? 'subject' : 'body' };
    // 2) токен, начинающийся с INV и содержащий номер (INV-48213, INVOICE77)
    const token = text.match(/\binv(?:oice)?[\s\-_.:#№]*[A-Z0-9][A-Z0-9.\-]{1,}\b/i);
    if (token) return { invoice: token[0].trim(), source: i === 0 ? 'subject' : 'body' };
  }
  return { invoice: null, source: null };
}

// Извлечь значение из строки с меткой, например «Артикул: ABC-123» или
// «Номер инвойса: INV-48213». labelKeys — массив меток (без двоеточия).
// Ищем по тексту (тело письма), значение — до конца строки, чистим.
// Возвращает строку или null.
function extractValueByLabel(body, labelKeys) {
  const text = String(body || '');
  const labels = (labelKeys || []).map((l) => String(l).replace(/:$/, '').trim().toLowerCase()).filter(Boolean);
  if (!labels.length) return null;
  // ищем по строкам (текст мог прийти с переносами строк)
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    // ищем любую из меток в строке (метка может быть и не в начале строки)
    const lower = line.toLowerCase();
    for (const l of labels) {
      const idx = lower.indexOf(l);
      if (idx === -1) continue;
      // отделяем метку границей слова/концом (не часть большего слова)
      const before = idx > 0 ? lower[idx - 1] : '';
      if (/[а-яa-z0-9]/.test(before)) continue;
      const after = line.slice(idx + l.length);
      // После метки (пропустив пробелы) должен идти разделитель — двоеточие
      // «:» (формат «Метка: значение») либо тире « - » (формат «верный номер
      // документа - АС…»). Без разделителя короткая метка («Арт» внутри слова
      // «артикул/артикулом») давала бы ложное значение.
      const colon = after.match(/^\s*[:：]\s*["'«]?(.+?)["'»]?\s*$/);
      if (colon && colon[1].trim()) {
        // берём значение, обрезая до конца строки (переносов в цитате нет)
        return colon[1].trim();
      }
      const dash = after.match(/^\s*-\s*["'«]?(.+?)["'»]?\s*$/);
      if (dash && dash[1].trim()) return dash[1].trim();
    }
  }
  return null;
}

// Разобрать тему письма в формате «Согласование <лого> - <артикул> - <причина>».
// <лого> — необязательный код поставщика (например RRE). Возвращает
// { article, reason, logo } по секциям темы.
function extractApprovalReason(subject) {
  const t = String(subject || '')
    // срезаем префиксы ответа/пересылки (могут повторяться, в любом регистре)
    .replace(/^\s*(?:(?:re|fwd|fw|ответ|отв)\s*[:\s>]*)+/i, '')
    .trim();
  // разделитель — дефис, окружённый пробелами (чтобы не рвать артикулы с дефисом)
  const segs = t.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  if (segs.length < 2) return { article: null, reason: null, logo: null, isApproval: false };
  // первая секция: «Согласование <лого>» → лого = слово(а) после «Согласование»
  let logo = null;
  const first = segs[0].replace(/\s{2,}/g, ' ').trim();
  const isApproval = /^Согласовани[ея]?(?:\s|$)/i.test(first);
  const lm = first.match(/^Согласовани[ея]?\s+(.+)$/i);
  if (lm) logo = lm[1].trim() || null;
  const article = segs[1] || null;
  const reason = segs.length > 2 ? segs.slice(2).join(' - ') : null;
  return { article, reason, logo, isApproval };
}

// Извлечь причину из письма. Сначала из темы (формат «Согласование - … - <причина>»),
// затем (фолбэк) из поля «Причина возврата: …» / «Причина: …» в теле.
// Возвращает строку или null.
function extractReasonFromEmail(subject, body) {
  const fromSubject = extractApprovalReason(subject).reason;
  if (fromSubject && String(fromSubject).trim()) return fromSubject.trim();
  const fromBody = extractValueByLabel(body, ['Причина возврата', 'Причина отклонения', 'Причина отказа', 'Причина']);
  if (fromBody && String(fromBody).trim()) return fromBody.trim();
  return null;
}

// Извлечь лого поставщика из темы письма: «Согласование <лого> - <артикул> - …».
// Возвращает строку (код лого) или null.
function extractLogoFromEmail(subject) {
  const fromSubject = extractApprovalReason(subject).logo;
  return fromSubject && String(fromSubject).trim() ? fromSubject.trim() : null;
}

// Нормализовать причину для сравнения: убрать пробелы и невидимые разделители
// (обычный/неразрывный пробел, мягкий перенос, zero-width), чтобы случайный
// разрыв в теме письма типа «ца рапины» сравнивался как «царапины».
function normalizeComparePhrase(s) {
  return String(s || '')
    .replace(/[\s\u00a0\u200b\u200c\u200d\u00ad\u202f\u2060]+/g, '')
    .trim()
    .toLowerCase();
}

// Извлечь часть письма с цитатой исходного письма (раздел переписки).
// Почтовые клиенты вставляют цитату после разделителя вида:
//   «Ответ ВАШЕ ПИСЬМО», «On … you wrote:», «----------», «Начало переписки»
// Возвращает текст после разделителя. Если разделитель не найден — весь текст.
function extractReplyQuote(text) {
  const t = String(text || '');
  const markers = [
    /Ответ\s+ВАШЕ\s+ПИСЬМО/i,
    /Ответ\s+на\s+Ваше\s+письмо/i,
    /On\s+[^,]{1,120}you\s+wrote\s*:/i,
    /Начало\s+переписки/i,
    /Begin\s+forwarded\s+message/i,
    /--------\s*(?:--------)*\s*$/mi,
    /^\s*[>\s]*-{3,}\s*$/mi
  ];
  let best = -1;
  for (const re of markers) {
    const m = t.match(re);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  if (best === -1) return t;
  // берём кусок от разделителя до конца (собственно цитата исходного письма)
  return t.slice(best);
}

// Вернуть «свежую» часть письма — текст БЕЗ цитаты переписки.
// Ключевые слова статуса ищутся только здесь: слово из процитированного
// старого письма не должно менять статус (защита от ложных срабатываний).
// Разделитель цитаты определяется теми же маркерами, что и в extractReplyQuote.
function freshBody(text) {
  const t = String(text || '');
  const markers = [
    /Ответ\s+ВАШЕ\s+ПИСЬМО/i,
    /Ответ\s+на\s+Ваше\s+письмо/i,
    /On\s+[^,]{1,120}you\s+wrote\s*:/i,
    /Начало\s+переписки/i,
    /Begin\s+forwarded\s+message/i,
    /--------\s*(?:--------)*\s*$/mi,
    /^\s*[>\s]*-{3,}\s*$/mi
  ];
  let best = -1;
  for (const re of markers) {
    const m = t.match(re);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  if (best === -1) return t;
  return t.slice(0, best);
}

// Отобрать письма для конкретного правила по полю sender.
// senderMode 'exclude' — sender трактуется как исключение (не обрабатывать),
// иначе (по умолчанию 'filter') — как инклюзивный фильтр (только эта почта).
// excludeEmails (legacy) всегда исключает. Возвращает отфильтрованный массив.
function filterRuleEmails(emails, rule) {
  const senderFilter = rule.sender ? String(rule.sender).trim().toLowerCase() : '';
  const senderMode = rule.senderMode === 'exclude' ? 'exclude' : 'filter';
  const exclude = [...(rule.excludeEmails || [])]
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean);
  if (senderMode === 'exclude' && senderFilter) exclude.push(senderFilter);
  return emails.filter((em) => {
    const fromL = String(em.from || '').toLowerCase();
    if (senderMode !== 'exclude' && senderFilter && !fromL.includes(senderFilter)) return false;
    return !exclude.some((ex) => fromL.includes(ex));
  });
}

// Один цикл синхронизации: письма Яндекса -> статусы по независимым правилам.
async function runSync(settings) {
  const report = { checked: 0, matched: 0, written: 0, successLetters: 0, emails: [], notFound: [], errors: [], need: [] };
  const mail = settings.mail || {};
  const table = settings.table || {};
  const rulesArr = (settings.rules && settings.rules.items) || [];

  // Отмечаем, что пользователь должен донастроить, чтобы цикл реально работал.
  // Это человекочитаемая «структура» причины пропуска.
  if (!mail.enabled) report.need.push('Включите блок «Яндекс Почта»');
  if (mail.enabled && !mail.user) report.need.push('Укажите логин Яндекс Почты');
  if (mail.enabled && !mail.password) report.need.push('Укажите app-пароль Яндекс Почты');
  if (!table.enabled) report.need.push('Включите блок «Google Таблица»');
  if (table.enabled && !table.spreadsheetId) report.need.push('Укажите ID Google Таблицы');
  if (table.enabled && table.spreadsheetId && !table.serviceAccountJson && !table.apiKey) {
    report.need.push('Загрузите JSON сервисного аккаунта (или API-ключ)');
  }
  if (table.enabled && table.spreadsheetId && rulesArr.length === 0) {
    report.need.push('Добавьте хотя бы одно правило (03 или 03b)');
  }
  // Письма читаем только когда есть хотя бы одно ВКЛЮЧЁННОЕ правило:
  // при выключенных ползунках обрабатывать письма нечем, и читать почту незачем.
  if (rulesArr.length > 0 && !rulesArr.some((r) => r.enabled !== false)) {
    report.need.push('Включите хотя бы одно правило (переключатель «включено»)');
  }

  if (!mail.enabled) return { ...report, skipped: 'mail-disabled' };
  if (!mail.user || !mail.password) return { ...report, skipped: 'mail-not-configured' };
  if (!table.enabled || (!table.spreadsheetId)) return { ...report, skipped: 'table-not-configured' };
  if (rulesArr.length === 0) return { ...report, skipped: 'no-rules' };
  // Все правила выключены — не читаем почту и не трогаем таблицу.
  if (!rulesArr.some((r) => r.enabled !== false)) return { ...report, skipped: 'no-enabled-rules' };

  const client = new ImapClient({
    host: mail.host,
    port: mail.port,
    user: mail.user,
    password: mail.password,
    folder: mail.folder,
    timeout: 30000
  });

  try {
    await client.connect();
    await client.login();
    const emails = await client.fetchNewEmails(null); // все непрочитанные; фильтруем по правилам
    report.checked = emails.length;

    // Письма, по которым статус успешно записан, — их пометим прочитанными.
    // Остальные (не удалось поменять статус) оставляем непрочитанными,
    // чтобы они были обработаны повторно в следующем цикле.
    const markedRead = [];
    // перемещение успешно обработанных писем в папки (по moveRules)
        const moveRules = settings.moveRules || {};
        const moveSpecific = [];
        const moveOther = [];
        const movedSeen = new Set(); // защита от дублирования перемещения письма
        const specificSender = moveRules.specificSender ? String(moveRules.specificSender).trim().toLowerCase() : '';

    // Каждое правило обрабатывается независимо: свой отправитель, лист, столбцы.
    for (const rule of rulesArr) {
      if (rule.enabled === false) continue; // отключённое правило пропускаем
      const sheetName = rule.sheetName || table.sheetName || 'Sheet1';
      const articleCol = (rule.articleCol || 'A').toUpperCase();
      const statusCol = (rule.statusCol || 'B').toUpperCase();
      const pattern = rule.articlePattern ? String(rule.articlePattern).trim() : '';
      // Правило 03 («Правила обработки ответов Сферы») не использует сверку по
      // «Номеру инвойса» — принудительно отключаем её, даже если столбец задан.
      const _invoiceCol = rule.invoiceCol ? String(rule.invoiceCol).trim().toUpperCase() : '';
      const invoiceCol = (rule.name && String(rule.name).trim() === 'Правило 03') ? '' : _invoiceCol;
      const invoicePattern = rule.invoicePattern ? String(rule.invoicePattern).trim() : '';
      // Столбец «Причина» — жёсткая сверка по правилу 03 (дополнительно к артикулу).
      const reasonCol = rule.reasonCol ? String(rule.reasonCol).trim().toUpperCase() : '';
      // Столбец «Лого поставщика» — жёсткая сверка по правилу 03 (доп. к артикулу/причине).
      const logoCol = rule.logoCol ? String(rule.logoCol).trim().toUpperCase() : '';
      const quoteMode = rule.quoteMode === true;

      const ruleEmails = filterRuleEmails(emails, rule);
      if (!ruleEmails.length) continue;

      // свой SheetsClient со своим листом
      const sheets = new SheetsClient({
        spreadsheetId: table.spreadsheetId,
        sheetName,
        articleCol,
        statusCol,
        headerRow: table.headerRow || 1,
        authMethod: table.authMethod,
        serviceAccountJson: table.serviceAccountJson,
        apiKey: table.apiKey
      });
      const rows = await sheets.readArticles();
      // Индекс по колонке артикула строится ОДИН раз на весь снимок таблицы,
      // а не на каждое письмо (экономия на большой таблице/многих письмах).
      const articleIndex = buildArticleIndex(rows, articleCol, table.headerRow || 1);

      for (const email of ruleEmails) {
        // В режиме quoteMode артикул/инвойс ищем в цитате ИСХОДНОГО письма
        // (ниже разделителя переписки), а не в новом тексте ответа.
        const parseBody = quoteMode ? extractReplyQuote(email.body) : email.body;
        const labeledArticle = extractValueByLabel(parseBody, ['Артикул', 'Артикул товара', 'Part number']);
        let article = null;
        let articleSource = null;
        if (labeledArticle) {
          article = labeledArticle;
          articleSource = 'label';
        } else if (quoteMode) {
          // В quoteMode артикул берём ТОЛЬКО из структурированного поля
          // «Артикул: …» в цитате исходного письма — без авто-угадывания по
          // мусору/теме (иначе ложные срабатывания на base64-строках).
          article = null;
          articleSource = null;
        } else {
          const fb = extractArticleFromEmail(email.subject, email.body, pattern);
          article = fb.article;
          articleSource = fb.source;
        }
        // Номер инвойса из письма (нужен только если задан столбец инвойса)
        let invoiceFound = { invoice: null, source: null };
        if (invoiceCol) {
          // Приоритет: «Верный номер документа - ХХХ» — исправленный номер в
          // ответе (может стоять над разделителем цитаты). Он важнее исходного
          // «Номер инвойса:» из цитаты.
          const correctDoc = extractValueByLabel(email.body, ['Верный номер документа']);
          if (correctDoc) {
            invoiceFound = { invoice: correctDoc, source: 'correct-doc' };
          } else {
            const labeledInvoice = extractValueByLabel(parseBody, ['Номер инвойса', 'Инвойс', 'Номер счёта', 'Invoice number', 'Invoice']);
            if (labeledInvoice) {
              invoiceFound = { invoice: labeledInvoice, source: 'label' };
            } else if (quoteMode) {
              // В quoteMode инвойс берём только из поля «Номер инвойса:» в цитате.
              invoiceFound = { invoice: null, source: null };
            } else {
              invoiceFound = extractInvoiceFromEmail(email.subject, email.body, invoicePattern);
            }
          }
        }
        const invoice = invoiceFound.invoice;
        const invoiceSource = invoiceFound.source;
        // Причина и лого поставщика из письма — для жёсткой сверки (правило 03).
        let reason = null;
        let logo = null;
        if (reasonCol || logoCol) {
          const topic = extractApprovalReason(email.subject);
          // Тема в формате «Согласование [<лого>] - <артикул> - <причина>» —
          // артикул берём именно из темы (она надёжнее эвристик в этом случае).
          if (topic.isApproval && topic.article) {
            article = topic.article;
            articleSource = 'subject';
          }
          // Лого берём ТОЛЬКО из темы (первая секция), причина — из темы/тела.
          logo = logoCol ? extractLogoFromEmail(email.subject) : null;
          reason = reasonCol ? extractReasonFromEmail(email.subject, email.body) : null;
        }
        // Ключевые слова статуса ищем в «свежей» части письма (без цитаты
        // переписки), чтобы слово из процитированного старого письма не меняло
        // статус по ошибке (защита от ложных срабатываний).
        const { status, matched } = determineStatusDetail(freshBody(email.body), rule.keywords);
        const bodyText = String(email.body || '');
        // Максимальная длина превью тела, попадающего в журнал (для диагностики).
        const BODY_PREVIEW_MAX = 2000;
        report.matched++;
        const detail = {
          rule: rule.name || 'правило',
          subject: email.subject,
          subjectRaw: email.subjectRaw || '',
          from: email.from,
          bodyPreview: bodyText.slice(0, BODY_PREVIEW_MAX),
          bodyHasMore: bodyText.length > BODY_PREVIEW_MAX,
          bodyRawHeads: (email.bodyRawHeads || []).slice(0, 3),
          article: article || null,
          articleSource: articleSource || null,
          invoice: invoice || null,
          invoiceSource: invoiceSource || null,
          invoiceCol: invoiceCol || null,
          reason: reason || null,
          reasonCol: reasonCol || null,
          logo: logo || null,
          logoCol: logoCol || null,
          pattern: pattern || null,
          matched: matched || null,
          status: status || null,
          row: null,
          articleCol,
          statusCol,
          sheetName,
          outcome: null
        };
        // В режиме quoteMode: если цитируемого сообщения с артикулом (и нужным
        // инвойсом) нет — письмо пропускаем, не меняя статус.
        const needInvoice = quoteMode && invoiceCol && !invoice;
        const needArticle = quoteMode && !article;
        if (needArticle || needInvoice) {
          const why = [];
          if (needArticle) why.push('нет артикула в цитате исходного письма');
          if (needInvoice) why.push('нет номера инвойса в цитате исходного письма');
          detail.outcome = why.join(' и ') + ' — письмо пропущено (статус не меняется)';
          report.notFound.push({ rule: rule.name, subject: email.subject, reason: why.join('; ') });
          report.emails.push(detail);
          continue;
        }
        if (!article) {
          detail.outcome = 'нет артикула — письмо осталось непрочитанным';
          report.notFound.push({ rule: rule.name, subject: email.subject, reason: 'нет артикула' });
          report.emails.push(detail);
          continue;
        }
        const matches = findAllRowsForArticleIndexed(articleIndex, article);
        detail.how = matches.length ? matches[0].how : null;
        if (matches.length === 0) {
          detail.columnSample = columnValues(rows, articleCol, table.headerRow || 1, 12);
          detail.outcome = 'артикул не найден в таблице — письмо осталось непрочитанным';
          report.notFound.push({ rule: rule.name, article, subject: email.subject, reason: 'артикул не найден' });
          report.emails.push(detail);
          continue;
        }

        // Проверка текущего статуса + запись для КАЖДОЙ найденной строки
        // (дубликатов артикула может быть несколько). Меняем только те,
        // у кого текущий статус равен условию (triggerStatus).
        const trigger = (rule.triggerStatus ? String(rule.triggerStatus).trim().toLowerCase() : 'запрос клиента');
        const statusColIdx = columnLetterToIndex(statusCol);
        // Сверка по номеру инвойса: если задан столбец инвойса, статус меняется
        // только когда номер инвойса в строке совпал с номером из письма.
        const invoiceColIdx = invoiceCol ? columnLetterToIndex(invoiceCol) : null;
        detail.writtenStatuses = [];
        detail.skippedStatuses = [];
        detail.invoiceMismatch = [];
        detail.reasonMismatch = [];
        detail.logoMismatch = [];
        const reasonColIdx = reasonCol ? columnLetterToIndex(reasonCol) : null;
        const logoColIdx = logoCol ? columnLetterToIndex(logoCol) : null;
        if (status) {
          for (const m of matches) {
            const rowIndex = m.row;
            const dataRow = rows[rowIndex - 1] || [];
            // Сверка инвойса: если колонка задана, но письмо не содержит номера —
            // строку не меняем.
            if (invoiceColIdx !== null) {
              const rowInvoice = dataRow[invoiceColIdx] !== undefined && dataRow[invoiceColIdx] !== null
                ? String(dataRow[invoiceColIdx]).trim()
                : '';
              const emailInvoice = String(invoice || '').trim();
              if (!emailInvoice || !rowInvoice || rowInvoice.toLowerCase() !== emailInvoice.toLowerCase()) {
                detail.invoiceMismatch.push('строка ' + rowIndex +
                  ' (инвойс «' + (rowInvoice || 'пусто') + '» ≠ «' + (emailInvoice || 'не найден в письме') + '»)');
                continue; // инвойс не совпал — эту строку не трогаем
              }
            }
            // Сверка лого поставщика (правило 03) — мягкая: блокируем строку
            // только когда лого есть в письме и не совпало со строкой. Письма
            // БЕЗ лого (например «Согласование - артикул - причина») по лого
            // не отсеиваются.
            const emailLogo = String(logo || '').trim();
            if (logoColIdx !== null && emailLogo) {
              const rowLogo = dataRow[logoColIdx] !== undefined && dataRow[logoColIdx] !== null
                ? String(dataRow[logoColIdx]).trim()
                : '';
              if (!rowLogo || rowLogo.toLowerCase() !== emailLogo.toLowerCase()) {
                detail.logoMismatch.push('строка ' + rowIndex +
                  ' (лого «' + (rowLogo || 'пусто') + '» ≠ «' + (emailLogo || 'не найдено в письме') + '»)');
                continue; // лого не совпало — эту строку не трогаем
              }
            }
            // Сверка причины (правило 03): если задан столбец причины, статус
            // меняется только когда причина в строке совпала с причиной из письма.
            if (reasonColIdx !== null) {
              const rowReason = dataRow[reasonColIdx] !== undefined && dataRow[reasonColIdx] !== null
                ? String(dataRow[reasonColIdx]).trim()
                : '';
              const emailReason = String(reason || '').trim();
              const normRow = normalizeComparePhrase(rowReason);
              const normEmail = normalizeComparePhrase(emailReason);
              if (!normEmail || !normRow || normRow !== normEmail) {
                detail.reasonMismatch.push('строка ' + rowIndex +
                  ' (причина «' + (rowReason || 'пусто') + '» ≠ «' + (emailReason || 'не найдена в письме') + '»)');
                continue; // причина не совпала — эту строку не трогаем
              }
            }
            const current = dataRow[statusColIdx] !== undefined && dataRow[statusColIdx] !== null
              ? String(dataRow[statusColIdx]).trim()
              : '';
            if (trigger && current.toLowerCase() === trigger) {
              await sheets.writeStatus(rowIndex, status, statusCol);
              report.written++;
              detail.writtenStatuses.push('строка ' + rowIndex);
              markedRead.push(email.seq);
              report.successLetters++;
              // Правило 06 «Перемещение писем»: письмо с успешно записанным статусом
              // направляем в соответствующую папку (успешно обработанные → «Обработано»).
              if (moveRules.enabled && !movedSeen.has(email.seq)) {
                movedSeen.add(email.seq);
                const fromL = String(email.from || '').toLowerCase();
                if (specificSender) {
                  if (fromL.includes(specificSender)) moveSpecific.push(email.seq);
                  else moveOther.push(email.seq);
                } else {
                  // «Определённая почта» не задана — все успешно обработанные
                  // письма перемещаем в папку «Обработано» (folderSpecific).
                  moveSpecific.push(email.seq);
                }
              }
            } else {
              detail.skippedStatuses.push('строка ' + rowIndex + ' («' + (current || 'пусто') + '»)');
            }
          }
          if (detail.writtenStatuses.length) {
            detail.row = detail.writtenStatuses.join(', ');
            detail.outcome = 'записано: ' + status + ' в ' + detail.writtenStatuses.join(', ') +
              (detail.skippedStatuses.length ? ' | пропущено: ' + detail.skippedStatuses.join('; ') : '') +
              (detail.invoiceMismatch.length ? ' | инвойс не совпал: ' + detail.invoiceMismatch.join('; ') : '') +
              (detail.logoMismatch.length ? ' | лого не совпало: ' + detail.logoMismatch.join('; ') : '') +
              (detail.reasonMismatch.length ? ' | причина не совпала: ' + detail.reasonMismatch.join('; ') : '');
          } else {
            detail.row = matches.map((m) => m.row).join(', ');
            const parts = [];
            if (detail.invoiceMismatch.length) parts.push('номер инвойса не совпал (' + detail.invoiceMismatch.join('; ') + ')');
            if (detail.logoMismatch.length) parts.push('лого не совпало (' + detail.logoMismatch.join('; ') + ')');
            if (detail.reasonMismatch.length) parts.push('причина не совпала (' + detail.reasonMismatch.join('; ') + ')');
            if (detail.skippedStatuses.length) parts.push('текущий статус ≠ «' + (rule.triggerStatus || 'Запрос клиента') + '» (' + detail.skippedStatuses.join('; ') + ')');
            detail.outcome = (parts.length ? parts.join('; ') : 'статус не подошёл') + ' — не меняем, письмо осталось непрочитанным';
          }
        } else {
          detail.row = matches.map((m) => m.row).join(', ');
          detail.outcome = 'статус не определён (нет ключевого слова) — письмо осталось непрочитанным';
        }
        report.emails.push(detail);
      }
    }

    // Помечаем прочитанными только письма, где статус реально обновился,
    // и только если в настройках включено «Отмечать прочитанным».
    if (mail.markSeen && markedRead.length) {
      try { await client.markSeen(markedRead); } catch (e) {}
    }

    // Перемещение успешно обработанных писем в папки (если включено).
    if (moveRules.enabled) {
      try {
        if (moveSpecific.length && moveRules.folderSpecific) {
          await client.move(moveSpecific, moveRules.folderSpecific);
          report.movedSpecific = moveSpecific.length;
        }
        if (moveOther.length && moveRules.folderOther) {
          await client.move(moveOther, moveRules.folderOther);
          report.movedOther = moveOther.length;
        }
      } catch (e) {
        report.errors.push('Перемещение: ' + e.message);
      }
    }
  } catch (e) {
    report.errors.push(e.message || String(e));
  } finally {
    client.close();
  }
  return report;
}

// Правило проверки таблицы: по интервалу (независимо от писем) меняет значения
// в столбце-приёмнике, если в столбце-источнике соответствует правилу.
async function runCheckTable(settings) {
  const report = { checked: 0, written: 0, matches: 0, errors: [], need: [], point5Rows: [] };
  const table = settings.table || {};
  const ct = settings.checkTable || {};

  if (!ct.enabled) return { ...report, skipped: 'check-table-disabled' };
  if (!table.enabled || !table.spreadsheetId) return { ...report, skipped: 'table-not-configured' };
  if (!table.serviceAccountJson && !table.apiKey) {
    report.need.push('Загрузите JSON сервисного аккаунта (или API-ключ)');
    return { ...report, skipped: 'creds-missing' };
  }
  const rules = ct.rules || [];
  const sheets = new SheetsClient({
    spreadsheetId: table.spreadsheetId,
    sheetName: ct.sheetName || 'Sheet1',
    articleCol: (ct.sourceCol || 'A').toUpperCase(),
    statusCol: (ct.targetCol || 'B').toUpperCase(),
    headerRow: table.headerRow || 1,
    authMethod: table.authMethod,
    serviceAccountJson: table.serviceAccountJson,
    apiKey: table.apiKey
  });

  try {
    const rows = await sheets.readArticles();
    const sourceIdx = columnLetterToIndex((ct.sourceCol || 'A').toUpperCase());
    const defaultTargetIdx = columnLetterToIndex((ct.targetCol || 'B').toUpperCase());
    const start = table.headerRow || 1;

    for (let r = start; r < rows.length; r++) {
      const row = rows[r] || [];
      const sourceVal = row[sourceIdx] !== undefined && row[sourceIdx] !== null
        ? String(row[sourceIdx]).trim()
        : '';
      report.checked++;
      // Настраиваемые правила «Проверки таблицы» отключены: сейчас проверка
      // должна применять ТОЛЬКО «Пункт 5» (ставить «Согласован» в J), а не менять
      // J на «Одобрен поставщиком» через настраиваемое правило.
      const colJ = 9;   // J — 10-я колонка (0-based 9)
      const colK = 10;  // K — 11-я колонка (0-based 10)
      const valK = row[colK] !== undefined && row[colK] !== null ? String(row[colK]).trim() : '';
      const valJ = row[colJ] !== undefined && row[colJ] !== null ? String(row[colJ]).trim() : '';
      if (valK.toLowerCase() === 'отказ' && valJ.toLowerCase() === 'одобрен поставщиком') {
        if (valJ !== 'Согласован') {
          await sheets.writeStatus(r + 1, 'Согласован', 'J');
          report.written++;
          report.point5Rows.push(r + 1);
        }
        report.matches++;
      }
    }
  } catch (e) {
    report.errors.push(e.message || String(e));
  }
  return report;
}

module.exports = { runSync, runCheckTable, determineStatus, determineStatusDetail, extractArticle, extractArticleFromEmail, extractInvoiceFromEmail, extractValueByLabel, extractReplyQuote, freshBody, filterRuleEmails, extractApprovalReason, extractReasonFromEmail, extractLogoFromEmail };
