// Юнит-тесты модуля routes/staff.js — сотрудники, оклады, премии, удаление, блокировка.
const { test } = require("node:test");
const assert = require("node:assert");
const createStaffHandler = require("../routes/staff");

function make(ctx) {
  return createStaffHandler(Object.assign({
    getDb: () => ({ staff: [], admins: [], days: {}, log: [], blocked: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    crypto: { randomBytes: () => Buffer.from("abc", "hex") },
    setStaffPayMonth: () => {},
    normalizeMonthKey: (m) => m,
    purgeStaffFromGroups: () => {},
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("POST /api/staff создаёт сотрудника", async () => {
  const db = { staff: [], admins: [], days: {}, log: [], blocked: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ name: "Иван" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/staff" }, res, "/api/staff", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.staff.length, 1);
});

test("POST /api/staff без имени -> 422", async () => {
  const h = make({ readBody: async () => ({}) });
  const res = {};
  await h({ headers: {}, url: "/api/staff" }, res, "/api/staff", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("POST /api/staff не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/staff" }, res, "/api/staff", "POST", { id: "u" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/staff/salary неизвестный -> 404", async () => {
  const h = make({ readBody: async () => ({ id: "nope" }) });
  const res = {};
  await h({ headers: {}, url: "/api/staff/salary" }, res, "/api/staff/salary", "POST", admin, true);
  assert.strictEqual(res._json.status, 404);
});

test("DELETE /api/staff/:id не свою отметку не даёт (сам себя)", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/staff/a1" }, res, "/api/staff/a1", "DELETE", admin, true);
  assert.strictEqual(res._json.status, 400);
});

test("POST /api/admin/staff/block без id -> 422", async () => {
  const h = make({ readBody: async () => ({}) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/staff/block" }, res, "/api/admin/staff/block", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
