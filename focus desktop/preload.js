const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusAPI", {
  getFocusMessages: () => ipcRenderer.invoke("focus-messages-get"),
  onFocusMessagesUpdated: callback => { ipcRenderer.on("focus-messages-updated", (_event, inbox) => callback(inbox)); },
  getPairQr: () => ipcRenderer.invoke("get-pair-qr"),
  onCompanionStatus: (callback) => {
    ipcRenderer.on("companion-status", (_event, status) => callback(status));
  },
  requestInstalledApps: () => ipcRenderer.invoke("request-installed-apps"),
  getPairInfo: () => ipcRenderer.invoke("get-pair-info"),
  syncPhoneRules: (payload) => ipcRenderer.invoke("phone-sync", payload),
  lockPhone: (payload) => ipcRenderer.invoke("phone-lock", payload),
  unlockPhone: (payload) => ipcRenderer.invoke("phone-unlock", payload),
  getAnalytics: (from, to) => ipcRenderer.invoke("get-analytics", from, to),
  getStats: () => ipcRenderer.invoke("stats-get"),
  cancelPaymentQuote: id => ipcRenderer.invoke("cancel-payment-quote", id),
  verifyCancelPayment: (id, wallet, signature) => ipcRenderer.invoke("cancel-payment-verify", id, wallet, signature),
  getTimer: () => ipcRenderer.invoke("timer-get"),
  commandTimer: (command, value, sessionId) => ipcRenderer.invoke("timer-command", command, value, sessionId),
  onTimerState: callback => { ipcRenderer.on("timer-state", (_event, state) => callback(state)); },
  onAnalyticsUpdated: (callback) => { ipcRenderer.on("analytics-updated", () => callback()); },
  vibrateForLookAway: id => ipcRenderer.invoke("focus-vibrate", id),
  addLookAway: () => ipcRenderer.invoke("stats-add-lookaway"),
  addBlocked: (app) => ipcRenderer.invoke("stats-add-blocked", app),
});
