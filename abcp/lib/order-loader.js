// Загрузка и кэширование заказов ABCP (общий источник для всех отчётов).
// Сбор заказов идёт в фоне (чтобы HTTP-запрос не блокировался десятки секунд),
// с персистентным накоплением по годам в /data.

function makeOrderLoader(deps) {
  const { storage, abcp, log, subtractDays, supplierClientsCache, warehouseCache } = deps;

  let ordersCache = null;
  let ordersCacheKey = '';
  let ordersInProgress = null;
  let ordersError = null;
  let ordersErrorAuth = false;
  let usersCache = null;
  let usersCacheLogin = '';

  function fullKey(s, filter) {
    return JSON.stringify([s.host, s.login, s.dateStart, s.dateEnd, filter || {}]);
  }

  function clear() {
    ordersCache = null;
    ordersCacheKey = '';
    ordersInProgress = null;
    ordersError = null;
    ordersErrorAuth = false;
  }

  function ensureOrdersLoaded(settings, force, filter) {
    const key = fullKey(settings, filter || {});
    const start = settings.dateStart || '';
    const end = settings.dateEnd || '';
    const hasClientFilter = !!(filter && (filter.userId || filter.distributorId));

    if (force) ordersCacheKey = '';
    if (ordersCache && ordersCacheKey === key) return { ready: true, orders: ordersCache };
    if (ordersError && !force) {
      const e = new Error(ordersError);
      e.isAuth = ordersErrorAuth;
      return { error: e };
    }
    if (storage.isPersistentWarming()) return { ready: false };
    const pers = storage.readPersistentOrders();

    const covered = !hasClientFilter && !!pers.coveredStart && !!pers.coveredEnd;
    const chunks = (start && end) ? abcp.splitRangeByDays(start, end) : [];
    const allChunksCovered = covered && chunks.length > 0 &&
      chunks.every((c) => pers.coveredStart <= c.dateStart && c.dateEnd <= pers.coveredEnd);

    if (!force && !hasClientFilter && pers.orders.length && allChunksCovered) {
      ordersCache = pers.orders;
      ordersCacheKey = key;
      return { ready: true, orders: pers.orders };
    }
    if (!force && !hasClientFilter && pers.orders.length && (!chunks.length || allChunksCovered)) {
      ordersCache = pers.orders;
      ordersCacheKey = key;
      return { ready: true, orders: pers.orders };
    }

    if (!ordersInProgress) {
      log('info', 'Загрузка/догрузка заказов ABCP (накопление по годам): ' + (start || '?') + ' — ' + (end || '?'), { cat: 'abcp' });
      ordersInProgress = (async () => {
        if (hasClientFilter || !chunks.length) {
          const added = await abcp.fetchAllOrders({ ...settings, dateStart: start, dateEnd: end }, filter || {});
          return { added, cs: start, ce: end, mergeBase: [], union: false };
        }
        const missing = chunks.filter((c) => !covered || !(pers.coveredStart <= c.dateStart && c.dateEnd <= pers.coveredEnd));
        const seenChunk = new Set(missing.map((c) => c.dateStart + '|' + c.dateEnd));
        const toFetch = missing.slice();
        if (force && start && end) {
          const tailStart = (subtractDays(end, 3) < start) ? start : subtractDays(end, 3);
          const tail = { dateStart: tailStart, dateEnd: end };
          if (!seenChunk.has(tail.dateStart + '|' + tail.dateEnd)) toFetch.push(tail);
        }
        const added = [];
        for (const c of toFetch) {
          const subs = await abcp.fetchAllOrders({ ...settings, dateStart: c.dateStart, dateEnd: c.dateEnd }, filter || {});
          for (const s of subs) added.push(s);
        }
        return { added, cs: start, ce: end, mergeBase: pers.orders, union: true, missing };
      })().then((res) => {
        let merged;
        let cs;
        let ce;
        if (res.union) {
          merged = storage.mergeOrderLists(res.mergeBase, res.added);
          cs = (pers.coveredStart && start) ? (pers.coveredStart < start ? pers.coveredStart : start) : (pers.coveredStart || start);
          ce = (pers.coveredEnd && end) ? (pers.coveredEnd > end ? pers.coveredEnd : end) : (pers.coveredEnd || end);
        } else {
          merged = res.added;
          cs = res.cs;
          ce = res.ce;
        }
        log('info', 'Заказы загружены: ' + merged.length, { cat: 'abcp' });
        ordersCache = merged;
        ordersCacheKey = key;
        ordersError = null;
        ordersErrorAuth = false;
        if (cs && ce) storage.writePersistentOrders(merged, cs, ce);
        supplierClientsCache.clear();
        warehouseCache.clear();
      })
        .catch((e) => {
          ordersError = e.message;
          ordersErrorAuth = Boolean(e.isAuth);
          log('error', 'Загрузка заказов ABCP: ' + (e && e.stack ? e.stack : e.message), { cat: 'abcp' });
        })
        .finally(() => { ordersInProgress = null; });
    }
    return { ready: false };
  }

  function waitForOrders(settings, filter) {
    return new Promise((resolve) => {
      const attempt = () => {
        const s = ensureOrdersLoaded(settings, false, filter);
        if (s.ready || s.error) return resolve(s);
        if (ordersInProgress) {
          ordersInProgress.then(attempt).catch(() => attempt());
        } else {
          resolve(s);
        }
      };
      attempt();
    });
  }

  function getOrdersTimed(settings, maxMs = 30000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const s = ensureOrdersLoaded(settings, false);
        if (s.ready || s.error) return resolve(s);
        if (Date.now() - start > maxMs) return resolve({ ready: false });
        setTimeout(tick, 1500);
      };
      tick();
    });
  }

  function filterOrdersByPeriod(orders, start, end) {
    if (!start && !end) return orders || [];
    return (orders || []).filter((o) => {
      const d = String(o.date || '').slice(0, 10);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  async function getUsersMap(settings) {
    const login = settings.login || '';
    if (usersCache && usersCacheLogin === login) return usersCache;
    usersCache = await abcp.fetchUsers(settings);
    usersCacheLogin = login;
    return usersCache;
  }

  return { clear, ensureOrdersLoaded, waitForOrders, getOrdersTimed, filterOrdersByPeriod, getUsersMap };
}

module.exports = { makeOrderLoader };
