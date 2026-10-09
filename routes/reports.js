// Мост к встроенному модулю «АБЦП отчет» (папка abcp/).
//
// Модуль АБЦП превращён из самостоятельного сервера в request-функцию
// (abcp/server.js → handleRequest). Здесь мы подключаем его к серверу BIOTIME:
//  - обрабатываем только пути, начинающиеся с /reports/;
//  - доступ проверяем через canSeeReports (права BIOTIME), собственную
//    авторизацию АБЦП не используем;
//  - идентичность подставляем в req._biotimeSession, а префикс /reports/
//    модуль срезает сам.
module.exports = function createReportsHandler({ canSeeReports, getDb } = {}) {
  let abcpHandle;
  const loadAbcp = () => {
    if (!abcpHandle) {
      // Ленивый require: тяжёлая инициализация (кэши, майлер, фоновые задачи)
      // происходит только при первом заходе во вкладку «Отчёты».
      abcpHandle = require('../abcp/server.js');
    }
    return abcpHandle;
  };

  return function handleReportsRoutes(req, res, urlPath, user) {
    if (typeof urlPath !== 'string' || !urlPath.startsWith('/reports/')) return false;
    const allowed = (canSeeReports || (() => false))(user, getDb ? getDb() : {});
    if (!allowed) {
      if (!res.headersSent) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Доступ запрещён');
      }
      return true;
    }
    // Идентичность текущего пользователя BIOTIME отдаём модулю.
    req._biotimeSession = {
      userId: user ? String(user.id) : '',
      name: user ? String(user.name || '') : '',
      role: user ? String(user.role || '') : '',
      isExternal: true,
    };
    // Доступ к внутренним разделам «Отчётов»: админ — все (null), остальные —
    // списки разделов, где он отмечен в «Настройки → Доступ к разделам → Отчёты».
    if (user) {
      const isAdm = String(user.role || "").toUpperCase() === "ADMIN";
      const db = getDb ? getDb() : {};
      const sec = (db.params && db.params.reportsSections) || {};
      const keys = Object.keys(sec).filter((k) =>
        Array.isArray(sec[k]) && sec[k].some((x) => String(x) === String(user.id)));
      req._biotimeSections = isAdm ? null : keys;
    }
    loadAbcp()(req, res);
    return true;
  };
};
