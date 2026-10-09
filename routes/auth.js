// Модуль-обработчик собственной авторизации (логин/пароль). Вынесен из server.js
// (handleAuthRoutes): вход, выход, смена пароля, masquerade, /api/auth/me.
//
// Сессии/пароли/утилиты HTTP передаются инъекцией (DI) из server.js, чтобы
// модуль не тянул глобальное состояние. db читается через getDb.
module.exports = function createAuthHandler({
  getDb,
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
} = {}) {
  return async function handleAuthRoutes(req, res, urlPath, method, identUser) {
    const db = getDb ? getDb() : {};

    if (urlPath === "/api/auth/find-by-name" && method === "POST") {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, users: staffByFio(String(body.name || "")) });
    } else if (urlPath === "/api/auth/set-credentials" && method === "POST") {
      const body = await readBody(req);
      const st = staffById(body.userId);
      if (!st) return sendJson(res, 404, { error: "Пользователь не найден" });
      if (st.login) return sendJson(res, 409, { error: "Учётные данные уже заданы — без перезаписи (обратитесь к администратору)" });
      // Безопасность: назначать логин/пароль можно только СВОЕЙ учётке, когда
      // личность надёжно известна (и имя введённого сотрудника совпадает с ней).
      const idTrusted = !/^local$/i.test(String(identUser && identUser.id));
      const hasRealName = String(identUser && identUser.name || "").trim() !== "" && String(identUser && identUser.name || "") !== "Локальный пользователь";
      if (!idTrusted || !hasRealName || !namesMatch(identUser && identUser.name, st.name)) {
        return sendJson(res, 403, { error: "Логин/пароль сотрудника назначает администратор (Настройки → Учётные записи)" });
      }
      const login = String(body.login || "").trim();
      const pass = String(body.password || "");
      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(login)) return sendJson(res, 422, { error: "Логин: 3–32 символа (лат., цифры, _ . -)" });
      if (pass.length < 8) return sendJson(res, 422, { error: "Пароль не короче 8 символов" });
      if (staffByLogin(login)) return sendJson(res, 409, { error: "Такой логин уже занят" });
      const { salt, hash } = hashPassword(pass);
      st.login = login; st.passSalt = salt; st.passHash = hash;
      await persistDb();
      const token = createSession(st.id);
      setAuthCookie(res, token, req);
      return sendJson(res, 200, { ok: true, token });
    } else if (urlPath === "/api/auth/login" && method === "POST") {
      const body = await readBody(req);
      const login = String(body.login || "").trim();
      const pass = String(body.password || "");
      const ipKey = String((req.socket && req.socket.remoteAddress) || "?") + "|" + login.toLowerCase();
      const ra = loginRate[ipKey] || {};
      if (ra.lockUntil && ra.lockUntil > Date.now()) return sendJson(res, 429, { error: "Слишком много попыток — подождите" });
      const st = staffByLogin(login);
      const ok = st && verifyPassword(pass, st.passSalt, st.passHash);
      if (!ok) {
        const cur = loginRate[ipKey] || { count: 0, lockUntil: 0 };
        cur.count = (cur.count || 0) + 1;
        if (cur.count >= 8) { cur.lockUntil = Date.now() + 60 * 1000; cur.count = 0; }
        loginRate[ipKey] = cur;
        return sendJson(res, 401, { error: "Неверный логин или пароль" });
      }
      delete loginRate[ipKey];
      const token = createSession(st.id);
      setAuthCookie(res, token, req);
      const role = (st.admin === true || st.portalAdmin === true || (db.admins || []).includes(String(st.id))) ? "ADMIN" : "MEMBER";
      return sendJson(res, 200, { ok: true, user: { id: String(st.id), name: st.name, role }, token });
    } else if (urlPath === "/api/auth/logout" && method === "POST") {
      const token = cookieValue(req.headers.cookie || "", AUTH_COOKIE);
      const s = token && SESSIONS.get(token);
      if (s && s.masqAdminId) {
        s.staffId = s.masqAdminId;
        delete s.masqAdminId;
        saveSessionsToDisk();
        return sendJson(res, 200, { ok: true, restoredAdmin: true });
      }
      if (token) { SESSIONS.delete(token); saveSessionsToDisk(); }
      clearAuthCookie(res);
      return sendJson(res, 200, { ok: true });
    } else if (urlPath === "/api/auth/masquerade" && method === "POST") {
      const token = cookieValue(req.headers.cookie || "", AUTH_COOKIE);
      const s = token && SESSIONS.get(token);
      const su = s && sessionUserFromCookie(req.headers.cookie || "");
      if (!su || su.role !== "ADMIN") return sendJson(res, 403, { error: "Только администратор" });
      const body = await readBody(req);
      const target = staffById(String(body.userId || ""));
      if (!target) return sendJson(res, 404, { error: "Пользователь не найден" });
      if (!s.masqAdminId) s.masqAdminId = s.staffId;
      s.staffId = String(target.id);
      s.exp = Date.now() + 30 * 24 * 3600 * 1000;
      saveSessionsToDisk();
      return sendJson(res, 200, { ok: true });
    } else if (urlPath === "/api/auth/me" && method === "GET") {
      const su = sessionUserFromCookie(req.headers.cookie || "");
      const stok = cookieValue(req.headers.cookie || "", AUTH_COOKIE);
      const sess = stok && SESSIONS.get(stok);
      const masquerade = !!(sess && sess.masqAdminId);
      const authRequired = true;
      return sendJson(res, 200, su
        ? { ok: true, user: { id: su.id, name: su.name, role: su.role }, masquerade, required: authRequired }
        : { ok: false, user: null, required: authRequired });
    } else if (urlPath === "/api/auth/change-password" && method === "POST") {
      const su = sessionUserFromCookie(req.headers.cookie || "") || identity(req.headers);
      if (!su || !su.id) return sendJson(res, 401, { error: "Не авторизованы" });
      let st = su.staffId ? staffById(su.staffId) : null;
      if (!st) st = staffById(su.id) || (db.staff || []).find((s) => namesMatch(su.name, s.name)) || null;
      if (!st) return sendJson(res, 404, { error: "Пользователь не найден" });
      const body = await readBody(req);
      const cur = String(body.currentPassword || "");
      const nw = String(body.newPassword || "");
      if (!st.passHash || !st.passSalt) return sendJson(res, 409, { error: "Учётка ещё не задана — обратитесь к администратору" });
      if (!verifyPassword(cur, st.passSalt, st.passHash)) return sendJson(res, 403, { error: "Текущий пароль неверен" });
      if (nw.length < 8) return sendJson(res, 422, { error: "Новый пароль не короче 8 символов" });
      if (nw === cur) return sendJson(res, 422, { error: "Новый пароль совпадает с текущим" });
      const { salt, hash } = hashPassword(nw);
      st.passSalt = salt; st.passHash = hash;
      await persistDb();
      return sendJson(res, 200, { ok: true });
    }
    return false;
  };
};
