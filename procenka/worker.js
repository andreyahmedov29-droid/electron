'use strict';
// Воркер потока для сравнения прайсов. Запускается из server.js через
// worker_threads, чтобы тяжёлая работа НЕ блокировала event loop главного
// процесса (иначе шлюз платформы отвечает BH_APP_STARTING).
//
// Чанки-файлы (JSON: массив строк, по 50 000 строк) читает САМ ВОРКЕР по пути,
// который присылает главный процесс. Это держит main event loop свободным на
// больших прайсах (раньше главный читал/парсил чанки и «затыкался»). Протокол:
//   сервер -> воркер  { type:'bChunk', chunkPath, startRow }  файл B -> карта
//   воркер -> сервер  { type:'bAck' }  чанк B обработан (flow-control: главный
//                        процесс шлёт следующий только по подтверждению — так в
//                        очереди воркера не накапливаются клоны всех чанков)
//   сервер -> воркер  { type:'bDone' }  файл B окончен
//   воркер -> сервер  { type:'bReady', size }  карта B построена
//   сервер -> воркер  { type:'aChunk', chunkPath, startRow }  файл A -> сравнение
//   воркер -> сервер  { type:'aAck' }  чанк A обработан
//   сервер -> воркер  { type:'aDone' }  сравнение окончено, финализируем результат
//   воркер -> сервер  { ok:true, countA, countB, matched, sampled:false } | { ok:false, error }
//
// Каждая строка — массив ячеек (разобран при нарезке в chunk-файл). startRow —
// АБСОЛЮТНЫЙ индекс первой строки чанка в исходном файле:
// вместе с headerRow воркер корректно пропускает шапку, даже если она лежит
// не в первом чанке.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { parentPort, workerData } = require('worker_threads');

// Чанк-файл (JSON: массив строк) читает САМ ВОРКЕР в своём потоке. Это разгружает
// главный процесс: раньше file.save(sync) + JSON.parse выполнялись в main event
// loop, и на десятках больших чанков он блокировался (status переставал отвечать,
// шлюз: «app not answering»). Теперь чтение/парсинг — в изолированном воркере.
function readChunkFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function parseNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).replace(/[\s\u00A0]/g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}
function normArt(s) {
  return String(s == null ? '' : s).replace(/[\s\u00A0]/g, '').toUpperCase();
}
function toRub(price, cur, rate) {
  if (cur === 'RUB') return price;
  const r = Number(rate);
  if (!isFinite(r) || r <= 0) return null;
  return price * r;
}

// Состояние воркера. map (артикул -> цена в рублях) файла B строится целиком.
// Файл A обрабатывается чанками по мере прихода; совпадения копятся в буфере
// и при заполнении порциями дописываются в промежуточный CSV на диске.
// Параллельно копим счётчики для листа «Итоги» (сколько дешевле у A/B, равны).
// ВАЖНО про память: карта на ~1 млн артикулов в Map давала пик RSS ~636 МБ и
// OOM на 512-контейнере; объект со строками снизил до ~593 МБ, но этого мало.
// Дальнейшее сжатие: храним карту как два параллельных ОТСОРТИРОВАННЫХ массива —
// keys (собственно артикулы, могут быть длинными строками) и vals (цены числом).
// Ключи-строки не помещаются в объект V8 с его хеш-накладными; бинарный поиск
// исключает массив-индекс. Большой выигрыш — компонуем без дублирования.
let mapKeys = [];   // отсортированные артикулы B
let mapVals = [];   // параллельные цены (числа)
let mapSize = 0;
let totalA = 0;
let buf = [];
let cheaperA = 0; // дешевле в файле A (первый прайс)
let cheaperB = 0; // дешевле в файле B (второй прайс)
let equal = 0;    // цены равны
let sumPct = 0;   // сумма «Разница (%)» по совпавшим позициям (для среднего)
let cntPct = 0;   // сколько позиций учтено в sumPct
// Устойчивая МЕДИАНА без хранения всех значений. Раньше pctVals держал массив из
// каждого совпадения (на 1,5 млн совпадений — 1,5 млн чисел + сортировка), что
// давило память именно на больших прайсах. Теперь ведём гистограмму с шагом 0.5
// п.п. в разумном диапазоне; медиана вычисляется из кумулятивных счётчиков.
// Хранить нужно фиксированное число корзин независимо от объёма.
const PCT_MIN = -100, PCT_MAX = 100, PCT_STEP = 0.5;
const PCT_BUCKETS = Math.round((PCT_MAX - PCT_MIN) / PCT_STEP) + 1;
const pctBins = new Array(PCT_BUCKETS).fill(0);
let pctCount = 0; // сколько значений учтено в гистограмме
// Гистограмма разницы «наш прайс против конкурента» (по шагам в 1 п.п.).
// oursMore[k] — конкурент дешевле нас на (k; k+1]%; oursLess[k] — мы дешевле.
const MAXH = 50;  // открытый хвост — всё, что больше 50%
const oursMore = new Array(MAXH + 1).fill(0);
const oursLess = new Array(MAXH + 1).fill(0);
// Пороговая скидка до паритета: на сколько % нужно опустить нашу цену, чтобы
// на позиции стать НЕ дороже конкурента (в терминах нашей цены, /ours*100).
// discBins[d] — позиций, где нужная скидка попала в диапазон [d; d+1)%.
const MAXD = 100; // открытый хвост — всё, что больше 100%
const discBins = new Array(MAXD + 1).fill(0);
let discNeg = 0;   // позиции, где мы УЖЕ дешевле конкурента (нужная скидка < 0)
let discTotal = 0; // всего позиций с ценами обоих прайсов
let discPct = null;
let tmpCsv = null;
let outPath = null;
let aName = '';
let bName = '';
let chunkSize = 10000;

function flush() {
  if (!buf.length) return;
  const text = buf.join('') + '\n';
  buf = [];
  fs.appendFileSync(tmpCsv, text, 'utf8');
}

// Бинарный поиск артикула в отсортированном mapKeys. Возвращает цену или undefined.
// Экономная по памяти: никакого промежуточного объекта, работаем с массивами.
function mapLookup(art) {
  let lo = 0, hi = mapKeys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = mapKeys[mid];
    if (k === art) return mapVals[mid];
    if (k < art) lo = mid + 1; else hi = mid - 1;
  }
  return undefined;
}

function compareRow(row, absRow) {
  if (absRow < workerData.headerRowA) return;
  const art = normArt(row[workerData.artIdxA]);
  const price = parseNum(row[workerData.priceIdxA]);
  if (!art || price === null) return;
  totalA++;
  const rub = toRub(price, workerData.curA, workerData.rateA);
  if (rub === null) return;
  const j = mapLookup(art);
  if (j === undefined) return;
  const diff = rub - j;
  const pct = j ? (diff / j) * 100 : null;
  let who;
  if (diff < -0.005) { who = 'дешевле ' + aName; cheaperA++; }
  else if (diff > 0.005) { who = 'дешевле ' + bName; cheaperB++; }
  else { who = 'цены равны'; equal++; }
  if (pct != null && isFinite(pct)) {
    sumPct += pct; cntPct++;
    let bi = Math.round((pct - PCT_MIN) / PCT_STEP);
    if (bi < 0) bi = 0; else if (bi >= PCT_BUCKETS) bi = PCT_BUCKETS - 1;
    pctBins[bi]++;
    pctCount++;
  }
  if (j > 0) {
    // «Наш» прайс — первый, если oursIsA, иначе второй. pctOur>0 — наш дороже
    // конкурента (конкурент дешевле нас), pctOur<0 — мы дешевле конкурента.
    const oursPrice = workerData.oursIsA ? rub : j;
    const rivalPrice = workerData.oursIsA ? j : rub;
    if (rivalPrice > 0 && oursPrice != null) {
      const pctOur = (oursPrice - rivalPrice) / rivalPrice * 100;
      if (isFinite(pctOur) && Math.abs(pctOur) >= 0.005) {
        let k = Math.ceil(Math.abs(pctOur)) - 1;
        if (k < 0) k = 0;
        if (k > MAXH) k = MAXH;
        if (pctOur > 0) oursMore[k]++; else oursLess[k]++;
      }
      if (oursPrice > 0) {
        const dOurs = (oursPrice - rivalPrice) / oursPrice * 100;
        if (isFinite(dOurs)) {
          discTotal++;
          if (dOurs < 0) { discNeg++; }
          else { const bi = Math.min(Math.floor(dOurs), MAXD); discBins[bi]++; }
        }
      }
    }
  }
  // экранируем и артикул, и поле «Кто дешевле» (в него включено имя владельца)
  // на случай кавычек/разделителя в названии поставщика
  const safeArt = String(art).replace(/"/g, '""');
  const safeWho = String(who).replace(/"/g, '""');
  buf.push('"' + safeArt + '";' + Math.round(rub * 100) / 100 + ';' + Math.round(j * 100) / 100 + ';' +
    Math.round(diff * 100) / 100 + ';' + (pct != null ? Math.round(pct * 100) / 100 : '') + ';"' + safeWho + '"\n');
  if (buf.length >= chunkSize) flush();
}

// Финальный результат — CSV (открывается в Excel): строка-заголовок сверху,
// тело — из промежуточного CSV. Итог кладётся в outPath (RESULT_DIR, /data).
function finalizeCsv() {
const header = 'Артикул;' + aName + ' (RUB);' + bName + ' (RUB);Разница (RUB);Разница (%);Кто дешевле\n';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const body = fs.existsSync(tmpCsv) ? fs.readFileSync(tmpCsv, 'utf8') : '';
  // BOM (\ufeff) в начале — иначе Excel открывает кириллицу в названиях
  // прайсов («Проф», «Петухи») как «Проб», «Петуш».
  fs.writeFileSync(outPath, '\ufeff' + header + body, 'utf8');
  if (fs.existsSync(tmpCsv)) { try { fs.unlinkSync(tmpCsv); } catch (_) {} }
  return body ? body.split(/\r?\n/).filter((l) => l.trim() !== '').length : 0;
}

parentPort.on('message', (m) => {
  try {
    if (!m || typeof m !== 'object') return;
    if (m.type === 'bChunk') {
      // Чанк читает САМ воркер (по пути), а не главный процесс: это убирает
      // JSON.parse и postMessage-копию из главного event loop, из-за которых на
      // больших файлах главный процесс «затыкался» и status переставал отвечать
      // («app not answering» после ~22 с). Воркер в своём потоке читает файл.
  const arr = m.chunkPath ? readChunkFile(m.chunkPath) : (Array.isArray(m.rows) ? m.rows : []);
  const start = Number.isInteger(m.startRow) ? m.startRow : 0;
  // Временно копим артикулы B в плоских массивах (ключ + цена), чтобы накопить
  // все пары, потом один раз отсортировать. На 1 млн — это десятки МБ, а не
  // сотни как у объекта V8.
  for (let i = 0; i < arr.length; i++) {
    const row = arr[i];
    if (start + i < workerData.headerRowB) continue;
    const art = normArt(row[workerData.artIdxB]);
    const price = parseNum(row[workerData.priceIdxB]);
    if (art && price !== null) {
      const rub = toRub(price, workerData.curB, workerData.rateB);
      if (rub !== null) { mapKeys.push(art); mapVals.push(rub); }
    }
  }
  parentPort.postMessage({ type: 'bAck' });
    } else if (m.type === 'bDone') {
      // Сортируем пары (ключ, цена) по артикулу и убираем дубликаты (оставляем
      // первое вхождение — как было с !map.has). После этого mapLookup работает
      // бинарным поиском по отсортированным массивам.
      const n = mapKeys.length;
      const order = new Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      order.sort((a, b) => {
        const ka = mapKeys[a], kb = mapKeys[b];
        return ka < kb ? -1 : (ka > kb ? 1 : 0);
      });
      const sKeys = new Array(n), sVals = new Array(n);
      for (let i = 0; i < n; i++) { sKeys[i] = mapKeys[order[i]]; sVals[i] = mapVals[order[i]]; }
      mapKeys = sKeys; mapVals = sVals;
      // дедуп
      let w = 0;
      for (let i = 0; i < n; i++) {
        if (w > 0 && mapKeys[i] === mapKeys[w - 1]) continue;
        mapKeys[w] = mapKeys[i]; mapVals[w] = mapVals[i]; w++;
      }
      mapKeys.length = w; mapVals.length = w;
      mapSize = w;
      parentPort.postMessage({ type: 'bReady', size: mapSize });
    } else if (m.type === 'aChunk') {
      if (!tmpCsv) {
        outPath = workerData.outPath;
        aName = workerData.nameA;
        bName = workerData.nameB;
        chunkSize = (workerData.chunkSize && workerData.chunkSize > 0) ? workerData.chunkSize : 100000;
        tmpCsv = path.join(os.tmpdir(), 'pc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '.csv');
      }
      const arr = m.chunkPath ? readChunkFile(m.chunkPath) : (Array.isArray(m.rows) ? m.rows : []);
      const start = Number.isInteger(m.startRow) ? m.startRow : 0;
      for (let i = 0; i < arr.length; i++) compareRow(arr[i], start + i);
      parentPort.postMessage({ type: 'aAck' });
    } else if (m.type === 'aDone') {
      flush();
      const matched = finalizeCsv();
      const avgPct = cntPct ? sumPct / cntPct : null;
      let medianPct = null;
      if (pctCount > 0) {
        // Медиана из гистограммы: находим корзину, где накопленная доля проходит
        // половину, и возвращаем её центр. Приближённо (шаг 0.5 п.п.), но
        // устойчиво и без хранения/сортировки миллиона значений.
        const half = pctCount / 2;
        let cum = 0;
        outer: for (let bi = 0; bi < PCT_BUCKETS; bi++) {
          cum += pctBins[bi];
          if (cum >= half) {
            const value = PCT_MIN + bi * PCT_STEP + PCT_STEP / 2;
            medianPct = Math.round(value * 100) / 100;
            break outer;
          }
        }
      }
      discPct = null;
      if (discTotal > 0) {
        // Точный перцентиль сдвига «нужная скидка» для диапазона 10..100% с шагом
        // 10. Линейная интерполяция внутри 1%-бакета: соседние пороги больше не
        // сливаются в одно целое число (как было с floor-округлением).
        discPct = {};
        const targets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
        for (const target of targets) {
          if (discNeg / discTotal >= target / 100) { discPct['p' + target] = 0; continue; }
          let cum = discNeg;
          let val = null;
          for (let d = 0; d <= MAXD; d++) {
            const cnt = discBins[d] || 0;
            if (cnt <= 0) continue;
            const next = cum + cnt;
            if (next / discTotal >= target / 100) {
              const need = (target / 100) * discTotal;
              let frac = (need - cum) / cnt;
              if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
              val = d + frac;
              break;
            }
            cum = next;
          }
          discPct['p' + target] = val == null ? null : Math.round(val * 10) / 10;
        }
      }
      parentPort.postMessage({
        ok: true, countA: totalA, countB: mapSize, matched,
        cheaperA, cheaperB, equal, curA: workerData.curA, curB: workerData.curB,
        rateA: workerData.rateA, rateB: workerData.rateB, aName, bName,
        avgPct, medianPct, oursMore, oursLess, discPct, discNeg, discTotal, sampled: false
      });
    }
  } catch (e) {
    parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
  }
});
