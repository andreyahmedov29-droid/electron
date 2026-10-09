// Исчерпывающие тесты ошибочного сканирования при сборке: waybill/scan и labels/scan.
// Покрывают ветки, где скан НЕ должен засчитываться, и убеждаются, что сервер
// отвечает корректным статусом и не мутирует данные ложно.
const { test } = require("node:test");
const assert = require("node:assert");
const createWaybillHandler = require("../routes/waybill");
const createLabelsHandler = require("../routes/labels");

const RU_LOOK = { "А": "A", "а": "a", "В": "B", "в": "b", "С": "C", "с": "c", "Е": "E", "е": "e", "К": "K", "к": "k", "М": "M", "м": "m", "Н": "H", "н": "h", "О": "O", "о": "o", "Р": "P", "р": "p", "Т": "T", "т": "t", "У": "Y", "у": "y", "Х": "X", "х": "x" };

function WB() {
  const db = { driverRoutes: [], labels: [] };
  const body = {};
  const h = createWaybillHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    parseXlsxItems: () => ({ items: [], buyer: "" }),
    logWaybillScan: () => {},
    artNorm: (s) => {
      const t = String(s == null ? "" : s);
      const tr = t.replace(/[АаВвСсЕеКкМмНнОоРрТтУуХхІі]/g, (c) => RU_LOOK[c] || c);
      return tr.replace(/[\s_.\-,:/;\\]/g, "");
    },
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  });
  const user = { id: "u1", name: "Склад" };
  const route = {
    id: "r1",
    clients: [{ client: "Клиент А" }],
    waybills: {
      0: {
        items: [
          { art: "A1", name: "Деталь A1", qty: 2, scanned: 0, missing: false },
          { art: "B2", name: "Деталь B2", qty: 1, scanned: 0, missing: false },
        ],
      },
    },
  };
  db.driverRoutes = [route];
  const call = async (path, payload) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: path }, res, path, "POST", user, true);
    return res;
  };
  return { db, body, call, route, h };
}

function LB() {
  const db = { labels: [], driverRoutes: [], scanLog: [] };
  const body = {};
  const h = createLabelsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    canSeeShipment: () => true,
    isDriver: () => true,
  });
  const user = { id: "u1", name: "Сотрудник" };
  const route = {
    id: "r1",
    clients: [
      { client: "Клиент А", address: "Ул. 1", labelQty: 2 },
    ],
  };
  db.driverRoutes = [route];
  const call = async (path, payload) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: path }, res, path, "POST", user, true);
    return res;
  };
  return { db, body, call, route };
}

// ---------- waybill/scan: ошибочные сканы ----------

test("waybill scan: пустой артикул -> 422", async () => {
  const c = WB();
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "", box: "B" });
  assert.strictEqual(res._json.status, 422);
  assert.match(String(res._json.obj.error), /Пустой артикул/);
});

test("waybill scan: нечисловой clientIndex -> 422", async () => {
  const c = WB();
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: "abc", art: "A1" });
  assert.strictEqual(res._json.status, 422);
  assert.match(String(res._json.obj.error), /bad clientIndex/);
});

test("waybill scan: неизвестный маршрут -> 404", async () => {
  const c = WB();
  const res = await c.call("/api/routes/nope/waybill/scan", { clientIndex: 0, art: "A1" });
  assert.strictEqual(res._json.status, 404);
  assert.match(String(res._json.obj.error), /Маршрут не найден/);
});

test("waybill scan: артикула нет в накладной -> 404", async () => {
  const c = WB();
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "ZZZ", box: "B" });
  assert.strictEqual(res._json.status, 404);
  assert.match(String(res._json.obj.error), /Артикул не найден в накладной/);
});

test("waybill scan: скан артикула с кириллическим двойником распознаётся (artNorm)", async () => {
  const c = WB();
  // артикул "А1" в накладной; сканируем "A1" латиницей — двойник А->A
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "B" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
});

test("waybill scan: скан с мусором вокруг артикула НЕ срабатывает (артикул не найден)", async () => {
  const c = WB();
  // стикер с лишними символами вокруг: сервер ищет точное совпадение артикула,
  // «A1X» не совпадает ни с A1, ни с B2
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1X", box: "B" });
  assert.strictEqual(res._json.status, 404);
});

test("waybill scan: скан артикула полностью собранного -> rebound и не увеличивает счёт", async () => {
  const c = WB();
  c.route.waybills[0].items[0] = { art: "A1", qty: 2, scanned: 2, missing: false, box: "Bx1" };
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "Bx2" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rebound, true);
  assert.strictEqual(res._json.obj.item.scanned, 2, "счёт не растёт при rebound");
});

test("waybill scan: qty > остатка режется до остатка, не допускает пересбора", async () => {
  const c = WB();
  // A1 qty=2, scanned=0; пробуем qty=50
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "B", qty: 50 });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.item.scanned, 2);
  assert.strictEqual(res._json.obj.left, 0);
});

test("waybill scan: qty=-5 -> приводится к 1 (Math.max(1,...))", async () => {
  const c = WB();
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "B", qty: -5 });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
});

test("waybill scan: вторая порция той же детали засчитывается до остатка", async () => {
  const c = WB();
  await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "B", qty: 1 });
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "A1", box: "B", qty: 2 });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.item.scanned, 2);
  assert.strictEqual(res._json.obj.left, 0);
});

test("waybill scan: без активного бокса деталь засчитывается (box опционален), box остаётся 'без бокса'", async () => {
  const c = WB();
  const res = await c.call("/api/routes/r1/waybill/scan", { clientIndex: 0, art: "B2" }); // без box
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
});

// ---------- waybill/scan: действие не из списка ----------
test("waybill: неизвестное действие (постфикс) не распознаётся как waybill-маршрут (возвращает false)", async () => {
  const c = WB();
  // постфикс "bogus" не входит в рег.выражение маршрута -> хендлер отдаёт false
  // (обработчик отклонён: не роняет сервер, не мутирует данные).
  Object.assign(c.body, { clientIndex: 0, art: "A1" });
  const res = {};
  const ret = await c.h({ headers: {}, url: "/api/routes/r1/waybill/bogus" }, res, "/api/routes/r1/waybill/bogus", "POST", { id: "u1", name: "Склад" }, true);
  assert.strictEqual(ret, false);
});

// ---------- labels/scan: ошибочные сканы ----------

test("labels scan: пустой код -> 400", async () => {
  const l = LB();
  const res = await l.call("/api/labels/scan", { code: "", action: "load" });
  assert.strictEqual(res._json.status, 400);
  assert.match(String(res._json.obj.error), /Укажите код этикетки/);
});

test("labels scan: неизвестное действие -> 400", async () => {
  const l = LB();
  const res = await l.call("/api/labels/scan", { code: "BGr1-1-1", action: "explode" });
  assert.strictEqual(res._json.status, 400);
  assert.match(String(res._json.obj.error), /Неизвестное действие/);
});

test("labels scan: код вне маршрута -> 404 Этикетка не найдена", async () => {
  const l = LB();
  const res = await l.call("/api/labels/scan", { code: "BGnope-1-1", action: "load" });
  assert.strictEqual(res._json.status, 404);
});

test("labels scan: выгрузка не созданного места авто-создаёт этикетку и НЕ даёт warning как у неизвестного", async () => {
  const l = LB();
  // кода нет -> авто-воссоздание (место 1 клиента 0)
  const res = await l.call("/api/labels/scan", { code: "BGr1-1-1", action: "load" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.label.status, "loaded");
  assert.strictEqual(res._json.obj.warning, null);
});

test("labels scan: дубль скана при погрузке даёт предупреждение и не дублирует журнал", async () => {
  const l = LB();
  await l.call("/api/labels/scan", { code: "BGr1-1-2", action: "load" });
  const first = l.db.scanLog.length;
  const res = await l.call("/api/labels/scan", { code: "BGr1-1-2", action: "load" });
  assert.ok(res._json.obj.warning, "повторный скан даёт предупреждение");
  assert.strictEqual(l.db.scanLog.length, first, "журнал не дублируется");
});

test("labels scan: выгрузка НЕ погруженного места = предупреждение, статус не меняется", async () => {
  const l = LB();
  // создадим место без погрузки
  await l.call("/api/labels/scan", { code: "BGr1-1-1", action: "load" }); // -> loaded
  const loaded = l.db.labels.find((x) => x.code === "BGr1-1-1");
  loaded.status = "created"; // сбросим, чтобы проверить выгрузку не-load-места
  const res = await l.call("/api/labels/scan", { code: "BGr1-1-1", action: "unload" });
  assert.strictEqual(res._json.obj.warning, "Место ещё не погружено (выгружать рано)");
  assert.strictEqual(l.db.labels.find((x) => x.code === "BGr1-1-1").status, "created");
});
