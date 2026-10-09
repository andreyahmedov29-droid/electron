// Модуль-обработчик групп (/api/groups). Вынесен из server.js (handleGroupsRoutes):
// логика перенесена дословно, поведение не меняется.
//
// Зависимости передаются инъекцией (DI) через фабрику, чтобы модуль не тянул
// за собой глобальное состояние server.js:
//   getDb     — () => актуальная БД (замыкание на let db; db может переустанавливаться,
//               поэтому всегда читаем через getter, а не храним ссылку);
//   persistDb — сохранение БД;
//   sendJson  — HTTP-ответ JSON;
//   readBody  — чтение тела запроса.
const crypto = require("node:crypto");

module.exports = function createGroupsHandler({ getDb, persistDb, sendJson, readBody } = {}) {
  return async function handleGroupsRoutes(req, res, urlPath, method, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/groups" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 200, { groups: db.groups });
    }

    if (urlPath === "/api/groups" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return sendJson(res, 422, { error: "name required" });
      const group = { id: "g-" + crypto.randomBytes(5).toString("hex"), name, memberIds: [], moderatorId: null };
      db.groups.push(group);
      await persistDb();
      return sendJson(res, 200, { ok: true, group, groups: db.groups });
    }

    const gm = urlPath.match(/^\/api\/groups\/(.+)$/) || null;
    if (gm && method === "PUT") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const group = db.groups.find((g) => g.id === gm[1]);
      if (!group) return sendJson(res, 404, { error: "group not found" });
      const body = await readBody(req);
      if (typeof body.name === "string") {
        const n = body.name.trim().slice(0, 120);
        if (n) group.name = n;
      }
      if (Array.isArray(body.memberIds)) {
        group.memberIds = [...new Set(body.memberIds.map(String).filter((mid) => db.staff.some((s) => s.id === mid)))];
      }
      if (body.moderatorId === null || body.moderatorId === "") {
        group.moderatorId = null;
      } else if (typeof body.moderatorId === "string" && db.staff.some((s) => s.id === body.moderatorId)) {
        group.moderatorId = body.moderatorId;
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, groups: db.groups });
    }

    if (gm && method === "DELETE") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      db.groups = db.groups.filter((g) => g.id !== gm[1]);
      await persistDb();
      return sendJson(res, 200, { ok: true, groups: db.groups });
    }
    return false;
  };
};
