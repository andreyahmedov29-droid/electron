// Тесты создания маршрута с «прогрузкой из 1С» (routes/route-create.js):
// POST /api/drivers/routes + autoPullWaybillsFrom1c. Проверяем сотни сценариев
// переноса накладных: сохранение партистекеров, стакание нескольких накладных
// одного клиента, отсутствие ИНН, разные количества клиентов/порций и т.п.
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

async function createRoute(ctx, db, clients) {
  const h = make(Object.assign({ getDb: () => db }, ctx || {}));
  const res = {};
  await h(
    { headers: {}, url: "/api/drivers/routes" },
    res, "/api/drivers/routes", "POST", admin, true
  );
  return { res, db };
}

// -------- N клиентов, у каждого накладная из 1С с партисткером ------------
for (let n = 1; n <= 30; n++) {
  test(`создание маршрута: ${n} клиентов, у каждого накладная с партисткером`, async () => {
    const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
    const clients = [];
    for (let i = 0; i < n; i++) clients.push({ client: `Клиент ${i}`, address: `Ул ${i}`, inn: `7701${String(i).padStart(6, "0")}`, login: "LOG" });
    const { res, db: d } = await createRoute({
      readBody: async () => ({ date: "2026-10-03", driverId: "d1", driverName: "В", routeName: "R", clients, clientNames: [] }),
      autoPullWaybillsFrom1c: async (clientsArr, arr) => {
        clientsArr.forEach((c, i) => {
          arr.push({ clientIndex: i, items: [{ art: `ART${i}`, name: "Деталь", qty: 1, scanned: 0, partsticker: `0001/${i}`, partQty: 1 }] });
        });
      },
    }, db, clients);
    assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
    const r = d.driverRoutes[0];
    assert.ok(r.waybills, "накладные созданы");
    assert.strictEqual(Object.keys(r.waybills).length, n);
    for (let i = 0; i < n; i++) {
      assert.ok(r.waybills[i] && r.waybills[i].items[0], "накладная клиента сохранена");
      assert.strictEqual(r.waybills[i].items[0].partsticker, `0001/${i}`, "партисткер сохранён");
      assert.strictEqual(r.waybills[i].items[0].partQty, 1);
    }
  });
}

// -------- Множественные накладные одного клиента (СТАКАНИЕ) ------------
for (let k = 1; k <= 10; k++) {
  test(`создание маршрута: ${k} накладных одного клиента стакаются (все позиции сохраняются)`, async () => {
    const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
    const { res, db: d } = await createRoute({
      readBody: async () => ({ date: "2026-10-03", driverId: "d1", driverName: "В", routeName: "R", clients: [{ client: "Клиент 1", address: "Ул 1", inn: "7701000000", login: "LOG" }], clientNames: [] }),
      autoPullWaybillsFrom1c: async (clientsArr, arr) => {
        for (let j = 0; j < k; j++) {
          arr.push({ clientIndex: 0, items: [{ art: `ART${j}`, name: "Деталь", qty: 1, scanned: 0, partsticker: `0001/${j}`, partQty: 1 }] });
        }
      },
    }, db);
    assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
    const wb = d.driverRoutes[0].waybills && d.driverRoutes[0].waybills["0"];
    assert.ok(wb, "накладная создана");
    assert.strictEqual(wb.items.length, k, `ожидается ${k} позиций (все накладные стаканы)`);
  });
}

// -------- Без ИНН / путой ответ 1С: накладная не появляется ------------
for (let n = 1; n <= 10; n++) {
  test(`создание маршрута: клиенты без ИНН и пустой ответ 1С (${n} шт)`, async () => {
    const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
    const clients = [];
    for (let i = 0; i < n; i++) clients.push({ client: `Клиент ${i}`, address: `Ул ${i}` }); // без ИНН
    const { res, db: d } = await createRoute({
      readBody: async () => ({ date: "2026-10-03", driverId: "d1", driverName: "В", routeName: "R", clients, clientNames: [] }),
      autoPullWaybillsFrom1c: async () => {}, // 1С ничего не отдала
    }, db, clients);
    assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
    assert.ok(!d.driverRoutes[0].waybills || Object.keys(d.driverRoutes[0].waybills).length === 0, "накладных нет");
  });
}

// -------- Разные количества порций в нескольких накладных ------------
for (let n = 1; n <= 15; n++) {
  test(`создание маршрута: у клиента ${n} порций (артикул, quantity=1 каждая)`, async () => {
    const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
    const { res, db: d } = await createRoute({
      readBody: async () => ({ date: "2026-10-03", driverId: "d1", driverName: "В", routeName: "R", clients: [{ client: "Клиент 1", address: "Ул 1", inn: "7701000000", login: "LOG" }], clientNames: [] }),
      autoPullWaybillsFrom1c: async (clientsArr, arr) => {
        const items = [];
        for (let i = 0; i < n; i++) items.push({ art: "ART1", name: "Деталь", qty: 1, scanned: 0, partsticker: `0001/${i}`, partQty: 1 });
        arr.push({ clientIndex: 0, items });
      },
    }, db);
    assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
    const wb = d.driverRoutes[0].waybills["0"];
    assert.strictEqual(wb.items.length, n, `${n} порций сохранено`);
    assert.strictEqual(wb.items[0].partsticker, "0001/0");
  });
}

// Кейс «связка 6 клиентов на одном адресе»: для каждого грузится СВОЯ накладная.
// Сервер должен сохранить каждую накладную у своего клиента (clientIndex) и НЕ
// задублировать позиции между клиентами — в сумме ровно по одному разу на каждую.
for (const N of [6, 3, 10]) {
  test(`создание маршрута: связка из ${N} клиентов на одном адресе, у каждого своя накладная — каждая у своего clientIndex, позиции не задвоены`, async () => {
    const db = { driverRoutes: [], driverClients: [], labels: [], params: {} };
    const clients = [];
    const waybills = [];
    for (let i = 0; i < N; i++) {
      clients.push({ client: `Клиент ${i}`, address: "Ул 1", bundleName: "Связка", inn: `7701${String(i).padStart(6, "0")}` });
      waybills.push({ clientIndex: i, items: [{ art: `ART${i}`, name: "Деталь", qty: 1, scanned: 0 }] });
    }
    const { res, db: d } = await createRoute({
      readBody: async () => ({ date: "2026-10-03", driverId: "d1", driverName: "В", routeName: "R", clients, waybills, clientNames: [] }),
      autoPullWaybillsFrom1c: async () => {}, // 1С отдаёт — берём из загруженных файлов
    }, db, clients);
    assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
    const wbs = d.driverRoutes[0].waybills;
    assert.ok(wbs, "накладные созданы");
    // У каждого клиента своя накладная с ровно своей позицией (по одному разу).
    let total = 0;
    for (let i = 0; i < N; i++) {
      assert.ok(wbs[i], `накладная клиента ${i} сохранена`);
      assert.strictEqual(wbs[i].items.length, 1, `у клиента ${i} ровно 1 позиция`);
      assert.strictEqual(wbs[i].items[0].art, `ART${i}`, `позиция принадлежит своему клиенту`);
      total += wbs[i].items.length;
    }
    assert.strictEqual(total, N, `всего позиций = числу клиентов (по одному разу, без ×N)`);
  });
}
