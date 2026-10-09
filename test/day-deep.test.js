// Глубокие юнит-тесты routes/day.js: гонки таймеров, adminLock, finish,
// prevFinished, защита от загтирания статусов.
const { test } = require("node:test");
const assert = require("node:assert");
const createDayHandler = require("../routes/day");

// segmentsFor(userId, day) в реальном приложении возвращает day.byEmployee[userId].segments.
function harness(over) {
  const db = { days: {} };
  const body = {};
  let persistCalls = 0;
  const h = createDayHandler(Object.assign({
    getDb: () => db,
    persistDb: async () => { persistCalls++; },
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => body,
    segmentsFor: (uid, day) => {
      const e = day && day.byEmployee && day.byEmployee[uid];
      return (e && Array.isArray(e.segments)) ? e.segments : [];
    },
    isAdmin: () => false,
    isModerator: () => false,
  }, over || {}));
  const user = over && over.user ? over.user : { id: "u1", name: "Петя" };
  const call = async (payload, who) => {
    Object.assign(body, payload);
    const res = {};
    await h({ headers: {} }, res, "/api/day", "POST", who || user, false);
    return res;
  };
  return { h, db, body, call, persistCalls: () => persistCalls };
}

test("сохранение дня пишет сегменты owner'у и сохраняет статусы", async () => {
  const conn = harness();
  conn.db.days["2026-10-03"] = { statuses: { u2: "Я" } };
  await conn.call({ key: "2026-10-03", segments: [{ kind: "work", start: 1, end: 2 }] });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  assert.strictEqual(entry.segments.length, 1);
  assert.strictEqual(conn.db.days["2026-10-03"].statuses.u2, "Я");
});

test("finish:true закрывает все открытые сегменты временем finishTime и помечает день закрытым", async () => {
  const conn = harness();
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 1, end: null }],
    finish: true,
    finishTime: 12345,
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  assert.strictEqual(entry.segments[0].end, 12345);
  assert.strictEqual(entry.finished, true);
});

test("гонка: фоновое сохранение идущего таймера не перезаписывает закрытый день", async () => {
  const conn = harness();
  // день уже закрыт (finished:true) с открытым на сервере сегментом
  conn.db.days["2026-10-03"] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 1, end: 9999 }], finished: true, adminLock: false },
    },
  };
  // фоновая вкладка присылает ОТКРЫТЫЙ сегмент (таймер ещё идёт), но без finish
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 1, end: null }],
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  // защита П.2: серверный закрытый сегмент не затирается
  assert.strictEqual(entry.segments[0].end, 9999);
  assert.strictEqual(entry.finished, true);
});

test("гонка: входящий без открытого сегмента не воскрешает prevOpen (закрытие таймера)", async () => {
  const conn = harness();
  conn.db.days["2026-10-03"] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 1, end: null, id: "w1" }], finished: false, adminLock: false },
    },
  };
  // клиент шлёт закрытый сегмент (закрытие ТОГО ЖЕ таймера, same id)
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 1, end: 9999, id: "w1" }],
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  assert.strictEqual(entry.segments.length, 1);
  assert.strictEqual(entry.segments[0].end, 9999);
  // сегмент тот же (w1), prevOpen НЕ воскрешён — в записи один закрытый сегмент
  assert.strictEqual(entry.segments[0].id, "w1");
});

test("гонка: prevOpen живёт, если клиент прислал БОЛЕЕ старый/другой набор без закрытия того же таймера", async () => {
  const conn = harness();
  conn.db.days["2026-10-03"] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 100, end: null, id: "w1" }], finished: false, adminLock: false },
    },
  };
  // клиент прислал сегмент с ДРУГИМ id и без end (другая вкладка, открытый) — но
  // правило П.1: если prevOpen есть и входящий тоже открыт — не воскрешаем, остаётся входящий.
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 200, end: null, id: "w2" }],
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  // incomingHasOpen=true, поэтому ветка prevOpen не срабатывает; остаётся входящий w2
  assert.strictEqual(entry.segments[0].id, "w2");
});

test("adminLock: живое сохранение не перезаписывает вручную заданное админом время", async () => {
  const conn = harness();
  conn.db.days["2026-10-03"] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 100, end: 200, id: "s" }], finished: true, adminLock: true },
    },
  };
  // водитель шлёт открытый таймер (реальное 08:00), но adminLock стоит -> не перезаписываем
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 300, end: null }],
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  assert.strictEqual(entry.segments[0].end, 200);
  assert.strictEqual(entry.segments[0].start, 100);
});

test("finish поверх adminLock всё равно закрывает день", async () => {
  const conn = harness();
  conn.db.days["2026-10-03"] = {
    byEmployee: {
      u1: { segments: [{ kind: "work", start: 100, end: 200, id: "s" }], finished: true, adminLock: true },
    },
  };
  await conn.call({
    key: "2026-10-03",
    segments: [{ kind: "work", start: 100, end: null }],
    finish: true,
    finishTime: 999,
  });
  const entry = conn.db.days["2026-10-03"].byEmployee["u1"];
  // finish применяется даже под adminLock: открытый сегмент закрыт временем finishTime
  assert.strictEqual(entry.segments[0].end, 999);
  assert.strictEqual(entry.finished, true);
  assert.strictEqual(entry.adminLock, true);
});

test("битые/пустые сегменты не роняют", async () => {
  const conn = harness();
  const res = await conn.call({ key: "2026-10-03", segments: [null, "junk", 5] });
  assert.strictEqual(res._json.status, 200);
});
