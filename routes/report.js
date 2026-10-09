// Модуль-обработчик экспорта табеля (/api/report/export?month=YYYY-MM).
// Вынесен из server.js дословно; зависимости инъекцией (DI).
module.exports = function createReportHandler({
  getDb,
  sendJson,
  isAdmin,
  isModerator,
  timesheetRowsForMonth,
  visibleStaff,
  buildXlsx,
  MIME,
} = {}) {
  return async function handleReportRoutes(req, res, urlPath, method, user, admin) {
    const db = getDb ? getDb() : {};

    // GET /api/report/export?month=YYYY-MM (admin/moderator; downloads the timesheet as .xlsx)
    if (urlPath === "/api/report/export" && method === "GET") {
      if (!admin && !isModerator(user, db)) return sendJson(res, 403, { error: "forbidden" });
      const month = String((new URL(req.url, `http://${req.headers.host}`).searchParams.get("month")) || "");
      const mm = /^(\d{4})-(\d{2})$/.exec(month);
      if (!mm) return sendJson(res, 422, { error: "bad month; expected YYYY-MM" });
      const year = Number(mm[1]);
      const m0 = Number(mm[2]) - 1;
      if (m0 < 0 || m0 > 11) return sendJson(res, 422, { error: "bad month" });
      try {
        const report = timesheetRowsForMonth(year, m0, visibleStaff(user, db));
        const buf = buildXlsx(report.sheet, report.title);
        res.writeHead(200, {
          "Content-Type": MIME[".xlsx"],
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(report.title.replace(/\s+/g, "_"))}.xlsx`,
          "Content-Length": buf.length,
          "Cache-Control": "no-store",
        });
        return res.end(buf);
      } catch (e) {
        console.error("export failed:", e);
        return sendJson(res, 500, { error: "export_failed" });
      }
    }

    return false;
  };
};
