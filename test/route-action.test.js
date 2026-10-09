// Юнит-тесты модуля routes/route-action.js — действия водителя по маршруту.
const { test } = require("node:test");
const assert = require("node:assert");
const createRouteActionHandler = require("../routes/route-action");

function make(ctx) {
  return createRouteActionHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [], days: {}, params: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    isAdmin: () => false,
    enrichUnloadProgress: (r) => r,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r, db) => r,
    segmentsFor: () => [],
    allowIncompleteFinish: () => true,
    unloadCounts: (mine) => {
      const total = mine.length;
      const done = mine.filter((l) => l.status === "delivered").length;
      return { total, done };
    },
    relinkRouteLabels: () => {},
  }, ctx || {}));
}

function routeWithPending() {
  return {
    id: "r1",
    date: "2026-10-03",
    driverId: "d1",
    progress: { status: "active", shippedAt: 1 },
    clients: [
      { id: "c1", state: "pending", address: "Ул. 1" },
      { id: "c2", state: "pending", address: "Ул. 2" },
    ],
  };
}

const driver = { id: "d1", name: "Водитель" };

test("POST /api/drivers/routes/action start переводит маршрут в active", async () => {
  const db = { driverRoutes: [routeWithPending()], labels: [], days: {}, params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", action: "start" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/action" }, res, "/api/drivers/routes/action", "POST", driver, false);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].progress.status, "active");
});

test("POST /api/drivers/routes/action неизвестный маршрут -> 404", async () => {
  const h = make({ readBody: async () => ({ routeId: "nope", action: "start" }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/action" }, res, "/api/drivers/routes/action", "POST", driver, false);
  assert.strictEqual(res._json.status, 404);
});

test("POST /api/drivers/routes/action не владелец и не админ -> 403", async () => {
  const db = { driverRoutes: [routeWithPending()], labels: [], days: {}, params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", action: "start" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/action" }, res, "/api/drivers/routes/action", "POST", { id: "other" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("неизвестная action -> 400", async () => {
  const db = { driverRoutes: [routeWithPending()], labels: [], days: {}, params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", action: "fly" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/action" }, res, "/api/drivers/routes/action", "POST", driver, false);
  assert.strictEqual(res._json.status, 400);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", driver, false);
  assert.strictEqual(r, false);
});
