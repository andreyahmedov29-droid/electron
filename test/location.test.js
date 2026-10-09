// Юнит-тесты модуля routes/location.js — геолокация водителей.
const { test } = require("node:test");
const assert = require("node:assert");
const createLocationHandler = require("../routes/location");

function make(ctx) {
  return createLocationHandler(Object.assign({
    getDb: () => ({ liveLocations: {}, tracks: {} }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    isDriver: () => true,
    isDriversGroupOnly: () => true,
    motionDayKey: () => "2026-10-03",
    tracksByDay: {},
    scheduleTracksSave: () => {},
  }, ctx || {}));
}

test("POST /api/drivers/location не-водитель -> 403", async () => {
  const h = make({ isDriver: () => false });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 403);
});

test("POST /api/drivers/location сохраняет координаты и трек", async () => {
  const db = { liveLocations: {}, tracks: {} };
  const h = make({
    getDb: () => db,
    tracksByDay: {},
    readBody: async () => ({ lat: 55.7, lon: 37.6, routeId: "r1" }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "POST", { id: "7", name: "Иван" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.liveLocations["7"].lat, 55.7);
  assert.strictEqual(db.tracks["7"].length, 1);
});

test("POST /api/drivers/location с невалидными координатами не добавляет точку", async () => {
  const db = { liveLocations: {}, tracks: {} };
  const tracksByDay = {};
  const h = make({
    getDb: () => db,
    tracksByDay,
    motionDayKey: () => "2026-10-03",
    readBody: async () => ({ lat: "x", lon: "y" }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.tracks["1"], undefined, "невалидная точка не добавляется в трек");
});

test("POST /api/drivers/location использует клиентское время ts (реальное время устройства)", async () => {
  const db = { liveLocations: {}, tracks: {} };
  const day = "2026-10-03";
  const dayStart = Date.UTC(2026, 9, 3) - 3 * 3600000; // 00:00 МСК
  const ts = dayStart + 900000; // 00:15 МСК
  const tracksByDay = {};
  const h = make({
    getDb: () => db,
    tracksByDay,
    motionDayKey: () => day,
    readBody: async () => ({ lat: 55.7, lon: 37.6, routeId: "r1", ts }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "POST", { id: "7", name: "Иван" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(db.liveLocations["7"].at, ts);
  assert.strictEqual(tracksByDay[day]["7"][0][2], ts);
});

test("POST /api/drivers/location принимает офлайн-пачку points", async () => {
  const db = { liveLocations: {}, tracks: {} };
  const day = "2026-10-03";
  const dayStart = Date.UTC(2026, 9, 3) - 3 * 3600000;
  const tracksByDay = {};
  const h = make({
    getDb: () => db,
    tracksByDay,
    motionDayKey: () => day,
    readBody: async () => ({
      points: [
        { lat: 55.1, lon: 37.1, ts: dayStart + 0 },
        { lat: 55.2, lon: 37.2, ts: dayStart + 15 * 60000 },
        { lat: 55.3, lon: 37.3, ts: dayStart + 30 * 60000 },
      ],
    }),
  });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "POST", { id: "7", name: "Иван" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.strictEqual(tracksByDay[day]["7"].length, 3, "все точки из пачки попадают в трек");
  assert.strictEqual(db.liveLocations["7"].lat, 55.3, "live-позиция — последняя точка пачки");
});

test("GET /api/drivers/location не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "GET", { id: "1" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/location возвращает свежие позиции", async () => {
  const db = { liveLocations: { "7": { lat: 55.7, lon: 37.6, at: Date.now(), name: "Иван", routeId: "r1" } }, tracks: {} };
  const h = make({ getDb: () => db });
  const res = {};
  await h({ headers: {} }, res, "/api/drivers/location", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1);
  assert.strictEqual(res._json.obj.rows[0].lat, 55.7);
});

test("GET /api/drivers/location-report возвращает 15-мин сетку с адресами", async () => {
  const day = "2026-10-03";
  // Полночь МСК (UTC+3) = 21:00 UTC предыдущих суток.
  const dayStart = Date.UTC(2026, 9, 3) - 3 * 3600000;
  const h = make({
    tracksByDay: {
      [day]: {
        "7": [
          [55.70, 37.60, dayStart],
          [55.71, 37.61, dayStart + 15 * 60000],
          [55.72, 37.62, dayStart + 30 * 60000],
        ],
      },
    },
    reverseGeocode: async () => "Москва",
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/location-report?date=" + day + "&driverId=7" },
    res, "/api/drivers/location-report", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.ok(res._json.obj.rows.length >= 1);
  assert.strictEqual(res._json.obj.rows[0].time, "00:00");
  assert.strictEqual(res._json.obj.rows[0].address, "Москва");
  assert.ok(Number.isFinite(res._json.obj.rows[0].lat));
});

test("location-report корректирует старые точки по дрейфу серверных часов (из новых)", async () => {
  const day = "2026-10-03";
  const dayStart = Date.UTC(2026, 9, 3) - 3 * 3600000; // 00:00 МСК
  const driftMs = 20 * 60000; // сервер опережает реальное на 20 минут
  const realOld = dayStart + 15 * 60000; // реально 00:15 МСК
  const serverOld = realOld + driftMs; // сервер записал бы так (старая точка)
  const realNew = dayStart + 30 * 60000; // реально 00:30 МСК
  const serverNew = realNew + driftMs; // серверное время приёма новой точки
  const h = make({
    tracksByDay: {
      [day]: {
        "7": [
          [55.0, 37.0, serverOld], // старая точка без маркера (3 элемента)
          [55.1, 37.1, realNew, serverNew], // новая точка с серверным временем (4 элемента)
        ],
      },
    },
    reverseGeocode: async () => "Адрес",
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/location-report?date=" + day + "&driverId=7" },
    res, "/api/drivers/location-report", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  const times = res._json.obj.rows.map((r) => r.time);
  assert.ok(times.includes("00:15"),
    "старая точка должна попасть в 00:15 после коррекции дрейфа: " + JSON.stringify(times));
});

test("location-report использует настраиваемый интервал", async () => {
  const day = "2026-10-03";
  const dayStart = Date.UTC(2026, 9, 3) - 3 * 3600000;
  const h = make({
    tracksByDay: { [day]: { "7": [[55.0, 37.0, dayStart + 30 * 60000]] } }, // 00:30 МСК
    reverseGeocode: async () => "Адрес",
  });
  const res = {};
  await h({ headers: {}, url: "/api/drivers/location-report?date=" + day + "&driverId=7&interval=30" },
    res, "/api/drivers/location-report", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200, JSON.stringify(res._json));
  assert.ok(res._json.obj.rows.some((r) => r.time === "00:30"),
    "с интервалом 30 минут точка 00:30 должна попасть в слот 00:30");
});

test("GET /api/drivers/location-report не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/location-report?date=2026-10-03&driverId=7" },
    res, "/api/drivers/location-report", "GET", { id: "1" }, false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/location-report без даты -> 422", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/location-report?driverId=7" },
    res, "/api/drivers/location-report", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 422);
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", { id: "1" }, true);
  assert.strictEqual(r, false);
});
