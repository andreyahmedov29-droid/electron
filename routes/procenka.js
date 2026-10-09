// Мост к встроенному модулю «Проценка» (папка procenka/). Модуль — Express-app
// (server.js → module.exports = app). Монтируем его под /procenka и передаём
// (req,res). Доступ — через canSeeProcenka (права BIOTIME).
module.exports = function createProcenkaHandler({ canSeeProcenka, getDb } = {}) {
  let handler;
  const load = () => {
    if (!handler) {
      const express = require("express");
      const innerApp = require("../procenka/server.js");
      const mounted = express();
      mounted.use("/procenka", innerApp);
      handler = mounted;
    }
    return handler;
  };
  return function handleProcenkaRoutes(req, res, urlPath, user) {
    if (typeof urlPath !== "string" || !urlPath.startsWith("/procenka/")) return false;
    const allowed = (canSeeProcenka || (() => false))(user, getDb ? getDb() : {});
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
