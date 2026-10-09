(function () {
  "use strict";

  // Встроенный в BIOTIME режим: страница живёт на /sverki/, API-пути дополняем
  // префиксом. При самостоятельном деплое префикс пуст.
  const API_PREFIX = (function () {
    try {
      const src = document.currentScript && document.currentScript.src;
      const p = src ? new URL(src).pathname : "";
      return p.startsWith("/sverki/") ? "/sverki" : "";
    } catch (_e) { return ""; }
  })();

  const $ = (id) => document.getElementById(id);
  const fileAInput = $("fileA");
  const fileBInput = $("fileB");
  const dzA = $("dzA");
  const dzB = $("dzB");
  const cpB = $("cpB");
  const compareBtn = $("compareBtn");
  const errorEl = $("error");
  const stepUpload = $("step-upload");
  const stepResult = $("step-result");

  // Глобальные помощники в области IIFE (защита от «esc is not defined»
  // в отдельных функциях — единый источник экранирования/денег)
  const esc = (s) => escapeHtml(s);

  let state = {
    fileA: null,
    fileB: null,
    cpA: "ПрофМаркетСистем", // файл №1 всегда наш акт (компания фиксирована)
    cpB: "",
    compareData: null,
    aiResult: null, // последний ИИ-разбор (для экспорта)
  };

  // Страховка на старте: модалка ИИ гарантированно скрыта, кнопка заблокирована.
  // ИИ-разбор запускается ТОЛЬКО по клику «✨ ИИ-разбор» после сверки —
  // никогда автоматически при загрузке страницы.
  const startupModal = $("aiModal");
  const startupAiBtn = $("aiTopBtn");
  if (startupModal) startupModal.hidden = true;
  if (startupAiBtn) startupAiBtn.disabled = true;

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = "";
  }

  function setDzFilled(dz, input, labelEl) {
    const has = input.files && input.files[0];
    dz.classList.toggle("filled", !!has);
    if (has) labelEl.textContent = input.files[0].name;
    else labelEl.textContent = "Нажмите, чтобы выбрать";
  }

  fileAInput.addEventListener("change", () => {
    state.fileA = fileAInput.files[0] || null;
    setDzFilled(dzA, fileAInput, $("fileAName"));
    updateCompare();
  });
  fileBInput.addEventListener("change", () => {
    state.fileB = fileBInput.files[0] || null;
    setDzFilled(dzB, fileBInput, $("fileBName"));
    updateCompare();
  });

  function getCounterparties() {
    state.cpA = "ПрофМаркетСистем";
    state.cpB = (cpB.value || "").trim();
  }

  function updateCompare() {
    getCounterparties();
    const ok = !!(state.fileA && state.fileB && state.cpA && state.cpB);
    compareBtn.disabled = !ok;
    clearError();
  }

  // Контрагент (акт №2) обязателен — без него кнопка «Сравнить» заблокирована
  cpB.addEventListener("input", updateCompare);

  // Drag & drop
  [dzA, dzB].forEach((dz, i) => {
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      const f = e.dataTransfer.files[0];
      if (!f) return;
      const input = i === 0 ? fileAInput : fileBInput;
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      if (i === 0) {
        state.fileA = f;
        setDzFilled(dzA, input, $("fileAName"));
      } else {
        state.fileB = f;
        setDzFilled(dzB, input, $("fileBName"));
      }
      updateCompare();
    });
    // клик по зоне открывает input
    dz.addEventListener("click", () => {
      (i === 0 ? fileAInput : fileBInput).click();
    });
  });

  compareBtn.addEventListener("click", async () => {
    clearError();
    compareBtn.disabled = true;
    const original = compareBtn.innerHTML;
    compareBtn.innerHTML =
      '<span class="loading"></span><span class="btn-label">Читаем файлы…</span>';

    const fd = new FormData();
    fd.append("fileA", state.fileA);
    fd.append("fileB", state.fileB);
    getCounterparties();
    fd.append("counterpartyA", state.cpA);
    fd.append("counterpartyB", state.cpB);
    try {
      const res = await fetch((API_PREFIX || "") + "/api/actcompare", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        showError(data.error || "Не удалось выполнить сверку.");
        return;
      }
      state.compareData = data;
      renderActResult(data);
    } catch (e) {
      showError("Ошибка соединения: " + e.message);
    } finally {
      compareBtn.disabled = !(state.fileA && state.fileB);
      compareBtn.innerHTML = original;
    }
  });

  function fmtMoney(n) {
    if (n === null || n === undefined || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("ru-RU", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  function renderActResult(data) {
    stepUpload.hidden = true;
    stepResult.hidden = false;

    const m = data.meta;
    const res = data.result || {};
    const saldo = data.saldo;
    const bl = data.blocks || {};
    const nameA = m.nameA || "Файл №1";
    const nameB = m.nameB || "Файл №2";

    // Статистика
    const grid = $("summaryGrid");
    grid.innerHTML = "";
    const cards = [
      { label: `Операций у ${nameA}`, value: m.opsA, cls: "good" },
      { label: `Операций у ${nameB}`, value: m.opsB, cls: "good" },
      { label: `Только у ${nameA}`, value: (bl.onlyA || []).length, cls: bl.onlyA && bl.onlyA.length ? "danger" : "good" },
      { label: `Только у ${nameB}`, value: (bl.onlyB || []).length, cls: bl.onlyB && bl.onlyB.length ? "danger" : "good" },
    ];
    cards.forEach((c) => {
      const div = document.createElement("div");
      div.className = "stat " + c.cls;
      div.innerHTML = `<div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>`;
      grid.appendChild(div);
    });

    // Структурированный читаемый ИИ-анализ с выделением ключевых мыслей
    $("summaryText").innerHTML = renderAnalysisText(data);
    // Активируем кнопку ИИ-разбора (в шапке) — открывает модальное окно
    enableAiTopBtn();

    // Подробный структурированный разбор
    const list = $("itemsList");
    list.innerHTML = "";

    // ----- Блок 1: Расхождения в операциях -----
    const head1 = document.createElement("div");
    head1.className = "report-section";
    head1.innerHTML = `<h4>1. Расхождения в операциях</h4>`;
    list.appendChild(head1);

    // только в №1
    const onlyA = bl.onlyA || [];
    const secA = document.createElement("div");
    secA.className = "report-sub";
    secA.innerHTML = `<h5>Есть у ${escapeHtml(nameA)}, но отсутствуют у ${escapeHtml(nameB)} (${onlyA.length} шт, на ${fmtMoney(bl.onlyASum)} руб):</h5>`;
    if (onlyA.length) secA.appendChild(opTable(onlyA, "onlyA"));
    else secA.innerHTML += `<p class="good-inline">Расхождений нет ✓</p>`;
    list.appendChild(secA);

    const onlyB = bl.onlyB || [];
    const secB = document.createElement("div");
    secB.className = "report-sub";
    secB.innerHTML = `<h5>Есть у ${escapeHtml(nameB)}, но отсутствуют у ${escapeHtml(nameA)} (${onlyB.length} шт, на ${fmtMoney(bl.onlyBSum)} руб):</h5>`;
    if (onlyB.length) secB.appendChild(opTable(onlyB, "onlyB"));
    else secB.innerHTML += `<p class="good-inline">Расхождений нет ✓</p>`;
    list.appendChild(secB);

    // Разница по суммам
    const diff = bl.sumDiff || [];
    const secD = document.createElement("div");
    secD.className = "report-sub";
    secD.innerHTML = `<h5>Разница по суммам совпадающих операций:</h5>`;
    if (diff.length) {
      const tbl = document.createElement("table");
      tbl.className = "op-table";
      tbl.innerHTML = `<thead><tr><th>Документ</th><th>В ${escapeHtml(nameA)}</th><th>В ${escapeHtml(nameB)}</th><th>Разница</th></tr></thead><tbody></tbody>`;
      const tb = tbl.querySelector("tbody");
      diff.forEach((d) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${escapeHtml(d.docA || d.key)}</td>
          <td>${fmtMoney(d.aSum)}</td>
          <td>${fmtMoney(d.bSum)}</td>
          <td class="warn">${fmtMoney(d.diff)}</td>`;
        tb.appendChild(tr);
      });
      secD.appendChild(tbl);
    } else {
      secD.innerHTML += `<p class="good-inline">Все совпадающие операции сходятся по суммам ✓</p>`;
    }
    list.appendChild(secD);

    // ----- Блок 2: Сравнение конечного сальдо -----
    const head2 = document.createElement("div");
    head2.className = "report-section";
    head2.innerHTML = `<h4>2. Сравнение конечного сальдо</h4>`;
    list.appendChild(head2);
    const secSal = document.createElement("div");
    secSal.className = "report-sub";
    secSal.innerHTML = `
      <div class="saldo-row">
        <div class="saldo-card"><span class="saldo-label">По данным</span><span class="saldo-name">${escapeHtml(nameA)}</span><span class="saldo-val">${fmtMoney(bl.saldoA)} руб</span></div>
        <div class="saldo-card"><span class="saldo-label">По данным</span><span class="saldo-name">${escapeHtml(nameB)}</span><span class="saldo-val">${fmtMoney(bl.saldoB)} руб</span></div>
      </div>`;
    list.appendChild(secSal);

    // ----- Блок 3: В чью пользу разница -----
    const head3 = document.createElement("div");
    head3.className = "report-section";
    head3.innerHTML = `<h4>3. В чью пользу разница и на какую сумму</h4>`;
    list.appendChild(head3);
    const secFav = document.createElement("div");
    secFav.className = "report-sub favor-box";
    if (bl.saldoDiff === null || !bl.saldoDiff) {
      secFav.innerHTML = `<p class="good-inline">Сальдо сходится — расхождений по итогу нет ✓</p>`;
    } else {
      const richer = bl.favorSide === "A" ? nameA : bl.favorSide === "B" ? nameB : "";
      secFav.innerHTML = `
        <p>Разница сальдо: <strong>${fmtMoney(bl.saldoDiff)} руб</strong></p>
        <p>${fmtMoney(bl.saldoA)} − ${fmtMoney(bl.saldoB)} = <strong>${fmtMoney(bl.saldoDiff)} руб</strong></p>
        <p class="favor-line">Разница в пользу <strong>${escapeHtml(richer)}</strong> — ${escapeHtml(richer)} показывает задолженность на <strong>${fmtMoney(bl.saldoDiff)} руб</strong> больше.</p>
        <p class="hint-line">Для уточнения причин разницы требуется проверить непарные документы и обороты у обеих сторон.</p>`;
    }
    list.appendChild(secFav);

    stepResult.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ── ИИ-разбор в модальном окне ───────────────────────────────────
  // Кнопка «✨ ИИ-разбор» живёт в шапке страницы и открывает модалку.
  // Ключ остаётся на сервере; в браузер уходит только текст разбора.

  const aiResultBtn = $("aiResultBtn");
  const aiModal = $("aiModal");
  const aiModalResult = $("aiModalResult");
  const aiModalError = $("aiModalError");
  const aiModalLoading = $("aiModalLoading");
  const aiModalBalance = $("aiModalBalance");
  const aiModalMeta = $("aiModalMeta");
  let aiCompareData = null; // данные последней сверки для кнопки

  // При загрузке страницы покажем баланс (если ключ задан)
  fetchBalance(aiModalBalance);

  function enableAiTopBtn() {
    aiCompareData = state.compareData;
    if (aiResultBtn) aiResultBtn.disabled = !aiCompareData;
    // показываем баланс в кнопке-миниатюре
    fetchBalance(aiModalBalance, true);
  }

  if (aiResultBtn) {
    aiResultBtn.addEventListener("click", () => {
      if (!aiCompareData) return;
      openAiModal();
    });
  }

  $("aiModalClose").addEventListener("click", closeAiModal);
  aiModal.addEventListener("click", (e) => {
    if (e.target === aiModal) closeAiModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !aiModal.hidden) closeAiModal();
  });

  function openAiModal() {
    aiModal.hidden = false;
    document.body.style.overflow = "hidden";
    resetAiModalState();
    fetchBalance(aiModalBalance); // обновляем баланс при открытии
    runAiAnalysis();
  }

  function closeAiModal() {
    aiModal.hidden = true;
    document.body.style.overflow = "";
  }

  function resetAiModalState() {
    aiModalResult.hidden = true;
    aiModalResult.innerHTML = "";
    aiModalError.hidden = true;
    aiModalError.textContent = "";
    aiModalLoading.hidden = false;
    aiModalMeta.textContent = "";
    setStage(0, "Анализируем документы…");
  }

  // Переключение стадии разбора: 0 — считаем, 1 — ищем причины, 2 — решение
  let stageTimer = null;
  function setStage(n, title) {
    const titleEl = $("aiStageTitle");
    const stepsEl = $("aiStageSteps");
    if (titleEl) titleEl.textContent = title;
    if (stepsEl) {
      const spans = stepsEl.querySelectorAll(".st");
      spans.forEach((el, i) => {
        el.classList.remove("done", "active");
        if (i < n) el.classList.add("done");
        else if (i === n) el.classList.add("active");
      });
    }
  }

  async function runAiAnalysis() {
    resetAiModalState();
    const data = aiCompareData;
    setStage(0, "Считаем расхождения…");
    // эмулируем смену стадий, пока идёт запрос (сервер отвечает быстро/долго)
    clearTimeout(stageTimer);
    stageTimer = setTimeout(() => setStage(1, "Ищем причины…"), 1200);
    stageTimer = setTimeout(() => setStage(2, "Формируем решение…"), 3000);
    // Таймаут запроса: если DeepSeek долго не отвечает — показываем понятную
    // ошибку вместо бесконечного «Формируем решение…»
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch((API_PREFIX || "") + "/api/ai-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: data.blocks || {}, meta: data.meta || {} }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const j = await res.json().catch(() => null);
      if (!j || !j.ok) {
        showAiError((j && j.error) || "Не удалось выполнить ИИ-разбор.");
        return;
      }
      let meta = "";
      if (j.tokensUsed) meta += `Расход: ${Number(j.tokensUsed).toLocaleString("ru-RU")} токенов`;
      if (j.cached) meta += (meta ? " · " : "") + "из кэша (повторно не оплачено)";
      aiModalMeta.textContent = meta;

      const parsed = tryParseJson(j.text);
      if (parsed && typeof parsed === "object") {
        aiModalResult.innerHTML = renderAiJson(parsed, data.blocks || {}, data.meta || {});
        setLastAi(parsed);
      } else {
        aiModalResult.innerHTML = formatAiText(j.text || "");
        setLastAi(null);
      }
      aiModalResult.hidden = false;
      // Запускаем чат-сессию по этой сверке (для уточняющих вопросов)
      startChatSession(data);
    } catch (e) {
      if (e && e.name === "AbortError") {
        showAiError("ИИ не ответил за отведённое время. Попробуйте ещё раз — возможно, DeepSeek временно перегружен.");
      } else {
        showAiError("Ошибка соединения: " + e.message);
      }
    } finally {
      clearTimeout(timer);
      aiModalLoading.hidden = true;
      clearTimeout(stageTimer);
    }
  }

  // Текущий ответ ИИ (для кнопок «Скачать» / «Копировать вопросы»)
  let lastAiJson = null;

  function setLastAi(json) {
    lastAiJson = json || null;
    state.aiResult = json || null;
    const copyBtn = $("aiCopyAsk");
    const dlBtn = $("aiDownload");
    const emailBtn = $("aiEmail");
    if (copyBtn) copyBtn.disabled = !(json && Array.isArray(json.askCounterparty) && json.askCounterparty.length);
    if (dlBtn) dlBtn.disabled = !json;
    if (emailBtn) emailBtn.disabled = !json;
  }

  // Скачивание разбора текстом (.txt) — готовый документ для менеджера/бухгалтера
  function downloadAnalysis() {
    if (!lastAiJson || !aiCompareData) return;
    const btn = $("aiDownload");
    const oldText = btn ? btn.textContent : "";
    if (btn) btn.textContent = "Формируем…";
    // POST через скрытую форму в новую вкладку: сервер вернёт Content-Disposition:
    // attachment → браузер сам скачает файл, без blob-перехвата и «перекидывания».
    try {
      const form = $("aiDownloadForm");
      const input = $("aiDownloadPayload");
      if (!form || !input) {
        if (btn) btn.textContent = "Ошибка";
        return;
      }
      input.value = JSON.stringify({
        blocks: aiCompareData.blocks || {},
        meta: aiCompareData.meta || {},
        ai: lastAiJson,
      });
      form.submit();
    } catch (e) {
      if (btn) btn.textContent = "Ошибка";
    } finally {
      setTimeout(() => {
        if (btn) btn.textContent = oldText;
      }, 800);
    }
  }

  // Копирование вопросов контрагенту в буфер обмена
  function copyAskCounterparty() {
    if (!lastAiJson || !Array.isArray(lastAiJson.askCounterparty)) return;
    const txt = lastAiJson.askCounterparty.map((q, i) => `${i + 1}. ${strip(q)}`).join("\n");
    navigator.clipboard
      .writeText(txt)
      .then(() => {
        const btn = $("aiCopyAsk");
        if (btn) {
          const old = btn.textContent;
          btn.textContent = "✓ Скопировано";
          setTimeout(() => (btn.textContent = old), 1800);
        }
      })
      .catch(() => {});
  }

  // Скопировать готовое письмо контрагенту (объяснение + вопросы)
  function copyEmailCounterparty() {
    if (!lastAiJson || !aiCompareData) return;
    const r = lastAiJson;
    const meta = (aiCompareData.meta || {});
    const nameA = meta.nameA || "Сторона 1";
    const nameB = meta.nameB || "Сторона 2";
    const blocks = aiCompareData.blocks || {};
    const onlyA = blocks.onlyA || [];
    const onlyB = blocks.onlyB || [];
    const lines = [];
    lines.push("Добрый день!");
    lines.push("");
    lines.push(`При проведении сверки взаиморасчётов между «${nameA}» и «${nameB}» были выявлены расхождения. Просим вас проверить по нашей документации следующие операции:`);
    if (onlyA.length || onlyB.length) {
      lines.push("");
      // Группируем по сторонам: документы, которые есть у nameA (нет у nameB) и наоборот
      if (onlyA.length) {
        lines.push(`В нашем акте (${nameA}) отражены операции, которых нет в вашем акте (${nameB}):`);
        onlyA.forEach((d) => lines.push(`- ${d.doc || d.key || "?"}${d.sumAbs != null ? " на " + fmtMoney(d.sumAbs) + " руб" : ""}`));
        lines.push("");
      }
      if (onlyB.length) {
        lines.push(`В вашем акте (${nameB}) отражены операции, которых нет в нашем акте (${nameA}):`);
        onlyB.forEach((d) => lines.push(`- ${d.doc || d.key || "?"}${d.sumAbs != null ? " на " + fmtMoney(d.sumAbs) + " руб" : ""}`));
        lines.push("");
      }
      lines.push("Будем признательны, если вы проверите и подтвердите отражение указанных документов в вашем учёте либо направите пояснения.");
    }
    if (Array.isArray(r.askCounterparty) && r.askCounterparty.length) {
      lines.push("");
      lines.push("Просим уточнить:");
      r.askCounterparty.forEach((q, i) => lines.push(`${i + 1}. ${strip(q)}`));
    }
    lines.push("");
    lines.push("Будем признательны за прояснение ситуации по перечисленным операциям.");
    const txt = lines.join("\n");
    navigator.clipboard
      .writeText(txt)
      .then(() => {
        const btn = $("aiEmail");
        if (btn) {
          const old = btn.textContent;
          btn.textContent = "✓ Письмо скопировано";
          setTimeout(() => (btn.textContent = old), 1800);
        }
      })
      .catch(() => {});
  }

  // Убрать лишние символы markdown/служебные при экспорте
  function strip(s) {
    return String(s || "")
      .replace(/[*_#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  const copyAskBtn = $("aiCopyAsk");
  if (copyAskBtn) copyAskBtn.addEventListener("click", copyAskCounterparty);
  const emailBtn = $("aiEmail");
  if (emailBtn) emailBtn.addEventListener("click", copyEmailCounterparty);
  const dlBtn = $("aiDownload");
  if (dlBtn) dlBtn.addEventListener("click", downloadAnalysis);

  function showAiError(msg) {
    aiModalError.textContent = msg;
    aiModalError.hidden = false;
  }

  // ── Чат по сверке (только в рамках текущих файлов) ──────────────
  const aiChat = $("aiChat");
  const aiChatLog = $("aiChatLog");
  const aiChatInput = $("aiChatInput");
  const aiChatSend = $("aiChatSend");
  let chatSessionId = null;
  let chatBusy = false;

  function startChatSession(data) {
    // прячем, если пусто
    if (!data || !data.blocks) return;
    fetch((API_PREFIX || "") + "/api/ai-chat/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blocks: data.blocks || {}, meta: data.meta || {} }),
    })
      .then((r) => r.json().catch(() => null))
      .then((j) => {
        if (j && j.ok && j.sessionId) {
          chatSessionId = j.sessionId;
          aiChat.hidden = false;
          aiChatLog.innerHTML = "";
          addChatMsg(
            "assistant",
            "Задавайте вопросы про эту сверку — расхождения, документы, сальдо. На другие темы я не отвечаю."
          );
        }
      })
      .catch(() => {});
  }

  function addChatMsg(role, text) {
    const div = document.createElement("div");
    div.className = "ai-chat-msg " + (role === "user" ? "user" : "assistant");
    div.textContent = text;
    aiChatLog.appendChild(div);
    aiChatLog.scrollTop = aiChatLog.scrollHeight;
  }

  async function sendChat() {
    const q = (aiChatInput.value || "").trim();
    if (!q || !chatSessionId || chatBusy) return;
    chatBusy = true;
    aiChatInput.value = "";
    aiChatSend.disabled = true;
    addChatMsg("user", q);
    addChatMsg("assistant", "…");
    const lastEl = aiChatLog.lastElementChild;
    try {
      const res = await fetch((API_PREFIX || "") + "/api/ai-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: chatSessionId, question: q }),
      });
      const j = await res.json().catch(() => null);
      if (j && j.ok && j.text) {
        lastEl.textContent = j.text;
        if (j.tokensUsed) {
          // обновляем расход в футере
          const prev = aiModalMeta.textContent.replace(/\s*·.*/, "");
          aiModalMeta.textContent = (prev ? prev + " · " : "") + "чат: " + Number(j.tokensUsed).toLocaleString("ru-RU") + " токенов";
        }
      } else {
        // Сервер уже вернул человеческое сообщение об ошибке
        lastEl.textContent = (j && j.error) || "Не удалось получить ответ. Попробуйте ещё раз.";
        lastEl.classList.add("chat-err");
      }
      aiChatLog.scrollTop = aiChatLog.scrollHeight;
    } catch (e) {
      lastEl.textContent = "Ошибка соединения: " + e.message;
      lastEl.classList.add("chat-err");
    } finally {
      chatBusy = false;
      aiChatSend.disabled = false;
      aiChatInput.focus();
    }
  }

  aiChatSend.addEventListener("click", sendChat);
  aiChatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  function tryParseJson(s) {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  // Отрисовка структурированного разбора (JSON от DeepSeek) блоками
  function renderAiJson(r, blocks, meta) {
    const esc = escapeHtml;
    const s = [];
    // Резюме сверху — «в двух словах», чтобы не скроллить весь разбор
    s.push(renderAiSummary(r, blocks || {}, meta || {}));
    // Вывод для директора — без терминов, 2-3 предложения.
    // Фолбэк: если модель не вернула executiveSummary, собираем из verdict+mainReason
    const execText =
      (r.executiveSummary && String(r.executiveSummary).trim()) ||
      buildFallbackExec(r, bl);
    if (execText) {
      s.push(`<div class="ai-card ai-exec"><span class="ai-card-label">Вывод для директора</span><div class="ai-exec-body">${formatAiBlock(execText)}</div></div>`);
    }
    // Вердикт
    if (r.verdict) {
      s.push(`<div class="ai-card verdict"><div class="ai-card-inner">${highlightStrong(esc(r.verdict))}</div></div>`);
    }
    // Уровень риска + главная причина
    if (r.riskLevel || r.mainReason) {
      s.push(`<div class="ai-card">
        ${r.riskLevel ? `<span class="ai-risk-chip risk-${esc(String(r.riskLevel).toLowerCase().replace(/[^a-z0-9-]/g, ""))}">Риск: ${esc(r.riskLevel)}</span><br>` : ""}
        ${r.mainReason ? `<span class="ai-card-label">Главная причина</span><div>${formatAiBlock(String(r.mainReason))}</div>` : ""}
      </div>`);
    }
    // Анализ — структурируем: заголовки, списки, абзацы
    if (r.analysis) {
      s.push(`<div class="ai-card"><span class="ai-card-label">Анализ</span>${formatAiBlock(String(r.analysis))}</div>`);
    }
    // Шаги
    if (Array.isArray(r.steps) && r.steps.length) {
      s.push(`<div class="ai-card"><span class="ai-card-label">Что делать</span>
        <ul class="ai-steps-list">${r.steps.map((st) => `<li>${annotateTerms(highlightStrong(esc(st)))}</li>`).join("")}</ul></div>`);
    }
    // Расхождения и решения (причина + действие по каждому документу)
    if (Array.isArray(r.discrepancies) && r.discrepancies.length) {
      s.push(`<div class="ai-card"><span class="ai-card-label">Расхождения и решения</span>
        <div class="ai-disc-table">
          <div class="ai-disc-row ai-disc-head">
            <span>Документ</span><span>Сумма</span><span>Вероятная причина</span><span>Что сделать</span>
          </div>
          ${r.discrepancies
            .map(
              (d) => `<div class="ai-disc-row">
                <span><b>${esc(d.doc || "—")}</b>${d.side ? `<br><em>${esc(d.side)}</em>` : ""}</span>
                <span>${esc(d.amount != null ? d.amount : "—")}</span>
                <span>${esc(d.reason || "—")}</span>
                <span>${esc(d.action || "—")}</span>
              </div>`
            )
            .join("")}
        </div></div>`);
    }
    // План действий (actionPlan) — что/кто/приоритет/срок
    if (Array.isArray(r.actionPlan) && r.actionPlan.length) {
      const prio = { HIGH: { cls: "hi", label: "HIGH" }, MEDIUM: { cls: "md", label: "MED" }, LOW: { cls: "lo", label: "LOW" } };
      s.push(`<div class="ai-card ai-plan-card"><span class="ai-card-label">План действий</span>
        <div class="ai-plan-list">${r.actionPlan
          .map(
            (p, i) => {
              const pr = prio[String(p.priority || "").toUpperCase()] || prio.MEDIUM;
              return `<div class="ai-plan-item">
                <span class="ai-plan-n">${i + 1}</span>
                <div class="ai-plan-body">
                  <div class="ai-plan-action">${annotateTerms(highlightStrong(esc(p.action || "")))}</div>
                  <div class="ai-plan-meta">
                    <span class="ai-plan-prio ${pr.cls}">${pr.label}</span>
                    ${p.owner ? `<span class="ai-plan-owner">${esc(p.owner)}</span>` : ""}
                    ${p.deadline ? `<span class="ai-plan-deadline">⏱ ${esc(p.deadline)}</span>` : ""}
                  </div>
                </div>
              </div>`;
            }
          )
          .join("")}
        </div></div>`);
    }
    // Последствие (impact), если не урегулировать
    if (r.impact) {
      s.push(`<div class="ai-card ai-impact-card"><span class="ai-card-label">Последствие, если не исправить</span><div>${formatAiBlock(String(r.impact))}</div></div>`);
    }
    // Итоговое решение
    if (r.solution) {
      s.push(`<div class="ai-card ai-solution"><span class="ai-card-label">Решение</span><div class="ai-solution-body">${formatSolution(String(r.solution))}</div></div>`);
    }
    // Предупреждения/риски
    if (Array.isArray(r.warnings) && r.warnings.length) {
      s.push(`<div class="ai-card ai-warn-card"><span class="ai-card-label">⚠ Обратить внимание</span>
        <ul class="ai-steps-list">${r.warnings.map((w) => `<li>${annotateTerms(highlightStrong(esc(w)))}</li>`).join("")}</ul></div>`);
    }
    // Вопросы контрагенту — готовый список уточнений
    if (Array.isArray(r.askCounterparty) && r.askCounterparty.length) {
      s.push(`<div class="ai-card ai-ask-card"><span class="ai-card-label">Что уточнить у контрагента</span>
        <ul class="ai-steps-list">${r.askCounterparty.map((q) => `<li>${annotateTerms(highlightStrong(esc(q)))}</li>`).join("")}</ul></div>`);
    }
    return s.join("");
  }

  // Компактное резюме разбора: общий итог + счётчики (расхождения/шаги/риск).
  function renderAiSummary(r, bl, meta) {
    const esc = escapeHtml;
    const nDisc = Array.isArray(r.discrepancies) ? r.discrepancies.length : 0;
    const nSteps = Array.isArray(r.steps) ? r.steps.length : 0;
    const risk = r.riskLevel || "";
    const riskClass = ("risk-" + String(risk).toLowerCase()).replace(/[^a-z0-9-]/g, "");
    const riskTxt =
      risk === "HIGH" ? "высокий риск" :
      risk === "MEDIUM" ? "средний риск" :
      risk === "LOW" ? "низкий риск" : "риск не определён";

    // Итоговая строка: от «сходится» до «не сходится на N»
    let verdict = "—";
    if (r.verdict) {
      const match = /не сходится:?\s+([^,;.]+)/i.exec(String(r.verdict));
      verdict = match ? "не сходится: " + match[1] : String(r.verdict).slice(0, 90);
    }

    // Мини-прогресс по сторонам (из эвристических blocks)
    let sideBars = "";
    if (bl && typeof bl.opsA === "number" && typeof bl.matched === "number") {
      sideBars = `<div class="ai-summary-sides">
        ${summarySideBar(meta.nameA || "Сторона А", bl.opsA, (bl.onlyA || []).length, bl.matched)}
        ${bl.opsB ? summarySideBar(meta.nameB || "Сторона Б", bl.opsB, (bl.onlyB || []).length, bl.matched) : ""}
      </div>`;
    }

    return `<div class="ai-summary">
      <div class="ai-summary-left">
        <div class="ai-summary-label">Резюме</div>
        <div class="ai-summary-text">${esc(verdict)}</div>
      </div>
      ${sideBars}
      <div class="ai-summary-stats">
        ${nDisc ? `<span class="ai-stat"><b>${nDisc}</b> расхождений</span>` : `<span class="ai-stat ok">✓ сходится</span>`}
        ${nSteps ? `<span class="ai-stat"><b>${nSteps}</b> шагов</span>` : ""}
        <span class="ai-stat ${riskClass}">${esc(riskTxt)}</span>
      </div>
    </div>`;
  }

  // Одна мини-полоса для резюме модалки
  function summarySideBar(name, totalOps, unmatchedCount, matchedCount) {
    if (!totalOps) return "";
    const esc = escapeHtml;
    const matchedN = Math.min(matchedCount, totalOps);
    const unmatchedN = Math.min(unmatchedCount, totalOps - matchedN);
    const pctMatched = Math.round((matchedN / totalOps) * 100);
    const pctUnmatched = 100 - pctMatched;
    return `<div class="ai-sb">
      <div class="ai-sb-top"><span>${esc(name)}</span><span>${totalOps} оп.</span></div>
      <div class="ai-sb-track">
        <div class="ai-sb-fill ok" style="width:${pctMatched}%"></div>
        <div class="ai-sb-fill bad" style="width:${pctUnmatched}%"></div>
      </div>
      <div class="ai-sb-legend"><span class="lg ok">✓ ${matchedN}</span><span class="lg bad">⚠ ${unmatchedN}</span></div>
    </div>`;
  }

  // Сборка «Вывода для директора» без LLM, из уже готовых полей:
  // простыми словами, без бухгалтерских терминов.
  function buildFallbackExec(r, bl) {
    const parts = [];
    if (r.verdict) {
      parts.push(strip(r.verdict).replace(/^По акту сверки\s+/i, "По итогам сверки "));
    }
    if (r.mainReason) {
      // обрезаем главную причину до сути (первое предложение)
      const m = strip(r.mainReason);
      parts.push(m.length > 200 ? m.slice(0, 200) + "…" : m);
    }
    if (Array.isArray(r.steps) && r.steps.length) {
      const first = strip(r.steps[0]);
      parts.push("Первый шаг: " + first);
    }
    if (!parts.length) {
      parts.push("Итоги сверки не получены — проверьте разбор.");
    }
    return parts.join(" ");
  }

  // Оформление блока «Решение»: выделяем номера документов и суммы.
  // Повышаем читаемость: номера — моноширинным синим, суммы — жёлтым.
  function formatSolution(text) {
    // Тот же принцип, что у «Анализа» и «Главной причины»: разбиваем плотный
    // текст на короткие строки/пункты с подсветкой цифр и документов.
    return formatAiBlock(text);
  }

  // Разбивает плотный текст бухгалтерского разбора на ЛЁГКИЕ для чтения
  // строки: предложения с ключевыми парами (сумма/сторона/документ) выносятся
  // отдельными пунктами со значками. Смысл не меняется — меняется подача.
  function formatAiBlock(text) {
    const esc = escapeHtml;
    // подсветка + тултипы терминов в один проход
    const decorate = (html) => annotateTerms(highlightStrong(html));
    const src = String(text || "");
    // 1) Разбиваем на предложения по границам .
    const rawSentences = src
      .split(/(?<=\.)\s+(?=[А-ЯЁA-Z])/)
      .map((s) => s.trim())
      .filter(Boolean);

    const out = [];
    for (const s of rawSentences) {
      const clean = s.replace(/[.]+$/g, "");
      // Короткое (<= 90 символов) — оставляем абзацем
      if (clean.length <= 90 && !/\d.*(?:руб|₽|тыс|тыр)/i.test(clean)) {
        out.push(`<p class="ai-line">${decorate(esc(clean))}</p>`);
        continue;
      }
      // Длинное предложение с цифрами: стараемся разбить по запятым/тире
      const parts = splitSmart(clean);
      if (parts.length > 1) {
        parts.forEach((p, i) => {
          out.push(`<div class="ai-line ai-line-dot"><span class="ai-dot">${i + 1 === parts.length ? "▪" : "•"}</span><span>${decorate(esc(p))}</span></div>`);
        });
      } else {
        out.push(`<p class="ai-line">${decorate(esc(clean))}</p>`);
      }
    }
    return out.join("");

    // Умная нарезка длинного предложения: режем по «;», « — », «: », запятым
    // между цифровыми группами, сохраняя смысловые блоки.
    function splitSmart(str) {
      // сначала по точке с запятой / тире / двоеточию, НО не режем «Заголовок — …»,
      // где слева короткое слово без цифр (например, «Цель — …», «Итог — …»)
      const sep = [];
      const pieces = str.split(/(?<=[;:])\s+/).map((s) => s.trim()).filter(Boolean);
      if (pieces.length > 1) sep.push(...pieces);
      else {
        // вариант с тире: режем только если в обеих частях есть хотя бы одна цифра
        const dashParts = str.split(/\s[—–-]\s/).map((s) => s.trim()).filter(Boolean);
        if (dashParts.length > 1 && dashParts.every((p) => /\d/.test(p))) sep.push(...dashParts);
        else sep.push(str);
      }
      if (sep.length > 1) return sep;
      // иначе по запятым перед смысловыми группами с числами
      const byComma = str.split(/(?<=,\s)(?=\d|[А-ЯЁA-Z])/).map((s) => s.trim()).filter(Boolean);
      return byComma;
    }
  }

  // Глоссарий терминов для всплывающих подсказок (менеджер без бухгалтерского
  // образования наводит на слово — видит объяснение)
  const TERM_GLOSSARY = {
    сальдо: "сколько одна сторона должна другой на конец периода",
    дебет: "приход/поступление по счёту",
    кредит: "отгрузка/расход по счёту",
    обороты: "все движения (документы) за период",
    "непарн": "документы, которые есть только у одной стороны",
    "не парн": null,
    задолженность: "сумма долга одной стороны перед другой",
    "входящее сальдо": "остаток на начало периода",
    "начальное сальдо": "остаток на начало периода",
    "конечное сальдо": "остаток на конец периода",
    коррекция: "исправление/изменение ранее проведённого документа",
    корректировка: "исправление/изменение ранее проведённого документа",
    стоимость: "цена в денежном выражении",
    "инвойс": "счёт-фактура",
    номенклатура: "список товаров/услуг",
  };

  // Превращает найденные термины в <span class="ai-term" data-tip="…">.
  // Применяется к уже экранированному HTML после подсветки.
  function annotateTerms(html) {
    let out = html;
    for (const [word, tip] of Object.entries(TERM_GLOSSARY)) {
      if (!tip) continue;
      // не трогаем то, что уже внутри span-подсветки (документ/сумма)
      const re = new RegExp("(?![^<]*>)(\\b" + word + "\\b(?![^<]*<\\/))", "giu");
      // простая версия: заменяем слово вне тегов
      out = out.replace(
        new RegExp("(?<![A-Za-zА-Яа-яЁё0-9])" + word + "(?![A-Za-zА-Яа-яЁё0-9])", "giu"),
        `<span class="ai-term" data-tip="${esc(tip)}">${word}</span>`
      );
    }
    return out;
  }

  // Универсальная подсветка: оборачивает номера документов (№УТ-3147, PT00057533…)
  // в .ai-docnum и суммы «123 456,78 руб» в .ai-solsum. Применяется к готовому
  // HTML-фрагменту (после структурной разбивки) — поэтому экранирование уже сделано.
  function highlightStrong(html) {
    const esc = escapeHtml;
    // выделяем номера документов (№... / РТ... / УТ... и т.п.)
    let out = html.replace(
      /(№\s*[A-Za-zА-Яа-я0-9-]+)|((?:^|\s)[A-Za-z]{0,4}[-]?[0-9]{4,})/g,
      (m) =>
        m.indexOf("№") === 0
          ? `<span class="ai-docnum">${esc(m.trim())}</span>`
          : `<span class="ai-docnum">\u00a0${esc(m.trim())}</span>`
    );
    // выделяем суммы: 123 456,78 руб
    out = out.replace(
      /(\d[\d\s\u00a0]*,\d{2})\s*руб\.?/g,
      (m) => `<span class="ai-solsum">${esc(m)}</span>`
    );
    return out;
  }

  // Структурированный вывод анализа: секции по **заголовкам**, буллеты,
  // нумерация, абзацы. Сплошной текст от DeepSeek превращаем в блоки.
  function formatAiTextStructured(text) {
    const esc = escapeHtml;
    const lines = String(text)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    const out = [];
    let openList = false;
    let isOrdered = false;
    const closeList = () => {
      if (openList) {
        out.push(isOrdered ? "</ol>" : "</ul>");
        openList = false;
      }
    };

    lines.forEach((line) => {
      // Жирный заголовок: **Что-то** (короткая строка)
      const boldHeader = /^\*\*(.+?)\*\*\s*[:\-—]?\s*$/.exec(line);
      if (boldHeader && boldHeader[1].length < 60) {
        closeList();
        out.push(`<div class="ai-subhead">${esc(boldHeader[1])}</div>`);
        return;
      }
      // Маркированный буллет
      if (/^[-*•]\s+/.test(line)) {
        if (!openList || isOrdered) {
          closeList();
          out.push("<ul class='ai-list'>");
          openList = true;
          isOrdered = false;
        }
        out.push(`<li>${esc(line.replace(/^[-*•]\s+/, ""))}</li>`);
        return;
      }
      // Нумерация "1." / "1)"
      if (/^\d+[.)]\s+/.test(line)) {
        if (!openList || !isOrdered) {
          closeList();
          out.push("<ol class='ai-list'>");
          openList = true;
          isOrdered = true;
        }
        out.push(`<li>${esc(line.replace(/^\d+[.)]\s+/, ""))}</li>`);
        return;
      }
      // Обычный абзац
      closeList();
      out.push(`<p>${esc(line)}</p>`);
    });
    closeList();
    return out.join("");
  }

  // Загрузка остатка баланса у ИИ-провайдера (безопасно: ключ на сервере).
  // soft=true — не пишем «недоступен», если это служебный вывод в кнопке.
  async function fetchBalance(el, soft) {
    try {
      const res = await fetch((API_PREFIX || "") + "/api/ai-balance");
      const j = await res.json().catch(() => null);
      if (j && j.ok && Array.isArray(j.balance) && j.balance.length) {
        const parts = j.balance.map(
          (b) => `${fmtMoney(b.total)} ${b.currency}`
        );
        const low = !!j.balance.find((b) => b.total < 1);
        el.textContent = "Баланс ИИ: " + parts.join(" · ");
        el.classList.toggle("ai-balance-low", low);
      } else if (j && j.keyMissing) {
        el.textContent = "Баланс ИИ: не подключён";
        el.classList.add("ai-balance-low");
      } else if (soft) {
        // служебный блок (кнопка) — не пугаем текстом «недоступен»
        el.textContent = "";
      } else {
        el.textContent = "Баланс ИИ: недоступен";
      }
    } catch (e) {
      if (!soft) el.textContent = "Баланс ИИ: недоступен";
    }
  }

  // Превращаем текст LLM в безопасный HTML: каждый абзац/строка — отдельный
  // блок, маркированные списки — <ul>. Весь контент экранируется.
  function formatAiText(text) {
    const esc = escapeHtml;
    const lines = String(text)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    let html = "";
    let inList = false;
    lines.forEach((line) => {
      if (/^[-*•]\s+/.test(line)) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += `<li>${esc(line.replace(/^[-*•]\s+/, ""))}</li>`;
      } else {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        html += `<p>${esc(line)}</p>`;
      }
    });
    if (inList) html += "</ul>";
    return html;
  }

  // Структурированный читаемый анализ с выделением ключевых мыслей.
  // Строится на локальных эвристиках (данные не покидают сервер):
  // вердикт → причина (разложение разницы) → проверка математики →
  // непарные операции → конкретные шаги для бухгалтера.
  function renderAnalysisText(data) {
    const bl = data.blocks || {};
    const m = data.meta || {};
    const nameA = m.nameA || "Файл №1";
    const nameB = m.nameB || "Файл №2";
    const esc = escapeHtml;

    let h = "";

    // ── 0. «Главное» — простыми словами для менеджера ─────────────────────
    const plain = bl.plain || {};
    const pStatus = plain.status || (bl.saldoDiff ? "warn-ops" : "ok");
    const statusMeta = {
      ok: { cls: "ok", label: "Сверка сошлась", icon: "🟢" },
      "warn-start": { cls: "warn", label: "Есть расхождение", icon: "🔴" },
      "warn-ops": { cls: "warn", label: "Есть расхождение", icon: "🔴" },
    };
    const st = statusMeta[pStatus] || statusMeta["warn-ops"];
    h += `<div class="an-verdict an-${st.cls} an-hero">
      <div class="an-hero-top"><span class="an-hero-icon">${st.icon}</span><span class="an-hero-label">${st.label}</span></div>
      <div class="an-hero-text">${esc(plain.summary || "")}</div>
      ${plain.whoOwes ? `<div class="an-hero-sub">${esc(plain.whoOwes)}</div>` : ""}
    </div>`;

    if (plain.reason || plain.firstAction) {
      h += `<div class="an-block an-plain">
        ${plain.reason ? `<div class="an-row"><span class="an-badge info">⚙️ Причина</span> ${esc(plain.reason)}</div>` : ""}
        ${plain.firstAction ? `<div class="an-row"><span class="an-badge info">👣 Первый шаг</span> ${esc(plain.firstAction)}</div>` : ""}
      </div>`;
    }

    // Числа в «Главном»: сумма совпавших + «кто кому сколько»
    if (bl.matched && bl.matchedSum) {
      const matchedRow = `${bl.matched} из ${bl.opsA + bl.opsB ? (bl.opsA + bl.opsB) / 1 : bl.matched}`;
      h += `<div class="an-nums">
        <div class="an-num"><span>Совпало</span><b>${bl.matched} док.</b><em>на ${fmtMoney(bl.matchedSum)} ₽</em></div>
        <div class="an-num"><span>Расходится</span><b>${bl.onlyASum + bl.onlyBSum ? (bl.onlyA.length + bl.onlyB.length) : 0} док.</b><em>на ${fmtMoney(bl.onlyASum + bl.onlyBSum)} ₽</em></div>
      </div>`;
    }

    // Топ-риск: крупнейшие непарные операции, что проверить первыми
    const topRisks = topDiscrepancies(bl, 3);
    if (topRisks.length) {
      h += `<div class="an-block"><div class="an-head">Топ-риск — что проверить первым</div>
        <div class="an-op-list">${topRisks
          .map(
            (r, i) => `<div class="an-op-item big">
              <span class="an-op-n">${i + 1}</span>
              <span class="an-op-doc"><b>${esc(r.doc || r.key)}</b> · ${esc(r.sideName)} — нет в акте другой стороны<em> · ${esc(r.sideTxt || "")}</em></span>
              <span class="an-op-sum">${fmtMoney(r.sumAbs)} ₽</span>
            </div>`
          )
          .join("")}
        </div></div>`;
    }

    // Вопросы контрагенту (эвристически) — без DeepSeek
    const askH = heuristicAsk(bl, nameA, nameB);
    if (askH.length) {
      h += `<div class="an-block"><div class="an-head">Что спросить у контрагента</div>
        <ul class="ai-steps-list">${askH.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>`;
    }

    // Подробности для бухгалтера — сворачиваемый блок (менеджеру не мешает)
    h += `<details class="an-details"><summary>Подробности для бухгалтера</summary>`;

    // ── 1. Итоговый вердикт ────────────────────────────────────────────────
    const sd = bl.saldoDiff;
    if (sd === null || sd === 0) {
      h += `<div class="an-verdict an-ok">✔ Итог: сальдо сходится — расхождений по балансу нет</div>`;
    } else {
      const favorName = bl.favorSide === "A" ? nameA : bl.favorSide === "B" ? nameB : "";
      h += `<div class="an-verdict an-warn">Разница сальдо <b>${fmtMoney(sd)} руб</b> — сальдо по <b>${esc(favorName)}</b> больше.</div>`;
    }

    const diffEnd = typeof bl.saldoDiffSigned === "number" ? bl.saldoDiffSigned : null;
    const diffStart = typeof bl.saldoStartDiffSigned === "number" ? bl.saldoStartDiffSigned : null;
    const netOps = typeof bl.netOpsDiff === "number" ? bl.netOpsDiff : null;

    // ── 2. Причина: разложение разницы конечного сальдо ───────────────────
    if (diffEnd !== null) {
      h += `<div class="an-block"><div class="an-head">Почему разошлось</div>`;
      if (diffStart !== null) {
        h += `<div class="an-math"><div class="an-math-label">Разница конечных сальдо</div>
          <div class="an-math-line"><span>= разница начальных (прошлый период)</span><b>${fmtMoney(diffStart)} ₽</b></div>
          <div class="an-math-line"><span>+ разница оборотов (текущий период)</span><b>${fmtMoney(netOps)} ₽</b></div>
          <div class="an-math-divider"></div>
          <div class="an-math-line an-math-total"><span>Итоговая разница</span><b>${fmtMoney(diffEnd)} ₽</b></div></div>`;
      } else {
        h += `<div class="an-row">Разница конечных сальдо: <b>${fmtMoney(diffEnd)} ₽</b></div>`;
      }

      // Процентная доля — наглядно видно, что «из прошлого» главенствует
      if (typeof bl.shareStartPct === "number") {
        const shareO = bl.shareOpsPct;
        const same = Math.abs(diffStart || 0) <= 0.005;
        const domTxt = same
          ? `💡 Начальное сальдо сходится — вся разница (100%) образована операциями текущего периода, прошлый период ни при чём.`
          : bl.shareStartPct >= 51
          ? `Из этой суммы <b>${bl.shareStartPct}%</b> даёт расхождение начального сальдо (${fmtMoney(bl.saldoStartDiff)} ₽), ещё <b>${shareO}%</b> — разница оборотов за период.`
          : `Распределение: начальное сальдо — <b>${bl.shareStartPct}%</b>, обороты периода — <b>${shareO}%</b>.`;
        h += `<div class="an-callout">${domTxt}</div>`;
      }
      h += `</div>`;
    }

    // ── 3. Проверка математики сверки ──────────────────────────────────────
    if (netOps !== null) {
      const netB = typeof bl.unmatchedNetSigned === "number" ? bl.unmatchedNetSigned : null;
      if (netB !== null) {
        const isConsistent = Math.abs(netOps - netB) <= 0.06;
        const arrow = fmtMoney(isConsistent ? 0 : netOps - netB);
        h += `<div class="an-block"><div class="an-head">Проверка сверки</div>`;
        if (isConsistent) {
          h += `<div class="an-row an-ok-row">✓ Разница оборотов <b>${fmtMoney(netOps)} ₽</b> объясняется непарными операциями <b>${fmtMoney(netB)} ₽</b> — математика бьётся до копеек, дополнительных скрытых расхождений нет.</div>`;
        } else {
          h += `<div class="an-row an-warn-row">⚠ Разница оборотов ${fmtMoney(netOps)} ₽, но непарные операции дают только ${fmtMoney(netB)} ₽ (невязка ${arrow} ₽). Совпадающие по паре документы могут иметь разные суммы либо где-то потерян документ — проверить вклад ${fmtMoney(Math.abs(arrow))} ₽.</div>`;
        }
        h += `</div>`;
      }
    }

    // ── 4. Непарные операции (что искать) ──────────────────────────────────
    const onlyA = bl.onlyA || [];
    const onlyB = bl.onlyB || [];
    if (onlyA.length || onlyB.length) {
      h += `<div class="an-block"><div class="an-head">1. Расхождения по операциям</div>`;

      // Сводка по совпадающим документам — масштаб сверки
      const matchedCount = bl.matched;
      if (typeof matchedCount === "number") {
        const sumMatched =
          Number(bl.matchedSumA) ||
          Number(bl.matchedSumB) ||
          0;
        h += `<div class="an-row"><span class="an-badge ok">Совпало</span>
          <b>${matchedCount} оп.</b>${
            sumMatched ? ` на <b>${fmtMoney(sumMatched)} ₽</b>` : ""
          } — суммы сходятся ✓</div>`;
      }

      // Непарные операции каждой стороны — наглядным списком
      if (onlyA.length) {
        h += `<div class="an-row"><span class="an-badge bad">Только у ${esc(nameA)}</span>
          <b>${onlyA.length} оп.</b> на <b>${fmtMoney(bl.onlyASum)} ₽</b></div>`;
        h += `<div class="an-op-list">${opListHtml(onlyA, nameA)}</div>`;
      }
      if (onlyB.length) {
        h += `<div class="an-row"><span class="an-badge bad">Только у ${esc(nameB)}</span>
          <b>${onlyB.length} оп.</b> на <b>${fmtMoney(bl.onlyBSum)} ₽</b></div>`;
        h += `<div class="an-op-list">${opListHtml(onlyB, nameB)}</div>`;
      }

      const diffList = bl.sumDiff || [];
      h += diffList.length
        ? `<div class="an-row"><span class="an-badge bad">Разница сумм</span> по совпадающим документам: ${diffList.length}</div>`
        : `<div class="an-row"><span class="an-badge ok">Сходятся</span> суммы по всем совпадающим документам ✓</div>`;
      h += `</div>`;
    }

    // ── 5. Что делать (конкретные шаги) ────────────────────────────────────
    const steps = [];
    if (diffStart !== null && Math.abs(diffStart) > 0.005) {
      steps.push(`Сверить входящие остатки на <b>начало периода</b> с прошлым актом сверки — здесь расхождение ${fmtMoney(bl.saldoStartDiff)} ₽ пришло из прошлого и не связано с операциями за период.`);
    }
    if (onlyA.length || onlyB.length) {
      steps.push(`Разобраться с <b>${onlyA.length + onlyB.length} непарными операциями</b> (${fmtMoney(bl.onlyASum + bl.onlyBSum)} ₽): найти недостающий документ у второй стороны либо уточнить, что за операция.`);
    }
    const sumD = bl.sumDiff || [];
    if (sumD.length) {
      steps.push(`Проверить разные суммы по ${sumD.length} совпадающим документам — возможна частичная оплата или корректировка.`);
    }
    if (typeof bl.unmatchedNetSigned === "number" && netOps !== null && Math.abs(netOps - bl.unmatchedNetSigned) > 0.06) {
      steps.push(`Невязка ${fmtMoney(Math.abs(netOps - bl.unmatchedNetSigned))} ₽ не покрывается непарными операциями — искать пропавший или лишний документ в оборотах.`);
    }
    if (!steps.length) {
      steps.push(`Сальдо сходится — дополнительные действия не требуются.`);
    }
    h += `<div class="an-block"><div class="an-head">Что делать</div>
      <ol class="an-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol></div>`;

    // Словарь терминов (для тех, кто не бухгалтер)
    const tp = (plain.termsPlain || {});
    const termLines = [];
    if (tp.saldo) termLines.push(`<li><b>Сальдо</b> — ${esc(tp.saldo)}</li>`);
    if (tp.debitCredit) termLines.push(`<li><b>Дебет/кредит</b> — ${esc(tp.debitCredit)}</li>`);
    if (tp.unmatched) termLines.push(`<li><b>Непарные операции</b> — ${esc(tp.unmatched)}</li>`);
    if (tp["обороты"]) termLines.push(`<li><b>Обороты</b> — ${esc(tp["обороты"])}</li>`);
    if (termLines.length) {
      h += `<div class="an-terms"><div class="an-head">Термины простыми словами</div><ul>${termLines.join("")}</ul></div>`;
    }

    // Сводка по сторонам — прогресс-бары «совпало vs непарно» для каждой стороны
    const opsA = bl.opsA;
    const opsB = bl.opsB;
    const matchedN = bl.matched;
    if ((typeof opsA === "number" || typeof opsB === "number") && typeof matchedN === "number") {
      h += `<div class="an-block an-sides"><div class="an-head">Сверка по сторонам</div>`;
      h += sideBar(nameA, opsA, onlyA.length, matchedN, bl.matchedSum, bl.onlyASum);
      h += sideBar(nameB, opsB, onlyB.length, matchedN, bl.matchedSum, bl.onlyBSum);
      h += `</div>`;
    }

    // Закрываем «Подробности для бухгалтера»
    h += `</details>`;

    return h;

    // Топ непарных операций по сумме (для «Топ-риск»)
    function topDiscrepancies(bl, n) {
      const arr = [];
      (bl.onlyA || []).forEach((o) => arr.push({ ...o, sideName: nameA, sideTxt: o.side === "д" ? "дебет" : "кредит" }));
      (bl.onlyB || []).forEach((o) => arr.push({ ...o, sideName: nameB, sideTxt: o.side === "д" ? "дебет" : "кредит" }));
      arr.sort((a, b) => (Math.abs(b.sumAbs ?? b.sum ?? 0) || 0) - (Math.abs(a.sumAbs ?? a.sum ?? 0) || 0));
      return arr.slice(0, n || 3);
    }

    // Эвристические вопросы контрагенту — по топу крупных непарных операций
    function heuristicAsk(bl, nameX, nameY) {
      const questions = [];
      const top = topDiscrepancies(bl, 3);
      for (const r of top) {
        const other = r.sideName === nameX ? nameY : nameX;
        if (r.sumAbs >= 5000) {
          questions.push(
            `Запросить у «${other}» подтверждение по документу «${r.doc || r.key}» (${fmtMoney(r.sumAbs)} ₽) — в акте другой стороны он отсутствует.`
          );
        }
      }
      if (!questions.length && (bl.onlyA.length || bl.onlyB.length)) {
        questions.push(`Уточнить у контрагента список всех операций за период — есть ${bl.onlyA.length + bl.onlyB.length} документов, которых нет во встречном акте.`);
      }
      return questions;
    }

    function listNames(list) {
      return list.map((o) => o.doc || o.key).slice(0, 10).join("; ");
    }

    // Одна полоса прогресса для стороны
    function sideBar(name, totalOps, unmatchedCount, matchedCount, matchedSum, unmatchedSum) {
      if (!totalOps) return "";
      const matchedN = Math.min(matchedCount, totalOps);
      const unmatchedN = Math.min(unmatchedCount, totalOps - matchedN);
      const pctMatched = Math.round((matchedN / totalOps) * 100);
      const pctUnmatched = 100 - pctMatched;
      return `<div class="an-sidebar">
        <div class="an-sidebar-top"><span>${esc(name)}</span><span>${totalOps} оп.</span></div>
        <div class="an-sidebar-track">
          <div class="an-sidebar-fill ok" style="width:${pctMatched}%"></div>
          <div class="an-sidebar-fill bad" style="width:${pctUnmatched}%"></div>
        </div>
        <div class="an-sidebar-legend">
          <span class="lg ok">✓ ${matchedN} · ${fmtMoney(matchedSum || 0)} ₽</span>
          <span class="lg bad">⚠ ${unmatchedN} · ${fmtMoney(unmatchedSum || 0)} ₽</span>
        </div>
      </div>`;
    }

    // Наглядный список непарных операций: сортировка по сумме (крупные первыми),
    // с документом, датой, суммой и пометкой стороны.
    function opListHtml(list, sideName) {
      const sorted = list
        .slice()
        .sort((a, b) => (Math.abs(b.sumAbs ?? b.sum ?? 0) || 0) - (Math.abs(a.sumAbs ?? a.sum ?? 0) || 0));
      return sorted
        .map((o, i) => {
          const amount = Math.abs(o.sumAbs ?? o.sum ?? 0);
          const big = amount >= 50000; // крупная операция — подсветить
          const sideTxt = o.side === "д" ? "дебет" : o.side === "к" ? "кредит" : "";
          return `<div class="an-op-item ${big ? "big" : ""}">
            <span class="an-op-n">${i + 1}</span>
            <span class="an-op-doc">${esc(o.doc || o.key || "—")} ${sideTxt ? `<em>${esc(sideTxt)}</em>` : ""}</span>
            <span class="an-op-sum">${fmtMoney(amount)} ₽</span>
          </div>`;
        })
        .join("");
    }
  }

  function opTable(ops, sideCls) {
    const tbl = document.createElement("table");
    tbl.className = "op-table";
    tbl.innerHTML = `<thead><tr><th>Документ</th><th>Дата</th><th>Сумма</th><th>Сторона</th></tr></thead><tbody></tbody>`;
    const tb = tbl.querySelector("tbody");
    ops.forEach((o) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(o.doc || o.key)}</td>
        <td>${escapeHtml(o.date || "—")}</td>
        <td>${fmtMoney(o.sumAbs)}</td>
        <td><span class="badge ${sideCls}">${o.side === "д" ? "дебет" : "кредит"}</span></td>`;
      tb.appendChild(tr);
    });
    return tbl;
  }

  function docShort(o) {
    if (!o) return "";
    const doc = o.doc || "";
    return doc || o.key;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[m]);
  }

  // Экспорт
  $("exportBtn").addEventListener("click", async () => {
    const data = state.compareData;
    if (!data) return;
    const btn = $("exportBtn");
    const orig = btn.textContent;
    btn.textContent = "Формируем…";
    btn.disabled = true;
    try {
      // Скачивание через скрытую форму-POST в новую вкладку: сервер отдаёт
      // Content-Disposition: attachment → файл скачивается без blob-перехвата.
      const form = $("aiDownloadForm");
      const input = $("aiDownloadPayload");
      if (form && input) {
        input.value = JSON.stringify({
          blocks: data.blocks || {},
          meta: data.meta || {},
          ai: state.aiResult, // передаём ИИ-разбор, если есть
        });
        form.submit();
      } else {
        showError("Не удалось подготовить отчёт.");
      }
    } catch (e) {
      showError("Ошибка экспорта: " + e.message);
    } finally {
      btn.textContent = orig;
      btn.disabled = false;
    }
  });

  // Кнопка "К выбору файлов": возврат к шагу загрузки после анализа
  $("backBtn").addEventListener("click", () => {
    stepResult.hidden = true;
    stepUpload.hidden = false;
    // сброс выбранных файлов
    state.fileA = null;
    state.fileB = null;
    state.cpA = "";
    state.cpB = "";
    state.compareData = null;
    if (fileAInput) fileAInput.value = "";
    if (fileBInput) fileBInput.value = "";
    if (cpA) cpA.value = "";
    if (cpB) cpB.value = "";
    setDzFilled(dzA, { files: [] }, $("fileAName"));
    setDzFilled(dzB, { files: [] }, $("fileBName"));
    updateCompare();
    stepUpload.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // ── Пакетная сверка: эталон + несколько контрагентов ─────────────
  const batchMaster = $("batchMaster");
  const batchDocs = $("batchDocs");
  const batchBtn = $("batchCompareBtn");
  const batchResult = $("batchResult");
  const batchError = $("batchError");

  if (batchBtn) {
    batchBtn.addEventListener("click", async () => {
      batchError.hidden = true;
      const master = batchMaster.files && batchMaster.files[0];
      const docs = batchDocs.files ? Array.from(batchDocs.files) : [];
      if (!master || !docs.length) {
        batchError.textContent = "Выберите эталон и хотя бы один акт контрагента.";
        batchError.hidden = false;
        return;
      }
      batchBtn.disabled = true;
      const orig = batchBtn.textContent;
      batchBtn.textContent = "Сверяем…";
      batchResult.innerHTML = "";
      try {
        const fd = new FormData();
        fd.append("master", master);
        docs.forEach((d, i) => {
          fd.append("doc" + (i + 1), d);
          // имя контрагента — из имени файла (грубо)
          const n = (d.name || "").replace(/\.[^.]+$/, "").replace(/(акт|сверк|взаиморасчет|взаиморасчётов|за\s|от\s|\b№\b|\d{2}\.\d{2}\.\d{4})\s*/gi, "").replace(/[_\-\s]+/g, " ").trim();
          fd.append("name" + (i + 1), n || d.name || "");
        });
        const res = await fetch((API_PREFIX || "") + "/api/batch-compare", { method: "POST", body: fd });
        const j = await res.json().catch(() => null);
        if (!j || !j.ok) {
          batchError.textContent = (j && j.error) || "Не удалось выполнить пакетную сверку.";
          batchError.hidden = false;
          return;
        }
        batchResult.innerHTML = renderBatchTable(j.rows || []);
      } catch (e) {
        batchError.textContent = "Ошибка: " + e.message;
        batchError.hidden = false;
      } finally {
        batchBtn.disabled = false;
        batchBtn.textContent = orig;
      }
    });
  }

  function renderBatchTable(rows) {
    const esc = escapeHtml;
    if (!rows.length) return `<p class="batch-empty">Нет данных.</p>`;
    const statusMeta = {
      ok: { cls: "st-ok", label: "✓ сходится" },
      diff: { cls: "st-diff", label: "⚠ расхождения" },
      error: { cls: "st-err", label: "✕ ошибка" },
    };
    let totalSum = 0;
    rows.forEach((r) => { if (r.saldoDiff) totalSum += Math.abs(r.saldoDiff); });
    let html = `<table class="batch-table">
      <thead><tr><th>Контрагент</th><th>Разница сальдо</th><th>Непарных операций</th><th>Статус</th></tr></thead><tbody>`;
    rows.forEach((r) => {
      const st = statusMeta[r.status] || statusMeta.error;
      html += `<tr>
        <td>${esc(r.name || "—")}</td>
        <td>${r.saldoDiff != null ? fmtMoney(Math.abs(r.saldoDiff)) + " ₽" : "—"}</td>
        <td>${r.unmatched != null ? r.unmatched : "—"}</td>
        <td><span class="batch-st ${st.cls}">${st.label}</span></td>
      </tr>`;
    });
    html += `</tbody></table>`;
    html += `<div class="batch-total">Совокупная разница по всем контрагентам: <b>${fmtMoney(totalSum)} ₽</b></div>`;
    return html;
  }
})();
