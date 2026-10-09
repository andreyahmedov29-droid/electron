// Модуль-обработчик /api/me и /api/state (текущий пользователь и полное состояние).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createMeStateHandler({
  getDb,
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
  canSeeSverki,
  canSeeProcenka,
  canSeeParser,
} = {}) {
  return async function handleMeStateRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // GET /api/me
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

    // GET /api/state
    if (urlPath === "/api/state" && method === "GET") {
      const changed = ensureStaffRecord(user);
      const froze = maybeFreezePrevMonth();
      if (changed || froze) await persistDb();
      const admin = isAdmin(user, db);
      const moderator = isModerator(user, db);
      if (admin) {
        void syncDirectory(false);
      }
      const groups = admin
        ? db.groups
        : (moderator ? groupsOfModerator(user, db) : []);
      const me = { id: user.id, name: user.name, role: user.role, isAdmin: admin, isDriver: isDriver(user, db), isLoader: isLoader(user, db) };
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
        canManageShipment: canManageShipment(user, db),
        canSeeShipment: canSeeShipment(user, db),
        canSeeNotfound: canSeeNotfound(user, db),
        canSeeLogs: canSeeLogs(user, db),
        canSeeReports: (canSeeReports || (() => false))(user, db),
        canSeeSverki: (canSeeSverki || (() => false))(user, db),
        canSeeProcenka: (canSeeProcenka || (() => false))(user, db),
        canSeeParser: (canSeeParser || (() => false))(user, db),
        staff: staffView,
        days: visibleDays(user, db),
        log: visibleLog(user, db),
        admins: admin ? db.admins : undefined,
        blocked: admin ? db.blocked : undefined,
        groups: admin || moderator ? groups : undefined,
        params: db.params,
        norm: db.norm,
        salaryMonth: db.salaryMonth || {},
        serverOffsetMinutes: serverTzOffset(),
        tzLabel: (() => {
          try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
        })(),
      });
    }

    return false;
  };
};
