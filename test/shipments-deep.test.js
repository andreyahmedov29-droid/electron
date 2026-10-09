// Глубокие юнит-тесты routes/shipments.js: защита отгрузки, блокировки,
// завершение, самовывоз.
const { test } = require("node:test");
const assert = require("node:assert");
const createShipmentHandler = require("../routes/shipments");

function harness(over, who) {
  const db = { driverRoutes: [], labels: [], params: {} };
  const body = {};
  const h = createShipmentHandler(Object.assign({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    canSeeShipment: () => true,
    canManageShipment: () => true,
    alignWaybillsToClients: (r) => r,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    purgeEmptyBoxes: () => {},
  }, over || {}));
  const user = who || { id: "u1", name: "Склад" };
  const call = async (path, method, payload) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: path }, res, path, method, user, false);
    return res;
  };
  return { h, db, body, call, user };
}

function route(o) {
  return Object.assign({
    id: "r1",
    date: "2026-10-03",
    driverId: "d1",
    driverName: "Водитель",
    progress: { status: "idle" },
    clients: [
      { client: "Клиент А", address: "Ул. 1", labelQty: 2 },
      { client: "Клиент Б", address: "Ул. 2", labelQty: 1 },
    ],
  }, o || {});
}

test("GET /api/shipments возвращает маршруты с количеством мест", async () => {
  const conn = harness();
  conn.db.driverRoutes = [route()];
  conn.db.labels = [
    { routeId: "r1", clientIndex: 0, place: 1, status: "loaded" },
    { routeId: "r1", clientIndex: 0, place: 2, status: "created" },
    { routeId: "r1", clientIndex: 1, place: 1, status: "created" },
  ];
  const res = await conn.call("/api/shipments", "GET");
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.routes.length, 1);
  const cl = res._json.obj.routes[0].clients;
  assert.strictEqual(cl[0].loadedCount, 1);
  assert.strictEqual(cl[0].totalCount, 2);
  assert.strictEqual(cl[1].totalCount, 1);
});

test("complete без оставшихся этикеток завершает отгрузку (shippedAt)", async () => {
  const conn = harness();
  const r = route();
  r.clients.forEach((c) => {
    const q = Number(c.labelQty) || 0;
    for (let i = 1; i <= q; i++) conn.db.labels.push({ routeId: "r1", clientIndex: r.clients.indexOf(c), place: i, status: "loaded" });
  });
  conn.db.driverRoutes = [r];
  const res = await conn.call("/api/shipments/complete", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 200);
  assert.ok(conn.db.driverRoutes[0].progress.shippedAt);
});

test("complete с неотсканированными этикетками и без canManageShipment -> 409", async () => {
  const conn = harness({ canManageShipment: () => false });
  const r = route();
  conn.db.labels.push({ routeId: "r1", clientIndex: 0, place: 1, status: "created" });
  conn.db.driverRoutes = [r];
  const res = await conn.call("/api/shipments/complete", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /Отсканируйте все этикетки/);
});

test("complete с canManageShipment=true пропускает проверку этикеток", async () => {
  const conn = harness({ canManageShipment: () => true });
  const r = route();
  conn.db.labels.push({ routeId: "r1", clientIndex: 0, place: 1, status: "created" });
  conn.db.driverRoutes = [r];
  const res = await conn.call("/api/shipments/complete", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 200);
});

test("complete неизвестный маршрут -> 404", async () => {
  const conn = harness();
  const res = await conn.call("/api/shipments/complete", "POST", { routeId: "nope" });
  assert.strictEqual(res._json.status, 404);
});

test("reopen завершённого водителем маршрута -> 409", async () => {
  const conn = harness();
  conn.db.driverRoutes = [route({ progress: { status: "done" } })];
  const res = await conn.call("/api/shipments/reopen", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /вернуть на отгрузку нельзя/);
});

test("reopen активного (не done) маршрута снимает shippedAt", async () => {
  const conn = harness();
  conn.db.driverRoutes = [route({ progress: { status: "active", shippedAt: 1, shippedBy: "u1" } })];
  const res = await conn.call("/api/shipments/reopen", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(conn.db.driverRoutes[0].progress.shippedAt, undefined);
});

test("start требует накладную на каждого клиента (allowWaybill=true)", async () => {
  const conn = harness();
  conn.db.driverRoutes = [route()];
  conn.db.params.allowWaybill = true;
  // нет waybills -> 409 «Загрузите расходную накладную»
  const res = await conn.call("/api/shipments/start", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /расходную накладную/);
});

test("start с завершёнными накладными и purgeEmptyBoxes -> 200", async () => {
  let purged = 0;
  const conn = harness({ purgeEmptyBoxes: () => { purged++; } });
  const r = route();
  r.waybills = {
    0: { items: [{ art: "A1", qty: 1, scanned: 1 }], finished: true },
    1: { items: [{ art: "B1", qty: 1, scanned: 0, missing: true }], finished: true },
  };
  conn.db.driverRoutes = [r];
  conn.db.params.allowWaybill = true;
  const res = await conn.call("/api/shipments/start", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.ok(conn.db.driverRoutes[0].progress.shipmentStartedAt);
  assert.ok(purged >= 1);
});

test("start с незавершённой накладной (есть остаток) -> 409", async () => {
  const conn = harness();
  const r = route();
  r.waybills = {
    0: { items: [{ art: "A1", qty: 2, scanned: 1, missing: false }], finished: false },
    1: { items: [{ art: "B1", qty: 1, scanned: 1 }], finished: true },
  };
  conn.db.driverRoutes = [r];
  conn.db.params.allowWaybill = true;
  const res = await conn.call("/api/shipments/start", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /не завершена/);
});

test("selfpickup-done не для самовывоза -> 400 и отмечает клиентов как shipped", async () => {
  const conn = harness();
  conn.db.driverRoutes = [route()];
  const res = await conn.call("/api/shipments/selfpickup-done", "POST", { routeId: "r1" });
  assert.strictEqual(res._json.status, 400);
  assert.match(String(res._json.obj.error), /не маршрут самовывоза/);

  const sp = route({ selfPickup: true });
  conn.db.driverRoutes = [sp];
  conn.db.labels.push({ routeId: "r1", clientIndex: 0, place: 1, status: "loaded" });
  const res2 = await conn.call("/api/shipments/selfpickup-done", "POST", { routeId: "r1" });
  assert.strictEqual(res2._json.status, 200);
  assert.strictEqual(sp.progress.status, "done");
  assert.strictEqual(sp.clients[0].state, "shipped");
  assert.strictEqual(conn.db.labels[0].status, "delivered");
});
