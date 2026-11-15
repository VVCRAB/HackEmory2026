package com.focus.companion

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class DebugActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_debug)
        applySystemBarInsets(findViewById(R.id.debugRoot))

        findViewById<View>(R.id.debugBackBtn).setOnClickListener { finish() }
        findViewById<View>(R.id.accessibilityBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<View>(R.id.notificationAccessBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        findViewById<View>(R.id.testVibrationBtn).setOnClickListener {
            val requested = playFocusVibration(this, "test button")
            Toast.makeText(
                this,
                if (requested) "Vibration requested" else "Vibration unavailable",
                Toast.LENGTH_SHORT
            ).show()
        }
    }
}
