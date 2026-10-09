// Модуль-обработчик гео-маршрутизации по дорогам через FreeRoute (openrouteservice-совместимо).
// POST /api/geo/route-from-track  { points: [{lat, lon}, ...] }
//   → строит маршрут ПО ДОРОГАМ (линия как в навигаторе) и возвращает координаты линии.
// Ключ/база берутся из окружения (FREEROUTE_API_KEY / FREEROUTE_API_BASE) — не из кода.
module.exports = function createGeoRoutes({
  getDb,
  sendJson,
  readBody,
} = {}) {
  const BASE = String(process.env.FREEROUTE_API_BASE || "https://api.maps.freeroute.org/v1").replace(/\/+$/, "");
  const KEY = String(process.env.FREEROUTE_API_KEY || "").trim();
  return async function handleGeoRoutes(req, res, urlPath, method) {
    if (urlPath === "/api/geo/route-from-track" && method === "POST") {
      const body = await readBody(req);
      const points = Array.isArray(body && body.points) ? body.points : [];
      const coords = points
        .map((p) => ({ lat: Number(p && p.lat), lon: Number(p && p.lon) }))
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (!KEY) return sendJson(res, 200, { ok: false, error: "FREEROUTE_API_KEY не настроен" });
      if (coords.length < 2) return sendJson(res, 200, { ok: false, error: "нужно минимум 2 точки" });
      let line = null;
      try {
        const payload = { coordinates: coords.map((p) => [p.lon, p.lat]) };
        const r = await fetch(
          `${BASE}/directions/driving-car?api_key=${encodeURIComponent(KEY)}&format=geojson`,
          { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/geo+json" }, body: JSON.stringify(payload) }
        );
        if (r.ok) {
          const j = await r.json().catch(() => null);
          const geo = j && j.routes && j.routes[0] && j.routes[0].geometry;
          if (geo && Array.isArray(geo.coordinates)) {
            line = geo.coordinates.map((c) => ({ lon: Number(c[0]), lat: Number(c[1]) }));
          }
        } else {
          err = "FreeRoute ответил HTTP " + r.status;
        }
      } catch (e) {
        err = (e && e.message) || "сбой вызова FreeRoute";
      }
      return sendJson(res, 200, { ok: !!line, line, error: line ? null : (err || "маршрут не получен") });
    }
    return false;
  };
};
