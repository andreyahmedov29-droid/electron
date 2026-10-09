// Модуль-обработчик маршрутов водителя (/api/drivers/routes*). Вынесен из
// server.js по частям; пока реализован GET /api/drivers/routes (список маршрутов
// для водителя/админа), остальные методы добавятся в этот же модуль отдельными
// итерациями. Зависимости инъекцией (DI).
module.exports = function createDriverRoutesHandler({
  getDb,
  sendJson,
  readBody,
  persistDb,
  isDriver,
  namesMatch,
  enrichUnloadProgress,
  withResolvedBundleNames,
  normalizeRouteProgress,
  routeKmCache,
  routeKmRoad,
  routeKm,
  routeKmPending,
  routeLockReason,
  normalizeRouteClient,
  autoPullWaybillsFrom1c,
} = {}) {
  return async function handleDriverRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/drivers/routes" && method === "GET") {
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const date = String(params.get("date") || "").slice(0, 10);
      const filterDate = (arr) => (date ? arr.filter((r) => r.date === date) : arr);
      const withKm = (r) => {
        const rr = enrichUnloadProgress(withResolvedBundleNames(normalizeRouteProgress(r), db), db.labels);
        const id = String(rr.id || "");
        const cached = routeKmCache[id];
        if (Number.isFinite(Number(cached))) {
          rr.km = Number(cached);
        } else {
          const saved = Number(rr && rr.km);
          if (Number.isFinite(saved) && saved >= 0 && typeof rr.km === "number") {
            rr.km = saved;
          } else {
            rr.km = routeKm(rr);
            routeKmCache[id] = rr.km;
            if (!routeKmPending[id]) {
              routeKmPending[id] = true;
              routeKmRoad(rr).then((km) => {
                if (Number.isFinite(Number(km))) routeKmCache[id] = Number(km);
              }).catch(() => {}).finally(() => { delete routeKmPending[id]; });
            }
          }
        }
        return rr;
      };
      if (isDriver(user, db) && !admin) {
        const routes = filterDate((db.driverRoutes || []).filter((r) =>
          r.driverId === user.id
          || (r.driverName && user.name && namesMatch(user.name, r.driverName))
        ));
        return sendJson(res, 200, { ok: true, routes: routes.map(withKm) });
      }
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 200, {
        ok: true,
        routes: filterDate(db.driverRoutes || []).map(withKm),
      });
    }

    if (urlPath === "/api/drivers/routes/check" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const date = String(body.date || "").slice(0, 10);
      const driverId = String(body.driverId || "").slice(0, 60);
      const excludeRouteId = String(body.excludeRouteId || "");
      const clientNames = Array.isArray(body.clientNames)
        ? body.clientNames.map((n) => String(n || "").trim()).filter(Boolean)
        : [];
      if (!date || !driverId || clientNames.length === 0) {
        return sendJson(res, 200, { ok: true, intersections: [] });
      }
      const nameSet = new Set(clientNames);
      const intersections = [];
      (db.driverRoutes || []).forEach((r) => {
        if (r.date !== date || String(r.driverId) !== String(driverId)) return;
        if (excludeRouteId && String(r.id) === String(excludeRouteId)) return;
        (Array.isArray(r.clients) ? r.clients : []).forEach((p) => {
          if (p && nameSet.has(String(p.client || "").trim())) {
            intersections.push({
              clientName: String(p.client || ""),
              routeName: r.routeName || "Маршрут",
              routeId: r.id,
            });
          }
        });
      });
      return sendJson(res, 200, { ok: true, intersections });
    }

    return false;
  };
};
