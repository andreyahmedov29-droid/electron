// Модуль-обработчик дашборда движения водителей (/api/drivers/motion GET).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createMotionHandler({
  getDb,
  sendJson,
  withResolvedBundleNames,
  haversineKm,
  motionDayKey,
  tracksByDay,
} = {}) {
  return async function handleMotionRoutes(req, res, urlPath, method, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/drivers/motion" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const q = req.url.split("?")[1] || "";
      const params = new URLSearchParams(q);
      let date = params.get("date") || "";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = motionDayKey(Date.now());
      const now = Date.now();
      const agg = {};
      const routesPerDriver = {};
      (db.driverRoutes || []).forEach((r) => {
        r = withResolvedBundleNames(r, db);
        if (!r || r.date !== date) return;
        const prog = r.progress || {};
        const totalLunch = (Array.isArray(prog.lunchHistory) ? prog.lunchHistory : [])
          .reduce((s, h) => {
            if (h && Number.isFinite(h.from) && Number.isFinite(h.to) && h.to > h.from) return s + (h.to - h.from);
            return s;
          }, 0);
        const path = [];
        if (Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
          path.push({ lat: prog.baseLat, lon: prog.baseLon });
        }
        let moveSec = 0, siteSec = 0, points = 0;
        (Array.isArray(r.clients) ? r.clients : []).forEach((c) => {
          if (!c) return;
          if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) path.push({ lat: c.lat, lon: c.lon });
          const tp = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
          let ts = Number.isFinite(c.transitStart) ? c.transitStart : 0;
          let te = Number.isFinite(c.transitEnd) ? c.transitEnd : 0;
          let ss = Number.isFinite(c.siteStart) ? c.siteStart : 0;
          let se = Number.isFinite(c.siteEnd) ? c.siteEnd : 0;
          if (c.state === "in_transit" && ts && !te) te = now;
          if (c.state === "on_site" && ss && !se) se = now;
          if (ts && te && te > ts) moveSec += Math.max(0, te - ts - tp);
          if (ss && se && se > ss) siteSec += se - ss;
          points += 1;
        });
        if (path.length >= 2 && Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
          path.push({ lat: prog.baseLat, lon: prog.baseLon });
        }
        let km = 0;
        for (let i = 1; i < path.length; i++) {
          if (path[i - 1] && path[i]) km += haversineKm(path[i - 1], path[i]);
        }
        const key = String(r.driverId);
        const a = agg[key] || (agg[key] = { name: r.driverName || key, km: 0, moveSec: 0, siteSec: 0, lunchSec: 0, points: 0 });
        a.km += km;
        a.moveSec += moveSec;
        a.siteSec += siteSec;
        a.lunchSec += totalLunch;
        a.points += points;
        const cli = Array.isArray(r.clients) ? r.clients : [];
        let cliTotal = 0, cliDelivered = 0, cliInTransit = 0, places = 0;
        cli.forEach((c) => {
          cliTotal += 1;
          const st = c && c.state;
          if (st === "delivered" || st === "postponed") cliDelivered += 1;
          else if (st === "in_transit") cliInTransit += 1;
          places += Number.isFinite(c && c.labelQty) ? (Number(c.labelQty) || 0) : 0;
        });
        let prevLat = Number.isFinite(prog.baseLat) ? prog.baseLat : null;
        let prevLon = Number.isFinite(prog.baseLon) ? prog.baseLon : null;
        const cliDetail = cli.map((c) => {
          const tp = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
          let ts = Number.isFinite(c.transitStart) ? c.transitStart : 0;
          let te = Number.isFinite(c.transitEnd) ? c.transitEnd : 0;
          let ss = Number.isFinite(c.siteStart) ? c.siteStart : 0;
          let se = Number.isFinite(c.siteEnd) ? c.siteEnd : 0;
          if (c.state === "in_transit" && ts && !te) te = now;
          if (c.state === "on_site" && ss && !se) se = now;
          let km = 0;
          if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
            if (prevLat != null && prevLon != null) {
              km = haversineKm({ lat: prevLat, lon: prevLon }, { lat: c.lat, lon: c.lon });
            }
            prevLat = c.lat; prevLon = c.lon;
          }
          return {
            client: String(c.client || ""),
            address: String(c.address || ""),
            bundleName: String(c.bundleName || ""),
            state: String(c.state || ""),
            moveSec: Math.round(((ts && te && te > ts) ? Math.max(0, te - ts - tp) : 0) / 1000),
            siteSec: Math.round(((ss && se && se > ss) ? (se - ss) : 0) / 1000),
            km: Math.round(km * 10) / 10,
            placesDone: Number.isFinite(c.placesDone) ? c.placesDone : 0,
            placesTotal: Number.isFinite(c.placesTotal) ? c.placesTotal : 0,
          };
        });
        const rd = routesPerDriver[key] || (routesPerDriver[key] = []);
        rd.push({
          id: String(r.id != null ? r.id : ""),
          name: r.routeName || r.driverName || "Маршрут",
          moveSec: Math.round(moveSec / 1000),
          siteSec: Math.round(siteSec / 1000),
          lunchSec: Math.round(totalLunch / 1000),
          points,
          cliTotal,
          cliDelivered,
          cliInTransit,
          places,
          clients: cliDetail,
        });
      });
      const dayTracks = tracksByDay[date] || {};
      for (const [id, e] of Object.entries(agg)) {
        const intervals = [];
        (db.driverRoutes || []).forEach((r) => {
          if (!r || r.date !== date || String(r.driverId) !== String(id)) return;
          let lastEnd = 0;
          (Array.isArray(r.clients) ? r.clients : []).forEach((c) => {
            if (!c) return;
            const ts = Number.isFinite(c.transitStart) ? c.transitStart : 0;
            const te = Number.isFinite(c.transitEnd) ? c.transitEnd : 0;
            if (ts && te && te > ts) intervals.push([ts, te]);
            if (te > lastEnd) lastEnd = te;
          });
          const back = Number.isFinite(r.progress && r.progress.baseArrivedAt)
            ? r.progress.baseArrivedAt : 0;
          if (lastEnd && back && back > lastEnd) intervals.push([lastEnd, back]);
        });
        intervals.sort((x, y) => x[0] - y[0]);
        const merged = [];
        for (const iv of intervals) {
          const lastIv = merged[merged.length - 1];
          if (lastIv && iv[0] <= lastIv[1]) lastIv[1] = Math.max(lastIv[1], iv[1]);
          else merged.push([iv[0], iv[1]]);
        }
        const tr = dayTracks[id] || [];
        if (tr.length >= 2) {
          let tk = 0;
          let usedAny = false;
          for (let i = 1; i < tr.length; i++) {
            const a = tr[i - 1], b = tr[i];
            if (!Array.isArray(a) || !Array.isArray(b) ||
                !Number.isFinite(a[0]) || !Number.isFinite(a[1]) ||
                !Number.isFinite(b[0]) || !Number.isFinite(b[1])) continue;
            const at = Number.isFinite(a[2]) ? a[2] : 0;
            const bt = Number.isFinite(b[2]) ? b[2] : 0;
            if (!(at && bt)) continue;
            if (!merged.some((iv) => at >= iv[0] && at <= iv[1] && bt >= iv[0] && bt <= iv[1])) continue;
            const d = haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
            const dtH = bt > at ? (bt - at) / 3600000 : 0;
            if (dtH > 0) {
              if (d / dtH > 150) continue;
            } else if (d > 0.05) {
              continue;
            }
            tk += d;
            usedAny = true;
          }
          if (usedAny) {
            e.km = Math.round(tk * 10) / 10;
            e.kmSource = "gps";
          } else {
            e.km = Math.round(e.km * 10) / 10;
            e.kmSource = "route";
          }
        } else {
          e.km = Math.round(e.km * 10) / 10;
          e.kmSource = "route";
        }
      }
      const rows = Object.entries(agg).map(([id, e]) => ({
        id,
        name: e.name,
        km: e.km,
        kmSource: e.kmSource,
        moveSec: Math.round(e.moveSec / 1000),
        siteSec: Math.round(e.siteSec / 1000),
        lunchSec: Math.round(e.lunchSec / 1000),
        points: e.points,
        routes: (routesPerDriver[id] || []).sort((x, y) => (y.points - x.points) || (y.moveSec - x.moveSec)),
      })).sort((x, y) => (y.km - x.km) || (y.moveSec - x.moveSec));
      return sendJson(res, 200, { ok: true, date, rows });
    }
    return false;
  };
};
