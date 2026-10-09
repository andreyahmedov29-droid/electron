// Модуль-обработчик сотрудников (/api/staff*, DELETE /api/staff/:id,
// /api/admin/staff/block). Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createStaffHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  crypto,
  setStaffPayMonth,
  normalizeMonthKey,
  purgeStaffFromGroups,
} = {}) {
  return async function handleStaffRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/staff" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return sendJson(res, 422, { error: "name required" });
      db.staff.push({ id: "s-" + crypto.randomBytes(5).toString("hex"), name, salary: null, bonus: null, extraBonus: null });
      await persistDb();
      return sendJson(res, 200, { ok: true, staff: db.staff });
    }

    // POST /api/staff/salary (set salary)
    if (urlPath === "/api/staff/salary" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const st = db.staff.find((s) => s.id === body.id);
      if (!st) return sendJson(res, 404, { error: "staff not found" });
      let v = parseInt(body.salary, 10);
      st.salary = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
      setStaffPayMonth(st, normalizeMonthKey(body.month), { salary: st.salary, bonus: st.bonus, extraBonus: st.extraBonus });
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/staff/bonus (set monthly bonus for a staff member)
    if (urlPath === "/api/staff/bonus" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const st = db.staff.find((s) => s.id === body.id);
      if (!st) return sendJson(res, 404, { error: "staff not found" });
      let v = parseInt(body.bonus, 10);
      st.bonus = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
      setStaffPayMonth(st, normalizeMonthKey(body.month), { salary: st.salary, bonus: st.bonus, extraBonus: st.extraBonus });
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/staff/extra-bonus (set additional monthly bonus)
    if (urlPath === "/api/staff/extra-bonus" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const st = db.staff.find((s) => s.id === body.id);
      if (!st) return sendJson(res, 404, { error: "staff not found" });
      let v = parseInt(body.extraBonus, 10);
      st.extraBonus = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
      setStaffPayMonth(st, normalizeMonthKey(body.month), { salary: st.salary, bonus: st.bonus, extraBonus: st.extraBonus });
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/staff/:id
    let m = urlPath.match(/^\/api\/staff\/(.+)$/) || null;
    if (m && method === "DELETE") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const id = m[1];
      if (id === user.id) return sendJson(res, 400, { error: "cannot remove self" });
      const rec = db.staff.find((s) => s.id === id);
      db.staff = db.staff.filter((s) => s.id !== id);
      db.admins = db.admins.filter((a) => a !== id);
      purgeStaffFromGroups(id, db);
      for (const k in db.days) {
        const day = db.days[k];
        // Remove the employee's segments from the shared per-day map.
        if (day.byEmployee && typeof day.byEmployee === "object" && day.byEmployee[id]) {
          delete day.byEmployee[id];
        }
        // Remove the removed employee's status from shared status maps; drop the
        // day if that leaves it without segments and without any statuses.
        if (day.statuses && day.statuses[id] !== undefined) {
          delete day.statuses[id];
          if (Object.keys(day.statuses).length === 0) delete day.statuses;
        }
        const hasSegs = day.byEmployee && Object.keys(day.byEmployee).some((e) => (day.byEmployee[e].segments || []).length);
        const hasStatuses = day.statuses && Object.keys(day.statuses).length > 0;
        if (!hasSegs && !hasStatuses) delete db.days[k];
      }
      db.log = db.log.filter((e) => e.ownerId !== id);
      // Close the employee's access to the app, so they don't reappear on next login.
      if (!db.blocked.some((b) => b.id === id)) {
        db.blocked.push({ id, name: rec ? rec.name : `Сотрудник ${id}`, at: Date.now() });
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, blocked: db.blocked });
    }

    // POST /api/admin/staff/block { id, on, name? }
    if (urlPath === "/api/admin/staff/block" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const id = String(body.id || "");
      if (!id) return sendJson(res, 422, { error: "id required" });
      if (id === user.id) return sendJson(res, 400, { error: "cannot block self" });
      const on = body.on === true;
      if (on) {
        const rec = db.staff.find((s) => s.id === id);
        db.staff = db.staff.filter((s) => s.id !== id);
        db.admins = db.admins.filter((a) => a !== id);
        purgeStaffFromGroups(id, db);
        if (!db.blocked.some((b) => b.id === id)) {
          db.blocked.push({ id, name: rec ? rec.name : String(body.name || `Сотрудник ${id}`), at: Date.now() });
        }
      } else {
        db.blocked = db.blocked.filter((b) => b.id !== id);
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, blocked: db.blocked });
    }

    return false;
  };
};
