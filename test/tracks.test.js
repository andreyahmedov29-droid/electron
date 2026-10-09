// Юнит-тесты модуля routes/tracks.js — GPS-следы.
const { test } = require("node:test");
const assert = require("node:assert");
const createTracksHandler = require("../routes/tracks");

function make(ctx) {
  return createTracksHandler(Object.assign({
    getDb: () => ({ staff: [{ id: "7", name: "Иван" }] }),
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    isDriver: () => true,
    motionDayKey: () => "2026-10-03",
    tracksByDay: { "2026-10-03": { "7": [[55.7, 37.6, 1], [55.71, 37.61, 2]] } },
    snappedTracks: {},
    snapTrackToRoads: () => Promise.resolve(null),
    scheduleSnappedSave: () => {},
  }, ctx || {}));
}

test("GET /api/drivers/tracks не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ "headers": {} }, res, "/api/drivers/tracks", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/drivers/tracks админ -> треки", async () => {
  const h = make();
  const res = {};
  await h({ headers: {}, url: "/api/drivers/tracks?date=2026-10-03" }, res, "/api/drivers/tracks", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.tracks.length, 1);
  assert.strictEqual(res._json.obj.tracks[0].name, "Иван");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", true);
  assert.strictEqual(r, false);
});
