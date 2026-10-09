const http = require("node:http");
const https = require("node:https");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Защита процесса: не даём приложению упасть (чего ждёт платформа и возвращает
// «BH_APP_STARTING» при перезапуске контейнера) из-за необработанного отказа промиса
// или исключения — например, при неудачном/зависшем обращении к 1С. Логируем и
// продолжаем работать, чтобы сервер оставался живым.
process.on("unhandledRejection", (err) => {
  try { console.error("[unhandledRejection]", (err && err.stack) || String(err)); } catch (_) { /* ignore */ }
});
process.on("uncaughtException", (err) => {
  try { console.error("[uncaughtException]", (err && err.stack) || String(err)); } catch (_) { /* ignore */ }
});

// ---- Единый источник версии (сервер / APK / desktop) ----
// Файл version.json в корне проекта задаёт актуальную версию приложения.
// APK-воркфлоу и сервер читают этот же файл: человек поднимает версию один раз
// (правка version.json), а всё остальное подхватывается автоматически.
const VERSION_FILE = path.join(ROOT, "version.json");
function readVersionSource() {
  try {
    if (fs.existsSync(VERSION_FILE)) {
      const raw = fs.readFileSync(VERSION_FILE, "utf8");
      const j = JSON.parse(raw);
      return {
        versionCode: Number(j.versionCode) || 0,
        versionName: String(j.versionName || ""),
        notes: String(j.notes || ""),
      };
    }
  } catch { /* невалидный/отсутствующий — вернём пустой объект ниже */ }
  return { versionCode: 0, versionName: "", notes: "" };
}
function writeVersionSource(versionCode, versionName, notes) {
  try {
    const data = {
      versionCode: Number(versionCode) || 1,
      versionName: String(versionName || "1.0.0"),
      notes: String(notes || ""),
    };
    fs.writeFileSync(VERSION_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[update] не удалось записать version.json:", err && (err.message || err));
  }
}

// ---- Удалённый источник актуальной версии APK (обход шлюза) ----
// Приложение Android задеплоено за Black Hole шлюзом, который авторизует КАЖДЫЙ
// запрос и режет безсессионные POST (CI не может достучаться до /api/app/update,
// возвращается 401 BH_LOGIN_REQUIRED до кода приложения). Поэтому версию APK
// сервер получает НЕ от CI, а САМ — читая единый источник актуальной версии
// прямо из публичного репозитория на GitHub (raw-файл version.json, который
// CI обновляет автоинкрементом при каждом push). raw.githubusercontent доступен
// без авторизации и не за шлюзом, поэтому update-info отдаёт актуальную версию
// без ручной правки параметров и без токена.
const REMOTE_VERSION_URL =
  process.env.APP_UPDATE_SOURCE_URL ||
  "https://raw.githubusercontent.com/andreyahmedov29-droid/biotime-android/main/version.json";
// Кэш, чтобы не дёргать GitHub на каждый запрос (TTL ниже).
let remoteApkCache = null;
async function fetchRemoteApkVersion() {
  const force = false;
  if (remoteApkCache && Date.now() - remoteApkCache.fetchedAt < (REMOTE_TTL_MS || 60000)) {
    return remoteApkCache.value;
  }
  try {
    const res = await fetch(REMOTE_VERSION_URL, { method: "GET" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const val = {
      versionCode: Number(j.versionCode) || 0,
      versionName: String(j.versionName || ""),
      notes: String(j.notes || ""),
    };
    remoteApkCache = { fetchedAt: Date.now(), value: val };
    return val;
  } catch (err) {
    // Если не удалось прочитать GitHub — возвращаем null, вызывающий код
    // откатится на локальные источники (version.json сервера / env / дефолт).
    remoteApkCache = { fetchedAt: Date.now(), value: null };
    return null;
  }
}
const REMOTE_TTL_MS = Number(process.env.APP_UPDATE_SOURCE_TTL_MS || 60000);

// ---- Persistent storage in /data (survives redeploy) ----
// Resolve with fallback so local runs still work.
const DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR !== "/data"
  ? process.env.DATA_DIR
  : (process.env.DATA_DIR || "/data");
const DATA_FILE = path.join(DATA_DIR, "db.json");
// Отдельный durable-файл статусов/комментариев «Проблемы со склада»: независим от
// db.json, поэтому статусы и комментарии переживают откат/перезапись db.json при
// деплое (как это было с логами — их отдельные файлы сохраняли историю).
const NOTFOUND_FILE = path.join(DATA_DIR, "notfound-statuses.json");
// Файл-архив логов сканирования (один на день). Логи ДОПОЛНИТЕЛЬНО дописываются
// сюда, чтобы история переживала лимит barcodeLog и очистку вкладки «Логи».
const BCODE_ARCHIVE_DIR = path.join(DATA_DIR, "barcode-archive");
function appendBarcodeLog(entry) {
  try {
    if (!fs.existsSync(BCODE_ARCHIVE_DIR)) fs.mkdirSync(BCODE_ARCHIVE_DIR, { recursive: true });
    const day = dayKey(Date.now());
    const f = path.join(BCODE_ARCHIVE_DIR, day + ".jsonl");
    fs.appendFileSync(f, JSON.stringify(entry) + "\n", "utf8");
  } catch { /* архив не критичен */ }
}
// Источник истины логов сканирования = файлы-архивы /data/barcode-archive/<день>.jsonl
// (в них на каждый скан дописывается строка). Читаем их ВМЕСТЕ с текущим db.barcodeLog,
// чтобы история переживала откат/перезапись db.json после деплоя (иначе «логи слетали»).
function readBarcodeLogs() {
  const map = new Map();
  const put = (e) => {
    if (!e || e.ts == null) return;
    const sig = (e.ts || "") + "|" + (e.userId || "") + "|" + (e.code || "") + "|" + (e.box || "") + "|" + (e.ok === true ? "1" : "0");
    if (!map.has(sig)) map.set(sig, e);
  };
  (Array.isArray(db.barcodeLog) ? db.barcodeLog : []).forEach(put);
  try {
    if (fs.existsSync(BCODE_ARCHIVE_DIR)) {
      for (const fn of (fs.readdirSync(BCODE_ARCHIVE_DIR) || [])) {
        // Файлы ежедневной записи (не массовые дампы очистки).
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fn)) continue;
        try {
          const lines = fs.readFileSync(path.join(BCODE_ARCHIVE_DIR, fn), "utf8").split("\n");
          for (const ln of lines) {
            if (!ln.trim()) continue;
            try { put(JSON.parse(ln)); } catch { /* строка повреждена — пропускаем */ }
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
  return Array.from(map.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

// Опорный часовой пояс приложения — смещение от UTC в минутах.
// Приоритет: переменная окружения APP_TZ_OFFSET_MIN (пояс компании) → Московский
// пояс (180), т.е. UTC+3 — компания работает в одном (московском) поясе.
// Клиент использует это смещение как ЕДИНЫЙ пояс для конвертации
// «ЧЧ:ММ» ↔ timestamp, чтобы время не зависело от пояса каждого устройства.
function serverTzOffset() {
  const env = process.env.APP_TZ_OFFSET_MIN;
  if (env !== undefined && env !== "" && Number.isFinite(Number(env))) return Number(env);
  return 180; // Москва, UTC+3 — пояс компании
}

// Ключ дня (YYYY-MM-DD) для группировки маршрутов в отчёте движения по датам.
function motionDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- Персистентные GPS-треки по дням ----
// В отличие от db.tracks (in-memory, живут ~6 ч и стираются при перезапуске),
// дневные треки сохраняются в /data/tracks.json и переживают перезапуск/передеплой,
// поэтому след водителя можно показать за любой прошедший день.
//   tracksByDay: { "<YYYY-MM-DD>": { "<driverId>": [[lat, lon], ...] } }
const TRACKS_FILE = path.join(DATA_DIR, "tracks.json");
const tracksByDay = {};
let tracksSaveTimer = null;
function loadDayTracks() {
  try {
    const j = JSON.parse(fs.readFileSync(TRACKS_FILE, "utf8")) || {};
    Object.assign(tracksByDay, j);
  } catch { /* нет файла — начинаем с нуля */ }
}
function scheduleTracksSave() {
  if (tracksSaveTimer) return;
  tracksSaveTimer = setTimeout(() => {
    tracksSaveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = TRACKS_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(tracksByDay));
      fs.renameSync(tmp, TRACKS_FILE);
    } catch (e) { console.error("tracks persist error:", e); }
  }, 25000);
}

// ---- Привязка GPS-треков к дорогам (map matching, «как в навигаторе») ----
// OSRM /match реконструирует пройденный путь по дорожной сети (OpenStreetMap),
// вместо прямых «птичьих» отрезков между GPS-точками. Результат кэшируется в
// /data/snapped-tracks.json по ключу "<date>:<driverId>", чтобы обновление карты
// (каждые ~30 с) не дёргало внешний сервис повторно. При сбое/недоступности OSRM
// сохраняются исходные точки — карта не ломается.
const SNAPPED_FILE = path.join(DATA_DIR, "snapped-tracks.json");
const snappedTracks = {};   // { "<date>:<driverId>": [[lat,lon],...] }
let snappedSaveTimer = null;
function loadSnappedTracks() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAPPED_FILE, "utf8")) || {};
    Object.assign(snappedTracks, j);
  } catch { /* нет файла — начинаем с нуля */ }
}
function scheduleSnappedSave() {
  if (snappedSaveTimer) return;
  snappedSaveTimer = setTimeout(() => {
    snappedSaveTimer = null;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = SNAPPED_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(snappedTracks));
      fs.renameSync(tmp, SNAPPED_FILE);
    } catch (e) { console.error("snapped tracks persist error:", e); }
  }, 25000);
}

// Перпендикулярное расстояние для алгоритма Дугласа—Пекера.
function perpDist(p, a, b) {
  const x0 = p[0], y0 = p[1], x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1];
  const dx = x2 - x1, dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x0 - x1, y0 - y1);
  const t = ((x0 - x1) * dx + (y0 - y1) * dy) / (dx * dx + dy * dy);
  const cx = x1 + t * dx, cy = y1 + t * dy;
  return Math.hypot(x0 - cx, y0 - cy);
}

// Упрощение трека (Douglas-Peucker): сокращаем число точек перед отправкой OSRM.
function douglasPeucker(points, eps) {
  if (points.length < 3) return points.slice();
  let maxDist = 0, idx = 0;
  const a = points[0], b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxDist) { maxDist = d; idx = i; }
  }
  if (maxDist > eps) {
    const left = douglasPeucker(points.slice(0, idx + 1), eps);
    const right = douglasPeucker(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// Вызов OSRM /match: points — [[lat,lon],...]; возвращает [[lat,lon],...] или null.
function osrmMatchTrack(pts) {
  return new Promise((resolve) => {
    const coords = pts
      .map((p) => `${Number(p[1]).toFixed(6)},${Number(p[0]).toFixed(6)}`)
      .join(";");
    const radiuses = pts.map(() => "25").join(";");
    const url = `${OSRM_URL}/match/v1/driving/${coords}?radiuses=${radiuses}&overview=full&geometries=geojson&steps=false`;
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const g = j && Array.isArray(j.matchings) &&
            j.matchings[0] && j.matchings[0].geometry;
          if (j && j.code === "Ok" && g && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
            // OSRM отдаёт [[lon,lat],...] → переводим в [[lat,lon],...].
            return resolve(g.coordinates.map((c) => [c[1], c[0]]));
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Привязка трека к дорогам с разбиением на чанки (OSRM лимитирует число точек
// на один запрос). Возвращает Promise<[[lat,lon],...]>; при полном отказе OSRM —
// исходные точки.
// Возвращает { path, snapped }: path — массив [[lat,lon],...], snapped — true
// ТОЛЬКО если реально построена дорожная геометрия (TomTom или OSRM). Если
// дорожные сервисы недоступны (нет ключей/таймаут/403) — snapped:false, path —
// исходные точки. Так потребитель не примет «сырые» GPS-точки за дорожный путь.
const FREEROUTE_API_URL = (String(process.env.FREEROUTE_API_BASE || "https://api.maps.freeroute.org/v1") || "").replace(/\/+$/, "");
const FREEROUTE_API_KEY2 = String(process.env.FREEROUTE_API_KEY || "").trim();

// Дорожный маршрут между двумя точками через FreeRoute (directions/driving-car).
// Возвращает массив [lat, lon] по дорожной сети или null, если не получилось.
async function freeRouteRouteGeometry(a, b) {
  if (!FREEROUTE_API_KEY2 || !FREEROUTE_API_URL) return null;
  try {
    const r = await fetch(`${FREEROUTE_API_URL}/directions/driving-car?api_key=${encodeURIComponent(FREEROUTE_API_KEY2)}&format=geojson`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/geo+json" },
      body: JSON.stringify({ coordinates: [[a[1], a[0]], [b[1], b[0]]] }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const geo = j && j.routes && j.routes[0] && j.routes[0].geometry;
    if (geo && Array.isArray(geo.coordinates) && geo.coordinates.length >= 2) {
      return geo.coordinates.map((c) => [Number(c[1]), Number(c[0])]);
    }
    return null;
  } catch { return null; }
}

async function snapTrackToRoads(raw) {
  const clean = (raw || []).filter((p) =>
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  if (clean.length < 2) return { path: clean.slice(), snapped: false };
  // Эпсилон ~0.0002° (~20 м) — убираем дрожание GPS, сохраняя форму пути.
  let simp = douglasPeucker(clean, 0.0002);
  if (simp.length < 2) simp = [clean[0], clean[clean.length - 1]];

  // 1) Привязка к дорогам через TomTom calculateRoute (публичные OSRM сейчас
  //    отвечают 403, а TomTom route по тарифу работает). Для каждой пары соседних
  //    точек упрощённой ломаной строим дорожный маршрут и склеиваем геометрии.
  //    Если конкретный сегмент не построился — оставляем прямой отрезок, чтобы
  //    след оставался сплошным.
  const segOut = [];
  let anyRoad = false;
  for (let i = 0; i < simp.length - 1; i++) {
    const a = simp[i], b = simp[i + 1];
    const seg = await freeRouteRouteGeometry(a, b);
    if (seg && seg.length >= 2) { segOut.push(seg); anyRoad = true; }
    else segOut.push([a, b]);
  }
  if (anyRoad) {
    const out = [];
    for (const seg of segOut) {
      for (const p of seg) {
        const last = out[out.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) continue; // без дублей на стыках
        out.push(p);
      }
    }
    // Если ни одна точка дорожной геометрии не получена (только прямые) —
    // возвращаем исходный след.
    return { path: out.length >= 2 ? out : clean.slice(), snapped: true };
  }

  // 2) Fallback — OSRM /match (если когда-нибудь заработает).
  const CHUNK = 40;
  const out = [];
  let anyMatch = false;
  for (let i = 0; i < simp.length - 1; i += CHUNK - 1) {
    const chunk = simp.slice(i, i + CHUNK);
    if (chunk.length < 2) continue;
    const snapped = await osrmMatchTrack(chunk);
    if (snapped && snapped.length >= 2) { out.push(...snapped); anyMatch = true; }
    else { out.push(...chunk); }
  }
  return { path: anyMatch ? out : clean.slice(), snapped: anyMatch };
}

// ---- Automatic backup schedule ----
// The app snapshots its whole database into /data/backups/ on its own, so even if
// the server is replaced there is always a recent copy of salaries, timesheet
// statuses, work hours, groups, clients and routes to restore from. Files are kept
// inside /data (which survives redeploys) and pruned to the newest N copies.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_EVERY_MS = 6 * 60 * 60 * 1000; // snapshot roughly every 6 hours
const BACKUP_KEEP = 30;                     // keep the newest 30 snapshots
const BACKUP_INTERVAL_MS = 60 * 1000;       // scheduler tick: once a minute

// ---- Portal access (.env for local run, env on the deployed server) ----
// Reads .env upwards from this file so a local start from any folder finds the key.
// On the deployed server there is no .env — the three variables arrive via the process
// environment, so this is a no-op there. Values already in process.env always win.
function loadEnvUpwards(startDir, maxLevels = 4) {
  let dir = path.resolve(startDir);
  for (let level = 0; level <= maxLevels; level += 1) {
    const file = path.join(dir, ".env");
    if (fs.existsSync(file)) {
      try {
        for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
          if (!m || m[1] in process.env) continue;
          process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
      } catch { /* unreadable — treat as absent */ }
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const KEY_FROM_ENVIRONMENT =
  typeof process.env.BITRIX_API_KEY === "string" && process.env.BITRIX_API_KEY !== "";
const ENV_FILE = loadEnvUpwards(__dirname);
const PORTAL_BASE = process.env.BITRIX_API_BASE_URL || "";
const PORTAL_KEY = process.env.BITRIX_API_KEY || "";
// Портальный прокси отвечает десятками секунд на живом портале (нормальная нагрузка,
// а не сбой). Таймаут поэтому — минуты, а не секунды: обрыв на 30/60/90 с выбросил бы
// ответ, который уже был в пути. Зависший портал при этом не должен вешать запрос
// посетителя бесконечно, поэтому у fetch есть верхний предел ожидания.
const PORTAL_TIMEOUT_MS = Number(process.env.PORTAL_TIMEOUT_MS || 180_000);

// One honest line at startup: whether the portal key is present and where it came from.
console.log(
  PORTAL_KEY
    ? `portal key loaded from ${KEY_FROM_ENVIRONMENT ? "the environment" : ENV_FILE}`
    : `NO portal key${ENV_FILE ? ` (${ENV_FILE} has no BITRIX_API_KEY)` : " (no .env found and none in env)"}` +
      " — staff directory sync is disabled until it appears"
);

// Portal REST call. Only the server talks to the portal; the browser never sees the key.
async function portal(pathname, { method = "GET", body } = {}) {
  if (!PORTAL_KEY || !PORTAL_BASE) {
    const err = new Error("portal_not_connected");
    err.status = 503;
    throw err;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PORTAL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${PORTAL_BASE}${pathname}`, {
      method,
      headers: {
        "X-Api-Key": PORTAL_KEY,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: ctl.signal,
    });
  } catch (e) {
    // Обрыв по таймауту или сети — это НЕ про ключ: портал просто не успел ответить.
    clearTimeout(timer);
    const err = new Error(e && e.name === "AbortError" ? "portal_timeout" : "portal_unreachable");
    err.status = e && e.name === "AbortError" ? 504 : 502;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  // Ответ портального прокси — всегда JSON. Но если адрес прокси настроен
  // неверно (например, на поддомен приложения, а не на основной домен
  // платформы /v1), Black Hole шлюз может вернуть 401 с ТЕКСТОВЫМ телом
  // ("Authentication required. This is a Black Hole app subdomain…") вместо JSON.
  // Неподтверждённый parse не должен вываливаться сырым исключением — превращаем
  // его в корректную ошибку, а не отдаём клиенту «кашу» шлюза.
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.error && data.error.message) ||
      (res.status === 401 || res.status === 403 ? "portal_auth_failed" : `portal_error_${res.status}`)
    );
    err.status = res.status;
    if (res.status === 401 || res.status === 403) err.code = "portal_auth_failed";
    throw err;
  }
  return data && data.data !== undefined ? data.data : data;
}

// Нормализация списков id для параметров доступа (убирает дубли и несуществующие
// сущности). Единое место для групп и сотрудников в POST /api/params.
function keepExistingIds(arr, sourceIds) {
  return [...new Set((arr || []).map(String).filter((id) => sourceIds.some((x) => String(x) === String(id))))];
}
function keepGroupParamIds(arr, dbData) {
  return keepExistingIds(arr, (dbData.groups || []).map((g) => g.id));
}
function keepStaffParamIds(arr, dbData) {
  return keepExistingIds(arr, (dbData.staff || []).map((s) => s.id));
}
// Разрешён ли водителю «Завершить выгрузку» при неполном скане (админ-параметр).
function allowIncompleteFinish(dbData) {
  return !!(dbData && dbData.params && dbData.params.allowFinishUnloadIncomplete === true);
}

function defaultDb() {
  return {
    staff: [],          // [{ id, name, salary|null }]
    admins: [],         // [id, ...] — дозаголовочные админы
    blocked: [],        // [{ id, name, at }] — вход в приложение закрыт
    groups: [],         // [{ id, name, memberIds: [], moderatorId: null }]
    days: {},           // { "<YYYY-MM-DD>": { ownerId, segments: [...] } }
    log: [],            // [{ ts, action, ownerId }]
    driverClients: [],  // [{ id, client, address, addedBy, at }] — клиенты для водителей
    driverRoutes: [],   // [{ id, date, driverId, driverName, clients: [{client,address}], addedBy, at }]
    salaryMonth: {},    // { "<staffId>": { "<YYYY-MM>": { salary?, bonus?, extraBonus? } } } — оклады/надбавки по месяцам
    frozenMonth: null,  // последний месяц, по которому уже заморожен предыдущий (см. maybeFreezePrevMonth)
    labels: [],         // [{ id, code, routeId, clientIdx, client, address, place, status, at }] — этикетки отгрузки
    scanLog: [],        // [{ ts, userId, userName, action: "load"|"unload", code, client, routeId, status, warning }] — журнал сканирования мест
    barcodeLog: [],     // [{ ts, userId, userName, ok, code, kind, routeId, clientIndex, reason }] — логи скана деталей при сборке
    lastSeen: {},       // { "<userId>": ts } — in-memory online presence (not persisted)
    liveLocations: {},  // { "<userId>": { lat, lon, at, routeId } } — in-memory live coords
    tracks: {},         // { "<userId>": [{ lat, lon, at }, ...] } — in-memory live path history
    params: {
      showOverHours: true,
      showOverSum: true,
      showDrivers: false,
      adminSeeRoutes: false,
      driverSeeRoutes: false,
      // Groups (ids) for which "show overtime hours / money" applies. Empty = for everyone.
      showOverHoursGroups: [],
      showOverSumGroups: [],
      // Group ids that can see the "Отгрузка" section. Empty = no one sees it.
      shipmentGroups: [],
      // When false, a driver cannot start a route until the warehouse has finished
      // the shipment (route.progress.shippedAt). Admin turns this on in Параметры
      // to let the driver ignore the warehouse and start the route directly.
      allowDriverStartWithoutShipment: false,
      // Когда true, водитель может завершить выгрузку мест клиента, даже если
      // отсканированы не все этикетки (иначе «Завершить выгрузку» блокируется,
      // пока остаются невыгруженные места). Админ включает в «Параметры».
      // Разрешить водителю «Завершить выгрузку» и «Завершить сдачу», даже если
      // отсканированы не все места клиента (включено по умолчанию — часть мест
      // может физически не доехать/потеряться, и водитель должен закрыть точку).
      allowFinishUnloadIncomplete: true,
      // Когда true, водитель может менять порядок НЕ пройденных (pending) точек
      // сдачи внутри активного маршрута. Уже сданные / перенесённые точки и
      // текущая точка водителя (in_transit / on_site) не перемещаются.
      allowDriverReorderPoints: false,
      // Код удаления ЗАВЕРШЁННОГО маршрута. Задаётся админом в «Параметры».
      // Пусто = завершённый маршрут удалить нельзя даже админу (защита истории
      // доставки). При заданном коде админ может удалить завершённый маршрут,
      // введя требуемый код. Маршруты В РАБОТЕ (статус active) не удаляются никогда.
      routeDeleteCode: "",
      // Сколько записей журнала сканирования мест хранить (настраивается админом
      // в «Параметры»). Последние scanLogLimit записей; более старые отбрасываются.
      scanLogLimit: 30000,
      multiplier: 1,
      multFrom: null,
      multTo: null,
      multGroups: [],
      // Индивидуальные правила повышенного множителя подработки (новая вкладка
      // «Множитель»). Каждое: { id, target: "all"|"staff"|"group", targetId, mult,
      // days: [пн..вс, 0-based] }. Приоритет при поиске: конкретный сотрудник →
      // группа → «для всех». Старые поля multiplier/multFrom/multTo/multGroups —
      // легаси-fallback, пока multRules пуст (обратная совместимость).
      multRules: [],
      // Разрешить складу загружать расходную накладную по маршруту/клиенту и
      // собирать товар по скану штрихкода артикула (раздел «Отгрузка»).
      allowWaybill: false,
      notfoundUsers: [], // кто (кроме админа) видит «Отчёт не найдено»
      logUsers: [], // кто (кроме админа/модератора) видит вкладку «Логи»
      reportsUsers: [], // кто (кроме админа/модератора) видит вкладку «Отчёты» (АБЦП)
      reportsSections: {}, // доступ к внутренним разделам «Отчётов»: { раздел: [userId, ...] }
      sverkiUsers: [], // кто (кроме админа) видит вкладку «Сверки»
      procenkaUsers: [], // кто (кроме админа) видит вкладку «Проценка»
      parserUsers: [], // кто (кроме админа) видит вкладку «Парсер почты»
      // Версия обновления Android-APK, управляемая из «Параметры» приложения.
      // Пусто = берутся значения из окружения APP_UPDATE_* (или жёсткие дефолты ниже).
      updateVersionCode: null,
      updateVersionName: "",
      updateApkUrl: "",
      updateNotes: "",
    },
    norm: 9,
  };
}

let db = null;
let writeQueue = Promise.resolve();

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const base = defaultDb();
    const dbOut = {
      staff: Array.isArray(parsed.staff) ? parsed.staff : base.staff,
      admins: Array.isArray(parsed.admins) ? parsed.admins : base.admins,
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : base.blocked,
      groups: Array.isArray(parsed.groups) ? parsed.groups : base.groups,
      days: parsed.days && typeof parsed.days === "object" ? parsed.days : base.days,
      log: Array.isArray(parsed.log) ? parsed.log : base.log,
      driverClients: Array.isArray(parsed.driverClients) ? parsed.driverClients : base.driverClients,
      driverRoutes: Array.isArray(parsed.driverRoutes) ? parsed.driverRoutes : base.driverRoutes,
      labels: Array.isArray(parsed.labels) ? parsed.labels : base.labels,
      scanLog: Array.isArray(parsed.scanLog) ? parsed.scanLog : base.scanLog,
      // lastSeen is intentionally in-memory only: online presence resets on restart.
      lastSeen: {},
      liveLocations: {},
      tracks: {},
      params: parsed.params && typeof parsed.params === "object" ? { ...base.params, ...parsed.params } : base.params,
      norm: Number.isFinite(parsed.norm) ? parsed.norm : base.norm,
    };
    migrateDays(dbOut);
    // The real working day is 9 hours. If a stored value was left at the earlier
    // (incorrect) 8h default, move it forward to the correct 9h norm.
    if (dbOut.norm === 8) dbOut.norm = 9;
    // Reconcile groups against the freshly loaded staff (staff is now set on dbOut).
    dbOut.groups = dbOut.groups.map((g) => normalizeGroup(g, dbOut.staff));
    // Normalise driver clients: every client carries an explicit (possibly null)
    // bundleId, logo (data-URL изображения) and logoText (бренд-аббревиатура
    // для текстового логотипа на этикетке, например «AVI»).
    dbOut.driverClients = dbOut.driverClients.map((c) => ({
      ...c,
      bundleId: c.bundleId || null,
      logo: c.logo || null,
      logoText: c.logoText || "",
      bundleName: c.bundleName || "",
      inn: String(c.inn || "").trim(),
      login: String(c.login || "").trim(),
    }));
    return dbOut;
  } catch {
    return defaultDb();
  }
}

// Normalise a group record so it always has the expected shape, dropping any
// members that no longer exist in `staff` and any stale moderator reference.
function normalizeGroup(g, staffArray) {
  const out = {
    id: String((g && g.id) || ""),
    name: String((g && g.name) || "").trim(),
    memberIds: Array.isArray(g && g.memberIds) ? g.memberIds.map(String) : [],
    moderatorId: (g && g.moderatorId != null) ? String(g.moderatorId) : null,
  };
  // De-duplicate members, keep only those present in staff.
  out.memberIds = [...new Set(out.memberIds.filter((id) => staffArray.some((s) => s.id === id)))];
  if (out.moderatorId && !staffArray.some((s) => s.id === out.moderatorId)) out.moderatorId = null;
  return out;
}

// Модель статусов табеля: раньше на день хранился ОДИН статус одного
// сотрудника ({ ownerId, status }), из-за чего статус нового сотрудника
// затирал предыдущего. Теперь на день хранится карта statuses[ownerId].
// Эта функция переводит старые записи в новый формат.
//
// То же самое касается сегментов времени: раньше на день был ОДИН список
// segments одного владельца, и сохранение времени второго сотрудника за тот
// же день стирало данные первого. Теперь на день хранится карта
// byEmployee[staffId].segments, и каждый сотрудник пишет/читает своё.
function migrateDays(dbOut) {
  for (const key in dbOut.days) {
    const rec = dbOut.days[key];
    if (!rec || typeof rec !== "object") continue;
    // 1) statuses -> карта (как раньше).
    if (!(rec.statuses && typeof rec.statuses === "object") && rec.status) {
      const ownerId = rec.ownerId;
      rec.statuses = {};
      if (ownerId && dbOut.staff.some((s) => s.id === ownerId)) {
        rec.statuses[ownerId] = rec.status;
      }
      delete rec.status;
    }
    // 2) segments -> byEmployee (если ещё не в новом формате).
    if (!(rec.byEmployee && typeof rec.byEmployee === "object")) {
      rec.byEmployee = {};
      for (const sid of Object.keys(rec)) {
        if (sid === "segments" && Array.isArray(rec[sid])) {
          if (rec.ownerId) rec.byEmployee[rec.ownerId] = { segments: rec[sid] };
        }
      }
    }
    // Новый формат не хранит segments / ownerId на верхнем уровне — только
    // карта byEmployee + карта statuses.
    delete rec.segments;
    delete rec.ownerId;
  }
}

// Сегменты работы конкретного сотрудника в дне rec (новый формат byEmployee
// либо старый, ещё не мигрированный, вид { ownerId, segments }).
function segmentsFor(staffId, rec) {
  if (!rec || typeof rec !== "object") return [];
  const byEmp = rec.byEmployee;
  if (byEmp && typeof byEmp === "object") {
    const e = byEmp[staffId];
    return (e && Array.isArray(e.segments)) ? e.segments : [];
  }
  // Старый формат / промежуточный.
  if (rec.ownerId && rec.ownerId !== staffId) return [];
  return Array.isArray(rec.segments) ? rec.segments : [];
}

// ---- SSE-шина (мгновенная синхронизация между устройствами) ----
// /api/events — Server-Sent Events: сервер держит соединения и пушит уведомление
// после каждого persistDb. Клиенты (ТСД/ПК/телефон) по событию сразу перечитывают
// актуальное состояние, не дожидаясь опроса.
const sseClients = new Set();
function sseWrite(res, str) {
  try { res.write(str); } catch { sseClients.delete(res); }
}
function notifyDbChanged() {
  const msg = `data: ${JSON.stringify({ type: "changed" })}\n\n`;
  for (const res of sseClients) sseWrite(res, msg);
}

function persistDb() {
  // Atomic write: tmp + rename. Serialised through the queue so parallel writes don't corrupt.
  writeQueue = writeQueue.then(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error("persist error:", e);
    }
  });
  // Мгновенная синхронизация между устройствами (ТСД/ПК/телефон): после каждого
  // реального сохранения уведомляем всех активных SSE-клиентов «данные изменились».
  // Клиент по событию сразу перечитывает актуальное состояние (скан, завершение
  // маршрута и т.п.) — не дожидаясь следующего такта опроса.
  notifyDbChanged();
  return writeQueue;
}

// Однократная нормализация данных при старте: позиция, у которой задан бокс,
// не может одновременно нести пометку «не найдено» (размещение в бокс = найдена).
// Чинит фантомные «проблемы склада», появившиеся до фикса в routes/waybill.js.
let staleMissingNormalized = false;
function normalizeStaleMissing(d) {
  let changed = false;
  for (const r of (Array.isArray(d.driverRoutes) ? d.driverRoutes : [])) {
    const wb = r && r.waybills;
    if (!wb || typeof wb !== "object") continue;
    for (const k of Object.keys(wb)) {
      const items = wb[k] && Array.isArray(wb[k].items) ? wb[k].items : [];
      for (const it of items) {
        if (it && String(it.box || "") && ((it.missing) || (Number(it.missingQty) || 0) > 0)) {
          it.missing = false;
          it.missingQty = 0;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function ensureLoaded() {
  if (!db) db = loadDb();
  if (!staleMissingNormalized) {
    staleMissingNormalized = true;
    if (normalizeStaleMissing(db)) { void persistDb().catch(() => {}); }
  }
  // Подмешиваем durable-файл статусов «Проблемы со склада» (переживает откат db.json).
  try {
    if (fs.existsSync(NOTFOUND_FILE)) {
      const saved = JSON.parse(fs.readFileSync(NOTFOUND_FILE, "utf8"));
      if (saved && typeof saved === "object") {
        if (!db.notFound || typeof db.notFound !== "object") db.notFound = {};
        for (const k of Object.keys(saved)) {
          const cur = db.notFound[k] || {};
          db.notFound[k] = Object.assign({}, cur, saved[k]);
        }
      }
    }
  } catch { /* ignore */ }
}
// Атомарная запись статусов в отдельный файл (tmp + rename).
function persistNotFoundStatuses() {
  return writeQueue.then(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = NOTFOUND_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(db.notFound || {}));
      fs.renameSync(tmp, NOTFOUND_FILE);
    } catch { /* ignore */ }
  });
}

// Write an automatic snapshot of the whole db into /data/backups/ (atomic: tmp +
// rename). `when` is a label for the filename; `envelope` stores it in the same
// "biotime backup" envelope the manual restore accepts. Prunes to BACKUP_KEEP.
function writeAutoBackup(envelope) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const name = `biotime-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
    const payload = envelope
      ? JSON.stringify({
          app: "biotime",
          version: 1,
          exportedAt: new Date().toISOString(),
          data: db,
          extra: collectExtraBackup ? collectExtraBackup() : {},
        }, null, 2)
      : JSON.stringify(db);
    const tmp = path.join(BACKUP_DIR, ".tmp-" + name);
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, path.join(BACKUP_DIR, name));
    // Prune old files beyond the keep limit (sorted by name ascending; drop oldest).
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^biotime-backup-.*\.json$/.test(f)).sort();
    while (files.length > BACKUP_KEEP) {
      const rm = files.shift();
      try { fs.unlinkSync(path.join(BACKUP_DIR, rm)); } catch { /* ignore */ }
    }
    return name;
  } catch (e) {
    console.error("auto backup failed:", e);
    return null;
  }
}

// List automatic backups: name + size + mtime, newest first.
function listAutoBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^biotime-backup-.*\.json$/.test(f))
      .map((name) => {
        const full = path.join(BACKUP_DIR, name);
        let st = null;
        try { st = fs.statSync(full); } catch { /* ignore */ }
        return { name, size: st ? st.size : 0, mtime: st ? st.mtime.toISOString() : null };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  } catch {
    return [];
  }
}

// Make a fresh auto-backup if the new enough one does not exist yet (used when the
// server starts and on the periodic tick). Skips empty databases so a fresh install
// does not spam useless files. Returns the file name or null.
function maybeAutoBackup(now) {
  const list = listAutoBackups();
  if (list.length > 0) {
    const newestMtime = new Date(list[0].mtime).getTime();
    if (now - newestMtime < BACKUP_EVERY_MS) return list[0].name;
  }
  // Don't snapshot an empty/new database — nothing worth keeping yet.
  if (!db || db.staff.length === 0) return null;
  return writeAutoBackup(true);
}

// Собирает ДОПОЛНИТЕЛЬНЫЕ durable-данные приложения, которые лежат в /data
// отдельными файлами и НЕ входят в объект db (а значит раньше не попадали в
// бэкап и терялись при восстановлении): GPS-треки, карта-привязанные треки,
// «Проблемы со склада», журнал заборов 1С и архив сканов. Возвращает объект,
// который кладётся в бэкап рядом с data, а при restore записывается обратно.
function collectExtraBackup() {
  const extra = {};
  if (Object.keys(tracksByDay || {}).length) extra.tracksByDay = tracksByDay;
  if (Object.keys(snappedTracks || {}).length) extra.snappedTracks = snappedTracks;
  if (db && db.notFound && typeof db.notFound === "object" && Object.keys(db.notFound).length) {
    extra.notFound = db.notFound;
  }
  if (Array.isArray(onecPullLog) && onecPullLog.length) extra.onecPullLog = onecPullLog;
  // Архив сканов (<день>.jsonl в /data/barcode-archive) читаем построчно в
  // { "<дата>": [entries] } — это полная история сканов, независимая от db.barcodeLog.
  try {
    if (fs.existsSync(BCODE_ARCHIVE_DIR)) {
      const arc = {};
      for (const fn of (fs.readdirSync(BCODE_ARCHIVE_DIR) || [])) {
        if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(fn)) continue;
        const day = fn.slice(0, 10);
        const lines = fs.readFileSync(path.join(BCODE_ARCHIVE_DIR, fn), "utf8").split("\n");
        const rows = [];
        for (const ln of lines) {
          if (!ln.trim()) continue;
          try { rows.push(JSON.parse(ln)); } catch { /* повреждённая строка */ }
        }
        if (rows.length) arc[day] = rows;
      }
      if (Object.keys(arc).length) extra.barcodeArchive = arc;
    }
  } catch { /* архив не критичен */ }
  return extra;
}

// Восстанавливает дополнителные данные из бэкапа: пишет их в /data и обновляет
// in-memory-копии, чтобы они сразу были видны (без перезапуска). Каждый файл
// пишется атомарно (tmp + rename); сбой одного не роняет восстановление БД.
function applyExtraBackup(extra) {
  if (!extra || typeof extra !== "object") return;
  const write = (file, obj, target) => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, file);
      if (target && typeof target === "object") {
        Object.keys(target).forEach((k) => delete target[k]);
        Object.assign(target, obj);
      }
    } catch (e) { console.error("extra restore (" + file + ") failed:", e); }
  };
  if (extra.tracksByDay && typeof extra.tracksByDay === "object") {
    write(TRACKS_FILE, extra.tracksByDay, tracksByDay);
  }
  if (extra.snappedTracks && typeof extra.snappedTracks === "object") {
    write(SNAPPED_FILE, extra.snappedTracks, snappedTracks);
  }
  if (extra.notFound && typeof extra.notFound === "object") {
    if (db) db.notFound = extra.notFound;
    write(NOTFOUND_FILE, extra.notFound);
  }
  if (Array.isArray(extra.onecPullLog) && extra.onecPullLog.length) {
    onecPullLog.length = 0;
    onecPullLog.push(...extra.onecPullLog);
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = ONEC_PULL_LOG_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(onecPullLog));
      fs.renameSync(tmp, ONEC_PULL_LOG_FILE);
    } catch { /* ignore */ }
  }
  if (extra.barcodeArchive && typeof extra.barcodeArchive === "object") {
    try {
      if (!fs.existsSync(BCODE_ARCHIVE_DIR)) fs.mkdirSync(BCODE_ARCHIVE_DIR, { recursive: true });
      for (const day of Object.keys(extra.barcodeArchive)) {
        const rows = extra.barcodeArchive[day];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(rows)) continue;
        const f = path.join(BCODE_ARCHIVE_DIR, day + ".jsonl");
        const tmp = f + ".tmp";
        const content = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
        fs.writeFileSync(tmp, content, "utf8");
        fs.renameSync(tmp, f);
      }
    } catch { /* ignore */ }
  }
}

// Timestamp of the last millisecond (23:59:59.999) of the COMPANY day containing
// `ts` — the instant an employee's running timer belongs to. Считаем в поясе
// КОМПАНИИ (serverTzOffset(), по умолчанию UTC+3), а не в системном поясе
// сервера (часто UTC): иначе автозакрытие незакрытого таймера ставит конец в
// 23:59 UTC, что в МСК показывается как 02:59 СЛЕДУЮЩЕГО дня — «завершил
// 18:19, а записалось 02:59».
function endOfDayMs(ts) {
  const off = serverTzOffset(); // +180 — UTC+3 Москва
  // Приводим ts к «компанийному» календарному дню: смещаем на off и берём дату по UTC.
  const shifted = new Date(ts + off * 60000);
  // Конец текущего компанийного дня = начало СЛЕДУЮЩЕГО компанийного дня минус 1 мс:
  // следующий день начинается в 00:00 по компанийному = в (00:00 − off) по UTC.
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - off * 60000 - 1;
}

// Auto-close any open work timer (`end == null`) whose day has already ended, so
// an employee who forgets to press "Завершить работу" does not leave it running
// forever. The timer is finished exactly at 23:59:59.999 of its own day. Runs from
// a periodic scheduler and at the start of every API request (see handleApi).
// Returns true if anything was changed (caller persists).
function autoCloseDayEndTimers(now) {
  let changed = false;
  for (const key in db.days) {
    const rec = db.days[key];
    if (!rec || !(rec.byEmployee && typeof rec.byEmployee === "object")) continue;
    for (const id in rec.byEmployee) {
      const entry = rec.byEmployee[id];
      if (!entry || !Array.isArray(entry.segments)) continue;
      let entryChanged = false;
      for (const s of entry.segments) {
        // Защита от битых/мусорных записей в сегментах дня: элемент может быть
        // null или не-объектом, и s.kind на нём раньше ронял ВЕСЬ запрос (500).
        if (s && typeof s === "object" && s.kind === "work" && s.end == null && now > endOfDayMs(s.start)) {
          s.end = endOfDayMs(s.start);
          entryChanged = true;
          changed = true;
        }
      }
      // ВАЖНО: НЕ помечаем день finished:true при авто-обрыве «зависшего» таймера.
      // Раньше это автоматически «закрывало» рабочий день сотрудника (и он начинал
      // «сам закрываться»), из-за чего день блокировался и мешал работе/сканированию
      // (см. жалобу про Сорокина). Здесь только обрываем просроченный сегмент (end),
      // а день остаётся открытым — сотрудник/админ управляет завершением вручную.
    }
  }
  return changed;
}

// ---- Gateway identity (load-bearing) ----
// The platform gate authenticates every request and injects identity headers.
// Client-supplied X-Vibe-* are stripped by the gate, so these are trustworthy.
function identity(headers) {
  let userId = String(headers["x-vibe-user-id"] || "").trim();
  let name = headers["x-vibe-user-name-encoded"]
    ? safeDecode(headers["x-vibe-user-name-encoded"])
    : (headers["x-vibe-user-name"] || "");
  let role = String(headers["x-vibe-user-role"] || "").trim().toUpperCase();

  // Local run (no gate) — default to the local admin so dev/staging keeps working.
  if (!userId) {
    userId = "local";
    name = name || "Локальный пользователь";
    role = role || "ADMIN";
  }
  if (role !== "ADMIN" && role !== "MEMBER") role = "MEMBER";

  return { id: userId, name: name || "Пользователь", role };
}

function safeDecode(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

// An app-level admin: gateway role ADMIN is the reliable check.
// Also allow explicitly appointed admins (kept in db.admins) and portal admins
// (isAdmin:true in the Bitrix24 directory). The portal-admin match is resolved by
// exact id and, as a fallback for WebView sessions that carry a non-portal id but
// a real name, by normalized name. This keeps admin access working no matter how
// the gateway identifies the user (e.g. an APK WebView that sends net_/vibe: ids).
// Significant name tokens for lenient admin-by-name matching. Drops one-letter
// words and common filler, so "Иван Петров" and "Петров Иван Иванович" still
// compare equal regardless of word order or extra middle names.
const NAME_STOP = new Set(["и", "в", "о", "на", "по", "с", "у", "к", "ср", "гр"]);
function nameTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-zа-яё\s]/gi, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !NAME_STOP.has(w));
}

// Tolerant name match: two names are considered equal when they share at least
// two significant tokens (typically "фамилия" + "имя") regardless of order.
// This bridges the gap where the gateway (a mobile APK WebView) reports the
// user's name in a different shape than the portal directory stores it.
function namesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  let hits = 0;
  for (const t of ta) if (tb.includes(t)) hits += 1;
  return hits >= 2;
}

function isPortalAdmin(user, dbData) {
  const staff = Array.isArray(dbData.staff) ? dbData.staff : [];
  if (user && user.id != null && staff.some((s) => s.id === String(user.id) && s.portalAdmin === true)) return true;
  // Lenient fallback by name for WebView/mobile sessions that carry a
  // non-portal id (net_/share:/vibe:). Order and extra middle names don't matter.
  if (user && user.name && staff.some((s) => s.portalAdmin === true && namesMatch(user.name, s.name))) return true;
  return false;
}

// Human-readable account diagnostics so an admin who sees no admin panel on a
// mobile APK can verify how the gateway identified them and why the server did
// or did not grant the admin role.
function adminDiag(user, dbData) {
  const idKind =
    /^net_/i.test(user.id) ? "net (внешний доступ)" :
    /^share:/i.test(user.id) ? "share (внешний)" :
    /^vibe:/i.test(user.id) ? "vibe (внешний)" :
    /^\d+$/.test(user.id) ? "portal-id (числовой)" : "other";
  const admin = isAdmin(user, dbData);
  let reason = null;
  if (!admin) {
    if (user.role === "ADMIN") reason = "Роль ADMIN, но id/имя не совпали с администратором в справочнике.";
    else if ((dbData.admins || []).includes(user.id)) reason = "id есть в списке админов приложения, но роль не ADMIN.";
    else reason = `Роль ${user.role}, id «${user.id}» (${idKind}) и имя не совпали с администратором портала.`;
  }
  return { idKind, id: user.id, fullName: user.name, role: user.role, isAdmin: admin, reason };
}

function isAdmin(user, dbData) {
  return user.role === "ADMIN" ||
    (dbData.admins || []).includes(user.id) ||
    isPortalAdmin(user, dbData);
}

// ================= Password auth (свой логин/пароль, поверх/вместо Вайбкод) =================
// Хэш пароля — scrypt (node:crypto), соль уникальна на пользователя, сравнение
// через timingSafeEqual. Пароль НИКОГДА не хранится и не логируется в открытом виде.
const SCRYPT = { N: 16384, r: 8, p: 1 };
function hashPassword(pass) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pass), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(pass, salt, hash) {
  if (!salt || !hash) return false;
  try {
    const calc = crypto.scryptSync(String(pass), salt, 64);
    const expect = Buffer.from(hash, "hex");
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch { return false; }
}

// Сессии: токен = randomBytes(32), живёт 30 дней, хранится в /data (персистентно).
const AUTH_COOKIE = "btime_auth";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SESSIONS = new Map(); // token -> { staffId, exp }
function sessionFile() { return path.join(DATA_DIR, "auth-sessions.json"); }
function sessionToken() { return crypto.randomBytes(32).toString("hex"); }
function loadSessionsFromDisk() {
  try {
    const j = JSON.parse(fs.readFileSync(sessionFile(), "utf8") || "{}");
    const now = Date.now();
    for (const k of Object.keys(j)) { if (j[k] && j[k].exp > now) SESSIONS.set(k, j[k]); }
  } catch { /* нет файла — нет сессий */ }
}
function saveSessionsToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = sessionFile() + ".tmp";
    const o = {};
    SESSIONS.forEach((v, k) => { o[k] = v; });
    fs.writeFileSync(tmp, JSON.stringify(o));
    fs.renameSync(tmp, sessionFile());
  } catch { /* не критично */ }
}
function createSession(staffId) {
  const token = sessionToken();
  SESSIONS.set(token, { staffId: String(staffId), exp: Date.now() + SESSION_TTL_MS });
  saveSessionsToDisk();
  return token;
}
function staffByLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return null;
  return (db.staff || []).find((s) => String(s.login || "").trim().toLowerCase() === l) || null;
}
function staffByFio(q) {
  const stop = new Set(["и", "в", "о", "на", "по", "с", "у", "к", "ср", "гр"]);
  const toks = (s) => String(s || "").toLowerCase().replace(/[^a-zа-яё\s]/gi, " ").split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 2 && !stop.has(w));
  const qt = toks(q);
  if (!qt.length) return [];
  const hits = [];
  for (const s of (db.staff || [])) {
    const st = toks(s.name);
    if (!st.length) continue;
    const hit = st.filter((t) => qt.includes(t)).length;
    if (hit >= 1) hits.push({ id: String(s.id), name: s.name, hit });
  }
  hits.sort((a, b) => b.hit - a.hit);
  return hits.slice(0, 10).map((h) => ({ id: h.id, name: h.name, hasCreds: !!(staffById(h.id) && staffById(h.id).login) }));
}
function staffById(id) { return (db.staff || []).find((s) => String(s.id) === String(id)) || null; }
// Главный администратор (владелец): его пароль/учётку может менять только он сам.
// Источники: explicit db.owner; иначе сотрудник с фамилией Ахмедов; иначе первый.
function rootAdminId(dbData) {
  if (dbData && dbData.owner != null) return String(dbData.owner);
  const ah = (dbData && dbData.staff || []).find((s) => /ахмед/i.test(String(s.name || "")));
  if (ah) return String(ah.id);
  return "1";
}
function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return "";
  for (const part of String(cookieHeader).split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}
function sessionUserFromCookie(cookieHeader) {
  const token = cookieValue(cookieHeader, AUTH_COOKIE);
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) { SESSIONS.delete(token); saveSessionsToDisk(); return null; }
  const st = staffById(s.staffId);
  if (!st) return null;
  const role = (st.admin === true || st.portalAdmin === true || (db.admins || []).includes(String(st.id))) ? "ADMIN" : "MEMBER";
  return { id: st.id, name: st.name || "Пользователь", role, staffId: String(st.id) };
}
// Простая защита от перебора: до 8 неудач подряд за минуту на связку IP+логин.
const loginRate = {};
let sessionsLoaded = false;
function setAuthCookie(res, token, req) {
  const secure = /^https$/i.test(String((req && req.headers && req.headers["x-forwarded-proto"]) || ""))
    ? "; Secure"
    : "";
  // Вайбкод показывает приложение внутри своего iframe (vibecodeconnector_open_app_frame).
  // Для cross-site iframe cookies SameSite=Lax НЕ передаются -> сессия «не держится».
  // За https используем SameSite=None; Secure, чтобы кука работала и во встроенной версии.
  const samesite = secure ? "None" : "Lax";
  res.setHeader("Set-Cookie",
    `${AUTH_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=${samesite}${secure}`);
}
function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=None; Secure`);
}

// ---- Auth for /api/*, returns { ok, user, body } ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      // Лимит 20 МБ: обычные запросы — килобайты, но резервная копия (бэкап) может
      // весить несколько мегабайт; при старом лимите 2 МБ восстановление из бэкапа
      // молча рвалось ещё на чтении тела («ничего не происходит»).
      if (raw.length > 20_000_000) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    // Referrer нужен Яндекс.Картам: ключ ограничен по HTTP Referer, и без origin
    // приложения Яндex не активирует карту («ключ не разрешает этот домен»).
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  res.end(body);
}

// ---- Groups & moderator role ----
// A user is a "moderator" when they are set as the moderator of at least one
// group. A moderator can see and moderate only the members of their group(s);
// they are NOT an admin, so the admin panel (including the "Оклады" section) is
// invisible to them.
function groupsOfModerator(user, dbData) {
  return (dbData.groups || []).filter((g) => g.moderatorId === user.id);
}

function isModerator(user, dbData) {
  return groupsOfModerator(user, dbData).length > 0;
}

// Member ids visible to a user through group membership moderation.
function moderatorVisibleIds(user, dbData) {
  const ids = new Set();
  for (const g of groupsOfModerator(user, dbData)) new Set(g.memberIds).forEach((id) => ids.add(id));
  return ids;
}

// A "driver" is any user who is a member of the group named «Водители».
function isDriver(user, dbData) {
  return (dbData.groups || []).some(
    (g) => /водител/i.test(String(g.name || "")) && (g.memberIds || []).includes(user.id)
  );
}

// «Погрузка» — сотрудник группы склада, чьё имя содержит «погрузк» (например
// группа «Погрузка»). Такой пользователь — чистый погрузочный терминал: он
// видит ТОЛЬКО вкладку «Отгрузка» и не отображается другим в Табеле, расчёте
// ЗП и «В эфире». Выделение по имени группы (как «Водители» для isDriver).
function isLoader(user, dbData) {
  return (dbData.groups || []).some(
    (g) => /погрузк/i.test(String(g.name || "")) && (g.memberIds || []).includes(user.id)
  );
}

// Проверка «погрузчик» по id сотрудника (для фильтрации списков видимости:
// Табель, расчёт ЗП, «В эфире», Журнал — погрузчик там не показывается).
function isLoaderById(staffId, dbData) {
  const uid = String(staffId);
  return (dbData.groups || []).some(
    (g) => /погрузк/i.test(String(g.name || "")) && (g.memberIds || []).includes(uid)
  );
}

// Узкое определение «водителя» ТОЛЬКО для карты «Трекинг»: учитываем лишь
// участников группы, чьё имя ТОЧНО «Водители»/«Водитель». Глобальная isDriver
// ловит все группы со словом «водител» (резервные/сменные и т.п.), но на карту
// пользователь хочет выводить только основную группу «Водители».
function isDriversGroupOnly(user, dbData) {
  const allowed = new Set(["водители", "водитель"]);
  return (dbData.groups || []).some((g) => {
    const n = String(g.name || "").trim().toLowerCase();
    return allowed.has(n) && (g.memberIds || []).includes(user.id);
  });
}

// Возвращает клон маршрута с гарантированно нормализованными полями прогресса:
// каждая точка несёт id, state и таймстемпы, а маршрут — объект progress.
// Используется при чтении, чтобы клиент всегда видел полную структуру, не
// перезаписывая БД на каждом GET.
// Человекочитаемая причина, по которой маршрут заблокирован для редактирования.
// Уточняет «почему так пишет»: вместо общего «маршрут занят» показывает, кто
// сейчас держит маршрут — водитель в пути или склад в сборке/отгрузке.
function routeLockReason(progress) {
  const p = progress || {};
  if (p.status === "done") return "Завершённый маршрут нельзя редактировать";
  if (p.status === "active") {
    return "Маршрут ведётся водителем — редактировать нельзя (водитель не завершил маршрут)";
  }
  if (p.shipmentStartedAt) {
    return "Маршрут в сборке/отгрузке на складе — редактировать нельзя (склад начал сборку)";
  }
  return "Маршрут занят (в работе или в сборке) — редактировать нельзя";
}

function normalizeRouteProgress(route) {
  if (!route) return route;
  const clone = JSON.parse(JSON.stringify(route));
  clone.progress = Object.assign(
    { status: "idle", baseLat: null, baseLon: null, baseAddress: "", baseArrivedAt: null },
    clone.progress || {}
  );
  // Защита от битых/необъектных записей точек: раньше c.state на null ронял
  // загрузку раздела (500). Такие записи отбрасываем, сохраняя валидные точки.
  clone.clients = (Array.isArray(clone.clients) ? clone.clients : [])
    .filter((c) => !!c && typeof c === "object")
    .map((c, i) => {
      if (!c.id) c.id = `${clone.id || "r"}-st${i + 1}`;
      c.state = c.state || "pending";
      c.transitStart = c.transitStart || null;
      c.transitEnd = c.transitEnd || null;
      c.siteStart = c.siteStart || null;
      c.siteEnd = c.siteEnd || null;
      // Накопленная суммарная длительность обеденных перерывов, которая
      // пришлась на этот отрезок пути (в пути к этой точке). Вычитается из
      // transitEnd − transitStart, чтобы время в пути не включало обед.
      c.transitPaused = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
      c.postponeReason = c.postponeReason || null;
      return c;
    });
  return clone;
}
// Выравнивает накладные под текущий порядок клиентов маршрута. Каждая накладная
// хранит clientIndex (индекс КЛИЕНТА на момент загрузки). Если клиентов позже
// переставили/добавили/убрали, позиция клиента меняется, а накладная остаётся с
// прежним clientIndex — из-за этого под «АвтоМ» могла попадать накладная «Рольф ЮГ»
// (чужие «не найдено» и собранные позиции). Здесь waybills перестраиваются в массив,
// где waybills[i] = НАКЛАДНАЯ с clientIndex===i (снакладная точки i). Применяем при
// отдаче маршрута и в отчёте «не найдено».
function alignWaybillsToClients(route) {
  if (!route) return route;
  const clients = Array.isArray(route.clients) ? route.clients : [];
  const byIdx = {};
  const wbs = route.waybills && typeof route.waybills === "object" ? route.waybills : {};
  const consume = (wb, i) => {
    if (wb == null) return;
    const idx = (wb.clientIndex != null) ? Number(wb.clientIndex) : (Number.isInteger(Number(i)) ? Number(i) : -1);
    if (Number.isInteger(idx) && idx >= 0) byIdx[idx] = wb;
  };
  if (Array.isArray(route.waybills)) route.waybills.forEach(consume);
  else Object.keys(wbs).forEach((k) => consume(wbs[k], k));
  const out = [];
  clients.forEach((c, i) => { out[i] = byIdx[i] || null; });
  route.waybills = out;
  return route;
}

// Нормализует одну точку маршрута-остановку. Каждая точка — одна ОСТАНОВКА
// (адрес). Для связки (несколько контрагентов на одном адресе) точка несёт
// список members — контрагентов этой остановки. Тогда в маршруте связка
// считается одним клиентом: одна печать этикеток, одна выгрузка/сдача.
function normalizeRouteClient(c) {
  const members = Array.isArray(c && c.members)
    ? c.members
        .filter((m) => !!m && (m.client || m.address))
        .slice(0, 50)
        .map((m) => ({
          client: String(m.client || "").slice(0, 200),
          address: String(m.address || "").slice(0, 500),
          bundleId: m.bundleId ? String(m.bundleId).slice(0, 60) : null,
          logo: m.logo ? String(m.logo).slice(0, 200000) : null,
          logoText: String(m.logoText || "").toUpperCase().slice(0, 5),
          bundleName: String(m.bundleName || "").slice(0, 200),
        }))
    : undefined;
  const base = {
    client: String((c && c.client) || "").slice(0, 200),
    address: String((c && c.address) || "").slice(0, 500),
    bundleId: c && c.bundleId ? String(c.bundleId).slice(0, 60) : null,
    logo: c && c.logo ? String(c.logo).slice(0, 200000) : null,
    logoText: String((c && c.logoText) || "").toUpperCase().slice(0, 5),
    bundleName: String((c && c.bundleName) || "").slice(0, 200),
    inn: String((c && c.inn) || "").trim(),
    login: String((c && c.login) || "").trim(),
  };
  if (members && members.length > 0) base.members = members;
  return base;
}

// Подтягивает ЕДИНОЕ название связки (bundleName) у точек маршрута из актуальной
// базы контрагентов (db.driverClients), если в самой точке оно пусто. Это чинит
// и старые маршруты, созданные до того, как единое название стало копироваться
// в точку: диспетчер задал «Единое название» связки (bundle-name), а в сохранённой
// точке поля bundleName не было. Резолв по общему bundleId: у всех участников
// связки bundleName один и тот же. Возвращает клон маршрута.
function withResolvedBundleNames(route, dbData) {
  if (!route || !Array.isArray(route.clients)) return route;
  const clients = dbData && Array.isArray(dbData.driverClients) ? dbData.driverClients : [];
  // Индекс единого названия по bundleId: <>-первый непустой bundleName связки.
  const nameByBundle = new Map();
  for (const cl of clients) {
    if (!cl || !cl.bundleId || !cl.bundleName) continue;
    const bid = String(cl.bundleId);
    if (!nameByBundle.has(bid)) nameByBundle.set(bid, String(cl.bundleName));
  }
  const clone = JSON.parse(JSON.stringify(route));
  clone.clients = (clone.clients || []).map((c) => {
    if (!c) return c;
    const bid = c.bundleId ? String(c.bundleId) : "";
    const resolved = bid && !c.bundleName ? (nameByBundle.get(bid) || "") : (c.bundleName || "");
    if (resolved) c.bundleName = resolved;
    // Та же логика для участников связки (members).
    if (Array.isArray(c.members)) {
      c.members = c.members.map((m) => {
        if (!m) return m;
        if (!m.bundleName) m.bundleName = resolved;
        return m;
      });
    }
    return c;
  });
  return clone;
}

// Обогащает точки маршрута водителя счётчиком выгрузки мест клиента: сколько
// этикеток уже выгружено (status "delivered"), сколько всего, и готов ли клиент
// к завершению выгрузки. Считается по хранилищу этикеток: код места клиента —
// «BG<routeId>-<clientIndex+1>-<place>», где clientIndex — индекс точки в
// route.clients. Поля unloadTotal/unloadDone/unloadReady вычисляются на лету
// (не персистятся); unloadFinished — это ручной флаг «водитель завершил выгрузку»
// (сохраняется в точке и НЕ переводит её в delivered — водитель остаётся на
// точке, время сдачи продолжает идти, пока не нажмёт «Завершить сдачу»).
// Единый расчёт счётчиков выгрузки клиента по его этикеткам. «Всего» = только
// погруженные (loaded|delivered); места со статусом "created" (напечатаны, но не
// погружены складом) в знаменатель выгрузки НЕ входят, но считаются отдельно —
// водитель физически не может их выгрузить, и их наличие не должно завышать
// счётчик и блокировать завершение выгрузки. Используется и при обогащении
// точек, и при обработке действия finish_unload — одна точка истины.
function unloadCounts(mine) {
  const arr = Array.isArray(mine) ? mine : [];
  const total = arr.filter((l) => l.status === "loaded" || l.status === "delivered").length;
  const done = arr.filter((l) => l.status === "delivered").length;
  const created = arr.filter((l) => l.status === "created").length;
  return { total, done, created };
}

function enrichUnloadProgress(route, labels) {
  const clients = Array.isArray(route && route.clients) ? route.clients : [];
  const all = labels || [];
  clients.forEach((c, i) => {
    const mine = all.filter(
      (l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === i
    );
    const { total, done, created } = unloadCounts(mine);
    c.unloadTotal = total;
    c.unloadDone = done;
    c.unloadCreated = created;
    // «Готово к завершению выгрузки»: все места выгружены, либо у клиента вовсе
    // нет этикеток (печатать нечего — завершить выгрузку разрешено).
    c.unloadReady = total === 0 ? true : done === total;
    c.unloadFinished = c.unloadFinished === true;
  });
  return route;
}

// Перепривязка этикеток маршрута при редактировании его состава. Этикетка
// хранит clientIndex — позицию клиента в маршруте (код наклейки
// «BG<routeId>-<clientIndex+1>-<place>», счётчики «Мест: N» идут по
// Number(l.clientIndex) === позиции). Если порядок/состав клиентов изменился
// (клиента переставили, убрали, добавили), а clientIndex у этикеток остался
// старым, места «съезжают» на чужого клиента (Авилон ЗИЛ вдруг показывает 3
// вместо ДЦ Алтуфьево). Сопоставляем каждую этикетку с новым клиентом по
// адресу (осн.) / имени (фолбэк) и обновляем её clientIndex под актуальную
// позицию. Этикетки, чей клиент исчез из маршрута, не трогаем (их индекс
// перестанет совпадать, и счетчики по ним обнулятся — это честно помечает
// «лишние» места).
// (релink этикеток вынесен в routes/helpers.js — см. relinkRouteLabels там)
const relinkRouteLabels = require("./routes/helpers").relinkRouteLabels;
// Перепривязка накладных (сборка + «не найдено») при reorder: накладная привязана
// к позиции маршрута, поэтому при перестановке клиентов её надо перенести на
// новый индекс своего клиента (по id), иначе сборка одного клиента «переезжает»
// к другому (позиция из сборки «Фроза» попадает в «Система»).
function relinkRouteWaybills(oldClients, newClients, waybills) {
  if (!waybills || typeof waybills !== "object") return waybills;
  if (!Array.isArray(oldClients) || !Array.isArray(newClients)) return waybills;
  const newIdxById = new Map(newClients.map((c, i) => [String(c && c.id), i]));
  const out = {};
  oldClients.forEach((oldC, oldIdx) => {
    if (!oldC) return;
    const wb = waybills[oldIdx];
    if (wb == null) return;
    const newIdx = newIdxById.get(String(oldC.id));
    if (newIdx != null) out[newIdx] = wb;
  });
  for (const key of Object.keys(waybills)) {
    const i = Number(key);
    if (Number.isInteger(i) && out[i] === undefined) out[i] = waybills[key];
  }
  return out;
}

// Протяжённость маршрута в км по последовательности остановок:
// база → точки маршрута → возврат на базу (как в отчёте движения).
// Маршрут хранит адреса точек, а не координаты, поэтому координаты берём из
// справочника контрагентов (по совпадению адреса); фолбэк — координаты самой
// точки, если они были сохранены ранее. Метод — гаверсинус: мгновенный, без
// внешних вызовов, безопасен для рендера списка со ВСЕМИ маршрутами сразу.
// Возвращает число (км) или null, если посчитать не по чему.
function routeKm(route) {
  if (!route) return null;
  const path = [];
  const prog = route.progress || {};
  if (Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
    path.push({ lat: prog.baseLat, lon: prog.baseLon });
  }
  (Array.isArray(route.clients) ? route.clients : []).forEach((c) => {
    if (!c) return;
    let pt = null;
    const addr = String(c.bundleAddress || c.address || "").trim().toLowerCase();
    if (addr) {
      const cc = (db.driverClients || []).find((x) =>
        String(x.bundleAddress || x.address || "").trim().toLowerCase() === addr
      );
      if (cc && Number.isFinite(cc.lat) && Number.isFinite(cc.lon)) {
        pt = { lat: cc.lat, lon: cc.lon };
      }
    }
    if (!pt && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      pt = { lat: c.lat, lon: c.lon };
    }
    if (pt) path.push(pt);
  });
  // Возврат на базу — последний отрезок (если маршрут имеет базу).
  if (path.length >= 2 && Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
    path.push({ lat: prog.baseLat, lon: prog.baseLon });
  }
  if (path.length < 2) return null;
  let km = 0;
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1] && path[i]) km += haversineKm(path[i - 1], path[i]);
  }
  return Math.round(km * 10) / 10;
}

// Кэш ДОРОЖНОЙ протяжённости маршрутов: routeId -> km (по дорогам, 2ГИС).
// Считается в фоне при GET /api/drivers/routes (фолбэк в ответе — routeKm по
// прямой) и кэшируется, чтобы следующий просмотр списка показал км, совпадающий
// с дорожными мостами карты. Живёт в памяти — передеплой пересчитает заново.
const routeKmCache = {};
const routeKmPending = {};

// Дорожная протяжённость маршрута (база → точки → возврат на базу) ОДНИМ вызовом
// матрицы 2ГИС по всем точкам сразу (сумма соседних ячеек). Фолбэк — гаверсинус
// по прямой (routeKm). Возвращает Promise<number|null>.
async function routeKmRoad(route) {
  if (!route) return null;
  const path = [];
  const prog = route.progress || {};
  if (Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
    path.push({ lat: prog.baseLat, lon: prog.baseLon });
  }
  (Array.isArray(route.clients) ? route.clients : []).forEach((c) => {
    if (!c) return;
    let pt = null;
    const addr = String(c.bundleAddress || c.address || "").trim().toLowerCase();
    if (addr) {
      const cc = (db.driverClients || []).find((x) =>
        String(x.bundleAddress || x.address || "").trim().toLowerCase() === addr
      );
      if (cc && Number.isFinite(cc.lat) && Number.isFinite(cc.lon)) {
        pt = { lat: cc.lat, lon: cc.lon };
      }
    }
    if (!pt && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
      pt = { lat: c.lat, lon: c.lon };
    }
    if (pt) path.push(pt);
  });
  if (path.length >= 2 && Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
    path.push({ lat: prog.baseLat, lon: prog.baseLon }); // возврат на базу
  }
  if (path.length < 2) return null;
  // 1) По дорогам через матрицу 2ГИС (один вызов на весь маршрут).
  try {
    const matrix = await gisDistanceMatrix(path);
    if (matrix && matrix.length >= path.length) {
      let road = 0;
      let ok = true;
      for (let i = 1; i < path.length; i++) {
        const d = matrix[i - 1] && matrix[i - 1][i];
        if (!Number.isFinite(d)) { ok = false; break; }
        road += d;
      }
      if (ok) return Math.round(road * 10) / 10;
    }
  } catch { /* запасной */ }
  // 2) Фолбэк — по прямой.
  let km = 0;
  for (let i = 1; i < path.length; i++) {
    if (path[i - 1] && path[i]) km += haversineKm(path[i - 1], path[i]);
  }
  return Math.round(km * 10) / 10;
}

// ---- Автопостроение маршрута по адресам клиентов (Яндекс.Карты) ----
// Геокодирование адреса → координаты [lat, lon]. Ключ API берётся из окружения
// (YANDEX_GEO_KEY), с фолбэком на ключ проекта (уже используется в test-yamaps).
// Если сервис недоступен или адрес не распознан — возвращается null (не краш).
const YANDEX_GEO_URL = "https://geocode-maps.yandex.ru/1.x/";
// Рабочий ключ Geocoder HTTP API. Задаётся через окружение (YANDEX_GEO_KEY) или
// .env (не коммитится). Значение в коде НЕ хранится. Без заголовков User-Agent/
// Referer Яндex отвечает 403 «Invalid api key» даже на активный ключ — их
// обязательно шлём в запросе.
const YANDEX_GEO_KEY = process.env.YANDEX_GEO_KEY || "";
const GEO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Referer": "https://developer.tech.yandex.ru/",
};
// Ключ JavaScript API Яндекс.Карт для живой карты администратора. Задаётся через
// окружение (YANDEX_MAPS_KEY) или .env (не коммитится). Ключ JS API всё равно
// виден в браузере (так устроен Я.Карты), поэтому секретности нет, но в код
// значение не вписываем — оно уходит в .env/окружение.
const YANDEX_MAPS_KEY = process.env.YANDEX_MAPS_KEY || "";

function geocodeAddress(address) {
  return new Promise((resolve) => {
    const text = String(address || "").trim();
    if (!text) return resolve(null);
    const url = YANDEX_GEO_URL + "?format=json&results=1&lang=ru_RU&apikey=" +
      encodeURIComponent(YANDEX_GEO_KEY) + "&geocode=" + encodeURIComponent(text);
    const req = https.get(url, { headers: GEO_HEADERS }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const fm = j && j.response && j.response.GeoObjectCollection &&
            j.response.GeoObjectCollection.featureMember;
          if (Array.isArray(fm) && fm[0] && fm[0].GeoObject && fm[0].GeoObject.Point) {
            const pos = String(fm[0].GeoObject.Point.pos || "").split(" ").map(Number);
            if (pos.length >= 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
              // Яндекс отдаёт «долгота широта».
              return resolve({ lat: pos[1], lon: pos[0] });
            }
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Обратное геокодирование координат [lat, lon] → текстовый адрес. Тот же ключ
// YANDEX_GEO_KEY, что и прямое геокодирование; кэшируем по координатам, чтобы
// 15-минутный отчёт «Местоположение» не долбил API десятками одинаковых запросов.
const reverseGeocodeCache = new Map();
function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    if (!YANDEX_GEO_KEY || !Number.isFinite(lat) || !Number.isFinite(lon)) return resolve(null);
    const ck = lat.toFixed(5) + "," + lon.toFixed(5);
    if (reverseGeocodeCache.has(ck)) return resolve(reverseGeocodeCache.get(ck));
    const url = YANDEX_GEO_URL + "?format=json&results=1&lang=ru_RU&apikey=" +
      encodeURIComponent(YANDEX_GEO_KEY) + "&geocode=" + encodeURIComponent(lon + "," + lat);
    const req = https.get(url, { headers: GEO_HEADERS }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const fm = j && j.response && j.response.GeoObjectCollection &&
            j.response.GeoObjectCollection.featureMember;
          let addr = null;
          if (Array.isArray(fm) && fm[0] && fm[0].GeoObject) {
            const md = fm[0].GeoObject.metaDataProperty &&
              fm[0].GeoObject.metaDataProperty.GeocoderMetaData;
            addr = (md && md.text) || fm[0].GeoObject.name || null;
          }
          if (addr) reverseGeocodeCache.set(ck, addr);
          return resolve(addr);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Расстояние между двумя точками по формуле гаверсинуса (км).
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Жадная оптимизация порядка объезда («ближайший сосед»): на каждом шаге едем
// к ближайшей непосещённой точке. Началом служит база, если задана, иначе —
// первая точка списка. Возвращает индексы points в новом порядке.
function nearestNeighbor(points, start) {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);
  const used = new Array(n).fill(false);
  const order = [];
  let startPt = start && Number.isFinite(start.lat) && Number.isFinite(start.lon)
    ? start
    : { lat: points[0].lat, lon: points[0].lon, _fake: true };
  let prevPt = null; // предыдущая точка — нужна для курса и правила правого поворота
  let cur = startPt;
  for (let step = 0; step < n; step++) {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const cand = { lat: points[i].lat, lon: points[i].lon };
      const d = haversineKm(cur, cand);
      // Штраф за левый поворот/разворот (правило правого поворота). Первый шаг
      // (без предыдущей точки) — штрафа нет.
      const pen = prevPt && !(cur && cur._fake) ? turnPenaltyKm(prevPt, cur, cand) : 0;
      if (d + pen < bestScore) { bestScore = d + pen; best = i; }
    }
    if (best < 0) break;
    used[best] = true;
    order.push(best);
    prevPt = cur;
    cur = { lat: points[best].lat, lon: points[best].lon };
  }
  return order;
}

// ---- Автопостроение по реальным дорогам (OSRM) ----
// Бесплатный open-source маршрутизатор по дорогам OpenStreetMap. Учитывает
// реальную дорожную сеть (но НЕ живые пробки). Адрес сервера задаётся в
// окружении (OSRM_URL); по умолчанию — свободный публичный OSRM-сервер
// OpenStreetMap (routed-car). Если сервер недоступен или не отвечает,
// оптимизация откатывается на гаверсинус («по прямой»).
const OSRM_URL = (process.env.OSRM_URL || "https://routing.openstreetmap.de/routed-car").replace(/\/+$/, "");

// ---- Автопостроение по реальному времени с учётом пробок (TomTom) ----
// Платный/лимитный сервис маршрутизации. Если ключ задан (TOMMOM_KEY) —
// оптимизация использует реальное время проезда с учётом пробок. Без ключа
// (или при ошибке/таймауте) безопасно откатывается на OSRM → гаверсинус.
const TOMMOM_KEY = String(
  process.env.TOMMOM_KEY || ""
);

// ---- Автопостроение маршрута с учётом пробок на 2ГИС (российский сервис) ----
// Бесплатный тариф разработчика 2ГИС: Distance Matrix API с учётом текущих
// пробок (type: "jam"). Доступен из РФ, не требует зарубежных сервисов.
// Ключ задаётся в окружении (GIS_API_KEY) или в .env (не коммитится) — в коде
// не хранится. Если ключ не задан (или API не ответил), безопасно откатываемся
// на TomTom → OSRM → прямую.
const GIS_API_KEY = String(
  process.env.GIS_API_KEY || ""
).trim();

// Запрашивает у 2ГИС Distance Matrix время в пути (сек) между всеми парами
// точек с учётом текущих пробок (type: "jam"). Точки — [{lat, lon}, ...];
// результат — number[][] (сек) или null при недоступности/ошибке.
function gisDurationMatrix(points) {
  return new Promise((resolve) => {
    if (!GIS_API_KEY || points.length === 0) return resolve(null);
    const n = points.length;
    const payload = {
      points: points.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) })),
      sources: Array.from({ length: n }, (_, i) => i),
      targets: Array.from({ length: n }, (_, i) => i),
      transport: "driving",
      type: "jam", // строить маршрут с учётом ТЕКУЩИХ пробок
    };
    const body = JSON.stringify(payload);
    const url = "https://routing.api.2gis.com/get_dist_matrix?key=" +
      encodeURIComponent(GIS_API_KEY) + "&version=2.0";
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const routes = j && Array.isArray(j.routes) ? j.routes : null;
          if (!routes) return resolve(null);
          const cell = (s, t) => {
            const row = routes.find((r) => Number(r.source_id) === s && Number(r.target_id) === t);
            if (!row || row.status !== "OK") return Infinity;
            return Number.isFinite(Number(row.duration)) ? Number(row.duration) : Infinity;
          };
          const out = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => cell(r, c)));
          const ok = out.every((row) => row.every((t) => Number.isFinite(t) && t < Infinity));
          return resolve(ok ? out : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// Запрашивает у 2ГИС Distance Matrix РАССТОЯНИЕ (км) между всеми парами точек
// по реальным дорогам с учётом текущих пробок (type: "jam"). Точки —
// [{lat, lon}, ...]; результат — number[][] (км) или null при недоступности.
// Используется для показа «км между точками маршрута» на экране выбора клиентов.
function gisDistanceMatrix(points) {
  return new Promise((resolve) => {
    if (!GIS_API_KEY || points.length === 0) return resolve(null);
    const n = points.length;
    const payload = {
      points: points.map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) })),
      sources: Array.from({ length: n }, (_, i) => i),
      targets: Array.from({ length: n }, (_, i) => i),
      transport: "driving",
      // type "shortest" — детерминированный кратчайший маршрут по дорогам БЕЗ
      // учёта текущих пробок. Раньше был "jam" (с пробками) — из-за этого
      // километраж секций «плавал» между построениями одного и того же маршрута
      // (2ГИС перекладывала путь в объезд пробок → км менялся). С "shortest"
      // одинаковые точки всегда дают одинаковое расстояние. Для построения
      // по времени пробки учитываются отдельно (матрицы TomTom/OSRM).
      type: "shortest",
    };
    const body = JSON.stringify(payload);
    const url = "https://routing.api.2gis.com/get_dist_matrix?key=" +
      encodeURIComponent(GIS_API_KEY) + "&version=2.0";
    const req = https.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const routes = j && Array.isArray(j.routes) ? j.routes : null;
          if (!routes) return resolve(null);
          const cell = (s, t) => {
            const row = routes.find((r) => Number(r.source_id) === s && Number(r.target_id) === t);
            if (!row || row.status !== "OK") return Infinity;
            // 2ГИС возвращает дистанцию в метрах — переводим в км.
            return Number.isFinite(Number(row.distance)) ? Number(row.distance) / 1000 : Infinity;
          };
          const out = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => cell(r, c)));
          const ok = out.every((row) => row.every((t) => Number.isFinite(t) && t < Infinity));
          return resolve(ok ? out : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// Запрашивает у TomTom Routing Matrix время в пути (сек) между всеми парами
// точек. Точки — [{lat, lon}, ...]; результат — number[][] или null.
function tomtomDurationMatrix(points) {
  return new Promise((resolve) => {
    if (!TOMMOM_KEY || points.length === 0) return resolve(null);
    const payload = {
      origins: points.map((p) => ({ point: { latitude: p.lat, longitude: p.lon } })),
      destinations: points.map((p) => ({ point: { latitude: p.lat, longitude: p.lon } })),
    };
    const body = JSON.stringify(payload);
    const url = `https://api.tomtom.com/routing/1/matrix/json?key=${encodeURIComponent(TOMMOM_KEY)}&routeType=shortest&traffic=true&computeTravelTimeFor=all`;
    const req = https.request(url, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const matrix = j && Array.isArray(j.matrix) ? j.matrix : null;
          if (!matrix) return resolve(null);
          // Переводим в число[][] с временем в секундах.
          const n = matrix.length;
          const out = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => {
            const cell = matrix[r] && matrix[r][c];
            const rt = cell && cell.routeSummary ? cell.routeSummary.travelTimeInSeconds : null;
            return Number.isFinite(rt) ? rt : Infinity;
          }));
          return resolve(out);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(20000, () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// Строит дорожный полилайн между двумя точками через TomTom calculateRoute.
// Публичные OSRM-серверы сейчас отвечают 403, поэтому для «привязки к дорогам»
// используем TomTom (ключ уже настроен; calculateRoute по тарифу работает).
// Возвращает [[lat,lon],...] (порядок точек по ходу движения) или null.
function tomtomRouteGeometry(a, b) {
  return new Promise((resolve) => {
    if (!TOMMOM_KEY || !a || !b) return resolve(null);
    const url = "https://api.tomtom.com/routing/1/calculateRoute/" +
      `${Number(a[1]).toFixed(6)},${Number(a[0]).toFixed(6)}:${Number(b[1]).toFixed(6)},${Number(b[0]).toFixed(6)}` +
      "/json?key=" + encodeURIComponent(TOMMOM_KEY) +
      "&routeType=shortest&traffic=false&language=ru-RU";
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          const legs = j && j.routes && j.routes[0] && Array.isArray(j.routes[0].legs)
            ? j.routes[0].legs
            : null;
          if (!legs || legs.length === 0) return resolve(null);
          const out = [];
          for (const leg of legs) {
            if (!leg || !Array.isArray(leg.points)) continue;
            for (const p of leg.points) {
              if (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
                out.push([p.latitude, p.longitude]);
              }
            }
          }
          return resolve(out.length >= 2 ? out : null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Запрашивает у OSRM матрицу времени в пути (сек) между всеми парами точек.
// returns: Promise<number[][] | null>
function osrmDurationMatrix(points) {
  return new Promise((resolve) => {
    const coordinates = points
      .map((p) => `${Number(p.lon).toFixed(6)},${Number(p.lat).toFixed(6)}`)
      .join(";");
    const url = `${OSRM_URL}/table/v1/driving/${coordinates}?annotations=duration`;
    const req = https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(data);
          if (j && j.code === "Ok" && Array.isArray(j.durations)) {
            return resolve(j.durations);
          }
          resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
  });
}

// Оптимизация порядка по реальному времени в пути (матрица OSRM): жадный
// «ближайший сосед», но расстояние выбирается по фактической продолжительности
// поездки между точками. Матрица построена по точкам [база?] + points, поэтому
// при withBase точка i в списке соответствует индексу (i+1) в матрице.
// Возвращает индексы points в новом порядке.
function nearestByTime(points, matrix, withBase, coords) {
  const n = points.length;
  if (n <= 1) return points.map((_, i) => i);
  const off = withBase ? 1 : 0; // смещение индексов из-за базы в начале списка OSRM
  const used = new Array(n).fill(false);
  const order = [];
  let cur = withBase ? -1 : 0; // -1 — «стоим у базы», её индекс в матрице 0
  let prev = null;             // индекс предыдущей «геометрической» точки в coords
  if (!withBase) { used[0] = true; order.push(0); }
  for (let step = order.length; step < n; step++) {
    let best = -1;
    let bestT = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const r = cur < 0 ? 0 : cur + off;
      const c = i + off;
      const t = matrix[r][c];
      if (t == null || !Number.isFinite(t)) continue;
      // Правило правого поворота: штраф за левый поворот/разворот поверх времени
      // в пути (которое уже учитывает пробки через TomTom / дороги через OSRM).
      let pen = 0;
      const curGeo = cur < 0 ? coords && coords[0] : coords && coords[cur + off];
      const prevGeo = prev != null && coords ? coords[prev] : null;
      if (prev != null && prevGeo && curGeo && coords) {
        pen = turnPenaltySeconds(prevGeo, curGeo, coords[i + off]);
      }
      if (t + pen < bestT) { bestT = t + pen; best = i; }
    }
    if (best < 0) break;
    used[best] = true;
    order.push(best);
    prev = cur < 0 ? 0 : cur + off; // геометрический индекс текущей точки в coords
    cur = best;
  }
  return order;
}

// ---- Правило правого поворота ----
// Известный приём логистики: при объезде точек стараться выбирать такой порядок,
// где движение идёт «по ходу» (прямо/направо) и по возможности избегать левых
// поворотов (они требуют пересечения встречного потока — дольше и опаснее) и
// разворотов. Здесь поворот оценивается геометрически по координатам: когда из
// текущей точки выбираем следующую, смотрим угол между текущим курсом
// (предыдущая → текущая точка) и направлением к кандидату.
//  - прямо / небольшое отклонение  → штраф 0;
//  - правый поворот              → лёгкий положительный штраф;
//  - левый поворот               → ощутимый штраф;
//  - почти разворот назад         → максимальный штраф.
// Штрафы для матрицы времени даны в секундах, для гаверсинуса — в км-эквиваленте.

// diff в радианах между курсом (prev→cur) и направлением на кандидата (cur→cand).
function turnSign(prev, cur, cand) {
  const h = Math.atan2(cur.lat - prev.lat, cur.lon - prev.lon);
  const d = Math.atan2(cand.lat - cur.lat, cand.lon - cur.lon);
  let diff = d - h;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  return diff; // <0 — направо, >0 — налево (в СК north-up)
}

function turnPenaltySeconds(prev, cur, cand) {
  if (!prev && !cand) return 0;
  if (!prev || !cur || !cand) return 0; // нет предыдущей точки — направления нет
  const diff = turnSign(prev, cur, cand);
  const deg = Math.abs(diff) * 180 / Math.PI;
  if (deg < 40) return 0;          // едем прямо
  if (deg > 140) return 120;       // почти разворот
  return diff < 0 ? 15 : 45;       // правый → легче, левый → тяжелее
}

function turnPenaltyKm(prev, cur, cand) {
  if (!prev || !cur || !cand) return 0;
  const diff = turnSign(prev, cur, cand);
  const deg = Math.abs(diff) * 180 / Math.PI;
  if (deg < 40) return 0;
  if (deg > 140) return 2.5;       // разворот ~ +2.5 км
  return diff < 0 ? 0.3 : 1.0;     // правый → легче, левый → тяжелее
}

// Точки, у которых ещё нет координат, догeокодируем по адресу (или адресу связки).
async function ensureClientCoords(client) {
  if (Number.isFinite(client.lat) && Number.isFinite(client.lon)) return;
  const address = String(client.bundleAddress || client.address || "").trim();
  if (!address) return;
  const g = await geocodeAddress(address);
  if (g) { client.lat = g.lat; client.lon = g.lon; }
}

// Фоновое до-геокодирование клиентов без координат. Запускается fire-and-forget
// из GET /api/drivers/clients, чтобы не блокировать карту трекинга. На одного
// клиента — не чаще раза в сутки, за один проход — не более 5 геокодов.
async function geocodeLackingClients(dbData, persistFn) {
  try {
    let changed = false;
    const now = Date.now();
    let attempts = 0;
    for (const c of dbData.driverClients || []) {
      if (attempts >= 5) break;
      if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) continue;
      if (!String(c.address || "").trim()) continue;
      if (Number.isFinite(c.geoAttemptAt) && (now - c.geoAttemptAt) < 86400000) continue;
      c.geoAttemptAt = now;
      const g = await geocodeAddress(c.address);
      if (g) { c.lat = g.lat; c.lon = g.lon; changed = true; }
      attempts++;
    }
    if (changed && persistFn) await persistFn();
  } catch { /* фоновая задача — не роняем сервер */ }
}

// Can the user set / manage day statuses for a given staff id?
// Admins manage everyone; a moderator manages only their own group members.
function canManageStatus(user, dbData, staffId) {
  if (isAdmin(user, dbData)) return true;
  if (isModerator(user, dbData)) return moderatorVisibleIds(user, dbData).has(staffId);
  return false;
}

// Может ли пользователь видеть и работать с разделом «Отгрузка»: либо админ,
// либо сотрудник группы, отмеченной в параметрах (и раздел включён).
function canSeeShipment(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  // «Погрузка» — чистый погрузочный терминал: доступ к «Отгрузке» у него
  // включён всегда, независимо от showShipment и shipmentGroups.
  if (isLoader(user, dbData)) return true;
  const p = dbData.params || {};
  if (p.showShipment !== true) return false;
  const ids = Array.isArray(p.shipmentGroups) ? p.shipmentGroups : [];
  if (ids.length === 0) return false;
  const uid = String(user.id);
  return ids.some((gid) => {
    const g = (dbData.groups || []).find((x) => String(x.id) === String(gid));
    return g && (g.memberIds || []).includes(uid);
  });
}

// Доступ к «Отчёту не найдено»: админ/модератор — всегда; остальным — только те,
// кто отмечен в «Параметры → Доступ к “Отчёту не найдено”» (notfoundUsers).
// Клиентская вкладка строится по этому же правилу, поэтому сервер обязан пускать
// в /api/notfound именно этих сотрудников (иначе — forbidden, хотя вкладка видна).
function canSeeNotfound(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  if (isModerator(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.notfoundUsers)
    ? dbData.params.notfoundUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

// Кто (кроме админа и модератора) видит вкладку «Логи»: сотрудники из
// «Параметры → Доступ к “Логи”» (logUsers). Сервер тоже обязан пускать именно
// этих сотрудников в /api/logs — иначе вкладка видна, а данные не отдаются.
function canSeeLogs(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  if (isModerator(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.logUsers)
    ? dbData.params.logUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

// Кто (кроме админа и модератора) видит вкладку «Отчёты» (модуль АБЦП): сотрудники
// из «Параметры → Доступ к “Отчёты”» (reportsUsers). Сервер тоже пускает именно
// этих сотрудников в /reports/api/* — иначе вкладка видна, а данные не отдаются.
function canSeeReports(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.reportsUsers)
    ? dbData.params.reportsUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

// Доступ к модулю «Сверки»: админ всегда, остальные — из «Доступ к разделам»
// (sverkiUsers). Сервер тоже пускает только этих сотрудников в /sverki/*.
function canSeeSverki(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.sverkiUsers)
    ? dbData.params.sverkiUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

function canSeeProcenka(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.procenkaUsers)
    ? dbData.params.procenkaUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

function canSeeParser(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  const ids = Array.isArray(dbData && dbData.params && dbData.params.parserUsers)
    ? dbData.params.parserUsers
    : [];
  if (ids.length === 0) return false;
  return user.id != null && ids.some((x) => String(x) === String(user.id));
}

// «Распорядитель склада»: админ портала ИЛИ модератор группы, входящей в
// shipmentGroups. Такой пользователь может завершить отгрузку без полного
// сканирования и вернуть маршрут обратно к отгрузке. Обычные сотрудники склада
// (только члены группы) обязаны сначала отсканировать все этикетки.
function canManageShipment(user, dbData) {
  if (!user) return false;
  if (isAdmin(user, dbData)) return true;
  const p = dbData.params || {};
  const ids = Array.isArray(p.shipmentGroups) ? p.shipmentGroups : [];
  if (ids.length === 0) return false;
  const uid = String(user.id);
  return (dbData.groups || []).some(
    (g) => ids.includes(String(g.id)) && String(g.moderatorId) === uid
  );
}

// Remove a removed/blocked employee from every group: drop from memberIds and
// clear the moderator role if it was theirs.
function purgeStaffFromGroups(staffId, dbData) {
  for (const g of dbData.groups || []) {
    g.memberIds = (g.memberIds || []).filter((id) => id !== staffId);
    if (g.moderatorId === staffId) g.moderatorId = null;
  }
}

// ---- Per-employee overtime visibility ----
// The "show overtime hours / money" params may be scoped to a set of groups:
// empty group list = applies to everyone (the historic behaviour). This decides,
// for a given staff member, whether they see the hours (or the money) in their
// own calendar and in the shared timesheet rows.
function staffSeesOver(dbData, staffId, which) {
  const p = dbData.params || {};
  const key = which === "hours" ? "showOverHoursGroups" : "showOverSumGroups";
  const globalOn = which === "hours" ? p.showOverHours : p.showOverSum;
  if (!globalOn) return false;
  const ids = Array.isArray(p[key]) ? p[key] : [];
  if (ids.length === 0) return true; // no groups selected -> everyone
  return ids.some((gid) => {
    const g = (dbData.groups || []).find((x) => x.id === gid);
    return g && (g.memberIds || []).includes(staffId);
  });
}

function visibleStaff(user, dbData) {
  // Модератор всегда ограничен членами своих групп — даже если по роли с
  // портала он приходит как ADMIN (или добавлен в список администраторов
  // приложения). Назначение модератором группы имеет приоритет: в «В эфире»,
  // отчёте и календаре он видит только своих.
  // Погрузчиков (роль «Погрузка») исключаем из любых списков видимости —
  // чистый погрузочный терминал не фигурирует в Табеле, расчёте ЗП и «Эфире».
  const notLoader = (s) => !isLoaderById(s && s.id, dbData);
  if (isModerator(user, dbData)) {
    const ids = moderatorVisibleIds(user, dbData);
    return dbData.staff.filter((s) => ids.has(s.id) && notLoader(s));
  }
  if (isAdmin(user, dbData)) return dbData.staff.filter(notLoader);
  const ids = moderatorVisibleIds(user, dbData);
  if (ids.size > 0) return dbData.staff.filter((s) => ids.has(s.id) && notLoader(s));
  return dbData.staff.filter((s) => s.id === user.id && notLoader(s));
}

// Клонирует день (db.days[key]), убирая сегменты и статусы погрузчиков (роль
// «Погрузка»). Возвращает null, если после очистки в дне ничего не осталось.
function dayWithoutLoaders(rec, dbData) {
  const byEmp = rec && rec.byEmployee && typeof rec.byEmployee === "object" ? rec.byEmployee : {};
  const statuses = rec && rec.statuses && typeof rec.statuses === "object" ? rec.statuses : {};
  const cleanByEmp = {};
  for (const sid in byEmp) {
    if (!isLoaderById(sid, dbData)) cleanByEmp[sid] = byEmp[sid];
  }
  const cleanStatuses = {};
  let anyStatus = false;
  for (const sid in statuses) {
    if (!isLoaderById(sid, dbData)) { cleanStatuses[sid] = statuses[sid]; anyStatus = true; }
  }
  const clean = {};
  if (Object.keys(cleanByEmp).length > 0) clean.byEmployee = cleanByEmp;
  if (anyStatus) clean.statuses = cleanStatuses;
  return Object.keys(clean).length > 0 ? clean : null;
}

function visibleDays(user, dbData) {
  const ids = moderatorVisibleIds(user, dbData);
  // Модератор всегда видит только дни членов своих групп — даже если по роли
  // он ADMIN (приоритет модераторства), см. visibleStaff.
  if (ids.size === 0 && isAdmin(user, dbData)) {
    // Админ видит все дни, кроме дней погрузчиков (их в табеле нет).
    const out = {};
    for (const key in dbData.days) {
      const clean = dayWithoutLoaders(dbData.days[key], dbData);
      if (clean) out[key] = clean;
    }
    return out;
  }
  const canSeeOthers = ids.size > 0;
  const out = {};
  for (const key in dbData.days) {
    const rec = dbData.days[key];
    if (!canSeeOthers) {
      // A plain member sees only their own day: own segments + own status.
      const byEmp = rec.byEmployee && typeof rec.byEmployee === "object" ? rec.byEmployee : {};
      const own = byEmp[user.id] || null;
      const hasOwn = own && Array.isArray(own.segments) && own.segments.length > 0;
      const myStatus = rec.statuses && rec.statuses[user.id];
      if (!hasOwn && !myStatus) continue;
      const copy = { byEmployee: {} };
      if (hasOwn) copy.byEmployee[user.id] = own;
      if (myStatus) copy.statuses = { [user.id]: myStatus };
      out[key] = copy;
      continue;
    }
    // A moderator sees the days of their group members. Keep only the segments
    // of group members and the statuses of group members.
    const byEmp = rec.byEmployee && typeof rec.byEmployee === "object" ? rec.byEmployee : {};
    const visibleEmp = {};
    for (const sid in byEmp) {
      if (ids.has(sid) && !isLoaderById(sid, dbData)) visibleEmp[sid] = byEmp[sid];
    }
    const statusKeys = rec.statuses && typeof rec.statuses === "object"
      ? Object.keys(rec.statuses).filter((id) => ids.has(id) && !isLoaderById(id, dbData))
      : [];
    if (Object.keys(visibleEmp).length === 0 && statusKeys.length === 0) continue;
    const copy = {};
    if (Object.keys(visibleEmp).length) copy.byEmployee = visibleEmp;
    if (statusKeys.length) {
      copy.statuses = {};
      for (const id of statusKeys) copy.statuses[id] = rec.statuses[id];
    }
    if (Object.keys(copy).length === 0) continue;
    out[key] = copy;
  }
  return out;
}

function visibleLog(user, dbData) {
  // Админу и сотруднику из logUsers журнал отдаём целиком (журнал погрузчиков —
  // только самим погрузчикам, их просто нет в общем учёте). У canSeeLogs "полный
  // журнал" — иначе вкладка «Логи» была бы пустой (рядовому юзеру видны только
  // его собственные записи).
  if (isAdmin(user, dbData) || canSeeLogs(user, dbData)) {
    return dbData.log.filter((e) => !isLoaderById(e && e.ownerId, dbData));
  }
  // A moderator sees the journal entries of their group members (+ their own), so
  // they can audit timer presses, statuses and manual time edits of their people.
  if (isModerator(user, dbData)) {
    const ids = moderatorVisibleIds(user, dbData);
    ids.add(user.id);
    return dbData.log.filter((e) => e.ownerId && ids.has(e.ownerId) && !isLoaderById(e.ownerId, dbData));
  }
  return dbData.log.filter((e) => !e.ownerId || e.ownerId === user.id);
}

// A user whose app access has been closed (deleted / blocked by an admin).
function isBlocked(user, dbData) {
  return (dbData.blocked || []).some((b) => b.id === user.id);
}

// Ensure the current user has a staff record (so the "Я" identity always exists).
function ensureStaffRecord(user) {
  if (isBlocked(user, db)) return false;
  const existing = db.staff.find((s) => s.id === user.id);
  if (!existing) {
    db.staff.push({ id: user.id, name: user.name, salary: null, bonus: null, extraBonus: null });
    return true;
  }
  return false;
}

// ---- Directory sync (portal employees -> "Все сотрудники") ----
// Pulls the real Bitrix24 employee list into db.staff. Existing records keep their
// salary (and any manual `s-*` entries stay). Runs at most once per SYNC_TTL_MS so
// portal rate limits are respected. If the portal key is absent, it silently no-ops.
const SYNC_TTL_MS = 60_000;
let lastSyncAt = 0;
let syncInFlight = null;

function memberName(u) {
  return [u.name, u.lastName, u.secondName].filter(Boolean).join(" ").trim() || `Сотрудник ${u.id}`;
}

async function syncDirectory(force) {
  const now = Date.now();
  if (!syncInFlight && !force && now - lastSyncAt < SYNC_TTL_MS) return null;
  if (!PORTAL_KEY || !PORTAL_BASE) return null;
  if (syncInFlight) return syncInFlight;

  syncInFlight = (async () => {
    let added = 0;
    try {
      const all = [];
      let offset = 0;
      const page = 50;
      let total = null;
      // Gather active intranet employees, capped to keep the request bounded.
      for (let i = 0; i < 20; i += 1) {
        const res = await portal("/users/search", {
          method: "POST",
          body: {
            filter: { active: true, userType: "employee" },
            select: ["id", "name", "lastName", "secondName", "active", "isAdmin", "userType"],
            limit: page,
            offset,
          },
        });
        const list = Array.isArray(res) ? res : [];
        all.push(...list);
        if (total === null && res.meta) total = res.meta.total;
        if (list.length < page) break;
        if (total != null && all.length >= total) break;
        offset += page;
      }

      for (const u of all) {
        if (!u || u.id == null) continue;
        const id = String(u.id);
        if ((db.blocked || []).some((b) => b.id === id)) continue; // keep access closed
        const name = memberName(u);
        const portalAdmin = u.isAdmin === true;
        const existing = db.staff.find((s) => s.id === id);
        if (!existing) {
          db.staff.push({ id, name, salary: null, bonus: null, extraBonus: null, portalAdmin });
          added += 1;
        } else {
          if (name && existing.name !== name) existing.name = name;
          if (existing.portalAdmin !== portalAdmin) existing.portalAdmin = portalAdmin;
        }
      }

      // The portal proxy strips `isAdmin` from /users/search and /users/:id
      // (it is only exposed on /users/me for the key owner). So on its own the
      // loop above can NEVER learn who the portal admins are — portalAdmin stays
      // false for everyone, which breaks admin access on mobile APK sessions
      // where the gateway reports role MEMBER instead of ADMIN. As a reliable,
      // safe fix: query /users/me (the key owner) and, when that owner is a portal
      // admin, auto-appoint that exact id as an app admin. Others are untouched,
      // so no rights are handed out to the whole directory.
      try {
        const me = await portal("/users/me", { method: "GET" });
        if (me && me.isAdmin === true && me.id != null) {
          const ownerId = String(me.id);
          if (!db.admins.includes(ownerId)) db.admins.push(ownerId);
          const ownerRec = db.staff.find((s) => s.id === ownerId);
          if (ownerRec) {
            if (ownerRec.portalAdmin !== true) { ownerRec.portalAdmin = true; added += 1; }
          } else {
            db.staff.push({ id: ownerId, name: me.name || ownerId, salary: null, bonus: null, extraBonus: null, portalAdmin: true });
            added += 1;
          }
        }
      } catch (e) {
        console.error("admin-owner sync failed:", e.message);
      }

      if (added > 0) await persistDb();
    } catch (e) {
      // Portal might be unreachable or the key invalid — leave existing staff untouched.
      console.error("directory sync failed:", e.message);
    }
    lastSyncAt = Date.now();
    syncInFlight = null;
    return added;
  })();

  return syncInFlight;
}


// ---- Static + API router ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

// ================= Excel (.xlsx) export =================
// The platform build cannot guarantee npm access, so the workbook is produced
// entirely with the Node standard library: a tiny Office Open XML spreadsheet +
// a hand-rolled ZIP writer (raw deflate via zlib). No external packages.

// ---- CRC32 (ISO-8859-1 style, as used by ZIP) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function zipEntry(rawName, data) {
  const name = Buffer.from(rawName, "utf8");
  const crc = crc32(data);
  const deflated = require("node:zlib").deflateRawSync(data);
  return {
    name,
    data,
    deflated,
    crc,
    method: 8,
  };
}

function zipBuild(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  const mtime = 0x0000; // no timestamp
  const mdate = 0x21;   // fixed DOS date
  for (const e of entries) {
    const lh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(e.method || 0),
      u16(mtime), u16(mdate), u32(e.crc),
      u32(e.deflated.length), u32(e.data.length),
      u16(e.name.length), u16(0), e.name, e.deflated,
    ]);
    local.push(lh);
    const ch = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0),
      u16(e.method || 0), u16(mtime), u16(mdate), u32(e.crc),
      u32(e.deflated.length), u32(e.data.length),
      u16(e.name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), e.name,
    ]);
    central.push(ch);
    offset += lh.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cd.length), u32(cdStart), u16(0),
  ]);
  return Buffer.concat([...local, cd, eocd]);
}

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

// Shared cell styles: 0 generic, 1 bold header, 2 centered day, 3 bold totals
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="10"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// rows: array of arrays {"v": string|number|null, "s": styleIndex?, "t"?: "s"|"n"}
function sheetXml(rows) {
  let colCount = 0;
  for (const r of rows) colCount = Math.max(colCount, r.length);
  const cols = colCount > 0
    ? `<cols>${Array.from({ length: colCount }, (_, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${i < 2 ? 16 : 6}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = rows.map((r, ri) => {
    const cells = r.map((c, ci) => {
      if (c == null || (typeof c === "string" && c === "")) return "";
      const s = c.s ? ` s="${c.s}"` : "";
      const ref = cellRef(ci, ri);
      if (typeof c.v === "number") {
        // Numeric cell: plain <v> (Excel default type "n").
        return `<c r="${ref}"${s}><v>${c.v}</v></c>`;
      }
      // Text cell: inline string (t="inlineStr"), NOT t="s" (which would mean a
      // sharedStrings index). Writing plain text under t="s" makes Excel reject
      // the whole workbook as corrupt.
      return `<c r="${ref}" t="inlineStr"${s}><is><t>${xmlEsc(c.v)}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function cellRef(ci, ri) {
  let col = "";
  let n = ci;
  while (n >= 0) { col = String.fromCharCode(65 + (n % 26)) + col; n = Math.floor(n / 26) - 1; }
  return `${col}${ri + 1}`;
}

function buildXlsx(sheetRows, title) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${xmlEsc((title || "Табель").slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const entries = [
    zipEntry("[Content_Types].xml", Buffer.from(contentTypes, "utf8")),
    zipEntry("_rels/.rels", Buffer.from(rootRels, "utf8")),
    zipEntry("xl/workbook.xml", Buffer.from(workbook, "utf8")),
    zipEntry("xl/_rels/workbook.xml.rels", Buffer.from(wbRels, "utf8")),
    zipEntry("xl/styles.xml", Buffer.from(STYLES_XML, "utf8")),
    zipEntry("xl/worksheets/sheet1.xml", Buffer.from(sheetXml(sheetRows), "utf8")),
  ];
  return zipBuild(entries);
}

// ---- Оклады/премии/надбавки ПО МЕСЯЦАМ ----
// Значения по месяцам хранятся в db.salaryMonth[staffId][month]. Это позволяет
// менять оклад/надбавку за конкретный месяц, не переписывая другие. Значение за
// месяц, у которого явная запись отсутствует, берётся из «текущего» st.*.
function currentMonthKey(now) {
  now = Number(now) || Date.now();
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function normalizeMonthKey(m) {
  const s = String(m || "").trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s) ? s : currentMonthKey();
}
function prevMonthKey(m) {
  const mm = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(m || ""));
  if (!mm) return "";
  const y = Number(mm[1]); const mo = Number(mm[2]) - 1; // 0-based
  const d = new Date(y, mo - 1, 1); // минус один месяц
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
// Значения за месяц: точная запись → иначе ближайшая ПРЕДШЕСТВУЮЩАЯ запись → иначе «текущие» st.*.
// Так правка за месяц (например, октябрь) не «протекает» в прошлые месяцы без своей записи.
function staffPayForMonth(st, month) {
  const map = db.salaryMonth && db.salaryMonth[st.id];
  const overlay = (rec) => ({
    salary: (rec && rec.salary != null) ? rec.salary : st.salary,
    bonus: (rec && rec.bonus != null) ? rec.bonus : st.bonus,
    extraBonus: (rec && rec.extraBonus != null) ? rec.extraBonus : st.extraBonus,
  });
  if (map) {
    if (map[month]) return overlay(map[month]);
    for (const mKey of Object.keys(map).sort().reverse()) {
      if (String(mKey) < String(month)) return overlay(map[mKey]);
    }
  }
  // Нет записи и нет предшествующей: для ПРОШЕДШЕГО месяца не берём «текущие»
  // значения (октябрьская надбавка не должна попадать в сентябрь). Оклад — как
  // есть, премию/надбавку без явной месячной записи показываем 0.
  if (String(month) < currentMonthKey()) {
    return { salary: st.salary != null ? st.salary : 50000, bonus: 0, extraBonus: 0 };
  }
  return overlay(null);
}
function setStaffPayMonth(st, month, patch) {
  if (!db.salaryMonth) db.salaryMonth = {};
  if (!db.salaryMonth[st.id]) db.salaryMonth[st.id] = {};
  const map = db.salaryMonth[st.id];
  const cur = map[month] || {};
  map[month] = Object.assign({}, cur, patch);
}
// ПРОСТАЯ фиксация «по месяцам»: как только наступает НОВЫЙ месяц (первый вызов
// /api/state в нём), ПРОШЕДШИЙ месяц у каждого сотрудника «замораживается» —
// в salaryMonth[st][прошлый месяц] кладётся текущий оклад/премия/надбавка (как
// они были на момент смены месяца). После этого правки в новом месяце (например,
// надбавка в октябре) НЕ протекают в прошлый. Замороженный месяц больше не меняется.
function maybeFreezePrevMonth() {
  const cur = currentMonthKey();
  if (db.frozenMonth === cur) return;
  const prev = prevMonthKey(cur);
  // Замораживаем прошлый месяц ТОЛЬКО при реальном переходе между месяцами
  // (frozenMonth уже был выставлен ранее). На первом запуске (frozenMonth=null)
  // историю не выдумываем — прошлые месяцы остаются как есть (их можно поправить
  // в редакторе по месяцам), иначе мы бы ошибочно зафиксировали уже изменённое.
  if (prev && db.frozenMonth) {
    if (!db.salaryMonth) db.salaryMonth = {};
    (Array.isArray(db.staff) ? db.staff : []).forEach((st) => {
      if (!db.salaryMonth[st.id]) db.salaryMonth[st.id] = {};
      if (!db.salaryMonth[st.id][prev]) {
        db.salaryMonth[st.id][prev] = { salary: st.salary, bonus: st.bonus, extraBonus: st.extraBonus };
      }
    });
  }
  db.frozenMonth = cur;
}

// ---- Timesheet computation (server replica of the client renderReport) ----
function timesheetRowsForMonth(year, m0, staffList) {
  const staffArr = Array.isArray(staffList) ? staffList : db.staff;
  const daysInMonth = new Date(year, m0 + 1, 0).getDate();
  const norm = Number.isFinite(db.norm) ? db.norm : 8;
  const normDayMs = norm * 3600000;
  const showOver = !db.params || db.params.showOverHours !== false;

  function dayWorkMs(staffId, key) {
    const rec = db.days[key];
    const segs = segmentsFor(staffId, rec);
    return segs
      .filter((s) => s.kind !== "break")
      .reduce((acc, s) => acc + Math.max(0, (s.end == null ? Date.now() : s.end) - s.start), 0);
  }
  // Overtime counts only for a CLOSED day: work segments with an explicit end
  // (set by "Завершить работу" or manually in "Время работы"). Open segments
  // contribute 0, so an accidentally running timer cannot inflate overtime.
  function dayClosedWorkMs(staffId, key) {
    const rec = db.days[key];
    const segs = segmentsFor(staffId, rec);
    return segs
      .filter((s) => s.kind !== "break" && s.end != null)
      .reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);
  }
  function dayStatus(staffId, key, workMs) {
    const rec = db.days[key];
    if (rec && rec.statuses && rec.statuses[staffId]) return rec.statuses[staffId];
    if (workMs >= normDayMs) return "Я";
    if (workMs > 0) return "НД"; // неполный день
    return null;
  }
  function fmtHours(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function fmtMoney(a) { return `${Math.round(a).toLocaleString("ru-RU")} ₽`; }

  const rows = staffArr.map((st) => {
    const dayWork = {};
    let totalMs = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const ms = dayWorkMs(st.id, key);
      dayWork[d] = ms;
      totalMs += ms;
    }
    const dayStatusMap = {};
    const attended = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // Автостатус «Я/НД» считается только по завершённым (закрытым)
      // сегментам: пока таймер запущен (открыт сегмент), день ещё не завершён
      // и статус не проставляется; он появится после «Завершить работу».
      const s = dayStatus(st.id, key, dayClosedWorkMs(st.id, key));
      dayStatusMap[d] = s;
      if (s === "Я") attended.push(d);
    }
    // Overtime accumulates per day: max(0, hours − norm) per worked day. Same
    // fix as the client report — the old totalMs − attended×norm inflated
    // overtime by the hours of partial days that were never flagged "Я".
    let overMs = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const wkKey = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const wk = dayClosedWorkMs(st.id, wkKey);
      if (wk > 0) {
        // Как в браузере: в выходной весь закрытый таймер — переработка, в рабочий —
        // только сверх нормы дня.
        const dow = new Date(year, m0, d).getDay();
        const isWeekend = dow === 0 || dow === 6;
        overMs += isWeekend ? wk : Math.max(0, wk - normDayMs);
      }
    }
    const smKey = year + "-" + String(m0 + 1).padStart(2, "0");
    const payS = staffPayForMonth(st, smKey);
    return {
      id: st.id, name: st.name, salary: payS.salary != null ? payS.salary : 0, bonus: payS.bonus != null ? payS.bonus : 0, extraBonus: payS.extraBonus != null ? payS.extraBonus : 0,
      dayWork, dayStatus: dayStatusMap, totalMs,
      overMs,
      count: attended.length,
    };
  });

  const totalCount = rows.reduce((a, r) => a + r.count, 0);
  const totalOverMs = rows.reduce((a, r) => a + r.overMs, 0);
  const totalSnap = rows.reduce((a, r) => a + r.totalMs, 0);
  // «Оклад» в табеле = оклад + надбавка; переработки считаются от чистого оклада.
  const totalSalary = rows.reduce((a, r) => a + ((r.salary ? r.salary : 0) + (r.extraBonus ? r.extraBonus : 0)), 0);

  // Header: two lines (day number + day-of-week).
  const DOW = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
  const header1 = [{ v: "№", s: 1 }, { v: "Сотрудник", s: 1 }];
  const header2 = [{ v: "", s: 1 }, { v: "", s: 1 }];
  for (let d = 1; d <= daysInMonth; d++) {
    header1.push({ v: String(d).padStart(2, "0"), s: 1 });
    header2.push({ v: DOW[new Date(year, m0, d).getDay()], s: 1 });
  }
  header1.push({ v: "Оклад", s: 1 });
  header2.push({ v: "", s: 1 });
  header1.push({ v: "Премия", s: 1 });
  header2.push({ v: "", s: 1 });
  header1.push({ v: "Отраб. дней", s: 1 });
  header2.push({ v: "", s: 1 });
  if (showOver) {
    header1.push({ v: "Часы", s: 1 });
    header2.push({ v: "", s: 1 });
    header1.push({ v: "Переработка", s: 1 });
    header2.push({ v: "", s: 1 });
  }

  const body = rows.map((r, idx) => {
    const row = [
      { v: idx + 1, t: "n", s: 2 },
      { v: r.name, s: 1 },
    ];
    for (let d = 1; d <= daysInMonth; d++) {
      row.push({ v: r.dayStatus[d] || "", s: 2 });
    }
    row.push({ v: (r.salary + r.extraBonus) ? fmtMoney(r.salary + r.extraBonus) : "", s: 2 });
    row.push({ v: r.bonus ? fmtMoney(r.bonus) : "", s: 2 });
    row.push({ v: r.count, t: "n", s: 2 });
    if (showOver) {
      row.push({ v: fmtHours(r.totalMs), s: 2 });
      row.push({ v: r.overMs > 0 ? fmtHours(r.overMs) : "", s: 2 });
    }
    return row;
  });

  const totals = [{ v: "", s: 3 }, { v: "Итого", s: 3 }];
  for (let d = 1; d <= daysInMonth; d++) {
    const cnt = rows.filter((r) => r.dayStatus[d] === "Я").length;
    totals.push({ v: cnt || "", t: "n", s: 3 });
  }
  totals.push({ v: totalSalary ? fmtMoney(totalSalary) : "", s: 3 });
  totals.push({ v: "", s: 3 });
  totals.push({ v: "", s: 3 });
  if (showOver) {
    totals.push({ v: fmtHours(totalSnap), s: 3 });
    totals.push({ v: totalOverMs > 0 ? fmtHours(totalOverMs) : "", s: 3 });
  }

  return {
    title: `Табель ${String(m0 + 1).padStart(2, "0")}.${year}`,
    sheet: [header1, header2, ...body, totals],
  };
}

// ---- Live presence / timer rows for the admin & moderator Live tab ----
// For every employee the viewer may see: online (fresh heartbeat), whether their
// work timer is running right now (an open segment today), all today's numbers
// (worked, overtime, status, overtime money) plus salary rate.
// Someone is "online" on the Live tab if they pinged within this window. Kept at
// 5 min on purpose: in a background / collapsed tab (or on a phone with the screen
// off) browsers drop setInterval to once a minute or less, so a 2-minute window made
// perfectly healthy people blink off the "В эфире" list. 5 minutes is still clearly
// "live" for a human but survives that throttling.
const ONLINE_WINDOW_MS = 5 * 60 * 1000;

// Множитель подработки для сотрудника на конкретную дату. Повышенный тариф
// ищется по индивидуальным правилам multRules (приоритет: конкретный сотрудник →
// группа → «для всех»), и только если правил нет — по легаси-полям params
// (multiplier/multFrom/multTo/multGroups). Согласовано с клиентским
// multiplierForDate() в app.js. Правило multRules привязано к КОНКРЕТНОЙ дате
// (date YYYY-MM-DD) и интервалу [from, to] (HH:MM): повышенный тариф для живого
// расчёта активен, если date совпадает с датой аргумента И момент времени `date`
// лежит внутри интервала. Без даты правило не применяется.
function serverDayMult(staffId, date) {
  const dbData = db || { params: {} };
  const p = dbData.params || {};
  const rules = Array.isArray(p.multRules) ? p.multRules : [];
  const dayKeyY = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const nowKey = dayKeyY(date);
  const nowMs = date.getTime();
  const timeToday = (t) => {
    const [h, m] = String(t).split(":").map(Number);
    const base = new Date(nowKey + "T00:00:00").getTime();
    return base + ((Number.isFinite(h) ? h : 0) * 3600000 + (Number.isFinite(m) ? m : 0) * 60000);
  };
  const dayMatches = (r) => {
    if (!r || r.mult < 1) return false;
    if (String(r.date || "") !== nowKey) return false; // день обязателен и должен совпадать
    const fromMs = timeToday(r.from);
    const toMs = timeToday(r.to);
    return fromMs <= nowMs && nowMs <= toMs; // сейчас внутри [from, to]
  };
  if (rules.length > 0) {
    const matchFor = (target, test) => {
      const r = rules.find((x) => x.target === target && dayMatches(x) && test(x));
      return r ? r.mult : null;
    };
    // 1) конкретный сотрудник
    const staffRule = matchFor("staff", (x) => String(x.targetId) === String(staffId));
    if (staffRule) return staffRule;
    // 2) группа (первая подходящая группа, где состоит сотрудник)
    const groups = dbData.groups || [];
    const groupRule = matchFor("group", (x) => {
      const g = groups.find((gg) => String(gg.id) === String(x.targetId));
      return g && Array.isArray(g.memberIds) && g.memberIds.includes(String(staffId));
    });
    if (groupRule) return groupRule;
    // 3) «для всех»
    const allRule = rules.find((x) => x.target === "all" && dayMatches(x));
    if (allRule) return allRule.mult;
    return 1;
  }
  // Легаси-fallback на старые params.
  const mg = p.multGroups || [];
  const inMultGroup = mg.length === 0 || mg.some((gid) => {
    const g = (dbData.groups || []).find((x) => String(x.id) === String(gid));
    return g && Array.isArray(g.memberIds) && g.memberIds.includes(String(staffId));
  });
  let mult = Number.isFinite(p.multiplier) && p.multiplier >= 1 ? p.multiplier : 1;
  if (mult <= 1 || !inMultGroup) return 1;
  if (p.multFrom && p.multTo) {
    const d0 = new Date(date); d0.setHours(0, 0, 0, 0);
    const from = new Date(p.multFrom + "T00:00:00");
    const to = new Date(p.multTo + "T23:59:59");
    if (!(from <= d0 && d0 <= to)) return 1;
  }
  return mult;
}

// Логирует событие сборки накладной в Журнал (action = "waybill"): клиент точки,
// время, артикул, наименование и кол-во позиции. Пометка «не найдено» тоже пишется
// (scanned сохраняет текущее значение для первичного скана).
function logWaybillScan(route, clientIndex, item, missing, body, user) {
  const scanLogLimit = Number(db.params && db.params.scanLogLimit) || 30000;
  db.scanLog = db.scanLog || [];
  const cl = route.clients && route.clients[clientIndex];
  const clientName = (cl && (cl.client || cl.bundleName || cl.address)) || "";
  db.scanLog.push({
    ts: Date.now(),
    action: "waybill",
    userId: user.id != null ? String(user.id) : null,
    userName: (user.name != null ? String(user.name) : ""),
    client: String(clientName || "").slice(0, 120),
    bundleName: String((cl && cl.bundleName) || "").slice(0, 120),
    members: Array.isArray(cl && cl.members)
      ? cl.members.map((m) => String(m.client || m.address || "").slice(0, 80)).filter(Boolean).slice(0, 50)
      : [],
    code: String(item.art || ""),
    partsticker: String((item && item.partsticker) || ""),
    name: String(item.name || "").slice(0, 200),
    qty: Number(item.qty) || 0,
    missing: !!missing,
    // Бокс в журнал: из item.box, а если пуст — из тела скана (body.box). Так
    // деталь, отсканированная при активном боксе, никогда не «теряет» бокс и не
    // попадает в группу «без бокса» из-за рассинхрона.
    box: String(item.box || (body && body.box) || "").slice(0, 60),
  });
  if (db.scanLog.length > scanLogLimit) db.scanLog = db.scanLog.slice(-scanLogLimit);
}

function listWaybillBoxes(route, clientIndex) {
  const wb = route && route.waybills && route.waybills[clientIndex];
  const items = wb && Array.isArray(wb.items) ? wb.items : [];
  const boxes = [];
  const seen = new Set();
  const detailByBox = {};
  items.forEach((it) => {
    if (!it.box) return;
    if (!detailByBox[String(it.box)]) detailByBox[String(it.box)] = 0;
    if ((Number(it.scanned) || 0) > 0) detailByBox[String(it.box)] += 1;
  });
  // В список попадают ТОЛЬКО настоящие боксы — созданные/напечатанные этикетки
  // мест (db.labels). Значения it.box, которые не являются настоящими боксами
  // (например, ошибочно записанные артикулы), в список НЕ включаем.
  if (route && db && Array.isArray(db.labels)) {
    db.labels.forEach((l) => {
      if (String(l.routeId) !== String(route.id) || Number(l.clientIndex) !== Number(clientIndex)) return;
      if (!l.code || seen.has(String(l.code))) return;
      seen.add(String(l.code));
      boxes.push({ box: String(l.code), details: detailByBox[String(l.code)] || 0 });
    });
  }
  // Боксы, к которым привязаны детали (it.box), но у которых НЕТ этикетки/места
  // в db.labels (например: "механический" бокс, подписанный маркером; стикер
  // потерян; печать не создала запись). Сервер уже хранит деталь в этом боксе,
  // но раньше не отдавал его фронту — скан «Бокс N» не активировал бокс, и деталь
  // в него нельзя было положить («боксы не всегда выбираются»). Включаем такие
  // боксы в список, чтобы фронт мог выбрать их сканом и продолжить привязку.
  items.forEach((it) => {
    if (!it.box) return;
    const code = String(it.box);
    if (seen.has(code)) return;
    // Ограничиваем: считаем боксом только валидный код места маршрута (BG<routeId>-…),
    // а не случайную строку/артикул. «Механические» боксы сборщики подписывают
    // кодом места того же формата.
    if (!/^BG[^-]+-\d+(-\d+)?$/.test(code)) return;
    seen.add(code);
    boxes.push({ box: code, details: detailByBox[code] || 0 });
  });
  return boxes;
}

// Удаляет этикетки мест маршрута (боксы), в которые НЕ привязана ни одна
// СОБРАННАЯ деталь (scanned>0). Склад часто печатает/создаёт бокс, но деталей в
// него не кладёт; такие пустые боксы не должны попадать в отгрузку («нет деталей
// в боксе») и остаются после «Завершить сборку». Чистим по всему маршруту — на
// момент начала отгрузки все клиенты уже готовы, поэтому убирать безопасно.
function purgeEmptyBoxes(route, db) {
  if (!route || !db || !Array.isArray(db.labels)) return;
  const used = new Set();
  const wbs = route.waybills && typeof route.waybills === "object"
    ? Object.values(route.waybills)
    : [];
  wbs.forEach((wb) => {
    (Array.isArray(wb && wb.items) ? wb.items : []).forEach((it) => {
      const box = String(it.box || "");
      if (box && (Number(it.scanned) || 0) > 0) used.add(box);
    });
  });
  db.labels = db.labels.filter((l) =>
    !(String(l.routeId) === String(route.id) && !used.has(String(l.code || "")))
  );
}

// ---- Расходная накладная (xlsx) — разбор без внешних пакетов ----
// xlsx = zip-архив с XML (sharedStrings.xml + worksheets/sheet1.xml). Парсим
// вручную: распаковываем только нужные записи (zlib.inflateRawSync), извлекаем
// строки из листа, подставляя общие строки. Ожидаемые колонки: артикул,
// наименование, кол-во (первая строка — заголовок).

function zipRead(buf, targetPath) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);
  let pos = cdStart;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (name === targetPath) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.slice(dataStart, dataStart + compSize);
      try {
        return method === 0 ? comp : require("zlib").inflateRawSync(comp);
      } catch { return null; }
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function xlsxText(s) {
  const out = [];
  let m;
  const re = /<t[^>]*>([^<]*)<\/t>|<v[^>]*>([^<]*)<\/v>/g;
  while ((m = re.exec(s)) !== null) out.push(m[1] || m[2] || "");
  return out.join("");
}

function xlsxColIndex(letter) {
  let n = 0;
  const s = String(letter || "").toUpperCase();
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

// Извлекает поле вида «Покупатель: …» из строк xlsx (контрагент в расходной
// накладной). Значение может стоять в той же ячейке после «:» либо правее
// (в объединённой ячейке). Возвращает строку или "".
function extractXlsxField(rows, labelRe, cellVal) {
  for (const row of rows) {
    const cells = row.cells;
    for (const col in cells) {
      const t = String(cellVal(cells[col])).trim();
      const m = labelRe.exec(t);
      if (!m) continue;
      const rest = t.slice(m[0].length).replace(/^[\s:]+/, "").trim();
      if (rest) return rest;
      let best = "", bestIdx = -1;
      const baseIdx = xlsxColIndex(col);
      for (const c2 in cells) {
        const ic = xlsxColIndex(c2);
        if (ic > baseIdx) {
          const v = String(cellVal(cells[c2])).trim();
          if (v && ic > bestIdx) { best = v; bestIdx = ic; }
        }
      }
      return best;
    }
  }
  return "";
}

function parseXlsxItems(buf) {
  const shared = zipRead(buf, "xl/sharedStrings.xml");
  const sheet = zipRead(buf, "xl/worksheets/sheet1.xml") || zipRead(buf, "xl/worksheets/sheet.xml");
  if (!sheet) return { items: [], error: "Внутри xlsx не найден лист" };
  const sharedStrings = [];
  if (shared) {
    const re = /<si>(.*?)<\/si>/gs;
    let m;
    while ((m = re.exec(String(shared))) !== null) sharedStrings.push(xlsxText(m[1]));
  }

  // Разбираем лист в список строк { cells: {col: {t, v}} } — с типом ячейки
  // (s=общая строка, n=число, inlineStr и т.п.) и сырым значением.
  const rowRe = /<row[^>]*>(.*?)<\/row>/gs;
  const stringsByRow = [];
  let rowMatch;
  const cellVal = (c) => {
    if (!c) return "";
    if (c.t === "s") return sharedStrings[Number(c.v)] != null ? sharedStrings[Number(c.v)] : "";
    return String(c.v != null ? c.v : "");
  };
  while ((rowMatch = rowRe.exec(String(sheet))) !== null) {
    const rowXml = rowMatch[1];
    const cells = {};
    const cellParts = rowXml.split("<c ");
    for (let ci = 1; ci < cellParts.length; ci++) {
      const part = cellParts[ci];
      const rM = /r="([A-Z]+)[0-9]+"/.exec(part);
      if (!rM) continue;
      const col = rM[1];
      const tM = /t="([^"]*)"/.exec(part);
      const type = tM ? tM[1] : "";
      let val = "";
      const vM = /<v>([^<]*)<\/v>/.exec(part);
      const isM = /<is>([\s\S]*?)<\/is>/.exec(part);
      if (vM) val = vM[1];
      else if (isM) {
        const t = /<t[^>]*>([^<]*)<\/t>/.exec(isM[1]);
        val = t ? t[1] : "";
      }
      cells[col] = { t: type, v: val };
    }
    stringsByRow.push({ cells });
  }

  // Определяем колонки по заголовкам: ищем строку, где в разных ячейках стоят
  // «Артикул», «Товар», «Количество». Это устойчиво к разнесённой вёрстке 1С.
  const headerRow = stringsByRow.find(({ cells }) =>
    Object.values(cells).some((c) => String(cellVal(c)).trim() === "Артикул")
  );
  let colArt = "B", colName = "C", colQty = "D";
  if (headerRow) {
    for (const col in headerRow.cells) {
      const txt = String(cellVal(headerRow.cells[col])).trim();
      if (txt === "Артикул") colArt = col;
      else if (txt === "Товар" || txt === "Наименование") colName = col;
      else if (/Кол-во|Количество/i.test(txt)) colQty = col;
    }
  }

  const items = [];
  const afterHeader = headerRow
    ? stringsByRow.slice(stringsByRow.indexOf(headerRow) + 1)
    : stringsByRow;
  const buyer = extractXlsxField(stringsByRow, /^Покупатель\s*:/i, cellVal);
  for (const { cells } of afterHeader) {
    const art = String(cellVal(cells[colArt])).trim();
    const name = String(cellVal(cells[colName])).trim();
    const qtyRaw = String(cellVal(cells[colQty])).trim().replace(",", ".");
    if (!art || !Number.isFinite(parseFloat(qtyRaw)) || parseFloat(qtyRaw) <= 0) continue;
    if (/Всего наименований/i.test(name) || /^Отпустил/i.test(name) || /^Получил/i.test(name)) continue;
    let cleanName = name;
    if (cleanName.startsWith(art + " ") || cleanName.startsWith(art + "•") || cleanName.startsWith(art + "\t")) {
      cleanName = cleanName.slice(art.length).replace(/^[\s\p{P}\p{S}]+/u, "").trim();
    }
    items.push({ art, name: (cleanName || name), qty: parseFloat(qtyRaw), scanned: 0 });
  }
  if (!items.length) {
    return { items, error: "Не удалось найти строки с артикулом. Проверьте, что в накладной есть колонки «Артикул», «Товар», «Количество»." };
  }
  return { items, buyer };
}

// ---- Интеграция с 1С (HTTP-сервис): автоподтягивание расходных накладных ----
// Кириллические «двойники» латиницы (А/А, В/В, С/С и т.п.) — из-за раскладки
// скан/ввод дают русские буквы, а артикул в накладной — латиница (или наоборот).
// Сводим их к латинице при сравнении.
const RU_LOOK = {
  "А": "A", "а": "a", "В": "B", "в": "b", "С": "C", "с": "c",
  "Е": "E", "е": "e", "К": "K", "к": "k", "М": "M", "м": "m",
  "Н": "H", "н": "h", "О": "O", "о": "o", "Р": "P", "р": "p",
  "Т": "T", "т": "t", "У": "Y", "у": "y", "Х": "X", "х": "x",
  "І": "I", "і": "i"
};
// Приводит артикул к каноническому виду для сравнения: убирает разделители и
// сводит кириллических «двойников» латиницы. Применяется одинаково к стикеру и артикулам.
function artNorm(s) {
  const t = String(s == null ? "" : s);
  const tr = t.replace(/[АаВвСсЕеКкМмНнОоРрТтУуХхІі]/g, (c) => RU_LOOK[c] || c);
  return tr.replace(/[\s_.\-,:/;\\]/g, "");
}

// Доступ настраивается переменными окружения сервера:
//   ONEC_API_URL  — адрес HTTP-сервиса 1С (например https://1c.company.ru/hs/biotime)
//   ONEC_API_KEY  — ключ/токен доступа (не уходит в браузер)
// Пока интеграция не настроена (нет ONEC_API_URL) — функции ведут себя как «ничего
// не нашлось» и маршрут создаётся по-старому (ручная загрузка накладных).
// Формат ответа 1С (предполагаемый контракт):
//   GET {url}/realizations?inn=<ИНН>
//   -> [ { id, number, taken: false, items: [{ article, name, qty }] } ]  (или { realizations: [...] })
function innForClient(routeClient, dbData) {
  // Приоритет — АКТУАЛЬНАЯ карточка контрагента (db.driverClients): там ИНН может
  // измениться после создания маршрута, а копия в точке маршрута — устареть
  // (раньше вся партия разноса брала один общий ИНН из первых точек маршрута).
  // Точка маршрута остаётся фолбэком только если контрагента в карточке нет.
  const byName = (dbData && dbData.driverClients || []).find(
    (c) => String(c.client) === String(routeClient && routeClient.client)
  );
  if (byName && String(byName.inn || "").trim()) {
    return String(byName.inn).trim();
  }
  if (routeClient && String((routeClient && routeClient.inn) || "").trim()) {
    return String(routeClient.inn).trim();
  }
  return "";
}

// Буквенный логин контрагента в 1С (нужен для сопоставления реализации).
function loginForClient(routeClient, dbData) {
  const byName = (dbData && dbData.driverClients || []).find(
    (c) => String(c.client) === String(routeClient && routeClient.client)
  );
  if (byName && String(byName.login || "").trim()) {
    return String(byName.login).trim();
  }
  if (routeClient && String((routeClient && routeClient.login) || "").trim()) {
    return String(routeClient.login).trim();
  }
  return "";
}

async function fetchOnecRealization(inn, login) {
  const innV = String(inn || "").trim();
  const loginV = String(login || "").trim();
  const url = String(process.env.ONEC_API_URL || "").trim().replace(/\/+$/, "");
  const logEvt = (partial) => {
    pushOnecPullLog(Object.assign({ source: "auto", inn: innV, login: loginV }, partial));
  };
  if (!url) {
    logEvt({ ok: false, reason: "no_url", message: "ONEC_API_URL не настроен" });
    return null;
  }
  if (!innV) {
    logEvt({ ok: false, reason: "no_inn", message: "у контрагента не заполнен ИНН" });
    return null;
  }
  // Авторизация у реального HTTP-сервиса 1С — базовая (логин/пароль), как в
  // наших .env ONEC_API_USER / ONEC_API_PASS. Легаси X-Api-Key не используется.
  const user = String(process.env.ONEC_API_USER || "").trim();
  const pass = String(process.env.ONEC_API_PASS || "").trim();
  const target = /\/shipment$/.test(url) ? url : url + "/shipment";
  const auth = (user || pass) ? "Basic " + Buffer.from(user + ":" + pass).toString("base64") : "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
      res = await fetch(target, {
        method: "POST",
        headers: Object.assign(
          { Accept: "application/json", "Content-Type": "application/json" },
          auth ? { Authorization: auth } : {}
        ),
        body: JSON.stringify({ inn: innV, login: loginV }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) {
      const st = res ? res.status : "?";
      logEvt({ ok: false, reason: "http_" + st, message: "1С вернула HTTP " + st });
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data) {
      logEvt({ ok: false, reason: "bad_json", message: "1С вернула не-JSON ответ" });
      return null;
    }
    // Реальный ответ 1С: { shipment_number, inn, id_partstiker_list: [{id_partstiker, quantity}] }
    // (может прийти и массивом). Нормализуем в список накладных.
    const arr = Array.isArray(data) ? data : [data];
    for (const d of arr) {
      // Каждая накладная несёт поле inn (кому принадлежит). Забираем её только
      // если это ИНН запрошенного контрагента (или поле не указано). Иначе
      // общий список 1С «прилипал» к первому запросившему — все накладные
      // уходили в одного клиента.
      const docInn = String((d && (d.inn != null ? d.inn : "")) || "").trim();
      if (docInn && docInn !== innV) continue;
      const list = Array.isArray(d && d.id_partstiker_list)
        ? d.id_partstiker_list
        : (Array.isArray(d && d.items) ? d.items : []);
      const items = list
        .map((it) => {
          const part = String((it && (it.id_partstiker || it.partsticker)) || "").trim();
          const art = String((it && (it.articul_number || it.article || it.art)) || "").trim() || part;
          const shipmentQty = Number(it && it.shipment_quantity != null ? it.shipment_quantity : (it.quantity != null ? it.quantity : it.qty));
          // Без партстикера количество берём из shipment_quantity целиком.
          let partQty = Number(it && it.quantity != null ? it.quantity : shipmentQty);
          if (!part) partQty = Number.isFinite(shipmentQty) ? shipmentQty : partQty;
          const rawName = String((it && (it.name || it.наименование || it.id_partstiker)) || "").trim();
          return {
            art,
            name: cleanPartstickerName(rawName, art),
            qty: partQty > 0 ? partQty : 1,                 // цель строки (= shipment_quantity без партстикера)
            scanned: 0,
            missing: false,
            partsticker: part,                              // храним внутри (не выводим)
            partQty: partQty > 0 ? partQty : 1,
            shipmentQty: shipmentQty > 0 ? shipmentQty : 1, // контроль всей отгрузки артикула
          };
        })
        .filter((it) => it.art);
      if (!items.length) continue;
      const number = String((d && (d.shipment_number || d.number || d.номер)) || "").trim();
      // Успешный забор в журнал пишет ТОЛЬКО кнопочный запрос (from-1c, единый
      // формат «забрано накладных: N»). Автоматический забор (autoPull при
      // создании/заполнении маршрута) здесь НЕ дублирует ok-строку — иначе на
      // одного клиента в «Логи 1C» падает по 2 строки («забрано накладных» +
      // «забрана накладная»). Ошибки и «пусто» авто-забора логируются через
      // logEvt выше — их видно.
      return {
        id: number || String((d && d.id) || ""),
        number,
        items,
      };
    }
    logEvt({ ok: false, reason: "empty", message: "1С не вернула накладных по этому ИНН/логину" });
    return null;
  } catch {
    logEvt({ ok: false, reason: "err", message: "ошибка запроса к 1С (timeout/сеть)" });
    return null;
  }
}

// Журнал заборов из 1С (показывается админу в «Маршрутизация → Логи 1С»).
// Хранится в файле /data и переживает передеплой/рестарт (не только в памяти).
const ONEC_PULL_LOG_FILE = path.join(DATA_DIR, "onec-pull-log.json");
function loadOnecPullLog() {
  try {
    if (fs.existsSync(ONEC_PULL_LOG_FILE)) {
      const arr = JSON.parse(fs.readFileSync(ONEC_PULL_LOG_FILE, "utf8"));
      if (Array.isArray(arr)) return arr;
    }
  } catch { /* пусто */ }
  return [];
}
const onecPullLog = loadOnecPullLog();
let onecLogSaveTimer = null;
function saveOnecPullLog() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = ONEC_PULL_LOG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(onecPullLog));
    fs.renameSync(tmp, ONEC_PULL_LOG_FILE);
  } catch { /* не критично */ }
}
// Старые записи журнала могли сохраниться без id (до добавления). Проставляем им
// id при старте, чтобы кнопка «Удалить из лога» работала и для них.
{
  let needSave = false;
  onecPullLog.forEach((e) => { if (e && !e.id) { e.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); needSave = true; } });
  if (needSave) saveOnecPullLog();
}
function pushOnecPullLog(entry) {
  const id = (entry && entry.id) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  onecPullLog.push(Object.assign({ id, ts: Date.now() }, entry));
  if (onecPullLog.length > 300) onecPullLog.shift();
  if (!onecLogSaveTimer) {
    onecLogSaveTimer = setTimeout(() => { onecLogSaveTimer = null; saveOnecPullLog(); }, 600);
  }
}
function getOnecPullLog() { return onecPullLog.slice(); }
function deleteOnecPullLog(id) {
  const i = onecPullLog.findIndex((e) => String(e && e.id) === String(id));
  if (i < 0) return false;
  onecPullLog.splice(i, 1);
  saveOnecPullLog();
  return true;
}

// Наименование из 1С часто начинается с артикула («5825437000 РЕГУЛЯТОР …»).
// Вычленяем ведущий артикул и убираем его, оставляя только текстовое наименование.
function cleanPartstickerName(rawName, art) {
  let n = String(rawName || "").trim();
  const a = String(art || "").trim();
  if (a) {
    // Убираем артикул, где бы он ни встретился в наименовании (в начале/середине/конце)
    // — и ведущий, и хвостовой («Разъем 8206673202» → «Разъем»).
    const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    n = n.replace(new RegExp(esc, "gi"), " ");
    n = n.replace(/\s+/g, " ").trim();
  }
  // Убираем скобочный суффикс («…[ORG]» и т.п.) — остаётся чистое наименование.
  const m = n.match(/^(.*?)\s*\[[^\]]*\]\s*$/);
  if (m && m[1]) n = m[1].trim();
  return n || String(rawName || "").trim();
}

// Заполняет накладные маршрута для клиентов, у которых есть ИНН и нет ещё накладной.
async function autoPullWaybillsFrom1c(clients, waybillsArr, dbData) {
  if (!Array.isArray(clients)) return;
  if (!String(process.env.ONEC_API_URL || "").trim()) return; // 1С не настроена — пропускаем
  const have = new Set();
  for (const w of waybillsArr) if (w && w.items && w.items.length) have.add(w.clientIndex);
  for (let i = 0; i < clients.length; i++) {
    if (have.has(i)) continue;
    const inn = innForClient(clients[i], dbData);
    if (!inn) continue;
    const login = loginForClient(clients[i], dbData);
    const doc = await fetchOnecRealization(inn, login);
    if (doc && doc.items && doc.items.length) {
      waybillsArr.push({ clientIndex: i, items: doc.items, buyer: String(doc.number || "") });
      have.add(i);
    }
  }
}

function liveRows(actor, dbData) {
  const staff = visibleStaff(actor, dbData);
  const now = Date.now();
  const normDayMs = (Number.isFinite(dbData.norm) ? dbData.norm : 8) * 3600000;
  const key = dayKey(now);
  const rec = dbData.days[key];
  const lastSeen = dbData.lastSeen || {};

  return staff.map((st) => {
    // Today's work time for this employee.
    let workedMs = 0;
    let openStart = null;
    for (const s of segmentsFor(st.id, rec)) {
      if (s.kind === "break") continue;
      workedMs += Math.max(0, (s.end == null ? now : s.end) - s.start);
      if (s.end == null) openStart = s.start;
    }
    // Живая переработка для «В эфире»: считается на текущий момент, включая
    // открытый (не завершённый) сегмент — диспетчер видит и часы, и сумму уже
    // сейчас, пока таймер идёт. Осознанное отличие от табеля/отчёта, где
    // переработка считается только по закрытому дню.
    const overMs = workedMs > 0 ? Math.max(0, workedMs - normDayMs) : 0;
    const status = (rec && rec.statuses && rec.statuses[st.id])
      || (workedMs >= normDayMs ? "Я" : (workedMs > 0 ? "НД" : null));
    const online = !!lastSeen[st.id] && (now - lastSeen[st.id]) < ONLINE_WINDOW_MS;
    // Overtime money from the monthly salary rate (server replica of the client calc).
    const m0 = new Date(now).getMonth();
    const year = new Date(now).getFullYear();
    const bizDays = businessDays(year, m0);
    const rateBaseH = bizDays * 8; // hourly rate always uses the 8-hour day base (оклад / 8)
    const rate = st.salary != null && st.salary > 0 && rateBaseH > 0 ? st.salary / rateBaseH : 0;
    // Множитель подработки для «сегодня» — согласован с клиентским
    // multiplierForDate(): ищет сначала индивидуальные правила multRules
    // (сотрудник → группа → для всех), а при их отсутствии — легаси-params.
    const mult = serverDayMult(st.id, new Date());
    const canShow = dbData.params ? dbData.params.showOverSum !== false : true;
    const overEarn = canShow ? (overMs / 3600000) * rate * mult : 0;
    return {
      id: st.id,
      name: st.name,
      online,
      timerOn: openStart != null,
      openStart,
      workedMs,
      overMs,
      status,
      rate,
      overEarn,
      salary: st.salary != null ? st.salary : null,
    };
  });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---- Производственный календарь РФ (серверная копия) ----
// Рабочие дни месяца = пн–пт минус праздничные нерабочие будни, плюс
// перенесённые рабочие субботы. Праздник, выпавший на вых., не отнимает день.
const RUS_HOLIDAYS = {
  0: [1, 2, 3, 4, 5, 6, 7, 8],  // новогодние каникулы + Рождество
  1: [23],                       // День защитника Отечества
  2: [8],                        // 8 Марта
  3: [1, 2],                     // Праздник Весны и Труда
  4: [9],                        // День Победы
  5: [12],                       // День России
  10: [4],                       // День народного единства
};
const RUS_SHIFTS = {
  "2026-1":  { add: [3],  off: [9] },
  "2026-12": { add: [],   off: [31] },
  "2027-1":  { add: [2],  off: [] },
  "2027-2":  { add: [20], off: [22] },
  "2027-11": { add: [],   off: [5] },
  "2027-12": { add: [],   off: [31] },
};
function businessDays(year, m0) {
  let count = 0;
  const days = new Date(year, m0 + 1, 0).getDate();
  const shift = RUS_SHIFTS[`${year}-${m0 + 1}`] || { add: [], off: [] };
  const holidays = RUS_HOLIDAYS[m0] || [];
  for (let d = 1; d <= days; d++) {
    const dow = new Date(year, m0, d).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = holidays.includes(d);
    if (isWeekend && shift.add.includes(d)) { count++; continue; }
    if (isWeekend) continue;
    if (isHoliday && !shift.off.includes(d)) continue;
    if (shift.off.includes(d)) continue;
    count++;
  }
  return count;
}

// ---- Собственная авторизация (логин/пароль) ----
// Выделена из общей цепочки маршрутов handleApi в отдельную функцию: это связный
// блок (вход/выход/смена пароля/masquerade/me). Логика перенесена дословно —
// поведение не меняется. Возвращает true, если маршрут распознан и ответ уже
// отправлен, иначе false (тогда handleApi продолжает обычную цепочку).
// ---- Собственная авторизация (логин/пароль) ----
// Реализация вынесена в routes/auth.js. Сессии/пароли/утилиты — инъекцией.
const handleAuthRoutes = require("./routes/auth")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  staffByFio,
  staffById,
  staffByLogin,
  hashPassword,
  createSession,
  setAuthCookie,
  clearAuthCookie,
  cookieValue,
  SESSIONS,
  sessionUserFromCookie,
  identity,
  namesMatch,
  verifyPassword,
  loginRate,
  saveSessionsToDisk,
  AUTH_COOKIE,
});

// ---- Реальный публичный IP, под которым приложение выходит в интернет ----
// Браузер сам такие данные не видит, поэтому их определяет сервер: запрашиваем
// внешний «echo-IP» сервис, кэшируем на 10 минут и по возможности пробуем
// несколько источников. Если ни один не ответил — возвращаем null (клиент
// покажет запасной вариант — адрес приложения). Чистых прав это не трогает.
let publicIpCache = { ip: null, ts: 0 };
const PUBLIC_IP_TTL_MS = 10 * 60 * 1000;
async function resolvePublicIp() {
  const now = Date.now();
  if (publicIpCache.ip && now - publicIpCache.ts < PUBLIC_IP_TTL_MS) {
    return publicIpCache.ip;
  }
  const sources = [
    "https://api.ipify.org?format=json",
    "https://ifconfig.me/ip",
  ];
  for (const src of sources) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3500);
      let res;
      try {
        res = await fetch(src, { signal: ctl.signal });
      } finally {
        clearTimeout(to);
      }
      if (!res || !res.ok) continue;
      const text = await res.text();
      let ip = null;
      try {
        const j = JSON.parse(text);
        if (j && typeof j === "object" && j.ip) ip = String(j.ip);
      } catch { /* не JSON */ }
      if (!ip) {
        const m = String(text).trim();
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(m)) ip = m;
      }
      if (ip) {
        publicIpCache = { ip, ts: now };
        return ip;
      }
    } catch { /* пробуем следующий источник */ }
  }
  return null;
}

// ---- Версия/состояние приложения и конфиг карты ----
// Реализация вынесена в routes/app.js (там же единственная константа WEB_BUILD).
const handleAppRoutes = require("./routes/app")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  writeVersionSource,
  readVersionSource,
  fetchRemoteApkVersion,
  yandexMapsKey: YANDEX_MAPS_KEY,
  resolvePublicIp,
  pushOnecPullLog,
  getOnecPullLog,
  deleteOnecPullLog,
});

// ---- Управление группами (админ) ----
// Связный блок: GET/POST /api/groups и PUT/DELETE /api/groups/:id.
// Реализация вынесена в отдельный модуль routes/groups.js (см. там) — здесь
// только сборка зависимостей. db читается через getter, т.к. переменная может
// переустанавливаться (восстановление из бэкапа).
const handleGroupsRoutes = require("./routes/groups")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
});

// ---- Сохранение параметров приложения (админ) ----
// Реализация вынесена в modules routes/params.js.
const handleParamsRoutes = require("./routes/params")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  keepGroupParamIds,
  keepStaffParamIds,
});

// ---- Резервное копирование (админ) ----
// Связный блок: GET /api/admin/backup, /backup/app, /backup/auto (download),
// POST /backup/restore. Перенесён дословно из handleApi.
// Реализация вынесена в routes/backup.js. БД передаётся геттером+сеттером
// (restore заменяет db целиком).
const handleBackupRoutes = require("./routes/backup")({
  getDb: () => db,
  setDb: (nd) => { db = nd; },
  persistDb,
  sendJson,
  readBody,
  DATA_DIR,
  BACKUP_DIR,
  BACKUP_KEEP,
  BACKUP_EVERY_MS,
  dayKey,
  listAutoBackups,
  migrateDays,
  normalizeGroup,
  collectExtraBackup,
  applyExtraBackup,
});

// ---- Отгрузка маршрутов (склад) ----
// Связный блок: GET /api/shipments, /complete, /reopen, /start, /selfpickup-done.
// Реализация вынесена в routes/shipments.js.
const handleShipmentRoutes = require("./routes/shipments")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  canSeeShipment,
  canManageShipment,
  alignWaybillsToClients,
  withResolvedBundleNames,
  normalizeRouteProgress,
  purgeEmptyBoxes,
  getOnecPullLog,
});
// «Проблемы со склада» (/api/notfound).
const handleNotfoundRoutes = require("./routes/notfound")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  canSeeNotfound,
  alignWaybillsToClients,
  persistNotFoundStatuses,
  isAdmin,
});
// Геолокация водителей (/api/drivers/location).
const handleLocationRoutes = require("./routes/location")({
  getDb: () => db,
  sendJson,
  readBody,
  isDriver,
  isDriversGroupOnly,
  motionDayKey,
  tracksByDay,
  scheduleTracksSave,
  reverseGeocode,
});
// GPS-следы водителей (/api/drivers/tracks и /tracks/snapped).
const handleTracksRoutes = require("./routes/tracks")({
  getDb: () => db,
  sendJson,
  isDriver,
  motionDayKey,
  tracksByDay,
  snappedTracks,
  snapTrackToRoads,
  scheduleSnappedSave,
});
// Гео-маршрутизация по дорогам через FreeRoute (/api/geo/route-from-track).
const handleGeoRoutes = require("./routes/geo")({
  getDb: () => db,
  sendJson,
  readBody,
});
// Дашборд движения водителей (/api/drivers/motion).
const handleMotionRoutes = require("./routes/motion")({
  getDb: () => db,
  sendJson,
  withResolvedBundleNames,
  haversineKm,
  motionDayKey,
  tracksByDay,
});
// Журнал сканов деталей (/api/logs/barcode).
const handleLogsRoutes = require("./routes/logs")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  appendBarcodeLog,
  readBarcodeLogs,
  fs,
  path,
  BCODE_ARCHIVE_DIR,
});
// Маршруты водителя (/api/drivers/routes*).
const handleDriverRoutes = require("./routes/driver-routes")({
  getDb: () => db,
  sendJson,
  readBody,
  isDriver,
  namesMatch,
  enrichUnloadProgress,
  withResolvedBundleNames,
  normalizeRouteProgress,
  routeKmCache,
  routeKmRoad,
  routeKm,
  routeKmPending,
});
// Журнал сканирования мест (/api/scanlog).
const handleScanlogRoutes = require("./routes/scanlog")({
  getDb: () => db,
  sendJson,
});
// Этикетки отгрузки и скан мест (/api/labels*).
const handleLabelsRoutes = require("./routes/labels")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  canSeeShipment,
  isDriver,
});
// Расходные накладные (/api/routes/:id/waybill*, /api/waybill/parse).
const handleWaybillRoutes = require("./routes/waybill")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  parseXlsxItems,
  logWaybillScan,
  artNorm,
  listWaybillBoxes,
  isAdmin,
  isModerator,
});
// Создание/настройка маршрутов (/api/drivers/routes POST, unlock, optimize, route-km, base-km).
const handleRouteCreateRoutes = require("./routes/route-create")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  normalizeRouteClient,
  routeLockReason,
  autoPullWaybillsFrom1c,
  relinkRouteLabels,
  canManageShipment,
  withResolvedBundleNames,
  normalizeRouteProgress,
  routeKmCache,
  routeKmPending,
  ensureClientCoords,
  geocodeAddress,
  gisDurationMatrix,
  tomtomDurationMatrix,
  osrmDurationMatrix,
  nearestByTime,
  nearestNeighbor,
  gisDistanceMatrix,
  haversineKm,
});
// Действия водителя по маршруту (/api/drivers/routes/action).
const handleRouteActionRoutes = require("./routes/route-action")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  enrichUnloadProgress,
  withResolvedBundleNames,
  normalizeRouteProgress,
  segmentsFor,
  allowIncompleteFinish,
  unloadCounts,
  relinkRouteLabels,
  relinkRouteWaybills,
});
// Сотрудники: создание/оклады/премии/удаление/блокировка (/api/staff*).
const handleStaffRoutes = require("./routes/staff")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  crypto,
  setStaffPayMonth,
  normalizeMonthKey,
  purgeStaffFromGroups,
});
// Восстановление «потерянных» офлайн-закрытий водителя (/api/admin/restore-client-close).
const handleRestoreCloseRoutes = require("./routes/restore-close")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
});
// Справочник клиентов для маршрутов (/api/drivers/clients, /api/clients/:id/logo*).
const handleDriverClientsRoutes = require("./routes/driver-clients")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  geocodeLackingClients,
  ensureClientCoords,
});
// Раздел «Доставка» (/api/deliveries?date=YYYY-MM-DD).
const handleDeliveriesRoutes = require("./routes/deliveries")({
  getDb: () => db,
  sendJson,
  withResolvedBundleNames,
  normalizeRouteProgress,
});
// Рабочий день (/api/day POST, DELETE /api/day/:key, POST /api/day/:key/reopen).
const handleDayRoutes = require("./routes/day")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  segmentsFor,
  isAdmin,
  isModerator,
});
// Админские правки дня (/api/admin/day PUT, /api/admins, /api/admin/status).
const handleAdminDayRoutes = require("./routes/admin-day")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  canManageStatus,
});
// Server-Sent Events (/api/events).
const handleEventsRoutes = require("./routes/events")({
  sseClients,
  sseWrite,
});
// Админ-управление учётками (/api/admin/users*).
const handleAdminUsersRoutes = require("./routes/admin-users")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  rootAdminId,
  staffById,
  staffByLogin,
  hashPassword,
});
// Текущий пользователь и полное состояние (/api/me, /api/state).
const handleMeStateRoutes = require("./routes/me-state")({
  getDb: () => db,
  persistDb,
  sendJson,
  serverTzOffset,
  ensureStaffRecord,
  maybeFreezePrevMonth,
  adminDiag,
  isAdmin,
  isModerator,
  syncDirectory,
  groupsOfModerator,
  isDriver,
  isLoader,
  staffSeesOver,
  visibleStaff,
  visibleDays,
  visibleLog,
  canManageShipment,
  canSeeShipment,
  canSeeNotfound,
  canSeeLogs,
  canSeeReports,
});
// Системные маршруты (/api/log, /api/heartbeat, /api/live, /api/log/clear).
const handleSystemRoutes = require("./routes/system")({
  getDb: () => db,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  isModerator,
  liveRows,
});
// Экспорт табеля (/api/report/export).
const handleReportRoutes = require("./routes/report")({
  getDb: () => db,
  sendJson,
  isAdmin,
  isModerator,
  timesheetRowsForMonth,
  visibleStaff,
  buildXlsx,
  MIME,
});
// Модуль «Отчёты» (АБЦП), смонтированный под /reports/*.
const handleReportsRoutes = require("./routes/reports")({
  canSeeReports,
  getDb: () => db,
});
// Модуль «Сверки», смонтированный под /sverki/*.
const handleReconcileRoutes = require("./routes/sverki")({
  canSeeSverki,
  getDb: () => db,
});
const handleProcenkaRoutes = require("./routes/procenka")({
  canSeeProcenka,
  getDb: () => db,
});
const handleParserRoutes = require("./routes/parser")({
  canSeeParser,
  getDb: () => db,
});

async function handleApi(req, res, urlPath) {
  ensureLoaded();
  // Auto-close timers whose day has already ended (forgot "Завершить работу").
  // Done on every request so the close never waits for the minute scheduler — an
  // open timer is finished at 23:59:59.999 of its own day.
  if (autoCloseDayEndTimers(Date.now())) {
    void persistDb().catch(() => {});
  }
  if (!sessionsLoaded) { loadSessionsFromDisk(); sessionsLoaded = true; }
  const method = req.method;
  // Версия сборки (меняется при каждом деплое). Клиент периодически опрашивает
  // её и автоматически перезагружает страницу после обновления — без ручных
  // действий на браузере, мобильном и в Electron.
  if (urlPath === "/api/version" && method === "GET") {
    return sendJson(res, 200, { v: cacheVersion() });
  }
  // Личность, под которой пришёл запрос (сессия собственной авторизации > шлюз >
  // локальный фолбэк). Нужна для защиты «первого входа», чтобы нельзя было
  // задать логин/пароль за чужого сотрудника.
  const identUser = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
  // SSE: поток уведомлений «данные изменились». Соединение держим открытым,
  // при каждом persistDb сервер шлёт событие, на которое клиент перечитывает данные.
  if (await handleAuthRoutes(req, res, urlPath, method, identUser) !== false) {
    return; // маршрут собственной авторизации обработан
  }

  // Server-Sent Events (/api/events) — держим поток открытым, user не нужен.
  if (await handleEventsRoutes(req, res, urlPath, method, identUser, false) !== false) {
    return; // маршрут «события (SSE)» обработан
  }

  const user = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);

  // Access closed for this user: deny every API call (they were deleted / blocked).
  if (isBlocked(user, db)) {
    return sendJson(res, 403, { error: "access_denied", blocked: true });
  }

  // ================= Admin-only routes =================
  const admin = isAdmin(user, db);

  // Своя авторизация: админ-управление учётками (/api/admin/users*).
  if (await handleAdminUsersRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «админ-учётки» обработан
  }

  // Текущий пользователь и полное состояние (/api/me, /api/state).
  if (await handleMeStateRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «me/state» обработан
  }

  // Системные маршруты (/api/log, /api/heartbeat, /api/live, /api/log/clear).
  if (await handleSystemRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «система» обработан
  }

  // Экспорт табеля (/api/report/export?month=YYYY-MM).
  if (await handleReportRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «экспорт табеля» обработан
  }

  // Рабочий день (/api/day POST, DELETE /api/day/:key, POST /api/day/:key/reopen).
  if (await handleDayRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «рабочий день» обработан
  }

  // Админские правки дня (/api/admin/day PUT, /api/admins, /api/admin/status).
  if (await handleAdminDayRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «админские правки дня» обработан
  }

  // Сотрудники (/api/staff*, DELETE /api/staff/:id, /api/admin/staff/block).
  if (await handleStaffRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «сотрудники» обработан
  }

  // Восстановление офлайн-закрытий водителя (/api/admin/restore-client-close).
  if (await handleRestoreCloseRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «восстановление закрытия» обработан
  }

  // Справочник клиентов (/api/drivers/clients, /api/clients/:id/logo*).
  if (await handleDriverClientsRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «клиенты» обработан
  }

  if (await handleParamsRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «параметры» обработан
  }

  // ---- Clients for drivers ----
  // ---- Driver routes (маршруты на день) ----
  // ---- Отгрузка (склад): маршруты, ожидающие отгрузки ----
  // Доступ: админ или сотрудник группы склада (см. canSeeShipment).
  if (await handleShipmentRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «отгрузка» обработан
  }

  // Этикетки отгрузки и скан мест (/api/labels*).
  if (await handleLabelsRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «этикетки/скан» обработан
  }

  // Расходные накладные (/api/routes/:id/waybill*, /api/waybill/parse).
  if (await handleWaybillRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «накладные» обработан
  }

  // Журнал сканирования мест — раздел «Журнал», видят все пользователи.
  // Записи идут свежими вперёд. Опциональные фильтры: ?action=load|unload,
  // ?limit=N (сколько последних вернуть; по умолчанию 300, максимум 2000).
  if (await handleScanlogRoutes(req, res, urlPath, method) !== false) {
    return; // маршрут «журнал сканирования мест» обработан
  }

  // Гео-маршрутизация по дорогам (/api/geo/route-from-track).
  if (await handleGeoRoutes(req, res, urlPath, method) !== false) {
    return; // маршрут «гео» обработан
  }

  if (await handleDriverRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «маршруты водителя» обработан
  }

  // Раздел «Доставка» (/api/deliveries?date=YYYY-MM-DD).
  if (await handleDeliveriesRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «доставка» обработан
  }

  // Создание/настройка маршрутов (/api/drivers/routes POST, unlock, optimize, route-km, base-km).
  if (await handleRouteCreateRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «создание маршрута» обработан
  }

  // Действия водителя по маршруту (/api/drivers/routes/action).
  if (await handleRouteActionRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «действия водителя» обработан
  }

  // ---- POST /api/drivers/location  ({ lat, lon, routeId? })  — водитель шлёт
  //      свои текущие координаты (геолокация, пока приложение в фокусе).
  //      Хранится in-memory и используется для живой карты в «Отчёте».
  if (await handleLocationRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «геолокация водителей» обработан
  }

  if (await handleTracksRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «GPS-следы» обработан
  }

  if (await handleMotionRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «движение водителей» обработан
  }

  // ---- GET /api/maps/config  (admin)  — отдаём фронту ключ JavaScript API
  //      Яндекс.Карт для живой карты в «Отчёте» маршрутизации.
  if (await handleAppRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «приложение/версия» обработан
  }

  if (await handleGroupsRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «группы» обработан
  }

  // ---- Отчёт по «не найдено»: детали, помеченные при сборке, + статус/комментарий ----
  if (await handleNotfoundRoutes(req, res, urlPath, method, user) !== false) {
    return; // маршрут «Проблемы со склада» обработан
  }

  if (await handleLogsRoutes(req, res, urlPath, method, user, admin) !== false) {
    return; // маршрут «журнал сканов» обработан
  }

  // ================= Full database backup / restore =================
  // The whole app state lives in ONE JSON file (staff + salaries + overtime hours,
  // groups, timesheet days, driver clients & routes, params, admins, log). These two
  // endpoints let an admin download that file and restore it on any server — so the
  // data can be moved to a fresh instance (new address) without losing anything.

  // ---- GET /api/admin/backup  (downloads the entire db as JSON) ----
  if (await handleBackupRoutes(req, res, urlPath, method, admin) !== false) {
    return; // маршрут «резервное копирование» обработан
  }

  return sendJson(res, 404, { error: "not found" });
}

// Хэш-версия сборки для кэш-бастеринга. Растёт при ЛЮБОЙ правке ключевых файлов
// (index.html/app.js/styles.css/sw.js), поэтому при каждом деплое устройства
// получают новый ?v= и скачивают свежий JS/CSS, а Service Worker сбрасывает старый
// кэш. Используем mtime, а не versionCode — versionCode у нас растёт только при
// ручном релизе APK, и опора на него оставляла бы ПК/WebView на устаревшем app.js
// (симптом: «кнопка есть, нажимаю — ничего не происходит» из старого скрипта).
function cacheVersion() {
  try {
    let acc = "";
    for (const f of ["index.html", "app.js", "styles.css", "sw.js"]) {
      const p = path.join(ROOT, f);
      if (fs.existsSync(p)) acc += fs.statSync(p).mtimeMs + ":" + f + ";";
    }
    if (!acc) return String(Math.floor(Date.now() / 1000));
    return crypto.createHash("sha1").update(acc).digest("hex").slice(0, 12);
  } catch {
    return String(Math.floor(Date.now() / 1000));
  }
}

function serveHtml(res, data) {
  // Cache-buster для статики: заменяем плейсхолдер ?v=RELEASE в ссылках на
  // app.js/styles.css хэш-версией сборки (cacheVersion). Это гарантирует, что
  // после каждого деплоя браузеры/WebView пользователей загружают свежие файлы,
  // а не закешированную старую версию.
  let out = data;
  try {
    const ver = cacheVersion();
    if (ver) out = Buffer.from(String(data).split("?v=RELEASE").join("?v=" + ver));
  } catch { /* если не вышло — отдаём как есть */ }
  res.writeHead(200, {
    "Content-Type": MIME[".html"],
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Разрешаем карту: скрипт/стиль Leaflet (unpkg.com) и тайлы OpenStreetMap
    // (tile.openstreetmap.org). Без этого прод-шлюз блокирует внешние ресурсы
    // и карта в «Трекинге» не отрисовывается (проверено живым кейсом).
    "Content-Security-Policy":
      "default-src 'self'; " +
      "script-src 'self' https://unpkg.com https://api-maps.yandex.ru https://yastatic.net https://*.yastatic.net https://*.yandex.ru https://*.maps.yandex.net 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' https://unpkg.com https://fonts.googleapis.com 'unsafe-inline'; " +
      "img-src 'self' data: blob: https://yandex.ru https://*.yandex.ru https://yastatic.net https://*.yastatic.net https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://yandex.net https://*.yandex.net https://*.tile.maps.yandex.net https://core-renderer-tiles.maps.yandex.net; " +
      "connect-src 'self' https://unpkg.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://api-maps.yandex.ru https://*.yandex.ru https://*.yandex.net https://yastatic.net https://*.yastatic.net; " +
      "font-src 'self' data: https://fonts.gstatic.com;",
  });
  res.end(out);
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    } catch {
      return sendJson(res, 400, { error: "bad url" });
    }
    // Модуль «Отчёты» (АБЦП) живёт под /reports/*: API и статика внутри самого
    // модуля. Доступ — через canSeeReports (права BIOTIME), свою авторизацию
    // АБЦП не используем.
    if (urlPath === "/reports" || urlPath.startsWith("/reports/")) {
      const ruser = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
      if (handleReportsRoutes(req, res, urlPath, ruser) !== false) return;
    }
    if (urlPath === "/sverki" || urlPath.startsWith("/sverki/")) {
      const suser = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
      if (handleReconcileRoutes(req, res, urlPath, suser) !== false) return;
    }
    if (urlPath === "/procenka" || urlPath.startsWith("/procenka/")) {
      const puser = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
      if (handleProcenkaRoutes(req, res, urlPath, puser) !== false) return;
    }
    if (urlPath === "/parser" || urlPath.startsWith("/parser/")) {
      const pu = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
      if (handleParserRoutes(req, res, urlPath, pu) !== false) return;
    }
    if (urlPath.startsWith("/api/")) {
      return await handleApi(req, res, urlPath);
    }
    if (urlPath === "/") urlPath = "/index.html";

    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Forbidden");
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        if (urlPath !== "/index.html") {
          return fs.readFile(path.join(ROOT, "index.html"), (e2, indexData) => {
            if (e2) {
              res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
              return res.end("Not Found");
            }
            serveHtml(res, indexData);
          });
        }
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        return res.end("Not Found");
      }
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".html") return serveHtml(res, data);
      // Service Worker: подставляем актуальную версию кэша (biotime-vRELEASE ->
      // битый хэш сборки). При каждом деплое sw.js меняется -> Worker
      // переустанавливается и на activate удаляет старый кэш статики, поэтому
      // устаревший app.js/styles.css не застревают на устройствах.
      let outData = data;
      if (urlPath === "/sw.js") {
        outData = Buffer.from(
          String(data).split("biotime-vRELEASE").join("biotime-v" + cacheVersion())
        );
      }
      const type = MIME[ext] || "application/octet-stream";
      // gzip-сжатие текстовой статики (js/css/json/svg/webmanifest): уменьшает
      // объём app.js/styles.css в разы, заметно ускоряя первую загрузку WebView
      // на мобильных и ТСД (пока Service Worker кэш ещё пуст). Изображения не
      // трогаем — они уже сжаты и сжимать их бессмысленно.
      // Манифест (.webmanifest) НЕ сжимаем: это маленький PWA-файл, который
      // браузер требует строго как JSON без обёрток — gzip тут лишь риск
      // «Manifest: Syntax error» при некоторых прокси/загрузчиках манифеста.
      const GZIP_EXT = new Set([".js", ".css", ".json", ".svg", ".txt", ".md", ".xml"]);
      if (GZIP_EXT.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] || ""))) {
        try {
          const gz = zlib.gzipSync(outData, { level: 9 });
          res.writeHead(200, {
            "Content-Type": type,
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
            "Content-Length": gz.length,
          });
          return res.end(gz);
        } catch { /* сжатие не вышло — отдаём как есть */ }
      }
      res.writeHead(200, { "Content-Type": type });
      res.end(outData);
    });
  } catch (e) {
    console.error("API error:", e);
    if (!res.headersSent) {
      // Возврат JSON с реальной причиной, чтобы клиент показал осмысленное
      // сообщение, а не общее «Ошибка сервера» (res.json() на plain-text падал).
      const msg = (e && e.message) ? String(e.message) : "Server Error";
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `Ошибка сервера: ${msg}` }));
    } else {
      res.end();
    }
  }
});

// Явно слушаем на 0.0.0.0 (все IPv4), чтобы health-проверка платформы на
// 127.0.0.1:<PORT> гарантированно достучалась: без хоста Node на части систем
// биндится только на :: (IPv6) и отвечает «did not answer … 000».
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Табель server running on http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  // Warm the portal directory in the background so an admin's first open is already current.
  try {
    ensureLoaded();
    loadDayTracks();
    loadSnappedTracks();
    // Periodic check: finish any running timer as soon as its day has passed.
    // A forgotten "Завершить работу" is closed at 23:59:59.999 of that day.
    setInterval(() => {
      try {
        if (autoCloseDayEndTimers(Date.now())) void persistDb().catch(() => {});
      } catch { /* non-fatal */ }
    }, 60 * 1000);
    // Automatic backup scheduler: snapshot the database roughly every 6 hours and
    // once on startup (when the last snapshot is older than the interval).
    const backupTick = () => {
      try { maybeAutoBackup(Date.now()); } catch { /* non-fatal */ }
    };
    backupTick();
    setInterval(backupTick, BACKUP_INTERVAL_MS);
    syncDirectory(true).catch(() => {});
  } catch { /* non-fatal */ }
});
