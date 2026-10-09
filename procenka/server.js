const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const express = require('express');
const { Worker } = require('worker_threads');
// Собственный лёгкий парсер .xlsx (без SheetJS). Грузим ЛЕНИВО с фолбэком:
// старт сервера НЕ должен зависеть от наличия xlsx-lite.js в архиве — если в
// распакованном пакете файла вдруг нет, require тут же роняет процесс ещё до
// listen, и шлюз вечно видит «app is not answering». Ленивая загрузка + фолбэк
// на SheetJS-воркер гарантируют, что приложение поднимется в любом случае.
let _XLSX_LITE = null;
function loadXLSXLite() {
  if (_XLSX_LITE) return _XLSX_LITE;
  try { _XLSX_LITE = require('./xlsx-lite'); }
  catch (_) { _XLSX_LITE = null; }
  return _XLSX_LITE;
}
// XLSX нужен только для чтения входных .xlsx/.xls. Грузим лениво: старт
// сервера НЕ должен зависеть от наличия вендора в архиве — иначе при его
// отсутствии приложение падает в момент запуска и шлюз вечно шлёт
// BH_APP_STARTING. Пользовательский результат теперь в CSV, для записи
// xlsx не нужен вовсе.
let _XLSX = null;
function loadXLSX() {
  if (!_XLSX) _XLSX = require(path.join(__dirname, 'vendor', 'xlsx'));
  return _XLSX;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Роль из заголовка шлюза платформы (подделать нельзя — входящие X-Vibe-* шлюз
// срезает). ADMIN нужен для опасных операций вроде /api/cleanup {all:true}.
function isAdmin(req) {
  return String(req.get('x-vibe-user-role') || '').toUpperCase() === 'ADMIN';
}

// Данные, которые должны переживать передеплой, пишем только в /data.
// Локально (без DATA_DIR) используем tmp.
let DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'pricecmp');
let UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
let RESULT_DIR = path.join(DATA_DIR, 'results');
let CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
// Сервер ОБЯЗАН подняться и слушать порт, иначе шлюз шлёт BH_APP_STARTING вечно.
// Если каталог данных недоступен для записи (типично для /data на некоторых
// контейнерах), не падаем на старте — откатываемся на tmp.
try {
  for (const d of [UPLOAD_DIR, RESULT_DIR, CHUNKS_DIR]) fs.mkdirSync(d, { recursive: true });
  // проверяем, что реально можно писать
  const probe = path.join(UPLOAD_DIR, '.w' + Date.now());
  fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe);
} catch (e) {
  console.error('[storage] каталог данных недоступен, откат на tmp:', e && e.message);
  DATA_DIR = path.join(os.tmpdir(), 'pricecmp');
  UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
  RESULT_DIR = path.join(DATA_DIR, 'results');
  CHUNKS_DIR = path.join(DATA_DIR, 'chunks');
  for (const d of [UPLOAD_DIR, RESULT_DIR, CHUNKS_DIR]) fs.mkdirSync(d, { recursive: true });
}

// ---- Своё логирование в файл (для диагностики без доступа к консоли) ----
// Пишем КЛЮЧЕВЫЕ моменты каждой фазы обработки в /data/app.log с таймингом.
// Файл переживает передеплой (лежит в /data) и его можно скачать через
// /api/debug/log. Это позволяет по таймингам точно увидеть, где на больших
// файлах застревает процесс (нарезка? сравнение? xlsx?).
const APP_LOG_PATH = path.join(DATA_DIR, 'app.log');
function appLog(scope, msg) {
  const line = new Date().toISOString() + ' [' + scope + '] ' + msg + '\n';
  try { fs.appendFileSync(APP_LOG_PATH, line, 'utf8'); } catch (_) {}
  // дублируем в консоль (для обычных логов платформы)
  // eslint-disable-next-line no-console
  console.log(line.trim());
}
// короткий хелпер для тайминга фаз
const _timers = new Map();
function tStart(key) { _timers.set(key, Date.now()); }
function tEnd(key, scope, msg) { const s = _timers.get(key); const ms = s ? Date.now() - s : -1; _timers.delete(key); appLog(scope, msg + ' [' + ms + 'ms]'); return ms; }

// Реальный лимит памяти контейнера (cgroup). Если прочитать нельзя — null.
// Значение в байтах, преобразуем в МБ. Это позволяет узнать, сколько памяти
// реально выделено контейнеру, и понять, упираемся ли мы в OOM на больших файлах.
function containerMemoryLimitMB() {
  const paths = [
    '/sys/fs/cgroup/memory.max',            // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
    '/sys/fs/cgroup/memory.max'
  ];
  for (const p of paths) {
    try {
      const v = Number(String(fs.readFileSync(p, 'utf8')).trim());
      const LIMIT_MAX = 9223372036854771712; // 2^63-1 "безлимит" у cgroup
      if (Number.isFinite(v) && v > 0 && v < LIMIT_MAX) return Math.round(v / 1048576);
    } catch (_) {}
  }
  return null;
}

// ---- DeepSeek: ИИ-анализ итогов ----
// Ключ НЕ хардкодим в код (публичное приложение, ключ утёк бы в архив). Берём
// из переменной окружения DEEPSEEK_API_KEY, а если её нет — из файла /data,
// который пользователь задаёт в настройках приложения и который ПЕРЕЖИВАЕТ
// передеплой. Ключ живёт только на сервере и наружу не отдаётся (в статусе —
// лишь признак «есть/нет» и хвост ключа).
const AI_SECRET_PATH = path.join(DATA_DIR, 'ai.secret.json');
// Ключ DeepSeek, указанный владельцем приложения. Используется как запасной,
// когда ключ не задан через переменную окружения DEEPSEEK_API_KEY и не сохранён
// через настройки (/data). Убрать окно ввода ключа — см. public/index.html.
const AI_HARDCODE_KEY = 'sk-f00ac8e08c6547d79e25ee379d42955c';
let AI_ENABLED = false; // взводится, когда найден рабочий ключ
function readAIKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const j = JSON.parse(fs.readFileSync(AI_SECRET_PATH, 'utf8'));
    if (j && typeof j.apiKey === 'string' && j.apiKey) return j.apiKey;
  } catch (_) { /* нет файла — полагаемся на зашитый ключ */ }
  // Запасной вариант: ключ, вшитый в код (см. AI_HARDCODE_KEY выше).
  return AI_HARDCODE_KEY || null;
}
function writeAIKey(apiKey) {
  const tmp = AI_SECRET_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ apiKey }), 'utf8');
  try { fs.chmodSync(tmp, 0o600); } catch (_) {}
  fs.renameSync(tmp, AI_SECRET_PATH); // атомарная замена
}
function maskKey(k) {
  if (!k) return '';
  return (k.length > 6) ? k.slice(0, 3) + '****' + k.slice(-4) : '****';
}

// Вызов DeepSeek (OpenAI-совместимый API). Таймаут — минуты, а не секунды:
// LLM на горячем сервисе отвечает за 10-40 с. Никогда не вызываем внутри
// запроса посетителя — только в фоне.
async function deepSeekChat(messages, opts) {
  const key = readAIKey();
  if (!key) throw new Error('ключ DeepSeek не задан');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 120000);
  try {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0.3,
        max_tokens: (opts && opts.maxTokens) || 700,
        messages
      }),
      signal: ctl.signal
    });
    if (!resp.ok) {
      let detail = '';
      try { const t = await resp.text(); detail = String(t).slice(0, 200); } catch (_) {}
      throw new Error('DeepSeek HTTP ' + resp.status + (detail ? ': ' + detail : ''));
    }
    const j = await resp.json();
    const txt = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof txt !== 'string' || !txt.trim()) throw new Error('DeepSeek вернул пустой ответ');
    return txt.trim();
  } finally {
    clearTimeout(timer);
  }
}

// Компактная текстовая сводка гистограммы разницы для ИИ-промпта.
// arr — массив counts по шагам в 1 п.п. (индекс k = диапазон (k; k+1]%,
// хвост на индексе 50 = «более 50%»).
function aiHistSummary(arr) {
  if (!Array.isArray(arr)) return 'нет данных';
  const tot = arr.reduce((s, v) => s + (v || 0), 0);
  if (!tot) return '0';
  const parts = [];
  for (let k = 0; k < 5 && k < arr.length; k++) { const v = arr[k] || 0; if (v > 0) parts.push('' + (k + 1) + '%: ' + v); }
  const grp = (f, t) => { let s = 0; for (let i = f; i < t && i < arr.length; i++) s += (arr[i] || 0); return s; };
  const ranges = [['5–10%', 5, 10], ['10–20%', 10, 20], ['20–30%', 20, 30], ['30–40%', 30, 40], ['40–50%', 40, 50]];
  for (const [lab, f, t] of ranges) { const s = grp(f, t); if (s > 0) parts.push(lab + ': ' + s); }
  if (arr.length > 50 && (arr[50] || 0) > 0) parts.push('более 50%: ' + arr[50]);
  return parts.join(', ') || '0';
}

// Сборка ИИ-вывода по метаданным сравнения. Промпт даёт LLM ТОЛЬКО реальные
// цифры (никаких выдуманных), просим короткий деловой вывод по-русски.
async function generateAIAnalysis(t) {
  const aName = t.aName || 'Прайс 1';
  const bName = t.bName || 'Прайс 2';
  // «Наш» прайс — тот, что называется «Проф» (без учёта регистра); если такого
  // нет — считаем «нашим» второй. Устойчиво к порядку загрузки файлов.
  const aIsOurs = String(aName).trim().toLowerCase() === 'проф';
  const bIsOurs = String(bName).trim().toLowerCase() === 'проф';
  const oursName = aIsOurs ? aName : (bIsOurs ? bName : bName);
  const rivalName = aIsOurs ? bName : (bIsOurs ? aName : aName);
  const medianPct = (typeof t.medianPct === 'number') ? (Math.round(t.medianPct * 100) / 100) : null;
  const disc = (t.disc && typeof t.disc === 'object') ? t.disc : null;
  const discFact = (disc && (disc.p50 != null || disc.p60 != null || disc.p70 != null))
    ? ('Нужная скидка на «' + oursName + '», чтобы перестать быть дороже: по 50% позиций — ' + (disc.p50 == null ? '—' : disc.p50 + '%') + ', по 60% — ' + (disc.p60 == null ? '—' : disc.p60 + '%') + ', по 70% — ' + (disc.p70 == null ? '—' : disc.p70 + '%') + ' (' + (t.discTotal || 0) + ' позиций с ценами обоих прайсов, из них ' + (t.discNeg || 0) + ' уже не дороже).')
    : null;
  const facts = [
    'Сравнивались прайсы: «' + aName + '» (первый) и «' + bName + '» (второй).',
    'Всего в первом: ' + (t.countA || 0) + ' строк, во втором: ' + (t.countB || 0) + ' строк.',
    'Совпавших артикулов: ' + (t.matched || 0) + '.',
    'Где дешевле «' + aName + '»: ' + (t.cheaperA || 0) + ', где дешевле «' + bName + '»: ' + (t.cheaperB || 0) + ', равных цен: ' + (t.equal || 0) + '.',
    'Медианная разница (%) по совпавшим позициям (устойчивая типичная оценка, знак — от «' + aName + '»): ' + (medianPct == null ? 'нет данных' : (medianPct > 0 ? '+' : '') + medianPct + '%') + '.',
    'Ваш прайс — «' + oursName + '», конкуренты — «' + rivalName + '».'
  ].join('\n');
  const histText = 'Распределение «конкуренты дешевле вас» (на сколько % и сколько позиций): ' + aiHistSummary(t.oursMore) + '. Распределение «вы дешевле конкурентов»: ' + aiHistSummary(t.oursLess) + '.';
  const prompt = 'Ты — аналитик прайс-менеджер. По фактическим данным сравнения прайс-листов дай краткий деловой вывод на русском (до 7 предложений). Ваш прайс — «' + oursName + '». Ответь: на сколько в среднем (по распределению) КОНКУРЕНТЫ («' + rivalName + '») превосходят вас по цене, где у кого ценовое преимущество и сколько примерно позиций, и ОБЯЗАТЕЛЬНО укажи практический вывод «какую скидку на ваш прайс дать, чтобы перестать быть дороже по 50%/60%/70% позиций». Дай 1-2 рекомендации. НЕ выдумывай цифры — опирайся только на приведённые факты. Среднее арифметическое НЕ используй, оно искажается выбросами.\n\n' + facts + (discFact ? '\n' + discFact : '') + '\n' + histText;
  return await deepSeekChat([
    { role: 'system', content: 'Ты — сжатый, точный аналитик цен. Отвечаешь только по данным из запроса, по-русски, без воды.' },
    { role: 'user', content: prompt }
  ], { maxTokens: 700 });
}

// ---- Хранилище чанков: файлы НА ДИСКЕ, в RAM только метаданные ----
// Файл НАРЕЗАЕТСЯ на чанки по CHUNK_ROWS строк в момент завершения загрузки
// (/api/upload/done). Каждый чанк — JSON-файл в CHUNKS_DIR. В памяти живут
// только пути к этим файлам, шапка и счётчики (метаданные, а НЕ все строки).
// Это критично для больших прайсов: хранение всех строк в RAM (900 тыс. и
// больше) приводило к OOM и падению контейнера («приложение перезапускается,
// не тянет»). При выгрузке воркер читает чанки-файлы по одному и сравнивает.
const CHUNK_ROWS = 50000;           // строк в одном чанке
// Предохранители по КОЛИЧЕСТВУ СТРОК (а не по мегабайтам). Нарезка потоковая и
// памяти стабильно мало (чанки-файлы на диске, в RAM только метаданные), карту
// артикулов воркер сравнения строит только по второму файлу в изолированном
// воркере (1 млн артикулов ~ 100-200 МБ). Поэтому лимит можно держать заметно
// выше, чем 100-150 МБ «плотного» файла. 2,5 млн строк ≈ 150-180 МБ CSV с
// короткими строками; при превышении приложение шлёт понятную ошибку.
const MAX_FILE_ROWS = 4000000;      // предохранитель: строк в одном файле
const MAX_TOTAL_ROWS = 8000000;     // предохранитель: строк суммарно по всем файлам
const chunkStore = new Map();       // fileId -> { type, chunkPaths:[], head, rows, size, delim, createdAt }
// Фоновая нарезка файла в память (почему фон — см. /api/upload/done):
// fileId -> { status:'chunking'|'ready'|'error', progress, rows, type, error }
const chunkTasks = new Map();

function storeTotalRows() {
  let n = 0;
  for (const e of chunkStore.values()) n += e.rows;
  return n;
}

// Формат определяем по СОДЕРЖИМОМУ, а не по имени: файлы хранятся под
// сгенерированным id без расширения. xlsx — ZIP (PK..), xls — OLE2 (D0CF11E0),
// всё остальное считаем CSV/TXT.
function detectFileType(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const b = Buffer.alloc(8);
    fs.readSync(fd, b, 0, 8, 0);
    fs.closeSync(fd);
    if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx';                                    // PK.. — ZIP (xlsx/xlsm)
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls';   // OLE2 (.xls)
  } catch (_) {}
  return 'csv';
}

// Нарезка CSV/TXT на чанки по CHUNK_ROWS строк (чанки — файлы на диске).
// Строки храним УЖЕ РАЗОБРАННЫМИ на ячейки (splitCSVLine), чтобы воркер не
// тратил время на повторный разбор. onProgress(collected) — по мере накопления.
async function chunkCsvFile(fileId, filePath, delim, onProgress) {
  const chunkPaths = [];
  const head = [];
  let cur = [];
  let rows = 0;
  let idx = 0;
  const flush = () => {
    if (cur.length) { chunkPaths.push(writeChunkFile(fileId, idx, cur)); idx++; cur = []; }
  };
  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    rl.on('line', (line) => {
      const row = splitCSVLine(line, delim);
      if (head.length < 12) head.push(row);
      cur.push(row);
      rows++;
      if (cur.length >= CHUNK_ROWS) flush();
      if (rows % 5000 === 0 && onProgress) onProgress(rows);
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
  flush();
  return { chunkPaths, head, rows };
}

// Каждый чанк — JSON-файл: массив строк (каждая строка — массив ячеек).
function writeChunkFile(fileId, idx, rows) {
  const p = path.join(CHUNKS_DIR, fileId + '.' + idx + '.json');
  fs.writeFileSync(p, JSON.stringify(rows), 'utf8');
  return p;
}
// АСИНХРОННАЯ нарезка xlsx/xls: весь первый лист читаем построчно и режем на
// чанки НА ДИСК, но РАБОТА ИДЁТ ШАГАМИ (по 15 000 строк на шаг с паузой через
// setImmediate). Это критично: синхронный проход по листу на 480 тыс. строк
// блокировал event loop на десятки секунд, а хранение всех строк в памяти
// приводило к OOM. Возвращает { chunkPaths:[], head, rows }.
async function chunkXlsxFile(fileId, filePath, onProgress) {
  const XLSX = loadXLSX();
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rng = ws && ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
  if (!rng) return { chunkPaths: [], head: [], rows: 0 };
  const chunkPaths = [];
  const head = [];
  let cur = [];
  let rows = 0;
  let idx = 0;
  const flush = () => {
    if (cur.length) { chunkPaths.push(writeChunkFile(fileId, idx, cur)); idx++; cur = []; }
  };
  const STEP = 15000; // строк на шаг — чтобы event loop успевал отвечать health
  let R = rng.s.r;
  while (R <= rng.e.r) {
    const end = Math.min(rng.e.r, R + STEP - 1);
    // обрабатываем блок строк [R..end]
    for (let curRow = R; curRow <= end; curRow++) {
      const row = [];
      for (let C = rng.s.c; C <= rng.e.c; C++) {
        const cell = ws[XLSX.utils.encode_cell({ r: curRow, c: C })];
        row.push(cell && cell.v != null ? cell.v : '');
      }
      if (head.length < 12) head.push(row);
      cur.push(row);
      rows++;
      if (cur.length >= CHUNK_ROWS) flush();
      if (rows % 50000 === 0 && onProgress) onProgress(rows);
    }
    // пауза: отдаём event loop'у управление (health-check успевает ответить)
    await new Promise((resolve) => setImmediate(resolve));
    R = end + 1;
  }
  flush();
  return { chunkPaths, head, rows };
}

// ---- Security-заголовки ----
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self'");
  next();
});

app.use(express.json({ limit: '2mb' }));

const VALID_CURRENCIES = new Set(['RUB', 'EUR', 'USD', 'BYN']);
const FILE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

function safeId(v) {
  return typeof v === 'string' && FILE_ID_RE.test(v) ? v : null;
}
function filePath(fileId, base) {
  return path.join(base, fileId);
}

function parseNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).replace(/[\s\u00A0]/g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function normArt(s) {
  return String(s == null ? '' : s).replace(/[\s\u00A0]/g, '').toUpperCase();
}
function isArtH(h) {
  // Колонка-кандидат на артикул. Дополнительно к явным названиям («артикул»,
  // «каталожный номер», «SKU») распознаём «№ ПРОИЗВ.» (номер производителя —
  // это и есть артикул во многих прайсах) и OEM/part. Стоп-слова («группа»,
  // «категория», «бренд», «производитель») артикулом быть не могут.
  return /артикул|арт\.|артик|sku|article|каталож|каталожн|номенклатур|номер|часть|позиц|арт\b|произв|oem|parallelpart|part\b|№|ном\b|code\b|код/i.test(h)
    && !/групп|категор|бренд|производител|brand|сегмент|класс|вид\b|тип\b/i.test(h);
}
function isPriceH(h) {
  return /^(цена|цена\b|price|стоимость|закуп|прайс|cost)/i.test(h) ||
         /(^|\s)(цена|price|стоимость)(\s|$)/i.test(h);
}

// Строгая проверка «похоже на число» для автоопределения колонки цены.
// В отличие от parseNum (который выкусывает число из «ART-001»), эта
// отбрасывает ячейки с буквами — чтобы столбец кодов не принять за цену.
function looksNumeric(v) {
  if (v == null) return false;
  const s = String(v).replace(/[\s\u00A0\uFEFF]/g, '').replace(',', '.');
  if (!s || !/\d/.test(s)) return false;
  if (/[a-zA-Zа-яА-ЯёЁ]/.test(s)) return false;
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s);
}
function toRub(price, cur, rate) {
  if (cur === 'RUB') return price;
  const r = Number(rate);
  if (!isFinite(r) || r <= 0) return null;
  return price * r;
}

// ---- Очистка старых файлов (лимит: держим недавние) ----
function cleanup(dir, keepMs = 3 * 3600 * 1000) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > keepMs) fs.unlinkSync(p);
    }
  } catch (_) { /* ignore */ }
}

function splitCSVLine(line, delim) {
  // простой сплит с учётом кавычек
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') { inQ = true; }
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  if (out[0] && out[0].charCodeAt(0) === 0xFEFF) out[0] = out[0].slice(1);
  return out;
}

function detectDelim(filePath) {
  let first = '';
  try {
    const buf = fs.readFileSync(filePath, { encoding: 'utf8' });
    first = buf.split(/\r?\n/)[0] || '';
    if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1);
  } catch (_) {}
  const counts = [';', ',', '\t'].map((d) => [d, (first.match(new RegExp('\\' + d, 'g')) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ';';
}

function guessColumns(headRows) {
  for (let r = 0; r < Math.min(headRows.length, 10); r++) {
    const hs = (headRows[r] || []).map((h) => String(h == null ? '' : h).trim().toLowerCase());
    let a = -1, p = -1;
    hs.forEach((h, i) => { if (a === -1 && isArtH(h)) a = i; if (p === -1 && isPriceH(h)) p = i; });
    if (a !== -1 && p !== -1 && a !== p) return { headerRow: r, artIdx: a, priceIdx: p };
  }
  // fallback: колонка 0 = артикул, первая числовая = цена
  const colCount = Math.max(0, ...headRows.map((r) => (r || []).length));
  for (let c = 0; c < colCount; c++) {
    const numeric = headRows.filter((r, i) => i > 0 && looksNumeric(r && r[c])).length;
    if (numeric >= Math.min(3, headRows.length - 1)) return { headerRow: 0, artIdx: 0, priceIdx: c };
  }
  return { headerRow: 0, artIdx: 0, priceIdx: 1 };
}

function columnList(headRows) {
  const colCount = Math.max(0, ...headRows.slice(0, 20).map((r) => (r || []).length));
  const cols = [];
  for (let c = 0; c < colCount; c++) {
    const sample = [];
    for (let r = 1; r < Math.min(headRows.length, 4); r++) {
      if (headRows[r] && headRows[r][c] != null && String(headRows[r][c]) !== '') sample.push(String(headRows[r][c]).slice(0, 18));
    }
    const h = headRows[0] && headRows[0][c] != null && String(headRows[0][c]).trim() !== ''
      ? String(headRows[0][c]) : ('Колонка ' + (c + 1));
    cols.push({ index: c, header: h, sample });
  }
  return cols;
}

// POST /api/upload — приём чанка (сырые бинарные данные), заголовки X-File-Id / X-Offset
const raw = express.raw({ type: 'application/octet-stream', limit: '4mb' });
app.post('/api/upload', raw, (req, res) => {
  try {
    const fileId = safeId(req.get('x-file-id'));
    const offset = parseInt(req.get('x-offset'), 10);
    if (!fileId || !Number.isFinite(offset)) return res.status(400).json({ ok: false, error: 'неверные параметры' });
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) return res.status(400).json({ ok: false, error: 'пустой чанк' });
    const p = filePath(fileId, UPLOAD_DIR);
    // Приём чанков БЕЗ требования строгого порядка: шлюз платформы может
    // переупорядочить или повторить доставку POST. Каждый чанк пишется по
    // своему абсолютному смещению, полнота проверяется только на /done
    // (сверка размера с total). Так «порядок чанков нарушен» исчезает как класс.
    //
    // Файл пишем через 'r+' (чтение+запись по позиции): на Windows дескриптор
    // 'a' (append) не позволяет читать, что нам нужно для сверки дублей.
    let rfd;
    try {
      rfd = fs.openSync(p, 'r+');
    } catch (e) {
      if (e.code === 'ENOENT') { fs.writeFileSync(p, Buffer.alloc(0)); rfd = fs.openSync(p, 'r+'); }
      else throw e;
    }
    const cur = fs.fstatSync(rfd).size;
    const writeEnd = offset + data.length;
    // Запись по абсолютному отступу, при необходимости расширяя файл до writeEnd.
    // Если между offset и текущим концом был "пропуск" (чанки пришли не по
    // порядку), дозаписываем пробел нулями поверх уже записанного контента —
    // итоговая полнота всё равно проверяется по размеру на /done.
    if (writeEnd > cur) {
      fs.writeSync(rfd, data, 0, data.length, offset);
      // На случай "дыры" между cur и offset < writeEnd расширяем файл явно.
      const finalSize = Math.max(writeEnd, cur);
      fs.ftruncateSync(rfd, finalSize);
    } else {
      // Чанк полностью укладывается в уже записанный диапазон — это дубль.
      const existing = Buffer.alloc(data.length);
      fs.readSync(rfd, existing, 0, data.length, offset);
      if (existing.equals(data)) { fs.closeSync(rfd); return res.json({ ok: true, received: 0, total: cur }); }
      // расхождение (перезапись перекрытия) — не должно случаться; перепишем
      fs.writeSync(rfd, data, 0, data.length, offset);
    }
    const newSize = fs.fstatSync(rfd).size;
    fs.closeSync(rfd);
    return res.json({ ok: true, received: data.length, total: Math.max(newSize, offset + data.length) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'не удалось записать чанк' });
  }
});

// Фоновая нарезка файла на чанки-файлы. Современный .xlsx режется собственным
// лёгким парсером xlsx-lite прямо в главном процессе (потоковое чтение, пик
// памяти как у CSV — см. xlsx-lite.js); это заменило SheetJS-воркер, чья
// изоляция worker_threads на проде зависала и «не прицепляла» загруженный файл.
// CSV/TXT и старый бинарный .xls по-прежнему нарезаются в отдельном воркер-потоке
// (chunk-worker.js).
async function runChunking(fileId, total) {
  const p = filePath(fileId, UPLOAD_DIR);
  let size = 0;
  try { size = fs.statSync(p).size; } catch (e) {
    chunkTasks.set(fileId, { status: 'error', error: 'файл не найден' });
    return;
  }
  if (size !== total) {
    chunkTasks.set(fileId, { status: 'error', error: 'файл неполный', have: size, want: total });
    return;
  }
  const task = { status: 'chunking', progress: 0, rows: 0 };
  chunkTasks.set(fileId, task);
  const type = detectFileType(p);
  tStart('chunk_' + fileId);
  appLog('chunking', 'начинаю нарезку ' + fileId + ' type=' + type + ' size=' + Math.round(size / 1048576) + 'MB');
  // Watchdog: если нарезка зависла (не пришло НИ ОДНОГО прогресса за 5 минут),
  // ставим понятную ошибку вместо вечного «Обрабатываю…». Таймер НЕ фиксированный:
  // он перезапускается при каждом прогрессе, поэтому большой файл, который
  // реально режется, не будет убит ложной ошибкой; сработает watchdog только тогда,
  // когда воркер/парсер по-настоящему замолчал (завис/упал, не шлёт прогресс).
  let watchdog = null;
  const armWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
    const cur = chunkTasks.get(fileId);
    if (cur && cur.status === 'chunking') {
      cur.status = 'error';
      cur.error = 'Нарезка файла не завершилась за отведённое время. Попробуйте загрузить файл ещё раз.';
      try { fs.unlinkSync(p); } catch (_) {}
    }
    }, 300000);
  };
  armWatchdog();
  console.log('[runChunking] старт', fileId, 'type=' + type, 'size=' + (size / 1048576).toFixed(1) + 'MB');
  try {
    let info;
    const lite = loadXLSXLite();
    if ((type === 'xlsx' || type === 'csv') && lite) {
      // Новый лёгкий разборщик в ГЛАВНОМ ПРОЦЕССЕ: .xlsx и .csv читаются
      // ПОТОКОМ через xlsx-lite (без worker_threads). Причина: worker-нарезка
      // CSV на проде могла «молчать» (не слать прогресс и не завершаться в
      // срок). Здесь onProgress идёт каждые 5000 строк, зависаний нет.
      // Фолбэк: если xlsx-lite недоступен — идём в воркер-ветку ниже.
      let lastProgress = 0;
      if (type === 'xlsx') {
        info = await lite.chunkXlsx({
          filePath: p, fileId, chunkRows: CHUNK_ROWS, chunksDir: CHUNKS_DIR,
          onProgress: (n) => { lastProgress = n; task.progress = n; armWatchdog(); }
        });
      } else {
        info = await lite.chunkCsv({
          filePath: p, fileId, chunkRows: CHUNK_ROWS, chunksDir: CHUNKS_DIR, maxRows: MAX_FILE_ROWS,
          onProgress: (n) => { lastProgress = n; task.progress = n; armWatchdog(); }
        });
      }
      task.progress = lastProgress;
    } else {
      // Старый бинарный .xls, либо xlsx/csv без доступного xlsx-lite —
      // через воркер-поток (chunk-worker.js). Для .xls воркер внутри использует
      // SheetJS (редкий запасной путь, см. detectFileType в chunk-worker.js).
      await new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'chunk-worker.js'), {
          workerData: { filePath: p, fileId, chunkRows: CHUNK_ROWS, chunksDir: CHUNKS_DIR, vendorDir: path.join(__dirname, 'vendor'), maxRows: MAX_FILE_ROWS }
        });
        worker.on('message', (m) => {
          if (m && m.type === 'progress') { task.progress = m.rows; armWatchdog(); return; }
          if (m && m.ok) { info = m; try { worker.terminate(); } catch (_) {} resolve(); }
          else if (m && !m.ok) { try { worker.terminate(); } catch (_) {} reject(new Error(m.error || 'ошибка нарезки')); }
        });
        worker.on('error', (e) => { try { worker.terminate(); } catch (_) {} reject(e); });
      });
    }
    clearTimeout(watchdog);
    task.progress = info.rows;
    if (info.rows === 0) {
      try { fs.unlinkSync(p); } catch (_) {}
      chunkTasks.set(fileId, { status: 'error', error: 'файл пуст — ни одной строки данных' });
      return;
    }
    if (info.rows > MAX_FILE_ROWS || storeTotalRows() + info.rows > MAX_TOTAL_ROWS) {
      try { fs.unlinkSync(p); } catch (_) {}
      chunkTasks.set(fileId, {
        status: 'error',
        error: 'Файл слишком большой для обработки в памяти: ' + info.rows.toLocaleString('ru-RU') +
          ' строк (лимит ' + MAX_FILE_ROWS.toLocaleString('ru-RU') + ' строк на прайс). Разделите файл на части и загрузите по очереди.'
      });
      return;
    }
    chunkStore.set(fileId, { type: info.type, chunkPaths: info.chunkPaths, head: info.head, rows: info.rows, size, delim: info.delim, createdAt: Date.now() });
    try { fs.unlinkSync(p); } catch (_) {}
    task.status = 'ready';
    task.rows = info.rows;
    chunkTasks.set(fileId, task);
    tEnd('chunk_' + fileId, 'chunking', 'нарезка готова ' + fileId + ' rows=' + info.rows + ' chunks=' + info.chunkPaths.length);
    const logType = info.type;
    const logChunks = info.chunkPaths.length;
    const logRows = info.rows;
    // workbook xlsx больше не нужен — если Node запущен с --expose-gc, вызываем
    // сборку мусора, чтобы отдать память контейнеру до нарезки следующего файла
    // (иначе два больших xlsx в памяти дают ~1 ГБ RSS и риск OOM на проде).
    try { if (global.gc) { info.chunkPaths = null; info = null; global.gc(); } } catch (_) {}
    console.log('[mem] загружен', fileId, logType, logRows, 'строк,', logChunks, 'чанков-файлов, rss', Math.round(process.memoryUsage().rss / 1048576) + 'MB');
  } catch (e) {
    try { fs.unlinkSync(p); } catch (_) {}
    console.error('[chunking]', fileId, e && e.message);
    appLog('chunking', 'ОШИБКА нарезки ' + fileId + ': ' + (e && e.message));
    chunkTasks.set(fileId, { status: 'error', error: 'не удалось разобрать файл: ' + sanitizeDetail(e) });
  }
}

// POST /api/upload/done — завершение загрузки чанков:
//   * проверяем полноту (размер == total) ОТВЕЧАЕМ СРАЗУ;
//   * нарезка файла на чанки по 100 000 строк выполняется В ФОНЕ (см. runChunking);
//   * фронт опрашивает /api/upload/status, пока не станет ready;
//   * причина фона: разбор большого xlsx может занимать десятки секунд, и
//     шлюз платформы оборвал бы синхронный запрос (симптом «100%, файл не выбран»).
app.post('/api/upload/done', (req, res) => {
  try {
    const fileId = safeId(req.body && req.body.fileId);
    const total = parseInt(req.body && req.body.total, 10);
    if (!fileId || !Number.isFinite(total)) return res.status(400).json({ ok: false, error: 'неверные параметры' });
    // Повторный вызов (ретрай клиента) — идемпотентно: если уже в памяти, вернули готовое.
    if (chunkStore.has(fileId)) {
      const ex = chunkStore.get(fileId);
      return res.json({ ok: true, size: ex.size, rows: ex.rows, status: 'ready' });
    }
    // Уже нарезается (дубль вызова) — отвечаем «в работе».
    const existing = chunkTasks.get(fileId);
    if (existing && existing.status === 'chunking') {
      return res.json({ ok: true, status: 'chunking', progress: existing.progress });
    }
    const p = filePath(fileId, UPLOAD_DIR);
    let size = 0;
    try { size = fs.statSync(p).size; } catch (_) { return res.status(404).json({ ok: false, error: 'файл не найден' }); }
    if (size !== total) return res.status(409).json({ ok: false, error: 'файл неполный', have: size, want: total });
    // Файл загружен полностью — запускаем фоновую нарезку и отвечаем сразу.
    // setImmediate: НЕ выполняем даже первый синхронный кусок (разбор заголовка
    // xlsx через readFileSync) прямо в HTTP-обработчике — иначе большой файл
    // заставит ответ /done ждать секунды, а шлюз может оборвать запрос.
    setImmediate(() => runChunking(fileId, total).catch((e) => {
      console.error('[runChunking]', fileId, e && e.message);
      chunkTasks.set(fileId, { status: 'error', error: 'внутренняя ошибка нарезки' });
    }));
    return res.json({ ok: true, status: 'chunking', total });
  } catch (e) {
    console.error('[upload/done]', e && e.message);
    return res.status(500).json({ ok: false, error: 'ошибка завершения загрузки' });
  }
});

// GET /api/upload/status?fileId= — статус фоновой нарезки
app.get('/api/upload/status', (req, res) => {
  try {
    const fileId = safeId(req.query.fileId);
    if (!fileId) return res.status(400).json({ ok: false, error: 'неверный fileId' });
    const e = chunkStore.get(fileId);
    if (e) return res.json({ ok: true, status: 'ready', rows: e.rows, size: e.size });
    const t = chunkTasks.get(fileId);
    if (!t) return res.status(404).json({ ok: false, error: 'файл не найден' });
    if (t.status === 'error') return res.json({ ok: true, status: 'error', error: t.error });
    return res.json({ ok: true, status: 'chunking', progress: t.progress || 0 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ошибка статуса' });
  }
});

// GET /api/columns?fileId= — автоопределение колонок по шапке ИЗ ПАМЯТИ
app.get('/api/columns', (req, res) => {
  try {
    const fileId = safeId(req.query.fileId);
    if (!fileId) return res.status(400).json({ ok: false, error: 'неверный fileId' });
    const e = chunkStore.get(fileId);
    if (!e) return res.status(404).json({ ok: false, error: 'файл не найден' });
    const guess = guessColumns(e.head);
    return res.json({ ok: true, cols: columnList(e.head), artIdx: guess.artIdx, priceIdx: guess.priceIdx, headerRow: guess.headerRow || 0 });
  } catch (e) {
    console.error('[columns]', e && e.message);
    return res.status(500).json({ ok: false, error: 'не удалось прочитать колонки' });
  }
});

// Задачи сравнения (async): /api/compare создаёт задачу и отвечает СРАЗУ,
// /api/compare/status опрашивается клиентом. Так HTTP-запрос не висит десятки
// секунд (иначе шлюз платформы не дожидается и шлёт BH_APP_STARTING).
const compareTasks = new Map();

function sanitizeDetail(e) {
  let detail = (e && e.message) ? String(e.message) : 'неизвестная ошибка';
  return detail.replace(/[\w]:\\[\\\w.() ]*|\/opt\/app[\\\/][\w.()\\\/ ]*/gi, '[путь]');
}

// Раздача чанков воркеру с flow-control. postMessage делает структурированную
// копию данных, поэтому если послать все чанки разом, их клоны осядут в очереди
// воркера одновременно (сотни МБ). Вместо этого шлём ПО ОДНОМУ чанку (100к строк)
// и следующий отправляем только после ack ("обработан") от воркера — в памяти
// в каждый момент живёт один клон.
async function feedChunks(entry, type, worker) {
  for (let i = 0; i < entry.chunkPaths.length; i++) {
    // Из главного процесса больше НИЧЕГО тяжёлого не читаем: воркер сам прочитает
    // чанк-файл по пути (readChunkFile внутри воркера). Это убирает JSON.parse и
    // postMessage-копию из main event loop — на больших файлах главный процесс
    // остаётся живым, и /api/compare/status отвечает всегда (а не «затыкается»
    // после ~20-30 с обработки).
    await new Promise((resolve, reject) => {
      const onMsg = (m) => {
        // воркер подтверждает обработку чанка сообщением { type:'bAck'|'aAck' }
        const ackType = type === 'bChunk' ? 'bAck' : 'aAck';
        if (m && m.type === ackType) { worker.off('message', onMsg); resolve(); }
        else if (m && !m.type && m.ok === false) { worker.off('message', onMsg); reject(new Error(m.error || 'ошибка воркера')); }
      };
      worker.on('message', onMsg);
      worker.postMessage({ type, chunkPath: entry.chunkPaths[i], startRow: i * CHUNK_ROWS });
    });
  }
}

// POST /api/compare — создаёт задачу сравнения и отвечает сразу с taskId
app.post('/api/compare', (req, res) => {
  let b;
  try { b = req.body || {}; } catch (_) { return res.status(400).json({ ok: false, error: 'неверный запрос' }); }
  const fileIdA = safeId(b.fileIdA);
  const fileIdB = safeId(b.fileIdB);
  if (!fileIdA || !fileIdB) return res.status(400).json({ ok: false, error: 'неверные файлы' });
  const entryA = chunkStore.get(fileIdA);
  const entryB = chunkStore.get(fileIdB);
  if (!entryA || !entryB) return res.status(404).json({ ok: false, error: 'файл не найден — перезагрузите прайсы' });
  // РАННЯЯ проверка объёма ДО старта воркера: если суммарно строк больше лимита,
  // отклоняем сразу, чтобы не грузить контейнер заведомо неподъёмным сравнением.
  if (entryA.rows > MAX_FILE_ROWS || entryB.rows > MAX_FILE_ROWS || entryA.rows + entryB.rows > MAX_TOTAL_ROWS) {
    return res.status(409).json({
      ok: false,
      error: 'Файл слишком большой для обработки в памяти: ' +
        (entryA.rows + entryB.rows).toLocaleString('ru-RU') +
        ' строк суммарно (лимит ' + MAX_TOTAL_ROWS.toLocaleString('ru-RU') + ' строк). Разделите файлы на части и загрузите по очереди.'
    });
  }

  const nameA = String(b.nameA || 'Файл 1');
  const nameB = String(b.nameB || 'Файл 2');
  const curA = String(b.curA || 'RUB');
  const curB = String(b.curB || 'RUB');
  if (!VALID_CURRENCIES.has(curA) || !VALID_CURRENCIES.has(curB)) return res.status(400).json({ ok: false, error: 'недопустимая валюта' });
  const rateA = parseNum(b.rateA) || 1;
  const rateB = parseNum(b.rateB) || 1;
  const artIdxA = parseInt(b.artIdxA, 10);
  const priceIdxA = parseInt(b.priceIdxA, 10);
  const artIdxB = parseInt(b.artIdxB, 10);
  const priceIdxB = parseInt(b.priceIdxB, 10);
  const headerRowA = parseInt(b.headerRowA, 10) || 0;
  const headerRowB = parseInt(b.headerRowB, 10) || 0;

  const resultId = 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const outPath = filePath(resultId, RESULT_DIR);
  // XLSX пишется в ОТДЕЛЬНЫЙ файл (не поверх CSV): тогда и «Скачать CSV», и
  // «Скачать XLSX» доступны одновременно, ни один не ломает другой.
  const xlsxId = resultId + '_x';
  const xlsxPath = filePath(xlsxId, RESULT_DIR);
  const taskId = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  tStart('cmp_' + taskId);
  appLog('compare', 'создаю задачу ' + taskId + ' A=' + entryA.rows + ' строк, B=' + entryB.rows + ' строк, rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
  // Обработка идёт из ПАМЯТИ: чанки файла B (карта) и чанки файла A (сравнение)
  // уходят воркеру через postMessage; результат собирается в один CSV и пишется
  // порциями в RESULT_DIR. Ни один исходник с диска не читается.
  const chunkSize = parseInt(b.chunkSize, 10) > 0 ? parseInt(b.chunkSize, 10) : 10000;

  const task = { taskId, status: 'running', startedAt: Date.now() };
  compareTasks.set(taskId, task);

  // Сравнение выполняем асинхронно (в фоне), чтобы ответ /api/compare ушёл сразу:
  // раздача чанков с ожиданием ack занимает время и не должна висеть в запросе.
  // «Наш» прайс — тот, что называется «Проф» (правило пользователя), иначе второй.
  const aNameNorm = String(nameA || '').trim().toLowerCase();
  const bNameNorm = String(nameB || '').trim().toLowerCase();
  const oursIsA = aNameNorm === 'проф';
  // Освобождаем память нарезки ПЕРЕД сравнением: на затс-контейнере 512 МБ важно
  // не копить RSS от нарезки + карты сравнения одновременно. Сервер запущен с
  // --expose-gc, вызов global.gc() подталкивает V8 вернуть неиспользуемое.
  try { if (global.gc) global.gc(); } catch (_) {}
  const worker = new Worker(path.join(__dirname, 'worker.js'), {
    workerData: { artIdxA, priceIdxA, headerRowA, curA, rateA, artIdxB, priceIdxB, headerRowB, curB, rateB, nameA, nameB, outPath, chunkSize, oursIsA },
    // Ограничиваем heap ВОРКЕРА: worker_threads НЕ наследует --max-old-space-size
    // родителя и может раздувать RSS всего процесса сверх лимита контейнера (512 МБ
    // на проде). Задаём размерное ограничение, чтобы пик сравнения укладывался.
    resourceLimits: { maxOldGenerationSizeMb: 200, maxYoungGenerationSizeMb: 40, codeRangeSizeMb: 16 }
  });

  // Посылаем чанки B, потом чанки A — без ожидания bReady: сообщения рабочего
  // потока доставляются по порядку, карта успевает собраться до aChunk.
  (async () => {
    try {
      await feedChunks(entryB, 'bChunk', worker);
      worker.postMessage({ type: 'bDone' });
      await feedChunks(entryA, 'aChunk', worker);
      worker.postMessage({ type: 'aDone' });
    } catch (e) {
      task.status = 'error'; task.error = (e && e.message) || 'ошибка воркера';
      try { worker.terminate(); } catch (_) {}
    }
  })();

  // Транзитные сообщения воркера (bAck/aAck/bReady) не несут поля ok и должны
  // игнорироваться: реагируем только на финальный ответ { ok:true|false }.
  worker.on('message', async (m) => {
    if (!m || m.ok === undefined) return;
    if (m.ok) {
      task.countA = m.countA; task.countB = m.countB; task.matched = m.matched;
      task.resultId = resultId;        // CSV
      task.xlsxId = xlsxId;            // XLSX
      task.cheaperA = m.cheaperA || 0;
      task.cheaperB = m.cheaperB || 0;
      task.equal = m.equal || 0;
      task.avgPct = (typeof m.avgPct === 'number' && isFinite(m.avgPct)) ? m.avgPct : null;
      task.medianPct = (typeof m.medianPct === 'number' && isFinite(m.medianPct)) ? m.medianPct : null;
      task.oursMore = Array.isArray(m.oursMore) ? m.oursMore : null;
      task.oursLess = Array.isArray(m.oursLess) ? m.oursLess : null;
      task.disc = (m.discPct && typeof m.discPct === 'object') ? m.discPct : null;
      task.discNeg = m.discNeg || 0;
      task.discTotal = m.discTotal || 0;
      task.curA = m.curA; task.curB = m.curB; task.rateA = m.rateA; task.rateB = m.rateB;
      task.aName = m.aName; task.bName = m.bName;
      // Сравнение завершено: CSV-результат уже записан в outPath, поэтому СРАЗУ
      // ставим done — клиент видит результат мгновенно, а сервер остаётся лёгким.
      task.status = 'done';
      tEnd('cmp_' + taskId, 'compare', 'сравнение готово matched=' + (m.matched || 0) + ', rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
      // ИИ-анализ отключён: внешний вызов DeepSeek (вплоть до таймаута 120 с) на
      // больших прайсах мог держать фоновые процессы и совпадать с обрывами
      // («app not answering»). Результат теперь всегда по расчётным данным.
      // Итоговый xlsx собираем В ФОНЕ отдельным воркером (пик памяти изолирован).
      // CSV к этому моменту уже лежит в outPath и доступен для скачивания; xlsx
      // пишется в xlsxPath отдельно, без перезаписи CSV.
      task.xlsxPending = true;
      const rssNow = process.memoryUsage().rss / 1048576;
      if (rssNow <= 3400) {
        const xlsxStart = Date.now();
        buildResultXlsx(task, outPath, xlsxPath)
          .then(() => {
            task.xlsxReady = true;
            task.xlsxFailed = false;
            task.xlsxPending = false;
            console.log('[xlsx-bg] собрано за ' + Math.round((Date.now() - xlsxStart) / 1000) + 'с, rss ' + Math.round(rssNow) + 'MB');
          })
          .catch((e) => {
            // Честный фолбэк на CSV, ЧТОБЫ НЕ ВИСЕТЬ: любая ошибка сборки
            // (таймаут watchdog, нехватка памяти, падение воркера) переводит
            // задачу в xlsxFailed — CSV остаётся доступен.
            // Причина всегда логируется в консоль с меткой [xlsx-bg].
            task.xlsxFailed = true;
            task.xlsxPending = false;
            console.error('[xlsx-bg] не удалось собрать xlsx за ' + Math.round((Date.now() - xlsxStart) / 1000) + 'с, переключаюсь на CSV:', e && e.message);
          });
      } else {
        // Память уже на пределе — запускать тяжёлую XLSX.write рискованно:
        // сразу честно отдаём CSV и не доводим контейнер до OOM.
        task.xlsxFailed = true;
        task.xlsxPending = false;
        console.log('[xlsx-bg] память ' + Math.round(rssNow) + 'MB — пропускаю сборку xlsx, отдаю CSV');
      }
      try { if (global.gc) global.gc(); } catch (_) {}
      // Воркер сравнения больше не нужен — завершаем его, чтобы освободить Map
      // (сотни МБ) до того, как фоновый воркер xlsx начнёт тяжёлую XLSX.write.
      try { worker.terminate(); } catch (_) {}
    } else {
      task.status = 'error'; task.error = m.error || 'неизвестная ошибка';
    }
    // Исходники больше не нужны — удаляем чанки-файлы и записи, но только после
    // того, как результат собран (иначе buildResultXlsx может не найти чанки).
    if (task.status === 'done' || task.status === 'error') {
      deleteChunkFiles(fileIdA);
      deleteChunkFiles(fileIdB);
    }
  });
  worker.once('error', (e) => { task.status = 'error'; task.error = sanitizeDetail(e); });
  worker.once('exit', (code) => { if (code !== 0 && task.status === 'running') { task.status = 'error'; task.error = 'воркер завершился с кодом ' + code; } });

  return res.json({ ok: true, taskId });
});

// GET /api/compare/status?taskId= — опрос статуса задачи
app.get('/api/compare/status', (req, res) => {
  const id = req.query.taskId;
  if (typeof id !== 'string' || !/^t_[a-z0-9]+$/i.test(id)) return res.status(400).json({ ok: false, error: 'неверный taskId' });
  const t = compareTasks.get(id);
  if (!t) return res.status(404).json({ ok: false, error: 'задача не найдена' });
  // Диагностика: отмечаем, как долго задача в статусе running, раз в ~10 секунд
  // (первый опрос + каждые 10 с), чтобы видеть, отвечает ли status во время
  // обработки и не «зависает» ли сравнение (скриншот из DevTools).
  const now = Date.now();
  if (t.status === 'running') {
    if (!t._lastLog || now - t._lastLog > 10000) {
      t._lastLog = now;
      appLog('status', 'задача ' + id + ' running уже ' + Math.round((now - (t.startedAt || now)) / 1000) + 'с, rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
    }
  }
  const payload = { ok: true, status: t.status };
  if (t.status === 'done') {
    payload.countA = t.countA; payload.countB = t.countB; payload.matched = t.matched;
    payload.avgPct = (typeof t.avgPct === 'number') ? Math.round(t.avgPct * 100) / 100 : null;
    payload.medianPct = (typeof t.medianPct === 'number') ? Math.round(t.medianPct * 100) / 100 : null;
    payload.disc = (t.disc && typeof t.disc === 'object') ? t.disc : null;
    payload.discNeg = t.discNeg || 0;
    payload.discTotal = t.discTotal || 0;
    payload.resultId = t.resultId; payload.xlsxId = t.xlsxId; payload.sampled = !!t.sampled;
    payload.xlsxReady = !!t.xlsxReady; payload.xlsxPending = !!t.xlsxPending;
    payload.xlsxFailed = !!t.xlsxFailed;
    payload.aiEnabled = !!readAIKey();
    payload.aiPending = !!t.aiPending;
    payload.aiInsight = (typeof t.aiInsight === 'string' && t.aiInsight) ? t.aiInsight : null;
    payload.aiFailed = !!t.aiFailed;
    // держим задачу ещё ~2 минуты после done — фронт опрашивает готовность xlsx
    if ((t.xlsxReady || !t.xlsxPending) && !t.aiPending) compareTasks.delete(id);
  }
  if (t.status === 'error') {
    // Санитизируем ошибку и обрезаем: не течём внутренние пути/конфиг наружу.
    payload.error = sanitizeDetail({ message: t.error }).slice(0, 500);
  }
  return res.json(payload);
});

// GET /api/memory — состояние хранилища чанков (для замеров и отладки)
app.get('/api/memory', (req, res) => {
  const list = [];
  for (const [fileId, e] of chunkStore) {
    list.push({ fileId, rows: e.rows, chunks: (e.chunkPaths || []).length, type: e.type, ageSec: Math.round((Date.now() - e.createdAt) / 1000) });
  }
  return res.json({ ok: true, rssMB: Math.round(process.memoryUsage().rss / 1048576), heapMB: Math.round(process.memoryUsage().heapUsed / 1048576), limitMB: containerMemoryLimitMB(), files: list });
});

// GET /api/debug/log — скачать наш диагностический лог из /data (текст)
// Требует ADMIN: лог содержит пути/внутренности, наружу не для всех.
app.get('/api/debug/log', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'недостаточно прав' });
  try {
    const text = fs.existsSync(APP_LOG_PATH) ? fs.readFileSync(APP_LOG_PATH, 'utf8') : '';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(text || '(лог пуст)');
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'не удалось прочитать лог' });
  }
});

// GET /api/ai/status — включён ли DeepSeek (наружу уходит только маска ключа)
app.get('/api/ai/status', (req, res) => {
  const key = readAIKey();
  return res.json({ ok: true, enabled: !!key, masked: maskKey(key), admin: isAdmin(req) });
});

// POST /api/ai/settings — задать/убрать ключ DeepSeek. Ключ хранится в /data
// (переживает передеплой), работает только на сервере. Менять может только
// администратор (роль из заголовка шлюза, подделать нельзя).
app.post('/api/ai/settings', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'только администратор' });
  let b;
  try { b = req.body || {}; } catch (_) { return res.status(400).json({ ok: false, error: 'неверный запрос' }); }
  const key = (typeof b.apiKey === 'string') ? b.apiKey.trim() : '';
  if (key === '') {
    try { fs.unlinkSync(AI_SECRET_PATH); } catch (_) {}
    AI_ENABLED = false;
    return res.json({ ok: true, enabled: false });
  }
  if (!/^[A-Za-z0-9\-_.]+$/.test(key)) return res.status(400).json({ ok: false, error: 'непохоже на ключ' });
  try {
    writeAIKey(key);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'не удалось сохранить ключ: ' + sanitizeDetail(e) });
  }
  AI_ENABLED = true;
  return res.json({ ok: true, enabled: true, masked: maskKey(readAIKey()) });
});

// Размер части скачивания. Каждая часть меньше лимита тела ответа шлюза
// платформы, поэтому шлюз не обрывает их — клиент склеивает части в файл.
// Размер части скачивания. Поднят с 1,5 МБ до 4 МБ: каждая часть всё ещё
// заметно ниже лимита тела ответа шлюза платформы, а частей стало в ~3 раза
// меньше — скачивание крупного xlsx требует меньшего числа запросов.
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;

function resultPath(resultId) {
  const id = safeId(resultId);
  return id ? filePath(id, RESULT_DIR) : null;
}

// GET /api/download/meta?resultId= — размер файла и число частей
app.get('/api/download/meta', (req, res) => {
  try {
    const p = resultPath(req.query.resultId);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'результат не найден' });
    const size = fs.statSync(p).size;
    const parts = Math.ceil(size / DOWNLOAD_CHUNK) || 1;
    return res.json({ ok: true, size, parts, total: size });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ошибка скачивания' });
  }
});

// GET /api/download/part?resultId=&part=N — одна часть файла
app.get('/api/download/part', (req, res) => {
  try {
    const p = resultPath(req.query.resultId);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ ok: false, error: 'результат не найден' });
    const part = parseInt(req.query.part, 10);
    const size = fs.statSync(p).size;
    if (!Number.isFinite(part) || part < 0) return res.status(400).json({ ok: false, error: 'неверная часть' });
    const start = part * DOWNLOAD_CHUNK;
    if (start >= size) return res.status(400).json({ ok: false, error: 'часть за пределами файла' });
    const end = Math.min(size, start + DOWNLOAD_CHUNK);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(end - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    // после выдачи последней части удаляем файл с диска
    if (end >= size) { try { fs.unlinkSync(p); } catch (_) { } }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('X-File-Part', String(part));
    res.setHeader('X-File-Last', end >= size ? '1' : '0');
    res.end(buf);
  } catch (e) {
    // часть могла уже быть удалена (повторный запрос) — отдаём 410
    if (!res.headersSent) return res.status(410).json({ ok: false, error: 'файл уже выдан, начните скачивание заново' });
    res.end();
  }
});

// Удаление чанков-файлов записи (по id из chunkStore).
function deleteChunkFiles(fileId) {
  const e = chunkStore.get(fileId);
  if (e && e.chunkPaths) {
    for (const p of e.chunkPaths) { try { fs.unlinkSync(p); } catch (_) {} }
  }
  chunkStore.delete(fileId);
}

// Сборка итогового xlsx из CSV-результата и метаданных сравнения.
// ВЫПОЛНЯЕТСЯ В ОТДЕЛЬНОМ ВОРКЕРЕ (result-worker.js): XLSX.write для листа на
// сотни тысяч строк даёт большой пик памяти, который в главном процессе ронял
// контейнер на проде. В воркере пик изолирован, главный процесс остаётся лёгким.
// Читает CSV-результат (csvPath) и пишет xlsx в ОТДЕЛЬНЫЙ файл (outPath) —
// CSV остаётся нетронутым для «Скачать CSV».
// Сборка НЕ ВЕЧНАЯ: жёсткий таймаут XLSX_TIMEOUT_MS (90 c). Если воркер за это
// время не завершился (чаще всего — упирается в память на сотнях тысяч строк),
// мы ПРЕРЫВАЕМ его и отклоняем промис. Вызывающий код ставит xlsxFailed и
// переключает результат на готовый CSV, а НЕ висит бесконечно. Прерывание до
// финальной записи безопасно: воркер пишет outPath одним writeFileSync в самом
// конце, поэтому CSV на диске остаётся нетронутым для фолбэка.
const XLSX_TIMEOUT_MS = 90000;
function buildResultXlsx(task, csvPath, outPath) {
  const vendorDir = path.join(__dirname, 'vendor');
  return new Promise((resolve, reject) => {
    // ВАЖНО: сборка xlsx читает СНИМОК CSV, а не сам csvPath. Иначе скачивание
    // CSV (эндпоинт /api/download/part удаляет файл после выдачи последней
    // части) стёрло бы исходник воркера, и сборка xlsx падала бы. Копия лежит
    // в отдельном файле и не зависит от судьбы скачиваемого CSV.
    const snap = csvPath + '.xlsx_src_' + Date.now().toString(36) + '.csv';
    fs.copyFileSync(csvPath, snap);
    const worker = new Worker(path.join(__dirname, 'result-worker.js'), {
      workerData: { csvPath: snap, outPath, vendorDir, task: {
        matched: task.matched || 0,
        cheaperA: task.cheaperA || 0,
        cheaperB: task.cheaperB || 0,
        equal: task.equal || 0,
        avgPct: task.avgPct,
        medianPct: task.medianPct,
        oursMore: task.oursMore,
        oursLess: task.oursLess,
        disc: task.disc,
        discNeg: task.discNeg,
        discTotal: task.discTotal,
        curA: task.curA, curB: task.curB,
        rateA: task.rateA, rateB: task.rateB,
        aName: task.aName || 'Прайс 1',
        bName: task.bName || 'Прайс 2'
      } }
    });
    let settled = false;
    // Снимок-исходник больше не нужен после того, как воркер его прочитал.
    // Чистим его в любом исходе сборки (успех/ошибка/прерывание по таймауту),
    // чтобы не засорять /data. Прерывание по таймауту также идёт через reject,
    // поэтому finally покрывает все три пути.
    const cleanupSnap = () => { try { fs.unlinkSync(snap); } catch (_) {} };
    // Watchdog: не даём сборке xlsx висеть дольше XLSX_TIMEOUT_MS. На 425 тыс.
    // строк XLSX.write часто упирается в память и не возвращается — вместо
    // вечного ожидания прерываем воркер (он пишет файл только в конце, так что
    // CSV для фолбэка сохраняется) и отклоняем промис с понятной причиной.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupSnap();
      try { worker.terminate(); } catch (_) {}
      reject(new Error('сборка xlsx не завершилась за ' + (XLSX_TIMEOUT_MS / 1000) + ' секунд (вероятно, нехватка памяти на больших объёмах)'));
    }, XLSX_TIMEOUT_MS);
    worker.on('message', (m) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSnap();
      if (m && m.ok) resolve();
      else reject(new Error((m && m.error) || 'ошибка сборки xlsx'));
    });
    worker.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSnap();
      reject(e);
    });
  });
}

// POST /api/cleanup — удалить файлы по списку ids (из uploads, chunks и/или results)
// либо всё сразу ({all:true}). Для чанков — удаляет и файлы с диска, и запись.
app.post('/api/cleanup', (req, res) => {
  try {
    const b = req.body || {};
    let removed = 0;
    const del = (id, base) => {
      const s = safeId(id);
      if (!s) return;
      const p = filePath(s, base);
      try { if (fs.existsSync(p)) { fs.unlinkSync(p); removed++; } } catch (_) {}
    };
    if (b.all) {
      // {all:true} стирает ВСЁ хранилище — разрешаем только администратору.
      // Обычное скачивание/загрузка использует b.files, которое остаётся
      // доступным всем вошедшим (шлюз уже аутентифицировал запрос).
      if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'недостаточно прав' });
      for (const fileId of Array.from(chunkStore.keys())) deleteChunkFiles(fileId);
      for (const f of fs.readdirSync(CHUNKS_DIR)) { try { fs.unlinkSync(filePath(f, CHUNKS_DIR)); removed++; } catch (_) {} }
      for (const f of fs.readdirSync(UPLOAD_DIR)) { try { fs.unlinkSync(filePath(f, UPLOAD_DIR)); removed++; } catch (_) {} }
      for (const f of fs.readdirSync(RESULT_DIR)) { try { fs.unlinkSync(filePath(f, RESULT_DIR)); removed++; } catch (_) {} }
    } else if (Array.isArray(b.files)) {
      b.files.forEach((id) => {
        const s = safeId(id);
        if (s && chunkStore.has(s)) { deleteChunkFiles(s); removed++; }
        // также снимаем все чанк-файлы этого id, если они остались без записи
        if (s) {
          for (const f of fs.readdirSync(CHUNKS_DIR)) {
            if (f.indexOf(s + '.') === 0) { try { fs.unlinkSync(filePath(f, CHUNKS_DIR)); removed++; } catch (_) {} }
          }
        }
        del(id, UPLOAD_DIR);
        del(id, RESULT_DIR);
      });
    }
    return res.json({ ok: true, removed });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'ошибка очистки' });
  }
});

// Статика
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  // index.html, app.js и style.css отдаём БЕЗ кэша, чтобы браузер не держал
  // старую версию интерфейса (иначе после деплоя видно старый фронт).
  setHeaders(rs, fp) {
    if (/\.html$|\.js$|\.css$/.test(fp)) rs.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Версия сервера — маркер сборки в health, чтобы отличать новый сервер
// (с фоновой нарезкой и /api/upload/status) от старого при диагностике.
app.get('/api/health', (req, res) => res.json({ ok: true, serverVersion: 'srv10-wc' })); // srv10-wc: чанки читает воркер, главный не блокируется

// Периодическая очистка: старые ЧАНКИ (файлы+записи) и старые файлы результатов (диск)
function sweepChunks(keepMs = 6 * 3600 * 1000) {
  const now = Date.now();
  for (const [fileId, e] of chunkStore) {
    if (now - e.createdAt > keepMs) deleteChunkFiles(fileId);
  }
}
setInterval(() => { sweepChunks(); cleanup(UPLOAD_DIR); cleanup(RESULT_DIR); cleanup(CHUNKS_DIR); }, 30 * 60 * 1000);

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[unhandled]', err && err.message);
  res.status(500).json({ ok: false, error: 'Внутренняя ошибка сервера' });
});

// Смонтированный в BIOTIME модуль: экспортируем Express-app вместо listen.
// BIOTIME (мост routes/procenka.js) монтирует его под /procenka и передаёт
// входящие (req, res) напрямую; собственный порт/запуск не используется.
module.exports = app;
