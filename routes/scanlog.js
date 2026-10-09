// Модуль-обработчик журнала сканирования мест (/api/scanlog GET). Вынесен из
// server.js дословно; зависимости инъекцией (DI).
module.exports = function createScanlogHandler({
  getDb,
  sendJson,
} = {}) {
  return async function handleScanlogRoutes(req, res, urlPath, method) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/scanlog" && method === "GET") {
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const action = String(params.get("action") || "");
      let limit = Number(params.get("limit") || 300);
      if (!Number.isInteger(limit) || limit < 1) limit = 300;
      if (limit > 2000) limit = 2000;
      let list = (db.scanLog || []).slice().reverse();
      if (action === "load" || action === "unload") {
        list = list.filter((e) => e.action === action);
      }
      list = list.slice(0, limit);
      list = list.map((e) => {
        const out = Object.assign({}, e);
        const parts = String(e.code || "").split("-");
        const placeNum = parts.length >= 3 ? Number(parts[parts.length - 1]) : NaN;
        const clientNum = parts.length >= 3 ? Number(parts[parts.length - 2]) : NaN;
        let total = 0;
        if (e.routeId != null && Number.isInteger(clientNum) && clientNum > 0) {
          total = (db.labels || []).filter(
            (l) => String(l.routeId) === String(e.routeId) && Number(l.clientIndex) === clientNum - 1
          ).length;
        }
        out.place = Number.isInteger(placeNum) && placeNum > 0 ? placeNum : null;
        out.totalPlaces = total > 0 ? total : null;
        return out;
      });
      return sendJson(res, 200, { ok: true, entries: list });
    }
    return false;
  };
};
