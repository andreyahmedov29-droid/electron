// Юнит-тесты модуля routes/backup.js — резервное копирование.
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const createBackupHandler = require("../routes/backup");

function make(ctx) {
  return createBackupHandler(Object.assign({
    getDb: () => ({ staff: [{ id: "1" }] }),
    setDb: () => {},
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    DATA_DIR: ".",
    BACKUP_DIR: ".",
    BACKUP_KEEP: 5,
    BACKUP_EVERY_MS: 3600000,
    dayKey: () => "2026-10-03",
    listAutoBackups: () => [],
    migrateDays: () => {},
    normalizeGroup: (g) => g,
  }, ctx || {}));
}

test("GET /api/admin/backup/auto не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/auto", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/admin/backup/auto админ -> параметры", async () => {
  const h = make({ listAutoBackups: () => ["a.json"] });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/auto", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.backups[0], "a.json");
});

test("POST /api/admin/backup/restore заменяет БД через setDb", async () => {
  let current = { staff: [{ id: "1" }] };
  let setCalled = 0;
  const h = make({
    getDb: () => current,
    setDb: (nd) => { current = nd; setCalled += 1; },
    readBody: async () => ({ data: { staff: [{ id: "9" }], groups: [] } }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/restore", "POST", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(current.staff[0].id, "9");
  assert.ok(setCalled >= 1);
});

test("POST /api/admin/backup/restore c мусором -> 422", async () => {
  const h = make({ readBody: async () => ({ data: { foo: "bar" } }) });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/restore", "POST", true);
  assert.strictEqual(res._json.status, 422);
});

test("restore: extra-данные (треки/статусы/журнал 1С) передаются в applyExtraBackup", async () => {
  let applied = null;
  const h = make({
    readBody: async () => ({
      data: { staff: [{ id: "1" }], groups: [] },
      extra: { tracksByDay: { "2026-10-03": { d1: [[1, 2]] } }, notFound: { x: 1 }, onecPullLog: [{ id: "a" }] },
    }),
    applyExtraBackup: (extra) => { applied = extra; },
  });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/restore", "POST", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.restored.extra, true);
  assert.ok(applied, "applyExtraBackup вызван с extra");
  assert.ok(applied.tracksByDay && applied.tracksByDay["2026-10-03"].d1, "треки переданы");
  assert.ok(applied.notFound, "статусы переданы");
  assert.ok(Array.isArray(applied.onecPullLog), "журнал 1С передан");
});

test("bulk restore: части собираются в /restore-complete и БД заменяется", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "biotime-bulk-"));
  let current = { staff: [{ id: "1" }] };
  let setCalled = 0;
  const bodyStr = JSON.stringify({ app: "biotime", version: 1, exportedAt: new Date().toISOString(), data: { staff: [{ id: "1", name: "А", login: "x", passSalt: "s", passHash: "h" }], admins: ["1"], groups: [], days: {} } });
  const CHUNK = 300;
  const total = Math.ceil(bodyStr.length / CHUNK);
  const token = "t-" + Date.now();

  for (let i = 0; i < total; i++) {
    const h = make({
      DATA_DIR: tmp,
      getDb: () => current,
      setDb: (nd) => { current = nd; setCalled += 1; },
      readBody: async () => ({ token, index: i, total, data: bodyStr.slice(i * CHUNK, (i + 1) * CHUNK) }),
    });
    const res = {};
    await h({ headers: {} }, res, "/api/admin/backup/restore-part", "POST", true);
    assert.strictEqual(res._json.status, 200);
  }

  const h = make({
    DATA_DIR: tmp,
    getDb: () => current,
    setDb: (nd) => { current = nd; setCalled += 1; },
    readBody: async () => ({ token, total }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/restore-complete", "POST", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.restored.staff, 1);
  assert.strictEqual(current.staff[0].name, "А");
  assert.ok(setCalled >= 1);
  assert.strictEqual(fs.readdirSync(path.join(tmp, "_staging")).length, 0, "части удаляются после restore");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("bulk restore: неполные части (нет части) -> 422", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "biotime-bulkmiss-"));
  const token = "tmiss";
  const h0 = make({
    DATA_DIR: tmp,
    readBody: async () => ({ token, index: 0, total: 2, data: "{}" }),
  });
  const r0 = {};
  await h0({ headers: {} }, r0, "/api/admin/backup/restore-part", "POST", true);
  assert.strictEqual(r0._json.status, 200);
  const h = make({
    DATA_DIR: tmp,
    readBody: async () => ({ token, total: 2 }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/admin/backup/restore-complete", "POST", true);
  assert.strictEqual(res._json.status, 422);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", true);
  assert.strictEqual(r, false);
});
