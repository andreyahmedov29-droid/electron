// Модуль-обработчик параметров (/api/params). Вынесен из server.js
// (handleParamsRoutes): логика перенесена дословно, поведение не меняется.
//
// Зависимости через фабрику (DI): getDb — актуальная БД (геттер, т.к. db может
// переустанавливаться); persistDb; sendJson; readBody; keepGroupParamIds и
// keepStaffParamIds — нормализация id (передаются из server.js).
module.exports = function createParamsHandler({ getDb, persistDb, sendJson, readBody, keepGroupParamIds, keepStaffParamIds } = {}) {
  return async function handleParamsRoutes(req, res, urlPath, method, admin) {
    if (urlPath === "/api/params" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const db = getDb ? getDb() : {};
      const body = await readBody(req);
      const p = db.params;
      if (typeof body.showOverHours === "boolean") p.showOverHours = body.showOverHours;
      if (typeof body.showOverSum === "boolean") p.showOverSum = body.showOverSum;
      if (typeof body.showDrivers === "boolean") p.showDrivers = body.showDrivers;
      if (typeof body.adminSeeRoutes === "boolean") p.adminSeeRoutes = body.adminSeeRoutes;
      if (typeof body.driverSeeRoutes === "boolean") p.driverSeeRoutes = body.driverSeeRoutes;
      if (typeof body.showShipment === "boolean") p.showShipment = body.showShipment;
      if (Array.isArray(body.showOverHoursGroups)) {
        p.showOverHoursGroups = keepGroupParamIds(body.showOverHoursGroups, db);
      }
      if (Array.isArray(body.showOverSumGroups)) {
        p.showOverSumGroups = keepGroupParamIds(body.showOverSumGroups, db);
      }
      if (Array.isArray(body.shipmentGroups)) {
        p.shipmentGroups = keepGroupParamIds(body.shipmentGroups, db);
      }
      if (Array.isArray(body.notfoundUsers)) {
        p.notfoundUsers = keepStaffParamIds(body.notfoundUsers, db);
      }
      if (Array.isArray(body.logUsers)) {
        p.logUsers = keepStaffParamIds(body.logUsers, db);
      }
      if (Array.isArray(body.reportsUsers)) {
        p.reportsUsers = keepStaffParamIds(body.reportsUsers, db);
      }
      if (body.reportsSections && typeof body.reportsSections === "object") {
        const out = {};
        for (const [key, ids] of Object.entries(body.reportsSections)) {
          if (!Array.isArray(ids)) continue;
          out[key] = ids.map((x) => String(x));
        }
        p.reportsSections = out;
      }
      if (Array.isArray(body.sverkiUsers)) {
        p.sverkiUsers = keepStaffParamIds(body.sverkiUsers, db);
      }
      if (Array.isArray(body.procenkaUsers)) {
        p.procenkaUsers = keepStaffParamIds(body.procenkaUsers, db);
      }
      if (Array.isArray(body.parserUsers)) {
        p.parserUsers = keepStaffParamIds(body.parserUsers, db);
      }
      if (typeof body.allowDriverStartWithoutShipment === "boolean") {
        p.allowDriverStartWithoutShipment = body.allowDriverStartWithoutShipment;
      }
      if (typeof body.allowFinishUnloadIncomplete === "boolean") {
        p.allowFinishUnloadIncomplete = body.allowFinishUnloadIncomplete;
      }
      if (typeof body.allowDriverReorderPoints === "boolean") {
        p.allowDriverReorderPoints = body.allowDriverReorderPoints;
      }
      if (typeof body.allowWaybill === "boolean") {
        p.allowWaybill = body.allowWaybill;
      }
      if (typeof body.routeDeleteCode === "string") {
        p.routeDeleteCode = String(body.routeDeleteCode).trim().slice(0, 50);
      }
      if (Number.isFinite(Number(body.scanLogLimit)) && Number(body.scanLogLimit) >= 100) {
        p.scanLogLimit = Math.min(200000, Math.round(Number(body.scanLogLimit)));
      }
      if (typeof body.multiplier === "number" && body.multiplier >= 1) p.multiplier = body.multiplier;
      if (typeof body.multFrom === "string") p.multFrom = body.multFrom || null;
      if (typeof body.multTo === "string") p.multTo = body.multTo || null;
      if (Array.isArray(body.multGroups)) {
        p.multGroups = [...new Set(body.multGroups.map(String).filter((id) => db.groups.some((g) => g.id === id)))];
      }
      if (Array.isArray(body.multRules)) {
        const staffIds = new Set((db.staff || []).map((s) => String(s.id)));
        const groupIds = new Set((db.groups || []).map((g) => String(g.id)));
        const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
        const validTime = (t) => typeof t === "string" && /^\d{2}:\d{2}$/.test(t);
        p.multRules = body.multRules
          .filter((r) => r && typeof r === "object")
          .map((r) => ({
            id: String(r.id || r.target + ":" + r.targetId + ":" + r.mult),
            target: r.target === "staff" || r.target === "group" || r.target === "all" ? r.target : "all",
            targetId: r.target === "all" ? null : String(r.targetId || ""),
            mult: Number.isFinite(Number(r.mult)) && Number(r.mult) >= 1 ? Number(r.mult) : 1,
            date: validDate(r.date) ? r.date : "",
            from: validTime(r.from) ? r.from : "",
            to: validTime(r.to) ? r.to : "",
          }))
          .filter((r) => {
            if (!r.date || !r.from || !r.to) return false; // день обязателен
            if (r.mult <= 1) return false;
            if (r.target === "all") return true;
            if (r.target === "staff") return staffIds.has(r.targetId);
            return groupIds.has(r.targetId);
          });
      }
      if (typeof body.norm === "number" && body.norm >= 1 && body.norm <= 24) db.norm = body.norm;
      if (body.updateVersionCode === "" || body.updateVersionCode === null) {
        p.updateVersionCode = null;
      } else if (Number.isFinite(Number(body.updateVersionCode)) && Number(body.updateVersionCode) >= 1) {
        p.updateVersionCode = Number(body.updateVersionCode);
      }
      if (typeof body.updateVersionName === "string") p.updateVersionName = body.updateVersionName.trim();
      if (typeof body.updateApkUrl === "string") p.updateApkUrl = body.updateApkUrl.trim();
      if (typeof body.updateNotes === "string") p.updateNotes = body.updateNotes.trim();
      await persistDb();
      return sendJson(res, 200, { ok: true, params: db.params, norm: db.norm });
    }
    return false;
  };
};
