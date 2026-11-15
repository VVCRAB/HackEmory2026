const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const { desktopCapturer, Notification } = require("electron");

const POLL_MS = 2500;
const COOLDOWN_MS = 30000;
const DWELL_MS = 15000;
const WARNING_MS = 5000;
const LIMIT = 5;
const RETENTION_MS = 90000;
const DOMAINS = ["instagram.com", "tiktok.com", "twitter.com", "x.com", "reddit.com"];
const FILE = /^(\d{13})-([a-z0-9.-]+)\.jpg$/;
const run = promisify(execFile);

function identifySite(value) {
  if (typeof value !== "string" || /\s/.test(value)) return null;
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const isHost = domain => url.hostname === domain || url.hostname.endsWith("." + domain);
    if (isHost("youtube.com")) return /^\/shorts(?:\/|$)/.test(url.pathname) ? "youtube.com" : null;
    return DOMAINS.find(isHost) || null;
  } catch {
    return null;
  }
}

async function foregroundBrowser(args = [], signal) {
  const { stdout } = await run("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "foreground-browser.ps1"), ...args,
  ], { windowsHide: true, timeout: 5000, signal });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

function createSiteCapture(folder, getSession, onClose = () => {}) {
  let interval;
  let busy = false;
  let warned = false;
  let controller;
  let activeSession;
  let stopped = false;
  let warning;
  let addressAvailable;
  const logFile = path.join(path.dirname(folder), "site-capture.log");

  function note(message) {
    const line = new Date().toISOString() + " " + message + "\n";
    console.info("[Site Capture]", message);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 64 * 1024) {
        fs.writeFileSync(logFile, line);
      } else fs.appendFileSync(logFile, line);
    } catch {
      // Logging must not interrupt the countdown or capture.
    }
  }
  const capturedAt = new Map();
  const attemptedAt = new Map();
  const closedAt = new Map();

  function entries() {
    try {
      return fs.readdirSync(folder).filter(name => FILE.test(name)).sort().reverse();
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function prune({ all = false, reserve = 0 } = {}) {
    const cutoff = Date.now() - RETENTION_MS;
    const names = entries();
    for (const [index, name] of names.entries()) {
      if (all || index >= LIMIT - reserve || Number(name.slice(0, 13)) <= cutoff) {
        fs.rmSync(path.join(folder, name), { force: true });
      }
    }
  }

  function stop() {
    clearInterval(interval);
    interval = undefined;
    controller?.abort();
    warning = undefined;
    capturedAt.clear();
    attemptedAt.clear();
    closedAt.clear();
    prune({ all: true });
  }

  prune();

  async function check() {
    const session = getSession();
    if (!session || stopped || busy) return;
    busy = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      prune();
      const before = await foregroundBrowser([], signal);
      if (signal.aborted || getSession() !== session) return;
      if (Boolean(before?.url) !== addressAvailable) {
        addressAvailable = Boolean(before?.url);
        note(addressAvailable ? "Foreground browser address readable." : "No readable foreground browser address.");
      }
      const domain = identifySite(before?.url);
      if (warning && (before?.handle !== warning.handle || domain !== warning.domain)) {
        warning = undefined;
        note("Close canceled because the active tab changed.");
      }

      if (!domain || getSession() !== session || Date.now() - (closedAt.get(domain) || 0) < COOLDOWN_MS) return;
      const now = Date.now();
      if (!warning) {
        if (now - (attemptedAt.get(domain) || 0) < 5000) return;
        warning = { handle: before.handle, domain, detectedAt: now, deadline: null };
        note("Detected " + domain);
        if (Notification.isSupported()) {
          new Notification({ title: "IronWill · Distraction detected", body: "Nice try opening " + domain + ". Back to work.", silent: true }).show();
        }
        return;
      }
      if (warning.deadline === null) {
        if (now - warning.detectedAt < DWELL_MS) return;
        warning.deadline = now + WARNING_MS;
        if (Notification.isSupported()) {
          const toast = new Notification({ title: "Distraction detected", body: "Closing " + domain + " in 5 seconds — this site is blocked during your focus session." });
          toast.on("failed", () => note("Desktop warning failed."));
          toast.show();
          note("Requested desktop warning for " + domain);
        } else {
          note("Desktop notifications unavailable.");
        }
        return;
      }
      if (now < warning.deadline) return;
      warning = undefined;
      attemptedAt.set(domain, now);
      const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 1280, height: 720 } });
      const source = sources.find(item => item.id === "window:" + before.handle + ":0");
      if (signal.aborted || getSession() !== session) return;
      const after = await foregroundBrowser([], signal);
      if (after?.handle !== before.handle || after.url !== before.url || signal.aborted || getSession() !== session) return;
      if (source && !source.thumbnail.isEmpty() && Date.now() - (capturedAt.get(domain) || 0) >= COOLDOWN_MS) {
        fs.mkdirSync(folder, { recursive: true });
        prune({ reserve: 1 });
        fs.writeFileSync(path.join(folder, Date.now() + "-" + domain + ".jpg"), source.thumbnail.toJPEG(75), { flag: "wx" });
        capturedAt.set(domain, Date.now());
        console.info("[Site Capture] Saved snapshot for", domain);
      } else if (!source || source.thumbnail.isEmpty()) {
        console.warn("[Site Capture] Window snapshot unavailable for", domain);
      }
      const result = await foregroundBrowser(["-ExpectedHandle", before.handle, "-ExpectedUrl", before.url], signal);
      if (result?.closeRequested) {
        closedAt.set(domain, Date.now());
        note("Sent close-tab shortcut for " + domain);
        if (getSession() === session) onClose(session, domain);
      } else console.info("[Site Capture] Close skipped because the tab changed.");
    } catch (error) {
      if (!signal.aborted) warning = undefined;
      if (!signal.aborted && !warned) note("Browser inspection or capture failed (" + (error.killed ? "probe timed out" : error.name) + ").");
      if (!signal.aborted) warned = true;
    } finally {
      busy = false;
    }
  }

  return {
    update() {
      if (process.platform !== "win32" || stopped) return;
      const session = getSession();
      if (session === activeSession) return;
      stop();
      activeSession = session;
      if (session) {
        addressAvailable = undefined;
        note("Monitoring started.");
        interval = setInterval(check, POLL_MS);
        void check();
      }
    },
    shutdown() {
      stopped = true;
      stop();
    },
    list() {
      prune();
      return entries().map(name => {
        const [, timestamp, domain] = name.match(FILE);
        const image = fs.readFileSync(path.join(folder, name));
        return { timestamp: Number(timestamp), domain, image: "data:image/jpeg;base64," + image.toString("base64") };
      });
    },
  };
}

module.exports = { createSiteCapture, identifySite };
