// Модуль-обработчик отгрузки маршрутов (склад). Вынесен из server.js
// (handleShipmentRoutes): GET /api/shipments, /complete, /reopen, /start,
// /selfpickup-done. Логика дословно; зависимости инъекцией (DI).
module.exports = function createShipmentHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  canSeeShipment,
  canManageShipment,
  alignWaybillsToClients,
  withResolvedBundleNames,
  normalizeRouteProgress,
  purgeEmptyBoxes,
  getOnecPullLog,
} = {}) {
  return async function handleShipmentRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/shipments" && method === "GET") {
      if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const routes = (db.driverRoutes || [])
        .filter((r) => !!r)
        .map((r) => {
          const route = alignWaybillsToClients(withResolvedBundleNames(normalizeRouteProgress(r), db));
          // Дообогащение из журнала заборов 1С: у позиций накладной, где партисткер
          // отсутствует (накладная создана раньше / из xlsx), дозаполняем `partsticker`
          // и `partQty` по совпадающему артикулу из последних записей журнала. Так
          // партисткеры появляются в сборке без повторного «Заполнить из 1С».
          if (getOnecPullLog && route && route.waybills) {
            const logRows = getOnecPullLog();
            if (Array.isArray(logRows) && logRows.length) {
              const used = new Set();
              try {
                Object.values(route.waybills).forEach((wb) => {
                  if (!wb || !Array.isArray(wb.items)) return;
                  wb.items = wb.items.map((it) => {
                    if (!it || it.partsticker || it.art == null) return it;
                    for (const e of logRows) {
                      if (!Array.isArray(e && e.items)) continue;
                      for (const li of e.items) {
                        if (!li || !li.partsticker) continue;
                        if (String(li.art) === String(it.art) && !used.has(String(li.partsticker))) {
                          used.add(String(li.partsticker));
                          return Object.assign({}, it, {
                            partsticker: li.partsticker,
                            partQty: (li.partQty != null ? Number(li.partQty) : (Number(li.qty) || 1)),
                          });
                        }
                      }
                    }
                    return it;
                  });
                });
              } catch { /* не критично */ }
            }
          }
          const labels = (db.labels || []).filter((l) => String(l.routeId) === String(route.id));
          route.clients = (route.clients || []).map((c, i) => ({
            ...c,
            loadedCount: labels.filter((l) => Number(l.clientIndex) === i && l.status === "loaded").length,
            totalCount: labels.filter((l) => Number(l.clientIndex) === i).length,
            waybillProgress: (() => {
              const wb = route.waybills && route.waybills[i];
              const items = (wb && Array.isArray(wb.items)) ? wb.items : [];
              const anyScanned = items.some((it) => (Number(it.scanned) || 0) > 0 || (Number(it.missingQty) || 0) > 0);
              return { finished: !!(wb && wb.finished), anyScanned, hasItems: items.length > 0 };
            })(),
          }));
          return route;
        })
        .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || 0);
      return sendJson(res, 200, { ok: true, routes });
    }

    if (urlPath === "/api/shipments/complete" && method === "POST") {
      if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      if (!canManageShipment(user, db)) {
        const routeLabels = (db.labels || []).filter((l) => String(l.routeId) === String(route.id));
        const unscanned = routeLabels.filter((l) => l.status !== "loaded");
        if (unscanned.length > 0) {
          return sendJson(res, 409, {
            error: `Отсканируйте все этикетки (осталось ${unscanned.length}), чтобы завершить отгрузку`,
          });
        }
      }
      if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
      route.progress.shippedAt = Date.now();
      route.progress.shippedBy = user.id != null ? String(user.id) : null;
      await persistDb();
      return sendJson(res, 200, { ok: true, route: withResolvedBundleNames(normalizeRouteProgress(route), db) });
    }

    if (urlPath === "/api/shipments/reopen" && method === "POST") {
      if (!canManageShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      if (route.progress) {
        if (route.progress.status === "done") {
          return sendJson(res, 409, { error: "Маршрут уже завершён водителем — вернуть на отгрузку нельзя" });
        }
        delete route.progress.shippedAt;
        delete route.progress.shippedBy;
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, route: withResolvedBundleNames(normalizeRouteProgress(route), db) });
    }

    if (urlPath === "/api/shipments/start" && method === "POST") {
      if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
      if (db.params && db.params.allowWaybill === true) {
        const clients = Array.isArray(route.clients) ? route.clients : [];
        const missing = clients.findIndex((_, i) => {
          const wb = route.waybills && route.waybills[i];
          if (wb && wb.finished) return false;
          return !wb || !Array.isArray(wb.items) || wb.items.length === 0;
        });
        if (missing >= 0) {
          return sendJson(res, 409, {
            error: `Загрузите расходную накладную на клиента «${(route.clients[missing].client || route.clients[missing].bundleName || route.clients[missing].address || (missing + 1)).slice(0, 60)}», чтобы начать отгрузку`,
          });
        }
        const notReady = clients.findIndex((_, i) => {
          const wb = route.waybills && route.waybills[i];
          const items = (wb && wb.items) || [];
          return items.some((it) => (Number(it.scanned) || 0) < (Number(it.qty) || 0) && !it.missing);
        });
        if (notReady >= 0) {
          return sendJson(res, 409, {
            error: `Сборка для клиента «${(route.clients[notReady].client || route.clients[notReady].bundleName || route.clients[notReady].address || (notReady + 1)).slice(0, 60)}» не завершена: остались несобранные позиции`,
          });
        }
      }
      purgeEmptyBoxes(route, db);
      if (!route.progress.shipmentStartedAt) {
        route.progress.shipmentStartedAt = Date.now();
        route.progress.shipmentStartedBy = user.id != null ? String(user.id) : null;
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, route: withResolvedBundleNames(normalizeRouteProgress(route), db) });
    }

    if (urlPath === "/api/shipments/selfpickup-done" && method === "POST") {
      if (!canSeeShipment(user, db) && !admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      if (!route.selfPickup) return sendJson(res, 400, { error: "Это не маршрут самовывоза" });
      route.progress = route.progress || { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
      route.progress.status = "done";
      route.progress.doneAt = Date.now();
      route.progress.shipmentDoneAt = Date.now();
      (Array.isArray(route.clients) ? route.clients : []).forEach((c) => {
        if (c && typeof c === "object") { c.state = "shipped"; c.siteStart = c.siteStart || null; c.siteEnd = Date.now(); }
      });
      if (Array.isArray(db.labels)) {
        db.labels
          .filter((l) => String(l.routeId) === String(route.id) && l.status !== "delivered")
          .forEach((l) => { l.status = "delivered"; l.deliveredAt = l.deliveredAt || Date.now(); });
      }
      route.at = Date.now();
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }
    return false;
  };
};
