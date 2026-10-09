// Детерминированный анализатор текста письма: сопоставление с правилами
// {keywords, status}. Без внешних нейросетей — только точные, предсказуемые
// эвристики, поэтому результат воспроизводим и «правило сработало/нет» можно
// объяснить и проверить.
//
// Слои поиска (по приоритету, без ложных срабатываний на коротких словах):
//   1) Точное совпадение ключа как ОТДЕЛЬНОГО слова/фразы (границы слова).
//   2) Совпадение по основе: слово в тексте начинается с ключа (или ключ
//      начинается со слова) при длине основы >= 4 — ловит падежи и глаголы
//      («отказ» -> «отказа», «отказы», «отказался»).
//   3) Нечёткое совпадение (правки Левенштейна) для слов длиной >= 4 — ловит
//      опечатки в 1–2 буквы.

// Кэш предкомпилированного разбора для списка правил.
const _ruleCache = new Map();

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

// Отделить «букву/цифру/подчёркивание» — признак того, что символ входит в слово.
function isWordChar(ch) {
  return !!ch && /[a-zа-яё0-9_]/.test(ch);
}

// Разбить текст на слова (токены), сохраняя их как есть (в lower).
function tokenize(hay) {
  // Сначала разобьём на «слова» регуляркой, чтобы найти точные вхождения.
  return hay.split(/[^a-zа-яё0-9_]+/).filter((t) => t !== '');
}

// Расстояние Левенштейна (по одной букве).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = new Array(m + 1);
  for (let i = 0; i <= m; i++) { d[i] = new Array(n + 1); d[i][0] = i; }
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

// Максимум допустимых правок для нечёткого совпадения (1–2 для длинных слов).
function maxEdits(len) {
  if (len >= 10) return 2;
  if (len >= 6) return 2;
  if (len >= 5) return 1;
  return 0; // слова короче — только точное/по основе
}

// Собрать массив «слов» из правила после нормализации.
// Фраза из нескольких слов матчится как подстрока с границами; одно слово —
// по всем слоям.
function ruleWords(raw) {
  const s = normalize(raw);
  return s.split(/\s+/).filter((t) => t !== '');
}

// Есть ли в тексте точное вхождение фразы с границами слова.
function phraseExact(hay, phrase) {
  let i = hay.indexOf(phrase);
  while (i !== -1) {
    const before = i > 0 ? hay[i - 1] : '';
    const after = i + phrase.length < hay.length ? hay[i + phrase.length] : '';
    if (!isWordChar(before) && !isWordChar(after)) return true;
    i = hay.indexOf(phrase, i + 1);
  }
  return false;
}

// Совпадение одного слова по всем слоям: точное, по основе, нечёткое.
function wordMatches(token, kw) {
  if (token === kw) return true;
  // По основе: одно начинается с другого, длина основы >= 4
  const min = Math.min(token.length, kw.length);
  if (min >= 4) {
    const prefixLeft = token.startsWith(kw);
    const prefixRight = kw.startsWith(token);
    if (prefixLeft && !isProcessWord(token, kw)) return true;
    if (prefixRight && !isProcessWord(kw, token)) return true;
    // Префиксная связь есть, но признана «процессом» — совпадения НЕТ,
    // и нечёткий слой ниже не должен перебить это (одно из слов — форма
    // процесса, а не результат).
    if (prefixLeft || prefixRight) return false;
  }
  // Нечёткое
  const edits = maxEdits(kw.length);
  if (edits > 0 && kw.length >= 5 && token.length >= 5) {
    if (levenshtein(token, kw) <= edits) return true;
  }
  return false;
}

// Проверить, что производное слово (token) — «процесс/действие», а не
// «результат», для ключевого слова kw (оба начинаются с одной основы).
// Нужно, чтобы «согласование»/«на согласовании» не считалось одобрением
// по ключу «согласован» (согласован = результат, согласование = процесс).
function isProcessWord(token, kw) {
  const suffix = token.slice(kw.length);
  if (!suffix) return false; // точная основа — результат
  // Отглагольное существительное «процесса»: суффикс после основы начинается
  // с «и» и длиннее 1 (ие, ия, ии, ию, ий) — «согласование», «согласовании».
  // Это НЕ результат. Глагольные формы («отказался», «согласовано»,
  // «согласована») не начинаются с «и» — они остаются совпадениями.
  if (suffix.length >= 2 && suffix[0] === 'и') return true;
  return false;
}

// Определить статус. Возвращает { status, matched } или { status:null, matched:null }.
function determineStatusDetail(body, keywordsArr) {
  const items = keywordsArr || [];
  const hay = normalize(body);
  if (!hay) return { status: null, matched: null };
  const tokens = new Set(tokenize(hay));

  for (const rule of items) {
    const kws = (rule.keywords || []).filter(Boolean);
    if (!kws.length) continue;
    for (const kw of kws) {
      const words = ruleWords(kw);
      if (words.length === 0) continue;

      // Фраза из нескольких слов — ищем точную фразу с границами.
      if (words.length > 1) {
        const phrase = words.join(' ');
        if (phraseExact(hay, phrase)) {
          return { status: rule.status, matched: kw };
        }
        continue; // многословный ключ не пытаемся «сближать» по частям
      }

      // Одно слово — по всем слоям.
      const w = words[0];
      if (tokens.has(w)) return { status: rule.status, matched: kw };
      // Слой «по основе» и «нечётко» — перебираем токены.
      for (const tok of tokens) {
        if (wordMatches(tok, w)) {
          return { status: rule.status, matched: kw };
        }
      }
    }
  }
  return { status: null, matched: null };
}

// Обратная совместимость: только статус.
function determineStatus(body, rules) {
  return determineStatusDetail(body, rules).status;
}

module.exports = { determineStatusDetail, determineStatus, levenshtein, normalize };
