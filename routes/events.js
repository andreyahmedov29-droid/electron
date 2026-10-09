// Модуль-обработчик Server-Sent Events (/api/events).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createEventsHandler({
  sseClients,
  sseWrite,
} = {}) {
  return async function handleEventsRoutes(req, res, urlPath, method, user, admin) {
    if (urlPath === "/api/events" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      const hb = setInterval(() => sseWrite(res, ": hb\n\n"), 25000);
      const cleanup = () => { clearInterval(hb); sseClients.delete(res); };
      req.on("close", cleanup);
      res.on("close", cleanup);
      return; // держим соединение открытым
    }

    return false;
  };
};
