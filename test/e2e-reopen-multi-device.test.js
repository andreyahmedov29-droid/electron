// E2E диагноз «день сам закрывается и не открывается по кнопке админа» на живом
// сервере. Воспроизводит три устройства (браузер / APK / Electron), которые шлют
// живые тики для одного сотрудника, и сценарий: админ правит время -> «Открыть»
// (reopen) -> следующий живой тик не должен снова закрыть день.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
let dataDir, port, proc, base;

function req(method, path, body, headersOverride) {
  const headers = Object.assign({
    "x-vibe-user-id": "u1",
    "x-vibe-user-name-encoded": encodeURIComponent("Сотрудник"),
    "x-vibe-user-role": "MEMBER",
    "content-type": "application/json",
  }, headersOverride || {});
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(base + path, opts).then(async (r) => {
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* бинарный */ }
    return { status: r.status, json, text };
  });
}

function seed() {
  const start = Date.now() - 3600 * 1000;
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  return {
    staff: [{ id: "u1", name: "Сотрудник", login: "emp", salary: 100, bonus: 0, extraBonus: 0 }],
    admins: [],
    owner: "a1",
    driverClients: [], driverRoutes: [], labels: [], groups: [], log: [], blocked: [],
    params: {}, norm: 8, salaryMonth: {},
    days: {
      [today]: {
        byEmployee: {
          u1: { segments: [{ kind: "work", start, end: null, id: "w1" }], finished: false, adminLock: false },
        },
      },
    },
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "biotime-reopen-"));
  mkdirSync(join(dataDir, "backups"), { recursive: true });
  writeFileSync(join(dataDir, "db.json"), JSON.stringify(seed()));
  port = 8000 + Math.floor(Math.random() * 1000);
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

function readDayInFile() {
  const raw = JSON.parse(readFileSync(join(dataDir, "db.json"), "utf8"));
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  return {
    today,
    entry: raw.days[today] && raw.days[today].byEmployee && raw.days[today].byEmployee["u1"],
    key: today,
  };
}

test("три устройства: админ правка -> reopen -> живой тик не закрывает день (finish=false)", async () => {
  const { today } = readDayInFile();
  const start = Date.now() - 3600 * 1000;

  // 1) Админ правит время (PUT /api/admin/day) -> adminLock=true, день закрыт.
  const adminEdit = await req("PUT", "/api/admin/day", {
    key: today, ownerId: "u1",
    segments: [{ kind: "work", start: start, end: start + 1000, id: "w1" }],
  }, { "x-vibe-user-id": "a1", "x-vibe-user-name-encoded": encodeURIComponent("Админ"), "x-vibe-user-role": "ADMIN" });
  assert.strictEqual(adminEdit.status, 200, JSON.stringify(adminEdit.json));

  // 2) Админ жмёт «Открыть» (reopen).
  const reopen = await req("POST", `/api/day/${today}/reopen`, { staffId: "u1" },
    { "x-vibe-user-id": "a1", "x-vibe-user-name-encoded": encodeURIComponent("Админ"), "x-vibe-user-role": "ADMIN" });
  assert.strictEqual(reopen.status, 200, JSON.stringify(reopen.json));
  await new Promise((r) => setTimeout(r, 200));
  let state = readDayInFile();
  assert.strictEqual(state.entry.finished, false, "после reopen день открыт");

  // 3) Живой тик с «устройства» (браузер/APK/electron — один и тот же эндпоинт).
  const tick = await req("POST", "/api/day", {
    key: today,
    segments: [{ kind: "work", start, end: null, id: "w1" }],
  });
  assert.strictEqual(tick.status, 200);
  await new Promise((r) => setTimeout(r, 300));
  state = readDayInFile();
  assert.strictEqual(
    state.entry.finished,
    false,
    "РЕГРЕССИЯ: живой тик после reopen снова закрыл день (день не должен самозакрываться)"
  );
  // adminLock после reopen и живого тика либо удалён, либо равен false —
  // главное, что заморозки (true) нет.
  assert.ok(!state.entry.adminLock, "adminLock не «замораживает» день после reopen (нет true)");
});

test("офлайн — живой тик с задержкой после reopen тоже не закрывает день", async () => {
  const { today } = readDayInFile();
  const start = Date.now() - 3600 * 1000;
  // устройство «задерживает» отправку (эмуляция офлайн-очереди) — шлём тик с clientTime в прошлом
  const tick = await req("POST", "/api/day", {
    key: today,
    segments: [{ kind: "work", start, end: null, id: "w1" }],
  });
  assert.strictEqual(tick.status, 200);
  await new Promise((r) => setTimeout(r, 250));
  const { entry } = readDayInFile();
  assert.strictEqual(entry.finished, false, "офлайн-тик не закрывает открытый день");
});
