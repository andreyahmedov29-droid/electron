// Тест реальной логики перепривязки этикеток при изменении порядка точек (reorder).
// Проверяет, что боксы/детали «едут» вместе со своим клиентом и НЕ перемешиваются
// между клиентами при перестановке точек маршрута.
const { test } = require("node:test");
const assert = require("node:assert");
const { relinkRouteLabels } = require("../routes/helpers");
const createRouteActionHandler = require("../routes/route-action");

test("relinkRouteLabels переносит этикетку на новую позицию клиента", () => {
  // Исходно: АвтоМ на позиции 0, Рольф на позиции 1.
  // Новый порядок (reorder): Рольф первым, АвтоМ вторым.
  const newOrder = [
    { id: "c2", client: "Рольф", address: "ул. А, 1" },   // новая позиция 0
    { id: "c1", client: "АвтоМ", address: "ул. Б, 2" },   // новая позиция 1
  ];
  const labels = [
    { routeId: "r1", clientIndex: 0, client: "АвтоМ", address: "ул. Б, 2", details: ["A"] },
    { routeId: "r1", clientIndex: 1, client: "Рольф", address: "ул. А, 1", details: ["B"] },
  ];
  relinkRouteLabels("r1", newOrder, labels);
  // АвтоМ (был 0) теперь 1, Рольф (был 1) теперь 0 — индексы переехали вместе
  // со своими клиентами.
  assert.strictEqual(labels[0].clientIndex, 1); // АвтоМ
  assert.strictEqual(labels[1].clientIndex, 0); // Рольф
  // Детали остались у своих клиентов.
  assert.deepStrictEqual(labels[0].details, ["A"]);
  assert.deepStrictEqual(labels[1].details, ["B"]);
});

test("relinkRouteLabels не трогает этикетки чужих маршрутов", () => {
  const labels = [{ routeId: "other", clientIndex: 0, client: "X", address: "ул. З" }];
  relinkRouteLabels("r1", [{ id: "c1", client: "АвтоМ", address: "ул. Б, 2" }], labels);
  assert.strictEqual(labels[0].clientIndex, 0);
});

// Интеграционный сценарий через реальный action "reorder" в route-action.js:
// два перемещаемых pending-клиента меняются местами, этикетки перелинковываются
// реальной relinkRouteLabels, детали остаются при своих клиентах.
test("reorder двух точек: боксы переезжают на новые индексы без смены владельца", async () => {
  const db = {
    params: { allowDriverReorderPoints: true },
    driverRoutes: [{
      id: "r1", driverId: "7", routeName: "М", date: "2026-10-03",
      progress: { status: "active" },
      clients: [
        { id: "c1", client: "АвтоМ", address: "ул. Б, 2", state: "pending" },
        { id: "c2", client: "Рольф", address: "ул. А, 1", state: "pending" },
      ],
    }],
    // Этикетки: деталь «A» у АвтоМ (idx 0), деталь «B» у Рольф (idx 1).
    labels: [
      { code: "BG-r1-1-1", routeId: "r1", clientIndex: 0, client: "АвтоМ", address: "ул. Б, 2", details: ["A"] },
      { code: "BG-r1-2-1", routeId: "r1", clientIndex: 1, client: "Рольф", address: "ул. А, 1", details: ["B"] },
    ],
  };
  // Реальная relinkRouteLabels — НЕ мок.
  const h = createRouteActionHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status) => { res._json = { status }; },
    readBody: async () => ({ routeId: "r1", action: "reorder", order: ["c2", "c1"] }),
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    enrichUnloadProgress: (r) => r,
    relinkRouteLabels,
    canManageShipment: () => false,
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/routes/action" }, res, "/api/drivers/routes/action", "POST", { id: "7", name: "Водитель" }, false);
  assert.strictEqual(res._json.status, 200);

  // Порядок клиентов в маршруте теперь: Рольф (0), АвтоМ (1).
  assert.strictEqual(db.driverRoutes[0].clients[0].id, "c2");
  assert.strictEqual(db.driverRoutes[0].clients[1].id, "c1");
  // Этикетки перелинкованы по ключу клиента:
  const byCode = Object.fromEntries(db.labels.map((l) => [l.code, l]));
  assert.strictEqual(byCode["BG-r1-1-1"].clientIndex, 1); // АвтоМ теперь idx 1
  assert.strictEqual(byCode["BG-r1-2-1"].clientIndex, 0); // Рольф теперь idx 0
  // Детали НЕ поменяли владельца: A осталась на АвтоМ, B — на Рольф.
  assert.deepStrictEqual(byCode["BG-r1-1-1"].details, ["A"]);
  assert.deepStrictEqual(byCode["BG-r1-2-1"].details, ["B"]);
});
