// Глубокие юнит-тесты routes/labels.js: авто-воссоздание этикеток, дубли-сканы,
// предупреждения, блокировка погрузки пустого бокса, защита «сначала соберите».
const { test } = require("node:test");
const assert = require("node:assert");
const createLabelsHandler = require("../routes/labels");

function harness(over, userOverride) {
  let db = over && over.db ? over.db : { labels: [], driverRoutes: [], scanLog: [] };
  const seenPersist = { called: 0 };
  const bodyRef = {};
  const h = createLabelsHandler(Object.assign({
    getDb: () => db,
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => bodyRef,
    persistDb: async () => { seenPersist.called++; },
    canSeeShipment: () => true,
    isDriver: () => true,
  }, over ? over.cfg : {}));
  const user = userOverride || { id: "u1", name: "Сотрудник" };
  return {
    h, db, bodyRef, user, seenPersist,
    scan: async (payload, who) => {
      Object.assign(bodyRef, payload);
      const res = {};
      await h({ headers: {}, url: "/api/labels/scan" }, res, "/api/labels/scan", "POST", who || user, true);
      return res;
    },
  };
}

function route(obj) {
  return Object.assign({
    id: "r1",
    clients: [
      { client: "Клиент А", address: "Ул. 1", labelQty: 3 },
      { client: "Клиент Б", address: "Ул. 2", labelQty: 1 },
    ],
  }, obj || {});
}

test("скан несуществующей этикетки авто-воссоздаёт её по коду BG<routeId>-<c>-<place>", async () => {
  const r = route();
  const conn = harness({ db: { labels: [], driverRoutes: [r], scanLog: [] } });
  // Сканируем BGr1-1-2, которой нет в labels -> должно авто-создаться место 2.
  const res = await conn.scan({ code: "BGr1-1-2", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
  // labelQty=3 -> созданы места 1..3, но найдено именно место 2.
  assert.strictEqual(conn.db.labels.length, 3);
  const place2 = conn.db.labels.find((l) => l.code === "BGr1-1-2");
  assert.strictEqual(place2.status, "loaded");
});

test("скан места вне labelQty расширяет labelQty", async () => {
  const r = route();
  const conn = harness({ db: { labels: [], driverRoutes: [r], scanLog: [] } });
  // место 9 больше labelQty=3 -> создаётся и labelQty поднимается до 9
  const res = await conn.scan({ code: "BGr1-1-9", action: "load" });
  assert.strictEqual(res._json.status, 200);
  assert.ok(conn.db.labels.some((l) => l.code === "BGr1-1-9"));
  assert.strictEqual(r.clients[0].labelQty, 9);
});

test("скан вне маршрута -> 404 «Этикетка не найдена»", async () => {
  const conn = harness({ db: { labels: [], driverRoutes: [route()], scanLog: [] } });
  const res = await conn.scan({ code: "XXXX-1", action: "load" });
  assert.strictEqual(res._json.status, 404);
  assert.match(String(res._json.obj.error), /не найдена/);
});

test("погрузка повторно -> предупреждение и НЕ пишется второй скан в журнал", async () => {
  const r = route();
  const labels = [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "created", client: "Клиент А", address: "Ул. 1" }];
  const conn = harness({ db: { labels, driverRoutes: [r], scanLog: [] } });
  await conn.scan({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(conn.db.scanLog.length, 1, "первый скан пишется в журнал");
  const res2 = await conn.scan({ code: "BGr1-1-1", action: "load" });
  // повторный «пик» сканера -> статус уже loaded, warning, новый лог НЕ добавляется
  assert.strictEqual(res2._json.obj.warning, "Место уже погружено");
  assert.strictEqual(conn.db.scanLog.length, 1, "дубль не пишется в журнал");
});

test("погрузка бокса без собранных деталей -> 409", async () => {
  const r = route();
  r.waybills = {
    0: { items: [ { art: "A1", qty: 1, scanned: 0, box: "BGr1-1-1" } ] },
  };
  const labels = [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "created", client: "Клиент А", address: "Ул. 1" }];
  const conn = harness({ db: { labels, driverRoutes: [r], scanLog: [] } });
  // в боксе есть строки накладной, но scanned=0 (ничего не собрано) -> 409
  const res = await conn.scan({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /собранных деталей/);
});

test("погрузка бокса с собранными деталями проходит", async () => {
  const r = route();
  r.waybills = {
    0: { items: [ { art: "A1", qty: 1, scanned: 1, box: "BGr1-1-1" } ] },
  };
  const labels = [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "created", client: "Клиент А", address: "Ул. 1" }];
  const conn = harness({ db: { labels, driverRoutes: [r], scanLog: [] } });
  const res = await conn.scan({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(conn.db.labels[0].status, "loaded");
});

test("выгрузка не погруженного места -> предупреждение, статус не меняется", async () => {
  const labels = [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "created", client: "Клиент А", address: "Ул. 1" }];
  const conn = harness({ db: { labels, driverRoutes: [route()], scanLog: [] } });
  const res = await conn.scan({ code: "BGr1-1-1", action: "unload" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.warning, "Место ещё не погружено (выгружать рано)");
  assert.strictEqual(conn.db.labels[0].status, "created");
});

test("выгрузка погруженного места -> delivered + запись в журнал", async () => {
  const labels = [{ id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "loaded", client: "Клиент А", address: "Ул. 1" }];
  const conn = harness({ db: { labels, driverRoutes: [route()], scanLog: [] } });
  const res = await conn.scan({ code: "BGr1-1-1", action: "unload" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(conn.db.labels[0].status, "delivered");
  assert.strictEqual(conn.db.scanLog.length, 1);
  assert.strictEqual(conn.db.scanLog[0].action, "unload");
});
