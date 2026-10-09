// Юнит-тесты модуля routes/deliveries.js — раздел «Доставка».
const { test } = require("node:test");
const assert = require("node:assert");
const createDeliveriesHandler = require("../routes/deliveries");

function make(ctx) {
  return createDeliveriesHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
  }, ctx || {}));
}

test("GET /api/deliveries без user -> 401", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/deliveries" }, res, "/api/deliveries", "GET", null);
  assert.strictEqual(res._json.status, 401);
});

test("GET /api/deliveries без даты -> все маршруты", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/deliveries" }, res, "/api/deliveries", "GET", { id: "u1" });
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.deliveries, []);
});

test("GET /api/deliveries?date фильтрует по дате", async () => {
  const db = {
    driverRoutes: [
      { id: "r1", date: "2026-10-03", clients: [] },
      { id: "r2", date: "2026-10-04", clients: [] },
    ],
    labels: [],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/deliveries?date=2026-10-03" }, res, "/api/deliveries", "GET", { id: "u1" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.deliveries.length, 1);
  assert.strictEqual(res._json.obj.deliveries[0].routeId, "r1");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { id: "u1" });
  assert.strictEqual(r, false);
});
