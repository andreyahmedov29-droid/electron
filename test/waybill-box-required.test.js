// Воспроизведение живой ошибки сборки «Ярпартс»: деталь с количеством (>1 шт)
// засчитывается ЧЕРЕЗ ОБЩУЮ модалку ввода количества (qtyrequest/qtyresolve).
// 1) Путь qtyresolve не проверял «выбран ли бокс» и не требовал бокс → через раз
//    деталь засчитывалась БЕЗ бокса (когда активный бокс "слетел"/второе устройство).
// 2) qtyresolve не писал logWaybillScan → в логах сканирования нет.
// Тесты фиксируют ЖЕЛАЕМОЕ поведение: бокс обязателен, скан логируется.
const { test } = require("node:test");
const assert = require("node:assert");
const createWaybillHandler = require("../routes/waybill");

function harness() {
  const db = { driverRoutes: [], labels: [] };
  const body = {};
  const logged = [];
  const h = createWaybillHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    parseXlsxItems: () => ({ items: [{ art: "A1", name: "Деталь", qty: 1 }], buyer: "" }),
    logWaybillScan: (...args) => { logged.push(args); },
    artNorm: (a) => String(a || "").trim().replace(/\s+/g, " ").toLowerCase(),
    listWaybillBoxes: () => [],
    isAdmin: () => false,
    isModerator: () => false,
  });
  const user = { id: "u1", name: "Склад" };
  const call = async (path, method, payload) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: path }, res, path, method, user, true);
    return res;
  };
  return { db, call, logged };
}
const routeWith = (items) => ({ id: "r1", clients: [{ client: "К" }], waybills: { 0: { items } } });

test("qtyresolve БЕЗ бокса НЕ засчитывает (бокс обязателен)", async () => {
  const c = harness();
  c.db.driverRoutes = [routeWith([{ art: "A1", qty: 5, scanned: 0, missing: false }])];
  await c.call("/api/routes/r1/waybill/qtyrequest", "POST", { clientIndex: 0, art: "A1" });
  const res = await c.call("/api/routes/r1/waybill/qtyresolve", "POST", { clientIndex: 0, art: "A1", qty: 2 });
  assert.strictEqual(res._json.status, 400, "без бокса засчитывать нельзя (сейчас баг: 200)");
  const it = c.db.driverRoutes[0].waybills[0].items[0];
  assert.strictEqual(it.scanned, 0, "счёт не меняется без бокса");
  assert.ok(!it.box, "бокс не привязан");
  assert.strictEqual(c.logged.length, 0, "без бокса лог не пишется");
});

test("qtyresolve с боксом привязывает бокс и ПИШЕТ ЛОГ (сейчас баг: нет лога)", async () => {
  const c = harness();
  c.db.driverRoutes = [routeWith([{ art: "A1", qty: 5, scanned: 0, missing: false }])];
  await c.call("/api/routes/r1/waybill/qtyrequest", "POST", { clientIndex: 0, art: "A1", box: "Бокс1" });
  const res = await c.call("/api/routes/r1/waybill/qtyresolve", "POST", { clientIndex: 0, art: "A1", qty: 2 });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  const it = c.db.driverRoutes[0].waybills[0].items[0];
  assert.strictEqual(it.scanned, 2);
  assert.strictEqual(it.box, "Бокс1", "бокс берётся из qtyrequest (pending) — второе устройство тоже привяжет");
  assert.strictEqual(c.logged.length, 1, "успешный скан залогирован (сейчас баг: 0)");
});

test("qtyresolve не требует НОВЫЙ бокс, если деталь уже привязана к боксу", async () => {
  const c = harness();
  c.db.driverRoutes = [routeWith([{ art: "A1", qty: 3, scanned: 1, missing: false, box: "БоксX" }])];
  const res = await c.call("/api/routes/r1/waybill/qtyresolve", "POST", { clientIndex: 0, art: "A1", qty: 2 });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(c.db.driverRoutes[0].waybills[0].items[0].scanned, 3);
  assert.strictEqual(c.db.driverRoutes[0].waybills[0].items[0].box, "БоксX", "бокс не отвязан");
});

test("qtyresolve логирует и привязывает бокс переданный в body (без pending box)", async () => {
  const c = harness();
  c.db.driverRoutes = [routeWith([{ art: "A1", qty: 4, scanned: 0, missing: false }])];
  const res = await c.call("/api/routes/r1/waybill/qtyresolve", "POST", { clientIndex: 0, art: "A1", qty: 2, box: "B2" });
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(c.db.driverRoutes[0].waybills[0].items[0].box, "B2");
  assert.strictEqual(c.logged.length, 1, "скан залогирован");
});
