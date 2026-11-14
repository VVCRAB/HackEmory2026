const { app, BrowserWindow, ipcMain, Menu, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { randomInt } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const QRCode = require("qrcode");
const { WebSocket, WebSocketServer } = require("ws");

const WS_PORT = 8080;
const statsPath = path.join(__dirname, "stats.json");

let pairingCode = randomCode();
let wss = null;
const sockets = new Set();
const appInventories = new Map();
const inventoryFailures = new Set();
let phoneLocked = false;
let blockedApps = [];
let activityDb;

function openActivityDatabase() {
  activityDb = new DatabaseSync(path.join(app.getPath("userData"), "activity.sqlite"));
  activityDb.exec(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY,
      event_type TEXT NOT NULL,
      package_name TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS focus_sessions (
      id TEXT PRIMARY KEY,
      seconds INTEGER NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS analytics_metadata (key TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS activity_logs_timestamp ON activity_logs(timestamp);
  `);
  initializeAnalyticsHistory();
}

function initializeAnalyticsHistory() {
  if (activityDb.prepare("SELECT 1 FROM analytics_metadata WHERE key = 'history-v1'").get()) return;
  const sessions = activityDb.prepare("INSERT INTO focus_sessions VALUES (?, ?, ?)");
  const events = activityDb.prepare("INSERT INTO activity_logs (event_type, package_name, timestamp) VALUES (?, ?, ?)");
  activityDb.exec("BEGIN");
  try {
    const history = loadStats();
    const hasSessions = activityDb.prepare("SELECT 1 FROM focus_sessions LIMIT 1").get();
    const hasEvents = activityDb.prepare("SELECT 1 FROM activity_logs LIMIT 1").get();
    if (!hasSessions) {
      history.sessions.forEach((item, i) => {
        if (Number.isFinite(item.endedAt) && item.minutes > 0) {
          sessions.run("legacy-" + i, Math.round(item.minutes * 60), item.endedAt);
        }
      });
    }
    for (const timestamp of history.lookAwayEvents || []) {
      if (Number.isSafeInteger(timestamp)) events.run("LOOK_AWAY", "", timestamp);
    }
    if (!hasSessions && !hasEvents && !history.sessions.length && !history.lookAwayEvents?.length) {
      const durations = [100, 115, 85, 125, 95, 110, 70];
      const packages = ["com.instagram.android", "com.zhiliaoapp.musically", "com.google.android.youtube", "com.twitter.android"];
      durations.forEach((minutes, index) => {
        const day = new Date();
        day.setDate(day.getDate() - 6 + index);
        day.setHours(8, 0, 0, 0);
        const now = Date.now();
        day.setTime(Math.min(day.getTime(), now));
        sessions.run("sample-" + index, minutes * 60, day.getTime());
        for (let i = 0; i < 1 + index % 4; i++) {
          events.run("LOOK_AWAY", "", Math.min(now, day.getTime() + (10 + i * 12) * 60000));
        }
        [10, 14, 18, 21].forEach((hour, window) => {
          if (index === 6 && hour > 10) return;
          day.setHours(hour, index * 7, 0, 0);
          for (let i = 0; i < 1 + (index + window * 2) % 3; i++) {
            const timestamp = day.getTime() + i * 60000;
            if (timestamp <= now) events.run("BLOCKED", packages[(index + i + window) % packages.length], timestamp);
          }
        });
      });
    }
    activityDb.exec("INSERT INTO analytics_metadata VALUES ('history-v1'); COMMIT");
  } catch (error) {
    activityDb.exec("ROLLBACK");
    throw error;
  }
}

function publishAnalyticsUpdate() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send("analytics-updated");
  }
}

function logActivity(type, packageName = "") {
  activityDb.prepare("INSERT INTO activity_logs (event_type, package_name, timestamp) VALUES (?, ?, ?)")
    .run(type, packageName, Date.now());
  publishAnalyticsUpdate();
}

function readFocusSessions() {
  return activityDb.prepare("SELECT timestamp AS endedAt, seconds / 60.0 AS minutes FROM focus_sessions").all();
}

function hasConnectedCompanion() {
  return [...sockets].some(ws => ws.readyState === WebSocket.OPEN);
}

function randomCode() {
  return String(randomInt(1000, 10000));
}

function defaultStats() {
  return {
    sessions: [],
    lookAways: 0,
    lookAwayEvents: [],
    blockedAttempts: {},
  };
}

function loadStats() {
  try {
    return { ...defaultStats(), ...JSON.parse(fs.readFileSync(statsPath, "utf8")) };
  } catch {
    return defaultStats();
  }
}

function saveStats(stats) {
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
}

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = net.family === "IPv4" || net.family === 4;
      if (family && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

function dispatch(payload, clients = sockets) {
  const recipients = [...clients].filter(ws => ws.readyState === WebSocket.OPEN);
  console.info("[Phone WS] Dispatch", payload.action === "HELLO" ? { action: "HELLO" } : payload, `to ${recipients.length} client(s)`);
  const raw = JSON.stringify(payload);
  for (const ws of recipients) {
    ws.send(raw, error => {
      if (error) console.error("[Phone WS] Send failed", payload.action, error.message);
    });
  }
}

function syncPhoneRules(clients) {
  dispatch({ action: "SYNC", blocked_apps: blockedApps }, clients);
}

function installedApps() {
  return [...new Map([...appInventories.values()].flat().map(app => [app.packageName, app])).values()];
}

function publishCompanionStatus() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) {
      win.webContents.send("companion-status", { connected: sockets.size, installedApps: installedApps(), inventoryReady: appInventories.size > 0, inventoryError: inventoryFailures.size > 0 });
    }
  }
}

function startWebSocketServer() {
  wss = new WebSocketServer({ host: "0.0.0.0", port: WS_PORT });
  wss.on("listening", () => console.info(`[Phone WS] Listening on port ${WS_PORT}`));
  wss.on("error", error => console.error("[Phone WS] Server error", error.message));
  wss.on("connection", (ws, request) => {
    const peer = request.socket.remoteAddress;
    const pairingTimeout = setTimeout(() => ws.close(1008, "Pairing required"), 10000);
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (!sockets.has(ws)) {
          if (msg?.action !== "PAIR" || msg.code !== pairingCode) {
            ws.close(1008, "Invalid pairing code");
            return;
          }
          clearTimeout(pairingTimeout);
          sockets.add(ws);
          console.info("[Phone WS] Companion paired", peer);
          dispatch({ action: "HELLO", ip: getLanIp(), port: WS_PORT }, [ws]);
          syncPhoneRules([ws]);
          dispatch({ action: phoneLocked ? "LOCK" : "UNLOCK" }, [ws]);
          publishCompanionStatus();
          return;
        }
        if (msg.action === "INSTALLED_APPS_ERROR") {
          inventoryFailures.add(ws);
          publishCompanionStatus();
        }
        if ((msg.action ?? msg.type) === "INSTALLED_APPS" && Array.isArray(msg.apps)) {
          const apps = msg.apps.slice(0, 2000).filter(item =>
            typeof item?.packageName === "string" && /^[a-z0-9_.]{1,255}$/i.test(item.packageName) &&
            !/telecom|dialer|system|settings/i.test(item.packageName) &&
            !["android", "com.android.phone", "com.android.emergency", "com.samsung.android.incallui", "com.focus.companion"].includes(item.packageName.toLowerCase()) &&
            typeof item.label === "string"
          ).map(item => ({
            packageName: item.packageName,
            label: item.label.trim().slice(0, 120),
            icon: typeof item.icon === "string" && item.icon.length <= 16000 &&
              /^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(item.icon) ? item.icon : null,
          }));
          inventoryFailures.delete(ws);
          console.info("[Phone WS] Installed apps received:", apps.length);
          appInventories.set(ws, apps);
          publishCompanionStatus();
        }
        if (msg.action === "BLOCKED" && typeof msg.app === "string" && msg.app.length > 0 && msg.app.length <= 255) {
          logActivity("BLOCKED", msg.app);
        }
      } catch (error) {
        console.warn("[Phone WS] Could not process message", error.name);
      }
    });
    ws.on("close", code => {
      clearTimeout(pairingTimeout);
      appInventories.delete(ws);
      inventoryFailures.delete(ws);
      if (sockets.delete(ws)) publishCompanionStatus();
      console.info("[Phone WS] Client disconnected", peer, code, `(${sockets.size} active)`);
    });
    ws.on("error", error => console.error("[Phone WS] Client error", peer, error.message));
  });
}

function createWindow() {
  Menu.setApplicationMenu(null);
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 700,
    backgroundColor: "#121214",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

function allowMedia(_webContents, permission, callback) {
  if (permission === "media" || permission === "camera" || permission === "audioCapture" || permission === "videoCapture") {
    callback(true);
    return;
  }
  callback(false);
}

app.whenReady().then(() => {
  openActivityDatabase();
  session.defaultSession.setPermissionRequestHandler(allowMedia);
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "camera" || permission === "audioCapture" || permission === "videoCapture";
  });
  if (typeof session.defaultSession.setDevicePermissionHandler === "function") {
    session.defaultSession.setDevicePermissionHandler(() => true);
  }

  startWebSocketServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (wss) {
    wss.close();
    wss = null;
  }
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("request-installed-apps", () => dispatch({ action: "GET_INSTALLED_APPS" }));

ipcMain.handle("get-pair-info", () => ({
  ip: getLanIp(),
  port: WS_PORT,
  code: pairingCode,
  connected: sockets.size,
  installedApps: installedApps(),
  inventoryReady: appInventories.size > 0, inventoryError: inventoryFailures.size > 0,
}));

ipcMain.handle("get-pair-qr", () => QRCode.toDataURL(
  JSON.stringify({ url: `ws://${getLanIp()}:${WS_PORT}`, code: pairingCode }),
  { width: 288, margin: 4, color: { dark: "#C2410C", light: "#121214" } }
));

const androidPackages = new Map([
  ["instagram", "com.instagram.android"],
  ["tiktok", "com.zhiliaoapp.musically"],
  ["youtube", "com.google.android.youtube"],
  ["x", "com.twitter.android"],
  ["reddit", "com.reddit.frontpage"],
]);

function updatePhoneRules(payload) {
  blockedApps = payload?.mode === "FULL"
    ? ["*"]
    : Array.isArray(payload?.apps) ? payload.apps.filter(app => typeof app === "string").map(app => androidPackages.get(app.trim().toLowerCase()) ?? app.trim()) : [];
  syncPhoneRules();
}

ipcMain.handle("phone-sync", (_event, payload) => {
  updatePhoneRules(payload);
  return { ok: true };
});

ipcMain.handle("phone-lock", (_event, payload) => {
  phoneLocked = true;
  updatePhoneRules(payload);
  dispatch({ action: "LOCK" });
  return { ok: true };
});

ipcMain.handle("phone-unlock", (_event, payload) => {
  phoneLocked = false;
  if (payload) updatePhoneRules(payload);
  dispatch({ action: "UNLOCK" });
  return { ok: true };
});

ipcMain.handle("get-analytics", (_event, from, to) => {
  if (!hasConnectedCompanion()) return { connected: false };
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= to) {
    throw new Error("Invalid analytics date range");
  }
  const logs = activityDb.prepare(`
    SELECT id, event_type, package_name, timestamp
    FROM activity_logs WHERE timestamp >= ? AND timestamp < ? ORDER BY timestamp DESC
  `).all(from, to);
  return { connected: true, logs, sessions: readFocusSessions(),
    lookAwayEvents: logs.filter(log => log.event_type === "LOOK_AWAY").map(log => log.timestamp) };
});

ipcMain.handle("stats-get", () => ({ sessions: readFocusSessions() }));

ipcMain.handle("stats-focus-tick", (_event, sessionId) => {
  if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) return;
  const now = new Date();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  activityDb.prepare(`
    INSERT INTO focus_sessions (id, seconds, timestamp) VALUES (?, 1, ?)
    ON CONFLICT(id) DO UPDATE SET seconds = seconds + 1, timestamp = excluded.timestamp
  `).run(sessionId + ":" + day.getTime(), now.getTime());
  publishAnalyticsUpdate();
});

ipcMain.handle("stats-add-lookaway", () => logActivity("LOOK_AWAY"));
ipcMain.handle("stats-add-blocked", (_event, appName) => {
  if (typeof appName === "string" && appName.length > 0 && appName.length <= 255) logActivity("BLOCKED", appName);
});
