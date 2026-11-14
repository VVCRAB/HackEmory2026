const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("focusAPI", {
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
  recordFocusTick: (id) => ipcRenderer.invoke("stats-focus-tick", id),
  onAnalyticsUpdated: (callback) => { ipcRenderer.on("analytics-updated", () => callback()); },
  addLookAway: () => ipcRenderer.invoke("stats-add-lookaway"),
  addBlocked: (app) => ipcRenderer.invoke("stats-add-blocked", app),
});
