// Юнит-тесты модуля routes/motion.js — дашборд движения водителей.
const { test } = require("node:test");
const assert = require("node:assert");
const createMotionHandler = require("../routes/motion");

function make(ctx) {
  return createMotionHandler(Object.assign({
    getDb: () => ({ driverRoutes: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    withResolvedBundleNames: (r) => r,
    haversineKm: () => 10,
    motionDayKey: () => "2026-10-03",
    tracksByDay: {},
  }, ctx || {}));
}

test("GET /api/drivers/motion не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/motion" }, res, "/api/drivers/motion", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/motion без маршрутов -> пустой список", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/motion" }, res, "/api/drivers/motion", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.rows, []);
});

test("GET /api/drivers/motion суммирует километраж и время", async () => {
  const route = {
    id: "r1", date: "2026-10-03", driverId: "7", driverName: "Иван", routeName: "Маршрут 1",
    progress: { status: "done", baseLat: 55.6, baseLon: 37.5 },
    clients: [{
      client: "АвтоМ", lat: 55.7, lon: 37.6, state: "delivered",
      transitStart: 1000, transitEnd: 101000, transitPaused: 0,
      siteStart: 200000, siteEnd: 300000,
    }],
  };
  const h = make({ getDb: () => ({ driverRoutes: [route] }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/motion?date=2026-10-03" }, res, "/api/drivers/motion", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1);
  const row = res._json.obj.rows[0];
  assert.strictEqual(row.name, "Иван");
  // путь база→клиент→база = 2 сегмента по 10 км
  assert.strictEqual(row.km, 20);
  // moveSec — миллисекунды в секунды: 100000 мс = 100 с
  assert.strictEqual(row.moveSec, 100);
  assert.strictEqual(row.siteSec, 100);
  assert.strictEqual(row.routes.length, 1);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", true);
  assert.strictEqual(r, false);
});
