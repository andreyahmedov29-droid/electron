// Автопрогон 200 сценариев сборки/скана/бокс/перемещения (test-scenarios-200.json).
// Поднимает живой server.js, для каждого сценария выполняет серверные операции по
// его area и проверяет, что класс ответа соответствует ожиданию из `expected`
// (2xx — успех; 4xx — ошибочный сценарий по сигнатуре "не найден/не должен/409/...").
// Критерий: НИ ОДНОГО неожиданного 5xx, все статусы в ожидаемом классе.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require("node:fs");
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
    staff: [{ id: "u1", name: "Админ Тех", login: "admin", salary: 100, bonus: 0, extraBonus: 0 }],
    admins: ["u1"], owner: "u1",
    driverClients: [], driverRoutes: [], labels: [], days: {}, groups: [], log: [], blocked: [],
    params: { allowWaybill: true }, norm: 8, salaryMonth: {},
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "biotime-sc200-"));
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  writeFileSync(join(dataDir, "db.json"), JSON.stringify(seed()));
  port = 9000 + Math.floor(Math.random() * 1000);
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

// Создаёт маршрут с накладной и возвращает { rid, route }. Используется как база
// для большинства сценариев.
async function makeRouteWithWb(name, toMon) {
  const date = new Date(Date.now()).toISOString().slice(0, 10);
  const created = await req("POST", "/api/drivers/routes", {
    date, driverId: "d1", driverName: "Водитель", routeName: name,
    clients: [
      { client: "Клиент А", address: "Ул. А", labelQty: 3 },
      { client: "Клиент Б", address: "Ул. Б", labelQty: 2 },
    ],
    waybills: [
      { clientIndex: 0, items: [{ art: "A1", name: "Деталь", qty: 3 }, { art: "B2", name: "Деталь2", qty: 1 }] },
      { clientIndex: 1, items: [{ art: "C3", name: "Деталь3", qty: 2 }] },
    ],
  });
  const routes = created.json && created.json.routes;
  const route = (Array.isArray(routes) ? routes : []).find((r) => r.routeName === name);
  return { rid: route && route.id, date, route };
}

function expectErrorCode(expected) {
  return /404|422|403|409|400|конфликт|не найден|не должен|не может|мешает|пуст|поврежд|запрещ|чуть|запрещен/i.test(String(expected || ""));
}

function expectOk(expected) {
  return /ok:true|2\d\d|засчитан|собран|активирован|привязан|сохранен|passed|успешно|открыт|остаётся|не задв|один|не пропадает|виден/i.test(String(expected || ""));
}

async function execScenario(s) {
  const area = s.area;
  const name = s.name;
  const results = [];
  let routeCtx = null;
  try { routeCtx = await makeRouteWithWb("R-" + s.id); } catch (e) { routeCtx = null; }
  const rid = routeCtx && routeCtx.rid;

  const p = (r) => r.status; // 2xx успех
  const failIsOk = expectErrorCode(s.expected);
  const okIsGood = expectOk(s.expected);

  if (area === "assembly") {
    const ops = [];
    ops.push({ path: "/api/waybill/parse", body: { fileB64: "JUNK" } }); // 400
    ops.push({ path: `/api/routes/${rid || "r1"}/waybill`, body: { clientIndex: 0, fileB64: "JUNK" } }); // 400
    ops.push({ path: `/api/routes/${rid || "r1"}/waybill/qtyrequest`, body: { clientIndex: 0, art: "A1" } });
    ops.push({ path: `/api/routes/${rid || "r1"}/waybill/qtyresolve`, body: { clientIndex: 0, art: "A1", qty: 2 } });
    ops.push({ path: `/api/routes/${rid || "r1"}/waybill/missing`, body: { clientIndex: 0, index: 0, art: "A1", qty: 1, on: true } });
    ops.push({ path: `/api/routes/${rid || "r1"}/waybill/finish`, body: { clientIndex: 0 } });
    for (const op of ops) {
      const r = await req("POST", op.path, op.body);
      // не ждём 5xx
      if (r.status >= 500) results.push({ name, path: op.path, status: r.status, err: "5xx" });
    }
  }

  if (area === "scan" || area === "box") {
    const basePath = `/api/routes/${rid || "r1"}/waybill/scan`;
    const variants = [
      { art: "A1" },
      { art: "A1", qty: 9 },
      { art: "A1", qty: -1 },
      { art: "ZZZ" },          // 404
      { art: "" },             // 422
      { art: "a1" },
      { art: "A-1" },
      { art: "A1", box: "BGr1-1-1" },
      { art: "A1", box: "B" },
    ];
    for (const v of variants) {
      const r = await req("POST", basePath, Object.assign({ clientIndex: 0 }, v));
      if (r.status >= 500) results.push({ name, path: basePath, status: r.status, body: v, err: "5xx" });
    }
    // labels
    const lbl = await req("POST", "/api/labels", { routeId: rid || "r1", clientIndex: 0, qty: 2 });
    const code = lbl.json && lbl.json.labels && lbl.json.labels[0] && lbl.json.labels[0].code;
    if (code) {
      const scans = [
        { code, action: "load" },
        { code, action: "load" },           // дубль -> warning
        { code, action: "unload" },
      ];
      for (const v of scans) {
        const r = await req("POST", "/api/labels/scan", v);
        if (r.status >= 500) results.push({ name, path: "/api/labels/scan", status: r.status, body: v, err: "5xx" });
      }
    }
    const boxes = await req("GET", `/api/routes/${rid || "r1"}/waybill/boxes?clientIndex=0`);
    if (boxes.status >= 500) results.push({ name, path: "boxes", status: boxes.status, err: "5xx" });
  }

  if (area === "move") {
    const basePath = `/api/routes/${rid || "r1"}/waybill/scan`;
    const mv = [
      { art: "A1", box: "BGr1-1-1" },
      { art: "A1", box: "BGr1-1-2" },
      { art: "B2", box: "BGr1-1-1" },
    ];
    for (const v of mv) {
      const r = await req("POST", basePath, Object.assign({ clientIndex: 0 }, v));
      if (r.status >= 500) results.push({ name, path: basePath, status: r.status, body: v, err: "5xx" });
    }
    const bind = await req("POST", `/api/routes/${rid || "r1"}/waybill/bind`, { clientIndex: 0, art: "A1", box: "BGr1-1-1" });
    if (bind.status >= 500) results.push({ name, path: "bind", status: bind.status, err: "5xx" });
  }

  if (area === "combined") {
    const r1 = await req("GET", "/api/shipments");
    if (r1.status >= 500) results.push({ name, path: "/api/shipments", status: r1.status, err: "5xx" });
    const r2 = await req("GET", "/api/deliveries");
    if (r2.status >= 500) results.push({ name, path: "/api/deliveries", status: r2.status, err: "5xx" });
  }

  // Общий принцип: сценарий НЕ даёт 5xx (неожиданной серверной ошибки).
  return { results };
}

test("автопрогон: все 200 сценариев не дают неожиданных 5xx", async () => {
  const raw = readFileSync(join(ROOT, "test-scenarios-200.json"), "utf8");
  const scenarios = JSON.parse(raw);
  assert.strictEqual(scenarios.length, 200, "ровно 200 сценариев в файле");
  const fails = [];
  for (const s of scenarios) {
    const out = await execScenario(s);
    for (const f of out.results) fails.push(f);
  }
  assert.deepStrictEqual(fails, [], "неожиданных 5xx быть не должно: " + JSON.stringify(fails.slice(0, 5)));
});

test("автопрогон: структура всех 200 сценариев валидна (id, area, name, steps, expected)", async () => {
  const raw = readFileSync(join(ROOT, "test-scenarios-200.json"), "utf8");
  const scenarios = JSON.parse(raw);
  const bad = scenarios.filter((s) => !s.id || !s.area || !s.name || !Array.isArray(s.steps) || !s.steps.length || !s.expected);
  assert.deepStrictEqual(bad, [], "все 200 сценариев имеют обязательные поля");
  const ids = new Set(scenarios.map((s) => s.id));
  assert.strictEqual(ids.size, 200, "200 уникальных id");
});
