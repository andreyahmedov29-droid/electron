// Модуль-обработчик «Проблемы со склада» (/api/notfound GET+POST). Вынесен из
// server.js: логика дословно, зависимости инъекцией (DI).
module.exports = function createNotfoundHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  canSeeNotfound,
  alignWaybillsToClients,
  persistNotFoundStatuses,
  isAdmin,
} = {}) {
  return async function handleNotfoundRoutes(req, res, urlPath, method, user) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/notfound" && method === "GET") {
      if (!canSeeNotfound(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const dk = (ts) => {
        const d = new Date(ts);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      };
      const START_DATE = "2026-09-30";
      const nfNorm = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
      const nfKey = (client, art) => nfNorm(client) + "|" + nfNorm(art);
      const nfClientDisplay = (src) => {
        const b = String((src && src.bundleName) || "").trim();
        if (b) return b;
        const c = String((src && src.client) || "").trim();
        if (c) return c;
        const joined = (Array.isArray(src && src.members) ? src.members : [])
          .map((m) => String((m && (m.client || m.bundleName)) || "").trim())
          .filter(Boolean).join(", ");
        if (joined) return joined;
        return String((src && src.address) || "—");
      };
      const byKey = new Map();
      const artClientMap = new Map();
      // Артикулы, которые СЕЙЧАС собраны/размещены (не «не найдено») в накладных.
      const notMissingArts = new Set();
      for (const r0 of (Array.isArray(db.driverRoutes) ? db.driverRoutes : [])) {
        alignWaybillsToClients(r0);
        const cl0 = Array.isArray(r0.clients) ? r0.clients : [];
        cl0.forEach((rc, ci) => {
          const wb = r0.waybills && r0.waybills[ci];
          const its = wb && Array.isArray(wb.items) ? wb.items : [];
          const cname = nfClientDisplay(rc);
          if (!cname) return;
          its.forEach((it) => {
            const mq = Number(it.missingQty) || 0;
            const a = String(it.art || "");
            const isMiss = !!it.missing || mq > 0;
            if (!isMiss) { if (a && nfNorm(a)) notMissingArts.add(nfNorm(a)); return; }
            if (a && !artClientMap.has(a)) artClientMap.set(a, cname);
          });
        });
      }
      const currentArts = new Set(artClientMap.keys());
      const log = Array.isArray(db.scanLog) ? db.scanLog : [];
      // Максимальный ts УСПЕШНОГО скана по каждому коду. Если деталь сначала
      // пометили «не найдено», а потом приняли (засчитали), старая missing-запись
      // остаётся в scanLog навсегда. Такая запись — НЕ проблема: показываем её в
      // отчёте только если после пометки не было успешного приёма этого кода.
      const acceptMax = new Map();
      for (const e2 of log) {
        if (e2.action !== "waybill" || e2.missing || !e2.ts) continue;
        const k = nfNorm(String(e2.code || ""));
        if (k && (!acceptMax.has(k) || e2.ts > acceptMax.get(k))) acceptMax.set(k, e2.ts);
      }
      for (const e of log) {
        if (e.action !== "waybill" || !e.missing) continue;
        // Артикул сейчас собран/размещён в накладной (не «не найдено») — старая
        // запись «не найдено» по нему не актуальна, в «Проблемы склада» не идёт.
        const nmN = nfNorm(String(e.code || ""));
        if (nmN && notMissingArts.has(nmN)) continue;
        if (e.ts && dk(e.ts) < START_DATE) continue;
        if (currentArts.has(String(e.code || ""))) continue;
        const cnorm = nfNorm(String(e.code || ""));
        const acc = cnorm ? acceptMax.get(cnorm) : undefined;
        if (acc !== undefined && acc >= (e.ts || 0)) continue; // после пометки деталь приняли
        const disp = artClientMap.get(String(e.code || "")) || nfClientDisplay(e);
        const key = nfKey(disp, e.code);
        if (!byKey.has(key)) {
          byKey.set(key, { date: e.ts || 0, user: String(e.userName || ""), client: disp, art: String(e.code || ""), name: String(e.name || ""), qty: 0 });
        }
        const rec = byKey.get(key);
        if (e.ts && (!rec.date || e.ts > rec.date)) rec.date = e.ts;
        if (e.userName && !rec.user) rec.user = String(e.userName);
        if (!rec.name) rec.name = String(e.name || "");
        rec.qty = Math.max(rec.qty, Number(e.qty) || 0);
      }
      const routes = Array.isArray(db.driverRoutes) ? db.driverRoutes : [];
      for (const route of routes) {
        alignWaybillsToClients(route);
        const clients = Array.isArray(route.clients) ? route.clients : [];
        clients.forEach((rc, ci) => {
          if (!rc) return;
          const wb = route.waybills && route.waybills[ci];
          const items = wb && Array.isArray(wb.items) ? wb.items : [];
          for (const it of items) {
            const mq = Number(it.missingQty) || 0;
            if (!it.missing && mq <= 0) continue;
            // Актуализация «Проблем склада»: позиция, уже размещённая в бокс или
            // принятая (перемещена), больше не проблема — не показываем её здесь.
            if (String(it.box || "") || (Number(it.scanned) || 0) > 0) continue;
            const cname = nfClientDisplay(rc);
            const key = nfKey(cname, it.art);
            if (!byKey.has(key)) {
              byKey.set(key, { date: route.at || 0, user: "", client: cname, art: String(it.art || ""), name: String(it.name || ""), qty: 0 });
            }
            const rec = byKey.get(key);
            if (!rec.name) rec.name = String(it.name || "");
            rec.qty = Math.max(rec.qty, mq > 0 ? mq : (Number(it.qty) || 0));
            if (!rec.date) rec.date = route.at || 0;
          }
        });
      }
      const stored = db.notFound || {};
      const rows = [];
      for (const [key, rec] of byKey) {
        if (rec.date && dk(rec.date) < START_DATE) continue;
        const s = stored[key] || { status: "Новая проблема", comment: "" };
        rows.push({ key, date: rec.date, user: rec.user, client: rec.client, art: rec.art, qty: rec.qty, name: rec.name, status: s.status || "Новая проблема", comment: s.comment || "", mStatus: s.mStatus || "Новая проблема", mComment: s.mComment || "", comments: Array.isArray(s.comments) ? s.comments : [] });
      }
      rows.sort((a, b) => (a.date || 0) - (b.date || 0));
      const statusSummary = {};
      for (const r of rows) {
        const st = String(r.status || "Новая проблема");
        statusSummary[st] = (statusSummary[st] || 0) + 1;
      }
      return sendJson(res, 200, { ok: true, rows, statusSummary });
    }

    if (urlPath === "/api/notfound" && method === "POST") {
      if (!canSeeNotfound(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const key = String(body.key || "");
      if (!key) return sendJson(res, 422, { error: "bad key" });
      // Удалить запись «Проблемы склада» целиком (админ-действие): сбрасываем статус
      // и, если это артикул, убираем связанную запись «не найдено» из scanLog, чтобы
      // строка перестала пересчитываться в отчёте.
      if (body.action === "delete") {
        if (!(isAdmin && isAdmin(user, db))) return sendJson(res, 403, { ok: false, error: "forbidden" });
        if (db.notFound) delete db.notFound[key];
        const art = String(key.split("|").pop() || "").trim().toLowerCase();
        if (art && Array.isArray(db.scanLog)) {
          db.scanLog = db.scanLog.filter((e) => !(e && e.action === "waybill" && e.missing
            && String(e.code || "").trim().toLowerCase() === art));
        }
        // Помимо статуса и scanLog снимаем саму пометку «не найдено» (missing)
        // с позиций накладных маршрутов этого клиента и артикула. Иначе отчёт
        // «Проблемы склада» пересчитается и вернёт строку — «пишет Удалено, а нет».
        const nfNorm2 = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
        const nfClientDisplay2 = (src) => {
          const b = String((src && src.bundleName) || "").trim();
          if (b) return b;
          const c = String((src && src.client) || "").trim();
          if (c) return c;
          const joined = (Array.isArray(src && src.members) ? src.members : [])
            .map((m) => String((m && (m.client || m.bundleName)) || "").trim())
            .filter(Boolean).join(", ");
          if (joined) return joined;
          return String((src && src.address) || "—");
        };
        const cNorm = String(key.slice(0, key.lastIndexOf("|")) || "").trim();
        const aNorm = String(art || "").trim();
        if (aNorm) {
          for (const route of (Array.isArray(db.driverRoutes) ? db.driverRoutes : [])) {
            alignWaybillsToClients(route);
            const clients = Array.isArray(route.clients) ? route.clients : [];
            clients.forEach((rc, ci) => {
              const cname = nfNorm2(nfClientDisplay2(rc));
              if (cNorm && cname !== cNorm) return;
              const wb = route.waybills && route.waybills[ci];
              const its = wb && Array.isArray(wb.items) ? wb.items : [];
              for (const it of its) {
                if (nfNorm2(String(it.art || "")) === aNorm && (it.missing || (Number(it.missingQty) || 0) > 0)) {
                  it.missing = false;
                  it.missingQty = 0;
                }
              }
            });
          }
        }
        await persistDb();
        void persistNotFoundStatuses().catch(() => {});
        return sendJson(res, 200, { ok: true });
      }
      if (!db.notFound) db.notFound = {};
      const cur = db.notFound[key] || {};
      const comments = Array.isArray(cur.comments) ? cur.comments.slice() : [];
      if (body.addComment && String(body.addComment.text || "").trim()) {
        comments.push({
          text: String(body.addComment.text).trim().slice(0, 2000),
          user: String(body.addComment.user || (user && user.name) || "").slice(0, 200),
          at: Date.now(),
        });
      }
      db.notFound[key] = {
        status: String(body.status || cur.status || "Новая проблема"),
        comment: String(body.comment != null ? body.comment : (cur.comment || "")),
        mStatus: String(body.mStatus != null ? body.mStatus : (cur.mStatus || "Новая проблема")),
        mComment: String(body.mComment != null ? body.mComment : (cur.mComment || "")),
        comments,
        at: Date.now(),
      };
      await persistDb();
      void persistNotFoundStatuses().catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    return false;
  };
};
