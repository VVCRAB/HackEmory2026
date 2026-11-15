package com.focus.companion

import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {
    private val pairingPrefs by lazy { getSharedPreferences(AppBlockerService.PREFS, MODE_PRIVATE) }
    private var showingConnection = false
    private val pairingListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == AppBlockerService.PAIRING_ACK) showConnectionIfReady()
    }

    override fun onStart() {
        super.onStart()
        showingConnection = false
        pairingPrefs.registerOnSharedPreferenceChangeListener(pairingListener)
        showConnectionIfReady()
    }

    override fun onStop() {
        pairingPrefs.unregisterOnSharedPreferenceChangeListener(pairingListener)
        super.onStop()
    }

    private fun showConnectionIfReady() {
        if (showingConnection || !AppBlockerService.isDesktopConnected) return
        showingConnection = true
        startActivity(Intent(this, ConnectedActivity::class.java))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        applySystemBarInsets(findViewById(R.id.homeRoot))

        findViewById<View>(R.id.btnConnect).setOnClickListener {
            startActivity(Intent(this, ScanIntroActivity::class.java))
        }
        findViewById<View>(R.id.debugTouchZone).setOnClickListener {
            startActivity(Intent(this, DebugActivity::class.java))
        }
    }
}

internal fun applySystemBarInsets(root: View) {
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
        insets
    }
}
