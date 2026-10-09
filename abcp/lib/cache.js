// Общий LRU-кэш с лимитом записей: защита от неограниченного роста памяти.
// API совместим с Map (get/set/has/clear), при обращении ключ «подогревается».
function makeCache(limit = 300) {
  const map = new Map();
  return {
    get(k) {
      const v = map.get(k);
      if (v !== undefined) { map.delete(k); map.set(k, v); }
      return v;
    },
    has(k) { return map.has(k); },
    set(k, v) {
      map.delete(k);
      map.set(k, v);
      if (map.size > limit) { const first = map.keys().next().value; map.delete(first); }
    },
    clear() { map.clear(); },
  };
}

// Свежесть персистентного снапшота: считаем актуальным только снимок за сегодня.
function isSnapFresh(snap) {
  if (!snap || !snap.generatedAt) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(snap.generatedAt).slice(0, 10) === today;
}

module.exports = { makeCache, isSnapFresh };
