package com.focus.companion

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val btnConnect = findViewById<Button>(R.id.btnConnect)
        val accessibilityBtn = findViewById<Button>(R.id.accessibilityBtn) // Optional if present in layout

        btnConnect.setOnClickListener {
            val intent = Intent(this, ScanIntroActivity::class.java)
            startActivity(intent)
        }

        findViewById<Button>(R.id.notificationAccessBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }

        accessibilityBtn?.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
    }
}