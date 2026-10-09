'use strict';

const $ = (id) => document.getElementById(id);
// Встроенный в BIOTIME режим: страница живёт на /reports/, значит абсолютные пути
// API (/api/*) дополняем префиксом /reports. При самостоятельном деплое префикс пуст.
const API_BASE = (function () {
  try {
    const src = document.currentScript && document.currentScript.src;
    const p = src ? new URL(src).pathname : '';
    return p.startsWith('/reports/') ? '/reports' : '';
  } catch (_e) { return ''; }
})();

let reportData = null;
let dashboardData = null;
let publicSettings = null;
let selectedStatuses = new Set();
let excludedDistributors = new Set();
let allDistributors = [];

const fmtMoney = (n) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtOrderDate = (str) => {
  const m = String(str || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return str || '—';
  const time = m[4] ? ` ${m[4]}:${m[5]}` : '';
  return `${m[3]}.${m[2]}.${m[1]}${time}`;
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ---------- Экспорт в Excel (.xlsx) без внешних зависимостей ---------- */
function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function xlsxColLetters(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    let c = '';
    let v = i;
    while (v > 0) { const r = (v - 1) % 26; c = String.fromCharCode(65 + r) + c; v = Math.floor((v - 1) / 26); }
    out.push(c);
  }
  return out;
}
function crc32Bytes(bytes) {
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function buildWorksheetXml(cols, rows) {
  const letters = xlsxColLetters(Math.max(1, cols.length));
  const parts = ['<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
  const headCells = cols.map((c, i) => `<c r="${letters[i]}1" t="inlineStr" s="1"><is><t>${escXml(c)}</t></is></c>`).join('');
  parts.push(`<row r="1">${headCells}</row>`);
  rows.forEach((r, ri) => {
    const rn = ri + 2;
    const cells = cols.map((_, ci) => {
      const ref = letters[ci] + rn;
      const v = r[ci];
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      const s = v == null ? '' : String(v);
      return `<c r="${ref}" t="inlineStr"><is><t>${escXml(s)}</t></is></c>`;
    }).join('');
    parts.push(`<row r="${rn}">${cells}</row>`);
  });
  parts.push('</sheetData></worksheet>');
  return parts.join('');
}
function zipStoreEntries(parts) {
  const enc = new TextEncoder();
  const body = [];
  const centralBody = [];
  let offset = 0;
  for (const p of parts) {
    const nameB = enc.encode(p.name);
    const data = p.data;
    const crc = crc32Bytes(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, 0, true); lh.setUint16(12, 0, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameB.length, true); lh.setUint16(28, 0, true);
    body.push(new Uint8Array(lh.buffer), nameB, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, 0, true); ch.setUint16(14, 0, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameB.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
    ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    centralBody.push(new Uint8Array(ch.buffer), nameB);
    offset += 30 + nameB.length + data.length;
  }
  const central = centralBody.reduce((s, c) => s + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
  eocd.setUint16(8, parts.length, true); eocd.setUint16(10, parts.length, true);
  eocd.setUint32(12, central, true); eocd.setUint32(16, offset, true); eocd.setUint16(20, 0, true);
  const chunks = body.concat(centralBody).concat([new Uint8Array(eocd.buffer)]);
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
function exportXlsx(opts) {
  const enc = new TextEncoder();
  const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + escXml(opts.sheetName || 'Лист1') + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"><alignment horizontal="center" vertical="center"/></xf></cellXfs></styleSheet>';
  const sheet = buildWorksheetXml(opts.cols, opts.rows);
  const parts = [
    { name: '[Content_Types].xml', data: enc.encode(ct) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'xl/workbook.xml', data: enc.encode(wb) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
    { name: 'xl/styles.xml', data: enc.encode(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
  ];
  const bytes = zipStoreEntries(parts);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = opts.filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 600);
}

/* ---------- Табы ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    try { localStorage.setItem('ap_tab', tab.dataset.tab); } catch (_e) { /* ignore */ }
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
    $('view-' + tab.dataset.tab).classList.add('is-active');
    if (tab.dataset.tab === 'settings') loadSettings();
    else if (tab.dataset.tab === 'rejections' && !rejData) loadRejections();
    else if (tab.dataset.tab === 'client-rejections' && !crjData) loadClientRejections();
    else if (tab.dataset.tab === 'client-analysis') loadClientAnalysis();
    else if (tab.dataset.tab === 'europe') loadEurope();
    else if (tab.dataset.tab === 'client-config') loadClientConfig();
    else if (tab.dataset.tab === 'manual-automat' && !maData) loadManualAutomat();
    else if (tab.dataset.tab === 'report' && !reportData) loadReport();
    else if (tab.dataset.tab === 'dashboard') {
      fillDashboardPeriod();
      if (!dashboardData) loadDashboard();
    }
    else if (tab.dataset.tab === 'terms') {
      if (!termsData) loadTerms();
    }
    else if (tab.dataset.tab === 'pricing') {
      updatePrSelected();
    }
    else if (tab.dataset.tab === 'users') {
      loadUsers();
    }
    else if (tab.dataset.tab === 'logs') {
      loadLogs();
    }
    else if (tab.dataset.tab === 'supplier-emails') {
      loadSupplierEmails();
    }
  });
});

/* ---------- Автообновление отчётов ---------- */
const AUTO_REFRESH_MS = 10 * 60 * 1000;
function autoRefreshActiveReport() {
  // Сбрасываем клиентский кэш модалок, чтобы после автообновления разбивки
  // пересчитывались из свежих данных, а не оставались закэшированными со старой сессии.
  supplierClientsCacheUI.clear();
  warehousesCacheUI.clear();
  const active = document.querySelector('.tab.is-active');
  if (!active) return;
  const t = active.dataset.tab;
  if (t === 'rejections') { loadRejections({ refresh: true }); return; }
  if (t === 'client-rejections') { loadClientRejections({ refresh: true }); return; }
  if (t === 'client-analysis') { loadClientAnalysis({ refresh: true }); return; }
  if (t === 'europe') { loadEurope({ refresh: true }); return; }
  if (t === 'client-config') { loadClientConfig({ refresh: true }); return; }
  if (t === 'manual-automat') { loadManualAutomat({ refresh: true }); return; }
  if (t === 'report') { loadReport({ refresh: true, silent: true }); return; }
  if (t === 'dashboard') { loadDashboard({ refresh: true }); return; }
  if (t === 'terms') { loadTerms({ refresh: true }); return; }
}
setInterval(autoRefreshActiveReport, AUTO_REFRESH_MS);

// Быстрое автообновление дашборда (пока вкладка активна) — данные должны приходить
// из ABCP максимально оперативно.
setInterval(() => {
  const active = document.querySelector('.tab.is-active');
  if (active && active.dataset.tab === 'dashboard' && dashboardData) loadDashboard({ refresh: true });
}, 30 * 1000);

/* ---------- Логи ---------- */
let logsCat = 'mail';
let lastLogs = [];

async function loadLogs() {
  const errBox = $('logs-err');
  errBox.classList.add('hidden');
  const dateEl = $('logs-date');
  const date = dateEl ? dateEl.value : '';
  let url = '/api/logs';
  if (date) url += '?date=' + encodeURIComponent(date);
  try {
    const data = await api(url);
    lastLogs = data.logs || [];
    renderLogs(lastLogs);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
}

function renderLogs(logs) {
  const box = $('logs-rows');
  box.innerHTML = '';
  const hint = $('logs-hint');
  hint.textContent = logsCat === 'mail'
    ? 'Почта: каждая рассылка — сворачиваемая карточка; клик по ней раскрывает шаги.'
    : logsCat === 'term'
      ? 'Изменение срока: запись реального срока поставщика в ABCP — сворачиваемые карточки.'
      : logsCat === 'automat'
        ? 'Автомат: номерa заказов, по которым статус автоматически изменён на «Заказан».'
        : 'ABCP: загрузка и обработка данных — сворачиваемые карточки по задачам.';
  // Строго по категории: «Почта» — только mail (письма/снятие/запрос),
  // «ABCP» — только abcp (загрузка заказов). Прокачка заказов не попадает в почту.
  const filtered = logs.filter((l) => l && l.msg && l.cat === logsCat);
  const order = [];
  const groups = new Map();
  for (const l of filtered) {
    const key = l.taskId || ('solo:' + l.ts + ':' + l.msg.slice(0, 20));
    if (!groups.has(key)) { groups.set(key, { entries: [] }); order.push(key); }
    groups.get(key).entries.push(l);
  }
  order.forEach((key) => {
    const g = groups.get(key);
    const last = g.entries[g.entries.length - 1];
    const hasErr = g.entries.some((e) => e.level === 'error');
    const hasWarn = !hasErr && g.entries.some((e) => e.level === 'warn');
    const status = hasErr ? 'ERR' : hasWarn ? 'WARN' : 'OK';

    const card = el('div', 'log-card' + (hasErr ? ' is-err' : hasWarn ? ' is-warn' : ''));
    const head = el('div', 'log-card-head');
    head.setAttribute('role', 'button');
    head.tabIndex = 0;
    head.appendChild(el('span', 'log-status ' + (hasErr ? 'is-err' : hasWarn ? 'is-warn' : 'is-ok'), status));
    head.appendChild(el('span', 'log-card-msg', last.msg || ''));
    const ld = new Date(last.ts);
    const ltime = `${String(ld.getDate()).padStart(2, '0')}.${String(ld.getMonth() + 1).padStart(2, '0')} ${String(ld.getHours()).padStart(2, '0')}:${String(ld.getMinutes()).padStart(2, '0')}`;
    head.appendChild(el('span', 'log-card-time', ltime));
    head.appendChild(el('span', 'log-card-count', g.entries.length > 1 ? `${g.entries.length} шагов` : ''));
    head.appendChild(el('span', 'log-chev', '▾'));

    const body = el('div', 'log-card-body');
    body.style.display = 'none';
    g.entries.forEach((e) => {
      const lv = e.level === 'error' ? 'is-err' : e.level === 'warn' ? 'is-warn' : 'is-info';
      const t = new Date(e.ts);
      const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      const step = el('div', 'log-step ' + lv);
      step.appendChild(el('span', 'log-dot'));
      step.appendChild(el('span', 'log-step-time', time));
      step.appendChild(el('span', 'log-step-text', e.msg));
      body.appendChild(step);
    });

    const toggle = () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      head.classList.toggle('open', !open);
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });

    card.appendChild(head);
    card.appendChild(body);
    box.appendChild(card);
  });
  $('logs-empty').classList.toggle('hidden', filtered.length > 0);
}

$('btn-refresh-logs').addEventListener('click', loadLogs);
$('btn-logs-today').addEventListener('click', () => {
  const dateEl = $('logs-date');
  if (dateEl) dateEl.value = '';
  loadLogs();
});
$('logs-date').addEventListener('change', loadLogs);
document.querySelectorAll('.logtab').forEach((btn) => {
  btn.addEventListener('click', () => {
    logsCat = String(btn.getAttribute('data-logcat') || 'mail');
    document.querySelectorAll('.logtab').forEach((b) => b.classList.toggle('is-active', b === btn));
    renderLogs(lastLogs);
  });
});
$('btn-clear-logs').addEventListener('click', () => {
  $('logs-rows').innerHTML = '';
  $('logs-empty').classList.remove('hidden');
});

/* ---------- API ---------- */
// Отображаемое имя поставщика: переименовываем 1de.by в читаемые названия.
function dispSupplier(n) {
  const s = String(n == null ? '' : n);
  if (/^1de\.by BYN\b/i.test(s)) return 'Сфера Минск';
  if (/^1de\.by EUR\b/i.test(s)) return 'EU';
  return s;
}

// Переименовывает имена поставщиков внутри данных отчёта (только для отображения).
function renameSupplierData(d) {
  if (Array.isArray(d && d.rows)) {
    d.rows.forEach((r) => {
      if (r.distributor != null && r._rawDist == null) r._rawDist = r.distributor;
      if (r.distributor != null) r.distributor = dispSupplier(r.distributor);
      if (r.name != null) r.name = dispSupplier(r.name);
    });
  }
  if (Array.isArray(d && d.byDistributor)) {
    d.byDistributor.forEach((x) => {
      if (x.name != null) x.name = dispSupplier(x.name);
    });
  }
  if (Array.isArray(d && d.suppliers)) {
    d.suppliers.forEach((x) => {
      if (x && x.name != null) x.name = dispSupplier(x.name);
    });
  }
  return d;
}

async function api(path, opts) {
  // Встроенный в BIOTIME режим: страница живёт на /reports/, поэтому абсолютные
  // пути API (/api/*) перенаправляем на /reports/api/*. Когда модуль деплоится
  // отдельно (без префикса), префикс пуст и пути не меняются.
  const outPath = (API_BASE || '') + path;
  const res = await fetch(outPath, { ...(opts || {}), cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    // Во встроенном режиме (модуль смонтирован в BIOTIME под /reports/) окно входа
    // не показываем: доступ уже обеспечен через BIOTIME (canSeeReports). Если бы
    // 401 всё же пришёл — это отсутствие прав, а не повод грузить форму входа.
    if (!API_BASE) showLoginGate();
    const e = new Error('Требуется вход');
    e.authRequired = true;
    throw e;
  }
  if (!res.ok) {
    const gh = gatewayMessage(data);
    const raw = data && data.error != null ? data.error : 'Ошибка запроса';
    const msg = gh || (typeof raw === 'string' ? raw : JSON.stringify(raw));
    const e = new Error(msg);
    e.auth = data.auth;
    e.code = data.code;
    throw e;
  }
  return data;
}

// Ответ шлюза платформы, когда приложение ещё стартует/не успело ответить —
// превращаем в понятный текст, а не в сырой JSON.
function gatewayMessage(data) {
  if (!data || typeof data !== 'object') return '';
  const code = data.code;
  if (code === 'BH_APP_STARTING') {
    return 'Приложение ещё загружается, подождите несколько секунд…';
  }
  if (code === 'BH_APP_TIMEOUT') {
    return 'Приложение не успело ответить. Повторите, пожалуйста, ещё раз.';
  }
  return '';
}

// Обработчик входа — привязываем первым, чтобы он работал, даже если
// какая-то другая инициализация страницы позже упадёт с ошибкой.
const loginFormEl = document.getElementById('login-form');
if (loginFormEl) {
  loginFormEl.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('login-error');
    if (errBox) errBox.classList.add('hidden');
    try {
      await api('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: document.getElementById('li-login').value, password: document.getElementById('li-password').value }),
      });
      window.location.reload();
    } catch (err) {
      if (errBox) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      } else {
        alert('Ошибка входа: ' + err.message);
      }
    }
  });
}

// Опрос готовности: сервер собирает данные в фоне и сразу отвечает 202,
// когда снимок ещё не готов. Здесь ждём короткими интервалами до готового ответа.
async function apiPoll(path, { refresh } = {}) {
  let first = true;
  let waitCount = 0;
  // Первый раз по большому периоду ABCP грузится очень долго (до 15–20 минут),
  // поэтому ждём дольше, чем раньше, и не обрываем легитимную первую загрузку.
  const MAX_WAIT = 480; // 480 × 2.5 c ≈ 20 минут
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    // cache-buster: уникальный URL при refresh, чтобы ни браузер, ни шлюз не смогли
    // вернуть старый закешированный ответ (иначе смена периода «не доезжает»).
    const url = path + (first && refresh ? sep + 'refresh=1&_=' + Date.now() : '');
    first = false;
    const res = await fetch((API_BASE || '') + url, { cache: 'no-store' });
    if (res.status === 202) {
      waitCount++;
      await new Promise((r) => setTimeout(r, 2500));
      if (waitCount > MAX_WAIT) throw new Error('Данные ещё загружаются (первый раз по большому периоду это долго). Попробуйте позже или нажмите «Обновить данные».');
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (data && data.code === 'BH_APP_STARTING') {
      waitCount++;
      const wait = (typeof data.retryAfter === 'number' ? data.retryAfter * 1000 : 2500);
      await new Promise((r) => setTimeout(r, wait));
      if (waitCount > MAX_WAIT) throw new Error('Приложение так и не загрузилось. Нажмите «Обновить данные» ещё раз.');
      continue;
    }
    if (!res.ok) {
      const gh = gatewayMessage(data);
      const raw = data && data.error != null ? data.error : 'Ошибка запроса';
      const msg = gh || (typeof raw === 'string' ? raw : JSON.stringify(raw));
      const e = new Error(msg);
      e.fromServer = true;
      e.auth = data.auth;
      e.code = data.code;
      throw e;
    }
    return data;
  }
}

async function loadReport({ silent, refresh } = {}) {
  const spinner = $('spinner');
  const errBox = $('error');
  errBox.classList.add('hidden');

  const prevSearch = $('filter-search').value;
  const prevDist = reportSupplierSel;

  if (!silent) spinner.classList.remove('hidden');
  try {
    initPeriodControl('rp', 'reportPeriod', () => loadReport({ refresh: true }));
    reportData = await apiPoll('/api/report', { refresh });
    renameSupplierData(reportData);
    fillReportParams();
    if ($('rp-status-checks')) buildStatusChecks(reportData.statusCodes || []);
    buildExclusionUI(reportData.rows || []);
    fillDistributorSelect(reportData.rows || []);
    buildReportStatusFilter(reportData.rows || []);
    $('filter-search').value = prevSearch;
    reportSupplierSel = prevDist;
    applyFilters();
    $('report-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    $('report-body').classList.add('hidden');
    if (e.auth) openSettings();
  } finally {
    spinner.classList.add('hidden');
  }
}

function fillReportParams() {
  initPeriodControl('rp', 'reportPeriod', () => loadReport({ refresh: true }));
}

// Красивый выбор поставщиков в «Просрочке»: кастомный выпадающий список с поиском.
let reportSupplierSel = 'Все поставщики';
let sdItems = [];
function fillDistributorSelect(rows) {
  const counts = new Map();
  for (const r of rows) {
    const d = r.distributor || '—';
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  sdItems = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const lbl = $('sd-label');
  if (lbl) lbl.textContent = reportSupplierSel;
  renderSupplierMenu('');
}

function renderSupplierMenu(q) {
  const list = $('sd-list');
  if (!list) return;
  list.innerHTML = '';
  const query = (q || '').trim().toLowerCase();
  const push = (name, count, active) => {
    const b = el('button', 'sd-item' + (active ? ' is-active' : ''), '');
    b.type = 'button';
    const lb = el('span', 'sd-item-name', name);
    const ct = el('span', 'sd-item-count', count != null ? String(count) : '');
    b.appendChild(lb);
    if (ct.textContent) b.appendChild(ct);
    b.addEventListener('click', () => {
      reportSupplierSel = name;
      $('sd-label').textContent = name;
      closeSupplierMenu();
      applyFilters();
    });
    list.appendChild(b);
  };
  const total = sdItems.reduce((s, x) => s + x[1], 0);
  push('Все поставщики', total, reportSupplierSel === 'Все поставщики');
  const filtered = query ? sdItems.filter((x) => x[0].toLowerCase().includes(query)) : sdItems;
  for (const [name, count] of filtered) push(name, count, reportSupplierSel === name);
}

function openSupplierMenu() { $('sd-menu').classList.remove('hidden'); $('sd-search').value = ''; $('sd-search').focus(); }
function closeSupplierMenu() { $('sd-menu').classList.add('hidden'); }

$('sd-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = !$('sd-menu').classList.contains('hidden');
  if (open) closeSupplierMenu(); else openSupplierMenu();
});
$('sd-search').addEventListener('input', (e) => renderSupplierMenu(e.target.value));
document.addEventListener('click', (e) => { if (!$('sd').contains(e.target)) closeSupplierMenu(); });

// Фильтр по статусу строки (столбец «Статус») в «Просрочке». Чипы-пилюли:
// клик по статусу показывает только такие строки; «Все» — сброс.
let reportStatusSel = new Set();
function buildReportStatusFilter(rows) {
  const wrap = $('rp-status-filter');
  if (!wrap) return;
  const counts = new Map();
  for (const r of rows) {
    const st = String(r.status == null || r.status === '' ? '—' : r.status);
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  const statuses = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (!statuses.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';

  const makeChip = (label, active, onClick) => {
    const b = el('button', 'rp-chip' + (active ? ' is-active' : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  wrap.appendChild(makeChip('Все', reportStatusSel.size === 0, () => {
    reportStatusSel = new Set();
    buildReportStatusFilter(reportData.rows || []);
    applyFilters();
  }));
  for (const [st, cnt] of statuses) {
    const active = reportStatusSel.has(st);
    wrap.appendChild(makeChip(`${st} · ${cnt}`, active, () => {
      if (reportStatusSel.has(st)) reportStatusSel.delete(st);
      else reportStatusSel.add(st);
      buildReportStatusFilter(reportData.rows || []);
      applyFilters();
    }));
  }
}

function fillSelect(select, items) {
  select.innerHTML = '';
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    select.appendChild(opt);
  }
}

/* ---------- Статусы (прямой фильтр) ---------- */
function buildStatusChecks(codes) {
  const wrap = $('rp-status-checks');
  wrap.innerHTML = '';
  const saved = publicSettings && publicSettings.completedStatusCodes
    ? publicSettings.completedStatusCodes.map(String)
    : [];
  const hasUserChoice = publicSettings && publicSettings.statusesTouched === true;
  const chosen = hasUserChoice
    ? new Set(saved)
    : defaultShownStatuses(codes);
  selectedStatuses = chosen;

  if (!codes.length) {
    $('rp-status-load').classList.remove('hidden');
    return;
  }
  $('rp-status-load').classList.add('hidden');

  for (const s of codes) {
    const key = String(s.statusCode);
    const label = el('label', 'status-check');
    const cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.checked = chosen.has(key);
    cbx.addEventListener('change', () => {
      if (cbx.checked) selectedStatuses.add(key);
      else selectedStatuses.delete(key);
      applyFilters();
    });
    label.appendChild(cbx);
    label.appendChild(el('span', 'sc-label', `${s.statusCode} · ${s.status || ''}`));
    label.appendChild(el('span', 'sc-count', s.count));
    wrap.appendChild(label);
  }
}

// Статусы, включённые в «Статусы для показа» по умолчанию, пока пользователь
// не применил свой выбор вручную. Можно снять их галочками.
// По умолчанию включены: Заказан (92320), Подтвержден поставщиком (436354),
// Обработка заказа (124679). Можно снять вручную.
const DEFAULT_SHOWN_STATUSES = ['92320', '436354', '124679'];

function defaultShownStatuses(codes) {
  const present = (codes || []).filter((c) => DEFAULT_SHOWN_STATUSES.includes(String(c.statusCode)));
  return new Set(present.map((c) => String(c.statusCode)));
}

/* ---------- Исключение поставщиков (окно с поиском) ---------- */
function buildExclusionUI(rows) {
  const fromSettings = new Set(
    publicSettings && publicSettings.excludedDistributors
      ? publicSettings.excludedDistributors.map(String)
      : []
  );
  excludedDistributors = fromSettings;
  const set = new Set();
  for (const name of fromSettings) set.add(name);
  for (const r of rows) if (r.distributor) set.add(r.distributor);
  allDistributors = Array.from(set).sort();
  $('exclusion-note').classList.toggle('hidden', allDistributors.length > 0);
  renderExclusionTags();
}

function renderExclusionTags() {
  const wrap = $('exclusion-tags');
  wrap.innerHTML = '';
  for (const name of Array.from(excludedDistributors).sort()) {
    const tag = el('span', 'exclusion-tag');
    tag.appendChild(el('span', null, name));
    const rm = el('button', 'exclusion-tag-remove', '×');
    rm.type = 'button';
    rm.setAttribute('aria-label', 'Убрать исключение');
    rm.addEventListener('click', () => {
      excludedDistributors.delete(name);
      renderExclusionTags();
      applyFilters();
    });
    tag.appendChild(rm);
    wrap.appendChild(tag);
  }
}

function openExclusionModal() {
  if (!allDistributors.length) return;
  $('exclusion-search').value = '';
  renderExclusionList('');
  $('exclusion-modal').classList.remove('hidden');
}

function closeExclusionModal() {
  $('exclusion-modal').classList.add('hidden');
}

function renderExclusionList(query) {
  const list = $('exclusion-list');
  list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const names = allDistributors.filter((n) => !q || n.toLowerCase().includes(q));
  if (!names.length) {
    list.appendChild(el('div', 'exclusion-empty', 'Ничего не найдено'));
    return;
  }
  for (const name of names) {
    const added = excludedDistributors.has(name);
    const row = el('button', 'exclusion-item' + (added ? ' is-added' : ''), name);
    row.type = 'button';
    row.appendChild(el('span', 'exclusion-item-mark', added ? '✓' : '+'));
    row.addEventListener('click', () => {
      if (added) excludedDistributors.delete(name);
      else excludedDistributors.add(name);
      renderExclusionList($('exclusion-search').value);
      renderExclusionTags();
      applyFilters();
    });
    list.appendChild(row);
  }
}

/* ---------- Фильтрация и рендер ---------- */
function applyFilters() {
  if (!reportData) return;
  const q = $('filter-search').value.trim().toLowerCase();
  const dist = reportSupplierSel;

  let rows = reportData.rows;
  if (q) {
    // Поиск по номеру заказа (вместо артикула/товара).
    rows = rows.filter((r) => String(r.orderNumber == null ? '' : r.orderNumber).indexOf(q) !== -1);
  }
  if (dist && dist !== 'Все поставщики') rows = rows.filter((r) => r.distributor === dist);
  if (excludedDistributors.size > 0) {
    rows = rows.filter((r) => !excludedDistributors.has(r.distributor));
  }
  if (reportStatusSel.size > 0) {
    rows = rows.filter((r) => reportStatusSel.has(String(r.status == null || r.status === '' ? '—' : r.status)));
  }

  renderSummaries(rows);
  renderDistributors(rows);
  renderRows(rows);
  const mtGenerated = $('meta-generated');
  const mtOrders = $('meta-orders');
  if (mtGenerated) mtGenerated.textContent = `Обновлено: ${new Date(reportData.generatedAt).toLocaleString('ru-RU')}`;
  if (mtOrders) {
    const sum = rows.reduce((s, r) => s + (r.sum || 0), 0);
    mtOrders.textContent = `просрочено: ${fmtMoney(rows.length)} поз. · сумма ${fmtMoney(sum)} ₽`;
  }
}

function renderSummaries(rows) {
  let sum = 0;
  let maxLate = 0;
  const dists = new Set();
  for (const r of rows) {
    sum += r.sum;
    if (r.daysLate > maxLate) maxLate = r.daysLate;
    if (r.distributor) dists.add(r.distributor);
  }
  $('stat-overdue').textContent = fmtMoney(rows.length);
  $('stat-sum').textContent = fmtMoney(sum);
  $('stat-distributors').textContent = fmtMoney(dists.size);
  $('stat-max-late').textContent = maxLate;
}

function renderDistributors(rows) {
  overdueFilteredRows = rows;
  const wrap = $('distributors');
  wrap.innerHTML = '';
  const map = new Map();
  for (const r of rows) {
    const e = map.get(r.distributor) || { name: r.distributor, overdue: 0, sum: 0 };
    e.overdue += 1;
    e.sum += r.sum;
    map.set(r.distributor, e);
  }
  const list = Array.from(map.values()).sort((a, b) => b.overdue - a.overdue);
  const max = Math.max(1, list.reduce((m, x) => Math.max(m, x.overdue || 0), 0));
  for (const d of list) {
    const item = el('div', 'dist-item');
    item.style.cursor = 'pointer';
    item.title = 'Показать просроченные позиции';
    item.addEventListener('click', () => openOverdueSupplier(d.name));
    const head = el('div', 'dist-head');
    head.appendChild(el('span', 'dist-name', d.name));
    head.appendChild(el('span', 'dist-count', `${d.overdue} поз.`));
    const bar = el('div', 'dist-bar');
    const fill = el('div', 'dist-bar-fill');
    fill.style.width = `${Math.round((d.overdue / max) * 100)}%`;
    bar.appendChild(fill);
    item.appendChild(head);
    item.appendChild(bar);
    item.appendChild(el('div', 'dist-sum', `на ${fmtMoney(d.sum)} ₽`));
    wrap.appendChild(item);
  }
}

let overdueFilteredRows = [];

function openOverdueSupplier(name) {
  const rows = (overdueFilteredRows || []).filter((r) => r.distributor === name);
  ovdAllRows = rows;
  $('ovd-title').textContent = name;
  $('ovd-info').textContent = rows.length ? '' : 'Нет позиций';
  buildOvdStatusFilter(rows);
  renderOvdRows(ovdFilteredRows());
  $('ovd-modal').classList.remove('hidden');
}

let ovdAllRows = [];
let ovdStatusSel = new Set();
const ovdFilteredRows = () => {
  if (!ovdStatusSel.size) return ovdAllRows;
  return ovdAllRows.filter((r) => ovdStatusSel.has(String(r.status == null || r.status === '' ? '—' : r.status)));
};
function buildOvdStatusFilter(rows) {
  const wrap = $('ovd-status-filter');
  if (!wrap) return;
  const counts = new Map();
  for (const r of rows) {
    const st = String(r.status == null || r.status === '' ? '—' : r.status);
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  const statuses = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (!statuses.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  const chip = (label, active, onClick) => {
    const b = el('button', 'rp-chip' + (active ? ' is-active' : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };
  wrap.appendChild(chip('Все', ovdStatusSel.size === 0, () => {
    ovdStatusSel = new Set();
    buildOvdStatusFilter(ovdAllRows);
    renderOvdRows(ovdFilteredRows());
  }));
  for (const [st, cnt] of statuses) {
    wrap.appendChild(chip(`${st} · ${cnt}`, ovdStatusSel.has(st), () => {
      if (ovdStatusSel.has(st)) ovdStatusSel.delete(st); else ovdStatusSel.add(st);
      buildOvdStatusFilter(ovdAllRows);
      renderOvdRows(ovdFilteredRows());
    }));
  }
}

function renderOvdRows(rows) {
  ovdShownRows = rows;
  const tbody = $('ovd-rows');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const chkTd = el('td', 'num');
    const cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.dataset.id = String(r.id);
    cbx.dataset.order = String(r.orderNumber);
    cbx.dataset.i = String(i);
    chkTd.appendChild(cbx);
    tr.appendChild(chkTd);
    tr.appendChild(el('td', null, fmtOrderDate(r.orderDate)));
    tr.appendChild(el('td', 'td-order', String(r.orderNumber)));
    tr.appendChild(el('td', 'td-part', r.partNumber || r.number || '—'));
    tr.appendChild(el('td', null, r.client || '—'));
    tr.appendChild(el('td', 'num', fmtMoney(r.quantity)));
    tr.appendChild(el('td', 'num', fmtMoney(r.sum)));
    const st = el('td', null);
    st.appendChild(el('span', 'badge', r.status || ('Код ' + r.statusCode)));
    tr.appendChild(st);
    tr.appendChild(el('td', null, fmtDate(r.plannedDate)));
    const late = el('td', 'num');
    late.appendChild(el('span', 'badge badge-late', `${r.daysLate} дн.`));
    tr.appendChild(late);
    const sentTd = el('td', 'num');
    sentTd.id = 'ovd-sent-cell-' + i;
    sentTd.textContent = ovdRowRequested(r.id) ? fmtDateTime(ovdRowRequested(r.id)) : '—';
    tr.appendChild(sentTd);
    tbody.appendChild(tr);
  });
  syncOvdCheckAll();
  updateOvdSent();
  updateOvdSentCells();
}

let ovdShownRows = [];

// Дата отправки запроса срока для позиции (из актуальных данных отчёта).
function ovdRowRequested(id) {
  if (id == null) return '';
  const src = (reportData && reportData.rows) || [];
  const row = src.find((x) => x.id != null && String(x.id) === String(id));
  return (row && row.requestedDate) || '';
}

// Обновляет столбец «Отправлено» в модалке без переоткрытия окна.
function updateOvdSentCells() {
  const box = document.getElementById('ovd-rows');
  if (!box) return;
  for (let i = 0; i < ovdShownRows.length; i++) {
    const r = ovdShownRows[i];
    const cell = document.getElementById('ovd-sent-cell-' + i);
    if (!cell) continue;
    const req = (r && r.id != null) ? ovdRowRequested(r.id) : '';
    cell.textContent = req ? fmtDateTime(req) : '—';
  }
}

// Показывает в модальном окне дату отправки запроса срока (последнюю по позициям).
function updateOvdSent() {
  const el = document.getElementById('ovd-sent');
  if (!el) return;
  const src = (reportData && reportData.rows) || [];
  const map = new Map(src.map((r) => [String(r.id), r.requestedDate]));
  let latest = '';
  for (const r of ovdShownRows || []) {
    if (!r || r.id == null) continue;
    const d = map.get(String(r.id));
    if (d && (!latest || d > latest)) latest = d;
  }
  el.textContent = latest ? 'Дата отправки запроса срока: ' + fmtDateTime(latest) : '';
}

function collectItemFromRow(r) {
  return {
    positionId: r.id,
    orderNumber: r.orderNumber,
    distributor: r._rawDist || r.distributor,
    number: r.partNumber || r.number || '',
    brand: r.brand || '',
    quantity: r.quantity,
    price: r.price,
    orderDate: r.orderDate,
    plannedDate: r.plannedDate,
    daysLate: r.daysLate,
  };
}

// Мгновенно убирает из текущего отчёта позиции, по которым снят отказ.
function forgetRefused(positionIds) {
  const ids = new Set(positionIds.map((x) => String(x)));
  if (Array.isArray(reportData && reportData.rows)) {
    reportData.rows = reportData.rows.filter((r) => !ids.has(String(r.id)));
  }
  overdueFilteredRows = overdueFilteredRows.filter((r) => !ids.has(String(r.id)));
  ovdShownRows = ovdShownRows.filter((r) => !ids.has(String(r.id)));
  applyFilters();
  if (!document.getElementById('ovd-modal').classList.contains('hidden')) {
    const name = document.getElementById('ovd-title').textContent;
    renderOvdRows(overdueFilteredRows.filter((r) => r.distributor === name));
  }
}

$('ovd-close').addEventListener('click', () => $('ovd-modal').classList.add('hidden'));
$('ovd-modal').addEventListener('click', (e) => {
  if (e.target.id === 'ovd-modal') $('ovd-modal').classList.add('hidden');
});

$('ovd-refusal').addEventListener('click', async () => {
  await apiPoll('/api/report').catch(() => {});
  const checked = Array.from(document.querySelectorAll('#ovd-rows input[type="checkbox"]:checked'));
  const info = $('ovd-info');
  if (!checked.length) {
    info.textContent = 'Выберите позиции';
    return;
  }
  const items = checked.map((cb) => collectItemFromRow(ovdShownRows[Number(cb.dataset.i)]));
  if (!confirm(`Снять в отказ ${items.length} позиций? Это изменит статусы в ABCP.`)) return;
  info.textContent = 'Отправляем…';
  try {
    const data = await api('/api/report/mark-refusal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    info.textContent = data.message || 'Задача принята — выполняется в фоне';
    forgetRefused(items.map((i) => i.positionId));
    if (data.ok) {
      document.querySelectorAll('#ovd-rows input[type="checkbox"]:checked').forEach((cb) => { cb.checked = false; });
      loadReport({ refresh: true });
    }
  } catch (e) {
    info.textContent = e.message;
  }
});

function renderRows(rows) {
  const tbody = $('rows');
  tbody.innerHTML = '';
  $('empty').classList.toggle('hidden', rows.length > 0);

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    const chkTd = el('td', 'num');
    const cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.dataset.id = String(r.id != null ? r.id : '');
    cbx.dataset.order = String(r.orderNumber != null ? r.orderNumber : '');
    cbx.dataset.i = String(i);
    chkTd.appendChild(cbx);
    tr.appendChild(chkTd);
    tr.appendChild(el('td', null, fmtOrderDate(r.orderDate)));
    tr.appendChild(el('td', 'td-order', String(r.orderNumber)));
    tr.appendChild(el('td', null, r.client || '—'));
    tr.appendChild(el('td', null, r.distributor));
    tr.appendChild(el('td', 'num', fmtMoney(r.quantity)));
    tr.appendChild(el('td', 'num', fmtMoney(r.sum)));

    const statusTd = el('td', null);
    const badgeBtn = el('button', 'badge badge-btn', r.status || `Код ${r.statusCode}`);
    badgeBtn.type = 'button';
    badgeBtn.addEventListener('click', () => openStatusHistory(r.id, r.orderNumber));
    statusTd.appendChild(badgeBtn);
    tr.appendChild(statusTd);

    tr.appendChild(el('td', null, fmtDate(r.plannedDate)));

    const lateTd = el('td', 'num');
    lateTd.appendChild(el('span', 'badge badge-late', `${r.daysLate} дн.`));
    tr.appendChild(lateTd);
    const sent = r.requestedDate ? fmtDateTime(r.requestedDate) : '';
    tr.appendChild(el('td', sent ? 'td-sent' : 'td-sent td-muted', sent || '—'));

    tbody.appendChild(tr);
  });
}

// Поставщики с «красивыми» (отображаемыми) названиями — им срок не обновляем:
// у них нет реального маршрута ABCP под этим именем. Список легко расширить.
const TERM_NO_UPDATE = ['Сфера Минск', 'EU'];

/* ---------- Отчёт по отказам ---------- */
/* ---------- Сроки по поставщикам ---------- */
/* ---------- Проценка ---------- */
let prSelectedSuppliers = new Set();
let prAllSuppliers = [];

function updatePrSelected() {
  $('pr-selected').textContent = prSelectedSuppliers.size
    ? `выбрано: ${prSelectedSuppliers.size}`
    : 'поставщики не выбраны';
}

async function loadPricing() {
  const spinner = $('pr-spinner');
  const errBox = $('pr-error');
  errBox.classList.add('hidden');
  const number = $('pr-number').value.trim();
  if (!number) {
    errBox.textContent = 'Введите артикул';
    errBox.classList.remove('hidden');
    return;
  }
  if (!prSelectedSuppliers.size) {
    errBox.textContent = 'Выберите хотя бы одного поставщика';
    errBox.classList.remove('hidden');
    return;
  }
  try {
    spinner.classList.remove('hidden');
    const suppliers = Array.from(prSelectedSuppliers).join(',');
    const brand = $('pr-brand').value.trim();
    const url = '/api/procenka?suppliers=' + encodeURIComponent(suppliers) +
      '&number=' + encodeURIComponent(number) +
      (brand ? '&brand=' + encodeURIComponent(brand) : '');
    const data = await api(url);
    renderPricing(data);
    $('pr-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    $('pr-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderPricing(d) {
  $('pr-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  const arts = d.articles || [];
  const recap = $('pr-recap');
  if (arts.length) {
    const parts = arts.map((a) => {
      const found = (a.numFound != null ? a.numFound : (a.offers || []).filter((o) => o.price != null).length);
      return `${a.number}${found === 0 ? ' — предложений не найдено' : ''}`;
    });
    recap.textContent = `Артикул(ы): ${parts.join(', ')}`;
  } else {
    recap.textContent = '';
  }
  const tb = $('pr-articles');
  tb.innerHTML = '';
  for (const a of arts) {
    const prices = (a.offers || [])
      .filter((o) => o.price != null && Number.isFinite(o.price))
      .map((o) => ({ supplier: o.supplier, price: Number(o.price) }));
  const minPrice = prices.length ? prices.reduce((m, p) => Math.min(m, Number(p.price) || Infinity), Infinity) : null;
    for (const o of a.offers || []) {
      const price = Number(o.price);
      const has = Number.isFinite(price) && price > 0;
    const tr = document.createElement('tr');
      tr.appendChild(el('td', 'td-part', a.number));
      tr.appendChild(el('td', null, o.supplier));
      tr.appendChild(el('td', 'num', has ? `${fmtMoney(price)} ₽` : '—'));
      const isMin = has && minPrice != null && Math.abs(price - minPrice) < 1e-9;
      const dev = has && minPrice != null ? ((price - minPrice) / minPrice) * 100 : null;
      tr.appendChild(el('td', 'num pr-cheaper', isMin ? 'база (мин.)' : (dev != null && dev < 0 ? `${dev.toFixed(1)}%` : '—')));
      tr.appendChild(el('td', 'num pr-more', dev != null && dev > 0 ? `+${dev.toFixed(1)}%` : (isMin ? '0%' : '—')));
      tb.appendChild(tr);
    }
  }
}

async function openPrSupplierModal() {
  try {
    const data = await apiPoll('/api/suppliers');
    const list = data.suppliers || [];
    prAllSuppliers = list
      .map((x) => ({ id: x.distributorId != null ? String(x.distributorId) : x.name, name: dispSupplier(x.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    $('pr-supplier-search').value = '';
    renderPrSupplierList('');
    $('pr-supplier-modal').classList.remove('hidden');
  } catch (e) {
    const errBox = $('pr-error');
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
}

function renderPrSupplierList(query) {
  const list = $('pr-supplier-list');
  list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const items = prAllSuppliers.filter((x) => !q || x.name.toLowerCase().includes(q));
  for (const it of items) {
    const label = el('label', 'status-check');
    const cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.checked = prSelectedSuppliers.has(it.id);
    cbx.addEventListener('change', () => {
      if (cbx.checked) prSelectedSuppliers.add(it.id);
      else prSelectedSuppliers.delete(it.id);
      updatePrSelected();
    });
    label.appendChild(cbx);
    label.appendChild(el('span', 'sc-label', it.name));
    list.appendChild(label);
  }
}

$('btn-refresh-pricing').addEventListener('click', () => {
  if (!prSelectedSuppliers.size) {
    const errBox = $('pr-error');
    errBox.textContent = 'Выберите хотя бы одного поставщика';
    errBox.classList.remove('hidden');
    return;
  }
  loadPricing();
});
$('btn-choose-pr-suppliers').addEventListener('click', openPrSupplierModal);
$('pr-supplier-close').addEventListener('click', () => $('pr-supplier-modal').classList.add('hidden'));
$('pr-supplier-modal').addEventListener('click', (e) => {
  if (e.target.id === 'pr-supplier-modal') $('pr-supplier-modal').classList.add('hidden');
});
$('pr-supplier-search').addEventListener('input', () => renderPrSupplierList($('pr-supplier-search').value));
$('pr-supplier-apply').addEventListener('click', () => {
  updatePrSelected();
  $('pr-supplier-modal').classList.add('hidden');
  if (prSelectedSuppliers.size) loadPricing();
});

/* ---------- Сроки по поставщикам ---------- */
let termsData = null;
let shipPollTimer = null;
let routePollTimer = null;
let termsScaleMax = 20;

async function pollShipProgress() {
  try {
    const p = await api('/api/ship-progress');
    const total = Math.max(1, p.total || 0);
    const done = Math.min(p.done || 0, total);
    const pct = Math.round((done / total) * 100);
    $('ship-percent').textContent = `${pct}%`;
    $('ship-bar').style.width = `${pct}%`;
    if (done >= total) {
      clearInterval(shipPollTimer);
      $('ship-progress-wrap').classList.add('hidden');
    }
  } catch (_e) {
    /* ignore */
  }
}

async function loadTerms({ refresh } = {}) {
  const spinner = $('terms-spinner');
  const errBox = $('terms-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    termsData = await apiPoll('/api/supplier-terms', { refresh });
    renameSupplierData(termsData);
    renderTerms();
    $('terms-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    $('terms-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderTerms() {
  const d = termsData;
  clearInterval(shipPollTimer);
  clearInterval(routePollTimer);
  const wrap = $('ship-progress-wrap');
  if (d.loadingShip) {
    if (d.shipProgress) {
      const pct = Math.round((d.shipProgress.done / Math.max(1, d.shipProgress.total)) * 100);
      $('ship-percent').textContent = `${pct}%`;
      $('ship-bar').style.width = `${pct}%`;
    }
    wrap.classList.remove('hidden');
    shipPollTimer = setInterval(pollShipProgress, 2000);
  } else {
    wrap.classList.add('hidden');
  }
  // Пока фон ещё пересчитывает реальные сроки маршрутов (routeLoading=true),
  // автоматически дочитываем, чтобы показать актуальную картину после завершения.
  if (d.routeLoading) {
    const note = $('terms-route-note');
    if (note) note.classList.remove('hidden');
    routePollTimer = setInterval(async () => {
      try {
        const r = await apiPoll('/api/supplier-terms', { refresh: false });
        if (!(r && r.routeLoading)) {
          clearInterval(routePollTimer);
          await loadTerms({ refresh: false });
        }
      } catch (_e) { /* повторяем */ }
    }, 5000);
  } else {
    const note = $('terms-route-note');
    if (note) note.classList.add('hidden');
  }
  $('terms-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('terms-orders').textContent = `Заказов обработано: ${fmtMoney(d.ordersCount)}`;
  const suppliers = d.suppliers || [];
  // Онлайн-поставщик определяем и по маркеру «[online]» в имени — так точнее, чем
  // только по полю type (ABCP помечает онлайн-поставщиков этим маркером).
  const isOnlineName = (n) => /\[online\]/i.test(String(n || ''));
  const isOnline = (s) => s.type === 'online' || isOnlineName(s.name);
  const price = suppliers.filter((s) => !isOnline(s));
  const online = suppliers.filter((s) => isOnline(s));
  // Прайсовые разбиваем на 3 блока по Итогу: быстрее / укладывается / нарушает.
  const termCat = (s) => {
    if (s.realCover == null || s.termMax == null) return 'ok';
    if (s.termMin != null && s.realCover < s.termMin) return 'fast';
    return s.realCover <= s.termMax ? 'ok' : 'bad';
  };
  // Сводка по статусам + верхняя граница общей шкалы.
  const cats = { fast: 0, ok: 0, bad: 0 };
  for (const s of price) cats[termCat(s)]++;
  $('t-stat-fast').textContent = cats.fast;
  $('t-stat-ok').textContent = cats.ok;
  $('t-stat-bad').textContent = cats.bad;
  $('t-stat-online').textContent = online.length;
  let scm = 0;
  for (const s of suppliers) { const mm = Number(s.termMax); if (Number.isFinite(mm) && mm > scm) scm = mm; }
  termsScaleMax = scm || 20;
  renderTermsTable($('terms-fast-rows'), price.filter((s) => termCat(s) === 'fast'), { noUpdate: false });
  renderTermsTable($('terms-ok-rows'), price.filter((s) => termCat(s) === 'ok'), { noUpdate: false });
  renderTermsTable($('terms-bad-rows'), price.filter((s) => termCat(s) === 'bad'), { noUpdate: false });
  renderTermsTable($('terms-online-rows'), online, { noUpdate: true });
}

function renderTermsTable(tbody, list, { noUpdate = false } = {}) {
  tbody.innerHTML = '';
  const fmtTerm = (v) => (v == null ? '—' : String(v));
  for (const s of list) {
    const online = s.type === 'online' || /\[online\]/i.test(String(s.name || ''));
    const hasPlan = s.termMin != null && s.termMax != null && s.realCover != null;
    const cat = !hasPlan
      ? { label: '—', cls: 'term-mut', dot: '#3d4a5b' }
      : s.realCover < s.termMin
        ? { label: 'быстрее', cls: 'term-fast', dot: 'var(--gold)' }
        : s.realCover <= s.termMax
          ? { label: 'укладывается', cls: 'term-ok', dot: 'var(--green)' }
          : { label: 'нарушает', cls: 'term-bad', dot: 'var(--red)' };
    const tr = document.createElement('tr');
    // Поставщик с цветной точкой по итогу.
    const nmTd = el('td', null);
    const nmWrap = el('div', 'tterm-sup');
    const dot = el('span', 'tterm-dot');
    dot.style.background = cat.dot;
    dot.style.boxShadow = '0 0 6px ' + cat.dot;
    nmWrap.appendChild(dot);
    nmWrap.appendChild(el('span', null, s.name));
    nmTd.appendChild(nmWrap);
    tr.appendChild(nmTd);
    tr.appendChild(el('td', null, online ? 'Онлайн' : 'Прайс'));
    tr.appendChild(el('td', 'num', fmtTerm(s.termMin)));
    tr.appendChild(el('td', 'num', fmtTerm(s.termMax)));
    // Реальный (80%) — с цветом по итогу.
    const realTd = el('td', 'num');
    const realV = el('span', 'tterm-real');
    realV.style.color = cat.dot;
    realV.textContent = fmtTerm(s.realCover);
    realTd.appendChild(realV);
    tr.appendChild(realTd);
    // Итог-бейдж.
    const badgeTd = el('td', null);
    badgeTd.appendChild(el('span', 'badge ' + cat.cls, cat.label));
    tr.appendChild(badgeTd);
    // Обновить (только прайсовым с реальным сроком).
    const actTd = el('td', null);
    if (!noUpdate && !online && s.realCover != null && !TERM_NO_UPDATE.includes(s.name)) {
      const b = el('button', 'btn btn-sm', 'Обновить срок');
      b.type = 'button';
      b.title = `Записать реальный срок ${s.realCover} дн. в максимальный срок ABCP`;
      b.addEventListener('click', () => updateSupplierTerms([{ supplier: s.name, realDays: s.realCover, minDays: s.termMin }]));
      actTd.appendChild(b);
    } else {
      actTd.appendChild(el('span', 'field-hint', '—'));
    }
    tr.appendChild(actTd);
    tbody.appendChild(tr);
  }
}

$('btn-refresh-terms').addEventListener('click', () => loadTerms({ refresh: true }));
$('btn-clear-terms').addEventListener('click', async () => {
  const errBox = $('terms-error');
  errBox.classList.add('hidden');
  try {
    await api('/api/supplier-terms/clear-cache', { method: 'POST' });
    await loadTerms({ refresh: true });
  } catch (e) {
    errBox.textContent = e.message || 'Не удалось очистить кэш';
    errBox.classList.remove('hidden');
  }
});

// Запись реального расчётного срока (в днях) в МАКСИМАЛЬНЫЙ срок ABCP (в часах): дни × 24.
async function updateSupplierTerms(items) {
  const info = $('terms-action');
  info.textContent = 'Обновляем сроки в ABCP…';
  try {
    const data = await api('/api/supplier-terms/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (data && data.accepted) {
      info.textContent = data.message || 'Задача принята — обновление сроков в фоне. Итог — в Логах → Изменение срока.';
      pollTermsAfterUpdate();
      return;
    }
    const res = (data && data.results) || [];
    const ok = res.filter((r) => r.ok).length;
    const bad = res.length - ok;
    info.textContent = bad
      ? `Обновлено: ${ok} из ${res.length} (ошибок: ${bad}). Пересчитываем сроки…`
      : `Обновлено сроков: ${ok}. Пересчитываем…`;
    await loadTerms({ refresh: true });
  } catch (e) {
    info.textContent = e.message || 'Не удалось обновить сроки';
  }
}

// После отправки задачи на обновление сроков опрашиваем сервер, пока фоновое
// обновление идёт (routeLoading=true), затем перечитываем сроки — колонка
// «Срок макс» при этом уже отразит записанный в ABCP максимум маршрута.
function pollTermsAfterUpdate() {
  let tries = 0;
  const timer = setInterval(async () => {
    tries += 1;
    try {
      const d = await apiPoll('/api/supplier-terms', { refresh: false });
      if (!(d && d.routeLoading) || tries > 40) {
        clearInterval(timer);
        await loadTerms({ refresh: false });
        const info = $('terms-action');
        if (info) info.textContent += ' Значения «Срок макс/мин» обновлены.';
      }
    } catch (_e) { /* повторяем до готовности */ }
  }, 5000);
}

$('btn-update-all-terms').addEventListener('click', async () => {
  const list = ((termsData && termsData.suppliers) || [])
    .filter((s) => s.type !== 'online' && s.realCover != null && !TERM_NO_UPDATE.includes(s.name));
  if (!list.length) {
    $('terms-action').textContent = 'Нет поставщиков с реальным сроком';
    return;
  }
  updateSupplierTerms(list.map((s) => ({ supplier: s.name, realDays: s.realCover, minDays: s.termMin })));
});

/* ---------- Отчёт по отказам ---------- */
/* ---------- Дашборд ---------- */
  const fmtDay = (s) => {
    if (!s) return s;
    if (s.length >= 10) return `${s.slice(8, 10)}.${s.slice(5, 7)}`; // ДД.ММ
    if (s.length === 7) return `${s.slice(5, 7)}.${s.slice(0, 4)}`; // YYYY-MM -> ММ.ГГГГ
    return s;
  };
const shortMoney = (n) => {
  const v = Math.round(n || 0);
  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}м`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}к`;
  return String(v);
};

async function loadDashboard({ refresh } = {}) {
  const spinner = $('dash-spinner');
  const errBox = $('dash-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    fillDashboardPeriod();
    dashboardData = await apiPoll('/api/dashboard', { refresh });
    renderDashboard();
    $('dash-body').classList.remove('hidden');
  } catch (e) {
    // Диагностика: показываем полный стек, чтобы найти место клиентской рекурсии.
    if (e && e.fromServer) {
      errBox.textContent = 'Ошибка сервера: ' + e.message;
      errBox.style.whiteSpace = '';
    } else if (e && e.stack) {
      errBox.textContent = e.stack;
      errBox.style.whiteSpace = 'pre-wrap';
      errBox.style.fontSize = '12px';
      errBox.style.textAlign = 'left';
    } else {
      errBox.textContent = (e && e.message) || String(e);
      errBox.style.whiteSpace = '';
    }
    if (typeof console !== 'undefined' && console.error) console.error('dashboard load error', e && e.stack);
    errBox.classList.remove('hidden');
    $('dash-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function fillDashboardPeriod() {
  initPeriodControl('dash', 'dashPeriod', () => loadDashboard({ refresh: true }));
}

/* ---------- Анализ заказов клиентов ---------- */
let caData = null;
const fmtPct = (v) => (v == null ? '' : v + '%');

async function loadClientAnalysis({ refresh } = {}) {
  const spinner = $('ca-spinner');
  const errBox = $('ca-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    initPeriodControl('ca', 'caPeriod', () => loadClientAnalysis({ refresh: true }));
    caData = await apiPoll('/api/client-analysis', { refresh });
    renderClientAnalysis();
    $('ca-body').classList.remove('hidden');
  } catch (e) {
    if (e && e.fromServer) {
      errBox.textContent = 'Ошибка сервера: ' + e.message;
      errBox.style.whiteSpace = '';
    } else if (e && e.stack) {
      errBox.textContent = e.stack;
      errBox.style.whiteSpace = 'pre-wrap';
      errBox.style.fontSize = '12px';
      errBox.style.textAlign = 'left';
    } else {
      errBox.textContent = (e && e.message) || String(e);
      errBox.style.whiteSpace = '';
    }
    errBox.classList.remove('hidden');
    $('ca-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function renderClientAnalysis() {
  const d = caData;
  const t = d.totals || {};
  $('ca-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('ca-summary').textContent =
    `Клиентов: ${(d.clients || []).length} · Сумма выданных: ${fmtMoney(t.sum)} ₽ · Маржа: ${fmtMoney(t.margin)} ₽ (${fmtPct(t.marginPct)})`;
  const tb = $('ca-rows');
  tb.innerHTML = '';
  for (const c of d.clients || []) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'td-order', c.client));
    tr.appendChild(el('td', 'num', `${fmtMoney(c.sum)} ₽`));
    tr.appendChild(el('td', 'num', `${fmtMoney(c.cost)} ₽`));
    tr.appendChild(el('td', 'num', `${fmtMoney(c.margin)} ₽`));
    tr.appendChild(el('td', 'num', fmtPct(c.marginPct)));
    tr.appendChild(el('td', 'num', String(c.orderCount)));
    tr.appendChild(el('td', 'num', String(c.qty)));
    tb.appendChild(tr);
  }
  const tf = $('ca-totals');
  tf.innerHTML = '';
  const tr = document.createElement('tr');
  tr.appendChild(el('td', 'td-order', 'ИТОГ'));
  tr.appendChild(el('td', 'num', `${fmtMoney(t.sum)} ₽`));
  tr.appendChild(el('td', 'num', `${fmtMoney(t.cost)} ₽`));
  tr.appendChild(el('td', 'num', `${fmtMoney(t.margin)} ₽`));
  tr.appendChild(el('td', 'num', fmtPct(t.marginPct)));
  tr.appendChild(el('td', 'num', String(t.orderCount)));
  tr.appendChild(el('td', 'num', String(t.qty)));
  tf.appendChild(tr);
}

$('btn-refresh-ca').addEventListener('click', () => loadClientAnalysis({ refresh: true }));

/* ---------- Отчет Европа ---------- */
let euData = null;
async function loadEurope({ refresh } = {}) {
  const errBox = $('eu-error');
  const spinner = $('eu-spinner');
  const body = $('eu-body');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  initPeriodControl('eu', 'euPeriod', () => loadEurope({ refresh: true }));
  try {
    const data = await apiPoll('/api/europe', { refresh });
    euData = data;
    renderEurope();
    spinner.classList.add('hidden');
    body.classList.remove('hidden');
  } catch (e) {
    spinner.classList.add('hidden');
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
}

function renderEurope() {
  const d = euData || {};
  $('eu-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  const ep = d.effPeriod || {};
  const per = `${d.start || ep.start || '—'} — ${d.end || ep.end || '—'}`;
  $('eu-summary').textContent = `Поставщик: EU · Период (90 дней): ${per}`;
  const tb = $('eu-rows');
  tb.innerHTML = '';
  const brands = Array.isArray(d.brands) ? d.brands : [];
  const t = d.totals || {};
  const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '0');
  const fmtD = (v) => (v == null ? '—' : Math.ceil(v)); // срок округляем в большую сторону до целого дня
  const pctCls = (p) => (p >= 20 ? 'e-bad' : p >= 5 ? 'e-warn' : 'e-ok');
  for (const b of brands) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', null, b.brand));
    tr.appendChild(el('td', 'num', fmtN(b.orders)));
    tr.appendChild(el('td', 'num', fmtN(b.qty)));
    tr.appendChild(el('td', 'num', fmtMoney(b.sum) + ' ₽'));
    tr.appendChild(el('td', 'num e-ok', fmtMoney(b.issuedSum) + ' ₽'));
    tr.appendChild(el('td', 'num ' + pctCls(b.refusalSumPct), b.refusalSumPct + '%'));
    tr.appendChild(el('td', 'num ' + (b.refusedSum > 0 ? 'e-warn' : 'e-muted'), fmtMoney(b.refusedSum) + ' ₽'));
    tr.appendChild(el('td', 'num ' + pctCls(b.refusalQtyPct), b.refusalQtyPct + '%'));
    tr.appendChild(el('td', 'num ' + (b.avgDays == null ? 'e-muted' : ''), fmtD(b.avgDays)));
    tb.appendChild(tr);
  }
  const tf = $('eu-totals');
  tf.innerHTML = '';
  const tr = document.createElement('tr');
  tr.appendChild(el('td', null, 'Итог'));
  tr.appendChild(el('td', 'num', fmtN(t.orders)));
  tr.appendChild(el('td', 'num', fmtN(t.qty)));
  tr.appendChild(el('td', 'num', fmtMoney(t.sum) + ' ₽'));
  tr.appendChild(el('td', 'num', fmtMoney(t.issuedSum) + ' ₽'));
  tr.appendChild(el('td', 'num', t.refusalSumPct + '%'));
  tr.appendChild(el('td', 'num', fmtMoney(t.refusedSum) + ' ₽'));
  tr.appendChild(el('td', 'num', t.refusalQtyPct + '%'));
  tr.appendChild(el('td', 'num', fmtD(t.avgDays)));
  tf.appendChild(tr);
}

$('btn-refresh-eu').addEventListener('click', () => loadEurope({ refresh: true }));

/* ---------- Конфигуратор сроков поставки для клиента ---------- */
let ccData = null;
const CC_SEL_KEY = 'cc_selected';
function ccGetSel() { try { return JSON.parse(localStorage.getItem(CC_SEL_KEY) || '[]') || []; } catch (_e) { return []; } }
function ccSetSel(a) { try { localStorage.setItem(CC_SEL_KEY, JSON.stringify(a)); } catch (_e) { /* ignore */ } }

async function loadClientConfig({ refresh } = {}) {
  const errBox = $('cc-error');
  const spinner = $('cc-spinner');
  const body = $('cc-body');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  const sel = ccGetSel();
  const qs = sel.length ? ('?suppliers=' + encodeURIComponent(sel.join(','))) : '';
  try {
    const data = await apiPoll('/api/client-config' + qs, { refresh });
    ccData = data;
    renderClientConfig();
    spinner.classList.add('hidden');
    body.classList.remove('hidden');
  } catch (e) {
    spinner.classList.add('hidden');
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
}

function renderClientConfig() {
  const d = ccData || {};
  $('cc-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('cc-summary').textContent = `Период (30 дней): ${d.start || '—'} — ${d.end || '—'}`;
  const tb = $('cc-rows');
  tb.innerHTML = '';
  const rows = Array.isArray(d.suppliers) ? d.suppliers : [];
  const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '0');
  const fmtD = (v) => (v == null ? '—' : Math.ceil(v));
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', null, r.supplier));
    tr.appendChild(el('td', 'num', fmtN(r.orders)));
    tr.appendChild(el('td', 'num', fmtN(r.qty)));
    // Колонки: Мин (минимальный реальный) и Макс (= среднее, бывшая «СР.»).
    tr.appendChild(el('td', 'num', fmtD(r.minDays)));
    tr.appendChild(el('td', 'num', fmtD(r.avgDays))); // в «Макс» показываем среднее
    tb.appendChild(tr);
  }
  const t = d.total || {};
  const tf = $('cc-totals');
  tf.innerHTML = '';
  const tr = document.createElement('tr');
  tr.appendChild(el('td', null, 'Итог'));
  tr.appendChild(el('td', 'num', ''));
  tr.appendChild(el('td', 'num', ''));
  // Итог: Мин (минимум по всем) и Макс (= максимальный срок среди выбранных поставщиков,
  // «по большему» — ведь поставщики уходят клиенту одним прайсом).
  const wd = (d) => (d == null ? null : Math.ceil((Number(d) * 5) / 7));
  let big = null;
  for (const r of rows) if (r.avgDays != null) big = (big == null ? r.avgDays : Math.max(big, r.avgDays));
  const calDays = fmtD(big);
  const wdVal = wd(big);
  tr.appendChild(el('td', 'num', fmtD(t.minDays)));
  tr.appendChild(el('td', 'num', calDays + (wdVal != null ? (' (' + wdVal + ' рд)') : '')));
  tf.appendChild(tr);
}

let ccAvail = [];
let ccSelSet = new Set();
let ccQuery = '';
function renderCcList() {
  const list = $('cc-list');
  list.innerHTML = '';
  const q = ccQuery.trim().toLowerCase();
  const filtered = q ? ccAvail.filter((s) => String(s).toLowerCase().includes(q)) : ccAvail;
  for (const s of filtered) {
    const tr = document.createElement('tr');
    const tdC = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = s;
    cb.checked = ccSelSet.has(String(s).toLowerCase());
    cb.addEventListener('change', () => {
      const k = String(s).toLowerCase();
      if (cb.checked) ccSelSet.add(k); else ccSelSet.delete(k);
    });
    tdC.appendChild(cb);
    const tdN = el('td', null, s);
    tr.appendChild(tdC);
    tr.appendChild(tdN);
    list.appendChild(tr);
  }
}
function openCcModal() {
  ccAvail = (ccData && ccData.availableSuppliers) || [];
  ccSelSet = new Set(ccGetSel().map((s) => String(s).toLowerCase()));
  ccQuery = '';
  const s = $('cc-search'); if (s) s.value = '';
  renderCcList();
  $('cc-suppliers-modal').classList.remove('hidden');
}
function closeCcModal() { $('cc-suppliers-modal').classList.add('hidden'); }

$('cc-suppliers-btn').addEventListener('click', openCcModal);
$('cc-modal-close').addEventListener('click', closeCcModal);
$('cc-suppliers-modal').addEventListener('click', (e) => { if (e.target.id === 'cc-suppliers-modal') closeCcModal(); });
$('cc-search').addEventListener('input', (e) => { ccQuery = e.target.value; renderCcList(); });
$('cc-select-all').addEventListener('click', () => { ccAvail.forEach((s) => ccSelSet.add(String(s).toLowerCase())); renderCcList(); });
$('cc-select-none').addEventListener('click', () => { ccSelSet.clear(); renderCcList(); });
$('cc-save').addEventListener('click', () => {
  ccSetSel(Array.from(ccSelSet));
  closeCcModal();
  loadClientConfig({ refresh: false });
});
$('btn-refresh-cc').addEventListener('click', () => loadClientConfig({ refresh: true }));

/* ---------- Ручной автомат ---------- */
let maData = null;
let maSelected = [];

async function loadManualAutomat({ refresh } = {}) {
  const spinner = $('ma-spinner');
  const errBox = $('ma-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    // При свежей загрузке страницы настройки могли ещё не подтянуться —
    // загружаем их здесь, чтобы флажок авто-смены отражал сохранённое значение.
    if (!publicSettings) {
      try {
        const sdata = await api('/api/settings');
        publicSettings = (sdata && sdata.settings) || null;
      } catch (_e) { /* настройки подтянутся позже */ }
    }
    maData = await apiPoll('/api/manual-automat', { refresh });
    maSelected = (publicSettings && Array.isArray(publicSettings.manualAutomatSuppliers)
      ? publicSettings.manualAutomatSuppliers
      : []).map((s) => String(s));
    const autoEl = document.getElementById('ma-auto');
    if (autoEl) autoEl.checked = !!(publicSettings && publicSettings.manualAutomatAuto);
    renderManualAutomat();
    $('ma-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = (e && e.message) || String(e);
    errBox.classList.remove('hidden');
    $('ma-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

$('ma-auto').addEventListener('change', async () => {
  const checked = $('ma-auto').checked;
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualAutomatAuto: checked }),
    });
    if (data && data.settings) publicSettings = data.settings;
  } catch (e) {
    alert('Не удалось сохранить настройку: ' + e.message);
    $('ma-auto').checked = !checked;
  }
});

function renderManualAutomat() {
  const d = maData;
  $('ma-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')} · Заказов в наборе: ${d.ordersCount}`;
  renderSupplierDropdown(d.availableSuppliers || []);
  const rows = d.rows || [];
  // «Сумма/штук/поз/заказов сегодня» считаем из того же набора, что и «Заказы клиентов»
  // (todayTotals), чтобы суммы совпадали — а не из накопленного счётчика.
  renderAutomatStats({ today: d.todayTotals || {} });
  const tb = $('ma-rows');
  tb.innerHTML = '';
  for (const s of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'td-order', `${s.orderNumber} ${s.orderDate}`));
    tr.appendChild(el('td', null, s.client));
    tr.appendChild(el('td', 'td-order', s.supplier));
    tr.appendChild(el('td', null, `${s.brand} ${s.code}`.trim()));
    tr.appendChild(el('td', 'td-order', s.description));
    tr.appendChild(el('td', 'num', String(s.qty)));
    tr.appendChild(el('td', 'num', `${fmtMoney(s.price)} ₽`));
    tr.appendChild(el('td', 'num', `${fmtMoney(s.priceIn)} ₽`));
    tr.appendChild(el('td', 'num', `${fmtMoney(s.margin)} ₽ (${s.marginPct}%)`));
    tr.appendChild(el('td', 'num', `${fmtMoney(s.sum)} ₽`));
    tr.appendChild(el('td', 'num', `${fmtMoney(s.sumIn)} ₽`));
    const statusTd = el('td', null, s.status);
    const b = el('button', 'btn btn-sm', '→ Заказан');
    b.type = 'button';
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/manual-automat/set-ordered', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ positionId: s.positionId, orderNumber: s.orderNumber }] }),
        });
        await loadManualAutomat({ refresh: true });
      } catch (e) {
        alert('Ошибка смены статуса: ' + e.message);
      } finally {
        b.disabled = false;
      }
    });
    statusTd.appendChild(b);
    tr.appendChild(statusTd);
    tb.appendChild(tr);
  }
}

// Отрисовка накопленной статистики «Ручного автомата» (отправлено сегодня).
function renderAutomatStats(st) {
  const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '0');
  const elId = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  elId('ma-st-today-pos', fmtN(st.today && st.today.positions));
  elId('ma-st-today-qty', fmtN(st.today && st.today.qty));
  elId('ma-st-today-sum', fmtMoney(st.today && st.today.sum) + ' ₽');
  elId('ma-st-today-orders', fmtN(st.today && st.today.orders));
}

// Выпадающий список поставщиков (все не-онлайн) с поиском и мультивыбором.
function renderSupplierDropdown(suppliers) {
  const list = $('ma-suppliers-list');
  if (!list) return;
  const selectedSet = new Set(maSelected);
  const q = ($('ma-supplier-search') ? $('ma-supplier-search').value : '').trim().toLowerCase();
  list.innerHTML = '';
  suppliers.filter((s) => !q || String(s).toLowerCase().includes(q)).forEach((sup) => {
    const label = document.createElement('label');
    label.className = 'checkbox-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    // пустой выбор = показать всех (галочки по умолчанию стоят)
    cb.checked = selectedSet.size ? selectedSet.has(sup) : true;
    cb.addEventListener('change', () => toggleSupplierDraft(sup, cb.checked));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + sup));
    list.appendChild(label);
  });
  if (!list.children.length) list.appendChild(el('div', 'empty', 'Не найдено'));
  updateSupplierBtnLabel();
  const cnt = document.getElementById('ma-suppliers-count');
  if (cnt) cnt.innerHTML = selectedSet.size
    ? `Выбрано: <b>${selectedSet.size}</b>`
    : 'Показаны <b>все</b> поставщики';
}

let maDraft = [];
function toggleSupplierDraft(sup, checked) {
  if (checked) { if (!maDraft.includes(sup)) maDraft.push(sup); }
  else maDraft = maDraft.filter((x) => x !== sup);
}
function updateSupplierBtnLabel() {
  const btn = $('ma-supplier-btn');
  if (btn) btn.textContent = `Поставщики: ${maSelected.length ? maSelected.length : 'все'}`;
}
function openSupplierModal() {
  maDraft = maSelected.slice();
  if ($('ma-supplier-search')) $('ma-supplier-search').value = '';
  if (maData) renderSupplierDropdown(maData.availableSuppliers || []);
  else renderSupplierDropdown([]);
  $('ma-suppliers-modal').classList.remove('hidden');
}
function closeSupplierModal() { $('ma-suppliers-modal').classList.add('hidden'); }

$('ma-supplier-btn').addEventListener('click', openSupplierModal);
$('ma-suppliers-close').addEventListener('click', closeSupplierModal);
$('ma-suppliers-modal').addEventListener('click', (e) => { if (e.target.id === 'ma-suppliers-modal') closeSupplierModal(); });

// «Заказы клиентов»: сводка по клиентам из строк «Ручного автомата».
function openClientsModal() {
  const rows = (maData && maData.rows) || [];
  // Предпочитаем серверную сводку (по всем статусам за сегодня) — она не пустеет
  // после отправки позиций. Фолбэк — агрегация по текущим строкам.
  let list = Array.isArray(maData && maData.clients) ? maData.clients.map((c) => ({ ...c })) : null;
  if (!list) {
    const byClient = new Map();
    for (const r of rows) {
      const name = r.client || '—';
      if (!byClient.has(name)) byClient.set(name, { orders: new Set(), qty: 0, sum: 0, margin: 0 });
      const c = byClient.get(name);
      c.orders.add(String(r.orderNumber));
      c.qty += r.qty || 0;
      c.sum += r.sum || 0;
      c.margin += r.margin || 0;
    }
    list = Array.from(byClient.entries())
      .map(([name, c]) => ({ client: name, orders: c.orders.size, qty: c.qty, sum: c.sum, margin: c.margin }))
      .sort((a, b) => b.sum - a.sum);
  }
  const tb = $('ma-clients-rows');
  tb.innerHTML = '';
  const fmtN = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('ru-RU') : '0');
  const total = { orders: 0, qty: 0, sum: 0, margin: 0 };
  if (!list.length) {
    const tr = el('tr');
    const td = el('td', 'td-order', 'Нет заказов в списке');
    td.colSpan = 5;
    tr.appendChild(td);
    tb.appendChild(tr);
  } else {
    for (const c of list) {
      const tr = el('tr');
      tr.appendChild(el('td', null, c.client || c.name || '—'));
      tr.appendChild(el('td', 'num', fmtN(c.orders)));
      tr.appendChild(el('td', 'num', fmtN(c.qty)));
      tr.appendChild(el('td', 'num', fmtMoney(c.sum) + ' ₽'));
      tr.appendChild(el('td', 'num', fmtMoney(c.margin) + ' ₽'));
      tr.appendChild(el('td', 'num', (Number.isFinite(c.marginPct) ? c.marginPct : (c.sum ? Math.round((c.margin / c.sum) * 1000) / 10 : 0)) + '%'));
      tb.appendChild(tr);
      total.orders += c.orders || 0;
      total.qty += c.qty || 0;
      total.sum += c.sum || 0;
      total.margin += c.margin || 0;
    }
  }
  const elId = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  $('ma-clients-total-orders').textContent = fmtN(total.orders);
  $('ma-clients-total-qty').textContent = fmtN(total.qty);
  $('ma-clients-total-sum').textContent = fmtMoney(total.sum) + ' ₽';
  $('ma-clients-total-margin').textContent = fmtMoney(total.margin) + ' ₽';
  elId('ma-clients-total-marginpct', (total.sum ? Math.round((total.margin / total.sum) * 1000) / 10 : 0) + '%');
  $('ma-clients-modal').classList.remove('hidden');
}
function closeClientsModal() { $('ma-clients-modal').classList.add('hidden'); }

$('btn-clients-ma').addEventListener('click', openClientsModal);
$('ma-clients-close').addEventListener('click', closeClientsModal);
$('ma-clients-modal').addEventListener('click', (e) => { if (e.target.id === 'ma-clients-modal') closeClientsModal(); });
$('ma-supplier-search').addEventListener('input', () => {
  if (maData) renderSupplierDropdown(maData.availableSuppliers || []);
});
$('ma-suppliers-save').addEventListener('click', async () => {
  maSelected = maDraft.map((s) => String(s));
  closeSupplierModal();
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualAutomatSuppliers: maSelected }),
    });
    if (data && data.settings) publicSettings = data.settings;
    await loadManualAutomat({ refresh: true });
  } catch (e) {
    alert('Не удалось сохранить выбор поставщиков: ' + e.message);
  }
});

// Массовая смена статуса «Заказан» по всем показанным позициям отчёта.
$('btn-ordered-all').addEventListener('click', async () => {
  const rows = (maData && maData.rows) || [];
  if (!rows.length) { alert('Нет позиций в списке'); return; }
  if (!confirm(`Отметить статус «Заказан» для всех ${rows.length} позиций в списке?`)) return;
  try {
    const r = await api('/api/manual-automat/set-ordered', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: rows.map((x) => ({ positionId: x.positionId, orderNumber: x.orderNumber })) }),
    });
    await loadManualAutomat({ refresh: true });
    alert((r && r.message) || 'Готово');
  } catch (e) {
    alert('Ошибка: ' + e.message);
  }
});

// Постоянное автообновление «Ручного автомата» (актуальные данные из ABCP).
setInterval(() => {
  const active = document.querySelector('.tab.is-active');
  if (active && active.dataset.tab === 'manual-automat') loadManualAutomat({ refresh: true });
}, 60 * 1000);

async function saveManualAutomatSelection(sup, checked) {
  const next = new Set(maSelected);
  if (checked) next.add(sup); else next.delete(sup);
  maSelected = Array.from(next);
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manualAutomatSuppliers: maSelected }),
    });
    if (data && data.settings) publicSettings = data.settings;
    await loadManualAutomat({ refresh: true });
  } catch (e) {
    alert('Не удалось сохранить выбор поставщиков: ' + e.message);
  }
}

$('btn-refresh-ma').addEventListener('click', () => loadManualAutomat({ refresh: true }));

/* ---------- Универсальный выбор периода (единый datepicker-модал) ---------- */
let periodTarget = null;      // { prefix, periodName, onApply }
let pickStart = '';           // 'YYYY-MM-DD'
let pickEnd = '';
let pvStart = { y: 0, m: 0 }; // месяц левого календаря
let pvEnd = { y: 0, m: 0 };   // месяц правого календаря
const periodControlRefreshers = {};

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtD(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

function currentPeriod(periodName) {
  const p = (publicSettings && publicSettings[periodName]) || {};
  let s = p.start || '', e = p.end || '';
  const okDate = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  const todayS = fmtD(new Date());
  // Санитизация: если период пустой, невалидный или перевёрнутый — подставляем
  // текущий месяц. Валидные периоды (в т.ч. старые) не трогаем.
  const bad = !s || !e || !okDate(s) || !okDate(e) || s > e;
  if (bad) {
    const d = new Date();
    s = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-01';
    e = fmtD(new Date());
  }
  return { start: s, end: e };
}

function initPeriodControl(prefix, periodName, onApply) {
  const btn = document.getElementById(prefix + '-period-btn');
  if (!btn || btn.dataset.built) return;
  btn.dataset.built = '1';
  const refresh = () => {
    const p = currentPeriod(periodName);
    btn.textContent = 'Период: ' + p.start + ' — ' + p.end;
  };
  refresh();
  periodControlRefreshers[prefix] = refresh;
  btn.addEventListener('click', () => {
    const p = currentPeriod(periodName);
    openPeriodModal({ prefix, periodName, onApply });
  });
}

function setPeriodLabel(prefix) {
  const r = periodControlRefreshers[prefix];
  if (r) r();
}

function openPeriodModal(tgt) {
  periodTarget = tgt;
  const p = currentPeriod(tgt.periodName);
  pickStart = p.start;
  pickEnd = p.end;
  const d0 = new Date(pickStart + 'T00:00:00');
  const d1 = new Date(pickEnd + 'T00:00:00');
  pvStart = { y: d0.getFullYear(), m: d0.getMonth() };
  pvEnd = { y: d1.getFullYear(), m: d1.getMonth() };
  renderPeriodModal();
  $('period-modal').classList.remove('hidden');
}

function closePeriodModal() { $('period-modal').classList.add('hidden'); }

function monthLabel(y, m) {
  const names = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  return names[m] + ' ' + y;
}
function prevMonth(v) { return v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }; }
function nextMonth(v) { return v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }; }

function renderCal(rootEl, view, isStart) {
  const first = new Date(view.y, view.m, 1);
  const gdow = first.getDay();
  const offset = gdow === 0 ? 6 : gdow - 1; // неделя с Пн
  const daysIn = new Date(view.y, view.m + 1, 0).getDate();
  const selected = isStart ? pickStart : pickEnd;
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push({ day: 0 });
  for (let d = 1; d <= daysIn; d++) cells.push({ day: d, date: fmtD(new Date(view.y, view.m, d)) });
  rootEl.innerHTML =
    '<div class="pc-head"><button type="button" class="pc-nav" data-nav="prev">‹</button>' +
    '<span class="pc-title">' + monthLabel(view.y, view.m) + '</span>' +
    '<button type="button" class="pc-nav" data-nav="next">›</button></div>' +
    '<div class="pc-dow">' + ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((d) => '<span>' + d + '</span>').join('') + '</div>' +
    '<div class="pc-grid">' + cells.map((c) => {
      if (!c.day) return '<span class="pc-day pc-blank"></span>';
      const sel = c.date === selected ? ' is-sel' : '';
      return '<button type="button" class="pc-day' + sel + '" data-date="' + c.date + '">' + c.day + '</button>';
    }).join('') + '</div>';
  rootEl.querySelector('[data-nav="prev"]').addEventListener('click', () => {
    if (isStart) pvStart = prevMonth(pvStart); else pvEnd = prevMonth(pvEnd);
    renderCal(rootEl, isStart ? pvStart : pvEnd, isStart);
  });
  rootEl.querySelector('[data-nav="next"]').addEventListener('click', () => {
    if (isStart) pvStart = nextMonth(pvStart); else pvEnd = nextMonth(pvEnd);
    renderCal(rootEl, isStart ? pvStart : pvEnd, isStart);
  });
  rootEl.querySelectorAll('.pc-day[data-date]').forEach((b) => {
    b.addEventListener('click', () => {
      const d = b.getAttribute('data-date');
      if (isStart) {
        pickStart = d;
        if (pickEnd && pickEnd < d) pickEnd = d;
      } else {
        pickEnd = d;
        if (pickStart && d < pickStart) pickStart = d;
      }
      renderPeriodModal();
    });
  });
  // Клик по заголовку месяца («Январь 2025») — быстрый выбор года, чтобы перескакивать
  // между годами, не листая календарь месяцами.
  const title = rootEl.querySelector('.pc-title');
  title.classList.add('pc-title-btn');
  title.addEventListener('click', () => {
    const existing = rootEl.querySelector('.pc-years');
    if (existing) { existing.remove(); return; }
    const curY = view.y;
    const panel = el('div', 'pc-years');
    // Начало «декады» годов (2025 -> 2020), по которой листаем панель.
    let base = Math.floor(curY / 10) * 10;
    const renderYears = () => {
      panel.innerHTML = '';
      const nav = el('div', 'pc-years-nav');
      const back = el('button', 'pc-nav', '‹'); back.type = 'button';
      const fwd = el('button', 'pc-nav', '›'); fwd.type = 'button';
      const lab = el('span', 'pc-years-label', `${base} — ${base + 9}`);
      back.addEventListener('click', (e) => { e.stopPropagation(); base -= 10; renderYears(); });
      fwd.addEventListener('click', (e) => { e.stopPropagation(); base += 10; renderYears(); });
      nav.appendChild(back); nav.appendChild(lab); nav.appendChild(fwd);
      panel.appendChild(nav);
      const grid = el('div', 'pc-years-grid');
      for (let y = base; y <= base + 9; y++) {
        const b = el('button', 'pc-year' + (y === curY ? ' is-sel' : ''), String(y));
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isStart) pvStart = { y, m: pvStart.m }; else pvEnd = { y, m: pvEnd.m };
          renderCal(rootEl, isStart ? pvStart : pvEnd, isStart);
        });
        grid.appendChild(b);
      }
      panel.appendChild(grid);
    };
    renderYears();
    rootEl.appendChild(panel);
  });
}

function renderPeriodModal() {
  $('pc-start-label').textContent = pickStart || '—';
  $('pc-end-label').textContent = pickEnd || '—';
  renderCal($('pc-cal-start'), pvStart, true);
  renderCal($('pc-cal-end'), pvEnd, false);
}

function applyPreset(key) {
  const now = new Date();
  const today = fmtD(now);
  const ym = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  const s = new Date(now);
  switch (key) {
    case 'today': pickStart = today; pickEnd = today; break;
    case 'yesterday': s.setDate(s.getDate() - 1); pickStart = fmtD(s); pickEnd = fmtD(s); break;
    case '7': s.setDate(s.getDate() - 6); pickStart = fmtD(s); pickEnd = today; break;
    case '10': s.setDate(s.getDate() - 9); pickStart = fmtD(s); pickEnd = today; break;
    case '30': s.setDate(s.getDate() - 29); pickStart = fmtD(s); pickEnd = today; break;
    case '6m': s.setDate(1); s.setMonth(s.getMonth() - 5); pickStart = fmtD(s); pickEnd = today; break;
    case '12m': s.setDate(1); s.setMonth(s.getMonth() - 11); pickStart = fmtD(s); pickEnd = today; break;
    case 'thisMonth': pickStart = ym(now) + '-01'; pickEnd = today; break;
    case 'thisYear': pickStart = now.getFullYear() + '-01-01'; pickEnd = today; break;
    case 'prevMonth': {
      const d0 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      pickStart = ym(d0) + '-01';
      pickEnd = ym(d0) + '-' + pad2(new Date(now.getFullYear(), now.getMonth(), 0).getDate());
      break;
    }
  }
  const d0 = new Date(pickStart + 'T00:00:00');
  const d1 = new Date(pickEnd + 'T00:00:00');
  pvStart = { y: d0.getFullYear(), m: d0.getMonth() };
  pvEnd = { y: d1.getFullYear(), m: d1.getMonth() };
  renderPeriodModal();
}

function confirmPeriod() {
  if (!periodTarget) return;
  const t = periodTarget;
  if (!pickStart || !pickEnd) return;
  closePeriodModal();
  const onApply = t.onApply;
  periodTarget = null;
  api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [t.periodName]: { start: pickStart, end: pickEnd } }),
  }).then((data) => {
    if (data && data.settings) publicSettings = data.settings;
    setPeriodLabel(t.prefix);
    // Для нового раздела «Анализ заказов клиентов» — гарантированный пересчёт:
    // полная перезагрузка, вкладка восстановится по localStorage, а сервер отдаст
    // данные за уже сохранённый период. Для остальных разделов лёгкий путь ниже.
    if (t.prefix === 'ca') {
      setTimeout(() => window.location.reload(), 400);
      return;
    }
    if (onApply) onApply();
    refreshCurrentTab();
  }).catch((e) => {
    alert('Не удалось применить период: ' + e.message);
  });
}

// Гарантированный пересчёт активного раздела с refresh=1 (страховка, если onApply не сработал).
function refreshCurrentTab() {
  const active = document.querySelector('.tab.is-active');
  if (!active) return;
  const t = active.dataset.tab;
  if (t === 'client-analysis') loadClientAnalysis({ refresh: true });
  else if (t === 'dashboard') loadDashboard({ refresh: true });
  else if (t === 'rejections') loadRejections({ refresh: true });
  else if (t === 'client-rejections') loadClientRejections({ refresh: true });
  else if (t === 'report') loadReport({ refresh: true, silent: true });
  else if (t === 'terms') loadTerms({ refresh: true });
}

$('period-ok').addEventListener('click', confirmPeriod);
$('period-close').addEventListener('click', closePeriodModal);
document.querySelectorAll('.preset-btn').forEach((b) => {
  b.addEventListener('click', () => applyPreset(b.getAttribute('data-preset')));
});
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'period-modal') closePeriodModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePeriodModal();
});

function currentYM() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function monthPeriod(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const cur = ym === currentYM();
  const endDay = cur ? new Date().getDate() : last;
  return {
    start: `${ym}-01`,
    end: `${ym}-${String(endDay).padStart(2, '0')}`,
  };
}

// Режим графика каждой карточки: 'day' (по дням) или 'wk' (по неделям).
// Ключ карточки — 'sum-orders', 'count-issued' и т.п.
const dashGraph = {};

// Начало недели (понедельник) для даты 'YYYY-MM-DD'.
function weekStart(dstr) {
  const d = new Date(String(dstr).slice(0, 10) + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // понедельник = 0
  d.setDate(d.getDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Собирает дневные корзины {day,count,sum} в недельные.
function aggregateWeeks(days) {
  const map = new Map();
  for (const e of days || []) {
    const ws = weekStart(e.day);
    const cur = map.get(ws) || { day: ws, count: 0, sum: 0 };
    cur.count += e.count || 0;
    cur.sum += e.sum || 0;
    map.set(ws, cur);
  }
  return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// Собирает дневные корзины {day,count,sum} в месячные (ключ — YYYY-MM).
function aggregateMonths(days) {
  const map = new Map();
  for (const e of days || []) {
    const key = String(e.day).slice(0, 7);
    if (key.length !== 7) continue;
    const cur = map.get(key) || { day: key, count: 0, sum: 0 };
    cur.count += e.count || 0;
    cur.sum += e.sum || 0;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// Собирает дневные корзины {day,count,sum} в годовые (ключ — YYYY).
function aggregateYears(days) {
  const map = new Map();
  for (const e of days || []) {
    const key = String(e.day).slice(0, 4);
    if (key.length !== 4) continue;
    const cur = map.get(key) || { day: key, count: 0, sum: 0 };
    cur.count += e.count || 0;
    cur.sum += e.sum || 0;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

function dashDaysFor(key, metric, id) {
  const d = dashboardData;
  const mode = dashGraph[key] || 'day';
  if (id === 'orders') {
    if (mode === 'mth') return aggregateMonths(d.ordersByDay || []);
    if (mode === 'yr') return aggregateYears(d.ordersByDay || []);
    return mode === 'wk' ? (d.ordersByWeek || []) : (d.ordersByDay || []);
  }
  const daySrc = id === 'issued' ? (d.issuedByDay || []) : (d.refusedByDay || []);
  // Для «Выдано»/«Отказы» недель и месяцев на сервере нет — собираем из дневных корзин.
  if (mode === 'mth') return aggregateMonths(daySrc);
  if (mode === 'yr') return aggregateYears(daySrc);
  return mode === 'wk' ? aggregateWeeks(daySrc) : daySrc;
}

// Доступность гранулярности в зависимости от охвата:
//   дни    — пока период в рамках месяца (≤ DASH_WEEK_DAYS);
//   недели — до двух месяцев (включая рамки выбранного/текущего месяца);
//   месяц  — только при 2 месяцах и больше (≥ DASH_MONTH_DAYS);
//   год    — при периоде длиннее года (≥ DASH_YEAR_DAYS), чтобы сравнивать годы.
const DASH_WEEK_DAYS = 32;
const DASH_MONTH_DAYS = 63; // 2 месяца и больше
const DASH_YEAR_DAYS = 400; // ~13 месяцев: дальше сравниваем по годам

function dashSpanDays() {
  const src = (dashboardData && dashboardData.ordersByDay) || [];
  if (!src.length) return 0;
  let mn = null;
  let mx = null;
  for (const e of src) {
    const t = Date.parse(String(e.day).slice(0, 10) + 'T00:00:00');
    if (Number.isNaN(t)) continue;
    if (mn === null || t < mn) mn = t;
    if (mx === null || t > mx) mx = t;
  }
  return mn === null || mx === null ? 0 : Math.round((mx - mn) / 86400000) + 1;
}

function dashAllowed(mode) {
  const span = dashSpanDays();
  if (mode === 'day') return span <= DASH_WEEK_DAYS;
  if (mode === 'mth') return span >= DASH_MONTH_DAYS;
  if (mode === 'yr') return span >= DASH_YEAR_DAYS;
  return span > DASH_WEEK_DAYS && span < DASH_MONTH_DAYS; // недели
}

function dashDefaultMode() {
  const span = dashSpanDays();
  if (span >= DASH_YEAR_DAYS) return 'yr';
  if (span >= DASH_MONTH_DAYS) return 'mth';
  if (span > DASH_WEEK_DAYS) return 'wk';
  return 'day';
}

function applyDashGranularity() {
  document.querySelectorAll('.dash-toggle').forEach((t) => {
    const key = t.id.replace('toggle-', '');
    // текущий режим стал недоступен (период изменился) — сбрасываем на разрешённый.
    if (!['day', 'wk', 'mth', 'yr'].includes(dashGraph[key]) || !dashAllowed(dashGraph[key])) {
      dashGraph[key] = dashDefaultMode();
    }
    t.querySelectorAll('.dash-toggle-btn').forEach((b) => {
      const g = b.getAttribute('data-graph');
      const dis = !dashAllowed(g);
      b.classList.toggle('is-active', dashGraph[key] === g);
      b.classList.toggle('is-disabled', dis);
      b.disabled = dis;
    });
  });
}

function renderDashboard() {
  const d = dashboardData;
  applyDashGranularity();
  $('dash-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('dash-orders').textContent = `Заказов обработано: ${fmtMoney(d.ordersCount)}`;
  for (const metric of ['sum', 'count']) {
    for (const id of ['orders', 'issued', 'refused']) renderDashCard(metric + '-' + id);
  }
}

// Перерисовывает только одну карточку дашборда (без пересборки остальных),
// чтобы переключение периода на одном графике не «моргало» на других.
function renderDashCard(key) {
  const [metric, id] = key.split('-');
  const fill = id === 'orders' ? 'fill-cyan' : id === 'issued' ? 'fill-green' : 'fill-red';
  renderDashBlock(metric, id, dashDaysFor(key, metric, id), fill);
}

document.querySelectorAll('.dash-toggle').forEach((t) => {
  const key = t.id.replace('toggle-', '');
  t.querySelectorAll('.dash-toggle-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const g = b.getAttribute('data-graph');
      // Недоступная для текущего охвата гранулярность — клик игнорируем.
      if (!dashAllowed(g)) return;
      t.querySelectorAll('.dash-toggle-btn').forEach((x) => x.classList.remove('is-active'));
      b.classList.add('is-active');
      dashGraph[key] = g;
      renderDashCard(key);
    });
  });
});

function renderDashBlock(metric, id, days, fillClass) {
  if (!Array.isArray(days)) days = [];
  const totalCount = days.reduce((s, d) => s + (d.count || 0), 0);
  const totalSum = days.reduce((s, d) => s + (d.sum || 0), 0);
  const showSum = metric === 'sum';
  $('m-' + metric + '-' + id).textContent = showSum
    ? `${fmtMoney(totalSum)} ₽`
    : `${fmtMoney(totalCount)}`;
  const subEl = $('sub-' + metric + '-' + id);
  if (subEl) subEl.textContent = 'за период · ' + ({ day: 'по дням', wk: 'по неделям', mth: 'по месяцам', yr: 'по годам' })[dashGraph[metric + '-' + id] || 'day'];

  const wrap = $('bars-' + metric + '-' + id);
  wrap.classList.toggle('dbars-slim', days.length > 14);
  wrap.innerHTML = '';
  const vals = days.map((d) => (showSum ? d.sum || 0 : d.count || 0));
  const max = vals.reduce((m, v) => Math.max(m, v || 0), 0) || 1;
  days.forEach((day, idx) => {
    const col = el('div', 'dbar');
    const v = showSum ? day.sum : day.count;
    col.appendChild(el('div', 'dbar-val', showSum ? shortMoney(day.sum) : fmtMoney(day.count)));
    const fill = el('div', 'dbar-fill ' + fillClass);
    fill.style.height = `${Math.max(1.5, ((v || 0) / max) * 100)}%`;
    col.appendChild(fill);
    col.appendChild(el('div', 'dbar-day', fmtDay(day.day)));
    if (showSum) col.appendChild(el('div', 'dbar-count', fmtMoney(day.count)));
    wrap.appendChild(col);
  });
}

/* ---------- Отчёт по отказам ---------- */
let rejData = null;
let rejSelectedDistributors = new Set();
let rejSuppliers = [];

async function loadRejections({ refresh } = {}) {
  const spinner = $('rej-spinner');
  const errBox = $('rej-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    let path = '/api/rejections';
    if (refresh) {
      const sid = currentSupplierId();
      if (sid) path += '?supplierId=' + encodeURIComponent(sid);
    }
    initPeriodControl('rej', 'rejPeriod', () => loadRejections({ refresh: true }));
    rejData = await apiPoll(path, { refresh });
    renameSupplierData(rejData);
    fillRejectionPeriod();
    rejSuppliers = (rejData.byDistributor || []).map((x) => x.name).sort();
    renderRejections();
    $('rej-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    $('rej-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function openRejSupplierModal() {
  if (!rejSuppliers.length) return;
  $('rej-supplier-search').value = '';
  renderRejSupplierList('');
  $('rej-supplier-modal').classList.remove('hidden');
}

function closeRejSupplierModal() {
  $('rej-supplier-modal').classList.add('hidden');
}

function renderRejSupplierList(query) {
  const list = $('rej-supplier-list');
  list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const names = rejSuppliers.filter((n) => !q || n.toLowerCase().includes(q));
  if (!names.length) {
    list.appendChild(el('div', 'exclusion-empty', 'Ничего не найдено'));
    return;
  }
  const allBtn = el('button', 'exclusion-item' + (rejSelectedDistributors.size === 0 ? ' is-added' : ''), 'Все поставщики');
  allBtn.type = 'button';
  allBtn.appendChild(el('span', 'exclusion-item-mark', rejSelectedDistributors.size === 0 ? '✓' : ''));
  allBtn.addEventListener('click', () => {
    rejSelectedDistributors.clear();
    closeRejSupplierModal();
    renderRejections();
  });
  list.appendChild(allBtn);
  for (const name of names) {
    const sel = rejSelectedDistributors.has(name);
    const row = el('button', 'exclusion-item' + (sel ? ' is-added' : ''), name);
    row.type = 'button';
    row.appendChild(el('span', 'exclusion-item-mark', sel ? '✓' : '+'));
    row.addEventListener('click', () => {
      if (sel) rejSelectedDistributors.delete(name);
      else rejSelectedDistributors.add(name);
      renderRejSupplierList(query);
      renderRejections();
    });
    list.appendChild(row);
  }
}

function findSupplierId(name) {
  const r = (rejData.rows || []).find((x) => x.distributor === name && x.distributorId);
  return r ? r.distributorId : '';
}

// Для серверной выборки по id передаём его только когда выбран ровно один поставщик.
function currentSupplierId() {
  if (rejSelectedDistributors.size !== 1) return '';
  return findSupplierId(Array.from(rejSelectedDistributors)[0]);
}

function fillRejectionPeriod() {
  initPeriodControl('rej', 'rejPeriod', () => loadRejections({ refresh: true }));
}

function renderRejections() {
  const d = rejData;
  const sel = rejSelectedDistributors;
  const rows = sel.size ? d.rows.filter((r) => sel.has(r.distributor)) : d.rows;
  const byDist = sel.size ? d.byDistributor.filter((x) => sel.has(x.name)) : d.byDistributor;
  const rejTotal = byDist.reduce((s, x) => s + x.total, 0);
  const rejSum = rows.reduce((s, r) => s + (r.sum || 0), 0);

  $('rej-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('rej-orders').textContent = `Заказов обработано: ${fmtMoney(d.ordersCount)}`;
  const rejQty = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  $('rej-refusal').textContent = fmtMoney(rejQty);
  $('rej-total').textContent = fmtMoney(rejTotal);
  const distsWithRefusal = byDist.filter((x) => x.refusals > 0).length;
  $('rej-dists').textContent = fmtMoney(distsWithRefusal);
  $('rej-avg').textContent = rejTotal
    ? `${Math.round((rejQty / rejTotal) * 1000) / 10}%`
    : '0%';
  $('rej-sum').textContent = fmtMoney(rejSum);
  $('btn-rej-supplier').textContent = sel.size ? `Поставщики (${sel.size})` : 'Поставщик: Все';

  renderRejDistributors(byDist);
}

function renderRejDistributors(list) {
  const wrap = $('rej-distributors');
  wrap.innerHTML = '';
  for (const d of list) {
    const item = el('div', 'dist-item clickable');
    const head = el('div', 'dist-head');
    const name = el('span', 'dist-name', `${d.name}`);
    const cnt = el('span', 'dist-count', `${d.refusals} / ${d.total} · ${d.percent}%`);
    head.appendChild(name);
    head.appendChild(cnt);
    const bar = el('div', 'dist-bar');
    const fill = el('div', 'dist-bar-fill');
    fill.style.width = `${Math.min(100, Math.round(d.percent))}%`;
    bar.appendChild(fill);
    item.appendChild(head);
    item.appendChild(bar);
    item.appendChild(el('div', 'dist-sum', `на ${fmtMoney(d.refusalSum || 0)} ₽`));
    item.addEventListener('click', () => openSupplierClients(d.name));
    wrap.appendChild(item);
  }
}

async function openSupplierClients(name) {
  rejClientsSupplier = name;
  const wrap = $('rej-clients-wrap');
  $('rej-clients-title').textContent = `Клиенты поставщика: ${name}`;
  $('rej-clients-modal').classList.remove('hidden');
  if (supplierClientsCacheUI.has(name)) {
    supClientsSort = { col: -1, original: null };
    rejHasWarehouses = supplierClientsCacheUI.get(name).hasWarehouses === true;
    renderSupplierClients(supplierClientsCacheUI.get(name).clients || []);
    return;
  }
  wrap.innerHTML = '';
  wrap.appendChild(el('div', 'empty', 'Загружаем…'));
  try {
    const data = await apiPoll('/api/supplier-clients?supplier=' + encodeURIComponent(name));
    supplierClientsCacheUI.set(name, data);
    supClientsSort = { col: -1, original: null };
    rejHasWarehouses = data.hasWarehouses === true;
    renderSupplierClients(data.clients || []);
  } catch (e) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'status-legend-error', e.message || 'Не удалось загрузить'));
  }
}

function closeSupplierClients() {
  $('rej-clients-modal').classList.add('hidden');
}

let rejClientsSupplier = '';
let rejHasWarehouses = false;
let crjDetailClient = '';
const supplierClientsCacheUI = new Map(); // клиенты поставщика (по ключу — поставщик)
const warehousesCacheUI = new Map();      // склады клиента (по ключу — поставщик|клиент|цена)
// Данные для экспорта в Excel из модалок.
let exportWarehouses = [];
let exportSupplierClients = [];
let exportCrjDetail = [];

async function openWarehousesModal(supplier, client, price) {
  const key = supplier + '|' + client + '|' + ((price === 'out') ? 'out' : 'in');
  $('wh-title').textContent = `Склады клиента: ${client}`;
  $('wh-modal').classList.remove('hidden');
  if (warehousesCacheUI.has(key)) {
    whSort = { col: -1, original: null };
    renderClientWarehouses(warehousesCacheUI.get(key));
    return;
  }
  const wrap = $('wh-wrap');
  const total = $('wh-total');
  wrap.innerHTML = ''; total.innerHTML = '';
  wrap.appendChild(el('div', 'empty', 'Загружаем…'));
  try {
    const pf = (price === 'out') ? 'out' : 'in';
    const data = await apiPoll('/api/client-warehouses?supplier=' + encodeURIComponent(supplier) + '&client=' + encodeURIComponent(client) + '&price=' + pf);
    whSort = { col: -1, original: null };
    warehousesCacheUI.set(key, data.warehouses || []);
    renderClientWarehouses(data.warehouses || []);
  } catch (e) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'status-legend-error', e.message || 'Не удалось загрузить'));
  }
}

function closeClientWarehouses() {
  $('wh-modal').classList.add('hidden');
}

let whSort = { col: -1, original: null };
const WH_HEAD = ['Склад', 'Отказы / все, шт', '% отказов', 'Сумма отказов', 'Сумма заказов', '% отказов по сумме', 'Кол-во в работе', 'Сумма в работе', 'Выдано, шт', 'Сумма выданных'];
const WH_GET = (w, ci) => ci === 0
  ? String(w.warehouse)
  : rejNum([w.refusals, w.percent, w.sum, w.allSum, w.percentBySum, w.work, w.workSum, w.issued, w.issuedSum][ci - 1]);

function renderClientWarehouses(list) {
  if (whSort.col === -1 && whSort.original !== list) whSort.original = list;
  exportWarehouses = list.slice();
  const wrap = $('wh-wrap');
  const total = $('wh-total');
  wrap.innerHTML = ''; total.innerHTML = '';
  if (!list.length) { wrap.appendChild(el('div', 'empty', 'Нет данных')); return; }
  const head = el('div', 'crj-d-head');
  WH_HEAD.forEach((t, ci) => {
    const sp = el('span', 'sortable' + (whSort.col === ci ? ' is-sorted' : ''), t);
    sp.setAttribute('role', 'button'); sp.tabIndex = 0;
    const doSort = () => {
      if (whSort.col === ci) { whSort.col = -1; renderClientWarehouses(whSort.original); return; }
      whSort.col = ci;
      const sorted = whSort.original.slice().sort((a, b) => {
        const av = WH_GET(a, ci), bv = WH_GET(b, ci);
        if (ci === 0) return String(bv).localeCompare(String(av), 'ru');
        return bv - av;
      });
      renderClientWarehouses(sorted);
    };
    sp.addEventListener('click', doSort);
    sp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); } });
    head.appendChild(sp);
  });
  wrap.appendChild(head);
  for (const w of list) {
    const row = el('div', 'crj-d-row');
    row.appendChild(el('span', 'rej-cli-name', w.warehouse));
    row.appendChild(el('span', null, `${w.refusals} / ${w.total}`));
    row.appendChild(el('span', 'crj-d-percent', `${w.percent}%`));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(w.sum)} ₽`));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(w.allSum)} ₽`));
    row.appendChild(el('span', 'crj-d-percent', `${w.percentBySum == null ? 0 : w.percentBySum}%`));
    row.appendChild(el('span', null, w.work));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(w.workSum)} ₽`));
    row.appendChild(el('span', null, w.issued));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(w.issuedSum)} ₽`));
    wrap.appendChild(row);
  }
  total.appendChild(buildWhTotalRow(list));
}

$('wh-close').addEventListener('click', closeClientWarehouses);

// Строка «ИТОГ» складов — закреплённый футер под списком (всегда виден при прокрутке).
function buildWhTotalRow(list) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sumV = (f) => list.reduce((s, w) => s + num(f(w)), 0);
  const rf = sumV((w) => w.refusals), tt = sumV((w) => w.total);
  const sm = sumV((w) => w.sum), as = sumV((w) => w.allSum);
  const row = el('div', 'rej-clients-total-row');
  const sp = (cls, txt) => row.appendChild(el('span', cls, txt));
  sp('rej-cli-name', 'ИТОГ');
  sp(null, `${Math.round(rf)} / ${Math.round(tt)}`);
  sp('crj-d-percent', tt ? `${Math.round((rf / tt) * 1000) / 10}%` : '0%');
  sp('crj-d-sum', `${fmtMoney(sm)} ₽`);
  sp('crj-d-sum', `${fmtMoney(as)} ₽`);
  sp('crj-d-percent', as ? `${Math.round((Number(sm) / Number(as)) * 1000) / 10}%` : '0%');
  sp(null, String(Math.round(sumV((w) => w.work))));
  sp('crj-d-sum', `${fmtMoney(sumV((w) => w.workSum))} ₽`);
  sp(null, String(Math.round(sumV((w) => w.issued))));
  sp('crj-d-sum', `${fmtMoney(sumV((w) => w.issuedSum))} ₽`);
  return row;
}

let supClientsSort = { col: -1, original: null };
const CLIENT_HEAD = ['Клиент', 'Отказы / все, шт', '% отказов', 'Сумма отказов', 'Сумма заказов', '% отказов по сумме', 'Кол-во в работе', 'Сумма в работе', 'Выдано, шт', 'Сумма выданных'];
const CLIENT_GET = (c, ci) => ci === 0
  ? String(c.client)
  : rejNum([c.refusals, c.percent, c.sum, c.allSum, c.percentBySum, c.work, c.workSum, c.issued, c.issuedSum][ci - 1]);

function renderSupplierClients(clients) {
  if (supClientsSort.col === -1 && supClientsSort.original !== clients) {
    supClientsSort.original = clients;
  }
  exportSupplierClients = clients.slice();
  const wrap = $('rej-clients-wrap');
  wrap.innerHTML = '';
  renderRejClientsTotal(clients);
  if (!clients.length) {
    wrap.appendChild(el('div', 'empty', 'Нет данных'));
    return;
  }
  const head = el('div', 'crj-d-head');
  CLIENT_HEAD.forEach((t, ci) => {
    const sp = el('span', 'sortable' + (supClientsSort.col === ci ? ' is-sorted' : ''), t);
    sp.setAttribute('role', 'button');
    sp.tabIndex = 0;
    const doSort = () => {
      if (supClientsSort.col === ci) {
        supClientsSort.col = -1;
        renderSupplierClients(supClientsSort.original);
        return;
      }
      supClientsSort.col = ci;
      const sorted = supClientsSort.original.slice().sort((a, b) => {
        const av = CLIENT_GET(a, ci), bv = CLIENT_GET(b, ci);
        if (ci === 0) return String(bv).localeCompare(String(av), 'ru');
        return bv - av;
      });
      renderSupplierClients(sorted);
    };
    sp.addEventListener('click', doSort);
    sp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); } });
    head.appendChild(sp);
  });
  wrap.appendChild(head);
  for (const c of clients) {
    const row = el('div', 'crj-d-row');
    if (rejHasWarehouses) {
      row.style.cursor = 'pointer';
      row.title = 'Склады по заказам клиента';
      row.addEventListener('click', () => openWarehousesModal(rejClientsSupplier, c.client, 'in'));
    }
    row.appendChild(el('span', 'rej-cli-name', c.client));
    row.appendChild(el('span', null, `${c.refusals} / ${c.total}`));
    row.appendChild(el('span', 'crj-d-percent', `${c.percent}%`));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(c.sum)} ₽`));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(c.allSum)} ₽`));
    row.appendChild(el('span', 'crj-d-percent', `${c.percentBySum == null ? 0 : c.percentBySum}%`));
    row.appendChild(el('span', null, c.work));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(c.workSum)} ₽`));
    row.appendChild(el('span', null, c.issued));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(c.issuedSum)} ₽`));
    wrap.appendChild(row);
  }
}

// Строка «ИТОГ» клиентов поставщика — часть таблицы, чтобы колонки совпадали с данными.
function buildClientTotalRow(list) {
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sumV = (f) => list.reduce((s, c) => s + num(f(c)), 0);
  const rf = sumV((c) => c.refusals), tt = sumV((c) => c.total);
  const sm = sumV((c) => c.sum), as = sumV((c) => c.allSum);
  const tr = document.createElement('tr');
  tr.className = 'rej-total';
  const td = (cls, txt) => tr.appendChild(el('td', cls, txt));
  td('rej-cli-name', 'ИТОГ');
  td(null, `${Math.round(rf)} / ${Math.round(tt)}`);
  td('rej-cli-percent', tt ? `${Math.round((rf / tt) * 1000) / 10}%` : '0%');
  td(null, `${fmtMoney(sm)} ₽`);
  td(null, `${fmtMoney(as)} ₽`);
  td('rej-cli-percent', as ? `${Math.round((Number(sm) / Number(as)) * 1000) / 10}%` : '0%');
  td(null, String(Math.round(sumV((c) => c.work))));
  td(null, `${fmtMoney(sumV((c) => c.workSum))} ₽`);
  td(null, String(Math.round(sumV((c) => c.issued))));
  td(null, `${fmtMoney(sumV((c) => c.issuedSum))} ₽`);
  return tr;
}

// Закреплённый под-итог «ИТОГ» в модалке «Клиенты поставщика» (как у «Отказ клиенты»).
function renderRejClientsTotal(clients) {
  const box = $('rej-clients-total');
  if (!box) return;
  box.innerHTML = '';
  if (!clients || !clients.length) return;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sumV = (f) => clients.reduce((s, c) => s + num(f(c)), 0);
  const rf = sumV((c) => c.refusals), tt = sumV((c) => c.total);
  const sm = sumV((c) => c.sum), as = sumV((c) => c.allSum);
  const row = el('div', 'rej-clients-total-row');
  row.appendChild(el('span', 'rej-cli-name', 'ИТОГ'));
  row.appendChild(el('span', null, `${Math.round(rf)} / ${Math.round(tt)}`));
  row.appendChild(el('span', 'rej-cli-percent', tt ? `${Math.round((rf / tt) * 1000) / 10}%` : '0%'));
  row.appendChild(el('span', null, `${fmtMoney(sm)} ₽`));
  row.appendChild(el('span', null, `${fmtMoney(as)} ₽`));
  row.appendChild(el('span', 'rej-cli-percent', as ? `${Math.round((Number(sm) / Number(as)) * 1000) / 10}%` : '0%'));
  row.appendChild(el('span', null, String(Math.round(sumV((c) => c.work)))));
  row.appendChild(el('span', null, `${fmtMoney(sumV((c) => c.workSum))} ₽`));
  row.appendChild(el('span', null, String(Math.round(sumV((c) => c.issued)))));
  row.appendChild(el('span', null, `${fmtMoney(sumV((c) => c.issuedSum))} ₽`));
  box.appendChild(row);
}

function renderRejRows(rows) {
  const tbody = $('rej-rows');
  tbody.innerHTML = '';
  $('rej-empty').classList.toggle('hidden', rows.length > 0);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'td-order', String(r.orderNumber)));
    tr.appendChild(el('td', null, r.client || '—'));
    tr.appendChild(el('td', null, r.distributor));
    tr.appendChild(el('td', 'num', fmtMoney(r.quantity)));
    const st = el('td', null);
    const b = el('button', 'badge badge-btn', r.status || `Код ${r.statusCode}`);
    b.type = 'button';
    b.addEventListener('click', () => openStatusHistory(r.id, r.orderNumber));
    st.appendChild(b);
    tr.appendChild(st);
    tbody.appendChild(tr);
  }
}

/* ---------- Отчёт по отказам по клиентам ---------- */
let crjData = null;
let crjSelectedClient = '';
let crjClients = [];
let crjSelectedClientId = '';

async function loadClientRejections({ refresh } = {}) {
  const spinner = $('crj-spinner');
  const errBox = $('crj-error');
  errBox.classList.add('hidden');
  spinner.classList.remove('hidden');
  try {
    let path = '/api/rejections/clients';
    if (refresh && crjSelectedClientId) path += '?clientId=' + encodeURIComponent(crjSelectedClientId);
    initPeriodControl('crj', 'crjPeriod', () => loadClientRejections({ refresh: true }));
    crjData = await apiPoll(path, { refresh });
    renameSupplierData(crjData);
    fillCrjPeriod();
    crjClients = (crjData.byDistributor || []).map((x) => x.name).sort();
    renderCrj();
    $('crj-body').classList.remove('hidden');
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
    $('crj-body').classList.add('hidden');
  } finally {
    spinner.classList.add('hidden');
  }
}

function fillCrjPeriod() {
  initPeriodControl('crj', 'crjPeriod', () => loadClientRejections({ refresh: true }));
}

function renderCrj() {
  const d = crjData;
  const rows = crjSelectedClient
    ? d.rows.filter((r) => r.client === crjSelectedClient)
    : d.rows;
  const clients = crjSelectedClient
    ? d.byDistributor.filter((x) => x.name === crjSelectedClient)
    : d.byDistributor;
  const total = clients.reduce((s, x) => s + x.total, 0);
  const sum = rows.reduce((s, r) => s + (r.sum || 0), 0);

  $('crj-meta').textContent = `Обновлено: ${new Date(d.generatedAt).toLocaleString('ru-RU')}`;
  $('crj-orders').textContent = `Заказов обработано: ${fmtMoney(d.ordersCount)}`;
  const crjQty = rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);
  $('crj-refusal').textContent = fmtMoney(crjQty);
  $('crj-total').textContent = fmtMoney(total);
  $('crj-dists').textContent = fmtMoney(clients.filter((x) => x.refusals > 0).length);
  $('crj-avg').textContent = total
    ? `${Math.round((crjQty / total) * 1000) / 10}%`
    : '0%';
  $('crj-sum').textContent = fmtMoney(sum);
  $('btn-crj-client').textContent = crjSelectedClient
    ? `Клиент: ${crjSelectedClient}`
    : 'Клиент: Все';

  renderCrjClients(clients);
}

function renderCrjClients(list) {
  const wrap = $('crj-distributors');
  wrap.innerHTML = '';
  for (const d of list) {
    const item = el('div', 'dist-item clickable');
    const head = el('div', 'dist-head');
    head.appendChild(el('span', 'dist-name', d.name));
    head.appendChild(el('span', 'dist-count', `${d.refusals} / ${d.total} · ${d.percent}%`));
    const bar = el('div', 'dist-bar');
    const fill = el('div', 'dist-bar-fill');
    fill.style.width = `${Math.min(100, Math.round(d.percent))}%`;
    bar.appendChild(fill);
    item.appendChild(head);
    item.appendChild(bar);
    item.appendChild(el('div', 'dist-sum', `на ${fmtMoney(d.refusalSum || 0)} ₽`));
    item.setAttribute('data-crj-client', d.name);
    item.addEventListener('click', () => openCrjDetail(d.name));
    wrap.appendChild(item);
  }
}

function openCrjDetail(client) {
  crjDetailClient = client;
  const entry = (crjData.supplierBreakdown || []).find((x) => x.client === client);
  $('crj-detail-title').textContent = `Поставщики клиента: ${client}`;
  const list = $('crj-detail-list');
  list.innerHTML = '';
  const suppliers = (entry && entry.suppliers) || [];
  exportCrjDetail = suppliers.slice();
  const rows = suppliers.map((s) => [
    s.name,
    `${s.refusals} / ${s.total}`,
    `${s.percent}%`,
    Math.round(s.sum),
    Math.round(s.allSum || 0),
    `${s.percentBySum == null ? 0 : s.percentBySum}%`,
    s.work,
    Math.round(s.workSum || 0),
    s.issued,
    Math.round(s.issuedSum),
  ]);
  crjDetailSort = { col: -1, original: null };
  renderCrjDetailTable(rows);
  renderCrjTotal(suppliers);
  $('crj-detail-modal').classList.remove('hidden');
}

function closeCrjDetail() {
  $('crj-detail-modal').classList.add('hidden');
}

// Строка «ИТОГ» под таблицей детализации: проценты — среднее, остальное — сумма.
function renderCrjTotal(suppliers) {
  const box = $('crj-detail-total');
  if (!box) return;
  box.innerHTML = '';
  if (!suppliers || !suppliers.length) return;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sum = (arr) => arr.reduce((s, v) => s + num(v), 0);
  const pct = (v) => `${Math.round(v * 10) / 10}%`;
  const refTot = sum(suppliers.map((x) => x.refusals));
  const allTot = sum(suppliers.map((x) => x.total));
  const refSum = sum(suppliers.map((x) => x.sum));
  const allSum = sum(suppliers.map((x) => x.allSum));
  const row = el('div', 'crj-d-row crj-d-total');
  row.appendChild(el('span', 'crj-d-name', 'ИТОГ'));
  row.appendChild(el('span', null, `${Math.round(refTot)} / ${Math.round(allTot)}`));
  row.appendChild(el('span', 'crj-d-percent', pct(allTot ? (refTot / allTot) * 100 : 0)));
  row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(Number(refSum))} ₽`));
  row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(Number(allSum))} ₽`));
  row.appendChild(el('span', 'crj-d-percent', pct(allSum ? (Number(refSum) / Number(allSum)) * 100 : 0)));
  row.appendChild(el('span', null, String(Math.round(sum(suppliers.map((x) => x.work))))));
  row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(Number(sum(suppliers.map((x) => x.workSum))))} ₽`));
  row.appendChild(el('span', null, String(Math.round(sum(suppliers.map((x) => x.issued))))));
  row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(Number(sum(suppliers.map((x) => x.issuedSum))))} ₽`));
  box.appendChild(row);
}

// Извлекает число из ячейки («3 / 10» → 3, «85.8%» → 85.8, «1 482 542 ₽» → 1482542).
function rejNum(cell) {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : 0;
  const s = String(cell == null ? '' : cell);
  const m = s.match(/-?\d+(?:[.,]\d+)?/);
  return m ? parseFloat(m[0].replace(',', '.')) : 0;
}

// Состояние сортировки: 1-й клик по заголовку — по убыванию, 2-й — исходный порядок.
let crjDetailSort = { col: -1, original: null };
const CRJ_DETAIL_HEAD = ['Поставщик', 'Отказы / все, шт', '% отказов', 'Сумма отказов', 'Сумма заказов', '% отказов по сумме', 'Кол-во в работе', 'Сумма в работе', 'Выдано, шт', 'Сумма выданных'];

function renderCrjDetailTable(rows) {
  if (crjDetailSort.col === -1 && crjDetailSort.original !== rows) {
    crjDetailSort.original = rows;
  }
  const wrap = $('crj-detail-list');
  wrap.innerHTML = '';
  if (!rows.length) {
    wrap.appendChild(el('div', 'exclusion-empty', 'Данных нет'));
    return;
  }
  const head = el('div', 'crj-d-head');
  CRJ_DETAIL_HEAD.forEach((t, ci) => {
    const sp = el('span', 'sortable' + (crjDetailSort.col === ci ? ' is-sorted' : ''), t);
    sp.setAttribute('role', 'button');
    sp.tabIndex = 0;
    const doSort = () => {
      if (crjDetailSort.col === ci) {
        crjDetailSort.col = -1;
        renderCrjDetailTable(crjDetailSort.original);
        return;
      }
      crjDetailSort.col = ci;
      const sorted = crjDetailSort.original.slice().sort((a, b) => {
        if (ci === 0) return String(b[0]).localeCompare(String(a[0]), 'ru');
        return rejNum(b[ci]) - rejNum(a[ci]);
      });
      renderCrjDetailTable(sorted);
    };
    sp.addEventListener('click', doSort);
    sp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); doSort(); } });
    head.appendChild(sp);
  });
  wrap.appendChild(head);
  for (const r of rows) {
    const row = el('div', 'crj-d-row');
    const nm = String(r[0] || '');
    const base = nm.indexOf(':') >= 0 ? nm.slice(0, nm.indexOf(':')).trim() : nm;
    row.style.cursor = 'pointer';
    row.title = 'Склады по заказам';
    row.addEventListener('click', () => openWarehousesModal(base, crjDetailClient, 'out'));
    row.appendChild(el('span', 'crj-d-name', r[0]));
    row.appendChild(el('span', null, r[1]));
    row.appendChild(el('span', 'crj-d-percent', r[2]));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(r[3])} ₽`));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(r[4])} ₽`));
    row.appendChild(el('span', 'crj-d-percent', r[5]));
    row.appendChild(el('span', null, r[6]));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(r[7])} ₽`));
    row.appendChild(el('span', null, r[8]));
    row.appendChild(el('span', 'crj-d-sum', `${fmtMoney(r[9])} ₽`));
    wrap.appendChild(row);
  }
}

async function openStatusHistory(id, orderNumber) {
  const list = $('status-legend-list');
  list.innerHTML = '';
  $('status-legend-title').textContent = orderNumber
    ? `История статусов · заказ ${orderNumber}`
    : 'История статусов';
  $('status-legend-modal').classList.remove('hidden');
  list.appendChild(el('div', 'exclusion-empty', 'Загружаем…'));
  try {
    const data = await api('/api/status-history?positionId=' + encodeURIComponent(id));
    renderStatusHistory(data.history || []);
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'status-legend-error', e.message || 'Не удалось загрузить историю'));
  }
}

function closeStatusLegend() {
  $('status-legend-modal').classList.add('hidden');
}

function renderStatusHistory(history) {
  const list = $('status-legend-list');
  list.innerHTML = '';
  if (!history.length) {
    list.appendChild(el('div', 'exclusion-empty', 'Нет данных'));
    return;
  }
  const head = el('div', 'sh-row sh-head');
  ['Автор', 'Статус', 'Дата и время'].forEach((t) => head.appendChild(el('span', null, t)));
  list.appendChild(head);
  for (const s of history) {
    const row = el('div', 'sh-row');
    row.appendChild(el('span', 'sh-author', s.managerName || '—'));
    const statusCell = el('span', 'sh-status');
    statusCell.appendChild(el('span', null, s.status || `Код ${s.statusCode}`));
    if (s.statusCode) statusCell.title = `Код ${s.statusCode}`;
    row.appendChild(statusCell);
    row.appendChild(el('span', 'sh-date', s.datetime || ''));
    list.appendChild(row);
  }
}

function renderCrjRows(rows) {
  const tbody = $('crj-rows');
  tbody.innerHTML = '';
  $('crj-empty').classList.toggle('hidden', rows.length > 0);
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', 'td-order', String(r.orderNumber)));
    tr.appendChild(el('td', null, r.client || '—'));
    tr.appendChild(el('td', null, r.distributor));
    tr.appendChild(el('td', 'num', fmtMoney(r.quantity)));
    const st = el('td', null);
    const b = el('button', 'badge badge-btn', r.status || `Код ${r.statusCode}`);
    b.type = 'button';
    b.addEventListener('click', () => openStatusHistory(r.id, r.orderNumber));
    st.appendChild(b);
    tr.appendChild(st);
    tbody.appendChild(tr);
  }
}

/* ---------- Фильтр клиента (отказы по клиентам) ---------- */
function openCrjClientModal() {
  if (!crjClients.length) return;
  $('crj-client-search').value = '';
  renderCrjClientList('');
  $('crj-client-modal').classList.remove('hidden');
}

function closeCrjClientModal() {
  $('crj-client-modal').classList.add('hidden');
}

function renderCrjClientList(query) {
  const list = $('crj-client-list');
  list.innerHTML = '';
  const q = query.trim().toLowerCase();
  const names = crjClients.filter((n) => !q || n.toLowerCase().includes(q));
  if (!names.length) {
    list.appendChild(el('div', 'exclusion-empty', 'Ничего не найдено'));
    return;
  }
  const allBtn = el('button', 'exclusion-item' + (crjSelectedClient === '' ? ' is-added' : ''), 'Все клиенты');
  allBtn.type = 'button';
  allBtn.appendChild(el('span', 'exclusion-item-mark', crjSelectedClient === '' ? '✓' : '+'));
  allBtn.addEventListener('click', () => {
    crjSelectedClient = '';
    crjSelectedClientId = '';
    closeCrjClientModal();
    renderCrj();
  });
  list.appendChild(allBtn);
  for (const name of names) {
    const sel = crjSelectedClient === name;
    const row = el('button', 'exclusion-item' + (sel ? ' is-added' : ''), name);
    row.type = 'button';
    row.appendChild(el('span', 'exclusion-item-mark', sel ? '✓' : '+'));
    row.addEventListener('click', () => {
      crjSelectedClient = name;
      crjSelectedClientId = findClientId(name);
      closeCrjClientModal();
      renderCrj();
    });
    list.appendChild(row);
  }
}

function findClientId(name) {
  const r = (crjData.rows || []).find((x) => x.client === name && x.clientId);
  return r ? r.clientId : '';
}

/* ---------- Настройки (подключение) ---------- */
let seSaveTimer = null;

async function loadSupplierEmails() {
  try {
    const data = await apiPoll('/api/suppliers');
    renderSupplierEmails(data.suppliers || []);
    $('se-status').textContent = 'загружено';
    $('se-fetch-info').textContent = '';
  } catch (e) {
    $('se-status').textContent = 'ошибка загрузки';
  }
}

async function fetchSupplierEmailsFromAbcp() {
  const info = $('se-fetch-info');
  info.textContent = 'Загружаем из ABCP…';
  try {
    const data = await api('/api/supplier-emails/fetch');
    renderSupplierEmails(data.suppliers || []);
    const added = (data.suppliers || []).filter((s) => (s.emails || []).length).length;
    info.textContent = `Заполнено почт у ${added} поставщиков`;
    $('se-status').textContent = 'загружено';
  } catch (e) {
    info.textContent = e.message;
  }
}

function renderSupplierEmails(suppliers) {
  const wrap = $('se-list');
  wrap.innerHTML = '';
  $('se-empty').classList.toggle('hidden', suppliers.length > 0);
  for (const s of suppliers) {
    const item = el('div', 'se-item');
    item.dataset.name = s.name;
    item.appendChild(el('div', 'se-item-name', s.name));
    const input = el('input', 'input se-item-emails', '');
    input.type = 'text';
    input.placeholder = 'Почты через запятую';
    input.value = (s.emails || []).join(', ');
    input.addEventListener('input', scheduleSeSave);
    item.appendChild(input);
    wrap.appendChild(item);
  }
  updateSeProgress();
}

// «Заполнено: N из M» — сколько поставщиков имеют хотя бы одну почту.
function updateSeProgress() {
  const items = document.querySelectorAll('#se-list .se-item');
  let filled = 0;
  items.forEach((item) => {
    const v = (item.querySelector('.se-item-emails').value || '').trim();
    if (v) filled += 1;
  });
  const el2 = document.getElementById('se-progress');
  if (el2) el2.textContent = `Заполнено: ${filled} из ${items.length}`;
}

function collectSeData() {
  const supplierEmails = {};
  document.querySelectorAll('#se-list .se-item').forEach((item) => {
    const emails = (item.querySelector('.se-item-emails').value || '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    supplierEmails[item.dataset.name] = emails;
  });
  return supplierEmails;
}

function scheduleSeSave() {
  clearTimeout(seSaveTimer);
  updateSeProgress();
  seSaveTimer = setTimeout(saveSupplierEmails, 700);
}

async function saveSupplierEmails() {
  $('se-status').textContent = 'сохранение…';
  try {
    await api('/api/supplier-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierEmails: collectSeData() }),
    });
    $('se-status').textContent = 'сохранено';
  } catch (e) {
    $('se-status').textContent = 'ошибка сохранения';
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/settings');
    publicSettings = data.settings;
    $('set-host').value = publicSettings.host || '';
    $('set-login').value = publicSettings.login || '';
    $('set-password').value = '';
    $('password-hint').textContent = publicSettings.hasPassword
      ? `MD5-пароль уже задан (…${publicSettings.passwordTail}). Оставьте поле пустым, чтобы не менять его.`
      : 'Не задан';
    const smtp = publicSettings.smtp || {};
    $('smtp-host').value = smtp.host || '';
    $('smtp-port').value = smtp.port || 587;
    $('smtp-secure').checked = !!smtp.secure;
    $('smtp-user').value = smtp.user || '';
    $('smtp-pass').value = '';
    $('smtp-from').value = smtp.fromEmail || '';
  } catch (e) {
    showSettingsMsg(e.message, true);
  }
}

function showSettingsMsg(text, isError) {
  const msg = $('settings-msg');
  msg.textContent = text;
  msg.classList.toggle('error', Boolean(isError));
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('btn-save');
  btn.disabled = true;
  try {
    const payload = {
      host: $('set-host').value,
      login: $('set-login').value,
      md5Password: $('set-password').value,
    };
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    publicSettings = data.settings;
    $('set-password').value = '';
    $('password-hint').textContent = publicSettings.hasPassword
      ? `MD5-пароль задан (…${publicSettings.passwordTail}).`
      : 'Не задан';
    showSettingsMsg('Настройки сохранены');
  } catch (err) {
    showSettingsMsg(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('btn-save-smtp').addEventListener('click', async () => {
  const msg = $('smtp-msg');
  msg.textContent = 'Сохраняем…';
  try {
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        smtp: {
          host: $('smtp-host').value,
          port: Number($('smtp-port').value) || 587,
          secure: $('smtp-secure').checked,
          user: $('smtp-user').value,
          pass: $('smtp-pass').value,
          fromEmail: $('smtp-from').value,
        },
      }),
    });
    publicSettings = data.settings;
    $('smtp-pass').value = '';
    msg.textContent = 'SMTP сохранён';
  } catch (e) {
    msg.textContent = e.message;
  }
});

/* ---------- Применить параметры отчёта ---------- */
$('btn-apply-params').addEventListener('click', async () => {
  const btn = $('btn-apply-params');
  const msg = $('rp-msg');
  btn.disabled = true;
  msg.textContent = '';
  try {
    const completedStatusCodes = [];
    const excluded = Array.from(excludedDistributors);
    const p = currentPeriod('reportPeriod');
    const data = await api('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reportPeriod: { start: p.start, end: p.end },
        completedStatusCodes,
        excludedDistributors: excluded,
        statusesTouched: true,
      }),
    });
    publicSettings = data.settings;
    selectedStatuses = new Set(completedStatusCodes.map(String));
    excludedDistributors = new Set(excluded.map(String));
    msg.textContent = 'Параметры применены';
    $('report-params').open = false;
    await loadReport({ refresh: true });
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add('error');
  } finally {
    btn.disabled = false;
    setTimeout(() => { msg.textContent = ''; msg.classList.remove('error'); }, 4000);
  }
});

function openSettings() {
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
  document.querySelector('[data-tab="settings"]').classList.add('is-active');
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('is-active'));
  $('view-settings').classList.add('is-active');
  loadSettings();
}

/* ---------- События ---------- */
$('btn-refresh').addEventListener('click', () => loadReport({ refresh: true }));
$('btn-refresh-dash').addEventListener('click', () => loadDashboard({ refresh: true }));

// Автообновление дашборда: пока открыта вкладка «Дашборд», каждые N минут
// пересчитывается текущий день и подтягиваются свежие данные (период,
// если он «плавающий», сам сойдётся на сегодня). Защита от двойных запусков.
const DASH_AUTO_MS = 10 * 60 * 1000; // 10 минут
let lastDashAuto = 0;
setInterval(() => {
  if (!authState.authed) return;
  const active = document.querySelector('.tab.is-active');
  if (!(active && active.dataset.tab === 'dashboard')) return;
  if (Date.now() - lastDashAuto < DASH_AUTO_MS) return;
  lastDashAuto = Date.now();
  loadDashboard({ refresh: true });
}, 60 * 1000);

$('chk-all').addEventListener('change', (e) => {
  document.querySelectorAll('#rows input[type="checkbox"]').forEach((cb) => {
    cb.checked = e.target.checked;
  });
});

// Главный чекбокс в шапке таблицы «Просроченные позиции»: выделяет/снимает все строки.
function syncOvdCheckAll() {
  const master = document.getElementById('ovd-check-all');
  if (!master) return;
  const cbs = Array.from(document.querySelectorAll('#ovd-rows input[type="checkbox"]'));
  const any = cbs.some((c) => c.checked);
  master.checked = cbs.length > 0 && any && cbs.every((c) => c.checked);
  master.indeterminate = cbs.length > 0 && any && !(cbs.every((c) => c.checked));
}
$('ovd-check-all').addEventListener('change', (e) => {
  document.querySelectorAll('#ovd-rows input[type="checkbox"]').forEach((cb) => { cb.checked = e.target.checked; });
  syncOvdCheckAll();
});
$('ovd-rows').addEventListener('change', (e) => {
  if (e.target && e.target.type === 'checkbox') syncOvdCheckAll();
});

// После отправки писем периодически перечитываем отчёт, пока фоновая рассылка идёт:
// тогда дата в колонке «Отправлено» появится сама, без перезахода и без ручного обновления.
let mailPollTimer = null;
function pollReportUntilMailDone() {
  if (mailPollTimer) clearInterval(mailPollTimer);
  let polls = 0;
  mailPollTimer = setInterval(async () => {
    polls++;
    if (polls > 40) { mailPollTimer = null; return; }
    try {
      const d = await apiPoll('/api/report');
      reportData = d;
      renameSupplierData(d);
      applyFilters();
      if (!document.getElementById('ovd-modal').classList.contains('hidden')) {
        updateOvdSentCells();
        updateOvdSent();
      }
      if (!d.mailActive) { clearInterval(mailPollTimer); mailPollTimer = null; }
    } catch (_e) {
      clearInterval(mailPollTimer);
      mailPollTimer = null;
    }
  }, 4000);
}

$('btn-refusal').addEventListener('click', async () => {
  await apiPoll('/api/report').catch(() => {});
  const checked = Array.from(document.querySelectorAll('#rows input[type="checkbox"]:checked'));
  const info = $('refusal-info');
  if (!checked.length) {
    info.textContent = 'Выберите позиции (галочки в таблице)';
    return;
  }
  const items = checked.map((cb) => collectItemFromRow(overdueFilteredRows[Number(cb.dataset.i)]));
  if (!confirm(`Снять в отказ ${items.length} позиций? Это изменит статусы в ABCP.`)) return;
  info.textContent = 'Отправляем…';
  try {
    const data = await api('/api/report/mark-refusal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    info.textContent = data.message || 'Задача принята — выполняется в фоне';
    forgetRefused(items.map((i) => i.positionId));
    if (data.ok) loadReport({ refresh: true });
  } catch (e) {
    info.textContent = e.message;
  }
});

$('btn-request-term').addEventListener('click', async () => {
  await apiPoll('/api/report').catch(() => {});
  const checked = Array.from(document.querySelectorAll('#rows input[type="checkbox"]:checked'));
  const info = $('refusal-info');
  if (!checked.length) {
    info.textContent = 'Выберите позиции (галочки в таблице)';
    return;
  }
  const items = checked.map((cb) => collectItemFromRow(overdueFilteredRows[Number(cb.dataset.i)]));
  if (!confirm(`Запросить срок поставки по ${items.length} позициям? Письма уйдут поставщикам.`)) return;
  info.textContent = 'Отправляем…';
  try {
    const data = await api('/api/report/request-term', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const now = new Date().toLocaleString('ru-RU');
    info.textContent = `Запрос отправлен: ${now}. ` + (data.message || 'письма выполняются в фоне');
    pollReportUntilMailDone();
  } catch (e) {
    info.textContent = e.message;
  }
});

$('ovd-request').addEventListener('click', async () => {
  await apiPoll('/api/report').catch(() => {});
  const checked = Array.from(document.querySelectorAll('#ovd-rows input[type="checkbox"]:checked'));
  const info = $('ovd-info');
  if (!checked.length) {
    info.textContent = 'Выберите позиции (галочки в таблице)';
    return;
  }
  const items = checked.map((cb) => collectItemFromRow(ovdShownRows[Number(cb.dataset.i)]));
  if (!confirm(`Запросить срок поставки по ${items.length} позициям? Письма уйдут поставщикам.`)) return;
  info.textContent = 'Отправляем…';
  try {
    const data = await api('/api/report/request-term', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const now = new Date().toLocaleString('ru-RU');
    info.textContent = `Запрос отправлен: ${now}. ` + (data.message || 'письма выполняются в фоне');
    pollReportUntilMailDone();
  } catch (e) {
    info.textContent = e.message;
  }
});
$('btn-refresh-rej').addEventListener('click', () => loadRejections({ refresh: true }));
$('btn-rej-supplier').addEventListener('click', openRejSupplierModal);
$('rej-supplier-close').addEventListener('click', closeRejSupplierModal);
$('rej-supplier-search').addEventListener('input', () => renderRejSupplierList($('rej-supplier-search').value));
$('rej-supplier-modal').addEventListener('click', (e) => {
  if (e.target.id === 'rej-supplier-modal') closeRejSupplierModal();
});
$('btn-crj-client').addEventListener('click', openCrjClientModal);
$('crj-client-close').addEventListener('click', closeCrjClientModal);
$('crj-client-search').addEventListener('input', () => renderCrjClientList($('crj-client-search').value));
$('crj-client-modal').addEventListener('click', (e) => {
  if (e.target.id === 'crj-client-modal') closeCrjClientModal();
});
$('crj-detail-close').addEventListener('click', closeCrjDetail);
$('crj-detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'crj-detail-modal') closeCrjDetail();
});
$('rej-clients-close').addEventListener('click', closeSupplierClients);
$('rej-clients-modal').addEventListener('click', (e) => {
  if (e.target.id === 'rej-clients-modal') closeSupplierClients();
});

/* ---------- Экспорт модалок в Excel ---------- */
function exportTotalRow(items) {
  const N = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sum = (k) => items.reduce((s, x) => s + N(x[k]), 0);
  const rf = sum('refusals'), tt = sum('total'), sm = sum('sum'), as = sum('allSum');
  return ['ИТОГ', `${Math.round(rf)} / ${Math.round(tt)}`, tt ? Math.round((rf / tt) * 1000) / 10 : 0,
    Math.round(sm * 100) / 100, Math.round(as * 100) / 100, as ? Math.round((sm / as) * 1000) / 10 : 0,
    sum('work'), Math.round(sum('workSum') * 100) / 100, sum('issued'), Math.round(sum('issuedSum') * 100) / 100];
}
function exportRowFrom(x) {
  return [x.name ?? x.client ?? x.warehouse,
    `${x.refusals} / ${x.total}`, x.percent, Math.round(x.sum * 100) / 100, Math.round(x.allSum * 100) / 100,
    x.percentBySum == null ? 0 : x.percentBySum, x.work, Math.round(x.workSum * 100) / 100, x.issued, Math.round(x.issuedSum * 100) / 100];
}
async function downloadReportXlsx(opts) {
  const r = await api('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  // Сервер отдаёт файл с Content-Disposition: attachment — браузер скачает его,
  // а не уйдёт на blob-ссылку.
  window.location.href = '/api/export/download?token=' + encodeURIComponent(r.token);
}
$('wh-export').addEventListener('click', () => {
  const rows = exportWarehouses.map(exportRowFrom).concat([exportTotalRow(exportWarehouses)]);
  downloadReportXlsx({ filename: `Склады_${rejClientsSupplier}`, sheetName: 'Склады', cols: WH_HEAD, rows, title: `Склады: ${rejClientsSupplier}` });
});
$('rej-clients-export').addEventListener('click', () => {
  const rows = exportSupplierClients.map(exportRowFrom).concat([exportTotalRow(exportSupplierClients)]);
  downloadReportXlsx({ filename: `Клиенты_поставщика_${rejClientsSupplier}`, sheetName: 'Клиенты', cols: CLIENT_HEAD, rows, title: `Клиенты поставщика: ${rejClientsSupplier}` });
});
$('crj-detail-export').addEventListener('click', () => {
  const rows = exportCrjDetail.map(exportRowFrom).concat([exportTotalRow(exportCrjDetail)]);
  downloadReportXlsx({ filename: `Поставщики_клиента_${crjDetailClient}`, sheetName: 'Поставщики', cols: CRJ_DETAIL_HEAD, rows, title: `Поставщики клиента: ${crjDetailClient}` });
});

$('status-legend-close').addEventListener('click', closeStatusLegend);
$('status-legend-modal').addEventListener('click', (e) => {
  if (e.target.id === 'status-legend-modal') closeStatusLegend();
});
$('btn-refresh-crj').addEventListener('click', () => loadClientRejections({ refresh: true }));
$('btn-add-exclusion').addEventListener('click', openExclusionModal);
$('btn-show-ip').addEventListener('click', async () => {
  const span = $('server-ip');
  span.textContent = 'Определяем IP…';
  try {
    const data = await api('/api/my-ip');
    span.textContent = `IP: ${data.ip}`;
    try {
      await navigator.clipboard.writeText(data.ip);
    } catch (_e) { /* не критично */ }
  } catch (e) {
    span.textContent = e.message;
  }
});
// Права текущего пользователя и статус главного администратора.
$('se-add').addEventListener('click', () => {
  const name = $('se-new-name').value.trim();
  const emails = $('se-new-emails').value;
  if (!name) return;
  const wrap = $('se-list');
  const item = el('div', 'se-item');
  item.dataset.name = name;
  item.appendChild(el('div', 'se-item-name', name));
  const input = el('input', 'input se-item-emails', '');
  input.type = 'text';
  input.placeholder = 'Почты через запятую';
  input.value = emails;
  input.addEventListener('input', scheduleSeSave);
  item.appendChild(input);
  wrap.appendChild(item);
  $('se-new-name').value = '';
  $('se-new-emails').value = '';
  $('se-empty').classList.add('hidden');
  scheduleSeSave();
});
$('se-fetch').addEventListener('click', fetchSupplierEmailsFromAbcp);
$('se-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('se-add').click(); });
$('exclusion-close').addEventListener('click', closeExclusionModal);
$('exclusion-search').addEventListener('input', () => renderExclusionList($('exclusion-search').value));
$('exclusion-modal').addEventListener('click', (e) => {
  if (e.target.id === 'exclusion-modal') closeExclusionModal();
});
$('filter-search').addEventListener('input', applyFilters);

/* ---------- Старт ---------- */
(async function init() {
  try {
    const data = await api('/api/settings');
    publicSettings = data.settings;
    if (!data.configured) {
      openSettings();
      return;
    }
    await loadDashboard();
  } catch (e) {
    const errBox = $('error');
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
})();

/* ---------- Автообновление дашборда (только при открытой вкладке) ---------- */
const DASH_AUTO_REFRESH_MS = 120000;
let dashUpdating = false;

async function maybeAutoRefreshDashboard() {
  const tab = document.querySelector('[data-tab="dashboard"]');
  const isActive = tab && tab.classList.contains('is-active');
  if (!isActive || dashUpdating) return;
  dashUpdating = true;
  try {
    await loadDashboard({ refresh: true });
  } catch (_e) {
    // ошибка уже показана интерфейсом
  } finally {
    dashUpdating = false;
  }
}

setInterval(maybeAutoRefreshDashboard, DASH_AUTO_REFRESH_MS);

/* ---------- Вход по логину/паролю и управление пользователями ---------- */
let authState = { needsSetup: false, authed: false };
const SECTION_LIST = [
  { key: 'dashboard', label: 'Дашборд' },
  { key: 'terms', label: 'Сроки по поставщикам' },
  { key: 'pricing', label: 'Проценка' },
  { key: 'report', label: 'Просрочка' },
  { key: 'rejections', label: 'Отказы Поставщики' },
  { key: 'client-rejections', label: 'Отказ клиенты' },
    { key: 'client-analysis', label: 'Анализ заказов клиентов' },
    { key: 'europe', label: 'Отчет Европа' },
    { key: 'client-config', label: 'Конфигуратор сроков поставки' },
  { key: 'manual-automat', label: 'Ручной автомат' },
  { key: 'supplier-emails', label: 'Почты поставщиков' },
];

function showLoginGate(needsSetup, isSuper) {
  authState.needsSetup = Boolean(needsSetup);
  authState.isSuper = Boolean(isSuper);
  $('login-screen').classList.remove('hidden');
  $('login-needs-setup').classList.toggle('hidden', !(authState.needsSetup && authState.isSuper));
  $('login-setup-btn-wrap').classList.toggle('hidden', !(authState.needsSetup && authState.isSuper));
  $('setup-screen').classList.add('hidden');
}

function hideAuthScreens() {
  $('login-screen').classList.add('hidden');
  $('setup-screen').classList.add('hidden');
}

async function checkAuth() {
  try {
 const r = await fetch((API_BASE || '') + '/api/auth/me');
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      authState.authed = true;
      authState.sections = Array.isArray(data.sections) ? data.sections : null;
      const nm = (data.user && (data.user.name || '')) || '';
      if (nm) {
        $('current-user').textContent = nm;
        setAvatar(data.user);
        const roleEl = $('user-role');
        if (roleEl && data.user) {
          roleEl.textContent = (ROLE_LABEL[data.user.role] || '').toLowerCase();
        }
      }
      hideAuthScreens();
      applySections();
      // остаёмся на той же вкладке, что была до обновления страницы
      const saved = localStorage.getItem('ap_tab');
      if (saved) {
        const btn = document.querySelector('.tab[data-tab="' + saved + '"]');
        if (btn && btn.style.display !== 'none') btn.click();
      }
      return;
    }
    showLoginGate(data.needsSetup, data.isSuper);
  } catch (_e) {
    showLoginGate(false, false);
  }
}

function applySections() {
  const sections = authState.sections; // null — администратор (все разделы), иначе массив разрешённых
  const isAdmin = sections === null;
  document.querySelectorAll('.tab[data-tab]').forEach((btn) => {
    const key = btn.dataset.tab;
    let visible;
    if (key === 'settings') visible = isAdmin; // настройки — только администраторам
    else if (key === 'logs') visible = true;   // логи — всем пользователям
    else visible = isAdmin || sections.includes(key);
    btn.style.display = visible ? '' : 'none';
  });
  // «Обновить данные» (перечитывание из ABCP) — доступно только администраторам.
  const DATA_REFRESH_IDS = ['btn-refresh', 'btn-refresh-dash', 'btn-refresh-rej', 'btn-refresh-crj', 'btn-refresh-terms', 'btn-refresh-ca', 'btn-refresh-ma'];
  for (const id of DATA_REFRESH_IDS) {
    const b = document.getElementById(id);
    if (b) b.style.display = isAdmin ? '' : 'none';
  }
}

$('btn-go-setup').addEventListener('click', () => {
  $('login-screen').classList.add('hidden');
  $('setup-screen').classList.remove('hidden');
});

$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = $('setup-error');
  errBox.classList.add('hidden');
  try {
    await api('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: $('su-login').value, name: $('su-name').value, password: $('su-password').value }),
    });
    window.location.reload();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
});

$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_e) { /* ignore */ }
  window.location.reload();
});

const ROLE_LABEL = { superAdmin: 'Главный администратор', admin: 'Администратор', user: 'Пользователь' };

/* ── Красивые случайные аватары (SVG, детерминированные по пользователю) ── */
const AVATAR_PALS = [
  ['#ff9a3d', '#ff5e6c', '#ffd24d'],
  ['#7b5bff', '#4fd6e8', '#b490ff'],
  ['#00c2a8', '#30e0b8', '#0a8f78'],
  ['#ff6b9d', '#ff9e7d', '#ff4f81'],
  ['#3aa0ff', '#6fd0ff', '#1f6fff'],
  ['#ffb020', '#ff7a00', '#ffd66b'],
  ['#8e5bff', '#31c6ff', '#b16bff'],
  ['#16a085', '#5ce1a6', '#0f7a63'],
  ['#ef5350', '#ff9a3d', '#ffd24d'],
  ['#2f9bd8', '#56d0f2', '#1c6ec4']
];
function avSeed(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h * 33) ^ s.charCodeAt(i)) >>> 0);
  return h;
}
function avatarSvg(u) {
  const key = 'av|' + (u && (u.id || u.login || ''));
  const s = avSeed(key);
  const pal = AVATAR_PALS[s % AVATAR_PALS.length];
  const p = (s >> 3) % 5;
  const [c0, c1, c2] = pal;
  const id = 'avg' + (s % 97);
  let deco = '';
  if (p === 0) {
    deco = '<circle cx="44" cy="44" r="26" fill="rgba(255,255,255,.14)"/>' +
      '<circle cx="44" cy="44" r="13" fill="rgba(255,255,255,.18)"/>';
  } else if (p === 1) {
    deco = '<path d="M-6 70 C18 40 40 34 70 46 L70 78 L-6 78 Z" fill="rgba(255,255,255,.16)"/>' +
      '<circle cx="14" cy="16" r="9" fill="rgba(255,255,255,.22)"/>';
  } else if (p === 2) {
    deco = '<circle cx="34" cy="34" r="20" fill="none" stroke="rgba(255,255,255,.30)" stroke-width="5"/>' +
      '<circle cx="34" cy="34" r="9" fill="rgba(255,255,255,.22)"/>';
  } else if (p === 3) {
    deco = '<circle cx="20" cy="20" r="12" fill="rgba(255,255,255,.16)"/>' +
      '<circle cx="46" cy="22" r="6" fill="rgba(255,255,255,.22)"/>' +
      '<circle cx="30" cy="50" r="16" fill="rgba(255,255,255,.12)"/>';
  } else {
    deco = '<path d="M32 6 L38 26 L58 32 L38 38 L32 58 L26 38 L6 32 L26 26 Z" fill="rgba(255,255,255,.22)"/>';
  }
  return '<svg viewBox="0 0 64 64" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
    '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="' + c0 + '"/><stop offset=".55" stop-color="' + c1 + '"/><stop offset="1" stop-color="' + c2 + '"/>' +
    '</linearGradient></defs>' +
    '<rect width="64" height="64" fill="url(#' + id + ')"/>' +
    deco +
    '<path d="M0 0 L64 0 L64 7 L0 18 Z" fill="rgba(255,255,255,.16)"/>' +
    '</svg>';
}
// Забавные аватарки с сервиса DiceBear: стиль выбирается по хешу пользователя,
// сид — из id/логина, поэтому у каждого свой постоянный аватар.
const DICEBEAR_STYLES = ['big-smile', 'fun-emoji'];
function dicebearUrl(u) {
  const key = 'dice|' + (u && (u.id || u.login || ''));
  const s = avSeed(key);
  const style = DICEBEAR_STYLES[s % DICEBEAR_STYLES.length];
  const seed = encodeURIComponent(String(u && (u.id || u.login || 'gost')));
  return 'https://api.dicebear.com/9.x/' + style + '/svg?seed=' + seed + '&backgroundColor=0d131c';
}
function setAvatar(user) {
  const av = $('avatar');
  if (!av || !user) return;
  const nm = (user && (user.name || user.login || '') || '').trim();
  const init = nm.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  av.textContent = init;
}

async function loadUsers() {
  const errBox = $('users-error');
  errBox.classList.add('hidden');
  try {
    const data = await api('/api/users');
    renderUsers(data.users || []);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.classList.remove('hidden');
  }
}

function renderUsers(users) {
  const tb = $('users-rows');
  tb.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.appendChild(el('td', null, u.login));
    tr.appendChild(el('td', null, u.name || '—'));
    tr.appendChild(el('td', null, ROLE_LABEL[u.role] || u.role));
    const td = el('td', 'num', '');
    const canDelete = u.role !== 'superAdmin';
    const btns = document.createElement('span');
    btns.style.display = 'inline-flex';
    btns.style.gap = '6px';
    if (u.role === 'user') {
      const secBtn = el('button', 'btn btn-accent btn-sm', 'Разделы');
      secBtn.type = 'button';
      secBtn.addEventListener('click', () => openUserSections(u));
      btns.appendChild(secBtn);
    }
    if (u.role !== 'superAdmin') {
      const impBtn = el('button', 'btn', 'Войти');
      impBtn.type = 'button';
      impBtn.title = 'Войти под этим пользователем (без пароля)';
      impBtn.addEventListener('click', async () => {
        try {
          await api('/api/auth/impersonate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: u.id }),
          });
          window.location.reload();
        } catch (e) {
          $('users-error').textContent = e.message;
          $('users-error').classList.remove('hidden');
        }
      });
      btns.appendChild(impBtn);
    }
    const delBtn = el('button', 'btn btn-danger-small', 'Удалить');
    delBtn.type = 'button';
    delBtn.disabled = !canDelete;
    delBtn.title = canDelete ? 'Удалить пользователя' : 'Главного администратора нельзя удалить';
    delBtn.addEventListener('click', async () => {
      if (!confirm('Удалить пользователя?')) return;
      try {
        await api('/api/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
        loadUsers();
      } catch (e) {
        $('users-error').textContent = e.message;
        $('users-error').classList.remove('hidden');
      }
    });
    btns.appendChild(delBtn);
    td.appendChild(btns);
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}

function renderSectionCheckboxes(container, selected) {
  container.innerHTML = '';
  const sel = new Set(selected || []);
  for (const s of SECTION_LIST) {
    const label = el('label', 'status-check');
    const cbx = document.createElement('input');
    cbx.type = 'checkbox';
    cbx.value = s.key;
    cbx.checked = sel.has(s.key);
    label.appendChild(cbx);
    label.appendChild(el('span', 'sc-label', s.label));
    container.appendChild(label);
  }
}

let editingUser = null;
renderSectionCheckboxes($('u-sections'), []);

$('btn-add-user').addEventListener('click', async () => {
  const msg = $('u-msg');
  msg.textContent = '';
  const sections = Array.from($('u-sections').querySelectorAll('input:checked')).map((i) => i.value);
  try {
    const data = await api('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: $('u-login').value,
        name: $('u-name').value,
        password: $('u-password').value,
        role: $('u-role').value,
        sections,
      }),
    });
    msg.textContent = `Создан: ${data.user.login}`;
    $('u-login').value = '';
    $('u-name').value = '';
    $('u-password').value = '';
    loadUsers();
  } catch (e) {
    msg.textContent = e.message;
  }
});

function openUserSections(u) {
  editingUser = u;
  renderSectionCheckboxes($('us-list'), u.sections || []);
  $('us-msg').textContent = '';
  $('us-modal').classList.remove('hidden');
}

$('us-close').addEventListener('click', () => $('us-modal').classList.add('hidden'));
$('us-modal').addEventListener('click', (e) => {
  if (e.target.id === 'us-modal') $('us-modal').classList.add('hidden');
});

$('us-save').addEventListener('click', async () => {
  const msg = $('us-msg');
  msg.textContent = '';
  if (!editingUser) return;
  const sections = Array.from($('us-list').querySelectorAll('input:checked')).map((i) => i.value);
  try {
    await api('/api/users/' + encodeURIComponent(editingUser.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sections }),
    });
    msg.textContent = 'Сохранено';
    $('us-modal').classList.add('hidden');
    loadUsers();
  } catch (e) {
    msg.textContent = e.message;
  }
});

$('btn-refresh-users').addEventListener('click', loadUsers);

checkAuth();
