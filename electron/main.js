// Биотим — desktop-приложение для Windows на Electron.
//
// Два режима работы:
//  [A] Веб-версия (по умолчанию): приложение открывает веб-версию BIOTIME на
//      платформе Вайкода (фиксированный адрес) и проходит шлюз платформы через
//      access-токен (заголовок Authorization: Bearer). Свой локальный сервер не
//      поднимается — данные/табель общие на всех (как в вебе), вход = выбор
//      сотрудника внутри приложения. Адрес и токен задаются переменными
//      окружения BIOTIME_APP_URL / BIOTIME_ACCESS_TOKEN (не хардкодятся в коде).
//  [B] Локальный автономный: если BIOTIME_APP_URL не задан, поднимается
//      собственная копия server.js на локальном порту (по умолчанию 3123) и
//      открывается http://localhost:<port>. Данные — локальная БД приложения.
//
// Веб-версия BIOTIME остаётся нетронутой — десктоп лишь подключается к ней.

const { app, BrowserWindow, shell, dialog } = require("electron");
const { session } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require("electron-updater");

// ---- Режим A: веб-версия на платформе ----
// Адрес веб-версии BIOTIME и access-токен для прохода через шлюз платформы.
// Источники (приоритет сверху вниз):
//   1) переменные окружения BIOTIME_APP_URL / BIOTIME_ACCESS_TOKEN;
//   2) конфиг-файл biotime.config.json в папке данных приложения
//      (поля appUrl / accessToken) — удобно прописать один раз и раздать
//      вместе с установщиком;
//   3) фиксированный адрес инстанса (fallback).
// Токен в код/сборку не включается.
let _cfg = {};
try {
  const cfgPath = path.join(app.getPath("userData"), "biotime.config.json");
  if (fs.existsSync(cfgPath)) {
    _cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")) || {};
  }
} catch { /* необязательный конфиг — при отсутствии используем env/fallback */ }

const WEB_APP_URL =
  process.env.BIOTIME_APP_URL ||
  (_cfg.appUrl && String(_cfg.appUrl)) ||
  "https://app-2660de1a180b.vibecode.bitrix24.tech";
const ACCESS_TOKEN = process.env.BIOTIME_ACCESS_TOKEN || (_cfg.accessToken || "");
// Личный вход через шлюз (по умолчанию): окно ведёт себя как обычный браузер,
// шлюз Black Hole при отсутствии сессии показывает экран «Защищённый сервер /
// Войти через Bitrix24», пользователь входит, и сессия сохраняется в userData.
// Общий access-токен при этом НЕ подставляется. Режим общего токена включается
// только явно: "useSharedToken": true в biotime.config.json либо
// BIOTIME_USE_SHARED_TOKEN=1. 
const useSharedToken =
  (process.env.BIOTIME_USE_SHARED_TOKEN === "1" || process.env.BIOTIME_USE_SHARED_TOKEN === "true") ||
  _cfg.useSharedToken === true;
// Имя принтера для прямой печати этикеток (без диалога). Если не задано —
// печатаем на принтер по умолчанию Windows. Пропишите в biotime.config.json
// поле "printerName": "HP...", чтобы печать шла всегда на нужный принтер.
const PRINTER_NAME = process.env.BIOTIME_PRINTER_NAME || (_cfg.printerName || "");
// Включён ли режим A (веб-версия). Если адрес задан — да.
const useWebMode = !!WEB_APP_URL && String(WEB_APP_URL).length > 0;

// Порт локального сервера. Можно переопределить через переменную окружения
// BIOTIME_PORT (например при конфликте порта на машине пользователя).
const PORT = Number(process.env.BIOTIME_PORT) || 3123;
// Адрес, который открывает окно.
const APP_URL = useWebMode ? WEB_APP_URL : `http://localhost:${PORT}`;

// Путь к корню проекта (папка, где лежат server.js, public/assets и т.д.).
// В dev он рядом с electron/main.js; в упакованном exe — в resources/app.
const PROJECT_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.join(__dirname, "..");

let serverProc = null;   // дочерний процесс Node (server.js)
let mainWindow = null;   // главное окно
let shuttingDown = false;
// Флаг: окно перенаправлено на вход платформы (vibecode.bitrix24.tech), чтобы
// не перенаправлять повторно и вернуться на приложение после установки сессии.
let loginRedirectPending = false;

// Пишет строку в файл web-gate.log в папке данных приложения. Нужно для
// диагностики входа: stdout GUI-приложения Windows в обычном запуске не виден,
// поэтому логируем в файл, который можно прочитать после запуска exe.
function logWeb(...args) {
  try {
    const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
    fs.appendFileSync(path.join(app.getPath("userData"), "web-gate.log"), line);
  } catch { /* диагностика не должна ронять приложение */ }
}

// Проверяет, отвечает ли локальный сервер (готов к открытию окна).
function serverIsUp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Дожидается готовности сервера с ограниченным числом попыток.
async function waitForServer(attempt = 0) {
  const MAX = 50;
  if (await serverIsUp("localhost", PORT)) return true;
  if (attempt >= MAX) return false;
  await new Promise((r) => setTimeout(r, 300));
  return waitForServer(attempt + 1);
}

// Запускает локальную копию сервера BIOTIME как дочерний процесс.
function startServer() {
  const serverPath = path.join(PROJECT_ROOT, "server.js");
  if (!fs.existsSync(serverPath)) {
    console.error("Server not found:", serverPath);
    return false;
  }
  const env = {
    ...process.env,
    PORT: String(PORT),
    // Локальный запуск без шлюза: сервер хранит БД и файлы не в /data (его на
    // Windows нет), а в папке данных приложения (куда у Electron есть права
    // записи). Путь резолвит server.js через process.env.DATA_DIR.
    DATA_DIR: path.join(app.getPath("userData"), "data"),
    // Ключевой трюк упаковки: process.execPath в dev и в exe указывает на
    // electron(.exe). Чтобы запустить server.js как обычный Node-скрипт, а не
    // новый инстанс Electron, передаём флаг ELECTRON_RUN_AS_NODE=1 — при нём
    // Electron отрабатывает как чистый Node-рантайм (без GUI).
    ELECTRON_RUN_AS_NODE: "1",
  };
  serverProc = spawn(process.execPath, [serverPath], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProc.stdout.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.log("[server]", s);
  });
  serverProc.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.error("[server]", s);
  });
  serverProc.on("error", (err) => {
    console.error("Failed to start server:", err);
  });
  serverProc.on("exit", (code) => {
    console.log("[server] exited with code", code);
    serverProc = null;
    if (!shuttingDown) app.quit();
  });
  return true;
}

// Создаёт главное окно приложения.
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "BIOTIME",
    backgroundColor: "#0e1116",
    autoHideMenuBar: true,
    webPreferences: {
      // Локальный сервер доверяем; дополнительных node-привилегий странице не даём.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Постоянная partition: cookies и сессия шлюза (вход в личную учётку)
      // сохраняются в userData и держатся между перезапусками приложения.
      // Не путать с изолированной (persist: — постоянная, а не in-memory):
      // без неё окно использует непостоянную defaultSession, вход теряется на
      // каждом запуске и шлюз отвечает BH_LOGIN_REQUIRED при старте.
      partition: "persist:biotime",
    },
  });

  mainWindow.loadURL(APP_URL);

  // Внешние ссылки (портал, документация) открываем во внешнем браузере.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Прямая печать этикеток БЕЗ окна предпросмотра. Когда страница вызывает
  // window.print() (печать этикеток), Chromium генерирует событие "print" в
  // webContents. Мы перехватываем его и печатаем молча (silent) на принтер:
  //   * принтер — из конфига (printerName) или системный по умолчанию;
  //   * размер листа — этикетка 58×40 мм (в микронах);
  //   * без полей и без диалога — стикер уходит на печать сразу.
  // Благодаря правилу @media print из styles.css в печать попадает только
  // #printArea (макет этикетки), остальной интерфейс скрывается.
  mainWindow.webContents.on("print", (event, wc) => {
    event.preventDefault();
    const printOpts = {
      silent: true,                     // без диалога предпросмотра
      printBackground: true,
      margins: { marginType: "none" },  // этикетка без полей
      pageSize: { width: 58000, height: 40000 }, // 58×40 мм (микроны)
    };
    if (PRINTER_NAME) printOpts.printerName = PRINTER_NAME;
    wc.print(printOpts, (ok, failureReason) => {
      if (!ok) console.error("[print] Печать не удалась:", failureReason || "unknown");
      else console.log("[print] Этикетки отправлены на печать.");
    });
  });

  // ---- Диагностика входа через шлюз ----
  // Логируем редиректы и завершения загрузки главного окна, чтобы понять, как
  // шлюз Black Hole встречает окно Electron (экран входа или JSON BH_LOGIN_REQUIRED).
  mainWindow.webContents.on("did-redirect-navigation", (event, url) => {
    logWeb("редирект →", url);
  });
  mainWindow.webContents.on("did-navigate", (event, url) => {
    logWeb("навигация/загрузка →", url);
  });
  // Точные начала/завершения навигации — увидеть, сколько раз окно пытается
  // загрузить документ и на каком URL. Полезно при чёрном экране первого
  // запуска: понять, дошла ли навигация до реального URL или застряла на
  // пустом/исходном адресе.
  mainWindow.webContents.on("did-start-navigation", (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) logWeb("start-nav →", url, "| inPlace:", isInPlace);
  });
  mainWindow.webContents.on("did-navigate-in-page", (event, url, isMainFrame) => {
    if (isMainFrame) logWeb("in-page →", url);
  });
  mainWindow.webContents.on("did-fail-load", (event, code, desc, url, isMainFrame) => {
    logWeb("ОШИБКА загрузки", code, desc, "|", url, "| main:", isMainFrame);
    // Ручной редирект на /auth/login ЗДЕСЬ НЕ ДЕЛАЕМ (убрано в 1.1.4).
    // Любая ошибка mainFrame на поддомене (в т.ч. ERR_ABORTED от корректной
    // 200-навигации) прерывала загрузку документа и вела на вход, из-за чего
    // шлюз-навигация отменялась и окно оставалось чёрным. Шлюз сам показывает
    // экран входа при отсутствии сессии — ручной переход не нужен.
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logWeb("страница загружена (финиш)");
    logWeb("  URL документа:", mainWindow.webContents.getURL());
    // Что реально в документе (url/title/высота/длина текста) — понять, отрисовывается
    // ли страница входа или это пустой/тёмный документ.
    try {
      mainWindow.webContents.executeJavaScript(
        "JSON.stringify({url: location.href, title: document.title, h: " +
        "(document.documentElement?document.documentElement.scrollHeight:-1), " +
        "body: (document.body?document.body.innerText.length:-1), html: " +
        "(document.documentElement?document.documentElement.outerHTML.length:-1)})",
        true
      ).then((r) => logWeb("  DOM:", r))
       .catch((e) => logWeb("  DOM err:", e && e.message));
    } catch (e) { logWeb("  executeJavaScript err:", e && e.message); }
    // Скриншот окна в userData/screen.png — увидеть, что реально рендерится.
    try {
      mainWindow.webContents.capturePage()
        .then((img) => {
          const p = path.join(app.getPath("userData"), "screen.png");
          fs.writeFileSync(p, img.toPNG());
          logWeb("  скриншот сохранён:", p);
        })
        .catch((e) => logWeb("  capture err:", e && e.message));
    } catch (e) { logWeb("  capture err2:", e && e.message); }
  });
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    logWeb("render-process-gone:", details && details.reason);
  });
  // Снимаем Set-Cookie при ответе шлюза на главный запрос (без разбора значений).
  const ses = mainWindow.webContents.session;
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (/^https:\/\/app-.*vibecode\.bitrix24\.tech/.test(details.url || "")) {
      const sc = (details.responseHeaders && details.responseHeaders["set-cookie"]) || [];
      const ct = (details.responseHeaders && details.responseHeaders["content-type"]) || [];
      const cl = (details.responseHeaders && details.responseHeaders["content-length"]) || [];
      logWeb("ответ", details.statusCode, "url:", details.url,
        "| set-cookie:", sc.length,
        "| content-type:", Array.isArray(ct) ? ct[0] : ct,
        "| content-length:", Array.isArray(cl) ? cl[0] : cl);
      // На 401/302 логируем ВСЕ заголовки ответа — там может быть Location
      // (куда вести на вход) или WWW-Authenticate/подсказка о способе входа.
      if (details.statusCode === 401 || details.statusCode === 302 || details.statusCode === 403) {
        logWeb("  ЗАГОЛОВКИ ОТВЕТА:", JSON.stringify(details.responseHeaders || {}));
      }
      // Ручной редирект на /auth/login на 401 ЗДЕСЬ НЕ ДЕЛАЕМ (убрано в 1.1.4).
      // Шлюз Black Hole сам отдаёт 200 HTML экрана входа при отсутствии
      // сессии; ручной loadURL(.../auth/login) в onHeadersReceived отменял
      // корректную mainFrame-навигацию (ERR_ABORTED + пустой getURL()).
      // Вход завершён: окно снова успешно (200) загрузило именно КОРНЕВУЮ
      // страницу приложения — значит шлюз отдал документ, то есть сессия есть.
      // ВАЖНО: судить только по корню, а не по любому 200 на поддомене: шлюз
      // отдаёт /sw.js и другие статические подресурсы 200 даже БЕЗ сессии, и
      // такой 200 ложно сбрасывал флаг входа, оставляя чёрный экран (окно уже
      // не перенаправлялось на вход, а сессии так и не было).
      if (loginRedirectPending && details.statusCode === 200
          && String(details.url || "").replace(/\/$/, "") === WEB_APP_URL.replace(/\/$/, "")) {
        logWeb("Вход выполнен: приложение отвечает 200; снимаем флаг ожидания входа");
        loginRedirectPending = false;
      }
    }
    // КРИТИЧНО (фикс 1.1.7): onHeadersReceived — это callback-API. Обработчик
    // ОБЯЗАН вызвать callback(), иначе Chromium не продолжит доставку тела
    // ответа: навигация mainFrame зависает (getURL() пуст, isLoading=true,
    // DOM не парсится, окно чёрное) и через несколько секунд обрывается
    // net::ERR_ABORTED. Именно этого не хватало во всех предыдущих версиях —
    // 200 text/html от шлюза приходил, но не становился документом окна.
    callback({});
  });
  // Возврат на приложение после того, как сессия платформы установилась в
  // cookie (пользователь прошёл вход). Слушаем появление cookie на домене
  // vibecode.bitrix24.tech и, если мы перенаправляли на вход, открываем
  // приложение снова — теперь шлюз пустит по сессии.
  if (!useSharedToken) {
    try {
      ses.cookies.on("changed", (event, cookie) => {
        if (loginRedirectPending && cookie && /(vibecode\.bitrix24\.tech)$/.test(String(cookie.domain || ""))) {
          logWeb("Обнаружена cookie сессии платформы; возвращаемся на приложение");
          loginRedirectPending = false;
          try { mainWindow.loadURL(WEB_APP_URL); } catch (e) { logWeb("ошибка возврата:", e && e.message); }
        }
      });
    } catch (e) {
      logWeb("не удалось слушать cookies:", e && e.message);
    }
  }

  // ---- Авто-диагностика, не зависящая от did-finish-load ----
  // Страница может прийти 200, но так и не завершить загрузку (did-finish-load
  // не наступает, окно остаётся чёрным). Поэтому снимаем URL/DOM/скриншот по
  // таймеру через несколько секунд после старта, а не по событию load.
  function captureDump() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      const u = mainWindow.webContents.getURL();
      const loaded = !mainWindow.webContents.isLoading();
      logWeb("[dump] URL:", JSON.stringify(u), "| isLoading:", String(!loaded),
        "| finished:", String(loaded));
      mainWindow.webContents.executeJavaScript(
        "(function(){var de=document.documentElement;var b=document.body;" +
        "return JSON.stringify({title:document.title, h:(de?de.scrollHeight:-1), " +
        "body:(b?b.innerText.length:-1), html:(de?de.outerHTML.length:-1)})})()",
        true
      ).then((r) => logWeb("[dump] DOM:", r))
       .catch((e) => logWeb("[dump] DOM err:", e && e.message));
      // executeJavaScript молчит — нет исполняемого документа — это главный
      // маркер проблемы. На случай зависшего контекста логируем факт отдельно.
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        logWeb("[dump] JS-статус: окно всё ещё в",
          mainWindow.webContents.isLoading() ? "загрузке (нет DOM)" : "завершено");
      }, 800);
    } catch (e) { logWeb("[dump] js err:", e && e.message); }
    try {
      mainWindow.webContents.capturePage()
        .then((img) => {
          const p = path.join(app.getPath("userData"), "screen.png");
          fs.writeFileSync(p, img.toPNG());
          logWeb("[dump] скриншот:", p);
        })
        .catch((e) => logWeb("[dump] capture err:", e && e.message));
    } catch (e) { logWeb("[dump] capture err2:", e && e.message); }
  }
  setTimeout(captureDump, 5000);
  setTimeout(captureDump, 12000);

  // Сетевые события: какие URL страница реально запрашивает и что висит/падает.
  try {
    ses.webRequest.onCompleted((details) => {
      const u = details.url || "";
      if (/vibecode\.bitrix24\.tech|auth2\.bitrix24\.net|app-/.test(u)) {
        logWeb("[net] done", details.statusCode, u, "| type:", details.resourceType || "?");
      }
    });
    ses.webRequest.onErrorOccurred((details) => {
      const u = details.url || "";
      if (/vibecode\.bitrix24\.tech|auth2\.bitrix24\.net|app-/.test(u)) {
        logWeb("[net] ОШИБКА", details.error || "?", u, "| type:", details.resourceType || "?");
      }
    });
  } catch (e) { logWeb("ошибка сетевого лога:", e && e.message); }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// В режиме A окно открывает веб-версию КАК ОБЫЧНЫЙ БРАУЗЕР. По умолчанию
// (личный вход) никакой access-токен НЕ подставляется: шлюз Black Hole при
// отсутствии сессии показывает экран «Защищённый сервер / Войти через
// Bitrix24», пользователь входит, сессия сохраняется в userData (persist).
// Общий токен (`Authorization: Bearer vibe_app_local_...`) — только при явно
// включённом useSharedToken. Перехват onBeforeSendHeaders регистрируется ЗДЕСЬ,
// до createWindow()/loadURL(), на той же partition-сессии, что использует окно
// (persist:biotime), поэтому Bearer уходит уже в ПЕРВЫЙ запрос к поддомену.
async function applyWebToken() {
  // Диагностика: пишем в web-gate.log, что реально видит приложение (путь
  // конфига, режим, наличие токена) — без секретов.
  try {
    const cfgPath = path.join(app.getPath("userData"), "biotime.config.json");
    logWeb("applyWebToken: userData=", app.getPath("userData"));
    logWeb("applyWebToken: useWebMode=", useWebMode, "| useSharedToken=", String(useSharedToken));
    logWeb("applyWebToken: ACCESS_TOKEN задан =", String(!!ACCESS_TOKEN), "| конфиг:", cfgPath);
  } catch (e) { logWeb("applyWebToken log err:", e && e.message); }
  if (!useWebMode) return;
  // До первой навигации сбрасываем service worker и HTTP-кэш partition. Старый
  // sw.js приложения может перехватывать навигацию как fetch/XHR — тогда шлюз
  // отвечает HTML страницы входа 200, но Chromium не подставляет его как документ
  // окна (запрос классифицирован как XHR, а не навигация) → чёрный экран.
  try {
    const webSes = session.fromPartition("persist:biotime");
    await webSes.clearStorageData({ storages: ["serviceworkers", "cachestorage", "indexdb"] });
    logWeb("очищен service worker / кэш partition (persist:biotime)");
    // ДЕСКТОП-ФИКС (1.1.6): подресурс /sw.js на поддомене приложения
    // отвечает 401 (Black Hole защищает его — проверено, остальная статика
    // index.html/app.js отдаётся 200 без сессии). Регистрация service worker
    // на такой защищённый sw.js в Electron (изолированная partition) ломает
    // mainFrame-навигацию: навигация по mainFrame зависает/отменяется
    // net::ERR_ABORTED → окно чёрное, getURL() пуст, DOM не появляется.
    // В обычном браузере тот же 401-SW не блокирует документ (SW просто не
    // активируется), поэтому приложение там работает. В десктопном окне
    // PWA-офлайн не нужен, а само приложение рассчитано на работу и без SW
    // (в index.html на ошибку регистрации есть обработчик «работает и без SW»).
    // Блокируем запрос /sw.js, чтобы навигация шла напрямую к index.html без
    // SW-перехвата и ERR_ABORTED не возникал.
    webSes.webRequest.onBeforeRequest((details, callback) => {
      const u = details.url || "";
      if (/\.vibecode\.bitrix24\.tech/.test(u) && /\/sw\.js(\?|$)/.test(u)) {
        logWeb("блокируем service worker (sw.js):", u);
        callback({ cancel: true });
      } else {
        callback({});
      }
    });
    logWeb("установлен перехват: sw.js на поддомене блокируется (фикс 1.1.6)");
  } catch (e) {
    console.warn("[web] Не удалось очистить storage:", e && e.message);
    try { logWeb("ошибка очистки storage:", e && e.message); } catch { /* ignore */ }
  }
  if (useSharedToken) {
    if (!ACCESS_TOKEN) {
      console.warn("[web] Режим общего токена включён (useSharedToken=true), "
        + "но BIOTIME_ACCESS_TOKEN не задан — шлюз вернёт 401. "
        + "Задайте токен в переменной окружения или в конфиге.");
    } else {
      console.log("[web] Режим общего токена: Authorization: Bearer будет подставляться.");
      // Окно открывает веб-версию на partition "persist:biotime" (см.
      // createWindow), поэтому перехват ставим именно на эту сессию, а не на
      // session.defaultSession — иначе запросы окна токен не увидят.
      // Регистрируем ЗДЕСЬ, до createWindow()/loadURL(): навигация окна пойдёт
      // уже с заголовком Authorization в первом же запросе к поддомену.
      try {
        const webSes = session.fromPartition("persist:biotime");
        webSes.webRequest.onBeforeSendHeaders((details, callback) => {
          const url = details.url || "";
          if (url.startsWith(WEB_APP_URL) || url.includes("vibecode.bitrix24.tech")) {
            const h = Object.assign({}, details.requestHeaders);
            if (ACCESS_TOKEN) h["Authorization"] = "Bearer " + ACCESS_TOKEN;
            logWeb("режим общего токена: Authorization подставлен к ", url);
            callback({ requestHeaders: h });
          } else {
            callback({});
          }
        });
      } catch (e) {
        console.warn("[web] Не удалось зарегистрировать перехват Authorization:",
          e && e.message);
    }
  }
  } else {
    console.log("[web] Личный вход через шлюз: окно открывает веб-версию браузером, "
      + "шлюз покажет экран входа, кто войдёт в учётку — тот и используется.");
  }
}

// Останавливает локальный сервер при завершении приложения.
function stopServer() {
  shuttingDown = true;
  if (serverProc && !serverProc.killed) {
    try {
      serverProc.kill();
    } catch { /* ignore */ }
  }
  serverProc = null;
}

// Запуск приложения.
app.whenReady().then(async () => {
  if (useWebMode) {
    // Режим A: подключаемся к веб-версии напрямую (без локального сервера).
    // Дожидаемся сброса SW/кэша внутри applyWebToken, чтобы первая навигация
    // loadURL() не была перехвачена старым сервис-воркером и не ушла как XHR.
    await applyWebToken();
    createWindow();
  } else {
    // Режим B: поднимаем локальную копию сервера.
    if (!startServer()) {
      app.quit();
      return;
    }
    const up = await waitForServer();
    if (!up) {
      console.error("Local server did not start within the allowed time.");
      app.quit();
      return;
    }
    createWindow();
  }

  // Автообновление: только в упакованном приложении (не в dev). Проверяем и,
  // если есть новая версия, качаем её фоном и предлагаем установить.
  if (app.isPackaged) {
    setupAutoUpdater();
  }

// macOS: пересоздание окна при активации (стандартное поведение).
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ---- Автообновление приложения (только в упакованной сборке) ----
// Проверяет наличие новой версии на GitHub Releases (поле "publish" в
// package.json) и, если она есть, скачивает фоном, а при завершении загрузки
// показывает пользователю предложение перезапустить приложение для установки.
// Печать и интерфейс при этом не блокируются.
function setupAutoUpdater() {
  // Не показываем диалог обновления посреди работы водителя внезапно —
  // просто тихо качаем новую версию в фоне.
  autoUpdater.allowPrerelease = false;
  autoUpdater.autoDownload = true;      // качаем фоном
  autoUpdater.autoInstallOnAppQuit = true; // установим при закрытии

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] Найдено обновление:", info && info.version);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("[updater] Обновлений нет — текущая версия актуальна.");
  });
  autoUpdater.on("download-progress", (p) => {
    // окно занято работой — только лог, без диалогов
    if (p && Number.isFinite(p.percent)) {
      console.log(`[updater] Загрузка: ${p.percent.toFixed(0)}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] Обновление скачано:", info && info.version);
    // Предлагаем перезапуск системным диалогом (мягко, не прерывает работу).
    showUpdateReady();
  });
  autoUpdater.on("error", (err) => {
    console.error("[updater] Ошибка проверки обновления:", err && (err.message || err));
  });

  // Отложенная проверка: даём приложению и окну полностью подняться,
  // затем проверяем обновления в фоне.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[updater] checkForUpdates failed:", err && (err.message || err));
    });
  }, 5000);
}

// Показывает нативный диалог, что обновление скачано и готово к установке.
// Окно грузит веб-версию по URL, поэтому уведомляем через системный диалог,
// а не через IPC (веб-страница не слушает канал update-ready).
function showUpdateReady() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: "info",
    title: "BIOTIME — доступно обновление",
    message: "Скачана новая версия BIOTIME.",
    detail: "Перезапустить приложение сейчас, чтобы установить обновление?",
    buttons: ["Перезапустить сейчас", "Позже"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  try {
    if (choice === 0) {
      // Квитирование для autoUpdater и перезапуск с установкой.
      autoUpdater.quitAndInstall(false, true);
    }
  } catch (err) {
    console.error("[updater] Не удалось перезапустить для установки:", err && (err.message || err));
  }
}

// Один экземпляр приложения — повторный запуск фокусирует окно.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Чистый выход: убить сервер при закрытии всех окон.
app.on("window-all-closed", () => {
  stopServer();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", stopServer);
