// Юнит-тесты модуля routes/app.js — версия приложения и карта.
const { test } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const createAppHandler = require("../routes/app");

function make(overrides) {
  return createAppHandler(Object.assign({
    getDb: () => ({ params: {} }),
    persistDb: async () => {},
    sendJson: (res, status, obj) => { res._json = { status, obj }; },
    readBody: async () => ({}),
    writeVersionSource: () => {},
    readVersionSource: () => ({}),
    fetchRemoteApkVersion: async () => null,
    yandexMapsKey: "KEY",
  }, overrides || {}));
}

test("GET /api/app/web-version отдаёт версию", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/app/web-version", "GET", false);
  assert.strictEqual(res._json.status, 200);
  assert.match(res._json.obj.version, /^\d{8}c\d{3}$/);
});

test("GET /api/maps/config не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/maps/config", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/maps/config админ -> ключ карты", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/maps/config", "GET", true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.yandexKey, "KEY");
});

test("GET /api/ip отдаёт реальный IP сервера", async () => {
  const h = make({ resolvePublicIp: async () => "203.0.113.7" });
  const res = {};
  await h({ headers: {} }, res, "/api/ip", "GET", false);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.ip, "203.0.113.7");
});

test("GET /api/ip при недоступном резолвере -> ip:null (не падает)", async () => {
  const h = make({ resolvePublicIp: async () => { throw new Error("net"); } });
  const res = {};
  await h({ headers: {} }, res, "/api/ip", "GET", false);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.ip, null);
});

test("GET /api/1c/ping не-админ -> 403", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/1c/ping", "GET", false);
  assert.strictEqual(res._json.status, 403);
});

test("GET /api/1c/log админ -> rows", async () => {
  const h = make({ getOnecPullLog: () => [{ ts: Date.now(), source: "button", inn: "7733379914", login: "GLAV", ok: true, number: "00УТ-0004385", posCount: 2 }] });
  const res = {};
  await h({ headers: {} }, res, "/api/1c/log", "GET", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.rows.length, 1);
  assert.strictEqual(res._json.obj.rows[0].inn, "7733379914");
});

test("POST /api/1c/log/delete удаляет запись (возвращает 200) и 404 при отсутствии", async () => {
  const h = make({
    readBody: async () => ({ id: "A1" }),
    deleteOnecPullLog: (id) => id === "A1",
  });
  const res1 = {};
  await h({ headers: {}, url: "/api/1c/log/delete" }, res1, "/api/1c/log/delete", "POST", { id: "1" }, true);
  assert.strictEqual(res1._json.status, 200);

  const h2 = make({
    readBody: async () => ({ id: "NOPE" }),
    deleteOnecPullLog: (id) => id === "A1",
  });
  const res2 = {};
  await h2({ headers: {}, url: "/api/1c/log/delete" }, res2, "/api/1c/log/delete", "POST", { id: "1" }, true);
  assert.strictEqual(res2._json.status, 404);
});

test("POST /api/waybills/from-1c без настроенного URL -> не падает (noInn/filled=0)", async () => {
  const h = make({ readBody: async () => ({ clients: [] }) });
  const res = {};
  await h({ headers: {} }, res, "/api/waybills/from-1c", "POST", { id: "1" }, true);
  assert.strictEqual(res._json.status, 200);
  assert.strictEqual(res._json.obj.ok, false);
  assert.match(String(res._json.obj.error), /ONEC_API_URL/);
});

test("POST /api/waybills/from-1c: пустой ответ 1С НЕ пишется в журнал (повтор/уже забрано не сбивает лог)", async () => {
  // Мок 1С, который всегда возвращает пустой JSON — контрагент «не найден» /
  // документы уже забраны (1С вернула 0 доков, diag.docs === 0). Записи в журнал
  // не создаём: пустые строки только «сбивают» лог при повторном заборе.
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const oldBase = process.env.ONEC_API_URL;
  const oldUser = process.env.ONEC_API_USER;
  const oldPass = process.env.ONEC_API_PASS;
  process.env.ONEC_API_URL = `http://127.0.0.1:${port}/shipment`;
  delete process.env.ONEC_API_USER;
  delete process.env.ONEC_API_PASS;
  const logged = [];
  const h = make({
    getOnecPullLog: () => logged,
    pushOnecPullLog: (e) => { logged.push(e); },
    readBody: async () => ({
      clients: [
        { inn: "5047254063", login: "SEV", client: "Рсервис Север" },
        { inn: "7714345645", login: "DOC", client: "Автодок" },
      ],
    }),
  });
  const res = {};
  try {
    await h({ headers: {} }, res, "/api/waybills/from-1c", "POST", { id: "1" }, true);
    assert.strictEqual(res._json.status, 200);
    // Пустые ответы (1С вернула 0 доков) в журнал не пишутся.
    assert.strictEqual(logged.length, 0, "пустые ответы не должны попадать в журнал");
  } finally {
    if (oldBase === undefined) delete process.env.ONEC_API_URL; else process.env.ONEC_API_URL = oldBase;
    if (oldUser === undefined) delete process.env.ONEC_API_USER; else process.env.ONEC_API_USER = oldUser;
    if (oldPass === undefined) delete process.env.ONEC_API_PASS; else process.env.ONEC_API_PASS = oldPass;
    await new Promise((r) => srv.close(r));
  }
});

test("БАГ: /api/waybills/from-1c отдаёт клиенту накладные с ЧУЖИМ ИНН (не сверяет d.inn), если 1С возвращает общий список", async () => {
  // 1С возвращает на ЛЮБОЙ запрос одну и ту же накладную, которая по полю
  // «inn» принадлежит ДРУГОМУ клиенту (везде d.inn = 222), а не запросившему.
  // Правильное поведение: сервер должен распределить накладную клиенту, чей
  // ИНН совпадает с d.inn (222), а не тому, кто запросил (111). Сейчас он
  // отдаёт её первому запросившему — поэтому «все накладные уходят одному».
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{
      shipment_number: "88YT-000111",
      inn: "2229999999", // принадлежит другому контрагенту (NOT запросившему)
      id_partstiker_list: [
        { id_partstiker: "0001/1", articul_number: "ART1", name: "Деталь", quantity: 1 },
      ],
    }]));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const oldBase = process.env.ONEC_API_URL, oldUser = process.env.ONEC_API_USER, oldPass = process.env.ONEC_API_PASS;
  process.env.ONEC_API_URL = `http://127.0.0.1:${port}/shipment`;
  delete process.env.ONEC_API_USER; delete process.env.ONEC_API_PASS;
  const logged = [];
  const h = make({
    getOnecPullLog: () => logged,
    pushOnecPullLog: (e) => logged.push(e),
    readBody: async () => ({
      clients: [
        { inn: "1111111111", login: "FROZ", client: "Фроза" },
        { inn: "2229999999", login: "LXTT", client: "ЛюксТрейд" },
      ],
    }),
  });
  const res = {};
  try {
    await h({ headers: {} }, res, "/api/waybills/from-1c", "POST", { id: "1" }, true);
    assert.strictEqual(res._json.status, 200);
    const wb = res._json.obj.waybills;
    // Накладная по полю inn принадлежит второму клиенту (2229999999).
    // Сервер должен положить её второму клиенту, а не первому (1111111111).
    // Если баг воспроизведён — оба клиента получат одну и ту же чужую накладную.
    const firstGetsItems = wb[0] && wb[0].ok === true && Array.isArray(wb[0].items) && wb[0].items.length > 0;
    const secondGetsItems = wb[1] && wb[1].ok === true && Array.isArray(wb[1].items) && wb[1].items.length > 0;
    assert.strictEqual(
      firstGetsItems,
      false,
      "БАГ ПОДТВЕРЖДЁН: сервер отдал накладную с ИНН 2229999999 первому клиенту (1111111111), не сверив d.inn с ИНН клиента — все накладные уходят одному из-за этого"
    );
    assert.strictEqual(secondGetsItems, true, "Накладная должна попасть клиенту с ИНН 2229999999");
  } finally {
    if (oldBase === undefined) delete process.env.ONEC_API_URL; else process.env.ONEC_API_URL = oldBase;
    if (oldUser === undefined) delete process.env.ONEC_API_USER; else process.env.ONEC_API_USER = oldUser;
    if (oldPass === undefined) delete process.env.ONEC_API_PASS; else process.env.ONEC_API_PASS = oldPass;
    await new Promise((r) => srv.close(r));
  }
});

test("БАГ: повторный/последовательный проход теряет накладные из-за alreadyLog-дедупа (после первого клиента остальные Пусто)", async () => {
  // Симптом из прод-логов: нажимаем «Заполнить из 1С», первый клиент заполняется,
  // а у остальных «Пусто», хотя 1С им что-то может отдать. Причина — дедуп по
  // номеру накладной в alreadyLog: запись успешного забора первого клиента
  // добавляется в журнал, и следующий клиент, которому 1С вернула ту же накладную
  // (общий список/повтор номера), отсекается как дубль (dup).
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // 1С возвращает ОДНУ И ТУ ЖЕ накладную с номером 88YT-000111 на ЛЮБОЙ запрос
    // (как при нефильтрующем списке реализаций на эту дату).
    res.end(JSON.stringify([{
      shipment_number: "88YT-000111",
      inn: "",
      id_partstiker_list: [{ id_partstiker: "0001/1", articul_number: "ART1", name: "Деталь", quantity: 1 }],
    }]));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const oldBase = process.env.ONEC_API_URL, oldUser = process.env.ONEC_API_USER, oldPass = process.env.ONEC_API_PASS;
  process.env.ONEC_API_URL = `http://127.0.0.1:${port}/shipment`;
  delete process.env.ONEC_API_USER; delete process.env.ONEC_API_PASS;
  const logged = [];
  const h = make({
    getOnecPullLog: () => logged,
    pushOnecPullLog: (e) => logged.push(e),
    readBody: async () => ({
      clients: [
        { inn: "1111111111", login: "A", client: "Клиент А" },
        { inn: "2229999999", login: "B", client: "Клиент Б" },
      ],
    }),
  });
  const res = {};
  try {
    await h({ headers: {} }, res, "/api/waybills/from-1c", "POST", { id: "1" }, true);
    assert.strictEqual(res._json.status, 200);
    const wb = res._json.obj.waybills;
    // Оба клиента получили от 1С одну и ту же накладную (общий список).
    // Если only первый ok — баг дедупа воспроизведён: второй клиент «Пусто»,
    // хотя 1С что-то вернула. Ожидаем, что оба получили накладную (each its own).
    const firstOk = wb[0] && wb[0].ok === true && Array.isArray(wb[0].items) && wb[0].items.length > 0;
    const secondOk = wb[1] && wb[1].ok === true && Array.isArray(wb[1].items) && wb[1].items.length > 0;
    assert.strictEqual(
      secondOk,
      true,
      "БАГ ПОДТВЕРЖДЁН: второй клиент получил «Пусто», потому что накладная 88YT-000111 уже забрана первым клиентом (alreadyLog-дедуп отсекает её) — так при последовательном проходе заполняется только первый"
    );
  } finally {
    if (oldBase === undefined) delete process.env.ONEC_API_URL; else process.env.ONEC_API_URL = oldBase;
    if (oldUser === undefined) delete process.env.ONEC_API_USER; else process.env.ONEC_API_USER = oldUser;
    if (oldPass === undefined) delete process.env.ONEC_API_PASS; else process.env.ONEC_API_PASS = oldPass;
    await new Promise((r) => srv.close(r));
  }
});

test("накладная с НЕСОВПАДАЮЩИМ inn НЕ разносится клиенту (1С отдала чужую/все активные)", async () => {
  // Клиент запрашивает со своим ИНН 1111111111. 1С отвечает накладной, где
  // inn = 5001007322 (не совпадает с клиентом). По правилу строгой сверки такая
  // накладная не разносится этому клиенту — иначе «забрали больше, чем нужно»
  // (1С могла отдать все активные накладные).
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{
      shipment_number: "88YT-8804500",
      inn: "5001007322", // ИНН владельца, НЕ совпадает с ИНН клиента 1111111111
      id_partstiker_list: [{ id_partstiker: "0001/1", articul_number: "ART1", name: "Деталь", quantity: 1 }],
    }]));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const oldBase = process.env.ONEC_API_URL, oldUser = process.env.ONEC_API_USER, oldPass = process.env.ONEC_API_PASS;
  process.env.ONEC_API_URL = `http://127.0.0.1:${port}/shipment`;
  delete process.env.ONEC_API_USER; delete process.env.ONEC_API_PASS;
  const logged = [];
  const h = make({
    getOnecPullLog: () => logged,
    pushOnecPullLog: (e) => logged.push(e),
    readBody: async () => ({
      clients: [
        { inn: "1111111111", login: "FROZ", client: "Фроза" },
      ],
    }),
  });
  const res = {};
  try {
    await h({ headers: {} }, res, "/api/waybills/from-1c", "POST", { id: "1" }, true);
    assert.strictEqual(res._json.status, 200);
    const got = res._json.obj.waybills[0];
    const gotItems = got && got.ok === true && Array.isArray(got.items) && got.items.length > 0;
    assert.strictEqual(
      gotItems,
      false,
      "накладная с чужим ИНН (5001007322 ≠ 1111111111) не должна разноситься этому клиенту"
    );
  } finally {
    if (oldBase === undefined) delete process.env.ONEC_API_URL; else process.env.ONEC_API_URL = oldBase;
    if (oldUser === undefined) delete process.env.ONEC_API_USER; else process.env.ONEC_API_USER = oldUser;
    if (oldPass === undefined) delete process.env.ONEC_API_PASS; else process.env.ONEC_API_PASS = oldPass;
    await new Promise((r) => srv.close(r));
  }
});

test("POST /api/app/update c неверным токеном -> 401", async () => {
  const h = make();
  const res = {};
  await h({ headers: { "x-update-token": "wrong" } }, res, "/api/app/update", "POST", true);
  assert.strictEqual(res._json.status, 401);
});

test("GET /api/app/update-info использует фолбэки", async () => {
  const h = make();
  const res = {};
  await h({ headers: {} }, res, "/api/app/update-info", "GET", false);
  assert.strictEqual(res._json.status, 200);
  assert.ok(res._json.obj.versionCode >= 1);
  assert.ok(typeof res._json.obj.apkUrl === "string");
});

test("неизвестный маршрут -> false", async () => {
  const h = make();
  const r = await h({ headers: {} }, {}, "/api/nope", "GET", true);
  assert.strictEqual(r, false);
});
