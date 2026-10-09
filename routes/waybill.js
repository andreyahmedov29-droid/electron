// Модуль-обработчик расходных накладных (/api/routes/:id/waybill*,
// /api/waybill/parse). Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createWaybillHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  parseXlsxItems,
  logWaybillScan,
  artNorm,
  listWaybillBoxes,
  isAdmin,
  isModerator,
} = {}) {
  // Сокращённая форма партстикера: убираем ведущие нули числовой части
  // (000000000020217/4 → 20217/4). Используется и для сравнения при скане,
  // чтобы полный и сокращённый код совпадали.
  const shortPs = (s) => {
    const p = String(s == null ? "" : s);
    const i = p.indexOf("/");
    const head = (i > 0 ? p.slice(0, i) : p).replace(/^0+/, "");
    return (i > 0 ? head + p.slice(i) : head);
  };
  const psEq = (a, b) => shortPs(a) === shortPs(b);
  return async function handleWaybillRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    let wm = urlPath.match(/^\/api\/routes\/([^/]+)\/waybill(\/(scan|missing|bind|finish|qtyrequest|qtyresolve|delete-unscanned))?$/) || null;
    // Разбор xlsx для формы создания маршрута (диспетчер): возвращает позиции без
    // сохранения — их отдаст сам POST создания маршрута.
    if (urlPath === "/api/waybill/parse" && method === "POST") {
      if (!admin) return sendJson(res, 403, { ok: false, error: "forbidden" });
      const body = await readBody(req);
      const b64 = String(body.fileB64 || "");
      if (!b64) return sendJson(res, 422, { ok: false, error: "Файл не передан" });
      let buf;
      try { buf = Buffer.from(b64, "base64"); } catch { return sendJson(res, 400, { ok: false, error: "Неверные данные файла" }); }
      if (!buf || buf.length < 100) return sendJson(res, 400, { ok: false, error: "Файл пуст или повреждён" });
      const parsed = parseXlsxItems(buf);
      if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
      return sendJson(res, 200, { ok: true, items: parsed.items, buyer: parsed.buyer || "" });
    }
    // Боксы клиента накладной.
    if (method === "GET" && urlPath.match(/^\/api\/routes\/([^/]+)\/waybill\/boxes$/)) {
      const q = req.url.split("?")[1] || "";
      const qr = new URLSearchParams(q);
      const routeId = urlPath.match(/^\/api\/routes\/([^/]+)\/waybill\/boxes$/)[1];
      const clientIndex = Number(qr.get("clientIndex"));
      const route = (db.driverRoutes || []).find((rr) => String(rr.id) === String(routeId));
      return sendJson(res, 200, { ok: true, boxes: listWaybillBoxes(route, clientIndex) });
    }
    // Удаление бокса: нельзя, если в нём есть привязанные детали.
    if (method === "POST" && urlPath.match(/^\/api\/routes\/([^/]+)\/waybill\/box\/delete$/)) {
      const routeId = urlPath.match(/^\/api\/routes\/([^/]+)\/waybill\/box\/delete$/)[1];
      const body = await readBody(req);
      const clientIndex = Number(body.clientIndex);
      const box = String(body.box || "").trim();
      const route = (db.driverRoutes || []).find((rr) => String(rr.id) === String(routeId));
      const wb = route && route.waybills && route.waybills[clientIndex];
      const items = wb && Array.isArray(wb.items) ? wb.items : [];
      const inBox = items.filter((it) => String(it.box) === box && (Number(it.scanned) || 0) > 0);
      if (inBox.length > 0) {
        return sendJson(res, 409, {
          ok: false,
          error: `В боксе ${box} — деталей: ${inBox.length}. Переразместите их в другой бокс перед удалением`,
        });
      }
      db.labels = (db.labels || []).filter((l) =>
        (String(l.code) !== box) && !(String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex && String(l.code) === box)
      );
      items.forEach((it) => { if (String(it.box) === box) it.box = ""; });
      await persistDb();
      return sendJson(res, 200, { ok: true, boxes: listWaybillBoxes(route, clientIndex) });
    }
    if (wm && method === "POST") {
      const routeId = wm[1];
      const action = wm[2] ? wm[2].slice(1) : (wm[0].endsWith("/waybill") ? "upload" : "");
      if (db.params) db.params.allowWaybill = true;
      const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
      if (!route) return sendJson(res, 404, { ok: false, error: "Маршрут не найден" });
      const body = await readBody(req);
      const clientIndex = Number(body.clientIndex);
      if (!Number.isInteger(clientIndex) || clientIndex < 0) {
        return sendJson(res, 422, { ok: false, error: "bad clientIndex" });
      }
      if (!route.waybills) route.waybills = {};
      route.waybills[clientIndex] = route.waybills[clientIndex] || { items: [] };
      const wb = route.waybills[clientIndex];
      if (action === "delete-unscanned") {
        // «Удалить не собранные»: вычищаем из накладной строки, по которым собрано
        // 0 шт (дубли-хвосты, «не найдено» и т.п.), чтобы сборка была актуальной.
        // Только администратор.
        if (!admin && !(isAdmin && isAdmin(db, user))) return sendJson(res, 403, { ok: false, error: "forbidden" });
        const arr = Array.isArray(wb.items) ? wb.items : [];
        const removedItems = arr.filter((it) => (Number(it && it.scanned) || 0) === 0);
        const before = arr.length;
        wb.items = arr.filter((it) => (Number(it && it.scanned) || 0) > 0);
        const removed = before - wb.items.length;
        // Чистим историю «не найдено» (scanLog) для удалённых артикулов, иначе записи
        // остались бы в «Проблемах склада» после удаления строки из накладной.
        if (removedItems.length && Array.isArray(db.scanLog)) {
          const removedArts = removedItems.map((it) => String((it && it.art) || "").trim()).filter(Boolean);
          if (removedArts.length) {
            db.scanLog = db.scanLog.filter((e) => !(e && e.action === "waybill" && e.missing
              && removedArts.some((a) => a && artNorm(a) === artNorm(String(e.code || "")))));
          }
        }
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, { ok: true, removed, total: wb.items.length });
      }
      if (action === "scan") {
        const art = String(body.art || "").trim();
        if (!art) return sendJson(res, 422, { ok: false, error: "Пустой артикул" });
        // Активный бокс из запроса. Если он пуст, НО у уже найденной строки
        // (и в filled ветке) деталь ранее была привязана к боксу — привязку
        // сохраняем: случайный пустой `box` (слетевший активный бокс на ТСД /
        // компьютерном сканере) не должен «отвязывать» собранную деталь.
      const sentBox = String(body.box || "").trim();
        const artN = artNorm(art);
        // Строка ищется по артикулу ИЛИ по партстикеру (id_partstiker).
        let item = wb.items.find((it) =>
          artNorm(it.art) === artN && (Number(it.scanned) || 0) < (Number(it.qty) || 0)
        );
        const partMatch = !!item ? psEq(item.partsticker, art) : false;
        if (!item && artN) {
          item = wb.items.find((it) =>
            it.partsticker && psEq(it.partsticker, art)
              && (Number(it.scanned) || 0) < (Number(it.qty) || 0)
          );
        }
        if (!item) {
          const existing = wb.items.find((it) => artNorm(it.art) === artNorm(art));
          if (existing) {
            const box = sentBox || existing.box || "";
            if (box) {
              existing.box = box;
              // Размещение в бокс = деталь найдена: снимаем «не найдено», иначе
              // деталь висит и в боксе, и в пометке/отчёте «Проблемы склада».
              existing.missing = false;
              existing.missingQty = 0;
            }
            logWaybillScan(route, clientIndex, existing, true, Object.assign({}, body, { box }), user);
            route.at = Date.now();
            await persistDb();
            return sendJson(res, 200, {
              ok: true,
              rebound: true,
              item: { art: existing.art, name: existing.name, qty: existing.qty, scanned: existing.scanned, missing: !!existing.missing, box: existing.box },
              left: 0,
            });
          }
          return sendJson(res, 404, { ok: false, error: "Артикул не найден в накладной" });
        }
        const left = item.qty - item.scanned;
        if (left <= 0) return sendJson(res, 409, { ok: false, error: "Этот артикул уже собран полностью" });
        // Скан партстикера: если количество не передано явно — берём «зашитое»
        // в партстикер (partQty) и засчитываем сразу.
        const viaPart = !!item && !!item.partsticker && psEq(item.partsticker, art);
        let qty = Math.max(1, Number(body.qty) || (viaPart ? (Number(item.partQty) || 1) : 1));
        if (qty > left) qty = left;
        item.scanned += qty;
        const box = sentBox || item.box || "";
        if (box) item.box = box;
        item.missing = false;
        item.missingQty = 0;
        logWaybillScan(route, clientIndex, item, false, body, user);
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, {
          ok: true,
          item: { art: item.art, name: item.name, qty: item.qty, scanned: item.scanned, missing: !!item.missing, box: item.box },
          missing: !!item.missing,
          left: Math.max(0, item.qty - item.scanned),
        });
      }
      // Опциональная привязка уже засчитанной детали к боксу.
      if (action === "bind") {
        const art = String(body.art || "").trim();
        const box = String(body.box || "").trim();
        if (!art || !box) return sendJson(res, 422, { ok: false, error: "Нужны артикул и бокс" });
        const item = wb.items.find((it) => artNorm(it.art) === artNorm(art));
        if (!item) return sendJson(res, 404, { ok: false, error: "Артикул не найден в накладной" });
        item.box = box;
        // Размещение в бокс = деталь найдена: снимаем «не найдено».
        item.missing = false;
        item.missingQty = 0;
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, {
          ok: true,
          item: { art: item.art, name: item.name, qty: item.qty, scanned: item.scanned, missing: !!item.missing, box: item.box },
        });
      }
      if (action === "missing") {
        const art = String(body.art || "").trim();
        if (!art) return sendJson(res, 422, { ok: false, error: "Пустой артикул" });
        const idx = Number(body.index);
        const item = (Number.isInteger(idx) && idx >= 0 && idx < wb.items.length && artNorm(wb.items[idx].art) === artNorm(art))
          ? wb.items[idx]
          : wb.items.find((it) => artNorm(it.art) === artNorm(art));
        if (!item) return sendJson(res, 404, { ok: false, error: "Артикул не найден в накладной" });
        const on = body.on === true;
        const scanned = Number(item.scanned) || 0;
        const qty = Number(item.qty) || 0;
        const remaining = Math.max(0, qty - scanned);
        if (on) {
          if (remaining <= 0) return sendJson(res, 400, { ok: false, error: "Позиция уже собрана полностью — пометить нечего" });
          let m = Math.max(1, Number(body.qty) || remaining);
          item.missingQty = Math.min(m, Math.max(1, remaining));
          item.missing = item.missingQty > 0;
          if (scanned + item.missingQty > qty) item.scanned = Math.max(0, qty - item.missingQty);
        } else {
          item.missing = false;
          item.missingQty = 0;
        }
        if (on) logWaybillScan(route, clientIndex, item, true, body, user);
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, {
          ok: true,
          item: { art: item.art, name: item.name, qty: item.qty, scanned: item.scanned, missing: !!item.missing, missingQty: Number(item.missingQty) || 0 },
        });
      }
      // Убрать «не найдено» у детали из НАКЛАДНОЙ этого клиента (админ/модератор).
      if (action === "remove-missing") {
        if (!isAdmin(user, db) && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
        const art = String(body.art || "").trim();
        if (!art) return sendJson(res, 422, { error: "Пустой артикул" });
        const it = wb.items.find((x) => artNorm(x.art) === artNorm(art));
        if (it) { it.missing = false; it.missingQty = 0; }
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, { ok: true });
      }
      // Завершение сборки.
      if (action === "finish") {
        wb.finished = true;
        wb.finishedAt = Date.now();
        const usedBoxes = new Set(
          (Array.isArray(wb.items) ? wb.items : [])
            .filter((it) => (Number(it.scanned) || 0) > 0)
            .map((it) => String(it.box || ""))
            .filter(Boolean)
        );
        if (Array.isArray(db.labels)) {
          db.labels = db.labels.filter((l) =>
            !(String(l.routeId) === String(routeId) &&
              Number(l.clientIndex) === clientIndex &&
              !usedBoxes.has(String(l.code || "")))
          );
        }
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, { ok: true });
      }
      if (action === "qtyrequest") {
        const art = String(body.art || "").trim();
        const items = (Array.isArray(wb.items) ? wb.items : []);
        const it = items.find((x) =>
          ((x.partsticker && psEq(x.partsticker, art)) || artNorm(x.art) === artNorm(art))
          && (Number(x.scanned) || 0) < (Number(x.qty) || 0) && !x.missing
        );
        if (!it) return sendJson(res, 404, { ok: false, error: "Не найдено строки с остатком" });
        const remaining = Math.max(1, (Number(it.qty) || 0) - (Number(it.scanned) || 0));
        // Сохраняем активный бокс инициатора в pending — тогда подтвердить количество
        // может любое устройство, и деталь стабильно привяжется к ТОМУ ЖЕ боксу.
        const pendingBox = String(body.box || "") || (it && String(it.box || ""));
        wb.pending = { art: String(it.art), remaining, by: String((user && (user.name || user.NAME)) || ""), at: Date.now(), box: pendingBox };
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, { ok: true, pending: wb.pending });
      }
      if (action === "qtyresolve") {
        const art = String(body.art || "").trim();
        const cancel = body.cancel === true;
        const items = Array.isArray(wb.items) ? wb.items : [];
        const it = items.find((x) =>
          ((x.partsticker && psEq(x.partsticker, art)) || artNorm(x.art) === artNorm(art))
          && (Number(x.scanned) || 0) < (Number(x.qty) || 0)
        );
        if (!cancel && it) {
          let qty = Math.max(1, Number(body.qty) || 1);
          const rem = Math.max(0, (Number(it.qty) || 0) - (Number(it.scanned) || 0));
          if (qty > rem) qty = rem;
          // Бокс обязателен: берём из запроса, затем из pending (qtyrequest инициатора),
          // затем из уже привязанной детали. Без бокса НЕ засчитываем — иначе деталь
          // «через раз» принимается без привязки (живой баг).
          const box = String(body.box || "") || (wb.pending && String(wb.pending.box || "")) || String(it.box || "");
          if (!box) {
            return sendJson(res, 400, { ok: false, error: "Не выбран бокс — отсканируйте бокс сначала" });
          }
          it.scanned += qty;
          it.missing = false; it.missingQty = 0;
          it.box = box;
          logWaybillScan(route, clientIndex, it, true, body, user);
        }
        if (wb.pending && artNorm(wb.pending.art) === artNorm(art)) wb.pending = null;
        route.at = Date.now();
        await persistDb();
        return sendJson(res, 200, {
          ok: true,
          item: it ? { art: it.art, name: it.name, qty: it.qty, scanned: it.scanned, missing: !!it.missing, missingQty: Number(it.missingQty) || 0, box: it.box } : undefined,
        });
      }
      // Загрузка накладной.
      const b64 = String(body.fileB64 || "");
      if (!b64) return sendJson(res, 422, { ok: false, error: "Файл не передан" });
      let buf;
      try { buf = Buffer.from(b64, "base64"); } catch { return sendJson(res, 400, { ok: false, error: "Неверные данные файла" }); }
      if (!buf || buf.length < 100) return sendJson(res, 400, { ok: false, error: "Файл пуст или повреждён" });
      const parsed = parseXlsxItems(buf);
      if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
      if (!parsed.items.length) return sendJson(res, 400, { ok: false, error: "В накладной нет позиций" });
      // Поддержка двух форматов: из 1С позиция несёт партину
      // (partsticker/partQty/shipmentQty), из .xlsx — только art/name/qty.
      // Приводим к единой структуре, чтобы сборка/скан вели себя одинаково.
      const newItems = parsed.items.map((x) => Object.assign({}, x, {
        missing: false,
        partsticker: x.partsticker != null ? String(x.partsticker).trim() : "",
        partQty: Number(x.partQty) > 0 ? Number(x.partQty) : (Number(x.qty) > 0 ? Number(x.qty) : 1),
        shipmentQty: Number(x.shipmentQty) > 0 ? Number(x.shipmentQty) : (Number(x.qty) > 0 ? Number(x.qty) : 0),
      }));
      if (!Array.isArray(wb.items)) wb.items = [];
      wb.items = wb.items.concat(newItems);
      wb.buyer = parsed.buyer || wb.buyer || "";
      wb.loadedAt = Date.now();
      route.at = Date.now();
      await persistDb();
      return sendJson(res, 200, { ok: true, items: wb.items, appended: newItems.length, total: wb.items.length });
    }

    return false;
  };
};
