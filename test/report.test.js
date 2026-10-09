// Юнит-тесты модуля routes/report.js — экспорт табеля.
const { test } = require("node:test");
const assert = require("node:assert");
const createReportHandler = require("../routes/report");

function make(ctx) {
  return createReportHandler(Object.assign({
    getDb: () => ({ staff: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    isAdmin: () => true,
    isModerator: () => false,
    timesheetRowsForMonth: () => ({ sheet: [], title: "Табель 2026-10" }),
    visibleStaff: () => [],
    buildXlsx: () => Buffer.from("xlsx"),
    MIME: { ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  }, ctx || {}));
}

const user = { id: "u1", name: "Петя" };

function fakeRes() {
  return { _ended: false, end(d) { this._ended = true; this._body = d; } };
}

test("GET /api/report/export без месяца -> 422", async () => {
  const h = make();
  const res = {};
  await h({ headers: { host: "x" }, url: "/api/report/export" }, res, "/api/report/export", "GET", user, true);
  assert.strictEqual(res._json.status, 422);
});

test("GET /api/report/export не-админ/модератор -> 403", async () => {
  const h = make({ isAdmin: () => false, isModerator: () => false });
  const res = {};
  await h({ headers: { host: "x" }, url: "/api/report/export?month=2026-10" }, res, "/api/report/export", "GET", user, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/report/export с месяцем -> отдаёт xlsx", async () => {
  const h = make();
  const res = fakeRes();
  res.writeHead = (s) => { this._s = s; };
  await h({ headers: { host: "x" }, url: "/api/report/export?month=2026-10" }, res, "/api/report/export", "GET", user, true);
  assert.strictEqual(res._ended, true);
  assert.strictEqual(res._body.toString(), "xlsx");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", user);
  assert.strictEqual(r, false);
});
