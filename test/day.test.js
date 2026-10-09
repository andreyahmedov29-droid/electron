// Юнит-тесты модуля routes/day.js — рабочий день.
const { test } = require("node:test");
const assert = require("node:assert");
const createDayHandler = require("../routes/day");

function make(ctx) {
  return createDayHandler(Object.assign({
    getDb: () => ({ days: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    segmentsFor: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  }, ctx || {}));
}

const user = { id: "u1", name: "Пользователь" };

test("POST /api/day с плохим ключом -> 422", async () => {
  const h = make({ readBody: async () => ({ key: "bad", segments: [] }) });
  const res = {};
  await h({ headers: {}, url: "/api/day" }, res, "/api/day", "POST", user);
  assert.strictEqual(res._json.status, 422);
});

test("POST /api/day сохраняет день", async () => {
  const db = { days: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ key: "2026-10-03", segments: [] }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/day" }, res, "/api/day", "POST", user);
  assert.strictEqual(res._json.status, 200);
  assert.ok(db.days["2026-10-03"]);
});

test("DELETE /api/day/:key несуществующий -> 404", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/day/2026-10-03" }, res, "/api/day/2026-10-03", "DELETE", user);
  assert.strictEqual(res._json.status, 404);
});

test("DELETE /api/day/:key админ удаляет день", async () => {
  const db = { days: { "2026-10-03": { byEmployee: { u1: { segments: [] } } } } };
  const h = make({ getDb: () => db, isAdmin: () => true });
  const res = {};
  await h({ headers: {}, url: "/api/day/2026-10-03" }, res, "/api/day/2026-10-03", "DELETE", user);
  assert.strictEqual(res._json.status, 200);
  assert.ok(!db.days["2026-10-03"]);
});

test("POST /api/day/:key/reopen не модератор/админ -> 403", async () => {
  const h = make({ readBody: async () => ({ staffId: "u1" }) });
  const res = {};
  await h({ headers: {}, url: "/api/day/2026-10-03/reopen" }, res, "/api/day/2026-10-03/reopen", "POST", user);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/day/:key/reopen админ несуществующий день -> 404", async () => {
  const h = make({ readBody: async () => ({ staffId: "u1" }), isAdmin: () => true });
  const res = {};
  await h({ headers: {}, url: "/api/day/2026-10-03/reopen" }, res, "/api/day/2026-10-03/reopen", "POST", user);
  assert.strictEqual(res._json.status, 404);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", user);
  assert.strictEqual(r, false);
});
