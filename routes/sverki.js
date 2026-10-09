// Мост к встроенному модулю «Сверки» (папка sverki/).
// Модуль превращён в request-функцию (sverki/server.js → handleRequest).
// Обрабатываем только пути /sverki/*, доступ — через canSeeSverki (права BIOTIME),
// префикс /sverki модуль срезает сам.
module.exports = function createReconcileHandler({ canSeeSverki, getDb } = {}) {
  let h;
  const load = () => {
    if (!h) h = require("../sverki/server.js");
    return h;
  };
  return function handleReconcileRoutes(req, res, urlPath, user) {
    if (typeof urlPath !== "string" || !urlPath.startsWith("/sverki/")) return false;
    const allowed = (canSeeSverki || (() => false))(user, getDb ? getDb() : {});
    if (!allowed) {
      if (!res.headersSent) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Доступ запрещён");
      }
      return true;
    }
    load()(req, res);
    return true;
  };
};
