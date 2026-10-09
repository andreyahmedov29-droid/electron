// Модуль-обработчик журнала сканов деталей (/api/logs/barcode POST/GET/clear).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createLogsHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  appendBarcodeLog,
  readBarcodeLogs,
  fs,
  path,
  BCODE_ARCHIVE_DIR,
} = {}) {
  return async function handleLogsRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/logs/barcode" && method === "POST") {
      if (!user) return sendJson(res, 401, { error: "unauthorized" });
      const body = await readBody(req);
      if (!Array.isArray(db.barcodeLog)) db.barcodeLog = [];
      const entry = {
        ts: Date.now(),
        userId: user.id != null ? String(user.id) : null,
        userName: String(user.name || ""),
        ok: body.ok === true,
        code: String(body.code || "").slice(0, 80),
        partsticker: String(body.partsticker || "").slice(0, 60),
        art: String(body.art || "").slice(0, 80),
        kind: String(body.kind || "detail").slice(0, 20),
        client: String(body.client || "").slice(0, 200),
        box: String(body.box || "").slice(0, 60),
        routeId: String(body.routeId || "").slice(0, 80),
        clientIndex: (body.clientIndex != null) ? Number(body.clientIndex) : null,
        reason: String(body.reason || "").slice(0, 200),
      };
      db.barcodeLog.push(entry);
      appendBarcodeLog(entry);
      const LIM = Number(db.params && db.params.scanLogLimit) || 30000;
      if (db.barcodeLog.length > LIM) db.barcodeLog = db.barcodeLog.slice(-LIM);
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    if (urlPath === "/api/logs/barcode" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const u = new URL(req.url, "http://localhost");
      const from = String(u.searchParams.get("from") || "").trim();
      const to = String(u.searchParams.get("to") || "").trim();
      const okOnly = String(u.searchParams.get("ok") || "");
      let rows = readBarcodeLogs();
      if (from) {
        const fd = Date.parse(from);
        if (!Number.isNaN(fd)) rows = rows.filter((r) => r.ts >= fd);
      }
      if (to) {
        const td = Date.parse(to);
        if (!Number.isNaN(td)) rows = rows.filter((r) => r.ts <= td);
      }
      if (okOnly === "false") rows = rows.filter((r) => r.ok !== true);
      if (okOnly === "true") rows = rows.filter((r) => r.ok === true);
      if (rows.length > 600) rows = rows.slice(0, 600);
      return sendJson(res, 200, { ok: true, rows });
    }

    if (urlPath === "/api/logs/barcode/clear" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      try {
        if (fs.existsSync(BCODE_ARCHIVE_DIR)) {
          for (const fn of (fs.readdirSync(BCODE_ARCHIVE_DIR) || [])) {
            try { fs.unlinkSync(path.join(BCODE_ARCHIVE_DIR, fn)); } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      db.barcodeLog = [];
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }
    return false;
  };
};
