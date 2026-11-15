package com.focus.companion

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import org.json.JSONObject

class AppNotificationListener : NotificationListenerService() {
    private var sessionId: String? = null
    private val seenMessages = mutableSetOf<Pair<String, Int>>()
    private val repliedConversations = mutableSetOf<String>()

    override fun onNotificationPosted(sbn: StatusBarNotification?, rankingMap: RankingMap?) {
        val entry = sbn ?: return
        val active = AppBlockerService.focusSessionId
        if (active == null) {
            if (AppBlockerService.shouldCancelNotification(this, entry.packageName)) suppress(entry)
            return
        }
        if (active != sessionId) {
            sessionId = active
            seenMessages.clear()
            repliedConversations.clear()
        }
        if (AppBlockerService.isEmergencyPackage(this, entry.packageName) ||
            entry.notification.category == Notification.CATEGORY_CALL ||
            entry.notification.category == Notification.CATEGORY_ALARM) return

        val ranking = Ranking()
        val emergency = Build.VERSION.SDK_INT >= 30 &&
            rankingMap?.getRanking(entry.key, ranking) == true &&
            ranking.channel?.isImportantConversation == true
        val notification = entry.notification
        val isMessage = notification.category == Notification.CATEGORY_MESSAGE ||
            notification.extras.containsKey(Notification.EXTRA_MESSAGES)

        try {
            if (isMessage && notification.flags and Notification.FLAG_GROUP_SUMMARY == 0) {
                processMessage(entry, emergency)
            }
        } finally {
            if (!emergency) suppress(entry)
        }
    }

    @Suppress("DEPRECATION")
    private fun processMessage(entry: StatusBarNotification, emergency: Boolean) {
        val notification = entry.notification
        val extras = notification.extras
        val style = androidx.core.app.NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
        val latest = style?.messages?.lastOrNull()
        val sender = if (latest != null) {
            // Android represents outgoing messages with no sender.
            latest.person?.name
        } else extras.getCharSequence(Notification.EXTRA_TITLE)
        if (sender.isNullOrBlank() || latest?.dataMimeType != null || latest?.dataUri != null) return
        val text = (latest?.text ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim()
        if (text.isNullOrBlank() || text.matches(MEDIA_LABEL)) return
        val timestamp = latest?.timestamp ?: entry.postTime
        val fingerprint = if (latest != null) Triple(sender.toString(), text, timestamp).hashCode()
            else Pair(sender.toString(), text).hashCode()
        if (!seenMessages.add(entry.key to fingerprint)) return
        Log.d(TAG, "Text message received from ${entry.packageName}")
        val app = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(entry.packageName, 0)).toString()
        }.getOrDefault(entry.packageName)
        val action = findReplyAction(entry)
        val token = if (action != null) java.util.UUID.randomUUID().toString() else null
        if (token != null && action != null) {
            replies[token] = ReplyTarget(AppBlockerService.focusSessionId, action)
            if (replies.size > 100) replies.remove(replies.keys.first())
        }
        val sent = AppBlockerService.forwardFocusMessage(JSONObject()
            .put("kind", "text").put("sourceApp", app).put("sender", sender.toString())
            .put("replyToken", token).put("text", text.take(4000)).put("timestamp", timestamp).put("emergency", emergency))
        Log.d(TAG, if (sent) "Message forwarded to desktop" else "Desktop unavailable")
        if (!emergency && !text.startsWith("emergency", ignoreCase = true)) reply(entry)
    }

    private fun reply(entry: StatusBarNotification) {
        val shortcut = if (Build.VERSION.SDK_INT >= 26) entry.notification.shortcutId else null
        val conversation = entry.packageName + ":" + (shortcut ?: entry.key)
        if (conversation in repliedConversations) return
        val action = findReplyAction(entry) ?: return
        repliedConversations.add(conversation)
        if (!sendReply(this, action, "Automatic reply: I’m in a focus session and will reply later. If you need me urgently, text EMERGENCY, then send a separate message with the details. I’ll see your follow-up.")) {
            repliedConversations.remove(conversation)
        }
    }

    private fun findReplyAction(entry: StatusBarNotification) =
        entry.notification.actions?.firstOrNull { candidate ->
            candidate.actionIntent?.creatorPackage == entry.packageName &&
                candidate.remoteInputs?.any { it.allowFreeFormInput } == true &&
                (Build.VERSION.SDK_INT < 28 || candidate.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY ||
                    candidate.title.toString().equals("Reply", ignoreCase = true))
        }

    private fun suppress(entry: StatusBarNotification) {
        runCatching { cancelNotification(entry.key) }
            .onSuccess { Log.d(TAG, "Notification dismissal requested for ${entry.packageName}") }
            .onFailure { Log.w(TAG, "Could not dismiss notification for ${entry.packageName}") }
    }

    companion object {
        private data class ReplyTarget(val sessionId: String?, val action: Notification.Action)
        private val replies = linkedMapOf<String, ReplyTarget>()

        internal fun replyFromDesktop(context: android.content.Context, token: String, text: String): Boolean {
            val target = replies[token] ?: return false
            val session = AppBlockerService.focusSessionId ?: return false
            if (target.sessionId != session || text.isBlank() || text.length > 500) return false
            return sendReply(context, target.action, text)
        }

        private fun sendReply(context: android.content.Context, action: Notification.Action, text: String): Boolean {
            val inputs = action.remoteInputs.filter { it.allowFreeFormInput }.toTypedArray()
            if (inputs.isEmpty()) return false
            val results = Bundle().apply { putCharSequence(inputs.first().resultKey, text) }
            val intent = Intent()
            RemoteInput.addResultsToIntent(inputs, intent, results)
            return runCatching { action.actionIntent.send(context, 0, intent) }
                .onSuccess { Log.d(TAG, "Reply submitted") }
                .onFailure { Log.w(TAG, "Reply action unavailable", it) }
                .isSuccess
        }

        private const val TAG = "FocusMessages"
        private val MEDIA_LABEL = Regex(
            """(?i)^(?:[\p{So}\uFE0F]+\s*)?(?:sent (?:you )?(?:a |an )?)?(?:photo|image|video|voice (?:note|message)|audio|gif|sticker|attachment|media)(?: sent)?[.!]?$"""
        )
    }
}
