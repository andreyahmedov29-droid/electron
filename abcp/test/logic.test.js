const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseOrderDate,
  plannedDate,
  isOverdue,
  computeReport,
  computeRejections,
  isRefusal,
  filterNotSentToday,
  parseAbcpDate,
  isAcceptedStatus,
  normalizeBrand,
} = require('../lib/logic');

test('filterNotSentToday пропускает уже отправленные сегодня позиции', () => {
  const items = [
    { positionId: '111', orderNumber: 'A' },
    { positionId: '222', orderNumber: 'B' },
    { positionId: '333', orderNumber: 'C' },
  ];
  const sent = new Set(['222', '999']);
  const out = filterNotSentToday(items, sent);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].positionId, '111');
  assert.strictEqual(out[1].positionId, '333');
});

test('filterNotSentToday принимает обычный массив', () => {
  const items = [
    { positionId: 1 },
    { positionId: 2 },
    { positionId: '3' },
  ];
  const out = filterNotSentToday(items, ['2']);
  assert.deepStrictEqual(out.map((x) => x && x.positionId), [1, '3']);
});

test('parseAbcpDate понимает формат dd.mm.yyyy hh:mm:ss', () => {
  const t = parseAbcpDate('07.10.2026 11:26:08');
  assert.ok(Number.isFinite(t));
  const d = new Date(t);
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 9); // октябрь
  assert.strictEqual(d.getUTCDate(), 7);
  assert.strictEqual(d.getUTCHours(), 11);
});

test('parseAbcpDate понимает формат YYYY-MM-DD HH:mm:ss', () => {
  const t = parseAbcpDate('2026-10-07 11:26:08');
  assert.ok(Number.isFinite(t));
  const d = new Date(t);
  assert.strictEqual(d.getUTCDate(), 7);
  assert.strictEqual(d.getUTCHours(), 11);
});

test('parseAbcpDate возвращает NaN для непонятного формата', () => {
  assert.ok(Number.isNaN(parseAbcpDate('не дата')));
  assert.ok(Number.isNaN(parseAbcpDate('')));
});

test('isAcceptedStatus — только точный «принят», не префикс', () => {
  assert.strictEqual(isAcceptedStatus('Принят'), true);
  assert.strictEqual(isAcceptedStatus(' принят '), true);
  assert.strictEqual(isAcceptedStatus('Принят в обработку (возврат)'), false);
  assert.strictEqual(isAcceptedStatus('Заказан'), false);
});

test('normalizeBrand объединяет Peugeot-Citroen и CITROEN/PEUGEOT', () => {
  assert.strictEqual(normalizeBrand('Peugeot-Citroen').display, 'Peugeot-Citroen');
  assert.strictEqual(normalizeBrand('CITROEN/PEUGEOT').display, 'Peugeot-Citroen');
  assert.strictEqual(normalizeBrand('Peugeot-Citroen').key, 'peugeot/citroen');
  assert.strictEqual(normalizeBrand('CITROEN/PEUGEOT').key, 'peugeot/citroen');
});

test('normalizeBrand объединяет ROVER/LAND ROVER и LAND ROVER', () => {
  assert.strictEqual(normalizeBrand('LAND ROVER').display, 'LAND ROVER');
  assert.strictEqual(normalizeBrand('ROVER/LAND ROVER').display, 'LAND ROVER');
  assert.strictEqual(normalizeBrand('ROVER/LAND ROVER').key, 'land-rover');
});

test('normalizeBrand объединяет MERCEDES-BENZ и Daimler AG', () => {
  assert.strictEqual(normalizeBrand('MERCEDES-BENZ').display, 'MERCEDES-BENZ');
  assert.strictEqual(normalizeBrand('Daimler AG').display, 'MERCEDES-BENZ');
  assert.strictEqual(normalizeBrand('Daimler AG').key, 'mercedes-benz');
});

test('parseOrderDate разбирает дату ABCP вида "YYYY-MM-DD HH:mm:ss"', () => {
  const d = parseOrderDate('2026-09-10 08:00:00');
  assert.ok(d instanceof Date);
  assert.strictEqual(d.getUTCFullYear(), 2026);
  assert.strictEqual(d.getUTCMonth(), 8); // сентябрь
  assert.strictEqual(d.getUTCDate(), 10);
  assert.strictEqual(d.getUTCHours(), 8);
});

test('plannedDate использует deadlineMax, когда он больше нуля', () => {
  const date = parseOrderDate('2026-09-10 00:00:00');
  const result = plannedDate(date, 24, 72);
  assert.strictEqual(result.getUTCDate(), 13); // +72 часа = +3 дня
});

test('plannedDate использует deadline (обычный срок), когда deadlineMax равен 0', () => {
  const date = parseOrderDate('2026-09-10 00:00:00');
  const result = plannedDate(date, 48, 0);
  assert.strictEqual(result.getUTCDate(), 12); // +48 часов = +2 дня
});

test('позиция просрочена: плановая дата в прошлом, статус не завершён', () => {
  const orderDate = parseOrderDate('2026-09-01 00:00:00');
  const now = parseOrderDate('2026-09-20 00:00:00');
  const position = {
    statusCode: '10',
    deadline: 24,
    deadlineMax: 24,
    isDelete: false,
    isCanceled: 0,
  };
  assert.strictEqual(isOverdue(position, orderDate, now, []), true);
});

test('позиция НЕ просрочена, если её статус входит в завершающие', () => {
  const orderDate = parseOrderDate('2026-09-01 00:00:00');
  const now = parseOrderDate('2026-09-20 00:00:00');
  const position = {
    statusCode: '15',
    deadline: 24,
    deadlineMax: 24,
    isDelete: false,
    isCanceled: 0,
  };
  assert.strictEqual(isOverdue(position, orderDate, now, ['15']), false);
});

test('позиция НЕ просрочена, если плановая дата ещё не наступила', () => {
  const orderDate = parseOrderDate('2026-09-25 00:00:00');
  const now = parseOrderDate('2026-09-20 00:00:00');
  const position = {
    statusCode: '10',
    deadline: 24,
    deadlineMax: 24,
    isDelete: false,
    isCanceled: 0,
  };
  assert.strictEqual(isOverdue(position, orderDate, now, []), false);
});

test('удалённые и отменённые позиции не считаются просроченными', () => {
  const orderDate = parseOrderDate('2026-09-01 00:00:00');
  const now = parseOrderDate('2026-09-20 00:00:00');
  const deleted = {
    statusCode: '10', deadline: 24, deadlineMax: 24,
    isDelete: true, isCanceled: 0,
  };
  const canceled = {
    statusCode: '10', deadline: 24, deadlineMax: 24,
    isDelete: false, isCanceled: 1,
  };
  assert.strictEqual(isOverdue(deleted, orderDate, now, []), false);
  assert.strictEqual(isOverdue(canceled, orderDate, now, []), false);
});

test('строковые флаги ABCP "0" не отбрасывают позицию как удалённую', () => {
  // ABCP присылает isDelete/isCanceled строками "0"/"1"; строка "0" должна
  // трактоваться как «не удалена / не отменена».
  const orderDate = parseOrderDate('2026-09-01 00:00:00');
  const now = parseOrderDate('2026-09-20 00:00:00');
  const active = {
    statusCode: '10', deadline: 24, deadlineMax: 24,
    isDelete: '0', isCanceled: '0',
  };
  assert.strictEqual(isOverdue(active, orderDate, now, []), true);

  const deletedStr = {
    statusCode: '10', deadline: 24, deadlineMax: 24,
    isDelete: '1', isCanceled: '0',
  };
  assert.strictEqual(isOverdue(deletedStr, orderDate, now, []), false);
});

test('computeReport считает просроченные позиции, сумму и разбивку по поставщикам', () => {
  const now = parseOrderDate('2026-09-20 00:00:00');
  const orders = [
    {
      number: '1001',
      date: '2026-09-01 00:00:00',
      positions: [
        {
          id: 1,
          distributorName: 'Поставщик А',
          brand: 'FEBI', number: '01089', description: 'Антифриз',
          quantity: 2, priceOut: 300, status: 'Заказан', statusCode: '10',
          deadline: 24, deadlineMax: 24, isDelete: false, isCanceled: 0,
        },
        {
          id: 2,
          distributorName: 'Поставщик А',
          brand: 'HEPU', number: 'P999', description: 'Масло',
          quantity: 1, priceOut: 500, status: 'Заказан', statusCode: '15',
          deadline: 24, deadlineMax: 24, isDelete: false, isCanceled: 0,
        },
        {
          id: 3,
          distributorName: 'Поставщик Б',
          brand: 'BMW', number: 'X1', description: 'Фильтр',
          quantity: 1, priceOut: 100, status: 'Заказан', statusCode: '10',
          deadline: 24, deadlineMax: 24, isDelete: false, isCanceled: 0,
        },
      ],
    },
  ];

  const report = computeReport(orders, { now, completedStatusCodes: ['15'] });

  assert.strictEqual(report.totalOverdue, 2);
  assert.strictEqual(report.totalSum, 700); // 600 + 100
  assert.strictEqual(report.rows.length, 2);
  assert.strictEqual(report.byDistributor.length, 2);

  const a = report.byDistributor.find((d) => d.name === 'Поставщик А');
  assert.strictEqual(a.overdue, 1);
  assert.strictEqual(a.sum, 600);
  const b = report.byDistributor.find((d) => d.name === 'Поставщик Б');
  assert.strictEqual(b.overdue, 1);
  assert.strictEqual(b.sum, 100);
});

test('computeReport выставляет дни просрочки для каждой строки', () => {
  const now = parseOrderDate('2026-09-20 00:00:00');
  const orders = [
    {
      number: '1001',
      date: '2026-09-01 00:00:00',
      positions: [
        {
          id: 1,
          distributorName: 'Поставщик А',
          brand: 'FEBI', number: '01089', description: 'Антифриз',
          quantity: 1, priceOut: 300, status: 'Заказан', statusCode: '10',
          deadline: 0, deadlineMax: 0, isDelete: false, isCanceled: 0,
        },
      ],
    },
  ];
  // плановая дата = дата заказа (срок 0) => прошло 19 дней
  const report = computeReport(orders, { now, completedStatusCodes: [] });
  assert.strictEqual(report.rows[0].daysLate, 19);
});

test('isRefusal определяет статусы-отказы по названию', () => {
  assert.strictEqual(isRefusal('Отказ'), true);
  assert.strictEqual(isRefusal('Отказ по браку'), true);
  assert.strictEqual(isRefusal('Выдан'), false);
  assert.strictEqual(isRefusal(null), false);
});

test('computeRejections считает % отказов по каждому поставщику', () => {
  const orders = [
    {
      number: '1001',
      date: '2026-09-01',
      positions: [
        { id: 1, distributorName: 'А', brand: 'B', number: '1', quantity: 1, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '0' },
        { id: 2, distributorName: 'А', brand: 'B', number: '2', quantity: 1, status: 'Выдан', statusCode: '92322', isDelete: '0', isCanceled: '0' },
        { id: 3, distributorName: 'А', brand: 'B', number: '3', quantity: 1, status: 'Отказ по браку', statusCode: '374308', isDelete: '0', isCanceled: '0' },
        { id: 4, distributorName: 'Б', brand: 'C', number: '4', quantity: 1, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '0' },
        { id: 5, distributorName: 'Б', brand: 'C', number: '5', quantity: 1, status: 'Заказан', statusCode: '92320', isDelete: '0', isCanceled: '0' },
      ],
    },
  ];
  const r = computeRejections(orders);
  assert.strictEqual(r.totalPositions, 5);
  assert.strictEqual(r.refusalPositions, 3);
  assert.strictEqual(r.rows.length, 3);
  // отказы: id1 (2 шт? нет, quantity=1, priceOut не задан) — без цен суммы 0
  assert.strictEqual(r.refusalSum, 0);

  const a = r.byDistributor.find((d) => d.name === 'А');
  assert.strictEqual(a.total, 3);
  assert.strictEqual(a.refusals, 2);
  assert.strictEqual(a.percent, 66.7); // 2/3 = 66.67 -> 66.7

  const b = r.byDistributor.find((d) => d.name === 'Б');
  assert.strictEqual(b.total, 2);
  assert.strictEqual(b.refusals, 1);
  assert.strictEqual(b.percent, 50);
});

test('computeRejections считает сумму отказов по цене × количеству', () => {
  const orders = [
    {
      number: '2001',
      date: '2026-09-01',
      positions: [
        { id: 1, distributorName: 'А', brand: 'B', number: '1', quantity: 2, priceOut: 500, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '0' },
        { id: 2, distributorName: 'А', brand: 'B', number: '2', quantity: 1, priceOut: 300, status: 'Выдан', statusCode: '92322', isDelete: '0', isCanceled: '0' },
      ],
    },
  ];
  const r = computeRejections(orders);
  assert.strictEqual(r.refusalSum, 1000); // 2 * 500
  const a = r.byDistributor.find((d) => d.name === 'А');
  assert.strictEqual(a.refusalSum, 1000);
  assert.strictEqual(r.rows[0].sum, 1000);
});

test('computeRejections с groupBy client группирует по покупателю', () => {
  const orders = [
    {
      number: '3001',
      date: '2026-09-01',
      userName: 'clientX',
      userFullName: 'Компания «Икс»',
      positions: [
        { id: 1, distributorName: 'А', brand: 'B', number: '1', quantity: 1, priceOut: 100, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '0' },
        { id: 2, distributorName: 'Б', brand: 'C', number: '2', quantity: 1, priceOut: 100, status: 'Выдан', statusCode: '92322', isDelete: '0', isCanceled: '0' },
      ],
    },
    {
      number: '3002',
      date: '2026-09-01',
      userFullName: 'Компания «Икс»',
      positions: [
        { id: 3, distributorName: 'А', brand: 'B', number: '3', quantity: 1, priceOut: 100, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '0' },
      ],
    },
  ];
  const r = computeRejections(orders, { groupBy: 'client' });
  assert.strictEqual(r.byDistributor.length, 1);
  const c = r.byDistributor[0];
  assert.strictEqual(c.name, 'Компания «Икс»');
  assert.strictEqual(c.total, 3);
  assert.strictEqual(c.refusals, 2);
  assert.strictEqual(c.percent, 66.7);
  assert.strictEqual(r.rows.length, 2);
  // В строках «Поставщик» должен быть реальный поставщик позиции, а не клиент.
  assert.strictEqual(r.rows[0].client, 'Компания «Икс»');
  assert.strictEqual(r.rows[0].distributor, 'А');
});

test('computeRejections исключает удалённые и отменённые позиции', () => {
  const orders = [
    {
      number: '1002',
      date: '2026-09-01',
      positions: [
        { id: 1, distributorName: 'А', brand: 'B', number: '1', quantity: 1, status: 'Отказ', statusCode: '92324', isDelete: '1', isCanceled: '0' },
        { id: 2, distributorName: 'А', brand: 'B', number: '2', quantity: 1, status: 'Отказ', statusCode: '92324', isDelete: '0', isCanceled: '1' },
        { id: 3, distributorName: 'А', brand: 'B', number: '3', quantity: 1, status: 'Заказан', statusCode: '92320', isDelete: '0', isCanceled: '0' },
      ],
    },
  ];
  const r = computeRejections(orders);
  assert.strictEqual(r.totalPositions, 1); // только не удалённая и не отменённая
  assert.strictEqual(r.refusalPositions, 0);
});
