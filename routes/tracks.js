// Модуль-обработчик GPS-следов (/api/drivers/tracks и /tracks/snapped).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createTracksHandler({
  getDb,
  sendJson,
  isDriver,
  motionDayKey,
  tracksByDay,
  snappedTracks,
  snapTrackToRoads,
  scheduleSnappedSave,
} = {}) {
  return async function handleTracksRoutes(req, res, urlPath, method, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/drivers/tracks" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const date = params.get("date") || motionDayKey(Date.now());
      const day = tracksByDay[date] || {};
      const staff = Array.isArray(db.staff) ? db.staff : [];
      const nameOf = (id) => {
        const s = staff.find((x) => x && String(x.id) === String(id));
        return (s && s.name) || "";
      };
      const tracks = [];
      for (const [id, pts] of Object.entries(day)) {
        if (!isDriver({ id }, db)) continue;
        const coords = (pts || []).map((p) => [p[0], p[1]]).filter((p) =>
          Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
        );
        if (!coords.length) continue;
        tracks.push({ id, name: nameOf(id), track: coords });
      }
      return sendJson(res, 200, { ok: true, tracks });
    }

    if (urlPath === "/api/drivers/tracks/snapped" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      const date = params.get("date") || motionDayKey(Date.now());
      const day = tracksByDay[date] || {};
      const staff = Array.isArray(db.staff) ? db.staff : [];
      const nameOf = (id) => {
        const s = staff.find((x) => x && String(x.id) === String(id));
        return (s && s.name) || "";
      };
      const tracks = [];
      for (const [id, pts] of Object.entries(day)) {
        if (!isDriver({ id }, db)) continue;
        const coords = (pts || []).map((p) => [p[0], p[1]]).filter((p) =>
          Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
        );
        if (!coords.length) continue;
        const key = `${date}:${id}`;
        const cached = snappedTracks[key];
        if (Array.isArray(cached) && cached.length >= 2) {
          tracks.push({ id, name: nameOf(id), track: cached, snapped: true });
        } else {
          tracks.push({ id, name: nameOf(id), track: coords, snapped: false });
          snapTrackToRoads(coords).then((r) => {
            if (r && r.snapped && Array.isArray(r.path) && r.path.length >= 2) {
              snappedTracks[key] = r.path;
              scheduleSnappedSave();
            }
          }).catch(() => {});
        }
      }
      return sendJson(res, 200, { ok: true, tracks });
    }
    return false;
  };
};
