(function () {
  const api = window.focusAPI;
  const DAY_MS = 86400000;
  let range = "week";
  let isConnected = false;
  let requestId = 0;
  let hideTimer;
  const dashboard = document.getElementById("analytics-dashboard");
  const gate = document.getElementById("analytics-gate");
  const loadMessage = document.getElementById("analytics-load-message");
  const retry = document.getElementById("analytics-retry");
  retry.addEventListener("click", render);

  const appNames = new Map([
    ["com.instagram.android", "Instagram"],
    ["com.zhiliaoapp.musically", "TikTok"],
    ["com.google.android.youtube", "YouTube"],
    ["com.twitter.android", "X"],
    ["com.reddit.frontpage", "Reddit"],
  ]);

  function showPairingGate() {
    clearTimeout(hideTimer);
    loadMessage.hidden = true;
    retry.hidden = true;
    dashboard.inert = true;
    delete dashboard.dataset.ready;
    gate.hidden = false;
    delete gate.dataset.dismissed;
  }

  function setConnectionState(connected) {
    if (isConnected === connected) return;
    isConnected = connected;
    if (connected) render();
    else {
      requestId++;
      showPairingGate();
    }
  }

  const APP_ORDER = ["Instagram", "TikTok", "YouTube", "X", "Reddit"];

  document.querySelectorAll("[data-range]").forEach((button) => {
    button.addEventListener("click", () => {
      range = button.getAttribute("data-range");
      render();
    });
  });

  function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function rangeStart() {
    const now = Date.now();
    if (range === "last-week") return startOfDay(now) - ((new Date().getDay() + 6) % 7 + 7) * DAY_MS;
    if (range === "30") return startOfDay(now) - 29 * DAY_MS;
    return startOfDay(now) - ((new Date().getDay() + 6) % 7) * DAY_MS;
  }

  function inRange(timestamp, from, to) {
    return timestamp >= from && timestamp < to;
  }

  function hoursLabel(minutes) {
    return (minutes / 60).toFixed(1);
  }

  function computeStreak(sessions) {
    const days = new Set(sessions.map((item) => startOfDay(item.endedAt)));
    let streak = 0;
    let cursor = startOfDay(Date.now());
    if (!days.has(cursor)) cursor -= DAY_MS;
    while (days.has(cursor)) {
      streak += 1;
      cursor -= DAY_MS;
    }
    return streak;
  }

  async function render() {
    if (!api || !isConnected) return;
    const request = ++requestId;
    loadMessage.textContent = "Loading analytics…";
    loadMessage.hidden = dashboard.hasAttribute("data-ready");
    retry.hidden = true;
    try {
      await renderDashboard(request);
    } catch (error) {
      if (request !== requestId || !isConnected) return;
      console.error("Unable to render analytics", error);
      loadMessage.textContent = "Unable to load analytics.";
      loadMessage.hidden = false;
      retry.hidden = false;
    }
  }

  async function renderDashboard(request) {
    const from = rangeStart();
    const to = range === "last-week" ? from + 7 * DAY_MS : Date.now() + DAY_MS;
    const stats = await api.getAnalytics(from, to);
    if (request !== requestId || !isConnected) return;
    if (stats?.connected === false) {
      document.body.dataset.phoneState = "disconnected";
      setConnectionState(false);
      return;
    }
    if (!stats?.connected) throw new Error("Missing analytics response");
    const sessions = Array.isArray(stats.sessions) ? stats.sessions.filter(Boolean) : [];
    const slice = sessions.filter((item) => inRange(item.endedAt, from, to));
    const prevFrom = from - (to - from);
    const prevSlice = sessions.filter((item) => inRange(item.endedAt, prevFrom, from));

    const minutes = slice.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
    const prevMinutes = prevSlice.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
    const lookAwayEvents = Array.isArray(stats.lookAwayEvents) ? stats.lookAwayEvents : [];
    const lookAways = lookAwayEvents.length
      ? lookAwayEvents.filter((ts) => inRange(ts, from, to)).length
      : slice.reduce((sum, item) => sum + (Number(item.lookAways) || 0), 0);

    const focusEl = document.getElementById("stat-focus-hours");
    const lookEl = document.getElementById("stat-lookaways");
    const deltaEl = document.getElementById("stat-focus-delta");
    if (focusEl) focusEl.textContent = hoursLabel(minutes);
    if (lookEl) lookEl.textContent = String(lookAways);
    if (deltaEl) {
      const delta = (minutes - prevMinutes) / 60;
      const sign = delta >= 0 ? "+" : "";
      deltaEl.textContent = `${sign}${delta.toFixed(1)} hrs vs. last period`;
    }

    const attempts = Object.create(null);
    const windows = ["Morning", "Afternoon", "Evening", "Night"];
    const counts = [0, 0, 0, 0];
    for (const log of Array.isArray(stats.logs) ? stats.logs.filter(Boolean) : []) {
      if (log.event_type !== "BLOCKED") continue;
      const hour = new Date(log.timestamp).getHours();
      counts[hour < 6 || hour >= 21 ? 3 : hour < 12 ? 0 : hour < 17 ? 1 : 2]++;
      const name = appNames.get(log.package_name) || log.package_name;
      attempts[name] = (attempts[name] || 0) + 1;
    }
    const ranked = Object.entries(attempts).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const topNameEl = document.getElementById("stat-top-app");
    const topDetailEl = document.getElementById("stat-top-app-detail");
    if (topNameEl) topNameEl.textContent = top ? top[0] : "—";
    if (topDetailEl) {
      const count = top ? top[1] : 0;
      const shielded = ((count * 9) / 60).toFixed(1);
      topDetailEl.textContent = `${count} attempts blocked · ${shielded} hrs shielded`;
    }

    const streak = computeStreak(sessions);
    const streakEl = document.getElementById("stat-streak");
    if (streakEl) streakEl.textContent = `${streak}-day streak`;

    const dailySummary = document.getElementById("stat-daily-summary");
    if (dailySummary) {
      dailySummary.textContent = `${hoursLabel(minutes)} hrs completed · 2.0h/day target`;
    }

    const bars = document.querySelectorAll("#daily-focus-bars > [data-dow]");
    const weekStart = range === "last-week" ? from : startOfDay(Date.now()) - ((new Date().getDay() + 6) % 7) * DAY_MS;
    let met = 0;
    let weekMinutes = 0;
    bars.forEach((col, index) => {
      const dayStart = weekStart + index * DAY_MS;
      const dayMinutes = sessions
        .filter((item) => startOfDay(item.endedAt) === dayStart)
        .reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
      weekMinutes += dayMinutes;
      const hours = dayMinutes / 60;
      if (hours >= 2) met += 1;
      const label = col.querySelector("[data-hours]");
      const fill = col.querySelector("[data-bar]");
      if (label) label.textContent = `${hours.toFixed(1)}h`;
      if (fill) fill.style.height = `${Math.min(100, Math.round((hours / 3.1) * 100))}%`;
    });
    const pace = document.getElementById("stat-goal-pace");
    if (pace) pace.textContent = `Avg: ${hoursLabel(weekMinutes / (range === "last-week" ? 7 : (new Date().getDay() + 6) % 7 + 1))}h/day`;
    const metEl = document.getElementById("stat-days-met");
    if (metEl) metEl.textContent = `${met} of 7 days met ≥ 2.0h target`;

    const totalAttempts = ranked.reduce((sum, item) => sum + item[1], 0);
    const totalAttemptsEl = document.getElementById("stat-attempts-total");
    if (totalAttemptsEl) totalAttemptsEl.textContent = `${totalAttempts} attempts total`;
    const shieldedTotalEl = document.getElementById("stat-shielded-total");
    if (shieldedTotalEl) shieldedTotalEl.textContent = `${((totalAttempts * 9) / 60).toFixed(1)}h`;
    const peakSummary = document.getElementById("stat-peak-summary");
    if (peakSummary) peakSummary.textContent = `Concentration of ${totalAttempts} blocked interruption attempts`;

    const distribution = document.getElementById("peak-distribution");
    if (distribution) {
      distribution.replaceChildren(...windows.map((name, index) => {
        const tile = document.createElement("div");
        tile.className = "rounded-lg bg-[#202020] p-2 text-center text-xs text-neutral-300";
        const pct = totalAttempts ? Math.round(counts[index] / totalAttempts * 100) : 0;
        tile.textContent = name + " · " + counts[index] + " (" + pct + "%)";
        return tile;
      }));
    }
    const peakWindow = document.getElementById("stat-peak-window");
    if (peakWindow) {
      const peak = Math.max(...counts);
      peakWindow.textContent = peak ? "Peak window: " + windows.filter((_, index) => counts[index] === peak).join(", ") : "No blocked attempts in this period";
    }

    APP_ORDER.forEach((name) => {
      const row = document.querySelector(`[data-breakdown="${name}"]`);
      if (!row) return;
      const count = attempts[name] || 0;
      const pct = totalAttempts ? Math.round((count / totalAttempts) * 100) : 0;
      const hours = ((count * 9) / 60).toFixed(1);
      const countEl = row.querySelector("[data-count]");
      const pctEl = row.querySelector("[data-pct]");
      const hoursEl = row.querySelector("[data-shielded]");
      const bar = row.querySelector("[data-bar]");
      if (countEl) countEl.textContent = `${count} attempts`;
      if (pctEl) pctEl.textContent = `${pct}% of attempts`;
      if (hoursEl) hoursEl.textContent = `${hours}h shielded`;
      if (bar) bar.style.width = `${Math.min(100, pct)}%`;
    });
    loadMessage.hidden = true;
    retry.hidden = true;
    dashboard.dataset.ready = "";
    dashboard.inert = false;
    gate.dataset.dismissed = "";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { gate.hidden = true; }, 200);
  }

  window.addEventListener("focus:phone-status", event => setConnectionState(event.detail));
  showPairingGate();
  api?.onAnalyticsUpdated?.(() => { if (isConnected) render(); });
})();
