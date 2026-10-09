// Модуль-обработчик справочника клиентов для маршрутов (/api/drivers/clients,
// /api/clients/:id/logo, /api/clients/:id/logo-text). Вынесен из server.js
// дословно; зависимости инъекцией (DI).
module.exports = function createDriverClientsHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  geocodeLackingClients,
  ensureClientCoords,
} = {}) {
  return async function handleDriverClientsRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/drivers/clients" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      // До-геокодирование клиентов без координат выполняется В ФОНЕ (без await):
      // ответ карте трекинга уходит мгновенно, а координаты подтягиваются постепенно.
      // Если бы геокод шёл синхронно (до 5 запросов по ~15с), карта, вызывающая
      // этот эндпоинт каждые 30 сек, надолго зависала бы в ожидании.
      geocodeLackingClients(db, persistDb);
      return sendJson(res, 200, { ok: true, clients: db.driverClients || [] });
    }

    if (urlPath === "/api/drivers/clients" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      db.driverClients = db.driverClients || [];
      // Создание связки: несколько клиентов на один адрес. Выбранные клиенты
      // получают общий bundleId; общий адрес связки хранится в отдельном поле
      // bundleAddress и НЕ перезаписывает собственный адрес контрагента
      // (адрес меняется только через редактирование). Связок может быть много.
      if (body.action === "bundle") {
        const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
        const bundleAddress = String(body.address || "").slice(0, 500).trim();
        const bundleName = String(body.name || "").slice(0, 200).trim();
        if (ids.length < 2) return sendJson(res, 422, { error: "Выберите хотя бы двух клиентов для связки" });
        if (!bundleAddress) return sendJson(res, 422, { error: "Укажите общий адрес связки" });
        const have = ids.filter((id) => db.driverClients.some((c) => c.id === id));
        if (have.length === 0) return sendJson(res, 404, { error: "Клиенты не найдены" });
        const bundleId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const bundleMembers = db.driverClients.filter((c) => have.includes(c.id));
        const commonLogoText = (bundleMembers.find((c) => c && c.logoText) || {}).logoText || "";
        const commonLogo = (bundleMembers.find((c) => c && c.logo) || {}).logo || null;
        for (const c of db.driverClients) {
          if (have.includes(c.id)) {
            c.bundleId = bundleId;
            c.bundleAddress = bundleAddress;
            if (bundleName) c.bundleName = bundleName;
            if (commonLogoText) c.logoText = String(commonLogoText).toUpperCase().slice(0, 5);
            if (commonLogo) c.logo = commonLogo;
          }
        }
        await persistDb();
        return sendJson(res, 200, { ok: true, clients: db.driverClients, bundleId });
      }
      // Разбиение связки: убрать у клиента признак связки (bundleId и общий адрес).
      if (body.action === "unbundle") {
        const id = String(body.id || "");
        const found = db.driverClients.find((c) => c.id === id);
        if (found) {
          delete found.bundleId;
          delete found.bundleAddress;
          await persistDb();
        }
        return sendJson(res, 200, { ok: true, clients: db.driverClients });
      }
      // Единое название связки: задать/изменить bundleName у ВСЕХ участников
      // указанной связки (bundleId). Пустое имя убирает название.
      if (body.action === "bundle-name") {
        const bundleId = String(body.bundleId || "");
        const name = String(body.name || "").slice(0, 200).trim();
        if (!bundleId) return sendJson(res, 400, { error: "Связка не указана" });
        const members = db.driverClients.filter((c) => c.bundleId === bundleId);
        if (members.length === 0) return sendJson(res, 404, { error: "Связка не найдена" });
        for (const c of members) {
          if (name) c.bundleName = name;
          else delete c.bundleName;
        }
        await persistDb();
        return sendJson(res, 200, { ok: true, clients: db.driverClients });
      }
      // Удаление клиента. Проверка имени/адреса здесь не нужна — ветка идёт
      // раньше общей валидации нового клиента.
      if (body.action === "delete") {
        const id = String(body.id || "");
        db.driverClients = db.driverClients.filter((c) => c.id !== id);
        await persistDb();
        return sendJson(res, 200, { ok: true, clients: db.driverClients });
      }
      const client = String(body.client || "").slice(0, 200).trim();
      const address = String(body.address || "").slice(0, 500).trim();
      if (!client || !address) return sendJson(res, 400, { error: "Нужно указать клиента и адрес" });
      // Редактирование существующего клиента (исправить имя/адрес).
      if (body.action === "update") {
        const id = String(body.id || "");
        const found = db.driverClients.find((c) => c.id === id);
        if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
        const prevClient = found.client;
        const prevAddress = found.address;
        found.client = client;
        found.address = address;
        found.inn = String(body.inn != null ? body.inn : found.inn || "").trim();
        // Буквенный логин контрагента в 1С (нужен для сопоставления реализации).
        found.login = String(body.login != null ? body.login : found.login || "").trim();
        // Адрес изменился — старые координаты недействительны, переглокализуем.
        found.lat = null;
        found.lon = null;
        await ensureClientCoords(found);
        if (prevClient !== client || prevAddress !== address) {
          (db.driverRoutes || []).forEach((r) => {
            (r.clients || []).forEach((p) => {
              if (p && typeof p === "object" && String(p.client) === String(prevClient)) {
                p.client = client;
                p.address = address;
              }
            });
          });
        }
        await persistDb();
        return sendJson(res, 200, { ok: true, clients: db.driverClients });
      }
      const newClient = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        client,
        address,
        inn: String(body.inn || "").trim(),
        login: String(body.login || "").trim(),
        bundleId: null,
        addedBy: user.id,
        at: Date.now(),
      };
      await ensureClientCoords(newClient);
      db.driverClients.push(newClient);
      if (db.driverClients.length > 2000) db.driverClients = db.driverClients.slice(-2000);
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }

    // --- Логотип клиента (для этикетки отгрузки): POST /api/clients/:id/logo ---
    if (urlPath.startsWith("/api/clients/") && urlPath.endsWith("/logo") && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const id = decodeURIComponent(urlPath.slice("/api/clients/".length, -"/logo".length));
      const found = (db.driverClients || []).find((c) => String(c.id) === String(id));
      if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
      const body = await readBody(req);
      let logo = String(body.logo || "").trim();
      if (logo) {
        if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
          return sendJson(res, 422, { error: "Некорректный формат изображения" });
        }
        if (logo.length > 500000) return sendJson(res, 422, { error: "Слишком большое изображение" });
      }
      found.logo = logo || null;
      (db.driverRoutes || []).forEach((r) => {
        (r.clients || []).forEach((p) => {
          if (p && typeof p === "object" && String(p.client) === String(found.client)) {
            p.logo = logo || null;
          }
        });
      });
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }

    // --- Аббревиатура логотипа клиента: POST /api/clients/:id/logo-text ---
    if (urlPath.startsWith("/api/clients/") && urlPath.endsWith("/logo-text") && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const id = decodeURIComponent(urlPath.slice("/api/clients/".length, -"/logo-text".length));
      const found = (db.driverClients || []).find((c) => String(c.id) === String(id));
      if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
      const body = await readBody(req);
      const logoText = String(body.logoText || "").trim().toUpperCase().slice(0, 5);
      found.logoText = logoText;
      (db.driverRoutes || []).forEach((r) => {
        (r.clients || []).forEach((p) => {
          if (p && typeof p === "object" && String(p.client) === String(found.client)) {
            p.logoText = logoText;
          }
        });
      });
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }

    return false;
  };
};
