// Общие чистые хелперы сервера (без побочных эффектов). Вынесены из server.js,
// чтобы их можно было переиспользовать и покрывать юнит-тестами напрямую.

// Перепривязка этикеток (боксов/мест) маршрута при изменении порядка точек.
// При reorder водителем newClients — это НОВЫЙ порядок клиентов (та же биекция,
// только последовательность другая). Каждую этикетку маршрута сопоставляем с
// клиентом по ключу (адрес или наименование) и выставляем новый clientIndex.
// Так бокс/детали «едут» вместе со своим клиентом и НЕ перекидываются другому
// клиенту при перестановке точек.
function relinkRouteLabels(routeId, newClients, labels) {
  if (!Array.isArray(labels) || !Array.isArray(newClients)) return labels;
  const keyOf = (c) => {
    const addr = String((c && c.address) || "").trim().toLowerCase();
    if (addr) return "a:" + addr;
    const client = String((c && c.client) || "").trim().toLowerCase();
    if (client) return "c:" + client;
    return null;
  };
  const idxByKey = new Map();
  newClients.forEach((c, i) => {
    const k = keyOf(c);
    if (k != null && !idxByKey.has(k)) idxByKey.set(k, i);
  });
  for (const l of labels) {
    if (!l || String(l.routeId) !== String(routeId)) continue;
    const k = keyOf({ address: l.address, client: l.client });
    if (k != null && idxByKey.has(k)) l.clientIndex = idxByKey.get(k);
  }
  return labels;
}

module.exports = { relinkRouteLabels };
