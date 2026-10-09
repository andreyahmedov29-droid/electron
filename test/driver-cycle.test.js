// Полный цикл водителя по маршруту: от старта до возврата на базу.
// Покрывает то, что делает и сервер, и мобильный APK (WebView приложения):
//   - старт маршрута,
//   - прибытие на адрес,
//   - печать/погрузку мест складом,
//   - сканирование выгрузки и боксов (POST /api/labels/scan, action "unload"),
//   - завершение выгрузки и сдачи,
//   - перенос точки,
//   - обед,
//   - возврат на базу и завершение маршрута,
//   - мобильный офлайн-сценарий (шканированный код отправляется после
//     восстановления связи и не засчитывается дважды).
//
// Модули используются РЕАЛЬНЫЕ (routes/*.js), только зависимости DI переопределены
// минимальными фейками, как это делают остальные юнит-тесты в test/.
const { test } = require("node:test");
const assert = require("node:assert");

const createRouteActionHandler = require("../routes/route-action");
const createLabelsHandler = require("../routes/labels");
const createDriverRoutesHandler = require("../routes/driver-routes");
const createWaybillHandler = require("../routes/waybill");

// ---- Роли (как в приложении) ----
const driver = { id: "d1", name: "Иван Водитель" };
const loader = { id: "l1", name: "Отгрузка Склад" };
const admin = { id: "a1", name: "Админ", portalAdmin: true };

// Реплика серверного unloadCounts (server.js) — total = loaded+delivered.
function unloadCounts(mine) {
  const arr = Array.isArray(mine) ? mine : [];
  return {
    total: arr.filter((l) => l.status === "loaded" || l.status === "delivered").length,
    done: arr.filter((l) => l.status === "delivered").length,
    created: arr.filter((l) => l.status === "created").length,
  };
}

// Реплика серверного enrichUnloadProgress (server.js) для проверки счётчиков,
// которые мобильный фронт показывает в карточке маршрута.
function enrichUnloadProgress(route, labels) {
  const clients = Array.isArray(route && route.clients) ? route.clients : [];
  const all = labels || [];
  clients.forEach((c, i) => {
    const mine = all.filter((l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === i);
    const { total, done, created } = unloadCounts(mine);
    c.unloadTotal = total;
    c.unloadDone = done;
    c.unloadCreated = created;
    c.unloadReady = total === 0 ? true : done === total;
    c.unloadFinished = c.unloadFinished === true;
  });
  return route;
}

// Маршрут на две точки; склад уже отгрузил (shippedAt задан).
function makeDb(overrides) {
  const base = {
    driverRoutes: [
      {
        id: "r1",
        date: "2026-10-03",
        driverId: "d1",
        driverName: "Иван Водитель",
        progress: { status: "active", shippedAt: 1, baseLat: 55.7, baseLon: 37.6, baseAddress: "База" },
        clients: [
          { id: "c1", state: "pending", client: "Клиент А", address: "Ул. А, 1", bundleId: null },
          { id: "c2", state: "pending", client: "Клиент Б", address: "Ул. Б, 2", bundleId: null },
        ],
      },
    ],
    labels: [],
    days: {},
    params: {},
  };
  Object.assign(base, overrides || {});
  return base;
}

// Собирает handlers с общим db и общим readBody (как сервер: один db, один механизм body).
function build(db, opts = {}) {
  let currentBody = {};
  const persisted = [];
  const persistDb = async () => { persisted.push(Date.now()); };

  const readBody = async () => currentBody;
  const setBody = (b) => { currentBody = b || {}; };

  const sendJson = (res, status, obj) => { res._json = { status, obj }; };
  const isAdmin = (u) => !!u && u.portalAdmin === true;

  const routeAction = createRouteActionHandler(Object.assign({
    getDb: () => db,
    persistDb,
    sendJson,
    readBody,
    isAdmin,
    enrichUnloadProgress,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    segmentsFor: () => [],
    allowIncompleteFinish: () => opts.allowIncomplete !== false,
    unloadCounts: (mine) => unloadCounts(mine),
    relinkRouteLabels: () => {},
  }, opts.routeAction || {}));

  const labels = createLabelsHandler(Object.assign({
    getDb: () => db,
    persistDb,
    sendJson,
    readBody,
    canSeeShipment: () => true,
    isDriver: () => true,
  }, opts.labels || {}));

  const driverRoutes = createDriverRoutesHandler(Object.assign({
    getDb: () => db,
    sendJson,
    readBody,
    isDriver: () => true,
    namesMatch: (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(),
    enrichUnloadProgress,
    withResolvedBundleNames: (r) => r,
    normalizeRouteProgress: (r) => r,
    routeKmCache: {},
    routeKmRoad: () => Promise.resolve(0),
    routeKm: () => 0,
    routeKmPending: {},
  }, opts.driverRoutes || {}));

  const waybill = createWaybillHandler(Object.assign({
    getDb: () => db,
    persistDb,
    sendJson,
    readBody,
    parseXlsxItems: () => ({ items: [], buyer: "" }),
    logWaybillScan: () => {},
    artNorm: (s) => String(s || "").trim().toLowerCase(),
    listWaybillBoxes: (route, ci) => {
      const wb = route && route.waybills && route.waybills[ci];
      const items = wb && Array.isArray(wb.items) ? wb.items : [];
      return [...new Set(items.filter((it) => it.box).map((it) => it.box))];
    },
    isAdmin: () => true,
    isModerator: () => true,
  }, opts.waybill || {}));

  return {
    db, setBody, persistDb, persisted,
    routeAction, labels, driverRoutes, waybill,
  };
}

// Универсальный вызов POST-handler'а с навешиванием _json и подсчётом статуса.
async function post(h, path, body, user = driver, adminFlag = false) {
  const res = {};
  await h(
    { headers: {}, url: path, socket: { remoteAddress: "10.0.0.1" } },
    res, path, "POST", user, adminFlag,
  );
  return res._json;
}

async function get(h, path, user = driver, adminFlag = false) {
  const res = {};
  await h(
    { headers: {}, url: path, socket: { remoteAddress: "10.0.0.1" } },
    res, path, "GET", user, adminFlag,
  );
  return res._json;
}

// Печатает N этикеток и погружает их (склад), готовя клиента к выгрузке.
async function printAndLoad(ctx, routeId, clientIndex, qty) {
  ctx.setBody({ routeId, clientIndex, qty });
  await post(ctx.labels, "/api/labels", { routeId, clientIndex, qty }, loader, false);
  const labels = ctx.db.labels.filter(
    (l) => String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex,
  );
  for (const l of labels) {
    ctx.setBody({ code: l.code, action: "load" });
    const r = await post(ctx.labels, "/api/labels/scan", { code: l.code, action: "load" }, loader, false);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.obj.label.status, "loaded", "место должно погрузиться");
  }
}

// Водитель сканирует все места клиента на выгрузке (как мобильный APK после
// invokeNativeScan/driverUnloadCallback для каждого кода бокса).
async function scanUnloadAll(ctx, routeId, clientIndex) {
  const labels = ctx.db.labels.filter(
    (l) => String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex,
  );
  for (const l of labels) {
    ctx.setBody({ code: l.code, action: "unload" });
    const r = await post(ctx.labels, "/api/labels/scan", { code: l.code, action: "unload" }, driver, false);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.obj.label.status, "delivered", "место должно выгрузиться");
  }
}

// Возвращает raw ответ о маршруте из /api/drivers/routes (то, что видит фронт APK).
async function getDriverRoute(ctx, routeId) {
  const r = await get(ctx.driverRoutes, "/api/drivers/routes", driver, false);
  assert.strictEqual(r.status, 200);
  const route = (r.obj.routes || []).find((x) => String(x.id) === String(routeId));
  assert.ok(route, "маршрут должен быть в списке водителя");
  return route;
}

// ================= Полный счастливый цикл =================

test("полный цикл водителя: старт -> прибытие -> скан выгрузки -> сдача -> база", async () => {
  const ctx = build(makeDb({ params: { allowDriverStartWithoutShipment: false } }));
  const routeId = "r1";

  // 1) Склад печатает и погружает 3 места для обеих точек.
  await printAndLoad(ctx, routeId, 0, 3);
  await printAndLoad(ctx, routeId, 1, 2);

  // 2) Старт маршрута: активный, первая точка in_transit.
  ctx.setBody({ routeId, action: "start" });
  let r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "start" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.progress.status, "active");
  assert.strictEqual(r.obj.route.clients[0].state, "in_transit");

  // 3) Прибыл на адрес: точка 1 on_site.
  ctx.setBody({ routeId, action: "arrive" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "arrive" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[0].state, "on_site");

  // 4) Водитель сканирует выгрузку боксов (все 3 места).
  await scanUnloadAll(ctx, routeId, 0);

  // 5) Счётчик в карточке для мобильного фронта показывает 3/3.
  let routeView = await getDriverRoute(ctx, routeId);
  assert.strictEqual(routeView.clients[0].unloadDone, 3);
  assert.strictEqual(routeView.clients[0].unloadTotal, 3);
  assert.strictEqual(routeView.clients[0].unloadReady, true);

  // 6) Завершить выгрузку.
  ctx.setBody({ routeId, action: "finish_unload" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "finish_unload" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[0].unloadFinished, true);

  // 7) Завершить сдачу: точка 1 delivered, точка 2 in_transit.
  ctx.setBody({ routeId, action: "deliver" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "deliver" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[0].state, "delivered");
  assert.strictEqual(r.obj.route.clients[1].state, "in_transit");

  // 8) Точка 2: прибытие, скан, сдача.
  ctx.setBody({ routeId, action: "arrive" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "arrive" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[1].state, "on_site");
  await scanUnloadAll(ctx, routeId, 1);
  ctx.setBody({ routeId, action: "finish_unload" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "finish_unload" }, driver, false);
  assert.strictEqual(r.status, 200);
  ctx.setBody({ routeId, action: "deliver" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "deliver" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[1].state, "delivered");

  // 9) Возврат на базу -> маршрут done.
  ctx.setBody({ routeId, action: "arrive_base" });
  r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId, action: "arrive_base" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.progress.status, "done");
});

// ================= Инварианты сканирования (важно для мобильного APK) =================

test("скан выгрузки до погрузки -> предупреждение, место не выгружается", async () => {
  const ctx = build(makeDb());
  // Склад только напечатал (created), не погрузил.
  ctx.setBody({ routeId: "r1", clientIndex: 0, qty: 1 });
  await post(ctx.labels, "/api/labels", { routeId: "r1", clientIndex: 0, qty: 1 }, loader, false);
  const code = ctx.db.labels[0].code;

  ctx.setBody({ code, action: "unload" });
  const r = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.ok(r.obj.warning, "должно быть предупреждение «ещё не погружено»");
  assert.notStrictEqual(r.obj.label.status, "delivered", "место не должно засчитаться");
});

test("повторный скан уже выгруженного места -> предупреждение без второго засчёта", async () => {
  const ctx = build(makeDb());
  await printAndLoad(ctx, "r1", 0, 1);
  const code = ctx.db.labels[0].code;

  ctx.setBody({ code, action: "unload" });
  const first = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
  assert.strictEqual(first.status, 200);

  const second = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
  assert.strictEqual(second.status, 200);
  assert.ok(second.obj.warning, "повтор должен дать предупреждение");
  assert.strictEqual(second.obj.label.status, "delivered");

  const routeView = await getDriverRoute(ctx, "r1");
  assert.strictEqual(routeView.clients[0].unloadDone, 1, "счётчик не должен вырасти выше 1");
});

test("скан несуществующей/чужой этикетки -> 404 (бокс не найден)", async () => {
  const ctx = build(makeDb());
  ctx.setBody({ code: "BG999-1-1", action: "unload" });
  const r = await post(ctx.labels, "/api/labels/scan", { code: "BG999-1-1", action: "unload" }, driver, false);
  assert.strictEqual(r.status, 404);
  assert.ok(/не найдена/i.test(r.obj.error || ""));
});

test("скан кода без печати: сервер воссоздаёт метку, но скан unload до погрузки не засчитывается", async () => {
  const ctx = build(makeDb());
  // Ничего не печатаем. Код метки строится как `BG<routeId>-<clientIndex+1>-<place>`
  // (у маршрута id = "r1"). Сервер распознаёт код, но создаёт метку в статусе
  // "created" — до погрузки складом выгрузка не засчитывается (безопасно для APK).
  const code = "BGr1-1-1";
  ctx.setBody({ code, action: "unload" });
  const r = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.label.status, "created", "метка воссоздаётся, но ещё не погружена");
  assert.ok(r.obj.warning, "должно предупредить «ещё не погружено»");
  const routeView = await getDriverRoute(ctx, "r1");
  assert.strictEqual(routeView.clients[0].unloadDone, 0, "без погрузки места не выгружаются");

  // После того как склад погрузит воссозданную метку, скан водителя засчитывается.
  const createdCode = ctx.db.labels.find((l) => String(l.code) === code);
  ctx.setBody({ code, action: "load" });
  const load = await post(ctx.labels, "/api/labels/scan", { code, action: "load" }, loader, false);
  assert.strictEqual(load.status, 200);
  assert.strictEqual(load.obj.label.status, "loaded");

  ctx.setBody({ code, action: "unload" });
  const done = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.obj.label.status, "delivered");
  const after = await getDriverRoute(ctx, "r1");
  assert.strictEqual(after.clients[0].unloadDone, 1);
});

// ================= Завершение выгрузки / сдачи =================

test("finish_unload при недо-скане и закрытой опции -> 409", async () => {
  const ctx = build(makeDb({ params: {} }), { allowIncomplete: false });
  await printAndLoad(ctx, "r1", 0, 3);
  // Начали маршрут и прибыли.
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);
  // Отсканировали только 1 из 3.
  for (const l of ctx.db.labels.slice(0, 1)) {
    ctx.setBody({ code: l.code, action: "unload" });
    await post(ctx.labels, "/api/labels/scan", { code: l.code, action: "unload" }, driver, false);
  }
  ctx.setBody({ routeId: "r1", action: "finish_unload" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "finish_unload" }, driver, false);
  assert.strictEqual(r.status, 409);
});

test("finish_unload при разрешённом неполном скане -> ok", async () => {
  const ctx = build(makeDb({ params: {} }), { allowIncomplete: true });
  await printAndLoad(ctx, "r1", 0, 3);
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "finish_unload" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "finish_unload" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[0].unloadFinished, true);
});

test("deliver без завершения выгрузки -> 409 (опция закрыта)", async () => {
  const ctx = build(makeDb(), { allowIncomplete: false });
  await printAndLoad(ctx, "r1", 0, 1);
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "deliver" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "deliver" }, driver, false);
  assert.strictEqual(r.status, 409);
});

test("deliver без завершения выгрузки при разрешённом неполном -> ок и завершает", async () => {
  const ctx = build(makeDb(), { allowIncomplete: true });
  await printAndLoad(ctx, "r1", 0, 1);
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "deliver" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "deliver" }, driver, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.obj.route.clients[0].state, "delivered");
  assert.strictEqual(r.obj.route.clients[0].unloadFinished, true, "неполное завершение должно закрыть выгрузку");
});

// ================= Старт и права =================

test("start без отгрузки складом -> 409, пока админ не разрешил", async () => {
  const db = makeDb();
  db.driverRoutes[0].progress.shippedAt = 0; // не отгружен
  const ctx = build(db);
  ctx.setBody({ routeId: "r1", action: "start" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  assert.strictEqual(r.status, 409);
});

test("стартующий не принадлежащий маршруту водитель -> 403", async () => {
  const ctx = build(makeDb());
  ctx.setBody({ routeId: "r1", action: "start" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, { id: "other", name: "Чужой" }, false);
  assert.strictEqual(r.status, 403);
});

test("arrive_base при незавершённых точках -> 409", async () => {
  const ctx = build(makeDb());
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive_base" });
  const r = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive_base" }, driver, false);
  assert.strictEqual(r.status, 409);
});

// ================= Перенос и обед =================

test("перенос точки: postpone требуeт причину и переводит группу в postponed", async () => {
  const ctx = build(makeDb());
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);

  // Без причины -> 400.
  ctx.setBody({ routeId: "r1", action: "postpone" });
  const bad = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "postpone" }, driver, false);
  assert.strictEqual(bad.status, 400);

  // С причиной -> ok.
  ctx.setBody({ routeId: "r1", action: "postpone", postponeReason: "Клиент отменил приёмку" });
  const ok = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "postpone", postponeReason: "Клиент отменил приёмку" }, driver, false);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.obj.route.clients[0].state, "postponed");
  assert.strictEqual(ok.obj.route.clients[0].postponeReason, "Клиент отменил приёмку");
  assert.strictEqual(ok.obj.route.clients[1].state, "in_transit", "следующая точка должна стать в пути");
});

test("обед вкл/выкл доступен после сдачи точки", async () => {
  const ctx = build(makeDb(), { allowIncomplete: true });
  await printAndLoad(ctx, "r1", 0, 1);
  ctx.setBody({ routeId: "r1", action: "start" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "start" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "arrive" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "arrive" }, driver, false);
  ctx.setBody({ routeId: "r1", action: "deliver" });
  await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "deliver" }, driver, false);

  ctx.setBody({ routeId: "r1", action: "lunch" });
  const on = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "lunch" }, driver, false);
  assert.strictEqual(on.status, 200);
  assert.strictEqual(on.obj.route.progress.lunchActive, true);

  ctx.setBody({ routeId: "r1", action: "lunch" });
  const off = await post(ctx.routeAction, "/api/drivers/routes/action", { routeId: "r1", action: "lunch" }, driver, false);
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.obj.route.progress.lunchActive, false);
});

// ================= Сканирование боксов при сборке (склад) =================

test("сборка боксов: склад сканирует детали в боксы; сверх нормы количество урезается", async () => {
  const db = makeDb();
  db.driverRoutes[0].waybills = { 0: { items: [{ art: "A-100", name: "Деталь", qty: 5, scanned: 0 }] } };
  const ctx = build(db);

  ctx.setBody({ clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 2 });
  const r1 = await post(ctx.waybill, "/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 2 }, loader, false);
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.obj.item.scanned, 2);
  assert.strictEqual(r1.obj.item.box, "BG1-1-1");

  // Добираем остаток.
  ctx.setBody({ clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 3 });
  const r2 = await post(ctx.waybill, "/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 3 }, loader, false);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.obj.item.scanned, 5);

  // Сверх нормы: сервер не выдаёт ошибку, а урезает количество до остатка.
  ctx.setBody({ clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 1 });
  const r3 = await post(ctx.waybill, "/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A-100", box: "BG1-1-1", qty: 1 }, loader, false);
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.obj.item.scanned, 5, "scanned не должен превысить норму");
  assert.strictEqual(r3.obj.left, 0, "после переполнения остаток нулевой");

  // Бокс с деталями нельзя удалить.
  ctx.setBody({ clientIndex: 0, box: "BG1-1-1" });
  const del = await post(ctx.waybill, "/api/routes/r1/waybill/box/delete", { clientIndex: 0, box: "BG1-1-1" }, loader, false);
  assert.strictEqual(del.status, 409);
});

// ================= Мобильный APK: офлайн-сценарий =================

test("мобильный офлайн: серия сканов после восстановления связи даёт тот же результат без дублей", async () => {
  // Имитируем APK: водитель отсканировал боксы при пропавшей сети, события легли в
  // офлайн-очередь и ушли одним флашем после восстановления (каждый код — один POST).
  const ctx = build(makeDb());
  await printAndLoad(ctx, "r1", 0, 3);

  // Отправляем все 3 скана подряд — как flushOfflineOps после сетевого оживления.
  const codes = ctx.db.labels.map((l) => l.code);
  for (const code of codes) {
    ctx.setBody({ code, action: "unload" });
    const r = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.obj.label.status, "delivered");
  }

  const routeView = await getDriverRoute(ctx, "r1");
  assert.strictEqual(routeView.clients[0].unloadDone, 3);
  assert.strictEqual(routeView.clients[0].unloadTotal, 3);
  assert.strictEqual(routeView.clients[0].unloadReady, true);

  // Если APK повторно по какой-то причине отправит те же коды — сервер не задвоит.
  for (const code of codes) {
    ctx.setBody({ code, action: "unload" });
    const r = await post(ctx.labels, "/api/labels/scan", { code, action: "unload" }, driver, false);
    assert.strictEqual(r.status, 200);
    assert.ok(r.obj.warning, "повторная доставка должна быть помечена предупреждением");
  }
  const after = await getDriverRoute(ctx, "r1");
  assert.strictEqual(after.clients[0].unloadDone, 3, "счётчик не должен вырасти от повторных доставок");
});

test("GET /api/drivers/routes отдаёт счётчики, на которые опирается UI мобильного/APK", async () => {
  const ctx = build(makeDb());
  const routeView = await getDriverRoute(ctx, "r1");
  assert.strictEqual(routeView.clients[0].unloadTotal, 0);
  assert.strictEqual(routeView.clients[0].unloadDone, 0);
  assert.strictEqual(routeView.clients[0].unloadReady, true, "без этикеток завершить выгрузку можно сразу");
});
