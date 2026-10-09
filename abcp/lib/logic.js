'use strict';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ABCP отдаёт даты в формате "YYYY-MM-DD HH:mm:ss" (без таймзоны — трактуем как UTC,
// чтобы расчёты были однозначными и не зависели от часового пояса сервера).
function parseOrderDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (typeof value !== 'string') return new Date(NaN);
  const m = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/
  );
  if (!m) return new Date(NaN);
  return new Date(Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] ? Number(m[4]) : 0,
    m[5] ? Number(m[5]) : 0,
    m[6] ? Number(m[6]) : 0
  ));
}

// Плановая дата поставки = дата заказа + срок поставки в часах.
// Если deadlineMax > 0, берётся гарантированный срок, иначе обычный deadline.
function plannedDate(orderDate, deadline, deadlineMax) {
  const base = new Date(orderDate.getTime());
  const hours = Number(deadlineMax) > 0 ? Number(deadlineMax) : Number(deadline || 0);
  base.setUTCHours(base.getUTCHours() + hours);
  return base;
}

// Нормализует statusCode позиции к строке (в ABCP он может быть числом или строкой).
function statusKey(statusCode) {
  if (statusCode === null || statusCode === undefined) return '';
  return String(statusCode);
}

function isRefusal(status) {
  if (typeof status !== 'string') return false;
  const s = status.trim().toLowerCase();
  // Отказом считаем строго два статуса: «Отказ» и «Отказ по браку».
  return s === 'отказ' || s === 'отказ по браку';
}

// «Выдано» — строго статус «Выдан».
function isIssued(status) {
  return typeof status === 'string' && status.trim().toLowerCase() === 'выдан';
}

// Приводит дату/время ABCP к 'YYYY-MM-DD'. ABCP отдаёт «дд.мм.гггг чч:мм:сс»,
// и сравнение такого слайса с ISO-диапазоном «с/по» всегда отбрасывало позицию.
function isoDate(s) {
  if (s == null) return '';
  const str = String(s).trim();
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})/); // дд.мм.гггг
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return String(s).slice(0, 10); // уже ISO YYYY-MM-DD
}

// Базовое имя поставщика: часть до «:» (ABCP пишет «Сфера Минск : 12067768»).
function supplierBaseOf(name) {
  const s = String(name || '').trim();
  const i = s.indexOf(':');
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

// Единая нормализация бренда: регистр и разделители (/ - _) сходятся, чтобы
// варианты вроде «HYUNDAI / KIA» и «Hyundai-KIA» считались одним брендом.
// Плюс канонические алиасы: MERCEDES-* / DAIMLER -> MERCEDES-BENZ, ROVER -> LAND ROVER.
const BRAND_ALIASES = {
  mercedes: 'mercedes-benz',
  'mercedes/benz': 'mercedes-benz',
  'mercedes benz': 'mercedes-benz',
  daimler: 'mercedes-benz',
  'daimler ag': 'mercedes-benz',
  'daimler/ag': 'mercedes-benz',
  rover: 'land-rover',
  'land rover': 'land-rover',
  'land/rover': 'land-rover',
  'land-rover': 'land-rover',
  'rover/land rover': 'land-rover',
  'rover/land/rover': 'land-rover',
  'citroen/peugeot': 'peugeot/citroen',
  'citroen peugeot': 'peugeot/citroen',
};
const BRAND_DISPLAY = {
  'mercedes-benz': 'MERCEDES-BENZ',
  'land-rover': 'LAND ROVER',
  'peugeot/citroen': 'Peugeot-Citroen',
};
function normalizeBrand(raw) {
  const norm = String(raw == null ? '—' : raw).trim().toLowerCase()
    .replace(/[\s]*[\/\\_\-][\s]*/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    .replace(/\s+/g, ' ') || '—';
  const key = BRAND_ALIASES[norm] || norm;
  return { key, display: BRAND_DISPLAY[key] || String(raw == null ? '—' : raw).trim() || '—' };
}

// ABCP отдаёт даты в формате "дд.мм.гггг чч:мм:сс" — его new Date() не понимает,
// поэтому парсим вручную единым хелпером.
function abcpDate(s) {
  if (s == null) return NaN;
  const str = String(s).trim();
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})[\sT](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], m[6] ? +m[6] : 0);
    return d.getTime();
  }
  return new Date(str).getTime();
}
// Разница двух дат в днях с округлением в большую сторону (календарные дни).
function spanDays(a, b) { return Math.ceil((abcpDate(a) - abcpDate(b)) / 86400000); }

const isAccepted = (st) => /принят/i.test(String(st || ''));

// Онлайн/API-поставщики помечены «[online]» (заказы уходят через API). Поставщики,
// работающие по прайс-листам (заказы по почте), такого маркера не имеют.
const isOnlineSupplier = (name) => /\[online\]/i.test(String(name || ''));

// Делит имя поставщика на базовое имя и склад/направление (после первого «:»).
// «ТРИНИТИ-ПАРТС : Bella509» → base «ТРИНИТИ-ПАРТС», wh «Bella509».
function supplierParts(name) {
  const s = String(name == null ? '' : name);
  const i = s.indexOf(':');
  if (i < 0) return { base: s.trim(), wh: '' };
  return { base: s.slice(0, i).trim(), wh: s.slice(i + 1).trim() };
}

// Склад/направление поставщика берём из полей позиции ABCP:
// dsRouteId — «Код склада поставщика», routeId — маршрут склада, supplierCode — устаревший код склада.
function warehouseOf(pos) {
  if (!pos) return '';
  const v = pos.dsRouteId != null ? pos.dsRouteId : (pos.routeId != null ? pos.routeId : pos.supplierCode);
  return String(v == null ? '' : v).trim();
}

// Отображаемое имя клиента: предпочитаем название из справочника ABCP (cp/users),
// иначе — полное имя из заказа, иначе — код пользователя.
function clientName(order, names) {
  if (names && order && order.userId != null) {
    const n = names[String(order.userId)];
    if (n) return n;
  }
  if (order) return order.userFullName || order.userName || '';
  return '';
}

// Позиция просрочена, если:
//  - не удалена и не отменена;
//  - её статус не входит в список «завершающих» (товар получен/выдан);
//  - плановая дата поставки уже наступила (меньше now).
function isOverdue(position, orderDate, now, completedStatusCodes) {
  if (!position || !orderDate || isNaN(orderDate.getTime())) return false;
  if (isNaN(now.getTime())) return false;

  // ABCP присылает isDelete строкой "0"/"1", а не булевым флагом —
  // сравниваем явно, чтобы строка "0" не отбрасывалась как истина.
  const deleted = position.isDelete === true || position.isDelete === 1 || String(position.isDelete) === '1';
  if (deleted) return false;
  const canceled = Number(position.isCanceled);
  if (canceled === 1 || canceled === 2) return false;
  // Позиция снята в отказ — в просрочке не показываем.
  if (isRefusal(position.status)) return false;

  const completed = (completedStatusCodes || []).map(statusKey);
  if (completed.includes(statusKey(position.statusCode))) return false;

  const planned = plannedDate(orderDate, position.deadline, position.deadlineMax);
  return planned.getTime() < now.getTime();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Строит отчёт: строки просроченных позиций, суммарные счётчики и разбивку по поставщикам.
function computeReport(orders, options = {}) {
  const now = options.now || new Date();
  const completedStatusCodes = options.completedStatusCodes || [];
  // Зашитые статусы, которые показываются в просрочке (остальные не отображаются).
  const ALLOWED_STATUSES = ['обработка заказа', 'заказан', 'отправлен поставщику', 'подтвержден поставщиком'];
  const rows = [];

  for (const order of orders || []) {
    const orderDate = parseOrderDate(order && order.date);
    if (isNaN(orderDate.getTime())) continue;
    const positions = (order && order.positions) || [];

    for (const pos of positions) {
      if (!isOverdue(pos, orderDate, now, completedStatusCodes)) continue;
      const stNorm = String(pos.status || '').trim().toLowerCase();
      if (!ALLOWED_STATUSES.includes(stNorm)) continue;
      const planned = plannedDate(orderDate, pos.deadline, pos.deadlineMax);
      const daysLate = Math.floor((now.getTime() - planned.getTime()) / MS_PER_DAY);
      const quantity = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      // В отчёте просрочки показываем закупочную сумму (priceIn).
      const price = toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      rows.push({
        id: pos.id,
        orderNumber: order.number,
        orderDate: order.date,
        client: clientName(order, options.names),
        clientId: order.userId != null ? String(order.userId) : '',
        distributor: pos.distributorName || '—',
        distributorId: pos.distributorId != null ? String(pos.distributorId) : '',
        brand: pos.brand || '',
        partNumber: pos.number || '',
        description: pos.description || '',
        quantity,
        price,
        sum: quantity * price,
        status: pos.status,
        statusCode: statusKey(pos.statusCode),
        deadlineHours: toNumber(pos.deadlineMax) > 0 ? toNumber(pos.deadlineMax) : toNumber(pos.deadline, 0),
        plannedDate: planned.toISOString(),
        daysLate,
      });
    }
  }

  const byDistributor = new Map();
  let totalOverdue = 0;
  let totalSum = 0;
  for (const r of rows) {
    totalOverdue += 1;
    totalSum += r.sum;
    const entry = byDistributor.get(r.distributor) || { name: r.distributor, overdue: 0, sum: 0 };
    entry.overdue += 1;
    entry.sum += r.sum;
    byDistributor.set(r.distributor, entry);
  }

  rows.sort((a, b) => b.daysLate - a.daysLate);
  const distributors = Array.from(byDistributor.values()).sort((a, b) => b.overdue - a.overdue);

  return { rows, totalOverdue, totalSum, byDistributor: distributors };
}

// Дашборд:
//  - ordersByDay: реальный объём всех заказов по дате заказа (сумма = поле sum заказа);
//  - issuedByDay: товары в статусе «выдан» по дате установки статуса (statusChangeDate);
//  - refusedByDay: отказы («отказ»/«отказ по браку» — одно и то же) по дате установки статуса.
// Суммы по товарам — продажная цена × количество.
function computeDashboard(orders, range = {}) {
  const oMap = new Map();
  const owMap = new Map();
  const iMap = new Map();
  const rMap = new Map();
  const mondayOf = (dateStr) => {
    const d = new Date(dateStr + 'T00:00:00');
    const shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return d.toISOString().slice(0, 10);
  };
  const addk = (m, day, count, sum) => {
    if (range.start && day < range.start) return;
    if (range.end && day > range.end) return;
    let e = m.get(day);
    if (!e) {
      e = { day, count: 0, sum: 0 };
      m.set(day, e);
    }
    e.count += count;
    e.sum += sum;
  };
  for (const order of orders || []) {
    const od = String(order.date || '').slice(0, 10);
    let cntAll = 0;
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      const val = qty * toNumber(pos.priceOut, 0);
      const st = String(pos.status || '');
      const sdate = isoDate(pos.statusChangeDate);
      // «Все заказы» считаем по всем позициям (включая отказы) — полное число штук.
      cntAll += qty;
      if (isRefusal(st)) {
        // отказная позиция идёт в «Отказы» (в дополнение к «Все заказы»).
        if (sdate) addk(rMap, sdate, qty, val);
        continue;
      }
      if (sdate && /выдан/i.test(st)) addk(iMap, sdate, qty, val);
    }
    if (od) addk(oMap, od, cntAll, Number(order.sum) || 0);
  }
  const sort = (m) => Array.from(m.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
  // Недельная агрегация «Все заказы за месяц»: группируем по понедельникам.
  for (const e of oMap.values()) {
    const wk = mondayOf(e.day);
    let we = owMap.get(wk);
    if (!we) { we = { day: wk, count: 0, sum: 0 }; owMap.set(wk, we); }
    we.count += e.count;
    we.sum += e.sum;
  }
  return { ordersByDay: sort(oMap), ordersByWeek: sort(owMap), issuedByDay: sort(iMap), refusedByDay: sort(rMap) };
}

// Шаблонный срок (часы) переводим в целые дни, округляя в большую сторону.
function toDays(hours) {
  const h = Number(hours);
  return Number.isFinite(h) && h > 0 ? Math.ceil(h / 24) : null;
}

// Сроки по поставщикам: текущий (deadline/deadlineMax) и реальный —
// время от даты заказа до статуса «Отгружен поставщиком».
function computeSupplierTerms(orders, shippedMap, orderedMap = {}) {
  const map = new Map();
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      const sup = pos.distributorName || '—';
      let st = map.get(sup);
      if (!st) {
        st = { name: sup, type: 'price', termMin: Infinity, termMax: -Infinity, realMin: Infinity, realMax: -Infinity, realList: [], count: 0 };
        map.set(sup, st);
      }
      // Онлайн-поставщик — заказ уходит через API: тип 22 либо маркер «[online]».
      if (isOnlineSupplier(sup) || Number(pos.distributorType) === 22) st.type = 'online';
      const termDays = toDays(Number(pos.deadlineMax) > 0 ? pos.deadlineMax : pos.deadline);
      if (termDays !== null) {
        if (termDays < st.termMin) st.termMin = termDays;
        if (termDays > st.termMax) st.termMax = termDays;
      }
      const shippedAt = shippedMap && shippedMap[pos.id];
      const curShip = /отгружен.*поставщик/i.test(String(pos.status || '')) ? pos.statusChangeDate : null;
      const refDate = shippedAt || (curShip ? pos.statusChangeDate : null);
      // Старт реального срока — дата статуса «Заказан» (из истории), иначе дата заказа.
      const startDate = orderedMap[pos.id] || order.date;
      if (refDate && startDate) {
        const d = spanDays(refDate, startDate);
        if (Number.isFinite(d) && d >= 0) {
          if (d < st.realMin) st.realMin = d;
          if (d > st.realMax) st.realMax = d;
          const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0) || 1;
          st.realList.push({ d, qty });
          st.count += 1;
        }
      }
    }
  }
  return Array.from(map.values())
    .map((s) => {
      const clean = cleanOutliers(s.realList);
      return {
        name: s.name,
        type: s.type,
        termMin: s.termMin === Infinity ? null : Math.round(s.termMin * 10) / 10,
        termMax: s.termMax === -Infinity ? null : Math.round(s.termMax * 10) / 10,
        realMin: coverageTerm(clean, 0.1),
        realMax: coverageTerm(clean, 0.95),
        realCover: coverageTerm(clean, 0.8),
        count: s.count,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}


// Отсеиваем единичные экстремальные сроки (выбросы): значение, которое
// сильно оторвано от медианы реальных сроков поставщика, не учитываем,
// чтобы один «зависший» заказ не искажал ни 80%, ни целевой срок.
function cleanOutliers(list) {
  if (!list || list.length < 4) return list;
  const ds = list.map((x) => x.d).sort((a, b) => a - b);
  const med = ds[Math.floor(ds.length / 2)];
  if (!med) return list;
  const thr = Math.max(med * 3, med + 14);
  return list.filter((x) => x.d <= thr);
}

// Срок, за который приходят не менее pct% деталей (по объёму), округлённый вверх.
function coverageTerm(list, pct = 0.9) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a.d - b.d);
  const total = sorted.reduce((s, x) => s + x.qty, 0);
  if (!total) return null;
  const target = pct * total;
  let cum = 0;
  for (const x of sorted) {
    cum += x.qty;
    if (cum >= target) return Math.ceil(x.d);
  }
  return Math.ceil(sorted[sorted.length - 1].d);
}

// Проценка: последние 100 уникальных артикулов и закупочная цена по выбранным
// поставщикам; сравниваем итоговую сумму и «% дешевле» относительно самого дешёвого.
function computePricing(orders, selectedSuppliers, maxArticles = 100, now = new Date()) {
  const byArt = new Map();
  const orderList = [];
  const selected = new Set(String(selectedSuppliers || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean));

  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      const num = String(pos.number || '').trim();
      if (!num) continue;
      const supplier = pos.distributorName || '';
      if (!selected.has(supplier)) continue;
      let a = byArt.get(num);
      if (!a) {
        a = { number: num, brand: pos.brand || '', description: pos.description || '', prices: {} };
        byArt.set(num, a);
        orderList.push(num);
      }
      if (a.prices[supplier] == null) {
        const price = toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
        if (price > 0) a.prices[supplier] = price;
      }
    }
  }

  const articles = orderList.slice(-maxArticles).map((n) => byArt.get(n)).filter(Boolean);
  const suppliers = Array.from(selected).sort();
  const totals = {};
  for (const s of suppliers) {
    let sum = 0;
    let cnt = 0;
    for (const a of articles) {
      if (a.prices[s] != null) {
        sum += a.prices[s];
        cnt += 1;
      }
    }
    totals[s] = { sum: Math.round(sum * 100) / 100, count: cnt };
  }

  const withSum = suppliers
    .map((s) => ({ supplier: s, sum: totals[s].sum, count: totals[s].count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => a.sum - b.sum);
  const maxSum = withSum.length ? withSum[withSum.length - 1].sum : 0;
  const comparison = withSum.map((x) => ({
    supplier: x.supplier,
    count: x.count,
    sum: x.sum,
    cheaperPercent: maxSum > 0 ? Math.round(((maxSum - x.sum) / maxSum) * 1000) / 10 : 0,
  }));

  return { articles, comparison, generatedAt: now.toISOString() };
}

// «Отчет Европа»: разбивка заказов поставщика «EU» по брендам за период (90 дней).
// Для каждого бренда: всего заказов, штук, сумма, % отказов (по сумме и по кол-ву),
// средний срок поставки от даты заказа до статуса «Выдан» (в днях, по issue date).
function computeEurope(orders, names, opts = {}) {
  const start = String(opts.start || '').slice(0, 10);
  const end = String(opts.end || '').slice(0, 10);
  const brands = new Map(); // бренд -> статистика
  const tot = { orders: new Set(), qty: 0, sum: 0, refusalsQty: 0, refusalsSum: 0, issuedSum: 0, delSum: 0, delN: 0 };
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      const sup = supplierBaseOf(pos.distributorName || '') || '';
      // Поставщик «EU» — в данных это вариант `1de.by EUR` (в UI переименован в «EU»).
      // Ловим его как `1de.by EUR...` (с любым суффиксом после «:»), либо буквально «EU».
      const full = String(pos.distributorName || '');
      const isEU = /^1de\.by\s+eur\b/i.test(sup) ||
        /^1de\.by\s+eur\b/i.test(full) ||
        /(^|[\s:()\-/])(eu)([\s:()\-/]|$)/i.test(sup);
      if (!isEU) continue; // только один поставщик EU
      const od = String(order.date || '').slice(0, 10);
      if (od && start && od < start) continue;
      if (od && end && od > end) continue;
      const rate = toNumber(pos.priceRate, 1) || 1;
      const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0) || 0;
      const pout = toNumber(pos.priceOut, 0);
      const sum = qty * pout * rate;
      const ordNo = String(order.number != null ? order.number : order.id);
      const { key: bKey, display: bDisplay } = normalizeBrand(pos.brand);
      if (!brands.has(bKey)) {
        brands.set(bKey, { brand: bDisplay, orders: new Set(), qty: 0, sum: 0, refusalsQty: 0, refusalsSum: 0, issuedSum: 0, delSum: 0, delN: 0 });
      }
      const b = brands.get(bKey);
      b.orders.add(ordNo);
      b.qty += qty;
      b.sum += sum;
      tot.orders.add(ordNo);
      tot.qty += qty;
      tot.sum += sum;
      if (isRefusal(pos.status)) {
        b.refusalsQty += qty;
        b.refusalsSum += sum;
        tot.refusalsQty += qty;
        tot.refusalsSum += sum;
      }
      // Сумма выданного — только позиции в статусе «Выдан».
      if (isIssued(pos.status)) {
        b.issuedSum += sum;
        tot.issuedSum += sum;
      }
      // Средний срок до выдачи — средневзвешенный по КОЛИЧЕСТВУ выданных деталей:
      // учитываются все 100% выданных позиций (взвешивание по штукам).
      if (isIssued(pos.status) && pos.statusChangeDate) {
      const d = spanDays(pos.statusChangeDate, order.date || pos.statusChangeDate);
        if (Number.isFinite(d) && d >= 0) {
          const w = qty || 0;
          b.delSum += w * d;
          b.delN += w;
          tot.delSum += w * d;
          tot.delN += w;
        }
      }
    }
  }
  const finalize = (b) => {
    const ordersN = b.orders.size;
    const refusalQtyPct = b.qty ? Math.round((b.refusalsQty / b.qty) * 1000) / 10 : 0;
    const refusalSumPct = b.sum ? Math.round((b.refusalsSum / b.sum) * 1000) / 10 : 0;
    const avgDays = b.delN ? Math.round((b.delSum / b.delN) * 10) / 10 : null;
    return {
      brand: b.brand,
      orders: ordersN,
      qty: Math.round(b.qty * 100) / 100,
      sum: Math.round(b.sum * 100) / 100,
      refusedQty: Math.round(b.refusalsQty * 100) / 100,
      refusedSum: Math.round(b.refusalsSum * 100) / 100,
      issuedSum: Math.round(b.issuedSum * 100) / 100,
      refusalQtyPct,
      refusalSumPct,
      avgDays,
    };
  };
  const brandRows = Array.from(brands.values()).map(finalize).sort((a, b) => b.sum - a.sum);
  const t = finalize(tot);
  return {
    brands: brandRows,
    totals: {
      orders: t.orders,
      qty: t.qty,
      sum: t.sum,
      refusedQty: t.refusedQty,
      refusedSum: t.refusedSum,
      issuedSum: t.issuedSum,
      refusalQtyPct: t.refusalQtyPct,
      refusalSumPct: t.refusalSumPct,
      avgDays: t.avgDays,
    },
    start,
    end,
  };
}

// «Конфигуратор сроков поставки для клиента»: по выбранным прайсовым поставщикам
// за 30 дней считаем РЕАЛЬНЫЙ срок так же, как в «Сроках по поставщикам»
// (от «Заказан» до «Отгружен поставщиком», по shippedMap/orderedMap), но по 100%
// заказов (без отсева выбросов и без процентиля). Итог: средний/мин/макс + общий средний.
function computeClientConfig(orders, shippedMap = {}, orderedMap = {}, opts = {}) {
  const start = String(opts.start || '').slice(0, 10);
  const end = String(opts.end || '').slice(0, 10);
  const selected = Array.isArray(opts.selected) && opts.selected.length
    ? new Set(opts.selected.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
    : null;
  const avail = new Map();
  const stats = new Map();
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      if (isOnlineSupplier(pos.distributorName)) continue; // только прайсовые (по почте)
      const sup = supplierBaseOf(pos.distributorName || '') || '—';
      const supKey = sup.toLowerCase();
      if (!avail.has(supKey)) avail.set(supKey, sup);
      if (selected && !selected.has(supKey)) continue;
      const od = String(order.date || '').slice(0, 10);
      if (od && start && od < start) continue;
      if (od && end && od > end) continue;
      // Реальный срок, как в «Сроках по поставщикам»: от «Заказан» до «Отгружен поставщиком».
      const shippedAt = shippedMap && shippedMap[pos.id];
      const curShip = /отгружен.*поставщик/i.test(String(pos.status || '')) ? pos.statusChangeDate : null;
      const refDate = shippedAt || (curShip ? pos.statusChangeDate : null);
      const startDate = (orderedMap && orderedMap[pos.id]) || order.date;
      if (!refDate || !startDate) continue;
      const d = spanDays(refDate, startDate);
      if (!Number.isFinite(d) || d < 0) continue;
      const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0) || 0;
      if (!stats.has(supKey)) stats.set(supKey, { sup, orders: new Set(), qty: 0, delSum: 0, delN: 0, minD: Infinity, maxD: -Infinity });
      const st = stats.get(supKey);
      st.orders.add(String(order.number != null ? order.number : order.id));
      st.qty += qty;
      st.delSum += qty * d;
      st.delN += qty;
      if (d < st.minD) st.minD = d;
      if (d > st.maxD) st.maxD = d;
    }
  }
  const rows = Array.from(stats.values()).map((st) => ({
    supplier: st.sup,
    orders: st.orders.size,
    qty: Math.round(st.qty),
    avgDays: st.delN ? Math.round((st.delSum / st.delN) * 10) / 10 : null,
    minDays: st.minD === Infinity ? null : st.minD,
    maxDays: st.maxD === -Infinity ? null : st.maxD,
  })).sort((a, b) => (b.avgDays || 0) - (a.avgDays || 0));
  let tSum = 0, tN = 0, tMin = Infinity, tMax = -Infinity;
  for (const r of rows) {
    if (r.qty > 0 && r.avgDays != null) { tSum += r.avgDays * r.qty; tN += r.qty; }
    if (r.minDays != null && r.minDays < tMin) tMin = r.minDays;
    if (r.maxDays != null && r.maxDays > tMax) tMax = r.maxDays;
  }
  return {
    suppliers: rows,
    availableSuppliers: Array.from(avail.values()).sort((a, b) => a.localeCompare(b, 'ru')),
    total: {
      avgDays: tN ? Math.round((tSum / tN) * 10) / 10 : null,
      minDays: tMin === Infinity ? null : tMin,
      maxDays: tMax === -Infinity ? null : tMax,
    },
    start,
    end,
  };
}

// Отчёт по отказам. По умолчанию группировка по поставщику; при opts.groupBy === 'client'
// — по клиенту (покупателю заказа). Считаем общее число позиций, число отказов,
// сумму отказов и процент отказов по каждому поставщику/клиенту.
function computeRejections(orders, opts = {}) {
  const groupBy = opts.groupBy === 'client' ? 'client' : 'distributor';
  // У поставщиков — закупочная сумма (priceIn), у клиентов — продажная (priceOut).
  const priceField = opts.priceField || 'priceOut';
  const byDist = new Map();
  const rows = [];
  let totalPositions = 0;
  let refusalPositions = 0;
  let refusalSum = 0;

  for (const order of orders || []) {
    const positions = (order && order.positions) || [];
    for (const pos of positions) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;

      const name = groupBy === 'client'
        ? (clientName(order, opts.names) || '—')
        : (pos.distributorName || '—');
      let entry = byDist.get(name);
      if (!entry) {
        entry = { name, total: 0, refusals: 0 };
        byDist.set(name, entry);
      }
      const q1 = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      entry.total += q1; // по физическому количеству штук
      totalPositions += 1;

      if (isRefusal(pos.status)) {
        entry.refusals += q1; // по физическому количеству штук
        refusalPositions += 1;
        const price = toNumber(pos[priceField] != null ? pos[priceField] : pos.priceOut, 0);
        const sum = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * price;
        entry.refusalSum = (entry.refusalSum || 0) + sum;
        refusalSum += sum;
        // «Отказ по браку» и «Отказ» приравниваем к одному статусу «Отказ».
        const normalizedStatus = 'Отказ';
        rows.push({
          id: pos.id,
          orderNumber: order.number,
          orderDate: order.date,
          client: clientName(order, opts.names),
          clientId: order.userId != null ? String(order.userId) : '',
          distributor: pos.distributorName || '—',
          distributorId: pos.distributorId != null ? String(pos.distributorId) : '',
          brand: pos.brand || '',
          partNumber: pos.number || '',
          description: pos.description || '',
          quantity: toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0),
          sum,
          status: normalizedStatus,
          statusCode: statusKey(pos.statusCode),
        });
      }
    }
  }

  const byDistributor = Array.from(byDist.values())
    .sort((a, b) => b.refusals - a.refusals)
    .map((d) => ({
      ...d,
      percent: d.total ? Math.round((d.refusals / d.total) * 1000) / 10 : 0,
    }));

  return { totalPositions, refusalPositions, refusalSum, byDistributor, rows };
}

// Детализация отказов по поставщикам внутри каждого клиента (для модального окна
// «Отчёт по клиентам»): по паре клиент→поставщик считаем всего позиций, отказов,
// сумму отказов и число заказов, где были отказы.
function buildClientSuppliers(orders, names) {
  const byClient = new Map();
  for (const order of orders || []) {
    const client = clientName(order, names) || '—';
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;

      const sup = pos.distributorName || '—';
      let cm = byClient.get(client);
      if (!cm) {
        cm = new Map();
        byClient.set(client, cm);
      }
      let st = cm.get(sup);
      if (!st) {
        st = { name: sup, total: 0, refusals: 0, sum: 0, allSum: 0, work: 0, workSum: 0, issued: 0, issuedSum: 0, orders: new Set() };
        cm.set(sup, st);
      }
      const q1 = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      st.total += q1;
      const sVal = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
        * toNumber(pos.priceOut, 0);
      st.allSum += Number.isFinite(sVal) ? sVal : 0;
      if (isRefusal(pos.status)) {
        st.refusals += q1;
        st.sum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceOut, 0);
} else if (isIssued(pos.status)) {
        st.issued += q1;
        st.issuedSum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceOut, 0);
      } else {
        st.work += q1;
        st.workSum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceOut, 0);
      }
    }
  }

  const out = [];
  for (const [client, cm] of byClient) {
    const suppliers = [];
    for (const st of cm.values()) {
      suppliers.push({
        name: st.name,
        total: st.total,
        refusals: st.refusals,
        sum: Math.round(st.sum * 100) / 100,
        allSum: Math.round(st.allSum * 100) / 100,
        percent: st.total ? Math.round((st.refusals / st.total) * 1000) / 10 : 0,
        percentBySum: st.allSum ? Math.round((st.sum / st.allSum) * 1000) / 10 : 0,
        ordersInRefusal: st.orders.size,
        work: st.work,
        workSum: Math.round(st.workSum * 100) / 100,
        issued: st.issued,
        issuedSum: Math.round(st.issuedSum * 100) / 100,
      });
    }
    suppliers.sort((a, b) => b.refusals - a.refusals);
    out.push({ client, suppliers });
  }
  return out;
}

// Для отчёта «Отказы поставщики»: клиенты конкретного поставщика (отказы, процент, сумма).
function buildSupplierClients(orders, names, supplier) {
  const byClient = new Map();
  const supKey = String(supplier || '').trim().toLowerCase();
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      if (String(pos.distributorName || '').trim().toLowerCase() !== supKey) continue;
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;

      const client = clientName(order, names) || '—';
      let st = byClient.get(client);
      if (!st) {
        st = { client, total: 0, refusals: 0, sum: 0, allSum: 0, work: 0, workSum: 0, issued: 0, issuedSum: 0, orders: new Set() };
        byClient.set(client, st);
      }
      const q1 = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      st.total += q1;
      const aVal = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
        * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      st.allSum += Number.isFinite(aVal) ? aVal : 0;
      if (isRefusal(pos.status)) {
        st.refusals += q1;
        st.sum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
} else if (isIssued(pos.status)) {
        st.issued += q1;
        st.issuedSum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      } else {
        st.work += q1;
        st.workSum += toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0)
          * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      }
    }
  }
  return Array.from(byClient.values())
    .sort((a, b) => b.refusals - a.refusals)
    .map((x) => ({
      client: x.client,
      total: x.total,
      refusals: x.refusals,
      percent: x.total ? Math.round((x.refusals / x.total) * 1000) / 10 : 0,
      sum: Math.round(x.sum * 100) / 100,
      allSum: Math.round(x.allSum * 100) / 100,
      ordersInRefusal: x.orders.size,
      percentBySum: x.allSum ? Math.round((x.sum / x.allSum) * 1000) / 10 : 0,
      work: x.work,
      workSum: Math.round(x.workSum * 100) / 100,
      issued: x.issued,
      issuedSum: Math.round(x.issuedSum * 100) / 100,
    }));
}

// Для отчёта «Отказы поставщики»: разбивка по складам/направлениям конкретного поставщика
// (склад — всё, что после первого «:» в названии). Суммы — закупочные (priceIn).
function buildSupplierWarehouses(orders, baseSupplier) {
  const baseKey = String(baseSupplier || '').trim().toLowerCase();
  const byWh = new Map();
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const del = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (del) continue;
      const can = Number(pos.isCanceled);
      if (can === 1 || can === 2) continue;
      const { base, wh } = supplierParts(pos.distributorName);
      if (base.toLowerCase() !== baseKey || !wh) continue;
      let e = byWh.get(wh);
      if (!e) {
        e = { warehouse: wh, total: 0, refusals: 0, sum: 0, allSum: 0, work: 0, workSum: 0, issued: 0, issuedSum: 0 };
        byWh.set(wh, e);
      }
      const q1 = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      const val = q1 * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      e.total += q1;
      e.allSum += Number.isFinite(val) ? val : 0;
      if (isRefusal(pos.status)) {
        e.refusals += q1;
        e.sum += Number.isFinite(val) ? val : 0;
      } else if (isIssued(pos.status)) {
        e.issued += q1;
        e.issuedSum += Number.isFinite(val) ? val : 0;
      } else {
        e.work += q1;
        e.workSum += Number.isFinite(val) ? val : 0;
      }
    }
  }
  return Array.from(byWh.values())
    .sort((a, b) => b.refusals - a.refusals)
    .map((e) => ({
      warehouse: e.warehouse,
      total: e.total,
      refusals: e.refusals,
      percent: e.total ? Math.round((e.refusals / e.total) * 1000) / 10 : 0,
      sum: Math.round(e.sum * 100) / 100,
      allSum: Math.round(e.allSum * 100) / 100,
      percentBySum: e.allSum ? Math.round((e.sum / e.allSum) * 1000) / 10 : 0,
      work: e.work,
      workSum: Math.round(e.workSum * 100) / 100,
      issued: e.issued,
      issuedSum: Math.round(e.issuedSum * 100) / 100,
    }));
}

// Для вложенного окна: склады, по которым у клиента были заказы у данного поставщика.
function buildClientWarehouses(orders, baseSupplier, client, names, priceField) {
  const supKey = String(baseSupplier || '').trim().toLowerCase();
  const cKey = String(client || '').trim().toLowerCase();
  const pf = priceField || 'priceIn';
  const byWh = new Map();
  for (const order of orders || []) {
    const cName = (clientName(order, names) || '—').trim().toLowerCase();
    if (cName !== cKey) continue;
    for (const pos of order.positions || []) {
      const del = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (del) continue;
      const can = Number(pos.isCanceled);
      if (can === 1 || can === 2) continue;
      if (String(pos.distributorName || '').trim().toLowerCase() !== supKey) continue;
      // Позиции без заполненного поля склада группируются в «Без склада», чтобы итог
      // разбивки по складам сходился с общим итогом по поставщику.
      const wh = warehouseOf(pos) || 'Без склада';
      let e = byWh.get(wh);
      if (!e) {
        e = { warehouse: wh, total: 0, refusals: 0, sum: 0, allSum: 0, work: 0, workSum: 0, issued: 0, issuedSum: 0 };
        byWh.set(wh, e);
      }
      const q1 = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      const val = q1 * toNumber(pos[pf] != null ? pos[pf] : pos.priceOut, 0);
      e.total += q1;
      e.allSum += Number.isFinite(val) ? val : 0;
      if (isRefusal(pos.status)) {
        e.refusals += q1;
        e.sum += Number.isFinite(val) ? val : 0;
      } else if (isIssued(pos.status)) {
        e.issued += q1;
        e.issuedSum += Number.isFinite(val) ? val : 0;
      } else {
        e.work += q1;
        e.workSum += Number.isFinite(val) ? val : 0;
      }
    }
  }
  return Array.from(byWh.values())
    .sort((a, b) => b.refusals - a.refusals)
    .map((e) => ({
      warehouse: e.warehouse,
      total: e.total,
      refusals: e.refusals,
      percent: e.total ? Math.round((e.refusals / e.total) * 1000) / 10 : 0,
      sum: Math.round(e.sum * 100) / 100,
      allSum: Math.round(e.allSum * 100) / 100,
      percentBySum: e.allSum ? Math.round((e.sum / e.allSum) * 1000) / 10 : 0,
      work: e.work,
      workSum: Math.round(e.workSum * 100) / 100,
      issued: e.issued,
      issuedSum: Math.round(e.issuedSum * 100) / 100,
    }));
}

// Анализ заказов по клиентам: сумма продаж (priceOut), себестоимость/закупка (priceIn),
// маржа и её процент. Группируем по клиенту, фильтруем по периоду даты заказа.
function computeClientAnalysis(orders, names, range = {}) {
  const byClient = new Map();
  for (const order of orders || []) {
    // Группируем по коду клиента (как в выгрузке ABCP: «Код клиента»), чтобы заказы
    // одного клиента не распадались по разным именам из-за неполного справочника.
    const clientNameStr = clientName(order, names) || '';
    const clientKey = order.userId != null ? String(order.userId) : (clientNameStr || '—');
    let a = byClient.get(clientKey);
    if (!a) {
      a = { client: clientKey, clientName: null, sum: 0, cost: 0, qty: 0, orders: new Set() };
      byClient.set(clientKey, a);
    }
    if (!a.clientName && clientNameStr) a.clientName = clientNameStr;
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      // Считаем только выданные позиции (статус «Выдан»): сумма = продажа
      // (priceOut), закупочная = закупка (priceIn) тех же позиций.
      if (!isIssued(pos.status)) continue;
      // «Выдано» относим к интервалу по дате статуса «Выдан» (statusChangeDate).
      const sdate = isoDate(pos.statusChangeDate);
      if (!sdate) continue;
      if (range.start && sdate < range.start) continue;
      if (range.end && sdate > range.end) continue;
      const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0);
      if (!qty) continue;
      // Цены ABCP хранит в базовой валюте; в выгрузке/финансах они приводятся к валюте
      // сайта/клиента умножением на priceRate. Умножаем, чтобы суммы совпали с ABCP.
      const rate = toNumber(pos.priceRate, 1) || 1;
      a.sum += qty * toNumber(pos.priceOut, 0) * rate;
      a.cost += qty * toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0) * rate;
      a.qty += qty;
      if (order.id != null) a.orders.add(order.id);
      else if (order.number != null) a.orders.add(order.number);
    }
  }
  const clients = [];
  for (const a of byClient.values()) {
    a.client = a.clientName || a.client; // показываем человеческое имя
    delete a.clientName;
    a.margin = a.sum - a.cost;
    a.marginPct = a.sum ? (a.margin / a.sum) * 100 : 0;
    a.orderCount = a.orders.size;
    delete a.orders;
    a.sum = Math.round(a.sum * 100) / 100;
    a.cost = Math.round(a.cost * 100) / 100;
    a.margin = Math.round(a.margin * 100) / 100;
    a.marginPct = Math.round(a.marginPct * 10) / 10;
    a.qty = Math.round(a.qty);
    clients.push(a);
  }
  clients.sort((x, y) => y.sum - x.sum);
  const totals = clients.reduce(
    (t, a) => {
      t.sum += a.sum; t.cost += a.cost; t.margin += a.margin; t.qty += a.qty; t.orderCount += a.orderCount;
      return t;
    },
    { sum: 0, cost: 0, margin: 0, qty: 0, orderCount: 0 }
  );
  totals.marginPct = totals.sum ? Math.round((totals.margin / totals.sum) * 1000) / 10 : 0;
  totals.sum = Math.round(totals.sum * 100) / 100;
  totals.cost = Math.round(totals.cost * 100) / 100;
  totals.margin = Math.round(totals.margin * 100) / 100;
  return {
    clients,
    totals,
    ordersCount: (orders || []).length,
    generatedAt: new Date().toISOString(),
  };
}

// «Ручной автомат»: таблица позиций в статусе «Принят» за текущий день по вручную
// выбранным поставщикам (прайс-лист, без API/[online]). availableSuppliers — ВСЕ
// не-онлайн поставщики из переданного набора (широкое окно), чтобы список выбора был
// заполнен даже в дни без заказов. rows — только за текущий день (opts.todayStr).
function computeManualAutomat(orders, names, opts = {}) {
  const selected = Array.isArray(opts.suppliers) && opts.suppliers.length
    ? new Set(opts.suppliers.map((s) => String(s).trim().toLowerCase()).filter(Boolean))
    : null; // null = все поставщики
  const today = String(opts.todayStr || '').slice(0, 10);
  const avail = new Map();
  const rows = [];
  const clients = new Map(); // по всем статусам (не только «Принят»)
  const todayT = { positions: 0, qty: 0, sum: 0, orders: new Set() };
  for (const order of orders || []) {
    for (const pos of order.positions || []) {
      const deleted = pos.isDelete === true || pos.isDelete === 1 || String(pos.isDelete) === '1';
      if (deleted) continue;
      const canceled = Number(pos.isCanceled);
      if (canceled === 1 || canceled === 2) continue;
      // Исключаем API/онлайн-поставщиков — остаются только «прайс-лист» (заказы по почте).
      if (isOnlineSupplier(pos.distributorName)) continue;
      const sup = supplierBaseOf(pos.distributorName) || '—';
      // Поставщика «Сток Партс» в ручном автомате не ведём — ни заказы, ни выбор.
      if (/сток\s*партс/i.test(sup) || /сток\s*партс/i.test(String(pos.distributorName || ''))) continue;
      const supKey = sup.toLowerCase();
      if (!avail.has(supKey)) avail.set(supKey, sup); // список для выбора (все не-онлайн)
      const od = String(order.date || '').slice(0, 10);
      if (today && od !== today) continue; // строки — только за текущий день
      if (selected && !selected.has(supKey)) continue;
      const cname = clientName(order, names) || '—';
      const ordNo = String(order.number != null ? order.number : order.id);
      const rateC = toNumber(pos.priceRate, 1) || 1;
      const qtyC = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0) || 0;
      const poutC = toNumber(pos.priceOut, 0);
      const pinC = toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      if (!clients.has(cname)) clients.set(cname, { orders: new Set(), qty: 0, sum: 0, margin: 0 });
      const cl = clients.get(cname);
      cl.orders.add(ordNo);
      cl.qty += qtyC;
      cl.sum += qtyC * poutC * rateC;
      cl.margin += qtyC * (poutC - pinC) * rateC;
      // Итоги за день — из того же набора, что и «Заказы клиентов», чтобы
      // «Сумма сегодня» и сумма в модалке клиентов всегда совпадали.
      todayT.positions += 1;
      todayT.qty += qtyC;
      todayT.sum += qtyC * poutC * rateC;
      todayT.orders.add(ordNo);
      if (!isAccepted(pos.status)) continue;
      const rate = toNumber(pos.priceRate, 1) || 1;
      const qty = toNumber(pos.quantityFinal != null ? pos.quantityFinal : pos.quantity, 0) || 0;
      const pout = toNumber(pos.priceOut, 0);
      const pin = toNumber(pos.priceIn != null ? pos.priceIn : pos.priceOut, 0);
      rows.push({
        positionId: pos.id != null ? pos.id : (pos.positionId != null ? pos.positionId : ''),
        orderNumber: order.number != null ? order.number : order.id,
        orderDate: String(order.date || '').slice(0, 16),
        client: clientName(order, names) || '—',
        supplier: sup,
        brand: pos.brand || '',
        code: pos.number || '',
        description: pos.description || '',
        qty,
        price: Math.round(pout * rate * 100) / 100,
        priceIn: Math.round(pin * rate * 100) / 100,
        margin: Math.round((pout - pin) * rate * 100) / 100,
        marginPct: pout ? Math.round(((pout - pin) / pout) * 1000) / 10 : 0,
        sum: Math.round(qty * pout * rate * 100) / 100,
        sumIn: Math.round(qty * pin * rate * 100) / 100,
        status: pos.status,
        comment: pos.comment || '',
      });
    }
  }
  rows.sort((a, b) => String(a.orderDate).localeCompare(String(b.orderDate)) || String(a.orderNumber).localeCompare(String(b.orderNumber)));
  const available = Array.from(avail.values()).sort((x, y) => x.localeCompare(y, 'ru'));
  const clientRows = Array.from(clients.entries())
    .map(([name, c]) => ({
      client: name,
      orders: c.orders.size,
      qty: c.qty,
      sum: Math.round(c.sum * 100) / 100,
      margin: Math.round(c.margin * 100) / 100,
      marginPct: c.sum ? Math.round((c.margin / c.sum) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.sum - a.sum);
  return {
    rows,
    clients: clientRows,
    todayTotals: {
      positions: todayT.positions,
      qty: todayT.qty,
      sum: Math.round(todayT.sum * 100) / 100,
      orders: todayT.orders.size,
    },
    availableSuppliers: available,
    ordersCount: (orders || []).length,
    generatedAt: new Date().toISOString(),
  };
}

// Оставляет только позиции, которых нет в наборе уже отправленных сегодня
// (гард против повторной отправки «Принят» → «Заказан» в Ручном автомате).
function filterNotSentToday(items, sentToday) {
  const set = sentToday instanceof Set
    ? sentToday
    : new Set((sentToday || []).map((x) => String(x)));
  return (items || []).filter((it) => !set.has(String(it && it.positionId)));
}

// Свой парсер дат ABCP (Date.parse эти форматы в Node не понимает):
// и «dd.mm.yyyy hh:mm:ss», и «YYYY-MM-DD HH:mm:ss».
function parseAbcpDate(s) {
  if (!s) return NaN;
  const str = String(s).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = /^(\d{2})\.(\d{2})\.(\d{4})[ ](\d{2}):(\d{2}):(\d{2})/.exec(str);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  return NaN;
}

// Точное совпадение статуса с явным списком «заказ принят» (не префикс).
const ACCEPTED_STATUSES = ['принят'];
function isAcceptedStatus(text) {
  return ACCEPTED_STATUSES.includes(String(text || '').trim().toLowerCase());
}

module.exports = {
  parseOrderDate,
  plannedDate,
  isOverdue,
  computeReport,
  computeDashboard,
  computeClientAnalysis,
  computeManualAutomat,
  computeEurope,
  computeClientConfig,
  computeSupplierTerms,
  computePricing,
  normalizeBrand,
  computeRejections,
  buildClientSuppliers,
  buildSupplierClients,
  buildSupplierWarehouses,
  buildClientWarehouses,
  supplierParts,
  isRefusal,
  statusKey,
  clientName,
  filterNotSentToday,
  parseAbcpDate,
  isAcceptedStatus,
};
