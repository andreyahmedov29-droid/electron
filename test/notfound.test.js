// Юнит-тесты модуля routes/notfound.js — «Проблемы со склада».
const { test } = require("node:test");
const assert = require("node:assert");
const createNotfoundHandler = require("../routes/notfound");

function make(ctx) {
  return createNotfoundHandler(Object.assign({
    getDb: () => ({ driverRoutes: [], scanLog: [], notFound: {} }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    canSeeNotfound: (u) => !!(u && u.see),
    alignWaybillsToClients: () => {},
    persistNotFoundStatuses: async () => {},
    isAdmin: () => true,
  }, ctx || {}));
}

test("GET /api/notfound без доступа -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: false });
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/notfound пустой отчёт -> 200, 0 строк", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.rows, []);
});

test("GET /api/notfound собирает строки из накладных (missing)", async () => {
  const route = {
    id: "r1", at: Date.parse("2026-10-02T10:00:00"),
    clients: [{ client: "АвтоМ", address: "ул. Т" }],
    waybills: [{ items: [{ art: "A1", name: "Деталь", missing: true, missingQty: 1, qty: 1 }] }],
  };
  const h = make({ getDb: () => ({ driverRoutes: [route], scanLog: [], notFound: {} }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1);
  assert.strictEqual(res._json.obj.rows[0].client, "АвтоМ");
  assert.strictEqual(res._json.obj.rows[0].art, "A1");
});

test("POST /api/notfound сохраняет статус и комментарий", async () => {
  const db = { driverRoutes: [], scanLog: [], notFound: {} };
  let nfSaved = 0;
  const h = make({
    getDb: () => db,
    persistNotFoundStatuses: async () => { nfSaved += 1; },
    readBody: async () => ({ key: "АвтоМ|A1", status: "Выполнено", comment: "ок" }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "POST", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.notFound["АвтоМ|A1"].status, "Выполнено");
  assert.ok(nfSaved >= 1);
});

test("POST /api/notfound action=delete удаляет запись и связанные missing-записи scanLog", async () => {
  const db = {
    driverRoutes: [],
    scanLog: [{ action: "waybill", missing: true, code: "A1", qty: 1, ts: Date.parse("2026-10-02T09:00:00") }],
    notFound: { "АвтоМ|A1": { status: "Выполнено", comment: "ок" } },
  };
  const h = make({ getDb: () => db, readBody: async () => ({ action: "delete", key: "АвтоМ|A1" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "POST", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.ok(!db.notFound["АвтоМ|A1"], "статус удалён");
  assert.ok(!db.scanLog.some((e) => e.action === "waybill" && e.missing && String(e.code) === "A1"),
    "missing-запись артикула убрана из scanLog");
});

test("POST /api/notfound action=delete не-адресам -> 403", async () => {
  const db = {
    driverRoutes: [],
    scanLog: [{ action: "waybill", missing: true, code: "A1", qty: 1, ts: Date.parse("2026-10-02T09:00:00") }],
    notFound: { "АвтоМ|A1": { status: "Новая проблема" } },
  };
  const h = make({
    getDb: () => db,
    isAdmin: () => false,
    readBody: async () => ({ action: "delete", key: "АвтоМ|A1" }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "POST", { see: true });
  assert.strictEqual(res._json.status, 403, "удалять может только админ");
  assert.ok(db.notFound["АвтоМ|A1"], "запись не удалена");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { see: true });
  assert.strictEqual(r, false);
});

const T = () => Date.parse("2026-10-05T09:00:00");

test("missing-запись в scanLog попадает в отчёт «Проблемы склада», если деталь НЕ приняли", async () => {
  const h = make({ getDb: () => ({
    driverRoutes: [], scanLog: [{ action: "waybill", missing: true, code: "A1", qty: 5, ts: T() }], notFound: {},
  }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1, "пометка без приёма остаётся проблемой");
  assert.strictEqual(res._json.obj.rows[0].art, "A1");
});

test("missing-запись НЕ попадает в отчёт, если ПОСЛЕ пометки деталь приняли (баг-кейс)", async () => {
  const h = make({ getDb: () => ({
    driverRoutes: [],
    scanLog: [
      { action: "waybill", missing: true, code: "A1", qty: 5, ts: T() },
      { action: "waybill", missing: false, code: "A1", ts: T() + 60000 }, // приём позже
    ],
    notFound: {},
  }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 0, "принятая после пометки деталь — не проблема");
});

test("missing-запись остаётся в отчёте, если успешный скан был РАНЬШЕ пометки", async () => {
  const h = make({ getDb: () => ({
    driverRoutes: [],
    scanLog: [
      { action: "waybill", missing: false, code: "A1", ts: T() - 60000 }, // приняли раньше
      { action: "waybill", missing: true, code: "A1", qty: 5, ts: T() },   // потом пометили
    ],
    notFound: {},
  }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.obj.rows.length, 1, "пометка после приёма — реальная проблема");
});

test("missing-запись остаётся в отчёте, если приняли ДРУГОЙ код (код не тот)", async () => {
  const h = make({ getDb: () => ({
    driverRoutes: [],
    scanLog: [
      { action: "waybill", missing: true, code: "A1", qty: 5, ts: T() },
      { action: "waybill", missing: false, code: "B2", ts: T() + 60000 },
    ],
    notFound: {},
  }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.obj.rows.length, 1);
  assert.strictEqual(res._json.obj.rows[0].art, "A1");
});

test("позиция «не найдено», но уже размещена в БОКС — НЕ в «Проблемах склада» (актуализация)", async () => {
  const route = {
    id: "r1", at: Date.parse("2026-10-02T10:00:00"),
    clients: [{ client: "АвтоМ", address: "ул. Т" }],
    waybills: [{ items: [
      { art: "A1", name: "Д1", missing: true, missingQty: 1, qty: 1, box: "Бокс 10" }, // размещена -> не проблема
      { art: "A2", name: "Д2", missing: true, missingQty: 1, qty: 1 },                  // не размещена -> проблема
    ] }],
  };
  const h = make({ getDb: () => ({ driverRoutes: [route], scanLog: [], notFound: {} }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1, "только неразмещённая позиция");
  assert.strictEqual(res._json.obj.rows[0].art, "A2");
});

test("старая запись «не найдено» по артикулу, который СЕЙЧАС собран — не в отчёте (актуализация)", async () => {
  // Артикул A1 сейчас собран (scanned=1, не missing), хотя в логе есть давняя
  // пометка «не найдено» (код мог писаться партистикером — accept не совпал).
  const route = {
    id: "r1", at: Date.parse("2026-10-02T10:00:00"),
    clients: [{ client: "АвтоМ", address: "ул. Т" }],
    waybills: [{ items: [{ art: "A1", name: "Д1", qty: 1, scanned: 1, missing: false, box: "Бокс 1" }] }],
  };
  const h = make({ getDb: () => ({
    driverRoutes: [route],
    scanLog: [{ action: "waybill", missing: true, code: "A1", qty: 1, ts: Date.parse("2026-10-01T09:00:00") }],
    notFound: {},
  }) });
  const res = {};
  await h({ headers: {} }, res, "/api/notfound", "GET", { see: true });
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 0, "собранный артикул не должен быть в «Проблемах склада»");
});
