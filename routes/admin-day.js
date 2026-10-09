// Модуль-обработчик админских правок дня (/api/admin/day PUT, /api/admins,
// /api/admin/status). Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createAdminDayHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  canManageStatus,
} = {}) {
  return async function handleAdminDayRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/admin/day" && method === "PUT") {
      const body = await readBody(req);
      const key = typeof body.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.key) ? body.key : null;
      if (!key) return sendJson(res, 422, { error: "bad day key" });
      const ownerId = String(body.ownerId || "");
      if (!ownerId || !db.staff.some((s) => s.id === ownerId)) {
        return sendJson(res, 422, { error: "unknown staff" });
      }
      if (!canManageStatus(user, db, ownerId)) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      const segments = Array.isArray(body.segments)
        ? body.segments.map((s) => ({
            start: Number.isFinite(s.start) ? s.start : 0,
            end: s.end == null ? null : (Number.isFinite(s.end) ? s.end : null),
            kind: s.kind === "break" ? "break" : "work",
            id: String(s.id || "s"),
          }))
        : [];
      const prev = db.days[key];
      const day = prev && typeof prev === "object" ? prev : {};
      if (!(day.byEmployee && typeof day.byEmployee === "object")) day.byEmployee = {};
      // Save ONLY this employee's segments so the others' data for the same day
      // (also edited from the "Время работы" tab) are never overwritten.
      // Админская правка «Время работы» тоже помечает день закрытым, если в
      // сохранённых сегментах нет открытых (у всех задан «конец»). Так исправление
      // времени не снимает защиту от гонки: фоновая вкладка сотрудника с открытым
      // таймером не сможет потом оживить закрытый день. Если админ намеренно
      // оставил «конец» пустым (открытый сегмент) — день считается открытым.
      day.byEmployee[ownerId] = {
        segments,
        finished: !segments.some((s) => s && typeof s === "object" && s.end == null),
        // Ручная правка админа приоритетнее живого таймера: пока запись помечена,
        // фоновые сохранения сотрудника (POST /api/day без явного finish) НЕ
        // перезаписывают вручную заданное время (иначе «поставил 07:00, а через
        // время стало 08:00» из-за реального таймера сотрудника). Снимается, когда
        // сотрудник явно завершит день или админ отредактирует заново.
        adminLock: true,
      };
      if (prev && prev.statuses && typeof prev.statuses === "object") day.statuses = prev.statuses;
      db.days[key] = day;
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/admins  { id, on }
    if (urlPath === "/api/admins" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const on = body.on === true;
      if (on) { if (!db.admins.includes(body.id)) db.admins.push(body.id); }
      else { db.admins = db.admins.filter((a) => a !== body.id); }
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/admin/status  { key, ownerId, status } (admin assigns a
    // timesheet status Я / Б / ОТ / ДО / НН, or clears it with "")
    if (urlPath === "/api/admin/status" && method === "POST") {
      const body = await readBody(req);
      const key = typeof body.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.key) ? body.key : null;
      if (!key) return sendJson(res, 422, { error: "bad day key" });
      const ownerId = String(body.ownerId || "");
      if (!ownerId || !db.staff.some((s) => s.id === ownerId)) {
        return sendJson(res, 422, { error: "unknown staff" });
      }
      if (!canManageStatus(user, db, ownerId)) return sendJson(res, 403, { error: "forbidden" });
      const status = String(body.status || "");
      const allowed = ["", "Я", "Б", "ОТ", "ДО", "НН"];
      if (!allowed.includes(status)) return sendJson(res, 422, { error: "bad status" });
      const rec = db.days[key];
      if (!rec) {
        if (status) db.days[key] = { statuses: { [ownerId]: status } };
      } else {
        if (status) {
          if (!rec.statuses) rec.statuses = {};
          rec.statuses[ownerId] = status;
        } else if (rec.statuses) {
          delete rec.statuses[ownerId];
          if (Object.keys(rec.statuses).length === 0) delete rec.statuses;
        }
        const hasSegs = rec.byEmployee && Object.keys(rec.byEmployee).some((e) => (rec.byEmployee[e].segments || []).length);
        const hasStatuses = rec.statuses && Object.keys(rec.statuses).length > 0;
        if (!hasSegs && !hasStatuses) delete db.days[key];
      }
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    return false;
  };
};
