(function () {
  'use strict';

  // Встроенный в BIOTIME режим: страница живёт на /parser/, API-пути
  // дополняем префиксом. При самостоятельном деплое префикс пуст.
  const API_PREFIX = (function () {
    try {
      const src = document.currentScript && document.currentScript.src;
      const p = src ? new URL(src).pathname : '';
      return p.startsWith('/parser/') ? '/parser' : '';
    } catch (_e) { return ''; }
  })();
  const apiPath = (s) => (API_PREFIX || '') + s;

  const MASK = '••••••••';
  const $ = (id) => document.getElementById(id);

  let current = null;       // последние полученные настройки (реальные, с паролем)
  let dirty = false;
  let isAdmin = false;      // роль пользователя (из заголовков шлюза)

  // --- элементы ---
  const els = {
    mailEnabled: $('mailEnabled'),
    mailUser: $('mailUser'),
    mailPassword: $('mailPassword'),
    mailHost: $('mailHost'),
    mailPort: $('mailPort'),
    mailFolder: $('mailFolder'),
    pollMinutes: $('pollMinutes'),
    markSeen: $('markSeen'),
    tableEnabled: $('tableEnabled'),
    spreadsheetId: $('spreadsheetId'),
    openSheetLink: $('openSheetLink'),
    rule03Sender: $('rule03Sender'),
    rule03Sheet: $('rule03Sheet'),
    rule03ArticleCol: $('rule03ArticleCol'),
    rule03StatusCol: $('rule03StatusCol'),
    rule03ReasonCol: $('rule03ReasonCol'),
    rule03LogoCol: $('rule03LogoCol'),
    rule03Pattern: $('rule03Pattern'),
    rule03Trigger: $('rule03Trigger'),
    rule03Enabled: $('rule03Enabled'),
    lblAppName: $('lblAppName'),
    lblMail: $('lblMail'),
    lblTable: $('lblTable'),
    lblRules: $('lblRules'),
    lblRules2: $('lblRules2'),
    lblLog: $('lblLog'),
    authMethod: $('authMethod'),
    serviceAccountJson: $('serviceAccountJson'),
    saFileInput: $('saFileInput'),
    apiKey: $('apiKey'),
    saField: $('saField'),
    keyField: $('keyField'),
    rulesList: $('rulesList'),
    addRuleBtn: $('addRuleBtn'),
    secondaryRulesList: $('secondaryRulesList'),
    addSecondaryRuleBtn: $('addSecondaryRuleBtn'),
    rule03bSender: $('rule03bSender'),
    rule03bSheet: $('rule03bSheet'),
    rule03bArticleCol: $('rule03bArticleCol'),
    rule03bStatusCol: $('rule03bStatusCol'),
    rule03bPattern: $('rule03bPattern'),
    rule03bInvoiceCol: $('rule03bInvoiceCol'),
    rule03bInvoicePattern: $('rule03bInvoicePattern'),
    rule03bTrigger: $('rule03bTrigger'),
    rule03bEnabled: $('rule03bEnabled'),
    checkEnabled: $('checkEnabled'),
    checkInterval: $('checkInterval'),
    checkSheet: $('checkSheet'),
    checkSourceCol: $('checkSourceCol'),
    checkTargetCol: $('checkTargetCol'),
    checkRulesList: $('checkRulesList'),
    checkPoint5Note: $('checkPoint5Note'),
    addCheckRuleBtn: $('addCheckRuleBtn'),
    moveEnabled: $('moveEnabled'),
    moveSpecific: $('moveSpecific'),
    moveFolderSpecific: $('moveFolderSpecific'),
    moveFolderOther: $('moveFolderOther'),
    foldersBtn: $('foldersBtn'),
    foldersList: $('foldersList'),
    saveMsg: $('saveMsg'),
    runBtn: $('runBtn'),
    backupBtn: $('backupBtn'),
    modeValue: $('modeValue'),
    lastRunValue: $('lastRunValue'),
    checkedValue: $('checkedValue'),
    logList: $('logList'),
    logPagination: $('logPagination'),
    readiness: $('readiness'),
    readinessList: $('readinessList')
  };

  // пагинация журнала
  let logEntries = [];
  let logPage = 1;
  let logFilter = 'all'; // 'all' | 'mail' | 'table' — вкладки журнала
  const LOG_PER_PAGE = 20;

  // --- загрузка настроек ---
  async function load() {
    try {
const res = await fetch(apiPath('/api/settings'));
      const data = await res.json();
      current = data.settings || {};
      isAdmin = !!(data.user && data.user.isAdmin);
      applyToForm(current);
      renderMode();
      applyRoleMode();
      await loadLog();
    } catch (e) {
      toast('Не удалось загрузить настройки', true);
    }
  }

  // Режим по роли: администратор — полный доступ, пользователь — только просмотр.
  function applyRoleMode() {
    const canEdit = isAdmin;
    // кнопки записи и запуска
    els.runBtn.style.display = canEdit ? '' : 'none';
    if (els.backupBtn) els.backupBtn.style.display = canEdit ? '' : 'none';
    els.addRuleBtn.style.display = canEdit ? '' : 'none';
    els.addSecondaryRuleBtn.style.display = canEdit ? '' : 'none';
    // все поля форм — только чтение для пользователя
    ['mailEnabled','mailUser','mailPassword','mailHost','mailPort','mailFolder',
     'pollMinutes','markSeen','tableEnabled','spreadsheetId',
     'rule03Sender','rule03Sheet','rule03ArticleCol','rule03StatusCol','rule03ReasonCol','rule03LogoCol','rule03Pattern','rule03Trigger',
     'rule03bSender','rule03bSheet','rule03bArticleCol','rule03bStatusCol','rule03bPattern','rule03bInvoiceCol','rule03bInvoicePattern','rule03bTrigger',
     'authMethod','serviceAccountJson','apiKey',
     'lblAppName','lblMail','lblTable','lblRules','lblRules2','lblLog']
      .forEach((id) => { const el = $(id); if (el) el.disabled = !canEdit; });
    els.saFileInput.disabled = !canEdit;
    // кнопки удаления правил
    document.querySelectorAll('.rule__del').forEach((b) => { b.style.display = canEdit ? '' : 'none'; });
    // баннер режима
    ensureRoleBanner();
    const banner = $('roleBanner');
    if (banner) {
      banner.classList.toggle('hidden', canEdit);
      if (!canEdit) {
        banner.querySelector('.roleBanner__who').textContent = 'вы вошли как пользователь — режим просмотра';
      }
    }
    // перерисовать правила (чтоб удалить деактивированные кнопки)
    els.rulesList.querySelectorAll('.rule__del').forEach((b) => { b.disabled = !canEdit; });
    els.secondaryRulesList.querySelectorAll('.rule__del').forEach((b) => { b.disabled = !canEdit; });
  }

  function ensureRoleBanner() {
    if ($('roleBanner')) return;
    const b = document.createElement('div');
    b.id = 'roleBanner';
    b.className = 'roleBanner hidden';
    const who = document.createElement('span');
    who.className = 'roleBanner__who';
    b.appendChild(who);
    document.querySelector('.shell').insertBefore(b, document.querySelector('.statusbar'));
  }

  function applyToForm(s) {
    const m = s.mail || {};
    const t = s.table || {};
    els.mailEnabled.checked = !!m.enabled;
    els.mailUser.value = m.user || '';
    els.mailPassword.value = m.password ? MASK : '';
    els.mailHost.value = m.host || 'imap.yandex.ru';
    els.mailPort.value = m.port || 993;
    els.mailFolder.value = m.folder || 'INBOX';
    els.pollMinutes.value = m.pollMinutes ?? 5;
    els.markSeen.value = String(!!m.markSeen);
    els.tableEnabled.checked = !!t.enabled;
    els.spreadsheetId.value = t.spreadsheetId || '';
    updateSheetLink();
    els.authMethod.value = t.authMethod || 'serviceAccount';
    els.serviceAccountJson.value = t.serviceAccountJson ? MASK : '';
    els.apiKey.value = t.apiKey ? MASK : '';
    toggleAuthFields();

    const rules = (s.rules && s.rules.items) || [];
    const r03 = rules[0] || {};
    const r03b = rules[1] || {};
    // поля правила 03
    els.rule03Enabled.checked = r03.enabled !== false;
    els.rule03Sender.value = r03.sender || '';
    els.rule03Sheet.value = r03.sheetName || 'Sheet1';
    els.rule03ArticleCol.value = r03.articleCol || 'A';
    els.rule03StatusCol.value = r03.statusCol || 'B';
    els.rule03ReasonCol.value = (r03.reasonCol || '').toUpperCase();
    els.rule03LogoCol.value = (r03.logoCol || '').toUpperCase();
    els.rule03Pattern.value = r03.articlePattern || '';
    els.rule03Trigger.value = r03.triggerStatus || 'Запрос клиента';
    // поля правила 03b
    els.rule03bEnabled.checked = r03b.enabled !== false;
    els.rule03bSender.value = r03b.sender || '';
    els.rule03bSheet.value = r03b.sheetName || 'Sheet1';
    els.rule03bArticleCol.value = r03b.articleCol || 'A';
    els.rule03bStatusCol.value = r03b.statusCol || 'C';
    els.rule03bPattern.value = r03b.articlePattern || '';
    els.rule03bInvoiceCol.value = (r03b.invoiceCol || '').toUpperCase();
    els.rule03bInvoicePattern.value = r03b.invoicePattern || '';
    els.rule03bTrigger.value = r03b.triggerStatus || 'Запрос клиента';

    // правило проверки таблицы
    const ct = s.checkTable || {};
    els.checkEnabled.checked = !!ct.enabled;
    els.checkInterval.value = ct.intervalMin ?? 5;
    els.checkSheet.value = ct.sheetName || 'Sheet1';
    els.checkSourceCol.value = (ct.sourceCol || 'B').toUpperCase();
    els.checkTargetCol.value = (ct.targetCol || 'C').toUpperCase();
    els.checkPoint5Note.value = ct.point5Note || '';
    els.checkRulesList.innerHTML = '';
    const ctrules = ct.rules || [];
    if (!ctrules.length) addCheckRuleRow('', '');
    ctrules.forEach((r) => addCheckRuleRow(r.from, r.to));

    // перемещение писем
    const mv = s.moveRules || {};
    els.moveEnabled.checked = !!mv.enabled;
    els.moveSpecific.value = mv.specificSender || '';
    els.moveFolderSpecific.value = mv.folderSpecific || 'Обработано';
    els.moveFolderOther.value = mv.folderOther || 'Другое';

    // списки ключевых слов
    els.rulesList.innerHTML = '';
    const kw03 = r03.keywords || [];
    if (!kw03.length) addRuleRow('', '');
    kw03.forEach((r) => addRuleRow((r.keywords || []).join(','), r.status));
    els.secondaryRulesList.innerHTML = '';
    const kw03b = r03b.keywords || [];
    if (!kw03b.length) addSecondaryRuleRow('', '');
    kw03b.forEach((r) => addSecondaryRuleRow((r.keywords || []).join(','), r.status));

    // названия разделов
    const labels = (s.ui && s.ui.labels) || {};
    els.lblAppName.value = labels.appName || 'Парсер почты';
    els.lblMail.value = labels.mail || 'Яндекс Почта';
    els.lblTable.value = labels.table || 'Google Таблица';
    els.lblRules.value = labels.rules || 'Правила «текст → статус»';
    els.lblRules2.value = labels.rules2 || 'Второе правило статуса';
    els.lblLog.value = labels.log || 'Журнал';
    applyLabels();
  }

  // Подставить сохранённые названия в заголовки разделов
  function applyLabels() {
    const labels = (current && current.ui && current.ui.labels) || {};
    document.querySelectorAll('[data-label]').forEach((el) => {
      const key = el.getAttribute('data-label');
      const text = labels && labels[key];
      if (text === undefined || text === null) return;
      // убираем старые текстовые узлы
      el.childNodes.forEach((n) => { if (n.nodeType === 3) el.removeChild(n); });
      const num = el.querySelector('.card__num');
      if (num) num.insertAdjacentText('afterend', String(text));
      else el.appendChild(document.createTextNode(String(text)));
    });
  }

  function toggleAuthFields() {
    const sa = els.authMethod.value === 'serviceAccount';
    els.saField.classList.toggle('hidden', !sa);
    els.keyField.classList.toggle('hidden', sa);
  }

  function addRuleRow(keywords, status) {
    const row = document.createElement('div');
    row.className = 'rule';
    const kw = document.createElement('input');
    kw.type = 'text'; kw.placeholder = 'ключевые слова через запятую'; kw.value = keywords;
    const st = document.createElement('input');
    st.type = 'text'; st.placeholder = 'статус'; st.value = status;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'rule__del'; del.textContent = '×';
    del.title = 'Удалить правило';
    del.addEventListener('click', () => {
      row.remove(); dirty = true; scheduleAutoSave();
    });
    ;[kw, st].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
    row.appendChild(kw); row.appendChild(st); row.appendChild(del);
    els.rulesList.appendChild(row);
  }

  function addSecondaryRuleRow(keywords, status) {
    const row = document.createElement('div');
    row.className = 'rule';
    const kw = document.createElement('input');
    kw.type = 'text'; kw.placeholder = 'ключевые слова через запятую'; kw.value = keywords;
    const st = document.createElement('input');
    st.type = 'text'; st.placeholder = 'статус'; st.value = status;
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'rule__del'; del.textContent = '×';
    del.title = 'Удалить правило №2';
    del.addEventListener('click', () => {
      row.remove(); dirty = true; scheduleAutoSave();
    });
    ;[kw, st].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
    row.appendChild(kw); row.appendChild(st); row.appendChild(del);
    els.secondaryRulesList.appendChild(row);
  }

  function addCheckRuleRow(from, to) {
    const row = document.createElement('div');
    row.className = 'rule';
    const a = document.createElement('input');
    a.type = 'text'; a.placeholder = 'если ='; a.value = from || '';
    const b = document.createElement('input');
    b.type = 'text'; b.placeholder = 'записать'; b.value = to || '';
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'rule__del'; del.textContent = '×';
    del.title = 'Удалить правило';
    del.addEventListener('click', () => {
      row.remove(); dirty = true; scheduleAutoSave();
    });
    ;[a, b].forEach((i) => i.addEventListener('input', () => { dirty = true; }));
    row.appendChild(a); row.appendChild(b); row.appendChild(del);
    els.checkRulesList.appendChild(row);
  }

  // --- сборка из формы (с сохранением не меняных секретов) ---
  function collect() {
    const kw03 = [];
    els.rulesList.querySelectorAll('.rule').forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const kws = inputs[0].value.split(',').map((s) => s.trim()).filter(Boolean);
      const status = inputs[1].value.trim();
      if (status) kw03.push({ keywords: kws, status });
    });
    const kw03b = [];
    els.secondaryRulesList.querySelectorAll('.rule').forEach((row) => {
      const inputs = row.querySelectorAll('input');
      const kws = inputs[0].value.split(',').map((s) => s.trim()).filter(Boolean);
      const status = inputs[1].value.trim();
      if (status) kw03b.push({ keywords: kws, status });
    });

    return {
      mail: {
        enabled: els.mailEnabled.checked,
        host: els.mailHost.value.trim() || 'imap.yandex.ru',
        port: parseInt(els.mailPort.value, 10) || 993,
        user: els.mailUser.value.trim(),
        password: els.mailPassword.value === MASK ? (current.mail && current.mail.password) : els.mailPassword.value,
        folder: els.mailFolder.value.trim() || 'INBOX',
        pollMinutes: parseInt(els.pollMinutes.value, 10) || 5,
        markSeen: els.markSeen.value === 'true'
      },
      table: {
        enabled: els.tableEnabled.checked,
        authMethod: els.authMethod.value,
        serviceAccountJson: els.serviceAccountJson.value === MASK
          ? (current.table && current.table.serviceAccountJson)
          : els.serviceAccountJson.value.trim(),
        apiKey: els.apiKey.value === MASK ? (current.table && current.table.apiKey) : els.apiKey.value.trim(),
        spreadsheetId: els.spreadsheetId.value.trim(),
        headerRow: 1
      },
      rules: {
        items: [
          {
            name: 'Правило 03',
            enabled: els.rule03Enabled.checked,
            sender: els.rule03Sender.value.trim(),
            sheetName: els.rule03Sheet.value.trim() || 'Sheet1',
            articleCol: (els.rule03ArticleCol.value.trim() || 'A').toUpperCase(),
            statusCol: (els.rule03StatusCol.value.trim() || 'B').toUpperCase(),
            articlePattern: els.rule03Pattern.value.trim(),
            // Правило 03: сверка по «Номеру инвойса» не используется.
            invoiceCol: '',
            invoicePattern: '',
            // Столбец «Причина» — жёсткая сверка (дополнительно к артикулу).
            reasonCol: els.rule03ReasonCol.value.trim().toUpperCase(),
            // Столбец «Лого поставщика» — жёсткая сверка (дополнительно).
            logoCol: els.rule03LogoCol.value.trim().toUpperCase(),
            quoteMode: false,
            triggerStatus: els.rule03Trigger.value.trim() || 'Запрос клиента',
            keywords: kw03
          },
          {
            name: 'Правило 03b',
            enabled: els.rule03bEnabled.checked,
            sender: els.rule03bSender.value.trim(),
            senderMode: 'exclude',
            sheetName: els.rule03bSheet.value.trim() || 'Sheet1',
            articleCol: (els.rule03bArticleCol.value.trim() || 'A').toUpperCase(),
            statusCol: (els.rule03bStatusCol.value.trim() || 'C').toUpperCase(),
            articlePattern: els.rule03bPattern.value.trim(),
            invoiceCol: els.rule03bInvoiceCol.value.trim().toUpperCase(),
            invoicePattern: els.rule03bInvoicePattern.value.trim(),
            quoteMode: true,
            triggerStatus: els.rule03bTrigger.value.trim() || 'Запрос клиента',
            keywords: kw03b
          }
        ]
      },
      // Правило «Проверка таблицы».
      checkTable: {
        enabled: els.checkEnabled.checked,
        intervalMin: parseInt(els.checkInterval.value, 10) || 5,
        sheetName: els.checkSheet.value.trim() || 'Sheet1',
        sourceCol: (els.checkSourceCol.value.trim() || 'B').toUpperCase(),
        targetCol: (els.checkTargetCol.value.trim() || 'C').toUpperCase(),
        point5Note: els.checkPoint5Note.value.trim(),
        rules: (() => {
          const out = [];
          els.checkRulesList.querySelectorAll('.rule').forEach((row) => {
            const inputs = row.querySelectorAll('input');
            const from = inputs[0] ? inputs[0].value.trim() : '';
            const to = inputs[1] ? inputs[1].value.trim() : '';
            if (from && to) out.push({ from, to });
          });
          return out;
        })()
      },
      // Правило 06 «Перемещение писем»
      moveRules: {
        enabled: els.moveEnabled.checked,
        specificSender: els.moveSpecific.value.trim(),
        folderSpecific: els.moveFolderSpecific.value.trim() || 'Обработано',
        folderOther: els.moveFolderOther.value.trim() || 'Другое'
      },
      ui: {
        labels: {
          appName: els.lblAppName.value.trim() || 'Парсер почты',
          mail: els.lblMail.value.trim() || 'Яндекс Почта',
          table: els.lblTable.value.trim() || 'Google Таблица',
          rules: els.lblRules.value.trim() || 'Правила «текст → статус»',
          rules2: els.lblRules2.value.trim() || 'Второе правило статуса',
          log: els.lblLog.value.trim() || 'Журнал'
        }
      }
    };
  }

  async function save() {
    if (!isAdmin) { toast('Доступ запрещён: требуется роль администратора', true); return; }
    const body = collect();
    setSaving(true);
    try {
const res = await fetch(apiPath('/api/settings'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Ошибка сохранения');
      current = data.settings;
      toast('Сохранено');
      dirty = false;
      renderMode();
      applyLabels();
      // показываем маски снова
      els.mailPassword.value = current.mail.password ? MASK : '';
      els.serviceAccountJson.value = current.table.serviceAccountJson ? MASK : '';
      els.apiKey.value = current.table.apiKey ? MASK : '';
    } catch (e) {
      toast(e.message, true);
    } finally {
      setSaving(false);
    }
  }

  async function runSync() {
    if (!isAdmin) { toast('Запуск доступен только администратору', true); return; }
    setRunning(true);
    try {
const res = await fetch(apiPath('/api/sync'), { method: 'POST' });
      const data = await res.json();
      renderMode();
      renderLast(data.report || data);
      await loadLog();
      if (data.skipped) toast('Цикл не выполнен: ' + skippedText(data.skipped), true);
      // Кнопка «Прогнать сейчас» также запускает «Проверку таблицы» (пункт 5),
      // если она включена — правки в таблице применяются сразу по кнопке.
      try {
const cr = await fetch(apiPath('/api/check-table'), { method: 'POST' });
        const cdata = await cr.json();
        if (cdata && !cdata.skipped && (cdata.written || cdata.matches)) {
          toast(`Проверка таблицы: записано ${cdata.written || 0}`);
        }
      } catch (e2) { /* проверка таблицы — не критична */ }
    } catch (e) {
      toast('Ошибка запуска: ' + e.message, true);
    } finally {
      setRunning(false);
    }
  }

  // Скачать полный бэкап настроек (включая пароли и ключи) файлом JSON.
  async function downloadBackup() {
    if (!isAdmin) { toast('Бэкап доступен только администратору', true); return; }
    try {
const res = await fetch(apiPath('/api/export'), { method: 'GET' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Ошибка выгрузки бэкапа');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = 'backup-settings-' + stamp + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      const data = JSON.parse(await blob.text());
      const keys = Object.keys(data || {}).length;
      toast('Бэкап скачан: разделов ' + keys);
    } catch (e) {
      toast(e.message, true);
    }
  }

  // Показать реальный список папок почтового ящика (по текущим настройкам почты).
  async function showFolderList() {
    if (!isAdmin) { toast('Доступ запрещён: требуется роль администратора', true); return; }
    const box = els.foldersList;
    if (els.foldersBtn) els.foldersBtn.disabled = true;
    try {
const res = await fetch(apiPath('/api/folders'), { method: 'GET' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Ошибка получения папок');
      const folders = data.folders || [];
      box.classList.remove('hidden');
      if (!folders.length) {
        box.innerHTML = '<p class="hint">Папок в ящике не найдено.</p>';
        return;
      }
      box.innerHTML =
        '<p class="hint" style="margin:0 0 8px">Точные имена папок в ящике (скопируйте нужное в поля «Папка»):</p>' +
        folders.map((f) => '<div class="folders-item">' + escHtml(f) + '</div>').join('');
    } catch (e) {
      toast('Не удалось получить папки: ' + e.message, true);
    } finally {
      if (els.foldersBtn) els.foldersBtn.disabled = false;
    }
  }

  function escHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Ссылка «Открыть таблицу» — формирует URL Google Таблицы по ID.
  function updateSheetLink() {
    const id = (els.spreadsheetId && String(els.spreadsheetId.value || '').trim()) || '';
    if (id) {
      els.openSheetLink.href = 'https://docs.google.com/spreadsheets/d/' + encodeURIComponent(id) + '/edit';
      els.openSheetLink.style.display = 'inline-block';
    } else {
      els.openSheetLink.href = '#';
      els.openSheetLink.style.display = 'none';
    }
  }

  function renderMode() {
    const m = current.mail || {};
    const t = current.table || {};
    const parts = [];
    parts.push(m.enabled ? 'почта вкл' : 'почта выкл');
    parts.push(t.enabled ? 'таблица вкл' : 'таблица выкл');
    const ready = m.enabled && t.enabled && (m.password || m.user);
    els.modeValue.textContent = parts.join(' · ');
    els.modeValue.style.color = ready ? 'var(--green)' : 'var(--amber)';
    // накопительный счётчик успешно обработанных писем за всё время
    if (current.stats && current.stats.successTotal !== undefined) {
      els.checkedValue.textContent = String(current.stats.successTotal);
    }
    // время последнего цикла (сохраняется на диск, переживает перезапуск)
    if (current.stats && current.stats.lastRunAt) {
      els.lastRunValue.textContent = new Date(current.stats.lastRunAt).toLocaleString('ru');
    }
    renderReadiness();
  }

  // Структура готовности: что именно нужно донастроить, чтобы цикл заработал.
  function renderReadiness() {
    const m = current.mail || {};
    const t = current.table || {};
    const need = [];
    if (!m.enabled) need.push({ label: 'Включите блок «Яндекс Почта»', step: 1 });
    if (m.enabled && !m.user) need.push({ label: 'Укажите логин Яндекс Почты', step: 2 });
    if (m.enabled && !m.password) need.push({ label: 'Укажите app-пароль Яндекс Почты', step: 3 });
    if (!t.enabled) need.push({ label: 'Включите блок «Google Таблица»', step: 4 });
    if (t.enabled && !t.spreadsheetId) need.push({ label: 'Укажите ID Google Таблицы', step: 5 });
    if (t.enabled && t.spreadsheetId && !t.serviceAccountJson && !t.apiKey) {
      need.push({ label: 'Загрузите JSON сервисного аккаунта (или API-ключ)', step: 6 });
    }

    if (!need.length) {
      els.readiness.classList.add('hidden');
      return;
    }
    els.readiness.classList.remove('hidden');
    els.readinessList.innerHTML = '';
    need.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'readiness__item';
      const num = document.createElement('span');
      num.className = 'readiness__num';
      num.textContent = item.step;
      const label = document.createElement('span');
      label.textContent = item.label;
      li.appendChild(num); li.appendChild(label);
      els.readinessList.appendChild(li);
    });
  }

  function renderLast(report) {
    if (!report) return;
    // накопительный счётчик успешно обработанных писем за всё время
    if (report.successTotal !== undefined) {
      els.checkedValue.textContent = String(report.successTotal);
    }
    els.lastRunValue.textContent = new Date(report.started || Date.now()).toLocaleString('ru') + (report.written ? ` · записано ${report.written}` : '');
  }

  async function loadLog() {
    try {
const res = await fetch(apiPath('/api/log?limit=500'));
      const data = await res.json();
      logEntries = data.log || [];
      logPage = 1;
      renderLogPage();
    } catch (e) {}
  }

  function renderLogPage() {
    const filtered = logEntries.filter((e) => {
      if (logFilter === 'all') return true;
      if (logFilter === 'mail') return e.kind === 'sync';
      if (logFilter === 'table') return e.kind === 'check-table';
      return true;
    });
    const log = filtered.slice((logPage - 1) * LOG_PER_PAGE, logPage * LOG_PER_PAGE);
    els.logList.innerHTML = '';
    if (!log.length) {
      const li = document.createElement('li');
      li.className = 'log--empty';
      li.textContent = 'Журнал пуст — запустите первый цикл, и здесь появятся понятные записи о работе.';
      els.logList.appendChild(li);
      renderLogPagination();
      return;
    }
    log.forEach((e) => {
      const li = renderLogEntry(e);
      if (li) els.logList.appendChild(li);
    });
    renderLogPagination();
  }

  // Вкладки журнала: Почта (sync) / Таблица (check-table) / Все.
  document.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-logfilter]') : null;
    if (!btn) return;
    logFilter = btn.getAttribute('data-logfilter') || 'all';
    document.querySelectorAll('[data-logfilter]').forEach((b) => b.classList.toggle('is-active', b === btn));
    logPage = 1;
    renderLogPage();
  });

  // Русская форма множественного числа: plural(5, ['письмо','письма','писем']) -> 'писем'
  function plural(n, forms) {
    const abs = Math.abs(n || 0);
    const d10 = abs % 10, d100 = abs % 100;
    if (d10 === 1 && d100 !== 11) return forms[0];
    if (d10 >= 2 && d10 <= 4 && (d100 < 10 || d100 >= 20)) return forms[1];
    return forms[2];
  }

  // Человекочитаемое название вида записи.
  function kindName(kind) {
    const names = {
      'sync': 'Синхронизация почты',
      'check-table': 'Проверка таблицы'
    };
    return names[kind] || (kind || 'Событие');
  }

  // Отформатировать время как «20 сен 2026, 15:04».
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso || '';
    return d.toLocaleString('ru', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  // Построить один человекочитаемый элемент журнала. Возвращает <li> или null.
  function renderLogEntry(e) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'log__time';
    time.textContent = fmtTime(e.at);
    const kind = document.createElement('span');
    kind.className = 'log__kind';
    kind.textContent = kindName(e.kind);

    const msg = document.createElement('span');
    msg.className = 'log__msg';
    let hasEmails = false;

    if (e.kind === 'sync') {
      if (e.skipped) {
        msg.classList.add('err');
        li.appendChild(time); li.appendChild(kind); li.appendChild(msg);
        msg.textContent = 'Синхронизация не запущена: ' + skippedText(e.skipped);
        if (e.need && e.need.length) {
          const detail = document.createElement('span');
          detail.className = 'log__need';
          detail.textContent = ' → нужно настроить: ' + e.need.join(', ');
          li.appendChild(detail);
        }
        return li;
      }
      if (e.errors && e.errors.length) {
        msg.classList.add('err');
        msg.textContent = 'При проверке почты возникли проблемы: ' + e.errors.join('; ');
        li.appendChild(time); li.appendChild(kind); li.appendChild(msg);
        return li;
      }
      msg.classList.add('ok');
      const counts = [];
      counts.push('проверено ' + e.checked + ' ' + plural(e.checked, ['письмо','письма','писем']));
      counts.push('найдено совпадений: ' + e.matched);
      counts.push('записано статусов: ' + e.written);
      msg.textContent = counts.join(' · ');
      hasEmails = !!(e.emails && e.emails.length);
    } else if (e.kind === 'check-table') {
      if (e.skipped) {
        msg.classList.add('err');
        msg.textContent = 'Проверка таблицы не запущена: ' + skippedText(e.skipped);
        li.appendChild(time); li.appendChild(kind); li.appendChild(msg);
        return li;
      }
      msg.classList.add('ok');
      let text = 'Проверено ' + e.checked + ' ' + plural(e.checked, ['строка','строки','строк']) +
        ' таблицы · изменено: ' + e.written;
      if (e.point5Rows && e.point5Rows.length) {
        text += ' · пункт 5: строки ' + shortRows(e.point5Rows);
      }
      msg.textContent = text;
      li.appendChild(time); li.appendChild(kind); li.appendChild(msg);
      return li;
    } else {
      msg.classList.add(e.ok ? 'ok' : 'err');
      msg.textContent = e.message || (e.ok ? 'Выполнено.' : 'Произошла ошибка.');
      li.appendChild(time); li.appendChild(kind); li.appendChild(msg);
      return li;
    }

    li.appendChild(time); li.appendChild(kind); li.appendChild(msg);

    // Детализация по каждому письму — по клику.
    if (hasEmails && e.emails) {
      const wrap = document.createElement('li');
      wrap.className = 'log__emails';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'log__toggle';
      const n = e.emails.length;
      toggle.textContent = '▸ подробнее о ' + n + ' ' + plural(n, ['письме','письмах','письмах']);
      const list = document.createElement('ul');
      list.className = 'log__email-list';
      list.hidden = true;
      e.emails.forEach(function (em) {
        const item = document.createElement('li');
        const art = document.createElement('span');
        art.className = 'log__art';
        art.textContent = em.article ? em.article : '—';
        if (!em.article) art.classList.add('log__art--warn');
        if (em.articleSource === 'body') {
          const src = document.createElement('span');
          src.className = 'log__src';
          src.textContent = 'из тела';
          art.appendChild(src);
        } else if (em.articleSource === 'subject') {
          const src = document.createElement('span');
          src.className = 'log__src log__src--subject';
          src.textContent = 'из темы';
          art.appendChild(src);
        } else if (em.articleSource === 'label') {
          const src = document.createElement('span');
          src.className = 'log__src log__src--label';
          src.textContent = 'по полю';
          art.appendChild(src);
        }
        const body = document.createElement('span');
        body.className = 'log__email-body';
        const parts = [];
        if (em.matched) parts.push('слово «' + em.matched + '»');
        if (em.status) parts.push('статус "' + em.status + '"');
        if (em.row) parts.push('строка ' + em.row);
        const head = (em.subject || 'письмо без темы');
        body.textContent = head + ' → ' + (parts.join(', ') || 'нет ключевого слова');
        if (em.outcome) {
          const out = document.createElement('div');
          out.className = 'log__diag log__diag--body';
          out.textContent = em.outcome;
          body.appendChild(out);
        }
        if (em.bodyPreview) {
          const box = document.createElement('div');
          box.className = 'log__diag log__diag--body';
          const title = document.createElement('div');
          title.className = 'log__diag-title';
          title.textContent = 'текст письма:';
          const txt = document.createElement('pre');
          txt.className = 'log__body-text';
          txt.textContent = em.bodyPreview + (em.bodyHasMore ? '…' : '');
          box.appendChild(title);
          box.appendChild(txt);
          body.appendChild(box);
        }
        item.appendChild(art); item.appendChild(body);
        list.appendChild(item);
      });
      toggle.addEventListener('click', function () {
        list.hidden = !list.hidden;
        toggle.textContent = list.hidden
          ? '▸ подробнее о ' + n + ' ' + plural(n, ['письме','письмах','письмах'])
          : '▾ скрыть подробности';
      });
      wrap.appendChild(toggle); wrap.appendChild(list);
      els.logList.appendChild(wrap);
    }

    return li;
  }

  // Компактно показать список номеров строк: «3, 7, 12» / при большом списке — «3 и ещё 5».
  function shortRows(rows) {
    const arr = Array.isArray(rows) ? rows : [];
    if (!arr.length) return '';
    const first = arr.slice(0, 8).join(', ');
    return arr.length > 8 ? first + ' (и ещё ' + (arr.length - 8) + ')' : first;
  }

  // Постраничная навигация журнала (внизу, слева): номера страниц + prev/next
  function renderLogPagination() {
    els.logPagination.innerHTML = '';
    const total = logEntries.length;
    if (total <= LOG_PER_PAGE) return;
    const pages = Math.ceil(total / LOG_PER_PAGE);
    const maxPage = pages;
    const cur = Math.min(logPage, maxPage);

    // предыдущая
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'page-btn';
    prev.textContent = '‹';
    prev.title = 'Предыдущая страница';
    prev.disabled = cur <= 1;
    prev.addEventListener('click', () => { if (cur > 1) { logPage = cur - 1; renderLogPage(); } });
    els.logPagination.appendChild(prev);

    // номера страниц (с окном вокруг текущей)
    const range = [];
    const from = Math.max(1, cur - 2);
    const to = Math.min(maxPage, cur + 2);
    if (from > 1) range.push(1);
    if (from > 2) range.push('…');
    for (let p = from; p <= to; p++) range.push(p);
    if (to < maxPage - 1) range.push('…');
    if (to < maxPage) range.push(maxPage);

    range.forEach((p) => {
      if (p === '…') {
        const sep = document.createElement('span');
        sep.className = 'page-sep';
        sep.textContent = '…';
        els.logPagination.appendChild(sep);
        return;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'page-btn' + (p === cur ? ' page-btn--active' : '');
      b.textContent = p;
      b.addEventListener('click', () => { logPage = p; renderLogPage(); });
      els.logPagination.appendChild(b);
    });

    // следующая
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'page-btn';
    next.textContent = '›';
    next.title = 'Следующая страница';
    next.disabled = cur >= maxPage;
    next.addEventListener('click', () => { if (cur < maxPage) { logPage = cur + 1; renderLogPage(); } });
    els.logPagination.appendChild(next);
  }

  // человекочитаемое объяснение кода пропуска
  function skippedText(code) {
    const map = {
      'mail-disabled': 'блок «Яндекс Почта» выключен',
      'mail-not-configured': 'почта не настроена',
      'table-not-configured': 'Google Таблица не настроена',
      'no-enabled-rules': 'все правила выключены — включите правило 03 или 03b',
      'already-running': 'предыдущий цикл ещё выполняется'
    };
    return map[code] || code;
  }

  let toastTimer = null;
  function toast(text, isErr) {
    els.saveMsg.textContent = text;
    els.saveMsg.classList.toggle('err', !!isErr);
    els.saveMsg.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.saveMsg.classList.remove('show'), 3500);
  }

  function setSaving(v) {
    // автосохранение: индикация в полосе статуса (кнопки "Сохранить" больше нет)
    if (v) { els.saveMsg.textContent = 'Сохранение…'; els.saveMsg.classList.add('show'); }
  }
  function setRunning(v) {
    els.runBtn.disabled = v;
    els.runBtn.firstChild.textContent = v ? '⏳' : '▶';
  }

  // --- привязка событий ---
  // Автосохранение: любое изменение поля (input/change/select) планирует сохранение.
  let saveTimer = null;
  function scheduleAutoSave() {
    if (!isAdmin) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { save(); }, 600);
  }
  document.addEventListener('input', (ev) => {
    if (ev.target && ev.target.closest('.shell') && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) {
      scheduleAutoSave();
    }
  }, true);
  document.addEventListener('change', (ev) => {
    if (ev.target && ev.target.closest('.shell') && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName)) {
      scheduleAutoSave();
    }
  }, true);
  // переключение режимов при change отображаемых элементов
  els.mailEnabled.addEventListener('change', () => { renderMode(); scheduleAutoSave(); });
  els.tableEnabled.addEventListener('change', () => { renderMode(); scheduleAutoSave(); });
  els.authMethod.addEventListener('change', () => { toggleAuthFields(); scheduleAutoSave(); });
  els.saFileInput.addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      els.serviceAccountJson.value = String(reader.result || '').trim();
      toast('Файл сервисного аккаунта загружен');
      scheduleAutoSave();
      ev.target.value = '';
    };
    reader.onerror = () => toast('Не удалось прочитать файл', true);
    reader.readAsText(file);
  });
  els.addRuleBtn.addEventListener('click', () => { addRuleRow('', ''); scheduleAutoSave(); });
  els.addSecondaryRuleBtn.addEventListener('click', () => { addSecondaryRuleRow('', ''); scheduleAutoSave(); });
  els.runBtn.addEventListener('click', runSync);
  if (els.backupBtn) els.backupBtn.addEventListener('click', downloadBackup);
  if (els.spreadsheetId) els.spreadsheetId.addEventListener('input', updateSheetLink);
  els.foldersBtn.addEventListener('click', showFolderList);

  // --- сворачивание/разворачивание карточек-разделов ---
  function initCollapse() {
    // ключ для localStorage — по data-label заголовка, иначе по номеру карточки
    const labelOf = (head) => {
      const labeled = head.querySelector('[data-label]');
      if (labeled) return labeled.getAttribute('data-label');
      const num = head.querySelector('.card__num');
      return num ? num.textContent.trim() : '';
    };
    const keyFor = (head) => 'aw_layout_' + labelOf(head);

    // разделы, сворачивающиеся вместе (по data-label): mail <-> table
    const linkedPairs = { mail: 'table', table: 'mail' };

    const heads = [];
    document.querySelectorAll('section.card').forEach((card) => {
      card.querySelectorAll(':scope > .card__head').forEach((head) => {
        heads.push(head);
      });
    });

    // найти связанный заголовок (по data-label из linkedPairs)
    const findLinked = (head) => {
      const key = labelOf(head);
      const linkedKey = linkedPairs[key];
      if (!linkedKey) return null;
      const linkedH2 = document.querySelector('h2[data-label="' + linkedKey + '"]');
      return linkedH2 ? linkedH2.closest('.card__head') : null;
    };

    // применить состояние к паре и сохранить
    const applyPair = (head, collapsed) => {
      setCollapsed(head, collapsed);
      const linked = findLinked(head);
      let coll = collapsed;
      if (linked) {
        setCollapsed(linked, collapsed);
        coll = collapsed;
        try { localStorage.setItem(keyFor(linked), collapsed ? 'collapsed' : ''); } catch (e) {}
      }
      try { localStorage.setItem(keyFor(head), collapsed ? 'collapsed' : ''); } catch (e) {}
    };

    heads.forEach((head) => {
        if (head.querySelector('.card__collapse')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'card__collapse';
        btn.setAttribute('aria-label', 'Свернуть раздел');
        btn.innerHTML = '<span class="card__collapse-arrow">▾</span>';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const collapsed = !head.classList.contains('head--collapsed');
          applyPair(head, collapsed);
        });
        head.appendChild(btn);

        // собираем сохранённое состояние (применяем после — с синхронизацией пар)
        let saved = '';
        try { saved = localStorage.getItem(keyFor(head)) || ''; } catch (e) {}
        head.__savedCollapsed = saved === 'collapsed';
    });

    // восстановление: сначала каждый по своему ключу, затем связанные пары
    // синхронизируем — оба в состоянии master-элемента (первый в паре: mail)
    heads.forEach((head) => {
      if (head.__savedCollapsed) setCollapsed(head, true);
      else setCollapsed(head, false);
    });
    // синхронизация пар: состояние пары = состояние первого (mail как master)
    heads.forEach((head) => {
      const key = labelOf(head);
      if (linkedPairs[key] && findLinked(head)) {
        // head — master, приводим связанный к его состоянию
        const collapsed = head.classList.contains('head--collapsed');
        const linked = findLinked(head);
        setCollapsed(linked, collapsed);
      }
    });
    delete heads.__savedCollapsed;
  }

  function setCollapsed(head, collapsed) {
    if (collapsed) head.classList.add('head--collapsed');
    else head.classList.remove('head--collapsed');
    // элементы после заголовка до следующего .card__head (или конца карточки)
    let siblings = [];
    let sib = head.nextElementSibling;
    while (sib && !(sib.classList && sib.classList.contains('card__head'))) {
      siblings.push(sib);
      sib = sib.nextElementSibling;
    }
    siblings.forEach((el) => { el.style.display = collapsed ? 'none' : ''; });
  }

  initCollapse();
  load();

  // Автообновление накопительного счётчика «Успешно обработано» и времени
  // последнего цикла: раз в 15 секунд аккуратно запрашиваем /api/settings и
  // обновляем показатели, не перезагружая страницу.
  function refreshCounter() {
fetch(apiPath('/api/settings'))
      .then((r) => r.json())
      .then((d) => {
        const st = (d && d.settings && d.settings.stats) || {};
        if (st.successTotal !== undefined && els.checkedValue) {
          if (String(els.checkedValue.textContent) !== String(st.successTotal)) {
            els.checkedValue.textContent = String(st.successTotal);
          }
        }
        if (st.lastRunAt && els.lastRunValue) {
          const t = new Date(st.lastRunAt).toLocaleString('ru');
          if (els.lastRunValue.textContent !== t) els.lastRunValue.textContent = t;
        }
      })
      .catch(() => { /* молча: сеть нестабильна — пропускаем такт */ });
  }
  setInterval(refreshCounter, 15000);
})();
