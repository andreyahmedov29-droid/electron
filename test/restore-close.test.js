// Юнит-тесты модуля routes/restore-close.js — восстановление офлайн-закрытий.
const { test } = require("node:test");
const assert = require("node:assert");
const createRestoreCloseHandler = require("../routes/restore-close");

function make(ctx) {
  return createRestoreCloseHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [], scanLog: [], params: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("POST /api/admin/restore-client-close без routeId и search -> 422", async () => {
  const h = make({ readBody: async () => ({}) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/restore-client-close" }, res, "/api/admin/restore-client-close", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("POST /api/admin/restore-client-close не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/admin/restore-client-close" }, res, "/api/admin/restore-client-close", "POST", { id: "u" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/admin/restore-client-close неизвестный маршрут -> 404", async () => {
  const h = make({ readBody: async () => ({ routeId: "nope" }) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/restore-client-close" }, res, "/api/admin/restore-client-close", "POST", admin, true);
  assert.strictEqual(res._json.status, 404);
});

test("POST /api/admin/restore-client-close закрывает точку маршрута", async () => {
  const db = {
    driverRoutes: [{ id: "r1", clients: [{ client: "К", address: "Адр", id: "c1", state: "in_transit" }] }],
    labels: [],
    scanLog: [],
    params: {},
  };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", clientIndex: 0, places: 1 }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/admin/restore-client-close" }, res, "/api/admin/restore-client-close", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].clients[0].state, "delivered");
  assert.strictEqual(db.labels.length, 1);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
