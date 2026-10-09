const { test } = require('node:test');
const assert = require('node:assert');

const { determineStatusDetail } = require('../lib/matcher');
const { freshBody } = require('../lib/sync');

function rules(list) {
  return list.map(([keywords, status]) => ({ keywords: [keywords], status }));
}

test('точное совпадение слова с границами', () => {
  const r = determineStatusDetail('письмо отказ', rules([['отказ', 'Отказ']]));
  assert.equal(r.status, 'Отказ');
  assert.equal(r.matched, 'отказ');
});

test('короткий ключ не матчится внутри слова', () => {
  const r = determineStatusDetail('документ и окна', rules([['ок', 'ОК']]));
  assert.equal(r.status, null);
});

test('словоформа через падеж', () => {
  const r = determineStatusDetail('просим отправить отказы', rules([['отказ', 'Отказ']]));
  assert.equal(r.status, 'Отказ');
});

test('словоформа через глагол', () => {
  const r = determineStatusDetail('клиент отказался от заказа', rules([['отказ', 'Отказ']]));
  assert.equal(r.status, 'Отказ');
});

test('фраза из нескольких слов', () => {
  const r = determineStatusDetail('товар ещё до клиента не доехал', rules([['до клиента', 'В пути']]));
  assert.equal(r.status, 'В пути');
});

test('опечатка в одну букву', () => {
  const r = determineStatusDetail('готова к отгрузке?', rules([['отгрузка', 'Отгружен']]));
  assert.equal(r.status, 'Отгружен');
});

test('две опечатки в коротком слове не матчатся', () => {
  const r = determineStatusDetail('отгзка товара', rules([['отгрузка', 'Отгружен']]));
  assert.equal(r.status, 'Отгружен');
});

test('возвращается статус первого сработавшего правила', () => {
  const r = determineStatusDetail('всё хорошо отказ', rules([
    ['хорошо', 'Хорошо'],
    ['отказ', 'Отказ']
  ]));
  assert.equal(r.status, 'Хорошо');
});

test('латиница не матчится как кириллица и наоборот', () => {
  const r = determineStatusDetail('status ok', rules([['ок', 'ОК']]));
  assert.equal(r.status, null);
});

test('регистр не важен', () => {
  const r = determineStatusDetail('ПИСЬМО ОТКАЗ', rules([['отказ', 'Отказ']]));
  assert.equal(r.status, 'Отказ');
});

test('freshBody: отбрасывает цитату после разделителя', () => {
  const body = 'Новый текст ответа\n----------\nЦитата со словом отказ';
  const fresh = freshBody(body);
  assert.ok(!fresh.includes('отказ'));
  assert.ok(fresh.includes('Новый текст'));
});

test('freshBody: без разделителя возвращает весь текст', () => {
  const body = 'просто письмо без цитаты';
  assert.equal(freshBody(body), body);
});

test('freshBody: фраза только в цитате не даёт статус', () => {
  const body = 'Согласование артикула\nНачало переписки\nпросим статус до клиента минск';
  const rulesArr = rules([['до клиента минск', 'До клиента Минск']]);
  // статус должен определяться только по свежей части
  const fresh = freshBody(body);
  assert.ok(!fresh.includes('минск'));
  assert.equal(determineStatusDetail(fresh, rulesArr).status, null);
});

test('«согласование» (процесс) не даёт статус «Одобрен поставщиком»', () => {
  const r = determineStatusDetail('отправили на согласование', rules([['согласован', 'Одобрен поставщиком']]));
  assert.equal(r.status, null);
});

test('«на согласовании» (процесс) не даёт статус одобрения', () => {
  const r = determineStatusDetail('заявка на согласовании', rules([['согласован', 'Одобрен поставщиком']]));
  assert.equal(r.status, null);
});

test('«согласовано» (результат) даёт статус «Одобрен поставщиком»', () => {
  const r = determineStatusDetail('Ваша заявка согласована', rules([['согласован', 'Одобрен поставщиком']]));
  assert.equal(r.status, 'Одобрен поставщиком');
});

test('«одобрен» (результат) даёт статус', () => {
  const r = determineStatusDetail('заявка одобрена поставщиком', rules([['одобрен', 'Одобрен поставщиком']]));
  assert.equal(r.status, 'Одобрен поставщиком');
});
