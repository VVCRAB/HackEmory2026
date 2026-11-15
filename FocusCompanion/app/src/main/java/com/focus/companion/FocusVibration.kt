package com.focus.companion

import android.content.Context
import android.media.AudioAttributes
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

@Suppress("DEPRECATION")
internal fun playFocusVibration(context: Context, source: String): Boolean {
    return runCatching {
        val vibrator = if (Build.VERSION.SDK_INT >= 31) {
            context.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            context.getSystemService(Vibrator::class.java)
        }
        if (vibrator !is Vibrator || !vibrator.hasVibrator()) {
            Log.w("FocusVibration", "No vibrator available ($source)")
            return false
        }

        val pattern = longArrayOf(0, 200, 100, 200)
        if (Build.VERSION.SDK_INT >= 26) {
            val effect = VibrationEffect.createWaveform(pattern, -1)
            val attributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .build()
            vibrator.vibrate(effect, attributes)
        } else {
            vibrator.vibrate(pattern, -1)
        }
        Log.d("FocusVibration", "Requested two pulses ($source)")
        true
    }.getOrElse {
        Log.w("FocusVibration", "Vibration request failed ($source)", it)
        false
    }
}
