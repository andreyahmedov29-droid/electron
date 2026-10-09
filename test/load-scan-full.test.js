// Комплексные тесты ПОГРУЗКИ складом: POST /api/labels/scan с action="load".
// Покрывают все модели и граничные случаи, чтобы выявить баги в текущей реализации.
const { test } = require("node:test");
const assert = require("node:assert");
const createLabelsHandler = require("../routes/labels");

// Хитрый хелпер: даёт возможность задать canSeeShipment / isDriver / admin,
// структуру маршрута с накладными и метки вручную.
function makeLB({ canSeeShipment = true, isDriver = false, driverRoutes = [], labels = [], adminArg = true } = {}) {
  const db = { labels, driverRoutes, scanLog: [] };
  const body = {};
  const h = createLabelsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    canSeeShipment: () => canSeeShipment,
    isDriver: () => isDriver,
  });
  const user = { id: "u1", name: "Склад" };
  const call = async (payload, admin = adminArg) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: "/api/labels/scan" }, res, "/api/labels/scan", "POST", user, admin);
    return res;
  };
  const find = (code) => db.labels.find((l) => String(l.code) === code);
  return { db, body, call, user, find };
}

// Маршрут без накладных вообще.
const routeNoWb = { id: "r1", clients: [{ client: "Клиент А", labelQty: 2 }] };
// Маршрут с накладной: клиент 0, две позиции A1 и B2.
const routeWithWb = {
  id: "r2",
  clients: [{ client: "Клиент А", labelQty: 2 }],
  waybills: {
    0: {
      items: [
        { art: "A1", qty: 2, scanned: 0, missing: false, box: "" },
        { art: "B2", qty: 1, scanned: 0, missing: false, box: "" },
      ],
    },
  },
};

const label = (over) => Object.assign({
  id: "L1", code: "BGr1-1-1", routeId: "r1", clientIndex: 0, place: 1, status: "created",
}, over || {});

// ---------- Модель 1: маршрут без накладной (cборки нет) ----------

test("load: маршрут вообще без waybills -> место loaded", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label()] });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
  assert.strictEqual(res._json.obj.warning, null);
});

test("load: маршрут с waybills, но у клиента нет накладной (undefined) -> loaded", async () => {
  // waybills[1] нет, сканируем место клиента 1
  const l = label({ code: "BGr1-1-2", clientIndex: 1, place: 2 });
  const c = makeLB({ driverRoutes: [{ ...routeNoWb, waybills: { 0: { items: [] } } }], labels: [l] });
  const res = await c.call({ code: "BGr1-1-2", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

test("load: waybills items накладной ПУСТОЙ [] -> loaded (проверка сборки пропускается)", async () => {
  const c = makeLB({
    driverRoutes: [{ ...routeNoWb, waybills: { 0: { items: [] } } }],
    labels: [label()],
  });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

test("load: waybills items НЕ массив (undefined поле) -> loaded", async () => {
  const c = makeLB({
    driverRoutes: [{ ...routeNoWb, waybills: { 0: { items: undefined } } }],
    labels: [label()],
  });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

test("load: маршрут не найден в базе (нет driverRoutes) -> loaded без проверки сборки", async () => {
  // found.routeId = r1, но в базе маршрута нет. wbRoute undefined -> пропуск.
  const c = makeLB({ driverRoutes: [], labels: [label()] });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

// ---------- Модель 2: сборка в бокс (hasInBox) ----------

test("load: деталь собрана в этот бокс (box=код места, scanned>0) -> loaded", async () => {
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [{ art: "A1", qty: 2, scanned: 2, missing: false, box: "BGr2-1-1" }] } },
  };
  const l = label({ routeId: "r2", code: "BGr2-1-1" });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

test("load: деталей в боксе НЕТ -> 409 «завершите сборку», статус не меняется", async () => {
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [{ art: "A1", qty: 2, scanned: 0, missing: false, box: "" }] } },
  };
  const l = label({ routeId: "r2", code: "BGr2-1-1" });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409, JSON.stringify(res._json));
  assert.match(String(res._json.obj.error), /нет собранных деталей/);
  assert.strictEqual(c.find("BGr2-1-1").status, "created");
  assert.strictEqual(c.db.scanLog.length, 0, "409 не пишет в журнал");
});

test("load: box совпадает, но scanned=0 -> 409 (собранным считается только scanned>0)", async () => {
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [{ art: "A1", qty: 2, scanned: 0, missing: false, box: "BGr2-1-1" }] } },
  };
  const l = label({ routeId: "r2", code: "BGr2-1-1" });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409, JSON.stringify(res._json));
});

test("load: деталь собрана в ДРУГОЙ бокс -> сканирование этого места даёт 409", async () => {
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [{ art: "A1", qty: 2, scanned: 2, missing: false, box: "BGr2-1-2" }] } },
  };
  // сканируем место 1, деталь в месте 2
  const l = label({ routeId: "r2", code: "BGr2-1-1", place: 1 });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409, JSON.stringify(res._json));
});

test("load: несколько позиций, хотя бы одна собрана в этот бокс -> loaded", async () => {
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [
      { art: "A1", qty: 2, scanned: 0, missing: false, box: "" },
      { art: "B2", qty: 1, scanned: 1, missing: false, box: "BGr2-1-1" },
    ] } },
  };
  const l = label({ routeId: "r2", code: "BGr2-1-1" });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

test("load: box хранится в человекочитаемом виде (не код места) -> 409 (чувствительность сравнения)", async () => {
  // РЕАЛЬНЫЙ РИСК: если при сборке фронт пишет в box читаемое имя/номер, а не точный
  // код этикетки BG..., hasInBox не найдёт совпадение и погрузка заблокируется.
  const wb = {
    ...routeWithWb,
    waybills: { 0: { items: [{ art: "A1", qty: 2, scanned: 2, missing: false, box: "1-1" }] } },
  };
  const l = label({ routeId: "r2", code: "BGr2-1-1" });
  const c = makeLB({ driverRoutes: [wb], labels: [l] });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409, JSON.stringify(res._json));
});

// ---------- Модель 3: повторные сканы и статусы ----------

test("load: повторный скан уже погруженного места -> warning, статус не меняется, журнал не дублируется", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label({ status: "created" })] });
  await c.call({ code: "BGr1-1-1", action: "load" });
  const afterFirst = c.db.scanLog.length;
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.ok(res._json.obj.warning, "должно быть предупреждение");
  assert.match(String(res._json.obj.warning), /уже погружено/);
  assert.strictEqual(res._json.obj.label.status, "loaded");
  assert.strictEqual(c.db.scanLog.length, afterFirst, "журнал не дублируется");
});

test("load: скан уже ВЫГРУЖЕННОГО (delivered) места -> warning «уже отгружено и выгружено»", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label({ status: "delivered" })] });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200);
  assert.match(String(res._json.obj.warning), /уже отгружено и выгружено/);
  assert.strictEqual(c.find("BGr1-1-1").status, "delivered");
  assert.strictEqual(c.db.scanLog.length, 0);
});

test("load: место со статусом undefined/прочим -> становится loaded", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label({ status: undefined })] });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
});

// ---------- Модель 4: clientTime и авторы ----------

test("load: clientTime проставляется в loadedAt", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label()] });
  const t = 1700000000000;
  const res = await c.call({ code: "BGr1-1-1", action: "load", clientTime: t });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.label.loadedAt, t);
  assert.strictEqual(res._json.obj.label.loadedBy, "u1");
  assert.strictEqual(c.db.scanLog[0].ts, t);
});

test("load: user.id = null -> loadedBy остаётся null", async () => {
  const db = { labels: [label()], driverRoutes: [routeNoWb], scanLog: [] };
  const body = {};
  const h = createLabelsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    canSeeShipment: () => true,
    isDriver: () => false,
  });
  Object.assign(body, { code: "BGr1-1-1", action: "load" });
  const res = {};
  await h({ headers: {}, url: "/api/labels/scan" }, res, "/api/labels/scan", "POST", { id: null, name: "X" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.label.loadedBy, null);
  assert.strictEqual(db.scanLog[0].userId, null);
});

// ---------- Модель 5: авто-воссоздание места при load ----------

test("load: несуществующее место BG-кодом авто-создаётся и становится loaded (без накладной)", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [] });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
  assert.ok(c.find("BGr1-1-1"), "метка создана");
});

test("load: авто-создание метки у клиента ВНЕ диапазона -> 404", async () => {
  // только 1 клиент (index 0), сканируем индекс 1 (client 2)
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [] });
  const res = await c.call({ code: "BGr1-2-1", action: "load" });
  assert.strictEqual(res._json.status, 404, JSON.stringify(res._json));
  assert.match(String(res._json.obj.error), /Этикетка не найдена/);
});

test("load: код не BG-формата -> 404", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [] });
  const res = await c.call({ code: "EAN1234567890", action: "load" });
  assert.strictEqual(res._json.status, 404, JSON.stringify(res._json));
});

test("load: авто-создание, но в боксе нет собранных деталей -> 409", async () => {
  // авто-воссоздание создаёт метку created, затем проверка сборки маршрута блокирует
  const c = makeLB({
    driverRoutes: [{ ...routeWithWb, id: "r2" }],
    labels: [],
  });
  const res = await c.call({ code: "BGr2-1-1", action: "load" });
  assert.strictEqual(res._json.status, 409, JSON.stringify(res._json));
});

// ---------- Модель 6: права доступа ----------

test("load: нет складских прав и не админ -> 403", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label()], canSeeShipment: false, adminArg: false });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 403, JSON.stringify(res._json));
});

test("load: даже водитель без canSeeShipment и не админ -> 403", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label()], canSeeShipment: false, isDriver: true, adminArg: false });
  const res = await c.call({ code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 403, JSON.stringify(res._json));
});

test("unload: не админ и не isDriver (водитель) -> 403", async () => {
  const c = makeLB({ driverRoutes: [routeNoWb], labels: [label()], canSeeShipment: true, isDriver: false, adminArg: false });
  const res = await c.call({ code: "BGr1-1-1", action: "unload" });
  assert.strictEqual(res._json.status, 403, JSON.stringify(res._json));
});

// ---------- Модель 7: связка сборка -> погрузка ----------

test("связка: собранная деталь в бокс (waybill scan), затем load места -> loaded", async () => {
  const createWaybillHandler = require("../routes/waybill");
  const db = {
    labels: [],
    driverRoutes: [{ ...routeWithWb, id: "r2" }],
    scanLog: [],
  };
  const wbBody = {};
  const wh = createWaybillHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => wbBody,
    parseXlsxItems: () => ({ items: [], buyer: "" }),
    logWaybillScan: () => {},
    artNorm: (s) => String(s == null ? "" : s).replace(/[\s_.\-,:/;\\]/g, ""),
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  });
  // собрать деталь A1 в бокс BGr2-1-1
  Object.assign(wbBody, { clientIndex: 0, art: "A1", box: "BGr2-1-1" });
  const wbRes = {};
  await wh({ headers: {}, url: "/api/routes/r2/waybill/scan" }, wbRes, "/api/routes/r2/waybill/scan", "POST", { id: "u1", name: "Склад" }, true);
  assert.strictEqual(wbRes._json.status, 200, JSON.stringify(wbRes._json));
  // теперь погрузить место через labels/scan load
  const lbBody = {};
  const lh = createLabelsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => lbBody,
    canSeeShipment: () => true,
    isDriver: () => false,
  });
  Object.assign(lbBody, { code: "BGr2-1-1", action: "load" });
  const lRes = {};
  await lh({ headers: {}, url: "/api/labels/scan" }, lRes, "/api/labels/scan", "POST", { id: "u1", name: "Склад" }, true);
  assert.strictEqual(lRes._json.status, 200, JSON.stringify(lRes._json));
  assert.strictEqual(lRes._json.obj.label.status, "loaded");
});
