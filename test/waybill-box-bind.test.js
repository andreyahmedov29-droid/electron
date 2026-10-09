// Юнит-тесты: «деталь не привязалась к боксу, хотя бокс был выбран».
//
// Воспроизводят живой баг в routes/waybill.js: сервер прикрепляет деталь к боксу
// ТОЛЬКО когда в запросе приходит поле `box` (if (box) item.box = box). Если клиент
// (ТСД или компьютерный сканер) выбрал бокс на экране, но в запрос `box` не попал
// (пустая строка, отсутствует, другое имя поля, невалидный код) — деталь
// засчитывается в счётчик, но привязки к боксу НЕТ (item.box остаётся пустым).
//
// Сканируем в двух режимах ввода — как на ТСД (аппаратный сканер шлёт только код
// детали + активный бокс из состояния) и как с компьютера (USB-сканер вводит код
// в поле). В обоих случаях сервер получает один и тот же REST-запрос; разница —
// доходит ли активный бокс до поля `box`.
const { test } = require("node:test");
const assert = require("node:assert");
const createWaybillHandler = require("../routes/waybill");

const RU_LOOK = { "А": "A", "а": "a", "В": "B", "в": "b", "С": "C", "с": "c", "Е": "E", "е": "e" };

function make() {
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
      const tr = String(s == null ? "" : s).replace(/[АаВвСсЕе]/g, (c) => RU_LOOK[c] || c);
      return tr.replace(/[\s_.\-,:/;\\]/g, "");
    },
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  });
  const user = { id: "u1", name: "Склад" };
  const route = {
    id: "r1",
    clients: [{ client: "Клиент А", address: "Ул. 1", labelQty: 3 }],
    waybills: {
      0: { items: [{ art: "A1", name: "Деталь A1", qty: 2, scanned: 0, missing: false }] },
    },
  };
  db.driverRoutes = [route];
  const scan = async (payload) => {
    Object.assign(body, { clientIndex: 0 }, payload || {});
    const res = {};
    await h({ headers: {}, url: "/api/routes/r1/waybill/scan" }, res, "/api/routes/r1/waybill/scan", "POST", user, true);
    return res;
  };
  const bind = async (payload) => {
    Object.assign(body, { clientIndex: 0 }, payload || {});
    const res = {};
    await h({ headers: {}, url: "/api/routes/r1/waybill/bind" }, res, "/api/routes/r1/waybill/bind", "POST", user, true);
    return res;
  };
  return { db, body, route, scan, bind, h };
}

test("ТСД: скан с переданным box привязывает деталь к боксу", async () => {
  const c = make();
  const res = await c.scan({ art: "A1", box: "BGr1-1-1" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
  assert.strictEqual(res._json.obj.item.box, "BGr1-1-1", "деталь привязана к боксу");
  assert.strictEqual(c.route.waybills[0].items[0].box, "BGr1-1-1");
});

test("РЕПРОДУКЦИЯ: ТСД выбрал бокс на экране, но box НЕ передан в запрос -> деталь засчитана, НО БЕЗ бокса", async () => {
  const c = make();
  const res = await c.scan({ art: "A1" }); // box отсутствует: ТСД шлёт только артикул
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1, "деталь засчитана");
  assert.ok(!res._json.obj.item.box, "БАГ: деталь не привязалась к боксу (box пуст/undefined)");
});

test("РЕПРОДУКЦИЯ: компьютерный сканер шлёт box пустой строкой -> деталь без привязки", async () => {
  const c = make();
  const res = await c.scan({ art: "A1", box: "" });
  assert.strictEqual(res._json.status, 200);
  assert.ok(!res._json.obj.item.box, "empty box -> нет привязки");
});

test("РЕПРОДУКЦИЯ: активный бокс клиента не долетел (null/undefined) -> деталь без бокса", async () => {
  const c = make();
  const res = await c.scan({ art: "A1", box: null });
  assert.strictEqual(res._json.status, 200);
  assert.ok(!res._json.obj.item.box, "null box -> не привязана");
});

test("РЕПРОДУКЦИЯ: активный бокс клиента назван иначе (activeBox) -> сервер его не видит", async () => {
  const c = make();
  const res = await c.scan({ art: "A1", activeBox: "BGr1-1-1" }); // неверное имя поля
  assert.strictEqual(res._json.status, 200);
  assert.ok(!res._json.obj.item.box, "сервер читает body.box, а не activeBox");
});

test("РЕПРОДУКЦИЯ: невалидный/пробельный box -> деталь без привязки", async () => {
  const c = make();
  const res = await c.scan({ art: "A1", box: "   " });
  assert.strictEqual(res._json.status, 200);
  assert.ok(!res._json.obj.item.box, "trim -> пустой, не привязано");
});

test("bind явно привязывает уже засчитанную деталь к боксу (обходной путь)", async () => {
  const c = make();
  await c.scan({ art: "A1" }); // засчитали без бокса
  assert.ok(!c.route.waybills[0].items[0].box, "до bind нет бокса");
  const res = await c.bind({ art: "A1", box: "BGr1-1-2" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.box, "BGr1-1-2", "bind привязал к боксу");
  assert.strictEqual(c.route.waybills[0].items[0].scanned, 1, "счёт не изменился при bind");
});

test("bind без бокса -> 422 (нужен бокс)", async () => {
  const c = make();
  const res = await c.bind({ art: "A1", box: "" });
  assert.strictEqual(res._json.status, 422);
});

test("вторая штука той же детали привязывается к тому же переданному боксу", async () => {
  const c = make();
  await c.scan({ art: "A1", box: "BGr1-1-1", qty: 2 });
  assert.strictEqual(c.route.waybills[0].items[0].scanned, 2);
  assert.strictEqual(c.route.waybills[0].items[0].box, "BGr1-1-1");
});

test("деталь, собранная с боксом, остаётся привязанной после повторного скана", async () => {
  const c = make();
  await c.scan({ art: "A1", box: "BGr1-1-3" });
  await c.scan({ art: "A1", box: "BGr1-1-3" }); // строка собранной детали -> rebound в тот же бокс
  const it = c.route.waybills[0].items[0];
  assert.strictEqual(it.box, "BGr1-1-3", "привязка сохраняется при rebound");
  assert.strictEqual(it.scanned, 2, "счёт до остатка");
});

test("скан партстикера сразу засчитывает его количество (partQty)", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "5825437000", name: "РЕГУЛЯТОР", qty: 4, scanned: 0, missing: false, partsticker: "000000000020217/3", partQty: 1 }];
  const res = await c.scan({ art: "000000000020217/3" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
  assert.strictEqual(res._json.obj.left, 3);
});

test("скан артикула без партстикера остаётся старой логикой (qty=1)", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "5825437000", name: "РЕГУЛЯТОР", qty: 4, scanned: 0, missing: false, partsticker: "", partQty: 0 }];
  const res = await c.scan({ art: "5825437000" });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.item.scanned, 1);
});

test("скан сокращённого партстикера (20217/4) засчитывается как полный (000000000020217/4)", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "353102B000", name: "ФОРСУНКА", qty: 4, scanned: 0, missing: false, partsticker: "000000000020217/4", partQty: 1 }];
  const res = await c.scan({ art: "20217/4" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.item.scanned, 1);
});

test("rebound (перепривязка в другой бокс) снимает пометку «не найдено»", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "A1", name: "Деталь", qty: 1, scanned: 1, missing: true, missingQty: 1, box: "БоксА" }];
  const res = await c.scan({ art: "A1", box: "БоксБ" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.rebound, true);
  const it = c.route.waybills[0].items[0];
  assert.strictEqual(it.box, "БоксБ");
  assert.strictEqual(it.missing, false, "размещение в бокс снимает «не найдено»");
  assert.strictEqual(it.missingQty, 0);
});

test("bind (привязка к боксу) снимает пометку «не найдено»", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "A1", name: "Деталь", qty: 1, scanned: 1, missing: true, missingQty: 1 }];
  const res = await c.bind({ art: "A1", box: "БоксС" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  const it = c.route.waybills[0].items[0];
  assert.strictEqual(it.box, "БоксС");
  assert.strictEqual(it.missing, false, "размещение в бокс снимает «не найдено»");
  assert.strictEqual(it.missingQty, 0);
});

test("delete-unscanned (админ) удаляет не собранные строки, собранные остаются", async () => {
  const c = make();
  c.route.waybills[0].items = [
    { art: "A1", name: "Д1", qty: 2, scanned: 2, missing: false },
    { art: "A2", name: "Д2", qty: 3, scanned: 1, missing: false },
    { art: "A3", name: "Д3", qty: 2, scanned: 0, missing: true, missingQty: 2 }, // «не найдено», собрано 0
    { art: "A4", name: "Д4", qty: 1, scanned: 0, missing: false },               // дубль, собрано 0
  ];
  Object.assign(c.body, { clientIndex: 0 });
  const res = {};
  await c.h({ headers: {}, url: "/api/routes/r1/waybill/delete-unscanned" }, res,
    "/api/routes/r1/waybill/delete-unscanned", "POST", { id: "u1", name: "Админ" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(res._json.obj.removed, 2, "удалены 2 не собранные строки");
  const items = c.route.waybills[0].items;
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].art, "A1");
  assert.strictEqual(items[1].art, "A2");
});

test("delete-unscanned без прав админа -> 403", async () => {
  const c = make();
  c.route.waybills[0].items = [{ art: "A1", name: "Д1", qty: 1, scanned: 0, missing: false }];
  Object.assign(c.body, { clientIndex: 0 });
  const res = {};
  await c.h({ headers: {}, url: "/api/routes/r1/waybill/delete-unscanned" }, res,
    "/api/routes/r1/waybill/delete-unscanned", "POST", { id: "u2", name: "Сотрудник" }, false);
  assert.strictEqual(res._json.status, 403, "не админ не может чистить");
});

test("delete-unscanned чистит записи «не найдено» в scanLog удалённых артикулов", async () => {
  const c = make();
  c.route.waybills[0].items = [
    { art: "A1", name: "Д1", qty: 2, scanned: 2, missing: false },
    { art: "A3", name: "Д3", qty: 2, scanned: 0, missing: true, missingQty: 2 },
  ];
  c.db.scanLog = [
    { action: "waybill", missing: true, code: "A3", qty: 2, ts: Date.now() },   // удаляемый артикул
    { action: "waybill", missing: false, code: "A1", qty: 2, ts: Date.now() },  // собранный — не трогаем
  ];
  Object.assign(c.body, { clientIndex: 0 });
  const res = {};
  await c.h({ headers: {}, url: "/api/routes/r1/waybill/delete-unscanned" }, res,
    "/api/routes/r1/waybill/delete-unscanned", "POST", { id: "u1", name: "Админ" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.ok(!c.db.scanLog.some((e) => e.action === "waybill" && e.missing && String(e.code) === "A3"),
    "missing-запись удалённого артикула убрана из scanLog");
  assert.ok(c.db.scanLog.some((e) => e.action === "waybill" && !e.missing && String(e.code) === "A1"),
    "успешный скан собранной детали сохранён");
});
