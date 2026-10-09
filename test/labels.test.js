// Юнит-тесты модуля routes/labels.js — этикетки отгрузки и скан мест.
const { test } = require("node:test");
const assert = require("node:assert");
const createLabelsHandler = require("../routes/labels");

function make(ctx) {
  return createLabelsHandler(Object.assign({
    getDb: () => ({ labels: [], driverRoutes: [], scanLog: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({ defaultBody: true }),
    persistDb: async () => {},
    canSeeShipment: () => true,
    isDriver: () => false,
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };
const route = {
  id: "r1",
  clients: [{ client: "Клиент А", address: "Ул. 1", labelQty: 2 }],
};

test("POST /api/labels создаёт этикетки для клиента", async () => {
  const db = { labels: [], driverRoutes: [route], scanLog: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", clientIndex: 0, qty: 2 }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/labels" }, res, "/api/labels", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.labels.length, 2);
  assert.strictEqual(res._json.obj.labels[0].code, "BGr1-1-1");
  assert.strictEqual(db.labels.length, 2);
});

test("POST /api/labels append допечатывает сверх существующих", async () => {
  const db = {
    labels: [{ id: "x", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1 }],
    driverRoutes: [route],
    scanLog: [],
  };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ routeId: "r1", clientIndex: 0, qty: 1, mode: "append" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/labels" }, res, "/api/labels", "POST", admin, true);
  assert.strictEqual(res._json.obj.labels.length, 2);
  assert.strictEqual(res._json.obj.labels[1].code, "BGr1-1-2");
});

test("DELETE /api/labels/:id удаляет только созданную", async () => {
  const db = {
    labels: [{ id: "L1", code: "BGr1-1-1", status: "created" }],
    driverRoutes: [],
    scanLog: [],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/labels/L1" }, res, "/api/labels/L1", "DELETE", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.labels.length, 0);
});

test("DELETE /api/labels/:id отсканированную не удаляет (409)", async () => {
  const db = {
    labels: [{ id: "L1", code: "BGr1-1-1", status: "loaded" }],
    driverRoutes: [],
    scanLog: [],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/labels/L1" }, res, "/api/labels/L1", "DELETE", admin, true);
  assert.strictEqual(res._json.status, 409);
  assert.strictEqual(db.labels.length, 1);
});

test("POST /api/labels/scan load меняет статус на loaded", async () => {
  const db = {
    labels: [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, status: "created" }],
    driverRoutes: [route],
    scanLog: [],
  };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ code: "BGr1-1-1", action: "load" }),
    persistDb: async () => {},
  });
  const res = {};
  await h({ headers: {}, url: "/api/labels/scan" }, res, "/api/labels/scan", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.label.status, "loaded");
  assert.strictEqual(db.scanLog.length, 1);
});

test("GET /api/labels фильтрует по routeId и clientIndex", async () => {
  const db = {
    labels: [
      { id: "L1", routeId: "r1", clientIndex: 0, code: "a" },
      { id: "L2", routeId: "r1", clientIndex: 1, code: "b" },
      { id: "L3", routeId: "r2", clientIndex: 0, code: "c" },
    ],
    driverRoutes: [],
    scanLog: [],
  };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {}, url: "/api/labels?routeId=r1&clientIndex=0" }, res, "/api/labels", "GET", admin, true);
  assert.strictEqual(res._json.obj.labels.length, 1);
  assert.strictEqual(res._json.obj.labels[0].id, "L1");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
