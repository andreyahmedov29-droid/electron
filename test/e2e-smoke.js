// E2E-smoke сервера BIOTIME (без внешних зависимостей).
//
// Поднимает server.js во ВРЕМЕННОМ каталоге (изолированный DATA_DIR, случайный
// PORT), ждёт готовности, гоняет набор GET+POST-запросов по ключевым API и
// падает, если хоть один ответ >= 500 (это признак сбоя цепочки handleApi,
// напр. повторная отправка ответа ERR_HTTP_HEADERS_SENT). В конце останавливает
// сервер и показывает, если в stderr оказались лишние строки.
//
// Запуск: npm run test:e2e   (или: node test/e2e-smoke.js)
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "biotime-e2e-"));
const PORT = 4100 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: DATA }),
  stdio: ["ignore", "pipe", "pipe"],
});
let errLog = "";
server.stderr.on("data", (d) => { errLog += String(d); });

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/app/web-version`);
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function req(method, p, body) {
  const opt = { method };
  if (body) {
    opt.headers = { "content-type": "application/json" };
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${p}`, opt);
  return r.status;
}

(async () => {
  const ready = await waitReady();
  if (!ready) {
    console.error("E2E FAIL: сервер не поднялся за отведённое время");
    server.kill();
    process.exit(1);
  }

  const gets = [
    "/", "/api/app/web-version", "/api/scanlog", "/api/notfound",
    "/api/shipments", "/api/deliveries", "/api/state", "/api/me",
    "/api/maps/config", "/api/admin/backup/auto",
  ];
  const posts = [
    ["/api/staff", { name: "E2E" }],
    ["/api/logs/barcode", { code: "X", ok: true }],
    ["/api/notfound", { key: "C|A", status: "Выполнено" }],
    ["/api/groups", { name: "E2E" }],
    ["/api/params", { showOverHours: true }],
    ["/api/waybill/parse", { text: "2026-10-03;C;A1;1" }],
    ["/api/day", { date: "2026-10-03" }],
    ["/api/shipments/complete", { routeId: "__none__" }],
    ["/api/auth/login", { login: "x", password: "12345678" }],
  ];

  const bad = [];
  for (const u of gets) {
    const s = await req("GET", u);
    if (s >= 500) bad.push(`GET ${u} -> ${s}`);
  }
  for (const [u, b] of posts) {
    const s = await req("POST", u, b);
    if (s >= 500) bad.push(`POST ${u} -> ${s}`);
  }

  server.kill();
  await new Promise((r) => setTimeout(r, 300));

  if (bad.length) {
    console.error("E2E FAIL:\n" + bad.join("\n"));
    process.exit(1);
  }
  const noisy = errLog.split("\n").map((s) => s.trim()).filter(Boolean).slice(-10);
  if (noisy.length) {
    console.warn("E2E WARN: в stderr сервера есть строки (возможно фоновые, не ошибки):\n" + noisy.join("\n"));
  }
  console.log("E2E OK: сервер поднялся, все GET+POST без 5xx, соединения корректны");
  process.exit(0);
})().catch((e) => {
  console.error("E2E ERROR:", e);
  server.kill();
  process.exit(1);
});
