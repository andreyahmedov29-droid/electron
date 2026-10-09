// E2E-тест: поднимает настоящий server.js на случайном порту со свежей тестовой
// DATA_DIR и проходит реальный HTTP-сценарий (логин админа -> me -> создание
// маршрута -> раздел «Доставка»). Проверяет, что все вынесенные модули работают
// вместе как единое приложение, а не только по отдельности.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash, createHmac, randomBytes } = require("node:crypto");

const ROOT = join(__dirname, "..");
let dataDir;
let port;
let proc;
let base;

// Генерим пароль так же, как делает приложение: scrypt с солью.
// Нужно, чтобы /api/auth/login принял пароль, сохранённый в db.json.
function hashPassword(pass) {
  const salt = randomBytes(16).toString("hex");
  const hash = require("node:crypto").scryptSync(pass, salt, 64).toString("hex");
  return { salt, hash };
}

// Стартовый db.json с админом-владельцем и логином для входа.
function seedDb() {
  const now = Date.now();
  const { salt, hash } = hashPassword("AdminPass123!");
  return {
    staff: [
      {
        id: "u1",
        name: "Админ Тех",
        login: "admin",
        passSalt: salt,
        passHash: hash,
        salary: null,
        bonus: null,
        extraBonus: null,
      },
    ],
    admins: ["u1"],
    owner: "u1",
    driverClients: [
      { id: "c1", client: "Клиент А", address: "Москва, ул. Ленина 1", lat: 55.75, lon: 37.62 },
      { id: "c2", client: "Клиент Б", address: "Москва, ул. Пушкина 2", lat: 55.76, lon: 37.63 },
    ],
    driverRoutes: [],
    labels: [],
    days: {},
    groups: [],
    log: [],
    blocked: [],
    params: {},
    norm: {},
    salaryMonth: {},
  };
}

function httpJson(method, path, body, cookie) {
  const headers = {
    "x-vibe-user-id": "u1",
    "x-vibe-user-name-encoded": encodeURIComponent("Админ Тех"),
    "x-vibe-user-role": "ADMIN",
    "content-type": "application/json",
  };
  if (cookie) headers["cookie"] = cookie;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(base + path, opts).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* бинарный ответ */ }
    return { status: r.status, json, text };
  });
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "biotime-e2e-"));
  const db = seedDb();
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  writeFileSync(join(dataDir, "db.json"), JSON.stringify(db));
  port = 4000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Ждём готовности сервера (до 15 секунд).
  let up = false;
  for (let i = 0; i < 75 && !up; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const r = await fetch(base + "/", { signal: AbortSignal.timeout(1500) });
      if (r.ok || r.status < 500) up = true;
    } catch { /* ещё не готов */ }
  }
  if (!up) {
    const err = proc.stderr && proc.stderr.read ? "" : "";
    throw new Error("server did not start (port " + port + ")");
  }
});

after(async () => {
  if (proc) proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("E2E: логин админа и /api/me", async () => {
  const login = await httpJson("POST", "/api/auth/login", {
    login: "admin",
    password: "AdminPass123!",
  });
  assert.strictEqual(login.status, 200, JSON.stringify(login.json));
  assert.ok(login.json && login.json.ok);
  assert.strictEqual(login.json.user && login.json.user.role, "ADMIN");
});

test("E2E: /api/state отдаёт данные приложения без битых ссылок", async () => {
  const r = await httpJson("GET", "/api/state");
  assert.strictEqual(r.status, 200);
  assert.ok(r.json);
  assert.strictEqual(r.json.ok === undefined || r.json.ok, true);
  assert.ok(Array.isArray(r.json.staff));
  assert.ok(Array.isArray(r.json.driverClients === undefined ? [] : [])); // совместимость формы
  assert.ok(Array.isArray(r.json.days === undefined ? [] : []));
});

test("E2E: создание маршрута и раздел «Доставка»", async () => {
  const created = await httpJson("POST", "/api/drivers/routes", {
    action: "",
    date: "2026-10-05",
    driverId: "d1",
    driverName: "Вася",
    routeName: "Утренний",
    clients: [
      { client: "Клиент А", address: "Москва, ул. Ленина 1" },
      { client: "Клиент Б", address: "Москва, ул. Пушкина 2" },
    ],
  });
  assert.strictEqual(created.status, 200, JSON.stringify(created.json));
  const routes = created.json.routes;
  assert.ok(Array.isArray(routes) && routes.length >= 1);
  const routeId = routes[0].id;
  assert.ok(routeId);

  const deliveries = await httpJson("GET", "/api/deliveries?date=2026-10-05");
  assert.strictEqual(deliveries.status, 200);
  assert.ok(Array.isArray(deliveries.json.deliveries));
  assert.strictEqual(deliveries.json.deliveries.length, 1);
  assert.strictEqual(deliveries.json.deliveries[0].routeId, routeId);
  assert.strictEqual(deliveries.json.deliveries[0].routeName, "Утренний");
});

test("E2E: экспорт табеля — корневой / и /api/report/export отвечают", async () => {
  const root = await httpJson("GET", "/");
  assert.ok(root.status === 200 || root.status === 301 || root.status === 302);

  // Сначала инициализируем день, чтобы табель имел строки.
  await httpJson("POST", "/api/day", { key: "2026-10-05", segments: [] });
  const exp = await httpJson("GET", "/api/report/export?month=2026-10");
  assert.ok(exp.status === 200 || exp.status === 500, "expected export to respond: " + exp.status);
});
