// Минимальный IMAP4rev1 клиент на чистом Node (без внешних зависимостей).
// Логин, выбор папки, поиск непрочитанных писем от отправителя,
// загрузка заголовка и тела, пометка прочитанным.
const tls = require('node:tls');

// IMAP-кодировка имени папки (модифицированный UTF-7, RFC 3501 §5.1.3).
// Русские/не-ASCII имена папок в командах MOVE/COPY/SELECT сервер ожидает
// именно в этой кодировке, а не в сыром UTF-8.
function encodeModifiedUTF7(str) {
  const input = String(str || '');
  let out = '';
  let seg = '';
  const flush = () => {
    if (!seg) return;
    const le = Buffer.from(seg, 'utf16le');
    // переводим UTF-16LE в UTF-16BE (попарно меняем байты)
    const be = Buffer.allocUnsafe(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
    const b64 = be.toString('base64').replace(/=+$/, '').replace(/\+/g, ',');
    out += '&' + b64 + '-';
    seg = '';
  };
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (ch === '&') { flush(); out += '&-'; }
    else if (code < 0x80 && code !== 0) { flush(); out += ch; }
    else { seg += ch; }
  }
  flush();
  return out;
}

// Обратное преобразование: modified UTF-7 -> юникод.
// Строки без сегментов "&...-" возвращаются как есть (там и так юникод).
function decodeModifiedUTF7(str) {
  const input = String(str || '');
  const out = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === '&') {
      let j = i + 1;
      while (j < input.length && input[j] !== '-') j++;
      const payload = input.slice(i + 1, j);
      i = j + 1;
      if (payload === '') { out.push('&'); continue; } // "&-" => литеральный &
      const b64 = payload.replace(/,/g, '+');
      const pad = b64.length % 4 === 2 ? 2 : (b64.length % 4 === 3 ? 1 : 0);
      const buf = Buffer.from(b64 + '='.repeat(pad), 'base64');
      const le = Buffer.allocUnsafe(buf.length);
      for (let k = 0; k + 1 < buf.length; k += 2) { le[k] = buf[k + 1]; le[k + 1] = buf[k]; }
      out.push(le.toString('utf16le'));
    } else {
      out.push(input[i]);
      i++;
    }
  }
  return out.join('');
}

// Привести имя папки к IMAP-кодировке РОВНО один раз: если пользователь вписал
// уже закодированную строку (как её вернул LIST), сначала декодируем её в юникод,
// затем кодируем заново. Так двойное кодирование не возникает.
function toIMAPFolder(raw) {
  const s = String(raw || '');
  const decoded = decodeModifiedUTF7(s);
  return encodeModifiedUTF7(decoded);
}

// Варианты имени папки для отправки в IMAP-команды. Яндекс.Почта (как и ряд
// серверов с UTF8=ACCEPT) хранит и возвращает в LIST имена в UTF-8, а не в
// modified-UTF7. Поэтому пробуем оба формата: сначала raw UTF-8, затем
// modified-UTF7. Возвращает массив экранированных (для кавычек) имён.
function folderVariants(raw) {
  const utf8 = String(raw || '');
  const mod = toIMAPFolder(utf8);
  const esc = (s) => s.replace(/"/g, '\\"');
  const out = [];
  const push = (v) => { if (!out.includes(v)) out.push(v); };
  push(esc(utf8));
  push(esc(mod));
  return out;
}

class ImapClient {
  constructor(options) {
    this.options = options || {};
    this.host = options.host || 'imap.yandex.ru';
    this.port = options.port || 993;
    this.user = options.user || '';
    this.password = options.password || '';
    this.folder = options.folder || 'INBOX';
    this.timeout = options.timeout || 30000;
    this.socket = null;
    this.buffer = '';
    this.nextTag = 1;
    this.pending = new Map();
    // состояние литерала
    this.pendingLiteral = null; // { remaining }
    this.pendingLine = '';      // строка, перед которой ожидался литерал
    this.fetchCb = null;        // callback для FETCH-строк
    this.searchCb = null;       // callback для SEARCH-списка
    this.listCb = null;         // callback для LIST-списка папок
    this.listNames = [];
    this.onGreeting = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({
        host: this.host,
        port: this.port,
        rejectUnauthorized: false,
        servername: this.host
      });
      this.socket = sock;
      sock.setTimeout(this.timeout);
      const fatal = (err) => { sock.destroy(); reject(err); };
      sock.once('error', fatal);
      sock.on('timeout', () => fatal(new Error('IMAP timeout')));
      sock.on('data', (chunk) => this._onData(chunk));
      const timer = setTimeout(() => fatal(new Error('No greeting from server')), this.timeout);
      this.onGreeting = () => { clearTimeout(timer); resolve(); };
    });
  }

  _onData(chunk) {
    this.buffer += chunk.toString('binary');
    this._process();
  }

  _process() {
    // 1) если ждём литерал
    if (this.pendingLiteral) {
      const take = Math.min(this.pendingLiteral.remaining, this.buffer.length);
      const part = this.buffer.slice(0, take);
      this.buffer = this.buffer.slice(take);
      this.pendingLiteral.remaining -= take;
      if (this.pendingLiteral.remaining <= 0) {
        // литерал завершён — добавим данные к текущей строке
        if (this.pendingLiteral.attach) {
          this.pendingLiteral.attach(part);
        }
        this.pendingLiteral = null;
        // после литерала может идти остаток строки => продолжим
        if (this.buffer.length) this._process();
      }
      return;
    }

    // 2) ищем завершённые строки (CRLF)
    let idx;
    while ((idx = this.buffer.indexOf('\r\n')) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      // если строка заканчивается на {N}, следующий фрагмент — литерал
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        const size = parseInt(litMatch[1], 10);
        // убираем маркер, оставляем префикс строки
        const prefix = line.replace(/\s*\{\d+\}$/, '');
        if (size === 0) {
          // пустой литерал
          this._handleLine(line);
          continue;
        }
      this.pendingLiteral = {
        remaining: size,
        attach: (data) => {
          this._handleLine({ prefix, literal: data });
          this.pendingLiteral._handled = true;
          }
        };
        this.pendingLiteral._builtLine = line;
        // не продолжаем — ждём литерал
        if (this.buffer.length) this._process();
        return;
      }
      this._handleLine(line);
    }
  }

  _handleLine(lineOrObj) {
    if (typeof lineOrObj !== 'string') {
      // FETCH с литералом: lineOrObj = { prefix, literal }
      const { prefix, literal } = lineOrObj;
      if (/^\* LIST/i.test(prefix)) {
        if (this.listCb) this.listCb(String(literal || ''));
      } else if (this.fetchCb) {
        this.fetchCb(parseFetch(prefix, literal));
      }
      return;
    }
    const line = lineOrObj.trim();
    if (!line) return;

    // continuation request от сервера ("+ ...") — например для AUTHENTICATE
    if (line.startsWith('+') && this.continuationCb) {
      const cb = this.continuationCb;
      this.continuationCb = null;
      cb(line.slice(1).trim());
      return;
    }

    if (line.startsWith('* OK')) {
      if (this.onGreeting) { const g = this.onGreeting; this.onGreeting = null; g(); }
      return;
    }
    if (line.startsWith('* BYE')) {
      this._failAll(new Error('Server BYE: ' + line));
      return;
    }

    const tagMatch = line.match(/^A(\d+)\s+(OK|NO|BAD)\b[\s]*(.*)$/);
    if (tagMatch) {
      const tag = parseInt(tagMatch[1], 10);
      const p = this.pending.get(tag);
      if (p) {
        this.pending.delete(tag);
        p.resolve({ status: tagMatch[2], msg: tagMatch[3] });
      }
      return;
    }

    // untagged
    if (line.startsWith('*')) {
      const listMatch = line.match(/^\* LIST\s*\([^)]*\)\s+[\S]+\s+"((?:[^"\\]|\\.)*)"\s*$/i);
      if (listMatch && this.listCb) {
        this.listCb(listMatch[1]);
        return;
      }
      const fetchMatch = line.match(/^\* (\d+) FETCH\s*\((.*)\)$/i);
      if (fetchMatch) {
        if (this.fetchCb) this.fetchCb(parseFetch(line, null));
        return;
      }
      const srch = line.match(/^\* (?:SEARCH)(.*)$/i);
      if (srch) {
        const nums = srch[1].trim().split(/\s+/).filter(Boolean).map(Number);
        if (this.searchCb) this.searchCb(nums);
        return;
      }
      // прочие (EXISTS, FLAGS, OK ...) — игнорируем
    }
  }

  _sendCommand(cmd) {
    return new Promise((resolve, reject) => {
      const tag = this.nextTag++;
      this.pending.set(tag, { resolve, reject });
      this.socket.write(`A${tag} ${cmd}\r\n`, 'binary');
    });
  }

  async login() {
    // 1) AUTHENTICATE PLAIN: base64("\0user\0pass") — не требует экранирования,
    // любые спецсимволы в пароле (кавычки, слеши, переводы строк) безопасны.
    try {
      const res = await new Promise((resolve, reject) => {
        const tag = this.nextTag++;
        this.pending.set(tag, { resolve, reject });
        this.socket.write(`A${tag} AUTHENTICATE PLAIN\r\n`, 'binary');
        this.continuationCb = () => {
          const payload = Buffer.from('\0' + this.user + '\0' + this.password, 'utf8').toString('base64');
          this.socket.write(payload + '\r\n', 'binary');
        };
      });
      if (res.status === 'OK') return res;
      if (res.status !== 'BAD' && res.status !== 'NO') {
        throw new Error('IMAP LOGIN failed: ' + res.msg);
      }
      // BAD/NO — механизм PLAIN не принят, переходим на LOGIN
    } catch (e) {
      if (/PLAIN/i.test(e.message || '') && /(BAD|NO)/i.test(e.message || '')) {
        // fall через
      } else {
        throw e;
      }
    }

    // 2) fallback: классический LOGIN (для серверов без PLAIN).
    // Экранирование корректно только для паролей без кавычек/слешей,
    // поэтому это запасной вариант.
    const esc = (s) => String(s).replace(/(["\\])/g, '\\$1');
    const res = await this._sendCommand(`LOGIN "${esc(this.user)}" "${esc(this.password)}"`);
    if (res.status !== 'OK') throw new Error('IMAP LOGIN failed: ' + res.msg);
    return res;
  }

  async select(folder) {
    const name = toIMAPFolder(String(folder || 'INBOX'));
    const esc = name.replace(/"/g, '\\"');
    const res = await this._sendCommand(`SELECT "${esc}"`);
    if (res.status !== 'OK') throw new Error('IMAP SELECT failed: ' + res.msg);
    return res;
  }

  async searchUnseenFrom(sender) {
    const nums = await new Promise((resolve, reject) => {
      this.searchCb = resolve;
      const where = ['UNSEEN'];
      if (sender) where.push(`FROM "${String(sender).replace(/"/g, '\\"')}"`);
      this._sendCommand(`SEARCH ${where.join(' ')}`).then(
        (r) => { if (r.status !== 'OK') { this.searchCb = null; reject(new Error('SEARCH failed: ' + r.msg)); } },
        reject
      );
    });
    this.searchCb = null;
    return nums;
  }

  // Получить список папок ящика (LIST "" "*"). Возвращает массив имён.
  // Полезно для диагностики: точное имя папки для перемещения пишем по факту.
  async listFolders() {
    return new Promise((resolve, reject) => {
      this.listNames = [];
      // LIST возвращает имена в modified-UTF7 — декодируем их в юникод, чтобы
      // в интерфейсе показывать русские имена (и вписывать их в настройки).
      this.listCb = (name) => { this.listNames.push(decodeModifiedUTF7(String(name || ''))); };
      const timer = setTimeout(() => {
        this.listCb = null;
        resolve(this.listNames.slice());
      }, 8000);
      this._sendCommand('LIST "" "*"').then(
        (r) => {
          clearTimeout(timer);
          if (r.status !== 'OK') { this.listCb = null; reject(new Error('LIST failed: ' + r.msg)); return; }
          this.listCb = null;
          resolve(this.listNames.slice());
        },
        (err) => { clearTimeout(timer); this.listCb = null; reject(err); }
      );
    });
  }

  async fetchOne(seq, what) {
    const result = await new Promise((resolve, reject) => {
      this.fetchCb = (acc) => { this.fetchCb = null; resolve(acc); };
      this._sendCommand(`FETCH ${seq} ${what}`).then(
        (r) => { if (r.status !== 'OK') { this.fetchCb = null; reject(new Error('FETCH failed: ' + r.msg)); } },
        reject
      );
    });
    return result;
  }

  async markSeen(nums) {
    if (!nums.length) return;
    try {
      await this._sendCommand(`STORE ${nums.join(',')} +FLAGS (\\Seen)`);
    } catch (e) {}
  }

  // Переместить письма (по seq) в папку folder.
  // Сначала пробуем команду MOVE; если сервер её не поддерживает (BAD),
  // делаем COPY + STORE \Deleted + EXPUNGE.
  async move(nums, folder) {
    if (!nums.length) return 0;
    const seqStr = nums.join(',');
    const variants = folderVariants(folder);
    // 1) пробуем MOVE каждым вариантом имени (серверы, поддерживающие MOVE + UTF8)
    for (const esc of variants) {
      try {
        const res = await this._sendCommand(`MOVE ${seqStr} "${esc}"`);
        if (res.status === 'OK') return nums.length;
      } catch (e) { /* переходим к следующему варианту / фолбэку */ }
    }
    // 2) фолбэк: COPY + STORE \Deleted + EXPUNGE (по каждому варианту имени)
    return this._moveByCopy(seqStr, folder, variants);
  }

  // Перемещение через COPY: пробуем каждый вариант имени, и если папка не
  // найдена — создаём её (CREATE) и повторяем.
  async _moveByCopy(seqStr, folderRaw, variants) {
    const ensure = async (esc) => {
      try {
        const res = await this._sendCommand(`CREATE "${esc}"`);
        return res.status === 'OK';
      } catch (e) { return false; }
    };
    let lastErr = null;
    for (const esc of variants) {
      const copyRes = await this._sendCommand(`COPY ${seqStr} "${esc}"`);
      if (copyRes.status === 'OK') {
        try { await this._sendCommand(`STORE ${seqStr} +FLAGS (\\Deleted)`); } catch (e) {}
        try { await this._sendCommand('EXPUNGE'); } catch (e) {}
        return seqStr.split(',').length;
      }
      lastErr = new Error('Папка не найдена (COPY ' + copyRes.status + ': ' + copyRes.msg + '), целевая папка: "' + esc + '"');
      // папки нет — создаём её и пробуем снова
      if (await ensure(esc)) {
        const again = await this._sendCommand(`COPY ${seqStr} "${esc}"`);
        if (again.status === 'OK') {
          try { await this._sendCommand(`STORE ${seqStr} +FLAGS (\\Deleted)`); } catch (e) {}
          try { await this._sendCommand('EXPUNGE'); } catch (e) {}
          return seqStr.split(',').length;
        }
        lastErr = new Error('Папка создана, но COPY всё равно не прошёл (COPY ' + again.status + ': ' + again.msg + ')' + ', целевая папка: "' + esc + '"');
      }
    }
    throw lastErr || new Error('Не удалось переместить письма в папку "' + folderRaw + '"');
  }

  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close() {
    try { if (this.socket) this.socket.end(); } catch (e) {}
    try { if (this.socket) this.socket.destroy(); } catch (e) {}
  }

  async fetchNewEmails(sender) {
    await this.select(this.folder || 'INBOX');
    const nums = await this.searchUnseenFrom(sender);
    if (!nums.length) return [];
    const emails = [];
    for (const n of nums) {
      try {
        const head = await this.fetchOne(n, 'BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)]');
        if (!head) continue;
        const subjectRaw = extractHeaderValue(head.text, 'Subject');
        const subject = decodeHeader(subjectRaw);
        const from = extractHeaderValue(head.text, 'From');
        // Получаем тело несколькими способами: весь TEXT и адресные части (1, 1.1),
        // затем берём наиболее читаемый результат. Для multipart-писем с вложениями
        // BODY.PEEK[TEXT] может вернуть не ту часть, а адресные части дают text/plain.
        const variants = ['BODY.PEEK[TEXT]', 'BODY.PEEK[1]', 'BODY.PEEK[1.1]'];
        let bestText = '';
        let bestScore = -Infinity;
        let rawHeads = [];
        for (const v of variants) {
          let fr;
          try { fr = await this.fetchOne(n, v); } catch (e) { continue; }
          if (!fr || !fr.text) continue;
          const t = fr.text;
          if (rawHeads.length < 3) rawHeads.push(String(t).slice(0, 90));
          const decoded = String(decodeBody(t) || '');
          // оценка читаемости: наличие кириллицы/слов, длина
          const scr = decoded ? (readabilityScore(decoded) + Math.min(decoded.length / 300, 0.5)) : -Infinity;
          if (scr > bestScore) { bestScore = scr; bestText = decoded; }
        }
        emails.push({
          seq: n, from, subject: subject || '', subjectRaw: subjectRaw || '',
          body: bestText || '',
          bodyRawHeads: rawHeads
        });
      } catch (e) {}
    }
    return emails;
  }
}

// Разбор FETCH-строки в двух формах:
//  * 5 FETCH (BODY[...] {123}   — литерал {prefix, literal}
//  * 5 FETCH (... без литерала) — просто строка
function parseFetch(lineOrObj, literal) {
  let prefix = lineOrObj;
  let lit = literal;
  if (typeof lineOrObj === 'object' && lineOrObj !== null) {
    prefix = lineOrObj.prefix;
    lit = lineOrObj.literal;
  }
  prefix = String(prefix);
  const seqMatch = prefix.match(/^\* (\d+) FETCH/i);
  const seq = seqMatch ? parseInt(seqMatch[1], 10) : null;
  const uidMatch = prefix.match(/UID (\d+)/i);
  const uid = uidMatch ? parseInt(uidMatch[1], 10) : null;
  // Сохраняем сырые байты байт-в-байт (latin1), чтобы не портить 8-bit тела
  // (windows-1251 / KOI8-R) декодером UTF-8. Декодирование выполняется позже
  // в decodeBody с учётом кодировки.
  const text = lit ? lit.toString('latin1') : '';
  return { seq, uid, text };
}

// Извлечение значения заголовка с учётом folded lines и переносов
function extractHeaderValue(headerText, name) {
  if (!headerText) return '';
  const lines = headerText.split(/\r?\n/);
  let collecting = false;
  let raw = '';
  for (const l of lines) {
    if (collecting) {
      if (/^[\s\t]/.test(l)) raw += ' ' + l.trim();
      else break;
    } else {
      if (l.toLowerCase().startsWith(name.toLowerCase() + ':')) {
        raw = l.slice(name.length + 1).trim();
        collecting = true;
      }
    }
  }
  return raw;
}

// Декодирование RFC2047 заголовков (=?UTF-8?B?...?= / =?UTF-8?Q?...?=)
function decodeHeader(value) {
  if (!value) return '';
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') {
        return Buffer.from(data, 'base64').toString('utf8');
      } else if (enc.toLowerCase() === 'q') {
        // Quoted-Printable
        return data.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/_/g, ' ');
      }
    } catch (e) {}
    return '';
  });
}

// Оценка «читаемости» строки: штраф за replacement-символы (�) и нечитаемые
// байты, бонус за буквы/цифры/пробелы. Чем выше — тем вероятнее это "живой" текст.
function readabilityScore(str) {
  const s = String(str || '');
  if (!s.length) return -Infinity;
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xFFFD) { score -= 8; continue; }
    // управляющие символы (кроме переносов) — сильный штраф
    if (c < 0x20 && c !== 0x0A && c !== 0x0D && c !== 0x09) { score -= 6; continue; }
    if (c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09) { score += 1; continue; }
    // CJK и декоративные скрипты — почти наверняка мусор от неверной utf16-трактовки
    if ((c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) ||
        (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFE30 && c <= 0xFE4F) ||
        (c >= 0xFF00 && c <= 0xFFEF) || (c >= 0xE000 && c <= 0xF8FF)) { score -= 3; continue; }
    // кириллица — предпочтительна для наших писем (высший приоритет)
    if (c >= 0x0400 && c <= 0x04FF) { score += 4; continue; }
    // Latin-1 верхняя половина («àáâ» и т.п.) — обычно побочный продукт 8-bit мусора
    if (c >= 0x0080 && c <= 0x00FF) { score -= 3; continue; }
    if (c >= 0x20 && c < 0x7F) { score += 1; continue; } // печатный ASCII
    if (/[\p{L}]/u.test(ch)) { score += 3; continue; }     // прочие буквы (греческий и т.п.)
    if (/[\p{N}]/u.test(ch)) { score += 2; continue; }
    score -= 1;
  }
  return score / s.length;
}

// Поменять порядок байт попарно (UTF-16BE -> LE).
function swapBytes(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) { out[i] = buf[i + 1]; out[i + 1] = buf[i]; }
  return out;
}

// Декодировать Windows-1251 (для буфера) в Unicode. Покрывает кириллицу +
// базовые ASCII; редко встречающиеся спецсимволы верхней половины — как есть.
function decodeCp1251(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xC0 && b <= 0xFF) {
      out += String.fromCharCode(b >= 0xE0 ? 0x430 + (b - 0xE0) : 0x410 + (b - 0xC0));
    } else if (b === 0xA8) out += 'Ё';
    else if (b === 0xB8) out += 'ё';
    else out += String.fromCharCode(b);
  }
  return out;
}

// Нормализовать имя кодировки из MIME-заголовка ("WINDOWS-1251" -> "cp1251").
function normalizeCharset(name) {
  const n = String(name || '').trim().toLowerCase().replace(/[_\s-]/g, '');
  if (n === 'windows1251' || n === 'cp1251' || n === 'win1251' || n === 'windows1252') return 'cp1251';
  if (n === 'koi8r' || n === 'koi8u' || n === 'koi8') return 'koi8';
  if (n === 'cp866' || n === 'ibm866' || n === '866') return 'cp866';
  if (n === 'utf8' || n === 'utf') return 'utf8';
  if (n === 'utf16le' || n === 'utf16') return 'utf16le';
  if (n === 'utf16be') return 'utf16be';
  if (n === 'latin1' || n === 'iso88591' || n === 'iso8859') return 'latin1';
  return null;
}

// Декодировать буфер в юникод по КОНКРЕТНОЙ кодировке. Возвращает строку.
function decodeByCharset(buf, charset) {
  switch (charset) {
    case 'cp1251': return decodeCp1251(buf);
    case 'cp866': return decodeCp866(buf);
    case 'koi8': return decodeKoi8R(buf);
    case 'utf16le': return buf.toString('utf16le');
    case 'utf16be': return swapBytes(buf).toString('utf16le');
    case 'latin1': return buf.toString('latin1');
    case 'utf8':
    default: return buf.toString('utf8');
  }
}

// Перебрать вероятные кодировки буфера и вернуть наиболее читаемый текст.
// При указанном charset он пробуется первым (и считается авторитетным, если
// даёт приемлемую читаемость); иначе — полный перебор. Возвращает строку или null.
function decodeBest(buf, declaredCharset, threshold) {
  const thr = threshold === undefined ? 0.35 : threshold;
  const order = [];
  if (declaredCharset) order.push(declaredCharset);
  // всегда добираем перебор по остальным, если заявленный не дал результата
  const rest = ['utf8', 'cp1251', 'utf16le', 'utf16be', 'koi8', 'cp866', 'latin1']
    .filter((c) => !order.includes(c));
  order.push(...rest);

  let best = null;
  let bestScore = thr;
  for (const cs of order) {
    try {
      const s = decodeByCharset(buf, cs);
      if (!s) continue;
      const sc = readabilityScore(s);
      if (sc > bestScore) { best = s; bestScore = sc; }
    } catch (e) {}
  }
  return bestScore > thr ? best : null;
}

// Перебрать ВАРИАНТЫ выравнивания байтов (исходный, со сдвигом на байт, с
// перестановкой пар) и в каждом — кодировки. Нужно для «съехавших» писем,
// где потерян/добавлен один байт или перепутан порядок 16-битных слов.
// Возвращает наиболее читаемый вариант или null, если ни один не прошёл порог.
function decodeAlign(buf, declaredCharset, threshold) {
  const thr = threshold === undefined ? 0.4 : threshold;
  const variants = [];
  if (buf.length) variants.push(['as-is', buf]);
  if (buf.length > 4) {
    const sw = Buffer.allocUnsafe(buf.length);
    for (let i = 0; i + 1 < buf.length; i += 2) { sw[i] = buf[i + 1]; sw[i + 1] = buf[i]; }
    variants.push(['swap', sw]);
  }

  let best = null;
  let bestScore = thr;
  for (const [, vbuf] of variants) {
    const d = decodeBest(vbuf, declaredCharset, thr);
    if (!d) continue;
    const sc = readabilityScore(d);
    if (sc > bestScore) { best = d; bestScore = sc; }
  }
  return bestScore > thr ? best : null;
}

// Почистить декодированный текст: убрать HTML/XML-разметку, base64-хвосты и
// мусор из multipart-обёртки, нормализовать переносы. Возвращает строку.
function cleanDecodedText(s) {
  let t = String(s || '');
  // 1) вырезаем HTML-блоки вместе с их содержимым (тело бывает в HTML-части)
  //    но НЕ вырезаем видимый текст — оставляем текст без тэгов
  t = t
    // стили/скрипты целиком
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // прочие открывающие/закрывающие/самозакрывающиеся тэги и комментарии
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    // HTML-сущности самого частого вида
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; } });
  // 2) нормализуем переносы и пустые строки
  t = t
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return t;
}

// Разобрать MIME-контейнер и вернуть { text, note } содержимого ПЕРВОЙ части
// text/plain (если она есть). Если это не multipart — возвращает null (обрабатываем
// текст как есть). Декодирует часть по Content-Transfer-Encoding (base64/QP) и
// charset. Нужно, чтобы для multipart-писем с вложениями/HTML (BODY.PEEK[TEXT]
// возвращает весь контейнер) тело бралось именно из текстовой части, а не из
// base64-вложений или HTML-кода.
function extractTextPart(mimeText) {
  const t = String(mimeText || '');
  const marker = 'Content-Type: text/plain';
  const idx = t.indexOf(marker);
  if (idx < 0) return null;
  // конец заголовков части — первая пустая строка после маркера
  const bodyStart = t.indexOf('\n\n', idx);
  if (bodyStart < 0) return null;
  const headers = t.slice(idx, bodyStart);
  // тело части — до следующей MIME-границы (строка, начинающаяся с '--')
  let end = t.indexOf('\r\n--', bodyStart + 2);
  if (end < 0) end = t.indexOf('\n--', bodyStart + 2);
  if (end < 0) end = t.length;
  let payload = t.slice(bodyStart + 2, end);
  // Декодируем по Content-Transfer-Encoding
  if (/base64/i.test(headers)) {
    try {
      payload = Buffer.from(payload.trim(), 'base64').toString('latin1');
    } catch (e) {}
  } else if (/quoted-printable/i.test(headers)) {
    payload = payload.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return { text: payload, charset: null };
}

// Декодирование тела письма: поддерживает MIME base64 и quoted-printable,
// перебирает кодировки и чистит HTML-разметку. Отвечает за то, чтобы текст,
// попавший в журнал, был по-настоящему читаемым.
function decodeBody(text) {
  if (!text) return '';

  // 0) Если это MIME-контейнер (multipart) с вложениями/HTML — извлекаем
  //    именно text/plain часть (мир текст письма), а не пытаемся декодировать
  //    весь контейнер (в т.ч. base64-вложения) как единый текст.
  const extracted = extractTextPart(text);
  if (extracted && extracted.text) text = extracted.text;

  // Ищем заявленную кодировку в MIME-заголовках (если они есть в тексте).
  const cm = text.match(/charset\s*=\s*["']?([A-Za-z0-9._-]+)["']?/i);
  const charset = cm ? normalizeCharset(cm[1]) : null;

  // 0) Тело в 8-bit кодировке (windows-1251 / KOI8-R / cp866). parseFetch
  // вернул сырые байты как latin1 — декодируем их в юникод, иначе русские
  // «Артикул: / Номер инвойса:» в цитируемом тексте не извлекаются.
  // ВАЖНО: если текст уже выглядит как юникод (кириллица читается), не трогаем.
  let eightBit = text;
  let needClean = false;
  const hasUnicodeCyrillic = /[\u0400-\u04FF]/.test(text);
  const hasHighBytes = /[^\x00-\x7F]/.test(text);
  // Если юникод-кириллица уже есть — текст декодирован, его не трогаем.
  // Иначе, если есть старшие байты — вероятно 8-bit (cp1251/KOI8/UTF-8),
  // пробуем раскодировать перебором с приоритетом заявленного charset.
  if (!hasUnicodeCyrillic && hasHighBytes) {
    const buf = Buffer.from(text, 'latin1');
    const d8 = decodeAlign(buf, charset, 0.4);
    if (d8) { eightBit = d8; needClean = d8 !== text; }
  }

  // 1) Если объявлен base64 — вырезаем блок base64 (строки из base64-алфавита)
  if (/(^|\r?\n)Content-Transfer-Encoding:\s*base64/i.test(eightBit)) {
    const block = extractBase64Block(eightBit);
    if (block) {
      try {
        let b = block;
        while (b.length % 4 !== 0) b += '=';
        const buf = Buffer.from(b, 'base64');
        const dec = decodeBest(buf, charset, 0.35);
        if (dec) return cleanDecodedText(dec);
      } catch (e) {}
    }
  }

  // 2) quoted-printable
  if (/(^|\r?\n)Content-Transfer-Encoding:\s*quoted-printable/i.test(eightBit)) {
    try {
      let qp = decodeQuotedPrintable(eightBit);
      if (qp) {
        // после раскодирования =XX кириллица в windows-1251 приходит как
        // latin1 (U+00xx) — превращаем её в настоящий юникод перебором кодировок.
        if (!/[\u0400-\u04FF]/.test(qp) && /[^\x00-\x7F]/.test(qp)) {
          const dq = decodeBest(Buffer.from(qp, 'latin1'), charset, 0.35);
          if (dq) qp = dq;
        }
        if (qp) return cleanDecodedText(qp);
      }
    } catch (e) {}
  }

  // 2b) quoted-printable БЕЗ MIME-заголовка: письмо приходит как text/plain в
  // QP (например от am-torg / некоторых магазинов), но BODY.PEEK не отдаёт
  // Content-Transfer-Encoding части. Распознаём по паттерну =XX и декодируем.
  if (looksLikeQuotedPrintable(eightBit)) {
    try {
      const dec = decodeQpToUtf8(eightBit);
      if (dec && /[\u0400-\u04FF\w]/.test(dec)) return cleanDecodedText(dec);
    } catch (e) {}
  }

  // 3) Фолбэк: тело без MIME-заголовков (BODY.PEEK[TEXT] не отдаёт
  // Content-Transfer-Encoding вложенной части). Извлекаем сплошной base64-блок
  // и декодируем его перебором кодировок.
  try {
    const frag = extractBase64Fragment(eightBit);
    if (frag && frag.length >= 24) {
      let b = frag;
      while (b.length % 4 !== 0) b += '=';
      const buf = Buffer.from(b, 'base64');
      const dec = decodeBest(buf, charset, 0.4);
      if (dec) return cleanDecodedText(dec);
    }
  } catch (e) {}

  // 3b) base64-HTML: некоторые письма (напр. OMEGA) приходят целиком как
  // base64-закодированный HTML (Content-Type: text/html; charset=utf-8 + CTE
  // base64). BODY.PEEK[TEXT] в них не содержит MIME-заголовков части, поэтому
  // выше блок не извлёкся. Если тело похоже на сплошной base64 — декодируем и
  // вытаскиваем текст из HTML.
  if (isMostlyBase64(eightBit)) {
    try {
      let clean = eightBit.replace(/[^A-Za-z0-9+/=]/g, '');
      while (clean.length % 4 !== 0) clean += '=';
      const rawBuf = Buffer.from(clean, 'base64');
      const dec = decodeBest(rawBuf, charset, 0.35);
      if (dec && /<[a-zA-Z!]/.test(dec)) return cleanDecodedText(dec);
      if (dec && dec.length > 20) {
        // даже без тегов — если декод дал читаемый русский, отдаём его
        const scr = readabilityScore(dec);
        if (scr > 0.5) return cleanDecodedText(dec);
      }
    } catch (e) {}
  }

  // 4) Обычный (не base64, не QP) текст: 8-бит уже раскодирован выше.
  //    Чистим HTML-разметку, если она попалась.
  if (needClean || /<\w[^>]*>/.test(eightBit)) return cleanDecodedText(eightBit);

  return cleanDecodedText(eightBit);
}

// Проверить, что текст почти целиком состоит из base64-алфавита
// (письмо, закодированное как base64-HTML). Возвращает true/false.
function isMostlyBase64(s) {
  const t = String(s || '');
  if (t.length < 24) return false;
  let b64 = 0;
  for (const ch of t) {
    const c = ch;
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '+' || c === '/' || c === '=') b64++;
  }
  return b64 / t.length > 0.9;
}

// Декодировать буфер Windows-866 (альтернативная кодировка кириллицы).
function decodeCp866(buf) {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) out += String.fromCharCode(b);
    // CP866: 0x80–0xAF — заглавные А–Я, 0xE0–0xEF — строчные а–п,
    // 0xF0–0xFF — строчные р–я.
    else if (b >= 0x80 && b <= 0xAF) out += String.fromCharCode(0x410 + (b - 0x80));   // А-Я
    else if (b >= 0xE0 && b <= 0xEF) out += String.fromCharCode(0x430 + (b - 0xE0));   // а-п
    else if (b >= 0xF0 && b <= 0xFF) out += String.fromCharCode(0x440 + (b - 0xF0));   // р-я
    else out += String.fromCharCode(b);
  }
  return out;
}

// Декодировать буфер KOI8-R (кириллица). Строки сопоставления: диапазоны
// 0xE1–0xFE покрывают русские буквы в порядке а-я/А-Я по особой схеме.
// Используем свёрнутую таблицу для корректного отображения основных букв.
function decodeKoi8R(buf) {
  let out = '';
  // таблица KOI8-R: индекс = b - 0x80, значение = Unicode-код символа
  // (ASCII-часть в таблице повторяема, но покрываем только кириллицу 0xE0+)
  const HI = [
    /*0xE0-0xFF*/ 0x044E,0x0430,0x0431,0x0446,0x0434,0x0435,0x0444,0x0433,
    0x0445,0x0438,0x0439,0x043A,0x043B,0x043C,0x043D,0x043E,
    0x043F,0x044F,0x0440,0x0441,0x0442,0x0443,0x0436,0x0432,
    0x044C,0x044B,0x0437,0x0448,0x044D,0x0449,0x0447,0x044A
  ];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b >= 0xE0 && b <= 0xFF) out += String.fromCharCode(HI[b - 0xE0]);
    else out += String.fromCharCode(b);
  }
  return out;
}

// Извлечь подряд идущий блок строк, состоящих только из base64-алфавита.
// Нужно для тела multipart-письма, где BODY.PEEK[TEXT] вернул закодированный
// текст БЕЗ MIME-заголовка Content-Transfer-Encoding.
function extractBase64Fragment(text) {
  const lines = String(text || '').split(/\r?\n/);
  let out = '';
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) { if (out) break; continue; }
    if (/^[A-Za-z0-9+/=]+$/.test(t)) out += t;
    else { if (out) break; }
  }
  return out.length >= 24 ? out : null;
}

// Извлечь строки base64 из текста (между заголовками/boundary)
function extractBase64Block(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let started = false;
  for (const ln of lines) {
    const t = ln.trim();
    if (!started) {
      // начинаем после строки Content-Transfer-Encoding: base64
      if (/^Content-Transfer-Encoding:\s*base64/i.test(t)) {
        started = true;
      }
      continue;
    }
    // стоп на boundary или следующем заголовке
    if (/^--/.test(t) || /^[A-Za-z-]+:/.test(t) || t === '') {
      if (/^[A-Za-z-]+:/.test(t)) break;
      continue;
    }
    if (/^[A-Za-z0-9+/=]+$/.test(t)) out.push(t);
  }
  if (out.length) return out.join('');
  return null;
}

// Декодировать quoted-printable + раскодировать =XX в utf8
function decodeQuotedPrintable(text) {
  let started = false;
  const lines = [];
  for (const ln of text.split(/\r?\n/)) {
    const t = ln.trim();
    if (!started) {
      if (/^Content-Transfer-Encoding:\s*quoted-printable/i.test(t)) { started = true; }
      continue;
    }
    if (/^--/.test(t) || /^[A-Za-z-]+:/.test(t)) break;
    lines.push(t);
  }
  const raw = lines.join('\r\n');
  // мягкие переносы "=\r\n"
  return raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Проверить, что текст похож на quoted-printable сырец (много =XX, ещё нет
// декодированной кириллицы). Нужно, чтобы ловить QP-части без MIME-заголовка.
function looksLikeQuotedPrintable(s) {
  const t = String(s || '');
  if (t.length < 12) return false;
  const matches = t.match(/=([0-9A-Fa-f]{2})/g) || [];
  const cyr = (t.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyr > 4) return false; // уже русский текст — не QP-сырец
  return matches.length >= 4 && (matches.length * 3) / t.length > 0.15;
}

// Декодировать quoted-printable (без заголовка) в юникод: =XX -> байты -> UTF-8.
function decodeQpToUtf8(s) {
  const cleaned = String(s || '').replace(/=\r?\n/g, '').replace(/=\r/g, '');
  const latin = cleaned.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const buf = Buffer.from(latin, 'latin1');
  return decodeBest(buf, null, 0.3) || '';
}

// Почистить декодированный текст от управляющих "0a/0d" и служебных символов
function cleanDecoded(dec) {
  return dec
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .trim();
}

module.exports = { ImapClient, decodeBody, decodeHeader };
