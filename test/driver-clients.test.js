// Юнит-тесты модуля routes/driver-clients.js — справочник клиентов для маршрутов.
const { test } = require("node:test");
const assert = require("node:assert");
const createDriverClientsHandler = require("../routes/driver-clients");

function make(ctx) {
  return createDriverClientsHandler(Object.assign({
    getDb: () => ({ driverClients: [], driverRoutes: [] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    persistDb: async () => {},
    geocodeLackingClients: () => {},
    ensureClientCoords: async () => {},
  }, ctx || {}));
}

const admin = { id: "a1", name: "Админ" };

test("GET /api/drivers/clients не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "GET", { id: "u" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/clients админ -> clients []", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "GET", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.deepStrictEqual(res._json.obj.clients, []);
});

test("POST /api/drivers/clients создаёт клиента", async () => {
  const db = { driverClients: [], driverRoutes: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ client: "Клиент", address: "Ул. 1" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.clients.length, 1);
});

test("POST /api/drivers/clients сохраняет ИНН и буквенный логин", async () => {
  const db = { driverClients: [], driverRoutes: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ client: "Клиент", address: "Ул. 1", inn: "7701234567", login: "KLIENT01" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "POST", admin, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.clients[0].inn, "7701234567");
  assert.strictEqual(res._json.obj.clients[0].login, "KLIENT01");
});

test("POST /api/drivers/clients без адреса -> 400", async () => {
  const h = make({ readBody: async () => ({ client: "Клиент" }) });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "POST", admin, true);
  assert.strictEqual(res._json.status, 400);
});

test("POST bundle менее двух клиентов -> 422", async () => {
  const db = { driverClients: [{ id: "c1" }], driverRoutes: [] };
  const h = make({
    getDb: () => db,
    readBody: async () => ({ action: "bundle", ids: ["c1"], address: "Общий адрес" }),
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/clients" }, res, "/api/drivers/clients", "POST", admin, true);
  assert.strictEqual(res._json.status, 422);
});

test("POST /api/clients/:id/logo несуществующий клиент -> 404", async () => {
  const h = make({ readBody: async () => ({ logo: "data:image/png;base64,AA==" }) });
  const res = {};
  await h({ headers: {}, url: "/api/clients/nope/logo" }, res, "/api/clients/nope/logo", "POST", admin, true);
  assert.strictEqual(res._json.status, 404);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", admin, true);
  assert.strictEqual(r, false);
});
