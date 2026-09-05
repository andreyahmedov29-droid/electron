const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// ---- Persistent storage in /data (survives redeploy) ----
// Resolve with fallback so local runs still work.
const DATA_DIR = process.env.DATA_DIR && process.env.DATA_DIR !== "/data"
  ? process.env.DATA_DIR
  : (process.env.DATA_DIR || "/data");
const DATA_FILE = path.join(DATA_DIR, "db.json");

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
async function snapTrackToRoads(raw) {
  const clean = (raw || []).filter((p) =>
    Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
  );
  if (clean.length < 2) return clean.slice();
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
    const seg = await tomtomRouteGeometry(a, b);
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
    return out.length >= 2 ? out : clean.slice();
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
  return anyMatch ? out : clean.slice();
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
  const res = await fetch(`${PORTAL_BASE}${pathname}`, {
    method,
    headers: {
      "X-Api-Key": PORTAL_KEY,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `portal_error_${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data && data.data !== undefined ? data.data : data;
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
    labels: [],         // [{ id, code, routeId, clientIdx, client, address, place, status, at }] — этикетки отгрузки
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
      allowFinishUnloadIncomplete: false,
      multiplier: 1,
      multFrom: null,
      multTo: null,
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
  return writeQueue;
}

function ensureLoaded() {
  if (!db) db = loadDb();
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
      ? JSON.stringify({ app: "biotime", version: 1, exportedAt: new Date().toISOString(), data: db }, null, 2)
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

// Timestamp of the last millisecond of the local day containing `ts`
// (23:59:59.999) — the instant an employee's running timer belongs to.
function endOfDayMs(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
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
      for (const s of entry.segments) {
        // Защита от битых/мусорных записей в сегментах дня: элемент может быть
        // null или не-объектом, и s.kind на нём раньше ронял ВЕСЬ запрос (500).
        if (s && typeof s === "object" && s.kind === "work" && s.end == null && now > endOfDayMs(s.start)) {
          s.end = endOfDayMs(s.start);
          changed = true;
        }
      }
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

// ---- Auth for /api/*, returns { ok, user, body } ----
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2_000_000) { req.destroy(); reject(new Error("body too large")); }
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
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

// Возвращает клон маршрута с гарантированно нормализованными полями прогресса:
// каждая точка несёт id, state и таймстемпы, а маршрут — объект progress.
// Используется при чтении, чтобы клиент всегда видел полную структуру, не
// перезаписывая БД на каждом GET.
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

// Обогащает точки маршрута водителя счётчиком выгрузки мест клиента: сколько
// этикеток уже выгружено (status "delivered"), сколько всего, и готов ли клиент
// к завершению выгрузки. Считается по хранилищу этикеток: код места клиента —
// «BG<routeId>-<clientIndex+1>-<place>», где clientIndex — индекс точки в
// route.clients. Поля unloadTotal/unloadDone/unloadReady вычисляются на лету
// (не персистятся); unloadFinished — это ручной флаг «водитель завершил выгрузку»
// (сохраняется в точке и НЕ переводит её в delivered — водитель остаётся на
// точке, время сдачи продолжает идти, пока не нажмёт «Завершить сдачу»).
function enrichUnloadProgress(route, labels) {
  const clients = Array.isArray(route && route.clients) ? route.clients : [];
  const all = labels || [];
  clients.forEach((c, i) => {
    const mine = all.filter(
      (l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === i
    );
    const total = mine.length;
    const done = mine.filter((l) => l.status === "delivered").length;
    c.unloadTotal = total;
    c.unloadDone = done;
    // «Готово к завершению выгрузки»: все места выгружены, либо у клиента вовсе
    // нет этикеток (печатать нечего — завершить выгрузку разрешено).
    c.unloadReady = total === 0 ? true : done === total;
    c.unloadFinished = c.unloadFinished === true;
  });
  return route;
}

// ---- Автопостроение маршрута по адресам клиентов (Яндекс.Карты) ----
// Геокодирование адреса → координаты [lat, lon]. Ключ API берётся из окружения
// (YANDEX_GEO_KEY), с фолбэком на ключ проекта (уже используется в test-yamaps).
// Если сервис недоступен или адрес не распознан — возвращается null (не краш).
const YANDEX_GEO_URL = "https://geocode-maps.yandex.ru/1.x/";
// Рабочий ключ Geocoder HTTP API. Переопределяется через окружение
// (YANDEX_GEO_KEY). Без заголовков User-Agent/Referer Яндex отвечает 403
// «Invalid api key» даже на активный ключ — их обязательно шлём в запросе.
const YANDEX_GEO_KEY = process.env.YANDEX_GEO_KEY || "92c61ff5-d3f3-4449-a201-ebb3196bb055";
const GEO_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Referer": "https://developer.tech.yandex.ru/",
};
// Ключ JavaScript API Яндекс.Карт для живой карты администратора. Приходит из
// окружения (YANDEX_MAPS_KEY); фолбэк — рабочий ключ этой разработки. Ключ JS API
// всё равно виден в браузере (так устроен Я.Карты), поэтому нет секретности.
const YANDEX_MAPS_KEY = process.env.YANDEX_MAPS_KEY || "2f4e9d71-43a9-4a4b-98f6-19f1bbaff0ed";

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
  process.env.TOMMOM_KEY ||
    "ONGC3rAONPnxS1ZXwtTPjDD5mtHijyaT"
);

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
  if (isModerator(user, dbData)) {
    const ids = moderatorVisibleIds(user, dbData);
    return dbData.staff.filter((s) => ids.has(s.id));
  }
  if (isAdmin(user, dbData)) return dbData.staff;
  const ids = moderatorVisibleIds(user, dbData);
  if (ids.size > 0) return dbData.staff.filter((s) => ids.has(s.id));
  return dbData.staff.filter((s) => s.id === user.id);
}

function visibleDays(user, dbData) {
  const ids = moderatorVisibleIds(user, dbData);
  // Модератор всегда видит только дни членов своих групп — даже если по роли
  // он ADMIN (приоритет модераторства), см. visibleStaff.
  if (ids.size === 0 && isAdmin(user, dbData)) return dbData.days;
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
      if (ids.has(sid)) visibleEmp[sid] = byEmp[sid];
    }
    const statusKeys = rec.statuses && typeof rec.statuses === "object"
      ? Object.keys(rec.statuses).filter((id) => ids.has(id))
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
  if (isAdmin(user, dbData)) return dbData.log;
  // A moderator sees the journal entries of their group members (+ their own), so
  // they can audit timer presses, statuses and manual time edits of their people.
  if (isModerator(user, dbData)) {
    const ids = moderatorVisibleIds(user, dbData);
    ids.add(user.id);
    return dbData.log.filter((e) => e.ownerId && ids.has(e.ownerId));
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
      if (wk > 0) overMs += Math.max(0, wk - normDayMs);
    }
    return {
      id: st.id, name: st.name, salary: st.salary != null ? st.salary : 0, bonus: st.bonus != null ? st.bonus : 0, extraBonus: st.extraBonus != null ? st.extraBonus : 0,
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
    let closedMs = 0;
    let openStart = null;
    for (const s of segmentsFor(st.id, rec)) {
      if (s.kind === "break") continue;
      workedMs += Math.max(0, (s.end == null ? now : s.end) - s.start);
      if (s.end != null) closedMs += Math.max(0, s.end - s.start);
      if (s.end == null) openStart = s.start;
    }
    // Overtime only for a closed day (segment with an explicit end), see
    // dayClosedWorkMs — matching the calendar/report behaviour.
    const overMs = closedMs > 0 ? Math.max(0, closedMs - normDayMs) : 0;
    const status = (rec && rec.statuses && rec.statuses[st.id])
      || (workedMs >= normDayMs ? "Я" : (workedMs > 0 ? "НД" : null));
    const online = !!lastSeen[st.id] && (now - lastSeen[st.id]) < ONLINE_WINDOW_MS;
    // Overtime money from the monthly salary rate (server replica of the client calc).
    const m0 = new Date(now).getMonth();
    const year = new Date(now).getFullYear();
    const bizDays = businessDays(year, m0);
    const rateBaseH = bizDays * 8; // hourly rate always uses the 8-hour day base (оклад / 8)
    const rate = st.salary != null && st.salary > 0 && rateBaseH > 0 ? st.salary / rateBaseH : 0;
    const mult = dbData.params && Number.isFinite(dbData.params.multiplier) ? dbData.params.multiplier : 1;
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

async function handleApi(req, res, urlPath) {
  ensureLoaded();
  // Auto-close timers whose day has already ended (forgot "Завершить работу").
  // Done on every request so the close never waits for the minute scheduler — an
  // open timer is finished at 23:59:59.999 of its own day.
  if (autoCloseDayEndTimers(Date.now())) {
    void persistDb().catch(() => {});
  }
  const user = identity(req.headers);
  const method = req.method;

  // Access closed for this user: deny every API call (they were deleted / blocked).
  if (isBlocked(user, db)) {
    return sendJson(res, 403, { error: "access_denied", blocked: true });
  }

  // ---- GET /api/me ----
  if (urlPath === "/api/me" && method === "GET") {
    ensureStaffRecord(user);
    await persistDb();
    const diag = adminDiag(user, db);
    return sendJson(res, 200, {
      id: user.id,
      name: user.name,
      role: user.role,
      isAdmin: diag.isAdmin,
      diag,
      serverOffsetMinutes: serverTzOffset(),
      tzLabel: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
      })(),
    });
  }

  // ---- GET /api/state ----
  if (urlPath === "/api/state" && method === "GET") {
    const changed = ensureStaffRecord(user);
    if (changed) await persistDb();
    const admin = isAdmin(user, db);
    const moderator = isModerator(user, db);
    if (admin) {
      // An admin sees the whole "Все сотрудники" list — refresh it from the portal
      // directory (rate-limited to once per minute) before returning.
      await syncDirectory(false);
    }
    // Groups: an admin sees every group; a moderator sees only the groups they
    // moderate. A plain member sees none.
    const groups = admin
      ? db.groups
      : (moderator ? groupsOfModerator(user, db) : []);
    // Per-employee overtime visibility (hours/money), scoped by group selection.
    // The group scope governs EVERYONE — including admins and moderators — so the
    // "Переработка" / "За подработку" timer blocks match the group that is allowed
    // to see them.
    const me = { id: user.id, name: user.name, role: user.role, isAdmin: admin, isDriver: isDriver(user, db) };
    me.diag = adminDiag(user, db);
    me.seeOverHours = staffSeesOver(db, user.id, "hours");
    me.seeOverSum = staffSeesOver(db, user.id, "sum");
    const staffView = visibleStaff(user, db).map((s) => ({
      id: s.id,
      name: s.name,
      salary: s.salary != null ? s.salary : null,
      bonus: s.bonus != null ? s.bonus : null,
      extraBonus: s.extraBonus != null ? s.extraBonus : null,
      seeOverHours: staffSeesOver(db, s.id, "hours"),
      seeOverSum: staffSeesOver(db, s.id, "sum"),
    }));
    return sendJson(res, 200, {
      me,
      isModerator: moderator,
      canEditStatus: admin || moderator,
      staff: staffView,
      days: visibleDays(user, db),
      log: visibleLog(user, db),
      admins: admin ? db.admins : undefined,
      blocked: admin ? db.blocked : undefined,
      groups: admin || moderator ? groups : undefined,
      params: db.params,
      norm: db.norm,
      // Смещение часового пояса сервера от UTC в минутах. Клиент использует его
      // как ЕДИНЫЙ опорный пояс для конвертации «ЧЧ:ММ» ↔ timestamp, чтобы время
      // не зависело от часового пояса каждого устройства (телефон/компьютер).
      serverOffsetMinutes: serverTzOffset(),
      tzLabel: (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
      })(),
    });
  }

  // ---- POST /api/day  (save current day for the owner) ----
  if (urlPath === "/api/day" && method === "POST") {
    const body = await readBody(req);
    const key = typeof body.key === "string" ? body.key : null;
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return sendJson(res, 422, { error: "bad day key" });
    const segments = Array.isArray(body.segments) ? body.segments : [];
    // Keep admin-assigned statuses for this day; the owner saving their own work
    // segments must not silently wipe them out (statuses belong to multiple
    // employees, not just the segment owner).
    const prev = db.days[key];
    const prevStatuses = prev && prev.statuses && typeof prev.statuses === "object" ? prev.statuses : undefined;
    // Do not let a stale client save silently kill a live running timer. When the
    // incoming list has no open work segment but the stored day already has one for
    // this owner, keep the open segment — the running timer must never be erased by a
    // background tab / an out-of-order save. An explicit "Завершить" always arrives
    // with that segment already closed (its `end` set), so it still works.
    const prevOwn = segmentsFor(user.id, prev);
    const prevOpen = prevOwn.find((s) => s.kind === "work" && s.end == null) || null;
    const incomingHasOpen = Array.isArray(segments) && segments.some((s) => s.kind === "work" && s.end == null);
    let merged = Array.isArray(segments) ? segments.slice() : [];
    if (prevOpen && !incomingHasOpen) {
      // The incoming day closes the SAME open timer (same id, or same start when
      // id is absent) — that is an explicit "Завершить работу", not a stale
      // background save. Keep the closed segment and do NOT resurrect the open
      // one, so the day stays finished after a reload (the "Завершить" button
      // does not come back and the "конец" time is recorded).
      const alreadyClosed = merged.some(
        (s) => s.kind === "work"
          && s.end != null
          && (s.id != null ? s.id === prevOpen.id : s.start === prevOpen.start)
      );
      if (!alreadyClosed) merged.push(prevOpen);
    }
    // Server always writes as the owner: a member can only touch their own days.
    const day = prev && typeof prev === "object" ? prev : {};
    if (!(day.byEmployee && typeof day.byEmployee === "object")) day.byEmployee = {};
    day.byEmployee[user.id] = { segments: merged };
    if (prevStatuses) day.statuses = prevStatuses;
    db.days[key] = day;
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- DELETE /api/day/:key (owner or admin) ----
  let m = urlPath.match(/^\/api\/day\/(\d{4}-\d{2}-\d{2})$/) || null;
  if (m && method === "DELETE") {
    const key = m[1];
    const rec = db.days[key];
    if (!rec) return sendJson(res, 404, { error: "not found" });
    if (!isAdmin(user, db)) {
      // Member deletes only their own segments, not the whole shared day.
      if (!(rec.byEmployee && rec.byEmployee[user.id]) && !(rec.ownerId === user.id)) {
        return sendJson(res, 403, { error: "forbidden" });
      }
      if (rec.byEmployee && typeof rec.byEmployee === "object") delete rec.byEmployee[user.id];
      const hasSegs = rec.byEmployee && Object.keys(rec.byEmployee).some((k) => (rec.byEmployee[k].segments || []).length);
      const hasStatuses = rec.statuses && Object.keys(rec.statuses).length;
      if (!hasSegs && !hasStatuses) delete db.days[key];
    } else {
      delete db.days[key];
    }
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/log (append an action) ----
  if (urlPath === "/api/log" && method === "POST") {
    const body = await readBody(req);
    const action = String(body.action || "").slice(0, 200);
    // kind: journal tab this entry belongs to — "timer" (default) / "status" / "manual".
    const kind = ["timer", "status", "manual"].includes(body.kind) ? body.kind : "timer";
    db.log.push({ ts: Date.now(), action, kind, ownerId: user.id });
    if (db.log.length > 2000) db.log = db.log.slice(-2000);
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/heartbeat (online presence) ----
  // Clients ping this regularly; a fresh timestamp makes the employee appear
  // "online" on the admin / moderator Live tab. Kept in memory only (no disk write).
  if (urlPath === "/api/heartbeat" && method === "POST") {
    if (!db.lastSeen) db.lastSeen = {};
    db.lastSeen[user.id] = Date.now();
    return sendJson(res, 200, { ok: true });
  }

  // ================= Admin-only routes =================
  const admin = isAdmin(user, db);

  // ---- GET /api/live (admin/moderator: who is online, whose timer runs, all data)
  if (urlPath === "/api/live" && method === "GET") {
    if (!admin && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
    const rows = liveRows(user, db);
    return sendJson(res, 200, { rows, at: Date.now() });
  }

  // ---- POST /api/staff  (add staff) ----
  if (urlPath === "/api/staff" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return sendJson(res, 422, { error: "name required" });
    db.staff.push({ id: "s-" + crypto.randomBytes(5).toString("hex"), name, salary: null, bonus: null, extraBonus: null });
    await persistDb();
    return sendJson(res, 200, { ok: true, staff: db.staff });
  }

  // ---- POST /api/staff/salary  (set salary) ----
  if (urlPath === "/api/staff/salary" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const st = db.staff.find((s) => s.id === body.id);
    if (!st) return sendJson(res, 404, { error: "staff not found" });
    let v = parseInt(body.salary, 10);
    st.salary = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/staff/bonus  (set monthly bonus for a staff member) ----
  if (urlPath === "/api/staff/bonus" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const st = db.staff.find((s) => s.id === body.id);
    if (!st) return sendJson(res, 404, { error: "staff not found" });
    let v = parseInt(body.bonus, 10);
    st.bonus = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/staff/extra-bonus  (set additional monthly bonus) ----
  if (urlPath === "/api/staff/extra-bonus" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const st = db.staff.find((s) => s.id === body.id);
    if (!st) return sendJson(res, 404, { error: "staff not found" });
    let v = parseInt(body.extraBonus, 10);
    st.extraBonus = Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- DELETE /api/staff/:id ----
  m = urlPath.match(/^\/api\/staff\/(.+)$/) || null;
  if (m && method === "DELETE") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const id = m[1];
    if (id === user.id) return sendJson(res, 400, { error: "cannot remove self" });
    const rec = db.staff.find((s) => s.id === id);
    db.staff = db.staff.filter((s) => s.id !== id);
    db.admins = db.admins.filter((a) => a !== id);
    purgeStaffFromGroups(id, db);
    for (const k in db.days) {
      const day = db.days[k];
      // Remove the employee's segments from the shared per-day map.
      if (day.byEmployee && typeof day.byEmployee === "object" && day.byEmployee[id]) {
        delete day.byEmployee[id];
      }
      // Remove the removed employee's status from shared status maps; drop the
      // day if that leaves it without segments and without any statuses.
      if (day.statuses && day.statuses[id] !== undefined) {
        delete day.statuses[id];
        if (Object.keys(day.statuses).length === 0) delete day.statuses;
      }
      const hasSegs = day.byEmployee && Object.keys(day.byEmployee).some((e) => (day.byEmployee[e].segments || []).length);
      const hasStatuses = day.statuses && Object.keys(day.statuses).length > 0;
      if (!hasSegs && !hasStatuses) delete db.days[k];
    }
    db.log = db.log.filter((e) => e.ownerId !== id);
    // Close the employee's access to the app, so they don't reappear on next login.
    if (!db.blocked.some((b) => b.id === id)) {
      db.blocked.push({ id, name: rec ? rec.name : `Сотрудник ${id}`, at: Date.now() });
    }
    await persistDb();
    return sendJson(res, 200, { ok: true, blocked: db.blocked });
  }

  // ---- POST /api/admin/staff/block  { id, on, name? } ----
  if (urlPath === "/api/admin/staff/block" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const id = String(body.id || "");
    if (!id) return sendJson(res, 422, { error: "id required" });
    if (id === user.id) return sendJson(res, 400, { error: "cannot block self" });
    const on = body.on === true;
    if (on) {
      const rec = db.staff.find((s) => s.id === id);
      db.staff = db.staff.filter((s) => s.id !== id);
      db.admins = db.admins.filter((a) => a !== id);
      purgeStaffFromGroups(id, db);
      if (!db.blocked.some((b) => b.id === id)) {
        db.blocked.push({ id, name: rec ? rec.name : String(body.name || `Сотрудник ${id}`), at: Date.now() });
      }
    } else {
      db.blocked = db.blocked.filter((b) => b.id !== id);
    }
    await persistDb();
    return sendJson(res, 200, { ok: true, blocked: db.blocked });
  }

  // ---- PUT /api/admin/day  (edit a specific employee's day) ----
  // Admins may edit anyone's day; a moderator only their own group members.
  if (urlPath === "/api/admin/day" && method === "PUT") {
    const body = await readBody(req);
    const key = typeof body.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.key) ? body.key : null;
    if (!key) return sendJson(res, 422, { error: "bad day key" });
    const ownerId = String(body.ownerId || "");
    if (!ownerId || !db.staff.some((s) => s.id === ownerId)) {
      return sendJson(res, 422, { error: "unknown staff" });
    }
    if (!canManageStatus(user, db, ownerId)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    const segments = Array.isArray(body.segments)
      ? body.segments.map((s) => ({
          start: Number.isFinite(s.start) ? s.start : 0,
          end: s.end == null ? null : (Number.isFinite(s.end) ? s.end : null),
          kind: s.kind === "break" ? "break" : "work",
          id: String(s.id || "s"),
        }))
      : [];
    const prev = db.days[key];
    const day = prev && typeof prev === "object" ? prev : {};
    if (!(day.byEmployee && typeof day.byEmployee === "object")) day.byEmployee = {};
    // Save ONLY this employee's segments so the others' data for the same day
    // (also edited from the "Время работы" tab) are never overwritten.
    day.byEmployee[ownerId] = { segments };
    if (prev && prev.statuses && typeof prev.statuses === "object") day.statuses = prev.statuses;
    db.days[key] = day;
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/admins  { id, on } ----
  if (urlPath === "/api/admins" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const on = body.on === true;
    if (on) { if (!db.admins.includes(body.id)) db.admins.push(body.id); }
    else { db.admins = db.admins.filter((a) => a !== body.id); }
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/admin/status  { key, ownerId, status } (admin assigns a
  //      timesheet status Я / Б / ОТ / ДО / НН, or clears it with "") ----
  if (urlPath === "/api/admin/status" && method === "POST") {
    const body = await readBody(req);
    const key = typeof body.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.key) ? body.key : null;
    if (!key) return sendJson(res, 422, { error: "bad day key" });
    const ownerId = String(body.ownerId || "");
    if (!ownerId || !db.staff.some((s) => s.id === ownerId)) {
      return sendJson(res, 422, { error: "unknown staff" });
    }
    // Admins may set statuses for anyone; a moderator only for their group members.
    if (!canManageStatus(user, db, ownerId)) return sendJson(res, 403, { error: "forbidden" });
    const status = String(body.status || "");
    const allowed = ["", "Я", "Б", "ОТ", "ДО", "НН"];
    if (!allowed.includes(status)) return sendJson(res, 422, { error: "bad status" });
    const rec = db.days[key];
    if (!rec) {
      if (status) db.days[key] = { statuses: { [ownerId]: status } };
    } else {
      if (status) {
        if (!rec.statuses) rec.statuses = {};
        rec.statuses[ownerId] = status;
      } else if (rec.statuses) {
        delete rec.statuses[ownerId];
        if (Object.keys(rec.statuses).length === 0) delete rec.statuses;
      }
      // If the day ended up with neither segments nor any status, drop it.
      const hasSegs = rec.byEmployee && Object.keys(rec.byEmployee).some((e) => (rec.byEmployee[e].segments || []).length);
      const hasStatuses = rec.statuses && Object.keys(rec.statuses).length > 0;
      if (!hasSegs && !hasStatuses) delete db.days[key];
    }
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- POST /api/params ----
  if (urlPath === "/api/params" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const p = db.params;
    if (typeof body.showOverHours === "boolean") p.showOverHours = body.showOverHours;
    if (typeof body.showOverSum === "boolean") p.showOverSum = body.showOverSum;
    if (typeof body.showDrivers === "boolean") p.showDrivers = body.showDrivers;
    if (typeof body.adminSeeRoutes === "boolean") p.adminSeeRoutes = body.adminSeeRoutes;
    if (typeof body.driverSeeRoutes === "boolean") p.driverSeeRoutes = body.driverSeeRoutes;
    if (typeof body.showShipment === "boolean") p.showShipment = body.showShipment;
    if (Array.isArray(body.showOverHoursGroups)) {
      p.showOverHoursGroups = [...new Set(body.showOverHoursGroups.map(String).filter((id) => db.groups.some((g) => g.id === id)))];
    }
    if (Array.isArray(body.showOverSumGroups)) {
      p.showOverSumGroups = [...new Set(body.showOverSumGroups.map(String).filter((id) => db.groups.some((g) => g.id === id)))];
    }
    if (Array.isArray(body.shipmentGroups)) {
      p.shipmentGroups = [...new Set(body.shipmentGroups.map(String).filter((id) => db.groups.some((g) => g.id === id)))];
    }
    if (typeof body.allowDriverStartWithoutShipment === "boolean") {
      p.allowDriverStartWithoutShipment = body.allowDriverStartWithoutShipment;
    }
    if (typeof body.allowFinishUnloadIncomplete === "boolean") {
      p.allowFinishUnloadIncomplete = body.allowFinishUnloadIncomplete;
    }
    if (typeof body.multiplier === "number" && body.multiplier >= 1) p.multiplier = body.multiplier;
    if (typeof body.multFrom === "string") p.multFrom = body.multFrom || null;
    if (typeof body.multTo === "string") p.multTo = body.multTo || null;
    if (typeof body.norm === "number" && body.norm >= 1 && body.norm <= 24) db.norm = body.norm;
    // Версия обновления Android-APK. Пустая строка/null = вернуться к дефолтам
    // (окружение APP_UPDATE_* или жёсткие значения ниже).
    if (body.updateVersionCode === "" || body.updateVersionCode === null) {
      p.updateVersionCode = null;
    } else if (Number.isFinite(Number(body.updateVersionCode)) && Number(body.updateVersionCode) >= 1) {
      p.updateVersionCode = Number(body.updateVersionCode);
    }
    if (typeof body.updateVersionName === "string") p.updateVersionName = body.updateVersionName.trim();
    if (typeof body.updateApkUrl === "string") p.updateApkUrl = body.updateApkUrl.trim();
    if (typeof body.updateNotes === "string") p.updateNotes = body.updateNotes.trim();
    await persistDb();
    return sendJson(res, 200, { ok: true, params: db.params, norm: db.norm });
  }

  // ---- Clients for drivers ----
  if (urlPath === "/api/drivers/clients" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    // До-геокодирование клиентов без координат выполняется В ФОНЕ (без await):
    // ответ карте трекинга уходит мгновенно, а координаты подтягиваются постепенно.
    // Если бы геокод шёл синхронно (до 5 запросов по ~15с), карта, вызывающая
    // этот эндпоинт каждые 30 сек, надолго зависала бы в ожидании.
    geocodeLackingClients(db, persistDb);
    return sendJson(res, 200, { ok: true, clients: db.driverClients || [] });
  }

  if (urlPath === "/api/drivers/clients" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    db.driverClients = db.driverClients || [];
    // Создание связки: несколько клиентов на один адрес. Выбранные клиенты
    // получают общий bundleId; общий адрес связки хранится в отдельном поле
    // bundleAddress и НЕ перезаписывает собственный адрес контрагента
    // (адрес меняется только через редактирование). Связок может быть много.
    if (body.action === "bundle") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const bundleAddress = String(body.address || "").slice(0, 500).trim();
      if (ids.length < 2) return sendJson(res, 422, { error: "Выберите хотя бы двух клиентов для связки" });
      if (!bundleAddress) return sendJson(res, 422, { error: "Укажите общий адрес связки" });
      const have = ids.filter((id) => db.driverClients.some((c) => c.id === id));
      if (have.length === 0) return sendJson(res, 404, { error: "Клиенты не найдены" });
      const bundleId = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      for (const c of db.driverClients) {
        if (have.includes(c.id)) {
          c.bundleId = bundleId;
          c.bundleAddress = bundleAddress;
        }
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients, bundleId });
    }
    // Разбиение связки: убрать у клиента признак связки (bundleId и общий адрес).
    if (body.action === "unbundle") {
      const id = String(body.id || "");
      const found = db.driverClients.find((c) => c.id === id);
      if (found) {
        delete found.bundleId;
        delete found.bundleAddress;
        await persistDb();
      }
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }
    // Удаление клиента. Проверка имени/адреса здесь не нужна — ветка идёт
    // раньше общей валидации нового клиента.
    if (body.action === "delete") {
      const id = String(body.id || "");
      db.driverClients = db.driverClients.filter((c) => c.id !== id);
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }
    const client = String(body.client || "").slice(0, 200).trim();
    const address = String(body.address || "").slice(0, 500).trim();
    if (!client || !address) return sendJson(res, 400, { error: "Нужно указать клиента и адрес" });
    // Редактирование существующего клиента (исправить имя/адрес).
    if (body.action === "update") {
      const id = String(body.id || "");
      const found = db.driverClients.find((c) => c.id === id);
      if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
      const prevClient = found.client;
      const prevAddress = found.address;
      found.client = client;
      found.address = address;
      // Адрес изменился — старые координаты недействительны, переглокализуем.
      found.lat = null;
      found.lon = null;
      await ensureClientCoords(found);
      // Синхронизация: если адрес или имя клиента изменились, обновляем его
      // точку во ВСЕХ существующих маршрутах (точки маршрута хранят копию
      // «client/address» без id, поэтому сопоставляем по имени — так же, как
      // клиентская форма при открытии маршрута).
      if (prevClient !== client || prevAddress !== address) {
        (db.driverRoutes || []).forEach((r) => {
          (r.clients || []).forEach((p) => {
            if (p && typeof p === "object" && String(p.client) === String(prevClient)) {
              p.client = client;
              p.address = address;
            }
          });
        });
      }
      await persistDb();
      return sendJson(res, 200, { ok: true, clients: db.driverClients });
    }
    const newClient = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      client,
      address,
      bundleId: null,
      addedBy: user.id,
      at: Date.now(),
    };
    await ensureClientCoords(newClient);
    db.driverClients.push(newClient);
    if (db.driverClients.length > 2000) db.driverClients = db.driverClients.slice(-2000);
    await persistDb();
    return sendJson(res, 200, { ok: true, clients: db.driverClients });
  }

  // ---- Логотип клиента (для этикетки отгрузки): POST /api/clients/:id/logo ----
  // Сохраняет data-URL изображения (PNG 58×58) в карточку клиента и синхронизирует
  // его в уже созданные точки маршрутов, сопоставляя по имени клиента — так лого
  // попадает на печатные этикетки без пересохранения маршрута.
  if (urlPath.startsWith("/api/clients/") && urlPath.endsWith("/logo") && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const id = decodeURIComponent(urlPath.slice("/api/clients/".length, -"/logo".length));
    const found = (db.driverClients || []).find((c) => String(c.id) === String(id));
    if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
    const body = await readBody(req);
    let logo = String(body.logo || "").trim();
    if (logo) {
      // Принимаем только PNG/JPEG data-URL нужного размера — защита от мусора в БД.
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
        return sendJson(res, 422, { error: "Некорректный формат изображения" });
      }
      // Ограничиваем размер: 58×58 PNG обычно < 20 КБ; запас под JPEG.
      if (logo.length > 500000) return sendJson(res, 422, { error: "Слишком большое изображение" });
    }
    found.logo = logo || null;
    // Синхронизация лого во все точки маршрутов по имени клиента.
    (db.driverRoutes || []).forEach((r) => {
      (r.clients || []).forEach((p) => {
        if (p && typeof p === "object" && String(p.client) === String(found.client)) {
          p.logo = logo || null;
        }
      });
    });
    await persistDb();
    return sendJson(res, 200, { ok: true, clients: db.driverClients });
  }

  // ---- Аббревиатура логотипа клиента: POST /api/clients/:id/logo-text ----
  // Текстовая «вывеска» для этикетки (например «AVI»), когда у клиента нет картинки-лого.
  // Рисуется на стикере крупным лого-блоком вместо полного названия клиента.
  if (urlPath.startsWith("/api/clients/") && urlPath.endsWith("/logo-text") && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const id = decodeURIComponent(urlPath.slice("/api/clients/".length, -"/logo-text".length));
    const found = (db.driverClients || []).find((c) => String(c.id) === String(id));
    if (!found) return sendJson(res, 404, { error: "Клиент не найден" });
    const body = await readBody(req);
    const logoText = String(body.logoText || "").trim().toUpperCase().slice(0, 5);
    found.logoText = logoText;
    // Синхронизация аббревиатуры во все точки маршрутов по имени клиента.
    (db.driverRoutes || []).forEach((r) => {
      (r.clients || []).forEach((p) => {
        if (p && typeof p === "object" && String(p.client) === String(found.client)) {
          p.logoText = logoText;
        }
      });
    });
    await persistDb();
    return sendJson(res, 200, { ok: true, clients: db.driverClients });
  }

  // ---- Driver routes (маршруты на день) ----
  // ---- Отгрузка (склад): маршруты, ожидающие отгрузки ----
  // Доступ: админ или сотрудник группы склада (см. canSeeShipment).
  if (urlPath === "/api/shipments" && method === "GET") {
    if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
    // В отгрузку попадают маршруты, ещё не запущенные (status === "idle"):
    // склад отгружает клиентов до того, как водитель начнёт объезд.
    // У созданного маршрута progress ещё нет (он появляется при старте или в
    // ответе normalizeRouteProgress), поэтому принимаем маршруты без progress,
    // а также те, что ещё не стали активными/завершёнными.
    const routes = (db.driverRoutes || [])
      .filter((r) => r && (
        !r.progress ||
        (r.progress.status && r.progress.status !== "active" && r.progress.status !== "done")
      ))
      .map(normalizeRouteProgress)
      .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || 0);
    return sendJson(res, 200, { ok: true, routes });
  }

  // Завершить отгрузку маршрута: склад ставит отметку Progress.shippedAt, после
  // чего водитель может начать маршрут (если админ не разрешил игнорировать склад).
  if (urlPath === "/api/shipments/complete" && method === "POST") {
    if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const routeId = String(body.routeId || "");
    const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
    if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
    if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
    route.progress.shippedAt = Date.now();
    route.progress.shippedBy = user.id != null ? String(user.id) : null;
    await persistDb();
    return sendJson(res, 200, { ok: true, route: normalizeRouteProgress(route) });
  }

  // Начать отгрузку маршрута: склад помечает, что приступил к отгрузке клиентов.
  // Промежуточный шаг перед «Завершить отгрузку» (shippedAt) — видно, что склад
  // уже работает с маршрутом, но водитель стартует только после завершения.
  if (urlPath === "/api/shipments/start" && method === "POST") {
    if (!canSeeShipment(user, db)) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const routeId = String(body.routeId || "");
    const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
    if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
    if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
    if (!route.progress.shipmentStartedAt) {
      route.progress.shipmentStartedAt = Date.now();
      route.progress.shipmentStartedBy = user.id != null ? String(user.id) : null;
    }
    await persistDb();
    return sendJson(res, 200, { ok: true, route: normalizeRouteProgress(route) });
  }

  // ---- Этикетки отгрузки (трекинг мест по QR) ----
  // Код этикетки согласован с фронтовой печатью (см. openPrintLabels/doPrintLabels
  // в app.js): "BG<routeId>-<clientIndex+1>-<place>". Здесь clientIndex — 0-based
  // индекс клиента в маршруте (как в select модалки печати).
  const LABEL_STATUS = new Set(["created", "loaded", "delivered"]);

  // Создать этикетки для клиента в маршруте: POST /api/labels { routeId, clientIndex, qty }
  // Пересоздаёт набор мест для этой пары (маршрут+клиент) — склад печатает заново при
  // изменении количества мест. Доступ: склад (как к отгрузке) или админ.
  if (urlPath === "/api/labels" && method === "POST") {
    if (!canSeeShipment(user, db) && !admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const routeId = String(body.routeId || "");
    const clientIndex = Number(body.clientIndex);
    const qty = Math.max(1, Math.min(200, Number(body.qty) || 1));
    const route = (db.driverRoutes || []).find((r) => String(r.id) === String(routeId));
    if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
    const clients = Array.isArray(route.clients) ? route.clients : [];
    if (!Number.isInteger(clientIndex) || clientIndex < 0 || clientIndex >= clients.length) {
      return sendJson(res, 400, { error: "Неверный индекс клиента" });
    }
    const cl = clients[clientIndex];
    // Запоминаем число мест в точке маршрута — чтобы при сканировании можно было
    // воссоздать недостающие этикетки, если по какой-то причине их не было создано
    // при печати (например, старые наклейки) или они потерялись.
    cl.labelQty = qty;
    // Сброс прежних этикеток этой пары (маршрут+клиент) перед новой печатью.
    db.labels = (db.labels || []).filter(
      (l) => !(String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex)
    );
    const now = Date.now();
    for (let i = 1; i <= qty; i++) {
      const code = `BG${routeId}-${clientIndex + 1}-${i}`;
      db.labels.push({
        id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        code,
        routeId: String(routeId),
        clientIndex,
        client: String(cl.client || ""),
        address: String(cl.address || ""),
        place: i,
        status: "created",
        at: now,
        createdBy: user.id != null ? String(user.id) : null,
      });
    }
    // Кап по размеру хранилища этикеток — держим свежие, срезаем старые.
    if (db.labels.length > 8000) db.labels = db.labels.slice(-8000);
    await persistDb();
    const created = db.labels.filter(
      (l) => String(l.routeId) === String(routeId) && Number(l.clientIndex) === clientIndex
    );
    return sendJson(res, 200, { ok: true, labels: created });
  }

  // Сканирование места: POST /api/labels/scan { code, action: "load"|"unload" }
  //  - load   (погрузка, склад):  created → loaded
  //  - unload (выгрузка, водитель): loaded → delivered
  // Возврат несёт этикетку, её код и актуальный статус (для UI и предупреждений).
  if (urlPath === "/api/labels/scan" && method === "POST") {
    const body = await readBody(req);
    const code = String(body.code || "").trim();
    const action = String(body.action || "").trim();
    if (!code) return sendJson(res, 400, { error: "Укажите код этикетки" });
    if (action !== "load" && action !== "unload") return sendJson(res, 400, { error: "Неизвестное действие" });
    // load — погрузка на складе; unload — выгрузка водителем (или админ может оба).
    if (action === "load" && !canSeeShipment(user, db) && !admin) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    if (action === "unload" && !isDriver(user, db) && !admin) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    db.labels = db.labels || [];
    let found = db.labels.find((l) => String(l.code) === String(code));
    // Авто-воссоздание: если этикетка не была зарегистрирована при печати (например,
    // напечатали раньше, до появления хранилища, или печать не создала запись), то
    // по коду «BG<routeId>-<c>-<i>» восстанавливаем недостающие этикетки клиента и
    // продолжаем скан. Это делает сканирование надёжным (не возвращает «не найдена»).
    if (!found) {
      const route = (db.driverRoutes || []).find((rd) => String(code).startsWith("BG" + rd.id + "-"));
      if (route) {
        const suffix = String(code).slice(("BG" + route.id + "-").length); // "<c>-<i>"
        const parts = suffix.split("-");
        const cIdx = Number(parts[0]) - 1;
        const scannedPlace = Number(parts[1]);
        if (Number.isInteger(cIdx) && cIdx >= 0 && cIdx < (route.clients || []).length) {
          const rc = route.clients[cIdx];
          const qty = Math.max(1, Math.min(200, Number(rc && rc.labelQty) || scannedPlace || 1));
          const now2 = Date.now();
          const existingPlaces = new Set(
            db.labels
              .filter((l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === cIdx)
              .map((l) => Number(l.place))
          );
          for (let n = 1; n <= qty; n++) {
            if (existingPlaces.has(n)) continue;
            const c2 = `BG${route.id}-${cIdx + 1}-${n}`;
            db.labels.push({
              id: `${now2.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
              code: c2,
              routeId: String(route.id),
              clientIndex: cIdx,
              client: String(rc.client || ""),
              address: String(rc.address || ""),
              place: n,
              status: "created",
              at: now2,
              createdBy: user.id != null ? String(user.id) : null,
            });
          }
          found = db.labels.find((l) => String(l.code) === String(code));
        }
      }
    }
    if (!found) return sendJson(res, 404, { error: "Этикетка не найдена" });
    const now = Date.now();
    let warning = null;
    if (action === "load") {
      if (found.status === "loaded" || found.status === "delivered") {
        warning = found.status === "delivered" ? "Место уже отгружено и выгружено" : "Место уже погружено";
      } else {
        found.status = "loaded";
        found.loadedAt = now;
        found.loadedBy = user.id != null ? String(user.id) : null;
      }
    } else { // unload
      if (found.status === "created") {
        warning = "Место ещё не погружено (выгружать рано)";
      } else if (found.status === "delivered") {
        warning = "Место уже выгружено";
      } else {
        found.status = "delivered";
        found.deliveredAt = now;
        found.deliveredBy = user.id != null ? String(user.id) : null;
      }
    }
    await persistDb();
    return sendJson(res, 200, { ok: true, label: found, warning });
  }

  // Статус этикеток: GET /api/labels?routeId=..&clientIndex=.. (или ?code=..)
  if (urlPath === "/api/labels" && method === "GET") {
    if (!canSeeShipment(user, db) && !admin && !isDriver(user, db)) {
      return sendJson(res, 403, { error: "forbidden" });
    }
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const routeId = String(params.get("routeId") || "");
    const clientIndex = params.get("clientIndex");
    const code = String(params.get("code") || "");
    let list = db.labels || [];
    if (code) {
      list = list.filter((l) => String(l.code) === String(code));
    } else if (routeId) {
      list = list.filter((l) => String(l.routeId) === String(routeId));
      if (clientIndex !== null && clientIndex !== undefined && clientIndex !== "") {
        const ci = Number(clientIndex);
        if (Number.isInteger(ci)) list = list.filter((l) => Number(l.clientIndex) === ci);
      }
    }
    // Обычно админ/склад ищут по маршруту; водитель базируется на коде из сканера.
    return sendJson(res, 200, { ok: true, labels: list });
  }

  if (urlPath === "/api/drivers/routes" && method === "GET") {
    // Опциональный фильтр по дате (?date=YYYY-MM-DD): маршруты конкретного дня.
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const date = String(params.get("date") || "").slice(0, 10);
    const filterDate = (arr) => (date ? arr.filter((r) => r.date === date) : arr);
    // Админ видит все маршруты; водитель — только свои; остальным — доступ запрещён.
    if (isDriver(user, db) && !admin) {
      const routes = filterDate((db.driverRoutes || []).filter((r) => r.driverId === user.id));
      return sendJson(res, 200, {
        ok: true,
        routes: routes.map((r) => enrichUnloadProgress(normalizeRouteProgress(r), db.labels)),
      });
    }
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    return sendJson(res, 200, {
      ok: true,
      routes: filterDate(db.driverRoutes || []).map((r) => enrichUnloadProgress(normalizeRouteProgress(r), db.labels)),
    });
  }

  // ---- GET /api/deliveries?date=YYYY-MM-DD  — раздел «Доставка».
  //      Доступен ЛЮБОМУ вошедшему (не только админу/водителю). Возвращает
  //      маршруты всех водителей за дату с именами водителей, статусами точек и
  //      прогресса — информационно, чтобы видеть, как едет каждый водитель.
  if (urlPath === "/api/deliveries" && method === "GET") {
    if (!user) return sendJson(res, 401, { error: "forbidden" });
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const date = String(params.get("date") || "").slice(0, 10);
    const list = (date ? (db.driverRoutes || []).filter((r) => r.date === date) : db.driverRoutes || [])
      .map(normalizeRouteProgress)
      .map((r) => ({
        routeId: r.id,
        driverId: String(r.driverId || ""),
        driverName: r.driverName || "",
        routeName: r.routeName || "",
        date: r.date || "",
        status: (r.progress && r.progress.status) || "idle",
        lunchActive: !!(r.progress && r.progress.lunchActive),
        lunchStart: (r.progress && Number.isFinite(r.progress.lunchStart)) ? r.progress.lunchStart : null,
        base: (r.progress && Number.isFinite(r.progress.baseLat) && Number.isFinite(r.progress.baseLon))
          ? { lat: r.progress.baseLat, lon: r.progress.baseLon }
          : null,
        clients: (Array.isArray(r.clients) ? r.clients : []).map((c) => ({
          client: c.client || "",
          address: c.address || "",
          state: c.state || "pending",
          lat: Number.isFinite(c.lat) ? c.lat : null,
          lon: Number.isFinite(c.lon) ? c.lon : null,
          transitStart: Number.isFinite(c.transitStart) ? c.transitStart : null,
          transitEnd: Number.isFinite(c.transitEnd) ? c.transitEnd : null,
          transitPaused: Number.isFinite(c.transitPaused) ? c.transitPaused : 0,
          siteStart: Number.isFinite(c.siteStart) ? c.siteStart : null,
          siteEnd: Number.isFinite(c.siteEnd) ? c.siteEnd : null,
        })),
      }));
    return sendJson(res, 200, { ok: true, date, deliveries: list });
  }

  // ---- POST /api/drivers/routes/check   ({ date, driverId, clientNames, excludeRouteId? })
  // Предварительная проверка пересечений: какие из выбранных клиентов уже есть
  // в других маршрутах того же водителя на ту же дату. Нужна для предупреждения
  // «клиент уже в маршруте» до сохранения (вариант «предупредить, не запрещать»).
  if (urlPath === "/api/drivers/routes/check" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const date = String(body.date || "").slice(0, 10);
    const driverId = String(body.driverId || "").slice(0, 60);
    const excludeRouteId = String(body.excludeRouteId || "");
    const clientNames = Array.isArray(body.clientNames)
      ? body.clientNames.map((n) => String(n || "").trim()).filter(Boolean)
      : [];
    if (!date || !driverId || clientNames.length === 0) {
      return sendJson(res, 200, { ok: true, intersections: [] });
    }
    const nameSet = new Set(clientNames);
    const intersections = [];
    (db.driverRoutes || []).forEach((r) => {
      if (r.date !== date || String(r.driverId) !== String(driverId)) return;
      if (excludeRouteId && String(r.id) === String(excludeRouteId)) return;
      (Array.isArray(r.clients) ? r.clients : []).forEach((p) => {
        if (p && nameSet.has(String(p.client || "").trim())) {
          intersections.push({
            clientName: String(p.client || ""),
            routeName: r.routeName || "Маршрут",
            routeId: r.id,
          });
        }
      });
    });
    return sendJson(res, 200, { ok: true, intersections });
  }

  if (urlPath === "/api/drivers/routes" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    if (body.action === "delete") {
      const id = String(body.id || "");
      db.driverRoutes = (db.driverRoutes || []).filter((r) => r.id !== id);
      await persistDb();
      return sendJson(res, 200, { ok: true, routes: db.driverRoutes });
    }
    // Обновление точек уже созданного маршрута по его id: заменяем состав и
    // порядок остановок (и при необходимости дату/водителя).
    if (body.action === "update") {
      const id = String(body.id || "");
      const found = (db.driverRoutes || []).find((r) => r.id === id);
      if (!found) return sendJson(res, 404, { error: "Маршрут не найден" });
      const clients = Array.isArray(body.clients)
        ? body.clients.slice(0, 50).map((c) => ({
            client: String(c.client || "").slice(0, 200),
            address: String(c.address || "").slice(0, 500),
            bundleId: c.bundleId ? String(c.bundleId).slice(0, 60) : null,
            logo: c.logo ? String(c.logo).slice(0, 200000) : null,
            logoText: String(c.logoText || "").toUpperCase().slice(0, 5),
          })).filter((c) => c.client || c.address)
        : [];
      if (clients.length === 0) return sendJson(res, 400, { error: "Укажите хотя бы одного клиента" });
      if (body.date) found.date = String(body.date).slice(0, 10);
      if (body.driverId) found.driverId = String(body.driverId).slice(0, 60);
      if (body.driverName !== undefined) found.driverName = String(body.driverName || "").slice(0, 200);
      found.clients = clients;
      found.at = Date.now();
      await persistDb();
      return sendJson(res, 200, { ok: true, routes: db.driverRoutes });
    }
    const date = String(body.date || "").slice(0, 10);
    const driverId = String(body.driverId || "").slice(0, 60);
    const driverName = String(body.driverName || "").slice(0, 200);
    const clients = Array.isArray(body.clients)
      ? body.clients.slice(0, 50).map((c) => ({
          client: String(c.client || "").slice(0, 200),
          address: String(c.address || "").slice(0, 500),
          bundleId: c.bundleId ? String(c.bundleId).slice(0, 60) : null,
          logo: c.logo ? String(c.logo).slice(0, 200000) : null,
          logoText: String(c.logoText || "").toUpperCase().slice(0, 5),
        })).filter((c) => c.client || c.address)
      : [];
    if (!date || !driverId || clients.length === 0) {
      return sendJson(res, 400, { error: "Укажите дату, водителя и хотя бы одного клиента" });
    }
    // Автоматическое имя маршрута по текущему времени: Утро (<12), Обед (12–17), Вечер (>17).
    const hour = new Date().getHours();
    const routeName = hour < 12 ? "Утро" : (hour < 17 ? "Обед" : "Вечер");
    db.driverRoutes = db.driverRoutes || [];
    // На одну дату у водителя один маршрут на слот (Утро/Обед/Вечер): повторное
    // создание того же слота заменяет существующий, а не плодит дубликаты.
    const existIdx = db.driverRoutes.findIndex(
      (r) => r.date === date && r.driverId === driverId && r.routeName === routeName
    );
    if (existIdx >= 0) {
      db.driverRoutes[existIdx].clients = clients;
      db.driverRoutes[existIdx].at = Date.now();
    } else {
      db.driverRoutes.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        date,
        driverId,
        driverName,
        routeName,
        clients,
        addedBy: user.id,
        at: Date.now(),
      });
    }
    if (db.driverRoutes.length > 3000) db.driverRoutes = db.driverRoutes.slice(-3000);
    await persistDb();
    return sendJson(res, 200, { ok: true, routes: db.driverRoutes });
  }

  // ---- POST /api/drivers/routes/optimize   ({ clientIds, baseAddress? })
  // Автопостроение маршрута по адресам выбранных клиентов: геокодирует адреса
  // (Яндекс.Карты), при необходимости задаёт стартовую точку (база) и считает
  // оптимальный порядок объезда (жадный «ближайший сосед»). Возвращает порядок
  // clientIds и обновлённые координаты, чтобы клиент их закешировал.
  if (urlPath === "/api/drivers/routes/optimize" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const ids = Array.isArray(body.clientIds) ? body.clientIds.map(String).filter(Boolean) : [];
    if (ids.length === 0) return sendJson(res, 400, { error: "Выберите клиентов для маршрута" });
    const points = ids
      .map((id) => db.driverClients.find((c) => c.id === id))
      .filter(Boolean);
    if (points.length === 0) return sendJson(res, 400, { error: "Клиенты не найдены" });

    // Геокодируем недостающие координаты (последовательно, безопасно к таймаутам).
    for (const p of points) {
      try { await ensureClientCoords(p); } catch { /* не критично */ }
    }

    // Стартовая точка (база) — опционально, по адресу из запроса.
    let base = null;
    const baseAddress = String(body.baseAddress || "").trim();
    if (baseAddress) {
      try { base = await geocodeAddress(baseAddress); } catch { base = null; }
    }

    // Клиенты с координатами участвуют в оптимизации; без координат — в конец
    // списка в исходном порядке.
    const geo = points.map((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    const geoIdx = points.map((_, i) => i).filter((i) => geo[i]);
    const ungeoIdx = points.map((_, i) => i).filter((i) => !geo[i]);

    // Кластеризация по адресу: клиенты с одинаковым адресом — это одна
    // «остановка» и всегда идут подряд, не разбиваясь другими клиентами
    // (частая реальность маршрутного листа: несколько заказов на один адрес).
    // Оптимизируем порядок остановок, а внутри каждой остановки сохраняем
    // исходный порядок выбранных клиентов.
    let order;
    let withBase = false;
    let method = "straight"; // какой алгоритм реально сработал (для честного UI)
    if (geoIdx.length <= 1) {
      method = "trivial"; // точек для оптимизации нет — предупреждение не нужно
      order = geoIdx.concat(ungeoIdx);
    } else {
      const geoPoints = geoIdx.map((i) => points[i]);
      const keyOf = (p) => String(p.bundleAddress || p.address || "").trim().toLowerCase();
      const groups = [];
      const byKey = new Map();
      for (let i = 0; i < geoPoints.length; i++) {
        const key = keyOf(geoPoints[i]) || "__a" + i;
        let g = byKey.get(key);
        if (!g) {
          g = { idxs: [], lat: geoPoints[i].lat, lon: geoPoints[i].lon };
          byKey.set(key, g);
          groups.push(g);
        }
        g.idxs.push(i);
      }
      // Представитель каждой остановки — её координаты (первый клиент группы).
      const reps = groups.map((g) => ({ lat: g.lat, lon: g.lon }));
      withBase = !!(base && Number.isFinite(base.lat) && Number.isFinite(base.lon));
      const osmPoints = withBase ? [base].concat(reps) : reps.slice();

      let nn = null;
      // 1) TomTom (ключ) — реальное время с учётом пробок.
      // 2) OSRM — реальные дороги без пробок.
      // 3) Гаверсинус — «по прямой» (если оба не ответили / нет ключа).
      try {
        const matrix = await tomtomDurationMatrix(osmPoints);
        if (matrix && matrix.length >= osmPoints.length &&
            !matrix.some((row) => row.some((t) => !Number.isFinite(t)))) {
          nn = nearestByTime(reps, matrix, withBase, osmPoints);
          method = "tomtom";
        }
      } catch { /* запасной */ }
      try {
        if (!nn) {
          const matrix = await osrmDurationMatrix(osmPoints);
          nn = (matrix && matrix.length >= osmPoints.length)
            ? nearestByTime(reps, matrix, withBase, osmPoints)
            : null;
          if (nn) method = "osrm";
        }
      } catch { /* запасной */ }
      if (!nn) nn = nearestNeighbor(reps, base); // метод остаётся "straight"

      // Разворачиваем порядок остановок в порядок отдельных клиентов:
      // клиенты каждой остановки идут подряд в исходном порядке.
      const flat = [];
      for (const gIdx of nn) {
        const g = groups[gIdx];
        if (!g) continue;
        for (const ci of g.idxs) flat.push(ci);
      }
      order = flat.map((k) => geoIdx[k]).concat(ungeoIdx);
    }

    await persistDb(); // сохранить догeокодированные координаты клиентов
    return sendJson(res, 200, {
      ok: true,
      order: order.map((i) => points[i].id),
      // Клиенты без распознанных координат: их адрес не удалось геокодировать
      // (побитый/название вместо адреса, недоступный геосервис). Они стоят в
      // конце исходного порядка и не участвуют в оптимизации.
      unresolved: ungeoIdx.map((i) => points[i].id),
      // Честный статус построения, чтобы интерфейс мог предупредить:
      //  - method: "tomtom" | "osrm" | "straight" — каким алгоритмом построен
      //    маршрут ("straight" = реальные дороги не сработали, порядок по прямой);
      //  - baseUnresolved: true, когда адрес базы задан, но распознать его
      //    не удалось — тогда маршрут строится от первого адреса, а не от базы.
      method,
      baseUnresolved: withBase === false && !!String(body.baseAddress || "").trim(),
      clients: points.map((p) => ({
        id: p.id,
        lat: Number.isFinite(p.lat) ? p.lat : null,
        lon: Number.isFinite(p.lon) ? p.lon : null,
      })),
    });
  }

  // ---- POST /api/drivers/routes/action   ({ routeId, action })
  // Действия водителя по маршруту. Автоматически переключает стадии точек и
  // считает время в пути к точке и время на точке.
  //   action = "start"        – начать маршрут (первая точка → в пути)
  //   action = "arrive"       – прибыл на адрес (стоп времени пути, старт времени на точке)
  //   action = "deliver"      – завершить сдачу (стоп времени на точке, старт пути к следующей)
  //   action = "arrive_base"  – прибыл на базу (маршрут завершён)
  if (urlPath === "/api/drivers/routes/action" && method === "POST") {
    const body = await readBody(req);
    const routeId = String(body.routeId || "");
    const action = String(body.action || "");
    const route = (db.driverRoutes || []).find((r) => r.id === routeId);
    if (!route) return sendJson(res, 404, { error: "Маршрут не найден" });
    // Только владелец маршрута или администратор.
    if (String(route.driverId) !== String(user.id) && !isAdmin(user, db)) {
      return sendJson(res, 403, { error: "forbidden" });
    }

    // Подготовить точки: каждая несёт id, стадию и таймстемпы.
    const now = Date.now();
    if (!route.progress) route.progress = { status: "idle", baseLat: null, baseLon: null, baseAddress: "" };
    // Поля обеда внутри маршрута (вариант 2: обед не исключается из рабочего
    // времени, а фиксируется как «остановка» внутри маршрута, чтобы потом по
    // интервалам строить временные отрезки в отчёте). Нормализуем на случай
    // маршрутов, созданных до появления этой функциональности.
    if (!route.progress.lunchActive) route.progress.lunchActive = false;
    if (route.progress.lunchStart == null) route.progress.lunchStart = null;
    if (!Array.isArray(route.progress.lunchHistory)) route.progress.lunchHistory = [];
    // Отказоустойчивость: битые / необъектные записи точек (null, строки и т.п.)
    // могли попасть в БД из реальных данных. Их отбрасываем, чтобы ручная
    // обработка ниже и поиск стадий не падали с TypeError, а маршрут с
    // оставшимися валидными точками продолжал работать.
    route.clients = (Array.isArray(route.clients) ? route.clients : [])
      .filter((c) => !!c && typeof c === "object")
      .map((c, i) => {
        if (!c.id) c.id = `${route.id}-st${i + 1}`;
        c.state = c.state || "pending";
        c.transitStart = c.transitStart || null;
        c.transitEnd = c.transitEnd || null;
        c.siteStart = c.siteStart || null;
        c.siteEnd = c.siteEnd || null;
        c.transitPaused = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
        c.postponeReason = c.postponeReason || null;
        return c;
      });
    if (route.clients.length === 0) return sendJson(res, 400, { error: "В маршруте нет точек" });

    const indexOfState = (st) => route.clients.findIndex((c) => c.state === st);
    const activeIdx = indexOfState("in_transit") >= 0 ? indexOfState("in_transit")
      : indexOfState("on_site");
    const nextPendingIdx = indexOfState("pending");

    // Группы «в связке»: несколько клиентов на одном адресе (созданы через связку)
    // обрабатываются водителем как одна точка — кнопки применяются ко всей группе,
    // а время (прибытие/уход) фиксируется один раз для всех участников связки.
    // Ключ группы: bundleId (если сохранён) или одинаковый адрес (фолбэк для
    // маршрутов, созданных до появления bundleId в точках).
    const bundleKeyOf = (c) => {
      if (c && c.bundleId) return "b:" + String(c.bundleId);
      const a = String(c && c.address || "").trim().toLowerCase();
      return a ? "a:" + a : "";
    };
    const groupMap = new Map();
    route.clients.forEach((c, i) => {
      const k = bundleKeyOf(c);
      if (!k) return;
      if (!groupMap.has(k)) groupMap.set(k, []);
      groupMap.get(k).push(i);
    });
    const groupOf = (idx) => {
      const k = bundleKeyOf(route.clients[idx]);
      return (k && groupMap.get(k)) || [idx];
    };
    // Переводит группу точек в указанную стадию с единым временем.
    const setGroupInTransit = (indices, t) => {
      indices.forEach((i) => {
        route.clients[i].state = "in_transit";
        route.clients[i].transitStart = t;
        route.clients[i].transitPaused = 0;
      });
    };
    // Стандартный успешный ответ действия: нормализованный маршрут, обогащённый
    // счётчиком выгрузки мест клиентов. Клонируем (normalizeRouteProgress), чтобы
    // вычисляемые поля unloadTotal/unloadDone/unloadReady не попали в БД.
    const routeResp = () =>
      ({ ok: true, route: enrichUnloadProgress(normalizeRouteProgress(route), db.labels) });

    // «Рабочий день завершён» определяется из основного таймера: у водителя в этот
    // день есть закрытый (с указанным концом) work-сегмент. Тогда взять новый
    // маршрут в работу нельзя.
    const dayFinished = () => {
      const rec = db.days[route.date] || {};
      const segs = Array.isArray(segmentsFor(user.id, rec)) ? segmentsFor(user.id, rec) : [];
      // Защита от битых/мусорных записей в сегментах дня: элемент может быть
      // null или не-объектом, обращение s.kind на нём роняло сервер (500).
      return segs.some((s) => !!s && typeof s === "object" && s.kind === "work" && s.end != null);
    };

    if (action === "start") {
      if (route.progress.status === "done") {
        return sendJson(res, 409, { error: "Маршрут уже завершён" });
      }
      if (dayFinished()) {
        return sendJson(res, 409, { error: "Рабочий день завершён — новый маршрут взять нельзя" });
      }
      // Пока админ не включил «начать маршрут без отгрузки», водитель не может
      // стартовать маршрут, пока склад не завершил отгрузку (progress.shippedAt).
      const allowIgnoreShipment = db.params && db.params.allowDriverStartWithoutShipment === true;
      if (!allowIgnoreShipment && !route.progress.shippedAt) {
        return sendJson(res, 409, { error: "Маршрут ещё не отгружен складом — запуск недоступен" });
      }
      route.progress.status = "active";
      const first = route.clients.find((c) => c.state === "pending");
      if (first) {
        // Если первая точка входит в связку (один адрес), в путь уходит вся её
        // группа с единым временем старта — кнопки применяются ко всем.
        const firstGroup = groupOf(route.clients.indexOf(first))
          .filter((i) => route.clients[i].state === "pending");
        setGroupInTransit(firstGroup, now);
      }
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    if (action === "arrive") {
      if (route.progress.status !== "active") {
        return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
      }
      // Пока водитель на обеде, зафиксировать «прибытие» нельзя: обед — это
      // остановка между точками, и она не должна попадать в учёт пути/точки.
      if (route.progress.lunchActive === true) {
        return sendJson(res, 409, { error: "Сначала вернитесь с обеда" });
      }
      const cur = route.clients[activeIdx];
      if (!cur || cur.state !== "in_transit") {
        return sendJson(res, 409, { error: "Нет точки, в которую вы сейчас едете" });
      }
      // Прибытие в связке: вся группа (все члены, что в пути) переходит в
      // «на точке» с единым временем — действие применилось ко всем клиентам.
      groupOf(activeIdx)
        .filter((i) => route.clients[i].state === "in_transit")
        .forEach((i) => {
          route.clients[i].transitEnd = now;
          route.clients[i].state = "on_site";
          route.clients[i].siteStart = now;
        });
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    if (action === "deliver") {
      if (route.progress.status !== "active") {
        return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
      }
      const cur = route.clients[activeIdx];
      if (!cur || cur.state !== "on_site") {
        return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
      }
      // Сдача в связке: вся группа (все «на точке») завершается с единым
      // временем, затем вся следующая группа уходит в путь.
      groupOf(activeIdx)
        .filter((i) => route.clients[i].state === "on_site")
        .forEach((i) => {
          route.clients[i].siteEnd = now;
          route.clients[i].state = "delivered";
        });
      const nextIdx = nextPendingIdx;
      if (nextIdx >= 0) {
        // Поехали к следующей точке — время пути к ней пошло; если следующая
        // точка в связке, в путь уходит вся её группа.
        const nextGroup = groupOf(nextIdx)
          .filter((i) => route.clients[i].state === "pending");
        setGroupInTransit(nextGroup, now);
      }
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    // «Перенос» точки: водитель прибыл на адрес, но не сдал — точка закрывается
    // с пометкой переноса и причиной. Логика времени как у «Завершить сдачу»:
    // фиксируется конец времени на точке и переход к следующей.
    if (action === "postpone") {
      if (route.progress.status !== "active") {
        return sendJson(res, 409, { error: "Сначала нажмите «Начать маршрут»" });
      }
      if (route.progress.lunchActive === true) {
        return sendJson(res, 409, { error: "Сначала вернитесь с обеда" });
      }
      const cur = route.clients[activeIdx];
      if (!cur || cur.state !== "on_site") {
        return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
      }
      const reason = String(body.postponeReason || body.reason || "").trim().slice(0, 200);
      if (!reason) {
        return sendJson(res, 400, { error: "Укажите причину переноса" });
      }
      // Перенос в связке: вся группа («на точке») переносится с единым временем
      // и общей причиной, затем следующая группа уходит в путь.
      groupOf(activeIdx)
        .filter((i) => route.clients[i].state === "on_site")
        .forEach((i) => {
          route.clients[i].siteEnd = now;
          route.clients[i].state = "postponed";
          route.clients[i].postponeReason = reason;
        });
      const nextIdx = nextPendingIdx;
      if (nextIdx >= 0) {
        const nextGroup = groupOf(nextIdx)
          .filter((i) => route.clients[i].state === "pending");
        setGroupInTransit(nextGroup, now);
      }
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    // «Завершить выгрузку»: водитель отсканировал места клиента на выгрузку.
    // Отмечает завершение выгрузки (флаг unloadFinished на точке/связке), но НЕ
    // переводит точку в delivered и НЕ закрывает время на точке — водитель всё
    // ещё стоит у клиента и ждёт приёмки (время сдачи продолжает считаться,
    // пока он не нажмёт «Завершить сдачу»). По умолчанию завершить выгрузку
    // можно только когда отсканированы все места клиента; если админ включил
    // параметр allowFinishUnloadIncomplete — разрешаем и при неполном скане.
    if (action === "finish_unload") {
      if (route.progress.status !== "active") {
        return sendJson(res, 409, { error: "Сначала начните маршрут" });
      }
      const cur = route.clients[activeIdx];
      if (!cur || cur.state !== "on_site") {
        return sendJson(res, 409, { error: "Нет точки, на которой вы сейчас находитесь" });
      }
      // Сколько мест клиента (по routeId + индексу точки) уже выгружено.
      const ci = activeIdx;
      const mine = (db.labels || []).filter(
        (l) => String(l.routeId) === String(route.id) && Number(l.clientIndex) === ci
      );
      const total = mine.length;
      const done = mine.filter((l) => l.status === "delivered").length;
      const allowIncomplete = db.params && db.params.allowFinishUnloadIncomplete === true;
      if (total > 0 && done < total && !allowIncomplete) {
        return sendJson(res, 409, { error: `Осталось отсканировать мест: ${total - done}` });
      }
      // Помечаем завершение выгрузки всей группе (связке), стадию не меняем.
      groupOf(activeIdx).forEach((i) => {
        route.clients[i].unloadFinished = true;
      });
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    if (action === "arrive_base") {
      if (route.progress.status !== "active") {
        return sendJson(res, 409, { error: "Сначала начните маршрут" });
      }
      // Закрытые точки — сданные ИЛИ перенесённые; только тогда маршрут можно
      // завершить прибытием на базу.
      const closedStates = new Set(["delivered", "postponed"]);
      const pendingLeft = route.clients.some((c) => !closedStates.has(c.state));
      if (pendingLeft) {
        return sendJson(res, 409, { error: "Сначала завершите все точки маршрута" });
      }
      route.progress.status = "done";
      route.progress.baseArrivedAt = now;
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    // Переключение «Обед» внутри маршрута. Обед доступен ТОЛЬКО на активном
    // маршруте после завершения сдачи хотя бы одной точки (водитель движется к
    // следующей). На закрытом (завершённом) маршруте кнопки/действия нет —
    // нажать «Обед» нельзя. Пока идёт обед, время в пути к текущей точке не
    // растёт: интервал обеда копится и при завершении вычитается из времени
    // пути (transitPaused). Сам перерыв НЕ исключается из рабочего времени и
    // оплаты: фиксируется интервал, чтобы по нему строить временные отрезки.
    if (action === "lunch") {
      // Обед доступен после закрытия хотя бы одной точки — сданной ИЛИ перенесённой.
      const completedSome = route.clients.some((c) => c.state === "delivered" || c.state === "postponed");
      const allowed = route.progress.status === "active" && completedSome;
      if (!allowed) {
        return sendJson(res, 409, { error: "Обед доступен на активном маршруте после сдачи или переноса точки" });
      }
      if (!route.progress.lunchActive) {
        route.progress.lunchActive = true;
        route.progress.lunchStart = now;
      } else {
        route.progress.lunchHistory.push({ from: route.progress.lunchStart, to: now });
        // Время обеда, пришедшееся на текущий отрезок пути (точку, к которой
        // сейчас едем), исключаем из учёта времени в пути: копим суммарную
        // паузу в transitPaused этой точки.
        const cur = route.clients[activeIdx];
        if (cur && cur.state === "in_transit" && Number.isFinite(route.progress.lunchStart)) {
          cur.transitPaused = Number.isFinite(cur.transitPaused) ? cur.transitPaused : 0;
          cur.transitPaused += Math.max(0, now - route.progress.lunchStart);
        }
        route.progress.lunchStart = null;
        route.progress.lunchActive = false;
      }
      await persistDb();
      return sendJson(res, 200, routeResp());
    }

    return sendJson(res, 400, { error: "Неизвестное действие" });
  }

  // ---- POST /api/drivers/location  ({ lat, lon, routeId? })  — водитель шлёт
  //      свои текущие координаты (геолокация, пока приложение в фокусе).
  //      Хранится in-memory и используется для живой карты в «Отчёте».
  if (urlPath === "/api/drivers/location" && method === "POST") {
    if (!isDriver(user, db)) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return sendJson(res, 422, { error: "bad coordinates" });
    }
    const uid = String(user.id);
    const atNow = Date.now();
    db.liveLocations[uid] = {
      lat, lon, at: atNow,
      name: user.name || "",
      routeId: body.routeId != null ? String(body.routeId) : "",
    };
    // Накопление трека (история точек): не дублируем точку, если водитель почти
    // не двигался (порог ~11 м) и интервал мал — иначе линия на карте «сгущается».
    const tr = db.tracks[uid] || (db.tracks[uid] = []);
    const last = tr[tr.length - 1];
    const moved = !last
      || Math.abs(last.lat - lat) > 1e-4
      || Math.abs(last.lon - lon) > 1e-4
      || (atNow - last.at) > 30000;
    if (moved) tr.push({ lat, lon, at: atNow });
    // Персистентный след за день: ту же «значимую» точку кладём в дневной трек,
    // с прореживанием (не чаще ~20 с), чтобы файл в /data не раздувался.
    const dayK = motionDayKey(atNow);
    const dTrack = (tracksByDay[dayK] || (tracksByDay[dayK] = {}))[uid] ||
      ((tracksByDay[dayK][uid] = []));
    const dLast = dTrack[dTrack.length - 1];
    if (!dLast || (atNow - dLast[2]) >= 20000 || Math.abs(dLast[0] - lat) > 5e-4 || Math.abs(dLast[1] - lon) > 5e-4) {
      dTrack.push([lat, lon, atNow]);
      if (dTrack.length > 4000) dTrack.splice(0, dTrack.length - 4000);
      // Храним не более 60 дней истории.
      const cutoff = motionDayKey(atNow - 60 * 24 * 3600000);
      Object.keys(tracksByDay).forEach((k) => { if (k < cutoff) delete tracksByDay[k]; });
      scheduleTracksSave();
    }
    // Не храним точки старше 6 часов и дольше 500 точек на водителя.
    while (tr.length && atNow - tr[0].at > 6 * 3600000) tr.shift();
    if (tr.length > 500) tr.splice(0, tr.length - 500);
    return sendJson(res, 200, { ok: true });
  }

  // ---- GET /api/drivers/location  — администратор получает живые координаты
  //      всех водителей для карты. Отдаём только свежие (не старше 10 минут),
  //      чтобы на карте не висели «пропавшие» метки давно закрытых сессий.
  if (urlPath === "/api/drivers/location" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const now = Date.now();
    const freshWindow = 10 * 60 * 1000;
    const rows = [];
    for (const [id, loc] of Object.entries(db.liveLocations || {})) {
      // Показываем на карте только АКТУАЛЬНЫХ водителей. Если пользователь убран
      // из группы «Водители» уже после того, как слал геолокацию, его устаревшая
      // запись оставалась в памяти до 10 минут и продолжала рисоваться на карте.
      // Здесь мы проверяем текущую роль и попутно вычищаем осиротевшие данные.
      if (!isDriver({ id }, db)) {
        delete db.liveLocations[id];
        delete db.tracks[id];
        continue;
      }
      if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) continue;
      if (now - loc.at > freshWindow) continue;
      // Трек (до 300 точек на водителя) во фронт не передаём: карта рисует только
      // текущее положение, а тянуть точки раз в 10 с впустую замедляет карту.
      rows.push({ id, name: loc.name || "", lat: loc.lat, lon: loc.lon, at: loc.at, routeId: loc.routeId || "" });
    }
    return sendJson(res, 200, { ok: true, rows });
  }

  // ---- GET /api/drivers/tracks  (admin)  — GPS-следы водителей для отрисовки
  //      реального пройденного пути на карте. Отдаётся редким запросом (~раз в
  //      30 с), отдельно от компактных позиций /api/drivers/location, чтобы не
  //      тянуть точки трека при каждом тике карты. Поддерживает ?date=YYYY-MM-DD:
  //      возвращает след за выбранный день из персистентного хранилища tracksByDay.
  if (urlPath === "/api/drivers/tracks" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const date = params.get("date") || motionDayKey(Date.now());
    const day = tracksByDay[date] || {};
    const staff = Array.isArray(db.staff) ? db.staff : [];
    const nameOf = (id) => {
      const s = staff.find((x) => x && String(x.id) === String(id));
      return (s && s.name) || "";
    };
    const tracks = [];
    for (const [id, pts] of Object.entries(day)) {
      if (!isDriver({ id }, db)) continue;
      const coords = (pts || []).map((p) => [p[0], p[1]]).filter((p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
      );
      if (!coords.length) continue;
      tracks.push({ id, name: nameOf(id), track: coords });
    }
    return sendJson(res, 200, { ok: true, tracks });
  }

  // ---- GET /api/drivers/tracks/snapped?date=YYYY-MM-DD  (admin)
  //      — те же GPS-следы, но ПРИВЯЗАННЫЕ К ДОРОЖНОЙ СЕТИ («как в навигаторе»).
  //      Результат берётся из кэша; если его ещё нет — запускается фоновый расчёт
  //      через OSRM /match, а в этом ответе отдаётся исходный след (следующее
  //      обновление карты уже вернёт дорожный путь). Ответ не блокируется на OSRM.
  if (urlPath === "/api/drivers/tracks/snapped" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    const date = params.get("date") || motionDayKey(Date.now());
    const day = tracksByDay[date] || {};
    const staff = Array.isArray(db.staff) ? db.staff : [];
    const nameOf = (id) => {
      const s = staff.find((x) => x && String(x.id) === String(id));
      return (s && s.name) || "";
    };
    const tracks = [];
    for (const [id, pts] of Object.entries(day)) {
      if (!isDriver({ id }, db)) continue;
      const coords = (pts || []).map((p) => [p[0], p[1]]).filter((p) =>
        Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
      );
      if (!coords.length) continue;
      const key = `${date}:${id}`;
      const cached = snappedTracks[key];
      if (Array.isArray(cached) && cached.length >= 2) {
        tracks.push({ id, name: nameOf(id), track: cached, snapped: true });
      } else {
        // Кэша нет — считаем в фоне, сейчас отдаём исходный след.
        tracks.push({ id, name: nameOf(id), track: coords, snapped: false });
        snapTrackToRoads(coords).then((roadPath) => {
          if (roadPath && roadPath.length >= 2) {
            snappedTracks[key] = roadPath;
            scheduleSnappedSave();
          }
        }).catch(() => {});
      }
    }
    return sendJson(res, 200, { ok: true, tracks });
  }

  // ---- GET /api/drivers/motion?date=YYYY-MM-DD  (admin)  — дашборд движения
  //      водителей по маршрутам за дату. Считается из точных интервалов,
  //      которые водитель фиксирует нажатиями в приложении:
  //        · время в пути до точки  = transitEnd − transitStart − transitPaused
  //          (интервал обеда, попавший на перегон, вычитается);
  //        · время стоянки на точке = siteEnd − siteStart;
  //        · время обеда            = сумма lunchHistory;
  //        · пробег                 = гаверсинус по порядку точек маршрута
  //          (база → точки → возврат на базу).
  // Активный маршрут, по которому водитель едет прямо сейчас, считается «на
  // сейчас»: незакрытые transitEnd/siteEnd заменяются на текущее время.
  if (urlPath === "/api/drivers/motion" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const q = req.url.split("?")[1] || "";
    const params = new URLSearchParams(q);
    let date = params.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = motionDayKey(Date.now());
    const now = Date.now();
    const agg = {}; // driverId -> { name, km, moveSec, siteSec, lunchSec, points }
    (db.driverRoutes || []).forEach((r) => {
      if (!r || r.date !== date) return;
      const prog = r.progress || {};
      const totalLunch = (Array.isArray(prog.lunchHistory) ? prog.lunchHistory : [])
        .reduce((s, h) => {
          if (h && Number.isFinite(h.from) && Number.isFinite(h.to) && h.to > h.from) return s + (h.to - h.from);
          return s;
        }, 0);
      // Пробег по порядку: база → точки маршрута.
      const path = [];
      if (Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
        path.push({ lat: prog.baseLat, lon: prog.baseLon });
      }
      let moveSec = 0, siteSec = 0, points = 0;
      (Array.isArray(r.clients) ? r.clients : []).forEach((c) => {
        if (!c) return;
        if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) path.push({ lat: c.lat, lon: c.lon });
        const tp = Number.isFinite(c.transitPaused) ? c.transitPaused : 0;
        let ts = Number.isFinite(c.transitStart) ? c.transitStart : 0;
        let te = Number.isFinite(c.transitEnd) ? c.transitEnd : 0;
        let ss = Number.isFinite(c.siteStart) ? c.siteStart : 0;
        let se = Number.isFinite(c.siteEnd) ? c.siteEnd : 0;
        // Живые (незакрытые) интервалы активного маршрута — считаем на сейчас.
        if (c.state === "in_transit" && ts && !te) te = now;
        if (c.state === "on_site" && ss && !se) se = now;
        if (ts && te && te > ts) moveSec += Math.max(0, te - ts - tp);   // время в пути до точки
        if (ss && se && se > ss) siteSec += se - ss;                      // время на точке
        points += 1;
      });
      // Возврат на базу — последний отрезок, если маршрут завершён или активен.
      if (path.length >= 2 && Number.isFinite(prog.baseLat) && Number.isFinite(prog.baseLon)) {
        path.push({ lat: prog.baseLat, lon: prog.baseLon });
      }
      let km = 0;
      for (let i = 1; i < path.length; i++) {
        if (path[i - 1] && path[i]) km += haversineKm(path[i - 1], path[i]);
      }
      const key = String(r.driverId);
      const a = agg[key] || (agg[key] = { name: r.driverName || key, km: 0, moveSec: 0, siteSec: 0, lunchSec: 0, points: 0 });
      a.km += km;
      a.moveSec += moveSec;
      a.siteSec += siteSec;
      a.lunchSec += totalLunch;
      a.points += points;
    });
    // Пробег из ФАКТИЧЕСКОГО GPS-трека водителя за день (фиксируется водителем
    // через /api/drivers/location). Он надёжнее геометрии маршрута «по прямой»:
    // показывает реально проеханные километры по дорогам. Если трек есть —
    // берём его, иначе оставляем геометрию маршрута (как раньше).
    const dayTracks = tracksByDay[date] || {};
    for (const [id, e] of Object.entries(agg)) {
      const tr = dayTracks[id] || [];
      if (tr.length >= 2) {
        let tk = 0;
        for (let i = 1; i < tr.length; i++) {
          const a = tr[i - 1], b = tr[i];
          if (Array.isArray(a) && Array.isArray(b) &&
              Number.isFinite(a[0]) && Number.isFinite(a[1]) &&
              Number.isFinite(b[0]) && Number.isFinite(b[1])) {
            tk += haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] });
          }
        }
        e.km = Math.round(tk * 10) / 10;
        e.kmSource = "gps";
      } else {
        e.km = Math.round(e.km * 10) / 10;
        e.kmSource = "route";
      }
    }
    const rows = Object.entries(agg).map(([id, e]) => ({
      id,
      name: e.name,
      km: e.km,
      kmSource: e.kmSource,
      moveSec: Math.round(e.moveSec / 1000),
      siteSec: Math.round(e.siteSec / 1000),
      lunchSec: Math.round(e.lunchSec / 1000),
      points: e.points,
    })).sort((x, y) => (y.km - x.km) || (y.moveSec - x.moveSec));
    return sendJson(res, 200, { ok: true, date, rows });
  }

  // ---- GET /api/maps/config  (admin)  — отдаём фронту ключ JavaScript API
  //      Яндекс.Карт для живой карты в «Отчёте» маршрутизации.
  if (urlPath === "/api/maps/config" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    return sendJson(res, 200, { ok: true, yandexKey: YANDEX_MAPS_KEY });
  }

  // ---- GET /api/app/update-info  — информация об актуальной версии Android-APK.
  //      Отдаётся любому вошедшему (водителю тоже), чтобы его обёртка могла
  //      сверить версию и предложить обновление.
  //      Приоритет значений: настройки приложения (db.params.update*) →
  //      переменные окружения APP_UPDATE_* → жёсткие дефолты ниже.
  if (urlPath === "/api/app/update-info" && method === "GET") {
    const p = db.params || {};
    const vc = p.updateVersionCode != null
      ? p.updateVersionCode
      : Number(process.env.APP_UPDATE_VERSION_CODE || 4);
    const vn = p.updateVersionName
      ? String(p.updateVersionName)
      : String(process.env.APP_UPDATE_VERSION_NAME || "1.0.3");
    const url = p.updateApkUrl
      ? String(p.updateApkUrl)
      : String(
          process.env.APP_UPDATE_APK_URL ||
            "https://github.com/andreyahmedov29-droid/biotime-android/releases/download/biotime-apk-latest/app-release.apk"
        );
    const notes = p.updateNotes
      ? String(p.updateNotes)
      : String(process.env.APP_UPDATE_NOTES || "Обновление: исправления и улучшения");
    return sendJson(res, 200, {
      ok: true,
      versionCode: vc,
      versionName: vn,
      apkUrl: url,
      notes: notes,
      updatedAt: new Date().toISOString(),
    });
  }

  // ---- POST /api/log/clear ----
  if (urlPath === "/api/log/clear" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    db.log = [];
    await persistDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- GET /api/groups (admin: all groups) ----
  if (urlPath === "/api/groups" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    return sendJson(res, 200, { groups: db.groups });
  }

  // ---- POST /api/groups  { name }  (admin creates a group) ----
  if (urlPath === "/api/groups" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 120);
    if (!name) return sendJson(res, 422, { error: "name required" });
    const group = { id: "g-" + crypto.randomBytes(5).toString("hex"), name, memberIds: [], moderatorId: null };
    db.groups.push(group);
    await persistDb();
    return sendJson(res, 200, { ok: true, group, groups: db.groups });
  }

  // ---- PUT /api/groups/:id  { name?, memberIds?, moderatorId? }  (admin) ----
  const gm = urlPath.match(/^\/api\/groups\/(.+)$/) || null;
  if (gm && method === "PUT") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const id = gm[1];
    const group = db.groups.find((g) => g.id === id);
    if (!group) return sendJson(res, 404, { error: "group not found" });
    const body = await readBody(req);
    if (typeof body.name === "string") {
      const n = body.name.trim().slice(0, 120);
      if (n) group.name = n;
    }
    if (Array.isArray(body.memberIds)) {
      group.memberIds = [...new Set(body.memberIds.map(String).filter((mid) => db.staff.some((s) => s.id === mid)))];
    }
    if (body.moderatorId === null || body.moderatorId === "") {
      group.moderatorId = null;
    } else if (typeof body.moderatorId === "string" && db.staff.some((s) => s.id === body.moderatorId)) {
      group.moderatorId = body.moderatorId;
    }
    await persistDb();
    return sendJson(res, 200, { ok: true, groups: db.groups });
  }

  // ---- DELETE /api/groups/:id (admin deletes a group) ----
  if (gm && method === "DELETE") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    db.groups = db.groups.filter((g) => g.id !== gm[1]);
    await persistDb();
    return sendJson(res, 200, { ok: true, groups: db.groups });
  }

  // ---- GET /api/report/export?month=YYYY-MM  (admin; downloads the timesheet as .xlsx) ----
  if (urlPath === "/api/report/export" && method === "GET") {
    // Admins export the whole company; a moderator exports only their group.
    if (!admin && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
    const month = String((new URL(req.url, `http://${req.headers.host}`).searchParams.get("month")) || "");
    const mm = /^(\d{4})-(\d{2})$/.exec(month);
    if (!mm) return sendJson(res, 422, { error: "bad month; expected YYYY-MM" });
    const year = Number(mm[1]);
    const m0 = Number(mm[2]) - 1;
    if (m0 < 0 || m0 > 11) return sendJson(res, 422, { error: "bad month" });
    try {
      const report = timesheetRowsForMonth(year, m0, visibleStaff(user, db));
      const buf = buildXlsx(report.sheet, report.title);
      res.writeHead(200, {
        "Content-Type": MIME[".xlsx"],
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(report.title.replace(/\s+/g, "_"))}.xlsx`,
        "Content-Length": buf.length,
        "Cache-Control": "no-store",
      });
      return res.end(buf);
    } catch (e) {
      console.error("export failed:", e);
      return sendJson(res, 500, { error: "export_failed" });
    }
  }

  // ================= Full database backup / restore =================
  // The whole app state lives in ONE JSON file (staff + salaries + overtime hours,
  // groups, timesheet days, driver clients & routes, params, admins, log). These two
  // endpoints let an admin download that file and restore it on any server — so the
  // data can be moved to a fresh instance (new address) without losing anything.

  // ---- GET /api/admin/backup  (downloads the entire db as JSON) ----
  if (urlPath === "/api/admin/backup" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const payload = JSON.stringify({
      app: "biotime",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: db,
    }, null, 2);
    const stamp = dayKey(Date.now());
    const fname = `biotime-backup-${stamp}.json`;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    return res.end(payload);
  }

  // ---- GET /api/admin/backup/app  (full project backup: source code + db) ----
  // Provides a single JSON file with ALL application source files (the ones that
  // are actually deployed / running from cwd) plus the current database. This lets
  // the admin save the whole application on any safe medium (flash drive, cloud) and
  // recover both the code and the data if the local folders are ever lost.
  if (urlPath === "/api/admin/backup/app" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    // Собираем ВСЕ файлы приложения из рабочей папки рекурсивно, чтобы в бэкап
    // попадал и исходный код, и любые новые файлы, добавленные после первой
    // версии (qr.js, иконки, манифест, памятки и т.д.). Исключаем служебные
    // каталоги, секреты и временные/диагностические файлы, чтобы копия была
    // чистой и компактной.
    const EXCLUDE_DIRS = new Set([".opencode", "node_modules", ".git", ".idea", ".vscode", "android", "ios", ".venv"]);
    const files = {};
    const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico)$/i;
    const SKIP_ANY = /\.(log|err)$/i;
    const SKIP_SPECIAL = /(^|[\\/])(srv.*|t2?_.*|check-.*\.png|example-.*|logo-preview\.html|test-.*\.html|.*_before_design\.png|export_test\.xlsx)$/i;
    // Рекурсивный обход рабочей папки. Защита от циклов и чужих огромных
    // каталогов (node_modules и т.п.) — отсекаются в EXCLUDE_DIRS и ниже.
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === "." || e.name === "..") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (EXCLUDE_DIRS.has(e.name)) continue;
          walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(process.cwd(), full).split(path.sep).join("/");
          if (rel.startsWith(".") || rel.includes("node_modules")) continue;
          if (SKIP_ANY.test(e.name) || SKIP_SPECIAL.test(rel) || SKIP_SPECIAL.test(e.name)) continue;
          try {
            const buf = fs.readFileSync(full);
            files[rel] = BINARY_EXT.test(e.name) ? buf.toString("base64") : buf.toString("utf8");
          } catch { /* skip unreadable file */ }
        }
      }
    };
    walk(process.cwd());
    const payload = JSON.stringify({
      archive: "biotime-project",
      app: "biotime",
      version: 3,
      generatedAt: new Date().toISOString(),
      note: "Полная резервная копия приложения: исходный код + база данных. Храните в надёжном месте.",
      files,
      data: db,
    }, null, 2);
    const stamp = dayKey(Date.now());
    const fname = `biotime-app-${stamp}.json`;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      "Content-Length": Buffer.byteLength(payload),
      "Cache-Control": "no-store",
    });
    return res.end(payload);
  }

  // ---- POST /api/admin/backup/restore  (replaces the whole db from a backup) ----
  if (urlPath === "/api/admin/backup/restore" && method === "POST") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const body = await readBody(req);
    // Accept either the raw backup envelope { app, version, data } or a plain db object.
    const incoming = body && body.data && typeof body.data === "object" ? body.data : body;
    if (!incoming || typeof incoming !== "object") {
      return sendJson(res, 422, { error: "invalid backup" });
    }
    // Basic sanity: the payload must look like a BIOTIME database (at least one of
    // the core collections present) to avoid wiping the db with a random JSON file.
    const looksLikeDb =
      Array.isArray(incoming.staff) ||
      Array.isArray(incoming.groups) ||
      (incoming.days && typeof incoming.days === "object");
    if (!looksLikeDb) return sendJson(res, 422, { error: "not a biotime backup" });

    // Before replacing, snapshot the current database so a bad restore is reversible.
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const bk = path.join(DATA_DIR, `before-restore-${Date.now()}.json`);
      fs.writeFileSync(bk, JSON.stringify(db));
    } catch (e) {
      console.error("restore snapshot failed:", e);
      // A failed snapshot is not fatal; refuse only if we cannot even validate.
    }

    // Merge only recognized top-level keys, preserving structure via normalisers.
    const prev = db;
    const nextStaff = Array.isArray(incoming.staff) ? incoming.staff : [];
    db = {
      staff: nextStaff,
      admins: Array.isArray(incoming.admins) ? incoming.admins : (prev ? prev.admins : []),
      blocked: Array.isArray(incoming.blocked) ? incoming.blocked : (prev ? prev.blocked : []),
      groups: Array.isArray(incoming.groups) ? incoming.groups : (prev ? prev.groups : []),
      days: incoming.days && typeof incoming.days === "object" ? incoming.days : {},
      log: Array.isArray(incoming.log) ? incoming.log : [],
      driverClients: Array.isArray(incoming.driverClients) ? incoming.driverClients : [],
      driverRoutes: Array.isArray(incoming.driverRoutes) ? incoming.driverRoutes : [],
      labels: Array.isArray(incoming.labels) ? incoming.labels : [],
      lastSeen: {},
      liveLocations: {},
      tracks: {},
      params: incoming.params && typeof incoming.params === "object" ? incoming.params : (prev ? prev.params : {}),
      norm: Number.isFinite(incoming.norm) ? incoming.norm : (prev && Number.isFinite(prev.norm) ? prev.norm : 9),
    };
    // Bring restored data into the canonical shape (drops members not in staff, etc.).
    migrateDays(db);
    db.groups = db.groups.map((g) => normalizeGroup(g, db.staff));
    await persistDb();
    return sendJson(res, 200, {
      ok: true,
      restored: {
        staff: db.staff.length,
        days: Object.keys(db.days).length,
        groups: db.groups.length,
        clients: db.driverClients.length,
        routes: db.driverRoutes.length,
        log: db.log.length,
      },
    });
  }

  // ---- GET /api/admin/backup/auto  (list automatic backups) ----
  if (urlPath === "/api/admin/backup/auto" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    return sendJson(res, 200, {
      ok: true,
      everyHours: BACKUP_EVERY_MS / (60 * 60 * 1000),
      keep: BACKUP_KEEP,
      backups: listAutoBackups(),
    });
  }

  // ---- GET /api/admin/backup/auto/download?name=...  (download a snapshot) ----
  if (urlPath === "/api/admin/backup/auto/download" && method === "GET") {
    if (!admin) return sendJson(res, 403, { error: "forbidden" });
    const name = String(new URL(req.url, `http://${req.headers.host}`).searchParams.get("name") || "");
    if (!/^biotime-backup-.*\.json$/.test(name)) return sendJson(res, 422, { error: "bad name" });
    const full = path.join(BACKUP_DIR, path.basename(name));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return sendJson(res, 404, { error: "not found" });
    const data = fs.readFileSync(full);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    return res.end(data);
  }

  return sendJson(res, 404, { error: "not found" });
}

function serveHtml(res, data) {
  res.writeHead(200, { "Content-Type": MIME[".html"] });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
    } catch {
      return sendJson(res, 400, { error: "bad url" });
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
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
      res.end(data);
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

server.listen(PORT, () => {
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
