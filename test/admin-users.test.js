// Юнит-тесты модуля routes/admin-users.js — админ-управление учётками.
const { test } = require("node:test");
const assert = require("node:assert");
const createAdminUsersHandler = require("../routes/admin-users");

function make(ctx) {
  return createAdminUsersHandler(Object.assign({
    getDb: () => ({ staff: [], groups: [], admins: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    isAdmin: () => true,
    rootAdminId: () => "root",
    staffById: () => null,
    staffByLogin: () => null,
    hashPassword: () => ({ salt: "s", hash: "h" }),
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("GET /api/admin/users не-админ -> 403", async () => {
  const h = make({ isAdmin: () => false });
  const res = {};
  await h({ headers: {}, url: "/api/admin/users" }, res, "/api/admin/users", "GET", { id: "u" }, true);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/admin/users админ -> users []", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/admin/users" }, res, "/api/admin/users", "GET", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.users, []);
  assert.strictEqual(res._json.obj.ownerId, "root");
});

test("POST /api/admin/users/credentials неизвестный пользователь -> 404", async () => {
  const h = make({ readBody: async () => ({ userId: "nope", login: "login1" }) });
  const res = {};
  await h({ headers: {}, url: "/api/admin/users/credentials" }, res, "/api/admin/users/credentials", "POST", admin, true);
  assert.strictEqual(res._json.status, 404);
});

test("POST /api/admin/users/credentials плохой логин -> 422", async () => {
  const h = make({
    readBody: async () => ({ userId: "u1", login: "" }),
    staffById: () => ({ id: "u1" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/admin/users/credentials" }, res, "/api/admin/users/credentials", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
