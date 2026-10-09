// Глубокие юнит-тесты routes/route-action.js: полный жизненный цикл маршрута,
// обед, выгрузка, перенос, переупорядочивание. Ищут ошибки в стадийной машине
// и в работе с состоянием точек.
const { test } = require("node:test");
const assert = require("node:assert");
const createRouteActionHandler = require("../routes/route-action");

const driver = { id: "d1", name: "Водитель" };
const driverB = { id: "d2", name: "Водитель 2" };

function baseRoute(o) {
  return Object.assign({
    id: "r1",
    date: "2026-10-03",
    driverId: "d1",
    progress: { status: "active", shippedAt: 1 },
    clients: [
      { id: "c1", state: "pending", address: "Ул. 1" },
      { id: "c2", state: "pending", address: "Ул. 2" },
    ],
  }, o || {});
}

function freshDb(routeObj) {
  return { driverRoutes: [routeObj || baseRoute()], labels: [], days: {}, params: {} };
}

// Создаёт хендлер + общий объект-тело + замыкание actLocal(action, extra) для маршрута r1.
// harness({ route, over }) — route: свой объект маршрута; over: переопределения DI.
function harness(opts) {
  const { route: routeObj, over } = opts || {};
  const db = freshDb(routeObj);
  const body = {};
  const cfg = Object.assign({
    getDb: () => db,
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    persistDb: async () => {},
    isAdmin: () => false,
    enrichUnloadProgress: (r) => r,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    segmentsFor: () => [],
    allowIncompleteFinish: () => false,
    unloadCounts: (mine) => {
      const total = mine.length;
      const done = mine.filter((l) => l.status === "delivered").length;
      return { total, done };
    },
    relinkRouteLabels: () => {},
  }, over || {});
  const h = createRouteActionHandler(cfg);
  const actLocal = async (action, extra, who) => {
    body.routeId = "r1";
    body.action = action;
    if (extra) Object.assign(body, extra);
    const res = {};
    await h({ headers: {} }, res, "/api/drivers/routes/action", "POST", who || driver, false);
    return res;
  };
  return { h, body, db, actLocal };
}

test("полный цикл start->arrive->deliver->arrive_base закрывает маршрут", async () => {
  const { db, actLocal } = harness();
  let res = await actLocal("start");
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].progress.status, "active");
  assert.strictEqual(db.driverRoutes[0].clients[0].state, "in_transit");
  res = await actLocal("arrive");
  assert.strictEqual(db.driverRoutes[0].clients[0].state, "on_site");
  res = await actLocal("deliver"); // нет unloadFinished, allowIncomplete=false -> 409
  assert.strictEqual(res._json.status, 409);
  db.driverRoutes[0].clients[0].unloadFinished = true;
  res = await actLocal("deliver");
  assert.strictEqual(db.driverRoutes[0].clients[0].state, "delivered");
  assert.strictEqual(db.driverRoutes[0].clients[1].state, "in_transit");
  res = await actLocal("arrive");
  db.driverRoutes[0].clients[1].unloadFinished = true;
  res = await actLocal("deliver");
  assert.strictEqual(db.driverRoutes[0].clients[1].state, "delivered");
  res = await actLocal("arrive_base");
  assert.strictEqual(db.driverRoutes[0].progress.status, "done");
});

test("start требует отгрузки без allowDriverStartWithoutShipment -> 409", async () => {
  const { actLocal } = harness({ route: baseRoute({ progress: { status: "idle" } }) });
  const res = await actLocal("start");
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /отгружен/);
});

test("start c allowDriverStartWithoutShipment=true стартует без отгрузки", async () => {
  const { db, actLocal } = harness({ route: baseRoute({ progress: { status: "idle" } }) });
  db.params.allowDriverStartWithoutShipment = true;
  const res = await actLocal("start");
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].progress.status, "active");
});

test("arrive на маршруте не в active -> 409", async () => {
  const { actLocal } = harness({ route: baseRoute({ progress: { status: "idle" } }) });
  const res = await actLocal("arrive");
  assert.strictEqual(res._json.status, 409);
});

test("finish_unload при невыгруженных местах и allowIncomplete=false -> 409", async () => {
  const { actLocal } = harness({
    over: {
    unloadCounts: () => ({ total: 3, done: 1 }),
    allowIncompleteFinish: () => false,
    },
  });
  await actLocal("start");
  await actLocal("arrive");
  const res = await actLocal("finish_unload");
  assert.strictEqual(res._json.status, 409);
  assert.match(String(res._json.obj.error), /Осталось отсканировать/);
});

test("finish_unload при неполном скане и allowIncompleteFinish=true проходит", async () => {
  const { db, actLocal } = harness({
    over: { unloadCounts: () => ({ total: 3, done: 1 }),
    allowIncompleteFinish: () => true,
    },
  });
  await actLocal("start");
  await actLocal("arrive");
  await actLocal("finish_unload");
  assert.strictEqual(db.driverRoutes[0].clients[0].unloadFinished, true);
});

test("postpone требует причину -> 400", async () => {
  const { db, actLocal } = harness();
  await actLocal("start");
  await actLocal("arrive");
  const res = await actLocal("postpone");
  assert.strictEqual(res._json.status, 400);
});

test("postpone ставит точку в postponed и проставляет причину", async () => {
  const { db, actLocal } = harness();
  await actLocal("start");
  await actLocal("arrive");
  const res = await actLocal("postpone", { postponeReason: "клиент не на месте" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].clients[0].state, "postponed");
  assert.strictEqual(db.driverRoutes[0].clients[0].postponeReason, "клиент не на месте");
});

test("arrive_base с незакрытыми точками -> 409", async () => {
  const { db, actLocal } = harness();
  await actLocal("start");
  const res = await actLocal("arrive_base");
  assert.strictEqual(res._json.status, 409);
});

test("обед доступен только после сдачи хотя бы одной точки", async () => {
  const { db, actLocal } = harness();
  await actLocal("start");
  const res = await actLocal("lunch");
  assert.strictEqual(res._json.status, 409);
});

test("обед включается после сдачи точки и вычитается из transitPaused", async () => {
  const { db, actLocal } = harness();
  await actLocal("start");
  await actLocal("arrive");
  db.driverRoutes[0].clients[0].unloadFinished = true;
  await actLocal("deliver"); // c1 delivered, c2 in_transit
  db.driverRoutes[0].clients[1].transitStart = Date.now() - 100000;
  const on = await actLocal("lunch");
  assert.strictEqual(on._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].progress.lunchActive, true);
  const off = await actLocal("lunch");
  assert.strictEqual(db.driverRoutes[0].progress.lunchActive, false);
  assert.ok(Number.isFinite(db.driverRoutes[0].clients[1].transitPaused) && db.driverRoutes[0].clients[1].transitPaused >= 0);
});

test("reorder при выключенном параметре -> 403", async () => {
  const { db, actLocal } = harness();
  const res = await actLocal("reorder", { order: ["c2", "c1"] });
  assert.strictEqual(res._json.status, 403);
});

test("reorder запрещает менять относительный порядок замороженных точек", async () => {
  const r = baseRoute();
  r.clients[0].state = "delivered"; // замороженная
  r.clients[1].state = "on_site";   // замороженная (текущая)
  const { db, actLocal } = harness({ route: r });
  db.params.allowDriverReorderPoints = true;
  // новый порядок ставит c2 впереди c1 — это ломает относительный порядок
  // замороженных (было c1, c2 → стало c2, c1) → 409
  const res = await actLocal("reorder", { order: ["c2", "c1"] });
  assert.strictEqual(res._json.status, 409);
});

test("reorder меняет порядок перемещаемых pending точек и вызывает relinkRouteLabels", async () => {
  let relinked = 0;
  const { db, actLocal } = harness({ over: { relinkRouteLabels: () => { relinked++; } } });
  db.params.allowDriverReorderPoints = true;
  const res = await actLocal("reorder", { order: ["c2", "c1"] });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].clients[0].id, "c2");
  assert.strictEqual(db.driverRoutes[0].clients[1].id, "c1");
  assert.ok(relinked >= 1);
});

test("два водителя: чужой маршрут -> 403", async () => {
  const { actLocal } = harness();
  const res = await actLocal("start", undefined, driverB);
  assert.strictEqual(res._json.status, 403);
});

test("клиенты с битыми значениями не роняют сервер", async () => {
  const bad = { id: "r1", date: "2026-10-03", driverId: "d1", progress: { status: "active", shippedAt: 1 }, clients: [null, "junk", { id: "c3", state: "pending", address: "X" }] };
  const { db, actLocal } = harness({ route: bad });
  const res = await actLocal("start");
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.driverRoutes[0].clients.length, 1);
  assert.strictEqual(db.driverRoutes[0].clients[0].id, "c3");
});

test("неизвестный маршрут -> 404", async () => {
  const { body, h } = harness({ route: { id: "rX", date: "2026-10-03", driverId: "d1", progress: { status: "idle" }, clients: [{ id: "c1", state: "pending", address: "A" }] } });
  body.routeId = "nope"; body.action = "start";
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/routes/action", "POST", driver, false);
  assert.strictEqual(res._json.status, 404);
});

test("неизвестная action -> 400", async () => {
  const { actLocal } = harness();
  const res = await actLocal("fly");
  assert.strictEqual(res._json.status, 400);
});
