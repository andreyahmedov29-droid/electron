// Юнит-тесты модуля routes/driver-routes.js — маршруты водителя (GET + check).
const { test } = require("node:test");
const assert = require("node:assert");
const createDriverRoutesHandler = require("../routes/driver-routes");

function make(ctx) {
  return createDriverRoutesHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    isDriver: () => true,
    namesMatch: (a, b) => a === b,
    enrichUnloadProgress: (r) => r,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    routeKmCache: {},
    routeKmRoad: () => Promise.resolve(null),
    routeKm: () => 0,
    routeKmPending: {},
  }, ctx || {}));
}

test("GET /api/drivers/routes не-водитель и не-админ -> 403", async () => {
  const h = make({ isDriver: () => false });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "GET", { id: "1" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/routes водитель видит свои маршруты", async () => {
  const db = { driverRoutes: [{ id: "r1", driverId: "7", routeName: "М" }], labels: [] };
  const h = make({ getDb: () => db, isDriver: () => true });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "GET", { id: "7", name: "Иван" }, false);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.routes.length, 1);
});

test("GET /api/drivers/routes админ видит все", async () => {
  const db = { driverRoutes: [{ id: "r1", driverId: "1", routeName: "М" }], labels: [] };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.routes.length, 1);
});

test("POST /api/drivers/routes/check находит пересечения", async () => {
  const db = { driverRoutes: [{ id: "r1", date: "2026-10-03", driverId: "7", routeName: "М", clients: [{ client: "АвтоМ" }] }] };
  const h = make({ getDb: () => db, readBody: async () => ({ date: "2026-10-03", driverId: "7", clientNames: ["АвтоМ", "Рольф"] }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/check" }, res, "/api/drivers/routes/check", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.intersections.length, 1);
  assert.strictEqual(res._json.obj.intersections[0].clientName, "АвтоМ");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { id: "1" }, true);
  assert.strictEqual(r, false);
});
