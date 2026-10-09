// Эндпоинты отчётов. Зависимости передаются явным объектом (deps), чтобы модуль
// не тянул глобальное состояние server.js.
const { isSnapFresh } = require('./cache');

function makeReportHandlers(deps) {
  const {
    storage, sendJson, sendAbcpError, urlQuery, urlQueryRefresh, buildFilter,
    reportKey, ensureOrdersLoaded, filterOrdersByPeriod, buildShippedMap,
    getUsersMap, subtractDays, computeEurope, computeClientConfig,
    computeReport, computeRejections, buildClientSuppliers, computeClientAnalysis,
    periodedSettings, attachRequested, log, abcp,
    reportCache, rejectionsCache, rejectionsClientsCache, clientAnalysisCache,
    europeCache, clientConfigCache,
    dashboardCache, computeDashboard,
    CLIENT_ANALYSIS_LOOKBACK_DAYS,
  } = deps;

  // «Просрочка».
  async function reportEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const eff = periodedSettings(settings, 'reportPeriod');
      const key = reportKey(eff, filter);
      if (!refresh && reportCache.get(key)) return sendJson(res, 200, attachRequested(reportCache.get(key)));
      if (!refresh && !reportCache.get(key)) {
        const snap = storage.readReportSnapshot('report', key);
        if (snap && isSnapFresh(snap)) {
          reportCache.set(key, snap);
          return sendJson(res, 200, attachRequested(snap));
        }
      }
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
      const report = computeReport(orders, { now: new Date(), completedStatusCodes: [], names });
      report.ordersCount = orders.length;
      report.generatedAt = new Date().toISOString();
      report.statusCodes = abcp.collectStatusCodes(state.orders);
      reportCache.set(key, report);
      storage.writeReportSnapshot('report', key, report);
      return sendJson(res, 200, attachRequested(report));
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  // «Отказы по поставщикам».
  async function rejectionsEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const eff = periodedSettings(settings, 'rejPeriod');
      const key = reportKey(eff, filter);
      if (!refresh && rejectionsCache.get(key)) return sendJson(res, 200, rejectionsCache.get(key));
      if (!refresh && !rejectionsCache.get(key)) {
        const snap = storage.readReportSnapshot('rejections', key);
        if (snap && isSnapFresh(snap)) {
          rejectionsCache.set(key, snap);
          return sendJson(res, 200, snap);
        }
      }
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
      const data = computeRejections(orders, { names, priceField: 'priceIn' });
      {
        const t = data.byDistributor.reduce((s, x) => s + (x.total || 0), 0);
        const r = data.byDistributor.reduce((s, x) => s + (x.refusals || 0), 0);
        log('info', 'Отказы (поставщики): всего шт ' + t + ', отказов шт ' + r + ', % ' + (t ? Math.round((r / t) * 1000) / 10 : 0), { cat: 'abcp' });
      }
      const merged = new Map();
      for (const d of data.byDistributor || []) {
        const i = String(d.name || '').indexOf(':');
        const base = i < 0 ? String(d.name || '').trim() : String(d.name).slice(0, i).trim();
        const wh = i < 0 ? '' : String(d.name).slice(i + 1).trim();
        const e = merged.get(base) || { name: base, total: 0, refusals: 0, refusalSum: 0, hasWh: false };
        e.total += d.total || 0;
        e.refusals += d.refusals || 0;
        e.refusalSum = (e.refusalSum || 0) + (d.refusalSum || 0);
        if (wh) e.hasWh = true;
        merged.set(base, e);
      }
      data.byDistributor = Array.from(merged.values())
        .sort((a, b) => b.refusals - a.refusals)
        .map((e) => ({ ...e, percent: e.total ? Math.round((e.refusals / e.total) * 1000) / 10 : 0 }));
      data.ordersCount = orders.length;
      data.generatedAt = new Date().toISOString();
      rejectionsCache.set(key, data);
      storage.writeReportSnapshot('rejections', key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  // «Отказ клиенты».
  async function rejectionsClientsEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const eff = periodedSettings(settings, 'crjPeriod');
      const key = reportKey(eff, filter);
      if (!refresh && rejectionsClientsCache.get(key)) return sendJson(res, 200, rejectionsClientsCache.get(key));
      if (!refresh && !rejectionsClientsCache.get(key)) {
        const snap = storage.readReportSnapshot('rejectionsClients', key);
        if (snap && isSnapFresh(snap)) {
          rejectionsClientsCache.set(key, snap);
          return sendJson(res, 200, snap);
        }
      }
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
      const data = computeRejections(orders, { groupBy: 'client', names, priceField: 'priceOut' });
      {
        data.supplierBreakdown = buildClientSuppliers(orders, names);
        const t = data.byDistributor.reduce((s, x) => s + (x.total || 0), 0);
        const r = data.byDistributor.reduce((s, x) => s + (x.refusals || 0), 0);
        log('info', 'Отказы (клиенты): всего шт ' + t + ', отказов шт ' + r + ', % ' + (t ? Math.round((r / t) * 1000) / 10 : 0), { cat: 'abcp' });
      }
      data.ordersCount = orders.length;
      data.generatedAt = new Date().toISOString();
      rejectionsClientsCache.set(key, data);
      storage.writeReportSnapshot('rejectionsClients', key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  // «Анализ заказов клиентов».
  async function clientAnalysisEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const eff = periodedSettings(settings, 'caPeriod');
      const key = reportKey(eff, filter);
      log('info', `Анализ клиентов: запрос refresh=${refresh}, период=${eff.dateStart || '?'} — ${eff.dateEnd || '?'}`, { cat: 'abcp' });
      if (!refresh && clientAnalysisCache.get(key)) return sendJson(res, 200, clientAnalysisCache.get(key));
      if (!refresh && !clientAnalysisCache.get(key)) {
        const snap = storage.readReportSnapshot('clientAnalysis', key);
        if (snap && isSnapFresh(snap)) {
          clientAnalysisCache.set(key, snap);
          return sendJson(res, 200, snap);
        }
      }
      const ordersEff = eff.dateStart
        ? { ...eff, dateStart: subtractDays(eff.dateStart, CLIENT_ANALYSIS_LOOKBACK_DAYS) }
        : eff;
      const state = ensureOrdersLoaded(ordersEff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const data = computeClientAnalysis(state.orders, names, { start: eff.dateStart, end: eff.dateEnd });
      data.ordersCount = (state.orders || []).length;
      data.generatedAt = new Date().toISOString();
      data.effPeriod = { start: eff.dateStart, end: eff.dateEnd };
      clientAnalysisCache.set(key, data);
      storage.writeReportSnapshot('clientAnalysis', key, data);
      log('info', `Анализ клиентов: период ${eff.dateStart || '?'} — ${eff.dateEnd || '?'}, ${data.clients.length} клиентов, сумма ${data.totals.sum} ₽, маржа ${data.totals.margin} ₽`, { cat: 'abcp' });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  // «Дашборд».
  async function dashboardEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.' });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const eff0 = periodedSettings(settings, 'dashPeriod');
      const from = urlQuery(req, 'from');
      const to = urlQuery(req, 'to');
      const dOk = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
      // Опциональные from/to переопределяют сохранённый период (нужно для рендера дашборда).
      const eff = (dOk(from) && dOk(to) && from <= to) ? { ...eff0, dateStart: from, dateEnd: to } : eff0;
      const key = reportKey(eff, {});
      if (!refresh && dashboardCache.get(key)) {
        return sendJson(res, 200, dashboardCache.get(key));
      }
      const realStart = eff.dateStart || '';
      const realEnd = eff.dateEnd || '';
      const fetchStart = realStart ? subtractDays(realStart, 15) : '';
      const ordersEff = { ...eff, dateStart: fetchStart };
      const state = ensureOrdersLoaded(ordersEff, refresh);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      log('info', `Дашборд период: ${realStart || '?'} — ${realEnd || '?'} | заказов в наборе: ${state.orders.length}`, { cat: 'abcp' });
      const data = {
        ...computeDashboard(state.orders, { start: realStart, end: realEnd }),
        ordersCount: state.orders.length,
        generatedAt: new Date().toISOString(),
      };
      dashboardCache.set(key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      log('error', 'Дашборд: ' + (e && e.stack ? e.stack : e.message), { cat: 'abcp' });
      return sendJson(res, 502, { error: `Не удалось получить данные: ${e.message}` });
    }
  }

  // «Отчет Европа»: сводка по клиентам за период только по поставщику «EU».
  async function europeEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, {
        error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.',
        settings: storage.toPublicSettings(settings),
      });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      // Заказы смотрим за 90 дней: если период ещё не выбран — берём последние 90 дней
      // и сохраняем, чтобы календарь показывал именно этот диапазон.
      const p90 = settings.euPeriod || {};
      const okD = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
      const todayE = new Date().toISOString().slice(0, 10);
      if (!okD(p90.start) || !okD(p90.end) || p90.start > p90.end) {
        p90.start = subtractDays(todayE, 89);
        p90.end = todayE;
        storage.writeSettings({ ...settings, euPeriod: { start: p90.start, end: p90.end } });
      }
      const eff = { ...settings, dateStart: p90.start, dateEnd: p90.end };
      const key = reportKey(eff, filter);
      if (!refresh && europeCache.get(key)) return sendJson(res, 200, europeCache.get(key));
      if (!refresh && !europeCache.get(key)) {
        const snap = storage.readReportSnapshot('europe', key);
        if (snap && isSnapFresh(snap)) {
          europeCache.set(key, snap);
          return sendJson(res, 200, snap);
        }
      }
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const names = await getUsersMap(eff);
      const data = computeEurope(state.orders, names, { start: eff.dateStart, end: eff.dateEnd });
      data.ordersCount = (state.orders || []).length;
      data.generatedAt = new Date().toISOString();
      data.effPeriod = { start: eff.dateStart, end: eff.dateEnd };
      europeCache.set(key, data);
      storage.writeReportSnapshot('europe', key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  // «Конфигуратор сроков поставки для клиента»: по выбранным прайсовым поставщикам
  // за 30 дней — средний/мин/макс срок + общий средний.
  async function clientConfigEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.', settings: storage.toPublicSettings(settings) });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const filter = buildFilter(req);
      const todayE = new Date().toISOString().slice(0, 10);
      const start = subtractDays(todayE, 29);
      const end = todayE;
      const sel = String(urlQuery(req, 'suppliers') || '').split(',').map((s) => s.trim()).filter(Boolean);
      const eff = { ...settings, dateStart: subtractDays(todayE, 40), dateEnd: todayE };
      const key = reportKey(eff, { ...filter, suppliers: sel.join(',') });
      if (!refresh && clientConfigCache.get(key)) return sendJson(res, 200, clientConfigCache.get(key));
      const state = ensureOrdersLoaded(eff, refresh, filter);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const orders = filterOrdersByPeriod(state.orders, eff.dateStart, eff.dateEnd);
      const { map: shippedMap, orderedMap } = await buildShippedMap(orders, eff);
      const data = computeClientConfig(orders, shippedMap, orderedMap, { start, end, selected: sel });
      data.ordersCount = (state.orders || []).length;
      data.generatedAt = new Date().toISOString();
      data.effPeriod = { start, end };
      clientConfigCache.set(key, data);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendAbcpError(res, e);
    }
  }

  return {
    europeEndpoint, clientConfigEndpoint,
    reportEndpoint, rejectionsEndpoint, rejectionsClientsEndpoint, clientAnalysisEndpoint,
    dashboardEndpoint,
  };
}

module.exports = { makeReportHandlers };
