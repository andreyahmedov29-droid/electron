// Модуль-обработчик системных маршрутов (/api/log, /api/heartbeat,
// /api/live, /api/log/clear). Вынесен из server.js дословно; завис. инъекцией (DI).
module.exports = function createSystemHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  isModerator,
  liveRows,
} = {}) {
  return async function handleSystemRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // POST /api/log (append an action)
    if (urlPath === "/api/log" && method === "POST") {
      const body = await readBody(req);
      const action = String(body.action || "").slice(0, 200);
      const kind = ["timer", "status", "manual"].includes(body.kind) ? body.kind : "timer";
      db.log.push({ ts: Date.now(), action, kind, ownerId: user.id });
      if (db.log.length > 2000) db.log = db.log.slice(-2000);
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/heartbeat (online presence)
    if (urlPath === "/api/heartbeat" && method === "POST") {
      if (!db.lastSeen) db.lastSeen = {};
      db.lastSeen[user.id] = Date.now();
      return sendJson(res, 200, { ok: true });
    }

    // GET /api/live (admin/moderator)
    if (urlPath === "/api/live" && method === "GET") {
      if (!admin && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const rows = liveRows(user, db);
      return sendJson(res, 200, { rows, at: Date.now() });
    }

    // POST /api/log/clear
    if (urlPath === "/api/log/clear" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      db.log = [];
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    return false;
  };
};
