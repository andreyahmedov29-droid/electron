// Юнит-тесты модуля routes/params.js — сохранение параметров.
const { test } = require("node:test");
const assert = require("node:assert");
const createParamsHandler = require("../routes/params");

function make(readBody) {
  return createParamsHandler({
    getDb: () => ({ params: {}, staff: [], groups: [] }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: readBody || (async () => ({})),
    keepGroupParamIds: (a) => a || [],
    keepStaffParamIds: (a) => a || [],
  });
}

test("POST /api/params не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/params", "POST", false);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/params сохраняет булевы параметры", async () => {
  const db = { params: {} };
  const h = createParamsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status) => { res._json = { status }; },
    readBody: async () => ({ showOverHours: true, allowFinishUnloadIncomplete: true }),
    keepGroupParamIds: (a) => a || [],
    keepStaffParamIds: (a) => a || [],
  });
  const res = {};
  await h({ headers: {} }, res, "/api/params", "POST", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.params.showOverHours, true);
  assert.strictEqual(db.params.allowFinishUnloadIncomplete, true);
});

test("POST /api/params валидирует scanLogLimit в диапазоне", async () => {
  const db = { params: {} };
  const h = createParamsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status) => { res._json = { status }; },
    readBody: async () => ({ scanLogLimit: 5000000 }),
    keepGroupParamIds: (a) => a || [],
    keepStaffParamIds: (a) => a || [],
  });
  const res = {};
  await h({ headers: {} }, res, "/api/params", "POST", true);
  assert.strictEqual(db.params.scanLogLimit, 200000);
});

test("POST /api/params отфильтровывает невалидные multRules", async () => {
  const db = { params: {}, groups: [{ id: "g-1" }], staff: [{ id: "s-1" }] };
  const h = createParamsHandler({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status) => { res._json = { status }; },
    readBody: async () => ({
      multRules: [
        { id: "a", target: "staff", targetId: "s-1", mult: 2, date: "2026-10-04", from: "09:00", to: "18:00" },
        { id: "b", target: "staff", targetId: "nonexistent", mult: 2, date: "2026-10-04", from: "09:00", to: "18:00" },
        { id: "c", target: "all", targetId: null, mult: 1, date: "2026-10-04", from: "09:00", to: "18:00" },
      ],
    }),
    keepGroupParamIds: (a) => a || [],
    keepStaffParamIds: (a) => a || [],
  });
  const res = {};
  await h({ headers: {} }, res, "/api/params", "POST", true);
  // остаётся только валидное правило для существующего сотрудника
  assert.strictEqual(db.params.multRules.length, 1);
  assert.strictEqual(db.params.multRules[0].id, "a");
});
