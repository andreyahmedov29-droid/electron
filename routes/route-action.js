// Модуль-обработчик действий водителя по маршруту (/api/drivers/routes/action).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createRouteActionHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  enrichUnloadProgress,
  withResolvedBundleNames,
  normalizeRouteProgress,
  segmentsFor,
  allowIncompleteFinish,
  unloadCounts,
  relinkRouteLabels,
  relinkRouteWaybills,
} = {}) {
  return async function handleRouteActionRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/drivers/routes/action" && method === "POST") {
      const body = await readBody(req);
      const routeId = String(body.routeId || "");
      const action = String(body.action || "");
      const route = (db.driverRoutes || []).find((r) => r.id === routeId);
      if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
      if (String(route.driverId) !== String(user.id) && !isAdmin(user, db)) {
        return sendJson(res, 403, { error: "forbidden" });
      }

      const now = Date.now();
      const t = (Number.isFinite(Number(body.clientTime)) && Number(body.clientTime) > 0)
        ? Number(body.clientTime) : now;
      if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
      if (!route.progress.lunchActive) route.progress.lunchActive = false;
      if (route.progress.lunchStart == null) route.progress.lunchStart = null;
      if (!Array.isArray(route.progress.lunchHistory)) route.progress.lunchHistory = [];
      route.clients = (Array.isArray(route.clients) ? route.clients : [])
        .filter((c) => !!c && typeof c === "object")
        .map((c, i) => {
          if (!c.id) c.id = `${route.id}-st${i + 1}`;
          c.state = c.state || "pending";
          c.transitStart = c.transitStart || null;
          c.transitEnd = c.transitEnd || null;
          c.siteStart = c.siteStart || null;
          c.siteEnd = c.siteEnd || null;
          c.transitPaused = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
          c.postponeReason = c.postponeReason || null;
          return c;
        });
      if (route.clients.length === 0) return sendJson(res, 400, { error: "В маршруте нет точек" });

      const indexOfState = (st) => route.clients.findIndex((c) => c.state === st);
      const activeIdx = indexOfState("in_transit") >= 0 ? indexOfState("in_transit")
        : indexOfState("on_site");
      const nextPendingIdx = indexOfState("pending");

      const bundleKeyOf = (c) => {
        if (c && c.bundleId) return "b:" + String(c.bundleId);
        const a = String(c && c.address || "").trim().toLowerCase();
        return a ? "a:" + a : "";
      };
      const groupMap = new Map();
      route.clients.forEach((c, i) => {
        const k = bundleKeyOf(c);
        if (!k) return;
        if (!groupMap.has(k)) groupMap.set(k, []);
        groupMap.get(k).push(i);
      });
      const groupOf = (idx) => {
        const k = bundleKeyOf(route.clients[idx]);
        return (k && groupMap.get(k)) || [idx];
      };
      const setGroupInTransit = (indices, t) => {
        indices.forEach((i) => {
          route.clients[i].state = "in_transit";
          route.clients[i].transitStart = t;
          route.clients[i].transitPaused = 0;
        });
      };
      const routeResp = () =>
        ({ ok: true, route: enrichUnloadProgress(withResolvedBundleNames(normalizeRouteProgress(route), db), db.labels) });

      const dayFinished = () => {
        const rec = db.days[route.date] || {};
        const segs = Array.isArray(segmentsFor(user.id, rec)) ? segmentsFor(user.id, rec) : [];
        return segs.some((s) => !!s && typeof s === "object" && s.kind === "work" && s.end != null);
      };

      if (action === "start") {
        if (route.progress.status === "done") {
          return sendJson(res, 409, { error: "Маршрут уже завершён" });
        }
        if (dayFinished()) {
          return sendJson(res, 409, { error: "Рабочий день завершён — новый маршрут взять нельзя" });
        }
        const allowIgnoreShipment = db.params && db.params.allowDriverStartWithoutShipment === true;
        if (!allowIgnoreShipment && !route.progress.shippedAt) {
          return sendJson(res, 409, { error: "Маршрут ещё не отгружен складом — запуск недоступен" });
        }
        route.progress.status = "active";
        const first = route.clients.find((c) => c.state === "pending");
        if (first) {
          const firstGroup = groupOf(route.clients.indexOf(first))
            .filter((i) => route.clients[i].state === "pending");
          setGroupInTransit(firstGroup, t);
        }
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      if (action === "arrive") {
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
        }
        if (route.progress.lunchActive === true) {
          return sendJson(res, 409, { error: "Сначала вернитесь с обеда" });
        }
        const cur = route.clients[activeIdx];
        if (!cur || cur.state !== "in_transit") {
          return sendJson(res, 409, { error: "Нет точки, в которую вы сейчас едете" });
        }
        groupOf(activeIdx)
          .filter((i) => route.clients[i].state === "in_transit")
          .forEach((i) => {
            route.clients[i].transitEnd = t;
            route.clients[i].state = "on_site";
            route.clients[i].siteStart = t;
          });
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      if (action === "deliver") {
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
        }
        const cur = route.clients[activeIdx];
        if (!cur || cur.state !== "on_site") {
          return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
        }
        if (cur.unloadFinished !== true) {
          const allowIncomplete = allowIncompleteFinish(db);
          if (!allowIncomplete) return sendJson(res, 409, { error: "Сначала завершите выгрузку" });
          cur.unloadFinished = true;
        }
        groupOf(activeIdx)
          .filter((i) => route.clients[i].state === "on_site")
          .forEach((i) => {
            route.clients[i].siteEnd = t;
            route.clients[i].state = "delivered";
          });
        const nextIdx = nextPendingIdx;
        if (nextIdx >= 0) {
          const nextGroup = groupOf(nextIdx)
            .filter((i) => route.clients[i].state === "pending");
          setGroupInTransit(nextGroup, t);
        }
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      // «Перенос» точки.
      if (action === "postpone") {
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
        }
        if (route.progress.lunchActive === true) {
          return sendJson(res, 409, { error: "Сначала вернитесь с обеда" });
        }
        const cur = route.clients[activeIdx];
        if (!cur || cur.state !== "on_site") {
          return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
        }
        const reason = String(body.postponeReason || body.reason || "").trim().slice(0, 200);
        if (!reason) {
          return sendJson(res, 400, { error: "Укажите причину переноса" });
        }
        groupOf(activeIdx)
          .filter((i) => route.clients[i].state === "on_site")
          .forEach((i) => {
            route.clients[i].siteEnd = t;
            route.clients[i].state = "postponed";
            route.clients[i].postponeReason = reason;
          });
        const nextIdx = nextPendingIdx;
        if (nextIdx >= 0) {
          const nextGroup = groupOf(nextIdx)
            .filter((i) => route.clients[i].state === "pending");
          setGroupInTransit(nextGroup, t);
        }
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      // «Завершить выгрузку».
      if (action === "finish_unload") {
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Сначала начните маршрут" });
        }
        const cur = route.clients[activeIdx];
        if (!cur || cur.state !== "on_site") {
          return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
        }
        const ci = activeIdx;
        const mine = (db.labels || []).filter(
          (l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === ci
        );
        const { total, done } = unloadCounts(mine);
        const allowIncomplete = allowIncompleteFinish(db);
        if (total > 0 && done < total && !allowIncomplete) {
          return sendJson(res, 409, { error: `Осталось отсканировать мест: ${total - done}` });
        }
        groupOf(activeIdx).forEach((i) => {
          route.clients[i].unloadFinished = true;
        });
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      if (action === "arrive_base") {
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Сначала начните маршрут" });
        }
        const closedStates = new Set(["delivered", "postponed"]);
        const pendingLeft = route.clients.some((c) => !closedStates.has(c.state));
        if (pendingLeft) {
          return sendJson(res, 409, { error: "Сначала завершите все точки маршрута" });
        }
        route.progress.status = "done";
        route.progress.baseArrivedAt = t;
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      // «Обед».
      if (action === "lunch") {
        const completedSome = route.clients.some((c) => c.state === "delivered" || c.state === "postponed");
        const allowed = route.progress.status === "active" && completedSome;
        if (!allowed) {
          return sendJson(res, 409, { error: "Обед доступен на активном маршруте после сдачи или переноса точки" });
        }
        if (!route.progress.lunchActive) {
          route.progress.lunchActive = true;
          route.progress.lunchStart = now;
        } else {
          route.progress.lunchHistory.push({ from: route.progress.lunchStart, to: now });
          const cur = route.clients[activeIdx];
          if (cur && cur.state === "in_transit" && Number.isFinite(route.progress.lunchStart)) {
            cur.transitPaused = Number.isFinite(cur.transitPaused) ? cur.transitPaused : 0;
            cur.transitPaused += Math.max(0, now - route.progress.lunchStart);
          }
          route.progress.lunchStart = null;
          route.progress.lunchActive = false;
        }
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      // «reorder» — водитель меняет порядок ещё не пройденных точек.
      if (action === "reorder") {
        const allowReorder = db.params && db.params.allowDriverReorderPoints === true;
        if (!allowReorder) {
          return sendJson(res, 403, { error: "Изменение порядка точек отключено администратором" });
        }
        if (route.progress.status !== "active") {
          return sendJson(res, 409, { error: "Менять порядок можно только в активном маршруте" });
        }
        const order = body.order;
        if (!Array.isArray(order) || order.length !== route.clients.length) {
          return sendJson(res, 400, { error: "Некорректный порядок точек" });
        }
        const byId = new Map(route.clients.map((c) => [String(c.id), c]));
        const seen = new Set();
        const newOrder = [];
        for (const rawId of order) {
          const id = String(rawId);
          if (seen.has(id) || !byId.has(id)) {
            return sendJson(res, 400, { error: "Некорректный порядок точек" });
          }
          seen.add(id);
          newOrder.push(byId.get(id));
        }
        const FROZEN = new Set(["on_site", "delivered", "postponed"]);
        const frozenCurrent = route.clients.filter((c) => FROZEN.has(c.state)).map((c) => String(c.id));
        const frozenNew = newOrder.filter((c) => FROZEN.has(c.state)).map((c) => String(c.id));
        if (JSON.stringify(frozenCurrent) !== JSON.stringify(frozenNew)) {
          return sendJson(res, 409, { error: "Нельзя менять уже пройденные точки или точку, где вы стоите" });
        }
        const prevClients = route.clients;
        route.clients = newOrder;
        relinkRouteLabels(route.id, newOrder, db.labels);
        // Накладные (сборка/«не найдено») привязаны к позиции — переносим их на
        // новые индексы своих клиентов, иначе содержимое сборки одного клиента
        // «переезжает» к другому после перестановки точек (Фроз -> Система).
        if (typeof relinkRouteWaybills === "function" && route.waybills) {
          route.waybills = relinkRouteWaybills(prevClients, newOrder, route.waybills);
        }
        await persistDb();
        return sendJson(res, 200, routeResp());
      }

      return sendJson(res, 400, { error: "Неизвестное действие" });
    }

    return false;
  };
};
