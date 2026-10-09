// Обширные тесты СБОРКИ с партисткерами (routes/waybill.js).
// Общие правила (вариант А):
//  - каждый партисткер — уникальная порция; при скане засчитывается его quantity;
//  - повторный скан того же партисткера НЕ засчитывается (уже собран);
//  - quantity == цель строки (строка = порция); shipment_quantity — контроль (не в строке);
//  - короткая форма кода (20217/1) == полная (000000000020217/1);
//  - если у позиции нет партисткера — скан по артикулу (по 1 / поштучно).
const { test } = require("node:test");
const assert = require("node:assert");
const createWaybillHandler = require("../routes/waybill");

const RU_LOOK = { "А": "A", "а": "a", "В": "B", "в": "b", "С": "C", "с": "c", "Е": "E", "е": "e" };
function make(items) {
  const db = { driverRoutes: [], labels: [] };
  const body = {};
  const h = createWaybillHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    parseXlsxItems: () => ({ items: [], buyer: "" }),
    logWaybillScan: () => {},
    artNorm: (s) => String(s == null ? "" : s).replace(/[\s_.\-,:/;\\]/g, ""),
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  });
  const route = {
    id: "r1",
    clients: [{ client: "Клиент А", address: "Ул. 1", labelQty: 3 }],
    waybills: { 0: { items } },
  };
  db.driverRoutes = [route];
  const scan = async (payload) => {
    Object.assign(body, { clientIndex: 0 }, payload || {});
    const res = {};
    await h({ headers: {}, url: "/api/routes/r1/waybill/scan" }, res, "/api/routes/r1/waybill/scan", "POST", { id: "u1", name: "Склад" }, true);
    return res;
  };
  return { db, route, scan, items };
}

const it0 = (c) => c.route.waybills[0].items[0];

// -------- Партисткер: скан засчитывает его quantity за один раз ------------
for (let p = 1; p <= 40; p++) {
  const full = `000000000020217/${p}`;
  const short = `20217/${p}`;
  const item = { art: "ART1", name: "Деталь", qty: p, scanned: 0, missing: false, partsticker: full, partQty: p };

  test(`партстикер qty=${p}: полная форма засчитывает ${p} шт`, async () => {
    const c = make([{ ...item }]);
    const r = await c.scan({ art: full });
    assert.strictEqual(r._json.status, 200, JSON.stringify(r._json));
    assert.strictEqual(it0(c).scanned, p);
  });

  test(`партстикер qty=${p}: короткая форма (${short}) засчитывает ${p} шт`, async () => {
    const c = make([{ ...item }]);
    const r = await c.scan({ art: short });
    assert.strictEqual(r._json.status, 200, JSON.stringify(r._json));
    assert.strictEqual(it0(c).scanned, p);
  });

  test(`партстикер qty=${p}: повторный скан НЕ засчитывает (already)`, async () => {
    const c = make([{ ...item }]);
    const r1 = await c.scan({ art: full });
    assert.strictEqual(it0(c).scanned, p);
    await c.scan({ art: full });
    assert.strictEqual(it0(c).scanned, p, "повторный скан не должен увеличить счёт");
    assert.deepStrictEqual(r1._json.status, 200);
  });

  test(`артикул qty=${p} без партистекара: скан по 1 шт`, async () => {
    const c = make([{ art: "ART1", name: "Деталь", qty: p, scanned: 0, missing: false, partsticker: "", partQty: 0 }]);
    const r = await c.scan({ art: "ART1" });
    assert.strictEqual(r._json.status, 200, JSON.stringify(r._json));
    assert.strictEqual(it0(c).scanned, 1);
  });

  test(`партстикер qty=${p}: скан с боксом привязывает порцию к боксу`, async () => {
    const c = make([{ ...item }]);
    const r = await c.scan({ art: full, box: "BGR1" });
    assert.strictEqual(r._json.status, 200);
    assert.strictEqual(it0(c).box, "BGR1");
    assert.strictEqual(it0(c).scanned, p);
  });
}

// -------- Несколько порций одного артикула (сумма = контроль) ------------
for (let n = 1; n <= 20; n++) {
  test(`несколько порций одного артикула (${n} порций): все засчитываются`, async () => {
    const items = [];
    for (let i = 0; i < n; i++) {
      items.push({ art: "ART1", name: "Деталь", qty: 1, scanned: 0, missing: false, partsticker: `000000000020217/${i + 1}`, partQty: 1 });
    }
    const c = make(items);
    let failed = 0;
    for (let i = 0; i < n; i++) {
      const r = await c.scan({ art: `20217/${i + 1}` });
      if (r._json.status !== 200) failed++;
    }
    const done = items.reduce((a, x) => a + (Number(x.scanned) || 0), 0);
    assert.strictEqual(done, n, "каждая порция даёт 1, всего n");
    assert.strictEqual(failed, 0);
  });
}

test("партстикер с неизвестным кодом -> не найден/собран (не увеличивает счёт)", async () => {
  const c = make([{ art: "ART1", name: "Деталь", qty: 2, scanned: 0, missing: false, partsticker: "000000000020217/1", partQty: 2 }]);
  const r = await c.scan({ art: "999999/9" });
  assert.ok(r._json.status === 404 || r._json.status === 409);
  assert.strictEqual(it0(c).scanned, 0);
});
