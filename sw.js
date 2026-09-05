/* Service worker for BIOTIME «Табель» — PWA
   Стратегия:
   - навигация (HTML): network-first, фолбэк на кэш (офлайн-интерфейс);
   - статика (css/js/иконки/манифест): stale-while-revalidate (свежесть + офлайн);
   - /api/* (живые данные портала): НЕ кэшируем, только сеть. */
"use strict";

// Версия кэша обязана меняться при каждом деплое, иначе stale-while-revalidate
// отдаёт клиентам старый app.js: новая кнопка в HTML есть, а её обработчик из
// свежего скрипта ещё не подхвачен → «нажимаю, ничего не происходит».
const CACHE = "biotime-v2";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png",
  "./icon-maskable-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Не трогаем API и внешние ресурсы (шрифты Google и т.п.).
  if (
    url.pathname.startsWith("/api/") ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  // Навигация (HTML) — network-first.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Статика — stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
