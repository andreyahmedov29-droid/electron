// Утилиты периодов отчётов (общие для всех разделов).

function subtractDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function periodedSettings(settings, name) {
  const p = settings[name] || {};
  let start = p.start || '';
  let end = p.end || '';
  // Санитизация: невалидный или перевёрнутый период сбрасываем на текущий месяц.
  const okDate = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!okDate(start) || !okDate(end) || start > end) {
    start = '';
    end = '';
  }
  // Период выбирается свободно: как только задан — его «по» чтится буквально.
  // Если не задан — по умолчанию текущий месяц (01 … сегодня).
  if (!start && !end) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    start = `${y}-${m}-01`;
    end = `${y}-${m}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return { ...settings, dateStart: start, dateEnd: end };
}

module.exports = { subtractDays, periodedSettings };
