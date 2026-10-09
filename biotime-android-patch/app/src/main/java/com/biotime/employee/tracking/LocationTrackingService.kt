package com.biotime.employee.tracking

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.IBinder
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.biotime.employee.MainActivity
import com.biotime.employee.R
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

/**
 * Фоновый трекер геолокации водителя. Работает даже при свёрнутом/заблокированном
 * приложении (Foreground Service + запрос "всегда"). Шлёт координаты на готовый
 * эндпоинт BIOTIME POST /api/drivers/location каждые [UPDATE_INTERVAL_MS].
 *
 * Офлайн-буфер: если сеть недоступна, точка не теряется, а кладётся в файл
 * track_buffer.json (переживает перезапуск) и досылается пачкой ({points:[...]})
 * при появлении сети. Сервер принял пачку для /api/drivers/location.
 */
class LocationTrackingService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var fusedClient: FusedLocationProviderClient

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            result.lastLocation?.let { send(it) }
        }
    }

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIF_ID, buildNotification())
        fusedClient = LocationServices.getFusedLocationProviderClient(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Трекер работает ТОЛЬКО у водителя и пока его рабочий день начат и не
        // завершён. Для не-водителей (не состоят в группе «Водители») геолокация
        // не запрашивается вообще.
        if (!isDriver() || !isWorkActive()) {
            stopSelf()
            return START_NOT_STICKY
        }
        startLocationUpdates()
        return START_STICKY
    }

    private fun buildNotification(): Notification {
        createChannel()
        val contentIntent = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.tracking_notif_title))
            .setContentText(getString(R.string.tracking_notif_text))
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .setContentIntent(contentIntent)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.tracking_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.tracking_channel_desc)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun startLocationUpdates() {
        if (ActivityCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) return

        val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, UPDATE_INTERVAL_MS)
            .setMinUpdateIntervalMillis(UPDATE_INTERVAL_MS / 2)
            .setMinUpdateDistanceMeters(10f)
            .build()

        try {
            fusedClient.requestLocationUpdates(request, callback, null)
        } catch (_: SecurityException) {
            // нет разрешения
        }
    }

    private fun send(loc: Location) {
        scope.launch {
            // Защита от гонки: если пользователь не водитель или день
            // завершился, пока координата летела — не отправляем её.
            if (!isDriver() || !isWorkActive()) return@launch
            val routeId = prefs().getString(KEY_ROUTE_ID, "") ?: ""
            // Сначала пробуем отправить накопленный офлайн-буфер (сеть могла
            // вернуться): если он уйдёт — освобождаем место на устройстве.
            flushBuffer()
            val body = JSONObject()
                .put("lat", loc.latitude)
                .put("lon", loc.longitude)
                .apply { if (routeId.isNotEmpty()) put("routeId", routeId) }
            try {
                postJson(body)
            } catch (_: Exception) {
                // сеть недоступна — кладём точку в офлайн-буфер, вышлем при
                // появлении сети (flushBuffer в следующем тике).
                appendToBuffer(loc, routeId, System.currentTimeMillis())
            }
        }
    }

    /** Файл офлайн-буфера координат (переживает перезапуски приложения). */
    private fun bufferFile() = java.io.File(filesDir, "track_buffer.json")

    private fun readBuffer(): JSONArray {
        val f = bufferFile()
        return try { if (f.exists()) JSONArray(f.readText()) else JSONArray() } catch (_: Exception) { JSONArray() }
    }

    /** Кладёт точку в офлайн-буфер, ограничивая его последними ~500 точками. */
    private fun appendToBuffer(loc: Location, routeId: String, ts: Long) {
        try {
            val arr = readBuffer()
            val o = JSONObject().put("lat", loc.latitude).put("lon", loc.longitude).put("ts", ts)
            if (routeId.isNotEmpty()) o.put("routeId", routeId)
            arr.put(o)
            val start = if (arr.length() > 500) arr.length() - 500 else 0
            val out = JSONArray()
            for (i in start until arr.length()) out.put(arr.get(i))
            bufferFile().writeText(out.toString())
        } catch (_: Exception) { /* не критично */ }
    }

    /** Отправляет накопленный офлайн-буфер пачкой; при успехе очищает его. */
    private fun flushBuffer(): Boolean {
        try {
            val f = bufferFile()
            if (!f.exists()) return true
            val arr = JSONArray(f.readText())
            if (arr.length() == 0) { f.delete(); return true }
            val body = JSONObject().put("points", arr)
            postJson(body)
            f.delete()
            return true
        } catch (_: Exception) {
            return false
        }
    }

    /** Единая отправка JSON POST на /api/drivers/location (с кукой сессии). */
    private fun postJson(body: JSONObject) {
        val url = URL(MainActivity.APP_URL.trimEnd('/') + "/api/drivers/location")
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 15_000
        conn.readTimeout = 15_000
        conn.setRequestProperty("Content-Type", "application/json")
        // Фоновый keepalive сессии: каждый координатный POST в фоне идёт на домен
        // приложения через платформенный Gateway. Чтобы Gateway признал запрос и
        // продлил сессию (_vibe_gw), передаём накопленную WebView-куку сессии так же,
        // как это делает активная вкладка.
        try {
            val cookie = CookieManager.getInstance().getCookie(url.toString())
            if (!cookie.isNullOrEmpty()) conn.setRequestProperty("Cookie", cookie)
        } catch (_: Exception) {
            // куки — вспомогательное; сбой не должен ронять фон
        }
        conn.doOutput = true
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        conn.responseCode // 200 — ок; 401/403 — сессия истекла (нужен вход в WebView)
        conn.disconnect()
    }

    private fun prefs() = getSharedPreferences("biotime", Context.MODE_PRIVATE)

    private fun isWorkActive(): Boolean =
        prefs().getBoolean(KEY_WORK_ACTIVE, false)

    private fun isDriver(): Boolean =
        prefs().getBoolean(KEY_IS_DRIVER, false)

    override fun onDestroy() {
        try { fusedClient.removeLocationUpdates(callback) } catch (_: Exception) {}
        scope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL_ID = "biotime_tracking"
        private const val NOTIF_ID = 1
        private const val KEY_ROUTE_ID = "active_route_id"
        private const val KEY_WORK_ACTIVE = "work_day_active"
        private const val KEY_IS_DRIVER = "is_driver"
        private const val UPDATE_INTERVAL_MS = 15_000L // 15 секунд

        fun isWorkActive(context: Context): Boolean =
            context.getSharedPreferences("biotime", Context.MODE_PRIVATE)
                .getBoolean(KEY_WORK_ACTIVE, false)

        fun isDriver(context: Context): Boolean =
            context.getSharedPreferences("biotime", Context.MODE_PRIVATE)
                .getBoolean(KEY_IS_DRIVER, false)

        fun setDriver(context: Context, isDriver: Boolean) {
            context.getSharedPreferences("biotime", Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_IS_DRIVER, isDriver).apply()
            if (!isDriver) {
                stop(context)
            }
        }

        fun setWorkActive(context: Context, active: Boolean) {
            context.getSharedPreferences("biotime", Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_WORK_ACTIVE, active).apply()
            if (active && isDriver(context)) {
                start(context)
            } else {
                stop(context)
            }
        }

        fun start(context: Context) {
            if (!isDriver(context) || !isWorkActive(context)) return
            val intent = Intent(context, LocationTrackingService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationTrackingService::class.java))
        }

        fun setActiveRouteId(context: Context, routeId: String) {
            context.getSharedPreferences("biotime", Context.MODE_PRIVATE)
                .edit().putString(KEY_ROUTE_ID, routeId).apply()
        }
    }
}
