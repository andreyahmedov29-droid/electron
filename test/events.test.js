// Юнит-тесты модуля routes/events.js — Server-Sent Events.
const { test } = require("node:test");
const assert = require("node:assert");
const createEventsHandler = require("../routes/events");

function make(ctx) {
  const sse = new Set();
  const cfg = Object.assign({ sseClients: sse, sseWrite: () => {} }, ctx || {});
  return { h: createEventsHandler(cfg), sse };
}

function fakeRes() {
  const handlers = {};
  return {
    head: null,
    writeHead(s, o) { this.head = { s, o }; },
    write() {},
    on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
    end() {},
    emit(ev) { (handlers[ev] || []).forEach((cb) => cb()); },
  };
}

test("GET /api/events открывает SSE-поток и держит соединение", () => {
  const { h, sse } = make();
  const res = fakeRes();
  const req = { on() {} };
  const r = h(req, res, "/api/events", "GET", { id: "u1" });
  // метод регистрирует res в sseClients; затем закрытие соединения его убирает
  assert.notStrictEqual(r, false);
  assert.strictEqual(sse.size, 1);
  res.emit("close");
  assert.strictEqual(sse.size, 0);
});

test("неизвестный маршрут -> false", async () => {
  const { h } = make();
  const r = await h({ on() {} }, fakeRes(), "/api/nope", "GET", { id: "u1" });
  assert.strictEqual(r, false);
});
