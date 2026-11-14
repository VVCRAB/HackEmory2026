package com.focus.companion

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

class AppNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn ?: return
        if (!AppBlockerService.shouldCancelNotification(this, notification.packageName)) return

        try {
            cancelNotification(notification.key)
        } catch (error: RuntimeException) {
            Log.w("NotificationBlocker", "Unable to cancel notification for ${notification.packageName}", error)
        }
    }
}
