// Юнит-тесты модуля routes/waybill.js — расходные накладные.
const { test } = require("node:test");
const assert = require("node:assert");
const createWaybillHandler = require("../routes/waybill");

function make(ctx) {
  return createWaybillHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], labels: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    parseXlsxItems: () => ({ items: [], buyer: "" }),
    logWaybillScan: () => {},
    artNorm: (a) => String(a || "").toLowerCase(),
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  }, ctx || {}));
}

const user = { id: "u1", name: "Склад" };

function routeWithWb() {
  return {
    id: "r1",
    clients: [{ client: "Клиент А", address: "Ул. 1" }],
    waybills: {
      0: {
        items: [
          { art: "ART-1", name: "Деталь 1", qty: 3, scanned: 0, missing: false },
        ],
      },
    },
  };
}

test("POST /api/waybill/parse без файла распознаёт маршрут (422 по умолчанию не приходит)", async () => {
  const h = make();
  const res = {};
  const r = await h({ headers: {}, url: "/api/waybill/parse" }, res, "/api/waybill/parse", "POST", user, true);
  // маршрут должен быть распознан (не false) — тело обработано модулем
  assert.notStrictEqual(r, false);
});

test("POST /api/waybill/scan не-админ без прав -> обрабатывается/403 при отсутствии allowWaybillPath", async () => {
  const db = { driverRoutes: [routeWithWb()], labels: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ clientIndex: 0, art: "ART-1" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/routes/r1/waybill/scan" }, res, "/api/routes/r1/waybill/scan", "POST", user, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.item.scanned, 1);
  assert.strictEqual(res._json.obj.left, 2);
});

test("unknown route for waybill POST -> 404", async () => {
  const db = { driverRoutes: [], labels: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ clientIndex: 0, art: "ART-1" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/routes/nope/waybill/scan" }, res, "/api/routes/nope/waybill/scan", "POST", user, true);
  assert.strictEqual(res._json.status, 404);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", user, true);
  assert.strictEqual(r, false);
});
