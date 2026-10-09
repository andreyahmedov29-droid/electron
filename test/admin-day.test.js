// Юнит-тесты модуля routes/admin-day.js — админские правки дня.
const { test } = require("node:test");
const assert = require("node:assert");
const createAdminDayHandler = require("../routes/admin-day");

function make(ctx) {
  return createAdminDayHandler(Object.assign({
    getDb: () => ({ staff: [], days: {}, admins: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    canManageStatus: () => true,
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("PUT /api/admin/day с плохим ключом -> 422", async () => {
  const h = make({ readBody: async () => ({ key: "bad" }) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/day" }, res, "/api/admin/day", "PUT", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("PUT /api/admin/day неизвестный сотрудник -> 422", async () => {
  const h = make({ readBody: async () => ({ key: "2026-10-03", ownerId: "nope" }) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/day" }, res, "/api/admin/day", "PUT", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("PUT /api/admin/day без прав -> 403", async () => {
  const db = { staff: [{ id: "u1" }], days: {}, admins: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ key: "2026-10-03", ownerId: "u1" }),
    canManageStatus: () => false,
  });
  const res = {};
  await h({ headers: {}, url: "/api/admin/day" }, res, "/api/admin/day", "PUT", admin, true);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/admin/status с плохим ключом -> 422", async () => {
  const h = make({ readBody: async () => ({ key: "bad" }) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/status" }, res, "/api/admin/status", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("POST /api/admins не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/admins" }, res, "/api/admins", "POST", { id: "u" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
