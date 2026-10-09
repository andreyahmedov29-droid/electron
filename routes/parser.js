// Мост к встроенному модулю «Парсер почты» (папка parser/). Модуль — request-
// функция (parser/server.js → handleRequest). Обрабатываем /parser/*, доступ —
// через canSeeParser (права BIOTIME), префикс /parser модуль срезает сам.
module.exports = function createParserHandler({ canSeeParser, getDb } = {}) {
  let h;
  const load = () => {
    if (!h) h = require("../parser/server.js");
    return h;
  };
  return function handleParserRoutes(req, res, urlPath, user) {
    if (typeof urlPath !== "string" || !urlPath.startsWith("/parser/")) return false;
    const allowed = (canSeeParser || (() => false))(user, getDb ? getDb() : {});
    if (!allowed) {
      if (!res.headersSent) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Доступ запрещён");
      }
      return true;
    }
    // Модуль парсера определяет роль по заголовку x-vibe-user-role, которого во
    // встроенном iframe может не быть. Доступ к разделу уже выдан (canSeeParser),
    // поэтому все допущенные получают полное редактирование (ADMIN), а не
    // «режим просмотра».
    if (user) {
      req.headers["x-vibe-user-role"] = "ADMIN";
      const uid = String(user.id != null ? user.id : "");
      if (uid) req.headers["x-vibe-user-id"] = uid;
      if (user.name) req.headers["x-vibe-user-name-encoded"] = encodeURIComponent(String(user.name));
    }
    load()(req, res);
    return true;
  };
};
