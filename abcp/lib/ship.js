// Сервис «дат отгрузок»: реальная дата «Отгружен поставщиком» по истории статусов
// каждой позиции, с персистентным кэшем shipdates.json и фоновой дозагрузкой.
const fs = require('fs');
const path = require('path');

function makeShipDates(deps) {
  const { storage, abcp } = deps;
  const shipStats = { total: 0, done: 0 };
  let shipBgBusy = false;

  function safeReadOrdersCache() {
    try {
      const file = path.join(storage.resolveDataDir(), 'shipdates.json');
      return JSON.parse(fs.readFileSync(file, 'utf8') || '{}') || {};
    } catch (_e) {
      return {};
    }
  }

  function writeOrdersCache(map) {
    try {
      const file = path.join(storage.resolveDataDir(), 'shipdates.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(map || {}), 'utf8');
    } catch (_e) { /* некритично */ }
  }

  async function startShipBackfill(entries, settings) {
    if (shipBgBusy) return;
    shipBgBusy = true;
    try {
      let idx = 0;
      shipStats.total = Math.max(shipStats.total, entries.length);
      shipStats.done = Math.max(shipStats.done, shipStats.total - entries.length);
      while (idx < entries.length) {
        const id = entries[idx++];
        if (safeReadOrdersCache()[id]) continue;
        try {
          const h = await abcp.fetchStatusHistory(settings, id);
          const s = (h || []).find((x) => /отгружен.*поставщик/i.test(String(x.status || '')));
          if (s && s.datetime) {
            const map = safeReadOrdersCache();
            map[id] = s.datetime;
            writeOrdersCache(map);
          }
        } catch (e) {
          if (/423|429/.test(String(e && e.message))) {
            await new Promise((r) => setTimeout(r, 30000));
          }
        }
        await new Promise((r) => setTimeout(r, 40));
        shipStats.done = Math.min(shipStats.done + 1, shipStats.total);
      }
    } finally {
      shipBgBusy = false;
    }
  }

  async function buildShippedMap(orders, settings, max = 20000, budget = 400) {
    const entries = [];
    const seen = new Set();
    const map = {};
    const orderedMap = {};
    for (const order of orders || []) {
      for (const pos of order.positions || []) {
        const d = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
        if (d) continue;
        const c = Number(pos.isCanceled);
        if (c === 1 || c === 2) continue;
        if (seen.has(pos.id)) continue;
        seen.add(pos.id);
        if (/отгружен.*поставщик/i.test(String(pos.status || '')) && pos.statusChangeDate) {
          map[pos.id] = pos.statusChangeDate;
          continue;
        }
        entries.push({ id: pos.id });
        if (entries.length >= max) break;
      }
      if (entries.length >= max) break;
    }
    const cache = safeReadOrdersCache();
    Object.assign(map, cache);
    shipStats.total = entries.length + Object.keys(cache).length;
    shipStats.done = Object.keys(cache).length;
    let i = 0;
    const CONC = 12;
    let net = 0;
    const leftEntries = [];
    async function worker() {
      while (i < entries.length) {
        const id = entries[i++].id;
        if (map[id]) continue;
        if (net >= budget) { leftEntries.push(id); continue; }
        net += 1;
        try {
          const h = await abcp.fetchStatusHistory(settings, id);
          const s = (h || []).find((x) => /отгружен.*поставщик/i.test(String(x.status || '')));
          if (s && s.datetime) map[id] = s.datetime;
          const so = (h || []).find((x) => /^\s*заказан\s*$/i.test(String(x.status || '')));
          if (so && so.datetime) orderedMap[id] = so.datetime;
        } catch (_e) { /* пропускаем */ }
        await new Promise((r) => setTimeout(r, 20));
        shipStats.done = Math.min(shipStats.done + 1, shipStats.total);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, entries.length) }, () => worker()));
    shipStats.done = Math.min(shipStats.done, shipStats.total);
    writeOrdersCache(map);
    if (leftEntries.length) startShipBackfill(leftEntries, settings);
    return { map, orderedMap, hasMore: leftEntries.length > 0 };
  }

  return {
    buildShippedMap,
    shipStats,
    shipProgress: () => ({ done: shipStats.done, total: shipStats.total }),
  };
}

module.exports = { makeShipDates };
