// Юнит-тесты модуля routes/me-state.js — /api/me и /api/state.
const { test } = require("node:test");
const assert = require("node:assert");
const createMeStateHandler = require("../routes/me-state");

function make(ctx) {
  return createMeStateHandler(Object.assign({
    getDb: () => ({ staff: [], groups: [], days: {}, blocked: [], admins: [], params: {}, norm: {}, salaryMonth: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    persistDb: async () => {},
    serverTzOffset: () => 180,
    ensureStaffRecord: () => false,
    maybeFreezePrevMonth: () => false,
    adminDiag: (u) => ({ isAdmin: false }),
    isAdmin: () => false,
    isModerator: () => false,
    syncDirectory: () => {},
    groupsOfModerator: () => [],
    isDriver: () => false,
    isLoader: () => false,
    staffSeesOver: () => false,
    visibleStaff: () => [],
    visibleDays: () => ({}),
    visibleLog: () => [],
    canManageShipment: () => false,
    canSeeShipment: () => false,
    canSeeNotfound: () => false,
    canSeeLogs: () => false,
  }, ctx || {}));
}

const user = { id: "u1", name: "Петя", role: "member" };

test("GET /api/me -> 200 c id/name", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/me" }, res, "/api/me", "GET", user);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.id, "u1");
  assert.strictEqual(res._json.obj.name, "Петя");
});

test("GET /api/state -> 200 со списком сотрудников", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/state" }, res, "/api/state", "GET", user);
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.staff, []);
  assert.ok("serverOffsetMinutes" in res._json.obj);
});

test("GET /api/state админ видит все группы", async () => {
  const db = { staff: [], groups: [{ name: "A", memberIds: ["u1"] }], days: {}, blocked: [], admins: [], params: {}, norm: {}, salaryMonth: {} };
  const h = make({ getDb: () => db, isAdmin: () => true });
  const res = {};
  await h({ headers: {}, url: "/api/state" }, res, "/api/state", "GET", user);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.groups.length, 1);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", user);
  assert.strictEqual(r, false);
});
