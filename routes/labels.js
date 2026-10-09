// Модуль-обработчик складских этикеток и сканирования мест (/api/labels*).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
//   POST  /api/labels              { routeId, clientIndex, qty, mode }
//   DELETE /api/labels/:id
//   POST  /api/labels/scan         { code, action: "load"|"unload", clientTime? }
//   GET   /api/labels              ?routeId=..&clientIndex=.. (или ?code=..)
module.exports = function createLabelsHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  canSeeShipment,
  isDriver,
} = {}) {
  return async function handleLabelsRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // ---- Этикетки отгрузки (трекинг мест по QR) ----
    // Создать этикетки для клиента в маршруте: POST /api/labels { routeId, clientIndex, qty }
    if (urlPath === "/api/labels" && method === "POST") {
      if (!canSeeShipment(user, db) && !admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const clientIndex = Number(body.clientIndex);
      const qty = Math.max(1, Math.min(200, Number(body.qty) || 1));
      const mode = body.mode === "append" ? "append" : "replace";
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      const clients = Array.isArray(route.clients) ? route.clients : [];
      if (!Number.isInteger(clientIndex) || clientIndex < 0 || clientIndex >= clients.length) {
        return sendJson(res, 400, { error: "Неверный индекс клиента" });
      }
      const cl = clients[clientIndex];
      if (mode === "append") {
        const existingCount = (db.labels || []).filter(
          (l) => String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex
        ).length;
        cl.labelQty = existingCount + qty;
        const now = Date.now();
        for (let i = 1; i <= qty; i++) {
          const place = existingCount + i;
          const code = `BG${routeId}-${clientIndex + 1}-${place}`;
          db.labels.push({
            id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            code,
            routeId: String(routeId),
            clientIndex,
            client: String(cl.client || ""),
            address: String(cl.address || ""),
            place,
            status: "created",
            at: now,
            createdBy: user.id != null ? String(user.id) : null,
          });
        }
      } else {
        cl.labelQty = qty;
        db.labels = (db.labels || []).filter(
          (l) => !(String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex)
        );
        const now = Date.now();
        for (let i = 1; i <= qty; i++) {
          const code = `BG${routeId}-${clientIndex + 1}-${i}`;
          db.labels.push({
            id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            code,
            routeId: String(routeId),
            clientIndex,
            client: String(cl.client || ""),
            address: String(cl.address || ""),
            place: i,
            status: "created",
            at: now,
            createdBy: user.id != null ? String(user.id) : null,
          });
        }
      }
      if (db.labels.length > 8000) db.labels = db.labels.slice(-8000);
      await persistDb();
      const created = db.labels.filter(
        (l) => String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex
      );
      return sendJson(res, 200, { ok: true, labels: created });
    }

    // Удалить ошибочно созданную этикетку: DELETE /api/labels/:id
    let lm = urlPath.match(/^\/api\/labels\/([A-Za-z0-9_-]+)$/) || null;
    if (lm && method === "DELETE") {
      if (!canSeeShipment(user, db) && !admin) return sendJson(res, 403, { error: "forbidden" });
      const id = lm[1];
      const idx = (db.labels || []).findIndex((l) => String(l.id) === String(id));
      if (idx < 0) return sendJson(res, 404, { error: "Этикетка не найдена" });
      const label = db.labels[idx];
      if (label.status !== "created") {
        return sendJson(res, 409, {
          error: "Удалить можно только этикетку в статусе «создана» (не отсканированную)",
        });
      }
      db.labels.splice(idx, 1);
      await persistDb();
      return sendJson(res, 200, { ok: true, id, code: String(label.code || "") });
    }

    // Сканирование места: POST /api/labels/scan { code, action: "load"|"unload" }
    if (urlPath === "/api/labels/scan" && method === "POST") {
      const body = await readBody(req);
      const code = String(body.code || "").trim();
      const action = String(body.action || "").trim();
      if (!code) return sendJson(res, 400, { error: "Укажите код этикетки" });
      if (action !== "load" && action !== "unload") return sendJson(res, 400, { error: "Неизвестное действие" });
      if (action === "load" && !canSeeShipment(user, db) && !admin) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      if (action === "unload" && !isDriver(user, db) && !admin) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      db.labels = db.labels || [];
      let found = db.labels.find((l) => String(l.code) === String(code));
      // Авто-воссоздание меток по коду, если запись не была создана при печати.
      if (!found) {
        const route = (db.driverRoutes || []).find((rd) => String(code).startsWith("BG" + rd.id + "-"));
        if (route) {
          const suffix = String(code).slice(("BG" + route.id + "-").length);
          const parts = suffix.split("-");
          const cIdx = Number(parts[0]) - 1;
          const scannedPlace = Number(parts[1]);
          if (Number.isInteger(cIdx) && cIdx >= 0 && cIdx < (route.clients || []).length) {
            const rc = route.clients[cIdx];
            const qty = Math.max(1, Math.min(200, Number(rc && rc.labelQty) || scannedPlace || 1));
            const now2 = Date.now();
            const existingPlaces = new Set(
              db.labels
                .filter((l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === cIdx)
                .map((l) => Number(l.place))
            );
            for (let n = 1; n <= qty; n++) {
              if (existingPlaces.has(n)) continue;
              const c2 = `BG${route.id}-${cIdx + 1}-${n}`;
              db.labels.push({
                id: `${now2.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                code: c2,
                routeId: String(route.id),
                clientIndex: cIdx,
                client: String(rc.client || ""),
                address: String(rc.address || ""),
                place: n,
                status: "created",
                at: now2,
                createdBy: user.id != null ? String(user.id) : null,
              });
              // Держим Set актуальным на лету: без этого отсканированное место,
              // только что созданное циклом, ниже считалось бы «ещё не существующим»
              // и добавлялось бы ВТОРОЙ раз — дубль этикетки места (и «съехавший»
              // бокс для фронта).
              existingPlaces.add(n);
            }
            if (!existingPlaces.has(scannedPlace)) {
              db.labels.push({
                id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
                code: `BG${route.id}-${cIdx + 1}-${scannedPlace}`,
                routeId: String(route.id),
                clientIndex: cIdx,
                client: String(rc.client || ""),
                address: String(rc.address || ""),
                place: scannedPlace,
                status: "created",
                at: Date.now(),
                createdBy: user.id != null ? String(user.id) : null,
              });
              if (rc && (Number(rc.labelQty) || 0) < scannedPlace) rc.labelQty = scannedPlace;
            }
            found = db.labels.find((l) => String(l.code) === String(code));
          }
        }
      }
      if (!found) return sendJson(res, 404, { error: "Этикетка не найдена" });
      const now = Date.now();
      const t = (Number.isFinite(Number(body.clientTime)) && Number(body.clientTime) > 0)
        ? Number(body.clientTime) : now;
      let warning = null;
      let changed = false;
      if (action === "load") {
        const wbRoute = db.driverRoutes.find((rd) => String(rd.id) === String(found.routeId));
        const wbForClient = wbRoute && wbRoute.waybills && wbRoute.waybills[found.clientIndex];
        if (wbForClient && Array.isArray(wbForClient.items) && wbForClient.items.length > 0) {
          const hasInBox = wbForClient.items.some(
            (it) => String(it.box) === String(found.code) && (Number(it.scanned) || 0) > 0
          );
          if (!hasInBox) {
            return sendJson(res, 409, { error: "В этом боксе нет собранных деталей — завершите сборку" });
          }
        }
        if (found.status === "loaded" || found.status === "delivered") {
          warning = found.status === "delivered" ? "Место уже отгружено и выгружено" : "Место уже погружено";
        } else {
          found.status = "loaded";
          found.loadedAt = t;
          found.loadedBy = user.id != null ? String(user.id) : null;
          changed = true;
        }
      } else { // unload
        if (found.status === "created") {
          warning = "Место ещё не погружено (выгружать рано)";
        } else if (found.status === "delivered") {
          warning = "Место уже выгружено";
        } else {
          found.status = "delivered";
          found.deliveredAt = t;
          found.deliveredBy = user.id != null ? String(user.id) : null;
          changed = true;
        }
      }
      if (changed) {
        const scanLogLimit = Number(db.params && db.params.scanLogLimit) || 30000;
        db.scanLog = db.scanLog || [];
        db.scanLog.push({
          ts: t,
          userId: user.id != null ? String(user.id) : null,
          userName: String(user.name || ""),
          action,
          code: String(found.code || ""),
          client: String(found.client || ""),
          address: String(found.address || ""),
          routeId: found.routeId != null ? String(found.routeId) : null,
          status: String(found.status || ""),
          warning: null,
        });
        if (db.scanLog.length > scanLogLimit) db.scanLog = db.scanLog.slice(-scanLogLimit);
      }
      persistDb().catch(() => {});
      return sendJson(res, 200, { ok: true, label: found, warning });
    }

    // Статус этикеток: GET /api/labels?routeId=..&clientIndex=.. (или ?code=..)
    if (urlPath === "/api/labels" && method === "GET") {
      if (!canSeeShipment(user, db) && !admin && !isDriver(user, db)) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const routeId = String(params.get("routeId") || "");
      const clientIndex = params.get("clientIndex");
      const code = String(params.get("code") || "");
      let list = db.labels || [];
      if (code) {
        list = list.filter((l) => String(l.code) === String(code));
      } else if (routeId) {
        list = list.filter((l) => String(l.routeId) === String(routeId));
        if (clientIndex !== null && clientIndex !== undefined && clientIndex !== "") {
          const ci = Number(clientIndex);
          if (Number.isInteger(ci)) list = list.filter((l) => Number(l.clientIndex) === ci);
        }
      }
      return sendJson(res, 200, { ok: true, labels: list });
    }

    return false;
  };
};
