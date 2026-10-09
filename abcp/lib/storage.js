'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');

// Учётка клиентского API ABCP (для отправки писем/запросов) больше не зашита в
// настройки: значение берётся из переменных окружения, а чтобы продолжать
// работать без ручного ввода — по умолчанию подставляются действующие значения.
// Позже их можно переопределить через ABCP_CLIENT_LOGIN / ABCP_CLIENT_MD5.
const ABCP_CLIENT_LOGIN = process.env.ABCP_CLIENT_LOGIN || 'aa@1-de.ru';
const ABCP_CLIENT_MD5 = process.env.ABCP_CLIENT_MD5 || '0b902ab190be360f155e4f5ed486e52e';

const DEFAULT_SETTINGS = {
  host: '',
  login: '',
  md5Password: '',
  clientLogin: ABCP_CLIENT_LOGIN,
  clientMd5: ABCP_CLIENT_MD5,
  dateStart: '',
  dateEnd: '',
  reportPeriod: { start: '', end: '' },
  rejPeriod: { start: '', end: '' },
  crjPeriod: { start: '', end: '' },
  dashPeriod: { start: '', end: '' },
  termsPeriod: { start: '', end: '' },
  pricingPeriod: { start: '', end: '' },
  completedStatusCodes: [],
  excludedDistributors: [],
  statusesTouched: false,
  manualAutomatAuto: false,
  manualAutomatSuppliers: [],
  supplierEmails: {},
  smtp: {},
  // Главные администраторы приложения: их нельзя удалить или понизить.
  // По умолчанию только Ахмедов Андрей (защищён в коде).
  superAdmins: [{ name: 'Ахмедов Андрей' }],
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Настройки переживают публикации только в /data (единственный сохраняемый том).
// Метод НЕ должен бросать: если /data недоступен, приложение переживает на
// локальной папке, а не падает при старте (иначе платформа рестартует процесс
// по кругу и шлюз отвечает BH_APP_STARTING).
function resolveDataDir() {
  if (process.env.DATA_DIR) {
    try {
      return ensureDir(process.env.DATA_DIR);
    } catch (_e) {
      console.error('Не удалось использовать DATA_DIR, переключаюсь на локальную папку:', _e.message);
    }
  }
  if (process.platform !== 'win32') {
    try {
      return ensureDir('/data');
    } catch (_e) {
      // нет прав на /data — падаем на локальную папку приложения
    }
  }
  return ensureDir(path.join(__dirname, '..', 'data'));
}

function settingsFile() {
  // Отдельный файл, чтобы настройки «Отчётов» (ABCP/SMTP) не конфликтовали
  // с настройками других встроенных модулей (у «Парсера» свой файл).
  return path.join(resolveDataDir(), 'abcp-settings.json');
}

function reportPath(name) {
  return path.join(resolveDataDir(), 'reports', `${name}.json`);
}

function usersFile() {
  return path.join(resolveDataDir(), 'users.json');
}

function ordersCacheFile() {
  return path.join(resolveDataDir(), 'orders-cache.json');
}

// Верхний предел размера постоянного кэша. Если файл больше — не читаем его
// вообще: JSON.parse такого файла на платформе сheap ~256МБ роняет процесс
// (FATAL ERROR: JavaScript heap out of memory). Пустой кэш безопаснее краша.
const PERSISTENT_ORDERS_MAX_BYTES = 400 * 1024 * 1024; // 400 МБ — сервер 8 ГБ, хватает на несколько лет
const PERSISTENT_ORDERS_MAX_COUNT = 500000; // предел числа заказов при записи

let persistentOrdersCache = null;
let persistentWarmPromise = null;
// Постоянный кэш заказов (переживает деплой), чтобы догружать только новые дни.
// Хранится в памяти после первого чтения, чтобы не блокировать сервер повторным
// синхронным парсингом большого файла на каждый запрос (это вызывало BH_APP_STARTING).
function readPersistentOrders() {
  if (persistentOrdersCache) return persistentOrdersCache;
  let res = { orders: [], coveredStart: '', coveredEnd: '' };
  try {
    const size = fs.statSync(ordersCacheFile()).size;
    if (size <= PERSISTENT_ORDERS_MAX_BYTES) {
      const d = JSON.parse(fs.readFileSync(ordersCacheFile(), 'utf8'));
      res = { orders: Array.isArray(d.orders) ? d.orders : [], coveredStart: d.coveredStart || '', coveredEnd: d.coveredEnd || '' };
    } else {
      console.warn('orders-cache.json слишком большой (' + size + ' байт) — пропускаю кэш, чтобы не исчерпать память.');
    }
  } catch (_e) { /* файл ещё нет/битый */ }
  persistentOrdersCache = res;
  return res;
}

// Асинхронная предзагрузка постоянного кэша при старте сервера: первый
// HTTP-запрос после подъёма не блокируется на синхронном чтении большого
// файла (иначе шлюз обрывает его как BH_APP_STARTING / «приложение перезагружается»).
function warmPersistentOrders() {
  if (persistentOrdersCache) return Promise.resolve(persistentOrdersCache);
  if (persistentWarmPromise) return persistentWarmPromise;
  persistentWarmPromise = fsp.stat(ordersCacheFile())
    .then((st) => {
      if (st.size > PERSISTENT_ORDERS_MAX_BYTES) {
        console.warn('orders-cache.json слишком большой (' + st.size + ' байт) — обхожу кэш, чтобы не исчерпать память.');
        persistentOrdersCache = { orders: [], coveredStart: '', coveredEnd: '' };
        return persistentOrdersCache;
      }
      return fsp.readFile(ordersCacheFile(), 'utf8').then((t) => {
        try {
          const d = JSON.parse(t);
          persistentOrdersCache = {
            orders: Array.isArray(d.orders) ? d.orders : [],
            coveredStart: d.coveredStart || '',
            coveredEnd: d.coveredEnd || '',
          };
        } catch (_e) {
          persistentOrdersCache = { orders: [], coveredStart: '', coveredEnd: '' };
        }
      }).catch(() => {
        persistentOrdersCache = { orders: [], coveredStart: '', coveredEnd: '' };
      });
    })
    .catch(() => {
      persistentOrdersCache = { orders: [], coveredStart: '', coveredEnd: '' };
    });
  return persistentWarmPromise;
}

// Идёт ли сейчас асинхронная загрузка постоянного кэша (ещё не прочитан).
function isPersistentWarming() {
  return !persistentOrdersCache && !!persistentWarmPromise;
}

// Отдаёт управление event loop, чтобы сервер продолжал отвечать на проверки шлюза
// во время большой фоновой работы (записи/сериализации массива заказов).
const yieldToLoop = () => new Promise((r) => setImmediate(r));

// Записывает большой массив заказов на диск порциями, каждые N элементов отдавая
// управление event loop. Синхронная запись всего кэша одной операцией блокировала
// сервер и приводила к тому, что шлюз видел «app is not answering» (BH_APP_STARTING).
function writePersistentOrders(orders, coveredStart, coveredEnd) {
  // Ограничиваем кэш, чтобы он не раздувался до сотен МБ: храним максимум
  // последние MAX_COUNT заказов (самые свежие по дате).
  let list = Array.isArray(orders) ? orders : [];
  if (list.length > PERSISTENT_ORDERS_MAX_COUNT) {
    list = list.slice(-PERSISTENT_ORDERS_MAX_COUNT);
  }
  let cs = coveredStart;
  const md = minDateOf(list);
  if (md && (!cs || md > cs)) cs = md;
  // В памяти кэш обновляем сразу, чтобы чтения никогда не ждали диск.
  persistentOrdersCache = { orders: list, coveredStart: cs, coveredEnd };
  const file = ordersCacheFile();
  const tmp = `${file}.tmp`;
  writeOrdersJsonToFile(tmp, list, cs, coveredEnd)
    .then(() => fsp.rename(tmp, file))
    .catch((_e) => { /* не критично — кэш в памяти уже актуален */ });
}

// Объединяет два массива заказов по id (порядок сохранён, заказы без id не теряются).
// При совпадении id побеждает значение из b — это свежедогруженные заказы (например,
// перечитанный «хвост» последних дней при обновлении), чтобы новые данные не затирались старым кэшем.
function mergeOrderLists(a, b) {
  const key = (o) => {
    if (o && o.id != null) return 'i:' + o.id;
    if (o && o.number != null) return 'n:' + (o.date || '') + '|' + o.number;
    return '';
  };
  const seen = new Set();
  const out = [];
  for (const arr of [b, a]) {
    for (const o of arr || []) {
      const k = key(o);
      if (k) {
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(o);
    }
  }
  return out;
}

function minDateOf(orders) {
  let m = '';
  for (const o of orders || []) {
    const d = String(o && o.date || '').slice(0, 10);
    if (d && (!m || d < m)) m = d;
  }
  return m;
}

async function writeOrdersJsonToFile(tmp, orders, coveredStart, coveredEnd) {
  const list = Array.isArray(orders) ? orders : [];
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  const handle = await fsp.open(tmp, 'w');
  const write = (s) => handle.write(Buffer.from(s, 'utf8'));
  try {
    await write(`{"orders":[`);
    let first = true;
    for (let i = 0; i < list.length; i++) {
      if ((i % 2000) === 0) await yieldToLoop(); // держим сервер отзывчивым
      if (!first) await write(',');
      first = false;
      await write(JSON.stringify(list[i]));
    }
    await write('],"coveredStart":');
    await write(JSON.stringify(coveredStart || ''));
    await write(',"coveredEnd":');
    await write(JSON.stringify(coveredEnd || ''));
    await write('}');
  } finally {
    await handle.close();
  }
}

// Пользователи приложения (логин + scrypt-хеш пароля + роль). Храним в /data,
// чтобы переживали перезапуск. Пароль в открытом виде не сохраняется.
function readUsers() {
  try {
    const raw = JSON.parse(fs.readFileSync(usersFile(), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_e) {
    return [];
  }
}

function writeUsers(users) {
  atomicWrite(usersFile(), users);
}

// Готовые снимки отчётов храним на диске в /data, чтобы они переживали перезапуск
// приложения и отдавались мгновенно без повторного обращения к ABCP.
function readReportSnapshot(name, key) {
  try {
    const raw = fs.readFileSync(reportPath(name), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.key !== key) return null;
    return parsed.data || null;
  } catch (_e) {
    return null;
  }
}

function writeReportSnapshot(name, key, data) {
  try {
    const file = reportPath(name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key, data }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_e) {
    // сбой записи снапшота не критичен — кэш в памяти всё равно работает
  }
}

function ordersPath(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(resolveDataDir(), 'orders', `${hash}.json`);
}

// Сырые заказы периода сохраняем на диск, чтобы перезапуск не тянул их заново из ABCP.
function readOrdersSnapshot(key) {
  try {
    const raw = fs.readFileSync(ordersPath(key), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.key !== key || !Array.isArray(parsed.orders)) return null;
    return parsed.orders;
  } catch (_e) {
    return null;
  }
}

function writeOrdersSnapshot(key, orders) {
  try {
    const file = ordersPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ key, orders }), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_e) {
    // не критично — кэш в памяти всё равно работает
  }
}

function termsCachePath() {
  return path.join(resolveDataDir(), 'terms-cache.json');
}

// Кэш вычисленных сроков поставщиков: при деплое/перезапуске не пересчитываем.
function readTermsCache() {
  try {
    const raw = fs.readFileSync(termsCachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.suppliers)) return null;
    return parsed;
  } catch (_e) {
    return null;
  }
}

function writeTermsCache(data) {
  try {
    const file = termsCachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_e) {
    // не критично
  }
}

// Полная очистка кэша сроков — чтобы следующий расчёт шёл с нуля.
function clearTermsCache() {
  try {
    const file = termsCachePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_e) {
    /* не критично */
  }
}

// Дата/время отправки запроса срока по каждой позиции (переживает деплой в /data).
function requestedFile() {
  return path.join(resolveDataDir(), 'requested.json');
}

function readRequested() {
  try {
    const d = JSON.parse(fs.readFileSync(requestedFile(), 'utf8'));
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  } catch (_e) {
    return {};
  }
}

function writeRequested(map) {
  try {
    const file = requestedFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(map), 'utf8');
    fs.renameSync(tmp, file);
  } catch (_e) {
    /* не критично */
  }
}

let currentUserId = '';

function setCurrentUser(userId) {
  currentUserId = userId || '';
}

function globalSettingsFile() {
  return path.join(resolveDataDir(), 'abcp-settings.json');
}

function userSettingsFile(uid) {
  return path.join(resolveDataDir(), `settings-${uid}.json`);
}

function safeRead(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return {};
  }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function supplierEmailsFile() {
  return path.join(resolveDataDir(), 'supplier-emails.json');
}

function mergeEmailMaps(a, b) {
  const norm = (e) => String(e || '').trim().toLowerCase();
  const out = {};
  const add = (name, arr) => {
    const cur = out[name] || [];
    const seen = new Set(cur.map(norm));
    for (const e of arr || []) {
      const n = norm(e);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      cur.push(String(e).trim());
    }
    out[name] = cur;
  };
  for (const k of Object.keys(a || {})) add(k, Array.isArray(a[k]) ? a[k] : [a[k]]);
  for (const k of Object.keys(b || {})) add(k, Array.isArray(b[k]) ? b[k] : [b[k]]);
  return out;
}

// Отдельный постоянный кэш почт поставщиков в /data: переживает деплой даже
// если settings.json по какой-то причине обновится без почт.
function readSupplierEmails() {
  try {
    const d = JSON.parse(fs.readFileSync(supplierEmailsFile(), 'utf8'));
    return (d && typeof d === 'object') ? d : {};
  } catch (_e) {
    return {};
  }
}

function writeSupplierEmails(map) {
  try {
    atomicWrite(supplierEmailsFile(), map || {});
  } catch (_e) { /* не критично */ }
}

// Подключение к ABCP храним глобально, а временные отрезки и фильтры — per-user:
// изменения одного пользователя не сбивают настройки других.
function readSettings() {
  const legacy = safeRead(globalSettingsFile());
  if (!currentUserId) return { ...DEFAULT_SETTINGS, ...legacy };
  const user = safeRead(userSettingsFile(currentUserId));
  const merged = { ...DEFAULT_SETTINGS, ...legacy, ...user };
  merged.host = legacy.host || user.host || '';
  merged.login = legacy.login || user.login || '';
  merged.md5Password = legacy.md5Password || user.md5Password || '';
  if (legacy.smtp && legacy.smtp.host) merged.smtp = legacy.smtp;
  if (legacy.supplierEmails && Object.keys(legacy.supplierEmails).length) merged.supplierEmails = legacy.supplierEmails;
  const seFile = readSupplierEmails();
  if (seFile && Object.keys(seFile).length) {
    merged.supplierEmails = mergeEmailMaps(merged.supplierEmails || {}, seFile);
  }
  return merged;
}

function writeSettings(settings) {
  const {
    host, login, md5Password, smtp, supplierEmails,
    manualAutomatAuto, manualAutomatSuppliers, ...rest
  } = settings;
  // Подключение, SMTP и почты поставщиков храним глобально. Периоды (включая
  // euPeriod) — ПЕРСОНАЛЬНЫЕ: кладём их в файл конкретного пользователя, чтобы
  // смена календаря одним пользователем не сбивала периоды у остальных.
  const userRest = { ...(rest || {}) };
  const connect = {
    host, login, md5Password,
    ...(typeof manualAutomatAuto === 'boolean' ? { manualAutomatAuto } : {}),
    ...(Array.isArray(manualAutomatSuppliers) ? { manualAutomatSuppliers } : {}),
    ...(smtp && typeof smtp === 'object' ? { smtp } : {}),
    ...(supplierEmails && typeof supplierEmails === 'object' ? { supplierEmails } : {}),
  };
  const legacy = safeRead(globalSettingsFile());
  atomicWrite(globalSettingsFile(), { ...legacy, ...connect });
  if (currentUserId) atomicWrite(userSettingsFile(currentUserId), userRest);
  writeSupplierEmails(supplierEmails);
}

// Публичное представление без секрета: пароль маскируется до последних 4 символов.
function toPublicSettings(settings) {
  const pw = settings.md5Password || '';
  return {
    host: settings.host,
    login: settings.login,
    hasPassword: pw.length > 0,
    passwordTail: pw.length > 4 ? pw.slice(-4) : (pw ? pw : ''),
    dateStart: settings.dateStart,
    dateEnd: settings.dateEnd,
    reportPeriod: settings.reportPeriod || { start: '', end: '' },
    rejPeriod: settings.rejPeriod || { start: '', end: '' },
    crjPeriod: settings.crjPeriod || { start: '', end: '' },
    dashPeriod: settings.dashPeriod || { start: '', end: '' },
    termsPeriod: settings.termsPeriod || { start: '', end: '' },
    pricingPeriod: settings.pricingPeriod || { start: '', end: '' },
    caPeriod: settings.caPeriod || { start: '', end: '' },
    euPeriod: settings.euPeriod || { start: '', end: '' },
    manualAutomatSuppliers: Array.isArray(settings.manualAutomatSuppliers) ? settings.manualAutomatSuppliers : [],
    manualAutomatAuto: settings.manualAutomatAuto === true,
    completedStatusCodes: settings.completedStatusCodes || [],
    excludedDistributors: settings.excludedDistributors || [],
    statusesTouched: settings.statusesTouched === true,
    supplierEmails: settings.supplierEmails || {},
    superAdmins: settings.superAdmins && settings.superAdmins.length
      ? settings.superAdmins
      : [{ name: 'Ахмедов Андрей' }],
    smtp: {
      host: (settings.smtp && settings.smtp.host) || '',
      port: (settings.smtp && settings.smtp.port) || 587,
      secure: !!(settings.smtp && settings.smtp.secure),
      user: (settings.smtp && settings.smtp.user) || '',
      hasPass: !!(settings.smtp && settings.smtp.pass),
      fromEmail: (settings.smtp && settings.smtp.fromEmail) || '',
    },
  };
}

function isConfigured(settings) {
  return Boolean(settings.host && settings.login && settings.md5Password);
}

// Накопительная статистика «Ручного автомата»: сколько позиций/заказов уже
// отправлено («Принят» → «Заказан») и на какую сумму. Хранится в /data, поэтому
// переживает передеплои. Ключ — дата (YYYY-MM-DD); ordersList — номера заказов.
function automatStatsFile() {
  return path.join(resolveDataDir(), 'automat-stats.json');
}

function readAutomatStats() {
  try {
    const d = JSON.parse(fs.readFileSync(automatStatsFile(), 'utf8'));
    return (d && typeof d === 'object' && d.byDay && typeof d.byDay === 'object') ? d : { byDay: {} };
  } catch (_e) {
    return { byDay: {} };
  }
}

// Прибавляет к статистике сегодняшнего дня отправленные позиции.
// entries: [{ positionId, qty, sum, orderNumber, client, margin }...]
// Одна и та же позиция за день учитывается только один раз (дедупликация по positionId).
function recordAutomatStats(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const stats = readAutomatStats();
  const byDay = stats.byDay;
  let day = byDay[date];
  // Старая схема (плоские поля) мигрируется в { total, clients }.
  if (!day || !day.total) {
    day = (day && day.positions != null)
      ? { total: { positions: day.positions || 0, qty: day.qty || 0, sum: day.sum || 0, orders: 0, ordersList: [], positionIds: [] }, clients: {} }
      : { total: { positions: 0, qty: 0, sum: 0, orders: 0, ordersList: [], positionIds: [] }, clients: {} };
  }
  const ordersSet = new Set(day.total.ordersList || []);
  for (const e of entries) {
    const pid = e.positionId != null ? String(e.positionId) : '';
    if (pid && Array.isArray(day.total.positionIds) && day.total.positionIds.includes(pid)) continue; // уже учтено
    if (pid) (day.total.positionIds = day.total.positionIds || []).push(pid);
    day.total.positions += 1;
    day.total.qty += Number(e.qty) || 0;
    day.total.sum += Number(e.sum) || 0;
    if (e.orderNumber) ordersSet.add(String(e.orderNumber));
    const cn = e.client || '—';
    const cl = day.clients[cn] || { positions: 0, qty: 0, sum: 0, margin: 0, ordersList: [] };
    cl.positions += 1;
    cl.qty += Number(e.qty) || 0;
    cl.sum += Number(e.sum) || 0;
    cl.margin += Number(e.margin) || 0;
    if (e.orderNumber && !cl.ordersList.includes(String(e.orderNumber))) cl.ordersList.push(String(e.orderNumber));
    day.clients[cn] = cl;
  }
  day.total.orders = ordersSet.size;
  day.total.ordersList = Array.from(ordersSet);
  byDay[date] = day;
  atomicWrite(automatStatsFile(), { byDay });
}

// Публичное представление: сегодня, итог и последние дни (для фронта).
function automatStatsPublic() {
  const byDay = readAutomatStats().byDay;
  const today = new Date().toISOString().slice(0, 10);
  const days = Object.keys(byDay).sort();
  const recent = days.slice(-14).reverse().map((d) => {
    const x = byDay[d];
    const t = x && x.total ? x.total : x;
    return {
      date: d,
      positions: (t && t.positions) || 0,
      qty: (t && t.qty) || 0,
      sum: Math.round(((t && t.sum) || 0) * 100) / 100,
      orders: (t && t.orders) || 0,
    };
  });
  const total = { positions: 0, qty: 0, sum: 0, orders: 0 };
  for (const d of days) {
    const x = byDay[d];
    const t = x && x.total ? x.total : x;
    total.positions += (t && t.positions) || 0;
    total.qty += (t && t.qty) || 0;
    total.sum += (t && t.sum) || 0;
    total.orders += (t && t.orders) || 0;
  }
  total.sum = Math.round(total.sum * 100) / 100;
  const td = byDay[today];
  const todayTotal = td && (td.total || td);
  // Клиенты сегодня — сортируем по сумме убыванию, с маржой и процентом.
  const clientMap = (td && td.clients) || {};
  const todayClients = Object.keys(clientMap).map((cn) => {
    const c = clientMap[cn];
    const sum = c.sum || 0;
    return {
      client: cn,
      orders: (c.ordersList || []).length,
      qty: c.qty || 0,
      sum: Math.round(sum * 100) / 100,
      margin: Math.round((c.margin || 0) * 100) / 100,
      marginPct: sum ? Math.round(((c.margin || 0) / sum) * 1000) / 10 : 0,
    };
  }).sort((a, b) => b.sum - a.sum);
  return {
    today: td
      ? {
          positions: (todayTotal && todayTotal.positions) || 0,
          qty: (todayTotal && todayTotal.qty) || 0,
          sum: Math.round(((todayTotal && todayTotal.sum) || 0) * 100) / 100,
          orders: (todayTotal && todayTotal.orders) || 0,
        }
      : { positions: 0, qty: 0, sum: 0, orders: 0 },
    todayClients,
    total,
    recent,
  };
}

// Кэш сроков маршрутов поставщиков (по имени): источник истины для колонки
// «Срок мин/макс». Исторические позиции заказов не меняются при обновлении
// маршрута, поэтому макс. срок после записи в ABCP читаем из cp/routes.
function routeTermsFile() {
  return path.join(resolveDataDir(), 'route-terms.json');
}

function readRouteTerms() {
  try {
    const d = JSON.parse(fs.readFileSync(routeTermsFile(), 'utf8'));
    return (d && typeof d === 'object') ? d : {};
  } catch (_e) {
    return {};
  }
}

// routeTerms: объект { имя поставщика: { minDays, maxDays, ts } }
function writeRouteTerms(routeTerms) {
  atomicWrite(routeTermsFile(), routeTerms || {});
}

module.exports = {
  DEFAULT_SETTINGS,
  readSettings,
  writeSettings,
  toPublicSettings,
  isConfigured,
  resolveDataDir,
  readReportSnapshot,
  writeReportSnapshot,
  readOrdersSnapshot,
  writeOrdersSnapshot,
  readTermsCache,
  writeTermsCache,
  clearTermsCache,
  readRequested,
  writeRequested,
  readUsers,
  writeUsers,
  readPersistentOrders,
  writePersistentOrders,
  mergeOrderLists,
  readSupplierEmails,
  writeSupplierEmails,
  warmPersistentOrders,
  isPersistentWarming,
  setCurrentUser,
  readAutomatStats,
  recordAutomatStats,
  automatStatsPublic,
  readRouteTerms,
  writeRouteTerms,
};
