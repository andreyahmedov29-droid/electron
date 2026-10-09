// Юнит-тесты модуля routes/scanlog.js — журнал сканирования мест.
const { test } = require("node:test");
const assert = require("node:assert");
const createScanlogHandler = require("../routes/scanlog");

function make(ctx) {
  return createScanlogHandler(Object.assign({
    getDb: () => ({ scanLog: [], labels: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
  }, ctx || {}));
}

test("GET /api/scanlog пустой -> 200, entries []", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/scanlog" }, res, "/api/scanlog", "GET");
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.entries, []);
});

test("GET /api/scanlog фильтрует по action=load", async () => {
  const db = {
    scanLog: [
      { code: "BG-r1-1-1", action: "load", routeId: "r1" },
      { code: "BG-r1-1-2", action: "unload", routeId: "r1" },
    ],
    labels: [{ routeId: "r1", clientIndex: 0 }],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/scanlog?action=load&limit=10" }, res, "/api/scanlog", "GET");
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.entries.length, 1);
  assert.strictEqual(res._json.obj.entries[0].action, "load");
});

test("GET /api/scanlog обогащает место и totalPlaces из кода", async () => {
  const db = {
    scanLog: [{ code: "BG-route-1-1", action: "load", routeId: "route" }],
    labels: [{ routeId: "route", clientIndex: 0 }, { routeId: "route", clientIndex: 0 }],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/scanlog" }, res, "/api/scanlog", "GET");
  assert.strictEqual(res._json.obj.entries.length, 1);
  assert.strictEqual(res._json.obj.entries[0].place, 1);
  assert.strictEqual(res._json.obj.entries[0].totalPlaces, 2);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET");
  assert.strictEqual(r, false);
});
