package com.focus.companion

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.Context
import android.telecom.TelecomManager
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.widget.Toast
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.json.JSONArray
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class AppBlockerService : AccessibilityService() {
    companion object {
        private var isLocked = false
        private var blockedPackages = emptySet<String>()

        // Both services and the socket's state updates run on the main thread.
        private val emergencyPackages = setOf(
            "com.android.phone", "com.android.server.telecom", "com.android.dialer",
            "com.samsung.android.dialer", "com.samsung.android.incallui",
            "com.google.android.apps.dialer", "com.android.emergency"
        )

        private fun isEmergencyPackage(context: Context, target: String): Boolean {
            val name = target.lowercase()
            return target == context.packageName || name in emergencyPackages ||
                "dialer" in name || "telecom" in name ||
                target == context.getSystemService(TelecomManager::class.java)?.defaultDialerPackage
        }

        internal fun shouldCancelNotification(context: Context, target: String): Boolean =
            isLocked && !isEmergencyPackage(context, target) &&
                ("*" in blockedPackages || target in blockedPackages)

        const val PREFS = "focus_connection"
        const val URL = "desktop_url"
        const val CODE = "desktop_pairing_code"
        const val PAIRING_ACK = "desktop_pairing_ack"
        const val PAIRING_REVISION = "desktop_pairing_revision"
    }

    private var lastEmergencyToast = -2500L
    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private lateinit var prefs: SharedPreferences
    private val inventoryExecutor = Executors.newSingleThreadExecutor()
    private var socket: WebSocket? = null

    private val reconnect = Runnable { connect() }
    private val urlChanged = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == PAIRING_REVISION) connect()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        prefs.registerOnSharedPreferenceChangeListener(urlChanged)
        connect()
    }

    private fun connect() {
        handler.removeCallbacks(reconnect)
        socket?.cancel()
        socket = null
        isLocked = false
        blockedPackages = emptySet()
        val url = prefs.getString(URL, null) ?: return
        val code = prefs.getString(CODE, null) ?: return
        val revision = prefs.getString(PAIRING_REVISION, null) ?: return
        val request = try {
            Request.Builder().url(url).build()
        } catch (error: IllegalArgumentException) {
            Log.e("FocusWS", "Invalid desktop address", error)
            return
        }
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("action", "PAIR").put("code", code).toString())
                Log.d("FocusWS", "Pairing request sent")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handler.post {
                    if (socket === webSocket) receive(text, revision)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                disconnected(webSocket, retry = code != 1008)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w("FocusWS", "Desktop connection failed", t)
                disconnected(webSocket)
            }
        })
    }

    private fun disconnected(webSocket: WebSocket, retry: Boolean = true) {
        handler.post {
            if (socket !== webSocket) return@post
            socket = null
            isLocked = false
            Log.d("FocusWS", if (retry) "Desktop disconnected, retrying" else "Pairing rejected, scan the current QR code")
            if (retry) handler.postDelayed(reconnect, 2000)
        }
    }

    private fun receive(text: String, revision: String) {
        try {
            val message = JSONObject(text)
            val action = message.optString("action")
            Log.d("FocusWS", if (action == "HELLO") "HELLO received" else text)
            when (action) {
                "HELLO" -> {
                    prefs.edit().putString(PAIRING_ACK, revision).apply()
                    sendInstalledApps()
                }
                "GET_INSTALLED_APPS" -> sendInstalledApps()
                "SYNC" -> {
                    val apps = message.getJSONArray("blocked_apps")
                    blockedPackages = (0 until apps.length()).map { apps.getString(it) }.toSet()
                }
                "LOCK" -> isLocked = true
                "UNLOCK" -> isLocked = false
                "VIBRATE" -> vibrateForLookAway()
                else -> Log.w("FocusWS", "Unknown action: $action")
            }
        } catch (error: org.json.JSONException) {
            Log.w("FocusWS", "Invalid desktop message", error)
        }
    }

    private fun vibrateForLookAway() {
        Log.d("FocusVibration", "Received VIBRATE from paired desktop")
        playFocusVibration(this, "desktop look-away")
        runCatching {
            val tone = android.media.ToneGenerator(android.media.AudioManager.STREAM_ALARM, 100)
            try {
                for (pulse in 0 until 10) {
                    handler.postDelayed({ tone.startTone(android.media.ToneGenerator.TONE_PROP_BEEP, 180) }, pulse * 500L)
                }
            } finally {
                handler.postDelayed({ tone.release() }, 5150)
            }
        }.onFailure { Log.w("FocusWS", "Could not play look-away tone", it) }
    }

    private fun sendInstalledApps() {
        val connection = socket ?: return
        inventoryExecutor.execute {
            runCatching {
                val apps = collectInstalledApps()
                connection.send(JSONObject().put("action", "INSTALLED_APPS").put("apps", apps).toString())
                Log.d("FocusWS", "Published ${apps.length()} installed apps")
            }.onFailure {
                Log.e("FocusWS", "Unable to read installed apps", it)
                connection.send(JSONObject().put("action", "INSTALLED_APPS_ERROR").toString())
            }
        }
    }

    private fun collectInstalledApps(): JSONArray {
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = JSONArray()
        val excluded = Regex("telecom|dialer|system|settings", RegexOption.IGNORE_CASE)
        val systemFlags = ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP
        packageManager.queryIntentActivities(launcher, 0)
            .distinctBy { it.activityInfo.packageName }
            .forEach { activity ->
                val info = activity.activityInfo.applicationInfo
                val target = info.packageName
                if (info.flags and systemFlags != 0 || info.uid < 10000 ||
                    target == "android" || excluded.containsMatchIn(target) ||
                    isEmergencyPackage(this, target)
                ) return@forEach
                val label = info.loadLabel(packageManager).toString().trim().ifBlank { target }
                val icon = runCatching {
                    val drawable = info.loadIcon(packageManager)
                    val bitmap = Bitmap.createBitmap(40, 40, Bitmap.Config.ARGB_8888)
                    drawable.setBounds(0, 0, bitmap.width, bitmap.height)
                    drawable.draw(Canvas(bitmap))
                    val bytes = ByteArrayOutputStream()
                    bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)
                    Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
                }.getOrNull()
                apps.put(JSONObject().put("packageName", target).put("label", label).put("icon", icon))
            }
        return apps
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val target = event.packageName?.toString()
        Log.d("FocusEvent", "type=${event.eventType} package=$target locked=$isLocked")
        if (!isLocked || target == null ||
            event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED ||
            target == "com.android.systemui" ||
            target == "com.android.settings" || isLauncherPackage(target)
        ) return

        if (isEmergencyPackage(this, target)) {
            if (target in blockedPackages || "*" in blockedPackages) {
                val now = android.os.SystemClock.elapsedRealtime()
                if (now - lastEmergencyToast >= 2500) {
                    lastEmergencyToast = now
                    Toast.makeText(this, "Cannot be blocked for emergency purposes.", Toast.LENGTH_SHORT).show()
                }
            }
            return
        }

        if (target !in blockedPackages && ("*" !in blockedPackages || isSystemPackage(target))) return

        Toast.makeText(this, "Blocked Access: Focus Mode Active", Toast.LENGTH_SHORT).show()
        if (!performGlobalAction(GLOBAL_ACTION_HOME)) {
            val home = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            runCatching { startActivity(home) }.onFailure {
                Log.w("FocusEvent", "Home redirect failed", it)
            }
        }
        socket?.send(JSONObject().put("action", "BLOCKED").put("app", target).toString())
        Log.d("FocusEvent", "Blocked $target")
    }

    private fun isSystemPackage(target: String): Boolean {
        return runCatching {
            val flags = packageManager.getApplicationInfo(target, 0).flags
            flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
        }.getOrDefault(false)
    }

    private fun isLauncherPackage(target: String): Boolean {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        return packageManager.resolveActivity(home, 0)?.activityInfo?.packageName == target
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        inventoryExecutor.shutdownNow()
        isLocked = false
        blockedPackages = emptySet()
        if (::prefs.isInitialized) prefs.unregisterOnSharedPreferenceChangeListener(urlChanged)
        handler.removeCallbacksAndMessages(null)
        socket?.cancel()
        socket = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        super.onDestroy()
    }
}
