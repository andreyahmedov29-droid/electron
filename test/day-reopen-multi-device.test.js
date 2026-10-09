// Диагностика жалобы «день сам закрывается и потом не открывается по кнопкам
// админа». Воспроизводят поведение на трёх устройствах: браузер, APK, Electron.
// Все они шлют живые тики POST /api/day для ОДНОГО сотрудника; сценарий — после
// админской правки времени (adminLock) и попытки reopen день должен ПО ИДЕЕ
// остаться открытым, но при админLock повторный живой тик может закрыть его снова.
const { test } = require("node:test");
const assert = require("node:assert");
const createDayHandler = require("../routes/day");

// Полная инъекция как в проде.
function makeDay(over) {
  const db = { days: {} };
  const body = {};
  const h = createDayHandler(Object.assign({
    getDb: () => db,
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    segmentsFor: (uid, day) => {
      const e = day && day.byEmployee && day.byEmployee[uid];
      return (e && Array.isArray(e.segments)) ? e.segments : [];
    },
    isAdmin: () => true,
    isModerator: () => true,
  }, over || {}));
  const call = async (path, method, payload, who) => {
    Object.assign(body, payload || {});
    const res = {};
    await h({ headers: {}, url: path }, res, path, method, who || { id: "u1", name: "Петя" }, true);
    return res;
  };
  return { db, body, call };
}

const admin = { id: "a1", name: "Админ" };

// Эмуляция PUT /api/admin/day, который ставит adminLock:true и finished:true,
// как делает реальный сервер (см. routes/admin-day.js).
function simulateAdminEdit(db, key, uid, segments) {
  const day = (db.days[key] = db.days[key] || { byEmployee: {} });
  if (!day.byEmployee) day.byEmployee = {};
  day.byEmployee[uid] = {
    segments,
    finished: !segments.some((s) => s.end == null),
    adminLock: true,
  };
}

test("после админской правки + reopen, повторный живой тик (браузер) не должен закрыть день", async () => {
  const m = makeDay();
  const key = "2026-11-20";
  const seg = [{ kind: "work", start: 1000, end: null, id: "w1" }];
  // админ правил время -> adminLock=true, день закрыт
  simulateAdminEdit(m.db, key, "u1", [{ kind: "work", start: 1000, end: 2000, id: "w1" }]);
  // админ жмёт «Открыть» -> finished=false (reopen)
  const reopen = await m.call(`/api/day/${key}/reopen`, "POST", { staffId: "u1" }, admin);
  assert.strictEqual(reopen._json.status, 200);
  assert.strictEqual(m.db.days[key].byEmployee["u1"].finished, false, "после reopen день открыт");

  // Живой тик откуда угодно: браузер/APK/electron шлёт POST /api/day с открытым
  // сегментом (таймер идёт), БЕЗ finish. При adminLock=true сервер закрывает день.
  const tick = await m.call("/api/day", "POST", {
    key,
    segments: [{ kind: "work", start: 1000, end: null, id: "w1" }],
  });
  assert.strictEqual(tick._json.status, 200);
  // ПРОБЛЕМА: день снова закрыт, хотя админ только что открыл
  assert.strictEqual(
    m.db.days[key].byEmployee["u1"].finished,
    false,
    "regression: живой тик после reopen НЕ должен закрывать день (сейчас закрывает)"
  );
});

test("reopen должен сбрасывать adminLock, иначе день самозакрывается на любом устройстве", async () => {
  const m = makeDay();
  const key = "2026-11-20";
  simulateAdminEdit(m.db, key, "u1", [{ kind: "work", start: 1000, end: 2000, id: "w1" }]);
  await m.call(`/api/day/${key}/reopen`, "POST", { staffId: "u1" }, admin);
  // adminLock должен быть снят, иначе следующий тик закроет день
  assert.ok(!m.db.days[key].byEmployee["u1"].adminLock, "reopen обязан снимать adminLock (ключ удалён)");
});

test("живой тик БЕЗ adminLock и БЕЗ finished не закрывает день", async () => {
  const m = makeDay();
  const key = "2026-11-20";
  m.db.days[key] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 1000, end: null, id: "w1" }], finished: false, adminLock: false },
    },
  };
  const r = await m.call("/api/day", "POST", {
    key,
    segments: [{ kind: "work", start: 1000, end: null, id: "w1" }],
  });
  assert.strictEqual(r._json.status, 200);
  assert.strictEqual(m.db.days[key].byEmployee["u1"].finished, false, "обычный тик не закрывает открытый день");
});

test("APK vs Electron: два живых тика (разные id сегментов) не закрывают день без finish", async () => {
  const m = makeDay();
  const key = "2026-11-20";
  m.db.days[key] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 1000, end: null, id: "wA" }], finished: false, adminLock: false },
    },
  };
  // устройство A (APK) шлёт свой сегмент wA (открытый)
  await m.call("/api/day", "POST", { key, segments: [{ kind: "work", start: 1000, end: null, id: "wA" }] });
  // устройство B (Electron) шлёт свой открытый wB — при open-к-онфликте не должно закрыться
  const r2 = await m.call("/api/day", "POST", { key, segments: [{ kind: "work", start: 2000, end: null, id: "wB" }] });
  assert.strictEqual(r2._json.status, 200);
  const entry = m.db.days[key].byEmployee["u1"];
  // incomingHasOpen=true -> не резолвим prevOpen, просто записываем пришедшее
  assert.strictEqual(entry.finished, false, "день не закрывается при конфликте открытых сегментов с двух устройств");
});
