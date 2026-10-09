(function () {
  'use strict';

  // Встроенный в BIOTIME режим: страница живёт на /procenka/, API-пути
  // дополняем префиксом. При самостоятельном деплое префикс пуст.
  const API_PREFIX = (function () {
    try {
      const src = document.currentScript && document.currentScript.src;
      const p = src ? new URL(src).pathname : '';
      return p.startsWith('/procenka/') ? '/procenka' : '';
    } catch (_e) { return ''; }
  })();
  const apiPath = (s) => (API_PREFIX || '') + s;

  const $ = (id) => document.getElementById(id);
  // Маркер версии — виден в правом углу. Если вы видите не этот номер,
  // значит браузер держит старый app.js (обновление: Ctrl+F5).
  (() => {
    const vb = document.getElementById('versionBadge');
    if (vb) vb.textContent = 'v8 · сервер…';
    // Запрашиваем версию сервера, чтобы видеть, согласованы ли фронт и бэк.
    if (vb) fetch(apiPath('/api/health')).then((r) => r.json()).then((h) => {
      if (vb) vb.textContent = 'v8 · srv ' + (h && h.serverVersion ? h.serverVersion : '?');
    }).catch(() => { if (vb) vb.textContent = 'v8 · srv ?'; });
  })();
  const state = {
    A: { fileId: null, cols: [], artIdx: null, priceIdx: null, headerRow: 0 },
    B: { fileId: null, cols: [], artIdx: null, priceIdx: null, headerRow: 0 }
  };
  let lastResult = null;

  // Размер одного HTTP-чанка загрузки. 512 КБ: заметно ниже лимита тела
  // запроса шлюза платформы (Black Hole), который на практике обрывает
  // крупные POST; мелкие чанки проходят надёжнее и ретраятся быстрее.
  const CHUNK = 512 * 1024;

  // Достаёт читаемый текст ошибки из любого значения. Ключевой момент: сервер
  // может вернуть в поле "error" ОБЪЕКТ (напр. {message: '...'}), и простой
  // new Error(obj) дал бы строку "[object Object]". Поэтому ДО построения
  // сообщения всегда прогоняем значение через errText.
  function errText(v, fallback) {
    if (v == null || v === '') return fallback || '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object') {
      if (typeof v.message === 'string' && v.message) return v.message;
      if (typeof v.error === 'string' && v.error) return v.error;
      if (v.error && typeof v.error === 'object') return errText(v.error, fallback);
      if (typeof v.detail === 'string' && v.detail) return v.detail;
      // никаких читаемых полей — честный JSON, но НЕ "[object Object]"
      try { return JSON.stringify(v); } catch (_) { return fallback || 'ошибка сервера'; }
    }
    return String(v) || fallback || '';
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setProgress(percent) {
    const bar = $('uploadBar');
    const label = $('uploadLabel');
    if (bar) { bar.style.width = percent + '%'; }
    if (label) { label.textContent = Math.round(percent) + '%'; }
  }

  // Удаляет файлы с сервера по списку id. Нужно, чтобы после каждой сверки
  // крупные прайсы и результаты не засоряли память/диск сервера.
  function cleanupServer(ids) {
    if (!ids || !ids.length) return;
  fetch(apiPath('/api/cleanup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: ids })
    }).catch(() => {});
  }

  // Ответ шлюза платформы (Black Hole) вида {"code":"BH_...","retryAfter":N} —
  // приложение ещё разворачивается/перезапускается. Возвращает задержку или null.
  function gatewayRetryMs(j) {
    if (j && typeof j === 'object' && typeof j.code === 'string' && /^BH_/.test(j.code)) {
      const n = Number(j.retryAfter);
      return (Number.isFinite(n) && n > 0) ? n * 1000 : 1500;
    }
    return null;
  }

  // fetch с таймаутом: висящий запрос (шлюз молчит/оборвал) должен
  // прерываться и давать возможность повторить, а не висеть вечно.
  async function fetchTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 30000);
    try {
      const u2 = (String(url).charAt(0) === '/' && !String(url).startsWith('//')) ? apiPath(url) : url;
      return await fetch(u2, Object.assign({}, opts, { signal: ctl.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // Опрос фоновой нарезки файла (см. /api/upload/done). Сервер отвечает сразу,
  // а нарезает в фоне; ждём, пока status не станет ready. Возвращает
  // {size, rows} или null при ошибке/таймауте.
  // Таймаут должен быть ЗАМЕТНО БОЛЬШЕ серверного watchdog нарезки (см.
  // runChunking в server.js), иначе фронт "сдастся" на 100% раньше, чем сервер
  // успеет закончить большой xlsx или выдать ошибку. 1200 итераций x 500 мс =
  // 10 минут ожидания — с запасом поверх watchdog в 5 минут.
  async function waitChunkReady(fileId, maxTries, onProgress) {
    const tries = maxTries || 1200;
    // опрашиваем чаще в начале (нарезка обычно идёт секунды), чтобы не тянуть
    const delay = 500;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        const sr = await fetch(apiPath('/api/upload/status?fileId=' + encodeURIComponent(fileId)));
        // 404 на /api/upload/status = старый сервер БЕЗ фоновой нарезки.
        // Висеть в «Обрабатываю…» бессмысленно — сообщаем о несоответствии версий.
        if (sr.status === 404) {
          throw new Error('Сервер не поддерживает фоновую обработку — нужна новая версия приложения (обновите деплой).');
        }
        const sj = await sr.json();
        if (sr.ok && sj && sj.ok && sj.status === 'ready') {
          return { size: sj.size || 0, rows: sj.rows || 0 };
        }
        if (sr.ok && sj && sj.ok && sj.status === 'error') {
          throw new Error(errText(sj.error, 'не удалось разобрать файл'));
        }
        // сервер ещё нарезает — показываем прогресс («Обрабатываю… N строк»),
        // чтобы пользователь видел живое движение, а не "зависло на 100%"
        if (onProgress && sj && sj.status === 'chunking') onProgress(sj.progress || 0);
        const wait = gatewayRetryMs(sj);
        if (wait != null) await new Promise((r) => setTimeout(r, wait));
      } catch (e) {
        // 404 (старый сервер) или сетевой обрыв — не висим до конца, а выходим
        if (e && e.message && e.message.indexOf('Сервер не поддерживает') === 0) throw e;
        // сетевой обрыв опроса — пробуем снова; только последняя итерация решает
        if (i === tries - 1) throw e;
      }
    }
    throw new Error('нарезка файла заняла слишком долго');
  }

  // Отправка одного чанка (начиная с offset) с прогрессом и ретраями.
  // Возвращает новую позицию offset (по ответу сервера, с учётом дублей).
  async function sendOneChunk(file, fileId, offset, fileSize, chunkIdx, totalChunks, fileName) {
    const blob = file.slice(offset, offset + CHUNK);
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * attempt));
      try {
        const r = await fetchTimeout('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-File-Id': fileId, 'X-Offset': String(offset) },
          body: blob
        }, 45000);
        let j = null; try { j = await r.json(); } catch (_) { j = null; }
        if (r.ok && j && j.ok) {
          return typeof j.total === 'number' ? j.total : offset + blob.size;
        }
        if (r.status === 409 && j && typeof j.have === 'number') {
          // сервер уже имеет данные до have — начинаем с этой позиции
          return { at: j.have };
        }
        // не_-200 — читаем тело ошибки для понятного сообщения
        if (r.status !== 200) {
          const msg = errText(j && j.error, 'ошибка сервера (' + r.status + ')');
          if (r.status === 413 || r.status === 500) throw new Error(msg);
        }
      } catch (e) {
        if (attempt === 5) throw e;
      }
      setStatus('Загружаю «' + fileName + '»… часть ' + chunkIdx + ' из ' + totalChunks, 'spin', true);
    }
    throw new Error('не удалось загрузить файл: сеть недоступна или сервер не отвечает');
  }

  // Загрузка файла чанками на сервер с прогрессом. Чистый async/await:
  // file.slice() отдаёт Blob, который можно отправить в fetch напрямую.
  async function uploadChunks(side, file) {
    const fileId = side.toLowerCase() + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    state[side].fileId = fileId;
    const total = file.size;
    const totalChunks = Math.ceil(total / CHUNK) || 1;
    let offset = 0;
    let chunkIdx = 0;

    while (offset < total) {
      chunkIdx++;
      const res = await sendOneChunk(file, fileId, offset, total, chunkIdx, totalChunks, file.name);
      offset = (res && typeof res === 'object') ? res.at : res;
      setProgress(total ? (offset / total) * 100 : 100);
    }

    // /api/upload/done ОТВЕЧАЕТ СРАЗУ и начинает фоновую нарезку файла в память
    // (разбор большого xlsx может идти секунды; синхронный ответ шлюз оборвал бы —
    // отсюда «застряло на 100%, файл не выбран»). После done ждём ready через
    // /api/upload/status. Если сервер отвечает 409 «файл неполный» с have —
    // ДОГРУЖАЕМ недостающее с позиции have, а не висим.
    let doneOk = false;
    let size = 0;
    for (let attempt = 0; attempt < 12 && !doneOk; attempt++) {
      // Отмечаем «жёсткую» ошибку (сам сервер сказал error, или нарезка не
      // уложилась в watchdog). Такие ошибки НЕ лечатся повторным /done — их
      // показываем сразу и прекращаем ретраи, иначе пользователь видел бы
      // бесконечное «Обрабатываю…», а причина (файл слишком большой, разбор
      // не удался) оставалась скрытой.
      let terminal = false;
      try {
        setStatus('Обрабатываю «' + file.name + '»…', 'spin', true);
        const d = await fetchTimeout('/api/upload/done', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId, total })
        }, 45000);
        const dj = await d.json();
        if (d.ok && dj && dj.ok) {
          if (dj.status === 'ready') { size = dj.size || 0; doneOk = true; break; }
          let lastProgShown = 0;
          let st = null;
          try {
            const t0 = Date.now();
            st = await waitChunkReady(fileId, 0, (n) => {
              // Показываем прогресс с ПЕРВОГО тика (включая 0), чтобы сразу было
              // видно «Обрабатываю… 0 строк» — сервер стартовал нарезку, а не
              // застыл. Обновляемся только когда число выросло (без спама).
              if (n >= 0 && n > lastProgShown) {
                lastProgShown = n;
                const secs = Math.round((Date.now() - t0) / 1000);
                setStatus('Обрабатываю «' + file.name + '»… ' + n.toLocaleString('ru-RU') + ' строк · прошло ' + secs + ' с', 'spin', true);
              }
            });
          } catch (e2) {
            // нарезка ответила error или истёк её watchdog/таймаут — терминально
            terminal = true;
            throw new Error(errText(e2 && e2.message, 'не удалось обработать файл на сервере'));
          }
          if (st) { size = st.size || 0; doneOk = true; break; }
        }
        // 409 = файл неполный: сервер сообщает, сколько байт реально имеет.
        if (d.status === 409 && dj && typeof dj.have === 'number') {
          if (dj.have < total) {
            // ВАЖНО: догружаем начиная с РЕАЛЬНОГО have на сервере, а не с
            // локального offset. Клиент мог «убежать» вперёд, а сервер потерять
            // середину — тогда догрузка с offset дыру не закроет.
            let from = dj.have;
            setStatus('Догружаю файл на сервер: ' + Math.round((from / total) * 100) + '%…', 'spin', true);
            let guard = 0;
            while (from < total && guard < 10000) {
              const res = await sendOneChunk(file, fileId, from, total, guard + 1, 999, file.name);
              from = (res && typeof res === 'object') ? res.at : res;
              guard++;
            }
            setProgress(total ? (from / total) * 100 : 100);
            continue; // повторяем /done
          }
        }
        const wait = gatewayRetryMs(dj);
        if (wait != null) { await new Promise((r) => setTimeout(r, wait)); continue; }
        // /done ответил не-ок, не-409 и не-шлюз — это ответ приложения, терминальный
        terminal = true;
        throw new Error(errText(dj && dj.error, 'ошибка завершения'));
      } catch (e) {
        // жёсткую ошибку нарезки показываем сразу, а не крутим ретраи вслепую
        if (terminal) {
          const msg = errText(e && e.message, 'не удалось обработать файл');
          setStatus(msg, 'error');
          const fatal = new Error(msg);
          fatal.deterministic = true;
          throw fatal;
        }
        if (attempt === 11) throw e;
      }
    }
    if (!doneOk) throw new Error('ошибка завершения загрузки');
    return { fileId, size };
  }

  async function loadFile(side, file) {
    const drop = $(side === 'A' ? 'dropA' : 'dropB');
    const sub = drop.querySelector('.dz-sub');
    const main = drop.querySelector('.dz-main');
    const cfg = $(side === 'A' ? 'cfgA' : 'cfgB');
    // перед загрузкой нового файла удаляем старый загруженный файл этой стороны
    if (state[side].fileId) cleanupServer([state[side].fileId]);
    setStatus('Загружаю «' + file.name + '»…', 'spin', true);
    $('uploadPanel').hidden = false;
    setProgress(0);

    // Автоповтор всей загрузки: шлюз/перезапуск приложения могут оборвать
    // процесс, поэтому пробуем несколько раз с полной очисткой на сервере.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) setStatus('Повторяю загрузку «' + file.name + '»… попытка ' + (attempt + 1), 'spin', true);
        const { fileId } = await uploadChunks(side, file);
        // опрашиваем колонки (с повтором: шлюз может оборвать первый запрос)
        let cj = null;
        for (let i = 0; i < 5 && !cj; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 700 * i));
          try {
      const cr = await fetch(apiPath('/api/columns?fileId=' + encodeURIComponent(fileId)));
            const j = await cr.json();
            if (cr.ok && j && j.ok) { cj = j; break; }
            const wait = gatewayRetryMs(j);
            if (wait != null) { await new Promise((r) => setTimeout(r, wait)); continue; }
            throw new Error(errText(j && j.error, 'не удалось прочитать колонки'));
          } catch (e) {
            if (i === 4) throw e;
          }
        }
        if (!cj) throw new Error('не удалось прочитать колонки');

        state[side].cols = cj.cols;
        state[side].artIdx = cj.artIdx;
        state[side].priceIdx = cj.priceIdx;
        state[side].headerRow = cj.headerRow || 0;

        drop.classList.add('loaded');
        drop.querySelector('.dz-icon').textContent = '✓';
        main.textContent = file.name;
        sub.textContent = cj.cols.length + ' колонок · ' + (file.name.split('.').pop() || 'xlsx').toUpperCase();

        cfg.hidden = false;
        fillColumnSelects(side, cj);
        updateCurrRate(side);
        maybeEnable();
        $('uploadPanel').hidden = true;
        setStatus('', '', true);
        return;
      } catch (e) {
        lastErr = e;
        // чистим незавершённую загрузку этой стороны и пробуем ещё раз
        if (state[side].fileId) { try { cleanupServer([state[side].fileId]); } catch (_) {} }
        state[side].fileId = null;
        // жёсткая ошибка сервера (файл слишком большой, разбор не удался и т.п.)
        // повторной загрузкой не лечится — прекращаем ретраи, показываем причину
        if (e && e.deterministic) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
      }
    }
    setStatus((lastErr && lastErr.message) || 'Ошибка загрузки файла', 'error');
    $('uploadPanel').hidden = true;
  }

  function fillColumnSelects(side, gi) {
    const artSel = $(side === 'A' ? 'artA' : 'artB');
    const priceSel = $(side === 'A' ? 'priceA' : 'priceB');
    artSel.innerHTML = ''; priceSel.innerHTML = '';
    gi.cols.forEach((c) => {
      const o1 = document.createElement('option'); o1.value = c.index; o1.textContent = c.header;
      const o2 = document.createElement('option'); o2.value = c.index; o2.textContent = c.header;
      artSel.appendChild(o1); priceSel.appendChild(o2);
    });
    artSel.value = gi.artIdx; priceSel.value = gi.priceIdx;
    state[side].artIdx = parseInt(artSel.value, 10);
    state[side].priceIdx = parseInt(priceSel.value, 10);
    artSel.onchange = () => { state[side].artIdx = parseInt(artSel.value, 10); maybeEnable(); };
    priceSel.onchange = () => { state[side].priceIdx = parseInt(priceSel.value, 10); maybeEnable(); };
  }

  function bindCurrency(side) {
    $(side === 'A' ? 'curA' : 'curB').addEventListener('change', () => updateCurrRate(side));
  }
  function updateCurrRate(side) {
    const rateRow = $(side === 'A' ? 'rateRowA' : 'rateRowB');
    const curSel = $(side === 'A' ? 'curA' : 'curB');
    const rate = $(side === 'A' ? 'rateA' : 'rateB');
    rateRow.hidden = curSel.value === 'RUB';
    if (curSel.value !== 'RUB' && !rate.value) {
      const def = { EUR: 97.3, USD: 90.0, BYN: 30.0 }[curSel.value];
      if (def) rate.placeholder = 'напр. ' + def;
    }
    maybeEnable();
  }

  function maybeEnable() {
    const btn = $('compareBtn');
    const aOK = state.A.fileId && state.A.artIdx != null && state.A.priceIdx != null;
    const bOK = state.B.fileId && state.B.artIdx != null && state.B.priceIdx != null;
    btn.disabled = !(aOK && bOK);
  }

  function setStatus(msg, cls, clear) {
    const s = $('status');
    s.className = 'status' + (cls ? ' ' + cls : '');
    let text;
    if (msg == null) text = '';
    else if (typeof msg === 'string') text = msg;
    else {
      // Никогда не показываем пользователю "[object Object]": из объекта
      // достаём читаемый текст (error.message, error.error, message...).
      const pick = (o) => {
        if (o == null) return '';
        if (typeof o === 'string') return o;
        if (typeof o === 'object') {
          if (o.message && typeof o.message === 'string') return o.message;
          if (o.error) return pick(o.error);
          if (o.detail && typeof o.detail === 'string') return o.detail;
        }
        return '';
      };
      text = pick(msg) || JSON.stringify(msg);
    }
    s.textContent = text;
    if (clear) setTimeout(() => { if (!s.textContent) s.className = 'status'; }, 4000);
  }

  function initDrop(side) {
    const drop = $(side === 'A' ? 'dropA' : 'dropB');
    const input = $(side === 'A' ? 'inputA' : 'inputB');
    drop.addEventListener('click', (e) => { if (!drop.classList.contains('loading')) input.click(); });
    input.addEventListener('change', () => { if (input.files[0]) loadFile(side, input.files[0]); });
    ['dragover', 'dragenter'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(side, f); });
  }

  async function compare() {
    const nameA = $('nameA').value.trim();
    const nameB = $('nameB').value.trim();
    // «Чей это прайс» — осмысленное имя владельца, которое пойдёт в выгрузку
    // вместо «Прайс 1/2». Если поле не заполнено — предупреждаем, чтобы
    // пользователь указал владельца (иначе в анализе будет безликое «Прайс 1»).
    if (!nameA || !nameB) {
      const missing = [];
      if (!nameA) missing.push('прайс № 1');
      if (!nameB) missing.push('прайс № 2');
      setStatus('Укажите, чей это прайс (' + missing.join(', ') + ') — оно попадёт в анализ вместо «Прайс 1/2»', 'error');
      return;
    }
    const curA = $('curA').value, curB = $('curB').value;
    const rateA = $('rateA').value, rateB = $('rateB').value;
    if (curA !== 'RUB' && (!rateA || Number(rateA) <= 0)) { setStatus('Укажите курс для валюты №1', 'error'); return; }
    if (curB !== 'RUB' && (!rateB || Number(rateB) <= 0)) { setStatus('Укажите курс для валюты №2', 'error'); return; }

    setStatus('Сравниваю…', 'spin');
    try {
      const body = JSON.stringify({
        fileIdA: state.A.fileId, fileIdB: state.B.fileId,
        nameA, nameB, curA, curB,
        rateA: rateA ? Number(rateA) : 1, rateB: rateB ? Number(rateB) : 1,
        artIdxA: state.A.artIdx, priceIdxA: state.A.priceIdx, headerRowA: state.A.headerRow,
        artIdxB: state.B.artIdx, priceIdxB: state.B.priceIdx, headerRowB: state.B.headerRow
      });
      // 1) создать задачу — сервер отвечает сразу (taskId), без долгого открытого запроса
      let r, j;
      for (let attempt = 0; attempt < 6; attempt++) {
      r = await fetch(apiPath('/api/compare'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        try { j = await r.json(); } catch (_) { j = null; }
        const wait = gatewayRetryMs(j);
        if (wait == null) break; // обычный ответ приложения
        // приложение ещё поднимается (BH_*): ждём и пробуем снова
        setStatus('Приложение ещё запускается, повторяю…', 'spin');
        await new Promise((s) => setTimeout(s, wait));
      }
      if (!r.ok || !j || !j.ok || !j.taskId) { setStatus(errText(j && j.error, 'Ошибка сравнения (код ' + (r && r.status) + ')'), 'error'); return; }
      // 2) опрашиваем статус задачи, пока не завершится
      let jj = null;
      for (let poll = 0; poll < 6000; poll++) {
        await new Promise((s) => setTimeout(s, 500));
      const sr = await fetch(apiPath('/api/compare/status?taskId=' + encodeURIComponent(j.taskId)));
        try { jj = await sr.json(); } catch (_) { jj = null; }
        if (!sr.ok || !jj || !jj.ok) { setStatus(errText(jj && jj.error, 'Ошибка проверки статуса'), 'error'); return; }
        if (jj.status === 'done') break;
        if (jj.status === 'error') { setStatus(errText(jj && jj.error, 'Ошибка сравнения'), 'error'); return; }
        if (poll % 4 === 0) setStatus('Сравниваю… (могут занять время на больших прайсах)', 'spin');
        if (poll === 5999) { setStatus('Сравнение заняло слишком долго, попробуйте ещё раз', 'error'); return; }
      }
      if (!jj || jj.status !== 'done') { setStatus('Не дождались результата сравнения', 'error'); return; }
      const done = jj;
      const taskId = j.taskId;
      // Два независимых файла: resultId — всегда CSV, xlsxId — xlsx (когда готов).
      lastResult = { ...j, resultId: done.resultId, xlsxId: done.xlsxId, countA: done.countA, countB: done.countB, matched: done.matched, avgPct: done.avgPct, medianPct: done.medianPct, disc: done.disc || null, discTotal: done.discTotal || 0, discNeg: done.discNeg || 0, sampled: !!done.sampled, aiEnabled: !!done.aiEnabled, aiPending: !!done.aiPending, aiInsight: done.aiInsight || null, aiFailed: !!done.aiFailed };
      renderSummary(lastResult);
      if (done.aiPending) pollAI(taskId);
      const csvBtn = $('csvBtn');
      const xlsxBtn = $('xlsxBtn');
      // CSV доступен ВСЕГДА с момента готовности сравнения.
      csvBtn.hidden = false;
      xlsxBtn.hidden = true;
      $('results').hidden = false;
      $('results').scrollIntoView({ behavior: 'smooth' });
      // Пока xlsx собирается — на XLSX-кнопке показываем обратный отсчёт
      // (сервер прерывает долгую сборку по своему watchdog 90 с); CSV при этом
      // доступен. Как только xlsx готов — показываем активную кнопку XLSX.
      const xlsxLabel = xlsxBtn.querySelector('.btn-label');
      const setXlsx = (txt) => { if (xlsxLabel) xlsxLabel.textContent = txt; };
      if (done.xlsxPending && !done.xlsxReady) {
        const XLSX_WAIT_SEC = 90;
        setXlsx('XLSX через ' + XLSX_WAIT_SEC + ' с');
        (async () => {
          let tries = 0;
          while (tries < 95) {
            await new Promise((s) => setTimeout(s, 1000));
            tries++;
            const left = XLSX_WAIT_SEC - tries;
            if (left >= 0) setXlsx('XLSX через ' + left + ' с');
            try {
      const sr = await fetch(apiPath('/api/compare/status?taskId=' + encodeURIComponent(taskId)));
              const sj = await sr.json();
              if (sj && sj.ok && sj.xlsxReady) {
                lastResult.xlsxId = sj.xlsxId || lastResult.xlsxId;
                setXlsx('Скачать XLSX');
                xlsxBtn.hidden = false;
                setStatus('Готово: ' + done.matched + ' совпадений — доступны CSV и XLSX', 'ok');
                break;
              }
              if (sj && sj.ok && sj.xlsxFailed) {
                xlsxBtn.hidden = true;
                setStatus('Готово: ' + done.matched + ' совпадений. XLSX собрать не удалось — доступен CSV', 'ok');
                break;
              }
            } catch (e) {}
            if (tries === 94) {
              xlsxBtn.hidden = true;
              setStatus('Готово: ' + done.matched + ' совпадений. XLSX собрать не удалось — доступен CSV', 'ok');
            }
          }
        })();
      } else if (done.xlsxReady) {
        setXlsx('Скачать XLSX');
        xlsxBtn.hidden = false;
      } else {
        xlsxBtn.hidden = true;
      }
      setStatus('Сравнение завершено: ' + done.matched + ' совпадений' + (done.xlsxPending && !done.xlsxReady ? ' — готовим XLSX…' : ''), 'ok');
    } catch (e) {
      setStatus((e && e.message) || 'Ошибка соединения', 'error');
    }
  }

  function renderSummary(j) {
    const stats = $('stats');
    stats.innerHTML = '';
    // Показываем МЕДИАНУ (устойчива к выбросам), а не среднее, которое из-за
    // позиций с крошечной ценой в знаменателе искажается до -90…-99%.
    const pct = (j && typeof j.medianPct === 'number') ? j.medianPct : ((j && typeof j.avgPct === 'number') ? j.avgPct : null);
    const fmtPct = pct == null ? '—' : ((pct > 0 ? '+' : '') + pct.toFixed(2).replace('.', ',') + '%');
    // Скидка, чтобы догнать конкурентов по 50% позиций (из перцентилей воркера).
    const disc50 = (j && j.disc && j.disc.p50 != null) ? (j.disc.p50 + '%') : '—';
    [
      { k: 'В прайсе 1', v: Number(j && j.countA) || 0 },
      { k: 'В прайсе 2', v: Number(j && j.countB) || 0 },
      { k: 'Совпадений', v: Number(j && j.matched) || 0 },
      { k: 'Скидка до 50% позиций', v: disc50 }
    ].forEach((it) => {
      const s = el('div', 'stat');
      s.appendChild(el('div', 'k', it.k));
      s.appendChild(el('div', 'v', (typeof it.v === 'number') ? it.v.toLocaleString('ru-RU') : it.v));
      stats.appendChild(s);
    });

    renderAINote();
  }

  // Текст-анализ под карточками итогов. Приоритет — вывод DeepSeek; если его
  // нет (ключ не задан, ошибка или ещё готовится) — расчётный вердикт по
  // средней разнице. Рендерим через textContent, чтобы LLM-текст не стал XSS.
  function aiVerdictFallback(avgPct) {
    if (avgPct == null) return '';
    const aName = ($('nameA') && $('nameA').value.trim()) || 'Прайс 1';
    const bName = ($('nameB') && $('nameB').value.trim()) || 'Прайс 2';
    // «Наш» прайс — тот, что называется «Проф»; устойчиво к порядку загрузки.
    const aIsOurs = aName.trim().toLowerCase() === 'проф';
    const oursName = aIsOurs ? aName : bName;
    const rivalName = aIsOurs ? bName : aName;
    // Отклонение со знаком «от нашего прайса»: >0 — наш дороже, <0 — наш дешевле.
    const fromOurs = aIsOurs ? avgPct : -avgPct;
    const abs = Math.abs(avgPct).toFixed(2).replace('.', ',') + '%';
    if (fromOurs < -0.005) return 'Вы («' + oursName + '») в типовом случае дешевле конкурентов («' + rivalName + '») на ' + abs + ' · вы выигрываете по цене';
    if (fromOurs > 0.005) return 'Конкуренты («' + rivalName + '») в типовом случае превосходят вас («' + oursName + '») по цене на ' + abs + ' · их цены ниже';
    return 'Цены в типовом случае сопоставимы';
  }
  function renderAINote() {
    const note = $('resNote');
    if (!note) return;
    const r = lastResult || {};
    let txt = '';
    if (r.aiInsight) {
      txt = '🤖 ' + r.aiInsight;
    } else if (r.aiPending) {
      txt = '🤖 ИИ-анализ готовится…';
    } else {
      txt = aiVerdictFallback(r.medianPct != null ? r.medianPct : r.avgPct);
      if (r.aiFailed && !r.aiEnabled) txt += ' (DeepSeek не настроен, показан расчёт)';
      else if (r.aiFailed) txt += ' (ИИ временно недоступен, показан расчёт)';
    }
    // Вывод «на сколько скинуть цену, чтобы догнать конкурентов по доле позиций».
    if (r.disc && (r.disc.p50 != null || r.disc.p60 != null || r.disc.p70 != null)) {
      const fmt = (x) => (x == null ? '—' : x + '%');
      const discTxt = 'Скидка на ваш прайс, чтобы сравняться с конкурентом: 50% позиций → ' + fmt(r.disc.p50) +
        ', 60% → ' + fmt(r.disc.p60) + ', 70% → ' + fmt(r.disc.p70) + '.';
      txt = (txt ? txt + ' ' : '') + discTxt;
    }
    note.textContent = (txt ? txt + ' ' : '') + 'Полный результат и распределение по шагам скидки — на листе «Итоги» в XLSX.';
  }

  // Опрос готовности ИИ-анализа после завершения сравнения (до ~60 с).
  async function pollAI(taskId) {
    let tries = 0;
    while (tries < 40) {
      await new Promise((s) => setTimeout(s, 1500));
      tries++;
      try {
        const sr = await fetch('/api/compare/status?taskId=' + encodeURIComponent(taskId));
        const sj = await sr.json();
        if (!sj || !sj.ok) break;
        if (sj.aiInsight) { lastResult.aiInsight = sj.aiInsight; lastResult.aiPending = false; renderAINote(); return; }
        if (sj.aiFailed || !sj.aiPending) { lastResult.aiPending = false; lastResult.aiFailed = !!sj.aiFailed; renderAINote(); return; }
        if (sj.aiPending) renderAINote();
      } catch (_) { break; }
    }
    if (lastResult && lastResult.aiPending) { lastResult.aiPending = false; renderAINote(); }
  }

  $('compareBtn').addEventListener('click', compare);
  initDrop('A');
  initDrop('B');
  bindCurrency('A');
  bindCurrency('B');
  $('csvBtn').hidden = true;
  $('xlsxBtn').hidden = true;

  // Чанковое скачивание результата: качаем части по отдельным запросам
  // (каждая меньше лимита ответа шлюза), склеиваем в Blob и сохраняем.
  async function downloadResult(resultId, isXlsx) {
    if (!lastResult || !resultId) return;
    const btn = isXlsx ? $('xlsxBtn') : $('csvBtn');
    btn.disabled = true;
    setStatus('Скачиваю результат…', 'spin');
    const suggestedName = isXlsx ? 'Сравнение_прайсов.xlsx' : 'Сравнение_прайсов.csv';
    // Имя всегда должно заканчиваться нужным расширением: в диалоге пользователь
    // может стереть .xlsx/.csv и Excel перестанет понимать файл (файл валидный,
    // но без расширения открыться не может). Если вдруг имя без расширения —
    // добавляем его, а после сохранения предупреждаем.
    const ext = isXlsx ? '.xlsx' : '.csv';
    const ensureExt = (name) => (String(name).toLowerCase().endsWith(ext) ? name : name + ext);
    // Нативный диалог сохранения (Chrome/Edge) открываем СРАЗУ, на живом клике —
    // иначе после долгой загрузки частей user activation истечёт, и
    // showSaveFilePicker откажется. Сохраняем handle и пишем blob позже.
    let saveWritable = null;
    if (window.showSaveFilePicker) {
      try {
        // Передаём браузеру типы с расширением: нативный диалог сам предложит и
        // подставит правильное расширение, чтобы файл не сохранялся «вслепую».
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: isXlsx ? 'Книга Excel' : 'CSV-файл',
            accept: isXlsx ? { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } : { 'text/csv': ['.csv'] }
          }]
        });
        saveWritable = await handle.createWritable();
      } catch (e) {
        // диалог закрыт пользователем или не поддержан — переходим на старый путь
        if (e && e.name === 'AbortError') { setStatus('Сохранение отменено', 'ok'); return; }
        saveWritable = null;
      }
    }
    try {
      const metaR = await fetch(apiPath('/api/download/meta?resultId=' + encodeURIComponent(resultId)));
      const meta = await metaR.json();
      if (!metaR.ok || !meta.ok) { setStatus(errText(meta && meta.error, 'Не удалось получить информацию о файле'), 'error'); btn.disabled = false; return; }
      const parts = [];
      for (let p = 0; p < meta.parts; p++) {
      const pr = await fetch(apiPath('/api/download/part?resultId=' + encodeURIComponent(resultId) + '&part=' + p));
        if (!pr.ok) { setStatus('Скачивание сорвалось на части ' + (p + 1) + '/' + meta.parts + ' — начните заново', 'error'); btn.disabled = false; return; }
        parts.push(await pr.blob());
        setStatus('Скачиваю результат… ' + Math.round(((p + 1) / meta.parts) * 100) + '%', 'spin');
      }
      const mime = isXlsx ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv;charset=utf-8';
      const blob = new Blob(parts, { type: mime });
      if (saveWritable) {
        // Нативный диалог уже открыт — пишем blob напрямую на диск.
        await saveWritable.write(blob);
        await saveWritable.close();
        // Сообщаем итоговое имя файла + напоминание про расширение.
        const nm = (typeof saveWritable.path === 'string' ? saveWritable.path : suggestedName) || suggestedName;
        const finalName = nm.split(/[\\/]/).pop() || suggestedName;
        setStatus('Готово: файл «' + finalName + '» сохранён' + (finalName.toLowerCase().endsWith(ext) ? '' : ' — добавьте ' + ext + ', чтобы открыть в Excel'), 'ok');
      } else {
        // Фолбэк для браузеров без showSaveFilePicker: скачивание через ссылку.
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = ensureExt(suggestedName);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        setStatus('Готово: файл скачан', 'ok');
      }
    } catch (e) {
      if (saveWritable) { try { await saveWritable.abort(); } catch (_) {} }
      setStatus('Ошибка скачивания', 'error');
    } finally {
      btn.disabled = false;
    }
    // после скачивания убираем исходники и результат с сервера
    const ids = [];
    if (state.A.fileId) ids.push(state.A.fileId);
    if (state.B.fileId) ids.push(state.B.fileId);
    if (lastResult && lastResult.resultId) ids.push(lastResult.resultId);
    if (lastResult && lastResult.xlsxId) ids.push(lastResult.xlsxId);
    cleanupServer(ids);
  }
  $('csvBtn').addEventListener('click', () => downloadResult(lastResult && lastResult.resultId, false));
  $('xlsxBtn').addEventListener('click', () => downloadResult(lastResult && lastResult.xlsxId, true));

  maybeEnable();
})();
