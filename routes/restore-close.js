// Модуль-обработчик восстановления «потерянных» офлайн-закрытий водителя
// (/api/admin/restore-client-close). Вынесен из server.js дословно; зависямости инъекцией (DI).
module.exports = function createRestoreCloseHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
} = {}) {
  return async function handleRestoreCloseRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/admin/restore-client-close" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const search = String(body.search || "").trim().toLowerCase();
      let route;
      if (routeId) {
        route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
        if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      } else {
        if (!search) return sendJson(res, 422, { error: "Укажите routeId или search" });
        route = (db.driverRoutes || []).find((r) => (r.clients || []).some(
          (c) => !!c && typeof c === "object" &&
            (String(c.client || "").toLowerCase().includes(search) ||
             String(c.address || "").toLowerCase().includes(search))
        ));
        if (!route) return sendJson(res, 404, { error: "Клиент по поиску не найден ни в одном маршруте" });
      }
      const hasIndex = body.clientIndex !== undefined && body.clientIndex !== null && body.clientIndex !== "";
      let clientIndex;
      if (hasIndex) {
        clientIndex = Number(body.clientIndex);
      } else {
        if (!search) return sendJson(res, 422, { error: "Укажите clientIndex или search" });
        const hit = (route.clients || []).findIndex(
          (c) => !!c && typeof c === "object" &&
            (String(c.client || "").toLowerCase().includes(search) ||
             String(c.address || "").toLowerCase().includes(search))
        );
        if (hit < 0) return sendJson(res, 404, { error: "Клиент не найден в маршруте" });
        clientIndex = hit;
      }
      if (!Number.isInteger(clientIndex) || clientIndex < 0 || clientIndex >= (route.clients || []).length) {
        return sendJson(res, 422, { error: "Некорректный clientIndex" });
      }
      const t = (Number.isFinite(Number(body.closedAt)) && Number(body.closedAt) > 0)
        ? Number(body.closedAt) : Date.now();
      const siteSeconds = (Number.isFinite(Number(body.siteSeconds)) && Number(body.siteSeconds) > 0)
        ? Number(body.siteSeconds) : 0;

      const cl = route.clients[clientIndex];
      if (!cl || typeof cl !== "object") {
        return sendJson(res, 422, { error: "Точка маршрута повреждена" });
      }
      const bundleKeyOf2 = (c) => {
        if (c && c.bundleId) return "b:" + String(c.bundleId);
        const a = String((c && c.address) || "").trim().toLowerCase();
        return a ? "a:" + a : "";
      };
      const targetKey = bundleKeyOf2(cl);
      const groupIdx = (route.clients || [])
        .map((c, i) => ({ c, i }))
        .filter((o) => !!o.c && typeof o.c === "object" && bundleKeyOf2(o.c) === targetKey && targetKey)
        .map((o) => o.i);
      const affected = groupIdx.length ? groupIdx : [clientIndex];

      const qty = Math.max(0, Math.min(500, Number.isInteger(Number(body.places))
        ? Number(body.places)
        : (Number(cl.labelQty) || 0)));
      db.labels = db.labels || [];
      const now36 = Date.now().toString(36);
      const existingPlaces = new Set(
        db.labels
          .filter((l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === clientIndex)
          .map((l) => Number(l.place))
      );
      let scanAdded = 0;
      const deliverPlace = (code, place) => {
        let lab = db.labels.find((l) => String(l.code) === String(code));
        if (!lab) {
          lab = {
            id: `${now36}-${Math.random().toString(36).slice(2, 7)}`,
            code,
            routeId: String(route.id),
            clientIndex,
            client: String(cl.client || ""),
            address: String(cl.address || ""),
            place,
            status: "created",
            at: t,
            createdBy: user.id != null ? String(user.id) : null,
          };
          db.labels.push(lab);
        }
        if (lab.status !== "delivered") {
          if (!lab.loadedAt) { lab.loadedAt = t; lab.loadedBy = user.id != null ? String(user.id) : null; }
          lab.status = "delivered";
          lab.deliveredAt = t;
          lab.deliveredBy = user.id != null ? String(user.id) : null;
          scanAdded++;
        }
      };
      if (qty > 0) {
        for (let n = 1; n <= qty; n++) {
          const code = `BG${route.id}-${clientIndex + 1}-${n}`;
          deliverPlace(code, n);
        }
        db.labels
          .filter((l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === clientIndex)
          .forEach((l) => { if (l.status !== "delivered") { deliverPlace(String(l.code), Number(l.place)); } });
      }
      if (scanAdded > 0) {
        const scanLogLimit = Number(db.params && db.params.scanLogLimit) || 30000;
        db.scanLog = db.scanLog || [];
        for (const l of db.labels.filter(
          (x) => String(x.routeId) === String(route.id) && Number(x.clientIndex) === clientIndex
        )) {
          db.scanLog.push({
            ts: t,
            userId: user.id != null ? String(user.id) : null,
            userName: String(user.name || ""),
            action: "unload",
            code: String(l.code || ""),
            client: String(l.client || ""),
            address: String(l.address || ""),
            routeId: String(route.id),
            status: "delivered",
            warning: null,
          });
        }
        if (db.scanLog.length > scanLogLimit) db.scanLog = db.scanLog.slice(-scanLogLimit);
      }

      affected.forEach((i) => {
        const c = route.clients[i];
        if (!c || typeof c !== "object") return;
        if (!c.id) c.id = `${route.id}-st${i + 1}`;
        c.siteStart = t - siteSeconds * 1000;
        c.siteEnd = t;
        c.unloadFinished = true;
        if (c.state !== "delivered" && c.state !== "postponed") {
          c.state = "delivered";
        }
      });
      await persistDb();
      return sendJson(res, 200, { ok: true, clientIndex, closed: affected, closedAt: t, siteSeconds });
    }

    return false;
  };
};
