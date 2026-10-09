// «Ручной автомат»: отчёт по «Принят» за сегодня + смена статуса на «Заказан»
// (вручную и фоном), статистика «Отправлено».

const { parseAbcpDate, isAcceptedStatus } = require('./logic');

function makeManualAutomat(deps) {
  const {
    storage, sendJson, urlQueryRefresh, buildFilter, reportKey,
    ensureOrdersLoaded, getOrdersTimed, waitForOrders, getUsersMap,
    subtractDays, periodedSettings, computeManualAutomat,
    requirePowerAdmin, readBody, log, manualAutomatCache, filterNotSentToday, abcp,
  } = deps;

  // Резервный код статуса «Заказан» (см. завершающие статусы портала).
  const DEFAULT_ZAKAZAN_CODE = '92320';

  function findStatusCode(orders, re) {
    for (const o of orders || []) {
      for (const p of o.positions || []) {
        if (re.test(String(p.status || '').trim())) return String(p.statusCode || '');
      }
    }
    return '';
  }

  function zakazanCode(orders) {
    return findStatusCode(orders, /^заказан$/i) || DEFAULT_ZAKAZAN_CODE;
  }

  // Позиции, уже отправленные «Принят» → «Заказан» сегодня (для гарда повторов).
  function sentTodaySet() {
    const today = new Date().toISOString().slice(0, 10);
    const stats = storage.readAutomatStats();
    const day = stats && stats.byDay && stats.byDay[today];
    const list = (day && day.total && day.total.positionIds) || [];
    return new Set(list.map((x) => String(x)));
  }

  // Короткий кэш фактического статуса позиции (чтобы не стучать в ABCP по каждой
  // позиции каждый цикл). Ключ — кабинет ABCP + positionId (чтобы не путать базы).
  const STATUS_CHECK_TTL = 5 * 60 * 1000;
  const STATUS_ERROR_TTL = 60 * 1000;
  const STATUS_CACHE_MAX = 500;
  const statusCache = new Map(); // key -> { kind:'ok', accepted, ts } | { kind:'err', ts }
  const statusPending = new Map(); // key -> Promise (дедуп параллельных запросов)

  function pickLatestStatus(history) {
    if (!Array.isArray(history) || !history.length) return '';
    let best = history[0];
    let bestT = -Infinity;
    for (const h of history) {
      const t = parseAbcpDate(h && (h.statusChangeDate || h.date || h.dateTime || ''));
      if (t > bestT) { bestT = t; best = h; }
    }
    return best && (best.status || best.statusName || best.name || best.statusText || '');
  }

  function cabinetKey(settings) {
    return String(settings.host || '').trim() + '|' + String(settings.login || '').trim();
  }
  function statusCacheKey(settings, pid) {
    return cabinetKey(settings) + '|' + String(pid);
  }
  // Ограничиваем размер кэша: при переполнении выкидываем самые старые записи.
  function trimStatusCache() {
    if (statusCache.size <= STATUS_CACHE_MAX) return;
    const entries = Array.from(statusCache.keys())
      .map((k) => ({ k, ts: (statusCache.get(k) && statusCache.get(k).ts) || 0 }))
      .sort((a, b) => a.ts - b.ts);
    let remove = statusCache.size - STATUS_CACHE_MAX;
    for (const e of entries) {
      if (remove <= 0) break;
      statusCache.delete(e.k);
      remove--;
    }
  }

  // Проверка фактического статуса на ABCP.
  // Возвращает { ok:true, accepted } если статус подтверждён,
  // { ok:false } если проверить не удалось (сетевая/серверная ошибка).
  // Ошибка и реальный статус кэшируются раздельно (ошибку статусом не считаем).
  async function isActuallyAccepted(settings, positionId) {
    const key = statusCacheKey(settings, positionId);
    const now = Date.now();
    const cached = statusCache.get(key);
    if (cached && cached.kind === 'ok' && now - cached.ts < STATUS_CHECK_TTL) return { ok: true, accepted: cached.accepted };
    if (cached && cached.kind === 'err' && now - cached.ts < STATUS_ERROR_TTL) return { ok: false };
    if (statusPending.has(key)) return statusPending.get(key);
    const p = (async () => {
      try {
        const history = await abcp.fetchStatusHistory(settings, String(positionId));
        const accepted = isAcceptedStatus(pickLatestStatus(history));
        statusCache.set(key, { kind: 'ok', accepted, ts: Date.now() });
        trimStatusCache();
        return { ok: true, accepted };
      } catch (e) {
        log('warn', 'Ручной автомат: не удалось проверить статус ' + positionId + ': ' + e.message, { cat: 'abcp' });
        statusCache.set(key, { kind: 'err', ts: Date.now() });
        trimStatusCache();
        return { ok: false };
      } finally {
        statusPending.delete(key);
      }
    })();
    statusPending.set(key, p);
    return p;
  }

  async function manualAutomatEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const todayStr = new Date().toISOString().slice(0, 10);
      const maStart = subtractDays(todayStr, 90);
      const maEnd = todayStr;
      const eff = { ...settings, dateStart: maStart, dateEnd: maEnd };
      const key = reportKey(eff, filter);
      if (!refresh && manualAutomatCache.get(key)) return sendJson(res, 200, manualAutomatCache.get(key));
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const data = computeManualAutomat(state.orders, names, {
        suppliers: settings.manualAutomatSuppliers || [],
        todayStr,
      });
      data.effPeriod = { start: maStart, end: maEnd };
      data.generatedAt = new Date().toISOString();
      data.sentStats = storage.automatStatsPublic();
      manualAutomatCache.set(key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 502, {
        error: e.isAuth ? 'ABCP отклонил учётные данные — проверьте логин и MD5-пароль'
          : e.badConfig ? e.message : `Не удалось получить данные из ABCP: ${e.message}`,
        auth: Boolean(e.isAuth),
      });
    }
  }

  async function markOrderedEndpoint(req, res) {
    const s = requirePowerAdmin(req, res);
    if (!s) return;
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
    const eff = periodedSettings(settings, 'caPeriod');
    const body = await readBody(req).catch(() => '{}');
    let items = [];
    try {
      const parsed = JSON.parse(body || '{}');
      items = Array.isArray(parsed.items) ? parsed.items : [];
    } catch (_e) { /* ignore */ }
    items = items.filter((x) => x && x.positionId != null).slice(0, 500);
    if (!items.length) return sendJson(res, 400, { error: 'Не выбраны позиции' });
    const todayStr = new Date().toISOString().slice(0, 10);
    const ordersEff = { ...eff, dateStart: subtractDays(todayStr, 80), dateEnd: todayStr };
    const state = await getOrdersTimed(ordersEff);
    const code = state.ready ? zakazanCode(state.orders) : '';
    if (!code) return sendJson(res, 502, { error: 'Код статуса «Заказан» не определён — обновите данные' });
    const visibleRows = state.ready
      ? computeManualAutomat(state.orders, {}, { suppliers: settings.manualAutomatSuppliers || [], todayStr }).rows
      : [];
    const allowed = new Set(visibleRows.map((r) => String(r.positionId)));
    const rowByPos = new Map(visibleRows.map((r) => [String(r.positionId), r]));
    const before = items.length;
    items = items.filter((it) => allowed.has(String(it.positionId)));
    if (!items.length) return sendJson(res, 400, { error: 'Нет позиций среди показанных в отчёте «Ручной автомат»' });
    if (items.length !== before) log('info', `Ручной автомат: отсеяно ${before - items.length} позиций вне показанного списка`, { cat: 'abcp' });
    // Гард: не отправлять повторно позиции, уже переведённые в «Заказан» сегодня.
    const sentToday = sentTodaySet();
    const before2 = items.length;
    items = filterNotSentToday(items, sentToday);
    if (items.length !== before2) log('info', `Ручной автомат: пропущено ${before2 - items.length} уже отправленных сегодня позиций`, { cat: 'abcp' });
    if (!items.length) return sendJson(res, 200, { ok: true, failed: 0, message: 'Все выбранные позиции уже отправлены сегодня' });
    const host = settings.host.trim();
    const login = settings.login.trim();
    const md5 = settings.md5Password.trim();
    let failed = 0;
    let skipped = 0;
    const sentEntries = [];
    for (const it of items) {
      // Сверка с ABCP: отправляем «Заказан» только если позиция реально ещё «Принят».
      const check = await isActuallyAccepted(settings, String(it.positionId));
      if (!check.ok || !check.accepted) {
        sentToday.add(String(it.positionId));
        skipped++;
        continue;
      }
      const orderNumber = String(it.orderNumber != null ? it.orderNumber : '');
      const bodyMap = [
        `userlogin=${encodeURIComponent(login)}`,
        `userpsw=${encodeURIComponent(md5)}`,
        ...(orderNumber ? [`order[number]=${encodeURIComponent(orderNumber)}`] : []),
        `order[positions][0][id]=${encodeURIComponent(String(it.positionId))}`,
        `order[positions][0][statusCode]=${encodeURIComponent(code)}`,
      ];
      try {
        const r = await fetch(`https://${host}/cp/order?userlogin=${encodeURIComponent(login)}&userpsw=${encodeURIComponent(md5)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: bodyMap.join('&'),
        });
        await r.text();
        const row = rowByPos.get(String(it.positionId));
        if (row && r.status >= 200 && r.status < 300) {
          sentEntries.push({ positionId: String(it.positionId), qty: row.qty, sum: row.sum, orderNumber: row.orderNumber, client: row.client, margin: row.margin });
          sentToday.add(String(it.positionId));
        } else if (!(r.status >= 200 && r.status < 300)) {
          failed++;
          log('error', 'Ручной автомат: cp/order HTTP ' + r.status + ' — ' + String(it.positionId), { cat: 'abcp' });
        }
      } catch (e) {
        failed++;
        log('error', 'Ручной автомат: cp/order ошибка — ' + e.message);
      }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    storage.recordAutomatStats(sentEntries);
    manualAutomatCache.clear();
    log('info', 'Ручной автомат: статус «Заказан» проставлен (ошибок: ' + failed + ')', { cat: 'abcp' });
    return sendJson(res, 200, { ok: true, failed, skipped, message: failed ? 'Ошибок: ' + failed : 'Статус «Заказан» проставлен' });
  }

  let automatRunning = false;
  async function runAutomatAuto() {
    if (automatRunning) return;
    automatRunning = true;
    try {
      const settings = storage.readSettings();
      if (settings.manualAutomatAuto !== true) return;
      if (!storage.isConfigured(settings)) return;
      const todayStr = new Date().toISOString().slice(0, 10);
      const eff = { ...settings, dateStart: subtractDays(todayStr, 90), dateEnd: todayStr };
      const state = await waitForOrders(eff);
      if (!state.ready || state.error) return;
      let rows = computeManualAutomat(state.orders, {}, {
        suppliers: settings.manualAutomatSuppliers || [],
        todayStr,
      }).rows;
      if (!rows.length) return;
      // Гард: не отправлять повторно позиции, уже переведённые в «Заказан» сегодня.
      const sentToday = sentTodaySet();
      const before2 = rows.length;
      rows = filterNotSentToday(rows, sentToday);
      if (rows.length !== before2) log('info', `Автомат: пропущено ${before2 - rows.length} уже отправленных сегодня позиций`, { cat: 'automat' });
      if (!rows.length) return;
      const code = zakazanCode(state.orders);
      if (!code) { log('error', 'Автомат: код статуса «Заказан» не определён', { cat: 'automat' }); return; }
      const host = settings.host.trim();
      const login = settings.login.trim();
      const md5 = settings.md5Password.trim();
      const changed = new Set();
      let failed = 0;
      let skipped = 0;
      const sentEntries = [];
      for (const r of rows) {
        // Сверка с ABCP: отправляем «Заказан» только если позиция реально ещё «Принят».
        const check = await isActuallyAccepted(settings, String(r.positionId));
        if (!check.ok || !check.accepted) {
          sentToday.add(String(r.positionId));
          skipped++;
          continue;
        }
        const orderNumber = String(r.orderNumber != null ? r.orderNumber : '');
        const bodyMap = [
          `userlogin=${encodeURIComponent(login)}`,
          `userpsw=${encodeURIComponent(md5)}`,
          ...(orderNumber ? [`order[number]=${encodeURIComponent(orderNumber)}`] : []),
          `order[positions][0][id]=${encodeURIComponent(String(r.positionId))}`,
          `order[positions][0][statusCode]=${encodeURIComponent(code)}`,
        ];
        try {
          const rr = await fetch(`https://${host}/cp/order?userlogin=${encodeURIComponent(login)}&userpsw=${encodeURIComponent(md5)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: bodyMap.join('&'),
          });
          await rr.text();
          if (rr.status >= 200 && rr.status < 300) {
            changed.add(orderNumber);
            sentEntries.push({ positionId: String(r.positionId), qty: r.qty, sum: r.sum, orderNumber, client: r.client, margin: r.margin });
            sentToday.add(String(r.positionId));
          } else {
            failed++;
            log('error', 'Автомат cp/order HTTP ' + rr.status + ' — ' + String(r.positionId), { cat: 'automat' });
          }
        } catch (e) {
          failed++;
          log('error', 'Автомат cp/order: ' + e.message, { cat: 'automat' });
        }
        await new Promise((r2) => setTimeout(r2, 50));
      }
      storage.recordAutomatStats(sentEntries);
      if (changed.size) {
        manualAutomatCache.clear();
        log('info', `Автомат: статус «Заказан» по ${changed.size} позициям (пропущено: ${skipped}, ошибок: ${failed}). Заказы: ${Array.from(changed).join(', ')}`, { cat: 'automat' });
      }
    } catch (e) {
      log('error', 'Автомат: ' + e.message, { cat: 'automat' });
    } finally {
      automatRunning = false;
    }
  }

  function start() {
    setInterval(runAutomatAuto, 30 * 1000);
  }

  return { manualAutomatEndpoint, markOrderedEndpoint, start };
}

module.exports = { makeManualAutomat };
