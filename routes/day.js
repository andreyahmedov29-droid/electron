// Модуль-обработчик рабочего дня (/api/day POST, DELETE /api/day/:key,
// POST /api/day/:key/reopen). Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createDayHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  segmentsFor,
  isAdmin,
  isModerator,
} = {}) {
  return async function handleDayRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/day" && method === "POST") {
      const body = await readBody(req);
      const key = typeof body.key === "string" ? body.key : null;
      if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return sendJson(res, 422, { error: "bad day key" });
      const segments = Array.isArray(body.segments) ? body.segments : [];
      // Keep admin-assigned statuses for this day; the owner saving their own work
      // segments must not silently wipe them out (statuses belong to multiple
      // employees, not just the segment owner).
      const prev = db.days[key];
      const prevStatuses = prev && prev.statuses && typeof prev.statuses === "object" ? prev.statuses : undefined;
      // Do not let a stale client save silently kill a live running timer. When the
      // incoming list has no open work segment but the stored day already has one for
      // this owner, keep the open segment — the running timer must never be erased by a
      // background tab / an out-of-order save. An explicit "Завершить" always arrives
      // with that segment already closed (its `end` set), so it still works.
      const prevOwn = segmentsFor(user.id, prev);
      const prevEntry = prev && prev.byEmployee && prev.byEmployee[user.id] ? prev.byEmployee[user.id] : null;
      const prevFinished = !!(prevEntry && prevEntry.finished);
      // Ручная правка админа по времени на этот день (см. PUT /api/admin/day):
      // пока стоит флаг, живые тики сотрудника не должны возвращать реальное
      // время поверх вручную заданного.
      const adminLock = !!(prevEntry && prevEntry.adminLock);
      const prevOpen = prevOwn.find((s) => s.kind === "work" && s.end == null) || null;
      // Защита от битых/мусорных записей сегментов (null, строки): клиент может
      // прислать их в segments, и раньше `incomingHasOpen` падал на s.kind (500).
      // Отбрасываем не-объектные элементы — они не могут быть «открытым рабочим»
      // сегментом, поэтому на решение о воскрешении таймера не влияют.
      const incomingHasOpen = Array.isArray(segments)
        && segments.some((s) => !!s && typeof s === "object" && s.kind === "work" && s.end == null);
      // П.1 — защита от дубля «закрытый + открытый»: явное «Завершить работу».
      // Клиент передаёт finish:true (и реальное время нажатия finishTime). Тогда
      // сервер закрывает любые открытые сегменты и НИКОГДА не воскрешает висящий
      // prevOpen (раньше при несовпадении id закрытый + prevOpen добавлялся обратно,
      // и день оставался открытым на сервере — «конец» в админке был пуст).
      const finish = body.finish === true;
      const finishTime = Number.isFinite(body.finishTime) ? body.finishTime : Date.now();
      let merged = Array.isArray(segments) ? segments.slice() : [];
      if (finish) {
        // Явное завершение: закрываем все открытые сегменты временем нажатия и
        // не тащим prevOpen обратно. День помечается закрытым (finished), чтобы
        // фоновые вкладки не могли его снова открыть.
        for (const s of merged) {
          if (s && typeof s === "object" && s.end == null) s.end = finishTime;
        }
      } else if (adminLock) {
        // Живое сохранение идущего таймера не имеет права трогать день, который
        // админ отредактировал вручную: оставляем серверные (админские) сегменты,
        // чтобы «07:00» не «съехал» на реальное «08:00». Явное «Завершить работу»
        // (finish) выше по-прежнему применяется и закрывает день.
        merged = prevOwn.slice();
      } else if (prevFinished) {
        // П.2 — защита от гонки: день уже закрыт («Завершить работу» было).
        // Фоновая вкладка с ещё идущим таймером каждые ~8 c шлёт сюда открытый
        // сегмент и перезаписывала бы закрытое состояние (а открытый сегмент мог бы
        // затереть уже сохранённый «конец»). Запрос без явного finish — не
        // авторитетная перезапись, поэтому НЕ трогаем уже сохранённую запись:
        // оставляем серверные сегменты (и флаг finished), возвращаем ok.
        merged = prevOwn.slice();
      } else if (prevOpen && !incomingHasOpen) {
        // The incoming day closes the SAME open timer (same id, or same start when
        // id is absent) — that is an explicit "Завершить работу", not a stale
        // background save. Keep the closed segment and do NOT resurrect the open
        // one, so the day stays finished after a reload (the "Завершить" button
        // does not come back and the "конец" time is recorded).
        const alreadyClosed = merged.some(
          (s) => s.kind === "work"
            && s.end != null
            && (s.id != null ? s.id === prevOpen.id : s.start === prevOpen.start)
        );
        if (!alreadyClosed) merged.push(prevOpen);
      }
      // Server always writes as the owner: a member can only touch their own days.
      const day = prev && typeof prev === "object" ? prev : {};
      if (!(day.byEmployee && typeof day.byEmployee === "object")) day.byEmployee = {};
      // Помечаем запись сотрудника закрытой при явном завершении (или если она
      // уже была закрыта) — так фоновые вкладки не смогут вернуть открытый таймер.
      day.byEmployee[user.id] = {
        segments: merged,
        finished: finish || prevFinished,
        adminLock: adminLock,
      };
      if (prevStatuses) day.statuses = prevStatuses;
      db.days[key] = day;
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // DELETE /api/day/:key (owner or admin)
    let m = urlPath.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/) || null;
    if (m && method === "DELETE") {
      const key = m[1];
      const rec = db.days[key];
      if (!rec) return sendJson(res, 404, { error: "not found" });
      if (!isAdmin(user, db)) {
        // Member deletes only their own segments, not the whole shared day.
        if (!(rec.byEmployee && rec.byEmployee[user.id]) && !(rec.ownerId === user.id)) {
          return sendJson(res, 403, { error: "forbidden" });
        }
        if (rec.byEmployee && typeof rec.byEmployee === "object") delete rec.byEmployee[user.id];
        const hasSegs = rec.byEmployee && Object.keys(rec.byEmployee).some((k) => (rec.byEmployee[k].segments || []).length);
        const hasStatuses = rec.statuses && Object.keys(rec.statuses).length;
        if (!hasSegs && !hasStatuses) delete db.days[key];
      } else {
        delete db.days[key];
      }
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    // POST /api/day/:key/reopen (admin/moderator)
    // Точечно «открыть» рабочий день сотрудника после того, как он сам закрылся
    // (например, автозакрытие незакрытого таймера по концу дня — autoCloseDayEndTimers
    // повесило finished:true). Только для этого сотрудника, остальных не затрагивает.
    // clearTime=true — удалить его сегменты времени этого дня (если нужно «удалить время»).
    let rm = urlPath.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})\/reopen$/) || null;
    if (rm && method === "POST") {
      if (!isAdmin(user, db) && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const key = rm[1];
      const body = await readBody(req);
      const staffId = String(body.staffId || "");
      const clearTime = body.clearTime === true;
      if (!staffId) return sendJson(res, 422, { error: "staffId required" });
      const rec = db.days[key];
      if (!rec) return sendJson(res, 404, { error: "not found" });
      if (rec.byEmployee && typeof rec.byEmployee === "object" && rec.byEmployee[staffId]) {
        const entry = rec.byEmployee[staffId];
        if (clearTime && Array.isArray(entry.segments)) entry.segments = [];
        entry.finished = false;
        entry.reopenedAt = Date.now();
        // Снимаем админскую «заморозку» правки времени: пока adminLock стоит, живые
        // тики сотрудника (POST /api/day) не обновляют вручную заданное время. Это
        // мешает: после ручной правки админ жмёт «Открыть», а день «не оживает» —
        // введённое ПО факту время блокируется навсегда. Открытие дня = снятие правки.
        if (entry.adminLock) delete entry.adminLock;
      }
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    return false;
  };
};
