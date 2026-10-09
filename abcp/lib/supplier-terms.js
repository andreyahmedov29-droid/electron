// «Сроки по поставщикам»: чтение реальных сроков + фоновый сбор сроков маршрутов.
// Обработчик обновления сроков (запись в ABCP) остаётся в server.js — он часть
// фоновой задачи записи.

function makeSupplierTermsHandlers(deps) {
  const {
    storage, sendJson, urlQueryRefresh, periodedSettings, subtractDays,
    TERMS_CACHE_VERSION, ensureOrdersLoaded, filterOrdersByPeriod,
    buildShippedMap, computeSupplierTerms, shipStats, routeState, log, abcp,
    requirePowerAdmin, readBody, getOrdersTimed, setLogScope, clearLogScope,
  } = deps;

  // Поставщики, которым макс. срок не обновляем (нет реального маршрута ABCP).
  const TERM_NO_UPDATE = ['Сфера Минск', 'EU'];

  // «Срок мин/макс» из кэша маршрутов (источник истины после обновления срока в ABCP).
  function mergeRouteTerms(suppliers) {
    const rt = storage.readRouteTerms();
    const now = Date.now();
    return (suppliers || []).map((s) => {
      const r = rt && rt[s.name];
      if (!r) return s;
      if (r.ts && (now - r.ts) > 24 * 3600 * 1000) return s;
      const s2 = { ...s };
      // Округляем в большую сторону до целых дней — как и «Реальный (80%)».
      if (r.minDays != null && Number.isFinite(Number(r.minDays))) s2.termMin = Math.ceil(Number(r.minDays));
      if (r.maxDays != null && Number.isFinite(Number(r.maxDays))) s2.termMax = Math.ceil(Number(r.maxDays));
      return s2;
    });
  }

  // Фоновый сбор макс./мин. срока маршрутов поставщиков через cp/routes.
  async function warmRouteTerms(settings, orders) {
    if (routeState.busy) return;
    routeState.busy = true;
    try {
      const distByName = new Map();
      for (const o of orders || []) {
        for (const p of o.positions || []) {
          const name = String(p.distributorName || '').trim();
          if (!name) continue;
          if (/\[online\]/i.test(name) || Number(p.distributorType) === 22) continue;
          if (p.distributorId == null) continue;
          if (!distByName.has(name)) distByName.set(name, new Set());
          distByName.get(name).add(String(p.distributorId));
        }
      }
      const out = storage.readRouteTerms();
      const now = Date.now();
      const entries = Array.from(distByName.entries());
      let i = 0;
      const worker = async () => {
        while (i < entries.length) {
          const idx = i++;
          const [name, dists] = entries[idx];
          let minHours = Infinity;
          let maxHours = -Infinity;
          for (const did of Array.from(dists).slice(0, 20)) {
            const fr = await abcp.fetchRoutes(settings, did);
            for (const rw of fr.routes || []) {
              if (rw.deadline != null) {
                const dh = Number(rw.deadline);
                if (Number.isFinite(dh)) minHours = Math.min(minHours, dh);
              }
              const mx = rw.deadlineMax != null ? Number(rw.deadlineMax) : rw.deadline;
              if (mx != null && Number.isFinite(mx)) maxHours = Math.max(maxHours, mx);
            }
            await new Promise((r2) => setTimeout(r2, 40));
          }
          out[name] = {
            minDays: minHours === Infinity ? null : Math.ceil(minHours / 24),
            maxDays: maxHours === -Infinity ? null : Math.ceil(maxHours / 24),
            ts: now,
          };
        }
      };
      await Promise.all(Array.from({ length: 4 }, () => worker()));
      storage.writeRouteTerms(out);
      log('info', 'Сроки маршрутов обновлены (' + Object.keys(out).length + ' поставщиков)', { cat: 'term' });
    } finally {
      routeState.busy = false;
    }
  }

  async function supplierTermsEndpoint(req, res) {
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) {
      return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено. Укажите хост, логин и MD5-пароль.' });
    }
    try {
      const refresh = urlQueryRefresh(req);
      const eff = periodedSettings(settings, 'termsPeriod');
      const end = new Date().toISOString().slice(0, 10);
      const start = subtractDays(end, 60);
      const ordersEff = { ...eff, dateStart: start, dateEnd: end };

      if (!refresh) {
        const cached = storage.readTermsCache();
        if (cached && cached.version === TERMS_CACHE_VERSION && cached.suppliers && cached.generatedAt) {
          const age = Date.now() - new Date(cached.generatedAt).getTime();
          const ttl = 12 * 3600 * 1000;
          if (age >= 0 && age < ttl) {
            return sendJson(res, 200, {
              suppliers: mergeRouteTerms(cached.suppliers),
              ordersCount: cached.ordersCount || 0,
              generatedAt: cached.generatedAt,
              loadingShip: false,
              shipProgress: { done: 1, total: 1 },
              routeLoading: routeState.busy,
            });
          }
        }
      }

      const state = ensureOrdersLoaded(ordersEff, refresh);
      if (state.error) return sendJson(res, 502, { error: state.error.message, auth: Boolean(state.error.isAuth) });
      if (!state.ready) return sendJson(res, 202, { loading: true });
      const orders = filterOrdersByPeriod(state.orders, ordersEff.dateStart, ordersEff.dateEnd);
      const { map: shippedMap, orderedMap, hasMore } = await buildShippedMap(orders, eff);
      warmRouteTerms(settings, orders).catch(() => {});
      const suppliers = mergeRouteTerms(computeSupplierTerms(orders, shippedMap, orderedMap));
      const data = {
        suppliers,
        ordersCount: orders.length,
        generatedAt: new Date().toISOString(),
        loadingShip: hasMore,
        shipProgress: { done: shipStats.done, total: shipStats.total },
        routeLoading: routeState.busy,
      };
      storage.writeTermsCache({
        version: TERMS_CACHE_VERSION,
        suppliers: data.suppliers,
        ordersCount: data.ordersCount,
        generatedAt: data.generatedAt,
      });
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 502, { error: `Не удалось получить данные: ${e.message}` });
    }
  }

  // Запись реального расчётного срока (в днях) в МАКСИМАЛЬНЫЙ срок маршрута ABCP (в часах).
  async function updateSupplierTermEndpoint(req, res) {
    const s = requirePowerAdmin(req, res);
    if (!s) return;
    const settings = storage.readSettings();
    if (!storage.isConfigured(settings)) return sendJson(res, 409, { error: 'Подключение к ABCP ещё не настроено.' });
    const body = await readBody(req).catch(() => '{}');
    let items = [];
    try {
      const p = JSON.parse(body || '{}');
      items = Array.isArray(p.items) ? p.items : [];
    } catch (_e) { /* ignore */ }
    if (!items.length) return sendJson(res, 400, { error: 'Нет поставщиков' });
    runTermUpdateTask(settings, items.slice(0, 200)).catch((e) => {
      log('error', 'Обновление сроков (фон): ' + (e && e.message ? e.message : e), { cat: 'term' });
    });
    return sendJson(res, 200, {
      accepted: true,
      message: 'Задача принята — обновление сроков выполняется в фоне. Итог смотрите в Логах → Изменение срока.',
    });
  }

  async function runTermUpdateTask(settings, items) {
    setLogScope('term-' + Date.now(), 'term');
    routeState.busy = true;
    try {
      log('info', 'Обновление сроков: принято поставщиков ' + items.length + ' — запускаю в фоне');
      const todayStrU = new Date().toISOString().slice(0, 10);
      const effU = { ...settings, dateStart: subtractDays(todayStrU, 120), dateEnd: todayStrU };
      const stateU = await getOrdersTimed(effU, 60000);
      const distBySup = new Map();
      const onlineBySup = new Set();
      if (stateU.ready) {
        for (const o of stateU.orders || []) {
          for (const p of o.positions || []) {
            const name = String(p.distributorName || '').trim();
            if (!name) continue;
            if (/\[online\]/i.test(name) || Number(p.distributorType) === 22) onlineBySup.add(name);
            const did = p.distributorId != null ? p.distributorId : null;
            if (did == null) continue;
            if (!distBySup.has(name)) distBySup.set(name, new Set());
            distBySup.get(name).add(String(did));
          }
        }
      }
      let okCount = 0;
      let badCount = 0;
      for (const it of items) {
        const supplier = String(it.supplier || '').trim();
        const realDays = Number(it.realDays);
        const minDays = Number(it.minDays);
        if (onlineBySup.has(supplier)) { badCount += 1; log('warn', 'Срок не меняем (онлайн): ' + supplier, { cat: 'term' }); continue; }
        if (!supplier || !Number.isFinite(realDays) || realDays <= 0 || TERM_NO_UPDATE.includes(supplier)) {
          badCount += 1; log('warn', 'Срок не обновлён (нет данных/исключён): ' + supplier, { cat: 'term' }); continue;
        }
        const minD = Number.isFinite(minDays) && minDays > 0 ? minDays : null;
        if (minD != null && realDays < minD) {
          badCount += 1; log('warn', 'Срок не обновлён (' + supplier + '): макс ' + realDays + ' дн. < мин ' + Math.round(minD * 10) / 10 + ' дн.', { cat: 'term' }); continue;
        }
        let hours = Math.ceil(realDays * 24);
        if (minD != null && realDays <= minD) hours = (Math.ceil(minD) + 1) * 24;
        const dists = Array.from(distBySup.get(supplier) || []).slice(0, 20);
        let ok = true;
        let lastStatus = 0;
        let lastBody = '';
        let routeCount = 0;
        try {
          for (const did of dists) {
            const fr = await abcp.fetchRoutes(settings, did);
            const routes = (fr.routes || []).filter((rw) => rw && rw.id != null);
            for (const rw of routes.slice(0, 50)) {
              const r = await abcp.updateRoute(settings, rw.id, { deadlineMax: hours });
              lastStatus = r.status;
              lastBody = r.body;
              routeCount += 1;
              if (!(r.status >= 200 && r.status < 300)) { ok = false; break; }
              await new Promise((r2) => setTimeout(r2, 60));
            }
            if (!ok) break;
            await new Promise((r2) => setTimeout(r2, 60));
          }
          if (ok && routeCount) { okCount += 1; } else { badCount += 1; }
          if (ok) log('info', 'Срок обновлён: ' + supplier + ' → ' + hours + ' ч (макс., маршрутов: ' + routeCount + ')', { cat: 'term' });
          else if (!routeCount) log('warn', 'Срок не обновлён (нет маршрутов): ' + supplier, { cat: 'term' });
          else log('error', 'Ошибка обновления срока ' + supplier + ' → ' + hours + ' ч: HTTP ' + lastStatus + ' ' + lastBody.slice(0, 300), { cat: 'term' });
          if (ok && routeCount) {
            const rt = storage.readRouteTerms();
            const prev = rt[supplier] || {};
            rt[supplier] = { minDays: prev.minDays != null ? prev.minDays : null, maxDays: Math.ceil(hours / 24), ts: Date.now() };
            storage.writeRouteTerms(rt);
          }
        } catch (e) {
          badCount += 1;
          log('error', 'Ошибка обновления срока ' + supplier + ': ' + e.message, { cat: 'term' });
        }
      }
      log('info', 'Обновление сроков завершено: успешно ' + okCount + ', ошибок/пропущено ' + badCount, { cat: 'term' });
    } finally {
      clearLogScope();
      routeState.busy = false;
    }
  }

  return { supplierTermsEndpoint, updateSupplierTermEndpoint };
}

module.exports = { makeSupplierTermsHandlers };
