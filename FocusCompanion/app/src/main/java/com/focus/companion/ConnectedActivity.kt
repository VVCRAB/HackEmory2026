package com.focus.companion

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.content.SharedPreferences
import android.os.Bundle
import android.view.View
import android.view.animation.DecelerateInterpolator
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

class ConnectedActivity : AppCompatActivity() {
    private val pairingPrefs by lazy { getSharedPreferences(AppBlockerService.PREFS, MODE_PRIVATE) }
    private var pulse: ObjectAnimator? = null
    private var pulseStart: Runnable? = null
    private val pairingListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == AppBlockerService.PAIRING_ACK && !AppBlockerService.isDesktopConnected) finish()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_connected)
        applySystemBarInsets(findViewById(R.id.connectedRoot))
        findViewById<View>(R.id.btnDisconnect).setOnClickListener { disconnect() }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = disconnect()
        })
    }

    override fun onStart() {
        super.onStart()
        pairingPrefs.registerOnSharedPreferenceChangeListener(pairingListener)
        if (!AppBlockerService.isDesktopConnected) {
            finish()
            return
        }
        val ring = findViewById<View>(R.id.connectedRadarRing)
        val start = Runnable { startRadar(ring) }
        pulseStart = start
        ring.post(start)
    }

    private fun startRadar(ring: View) {
        ring.scaleX = 1f
        ring.scaleY = 1f
        ring.alpha = 0.9f
        pulse?.cancel()
        pulse = ObjectAnimator.ofPropertyValuesHolder(
            ring,
            PropertyValuesHolder.ofFloat(View.SCALE_X, 1f, 5.2f),
            PropertyValuesHolder.ofFloat(View.SCALE_Y, 1f, 5.2f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0.9f, 0f)
        ).apply {
            duration = 2100
            repeatCount = ObjectAnimator.INFINITE
            interpolator = DecelerateInterpolator()
            start()
        }
    }

    override fun onStop() {
        pulseStart?.let { findViewById<View>(R.id.connectedRadarRing)?.removeCallbacks(it) }
        pulseStart = null
        pulse?.cancel()
        pulse = null
        pairingPrefs.unregisterOnSharedPreferenceChangeListener(pairingListener)
        super.onStop()
    }

    private fun disconnect() {
        pairingPrefs.edit()
            .remove(AppBlockerService.URL)
            .remove(AppBlockerService.CODE)
            .remove(AppBlockerService.PAIRING_ACK)
            .remove(AppBlockerService.PAIRING_REVISION)
            .apply()
        finish()
    }
}
