'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const crypto = require('node:crypto');

const storage = require('./lib/storage');
const { makeCache, isSnapFresh } = require('./lib/cache');
const { subtractDays, periodedSettings } = require('./lib/periods');
const { makeReportHandlers } = require('./lib/reports');
const { makeSupplierTermsHandlers } = require('./lib/supplier-terms');
const { makeShipDates } = require('./lib/ship');
const { makeManualAutomat } = require('./lib/manual-automat');
const { makeOrderLoader } = require('./lib/order-loader');
const abcp = require('./lib/abcp');
const { sendMail } = require('./lib/mailer');
const { buildXlsx } = require('./lib/xlsx');

// Метка актуальной сборки: по ней легко проверить, что на сайте развёрнута свежая версия.
const APP_VERSION = '2026-09-29.21';

// Личность пользователя, которую проставляет шлюз Black Hole на каждый запрос.
function identity(req) {
  const rawName = req.headers['x-vibe-user-name-encoded'] || req.headers['x-vibe-user-name'] || '';
  let name = '';
  try {
    name = decodeURIComponent(rawName);
  } catch (_e) {
    name = rawName;
  }
  return {
    id: String(req.headers['x-vibe-user-id'] || '').trim(),
    name: name.trim(),
    role: String(req.headers['x-vibe-user-role'] || '').trim(),
  };
}

// Проверка, является ли пользователь главным администратором (супер-админом).
function isSuperAdmin(ident, settings) {
  const supers = (settings && settings.superAdmins) && settings.superAdmins.length
    ? settings.superAdmins
    : [{ name: 'Ахмедов Андрей' }];
  // Сравниваем по набору слов в любом порядке — «Ахмедов Андрей» == «Андрей Ахмедов».
  const norm = (s) => String(s || '').toLowerCase().split(/[\s,]+/).filter(Boolean).sort().join(' ');
  return supers.some((s) =>
    (s && s.id && ident.id && String(s.id) === ident.id) ||
    (s && s.name && ident.name && norm(s.name) === norm(ident.name))
  );
}

// Защита главного администратора: супер-админа нельзя удалить или снять роль.
// Вызывать в любой операции управления пользователями до изменения.
function superAdminGuard(ident, settings, targetId, targetName) {
  const target = {
    id: targetId != null ? String(targetId) : '',
    name: String(targetName || ''),
  };
  if (isSuperAdmin(target, settings)) {
    const e = new Error('Главного администратора нельзя удалить или снять его роль.');
    e.status = 403;
    throw e;
  }
}

/* ---------------- Вход по логину/паролю и управление пользователями ---------------- */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов
const SESSION_COOKIE = 'ap_sid'; // не «session» — это имя занято кукой платформы
const sessions = new Map(); // токен -> {userId, login, name, role, expires}
// При имперсонации запоминаем исходную админ-сессию, чтобы «Выйти» вернул в неё.
const impersonationOrigin = new Map(); // токен(имперсонация) -> сессия админа

// Защита от перебора пароля: не более LOGIN_MAX неудачных попыток с одного IP и на
// один логин за окно LOGIN_WINDOW_MS, после чего — временная блокировка.
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginThrottle = new Map();
function loginThrottleKey(req, login) {
  const ip = req.socket.remoteAddress || '';
  return ip + ':' + String(login || '').toLowerCase();
}
function checkLoginThrottle(key) {
  const e = loginThrottle.get(key);
  if (e && e.count >= LOGIN_MAX && Date.now() < e.resetAt) {
    return { blocked: true, retryAfter: Math.ceil((e.resetAt - Date.now()) / 1000) };
  }
  return { blocked: false };
}
function noteLoginThrottle(key) {
  const now = Date.now();
  let e = loginThrottle.get(key);
  if (!e || now >= e.resetAt) e = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  e.count += 1;
  loginThrottle.set(key, e);
}
const SECTION_KEYS = ['dashboard', 'terms', 'pricing', 'report', 'rejections', 'client-rejections', 'client-analysis', 'europe', 'client-config', 'manual-automat', 'supplier-emails'];
function persistSessions() {
  try {
    fs.writeFileSync(path.join(storage.resolveDataDir(), 'sessions.json'), JSON.stringify(Array.from(sessions.entries())));
  } catch (_e) { /* ignore */ }
}
try {
  const saved = JSON.parse(fs.readFileSync(path.join(storage.resolveDataDir(), 'sessions.json'), 'utf8'));
  if (Array.isArray(saved)) {
    for (const [tok, s] of saved) {
      if (s && s.expires > Date.now()) sessions.set(tok, s);
    }
  }
} catch (_e) { /* файл ещё не существует */ }
const LOG_MAX = 3000;
const logBuffer = [];
let currentTaskId = null;
let currentLogCat = 'general';
function setLogScope(id, cat) { currentTaskId = id; currentLogCat = cat; }
function clearLogScope() { currentTaskId = null; currentLogCat = 'general'; }
let logQueue = [];
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function persistLogs() {
  try {
    // Пишем по файлу на день: так история прошлых дней не затирается капом.
    const byDay = {};
    for (const e of logBuffer.slice(-LOG_MAX)) {
      const d = String((e && e.ts) || '').slice(0, 10) || todayStr();
      (byDay[d] = byDay[d] || []).push(e);
    }
    for (const d of Object.keys(byDay)) {
      fs.writeFileSync(path.join(storage.resolveDataDir(), 'logs-' + d + '.json'), JSON.stringify(byDay[d]));
    }
  } catch (_e) { /* ignore */ }
}
function readDayLogs(date) {
  try {
    const raw = fs.readFileSync(path.join(storage.resolveDataDir(), 'logs-' + String(date || '') + '.json'), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_e) {
    return [];
  }
}
// Журнал приложения (для вкладок «Логи»: Почта и ABCP). Категория (cat) делит
// записи: 'mail' — письма/снятие/запрос срока, 'abcp' — загрузка данных ABCP,
// 'general' — служебное. Если cat явно не передан, наследуется из контекста задачи.
function log(level, msg, extra, cat) {
  let taskId = null;
  let category = 'general';
  if (extra && typeof extra === 'object') {
    taskId = extra.taskId || null;
    if (extra.cat) category = extra.cat;
  } else {
    taskId = extra || null;
    if (cat) category = cat;
  }
  if (category === 'general' && currentLogCat && currentLogCat !== 'general') category = currentLogCat;
  const entry = { ts: new Date().toISOString(), level: String(level || 'info'), msg: String(msg), taskId: taskId || currentTaskId || null, cat: category };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
  if (level === 'error') console.error('[app]', msg);
  else console.log('[app]', msg);
  logQueue.push(true);
  if (logQueue.length >= 5) {
    logQueue = [];
    persistLogs();
  }
}
// Восстанавливаем сохранённые логи после перезапуска (переживают деплой).
try {
  let saved = null;
  const dayFile = path.join(storage.resolveDataDir(), 'logs-' + todayStr() + '.json');
  try {
    saved = JSON.parse(fs.readFileSync(dayFile, 'utf8'));
  } catch (_e) {
    // Файла дня ещё нет — подхватываем однофайловый журнал прошлых версий (logs.json);
    // при следующей записи он автоматически разъедется по дням.
    try { saved = JSON.parse(fs.readFileSync(path.join(storage.resolveDataDir(), 'logs.json'), 'utf8')); }
    catch (_e2) { saved = null; }
  }
  if (Array.isArray(saved)) logBuffer.push(...saved.slice(-LOG_MAX));
} catch (_e) { /* файл ещё не существует */ }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = Buffer.from(hashPassword(password, salt), 'hex');
  const expect = Buffer.from(hash, 'hex');
  return test.length === expect.length && crypto.timingSafeEqual(test, expect);
}

function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashPassword(password, salt)}`;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function publicUser(u) {
  return { id: u.id, login: u.login, name: u.name || u.login, role: u.role || 'user', sections: u.sections || [] };
}

function getSession(req) {
  // Встроенный в BIOTIME режим: сессию даёт BIOTIME через req._biotimeSession.
  // Возвращаем её как админ-сессию модуля, чтобы проверки ролей (например для
  // сохранения настроек) не падали из-за отсутствия собственной ap_sid-сессии.
  if (req && req._biotimeSession) {
    return {
      userId: String(req._biotimeSession.userId || ''),
      login: String(req._biotimeSession.name || '') || ('user' + String(req._biotimeSession.userId || '')),
      name: String(req._biotimeSession.name || 'Пользователь'),
      role: 'admin',
      expires: Date.now() + SESSION_TTL_MS,
    };
  }
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginEndpoint(req, res) {
  const body = await readBody(req).catch(() => '{}');
  let login = '';
  let password = '';
  try {
    const parsed = JSON.parse(body || '{}');
    login = String(parsed.login || '').trim();
    password = String(parsed.password || '');
  } catch (_e) { /* ignore */ }
  if (!login || !password) return sendJson(res, 400, { error: 'Введите логин и пароль' });
  const thrKey = loginThrottleKey(req, login);
  const thr = checkLoginThrottle(thrKey);
  if (thr.blocked) {
    return sendJson(res, 429, { error: 'Слишком много попыток входа. Повторите позже.', retryAfter: thr.retryAfter });
  }
  const users = storage.readUsers();
  const u = users.find((x) => String(x.login).toLowerCase() === login.toLowerCase());
  if (!u || !verifyPassword(password, u.passwordHash)) {
    noteLoginThrottle(thrKey);
    await sleep(400);
    return sendJson(res, 401, { error: 'Неверный логин или пароль' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: u.id, login: u.login, name: u.name || u.login, role: u.role || 'user', expires: Date.now() + SESSION_TTL_MS });
  persistSessions();
  setSessionCookie(res, token);
  return sendJson(res, 200, { ok: true, user: publicUser(u) });
}

async function logoutEndpoint(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const origin = impersonationOrigin.get(token);
    impersonationOrigin.delete(token);
    sessions.delete(token);
    // Если выходим из-под имперсонированного пользователя — возвращаем админа
    // в его собственный аккаунт (без повторного ввода пароля).
    if (origin) {
      const nt = crypto.randomBytes(32).toString('hex');
      sessions.set(nt, { ...origin, expires: Date.now() + SESSION_TTL_MS });
      persistSessions();
      setSessionCookie(res, nt);
      return sendJson(res, 200, { ok: true, returnedToAccount: true });
    }
  }
  persistSessions();
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  return sendJson(res, 200, { ok: true });
}

// Имперсонация: администратор входит под другим пользователем (без пароля).
// Меняет куку сессии на сессию выбранного пользователя — затем фронт перезагружается.
async function impersonateEndpoint(req, res) {
  const cur = getSession(req);
  if (!cur) return sendJson(res, 401, { error: 'login_required' });
  const isPower = cur.role === 'admin' || cur.role === 'superAdmin' ||
    isSuperAdmin(identity(req), storage.readSettings());
  if (!isPower) return sendJson(res, 403, { error: 'Доступно только администратору' });
  let uid = '';
  try {
    const parsed = JSON.parse((await readBody(req).catch(() => '{}')) || '{}');
    uid = String(parsed.userId || '').trim();
  } catch (_e) { /* ignore */ }
  if (!uid) return sendJson(res, 400, { error: 'Не указан пользователь' });
  const users = storage.readUsers();
  const u = users.find((x) => String(x.id) === String(uid));
  if (!u) return sendJson(res, 404, { error: 'Пользователь не найден' });
  if (String(u.id) === String(cur.userId)) return sendJson(res, 400, { error: 'Это уже ваш аккаунт' });
  // Защита от повышения ролей: администратор не может войти под главного
  // администратора (это запрещённая эскалация прав).
  if (cur.role !== 'superAdmin' && (u.role || 'user') === 'superAdmin') {
    return sendJson(res, 403, { error: 'Вход под главного администратора запрещён' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: u.id,
    login: u.login,
    name: u.name || u.login,
    role: u.role || 'user',
    expires: Date.now() + SESSION_TTL_MS,
  });
  impersonationOrigin.set(token, cur); // чтобы «Выйти» вернул в аккаунт админа
  persistSessions();
  setSessionCookie(res, token);
  return sendJson(res, 200, { ok: true, user: publicUser(u) });
}

function authMeEndpoint(req, res) {
  const s = req._biotimeSession || getSession(req);
  if (!s) {
    const needsSetup = storage.readUsers().length === 0;
    const isHeaderSuper = isSuperAdmin(identity(req), storage.readSettings());
    return sendJson(res, 401, { error: 'login_required', needsSetup, isSuper: isHeaderSuper });
  }
  // Встроенный в BIOTIME режим: пользователь пришёл с сессии BIOTIME
  // (_biotimeSession), в базе пользователей АБЦП его записи нет. Доступ к самому
  // модулю уже ограничен canSeeReports, поэтому внутри отдаём все разделы сразу.
  if (req._biotimeSession) {
    return sendJson(res, 200, {
      user: {
        id: s.userId,
        login: String(s.name || '') || ('user' + String(s.userId || '')),
        name: String(s.name || 'Пользователь'),
        role: 'admin',
      },
      // Разрешения на внутренние разделы из BIOTIME (null — все для админа,
      // массив — только отмеченные разделы для остальных).
      sections: (req._biotimeSections !== undefined) ? req._biotimeSections : null,
    });
  }
  const users = storage.readUsers();
  const u = users.find((x) => String(x.id) === s.userId);
  if (!u) return sendJson(res, 401, { error: 'login_required' });
  const isPower = u.role === 'admin' || u.role === 'superAdmin';
  return sendJson(res, 200, {
    user: publicUser(u),
    sections: isPower ? null : (u.sections || []), // null — все разделы
  });
}

// Первый пользователь (главный администратор) создаётся, только когда список
// пользователей пуст и текущий посетитель — супер-админ по заголовку шлюза.
async function setupEndpoint(req, res) {
  const users = storage.readUsers();
  if (users.length) return sendJson(res, 403, { error: 'Пользователи уже настроены' });
  const ident = identity(req);
  const settings = storage.readSettings();
  if (!isSuperAdmin(ident, settings)) {
    return sendJson(res, 403, { error: 'Первоначальная настройка доступна только главному администратору' });
  }
  const body = await readBody(req).catch(() => '{}');
  let login = '';
  let password = '';
  let name = '';
  try {
    const parsed = JSON.parse(body || '{}');
    login = String(parsed.login || '').trim();
    password = String(parsed.password || '');
    name = String(parsed.name || ident.name || '').trim();
  } catch (_e) { /* ignore */ }
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(login)) return sendJson(res, 400, { error: 'Некорректный логин' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
  const u = {
    id: crypto.randomUUID(),
    login,
    name: name || login,
    role: 'superAdmin',
    passwordHash: createPasswordHash(password),
  };
  storage.writeUsers([...users, u]);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: u.id, login: u.login, name: u.name, role: 'superAdmin', expires: Date.now() + SESSION_TTL_MS });
  persistSessions();
  setSessionCookie(res, token);
  return sendJson(res, 200, { ok: true, user: publicUser(u) });
}

// Восстановление доступа: главному администратору (по заголовку шлюза) — задать
// новый пароль своей учётке. Логин остаётся прежним; если супер-админа нет — создаётся.
async function resetSuperAdminEndpoint(req, res) {
  const ident = identity(req);
  const settings = storage.readSettings();
  if (!isSuperAdmin(ident, settings)) {
    return sendJson(res, 403, { error: 'Восстановление доступно только главному администратору' });
  }
  const body = await readBody(req).catch(() => '{}');
  let password = '';
  let login = '';
  try {
    const parsed = JSON.parse(body || '{}');
    password = String(parsed.password || '');
    login = String(parsed.login || '').trim();
  } catch (_e) { /* ignore */ }
  if (password.length < 6) return sendJson(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
  const users = storage.readUsers();
  let sup = users.find((u) => u.role === 'superAdmin');
  if (!sup) {
    const safeLogin = login || 'admin';
    if (!/^[A-Za-z0-9._@-]{2,64}$/.test(safeLogin)) return sendJson(res, 400, { error: 'Некорректный логин' });
    sup = { id: crypto.randomUUID(), login: safeLogin, name: ident.name || safeLogin, role: 'superAdmin', passwordHash: createPasswordHash(password), sections: [] };
    users.push(sup);
  } else {
    sup.passwordHash = createPasswordHash(password);
  }
  storage.writeUsers(users);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: sup.id, login: sup.login, name: sup.name, role: 'superAdmin', expires: Date.now() + SESSION_TTL_MS });
  persistSessions();
  setSessionCookie(res, token);
  return sendJson(res, 200, { ok: true, user: publicUser(sup) });
}

// Только супер-администратор может управлять пользователями.
function requireSuperAdmin(req, res) {
  const s = getSession(req);
  if (!s) {
    sendJson(res, 401, { error: 'login_required' });
    return null;
  }
  const ident = identity(req);
  const settings = storage.readSettings();
  if (s.role !== 'superAdmin' && !isSuperAdmin(ident, settings)) {
    sendJson(res, 403, { error: 'Недостаточно прав' });
    return null;
  }
  return s;
}

function usersListEndpoint(req, res) {
  const s = requireSuperAdmin(req, res);
  if (!s) return;
  return sendJson(res, 200, {
    users: storage.readUsers().map(publicUser),
  });
}

async function usersCreateEndpoint(req, res) {
  const s = requireSuperAdmin(req, res);
  if (!s) return;
  const body = await readBody(req).catch(() => '{}');
  let login = '', password = '', role = 'user', name = '';
  let sections = [];
  try {
    const parsed = JSON.parse(body || '{}');
    login = String(parsed.login || '').trim();
    password = String(parsed.password || '');
    role = ['user', 'admin', 'superAdmin'].includes(parsed.role) ? parsed.role : 'user';
    name = String(parsed.name || '').trim() || login;
    sections = Array.isArray(parsed.sections) ? parsed.sections : [];
  } catch (_e) { /* ignore */ }
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(login)) return sendJson(res, 400, { error: 'Некорректный логин' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Пароль должен быть не короче 6 символов' });
  const users = storage.readUsers();
  if (users.some((u) => String(u.login).toLowerCase() === login.toLowerCase())) {
    return sendJson(res, 409, { error: 'Пользователь с таким логином уже существует' });
  }
  const allowed = sections.filter((s) => SECTION_KEYS.includes(s));
  const u = {
    id: crypto.randomUUID(),
    login,
    name,
    role,
    passwordHash: createPasswordHash(password),
    sections: role === 'user' ? allowed : [],
  };
  storage.writeUsers([...users, u]);
  return sendJson(res, 200, { user: publicUser(u) });
}

function parseUserParam(p) {
  const m = /^\/api\/users\/([\w-]+)$/.exec(p);
  return m ? m[1] : null;
}

async function usersUpdateEndpoint(req, res, userId) {
  const s = requireSuperAdmin(req, res);
  if (!s) return;
  const users = storage.readUsers();
  const u = users.find((x) => String(x.id) === userId);
  if (!u) return sendJson(res, 404, { error: 'Пользователь не найден' });
  // Защита главного администратора: нельзя изменить роль или логин супер-админа.
  if (u.role === 'superAdmin') {
    return sendJson(res, 403, { error: 'Нельзя изменить роль или логин главного администратора' });
  }
  const body = await readBody(req).catch(() => '{}');
  try {
    const parsed = JSON.parse(body || '{}');
    if (parsed.role) {
      u.role = ['user', 'admin'].includes(parsed.role) ? parsed.role : u.role;
    }
    if (parsed.name) u.name = String(parsed.name).trim() || u.name;
    if (Array.isArray(parsed.sections)) {
      u.sections = parsed.sections.filter((x) => SECTION_KEYS.includes(x));
    }
    if (parsed.password && String(parsed.password).length >= 6) {
      u.passwordHash = createPasswordHash(String(parsed.password));
    }
  } catch (_e) { /* ignore */ }
  storage.writeUsers(users);
  return sendJson(res, 200, { user: publicUser(u) });
}

async function usersDeleteEndpoint(req, res, userId) {
  const s = requireSuperAdmin(req, res);
  if (!s) return;
  const users = storage.readUsers();
  const u = users.find((x) => String(x.id) === userId);
  if (!u) return sendJson(res, 404, { error: 'Пользователь не найден' });
  if (u.role === 'superAdmin' || s.userId === String(u.id)) {
    return sendJson(res, 403, { error: 'Нельзя удалить главного администратора' });
  }
  storage.writeUsers(users.filter((x) => String(x.id) !== userId));
  return sendJson(res, 200, { ok: true });
}
// Запас в днях для «Анализа заказов клиентов» (передаётся в обработчики отчётов).
const CLIENT_ANALYSIS_LOOKBACK_DAYS = 80;

const {
  computeReport,
  computeRejections,
  buildClientSuppliers,
  buildSupplierClients,
  buildSupplierWarehouses,
  buildClientWarehouses,
  computeDashboard,
  computeClientAnalysis,
  computeManualAutomat,
  computeEurope,
  computeClientConfig,
  computeSupplierTerms,
  computePricing,
  filterNotSentToday,
} = require('./lib/logic');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SNAPSHOT_VER = 'v6';

// Снимок отчёта держим в памяти: сбор данных из ABCP дорогой, поэтому
// отдаём последний готовый результат, а обновление — по ?refresh=1.
let reportCache = makeCache();
let rejectionsCache = makeCache();
let rejectionsClientsCache = makeCache();
let dashboardCache = makeCache();
let clientAnalysisCache = makeCache();
const europeCache = makeCache();
const clientConfigCache = makeCache();
let manualAutomatCache = makeCache();
let supplierClientsCache = makeCache();
let warehouseCache = makeCache();

function fullKey(s, filter) {
  return JSON.stringify([s.host, s.login, s.dateStart, s.dateEnd, filter || {}]);
}

// Ключ снапшота на диске включает версию: при изменении структуры отчёта
// (например, новых возможностях) старые снимки в /data не подходят и пересобираются.
function reportKey(s, filter) {
  return `${fullKey(s, filter)}::${SNAPSHOT_VER}`;
}

function urlQuery(req, name) {
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get(name) || '';
  } catch (_e) {
    return '';
  }
}

function toUserId(req) {
  const h = req.headers['x-vibe-user-id'];
  return h && /^\d+$/.test(String(h).trim()) ? String(h).trim() : '';
}

function buildFilter(req) {
  const filter = {};
  const clientId = urlQuery(req, 'clientId');
  const supplierId = urlQuery(req, 'supplierId');
  if (clientId) filter.userId = clientId;
  if (supplierId) filter.distributorId = supplierId;
  return filter;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// Единый, безопасный разбор ошибки обращения к ABCP: клиенту никогда не уходят
// сырые стеки/секреты — только понятное сообщение + флаг auth (для логина).
function sendAbcpError(res, e) {
  const msg = e && e.isAuth
    ? 'ABCP отклонил учётные данные — проверьте логин и MD5-пароль'
    : e && e.badConfig
      ? e.message
      : `Не удалось получить данные из ABCP: ${e && e.message ? e.message : 'неизвестная ошибка'}`;
  sendJson(res, 502, { error: msg, auth: Boolean(e && e.isAuth) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 8_000_000) {
        reject(new Error('Слишком большой запрос'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Валидация и нормализация настроек с фронта (входные данные не доверяем).
function normalizeSettings(input) {
  const current = storage.readSettings();
  const next = { ...current };

  if (typeof input.host === 'string') next.host = input.host.trim().replace(/^https?:\/\//, '');
  if (typeof input.login === 'string') next.login = input.login.trim();
  if (typeof input.md5Password === 'string' && input.md5Password.trim() !== '') {
    next.md5Password = input.md5Password.trim();
  } else if (input.md5Password === '' && input.hasPassword === true) {
    // оставляем текущий пароль, если поле очищено, но пароль уже задан ранее
    // (текущий сохраняется в next за счёт spread)
  } else if (input.md5Password === '' && !current.md5Password) {
    next.md5Password = '';
  }

  if (typeof input.dateStart === 'string') next.dateStart = input.dateStart.trim();
  if (typeof input.dateEnd === 'string') next.dateEnd = input.dateEnd.trim();

  if (Array.isArray(input.completedStatusCodes)) {
    next.completedStatusCodes = input.completedStatusCodes
      .map(String)
      .filter((s) => s.length <= 20);
  }
  if (Array.isArray(input.excludedDistributors)) {
    next.excludedDistributors = input.excludedDistributors
      .map(String)
      .filter((s) => s.length <= 200);
  }
  // «Ручной автомат»: список вручную выбранных поставщиков для сводки по статусу «Принят».
  if (Array.isArray(input.manualAutomatSuppliers)) {
    next.manualAutomatSuppliers = input.manualAutomatSuppliers
      .map(String)
      .filter((s) => s.length <= 200);
  }
  if (typeof input.manualAutomatAuto === 'boolean') {
    next.manualAutomatAuto = input.manualAutomatAuto;
  }
  if (typeof input.statusesTouched === 'boolean') {
    next.statusesTouched = input.statusesTouched;
  }
  for (const k of ['reportPeriod', 'rejPeriod', 'crjPeriod', 'dashPeriod', 'termsPeriod', 'pricingPeriod', 'caPeriod', 'euPeriod']) {
    if (input[k] && typeof input[k] === 'object') {
      next[k] = {
        start: typeof input[k].start === 'string' ? input[k].start.slice(0, 10) : '',
        end: typeof input[k].end === 'string' ? input[k].end.slice(0, 10) : '',
      };
    }
  }
  if (input.supplierEmails && typeof input.supplierEmails === 'object') {
    const se = {};
    for (const name of Object.keys(input.supplierEmails)) {
      const key = name.trim().slice(0, 200);
      if (!key) continue;
      const list = Array.isArray(input.supplierEmails[name])
        ? input.supplierEmails[name].map((s) => String(s).trim().slice(0, 200)).filter(Boolean)
        : [];
      se[key] = list;
    }
    next.supplierEmails = se;
  }

  if (next.host && !abcp.validateHost(next.host)) {
    throw new Error('Хост должен быть обычным доменом без протокола, пробелов и символов');
  }
  if (next.dateStart && !/^\d{4}-\d{2}-\d{2}$/.test(next.dateStart)) {
    throw new Error('Дата начала должна быть в формате ГГГГ-ММ-ДД');
  }
  if (next.dateEnd && !/^\d{4}-\d{2}-\d{2}$/.test(next.dateEnd)) {
    throw new Error('Дата окончания должна быть в формате ГГГГ-ММ-ДД');
  }

  return next;
}

function getSettingsEndpoint(req, res) {
  const settings = storage.readSettings();
  sendJson(res, 200, {
    settings: storage.toPublicSettings(settings),
    configured: storage.isConfigured(settings),
    dataDir: storage.resolveDataDir(),
  });
}

// Нормализация SMTP-настроек почтового ящика для рассылки писем поставщикам.
function normalizeSmtp(input, current) {
  const cur = current || {};
  const host = String((input && input.host) || '').trim();
  const port = parseInt(input && input.port != null ? input.port : cur.port, 10);
  const secure = !!(input && input.secure === true);
  const user = String((input && input.user) || '').trim();
  const pass = String((input && input.pass) || '');
  const fromEmail = String((input && input.fromEmail) || '').trim();
  if (host && (port < 1 || port > 65535)) throw new Error('Некорректный порт SMTP');
  if (host && !/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error('Некорректный адрес SMTP-сервера');
  if (host && !fromEmail) throw new Error('Укажите адрес отправителя (From)');
  return {
    host,
    port: host ? (port || 587) : 0,
    secure,
    user,
    pass: pass || (cur.pass || ''),
    fromEmail,
  };
}

async function saveSettingsEndpoint(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'Некорректное тело запроса' });
  }

  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch (_e) {
    return sendJson(res, 400, { error: 'Тело запроса не является JSON' });
  }

  let next;
  try {
    next = normalizeSettings(input);
  } catch (e) {
    return sendJson(res, 422, { error: e.message });
  }

  // если в поле пароля ничего не введено и пароль сейчас есть — сохраняем прежний
  const saved = { ...next };
  if ((!input.md5Password || input.md5Password.trim() === '') && next.md5Password === '') {
    const current = storage.readSettings();
    saved.md5Password = current.md5Password;
  }
  if (input.smtp && typeof input.smtp === 'object') {
    saved.smtp = normalizeSmtp(input.smtp, storage.readSettings().smtp);
  }

  storage.writeSettings(saved);
  reportCache.clear();
  rejectionsCache.clear();
  rejectionsClientsCache.clear();
  dashboardCache.clear();
  supplierClientsCache.clear();
  warehouseCache.clear();
  europeCache.clear();
  clearOrders();
  return sendJson(res, 200, {
    settings: storage.toPublicSettings(saved),
    configured: storage.isConfigured(saved),
  });
}

// Добавляет к строкам отчёта дату отправки запроса срока (если она была).
function attachRequested(report) {
  if (report && typeof report === 'object') report.mailActive = Boolean(currentTaskId);
  if (!report || !Array.isArray(report.rows)) return report;
  const map = storage.readRequested();
  for (const r of report.rows) {
    if (r.id != null && map[String(r.id)]) {
      r.requestedDate = map[String(r.id)];
    }
  }
  return report;
}

// «Ручной автомат»: сводка по заказам/позициям в статусе «Принят» по вручную выбранным
// поставщикам (аналогично фильтру «Обработка заказов» в ABCP).
async function statusHistoryEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, {
      error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.',
      settings: storage.toPublicSettings(settings),
    });
  }
  const positionId = urlQuery(req, 'positionId');
  if (!positionId) {
    return sendJson(res, 400, { error: 'Не указан positionId' });
  }
  try {
    const history = await abcp.fetchStatusHistory(settings, positionId);
    return sendJson(res, 200, { history, positionId });
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось получить историю статуса: ${e.message}` });
  }
}

// Общий статус фонового сбора сроков маршрутов (делится с задачей записи сроков).
const routeState = { busy: false };

// Очистка кэша сроков — следующий расчёт пойдёт с нуля.
async function clearTermsCacheEndpoint(req, res) {
  const s = requirePowerAdmin(req, res);
  if (!s) return;
  storage.clearTermsCache();
  return sendJson(res, 200, { ok: true });
}

// Поставщики с «красивыми» (отображаемыми) названиями — им максимальный срок не обновляем:
// под таким именем нет реального маршрута ABCP. Список легко расширить.
// Версия схемы кэша сроков: инкремент аннулирует старый кэш после деплоя.
const TERMS_CACHE_VERSION = 'v4';

async function pricingEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  try {
    const refresh = urlQueryRefresh(req);
    const eff = periodedSettings(settings, 'pricingPeriod');
    const suppliers = urlQuery(req, 'suppliers');
    const state = ensureOrdersLoaded(eff, refresh);
    if (state.error) {
      return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
    }
    if (!state.ready) return sendJson(res, 202, { loading: true });
    const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
    let data;
    if (settings.clientLogin && settings.clientMd5) {
      data = await livePricing(orders, eff, suppliers);
    } else {
      data = computePricing(orders, suppliers);
    }
    data.ordersCount = orders.length;
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось получить данные: ${e.message}` });
  }
}

async function liveSuppliersEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  const eff = periodedSettings(settings, 'pricingPeriod');
  if (settings.clientLogin && settings.clientMd5) {
    const state = ensureOrdersLoaded(eff, false);
    if (state.error) {
      return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
    }
    if (!state.ready) return sendJson(res, 202, { loading: true });
    const names = new Set();
    const arts = [];
    const seen = new Set();
    for (const o of state.orders || []) {
      for (const p of o.positions || []) {
        if (p.number == null) continue;
        const key = `${String(p.number).trim()}|${String(p.brand || '').trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        arts.push({ number: String(p.number).trim(), brand: String(p.brand || '').trim() });
        if (arts.length >= 30) break;
      }
      if (arts.length >= 30) break;
    }
    let i = 0;
    const CONC = 9;
    async function worker() {
      while (i < arts.length) {
        const a = arts[i++];
        try {
          const offers = await abcp.liveSearch(eff, a.number, a.brand);
          for (const it of offers) {
            if (it && Number(it.price) > 0) {
              names.add(it.supplierDescription || it.distributorCode || '—');
            }
          }
        } catch (_e) { /* continue */ }
        await new Promise((r) => setTimeout(r, 15));
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, arts.length) }, () => worker()));
    return sendJson(res, 200, { suppliers: Array.from(names).sort(), live: true });
  }
  return sendJson(res, 200, { suppliers: [], live: false });
}

// Проценка по артикулу: для каждого выбранного поставщика находим лучшее
// (минимальное) предложение цены и показываем разницу между ними.
async function liveProcenka(settings, selectedSuppliers, numbers, brand) {
  const selected = Array.from(new Set(String(selectedSuppliers || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)));
  if (!selected.length) throw new Error('Выберите хотя бы одного поставщика');
  const isId = (s) => /^\d+$/.test(s);
  const byId = new Set(selected.filter(isId));
  const byName = new Set(selected.filter((s) => !isId(s)));
  const arts = String(numbers || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!arts.length) throw new Error('Введите артикул');
  if (arts.length > 50) arts.length = 50;

  const results = [];
  let idx = 0;
  const CONC = 9;
  let authBlocked = false;
  let anyPrice = false;
  const norm = (s) => String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '') // убираем суффиксы вида «[online]»
    .replace(/\s+/g, ' ')
    .trim();
  async function worker() {
    while (idx < arts.length) {
      const n = arts[idx++];
      let off = [];
      try {
        off = await abcp.liveSearch(settings, n, brand);
      } catch (_e) {
        if (/403|103|разрешени|permission/i.test(String(_e && _e.message))) {
          authBlocked = true;
        }
        off = [];
      }
      const withPrice = (off || []).filter((it) => Number(it.price) > 0);
      const numFound = withPrice.length;
      if (numFound) anyPrice = true;
      const offers = [];
      for (const sup of selected) {
        let min = null;
        for (const it of withPrice) {
          const did = String(it.distributorId != null ? it.distributorId : '');
          const matches = isId(sup)
            ? did === sup
            : byName.has(sup) && norm(it.supplierDescription || it.distributorCode || '') === norm(sup);
          if (matches && (min == null || Number(it.price) < min)) {
            min = Number(it.price);
          }
        }
        offers.push({ supplier: sup, price: min });
      }
      results.push({ number: n, brand: brand || '', numFound, offers });
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, arts.length) }, () => worker()));
  if (!anyPrice && authBlocked) {
    throw new Error('Клиентский доступ ABCP отклонён (errorCode 103): IP-адрес сервера не имеет разрешения на API-операции. Обратитесь к менеджеру ABCP или проверьте клиентский доступ в настройках.');
  }
  return { articles: results, generatedAt: new Date().toISOString() };
}

async function procenkaEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  if (!settings.clientLogin || !settings.clientMd5) {
    return sendJson(res, 409, { error: 'Для проценки нужен клиентский доступ ABCP (настройте его в разделе «Настройки»).' });
  }
  try {
    const suppliers = urlQuery(req, 'suppliers');
    const number = urlQuery(req, 'number');
    const brand = urlQuery(req, 'brand') || '';
    const data = await liveProcenka(settings, suppliers, number, brand);
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось выполнить проценку: ${e.message}` });
  }
}

// Живые цены по 100 артикулам у поставщиков, реально дающих цену.
async function livePricing(orders, settings, selectedSuppliers) {
  const selected = new Set(String(selectedSuppliers || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!selected.size) throw new Error('Выберите хотя бы одного поставщика');
  const arts = [];
  const seen = new Set();
  for (const o of orders || []) {
    for (const p of o.positions || []) {
      if (p.number == null) continue;
      if (selected.size && !selected.has(String(p.distributorName || ''))) continue;
      const key = `${String(p.number).trim()}|${String(p.brand || '').trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      arts.push({ number: String(p.number).trim(), brand: String(p.brand || '').trim() });
      if (arts.length >= 400) break;
    }
    if (arts.length >= 400) break;
  }
  const articles = [];
  let i = 0;
  const CONC = 9;
  async function worker() {
    while (i < arts.length) {
      const a = arts[i++];
      let offers = [];
      try {
        offers = await abcp.liveSearch(settings, a.number, a.brand);
      } catch (_e) {
        offers = [];
      }
      const prices = {};
      for (const item of offers) {
        if (item == null || Number(item.price) <= 0) continue;
        const dist = item.supplierDescription || item.distributorCode || '—';
        if (selected.size && !selected.has(dist)) continue;
        if (prices[dist] == null) prices[dist] = Number(item.price);
      }
      articles.push({ number: a.number, brand: a.brand, description: '', prices });
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, arts.length) }, () => worker()));
  // Только общие артикулы: у всех выбранных поставщиков есть цена.
  const common = articles.filter((a) =>
    Array.from(selected).every((s) => a.prices[s] != null)
  );
  const withSum = Array.from(selected)
    .map((supplier) => {
      let sum = 0;
      let count = 0;
      for (const a of common) {
        if (a.prices[supplier] != null) {
          sum += a.prices[supplier];
          count += 1;
        }
      }
      return { supplier, sum: Math.round(sum * 100) / 100, count };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => a.sum - b.sum);
  const maxSum = withSum.length ? withSum[withSum.length - 1].sum : 0;
  const comparison = withSum.map((x) => ({
    supplier: x.supplier,
    count: x.count,
    sum: x.sum,
    cheaperPercent: maxSum > 0 ? Math.round(((maxSum - x.sum) / maxSum) * 1000) / 10 : 0,
  }));
  return { articles: common, comparison, generatedAt: new Date().toISOString() };
}

// Список поставщиков: объединяем сохранённые почты и поставщиков из последних данных ABCP.
async function suppliersEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  if (!settings.clientLogin) {
    return sendJson(res, 200, { suppliers: [] });
  }
  const eff = periodedSettings(settings, 'pricingPeriod');
  const state = ensureOrdersLoaded(eff, false);
  if (state.error) {
    return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
  }
  const se = (settings.supplierEmails || {});
  const byName = new Map(); // нормализованное имя -> {name, distributorId, emails}
  const normName = (s) => String(s || '').trim().toLowerCase();
  if (state.ready && state.orders) {
    for (const order of state.orders) {
      for (const pos of order.positions || []) {
        if (pos.distributorId != null) {
          const nm = pos.distributorName || '';
          const key = normName(nm);
          if (key) byName.set(key, { name: nm, distributorId: String(pos.distributorId), emails: se[nm] || [] });
        }
      }
    }
  }
  for (const name of Object.keys(se)) {
    const key = normName(name);
    if (!key) continue;
    if (!byName.has(key)) {
      byName.set(key, { name: name.trim(), distributorId: `em-${name.trim()}`, emails: se[name] || [] });
    }
  }
  if (!state.ready) return sendJson(res, 202, { loading: true });
  const suppliers = Array.from(byName.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, distributorId, emails }) => ({ distributorId, name, emails: emails || [] }));
  return sendJson(res, 200, { suppliers });
}

// Автосохранение почт поставщиков.
async function supplierEmailsEndpoint(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (_e) {
    return sendJson(res, 400, { error: 'Некорректное тело запроса' });
  }
  let input;
  try {
    input = JSON.parse(raw || '{}');
  } catch (_e) {
    return sendJson(res, 400, { error: 'Тело запроса не является JSON' });
  }
  try {
    const next = normalizeSettings({ supplierEmails: input.supplierEmails || {} });
    storage.writeSettings(next);
    return sendJson(res, 200, { saved: true });
  } catch (e) {
    return sendJson(res, 422, { error: e.message });
  }
}

// Автозаполнение почт поставщиков из ABCP (cp/distributors): берём email из
// карточки поставщика и дополняем существующий список, не затирая ручные почты.
async function supplierEmailsFetchEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  try {
    const list = await abcp.fetchSuppliersEmails(settings);
    const se = mergeSupplierEmails(settings.supplierEmails || {}, list);
    const next = normalizeSettings({ supplierEmails: se });
    storage.writeSettings(next);
    return sendJson(res, 200, {
      suppliers: Array.from(se.entries ? se.entries() : Object.entries(se))
        .map(([name, emails]) => ({ name, emails: emails.slice ? emails.slice() : [emails] })),
    });
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось получить почты из ABCP: ${e.message}` });
  }
}

// Объединяет текущий словарь почт с данными ABCP: сохраняет ручные записи,
// для найденных поставщиков добавляет email, если его ещё нет.
function mergeSupplierEmails(existing, list) {
  const normEmail = (e) => String(e || '').trim().toLowerCase();
  const uniqueEmails = (arr) => {
    const seen = new Set();
    const res = [];
    for (const x of arr) {
      const n = normEmail(x);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      res.push(String(x).trim());
    }
    return res;
  };
  const out = {};
  for (const name of Object.keys(existing || {})) {
    const arr = Array.isArray(existing[name]) ? existing[name].slice() : [existing[name]];
    out[name] = uniqueEmails(arr);
  }
  for (const it of list) {
    const e = normEmail(it.email);
    if (!e || !it.name) continue;
    const cur = out[it.name] || [];
    out[it.name] = cur.some((x) => normEmail(x) === e) ? cur : uniqueEmails(cur.concat([it.email]));
  }
  return out;
}

async function myIpEndpoint(req, res) {
  const sources = [
    'https://api.ipify.org?format=json',
    'https://ipinfo.io/ip',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ];
  for (const src of sources) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(src, { signal: ctl.signal });
      clearTimeout(t);
      const txt = (await r.text()).trim();
      const m = txt.match(/(\d{1,3}\.){3}\d{1,3}/);
      if (m) return sendJson(res, 200, { ip: m[0] });
    } catch (_e) {
      clearTimeout(t);
    }
  }
  return sendJson(res, 502, { error: 'Не удалось определить IP' });
}

async function meEndpoint(req, res) {
  const ident = identity(req);
  const settings = storage.readSettings();
  const supers = (settings.superAdmins && settings.superAdmins.length)
    ? settings.superAdmins
    : [{ name: 'Ахмедов Андрей' }];
  const isSuper = isSuperAdmin(ident, settings);
  return sendJson(res, 200, {
    id: ident.id,
    name: ident.name,
    role: ident.role || 'MEMBER',
    isSuperAdmin: isSuper,
    superAdmins: supers,
    protected: isSuper,
  });
}

function logsEndpoint(req, res) {
  // Логи видят все вошедшие пользователи (не только администраторы).
  const s = getSession(req);
  if (!s) return sendJson(res, 401, { error: 'login_required' });
  const date = urlQuery(req, 'date');
  const dOk = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
  const pool = dOk ? readDayLogs(date) : logBuffer;
  const reverse = urlQuery(req, 'reverse') !== '0';
  const out = reverse ? pool.slice().reverse() : pool.slice();
  return sendJson(res, 200, { logs: out, date: dOk ? date : todayStr() });
}

// Проверка доступа к живой цене (клиентский поиск search/articles) с сервера приложения.
async function liveCheckEndpoint(req, res) {
  const settings = storage.readSettings();
  const host = (settings.host || '').trim();
  const login = settings.clientLogin || '';
  const md5 = settings.clientMd5 || '';
  if (!host || !login || !md5) {
    return sendJson(res, 400, { error: 'Не заданы клиентские данные ABCP' });
  }
  const number = urlQuery(req, 'number') || 'SS100';
  const brand = urlQuery(req, 'brand') || 'Shine Systems';
  try {
    const url = `https://${host}/search/articles?userlogin=${encodeURIComponent(login)}&userpsw=${encodeURIComponent(md5)}&number=${encodeURIComponent(number)}&brand=${encodeURIComponent(brand)}`;
    const res2 = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res2.text();
    return sendJson(res, 200, { http: res2.status, body: text.slice(0, 4000) });
  } catch (e) {
    return sendJson(res, 502, { error: `Ошибка запроса: ${e.message}` });
  }
}

async function supplierClientsEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, {
      error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.',
    });
  }
  const supplier = urlQuery(req, 'supplier');
  if (!supplier) return sendJson(res, 400, { error: 'Не указан поставщик' });
  if (supplierClientsCache.has(supplier)) {
    return sendJson(res, 200, supplierClientsCache.get(supplier));
  }
  const eff = periodedSettings(settings, 'rejPeriod');
  const state = ensureOrdersLoaded(eff, false);
  if (state.error) {
    return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
  }
  if (!state.ready) return sendJson(res, 202, { loading: true });
  try {
    const names = await getUsersMap(eff);
    // Считаем в том же периоде отчёта, что и родительский отчёт по отказам
    // (иначе модалка по клиентам охватывает всю историю и цифры не сходятся с виджетом).
    const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
    const clients = buildSupplierClients(orders, names, supplier);
    // Есть ли у поставщика склады/направления (в названии после «:»).
    const supKey = String(supplier || '').trim().toLowerCase();
    let hasWarehouses = false;
    for (const order of orders || []) {
      for (const pos of order.positions || []) {
        if (String(pos.distributorName || '').trim().toLowerCase() !== supKey) continue;
        const wh = pos.dsRouteId != null ? pos.dsRouteId : (pos.routeId != null ? pos.routeId : pos.supplierCode);
        if (wh != null && String(wh).trim()) { hasWarehouses = true; break; }
      }
      if (hasWarehouses) break;
    }
    const payload = { supplier, clients, hasWarehouses };
    supplierClientsCache.set(supplier, payload);
    return sendJson(res, 200, payload);
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось получить клиентов поставщика: ${e.message}` });
  }
}

// Склады, по которым у клиента были заказы у поставщика (вложенное окно).
async function clientWarehousesEndpoint(req, res) {
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  const supplier = urlQuery(req, 'supplier');
  const client = urlQuery(req, 'client');
  if (!supplier || !client) return sendJson(res, 400, { error: 'Не указаны поставщик или клиент' });
  const price = urlQuery(req, 'price');
  const priceField = price === 'out' ? 'priceOut' : 'priceIn';
  const cacheKey = supplier + '\u0000' + client + '\u0000' + priceField;
  if (warehouseCache.has(cacheKey)) {
    return sendJson(res, 200, warehouseCache.get(cacheKey));
  }
  const eff = periodedSettings(settings, 'rejPeriod');
  const state = ensureOrdersLoaded(eff, false);
  if (state.error) {
    return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
  }
    if (!state.ready) return sendJson(res, 202, { loading: true });
  try {
    const names = await getUsersMap(eff);
    const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
    const warehouses = buildClientWarehouses(orders, supplier, client, names, priceField);
    const payload = { supplier, client, warehouses };
    warehouseCache.set(cacheKey, payload);
    return sendJson(res, 200, payload);
  } catch (e) {
    return sendJson(res, 502, { error: `Не удалось получить склады клиента: ${e.message}` });
  }
}

// Временное хранилище собранных файлов экспорта (token -> {buf, filename}).
const exportStore = new Map();

// POST /api/export — построить .xlsx из {filename, sheetName, cols, rows} и вернуть token.
async function exportCreateEndpoint(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: 'Слишком большой запрос' }); }
  let input;
  try { input = JSON.parse(body || '{}'); } catch (e) { return sendJson(res, 400, { error: 'Некорректный JSON' }); }
  const cols = Array.isArray(input.cols) ? input.cols.map((c) => String(c)) : [];
  const rows = Array.isArray(input.rows) ? input.rows : [];
  if (!cols.length) return sendJson(res, 400, { error: 'Нет колонок' });
  if (rows.length > 50000) return sendJson(res, 400, { error: 'Слишком много строк для экспорта' });
  const cleanRows = rows.map((r) => (Array.isArray(r)
    ? r.map((v) => (typeof v === 'number' ? v : String(v == null ? '' : v)))
    : []));
  const filename = String(input.filename || 'export.xlsx').replace(/\.xlsx$/i, '') + '.xlsx';
  const sheetName = String(input.sheetName || 'Лист1');
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '';
  let buf;
  try {
    buf = buildXlsx(cols, cleanRows, sheetName, title);
  } catch (e) {
    return sendJson(res, 500, { error: 'Не удалось собрать файл' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  exportStore.set(token, { buf, filename, at: Date.now() });
  for (const [k, v] of exportStore) if (Date.now() - v.at > 10 * 60 * 1000) exportStore.delete(k);
  return sendJson(res, 200, { token, filename });
}

// GET /api/export/download?token=… — отдать файл как вложение (браузер скачит, а не откроет blob).
function exportDownloadEndpoint(req, res) {
  const token = urlQuery(req, 'token');
  const item = token && exportStore.get(token);
  if (!item) return sendJson(res, 404, { error: 'Файл не найден или срок истёк' });
  exportStore.delete(token);
  const encoded = encodeURIComponent(item.filename);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename*=UTF-8''${encoded}`,
    'Content-Length': item.buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(item.buf);
}

// Только администраторы (или главный админ) могут снимать позиции в отказ.
function requirePowerAdmin(req, res) {
  const s = getSession(req);
  if (!s) {
    sendJson(res, 401, { error: 'login_required' });
    return null;
  }
  if (s.role === 'superAdmin' || s.role === 'admin') return s;
  const ident = identity(req);
  if (isSuperAdmin(ident, storage.readSettings())) return s;
  sendJson(res, 403, { error: 'Доступно только администратору' });
  return null;
}

// Минимальный вход: любой вошедший по логину/паролю пользователь (не только админ).
// Используется для действий раздела «Проценка» («Снять», «Отправить письмо»),
// чтобы обычные пользователи с доступом к разделу тоже могли их выполнять.
function requireUser(req, res) {
  const s = getSession(req);
  if (!s) {
    sendJson(res, 401, { error: 'login_required' });
    return null;
  }
  return s;
}

// Код статуса «Отказ» определяем из уже загруженных заказов.
async function refusalStatusCode(orders) {
  const set = new Map();
  for (const o of orders || []) {
    for (const p of o.positions || []) {
      if (p.statusCode == null) continue;
      if (/^\s*отказ\s*$/i.test(String(p.status || '').trim())) {
        set.set(String(p.statusCode), String(p.statusCode));
      }
    }
  }
  if (set.size) {
    const keys = Array.from(set.keys()).sort((a, b) => Number(a) - Number(b));
    return keys[0];
  }
  return null;
}

// «Снять» выбранные позиции: проставить им статус «Отказ» через cp/order (POST).
async function markRefusalEndpoint(req, res) {
  const s = requireUser(req, res);
  if (!s) return;
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  const eff = periodedSettings(settings, 'reportPeriod');
  const body = await readBody(req).catch(() => '{}');
  let items = [];
  let forcedCode = '';
  try {
    const parsed = JSON.parse(body || '{}');
    items = Array.isArray(parsed.items) ? parsed.items : [];
    forcedCode = String(parsed.statusCode || '').trim();
  } catch (_e) { /* ignore */ }
  items = items
    .filter((x) => x && (x.positionId != null || x.orderNumber != null))
    .slice(0, 200);
  if (!items.length) return sendJson(res, 400, { error: 'Не выбраны позиции' });
  // Тяжёлое действие (массовое cp/order + письма) выполняем в фоне, чтобы не
  // упираться в лимит шлюза (BH_APP_TIMEOUT): отвечаем сразу, работа идёт отдельно.
  runRefusalTask(settings, eff, items, forcedCode, s.name || s.login).catch((e) => {
    log('error', 'Снятие (фон): ' + e.message);
  });
  return sendJson(res, 200, {
    accepted: true,
    message: 'Задача принята — снятие позиций и письма выполняются в фоне.',
  });
}

async function runRefusalTask(settings, eff, items, forcedCode, actorName) {
  currentTaskId = 'ref-' + Date.now();
  currentLogCat = 'mail';
  log('info', 'Снятие: принято позиций ' + items.length + ' — запускаю обработку');
  // 1) письмо поставщику (из данных интерфейса — мгновенно, без ожидания заказов)
  await sendMailsFromItems(settings, items, true);
  // «Ваш ответ» в ABCP: кто снял и когда (поле commentAnswer).
  // Дата по Москве (сервер может быть в UTC — локальная зона сервера не подходит).
  const fmtMsk = (d) => new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(d);
  // 2) снятие в ABCP (статус «Отказ») — требует код статуса, ждём данные не дольше 30 с
  const state = await getOrdersTimed(eff);
  if (!state.ready || state.error) {
    log('error', 'Снятие: статус в ABCP не выставлен — данные заказов не готовы (' + (state.error ? state.error.message : 'таймаут') + ')');
    return;
  }
  const code = forcedCode || await refusalStatusCode(state.orders);
  if (!code) { log('error', 'Снятие: код статуса «Отказ» не определён'); return; }
  let failedCount = 0;
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5 = settings.md5Password.trim();
  for (const it of items) {
    if (it.positionId == null) { failedCount++; continue; }
    const orderNumber = String(it.orderNumber != null ? it.orderNumber : '');
    // «Ваш ответ» в ABCP: кто снял через отчёт «Просрочка», срок просрочки по позиции, дата/время (МСК).
    const late = it.daysLate != null ? String(it.daysLate) : '—';
    const answer = actorName
      ? (actorName + ', снят через отчёт «Просрочка», просрочка ' + late + ' дн., ' + fmtMsk(new Date()))
      : '';
    const bodyMap = [
      `userlogin=${encodeURIComponent(login)}`,
      `userpsw=${encodeURIComponent(md5)}`,
      ...(orderNumber ? [`order[number]=${encodeURIComponent(orderNumber)}`] : []),
      `order[positions][0][id]=${encodeURIComponent(String(it.positionId))}`,
      `order[positions][0][statusCode]=${encodeURIComponent(code)}`,
      ...(answer ? [`order[positions][0][commentAnswer]=${encodeURIComponent(answer)}`] : []),
    ];
    try {
      const r = await fetch(`https://${host}/cp/order?userlogin=${encodeURIComponent(login)}&userpsw=${encodeURIComponent(md5)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: bodyMap.join('&'),
      });
      await r.text();
    } catch (e) {
      failedCount++;
      log('error', 'Снятие: cp/order ошибка — ' + e.message);
    }
    await new Promise((r2) => setTimeout(r2, 50));
  }
  log('info', 'Снятие: статус в ABCP выставлен для позиций (ошибок: ' + failedCount + ')');
  currentTaskId = null;
  currentLogCat = 'general';
}

// Отправка писем поставщикам из данных интерфейса (без обращения к заказам/кэшу).
async function sendMailsFromItems(settings, items, isRefusal) {
  const sentIds = new Set(); // позиции, по которым письмо реально отправлено
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmtAmount = (v) => v.toLocaleString ? v.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : String(v);
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDMY = (v) => {
    if (v instanceof Date && !isNaN(v.getTime())) return pad(v.getDate()) + '.' + pad(v.getMonth() + 1) + '.' + v.getFullYear();
    const m = String(v || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(v || '');
  };
  const smtp = settings.smtp || {};
  if (!smtp.host || !smtp.fromEmail) {
    log('warn', (isRefusal ? 'Снятие' : 'Запрос срока') + ': SMTP не настроен — письма не отправлены');
    return sentIds;
  }
  const supplierEmails = settings.supplierEmails || {};
  const byDist = new Map(); // dist -> {to, recs:[]}
  for (const it of items) {
    const dist = String(it.distributor || '').trim();
    if (!dist) continue;
    const emails = supplierEmails[dist] || [];
    const to = (Array.isArray(emails) && emails.length ? String(emails[0]) : String(emails || '')).trim();
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      log('warn', (isRefusal ? 'Снятие' : 'Запрос срока') + ': нет корректной почты у поставщика «' + dist + '» — письмо пропущено');
      continue;
    }
    if (!byDist.has(dist)) byDist.set(dist, { to, recs: [] });
    byDist.get(dist).recs.push(it);
  }
  for (const [dist, { to, recs }] of byDist) {
    log('info', (isRefusal ? 'Снятие' : 'Запрос срока') + ': отправляю письмо ' + to + ' (' + recs.length + ' поз.)');
    const padCell = (s, w) => String(s == null ? '' : s).padEnd(w);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const orders = Array.from(new Set(recs.map((r) => String(r.orderNumber || '').trim()).filter(Boolean)));

    let head, rows, introText, footerText;
    if (isRefusal) {
      const posWord = recs.length === 1 ? 'позицию' : 'позиции';
      introText = orders.length <= 1
        ? 'Снимаем ' + posWord + ' по заказу № ' + (orders[0] || '—') + ' по причине нарушения срока поставки.'
        : 'Снимаем ' + posWord + ' по заказам №№ ' + orders.join(', ') + ' по причине нарушения срока поставки.';
      head = ['Заказ', 'Артикул', 'Бренд', 'Кол-во', 'Цена', 'Сумма', 'Дата заказа', 'Срок поставки', 'Просрочка в днях'];
      rows = recs.map((rec) => {
        const qty = num(rec.quantity);
        const priceIn = num(rec.price);
        return [
          String(rec.orderNumber || ''), String(rec.number || ''), String(rec.brand || ''),
          String(qty), fmtAmount(priceIn), fmtAmount(qty * priceIn),
          fmtDMY(rec.orderDate), fmtDMY(rec.plannedDate),
          rec.daysLate != null ? String(rec.daysLate) : '',
        ];
      });
      footerText = 'Просьба не отгружать перечисленные позиции.';
    } else {
      introText = orders.length <= 1
        ? 'Просим уточнить сроки поставки по заказу № ' + (orders[0] || '—') + '.'
        : 'Просим уточнить сроки поставки по заказам №№ ' + orders.join(', ') + '.';
      head = ['Заказ', 'Артикул', 'Бренд', 'Кол-во', 'Цена', 'Сумма', 'Дата заказа', 'Просрочка в днях'];
      rows = recs.map((rec) => {
        const qty = num(rec.quantity);
        const priceIn = num(rec.price);
        return [
          String(rec.orderNumber || ''), String(rec.number || ''), String(rec.brand || ''),
          String(qty), fmtAmount(priceIn), fmtAmount(qty * priceIn),
          fmtDMY(rec.orderDate),
          rec.daysLate != null ? String(rec.daysLate) : '',
        ];
      });
      footerText = 'Просьба подтвердить сроки поставки по перечисленным позициям.';
    }

    // Текстовая версия (запасной вариант для клиентов без HTML).
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] || '').length)));
    const textLines = ['Добрый день!', '', introText, ''];
    textLines.push(head.map((h, i) => padCell(h, widths[i])).join('  '));
    textLines.push(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) textLines.push(r.map((c, i) => padCell(c, widths[i])).join('  '));
    textLines.push('', footerText, 'Благодарим за сотрудничество!');

    // HTML-версия с настоящей таблицей.
    const cellStyle = 'border:1px solid #c6ccd4;padding:6px 10px;text-align:center';
    const th = (t) => '<th style="' + cellStyle + ';background:#eef1f5">' + esc(t) + '</th>';
    const td = (t) => '<td style="' + cellStyle + '">' + esc(t) + '</td>';
    const htmlTable = '<table style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#222">' +
      '<thead><tr>' + head.map(th).join('') + '</tr></thead>' +
      '<tbody>' + rows.map((r) => '<tr>' + r.map(td).join('') + '</tr>').join('') + '</tbody></table>';
    const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222">' +
      '<p>Добрый день!</p><p>' + esc(introText) + '</p>' + htmlTable +
      '<p>' + esc(footerText) + '</p><p>Благодарим за сотрудничество!</p></div>';
    const text = textLines.join('\n');
    try {
      await sendMail(smtp, {
        from: smtp.fromEmail,
        to,
        subject: isRefusal ? 'ПрофМаркетСистем: Отказ от позиции' : 'ПрофМаркетСистем: Запрос срока поставки',
        text,
        html,
      }, null);
      log('info', (isRefusal ? 'Снятие' : 'Запрос срока') + ': письмо отправлено ' + to + ' (' + recs.length + ' поз.)');
      for (const rec of recs) {
        if (rec.positionId != null) sentIds.add(String(rec.positionId));
      }
    } catch (e) {
      log('error', (isRefusal ? 'Снятие' : 'Запрос срока') + ': письмо не отправлено (' + to + '): ' + e.message);
    }
  }
  return sentIds;
}

// Запрос срока поставки: для выбранных позиций отправляет поставщикам письмо
// с просьбой уточнить срок (статус не меняется). Группировка по поставщикам.
async function requestTermEndpoint(req, res) {
  const s = requireUser(req, res);
  if (!s) return;
  const settings = storage.readSettings();
  if (!storage.isConfigured(settings)) {
    return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
  }
  const eff = periodedSettings(settings, 'reportPeriod');
  const body = await readBody(req).catch(() => '{}');
  let items = [];
  try {
    const parsed = JSON.parse(body || '{}');
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch (_e) { /* ignore */ }
  items = items.filter((x) => x && x.positionId != null).slice(0, 200);
  if (!items.length) return sendJson(res, 400, { error: 'Не выбраны позиции' });
  // Отправка писем выполняется в фоне, чтобы запрос отвечал мгновенно.
  runRequestTask(settings, eff, items).catch((e) => {
    log('error', 'Запрос срока (фон): ' + e.message);
  });
  return sendJson(res, 200, {
    accepted: true,
    message: 'Задача принята — письма выполняются в фоне.',
  });
}

async function runRequestTask(settings, eff, items) {
  currentTaskId = 'req-' + Date.now();
  currentLogCat = 'mail';
  log('info', 'Запрос срока: принято позиций ' + items.length + ' — запускаю рассылку');
  // Фиксируем дату/время отправки ТОЛЬКО по позициям, где письмо реально отправлено
  // (есть корректная почта и SMTP принял письмо). Без почты или при ошибке — не пишем.
  const sentIds = await sendMailsFromItems(settings, items, false);
  const now = new Date().toISOString();
  const reqMap = storage.readRequested();
  let changed = false;
  for (const id of sentIds || []) {
    reqMap[id] = now;
    changed = true;
  }
  if (changed) storage.writeRequested(reqMap);
  log('info', 'Запрос срока: рассылка завершена по ' + items.length + ' позициям');
  currentTaskId = null;
  currentLogCat = 'general';
}

function urlQueryRefresh(req) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return u.searchParams.get('refresh') === '1';
}

// Снапшот отчёта действителен только в течение сегодняшнего дня:
// иначе при смене месяца/дня возвращался бы устаревший результат.
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  // защита от path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
}

// Сервис «дат отгрузок» (общий для отчётов и сроков).
const ship = makeShipDates({ storage, abcp });
const { buildShippedMap, shipStats } = ship;

// Загрузчик заказов ABCP (общий для всех отчётов).
const orderLoader = makeOrderLoader({
  storage, abcp, log, subtractDays, supplierClientsCache, warehouseCache,
});
const { ensureOrdersLoaded, waitForOrders, getOrdersTimed, filterOrdersByPeriod, getUsersMap, clear: clearOrders } = orderLoader;

const {
  europeEndpoint, clientConfigEndpoint,
  reportEndpoint, rejectionsEndpoint, rejectionsClientsEndpoint, clientAnalysisEndpoint,
  dashboardEndpoint,
} = makeReportHandlers({
  storage, sendJson, sendAbcpError, urlQuery, urlQueryRefresh, buildFilter,
  reportKey, ensureOrdersLoaded, filterOrdersByPeriod, buildShippedMap,
  getUsersMap, subtractDays, computeEurope, computeClientConfig,
  computeReport, computeRejections, buildClientSuppliers, computeClientAnalysis,
  periodedSettings, attachRequested, log, abcp,
  reportCache, rejectionsCache, rejectionsClientsCache, clientAnalysisCache,
  europeCache, clientConfigCache,
  dashboardCache, computeDashboard,
  CLIENT_ANALYSIS_LOOKBACK_DAYS,
});

const { supplierTermsEndpoint, updateSupplierTermEndpoint } = makeSupplierTermsHandlers({
  storage, sendJson, urlQueryRefresh, periodedSettings, subtractDays,
  TERMS_CACHE_VERSION, ensureOrdersLoaded, filterOrdersByPeriod,
  buildShippedMap, computeSupplierTerms, shipStats, routeState, log, abcp,
  requirePowerAdmin, readBody, getOrdersTimed, setLogScope, clearLogScope,
});

const { manualAutomatEndpoint, markOrderedEndpoint, start: startManualAutomat } = makeManualAutomat({
  storage, sendJson, urlQueryRefresh, buildFilter, reportKey,
  ensureOrdersLoaded, getOrdersTimed, waitForOrders, getUsersMap,
  subtractDays, periodedSettings, computeManualAutomat,
  requirePowerAdmin, readBody, log, manualAutomatCache, filterNotSentToday, abcp,
});
startManualAutomat();

// Смонтированный в BIOTIME модуль: это request-функция, а не самостоятельный
// http-сервер. Порт и запуск предоставляет BIOTIME. Авторизацию даёт BIOTIME
// (canSeeReports → req._biotimeSession), запасной путь — свой ap_sid, если модуль
// развернуть отдельно.
function handleRequest(req, res) {
  // Ключ для персональных настроек: предпочитаем id пользователя из сессии
  // (переданной BIOTIME или собственной), иначе — числовой x-vibe-user-id.
  const sess = req._biotimeSession || getSession(req);
  storage.setCurrentUser((sess && sess.userId) || toUserId(req));
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  // Встроенный режим: запросы приходят с префиксом /reports — срезаем его, чтобы
  // внутренние маршруты (/api/*, статика) матчились как у самостоятельного приложения.
  const p = url.pathname.replace(/^\/reports/, '') || '/';

  try {
    // Все данные приложения доступны только после входа по логину/паролю.
    if (p.startsWith('/api/') && !p.startsWith('/api/auth/')) {
      if (!req._biotimeSession && !getSession(req)) return sendJson(res, 401, { error: 'login_required' });
    }
    if (p === '/api/auth/login' && req.method === 'POST') return loginEndpoint(req, res);
    if (p === '/api/auth/logout' && req.method === 'POST') return logoutEndpoint(req, res);
    if (p === '/api/auth/impersonate' && req.method === 'POST') return impersonateEndpoint(req, res);
    if (p === '/api/auth/me' && req.method === 'GET') return authMeEndpoint(req, res);
    if (p === '/api/auth/setup' && req.method === 'POST') return setupEndpoint(req, res);
    if (p === '/api/auth/reset' && req.method === 'POST') return resetSuperAdminEndpoint(req, res);
    if (p === '/api/users' && req.method === 'GET') return usersListEndpoint(req, res);
    if (p === '/api/users' && req.method === 'POST') return usersCreateEndpoint(req, res);
    const uid = parseUserParam(p);
    if (uid && p.startsWith('/api/users/') && req.method === 'PATCH') return usersUpdateEndpoint(req, res, uid);
    if (uid && p.startsWith('/api/users/') && req.method === 'DELETE') return usersDeleteEndpoint(req, res, uid);
    if (p === '/api/settings' && req.method === 'GET') return getSettingsEndpoint(req, res);
    if (p === '/api/settings' && req.method === 'PUT') return saveSettingsEndpoint(req, res);
    if (p === '/api/report' && req.method === 'GET') return reportEndpoint(req, res);
    if (p === '/api/rejections' && req.method === 'GET') return rejectionsEndpoint(req, res);
    if (p === '/api/rejections/clients' && req.method === 'GET') return rejectionsClientsEndpoint(req, res);
    if (p === '/api/client-analysis' && req.method === 'GET') return clientAnalysisEndpoint(req, res);
    if (p === '/api/europe' && req.method === 'GET') return europeEndpoint(req, res);
    if (p === '/api/client-config' && req.method === 'GET') return clientConfigEndpoint(req, res);
    if (p === '/api/manual-automat' && req.method === 'GET') return manualAutomatEndpoint(req, res);
    if (p === '/api/manual-automat/set-ordered' && req.method === 'POST') return markOrderedEndpoint(req, res);
    if (p === '/api/version' && req.method === 'GET') return sendJson(res, 200, { version: APP_VERSION, now: new Date().toISOString() });
    if (p === '/api/status-history' && req.method === 'GET') return statusHistoryEndpoint(req, res);
    if (p === '/api/suppliers' && req.method === 'GET') return suppliersEndpoint(req, res);
    if (p === '/api/supplier-emails' && req.method === 'POST') return supplierEmailsEndpoint(req, res);
    if (p === '/api/supplier-emails/fetch' && req.method === 'GET') return supplierEmailsFetchEndpoint(req, res);
    if (p === '/api/my-ip' && req.method === 'GET') return myIpEndpoint(req, res);
    if (p === '/api/me' && req.method === 'GET') return meEndpoint(req, res);
    if (p === '/api/logs' && req.method === 'GET') return logsEndpoint(req, res);
    if (p === '/api/live-check' && req.method === 'GET') return liveCheckEndpoint(req, res);
    if (p === '/api/supplier-clients' && req.method === 'GET') return supplierClientsEndpoint(req, res);
    if (p === '/api/client-warehouses' && req.method === 'GET') return clientWarehousesEndpoint(req, res);
    if (p === '/api/report/mark-refusal' && req.method === 'POST') return markRefusalEndpoint(req, res);
    if (p === '/api/report/request-term' && req.method === 'POST') return requestTermEndpoint(req, res);
    if (p === '/api/dashboard' && req.method === 'GET') return dashboardEndpoint(req, res);
    if (p === '/api/supplier-terms' && req.method === 'GET') return supplierTermsEndpoint(req, res);
    if (p === '/api/supplier-terms/clear-cache' && req.method === 'POST') return clearTermsCacheEndpoint(req, res);
    if (p === '/api/supplier-terms/update' && req.method === 'POST') return updateSupplierTermEndpoint(req, res);
    if (p === '/api/procenka' && req.method === 'GET') return procenkaEndpoint(req, res);
    if (p === '/api/pricing' && req.method === 'GET') return pricingEndpoint(req, res);
    if (p === '/api/live-suppliers' && req.method === 'GET') return liveSuppliersEndpoint(req, res);
    if (p === '/api/ship-progress' && req.method === 'GET') return sendJson(res, 200, ship.shipProgress());
    if (p === '/api/export' && req.method === 'POST') return exportCreateEndpoint(req, res);
    if (p === '/api/export/download' && req.method === 'GET') return exportDownloadEndpoint(req, res);
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Неизвестный API-метод' });
    const stUrl = new URL((url.pathname.replace(/^\/reports/, '') || '/') + (url.search || ''), 'http://x');
    return serveStatic(req, res, stUrl);
  } catch (e) {
    // общий обработчик: пользователю — обобщённое сообщение, детали — в лог
    console.error('Ошибка обработки запроса:', e.message);
    log('error', 'Запрос ' + p + ': ' + (e && e.stack ? e.stack : e.message), { cat: 'abcp' });
    if (!res.headersSent) {
      return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
    return res.end();
  }
}

module.exports = handleRequest;

// Процесс НЕ должен умирать из-за фоновых задач (письма, догрузка ABCP) или
// случайных исключений: падение процесса = платформа перезапускает его, а шлюз
// в это время отвечает BH_APP_STARTING. Логируем и продолжаем жить.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (ABCP):', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (ABCP):', err && (err.stack || err.message || err));
});

// Процесс НЕ должен умирать из-за фоновых задач (письма, догрузка ABCP) или
// случайных исключений: падение процесса = платформа перезапускает его, а шлюз
// в это время отвечает BH_APP_STARTING. Логируем и продолжаем жить.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err && (err.stack || err.message || err));
});
