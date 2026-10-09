// Юнит-тесты модуля routes/auth.js — вход/выход/смена пароля.
const { test } = require("node:test");
const assert = require("node:assert");
const createAuthHandler = require("../routes/auth");

function make(overrides) {
  return createAuthHandler(Object.assign({
    getDb: () => ({ admins: [], staff: [{ id: "1", name: "Иван", login: "ivan" }] }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    staffByFio: (n) => (n ? [{ id: "1" }] : []),
    staffById: (id) => (id === "1" ? { id: "1", name: "Иван" } : null),
    staffByLogin: (l) => (l === "ivan" ? { id: "1", name: "Иван", login: "ivan", passSalt: "s", passHash: "h" } : null),
    hashPassword: (p) => ({ salt: "s", hash: p }),
    createSession: (id) => "tok-" + id,
    setAuthCookie: () => {},
    clearAuthCookie: () => {},
    cookieValue: (c, n) => "tok-1",
    SESSIONS: new Map([["tok-1", { staffId: "1", exp: Date.now() + 1e9 }]]),
    sessionUserFromCookie: () => ({ id: "1", name: "Иван", role: "MEMBER" }),
    identity: () => ({ id: "1", name: "Иван" }),
    namesMatch: () => true,
    verifyPassword: () => true,
    loginRate: {},
    saveSessionsToDisk: () => {},
    AUTH_COOKIE: "s",
  }, overrides || {}));
}

test("POST /api/auth/me возвращает пользователя", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/auth/me", "GET", null);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.user.name, "Иван");
  assert.strictEqual(res._json.obj.required, true);
});

test("POST /api/auth/logout выходит (200)", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/auth/logout", "POST", null);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.ok, true);
});

test("POST /api/auth/find-by-name ищет сотрудника по ФИО", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/auth/find-by-name", "POST", null);
  assert.strictEqual(res._json.status, 200);
  assert.ok(Array.isArray(res._json.obj.users));
});

test("POST /api/auth/change-password без пароля -> 409", async () => {
  const h = make({ readBody: async () => ({ currentPassword: "x", newPassword: "12345678" }) });
  const res = {};
  await h({ headers: {} }, res, "/api/auth/change-password", "POST", null);
  assert.strictEqual(res._json.status, 409); // учётка не задана (passHash отсутствует у st)
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", null);
  assert.strictEqual(r, false);
});
