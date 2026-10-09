// Юнит-тесты модуля routes/system.js — системные маршруты.
const { test } = require("node:test");
const assert = require("node:assert");
const createSystemHandler = require("../routes/system");

function make(ctx) {
  return createSystemHandler(Object.assign({
    getDb: () => ({ log: [], lastSeen: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    isAdmin: () => true,
    isModerator: () => false,
    liveRows: () => [],
  }, ctx || {}));
}

const user = { id: "u1", name: "Петя" };

test("POST /api/log добавляет запись в журнал", async () => {
  const db = { log: [], lastSeen: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ action: "login" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/log" }, res, "/api/log", "POST", user);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.log.length, 1);
});

test("POST /api/heartbeat обновляет lastSeen", async () => {
  const db = { log: [], lastSeen: {} };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/heartbeat" }, res, "/api/heartbeat", "POST", user);
  assert.strictEqual(res._json.status, 200);
  assert.ok(db.lastSeen["u1"]);
});

test("GET /api/live не-модератор/админ -> 403", async () => {
  const h = make({ isAdmin: () => false });
  const res = {};
  await h({ headers: {}, url: "/api/live" }, res, "/api/live", "GET", user, false);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/log/clear не-админ -> 403", async () => {
  const h = make({ isAdmin: () => false });
  const res = {};
  await h({ headers: {}, url: "/api/log/clear" }, res, "/api/log/clear", "POST", user, false);
  assert.strictEqual(res._json.status, 403);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", user);
  assert.strictEqual(r, false);
});
