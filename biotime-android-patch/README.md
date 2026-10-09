# Офлайн-буфер GPS → в biotime-android

Это готовый файл для репозитория **biotime-android** (Android-код в корне,
а не в папке `android/`). Он идентичен текущей версии трекера и добавляет к ней
только офлайн-буфер координат: при пропаже сети точка не теряется, копится в
`track_buffer.json` на устройстве и досылается пачкой при появлении сети.

## Как применить (1 файл)

1. Скопируйте файл
   `biotime-android-patch/app/src/main/java/com/biotime/employee/tracking/LocationTrackingService.kt`
   в репозиторий `biotime-android` по тому же пути
   `app/src/main/java/com/biotime/employee/tracking/LocationTrackingService.kt`.
2. В клоне `biotime-android` выполните:
   ```bash
   git add app/src/main/java/com/biotime/employee/tracking/LocationTrackingService.kt
   git commit -m "feat(tracking): офлайн-буфер координат — досыл пачкой при появлении сети"
   git push origin main
   ```
3. GitHub Actions «Сборка APK» соберёт новый APK и опубликует его в
   `biotime-apk-latest` — водители получат его через автообновление
   (versionCode поднимется автоматически workflow).

## Сервер

Сервер уже принимает пачку: `POST /api/drivers/location` с телом
`{ points: [ {lat, lon, ts, routeId}, ... ] }`. Убедитесь, что веб‑часть
задеплоена (кнопка «Деплой») — иначе новые точки не примутся.
