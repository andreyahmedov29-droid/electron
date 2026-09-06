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
  "https://app-22aae7dc61f1.vibecode.bitrix24.tech";
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
  mainWindow.webContents.on("did-fail-load", (event, code, desc, url, isMainFrame) => {
    logWeb("ОШИБКА загрузки", code, desc, "|", url, "| main:", isMainFrame);
    // Если главная страница поддомена приложения не загрузилась (нет сессии —
    // шлюз отвечает 401 и не отдаёт HTML), направляем на вход платформы.
    if (isMainFrame && /^https:\/\/app-.*vibecode\.bitrix24\.tech/.test(url || "") && !loginRedirectPending) {
      loginRedirectPending = true;
      logWeb("did-fail-load на поддомене: переходим на вход платформы");
      try { mainWindow.loadURL("https://vibecode.bitrix24.tech"); } catch (e) { logWeb("ошибка перехода на вход:", e && e.message); }
    }
  });
  mainWindow.webContents.on("did-finish-load", () => {
    logWeb("страница загружена (финиш)");
  });
  mainWindow.webContents.on("render-process-gone", (event, details) => {
    logWeb("render-process-gone:", details && details.reason);
  });
  // Снимаем Set-Cookie при ответе шлюза на главный запрос (без разбора значений).
  const ses = mainWindow.webContents.session;
  // ЧИСТЫЙ режим: НЕ трогаем заголовки запроса (ни UA, ни Authorization).
  // Окно ведёт себя как обычный браузер, чтобы шлюз Black Hole при отсутствии
  // сессии показал экран «Защищённый сервер / Войти через Bitrix24» (200 с
  // HTML), а не отвечал 401 XML. В режиме общего токена (useSharedToken)
  // Authorization подставляется только тогда — см. applyWebToken.
  if (useSharedToken) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = details.url || "";
      if (url.startsWith(WEB_APP_URL) || url.includes("vibecode.bitrix24.tech")) {
        const h = Object.assign({}, details.requestHeaders);
        if (ACCESS_TOKEN) h["Authorization"] = "Bearer " + ACCESS_TOKEN;
        logWeb("режим общего токена: Authorization подставлен");
        callback({ requestHeaders: h });
      } else {
        callback({});
      }
    });
  }
  // Всегда логируем ПОЛНЫЙ набор исходящих заголовков окна к поддомену
  // приложения (заголовки НЕ меняем — только смотрим). Это нужно, чтобы
  // сравнить, чем запрос окна Electron отличается от запроса обычного
  // браузера, который шлюз встречает экраном входа, а не 401 JSON.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (/vibecode\.bitrix24\.tech/.test(details.url || "")) {
      logWeb("ИСХОДЯЩИЕ ЗАГОЛОВКИ ", details.method, details.url);
      logWeb("  " + JSON.stringify(details.requestHeaders || {}));
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  // Воспроизводим ЗАГОЛОВКИ браузерной навигации. Electron при loadURL посылает
  // Sec-Fetch-Dest:"empty", а настоящий Chrome при переходе по адресу — 
  // Sec-Fetch-Dest:"document" + Sec-Fetch-Mode:"navigate" + client hints.
  // Шлюз Black Hole реагирует на этот признак: «навигация» → ведёт на OAuth-
  // вход (auth2.bitrix24.net), «не навигация» (empty) → отвечает 401 JSON.
  if (!useSharedToken) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = details.url || "";
      if (/^https:\/\/app-.*vibecode\.bitrix24\.tech/.test(url) && details.resourceType === "mainFrame") {
        const h = Object.assign({}, details.requestHeaders);
        if (!/^https:\/\/app-.*vibecode\.bitrix24\.tech\/oauth|auth2\.bitrix24\.net/.test(url)) {
          h["Sec-Fetch-Dest"] = "document";
          h["Sec-Fetch-Mode"] = "navigate";
          h["Sec-Fetch-Site"] = "none";
        }
        h["Sec-CH-UA"] = '"Chromium";v="126", "Google Chrome";v="126", "Not.A/Brand";v="8"';
        h["Sec-CH-UA-Mobile"] = "?0";
        h["Sec-CH-UA-Platform"] = '"Windows"';
        callback({ requestHeaders: h });
      } else {
        callback({});
      }
    });
  }
  ses.webRequest.onHeadersReceived((details) => {
    if (/^https:\/\/app-.*vibecode\.bitrix24\.tech/.test(details.url || "")) {
      const sc = (details.responseHeaders && details.responseHeaders["set-cookie"]) || [];
      logWeb("ответ", details.statusCode, "url:", details.url, "| set-cookie:", sc.length);
      // На 401/302 логируем ВСЕ заголовки ответа — там может быть Location
      // (куда вести на вход) или WWW-Authenticate/подсказка о способе входа.
      if (details.statusCode === 401 || details.statusCode === 302 || details.statusCode === 403) {
        logWeb("  ЗАГОЛОВКИ ОТВЕТА:", JSON.stringify(details.responseHeaders || {}));
      }
      // Личный вход через платформу: если поддомен приложения отвечает 401
      // (нет сессии платформы), перенаправляем окно на вход платформы
      // vibecode.bitrix24.tech (SSO → auth2.bitrix24.net → Битрикс24). После
      // входа сессия появится в cookie, слушатель session.cookies ниже вернёт
      // окно обратно на приложение. Главный запрос (GET /) — это и есть
      // загрузка документа, поэтому не ограничиваем по resourceType (в
      // onHeadersReceived он может приходить не как "mainFrame").
      if (details.statusCode === 401 && !loginRedirectPending) {
        loginRedirectPending = true;
        logWeb("НЕТ СЕССИИ: перенаправляем на вход платформы vibecode.bitrix24.tech");
        try { mainWindow.loadURL("https://vibecode.bitrix24.tech"); } catch (e) { logWeb("ошибка перехода на вход:", e && e.message); }
      }
    }
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

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// В режиме A окно открывает веб-версию КАК ОБЫЧНЫЙ БРАУЗЕР. По умолчанию
// (личный вход) никакой access-токен НЕ подставляется: шлюз Black Hole при
// отсутствии сессии показывает экран «Защищённый сервер / Войти через
// Bitrix24», пользователь входит, сессия сохраняется в userData (persist).
// Общий токен (`Authorization: Bearer vibe_app_local_...`) — только при явно
// включённом useSharedToken, и подставляется в перехвате внутри createWindow.
function applyWebToken() {
  if (!useWebMode) return;
  if (useSharedToken) {
    if (!ACCESS_TOKEN) {
      console.warn("[web] Режим общего токена включён (useSharedToken=true), "
        + "но BIOTIME_ACCESS_TOKEN не задан — шлюз вернёт 401. "
        + "Задайте токен в переменной окружения или в конфиге.");
    } else {
      console.log("[web] Режим общего токена: Authorization: Bearer будет подставляться.");
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
    applyWebToken();
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
