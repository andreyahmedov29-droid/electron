// Юнит-тесты модуля routes/route-create.js — создание/настройка маршрутов.
const { test } = require("node:test");
const assert = require("node:assert");
const createRouteCreateHandler = require("../routes/route-create");

function make(ctx) {
  return createRouteCreateHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], driverClients: [], labels: [], params: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    routeKmCache: {},
    routeKmPending: {},
    normalizeRouteClient: (c) => c,
    routeLockReason: (p) => "маршрут занят",
    autoPullWaybillsFrom1c: async () => {},
    relinkRouteLabels: () => {},
    canManageShipment: () => true,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    ensureClientCoords: async () => {},
    geocodeAddress: async () => null,
    gisDurationMatrix: async () => null,
    tomtomDurationMatrix: async () => null,
    osrmDurationMatrix: async () => null,
    nearestByTime: () => [],
    nearestNeighbor: () => [],
    gisDistanceMatrix: async () => null,
    haversineKm: () => 5,
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("POST /api/drivers/routes создаёт маршрут", async () => {
  const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({
      date: "2026-10-03",
      driverId: "d1",
      driverName: "Водитель",
      routeName: "Утренний",
      clients: [{ client: "Клиент А", address: "Ул. 1" }],
    }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.routes.length, 1);
  assert.strictEqual(res._json.obj.routes[0].routeName, "Утренний");
});

test("POST /api/drivers/routes сохраняет партисткер в накладную (autoPull из 1С)", async () => {
  const db = { driverRoutes: [], driverClients: [{ client: "Клиент А", inn: "7701234567", login: "X" }], labels: [], params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({
      date: "2026-10-03",
      driverId: "d1",
      driverName: "Водитель",
      routeName: "Утренний",
      clients: [{ client: "Клиент А", address: "Ул. 1" }],
    }),
    autoPullWaybillsFrom1c: async (clients, arr) => {
      // Имитируем реальный ответ 1С: позиция с partsticker/partQty.
      arr.push({
        clientIndex: 0,
        items: [{ art: "5825437000", name: "ФОРСУНКА", qty: 4, scanned: 0, partsticker: "000000000020217/2", partQty: 1 }],
      });
    },
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "POST", admin, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  const r = db.driverRoutes[0];
  assert.ok(r.waybills && r.waybills[0] && r.waybills[0].items[0], "накладная создана");
  assert.strictEqual(r.waybills[0].items[0].partsticker, "000000000020217/2", "партисткер сохранён в накладную");
  assert.strictEqual(r.waybills[0].items[0].partQty, 1);
});

test("POST /api/drivers/routes без названия -> 400", async () => {
  const h = make({
    readBody: async () => ({ date: "2026-10-03", driverId: "d1", clients: [] }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "POST", admin, true);
  assert.strictEqual(res._json.status, 400);
});

test("POST /api/drivers/routes не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "POST", { id: "u1" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/drivers/routes delete удаляет маршрут", async () => {
  const db = {
    driverRoutes: [{ id: "r1", progress: {}, clients: [] }],
    driverClients: [],
    labels: [],
    params: {},
  };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ action: "delete", id: "r1" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes" }, res, "/api/drivers/routes", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.routes.length, 0);
});

test("POST /api/routes/unlock неизвестный маршрут -> 404", async () => {
  const h = make({ readBody: async () => ({ routeId: "nope" }) });
  const res = {};
  await h({ headers: {}, url: "/api/routes/unlock" }, res, "/api/routes/unlock", "POST", admin, true);
  assert.strictEqual(res._json.status, 404);
});

test("POST /api/drivers/routes/optimize без клиентов -> 400", async () => {
  const h = make({ readBody: async () => ({ clientIds: [] }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/optimize" }, res, "/api/drivers/routes/optimize", "POST", admin, true);
  assert.strictEqual(res._json.status, 400);
});

test("POST /api/drivers/route-km с одной точкой -> empty", async () => {
  const h = make({ readBody: async () => ({ points: [{ lat: 55, lon: 37 }] }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/route-km" }, res, "/api/drivers/route-km", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.method, "empty");
});

test("POST /api/routes/r1/fill-from-1c заполняет накладные клиентов из 1С", async () => {
  const db = {
    driverRoutes: [{ id: "r1", clients: [{ client: "Клиент А" }], waybills: {} }],
    driverClients: [{ client: "Клиент А", inn: "7701234567", login: "X" }],
    labels: [],
    params: {},
  };
  const h = make({
    getDb: () => db,
    autoPullWaybillsFrom1c: async (clients, arr) => {
      arr.push({ clientIndex: 0, items: [{ art: "TZ1", name: "Деталь", qty: 1, scanned: 0, missing: false }], buyer: "00УТ-0004386" });
    },
  });
  const res = {};
  await h({ headers: {}, url: "/api/routes/r1/fill-from-1c" }, res, "/api/routes/r1/fill-from-1c", "POST", admin, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.filled, 1);
  assert.strictEqual(res._json.obj.skipped, 0);
  assert.strictEqual(res._json.obj.noInn, 0);
  assert.ok(db.driverRoutes[0].waybills[0], "накладная записана в маршрут");
});

test("POST /api/routes/r1/fill-from-1c не-админ -> 403", async () => {
  const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
  const h = make({ getDb: () => db, canManageShipment: () => false });
  const res = {};
  await h({ headers: {}, url: "/api/routes/r1/fill-from-1c" }, res, "/api/routes/r1/fill-from-1c", "POST", admin, true);
  assert.strictEqual(res._json.status, 403);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
