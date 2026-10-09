// Юнит-тесты модуля routes/logs.js — журнал сканов деталей.
const { test } = require("node:test");
const assert = require("node:assert");
const createLogsHandler = require("../routes/logs");

const fs = { existsSync: () => false, readdirSync: () => [], unlinkSync: () => {} };

function make(ctx) {
  return createLogsHandler(Object.assign({
    getDb: () => ({ barcodeLog: [], params: {} }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    appendBarcodeLog: () => {},
    readBarcodeLogs: () => [],
    fs,
    path: require("node:path"),
    BCODE_ARCHIVE_DIR: "/tmp/archive",
  }, ctx || {}));
}

test("POST /api/logs/barcode без юзера -> 401", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/logs/barcode", "POST", null, true);
  assert.strictEqual(res._json.status, 401);
});

test("POST /api/logs/barcode пишет запись скана", async () => {
  const db = { barcodeLog: [], params: {} };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ code: "A1", ok: false, client: "Клиент" }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/logs/barcode", "POST", { id: "7", name: "Иван" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.barcodeLog.length, 1);
  assert.strictEqual(db.barcodeLog[0].code, "A1");
  assert.strictEqual(db.barcodeLog[0].ok, false);
});

test("GET /api/logs/barcode не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/logs/barcode", "GET", { id: "7" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/logs/barcode админ -> список", async () => {
  const h = make({ readBarcodeLogs: () => [{ code: "A1", ok: false, ts: 1 }] });
  const res = {};
  await h({ headers: {}, url: "/api/logs/barcode?ok=false" }, res, "/api/logs/barcode", "GET", { id: "7" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows[0].code, "A1");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { id: "7" }, true);
  assert.strictEqual(r, false);
});
