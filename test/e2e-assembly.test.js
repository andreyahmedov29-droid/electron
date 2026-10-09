// E2E-сценарий СБОРКИ: воспроизводит жалобу «боксы не всегда выбираются».
// Поднимает настоящий server.js на случайном порту со свежей DATA_DIR и проходит
// реальный HTTP-поток сборки:
//   1. создаём маршрут с накладной;
//   2. «печатаем» бокс (создаём этикетку места через /api/labels);
//   3. проверяем, что этот бокс виден в /api/routes/:id/waybill/boxes;
//   4. сканируем деталь с привязкой к этому боксу (/waybill/scan c box);
//   5. воспроизводим проблемный кейс: деталь привязана к коду бокса, НО этикетка
//      этого места не была создана -> бокс отсутствует в списке boxes.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { randomBytes } = require("node:crypto");

const ROOT = join(__dirname, "..");
let dataDir, port, proc, base;
const ADMIN_HEADERS = {
  "x-vibe-user-id": "u1",
  "x-vibe-user-name-encoded": encodeURIComponent("Админ Тех"),
  "x-vibe-user-role": "ADMIN",
  "content-type": "application/json",
};

function req(method, path, body, cookie, extraHeaders) {
  const headers = Object.assign({}, ADMIN_HEADERS, extraHeaders || {});
  if (cookie) headers.cookie = cookie;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(base + path, opts).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* бинарный ответ */ }
    return { status: r.status, json, text };
  });
}

function routesWithWaybill(routeId) {
  return {
    id: routeId,
    clients: [
      { client: "Клиент А", address: "Москва, ул. Ленина 1", labelQty: 3 },
    ],
    waybills: {
      0: {
        items: [
          { art: "12345", name: "Деталь 1", qty: 2, scanned: 0, missing: false },
          { art: "99999", name: "Деталь 2", qty: 1, scanned: 0, missing: false },
        ],
      },
    },
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "biotime-asmb-"));
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  const state = {
    staff: [{ id: "u1", name: "Админ Тех", login: "admin", salary: null, bonus: null, extraBonus: null }],
    admins: ["u1"],
    owner: "u1",
    driverClients: [],
    driverRoutes: [routesWithWaybill("r1")],
    labels: [],
    days: {},
    groups: [],
    log: [],
    blocked: [],
    params: { allowWaybill: true },
    norm: {},
    salaryMonth: {},
  };
  writeFileSync(join(dataDir, "db.json"), JSON.stringify(state));
  port = 5000 + Math.floor(Math.random() * 1000);
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
  if (!up) throw new Error("server did not start (port " + port + ")");
});

after(async () => {
  if (proc) proc.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 300));
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("Сборка: создание бокса через /api/labels делает его видимым в /waybill/boxes", async () => {
  // Печатаем 2 бокса (этикетки мест) для клиента 0 маршрута r1.
  const labels = await req("POST", "/api/labels", { routeId: "r1", clientIndex: 0, qty: 2 });
  assert.strictEqual(labels.status, 200, JSON.stringify(labels.json));
  assert.strictEqual(labels.json.labels.length, 2);

  const boxes = await req("GET", "/api/routes/r1/waybill/boxes?clientIndex=0");
  assert.strictEqual(boxes.status, 200);
  // Оба созданных бокса должны попасть в список (этикетки есть в db.labels).
  assert.strictEqual(boxes.json.boxes.length, 2, JSON.stringify(boxes.json.boxes));
  const codes = boxes.json.boxes.map((b) => b.box);
  assert.ok(codes.includes("BGr1-1-1"), JSON.stringify(codes));
  assert.ok(codes.includes("BGr1-1-2"), JSON.stringify(codes));
});

test("Сборка: скан детали привязывается к активному боксу", async () => {
  const scan = await req("POST", "/api/routes/r1/waybill/scan", {
    clientIndex: 0,
    art: "12345",
    box: "BGr1-1-1",
  });
  assert.strictEqual(scan.status, 200, JSON.stringify(scan.json));
  assert.strictEqual(scan.json.item.scanned, 1);
  assert.strictEqual(scan.json.item.box, "BGr1-1-1");
});

test("Сборка: деталь в «механическом» боксе без этикетки => бокс всё равно виден и выбирается", async () => {
  // Сканируем деталь в «бокс» с кодом BGr1-1-9, у которого НЕ создана этикетка.
  // В реальности сборщик печатает бокс через ПК, сканирует его стикер (который
  // создаёт этикетку) и кладёт деталь. Но если стикер НЕ был напечатан/зарегистрирован
  // (например, бокс «механический» — подписали маркером, или печать не создала
  // запись, или этикетку потеряли), то сервер всё равно привяжет деталь к коду
  // бокса, НО не вернёт его в список boxes => фронт не сможет активировать его.
  const scan = await req("POST", "/api/routes/r1/waybill/scan", {
    clientIndex: 0,
    art: "99999",
    box: "BGr1-1-9",
  });
  assert.strictEqual(scan.status, 200, JSON.stringify(scan.json));
  assert.strictEqual(scan.json.item.box, "BGr1-1-9");

  // Бокс был передан и деталь к нему привязалась, но этикетки BGr1-1-9 нет.
  const boxes = await req("GET", "/api/routes/r1/waybill/boxes?clientIndex=0");
  const hasMissing = boxes.json.boxes.some((b) => b.box === "BGr1-1-9");
  // ИСПРАВЛЕНО: сервер включил бокс без этикетки в список, потому что в нём лежит
  // деталь. Теперь фронт узнаёт про «Бокс 9» (попадёт в waybillBoxPlaces) и сможет
  // активировать его сканом.
  assert.strictEqual(hasMissing, true, "BGr1-1-9 присутствует в boxes, несмотря на отсутствие этикетки (фикс)");

  // Деталь при этом физически лежит в BGr1-1-9 на сервере: повторный скан того же
  // артикула НЕ «найдёт строку с остатком» (99999 qty=1 собран) — пойдёт в ветку
  // перепривязки existing+box, т.е. та же деталь всё ещё числится в BGr1-1-9.
  const rescan = await req("POST", "/api/routes/r1/waybill/scan", {
    clientIndex: 0,
    art: "99999",
    box: "BGr1-1-9",
  });
  // Сервер отвечает 200 rebound (деталь уже собрана, переносим в тот же бокс).
  assert.strictEqual(rescan.status, 200, JSON.stringify(rescan.json));
  assert.strictEqual(rescan.json.rebound, true, "деталь 99999 уже привязана к BGr1-1-9 на сервере");

  // Итог противоречия: сервер «держит» бокс BGr1-1-9 (в нём лежит деталь), но
  // раньше список boxes его не отдавал (нет этикетки) — сейчас отдаёт. Фронт строит
  // распознавание бокса по этому списку (waybillBoxPlaces), поэтому «Бокс 9»
  // активируется, и детали в него привязываются.
  const boxes2 = await req("GET", "/api/routes/r1/waybill/boxes?clientIndex=0");
  const allCodes = boxes2.json.boxes.map((b) => b.box);
  assert.ok(allCodes.includes("BGr1-1-9"), "BGr1-1-9 есть в boxes, хотя в нём есть собранная деталь и нет этикетки");
});
