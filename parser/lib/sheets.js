// Работа с Google Sheets API на чистом Node (без внешних зависимостей).
// Поддерживает авторизацию через Service Account (JWT + RS256) и через
// простой Google API-ключ (для публично доступной таблицы).
const crypto = require('node:crypto');

class SheetsClient {
  constructor(cfg) {
    this.cfg = cfg || {};
    this.spreadsheetId = cfg.spreadsheetId || '';
    this.sheetName = cfg.sheetName || 'Sheet1';
    this.articleCol = (cfg.articleCol || 'A').toUpperCase();
    this.statusCol = (cfg.statusCol || 'B').toUpperCase();
    this.headerRow = cfg.headerRow || 1;
    this.token = null;
    this.tokenExp = 0;
  }

  isConfiguredKey() {
    return !!(this.cfg.apiKey && this.spreadsheetId);
  }

  async _getAccessToken() {
    if (this.cfg.authMethod === 'apiKey') return null;
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;

    let sa;
    try {
      sa = typeof this.cfg.serviceAccountJson === 'string'
        ? JSON.parse(this.cfg.serviceAccountJson)
        : this.cfg.serviceAccountJson;
    } catch (e) {
      throw new Error('Неверный JSON Service Account');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const claims = {
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now
    };
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = b64(header) + '.' + b64(claims);
    const key = sa.private_key;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(data), key);
    const assertion = data + '.' + sig.toString('base64url');

    const resp = await fetch(sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString()
    });
    const j = await resp.json();
    if (!j.access_token) throw new Error('Не удалось получить токен Google: ' + (j.error_description || j.error || resp.status));
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }

  _uri(path, params) {
    const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(this.spreadsheetId);
    const q = new URLSearchParams(params || {});
    return base + path + (q.toString() ? '?' + q.toString() : '');
  }

  async _authFetch(url, options = {}) {
    const token = await this._getAccessToken();
    const headers = { ...(options.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const resp = await fetch(url, { ...options, headers });
    let body;
    try { body = await resp.json(); } catch (e) { body = null; }
    if (!resp.ok) {
      const msg = (body && (body.error && (body.error.message || body.error.status))) || resp.statusText;
      throw new Error('Google Sheets: ' + msg + ' (HTTP ' + resp.status + ')');
    }
    return body;
  }

  // Прочитать весь лист. Индексы значений совпадают с буквами колонок:
  // values[row][0] = колонка A, values[row][5] = колонка F и т.д.
  // (раньше читался только диапазон articleCol:statusCol со сдвигом индексов,
  //  из-за чего поиск по настроенной колонке работал неверно)
  async readArticles() {
    const url = this._uri('/values/' + encodeURIComponent(this.sheetName));
    const data = await this._authFetch(url);
    return data.values || [];
  }

  // Записать статус конкретной строке. col — буква столбца (по умолчанию statusCol).
  async writeStatus(rowIndex, status, col) {
    const targetCol = (col || this.statusCol || 'B').toUpperCase();
    const cell = `${this.sheetName}!${targetCol}${rowIndex}`;
    // values.update требует valueInputOption; RAW — записываем значение как есть
    const url = this._uri('/values/' + encodeURIComponent(cell), { valueInputOption: 'RAW' });
    await this._authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: cell, majorDimension: 'ROWS', values: [[String(status)]] })
    });
  }
}

// Найти строку по артикулу в колонке A (с учётом headerRow)
function findRowForArticle(rows, article, articleCol, headerRow) {
  const d = findRowForArticleDetailed(rows, article, articleCol, headerRow);
  return d ? d.row : null;
}

// Найти ВСЕ строки по артикулу (могут быть дубликаты в таблице).
// Той же логике, что findRowForArticleDetailed, но возвращает массив
// найденных { row, how } по всем совпадениям, а не только первое.
function findAllRowsForArticle(rows, article, articleCol, headerRow) {
  const index = buildArticleIndex(rows, articleCol, headerRow);
  return findAllRowsForArticleIndexed(index, article);
}

// Построить нормализованный индекс значений столбца артикула.
// Нормализация делается ОДИН раз на снимок таблицы, а не на каждое письмо.
// Возвращает { start, byExact, byNorm, needleLetters }-подобную структуру:
//   byExact: Map<normValue, number[]>  — точное совпадение по полному значению
//   byNorm:  Map<normValue, number[]>  — тоже (для префиксного поиска)
//   start:   индекс первой строки данных (headerRow)
// Значения ключей Map — нормализованные (trim + lower) строки ячеек.
function buildArticleIndex(rows, articleCol, headerRow, article) {
  const colIndex = columnLetterToIndex(articleCol);
  const start = headerRow || 1;
  const byNorm = new Map(); // норм. значение -> [номера строк]
  for (let r = start; r < rows.length; r++) {
    const row = rows[r] || [];
    const val = row[colIndex];
    if (val === undefined || val === null) continue;
    const norm = String(val).trim().toLowerCase();
    if (norm === '') continue;
    if (!byNorm.has(norm)) byNorm.set(norm, []);
    byNorm.get(norm).push(r + 1);
  }
  return { start, byNorm };
}

// Поиск всех строк по уже построенному индексу (buildArticleIndex).
// Поведение идентично findAllRowsForArticle, но без повторной нормализации.
function findAllRowsForArticleIndexed(index, article) {
  const { byNorm } = index;
  const needle = String(article).trim().toLowerCase();
  const needleLetters = needle.replace(/[^0-9a-z]/gi, '');
  const found = [];
  const seen = new Set();
  const push = (r, how) => {
    if (seen.has(r)) return;
    seen.add(r);
    found.push({ row: r, how });
  };
  // 1) точное
  if (byNorm.has(needle)) byNorm.get(needle).forEach((r) => push(r, 'exact'));
  // 2) префикс (для строк, пропущенных на точном)
  if (needle) {
    for (const [v, rows] of byNorm) {
      if (v !== needle && (v.startsWith(needle) || needle.startsWith(v))) {
        rows.forEach((r) => push(r, 'prefix'));
      }
    }
  }
  // 3) содержит (по буквенно-цифровой основе)
  if (needleLetters.length >= 4) {
    for (const [v, rows] of byNorm) {
      if (v.includes(needleLetters)) {
        rows.forEach((r) => push(r, 'contains'));
      }
    }
  }
  return found;
}

// Гибкий поиск строки по артикулу в колонке articleCol.
// Порядок: 1) точное совпадение (без пробелов, без учёта регистра);
//          2) значение начинается с артикула; 3) значение содержит артикул.
// Возвращает { row, how } или null. Также `candidates` в отдельном поле
// (непустые значения столбца — для диагностики).
function findRowForArticleDetailed(rows, article, articleCol, headerRow) {
  const index = buildArticleIndex(rows, articleCol, headerRow);
  const needle = String(article).trim().toLowerCase();
  const needleLetters = needle.replace(/[^0-9a-z]/gi, '');

  // 1) точное
  if (index.byNorm.has(needle) && index.byNorm.get(needle).length) {
    return { row: index.byNorm.get(needle)[0], how: 'exact' };
  }

  // 2) значение начинается с артикула
  if (needle) {
    for (const [v, rows] of index.byNorm) {
      if (v !== needle && (v.startsWith(needle) || needle.startsWith(v))) {
        return { row: rows[0], how: 'prefix' };
      }
    }
  }

  // 3) значение содержит артикул (по буквенно-цифровой основе)
  if (needleLetters.length >= 4) {
    for (const [v, rows] of index.byNorm) {
      if (v.includes(needleLetters)) {
        return { row: rows[0], how: 'contains' };
      }
    }
  }
  return null;
}

// Собрать непустые значения столбца (для диагностики в журнале)
function columnValues(rows, articleCol, headerRow, limit) {
  const colIndex = columnLetterToIndex(articleCol);
  const out = [];
  for (let r = headerRow; r < rows.length; r++) {
    const row = rows[r] || [];
    const val = row[colIndex];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      out.push(String(val).trim());
      if (limit && out.length >= limit) break;
    }
  }
  return out;
}

function columnLetterToIndex(letter) {
  let sum = 0;
  for (let i = 0; i < letter.length; i++) {
    sum = sum * 26 + (letter.charCodeAt(i) - 64);
  }
  return sum - 1;
}

module.exports = { SheetsClient, findRowForArticle, findRowForArticleDetailed, findAllRowsForArticle, findAllRowsForArticleIndexed, buildArticleIndex, columnValues, columnLetterToIndex };
