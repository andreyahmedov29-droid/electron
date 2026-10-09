const { test } = require('node:test');
const assert = require('node:assert');

const { makeCache, isSnapFresh } = require('../lib/cache');
const { subtractDays, periodedSettings } = require('../lib/periods');
const { normalizeBrand, computeEurope, computeClientConfig, computeSupplierTerms, computeClientAnalysis } = require('../lib/logic');

/* ---------- lib/cache ---------- */
test('makeCache: хранит и подогревает ключи, вытесняет самые старые', () => {
  const c = makeCache(2);
  c.set('a', 1); c.set('b', 2); c.set('c', 3); // лимит 2 -> a вытеснен
  assert.strictEqual(c.get('a'), undefined);
  assert.strictEqual(c.get('b'), 2);
  assert.strictEqual(c.has('c'), true);
  c.clear();
  assert.strictEqual(c.has('b'), false);
});

test('isSnapFresh: сегодняшний снимок свежий, вчерашний — нет', () => {
  const today = new Date().toISOString();
  assert.strictEqual(isSnapFresh({ generatedAt: today }), true);
  assert.strictEqual(isSnapFresh({}), false);
  assert.strictEqual(isSnapFresh({ generatedAt: '2000-01-01T00:00:00Z' }), false);
});

/* ---------- lib/periods ---------- */
test('subtractDays: вычитает дни, не выходя за валидные границы', () => {
  assert.strictEqual(subtractDays('x', 3), '');
  const r = subtractDays('2026-10-03', 3);
  assert.ok(r < '2026-10-03'); // стало раньше
});

test('periodedSettings: валидный период сохраняется, перевёрнутый сбрасывается на текущий месяц', () => {
  const s = periodedSettings({ reportPeriod: { start: '2026-01-01', end: '2026-09-30' } }, 'reportPeriod');
  assert.strictEqual(s.dateStart, '2026-01-01');
  assert.strictEqual(s.dateEnd, '2026-09-30');
  const inv = periodedSettings({ reportPeriod: { start: '2026-09-30', end: '2026-01-01' } }, 'reportPeriod');
  assert.ok(/^\d{4}-\d{2}-01$/.test(inv.dateStart), 'старт — 1-е число текущего месяца');
  assert.ok(inv.dateEnd >= inv.dateStart, 'конец не раньше старта');
});

/* ---------- lib/logic: нормализация брендов ---------- */
test('normalizeBrand: слияние регистра/разделителей и алиасов', () => {
  assert.strictEqual(normalizeBrand('HYUNDAI / KIA').key, normalizeBrand('Hyundai-KIA').key);
  assert.strictEqual(normalizeBrand('MERCEDES-BENZ').display, 'MERCEDES-BENZ');
  assert.strictEqual(normalizeBrand('daimler').key, 'mercedes-benz');
  assert.strictEqual(normalizeBrand('rover').key, 'land-rover');
  assert.strictEqual(normalizeBrand('ROVER').display, 'LAND ROVER');
});

/* ---------- lib/logic: computeEurope (только EU, агрегация по бренду) ---------- */
function madeOrder(date, number, positions) {
  return { date, number, positions };
}
function madePos(distributorName, brand, opts = {}) {
  return {
    distributorName, brand,
    quantityFinal: opts.qty || 1,
    priceOut: opts.pout || 100,
    priceRate: opts.rate != null ? opts.rate : 1,
    status: opts.status || 'Заказан',
    statusChangeDate: opts.scd || null,
    isDelete: 0, isCanceled: 0,
  };
}

test('computeEurope: считает только поставщика EU и группирует бренд', () => {
  const orders = [
    madeOrder('2026-09-01', '1', [madePos('1de.by EUR', 'BMW', { status: 'Выдан', scd: '02.09.2026 12:00:00', pout: 100, rate: 1 })]),
    madeOrder('2026-09-01', '2', [madePos('1de.by EUR', 'BMW', { status: 'Выдан', scd: '03.09.2026 12:00:00', pout: 200, rate: 1 })]),
    madeOrder('2026-09-01', '3', [madePos('ДРУГОЙ', 'BMW', { status: 'Выдан' })]), // не EU
  ];
  const res = computeEurope(orders, {}, { start: '2026-01-01', end: '2026-09-30' });
  const bmw = res.brands.find((b) => b.brand === 'BMW');
  assert.ok(bmw, 'бренд BMW должен присутствовать');
  assert.strictEqual(bmw.orders, 2); // только 2 позиции EU
  assert.strictEqual(bmw.sum, 300); // 100 + 200
  assert.strictEqual(res.totals.orders, 2);
});

/* ---------- lib/logic: computeClientConfig (мин/макс/средний) ---------- */
test('computeClientConfig: выбранный поставщик, реальный срок по отгрузке', () => {
  const shippedMap = {};
  const orderedMap = {};
  const orders = [
    madeOrder('2026-09-01', '1', [madePos('ABV', 'X', { status: 'Отгружен поставщиком', scd: '03.09.2026 00:00:00' })]),
  ];
  // Отгруженный статус уже даёт refDate из statusChangeDate; orderedMap пуст — старт = дата заказа.
  computed = computeClientConfig(orders, shippedMap, orderedMap, {
    start: '2026-09-01', end: '2026-10-01', selected: ['abv'],
  });
  const row = computed.suppliers.find((s) => s.supplier === 'ABV');
  assert.ok(row, 'поставщик ABV должен быть');
  assert.strictEqual(row.minDays, 2); // 03.09 - 01.09 = 2 дня
  assert.strictEqual(row.maxDays, 2);
  assert.strictEqual(row.avgDays, 2);
});

/* ---------- lib/logic: computeSupplierTerms ---------- */
test('computeSupplierTerms: реальный срок по отгрузке и макс. срок из часов', () => {
  const order = {
    date: '2026-09-01',
    number: '1',
    id: 'o1',
    positions: [{
      id: 'p1',
      distributorName: 'ABV',
      deadlineMax: 48, // 2 дня
      quantityFinal: 2,
      status: 'Отгружен поставщиком',
      statusChangeDate: '03.09.2026 00:00:00',
      isDelete: 0, isCanceled: 0,
    }],
  };
  const res = computeSupplierTerms([order], {}, {});
  const abv = res.find((s) => s.name === 'ABV');
  assert.ok(abv);
  assert.strictEqual(abv.type, 'price');
  assert.strictEqual(abv.termMax, 2);
  assert.strictEqual(abv.realCover, 2); // 02.09→04.09? нет: 03.09-01.09=2
});

/* ---------- lib/logic: computeClientAnalysis ---------- */
test('computeClientAnalysis: сумма/маржа по выданному, фильтр по дате выдачи', () => {
  const orders = [
    {
      userId: '10', id: 'A', date: '2026-09-01',
      positions: [{ id: 'p1', status: 'Выдан', statusChangeDate: '02.09.2026 00:00:00', quantityFinal: 2, priceOut: 100, priceIn: 80, priceRate: 1, isDelete: 0, isCanceled: 0 }],
    },
    {
      userId: '11', id: 'B', date: '2026-09-01',
      positions: [{ id: 'p2', status: 'Выдан', statusChangeDate: '05.08.2026 00:00:00', quantityFinal: 1, priceOut: 100, priceIn: 70, priceRate: 1, isDelete: 0, isCanceled: 0 }],
    },
  ];
  const res = computeClientAnalysis(orders, {}, { start: '2026-09-01', end: '2026-09-30' });
  // Клиент 11 (выдача вне периода) остаётся строкой с нулевой суммой — это поведение функции.
  assert.strictEqual(res.clients.length, 2);
  const c = res.clients.find((x) => x.client === '10');
  assert.ok(c);
  assert.strictEqual(c.sum, 200); // 2 × 100
  assert.strictEqual(c.cost, 160); // 2 × 80
  assert.strictEqual(c.margin, 40);
  assert.strictEqual(c.qty, 2);
  assert.strictEqual(c.orderCount, 1);
  assert.strictEqual(res.clients.find((x) => x.client === '11').sum, 0);
});
