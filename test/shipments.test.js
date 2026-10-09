// Юнит-тесты модуля routes/shipments.js — отгрузка маршрутов.
const { test } = require("node:test");
const assert = require("node:assert");
const createShipmentHandler = require("../routes/shipments");

function make(ctx) {
  return createShipmentHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [] }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    canSeeShipment: () => true,
    canManageShipment: () => true,
    alignWaybillsToClients: (r) => r,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    purgeEmptyBoxes: () => {},
  }, ctx || {}));
}

test("GET /api/shipments не-склад -> 403", async () => {
  const h = make({ canSeeShipment: () => false });
  const res = {};
  await h({ headers: {} }, res, "/api/shipments", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/shipments админ -> список маршрутов", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/shipments", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.ok(Array.isArray(res._json.obj.routes));
});

test("GET /api/shipments дообогащает позиции партисткером из журнала 1С", async () => {
  const db = {
    driverRoutes: [{ id: "r1", waybills: { 0: { items: [{ art: "5825437000", qty: 1, scanned: 0 }] } } }],
    labels: [],
  };
  const h = make({
    getDb: () => db,
    getOnecPullLog: () => [{
      ts: Date.now(), items: [{ art: "5825437000", partsticker: "000000000020230/1", partQty: 1 }],
    }],
  });
  const res = {};
  await h({ headers: {} }, res, "/api/shipments", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  const it = res._json.obj.routes[0].waybills[0].items[0];
  assert.strictEqual(it.partsticker, "000000000020230/1");
  assert.strictEqual(it.partQty, 1);
});

test("POST /api/shipments/complete помечает shippedAt", async () => {
  const route = { id: "r1", progress: { status: "idle" } };
  const db = { driverRoutes: [route], labels: [] };
  const h = make({ getDb: () => db, readBody: async () => ({ routeId: "r1" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/shipments/complete", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.ok(Number.isFinite(route.progress.shippedAt));
});

test("POST /api/shipments/reopen снимает shippedAt", async () => {
  const route = { id: "r1", progress: { status: "idle", shippedAt: 123 } };
  const db = { driverRoutes: [route] };
  const h = make({ getDb: () => db, readBody: async () => ({ routeId: "r1" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/shipments/reopen", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(route.progress.shippedAt, undefined);
});

test("POST /api/shipments/selfpickup-done завершает маршрут", async () => {
  const route = { id: "r1", selfPickup: true, clients: [{ client: "К" }], progress: { status: "idle" } };
  const db = { driverRoutes: [route], labels: [] };
  const h = make({ getDb: () => db, readBody: async () => ({ routeId: "r1" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/shipments/selfpickup-done", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(route.progress.status, "done");
  assert.strictEqual(route.clients[0].state, "shipped");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { id: "1" }, true);
  assert.strictEqual(r, false);
});
