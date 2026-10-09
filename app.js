(() => {
  "use strict";

  // Слабый WebView/ТСД (APK на Android): включаем режим low-motion — отключаем
  // тяжёлые CSS-переходы и анимации. При частых перерисовках (опросы каждые
  // 5–10 с, секундные таймеры) это заметно снижает нагрузку на слабый CPU.
  try {
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
    if (typeof window !== "undefined" &&
        (window.AndroidBridge || /Android/i.test(ua))) {
      document.documentElement.classList.add("low-motion");
    }
  } catch (_) { /* не критично */ }

  // UI-only preference keeps living in localStorage (per browser). Everything else is server-side.
  const COLLAPSE_KEY = "biotime.collapsed";
  const FINISH_KEY = "biotime.finishKey";
  // Кэш стартового состояния для офлайн-старта (см. cacheStateSnapshot /
  // loadStateCache): если приложение открылось без сети и /api/state недоступен,
  // кнопка «Начать» не блокируется — восстанавливаем последний удачный снимок.
  const STATE_CACHE_KEY = "biotime.stateCache";
  const CAL_START = { year: 2026, month: 8 }; // сентябрь 2026 (month 0-based)

  // ---- State (server-backed) ----
  const state = {
    me: null,          // { id, name, role, isAdmin }
    isAdmin: false,
    isModerator: false,
    canEditStatus: false,
    canManageShipment: false,
    canSeeShipment: false, // серверный флаг доступа к разделу «Отгрузка»
    isLoader: false,       // роль «Погрузка»: видит только вкладку «Отгрузка»
    staff: [],         // [{ id, name, salary|null }]
    groups: [],        // [{ id, name, memberIds, moderatorId }]
    days: {},          // { "<YYYY-MM-DD>": { ownerId, segments } }
    log: [],           // [{ ts, action, ownerId }]
    admins: [],        // [id,...]
    blocked: [],       // [{ id, name, at }] — вход в приложение закрыт администратором
    params: { showOverHours: true, showOverSum: true, showDrivers: false, adminSeeRoutes: false, driverSeeRoutes: false, showShipment: false, shipmentGroups: [], allowDriverStartWithoutShipment: false, allowFinishUnloadIncomplete: false, allowDriverReorderPoints: false, allowWaybill: false, routeDeleteCode: "", scanLogLimit: 30000, multiplier: 1, multFrom: null, multTo: null, multGroups: [], multRules: [], updateVersionCode: null, updateVersionName: "", updateApkUrl: "", updateNotes: "" },
    norm: 9,
    phase: "idle",     // idle | working | paused | finished
    segments: [],      // today's segments
    dayKey: null,
    // День, который сотрудник явно завершил («Завершить работу»). Персистится в
    // localStorage: если завершение не успело уйти на сервер (нет сети) и страница
    // перезагрузится, флаг не потеряется — таймер не «оживёт» и не будет
    // автозакрыт в неверный момент (см. refreshToday).
    finishKey: (() => {
      try { return localStorage.getItem(FINISH_KEY) || null; } catch { return null; }
    })(),
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

  // Снимок стартового состояния для офлайн-старта. Сохраняется при каждом
  // УСПЕШНОМ loadState(). Если при последующем открытии сети нет — init()
  // восстанавливает этот снимок (applyStateCache), и кнопка «Начать» не
  // блокируется: водитель начинает день, а saveDay уходит в офлайн-очередь.
  function cacheStateSnapshot() {
    try {
      localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({
        me: state.me || null,
        isAdmin: state.isAdmin,
        isModerator: state.isModerator,
        isDriver: state.isDriver,
        isLoader: state.isLoader,
        canEditStatus: state.canEditStatus,
        canManageShipment: state.canManageShipment,
        canSeeShipment: state.canSeeShipment,
        staff: state.staff || [],
        groups: state.groups || [],
        params: state.params || {},
        norm: state.norm,
        serverOffsetMin: state.serverOffsetMin,
        phase: state.phase,
        dayKey: state.dayKey,
        segments: state.segments || [],
        finishKey: state.finishKey || null,
      }));
    } catch { /* приватный режим / переполнение — офлайн-старт просто недоступен */ }
  }

  function loadStateCache() {
    try {
      const raw = localStorage.getItem(STATE_CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      return (c && c.me) ? c : null;
    } catch {
      return null;
    }
  }

  // Применяет кэшированный снимок к state (офлайн-старт). Рабочий день
  // восстанавливается, только если кэш относится к СЕГОДНЯ и сегменты не
  // завершены; иначе — чистый «idle», чтобы можно было начать сегодня заново.
  function applyStateCache(c) {
    state.me = c.me || null;
    state.isAdmin = !!c.isAdmin;
    state.isModerator = !!c.isModerator;
    state.isDriver = !!c.isDriver;
    state.isLoader = !!c.isLoader;
    state.canEditStatus = !!c.canEditStatus;
    state.canManageShipment = !!c.canManageShipment;
    state.canSeeShipment = !!c.canSeeShipment;
    state.staff = Array.isArray(c.staff) ? c.staff : [];
    state.groups = Array.isArray(c.groups) ? c.groups : [];
    state.params = c.params && typeof c.params === "object" ? c.params : state.params;
    state.norm = Number.isFinite(Number(c.norm)) ? Number(c.norm) : state.norm;
    state.serverOffsetMin = Number.isFinite(Number(c.serverOffsetMin)) ? Number(c.serverOffsetMin) : -new Date().getTimezoneOffset();
    state.finishKey = c.finishKey || null;
    const today = dayKeyOf(Date.now());
    state.dayKey = today;
    if (c.phase === "working" && c.dayKey === today && Array.isArray(c.segments) && c.segments.length) {
      // Был открытый рабочий таймер — продолжаем его офлайн (не заново).
      state.segments = c.segments.slice();
      state.phase = "working";
    } else {
      state.segments = [];
      state.phase = "idle";
    }
    state.loading = false;
  }

  // Локальный кэш ОТКРЫТОГО (идущего) таймера. Водитель на APK сворачивает окно,
  // выключает экран или теряет интернет — сервер может не успеть узнать об
  // открытом сегменте, и при возврате таймер «обнулялся». Записываем начало дня
  // в localStorage при «Начать работу» и восстанавливаем при старте, если сервер
  // не вернул открытый сегмент.
  const OPEN_SEG_KEY = "biotime.openSeg";
  function writeOpenSegCache() {
    try {
      const seg = openSegment();
      if (seg && (state.phase === "working" || state.phase === "paused")) {
        localStorage.setItem(OPEN_SEG_KEY, JSON.stringify({ id: seg.id, start: seg.start, kind: seg.kind || "work" }));
      } else {
        localStorage.removeItem(OPEN_SEG_KEY);
      }
    } catch { /* приватный режим — просто без кэша */ }
  }
  function restoreOpenSegCache() {
    try {
      const raw = localStorage.getItem(OPEN_SEG_KEY);
      if (!raw) return;
      const c = JSON.parse(raw);
      if (!c || !c.start) { localStorage.removeItem(OPEN_SEG_KEY); return; }
      if (state.finishKey === state.dayKey) { localStorage.removeItem(OPEN_SEG_KEY); return; } // день завершён
      if (openSegment()) return; // сервер уже дал открытый — кэш не нужен
      const seg = { id: String(c.id || "open"), start: Number(c.start), kind: c.kind === "break" ? "break" : "work", end: null, internal: true };
      state.segments.push(seg);
      state.phase = "working";
    } catch { /* ignore */ }
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
      // Таймаут сетевого вызова: без него при потере связи fetch в мобильном
      // WebView/браузере может «висеть» десятки секунд (DNS/сокет/VPN), и кнопка
      // водителя (например, «Прибыл на адрес») кажется неактивной — нажатие
      // «замирает» и не даёт ни очереди, ни отклика. С таймаутом ~8 с вызов
      // падает быстро, действие тут же уходит в офлайн-очередь, а водитель сразу
      // видит «Нет связи — действие сохранено». При живой сети этого не видно:
      // API приложения отвечает за доли секунды (портал не опрашивается в
      // обработчике посетителя — только в фоне).
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      try {
        res = await fetch(path, {
          headers: { "Content-Type": "application/json" },
          ...opts,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(t);
      }
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

  // ================= Офлайн-очередь действий водителя =================
  // Когда у ТСД/телефона нет сети (или она потерялась), водитель всё равно
  // может нажимать кнопки маршрута (прибыл на адрес, сдача, перенос, выгрузка,
  // старт, на базу) и сканировать места. Действия не теряются: каждое
  // складывается в локальную очередь (localStorage WebView — переживает
  // перезапуск), а как только связь восстанавливается — автоматически
  // отправляется на сервер в исходном порядке, с реальным временем нажатия.
  const OFFLINE_KEY = "biotime.offlineOps";

  // Нативный дубль офлайн-очереди (Android WebView).
  // Веб хранит очередь в localStorage, а дополнительно дублирует её JSON в
  // нативный файл через AndroidBridge (см. MainActivity.kt, offlineOpsSave).
  // Это страховка от ситуации, когда система очищает localStorage при
  // принудительном kill/перезагрузке телефона: после рестарта очередь
  // восстанавливается из нативного файла, а не теряется.
  const nativeSupportsOffline = typeof AndroidBridge !== "undefined" &&
    typeof AndroidBridge.offlineOpsSave === "function" &&
    typeof AndroidBridge.offlineOpsLoad === "function" &&
    typeof AndroidBridge.offlineOpsClear === "function";

  // Дублирует очередь в нативный слой. Безопасно: сбой моста не прерывает
  // основную (localStorage) запись.
  function nativeOfflineOpsSave(ops) {
    if (!nativeSupportsOffline) return;
    try { AndroidBridge.offlineOpsSave(JSON.stringify(ops)); } catch (_) { /* не критично */ }
  }

  // Восстанавливает очередь из нативного дубля, если localStorage пуст/повреждён.
  function hydrateOfflineFromNative() {
    if (!nativeSupportsOffline) return false;
    try {
      const raw = AndroidBridge.offlineOpsLoad();
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return false;
      try { localStorage.setItem(OFFLINE_KEY, JSON.stringify(parsed)); } catch { /* ignore */ }
      return true;
    } catch { return false; }
  }

  function readOfflineOps() {
    try {
      const raw = JSON.parse(localStorage.getItem(OFFLINE_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function writeOfflineOps(ops) {
    try {
      localStorage.setItem(OFFLINE_KEY, JSON.stringify(ops));
      nativeOfflineOpsSave(ops);
      return true;
    } catch {
      // Переполнение / приватный режим / диск недоступен. Возвращаем false,
      // чтобы вызывающий код знал о проблеме и не считал данные сохранёнными.
      // Даже если localStorage переполнен — пробуем хотя бы нативный дубль.
      nativeOfflineOpsSave(ops);
      return false;
    }
  }
  function offlineOpId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }
  function enqueueOfflineOp(op) {
    const ops = readOfflineOps();
    ops.push(op);
    writeOfflineOps(ops);
    updateOfflineBadge(ops.length);
    return op;
  }
  function removeOfflineOp(id) {
    const ops = readOfflineOps().filter((o) => o.id !== id);
    writeOfflineOps(ops);
    updateOfflineBadge(ops.length);
  }
  // Сетевая ошибка (сервер/шлюз недоступны) в отличие от HTTP-ошибки сервера.
  function isOfflineError(e) {
    return (e && e.status === 0) || (typeof navigator !== "undefined" && navigator.onLine === false);
  }

  // Временная ошибка отправки: действие НЕЛЬЗЯ удалять из очереди — оно должно
  // повториться позже. Это не «сервер отклонил действие», а «сервер не смог
  // принять его прямо сейчас»: истёкшая сессия шлюза (401), лимит запросов (429),
  // неготовый/просыпающийся инстанс (5xx, BH_SERVER_WAKING), обрыв соединения
  // на середине ответа (таймаут). Удаление в таких случаях — потеря действия,
  // из-за которой водитель «нажал — а всё слетело» после восстановления сети.
  function isTransientError(e) {
    if (!e || typeof e !== "object") return false;
    const status = e.status;
    const code = String(e.code || "");
    if (status === 0) return true; // сетевой обрыв (страховочно)
    // 408 (Request Timeout), 429 (Too Many Requests), 5xx — сервер не готов.
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
    // 401/403 — сессия шлюза не подтверждена (часто после пересоздания WebView);
    // это временное состояние, нужен вход, а не потеря действия.
    if (status === 401 || status === 403) return true;
    // Платформенные коды пробуждения/входа — временные.
    if (/BH_SERVER_WAKING|SERVER_WAKING|WAKING|BH_LOGIN_REQUIRED|LOGIN_REQUIRED/i.test(code)) return true;
    return false;
  }

  // Индикатор очереди внизу/вверху интерфейса. Показывает «Нет связи — N действий
  // в очереди, отправятся автоматически». Скрывается, когда очередь пуста.
  let offlineBadgeEl = null;
  function ensureOfflineBadge() {
    if (offlineBadgeEl) return offlineBadgeEl;
    let b = document.getElementById("offlineOpsBadge");
    if (!b) {
      b = document.createElement("div");
      b.id = "offlineOpsBadge";
      b.style.cssText =
        "position:fixed;left:12px;right:12px;bottom:14px;z-index:9000;" +
        "background:#3a3310;color:#ffd76a;border:1px solid #6b5c1e;border-radius:10px;" +
        "padding:10px 12px;font:13px/1.4 inherit;text-align:center;display:none;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.45);";
      document.body.appendChild(b);
    }
    offlineBadgeEl = b;
    return b;
  }
  function showOfflineBadge(n) {
    const b = ensureOfflineBadge();
    const label = n === 1 ? "1 действие в очереди" : `${n} действий в очереди`;
    b.textContent = "Нет связи — " + label + ". Данные сохранены и отправятся автоматически, когда связь появится.";
    b.style.display = "block";
  }
  function hideOfflineBadge() {
    if (offlineBadgeEl) offlineBadgeEl.style.display = "none";
  }
  function updateOfflineBadge(n) {
    if (n > 0) showOfflineBadge(n); else hideOfflineBadge();
  }

  // ================== Локальный кэш «Моих маршрутов» ==================
  // Данные маршрутов водителя персистятся в localStorage, чтобы в зоне без
  // интернета (офлайн-старт приложения или потеря связи после открытия) водитель
  // ВСЁ РАВНО видел свой маршрут и точки и мог нажимать кнопки («Прибыл»,
  // «Сдача», «Перенос», «На базу»). Сами нажатия уже ставятся в офлайн-очередь
  // и автосинхронизируются при появлении сети; кэш лишь поднимает картинку.
  // Кэш привязан к пользователю: на переиспользуемом устройстве чужой водитель
  // чужие маршруты не увидит.
  const ROUTES_CACHE_PREFIX = "biotime.myRoutesCache.";
  function myRoutesCacheKey() {
    const uid = state && state.me && state.me.id;
    return ROUTES_CACHE_PREFIX + (uid != null ? String(uid) : "anon");
  }
  function persistMyRoutes() {
    if (!Array.isArray(myRoutesCache)) return;
    try {
      const data = {
        savedForUserId: (state && state.me && state.me.id) != null ? state.me.id : null,
        savedAt: Date.now(),
        routes: myRoutesCache,
      };
      localStorage.setItem(myRoutesCacheKey(), JSON.stringify(data));
    } catch { /* переполнение/приватный режим */ }
  }
  // Читает кэш из localStorage и возвращает массив маршрутов, если он валиден и
  // принадлежит текущему пользователю. При несовпадении/повреждении — null.
  function hydrateMyRoutes() {
    try {
      const raw = JSON.parse(localStorage.getItem(myRoutesCacheKey()));
      if (!raw || !Array.isArray(raw.routes)) return null;
      const uid = state && state.me && state.me.id;
      // Если мы ещё не знаем пользователя (loadState не дошёл), отдаём как есть:
      // почти всегда это тот же водитель на своём устройстве. Если знаем и он
      // не совпал — не отдаём чужие маршруты.
      if (uid != null && raw.savedForUserId != null && String(uid) !== String(raw.savedForUserId)) {
        return null;
      }
      return raw.routes;
    } catch { return null; }
  }

  // Оптимистичное применение действия к локальному кэшу маршрута: без сети
  // переключаем стадию текущей точки, чтобы водитель видел результат сразу.
  // Это лишь временная картинка — после успешной отправки очереди приходит
  // реальный ответ сервера (с учётом связок/групп) и перерисовывается точно.
  function applyOptimisticRoute(routeId, action, payload) {
    if (!Array.isArray(myRoutesCache)) return;
    const route = myRoutesCache.find((r) => String(r.id) === String(routeId));
    if (!route || !Array.isArray(route.clients)) return;
    const byState = (s) => route.clients.findIndex((c) => (c.state || "pending") === s);
    const activeIdx = byState("in_transit") >= 0 ? byState("in_transit") : byState("on_site");
    const setNextInTransit = () => {
      const ni = byState("pending");
      if (ni >= 0) {
        route.clients[ni].state = "in_transit";
        route.clients[ni].transitStart = route.clients[ni].transitStart || Date.now();
      }
    };
    if (action === "start") {
      if (route.progress) route.progress.status = "active";
      setNextInTransit();
    } else if (action === "arrive") {
      if (activeIdx < 0 || route.clients[activeIdx].state !== "in_transit") return;
      route.clients[activeIdx].state = "on_site";
      route.clients[activeIdx].siteStart = route.clients[activeIdx].siteStart || Date.now();
    } else if (action === "deliver") {
      if (activeIdx < 0 || route.clients[activeIdx].state !== "on_site") return;
      route.clients[activeIdx].state = "delivered";
      route.clients[activeIdx].siteEnd = route.clients[activeIdx].siteEnd || Date.now();
      setNextInTransit();
    } else if (action === "postpone") {
      if (activeIdx < 0 || route.clients[activeIdx].state !== "on_site") return;
      route.clients[activeIdx].state = "postponed";
      route.clients[activeIdx].postponeReason = (payload && payload.postponeReason) || route.clients[activeIdx].postponeReason || "Перенесено без сети";
      route.clients[activeIdx].siteEnd = route.clients[activeIdx].siteEnd || Date.now();
      setNextInTransit();
    } else if (action === "finish_unload") {
      if (activeIdx < 0) return;
      route.clients[activeIdx].unloadFinished = true;
    } else if (action === "arrive_base") {
      if (route.progress) route.progress.status = "done";
    } else {
      return;
    }
    route._offlinePending = (Number(route._offlinePending) || 0) + 1;
    // Оптимистичная смена стадии сохраняется в localStorage: если водитель
    // применил действие офлайн и закрыл приложение до синхронизации очереди,
    // после рестарта точка не «откатится» к старому состоянию.
    persistMyRoutes();
  }

  // Отправляет накопленную очередь на сервер последовательно (важен порядок
  // действий) и в исходном порядке. При успехе действие уходит из очереди; при
  // потере сети снова — останавливаемся; при серверной ошибке (устарел/конфликт)
  // — убираем из очереди, чтобы не зациклиться, и сообщаем.
  async function flushOfflineOps() {
    let ops = readOfflineOps();
    if (!ops.length) { hideOfflineBadge(); return; }
    // НЕ блокируемся по navigator.onLine: в мобильном WebView/браузере это поле
    // и событие online часто запаздывают (сеть вернулась, а onLine ещё false).
    // Если мы останавливаемся на этой проверке, периодический тик (20 с) каждые
    // 20 секунд «видит» нет сети и НИКОГДА не пробует отправить — данные уходят
    // только после перезапуска, когда onLine пересчитывается в true. Вместо
    // этого всегда пробуем реальную отправку: если сети и правда нет, fetch
    // упадёт быстро, isOfflineError вернёт управление, действия останутся в
    // очереди и бейдж останется. Если сеть есть (даже при устаревшем onLine) —
    // данные уйдут сразу, без перезапуска.
    updateOfflineBadge(ops.length);
    for (const op of ops) {
      try {
        if (op.kind === "save_day") {
          // Завершение рабочего дня, отправленное в офлайн-очередь при потере сети:
          // доставляем закрытое состояние дня (сегменты с заданным end), чтобы таймер
          // не остался открытым на сервере и не был автозакрыт в неверный момент.
          await api("/api/day", {
            method: "POST",
            body: JSON.stringify({
              key: op.dayKey,
              segments: Array.isArray(op.segments) ? op.segments : [],
              // Завершение, отложенное в офлайн-очередь, несёт флаг finish —
              // доставляем его, иначе сервер мог бы счесть время прихода сети
              // «открытым» и не закрыть день (см. POST /api/day).
              ...(op.finish ? { finish: true, finishTime: op.finishTime } : {}),
              clientTime: op.clientTime,
            }),
          });
        } else if (op.kind === "scan") {
          await api("/api/labels/scan", {
            method: "POST",
            body: JSON.stringify({
              code: op.payload && op.payload.code,
              action: "unload",
              clientTime: op.clientTime,
            }),
          });
        } else {
          await api("/api/drivers/routes/action", {
            method: "POST",
            body: JSON.stringify({
              routeId: op.routeId,
              action: op.action,
              ...(op.payload || {}),
              clientTime: op.clientTime,
            }),
          });
        }
        removeOfflineOp(op.id);
      } catch (e) {
        if (isOfflineError(e) || isTransientError(e)) {
          // Сеть пропала ИЛИ сервер/сессия временно не готовы — действие НЕ
          // удаляем, оно повторится при следующей попытке (online-событие, старт,
          // периодический flush). Очередь уже на диске в localStorage — переживёт
          // сворачивание и перезапуск.
          showOfflineBadge(readOfflineOps().length);
          return;
        }
        // Постоянная ошибка сервера (сервер явно отклонил действие: 400/422/409 —
        // устаревшее состояние, невалидный payload). Не удаляем сразу — даём
        // несколько попыток (возможно, сервер ещё «дожимает» предыдущее действие
        // очереди, и состояние скоро станет валидным), и только после лимита
        // убираем, чтобы не крутить вечно.
        const attempts = (Number(op.attempts) || 0) + 1;
        op.attempts = attempts;
        try {
          const cur = readOfflineOps();
          const idx = cur.findIndex((x) => x.id === op.id);
          if (idx >= 0) { cur[idx].attempts = attempts; writeOfflineOps(cur); }
        } catch (_) { /* не критично */ }
        if (attempts >= 4) {
          removeOfflineOp(op.id);
          const msg = (e && (e.error || e.message)) || "Действие из офлайн-очереди отклонено сервером";
          toast(msg);
        } else {
          showOfflineBadge(readOfflineOps().length);
          return;
        }
      }
    }
    // Очередь отправлена — перерисовываем маршруты из актуального состояния.
    if (ops.length && Array.isArray(myRoutesCache)) {
      try { await loadMyRoutes(true); } catch (_) { /* сеть вновь пропала — не критично */ }
      renderMyRoutesList(myRoutesCache);
    }
    updateOfflineBadge(readOfflineOps().length);
    // Если очередь полностью отправлена — стираем нативный дубль, чтобы он не
    // «воскрес» обратно в localStorage при следующем старте (мы уже отдали всё).
    if (!readOfflineOps().length && nativeSupportsOffline) {
      try { AndroidBridge.offlineOpsClear(); } catch (_) { /* не критично */ }
    }
  }

  async function loadState() {
    state.loading = true;
    const s = await api("/api/state");
    state.me = s.me;
    state.isAdmin = !!s.me.isAdmin;
    updateAdminUsersVisibility && updateAdminUsersVisibility();
    state.isModerator = !!s.isModerator;
    state.isDriver = !!s.me.isDriver;
    state.isLoader = !!s.me.isLoader;
    state.canEditStatus = !!s.canEditStatus;
    state.canManageShipment = !!s.canManageShipment;
    state.canSeeLogs = !!s.canSeeLogs;
    state.canSeeReports = !!s.canSeeReports;
    state.canSeeSverki = !!s.canSeeSverki;
    state.canSeeProcenka = !!s.canSeeProcenka;
    state.canSeeParser = !!s.canSeeParser;
    // Latch: если раздел «Отгрузка» уже был доступен — держим его на этом устройстве,
    // чтобы транзиентный `false` при перезапросе состояния (напр. при нескольких
    // открытых устройствах) не прятал вкладку до перезагрузки страницы.
    state.canSeeShipment = state.canSeeShipment === true ? true : !!s.canSeeShipment;
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
    state.params = Object.assign({ showOverHours: true, showOverSum: true, showDrivers: false, adminSeeRoutes: false, driverSeeRoutes: false, showShipment: false, shipmentGroups: [], allowDriverStartWithoutShipment: false, allowFinishUnloadIncomplete: false, allowDriverReorderPoints: false, allowWaybill: false, routeDeleteCode: "", scanLogLimit: 30000, multiplier: 1, multFrom: null, multTo: null, multGroups: [], multRules: [] }, s.params || {});
    state.params.allowWaybill = true; // сборка с расходными накладными теперь всегда включена
    state.norm = (s.norm != null && s.norm >= 0 && s.norm <= 24) ? s.norm : 8;
    // Единый опорный пояс (смещение сервера от UTC в минутах). Если сервер его
    // не прислал (старая версия) — фолбэк на локальный пояс устройства.
    state.serverOffsetMin = (s.serverOffsetMinutes != null && Number.isFinite(s.serverOffsetMinutes))
      ? s.serverOffsetMinutes
      : -new Date().getTimezoneOffset();
    state.loading = false;
    refreshToday();
    // Пишем снимок для офлайн-старта (при каждом успешном чтении состояния).
    cacheStateSnapshot();
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
      // Не откатываем вручную выбранные настройки фоновым опросом, пока POST
      // /api/params не подтверждён сервером (см. paramsDirty в applyParams).
      if (s.params && !paramsDirty) state.params = Object.assign(state.params, s.params || {});
      const prevDays = JSON.stringify(state.days || {});
      const prevSegments = JSON.stringify(state.segments);
      state.days = s.days || {};
      state.salaryMonth = s.salaryMonth || {};
      state.dayKey = dayKeyOf(Date.now());
      // САМОЛЕЧЕНИЕ «завершённого» дня (актуально для APK): в localStorage может
      // остаться старый маркер «день завершён» (biotime.finishKey = сегодня) ещё со
      // старой сессии/устаревшей сборки. Он заставлял refreshToday сразу ставить
      // день finished — через веб это не видно (чистый localStorage браузера), а в
      // APK WebView «день завершался сразу при входе». Если сервер считает день НЕ
      // завершённым — устаревший finishKey убираем, чтобы день был открыт.
      if (state.finishKey === state.dayKey) {
        const e = state.days[state.dayKey] && state.days[state.dayKey].byEmployee
          && state.days[state.dayKey].byEmployee[state.me.id];
        if (!(e && e.finished)) {
          state.finishKey = null;
          try { localStorage.removeItem(FINISH_KEY); } catch { /* приватный режим */ }
        }
      }
      const serverSegs = daySegments(state.dayKey, state.me.id);
      // Protect the live running timer from a stale / lagging server copy. When the
      // user is actively working (open local segment) but the server read does not
      // yet contain an open segment — e.g. the `/api/day` save is still in flight,
      // a second tab beat us to it, or the mirror lagged — adopting the server list
      // would silently drop the open segment, flip phase to idle/finished and STOP
      // the ticking timer. Keep the locally running session instead.
      const localOpen = openSegment();
      const serverOpen = serverSegs.some((sg) => sg.kind === "work" && sg.end == null);
      // День, который пользователь реально завершил кнопкой «Завершить работу»:
      // в этом случае сервер без открытого сегмента — это НЕ отставание, а факт
      // закрытия (реегрессию не воскрешаем). finishKey ставится только явным
      // завершением (см. сохранение дня), фоновый сбой его не трогает.
      const dayFinishedLocally = state.finishKey === state.dayKey;
      // Защищаем бегущий таймер независимо от того, в какой фазе просыпается
      // приложение после свёртывания/пересоздания WebView: пока есть локальный
      // открытый сегмент и день не завершён — серверное «без открытого» не
      // регрессирует (раньше защита срабатывала только при phase working/paused,
      // и водитель на мобильном терял таймер, если фаза при сворачивании сбилась).
      // Сегмент переносим/держим, только если он относится к ТЕКУЩЕМУ дню —
      // иначе вчерашний незакрытый сегмент вёл бы к раздутому времени (см. fix в
      // refreshToday): он «ужимается» в свой день и сюда не проваливается.
      const localOpenToday = localOpen && dayKeyOf(localOpen.start) === state.dayKey;
      if (localOpenToday && !dayFinishedLocally && !serverOpen) {
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

  async function saveDay(opts) {
    // opts = { finish?: bool, finishTime?: number } — «Завершить работу».
    // Передаём серверу явный флаг завершения, чтобы он закрыл день (finished) и
    // не воскрешал висящий открытый сегмент / не давал фоновым вкладкам оживить
    // таймер (см. POST /api/day на сервере).
    const finish = !!(opts && opts.finish);
    const finishTime = (opts && Number.isFinite(opts.finishTime)) ? opts.finishTime : Date.now();
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
    try {
      await api("/api/day", {
        method: "POST",
        body: JSON.stringify({
          key: state.dayKey,
          segments: state.segments,
          ...(finish ? { finish: true, finishTime } : {}),
        }),
      });
      // Успешная доставка — если в очереди была отложенная запись этого дня, снимаем её,
      // чтобы она не перезаписала уже актуальные данные более поздним сохранением.
      const ops = readOfflineOps();
      const leftover = ops.filter((o) => !(o.kind === "save_day" && o.dayKey === state.dayKey));
      if (leftover.length !== ops.length) writeOfflineOps(leftover);
    } catch (e) {
      if (isOfflineError(e)) {
        // НЕТ СЕТИ: закрытие дня («Завершить работу») не должно теряться. Если нажать
        // «Завершить» без связи, сегменты уже закрыты в памяти (end задан), но на сервер
        // не ушли — сервер считал бы таймер открытым и автозакрыл бы его позже в неверный
        // момент (вплоть до «завершил 18:19, а записалось 02:59»). Кладём закрытое состояние
        // дня в офлайн-очередь и доставим его при появлении сети.
        enqueueOfflineOp({
          id: offlineOpId(),
          kind: "save_day",
          dayKey: state.dayKey,
          segments: state.segments.slice(),
          ...(finish ? { finish: true, finishTime } : {}),
          clientTime: Date.now(),
        });
        showOfflineBadge(readOfflineOps().length);
      } else {
        throw e; // Серверная ошибка не про сеть — пробрасываем, как и раньше.
      }
    }
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
    state.days[state.dayKey].byEmployee[state.me.id] = {
      segments: state.segments.slice(),
      finished: finish || !!(state.days[state.dayKey].byEmployee[state.me.id]
        && state.days[state.dayKey].byEmployee[state.me.id].finished),
    };
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
    let _gpsSpeedSmooth = null; // скользящее среднее GPS-скорости
    const activeRouteId = () => {
      const a = (myRoutesCache || []).find((r) => r.progress && r.progress.status === "active");
      return a ? a.id : "";
    };
    const send = (pos) => {
      const now = Date.now();
      if (now - lastSent < 15000) return;
      lastSent = now;
      const rid = activeRouteId();
      // Реальная скорость от GPS-приёмника (м/с → км/ч) + сглаживание скользящим
      // средним (эффект «варианта 3» — акселерометр-эквивалент: убирает рывки/скачки).
      let gpsSpeedKmh = (pos && pos.coords && Number.isFinite(pos.coords.speed))
        ? Math.round((pos.coords.speed * 3.6) * 10) / 10
        : null;
      if (gpsSpeedKmh != null) {
        _gpsSpeedSmooth = (_gpsSpeedSmooth == null) ? gpsSpeedKmh : Math.round(((_gpsSpeedSmooth * 0.6) + (gpsSpeedKmh * 0.4)) * 10) / 10;
        gpsSpeedKmh = _gpsSpeedSmooth;
      }
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
          speed: gpsSpeedKmh,
          // Реальное время устройства водителя + поправка (мин), заданная в настройке
          // устройства, — компенсирует рассинхрон часов ТСД/сканера.
          ts: Date.now() + deviceTimeOffsetMs(),
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
  // Поправка времени устройства (мин), заданная в профиле: компенсирует рассинхрон
  // часов ТСД/сканера — прибавляется к метке геолокации.
  function deviceTimeOffsetMs() {
    try { return (Number(localStorage.getItem("biotime_time_offset_min")) || 0) * 60000; } catch { return 0; }
  }

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
      // Важно: локальный открытый сегмент переносим в «сегодня» ТОЛЬКО если он
      // сам относится к текущему дню. Иначе вчерашний незакрытый сегмент (если
      // вчера не нажали «Завершить») «переезжал» бы в сегодняшние сегменты,
      // раздувал отработанное время (например 09:36 при реальных ~5 ч) и держал
      // таймер открытым от вчерашнего start — сервер же в «Эфире» считает по
      // факту и показывал расходящееся значение.
      if (localOpen
        && dayKeyOf(localOpen.start) === state.dayKey
        && !serverSegs.some((sg) => sg.kind === "work" && sg.end == null && sg.id === localOpen.id)) {
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
        // День завершён: шлём закрытое состояние с флагом завершения, чтобы сервер
        // пометил день finished и фоновые вкладки не смогли оживить открытый таймер.
        saveDay({ finish: true }).catch(() => {});
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
  // Значения оклада/премии/надбавки КОНКРЕТНОГО месяца (per-month): если для
  // месяца есть явная запись (state.salaryMonth) — берём её, иначе «текущее».
  // Благодаря этому правка оклада/надбавки за один месяц не переписывает другие.
  function staffPayForMonth(st, monthKey) {
    const map = state.salaryMonth && state.salaryMonth[st.id];
    const overlay = (m) => ({
      salary: (m && m.salary != null) ? m.salary : st.salary,
      bonus: (m && m.bonus != null) ? m.bonus : st.bonus,
      extraBonus: (m && m.extraBonus != null) ? m.extraBonus : st.extraBonus,
    });
    if (map) {
      if (map[monthKey]) return overlay(map[monthKey]);
      for (const mKey of Object.keys(map).sort().reverse()) {
        if (String(mKey) < String(monthKey)) return overlay(map[mKey]);
      }
    }
    // Нет записи и нет предшествующей: для ПРОШЕДШЕГО месяца не берём «текущие»
    // значения (октябрьская надбавка не должна попадать в сентябрь). Оклад — как
    // есть, премию/надбавку без явной месячной записи показываем 0.
    if (String(monthKey) < currentMonthKey()) {
      return { salary: (st && st.salary != null) ? st.salary : 50000, bonus: 0, extraBonus: 0 };
    }
    return overlay(null);
  }
  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  // Мемоизация «текущего» множителя для таймера: пересчитывается редко (смена
  // дня, правил, сотр. не выбран иначе), а зовётся на каждом тике таймера (×1с)
  // и в renderLive. Ключ — дата + сериализованный снimок правил + id сотрудника.
  let currMultKey = null;
  let currMultVal = 1;
  function currentMultiplier() {
    const now = Date.now();
    const key = dayKeyOf(now);
    const rules = state.params && state.params.multRules;
    const rulesSig = rules && rules.length ? JSON.stringify(rules) : "";
    const cacheKey = key + "|" + String(state.me && state.me.id) + "|" + rulesSig;
    if (cacheKey === currMultKey) return currMultVal;
    currMultKey = cacheKey;
    currMultVal = multiplierForDate(key, state.me && state.me.id);
    return currMultVal;
  }

  // Активен ли повышенный тариф для текущего пользователя «сегодня».
  // Используется для статус-панели (бейдж «Действует повышенный тариф ×N»).
  function multiplierActive() {
    return currentMultiplier() > 1;
  }

  // Правило множителя (мультипликатор подработки) теперь привязано к КОНКРЕТНОЙ
  // дате и временному интервалу [from, to] (HH:MM). Если дата не совпадает или
  // интервал не задан — правило НЕ применяется. Множитель ×N насчитывается
  // ТОЛЬКО на те сверхурочные часы дня, которые попали в интервал.
  //
  // multRuleInfoFor(dateKey, staffId) → { mult, from, to } | null.
  function multRuleInfoFor(dateKey, staffIdForGroup) {
    const rules = Array.isArray(state.params.multRules) ? state.params.multRules : [];
    if (!rules.length) return null;
    const dateMatches = (r) => String(r.date || "") === String(dateKey);
    const parseWindow = (r) => {
      const from = String(r.from || "").trim();
      const to = String(r.to || "").trim();
      return (from && to) ? { from, to } : null;
    };
    const first = (target, test) => {
      const r = rules.find((x) => x.target === target && x.mult >= 1 && dateMatches(x) && test(x));
      return r ? { mult: r.mult, window: parseWindow(r) } : null;
    };
    // 1) конкретный сотрудник → 2) группа → 3) «для всех»
    const candidates = [
      first("staff", (x) => String(x.targetId) === String(staffIdForGroup)),
      first("group", (x) => staffInGroup(staffIdForGroup, [x.targetId])),
      (() => {
        const r = rules.find((x) => x.target === "all" && x.mult >= 1 && dateMatches(x));
        return r ? { mult: r.mult, window: parseWindow(r) } : null;
      })(),
    ];
    return candidates.find((c) => c) || null;
  }

  // Множитель для бейджей/подсветки: возвращает ×N если на эту дату есть
  // подходящее правило (независимо от интервала времени суток — бейдж показывает
  // факт правила на день). Точный почасовой расчёт — в calcOverEarnByDay.
  function multiplierForDate(dateKey, staffIdForGroup) {
    const info = multRuleInfoFor(dateKey, staffIdForGroup);
    return info ? info.mult : 1;
  }

  // Absolute ms начала/конца интервала (HH:MM) для даты dateKey.
  function windowMs(dateKey, from, to) {
    const base = new Date(dateKey + "T00:00:00").getTime();
    const [h1, m1] = String(from).split(":").map(Number);
    const [h2, m2] = String(to).split(":").map(Number);
    const fromMs = base + ((Number.isFinite(h1) ? h1 : 0) * 3600000 + (Number.isFinite(m1) ? m1 : 0) * 60000);
    const toMs = base + ((Number.isFinite(h2) ? h2 : 0) * 3600000 + (Number.isFinite(m2) ? m2 : 0) * 60000);
    return { fromMs, toMs };
  }

  // Доля (0..1) сверхурочных часов дня, попавших в интервал [from, to].
  // Модель: переработка дня — «хвост» рабочего времени (последние over минуты
  // за концом рабочего дня). Считаем пересечение этого хвоста с интервалом.
  function overtimeWindowShare(dateKey, staffId, overMs, from, to) {
    if (!(overMs > 0) || !from || !to) return 0;
    const segs = daySegments(dateKey, staffId);
    let lastEnd = -Infinity;
    for (const s of segs) {
      if (s.kind !== "work") continue;
      const end = s.end == null
        ? (dateKey === dayKeyOf(Date.now()) ? Date.now() : dayEndMs(dateKey))
        : s.end;
      if (end > lastEnd) lastEnd = end;
    }
    if (!Number.isFinite(lastEnd) || lastEnd < 0) return 0;
    const { fromMs, toMs } = windowMs(dateKey, from, to);
    const tailStart = lastEnd - overMs; // начало «хвоста» переработки
    const overlap = Math.max(0, Math.min(lastEnd, toMs) - Math.max(tailStart, fromMs));
    return Math.min(1, Math.max(0, overlap / overMs));
  }

  // Деньги за переработку месяца с ПО-ЧАСОВЫМ множителем и автокомпенсацией
  // недобора. rows: [{ date: Date, over: ms }, ...] — переработка каждого дня.
  // Повышенный тариф ×N (правило multRules: конкретная дата + интервал [from,to])
  // начисляется ТОЛЬКО на те сверхурочные часы дня, которые попали в интервал.
  // Остальные сверхурочные часы — по обычной ставке (×1). Автокомпенсация:
  // часы, зачтённые в месячный недобор, не оплачиваются — сначала «съедаются»
  // часы без повышенного тарифа, чтобы конкретный интервал с ×N оплатился.
  // Возвращает { overEarn, effectiveOverMs }.
  function calcOverEarnByDay(rows, rate, isComplete, totalOverMs, deficitMs, staffIdForGroup) {
    const dayMult = rows.map((r) => ({
      dateKey: dayKeyOf(r.date.getTime()),
      overMs: Math.max(0, r.over || 0),
      // Признак «повышенного» дня для порядка компенсации: есть ли правило на дату.
      info: null,
    }));
    // Не считаем info в map (нужен dayKey): заполняем отдельным проходом.
    for (const dm of dayMult) dm.info = multRuleInfoFor(dm.dateKey, staffIdForGroup);
    const totalOver = dayMult.reduce((acc, x) => acc + x.overMs, 0);
    const usedMs = isComplete ? Math.min(totalOver > 0 ? totalOver : totalOverMs, deficitMs) : 0;
    let rem = usedMs;
    let overEarn = 0;
    // Дни с правилом (повышенным) стоят в очереди компенсации позже обычных —
    // недобор «съедается» сначала из дней ×1, чтобы интервал ×N оплатился.
    const ordered = [...dayMult].sort((a, b) => Number(!!a.info) - Number(!!b.info));
    for (const dm of ordered) {
      if (dm.overMs <= 0) continue;
      const take = Math.min(dm.overMs, rem);
      const paid = dm.overMs - take;
      if (paid > 0) {
        const key = dayKeyOf(dm.dateKey);
        const share = (dm.info && dm.info.window)
          ? overtimeWindowShare(key, staffIdForGroup, dm.overMs, dm.info.window.from, dm.info.window.to)
          : 0;
        const boosted = paid * share;            // сверхурочные внутри интервала — по ×N
        const base = paid - boosted;             // остальные — по ×1
        const mult = dm.info ? dm.info.mult : 1;
        overEarn += (base / 3600000) * rate * 1 + (boosted / 3600000) * rate * mult;
      }
      rem -= take;
    }
    const effectiveOverMs = isComplete ? Math.max(0, totalOverMs - usedMs) : totalOverMs;
    return { overEarn, effectiveOverMs };
  }

  // Hourly rate from the monthly salary and the current month's working days.
  // The hourly rate always uses an 8-hour working-day base (оклад / 8), regardless
  // of the overtime norm (9 h = 8 h per Labour Code + 1 h lunch).
  const RATE_BASE_HOURS = 8;
  // Мемоизация ставки: зависит только от месяца и оклада, которые меняются редко.
  let currRateKey = null;
  let currRateVal = 0;
  function currentRatePerHour() {
    const now = new Date();
    const key = now.getFullYear() + "-" + now.getMonth() + "|" + activeSalary();
    if (key === currRateKey) return currRateVal;
    currRateKey = key;
    const bizDays = businessDaysInMonth(now.getFullYear(), now.getMonth());
    const rateMonthMs = bizDays * RATE_BASE_HOURS * 3600000;
    const salary = activeSalary();
    currRateVal = rateMonthMs > 0 ? salary / (rateMonthMs / 3600000) : 0;
    return currRateVal;
  }

  // Money earned today: overtime only, no salary base.
  // = overtime hours × hourly rate × multiplier.
  function todayEarned(workMs) {
    const rate = currentRatePerHour();
    // По-дневной множитель: «заработано сегодня» учитывает период и группы.
    const mult = multiplierForDate(dayKeyOf(Date.now()), state.me && state.me.id);
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

  // ------------- Боксы: человекочитаемое отображение -------------
  // В интерфейсе и на стикере показываем «Бокс N» (N — номер из кода этикетки,
  // последний сегмент «...-N»). Настоящий «кракозябристый» код при этом хранится в
  // QR и используется при сканировании. Если номер выделить не получается —
  // показываем сам код как есть.
  function waybillBoxNumber(box) {
    const s = String(box == null ? "" : box).trim();
    const m = /\-(\d+)$/.exec(s);
    return m ? m[1] : "";
  }
  function waybillBoxName(box) {
    const n = waybillBoxNumber(box);
    return n ? "Бокс " + n : (String(box == null ? "" : box) || "");
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

  // ---- Производственный календарь РФ ----
  // Рабочие дни месяца = пн–пт минус праздничные нерабочие будни, плюс
  // перенесённые рабочие субботы (из-за переноса выходных). Праздник, выпавший
  // на субботу/воскресенье, дополнительный рабочий день не отнимает.
  const RUS_HOLIDAYS = {
    0: [1, 2, 3, 4, 5, 6, 7, 8],  // новогодние каникулы + Рождество
    1: [23],                       // День защитника Отечества
    2: [8],                        // 8 Марта
    3: [1, 2],                     // Праздник Весны и Труда
    4: [9],                        // День Победы
    5: [12],                       // День России
    10: [4],                       // День народного единства
  };
  // Переносы выходных по годам (по официальному производственному календарю):
  //   add — сдвинутая суббота/воскресенье становятся рабочими днями,
  //   off — будний день становится нерабочим из-за переноса.
  const RUS_SHIFTS = {
    "2026-1":  { add: [3],  off: [9] },   // 3 янв (сб) → раб.; 9 янв (пт) → вых.
    "2026-12": { add: [],   off: [31] },  // 31 дек (чт) → вых. (перенос с 4 янв)
    "2027-1":  { add: [2],  off: [] },    // 2 янв (сб) → раб. (перенос на 5 нояб.)
    "2027-2":  { add: [20], off: [22] },  // 20 фев (сб) → раб.; 22 фев (пн) → вых.
    "2027-11": { add: [],   off: [5] },   // 5 ноя (пт) → вых. (перенос с 2 янв)
    "2027-12": { add: [],   off: [31] },  // 31 дек (пт) → вых. (перенос с 3 янв)
  };
  function businessDaysInMonth(year, month0) {
    let count = 0;
    const days = new Date(year, month0 + 1, 0).getDate();
    const shift = RUS_SHIFTS[`${year}-${month0 + 1}`] || { add: [], off: [] };
    const holidays = RUS_HOLIDAYS[month0] || [];
    for (let d = 1; d <= days; d++) {
      const dow = new Date(year, month0, d).getDay();
      const isWeekend = dow === 0 || dow === 6;
      const isHoliday = holidays.includes(d);
      if (isWeekend && shift.add.includes(d)) { count++; continue; } // рабочая суббота/вс
      if (isWeekend) continue;                        // обычный выходной
      if (isHoliday && !shift.off.includes(d)) continue; // праздник в будень
      if (shift.off.includes(d)) continue;            // будень стал нерабочим
      count++;                                        // обычный рабочий пн–пт
    }
    return count;
  }
  // Является ли конкретный день рабочим по производственному календарю РФ.
  // Возвращает true для пн–пт без праздников и без перенесённых нерабочих дней,
  // а также для «рабочих суббот» из переносов (add). Необходимо для правила:
  // в выходной день все отработанные часы считаются переработкой.
  function isBizDay(year, month0, d) {
    const dow = new Date(year, month0, d).getDay();
    const isWeekend = dow === 0 || dow === 6;
    const shift = RUS_SHIFTS[`${year}-${month0 + 1}`] || { add: [], off: [] };
    const holidays = RUS_HOLIDAYS[month0] || [];
    if (isWeekend && shift.add.includes(d)) return true;  // рабочая суббота/вс
    if (isWeekend) return false;                          // выходной
    if (shift.off.includes(d)) return false;              // будень стал нерабочим
    if (holidays.includes(d)) return false;               // праздник в будень
    return true;                                          // обычный рабочий пн–пт
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
      const isBiz = isBizDay(year, m0, d);
      const closedReal = dayClosedWorkMs(state.me.id, key);
      // Выходной день: если таймер был запущен и завершён (есть закрытый сегмент)
      // — ВЕСЬ интервал пишется в подработку (не только сверх нормы).
      if (!isBiz && closedReal > 0) {
        totalWorkMs += closedReal;
        totalOverMs += closedReal;
        rows.push({ day: d, work: closedReal, over: closedReal, date: new Date(year, m0, d) });
        continue;
      }
      // Приоритет часов: есть таймер → используем его (ручная явка игнорируется).
      // Нет таймера → если проставлена ручная явка «Я», считаем день за 8 часов.
      // Больничный (Б) и отпуск (ОТ) — оплачиваемое отсутствие: засчитываем как
      // явку (8 ч/день), как это делает карточка «Расчёт ЗП» (employeeSalaryCalc).
      // Иначе в личном кабинете недобор получался больше, чем в табеле админа,
      // и вся переработка списывалась в недобор (к оплате 00:00).
      const isPaidIdle = status === "Б" || status === "ОТ";
      const hasTimer = closedReal > 0;
      const workEff = hasTimer ? work : (status === "Я" || isPaidIdle ? RATE_BASE_HOURS * 3600000 : 0);
      if (workEff <= 0) continue;
      const over = hasTimer ? Math.max(0, closedReal - normDayMs) : 0;
      totalWorkMs += workEff;
      totalOverMs += over;
      rows.push({ day: d, work: workEff, over, date: new Date(year, m0, d) });
    }
    const bizDays = businessDaysInMonth(year, m0);
    const rateMonthMs = bizDays * RATE_BASE_HOURS * 3600000;
    // Оклад/премия/надбавка — по-МЕСЯЧНО (может отличаться от текущего значения).
    const mKeyPay = year + "-" + String(m0 + 1).padStart(2, "0");
    const meSt0 = staffById(state.me.id);
    const pay = meSt0 ? staffPayForMonth(meSt0, mKeyPay) : {};
    const salary = (pay.salary != null) ? pay.salary : activeSalary();
    const bonus = (pay.bonus != null) ? pay.bonus : activeBonus();
    const extraBonus = (pay.extraBonus != null) ? pay.extraBonus : activeExtraBonus();
    const ratePerHour = rateMonthMs > 0 ? salary / (rateMonthMs / 3600000) : 0;
    // Автокомпенсация: месячная норма = 22 рабочих дня × 8 ч = 176 ч
    // (по ТК — стандартная норма полного месяца; обед 1 ч не входит в часовую
    // норму). Если за месяц недобор, но в какие-то дни была переработка — она
    // засчитывается в недобор (не оплачивается). Оплачивается только остаток
    // переработки сверх месячной нормы. Оклад — полный.
    const NORM_MONTH_DAYS = 22;
    const normMonthMs = NORM_MONTH_DAYS * RATE_BASE_HOURS * 3600000; // 176 ч
    const deficitMs = Math.max(0, normMonthMs - totalWorkMs);
    // Месяц считается завершённым (расчёт окончателен), когда наступило 1-е число
    // следующего месяца. Автокомпенсация (уменьшение переработки на недобор)
    // применяется ТОЛЬКО после завершения месяца — пока месяц идёт, недобор ещё
    // может закрыться, поэтому показываем полную переработку (не обнуляем сумму).
    const isComplete = new Date(year, m0 + 1, 1) <= new Date();
    // Деньги за переработку с ПО-ДНЕВНЫМ множителем: повышенный тариф ×N действует
    // только в дни периода multFrom–multTo (и только для отмеченных групп),
    // остальные дни — обычная ставка (×1). Раньше единый currentMultiplier()
    // применялся ко всему месяцу, из-за чего «тариф на конкретный день» считал все дни.
    const meId = state.me && state.me.id;
    const overCalc = calcOverEarnByDay(rows, ratePerHour, isComplete, totalOverMs, deficitMs, meId);
    const effectiveOverMs = overCalc.effectiveOverMs; // к оплате
    const overEarn = overCalc.overEarn;
    const usedMs = isComplete ? Math.max(0, totalOverMs - effectiveOverMs) : 0; // зачтено в недобор
    // Unpaid days (НН/ДО) are not paid: deduct their share of the monthly salary.
    const dayRate = bizDays > 0 ? salary / bizDays : 0;
    const unpaidDeduct = unpaidDays * dayRate;
    // "Заработано" = оклад + подработка + премия − неоплаченные дни; подработка считается ТОЛЬКО от оклада.
    const earned = salary + overEarn + bonus + extraBonus - unpaidDeduct;
    const overRate = ratePerHour;
    // overEarn уже посчитан ПО ДНЯМ (calcOverEarnByDay) с по-дневным множителем;
    // отдельная переменная `multiplier` тут не нужна (и удалена — не ссылаться на неё).
    return { year, m0, key: monthKey(year, m0), label: monthLabel(year, m0), isLast, isComplete, bizDays, salary, bonus, extraBonus, totalWorkMs, totalOverMs, normMonthMs, deficitMs, usedMs, effectiveOverMs, ratePerHour, overEarn, earned, unpaidDays, unpaidDeduct, unpaidDates, dayRate, rows };
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
    accountLogout: $("accountLogout"), accountLogBtn: $("accountLogBtn"), authScreen: $("authScreen"), authLoginBtn: $("authLoginBtn"), authHint: $("authHint"),
    appLogModal: $("appLogModal"), appLogArea: $("appLogArea"), appLogClose: $("appLogClose"), appLogCopy: $("appLogCopy"), appLogClear: $("appLogClear"),
    acctName: $("acctName"), acctId: $("acctId"), acctIdKind: $("acctIdKind"), acctRole: $("acctRole"), acctAdmin: $("acctAdmin"), acctVersion: $("acctVersion"), acctReason: $("acctReason"),
    monthList: $("monthList"), calSalaryChip: $("calSalaryChip"),
    pageTimer: $("page-timer"), pageCalendar: $("page-calendar"), pageLive: $("page-live"), pageReport: $("page-report"), pageDrivers: $("page-drivers"),
    pageMyRoutes: $("page-myroutes"), myroutesList: $("myroutesList"), myroutesCount: $("myroutesCount"), myroutesDateFilter: $("myroutesDateFilter"),
    pageShipment: $("page-shipment"),
    pageScanlog: $("page-scanlog"),
    pageNotfound: $("page-notfound"), pageLogs: $("page-logs"), pageReports: $("page-reports"), reportsHost: $("reportsHost"),
    notfoundModal: $("notfoundModal"), notfoundModalBody: $("notfoundModalBody"), notfoundModalClose: $("notfoundModalClose"),
    salaryModal: $("salaryModal"), salaryModalBody: $("salaryModalBody"), salaryModalClose: $("salaryModalClose"),
    reportsModal: $("reportsModal"), reportsModalFrame: $("reportsModalFrame"), reportsModalClose: $("reportsModalClose"),
    sverkiModal: $("sverkiModal"), sverkiModalFrame: $("sverkiModalFrame"), sverkiModalClose: $("sverkiModalClose"),
    procenkaModal: $("procenkaModal"), procenkaModalFrame: $("procenkaModalFrame"), procenkaModalClose: $("procenkaModalClose"),
    parserModal: $("parserModal"), parserModalFrame: $("parserModalFrame"), parserModalClose: $("parserModalClose"),
    nfdModal: $("notfoundDetailModal"), nfdModalBody: $("nfdModalBody"), nfdModalClose: $("nfdModalClose"),
    nfTabs: $("nfTabs"),
    nfSummary: $("nfSummary"),
    scanlogTable: $("scanlogTable"), scanlogEmpty: $("scanlogEmpty"), scanlogFilters: $("scanlogFilters"),
    scanlogSearch: $("scanlogSearch"), scanlogDateLoad: $("scanlogDateLoad"), scanlogDateUnload: $("scanlogDateUnload"),
    scanlogLoadDateField: $("scanlogLoadDateField"), scanlogUnloadDateField: $("scanlogUnloadDateField"),
    scanlogWaybillDateField: $("scanlogWaybillDateField"), scanlogDateWaybill: $("scanlogDateWaybill"),
    scanlogWbToggle: $("scanlogWbToggle"), scanlogWbAll: $("scanlogWbAll"), scanlogWbMissing: $("scanlogWbMissing"),
    notfoundTable: $("notfoundTable"), nfSearch: $("nfSearch"), nfRefresh: $("nfRefresh"), nfDeleteSelected: $("nfDeleteSelected"), nfdDate: $("nfdDate"),
    pageDelivery: $("page-delivery"), deliveryList: $("deliveryList"), deliveryDateFilter: $("deliveryDateFilter"), deliveryCount: $("deliveryCount"),
    driverClientName: $("driverClientName"), driverClientAddress: $("driverClientAddress"), driverClientInn: $("driverClientInn"), driverClientLogin: $("driverClientLogin"),
    driverClientsForm: $("driverClientsForm"), driverClientsBlock: $("driverClientsBlock"), driverClientsToggle: $("driverClientsToggle"), driverRouteForm: $("driverRouteForm"),
    addDriverClientBtn: $("addDriverClientBtn"), driverClientsList: $("driverClientsList"), driverClientsCount: $("driverClientsCount"),
    bundleToggle: $("bundleToggle"), bundlePanel: $("bundlePanel"), bundlePickList: $("bundlePickList"),
    bundleAddress: $("bundleAddress"), bundleName: $("bundleName"), bundleCreateBtn: $("bundleCreateBtn"), bundleList: $("bundleList"),
    driverRouteDate: $("driverRouteDate"), driverRouteDriver: $("driverRouteDriver"), driverRouteName: $("driverRouteName"), driverRouteClients: $("driverRouteClients"),
    selfPickupChk: $("selfPickupChk"),
    routeClientSearch: $("routeClientSearch"), routeClientOptions: $("routeClientOptions"), routeClientSelected: $("routeClientSelected"),
    routeStepCount: $("routeStepCount"), routeSelectedCount: $("routeSelectedCount"), routeTotalPill: $("routeTotalPill"),
    subtabContr: $("subtab-contr"), subtabRoute: $("subtab-route"), subtabRoutes: $("subtab-routes"), subtabReport: $("subtab-report"), subtabLocation: $("subtab-location"), subtab1cLog: $("subtab-1clog"), subtabTracking: $("subtab-tracking"),
    routesubContr: $("routesub-contr"), routesubRoute: $("routesub-route"), routesubRoutes: $("routesub-routes"), routesubReport: $("routesub-report"), routesubLocation: $("routesub-location"), routesub1cLog: $("routesub-1clog"), routesubTracking: $("routesub-tracking"),
    oneclogBody: $("oneclogBody"), oneclogStub: $("oneclogStub"),
    locationDriverSelect: $("locationDriverSelect"), locationDateFilter: $("locationDateFilter"), locationGoBtn: $("locationGoBtn"),
    locationInterval: $("locationInterval"),
    locationBody: $("locationBody"), locationTableWrap: $("locationTableWrap"), locationStub: $("locationStub"),
    onecPingRow: $("onecPingRow"), onecPingBtn: $("onecPingBtn"), onecPingRes: $("onecPingRes"),
    acctTzRow: $("acctTzRow"), acctTzOffset: $("acctTzOffset"),
    driverMap: $("driverMap"), driverMapCount: $("driverMapCount"), driverMapHint: $("driverMapHint"), driverTrackDate: $("driverTrackDate"), driverTrackStatus: $("driverTrackStatus"),
    motionDateFilter: $("motionDateFilter"),
    motionDrivers: $("motionDrivers"), motionKm: $("motionKm"), motionMove: $("motionMove"), motionLunch: $("motionLunch"),
    motionTable: $("motionTable"), motionBody: $("motionBody"),
    netBanner: $("netBanner"), netBannerText: $("netBannerText"), netRetry: $("netRetry"),
    saveDriverRouteBtn: $("saveDriverRouteBtn"), driverRoutesList: $("driverRoutesList"), driverRoutesCount: $("driverRoutesCount"),
    fillFrom1CBtn: $("fillFrom1CBtn"),
    routeWaybillsBlock: $("routeWaybillsBlock"), routeWaybillsList: $("routeWaybillsList"),
    autoRouteBtn: $("autoRouteBtn"), routeBaseAddress: $("routeBaseAddress"), autoRouteStatus: $("autoRouteStatus"),
    driverRoutesDateFilter: $("driverRoutesDateFilter"),
    liveSummary: $("liveSummary"), liveList: $("liveList"), liveBadge: $("liveBadge"),
    reportMonth: $("reportMonth"), reportShowOver: $("reportShowOver"),
    reportExportBtn: $("reportExportBtn"),
    reportWorkDays: $("reportWorkDays"), reportStaffCount: $("reportStaffCount"), reportTotalOver: $("reportTotalOver"),
    reportTableWrap: $("reportTableWrap"), reportTable: $("reportTable"),
    salaryCalcMonth: $("salaryCalcMonth"), salaryCalcList: $("salaryCalcList"),
    statusModal: $("statusModal"), statusClose: $("statusClose"), statusWho: $("statusWho"),
    statusOptions: $("statusOptions"), statusClear: $("statusClear"),
    statusReopen: $("statusReopen"), statusReopenClear: $("statusReopenClear"),
    routeConfirmModal: $("routeConfirmModal"), routeConfirmText: $("routeConfirmText"),
    routeConfirmOk: $("routeConfirmOk"), routeConfirmCancel: $("routeConfirmCancel"), routeConfirmClose: $("routeConfirmClose"),
    updateModal: $("updateModal"), updateText: $("updateText"),
    updateClose: $("updateClose"), updateLater: $("updateLater"), updateDownload: $("updateDownload"),
    postponeModal: $("postponeModal"), postponeClose: $("postponeClose"), postponeTiles: $("postponeTiles"),
    adminClose: $("adminClose"), adminTabs: $("adminTabs"),
    staffCountNote: $("staffCountNote"), addStaffBtn: $("addStaffBtn"),
    addStaffModal: $("addStaffModal"), addStaffClose: $("addStaffClose"), addStaffCancel: $("addStaffCancel"), addStaffSubmit: $("addStaffSubmit"),
    asName: $("asName"), asGroup: $("asGroup"), asLogin: $("asLogin"), asPass: $("asPass"),
    staffList: $("staffList"), salariesBody: $("salariesBody"), salMonth: $("salMonth"),
    scansLogList: $("scansLogList"), scansLogRefresh: $("scansLogRefresh"), scansOnlyFailed: $("scansOnlyFailed"), scansLogClear: $("scansLogClear"), scansDate: $("scansDate"), scansAllDays: $("scansAllDays"), scansSummary: $("scansSummary"),
    todayList: $("todayList"), todayDateNote: $("todayDateNote"),
    groupsList: $("groupsList"), newGroupName: $("newGroupName"), addGroupBtn: $("addGroupBtn"),
    clearLogBtn: $("clearLogBtn"), logTabs: $("logTabs"), logList: $("logList"), adminsList: $("adminsList"),
    showOverHours: $("showOverHours"), showOverSum: $("showOverSum"),
    showDrivers: $("showDrivers"),
    adminSeeRoutes: $("adminSeeRoutes"), driverSeeRoutes: $("driverSeeRoutes"),
    showOverHoursGroups: $("showOverHoursGroups"), showOverSumGroups: $("showOverSumGroups"),
    showShipment: $("showShipment"), shipmentGroups: $("shipmentGroups"),
    notfoundUsersGroups: $("notfoundUsersGroups"),
    logUsersGroups: $("logUsersGroups"), logUsersSearch: $("logUsersSearch"), logUsersCount: $("logUsersCount"),
    reportsUsersGroups: $("reportsUsersGroups"), reportsUsersSearch: $("reportsUsersSearch"), reportsUsersCount: $("reportsUsersCount"),
    reportsSectionsWrap: $("reportsSectionsWrap"),
    notfoundTab: $("notfoundTab"),
    reportsTab: $("reportsTab"),
    sverkiTab: $("sverkiTab"),
    sverkiUsersGroups: $("sverkiUsersGroups"), sverkiUsersSearch: $("sverkiUsersSearch"), sverkiUsersCount: $("sverkiUsersCount"),
    procenkaTab: $("procenkaTab"),
    procenkaUsersGroups: $("procenkaUsersGroups"), procenkaUsersSearch: $("procenkaUsersSearch"), procenkaUsersCount: $("procenkaUsersCount"),
    parserTab: $("parserTab"),
    parserUsersGroups: $("parserUsersGroups"), parserUsersSearch: $("parserUsersSearch"), parserUsersCount: $("parserUsersCount"),
    allowDriverStartWithoutShipment: $("allowDriverStartWithoutShipment"),
    allowFinishUnloadIncomplete: $("allowFinishUnloadIncomplete"),
    allowDriverReorderPoints: $("allowDriverReorderPoints"),
    routeDeleteCode: $("routeDeleteCode"),
    scanLogLimit: $("scanLogLimit"),
    routeDeleteModal: $("routeDeleteModal"), routeDeleteInput: $("routeDeleteInput"),
    routeDeleteConfirm: $("routeDeleteConfirm"), routeDeleteCancel: $("routeDeleteCancel"),
    routeDeleteClose: $("routeDeleteClose"),
    driverScanModal: $("driverScanModal"), driverScanInput: $("driverScanInput"),
    driverScanClose: $("driverScanClose"), driverScanCancel: $("driverScanCancel"),
    driverScanOk: $("driverScanOk"),
    shipmentListActive: $("shipmentListActive"), shipmentListDone: $("shipmentListDone"),
    shipmentSubtabActive: $("shipmentSubtabActive"), shipmentSubtabDone: $("shipmentSubtabDone"),
    shipmentDateFilter: $("shipmentDateFilter"), shipmentDateClear: $("shipmentDateClear"),
    printModal: $("printModal"), printClientsTiles: $("printClientsTiles"),
    printPlacesQty: $("printPlacesQty"), printConfirm: $("printConfirm"),
    printCancel: $("printCancel"), printClose: $("printClose"), printArea: $("printArea"),
    printShipmentComplete: $("printShipmentComplete"), printAppendBtn: $("printAppendBtn"),
    appendModal: $("appendModal"), appendClientsTiles: $("appendClientsTiles"),
    appendPlacesQty: $("appendPlacesQty"), appendConfirm: $("appendConfirm"),
    appendCancel: $("appendCancel"), appendClose: $("appendClose"),
    scanLoadBtn: $("scanLoadBtn"), scanOverlayClose: $("scanOverlayClose"),
    printScanStatus: $("printScanStatus"), printLabelsList: $("printLabelsList"), printScanInput: $("printScanInput"),
    scanSrcCamera: $("scanSrcCamera"), scanSrcExternal: $("scanSrcExternal"), printScanHint: $("printScanHint"),
    multiplierStatus: $("multiplierStatus"), normVal: $("normVal"), paramsSave: $("paramsSave"),
    multRuleTarget: $("multRuleTarget"), multRuleSubject: $("multRuleSubject"),
    multRuleSubjectField: $("multRuleSubjectField"), multRuleSubjectLabel: $("multRuleSubjectLabel"),
    multRuleDate: $("multRuleDate"), multRuleFrom: $("multRuleFrom"), multRuleTo: $("multRuleTo"),
    multRuleValue: $("multRuleValue"),
    multRuleAddBtn: $("multRuleAddBtn"), multRuleCancelBtn: $("multRuleCancelBtn"),
    multRuleFormTitle: $("multRuleFormTitle"), multRuleList: $("multRuleList"),
    goToMultiplierTab: $("goToMultiplierTab"),
    waybillModal: $("waybillModal"), waybillTitle: $("waybillTitle"),
    waybillClose: $("waybillClose"), waybillFile: $("waybillFile"), waybillRemoveMissing: $("waybillRemoveMissing"), waybillCleanBtn: $("waybillCleanBtn"),
    waybillStatus: $("waybillStatus"), waybillFlash: $("waybillFlash"), waybillArtInput: $("waybillArtInput"),
    waybillQtyInput: $("waybillQtyInput"),
    waybillScanBtn: $("waybillScanBtn"), waybillList: $("waybillList"),
    waybillFinishBtn: $("waybillFinishBtn"),
    waybillMissBtn: $("waybillMissBtn"), waybillManualBtn: $("waybillManualBtn"),
    waybillListModal: $("waybillListModal"), waybillListModalBody: $("waybillListModalBody"),
    waybillListModalClose: $("waybillListModalClose"), waybillListModalTitle: $("waybillListModalTitle"),
    waybillModalAssembleBtn: $("waybillModalAssembleBtn"), waybillModalMissBtn: $("waybillModalMissBtn"),
    waybillModalQty: $("waybillModalQty"),
    waybillQtyAskModal: $("waybillQtyAskModal"), waybillQtyAsk: $("waybillQtyAsk"),
    waybillQtyAskOk: $("waybillQtyAskOk"), waybillQtyAskCancel: $("waybillQtyAskCancel"),
    waybillSharedQtyModal: $("waybillSharedQtyModal"), waybillSharedQty: $("waybillSharedQty"), waybillSharedQtyInfo: $("waybillSharedQtyInfo"),
    waybillSharedQtyOk: $("waybillSharedQtyOk"), waybillSharedQtyCancel: $("waybillSharedQtyCancel"),
    waybillBoxCur: $("waybillBoxCur"), waybillNewBoxBtn: $("waybillNewBoxBtn"),
    waybillBoxQty: $("waybillBoxQty"),
    boxDetailsModal: $("boxDetailsModal"), boxDetailsList: $("boxDetailsList"),
    boxDetailsTitle: $("boxDetailsTitle"), boxDetailsClose: $("boxDetailsClose"),
    authBtn: $("authBtn"), authModal: null, authClose: $("authClose"),
    authLogin: $("authLogin"), authPassword: $("authPassword"), authSubmitBtn: $("authSubmitBtn"),
    authHint: $("authHint"), authTitle: $("authTitle"),
    authLoginView: $("authLoginView"), authFirstView: $("authFirstView"),
    authFirstLink: $("authFirstLink"), authBackLogin: $("authBackLogin"),
    authName: $("authName"), authFindBtn: $("authFindBtn"), authResults: $("authResults"),
    authSetView: $("authSetView"), authNewLogin: $("authNewLogin"), authNewPass: $("authNewPass"),
    authSetBtn: $("authSetBtn"), authFirstHint: $("authFirstHint"),
    authUserChip: $("userChip"), authUserName: $("userName"), authAvatar: $("userAvatar"),
    authGate: $("authGate"),
    cpBox: $("cpBox"), cpCurrent: $("cpCurrent"), cpNew: $("cpNew"), cpSubmit: $("cpSubmit"), cpHint: $("cpHint"),
    waybillDelBoxList: $("waybillDelBoxList"), waybillDelBoxBtn: $("waybillDelBoxBtn"),
    updateVersionCode: $("updateVersionCode"), updateVersionName: $("updateVersionName"),
    updateApkUrl: $("updateApkUrl"), updateNotes: $("updateNotes"),
    backupExportBtn: $("backupExportBtn"), backupAppBtn: $("backupAppBtn"), backupImportFile: $("backupImportFile"), backupStatus: $("backupStatus"),
    backupAutoNote: $("backupAutoNote"), backupAutoList: $("backupAutoList"),
  };

  let toastTimer = null;
  // Кэш актуальной версии приложения (из /api/app/update-info → version.json).
  // Используется бейджем в шапке и карточкой «Учётная запись».
  let appVersionName = "";
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

  // ------------- Диагностический журнал на устройстве -------------
  // Пишет события сканера выгрузки, ответы нативного моста и ошибки JS в
  // localStorage, чтобы водитель мог открыть «Учётная запись» -> «Логи» и
  // посмотреть/скопировать, когда кнопка «Сканировать выгрузку» молчит.
  // В APK (WebView) console-логи в Logcat видны только через adb, а этот буфер
  // доступен прямо на устройстве.
  const APP_LOG_KEY = "biotime_app_log";
  const APP_LOG_LIMIT = 400;
  function readAppLog() {
    try {
      const raw = localStorage.getItem(APP_LOG_KEY);
      const a = raw ? JSON.parse(raw) : [];
      return Array.isArray(a) ? a : [];
    } catch { return []; }
  }
  function logApp(level, msg) {
    let line;
    try {
      const t = new Date().toISOString().slice(11, 19);
      line = "[" + t + "] " + String(level).toUpperCase() + " " + String(msg);
    } catch {
      line = String(msg);
    }
    try {
      if (console && typeof console[level] === "function") console[level](msg);
      else if (console && console.log) console.log(msg);
    } catch { /* ignore */ }
    try {
      const a = readAppLog();
      a.push(line);
      if (a.length > APP_LOG_LIMIT) a.splice(0, a.length - APP_LOG_LIMIT);
      localStorage.setItem(APP_LOG_KEY, JSON.stringify(a));
    } catch { /* ignore */ }
    return line;
  }
  function openAppLogModal() {
    if (el.appLogArea) el.appLogArea.value = readAppLog().join("\n");
    if (el.appLogModal) { try { el.appLogModal.showModal(); } catch { /* уже открыта */ } }
  }
  function closeAppLogModal() {
    if (el.appLogModal && el.appLogModal.open) { try { el.appLogModal.close(); } catch { /* ignore */ } }
  }
  function copyAppLog() {
    const txt = readAppLog().join("\n");
    if (!txt) { toast("Логи пока пусты"); return; }
    const done = () => toast("Логи скопированы");
    const fail = () => {
      // Фолбэк без Clipboard API (старый WebView): выделяем и говорим водителю.
      if (el.appLogArea) { try { el.appLogArea.focus(); el.appLogArea.select(); } catch { /* ignore */ } }
      toast("Выделите текст и скопируйте вручную");
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done).catch(fail);
      } else {
        const ta = document.createElement("textarea");
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        ok ? done() : fail();
      }
    } catch { fail(); }
  }
  function clearAppLog() {
    try { localStorage.removeItem(APP_LOG_KEY); } catch { /* ignore */ }
    if (el.appLogArea) el.appLogArea.value = "";
    toast("Логи очищены");
  }

  // ------------- Actions -------------
  // Передаём нативу (Android WebView) статус рабочего дня водителя, чтобы
  // фоновый трекер геолокации работал ТОЛЬКО пока день начат и не завершён.
  // После «Завершить работу» натив останавливает отправку координат.
  function syncWorkActiveToNative(active) {
    if (window.AndroidBridge && typeof window.AndroidBridge.setWorkActive === "function") {
      try { window.AndroidBridge.setWorkActive(!!active); } catch (_) { /* натив недоступен */ }
    }
  }

  // Сообщаем нативу, является ли сотрудник водителем (me.isDriver из /api/state).
  // Трекер геолокации нативный запускает ТОЛЬКО у водителей — для всех остальных
  // местоположение не запрашивается.
  function syncDriverToNative() {
    if (window.AndroidBridge && typeof window.AndroidBridge.setDriver === "function") {
      try { window.AndroidBridge.setDriver(!!state.isDriver); } catch (_) { /* натив недоступен */ }
    }
  }

  async function startWork() {
    if (state.phase === "working" && openSegment()) return;
    // День завершён на сервере — сегодня начать нельзя. НО если админ «Открыл» день
    // (сбросил завершение: finished=false), день снова рабочий — разрешаем старт,
    // сняв устаревший локальный маркер завершения (иначе фоновый poll/refreshToday
    // видел бы «завершено» и закрывал свежезапущенный таймер через пару минут).
    const sd = state.days[state.dayKey]
      && state.days[state.dayKey].byEmployee
      && state.days[state.dayKey].byEmployee[state.me.id];
    if (state.phase === "finished" && sd && sd.finished) {
      toast("Рабочий день уже завершён — сегодня начать нельзя");
      return;
    }
    // Снимаем локальный маркер завершения и открываем день на сервере.
    state.finishKey = null;
    try { localStorage.removeItem(FINISH_KEY); } catch { /* приватный режим */ }
    if (sd) sd.finished = false;
    state.segments.push({ start: Date.now(), end: null, kind: "work", id: uid() });
    state.phase = "working";
    writeOpenSegCache(); // помним начало дня локально — переживёт сворачивание/потерю сети
    // Трекер запускается только у водителя (не-водители не шлют координаты).
    syncDriverToNative();
    if (state.isDriver) syncWorkActiveToNative(true);
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
    writeOpenSegCache(); // открытого больше нет — чистим локальный кэш таймера
    try { localStorage.setItem(FINISH_KEY, state.dayKey || ""); } catch { /* приватный режим */ }
    syncWorkActiveToNative(false);
    render();
    showFinishToast();
    postLog("завершение работы");
    // П.3 — централизация завершения: явно сообщаем серверу, что день закрыт
    // (finish:true + время нажатия). Сервер закрывает день и не даст фоновым
    // вкладкам/дублю вернуть открытый таймер (см. POST /api/day).
    await saveDay({ finish: true, finishTime: now });
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
    const [y, m, d] = state.dayKey.split("-").map(Number);
    // В выходной день (по производственному календарю) вся отработанная работа
    // сразу считается переработкой — в тосте при завершении показываем её целиком.
    const over = isBizDay(y, m - 1, d) ? Math.max(0, work - normMs) : Math.max(0, work);
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
    // Выходной день по производственному календарю РФ: ВСЯ отработанная работа
    // сразу считается переработкой (не только сверх нормы, и без порога 9 часов).
    // На таймере показывается переработка ТОЛЬКО за текущий день (без вчерашней):
    // вчерашние часы уже учтены в месячном/ли отчёте, на таймере их не дублируем.
    const [ty, tm, td] = state.dayKey.split("-").map(Number);
    const todayIsBiz = isBizDay(ty, tm - 1, td);
    // Выходной день (воскресенье и т.п.): ВСЯ отработанная работа — переработка,
    // включая ещё открытый (идущий) сегмент таймера. Условие на закрытые сегменты
    // здесь НЕ применяется, иначе запущенный таймер показывал бы 0 до нажатия
    // «Завершить работу». В рабочий день переработка — только закрытые часы сверх нормы.
    const todayOver = todayIsBiz
      ? (closedWork > 0 ? Math.max(0, closedWork - normMs) : 0)
      : workNet;
    // Порог показа переработки: в рабочий день — только после достижения нормы
    // (9 ч), а в выходной — сразу с первой минуты работы (вся работа — переработка).
    const showSubtotal = todayIsBiz ? workNet >= nineH : workNet > 0;
    // Вариант А: переработка на таймере — только за текущий день (todayOver),
    // без добавления вчерашней переработки.
    const over = showSubtotal ? todayOver : 0;
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

  // Лёгкое ежесекундное обновление таймера: пересчитывает и пишет ТОЛЬКО живые
  // цифры (отработано, переработка, деньги, время начала), не перерисовывая
  // статусы/бейджи/ставку и не дёргая тяжёлые функции (currentRatePerHour,
  // multiplierForDate) на каждый тик. Полный render() вызывается на событиях
  // (start/pause/finish/poll) — там смена статуса действительно нужна.
  function tickTimer() {
    if (!el.pageTimer || el.pageTimer.hidden) return;
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
    const nineH = 9 * 3600 * 1000;
    const [ty, tm, td] = state.dayKey.split("-").map(Number);
    const todayIsBiz = isBizDay(ty, tm - 1, td);
    const todayOver = todayIsBiz
      ? (closedWork > 0 ? Math.max(0, closedWork - normMs) : 0)
      : workNet;
    const showSubtotal = todayIsBiz ? workNet >= nineH : workNet > 0;
    const over = showSubtotal ? todayOver : 0;
    if (el.totWorked) el.totWorked.textContent = fmtMs(workNet, false);
    if (el.totOvertime) el.totOvertime.textContent = over > 0 ? fmtMs(over, false) : "00:00";
    if (el.totOvertime && el.totOvertime.parentElement) {
      el.totOvertime.parentElement.classList.toggle("over", over > 0);
    }
    if (el.totBal) el.totBal.textContent = fmtMoney(todayEarned(over > 0 ? normMs + over : 0));
    // Время начала (первый рабочий сегмент) тоже живёт и дорисовывается только здесь.
    const startSeg = state.segments.find((s) => s.kind === "work");
    if (el.dialTime) {
      if (!startSeg) el.dialTime.textContent = "—";
      else if (startSeg.end != null) el.dialTime.textContent = `${msToHm(startSeg.start)} → ${msToHm(startSeg.end)}`;
      else el.dialTime.textContent = msToHm(startSeg.start);
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
      // Отдельный блок: автокомпенсация переработки в месячный недобор.
      // Показывается, если за месяц был недобор и/или переработка частично
      // засчиталась в него (объясняет, почему часть часов не оплачена сверх оклада).
      const compBadge = calc.usedMs > 0 ? "✓" : "i";
      // Надпись для сотрудника показываем только после завершения месяца
      // (появляется, когда расчёт уже произведён — например, за сентябрь
      // видна с 1 октября). Текущий незавершённый месяц — без пояснения.
      const compNote = (calc.deficitMs > 0 || calc.usedMs > 0) && calc.isComplete
        ? `<div class="month-comp-note">
            <span class="mcn-badge" aria-hidden="true">${compBadge}</span>
            <div class="mcn-body">
              <div class="mcn-title">${calc.usedMs > 0 ? "Подработка засчитана в недобор" : "Недобор по месячной норме"}</div>
              <div class="mcn-text">${calc.usedMs > 0
                ? `Была нехватка основных часов (${fmtHours(calc.deficitMs)}) — для её перекрытия списана подработка (${fmtHours(calc.usedMs)}, не оплачивается), к оплате переработка ${fmtHours(calc.effectiveOverMs)}.`
                : `Нехватка основных часов: ${fmtHours(calc.deficitMs)}, переработки нет — недобор не компенсируется.`}</div>
            </div>
          </div>`
        : "";
      if (!hasRows) {
        inner.innerHTML = compNote + unpaidNote + `<div class="month-empty">${calc.unpaidDays > 0 ? "Отработанных дней не было, а неоплачиваемые дни учтены выше." : "Нет отработанных дней в этом месяце."}</div>`;
      } else {
        const rowsHtml = calc.rows.map((r) => {
          const dateStr = r.date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", weekday: "short" });
          const overCell = showOverHoursFlag ? `<td class="num ${r.over > 0 ? "over-pos" : ""}">${r.over > 0 ? fmtHours(r.over) : "—"}</td>` : "";
          // Дневная сумма с ПО-ДНЕВНЫМ множителем (повышенный тариф только в дни
          // периода и для отмеченных групп) — согласуется с итогом calc.overEarn.
          const dayMult = multiplierForDate(dayKeyOf(r.date.getTime()), state.me && state.me.id);
          const sumCell = showOverSumFlag ? `<td class="num earn">${fmtMoney((r.over / 3600000) * calc.ratePerHour * dayMult)}</td>` : "";
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
        if (compNote) inner.insertAdjacentHTML("afterbegin", compNote);
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
      // Переработка и её стоимость собираются ПО ДНЯМ. Переработка дня считается
      // по тем же правилам, что в ЗП (выходной — весь закрытый таймер в подработку,
      // рабочий — сверх нормы). Стоимость каждого дня учитывает ПО-ДНЕВНОЙ множитель
      // (повышенный тариф только в дни периода multFrom–multTo и для отмеченных
      // групп), а не единый множитель на весь месяц.
      let overMsVal = 0;
      const overByDay = [];
      for (let o = 1; o <= daysInMonth; o += 1) {
        const dKey = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(o).padStart(2, "0")}`;
        const wk = dayClosedWorkMs(st.id, dKey);
        if (wk > 0) {
          const overDay = isBizDay(y, m0, o) ? Math.max(0, wk - normDayMs) : wk;
          if (overDay > 0) {
            overMsVal += overDay;
            overByDay.push({ dKey, overDay });
          }
        }
      }
      // "Часы" follow the hours flag; "сумма" (money) follows its OWN flag, so a
      // group granted hours but not the money is not charged for overtime.
      const seeHoursVal = showOver && (st.seeOverHours !== false);
      const seeSumVal = showOver && (st.seeOverSum !== false);
      // Money for overtime, from the employee's salary rate (salary / month norm).
      // Оклад/премия/надбавка — по-МЕСЯЧНО (не трогаем соседние месяцы).
      const mKeyPay0 = y + "-" + String(m0 + 1).padStart(2, "0");
      const pay0 = staffPayForMonth(st, mKeyPay0);
      const normMonthH = bizDays * RATE_BASE_HOURS;
      const staffRate = pay0.salary != null && pay0.salary > 0 && normMonthH > 0 ? pay0.salary / normMonthH : 0;
      const overEarn = seeSumVal
        ? overByDay.reduce((acc, od) => acc + (od.overDay / 3600000) * staffRate * multiplierForDate(od.dKey, st.id), 0)
        : 0;
      return {
        id: st.id,
        name: st.name,
        salary: pay0.salary != null ? pay0.salary : 0,
        bonus: pay0.bonus != null ? pay0.bonus : 0,
        extraBonus: pay0.extraBonus != null ? pay0.extraBonus : 0,
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
      anySeeHours ? `<th class="report-sticky-right" title="Время переработки в формате ЧЧ:ММ">Часы переработка</th>` : "",
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
        const key = `${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        // Повышенный тариф подработки (множитель ×N > 1) в этот день для этого
        // сотрудника: подсвечиваем ячейку табеля, чтобы было видно, что день
        // «ишёл по повышенному тарифу» (период multFrom–multTo + группа сотрудника).
        const dayMult = multiplierForDate(key, r.id);
        const isToday = (() => {
          const now = new Date();
          return now.getFullYear() === y && now.getMonth() === m0 && now.getDate() === d;
        })();
        const cls = [isWE ? "dow-we" : ""];
        if (dayMult > 1) cls.push("day-mult");
        const status = r.dayStatus[d];
        const rec = state.days[`${y}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`];
        const isManual = rec && rec.statuses && rec.statuses[r.id];
        if (!status && d >= 1) cls.push("day-offempty");
        if (isToday) cls.push("day-today");
        if (status && isManual) cls.push("manual");
        if (status && !isManual) cls.push("auto-mark");
        if (status) cls.push("has-status");
        if (state.canEditStatus) cls.push("editable");
        const mark = status
          // Бейдж множителя ×N показываем ТОЛЬКО в ячейках с явкой («Я»):
          // повышенный тариф применяется к подработке, а подработка считается
          // только в фактически отработанный день. У больничных, отпусков,
          // неполных дней и прогулов бейдж ×N не ставим, даже если день попадает
          // в период повышенного тарифа.
          ? `<span class="mark ${status === "Я" && r.overMs > 0 ? "mark-over" : ""} status-${status}">${status}${status === "Я" && dayMult > 1 ? `<i class="mult-tag">×${dayMult}</i>` : ""}</span>`
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
      // Итог по группе (по окладу/премии/переработке/сумме) — «шапка как у Итого».
      let gSalary = 0, gBonus = 0, gOverMs = 0, gOverEarn = 0;
      grp.members.forEach((r) => {
        gSalary += (r.salary ? r.salary : 0) + (r.extraBonus ? r.extraBonus : 0);
        gBonus += r.bonus ? r.bonus : 0;
        gOverMs += r.overMs ? r.overMs : 0;
        gOverEarn += r.overEarn ? r.overEarn : 0;
      });
      let gDay = "";
      for (let d = 1; d <= daysInMonth; d += 1) {
        const cnt = grp.members.filter((r) => r.dayStatus[d] === "Я").length;
        const dow = new Date(y, m0, d).getDay();
        gDay += `<td class="num ${(dow === 0 || dow === 6) ? "dow-we" : ""}">${cnt || ""}</td>`;
      }
      bodyParts.push(anySeeHours
        ? `<tr class="report-group-subtotal">
            <td class="report-idx-head"></td>
            <td class="report-total-key">Итого · ${escapeHtml(grp.name)}</td>
            ${gDay}
            <td class="num report-total-val">${fmtMoney(gSalary)}</td>
            <td class="num report-total-val">${fmtMoney(gBonus)}</td>
            <td></td>
            <td class="num report-over">${gOverMs > 0 ? fmtHours(gOverMs) : "—"}</td>
            <td class="num report-total-val">${fmtMoney(gOverEarn)}</td>
          </tr>`
        : `<tr class="report-group-subtotal">
            <td class="report-idx-head"></td>
            <td class="report-total-key">Итого · ${escapeHtml(grp.name)}</td>
            ${gDay}
            <td class="num report-total-val">${fmtMoney(gSalary)}</td>
            <td class="num report-total-val">${fmtMoney(gBonus)}</td>
            <td></td>
          </tr>`);
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

  // ------------- Расчёты ЗП (вкладка «Отчёт» → «Расчёты ЗП») -------------
  // Считает зарплату каждого сотрудника (кроме группы «god») за выбранный месяц
  // по правилу автокомпенсации:
  //   месячная норма = рабочие дни месяца × 9 ч (8 по ТК + 1 обед);
  //   если по итогу месяца недобор, но в какие-то дни была переработка — она
  //   засчитывается в недобор (не оплачивается как переработка); доплачивается
  //   только остаток переработки СВЕРХ месячной нормы. Оклад выплачивается
  //   полностью всегда (автокомпенсация лишь убирает переработку из оплаты).
  function isInGodGroup(staffId) {
    return (state.groups || []).some(
      (g) => /god/i.test(String(g.name || "")) && (g.memberIds || []).includes(staffId)
    );
  }

  function renderSalaryCalcMonthSelect() {
    if (!el.salaryCalcMonth) return;
    if (el.salaryCalcMonth.options.length === 0) {
      const months = monthRange();
      if (months.length === 0) return;
      [...months].reverse().forEach(({ year, month }) => {
        const opt = document.createElement("option");
        opt.value = monthKey(year, month);
        opt.textContent = monthLabel(year, month);
        el.salaryCalcMonth.appendChild(opt);
      });
    }
    const now = new Date();
    const cur = monthKey(now.getFullYear(), now.getMonth());
    if (!el.salaryCalcMonth.value) {
      if ([...el.salaryCalcMonth.options].some((o) => o.value === cur)) {
        el.salaryCalcMonth.value = cur;
      } else if (el.salaryCalcMonth.options.length) {
        el.salaryCalcMonth.value = el.salaryCalcMonth.options[0].value;
      }
    }
  }

  // Расчёт зарплаты одного сотрудника за месяц (year, m0) с автокомпенсацией.
  function employeeSalaryCalc(staffId, year, m0) {
    // Рабочая норма дня — 8 ч: именно эти часы показываем как «отработано».
    const workedNormMs = RATE_BASE_HOURS * 3600000;
    // Порог переработки — та же норма дня, что в табеле (state.norm, обычно 9 ч =
    // 8 рабочих + 1 ч обед). Переработка идёт СВЕРХ этой нормы, а не сверх 8 ч.
    const overNormMs = (state.norm > 0 ? state.norm : RATE_BASE_HOURS) * 3600000;
    const daysInMonth = new Date(year, m0 + 1, 0).getDate();
    const bizDays = businessDaysInMonth(year, m0);
    // Месячная норма для автокомпенсации = рабочие дни × 8 ч рабочего времени.
    const NORM_MONTH_DAYS = 22;
    const normMonthMs = NORM_MONTH_DAYS * RATE_BASE_HOURS * 3600000; // 22 × 8 = 176 ч
    let totalWorkMs = 0;
    let totalOverMs = 0;
    let unpaidDays = 0;
    let paidIdleDays = 0; // дни больничного / отпуска, засчитанные как явка
    let paidIdleMs = 0;   // их часы (вошли в totalWorkMs)
    const rows = []; // строки по дням для таблицы: {day, date, work, over}
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = `${year}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const rec = state.days[key];
      const st = rec && rec.statuses ? rec.statuses[staffId] : undefined;
      // Неоплачиваемые статусы (НН/ДО): исключаем из заработка.
      if (st === "НН" || st === "ДО") { unpaidDays++; continue; }
      // Больничный (Б) и отпуск (ОТ) — оплачиваемое отсутствие: засчитываем в
      // часы явки (по норме, как будто сотрудник отработал день) и обязательно
      // показываем такой день строкой в карточке сотрудника (fixed in card).
      const isPaidIdle = st === "Б" || st === "ОТ";
      const isBiz = isBizDay(year, m0, d);
      const closedReal = dayClosedWorkMs(staffId, key);
      const hasTimer = closedReal > 0; // есть завершённый сегмент таймера
      // Выходной день: если таймер был запущен и завершён (есть закрытый сегмент)
      // — ставим явку независимо от часов и ВЕСЬ интервал пишем в подработку.
      if (!isBiz && hasTimer) {
        totalOverMs += closedReal;
        rows.push({ day: d, date: new Date(year, m0, d), work: 0, over: closedReal });
        continue;
      }
      // Приоритет: есть таймер → используем его (ручная явка игнорируется).
      // Нет таймера → если проставлена явка «Я» либо больничный «Б» / отпуск
      // «ОТ», считаем день за норму рабочего времени (как явку).
      const work = hasTimer ? reportDayWorkMs(staffId, key)
        : (st === "Я" || isPaidIdle ? RATE_BASE_HOURS * 3600000 : 0);
      if (work <= 0) continue;
      // Переработка дня = рабочее время сверх 8 ч нормы.
      const over = hasTimer ? Math.max(0, work - overNormMs) : 0;
      // «Факт» (Отработано) = базовая норма до 8 ч, БЕЗ переработки.
      totalWorkMs += Math.min(work, workedNormMs);
      if (over > 0) totalOverMs += over;
      if (isPaidIdle && !hasTimer) { paidIdleDays += 1; paidIdleMs += work; }
      rows.push({ day: d, date: new Date(year, m0, d), work: Math.min(work, workedNormMs), over, st: isPaidIdle ? st : undefined });
    }
    const deficitMs = Math.max(0, normMonthMs - totalWorkMs);
    // Автокомпенсация применяется ТОЛЬКО после завершения месяца: пока месяц
    // идёт, показываем полную переработку, а недобор ещё может закрыться.
    const isComplete = new Date(year, m0 + 1, 1) <= new Date();
    const st = state.staff.find((x) => String(x.id) === String(staffId));
    // Значения оклада/премии/надбавки — по-МЕСЯЧНО (не из «текущего» st.*), чтобы
    // надбавка, установленная в октябре, не попадала в сентябрьский «Расчёт ЗП».
    const mKey0 = year + "-" + String(m0 + 1).padStart(2, "0");
    const payM = st ? staffPayForMonth(st, mKey0) : {};
    const salary = (payM.salary != null) ? payM.salary : (st ? 50000 : 0);
    const extraBonus = (payM.extraBonus != null) ? payM.extraBonus : 0;
    const bonus = (payM.bonus != null) ? payM.bonus : 0;
    const rateMonthH = bizDays * RATE_BASE_HOURS;
    const ratePerHour = rateMonthH > 0 ? salary / rateMonthH : 0;
    // Деньги за переработку с ПО-ДНЕВНЫМ множителем (повышенный тариф только в
    // дни периода multFrom–multTo и для отмеченных групп), остальные дни — ×1.
    const overCalc = calcOverEarnByDay(rows, ratePerHour, isComplete, totalOverMs, deficitMs, staffId);
    const effectiveOverMs = overCalc.effectiveOverMs; // к оплате
    const overEarn = overCalc.overEarn;
    const usedMs = isComplete ? Math.max(0, totalOverMs - effectiveOverMs) : 0; // зачлось в недобор
    const dayRate = bizDays > 0 ? salary / bizDays : 0;
    const unpaidDeduct = unpaidDays * dayRate;
    // «Заработано» = оклад + премия + надбавка + переработка − неоплаченные дни
    // (согласовано с личным расчётом сотрудника в computeMonth).
    const earned = salary + bonus + extraBonus + overEarn - unpaidDeduct;
    return {
      id: staffId,
      name: st ? st.name : "—",
      bizDays, normMonthMs, totalWorkMs, totalOverMs,
      isComplete, deficitMs, usedMs, effectiveOverMs,
      salary, bonus, extraBonus, ratePerHour, overEarn, earned,
      unpaidDays, unpaidDeduct, dayRate, rows,
      paidIdleDays, paidIdleMs,
    };
  }

  function fmtCalcHours(ms) {
    const totalMin = Math.round(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const min = totalMin % 60;
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  function fmtCalcMoney(a) { return `${Math.round(a).toLocaleString("ru-RU")} ₽`; }

  function buildSalaryExplanation(r) {
    const hs = fmtCalcHours;
    // Пояснение выводится ТОЛЬКО по завершении месяца (1-го числа нового за
    // предыдущий, r.isComplete) и только когда нехватка основных часов была
    // перекрыта списанием подработки. Во всех остальных случаях — пусто.
    if (r.isComplete && r.deficitMs > 0 && r.usedMs > 0) {
      return `Была нехватка отработки основных часов — ${hs(r.deficitMs)}. ` +
        `Для её перекрытия списана подработка: ${hs(r.usedMs)} засчитаны в недобор (не оплачиваются), ` +
        `к оплате переработка ${hs(r.effectiveOverMs)}.`;
    }
    return "";
  }

  // Кэш расчёта ЗП по сотруднику+месяцу для ЛЕНИВОГО рендера дневной детализации.
  // Тяжёлый HTML построчно-по-дням (до ~31 <tr> на сотрудника) строится только
  // когда карточку раскрывают, а не для всех сотрудников сразу — иначе первичный
  // рендер «Расчёты ЗП» собирает тысячи скрытых DOM-узлов и заметно тормозит
  // (особенно на мобильном WebView).
  const salaryCalcCache = {};
  function salaryCalcKey(id, y, m0) { return `${id}:${y}:${m0}`; }
  function salaryCalcDaysHtml(entry) {
    if (!entry || !entry.rows || !entry.rows.length) return "";
    const hs = fmtCalcHours;
    return entry.rows.map((row) => {
      const dKey = dayKeyOf(row.date.getTime());
      // Дневная сумма с ПО-ДНЕВНЫМ множителем (повышенный тариф только в дни
      // периода, остальные ×1), согласовано с итогом employeeSalaryCalc.
      const dayMult = multiplierForDate(dKey, entry.id);
      const overPay = (row.over / 3600000) * entry.ratePerHour * dayMult;
      const dateStr = row.date ? row.date.toLocaleDateString("ru-RU", { day: "numeric", weekday: "short" }) : ("—" + row.day);
      // День, в который для этого сотрудника действовал повышенный тариф ×N:
      // подсвечиваем строку и показываем множитель рядом с датой.
      // Больничный «Б» / отпуск «ОТ»: помечаем день бейджем статуса и
      // подсвечиваем строку — отсутствие засчитано в часы явки.
      const paidIdle = row.st === "Б" || row.st === "ОТ";
      // Повышенный тариф ×N действует ТОЛЬКО при реальной явке (переработка),
      // а не в дни больничного/отпуска — у отсутствия нет переработки, поэтому
      // множитель там не показываем и не подсвечиваем строку как тарифную.
      const multBadge = (!paidIdle && dayMult > 1) ? ` <i class="mult-tag">×${dayMult}</i>` : "";
      const statusBadge = paidIdle ? `<span class="day-status-tag">${row.st}</span>` : "";
      return `<tr class="${!paidIdle && dayMult > 1 ? "mult-day" : ""} ${paidIdle ? "day-paid-idle" : ""}">
        <td data-label="День">${dateStr}${multBadge}${statusBadge}</td>
        <td class="num" data-label="Отработано">${hs(row.work)}</td>
        <td class="num ${row.over > 0 ? "over-pos" : ""}" data-label="Часы переработка">${row.over > 0 ? hs(row.over) : "—"}</td>
        <td class="num earn" data-label="За переработку">${fmtCalcMoney(overPay)}</td>
      </tr>`;
    }).join("");
  }

  // Были ли у этого сотрудника в выбранный месяц дни с повышенным тарифом ×N>1.
  function entryHasMultDays(entry) {
    return !!(entry && entry.rows && entry.rows.some((row) => {
      // Считаем только дни реальной явки — больничный/отпуск не тарифные.
      if (row.st === "Б" || row.st === "ОТ") return false;
      const dKey = dayKeyOf(row.date.getTime());
      return multiplierForDate(dKey, entry.id) > 1;
    }));
  }

  function renderSalaryCalc() {
    renderSalaryCalcMonthSelect();
    const val = el.salaryCalcMonth.value;
    if (!val || !el.salaryCalcList) return;
    const [y, m] = val.split("-").map(Number);
    const m0 = m - 1;
    const hs = fmtCalcHours;

    const calcRows = state.staff
      .filter((s) => !isInGodGroup(s.id))
      .map((s) => {
        const e = employeeSalaryCalc(s.id, y, m0);
        e.id = s.id;
        salaryCalcCache[salaryCalcKey(s.id, y, m0)] = e;
        return e;
      })
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));

    const list = el.salaryCalcList;
    if (calcRows.length === 0) {
      list.innerHTML = `<div class="salary-calc-none">Нет сотрудников для расчёта.</div>`;
      return;
    }
    // Плитки сотрудников показываем СРАЗУ с полным расчётом: норма месяца,
    // фактически отработанные часы, переработка и детализация по дням видны
    // сразу, не дожидаясь завершения месяца. Автокомпенсация (зачёт переработки
    // в недобор) применяется по завершении месяца — с 1-го числа нового,
    // логика в employeeSalaryCalc через isComplete/effectiveOverMs.
    list.innerHTML = calcRows.map((r) => {
      const overHead = true;
      const sumHead = true;
      // Дневная детализация строится ЛЕНИВО при раскрытии карточки
      // (salaryCalcDaysHtml из salaryCalcCache в click-обработчике), см. tbody.
      const totalOverPay = r.overEarn; // уже посчитано по дням в employeeSalaryCalc
      // У этого сотрудника в выбранный месяц были дни с повышенным тарифом ×N.
      const hasMult = entryHasMultDays(r);
      return `
      <article class="salary-calc-card${hasMult ? " has-mult" : ""}" data-skey="${r.id}">
        <header class="salary-calc-head">
          <strong class="salary-calc-name">${escapeHtml(r.name)}</strong>
          <span class="salary-calc-total">Зарплата: ${fmtCalcMoney(r.earned)}</span>
          <span class="salary-calc-chevron" aria-hidden="true">▸</span>
        </header>
        <div class="salary-calc-sub">${r.bizDays} раб. дн. · план ${hs(r.normMonthMs)} · ставка ${fmtCalcMoney(r.ratePerHour)}/ч${hasMult ? `<span class="mult-badge">есть дни ×N</span>` : ""}</div>
        <!-- Подробности скрыты по умолчанию: плитка → клик раскрывает. -->
        <div class="salary-calc-body" hidden>
          <div class="salary-calc-summary">
            <div class="salary-sum-card salary-sum-oklad"><span class="salary-sum-value">${fmtCalcMoney(r.salary)}</span><span class="salary-sum-label">Оклад</span></div>
            <div class="salary-sum-card"><span class="salary-sum-value">${fmtCalcMoney(r.overEarn)}</span><span class="salary-sum-label">За переработку</span></div>
            <div class="salary-sum-card"><span class="salary-sum-value">${fmtCalcMoney(r.bonus)}</span><span class="salary-sum-label">Премия</span></div>
            <div class="salary-sum-card"><span class="salary-sum-value">${fmtCalcMoney(r.extraBonus)}</span><span class="salary-sum-label">Надбавка</span></div>
            <div class="salary-sum-card"><span class="salary-sum-value">${hs(r.effectiveOverMs)}</span><span class="salary-sum-label">Переработка, время</span></div>
            <div class="salary-sum-card salary-sum-earned"><span class="salary-sum-value">${fmtCalcMoney(r.earned)}</span><span class="salary-sum-label">Заработано</span></div>
          </div>
          ${r.rows && r.rows.length ? `
          <div class="salary-calc-days-wrap">
            <table class="salary-calc-days">
              <thead>
                <tr><th>День</th><th class="num">Отработано</th><th class="num">Часы переработка</th><th class="num">За переработку</th></tr>
              </thead>
              <!-- Дневные строки подставляются лениво при раскрытии карточки. -->
              <tbody data-salary-lazy="1"></tbody>
              <tfoot>
                <tr><td data-label="Итого">Итого</td><td class="num" data-label="Отработано">${hs(r.totalWorkMs)}</td><td class="num over-pos" data-label="Часы переработка">${hs(r.totalOverMs)}</td><td class="num earn" data-label="За переработку">${fmtCalcMoney(totalOverPay)}</td></tr>
              </tfoot>
            </table>
          </div>` : `<div class="salary-calc-none">Нет отработанных дней за этот месяц.</div>`}
          <div class="salary-calc-grid">
            <div>Отработано (факт): <b>${hs(r.totalWorkMs)}</b></div>
            ${r.paidIdleDays ? `<div>Больничный · отпуск (${r.paidIdleDays} дн.): <b>${hs(r.paidIdleMs)}</b></div>` : ""}
            <div>Норма месяца (план): <b>${hs(r.normMonthMs)}</b></div>
            <div>Недобор: <b>${hs(r.deficitMs)}</b></div>
            <div>Переработка (суммарно): <b>${hs(r.totalOverMs)}</b></div>
            <div>Зачтено в недобор: <b>${hs(r.usedMs)}</b></div>
            <div>Переработка к оплате: <b>${hs(r.effectiveOverMs)}</b></div>
            <div>Премия: <b>${fmtCalcMoney(r.bonus)}</b></div>
            ${r.extraBonus ? `<div>Надбавка: <b>${fmtCalcMoney(r.extraBonus)}</b></div>` : ""}
            ${r.unpaidDays ? `<div>Не оплачены (${r.unpaidDays} дн.): <b>−${fmtCalcMoney(r.unpaidDeduct)}</b></div>` : ""}
            <div>Переработка к оплате, ₽: <b>${fmtCalcMoney(r.overEarn)}</b></div>
            <div>Ставка/час: <b>${fmtCalcMoney(r.ratePerHour)}</b></div>
          </div>
          ${(() => {
            const expl = buildSalaryExplanation(r);
            return expl ? `<p class="salary-calc-expl">${escapeHtml(expl)}</p>` : "";
          })()}
        </div>
      </article>`;
    }).join("");
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
    if (name === "notfound" && !canSeeNotfound()) name = "calendar";
    // Вкладка «Логи» — админ, модератор или сотрудник из «Параметры → Доступ к “Логи”».
    if (name === "logs" && !canSeeLogs()) name = "calendar";
    // Вкладка «Отчёты» — админ, модератор или сотрудник из «Параметры → Доступ к “Отчёты”».
    if (name === "reports" && !canSeeReports()) name = "calendar";
    el.pageTimer.hidden = name !== "timer";
    el.pageCalendar.hidden = name !== "calendar";
    el.pageLive.hidden = name !== "live";
    el.pageReport.hidden = name !== "report";
    el.pageDrivers.hidden = name !== "drivers";
    el.pageMyRoutes.hidden = name !== "myroutes";
    el.pageShipment.hidden = name !== "shipment";
    el.pageScanlog.hidden = name !== "scanlog";
    el.pageNotfound.hidden = name !== "notfound";
    if (el.pageLogs) el.pageLogs.hidden = name !== "logs";
    if (el.pageReports) el.pageReports.hidden = name !== "reports";
    el.pageDelivery.hidden = name !== "delivery";
    if (name === "logs") renderScansLog();
    if (name === "reports") renderReports();
    document.body.classList.remove("report-full", "live-full");
    // Отчёт — полноширинный на больших дисплеях: табель занимает весь экран.
    if (name === "report") document.body.classList.add("report-full");
    el.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    if (name === "calendar") renderCalendar();
    if (name === "live") { loadLive(); startLivePolling(); } else { stopLivePolling(); }
    if (name === "report") switchReportSubtab(state.reportSubtab || "timesheet");
    if (name === "drivers") renderDrivers();
    if (name === "myroutes") { renderMyRoutes(); startMyRoutesPolling(); } else { stopMyRoutesPolling(); }
    if (name === "shipment") {
      loadShipments(); // обновит кэш и (раз раздел теперь виден) отрисует
      if (typeof renderShipments === "function") renderShipments(); // гарантированно свежий список из кэша
      startShipmentPolling();
    } else { stopShipmentPolling(); }
    if (name === "scanlog") loadScanLog();
    if (name === "notfound") renderNotfound();
    if (name === "delivery") renderDeliveries();
  }

  // ---- Журнал сканирования мест (раздел «Журнал», виден всем) ----
  let scanlogFilterAction = "load"; // "load" (Погрузка) | "unload" (Выгрузка)
  let scanlogDateWaybill = dayKeyOf(Date.now()); // календарь «Сборка за дату»
  let scanlogMissingOnly = false; // под-вкладка «Не собрано» (только не найденные)
  // Состояние раскрытия дерева журнала сборки. Загружается из localStorage ОДИН раз
  // при старте и в сессии живёт в памяти (единственный источник) — перерисовки его
  // не сбрасывают, и раскрытый бокс не сворачивается сам.
  let _wblogState = (() => {
    try {
      const raw = localStorage.getItem("biotime_wblog_open");
      if (raw) return Object.assign({ clients: {}, boxes: {} }, JSON.parse(raw) || {});
    } catch { /* ignore */ }
    return { clients: {}, boxes: {} };
  })();
  // Позиция нажатия пальцем/мышью перед возможным скроллом: чтобы жест прокрутки,
  // начавшийся на заголовке бокса, не превращался браузером в «клик» и не схлопывал
  // развёрнутый бокс на тач-устройствах (ТСД/телефон).
  let _wbPointerStart = null;
  let scanlogSearchText = "";   // подстрока для поиска по клиенту
  let scanlogDateLoad = "";     // "YYYY-MM-DD" — дата отгрузки (погрузки); "" = все
  let scanlogDateUnload = "";   // "YYYY-MM-DD" — дата выгрузки; "" = все
  let scanlogEntries = [];      // последние записи, полученные с сервера
  // Сигнатура последней отрисованной выборки журнала. Автообновление (раз в
  // несколько секунд) НЕ перерисовывает дерево, если данные не изменились —
  // иначе полная перерисовка DOM сбрасывала прокрутку и раскрытые боксы,
  // и пользователь видел, что «бокс сам через пару секунд схлопнулся».
  let scanlogSignature = null;
  const scanlogSig = (entries) => {
    const parts = [];
    for (const e of entries) {
      parts.push([
        e && e.ts, e && e.action, e && e.client, e && e.bundleName, e && e.box,
        e && e.code, e && e.name, e && e.missing ? 1 : 0, e && e.userName, e && e.qty,
      ].join("|"));
    }
    parts.sort();
    return parts.join("\n");
  };
  async function loadScanLog() {
    try {
      const q = scanlogFilterAction ? `?action=${encodeURIComponent(scanlogFilterAction)}` : "";
      const r = await api(`/api/scanlog${q}`);
      const fresh = r.entries || [];
      const sig = scanlogSig(fresh);
      if (sig === scanlogSignature) return; // данных не изменилось — DOM не трогаем
      scanlogSignature = sig;
      scanlogEntries = fresh;
      renderScanLog(applyScanlogFilters(scanlogEntries));
    } catch {
      scanlogEntries = [];
      scanlogSignature = null;
      renderScanLog([]);
    }
  }
  // Применяет к записям журнала поиск по клиенту, тип действия (только активная
  // вкладка «Погрузка»/«Выгрузка») и соответствующую дату (отгрузка — для
  // погрузки, выгрузка — для выгрузки).
  function applyScanlogFilters(entries) {
    const q = scanlogSearchText.trim().toLowerCase();
    const isWaybill = scanlogFilterAction === "waybill";
    const activeAction = isWaybill ? "waybill" : (scanlogFilterAction === "unload" ? "unload" : "load");
    const activeDate = isWaybill ? scanlogDateWaybill : (activeAction === "load" ? scanlogDateLoad : scanlogDateUnload);
    return entries.filter((e) => {
      if (q && !String(e.client || "").toLowerCase().includes(q)) return false;
      if (e.action !== activeAction) return false;
      if (isWaybill && scanlogMissingOnly && !e.missing) return false;
      if (activeDate && e.ts && dayKeyOf(e.ts) !== activeDate) return false;
      return true;
    });
  }
  // Перерисовывает журнал уже загруженными записями с учётом текущих фильтров
  // (без обращения к серверу). Вызывается при изменении поиска и дат.
  function refreshScanlogView() {
    renderScanLog(applyScanlogFilters(scanlogEntries));
  }
  function renderScanLog(entries) {
    if (!el.scanlogTable) return;
    if (!entries || entries.length === 0) {
      el.scanlogTable.innerHTML = "";
      if (el.scanlogEmpty) el.scanlogEmpty.hidden = false;
      return;
    }
    if (el.scanlogEmpty) el.scanlogEmpty.hidden = true;
    const isWaybillView = scanlogFilterAction === "waybill";
    // Русские названия статусов мест в журнале (для складской погрузки/выгрузки).
    const STATUS_RU = { created: "Создана", loaded: "Отгружен", delivered: "Выгружен" };
    if (isWaybillView) {
      // Журнал «Сборка»: дерево Клиент → Бокс → Детали, чтобы не обрезать колонку «Бокс».
      const byClient = new Map();
      const clientMeta = new Map();
      for (const e of entries) {
        const key = String(e.bundleName || (e.client && e.client.trim()) || "Без клиента");
        let meta = clientMeta.get(key);
        if (!meta) {
          meta = {
            title: e.bundleName || e.client || "Без клиента",
            sub: (e.bundleName && Array.isArray(e.members) && e.members.length) ? e.members.join(", ") : "",
            who: new Set(), // кто собирал (имена операторов)
          };
          clientMeta.set(key, meta);
        }
        if (e.userName) meta.who.add(String(e.userName));
        if (!byClient.has(key)) byClient.set(key, new Map());
        const box = String(e.box || "без бокса");
        if (!byClient.get(key).has(box)) byClient.get(key).set(box, []);
        byClient.get(key).get(box).push(e);
      }
      function detailRow(e) {
        const miss = !!e.missing;
        // Партстикер позиции — сокращённой формой, как в сборке (ведущие нули урезаем).
        const ps = (e && e.partsticker) ? escapeHtml(shortPs(e.partsticker)) : "";
        // Детали в виде таблицы по столбцам: Время | ID(партстикер) | Артикул | Наименование | Кол-во/статус.
        return `<tr class="wb-log-detail${miss ? " wb-missing" : ""}">
          <td class="wbl-time">${e.ts ? fmtDateTimeSec(e.ts) : ""}</td>
          <td class="wbl-ps">${ps || "—"}</td>
          <td class="wbl-art">${escapeHtml(e.code || "—")}</td>
          <td class="wbl-name">${escapeHtml(e.name || "")}</td>
          <td class="wbl-qty">${miss ? "не найдено" : (Number(e.qty) || "—")}</td>
        </tr>`;
      }
      let html = "";
      let ci = 0;
      for (const [client, boxes] of byClient) {
        const meta = clientMeta.get(client) || { title: client, sub: "" };
        const clientOpen = !!_wblogState.clients[client];
        html += `<div class="wb-log-client" data-wlc="${ci}" data-wlc-key="${escapeHtml(client)}">
          <span class="wbl-arrow">${clientOpen ? "▾" : "▸"}</span>
          <span class="wbl-client">${escapeHtml(meta.title)}${meta.sub ? `<span class="wbl-client-sub"> · ${escapeHtml(meta.sub)}</span>` : ""}</span>
          <span class="wbl-count">(${[...boxes.values()].reduce((s, a) => {
            const seen2 = new Set(); let c = 0;
            for (const e of a) { const k = String(e.code || "—"); if (!seen2.has(k)) { seen2.add(k); c++; } }
            return s + c;
          }, 0)} поз.)</span>
          <span class="wbl-who">Собирал: ${escapeHtml([...(meta.who || [])].filter(Boolean).join(", ") || "—")}</span>
        </div>`;
        html += `<div class="wb-log-boxes" id="wbox-${ci}"${clientOpen ? "" : " hidden"}>`;
        const boxKeys = [...boxes.keys()].sort((a, b) => {
          const na = parseInt(waybillBoxNumber(a), 10) || 0;
          const nb = parseInt(waybillBoxNumber(b), 10) || 0;
          return na !== nb ? na - nb : String(a).localeCompare(String(b));
        });
        let bi = 0;
        for (const box of boxKeys) {
          const dets = boxes.get(box);
          const uniq = [];
          const seenP = new Set();
          for (const e of dets) {
            const k = String(e.code || "—");
            if (!seenP.has(k)) { seenP.add(k); uniq.push(e); }
          }
          const boxOpen = !!_wblogState.boxes[client + "::" + box];
          html += `<div class="wb-log-box" data-wlb="${ci}-${bi}" data-wlb-key="${escapeHtml(box)}">
            <span class="wbl-arrow">${boxOpen ? "▾" : "▸"}</span>
            <span class="wbl-box">Бокс: ${escapeHtml(waybillBoxName(box))}</span>
            <span class="wbl-count">(${uniq.length})</span>
          </div>`;
          html += `<div class="wb-log-details wb-tbl" id="wdet-${ci}-${bi}"${boxOpen ? "" : " hidden"}><table><thead><tr>
            <th class="wbl-time">Время</th><th class="wbl-ps">ID</th><th class="wbl-art">Артикул</th>
            <th class="wbl-name">Наименование</th><th class="wbl-qty">Кол-во</th>
          </tr></thead><tbody>${uniq.map(detailRow).join("")}</tbody></table></div>`;
          bi++;
        }
        html += `</div>`;
        ci++;
      }
      el.scanlogTable.innerHTML = `<tbody><tr><td colspan="7"><div class="wb-log">${html}</div></td></tr></tbody>`;
      return;
    }
    const rows = entries.map((e) => {
      const isLoad = e.action === "load";
      const actionLabel = isLoad ? "Погрузка" : (e.action === "unload" ? "Выгрузка" : (e.action || "—"));
      const placeLabel = e.place != null
        ? (e.totalPlaces != null ? `${e.place} из ${e.totalPlaces}` : String(e.place))
        : "—";
      const statusRu = e.status ? (STATUS_RU[e.status] || e.status) : "—";
      return `<tr>
        <td class="scanlog-time" data-label="Время">${e.ts ? fmtDateTimeSec(e.ts) : "—"}</td>
        <td class="scanlog-user" data-label="Пользователь">${escapeHtml(e.userName || "—")}</td>
        <td data-label="Действие"><span class="scanlog-action ${isLoad ? "load" : "unload"}">${escapeHtml(actionLabel)}</span></td>
        <td data-label="Клиент">${escapeHtml(e.client || "—")}</td>
        <td class="scanlog-place" data-label="Место">${escapeHtml(placeLabel)}</td>
        <td data-label="Статус">${escapeHtml(statusRu)}</td>
      </tr>`;
    }).join("");
    const thead = isWaybillView
      ? `<thead><tr><th>Дата/время</th><th>Оператор</th><th>Клиент</th><th>Позиция</th><th>Наименование</th><th>Бокс</th><th>Кол-во</th></tr></thead>`
      : `<thead><tr><th>Время</th><th>Пользователь</th><th>Действие</th><th>Клиент</th><th>Место</th><th>Статус</th></tr></thead>`;
    el.scanlogTable.innerHTML = thead + `<tbody>${rows}</tbody>`;
  }
  function fmtDateTimeSec(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // "Водители" page — clients and their addresses (map/geocoder added later).
  function renderDrivers() {
    // Эта страница теперь чисто админская (вкладка «Маршрутизация» доступна
    // только администраторам). Водители видят свои маршруты в разделе myroutes.
    if (el.driverRouteDate) el.driverRouteDate.value = el.driverRouteDate.value || dayKeyOf(Date.now());
    // Фильтр списка «Маршруты» по дате: по умолчанию — сегодня, чтобы в списке
    // не мешались маршруты соседних дней.
    if (el.driverRoutesDateFilter) el.driverRoutesDateFilter.value = el.driverRoutesDateFilter.value || dayKeyOf(Date.now());
    fillDriverRouteDriverSelect();
    updateRouteStepCount();
    loadDriverClients();
    loadDriverRoutes();
    // Восстанавливаем набранный черновик маршрута после подгрузки контрагентов
    // (id выбранных клиентов должны уже быть в кэше, чтобы выбор применился).
    setTimeout(restoreRouteDraft, 60);
  }

  // Внутренняя вкладка маршрутизации: «Контрагенты» / «Маршрут на день» / «Маршруты».
  function switchRouteSubtab(name) {
    const tabs = [
      { key: "contr", btn: el.subtabContr, panel: el.routesubContr },
      { key: "route", btn: el.subtabRoute, panel: el.routesubRoute },
      { key: "routes", btn: el.subtabRoutes, panel: el.routesubRoutes },
      { key: "report", btn: el.subtabReport, panel: el.routesubReport },
      { key: "location", btn: el.subtabLocation, panel: el.routesubLocation },
      { key: "1clog", btn: el.subtab1cLog, panel: el.routesub1cLog },
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
    // Отчёт «Местоположение»: наполняем список водителей и грузим данные.
    if (name === "location") {
      populateLocationDrivers();
      loadLocationReport();
    }
    if (name === "1clog") loadOnecLog();
  }

  // Логи заборов из 1С (что и когда забирали).
  // Сигнатура журнала: при опросе не перерисовываем список, если данные не
  // изменились — иначе вручную раскрытая строка состава сворачивалась бы
  // каждые 10 секунд автообновлением.
  let onecLogLastSig = null;
  async function loadOnecLog() {
    if (!el.oneclogBody) return;
    let rows = [];
    try { const r = await api("/api/1c/log"); rows = (r && Array.isArray(r.rows)) ? r.rows : []; } catch { rows = []; }
    const sig = JSON.stringify(rows.map((e) => [String(e && e.ts), String(e && e.inn), String(e && e.login), String(e && e.ok), String(e && e.number), String(e && e.posCount)]));
    if (sig === onecLogLastSig) return; // данные не изменились — не трогаем DOM
    onecLogLastSig = sig;
    const body = el.oneclogBody;
    body.innerHTML = "";
    if (el.oneclogStub) el.oneclogStub.style.display = rows.length ? "none" : "";
    if (!rows.length) return;
    const frag = document.createDocumentFragment();
    rows.slice().reverse().forEach((e) => {
      const tr = document.createElement("tr");
      const ok = !!(e && e.ok);
      const time = e && e.ts ? new Date(Number(e.ts) + (3 * 3600000)).toISOString().slice(11, 19) : "—";
      const result = ok ? ("Хорошо · " + ((e.reason) || "забрано")) : ("Пусто · " + ((e && e.reason) || "нет данных"));
      // Дополнительные пояснения: имя контрагента и человеко-читаемая причина
      // (пусто по ИНН, HTTP-код 1С, ошибка сети и т.п.), чтобы было видно, по
      // какому клиенту 1С ничего не нашла.
      const detail = [];
      if (e && e.clientName) detail.push("клиент: " + String(e.clientName));
      if (e && e.message) detail.push(String(e.message));
      const resultFull = detail.length ? (result + " (" + detail.join("; ") + ")") : result;
      const items = (e && Array.isArray(e.items) && e.items.length) ? e.items : [];
      // Успешная запись с составом — клик раскрывает список позиций.
      if (items.length) {
        tr.style.cursor = "pointer";
        tr.addEventListener("click", () => {
          const sub = tr.nextElementSibling;
          if (sub) sub.hidden = !sub.hidden;
        });
      }
      tr.innerHTML =
        `<td>${escapeHtml(time)}</td>` +
        `<td>${escapeHtml((e && e.inn) || "—")}</td>` +
        `<td>${escapeHtml((e && e.login) || "—")}</td>` +
        `<td>${escapeHtml((e && e.number) || "—")}</td>` +
        `<td>${escapeHtml(String((e && e.posCount) != null ? e.posCount : "—"))}</td>` +
        `<td>${escapeHtml(resultFull)}</td>` +
        `<td style="width:38px;text-align:center;vertical-align:middle;padding:4px 6px"><button type="button" class="icon-btn" data-1clog-del="${escapeHtml(String((e && e.id) || ""))}" title="Удалить из лога (позволит забрать накладную повторно)">✕</button></td>`;
      frag.appendChild(tr);
      const sub = document.createElement("tr");
      sub.hidden = true;
      const itemRows = items.map((it) =>
        `<tr>
           <td style="padding:3px 10px;white-space:nowrap">${escapeHtml(shortPs((it && it.partsticker) || "") || "—")}</td>
           <td style="padding:3px 10px;white-space:nowrap">${escapeHtml(String((it && it.art) || ""))}</td>
           <td style="padding:3px 10px">${escapeHtml(String((it && it.name) || ""))}</td>
           <td style="padding:3px 10px;text-align:right;white-space:nowrap">${escapeHtml(String((it && it.qty) != null ? it.qty : ""))} шт</td>
         </tr>`
      ).join("");
      sub.innerHTML = `<td colspan="7"><table class="oneclog-items" style="width:100%;border-collapse:collapse;font-size:12px;color:var(--text-2,#aaa)">
        <thead><tr style="font-size:10px;color:#777;text-transform:uppercase;letter-spacing:.04em">
          <th style="padding:3px 10px;text-align:left">Партстикер</th>
          <th style="padding:3px 10px;text-align:left">Артикул</th>
          <th style="padding:3px 10px;text-align:left">Наименование</th>
          <th style="padding:3px 10px;text-align:right">Кол-во</th>
        </tr></thead>
        <tbody>${itemRows || ""}</tbody>
      </table></td>`;
      frag.appendChild(sub);
    });
    body.appendChild(frag);
    // Удаление записи из журнала (снимает защиту от дублей — можно забрать заново).
    body.querySelectorAll("[data-1clog-del]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const id = btn.getAttribute("data-1clog-del");
        if (!id) return;
        try { await api("/api/1c/log/delete", { method: "POST", body: JSON.stringify({ id }) }); } catch { /* ignore */ }
        onecLogLastSig = null;
        loadOnecLog();
      });
    });
  }

  // Наполняет селект «Водитель» в отчёте «Местоположение» (из state.staff).
  function populateLocationDrivers() {
    if (!el.locationDriverSelect) return;
    const prev = el.locationDriverSelect.value;
    // Только пользователи группы «Водители» (как в селекте водителя маршрута);
    // остальные сотрудники не выводятся.
    const driverGroup = (Array.isArray(state.groups) ? state.groups : [])
      .find((g) => /водител/i.test(String(g.name || "")));
    const ids = driverGroup && Array.isArray(driverGroup.memberIds) ? new Set(driverGroup.memberIds) : null;
    const allStaff = Array.isArray(state.staff) ? state.staff : [];
    const staff = ids ? allStaff.filter((s) => ids.has(String(s.id))) : allStaff;
    const options = staff
      .slice()
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
      .map((s) => `<option value="${escapeHtml(String(s.id))}">${escapeHtml(s.name || "—")}</option>`)
      .join("");
    el.locationDriverSelect.innerHTML = options || '<option value="">—</option>';
    if (prev && [...el.locationDriverSelect.options].some((o) => o.value === prev)) {
      el.locationDriverSelect.value = prev;
    }
    if (!el.locationDateFilter) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(el.locationDateFilter.value || "")) {
      el.locationDateFilter.value = dayKeyOf(Date.now());
    }
    // Восстанавливаем сохранённый интервал (по умолчанию 15 мин).
    if (el.locationInterval) {
      try {
        const saved = localStorage.getItem("biotime_location_interval");
        if (saved && [...el.locationInterval.options].some((o) => o.value === saved)) {
          el.locationInterval.value = saved;
        }
      } catch { /* ignore */ }
    }
  }

  // Отчёт «Местоположение»: где был водитель за календарный день, шаг 15 минут.
  async function loadLocationReport() {
    if (!el.locationBody || !el.locationDriverSelect) return;
    if (el.locationStub) el.locationStub.style.display = "none";
    const driverId = el.locationDriverSelect.value;
    const date = el.locationDateFilter ? el.locationDateFilter.value : "";
    if (!driverId || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      if (el.locationTableWrap) el.locationTableWrap.hidden = true;
      if (el.locationStub) el.locationStub.style.display = "";
      return;
    }
    const interval = el.locationInterval ? (Number(el.locationInterval.value) || 15) : 15;
    let data = null;
    try {
      data = await api("/api/drivers/location-report?date=" + encodeURIComponent(date) +
        "&driverId=" + encodeURIComponent(driverId) +
        "&interval=" + encodeURIComponent(String(interval)));
    } catch { data = null; }
    const rows = (data && data.rows) || [];
    const body = el.locationBody;
    body.innerHTML = "";
    if (el.locationStub) el.locationStub.style.display = rows.length ? "none" : "";
    if (el.locationTableWrap) el.locationTableWrap.hidden = !rows.length;
    if (!rows.length) return;
    const frag = document.createDocumentFragment();
    rows.forEach((r) => {
      const tr = document.createElement("tr");
      const speedTxt = (r.speed != null) ? `${r.speed} км/ч` : "—";
      tr.innerHTML =
        `<td>${escapeHtml(r.time || "—")}</td>` +
        `<td>${r.address ? escapeHtml(r.address) : "—"}</td>` +
        `<td>${escapeHtml(speedTxt)}</td>`;
      frag.appendChild(tr);
    });
    body.appendChild(frag);
  }

  // ---- Живая карта водителей (вкладка «Отчёт» маршрутизации) ----
  // Подключает Yandex JS API (ключ из /api/maps/config), рисует маршруты и точки,
  // а поверх — живые координаты водителей (из /api/drivers/location). Обновляется
  // автоматически, пока вкладка открыта.
  let driverMap = null;
  let driverMapScript = null;
  let driverMapTimer = null;
  let yandexPreload = null;
  async function ensureYandexPreloaded() {
    if (yandexPreload && yandexPreload.promise) return;
    let cfg = {};
    try { cfg = await api("/api/maps/config"); } catch { /* конфиг недоступен */ }
    const key = (cfg && cfg.yandexKey) || "";
    const promise = loadYandexMaps(key);
    yandexPreload = { cfg, promise };
    promise.catch(() => {});
  }
  function preloadYandexMaps() { ensureYandexPreloaded().catch(() => {}); }
  let driverMapFitted = false;
  let driverLiveMarks = {};      // id водителя -> ymaps.Placemark (зелёная метка)
  let driverRoutesSig = "";
  let driverRoutesReady = false;
  let driverRoutesDueAt = 0;
  let driverRoutesLoading = false;
  let driverTrackCollection = null;   // GeoObjectCollection следа; создаётся с картой
  let driverTracksDueAt = 0;
  let driverTracks = {};
  let driverTracksSnapped = {};
  let driverClientMarks = {};         // id клиента -> ymaps.Placemark (серый маркер)
  let driverClientsDueAt = 0;
  let driverClientsLoading = false;
  let driverClientSig = "";
  let driverClientClusterer = null;   // ymaps.Clusterer — группирует маркеры клиентов

  function loadYandexMaps(apikey) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      if (window.ymaps && window.ymaps.Map) { resolve(window.ymaps); return; }
      if (driverMapScript) {
        const t = setInterval(() => {
          if (window.ymaps && window.ymaps.Map) { clearInterval(t); resolve(window.ymaps); }
        }, 250);
        setTimeout(() => { clearInterval(t); done(reject, new Error("Карта не загрузилась за отведённое время")); }, 25000);
        return;
      }
      if (!apikey) { done(reject, new Error("Нет ключа Яндекс.Карт — карта недоступна")); return; }
      driverMapScript = document.createElement("script");
      driverMapScript.src = "https://api-maps.yandex.ru/2.1/?apikey=" + encodeURIComponent(apikey) + "&lang=ru_RU";
      driverMapScript.onload = () => {
        if (window.ymaps && window.ymaps.ready) {
          const tm = setTimeout(() => {
            done(reject, new Error("Яндекс.Карты не инициализировались (похоже, ключ карт не разрешает этот домен: " + window.location.hostname + ")"));
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
      await ensureYandexPreloaded();
      const ymaps = await yandexPreload.promise;
      if (!driverMap) {
        // Контейнер мог быть нулевой высоты в момент инициализации (вкладка ещё
        // не дорисовала layout) — тогда Яндекс.Карты не запрашивают тайлы и карта
        // пустая. Назначаем высоту явно, если она ещё 0.
        if (el.driverMap && el.driverMap.clientHeight <= 0) el.driverMap.style.height = "460px";
        driverMap = new ymaps.Map(el.driverMap, {
          center: [55.75, 37.62], zoom: 10,
          controls: ["zoomControl", "fullscreenControl"],
        });
        driverTrackCollection = new ymaps.GeoObjectCollection();
        driverMap.geoObjects.add(driverTrackCollection);
        driverClientClusterer = new ymaps.Clusterer({
          preset: "islands#invertedGreyClusterIcons",
          clusterDisableClickZoom: false,
          gridSize: 48,
          minClusterSize: 2,
        });
        driverMap.geoObjects.add(driverClientClusterer);
        driverTracksDueAt = 0;
      }
      try { driverMap.container.fitToViewport(); } catch { /* ignore */ }
      if (el.driverMapHint) el.driverMapHint.textContent = "";
      try { await refreshDriverMap(ymaps); } catch { /* не роняем приёмку карты у маркеров */ }
      if (!driverMapTimer) {
        driverMapTimer = setInterval(() => {
          if (el.routesubTracking && !el.routesubTracking.hidden) {
            try { refreshDriverMap(ymaps); } catch { /* ignore */ }
          }
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
        const m = driverLiveMarks[id];
        if (m) { const g = m && m.geometry; if (g) pts.push(g.getCoordinates()); }
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
      const addr = (c.bundleAddress || c.address || "").trim();
      const balloon = `<b>${escapeHtml(c.client || "Клиент")}</b>${addr ? `<br>${escapeHtml(addr)}` : ""}`;
      const mark = driverClientMarks[id];
      if (mark) {
        const g = mark.geometry && mark.geometry.getCoordinates();
        if (!g || g[0] !== c.lat || g[1] !== c.lon) {
          try { mark.geometry.setCoordinates([c.lat, c.lon]); } catch { /* ignore */ }
        }
        try { mark.properties.set("hintContent", hint); } catch { /* ignore */ }
        try { mark.properties.set("balloonContentBody", balloon); } catch { /* ignore */ }
      } else {
        driverClientMarks[id] = new ymaps.Placemark(
          [c.lat, c.lon], { hintContent: hint, balloonContentBody: balloon }, { preset: "islands#redCircleDotIcon" }
        );
      }
    });
    Object.keys(driverClientMarks).forEach((id) => {
      if (!seen.has(id) && driverClientMarks[id]) { delete driverClientMarks[id]; }
    });
    const newSig = Object.keys(driverClientMarks).sort().map((id) => {
      const m = driverClientMarks[id];
      const g = m && m.geometry ? m.geometry.getCoordinates() : null;
      return id + ":" + (g ? g[0].toFixed(4) + "," + g[1].toFixed(4) : "");
    }).join("|");
    if (newSig !== driverClientSig) {
      driverClientSig = newSig;
      if (driverClientClusterer) { try { driverClientClusterer.removeAll(); driverClientClusterer.add(Object.values(driverClientMarks)); } catch { /* ignore */ } }
    }
  }

  // Статичный слой карты: базы, клиенты и полилинии пройденного пути. Строится
  // только при изменении набора/статуса маршрутов — дорогая операция, поэтому её
  // выполняем редко, а не на каждом тике автообновления.
  function drawDriverRouteLayers(ymaps, routes) {
    if (!driverMap) return;
    driverMap.geoObjects.removeAll();
    if (driverTrackCollection) driverMap.geoObjects.add(driverTrackCollection);
    Object.keys(driverLiveMarks).forEach((id) => {
      if (driverLiveMarks[id]) driverMap.geoObjects.add(driverLiveMarks[id]);
    });
    if (driverClientClusterer) driverMap.geoObjects.add(driverClientClusterer);
    routes.forEach((route) => {
      const base = route.progress;
      if (base && Number.isFinite(base.baseLat) && Number.isFinite(base.baseLon)) {
        driverMap.geoObjects.add(new ymaps.Placemark(
          [base.baseLat, base.baseLon],
          { hintContent: "База · " + (route.driverName || ""), balloonContentBody: `<b>База</b>${route.driverName ? `<br>${escapeHtml(route.driverName)}` : ""}` },
          { preset: "islands#darkBlueDotIcon" }
        ));
      }
      (route.clients || []).forEach((c) => {
        if (Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
          const addr = (c.address || "").trim();
          const balloon = `<b>${escapeHtml(c.client || "Точка")}</b>${addr ? `<br>${escapeHtml(addr)}` : ""}`;
          driverMap.geoObjects.add(new ymaps.Placemark(
            [c.lat, c.lon], { hintContent: c.client || "Точка", balloonContentBody: balloon }, { preset: "islands#blueDotIcon" }
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
      const spd = (d.speed != null && Number.isFinite(d.speed)) ? ` · ${Number(d.speed).toFixed(0)} км/ч` : "";
      const hint = (d.name || "Водитель") + " · на карте" + label + spd;
      const balloon = `<b>${escapeHtml(d.name || "Водитель")}</b><br>на карте${label ? escapeHtml(label) : ""}${escapeHtml(spd)}`;
      let m = driverLiveMarks[d.id];
      if (m) {
        try { m.geometry.setCoordinates([d.lat, d.lon]); } catch { /* ignore */ }
        try { m.properties.set("hintContent", hint); } catch { /* ignore */ }
        try { m.properties.set("balloonContentBody", balloon); } catch { /* ignore */ }
      } else {
        m = new ymaps.Placemark([d.lat, d.lon], { hintContent: hint, balloonContentBody: balloon }, { preset: "islands#greenCircleDotIcon" });
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
    driverTracksSnapped = {};
    tracks.forEach((o) => {
      if (o && o.id && Array.isArray(o.track)) {
        driverTracks[o.id] = o.track;
        driverTracksSnapped[o.id] = !!o.snapped;
      }
    });
    drawDriverTracks(ymaps);
    updateDriverTrackStatus();
  }

  // Диагностика дорожных треков была полезна, когда линии следа отрисовывались.
  // Сейчас линии убраны по запросу, поэтому чип «по дорогам: N» больше не
  // показывается — он сообщал о тех самых линиях, которых на карте нет.
  function updateDriverTrackStatus() {
    if (el.driverTrackStatus) el.driverTrackStatus.hidden = true;
  }

  // Следы движения водителей. По запросу пользователя линии следа (как «сырые»
  // GPS-ломанные, так и дорожные) полностью убраны с карты «Трекинг»: карта
  // показывает только живые метки водителей и точки клиентов. Данные треков
  // по-прежнему грузятся (нужны для отчёта о пробеге), но не отрисовываются.
  // Рисует маршрут водителя ПО ДОРОГАМ (как в навигаторе). Сервер уже возвращает
  // snapped-трек (map-matching по дорожной сети, /api/drivers/tracks/snapped) —
  // рисуем именно его, координаты идут по дорогам и дают ровную линию. Если по
  // какой-то причине snapped отсутствует — рисуем сырые координаты (ломаной).
  function drawDriverTracks(ymaps) {
    if (!driverMap || !driverTrackCollection) return;
    const coll = driverTrackCollection;
    try { coll.removeAll(); } catch { /* ignore */ }
    // Линии (дорожные «полосы» движения) по запросу больше не рисуем —
    // коллекцию очищаем, чтобы старые линии не оставались на карте.
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
    const siteSec = rows.reduce((s, r) => s + (r.siteSec || 0), 0);
    const lunchSec = rows.reduce((s, r) => s + (r.lunchSec || 0), 0);
    if (el.motionDrivers) el.motionDrivers.textContent = String(rows.length);
    if (el.motionKm) el.motionKm.textContent = String(Math.round(km * 10) / 10);
    if (el.motionMove) el.motionMove.textContent = fmtHms(moveSec);
    if (el.motionSite) el.motionSite.textContent = fmtHms(siteSec);
    if (el.motionLunch) el.motionLunch.textContent = fmtHms(lunchSec);
    // Таблица.
    const body = el.motionBody;
    if (!body) return;
    // Сохраняем раскрытые строки (по id водителя), чтобы перестройка таблицы
    // (например, при выборе другой даты) не сворачивала их самих.
    const openedBefore = new Set();
    body.querySelectorAll("tr.motion-row.is-open").forEach((tr) => {
      const did = tr.getAttribute("data-driver-id");
      if (did) openedBefore.add(did);
    });
    body.innerHTML = "";
    if (el.driverReportStub) el.driverReportStub.style.display = rows.length ? "none" : "";
    if (!rows.length) return;
    const frag = document.createDocumentFragment();
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.className = "motion-row";
      tr.setAttribute("data-driver-id", String(r.id != null ? r.id : ""));
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
      // Детальная статистика по маршрутам водителя (раскрывается кликом).
      const routes = (r.routes && r.routes.length) ? r.routes : [];
      const detailHtml = routes.length
        ? `<div class="motion-route-detail">
             <div class="motion-route-title">Маршруты за день</div>
             <table class="report-table motion-route-table">
               <thead><tr><th>Маршрут</th><th>В пути</th><th>Сдача</th><th>Обед</th><th>Сдал</th><th>В пути</th><th>Мест</th></tr></thead>
               <tbody>${routes.map((rt, mi) => {
                 const cliRows = (rt.clients && rt.clients.length)
                   ? `<tr class="route-clients-row" data-route-client-idx="${mi}"><td colspan="7">
                       <table class="report-table motion-clients-table">
                         <thead><tr><th>Клиент</th><th>Километраж</th><th>В пути</th><th>Сдача</th><th>Мест сдано</th></tr></thead>
                         <tbody>${rt.clients.map((cl) => {
                           // В колонке «Клиент» показываем только название точки:
                           // «Единое название» связки, если задано, иначе имя клиента.
                           // Адрес точки в отчёте маршрутизации не выводится.
                           const label = cl.bundleName || cl.client || "—";
                           return `<tr>
                             <td>
                               <span class="motion-client-name">${escapeHtml(label)}</span>
                             </td>
                           <td>${cl.km || 0}</td>
                           <td>${fmtHms(cl.moveSec || 0)}</td>
                           <td>${fmtHms(cl.siteSec || 0)}</td>
                           <td>${(cl.placesDone || 0)} / ${(cl.placesTotal || 0)}</td>
                         </tr>`;
                         }).join("")}</tbody>
                       </table>
                     </td></tr>`
                   : "";
                 return `<tr class="motion-route-row">
                   <td>${escapeHtml(rt.name || "Маршрут")}</td>
                   <td>${fmtHms(rt.moveSec || 0)}</td>
                   <td>${fmtHms(rt.siteSec || 0)}</td>
                   <td>${fmtHms(rt.lunchSec || 0)}</td>
                   <td>${(rt.cliDelivered || 0)} из ${(rt.cliTotal || 0)}</td>
                   <td>${rt.cliInTransit || 0}</td>
                   <td>${rt.places || 0}</td>
                 </tr>${cliRows}`;
               }).join("")}</tbody>
             </table>
           </div>`
        : `<div class="motion-route-detail empty">Нет деталей по маршрутам</div>`;
      const detail = document.createElement("tr");
      detail.className = "motion-detail";
      detail.style.display = "none";
      detail.innerHTML = `<td colspan="7">${detailHtml}</td>`;
      tr.addEventListener("click", () => {
        const open = detail.style.display !== "none";
        detail.style.display = open ? "none" : "";
        tr.classList.toggle("is-open", !open);
      });
      frag.appendChild(tr);
      frag.appendChild(detail);
    });
    body.appendChild(frag);
    // Восстанавливаем раскрытые строки после перестройки.
    openedBefore.forEach((id) => {
      const tr = body.querySelector(`tr.motion-row[data-driver-id="${CSS.escape(String(id))}"]`);
      const detail = tr && tr.nextElementSibling;
      if (tr && detail && detail.classList && detail.classList.contains("motion-detail")) {
        detail.style.display = "";
        tr.classList.add("is-open");
      }
    });
  }

  // Динамически показываем/скрываем вкладки «Мои маршруты» и «Маршрутизация»
  // при изменении ролей или переключении настроек — без перезагрузки страницы.
  function refreshNavTabs() {
    if (!el.tabs) return;
    // Роль «Погрузка» — погрузочный терминал: видна «Отгрузка» и «Журнал»
    // (scanlog — журнал сканирования мест, нужен складу). Все остальные
    // (Табель/ЗП, Эфир, Доставка, Маршрутизация и т.д.) скрыты.
    if (state.isLoader) {
      el.tabs.querySelectorAll(".tab").forEach((t) => {
        const isShipment = t.classList.contains("shipment-only");
        const isLog = t.dataset.tab === "scanlog"; // «Журнал» доступен погрузке
        t.classList.toggle("admin-visible", isShipment || isLog);
        t.hidden = !(isShipment || isLog);
      });
      return;
    }
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
          <div class="bundle-card-name">
            <label class="drv-field-label" for="">Единое название</label>
            <div class="bundle-name-row">
              <input class="text-input bundle-name-input" type="text" data-bundle="${escapeHtml(g.bundleId)}" placeholder="Покажется в отгрузке вместо адреса" value="${escapeHtml((g.members.find((m) => m.bundleName) || {}).bundleName || "")}" />
              <button type="button" class="drv-mini-btn bundle-name-save" data-bundle="${escapeHtml(g.bundleId)}">Сохранить</button>
            </div>
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
    el.bundleList.querySelectorAll(".bundle-name-save").forEach((b) => {
      b.addEventListener("click", () => {
        const bundleId = b.dataset.bundle;
        const inp = el.bundleList.querySelector(`.bundle-name-input[data-bundle="${bundleId}"]`);
        saveBundleName(bundleId, inp && inp.value);
      });
    });
  }

  // Задаёт/меняет единое название уже существующей связки (всем её участникам).
  async function saveBundleName(bundleId, name) {
    const n = String(name || "").trim().slice(0, 200);
    if (!bundleId) return;
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ action: "bundle-name", bundleId, name: n }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      refreshBundleUi();
      toast(n ? "Название связки сохранено" : "Название связки убрано");
    } catch (e) {
      toast(e.message);
    }
  }

  function refreshBundleUi() {
    renderBundlePick();
    renderBundleList();
  }

  async function createBundle() {
    const ids = [...bundlePick];
    const address = (el.bundleAddress && el.bundleAddress.value || "").trim();
    const name = (el.bundleName && el.bundleName.value || "").trim();
    if (ids.length < 2) { toast("Выберите хотя бы двух контрагентов"); return; }
    if (!address) { toast("Укажите общий адрес связки"); return; }
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ action: "bundle", ids, address, name }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      bundlePick.clear();
      if (el.bundleAddress) el.bundleAddress.value = "";
      if (el.bundleName) el.bundleName.value = "";
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
        // Причина переноса (если указана) — видна диспетчеру в разделе «Доставка».
        // Раньше здесь причина не выводилась, хотя в данных она есть.
        const reason = (c.postponeReason && String(c.postponeReason).trim())
          ? `<div class="rms-stop-postpone-reason">Перенос: ${escapeHtml(c.postponeReason)}</div>`
          : "";
        const transit = (c.transitEnd && c.transitStart)
          ? (c.transitEnd - c.transitStart - (Number.isFinite(c.transitPaused) ? c.transitPaused : 0)) : null;
        const site = (c.siteEnd && c.siteStart) ? (c.siteEnd - c.siteStart) : null;
        timerHtml = `<div class="rms-stop-times">
          <span>Путь: ${fmtDuration(transit)}</span>
          <span>На точке: ${fmtDuration(site)}</span>
        </div>${reason}`;
      }
      const activeCls = (i === activeIdx && (st === "in_transit" || st === "on_site")) ? " is-active" : "";
      // Счётчик мест клиента: сколько выгружено / сколько всего (если места есть).
      const places = (Number.isFinite(c.placesTotal) && c.placesTotal > 0)
        ? `<span class="rms-stop-places${c.placesDone === c.placesTotal ? " is-full" : ""}"
             title="Выгружено мест / всего">${c.placesDone} / ${c.placesTotal}</span>`
        : "";
      return `
        <div class="rms-stop${activeCls}">
          <div class="rms-stop-top">
            <span class="rms-stop-idx">${i + 1}</span>
            <span class="rms-stop-name">${escapeHtml((c.members && c.members.length) ? (c.bundleName || c.address || c.client || "Связка") : (c.client || ""))} ${timeLine} ${places}</span>
          </div>
          ${c.address ? `<div class="rms-stop-addr">${escapeHtml(c.address)}</div>` : ""}
          ${timerHtml}
        </div>
      `;
    }).join("");

    const dateStr = d.date ? fmtDateReadable(d.date) : "—";
    const slot = d.routeName ? `Маршрут ${d.routeName}` : "Маршрут";
    // Общий счётчик мест по маршруту: сколько выгружено / сколько всего.
    const routePlaces = (Number.isFinite(d.placesTotal) && d.placesTotal > 0)
      ? `<span class="delivery-places-count" title="Выгружено мест / всего">${d.placesDone} / ${d.placesTotal}</span>`
      : "";
    // Активный маршрут (водитель в пути, точка не закрыта) свернуть нельзя.
    const dActive = p === "active";
    const collapseBtn = dActive
      ? `<button type="button" class="delivery-collapse route-collapse is-locked" disabled title="Активный маршрут нельзя свернуть">▾</button>`
      : `<button type="button" class="delivery-collapse route-collapse" data-route-collapse title="Свернуть/развернуть">▸</button>`;
    // По умолчанию неактивные маршруты свёрнуты, но если водитель вручную
    // развернул карточку (expandedShipmentCards), она ДОЛЖНА остаться раскрытой
    // и при последующих перерисовках (автообновление раз в N сек) — иначе карточка
    // «сама схлопывается» через пару секунд. Активный маршрут всегда раскрыт.
    const dExpanded = !dActive && expandedShipmentCards.has(String(d.routeId));
    const dCollapsed = dActive ? "" : (dExpanded ? "" : " route-collapsed");
    return `
      <div class="delivery-card${dCollapsed}" data-route-id="${escapeHtml(String(d.routeId))}">
        <div class="delivery-card-head">
          <div class="delivery-driver">
            <span class="delivery-driver-name">${escapeHtml(d.driverId ? (d.driverName || "Водитель") : "Маршрут: Самовывоз")}</span>
            <span class="delivery-driver-route">${escapeHtml(slot)} · ${escapeHtml(dateStr)} ${routePlaces}</span>
          </div>
          ${statusBadge}
          ${collapseBtn}
        </div>
        <div class="route-collapsible"${dActive || dExpanded ? "" : " hidden"}>${stops}</div>
      </div>
    `;
  }

  // Водительский раздел «Мои маршруты»: показывает только маршруты текущего
  // водителя (сервер уже фильтрует по user.id), с фильтром по дате.
  let myRoutesCache = [];
  // Сигнатура последнего отрисованного набора маршрутов: если автообновление
  // (polling раз в 5 с) не видит изменений, мы НЕ перестраиваем DOM, — благодаря
  // этому раскрытые карточки маршрута не «схлопываются» сами через пару секунд.
  let lastMyRoutesSig = "";
  // Пока идёт запрос изменения порядка точек (reorder), фоновый опрос не должен
  // перезаписывать список и перерисовывать окно — иначе карточки «мигают».
  let suppressMyRoutesRepaint = false;
  function renderMyRoutes() {
    if (el.myroutesDateFilter) el.myroutesDateFilter.value = el.myroutesDateFilter.value || dayKeyOf(Date.now());
    loadMyRoutes();
  }

  async function loadMyRoutes(silent) {
    try {
      const r = await api("/api/drivers/routes"); // server returns only this driver's routes
      if (r && Array.isArray(r.routes)) {
        const sig = JSON.stringify(r.routes.map((x) => {
          // В сигнатуру обязательно включаем счётчики выгрузки мест по каждой
          // точке (unloadDone/unloadTotal/unloadFinished) и счётчик обработанных
          // мест маршрута (placesDone/placesTotal): иначе после сканирования мест
          // водитель видит устаревшее «Выгружено X из Y», пока signal не пробьёт
          // перерисовку (например, до нажатия «Завершить выгрузку»).
          const cl = (x.clients || []).map((c) => {
            if (!c) return "";
            return [c.state || c.status, c.unloadDone ?? "", c.unloadTotal ?? "",
                    c.unloadFinished ? "f" : "", c.bundleName || ""].join(":");
          }).join(",");
          return [x.id, x.date, x.status, x.placesDone, x.placesTotal, cl].join("|");
        }));
        if (!silent && sig === lastMyRoutesSig) return; // не изменилось — не перерисовываем
        myRoutesCache = r.routes;
        lastMyRoutesSig = sig;
        persistMyRoutes(); // свежие данные маршрута — в localStorage для офлайн-старта
        if (!silent) renderMyRoutesList(myRoutesCache);
      }
    } catch {
      // Нет сети (офлайн-старт или связь пропала). Если данных в памяти ещё нет —
      // поднимаем закешированный маршрут, чтобы водитель видел кнопки и мог
      // продолжать работу офлайн (нажатия уйдут в офлайн-очередь при появлении сети).
      if (!Array.isArray(myRoutesCache) || myRoutesCache.length === 0) {
        const cached = hydrateMyRoutes();
        if (cached) {
          myRoutesCache = cached;
          if (!silent) renderMyRoutesList(myRoutesCache);
        }
      }
    }
  }

  function renderMyRoutesList(routes) {
    const filter = el.myroutesDateFilter ? el.myroutesDateFilter.value : "";
    // Маршруты самовывоза (без назначенного водителя) в «Моих маршрутах» не показываем —
    // водителю видны только маршруты, назначенные на него.
    const mine = (Array.isArray(routes) ? routes : []).filter((r) => r && r.driverId);
    const list = filter ? mine.filter((r) => String(r.date) === filter) : mine;
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
    // Стрелки изменения порядка точек в активном маршруте (см. reorderRoutePoint).
    el.myroutesList.querySelectorAll("[data-route-reorder]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const dir = btn.dataset.routeReorder; // "up" | "down"
        reorderRoutePoint(btn.dataset.routeId, btn.dataset.clientId, dir);
      });
    });
    // Живые счётчики: немедленно отрисовать текущие значения и запустить
    // единый секундный тикер (если ещё не запущен).
    refreshLiveRouteNodes();
    startLiveRouteTicker();
    tickLiveRouteTimers();
  }

  // Мягкая перерисовка «Моих маршрутов» после смены порядка точек: отключаем
  // CSS-переходы на время пересоздания DOM, чтобы карточки не «мигали»
  // (не подсвечивались) при обновлении. После отрисовки одного кадра возвращаем
  // переходы обратно.
  function repaintMyRoutesQuietly() {
    if (!el.myroutesList) return;
    el.myroutesList.classList.add("no-anim");
    renderMyRoutesList(myRoutesCache);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.myroutesList.classList.remove("no-anim");
      });
    });
  }

  // ---- Отгрузка (склад) ----
  // Показывает маршруты водителей, ожидающие отгрузки. Склад завершает отгрузку
  // одной кнопкой — после этого водитель может начать маршрут (если админ не
  // разрешил игнорировать склад).
  let shipmentsCache = [];
  // Сигнатура последнего отрисованного набора отгрузок: если автообновление
  // (polling раз в 5 с) не видит изменений, раздел не перестраивается — раскрытые
  // карточки отгрузки не «схлопываются» сами через пару секунд.
  let lastShipmentsSig = "";
  // Койлдаун запросов отгрузки: при пачке событий (скан + SSE + таймер) реально
  // ходим на сервер не чаще ~1,5 с, а лишние вызовы схлопываются в один. Это снижает
  // сетевую нагрузку и тормоза на слабом ТСД.
  let lastShipmentsFetch = 0;
  let shipmentsFetchQueued = false;
  // Подвкладка раздела «Отгрузка»: "active" — маршруты в работе, "done" — завершённые.
  let shipmentSubtab = "active";

  async function loadShipments() {
    if (!el.shipmentListActive) return;
    const now = Date.now();
    const wait = 1500 - (now - lastShipmentsFetch);
    if (wait > 0) {
      // Уже был недавний запрос — откладываем накопленный запрос на крайний срок.
      if (!shipmentsFetchQueued) {
        shipmentsFetchQueued = true;
        setTimeout(() => { shipmentsFetchQueued = false; loadShipments(); }, wait);
      }
      return;
    }
    lastShipmentsFetch = Date.now();
    let routes = [];
    try {
      const r = await api("/api/shipments");
      routes = (r && r.routes) || [];
    } catch {
      if (el.shipmentListActive) el.shipmentListActive.innerHTML = `<div class="empty-hint">Не удалось загрузить маршруты отгрузки.</div>`;
      if (el.shipmentListDone) el.shipmentListDone.innerHTML = "";
      return;
    }
    const sig = JSON.stringify(routes.map((x) => {
      // Сигнатура должна ловить ЛЮБЫЕ изменения, влияющие на карточку отгрузки:
      // стадию точки, счётчики мест (печать стикеров / отгрузка не меняют stage,
      // но меняют loadedCount/totalCount/labelQty), единое название связки и
      // состав участников. Иначе при печати стикеров или отгрузке товара карточка
      // не перерисуется, пока пользователь не «перещёлкнет» клиента.
      const cl = (x.clients || []).map((c) => c ? [
        c.state || c.status || "",
        Number(c.loadedCount) || 0,
        Number(c.totalCount) || 0,
        Number(c.labelQty) || 0,
        c.bundleName || "",
        c.unloadFinished ? "f" : "",
        (Array.isArray(c.members) ? c.members.map((m) => (m && m.client) || "").join(",") : ""),
      ].join(":") : "").join(",");
      return [x.id, x.date, (x.progress ? x.progress.shippedAt : "") || 0,
              (x.progress ? x.progress.shipmentStartedAt : "") || 0, cl].join("|");
    }));
    if (sig === lastShipmentsSig) return; // не изменилось — не перерисовываем
    shipmentsCache = routes;
    lastShipmentsSig = sig;
    // Перерисовываем только когда раздел «Отгрузка» реально виден — иначе на ТСД
    // карточки перестраиваются в фоне без нужды (раздел может быть свёрнут/другая вкладка).
    if (!el.pageShipment.hidden) renderShipments();
  }

  // Показывает контейнер активной подвкладки, скрывает другую. Сворачивание
  // отдельных карточек отгрузки теперь по-кнопочно (см. data-route-collapse).
  // Множество id карточек, раскрытых пользователем вручную: раздел автообновляется
  // через loadShipments каждые несколько секунд, и без него раскрытая завершённая
  // отгрузка при перерисовке снова рендерилась бы свёрнутой («сама сворачивается»).
  const expandedShipmentCards = new Set();
  // Карточки отгрузки, которые пользователь явно СВЕРНУЛ. По умолчанию раскрыты:
  // склад должен сразу видеть клиентов и кнопку «Сборка», без лишних кликов.
  function loadCollapsedSet(key) {
    const s = new Set();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) arr.forEach((x) => s.add(String(x)));
      }
    } catch { /* ignore */ }
    return s;
  }
  function saveCollapsedSet(key, setObj) {
    try { localStorage.setItem(key, JSON.stringify([...setObj])); } catch { /* ignore */ }
  }
  // Состояние свёрнутых/развёрнутых карточек сохраняем в localStorage, чтобы при
  // перезагрузке/обновлении данных развёрнутые вкладки НЕ сворачивались сами.
  const collapsedShipmentCards = new Set(loadCollapsedSet("biotime_collapsed_cards"));
  const saveShipCollapsed = () => saveCollapsedSet("biotime_collapsed_cards", collapsedShipmentCards);
  // Аналогичный набор для «Моих маршрутов» водителя: раздел автообновляется через
  // loadMyRoutes каждые несколько секунд, и без него раскрытая карточка маршрута
  // при перерисовке снова сворачивалась бы, из-за чего маршрут «сразу исчезал».
  const expandedMyRouteCards = new Set(loadCollapsedSet("biotime_expanded_myroutes"));
  // Развёрнутые водителем карточки маршрутов в разделе «Движение водителей»
  // (drv-route-card): раздел перерисовывается автообновлением, и без этого набора
  // вручную раскрытая карточка снова сворачивалась бы при каждом обновлении.
  const expandedDriverRouteCards = new Set();
  function applyShipmentCollapseUI() {
    const showActive = shipmentSubtab === "active";
    const showDone = shipmentSubtab === "done";
    if (el.shipmentListActive) el.shipmentListActive.hidden = !showActive;
    if (el.shipmentListDone) el.shipmentListDone.hidden = !showDone;
  }

  function renderShipments() {
    if (!el.shipmentListActive && !el.shipmentListDone) return;
    const isDone = (r) => !!(r.progress && r.progress.shippedAt);
    // Фильтр по дате (календарь дат в шапке раздела). Действует и на «В работе»,
    // и на «Завершённые отгрузки». Значение — строка YYYY-MM-DD или пусто.
    const dateFilter = (typeof state.shipmentDateFilter === "string") ? state.shipmentDateFilter.trim() : "";
    const byDate = (r) => !dateFilter || String(r.date || "") === dateFilter;
    const cardHtml = (r) => {
      const dateStr = r.date ? fmtDateReadable(r.date) : "—";
      const shipStarted = !!(r.progress && r.progress.shipmentStartedAt);
      const shipDone = !!(r.progress && r.progress.shippedAt);
      let badge;
      if (shipDone) badge = `<span class="rms-status delivered">Отгружен</span>`;
      else if (shipStarted) badge = `<span class="rms-status active">Отгрузка идёт</span>`;
      else badge = `<span class="rms-status idle">Ожидает отгрузки</span>`;
      const waybillOn = !!state.params.allowWaybill;
      const clients = (r.clients || []).map((c, ci) => {
        const members = Array.isArray(c.members) && c.members.length > 0 ? c.members : null;
        // Состав по боксам (если велась сборка): группируем собранные детали по
        // коду бокса — те же боксы потом сканируются при отгрузке.
        let boxesHtml = "";
        const wb = r.waybills && r.waybills[ci];
        const items = wb && wb.items ? wb.items : [];
        const byBox = {};
        const boxOrder = [];
        items.forEach((it) => {
          if (!it.box) return;
          if (!byBox[it.box]) { byBox[it.box] = []; boxOrder.push(it.box); }
          byBox[it.box].push(it);
        });
        if (boxOrder.length) {
          boxesHtml = `<div class="shipment-client-boxes">` + boxOrder.map((b) => {
            const dets = byBox[b];
            // Удаление бокса из отгрузки: бокс С деталями удалить нельзя (кнопка
            // неактивна) — можно удалять только пустые боксы.
            const hasDetails = dets.length > 0;
            const delBtn = hasDetails
              ? `<button type="button" class="shipment-del-box" disabled title="Бокс содержит детали — удалить нельзя">✕</button>`
              : `<button type="button" class="shipment-del-box" title="Удалить бокс"
                  data-shipment-delbox="${escapeHtml(r.id)}:${ci}:${escapeHtml(b)}">✕</button>`;
            // Собранные детали внутри бокса в отгрузке не показываем — только код
            // бокса и (для склада) кнопку удаления.
            return `<div class="shipment-client-box"><span class="shipment-client-box-code">${escapeHtml(b)}</span>${delBtn}</div>`;
          }).join("") + `</div>`;
        }
        // Кнопка «Сборка» отражает состояние: «Завершена» / «Идёт сборка» / «Сборка».
        const wbp = c && c.waybillProgress ? c.waybillProgress : { finished: false, anyScanned: false };
        const wbLabel = wbp.finished ? "Завершена" : (wbp.anyScanned ? "Идёт сборка" : "Сборка");
        const wbBtn = waybillOn
          ? `<button type="button" class="ctrl ctrl-soft shipment-waybill-btn" data-waybill-open="${escapeHtml(r.id)}:${ci}">${escapeHtml(wbLabel)}</button>`
          : "";
        // В отгрузке у клиента показываем только кнопку «Сборка» — список боксов
        // и крестики удаления скрыты (состав боксов см. в окне сборки).
        return `
          <div class="shipment-client shipment-client-center">
            <span class="shipment-client-name">${escapeHtml(members ? (c.bundleName || c.address || c.client || "Связка") : (c.client || "—"))}</span>
            ${members ? `<span class="shipment-client-sub">${members.map((m) => escapeHtml(m.client)).join(", ")}</span>` : ""}
            ${(Number(c.loadedCount) || 0) > 0 ? `<span class="shipment-client-count">Мест: ${Number(c.loadedCount) || 0}</span>` : ""}
            ${wbBtn}
          </div>
        `;
      }).join("");
      let btn;
      if (shipDone) {
        // Маршрут, завершённый водителем (progress.status === "done"), вернуть
        // на отгрузку нельзя — скрываем кнопку (сервер это и так отвергает).
        const doneByDriver = !!(r.progress && r.progress.status === "done");
        const reopen = (state.canManageShipment && !doneByDriver)
          ? `<button type="button" class="ctrl ctrl-danger" data-shipment-reopen="${escapeHtml(r.id)}">Вернуть к отгрузке</button>`
          : "";
        btn = `<span class="shipment-shipped-note">Отгрузка завершена — водитель может начать маршрут</span>${reopen}`;
      } else if (shipStarted) {
        btn = r.selfPickup
          ? `<button type="button" class="ctrl ctrl-primary" data-shipment-selfpickup="${escapeHtml(r.id)}">Завершить самовывоз</button>`
          : "";
      } else {
        // При включённых накладных — нельзя начать, пока нет готовности по каждому
        // клиенту (сборка завершена ИЛИ накладная с позициями загружена).
        // Готовность берём из waybillProgress (в /api/shipments он приходит), а не из
        // r.waybills, которого в этом ответе нет.
        const wbReady = !waybillOn || (r.clients || []).every((c2) => {
          const wp = c2 && c2.waybillProgress;
          return wp ? (!!wp.finished || !!wp.hasItems) : false;
        });
        btn = wbReady
          ? `<button type="button" class="ctrl ctrl-primary" data-shipment-start="${escapeHtml(r.id)}">Начать отгрузку</button>`
          : `<button type="button" class="ctrl" disabled title="Сначала загрузите расходную накладную">Начать отгрузку</button>`;
      }
      // «Печать этикеток» в отгрузке доступна всегда, пока отгрузка идёт и не
      // завершена: склад печатает стикеры из браузера или десктопа напрямую (так
      // работало до того, как печать боксов появилась в «Сборке»).
      const printBtn = (shipStarted && !shipDone)
        ? `<button type="button" class="ctrl ctrl-soft" data-shipment-print="${escapeHtml(r.id)}">Печать этикеток</button>`
        : "";
      // Идущую отгрузку (склад уже работает с маршрутом) свернуть нельзя —
      // кнопка заблокирована и карточка раскрыта. Остальные карточки отгрузки
      // по умолчанию свёрнуты (список клиентов скрыт, виден шапкой с кнопкой).
      const shipLocked = shipStarted && !shipDone;
      // Свёрнута, если нельзя заблокировать (раскрыта всегда при идущей отгрузке)
      // и пользователь не раскрыл её вручную (сохраняем между автообновлениями).
      const shipCollapsed = !shipLocked && collapsedShipmentCards.has(String(r.id));
      const shipCollapseBtn = shipLocked
        ? `<button type="button" class="route-collapse is-locked" disabled title="Идущую отгрузку нельзя свернуть">▾</button>`
        : `<button type="button" class="route-collapse" data-route-collapse title="Свернуть/развернуть">${shipCollapsed ? "▸" : "▾"}</button>`;
      return `
        <div class="shipment-card${shipCollapsed ? " route-collapsed" : ""}" data-route-id="${escapeHtml(String(r.id))}">
          <div class="shipment-card-head">
            <span class="drv-route-name" title="Название маршрута">${escapeHtml(r.routeName || "Маршрут")}</span>
            <span class="driver-route-date">${escapeHtml(dateStr)}</span>
            <span class="driver-route-driver">${escapeHtml(r.driverName || "—")}</span>
            ${badge}
            ${shipCollapseBtn}
          </div>
          <div class="shipment-clients route-collapsible"${shipCollapsed ? " hidden" : ""}>${clients}</div>
          <div class="shipment-card-actions">${printBtn}${btn}</div>
        </div>
      `;
    };
    const activeList = shipmentsCache.filter((r) => !isDone(r) && byDate(r));
    const doneList = shipmentsCache.filter((r) => isDone(r) && byDate(r));
    if (el.shipmentListActive) {
      el.shipmentListActive.innerHTML = activeList.length
        ? activeList.map(cardHtml).join("")
        : `<div class="empty-hint">Маршрутов, ожидающих отгрузки, нет.</div>`;
      el.shipmentListActive.querySelectorAll("[data-shipment-start]").forEach((btn) => {
        btn.addEventListener("click", () => startShipment(btn.dataset.shipmentStart, btn));
      });
      el.shipmentListActive.querySelectorAll("[data-shipment-selfpickup]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            const r = await api("/api/shipments/selfpickup-done", {
              method: "POST",
              body: JSON.stringify({ routeId: btn.dataset.shipmentSelfpickup }),
            });
            toast((r && r.ok) ? "Самовывоз завершён — товар передан клиенту на складе" : ((r && r.error) || "Ошибка"));
          } catch (e) { toast((e && e.message) || "Ошибка"); }
          loadShipments();
        });
      });
      el.shipmentListActive.querySelectorAll("[data-shipment-print]").forEach((btn) => {
        btn.addEventListener("click", () => openPrintLabels(btn.dataset.shipmentPrint));
      });
      el.shipmentListActive.querySelectorAll("[data-shipment-delbox]").forEach((btn) => {
        btn.addEventListener("click", () => deleteBoxFromShipment(btn.dataset.shipmentDelbox));
      });
    }
    if (el.shipmentListDone) {
      el.shipmentListDone.innerHTML = doneList.length
        ? doneList.map(cardHtml).join("")
        : `<div class="empty-hint">Завершённых отгрузок пока нет.</div>`;
      el.shipmentListDone.querySelectorAll("[data-shipment-reopen]").forEach((btn) => {
        btn.addEventListener("click", () => reopenShipment(btn.dataset.shipmentReopen));
      });
    }
    applyShipmentCollapseUI();
  }

  // ---- Расходная накладная (сборка: загрузка xlsx + скан артикула) ----
  let waybillRouteId = null;
  let waybillClientIdx = 0;
  // Локальная копия накладной, не зависящая от асинхронного кэша shipmentsCache:
  // из-за гонки после загрузки файла кэш ещё старый, и список показывал
  // «Товаров нет» при загруженных 41 позиции.
  let waybillLocal = null;
  let waybillPoll = null;
  // Автообновление состояния сборки: оператор держит окно открытым на телефоне,
  // а сканер работает на ПК — периодически перечитываем накладную с сервера и
  // перерисовываем зелёные строки / кол-ва, чтобы видно было «прямо сейчас».
  function stopWaybillPoll() {
    if (waybillPoll) { clearInterval(waybillPoll); waybillPoll = null; }
  }
  // Перечитывает текущую накладную с сервера и перерисовывает (если окно открыто).
  // Вызывается по опросу и (мгновенно) по SSE-уведомлению о смене данных.
  async function refreshWaybillFromServer() {
    try {
      if (!el.waybillModal || !el.waybillModal.open) return;
      const r = await api("/api/shipments");
      const route = (r && r.routes || []).find((x) => String(x.id) === String(waybillRouteId));
      const fresh = route && route.waybills && route.waybills[waybillClientIdx];
      if (fresh && Array.isArray(fresh.items)) {
        const sig = JSON.stringify(fresh.items.map((x) => [String(x.art), Number(x.qty), Number(x.scanned) || 0, Number(x.missingQty) || 0, !!x.missing, String(x.box || "")]));
        waybillLocal = { items: fresh.items.map((x) => Object.assign({}, x)), pending: fresh.pending || null };
        if (sig !== waybillLastSig) {
          waybillLastSig = sig;
          renderWaybill();
        }
      }
      syncPendingQty(); // показываем/скрываем общую модалку ввода количества
      // Список боксов для удаления пересобираем ТОЛЬКО когда он виден на экране.
      // Раньше он опрашивался и перерисовывался каждые 2,5 с даже скрытым — лишняя
      // сеть + рендер тормозили ТСД в сборке (главная причина «тормозов»).
      try {
        if (el.waybillDelBoxList && el.waybillDelBoxList.offsetParent !== null) {
          renderWaybillDelBox();
        }
      } catch { /* ignore */ }
    } catch { /* сеть в моменте недоступна — пропускаем такт */ }
  }
  function startWaybillPoll() {
    stopWaybillPoll();
    waybillPoll = setInterval(refreshWaybillFromServer, 2500); // страховка; скорость даёт SSE
  }
  // Синхронизирует общую модалку ввода количества с серверным запросом (pending):
  // если есть ожидаемый запрос — показываем модалку на этом устройстве; если его
  // засчитали с любого устройства — закрываем. Вызывается при каждом обновлении.
  function syncPendingQty() {
    const pending = waybillLocal && waybillLocal.pending;
    if (pending && String(pending.art)) {
      if (!el.waybillSharedQtyModal || el.waybillSharedQtyModal.open) {
        if (el.waybillSharedQtyModal && el.waybillSharedQtyModal.open && waybillSharedPendingArt !== String(pending.art)) {
          // другой артикул уже ждёт — переустановим лимиты под текущий
          if (el.waybillSharedQty) { el.waybillSharedQty.max = String(pending.remaining); el.waybillSharedQty.value = ""; }
          waybillSharedPendingArt = String(pending.art);
        }
        return;
      }
      waybillSharedPendingArt = String(pending.art);
      if (el.waybillSharedQty) { el.waybillSharedQty.max = String(pending.remaining); el.waybillSharedQty.value = ""; }
      // Показываем КАКУЮ строчку накладной выбрали (артикул/наименование/сколько на
      // позиции и какой остаток) — оператор видит, что «села» нужная строка (4 или 7),
      // и не перепутает позиции одного артикула.
      if (el.waybillSharedQtyInfo) {
        const row = (waybillLocal && waybillLocal.items || []).find((it) => waybillNormArt(it.art) === waybillNormArt(pending.art));
        if (row) {
          const qtyN = Number(row.qty) || 0;
          const scannedN = Number(row.scanned) || 0;
          el.waybillSharedQtyInfo.innerHTML = `<span class="qty-info-code">${escapeHtml(row.art)}</span>` +
            (row.name ? `<span class="qty-info-name">${escapeHtml(row.name)}</span>` : "") +
            `<span class="qty-info-qty">позиция на ${qtyN} шт · осталось ${Math.max(0, qtyN - scannedN)}</span>`;
        } else {
          el.waybillSharedQtyInfo.innerHTML = `<span class="qty-info-code">${escapeHtml(pending.art)}</span>`;
        }
      }
      setWaybillStatus(`Введите количество (макс ${pending.remaining}) — ответ с любого устройства`);
      playScanFeedback(true, "Введите количество");
      try { el.waybillSharedQtyModal.showModal(); } catch { /* уже открыта */ }
    } else {
      if (waybillSharedPendingArt && el.waybillSharedQtyModal && el.waybillSharedQtyModal.open) {
        try { el.waybillSharedQtyModal.close(); } catch { /* ignore */ }
      }
      waybillSharedPendingArt = "";
      waybillSharedPendingBox = "";
      focusWaybillScan();
    }
  }
  function focusWaybillScan() {
    // Фокусируем поле всегда (и на ТСД): оно readOnly на ТСД, поэтому экранная
    // клавиатура не вылезет, а аппаратный сканер получит цель ввода — кликать в
    // поле при каждом скане не нужно.
    if (el.waybillArtInput) {
      try { el.waybillArtInput.focus(); } catch { /* ignore */ }
    }
    // После закрытия <dialog> браузер сам восстанавливает фокус (и часто — НЕ в это
    // поле). Повторяем фокусировку с задержкой, чтобы она пережила это и курсор
    // остался в поле «Штрихкод / артикул» — сканер сразу продолжал работать.
    setTimeout(() => { try { if (el.waybillArtInput) el.waybillArtInput.focus(); } catch { /* ignore */ } }, 60);
    setTimeout(() => { try { if (el.waybillArtInput) el.waybillArtInput.focus(); } catch { /* ignore */ } }, 250);
  }
  // ——— Боксы сборки ———
  let waybillBox = "";       // текущий бокс (код этикетки места)
  let waybillClientName = ""; // имя клиента текущей накладной (для логов сканов)
  let waybillBoxCodes = new Set();  // коды боксов клиента (для надёжного распознавания скана)
  let waybillBoxPlaces = new Set(); // номера мест боксов клиента
  let waybillBoxMetaLoaded = false; // загружены ли списки боксов (для распознавания)
  let waybillPrinting = false; // печатаем бокс из окна СБОРКИ (не открывать модалку отгрузки)
  let waybillPendingArt = ""; // деталь, ожидающая свой бокс (скан: деталь → «МЕСТО» → бокс)
  let waybillSelected = new Set(); // строки, отмеченные чекбоксом (для «Не найдено»/«Собрать вручную»)
  let waybillTcd = false; // true на ТСД: список деталей — в модальном окне через кнопку
  let waybillLastSig = "";  // сигнатура данных сборки — чтобы не перерисовывать, если не менялось
  let waybillListModalHtml = ""; // закэшированный HTML списка в модалке ТСД
  let waybillFlashTimer = null; // таймер автоскрытия баннера результата
  let waybillFinishedLocal = false; // сборка завершена кнопкой «Завершить сборку»
  let waybillSharedPendingArt = ""; // артикул, ждущий общий ввод количества (мультидевайс)
  let waybillSharedPendingBox = ""; // активный бокс на момент запроса количества (см. qtyresolve)
  function setWaybillBox(box) {
    waybillBox = String(box || "").trim();
    const cur = el.waybillBoxCur;
    if (cur) {
      cur.dataset.state = waybillBox ? "active" : "empty";
      const val = cur.querySelector(".waybill-box-value");
      const hint = cur.querySelector(".waybill-box-hint");
      if (val) val.textContent = waybillBox ? waybillBoxNumber(waybillBox) : "—";
      if (hint) hint.textContent = waybillBox ? "можно сканировать" : "не обязательно";
    }
    if (el.waybillArtInput) el.waybillArtInput.value = "";
    setWaybillStatus(waybillBox ? `Бокс выбран: ${waybillBox} — можно сканировать детали` : "Бокс не выбран — детали можно сканировать без бокса");
    if (el.waybillNewBoxBtn) el.waybillNewBoxBtn.classList.toggle("active", !waybillBox);
    focusWaybillScan();
  }
  function waybillNewBox() {
    // Печатаем ОДИН новый бокс для текущего клиента сразу, без перехода на вкладку
    // «Отгрузка»: настраиваем печать и печатаем 1 место (append). Стикер «вылезает»
    // прямо из окна сборки — сборщику остаётся отсканировать его код.
    setWaybillBox("");
    // Новый бокс начинает новый цикл: сбрасываем ожидающую деталь, чтобы следующий
    // скан детали шёл как «МЕСТО», а не как бокс.
    waybillPendingArt = "";
    if (waybillRouteId) {
      printRouteId = waybillRouteId;
      printClientIndex = waybillClientIdx;
      // Кол-во для «Нового бокса»: по умолчанию 1, можно ввести сколько угодно
      // стикеров (печать нескольких боксов за раз). Ограничено 1..200.
      const multiQty = Math.max(1, Math.min(200, Number(el.waybillBoxQty && el.waybillBoxQty.value) || 1));
      if (el.waybillBoxQty) el.waybillBoxQty.value = String(multiQty);
      if (el.printPlacesQty) el.printPlacesQty.value = String(multiQty);
      waybillPrinting = true;
      doPrintLabels(false);
    }
    // На ТСД печать не делаем (стикер — с ПК), поэтому и сообщение честное.
    const multiQty = Math.max(1, Number(el.waybillBoxQty && el.waybillBoxQty.value) || 1);
    setWaybillStatus(canPrintHere()
      ? (`Новых боксов напечатано: ${multiQty} — отсканируйте их (код BG…)`)
      : (`Создано боксов: ${multiQty} — распечатайте стикеры с ПК, затем отсканируйте их`));
    playScanFeedback(true, "Новый бокс");
    renderWaybillDelBox();
    // Этикетка нового бокса создаётся на сервере асинхронно (печать); когда она
    // появится — сразу отображаем её в списке боксов, без перезахода в сборку.
    setTimeout(() => { try { renderWaybillDelBox(); } catch { /* ignore */ } }, 350);
    focusWaybillScan();
  }
  // Список созданных боксов для удаления (чекбоксы; боксы с деталями недоступны).
  async function renderWaybillDelBox() {
    const boxList = el.waybillDelBoxList;
    if (!boxList) return;
    let boxes = [];
    if (waybillRouteId) {
      try {
        const r = await api(`/api/routes/${encodeURIComponent(waybillRouteId)}/waybill/boxes?clientIndex=${waybillClientIdx}`);
        boxes = (r && r.boxes) || [];
      } catch { boxes = []; }
    }
    if (!boxes.length) {
      waybillBoxCodes = new Set();
      waybillBoxPlaces = new Set();
      boxList.innerHTML = '<span class="empty-hint">Боксов нет</span>';
      return;
    }
    // Актуализируем известные боксы клиента — по ним надёжно распознаём скан бокса.
    waybillBoxCodes = new Set();
    waybillBoxPlaces = new Set();
    boxes.forEach((b) => {
      const bc = String(b.box || "");
      if (!bc) return;
      waybillBoxCodes.add(bc);
      const p = parseInt(waybillBoxNumber(bc), 10);
      if (Number.isFinite(p) && p > 0) waybillBoxPlaces.add(p);
    });
    // Сохраняем отмеченные боксы перед перерисовкой (список часто обновляется
    // после сканов/отгрузки), чтобы галочки не «слетали» при ре-рендере.
    const checkedBefore = new Set(
      Array.from(boxList.querySelectorAll(".waybill-del-box-check:checked")).map((c) => c.value)
    );
    boxList.innerHTML = boxes.map((b) => {
      const hasDetails = Number(b.details) > 0;
      const code = String(b.box || "");
      const name = escapeHtml(waybillBoxName(code));
      const isActive = code && String(waybillBox) === String(code);
      return `<div class="waybill-del-box-item${hasDetails ? " is-locked has-content" : ""}${isActive ? " is-active" : ""}"${hasDetails ? ` data-box-open="${escapeHtml(code)}"` : ""} title="${hasDetails ? "Нажмите, чтобы посмотреть содержимое (удалить нельзя)" : name}">
        <input type="checkbox" class="waybill-del-box-check" value="${escapeHtml(code)}" ${hasDetails ? "disabled" : ""}>
        <span class="waybill-del-box-code">${name}</span>
        ${hasDetails ? `<span class="waybill-del-box-note">· с деталями</span>` : ""}
        ${isActive ? `<span class="waybill-del-box-active">✓ активный</span>` : ""}
        <span class="waybill-del-box-actions">
          <button type="button" class="waybill-del-box-reprint" data-box-reprint="${escapeHtml(code)}" title="Перепечатать этот бокс">🖨</button>
        </span>
      </div>`;
    }).join("");
    // Возвращаем отметки ранее отмеченным боксам (кроме ставших «с деталями»).
    boxList.querySelectorAll(".waybill-del-box-check").forEach((cb) => {
      if (checkedBefore.has(cb.value)) cb.checked = true;
    });
    // Клик по боксу с деталями — открываем модалку с его содержимым.
    boxList.querySelectorAll("[data-box-open]").forEach((it) => {
      it.addEventListener("click", (ev) => {
        ev.preventDefault();
        openBoxDetails(it.getAttribute("data-box-open"));
      });
    });
    // Перепечатка существующего бокса (стикер того же кода).
    boxList.querySelectorAll("[data-box-reprint]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        reprintWaybillBox(btn.getAttribute("data-box-reprint"));
      });
    });
  }
  // Легкая подгрузка списков боксов клиента (коды + номера мест) для надёжного
  // распознавания скана бокса, даже если панель боксов не отрисована на ТСД.
  async function ensureWaybillBoxMeta() {
    if (waybillBoxMetaLoaded || !waybillRouteId) return;
    try {
      const r = await api(`/api/routes/${encodeURIComponent(waybillRouteId)}/waybill/boxes?clientIndex=${waybillClientIdx}`);
      const boxes = (r && r.boxes) || [];
      waybillBoxCodes = new Set();
      waybillBoxPlaces = new Set();
      boxes.forEach((b) => {
        const bc = String(b.box || "");
        if (!bc) return;
        waybillBoxCodes.add(bc);
        const p = parseInt(waybillBoxNumber(bc), 10);
        if (Number.isFinite(p) && p > 0) waybillBoxPlaces.add(p);
      });
      waybillBoxMetaLoaded = true;
    } catch { /* сеть недоступна — распознавание по QR/BG останется */ }
  }
  // Перепечатывает стикер конкретного бокса (тот же код, что на этикетке).
  function reprintWaybillBox(code) {
    if (!canPrintHere()) { setWaybillStatus("Печать стикеров доступна на компьютере"); return; }
    const route = (shipmentsCache || []).find((x) => String(x.id) === String(waybillRouteId));
    const cl = route && route.clients ? route.clients[waybillClientIdx] : null;
    const area = el.printArea;
    if (!area || !String(code)) return;
    area.innerHTML = "";
    let logoHtml = "";
    if (cl && cl.logoText) logoHtml = `<div class="label-logo label-logo-text">${escapeHtml(cl.logoText)}</div>`;
    else if (cl && cl.logo) logoHtml = `<div class="label-logo"><img src="${escapeHtml(cl.logo)}" alt="лого" crossorigin="anonymous" /></div>`;
    const dateStr = route ? String(route.date || "") : "";
    const q = buildQrImage(code);
    const px = (q && q.size) ? 70 : 0;
    const card = document.createElement("div");
    card.className = "label-card";
    card.innerHTML =
      logoHtml +
      `<div class="label-order">Отгрузка ${escapeHtml(dateStr)}</div>` +
      `<div class="label-qr">${px && q.src ? `<img alt="QR" width="${px}" height="${px}" src="${q.src}" />` : ""}</div>` +
      `<div class="label-code">${escapeHtml(waybillBoxName(code))}</div>`;
    area.appendChild(card);
    dispatchStickerPrint(function () {});
    setWaybillStatus(`Перепечатан бокс: ${waybillBoxName(code)}`);
    playScanFeedback(true, "Печать бокса");
  }
  // Модалка «содержимое бокса»: показывает детали, привязанные к боксу.
  function openBoxDetails(box) {
    const items = (waybillLocal && waybillLocal.items ? waybillLocal.items : [])
      .filter((it) => String(it.box) === String(box));
    if (!el.boxDetailsList || !el.boxDetailsModal) return;
    if (el.boxDetailsTitle) el.boxDetailsTitle.textContent = "Содержимое бокса · " + waybillBoxNumber(box);
    const head = items.length
      ? `<div class="waybill-box-detail wbd-head">
          <span class="wbd-ps">Партстикер</span>
          <span class="wbd-art">Артикул</span>
          <span class="wbd-name">Наименование</span>
          <span class="wbd-qty">Кол-во</span>
        </div>`
      : "";
    el.boxDetailsList.innerHTML = (head + (items.length ? items.map((it) => `
          <div class="waybill-box-detail">
            <span class="wbd-ps" style="color:#999;font-size:11px;margin-right:8px">${it.partsticker ? escapeHtml(shortPs(it.partsticker)) : "—"}</span>
            <span class="wbd-art">${escapeHtml(it.art)}</span>
            <span class="wbd-name">${escapeHtml(it.name || "")}</span>
            <span class="wbd-qty">${Number(it.scanned) || 0}/${Number(it.qty) || 0}</span>
          </div>`).join("") : '<div class="empty-hint">В боксе нет деталей</div>'));
    try { el.boxDetailsModal.showModal(); } catch (_) { /* уже открыта */ }
  }
  async function deleteWaybillBox() {
    const boxList = el.waybillDelBoxList;
    const checks = boxList ? Array.from(boxList.querySelectorAll(".waybill-del-box-check:checked")) : [];
    const boxes = checks.map((c) => c.value).filter(Boolean);
    if (!boxes.length) { setWaybillStatus("Отметьте боксы для удаления"); return; }
    let ok = 0, blocked = 0, failed = 0;
    for (const box of boxes) {
      try {
        const r = await api(`/api/routes/${encodeURIComponent(waybillRouteId)}/waybill/box/delete`, {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx, box }),
        });
        if (r && r.ok) ok += 1;
        else if (r && !r.ok && /детал|переразмест/i.test((r.error || ""))) blocked += 1;
        else failed += 1;
      } catch (e) { blocked += 1; }
    }
    if (ok) setWaybillStatus(`Удалено боксов: ${ok}`);
    else if (blocked) setWaybillStatus("Боксы с деталями удалить нельзя");
    else if (failed) setWaybillStatus("Не удалось удалить выбранные боксы");
    renderWaybillDelBox();
    renderWaybill();
    loadShipments();
    focusWaybillScan();
  }
  function waybillGet() {
    const r = (shipmentsCache || []).find((x) => String(x.id) === String(waybillRouteId));
    return r && r.waybills && r.waybills[waybillClientIdx] ? r.waybills[waybillClientIdx] : null;
  }
  // Удаление бокса из ОТГРУЗКИ: тот же эндпоинт /waybill/box/delete, где сервер
  // запрещает удалять бокс с деталями («переразместите в другой бокс»).
  async function deleteBoxFromShipment(key) {
    const parts = String(key || "").split(":"); // routeId:clientIdx:box
    if (parts.length < 3) return;
    const routeId = parts[0];
    const clientIdx = Number(parts[1]);
    const box = parts.slice(2).join(":");
    try {
      const r = await api(`/api/routes/${encodeURIComponent(routeId)}/waybill/box/delete`, {
        method: "POST",
        body: JSON.stringify({ clientIndex: clientIdx, box }),
      });
      if (r && r.ok) {
        toast(`Бокс ${box} удалён`);
      } else {
        toast((r && r.error) || "Не удалось удалить бокс");
        playScanFeedback(false);
      }
      loadShipments();
    } catch (e) {
      toast((e && e.message) || "В боксе деталь — переразместите в другой бокс");
      playScanFeedback(false);
      loadShipments();
    }
  }
  // Удаляет загруженную накладную у клиента (сборку можно отменить, пока нет
  // собранных деталей/боксов — сервер сам откажет, если они есть).
  function openWaybill(routeId, clientIdx) {
    waybillRouteId = routeId;
    waybillClientIdx = Number(clientIdx) || 0;
    waybillBox = "";
    waybillPendingArt = "";
    waybillFinishedLocal = false;
    setWaybillBox(""); // индикатор бокса: «не выбран» — детали сканируются без бокса
    waybillPendingArt = "";
    const cached = waybillGet();
    waybillLocal = cached && cached.items ? { items: cached.items.map((x) => Object.assign({}, x)) } : null;
    if (el.waybillArtInput) el.waybillArtInput.value = "";
    if (el.waybillFile) el.waybillFile.value = "";
    if (el.waybillTitle) {
      const r = (shipmentsCache || []).find((x) => String(x.id) === String(routeId));
      const cl = r && r.clients[waybillClientIdx];
      // Для логов показываем НАЗВАНИЕ клиента, а не адрес. У объединённых клиентов
      // имя берём из bundleName или имён участников; адрес оставляем крайним фолбэком.
      waybillClientName = cl ? (
        cl.client ||
        cl.bundleName ||
        (Array.isArray(cl.members) ? cl.members.map((m) => String((m && (m.client || m.bundleName)) || "").trim()).filter(Boolean).join(", ") : "") ||
        cl.address ||
        ""
      ) : "";
      el.waybillTitle.textContent = "Накладная · " + (cl ? (waybillClientName || `Клиент ${waybillClientIdx + 1}`) : "Клиент");
    }
    const wb = waybillLocal;
    // Кнопка «Убрать «не найдено»» — только админ/модератор; доступ в накладной.
    if (el.waybillRemoveMissing) {
      el.waybillRemoveMissing.hidden = !(state.isAdmin || state.isModerator === true);
    }
    // Кнопка «Удалить не собранные» — только администратор.
    if (el.waybillCleanBtn) {
      el.waybillCleanBtn.hidden = !(state.isAdmin === true);
    }
    setWaybillStatus(wb ? `Загружено позиций: ${wb.items.length}` : "Накладная не загружена на этого клиента");
    // Можно добавить ещё одну расходную накладную: она ДОПОЛНИТ единый список
    // сборки этой точки (строки просто добавятся), не заменяя уже загруженные.
    // Кнопка загрузки всегда активна.
    if (el.waybillFile) {
      el.waybillFile.disabled = false;
      el.waybillFile.value = "";
      const fileRow = el.waybillFile.closest(".file-row");
      if (fileRow) fileRow.style.display = "";
    }
    startWaybillPoll();
    waybillBoxMetaLoaded = false; // новый клиент/накладная → списки боксов могли поменяться
    renderWaybill();
    renderWaybillDelBox();
    try { el.waybillModal.showModal(); } catch { /* уже открыта */ }
    // Немедленно читаем из накладной АКТУАЛЬНОЕ состояние с сервера (а не из
    // локального кэша) — чтобы после «Завершить сборку» и повторного входа
    // собранные детали не показывались как 0/N и не приходилось собирать заново.
    refreshWaybillFromServer();
    // Вход в сборку → кнопка в списке отгрузки показывает «Идёт сборка».
    document.querySelectorAll(`[data-waybill-open="${routeId}:${clientIdx}"]`).forEach((b) => {
      if (b && b.textContent !== "Завершена") b.textContent = "Идёт сборка";
    });
    // Сканер работает «не вставая в строку»: фокус всегда на поле штрихкода.
    setTimeout(focusWaybillScan, 120);
  }
  function closeWaybill() {
    stopWaybillPoll();
    if (el.waybillModal && el.waybillModal.open) { try { el.waybillModal.close(); } catch { /* ignore */ } }
    if (el.waybillSharedQtyModal && el.waybillSharedQtyModal.open) { try { el.waybillSharedQtyModal.close(); } catch { /* ignore */ } }
    waybillSharedPendingArt = "";
    waybillSharedPendingBox = "";
    // Если вышел без единого скана (и не завершали) — возвращаем кнопке «Сборка».
    if (!waybillFinishedLocal) {
      const any = (waybillLocal && Array.isArray(waybillLocal.items))
        && waybillLocal.items.some((it) => (Number(it.scanned) || 0) > 0 || (Number(it.missingQty) || 0) > 0);
      if (!any && waybillRouteId != null) {
        document.querySelectorAll(`[data-waybill-open="${waybillRouteId}:${waybillClientIdx}"]`).forEach((b) => {
          if (b && b.textContent === "Идёт сборка") b.textContent = "Сборка";
        });
      }
    }
    loadShipments(); // свежая кнопка и для других устройств
  }
  function setWaybillStatus(t) {
    if (el.waybillStatus) el.waybillStatus.textContent = t;
    // Результаты сканирования показываем ещё и крупным баннером, который держится
    // ~2,5 с, чтобы оператор успел прочитать, даже если статусная строка дальше
    // перепишется (следующий скан / фоновая синхронизация).
    if (el.waybillFlash && /ХОРОШО|ПЛОХО|Уже отсканировано|засчитано|не найдена в накладной/.test(String(t || ""))) {
      showWaybillFlash(String(t));
    }
  }
  function showWaybillFlash(text) {
    if (!el.waybillFlash) return;
    el.waybillFlash.textContent = text;
    el.waybillFlash.hidden = false;
    el.waybillFlash.classList.remove("fw-out");
    clearTimeout(waybillFlashTimer);
    waybillFlashTimer = setTimeout(() => {
      el.waybillFlash.classList.add("fw-out");
      setTimeout(() => { if (el.waybillFlash) el.waybillFlash.hidden = true; }, 350);
    }, 2500);
  }
  function renderWaybill() {
    if (!el.waybillList) return;
    const wb = waybillLocal;
    if (!wb || !wb.items || !wb.items.length) {
      el.waybillList.innerHTML = `<div class="mult-rule-empty">Товаров нет. Загрузите .xlsx.</div>`;
      // Позиций нет вовсе — завершить сборку можно в любом случае.
      if (el.waybillFinishBtn) el.waybillFinishBtn.disabled = false;
      return;
    }
    const doneAll = wb.items.every((it) =>
      ((Number(it.scanned) || 0) + (Number(it.missingQty) || 0)) >= (Number(it.qty) || 0)
    );
    const codedOne = wb.items.filter((it) => (Number(it.scanned) || 0) > 0).length;
    const missCount = wb.items.filter((it) => (Number(it.missingQty) || 0) > 0 || !!it.missing).length;
    // Количество в штуках (аналогично позициям): сколько деталей собрано / сколько
    // всего единиц товара по накладной.
    const unitsDone = wb.items.reduce((s, it) => s + (Number(it.scanned) || 0), 0);
    const unitsTotal = wb.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    setWaybillStatus(
      `Собрано позиций: ${codedOne}/${wb.items.length}${missCount ? ` · не найдено: ${missCount}` : ""}`
      + ` · штук: ${unitsDone}/${unitsTotal}`
      + (doneAll ? " · сборка готова — можно начать отгрузку" : "")
    );
    // Завершение сборки доступно, когда весь товар собран или помечен «не найдено»
    // (комбинированно): кнопка просто закрывает окно — сервер при начале отгрузки
    // сам проверяет готовность.
    // Если позиций в сборке не было вовсе — завершить можно в любом случае.
    if (el.waybillFinishBtn) el.waybillFinishBtn.disabled = wb.items.length > 0 ? !doneAll : false;
    // Кнопки активны, когда есть хотя бы одна отмеченная чекбоксом строка.
    const hasSel = waybillSelected.size > 0;
    if (el.waybillMissBtn) el.waybillMissBtn.disabled = !hasSel;
    if (el.waybillManualBtn) el.waybillManualBtn.disabled = !hasSel;
    if (el.waybillModalAssembleBtn) el.waybillModalAssembleBtn.disabled = !hasSel;
    if (el.waybillModalMissBtn) el.waybillModalMissBtn.disabled = !hasSel;
    const itemHtml = (it, i) => {
      const left = Math.max(0, (Number(it.qty) || 0) - (Number(it.scanned) || 0));
      const scanned = Number(it.scanned) || 0;
      const qtyN = Number(it.qty) || 0;
      const missQty = Number(it.missingQty) || 0;
      const miss = missQty > 0 || !!it.missing;
      const done = (scanned + missQty) >= qtyN;
      const sel = waybillSelected.has(i);
      const cls = ["waybill-item", done ? " done" : "", miss ? " missing" : "", sel ? " selected" : ""].join(" ");
      const mark = miss
        ? `<span class="waybill-mark">не найдено${missQty > 0 ? " " + missQty : ""}</span>`
        : (done ? `<span class="waybill-mark">${it.box ? "бокс " + escapeHtml(String(it.box).slice(0, 18)) : "собрано"}</span>` : "");
      // Очистка наименования от ведущего артикула (бывает в данных / из xlsx).
      const cleanName = (nm, art) => {
        let n = String(nm || "");
        const a = String(art || "");
        if (a && n.toLowerCase().startsWith(a.toLowerCase())) n = n.slice(a.length).replace(/\s+$/, "").trim();
        return n || String(nm || "");
      };
      return `<tr class="${cls}" data-waybill-index="${i}" data-waybill-art="${escapeHtml(it.art)}">
        <td class="waybill-check" data-wb-check="${i}">${sel ? "☑" : "☐"}</td>
        <td class="waybill-item-ps">${it.partsticker ? escapeHtml(shortPs(it.partsticker)) : "—"}</td>
        <td class="waybill-item-art">${escapeHtml(it.art)}</td>
        <td class="waybill-item-name">${escapeHtml(cleanName(it.name, it.art))}</td>
        <td class="waybill-item-qty" title="Всего: ${qtyN} шт · собрано: ${scanned}${missQty ? " · не найдено: " + missQty : ""}">${scanned} из ${qtyN} шт</td>
        <td class="waybill-markcell">${mark}</td>
      </tr>`;
    };
    // Сортируем для удобства: непринятые (не собранные) детали сверху, принятые снизу.
    // Порядок внутри групп сохраняется; data-waybill-index остаётся исходным индексом,
    // чтобы клики/чекбоксы не ломались.
    const rows = wb.items.map((it, i) => ({ it, i }));
    rows.sort((a, b) => {
      // Порядок: 0 = не отсканировано, 1 = «не найдено», 2 = собрано.
      const g1 = (it) => {
        const qty = Number(it.qty) || 0;
        const scanned = Number(it.scanned) || 0;
        const missQty = Number(it.missingQty) || 0;
        if (it.missing || missQty > 0) return 1;       // «не найдено» — всегда выше собранных
        if ((scanned + missQty) >= qty) return 2;      // собрано
        return 0;                                       // не отсканировано
      };
      return g1(a.it) - g1(b.it);
    });
    // Настоящая таблица: каждая колонка — отдельная ячейка.
    const listHeader = `<table class="waybill-table"><thead><tr>
      <th class="th-check"></th>
      <th class="th-ps">Партстикер</th>
      <th class="th-art">Артикул</th>
      <th class="th-name">Наименование</th>
      <th class="th-qty">Кол-во</th>
      <th class="th-mark"></th>
    </tr></thead><tbody>`;
    const listFooter = `</tbody></table>`;
    if (waybillTcd) {
      // На ТСД вместо прокручиваемого списка — кнопка, открывающая модалку со списком.
      const doneCount = wb.items.filter((x) => ((Number(x.scanned) || 0) + (Number(x.missingQty) || 0)) >= (Number(x.qty) || 0)).length;
      el.waybillList.innerHTML = `<button type="button" class="ctrl ctrl-primary waybill-list-toggle" id="waybillListToggle">
        Показать список деталей (${doneCount}/${wb.items.length})
      </button>`;
      // Список в модалке ТСД пересобираем ТОЛЬКО когда модалка открыта, и лишь если
      // его содержимое реально изменилось — не тратим ресурсы ТСД на перерисовку
      // каждого такта, когда окно закрыто или данные те же.
      if (el.waybillListModal && el.waybillListModal.open && el.waybillListModalBody) {
        const html = listHeader + rows.map((r) => itemHtml(r.it, r.i)).join("") + listFooter;
        if (html !== waybillListModalHtml) { waybillListModalHtml = html; el.waybillListModalBody.innerHTML = html; }
      }
    } else {
      el.waybillList.innerHTML = listHeader + rows.map((r) => itemHtml(r.it, r.i)).join("") + listFooter;
      if (el.waybillListModalBody) el.waybillListModalBody.innerHTML = "";
    }
  }
  async function toggleMissingWaybill(idx) {
    if (!waybillLocal || !waybillLocal.items) { setWaybillStatus("Сначала загрузите накладную"); return; }
    const item = waybillLocal.items[idx];
    if (!item) { setWaybillStatus("Позиция не найдена"); return; }
    const art = String(item.art);
    const scanned = Number(item.scanned) || 0;
    const qtyN = Number(item.qty) || 0;
    const remaining = Math.max(0, qtyN - scanned);
    const alreadyMissing = (Number(item.missingQty) || 0) > 0 || !!item.missing;
    // Снимаем пометку целиком.
    if (alreadyMissing) {
      try {
        const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/missing", {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx, index: idx, art, on: false }),
        });
        if (r && r.ok) {
          item.missing = false; item.missingQty = 0;
          if (r.item && r.item.scanned != null) item.scanned = r.item.scanned;
          setWaybillStatus(`Пометка ${art} снята`);
          renderWaybill(); loadShipments();
        } else setWaybillStatus((r && r.error) || "Ошибка сохранения пометки");
      } catch (e) { setWaybillStatus((e && e.message) || "Ошибка: не удалось снять пометку"); }
      focusWaybillScan();
      return;
    }
    if (remaining <= 0) { setWaybillStatus("Нельзя пометить собранную полностью позицию"); focusWaybillScan(); return; }
    // Спрашиваем, сколько единиц пометить «не найдено» (всегда, даже если остаток 1).
    const qty = await askWaybillQty(remaining);
    if (qty == null) { setWaybillStatus("Пометка отменена"); focusWaybillScan(); return; }
    try {
      const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/missing", {
        method: "POST",
        body: JSON.stringify({ clientIndex: waybillClientIdx, index: idx, art, on: true, qty }),
      });
      if (r && r.ok) {
        item.missing = true;
        item.missingQty = (r.item && r.item.missingQty != null) ? Number(r.item.missingQty) : qty;
        if (r.item && r.item.scanned != null) item.scanned = r.item.scanned;
        setWaybillStatus(`«Не найдено»: ${item.missingQty} из ${qtyN}`);
        renderWaybill();
        loadShipments();
      } else {
        setWaybillStatus((r && r.error) || "Ошибка сохранения пометки");
      }
    } catch (e) {
      setWaybillStatus((e && e.message) || "Ошибка: не удалось пометить");
    }
    focusWaybillScan();
  }
  // «Собрать вручную»: собрать полностью каждую отмеченную чекбоксом строку
  // (эквивалентно нескольким сканам — деталь зеленеет, пометка «не найдено» снимается).
  async function manualAssembleWaybill() {
    const idxs = [...waybillSelected];
    waybillSelected.clear();
    for (const idx of idxs) {
      const it = waybillLocal && waybillLocal.items[idx];
      if (!it) continue;
      const rem = Math.max(0, (Number(it.qty) || 0) - ((Number(it.scanned) || 0) + (Number(it.missingQty) || 0)));
      if (rem <= 0) continue;
      // Спрашиваем, сколько собрать вручную (всегда, даже если остаток 1).
      const take = await askWaybillQty(rem);
      if (take == null) continue;
      await waybillScanDetail(String(it.art), take);
    }
    renderWaybill();
    focusWaybillScan();
  }
  function uploadWaybill() {
    const file = el.waybillFile && el.waybillFile.files && el.waybillFile.files[0];
    if (!file) { setWaybillStatus("Выберите файл .xlsx"); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      setWaybillStatus("Загружаю накладную…");
      const b64 = String(reader.result).split(",")[1] || "";
      try {
        const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill", {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx, fileB64: b64 }),
        });
        if (r && r.ok) {
          waybillLocal = { items: (r.items || []).map((x) => Object.assign({}, x)) };
          const total = (waybillLocal.items || []).reduce((s, it) => s + (Number(it.scanned) || 0), 0);
          setWaybillStatus(`Загружено позиций: ${waybillLocal.items.length}${r.total ? ` · накладная дополнена` : ""}${total ? " · собрано " + total : ""}`);
          renderWaybill();
          loadShipments(); // обновляем родительский список в фоне
          focusWaybillScan();
        } else {
          setWaybillStatus((r && r.error) || "Не удалось загрузить накладную");
        }
      } catch (e) {
        setWaybillStatus((e && e.message) || "Ошибка загрузки");
      }
    };
    reader.onerror = () => setWaybillStatus("Не удалось прочитать файл");
    reader.readAsDataURL(file);
  }
  async function scanWaybill() {
    if (!waybillLocal || !waybillLocal.items) {
      setWaybillStatus("Сначала загрузите накладную");
      return;
    }
    const val = el.waybillArtInput ? String(el.waybillArtInput.value || "").trim() : "";
    if (!val) { setWaybillStatus("Введите/отсканируйте код"); focusWaybillScan(); return; }
    // Сборка: БОКС → активируется (активный бокс), ДЕТАЛЬ → засчитывается и
    // привязывается к АКТИВНОМУ боксу. Бокс и артикул сканируются в одном поле.
    // Чтобы переключить бокс, сканируем новый — следующие детали идут в него.
    // Распознаём бокс надёжно: полный код «BG…», либо «Бокс N»/номер, совпадающий
    // с одним из существующих боксов клиента (артикулы деталей боксом не считаем).
    const rawBox = String(val).trim();
    let isFullBox = rawBox.startsWith("BG" + waybillRouteId + "-") || waybillBoxCodes.has(rawBox);
    const boxNumMatch = /(\d+)\s*$/.exec(rawBox);
    const boxNum = boxNumMatch ? parseInt(boxNumMatch[1], 10) : 0;
    const isDetailArt = (waybillLocal && waybillLocal.items || []).some((it) =>
      String(it.art).trim() === rawBox || Number(String(it.art).replace(/[^0-9]/g, "")) === boxNum
    );
    let isBoxNum = /^(\s*(б\s*о\s*к\s*с|box|№|#)\s*)?\d+$/i.test(rawBox)
      && waybillBoxPlaces.has(boxNum) && !isDetailArt;
    // Если это не QR-код бокса и не деталь, а списки боксов ещё не подгружены — тянем
    // их на лету и пересчитываем (на ТСД панель боксов может не отрисоваться, и скан
    // «Бокс N» без этого был бы принят за деталь → бокс не активировался).
    if (!isFullBox && !isDetailArt && waybillBoxPlaces.size === 0) {
      await ensureWaybillBoxMeta();
      isFullBox = rawBox.startsWith("BG" + waybillRouteId + "-") || waybillBoxCodes.has(rawBox);
      isBoxNum = /^(\s*(б\s*о\s*к\s*с|box|№|#)\s*)?\d+$/i.test(rawBox)
        && waybillBoxPlaces.has(boxNum) && !isDetailArt;
    }
    // Надёжное распознавание «механического» бокса: деталь уже могла лежать в
    // боксе (сервер теперь его отдаёт в /waybill/boxes), но списки могут не
    // успеть подгрузиться на ТСД. Если сборщик явно указал бокс словом («Бокс N»,
    // «box N», «№N») — это бокс, а не деталь; активируем его и по номеру, даже
    // если он ещё не в waybillBoxPlaces (главное — чтобы это не был артикул).
    const isExplicitBoxNumber = /^(\s*(б\s*о\s*к\s*с|box|б|№|#)\s*)\d+$/i.test(rawBox)
      && boxNum > 0 && !isDetailArt;
    if (isFullBox || isBoxNum || isExplicitBoxNumber) {
      // Отсканированный бокс становится АКТИВНЫМ: последующие детали привязываются
      // к нему. Другой бокс — другой скан — детали пойдут в новый.
      // Код бокса: полный QR-код / явное «Бокс N» → код места «BG…-place», даже
      // если кода нет в списках (механический бокс). Голый номер без слова —
      // только если он есть в waybillBoxPlaces (isBoxNum), чтобы не путать с артикулом.
      const selCode = isFullBox ? rawBox : "BG" + waybillRouteId + "-" + (waybillClientIdx + 1) + "-" + boxNum;
      setWaybillBox(selCode);
      setWaybillStatus(`Бокс Выбран: ${waybillBoxName(selCode)} — можно сканировать детали`);
      playScanFeedback(true, "Бокс выбран");
    } else {
      await waybillScanDetail(val);
    }
    if (el.waybillArtInput) el.waybillArtInput.value = "";
    // Сканер «не вставая в строку»: возвращаем фокус на поле штрихкода.
    focusWaybillScan();
  }

  // Засчитать деталь (как при сканировании штрихкода) и подтвердить на сервере.
  // Используется и самим сканером, и двойным кликом по строке накладной.
  async function waybillScanDetail(val, qtyOverride) {
    if (!waybillLocal || !waybillLocal.items) { setWaybillStatus("Сначала загрузите накладную"); return; }
    const valForms = waybillArtForms(val);
    let artRows = (waybillLocal.items || []).filter((it) => {
      const f = waybillArtForms(it.art);
      for (const x of valForms) { if (f.has(x)) return true; }
      return false;
    });
    let usedArt = artRows.length ? String(artRows[0].art) : "";
    if (!artRows.length) {
      // Фолбэк: артикул на стикере может идти с «мусором» (12345 → «12345 AG»).
      // Разбираем стикер на блоки и ищем единственный совпавший артикул.
      const res = resolveWaybillArtCandidates(val, waybillLocal.items);
      if (res) {
        usedArt = res;
        artRows = (waybillLocal.items || []).filter((it) => waybillNormArt(it.art) === waybillNormArt(res));
      }
    }
    // Комбинированная сборка: если сканированный код — партстикер (id_partstiker),
    // принимаем сразу «зашитое» в него количество (partQty), без ввода количества.
    let partScanQty = null;
    if (!partScanQty) {
      // «Числовое ядро» партисткера: убираем мусор сканера (пробелы, переводы строк,
      // лишние символы) и ведущие нули — 000000000020217/1 и 20217/1 совпадают.
      const psCore = (s) => {
        const p = String(s == null ? "" : s).replace(/[^\d\/]/g, "");
        const i = p.indexOf("/");
        const head = (i > 0 ? p.slice(0, i) : p).replace(/^0+/, "");
        return (i > 0 ? head + "/" + p.slice(i + 1) : head);
      };
      const psRows = (waybillLocal.items || []).filter(
        (it) => it.partsticker && psCore(it.partsticker) === psCore(val)
      );
      if (psRows.length) {
        artRows = psRows;
        usedArt = String(psRows[0].partsticker || val); // канонический код — сервер найдёт точно
        const pq = Number(psRows[0].partQty);
        partScanQty = pq > 0 ? pq : null;
      }
    }
    if (!artRows.length) {
      setWaybillStatus("ПЛОХО · деталь " + val + " не найдена в накладной");
      playScanFeedback(false, "Не найдено");
      logBarcodeScan("detail", val, false, "деталь не найдена в накладной");
      return;
    }
    // Строки с остатком: предпочитаем не помеченные «не найдено», но помеченные
    // тоже можно сканировать — тогда пометка снимается и деталь зеленеет.
    let it0 = artRows.find((it) => (Number(it.scanned) || 0) < (Number(it.qty) || 0) && !it.missing);
    if (!it0) it0 = artRows.find((it) => (Number(it.scanned) || 0) < (Number(it.qty) || 0));
    if (!it0) {
      // Деталь УЖЕ собрана (например, привязана к Боксу А). Если выбран активный
      // бокс (сканировали Бокс Б, голос «Бокс выбран») — перепривязываем деталь
      // в новый бокс: серверная rebound-ветка перезаписывает it.box. Голос
      // «Деталь перемещена». Без активного бокса — прежнее «Уже отсканировано».
      if (artRows.length && waybillBox) {
        const targetArt = String(artRows[0].art || val);
        try {
          const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/scan", {
            method: "POST",
            body: JSON.stringify({ clientIndex: waybillClientIdx, art: targetArt, qty: 0, box: waybillBox }),
          });
          if (r && r.ok && r.rebound) {
            const newBox = String((r.item && r.item.box) || waybillBox);
            artRows.forEach((x) => { x.box = newBox; });
            logBarcodeScan("detail", val, true, "перемещена");
            setWaybillStatus(`Перемещена · ${usedArt || targetArt} · в ${waybillBoxName(newBox)}`);
            playScanFeedback(true, "Деталь перемещена");
            renderWaybill();
            focusWaybillScan();
            refreshWaybillFromServer();
            return;
          }
        } catch (e) { /* сервер не ответил — ниже сообщение «уже отсканировано» */ }
      }
      setWaybillStatus("Уже отсканировано · " + val);
      playScanFeedback(false, "Уже отсканировано");
      return;
    }
    const remBefore = it0 ? Math.max(0, (Number(it0.qty) || 0) - (Number(it0.scanned) || 0)) : 0;
    // Партстикер: подтверждаем количество (предзаполнен «зашитый» volume) — оператор
    // может поправить, если по факту деталей меньше/больше. У разных партстикеров
    // одного артикула — своё количество (каждому своя строка со своим partQty).
    if (partScanQty && !qtyOverride) {
      const defTake = Math.min(Number(partScanQty) || 1, remBefore);
      if (remBefore > 1) {
        const take = await askWaybillQty(remBefore, defTake);
        if (take == null) {
          setWaybillStatus("Отменено");
          playScanFeedback(false, "Отменено");
          focusWaybillScan();
          renderWaybill();
          return;
        }
        partScanQty = Math.max(1, take);
      } else {
        partScanQty = Math.max(1, defTake);
      }
    }
    // Без активного бокса деталь НЕ засчитываем: оператор должен сначала отсканировать
    // бокс (голосом «Бокс выбран»), затем деталь. Если бокс не выбран или «слетел» —
    // жёстко не считаем сканирование и просим пересканировать бокс.
    // Исключение: деталь УЖЕ была привязана к боксу ранней привязкой (it0.box задан,
    // например, предыдущим сканом/вводом количества) — тогда активный бокс как бы
    // «восстанавливается» из строки, и скан нельзя терять: деталь не должна
    // «отвязываться» из-за случайного обнуления waybillBox (перерисовка/автообновление).
    if (!waybillBox && !(it0 && it0.box)) {
      setWaybillStatus("Не выбран бокс — отсканируйте бокс сначала");
      playScanFeedback(false, "Не выбран бокс");
      logBarcodeScan("detail", val, false, "не выбран бокс");
      focusWaybillScan();
      return;
    }
    const activeBox = waybillBox || (it0 && it0.box) || "";
    // Количественная деталь (осталось больше 1 единицы): голосом просим «Введите
    // количество» и открываем быструю модалку ввода. Если кол-во передано явно
    // (кнопка «Собрать», повторный ввод) — спрашивать не нужно.
    let scanQty = partScanQty && Number(partScanQty) > 0
      ? Math.max(1, Number(partScanQty))
      : (qtyOverride && Number(qtyOverride) > 0
        ? Math.max(1, Number(qtyOverride))
        : Math.max(1, Number(el.waybillQtyInput && el.waybillQtyInput.value) || 1));
    // Если засчитываемое количество больше остатка к приёмке — не засчитываем:
    // голосом «Фиаско», строка не зеленеет до ввода верного количества.
    if (scanQty > remBefore) {
      setWaybillStatus(`Больше, чем есть: осталось ${remBefore}`);
      playScanFeedback(false, "Это Фиаско Братан ты ввел больше чем есть");
      focusWaybillScan();
      return;
    }
    if (it0) { it0.missing = false; it0.missingQty = 0; } // найденная деталь больше не «не найдена»
    // НЕ прибавляем сканированную «1» заранее, если сейчас будет запрос количества
    // (многоштучная деталь, осталось > 1): иначе введённое N превращалось бы в N+1 /
    // «остаток N-1 → Фиаско». При запросе количества сервер засчитает ровно введённое
    // число (qtyresolve), поэтому локально `scanned` не трогаем.
    const willAskQty = !qtyOverride && !partScanQty && remBefore > 1;
    if (it0 && !willAskQty) it0.scanned = Math.min(Number(it0.scanned || 0) + scanQty, Number(it0.qty) || 1);
    const clamped = remBefore > 0 && scanQty > remBefore;
    if (it0 && activeBox) it0.box = activeBox;
    // Деталь с количеством (осталось собрать > 1 ед.) и без явного кол-ва → общий
    // (мультидевайсный) запрос ввода количества: модалка появится на всех устройствах
    // с этой сборкой, ответить может любой; засчитывается на сервере.
    if (willAskQty) {
      waybillSharedPendingArt = usedArt;
      waybillSharedPendingBox = activeBox || "";
      try {
        const rr = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/qtyrequest", {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx, art: usedArt, box: activeBox || "" }),
        });
        // Сразу кладём подтверждённый запрос в локальное состояние и открываем общую
        // модалку ввода количества — БЕЗ ожидания следующего опроса/SSE (раньше на
        // ТСД при скане детали с остатком появлялась задержка «сканируешь → введи
        // количество», т.к. окно открывалось только из refreshWaybillFromServer).
        if (rr && rr.pending && waybillLocal) waybillLocal.pending = rr.pending;
      } catch { /* если запрос не прошёл — деталь просто не засчитана */ }
      setWaybillStatus(`Введите количество: деталь ${usedArt} (осталось до ${remBefore})`);
      playScanFeedback(true, "Введите количество");
      if (waybillLocal) syncPendingQty();
      if (!(el.waybillSharedQtyModal && el.waybillSharedQtyModal.open)) focusWaybillScan();
      renderWaybill();
      return;
    }
    waybillPendingArt = "";
    renderWaybill();
    playScanFeedback(true, activeBox ? "Перемещена" : "Хорошо");
    setWaybillStatus(activeBox
      ? `Перемещена · ${usedArt} · в ${waybillBoxName(activeBox)}`
      : (clamped
          ? `ХОРОШО · ${usedArt} · оставалось ${remBefore} — засчитано ${remBefore}`
          : `ХОРОШО · ${usedArt}`));
    try {
      const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/scan", {
        method: "POST",
        body: JSON.stringify({ clientIndex: waybillClientIdx, art: usedArt, qty: scanQty, box: activeBox || undefined }),
      });
      if (r && r.ok) {
        // Обновляем ИМЕННО ту строку, которую засчитали (it0), а не первую строку
        // с таким артикулом — иначе при нескольких строках одного артикула прогресс
        // и статус «уже отсканировано» вычислялись по неверной строке.
        if (it0 && r.item) {
          it0.scanned = (r.item.scanned != null) ? r.item.scanned : it0.scanned;
          it0.box = (r.item && r.item.box != null) ? r.item.box : it0.box;
        }
        const done = (waybillLocal.items || []).filter((it) => Number(it.scanned) >= Number(it.qty)).length;
        const tail = clamped
          ? ` · оставалось ${remBefore} — засчитано ${remBefore}`
          : ` · осталось ${r.left} · готово ${done}/${waybillLocal.items.length}`;
        setWaybillStatus(`ХОРОШО · ${val}${tail}`);
        logBarcodeScan("detail", val, true, clamped ? "засчитано полностью" : "успешно", it0 && it0.partsticker, it0 && it0.art);
        renderWaybill();
        loadShipments();
        // Перечитываем накладную с сервера — чтобы при нескольких строках одного
        // артикула локальный остаток и выбор следующей (недособранной) строки были
        // всегда точными, а не считались по устаревшей копии первой строки.
        refreshWaybillFromServer();
      } else {
        if (it0) it0.scanned = Math.max(0, Number(it0.scanned || 0) - scanQty);
        setWaybillStatus("ПЛОХО · " + ((r && r.error) || "Деталь не принята"));
        playScanFeedback(false, "Плохо");
        logBarcodeScan("detail", val, false, (r && r.error) ? String(r.error) : "деталь не принята", it0 && it0.partsticker, it0 && it0.art);
        renderWaybill();
      }
    } catch (e) {
      if (it0) it0.scanned = Math.max(0, Number(it0.scanned || 0) - scanQty);
      setWaybillStatus("ПЛОХО · " + ((e && e.message) || "Ошибка приёмки детали"));
      playScanFeedback(false, "Плохо");
      logBarcodeScan("detail", val, false, (e && e.message) ? String(e.message) : "ошибка приёмки детали", it0 && it0.partsticker, it0 && it0.art);
      renderWaybill();
    }
  }

  // Кириллические «двойники» латиницы (А/А, В/В, С/С и т.п.) — из-за раскладки
  // сканер/ручной ввод дают русские буквы, а артикул в накладной — латиница (или
  // наоборот). Сводим их к латинице при сравнении.
  const RU_LOOK = {
    "А": "A", "а": "a", "В": "B", "в": "b", "С": "C", "с": "c",
    "Е": "E", "е": "e", "К": "K", "к": "k", "М": "M", "м": "m",
    "Н": "H", "н": "h", "О": "O", "о": "o", "Р": "P", "р": "p",
    "Т": "T", "т": "t", "У": "Y", "у": "y", "Х": "X", "х": "x",
    "І": "I", "і": "i"
  };
  // Кириллица → латинская клавиша по раскладке QWERTY (для случая «артикул на
  // русском, а раскладка английская»: «АРК1234» вводится как «FHR1234»).
  const CYR_TO_LAT = {
    "Й": "Q", "Ц": "W", "У": "E", "К": "R", "Е": "T", "Н": "Y", "Г": "U", "Ш": "I", "Щ": "O", "З": "P",
    "Ф": "A", "Ы": "S", "В": "D", "А": "F", "П": "G", "Р": "H", "О": "J", "Л": "K", "Д": "L",
    "Я": "Z", "Ч": "X", "С": "C", "М": "V", "И": "B", "Т": "N", "Ь": "M"
  };
  // Латиница → кириллица по раскладке QWERTY (обратный случай).
  const LAT_TO_CYR = {
    "Q": "Й", "W": "Ц", "E": "У", "R": "К", "T": "Е", "Y": "Н", "U": "Г", "I": "Ш", "O": "Щ", "P": "З",
    "A": "Ф", "S": "Ы", "D": "В", "F": "А", "G": "П", "H": "Р", "J": "О", "K": "Л", "L": "Д",
    "Z": "Я", "X": "Ч", "C": "С", "V": "М", "B": "И", "N": "Т", "M": "Ь"
  };
  // Возвращает набор «форм» артикула: исходная, по двойникам (А→A), по раскладке
  // (А→F), а также латиница→кириллица. Два артикула считаются равными, если у них
  // пересекается хоть одна форма — это ловит и кириллицу/латиницу-двойники, и
  // несовпадение раскладки.
  function waybillArtForms(s) {
    const base = String(s == null ? "" : s).toUpperCase().replace(/[\s_.\-,:/;\\]/g, "");
    if (!base) return new Set();
    const forms = new Set([base]);
    forms.add(base.split("").map((c) => RU_LOOK[c] || c).join(""));
    forms.add(base.split("").map((c) => CYR_TO_LAT[c] || c).join(""));
    forms.add(base.split("").map((c) => LAT_TO_CYR[c] || c).join(""));
    return forms;
  }
  // Приводит артикул к каноническому виду для сравнения: убирает разделители
  // («мусор») и сводит кириллических «двойников» латиницы. Применяется одинаково
  // и к стикеру, и к артикулам накладной.
  function waybillNormArt(s) {
    const t = String(s == null ? "" : s);
    const tr = t.replace(/[АаВвСсЕеКкМмНнОоРрТтУуХхІі]/g, (c) => RU_LOOK[c] || c);
    return tr.replace(/[\s_.\-,:/;\\]/g, "");
  }
  // Сокращённая форма партстикера/артикула: 000000000020217/4 -> 20217/4.
  function shortPs(s) {
    const p = String(s == null ? "" : s);
    const i = p.indexOf("/");
    const head = (i > 0 ? p.slice(0, i) : p).replace(/^0+/, "");
    return (i > 0 ? head + p.slice(i) : head);
  }
  // Возвращает артикул накладной, который содержится в очищенном стикере КАК ЕДИНАЯ
  // строка (артикул не разбиваем — ищем его целиком, а мусор вокруг отбрасываем).
  // Пример: стикер «12345AG» содержит артикул «12345» → возвращаем «12345».
  // Если содержатся несколько разных артикулов, берём самый длинный (наиболее полный);
  // если совпадений нет — пустая строка.
  function resolveWaybillArtCandidates(sticker, items) {
    if (!Array.isArray(items)) return "";
    const clean = waybillNormArt(sticker);
    if (!clean) return "";
    const seen = new Set();
    const matched = [];
    for (const it of items) {
      const a = waybillNormArt(it.art);
      if (!a || seen.has(a)) continue;
      seen.add(a);
      if (clean.includes(a)) matched.push({ norm: a, orig: String(it.art) });
    }
    if (!matched.length) return "";
    matched.sort((x, y) => y.norm.length - x.norm.length); // предпочитаем самый полный
    return matched[0].orig;
  }

  // Быстрая модалка ввода количества при скане детали с кол-вом >1.
  // Голосом озвучивает «Введите количество», открывает окно, возвращает Promise
  // с введённым числом (или null при отмене). Максимум — оставшееся количество.
  let waybillQtyAskResolve = null;
  function askWaybillQty(maxQty, defVal) {
    return new Promise((resolve) => {
      if (!el.waybillQtyAskModal || !el.waybillQtyAsk) { resolve(null); return; }
      waybillQtyAskResolve = resolve;
      const safeMax = Math.max(1, Number(maxQty) || 1);
      // Осталось всего 1 шт — незачем открывать модалку и спрашивать: сразу берём 1.
      // Это заметно ускоряет «Собрать вручную» и «Не найдено» на ТСД (раньше окно
      // ввода количества прыгало перед каждым единичным остатком).
      if (safeMax <= 1) { resolve(1); return; }
      el.waybillQtyAsk.max = String(safeMax);
      // По умолчанию предлагаем «зашитое» значение (для партстикера) или максимум.
      const init = defVal != null ? Math.max(1, Number(defVal)) : safeMax;
      el.waybillQtyAsk.value = String(Math.min(init, safeMax));
      setWaybillStatus(`Введите количество (макс ${safeMax})`);
      playScanFeedback(true, "Введите количество");
      try { el.waybillQtyAskModal.showModal(); } catch { /* уже открыта */ }
      try { el.waybillQtyAsk.focus(); el.waybillQtyAsk.select(); } catch { /* ok */ }
    });
  }
  function finishWaybillQtyAsk(isCancel) {
    const m = el.waybillQtyAskModal;
    const resolve = waybillQtyAskResolve;
    if (isCancel || !el.waybillQtyAsk) {
      waybillQtyAskResolve = null;
      if (m && m.open) { try { m.close(); } catch { /* ignore */ } }
      if (resolve) resolve(null);
      return;
    }
    const v = Math.max(1, Number(el.waybillQtyAsk.value) || 1);
    const max = Math.max(1, Number(el.waybillQtyAsk.max) || v);
    if (v > max) {
      // Ввели больше, чем осталось к приёмке: не засчитываем, не закрываем окно,
      // голосом указываем на ошибку — пока не введено верное количество.
      setWaybillStatus(`Больше, чем есть: осталось ${max}`);
      playScanFeedback(false, "Это Фиаско Братан ты ввел больше чем есть");
      el.waybillQtyAsk.value = "";
      try { el.waybillQtyAsk.focus(); } catch { /* ok */ }
      return;
    }
    waybillQtyAskResolve = null;
    if (m && m.open) { try { m.close(); } catch { /* ignore */ } }
    if (resolve) resolve(v);
    focusWaybillScan();
  }

  // ---- Печать этикеток отгрузки (склад: выбирает клиента и кол-во мест) ----
  let printRouteId = null;
  let printClientIndex = 0;
  function openPrintLabels(routeId) {
    const r = shipmentsCache.find((x) => String(x.id) === String(routeId));
    if (!r || !Array.isArray(r.clients) || r.clients.length === 0) {
      toast("В отгрузке нет клиентов для печати");
      return;
    }
    printRouteId = routeId;
    // Открываем сразу на первом клиенте, который ещё не отгружен полностью;
    // если все клиенты отгружены — остаётся первый как заглушка.
    printClientIndex = r.clients.findIndex(
      (c) => !(Number(c.totalCount) > 0 && Number(c.loadedCount) >= Number(c.totalCount))
    );
    if (printClientIndex < 0) printClientIndex = 0;
    renderPrintClientsTiles();
    el.printPlacesQty.value = "1";
    if (el.printScanStatus) { el.printScanStatus.textContent = ""; el.printScanStatus.className = "print-scan-status"; }
    refreshPrintLabels();
    try { el.printModal.showModal(); } catch { /* уже открыта */ }
    // На десктопе/Electron сразу ставим фокус в поле USB-сканера, чтобы водитель
    // мог сканировать этикетки без лишнего клика.
    // В режиме внешнего сканера (ТСД) поле фокусим ВСЕГДА — камеру не открываем.
    if (el.printScanInput && (scanSource === "external" || !(window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function"))) {
      el.printScanInput.value = "";
      el.printScanInput.focus();
    }
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

  async function doPrintLabels(append) {
    if (!printRouteId) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    if (!r) return;
    const idx = printClientIndex;
    const cl = (r.clients || [])[idx];
    if (!cl) return;
    const qty = Math.max(1, Math.min(200, Number(el.printPlacesQty.value) || 1));
    // Номер, с которого начинается печать. Обычная «Печать этикеток» (отгрузка) —
    // replace: start = 0, места 1..qty, прежние этикетки пары пересоздаются заново.
    // Печать бокса из «Сборки» («Новый бокс») — накопительная append: стартуем со
    // следующего свободного номера (N+1..N+qty), уже созданные/отсканированные
    // места не трогаем.
    let start = 0;
    if (waybillPrinting) {
      try {
        const cur = await api(`/api/labels?routeId=${encodeURIComponent(printRouteId)}&clientIndex=${idx}`);
        start = cur && Array.isArray(cur.labels) ? cur.labels.length : (Array.isArray(scanLabels) ? scanLabels.length : 0);
      } catch {
        start = Array.isArray(scanLabels) ? scanLabels.length : 0;
      }
    }
    const total = start + qty;
    // Дата отгрузки на стикере — в формате ДД.ММ.ГГГГ (r.date/день приходят как
    // YYYY-MM-DD). Если формат иной — показываем как есть.
    const _dateRaw = r.date || dayKeyOf(Date.now());
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(_dateRaw)
      ? _dateRaw.split("-").reverse().join(".")
      : _dateRaw;
    const codeBase = "BG" + printRouteId + "-" + (idx + 1) + "-";
    const area = el.printArea;
    area.innerHTML = "";
    for (let i = 1; i <= qty; i++) {
      const place = start + i;
      const code = codeBase + place;
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
        `<div class="label-order">Отгрузка ${escapeHtml(dateStr)}</div>` +
        `` +
        (() => {
          // QR на этикетке — крупный и читаемый (~70px ≈ 18.5 мм): стикер
          // квадратный 58×58 мм, высоты с запасом хватает. Раньше драйвер
          // резал по 40 мм (58×40) и QR переезжал на следующий стикер — теперь
          // физическая высота этикетки 58 мм, QR помещается вместе со всем.
          const q = buildQrImage(code);
          const px = (q && q.size) ? 70 : 0;
          return `<div class="label-qr">${px && q.src ? `<img alt="QR" width="${px}" height="${px}" src="${q.src}" />` : ""}</div>`;
        })() +
        // На стикере вместо «кракозябистого» кода показываем «Бокс N»; сам код
        // остаётся в QR (создаётся выше через buildQrImage(code)).
        `<div class="label-code">${escapeHtml(waybillBoxName(code))}</div>`;
      area.appendChild(card);
    }
    // Синхронизируем напечатанные места с серверным хранилищем этикеток (Шаг 2):
    // по тем же кодам QR склад/водитель потом отмечают погрузку и выгрузку.
    // Запись не блокирует печать — при сбое печать всё равно выполнится.
    try {
      api("/api/labels", {
        method: "POST",
        body: JSON.stringify({ routeId: printRouteId, clientIndex: idx, qty, mode: waybillPrinting ? "append" : "replace" }),
      }).then((r) => {
        if (r && Array.isArray(r.labels)) {
          if (waybillPrinting) {
            toast(`Новый бокс: всего мест ${r.labels.length}`);
          } else {
            toast(`Создано мест: ${r.labels.length} — можно сканировать при погрузке/выгрузке`);
          }
          refreshPrintLabels();
        }
      }).catch(() => {});
    } catch { /* ignore */ }
    // Единый запуск печати (отгрузка/допечатка/бокс — одна точка).
    dispatchStickerPrint(waybillPrinting ? (function () {}) : ensurePrintModalRestored);
    // Печать бокса из «Сборки» завершена — флаг больше не нужен (callback уже
    // выбран на момент вызова печати, поэтому сброс безопасен).
    waybillPrinting = false;
  }

  // Стикерные стили 58×58 мм, продублированные для печатного iframe. Идентичны
  // тем, что в styles.css применяются к #printArea в @media print: QR, логотип,
  // код и «Отгрузка ДД.ММ.ГГГГ» — те же размеры, что печатает склад.
  const STICKER_CSS = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #000; background: #fff; }
    .label-card { width: 58mm; padding: 5mm 4mm 3mm; border: 1.5px solid #000; text-align: center; page-break-after: always; }
    .label-card:last-child { page-break-after: auto; }
    .label-logo img, .label-logo { width: 40px; height: 40px; object-fit: contain; display: block; margin: 0 auto 1mm; }
    .label-logo-empty { display: grid; place-items: center; color: #bbb; font-size: 9px; border: 1px dashed #ccc; }
    .label-logo-text { display: inline-flex; align-items: center; justify-content: center; width: auto; min-width: 40px; max-width: 100%; height: 40px; padding: 0 8px; overflow: hidden; white-space: nowrap; border-radius: 7px; background: #fff; color: #000; font-weight: 900; letter-spacing: .5px; font-size: 15px; border: 1px solid #000; }
    .label-name { font-size: 10px; font-weight: 800; color: #000; margin-top: .6mm; }
    .label-addr { font-size: 9px; font-weight: 700; color: #000; margin-top: .8mm; }
    .label-order { font-size: 8px; font-weight: 700; color: #000; margin-top: .8mm; }
    .label-qr { margin: 1mm auto 0; line-height: 0; }
    .label-code { font-size: 8px; font-weight: 700; color: #000; margin-top: .6mm; letter-spacing: .3px; font-family: monospace; }
    .label-from { font-size: 8px; font-weight: 700; color: #444; margin-top: .5mm; }
  `;

  // Печать этикеток через iframe: основной документ НЕ перезагружается, поэтому
  // пользователь остаётся в разделе «Отгрузка» после печати.
  //
  // Что важно (и что проверено на боевой среде):
  //  - iframe НЕЛЬЗЯ прятать через visibility:hidden/display:none или нулевой
  //    размер: тогда contentWindow.print() печатает РОДИТЕЛЬСКИЙ документ (A4 +
  //    этикетка в углу) и теряется состояние раздела.
  //  - iframe НЕЛЬЗЯ оставлять видимым на экране — пользователь видит «кусок
  //    стикера» в углу и путается.
  // Решение — держим iframe в лейауте С РЕАЛЬНЫМ размером (58мм-этикетка), но
  // сдвинутым далеко за пределы видимой области (off-screen): он не виден
  // глазу, но браузер печатает именно его содержимое (58×58 мм), а не главный
  // документ. Фолбэка на window.print() нет — он и вызывал «вылет».
  // Настольная сборка (Electron): window.print() на главной странице перехватывается
  // в electron/main.js и печатает молча (#printArea, без окна). Возвращает true,
  // если приложение запущено внутри настольной оболочки.
  function isElectronDesktop() {
    try {
      if (typeof navigator !== "undefined" && /electron\//i.test(String(navigator.userAgent || ""))) return true;
      // Запасные признаки Electron (если userAgent переопределён/иная обёртка).
      if (typeof window !== "undefined" && window.process && window.process.versions && window.process.versions.electron) return true;
      if (typeof process !== "undefined" && process.versions && process.versions.electron) return true;
      return false;
    } catch { return false; }
  }
  // Может ли эта точка печатать стикер прямо здесь: Electron — да (тихо), браузер —
  // да (через диалог peчати), Android/ТСД — нет (WebView не печатает; стикер с ПК).
  function canPrintHere() {
    if (isElectronDesktop()) return true;
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") return false;
    return true;
  }
  // Единый запуск печати стикеров для всех мест (отгрузка, допечатка, бокс).
  //  - Наш десктоп-шелл (Electron): печатаем через нативный мост printStickerBridge
  //    (IPC → main-процесс → webContents.print). Ему песочница не мешает.
  //  - ТСД/Android WebView: печать не делаем (WebView не печатает; стикер с ПК).
  //  - Обычный браузер И любой чужой Electron-браузер (напр. встроенный браузер
  //    Коворка, который тоже отдаёт 'electron' в userAgent): печатаем через скрытый
  //    iframe. НЕ вызываем window.print() на главном документе по одному лишь
  //    признаку 'electron' в UA — такие браузеры держат документ в песочнице без
  //    allow-modals, и window.print() молча игнорируется («document is sandboxed»).
  function dispatchStickerPrint(restoreModal) {
    // Наш десктоп-шелл: нативный мост уже отдаёт странице printStickerBridge.
    if (typeof window.printStickerBridge !== "undefined" && window.printStickerBridge
        && typeof window.printStickerBridge.print === "function") {
      const html = (el.printArea && el.printArea.innerHTML) || "";
      if (html) { try { window.printStickerBridge.print(html); } catch (_) { /* ignore */ } }
      return;
    }
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
      return; // Android/ТСД — WebView не печатает.
    }
    // Браузер и чужие Electron-браузеры: скрытый iframe (проверенный способ).
    printStickersViaIframe(typeof restoreModal === "function" ? restoreModal : (function () {}));
  }
  function printStickersViaIframe(restoreModal) {
    const area = el.printArea;
    if (!area) return;
    const html = area.innerHTML;
    if (!html) return;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    // Реальный размер (= этикетка), но за экраном: left/top отрицательные и
    // большие, чтобы iframe не был виден, оставаясь печатаемым.
    iframe.style.cssText =
      "position:fixed;left:-20000px;top:0;width:160px;height:160px;border:0;" +
      "z-index:-1;background:#fff;";
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<style>@page { size: 58mm auto; margin: 0; }" + STICKER_CSS + "</style>" +
      "</head><body>" + html + "</body></html>"
    );
    doc.close();
    // Ждём, пока QR-картинки (data-url) и внешние логотипы отрисуются, потом печатаем.
    const imgs = Array.prototype.slice.call(doc.querySelectorAll("img"));
    let pending = imgs.length || 0;
    // Страховка: печать ВСЕГДА срабатывает, даже если события load/error у QR-картинки
    // не придут (бывает на некоторых устройствах — без этого окно печати «молчит»).
    let fired = false;
    const removed = () => { setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* ignore */ } }, 1000); };
    const go = () => {
      if (fired) return;
      fired = true;
      let printed = false;
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        printed = true;
      } catch {
        printed = false;
      }
      removed();
      if (!printed) {
        // Печать из iframe заблокирована средой (часто на складских/встроенных
        // браузерах). Открываем системный диалог печати на главном документе —
        // благодаря @media print напечатается только #printArea (стикер).
        try {
          window.print();
        } catch (_) { /* окна печати нет вообще */ }
      }
      // Страховка для Коворка: встроенный просмотрщик после print() может сбросить
      // модальное окно. Если передан колбэк восстановления — вызываем его с
      // небольшой задержкой, чтобы печать успела отпустить диалог.
      if (typeof restoreModal === "function") {
        setTimeout(() => { try { restoreModal(); } catch { /* ignore */ } }, 80);
      }
    };
    if (pending === 0) { setTimeout(go, 200); return; }
    const onImg = () => { pending -= 1; if (pending <= 0) setTimeout(go, 150); };
    imgs.forEach((im) => {
      if (im.complete) { pending -= 1; return; }
      im.addEventListener("load", onImg);
      im.addEventListener("error", onImg);
    });
    if (pending <= 0) setTimeout(go, 200);
    // Принудительно запускаем печать через фиксированное время, если картинки так
    // и не «прогрузились» (иначе окно печати может не появиться на части устройств).
    setTimeout(go, 900);
  }

  // Страховка: возвращает модалку печати, если печать (в просмотрщике Коворка)
  // сбросила её окно. Состояние маршрута и выбранного клиента уже сохранено в
  // printRouteId/printClientIndex, поэтому просто переоткрываем модалку и
  // обновляем список этикеток — индекс клиента НЕ пересчитываем.
  function ensurePrintModalRestored() {
    if (!el.printModal || el.printModal.open) return;
    if (!printRouteId) return;
    refreshPrintLabels();
    try { el.printModal.showModal(); } catch { /* уже открыта */ }
    if (el.printScanInput && (scanSource === "external" || !(window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function"))) {
      el.printScanInput.value = "";
      el.printScanInput.focus();
    }
  }

  // Аналогичная страховка для окна «Допечатать места»: возвращает его, если
  // печать допечатанных этикеток сбросила окно. Состояние в appendRouteId/
  // appendClientIndex уже сохранено.
  function ensureAppendModalRestored() {
    if (!el.appendModal || el.appendModal.open) return;
    if (appendRouteId == null) return;
    renderAppendClientsTiles();
    updateAppendConfirmState();
    try { el.appendModal.showModal(); } catch { /* уже открыта */ }
  }

  // ---- Допечатка дополнительных мест (отдельное окно) ----
  // Отдельная модалка показывает ВСЕХ клиентов маршрута — в т.ч. уже отгруженных
  // (закрытых) — чтобы можно было допечатать этикетки для мест, найденных позже.
  // Каждое допечатывание сохраняется на сервере (режим append), поэтому закрытие
  // окна «с сохранением» — это просто закрытие: данные уже записаны.
  let appendRouteId = null;
  let appendClientIndex = -1;

  function openAppendModal(routeId) {
    const r = shipmentsCache.find((x) => String(x.id) === String(routeId));
    if (!r || !Array.isArray(r.clients) || r.clients.length === 0) {
      toast("В отгрузке нет клиентов для допечатки");
      return;
    }
    appendRouteId = routeId;
    appendClientIndex = -1;
    if (el.appendPlacesQty) el.appendPlacesQty.value = "1";
    renderAppendClientsTiles();
    updateAppendConfirmState();
    try { el.appendModal.showModal(); } catch { /* уже открыта */ }
  }

  function appendClientDone(c) {
    return Number(c.totalCount) > 0 && Number(c.loadedCount) >= Number(c.totalCount);
  }

  // Плитки клиентов в окне допечатки: ВСЕ клиенты, включая отгруженных (is-done).
  function renderAppendClientsTiles() {
    const r = shipmentsCache.find((x) => String(x.id) === String(appendRouteId));
    const clients = r && Array.isArray(r.clients) ? r.clients : [];
    if (!el.appendClientsTiles) return;
    if (clients.length === 0) { el.appendClientsTiles.innerHTML = ""; return; }
    el.appendClientsTiles.innerHTML = clients.map((c, i) => {
      const done = appendClientDone(c);
      const total = Number(c.totalCount) || 0;
      const loaded = Number(c.loadedCount) || 0;
      const labelled = c.labelQty != null && Number(c.labelQty) > 0 ? Number(c.labelQty) : 0;
      const places = labelled ? `мест: ${labelled}` : `${loaded} / ${total}`;
      const cls = [
        "print-client-tile",
        i === appendClientIndex ? "is-active" : "",
        done ? "is-done" : "",
      ].filter(Boolean).join(" ");
      // Допечатать можно только клиента, у которого ВСЕ боксы уже погружены.
      // Пока боксы не созданы или создана лишь часть — места добавляют обычной
      // кнопкой «Печать этикеток» через выбор клиента, поэтому допечатка тут
      // недоступна (плитка отключена).
      const appendTitle = done
        ? "Отгружен — можно допечатать новые места"
        : "Допечатка доступна, только когда все боксы клиента уже погружены";
      return `
        <button type="button" class="${cls}" data-append-client-index="${i}" title="${appendTitle}"${done ? "" : " disabled"}>
          <span class="tile-name">${escapeHtml((c.members && c.members.length) ? (c.bundleName || c.address || c.client || "Связка") : (c.client || "—"))}</span>
          <span class="tile-places">${done ? "отгружен · " + places : places}</span>
        </button>
      `;
    }).join("");
  }

  function updateAppendConfirmState() {
    // Подтвердить можно только выбранного полностью погруженного клиента.
    let canConfirm = false;
    if (appendClientIndex >= 0) {
      const r = shipmentsCache.find((x) => String(x.id) === String(appendRouteId));
      const cl = r && Array.isArray(r.clients) ? r.clients[appendClientIndex] : null;
      if (cl) canConfirm = Number(cl.totalCount) > 0 && Number(cl.loadedCount) >= Number(cl.totalCount);
    }
    if (el.appendConfirm) el.appendConfirm.disabled = !canConfirm;
  }

  // Допечать этикеток выбранному клиенту (режим append): сервер добавляет новые
  // места СВЕРХ существующих, ничего не трогая. Затем печатаем добавленные стикеры.
  async function doAppendLabels() {
    if (appendRouteId == null || appendClientIndex < 0) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(appendRouteId));
    const cl = r && Array.isArray(r.clients) ? r.clients[appendClientIndex] : null;
    if (!r || !cl) return;
    const qty = Math.max(1, Math.min(200, Number(el.appendPlacesQty && el.appendPlacesQty.value) || 1));
    el.appendConfirm.disabled = true;
    const res = await api("/api/labels", {
      method: "POST",
      body: JSON.stringify({ routeId: appendRouteId, clientIndex: appendClientIndex, qty, mode: "append" }),
    }).catch(() => null);
    updateAppendConfirmState();
    if (!res || !Array.isArray(res.labels)) {
      toast("Не удалось допечатать места. Попробуйте ещё раз.");
      return;
    }
    // Обновляем живые счётчики этого клиента и кэш маршрута (данные уже на сервере).
    cl.loadedCount = res.labels.filter((l) => l.status === "loaded").length;
    cl.totalCount = res.labels.length;
    cl.labelQty = res.labels.length;
    toast(`Допечатано мест: ${qty}. Всего у клиента: ${res.labels.length}`);
    renderAppendClientsTiles();
    updateAppendConfirmState();
    // Обновляем счётчики основной модалки печати и ленты отгрузок.
    refreshShipmentTileCounters();
    // Печатаем только что добавленные стикеры.
    printAppendStickers(r, cl, res.labels, qty);
  }

  // Строит этикетки для допечатанных мест (последние qty) и печатает их через
  // iframe — так же, как делает «Печать этикеток», но только для новых мест.
  function printAppendStickers(r, cl, labels, qty) {
    const area = el.printArea;
    if (!area) return;
    const added = (labels || []).slice(-qty);
    if (added.length === 0) return;
    const _dateRaw = r.date || dayKeyOf(Date.now());
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(_dateRaw)
      ? _dateRaw.split("-").reverse().join(".")
      : _dateRaw;
    const total = (labels || []).length;
    const codeBase = "BG" + appendRouteId + "-" + (appendClientIndex + 1) + "-";
    area.innerHTML = "";
    added.forEach((l) => {
      const place = Number(l.place);
      const code = String(l.code || codeBase + place);
      const card = document.createElement("div");
      card.className = "label-card";
      let logoHtml = "";
      if (cl.logoText) {
        logoHtml = `<div class="label-logo label-logo-text">${escapeHtml(cl.logoText)}</div>`;
      } else if (cl.logo) {
        logoHtml = `<div class="label-logo"><img src="${cl.logo}" alt="лого" crossorigin="anonymous" /></div>`;
      }
      const q = buildQrImage(code);
      const px = (q && q.size) ? 70 : 0;
      card.innerHTML =
        logoHtml +
        `<div class="label-order">Отгрузка ${escapeHtml(dateStr)}</div>` +
        `` +
        `<div class="label-qr">${px && q.src ? `<img alt="QR" width="${px}" height="${px}" src="${q.src}" />` : ""}</div>` +
        `<div class="label-code">${escapeHtml(waybillBoxName(code))}</div>`;
      area.appendChild(card);
    });
    dispatchStickerPrint(ensureAppendModalRestored);
  }

  // ---- Сканирование этикеток (погрузка/выгрузка) — Шаг 3 ----
  // Непрерывное сканирование и живой счётчик: состояние scanLabels + scanProgress.
  // После каждого успешного скана, пока есть неотсканированные места, сканер
  // открывается снова автоматически; когда всё готово — цикл останавливается.
  // Индекс выбранного клиента в модалке печати (0-based, как в select печати).
  function currentPrintClientIndex() {
    return printClientIndex;
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
      logApp("info", "invokeNativeScan call " + action + " done=" + done + " need=" + need + " client=" + client);
      const res = window.AndroidBridge.scanQR(
        callback,
        action,
        Number(done) || 0,
        Number(need) || 0,
        String(client || "")
      );
      logApp("info", "invokeNativeScan returned " + String(res));
      return true;
    } catch (e) {
      logApp("error", "invokeNativeScan new-signature failed: " + (e && e.message ? e.message : String(e)));
      // Старый мост не принимает 5 аргументов — пробуем усечённую сигнатуру.
      try {
        window.AndroidBridge.scanQR(callback, action);
        return true;
      } catch (_) {
        logApp("error", "invokeNativeScan legacy failed too");
        return false;
      }
    }
  }

  // Закрыть открытый нативный сканер из веба. Вызывается, когда все места
  // отсканированы (погрузка: prog.remaining <= 0; выгрузка: клиент unloadReady),
  // чтобы нельзя было просканировать бокс повторно или сверх нормы — иначе камера
  // оставалась бы открытой и счётчик рос дальше положенного, плодя лишние дубли.
  function closeNativeScan() {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.closeScan === "function") {
        window.AndroidBridge.closeScan();
      }
    } catch (_) { /* моста нет/старый APK — камера закроется сама по крестику */ }
  }

  // Текущий режим сканирования мест (load/unload) и актуальный список этикеток
  // выбранного клиента. Нужны для непрерывного сканирования и живого счётчика.
  let scanMode = null;
  let scanAuto = false;
  let scanLabels = [];
  // Источник сканирования в окне отгрузки («Погрузка»):
  //   "camera"   — нативная камера (AndroidBridge.scanQR / сканер APK);
  //   "external" — встроенный/внешний сканер ТСД (клавиатурный ввод: кнопка
  //                сканера «печатает» код + Enter). Позволяет сканировать
  //                на ТСД с аппаратным сканером, не открывая камеру.
  // Выбор запоминается на устройстве. В WebView ТСД localStorage может быть
  // отключён (отсутствует DOM Storage) — тогда пишем ещё и в cookie, который
  // переживает перезапуск приложения. Оба пути в try/catch-фолбэках, чтобы
  // выбор гарантированно не терялся и работал в текущей сессии в любом случае.
  const SCAN_SRC_KEY = "biotime.scanSource";
  const readScanSource = () => {
    // cookie и localStorage читаем безопасно; приоритет localStorage.
    let fromLS = null;
    try { fromLS = localStorage.getItem(SCAN_SRC_KEY); } catch (_) {}
    if (fromLS === "external") return "external";
    try {
      const m = (document.cookie || "").split(";").map((s) => s.trim())
        .find((s) => s.indexOf(SCAN_SRC_KEY + "=") === 0);
      if (m && m.slice(SCAN_SRC_KEY.length + 1) === "external") return "external";
    } catch (_) {}
    return "camera";
  };
  const writeScanSource = (v) => {
    try { localStorage.setItem(SCAN_SRC_KEY, v); } catch (_) {}
    try {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 5);
      document.cookie = SCAN_SRC_KEY + "=" + v + "; expires=" + d.toUTCString() + "; path=/";
    } catch (_) {}
  };
  let scanSource = readScanSource();
  // Это устройство с аппаратным сканером (ТСД)? Нативный мост AndroidBridge.isTCD()
  // определяет его по модели/производителю. Если ТСД — камера не используется:
  // автоматически ставим внешний сканер и скрываем кнопку «Камера».
  let isTcdDevice = false;
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.isTCD === "function") {
      isTcdDevice = !!window.AndroidBridge.isTCD();
    }
  } catch (_) { /* нативного моста нет — устройство не ТСД */ }
  if (isTcdDevice) {
    scanSource = "external";
    waybillTcd = true; // на ТСД список деталей — в модальном окне через кнопку
    document.body.classList.add("tcd");
    // Поле штрих/артикула на ТСД делаем read-only: клик по нему не открывает
    // экранную клавиатуру, а код по-прежнему заносится аппаратным сканером.
    try { if (el.waybillArtInput) el.waybillArtInput.readOnly = true; } catch { /* ignore */ }
  }
  function applyScanSourceUI() {
    try {
      const ext = scanSource === "external";
      // На ТСД источник «Камера» скрываем полностью.
      if (el.scanSrcCamera) {
        el.scanSrcCamera.hidden = isTcdDevice;
        el.scanSrcCamera.classList.toggle("is-active", !ext && !isTcdDevice);
      }
      if (el.scanSrcExternal) {
        el.scanSrcExternal.hidden = false;
        el.scanSrcExternal.classList.toggle("is-active", ext || isTcdDevice);
      }
      if (el.printScanHint) {
        el.printScanHint.hidden = !(ext || isTcdDevice);
        if (ext || isTcdDevice) {
          el.printScanHint.textContent =
            "Режим внешнего сканера: нажмите кнопку сканера на ТСД, наведите на этикетку — код считается без открытия камеры.";
        }
      }
    } catch (_) { /* не критично */ }
  }
  function setScanSource(src) {
    // На ТСД камера недоступна — принудительно внешний сканер.
    if (isTcdDevice) src = "external";
    scanSource = (src === "external") ? "external" : "camera";
    writeScanSource(scanSource);
    applyScanSourceUI();
  }

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
        <button type="button" class="pp-print" data-label-print="${escapeHtml(l.id)}" title="Распечатать повторно" aria-label="Повторная печать">🖨</button>
        ${l.status === "created"
          ? `<button type="button" class="pp-del" data-label-del="${escapeHtml(l.id)}" title="Удалить этикетку" aria-label="Удалить этикетку">✕</button>`
          : ""}
      </div>
    `).join("");
    // Живое обновление плиток клиентов: после каждого скана пересчитываем
    // отгруженные места текущего клиента и перерисовываем статусы плиток
    // (полностью отгруженный клиент становится серым).
    try {
      const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
      const cl = r && Array.isArray(r.clients) ? r.clients[currentPrintClientIndex()] : null;
      if (cl) {
        cl.loadedCount = scanLabels.filter((l) => l.status === "loaded").length;
        cl.totalCount = scanLabels.length;
      }
      renderPrintClientsTiles();
    } catch (e) { /* не критично */ }
  }

  // Повторная печать одного созданного стикера: берём код этикетки и печатаем
  // ровно одну label-card (тем же макетом, что и при создании), без создания
  // новых мест и без изменения статуса/хранилища.
  function printOneLabel(labelId) {
    const l = (scanLabels || []).find((x) => String(x.id) === String(labelId));
    if (!l) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    const cl = r && Array.isArray(r.clients) ? r.clients[printClientIndex] : null;
    const _dateRaw = (r && r.date) || dayKeyOf(Date.now());
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(_dateRaw)
      ? _dateRaw.split("-").reverse().join(".")
      : _dateRaw;
    const code = String(l.code || "");
    let logoHtml = "";
    if (cl && cl.logoText) {
      logoHtml = `<div class="label-logo label-logo-text">${escapeHtml(cl.logoText)}</div>`;
    } else if (cl && cl.logo) {
      logoHtml = `<div class="label-logo"><img src="${cl.logo}" alt="лого" crossorigin="anonymous" /></div>`;
    }
    const q = buildQrImage(code);
    const px = (q && q.size) ? 70 : 0;
    const card = document.createElement("div");
    card.className = "label-card";
    card.innerHTML =
      logoHtml +
      `<div class="label-order">Отгрузка ${escapeHtml(dateStr)}</div>` +
      `` +
      `<div class="label-qr">${px && q.src ? `<img alt="QR" width="${px}" height="${px}" src="${q.src}" />` : ""}</div>` +
      `<div class="label-code">${escapeHtml(waybillBoxName(code))}</div>`;
    const area = el.printArea;
    if (area) { area.innerHTML = ""; area.appendChild(card); }
    dispatchStickerPrint(function restoreAfterSinglePrint() {});
  }

  // Плитки клиентов окна «Отгрузка»: вместо выпадающего списка клиентов —
  // карточки. Активный клиент подсвечен; полностью отгруженный (все места
  // погружены) перестаёт подсвечиваться и становится серым.
  function renderPrintClientsTiles() {
    if (!el.printClientsTiles) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    const clients = r && Array.isArray(r.clients) ? r.clients : [];
    if (clients.length === 0) {
      el.printClientsTiles.innerHTML = "";
      return;
    }
    // Кнопки-плитки создаются ОДИН раз (когда контейнер ещё пуст), а при
    // последующих вызовах мы только переключаем классы и обновляем текст.
    // Это важно для десктопа (Electron): если пересоздавать innerHTML прямо под
    // курсором в момент клика, событие click успевает «прицелиться» в заново
    // отрисованную первую плитку и сбросить выбор на клиента 0 (в логе видно
    // «clientIndex=1 → clientIndex=0 за ~60 мс»). Стабильные кнопки устраняют
    // этот повторный вызов.
    // Пересоздаём только если кнопок ещё нет ИЛИ их число не совпадает с числом
    // клиентов (маршрут мог измениться). При одинаковом количестве — обновляем
    // классы/текст, не трогая DOM (защита от сброса выбора в Electron).
    const existing = el.printClientsTiles.querySelectorAll(".print-client-tile");
    if (existing.length !== clients.length) {
      el.printClientsTiles.innerHTML = clients.map((c, i) => {
      const done = Number(c.totalCount) > 0 && Number(c.loadedCount) >= Number(c.totalCount);
      const cls = [
        "print-client-tile",
        i === printClientIndex ? "is-active" : "",
        done ? "is-done" : "",
      ].filter(Boolean).join(" ");
      const total = Number(c.totalCount) || 0;
      const loaded = Number(c.loadedCount) || 0;
      const places = done ? `отгружено ${loaded}` : `${loaded} / ${total}`;
      // Для связки (несколько контрагентов на адресе) показываем ЕДИНОЕ название
      // (bundleName), если оно задано; иначе — общий адрес связки, как раньше.
      const isBundle = Array.isArray(c.members) && c.members.length > 0;
      const tileName = (isBundle ? (c.bundleName || c.address || c.client || "Связка") : (c.client || "—"));
      return `
        <button type="button" class="${cls}" data-client-index="${i}" title="${done ? "Клиент отгружен — можно допечатать новые места" : ""}">
          <span class="tile-name">${escapeHtml(tileName)}</span>
          <span class="tile-places">${places}</span>
        </button>
      `;
      }).join("");
    } else {
      // Контейнер уже заполнен — обновляем только активную подсветку/текст.
      const buttons = Array.from(el.printClientsTiles.querySelectorAll(".print-client-tile"));
      buttons.forEach((btn, i) => {
        const c = clients[i];
        const done = c ? (Number(c.totalCount) > 0 && Number(c.loadedCount) >= Number(c.totalCount)) : false;
        btn.classList.toggle("is-active", i === printClientIndex);
        btn.classList.toggle("is-done", !!done);
        btn.title = done ? "Клиент отгружен — можно допечатать новые места" : "";
        const nameEl = btn.querySelector(".tile-name");
        if (nameEl && c) {
          const isBundle = Array.isArray(c.members) && c.members.length > 0;
          nameEl.textContent = isBundle ? (c.bundleName || c.address || c.client || "Связка") : (c.client || "—");
        }
        const placesEl = btn.querySelector(".tile-places");
        if (placesEl && c) {
          const total = Number(c.totalCount) || 0;
          const loaded = Number(c.loadedCount) || 0;
          placesEl.textContent = done ? `отгружено ${loaded}` : `${loaded} / ${total}`;
        }
      });
    }
    updatePrintAppendBtn();
  }

  // Кнопку «Допечатать места» разрешаем только когда у выбранного клиента ВСЕ
  // боксы уже погружены (полностью отгружен). Пока боксы не созданы или создана
  // лишь часть — допечатка недоступна, новые места добавляются выбором клиента
  // и кнопкой «Печать этикеток». Это не даёт случайно допечатать поверх места,
  // которое ещё полностью не отгружено.
  function updatePrintAppendBtn() {
    if (!el.printAppendBtn) return;
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    const cl = r && Array.isArray(r.clients) ? r.clients[printClientIndex] : null;
    const done = cl
      ? Number(cl.totalCount) > 0 && Number(cl.loadedCount) >= Number(cl.totalCount)
      : false;
    el.printAppendBtn.disabled = !done;
    el.printAppendBtn.title = done
      ? "Допечатать дополнительные места, не трогая уже созданные"
      : "Допечатка доступна, когда все боксы клиента уже погружены";
  }

  // Переключение активного клиента по клику на плитку.
  function selectPrintClient(idx) {
    const r = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
    const clients = r && Array.isArray(r.clients) ? r.clients : [];
    if (idx < 0 || idx >= clients.length) return;
    // Если активная плитка уже та же — ничего не делаем (не пересоздаём DOM).
    if (idx === printClientIndex) return;
    printClientIndex = idx;
    // Лёгкая смена активной плитки: только переключить CSS-класс is-active,
    // НЕ пересоздавая innerHTML кнопок. Пересоздание пальтиток во время
    // обработки клика ломало переключение в изолированном окне Electron
    // (DOM кнопки под кликом заменялся, событие/фокус сбивались и выбор
    // «откатывался» на первого клиента). Обновление классов этого лишено.
    applyPrintActiveTile();
    refreshPrintLabels();
  }

  // Переключает класс is-active между плитками, не трогая их innerHTML.
  function applyPrintActiveTile() {
    const wrap = el.printClientsTiles;
    if (!wrap) return;
    const tiles = wrap.querySelectorAll(".print-client-tile");
    tiles.forEach((tile) => {
      const idx = Number(tile.dataset.clientIndex);
      tile.classList.toggle("is-active", idx === printClientIndex);
    });
  }

  // Пересчитывает счётчики отгруженных мест ВСЕХ клиентов маршрута и перерисовывает
  // плитки. Нужно, чтобы сканы мест разных клиентов могли идти в любой последовательности:
  // отсканировав место любого клиента, плитка этого клиента сразу получает актуальное
  // количество, а полностью отгруженный клиент перестаёт подсвечиваться (становится серым).
  async function refreshShipmentTileCounters() {
    try {
      const r = await api("/api/shipments");
      if (r && Array.isArray(r.routes)) shipmentsCache = r.routes;
    } catch (e) { /* не критично */ }
    renderPrintClientsTiles();
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

  // Удалить ошибочно созданную этикетку (ещё в статусе «создана»).
  // Сервер отклоняет удаление уже отсканированных (loaded/delivered) — тут просто
  // показываем его сообщение. После удаления перерисовываем список и счётчики.
  async function deletePrintLabel(id, code) {
    if (!id) return;
    if (!window.confirm(`Удалить этикетку ${code ? String(code) : ""}?\nОтсканированные места удалить нельзя.`)) {
      return;
    }
    try {
      const r = await api(`/api/labels/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (r && r.ok) {
        toast("Этикетка удалена");
        await refreshPrintLabels();
        refreshShipmentTileCounters();
      } else {
        toast((r && r.error) || "Не удалось удалить этикетку");
        await refreshPrintLabels();
      }
    } catch (e) {
      toast((e && (e.error || e.message)) || "Не удалось удалить этикетку");
    }
  }

  // Запуск сканирования: при наличии нативного моста (Android APK) — камера,
  // иначе (браузер/десктоп) — ручной ввод кода.
  function callQrScanner(action) {
    scanMode = action === "unload" ? "unload" : "load";
    setPrintScanStatus("");
    // Внешний сканер ТСД: камеру НЕ открываем — считываем код физической
    // кнопкой сканера (клавиатурный ввод в поле printScanInput + глобальный
    // перехват). Так аппаратный сканер Atol работает без камеры.
    if (scanSource === "external" && el.printScanInput) {
      el.printScanInput.value = "";
      el.printScanInput.focus();
      setPrintScanStatus(
        `Наведите сканер ТСД на этикетку (${action === "load" ? "погрузка" : "выгрузка"})…`,
        "warn"
      );
      return;
    }
    if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
      if (typeof window.qrScanCallback !== "function") window.qrScanCallback = qrScanCallback;
      const prog = scanProgress(scanLabels, action);
      invokeNativeScan("qrScanCallback", action, prog.done, prog.need, scanClientName());
      return;
    }
    // Fallback без камеры: имя склада вне Android-обёртки. Вводим код вручную.
    // На десктопе/Electron работает поле для USB-сканера (клавиатурного):
    // сканер «печатает» код в поле и жмёт Enter, либо код вводится вручную.
    if (el.printScanInput) {
      el.printScanInput.value = "";
      el.printScanInput.focus();
      setPrintScanStatus(`Наведите сканер на этикетку (${action === "load" ? "погрузка" : "выгрузка"})…`, "warn");
      return;
    }
    // Запасной вариант (старая сборка без поля): ручной ввод.
    setPrintScanStatus("Сканера нет на этом устройстве", "warn");
    const code = prompt(`Введите код этикетки (${action === "load" ? "погрузка" : "выгрузка"}):`);
    if (code == null || !String(code).trim()) { setPrintScanStatus("Сканирование отменено", "warn"); return; }
    doScanLabel(action, String(code).trim());
  }

  // Нормализует код этикетки, если он введён с русской раскладкой клавиатуры.
  // USB-сканер «печатает» символы штрих-кода через текущую раскладку ОС: латинские
  // буквы кода (напр. «BG...») при включённой русской раскладке становятся
  // кириллическими («ИП...»), и сервер не находит этикетку. Здесь переводим
  // кириллические буквы обратно в латинские, сохраняя регистр. Цифры и дефис в
  // обеих раскладках совпадают и не трогаются.
  const RU_TO_EN = {
    "й":"q","ц":"w","у":"e","к":"r","е":"t","н":"y","г":"u","ш":"i","щ":"o","з":"p",
    "ф":"a","ы":"s","в":"d","а":"f","п":"g","р":"h","о":"j","л":"k","д":"l",
    "я":"z","ч":"x","с":"c","м":"v","и":"b","т":"n","ь":"m",
    "ё":"`","ъ":"]","х":"[","ж":";","э":"'","б":",","ю":"."
  };
  function normalizeLabelCode(raw) {
    if (!raw) return raw;
    let out = "";
    for (const ch of String(raw)) {
      const lower = ch.toLowerCase();
      const en = RU_TO_EN[lower];
      if (en) out += ch === lower ? en : en.toUpperCase();
      else out += ch;
    }
    return out;
  }

  // Звуковая и тактильная обратная связь при сканировании боксов.
  // ОСНОВНОЙ канал — голос: «Хорошо» / «Плохо» (SpeechSynthesis). Как только
  // найден русский TTS-голос, бип заглушается до еле слышного «тика», чтобы
  // голос был главным. Если на устройстве (некоторые ТСД/WebView) голосовых
  // движков нет — остаётся бип как запасной сигнал. Вибрация — третий слой.
  let _scanCtx = null;
  function scanBeep(ok) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!_scanCtx) _scanCtx = new AC();
      const ctx = _scanCtx;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      const tone = (freq, start, dur, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "square";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(start);
        o.stop(start + dur + 0.03);
      };
      if (ok) {
        tone(880, now, 0.05, 0.06);          // лёгкий «тик» успеха
        tone(880, now + 0.11, 0.05, 0.06);
      } else {
        tone(180, now, 0.22, 0.07);          // тихий длинный гудок
        tone(90, now + 0.05, 0.2, 0.07);
      }
    } catch (_) { /* без звука нельзя допустить сбой всего сканирования */ }
  }
  // Кэш найденных голосов SpeechSynthesis (загружаются асинхронно).
  let _voicesLoaded = false;
  function pickRussianVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    // Приоритет: явный русский, затем любой с lang, начинающимся на ru.
    return voices.find((v) => v.lang && v.lang.toLowerCase() === "ru-ru")
      || voices.find((v) => v.lang && v.lang.toLowerCase().startsWith("ru"))
      || null;
  }
  function playScanFeedback(ok, spokenText) {
    try {
      // Кастомная фраза (например, «уже отгружено») перекрывает стандартные
      // «Хорошо»/«Плохо»: озвучиваем её, а бип/вибрация идут по флагу `ok`.
      const text = (spokenText && String(spokenText).trim()) || (ok ? "Хорошо" : "Плохо");
      let spoke = false;
      if ("speechSynthesis" in window) {
        // Голоса подгружаются не сразу — подписываемся на событие первый раз.
        if (!_voicesLoaded) {
          window.speechSynthesis.onvoiceschanged = () => { _voicesLoaded = true; };
          _voicesLoaded = (window.speechSynthesis.getVoices() || []).length > 0;
        }
        const voice = pickRussianVoice();
        // Говорим голосом, ТОЛЬКО если реально доступен хотя бы один голос (TTS
        // движок есть). На ТСД/WebView без речевого движка getVoices() пуст, и
        // speak() безмолвно НЕ выдаёт звук — если считать это «озвучиванием»
        // (spoke=true), бип как запасной канал не сыграет вовсе. Поэтому бип
        // зарезервирован под случай, когда голоса нет вообще: speak() никогда
        // не вызовется, звук гарантированно остаётся за последним каналом.
        if (voice || (window.speechSynthesis.getVoices() || []).length) {
          const u = new SpeechSynthesisUtterance(text);
          u.lang = "ru-RU";
          u.rate = 0.95;
          u.volume = 1;
          if (voice) u.voice = voice;
          // cancel предыдущей фразы, чтобы быстрые сканы не наслаивались.
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(u);
          spoke = true;
        }
      }
      // Нативный голос APK (AndroidBridge): когда веб-речи нет (getVoices() пуст
      // на ТСД/WebView без речевого движка), озвучиваем «Хорошо/Плохо» голосом
      // нативного TextToSpeech из APK — он работает на любом устройстве, где
      // установлена системная речь. Голос и здесь остаётся приоритетнее бипа.
      if (!spoke && window.AndroidBridge && typeof window.AndroidBridge.hasTts === "function") {
        try {
          if (window.AndroidBridge.hasTts() && typeof window.AndroidBridge.speak === "function") {
            window.AndroidBridge.speak(text);
            spoke = true;
          }
        } catch (_) { /* натив недоступен — уходим на бип */ }
      }
      // Бип — только как последний запасной канал (когда нет ни веб-речи, ни
      // нативного TTS в APK), чтобы ни один скан не остался без звука.
      if (!spoke) {
        scanBeep(ok);
      }
      // Вибрация: успех — короткий «тик», ошибка — тройная продолжительная.
      if ("vibrate" in navigator) {
        if (ok) {
          navigator.vibrate([60, 40, 60]);
        } else {
          navigator.vibrate([250, 80, 250, 80, 400]);
        }
      }
    } catch (_) { /* прямая обратная связь не должна ломать сканирование */ }
  }

  // Выполнение отметки через сервер: POST /api/labels/scan { code, action }.
  // Возвращает true при успешной отметке — вызывающий (qrScanCallback) по этому
  // значению решает, продолжать ли непрерывное сканирование.
  async function doScanLabel(action, code) {
    // Код мог прийти со сканера с русской раскладкой — приводим к латинице.
    const norm = normalizeLabelCode(String(code || "").trim());
      if (!norm) { setPrintScanStatus("Укажите код этикетки", "err"); return false; }
    // Оптимистичный отклик: если код — известная напечатанная этикетка (есть в
    // локальном списке scanLabels), сразу озвучиваем «Хорошо», не дожидаясь сети.
    // Если сервер потом отклонит скан (не найден/ошибка) — произносим «Плохо».
    const optimistic = Array.isArray(scanLabels) && scanLabels.some((l) => String(l.code) === String(norm));
    if (optimistic) playScanFeedback(true);
    try {
      const r = await api("/api/labels/scan", {
        method: "POST",
        body: JSON.stringify({ code: norm, action }),
      });
      if (!r) {
        if (optimistic) playScanFeedback(false);
        setPrintScanStatus("Нет ответа от сервера", "err");
        return false;
      }
      if (r.ok && r.label) {
        // Повторный скан уже обработанного места (оптимизм уже сыграл «Хорошо»
        // выше): сервер вернул warning — переигрываем на «Плохо» и озвучиваем
        // отказ. На погрузке грузчик на ТСД слышит «Уже отгружено»; на выгрузке
        // — соответствующий текст warning («Место уже выгружено» и т.п.).
        if (r.warning) {
          playScanFeedback(false, action === "load" ? "Уже отгружено" : r.warning);
        } else if (!optimistic) {
          playScanFeedback(true);
        }
        // Обновляем статус места в локальном списке сразу, чтобы живой счётчик
        // пересчитался мгновенно, не дожидаясь повторного GET /api/labels.
        const updated = r.label;
        const idx = scanLabels.findIndex((l) => String(l.code) === String(updated.code));
        if (idx >= 0) scanLabels[idx] = Object.assign({}, scanLabels[idx], updated);
        else scanLabels.push(updated);
        const s = STATUS_LABEL[r.label.status] || r.label.status;
        const warn = r.warning ? ` · ${r.warning}` : "";
        setPrintScanStatus(`Код ${r.label.code} → ${s}.${warn}`, r.warning ? "warn" : "ok");
        // Место может принадлежать любому клиенту открытой отгрузки — если
        // отсканировали этикетку ДРУГОГО клиента, автоматически переключаемся
        // на него (без ручного выбора плитки), чтобы отгрузка шла свободно.
        if (printRouteId && updated.clientIndex !== undefined && Number.isInteger(Number(updated.clientIndex))) {
          const lci = Number(updated.clientIndex);
          const route = shipmentsCache.find((x) => String(x.id) === String(printRouteId));
          const cl = route && Array.isArray(route.clients) ? route.clients[lci] : null;
          if (cl && lci !== currentPrintClientIndex()) {
            printClientIndex = lci;
            renderPrintClientsTiles();
          }
        }
        refreshPrintLabels();
        // Отмеченное место может принадлежать любому клиенту маршрута — обновляем
        // плитки всех клиентов, чтобы скан шёл в произвольной последовательности.
        refreshShipmentTileCounters();
        return true;
      } else if (r.error) {
        // Невалидный/не-отгрузочный стикер (кода нет среди этикеток → optimistic
        // false) или иная ошибка сервера: озвучиваем «Плохо» ВСЕГДА, а не только
        // когда оптимистичный «Хорошо» нужно перебить. Иначе чужой штрихкод
        // отклоняется молча (только текст «Этикетка не найдена» без звука).
        playScanFeedback(false);
        setPrintScanStatus(String(r.error), "err");
        return false;
      }
      return false;
    } catch (e) {
      // api() на HTTP-ошибку (например 404 «Этикетка не найдена» для не-отгрузочного
      // стикера) БРОСАЕТ исключение, а не возвращает {error:...}, поэтому сюда
      // приходит любой отказ сканирования. «Плохо» озвучиваем ВСЕГДА (а не только
      // когда оптимистичный «Хорошо» нужно перебить): иначе чужой штрихкод на ТСД
      // отклоняется молча — только текст ошибки без голоса.
      playScanFeedback(false);
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
      hideScanOverlay();
      return;
    }
    const action = payload.action === "unload" ? "unload" : "load";
    scanMode = action;
    const code = String(payload.code || "").trim();
    const ok = await doScanLabel(action, code);
    // Непрерывный скан на нативной камере: QrScanActivity сама остаётся открытой
    // и шлёт сюда каждый отсканированный код, поэтому камеру ЗДЕСЬ больше не
    // открываем и не показываем промежуточный оверлей. Веб лишь отмечает место на
    // сервере и обновляет счётчик. Камера закроется на нативе сама (все места
    // отсканированы) либо по системной кнопке «Назад».
    const prog = scanProgress(scanLabels, action);
    const modeLabel = action === "unload" ? "выгрузку" : "погрузку";
    const note = prog.remaining <= 0
      ? `Все места отсканированы (${modeLabel})`
      : `Осталось отсканировать: ${prog.remaining} · (${modeLabel})`;
    // Показываем компактный статус в окне печати (не оверлей поверх камеры).
    if (!ok) setPrintScanStatus(note, "warn");
    else setPrintScanStatus(note, prog.remaining <= 0 ? "ok" : "");
    // Все места отсканированы — закрываем камеру, чтобы нельзя было просканировать
    // бокс повторно или сверх нормы (счётчик на нативе иначе рос бы и дальше).
    if (prog.remaining <= 0) closeNativeScan();
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
    try {
      driverUnloadRouteId = routeId;
      driverUnloadClientIdx = Number(clientIdx) || 0;
      logApp("info", "startDriverUnloadScan route=" + String(routeId) + " idx=" + String(clientIdx));
      if (window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function") {
        if (typeof window.driverUnloadCallback !== "function") window.driverUnloadCallback = driverUnloadCallback;
        const cur = findDriverUnloadClient();
        const d = cur ? Number(cur.unloadDone) || 0 : 0;
        const n = cur ? Number(cur.unloadTotal) || 0 : 0;
        const cl = cur ? (cur.client || "—") : "—";
        // Точек совсем нет (need=0): нативная камера открывается и мгновенно
        // закрывается (счётчик 0 из 0), что со стороны выглядит как «кнопка
        // нажимается, но ничего не происходит». Не открываем камеру впустую —
        // явно сообщаем водителю и сразу открываем ручной ввод кода.
        if ((Number(n) || 0) === 0) {
          logApp("info", "Нет мест для выгрузки (need=0) — открываем ручной ввод");
          try { setDriverManualScan(routeId, driverUnloadClientIdx); } catch (e2) {
            logApp("error", "setDriverManualScan error: " + (e2 && e2.message ? e2.message : String(e2)));
          }
          try { toast("Мест для выгрузки нет (0). Если боксы есть — введите код вручную"); } catch (_) { /* ignore */ }
          return;
        }
        // Результат проверяем: если нативный скан НЕ открылся (мост есть, но scanQR
        // бросил исключение / камера не стартовала), не молчим — открываем ручную
        // модалку ввода кода, чтобы кнопка всегда давала результат водителю.
        const opened = invokeNativeScan("driverUnloadCallback", "unload", d, n, cl);
        logApp("info", "invokeNativeScan opened=" + String(opened) + " done=" + d + " need=" + n);
        if (opened) return;
        logApp("info", "native scan не открылся — открываем ручную модалку");
        openDriverScanModal();
        return;
      }
      // Fallback без камеры: ручной ввод кода этикетки. Используем НЕБЛОКИРУЮЩУЮ
      // модалку вместо нативного prompt(): синхронный prompt() в Android WebView
      // (без обработчика WebChromeClient) вешает UI — кнопки перестают нажиматься
      // до перезапуска приложения «на каждой точке».
      openDriverScanModal();
    } catch (err) {
      logApp("error", "startDriverUnloadScan error: " + (err && err.message ? err.message : String(err)));
      // Никогда не молчим: при любой ошибке показываем водителю модалку ручного
      // ввода, чтобы кнопка всегда давала результат (иначе «кликается, но ничего»).
      try { openDriverScanModal(); } catch (_) { /* даже это не вышло — тост ниже */ }
      try { toast("Не удалось открыть сканер: " + (err && err.message ? err.message : "ошибка")); } catch (_) { /* ignore */ }
    }
  }

  function openDriverScanModal() {
    if (!el.driverScanModal) { toast("Сканирование недоступно"); return; }
    if (el.driverScanInput) { el.driverScanInput.value = ""; }
    try { el.driverScanModal.showModal(); } catch { /* уже открыта */ }
    if (el.driverScanInput) {
      // Автофокус на поле ввода. В WebView клавиатура откроется только по
      // жесту; после показа модалки ставим фокус с небольшой задержкой.
      setTimeout(() => { try { el.driverScanInput.focus(); } catch { /* ignore */ } }, 120);
    }
  }

  function closeDriverScanModal() {
    if (el.driverScanModal && el.driverScanModal.open) {
      try { el.driverScanModal.close(); } catch { /* ignore */ }
    }
  }

  function submitDriverScan() {
    const code = el.driverScanInput ? String(el.driverScanInput.value || "").trim() : "";
    closeDriverScanModal();
    if (!code) { toast("Сканирование отменено"); return; }
    driverUnloadScanCode(code);
  }

  async function driverUnloadScanCode(code) {
    const clientTime = Date.now();
    const normCode = normalizeLabelCode(String(code || "").trim());
    try {
      const r = await api("/api/labels/scan", {
        method: "POST",
        body: JSON.stringify({ code: normCode, action: "unload", clientTime }),
      });
      if (r && r.ok && r.label) {
        const s = STATUS_LABEL[r.label.status] || r.label.status;
        toast(r.warning ? `${r.label.code} → ${s} · ${r.warning}` : `${r.label.code} → ${s}`);
        // Место засчитано (нет предупреждений) → «Хорошо»; не засчитано (already
        // выгружено / ещё не погружено) → «Плохо».
        playScanFeedback(!r.warning);
      } else {
        toast((r && r.error) || "Не удалось отметить место");
        playScanFeedback(false);
      }
    } catch (e) {
      // Нет связи ИЛИ шлюз/сервер временно не ответили (401 сессии при VPN,
      // 429, 5xx, таймаут, пробуждение): скан НЕ теряем — кладём в офлайн-очередь
      // и локально увеличиваем счётчик выгруженных мест, чтобы водитель видел
      // прогресс сразу. Отправка произойдёт автоматически при восстановлении
      // связи (flushOfflineOps). Раньше учитывался только чистый offline
      // (status 0), а 401/502 шлюза при «пропал интернет» уводили в ветку
      // «Ошибка сканирования» — бокс терялся.
      if (isOfflineError(e) || isTransientError(e)) {
        // Дедупликация: если этот самый код уже лежит в офлайн-очереди и ещё не
        // доставлен, повторно его не добавляем — иначе один бокс засчитается дважды.
        if (scanAlreadyQueued(normCode)) {
          toast("Этот бокс уже в очереди отправки");
          playScanFeedback(true);
          return;
        }
        enqueueOfflineOp({
          id: offlineOpId(),
          kind: "scan",
          routeId: driverUnloadRouteId || null,
          payload: { code: normCode, action: "unload" },
          clientTime,
        });
        toast("Нет связи — место сохранено и отправится автоматически");
        playScanFeedback(true);
        const cur = findDriverUnloadClient();
        if (cur) {
          cur.unloadDone = (Number(cur.unloadDone) || 0) + 1;
          // Сохраняем оптимистичный счётчик в localStorage: если водитель
          // закроет приложение до синхронизации очереди, прогресс выгрузки
          // переживёт перезапуск (см. persistMyRoutes для стадий маршрута).
          persistMyRoutes();
        }
        renderMyRoutesList(myRoutesCache);
        return;
      }
      toast((e && (e.error || e.message)) || "Ошибка сканирования");
      playScanFeedback(false);
    }
    // Обновляем маршруты (счётчик выгрузки считает сервер). Камеру здесь повторно
    // НЕ открываем: нативный QrScanActivity теперь непрерывный и сам шлёт каждый
    // код через колбэк (webSignal), оставаясь открытым до конца выгрузки, поэтому
    // invokeNativeScan на этом шаге лишь наслоил бы вторую камеру поверх.
    await loadMyRoutes();
    // Все места клиента выгружены — закрываем камеру, чтобы водитель не мог
    // пересканировать бокс и не получал «плохо» на уже выгруженных местах.
    const unloadDoneCl = findDriverUnloadClient();
    if (unloadDoneCl && (unloadDoneCl.unloadReady === true || (Number(unloadDoneCl.unloadTotal) > 0 && Number(unloadDoneCl.unloadDone) >= Number(unloadDoneCl.unloadTotal)))) {
      closeNativeScan();
    }
  }

  // Проверяет, есть ли в офлайн-очереди ещё не доставленный скан с таким кодом.
  function scanAlreadyQueued(code) {
    const ops = readOfflineOps();
    return ops.some((o) =>
      o &&
      o.kind === "scan" &&
      o.payload &&
      String(o.payload.code) === String(code)
    );
  }

  // Колбэк нативного сканера: AndroidBridge.scanQR вызывает window.driverUnloadCallback(payload).
  async function driverUnloadCallback(payload) {
    if (!payload) return;
    if (!payload.ok) {
      toast(payload.message || "Сканирование завершено без результата");
      playScanFeedback(false);
      return;
    }
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
        // Сразу после старта открываем окно печати этикеток, чтобы склад мог
        // собрать (напечатать) этикетки на всех клиентов маршрута.
        openPrintLabels(routeId);
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

  // Вернуть завершённую отгрузку обратно (маршрут снова встаёт в очередь сборки).
  // Эндпоинт доступен только распорядителям склада (админ/модератор группы склада).
  async function reopenShipment(routeId) {
    try {
      const r = await api("/api/shipments/reopen", {
        method: "POST",
        body: JSON.stringify({ routeId }),
      });
      if (r && r.ok) {
        toast("Маршрут возвращён к отгрузке");
        loadShipments();
      }
    } catch (e) {
      const msg = (e && (e.error || e.message)) || "Не удалось вернуть маршрут к отгрузке";
      toast(msg);
    }
  }

  // Форматирует миллисекунды как «ЧЧ:ММ:СС» (часы:минуты:секунды) — единый формат
  // для «Путь»/«На точке» в карточках точек, согласованный с живым счётчиком
  // активной точки (fmtHMS). Раньше было «ЧЧ:ММ» без секунд, из-за чего малые
  // интервалы вроде 2 минут выглядели как «0:02» и читались как секунды.
  function fmtDuration(ms) {
    if (!ms || isNaN(ms) || ms < 0) return "—";
    const totalSec = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
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

    // Общий счётчик мест по маршруту: сколько выгружено / сколько всего.
    // Считается по клиентам (unloadDone/unloadTotal приходят с сервера из этикеток).
    const routeTotalPlaces = clients.reduce((s, c) => s + (Number(c.unloadTotal) || 0), 0);
    const routeDonePlaces = clients.reduce((s, c) => s + (Number(c.unloadDone) || 0), 0);
    const routePlacesBadge = routeTotalPlaces > 0
      ? `<span class="rms-route-places${routeDonePlaces === routeTotalPlaces ? " ok" : ""}"
           title="Выгружено мест / всего">${routeDonePlaces}/${routeTotalPlaces}</span>`
      : "";

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
      // Счётчик мест «выгружено/всего» клиента (сервер считает из этикеток):
      // знаменатель — сколько мест отгрузил склад, числитель — сколько выгрузил
      // водитель. Показываем компактно «17/17» у каждого клиента маршрута.
      const unTotal = Number(c.unloadTotal) || 0;
      const unDone = Number(c.unloadDone) || 0;
      const unReady = (c.unloadReady === true) || (unTotal > 0 && unDone === unTotal);
      let unloadBadge = "";
      if (unTotal > 0) {
        unloadBadge = `<span class="rms-stop-flight${unReady ? " ok" : ""}" title="Выгружено мест: ${unDone} из ${unTotal}">${unDone}/${unTotal}</span>`;
      }

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
        const unCreated = Number(c.unloadCreated) || 0; // напечатаны, но не погружены складом
        const unReady = c.unloadReady === true;       // все места выгружены (или их нет)
        const unFinished = c.unloadFinished === true; // водитель нажал «Завершить выгрузку»
        // Разрешает ли админ завершить выгрузку при неполном сканировании.
        const allowIncomplete = !!state.params.allowFinishUnloadIncomplete;
        // Заблокировать «Завершить выгрузку», если остались невыгруженные места
        // и админ не включил режим «завершать при неполном скане».
        const canFinish = unReady || allowIncomplete;
        const finishDisabled = unFinished || !canFinish;
        // «Сканировать выгрузку» активна и подсвечена, ПОКА не всё выгружено.
        // Когда все места отсканированы (unReady) либо выгрузка уже завершена
        // (unFinished) — кнопка сканирования гаснет, активируется «Завершить выгрузку».
        // «Сканировать выгрузку» активна, пока выгрузка НЕ завершена водителем
        // (unFinished). Раньше кнопка гасла и от unReady, а unReady=true при
        // unloadTotal===0 (склад не погрузил боксы / механические боксы без
        // этикеток) — из-за этого водитель на телефоне не мог открыть сканер
        // («кнопка нажимается, ничего не происходит»). Теперь сканер доступен
        // всегда, пока водитель сам не нажал «Завершить выгрузку».
        const scanDisabled = unFinished;
        const scanHint = unReady
          ? "Все места уже выгружены — сканирование не требуется"
          : "";
        const finishHint = unFinished
          ? "Выгрузка мест отмечена как завершённая"
          : (!canFinish && unTotal > 0 ? `Осталось отсканировать мест: ${unTotal - unDone}` : "");
        let unloadCountHtml = "";
        if (unTotal > 0) {
          const cls = unReady ? " ok" : "";
          unloadCountHtml = `<span class="rms-unload-count${cls}">Выгружено ${unDone} из ${unTotal}${unReady ? " ✓" : ""}</span>`;
        }
        // Места, которые склад напечатал, но не погрузил (статус "created"). На
        // выгрузку они не влияют (счётчик «Выгружено N из M» их не учитывает), но
        // показываем их отдельной пометкой, чтобы было видно «недогруз склада».
        const createdNoteHtml = unCreated > 0
          ? `<div class="rms-unload-note">⚠ ${unCreated} место не погружено складом — выгрузка пройдёт без него</div>`
          : "";
        // Содержимое боксов этой точки для водителя: сгруппировано по коду бокса —
        // водитель видит, какие детали лежат в каждом боксе (из накладной сборки).
        const wbBoxesHtml = (() => {
          const wbi = r.waybills && r.waybills[i];
          const items = wbi && Array.isArray(wbi.items) ? wbi.items : [];
          const byBox = {};
          const order = [];
          items.forEach((it) => {
            if (!it.box || (Number(it.scanned) || 0) <= 0) return;
            if (!byBox[it.box]) { byBox[it.box] = []; order.push(it.box); }
            byBox[it.box].push(it);
          });
          if (!order.length) return "";
          // Боксы по порядку номеров (не по порядку строк накладной).
          order.sort((a, b) => {
            const na = parseInt(waybillBoxNumber(a), 10) || 0;
            const nb = parseInt(waybillBoxNumber(b), 10) || 0;
            return na !== nb ? na - nb : String(a).localeCompare(String(b));
          });
          // Водителю показываем только коды боксов, без собранных деталей внутри.
          return `<div class="rms-waybill-boxes">` + order.map((b) =>
            `<div class="rms-waybill-box"><span class="rms-waybill-box-code">${escapeHtml(waybillBoxName(b))}</span></div>`
          ).join("") + `</div>`;
        })();
        let unloadBlock = `<div class="rms-unload">
          ${wbBoxesHtml}
          ${unloadCountHtml}
          ${createdNoteHtml}
          <div class="rms-stop-actions">
            <button type="button" class="rms-stop-btn primary" data-route-action="scan_unload" data-route-id="${escapeHtml(r.id)}" data-client-idx="${i}" ${scanDisabled ? "disabled" : ""} title="${escapeHtml(scanHint)}">Сканировать выгрузку</button>
            <button type="button" class="rms-stop-btn ghost" data-route-action="finish_unload" data-route-id="${escapeHtml(r.id)}" ${finishDisabled ? "disabled" : ""} title="${escapeHtml(finishHint)}">${unFinished ? "Выгрузка завершена" : "Завершить выгрузку"}</button>
          </div>
        </div>`;
        btnHtml = `${unloadBlock}
          <div class="rms-stop-actions">
            <button type="button" class="rms-stop-btn primary" data-route-action="deliver" data-route-id="${escapeHtml(r.id)}" ${(!unFinished && !allowIncomplete) ? "disabled" : ""} title="${(!unFinished && !allowIncomplete) ? "Сначала завершите выгрузку или включите «завершать при неполном скане»" : ""}">Завершить сдачу</button>
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
      // Пометка связки: точка = несколько контрагентов на одном адресе.
      // Связка хранится одной остановкой (c.members) — «1 клиент» в маршруте,
      // но водителю показываем, что на адресе несколько контрагентов.
      const members = Array.isArray(c.members) && c.members.length > 0 ? c.members : null;
      const bundleBadge = members
        ? `<span class="rms-bundle-badge">связка · ${members.length} ${plural(members.length, "контрагент", "контрагента", "контрагентов")}</span>`
        : "";

      // Кнопки изменения порядка точки — видны водителю только когда админ включил
      // настройку «Водитель может менять порядок точек» и маршрут активен. Двигаются
      // только не пройденные точки (pending) и та, к которой водитель ещё едет
      // (in_transit). Сданные (delivered), перенесённые (postponed) и точка, где
      // водитель стоит (on_site), заморожены — стрелок у них нет.
      let reorderHtml = "";
      const reorderEnabled = !!state.params.allowDriverReorderPoints
        && p.status === "active"
        && (st === "pending" || st === "in_transit");
      if (reorderEnabled) {
        const cid = escapeHtml(c.id != null ? String(c.id) : `${r.id}-st${i + 1}`);
        reorderHtml = `
          <span class="rms-stop-reorder">
            <button type="button" class="rms-reorder-btn" data-route-reorder="up"
              data-route-id="${escapeHtml(String(r.id))}" data-client-id="${cid}"
              title="Переместить раньше" aria-label="Переместить раньше" ${i === 0 ? "disabled" : ""}>▲</button>
            <button type="button" class="rms-reorder-btn" data-route-reorder="down"
              data-route-id="${escapeHtml(String(r.id))}" data-client-id="${cid}"
              title="Переместить позже" aria-label="Переместить позже" ${i === clients.length - 1 ? "disabled" : ""}>▼</button>
          </span>`;
      }

      return `
        <div class="rms-stop${activeCls}">
          <div class="rms-stop-top">
            <span class="rms-stop-idx">${i + 1}</span>
            <span class="rms-stop-name">${escapeHtml(members ? (c.bundleName || c.address || c.client || "Связка") : c.client)}
              ${doneMark}
              ${st === "in_transit" ? '<span class="rms-stop-tag">едем</span>' : ""}
              ${st === "on_site" ? '<span class="rms-stop-tag">на месте</span>' : ""}
              ${st === "postponed" ? '<span class="rms-stop-tag postponed">перенос</span>' : ""}
            </span>
            ${members ? `<div class="rms-stop-members">${members.map((m) => escapeHtml(m.client)).join(", ")}</div>` : ""}
            ${unloadBadge}
            ${reorderHtml}
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

    // Кнопка «Прибыл на базу» — когда все точки ЗАКРЫТЫ (сданы ИЛИ перенесены),
    // а маршрут ещё активен. Сервер завершает маршрут по тем же закрытым
    // состояниям (delivered/postponed). Раньше здесь требовались ТОЛЬКО сданные
    // (delivered), из-за чего маршрут с перенесёнными точками не давал кнопку
    // «Прибыл на базу» и водитель не мог пометить его завершённым.
    let baseBtn = "";
    if (p.status === "active" && clients.length > 0 &&
        clients.every((c) => {
          const st = (c.state || "pending");
          return st === "delivered" || st === "postponed";
        })) {
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

    // Сворачивание карточки маршрута: активный маршрут (водитель начал и не
    // завершил) свернуть нельзя — кнопка заблокирована.
    const active = p.status === "active";
    // Состояние сворачивания: активный маршрут раскрыт всегда; остальные свёрнуты,
    // если пользователь вручную не раскрыл их (сохраняем между автообновлениями,
    // чтобы маршрут не «прятался» при перерисовке каждые несколько секунд).
    const myCollapsed = active ? false : !expandedMyRouteCards.has(String(r.id));
    const collapseBtn = active
      ? `<button type="button" class="route-collapse is-locked" disabled title="Активный маршрут нельзя свернуть">▾</button>`
      : `<button type="button" class="route-collapse" data-route-collapse title="Свернуть/развернуть">${myCollapsed ? "▸" : "▾"}</button>`;
    // Панель шагов водителя: показывает текущий этап маршрута (без изменения логики).
    let stepsStrip = "";
    if (p.status === "active" || p.status === "done") {
      const STEPS = ["В путь", "На точке", "Выгрузка", "Сдача", "Готово"];
      let stepIdx = 1; // активный маршрут — минимум «В путь»
      if (p.status === "done") stepIdx = 4;
      else {
        const scx = clients.find((c) => c.state === "in_transit" || c.state === "on_site");
        if (scx && scx.state === "on_site") stepIdx = scx.unloadFinished ? 3 : 2;
      }
      stepsStrip = `<div class="rms-steps">`
        + STEPS.map((s, idx) =>
          `<div class="rms-step${idx === stepIdx ? " active" : ""}${idx < stepIdx ? " done" : ""}">
             <span class="rms-step-dot"></span><span class="rms-step-lbl">${s}</span>
           </div>`).join("")
        + `</div>`;
    }
    return `
      <div class="admin-row driver-route-card${myCollapsed ? " route-collapsed" : ""} ${p.status === "done" ? " is-done" : ""}" data-route-id="${escapeHtml(String(r.id))}" data-myroute="">
        <div class="admin-row-main">
          <div class="driver-route-head">
            <span class="driver-route-date">${escapeHtml(dateStr)}</span>
            <span class="driver-route-driver">${escapeHtml(slot)} ${routePlacesBadge}</span>
            ${statusBadge}
            ${collapseBtn}
          </div>
          <div class="route-collapsible"${myCollapsed ? " hidden" : ""}>
            ${stepsStrip}
            ${startBtn}
            <div class="rms-stops">${stopsHtml}</div>
            ${baseBtn}
            ${lunchBtn}
          </div>
        </div>
      </div>
    `;
  }

  // Выполняет действие водителя по маршруту и перерисовывает список.
  async function routeAction(action, routeId) {
    const clientTime = Date.now(); // реальное время нажатия (для честного учёта при офлайн-отправке)
    try {
      const r = await api("/api/drivers/routes/action", {
        method: "POST",
        body: JSON.stringify({ routeId, action, clientTime }),
      });
      // Сервер вернул ок — обновляем локальный кэш и перерисовываем.
      if (r && r.ok && r.route) {
        const idx = myRoutesCache.findIndex((x) => String(x.id) === String(r.route.id));
        if (idx >= 0) myRoutesCache[idx] = r.route;
        else myRoutesCache.unshift(r.route);
        persistMyRoutes();
        renderMyRoutesList(myRoutesCache);
      }
    } catch (e) {
      // Нет связи либо шлюз/сервер временно не ответили (401 сессии при VPN,
      // 429, 5xx, таймаут): действие не теряем — кладём в локальную офлайн
      // -очередь, оптимистично переключаем точку и продолжим, когда связь
      // вернётся (flushOfflineOps повторит отправку).
      if (isOfflineError(e) || isTransientError(e)) {
        enqueueOfflineOp({
          id: offlineOpId(),
          kind: "route",
          routeId,
          action,
          payload: {},
          clientTime,
        });
        toast("Нет связи — действие сохранено и отправится автоматически");
        applyOptimisticRoute(routeId, action, {});
        renderMyRoutesList(myRoutesCache);
        return;
      }
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
    const clientTime = Date.now();
    try {
      const r = await api("/api/drivers/routes/action", {
        method: "POST",
        body: JSON.stringify({ routeId, action: "postpone", postponeReason: reason, clientTime }),
      });
      if (r && r.ok && r.route) {
        const idx = myRoutesCache.findIndex((x) => String(x.id) === String(r.route.id));
        if (idx >= 0) myRoutesCache[idx] = r.route;
        else myRoutesCache.unshift(r.route);
        persistMyRoutes();
        renderMyRoutesList(myRoutesCache);
      }
    } catch (e) {
      if (isOfflineError(e) || isTransientError(e)) {
        enqueueOfflineOp({
          id: offlineOpId(),
          kind: "route",
          routeId,
          action: "postpone",
          payload: { postponeReason: reason },
          clientTime,
        });
        toast("Нет связи — перенос сохранён и отправится автоматически");
        applyOptimisticRoute(routeId, "postpone", { postponeReason: reason });
        renderMyRoutesList(myRoutesCache);
        return;
      }
      const msg = (e && (e.error || e.message)) || "Не удалось выполнить перенос";
      toast(msg);
    }
  }

  // Меняет порядок точки в активном маршруте водителя по нажатию на ▲/▼.
  // Локально переставляет точку среди перемещаемых соседей (pending / in_transit)
  // и отправляет полный новый порядок всех id на сервер (action "reorder"),
  // который сам проверяет, что замороженные точки (on_site / delivered / postponed)
  // сохранили относительный порядок. На ошибке — откат к серверному состоянию.
  async function reorderRoutePoint(routeId, clientId, dir) {
    try {
      const routeIdx = myRoutesCache.findIndex((x) => String(x.id) === String(routeId));
      if (routeIdx < 0) return;
      const route = myRoutesCache[routeIdx];
      if (!route || !Array.isArray(route.clients)) return;
      const st = (c) => c.state || "pending";
      const movable = (c) => st(c) === "pending" || st(c) === "in_transit";
      const fromIdx = route.clients.findIndex((c) => String(c.id) === String(clientId));
      if (fromIdx < 0 || !movable(route.clients[fromIdx])) return;
      // Ближайшая перемещаемая точка в направлении стрелки.
      let swapIdx = -1;
      if (dir === "up") {
        for (let k = fromIdx - 1; k >= 0; k--) if (movable(route.clients[k])) { swapIdx = k; break; }
      } else {
        for (let k = fromIdx + 1; k < route.clients.length; k++) if (movable(route.clients[k])) { swapIdx = k; break; }
      }
      if (swapIdx < 0) return; // среди перемещаемых двигать некуда
      // Отправляем новый порядок ВСЕХ id — сервер валидирует замороженные.
      const arr = route.clients.slice();
      [arr[fromIdx], arr[swapIdx]] = [arr[swapIdx], arr[fromIdx]];
      const order = arr.map((c) => c.id);
      // Не перерисовываем окно до ответа сервера и не даём фоновому опросу
      // перезаписать список, пока reorder в полёте — иначе карточки «мигают»
      // (пересоздание DOM + CSS-переходы). Однократная мягкая перерисовка —
      // только после подтверждения сервера.
      suppressMyRoutesRepaint = true;
      const r = await api("/api/drivers/routes/action", {
        method: "POST",
        body: JSON.stringify({ routeId, action: "reorder", order }),
      });
      if (r && r.ok && r.route) {
        myRoutesCache[routeIdx] = r.route;
      } else {
        await loadMyRoutes(true); // обновить кэш, не рисуя — рисует finally
      }
    } catch (e) {
      const msg = (e && (e.error || e.message)) || "Не удалось изменить порядок точек";
      toast(msg);
      await loadMyRoutes(true); // вернуть серверный порядок в кэш (без лишней отрисовки)
    } finally {
      suppressMyRoutesRepaint = false;
      repaintMyRoutesQuietly();
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
  // Суммарный километраж построения маршрута (база → точки), который админ
  // видит в мостах между плитками и от базы. Обновляется по мере подгрузки км
  // мостов и передаётся на сервер при сохранении, чтобы карточка списка
  // показывала ровно то же число, что и построение маршрута.
  let routeBuildKm = null;
  // ---- Черновик «Маршрут на день»: автосохраняем набранное, чтобы оно не
  // «слетало» при перезагрузке/перерисовке, пока админ набивает маршрут. ----
  const ROUTE_DRAFT_KEY = "biotime.routeDraft";
  function saveRouteDraft() {
    try {
      const d = {
        date: (el.driverRouteDate && el.driverRouteDate.value) || "",
        driverId: (el.driverRouteDriver && el.driverRouteDriver.value) || "",
        name: (el.driverRouteName && el.driverRouteName.value) || "",
        selfPickup: !!(el.selfPickupChk && el.selfPickupChk.checked),
        order: routeOrderIds.slice(),
        // Загруженные расходные накладные (по ключу адреса) — чтобы они тоже
        // восстанавливались при возврате на вкладку, а не «всё пропадало».
        waybills: Array.from(routeWaybills.entries()).map(([k, v]) => [k, {
          buyer: v && v.buyer || "",
          items: (v && Array.isArray(v.items)) ? v.items.map((it) => ({ art: it.art, name: it.name, qty: it.qty })) : [],
        }]),
        at: Date.now(),
      };
      localStorage.setItem(ROUTE_DRAFT_KEY, JSON.stringify(d));
    } catch { /* приватный режим */ }
  }
  function clearRouteDraft() {
    try { localStorage.removeItem(ROUTE_DRAFT_KEY); } catch { /* ignore */ }
  }
  function restoreRouteDraft() {
    let d = null;
    try { const raw = localStorage.getItem(ROUTE_DRAFT_KEY); if (raw) d = JSON.parse(raw); } catch { /* ignore */ }
    if (!d) return;
    try {
      if (el.driverRouteDate && d.date) el.driverRouteDate.value = d.date;
      if (el.driverRouteDriver && d.driverId && !el.driverRouteDriver.value) el.driverRouteDriver.value = d.driverId;
      if (el.driverRouteName && !el.driverRouteName.value && d.name) el.driverRouteName.value = d.name;
      if (el.selfPickupChk && d.selfPickup) el.selfPickupChk.checked = true;
      if (Array.isArray(d.order) && d.order.length) {
        selectedRouteClientIds.clear();
        routeOrderIds = [];
        d.order.forEach((id) => {
          const sid = String(id);
          if (driverClientsCache.some((c) => String(c.id) === sid)) {
            selectedRouteClientIds.add(sid);
            routeOrderIds.push(sid);
          }
        });
        renderRouteClientOptions();
        renderRouteClientSelected();
      }
      // Восстанавливаем загруженные накладные.
      if (Array.isArray(d.waybills) && d.waybills.length) {
        routeWaybills.clear();
        d.waybills.forEach(([k, v]) => {
          if (!k) return;
          routeWaybills.set(String(k), {
            buyer: (v && v.buyer) || "",
            items: (v && Array.isArray(v.items)) ? v.items.map((it) => Object.assign({ art: it.art || "", name: it.name || "", qty: it.qty || 0 }, it)) : [],
          });
        });
        renderRouteWaybillsBlock();
      }
      if (el.selfPickupChk && typeof applySelfPickupUI === "function") { try { applySelfPickupUI(); } catch { /* ignore */ } }
      if (typeof updateRouteStepCount === "function") { try { updateRouteStepCount(); } catch { /* ignore */ } }
    } catch { /* ignore */ }
  }
  function syncOrderFromSet() {
    routeOrderIds = routeOrderIds.filter((id) => selectedRouteClientIds.has(String(id)));
    selectedRouteClientIds.forEach((id) => {
      if (!routeOrderIds.some((x) => String(x) === String(id))) routeOrderIds.push(id);
    });
  }
  // Пересчитывает суммарный км построения маршрута из заполненных мостов
  // (база → первая точка + отрезки между плитками). null, если мосты ещё не
  // подгрузились или данных мало.
  function updateRouteBuildKm() {
    const container = el.routeClientSelected;
    if (!container) { routeBuildKm = null; return; }
    let total = 0;
    let found = 0;
    container.querySelectorAll(".rms-bridge .rms-bridge-val").forEach((val) => {
      const num = Number(String(val.textContent || "").replace(/\s*км/, "").trim());
      if (Number.isFinite(num)) { total += num; found++; }
    });
    routeBuildKm = found > 0 ? Math.round(total * 10) / 10 : null;
  }
  // Ключ «связанности» клиента для группировки в одну плитку маршрута.
  // Связанными считаем клиентов одного адреса: все участники одной связки
  // (bundleId) делят общий bundleAddress, а прочие — совпадающий собственный
  // address. Адрес нормализуем (трим + lowercase), чтобы «Черепановых 8» и
  // «Черепановых 8 » не разъезжались. Если адреса нет — такой клиент не
  // группируется (собственная плитка).
  function clientGroupKey(c) {
    const addr = String((c && (c.bundleAddress || c.address)) || "").trim().toLowerCase();
    return addr ? "addr:" + addr : "id:" + String(c && c.id);
  }
  // Разбивает текущий routeOrderIds на блоки групп (подряд идущие клиенты
  // одного адреса — один блок). Нужно, чтобы перемещение ▲/▼ и drag&drop
  // двигали ВСЮ плитку (группу), а не одного клиента из неё.
  function flatRouteBlocks() {
    const byId = new Map(driverClientsCache.map((c) => [String(c.id), c]));
    const blocks = [];
    for (const x of routeOrderIds) {
      const c = byId.get(String(x));
      const key = c ? clientGroupKey(c) : ("id:" + String(x));
      const last = blocks[blocks.length - 1];
      if (last && last.key === key) last.ids.push(x);
      else blocks.push({ key, ids: [x] });
    }
    return blocks;
  }
  function addToRouteOrder(id) {
    if (!routeOrderIds.some((x) => String(x) === String(id))) routeOrderIds.push(id);
    saveRouteDraft();
  }
  function removeFromRouteOrder(id) {
    routeOrderIds = routeOrderIds.filter((x) => String(x) !== String(id));
    saveRouteDraft();
  }

  function fillDriverRouteClientChecks() {
    renderRouteClientOptions();
    renderRouteClientSelected();
    saveRouteDraft();
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
    // Группируем «связанные» точки — клиентов одного адреса (в т.ч. целиком
    // связку) — в ОДНУ плитку, чтобы на карте маршрута рядом не висело несколько
    // плиток одного адреса с мостами «0 км» между ними. Мосты строятся только
    // между разными адресами.
    const groups = [];
    for (const c of order) {
      const key = clientGroupKey(c);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.members.push(c);
      else groups.push({ key, members: [c] });
    }
    const parts = [];
    // Мост «от базы»: стрелка и километраж до первой точки — слева от первой
    // плитки (по аналогии с мостами между плитками). Показывается, когда адрес
    // базы задан в поле «База (адрес отправления)».
    const baseAddrText = (el.routeBaseAddress ? el.routeBaseAddress.value : "").trim();
    if (baseAddrText && groups.length > 0) {
      const firstClient = groups[0].members[0];
      parts.push(`
        <div class="rms-bridge rms-bridge-base" data-base-km>
          <span class="rms-bridge-arrow" aria-hidden="true">→</span>
          <div class="rms-bridge-km"><div class="rms-bridge-val">— км</div><div class="rms-bridge-to">от базы до ${escapeHtml(firstClient.client || "первой точки")}</div></div>
          <span class="rms-bridge-arrow" aria-hidden="true">→</span>
        </div>
      `);
    }
    groups.forEach((g, i) => {
      const first = g.members[0];
      const addr = first.bundleAddress || first.address || "";
      parts.push(`
        <div class="rms-tile" data-id="${escapeHtml(first.id)}" draggable="true">
          <div class="rms-tile-top">
            <span class="rms-tile-drag" title="Перетащить" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
            </span>
            <span class="rms-tile-idx">${i + 1}</span>
            <div class="rms-tile-order">
              <button type="button" class="rms-move-btn" data-action="up" data-id="${escapeHtml(first.id)}" title="Вперёд (раньше)" aria-label="Переместить раньше" ${i === 0 ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M18 15l-6-6-6 6"/></svg>
              </button>
              <button type="button" class="rms-move-btn" data-action="down" data-id="${escapeHtml(first.id)}" title="Назад (позже)" aria-label="Переместить позже" ${i === groups.length - 1 ? "disabled" : ""}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
              </button>
            </div>
          </div>
          <div class="rms-tile-clients">
            ${g.members.map((c, ci) => `
              <div class="rms-tile-client${ci > 0 ? " rms-tile-client-sub" : ""}">
                ${g.members.length > 1 ? `<span class="rms-tile-client-n">${ci + 1}</span>` : ""}
                <span class="rms-tile-name">${escapeHtml(c.client)}</span>
                <button type="button" class="rms-tile-del" data-id="${escapeHtml(c.id)}" aria-label="Убрать" title="Убрать из маршрута">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
              </div>
            `).join("")}
          </div>
          ${addr ? `<div class="rms-tile-addr">${escapeHtml(addr)}</div>` : ""}
          ${g.members.length > 1 ? `<div class="rms-tile-badge">${g.members.length} ${plural(g.members.length, "клиент на адресе", "клиента на адресе", "клиентов на адресе")}</div>` : ""}
        </div>
      `);
      if (i < groups.length - 1) {
        const next = groups[i + 1];
        parts.push(`
          <div class="rms-bridge" data-route-km-from="${escapeHtml(first.id)}" data-route-km-to="${escapeHtml(next.members[0].id)}">
            <span class="rms-bridge-arrow" aria-hidden="true">→</span>
            <div class="rms-bridge-km"><div class="rms-bridge-val">— км</div><div class="rms-bridge-to">до ${escapeHtml(next.members[0].client || "следующей точки")}</div></div>
            <span class="rms-bridge-arrow" aria-hidden="true">→</span>
          </div>
        `);
      }
    });
    el.routeClientSelected.innerHTML = parts.join("");
    el.routeClientSelected.querySelectorAll(".rms-tile-del").forEach((b) => {
      b.addEventListener("click", () => toggleRouteClient(b.dataset.id));
    });
    el.routeClientSelected.querySelectorAll(".rms-move-btn").forEach((b) => {
      b.addEventListener("click", () => moveRouteOrder(b.dataset.id, b.dataset.action));
    });
    bindRouteDragDrop();
    updateRouteStepCount();
    // Мосты строятся только между разными адресами (группами): передаём
    // представителя каждой группы, чтобы км считались между плитками.
    loadSelectedRouteKm(groups.map((g) => g.members[0]));
    // Мост «от базы» до первой точки (слева от первой плитки).
    loadBaseKm(groups);
    // Начали новое построение — суммарный км мостов ещё не подгрузился.
    routeBuildKm = null;
    renderRouteWaybillsBlock();
  }

  // Накладные, загруженные диспетчером, по ключу адреса точки (=== stopKeyOf).
  const routeWaybills = new Map(); // addrKeyLower -> items[]
  const stopKeyOf2 = (c) =>
    String((c && (c.bundleAddress || c.address)) || "").trim().toLowerCase();
  function routeWaybillState(addrKey) {
    if (!routeWaybills.has(addrKey)) return null;
    const e = routeWaybills.get(addrKey);
    const items = e && e.items;
    return { items, count: items ? items.length : 0, buyer: (e && e.buyer) || "" };
  }
  // Показывает блок загрузки накладных: по одной строке на выбранную точку.
  function renderRouteWaybillsBlock() {
    if (!el.routeWaybillsBlock || !el.routeWaybillsList) return;
    const on = !!state.params.allowWaybill;
    if (!on || routeOrderIds.length === 0) {
      el.routeWaybillsBlock.hidden = true;
      return;
    }
    // По накладной на КАЖДОГО выбранного клиента (в т.ч. на каждого клиента
    // связки на одном адресе). В сборке накладные клиентов одной точки сложатся.
    const stops = [];
    for (const id of routeOrderIds) {
      const c = driverClientsCache.find((x) => String(x.id) === String(id));
      if (!c) continue;
      // Накладную храним ПО КЛИЕНТУ (id), а не по адресу: у объединённых клиентов
      // на одном адресе каждая накладная идёт своему клиенту, иначе накладные
      // дублировались бы в каждую точку (позиций ×N на число клиентов адреса).
      stops.push({ key: String(c.id), label: (c.client || c.bundleName || c.bundleAddress || c.address || "Клиент") });
    }
    const rows = stops.map((s) => {
      const st = routeWaybillState(s.key);
      const delBtn = st
        ? `<button type="button" class="route-waybill-del" title="Удалить загруженную накладную"
             data-waybill-del-key="${escapeHtml(s.key)}">✕</button>`
        : "";
      return `<div class="route-waybill-row">
        <span class="route-waybill-label">${escapeHtml(s.label)}</span>
        <span class="route-waybill-state">${st ? `загружено: ${st.count} поз.` : "не загружено"}</span>
        ${delBtn}
        <label class="ctrl ctrl-soft route-waybill-upload"> ${st ? "Добавить .xlsx" : "Загрузить .xlsx"}
          <input type="file" accept=".xlsx" data-waybill-key="${escapeHtml(s.key)}" hidden />
        </label>
      </div>`;
    }).join("");
    el.routeWaybillsBlock.hidden = false;
    el.routeWaybillsList.innerHTML = rows;
    el.routeWaybillsList.querySelectorAll("input[type=file]").forEach((inp) => {
      inp.addEventListener("change", () => routeUploadWaybill(inp));
    });
    el.routeWaybillsList.querySelectorAll("[data-waybill-del-key]").forEach((b) => {
      b.addEventListener("click", () => {
        routeWaybills.delete(b.dataset.waybillDelKey);
        saveRouteDraft();
        toast("Накладная удалена");
        renderRouteWaybillsBlock();
      });
    });
  }
  async function routeUploadWaybill(inp) {
    const key = inp.dataset.waybillKey;
    const file = inp.files && inp.files[0];
    if (!file) return;
    const r2 = new FileReader();
    r2.onload = async () => {
      const b64 = String(r2.result).split(",")[1] || "";
      try {
        const r = await api("/api/waybill/parse", { method: "POST", body: JSON.stringify({ fileB64: b64 }) });
        const items = (r && r.items) || [];
        // Несколько накладных на одного клиента ДОПОЛНЯЮТ единый список сборки,
        // а не заменяют предыдущие (одинаковые артикулы остаются отдельными строками).
        const existing = routeWaybills.get(key);
        const prev = existing && Array.isArray(existing.items) ? existing.items : [];
        const combined = prev.concat(items);
        routeWaybills.set(key, { items: combined, buyer: (r && r.buyer) || (existing && existing.buyer) || "" });
        toast(items.length ? `Накладная добавлена: ${items.length} поз. · всего ${combined.length}` : "В накладной нет позиций");
      } catch (e) {
        routeWaybills.set(key, { items: [], buyer: "" });
        toast((e && e.message) || "Не удалось разобрать накладную");
      }
      renderRouteWaybillsBlock();
      saveRouteDraft();
    };
    r2.readAsDataURL(file);
  }

  // Асинхронно подгружает км между соседними выбранными клиентами (по дорогам
  // через сервер /api/drivers/route-km, фолбэк — по прямой). Заполняет мосты.
  async function loadSelectedRouteKm(order) {
    const container = el.routeClientSelected;
    if (!container || !Array.isArray(order) || order.length < 2) return;
    const geo = order.map((c) => ({
      lat: Number.isFinite(c.lat) ? c.lat : null,
      lon: Number.isFinite(c.lon) ? c.lon : null,
    }));
    const valid = geo.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (valid.length < 2) return; // нет координат — мосты остаются «— км»
    let segs = null;
    let method = "";
    try {
      const r = await api("/api/drivers/route-km", {
        method: "POST",
        body: JSON.stringify({ points: geo }),
      });
      if (r && r.ok && Array.isArray(r.segs)) segs = r.segs;
      if (r && typeof r.method === "string") method = r.method;
    } catch { segs = null; }
    if (!segs || segs.length === 0) return;
    // Мосты между плитками (без моста «от базы» — у него свой расчёт km).
    container.querySelectorAll(".rms-bridge:not(.rms-bridge-base)").forEach((br, i) => {
      const seg = segs[i];
      if (!seg || !Number.isFinite(Number(seg.km))) return;
      const val = br.querySelector(".rms-bridge-val");
      if (val) val.textContent = `${Number(seg.km)} км`;
      if (method) br.dataset.kmMethod = method;
    });
    updateRouteBuildKm();
  }

  // Асинхронно подгружает км «от базы» до первой точки маршрута (по дорогам
  // через сервер /api/drivers/base-km, фолбэк — по прямой). Заполняет мост,
  // нарисованный слева от первой плитки, когда адрес базы был задан.
  async function loadBaseKm(groups) {
    const container = el.routeClientSelected;
    if (!container || !groups || groups.length === 0) return;
    const bridge = container.querySelector(".rms-bridge-base");
    if (!bridge) return;
    const baseAddress = (el.routeBaseAddress ? el.routeBaseAddress.value : "").trim();
    if (!baseAddress) return;
    const first = groups[0].members[0];
    if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lon)) return; // км не посчитать — «— км»
    try {
      const r = await api("/api/drivers/base-km", {
        method: "POST",
        body: JSON.stringify({ baseAddress, firstLat: first.lat, firstLon: first.lon }),
      });
      if (!r || !Number.isFinite(Number(r.km))) return;
      const val = bridge.querySelector(".rms-bridge-val");
      if (val) val.textContent = `${Number(r.km)} км`;
      if (r.method) bridge.dataset.kmMethod = r.method;
      updateRouteBuildKm();
    } catch { /* оставляем «— км» */ }
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
    // Плитка — это группа «связанных» клиентов одного адреса: перемещаем её целиком.
    const blocks = flatRouteBlocks();
    const dragBi = blocks.findIndex((b) => b.ids.some((x) => String(x) === String(dragId)));
    const targetBi = blocks.findIndex((b) => b.ids.some((x) => String(x) === String(targetId)));
    if (dragBi < 0 || targetBi < 0 || dragBi === targetBi) return;
    const [dragBlock] = blocks.splice(dragBi, 1);
    // После удаления целевая позиция могла сдвинуться — ищем заново.
    const ti = blocks.findIndex((b) => b.ids.some((x) => String(x) === String(targetId)));
    blocks.splice(ti < 0 ? blocks.length : ti, 0, dragBlock);
    routeOrderIds = blocks.flatMap((b) => b.ids);
    renderRouteClientSelected();
  }

  function moveRouteOrder(id, action) {
    syncOrderFromSet();
    // Перемещаем плитку (группу связанных клиентов) целиком, сохраняя порядок
    // клиентов внутри неё.
    const blocks = flatRouteBlocks();
    const bi = blocks.findIndex((b) => b.ids.some((x) => String(x) === String(id)));
    if (bi < 0) return;
    const swapWith = action === "up" ? bi - 1 : bi + 1;
    if (swapWith < 0 || swapWith >= blocks.length) return;
    [blocks[bi], blocks[swapWith]] = [blocks[swapWith], blocks[bi]];
    routeOrderIds = blocks.flatMap((b) => b.ids);
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
            <div class="drv-client-address">${escapeHtml(c.address)}${c.inn ? `<span class="drv-client-inn">ИНН ${escapeHtml(c.inn)}</span>` : ""}</div>
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
    const inn = (el.driverClientInn ? el.driverClientInn.value : "").trim().replace(/\s+/g, "");
    const login = (el.driverClientLogin ? el.driverClientLogin.value : "").trim();
    if (!client || !address) {
      toast("Укажите и клиента, и адрес");
      return;
    }
    try {
      const r = await api("/api/drivers/clients", {
        method: "POST",
        body: JSON.stringify({ client, address, inn, login }),
      });
      if (r && Array.isArray(r.clients)) renderDriverClients(r.clients);
      if (el.driverClientName) el.driverClientName.value = "";
      if (el.driverClientAddress) el.driverClientAddress.value = "";
      if (el.driverClientInn) el.driverClientInn.value = "";
      if (el.driverClientLogin) el.driverClientLogin.value = "";
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
        <input class="text-input" id="editClientInn-${escapeHtml(id)}" value="${escapeHtml(c.inn || "")}" placeholder="ИНН" autocomplete="off" />
        <input class="text-input" id="editClientLogin-${escapeHtml(id)}" value="${escapeHtml(c.login || "")}" placeholder="Логин (буквенный)" autocomplete="off" />
        <div class="driver-edit-actions">
          <button type="button" class="drv-mini-btn drv-mini-primary" id="saveEdit-${escapeHtml(id)}">Сохранить</button>
          <button type="button" class="drv-mini-btn" id="cancelEdit-${escapeHtml(id)}">Отмена</button>
        </div>
      </div>
    `;
    document.getElementById(`saveEdit-${id}`).addEventListener("click", async () => {
      const client = document.getElementById(`editClientName-${id}`).value.trim();
      const address = document.getElementById(`editClientAddr-${id}`).value.trim();
      const inn = document.getElementById(`editClientInn-${id}`).value.trim().replace(/\s+/g, "");
      const login = document.getElementById(`editClientLogin-${id}`).value.trim();
      if (!client || !address) { toast("Укажите имя и адрес"); return; }
      try {
        const r = await api("/api/drivers/clients", {
          method: "POST",
          body: JSON.stringify({ action: "update", id, client, address, inn, login }),
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

  // Клиентская версия причины блокировки маршрута — для тултипа замка 🔒.
  // Дублирует серверную routeLockReason, чтобы подсказка была видна и до запроса.
  function routeLockReasonLabel(r) {
    const p = (r && r.progress) || {};
    if (p.status === "done") return "Маршрут завершён";
    if (p.status === "active") return "Маршрут ведётся водителем — редактировать нельзя";
    if (p.shipmentStartedAt) return "Маршрут в сборке/отгрузке на складе — редактировать нельзя";
    return "Маршрут занят (в работе или в сборке)";
  }

  function renderDriverRoutes(routes) {
    if (el.driverRoutesCount) {
      el.driverRoutesCount.textContent = routes.length
        ? `${routes.length} ${plural(routes.length, "маршрут", "маршрута", "маршрутов")}`
        : "0 маршрутов";
    }
    if (!el.driverRoutesList) return;
    // Кеш хранит ПОЛНЫЙ список маршрутов с сервера (до фильтра по дате), чтобы
    // при смене дня в фильтре можно было перерисовать маршруты любого дня, а не
    // только того, что был выбран при загрузке.
    driverRoutesCache = routes;
    // Применяем выбранную в поле фильтра дату: показываем только маршруты этого
    // дня. Пустое значение поля = показать все маршруты.
    const filterDate = (el.driverRoutesDateFilter && el.driverRoutesDateFilter.value.trim()) || "";
    if (filterDate) {
      routes = routes.filter((r) => String(r.date || "") === filterDate);
    }
    if (routes.length === 0) {
      el.driverRoutesList.innerHTML = `<div class="empty-hint">Маршрутов пока нет.</div>`;
      return;
    }
    const sorted = [...routes].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    el.driverRoutesList.innerHTML = sorted.map((r) => {
      const dateStr = r.date ? fmtDateReadable(r.date) : "—";
      const stops = (r.clients || []).length;
      const n = `${stops} ${plural(stops, "остановка", "остановки", "остановок")}`;
      const clientsHtml = (r.clients || []).map((c, i) => {
        // Связка = несколько контрагентов на одном адресе (c.members) —
        // это ОДНА остановка маршрута. Показываем адрес и перечень контрагентов.
        const members = Array.isArray(c.members) && c.members.length > 0 ? c.members : null;
        // Кнопка «Восстановить точку» (только для администратора): применяется,
        // когда действия водителя по точке потерялись (офлайн-очередь не
        // доехала до сервера) и точку нужно закрыть как выполненную, не трогая
        // соседние (например, «СмартПартс», который сейчас в работе).
        const restoreBtn = state.isAdmin
          ? `<button type="button" class="drv-ico-btn drv-stop-restore" data-route-id="${escapeHtml(r.id)}" data-client-index="${i}" title="Восстановить точку (закрыть как выполненную, места delivered)" aria-label="Восстановить точку">
<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/><path d="M12 7v5l3 2"/></svg>
</button>`
          : "";
        return `
          <li class="drv-stop">
            <span class="drv-stop-idx">${i + 1}</span>
            <span class="drv-stop-body">
              <span class="drv-stop-name">${escapeHtml(members ? (c.bundleName || c.address || c.client || "Связка") : c.client)}</span>
              ${c.address ? `<span class="drv-stop-addr">${escapeHtml(c.address)}</span>` : ""}
              ${members
                ? `<span class="drv-stop-members">${members.map((m) => escapeHtml(m.client)).join(", ")}</span>`
                : ""}
            </span>
            ${restoreBtn}
          </li>
        `;
      }).join("");
      // Активный маршрут (водитель начал и не завершил) свернуть нельзя.
      const routeActive = r.progress && r.progress.status === "active";
      // Маршрут нельзя редактировать/удалять, если он завершён, взят в сборку
      // (склад уже начинает отгрузку) или водитель взял его в работу.
      const routeDone = r.progress && r.progress.status === "done";
      const routeInShipment = r.progress && !!r.progress.shipmentStartedAt;
      const routeLocked = !!(routeActive || routeDone || routeInShipment);
      const collapseBtn = routeActive
        ? `<button type="button" class="drv-ico-btn route-collapse is-locked" disabled title="Активный маршрут нельзя свернуть">▾</button>`
        : `<button type="button" class="drv-ico-btn route-collapse" data-route-collapse title="Свернуть/развернуть">▸</button>`;
      // По умолчанию маршруты показываются свёрнутыми (активные — раскрытыми);
      // вручную раскрытые пользователем (expandedDriverRouteCards) остаются раскрытыми
      // и после автообновления раздела (иначе карточка «разворачивается и сворачивается»).
      const drvCollapsedNow = routeActive ? false : !expandedDriverRouteCards.has(String(r.id));
      const drvCollapsed = drvCollapsedNow ? " route-collapsed" : "";
      // Кнопки управления маршрутом.
      //  • Завершённый (done) — удаляется только по коду из «Параметры»:
      //    рисуем замок, по клику открывается ввод кода. Разблокировке done не
      //    подлежит (история доставки зафиксирована).
      //  • В работе у водителя (active) или в сборке/отгрузке у склада
      //    (shipmentStartedAt) — администратор может удалить маршрут в ЛЮБОЙ
      //    момент, но обязательно подтвердив кодом. Показываем кнопку удаления
      //    по коду, а для залипших состояний — ещё и «Разблокировать».
      //  • Обычные (idle) — редактирование и удаление без кода, как и раньше.
      const delLockedBtn = `<button type="button" class="drv-ico-btn drv-ico-danger driver-route-del-locked" data-id="${escapeHtml(r.id)}" title="Удалить занятый маршрут (ввести код)" aria-label="Удалить занятый маршрут">
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1.4"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
</button>`;
      const canUnlock = state.isAdmin || state.canManageShipment;
      const unlockBtn = `<button type="button" class="drv-ico-btn driver-route-unlock" data-id="${escapeHtml(r.id)}" title="Разблокировать маршрут (снять залипший статус)" aria-label="Разблокировать маршрут">
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="11" width="14" height="9" rx="1.4"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/><circle cx="12" cy="15" r="1.5"/></svg>
</button>`;
      let editDelBtns;
      if (routeDone) {
        editDelBtns = delLockedBtn;
      } else if (routeActive) {
        // Ведётся водителем прямо сейчас — состав зафиксирован: правка недоступна,
        // удаление только по коду, есть «Разблокировать» для залипших состояний.
        editDelBtns = delLockedBtn + `${canUnlock ? unlockBtn : ""}`;
      } else if (routeInShipment) {
        // Склад уже взял маршрут в сборку/отгрузку, но диспетчер отвечает за
        // состав остановок — ему разрешено РЕДАКТИРОВАТЬ маршрут. Удаление — по
        // коду (занятый), плюс «Разблокировать» на случай залипшего статуса.
        editDelBtns = `
          <button type="button" class="drv-ico-btn driver-route-edit" data-id="${escapeHtml(r.id)}" title="Редактировать точки" aria-label="Редактировать точки маршрута">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>
          </button>
          ${delLockedBtn}${canUnlock ? unlockBtn : ""}`;
      } else {
        // Обычный маршрут — редактирование и удаление без кода.
        editDelBtns = `<button type="button" class="drv-ico-btn driver-route-edit" data-id="${escapeHtml(r.id)}" title="Редактировать точки" aria-label="Редактировать точки маршрута">
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/><path d="M13.5 6.5l3 3"/></svg>
</button>
<button type="button" class="drv-ico-btn drv-ico-danger driver-route-del" data-id="${escapeHtml(r.id)}" title="Удалить маршрут" aria-label="Удалить маршрут">
<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
</button>`;
      }
      return `
        <div class="drv-route-card${drvCollapsed}" data-route-id="${escapeHtml(String(r.id))}">
          <div class="drv-route-card-head">
            <div class="drv-route-card-meta">
              <span class="drv-route-name" title="Название маршрута">${escapeHtml(r.routeName || "Маршрут")}</span>
              <span class="drv-route-date">${escapeHtml(dateStr)}</span>
              ${r.selfPickup ? "" : `<span class="drv-route-driver">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.6-3.4 3.3-5.5 7-5.5s6.4 2.1 7 5.5"/></svg>
                ${escapeHtml(r.driverName || "—")}
              </span>`}
              <span class="drv-stop-count">${n}</span>
              ${(!r.selfPickup && Number.isFinite(Number(r.km)))
                ? `<span class="drv-route-km" title="Протяжённость маршрута (база → точки → база)">${Number(r.km)} км</span>`
                : ""}
            </div>
            ${collapseBtn}
            ${editDelBtns}
          </div>
          <div class="route-collapsible"${drvCollapsedNow ? " hidden" : ""}>
            <ol class="drv-stops">${clientsHtml}</ol>
          </div>
        </div>
      `;
    }).join("");
    el.driverRoutesList.querySelectorAll(".driver-route-edit").forEach((btn) => {
      btn.addEventListener("click", () => editDriverRoute(btn.dataset.id));
    });
    el.driverRoutesList.querySelectorAll(".driver-route-del").forEach((btn) => {
      btn.addEventListener("click", () => deleteDriverRoute(btn.dataset.id));
    });
    el.driverRoutesList.querySelectorAll(".driver-route-del-locked").forEach((btn) => {
      btn.addEventListener("click", () => askRouteDeleteCode(btn.dataset.id));
    });
    el.driverRoutesList.querySelectorAll(".driver-route-unlock").forEach((btn) => {
      btn.addEventListener("click", () => unlockDriverRoute(btn.dataset.id));
    });
    // Восстановление точки (закрыть как выполненную) — только админ. Операция
    // влияет на боевые данные, поэтому с подтверждением.
    el.driverRoutesList.querySelectorAll(".drv-stop-restore").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const routeId = btn.dataset.routeId;
        const clientIndex = Number(btn.dataset.clientIndex);
        if (!routeId || !Number.isInteger(clientIndex)) { toast("Не удалось определить точку"); return; }
        const ok = confirm("Закрыть эту точку маршрута как выполненную (все места выгружены)? Соседние точки (например, активная «СмартПартс») не будут изменены.");
        if (!ok) return;
        // Восстановление времени на точке: водитель мог простоять на точке
        // (например, «Тодокар» — 16 секунд). Спрашиваем у админа и передаём в
        // эндпоинт, чтобы в отчёте «На точке» показалось нужное значение.
        let siteSeconds = 0;
        const rawSite = prompt("Сколько секунд водитель простоял на точке (время «На точке»)? Пусто или 0 — если время не восстанавливаем.", "");
        if (rawSite !== null && rawSite.trim() !== "") {
          const n = Number(String(rawSite).trim());
          siteSeconds = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
        }
        try {
          await api("/api/admin/restore-client-close", {
            method: "POST",
            body: JSON.stringify({ routeId, clientIndex, siteSeconds }),
          });
          toast("Точка закрыта, места отмечены выгруженными");
          try { await loadDriverRoutes(); } catch (_) { /* не критично */ }
        } catch (e) {
          toast((e && (e.error || e.message)) || "Не удалось восстановить точку");
        }
      });
    });
  }

  // «Разблокировать» залипший маршрут: снимает статус active (водитель не
  // завершил) и/или флаг сборки склада (shipmentStartedAt). С подтверждением —
  // операция влияет на боевые данные. Доступно админу или распорядителю склада
  // (сервер повторно проверяет права). Завершённый маршрут не трогаем.
  async function unlockDriverRoute(id) {
    const r = (driverRoutesCache || []).find((x) => String(x.id) === String(id));
    const reason = r ? routeLockReasonLabel(r) : "";
    const text = reason
      ? `${reason}. Разблокировка вернёт маршрут в режим настройки — состав и порядок точек снова можно будет менять. Продолжить?`
      : "Разблокировать маршрут? Это вернёт его в режим настройки.";
    const ok = window.confirm(text);
    if (!ok) return;
    try {
      const res = await api("/api/routes/unlock", { method: "POST", body: JSON.stringify({ routeId: id }) });
      if (res && res.ok) {
        toast("Маршрут разблокирован");
        loadDriverRoutes();
      } else if (res && res.error) {
        toast(res.error);
      }
    } catch (e) {
      toast((e && e.message) || "Не удалось разблокировать маршрут");
    }
  }

  async function saveDriverRoute() {
    let date = (el.driverRouteDate.value || "").trim();
    const driverId = el.driverRouteDriver ? el.driverRouteDriver.value : "";
    const driverName = driverId ? (staffById(driverId) ? staffById(driverId).name : driverId) : "";
    // Самовывоз: дату ставим сами (сегодня — если не указана), водитель не нужен,
    // обязателен только выбор хотя бы одного клиента.
    const selfPickup = !!(el.selfPickupChk && el.selfPickupChk.checked);
    if (selfPickup && !date) {
      date = dayKeyOf(Date.now());
      if (el.driverRouteDate) el.driverRouteDate.value = date;
    }
    // Название маршрута обязательное: берём ровно то, что диспетчер ввёл в поле
    // «Название маршрута». Поле при открытии страницы пустое, поэтому без явного
    // ввода сохранить маршрут нельзя — маршрут не должен получать случайное имя.
    let routeName = (el.driverRouteName ? el.driverRouteName.value.trim() : "");
    if (!routeName) {
      if (selfPickup) {
        // Самовывозу имя не нужно — подставляем автоматически.
        routeName = `Самовывоз ${date || dayKeyOf(Date.now())}`;
      } else {
        toast("Укажите название маршрута");
        if (el.driverRouteName) el.driverRouteName.focus();
        return;
      }
    }
    // Собираем остановки маршрута. Контрагентов связки (несколько на один
    // адрес — общий bundleAddress/address) схлопываем в ОДНУ остановку: в
    // маршруте связка считается одним клиентом (одна печать, одна выгрузка).
    // Остановка хранит список members — контрагентов этой связки.
    const chosen = [];
    syncOrderFromSet();
    const stopKeyOf = (c) =>
      String((c && (c.bundleAddress || c.address)) || "").trim().toLowerCase();
    const stopGroups = []; // { addr, items: [...] } в порядке объезда
    const stopByKey = new Map();
    for (const id of routeOrderIds) {
      const c = driverClientsCache.find((x) => String(x.id) === String(id));
      if (!c) continue;
      const key = stopKeyOf(c) || "id:" + String(c.id);
      let g = stopByKey.get(key);
      if (!g) {
        g = { addr: (c.bundleAddress || c.address || "").trim(), items: [] };
        stopByKey.set(key, g);
        stopGroups.push(g);
      }
      g.items.push(c);
    }
    for (const g of stopGroups) {
      const single = g.items.length === 1;
      const head = g.items[0];
      const allSameBundle = g.items.every(
        (x) => x.bundleId && x.bundleId === head.bundleId
      );
      const stop = {
        client: single ? head.client : (g.addr || head.client || "Связка"),
        address: g.addr || head.address || "",
        bundleName: head.bundleName || "",
        bundleId: single || allSameBundle ? (head.bundleId || null) : null,
        logo: head.logo || "",
        logoText: head.logoText || "",
      };
      if (!single) {
        stop.members = g.items.map((m) => ({
          client: m.client,
          address: m.bundleAddress || m.address || "",
          bundleName: m.bundleName || (head.bundleName || ""),
          bundleId: m.bundleId || null,
          logo: m.logo || "",
          logoText: m.logoText || "",
        }));
      }
      chosen.push(stop);
    }
    const needDate = selfPickup ? false : !date;
    const needDriver = selfPickup ? false : !driverId;
    if (needDate || needDriver || chosen.length === 0) {
      toast(selfPickup
        ? "Выберите хотя бы одного клиента"
        : "Укажите дату, водителя и выберите хотя бы одного клиента");
      return;
    }
    // Маршрут можно создать и без загруженной накладной (если накладные включены):
    // передаём лишь те, что уже загружены; остальные добавляют позже в «Отгрузке»
    // или подтянет из 1С при создании маршрута.
    const waybillOn2 = !!state.params.allowWaybill;
    const waybills = [];
    if (waybillOn2) {
      // Накладные собираем по КЛИЕНТАМ каждой остановки, а не по адресу: у
      // объединённых клиентов на одном адресе каждая накладная идёт только своему
      // клиенту, а в остановку попадают накладные лишь её клиентов. Иначе накладные
      // дублировались бы в каждую точку (позиций ×N = число клиентов адреса).
      const dedupeItems = (arr) => {
        // Объединяем одинаковые позиции (артикул + партстикер) СУММОЙ количества.
        // Раньше дубль просто отбрасывался по ключу art|partsticker|qty — если 1С
        // отдаёт артикул без партстикера (прочерк) несколькими строками по 1 шт
        // (итого 2), вторая строка терялась и в сборку попадало 1 вместо 2.
        const byKey = new Map();
        for (const it of arr) {
          const k = String((it && it.art) || "") + "|" + String((it && it.partsticker) || "");
          if (byKey.has(k)) {
            const e = byKey.get(k);
            e.qty = (Number(e.qty) || 0) + (Number(it.qty) || 0);
          } else {
            byKey.set(k, Object.assign({}, it));
          }
        }
        return [...byKey.values()];
      };
      for (let i = 0; i < stopGroups.length; i++) {
        const g = stopGroups[i];
        const items = [];
        for (const c of g.items) {
          const e = routeWaybills.get(String(c.id));
          if (e && Array.isArray(e.items) && e.items.length) items.push(...e.items);
        }
        if (items.length) waybills.push({ clientIndex: i, items: dedupeItems(items) });
      }
    }
    try {
      // Предупреждение о пересечении: клиент уже в другом маршруте этого же
      // водителя на ту же дату. Разрешаем сохранить, но предупреждаем.
      // Для проверки пересечений собираем имена ВСЕХ контрагентов маршрута,
      // включая участников связок (members) — адрес остановки сам по себе не
      // является именем контрагента.
      const allClientNames = [];
      chosen.forEach((s) => {
        if (Array.isArray(s.members) && s.members.length > 0) {
          s.members.forEach((m) => { if (m.client) allClientNames.push(m.client); });
        } else if (s.client) {
          allClientNames.push(s.client);
        }
      });
      // Проверку пересечений делаем только для маршрутов с водителем: при
      // самовывозе водителя нет, поэтому пересечений по водителю быть не может.
      if (!selfPickup) {
        const check = await api("/api/drivers/routes/check", {
          method: "POST",
          body: JSON.stringify({
            date,
            driverId,
            clientNames: allClientNames,
            excludeRouteId: editingRouteId || "",
          }),
        });
        const inter = (check && Array.isArray(check.intersections)) ? check.intersections : [];
        if (inter.length > 0) {
          const list = [...new Set(inter.map((i) => `Клиент «${i.clientName}» уже в маршруте «${i.routeName}»`))];
          const ok = await confirmRouteIntersection(list);
          if (!ok) return;
        }
      }
      const r = await api("/api/drivers/routes", {
        method: "POST",
        body: JSON.stringify(
          Object.assign(
            { routeName, selfPickup: !!(el.selfPickupChk && el.selfPickupChk.checked) },
            // Километраж построения маршрута (сумма мостов) — сохраняем, чтобы
            // карточка списка показывала то же число, что и построение.
            // Для самовывоза расстояние до точки не считаем и не сохраняем.
            ((!(el.selfPickupChk && el.selfPickupChk.checked) && Number.isFinite(Number(routeBuildKm))) ? { km: routeBuildKm } : {}),
            editingRouteId
              ? { action: "update", id: editingRouteId, date, driverId, driverName, clients: chosen, waybills }
              : { date, driverId, driverName, clients: chosen, waybills }
          )
        ),
      });
      if (r && Array.isArray(r.routes)) renderDriverRoutes(r.routes);
      editingRouteId = null;
      selectedRouteClientIds.clear();
      routeOrderIds = [];
      if (el.driverRouteName) el.driverRouteName.value = "";
      routeClientSearchValue = "";
      if (el.routeClientSearch) el.routeClientSearch.value = "";
      renderRouteClientOptions();
      renderRouteClientSelected();
      routeWaybills.clear();
      clearRouteDraft();
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

  // Контекст модала удаления завершённого маршрута: id выбранного маршрута.
  let routeDeleteCtx = null;
  // Админ нажал на замок завершённого маршрута — просим код удаления.
  function askRouteDeleteCode(id) {
    routeDeleteCtx = String(id);
    if (el.routeDeleteInput) el.routeDeleteInput.value = "";
    // Динамический текст модалки в зависимости от статуса маршрута: админ может
    // удалить занятый маршрут (в работе у водителя / в сборке у склада / уже
    // завершён), но обязан подтвердить кодом из «Параметры».
    const r = (driverRoutesCache || []).find((x) => String(x.id) === String(id));
    const p = (r && r.progress) || {};
    let titleTxt = "Удалить маршрут?";
    let noteTxt = "Это удалит маршрут, его историю доставки и этикетки мест. Чтобы подтвердить удаление, введите код из «Параметры»:";
    if (p.status === "done") {
      titleTxt = "Удалить завершённый маршрут?";
      noteTxt = "Маршрут уже завершён (водитель сдал все точки). Удаление сотрёт историю доставки и этикетки мест. Чтобы подтвердить удаление, введите код из «Параметры»:";
    } else if (p.status === "active") {
      titleTxt = "Удалить маршрут в работе?";
      noteTxt = "Водитель прямо сейчас ведёт этот маршрут. Удаление прервёт его и сотрёт историю доставки и этикетки мест. Чтобы подтвердить удаление, введите код из «Параметры»:";
    } else if (p.shipmentStartedAt) {
      titleTxt = "Удалить маршрут в сборке?";
      noteTxt = "Склад начал сборку/отгрузку этого маршрута. Удаление прервёт сборку и сотрёт историю доставки и этикетки мест. Чтобы подтвердить удаление, введите код из «Параметры»:";
    }
    const head = el.routeDeleteModal ? el.routeDeleteModal.querySelector(".modal-head h3") : null;
    const note = el.routeDeleteModal ? el.routeDeleteModal.querySelector(".modal-note") : null;
    if (head) head.textContent = titleTxt;
    if (note) note.textContent = noteTxt;
    if (el.routeDeleteModal) el.routeDeleteModal.showModal();
    if (el.routeDeleteInput) el.routeDeleteInput.focus();
  }

  async function deleteDriverRoute(id, code) {
    try {
      const payload = { action: "delete", id };
      if (code != null) payload.code = String(code).trim();
      const r = await api("/api/drivers/routes", {
        method: "POST",
        body: JSON.stringify(payload),
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
    if (el.driverRouteName) el.driverRouteName.value = r.routeName || "";
  if (el.selfPickupChk) el.selfPickupChk.checked = !!r.selfPickup;
  applySelfPickupUI();
    selectedRouteClientIds.clear();
    routeOrderIds = [];
    (r.clients || []).forEach((rc) => {
      // Маршрут хранит клиентов без id — сопоставляем по имени с текущими
      // контрагентами. Точка-связка несёт список members (контрагенты одной
      // остановки) — восстанавливаем выбор всех её контрагентов.
      const names = (Array.isArray(rc.members) && rc.members.length > 0)
        ? rc.members.map((m) => String(m.client || ""))
        : [String(rc.client || "")];
      names.forEach((nm) => {
        if (!nm) return;
        const match = driverClientsCache.find((c) => String(c.client) === nm);
        if (match) {
          selectedRouteClientIds.add(String(match.id));
          addToRouteOrder(String(match.id));
        }
      });
    });
    renderRouteClientOptions();
    renderRouteClientSelected();
    // Восстанавливаем загруженные накладные (позиции + контрагент) из сохранённого
    // маршрута: иначе после перезагрузки блок показывает «не загружено», а число
    // позиций и название контрагента «съезжают». Ключи считаем так же, как в
    // renderRouteWaybillsBlock — по выбранным объектам клиентов из кэша.
    routeWaybills.clear();
    (r.clients || []).forEach((rc, i) => {
      const wb = r.waybills && r.waybills[i];
      if (!wb || !Array.isArray(wb.items) || !wb.items.length) return;
      const cid = routeOrderIds[i];
      const c = driverClientsCache.find((x) => String(x.id) === String(cid));
      // Ключ — по id КЛИЕНТА (единообразно с сохранением/загрузкой). Раньше брали
      // адрес (stopKeyOf2) — при сохранении накладные не находились, сборка пуста.
      const key = c ? String(c.id) : "id:" + String(cid);
      routeWaybills.set(key, {
        items: wb.items.map((x) => Object.assign({}, x)),
        buyer: String((wb && wb.buyer) || ""),
      });
    });
    renderRouteWaybillsBlock();
    switchRouteSubtab("route");
    toast("Редактирование маршрута: меняйте точки и нажмите «Сохранить маршрут»");
  }
  // При самовывозе скрываем поле «Водитель» и сбрасываем его (водителя нет).
  function applySelfPickupUI() {
    const on = !!(el.selfPickupChk && el.selfPickupChk.checked);
    const dv = el.driverRouteDriver;
    const wrap = dv && dv.closest && dv.closest(".drv-route-driver-field");
    if (wrap) wrap.classList.toggle("is-selfpickup-hidden", on);
    if (dv) { if (on) dv.value = ""; dv.disabled = on; }
  }
  if (el.selfPickupChk) el.selfPickupChk.addEventListener("change", applySelfPickupUI);

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
      if (!el.pageMyRoutes.hidden && !suppressMyRoutesRepaint) loadMyRoutes();
    }, 5000);
  }
  function stopMyRoutesPolling() {
    if (myRoutesTimer) { clearInterval(myRoutesTimer); myRoutesTimer = null; }
  }

  // Автообновление раздела «Отгрузка»: новые отгрузки появляются, а завершённые
  // переносятся в «Завершённые» без перезагрузки страницы.
  let shipmentTimer = null;
  function startShipmentPolling() {
    if (shipmentTimer) return;
    shipmentTimer = setInterval(() => {
      if (!el.pageShipment.hidden) loadShipments();
    }, 5000);
  }
  function stopShipmentPolling() {
    if (shipmentTimer) { clearInterval(shipmentTimer); shipmentTimer = null; }
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
    else if (name === "scans") renderScansLog();
    else if (name === "settings") renderParams();
    else if (name === "multiplier") renderMultRules();
    else if (name === "admins") renderAdmins();
    else if (name === "access") renderAccess();
    else if (name === "backup") renderBackup();
  }
  function renderBackup() {
    if (el.backupAutoList) loadAutoBackups();
  }

  // Раздел «Доступ к разделам»: чекбоксы сотрудников для Проблем/Логов/Отчётов.
  function renderAccess() {
    if (el.notfoundUsersGroups) renderNotfoundUsersChecks(el.notfoundUsersGroups);
    if (el.logUsersGroups) renderLogUsersChecks(el.logUsersGroups);
    if (el.reportsUsersGroups) renderReportsUsersChecks(el.reportsUsersGroups);
    if (el.sverkiUsersGroups) renderSverkiUsersChecks(el.sverkiUsersGroups);
    if (el.procenkaUsersGroups) renderProcenkaUsersChecks(el.procenkaUsersGroups);
    if (el.parserUsersGroups) renderParserUsersChecks(el.parserUsersGroups);
  }

  let _adminUsersMap = null;
  async function loadAdminUsersMap() {
    if (_adminUsersMap) return _adminUsersMap;
    try {
      const r = await api("/api/admin/users");
      const m = new Map();
      ((r && (r.users || r.list)) || []).forEach((u) => m.set(String(u.id), u));
      _adminUsersMap = m;
    } catch (_e) {
      _adminUsersMap = new Map();
    }
    return _adminUsersMap;
  }
  async function renderStaff() {
    const meName = staffById(state.me.id) ? staffById(state.me.id).name : state.me.name;
    el.staffCountNote.textContent = `${state.staff.length} ${plural(state.staff.length, "сотрудник", "сотрудника", "сотрудников")} · вы — «${escapeHtml(meName)}»`;
    el.staffList.innerHTML = "";
    const aMap = await loadAdminUsersMap();
    // Разбивка по существующим группам: каждый сотрудник попадает в свою группу,
    // без группы — в «Без группы». Одна строка на сотрудника, без дублей.
    const byGroup = new Map();
    const ungrouped = [];
    (state.staff || []).forEach((s) => {
      const gr = (state.groups || []).find((g) => (g.memberIds || []).includes(s.id));
      if (gr) {
        const name = gr.name || "Группа";
        if (!byGroup.has(name)) byGroup.set(name, []);
        byGroup.get(name).push(s);
      } else {
        ungrouped.push(s);
      }
    });
    const renderRow = (s) => {
      const row = document.createElement("div");
      row.className = "admin-row";
      const isMe = s.id === state.me.id;
      const isAdminUser = state.admins.includes(s.id) || (s.id === state.me.id && state.isAdmin);
      const ownerCanToggle = !isMe; // владельца нельзя снять с роли
      const acct = aMap.get(String(s.id));
      const letter = (s.name || "?").trim().charAt(0).toUpperCase();
      row.innerHTML = `
        <div class="avatar">${letter}</div>
        <div class="admin-row-main">
          <div class="admin-row-name">${escapeHtml(s.name)}${isMe ? ' <span class="badge">вы</span>' : ""}</div>
          <div class="admin-row-sub"></div>
        </div>
        <div class="row-action">
          ${isAdminUser ? '<span class="badge">админ</span>' : ""}
          ${ownerCanToggle
            ? `<button class="mini-btn ${isAdminUser ? "on" : ""}" data-admin="${s.id}" data-on="${isAdminUser}">${isAdminUser ? "Снять админа" : "Сделать админом"}</button>`
            : '<span class="disabled-note">это вы</span>'}
          ${!isMe ? `<button class="mini-btn on" data-id="${s.id}">Удалить</button>` : ""}
        </div>
        ${state.isAdmin ? `
        <div class="row-acct">
          <input class="text-input acct-login" data-login-for="${s.id}" value="${acct && acct.login ? escapeHtml(acct.login) : ""}" placeholder="логин" autocomplete="off" />
          <input class="text-input acct-pass" data-pass-for="${s.id}" type="password" placeholder="пароль" autocomplete="new-password" />
          <button class="mini-btn" data-masq="${s.id}" title="Войти под этим пользователем">Войти</button>
        </div>` : ""}
      `;
      return row;
    };
    // Сначала блоки с группами, затем «Без группы».
    for (const [title, items] of byGroup) {
      const t = document.createElement("div");
      t.className = "block-title";
      t.textContent = title;
      el.staffList.appendChild(t);
      items.forEach((s) => el.staffList.appendChild(renderRow(s)));
    }
    if (ungrouped.length) {
      const t = document.createElement("div");
      t.className = "block-title";
      t.textContent = "Без группы";
      el.staffList.appendChild(t);
      ungrouped.forEach((s) => el.staffList.appendChild(renderRow(s)));
    }
    // Назначение/снятие роли администратора (без дублей в db.admins).
    el.staffList.querySelectorAll("[data-admin]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const on = btn.dataset.on === "true";
        try {
          await api("/api/admins", { method: "POST", body: JSON.stringify({ id, on: !on }) });
          if (on) state.admins = state.admins.filter((a) => a !== id);
          else state.admins = state.admins.concat(id);
          renderStaff();
          toast(on ? "Роль администратора снята" : "Назначен администратором");
        } catch (e) {
          toast(e.message);
        }
      });
    });
    el.staffList.querySelectorAll(".mini-btn[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => removeStaff(btn.dataset.id));
    });
    // Учётные записи: автосохранение логина/пароля при вводе (без кнопки «Сохранить»).
    const debounceCreds = {};
    el.staffList.querySelectorAll("input[data-login-for], input[data-pass-for]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const id = inp.getAttribute("data-login-for") || inp.getAttribute("data-pass-for");
        if (!id) return;
        clearTimeout(debounceCreds[id]);
        debounceCreds[id] = setTimeout(async () => {
          const loginInp = el.staffList.querySelector(`[data-login-for="${id}"]`);
          const passInp = el.staffList.querySelector(`[data-pass-for="${id}"]`);
          const login = loginInp ? String(loginInp.value).trim() : "";
          const pass = passInp ? String(passInp.value) : "";
          try {
            await apiAuth("POST", "/api/admin/users/credentials", { userId: id, login, password: pass });
            _adminUsersMap = null;
            toast("Учётная запись сохранена");
          } catch (e) {
            toast((e && e.message) || "Не удалось сохранить учётную запись");
          }
        }, 600);
      });
    });
    // Вход под пользователем (имперсонация) — только админ.
    el.staffList.querySelectorAll("[data-masq]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await apiAuth("POST", "/api/auth/masquerade", { userId: btn.dataset.masq });
          // Имперсонация: сбрасываем личный кэш прежнего пользователя, чтобы
          // в новом сеансе таймер/день соответствовали тому, под кем вошли,
          // а не времени администратора.
          try { localStorage.clear(); } catch (_e) {}
          try { sessionStorage.clear(); } catch (_e) {}
          toast("Вошли под пользователем");
          location.reload();
        } catch (e) {
          toast((e && e.message) || "Не удалось войти под пользователем");
        }
      });
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
    // Группируем дни по месяцам: {"YYYY-MM": [dayKeys...]} (порядок — как в dayKeys,
    // т.е. месяцы от новых к старым).
    const monthsRu = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
    const byMonth = new Map();
    dayKeys.forEach((key) => {
      const m = key.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(key);
    });
    const curYM = todayKey.slice(0, 7);
    byMonth.forEach((keys, m) => {
      const mf = document.createElement("div");
      const monthKey = "month:" + m;
      // Текущий месяц по умолчанию раскрыт, прошлые свёрнуты. Ручное сворачивание
      // месяца сохраняем в state.collapsed (как у дней), чтобы автообновление
      // списка не «разворачивало» месяц обратно — иначе его невозможно свернуть.
      const openMonth = state.collapsed.has(monthKey) ? false : m === curYM;
      mf.className = "month-folder" + (openMonth ? " open" : "");
      const mHead = document.createElement("div");
      mHead.className = "month-folder-head";
      const mo = Number(m.slice(5, 7)) - 1;
      const label = (monthsRu[mo] || "") + " " + Number(m.slice(0, 4));
      mHead.innerHTML = `
        <span class="folder-caret"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg></span>
        <span class="month-label">${label}</span>
        <span class="month-count">${keys.length} дн.</span>`;
      const mBody = document.createElement("div");
      mBody.className = "month-folder-body";
      keys.forEach((key) => {
        const isToday = key === today;
        const colKey = "day:" + key;
        const openedKey = colKey + "+"; // явно раскрытая папка (кроме «сегодня» по умолчанию)
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
        head.addEventListener("click", () => {
          state.collapsed.delete(colKey);
          state.collapsed.delete(openedKey);
          const nowOpen = !folder.classList.contains("open");
          state.collapsed.add(nowOpen ? openedKey : colKey);
          saveCollapsed(state.collapsed);
          folder.classList.toggle("open", nowOpen);
          if (nowOpen && list.childElementCount === 0) {
            buildTodayRows(list, key, canEdit);
          }
        });
        if (open) buildTodayRows(list, key, canEdit);
        mBody.appendChild(folder);
      });
      mHead.addEventListener("click", () => {
        const willOpen = !mf.classList.contains("open");
        mf.classList.toggle("open", willOpen);
        if (willOpen) state.collapsed.delete(monthKey);
        else state.collapsed.add(monthKey);
        saveCollapsed(state.collapsed);
      });
      mf.appendChild(mHead);
      mf.appendChild(mBody);
      frag.appendChild(mf);
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
            <button type="button" class="sd-clear" title="Удалить этот день" aria-label="Удалить этот день">✕</button>
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
      // Крестик: полностью очищает день сотрудника (начало и конец) и удаляет
      // запись с сервера (saveTodayRow при пустых полях удаляет сегмент).
      const clearBtn = row.querySelector(".sd-clear");
      if (clearBtn && canEdit) {
        clearBtn.addEventListener("click", () => {
          startInput.value = "";
          endInput.value = "";
          if (todayDraft[key]) { delete todayDraft[key][s.id]; persistDraft(); }
          saveTodayRow(s.id, key);
        });
      }
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
      // Состояние сворачивания группы персистим (как и дни), иначе автоопрос
      // каждые ~8с пересоздаёт DOM, и развёрнутая пользователем группа снова
      // схлопывается — «вкладка сама сворачивается». По умолчанию свёрнута, но
      // после клика по заголовку выбор запоминается и переживает перерисовку.
      const colKey = "todayGrp:" + key + ":" + gid;
      const openedKey = colKey + "+";
      // Развёрнута, если пользователь явно отметил `+`-ключ; иначе свёрнута.
      const isOpen = state.collapsed.has(openedKey);
      group.className = "today-group" + (isOpen ? "" : " collapsed");
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
        const nowOpen = group.classList.toggle("collapsed") === false;
        // Запоминаем выбор: '+'-ключ = развёрнута, обычный = свёрнута.
        state.collapsed.delete(colKey);
        state.collapsed.delete(openedKey);
        state.collapsed.add(nowOpen ? openedKey : colKey);
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
    // Читаем значения ИЗ ЧЕРНОВИКА (todayDraft), который записывается при каждом
    // нажатии клавиши и переживает перерисовку (buildTodayRows отображает из него).
    // Раньше читали из DOM-элементов: автоопрос каждые ~8с пересоздаёт строки, и к
    // моменту debounce-сохранения поле «конец» могло оказаться ПУСТЫМ (т.к. на
    // сервере сегмент открыт, end:null) → в PUT уходило end:null → сегмент оставался
    // открытым и автозакрывался в неверный момент («не даёт изменить время вручную»).
    const draft = todayDraft[key] && todayDraft[key][id];
    const startVal = (draft && draft.start !== undefined) ? draft.start : card.querySelector(".today-start").value;
    const endVal = (draft && draft.end !== undefined) ? draft.end : card.querySelector(".today-end").value;
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

  function openAddStaffModal() {
    if (!el.addStaffModal) return;
    const sel = el.asGroup;
    if (sel) {
      sel.innerHTML = '<option value="">Без группы</option>'
        + (state.groups || []).map((g) => `<option value="${escapeHtml(g.id)}">${escapeHtml(g.name)}</option>`).join("");
    }
    if (el.asName) el.asName.value = "";
    if (el.asLogin) el.asLogin.value = "";
    if (el.asPass) el.asPass.value = "";
    if (el.asGroup) el.asGroup.value = "";
    if (el.addStaffModal.showModal) el.addStaffModal.showModal();
  }
  function closeAddStaffModal() {
    if (el.addStaffModal && el.addStaffModal.close) el.addStaffModal.close();
  }
  async function addStaff() {
    const name = String((el.asName && el.asName.value || "")).trim();
    if (!name) { toast("Введите ФИО сотрудника"); return; }
    const groupId = String((el.asGroup && el.asGroup.value) || "");
    const login = String((el.asLogin && el.asLogin.value) || "").trim();
    const pass = String((el.asPass && el.asPass.value) || "");
    try {
      const r = await api("/api/staff", { method: "POST", body: JSON.stringify({ name }) });
      state.staff = r.staff;
      const created = (r.staff || []).find((s) => s.name === name);
      // Привязка к группе (если выбрана).
      if (groupId && created) {
        const g = (state.groups || []).find((x) => String(x.id) === String(groupId));
        if (g) {
          const memberIds = Array.from(new Set([...(g.memberIds || []), created.id]));
          await api("/api/groups/" + encodeURIComponent(g.id), {
            method: "PUT",
            body: JSON.stringify({ moderatorId: g.moderatorId || null, memberIds }),
          });
        }
      }
      // Учётная запись (логин/пароль).
      if (created && login) {
        await apiAuth("POST", "/api/admin/users/credentials", { userId: created.id, login, password: pass });
      }
      closeAddStaffModal();
      await loadState();
      render();
      renderAdminSub("staff");
      toast("Сотрудник добавлен");
    } catch (e) {
      toast((e && e.message) || "Не удалось добавить сотрудника");
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
    // Месяц, за который показываем/правим оклад, премию, надбавку. По умолчанию —
    // текущий; значения за конкретный месяц берутся из state.salaryMonth (не из
    // «текущего» st.*), поэтому правка одного месяца не трогает другие.
    let salaryMonthKey = el.salMonth ? String(el.salMonth.value || "") : "";
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(salaryMonthKey)) salaryMonthKey = currentMonthKey();
    const yp = Number(salaryMonthKey.slice(0, 4));
    const mp = Number(salaryMonthKey.slice(5, 7)) - 1;
    const bizDays = businessDaysInMonth(yp, mp);
    const normDay = state.norm;
    const monthLabel = new Date(yp, mp, 1)
      .toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
    let html;
    if (state.staff.length === 0) {
      html = `<tr><td colspan="6" class="num" style="color:var(--ink-faint)">Добавьте сотрудников</td></tr>`;
    } else {
      html = state.staff.map((s) => {
        const pay = staffPayForMonth(s, salaryMonthKey);
        const salary = pay.salary != null ? pay.salary : 50000;
        const bonus = pay.bonus != null ? pay.bonus : 0;
        const extraBonus = pay.extraBonus != null ? pay.extraBonus : 0;
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
          await api("/api/staff/salary", { method: "POST", body: JSON.stringify({ id, salary: st.salary, month: salaryMonthKey }) });
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
          await api("/api/staff/bonus", { method: "POST", body: JSON.stringify({ id, bonus: st.bonus, month: salaryMonthKey }) });
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
          await api("/api/staff/extra-bonus", { method: "POST", body: JSON.stringify({ id, extraBonus: st.extraBonus, month: salaryMonthKey }) });
          toast(`Надбавка обновлена: ${st.name} — ${fmtMoney(st.extraBonus)}`);
        } catch (e) {
          toast(e.message);
        }
      });
    });
    if (el.salMonth) {
      // После рендера перерисовываем табель/ЗП, чтобы он совпал с выбранным месяцем.
      el.salMonth.dataset.lastYear = String(yp);
      el.salMonth.dataset.lastMonth = String(mp);
    }
  }
  if (el.salMonth) {
    el.salMonth.value = el.salMonth.value || currentMonthKey();
    el.salMonth.addEventListener("change", () => {
      renderSalaries();
      if (el.reportMonth && el.salMonth.value) {
        try { el.reportMonth.value = el.salMonth.value; } catch { /* ignore */ }
        state.reportMonthKey = el.salMonth.value;
        renderReport();
      }
    });
  }

  // ---- Логи сканов деталей при сборке (вкладка «Логи», только админ) ----
  // Раскрытые клиенты в журнале сканов («Логи»): состояние живёт между
  // перерисовками (фильтр/обновление), чтобы раскрытая вкладка клиента сама
  // не закрывалась.
  let scansOpen = new Set();
  async function renderScansLog() {
    const list = el.scansLogList;
    if (!list) return;
    const onlyFailed = !!(el.scansOnlyFailed && el.scansOnlyFailed.checked);
    // Фильтр «календарь по дням»: пустая дата = показать ВСЕ дни (не теряем список
    // и не выглядит так, будто логи «пропали»), выбранная дата = только этот день.
    const day = (el.scansDate && el.scansDate.value) || "";
    const dayOk = /^\d{4}-\d{2}-\d{2}$/.test(day);
    try {
      const parts = [];
      if (dayOk) {
        parts.push("from=" + encodeURIComponent(day + "T00:00:00"), "to=" + encodeURIComponent(day + "T23:59:59.999"));
      }
      if (onlyFailed) parts.push("ok=false");
      const q = parts.length ? "?" + parts.join("&") : "";
      const r = await api("/api/logs/barcode" + q);
      const rows = (r && r.rows) || [];
      if (!rows.length) {
        renderScansSummary(0, 0, 0);
        list.innerHTML = `<tr><td colspan="9" class="num" style="color:var(--ink-faint)">${
          onlyFailed ? "Неуспешных сканов нет" : "Сканов нет"
        }</td></tr>`;
        return;
      }
      renderScansSummary(rows.length, rows.filter((x) => x.ok === true).length, rows.filter((x) => x.ok !== true).length);
      // Группируем строки по клиентам в раскрываемые вкладки (Клиент → его сканы).
      const groups = new Map();
      for (const x of rows) {
        const c = String(x.client || "Без клиента");
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push(x);
      }
      const frag = [];
      for (const [client, items] of groups) {
        const open = scansOpen.has(client);
        frag.push(`<div class="scans-client" data-scans-client="${escapeHtml(client)}">
          <div class="scans-client-head" title="Нажмите, чтобы раскрыть/свернуть сканы клиента">
            <span class="scans-arrow">${open ? "▾" : "▸"}</span>
            <span class="scans-client-name">${escapeHtml(client)}</span>
            <span class="scans-client-count">(${items.length})</span>
          </div>
          <div class="scans-client-body"${open ? "" : " hidden"}>
            <table>
              <thead><tr>
                <th>ВРЕМЯ</th><th>СОТРУДНИК</th><th>ПАРТСТИКЕР</th><th>КОД</th><th>БОКС</th>
                <th>АРТИКУЛ В НАКЛАДНОЙ</th><th>СТАТУС</th><th>ПРИЧИНА</th>
              </tr></thead>
              <tbody>${items.map((x) => {
                const ok = x.ok === true;
                return `<tr class="${ok ? "scan-ok" : "scan-fail"}">
                  <td>${escapeHtml(x.ts ? fmtDateTimeSec(x.ts) : "")}</td>
                  <td>${escapeHtml(x.userName || "—")}</td>
                  <td>${x.partsticker ? escapeHtml(shortPs(x.partsticker)) : "—"}</td>
                  <td><span class="scan-code">${escapeHtml(x.art || x.code || "—")}</span></td>
                  <td>${escapeHtml(x.box ? waybillBoxName(x.box) : "—")}</td>
                  <td>${x.ok === true ? "Да" : "Нет"}</td>
                  <td>${ok ? "успешно" : "неуспешно"}</td>
                  <td>${escapeHtml(x.reason || "")}</td>
                </tr>`;
              }).join("")}</tbody>
            </table>
          </div>
        </div>`);
      }
      list.innerHTML = frag.join("");
      // Клик по заголовку клиента раскрывает/сворачивает его сканы; состояние
      // сохраняем, чтобы раскрытая вкладка не закрывалась при повторных рендерах.
      list.querySelectorAll("[data-scans-client]").forEach((block) => {
        const head = block.querySelector(".scans-client-head");
        if (!head) return;
        head.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const client = block.getAttribute("data-scans-client") || "";
          const body = block.querySelector(".scans-client-body");
          const arrow = block.querySelector(".scans-arrow");
          if (!body) return;
          const nowOpen = body.hidden;
          body.hidden = !nowOpen;
          if (arrow) arrow.textContent = nowOpen ? "▾" : "▸";
          if (nowOpen) scansOpen.add(client); else scansOpen.delete(client);
        });
      });
    } catch (e) {
      list.innerHTML = `<tr><td colspan="9" class="num">Ошибка загрузки: ${escapeHtml((e && e.message) || String(e))}</td></tr>`;
    }
  }
  function renderScansSummary(total, okN, failN) {
    const box = el.scansSummary;
    if (!box) return;
    box.innerHTML = `<span>За день: <b>${total}</b></span>` +
      `<span class="scan-sum-ok">успешных: <b>${okN}</b></span>` +
      `<span class="scan-sum-fail">неуспешных: <b>${failN}</b></span>`;
  }
  if (el.scansOnlyFailed) {
    // Запоминаем галочку «Только неуспешные» и восстанавливаем после перезагрузки.
    try { el.scansOnlyFailed.checked = localStorage.getItem("biotime.scansOnlyFailed") === "1"; } catch { /* ignore */ }
    el.scansOnlyFailed.addEventListener("change", () => {
      try { localStorage.setItem("biotime.scansOnlyFailed", el.scansOnlyFailed.checked ? "1" : "0"); } catch { /* ignore */ }
      renderScansLog();
    });
  }
  if (el.scansLogRefresh) el.scansLogRefresh.addEventListener("click", renderScansLog);
  if (el.scansDate) {
    // Дата по умолчанию — пусто (показываем ВСЕ дни: полный список, ничего не «пропадает»).
    el.scansDate.addEventListener("change", renderScansLog);
  }
  if (el.scansAllDays) el.scansAllDays.addEventListener("click", () => {
    if (el.scansDate) el.scansDate.value = "";
    renderScansLog();
  });
  if (el.scansLogClear) {
    el.scansLogClear.addEventListener("click", async () => {
      if (!confirm("Очистить логи сканирования? Текущие будут сохранены в архив (не удаляются безвозвратно).")) return;
      try {
        const r = await api("/api/logs/barcode/clear", { method: "POST", body: JSON.stringify({}) });
        if (r && r.ok) toast("Логи очищены");
        else toast((r && r.error) || "Не удалось очистить");
      } catch (e) { toast((e && e.message) || "Ошибка очистки"); }
      renderScansLog();
    });
  }
  // Автообновление «Логов» по мере сканирования складом: опрашиваем каждые ~5 с,
  // но реально перезапрашиваем, ТОЛЬКО когда вкладка «Логи» открыта (иначе зря дёргаем сервер).
  setInterval(() => {
    const list = el.scansLogList;
    if (list && list.offsetParent !== null) renderScansLog();
  }, 5000);

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
  // Собрать матрицу доступа к разделам «Отчётов»: { раздел: [userId, ...] }.
  function collectReportsSections() {
    const out = {};
    const root = el.reportsUsersGroups || el.reportsSectionsWrap;
    if (root) root.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      const key = cb.getAttribute("data-rs-key");
      if (!key) return;
      (out[key] = out[key] || []).push(cb.getAttribute("data-rs-user"));
    });
    return out;
  }
  // Чекбоксы сотрудников для доступа к «Отчёту не найдено» (кто видит вкладку).
  function renderNotfoundUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.notfoundUsers || [];
    if (el.notfoundUsersCount) el.notfoundUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.notfoundUsersSearch ? el.notfoundUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) {
      container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`;
      return;
    }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      return `<label class="group-check">
        <input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} />
        <span>${escapeHtml(s.name)}</span>
      </label>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => applyParams());
    });
  }
  if (el.notfoundUsersSearch) {
    el.notfoundUsersSearch.addEventListener("input", () =>
      el.notfoundUsersGroups && renderNotfoundUsersChecks(el.notfoundUsersGroups));
  }

  // Чекбоксы сотрудников для доступа к вкладке «Логи» (кто видит «Логи»).
  function renderLogUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.logUsers || [];
    if (el.logUsersCount) el.logUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.logUsersSearch ? el.logUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) {
      container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`;
      return;
    }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      return `<label class="group-check">
        <input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} />
        <span>${escapeHtml(s.name)}</span>
      </label>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => applyParams());
    });
  }
  if (el.logUsersSearch) {
    el.logUsersSearch.addEventListener("input", () =>
      el.logUsersGroups && renderLogUsersChecks(el.logUsersGroups));
  }
  function renderReportsUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.reportsUsers || [];
    if (el.reportsUsersCount) el.reportsUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.reportsUsersSearch ? el.reportsUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) {
      container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`;
      return;
    }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      const sec = (state.params && state.params.reportsSections) || {};
      const checks = REPORTS_SECTIONS.map(([key, name]) => {
        const on = (sec[key] || []).some((x) => String(x) === String(s.id));
        return `<label class="rs-check" title="${escapeHtml(name)}"><input type="checkbox" data-rs-user="${escapeHtml(String(s.id))}" data-rs-key="${key}" ${on ? "checked" : ""} /><span>${escapeHtml(String(name).slice(0, 4))}.</span></label>`;
      }).join("");
      return `<label class="group-check">
        <input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} />
        <span>${escapeHtml(s.name)}</span>
      </label>
      <div class="rs-row rs-inline"><div class="rs-checks">${checks}</div></div>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => applyParams());
    });
  }
  if (el.reportsUsersSearch) {
    el.reportsUsersSearch.addEventListener("input", () =>
      el.reportsUsersGroups && renderReportsUsersChecks(el.reportsUsersGroups));
  }
  // Внутренние разделы «Отчётов» (ключ вкладки модуля → русское название).
  const REPORTS_SECTIONS = [
    ["dashboard", "Дашборд"],
    ["terms", "Сроки по поставщикам"],
    ["pricing", "Проценка"],
    ["report", "Отчет"],
    ["rejections", "Отказы поставщики"],
    ["client-rejections", "Отказ клиенты"],
    ["client-analysis", "Анализ заказов клиентов"],
    ["europe", "Отчет Европа"],
    ["client-config", "Конфигуратор сроков"],
    ["manual-automat", "Ручной автомат"],
    ["supplier-emails", "Почты поставщиков"],
    ["logs", "Логи"],
    ["settings", "Настройки"],
  ];
  function renderReportsSections() {
    const wrap = el.reportsSectionsWrap;
    if (!wrap) return;
    const staff = state.staff || [];
    const sec = state.params && state.params.reportsSections || {};
    // Список сотрудников; напротив каждого — чекбоксы доступных разделов «Отчётов».
    const rows = staff.map((s) => {
      const checks = REPORTS_SECTIONS.map(([key, name]) => {
        const on = (sec[key] || []).some((x) => String(x) === String(s.id));
        const t = String(name).slice(0, 4) + "."; // компактная подпись (полное в title)
        return `<label class="rs-check" title="${escapeHtml(name)}"><input type="checkbox" data-rs-user="${escapeHtml(String(s.id))}" data-rs-key="${key}" ${on ? "checked" : ""} /><span>${escapeHtml(t)}</span></label>`;
      }).join("");
      return `<div class="rs-row"><span class="rs-name">${escapeHtml(s.name)}</span><div class="rs-checks">${checks}</div></div>`;
    }).join("");
    wrap.innerHTML = rows || `<div class="empty-hint">Сотрудники не заданы.</div>`;
    wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => applyParams()));
  }
  function renderSverkiUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.sverkiUsers || [];
    if (el.sverkiUsersCount) el.sverkiUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.sverkiUsersSearch ? el.sverkiUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) { container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`; return; }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      return `<label class="group-check"><input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} /><span>${escapeHtml(s.name)}</span></label>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => applyParams()));
  }
  if (el.sverkiUsersSearch) {
    el.sverkiUsersSearch.addEventListener("input", () =>
      el.sverkiUsersGroups && renderSverkiUsersChecks(el.sverkiUsersGroups));
  }
  function renderProcenkaUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.procenkaUsers || [];
    if (el.procenkaUsersCount) el.procenkaUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.procenkaUsersSearch ? el.procenkaUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) { container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`; return; }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      return `<label class="group-check"><input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} /><span>${escapeHtml(s.name)}</span></label>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => applyParams()));
  }
  if (el.procenkaUsersSearch) {
    el.procenkaUsersSearch.addEventListener("input", () =>
      el.procenkaUsersGroups && renderProcenkaUsersChecks(el.procenkaUsersGroups));
  }
  function renderParserUsersChecks(container) {
    if (!container) return;
    const staff = state.staff || [];
    const sel = state.params.parserUsers || [];
    if (el.parserUsersCount) el.parserUsersCount.textContent = sel.length ? `· выбрано: ${sel.length}` : "";
    const q = (el.parserUsersSearch ? el.parserUsersSearch.value : "").toLowerCase().trim();
    const filtered = staff.filter((s) => !q || String(s.name || "").toLowerCase().includes(q));
    if (!filtered.length) { container.innerHTML = `<span class="group-scope-empty">Сотрудники не найдены.</span>`; return; }
    container.innerHTML = filtered.map((s) => {
      const checked = sel.some((x) => String(x) === String(s.id)) ? "checked" : "";
      return `<label class="group-check"><input type="checkbox" value="${escapeHtml(String(s.id))}" ${checked} /><span>${escapeHtml(s.name)}</span></label>`;
    }).join("");
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => cb.addEventListener("change", () => applyParams()));
  }
  if (el.parserUsersSearch) {
    el.parserUsersSearch.addEventListener("input", () =>
      el.parserUsersGroups && renderParserUsersChecks(el.parserUsersGroups));
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
    // Источник истины — серверный флаг canSeeShipment: сервер видит полный
    // db.groups, а клиенту groups для не-админа/не-модератора не отдаются,
    // поэтому клиентский staffInGroup для такого пользователя всегда false —
    // из-за этого вкладка «Отгрузка» пряталась даже у сотрудников группы склада.
    // Если флаг (из новой версии сервера) пришёл — доверяем ему целиком.
    if (typeof state.canSeeShipment === "boolean") return state.canSeeShipment;
    // Фолбэк для старой версии сервера без поля canSeeShipment.
    if (!state.params.showShipment) return false;
    if (state.isAdmin) return true;
    const ids = state.params.shipmentGroups || [];
    if (ids.length === 0) return false; // никого не отмечено — раздел скрыт у всех
    return state.me && staffInGroup(state.me.id, ids);
  }
  // Доступ к вкладке «Отчёт не найдено»: админ — всегда; остальные — только те,
  // кто отмечен в «Параметры → Доступ к “Отчёту не найдено”».
  function canSeeNotfound() {
    if (state.isAdmin) return true;
    // Источник истины — серверный флаг (как canSeeShipment): сервер считает доступ
    // по полному списку notfoundUsers и пускает в /api/notfound именно этих людей.
    if (typeof state.canSeeNotfound === "boolean") return state.canSeeNotfound;
    const ids = state.params.notfoundUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  // Кто видит вкладку «Логи»: админ, модератор или сотрудник из logUsers
  // (серверный флаг canSeeLogs — источник истины, как canSeeNotfound).
  function canSeeLogs() {
    if (state.isAdmin || state.isModerator) return true;
    if (typeof state.canSeeLogs === "boolean") return state.canSeeLogs;
    const ids = state.params.logUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  function canSeeReports() {
    // Вкладку «Отчёты» всегда видит только администратор; остальные — только если
    // отмечены в «Параметры → Доступ к “Отчёты”» (модератор права не имеет).
    if (state.isAdmin) return true;
    if (typeof state.canSeeReports === "boolean") return state.canSeeReports;
    const ids = state.params.reportsUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  function canSeeSverki() {
    if (state.isAdmin) return true;
    if (typeof state.canSeeSverki === "boolean") return state.canSeeSverki;
    const ids = state.params.sverkiUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  function canSeeProcenka() {
    if (state.isAdmin) return true;
    if (typeof state.canSeeProcenka === "boolean") return state.canSeeProcenka;
    const ids = state.params.procenkaUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  function canSeeParser() {
    if (state.isAdmin) return true;
    if (typeof state.canSeeParser === "boolean") return state.canSeeParser;
    const ids = state.params.parserUsers || [];
    if (ids.length === 0) return false;
    return state.me && state.me.id != null && ids.some((x) => String(x) === String(state.me.id));
  }
  // Отрисовка вкладки «Отчёты». Пока модуль АБЦП не перенесён — заглушка; после
  // интеграции здесь монтируется его интерфейс (вариант 2 — прямая встройка).
  function renderReports() {
    const host = el.reportsHost;
    if (!host) return;
    if (host.dataset.ready) return;
    host.dataset.ready = "1";
    host.classList.add("reports-embed");
    host.innerHTML = `<iframe src="/reports/" style="width:100%;height:calc(100vh - 150px);min-height:480px;border:0;border-radius:12px;background:#101010;" title="Отчёты"></iframe>`;
  }
  // Полноэкранное модальное окно «Отчёты».
  function openReportsModal() {
    if (!canSeeReports()) return;
    if (!el.reportsModal || !el.reportsModalFrame) return;
    if (!el.reportsModalFrame.querySelector("iframe")) {
      const ifr = document.createElement("iframe");
      ifr.src = "/reports/";
      ifr.setAttribute("title", "Отчеты ПрофМаркет");
      el.reportsModalFrame.appendChild(ifr);
    }
    if (el.reportsModal.showModal) el.reportsModal.showModal();
  }
  function closeReportsModal() {
    if (el.reportsModal && el.reportsModal.close) el.reportsModal.close();
    if (el.reportsModalFrame) el.reportsModalFrame.innerHTML = "";
  }
  if (el.reportsModalClose) el.reportsModalClose.addEventListener("click", closeReportsModal);
  // Полноэкранное модальное окно «Сверки».
  function openSverkiModal() {
    if (!canSeeSverki()) return;
    if (!el.sverkiModal || !el.sverkiModalFrame) return;
    if (!el.sverkiModalFrame.querySelector("iframe")) {
      const ifr = document.createElement("iframe");
      ifr.src = "/sverki/";
      ifr.setAttribute("title", "Сверки");
      el.sverkiModalFrame.appendChild(ifr);
    }
    if (el.sverkiModal.showModal) el.sverkiModal.showModal();
  }
  function closeSverkiModal() {
    if (el.sverkiModal && el.sverkiModal.close) el.sverkiModal.close();
    if (el.sverkiModalFrame) el.sverkiModalFrame.innerHTML = "";
  }
  if (el.sverkiModalClose) el.sverkiModalClose.addEventListener("click", closeSverkiModal);
  // Полноэкранное модальное окно «Проценка».
  function openProcenkaModal() {
    if (!canSeeProcenka()) return;
    if (!el.procenkaModal || !el.procenkaModalFrame) return;
    if (!el.procenkaModalFrame.querySelector("iframe")) {
      const ifr = document.createElement("iframe");
      ifr.src = "/procenka/";
      ifr.setAttribute("title", "Проценка");
      el.procenkaModalFrame.appendChild(ifr);
    }
    if (el.procenkaModal.showModal) el.procenkaModal.showModal();
  }
  function closeProcenkaModal() {
    if (el.procenkaModal && el.procenkaModal.close) el.procenkaModal.close();
    if (el.procenkaModalFrame) el.procenkaModalFrame.innerHTML = "";
  }
  if (el.procenkaModalClose) el.procenkaModalClose.addEventListener("click", closeProcenkaModal);
  // Полноэкранное модальное окно «Парсер почты».
  function openParserModal() {
    if (!canSeeParser()) return;
    if (!el.parserModal || !el.parserModalFrame) return;
    if (!el.parserModalFrame.querySelector("iframe")) {
      const ifr = document.createElement("iframe");
      ifr.src = "/parser/";
      ifr.setAttribute("title", "Парсер почты");
      el.parserModalFrame.appendChild(ifr);
    }
    if (el.parserModal.showModal) el.parserModal.showModal();
  }
  function closeParserModal() {
    if (el.parserModal && el.parserModal.close) el.parserModal.close();
    if (el.parserModalFrame) el.parserModalFrame.innerHTML = "";
  }
  if (el.parserModalClose) el.parserModalClose.addEventListener("click", closeParserModal);
  // Проблемы со склада — полноэкранное модальное окно (переносим содержимое раздела).
  function openNotfoundModal() {
    if (!el.notfoundModal || !el.notfoundModalBody) return;
    while (el.pageNotfound && el.pageNotfound.firstChild) {
      el.notfoundModalBody.appendChild(el.pageNotfound.firstChild);
    }
    if (el.notfoundModal.showModal) el.notfoundModal.showModal();
    renderNotfound();
  }
  function closeNotfoundModal() {
    if (el.notfoundModal && el.notfoundModal.close) el.notfoundModal.close();
    if (el.pageNotfound && el.notfoundModalBody) {
      while (el.notfoundModalBody.firstChild) {
        el.pageNotfound.appendChild(el.notfoundModalBody.firstChild);
      }
    }
  }
  if (el.notfoundModalClose) el.notfoundModalClose.addEventListener("click", closeNotfoundModal);
  // Зарплата — полноэкранное модальное окно.
  function openSalaryModal() {
    const page = el.pageCalendar || document.getElementById("page-calendar");
    if (!el.salaryModal || !el.salaryModalBody || !page) return;
    while (page.firstChild) el.salaryModalBody.appendChild(page.firstChild);
    if (el.salaryModal.showModal) el.salaryModal.showModal();
    if (typeof renderCalendar === "function") renderCalendar();
  }
  function closeSalaryModal() {
    if (el.salaryModal && el.salaryModal.close) el.salaryModal.close();
    const page = el.pageCalendar || document.getElementById("page-calendar");
    if (page && el.salaryModalBody) {
      while (el.salaryModalBody.firstChild) page.appendChild(el.salaryModalBody.firstChild);
    }
  }
  if (el.salaryModalClose) el.salaryModalClose.addEventListener("click", closeSalaryModal);
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
    if (el.allowDriverReorderPoints) el.allowDriverReorderPoints.checked = !!state.params.allowDriverReorderPoints;
    if (el.allowWaybill) el.allowWaybill.checked = !!state.params.allowWaybill;
    if (el.routeDeleteCode) el.routeDeleteCode.value = state.params.routeDeleteCode || "";
    if (el.scanLogLimit) el.scanLogLimit.value = state.params.scanLogLimit != null ? state.params.scanLogLimit : 30000;
    renderGroupChecks(el.showOverHoursGroups, state.params.showOverHoursGroups || []);
    renderGroupChecks(el.showOverSumGroups, state.params.showOverSumGroups || []);
    renderGroupChecks(el.shipmentGroups, state.params.shipmentGroups || []);
    renderNotfoundUsersChecks(el.notfoundUsersGroups);
    renderLogUsersChecks(el.logUsersGroups);
    renderReportsUsersChecks(el.reportsUsersGroups);
    if (el.normVal) el.normVal.value = state.norm;
    if (el.updateVersionCode) el.updateVersionCode.value = state.params.updateVersionCode != null ? state.params.updateVersionCode : "";
    if (el.updateVersionName) el.updateVersionName.value = state.params.updateVersionName || "";
    if (el.updateApkUrl) el.updateApkUrl.value = state.params.updateApkUrl || "";
    if (el.updateNotes) el.updateNotes.value = state.params.updateNotes || "";
    updateMultiplierStatus();
  }

  function updateMultiplierStatus() {
    if (!el.multiplierStatus) return;
    const p = state.params;
    const rules = Array.isArray(p.multRules) ? p.multRules : [];
    const active = multiplierActive(); // применяется ли к текущему пользователю сейчас
    let text;
    if (rules.length > 0) {
      text = `Настроено правил: ${rules.length}`
        + (active ? " · на вас действует повышенный тариф" : "");
    } else if (p.multiplier && p.multiplier > 1) {
      // Легаси-настройка (старые поля) — всё ещё влияет на расчёт.
      const hasPeriod = !!(p.multFrom && p.multTo);
      const normFrom = p.multFrom ? new Date(p.multFrom).toLocaleDateString("ru-RU") : "—";
      const normTo = p.multTo ? new Date(p.multTo).toLocaleDateString("ru-RU") : "—";
      const gids = p.multGroups || [];
      const groupNames = gids
        .map((gid) => { const g = (state.groups || []).find((x) => x.id === gid); return g ? g.name : null; })
        .filter(Boolean)
        .join(", ");
      text = hasPeriod
        ? `Легаси: ×${p.multiplier} · период ${normFrom} – ${normTo}${groupNames ? ` · группы: ${groupNames}` : " · для всех"}`
        : `Легаси: ×${p.multiplier} · постоянно${groupNames ? ` · группы: ${groupNames}` : " · для всех"}`
        + (active ? " · действует на вас" : "");
    } else {
      text = "Правил нет — множитель ×1";
    }
    el.multiplierStatus.textContent = text;
    el.multiplierStatus.classList.toggle("active", active);
  }

  // ---- Вкладка «Множитель»: правила «конкретный день + интервал времени» ----
  function multSubjectName(rule) {
    if (rule.target === "all") return "Все сотрудники";
    if (rule.target === "staff") {
      const s = (state.staff || []).find((x) => String(x.id) === String(rule.targetId));
      return s ? s.name : `Сотрудник #${rule.targetId}`;
    }
    const g = (state.groups || []).find((x) => String(x.id) === String(rule.targetId));
    return g ? g.name : `Группа #${rule.targetId}`;
  }
  function multRuleWindowText(rule) {
    const date = rule.date ? new Date(rule.date + "T00:00:00").toLocaleDateString("ru-RU") : "—";
    const from = rule.from ? String(rule.from) : "—";
    const to = rule.to ? String(rule.to) : "—";
    return `${date} · ${from}–${to}`;
  }

  function renderMultSubjectOptions() {
    if (!el.multRuleTarget || !el.multRuleSubject) return;
    const target = el.multRuleTarget.value;
    const label = target === "staff" ? "Сотрудник" : (target === "group" ? "Группа" : "Субъект");
    if (el.multRuleSubjectLabel) el.multRuleSubjectLabel.textContent = label;
    if (el.multRuleSubjectField) el.multRuleSubjectField.style.display = target === "all" ? "none" : "";
    if (target === "all") return;
    const opts = target === "staff"
      ? (state.staff || []).map((s) => ({ id: s.id, name: s.name }))
      : (state.groups || []).map((g) => ({ id: g.id, name: g.name }));
    el.multRuleSubject.innerHTML = opts.length
      ? opts.map((o) => `<option value="${escapeHtml(String(o.id))}">${escapeHtml(o.name)}</option>`).join("")
      : `<option value="" selected>Нет доступных</option>`;
  }

  function renderMultRules() {
    updateMultiplierStatus();
    renderMultSubjectOptions();
    if (!el.multRuleList) return;
    const rules = Array.isArray(state.params.multRules) ? state.params.multRules : [];
    if (!rules.length) {
      el.multRuleList.innerHTML = `<div class="mult-rule-empty">Правил пока нет — переработка считается по стандартной ставке (×1).</div>`;
      return;
    }
    el.multRuleList.innerHTML = rules.map((r) => `
      <div class="mult-rule-item">
        <div class="mult-rule-info">
          <div class="mult-rule-who"><b>${escapeHtml(multSubjectName(r))}</b> · ×${r.mult}</div>
          <div class="mult-rule-days-text">Действует: ${escapeHtml(multRuleWindowText(r))}</div>
        </div>
        <div class="mult-rule-actions-inline">
          <button type="button" class="mini-btn mult-rule-edit" data-mult-rule-id="${escapeHtml(r.id)}">Изменить</button>
          <button type="button" class="mini-btn mult-rule-del" data-mult-rule-id="${escapeHtml(r.id)}">Удалить</button>
        </div>
      </div>`).join("");
  }

  // id правила, которое сейчас редактируем через форму (null = режим добавления).
  let multRuleEditingId = null;

  function setMultRuleFormMode(editing) {
    if (el.multRuleFormTitle) {
      el.multRuleFormTitle.textContent = editing ? "Редактирование правила" : "Новое правило";
    }
    if (el.multRuleAddBtn) {
      el.multRuleAddBtn.textContent = editing ? "Сохранить изменения" : "Добавить правило";
    }
    if (el.multRuleCancelBtn) el.multRuleCancelBtn.hidden = !editing;
  }

  function submitMultRule() {
    if (!el.multRuleTarget || !el.multRuleValue) return;
    const target = el.multRuleTarget.value;
    const targetId = target === "all" ? null : (el.multRuleSubject ? el.multRuleSubject.value : "");
    if (target !== "all" && !targetId) { toast("Выберите сотрудника или группу"); return; }
    const date = el.multRuleDate ? String(el.multRuleDate.value || "").trim() : "";
    if (!date) { toast("Выберите день в календаре — без дня множитель не действует"); return; }
    const from = el.multRuleFrom ? String(el.multRuleFrom.value || "18:00").trim() : "18:00";
    const to = el.multRuleTo ? String(el.multRuleTo.value || "21:00").trim() : "21:00";
    const mult = Number(parseFloat(String(el.multRuleValue.value || "")));
    if (!Number.isFinite(mult) || mult < 1) { toast("Множитель должен быть ≥ 1"); return; }

    if (!Array.isArray(state.params.multRules)) state.params.multRules = [];

    if (multRuleEditingId) {
      // Режим редактирования: обновляем существующее правило.
      const idx = state.params.multRules.findIndex((r) => String(r.id) === String(multRuleEditingId));
      if (idx === -1) { cancelMultRuleEdit(); toast("Правило не найдено — обновлён список"); return; }
      state.params.multRules[idx] = Object.assign({}, state.params.multRules[idx], {
        target, targetId, mult, date, from, to,
      });
      cancelMultRuleEdit();
      renderMultRules();
      render();
      toast("Правило обновлено");
      return;
    }

    const rule = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      target,
      targetId,
      mult,
      date,
      from,
      to,
    };
    state.params.multRules.push(rule);
    renderMultRules();
    render();
    toast("Правило добавлено");
  }

  function startEditMultRule(ruleId) {
    if (!ruleId || !Array.isArray(state.params.multRules)) return;
    const rule = state.params.multRules.find((r) => String(r.id) === String(ruleId));
    if (!rule) return;
    multRuleEditingId = rule.id;
    if (el.multRuleTarget) el.multRuleTarget.value = rule.target;
    if (el.multRuleTarget) renderMultSubjectOptions();
    if (el.multRuleSubject) el.multRuleSubject.value = rule.targetId || "";
    if (el.multRuleDate) el.multRuleDate.value = rule.date || "";
    if (el.multRuleFrom) el.multRuleFrom.value = rule.from || "";
    if (el.multRuleTo) el.multRuleTo.value = rule.to || "";
    if (el.multRuleValue) el.multRuleValue.value = rule.mult;
    setMultRuleFormMode(true);
    if (el.multRuleCancelBtn) el.multRuleCancelBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function cancelMultRuleEdit() {
    multRuleEditingId = null;
    if (el.multRuleDate) el.multRuleDate.value = "";
    if (el.multRuleFrom) el.multRuleFrom.value = "18:00";
    if (el.multRuleTo) el.multRuleTo.value = "21:00";
    if (el.multRuleValue) el.multRuleValue.value = "1.5";
    if (el.multRuleTarget) el.multRuleTarget.value = "all";
    if (el.multRuleTarget) renderMultSubjectOptions();
    setMultRuleFormMode(false);
  }

  function removeMultRule(ruleId) {
    if (!ruleId || !Array.isArray(state.params.multRules)) return;
    state.params.multRules = state.params.multRules.filter((r) => String(r.id) !== String(ruleId));
    renderMultRules();
    render();
    toast("Правило удалено");
  }

  // Сохранение правил на сервер — отдельным вызовом /api/params (админ), через
  // цепочку, чтобы быстрые клики по «Добавить/Удалить» не гоняли параллельные
  // POST (см. paramsSaveChain в applyParams).
  let multRuleSaveChain = Promise.resolve();
  function persistMultRules() {
    // Защищаем локальные multRules от фонового опроса pollState, пока POST в
    // полёте: без этого правила, добавленного только что на клиенте, `paramsDirty`
    // не поднят, и pollState (раз в 8 с) перезаписывает state.params старой
    // версией с сервера — правило «исчезает» из списка ещё до подтверждения.
    paramsDirty = true;
    multRuleSaveChain = multRuleSaveChain.then(async () => {
      const st = state.params;
      const p = {
        multRules: Array.isArray(st.multRules) ? st.multRules : [],
        // Оставляем легаси-поля, чтобы старые версии клиента/сервера не потеряли
        // настройку: при записи правил сбрасываем глобальный легаси-множитель,
        // иначе старый расчёт и новый конфликтовали бы.
        multiplier: (Array.isArray(st.multRules) && st.multRules.length ? 1 : st.multiplier),
      };
      return api("/api/params", { method: "POST", body: JSON.stringify(p) })
        .then(() => {
          paramsDirty = false;
          toast("Правила множителя сохранены");
        })
        .catch(() => {
          paramsDirty = false;
          toast("Не удалось сохранить правила — проверьте связь");
        });
    });
  }

  // Цепочка сохранения параметров: применяем изменения мгновенно на клиенте
  // (вкладки реагируют сразу), а на сервер пишем строго последовательно, чтобы
  // быстрые клики не «разъезжались» гонкой независимых POST и не откатывали
  // друг друга (в т.ч. ползунок «Отгрузка»).
  let paramsSaveChain = Promise.resolve();
  // Пока админ вручную меняет параметры и POST /api/params ещё не подтверждён
  // сервером, фоновый опрос pollState не должен перезаписывать локально
  // выбранное состояние (иначе тумблер, который только что включили, мог бы
  // «откатиться» пришедшим из фона старым значением — симптом «настройка
  // слетает»). Флаг снимается только после успешного сохранения на сервер.
  let paramsDirty = false;
  function applyParams() {
    paramsDirty = true;
    const p = {
      showOverHours: !!el.showOverHours.checked,
      showOverSum: !!el.showOverSum.checked,
      showDrivers: !!el.showDrivers.checked,
      adminSeeRoutes: !!el.adminSeeRoutes.checked,
      driverSeeRoutes: !!el.driverSeeRoutes.checked,
      showShipment: !!el.showShipment.checked,
      allowDriverStartWithoutShipment: !!el.allowDriverStartWithoutShipment.checked,
      allowFinishUnloadIncomplete: !!el.allowFinishUnloadIncomplete.checked,
      allowDriverReorderPoints: !!el.allowDriverReorderPoints.checked,
      allowWaybill: true, // сборка всегда включена, опции нет
      authRequired: true, // собственный вход (логин/пароль) всегда включён, опции нет
      routeDeleteCode: el.routeDeleteCode ? el.routeDeleteCode.value.trim() : "",
      scanLogLimit: el.scanLogLimit ? (Number(el.scanLogLimit.value) || 30000) : 30000,
      showOverHoursGroups: collectGroupChecks(el.showOverHoursGroups),
      showOverSumGroups: collectGroupChecks(el.showOverSumGroups),
      shipmentGroups: collectGroupChecks(el.shipmentGroups),
      notfoundUsers: collectGroupChecks(el.notfoundUsersGroups),
      logUsers: collectGroupChecks(el.logUsersGroups),
      reportsUsers: collectGroupChecks(el.reportsUsersGroups),
      reportsSections: collectReportsSections(),
      sverkiUsers: collectGroupChecks(el.sverkiUsersGroups),
      procenkaUsers: collectGroupChecks(el.procenkaUsersGroups),
      parserUsers: collectGroupChecks(el.parserUsersGroups),
    };
    // Множитель теперь управляется только через вкладку «Множитель» (multRules):
    // старые поля params.multiplier/multFrom/multTo не редактируются здесь и
    // сохраняются как есть (легаси-fallback, пока правил нет).
    let norm = parseFloat(el.normVal.value);
    p.norm = (Number.isFinite(norm) && norm >= 1 && norm <= 24) ? norm : state.norm;
    // Версия обновления Android-APK (управляется из «Параметры»). Пусто = вернуться
    // к значениям окружения/дефолтам сервера.
    if (el.updateVersionCode) p.updateVersionCode = el.updateVersionCode.value.trim();
    if (el.updateVersionName) p.updateVersionName = el.updateVersionName.value.trim();
    if (el.updateApkUrl) p.updateApkUrl = el.updateApkUrl.value.trim();
    if (el.updateNotes) p.updateNotes = el.updateNotes.value.trim();
    p.multRules = state.params.multRules || [];
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
        paramsDirty = false;
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
  el.addStaffBtn.addEventListener("click", openAddStaffModal);
  el.addStaffSubmit && el.addStaffSubmit.addEventListener("click", addStaff);
  el.addStaffClose && el.addStaffClose.addEventListener("click", closeAddStaffModal);
  el.addStaffCancel && el.addStaffCancel.addEventListener("click", closeAddStaffModal);
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
        // Отзываем ссылку не сразу: сразу после click() браузер может ещё не начать
        // запись файла, и revoke отменяет скачивание «без ничего». Даём запас.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
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
        // file.text() отсутствует в части WebView/встроенных браузеров и молча
        // ронял восстановление («нажимаю Да — ничего не происходит»). Читаем
        // через FileReader — тот же паттерн, что уже работает в app.js для
        // накладных, и он доступен везде.
        const text = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
          try {
            reader.readAsText(file, "utf-8");
          } catch (e) {
            reject(new Error("Файл не читается в этом браузере"));
          }
        });
        let parsed;
        try { parsed = JSON.parse(text); } catch { throw new Error("Файл не является корректным JSON-бэкапом"); }
        // Standalone Black Hole обрезает тело запроса (лимит шлюза), поэтому
        // большой бэкап не уходит одним POST («Ошибка сервера: bad json»).
        // Отправляем JSON кусками по ~500 тыс. символов (~0.6 МБ в utf-8) —
        // каждая часть проходит даже лимит 1 МиБ, — и собираем на сервере
        // вызовом /restore-complete.
        const CHUNK_CHARS = 500000;
        const token = "b" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        const bodyStr = JSON.stringify(parsed);
        const total = Math.max(1, Math.ceil(bodyStr.length / CHUNK_CHARS));
        let restoreRes;
        if (total === 1) {
          restoreRes = await fetch("/api/admin/backup/restore", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: bodyStr,
          });
        } else {
          for (let i = 0; i < total; i++) {
            const chunk = bodyStr.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS);
            const pr = await fetch("/api/admin/backup/restore-part", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token, index: i, total, data: chunk }),
            });
            const pj = await pr.json().catch(() => ({}));
            if (!pr.ok) throw new Error((pj && pj.error) || `Не удалось загрузить часть ${i + 1}/${total}`);
          }
          restoreRes = await fetch("/api/admin/backup/restore-complete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, total }),
          });
        }
        const res = restoreRes;
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = (j && j.error) || `Не удалось восстановить базу (HTTP ${res.status})`;
          toast(msg);
          if (el.backupStatus) { el.backupStatus.textContent = msg; el.backupStatus.className = "backup-status err"; }
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
        const msg = (e && e.message) || "Не удалось восстановить базу";
        toast(msg);
        if (el.backupStatus) { el.backupStatus.textContent = msg; el.backupStatus.className = "backup-status err"; }
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
  // Заполнить расходные накладные из 1С для ВСЕХ выбранных на форме клиентов —
  // ДО сохранения маршрута. Накладные складываются в routeWaybills и уедут
  // вместе с маршрутом при «Сохранить маршрут».
  if (el.fillFrom1CBtn) {
    el.fillFrom1CBtn.addEventListener("click", async () => {
      // Раскрываем объединённого клиента (связку, несколько контрагентов на один
      // адрес) на всех его членов: у каждого внутреннего клиента свой ИНН и логин,
      // и каждый должен уйти в 1С со своими данными и появиться в «Логи 1C»
      // отдельной строкой — иначе в логе виден только общий (STP) и непонятно,
      // кто из внутренних получил данные, а кто нет.
      const picked = routeOrderIds.length ? routeOrderIds.slice() : [...selectedRouteClientIds];
      const ids = new Set();
      for (const id of picked) {
        const s = String(id);
        ids.add(s);
        const c = driverClientsCache.find((x) => String(x.id) === s);
        // Раскрываем связку по ОБЩЕМУ АДРЕСУ (bundleAddress || address) — так связка
        // схлопывается в одну остановку маршрута. На одном адресе может быть
        // несколько контрагентов, у каждого свой ИНН и логин — каждый должен уйти
        // в 1С со своими данными и появиться в «Логи 1C» отдельной строкой (ИНН и
        // логин контрагента, по которому взят документ), а не общим STP.
        const addrKey = String((c && (c.bundleAddress || c.address)) || "").trim().toLowerCase();
        if (addrKey) {
          driverClientsCache.forEach((m) => {
            const mk = String((m && (m.bundleAddress || m.address)) || "").trim().toLowerCase();
            if (mk && mk === addrKey) ids.add(String(m.id));
          });
        }
      }
      const chosen = [...ids].map((id) => driverClientsCache.find((x) => String(x.id) === id)).filter(Boolean);
      if (!chosen.length) { toast("Сначала выберите клиентов"); return; }
      const payload = chosen.map((c) => ({ inn: (c && c.inn) || "", login: (c && c.login) || "" }));
      try {
        const r = await api("/api/waybills/from-1c", {
          method: "POST",
          body: JSON.stringify({ clients: payload }),
        });
        const rr = r && r.waybills;
        if (!Array.isArray(rr)) {
          toast((r && r.error) || "Ошибка заполнения из 1С");
          return;
        }
        let filled = 0, totalItems = 0, totalQty = 0;
        rr.forEach((res, i) => {
          const c = chosen[i];
          if (!c) return;
          if (res && res.ok && Array.isArray(res.items) && res.items.length) {
            // Ключ — по id КЛИЕНТА (единообразно с загрузкой .xlsx и с чтением при
            // сохранении). Иначе (по адресу) накладные из «Заполнить из 1С» терялись
            // бы при сохранении — в сборке оставалось пусто.
            routeWaybills.set(String(c.id), { items: res.items, buyer: (res.buyer || "") });
            filled++;
            totalItems += res.items.length;
            res.items.forEach((it) => { totalQty += (Number(it && it.qty) || 0); });
          }
        });
        renderRouteWaybillsBlock();
        let msg = filled
          ? ("Успешно добавлено: " + totalItems + " поз. / " + totalQty + " шт")
          : "Не удалось получить накладные";
        if (r && r.noInn) msg += " · без ИНН/логина: " + r.noInn;
        toast(msg);
        // Для уже существующего маршрута сразу сохраняем накладные на сервер
        // в route.waybills — тогда партисткеры и позиции сразу видны в сборке,
        // а не только после «Сохранить маршрут».
        if (editingRouteId) {
          try {
            await api("/api/routes/" + encodeURIComponent(editingRouteId) + "/fill-from-1c", { method: "POST" });
          } catch { /* ignore */ }
          try { loadDriverRoutes(); } catch { /* ignore */ }
          try { refreshWaybillFromServer(); } catch { /* ignore */ }
        }
      } catch (e) {
        toast((e && e.message) || "Ошибка заполнения из 1С");
      }
    });
  }
  // Поправка времени устройства: сохраняем при изменении.
  if (el.acctTzOffset) {
    el.acctTzOffset.addEventListener("change", () => {
      try { localStorage.setItem("biotime_time_offset_min", String(el.acctTzOffset.value || "0")); } catch { /* ignore */ }
    });
  }
  // Черновик «Маршрут на день»: сохраняем при любом изменении полей/выбора.
  ["driverRouteDate", "driverRouteDriver", "driverRouteName"].forEach((ref) => {
    const n = el[ref];
    if (n) n.addEventListener(n.type === "text" ? "input" : "change", saveRouteDraft);
  });
  if (el.selfPickupChk) el.selfPickupChk.addEventListener("change", saveRouteDraft);
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
  bindSubtab(el.subtabLocation, "location");
  bindSubtab(el.subtab1cLog, "1clog");
  bindSubtab(el.subtabTracking, "tracking");
  // Подвкладки раздела «Отгрузка»: «В работе» и «Завершённые отгрузки».
  const setShipmentSubtab = (tab) => {
    shipmentSubtab = tab;
    if (el.shipmentSubtabActive) el.shipmentSubtabActive.classList.toggle("is-active", tab === "active");
    if (el.shipmentSubtabDone) el.shipmentSubtabDone.classList.toggle("is-active", tab === "done");
    // Немедленно показываем нужный контейнер (без ожидания сетевого ответа),
    // чтобы переключение вкладки не «зависало», пока сервер отвечает.
    applyShipmentCollapseUI();
    // Перезапрашиваем с сервера при каждом переключении подвкладки, чтобы
    // завершённая отгрузка сразу уходила из «В работе» и появлялась в
    // «Завершённые отгрузки», а не рисовалась из устаревшего кеша.
    loadShipments();
  };
  if (el.shipmentSubtabActive) el.shipmentSubtabActive.addEventListener("click", () => setShipmentSubtab("active"));
  if (el.shipmentSubtabDone) el.shipmentSubtabDone.addEventListener("click", () => setShipmentSubtab("done"));
  // Календарь дат в разделе «Отгрузка»: фильтр по дате маршрута.
  if (el.shipmentDateFilter) {
    el.shipmentDateFilter.addEventListener("change", () => {
      state.shipmentDateFilter = el.shipmentDateFilter.value || "";
      renderShipments();
    });
  }
  if (el.shipmentDateClear) {
    el.shipmentDateClear.addEventListener("click", () => {
      state.shipmentDateFilter = "";
      if (el.shipmentDateFilter) el.shipmentDateFilter.value = "";
      renderShipments();
    });
  }
  // Сворачивание/разворачивание карточки маршрута во всех разделах (Мои маршруты,
  // Маршруты у админа, Доставка, Отгрузка). Делегированный обработчик: активный
  // маршрут (и идущую отгрузку) свернуть нельзя — кнопка не имеет
  // data-route-collapse и заблокирована.
  document.addEventListener("click", (ev) => {
    const toggler = ev.target.closest && ev.target.closest("[data-route-collapse]");
    if (!toggler) return;
    const card = toggler.closest(".drv-route-card, .driver-route-card, .delivery-card, .shipment-card");
    if (!card) return;
    card.classList.toggle("route-collapsed");
    const collapsedNow = card.classList.contains("route-collapsed");
    const body = card.querySelector(".route-collapsible");
    if (body) body.hidden = collapsedNow;
    toggler.textContent = collapsedNow ? "▸" : "▾";
    // Запоминаем вручную раскрытые карточки, чтобы автообновление раздела
    // (loadShipments / loadMyRoutes раз в несколько секунд) не сворачивало их
    // обратно. Для отгрузки — expandedShipmentCards, для «Моих маршрутов» —
    // expandedMyRouteCards (отличаем по data-myroute).
    const rid = card.dataset.routeId;
    if (rid) {
      const idStr = String(rid);
      if (card.hasAttribute("data-myroute")) {
        if (collapsedNow) expandedMyRouteCards.delete(idStr);
        else expandedMyRouteCards.add(idStr);
        saveCollapsedSet("biotime_expanded_myroutes", expandedMyRouteCards);
      } else if (card.classList.contains("shipment-card")) {
        if (collapsedNow) collapsedShipmentCards.add(idStr);
        else collapsedShipmentCards.delete(idStr);
        saveShipCollapsed();
      } else if (card.classList.contains("delivery-card")) {
        if (collapsedNow) expandedShipmentCards.delete(idStr);
        else expandedShipmentCards.add(idStr);
      } else if (card.classList.contains("drv-route-card")) {
        if (collapsedNow) expandedDriverRouteCards.delete(idStr);
        else expandedDriverRouteCards.add(idStr);
      }
    }
  });
  // Печать этикеток отгрузки: подтверждение и закрытие модалки.
  if (el.printConfirm) el.printConfirm.addEventListener("click", () => doPrintLabels(false));
  // «Допечатать места» открывает отдельное окно со ВСЕМИ клиентами маршрута
  // (включая отгруженных), где можно выбрать любого и допечатать ему места.
  if (el.printAppendBtn) el.printAppendBtn.addEventListener("click", () => {
    if (printRouteId) openAppendModal(printRouteId);
  });
  if (el.printCancel) el.printCancel.addEventListener("click", () => { try { el.printModal.close(); } catch {} });
  if (el.printClose) el.printClose.addEventListener("click", () => { try { el.printModal.close(); } catch {} });
  // События отдельного окна «Допечатать места».
  if (el.appendClose) el.appendClose.addEventListener("click", () => { try { el.appendModal.close(); } catch {} });
  if (el.appendCancel) el.appendCancel.addEventListener("click", () => { try { el.appendModal.close(); } catch {} });
  if (el.appendConfirm) el.appendConfirm.addEventListener("click", () => doAppendLabels());
  if (el.appendClientsTiles) {
    el.appendClientsTiles.addEventListener("click", (ev) => {
      const tile = ev.target.closest(".print-client-tile");
      if (!tile) return;
      const idx = Number(tile.dataset.appendClientIndex);
      if (Number.isFinite(idx) && idx >= 0) {
        // Допечатка доступна только полностью погруженному клиенту — игнорируем
        // клик по клиенту, у которого боксы ещё не созданы или создана лишь часть.
        const r = shipmentsCache.find((x) => String(x.id) === String(appendRouteId));
        const cl = r && Array.isArray(r.clients) ? r.clients[idx] : null;
        const done = cl
          ? Number(cl.totalCount) > 0 && Number(cl.loadedCount) >= Number(cl.totalCount)
          : false;
        if (!done) return;
        appendClientIndex = idx;
        renderAppendClientsTiles();
        updateAppendConfirmState();
      }
    });
  }
  // «Завершить отгрузку» перенесена в окно печати этикеток: завершает текущий
  // маршрут (printRouteId) и закрывает окно, после чего список отгрузки
  // перерисовывается (loadShipments) и водитель может начать маршрут.
  if (el.printShipmentComplete) {
    el.printShipmentComplete.addEventListener("click", async () => {
      if (!printRouteId) return;
      const routeId = printRouteId;
      const btn = el.printShipmentComplete;
      btn.disabled = true;
      try {
        const r = await api("/api/shipments/complete", {
          method: "POST",
          body: JSON.stringify({ routeId }),
        });
        if (r && r.ok) {
          toast("Отгрузка завершена");
          // Дожидаемся обновления списка, чтобы завершённая отгрузка сразу
          // ушла из «В работе» (без ожидания следующего 5-сек поллинга).
          await loadShipments();
          try { el.printModal.close(); } catch { /* ignore */ }
        } else {
          toast((r && r.error) || "Не удалось завершить отгрузку");
        }
      } catch (e) {
        toast((e && (e.error || e.message)) || "Не удалось завершить отгрузку");
      } finally {
        btn.disabled = false;
      }
    });
  }
  if (el.scanLoadBtn) el.scanLoadBtn.addEventListener("click", () => callQrScanner("load"));
  // Переключатель источника сканирования: камера / внешний сканер ТСД.
  if (el.scanSrcCamera) {
    el.scanSrcCamera.addEventListener("click", () => {
      setScanSource("camera");
      if (el.printScanHint) el.printScanHint.hidden = true;
    });
  }
  if (el.scanSrcExternal) {
    el.scanSrcExternal.addEventListener("click", () => {
      setScanSource("external");
      if (el.printScanInput) { el.printScanInput.value = ""; el.printScanInput.focus(); }
    });
  }
  applyScanSourceUI();
  // USB-сканер (клавиатурный) печатает код в поле printScanInput. Отправляем код
  // по Enter/автоподаче (сканер жмёт Enter) и для надёжности — при паузе ввода.
  if (el.printScanInput) {
    let scanInputTimer = null;
    el.printScanInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const code = el.printScanInput.value.trim();
        if (code) {
          el.printScanInput.value = "";
          handleExternalScanCode(code);
        }
      }
    });
    el.printScanInput.addEventListener("input", () => {
      // Сканеры часто печатают без Enter — автоподача по паузе ~250 мс.
      clearTimeout(scanInputTimer);
      scanInputTimer = setTimeout(() => {
        if (!el.printScanInput) return;
        const code = el.printScanInput.value.trim();
        if (code) {
          el.printScanInput.value = "";
          handleExternalScanCode(code);
        }
      }, 250);
    });
    el.printScanInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") clearTimeout(scanInputTimer);
    });
  }
  // ---- Внешний сканер (ТСД/USB): считывание кода аппаратной кнопкой сканера.
  // ТСД-сканер передаёт код одним из двух способов:
  //   1) как клавиатура — печатает символы (+Enter) в активный элемент или «в
  //      воздух» (без фокуса на поле). Ловим глобально в capture-фазе.
  //   2) через нативный мост приложения (AndroidBridge / window-колбэк) без
  //      участия клавиатуры. Регистрируем ловушки на распространённые имена.
  // Чтобы не задваивать, когда код лег в поле printScanInput, глобальный
  // keydown-буфер игнорирует ввод, пришедший именно в это поле (оно само
  // отправляет по автоподаче/Enter), а обрабатывает «в воздух» — вне него.
  let glScanCount = 0;
  const bumpScanCount = () => {
    glScanCount += 1;
    try {
      if (el.printScanStatus && scanSource === "external") {
        setPrintScanStatus(`Сканер передал кодов: ${glScanCount}. Если место не отмечается — проверьте, что код корректный.`, "");
        el.printScanStatus.className = "print-scan-status warn";
      }
    } catch (_) {}
  };
  // Единая точка приёма кода с внешнего сканера: погрузка.
  const handleExternalScanCode = (raw) => {
    const code = String(raw == null ? "" : raw).trim();
    if (!code || !el.printModal || !el.printModal.open) return;
    bumpScanCount();
    doScanLabel("load", code);
  };
  // Единая точка приёма кода с нативного сканера ТСД (AndroidBridge.onBarcode /
  // onScan и глобальные window-колбэки). Если открыто окно СБОРКИ — уводим код в
  // поле сборки и запускаем скан (деталь→«МЕСТО», бокс→«ХОРОШО»). Если открыта
  // «Отгрузка» — это погрузка/выгрузка мест (handleExternalScanCode выше).
  const routeExternalScanCode = (raw) => {
    const code = String(raw == null ? "" : raw).trim();
    if (!code) return;
    if (el.waybillModal && el.waybillModal.open) {
      if (el.waybillArtInput) el.waybillArtInput.value = code;
      try { scanWaybill(); } catch (_) { /* не критично */ }
      return;
    }
    handleExternalScanCode(code);
  };
  // (A) Клавиатурный перехват (capture-фаза). Срабатывает всегда при открытом
  // окне «Отгрузка», независимо от фокуса (только избегаем дубля с полем).
  if (scanSource === "external" || !(window.AndroidBridge && typeof window.AndroidBridge.scanQR === "function")) {
    let glScanBuf = "";
    let glScanTs = 0;
    let glScanTimer = null;
    const glSendScan = () => {
      const code = String(glScanBuf).trim();
      glScanBuf = ""; glScanTs = 0;
      if (glScanTimer) { clearTimeout(glScanTimer); glScanTimer = null; }
      if (code) handleExternalScanCode(code);
    };
    const glResetScan = () => {
      glScanBuf = ""; glScanTs = 0;
      if (glScanTimer) { clearTimeout(glScanTimer); glScanTimer = null; }
    };
    window.addEventListener("keydown", (ev) => {
      // Реагируем только когда открыто окно «Отгрузка» (погрузка на складе).
      if (!el.printModal || !el.printModal.open) { glResetScan(); return; }
      // Ввод в поле printScanInput обрабатывается самим полем — не дублируем.
      const ae = document.activeElement;
      if (ae && ae.id === "printScanInput") { glResetScan(); return; }
      const t = Date.now();
      if (glScanTs && (t - glScanTs) > 200) glScanBuf = "";
      const k = ev.key;
      if (k === "Enter") {
        const code = String(glScanBuf).trim();
        if (code) { ev.preventDefault(); ev.stopPropagation(); glSendScan(); }
        else glResetScan();
        return;
      }
      if (k && k.length === 1 && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        glScanBuf += k;
        glScanTs = t;
        if (glScanTimer) clearTimeout(glScanTimer);
        glScanTimer = setTimeout(glSendScan, 300);
      } else {
        glResetScan();
      }
    }, true);
    // (A2) Ввод в поле printScanInput обрабатывается его собственными
    // обработчиками (keydown Enter + input-автоподача) выше — дополнительно
    // diagnostics через тот же handleExternalScanCode не требуется.
    const fieldBorder = () => {};
    // (B) Нативные колбэки сканера ТСД (без клавиатуры). Многие обёртки
    // (WebView+нативный сканер) передают код через глобальные функции окна.
    const nativeCallbackNames = [
      "onBarcode", "onScanData", "scanResult", "barcodeResult",
      "onScannerData", "receiveBarcode", "onBarcodeScanned", "scannerResult",
    ];
    nativeCallbackNames.forEach((name) => {
      try {
        if (typeof window[name] !== "function") {
          window[name] = (data) => {
            const code = (data && (data.code !== undefined ? data.code : data.text !== undefined ? data.text : data)) || "";
            routeExternalScanCode(String(code).trim());
          };
        }
      } catch (_) {}
    });
    // (B2) Колбэк через AndroidBridge, если нативный мост предоставляет его.
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.onScan === "function") {
        const orig = window.AndroidBridge.onScan;
        window.AndroidBridge.onScan = function() {
          routeExternalScanCode(String(arguments.length ? arguments[0] : "").trim());
          try { return orig.apply(this, arguments); } catch (_) { return undefined; }
        };
      }
      if (window.AndroidBridge && typeof window.AndroidBridge.onBarcode === "function") {
        const orig = window.AndroidBridge.onBarcode;
        window.AndroidBridge.onBarcode = function() {
          routeExternalScanCode(String(arguments.length ? arguments[0] : "").trim());
          try { return orig.apply(this, arguments); } catch (_) { return undefined; }
        };
      }
    } catch (_) {}
  }
  // Крестик в оверлее прогресса сканирования: закрывает оверлей и прекращает
  // автоматический перезапуск камеры (водитель сам решает, когда продолжить).
  if (el.scanOverlayClose) {
    el.scanOverlayClose.addEventListener("click", hideScanOverlay);
  }
  if (el.printClientsTiles) {
    el.printClientsTiles.addEventListener("click", (ev) => {
      const tile = ev.target.closest(".print-client-tile");
      if (!tile) return;
      const idx = Number(tile.dataset.clientIndex);
      // Раньше «отгруженный» клиент (tile.is-done) здесь игнорировался — выбрать
      // его было нельзя. Но в процессе отгрузки могут найтись новые места, и для
      // них нужно ДОПЕЧАТАТЬ этикетки. Поэтому отгруженного клиента тоже можно
      // выбрать (допечатка через append не трогает уже погруженные места).
      selectPrintClient(idx);
    });
  }
  // Удаление созданной этикетки: кнопка «✕» в списке мест окна «Отгрузка».
  if (el.printLabelsList) {
    el.printLabelsList.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".pp-del");
      const printBtn = ev.target.closest(".pp-print");
      if (printBtn) { printOneLabel(printBtn.dataset.labelPrint); return; }
      if (!btn) return;
      const id = btn.dataset.labelDel;
      // Код этикетки для понятного подтверждения: рядом в строке.
      const place = btn.closest(".print-place");
      const codeEl = place && place.querySelector(".pp-code");
      const code = codeEl ? codeEl.textContent.trim() : "";
      deletePrintLabel(id, code);
    });
  }
  // Дашборд движения: смена даты перезагружает данные (автообновление —
  // периодический таймер в switchRouteSubtab, см. sectionAutoRefresh).
  if (el.motionDateFilter) {
    el.motionDateFilter.addEventListener("change", loadMotionReport);
  }
  // Отчёт «Местоположение»: кнопка «Показать» и смена даты перезагружают данные.
  if (el.locationGoBtn) {
    el.locationGoBtn.addEventListener("click", () => { populateLocationDrivers(); loadLocationReport(); });
  }
  if (el.locationDateFilter) {
    el.locationDateFilter.addEventListener("change", loadLocationReport);
  }
  if (el.locationDriverSelect) {
    el.locationDriverSelect.addEventListener("change", loadLocationReport);
  }
  // Интервал сетки: сохраняем автоматически и сразу перезагружаем отчёт.
  if (el.locationInterval) {
    el.locationInterval.addEventListener("change", () => {
      try { localStorage.setItem("biotime_location_interval", String(el.locationInterval.value)); } catch { /* ignore */ }
      loadLocationReport();
    });
  }
  // Диагностика связи с 1С (только админ): стучится в 1С с IP приложения.
  if (el.onecPingBtn) {
    el.onecPingBtn.addEventListener("click", async () => {
      if (!el.onecPingRes) return;
      el.onecPingRes.textContent = "Проверка…";
      try {
        const resp = await fetch("/api/1c/ping", {
          headers: { "Accept": "application/json" },
          cache: "no-store",
        });
        let body = null;
        try { body = await resp.json(); } catch (_) { /* не JSON */ }
        if (resp.status === 401 || resp.status === 403) {
          el.onecPingRes.textContent = "Отказ: HTTP " + resp.status + " (сервер не видит админа)";
        } else if (!resp.ok) {
          el.onecPingRes.textContent = "HTTP " + resp.status + ((body && body.error) ? " · " + body.error : "");
        } else if (body && body.error) {
          el.onecPingRes.textContent = "Ошибка: " + body.error;
        } else if (body && body.summary) {
          const s = String(body.summary).replace(/\s+/g, " ");
          el.onecPingRes.textContent = s.length > 600 ? s.slice(0, 600) + "…" : s;
        } else {
          el.onecPingRes.textContent = "HTTP " + (body ? body.http : "?")
            + ((body && body.snippet) ? " · " + body.snippet : "");
        }
      } catch (e) {
        el.onecPingRes.textContent = "Сбой запроса: " + e.message;
      }
    });
  }
  // Доставка: смена даты перезагружает данные (автообновление — периодический
  // таймер в switchTab, см. sectionAutoRefresh).
  if (el.deliveryDateFilter) {
    el.deliveryDateFilter.addEventListener("change", () => {
      // Синхронизируем выбранный день с разделом «Маршруты», чтобы в обоих
      // местах показывался один и тот же день (иначе в доставке 4-е, а в
      // маршрутах — свой день: кажется, что маршрутов нет).
      if (el.driverRoutesDateFilter) el.driverRoutesDateFilter.value = el.deliveryDateFilter.value;
      renderDeliveries();
      if (Array.isArray(driverRoutesCache)) renderDriverRoutes(driverRoutesCache);
    });
  }
  // «Мои маршруты» (водитель): смена выбранного дня перефильтровывает список
  // маршрутов из уже загруженного кэша. Раньше у этого фильтра не было
  // обработчика — водитель открывал календарь, выбирал прошедший день, но
  // список не перерисовывался, и казалось, что «календарь не работает».
  if (el.myroutesDateFilter) {
    el.myroutesDateFilter.addEventListener("change", () => {
      if (Array.isArray(myRoutesCache)) renderMyRoutesList(myRoutesCache);
    });
  }
  // Маршруты: смена выбранного дня в фильтре списка перерисовывает маршруты
  // этого дня из уже загруженного кэша и синхронизирует день с «Доставкой».
  if (el.driverRoutesDateFilter) {
    el.driverRoutesDateFilter.addEventListener("change", () => {
      if (el.deliveryDateFilter) el.deliveryDateFilter.value = el.driverRoutesDateFilter.value;
      if (Array.isArray(driverRoutesCache)) renderDriverRoutes(driverRoutesCache);
      renderDeliveries();
    });
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
  ["showOverHours", "showOverSum", "showDrivers", "adminSeeRoutes", "driverSeeRoutes", "showShipment", "allowDriverStartWithoutShipment", "allowFinishUnloadIncomplete", "allowDriverReorderPoints", "allowWaybill"]
    .forEach((key) => {
      const el2 = el[key];
      if (el2) el2.addEventListener("change", applyParams);
    });
  // Автосохранение нормы рабочего дня и множителя подработки — без кнопки.
  if (el.normVal) el.normVal.addEventListener("change", applyParams);
  // ---- Вкладка «Множитель»: интерактив ----
  if (el.multRuleTarget) {
    el.multRuleTarget.addEventListener("change", renderMultSubjectOptions);
  }
  if (el.multRuleAddBtn) {
    el.multRuleAddBtn.addEventListener("click", () => {
      submitMultRule();
      persistMultRules();
    });
  }
  if (el.multRuleCancelBtn) {
    el.multRuleCancelBtn.addEventListener("click", cancelMultRuleEdit);
  }
  if (el.multRuleList) {
    el.multRuleList.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest("[data-mult-rule-id]");
      if (!btn) return;
      if (btn.classList.contains("mult-rule-edit")) {
        startEditMultRule(btn.dataset.multRuleId);
      } else {
        removeMultRule(btn.dataset.multRuleId);
        persistMultRules();
      }
    });
  }
  if (el.goToMultiplierTab) {
    el.goToMultiplierTab.addEventListener("click", () => switchAdminSub("multiplier"));
  }
  // Автосохранение версии обновления Android-приложения.
  // Событие change срабатывает только на blur/Enter и легко «теряет» ввод, если
  // пользователь закрыл модалку, не убрав фокус с поля. Поэтому слушаем input
  // (каждое изменение) и сохраняем с коротким debounce — значение гарантированно
  // уходит на сервер, что бы ни случилось с фокусом.
  let updateDebounceTimer = null;
  // Сюда же добавлено поле «Код удаления завершённых маршрутов» (routeDeleteCode):
  // у него тоже не было обработчика сохранения, поэтому введённый код не уходил
  // на сервер и «не сохранялся». Теперь он автосохраняется при вводе, как и поля
  // версии обновления.
  ["routeDeleteCode", "scanLogLimit", "updateVersionCode", "updateVersionName", "updateApkUrl", "updateNotes"]
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
  el.reportMonth.addEventListener("change", () => { state.reportMonthKey = el.reportMonth.value; renderReport(); });
  el.reportShowOver.addEventListener("change", renderReport);
  // Переключение разделов вкладки «Отчёт» (Табель / Расчёты ЗП).
  function switchReportSubtab(name) {
    state.reportSubtab = name;
    document.querySelectorAll("#page-report .report-subtab").forEach((b) =>
      b.classList.toggle("active", b.dataset.rsub === name)
    );
    document.querySelectorAll("#page-report .report-subpanel").forEach((p) =>
      p.hidden = p.dataset.rsubpanel !== name
    );
    if (name === "salary") renderSalaryCalc();
    else renderReport();
  }
  document.querySelectorAll("#page-report .report-subtab").forEach((b) => {
    b.addEventListener("click", () => switchReportSubtab(b.dataset.rsub));
  });
  if (el.salaryCalcMonth) el.salaryCalcMonth.addEventListener("change", renderSalaryCalc);
  // Плитки «Расчёт ЗП»: клик по карточке сотрудника раскрывает/сворачивает
  // подробности (по умолчанию всё свёрнуто). Делегируем на весь документ, чтобы
  // обработка работала после любого перерендера списка.
  document.addEventListener("click", (ev) => {
    const card = ev.target.closest && ev.target.closest(".salary-calc-card");
    if (!card) return;
    // Клики внутри раскрытого содержимого (сводка, таблица, сетка показателей)
    // НЕ переключают карточку: там своя прокрутка, и клик по ней должен
    // прокручивать, а не сворачивать карточку. Сворачивание — по шапке/подписи.
    if (ev.target.closest && ev.target.closest(".salary-calc-body")) return;
    const body = card.querySelector(".salary-calc-body");
    if (!body) return;
    const open = body.hidden;
    const skey = card.dataset.skey;
    // Лениво подставляем дневную детализацию при первом раскрытии карточки
    // (HTML строился только для свёрнутых карточек; тут заполняем из кэша).
    if (open && skey) {
      const tbody = body.querySelector("tbody[data-salary-lazy]");
      if (tbody && !tbody.dataset.rendered) {
        const val = el.salaryCalcMonth && el.salaryCalcMonth.value;
        const [yy, mm] = (val || "").split("-").map(Number);
        const entry = (yy && mm) ? salaryCalcCache[salaryCalcKey(skey, yy, mm - 1)] : null;
        tbody.innerHTML = salaryCalcDaysHtml(entry);
        tbody.dataset.rendered = "1";
      }
    }
    body.hidden = !open;
    card.classList.toggle("open", !body.hidden);
    const chev = card.querySelector(".salary-calc-chevron");
    if (chev) chev.textContent = body.hidden ? "▸" : "▾";
  });
  // Download the timesheet for the selected month as an .xlsx file (admin).
  el.reportExportBtn.addEventListener("click", async () => {
    const month = el.reportMonth.value;
    if (!month) return;
    // Просто переходим на адрес выгрузки: сервер отдаёт .xlsx с
    // Content-Disposition: attachment, и браузер/Electron скачивает файл,
    // а не открывает BLOB-поток.
    try { window.location.href = `/api/report/export?month=${encodeURIComponent(month)}`; } catch { /* ignore */ }
    toast("Табель выгружается…");
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
  // «Открыть день» / «Сбросить время и открыть»: админ нажимает на ячейку дня в
  // табеле → в модалке статуса. Сервер POST /api/day/<key>/reopen точечно убирает
  // «завершён» (и при необходимости время) у этого сотрудника, не трогая других.
  async function reopenDay(clearTime) {
    if (!statusCtx) return;
    const { key, ownerId } = statusCtx;
    try {
      const r = await api(`/api/day/${encodeURIComponent(key)}/reopen`, {
        method: "POST",
        body: JSON.stringify({ staffId: ownerId, clearTime }),
      });
      if (r && r.ok) toast(clearTime ? "Время сброшено, день открыт" : "День открыт");
      else toast((r && r.error) || "Не удалось открыть день");
      if (el.statusModal && el.statusModal.open) { try { el.statusModal.close(); } catch { /* ignore */ } }
      loadState();
    } catch (e) { toast((e && e.message) || "Ошибка"); }
  }
  if (el.statusReopen) el.statusReopen.addEventListener("click", () => reopenDay(false));
  if (el.statusReopenClear) el.statusReopenClear.addEventListener("click", () => reopenDay(true));
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
  // ----- Модал удаления завершённого маршрута по коду -----
  if (el.routeDeleteConfirm) {
    el.routeDeleteConfirm.addEventListener("click", () => {
      if (!routeDeleteCtx) return;
      const id = routeDeleteCtx;
      const code = el.routeDeleteInput ? el.routeDeleteInput.value : "";
      routeDeleteCtx = null;
      if (el.routeDeleteModal && el.routeDeleteModal.open) el.routeDeleteModal.close();
      deleteDriverRoute(id, code);
    });
  }
  if (el.routeDeleteCancel) {
    el.routeDeleteCancel.addEventListener("click", () => {
      routeDeleteCtx = null;
      if (el.routeDeleteModal) el.routeDeleteModal.close();
    });
  }
  if (el.routeDeleteClose) {
    el.routeDeleteClose.addEventListener("click", () => {
      routeDeleteCtx = null;
      if (el.routeDeleteModal) el.routeDeleteModal.close();
    });
  }
  if (el.routeDeleteModal) {
    el.routeDeleteModal.addEventListener("cancel", (e) => {
      e.preventDefault();
      routeDeleteCtx = null;
      el.routeDeleteModal.close();
    });
  }
  // Подтверждение удаления по Enter в поле кода.
  if (el.routeDeleteInput) {
    el.routeDeleteInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (el.routeDeleteConfirm) el.routeDeleteConfirm.click();
      }
    });
  }
  // ----- Ручной ввод кода этикетки при выгрузке (неблокирующая модалка) -----
  if (el.driverScanOk) {
    el.driverScanOk.addEventListener("click", submitDriverScan);
  }
  if (el.driverScanCancel) {
    el.driverScanCancel.addEventListener("click", closeDriverScanModal);
  }
  if (el.driverScanClose) {
    el.driverScanClose.addEventListener("click", closeDriverScanModal);
  }
  if (el.driverScanInput) {
    el.driverScanInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitDriverScan();
      }
    });
  }
  if (el.driverScanModal) {
    el.driverScanModal.addEventListener("cancel", (e) => {
      e.preventDefault();
      closeDriverScanModal();
    });
  }
  // ----- Расходная накладная: открытие из отгрузки + модалка -----
  document.addEventListener("click", (ev) => {
    const wb = ev.target.closest && ev.target.closest("[data-waybill-open]");
    if (!wb || !state.params.allowWaybill) return;
    const parts = String(wb.dataset.waybillOpen || "").split(":");
    ev.preventDefault();
    openWaybill(parts[0], Number(parts[1] || 0));
  });
  if (el.waybillClose) el.waybillClose.addEventListener("click", closeWaybill);
  if (el.waybillRemoveMissing) {
    el.waybillRemoveMissing.addEventListener("click", async () => {
      const wbL = waybillLocal;
      const arr = wbL && Array.isArray(wbL.items) ? wbL.items : [];
      const missArts = [...new Set(arr
        .filter((it) => (Number(it.missingQty) || 0) > 0 || !!it.missing)
        .map((it) => String(it.art || "")))];
      if (!missArts.length) { toast("«Не найдено» в этой накладной нет"); return; }
      if (!confirm(`Убрать пометку «не найдено» у ${missArts.length} деталей из накладной «${waybillClientName || waybillClientIdx + 1}»?`)) return;
      let okN = 0, bad = 0;
      for (const art of missArts) {
        try {
          await api(`/api/routes/${encodeURIComponent(waybillRouteId)}/waybill`, {
            method: "POST",
            body: JSON.stringify({ action: "remove-missing", clientIndex: waybillClientIdx, art }),
          });
          okN += 1;
        } catch { bad += 1; }
      }
      toast(bad ? `Убрано ${okN}, ошибок ${bad}` : `Убрано «не найдено»: ${okN}`);
      refreshWaybillFromServer();
      renderWaybill();
    });
  }
  if (el.waybillCleanBtn) {
    el.waybillCleanBtn.addEventListener("click", async () => {
      const wbL = waybillLocal;
      const arr = wbL && Array.isArray(wbL.items) ? wbL.items : [];
      const unscanned = arr.filter((it) => (Number(it && it.scanned) || 0) === 0).length;
      if (!unscanned) { toast("Не собранных позиций нет"); return; }
      const who = waybillClientName || (`Клиент ${waybillClientIdx + 1}`);
      if (!confirm(`Удалить из накладной «${who}» ${unscanned} не собранных позиций (собрано 0 шт: дубли и «не найдено»)?`)) return;
      try {
        const r = await api(`/api/routes/${encodeURIComponent(waybillRouteId)}/waybill/delete-unscanned`, {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx }),
        });
        if (r && r.ok) {
          toast(`Удалено не собранных: ${r.removed}, осталось позиций: ${r.total}`);
        } else {
          toast((r && r.error) || "Ошибка удаления");
        }
      } catch (e) {
        toast((e && e.message) || "Ошибка удаления");
      }
      refreshWaybillFromServer();
      renderWaybill();
    });
  }
  if (el.waybillFile) el.waybillFile.addEventListener("change", uploadWaybill);
  if (el.waybillScanBtn) el.waybillScanBtn.addEventListener("click", scanWaybill);
  if (el.waybillNewBoxBtn) el.waybillNewBoxBtn.addEventListener("click", waybillNewBox);
  if (el.waybillDelBoxBtn) el.waybillDelBoxBtn.addEventListener("click", deleteWaybillBox);
  if (el.boxDetailsClose) el.boxDetailsClose.addEventListener("click", () => { try { el.boxDetailsModal.close(); } catch {} });
  if (el.boxDetailsModal) el.boxDetailsModal.addEventListener("click", (ev) => { if (ev.target === el.boxDetailsModal) { try { el.boxDetailsModal.close(); } catch {} } });

  // ---- Своя авторизация: вход/первый вход (фронт) ----
  let authPickId = null;
  let authPickedName = "";
  async function apiAuth(method, url, body) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json().catch(() => null);
    } catch { return null; }
  }
  // Нативное хранение токена (APK): куки WebView могут очищаться системой,
  // поэтому токен собственной авторизации дублируем в SharedPreferences.
  function nativeGetToken() {
    if (!window.AndroidBridge || typeof window.AndroidBridge.getAuthToken !== "function") return "";
    try { return window.AndroidBridge.getAuthToken() || ""; } catch { return ""; }
  }
  function nativeSetToken(t) {
    if (window.AndroidBridge && typeof window.AndroidBridge.setAuthToken === "function") {
      try { window.AndroidBridge.setAuthToken(String(t || "")); } catch { /* ignore */ }
    }
  }
  function nativeClearToken() {
    if (window.AndroidBridge && typeof window.AndroidBridge.clearAuthToken === "function") {
      try { window.AndroidBridge.clearAuthToken(); } catch { /* ignore */ }
    }
  }
  function authCookieFromToken(t) {
    if (!t || document.cookie.includes("btime_auth=")) return;
    try { document.cookie = `btime_auth=${t}; Path=/; Max-Age=2592000;`; } catch { /* ignore */ }
  }
  function setAuthUserUI(u) {
    if (el.authUserName) el.authUserName.textContent = u.name || "Пользователь";
    if (el.authAvatar) el.authAvatar.textContent = (u.name || "П")[0];
    if (el.authUserChip) el.authUserChip.hidden = false;
    if (el.authBtn) { el.authBtn.hidden = false; el.authBtn.textContent = "Выйти"; }
    window.__isOwnLoggedIn = true;
  }
  async function initAuth() {
    try {
      const hideBoot = () => { const b = document.getElementById("bootCover"); if (b) b.hidden = true; };
      // APK: если кука потерялась, восстанавливаем токен из нативного хранилища.
      authCookieFromToken(nativeGetToken());
      // Уже авторизовались в этой сессии страницы (даже если кука не дожила за
      // шлюзом Вайбкода) — не перепроверяем и не открываем гейт повторно.
      if (window.__ownAuthUser) {
        setAuthUserUI(window.__ownAuthUser);
        if (el.authGate) el.authGate.hidden = true;
        hideBoot();
        return;
      }
      const j = await apiAuth("GET", "/api/auth/me");
      if (j && j.ok && j.user) {
        setAuthUserUI(j.user);
        renderMasqBanner(j.masquerade === true && j.user ? j.user.name : "");
        if (el.authGate) el.authGate.hidden = true;
        hideBoot();
        return;
      }
      // Сессии нет — НЕавторизованный сразу видит окно «Логин/Пароль»
      // (висит экраном входа, а не интерфейс с кнопкой «Войти»).
      if (el.authBtn) { el.authBtn.hidden = false; el.authBtn.textContent = "Войти"; }
      openAuth(true);
      hideBoot();
    } catch { /* без UI не критично */ }
  }
  // Баннер «вход под пользователем»: виден, когда админ имперсонирует сотрудника.
  function renderMasqBanner(name) {
    let elBar = document.getElementById("masqBanner");
    if (!name) { if (elBar) elBar.remove(); return; }
    if (!elBar) {
      elBar = document.createElement("div");
      elBar.id = "masqBanner";
      elBar.className = "masq-banner";
      document.body.insertBefore(elBar, document.body.firstChild);
    }
    elBar.innerHTML = `Вы вошли под пользователем: <b>${escapeHtml(name)}</b>
      <button type="button" class="masq-return" id="masqReturnBtn">Вернуться в свой аккаунт</button>`;
    const b = document.getElementById("masqReturnBtn");
    if (b) b.addEventListener("click", doLogout);
  }
  function showAuthView(view) {
    const login = view === "login";
    if (el.authLoginView) el.authLoginView.hidden = !login;
    if (el.authFirstView) el.authFirstView.hidden = login;
    if (el.authTitle) el.authTitle.textContent = login ? "Вход" : "Первый вход";
    if (el.authHint) el.authHint.textContent = "";
    if (el.authFirstHint) el.authFirstHint.textContent = "";
    authPickId = null;
    if (el.authResults) el.authResults.innerHTML = "";
    if (el.authSetView) el.authSetView.hidden = true;
    if (el.authLogin) el.authLogin.value = "";
    if (el.authPassword) el.authPassword.value = "";
    if (el.authName) el.authName.value = "";
  }
  function openAuth(forced) {
    if (!el.authGate) return;
    // Только логин/пароль (первый вход по ФИО убран).
    showAuthView("login");
    el.authGate.hidden = false;
    if (el.authClose) el.authClose.hidden = !!forced;
    if (el.authLogin) setTimeout(() => { try { el.authLogin.focus(); } catch {} }, 50);
  }
  async function doLogin() {
    const login = el.authLogin ? el.authLogin.value.trim() : "";
    const pass = el.authPassword ? el.authPassword.value : "";
    if (!login || !pass) { if (el.authHint) el.authHint.textContent = "Введите логин и пароль"; return; }
    let j = null;
    try { j = await apiAuth("POST", "/api/auth/login", { login, password: pass }); }
    catch (e) { console.error("[auth] login error:", e); }
    console.log("[auth] login result:", j);
    if (j && j.ok && j.user) {
      toast("Вы вошли");
      try { localStorage.setItem("biotime_firstlogin_done", "1"); } catch {}
      nativeSetToken(j.token); authCookieFromToken(j.token);
      window.__ownAuthUser = j.user;
      setAuthUserUI(j.user);
      if (el.authGate) el.authGate.hidden = true;
      if (el.authClose) el.authClose.hidden = false;
      // Применяем роль полностью: автоматическая перезагрузка страницы (без неё
      // вкладки/разделы применяются только при ручном обновлении). Идём на reload,
      // т.к. шлюз выключен и кука SameSite=None теперь переживает перезагрузку.
      setTimeout(() => location.reload(), 350);
        return;
    }
    const msg = (j && j.error) || "Не удалось войти (проверьте сеть)";
    if (el.authHint) el.authHint.textContent = msg;
    toast(msg);
  }
  async function firstLoginFind() {
    const name = el.authName ? el.authName.value.trim() : "";
    if (!name) { if (el.authFirstHint) el.authFirstHint.textContent = "Введите имя или фамилию"; return; }
    const j = await apiAuth("POST", "/api/auth/find-by-name", { name });
    const list = (j && j.users) || [];
    if (!el.authResults) return;
    if (!list.length) { el.authResults.innerHTML = '<div class="empty-hint">Не найдено — проверьте имя/фамилию.</div>'; return; }
    el.authResults.innerHTML = list.map((u) => `
      <button type="button" class="mini-btn route-confirm-ok auth-result" data-id="${escapeHtml(u.id)}"
        data-name="${escapeHtml(u.name)}" data-has="${u.hasCreds ? "1" : "0"}" style="display:block;margin:4px 0;text-align:left">
        ${escapeHtml(u.name)}${u.hasCreds ? " · уже есть вход" : ""}
      </button>`).join("");
    el.authResults.querySelectorAll(".auth-result").forEach((b) => {
      b.addEventListener("click", () => pickAuthResult(b.dataset.id, b.dataset.name, b.dataset.has === "1"));
    });
  }
  const authTranslit = { "а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"c","ч":"ch","ш":"sh","щ":"sch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya" };
  function translitLogin(name) {
    const s = String(name || "").toLowerCase().replace(/[^a-zа-яё\s]/gi, " ");
    return s.split("").map((ch) => authTranslit[ch] || (ch === " " ? "." : ch)).join("")
      .replace(/\.+/g, ".").replace(/^\.|\.$/g, "").slice(0, 32) || "user";
  }
  function pickAuthResult(id, name, has) {
    if (has) { if (el.authFirstHint) el.authFirstHint.textContent = "У этого пользователя уже есть вход — используйте «Вход» по логину/паролю."; return; }
    authPickId = String(id);
    authPickedName = String(name || "");
    if (el.authNewLogin) { el.authNewLogin.value = translitLogin(name); }
    if (el.authNewPass) el.authNewPass.value = "";
    if (el.authSetView) el.authSetView.hidden = false;
    if (el.authFirstHint) el.authFirstHint.textContent = "Выбрано: " + name + ". Придумайте логин и пароль (мин. 8 символов).";
  }
  async function doSetCreds() {
    const login = el.authNewLogin ? el.authNewLogin.value.trim() : "";
    const pass = el.authNewPass ? el.authNewPass.value : "";
    if (!authPickId || !login || pass.length < 8) { if (el.authFirstHint) el.authFirstHint.textContent = "Укажите логин и пароль (мин. 8 символов)."; return; }
    const j = await apiAuth("POST", "/api/auth/set-credentials", { userId: authPickId, login, password: pass });
    if (j && j.ok) {
      try { localStorage.setItem("biotime_firstlogin_done", "1"); } catch {}
      nativeSetToken(j.token); authCookieFromToken(j.token);
      window.__ownAuthUser = { id: authPickId, name: authPickedName || "Пользователь", role: "MEMBER" };
      if (el.authGate) el.authGate.hidden = true;
      toast("Учётные данные сохранены — вы вошли");
      setAuthUserUI(window.__ownAuthUser);
      if (el.authClose) el.authClose.hidden = false;
      setTimeout(() => location.reload(), 350);
      return;
    }
    if (el.authFirstHint) el.authFirstHint.textContent = (j && j.error) || "Не удалось сохранить";
  }
  async function doLogout() {
    await apiAuth("POST", "/api/auth/logout");
    nativeClearToken();
    if (el.authGate) el.authGate.hidden = true;
    window.__isOwnLoggedIn = false;
    if (el.authUserChip) el.authUserChip.hidden = true;
    if (el.authBtn) { el.authBtn.hidden = false; el.authBtn.textContent = "Войти"; }
    location.reload();
  }
  if (el.authBtn) el.authBtn.addEventListener("click", () => { if (window.__isOwnLoggedIn) doLogout(); else openAuth(false); });
  if (el.authClose) el.authClose.addEventListener("click", () => { if (el.authGate) el.authGate.hidden = true; });
  if (el.authFirstLink) el.authFirstLink.addEventListener("click", () => showAuthView("first"));
  if (el.authBackLogin) el.authBackLogin.addEventListener("click", () => showAuthView("login"));
  if (el.authSubmitBtn) el.authSubmitBtn.addEventListener("click", doLogin);
  if (el.authFindBtn) el.authFindBtn.addEventListener("click", firstLoginFind);
  if (el.authSetBtn) el.authSetBtn.addEventListener("click", doSetCreds);
  if (el.authPassword) el.authPassword.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doLogin(); } });
  if (el.authName) el.authName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); firstLoginFind(); } });
  initAuth();

  // ---- Смена собственного пароля ----
  async function changePassword() {
    const cur = el.cpCurrent ? el.cpCurrent.value : "";
    const nw = el.cpNew ? el.cpNew.value : "";
    const hint = el.cpHint;
    if (!cur || !nw) { if (hint) hint.textContent = "Введите текущий и новый пароль"; return; }
    const j = await apiAuth("POST", "/api/auth/change-password", { currentPassword: cur, newPassword: nw });
    if (j && j.ok) {
      if (hint) { hint.textContent = "Пароль изменён"; hint.className = "auth-hint ok"; }
      toast("Пароль изменён");
      if (el.cpCurrent) el.cpCurrent.value = "";
      if (el.cpNew) el.cpNew.value = "";
      return;
    }
    if (hint) { hint.textContent = (j && j.error) || "Не удалось изменить пароль"; hint.className = "auth-hint"; }
    toast((j && j.error) || "Не удалось изменить пароль");
  }
  if (el.cpSubmit) el.cpSubmit.addEventListener("click", changePassword);
  if (el.cpNew) el.cpNew.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); changePassword(); } });

  // ---- Админ: учётные записи сотрудников (логин/пароль) ----
  function ensureAdminUsersUI() {
    // Панель «Учётные записи» теперь — вкладка настроек (index.html),
    // здесь просто подключаем кнопку загрузки списка.
    const loadBtn = document.getElementById("adminUsersLoad");
    if (loadBtn && !loadBtn.__wired) {
      loadBtn.__wired = true;
      loadBtn.addEventListener("click", loadAdminUsers);
    }
  }
  function updateAdminUsersVisibility() {
    // Вкладкой «Учётные записи» управляет стандартный switchAdminSub (админ-панель
    // доступна только админам). Права пользователей не меняются.
    return;
  }
  async function loadAdminUsers() {
    const list = document.getElementById("adminUsersList");
    if (!list) return;
    const j = await apiAuth("GET", "/api/admin/users");
    if (!j || !j.ok) { list.innerHTML = '<div class="empty-hint">Нет доступа к учётным записям (нужен админ).</div>'; return; }
    const ownerId = j.ownerId;
    // Главному админу менять учётку может только он сам.
    const meRoot = window.__ownAuthUser && String(window.__ownAuthUser.id) === String(ownerId);
    function rowHtml(u) {
      const isOwner = String(u.id) === String(ownerId);
      const canEdit = isOwner ? !!meRoot : true;
      const name = escapeHtml(u.name) + (isOwner ? ' <span class="acct-owner-badge">главный админ</span>' : "");
      return `<tr data-id="${escapeHtml(u.id)}"${isOwner ? ' class="acct-owner-row"' : ""}>
        <td class="acct-name">${name}</td>
        <td><input class="text-input au-login" value="${escapeHtml(u.login || "")}" placeholder="логин" ${canEdit ? "" : "disabled"} /></td>
        <td><input class="text-input au-pass" type="password" value="" placeholder="${canEdit ? "новый пароль" : "только сам"}" autocomplete="new-password" ${canEdit ? "" : "disabled"} /></td>
        <td><button type="button" class="mini-btn acct-masq" data-masq="${escapeHtml(u.id)}" title="Войти под этим пользователем" ${state.isAdmin ? "" : "hidden"}>→</button></td>
        <td><button type="button" class="mini-btn" data-id="${escapeHtml(u.id)}" ${canEdit ? "" : "disabled"}>${isOwner && !canEdit ? "сам" : "Сохранить"}</button></td>
      </tr>`;
    }
    // Группируем: по группам сотрудников + «Без группы».
    const groups = (j.groups || []);
    const ownedSet = new Set(groups.flatMap((g) => (g.memberIds || []).map(String)));
    const userById = new Map((j.users || []).map((u) => [String(u.id), u]));
    const byGroup = groups
      .map((g) => ({ name: g.name || "Группа", members: (g.memberIds || []).map(String).map((id) => userById.get(id)).filter(Boolean) }))
      .filter((g) => g.members.length);
    const solo = (j.users || []).filter((u) => !ownedSet.has(String(u.id)));
    const head = `<table class="acct-table"><thead><tr><th>Сотрудник</th><th>Логин</th><th>Пароль</th><th>Войти под</th><th></th></tr></thead><tbody>`;
    const grp = (g) => `<tr class="acct-group"><td colspan="4">${escapeHtml(g.name)}<span class="acct-group-count">${g.members.length}</span></td></tr>` + g.members.map(rowHtml).join("");
    const soloHtml = solo.length ? `<tr class="acct-group"><td colspan="4">Без группы<span class="acct-group-count">${solo.length}</span></td></tr>` + solo.map(rowHtml).join("") : "";
    list.innerHTML = head + byGroup.map(grp).join("") + soloHtml + `</tbody></table>`;
    (list.querySelectorAll("button[data-id]") || []).forEach((btn) => {
      btn.addEventListener("click", saveAdminUser);
    });
    (list.querySelectorAll(".acct-masq") || []).forEach((btn) => {
      btn.addEventListener("click", masqueradeUser);
    });
  }
  async function masqueradeUser() {
    if (!state.isAdmin) { toast("Только администратор"); return; }
    const id = this.getAttribute("data-masq");
    const j = await apiAuth("POST", "/api/auth/masquerade", { userId: id });
    if (j && j.ok) { toast("Вошли под пользователем"); setTimeout(() => location.reload(), 400); }
    else toast((j && j.error) || "Ошибка входа под пользователем");
  }
  async function saveAdminUser() {
    if (this.disabled) return;
    const row = this.closest && this.closest("tr");
    const id = this.getAttribute("data-id");
    const login = row ? row.querySelector(".au-login").value.trim() : "";
    const pass = row ? row.querySelector(".au-pass").value : "";
    if (!login) { toast("Укажите логин"); return; }
    if (pass && pass.length < 8) { toast("Пароль не короче 8 символов"); return; }
    const j = await apiAuth("POST", "/api/admin/users/credentials", { userId: id, login, password: pass });
    toast((j && j.error) || "Сохранено");
    if (j && j.ok) loadAdminUsers();
  }
  ensureAdminUsersUI();
  if (el.waybillFinishBtn) {
    el.waybillFinishBtn.addEventListener("click", async () => {
      // Фиксируем «Завершена» на сервере (видно и на других устройствах) и на кнопке.
      waybillFinishedLocal = true;
      try {
        await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/finish", {
          method: "POST",
          body: JSON.stringify({ clientIndex: waybillClientIdx }),
        });
      } catch { /* даже если сеть упала — закрываем окно */ }
      closeWaybill();
      document.querySelectorAll(`[data-waybill-open="${waybillRouteId}:${waybillClientIdx}"]`).forEach((b) => {
        if (b) b.textContent = "Завершена";
      });
      loadShipments();
      toast("Сборка завершена — можно начать отгрузку");
    });
  }
  const bindWaybillListEvents = (container) => {
    container.addEventListener("click", (ev) => {
      const toggle = ev.target.closest && ev.target.closest("#waybillListToggle");
      if (toggle) {
        // Сначала мгновенно показываем окно с «Загрузка…», а тяжёлый список деталей
        // собираем асинхронно — иначе ТСД ждёт построения всего списка в innerHTML
        // и модалка открывается с задержкой.
        waybillListModalHtml = "";
        if (el.waybillListModalBody) el.waybillListModalBody.innerHTML = '<div class="empty-hint">Загрузка…</div>';
        try { el.waybillListModal.showModal(); } catch { /* уже открыта */ }
        const build = () => renderWaybill();
        if (window.requestIdleCallback) { try { requestIdleCallback(build, { timeout: 200 }); } catch { setTimeout(build, 0); } }
        else setTimeout(build, 0);
        return;
      }
      const row = ev.target.closest && ev.target.closest("[data-waybill-index]");
      if (!row) return;
      const i = Number(row.dataset.waybillIndex);
      if (waybillSelected.has(i)) waybillSelected.delete(i); else waybillSelected.add(i);
      renderWaybill();
      focusWaybillScan();
    });
    container.addEventListener("dblclick", (ev) => {
      const row = ev.target.closest && ev.target.closest("[data-waybill-index]");
      if (!row) return;
      const art = String(row.dataset.waybillArt || "");
      waybillSelected.add(Number(row.dataset.waybillIndex));
      if (art) waybillScanDetail(art);
    });
  };
  if (el.waybillList) bindWaybillListEvents(el.waybillList);
  if (el.waybillListModalBody) bindWaybillListEvents(el.waybillListModalBody);
  if (el.waybillListModalClose) {
    el.waybillListModalClose.addEventListener("click", () => { try { el.waybillListModal.close(); } catch {} });
  }
  if (el.waybillListModal) {
    el.waybillListModal.addEventListener("cancel", (e) => { e.preventDefault(); try { el.waybillListModal.close(); } catch {} });
  }
  if (el.waybillQtyAskOk) {
    el.waybillQtyAskOk.addEventListener("click", () => finishWaybillQtyAsk(false));
  }
  if (el.waybillQtyAskCancel) {
    el.waybillQtyAskCancel.addEventListener("click", () => finishWaybillQtyAsk(true));
  }
  if (el.waybillQtyAsk) {
    el.waybillQtyAsk.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finishWaybillQtyAsk(false); }
      else if (e.key === "Escape") { e.preventDefault(); finishWaybillQtyAsk(true); }
    });
  }
  if (el.waybillQtyAskModal) {
    el.waybillQtyAskModal.addEventListener("cancel", (e) => { e.preventDefault(); finishWaybillQtyAsk(true); });
  }
  const sharedQtyResolve = async (cancel) => {
    const art = waybillSharedPendingArt;
    const max = Math.max(1, Number(el.waybillSharedQty && el.waybillSharedQty.max) || 1);
    const entered = Number(el.waybillSharedQty && el.waybillSharedQty.value) || 0;
    if (!cancel && entered > max) {
      // Больше, чем есть: голосом «Фиаско», ничего не засчитываем, ждём верное кол-во.
      setWaybillStatus(`Больше, чем есть: осталось ${max}`);
      playScanFeedback(false, "Это Фиаско Братан ты ввел больше чем есть");
      if (el.waybillSharedQty) { el.waybillSharedQty.value = ""; try { el.waybillSharedQty.focus(); } catch { /* ignore */ } }
      return;
    }
    const qty = Math.min(Math.max(1, entered || 1), max);
    let ok = false;
    try {
      const r = await api("/api/routes/" + encodeURIComponent(waybillRouteId) + "/waybill/qtyresolve", {
        method: "POST",
        body: JSON.stringify({ clientIndex: waybillClientIdx, art, qty, cancel: !!cancel, box: waybillSharedPendingBox || undefined }),
      });
      ok = !!(r && r.ok);
    } catch { /* ignore */ }
    // Сообщаем по факту результата сервера: «Хорошо» только если засчитали; иначе —
    // «Плохо», и окно не закрываем (можно повторить), чтобы не было рассинхрона вида.
    if (!ok && !cancel) {
      setWaybillStatus(`Не получилось засчитать ${art} — повторите количество`);
      playScanFeedback(false, "Это Фиаско Братан не получилось засчитать");
      if (el.waybillSharedQty) { el.waybillSharedQty.value = ""; try { el.waybillSharedQty.focus(); } catch { /* ignore */ } }
      return;
    }
    if (el.waybillSharedQtyModal && el.waybillSharedQtyModal.open) { try { el.waybillSharedQtyModal.close(); } catch { /* ignore */ } }
    waybillSharedPendingArt = "";
    waybillSharedPendingBox = "";
    wbScanBuf = ""; wbScanTs = 0; // сбрасываем буфер сканера от цифр, введённых в модалке
    if (cancel) playScanFeedback(false, "Отменено");
    else playScanFeedback(true, "Хорошо");
    if (el.waybillArtInput) el.waybillArtInput.value = ""; // убираем остаточный код поля
    refreshWaybillFromServer();
    focusWaybillScan();
  };
  if (el.waybillSharedQtyOk) {
    el.waybillSharedQtyOk.addEventListener("click", () => sharedQtyResolve(false));
  }
  if (el.waybillSharedQtyCancel) {
    el.waybillSharedQtyCancel.addEventListener("click", () => sharedQtyResolve(true));
  }
  if (el.waybillSharedQty) {
    el.waybillSharedQty.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sharedQtyResolve(false); }
      else if (e.key === "Escape") { e.preventDefault(); sharedQtyResolve(true); }
    });
  }
  if (el.waybillSharedQtyModal) {
    el.waybillSharedQtyModal.addEventListener("cancel", (e) => { e.preventDefault(); sharedQtyResolve(true); });
  }
  // «Собрать» в модалке: засчитать отмеченные позиции на указанное кол-во.
  if (el.waybillModalAssembleBtn) {
    el.waybillModalAssembleBtn.addEventListener("click", () => {
      const qty = Math.max(1, Number(el.waybillModalQty && el.waybillModalQty.value) || 1);
      const idxs = [...waybillSelected];
      waybillSelected.clear();
      (async () => {
        for (const idx of idxs) {
          const it = waybillLocal && waybillLocal.items[idx];
          if (!it) continue;
          const rem = Math.max(0, (Number(it.qty) || 0) - (Number(it.scanned) || 0));
          if (rem > 0) await waybillScanDetail(String(it.art), Math.min(qty, rem));
        }
        if (el.waybillModalQty) el.waybillModalQty.value = "1";
        renderWaybill();
        focusWaybillScan();
      })();
    });
  }
  if (el.waybillModalMissBtn) {
    el.waybillModalMissBtn.addEventListener("click", () => {
      const idxs = [...waybillSelected];
      waybillSelected.clear();
      for (const idx of idxs) toggleMissingWaybill(idx);
      renderWaybill();
      focusWaybillScan();
    });
  }
  if (el.waybillMissBtn) {
    el.waybillMissBtn.addEventListener("click", () => {
      const idxs = [...waybillSelected];
      waybillSelected.clear();
      for (const idx of idxs) toggleMissingWaybill(idx);
      focusWaybillScan();
    });
  }
  if (el.waybillManualBtn) {
    el.waybillManualBtn.addEventListener("click", () => manualAssembleWaybill());
  }
  if (el.waybillArtInput) {
    el.waybillArtInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); scanWaybill(); }
    });
  }
  // Скан на ТСД БЕЗ фокуса в поле: ловим ввод аппаратного сканера (клавиатурная
  // инжекция) на уровне окна, пока открыта Сборка. Если фокус в поле — поле само
  // обрабатывает Enter (не дублируем).
  let wbScanBuf = "";
  let wbScanTs = 0;
  let wbScanTimer = null;
  const wbSendScan = () => {
    const code = String(wbScanBuf).trim();
    wbScanBuf = ""; wbScanTs = 0;
    if (wbScanTimer) { clearTimeout(wbScanTimer); wbScanTimer = null; }
    if (code) {
      if (el.waybillArtInput) el.waybillArtInput.value = code;
      try { scanWaybill(); } catch (_) { /* не критично */ }
    }
  };
  window.addEventListener("keydown", (ev) => {
    if (!el.waybillModal || !el.waybillModal.open) return;
    // Если открыта модалка ввода количества — цифры и Enter идут в неё, а не в
    // буфер сканера (иначе на ТСД ввод кол-ва дублировался в скан).
    if (el.waybillQtyAskModal && el.waybillQtyAskModal.open) return;
    if (el.waybillSharedQtyModal && el.waybillSharedQtyModal.open) return;
    // В поле (ручной ввод) — не дублируем, оно само вызывает скан по Enter.
    const ae = document.activeElement;
    if (ae && el.waybillArtInput && ae === el.waybillArtInput) return;
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const t = Date.now();
    if (wbScanTs && (t - wbScanTs) > 200) wbScanBuf = "";
    const k = ev.key;
    if (k === "Enter") {
      if (wbScanBuf) { ev.preventDefault(); ev.stopPropagation(); wbSendScan(); }
      else wbScanBuf = "";
      return;
    }
    if (k && k.length === 1) {
      wbScanBuf += k;
      wbScanTs = t;
      if (wbScanTimer) clearTimeout(wbScanTimer);
      wbScanTimer = setTimeout(wbSendScan, 300);
    } else {
      wbScanBuf = "";
    }
  }, true);
  if (el.waybillModal) {
    el.waybillModal.addEventListener("cancel", (e) => { e.preventDefault(); closeWaybill(); });
  }
  // ----- Актная запись: показываем, кем сервер видит вошедшего -----
  function openAccountModal() {
    const d = (state.me && state.me.diag) || {};
    // «Сменить пароль» всегда доступно в личном кабинете (сервер сам определит
    // аккаунт по текущей личности и проверит, задана ли учётка).
    if (el.cpBox) { el.cpBox.hidden = false; }
    if (el.cpCurrent) el.cpCurrent.value = "";
    if (el.cpNew) el.cpNew.value = "";
    if (el.cpHint) el.cpHint.textContent = "";
    el.acctName.textContent = state.me ? (state.me.name || "—") : "—";
    el.acctId.textContent = d.id != null ? String(d.id) : "—";
    el.acctIdKind.textContent = d.idKind ? String(d.idKind) : "—";
    const roleLabel = d.role === "ADMIN" ? "ADMIN (администратор)" : d.role === "MEMBER" ? "MEMBER (сотрудник)" : String(d.role || "—");
    el.acctRole.textContent = roleLabel;
    el.acctAdmin.textContent = d.isAdmin ? "Да" : "Нет";
    el.acctAdmin.style.color = d.isAdmin ? "var(--ok, #16a34a)" : "var(--danger, #dc2626)";
    // Технические данные (IP-адрес, адрес приложения) показываем только админу.
    if (el.acctAdminRow) el.acctAdminRow.hidden = !d.isAdmin;
    if (el.acctVersionRow) el.acctVersionRow.hidden = !d.isAdmin;
    if (el.acctIpRow) el.acctIpRow.hidden = !d.isAdmin;
    if (el.acctHostRow) el.acctHostRow.hidden = !d.isAdmin;
    if (el.accountLogout) el.accountLogout.hidden = !d.isAdmin;
    // Кнопка диагностики связи с 1С — только админу.
    if (el.onecPingRow) el.onecPingRow.hidden = !d.isAdmin;
    // Поправка времени устройства (компенсация рассинхрона часов ТСД/сканера).
    if (el.acctTzRow && el.acctTzOffset) {
      el.acctTzRow.hidden = !d.isAdmin;
      try { el.acctTzOffset.value = localStorage.getItem("biotime_time_offset_min") || "0"; } catch { /* ignore */ }
    }
    // Диагностические «Логи» — только админу.
    if (el.accountLogBtn) el.accountLogBtn.hidden = !d.isAdmin;
    if (el.acctVersion) {
      // Показываем актуальную версию приложения (единый источник — version.json,
      // отдаёт /api/app/update-info). Если ещё не получена — дозапрашиваем.
      if (appVersionName) {
        el.acctVersion.textContent = appVersionName;
      } else {
        api("/api/app/update-info")
          .then((info) => {
            const vn = info && info.versionName;
            if (!vn || !el.acctVersion) return;
            el.acctVersion.textContent = String(vn).replace(/<[^>]*>/g, "");
          })
          .catch(() => { /* нет сети — версию не показываем */ });
      }
    }
    // Реальный публичный IP сервера. Сервер определяет его через внешний echo-сервис
    // (/api/ip); пока IP не получен (или он недоступен за шлюзом), показываем адрес
    // приложения — host, под которым пользователь открыл его. Так поле никогда не
    // остаётся пустым/прочерком, у пользователя всегда есть полезное значение.
    if (el.acctIp) {
      el.acctIp.textContent = window.location.host || "—";
      api("/api/ip")
        .then((r) => {
          if (el.acctIp && r && r.ip) el.acctIp.textContent = String(r.ip);
        })
        .catch(() => { /* IP недоступен — остаётся адрес приложения */ });
    }
    // Строку «Роль не совпала с администратором портала» и прочие причины фильтрации
    // тоже показывает только админ — обычному пользователю она не нужна.
    if (d.reason && d.isAdmin) {
      el.acctReason.hidden = false;
      el.acctReason.textContent = d.reason;
    } else {
      el.acctReason.hidden = true;
    }
    el.accountModal.showModal();
  }
  el.userChip.addEventListener("click", openAccountModal);
  el.accountClose.addEventListener("click", () => el.accountModal.close());

  // ----- Выход из приложения -----
  // Платформа не даёт приложению принудительно завершить сессию шлюза (cookie
  // _vibe_gw — HttpOnly и управляется только Gateway; отдельного URL разлогина
  // нет). Поэтому «Выйти» — это локальный выход из приложения: очищаем локальное
  // состояние пользователя и показываем экран «Вход в приложение». Кнопка
  // «Войти» возвращает — шлюз сам подтверждает сессию и данные подтянутся заново.
  function showAuthScreen(reason) {
    if (el.authHint && reason) {
      el.authHint.textContent = reason;
    }
    if (el.authScreen) el.authScreen.hidden = false;
    if (el.accountModal && el.accountModal.open) el.accountModal.close();
  }

  function doLogout() {
    // Закрываем все открытые модалки.
    document.querySelectorAll("dialog[open]").forEach((d) => {
      try { d.close(); } catch { /* ignore */ }
    });
    (async () => {
      let restored = false;
      try {
        const j = await apiAuth("POST", "/api/auth/logout");
        restored = !!(j && j.ok && j.restoredAdmin);
      } catch { /* ignore */ }
      if (restored) {
        // Выход «из-под» пользователя: возвращаемся в свой аккаунт администратора.
        toast("Вернулись в свой аккаунт");
        setTimeout(() => location.reload(), 300);
        return;
      }
      // Своя авторизация: выходим из сессии и просим ввести логин/пароль.
      window.__ownAuthUser = null;
      if (typeof nativeClearToken === "function") nativeClearToken();
      state.me = null;
      state.isAdmin = false;
      state.isModerator = false;
      state.isDriver = false;
      if (el.userChip) el.userChip.hidden = true;
      if (el.settingsBtn) el.settingsBtn.classList.add("hidden");
      try {
        localStorage.removeItem("biotime_active_tab");
        localStorage.removeItem("biotime.todayDraft");
        localStorage.removeItem("biotime_collapsed");
      } catch { /* ignore */ }
      if (typeof openAuth === "function") openAuth();
      if (typeof showAuthView === "function") showAuthView("login");
    })();
  }

  if (el.accountLogout) {
    el.accountLogout.addEventListener("click", doLogout);
  }
  if (el.accountReloadBtn) {
    el.accountReloadBtn.addEventListener("click", () => {
      // На ТСД вызываем нативный мост: снимает закреплённый режим и перезагружает
      // WebView. Вне APK — обычная перезагрузка страницы.
      let unfrozen = false;
      if (window.AndroidBridge && typeof window.AndroidBridge.unfreezeApp === "function") {
        try { window.AndroidBridge.unfreezeApp(); unfrozen = true; } catch { /* ignore */ }
      }
      if (el.accountModal && el.accountModal.open) { try { el.accountModal.close(); } catch { /* ignore */ } }
      if (!unfrozen) { try { location.reload(); } catch { /* ignore */ } }
    });
  }
  if (el.accountLogBtn) {
    el.accountLogBtn.addEventListener("click", openAppLogModal);
  }
  if (el.appLogClose) {
    el.appLogClose.addEventListener("click", closeAppLogModal);
  }
  if (el.appLogModal) {
    el.appLogModal.addEventListener("cancel", (e) => { e.preventDefault(); closeAppLogModal(); });
  }
  if (el.appLogCopy) {
    el.appLogCopy.addEventListener("click", copyAppLog);
  }
  if (el.appLogClear) {
    el.appLogClear.addEventListener("click", clearAppLog);
  }
  // Любые непойманные ошибки/отклонённые промисы тоже пишем в журнал — тогда
  // «кнопка молчит» всегда оставляет след на устройстве.
  try {
    window.addEventListener("error", (ev) => {
      logApp("error", "onerror: " + (ev && ev.message ? ev.message : String(ev && ev.error || "?")));
    });
    window.addEventListener("unhandledrejection", (ev) => {
      const r = ev && ev.reason;
      logApp("error", "unhandledrejection: " + (r && r.message ? r.message : String(r)));
    });
  } catch { /* ignore */ }
  if (el.authLoginBtn) {
    // «Войти» — возвращаемся в рабочее состояние. Шлюз сам подтвердит сессию,
    // приложение перечитает данные с сервера (обычная перезагрузка страницы).
    el.authLoginBtn.addEventListener("click", () => location.reload());
  }
  el.adminTabs.querySelectorAll(".atab").forEach((t) => {
    t.addEventListener("click", () => switchAdminSub(t.dataset.sub));
  });
  el.tabs.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      // Вкладка «Отчёты» открывает полноэкранное модальное окно вместо страницы.
      if (t.dataset.tab === "reports") { openReportsModal(); return; }
      if (t.dataset.tab === "sverki") { openSverkiModal(); return; }
      if (t.dataset.tab === "procenka") { openProcenkaModal(); return; }
      if (t.dataset.tab === "parser") { openParserModal(); return; }
      if (t.dataset.tab === "notfound") { openNotfoundModal(); return; }
      if (t.dataset.tab === "calendar") { openSalaryModal(); return; }
      switchTab(t.dataset.tab);
    });
  });
  if (el.scanlogFilters) {
    el.scanlogFilters.querySelectorAll(".scanlog-filter").forEach((btn) => {
      btn.addEventListener("click", () => {
        el.scanlogFilters.querySelectorAll(".scanlog-filter").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        // Вкладка «Сборка» (waybill) показывает только сканы деталей накладной —
        // в неё НЕ попадают погрузка (load) и выгрузка (unload).
        const act = btn.dataset.action;
        // «Не найдено» — отдельная вкладка: та же сборка, но фильтр только по
        // помеченным «не найдено» позициям.
        if (act === "waybill-missing") {
          scanlogFilterAction = "waybill";
          scanlogMissingOnly = true;
        } else {
          scanlogFilterAction = (act === "unload" || act === "waybill") ? act : "load";
          scanlogMissingOnly = false;
        }
        // Показываем дату, соответствующую активной вкладке: «Отгрузка за дату» —
        // во вкладке «Погрузка», «Выгрузка за дату» — во вкладке «Выгрузка».
        if (el.scanlogLoadDateField) el.scanlogLoadDateField.hidden = scanlogFilterAction !== "load";
        if (el.scanlogUnloadDateField) el.scanlogUnloadDateField.hidden = scanlogFilterAction !== "unload";
        if (el.scanlogWaybillDateField) el.scanlogWaybillDateField.hidden = scanlogFilterAction !== "waybill";
        loadScanLog();
      });
    });
  }

  // ---- Отчёт по «не найдено»: детали сборки с изменяемым статусом/комментарием ----
  // Выбранные (галочками) записи «Проблемы склада» для массового удаления (админ).
  let nfSelected = new Set();
  async function renderNotfound() {
    const wrap = el.notfoundTable;
    if (!wrap) return;
    try { window.scrollTo({ top: 0, left: 0, behavior: "auto" }); } catch { /* ignore */ }
    let rows = [];
    let err = "";
    let statusSummary = {};
    try {
      const r = await api("/api/notfound");
      rows = (r && r.rows) || [];
      statusSummary = (r && r.statusSummary) || {};
    } catch (e) { err = (e && e.message) || String(e); }
    // Диагностическая сводка под вкладками: сколько заявок в каждом статусе.
    if (el.nfSummary) {
      const cnt = (labels) => labels.reduce((n, L) => n + (Number(statusSummary[L]) || 0), 0);
      el.nfSummary.innerHTML = "Статусы: " +
        `Новая проблема — ${Number(statusSummary["Новая проблема"]) || 0} · ` +
        `Выполняется — ${Number(statusSummary["Выполняется"]) || 0} · ` +
        `Выполнено — ${Number(statusSummary["Выполнено"]) || 0} · ` +
        `Возвращено — ${Number(statusSummary["Возвращено"]) || 0} · ` +
        `Завершено — ${Number(statusSummary["Завершено"]) || 0}`;
    }
    const q = (el.nfSearch && el.nfSearch.value || "").toLowerCase().trim();
    if (q) rows = rows.filter((x) =>
      String(x.client || "").toLowerCase().includes(q) || String(x.art || "").toLowerCase().includes(q)
    );
    // Статусы: Новая проблема → Выполняется → (Отправить на проверку) Выполнено →
    // (Завершить) Завершено; возврат из проверки/завершения → Возвращено.
    const nfLabel = (s) => (s === "В работе" ? "Выполняется" : (s || "Новая проблема"));
    const nfCls = (s) => ({ "Новая проблема": "new", "Выполняется": "work", "Выполнено": "review", "Завершено": "done", "Возвращено": "ret" }[nfLabel(s)] || "new");
    const nfNextAction = (s) => ({ "Выполняется": "Отправить на проверку", "Выполнено": "Завершить", "Завершено": "Вернуть в работу" }[nfLabel(s)] || "Взять в работу");
    const nfActionResult = (s) => ({ "Выполняется": "Выполнено", "Выполнено": "Завершено", "Завершено": "Возвращено" }[nfLabel(s)] || "Выполняется");
    // Вкладки: «Проблемы» (не Выполнено и не Завершено), «На проверке» (Выполнено), «Завершённые» (Завершено).
    const notfoundView = (typeof state.notfoundView === "string" && state.notfoundView) ? state.notfoundView : "problems";
    if (el.nfTabs) {
      el.nfTabs.querySelectorAll(".nf-tab").forEach((b) => b.classList.toggle("active", b.dataset.nfView === notfoundView));
    }
    rows = rows.filter((x) => {
      const s = nfLabel(x.status);
      if (notfoundView === "review") return s === "Выполнено";
      if (notfoundView === "done") return s === "Завершено";
      return s !== "Выполнено" && s !== "Завершено";
    });
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-hint">Нет заявок в этом разделе.</div>
        <div class="nf-diag" style="margin-top:6px;font-size:12px;opacity:.7;">Диагностика: сервер вернул ${rows.length} строк${err ? " · ошибка: " + escapeHtml(err) : ""}. Если данные есть в журнале «Сборка → Не найдено», а тут 0 — проверьте доступ/эндпоинт (/api/notfound).</div>`;
      return;
    }
    const rowsByKey = new Map(rows.map((r) => [r.key, r]));
    // Ищет накладную маршрута, где у клиента с именем `client` есть артикул `art`
    // с пометкой «не найдено». Нужно, чтобы убрать чужую деталь из накладной клиента.
    const nfFindWaybill = (client, art) => {
      const normName = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
      const want = normName(client);
      for (const rt of (Array.isArray(shipmentsCache) ? shipmentsCache : [])) {
        const cli = rt.clients || [];
        for (let i = 0; i < cli.length; i += 1) {
          const c = cli[i];
          if (!c) continue;
          const name = normName(c.client || c.bundleName || "");
          if (name !== want) continue;
          const wb = rt.waybills && rt.waybills[i];
          const items = wb && Array.isArray(wb.items) ? wb.items : [];
          const hit = items.some((it) =>
            String(it.art || "").trim().toLowerCase() === String(art || "").trim().toLowerCase() &&
            ((Number(it.missingQty) || 0) > 0 || !!it.missing));
          if (hit) return { routeId: rt.id, clientIndex: i };
        }
      }
      return null;
    };
    const canDel = state.isAdmin === true;
    const body = rows.map((r) => {
      const st = nfLabel(r.status);
      const checked = nfSelected.has(r.key) ? " checked" : "";
      return `<tr data-nf-key="${escapeHtml(r.key)}" class="nf-row-click" title="Открыть детали позиции">
        ${canDel ? `<td class="nf-cell-sm nf-check-cell"><input type="checkbox" class="nf-check" data-nf-check="${escapeHtml(r.key)}"${checked} name="nfchk" /></td>` : ""}
        <td class="nf-cell-sm">${escapeHtml(r.date ? fmtDateTimeSec(r.date) : "")}</td>
        <td>${escapeHtml(r.client)}</td>
        <td class="nf-cell-sm"><span class="nf-art">${escapeHtml(r.art)}</span></td>
        <td class="nf-cell-qty"><span class="nf-qty-val">${Number(r.qty) || 0}</span></td>
        <td><span class="nf-status-badge st-${nfCls(st)}">${escapeHtml(st)}</span></td>
      </tr>`;
    }).join("");
    wrap.innerHTML = `<table class="nf-table"><thead><tr>
      ${canDel ? `<th class="nf-check-cell"></th>` : ""}<th>Дата</th><th>Клиент</th><th>Артикул</th><th>Кол-во</th><th>Статус</th>
      </tr></thead><tbody>${body}</tbody></table>`;
    // Клик по строке → модалка с деталями позиции и кнопкой-состоянием.
    wrap.querySelectorAll("tr[data-nf-key]").forEach((row) => {
      row.addEventListener("click", () => {
        const key = row.getAttribute("data-nf-key");
        const r = rowsByKey.get(key);
        if (!r || !el.nfdModal || !el.nfdModalBody) return;
        const renderModal = () => {
          const myName = (state.me && state.me.name) || (staffById(state.me.id) ? staffById(state.me.id).name : "");
          const myComments = r.comments || [];
          const cur = nfLabel(r.status);
          const action = nfNextAction(cur);
          // Кнопки продвижения/возврата статуса:
          // «Взять в работу» (Новая проблема), «Отправить на проверку» (Выполняется),
          // «Завершить» (Выполнено); «Вернуть в работу» — в Выполнено и Завершено.
          const showAction = cur === "Новая проблема" || cur === "Выполняется" || cur === "Выполнено";
          const showReturn = cur === "Выполнено" || cur === "Завершено";
          el.nfdModalBody.innerHTML = `
            <div class="nf-detail-info">
              <div class="nf-detail-row"><span>Дата:</span> ${escapeHtml(r.date ? fmtDateTimeSec(r.date) : "—")}</div>
              <div class="nf-detail-row"><span>Сборщик:</span> ${escapeHtml(r.user || "—")}</div>
              <div class="nf-detail-row"><span>Клиент:</span> ${escapeHtml(r.client)}</div>
              <div class="nf-detail-row"><span>Артикул:</span> ${escapeHtml(r.art)}</div>
              <div class="nf-detail-row"><span>Кол-во:</span> ${Number(r.qty) || 0}</div>
            </div>
            <div class="nf-actions-row">
              ${showAction ? `<button type="button" class="nfd-action-btn" id="nfdActionBtn">${escapeHtml(action)}</button>` : ""}
              ${showReturn ? `<button type="button" class="nfd-action-btn nfd-btn-soft" id="nfdReturnBtn">Вернуть в работу</button>` : ""}
            </div>
            <div class="nf-chat">
              ${myComments.map((c) => `
                <div class="nf-msg">
                  <div class="nf-msg-head"><span class="nf-msg-who">${escapeHtml(c.user || "—")}</span><span class="nf-msg-time">${c.at ? fmtDateTimeSec(c.at) : ""}</span></div>
                  <div class="nf-msg-text">${escapeHtml(c.text)}</div>
                </div>`).join("")}
              <div class="nf-chat-empty"${myComments.length ? ' style="display:none"' : ""}>Комментариев пока нет</div>
            </div>
            <div class="nf-chat-input-row">
              <input class="text-input nf-chat-input" id="nfdChatInput" placeholder="Комментарий..." autocomplete="off" />
              <button type="button" class="nfd-send-btn" id="nfdChatSend">Отправить</button>
            </div>`;
          // Отправка комментария — лента «переписки».
          const sendComment = async () => {
            const inp = el.nfdModalBody.querySelector("#nfdChatInput");
            const text = (inp && inp.value || "").trim();
            if (!text) return;
            await saveNotFound(key, { status: r.status || "Новая проблема", addComment: { text, user: myName || "—" } });
            if (!r.comments) r.comments = [];
            r.comments.push({ text, user: myName || "—", at: Date.now() });
            renderModal();
          };
          const sendBtn = el.nfdModalBody.querySelector("#nfdChatSend");
          if (sendBtn) sendBtn.addEventListener("click", sendComment);
          const ci = el.nfdModalBody.querySelector("#nfdChatInput");
          if (ci) ci.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); sendComment(); } });
          // Кнопка-состояние: взять в работу / отправить на проверку / завершить.
          const ab = el.nfdModalBody.querySelector("#nfdActionBtn");
          if (ab) ab.addEventListener("click", async () => {
            const next = nfActionResult(cur);
            r.status = next;
            await saveNotFound(key, { status: next, comment: r.comment || "" });
            const badge = row.querySelector(".nf-status-badge");
            if (badge) { badge.textContent = nfLabel(next); badge.className = "nf-status-badge st-" + nfCls(next); }
            renderModal();
            renderNotfound();
          });
          // «Вернуть в работу»: возвращаем заявку в «Проблемы» (статус «Возвращено»).
          const rb = el.nfdModalBody.querySelector("#nfdReturnBtn");
          if (rb) rb.addEventListener("click", async () => {
            r.status = "Возвращено";
            await saveNotFound(key, { status: "Возвращено", comment: r.comment || "" });
            const badge = row.querySelector(".nf-status-badge");
            if (badge) { badge.textContent = "Возвращено"; badge.className = "nf-status-badge st-ret"; }
            renderModal();
            renderNotfound();
          });
        };
        renderModal();
        try { el.nfdModal.showModal(); } catch { /* уже открыта */ }
      });
    });
    // Чекбоксы выделения (админ) — вместо кнопки удаления в строке.
    wrap.querySelectorAll("[data-nf-check]").forEach((cb) => {
      cb.addEventListener("click", (ev) => ev.stopPropagation()); // не открывать модалку строки
      cb.addEventListener("change", () => {
        const key = cb.getAttribute("data-nf-check");
        if (!key) return;
        if (cb.checked) nfSelected.add(key); else nfSelected.delete(key);
        if (el.nfDeleteSelected) el.nfDeleteSelected.disabled = nfSelected.size === 0;
      });
    });
    // Вся ячейка галочки — отдельная зона: клик в любом её месте только
    // переключает галочку и НЕ открывает модалку (промах мимо чекбокса больше
    // не разворачивает детали). Сам чекбокс обрабатывается выше.
    wrap.querySelectorAll("td.nf-check-cell").forEach((td) => {
      td.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (ev.target && ev.target.closest && ev.target.closest("input[type=checkbox]")) return;
        const cb = td.querySelector("input[data-nf-check]");
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });
    // Кнопка «Удалить выбранные» в шапке — закреплена, видна админу.
    if (el.nfDeleteSelected) {
      el.nfDeleteSelected.hidden = !canDel;
      el.nfDeleteSelected.disabled = nfSelected.size === 0;
    }
  }
  async function saveNotFound(key, data) {
    try { await api("/api/notfound", { method: "POST", body: JSON.stringify(Object.assign({ key }, data)) }); toast("Сохранено"); }
    catch (e) { toast((e && e.message) || "Ошибка сохранения"); }
  }
  // Логи скана деталей при сборке (вкладка «Логи» у админа): шлём НЕУСПЕШНЫЕ сканы
  // (ok:false), чтобы диспетчер видел, какие коды не находились/не принимались.
  function logBarcodeScan(kind, code, ok, reason, partsticker, art) {
    try {
      api("/api/logs/barcode", { method: "POST", body: JSON.stringify({
        kind: String(kind || "detail"),
        code: String(code || ""),
        ok: !!ok,
        reason: String(reason || ""),
        partsticker: String(partsticker || ""),
        art: String(art || ""),
        client: String(waybillClientName || ""),
        box: String(waybillBox || ""),
        routeId: String(waybillRouteId || ""),
        clientIndex: waybillClientIdx != null ? Number(waybillClientIdx) : null,
      }) }).catch(() => { /* потери лога не критичны */ });
    } catch { /* ignore */ }
  }
  if (el.nfRefresh) el.nfRefresh.addEventListener("click", renderNotfound);
  // Кнопка «Удалить выбранные» в шапке «Проблем» — админ, удаляет выделенные галочками.
  if (el.nfDeleteSelected) {
    el.nfDeleteSelected.addEventListener("click", async () => {
      if (nfSelected.size === 0) return;
      if (!confirm(`Удалить выбранные записи «Проблемы склада» (${nfSelected.size}) из отчёта?`)) return;
      const keys = [...nfSelected];
      let okN = 0, bad = 0;
      for (const key of keys) {
        try { await api("/api/notfound", { method: "POST", body: JSON.stringify({ action: "delete", key }) }); okN += 1; }
        catch { bad += 1; }
      }
      nfSelected.clear();
      toast(bad ? `Удалено ${okN}, ошибок ${bad}` : `Удалено: ${okN}`);
      renderNotfound();
    });
  }
  if (el.nfSearch) el.nfSearch.addEventListener("input", renderNotfound);
  if (el.nfdModalClose && el.nfdModal) {
    el.nfdModalClose.addEventListener("click", () => { try { el.nfdModal.close(); } catch { /* ignore */ } });
  }
  if (el.nfTabs) {
    el.nfTabs.querySelectorAll(".nf-tab").forEach((b) =>
      b.addEventListener("click", () => {
        state.notfoundView = b.getAttribute("data-nf-view");
        renderNotfound();
      }));
  }
  // ---- Журнал: поиск по клиенту и выбор дат ----
  // Вкладки «Погрузка»/«Выгрузка»: поиск по клиенту общий, а дата меняется
  // в зависимости от вкладки — «Отгрузка за дату» во «Погрузке», «Выгрузка за
  // дату» во «Выгрузке». По умолчанию обе даты = сегодня. Всё обновляется
  // автоматически при изменении, без кнопки «Обновить».
  const todayKeyNow = dayKeyOf(Date.now());
  scanlogDateLoad = todayKeyNow;
  scanlogDateUnload = todayKeyNow;
  scanlogDateWaybill = todayKeyNow;
  if (el.scanlogDateLoad) el.scanlogDateLoad.value = todayKeyNow;
  if (el.scanlogDateUnload) el.scanlogDateUnload.value = todayKeyNow;
  if (el.scanlogDateWaybill) el.scanlogDateWaybill.value = todayKeyNow;
  // По умолчанию открыта «Погрузка»; согласуем видимость полей дат.
  if (el.scanlogLoadDateField) el.scanlogLoadDateField.hidden = scanlogFilterAction !== "load";
  if (el.scanlogUnloadDateField) el.scanlogUnloadDateField.hidden = scanlogFilterAction !== "unload";
  if (el.scanlogWaybillDateField) el.scanlogWaybillDateField.hidden = scanlogFilterAction !== "waybill";
  if (el.scanlogDateLoad) {
    el.scanlogDateLoad.addEventListener("change", () => {
      scanlogDateLoad = el.scanlogDateLoad.value || "";
      refreshScanlogView();
    });
  }
  if (el.scanlogDateUnload) {
    el.scanlogDateUnload.addEventListener("change", () => {
      scanlogDateUnload = el.scanlogDateUnload.value || "";
      refreshScanlogView();
    });
  }
  if (el.scanlogDateWaybill) {
    el.scanlogDateWaybill.addEventListener("change", () => {
      scanlogDateWaybill = el.scanlogDateWaybill.value || "";
      refreshScanlogView();
    });
  }
  // Под-вкладки «Все» / «Не собрано» в журнале «Сборка».
  const setScanlogMissingOnly = (on) => {
    scanlogMissingOnly = !!on;
    if (el.scanlogWbAll) el.scanlogWbAll.classList.toggle("is-active", !scanlogMissingOnly);
    if (el.scanlogWbMissing) el.scanlogWbMissing.classList.toggle("is-active", scanlogMissingOnly);
    refreshScanlogView();
  };
  if (el.scanlogWbAll) el.scanlogWbAll.addEventListener("click", () => setScanlogMissingOnly(false));
  if (el.scanlogWbMissing) el.scanlogWbMissing.addEventListener("click", () => setScanlogMissingOnly(true));
  // Дерево «Сборки»: клиент → бокс → детали (раскрытие/сворачивание).
  if (el.scanlogTable) {
    // Фиксируем точку начала нажатия на таблице журнала (и на документе — скролл
    // может начаться и вне таблицы, а click сработать внутри неё).
    const recordStart = (e) => { _wbPointerStart = e && e.clientX != null ? { x: e.clientX, y: e.clientY } : null; };
    el.scanlogTable.addEventListener("pointerdown", recordStart, true);
    document.addEventListener("pointerdown", recordStart, true);
    el.scanlogTable.addEventListener("click", (ev) => {
      // Жест прокрутки: если между нажатием и «кликом» палец сместился — это скролл,
      // а не тап по боксу. Такой «клик» игнорируем, чтобы бокс не схлопывался при
      // попытке прокрутить его содержимое.
      const start = _wbPointerStart;
      _wbPointerStart = null;
      if (start && ev.clientX != null && ev.clientY != null &&
          (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 8)) {
        return;
      }
      // Клик/нажатие ВНУТРИ раскрытых деталей бокса (строки списка деталей, области
      // прокрутки) НЕ должен сворачивать группу: детали рендерятся внутри клиента
      // [data-wlc], но вне заголовка [data-wlb], и клик по ним «всплывал» к клиенту,
      // схлопывая весь блок (и развёрнутый бокс) — казалось, что «сам сворачивается».
      if (ev.target && ev.target.closest && ev.target.closest(".wb-log-details")) return;
      // Бокс проверяем РАНЬШЕ клиента: строка бокса [data-wlb] вложена в клиента
      // [data-wlc], и если проверять клиента первым, closest() находит клиента и
      // клик по боксу сворачивал бы ВЕСЬ блок клиента (дерево: клиент → боксы →
      // детали). От этого боксы «сами сворачивались» при попытке их раскрыть.
      const wlb = ev.target.closest && ev.target.closest("[data-wlb]");
      if (wlb) {
        const next = document.getElementById("wdet-" + wlb.getAttribute("data-wlb"));
        if (next) {
          next.hidden = !next.hidden;
          wlb.querySelector(".wbl-arrow").textContent = next.hidden ? "▸" : "▾";
          // Ключ бокса формируем с клиентом, чтобы одинаковые коды у разных клиентов
          // не перетирали друг друга.
          const clientRow = wlb.closest("[data-wlc]");
          const client = clientRow ? (clientRow.getAttribute("data-wlc-key") || "") : "";
          const box = wlb.getAttribute("data-wlb-key") || "";
          _wblogState.boxes[client + "::" + box] = !next.hidden;
          try { localStorage.setItem("biotime_wblog_open", JSON.stringify(_wblogState)); } catch { /* ignore */ }
        }
        return;
      }
      const wlc = ev.target.closest && ev.target.closest("[data-wlc]");
      if (wlc) {
        const next = document.getElementById("wbox-" + wlc.getAttribute("data-wlc"));
        if (next) {
          next.hidden = !next.hidden;
          wlc.querySelector(".wbl-arrow").textContent = next.hidden ? "▸" : "▾";
          const client = wlc.getAttribute("data-wlc-key") || "";
          _wblogState.clients[client] = !next.hidden;
          try { localStorage.setItem("biotime_wblog_open", JSON.stringify(_wblogState)); } catch { /* ignore */ }
        }
        return;
      }
    });
  }
  if (el.scanlogSearch) {
    let searchTimer = null;
    el.scanlogSearch.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        scanlogSearchText = el.scanlogSearch.value || "";
        refreshScanlogView();
      }, 200);
    });
  }

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
  // Загружаем актуальную версию из /api/app/update-info (единый источник —
  // version.json) в кэш appVersionName для карточки «Учётная запись». Сам номер
  // версии на главной странице больше не показывается (перенесён в профиль).
  function showAppVersion() {
    api("/api/app/update-info")
      .then((info) => {
        const vn = info && info.versionName;
        if (!vn) return;
        appVersionName = String(vn).replace(/<[^>]*>/g, "");
      })
      .catch(() => { /* нет сети — версию не показываем */ });
  }

  // ------------- Init -------------
  // Флаг: приложение стартовало офлайн по кэшу (нет связи с сервером).
  let offlineStarted = false;
  (async function init() {
    try {
      await loadState();
    } catch (e) {
      if (e && e.status === 403) {
        // Доступ к приложению закрыт администратором — таких не пускаем и офлайн.
        el.startBtn.disabled = true;
        el.finishBtn.disabled = true;
        el.statusText.textContent = "Доступ в приложение закрыт администратором";
        state.phase = "idle";
        return;
      }
      // Нет сети (или шлюз недоступен) при старте: если есть удачный кэш
      // состояния — продолжаем с него. Кнопку «Начать» НЕ блокируем: водитель
      // может начать день офлайн, а saveDay уйдёт в офлайн-очередь.
      const cached = loadStateCache();
      if (cached) {
        applyStateCache(cached);
        offlineStarted = true;
      } else {
        el.startBtn.disabled = true;
        el.finishBtn.disabled = true;
        el.statusText.textContent = "Ошибка загрузки";
        state.phase = "idle";
        return;
      }
    }

    // Если старт произошёл офлайн (по кэшу) — показываем внятную метку, чтобы
    // водитель понимал, что данные ещё не синхронизированы.
    if (offlineStarted) {
      showNetBanner("Нет связи — работаем офлайн. Начните день, данные отправятся при появлении сети.");
    }
    // Восстанавливаем открытый таймер из локального кэша, если сервер (из-за
    // сворачивания/потери сети) не вернул его — чтобы «время работы» не обнулялось.
    restoreOpenSegCache();

    // The employee is identified automatically from the platform session — show
    // who is signed in so the auto login is visible and unambiguous.
    if (state.me && state.me.name) {
      el.userName.textContent = state.me.name;
      const initials = state.me.name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
      el.userAvatar.textContent = initials || "?";
      el.userChip.hidden = false;
    }

    // Роль «водитель» одинакова на весь вход — сообщаем нативу однократно, чтобы
    // не-водители ни при каких условиях не запрашивали геолокацию.
    syncDriverToNative();
    // Синхронизируем с нативом фактический статус рабочего дня: если приложение
    // (или процесс Android) перезапустилось посреди дня, трекер геолокации должен
    // снова заработать — натив узнаёт, что день ещё активен. Если день завершён
    // (или не начат) — натив трекер не запускает.
    syncWorkActiveToNative(state.isDriver && (state.phase === "working" || state.phase === "paused"));

    // Show/hide the admin gear based on the real role from the server.
    el.settingsBtn.classList.toggle("hidden", !(state.isAdmin || state.isModerator));
    // A moderator may edit only their own group members' days: hide the admin-only
    // tabs so they cannot reach other management sections. The "Журнал" tab is the
    // exception — a moderator can open it to audit their group members (-only view).
    // Вкладки, видимые ТОЛЬКО администраторам. Модератор входит только в свои
    // группы, поэтому управление группами/окладами/настройками/множителем и
    // списком админов — только для ADMIN. «Оклады» (salaries) уже здесь.
    const adminOnlySubs = ["groups", "salaries", "settings", "admins", "multiplier", "access", "backup"];
    el.adminTabs.querySelectorAll(".atab").forEach((t) => {
      let visible;
      if (t.dataset.sub === "log") visible = state.isAdmin || state.isModerator;
      else if (adminOnlySubs.includes(t.dataset.sub)) visible = state.isAdmin;
      else visible = true;
      t.classList.toggle("hidden", !visible);
    });
    // The "Отчёт" tab is visible to admins and moderators.
    el.tabs.querySelectorAll(".tab.admin-only").forEach((t) =>
      t.classList.toggle("admin-visible",
        (t.id === "logsTab") ? canSeeLogs()
          : (t.id === "reportsTab") ? canSeeReports()
          : (t.id === "sverkiTab") ? canSeeSverki()
          : (t.id === "procenkaTab") ? canSeeProcenka()
          : (t.id === "parserTab") ? canSeeParser()
          : (state.isAdmin || state.isModerator))
    );
    // Вкладка «Отчёт не найдено» дополнительно доступна отмеченным сотрудникам.
    if (el.notfoundTab) el.notfoundTab.classList.toggle("admin-visible", canSeeNotfound());
    // Show/hide the feature tabs (Мои маршруты / Маршрутизация) reactively.
    refreshNavTabs();
    // Предзагружаем Яндекс.Карты заранее (тем, кому доступна карта маршрутов),
    // чтобы вкладка «Трекинг» открывалась сразу, без ожидания скачивания API.
    if (state.isAdmin || state.isModerator) preloadYandexMaps();
    // Роль «Погрузка» — чистый терминал: всегда открывается на «Отгрузке»
    // (единственная доступная вкладка), настройки недоступны, сохранённая
    // вкладка игнорируется.
    if (state.isLoader) {
      switchTab("shipment");
      if (el.settingsBtn) el.settingsBtn.classList.add("hidden");
    } else {
      // Восстанавливаем вкладку, на которой пользователь был до перезагрузки
      // (если сохранённая вкладка доступна его роли — switchTab сам уведёт на
      // «Зарплату»/доступную, если нет).
      try {
        const savedTab = localStorage.getItem("biotime_active_tab");
        if (savedTab) switchTab(savedTab);
      } catch { /* ignore */ }
    }
    render();
    // Перерисовываем уже открытую вкладку из уже полученных данных (без повторных
    // сетевых запросов) сразу и ещё пару раз по мере прихода стартовых ответов
    // портала — данные появляются, как только готовы, без «закрыть и открыть».
    const rerenderActive = () => {
      try {
        if (!el.pageShipment.hidden) renderShipments();
        if (!el.pageDrivers.hidden) renderDriverRoutes(driverRoutesCache);
        if (!el.pageMyRoutes.hidden) renderMyRoutes();
        if (!el.pageScanlog.hidden) refreshScanlogView();
        if (!el.pageCalendar.hidden) renderCalendar();
      } catch { /* не критично */ }
    };
    rerenderActive();
    setTimeout(rerenderActive, 300);
    setTimeout(rerenderActive, 900);
    // Автообновление Android-APK: веб (со сессией) опрашивает сервер и, если там
    // версия выше установленной, показывает окно обновления.
    showAppVersion();
    checkForAppUpdate();
    // ---- Автообновление ВЕБ-версии прямо после деплоя (без перезапуска) ----
    // Сверяем сборку, с которой открыта страница (<meta app-version>), с текущей
    // на сервере каждые ~25 с. Если сервер поднял новую версию (деплой) — сами
    // перезагружаемся и подхватываем новый index.html/app.js/styles.css. Работает
    // и в браузере, и в Electron/APK-оболочке (они грузят тот же адрес). Plain
    // fetch без api(), чтобы фоновая проверка не показывала баннер «нет связи».
    const _loadedWebVersion = (() => {
      const m = document.querySelector('meta[name="app-version"]');
      return m ? String(m.getAttribute("content") || "") : "";
    })();
    let _webRefreshLock = false;
    let _webLastReload = 0;
    const checkWebVersionRefresh = () => {
      if (_webRefreshLock || !_loadedWebVersion) return;
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 8000);
      fetch("/api/app/web-version", {
        signal: c.signal,
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((r) => {
          if (!_webRefreshLock && r && r.ok && r.version != null &&
              String(r.version) !== String(_loadedWebVersion)) {
            // Защита от «цикла перезагрузки»: если недавно уже перезагружались, а
            // версия всё ещё расходится (например, регион/кэш шлюза) — пауза 60 с
            // между срабатываниями, чтобы приложение не моргало бесконечно.
            const now = Date.now();
            if (now - _webLastReload < 60000) return;
            _webLastReload = now;
            _webRefreshLock = true;
            try { toast("Доступна новая версия — обновляю…"); } catch { /* ignore */ }
            setTimeout(() => { try { location.reload(); } catch { _webRefreshLock = false; } }, 800);
          }
        })
        .catch(() => { /* нет сети/шлюз — тихо, следующая проверка позже */ })
        .finally(() => clearTimeout(t));
    };
    checkWebVersionRefresh();
    setInterval(checkWebVersionRefresh, 25000);
    // Обновляемся сразу, когда ТСД/приложение возвращается на передний план
    // (focus/visibility) — не ждём 25 с: вернулся к устройству → подтянулась новая версия.
    const _onFront = () => {
      if (!document.hidden) checkWebVersionRefresh();
    };
    document.addEventListener("visibilitychange", _onFront);
    window.addEventListener("focus", _onFront);
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
    // SSE-синхронизация: мгновенно узнаём об изменении данных (скан на другом
    // устройстве, завершение маршрута) и сразу перечитываем актуальное состояние.
    let sseLast = 0;
    const onSseChanged = () => {
      const now = Date.now();
      if (now - sseLast < 250) return; // схлопываем пачку событий в одно обновление
      sseLast = now;
      if (el.waybillModal && el.waybillModal.open) refreshWaybillFromServer();
      loadShipments();
      // Реальное время в «Логи»: сканер сделал запись → сервер пушит changed →
      // если вкладка «Логи» открыта, перерисовываем список сразу (без ожидания 5 с).
      if (el.scansLogList && el.scansLogList.offsetParent !== null) renderScansLog();
    };
    try {
      if ("EventSource" in window) {
        const es = new EventSource("/api/events");
        es.onmessage = onSseChanged;
        es.onerror = () => { /* SSE упал — опрос остаётся страховкой */ };
      }
    } catch { /* без SSE работаем по опросу */ }
    // Автообновление разделов без ручных кнопок «Обновить». Единый дешёвый
    // таймер раз в 10 секунд тянет данные только для тех разделов, которые
    // сейчас реально открыты (не hidden) и у которых нет собственного таймера
    // (Отгрузка/Мои маршруты/В эфире/Карта обновляются своими интервалами).
    // Так данные на вкладках доставляются живьём без нажатия кнопки, F5
    // и переключения вкладок — и на десктопе, и в мобильном WebView.
    setInterval(() => {
      if (!el.pageDelivery.hidden) loadDeliveries();
      if (!el.pageScanlog.hidden) loadScanLog();
      // «Движение водителей» — подвкладка «Отчёт» раздела «Маршрутизация».
      if (!el.pageDrivers.hidden && el.routesubReport && !el.routesubReport.hidden) loadMotionReport();
      // «Местоположение водителя» — подвкладка маршрутизации: автообновление,
      // чтобы новые точки GPS подтягивались без клика «Показать»/F5.
      if (!el.pageDrivers.hidden && el.routesubLocation && !el.routesubLocation.hidden) loadLocationReport();
      // «Логи 1С» — подвкладка маршрутизации: живое обновление заборов.
      if (!el.pageDrivers.hidden && el.routesub1cLog && !el.routesub1cLog.hidden) loadOnecLog();
    }, 10000);

    // Live ticking counter for the "Таймер" page. The worked/overtime figures are
    // recomputed from an open segment's `start` against Date.now(), so a 1s tick
    // keeps the visible counter moving and makes it jump to the correct value the
    // moment the page is shown again after being collapsed/focused — without
    // waiting for the 8s pollState round-trip. This is what employees experience
    // as "отработанное время перестало считаться при свёртывании": the counter
    // was only repainted inside pollState, which browsers throttle in a
    // background/collapsed tab.
    setInterval(() => { tickTimer(); }, 1000);

    // Periodically re-save the open segment while it runs. A saved open session is
    // what lets the timer survive a page reload and a tab collapse (the worked time
    // is recomputed from `start` on the next open). Relying only on the initial
    // `saveDay` after "Начать работу" and on `persistOnUnload` is fragile on mobile,
    // where `pagehide`/`beforeunload` often never fires when the app is killed, so
    // the open segment may be missing from the server after an abrupt close.
    // Сохраняем чаще (20 с вместо 60 с) и НЕ отбрасываем сохранение при свёрнутом
    // окне: у водителя приложение лежит в фоне/экраны выключены, и частый (пусть
    // даже фоновый) сейв надёжнее сохраняет открытый таймер на сервере. fetch в
    // фоне может быть троттлится, но попытка не помешает; локальный таймер всё
    // равно держится до возврата.
    setInterval(() => {
      if (!openSegment()) return;
      api("/api/day", {
        method: "POST",
        body: JSON.stringify({ key: state.dayKey, segments: state.segments }),
      }).catch(() => {});
    }, 20000);

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
        // Сеть могла вернуться, пока приложение было свёрнуто/в фоне, и событие
        // online (а значит и периодический тик, троттлится в фоне) могло не
        // сработать. При возврате в приложение сразу пробуем отправить
        // накопленные офлайн-действия.
        flushOfflineOps();
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
      // Связь восстановилась — сразу отправляем накопленные офлайн-действия
      // (прибыл на адрес, сдача, перенос, выгрузка, сканы мест и т.д.).
      flushOfflineOps();
    });
    window.addEventListener("offline", () => {
      showNetBanner("Нет подключения к интернету. Проверьте сеть и отключите VPN, если он блокирует приложение.");
      const n = readOfflineOps().length;
      if (n > 0) showOfflineBadge(n);
    });
    // Если localStorage пуст (например, система очистила его при принудительном
    // kill/перезагрузке), пытаемся восстановить очередь из нативного дубля
    // (AndroidBridge → файл на диске в MainActivity.kt). Это страховка, чтобы
    // действия водителя пережили даже такую перезагрузку телефона.
    if (!readOfflineOps().length && nativeSupportsOffline) {
      hydrateOfflineFromNative();
      const n = readOfflineOps().length;
      if (n > 0) showOfflineBadge(n);
    }
    // Первичная отправка накопленной очереди (если приложение открыли, когда связь
    // уже есть) и периодическая повторная попытка на случай, если момент
    // восстановления сети не был пойман событием online.
    setTimeout(() => flushOfflineOps(), 1500);
    setInterval(() => flushOfflineOps(), 20000);
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
      // Восстанавливаем только сегмент ТЕКУЩЕГО дня: переезд вчерашнего
      // незакрытого сегмента в сегодня раздувал «отработано» и держал таймер
      // от вчерашнего start (та же причина, что и в refreshToday/pollState).
      if (hadOpen && dayKeyOf(hadOpen.start) === state.dayKey && !stillOpen) {
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
  // При сворачивании/закрытии страницы форсируем отправку накопленной
  // офлайн-очереди: если связь уже есть, последние действия (прибыл на адрес,
  // сдача, перенос, сканы) уходят на сервер прямо сейчас, а не ждут
  // следующего периодического flush после возврата. Если сети нет — очередь
  // уже лежит в localStorage и переживёт перезапуск/убийство WebView.
  const flushOnUnload = () => { try { flushOfflineOps(); } catch { /* ignore */ } };
  window.addEventListener("pagehide", () => { persistOnUnload(); flushOnUnload(); });
  window.addEventListener("beforeunload", persistOnUnload);
})();

/* ================================================================
   Автообновление веб-версии (мягкое, без внезапного релоада)
   ----------------------------------------------------------------
   Логика: серверная версия (sw.js) обновилась → новый service worker
   установился и активировался (skipWaiting + clients.claim уже в sw.js),
   событие controllerchange уведомляет страницу. В этот момент новый код
   уже лежит в кэше, но документ ещё работает на старом. Показываем
   баннер «Доступно обновление» и перезагружаемся ТОЛЬКО по кнопке
   «Обновить» — чтобы не прерывать сканирование на складе внезапным
   релоадом. «Позже» прячет баннер до следующего определения версии.
   Отдельный самодостаточный блок: не зависит от приложения и не может
   сломать его работу, если SW недоступен.
   ================================================================ */
(function updater() {
  "use strict";

  if (!("serviceWorker" in navigator)) return;

  // Первый заход: controller ещё null. controllerchange при первой установке
  // сработает, но обновлять нечего (мы уже на свежей версии) — пропускаем.
  const hadController = !!navigator.serviceWorker.controller;
  let bannerVisible = false;
  let laterPressed = false;

  function show() {
    if (bannerVisible || laterPressed) return;
    const b = document.getElementById("updBanner");
    if (!b) return;
    b.hidden = false;
    bannerVisible = true;
  }

  function hide() {
    const b = document.getElementById("updBanner");
    if (b) b.hidden = true;
    bannerVisible = false;
  }

  document.addEventListener("DOMContentLoaded", function () {
    const later = document.getElementById("updLater");
    const apply = document.getElementById("updApply");
    if (later) {
      later.addEventListener("click", function () {
        laterPressed = true;
        hide();
      });
    }
    if (apply) {
      apply.addEventListener("click", function () {
        // Принудительно пропускаем кэш, чтобы после релоада точно пришёл новый код.
        location.reload();
      });
    }
    // Автоперезагрузка после деплоя: сервер отдаёт версию сборки, которая меняется
    // при каждом обновлении. Если версия сменилась — обновляем Service Worker и
    // перезагружаем страницу сами, без нажатий (браузер / мобильный / Electron).
    let deployBaseline = null;
    async function pollDeployVersion() {
      let r = null;
      // Тихий опрос (без баннера «Нет связи»): фоновая проверка не должна шуметь.
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
          const resp = await fetch("/api/version", { headers: { "Content-Type": "application/json" }, signal: ctrl.signal });
          if (resp.ok) r = await resp.json();
        } finally { clearTimeout(t); }
      } catch (e) { return; }
      const v = r && r.v;
      if (!v) return;
      if (deployBaseline === null) { deployBaseline = String(v); return; }
      if (String(v) !== deployBaseline) {
        deployBaseline = String(v);
        try {
          if (navigator.serviceWorker) {
            const reg = await navigator.serviceWorker.getRegistration();
            if (reg) await reg.update();
          }
        } catch (e) { /* если SW недоступен — всё равно перезагружаем */ }
        location.reload();
      }
    }
    setTimeout(pollDeployVersion, 4000);   // первый опрос после открытия страницы
    setInterval(pollDeployVersion, 20000); // затем каждые 20 секунд
  });

  // Новый SW активировался и взял контроль. Второй и последующие заходы —
  // это сигнал, что на сервере есть новая версия → показать баннер.
  if (hadController) {
    navigator.serviceWorker.addEventListener("controllerchange", show);
  }

  // Фоновый апдейт: проверяем наличие новой версии раз в 15 минут, чтобы
  // баннер появлялся и у пользователей, которые долго держат вкладку открытой
  // без навигации (controllerchange может не сработать без явной проверки).
  // updatefound + statechange до activated дублирует controllerchange на тот
  // случай, если на первой установке мы его пропустили, а версия изменилась.
  function armUpdater(reg) {
    let wasActivated = reg.active ? reg.active.state === "activated" : false;
    reg.addEventListener("updatefound", function () {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", function () {
        if (nw.state === "activated") {
          wasActivated = true;
          // На первой установке reg.active ещё не было — это и есть новое
          // обновление относительно состояния контроллера, показать баннер.
          if (!hadController && !navigator.serviceWorker.controller) return;
          if (hadController) show();
        }
      });
    });
  }

  navigator.serviceWorker.ready.then(function (reg) {
    armUpdater(reg);
    // Периодически спрашиваем сервер о новой версии sw.js.
    setInterval(function () {
      reg.update().catch(function () { /* нет сети — ничего страшного */ });
    }, 15 * 60 * 1000);
  });
})();
