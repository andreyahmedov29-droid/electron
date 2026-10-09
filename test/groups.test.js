// Юнит-тесты модуля routes/groups.js — группа/отделы.
const { test } = require("node:test");
const assert = require("node:assert");
const createGroupsHandler = require("../routes/groups");

function make(ctx) {
  return createGroupsHandler(Object.assign({
    getDb: () => ({ groups: [], staff: [{ id: "5", name: "X" }] }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
  }, ctx || {}));
}

test("GET /api/groups без прав администратора -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/groups", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/groups админ -> 200 и список групп", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/groups", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.ok(Array.isArray(res._json.obj.groups));
});

test("POST /api/groups создаёт группу с валидным id", async () => {
  const db = { groups: [], staff: [] };
  const h = make({ getDb: () => db, readBody: async () => ({ name: "Склад" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/groups", "POST", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.groups.length, 1);
  assert.match(db.groups[0].id, /^g-/);
  assert.strictEqual(db.groups[0].name, "Склад");
});

test("POST /api/groups без названия -> 422", async () => {
  const h = make({ readBody: async () => ({ name: "" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/groups", "POST", true);
  assert.strictEqual(res._json.status, 422);
});

test("PUT /api/groups/:id меняет имя и состав", async () => {
  const grp = { id: "g-1", name: "A", memberIds: [], moderatorId: null };
  const db = { groups: [grp], staff: [{ id: "5", name: "X" }] };
  const h = make({ getDb: () => db, readBody: async () => ({ name: "B", memberIds: ["5"] }) });
  const res = {};
  await h({ headers: {} }, res, "/api/groups/g-1", "PUT", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.groups[0].name, "B");
  assert.deepStrictEqual(db.groups[0].memberIds, ["5"]);
});

test("DELETE /api/groups/:id удаляет группу", async () => {
  const db = { groups: [{ id: "g-1", name: "A" }], staff: [] };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {} }, res, "/api/groups/g-1", "DELETE", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.groups.length, 0);
});

test("неизвестный маршрут -> false (цепочка продолжается)", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", true);
  assert.strictEqual(r, false);
});
