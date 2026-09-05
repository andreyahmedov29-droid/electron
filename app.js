(() => {
  "use strict";

  // UI-only preference keeps living in localStorage (per browser). Everything else is server-side.
  const COLLAPSE_KEY = "biotime.collapsed";
  const CAL_START = { year: 2026, month: 8 }; // сентябрь 2026 (month 0-based)

  // ---- State (server-backed) ----
  const state = {
    me: null,          // { id, name, role, isAdmin }
    isAdmin: false,
    isModerator: false,
    canEditStatus: false,
    staff: [],         // [{ id, name, salary|null }]
    groups: [],        // [{ id, name, memberIds, moderatorId }]
    days: {},          // { "<YYYY-MM-DD>": { ownerId, segments } }
    log: [],           // [{ ts, action, ownerId }]
    admins: [],        // [id,...]
    blocked: [],       // [{ id, name, at }] — вход в приложение закрыт администратором
    params: { showOverHours: true, showOverSum: true, showDrivers: false, adminSeeRoutes: false, driverSeeRoutes: false, showShipment: false, shipmentGroups: [], allowDriverStartWithoutShipment: false, allowFinishUnloadIncomplete: false, multiplier: 1, multFrom: null, multTo: null, updateVersionCode: null, updateVersionName: "", updateApkUrl: "", updateNotes: "" },
    norm: 9,
    phase: "idle",     // idle | working | paused | finished
    segments: [],      // today's segments
    dayKey: null,
    finishKey: null,   // day the employee explicitly finished ("Завершить работу")
    collapsed: collapsedSet(),
    loading: true,
  };

  function collapsedSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []);
    } catch {
      return new Set();
    }
  }
  function saveCollapsed(set) {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  }

  // Черновики «начало/конец» для раздела «Время работы»: пока время ещё не
  // сохранено на сервер, набранные значения живут здесь (per browser) и,
  // как и свёрнутые дни, переживают перезагрузку и сворачивание папки дня.
  const DRAFT_KEY = "biotime.todayDraft";
  function draftSet() {
    try {
      const raw = JSON.parse(localStorage.getItem(DRAFT_KEY));
      return (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
    } catch {
      return {};
    }
  }
  function persistDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(todayDraft));
    } catch { /* ignore quota / private mode */ }
  }
  const todayDraft = draftSet();

  // ================= Server API =================
  async function api(path, opts = {}) {
    let res;
    let retryAfter = 0; // секунд до повтора, если сервер «просыпается»
    try {
      res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...opts,
      });
    } catch (e) {
      // Сетевая ошибка: сервер/шлюз недоступны (типично для VPN, блокирующего
      // доступ к домену приложения). Показываем водителю внятный баннер.
      showNetBanner(
        "Нет связи с сервером. Проверьте интернет и отключите VPN, если он блокирует приложение."
      );
      const err = new Error("Нет связи с сервером (проверьте VPN/интернет)");
      err.status = 0;
      throw err;
    }
    // Успешный ответ — связь есть: прячем баннер.
    if (res.ok) {
      resetWake();
      return res.status === 204 ? null : res.json();
    }
    // HTTP-ошибка: читаем тело, чтобы различить обычную серверную ошибку и
    // «требуется вход на платформу» (BH_LOGIN_REQUIRED — бывает при VPN, когда
    // сессия платформы не проходит через туннель).
    let msg = "Ошибка сервера";
    let code = "";
    try {
      const j = await res.json();
      if (j && j.error) {
        if (typeof j.error === "string") msg = j.error;
        else {
          msg = j.error.message || msg;
          code = j.error.code || "";
          // Платформа может указать срок ожидания перед повтором (сек).
          if (Number.isFinite(Number(j.error.retryAfter))) retryAfter = Number(j.error.retryAfter);
        }
      }
      if (Number.isFinite(Number(j && j.retryAfter))) retryAfter = Number(j.retryAfter);
    } catch { /* ignore */ }
    if (/BH_LOGIN_REQUIRED|LOGIN_REQUIRED|UNAUTHORIZED/i.test(code) || res.status === 401) {
      showNetBanner(
        "Сессия платформы не подтверждена — нужен вход. Проверьте, что VPN не блокирует авторизацию, и обновите страницу."
      );
    } else if (/BH_SERVER_WAKING|SERVER_WAKING|WAKING/i.test(code)) {
      // Сервер «просыпается» после простоя (спящий инстанс). Это временное
      // состояние, а не ошибка: показываем понятное сообщение и повторяем
      // запрос автоматически, как только сервер поднимется.
      await retryAfterWake(path, opts, res.status, retryAfter);
      return;
    } else {
      hideNetBanner();
    }
    const err = new Error(msg);
    err.status = res.status;
    err.code = code;
    throw err;
  }

  // Сервер приложения «просыпается» (спящий инстанс платформы возвращает
  // BH_SERVER_WAKING со сроком retryAfter). Это нормальное временное состояние
  // после простоя, не ошибка пользователя: показываем внятный баннер и
  // повторяем запрос автоматически. Счётчик попыток храним на уровне модуля,
  // чтобы он переживал рекурсивные вызовы api() (не сбрасывался на каждом витке).
  let wakeRetryCount = 0;
  async function retryAfterWake(path, opts, status, retryAfterSec) {
    const MAX_ATTEMPTS = 4;
    wakeRetryCount += 1;
    if (wakeRetryCount === 1) {
      // Первый раз: мягко сообщаем, что идёт пробуждение.
      showNetBanner("Сервер просыпается — сейчас всё обновится автоматически. Подождите немного…");
    }
    if (wakeRetryCount > MAX_ATTEMPTS) {
      // Не смогли дождаться — отдаём понятную ошибку, а не сырой JSON.
      showNetBanner(
        "Сервер приложения сейчас недоступен. Попробуйте обновить страницу через минуту."
      );
      wakeRetryCount = 0;
      const err = new Error("Сервер приложения ещё просыпается, попробуйте чуть позже");
      err.status = status;
      err.code = "BH_SERVER_WAKING";
      throw err;
    }
    // Пауза: preferred retryAfter от платформы, иначе разумный дефолт 15 с.
    const delayMs = 1000 * (Number.isFinite(Number(retryAfterSec)) && Number(retryAfterSec) > 0
      ? Number(retryAfterSec) : 15);
    await new Promise((r) => setTimeout(r, delayMs));
    // Пробуем ещё раз. hideNetBanner произойдёт, как только сервер ответит успешно
    // (api() вызывает hideNetBanner), либо при следующей итерации пробуждения.
    return await api(path, opts);
  }

  // Сбрасываем счётчик пробуждения после успешного ответа сервера.
  function resetWake() {
    wakeRetryCount = 0;
    hideNetBanner();
  }

  // Показывает/скрывает полосу «нет связи/сессия» вверху экрана.
  let netBannerShown = false;
  function showNetBanner(text) {
    if (!el.netBanner) return;
    if (el.netBannerText) el.netBannerText.textContent = text;
    el.netBanner.hidden = false;
    netBannerShown = true;
  }
  function hideNetBanner() {
    if (!el.netBanner) return;
    const was = netBannerShown;
    el.netBanner.hidden = true;
    netBannerShown = false;
    return was;
  }

  async function loadState() {
    state.loading = true;
    const s = await api("/api/state");
    state.me = s.me;
    state.isAdmin = !!s.me.isAdmin;
    state.isModerator = !!s.isModerator;
    state.isDriver = !!s.me.isDriver;
    state.canEditStatus = !!s.canEditStatus;
    state.staff = s.staff || [];
    state.groups = s.groups || [];
    state.days = s.days || {};
    state.log = (s.log || []).map((e) => {
      // Legacy entries had no `kind`; infer it from the action prefix so history
      // still lands on the right journal tab after the split.
      if (!e.kind) {
        const a = String(e.action || "");
        if (a.startsWith("статус ")) e.kind = "status";
        else if (a.startsWith("время на ")) e.kind = "manual";
        else e.kind = "timer";
      }
      return e;
    });
    state.admins = s.admins || [];
    state.blocked = s.blocked || [];
    state.params = Object.assign({ showOverHours: true, showOverSum: true, showDrivers: false, adminSeeRoutes: false, driverSeeRoutes: false, showShipment: false, shipmentGroups: [], allowDriverStartWithoutShipment: false, allowFinishUnloadIncomplete: false, multiplier: 1, multFrom: null, multTo: null }, s.params || {});
    state.norm = (s.norm != null && s.norm >= 0 && s.norm <= 24) ? s.norm : 8;
    // Единый опорный пояс (смещение сервера от UTC в минутах). Если сервер его
    // не прислал (старая версия) — фолбэк на локальный пояс устройства.
    state.serverOffsetMin = (s.serverOffsetMinutes != null && Number.isFinite(s.serverOffsetMinutes))
      ? s.serverOffsetMinutes
      : -new Date().getTimezoneOffset();
    state.loading = false;
    refreshToday();
  }

  // Background sync: re-polls the server so an admin's day edits (e.g. fixing an
  // employee's start/end time) appear on the employee's live timer WITHOUT a page
  // reload. Only server-authoritative fields are replaced; local UI-only prefs
  // (collapsed months) are left alone.
  async function pollState() {
    try {
      const s = await api("/api/state");
      state.staff = s.staff || [];
      if (s.serverOffsetMinutes != null && Number.isFinite(s.serverOffsetMinutes)) {
        state.serverOffsetMin = s.serverOffsetMinutes;
      }
      if (s.params) state.params = Object.assign(state.params, s.params || {});
      const prevDays = JSON.stringify(state.days || {});
      const prevSegments = JSON.stringify(state.segments);
      state.days = s.days || {};
      state.dayKey = dayKeyOf(Date.now());
      const serverSegs = daySegments(state.dayKey, state.me.id);
      // Protect the live running timer from a stale / lagging server copy. When the
      // user is actively working (open local segment) but the server read does not
      // yet contain an open segment — e.g. the `/api/day` save is still in flight,
      // a second tab beat us to it, or the mirror lagged — adopting the server list
      // would silently drop the open segment, flip phase to idle/finished and STOP
      // the ticking timer. Keep the locally running session instead.
      const localOpen = openSegment();
      const serverOpen = serverSegs.some((sg) => sg.kind === "work" && sg.end == null);
      if (localOpen && (state.phase === "working" || state.phase === "paused") && !serverOpen) {
        // server is behind this live session — do not regress the running timer.
      } else {
        state.segments = serverSegs;
        if (JSON.stringify(state.segments) !== prevSegments) {
          refreshToday();
        }
      }
      render();
      // Календарь (вкладка «Зарплата») перерисовываем только когда он открыт
      // И его данные реально изменились с прошлого опроса. Раньше это было
      // внутри render() раз в секунду — полная пересборка всех месяцев календаря
      // каждую секунду была главной причиной тормозов WebView на Android.
      if (!el.pageCalendar.hidden && JSON.stringify(state.days || {}) !== prevDays) renderCalendar();
      // Автоперерисовка открытых экранов панели администратора на свежих данных
      // с сервера — без ручной кнопки «Обновить».
      if (!el.settingsModal.hidden && activeAdminSub === "today") {
        // Не рвём незавершённое редактирование времени: живой пере-рендер с
        // сервера каждые несколько секунд заново создаёт все поля «начало/конец»
        // и сбивал открытый пикер или только что введённое значение. Пока
        // пользователь держит фокус внутри списка — пропускаем пересоздание,
        // данные при этом уже обновлены в state.days и применятся после.
        const list = el.todayList;
        const editingNow = list && list.matches(":focus-within");
        if (!editingNow) renderToday();
      }
      if (!el.pageReport.hidden) renderReport();
    } catch { /* transient network error — keep current state */ }
  }

  async function saveDay() {
    // Deduplicate segments before persisting: repeated saves/restores can leave
    // several work rows sharing the same `start`. Keep one (prefer the one with an
    // `end`), so no accidental duplicate open timer survives and inflates totals.
    const seen = new Map();
    for (const sg of state.segments) {
      const key = `${sg.kind}:${sg.start}`;
      const prev = seen.get(key);
      if (!prev) { seen.set(key, sg); continue; }
      if (prev.end == null && sg.end != null) seen.set(key, sg);
    }
    state.segments = [...seen.values()];
    await api("/api/day", {
      method: "POST",
      body: JSON.stringify({ key: state.dayKey, segments: state.segments }),
    });
    // Update the local days cache so the calendar reflects the change immediately.
    if (!state.days[state.dayKey]) state.days[state.dayKey] = {};
    if (!(state.days[state.dayKey].byEmployee && typeof state.days[state.dayKey].byEmployee === "object")) {
      // Legacy single-owner day: convert it to the per-employee map, keeping others' data.
      state.days[state.dayKey].byEmployee = state.days[state.dayKey].byEmployee || {};
      const legacyOwner = state.days[state.dayKey].ownerId;
      const legacySegs = Array.isArray(state.days[state.dayKey].segments) ? state.days[state.dayKey].segments : [];
      if (legacyOwner && legacyOwner !== state.me.id) {
        state.days[state.dayKey].byEmployee[legacyOwner] = { segments: legacySegs };
      }
      delete state.days[state.dayKey].ownerId;
      delete state.days[state.dayKey].segments;
    }
    state.days[state.dayKey].byEmployee[state.me.id] = { segments: state.segments.slice() };
  }

  async function postLog(action, kind = "timer") {
    const entry = { ts: Date.now(), action, kind, ownerId: state.me.id };
    state.log.unshift(entry);
    try {
      await api("/api/log", { method: "POST", body: JSON.stringify({ action, kind }) });
    } catch { /* non-fatal */ }
  }

  // Геолокация водителя: пока приложение в фокусе, раз в ~15 секунд отправляем
  // текущие координаты на сервер (эндпоинт /api/drivers/location), чтобы
  // администратор видел водителя в движении на живой карте во вкладке «Отчёт».
  // Не фейлим, если геолокация недоступна или пользователь запретил доступ.
  let locWatchId = null;
  function startLocationReporting() {
    if (locWatchId != null || !navigator.geolocation) return;
    let lastSent = 0;
    const activeRouteId = () => {
      const a = (myRoutesCache || []).find((r) => r.progress && r.progress.status === "active");
      return a ? a.id : "";
    };
    const send = (pos) => {
      const now = Date.now();
      if (now - lastSent < 15000) return;
      lastSent = now;
      const rid = activeRouteId();
      // Передаём активный маршрут нативному Android-трекеру (WebView-обёртка):
      // тот шлёт координаты на /api/drivers/location в фоне вместе с routeId.
      try {
        if (typeof AndroidBridge !== "undefined" && AndroidBridge.setRouteId) {
          AndroidBridge.setRouteId(String(rid || ""));
        }
      } catch (_) { /* нативного моста нет — трекинг продолжится через JS по сети */ }
      api("/api/drivers/location", {
        method: "POST",
        body: JSON.stringify({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          routeId: rid,
        }),
      }).catch(() => {});
    };
    locWatchId = navigator.geolocation.watchPosition(
      send,
      () => { /* нет доступа к геолокации — просто не передаём */ },
      { enableHighAccuracy: true, maximumAge: 30000, timeout: 60000 }
    );
  }

  // ------------- Helpers -------------
  function dayKeyOf(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function refreshToday() {
    state.dayKey = dayKeyOf(Date.now());
    const serverSegs = daySegments(state.dayKey, state.me.id).slice();
    const finished = state.finishKey === state.dayKey;
    let closedSomething = false;
    if (finished) {
      // The day was explicitly finished ("Завершить работу"). Do NOT resurrect an
      // open (running) segment that may linger in the server cache — close it so
      // the "Завершить работу" button stays hidden across tab switches.
      serverSegs.forEach((sg) => {
        if (sg.kind === "work" && sg.end == null) { sg.end = Date.now(); closedSomething = true; }
      });
    } else {
      // Capture the currently running timer BEFORE adopting the server copy. If the
      // server is lagging (a fresh save still in flight, or the tab was in the
      // background and the sync dropped the open session), keep the local open
      // segment so the timer never resets/stopped when the window is minimised.
      const localOpen = openSegment();
      if (localOpen && !serverSegs.some((sg) => sg.kind === "work" && sg.end == null && sg.id === localOpen.id)) {
        serverSegs.push(localOpen);
      }
    }
    state.segments = serverSegs;
    const open = openSegment();
    if (open && !finished) state.phase = "working";
    else if (state.segments.length > 0) state.phase = "finished";
    else state.phase = "idle";
    // Persist the cleaned-up (all closed) segments of the finished day so the open
    // one does not come back on the next poll. Fire-and-forget, and only when the
    // cleanup actually closed something — otherwise every 8s poll would re-save.
    if (finished && closedSomething && state.segments.length > 0 && state.me && state.dayKey) {
      const byEmp = state.days[state.dayKey] && state.days[state.dayKey].byEmployee;
      if (byEmp && byEmp[state.me.id]) {
        byEmp[state.me.id].segments = state.segments.slice();
        saveDay().catch(() => {});
      }
    }
  }

  function staffById(id) {
    return state.staff.find((s) => s.id === id) || null;
  }

  function activeSalary() {
    const st = staffById(state.me.id);
    return (st && st.salary != null) ? st.salary : 50000;
  }

  function activeBonus() {
    const st = staffById(state.me.id);
    return (st && st.bonus != null) ? st.bonus : 0;
  }

  function activeExtraBonus() {
    const st = staffById(state.me.id);
    return (st && st.extraBonus != null) ? st.extraBonus : 0;
  }

  function currentMultiplier() {
    return multiplierActive() ? state.params.multiplier : 1;
  }

  function multiplierActive() {
    const p = state.params;
    // A multiplier > 1 applies at all times unless a limiting period is given.
    // Without a period, treat the set multiplier as active (elevated tariff).
    if (!p.multFrom || !p.multTo) return p.multiplier > 1;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = new Date(p.multFrom + "T00:00:00");
    const to = new Date(p.multTo + "T23:59:59");
    return from <= today && today <= to;
  }

  // Hourly rate from the monthly salary and the current month's working days.
  // The hourly rate always uses an 8-hour working-day base (оклад / 8), regardless
  // of the overtime norm (9 h = 8 h per Labour Code + 1 h lunch).
  const RATE_BASE_HOURS = 8;
  function currentRatePerHour() {
    const now = new Date();
    const bizDays = businessDaysInMonth(now.getFullYear(), now.getMonth());
    const rateMonthMs = bizDays * RATE_BASE_HOURS * 3600000;
    const salary = activeSalary();
    return rateMonthMs > 0 ? salary / (rateMonthMs / 3600000) : 0;
  }

  // Money earned today: overtime only, no salary base.
  // = overtime hours × hourly rate × multiplier.
  function todayEarned(workMs) {
    const rate = currentRatePerHour();
    const mult = currentMultiplier();
    const normMs = state.norm * 3600000;
    const over = Math.max(0, workMs - normMs);
    return (over / 3600000) * rate * mult;
  }

  // ------------- Derived -------------
  function segDurationMs(seg, now) {
    const end = seg.end == null ? now : seg.end;
    return Math.max(0, end - seg.start);
  }
  function liveNow() { return Date.now(); }

  function totals(now) {
    let work = 0;
    let breaks = 0;
    for (const s of state.segments) {
      if (s.kind === "break") breaks += segDurationMs(s, now);
      else work += segDurationMs(s, now);
    }
    return { work, breaks };
  }

  function openSegment() {
    for (let i = state.segments.length - 1; i >= 0; i--) {
      if (state.segments[i].kind === "work" && state.segments[i].end == null) return state.segments[i];
    }
    return null;
  }

  // ------------- Formatting -------------
  function fmtMs(ms, withHours = true) {
    const sign = ms < 0 ? "−" : "";
    const a = Math.abs(ms);
    const totalSec = Math.floor(a / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (!withHours) return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  function fmtDateReadable(key) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });
  }
  function fmtMoney(amount) {
    return `${Math.round(amount).toLocaleString("ru-RU")} ₽`;
  }
  function fmtHours(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }
  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // ------------- Calendar computation -------------
  // Segments of one employee on a given day. In the new model a day stores
  // segments per employee (byEmployee[staffId].segments) so several employees
  // can have their own working time on the same day without overwriting each other.
  function daySegments(key, staffId) {
    const rec = state.days[key];
    if (!rec) return [];
    const byEmp = rec.byEmployee;
    if (byEmp && typeof byEmp === "object") {
      const e = byEmp[staffId];
      return (e && Array.isArray(e.segments)) ? e.segments : [];
    }
    // Legacy single-owner shape.
    if (rec.ownerId && rec.ownerId !== staffId) return [];
    return Array.isArray(rec.segments) ? rec.segments : [];
  }

  function dayWorkMs(key) {
    const segs = daySegments(key, state.me.id);
    let work = 0;
    for (const s of segs) {
      if (s.kind !== "work") continue;
      // Не даём незакрытому прошлому сегменту «тикать» от текущего времени: для
      // вчерашних (и более ранних) дней концом считается конец дня, иначе цифры
      // в календаре/отчёте росли бы при каждом обновлении страницы.
      const end = s.end == null
        ? (key === dayKeyOf(Date.now()) ? Date.now() : dayEndMs(key))
        : s.end;
      work += Math.max(0, end - s.start);
    }
    return Math.max(0, work);
  }

  // Overtime must only count for a CLOSED day — i.e. a day whose work segments
  // have an explicit end time (set by "Завершить работу" or manually in the
  // "Время работы" tab). While any work segment is still open (no `end`) the day
  // is considered unfinished and contributes 0 to overtime, so an accidentally
  // running timer can no longer inflate overtime figures.
  function dayClosedWorkMs(staffId, key) {
    const segs = daySegments(key, staffId);
    let work = 0;
    for (const s of segs) {
      if (s.kind !== "work") continue;
      if (s.end == null) continue; // open segment — not counted for overtime
      work += Math.max(0, s.end - s.start);
    }
    return Math.max(0, work);
  }

  function dayEndMs(key) {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }

  function businessDaysInMonth(year, month0) {
    let count = 0;
    const days = new Date(year, month0 + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const dow = new Date(year, month0, d).getDay();
      if (dow >= 1 && dow <= 5) count++;
    }
    return count;
  }

  function monthRange() {
    const now = new Date();
    const res = [];
    for (let y = CAL_START.year, m = CAL_START.month; y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth()); ) {
      res.push({ year: y, month: m });
      m++;
      if (m > 11) { m = 0; y++; }
    }
    return res;
  }
  function monthKey(year, m0) { return `${year}-${String(m0 + 1).padStart(2, "0")}`; }
  function monthLabel(year, m0) {
    return new Date(year, m0, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  }

  function computeMonth(year, m0) {
    const normDayMs = state.norm * 3600000;
    const range = monthRange();
    const isLast = range.length > 0 && range[range.length - 1].year === year && range[range.length - 1].month === m0;
    let totalWorkMs = 0, totalOverMs = 0;
    let unpaidDays = 0; // days with an unpaid status (НН / ДО) assigned by an admin
    const unpaidDates = [];
    const rows = [];
    for (let d = 1; d <= new Date(year, m0 + 1, 0).getDate(); d++) {
      const key = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const work = dayWorkMs(key);
      // Count unpaid statuses on this employee's own day (their calendar).
      const rec = state.days[key];
      const status = rec && rec.statuses ? rec.statuses[state.me.id] : undefined;
      if (status === "НН" || status === "ДО") {
        unpaidDays++;
        unpaidDates.push({ key, status, day: d, date: new Date(year, m0, d) });
      }
      if (work <= 0) continue;
      // Overtime counts only for closed segments (day finished), see dayClosedWorkMs.
      const over = Math.max(0, dayClosedWorkMs(state.me.id, key) - normDayMs);
      totalWorkMs += work;
      totalOverMs += over;
      rows.push({ day: d, work, over, date: new Date(year, m0, d) });
    }
    const bizDays = businessDaysInMonth(year, m0);
    const rateMonthMs = bizDays * RATE_BASE_HOURS * 3600000;
    const salary = activeSalary();
    const bonus = activeBonus();
    const extraBonus = activeExtraBonus();
    const ratePerHour = rateMonthMs > 0 ? salary / (rateMonthMs / 3600000) : 0;
    const multiplier = currentMultiplier();
    const overEarn = (totalOverMs / 3600000) * ratePerHour * multiplier;
    // Unpaid days (НН/ДО) are not paid: deduct their share of the monthly salary.
    const dayRate = bizDays > 0 ? salary / bizDays : 0;
    const unpaidDeduct = unpaidDays * dayRate;
    // "Заработано" = оклад + подработка + премия − неоплаченные дни; подработка считается ТОЛЬКО от оклада.
    const earned = salary + overEarn + bonus + extraBonus - unpaidDeduct;
    const overRate = ratePerHour * multiplier;
    return { year, m0, key: monthKey(year, m0), label: monthLabel(year, m0), isLast, bizDays, salary, bonus, extraBonus, totalWorkMs, totalOverMs, ratePerHour, overEarn, earned, unpaidDays, unpaidDeduct, unpaidDates, dayRate, rows };
  }

  // ------------- DOM refs -------------
  const $ = (id) => document.getElementById(id);
  const el = {
    todayChip: $("todayChip"), statusDot: $("statusDot"), statusText: $("statusText"),
    phasePill: $("phasePill"), dialTime: $("dialTime"), dialSub: $("dialSub"),
    totWorked: $("totWorked"), totOvertime: $("totOvertime"), totBal: $("totBal"), totBalLabel: $("totBalLabel"), rateNote: $("rateNote"), overNote: $("overNote"),
    startBtn: $("startBtn"), finishBtn: $("finishBtn"),
    settingsBtn: $("settingsBtn"), settingsModal: $("settingsModal"), toast: $("toast"), tabs: $("tabs"),
    userChip: $("userChip"), userName: $("userName"), userAvatar: $("userAvatar"),
    accountModal: $("accountModal"), accountClose: $("accountClose"),
    acctName: $("acctName"), acctId: $("acctId"), acctIdKind: $("acctIdKind"), acctRole: $("acctRole"), acctAdmin: $("acctAdmin"), acctReason: $("acctReason"),
    monthList: $("monthList"), calSalaryChip: $("calSalaryChip"),
    pageTimer: $("page-timer"), pageCalendar: $("page-calendar"), pageLive: $("page-live"), pageReport: $("page-report"), pageDrivers: $("page-drivers"),
    pageMyRoutes: $("page-myroutes"), myroutesList: $("myroutesList"), myroutesCount: $("myroutesCount"), myroutesDateFilter: $("myroutesDateFilter"),
    pageShipment: $("page-shipment"),
    pageDelivery: $("page-delivery"), deliveryList: $("deliveryList"), deliveryDateFilter: $("deliveryDateFilter"), deliveryCount: $("deliveryCount"), deliveryRefresh: $("deliveryRefresh"),
    driverClientName: $("driverClientName"), driverClientAddress: $("driverClientAddress"),
    driverClientsForm: $("driverClientsForm"), driverClientsBlock: $("driverClientsBlock"), driverClientsToggle: $("driverClientsToggle"), driverRouteForm: $("driverRouteForm"),
    addDriverClientBtn: $("addDriverClientBtn"), driverClientsList: $("driverClientsList"), driverClientsCount: $("driverClientsCount"),
    bundleToggle: $("bundleToggle"), bundlePanel: $("bundlePanel"), bundlePickList: $("bundlePickList"),
    bundleAddress: $("bundleAddress"), bundleCreateBtn: $("bundleCreateBtn"), bundleList: $("bundleList"),
    driverRouteDate: $("driverRouteDate"), driverRouteDriver: $("driverRouteDriver"), driverRouteClients: $("driverRouteClients"),
    routeClientSearch: $("routeClientSearch"), routeClientOptions: $("routeClientOptions"), routeClientSelected: $("routeClientSelected"),
    routeStepCount: $("routeStepCount"), routeSelectedCount: $("routeSelectedCount"), routeTotalPill: $("routeTotalPill"),
    subtabContr: $("subtab-contr"), subtabRoute: $("subtab-route"), subtabRoutes: $("subtab-routes"), subtabReport: $("subtab-report"), subtabTracking: $("subtab-tracking"),
    routesubContr: $("routesub-contr"), routesubRoute: $("routesub-route"), routesubRoutes: $("routesub-routes"), routesubReport: $("routesub-report"), routesubTracking: $("routesub-tracking"),
    driverMap: $("driverMap"), driverMapCount: $("driverMapCount"), driverMapRefresh: $("driverMapRefresh"), driverMapHint: $("driverMapHint"), driverTrackDate: $("driverTrackDate"),
    motionDateFilter: $("motionDateFilter"), motionRefresh: $("motionRefresh"),
    motionDrivers: $("motionDrivers"), motionKm: $("motionKm"), motionMove: $("motionMove"), motionLunch: $("motionLunch"),
    motionTable: $("motionTable"), motionBody: $("motionBody"),
    netBanner: $("netBanner"), netBannerText: $("netBannerText"), netRetry: $("netRetry"),
    saveDriverRouteBtn: $("saveDriverRouteBtn"), driverRoutesList: $("driverRoutesList"), driverRoutesCount: $("driverRoutesCount"),
    autoRouteBtn: $("autoRouteBtn"), routeBaseAddress: $("routeBaseAddress"), autoRouteStatus: $("autoRouteStatus"),
    driverRoutesDateFilter: $("driverRoutesDateFilter"),
    liveSummary: $("liveSummary"), liveList: $("liveList"), liveBadge: $("liveBadge"),
    reportMonth: $("reportMonth"), reportShowOver: $("reportShowOver"),
    reportExportBtn: $("reportExportBtn"),
    reportWorkDays: $("reportWorkDays"), reportStaffCount: $("reportStaffCount"), reportTotalOver: $("reportTotalOver"),
    reportTableWrap: $("reportTableWrap"), reportTable: $("reportTable"),
    statusModal: $("statusModal"), statusClose: $("statusClose"), statusWho: $("statusWho"),
    statusOptions: $("statusOptions"), statusClear: $("statusClear"),
    routeConfirmModal: $("routeConfirmModal"), routeConfirmText: $("routeConfirmText"),
    routeConfirmOk: $("routeConfirmOk"), routeConfirmCancel: $("routeConfirmCancel"), routeConfirmClose: $("routeConfirmClose"),
    updateModal: $("updateModal"), updateText: $("updateText"),
    updateClose: $("updateClose"), updateLater: $("updateLater"), updateDownload: $("updateDownload"),
    appVersion: $("appVersion"),
    postponeModal: $("postponeModal"), postponeClose: $("postponeClose"), postponeTiles: $("postponeTiles"),
    adminClose: $("adminClose"), adminTabs: $("adminTabs"),
    staffCountNote: $("staffCountNote"), newStaffName: $("newStaffName"), addStaffBtn: $("addStaffBtn"),
    staffList: $("staffList"), salariesBody: $("salariesBody"),
    todayList: $("todayList"), todayDateNote: $("todayDateNote"),
    groupsList: $("groupsList"), newGroupName: $("newGroupName"), addGroupBtn: $("addGroupBtn"),
    clearLogBtn: $("clearLogBtn"), logTabs: $("logTabs"), logList: $("logList"), adminsList: $("adminsList"),
    showOverHours: $("showOverHours"), showOverSum: $("showOverSum"),
    showDrivers: $("showDrivers"),
    adminSeeRoutes: $("adminSeeRoutes"), driverSeeRoutes: $("driverSeeRoutes"),
    showOverHoursGroups: $("showOverHoursGroups"), showOverSumGroups: $("showOverSumGroups"),
    showShipment: $("showShipment"), shipmentGroups: $("shipmentGroups"),
    allowDriverStartWithoutShipment: $("allowDriverStartWithoutShipment"),
    allowFinishUnloadIncomplete: $("allowFinishUnloadIncomplete"),
    shipmentList: $("shipmentList"), shipmentRefresh: $("shipmentRefresh"),
    printModal: $("printModal"), printClientSelect: $("printClientSelect"),
    printPlacesQty: $("printPlacesQty"), printConfirm: $("printConfirm"),
    printCancel: $("printCancel"), printClose: $("printClose"), printArea: $("printArea"),
    scanLoadBtn: $("scanLoadBtn"), scanOverlayClose: $("scanOverlayClose"),
    printScanStatus: $("printScanStatus"), printLabelsList: $("printLabelsList"),
    multiplierVal: $("multiplierVal"), multiplierFrom: $("multiplierFrom"), multiplierTo: $("multiplierTo"),
    multiplierStatus: $("multiplierStatus"), normVal: $("normVal"), paramsSave: $("paramsSave"),
    updateVersionCode: $("updateVersionCode"), updateVersionName: $("updateVersionName"),
    updateApkUrl: $("updateApkUrl"), updateNotes: $("updateNotes"),
    backupExportBtn: $("backupExportBtn"), backupAppBtn: $("backupAppBtn"), backupImportFile: $("backupImportFile"), backupStatus: $("backupStatus"),
    backupAutoNote: $("backupAutoNote"), backupAutoList: $("backupAutoList"),
  };

  let toastTimer = null;
  // Активная подвкладка панели администратора — нужна, чтобы фоновое обновление
  // перерисовывало именно открытый экран (например «Время работы») без кнопки
  // «Обновить».
  let activeAdminSub = "staff";
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2600);
  }

  // ------------- Actions -------------
  async function startWork() {
    if (state.phase === "working") return;
    // A finished day is closed: you cannot start (or "resume") it again today.
    // The "Начать работу" button returns automatically on the next day (idle).
    if (state.phase === "finished") {
      toast("Рабочий день уже завершён — сегодня начать нельзя");
      return;
    }
    state.segments.push({ start: Date.now(), end: null, kind: "work", id: uid() });
    state.phase = "working";
    render();
    toast("Работа начата");
    postLog("начало работы");
    await saveDay();
  }

  async function finishWork() {
    if (state.phase === "idle" || state.phase === "finished") return;
    // Close EVERY open work segment (duplicates can accumulate from repeated
    // saves/restores), so no open timer survives a page reload and the
    // "Завершить работу" button stays hidden after finishing.
    const now = Date.now();
    for (const sg of state.segments) {
      if (sg.kind === "work" && sg.end == null) sg.end = now;
    }
    // Закрываем и открытый перерыв (обед): после «Завершить работу» не должно
    // оставаться незакрытого сегмента, иначе он повиснет при перезагрузке.
    for (const sg of state.segments) {
      if (sg.kind === "break" && sg.end == null) sg.end = now;
    }
    state.phase = "finished";
    state.finishKey = state.dayKey; // day finished — prevent an open segment re-living
    render();
    showFinishToast();
    postLog("завершение работы");
    await saveDay();
    // Re-sync the timer state and immediately refresh the "Время работы" tab so
    // the finish time (now) shows up in the "конец" field without waiting for the
    // next poll / tab switch.
    refreshToday();
    render();
    if (activeAdminSub === "today") renderToday();
  }

  function showFinishToast() {
    const { work } = totals(liveNow());
    const normMs = state.norm * 3600 * 1000;
    const over = Math.max(0, work) - normMs;
    if (over > 0) toast(`Рабочий день завершён. Переработка: ${fmtMs(over, false)}`);
    else toast("Рабочий день завершён. Спасибо!");
  }

  let uidCounter = 0;
  function uid() {
    return `${Date.now().toString(36)}-${(uidCounter++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // ================= Render =================
  function render() {
    const now = liveNow();
    const t = totals(now);
    const normMs = state.norm * 3600 * 1000;
    let closedWork = 0;
    let openWork = 0;
    for (const s of state.segments) {
      if (s.kind !== "work") continue;
      const dur = segDurationMs(s, now);
      if (s.end == null) openWork += dur;
      else closedWork += dur;
    }
    const workNet = Math.max(0, closedWork) + openWork;
    // Cumulative overtime subtotal on the timer: yesterday (closed) + today
    // (closed segments). Shown only once today's worked time reaches 9 hours
    // (show threshold); before that the timer shows 0. The final figures settle
    // when the employee presses "Завершить работу" (today's part then counts).
    const nineH = 9 * 3600 * 1000;
    const yestKey = dayKeyOf(Date.now() - 86400000);
    const yestClosed = dayClosedWorkMs(state.me.id, yestKey);
    const yestOver = yestClosed > 0 ? Math.max(0, yestClosed - normMs) : 0;
    const todayOver = closedWork > 0 ? Math.max(0, closedWork - normMs) : 0;
    const showSubtotal = workNet >= nineH;
    const over = showSubtotal ? (yestOver + todayOver) : 0;
    const bal = normMs - workNet;

    document.body.classList.toggle("state-working", state.phase === "working");
    document.body.classList.toggle("state-paused", state.phase === "paused");
    document.body.classList.toggle("state-finished", state.phase === "finished");
    // Personal over-hours / money visibility (scoped by group on the server).
    const seeHours = (state.me && state.me.seeOverHours != null)
      ? state.me.seeOverHours
      : state.params.showOverHours;
    const seeSum = (state.me && state.me.seeOverSum != null)
      ? state.me.seeOverSum
      : state.params.showOverSum;
    document.body.classList.toggle("hide-over-hours", !seeHours);
    document.body.classList.toggle("hide-over-sum", !seeSum);
    el.todayChip.textContent = fmtDateReadable(state.dayKey);

    const statusMap = {
      idle: "Сегодня не начали", working: "Работаем. Время идёт",
      paused: "Пауза — нажмите «Возобновить»", finished: "Рабочий день завершён",
    };
    el.statusText.textContent = statusMap[state.phase];
    const phaseMap = { idle: "ожидание", working: "в работе", paused: "пауза", finished: "завершено" };
    el.phasePill.textContent = phaseMap[state.phase];

    // No live ticking counter: show the fixed start time, and "start → end" once
    // the day is finished. Worked/overtime totals still come from `t` below.
    const startSeg = state.segments.find((s) => s.kind === "work");
    if (!startSeg) {
      el.dialTime.textContent = "—";
      el.dialSub.textContent = "Начал работу — запишем время";
    } else if (startSeg.end != null) {
      el.dialTime.textContent = `${msToHm(startSeg.start)} → ${msToHm(startSeg.end)}`;
      el.dialSub.textContent = "начало — конец";
    } else {
      el.dialTime.textContent = msToHm(startSeg.start);
      el.dialSub.textContent = "начало работы";
    }

    el.totWorked.textContent = fmtMs(workNet, false);
    el.totOvertime.textContent = over > 0 ? fmtMs(over, false) : "00:00";
    el.totOvertime.parentElement.classList.toggle("over", over > 0);
    el.totOvertime.parentElement.classList.add("over-hours-cell");
    // Third cell: money for overtime only — no salary base.
    el.totBal.textContent = fmtMoney(todayEarned(over > 0 ? normMs + over : 0));
    el.totBalLabel.textContent = "за подработку";
    el.totBal.parentElement.classList.add("ok");
    el.totBal.parentElement.classList.add("earned-cell");
    // Hourly rate; highlight when an elevated tariff (multiplier) is active.
    const rate = currentRatePerHour();
    const mult = currentMultiplier();
    const multActive = multiplierActive() && mult > 1;
    const multStr = (mult % 1 === 0) ? String(mult) : String(mult).replace(".", ",");
    el.rateNote.textContent = multActive
      ? `${fmtMoney(rate)}/ч · тариф ×${multStr}`
      : `${fmtMoney(rate)}/ч`;
    el.rateNote.classList.toggle("rate-boosted", multActive);
    el.rateNote.title = multActive
      ? `Действует повышенный тариф ×${multStr}${state.params.multFrom ? ` (${state.params.multFrom} – ${state.params.multTo})` : ""}`
      : "Часовая ставка";
    el.totBal.parentElement.classList.toggle("boosted", multActive);

    // Overtime note: tie the applied multiplier to the overtime cell itself, so
    // it's clear which tariff is used for the surplus hours.
    const overRate = rate * mult;
    if (over > 0) {
      el.overNote.textContent = multActive
        ? `×${multStr} → ${fmtMoney(overRate)}/ч`
        : `${fmtMoney(overRate)}/ч`;
    } else {
      el.overNote.textContent = "";
    }
    el.overNote.classList.toggle("over-boosted", multActive && over > 0);
    el.overNote.title = multActive && over > 0
      ? `Переработка ×${multStr} — ${fmtMoney(overRate)}/ч`
      : "Ставка переработки";

    // After "Завершить работу" the day is closed: show the start button only in
    // the idle phase (it comes back on the next day automatically).
    el.startBtn.classList.toggle("hidden", state.phase !== "idle");
    el.finishBtn.classList.toggle("hidden", state.phase === "idle" || state.phase === "finished");
    if (state.phase === "idle") {
      el.startBtn.textContent = "Начать работу";
      el.startBtn.className = "ctrl ctrl-primary";
    } else {
      el.startBtn.className = "ctrl";
    }
  }

  // ------------- Calendar render -------------
  function renderCalendar() {
    // Чип оклада показывает только оклад (без надбавки). Надбавка остаётся
    // видимой ниже, в расшифровке месячной сводки.
    el.calSalaryChip.textContent = fmtMoney(activeSalary());
    const months = monthRange();
    if (months.length === 0) {
      el.monthList.innerHTML = `<div class="empty-hint">Календарь начинается с сентября 2026.</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    months.forEach(({ year, month }) => {
      const calc = computeMonth(year, month);
      const key = calc.key;
      // Текущий (последний) месяц всегда производим раскрытым — как на экране
      // «Календарь» по умолчанию. Сохранённая свёрнутость применяется только
      // к прошлым месяцам; клик по заголовку по-прежнему сворачивает/разворачивает
      // живой месяц в рамках сессии.
      const isCollapsed = state.collapsed.has(key) && !calc.isLast;
      const open = !isCollapsed;
      const hasRows = calc.rows.length > 0;
      // Реальные неоплачиваемые статусы (НН/ДО), расставленные в табеле.
      const unpaidStatuses = [...new Set(calc.unpaidDates.map((u) => u.status))];
      // Personal visibility (group-scoped): own calendar follows own group rights.
      const showOverHoursFlag = (state.me && state.me.seeOverHours != null)
        ? state.me.seeOverHours : state.params.showOverHours;
      const showOverSumFlag = (state.me && state.me.seeOverSum != null)
        ? state.me.seeOverSum : state.params.showOverSum;

      const folder = document.createElement("div");
      folder.className = "month-folder" + (open ? " open" : "");
      const head = document.createElement("div");
      head.className = "month-head";
      const multVal = currentMultiplier();
      const multLabel = (multVal % 1 === 0) ? String(multVal) : String(multVal).replace(".", ",");
      const rateLabel = multVal > 1
        ? `ставка ${fmtMoney(calc.ratePerHour)}/ч · тариф ×${multLabel}`
        : `ставка ${fmtMoney(calc.ratePerHour)}/ч`;
      const statsHtml = [
        `<div class="folder-stat acc"><span class="fs-label">за переработку</span><span class="fs-value">${fmtMoney(calc.overEarn)}</span></div>`,
        `<div class="folder-stat earn"><span class="fs-label">премия</span><span class="fs-value">${fmtMoney(calc.bonus)}</span></div>`,
        `<div class="folder-stat earn"><span class="fs-label">надбавка</span><span class="fs-value">${fmtMoney(calc.extraBonus)}</span></div>`,
        showOverHoursFlag ? `<div class="folder-stat acc"><span class="fs-label">переработка</span><span class="fs-value">${fmtHours(calc.totalOverMs)}</span></div>` : "",
        showOverSumFlag ? `<div class="folder-stat earn"><span class="fs-label">заработано</span><span class="fs-value">${fmtMoney(calc.earned)}</span></div>` : "",
        calc.unpaidDays > 0 ? `<div class="folder-stat unpaid" title="Неоплачиваемые дни (НН «прогул», ДО «за свой счёт») не входят в заработок">
          <span class="fs-label">не оплачено</span><span class="fs-value">${calc.unpaidDays} ${plural(calc.unpaidDays, "день", "дня", "дней")} −${fmtMoney(calc.unpaidDeduct)}</span>
        </div>` : "",
      ].join("");
      head.innerHTML = `
        <span class="folder-caret"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></span>
        <div class="folder-main">
          <div class="folder-name">${calc.label}</div>
          <div class="folder-sub">${calc.bizDays} ${plural(calc.bizDays, "раб. день", "раб. дня", "раб. дней")} · ${rateLabel}${calc.unpaidDays > 0 ? ` · <span class="unpaid-sub">не оплачено: ${calc.unpaidDays} дн. (${unpaidStatuses.join(", ")})</span>` : ""}</div>
        </div>
        <div class="folder-stats">${statsHtml}</div>
      `;
      const body = document.createElement("div");
      body.className = "month-body";
      const inner = document.createElement("div");
      inner.className = "month-body-inner";
      // Название статуса и пояснение берутся из реально расставленных дней
      // табеля (НН — прогул, ДО — за свой счёт): в сводке пишется только то,
      // что реально стоит в табеле, с полной датой «число + месяц».
      const statusLabel = (s) => s === "НН" ? "НН (прогул)" : s === "ДО" ? "ДО (за свой счёт)" : s;
      const unpaidDaysList = calc.unpaidDates.map((u) => {
        const dstr = u.date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
        return `<div class="mun-day"><span class="mun-day-date">${dstr}</span><span class="mun-day-status">${statusLabel(u.status)}</span></div>`;
      }).join("");
      const unpaidNoteText = unpaidStatuses.map((s) => `${statusLabel(s)} не входит в заработок`).join("; ");
      const unpaidNote = calc.unpaidDays > 0
        ? `<div class="month-unpaid-note">
            <span class="mun-badge" aria-hidden="true">!</span>
            <div class="mun-body">
              <div class="mun-title">Не оплачиваются</div>
              <div class="mun-sum">−${fmtMoney(calc.unpaidDeduct)} <span class="mun-days">за ${calc.unpaidDays} ${plural(calc.unpaidDays, "день", "дня", "дней")}</span></div>
              <div class="mun-days-list">${unpaidDaysList}</div>
              <div class="mun-text">${unpaidNoteText}</div>
            </div>
          </div>`
        : "";
      if (!hasRows) {
        inner.innerHTML = unpaidNote + `<div class="month-empty">${calc.unpaidDays > 0 ? "Отработанных дней не было, а неоплачиваемые дни учтены выше." : "Нет отработанных дней в этом месяце."}</div>`;
      } else {
        const rowsHtml = calc.rows.map((r) => {
          const dateStr = r.date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", weekday: "short" });
          const overCell = showOverHoursFlag ? `<td class="num ${r.over > 0 ? "over-pos" : ""}">${r.over > 0 ? fmtHours(r.over) : "—"}</td>` : "";
          const sumCell = showOverSumFlag ? `<td class="num earn">${fmtMoney((r.over / 3600000) * calc.ratePerHour)}</td>` : "";
          return `<tr><td>${dateStr}</td><td class="num">${fmtHours(r.work)}</td>${overCell}${sumCell}</tr>`;
        }).join("");
        const overHead = showOverHoursFlag ? `<th class="num">Переработка</th>` : "";
        const sumHead = showOverSumFlag ? `<th class="num">За переработку</th>` : "";
        const overFoot = showOverHoursFlag ? `<td class="num">${fmtHours(calc.totalOverMs)}</td>` : "";
        const sumFoot = showOverSumFlag ? `<td class="num">${fmtMoney(calc.earned)}</td>` : "";
        const tbody = `
          <table class="month-table">
            <thead><tr><th>День</th><th class="num">Отработано</th>${overHead}${sumHead}</tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td>Итого</td><td class="num">${fmtHours(calc.totalWorkMs)}</td>${overFoot}${sumFoot}</tr></tfoot>
          </table>`;
        const wrap = document.createElement("div");
        wrap.className = "month-table-wrap";
        wrap.innerHTML = tbody;
        inner.appendChild(wrap);
        if (unpaidNote) inner.insertAdjacentHTML("afterbegin", unpaidNote);
      }
      body.appendChild(inner);
      folder.appendChild(head);
      folder.appendChild(body);
      head.addEventListener("click", () => {
        if (state.collapsed.has(key)) state.collapsed.delete(key);
        else state.collapsed.add(key);
        saveCollapsed(state.collapsed);
        folder.classList.toggle("open", !state.collapsed.has(key));
      });
      frag.appendChild(folder);
    });
    el.monthList.innerHTML = "";
    el.monthList.appendChild(frag);
  }

  // ------------- Live: кто онлайн, у кого работает таймер -------------
  let liveRowsCache = [];   // последняя выгрузка /api/live
  let liveTimer = null;
  let liveTick = null;
  let myRoutesTimer = null; // периодический опрос «Мои маршруты» (без перезагрузки)

  async function loadLive() {
    try {
      const r = await api("/api/live");
      liveRowsCache = r.rows || [];
      renderLive();
    } catch { /* transient — keep last view */ }
  }

  function renderLive() {
    // Показываем только сотрудников с запущенным таймером (открытый рабочий
    // сегмент сегодня). Остальные из «В эфире» скрыты — раздел отвечает на вопрос
    // «кто сейчас работает», а не «весь штат».
    const rows = liveRowsCache.filter((r) => r && r.name && r.timerOn);
    const online = rows.filter((r) => r.online);
    const onTimer = rows.filter((r) => r.timerOn);
    el.liveBadge.classList.toggle("has-online", online.length > 0);

    // Сводка.
    let summary = "";
    if (rows.length > 0) {
      summary = `
        <div class="live-stat"><span class="live-stat-v">${rows.length}</span><span class="live-stat-l">сотрудников</span></div>
        <div class="live-stat"><span class="live-stat-v on">${online.length}</span><span class="live-stat-l">онлайн</span></div>
        <div class="live-stat"><span class="live-stat-v timer">${onTimer.length}</span><span class="live-stat-l">таймер идёт</span></div>
      `;
    }
    el.liveSummary.innerHTML = summary;

    if (rows.length === 0) {
      el.liveList.innerHTML = `<div class="empty-hint">Сейчас никто не работает — таймеры не запущены.</div>`;
      return;
    }

    // Сортируем: сначала работающие (таймер), затем онлайн, остальные по алфавиту.
    const sorted = [...rows].sort((a, b) => {
      if (a.timerOn !== b.timerOn) return a.timerOn ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.name || "").localeCompare(b.name || "", "ru");
    });

    const frag = document.createDocumentFragment();
    sorted.forEach((r) => {
      const row = document.createElement("div");
      // Переработка в едином формате "ЧЧ:ММ" (как в календаре/отчёте). Логика
      // значения (только по закрытым сегментам, от 9-часового дня, ставка оклад/8)
      // уже приходит с сервера из liveRows.
      const over = r.overMs > 0 ? fmtHours(r.overMs) : "—";
      const earned = r.overEarn > 0 ? fmtMoney(r.overEarn) : "0 ₽";
      const session = r.timerOn ? fmtMs(Math.max(0, Date.now() - r.openStart), false) : "—";
      const stateCls = r.timerOn ? "running" : (r.online ? "online" : "off");
      const stateTxt = r.timerOn ? "таймер идёт" : (r.online ? "онлайн" : "не в сети");
      row.className = "live-row";
      row.innerHTML = `
        <div class="live-presence">
          <span class="live-avatar">${escapeHtml(r.name).trim().charAt(0).toUpperCase()}</span>
          <div class="live-name-wrap">
            <div class="live-name">${escapeHtml(r.name)}</div>
            <div class="live-state ${stateCls}"><span class="live-state-dot"></span>${stateTxt}</div>
          </div>
        </div>
        <div class="live-cell">${session}</div>
        <div class="live-cell">${over}</div>
        <div class="live-cell num">${earned}</div>
      `;
      frag.appendChild(row);
    });
    el.liveList.innerHTML = "";
    // Заголовок таблицы.
    const head = document.createElement("div");
    head.className = "live-head";
    head.innerHTML = `
      <div class="live-presence">Сотрудник</div>
      <div class="live-cell">Время работы</div>
      <div class="live-cell">Переработка</div>
      <div class="live-cell num">За подработку</div>
    `;
    el.liveList.appendChild(head);
    el.liveList.appendChild(frag);
  }

  // ------------- Report: time-sheet (табель) -------------
  // Builds a table in the style of the uploaded excel timesheet: a grid of days
  // for the selected month with a "Я" mark when an employee worked that day,
  // plus summary columns (worked days, hours, overtime). Data comes from the
  // live timer records (state.days) and staff (state.staff).
  function renderReportMonthSelect() {
    if (el.reportMonth.options.length === 0) {
      const months = monthRange();
      if (months.length === 0) return;
      // Add from newest to oldest so the current month is pre-selected.
      [...months].reverse().forEach(({ year, month }) => {
        const opt = document.createElement("option");
        opt.value = monthKey(year, month);
        opt.textContent = monthLabel(year, month);
        el.reportMonth.appendChild(opt);
      });
    }
    const now = new Date();
    const cur = monthKey(now.getFullYear(), now.getMonth());
    if (!el.reportMonth.value || !state.reportMonthKey) {
      if ([...el.reportMonth.options].some((o) => o.value === cur)) {
        el.reportMonth.value = cur;
      } else if (el.reportMonth.options.length) {
        el.reportMonth.value = el.reportMonth.options[0].value;
      }
    }
  }

  function reportDayWorkMs(staffId, key) {
    const raw = daySegments(key, staffId)
      .filter((s) => s.kind !== "break")
      .reduce((acc, s) => acc + Math.max(0, (s.end == null ? (key === dayKeyOf(Date.now()) ? Date.now() : dayEndMs(key)) : s.end) - s.start), 0);
    return Math.max(0, raw);
  }

  function reportStaffWorkDays(staffId, year, m0) {
    const daysInMonth = new Date(year, m0 + 1, 0).getDate();
    const res = [];
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (reportDayWorkMs(staffId, key) > 0) res.push(d);
    }
    return res;
  }

  // Effective status for a day: an admin-assigned status (Я/Б/ОТ/ДО/НН) wins;
  // otherwise attendance "Я" is derived automatically from a fully worked day.
  function reportDayStatus(staffId, key, workMs, normDayMs) {
    const rec = state.days[key];
    if (rec && rec.statuses && rec.statuses[staffId]) return rec.statuses[staffId];
    if (workMs >= normDayMs) return "Я";
    // Неполный день: отработал > 0, но меньше нормы (напр. завершил по кнопке,
    // не добрав до 9 ч) → автоматический статус «НД (не полный день)».
    if (workMs > 0) return "НД";
    return null;
  }

  function renderReport() {
    renderReportMonthSelect();
    const val = el.reportMonth.value;
    if (!val) return;
    state.reportMonthKey = val;
    const [y, m] = val.split("-").map(Number);
    const m0 = m - 1;
    const daysInMonth = new Date(y, m0 + 1, 0).getDate();
    const normDayMs = state.norm * 3600000;
    const bizDays = businessDaysInMonth(y, m0);
    const showOver = el.reportShowOver.checked;

    // Per-employee rows.
    const rows = state.staff.map((st) => {
      // workMs per day for this staff member across the whole month.
      const dayWork = {};
      let totalMs = 0;
      for (let d = 1; d <= daysInMonth; d += 1) {
        const key = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const ms = reportDayWorkMs(st.id, key);
        dayWork[d] = ms;
        totalMs += ms;
      }
      // Status per day: admin-assigned status, else auto "Я" from a full day.
      const dayStatus = {};
      const attendedDays = [];
      for (let d = 1; d <= daysInMonth; d += 1) {
        const key = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        // Автостатус «Я/НД» — только по завершённым (закрытым) сегментам.
        // Пока таймер запущен (открыт сегмент), день не завершён и статус
        // не проставляется; он появится после «Завершить работу».
        const s = reportDayStatus(st.id, key, dayClosedWorkMs(st.id, key), normDayMs);
        dayStatus[d] = s;
        if (s === "Я") attendedDays.push(d);
      }
      // Overtime accumulates PER DAY: max(0, hours − 8h) summed over every worked
      // day. The old formula (totalMs − attendedDays×8h) included the hours of
      // partial days (< 8h) that were not flagged "Я" while never subtracting
      // their norm, which inflated overtime (e.g. 2×2h expected became 5.7h).
      let overMsVal = 0;
      for (let o = 1; o <= daysInMonth; o += 1) {
        const dKey = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(o).padStart(2, "0")}`;
        const wk = dayClosedWorkMs(st.id, dKey);
        if (wk > 0) overMsVal += Math.max(0, wk - normDayMs);
      }
      // "Часы" follow the hours flag; "сумма" (money) follows its OWN flag, so a
      // group granted hours but not the money is not charged for overtime.
      const seeHoursVal = showOver && (st.seeOverHours !== false);
      const seeSumVal = showOver && (st.seeOverSum !== false);
      // Money for overtime, from the employee's salary rate (salary / month norm).
      const normMonthH = bizDays * RATE_BASE_HOURS;
      const staffRate = st.salary != null && st.salary > 0 && normMonthH > 0 ? st.salary / normMonthH : 0;
      const overEarn = seeSumVal ? (overMsVal / 3600000) * staffRate * currentMultiplier() : 0;
      return {
        id: st.id,
        name: st.name,
        salary: st.salary != null ? st.salary : 0,
        bonus: st.bonus != null ? st.bonus : 0,
        extraBonus: st.extraBonus != null ? st.extraBonus : 0,
        workMs: dayWork,
        dayStatus: dayStatus,
        workDays: Object.keys(dayWork).filter((d) => dayWork[d] > 0).map(Number),
        totalMs: totalMs,
        overMs: overMsVal,
        overEarn: overEarn,
        seeHours: seeHoursVal,
        seeSum: seeSumVal,
        count: attendedDays.length,
      };
    });

    // Totals.
    // Overtime columns are shown when at least one visible employee may see them.
    const anySeeHours = rows.some((r) => r.seeHours);
    const totalCount = rows.reduce((a, r) => a + r.count, 0);
    const totalOverMs = rows.reduce((a, r) => (r.seeHours ? a + r.overMs : a), 0);
    // "Оклад" subtotal = оклад + надбавка (надбавка включена в оклад, как в ячейке).
    const totalSalary = rows.reduce((a, r) => a + ((r.salary ? r.salary : 0) + (r.extraBonus ? r.extraBonus : 0)), 0);
    const totalBonus = rows.reduce((a, r) => a + (r.bonus ? r.bonus : 0), 0);
    const totalOverEarn = rows.reduce((a, r) => a + (r.overEarn ? r.overEarn : 0), 0);

    el.reportWorkDays.textContent = bizDays;
    el.reportStaffCount.textContent = state.staff.length;
    el.reportTotalOver.textContent = anySeeHours ? fmtMs(totalOverMs, false) : "—";

    // Header.
    let head = "";
    let dowHead = "";
    let daysHead = "";
    let daysBody = "";
    for (let d = 1; d <= daysInMonth; d += 1) {
      const dow = new Date(y, m0, d).getDay();
      const isWE = dow === 0 || dow === 6;
      const dayLabel = String(d).padStart(2, "0");
      head += `<th class="col-idx ${isWE ? "dow-we" : ""}" title="${fmtDateReadable(`${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`)}">${dayLabel}</th>`;
      dowHead += `<th class="col-dow ${isWE ? "dow-we" : ""}">${["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"][dow]}</th>`;
    }

    // Footer cells for days.
    const totalWorkedCells = (() => {
      let s = "";
      for (let d = 1; d <= daysInMonth; d += 1) {
        // Count employees whose effective status that day is attendance "Я".
        const cnt = rows.filter((r) => r.dayStatus[d] === "Я").length;
        const dow = new Date(y, m0, d).getDay();
        const isWE = dow === 0 || dow === 6;
        // No "mark" class here: on a <td> (unlike the <span class="mark"> used in
        // body cells) the CSS rule .report-table td.mark { display: inline-grid }
        // blows the cell height up, making the totals row a huge empty strip.
        s += `<td class="num ${isWE ? "dow-we" : ""}">${cnt || ""}</td>`;
      }
      return s;
    })();

    // Первый ряд шапки: № и Сотрудник — в начале, данные (оклад, часы,
    // переработка) размещаются ПОСЛЕ сетки дней табеля.
    const leadCols = [
      `<th class="report-sticky-left report-idx-head">№</th>`,
      `<th class="col-name report-sticky-left">Сотрудник</th>`,
    ].join("");
    // В «Оклад» включена надбавка (оклад + надбавка); переработки («Сумма»)
    // считаются ТОЛЬКО от чистого оклада, без надбавки.
    const dataCols = [
      `<th class="report-sticky-right" title="Оклад + надбавка. Переработки считаются от чистого оклада, без надбавки">Оклад</th>`,
      `<th class="report-sticky-right" title="Премия — доплата к окладу (из раздела «Оклады и дни»)">Премия</th>`,
      `<th class="report-sticky-right">Отраб. дней</th>`,
      anySeeHours ? `<th class="report-sticky-right">Переработка</th>` : "",
      anySeeHours ? `<th class="report-sticky-right">Сумма</th>` : "",
    ].join("");

    const headRow = `
      <thead>
        <tr>${leadCols}${head}${dataCols}</tr>
        <tr>
          <th class="report-sticky-left report-idx-head"></th>
          <th class="report-sticky-left"></th>
          ${dowHead}
          <th class="report-sticky-right"></th>
          <th class="report-sticky-right"></th>
          <th class="report-sticky-right"></th>
          ${anySeeHours ? '<th class="report-sticky-right"></th><th class="report-sticky-right"></th>' : ""}
        </tr>
      </thead>`;

    // Body rows.
    const rowHtml = (r, idx) => {
      let dayCells = "";
      for (let d = 1; d <= daysInMonth; d += 1) {
        const dow = new Date(y, m0, d).getDay();
        const isWE = dow === 0 || dow === 6;
        const isToday = (() => {
          const now = new Date();
          return now.getFullYear() === y && now.getMonth() === m0 && now.getDate() === d;
        })();
        const cls = [isWE ? "dow-we" : ""];
        const status = r.dayStatus[d];
        const rec = state.days[`${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`];
        const isManual = rec && rec.statuses && rec.statuses[r.id];
        if (!status && d >= 1) cls.push("day-offempty");
        if (isToday) cls.push("day-today");
        if (status && isManual) cls.push("manual");
        if (status && !isManual) cls.push("auto-mark");
        if (status) cls.push("has-status");
        if (state.canEditStatus) cls.push("editable");
        const key = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const mark = status
          ? `<span class="mark ${status === "Я" && r.overMs > 0 ? "mark-over" : ""} status-${status}">${status}</span>`
          : "";
        dayCells += `<td class="${cls.join(" ")}" data-day="${key}" data-owner="${r.id}">${mark}</td>`;
      }
      const overCell = r.seeHours
        ? `<td class="num report-over report-sticky-right">${r.overMs > 0 ? fmtHours(r.overMs) : "—"}</td>`
        : `<td class="num report-sticky-right">—</td>`;
      const sumCell = r.seeSum
        ? `<td class="num report-sticky-right">${r.overEarn > 0 ? fmtMoney(r.overEarn) : "—"}</td>`
        : `<td class="num report-sticky-right">—</td>`;
      // Данные идут ПОСЛЕ сетки дней: оклад, отработанные дни, переработка, сумма.
      return `<tr>
          <td class="col-idx report-sticky-left">${idx + 1}</td>
          <td class="col-name report-sticky-left">${escapeHtml(r.name)}</td>
          ${dayCells}
          <td class="num report-sticky-right">${(r.salary + r.extraBonus) ? fmtMoney(r.salary + r.extraBonus) : "—"}</td>
          <td class="num report-sticky-right">${r.bonus ? fmtMoney(r.bonus) : "—"}</td>
          <td class="num report-total-val report-sticky-right">${r.count}</td>
        ${overCell}
        ${sumCell}
      </tr>`;
    };

    // Group the report rows by group (header row before each group); employees
    // that belong to no group go last under "Без группы". Numbering stays global.
    const seenIds = new Set();
    const groupsArr = [];
    state.groups.forEach((g) => {
      const members = rows.filter((rr) => (g.memberIds || []).includes(rr.id));
      if (members.length === 0) return;
      groupsArr.push({ name: g.name, members });
      members.forEach((m) => seenIds.add(m.id));
    });
    const ungroupedRows = rows.filter((rr) => !seenIds.has(rr.id));

    const reportTotalCols = 2 + daysInMonth + 3 + (anySeeHours ? 2 : 0);
    const groupHead = (name, count) =>
      `<tr class="report-group-head"><td colspan="${reportTotalCols}"><span class="report-group-name">${escapeHtml(name)}</span><span class="report-group-count">${count}</span></td></tr>`;

    const bodyParts = [];
    let gi = 0;
    groupsArr.forEach((grp) => {
      bodyParts.push(groupHead(grp.name, grp.members.length));
      grp.members.forEach((r) => { bodyParts.push(rowHtml(r, gi)); gi += 1; });
    });
    if (ungroupedRows.length) {
      if (groupsArr.length) bodyParts.push(groupHead("Без группы", ungroupedRows.length));
      ungroupedRows.forEach((r) => { bodyParts.push(rowHtml(r, gi)); gi += 1; });
    }
    const bodyHtml = bodyParts.join("");

    // Totals row is a single ordinary line like every other row: it intentionally
    // carries NO sticky-left/sticky-right classes so it does not get stretched by
    // the table-layout: fixed engine and stays one compact line.
    const footRow = anySeeHours
      ? `<tr>
          <td class="report-idx-head"></td>
          <td class="report-total-key">Итого</td>
          ${totalWorkedCells}
          <td class="num report-total-val">${fmtMoney(totalSalary)}</td>
          <td class="num report-total-val">${fmtMoney(totalBonus)}</td>
          <td></td>
          <td class="num report-over">${totalOverMs > 0 ? fmtHours(totalOverMs) : "—"}</td>
          <td class="num report-total-val">${fmtMoney(totalOverEarn)}</td>
        </tr>`
      : `<tr>
          <td class="report-idx-head"></td>
          <td class="report-total-key">Итого</td>
          ${totalWorkedCells}
          <td class="num report-total-val">${fmtMoney(totalSalary)}</td>
          <td class="num report-total-val">${fmtMoney(totalBonus)}</td>
          <td></td>
        </tr>`;

    // Grand total: оклад (включая надбавку) + премия + деньги за переработку.
    const totalRow = `<tr>
      <td class="report-idx-head"></td>
      <td class="report-total-key">Всего начислено</td>
      ${totalWorkedCells}
      <td class="num report-total-val" colspan="${anySeeHours ? 5 : 3}">${fmtMoney(totalSalary + totalBonus + totalOverEarn)}</td>
    </tr>`;

    // Fixed equal sizing for the day-grid columns (№ and name on the left, salary
    // / days / hours / overtime on the right) so that no single column — e.g. the
    // first days next to the sticky right-hand columns — gets stretched wider than
    // the others. With table-layout: fixed the day columns share equal width.
    const colWidths = [`<col style="width:34px">`, `<col style="width:180px">`];
    for (let d = 1; d <= daysInMonth; d += 1) colWidths.push(`<col style="width:30px">`);
    colWidths.push(`<col style="width:90px">`, `<col style="width:80px">`, `<col style="width:70px">`);
    if (anySeeHours) colWidths.push(`<col style="width:70px">`, `<col style="width:90px">`);
    const colGroup = `<colgroup>${colWidths.join("")}</colgroup>`;

    const tbody = `<tbody>${bodyHtml}</tbody><tfoot>${footRow}${totalRow}</tfoot>`;
    el.reportTable.innerHTML = colGroup + headRow + tbody;
  }

  // ------------- Report: assign a day status (admin) -------------
  const DAY_STATUSES = [
    { code: "Я", label: "Явка" },
    { code: "НД", label: "Не полный день" },
    { code: "Б", label: "Больничный" },
    { code: "ОТ", label: "Отпуск" },
    { code: "ДО", label: "День за свой счёт" },
    { code: "НН", label: "Прогул" },
  ];

  let statusCtx = null; // { key, ownerId }

  function openStatusMenu(key, ownerId) {
    statusCtx = { key, ownerId };
    const st = staffById(ownerId);
    const name = st ? st.name : ownerId;
    const date = fmtDateReadable(key);
    el.statusWho.textContent = `${name} · ${date}`;

    const options = DAY_STATUSES.map(({ code, label }) => {
      // Highlight the currently applied status, if any.
      const rec = state.days[key];
      const own = rec && rec.statuses ? rec.statuses[ownerId] : undefined;
      const isAuto = !own;
      const active = own === code;
      const auto = code === "Я" && !active && isAuto && reportDayStatus(ownerId, key, dayClosedWorkMs(ownerId, key), state.norm * 3600000) === "Я";
      const cls = ["status-opt"];
      if (active) cls.push("active");
      if (auto) cls.push("auto");
      return `<button type="button" class="${cls.join(" ")}" data-status="${code}">
        <span class="legend-mark">${code}</span>${label}${auto ? '<span class="auto-tag">авто</span>' : ""}
      </button>`;
    }).join("");
    el.statusOptions.innerHTML = options;
    el.statusModal.showModal();
  }

  async function setDayStatus(key, ownerId, status) {
    try {
      await api("/api/admin/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ownerId, status }),
      });
      // Update local state so the table re-renders immediately.
      let rec = state.days[key];
      if (!rec) rec = state.days[key] = {};
      if (!rec.statuses) rec.statuses = {};
      if (status) rec.statuses[ownerId] = status;
      else delete rec.statuses[ownerId];
      const hasSegs = rec.byEmployee && Object.keys(rec.byEmployee).some((e) => (rec.byEmployee[e].segments || []).length);
      const hasStatuses = rec.statuses && Object.keys(rec.statuses).length;
      if (!hasSegs && !hasStatuses) {
        delete state.days[key];
      }
      postLog(`статус ${fmtDateReadable(key)}: ${status || "авто"} (${staffById(ownerId) ? staffById(ownerId).name : ownerId})`, "status");
      renderReportKeepScroll();
    } catch (err) {
      toast("Не удалось сохранить статус");
    }
  }

  // Permits an admin to set statuses in the timesheet day by day without the
  // table resetting the scroll position on every save (which felt like the
  // selection "jumping" between cells). Saves and restores both the window
  // scroll and the horizontal offset of the table wrapper around the re-render.
  function renderReportKeepScroll() {
    const wrap = el.reportTableWrap;
    const savedTop = window.scrollY;
    const savedLeft = wrap ? wrap.scrollLeft : 0;
    renderReport();
    requestAnimationFrame(() => {
      if (wrap) wrap.scrollLeft = savedLeft;
      window.scrollTo(0, savedTop);
    });
  }

  // ------------- Tabs -------------
  function switchTab(name) {
    // Запоминаем активную вкладку, чтобы после перезагрузки страницы остаться
    // на ней же, а не сбрасываться на «Таймер».
    try { localStorage.setItem("biotime_active_tab", name); } catch { /* ignore */ }
    // Отчёт/В эфире — только админ и модератор.
    if ((name === "report" || name === "live") && !state.isAdmin && !state.isModerator) name = "calendar";
    // Маршрутизация — только админ и при включённой настройке.
    if (name === "drivers" && !(state.isAdmin && state.params.showDrivers)) name = "calendar";
    // Мои маршруты — водителям.
    if (name === "myroutes" && !((state.isAdmin && state.params.adminSeeRoutes) || (state.isDriver && state.params.driverSeeRoutes))) name = "calendar";
    // Отгрузка — по группам.
    if (name === "shipment" && !shipmentVisible()) name = "calendar";
    el.pageTimer.hidden = name !== "timer";
    el.pageCalendar.hidden = name !== "calendar";
    el.pageLive.hidden = name !== "live";
    el.pageReport.hidden = name !== "report";
    el.pageDrivers.hidden = name !== "drivers";
    el.pageMyRoutes.hidden = name !== "myroutes";
    el.pageShipment.hidden = name !== "shipment";
    el.pageDelivery.hidden = name !== "delivery";
    document.body.classList.remove("report-full", "live-full");
    // Отчёт — полноширинный на больших дисплеях: табель занимает весь экран.
    if (name === "report") document.body.classList.add("report-full");
    el.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    if (name === "calendar") renderCalendar();
    if (name === "live") { loadLive(); startLivePolling(); } else { stopLivePolling(); }
    if (name === "report") renderReport();
    if (name === "drivers") renderDrivers();
    if (name === "myroutes") { renderMyRoutes(); startMyRoutesPolling(); } else { stopMyRoutesPolling(); }
    if (name === "shipment") loadShipments();
    if (name === "delivery") renderDeliveries();
  }

  // "Водители" page — clients and their addresses (map/geocoder added later).
  function renderDrivers() {
    // Эта страница теперь чисто админская (вкладка «Маршрутизация» доступна
    // только администраторам). Водители видят свои маршруты в разделе myroutes.
    if (el.driverRouteDate) el.driverRouteDate.value = el.driverRouteDate.value || dayKeyOf(Date.now());
    fillDriverRouteDriverSelect();
    updateRouteStepCount();
    loadDriverClients();
    loadDriverRoutes();
  }

  // Внутренняя вкладка маршрутизации: «Контрагенты» / «Маршрут на день» / «Маршруты».
  function switchRouteSubtab(name) {
    const tabs = [
      { key: "contr", btn: el.subtabContr, panel: el.routesubContr },
      { key: "route", btn: el.subtabRoute, panel: el.routesubRoute },
      { key: "routes", btn: el.subtabRoutes, panel: el.routesubRoutes },
      { key: "report", btn: el.subtabReport, panel: el.routesubReport },
      { key: "tracking", btn: el.subtabTracking, panel: el.routesubTracking },
    ];
    for (const t of tabs) {
      if (!t.btn || !t.panel) continue;
      const active = t.key === name;
      t.btn.classList.toggle("active", active);
      t.btn.setAttribute("aria-selected", active ? "true" : "false");
      t.panel.hidden = !active;
    }
    // Запоминаем активную подвкладку, чтобы после перезагрузки страницы
    // остаться на той же (например, «Трекинг» вместо дефолтной).
    try { localStorage.setItem("biotime_route_subtab", name); } catch { /* ignore */ }
    // Живая карта водителей живёт во вкладке «Трекинг»: запускаем её сразу,
    // как только раздел открыт (и перезапускаем на каждое открытие).
    if (name === "tracking") loadDriverMap();
    // Дашборд движения водителей грузим при каждом открытии «Отчёта».
    if (name === "report") loadMotionReport();
  }

  // ---- Живая карта водителей (вкладка «Отчёт» маршрутизации) ----
  // Подключает Yandex JS API (ключ из /api/maps/config), рисует маршруты и точки,
  // а поверх — живые координаты водителей (из /api/drivers/location). Обновляется
  // автоматически, пока вкладка открыта.
  let driverMap = null;
  let driverMapScript = null;
  let driverMapTimer = null;
  // Показываем/фокусируем камеру на всех точках ТОЛЬКО при первой загрузке.
  // При последующих автообновлениях не двигаем камеру, чтобы не «сбрасывать»
  // зум/позицию, которые выбрал пользователь (иначе увеличение откатывается
  // на мировой масштаб у каждого тика автообновления).
  let driverMapFitted = false;
  // ---- Инкрементальная отрисовка (для скорости) ----
  // Метки живых водителей (зелёные) перерисовываются «на лету» — без полного
  // removeAll() карты, который дорого стоит при множестве точек. Статичный слой
  // (базы, клиенты, полилинии пройденного пути) строится заново только когда
  // реально изменился набор/статус маршрутов (сигнатура) или прошёл таймер.
  let driverLiveMarks = {};      // id водителя -> ymaps.Placemark (зелёная метка)
  let driverRoutesSig = "";      // сигнатура последнего отрисованного набора маршрутов
  let driverRoutesReady = false; // статичный слой построен хотя бы раз
  let driverRoutesDueAt = 0;     // когда снова перезагрузить маршруты (для смены статусов)
  let driverRoutesLoading = false;
  // ---- Слой реального GPS-следа (обновляется редко, отдельно от позиций) ----
  let driverTrackCollection = null;   // GeoObjectCollection следа; создаётся с картой
  let driverTracksDueAt = 0;          // когда снова перезагрузить треки
  let driverTracks = {};              // id водителя -> [[lat, lon], ...]

  // ---- Слой всех клиентов справочника (серые маркеры) ----
  // Вся география клиентов показывается на карте, чтобы видеть, где они находятся,
  // даже если клиент не попал в маршрут выбранного дня. Обновляется редко, отдельно
  // от позиций водителей, по тому же принципу, что маршруты (не чаще раза в 30 с).
  let driverClientMarks = {};         // id клиента -> ymaps.Placemark (серый маркер)
  let driverClientsDueAt = 0;         // когда снова перезагрузить справочник клиентов
  let driverClientsLoading = false;
  let driverClientSig = "";           // сигнатура набора клиентов (id+координаты)
  let driverClientClusterer = null;   // ymaps.Clusterer — группирует маркеры клиентов, ускоряя карту

  // Метки на карте трекинга используем простыми встроенными пресетами точек
  // (~точки того же цвета, что и раньше): они легче и быстрее кастомных PNG —
  // при многих маркерах карту не «тормозит». Водители — зелёные точки,
  // клиенты — красные точки.

  function loadYandexMaps(apikey) {
    return new Promise((resolve, reject) => {
      // Экранируем повторные срабатывания (onload + таймер), чтобы продемонстрировать
      // только одну причину завершения.
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };

      if (window.ymaps && window.ymaps.Map) { resolve(window.ymaps); return; }

      if (driverMapScript) {
        // Скрипт уже начал грузиться в этом заходе — ждём появления API.
        const t = setInterval(() => {
          if (window.ymaps && window.ymaps.Map) { clearInterval(t); resolve(window.ymaps); }
        }, 250);
        setTimeout(() => { clearInterval(t); done(reject, new Error("Карта не загрузилась за отведённое время")); }, 25000);
        return;
      }

      if (!apikey) {
        done(reject, new Error("Нет ключа Яндекс.Карт — карта недоступна"));
        return;
      }

      driverMapScript = document.createElement("script");
      driverMapScript.src = "https://api-maps.yandex.ru/2.1/?apikey=" +
        encodeURIComponent(apikey) + "&lang=ru_RU";
      // Скрипт грузится (loader отдаётся 200) даже если ключ не разрешает домен
      // приложения — при этом window.ymaps появляется, но ymaps.ready не срабатывает,
      // и карта «вечно загружается». Ловим этот случай явным тайм-аутом и
      // подсказкой про разрешённые домены ключа.
      driverMapScript.onload = () => {
        if (window.ymaps && window.ymaps.ready) {
          const tm = setTimeout(() => {
            done(reject, new Error("Яндекс.Карты не инициализировались (похоже, ключ карт не разрешает этот домен: " +
              window.location.hostname + ")"));
          }, 25000);
          window.ymaps.ready(() => { clearTimeout(tm); done(resolve, window.ymaps); });
        } else {
          done(reject, new Error("Яндекс.Карты не инициализировались — проверьте ключ карт"));
        }
      };
      driverMapScript.onerror = () => done(reject, new Error("Не удалось загрузить Яндекс.Карты (сеть недоступна)"));
      document.head.appendChild(driverMapScript);
    });
  }

  async function loadDriverMap() {
    if (!el.driverMap || !el.routesubTracking || el.routesubTracking.hidden) return;
    if (el.driverMapHint) el.driverMapHint.textContent = "Загрузка карты…";
    try {
      const cfg = await api("/api/maps/config");
      const ymaps = await loadYandexMaps(cfg.yandexKey);
      if (!driverMap) {
        driverMap = new ymaps.Map(el.driverMap, {
          center: [55.75, 37.62], zoom: 10,
          controls: ["zoomControl", "fullscreenControl"],
        });
        // Отдельный слой для GPS-следа: рисуется редко, чтобы не тормозить карту.
        driverTrackCollection = new ymaps.GeoObjectCollection();
        driverMap.geoObjects.add(driverTrackCollection);
        // Кластерер для маркеров клиентов: при большом числе точек группирует их
        // в кластеры и тем самым ускоряет карту (меньше объектов рендерится).
        driverClientClusterer = new ymaps.Clusterer({
          preset: "islands#invertedGreyClusterIcons",
          clusterDisableClickZoom: false,
          gridSize: 48,
          minClusterSize: 2,
        });
        driverMap.geoObjects.add(driverClientClusterer);
        driverTracksDueAt = 0;
      }
      // Контейнер мог быть нулевого размера в момент создания карты (вкладка
      // «Трекинг» изначально скрыта). Яндекс.Карты в таком случае запоминают
      // размер 0×0, не запрашивают тайлы области и показывают серую карту
      // «Для этого участка местности нет данных». Явно просим карту пересчитать
      // размер и подгрузить тайлы сейчас, а не ждать следующего таймера.
      try { driverMap.container.fitToViewport(); } catch { /* ignore */ }
      if (el.driverMapHint) el.driverMapHint.textContent = "";
      await refreshDriverMap(ymaps);
      if (!driverMapTimer) {
        driverMapTimer = setInterval(() => {
          if (el.routesubTracking && !el.routesubTracking.hidden) refreshDriverMap(ymaps);
        }, 10000);
      }
    } catch (e) {
      if (el.driverMapHint) el.driverMapHint.textContent = e && e.message ? e.message : "Карта недоступна";
    }
  }

  async function refreshDriverMap(ymaps) {
    const now = Date.now();
    // Позиции водителей грузим каждый тик (лёгкий ответ).
    let locs = [];
    try {
      const l = await api("/api/drivers/location");
      locs = (l && l.rows) || [];
    } catch { /* transient — повторим в следующий тик */ }
    if (!driverMap) return;

    // Маршруты (ответ тяжелее) перезагружаем реже: только если статичный слой ещё
    // не построен, либо прошло ≥30 с. Так положение водителей обновляется каждые
    // 10 с на лету, а тяжёлая перестройка статики — не чаще раза в 30 с.
    let routes = null;
    const routesDue = !driverRoutesReady || now >= driverRoutesDueAt;
    if (routesDue && !driverRoutesLoading) {
      driverRoutesLoading = true;
      try {
        // Показываем маршруты выбранного дня: если дата задана, фильтруем на сервере.
        const dateNow = el.driverTrackDate ? (el.driverTrackDate.value || "") : "";
        const q = dateNow ? "?date=" + encodeURIComponent(dateNow) : "";
        const r = await api("/api/drivers/routes" + q);
        routes = (r && r.routes) || [];
      } catch { routes = null; }
      driverRoutesLoading = false;
      driverRoutesDueAt = now + 30000;
    }

    const routeNameById = {};
    if (routes) {
      routes.forEach((r) => { if (r && r.id) routeNameById[r.id] = r.routeName ? `Маршрут ${r.routeName}` : "Маршрут"; });
      const sig = routes.map((r) =>
        (r.id || "") + ":" + ((r.progress && r.progress.status) || "") + ":" +
        ((r.clients || []).map((c) => (c && c.state) || "").join(","))
      ).join("|");
      // Перестраиваем статичный слой только при изменении набора/статуса маршрутов.
      if (!driverRoutesReady || sig !== driverRoutesSig) {
        drawDriverRouteLayers(ymaps, routes);
        driverRoutesSig = sig;
        driverRoutesReady = true;
      }
    }

    // GPS-след водителей перезагружаем редко (~раз в 30 с), чтобы не тянуть точки
    // трека при каждом тике — это отдельный лёгкий слой поверх карты.
    if (now >= driverTracksDueAt && driverTrackCollection) {
      loadDriverTracks(ymaps);
    }

    // Географию всех клиентов справочника перезагружаем редко (~раз в 30 с).
    // Она показывает, где находятся клиенты, включая тех, что не попали
    // в маршруты выбранного дня (серые маркеры поверх карты).
    if (now >= driverClientsDueAt && !driverClientsLoading) {
      driverClientsLoading = true;
      try {
        const r = await api("/api/drivers/clients");
        updateClientLayer(ymaps, (r && r.clients) || []);
      } catch { /* admin-only; повторим в следующий тик */ }
      driverClientsLoading = false;
      driverClientsDueAt = now + 30000;
    }

    // Инкрементально обновляем зелёные метки водителей (без removeAll карты).
    updateDriverLive(ymaps, locs, routeNameById);

    if (el.driverMapCount) {
      el.driverMapCount.textContent = `водителей на карте: ${locs.length}`;
    }
    // Фокусируем камеру на всех точках только при первой загрузке.
    if (!driverMapFitted) {
      const pts = [];
      Object.keys(driverLiveMarks).forEach((id) => {
        const g = driverLiveMarks[id] && driverLiveMarks[id].geometry;
        if (g) pts.push(g.getCoordinates());
      });
      if (routes) {
        routes.forEach((route) => {
          const base = route.progress;
          if (base && Number.isFinite(base.baseLat) && Number.isFinite(base.baseLon)) pts.push([base.baseLat, base.baseLon]);
          (route.clients || []).forEach((c) => { if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) pts.push([c.lat, c.lon]); });
        });
      }
      // НЕ включаем всех клиентов справочника в кадр: если они в разных регионах,
      // карта раскроется на всю страну/мир. Фокусируемся на водителях и маршрутах
      // выбранного дня — локальный рабочий район.
      // Отбрасываем некорректные/нулевые координаты, чтобы одна битая точка
      // не раскатывала камеру в мировой масштаб.
      const valid = pts.filter((p) =>
        Array.isArray(p) && p.length >= 2 &&
        Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
        (Math.abs(p[0]) > 1e-9 || Math.abs(p[1]) > 1e-9) &&
        p[0] >= -90 && p[0] <= 90 && p[1] >= -180 && p[1] <= 180
      );
      if (valid.length) {
        try { driverMap.setBounds(valid, { checkZoomRange: true, zoomMargin: 40 }); } catch { /* ignore */ }
        driverMapFitted = true;
      }
      // Если точек ещё нет (координаты не подоспели), НЕ фиксируем камеру —
      // повторим фокусировку на следующем тике, когда появятся реальные объекты.
      // Иначе карта навсегда осталась бы в глобальном масштабе.
    }
  }

  // Инкрементально обновляет серые маркеры всех клиентов справочника на карте:
  // добавляет новые, двигает изменившиеся и убирает удалённые — без перерисовки
  // всего статичного слоя. И показывает, где находятся клиенты, включая тех,
  // что не попали в маршруты выбранного дня. Клиенты без координат пропускаются.
  function updateClientLayer(ymaps, clients) {
    if (!driverMap) return;
    const seen = new Set();
    clients.forEach((c) => {
      if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return;
      const id = String(c.id != null ? c.id : c.client);
      seen.add(id);
      const hint = (c.bundleAddress && c.bundleAddress !== c.address)
        ? `${c.client} · ${c.bundleAddress}`
        : (c.client || "Клиент");
      const mark = driverClientMarks[id];
      if (mark) {
        const g = mark.geometry && mark.geometry.getCoordinates();
        if (!g || g[0] !== c.lat || g[1] !== c.lon) {
          try { mark.geometry.setCoordinates([c.lat, c.lon]); } catch { /* ignore */ }
        }
        try { mark.properties.set("hintContent", hint); } catch { /* ignore */ }
      } else {
        const m = new ymaps.Placemark(
          [c.lat, c.lon],
          { hintContent: hint },
          { preset: "islands#redCircleDotIcon" }
        );
        driverClientMarks[id] = m;
      }
    });
    Object.keys(driverClientMarks).forEach((id) => {
      if (!seen.has(id) && driverClientMarks[id]) {
        delete driverClientMarks[id];
      }
    });
    // Сам маркеры в карту не добавляем — их держит кластерер. Пересобираем его,
    // ТОЛЬКО когда набор/позиции клиентов изменились (иначе на каждом 30-секундном
    // тике пересборка тысячи маркеров впустую тормозила бы раздел).
    const newSig = Object.keys(driverClientMarks)
      .sort()
      .map((id) => {
        const m = driverClientMarks[id];
        const g = m && m.geometry ? m.geometry.getCoordinates() : null;
        return id + ":" + (g ? g[0].toFixed(4) + "," + g[1].toFixed(4) : "");
      })
      .join("|");
    if (newSig !== driverClientSig) {
      driverClientSig = newSig;
      if (driverClientClusterer) {
      try {
        driverClientClusterer.removeAll();
        driverClientClusterer.add(Object.values(driverClientMarks));
      } catch { /* ignore */ }
      }
    }
  }

  // Статичный слой карты: базы, клиенты и полилинии пройденного пути. Строится
  // только при изменении набора/статуса маршрутов — дорогая операция, поэтому её
  // выполняем редко, а не на каждом тике автообновления.
  function drawDriverRouteLayers(ymaps, routes) {
    if (!driverMap) return;
    driverMap.geoObjects.removeAll();
    // Возвращаем на карту слой GPS-следа (removeAll снимает и его).
    if (driverTrackCollection) driverMap.geoObjects.add(driverTrackCollection);
    // Возвращаем на карту живые метки водителей (их мы ведём инкрементально).
    Object.keys(driverLiveMarks).forEach((id) => {
      if (driverLiveMarks[id]) driverMap.geoObjects.add(driverLiveMarks[id]);
    });
    // Возвращаем на карту кластерер маркеров клиентов (removeAll снимает и его).
    if (driverClientClusterer) driverMap.geoObjects.add(driverClientClusterer);
    routes.forEach((route) => {
      const base = route.progress;
      if (base && Number.isFinite(base.baseLat) && Number.isFinite(base.baseLon)) {
        driverMap.geoObjects.add(new ymaps.Placemark(
          [base.baseLat, base.baseLon],
          { hintContent: "База · " + (route.driverName || "") },
          { preset: "islands#darkBlueDotIcon" }
        ));
      }
      (route.clients || []).forEach((c) => {
        if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
          driverMap.geoObjects.add(new ymaps.Placemark(
            [c.lat, c.lon],
            { hintContent: c.client || "Точка" },
            { preset: "islands#blueDotIcon" }
          ));
        }
      });
    });
  }

  // Инкрементальное обновление зелёных меток водителей: двигаем существующие,
  // добавляем новые, убираем исчезнувшие — без полной перерисовки карты.
  function updateDriverLive(ymaps, locs, routeNameById) {
    if (!driverMap) return;
    const seen = new Set();
    locs.forEach((d) => {
      if (!Number.isFinite(d.lat) || !Number.isFinite(d.lon)) return;
      seen.add(d.id);
      const label = (d.routeId && routeNameById[d.routeId]) ? ` · ${routeNameById[d.routeId]}` : "";
      const hint = (d.name || "Водитель") + " · на карте" + label;
      let m = driverLiveMarks[d.id];
      if (m) {
        try { m.geometry.setCoordinates([d.lat, d.lon]); } catch { /* ignore */ }
        try { m.properties.set("hintContent", hint); } catch { /* ignore */ }
      } else {
        m = new ymaps.Placemark([d.lat, d.lon], { hintContent: hint }, { preset: "islands#greenCircleDotIcon" });
        driverLiveMarks[d.id] = m;
        driverMap.geoObjects.add(m);
      }
    });
    Object.keys(driverLiveMarks).forEach((id) => {
      if (seen.has(id)) return;
      const m = driverLiveMarks[id];
      if (m) { try { driverMap.geoObjects.remove(m); } catch { /* ignore */ } }
      delete driverLiveMarks[id];
    });
  }

  // Загружает GPS-следы водителей (/api/drivers/tracks) и перерисовывает слой
  // реального пройденного пути. Вызывается редко (~раз в 30 с), отдельным лёгким
  // запросом, чтобы не тянуть точки трека при каждом автообновлении позиций.
  async function loadDriverTracks(ymaps) {
    if (!driverMap || !driverTrackCollection) return;
    driverTracksDueAt = Date.now() + 30000;
    let tracks = [];
    try {
      // След показываем за выбранный день (если дата задана — с ?date=).
      const dateNow = el.driverTrackDate ? (el.driverTrackDate.value || "") : "";
      const q = dateNow ? "?date=" + encodeURIComponent(dateNow) : "";
      // /snapped — GPS-след, привязанный к дорожной сети (как в навигаторе),
      // через серверный OSRM map-matching. Формат ответа тот же {id, name, track}.
      const t = await api("/api/drivers/tracks/snapped" + q);
      tracks = (t && t.tracks) || [];
    } catch { return; }
    driverTracks = {};
    tracks.forEach((o) => { if (o && o.id && Array.isArray(o.track)) driverTracks[o.id] = o.track; });
    drawDriverTracks(ymaps);
  }

  // Рисует GPS-след водителей тонкой полупрозрачной линией по факту движения.
  function drawDriverTracks(ymaps) {
    if (!driverMap || !driverTrackCollection) return;
    const coll = driverTrackCollection;
    try { coll.removeAll(); } catch { /* ignore */ }
    Object.keys(driverTracks).forEach((id) => {
      const pts = driverTracks[id];
      if (!pts || pts.length < 2) return;
      const coords = pts.filter((p) =>
        Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
      );
      if (coords.length < 2) return;
      coll.add(new ymaps.Polyline(coords, {
        hintContent: "След движения",
      }, {
        strokeColor: "rgba(120,190,255,0.55)",
        strokeWidth: 3,
        strokeStyle: "solid",
      }));
    });
  }

  // ---- Дашборд движения водителей (подвкладка «Отчёт» маршрутизации) ----
  // Грузит /api/drivers/motion за выбранную дату и рендерит KPI-карточки и
  // таблицу: пробег (км), время в пути, время на точках и время обеда по
  // водителям. Времена считаются из точных интервалов маршрутов (по нажатиям
  // «начать маршрут», «на месте», «завершить», «обед»), а не из треков.
  function fmtHms(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h} ч ${m} мин`;
    if (m > 0) return `${m} мин ${s} с`;
    return `${s} с`;
  }
  async function loadMotionReport() {
    if (!el.motionTable) return;
    let date = el.motionDateFilter && el.motionDateFilter.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      date = dayKeyOf(Date.now());
      if (el.motionDateFilter) el.motionDateFilter.value = date;
    }
    let rows = [];
    try {
      const data = await api("/api/drivers/motion?date=" + encodeURIComponent(date));
      rows = (data && data.rows) || [];
    } catch { rows = []; }
    // KPI-карточки.
    const km = rows.reduce((s, r) => s + (r.km || 0), 0);
    const moveSec = rows.reduce((s, r) => s + (r.moveSec || 0), 0);
    const lunchSec = rows.reduce((s, r) => s + (r.lunchSec || 0), 0);
    if (el.motionDrivers) el.motionDrivers.textContent = String(rows.length);
    if (el.motionKm) el.motionKm.textContent = String(Math.round(km * 10) / 10);
    if (el.motionMove) el.motionMove.textContent = fmtHms(moveSec);
    if (el.motionLunch) el.motionLunch.textContent = fmtHms(lunchSec);
    // Таблица.
    const body = el.motionBody;
    if (!body) return;
    body.innerHTML = "";
    if (el.driverReportStub) el.driverReportStub.style.display = rows.length ? "none" : "";
    if (!rows.length) return;
    const frag = document.createDocumentFragment();
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      const kmFmt = (Math.round((r.km || 0) * 10) / 10).toFixed(1);
      const kmHint = r.kmSource === "gps"
        ? "по фактическому GPS-треку"
        : "по прямой между точками маршрута";
      tr.innerHTML =
        `<td class="col-idx">${i + 1}</td>` +
        `<td class="col-name">${escapeHtml(r.name || "Водитель")}</td>` +
        `<td class="km-cell" title="Пробег: ${escapeHtml(kmHint)}">${kmFmt}${r.kmSource === "gps" ? " <span class='km-src'>GPS</span>" : ""}</td>` +
        `<td class="move-cell">${fmtHms(r.moveSec || 0)}</td>` +
        `<td class="site-cell">${fmtHms(r.siteSec || 0)}</td>` +
        `<td class="idle-cell">${fmtHms(r.lunchSec || 0)}</td>` +
        `<td>${r.points || 0}</td>`;
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  // Динамически показываем/скрываем вкладки «Мои маршруты» и «Маршрутизация»
  // при изменении ролей или переключении настроек — без перезагрузки страницы.
  function refreshNavTabs() {
    if (!el.tabs) return;
    const myRoutesVisible =
      (!!state.isAdmin && !!state.params.adminSeeRoutes) ||
      (!!state.isDriver && !!state.params.driverSeeRoutes);
    const driversVisible = !!state.isAdmin && !!state.params.showDrivers;

    el.tabs.querySelectorAll(".tab.driver-only-tab").forEach((d) => {
      d.classList.toggle("admin-visible", myRoutesVisible);
      d.hidden = !myRoutesVisible;
    });
    el.tabs.querySelectorAll(".tab.admin-only-drivers").forEach((t) => {
      t.classList.toggle("admin-visible", driversVisible);
      t.hidden = !driversVisible;
    });
    // «Отгрузка» видна только сотрудникам групп, отмеченных в параметрах.
    const shipmentVisibleNow = shipmentVisible();
    el.tabs.querySelectorAll(".tab.shipment-only").forEach((t) => {
      t.classList.toggle("admin-visible", shipmentVisibleNow);
      t.hidden = !shipmentVisibleNow;
    });

    // Если активная вкладка только что скрылась — уходим на доступную.
    const activeEl = el.tabs.querySelector(".tab.active");
    const activeName = activeEl ? activeEl.dataset.tab : null;
    if (activeName === "myroutes" && !myRoutesVisible) switchTab("calendar");
    else if (activeName === "drivers" && !driversVisible) switchTab("calendar");
    else if (activeName === "shipment" && !shipmentVisibleNow) switchTab("calendar");
  }

  // Кэш клиентов; выпадающий список с поиском (мультивыбор) для маршрута.
  let driverClientsCache = [];
  let routeClientSearchValue = "";

  // ---- Связки контрагентов на один адрес ----
  // Расставляем чекбоксы в списке клиентов и создаём связку (общий адрес +
  // единый bundleId). В «Маршрут на день» выбор одного клиента связки
  // автоматически выделяет всех остальных из этой связки.
  const bundlePick = new Set();

  function renderBundlePick() {
    if (!el.bundlePickList) return;
    if (driverClientsCache.length === 0) {
      el.bundlePickList.innerHTML = `<div class="empty-hint">Сначала добавьте контрагентов.</div>`;
      return;
    }
    el.bundlePickList.innerHTML = driverClientsCache.map((c) => {
      const on = bundlePick.has(String(c.id));
      const inBundle = !!c.bundleId;
      return `
        <button type="button" class="bundle-pick-card${on ? " picked" : ""}${inBundle ? " locked" : ""}" data-id="${escapeHtml(c.id)}" ${inBundle ? "disabled title='Клиент уже в связке'" : ""}>
          <span class="bundle-pick-card-top">
            <span class="bundle-pick-avatar">${escapeHtml(String(c.client).trim().charAt(0).toUpperCase())}</span>
            <span class="bundle-pick-check" aria-hidden="true">
              ${on ? `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>` : ""}
            </span>
          </span>
          <span class="bundle-pick-body">
            <span class="bundle-pick-name">${escapeHtml(c.client)}</span>
            <span class="bundle-pick-addr">${escapeHtml(c.address || "")}</span>
          </span>
          ${inBundle ? `<span class="bundle-pick-badge">в связке</span>` : ""}
        </button>
      `;
    }).join("");
    // Клиенты уже в связке не выбираются; остальные — кликабельные плитки.
    el.bundlePickList.querySelectorAll(".bundle-pick-card:not(:disabled)").forEach((card) => {
      card.addEventListener("click", () => toggleBundlePick(card.dataset.id));
    });
  }

  // Переключает выбор контрагента в форме новой связки и перерисовывает карточки.
  function toggleBundlePick(id) {
    if (bundlePick.has(String(id))) bundlePick.delete(String(id));
    else bundlePick.add(String(id));
    renderBundlePick();
  }

  function renderBundleList() {
    if (!el.bundleList) return;
    // Group clients by bundleId.
    const groups = new Map(); // bundleId -> { address, members }
    for (const c of driverClientsCache) {
      if (!c.bundleId) continue;
      // Общий адрес связки хранится в bundleAddress; address — собственный
      // адрес контрагента (перезаписью не трогаем). Для старых связок, где
      // bundleAddress ещё нет, используем текущий address как фолбэк.
      if (!groups.has(c.bundleId)) groups.set(c.bundleId, { bundleId: c.bundleId, address: c.bundleAddress || c.address || "", members: [] });
      groups.get(c.bundleId).members.push(c);
    }
    const list = [...groups.values()].sort((a, b) => a.bundleId < b.bundleId ? -1 : 1);

    if (list.length === 0) {
      el.bundleList.innerHTML = `<div class="empty-hint">Связок пока нет. Создайте первую.</div>`;
      return;
    }

    el.bundleList.innerHTML = list.map((g) => {
      const avatarTexts = g.members.slice(0, 3).map((m) => String(m.client).trim().charAt(0).toUpperCase());
      const extra = g.members.length - avatarTexts.length;
      return `
        <div class="bundle-card" data-bundle="${escapeHtml(g.bundleId)}">
          <div class="bundle-card-top">
            <div class="bundle-card-avatars">
              ${avatarTexts.map((t) => `<span class="bundle-card-avatar">${escapeHtml(t)}</span>`).join("")}
              ${extra > 0 ? `<span class="bundle-card-avatar bundle-card-avatar-more">+${extra}</span>` : ""}
            </div>
            <span class="bundle-card-count">${g.members.length} ${plural(g.members.length, "контрагент", "контрагента", "контрагентов")}</span>
          </div>
          <div class="bundle-card-addr" title="${escapeHtml(g.address || "—")}">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-5.2-7-11a7 7 0 0 1 14 0c0 5.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.6"/></svg>
            <span>${escapeHtml(g.address || "—")}</span>
          </div>
          <div class="bundle-card-members">
            ${g.members.map((m) => `
              <span class="bundle-member">
                ${escapeHtml(m.client)}
                <button type="button" class="bundle-member-remove" data-id="${escapeHtml(m.id)}" title="Разорвать связь" aria-label="Разорвать связь">×</button>
              </span>
            `).join("")}
          </div>
          <div class="bundle-card-actions">
            <button type="button" class="drv-mini-btn bundle-to-route" data-bundle="${escapeHtml(g.bundleId)}">В маршрут</button>
            <button type="button" class="drv-mini-btn bundle-unlink" data-bundle="${escapeHtml(g.bundleId)}">Развязать</button>
          </div>
        </div>
      `;
    }).join("");

    el.bundleList.querySelectorAll(".bundle-member-remove").forEach((b) => {
      b.addEventListener("click", () => unbundleClient(b.dataset.id));
    });
    el.bundleList.querySelectorAll(".bundle-to-route").forEach((b) => {
      b.addEventListener("click", () => selectBundleForRoute(b.dataset.bundle));
    });
    el.bundleList.querySelectorAll(".bundle-unlink").forEach((b) => {
      b.addEventListener("click", () => unbundleAll(b.dataset.bundle));
    });
  }

  function refreshBundleUi() {
    renderBundlePick();
    renderBundleList();
  }

  async function createBundle() {
    const ids = [...bundlePick];
    const address = (el.bundleAddress && el.bundleAddress.value || "").trim();
    if (ids.length < 2) { toast("Выберите хотя бы двух контрагентов"); return; }
    if (!address) { toast("Укажите общий адрес связки"); return; }
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ action: "bundle", ids, address }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      bundlePick.clear();
      if (el.bundleAddress) el.bundleAddress.value = "";
      refreshBundleUi();
      toast("Контрагенты связаны на один адрес");
    } catch (e) {
      toast(e.message);
    }
  }

  async function unbundleClient(id) {
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ action: "unbundle", id }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      selectedRouteClientIds.delete(id);
      removeFromRouteOrder(id);
      renderRouteClientOptions();
      renderRouteClientSelected();
      refreshBundleUi();
      toast("Связь разорвана");
    } catch (e) {
      toast(e.message);
    }
  }

  // Развязать всех участников одной связки (снимает bundleId у каждого).
  async function unbundleAll(bundleId) {
    const members = driverClientsCache.filter((c) => c.bundleId === bundleId);
    if (members.length === 0) return;
    try {
      for (const m of members) {
        await api("/api/drivers/clients", {
          method: "POST",
          body: JSON.stringify({ action: "unbundle", id: m.id }),
        });
      }
      reloadDriverClients();
      toast("Связка развязана");
    } catch (e) {
      toast(e.message);
    }
  }

  async function selectBundleForRoute(bundleId) {
    const members = driverClientsCache.filter((c) => c.bundleId === bundleId);
    if (members.length === 0) return;
    for (const m of members) {
      selectedRouteClientIds.add(String(m.id));
      addToRouteOrder(String(m.id));
    }
    renderRouteClientOptions();
    renderRouteClientSelected();
    switchRouteSubtab("route");
    toast("Контрагенты связки добавлены в маршрут");
  }

  function reloadDriverClients() {
    loadDriverClients();
  }

  // Раздел «Доставка» (доступен всем): показывает маршруты всех водителей за дату
  // информационно — как едет каждый водитель, у кого какой маршрут. Без кнопок
  // действий: только данные и статусы. Источник — GET /api/deliveries.
  function renderDeliveries() {
    if (el.deliveryDateFilter) el.deliveryDateFilter.value = el.deliveryDateFilter.value || dayKeyOf(Date.now());
    loadDeliveries();
  }

  async function loadDeliveries() {
    if (!el.deliveryList) return;
    let date = el.deliveryDateFilter ? el.deliveryDateFilter.value : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) date = dayKeyOf(Date.now());
    let deliveries = [];
    try {
      const r = await api("/api/deliveries?date=" + encodeURIComponent(date));
      deliveries = (r && Array.isArray(r.deliveries)) ? r.deliveries : [];
    } catch { deliveries = []; }
    if (el.deliveryCount) el.deliveryCount.textContent =
      deliveries.length ? `${deliveries.length} ${plural(deliveries.length, "маршрут", "маршрута", "маршрутов")}` : "—";
    const body = el.deliveryList;
    if (!body) return;
    if (!deliveries.length) {
      body.innerHTML = `<div class="empty-hint">На эту дату маршрутов доставки нет.</div>`;
      return;
    }
    // Сортируем: активные/в пути сверху, остальные ниже; внутри — по водителю.
    const prio = { active: 0, idle: 1, done: 2 };
    deliveries.sort((x, y) =>
      (prio[y.status] ?? 3) - (prio[x.status] ?? 3) ||
      String(x.driverName || "").localeCompare(String(y.driverName || ""), "ru")
    );
    body.innerHTML = deliveries.map((d) => deliveryCard(d)).join("");
    // Живые таймеры «сколько водитель в пути / на точке» в разделе «Доставка»:
    // перерисовываем их раз в секунду без перезагрузки страницы.
    refreshLiveRouteNodes();
    startLiveRouteTicker();
    tickLiveRouteTimers();
  }

  function deliveryCard(d) {
    const p = d.status || "idle";
    let statusBadge = "";
    if (p === "active") statusBadge = `<span class="rms-status active">В пути</span>`;
    else if (p === "done") statusBadge = `<span class="rms-status done">Завершён</span>`;
    else statusBadge = `<span class="rms-status idle">Ожидает</span>`;

    const activeIdx = (d.clients || []).findIndex((c) => c.state === "in_transit" || c.state === "on_site");
    const stops = (d.clients || []).map((c, i) => {
      const st = c.state || "pending";
      let timeLine = "";
      let timerHtml = "";
      if (st === "in_transit") {
        timeLine = `<span class="rms-stop-tag">едем</span>`;
        timerHtml = `<div class="rms-stop-times is-live" data-live-timer="path"
          data-start="${c.transitStart || ""}" data-paused="${c.transitPaused || 0}"
          data-lunch-active="${d.lunchActive ? "1" : ""}" data-lunch-start="${d.lunchStart || ""}">
          <span class="rms-live-label">В пути</span>
          <span class="rms-live-clock" data-live-clock="path">00:00:00</span>
        </div>`;
      } else if (st === "on_site") {
        timeLine = `<span class="rms-stop-tag on-site">на месте</span>`;
        timerHtml = `<div class="rms-stop-times is-live" data-live-timer="site" data-start="${c.siteStart || ""}">
          <span class="rms-live-label">На точке</span>
          <span class="rms-live-clock" data-live-clock="site">00:00:00</span>
        </div>`;
      } else if (st === "delivered") {
        timeLine = `<span class="rms-stop-done" title="Точка пройдена">✓</span>`;
        const transit = (c.transitEnd && c.transitStart)
          ? (c.transitEnd - c.transitStart - (Number.isFinite(c.transitPaused) ? c.transitPaused : 0)) : null;
        const site = (c.siteEnd && c.siteStart) ? (c.siteEnd - c.siteStart) : null;
        timerHtml = `<div class="rms-stop-times">
          <span>Путь: ${fmtDuration(transit)}</span>
          <span>На точке: ${fmtDuration(site)}</span>
        </div>`;
      } else if (st === "postponed") {
        timeLine = `<span class="rms-stop-tag postponed">перенос</span>`;
        const transit = (c.transitEnd && c.transitStart)
          ? (c.transitEnd - c.transitStart - (Number.isFinite(c.transitPaused) ? c.transitPaused : 0)) : null;
        const site = (c.siteEnd && c.siteStart) ? (c.siteEnd - c.siteStart) : null;
        timerHtml = `<div class="rms-stop-times">
          <span>Путь: ${fmtDuration(transit)}</span>
          <span>На точке: ${fmtDuration(site)}</span>
        </div>`;
      }
      const activeCls = (i === activeIdx && (st === "in_transit" || st === "on_site")) ? " is-active" : "";
      return `
        <div class="rms-stop${activeCls}">
          <div class="rms-stop-top">
            <span class="rms-stop-idx">${i + 1}</span>
            <span class="rms-stop-name">${escapeHtml(c.client || "")} ${timeLine}</span>
          </div>
          ${c.address ? `<div class="rms-stop-addr">${escapeHtml(c.address)}</div>` : ""}
          ${timerHtml}
        </div>
      `;
    }).join("");

    const dateStr = d.date ? fmtDateReadable(d.date) : "—";
    const slot = d.routeName ? `Маршрут ${d.routeName}` : "Маршрут";
    return `
      <div class="delivery-card">
        <div class="delivery-card-head">
          <div class="delivery-driver">
            <span class="delivery-driver-name">${escapeHtml(d.driverName || "Водитель")}</span>
            <span class="delivery-driver-route">${escapeHtml(slot)} · ${escapeHtml(dateStr)}</span>
          </div>
          ${statusBadge}
        </div>
        ${stops}
      </div>
    `;
  }

  // Водительский раздел «Мои маршруты»: показывает только маршруты текущего
  // водителя (сервер уже фильтрует по user.id), с фильтром по дате.
  let myRoutesCache = [];
  function renderMyRoutes() {
    if (el.myroutesDateFilter) el.myroutesDateFilter.value = el.myroutesDateFilter.value || dayKeyOf(Date.now());
    loadMyRoutes();
  }

  async function loadMyRoutes() {
    try {
      const r = await api("/api/drivers/routes"); // server returns only this driver's routes
      if (r && Array.isArray(r.routes)) {
        myRoutesCache = r.routes;
        renderMyRoutesList(myRoutesCache);
      }
    } catch { /* keep current */ }
  }

  function renderMyRoutesList(routes) {
    const filter = el.myroutesDateFilter ? el.myroutesDateFilter.value : "";
    const list = filter ? routes.filter((r) => String(r.date) === filter) : routes;
    if (el.myroutesCount) {
      el.myroutesCount.textContent = list.length
        ? `${list.length} ${plural(list.length, "маршрут", "маршрута", "маршрутов")}`
        : "0";
    }
    if (!el.myroutesList) return;
    if (list.length === 0) {
      el.myroutesList.innerHTML = `<div class="empty-hint">На эту дату маршруты не назначены.</div>`;
      return;
    }
    const sorted = [...list].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    // Рабочий день завершён — новый маршрут брать нельзя (кнопка «Начать»
    // у незапущенных маршрутов блокируется).
    const dayFinished = state.phase === "finished";
    el.myroutesList.innerHTML = sorted.map((r) => renderMyRouteCard(r, dayFinished)).join("");
    el.myroutesList.querySelectorAll("[data-route-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const routeActionName = btn.dataset.routeAction;
        // «Перенос» сначала просит выбрать причину во всплывающем окне.
        if (routeActionName === "postpone") {
          openPostponeModal(btn.dataset.routeId);
          return;
        }
        // «Сканировать выгрузку» — локальный запуск сканера для клиента маршрута
        // (не серверное действие routeAction).
        if (routeActionName === "scan_unload") {
          startDriverUnloadScan(btn.dataset.routeId, btn.dataset.clientIdx);
          return;
        }
        routeAction(routeActionName, btn.dataset.routeId);
      });
    });
    // Живые счётчики: немедленно отрисовать текущие значения и запустить
    // единый секундный тикер (если ещё не запущен).
    refreshLiveRouteNodes();
    startLiveRouteTicker();
    tickLiveRouteTimers();
  }

  // ---- Отгрузка (склад) ----
  // Показывает маршруты водителей, ожидающие отгрузки. Склад завершает отгрузку
  // одной кнопкой — после этого водитель может начать маршрут (если админ не
  // разрешил игнорировать склад).
  let shipmentsCache = [];

  async function loadShipments() {
    if (!el.shipmentList) return;
    el.shipmentList.innerHTML = `<div class="empty-hint">Загрузка маршрутов…</div>`;
    let routes = [];
    try {
      const r = await api("/api/shipments");
      routes = (r && r.routes) || [];
    } catch {
      el.shipmentList.innerHTML = `<div class="empty-hint">Не удалось загрузить маршруты отгрузки.</div>`;
      return;
    }
    shipmentsCache = routes;
    renderShipments();
  }

  function renderShipments() {
    if (!el.shipmentList) return;
    if (shipmentsCache.length === 0) {
      el.shipmentList.innerHTML = `<div class="empty-hint">Маршрутов, ожидающих отгрузки, нет.</div>`;
      return;
    }
    el.shipmentList.innerHTML = shipmentsCache.map((r) => {
      const dateStr = r.date ? fmtDateReadable(r.date) : "—";
      // Три стадии отгрузки:
      // 1) не начата   — «Начать отгрузку»
      // 2) идёт        — «Завершить отгрузку»
      // 3) завершена   — «Отгружен» (водитель может начать маршрут)
      const shipStarted = !!(r.progress && r.progress.shipmentStartedAt);
      const shipDone = !!(r.progress && r.progress.shippedAt);
      let badge;
      if (shipDone) badge = `<span class="rms-status delivered">Отгружен</span>`;
      else if (shipStarted) badge = `<span class="rms-status active">Отгрузка идёт</span>`;
      else badge = `<span class="rms-status idle">Ожидает отгрузки</span>`;
      const clients = (r.clients || []).map((c) => `
        <div class="shipment-client">
          <span class="shipment-client-name">${escapeHtml(c.client || "—")}</span>
          ${c.address ? `<span class="shipment-client-addr">${escapeHtml(c.address)}</span>` : ""}
        </div>
      `).join("");
      let btn;
      if (shipDone) {
        btn = `<span class="shipment-shipped-note">Отгрузка завершена — водитель может начать маршрут</span>`;
      } else if (shipStarted) {
        btn = `<button type="button" class="ctrl ctrl-primary" data-shipment-complete="${escapeHtml(r.id)}">Завершить отгрузку</button>`;
      } else {
        btn = `<button type="button" class="ctrl ctrl-primary" data-shipment-start="${escapeHtml(r.id)}">Начать отгрузку</button>`;
      }
      // Печать этикеток на клиентов — доступна всегда (склад печатает при погрузке,
      // а водитель может до-печатать при необходимости).
      const printBtn = `<button type="button" class="ctrl ctrl-soft" data-shipment-print="${escapeHtml(r.id)}">Печать этикеток</button>`;
      return `
        <div class="shipment-card">
          <div class="shipment-card-head">
            <span class="driver-route-date">${escapeHtml(dateStr)}</span>
            <span class="driver-route-driver">${escapeHtml(r.driverName || "—")}</span>
            ${badge}
          </div>
          <div class="shipment-clients">${clients}</div>
          <div class="shipment-card-actions">${printBtn}${btn}</div>
        </div>
      `;
    }).join("");
    el.shipmentList.querySelectorAll("[data-shipment-complete]").forEach((btn) => {
      btn.addEventListener("click", () => completeShipment(btn.dataset.shipmentComplete, btn));
    });
    el.shipmentList.querySelectorAll("[data-shipment-start]").forEach((btn) => {
      btn.addEventListener("click", () => startShipment(btn.dataset.shipmentStart, btn));
    });
    el.shipmentList.querySelectorAll("[data-shipment-print]").forEach((btn) => {
      btn.addEventListener("click", () => openPrintLabels(btn.dataset.shipmentPrint));
    });
  }

  // ---- Печать этикеток отгрузки (склад: выбирает клиента и кол-во мест) ----
  let printRouteId = null;
  function openPrintLabels(routeId) {
    const r = shipmentsCache.find((x) => String(x.id) === String(routeId));
    if (!r || !Array.isArray(r.clients) || r.clients.length === 0) {
      toast("В отгрузке нет клиентов для печати");
      return;
    }
    printRouteId = routeId;
    const sel = el.printClientSelect;
    sel.innerHTML = r.clients
      .map((c, i) => `<option value="${i}">${escapeHtml(c.client || "—")}${c.address ? " — " + escapeHtml(c.address) : ""}</option>`)
      .join("");
    el.printPlacesQty.value = "1";
    if (el.printScanStatus) { el.printScanStatus.textContent = ""; el.printScanStatus.className = "print-scan-status"; }
    refreshPrintLabels();
    try { el.printModal.showModal(); } catch { /* уже открыта */ }
  }

  function buildQrImage(text) {
    let matrix;
    try { matrix = window.QRGen.generate(text); } catch { return { src: "", size: 0 }; }
    const n = matrix.length;
    const small = document.createElement("canvas");
    small.width = n; small.height = n;
    const sctx = small.getContext("2d");
    sctx.fillStyle = "#fff"; sctx.fillRect(0, 0, n, n);
    sctx.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matrix[r][c]) sctx.fillRect(c, r, 1, 1);
    const scale = 8;
    const big = document.createElement("canvas");
    big.width = n * scale; big.height = n * scale;
    const bctx = big.getContext("2d");
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(small, 0, 0, big.width, big.height);
    return { src: big.toDataURL("image/png"), size: n };
  }

  function doPrintLabels() {
    if (!printRouteId) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    if (!r) return;
    const idx = Number(el.printClientSelect.value || 0);
    const cl = (r.clients || [])[idx];
    if (!cl) return;
    const qty = Math.max(1, Math.min(200, Number(el.printPlacesQty.value) || 1));
    const dateStr = r.date || dayKeyOf(Date.now());
    const codeBase = "BG" + printRouteId + "-" + (idx + 1) + "-";
    const area = el.printArea;
    area.innerHTML = "";
    for (let i = 1; i <= qty; i++) {
      const code = codeBase + i;
      const card = document.createElement("div");
      card.className = "label-card";
      // Логотип на стикере: буквенный лого-блок (logoText, напр. «AVI»), либо legacy
      // изображение, если оно ещё задано. Наименование клиента на стикер НЕ выводим.
      let logoHtml = "";
      if (cl.logoText) {
        logoHtml = `<div class="label-logo label-logo-text">${escapeHtml(cl.logoText)}</div>`;
      } else if (cl.logo) {
        logoHtml = `<div class="label-logo"><img src="${cl.logo}" alt="лого" crossorigin="anonymous" /></div>`;
      }
      card.innerHTML =
        logoHtml +
        (cl.address ? `<div class="label-addr">${escapeHtml(cl.address)}</div>` : "") +
        `<div class="label-order">Отгрузка ${escapeHtml(dateStr)}</div>` +
        `<div class="label-name" style="margin-top:1mm">${i} из ${qty}</div>` +
        (() => {
          // QR на этикетке делаем крупным (4 пикселя на модуль, не меньше 70px),
          // чтобы мелкие модули не сливались и код надёжно читался камерой.
          const q = buildQrImage(code);
          const px = q && q.size ? Math.max(70, q.size * 4) : 0;
          return `<div class="label-qr">${px && q.src ? `<img alt="QR" width="${px}" height="${px}" src="${q.src}" />` : ""}</div>`;
        })() +
        `<div class="label-code">${escapeHtml(code)}</div>`;
      area.appendChild(card);
    }
    // Синхронизируем напечатанные места с серверным хранилищем этикеток (Шаг 2):
    // по тем же кодам QR склад/водитель потом отмечают погрузку и выгрузку.
    // Запись не блокирует печать — при сбое печать всё равно выполнится.
    try {
      api("/api/labels", {
        method: "POST",
        body: JSON.stringify({ routeId: printRouteId, clientIndex: idx, qty }),
      }).then((r) => {
        if (r && Array.isArray(r.labels)) {
          toast(`Создано мест: ${r.labels.length} — можно сканировать при погрузке/выгрузке`);
          renderPrintLabels(r.labels);
        }
      }).catch(() => {});
    } catch { /* ignore */ }
    try { el.printModal.close(); } catch { /* ignore */ }
    setTimeout(() => window.print(), 60);
  }

  // ---- Сканирование этикеток (погрузка/выгрузка) — Шаг 3 ----
  // Непрерывное сканирование и живой счётчик: состояние scanLabels + scanProgress.
  // После каждого успешного скана, пока есть неотсканированные места, сканер
  // открывается снова автоматически; когда всё готово — цикл останавливается.
  // Индекс выбранного клиента в модалке печати (0-based, как в select печати).
  function currentPrintClientIndex() {
    return Number(el.printClientSelect ? el.printClientSelect.value : 0) || 0;
  }

  function setPrintScanStatus(text, cls) {
    if (!el.printScanStatus) return;
    el.printScanStatus.textContent = text || "";
    el.printScanStatus.className = "print-scan-status" + (cls ? " " + cls : "");
  }

  // ---- Оверлей живого прогресса сканирования (между сканами нативного ZXing).
  // Показывает крупно клиента и счётчик «отсканировано / нужно», чтобы водитель
  // видел остаток, пока камера закрыта (нативный сканер открывается на каждое место).
  function scanOverlay() {
    return {
      wrap: document.getElementById("scanOverlay"),
      client: document.getElementById("scanOverlayClient"),
      logo: document.getElementById("scanOverlayLogo"),
      done: document.getElementById("scanOverlayDone"),
      need: document.getElementById("scanOverlayNeed"),
      note: document.getElementById("scanOverlayNote"),
    };
  }

  // Данные текущего клиента окна «Печать этикеток» (или у водителя — из маршрута):
  // имя, адрес и логотип (logo — изображение, logoText — буквенная аббревиатура).
  // Логотип нужен, чтобы показывать бренд клиента в оверлее прогресса (как «AVI»
  // у Авилона). Если логотипа нет — оверлей показывает имя + адрес как раньше.
  function scanClientInfo() {
    const info = { name: "—", address: "", logo: "", logoText: "" };
    const sel = el.printClientSelect;
    if (sel && sel.selectedOptions && sel.selectedOptions[0]) {
      info.name = sel.selectedOptions[0].textContent || "—";
    }
    // Достаём «сырого» клиента из кэша отгрузок — там есть logo/logoText/address.
    try {
      const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
      const cl = r && Array.isArray(r.clients) ? r.clients[currentPrintClientIndex()] : null;
      if (cl) {
        if (cl.client) info.name = cl.client;
        if (cl.address) info.address = cl.address;
        if (cl.logo) info.logo = cl.logo;
        if (cl.logoText) info.logoText = String(cl.logoText);
      }
    } catch (e) { /* не критично */ }
    return info;
  }

  // Имя текущего клиента в окне «Печать этикеток» (или у водителя — из маршрута)
  // для передачи в нативный сканер.
  function scanClientName() {
    return scanClientInfo().name;
  }

  function showScanOverlay(prog, note) {
    const o = scanOverlay();
    if (!o.wrap) return;
    const info = scanClientInfo();
    // Логотип клиента: если задано изображение (logo) — показываем картинку;
    // иначе если задана буквенная аббревиатура (logoText, напр. «AVI») — блок
    // с текстом. Если логотипа нет — как раньше: имя и адрес текстом.
    if (info.logo || info.logoText) {
      if (o.logo) {
        if (info.logo) {
          o.logo.innerHTML = `<img src="${info.logo}" alt="лого" crossorigin="anonymous" />`;
        } else {
          o.logo.innerHTML = `<div class="scan-overlay-logo-text">${escapeHtml(info.logoText)}</div>`;
        }
        o.logo.hidden = false;
      }
      if (o.client) {
        o.client.textContent = info.name + (info.address ? " — " + info.address : "");
      }
    } else {
      if (o.logo) o.logo.hidden = true;
      if (o.client) o.client.textContent = info.name + (info.address ? " — " + info.address : "");
    }
    o.done.textContent = String(prog.done || 0);
    o.need.textContent = String(prog.need || 0);
    o.note.textContent = note || "";
    o.wrap.hidden = false;
  }

  function hideScanOverlay() {
    scanAuto = false;
    const o = scanOverlay();
    if (o.wrap) o.wrap.hidden = true;
  }

  // Вызов нативного сканера (AndroidBridge.scanQR) с передачей счётчика и имени
  // клиента, чтобы кастомная камера QrScanActivity показывала прогресс во время
  // сканирования. Фолбэк на старую сигнатуру (старого APK) — безопасно.
  function invokeNativeScan(callback, action, done, need, client) {
    if (!window.AndroidBridge || typeof window.AndroidBridge.scanQR !== "function") {
      return false;
    }
    try {
      // Новая сигнатура: scanQR(callback, action, done, need, client)
      window.AndroidBridge.scanQR(
        callback,
        action,
        Number(done) || 0,
        Number(need) || 0,
        String(client || "")
      );
      return true;
    } catch (e) {
      // Старый мост не принимает 5 аргументов — пробуем усечённую сигнатуру.
      try {
        window.AndroidBridge.scanQR(callback, action);
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  // Текущий режим сканирования мест (load/unload) и актуальный список этикеток
  // выбранного клиента. Нужны для непрерывного сканирования и живого счётчика.
  let scanMode = null;
  let scanAuto = false;
  let scanLabels = [];

  // Прогресс сканирования: need — сколько нужно отсканировать для выбранного
  // действия, done — сколько уже обработано, remaining — остаток.
  function scanProgress(labels, action) {
    const total = (labels || []).length;
    const loaded = (labels || []).filter((l) => l.status === "loaded" || l.status === "delivered").length;
    const delivered = (labels || []).filter((l) => l.status === "delivered").length;
    const need = action === "unload" ? loaded : total;
    const done = action === "unload" ? delivered : loaded;
    return { total, loaded, delivered, need, done, remaining: Math.max(0, need - done) };
  }

  const STATUS_LABEL = { created: "создана", loaded: "погружена", delivered: "выгружена" };
  const STATUS_CLASS = { created: "created", loaded: "loaded", delivered: "delivered" };

  function renderPrintLabels(labels) {
    // Актуальный список этикеток выбранного клиента — источник правды для живого
    // счётчика и непрерывного сканирования (qrScanCallback читает именно его).
    scanLabels = labels || [];
    if (!el.printLabelsList) return;
    if (scanLabels.length === 0) {
      el.printLabelsList.innerHTML =
        '<div class="print-place"><span class="pp-code" style="opacity:.6">Мест пока нет — нажмите «Печать этикеток»</span></div>';
      if (el.printScanStatus) el.printScanStatus.textContent = "";
      return;
    }
    const sorted = [...scanLabels].sort((a, b) => Number(a.place) - Number(b.place));
    const prog = scanProgress(scanLabels, scanMode || "load");
    // Крупный живой счётчик: сколько осталось отсканировать в текущем действии
    // и сколько уже сделано. Понятно сразу, без чтения лога.
    if (el.printScanStatus) {
      const modeLabel = scanMode === "unload" ? "выгрузку" : "погрузку";
      el.printScanStatus.innerHTML =
        `<span class="scan-counter">
           <span class="scan-counter-big">${prog.done}<span class="scan-counter-of">/ ${prog.need}</span></span>
           <span class="scan-counter-note">${prog.remaining === 0 ? "Все места отсканированы" : `Осталось отсканировать: ${prog.remaining}`} · (${modeLabel})</span>
         </span>`;
      el.printScanStatus.className = "print-scan-status" + (prog.remaining === 0 ? " ok" : "");
    }
    el.printLabelsList.innerHTML = sorted.map((l) => `
      <div class="print-place">
        <span class="pp-code">${escapeHtml(l.code)}</span>
        <span class="pp-status ${STATUS_CLASS[l.status] || "created"}">${STATUS_LABEL[l.status] || l.status}</span>
      </div>
    `).join("");
  }

  // Статусы мест выбранного клиента (после печати или смены клиента).
  async function refreshPrintLabels() {
    if (!printRouteId) return;
    const ci = currentPrintClientIndex();
    try {
      const r = await api(`/api/labels?routeId=${encodeURIComponent(printRouteId)}&clientIndex=${ci}`);
      if (r && Array.isArray(r.labels)) renderPrintLabels(r.labels);
    } catch { /* опционально */ }
  }

  // Запуск сканирования: при наличии нативного моста (Android APK) — камера,
  // иначе (браузер/десктоп) — ручной ввод кода.
  function callQrScanner(action) {
    scanMode = action === "unload" ? "unload" : "load";
    setPrintScanStatus("");
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
      if (typeof window.qrScanCallback !== "function") window.qrScanCallback = qrScanCallback;
      const prog = scanProgress(scanLabels, action);
      invokeNativeScan("qrScanCallback", action, prog.done, prog.need, scanClientName());
      return;
    }
    // Fallback без камеры: имя склада вне Android-обёртки. Вводим код вручную.
    const code = prompt(`Сканера нет на этом устройстве.\nВведите код этикетки (${action === "load" ? "погрузка" : "выгрузка"}):`);
    if (code == null || !String(code).trim()) { setPrintScanStatus("Сканирование отменено", "warn"); return; }
    doScanLabel(action, String(code).trim());
  }

  // Выполнение отметки через сервер: POST /api/labels/scan { code, action }.
  // Возвращает true при успешной отметке — вызывающий (qrScanCallback) по этому
  // значению решает, продолжать ли непрерывное сканирование.
  async function doScanLabel(action, code) {
    try {
      const r = await api("/api/labels/scan", {
        method: "POST",
        body: JSON.stringify({ code, action }),
      });
      if (!r) { setPrintScanStatus("Нет ответа от сервера", "err"); return false; }
      if (r.ok && r.label) {
        // Обновляем статус места в локальном списке сразу, чтобы живой счётчик
        // пересчитался мгновенно, не дожидаясь повторного GET /api/labels.
        const updated = r.label;
        const idx = scanLabels.findIndex((l) => String(l.code) === String(updated.code));
        if (idx >= 0) scanLabels[idx] = Object.assign({}, scanLabels[idx], updated);
        else scanLabels.push(updated);
        const s = STATUS_LABEL[r.label.status] || r.label.status;
        const warn = r.warning ? ` · ${r.warning}` : "";
        setPrintScanStatus(`Код ${r.label.code} → ${s}.${warn}`, r.warning ? "warn" : "ok");
        refreshPrintLabels();
        return true;
      } else if (r.error) {
        setPrintScanStatus(String(r.error), "err");
        return false;
      }
      return false;
    } catch (e) {
      setPrintScanStatus((e && (e.error || e.message)) || "Ошибка сканирования", "err");
      return false;
    }
  }

  // Колбэк нативного сканера: AndroidBridge.scanQR вызывает window.qrScanCallback(payload).
  async function qrScanCallback(payload) {
    if (!payload) return;
    if (!payload.ok) {
      setPrintScanStatus(payload.message || "Сканирование завершено без результата", "warn");
      scanAuto = false;
      return;
    }
    const action = payload.action === "unload" ? "unload" : "load";
    scanMode = action;
    const code = String(payload.code || "").trim();
    const ok = await doScanLabel(action, code);
    // Непрерывный скан: если ещё остались неотсканированные места, автоматически
    // открываем сканер снова (не надо жать кнопку для каждого места).
    const prog = scanProgress(scanLabels, action);
    const modeLabel = action === "unload" ? "выгрузку" : "погрузку";
    const note = prog.remaining <= 0
      ? `Все места отсканированы (${modeLabel})`
      : `Осталось отсканировать: ${prog.remaining} · (${modeLabel})`;
    // Показываем крупный оверлей-прогресс с именем клиента и счётчиком,
    // чтобы водитель видел остаток между сканами нативной камеры.
    showScanOverlay(prog, note);
    if (!ok || prog.remaining <= 0) {
      // Ошибка или всё отсканировано — держим оверлей и не открываем камеру.
      scanAuto = false;
      return;
    }
    // Пауза, чтобы водитель успел увидеть счётчик, затем снова камера.
    scanAuto = true;
    await new Promise((r) => setTimeout(r, 2200));
    if (!scanAuto) { hideScanOverlay(); return; }
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
      hideScanOverlay();
      invokeNativeScan("qrScanCallback", action, prog.done, prog.need, scanClientName());
    } else {
      hideScanOverlay();
      callQrScanner(action);
    }
  }

  // ---- Сканирование выгрузки мест из «Моих маршрутов» водителя ----
  // Работает независимо от сканера склада: водитель на точке (on_site) жмёт
  // «Сканировать выгрузку», считывает коды этикеток мест (POST /api/labels/scan
  // с action "unload"), а «Завершить выгрузку» фиксирует завершение, НЕ закрывая
  // статус «на точке» (время сдачи продолжает считаться до «Завершить сдачу»).
  // Какой маршрут и какой клиент сейчас сканируем.
  let driverUnloadRouteId = null;
  let driverUnloadClientIdx = null;

  function startDriverUnloadScan(routeId, clientIdx) {
    driverUnloadRouteId = routeId;
    driverUnloadClientIdx = Number(clientIdx) || 0;
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
      if (typeof window.driverUnloadCallback !== "function") window.driverUnloadCallback = driverUnloadCallback;
      const cur = findDriverUnloadClient();
      const d = cur ? Number(cur.unloadDone) || 0 : 0;
      const n = cur ? Number(cur.unloadTotal) || 0 : 0;
      const cl = cur ? (cur.client || "—") : "—";
      invokeNativeScan("driverUnloadCallback", "unload", d, n, cl);
      return;
    }
    // Fallback без камеры: ручной ввод кода этикетки.
    const code = prompt("Сканера нет на этом устройстве.\nВведите код этикетки (выгрузка):");
    if (code == null || !String(code).trim()) { toast("Сканирование отменено"); return; }
    driverUnloadScanCode(String(code).trim());
  }

  async function driverUnloadScanCode(code) {
    try {
      const r = await api("/api/labels/scan", {
        method: "POST",
        body: JSON.stringify({ code, action: "unload" }),
      });
      if (r && r.ok && r.label) {
        const s = STATUS_LABEL[r.label.status] || r.label.status;
        toast(r.warning ? `${r.label.code} → ${s} · ${r.warning}` : `${r.label.code} → ${s}`);
      } else {
        toast((r && r.error) || "Не удалось отметить место");
      }
    } catch (e) {
      toast((e && (e.error || e.message)) || "Ошибка сканирования");
    }
    // Обновляем маршруты (счётчик выгрузки считает сервер) и решаем, продолжать
    // ли сканирование: пока остались невыгруженные места — открываем сканер снова.
    await loadMyRoutes();
    const cur = findDriverUnloadClient();
    const total = cur ? Number(cur.unloadTotal) || 0 : 0;
    const ready = cur ? cur.unloadReady === true : false;
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function" && total > 0 && !ready) {
      const cur = findDriverUnloadClient();
      const d = cur ? Number(cur.unloadDone) || 0 : 0;
      const cl = cur ? (cur.client || "—") : "—";
      invokeNativeScan("driverUnloadCallback", "unload", d, total, cl);
    }
  }

  // Колбэк нативного сканера: AndroidBridge.scanQR вызывает window.driverUnloadCallback(payload).
  async function driverUnloadCallback(payload) {
    if (!payload) return;
    if (!payload.ok) { toast(payload.message || "Сканирование завершено без результата"); return; }
    const code = String(payload.code || "").trim();
    if (!code) return;
    await driverUnloadScanCode(code);
  }

  // Возвращает точку маршрута, для которой сейчас идёт сканирование выгрузки,
  // из локального кэша (myRoutesCache) — для чтения счётчика и решения о цикле.
  function findDriverUnloadClient() {
    if (!driverUnloadRouteId) return null;
    const route = (myRoutesCache || []).find((r) => String(r.id) === String(driverUnloadRouteId));
    if (!route) return null;
    const clients = route.clients || [];
    return clients[driverUnloadClientIdx] || null;
  }

  async function startShipment(routeId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Начинаем…"; }
    try {
      const r = await api("/api/shipments/start", {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      if (r && r.ok) {
        toast("Отгрузка начата");
        loadShipments();
      }
    } catch (e) {
      const msg = (e && (e.error || e.message)) || "Не удалось начать отгрузку";
      toast(msg);
      if (btn) { btn.disabled = false; btn.textContent = "Начать отгрузку"; }
    }
  }

  async function completeShipment(routeId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Проверяем…"; }
    try {
      const r = await api("/api/shipments/complete", {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      if (r && r.ok) {
        toast("Отгрузка завершена");
        loadShipments();
      }
    } catch (e) {
      const msg = (e && (e.error || e.message)) || "Не удалось завершить отгрузку";
      toast(msg);
      if (btn) { btn.disabled = false; btn.textContent = "Завершить отгрузку"; }
    }
  }

  // Форматирует миллисекунды как «ЧЧ:ММ» (часы, минуты).
  function fmtDuration(ms) {
    if (!ms || isNaN(ms) || ms < 0) return "—";
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}:${String(m).padStart(2, "0")}`;
  }

  // Форматирует миллисекунды как «ЧЧ:ММ:СС» (часы:минуты:секунды) — для
  // живого счётчика времени, обновляющегося каждую секунду.
  function fmtHMS(ms) {
    if (!ms || isNaN(ms) || ms < 0) return "00:00:00";
    const totalSec = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }

  // Обновляет все живые счётчики маршрутов на странице раз в секунду.
  // Узлы собираются один раз при рендере списка (refreshLiveRouteNodes), а не
  // querySelectorAll'ом по всей странице на каждый тик — на мобильном WebView
  // это заметно разгружает UI-поток.
  let liveRouteTimerNodes = [];
  function refreshLiveRouteNodes() {
    liveRouteTimerNodes = Array.from(document.querySelectorAll("[data-live-timer]"));
  }
  function tickLiveRouteTimers() {
    const now = Date.now();
    for (const el of liveRouteTimerNodes) {
      const start = parseInt(el.dataset.start, 10);
      const clock = el.querySelector("[data-live-clock]");
      if (!start || !clock) continue;
      const kind = el.dataset.liveTimer;
      if (kind === "path" || kind === "site") {
        // Обед приостанавливает учёт времени в пути: пока идёт обед счётчик
        // заморожен на моменте начала обеда, а суммарные завершённые обеды
        // (transitPaused) вычитаются из времени, чтобы после обеда счётчик
        // не «прыгал» вверх на всю длительность перерыва.
        const lunchActive = el.dataset.lunchActive === "1";
        const lunchStart = parseInt(el.dataset.lunchStart, 10);
        const paused = parseInt(el.dataset.paused || "0", 10);
        let elapsed;
        if (lunchActive && lunchStart) {
          elapsed = Math.max(0, lunchStart - start - paused);
        } else {
          elapsed = Math.max(0, now - start - paused);
        }
        clock.textContent = fmtHMS(elapsed);
      }
    }
  }

  // Единый глобальный интервал для живых счётчиков маршрутов (1 раз в сек).
  let liveRouteTicker = null;
  function startLiveRouteTicker() {
    if (liveRouteTicker) return;
    liveRouteTicker = setInterval(tickLiveRouteTimers, 1000);
  }

  // Карточка одного маршрута в «Моих маршрутах» с точками и кнопками-стадиями.
  function renderMyRouteCard(r, dayFinished) {
    const dateStr = r.date ? fmtDateReadable(r.date) : "—";
    const slot = r.routeName ? `Маршрут ${r.routeName}` : "Маршрут";
    const p = r.progress || { status: "idle" };
    const clients = r.clients || [];

    // Статусная строка маршрута.
    let statusBadge = "";
    if (p.status === "done") statusBadge = `<span class="rms-status done">Завершён</span>`;
    else if (p.status === "active") statusBadge = `<span class="rms-status active">В пути</span>`;
    else statusBadge = `<span class="rms-status idle">Ожидает</span>`;

    // Точки.
    const activeIdx = clients.findIndex((c) => c.state === "in_transit" || c.state === "on_site");
    // Группа «в связке»: точки одного адреса/бандла обрабатываются водителем
    // как одна — выделяем активной всю группу (а не только одну точку).
    const activeBundleKey = (c) => {
      if (c && c.bundleId) return "b:" + String(c.bundleId);
      const a = String(c && c.address || "").trim().toLowerCase();
      return a ? "a:" + a : "";
    };
    const activeKey = activeIdx >= 0 ? activeBundleKey(clients[activeIdx]) : null;
    const activeIsGroup = activeKey !== null;
    const stopsHtml = clients.map((c, i) => {
      const st = c.state || "pending";
      let btnHtml = "";
      let timeLine = "";
      let doneMark = "";

      if (st === "delivered" || st === "postponed") {
        const postponed = st === "postponed";
        doneMark = postponed
          ? `<span class="rms-stop-done postponed" title="Перенос">»</span>`
          : `<span class="rms-stop-done" title="Точка пройдена">✓</span>`;
        // Время в пути без обеденных пауз (transitPaused): обед между точками
        // не считается в пути.
        const transit = (c.transitEnd && c.transitStart)
          ? (c.transitEnd - c.transitStart - (Number.isFinite(c.transitPaused) ? c.transitPaused : 0))
          : null;
        const site = (c.siteEnd && c.siteStart) ? (c.siteEnd - c.siteStart) : null;
        timeLine = (postponed && c.postponeReason)
          ? `<div class="rms-stop-postpone-reason">Перенос: ${escapeHtml(c.postponeReason)}</div>`
          : "";
        timeLine += `<div class="rms-stop-times">
          <span>Путь: ${fmtDuration(transit)}</span>
          <span>На точке: ${fmtDuration(site)}</span>
        </div>`;
      } else if (st === "on_site") {
        // ---- Блок выгрузки мест (появляется, когда водитель «на точке»).
        // Счётчик «выгружено / всего» считает сервер из этикеток клиента.
        const unTotal = Number(c.unloadTotal) || 0;
        const unDone = Number(c.unloadDone) || 0;
        const unReady = c.unloadReady === true;       // все места выгружены (или их нет)
        const unFinished = c.unloadFinished === true; // водитель нажал «Завершить выгрузку»
        // Разрешает ли админ завершить выгрузку при неполном сканировании.
        const allowIncomplete = !!state.params.allowFinishUnloadIncomplete;
        // Заблокировать «Завершить выгрузку», если остались невыгруженные места
        // и админ не включил режим «завершать при неполном скане».
        const canFinish = unReady || allowIncomplete;
        const finishDisabled = unFinished || !canFinish;
        const finishHint = unFinished
          ? "Выгрузка мест отмечена как завершённая"
          : (!canFinish && unTotal > 0 ? `Осталось отсканировать мест: ${unTotal - unDone}` : "");
        let unloadCountHtml = "";
        if (unTotal > 0) {
          const cls = unReady ? " ok" : "";
          unloadCountHtml = `<span class="rms-unload-count${cls}">Выгружено ${unDone} из ${unTotal}${unReady ? " ✓" : ""}</span>`;
        }
        let unloadBlock = `<div class="rms-unload">
          ${unloadCountHtml}
          <div class="rms-stop-actions">
            <button type="button" class="rms-stop-btn primary" data-route-action="scan_unload" data-route-id="${escapeHtml(r.id)}" data-client-idx="${i}">Сканировать выгрузку</button>
            <button type="button" class="rms-stop-btn ghost" data-route-action="finish_unload" data-route-id="${escapeHtml(r.id)}" ${finishDisabled ? "disabled" : ""} title="${escapeHtml(finishHint)}">${unFinished ? "Выгрузка завершена" : "Завершить выгрузку"}</button>
          </div>
        </div>`;
        btnHtml = `${unloadBlock}
          <div class="rms-stop-actions">
            <button type="button" class="rms-stop-btn primary" data-route-action="deliver" data-route-id="${escapeHtml(r.id)}">Завершить сдачу</button>
            <button type="button" class="rms-stop-btn ghost" data-route-action="postpone" data-route-id="${escapeHtml(r.id)}">Перенос</button>
          </div>`;
        // Живой счётчик времени на точке: идёт от siteStart до нажатия
        // «Завершить сдачу».
        timeLine = `<div class="rms-stop-times is-live" data-live-timer="site" data-start="${c.siteStart || ""}" data-paused="0" data-lunch-active="${p.lunchActive ? "1" : ""}" data-lunch-start="${p.lunchStart || ""}">
          <span class="rms-live-label">На точке</span>
          <span class="rms-live-clock" data-live-clock="site">00:00:00</span>
        </div>`;
      } else if (st === "in_transit") {
        // Пока водитель на обеде, «Прибыл на адрес» недоступна — сначала нужно
        // вернуться с обеда. Кнопку не показываем, чтобы переход точки не попал
        // в учёт во время обеда.
        if (p.lunchActive === true) {
          btnHtml = `<span class="rms-lunch-note">На обеде — сначала вернитесь с обеда</span>`;
        } else {
          btnHtml = `<button type="button" class="rms-stop-btn primary" data-route-action="arrive" data-route-id="${escapeHtml(r.id)}">Прибыл на адрес</button>`;
        }
        // Живой счётчик времени в пути: идёт от transitStart до нажатия
        // «Прибыл на адрес».
        timeLine = `<div class="rms-stop-times is-live" data-live-timer="path" data-start="${c.transitStart || ""}" data-paused="${c.transitPaused || 0}" data-lunch-active="${p.lunchActive ? "1" : ""}" data-lunch-start="${p.lunchStart || ""}">
          <span class="rms-live-label">В пути</span>
          <span class="rms-live-clock" data-live-clock="path">00:00:00</span>
        </div>`;
      }

      // Выделяем активную (текущую) точку.
      const isActive = (st === "in_transit" || st === "on_site") &&
        (activeIsGroup ? activeBundleKey(c) === activeKey : i === activeIdx);
      const activeCls = isActive ? " is-active" : "";
      // Пометка связки: точка входит в группу клиентов одного адреса. Число
      // участников считаем по тому же адресу/бандлу, что и на сервере.
      const bKey = activeBundleKey(c);
      const bCount = bKey ? clients.filter((x) => activeBundleKey(x) === bKey).length : 1;
      const bundleBadge = (bCount > 1 && bKey) ? `<span class="rms-bundle-badge">связка · ${bCount} клиента</span>` : "";

      return `
        <div class="rms-stop${activeCls}">
          <div class="rms-stop-top">
            <span class="rms-stop-idx">${i + 1}</span>
            <span class="rms-stop-name">${escapeHtml(c.client)}
              ${doneMark}
              ${st === "in_transit" ? '<span class="rms-stop-tag">едем</span>' : ""}
              ${st === "on_site" ? '<span class="rms-stop-tag">на месте</span>' : ""}
              ${st === "postponed" ? '<span class="rms-stop-tag postponed">перенос</span>' : ""}
            </span>
          </div>
          ${c.address ? `<div class="rms-stop-addr">${escapeHtml(c.address)}</div>` : ""}
          ${bundleBadge}
          ${timeLine}
          ${btnHtml}
        </div>
      `;
    }).join("");

    // Кнопка запуска маршрута.
    let startBtn = "";
    if (p.status === "idle") {
      // Маршрут нельзя начать, пока склад не завершил отгрузку — если админ
      // не включил режим «начинать маршрут без отгрузки».
      const allowIgnoreShipment = !!state.params.allowDriverStartWithoutShipment;
      const notShipped = !p.shippedAt;
      const blockedShip = !allowIgnoreShipment && notShipped;
      const blocked = dayFinished || blockedShip;
      const blockReason = dayFinished
        ? "Рабочий день завершён — сегодня новый маршрут взять нельзя"
        : (blockedShip ? "Маршрут ещё не отгружен складом — запуск недоступен" : "");
      startBtn = `
        <button type="button" class="rms-start-btn" data-route-action="start" data-route-id="${escapeHtml(r.id)}"
          ${blocked ? "disabled" : ""}
          title="${blockReason}">
          Начать маршрут
        </button>
      `;
      if (blocked) {
        startBtn += `<div class="rms-day-finished">${
          dayFinished
            ? "Рабочий день завершён — новый маршрут сегодня недоступен"
            : "Маршрут ещё не отгружен складом — запуск станет доступен после завершения отгрузки."
        }</div>`;
      }
    }

    // Кнопка «Прибыл на базу» — когда все точки доставлены, а маршрут ещё активен.
    let baseBtn = "";
    if (p.status === "active" && clients.length > 0 &&
        clients.every((c) => (c.state || "pending") === "delivered")) {
      baseBtn = `
        <button type="button" class="rms-start-btn" data-route-action="arrive_base" data-route-id="${escapeHtml(r.id)}">
          Прибыл на базу
        </button>
      `;
    }

    // Кнопка «Обед» внутри маршрута. Появляется только на АКТИВНОМ маршруте
    // после закрытия хотя бы одной точки (сданной ИЛИ перенесённой), то есть
    // когда водитель уже начал объезд и движется к следующей. На закрытом
    // (завершённом) маршруте кнопки нет. При нажатии «Обед» время в пути
    // приостанавливается, пишется время обеда, после — вновь продолжается.
    const lunchOn = p.lunchActive === true;
    const lunchAllowed = (p.status === "active" && clients.some((c) => c.state === "delivered" || c.state === "postponed"))
      && p.lunchActive !== true;
    let lunchBtn = "";
    if (lunchAllowed || lunchOn) {
      lunchBtn = `
        <button type="button" class="rms-start-btn rms-lunch-btn${lunchOn ? " on" : ""}"
          data-route-action="lunch" data-route-id="${escapeHtml(r.id)}">
          ${lunchOn ? "Вернуться с обеда" : "Обед"}
        </button>
      `;
    }

    return `
      <div class="admin-row driver-route-card ${p.status === "done" ? " is-done" : ""}">
        <div class="admin-row-main">
          <div class="driver-route-head">
            <span class="driver-route-date">${escapeHtml(dateStr)}</span>
            <span class="driver-route-driver">${escapeHtml(slot)}</span>
            ${statusBadge}
          </div>
          ${startBtn}
          <div class="rms-stops">${stopsHtml}</div>
          ${baseBtn}
          ${lunchBtn}
        </div>
      </div>
    `;
  }

  // Выполняет действие водителя по маршруту и перерисовывает список.
  async function routeAction(action, routeId) {
    try {
      const r = await api("/api/drivers/routes/action", {
        method: "POST",
        body: JSON.stringify({ routeId, action }),
      });
      // Сервер вернул ок — обновляем локальный кэш и перерисовываем.
      if (r && r.ok && r.route) {
        const idx = myRoutesCache.findIndex((x) => String(x.id) === String(r.route.id));
        if (idx >= 0) myRoutesCache[idx] = r.route;
        else myRoutesCache.unshift(r.route);
        renderMyRoutesList(myRoutesCache);
      }
    } catch (e) {
      // api() кладёт серверную причину в err.message (свойства error у него нет),
      // поэтому здесь читаем именно message, иначе реальная ошибка маскируется
      // общей фразой «Не удалось выполнить действие».
      const msg = (e && (e.error || e.message)) || "Не удалось выполнить действие";
      toast(msg);
    }
  }

  // Выполняет перенос точки с причиной: закрывает точку как «перенесена» и
  // пишет причину в отчёт (то же, что «Завершить сдачу», плюс причина переноса).
  async function postponeAction(routeId, reason) {
    try {
      const r = await api("/api/drivers/routes/action", {
        method: "POST",
        body: JSON.stringify({ routeId, action: "postpone", postponeReason: reason }),
      });
      if (r && r.ok && r.route) {
        const idx = myRoutesCache.findIndex((x) => String(x.id) === String(r.route.id));
        if (idx >= 0) myRoutesCache[idx] = r.route;
        else myRoutesCache.unshift(r.route);
        renderMyRoutesList(myRoutesCache);
      }
    } catch (e) {
      const msg = (e && (e.error || e.message)) || "Не удалось выполнить перенос";
      toast(msg);
    }
  }

  // Всплывающее окно выбора причины переноса. Показывается водителю, когда он
  // нажал «Перенос» на точке, куда уже прибыл (стадия on_site). Причина выбирается
  // быстрыми плитками, после чего точка закрывается и причина попадает в отчёт.
  let postponeCtx = null; // id маршрута, для которого выбираем причину переноса
  function openPostponeModal(routeId) {
    postponeCtx = routeId;
    el.postponeModal.showModal();
  }
  const selectedRouteClientIds = new Set();
  // id маршрута, который сейчас редактируется в форме «Маршрут на день»
  // (null — создание нового маршрута).
  let editingRouteId = null;
  // Кэш всех маршрутов (админ) для кнопки «Редактировать точки».
  let driverRoutesCache = [];
  // Порядок выбранных доставок: массив id в той очередности, в которой их
  // нужно объезжать. Set выше отвечает только за "выбран/не выбран", а этот
  // массив — за порядок (пользователь может менять его ▲/▼).
  let routeOrderIds = [];
  function syncOrderFromSet() {
    routeOrderIds = routeOrderIds.filter((id) => selectedRouteClientIds.has(String(id)));
    selectedRouteClientIds.forEach((id) => {
      if (!routeOrderIds.some((x) => String(x) === String(id))) routeOrderIds.push(id);
    });
  }
  function addToRouteOrder(id) {
    if (!routeOrderIds.some((x) => String(x) === String(id))) routeOrderIds.push(id);
  }
  function removeFromRouteOrder(id) {
    routeOrderIds = routeOrderIds.filter((x) => String(x) !== String(id));
  }

  function fillDriverRouteClientChecks() {
    renderRouteClientOptions();
    renderRouteClientSelected();
  }

  function filteredRouteClients() {
    const q = (routeClientSearchValue || "").trim().toLowerCase();
    const list = driverClientsCache.filter((c) =>
      !q
      ||
      String(c.client || "").toLowerCase().includes(q)
      || String(c.address || "").toLowerCase().includes(q)
    );
    // Клиенты в выборе маршрута — по алфавиту (А–Я).
    return [...list].sort((a, b) => String(a.client || "").localeCompare(String(b.client || ""), "ru"));
  }

  function renderRouteClientOptions() {
    if (!el.routeClientOptions) return;
    if (driverClientsCache.length === 0) {
      el.routeClientOptions.innerHTML = `<div class="empty-hint">Сначала добавьте клиентов в блок выше.</div>`;
      return;
    }
    const list = filteredRouteClients();
    if (list.length === 0) {
      el.routeClientOptions.innerHTML = `<div class="rms-empty">Ничего не найдено</div>`;
      return;
    }
    el.routeClientOptions.innerHTML = list.map((c) => {
      const on = selectedRouteClientIds.has(c.id);
      return `
        <button type="button" class="rms-opt-tile${on ? " selected" : ""}" data-id="${escapeHtml(c.id)}">
          <span class="rms-opt-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
          </span>
          <span class="rms-opt-avatar">${escapeHtml(String(c.client).trim().charAt(0).toUpperCase())}</span>
          <span class="rms-opt-body">
            <span class="rms-opt-name">${escapeHtml(c.client)}</span>
            <span class="rms-opt-addr">${escapeHtml(c.bundleAddress || c.address || "")}</span>
          </span>
          ${c.bundleId ? `<span class="rms-opt-bundle" title="Клиент входит в связку — при выборе выделяется вся связка">связка</span>` : ""}
        </button>
      `;
    }).join("");
    el.routeClientOptions.querySelectorAll(".rms-opt-tile").forEach((b) => {
      b.addEventListener("click", () => toggleRouteClient(b.dataset.id));
    });
  }

  function renderRouteClientSelected() {
    if (!el.routeClientSelected) return;
    if (selectedRouteClientIds.size === 0) {
      el.routeClientSelected.innerHTML = `<div class="rms-selected-empty">Клиенты не выбраны</div>`;
      updateRouteStepCount();
      return;
    }
    syncOrderFromSet();
    const byId = new Map(driverClientsCache.map((c) => [String(c.id), c]));
    const order = routeOrderIds.map((id) => byId.get(String(id))).filter(Boolean);
    el.routeClientSelected.innerHTML = order.map((c, i) => `
      <div class="rms-tile" data-id="${escapeHtml(c.id)}" draggable="true">
        <div class="rms-tile-top">
          <span class="rms-tile-drag" title="Перетащить" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
          </span>
          <span class="rms-tile-idx">${i + 1}</span>
          <div class="rms-tile-order">
            <button type="button" class="rms-move-btn" data-action="up" data-id="${escapeHtml(c.id)}" title="Вперёд (раньше)" aria-label="Переместить раньше" ${i === 0 ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 15l-6-6-6 6"/></svg>
            </button>
            <button type="button" class="rms-move-btn" data-action="down" data-id="${escapeHtml(c.id)}" title="Назад (позже)" aria-label="Переместить позже" ${i === order.length - 1 ? "disabled" : ""}>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
            </button>
          </div>
          <button type="button" class="rms-tile-del" data-id="${escapeHtml(c.id)}" aria-label="Убрать" title="Убрать из маршрута">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg>
          </button>
        </div>
        <div class="rms-tile-name">${escapeHtml(c.client)}</div>
        ${(c.bundleAddress || c.address) ? `<div class="rms-tile-addr">${escapeHtml(c.bundleAddress || c.address)}</div>` : ""}
      </div>
    `).join("");
    el.routeClientSelected.querySelectorAll(".rms-tile-del").forEach((b) => {
      b.addEventListener("click", () => toggleRouteClient(b.dataset.id));
    });
    el.routeClientSelected.querySelectorAll(".rms-move-btn").forEach((b) => {
      b.addEventListener("click", () => moveRouteOrder(b.dataset.id, b.dataset.action));
    });
    bindRouteDragDrop();
    updateRouteStepCount();
  }

  // --- Drag & drop: перетаскивание клиентов для изменения порядка в маршруте.
  // Стрелки ▲/▼ остаются, но теперь порядок можно менять и перетаскиванием.
  // Мышь/трекпад — нативный HTML5 drag & drop; сенсорные экраны (телефон/планшет,
  // где HTML5 DnD не работает) — собственное перетаскивание через Pointer Events.
  let routeDragId = null;

  // Состояние сенсорного перетаскивания (drag на телефоне).
  const touchDrag = {
    active: false,     // выполняется ли сейчас перетаскивание
    started: false,    // преодолели порог и реально тащим (не скроллим)
    tile: null,        // перетаскиваемая плитка
    dragId: null,      // id клиента
    startX: 0, startY: 0,
    lastOver: null,    // последняя подсвеченная целевая плитка
    ghost: null        // призрачная копия, следующая за пальцем
  };

  // Точка под пальцем -> плитка .rms-tile (не сама перетаскиваемая).
  function tileFromPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest(".rms-tile") : null;
  }

  function clearTouchDragOver() {
    touchDrag.tile && touchDrag.tile.classList.remove("drag-over");
    if (touchDrag.lastOver && touchDrag.lastOver !== touchDrag.tile) {
      touchDrag.lastOver.classList.remove("drag-over");
    }
    touchDrag.lastOver = null;
  }

  function removeTouchGhost() {
    if (touchDrag.ghost && touchDrag.ghost.parentNode) {
      touchDrag.ghost.parentNode.removeChild(touchDrag.ghost);
    }
    touchDrag.ghost = null;
  }

  function finishTouchDrag(apply) {
    if (!touchDrag.active) return;
    // Целевая плитка, на которую указывал палец в момент отпускания.
    const target = touchDrag.lastOver;
    clearTouchDragOver();
    if (touchDrag.started && apply && touchDrag.dragId && target) {
      const targetId = String(target.dataset.id);
      if (targetId && targetId !== touchDrag.dragId) {
        moveRouteTile(touchDrag.dragId, targetId);
      }
    }
    if (touchDrag.tile) {
      touchDrag.tile.classList.remove("dragging");
      touchDrag.tile.classList.remove("rms-touch-dragging");
      // Вернуть плитку на место; рендер ниже всё равно перестроит список,
      // но transition выглядит плавнее.
      touchDrag.tile.style.transform = "";
      touchDrag.tile.style.opacity = "";
    }
    removeTouchGhost();
    touchDrag.active = false;
    touchDrag.started = false;
    touchDrag.tile = null;
    touchDrag.dragId = null;
    touchDrag.lastOver = null;
  }

  // --- Сенсорное перетаскивание. Начинаем с малого порога, чтобы вертикальный
  // скролл списка продолжал работать, а перетаскивание включалось только когда
  // палец действительно «тащит» плитку.
  function bindTileTouch(tile) {
    // inputType ещё не известен до pointerdown — определяем внутри обработчика.
    tile.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return; // мышь — нативный DnD
      if (touchDrag.active) return;
      if (e.target.closest("button")) return; // кнопки внутри плитки работают сами

      touchDrag.active = true;
      touchDrag.started = false;
      touchDrag.tile = tile;
      touchDrag.dragId = String(tile.dataset.id);
      touchDrag.startX = e.clientX;
      touchDrag.startY = e.clientY;
      touchDrag.lastOver = null;

      // Захватываем указатель, чтобы двигать/отпускать вне плитки.
      try { tile.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }

      const move = (ev) => {
        if (!touchDrag.active) return;
        const dx = ev.clientX - touchDrag.startX;
        const dy = ev.clientY - touchDrag.startY;

        // До преодоления порога даём скроллу «съесть» жест.
        if (!touchDrag.started) {
          if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
          touchDrag.started = true;
          tile.classList.add("dragging", "rms-touch-dragging");
        }

        ev.preventDefault();

        // Призрак — единственная визуальная копия, следующая за пальцем.
        if (!touchDrag.ghost) {
          const rect = tile.getBoundingClientRect();
          const clone = tile.cloneNode(true);
          clone.classList.add("rms-tile-ghost");
          clone.style.width = rect.width + "px";
          clone.style.transform = "translate(" + (ev.clientX - rect.width / 2) + "px," + (ev.clientY - 12) + "px)";
          document.body.appendChild(clone);
          touchDrag.ghost = clone;
          tile.style.transform = "scale(0.96)";
          tile.style.opacity = "0.3";
        } else {
          const rect = tile.getBoundingClientRect();
          touchDrag.ghost.style.transform =
            "translate(" + (ev.clientX - rect.width / 2) + "px," + (ev.clientY - 12) + "px)";
        }

        // Подсветка целевой плитки.
        const over = tileFromPoint(ev.clientX, ev.clientY);
        clearTouchDragOver();
        if (over && over !== tile) {
          over.classList.add("drag-over");
          touchDrag.lastOver = over;
        }
      };

      const up = (ev) => {
        if (ev.pointerType !== "touch" && ev.pointerType !== "pen") return;
        finishTouchDrag(true);
        tile.removeEventListener("pointermove", move);
        tile.removeEventListener("pointerup", up);
        tile.removeEventListener("pointercancel", cancel);
      };

      const cancel = () => {
        finishTouchDrag(false);
        tile.removeEventListener("pointermove", move);
        tile.removeEventListener("pointerup", up);
        tile.removeEventListener("pointercancel", cancel);
      };

      tile.addEventListener("pointermove", move);
      tile.addEventListener("pointerup", up);
      tile.addEventListener("pointercancel", cancel);
    });
  }

  function bindRouteDragDrop() {
    const container = el.routeClientSelected;
    if (!container) return;

    container.querySelectorAll(".rms-tile").forEach((tile) => {
      // Сенсор: собственное перетаскивание (HTML5 DnD на тач не работает).
      bindTileTouch(tile);

      // Не начинать перетаскивание при клике по кнопкам внутри плитки.
      tile.addEventListener("dragstart", (e) => {
        if (e.target.closest("button")) { e.preventDefault(); return; }
        routeDragId = String(tile.dataset.id);
        tile.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", String(tile.dataset.id));
        }
      });

      tile.addEventListener("dragover", (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (String(tile.dataset.id) !== routeDragId) tile.classList.add("drag-over");
      });

      tile.addEventListener("dragleave", () => {
        tile.classList.remove("drag-over");
      });

      tile.addEventListener("drop", (e) => {
        e.preventDefault();
        tile.classList.remove("drag-over");
        const targetId = String(tile.dataset.id);
        if (!routeDragId || routeDragId === targetId) return;
        moveRouteTile(routeDragId, targetId);
      });

      tile.addEventListener("dragend", () => {
        tile.classList.remove("dragging");
        container.querySelectorAll(".rms-tile.drag-over").forEach((t) => t.classList.remove("drag-over"));
        routeDragId = null;
      });
    });
  }

  // Перемещает перетаскиваемую плитку на место целевой в routeOrderIds.
  function moveRouteTile(dragId, targetId) {
    syncOrderFromSet();
    const dragIdx = routeOrderIds.findIndex((x) => String(x) === String(dragId));
    const targetIdx = routeOrderIds.findIndex((x) => String(x) === String(targetId));
    if (dragIdx < 0 || targetIdx < 0) return;
    const [moved] = routeOrderIds.splice(dragIdx, 1);
    // После удаления индекс целевой позиции мог сдвинуться.
    const insertAt = routeOrderIds.findIndex((x) => String(x) === String(targetId));
    if (insertAt < 0) { routeOrderIds.push(moved); }
    else routeOrderIds.splice(insertAt, 0, moved);
    renderRouteClientSelected();
  }

  function moveRouteOrder(id, action) {
    syncOrderFromSet();
    const idx = routeOrderIds.findIndex((x) => String(x) === String(id));
    if (idx < 0) return;
    const swapWith = action === "up" ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= routeOrderIds.length) return;
    [routeOrderIds[idx], routeOrderIds[swapWith]] = [routeOrderIds[swapWith], routeOrderIds[idx]];
    renderRouteClientSelected();
  }

  function toggleRouteClient(id) {
    const chosen = driverClientsCache.filter((c) => selectedRouteClientIds.has(c.id));
    const wasSelected = selectedRouteClientIds.has(id);
    if (wasSelected) {
      selectedRouteClientIds.delete(id);
      removeFromRouteOrder(id);
    } else {
      // When a client from a bundle is picked, auto-select the whole bundle
      // (all clients sharing the same address/bundleId).
      const target = driverClientsCache.find((c) => String(c.id) === String(id));
      if (target && target.bundleId) {
        driverClientsCache.forEach((c) => {
          if (c.bundleId === target.bundleId) {
            selectedRouteClientIds.add(String(c.id));
            addToRouteOrder(String(c.id));
          }
        });
      } else {
        selectedRouteClientIds.add(id);
        addToRouteOrder(id);
      }
    }
    renderRouteClientOptions();
    renderRouteClientSelected();
  }

  function updateRouteStepCount() {
    const n = selectedRouteClientIds.size;
    if (el.routeStepCount) {
      el.routeStepCount.textContent = n
        ? `${n} ${plural(n, "клиент", "клиента", "клиентов")}`
        : "0 клиентов";
    }
    if (el.routeSelectedCount) {
      el.routeSelectedCount.textContent = n
        ? `${n} ${plural(n, "клиент", "клиента", "клиентов")}`
        : "0 клиентов";
    }
  }

  function fillDriverRouteDriverSelect() {
    if (!el.driverRouteDriver) return;
    // Водители = участники группы «Водители»; остальные сотрудники не выводятся.
    const driverGroup = state.groups.find((g) => /водител/i.test(String(g.name || "")));
    const ids = driverGroup && Array.isArray(driverGroup.memberIds) ? new Set(driverGroup.memberIds) : null;
    const list = ids ? state.staff.filter((s) => ids.has(s.id)) : state.staff;
    el.driverRouteDriver.innerHTML = list.map((s) =>
      `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`
    ).join("");
  }

  async function loadDriverClients() {
    try {
      const r = await api("/api/drivers/clients");
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
    } catch { /* admin-only; keep last view */ }
  }

  function renderDriverClients(clients) {
    // Сортируем контрагентов по алфавиту (локализованно) для списка и выбора.
    clients = [...clients].sort((a, b) =>
      String(a.client || "").localeCompare(String(b.client || ""), "ru", { numeric: true, sensitivity: "base" })
    );
    driverClientsCache = clients;
    fillDriverRouteClientChecks();
    if (el.driverClientsCount) {
      el.driverClientsCount.textContent = clients.length
        ? `${clients.length} ${plural(clients.length, "клиент", "клиента", "клиентов")}`
        : "0 клиентов";
    }
    if (!el.driverClientsList) return;
    if (clients.length === 0) {
      el.driverClientsList.innerHTML = `<div class="empty-hint">Клиентов пока нет. Добавьте первого клиента.</div>`;
      return;
    }
    el.driverClientsList.innerHTML = clients.map((c) => {
      const d = new Date(c.at);
      const date = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
      return `
        <div class="drv-client" data-id="${escapeHtml(c.id)}">
          ${c.logo
            ? `<div class="drv-client-avatar drv-client-avatar-img"><img src="${c.logo}" alt="лого" /></div>`
            : c.logoText
              ? `<div class="drv-client-avatar drv-client-avatar-txt">${escapeHtml(String(c.logoText).slice(0, 3))}</div>`
              : `<div class="drv-client-avatar">${escapeHtml(String(c.client).trim().charAt(0).toUpperCase())}</div>`}
          <div class="drv-client-main">
            <div class="drv-client-name">${escapeHtml(c.client)}</div>
            <div class="drv-client-address">${escapeHtml(c.address)}</div>
            ${c.bundleId ? `<div class="drv-client-bundle"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l-4 4 4 4M15 11l4 4-4 4M12 3l-2 18"/></svg>в связке · ${escapeHtml(c.bundleAddress || c.address)}</div>` : ""}
          </div>
          <div class="drv-client-side">
            <span class="drv-client-date">${date}</span>
            <div class="drv-client-actions">
              <button type="button" class="drv-ico-btn driver-client-edit" data-id="${escapeHtml(c.id)}" title="Редактировать" aria-label="Редактировать клиента">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>
              </button>
              <button type="button" class="drv-ico-btn driver-client-logotext" data-id="${escapeHtml(c.id)}" title="Буквенный логотип для этикетки (до 5 символов)" aria-label="Буквенный логотип">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h4M4 12h7M4 17h4M12 17l2.5-6 2.5 6M13 15h3"/><path d="M18 5v4M16 7h4"/></svg>
              </button>
              <button type="button" class="drv-ico-btn drv-ico-danger driver-client-del" data-id="${escapeHtml(c.id)}" title="Удалить" aria-label="Удалить клиента">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");
    el.driverClientsList.querySelectorAll(".driver-client-edit").forEach((btn) => {
      btn.addEventListener("click", () => editDriverClient(btn.dataset.id));
    });
    el.driverClientsList.querySelectorAll(".driver-client-del").forEach((btn) => {
      btn.addEventListener("click", () => deleteDriverClient(btn.dataset.id));
    });
    el.driverClientsList.querySelectorAll(".driver-client-logotext").forEach((btn) => {
      btn.addEventListener("click", () => pickClientLogoText(btn.dataset.id));
    });
    refreshBundleUi();
  }

  async function addDriverClient() {
    const client = (el.driverClientName.value || "").trim();
    const address = (el.driverClientAddress.value || "").trim();
    if (!client || !address) {
      toast("Укажите и клиента, и адрес");
      return;
    }
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ client, address }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      if (el.driverClientName) el.driverClientName.value = "";
      if (el.driverClientAddress) el.driverClientAddress.value = "";
      toast("Клиент добавлен");
    } catch (e) {
      toast(e.message);
    }
  }

  // Inline-редактирование клиента: исправить имя/адрес.
  function editDriverClient(id) {
    const c = driverClientsCache.find((x) => String(x.id) === String(id));
    if (!c) return;
    const row = el.driverClientsList.querySelector(`.drv-client [data-id="${escapeHtml(id)}"]`);
    const main = row ? row.closest(".drv-client") : null;
    if (!main) return;
    main.innerHTML = `
      <div class="drv-client-main drv-client-edit-form">
        <input class="text-input" id="editClientName-${escapeHtml(id)}" value="${escapeHtml(c.client)}" />
        <input class="text-input" id="editClientAddr-${escapeHtml(id)}" value="${escapeHtml(c.address)}" />
        <div class="driver-edit-actions">
          <button type="button" class="drv-mini-btn drv-mini-primary" id="saveEdit-${escapeHtml(id)}">Сохранить</button>
          <button type="button" class="drv-mini-btn" id="cancelEdit-${escapeHtml(id)}">Отмена</button>
        </div>
      </div>
    `;
    document.getElementById(`saveEdit-${id}`).addEventListener("click", async () => {
      const client = document.getElementById(`editClientName-${id}`).value.trim();
      const address = document.getElementById(`editClientAddr-${id}`).value.trim();
      if (!client || !address) { toast("Укажите имя и адрес"); return; }
      try {
        const r = await api("/api/drivers/clients", {
          method: "POST",
          body: JSON.stringify({ action: "update", id, client, address }),
        });
        if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
        toast("Клиент обновлён");
      } catch (e) { toast(e.message); }
    });
    document.getElementById(`cancelEdit-${id}`).addEventListener("click", () => {
      renderDriverClients(driverClientsCache);
    });
  }

  // Удаление клиента.
  async function deleteDriverClient(id) {
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ action: "delete", id }),
      });
      if (r && Array.isArray(r.clients)) {
        renderDriverClients(r.clients);
        // Убрать удалённого из выбранных в маршруте, если был выбран.
        selectedRouteClientIds.delete(id);
        removeFromRouteOrder(id);
        renderRouteClientOptions();
        renderRouteClientSelected();
      }
      toast("Клиент удалён");
    } catch (e) {
      toast(e.message);
    }
  }

  // Задание текстовой аббревиатуры логотипа (например «AVI»): выводится на этикетке
  // крупным лого-блоком, когда у клиента нет картинки-лого.
  function pickClientLogoText(id) {
    const c = driverClientsCache.find((x) => String(x.id) === String(id));
    const current = (c && c.logoText) || "";
    const val = prompt("Аббревиатура/текст логотипа для этикетки (например AVI):", current);
    if (val == null) return; // отмена
    uploadClientLogoText(id, String(val).trim().toUpperCase().slice(0, 5));
  }

  // Сохраняет аббревиатуру на сервер и обновляет справочник + точки маршрутов.
  async function uploadClientLogoText(id, logoText) {
    try {
      const r = await api("/api/clients/" + encodeURIComponent(id) + "/logo-text", {
        method: "POST",
        body: JSON.stringify({ logoText }),
      });
      if (r && Array.isArray(r.clients)) {
        renderDriverClients(r.clients);
        loadDriverRoutes();
        toast("Аббревиатура логотипа сохранена");
      }
    } catch (e) {
      toast(e.message || "Ошибка сохранения аббревиатуры");
    }
  }

  // ------------- Маршруты на день -------------
  async function loadDriverRoutes() {
    try {
      const r = await api("/api/drivers/routes");
      if (r && Array.isArray(r.routes)) renderDriverRoutes(r.routes);
    } catch { /* admin-only */ }
  }

  function renderDriverRoutes(routes) {
    if (el.driverRoutesCount) {
      el.driverRoutesCount.textContent = routes.length
        ? `${routes.length} ${plural(routes.length, "маршрут", "маршрута", "маршрутов")}`
        : "0 маршрутов";
    }
    if (!el.driverRoutesList) return;
    if (routes.length === 0) {
      el.driverRoutesList.innerHTML = `<div class="empty-hint">Маршрутов пока нет.</div>`;
      return;
    }
    driverRoutesCache = routes;
    const sorted = [...routes].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    el.driverRoutesList.innerHTML = sorted.map((r) => {
      const dateStr = r.date ? fmtDateReadable(r.date) : "—";
      const stops = (r.clients || []).length;
      const n = `${stops} ${plural(stops, "остановка", "остановки", "остановок")}`;
      const clientsHtml = (r.clients || []).map((c, i) => `
        <li class="drv-stop">
          <span class="drv-stop-idx">${i + 1}</span>
          <span class="drv-stop-body">
            <span class="drv-stop-name">${escapeHtml(c.client)}</span>
            ${c.address ? `<span class="drv-stop-addr">${escapeHtml(c.address)}</span>` : ""}
          </span>
        </li>
      `).join("");
      return `
        <div class="drv-route-card">
          <div class="drv-route-card-head">
            <div class="drv-route-card-meta">
              <span class="drv-route-date">${escapeHtml(dateStr)}</span>
              <span class="drv-route-driver">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.4 3.3-5.5 7-5.5s6.4 2.1 7 5.5"/></svg>
                ${escapeHtml(r.driverName || "—")}
              </span>
              <span class="drv-stop-count">${n}</span>
            </div>
            <button type="button" class="drv-ico-btn driver-route-edit" data-id="${escapeHtml(r.id)}" title="Редактировать точки" aria-label="Редактировать точки маршрута">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>
            </button>
            <button type="button" class="drv-ico-btn drv-ico-danger driver-route-del" data-id="${escapeHtml(r.id)}" title="Удалить маршрут" aria-label="Удалить маршрут">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
            </button>
          </div>
          <ol class="drv-stops">${clientsHtml}</ol>
        </div>
      `;
    }).join("");
    el.driverRoutesList.querySelectorAll(".driver-route-edit").forEach((btn) => {
      btn.addEventListener("click", () => editDriverRoute(btn.dataset.id));
    });
    el.driverRoutesList.querySelectorAll(".driver-route-del").forEach((btn) => {
      btn.addEventListener("click", () => deleteDriverRoute(btn.dataset.id));
    });
  }

  async function saveDriverRoute() {
    const date = (el.driverRouteDate.value || "").trim();
    const driverId = el.driverRouteDriver ? el.driverRouteDriver.value : "";
    const driverName = driverId ? (staffById(driverId) ? staffById(driverId).name : driverId) : "";
    const chosen = [];
    syncOrderFromSet();
    for (const id of routeOrderIds) {
      const c = driverClientsCache.find((x) => String(x.id) === String(id));
      if (c) chosen.push({
        client: c.client,
        address: c.bundleAddress || c.address || "",
        bundleId: c.bundleId || null,
        logo: c.logo || "",
        logoText: c.logoText || "",
      });
    }
    if (!date || !driverId || chosen.length === 0) {
      toast("Укажите дату, водителя и выберите хотя бы одного клиента");
      return;
    }
    try {
      // Предупреждение о пересечении: клиент уже в другом маршруте этого же
      // водителя на ту же дату. Разрешаем сохранить, но предупреждаем.
      const check = await api("/api/drivers/routes/check", {
        method: "POST",
        body: JSON.stringify({
          date,
          driverId,
          clientNames: chosen.map((c) => c.client),
          excludeRouteId: editingRouteId || "",
        }),
      });
      const inter = (check && Array.isArray(check.intersections)) ? check.intersections : [];
      if (inter.length > 0) {
        const list = [...new Set(inter.map((i) => `Клиент «${i.clientName}» уже в маршруте «${i.routeName}»`))];
        const ok = await confirmRouteIntersection(list);
        if (!ok) return;
      }
      const r = await api("/api/drivers/routes", {
        method: "POST",
        body: JSON.stringify(
          editingRouteId
            ? { action: "update", id: editingRouteId, date, driverId, driverName, clients: chosen }
            : { date, driverId, driverName, clients: chosen }
        ),
      });
      if (r && Array.isArray(r.routes)) renderDriverRoutes(r.routes);
      editingRouteId = null;
      selectedRouteClientIds.clear();
      routeOrderIds = [];
      routeClientSearchValue = "";
      if (el.routeClientSearch) el.routeClientSearch.value = "";
      renderRouteClientOptions();
      renderRouteClientSelected();
      toast("Маршрут сохранён");
    } catch (e) {
      toast(e.message);
    }
  }

  // Статусная строка блока автопостроения маршрута (общая для busy/ошибки).
  function setAutoRouteStatus(text) {
    if (!el.autoRouteStatus) return;
    el.autoRouteStatus.hidden = !text;
    el.autoRouteStatus.textContent = text || "";
  }

  // Автопостроение маршрута по адресам выбранных клиентов: сервер геокодирует
  // адреса (Яндекс.Карты), учитывает базу и возвращает оптимальный порядок.
  async function autoBuildRoute() {
    if (selectedRouteClientIds.size < 2) {
      toast("Выберите хотя бы двух клиентов для построения маршрута");
      return;
    }
    syncOrderFromSet();
    const clientIds = routeOrderIds.slice();
    const baseAddress = el.routeBaseAddress ? el.routeBaseAddress.value.trim() : "";
    if (el.autoRouteBtn) el.autoRouteBtn.disabled = true;
    setAutoRouteStatus("Геокодируем адреса и считаем оптимальный порядок…");
    try {
      const r = await api("/api/drivers/routes/optimize", {
        method: "POST",
        body: JSON.stringify({ clientIds, baseAddress: baseAddress || undefined }),
      });
      if (r && Array.isArray(r.order) && r.order.length > 0) {
        // Обновить координаты в кеше клиентов (сервер их догeокодировал).
        (r.clients || []).forEach((cc) => {
          const c = driverClientsCache.find((x) => String(x.id) === String(cc.id));
          if (c) { c.lat = cc.lat; c.lon = cc.lon; }
        });
        // Пересобрать порядок маршрута в оптимизированной последовательности.
        const ordered = r.order.map(String);
        routeOrderIds = ordered.filter((id) => selectedRouteClientIds.has(String(id)));
        syncOrderFromSet();
        renderRouteClientOptions();
        renderRouteClientSelected();
        // Собираем честные предупреждения о качестве построения:
        // 1) какие-то адреса не распознались (стоят в конце, не оптимизированы);
        // 2) маршрут построен «по прямой» (сервисы дорог не сработали — порядок
        //    может не совпадать с реальным удобством проезда);
        // 3) адрес базы не распознан (маршрут построен от первого адреса).
        const warns = [];
        const unresolved = Array.isArray(r.unresolved) ? r.unresolved : [];
        if (unresolved.length > 0) {
          const names = unresolved
            .map((id) => {
              const c = driverClientsCache.find((x) => String(x.id) === String(id));
              return c ? c.client : id;
            })
            .filter(Boolean)
            .join(", ");
          warns.push(`Не распознан адрес у: ${names}. Проверьте, что указан полный адрес (улица, дом, город).`);
        }
        if (r.method === "straight") {
          warns.push("Маршрут построен по прямой: сервисы учёта реальных дорог сейчас недоступны, порядок может отличаться от реального удобства проезда.");
        }
        if (r.baseUnresolved) {
          warns.push("Адрес базы не распознан — маршрут построен от первого адреса, а не от базы. Проверьте адрес отправления.");
        }
        if (warns.length > 0) {
          setAutoRouteStatus(warns.join(" "));
          toast("Маршрут построен с предупреждениями");
        } else {
          setAutoRouteStatus(null);
          toast("Маршрут построен: порядок точек оптимизирован");
        }
      } else {
        setAutoRouteStatus("Не удалось построить маршрут: не найдены координаты адресов");
      }
    } catch (e) {
      const msg = (e && e.message) || "Ошибка построения маршрута";
      setAutoRouteStatus(msg);
      toast(msg);
    } finally {
      if (el.autoRouteBtn) el.autoRouteBtn.disabled = false;
    }
  }

  async function deleteDriverRoute(id) {
    try {
      const r = await api("/api/drivers/routes", {
        method: "POST",
        body: JSON.stringify({ action: "delete", id }),
      });
      if (r && Array.isArray(r.routes)) renderDriverRoutes(r.routes);
      toast("Маршрут удалён");
    } catch (e) {
      toast(e.message);
    }
  }

  // Открыть маршрут в форме «Маршрут на день» для редактирования точек:
  // заполняем дату/водителя и выбранных клиентов (с порядком маршрута),
  // после чего админ может менять состав и порядок и нажать «Сохранить маршрут».
  function editDriverRoute(id) {
    const r = driverRoutesCache.find((x) => String(x.id) === String(id));
    if (!r) { toast("Маршрут не найден"); return; }
    editingRouteId = id;
    if (el.driverRouteDate) el.driverRouteDate.value = r.date || "";
    if (el.driverRouteDriver && r.driverId) el.driverRouteDriver.value = r.driverId;
    selectedRouteClientIds.clear();
    routeOrderIds = [];
    (r.clients || []).forEach((rc) => {
      // Маршрут хранит клиентов без id — сопоставляем по имени с текущими контрагентами.
      const match = driverClientsCache.find((c) => String(c.client) === String(rc.client));
      if (match) {
        selectedRouteClientIds.add(String(match.id));
        addToRouteOrder(String(match.id));
      }
    });
    renderRouteClientOptions();
    renderRouteClientSelected();
    switchRouteSubtab("route");
    toast("Редактирование маршрута: меняйте точки и нажмите «Сохранить маршрут»");
  }

  function startLivePolling() {
    if (liveTimer) return;
    liveTimer = setInterval(loadLive, 10000);
    liveTick = setInterval(() => { if (!el.pageLive.hidden) renderLive(); }, 1000);
  }
  function stopLivePolling() {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    if (liveTick) { clearInterval(liveTick); liveTick = null; }
  }

  // Периодическое обновление «Мои маршруты»: добавленные/удалённые админом
  // маршруты подхватываются автоматически, без перезагрузки страницы.
  function startMyRoutesPolling() {
    if (myRoutesTimer) return;
    myRoutesTimer = setInterval(() => {
      if (!el.pageMyRoutes.hidden) loadMyRoutes();
    }, 5000);
  }
  function stopMyRoutesPolling() {
    if (myRoutesTimer) { clearInterval(myRoutesTimer); myRoutesTimer = null; }
  }

  // ------------- Admin panel render -------------
  function switchAdminSub(name) {
    activeAdminSub = name;
    // Запоминаем активную вкладку панели администратора, чтобы после
    // перезагрузки открывать её, а не сбрасывать на самую первую.
    try { localStorage.setItem("biotime_admin_sub", name); } catch { /* ignore */ }
    el.adminTabs.querySelectorAll(".atab").forEach((t) => t.classList.toggle("active", t.dataset.sub === name));
    el.settingsModal.querySelectorAll(".asub").forEach((p) => { p.hidden = p.dataset.sub !== name; });
    renderAdminSub(name);
  }
  function renderAdminSub(name) {
    if (name === "staff") renderStaff();
    else if (name === "today") renderToday();
    else if (name === "groups") renderGroups();
    else if (name === "salaries") renderSalaries();
    else if (name === "log") renderLog();
    else if (name === "settings") renderParams();
    else if (name === "admins") renderAdmins();
  }

  function renderStaff() {
    const meName = staffById(state.me.id) ? staffById(state.me.id).name : state.me.name;
    el.staffCountNote.textContent = `${state.staff.length} ${plural(state.staff.length, "сотрудник", "сотрудника", "сотрудников")} · вы — «${escapeHtml(meName)}»`;
    el.staffList.innerHTML = "";
    state.staff.forEach((s) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      const isMe = s.id === state.me.id;
      const isAdminUser = state.admins.includes(s.id) || (s.id === state.me.id && state.isAdmin);
      const letter = (s.name || "?").trim().charAt(0).toUpperCase();
      const sub = [];
      if (isMe) sub.push('<span class="badge">вы</span>');
      if (isAdminUser) sub.push('<span class="badge">админ</span>');
      row.innerHTML = `
        <div class="avatar">${letter}</div>
        <div class="admin-row-main">
          <div class="admin-row-name">${escapeHtml(s.name)}</div>
          <div class="admin-row-sub">${sub.join(" ") || "сотрудник"}</div>
        </div>
        <div class="row-action">
          ${isMe
            ? '<span class="disabled-note">это вы</span>'
            : `<button class="mini-btn on" data-id="${s.id}">Удалить</button>`}
        </div>
      `;
      el.staffList.appendChild(row);
    });
    el.staffList.querySelectorAll(".mini-btn[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => removeStaff(btn.dataset.id));
    });

    // Blocked employees (access closed). Admin can restore access.
    if (state.blocked.length > 0) {
      const blockTitle = document.createElement("div");
      blockTitle.className = "block-title";
      blockTitle.textContent = "Закрыт доступ";
      el.staffList.appendChild(blockTitle);
      state.blocked.forEach((b) => {
        const row = document.createElement("div");
        row.className = "admin-row blocked-row";
        const letter = (b.name || "?").trim().charAt(0).toUpperCase();
        row.innerHTML = `
          <div class="avatar">${letter}</div>
          <div class="admin-row-main">
            <div class="admin-row-name">${escapeHtml(b.name)}</div>
            <div class="admin-row-sub">${b.at ? new Date(b.at).toLocaleString("ru-RU") : ""} · вход закрыт</div>
          </div>
          <div class="row-action">
            <button class="mini-btn" data-block="${b.id}">Восстановить доступ</button>
          </div>
        `;
        el.staffList.appendChild(row);
      });
      el.staffList.querySelectorAll("[data-block]").forEach((btn) => {
        btn.addEventListener("click", () => unblockStaff(btn.dataset.block));
      });
    }
  }

  // ------------- "Время работы": проставить рабочее время всем сотрудникам ----
  // Список всех сотрудников, у каждого — поля «начало / конец» за текущий день.
  // Админ правит всех; модератор видит только членов своих групп (state.staff уже
  // отфильтрован сервером). Сохранение идёт через PUT /api/admin/day (canManageStatus).
  function todayRows(activeId, key) {
    key = key || dayKeyOf(Date.now());
    // Одна активная строка "работа" на день (min start / max end), как в "Днях сотрудников".
    const raw = daySegments(key, activeId);
    const work = raw.filter((s) => s.kind !== "break");
    if (work.length === 0) return [];
    const hasOpen = work.some((s) => s.end == null);
    const start = Math.min(...work.map((s) => s.start));
    const ends = work.filter((s) => s.end != null).map((s) => s.end);
    const end = hasOpen ? null : (ends.length ? Math.max(...ends) : null);
    return [{ kind: "work", start, end }];
  }

  function renderToday() {
    const canEdit = state.isAdmin || state.isModerator;
    const today = dayKeyOf(Date.now());
    if (el.todayDateNote) {
      el.todayDateNote.textContent = fmtDateReadable(today);
    }
    el.todayList.innerHTML = "";
    if (state.staff.length === 0) {
      el.todayList.innerHTML = `<div class="empty-hint">Сотрудников пока нет. Добавьте их в разделе «Все сотрудники».</div>`;
      return;
    }
    // Непрерывный набор вкладок по дням: от «1 сентября» текущего года (а если
    // где-то есть данные раньше — с самого раннего дня) до сегодня включительно,
    // включая пустые дни. Каждый новый день появляется сам, как только наступает,
    // а старые вкладки остаются доступными для правки.
    const todayKey = today;
    const year = todayKey.slice(0, 4);
    const sepStart = `${year}-09-01`;
    const earliest = Object.keys(state.days).sort().shift();
    let startKey = sepStart < todayKey ? sepStart : todayKey;
    if (earliest && earliest < startKey) startKey = earliest;
    const dayKeys = [];
    {
      const cursor = new Date(startKey + "T00:00:00");
      const end = new Date(todayKey + "T00:00:00");
      while (cursor <= end) {
        dayKeys.push(dayKeyOf(cursor.getTime()));
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    dayKeys.reverse();

    const frag = document.createDocumentFragment();
    dayKeys.forEach((key) => {
      const isToday = key === today;
      const colKey = "day:" + key;
      const openedKey = colKey + "+"; // явно раскрытая папка (кроме «сегодня» по умолчанию)
      // Явный выбор важнее дефолта: «+» = раскрыта, «без суффикса» = свёрнута.
      let open;
      if (state.collapsed.has(openedKey)) open = true;
      else if (state.collapsed.has(colKey)) open = false;
      else open = isToday; // дефолт: сегодня раскрыта, прошлые дни свёрнуты
      const folder = document.createElement("div");
      folder.className = "day-folder" + (open ? " open" : "") + (isToday ? " is-today" : "");
      const head = document.createElement("div");
      head.className = "today-day-head";
      head.innerHTML = `
        <span class="folder-caret"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></span>
        <span class="today-day-label">${fmtDateReadable(key)}${isToday ? ` <span class="badge">сегодня</span>` : ""}</span>
      `;
      const body = document.createElement("div");
      body.className = "today-day-body";
      const list = document.createElement("div");
      list.className = "today-day-inner";
      body.appendChild(list);
      folder.appendChild(head);
      folder.appendChild(body);
      // Collapse / expand this day folder. Explicit user choice is remembered in
      // localStorage so the "today open / past collapsed" default is overridable.
      head.addEventListener("click", () => {
        state.collapsed.delete(colKey);
        state.collapsed.delete(openedKey);
        const nowOpen = !folder.classList.contains("open");
        state.collapsed.add(nowOpen ? openedKey : colKey);
        saveCollapsed(state.collapsed);
        folder.classList.toggle("open", nowOpen);
        // Ленивое построение: строки дня создаются в момент первого раскрытия,
        // а не только на этапе рендера. Так свёрнутый прошедший день открывается
        // сразу (с актуальными данными), без ручного «Обновить».
        if (nowOpen && list.childElementCount === 0) {
          buildTodayRows(list, key, canEdit);
        }
      });
      if (open) buildTodayRows(list, key, canEdit);
      frag.appendChild(folder);
    });
    el.todayList.innerHTML = "";
    el.todayList.appendChild(frag);
  }

  // Build the per-employee "начало/конец + Сохранить" rows for one day inside listEl.
  function buildTodayRows(listEl, key, canEdit) {
    const drafts = todayDraft[key] || {};
    // Order staff by groups: each group gets a header, its members listed under it;
    // employees that belong to no group go last (under "Без группы" when groups exist).
    const seen = new Set();
    const groupOrder = [];
    for (const g of state.groups) {
      const ids = Array.isArray(g.memberIds) ? g.memberIds : [];
      const members = state.staff.filter((s) => ids.includes(s.id));
      if (members.length === 0) continue;
      groupOrder.push({ name: g.name, members });
      members.forEach((m) => seen.add(m.id));
    }
    const ungrouped = state.staff.filter((s) => !seen.has(s.id));

    const makeRow = (listEl2, s) => {
      const seg = todayRows(s.id, key)[0] || {};
      const d = drafts[s.id];
      const startHm = d ? d.start : (seg.start != null ? msToHm(seg.start) : "");
      const endHm = d ? d.end : (seg.end != null ? msToHm(seg.end) : "");
      const row = document.createElement("div");
      row.className = "admin-row today-row";
      row.innerHTML = `
        <div class="avatar">${escapeHtml(s.name).trim().charAt(0).toUpperCase()}</div>
        <div class="admin-row-main sd-main">
          <div class="admin-row-name">${escapeHtml(s.name)}</div>
          <div class="today-times">
            <span class="sd-label">начало</span>
            <input class="sd-time today-start" type="time" data-id="${escapeHtml(s.id)}" value="${startHm}" />
            <span class="sd-label">конец</span>
            <input class="sd-time today-end" type="time" data-id="${escapeHtml(s.id)}" value="${endHm}" />
          </div>
        </div>
        <div class="today-state" id="todayState-${escapeHtml(s.id)}"></div>
        ${canEdit ? "" : '<span class="disabled-note">чтение</span>'}
      `;
      listEl2.appendChild(row);
      // Persist typed values into the draft store so they survive re-render
      // ("Обновить" / day-folder collapse-and-reopen) until saved.
      const startInput = row.querySelector(".today-start");
      const endInput = row.querySelector(".today-end");
      const stateEl = row.querySelector(".today-state");
      const saveDraft = () => {
        if (!todayDraft[key]) todayDraft[key] = {};
        todayDraft[key][s.id] = { start: startInput.value, end: endInput.value };
        persistDraft();
      };
      // Адаптивное время сохраняется само: правка «начало»/«конец» сразу пишется
      // на сервер (с короткой паузой-debounce), кнопка «Сохранить» не нужна.
      let autoTimer = null;
      const scheduleAutoSave = () => {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(() => saveTodayRow(s.id, key), 700);
      };
      if (canEdit) {
        startInput.addEventListener("input", () => { saveDraft(); scheduleAutoSave(); });
        endInput.addEventListener("input", () => { saveDraft(); scheduleAutoSave(); });
        // Выбор времени из пикера (change) сохраняет сразу, без паузы.
        startInput.addEventListener("change", () => { saveDraft(); clearTimeout(autoTimer); saveTodayRow(s.id, key); });
        endInput.addEventListener("change", () => { saveDraft(); clearTimeout(autoTimer); saveTodayRow(s.id, key); });
      } else {
        startInput.disabled = true;
        endInput.disabled = true;
      }
    };

    const appendGroup = (el2, name, members, gid) => {
      const group = document.createElement("div");
      group.className = "today-group";
      // Персистентный ключ свёрнутости группы на конкретный день (как у папок дней).
      const gKey = "grp:" + key + ":" + (gid || name);
      if (state.collapsed.has(gKey)) group.classList.add("collapsed");
      const head = document.createElement("div");
      head.className = "today-group-head";
      head.innerHTML = `
        <span class="today-group-caret">▶</span>
        <span class="today-group-name">${escapeHtml(name)}</span>
        <span class="today-group-count">${members.length}</span>
      `;
      const body = document.createElement("div");
      body.className = "today-group-body";
      members.forEach((s) => makeRow(body, s));
      group.appendChild(head);
      group.appendChild(body);
      head.addEventListener("click", () => {
        group.classList.toggle("collapsed");
        if (group.classList.contains("collapsed")) state.collapsed.add(gKey);
        else state.collapsed.delete(gKey);
        saveCollapsed(state.collapsed);
      });
      el2.appendChild(group);
    };

    groupOrder.forEach((g) => appendGroup(listEl, g.name, g.members, g.id));
    if (ungrouped.length) {
      if (groupOrder.length) appendGroup(listEl, "Без группы", ungrouped, "__none__");
      else ungrouped.forEach((s) => makeRow(listEl, s));
    }
  }

  async function saveTodayRow(id, key) {
    // Находим строку этого сотрудника в списке, чтобы перечитать поля
    // «начало»/«конец» (кнопки больше нет — изменения сохраняются сами).
    let card = null;
    const rows = el.todayList.querySelectorAll(".today-row");
    for (const r of rows) {
      const sInput = r.querySelector(".today-start");
      if (sInput && sInput.getAttribute("data-id") === String(id)) { card = r; break; }
    }
    if (!card) return;
    const startVal = card.querySelector(".today-start").value;
    const endVal = card.querySelector(".today-end").value;
    const stateEl = card.querySelector(".today-state");
    if (stateEl) stateEl.textContent = "сохраняю…";
    // Пустые начало и конец — не трогаем день (не создаём пустую запись).
    const segments = [];
    if (startVal) {
      const startMs = hmToMs(key, startVal);
      let endMs = endVal ? hmToMs(key, endVal) : null;
      // Ночная смена: если время «конец» меньше времени «начала», смена
      // закончилась на следующий календарный день (например 08:13 → 02:59).
      // Раньше это считалось ошибкой «конец раньше начала», и администратор не
      // мог сохранить правку времени у сотрудников с ночной сменой.
      if (endMs != null && endMs <= startMs) {
        endMs += 86400000; // переносим конец на следующий день по календарю
      }
      segments.push({ kind: "work", start: startMs, end: endMs, id: `t-${id}` });
    }
    try {
      await api("/api/admin/day", {
        method: "PUT",
        body: JSON.stringify({ key, ownerId: id, segments }),
      });
      // Обновить локальный кэш дня — только сегменты ЭТОГО сотрудника, чтобы не
      // затирать время других (прежний код заменял весь день одним владельцем).
      if (!state.days[key]) state.days[key] = {};
      if (!(state.days[key].byEmployee && typeof state.days[key].byEmployee === "object")) {
        // Legacy single-owner day: convert, keeping any other employee's data.
        state.days[key].byEmployee = state.days[key].byEmployee || {};
        const legacyOwner = state.days[key].ownerId;
        const legacySegs = Array.isArray(state.days[key].segments) ? state.days[key].segments : [];
        if (legacyOwner && legacyOwner !== id) {
          state.days[key].byEmployee[legacyOwner] = { segments: legacySegs };
        }
        delete state.days[key].ownerId;
        delete state.days[key].segments;
      }
      if (segments.length > 0) {
        state.days[key].byEmployee[id] = { segments };
      } else {
        delete state.days[key].byEmployee[id];
      }
      const hasAnySegs = state.days[key].byEmployee && Object.keys(state.days[key].byEmployee).some((e) => (state.days[key].byEmployee[e].segments || []).length);
      const hasStatusesCache = state.days[key].statuses && Object.keys(state.days[key].statuses).length;
      if (!hasAnySegs && !hasStatusesCache) delete state.days[key];
      // Saved — drop this employee's draft so a stale typed value cannot override
      // the freshly persisted day on the next render.
      if (todayDraft[key]) { delete todayDraft[key][id]; persistDraft(); }
      if (stateEl) stateEl.textContent = "сохранено";
      if (state.me && state.me.id === id) { refreshToday(); render(); }
      postLog(`время на ${key} (${staffById(id) ? staffById(id).name : id})`, "manual");
    } catch (e) {
      if (stateEl) stateEl.textContent = "ошибка";
      toast(e.message || "Не удалось сохранить");
    }
  }

  async function addStaff() {
    const name = el.newStaffName.value.trim();
    if (!name) { toast("Введите ФИО сотрудника"); return; }
    try {
      const r = await api("/api/staff", { method: "POST", body: JSON.stringify({ name }) });
      state.staff = r.staff;
      el.newStaffName.value = "";
      renderAdminSub("staff");
      toast("Сотрудник добавлен");
    } catch (e) {
      toast(e.message);
    }
  }

  async function removeStaff(id) {
    if (id === state.me.id) { toast("Себя удалить нельзя"); return; }
    const name = staffById(id) ? staffById(id).name : "сотрудника";
    if (!confirm(`Удалить ${name} из списка и закрыть ему вход в приложение?\n\nВсе его записи будут удалены.`)) return;
    try {
      const r = await api("/api/staff/" + encodeURIComponent(id), { method: "DELETE" });
      if (Array.isArray(r.blocked)) state.blocked = r.blocked;
      await loadState();
      render();
      renderAdminSub("staff");
      toast("Сотрудник удалён, вход закрыт");
    } catch (e) {
      toast(e.message);
    }
  }

  async function unblockStaff(id) {
    try {
      const r = await api("/api/admin/staff/block", { method: "POST", body: JSON.stringify({ id, on: false }) });
      if (Array.isArray(r.blocked)) state.blocked = r.blocked;
      toast("Доступ восстановлен");
      renderAdminSub("staff");
    } catch (e) {
      toast(e.message);
    }
  }

  // ------------- Groups & moderators (admin) -------------
  function renderGroups() {
    el.groupsList.innerHTML = "";
    if (state.groups.length === 0) {
      el.groupsList.innerHTML = `<div class="empty-hint">Групп пока нет. Создайте первую группу, затем добавьте сотрудников и назначьте модератора.</div>`;
      return;
    }
    state.groups.forEach((g) => {
      const card = document.createElement("div");
      card.className = "admin-row group-card";
      const memberToggles = state.staff.map((s) => {
        const checked = g.memberIds.includes(s.id) ? "checked" : "";
        const isMod = g.moderatorId === s.id;
        return `<label class="group-member">
          <input type="checkbox" class="group-member-cb" data-id="${escapeHtml(s.id)}" ${checked} />
          <span>${escapeHtml(s.name)}${isMod ? ' <span class="badge">модератор</span>' : ""}</span>
        </label>`;
      }).join("");
      const modOptions = [`<option value="">— нет —</option>`].concat(
        state.staff.map((s) => {
          const sel = g.moderatorId === s.id ? "selected" : "";
          return `<option value="${escapeHtml(s.id)}" ${sel}>${escapeHtml(s.name)}</option>`;
        })
      ).join("");
      card.innerHTML = `
        <div class="admin-row-main sd-main" style="width:100%">
          <div class="admin-row-name">${escapeHtml(g.name)} <span class="group-count">${g.memberIds.length}</span></div>
          <div class="group-meta">
            <label class="group-field"><span class="group-label">Модератор</span>
              <select class="select-input group-mod" data-id="${escapeHtml(g.id)}">${modOptions}</select>
            </label>
          </div>
          <div class="group-members">${memberToggles}</div>
          <div class="sd-actions">
            <button class="mini-btn group-save" data-id="${escapeHtml(g.id)}" type="button">Сохранить</button>
            <button class="mini-btn group-del" data-id="${escapeHtml(g.id)}" type="button">Удалить</button>
          </div>
        </div>
      `;
      el.groupsList.appendChild(card);
    });
    el.groupsList.querySelectorAll(".group-save").forEach((b) => b.addEventListener("click", () => saveGroup(b)));
    el.groupsList.querySelectorAll(".group-del").forEach((b) => b.addEventListener("click", () => deleteGroup(b)));
  }

  async function saveGroup(btn) {
    const card = btn.closest(".admin-row");
    if (!card) return;
    const moderatorId = card.querySelector(".group-mod").value || null;
    const memberIds = [...card.querySelectorAll(".group-member-cb:checked")].map((c) => c.dataset.id);
    try {
      const r = await api("/api/groups/" + encodeURIComponent(btn.dataset.id), {
        method: "PUT",
        body: JSON.stringify({ moderatorId, memberIds }),
      });
      state.groups = r.groups;
      renderGroups();
      toast("Группа обновлена");
    } catch (e) {
      toast(e.message);
    }
  }

  async function deleteGroup(btn) {
    const card = btn.closest(".admin-row");
    const name = card ? card.querySelector(".admin-row-name").textContent.trim() : "группу";
    if (!confirm(`Удалить ${name}? Сотрудники останутся в списке.`)) return;
    try {
      const r = await api("/api/groups/" + encodeURIComponent(btn.dataset.id), { method: "DELETE" });
      state.groups = r.groups;
      renderGroups();
      toast("Группа удалена");
    } catch (e) {
      toast(e.message);
    }
  }

  async function addGroup() {
    const name = el.newGroupName.value.trim();
    if (!name) { toast("Введите название группы"); return; }
    try {
      const r = await api("/api/groups", { method: "POST", body: JSON.stringify({ name }) });
      state.groups = r.groups;
      el.newGroupName.value = "";
      renderGroups();
      toast("Группа создана");
    } catch (e) {
      toast(e.message);
    }
  }

  function renderSalaries() {
    const now = new Date();
    const bizDays = businessDaysInMonth(now.getFullYear(), now.getMonth());
    const normDay = state.norm;
    const monthLabel = new Date(now.getFullYear(), now.getMonth(), 1)
      .toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    let html;
    if (state.staff.length === 0) {
      html = `<tr><td colspan="6" class="num" style="color:var(--ink-faint)">Добавьте сотрудников</td></tr>`;
    } else {
      html = state.staff.map((s) => {
        const salary = s.salary != null ? s.salary : 50000;
        const bonus = s.bonus != null ? s.bonus : 0;
        const extraBonus = s.extraBonus != null ? s.extraBonus : 0;
        const hoursNorm = bizDays * RATE_BASE_HOURS;
        const rate = hoursNorm > 0 ? salary / hoursNorm : 0;
        return `
          <tr data-staff="${s.id}">
            <td>${escapeHtml(s.name)}</td>
            <td data-label="Оклад"><input class="salary-input" type="number" min="0" step="500" value="${salary}" data-id="${s.id}" title="Оклад за месяц" /></td>
            <td data-label="Премия"><input class="bonus-input" type="number" min="0" step="500" value="${bonus}" data-id="${s.id}" title="Премия за месяц" /></td>
            <td data-label="Надбавка"><input class="extra-bonus-input" type="number" min="0" step="500" value="${extraBonus}" data-id="${s.id}" title="Надбавка — включается в оклад, но не влияет на расчёт переработок" /></td>
            <td data-label="Рабочих дней в мес." class="num" title="${monthLabel}: рабочие дни рассчитаны автоматически">${bizDays} <span class="muted-mark">(авто)</span></td>
            <td data-label="Ставка ₽/ч" class="num rate-cell" data-id="${s.id}">${fmtMoney(rate)}</td>
          </tr>
        `;
      }).join("");
    }
    el.salariesBody.innerHTML = html;
    el.salariesBody.querySelectorAll(".salary-input").forEach((inp) => {
      inp.addEventListener("input", () => {
        const id = inp.dataset.id;
        const v = parseInt(inp.value, 10);
        const normHours = bizDays * RATE_BASE_HOURS;
        const rate = (!Number.isFinite(v) || v < 0 || normHours <= 0) ? 0 : v / normHours;
        const cell = el.salariesBody.querySelector(`.rate-cell[data-id="${id}"]`);
        if (cell) cell.textContent = fmtMoney(rate);
      });
      inp.addEventListener("change", async () => {
        const id = inp.dataset.id;
        const st = staffById(id);
        if (!st) return;
        let v = parseInt(inp.value, 10);
        if (!Number.isFinite(v) || v < 0) v = 0;
        st.salary = Math.round(v);
        try {
          await api("/api/staff/salary", { method: "POST", body: JSON.stringify({ id, salary: st.salary }) });
          toast(`Оклад обновлён: ${st.name} — ${fmtMoney(st.salary)}`);
        } catch (e) {
          toast(e.message);
        }
      });
    });
    el.salariesBody.querySelectorAll(".bonus-input").forEach((inp) => {
      inp.addEventListener("change", async () => {
        const id = inp.dataset.id;
        const st = staffById(id);
        if (!st) return;
        let v = parseInt(inp.value, 10);
        if (!Number.isFinite(v) || v < 0) v = 0;
        st.bonus = Math.round(v);
        try {
          await api("/api/staff/bonus", { method: "POST", body: JSON.stringify({ id, bonus: st.bonus }) });
          toast(`Премия обновлена: ${st.name} — ${fmtMoney(st.bonus)}`);
        } catch (e) {
          toast(e.message);
        }
      });
    });
    el.salariesBody.querySelectorAll(".extra-bonus-input").forEach((inp) => {
      inp.addEventListener("change", async () => {
        const id = inp.dataset.id;
        const st = staffById(id);
        if (!st) return;
        let v = parseInt(inp.value, 10);
        if (!Number.isFinite(v) || v < 0) v = 0;
        st.extraBonus = Math.round(v);
        try {
          await api("/api/staff/extra-bonus", { method: "POST", body: JSON.stringify({ id, extraBonus: st.extraBonus }) });
          toast(`Надбавка обновлена: ${st.name} — ${fmtMoney(st.extraBonus)}`);
        } catch (e) {
          toast(e.message);
        }
      });
    });
  }

  // Convert ms timestamp -> "HH:MM" (local time).
  // Единый опорный часовой пояс — смещение от UTC в минутах, присланное сервером.
  // Все «ЧЧ:ММ» интерпретируются в поясе сервера, а не в поясе конкретного
  // устройства (телефон/компьютер), иначе у пользователей с другим поясом время
  // «слетает» (сдвигается) при редактировании и сохранении.
  function tzOffsetMin() {
    return (state.serverOffsetMin != null && Number.isFinite(state.serverOffsetMin))
      ? state.serverOffsetMin
      : -new Date().getTimezoneOffset();
  }

  function msToHm(ts) {
    const d = new Date(ts + tzOffsetMin() * 60000);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }

  // Build a ms timestamp for key=YYYY-MM-DD at HH:MM in the server timezone.
  function hmToMs(key, hhmm) {
    if (!hhmm) return null;
    const [y, m, d] = key.split("-").map(Number);
    const [hh, mm] = hhmm.split(":").map(Number);
    return Date.UTC(y, m - 1, d, hh, mm, 0, 0) - tzOffsetMin() * 60000;
  }

  // Активная подвкладка журнала: "status" | "timer" | "manual".
  let activeLogKind = "status";
  function switchLogKind(kind) {
    activeLogKind = kind;
    if (el.logTabs) {
      el.logTabs.querySelectorAll(".jtab").forEach((t) => t.classList.toggle("active", t.dataset.jkind === kind));
    }
    renderLog();
  }

  function renderLog() {
    // Записи без kind (старые) считаем нажатиями таймера.
    const items = state.log
      .filter((e) => (e.kind || "timer") === activeLogKind)
      .slice()
      .reverse();
    const labels = {
      status: "Журнал статусов пока пуст. Статусы, проставленные в табеле, записываются сюда.",
      timer: "Журнал таймера пока пуст. Время нажатий таймера сотрудниками записывается сюда.",
      manual: "Журнал изменений пока пуст. Ручные правки времени по дням записываются сюда.",
    };
    if (items.length === 0) {
      el.logList.innerHTML = `<div class="empty-hint">${labels[activeLogKind]}</div>`;
      return;
    }
    el.logList.innerHTML = items.map((e) => {
      const d = new Date(e.ts);
      const who = staffById(e.ownerId) ? staffById(e.ownerId).name : "—";
      return `
        <div class="admin-row">
          <div class="avatar">${(who || "?").trim().charAt(0).toUpperCase()}</div>
          <div class="admin-row-main">
            <div class="admin-row-name">${escapeHtml(e.action)}</div>
            <div class="admin-row-sub">${d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })} · ${escapeHtml(who)}</div>
          </div>
        </div>
      `;
    }).join("");
  }

  function renderAdmins() {
    el.adminsList.innerHTML = "";
    state.staff.forEach((s) => {
      const isAdm = state.admins.includes(s.id);
      const isGatewayAdmin = s.id === state.me.id && state.isAdmin;
      const isOwner = s.id === state.me.id;
      const row = document.createElement("div");
      row.className = "admin-row";
      row.innerHTML = `
        <div class="avatar">${escapeHtml(s.name).trim().charAt(0).toUpperCase()}</div>
        <div class="admin-row-main">
          <div class="admin-row-name">${escapeHtml(s.name)}${isOwner ? ' <span class="badge">владелец</span>' : ""}</div>
          <div class="admin-row-sub">${isGatewayAdmin ? "администратор (портал)" : (isAdm ? "администратор" : "сотрудник")}</div>
        </div>
        <div class="row-action">
          ${isOwner
            ? '<span class="disabled-note">снять нельзя</span>'
            : `<button class="mini-btn ${isAdm ? "on" : ""}" data-id="${s.id}" data-on="${isAdm}">${isAdm ? "Снять роль" : "Сделать админом"}</button>`}
        </div>
      `;
      el.adminsList.appendChild(row);
    });
    el.adminsList.querySelectorAll(".mini-btn[data-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const on = btn.dataset.on === "true";
        try {
          await api("/api/admins", { method: "POST", body: JSON.stringify({ id, on: !on }) });
          if (on) state.admins = state.admins.filter((a) => a !== id);
          else state.admins.push(id);
          renderAdmins();
          toast(on ? "Роль администратора снята" : "Назначен администратором");
        } catch (e) {
          toast(e.message);
        }
      });
    });
  }

  // ------------- Params -------------
  // Render the "Показывать группам" scope as a list of checkboxes (a multi-select
  // was awkward to use and hard to save).
  function renderGroupChecks(container, selectedIds) {
    if (!container) return;
    const groups = state.groups || [];
    if (groups.length === 0) {
      container.innerHTML = `<span class="group-scope-empty">Сначала создайте группы в разделе «Группы» (панель администратора). Затем вернитесь сюда и отметьте, кому виден раздел.</span>`;
      return;
    }
    container.innerHTML = groups.map((g) => {
      const checked = (selectedIds || []).includes(g.id) ? "checked" : "";
      return `<label class="group-check">
        <input type="checkbox" value="${escapeHtml(g.id)}" ${checked} />
        <span>${escapeHtml(g.name)}</span>
      </label>`;
    }).join("");
    // Автосохранение групп: отметку сохраняем сразу, без кнопки «Сохранить».
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => applyParams());
    });
  }

  function collectGroupChecks(container) {
    if (!container) return [];
    return [...container.querySelectorAll('input[type="checkbox"]:checked')].map((c) => c.value);
  }

  // Client-side replica of the server's group-scoped overtime visibility, used to
  // refresh the "me"/staff flags right after an admin saves the params.
  function staffInGroup(staffId, groupIds) {
    if (!groupIds || groupIds.length === 0) return true; // no groups -> everyone
    return groupIds.some((gid) => {
      const g = (state.groups || []).find((x) => x.id === gid);
      return g && (g.memberIds || []).includes(staffId);
    });
  }
  // Виден ли раздел «Отгрузка» текущему пользователю. Админ видит раздел всегда,
  // когда включён переключатель (чтобы сразу управлять складом, не отмечая себя
  // в группе); прочие сотрудники — только если состоят в отмеченной группе.
  function shipmentVisible() {
    if (!state.params.showShipment) return false;
    if (state.isAdmin) return true;
    const ids = state.params.shipmentGroups || [];
    if (ids.length === 0) return false; // никого не отмечено — раздел скрыт у всех
    return state.me && staffInGroup(state.me.id, ids);
  }
  function recomputeOverVisibility() {
    const pH = state.params.showOverHoursGroups || [];
    const pS = state.params.showOverSumGroups || [];
    if (state.me) {
      // Same rule as the server: the group scope governs everyone, admins included.
      state.me.seeOverHours = !!state.params.showOverHours && staffInGroup(state.me.id, pH);
      state.me.seeOverSum = !!state.params.showOverSum && staffInGroup(state.me.id, pS);
    }
    (state.staff || []).forEach((s) => {
      s.seeOverHours = !!state.params.showOverHours && staffInGroup(s.id, pH);
      s.seeOverSum = !!state.params.showOverSum && staffInGroup(s.id, pS);
    });
  }

  function renderParams() {
    if (el.showOverHours) el.showOverHours.checked = !!state.params.showOverHours;
    if (el.showOverSum) el.showOverSum.checked = !!state.params.showOverSum;
    if (el.showDrivers) el.showDrivers.checked = !!state.params.showDrivers;
    if (el.adminSeeRoutes) el.adminSeeRoutes.checked = !!state.params.adminSeeRoutes;
    if (el.driverSeeRoutes) el.driverSeeRoutes.checked = !!state.params.driverSeeRoutes;
    if (el.showShipment) el.showShipment.checked = !!state.params.showShipment;
    if (el.allowDriverStartWithoutShipment) el.allowDriverStartWithoutShipment.checked = !!state.params.allowDriverStartWithoutShipment;
    if (el.allowFinishUnloadIncomplete) el.allowFinishUnloadIncomplete.checked = !!state.params.allowFinishUnloadIncomplete;
    renderGroupChecks(el.showOverHoursGroups, state.params.showOverHoursGroups || []);
    renderGroupChecks(el.showOverSumGroups, state.params.showOverSumGroups || []);
    renderGroupChecks(el.shipmentGroups, state.params.shipmentGroups || []);
    if (el.multiplierVal) el.multiplierVal.value = state.params.multiplier;
    if (el.multiplierFrom) el.multiplierFrom.value = state.params.multFrom || "";
    if (el.multiplierTo) el.multiplierTo.value = state.params.multTo || "";
    if (el.normVal) el.normVal.value = state.norm;
    if (el.updateVersionCode) el.updateVersionCode.value = state.params.updateVersionCode != null ? state.params.updateVersionCode : "";
    if (el.updateVersionName) el.updateVersionName.value = state.params.updateVersionName || "";
    if (el.updateApkUrl) el.updateApkUrl.value = state.params.updateApkUrl || "";
    if (el.updateNotes) el.updateNotes.value = state.params.updateNotes || "";
    updateMultiplierStatus();
  }

  function updateMultiplierStatus() {
    if (!el.multiplierStatus) return;
    const active = multiplierActive();
    const hasPeriod = !!(state.params.multFrom && state.params.multTo);
    const normFrom = state.params.multFrom ? new Date(state.params.multFrom).toLocaleDateString("ru-RU") : "—";
    const normTo = state.params.multTo ? new Date(state.params.multTo).toLocaleDateString("ru-RU") : "—";
    el.multiplierStatus.textContent = active
      ? (hasPeriod
          ? `Активен сейчас · множитель ×${state.params.multiplier} · ${normFrom} – ${normTo}`
          : `Активен сейчас · множитель ×${state.params.multiplier} · действует постоянно`)
      : (hasPeriod
          ? `Не активен · период ${normFrom} – ${normTo}`
          : "Множитель не задан (×1)");
    el.multiplierStatus.classList.toggle("active", active);
  }

  // Цепочка сохранения параметров: применяем изменения мгновенно на клиенте
  // (вкладки реагируют сразу), а на сервер пишем строго последовательно, чтобы
  // быстрые клики не «разъезжались» гонкой независимых POST и не откатывали
  // друг друга (в т.ч. ползунок «Отгрузка»).
  let paramsSaveChain = Promise.resolve();
  function applyParams() {
    const p = {
      showOverHours: !!el.showOverHours.checked,
      showOverSum: !!el.showOverSum.checked,
      showDrivers: !!el.showDrivers.checked,
      adminSeeRoutes: !!el.adminSeeRoutes.checked,
      driverSeeRoutes: !!el.driverSeeRoutes.checked,
      showShipment: !!el.showShipment.checked,
      allowDriverStartWithoutShipment: !!el.allowDriverStartWithoutShipment.checked,
      allowFinishUnloadIncomplete: !!el.allowFinishUnloadIncomplete.checked,
      showOverHoursGroups: collectGroupChecks(el.showOverHoursGroups),
      showOverSumGroups: collectGroupChecks(el.showOverSumGroups),
      shipmentGroups: collectGroupChecks(el.shipmentGroups),
    };
    let m = parseFloat(el.multiplierVal.value);
    p.multiplier = Number.isFinite(m) && m >= 1 ? m : 1;
    p.multFrom = el.multiplierFrom.value || null;
    p.multTo = el.multiplierTo.value || null;
    let norm = parseFloat(el.normVal.value);
    p.norm = (Number.isFinite(norm) && norm >= 1 && norm <= 24) ? norm : state.norm;
    // Версия обновления Android-APK (управляется из «Параметры»). Пусто = вернуться
    // к значениям окружения/дефолтам сервера.
    if (el.updateVersionCode) p.updateVersionCode = el.updateVersionCode.value.trim();
    if (el.updateVersionName) p.updateVersionName = el.updateVersionName.value.trim();
    if (el.updateApkUrl) p.updateApkUrl = el.updateApkUrl.value.trim();
    if (el.updateNotes) p.updateNotes = el.updateNotes.value.trim();
    if (p.multFrom && p.multTo && p.multFrom > p.multTo) {
      const tmp = p.multFrom;
      p.multFrom = p.multTo;
      p.multTo = tmp;
    }
    // Мгновенно применяем к текущему состоянию: ползунки и вкладки обновляются
    // сразу, без ожидания ответа сервера (и без перезагрузки страницы).
    state.params = Object.assign({}, state.params, p);
    state.norm = p.norm;
    recomputeOverVisibility();
    renderParams();
    render();
    refreshNavTabs();
    // Последовательное сохранение на сервер.
    return (paramsSaveChain = paramsSaveChain.then(async () => {
      try {
        const r = await api("/api/params", { method: "POST", body: JSON.stringify(p) });
        state.params = r.params;
        if (r.norm != null && Number.isFinite(r.norm)) state.norm = r.norm;
        recomputeOverVisibility();
        renderParams();
        render();
        refreshNavTabs();
      } catch (e) {
        toast(e.message);
      }
    }));
  }

  // ------------- Settings -------------
  function openSettings() {
    el.settingsModal.showModal();
    // Восстанавливаем последнюю открытую вкладку панели, иначе — дефолт по роли
    // (админ — «Параметры», модератор — «Время работы»).
    const savedAdmin = (() => {
      try {
        const v = localStorage.getItem("biotime_admin_sub");
        return ["staff", "today", "groups", "salaries", "log", "settings", "admins", "status"]
          .includes(v) ? v : null;
      } catch { return null; }
    })();
    switchAdminSub(savedAdmin || (state.isAdmin ? "settings" : "today"));
  }
  function closeSettings() {
    el.settingsModal.close();
  }

  // ------------- Events -------------
  el.startBtn.addEventListener("click", startWork);
  // Finish without a confirm dialog: on mobile the native confirm() is unreliable,
  // so the button must finish the day instantly.
  el.finishBtn.addEventListener("click", finishWork);

  el.settingsBtn.addEventListener("click", openSettings);
  el.adminClose.addEventListener("click", closeSettings);
  el.addStaffBtn.addEventListener("click", addStaff);
  el.addGroupBtn.addEventListener("click", addGroup);
  el.newGroupName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addGroup();
    }
  });
  // ---- Резервная копия: скачать полную базу ----
  if (el.backupExportBtn) {
    el.backupExportBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/admin/backup", { method: "GET" });
        if (!res.ok) {
          let msg = "Не удалось создать бэкап";
          try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
          toast(msg);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        // Имя файла забираем из заголовка Content-Disposition, иначе дефолт.
        const disp = res.headers.get("Content-Disposition") || "";
        const m = /filename\*=UTF-8''([^;]+)/.exec(disp);
        a.download = m ? decodeURIComponent(m[1]) : `biotime-backup-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (el.backupStatus) {
          el.backupStatus.textContent = "Бэкап скачан. Храните файл в надёжном месте — он содержит все данные приложения.";
          el.backupStatus.className = "backup-status ok";
        }
        toast("Бэкап скачан");
      } catch (e) {
        toast(e.message || "Не удалось создать бэкап");
      }
    });
  }

  // ---- Полная копия приложения (код + данные): защита от потери папок на
  // компьютере. Скачивает один JSON-файл со всеми исходниками проекта и базой.
  if (el.backupAppBtn) {
    el.backupAppBtn.addEventListener("click", async () => {
      try {
        const res = await fetch("/api/admin/backup/app", { method: "GET" });
        if (!res.ok) {
          let msg = "Не удалось создать копию приложения";
          try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* ignore */ }
          toast(msg);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const disp = res.headers.get("Content-Disposition") || "";
        const m = /filename\*=UTF-8''([^;]+)/.exec(disp);
        a.download = m ? decodeURIComponent(m[1]) : `biotime-app-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        if (el.backupStatus) {
          el.backupStatus.textContent = "Копия приложения скачана: код и все данные в одном файле. Храните его в надёжном месте (флешка, облако) — она восстановит приложение, даже если локальные папки будут удалены.";
          el.backupStatus.className = "backup-status ok";
        }
        toast("Копия приложения скачана");
      } catch (e) {
        toast(e.message || "Не удалось создать копию приложения");
      }
    });
  }

  // ---- Резервная копия: восстановить из файла ----
  if (el.backupImportFile) {
    el.backupImportFile.addEventListener("change", async () => {
      const file = el.backupImportFile.files && el.backupImportFile.files[0];
      if (!file) return;
      if (!confirm("Восстановить базу из выбранного файла? Текущие данные будут заменены (их копия сохранится на сервере отдельным файлом).")) {
        el.backupImportFile.value = "";
        return;
      }
      try {
        const text = await file.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error("Файл не является корректным JSON-бэкапом"); }
        const res = await fetch("/api/admin/backup/restore", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(parsed),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast((j && j.error) || "Не удалось восстановить базу");
          return;
        }
        if (el.backupStatus) {
          const r = j.restored || {};
          el.backupStatus.textContent = `База восстановлена: сотрудников — ${r.staff ?? "?"}, дней — ${r.days ?? "?"}, клиентов — ${r.clients ?? "?"}, маршрутов — ${r.routes ?? "?"}. Страница будет перезагружена.`;
          el.backupStatus.className = "backup-status ok";
        }
        toast("База восстановлена");
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        toast(e.message || "Не удалось восстановить базу");
      } finally {
        el.backupImportFile.value = "";
      }
    });
  }

  // ---- Автоматические копии: список, скачивание, восстановление ----
  function fmtBackupSize(bytes) {
    bytes = Number(bytes) || 0;
    if (bytes < 1024) return bytes + " Б";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " КБ";
    return (bytes / (1024 * 1024)).toFixed(1) + " МБ";
  }
  function fmtBackupTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  async function loadAutoBackups() {
    if (!el.backupAutoList) return;
    try {
      const res = await fetch("/api/admin/backup/auto");
      if (!res.ok) return;
      const j = await res.json();
      if (el.backupAutoNote) {
        const h = Number(j.everyHours) || 6;
        const keep = Number(j.keep) || 30;
        el.backupAutoNote.textContent = `≈ каждые ${h} ч · хранится ${keep} копий`;
      }
      const list = Array.isArray(j.backups) ? j.backups : [];
      if (list.length === 0) {
        el.backupAutoList.innerHTML = `<div class="empty-hint">Автоматических копий пока нет — первая появится при первом запуске сервера.</div>`;
        return;
      }
      el.backupAutoList.innerHTML = list.map((b) => `
        <div class="backup-auto-item" data-name="${escapeHtml(b.name)}">
          <div class="backup-auto-item-info">
            <span class="backup-auto-item-name">${escapeHtml(b.name)}</span>
            <span class="backup-auto-item-meta">${fmtBackupTime(b.mtime)} · ${fmtBackupSize(b.size)}</span>
          </div>
          <div class="backup-auto-item-actions">
            <button type="button" class="drv-mini-btn backup-auto-dl" data-name="${escapeHtml(b.name)}">Скачать</button>
            <button type="button" class="drv-mini-btn backup-auto-restore" data-name="${escapeHtml(b.name)}">Восстановить</button>
          </div>
        </div>
      `).join("");
      el.backupAutoList.querySelectorAll(".backup-auto-dl").forEach((btn) => {
        btn.addEventListener("click", () => downloadAutoBackup(btn.dataset.name));
      });
      el.backupAutoList.querySelectorAll(".backup-auto-restore").forEach((btn) => {
        btn.addEventListener("click", () => restoreAutoBackup(btn.dataset.name));
      });
    } catch { /* transient — list stays empty */ }
  }
  async function downloadAutoBackup(name) {
    try {
      const res = await fetch(`/api/admin/backup/auto/download?name=${encodeURIComponent(name)}`);
      if (!res.ok) { toast("Не удалось скачать копию"); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Копия скачана");
    } catch (e) {
      toast(e.message || "Не удалось скачать копию");
    }
  }
  async function restoreAutoBackup(name) {
    if (!confirm(`Восстановить базу из автоматической копии «${name}»? Текущие данные будут заменены (их копия сохранится на сервере).`)) return;
    try {
      const dl = await fetch(`/api/admin/backup/auto/download?name=${encodeURIComponent(name)}`);
      if (!dl.ok) { toast("Не удалось прочитать копию"); return; }
      const parsed = await dl.json();
      const res = await fetch("/api/admin/backup/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { toast((j && j.error) || "Не удалось восстановить базу"); return; }
      if (el.backupStatus) {
        const r = j.restored || {};
        el.backupStatus.textContent = `База восстановлена из копии: сотрудников — ${r.staff ?? "?"}, дней — ${r.days ?? "?"}, клиентов — ${r.clients ?? "?"}, маршрутов — ${r.routes ?? "?"}. Страница будет перезагружена.`;
        el.backupStatus.className = "backup-status ok";
      }
      toast("База восстановлена");
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toast(e.message || "Не удалось восстановить базу");
    }
  }
  if (el.backupAutoList) loadAutoBackups();

  if (el.addDriverClientBtn) {
    el.addDriverClientBtn.addEventListener("click", addDriverClient);
    el.driverClientAddress && el.driverClientAddress.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); addDriverClient(); }
    });
  }
  // Связки контрагентов на один адрес.
  if (el.bundleToggle) {
    el.bundleToggle.addEventListener("click", () => {
      if (el.bundlePanel.hidden) {
        el.bundlePanel.hidden = false;
        refreshBundleUi();
        el.bundleToggle.classList.add("open");
      } else {
        el.bundlePanel.hidden = true;
        el.bundleToggle.classList.remove("open");
      }
    });
  }
  if (el.bundleCreateBtn) {
    el.bundleCreateBtn.addEventListener("click", createBundle);
  }
  if (el.bundleAddress) {
    el.bundleAddress.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createBundle(); }
    });
  }
  if (el.saveDriverRouteBtn) {
    el.saveDriverRouteBtn.addEventListener("click", saveDriverRoute);
  }
  if (el.autoRouteBtn) {
    el.autoRouteBtn.addEventListener("click", autoBuildRoute);
  }
  if (el.routeClientSearch) {
    el.routeClientSearch.addEventListener("input", () => {
      routeClientSearchValue = el.routeClientSearch.value;
      renderRouteClientOptions();
    });
  }
  // Внутренние вкладки маршрутизации.
  const bindSubtab = (btn, name) => {
    if (btn) btn.addEventListener("click", () => switchRouteSubtab(name));
  };
  bindSubtab(el.subtabContr, "contr");
  bindSubtab(el.subtabRoute, "route");
  bindSubtab(el.subtabRoutes, "routes");
  bindSubtab(el.subtabReport, "report");
  bindSubtab(el.subtabTracking, "tracking");
  // «Обновить» на карте трекинга. Вручную принудительно перезапрашивает маршруты
  // и живые координаты, всегда показывает явный отклик (спиннер на кнопке) и не
  // молча возвращается, если подвкладка временно скрыта.
  if (el.driverMapRefresh) {
    el.driverMapRefresh.addEventListener("click", async () => {
      el.driverMapRefresh.disabled = true;
      el.driverMapRefresh.textContent = "Обновляется…";
      try {
        const cfg = await api("/api/maps/config");
        const ymaps = await loadYandexMaps(cfg.yandexKey);
        if (driverMap) {
          await refreshDriverMap(ymaps);
          if (el.driverMapHint) el.driverMapHint.textContent = "";
        } else {
          // Карта ещё не создана — выполняем полноценную загрузку вкладки.
          await loadDriverMap();
        }
      } catch (e) {
        if (el.driverMapHint) {
          el.driverMapHint.textContent = (e && e.message) ? e.message : "Не удалось обновить карту";
        }
      } finally {
        el.driverMapRefresh.disabled = false;
        el.driverMapRefresh.textContent = "Обновить";
      }
    });
  }
  // «Обновить» в разделе «Отгрузка»: перезагружает список маршрутов складу.
  if (el.shipmentRefresh) {
    el.shipmentRefresh.addEventListener("click", loadShipments);
  }
  // Печать этикеток отгрузки: подтверждение и закрытие модалки.
  if (el.printConfirm) el.printConfirm.addEventListener("click", doPrintLabels);
  if (el.printCancel) el.printCancel.addEventListener("click", () => { try { el.printModal.close(); } catch {} });
  if (el.printClose) el.printClose.addEventListener("click", () => { try { el.printModal.close(); } catch {} });
  if (el.scanLoadBtn) el.scanLoadBtn.addEventListener("click", () => callQrScanner("load"));
  if (el.printClientSelect) {
    el.printClientSelect.addEventListener("change", () => refreshPrintLabels());
  }
  // Дашборд движения: кнопка «Обновить» и смена даты перезагружают данные.
  if (el.motionRefresh) {
    el.motionRefresh.addEventListener("click", loadMotionReport);
  }
  if (el.motionDateFilter) {
    el.motionDateFilter.addEventListener("change", loadMotionReport);
  }
  // Доставка: кнопка «Обновить» и смена даты перезагружают данные.
  if (el.deliveryRefresh) {
    el.deliveryRefresh.addEventListener("click", renderDeliveries);
  }
  if (el.deliveryDateFilter) {
    el.deliveryDateFilter.addEventListener("change", renderDeliveries);
  }
  // Трекинг: смена выбранного дня — перестраиваем карту под маршруты этого дня.
  if (el.driverTrackDate) {
    // По умолчанию показываем «сегодня».
    if (!el.driverTrackDate.value) el.driverTrackDate.value = dayKeyOf(Date.now());
    el.driverTrackDate.addEventListener("change", async () => {
      driverRoutesReady = false; // перерисовать статику маршрутов под новый день
      driverRoutesDueAt = 0;     // не ждать 30 с — перезагрузить маршруты сразу
      driverMapFitted = false;   // перестроить камеру под точки выбранного дня
      driverTracks = {};         // старый GPS-след к выбранному дню не относится
      if (driverTrackCollection) { try { driverTrackCollection.removeAll(); } catch { /* ignore */ } }
      if (window.ymaps) refreshDriverMap(window.ymaps);
    });
  }
  // Восстанавливаем последнюю открытую подвкладку маршрутизации (сработает
  // сразу при «Маршрутизация», а не только для админа — вкладка открывается
  // по мере доступа). Если сохранённого нет — дефолт «Контрагенты».
  let savedRouteSubtab = "contr";
  try {
    const v = localStorage.getItem("biotime_route_subtab");
    if (["contr", "route", "routes", "report", "tracking"].includes(v)) savedRouteSubtab = v;
  } catch { /* ignore */ }
  switchRouteSubtab(savedRouteSubtab);
  if (el.driverClientsToggle) {
    el.driverClientsToggle.addEventListener("click", () => {
      if (el.driverClientsBlock) {
        el.driverClientsBlock.classList.toggle("collapsed");
      }
    });
  }
  // Единое автосохранение всех тумблеров параметров: любой переключатель сразу
  // сохраняет полный набор через applyParams() (последовательно, без гонки) и
  // мгновенно обновляет вкладки.
  ["showOverHours", "showOverSum", "showDrivers", "adminSeeRoutes", "driverSeeRoutes", "showShipment", "allowDriverStartWithoutShipment", "allowFinishUnloadIncomplete"]
    .forEach((key) => {
      const el2 = el[key];
      if (el2) el2.addEventListener("change", applyParams);
    });
  // Автосохранение нормы рабочего дня и множителя подработки — без кнопки.
  if (el.normVal) el.normVal.addEventListener("change", applyParams);
  if (el.multiplierVal) el.multiplierVal.addEventListener("change", applyParams);
  if (el.multiplierFrom) el.multiplierFrom.addEventListener("change", applyParams);
  if (el.multiplierTo) el.multiplierTo.addEventListener("change", applyParams);
  // Автосохранение версии обновления Android-приложения.
  // Событие change срабатывает только на blur/Enter и легко «теряет» ввод, если
  // пользователь закрыл модалку, не убрав фокус с поля. Поэтому слушаем input
  // (каждое изменение) и сохраняем с коротким debounce — значение гарантированно
  // уходит на сервер, что бы ни случилось с фокусом.
  let updateDebounceTimer = null;
  ["updateVersionCode", "updateVersionName", "updateApkUrl", "updateNotes"]
    .forEach((key) => {
      const el2 = el[key];
      if (!el2) return;
      el2.addEventListener("input", () => {
        clearTimeout(updateDebounceTimer);
        updateDebounceTimer = setTimeout(applyParams, 600);
      });
    });
  el.clearLogBtn.addEventListener("click", async () => {
    try {
      await api("/api/log/clear", { method: "POST" });
      state.log = [];
      renderLog();
      toast("Журнал очищен");
    } catch (e) {
      toast(e.message);
    }
  });
  if (el.logTabs) {
    el.logTabs.querySelectorAll(".jtab").forEach((t) => {
      t.addEventListener("click", () => switchLogKind(t.dataset.jkind));
    });
  }
  el.newStaffName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addStaff();
    }
  });
  el.reportMonth.addEventListener("change", () => { state.reportMonthKey = el.reportMonth.value; renderReport(); });
  el.reportShowOver.addEventListener("change", renderReport);
  // Download the timesheet for the selected month as an .xlsx file (admin).
  el.reportExportBtn.addEventListener("click", async () => {
    const month = el.reportMonth.value;
    if (!month) return;
    const btn = el.reportExportBtn;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("busy");
    try {
      const res = await fetch(`/api/report/export?month=${encodeURIComponent(month)}`);
      if (!res.ok) throw new Error("Не удалось выгрузить табель");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Табель_${month}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Табель выгружен в Excel");
    } catch (e) {
      toast(e.message || "Не удалось выгрузить табель");
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
      btn.innerHTML = original;
    }
  });
  // Clicking a day cell in the timesheet (admin only) opens the status picker.
  el.reportTable.addEventListener("click", (e) => {
    if (!state.canEditStatus) return;
    const td = e.target.closest("td[data-day]");
    if (!td || !td.closest("tbody")) return;
    openStatusMenu(td.dataset.day, td.dataset.owner);
  });
  el.statusOptions.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-status]");
    if (!btn || !statusCtx) return;
    const { key, ownerId } = statusCtx;
    el.statusModal.close();
    setDayStatus(key, ownerId, btn.dataset.status);
  });
  el.statusClear.addEventListener("click", () => {
    if (!statusCtx) return;
    const { key, ownerId } = statusCtx;
    el.statusModal.close();
    setDayStatus(key, ownerId, "");
  });
  el.statusClose.addEventListener("click", () => el.statusModal.close());
  // ----- Предупреждение о пересечении клиентов в маршрутах -----
  // Модалка подтверждения с кнопками «Продолжить»/«Отменить» вместо нативного
  // confirm(). Возвращает Promise<boolean>: true — продолжить (разрешить дубль).
  let routeConfirmResolver = null;
  function confirmRouteIntersection(lines) {
    if (el.routeConfirmText) {
      el.routeConfirmText.innerHTML = lines.map((l) =>
        `<div class="route-confirm-line">${escapeHtml(l)}</div>`
      ).join("");
    }
    if (el.routeConfirmModal) el.routeConfirmModal.showModal();
    return new Promise((resolve) => {
      routeConfirmResolver = resolve;
    });
  }
  function resolveRouteConfirm(ok) {
    if (el.routeConfirmModal && el.routeConfirmModal.open) el.routeConfirmModal.close();
    if (routeConfirmResolver) {
      const r = routeConfirmResolver;
      routeConfirmResolver = null;
      r(ok);
    }
  }
  el.routeConfirmOk.addEventListener("click", () => resolveRouteConfirm(true));
  el.routeConfirmCancel.addEventListener("click", () => resolveRouteConfirm(false));
  el.routeConfirmClose.addEventListener("click", () => resolveRouteConfirm(false));
  el.routeConfirmModal.addEventListener("cancel", (e) => {
    e.preventDefault();
    resolveRouteConfirm(false);
  });
  // ----- Выбор причины переноса точки (модалка с плитками) -----
  if (el.postponeTiles) {
    el.postponeTiles.addEventListener("click", (e) => {
      const tile = e.target.closest(".postpone-tile");
      if (!tile || !postponeCtx) return;
      const routeId = postponeCtx;
      const reason = tile.dataset.reason || "";
      postponeCtx = null;
      el.postponeModal.close();
      postponeAction(routeId, reason);
    });
  }
  if (el.postponeClose) {
    el.postponeClose.addEventListener("click", () => {
      postponeCtx = null;
      el.postponeModal.close();
    });
  }
  if (el.postponeModal) {
    el.postponeModal.addEventListener("cancel", (e) => {
      e.preventDefault();
      postponeCtx = null;
      el.postponeModal.close();
    });
  }
  // ----- Актная запись: показываем, кем сервер видит вошедшего -----
  function openAccountModal() {
    const d = (state.me && state.me.diag) || {};
    el.acctName.textContent = state.me ? (state.me.name || "—") : "—";
    el.acctId.textContent = d.id != null ? String(d.id) : "—";
    el.acctIdKind.textContent = d.idKind ? String(d.idKind) : "—";
    const roleLabel = d.role === "ADMIN" ? "ADMIN (администратор)" : d.role === "MEMBER" ? "MEMBER (сотрудник)" : String(d.role || "—");
    el.acctRole.textContent = roleLabel;
    el.acctAdmin.textContent = d.isAdmin ? "Да" : "Нет";
    el.acctAdmin.style.color = d.isAdmin ? "var(--ok, #16a34a)" : "var(--danger, #dc2626)";
    if (d.reason) {
      el.acctReason.hidden = false;
      el.acctReason.textContent = d.reason;
    } else {
      el.acctReason.hidden = true;
    }
    el.accountModal.showModal();
  }
  el.userChip.addEventListener("click", openAccountModal);
  el.accountClose.addEventListener("click", () => el.accountModal.close());
  el.adminTabs.querySelectorAll(".atab").forEach((t) => {
    t.addEventListener("click", () => switchAdminSub(t.dataset.sub));
  });
  el.tabs.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });

  // ---- Автопроверка обновления Android-APK ----
  // Веб-интерфейс ходит через сессию шлюза, поэтому /api/app/update-info отвечает
  // ему корректно (в отличие от нативного HttpURLConnection без сессии). Сравниваем
  // установленную версию (передаёт нативный мост AndroidBridge.getVersionCode) с
  // версией на сервере и показываем окно «Доступно обновление», если сервер новее.
  function installedVersionCode() {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.getVersionCode === "function") {
        const vc = window.AndroidBridge.getVersionCode();
        if (typeof vc === "number" && vc > 0) return vc;
      }
    } catch { /* нет нативного моста (обычный браузер/десктоп) */ }
    return null;
  }

  function checkForAppUpdate() {
    const installed = installedVersionCode();
    // Показываем только внутри APK, где есть версия устройства.
    if (installed == null) return;
    api("/api/app/update-info")
      .then((info) => {
        if (!info || !info.ok) return;
        if (!(info.versionCode > installed)) return; // версия на сервере не новее
        const vn = info.versionName ? ` (${info.versionName})` : "";
        el.updateText.textContent =
          "Доступна версия " + info.versionCode + vn +
          ". Текущая установленная — " + installed + "." +
          (info.notes ? "\n\n" + info.notes : "");
        el.updateDownload.onclick = () => {
          // Внутри Android-APK установку выполняет НАТИВНЫЙ код через мост
          // AndroidBridge.updateApp: он запускает системный установщик, а не
          // открывает ссылку на APK (window.open в WebView не умеет ставить APK —
          // окно «закрывается» и обновления не происходит).
          if (window.AndroidBridge && typeof window.AndroidBridge.updateApp === "function") {
            try {
              window.AndroidBridge.updateApp(
                Number(info.versionCode) || 0,
                String(info.versionName || ""),
                String(info.apkUrl || ""),
                String(info.notes || "")
              );
            } catch (e) {
              toast("Не удалось запустить установку. Попробуйте ещё раз.");
            }
            el.updateModal.close();
            return;
          }
          // Вне APK (обычный браузер/десктоп) — просто открываем ссылку на APK.
          if (info.apkUrl) {
            try { window.open(info.apkUrl, "_blank"); } catch { location.href = info.apkUrl; }
          }
          el.updateModal.close();
        };
        try { el.updateModal.showModal(); } catch { /* уже открыта модалка */ }
      })
      .catch(() => { /* нет сети — тихо пропускаем */ });
  }

  // Кнопки окна обновления.
  if (el.updateClose) el.updateClose.addEventListener("click", () => el.updateModal.close());
  if (el.updateLater) el.updateLater.addEventListener("click", () => el.updateModal.close());

  // ---- Номер версии приложения (бейдж в шапке) ----
  // Показываем актуальную версию из /api/app/update-info (единый источник —
  // version.json). Тихо скрываем бейдж, если сервер пока не ответил.
  function showAppVersion() {
    const badge = el.appVersion;
    if (!badge) return;
    api("/api/app/update-info")
      .then((info) => {
        const vn = info && info.versionName;
        if (!vn) return;
        badge.innerHTML =
          '<span class="app-version-dot"></span>Версия ' +
          String(vn).replace(/<[^>]*>/g, "");
        badge.hidden = false;
      })
      .catch(() => { /* нет сети — версию не показываем */ });
  }

  // ------------- Init -------------
  (async function init() {
    try {
      await loadState();
    } catch (e) {
      el.startBtn.disabled = true;
      el.finishBtn.disabled = true;
      el.statusText.textContent = e && e.status === 403 ? "Доступ в приложение закрыт администратором" : "Ошибка загрузки";
      state.phase = "idle";
      return;
    }

    // The employee is identified automatically from the platform session — show
    // who is signed in so the auto login is visible and unambiguous.
    if (state.me && state.me.name) {
      el.userName.textContent = state.me.name;
      const initials = state.me.name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
      el.userAvatar.textContent = initials || "?";
      el.userChip.hidden = false;
    }

    // Show/hide the admin gear based on the real role from the server.
    el.settingsBtn.classList.toggle("hidden", !(state.isAdmin || state.isModerator));
    // A moderator may edit only their own group members' days: hide the admin-only
    // tabs so they cannot reach other management sections. The "Журнал" tab is the
    // exception — a moderator can open it to audit their group members (-only view).
    const adminOnlySubs = ["groups", "salaries", "settings", "admins"];
    el.adminTabs.querySelectorAll(".atab").forEach((t) => {
      let visible;
      if (t.dataset.sub === "log") visible = state.isAdmin || state.isModerator;
      else if (adminOnlySubs.includes(t.dataset.sub)) visible = state.isAdmin;
      else visible = true;
      t.classList.toggle("hidden", !visible);
    });
    // The "Отчёт" tab is visible to admins and moderators.
    el.tabs.querySelectorAll(".tab.admin-only").forEach((t) =>
      t.classList.toggle("admin-visible", state.isAdmin || state.isModerator)
    );
    // Show/hide the feature tabs (Мои маршруты / Маршрутизация) reactively.
    refreshNavTabs();
    // Восстанавливаем вкладку, на которой пользователь был до перезагрузки
    // (если сохранённая вкладка доступна его роли — switchTab сам уведёт на
    // «Зарплату»/доступную, если нет).
    try {
      const savedTab = localStorage.getItem("biotime_active_tab");
      if (savedTab) switchTab(savedTab);
    } catch { /* ignore */ }
    render();
    // Автообновление Android-APK: веб (со сессией) опрашивает сервер и, если там
    // версия выше установленной, показывает окно обновления.
    showAppVersion();
    checkForAppUpdate();
    // Фоновая предзагрузка Яндекс.Карт для администраторов/модераторов: тяжёлый
    // JS API (~сотни КБ) грузится заранее, в фоне, чтобы при первом открытии
    // вкладки «Трекинг» карта появилась сразу, а не висело «Загрузка карты…»
    // на глазах у пользователя. Повторный вызов loadYandexMaps из loadDriverMap
    // просто вернёт уже загруженный API — дублирующей загрузки не будет.
    if (state.isAdmin || state.isModerator) {
      // Запускаем предзагрузку через requestIdleCallback (или отложенно) — не
      // блокируя первые секунды работы, когда идёт стартовый рендер. Тяжёлый JS
      // Яндекс.Карт (~сотни КБ) в момент запуска на слабом телефоне ощутимо
      // тормозил приложение.
      const idleArg =
        (window.requestIdleCallback
          ? (cb) => window.requestIdleCallback(cb, { timeout: 6000 })
          : (cb) => setTimeout(cb, 6000));
      idleArg(() => {
        api("/api/maps/config")
          .then((cfg) => { if (cfg && cfg.yandexKey) loadYandexMaps(cfg.yandexKey).catch(() => {}); })
          .catch(() => {});
      });
    }
    // Водитель передаёт свои координаты для живой карты администратора.
    if (state.me && state.me.isDriver) startLocationReporting();

    // Poll the server in the background so edits made elsewhere (by an admin in
    // "Дни сотрудников", or on another device) reach this timer live, no reload.
    setInterval(pollState, 8000);

    // Live ticking counter for the "Таймер" page. The worked/overtime figures are
    // recomputed from an open segment's `start` against Date.now(), so a 1s tick
    // keeps the visible counter moving and makes it jump to the correct value the
    // moment the page is shown again after being collapsed/focused — without
    // waiting for the 8s pollState round-trip. This is what employees experience
    // as "отработанное время перестало считаться при свёртывании": the counter
    // was only repainted inside pollState, which browsers throttle in a
    // background/collapsed tab.
    setInterval(() => { if (!el.pageTimer.hidden) render(); }, 1000);

    // Periodically re-save the open segment while it runs. A saved open session is
    // what lets the timer survive a page reload and a tab collapse (the worked time
    // is recomputed from `start` on the next open). Relying only on the initial
    // `saveDay` after "Начать работу" and on `persistOnUnload` is fragile on mobile,
    // where `pagehide`/`beforeunload` often never fires when the app is killed, so
    // the open segment may be missing from the server after an abrupt close.
    setInterval(() => {
      if (document.hidden) return;            // collapsed — the local state still holds it
      if (!openSegment()) return;
      api("/api/day", {
        method: "POST",
        body: JSON.stringify({ key: state.dayKey, segments: state.segments }),
      }).catch(() => {});
    }, 60000);

    // Online presence: ping the server regularly so the admin / moderator "В эфире"
    // tab can show who is online right now.
    const sendHeartbeat = () => api("/api/heartbeat", { method: "POST", body: "{}" }).catch(() => {});
    sendHeartbeat();
    setInterval(sendHeartbeat, 20000);
    // In a background/collapsed tab or on a phone with the screen off, browsers
    // throttle setInterval (sometimes to <1/min), so the heartbeat can lapse and the
    // employee blinks off the "В эфире" list even though they are online. Send an
    // extra heartbeat the moment the tab becomes visible/focused again so presence
    // recovers immediately.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        // The tab went to the background: persist the live open session so a running
        // timer is known to the server (it keeps running even while the window is
        // collapsed) and survives the next sync without resetting.
        if (openSegment()) persistOnUnload();
      } else {
        // Coming back: repaint the counter immediately from the local state (cheap,
        // no network wait) so a long-collapsed timer visibly jumps to the correct
        // figure right away, then resume heartbeat/polling.
        refreshToday();
        render();
        sendHeartbeat();
      }
    });
    window.addEventListener("focus", sendHeartbeat);
    // Индикатор связи: кнопка «Проверить» и браузерные события online/offline.
    // Баннер снимается сразу, как только запрос снова доходит — водитель видит
    // явное состояние «нет связи с сервером» (в т.ч. когда VPN блокирует доступ
    // к домену приложения), а не молчаливо зависшее приложение.
    if (el.netRetry) {
      el.netRetry.addEventListener("click", async () => {
        hideNetBanner();
        try { await loadState(); render(); } catch { /* связь не восстановилась — баннер останется */ }
      });
    }
    window.addEventListener("online", () => {
      hideNetBanner();
      loadState().catch(() => {});
    });
    window.addEventListener("offline", () => {
      showNetBanner("Нет подключения к интернету. Проверьте сеть и отключите VPN, если он блокирует приложение.");
    });
  })();

  // Keep today's state fresh across a tab share / multi-device admin edits.
  window.addEventListener("focus", async () => {
    // Repaint immediately from the local state (reverse the "застывший счётчик"
    // effect of a collapsed tab) BEFORE the async server refresh completes, so the
    // counter does not sit frozen while the fetch is in flight or the network is slow.
    if (!state.loading) { refreshToday(); render(); }
    try {
      const hadOpen = openSegment();
      await loadState();
      // A lagging server read (fresh `/api/day` save still in flight) must not
      // freeze a live open session when the user returns to the tab. If the read
      // dropped the open segment, restore it so the timer keeps running.
      const stillOpen = hadOpen && state.segments.some(
        (sg) => sg.kind === "work" && sg.end == null && sg.id === hadOpen.id
      );
      if (hadOpen && !stillOpen) {
        state.segments.push(hadOpen);
        state.phase = "working";
      }
      render();
    } catch { /* ignore */ }
  });

  // Persist the live open session when the tab is hidden or closed, so a timer
  // started (or resumed) right before closing still reaches the server and does
  // not "слеть" on the next open. `keepalive` lets the POST finish even after the
  // page has unloaded.
  const persistOnUnload = () => {
    if (!openSegment()) return;
    try {
      api("/api/day", {
        method: "POST",
        body: JSON.stringify({ key: state.dayKey, segments: state.segments }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* ignore */ }
  };
  window.addEventListener("pagehide", persistOnUnload);
  window.addEventListener("beforeunload", persistOnUnload);
})();
