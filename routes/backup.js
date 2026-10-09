// Модуль-обработчик резервного копирования (админ). Вынесен из server.js
// (handleBackupRoutes): GET /api/admin/backup, /backup/app, /backup/auto,
// /backup/auto/download и POST /backup/restore.
//
// Зависимости через фабрику (DI). БД читается через getDb; в restore БД
// переустанавливается целиком, поэтому здесь нужен setDb(newDb).
const fs = require("node:fs");
const path = require("node:path");

module.exports = function createBackupHandler({
  getDb,
  setDb,
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
} = {}) {
  // Собрать JSON-настройки встроенных модулей (Отчёты/Сверки/Проценка/Парсер),
  // которые живут в общем /data. Собираем верхний уровень *.json (кроме логов и
  // тяжёлых/динамических) — это «все данные» интеграций для полного бэкапа.
  function collectModulesJson(dir) {
    const out = {};
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      if (/^logs(-.*)?$/.test(e.name) || /^sessions/.test(e.name)) continue;
      if (e.name === "db.json") continue;
      try {
        out[e.name] = JSON.parse(fs.readFileSync(path.join(dir, e.name), "utf8"));
      } catch (_) { /* пропускаем нечитаемые */ }
    }
    return out;
  }
  return async function handleBackupRoutes(req, res, urlPath, method, admin) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/admin/backup" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const extra = collectExtraBackup ? collectExtraBackup() : {};
      const modulesJson = DATA_DIR ? collectModulesJson(DATA_DIR) : {};
      const payload = JSON.stringify({
        app: "biotime",
        version: 1,
        exportedAt: new Date().toISOString(),
        data: db,
        extra: Object.keys(extra).length ? extra : undefined,
        modules: Object.keys(modulesJson).length ? modulesJson : undefined,
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

    if (urlPath === "/api/admin/backup/app" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const EXCLUDE_DIRS = new Set([".opencode", "node_modules", ".git", ".idea", ".vscode", "android", "ios", ".venv"]);
      const files = {};
      const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico)$/i;
      const SKIP_ANY = /\.(log|err)$/i;
      const SKIP_SPECIAL = /(^|[\\/])(srv.*|t2?_.*|check-.*\.png|example-.*|logo-preview\.html|test-.*\.html|.*_before_design\.png|export_test\.xlsx)$/i;
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
        extra: collectExtraBackup ? collectExtraBackup() : {},
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

    if (urlPath === "/api/admin/backup/restore" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const incoming = body && body.data && typeof body.data === "object" ? body.data : body;
      if (!incoming || typeof incoming !== "object") {
        return sendJson(res, 422, { error: "invalid backup" });
      }
      const looksLikeDb =
        Array.isArray(incoming.staff) ||
        Array.isArray(incoming.groups) ||
        (incoming.days && typeof incoming.days === "object");
      if (!looksLikeDb) return sendJson(res, 422, { error: "not a biotime backup" });

      try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const bk = path.join(DATA_DIR, `before-restore-${Date.now()}.json`);
        fs.writeFileSync(bk, JSON.stringify(db));
      } catch (e) {
        console.error("restore snapshot failed:", e);
      }

      const prev = db;
      const next = {
        staff: Array.isArray(incoming.staff) ? incoming.staff : [],
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
      if (setDb) setDb(next);
      try {
        migrateDays(next);
        next.groups = next.groups.map((g) => normalizeGroup(g, next.staff));
        await persistDb();
        // Восстанавливаем дополнительные durable-данные (треки, статусы, журнал
        // 1С, архив сканов), которые шли в бэкапе рядом с data.
        if (applyExtraBackup) applyExtraBackup(body && body.extra);
        return sendJson(res, 200, {
          ok: true,
          restored: {
            staff: next.staff.length,
            days: Object.keys(next.days).length,
            groups: next.groups.length,
            clients: next.driverClients.length,
            routes: next.driverRoutes.length,
            log: next.log.length,
            extra: !!(body && body.extra && typeof body.extra === "object"),
          },
        });
      } catch (err) {
        console.error("restore failed:", err);
        return sendJson(res, 500, { error: "Ошибка восстановления: " + (err && err.message ? err.message : String(err)) });
      }
    }

    // ---------------------------------------------------------------
    // Восстановление ПО ЧАСТЯМ (обход лимита размера тела запроса на
    // standalone Black Hole ~4 МиБ): клиент шлёт бэкап кусками по
    // /restore-part, затем собирает их на сервере вызовом /restore-complete.
    // Части лежат в /data/_staging, переживают перезапуск и удаляются после.
    // ---------------------------------------------------------------
    const STAGING_DIR = path.join(DATA_DIR, "_staging");
    const bulkToken = (t) => String(t || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const bulkCleanup = (token, total) => {
      try {
        for (let i = 0; i < total; i++) {
          const p = path.join(STAGING_DIR, `${token}-${i}.part`);
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      } catch { /* ок */ }
    };

    if (urlPath === "/api/admin/backup/restore-part" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const token = bulkToken(body && body.token);
      const index = Number(body && body.index);
      const total = Number(body && body.total);
      const part = typeof (body && body.data) === "string" ? body.data : "";
      if (!token || !Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total < 1 || index >= total) {
        return sendJson(res, 422, { error: "invalid part" });
      }
      // Часть — строка; экранированные utf-8 байты в части не могут быть больше
      // ~8кратной длины строки, но реальный потолок тела задаёт шлюз, поэтому
      // дополнительно режем по длине строки, чтобы часть гарантированно
      // прошла. 5 000 000 символов utf-8 далеко в безопасной зоне.
      if (part.length > 5_000_000) return sendJson(res, 422, { error: "part too large" });
      try {
        if (!fs.existsSync(STAGING_DIR)) fs.mkdirSync(STAGING_DIR, { recursive: true });
        fs.writeFileSync(path.join(STAGING_DIR, `${token}-${index}.part`), part, "utf8");
        return sendJson(res, 200, { ok: true, index, total });
      } catch (e) {
        console.error("restore part failed:", e);
        return sendJson(res, 500, { error: "Ошибка приёма части: " + (e && e.message ? e.message : String(e)) });
      }
    }

    if (urlPath === "/api/admin/backup/restore-complete" && method === "POST") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const token = bulkToken(body && body.token);
      const total = Number(body && body.total);
      if (!token || !Number.isInteger(total) || total < 1 || total > 1000) {
        return sendJson(res, 422, { error: "invalid complete" });
      }
      let raw = "";
      try {
        for (let i = 0; i < total; i++) {
          const p = path.join(STAGING_DIR, `${token}-${i}.part`);
          if (!fs.existsSync(p)) return sendJson(res, 422, { error: `Часть ${i + 1} из ${total} не найдена — повторите загрузку` });
          raw += fs.readFileSync(p, "utf8");
        }
      } catch (e) {
        return sendJson(res, 500, { error: "Ошибка чтения частей: " + (e && e.message ? e.message : String(e)) });
      }
      try {
        bulkCleanup(token, total);
      } catch { /* ок */ }
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return sendJson(res, 422, { error: "Собранный бэкап повреждён — повторите загрузку" }); }
      const incoming = parsed && parsed.data && typeof parsed.data === "object" ? parsed.data : parsed;
      const looksLikeDb =
        Array.isArray(incoming.staff) ||
        Array.isArray(incoming.groups) ||
        (incoming.days && typeof incoming.days === "object");
      if (!looksLikeDb) return sendJson(res, 422, { error: "not a biotime backup" });

      const prev = db;
      const next = {
        staff: Array.isArray(incoming.staff) ? incoming.staff : [],
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
      if (setDb) setDb(next);
      try {
        migrateDays(next);
        next.groups = next.groups.map((g) => normalizeGroup(g, next.staff));
        await persistDb();
        // Восстанавливаем дополнительные durable-данные из общего envelope.
        if (applyExtraBackup) applyExtraBackup(parsed && parsed.extra);
        return sendJson(res, 200, {
          ok: true,
          restored: {
            staff: next.staff.length,
            days: Object.keys(next.days).length,
            groups: next.groups.length,
            clients: next.driverClients.length,
            routes: next.driverRoutes.length,
            log: next.log.length,
            extra: !!(parsed && parsed.extra && typeof parsed.extra === "object"),
          },
        });
      } catch (err) {
        console.error("restore (bulk) failed:", err);
        return sendJson(res, 500, { error: "Ошибка восстановления: " + (err && err.message ? err.message : String(err)) });
      }
    }

    if (urlPath === "/api/admin/backup/auto" && method === "GET") {
      if (!admin) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 200, {
        ok: true,
        everyHours: BACKUP_EVERY_MS / (60 * 60 * 1000),
        keep: BACKUP_KEEP,
        backups: listAutoBackups(),
      });
    }

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
    return false;
  };
};
