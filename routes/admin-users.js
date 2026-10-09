// Модуль-обработчик админ-управления учётками (/api/admin/users*).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createAdminUsersHandler({
  getDb,
  persistDb,
  sendJson,
  readBody,
  isAdmin,
  rootAdminId,
  staffById,
  staffByLogin,
  hashPassword,
} = {}) {
  return async function handleAdminUsersRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // Своя авторизация: админ-управление учётками.
    if (urlPath === "/api/admin/users" && method === "GET") {
      if (!isAdmin(user, db)) return sendJson(res, 403, { error: "forbidden" });
      return sendJson(res, 200, {
        ok: true,
        ownerId: rootAdminId(db),
        groups: (db.groups || []).map((g) => ({ name: g.name || "Группа", memberIds: (g.memberIds || []).map(String) })),
        users: (db.staff || []).map((s) => ({ id: String(s.id), name: s.name, login: s.login || "", hasCreds: !!s.login })),
      });
    }
    if (urlPath === "/api/admin/users/credentials" && method === "POST") {
      if (!isAdmin(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      const rootId = rootAdminId(db);
      // Главному админу учётку может менять только он сам — другие админы нет.
      const callerRoot = (user && (String(user.staffId || user.id) === rootId));
      if (String(body && body.userId) === rootId && !callerRoot) {
        return sendJson(res, 403, { error: "Пароль главного администратора может менять только он сам" });
      }
      const st = staffById(body.userId);
      if (!st) return sendJson(res, 404, { error: "Пользователь не найден" });
      const login = String(body.login || "").trim();
      const pass = String(body.password || "");
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(login)) return sendJson(res, 422, { error: "Логин: 3–32 символа (лат., цифры, _ . -)" });
      const other = staffByLogin(login);
      if (other && String(other.id) !== String(st.id)) return sendJson(res, 409, { error: "Такой логин уже занят" });
      if (pass && pass.length < 8) return sendJson(res, 422, { error: "Пароль не короче 8 символов" });
      st.login = login;
      if (pass) {
        const { salt, hash } = hashPassword(pass);
        st.passSalt = salt; st.passHash = hash;
      }
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }

    return false;
  };
};
