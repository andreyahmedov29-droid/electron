'use strict';

const { computeReport } = require('./logic');

const REQUEST_TIMEOUT_MS = 180 * 1000; // портал отвечает десятками секунд
const PAGE_SIZE = 1000; // ABCP отдаёт максимум 1000 заказов за один запрос
const CONCURRENCY = 40;
const MAX_ATTEMPTS = 4;
const MAX_RANGE_DAYS = 364; // ABCP ограничивает диапазон дат одним годом (иначе HTTP 400)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Отдаёт управление event loop между большими операциями (объединение страниц),
// чтобы сервер продолжал отвечать на проверки шлюза и не ловил BH_APP_STARTING.
const yieldToLoop = () => new Promise((r) => setImmediate(r));

// Стабильный ключ заказа для объединения/дедупликации: по id, иначе по дате+номеру.
function orderKey(o) {
  if (o && o.id != null) return 'i:' + o.id;
  if (o && o.number != null) return 'n:' + (o.date || '') + '|' + o.number;
  return '';
}

// Проверка, что host выглядит как легитимный внешний домен (без схемы/пробелов/путей).
function validateHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) return false;
  if (!host.includes('.')) return false;
  // Запрещаем локальные/приватные адреса, чтобы сервер не стал SSRF-прокси в сеть.
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return false;
  const ipv4 = lower.split('.');
  if (ipv4.length === 4 && ipv4.every((o) => /^\d{1,3}$/.test(o))) {
    const [a, b] = ipv4.map((o) => Number(o));
    if (
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224
    ) {
      return false;
    }
  }
  return true;
}

function fmtDateTime(date) {
  return `${date} 00:00:00`;
}

function fmtEndDateTime(date) {
  return `${date} 23:59:59`;
}

function buildQuery(params) {
  // encodeURIComponent защищает параметры от инъекций в URL
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}

// Забирает ОДНУ страницу (до 1000 заказов) с format=p, который возвращает { items, count }.
async function fetchPage(host, login, md5Password, opts) {
  const base = `https://${host}/cp/orders`;
  const query = buildQuery({
    userlogin: login,
    userpsw: md5Password,
    format: 'p',
    dateCreatedStart: opts.dateStart ? fmtDateTime(opts.dateStart) : undefined,
    dateCreatedEnd: opts.dateEnd ? fmtEndDateTime(opts.dateEnd) : undefined,
    limit: PAGE_SIZE,
    skip: opts.skip || 0,
    distributorId: opts.distributorId || undefined,
    userId: opts.userId || undefined,
  });
  const url = `${base}?${query}`;

  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(4000);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) {
          let detail = '';
          try {
            const body = await res.json();
            detail = body.errorMessage || body.errorCode || '';
          } catch (_e) {
            /* без тела */
          }
          const err = new Error(`ABCP вернул HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
          err.statusCode = res.status;
          err.isAuth = res.status === 401 || res.status === 403 || detail === '102' || detail === '103';
          err.isHttp = true;
          err.retryable = res.status === 429 || res.status === 423 || res.status >= 500;
          throw err;
        }
        const body = await res.json();
        let orders;
        let count = 0;
        if (Array.isArray(body)) {
          orders = body;
          count = body.length;
        } else if (body && Array.isArray(body.items)) {
          orders = body.items;
          count = Number(body.count) || body.items.length;
        } else {
          throw new Error('Непредвиденная структура ответа ABCP (ожидался список заказов)');
        }
        return { orders, count };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // Ошибки авторизации и обычные HTTP (4xx) не повторяем.
      if (e.isAuth) throw e;
      if (e.isHttp && !e.retryable) throw e;
      lastErr = e;
    }
  }
  if (lastErr && lastErr.name === 'AbortError') {
    throw new Error('ABCP не ответил в течение отведённого времени — попробуйте уменьшить период отчёта');
  }
  throw new Error(`Сетевая ошибка при запросе к ABCP: ${lastErr ? lastErr.message : 'неизвестная'}`);
}

// Режет диапазон дат по календарным годам: каждый год — отдельная выгрузка
// (ABCP не принимает период больше года, а так заказы грузятся «годами» и потом объединяются).
function splitRangeByDays(start, end, maxDays) {
  if (!start || !end) return [{ dateStart: start, dateEnd: end }];
  const parse = (d) => new Date(d + 'T00:00:00Z'); // UTC, чтобы не сдвигать даты на часовой пояс
  const fmt = (d) => d.toISOString().slice(0, 10);
  const s = parse(start);
  const e = parse(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return [{ dateStart: start, dateEnd: end }];
  const chunks = [];
  let cur = new Date(s.getTime());
  while (cur <= e) {
    // конец текущего календарного года (в пределах выбранного диапазона)
    let yearEnd = new Date(Date.UTC(cur.getUTCFullYear(), 11, 31));
    if (yearEnd > e) yearEnd = new Date(e.getTime());
    chunks.push({ dateStart: fmt(cur), dateEnd: fmt(yearEnd) });
    cur = new Date(Date.UTC(yearEnd.getUTCFullYear() + 1, 0, 1));
  }
  return chunks;
}

// Параллельно тянем страницы одного подпериода: count из первого ответа позволяет грузить их разом.
async function fetchRangePages(host, login, md5Password, period, filter) {
  const first = await fetchPage(host, login, md5Password, { ...period, ...filter, skip: 0 });
  const orders = [...first.orders];
  const count = first.count;
  if (orders.length >= PAGE_SIZE && count > orders.length) {
    const totalPages = Math.ceil(count / PAGE_SIZE);
    const skips = [];
    for (let s = PAGE_SIZE; s < totalPages * PAGE_SIZE; s += PAGE_SIZE) skips.push(s);
    const pages = await mapLimit(skips, CONCURRENCY, (skip) =>
      fetchPage(host, login, md5Password, { ...period, ...filter, skip })
    );
    for (const page of pages) {
      for (const o of page.orders) orders.push(o);
      await yieldToLoop();
    }
  }
  return orders;
}

// Забираем заказы из ABCP. Если период длиннее года — разбиваем на подпериоды ≤ 1 года,
// каждый тянем отдельно, затем объединяем по id (ABCP иначе отвечает HTTP 400).
async function fetchAllOrders(settings, opts = {}) {
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5Password = settings.md5Password.trim();

  if (!validateHost(host)) {
    const e = new Error('Некорректный хост API ABCP');
    e.badConfig = true;
    throw e;
  }
  if (!login || !md5Password) {
    const e = new Error('Не задан логин или MD5-пароль ABCP');
    e.badConfig = true;
    throw e;
  }

  const filter = {
    distributorId: opts.distributorId || undefined,
    userId: opts.userId || undefined,
  };
  const chunks = splitRangeByDays(settings.dateStart, settings.dateEnd);
  const all = [];
  for (const chunk of chunks) {
    const orders = await fetchRangePages(host, login, md5Password, chunk, filter);
    // Цикл, а не all.push(...orders): спред большого массива в аргументы превышает
    // лимит V8 (~65 535) и бросает "Maximum call stack size exceeded" на крупных годах.
    for (const o of orders) all.push(o);
  }
  // Объединяем по id (или дате+номеру для заказов без id), чтобы не задвоить данные.
  const seen = new Set();
  const out = [];
  for (const o of all) {
    const k = orderKey(o);
    if (k) {
      if (seen.has(k)) continue;
      seen.add(k);
    }
    out.push(o);
  }
  return out;
}

function mapLimit(items, limit, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results.push(await fn(items[cur]));
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  return Promise.all(workers).then(() => results);
}

// Полное название клиентов из ABCP (cp/users): возвращает Map userId -> name.
async function fetchUsers(settings) {
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5Password = settings.md5Password.trim();
  const base = `https://${host}/cp/users`;
  const all = [];
  let skip = 0;
  for (;;) {
    const query = buildQuery({
      userlogin: login,
      userpsw: md5Password,
      limit: 1000,
      skip,
    });
    const url = `${base}?${query}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let page;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`ABCP вернул HTTP ${res.status}`);
      page = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(page)) throw new Error('Непредвиденная структура ответа ABCP (cp/users)');
    all.push(...page);
    if (page.length < 1000) break;
    skip += page.length;
  }
  const map = {};
  for (const u of all) {
    // «Наименование» клиента в ABCP — краткое наименование организации (organizationName),
    // при его отсутствии — внутреннее имя клиента (name).
    if (u && u.userId != null) map[String(u.userId)] = u.organizationName || u.name || '';
  }
  return map;
}

// Живой поиск цен по артикулу (клиентский API search/articles).
async function liveSearch(settings, number, brand) {
  const host = settings.host.trim();
  const login = settings.clientLogin || '';
  const md5 = settings.clientMd5 || '';
  const q = buildQuery({
    userlogin: login,
    userpsw: md5,
    number,
    brand,
  });
  const url = `https://${host}/search/articles?${q}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(20000);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
      if (r.status === 423 || r.status === 429) continue; // лимит — ждём и повторяем
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = await r.json();
      return Array.isArray(b) ? b : [];
    } finally {
      clearTimeout(t);
    }
  }
  return [];
}

// История изменения статуса позиции (cp/order/statusHistory).
async function fetchStatusHistory(settings, positionId) {
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5Password = settings.md5Password.trim();
  const query = buildQuery({
    userlogin: login,
    userpsw: md5Password,
    positionId,
  });
  const url = `https://${host}/cp/order/statusHistory?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`ABCP вернул HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  } finally {
    clearTimeout(timer);
  }
}

// Список поставщиков ABCP с контактами (операция cp/distributors) — поле email.
async function fetchSuppliersEmails(settings) {
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5Password = settings.md5Password.trim();
  const all = [];
  let skip = 0;
  for (;;) {
    const query = buildQuery({
      userlogin: login,
      userpsw: md5Password,
      limit: 1000,
      skip,
    });
    const url = `https://${host}/cp/distributors?${query}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let page;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`ABCP вернул HTTP ${res.status}`);
      page = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(page)) break;
    all.push(...page);
    if (page.length < 1000) break;
    skip += page.length;
  }
  return all
    .map((d) => {
      const name = d.name || d.publicName || '';
      const email = String(d.email || '').trim();
      return { name: String(name).trim(), email };
    })
    .filter((x) => x.name && x.email);
}

// Обёртка: забирает заказы из ABCP и строит отчёт по логике просрочки.
async function buildReport(settings) {
  const orders = await fetchAllOrders(settings);
  // Просрочка считается по дате «Ожидается» (плановая дата уже прошла).
  // Статусы на клиенте работают как прямой фильтр отображения.
  const report = computeReport(orders, {
    now: new Date(),
    completedStatusCodes: [],
  });
  report.ordersCount = orders.length;
  report.generatedAt = new Date().toISOString();
  report.statusCodes = collectStatusCodes(orders);
  return report;
}

// Все уникальные статусы позиций за период — чтобы пользователь мог выбрать фильтр.
function collectStatusCodes(orders) {
  const map = {};
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const key = String(pos.statusCode);
      if (!map[key]) {
        map[key] = { statusCode: key, status: pos.status || `Статус ${key}`, count: 0 };
      }
      map[key].count += 1;
    }
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

// Обновление данных маршрута поставщика: операция cp/route (POST).
// Параметры: routeId (обязательный) + только изменяемые поля, например deadlineMax
// (максимальный срок поставки в часах). См. документацию ABCP, раздел «Маршруты».
async function updateRoute(settings, routeId, fields) {
  const host = settings.host.trim();
  const login = settings.login.trim();
  const md5 = settings.md5Password.trim();
  const parts = [
    `userlogin=${encodeURIComponent(login)}`,
    `userpsw=${encodeURIComponent(md5)}`,
    `routeId=${encodeURIComponent(String(routeId))}`,
  ];
  for (const k of Object.keys(fields || {})) {
    const v = fields[k];
    if (v !== undefined && v !== null) parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  const r = await fetch(`https://${host}/cp/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parts.join('&'),
  });
  const body = await r.text();
  return { status: r.status, body };
}

// Список маршрутов поставщика: операция cp/routes (GET). Маршрут — это АКТУАЛЬНЫЙ
// routeId (поле id) для операции cp/route; значения dsRouteId из заказов не всегда
// совпадают с ним, поэтому для обновления сроков маршруты берём отсюда.
async function fetchRoutes(settings, distributorId) {
  const host = settings.host.trim();
  const query = buildQuery({
    userlogin: settings.login.trim(),
    userpsw: settings.md5Password.trim(),
    distributorId,
    withDisabled: '0',
  });
  const url = `https://${host}/cp/routes?${query}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await r.text();
  let routes = [];
  try {
    const arr = JSON.parse(body);
    if (Array.isArray(arr)) routes = arr;
  } catch (_e) { /* не-JSON */ }
  return { status: r.status, body, routes };
}

module.exports = {
  validateHost,
  fetchAllOrders,
  splitRangeByDays,
  fetchUsers,
  liveSearch,
  fetchStatusHistory,
  fetchSuppliersEmails,
  buildReport,
  collectStatusCodes,
  updateRoute,
  fetchRoutes,
};
