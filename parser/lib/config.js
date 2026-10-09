// Хранение настроек приложения. Настройки должны переживать передеплой,
// поэтому пишем ТОЛЬКО в /data (с фолбэком на папку приложения локально).
const fs = require('node:fs');
const path = require('node:path');

function dataDir() {
  const envDir = process.env.DATA_DIR;
  if (envDir) return envDir;
  return '/data';
}

function configPath() {
  // Свой файл, чтобы не конфликтовать с настройками других встроенных модулей
  // (у «Отчётов» настройки в abcp-settings.json).
  return path.join(dataDir(), 'parser-settings.json');
}

function defaults() {
  return {
    mail: {
      enabled: false,
      host: 'imap.yandex.ru',
      port: 993,
      user: '',
      password: '', // app-пароль Яндекс
      folder: 'INBOX',
      onlyUnseen: true,
      markSeen: true,
      pollMinutes: 5
    },
    table: {
      enabled: false,
      authMethod: 'serviceAccount', // serviceAccount | apiKey
      serviceAccountJson: '',       // содержимое JSON Service Account
      apiKey: '',
      spreadsheetId: ''            // ID Google Таблицы (общий для всех правил)
    },
    // Два независимых правила обработки писем.
    rules: {
      items: [
        {
          name: 'Правило 03',
          enabled: true,
          sender: '',
          // 'filter' — sender это инклюзивный фильтр (только эта почта),
          // 'exclude' — sender это исключение (не обрабатывать эту почту).
          senderMode: 'filter',
          sheetName: 'Sheet1',
          articleCol: 'A',
          statusCol: 'B',
          // quoteMode: при true артикул/инвойс ищем в цитате исходного письма
          // (раздел переписки), а не в новом тексте ответа. Правило 03 — весь текст.
          quoteMode: false,
          // Столбец «Номер инвойса». Пусто = сверка по инвойсу выключена.
          // Если задан — статус меняется только при совпадении и артикула,
          // и номера инвойса в найденной строке.
          invoiceCol: '',
          invoicePattern: '',
          // Столбец «Причина» — дополнительная жёсткая сверка для правила 03.
          // Пусто = сверка по причине выключена. Если задан — статус меняется
          // только когда в строке совпал и артикул, и причина (берётся из темы
          // письма вида «Согласование - <артикул> - <причина>»).
          reasonCol: '',
          // Столбец «Лого поставщика» — жёсткая сверка по правилу 03. Пусто =
          // сверка по лого выключена. Лого берётся из темы письма вида
          // «Согласование <лого> - <артикул> - <причина>» (напр. «RRE»).
          logoCol: '',
          articlePattern: '',
          triggerStatus: 'Запрос клиента',
          keywords: [
            { keywords: ['до клиента'], status: 'До клиента' },
            { keywords: ['отгружайте'], status: 'Отгружайте' }
          ]
        },
        {
          name: 'Правило 03b',
          enabled: true,
          sender: '',
          senderMode: 'exclude',
          sheetName: 'Sheet1',
          articleCol: 'A',
          statusCol: 'C',
          // Правило 4: артикул/инвойс всегда из цитаты исходного письма.
          quoteMode: true,
          invoiceCol: '',
          invoicePattern: '',
          articlePattern: '',
          triggerStatus: 'Запрос клиента',
          keywords: []
        }
      ]
    },
    ui: {
      // Названия разделов интерфейса (можно менять в настройках)
      labels: {
        appName: 'Парсер почты',
        mail: 'Яндекс Почта',
        table: 'Google Таблица',
        rules: 'Правила «текст → статус»',
        rules2: 'Второе правило статуса',
        log: 'Журнал'
      }
    },
    stats: {
      // Накопительный счётчик успешно обработанных писем за всё время
      successTotal: 0,
      // Время последнего цикла синхронизации (ISO) — хранится на диске
      lastRunAt: ''
    },
    log: []
  };
}

function ensureDataDir() {
  const dir = dataDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    // не критично — локально пишем в фолбэк
  }
  return dir;
}

function read() {
  const p = configPath();
  try {
    let parsed = defaults();
    if (fs.existsSync(p)) {
      parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    }
    const merged = merge(defaults(), parsed);
    merged.log = [];
    // Восстановление из бэкапа (seed): если в серверных настройках нет
    // подключений (mail/table), а в seed они есть — дозаполняем их, чтобы
    // после встройки парсер сразу заработал с восстановленными данными.
    // Существующие значения не перезаписываются.
    let seeded = false;
    try {
      const seedPath = path.join(__dirname, '..', 'settings.seed.json');
      if (fs.existsSync(seedPath)) {
        const s = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
        const sMail = s.mail || {};
        const sTable = s.table || {};
        if (!merged.mail.user && sMail.user) { merged.mail.user = sMail.user; seeded = true; }
        if (!merged.mail.password && sMail.password) { merged.mail.password = sMail.password; seeded = true; }
        if (!merged.mail.host) { merged.mail.host = sMail.host || 'imap.yandex.ru'; }
        if (!merged.table.serviceAccountJson && sTable.serviceAccountJson) { merged.table.serviceAccountJson = sTable.serviceAccountJson; seeded = true; }
        if (!merged.table.spreadsheetId && sTable.spreadsheetId) { merged.table.spreadsheetId = sTable.spreadsheetId; seeded = true; }
        if (!merged.table.authMethod) { merged.table.authMethod = sTable.authMethod || merged.table.authMethod; }
      }
    } catch (_e) { /* нет seed — пропускаем */ }
    if (seeded) { try { write(merged); } catch (_e) {} }
    return merged;
  } catch (e) {
    return defaults();
  }
}

function write(settings) {
  const dir = ensureDataDir();
  const p = path.join(dir, 'settings.json');
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    // если /data недоступен (локально), попробуем фолбэк
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
      fs.renameSync(tmp, p);
      return true;
    } catch (ee) {
      return false;
    }
  }
}

function merge(base, overrides) {
  const out = JSON.parse(JSON.stringify(base));
  for (const key of Object.keys(overrides || {})) {
    const b = out[key];
    const o = overrides[key];
    if (b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o)) {
      out[key] = merge(b, o);
    } else {
      out[key] = o;
    }
  }
  return out;
}

function addLogEntry(settings, entry) {
  settings.log = settings.log || [];
  settings.log.unshift({ at: new Date().toISOString(), ...entry });
  // держим последние 500 записей
  if (settings.log.length > 500) settings.log.length = 500;
  return settings;
}

module.exports = { read, write, defaults, merge, addLogEntry, dataDir, configPath };
