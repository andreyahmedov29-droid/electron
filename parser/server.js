const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const config = require('./lib/config');
const { runSync, runCheckTable } = require('./lib/sync');
const { ImapClient } = require('./lib/imap');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- состояние ----------
let settings = config.read();
let lastRun = null;   // последний результат синхронизации
let running = false;  // защита от параллельных запусков
let runHistory = [];

// ---------- вспомогательные ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { reject(new Error('payload too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---------- авторизация (заголовки шлюза, вход уже сделан до нас) ----------
// Шлюз платформы проставляет эти заголовки в каждый запрос и срезает
// поддельные X-Vibe-*, поэтому им можно доверять. Свой вход не нужен.
function getUser(req) {
  const rawId = req.headers['x-vibe-user-id'];
  const rawName = req.headers['x-vibe-user-name-encoded'];
  const rawRole = req.headers['x-vibe-user-role'];
  let name = '';
  if (rawName) {
    try { name = decodeURIComponent(rawName); } catch (e) { name = rawName; }
  }
  const role = (rawRole || '').toUpperCase();
  // Локально (без шлюза) заголовков нет — для разработки можно включить роль
  // переменной DEV_ROLE; иначе безопасный дефолт MEMBER (только просмотр).
  const isAdmin = role === 'ADMIN'
    || (!rawRole && String(process.env.DEV_ROLE || '').toUpperCase() === 'ADMIN');
  const isMember = role === 'MEMBER' || role === 'ADMIN' || isAdmin;
  const userId = /^\d+$/.test(rawId || '') ? rawId : null;
  return { userId, name, role, isAdmin, isMember };
}

function requireAdmin(req, res) {
  const user = getUser(req);
  if (!user.isAdmin) {
    sendJson(res, 403, { ok: false, error: 'Доступ запрещён: требуются права администратора' });
    return null;
  }
  return user;
}

async function persist() {
  if (!config.write(settings)) {
    throw new Error('Не удалось сохранить настройки (нет доступа к /data)');
  }
}

function pushLog(entry) {
  settings = config.addLogEntry(settings, entry);
  try { config.write(settings); } catch (e) {}
}

// Получить реальный список папок почтового ящика (по активным настройкам почты).
async function doListFolders() {
  const mail = settings.mail || {};
  if (!mail.enabled || !mail.user || !mail.password) {
    throw new Error('Блок «Яндекс Почта» не настроен — подключите почту, чтобы увидеть папки');
  }
  const client = new ImapClient({
    host: mail.host,
    port: mail.port,
    user: mail.user,
    password: mail.password,
    folder: mail.folder,
    timeout: 15000
  });
  try {
    await client.connect();
    await client.login();
    return await client.listFolders();
  } finally {
    try { client.close(); } catch (e) {}
  }
}

async function doSync() {
  if (running) return { skipped: 'already-running' };
  running = true;
  const started = new Date().toISOString();
  try {
    // Жёсткий таймаут: если чтение почты зависает (медленный IMAP/логин), не
    // блокируем процесс навсегда. По истечении времени бросаем ошибку; finally
    // ниже гарантированно сбросит running, чтобы следующие прогоны снова работали.
    const SYNC_TIMEOUT_MS = 180000; // 3 минуты — чтение почты может быть медленным
    const report = await Promise.race([
      runSync(settings),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('Синхронизация почты не завершилась вовремя (timeout)')),
        SYNC_TIMEOUT_MS
      ))
    ]);
    // накопительный счётчик успешно обработанных писем за всё время
    const successLetters = report.successLetters || 0;
    settings.stats = settings.stats || {};
    settings.stats.successTotal = (settings.stats.successTotal || 0) + successLetters;
    settings.stats.lastRunAt = started;
    try { persist(); } catch (e) {}
    lastRun = {
      started,
      finished: new Date().toISOString(),
      report,
      successTotal: settings.stats.successTotal
    };
    runHistory.unshift(lastRun);
    if (runHistory.length > 50) runHistory.length = 50;
    pushLog({
      kind: 'sync',
      ok: !report.errors.length,
      checked: report.checked,
      matched: report.matched,
      written: report.written,
      successLetters,
      successTotal: settings.stats.successTotal,
      skipped: report.skipped || null,
      need: report.need || [],
      emails: report.emails || [],
      errors: report.errors
    });
    return lastRun;
  } finally {
    running = false;
  }
}

async function doCheckTable() {
  const report = await runCheckTable(settings);
  pushLog({
    kind: 'check-table',
    ok: !report.errors.length,
    checked: report.checked,
    written: report.written,
    matches: report.matches,
    point5Rows: report.point5Rows || [],
    skipped: report.skipped || null,
    need: report.need || [],
    errors: report.errors
  });
  return report;
}

// ---------- маршрутизация /api ----------
async function handleApi(req, res, parsed) {
  const p = parsed.pathname;

  if (req.method === 'GET' && p === '/api/settings') {
    return sendJson(res, 200, { settings: redact(settings), user: getUser(req) });
  }

  // Выгрузка полного бэкапа настроек (включая секреты) файлом settings.json.
  // Только администратор: файл содержит пароли почты и ключи подключения.
  if (req.method === 'GET' && p === '/api/export') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    const body = JSON.stringify(settings, null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="backup-settings-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(body)
    });
    return res.end(body);
  }

  if (req.method === 'POST' && p === '/api/settings') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const body = JSON.parse(await readBody(req));
      // Сохраняем прежние секреты — они в ответе всегда маскируются,
      // и клиент может переслать маску обратно, не меняя секрет.
      const prev = {
        mailPassword: settings.mail && settings.mail.password,
        saJson: settings.table && settings.table.serviceAccountJson,
        apiKey: settings.table && settings.table.apiKey
      };
      // мержим осторожно, не теряя логи
      const log = settings.log;
      settings = config.merge(config.defaults(), body);
      settings.log = log;
      // Если клиент прислал маску вместо настоящего секрета — восстанавливаем прежний.
      if (settings.mail && settings.mail.password === '••••••••') {
        settings.mail.password = prev.mailPassword || '';
      }
      if (settings.table && settings.table.serviceAccountJson === '••••••••') {
        settings.table.serviceAccountJson = prev.saJson || '';
      }
      if (settings.table && settings.table.apiKey === '••••••••') {
        settings.table.apiKey = prev.apiKey || '';
      }
      await persist();
      return sendJson(res, 200, { ok: true, settings: redact(settings) });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/sync') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const r = await doSync();
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'POST' && p === '/api/check-table') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const r = await doCheckTable();
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && p === '/api/log') {
    const limit = parseInt(parsed.query.get ? parsed.query.get('limit') : (parsed.query.limit || '100'), 10) || 100;
    return sendJson(res, 200, { log: (settings.log || []).slice(0, limit) });
  }

  if (req.method === 'GET' && p === '/api/folders') {
    const admin = requireAdmin(req, res);
    if (!admin) return;
    try {
      const folders = await doListFolders();
      return sendJson(res, 200, { ok: true, folders });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

// маскируем пароль в выдаче
function redact(s) {
  const out = JSON.parse(JSON.stringify(s));
  if (out.mail) {
    out.mail.password = out.mail.password ? '••••••••' : '';
  }
  if (out.table && out.table.serviceAccountJson) {
    out.table.serviceAccountJson = out.table.serviceAccountJson ? '••••••••' : '';
  }
  if (out.table && out.table.apiKey) {
    out.table.apiKey = out.table.apiKey ? '••••••••' : '';
  }
  return out;
}

// ---------- раздача статики ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res, parsed) {
  let p = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  let file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- сервер ----------
// Смонтированный в BIOTIME модуль: request-функция вместо самостоятельного
// http-сервера. Порт/запуск даёт BIOTIME; префикс /parser срезается, чтобы
// внутренние /api/* и статика матчились как у отдельного приложения.
function handleRequest(req, res) {
  const parsed = new url.URL(req.url || '/', 'http://localhost');
  parsed.pathname = (parsed.pathname || '/').replace(/^\/parser/, '') || '/';
  // promisify get
  parsed.query = Object.fromEntries(parsed.searchParams);
  parsed.query.get = (k) => parsed.searchParams.get(k);
  if (parsed.pathname.startsWith('/api/')) {
    return handleApi(req, res, parsed);
  }
  return serveStatic(req, res, parsed);
}

module.exports = handleRequest;

// ---------- планировщик ----------
function scheduleNext() {
  const minutes = (settings.mail && settings.mail.pollMinutes) || 5;
  const ms = Math.max(1, minutes) * 60 * 1000;
  setTimeout(async () => {
    try {
      if (settings.mail && settings.mail.enabled) {
        await doSync();
      }
    } catch (e) {}
    scheduleNext();
  }, ms);
}

// планировщик правила проверки таблицы (по своему интервалу)
function scheduleCheckNext() {
  const minutes = (settings.checkTable && settings.checkTable.intervalMin) || 5;
  const ms = Math.max(1, minutes) * 60 * 1000;
  setTimeout(async () => {
    try {
      if (settings.checkTable && settings.checkTable.enabled) {
        await doCheckTable();
      }
    } catch (e) {}
    scheduleCheckNext();
  }, ms);
}

// Очистить журнал: удалить записи за предыдущие дни (оставить только сегодняшние).
function cleanupLog() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const before = (settings.log || []).length;
  settings.log = (settings.log || []).filter((e) => {
    const t = new Date(e.at).getTime();
    return !isNaN(t) && t >= startOfToday;
  });
  if (settings.log.length !== before) {
    try { config.write(settings); } catch (e) {}
  }
  return settings.log.length;
}

// Запланировать очистку журнала: первый запуск в ближайшие 23:59, далее —
// каждые 3 дня в 23:59 (удаляем записи за предыдущие дни).
function scheduleLogCleanupNext() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).getTime();
  let wait = target - now.getTime();
  if (wait <= 0) {
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 0).getTime();
    wait = next - now.getTime();
  }
  setTimeout(async () => {
    try { cleanupLog(); } catch (e) {}
    scheduleLogCleanupStreak();
  }, wait);
}

// Последующие запуски очистки — каждые 3 дня (72 ч) в то же время 23:59.
function scheduleLogCleanupStreak() {
  setTimeout(async () => {
    try { cleanupLog(); } catch (e) {}
    scheduleLogCleanupStreak();
  }, 3 * 24 * 60 * 60 * 1000);
}

// защита от двойного запуска цикла при рестартах
const SCHED_INIT = process.env.DISABLE_SCHED !== '1';
if (SCHED_INIT) {
  scheduleNext();
  scheduleCheckNext();
  scheduleLogCleanupNext();
}
