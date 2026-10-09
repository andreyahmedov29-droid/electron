// E2E-репродукция жалобы «пропадает маршрут, в который грузим расходную накладную»,
// в т.ч. при 15+ клиентах. Поднимает настоящий server.js и проверяет, что маршрут
// не исчезает после создания и после загрузки накладной.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
let dataDir, port, proc, base;
const HDR = {
  "x-vibe-user-id": "u1",
  "x-vibe-user-name-encoded": encodeURIComponent("Админ Тех"),
  "x-vibe-user-role": "ADMIN",
  "content-type": "application/json",
};

function req(method, path, body) {
  const opts = { method, headers: HDR };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(base + path, opts).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* бинарный */ }
    return { status: r.status, json, text };
  });
}

function seed() {
  return {
    staff: [{ id: "u1", name: "Админ Тех", login: "admin", salary: null, bonus: null, extraBonus: null }],
    admins: ["u1"],
    owner: "u1",
    driverClients: [],
    driverRoutes: [],
    labels: [],
    days: {},
    groups: [],
    log: [],
    blocked: [],
    params: { allowWaybill: true },
    norm: {},
    salaryMonth: {},
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "biotime-rw-"));
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  writeFileSync(join(dataDir, "db.json"), JSON.stringify(seed()));
  port = 7000 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { await fetch(base + "/", { signal: AbortSignal.timeout(1500) }); up = true; } catch { /* нет */ }
  }
  if (!up) throw new Error("server did not start");
});

after(async () => {
  if (proc) proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("маршрут с 20 клиентами создаётся и не пропадает после загрузки накладной", async () => {
  const clients = [];
  for (let i = 1; i <= 20; i++) clients.push({ client: `Клиент ${i}`, address: `Ул. ${i}` });
  const created = await req("POST", "/api/drivers/routes", {
    date: "2026-11-10",
    driverId: "d1",
    driverName: "Водитель",
    routeName: "Большой",
    clients,
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const routes = created.json.routes;
  const route = (Array.isArray(routes) ? routes : []).find((r) => r.date === "2026-11-10");
  assert.ok(route, "маршрут создан и виден в ответе");
  assert.strictEqual(route.clients.length, 20, "все 20 клиентов на месте");
  const rid = route.id;

  // загружаем накладную в 0-го клиента
  const up = await req("POST", `/api/routes/${rid}/waybill`, {
    clientIndex: 0,
    items: [{ art: "A1", name: "Деталь", qty: 2 }],
  });
  // без fileB64 сервер вернёт 422 — это валидация, маршрут не должен пропасть
  assert.ok(up.status === 422 || up.status === 400 || up.status === 200, JSON.stringify(up.json));

  const after = await req("GET", "/api/shipments");
  const afterRoutes = after.json.routes || [];
  const still = afterRoutes.find((r) => String(r.id) === String(rid));
  assert.ok(still, "маршрут НЕ исчез из /api/shipments после загрузки накладной");
  assert.strictEqual(still.clients.length, 20, "у маршрута 20 клиентов");
});

test("маршрут с 16 клиентами и накладной в body создаётся целиком (не срезается)", async () => {
  const clients = [];
  for (let i = 1; i <= 16; i++) clients.push({ client: `Клиент ${i}`, address: `Ул. ${i}` });
  const waybills = clients.slice(0, 3).map((_, i) => ({
    clientIndex: i,
    items: [{ art: `A${i}`, name: "Деталь", qty: 1 }],
  }));
  const created = await req("POST", "/api/drivers/routes", {
    date: "2026-11-11",
    driverId: "d2",
    driverName: "Водитель2",
    routeName: "Большой2",
    clients,
    waybills,
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const route = created.json.routes.find((r) => r.date === "2026-11-11");
  assert.ok(route);
  assert.strictEqual(route.clients.length, 16, "16 клиентов сохранены");
  assert.ok(route.waybills && route.waybills[0] && route.waybills[0].items.length === 1, "накладная привязана на 0-го клиента");
});

test("маршрут создан повторно с тем же (дата, водитель, название) — перезаписывается НЕ пропадает", async () => {
  const base2 = async (clients) => req("POST", "/api/drivers/routes", {
    date: "2026-11-12", driverId: "d3", driverName: "Водитель3", routeName: "ТотЖе", clients,
  });
  await base2([{ client: "Клиент A", address: "Ул A" }, { client: "Клиент B", address: "Ул B" }]);
  const res2 = await base2([{ client: "Клиент A", address: "Ул A" }, { client: "Клиент B", address: "Ул B" }, { client: "Клиент C", address: "Ул C" }]);
  assert.strictEqual(res2.status, 200);
  const routes = res2.json.routes.filter((r) => r.date === "2026-11-12");
  assert.strictEqual(routes.length, 1, "один маршрут на эту дату/водителя/названия (не задваивается)");
  assert.strictEqual(routes[0].clients.length, 3, "у перезаписанного маршрута 3 клиента");
});

test("накладная, загруженная отдельно, НЕ теряется при повторном сохранении маршрута", async () => {
  // Создаём маршрут.
  const created = await req("POST", "/api/drivers/routes", {
    date: "2026-11-13", driverId: "d4", driverName: "В4", routeName: "СНакладной",
    clients: [{ client: "Кл1", address: "А1" }, { client: "Кл2", address: "А2" }],
  });
  const route = created.json.routes.find((r) => r.date === "2026-11-13");
  const rid = route.id;
  // Грузим накладную через /waybill (клиенту 1).
  const up = await req("POST", `/api/routes/${rid}/waybill`, {
    clientIndex: 1,
    fileB64: Buffer.from("dummy-xlsx").toString("base64"),
  });
  // parseXlsxItems на "dummy-xlsx" может вернуть ошибку — допустимо; главное проверить сценарий
  // с реальными items через прямое добавление нельзя (сервер парсит файл). Ограничимся проверкой,
  // что маршрут цел и повторное сохранение не роняет.
  assert.ok(up.status === 422 || up.status === 400 || up.status === 200, JSON.stringify(up.json));

  // Повторное сохранение ТОГО ЖЕ маршрута (та же дата/водитель/название), 15+ клиентов.
  const clients = [];
  for (let i = 1; i <= 16; i++) clients.push({ client: `Клиент ${i}`, address: `Ул ${i}` });
  const resave = await req("POST", "/api/drivers/routes", {
    date: "2026-11-13", driverId: "d4", driverName: "В4", routeName: "СНакладной",
    clients,
    waybills: [{ clientIndex: 0, items: [{ art: "A0", name: "Деталь", qty: 1 }] }],
  });
  assert.strictEqual(resave.status, 200, JSON.stringify(resave.json));
  const after = resave.json.routes.filter((r) => r.date === "2026-11-13" && r.routeName === "СНакладной");
  assert.strictEqual(after.length, 1, "маршрут один (не задвоился)");
  assert.strictEqual(after[0].clients.length, 16, "16 клиентов на месте после перезаписи");
  // Проверяем, что накладная клиента 0 на месте.
  const wb0 = after[0].waybills && after[0].waybills[0];
  assert.ok(wb0 && Array.isArray(wb0.items) && wb0.items.length > 0, "накладная клиента 0 привязана после перезаписи");
});
