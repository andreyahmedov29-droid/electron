// Модуль-обработчик геолокации водителей (/api/drivers/location GET+POST).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createLocationHandler({
  getDb,
  sendJson,
  readBody,
  isDriver,
  isDriversGroupOnly,
  motionDayKey,
  tracksByDay,
  scheduleTracksSave,
  reverseGeocode,
} = {}) {
  // Расстояние по гаверсинусу (км).
  const haversineKm = (aLat, aLon, bLat, bLon) => {
    const R = 6371, toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  return async function handleLocationRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // Отчёт «Местоположение»: где находился водитель в течение календарного дня
    // с интервалом в 15 минут. Данные — фактический GPS-трек (tracksByDay).
    // Обратное геокодирование координат в адрес делает reverseGeocode (Yandex),
    // с кэшем. Доступно только админу/модератору.
    if (urlPath === "/api/drivers/location-report" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      try {
        const u = new URL(req.url, "http://localhost");
        const date = String(u.searchParams.get("date") || "");
        const driverId = String(u.searchParams.get("driverId") || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !driverId) {
          return sendJson(res, 422, { ok: false, error: "bad params" });
        }
        const reqInterval = Number(u.searchParams.get("interval") || 15);
        const intervalMin = Number.isFinite(reqInterval) && reqInterval >= 1 && reqInterval <= 1440
          ? Math.round(reqInterval)
          : 15;
        const pts = (tracksByDay[date] && tracksByDay[date][driverId]) || [];
        // Отчёт строится в часовом поясе Москвы (UTC+3) независимо от пояса сервера:
        // календарный день в МСК начинается в 21:00 UTC предыдущих суток.
        const [yy, mm, dd] = String(date).split("-").map(Number);
        const dayStart = Date.UTC(yy, mm - 1, dd) - 3 * 3600000;
        const dayEnd = dayStart + 86400000;
        const raw = Array.isArray(pts) ? pts.filter(
          (p) => Array.isArray(p) && p.length >= 3
            && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])
        ) : [];
        // Дрейф серверных часов относительно реальных: берём из точки, у которой
        // рядом с реальным временем сохранено серверное время приёма (4-й элемент).
        let drift = null;
        for (const p of raw) {
          if (p.length >= 4 && Number.isFinite(Number(p[3]))) {
            drift = Number(p[3]) - Number(p[2]);
          }
        }
        const realTsOf = (p) => {
          if (p.length >= 4) return Number(p[2]); // уже реальное (клиентское)
          return Number.isFinite(drift) ? Number(p[2]) - drift : Number(p[2]);
        };
        const track = raw
          .map((p) => ({ lat: Number(p[0]), lon: Number(p[1]), t: realTsOf(p) }))
          .filter((q) => q.t >= dayStart && q.t < dayEnd)
          .sort((a, b) => a.t - b.t);
        const SLOT = intervalMin * 60000;
        // Слот без точек рядом пропускаем: окно поиска чуть шире шага, но не больше
        // мгновенного «простоя» соседних слотов.
        const MAX_GAP = Math.max(intervalMin * 60000, 10 * 60000);
        const rows = [];
        const slots = Math.floor((24 * 60) / intervalMin);
        let prev = null;
        for (let i = 0; i < slots; i++) {
          const slotTs = dayStart + i * SLOT;
          let best = null;
          for (const p of track) {
            const d = Math.abs(p.t - slotTs);
            if (!best || d < best.d) best = { d, p };
          }
          if (!best || best.d > MAX_GAP) continue;
          const p = best.p;
          const addr = reverseGeocode ? await reverseGeocode(p.lat, p.lon) : null;
          const dt = new Date(slotTs + 3 * 3600000); // переводим метку в МСК (UTC+3)
          // Реальная скорость от приложения (5-й элемент точки), если она передана:
          // иначе используем расчётную (distance/time) с отсечкой выбросов.
          const realSpeed = (Array.isArray(p) && p.length >= 5 && Number.isFinite(Number(p[4])))
            ? Math.round(Number(p[4]) * 10) / 10
            : null;
          // Скорость на участке между соседними точками снятия (средняя, км/ч).
          let speedKmh = null;
          if (prev && (p.t - prev.t) > 20e3) {
            const dKm = haversineKm(prev.lat, prev.lon, p.lat, p.lon);
            const dtH = (p.t - prev.t) / 3600000;
            if (dtH > 0) speedKmh = Math.round((dKm / dtH) * 10) / 10;
            // GPS-скачок: одна точка «прыгнула» далеко от предыдущей за короткое
            // время — расчётная скорость нереальна (170–340 км/ч в городе). Это
            // выброс координат, а не движение: не показываем его как скорость.
            if (speedKmh != null && speedKmh > 130) speedKmh = null;
          }
          rows.push({
            time: String(dt.getUTCHours()).padStart(2, "0") + ":" + String(dt.getUTCMinutes()).padStart(2, "0"),
            lat: Number(Number(p.lat).toFixed(6)),
            lon: Number(Number(p.lon).toFixed(6)),
            speed: realSpeed != null ? realSpeed : speedKmh,
            address: addr || null,
            actualTs: p.t,
          });
          prev = p;
        }
        return sendJson(res, 200, { ok: true, date, driverId, rows });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: "report failed" });
      }
    }

    if (urlPath === "/api/drivers/location" && method === "POST") {
      if (!isDriver(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      // Принимаем либо одиночную точку {lat, lon, routeId?, ts?}, либо пачку
      // офлайн-буфера: { points: [ {lat, lon, routeId?, ts?}, ... ] }.
      const batch = Array.isArray(body.points) ? body.points.slice(0, 200) : [body];
      for (const p of batch) {
        const lat = Number(p.lat);
        const lon = Number(p.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const uid = String(user.id);
        // Метка времени берётся с устройства водителя (реальное время), если
        // передана корректной, иначе — со сервера (убирает сдвиг часов сервера).
        const serverNow = Date.now();
        const clientTs = Number(p.ts);
        const useClient = Number.isFinite(clientTs) && clientTs > 0;
        const atNow = useClient ? clientTs : serverNow;
        db.liveLocations[uid] = {
          lat, lon, at: atNow,
          name: user.name || "",
          routeId: p.routeId != null ? String(p.routeId) : "",
          speed: Number(p.speed) || null,
        };
        const tr = db.tracks[uid] || (db.tracks[uid] = []);
        const last = tr[tr.length - 1];
        const moved = !last
          || Math.abs(last.lat - lat) > 1e-4
          || Math.abs(last.lon - lon) > 1e-4
          || (atNow - last.at) > 30000;
        if (moved) tr.push({ lat, lon, at: atNow });
        const dayK = motionDayKey(atNow);
        const dTrack = (tracksByDay[dayK] || (tracksByDay[dayK] = {}))[uid] ||
          ((tracksByDay[dayK][uid] = []));
        const dLast = dTrack[dTrack.length - 1];
        if (!dLast || (atNow - dLast[2]) >= 20000 || Math.abs(dLast[0] - lat) > 5e-4 || Math.abs(dLast[1] - lon) > 5e-4) {
          // Единый формат точки [lat, lon, t, serverNow, speed]: t — реальное время,
          // serverNow — серверное при приёме (для дрейфа часов), speed — реальная
          // GPS-скорость от приложения (если передана). По числу элементов (>=4)
          // отчёт понимает, что точка несёт полную информацию.
          dTrack.push([lat, lon, atNow, serverNow, Number(p.speed) || null]);
          if (dTrack.length > 4000) dTrack.splice(0, dTrack.length - 4000);
          const cutoff = motionDayKey(atNow - 60 * 24 * 3600000);
          Object.keys(tracksByDay).forEach((k) => { if (k < cutoff) delete tracksByDay[k]; });
          scheduleTracksSave();
        }
        while (tr.length && atNow - tr[0].at > 6 * 3600000) tr.shift();
        if (tr.length > 500) tr.splice(0, tr.length - 500);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (urlPath === "/api/drivers/location" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const now = Date.now();
      const freshWindow = 10 * 60 * 1000;
      const rows = [];
      for (const [id, loc] of Object.entries(db.liveLocations || {})) {
        if (!isDriversGroupOnly({ id }, db)) {
          delete db.liveLocations[id];
          delete db.tracks[id];
          continue;
        }
        if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) continue;
        if (now - loc.at > freshWindow) continue;
        rows.push({ id, name: loc.name || "", lat: loc.lat, lon: loc.lon, at: loc.at, routeId: loc.routeId || "", speed: loc.speed != null ? loc.speed : null });
      }
      return sendJson(res, 200, { ok: true, rows });
    }
    return false;
  };
};
