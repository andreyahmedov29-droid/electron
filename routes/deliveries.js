// Модуль-обработчик раздела «Доставка» (/api/deliveries?date=YYYY-MM-DD).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createDeliveriesHandler({
  getDb,
  sendJson,
  withResolvedBundleNames,
  normalizeRouteProgress,
} = {}) {
  return async function handleDeliveriesRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // GET /api/deliveries?date=YYYY-MM-DD — раздел «Доставка».
    // Доступен ЛЮБОМУ вошедшему (не только админу/водителю). Возвращает
    // маршруты всех водителей за дату с именами водителей, статусами точек и
    // прогресса — информационно, чтобы видеть, как едет каждый водитель.
    if (urlPath === "/api/deliveries" && method === "GET") {
      if (!user) return sendJson(res, 401, { error: "forbidden" });
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const date = String(params.get("date") || "").slice(0, 10);
      const list = (date ? (db.driverRoutes || []).filter((r) => r.date === date) : db.driverRoutes || [])
        .map((r) => withResolvedBundleNames(normalizeRouteProgress(r), db))
        .map((r) => {
          const labels = db.labels || [];
          const clients = (Array.isArray(r.clients) ? r.clients : []).map((c, i) => {
            const mine = labels.filter(
              (l) => String(l.routeId) === String(r.id) && Number(l.clientIndex) === i
            );
            const total = mine.length;
            const done = mine.filter((l) => l.status === "delivered").length;
            return {
              client: c.client || "",
              address: c.address || "",
              bundleName: c.bundleName || "",
              members: Array.isArray(c.members) && c.members.length > 0
                ? c.members.map((m) => ({ client: m.client || "" }))
                : undefined,
              state: c.state || "pending",
              postponeReason: c.postponeReason || "",
              lat: Number.isFinite(c.lat) ? c.lat : null,
              lon: Number.isFinite(c.lon) ? c.lon : null,
              transitStart: Number.isFinite(c.transitStart) ? c.transitStart : null,
              transitEnd: Number.isFinite(c.transitEnd) ? c.transitEnd : null,
              transitPaused: Number.isFinite(c.transitPaused) ? c.transitPaused : 0,
              siteStart: Number.isFinite(c.siteStart) ? c.siteStart : null,
              siteEnd: Number.isFinite(c.siteEnd) ? c.siteEnd : null,
              placesTotal: total,
              placesDone: done,
            };
          });
          const routeTotal = clients.reduce((s, c) => s + (c.placesTotal || 0), 0);
          const routeDone = clients.reduce((s, c) => s + (c.placesDone || 0), 0);
          return {
            routeId: r.id,
            driverId: String(r.driverId || ""),
            driverName: r.driverName || "",
            routeName: r.routeName || "",
            date: r.date || "",
            status: (r.progress && r.progress.status) || "idle",
            lunchActive: !!(r.progress && r.progress.lunchActive),
            lunchStart: (r.progress && Number.isFinite(r.progress.lunchStart)) ? r.progress.lunchStart : null,
            base: (r.progress && Number.isFinite(r.progress.baseLat) && Number.isFinite(r.progress.baseLon))
              ? { lat: r.progress.baseLat, lon: r.progress.baseLon }
              : null,
            clients,
            placesTotal: routeTotal,
            placesDone: routeDone,
          };
        });
      return sendJson(res, 200, { ok: true, date, deliveries: list });
    }

    return false;
  };
};
