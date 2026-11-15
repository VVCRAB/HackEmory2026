(function () {
  const api = window.focusAPI;
  const DAY_MS = 86400000;
  let range = "today";
  const samples = {
    today: { usage: [1.4, .8, 2.1, .3, .5], hours: [0, 0, .6, .4, .8, .3, .5], total: 2.6, delta: "+24%", pace: 130, alerts: 3, trend: "1 fewer than yesterday", streak: 4, average: 2.6, attempts: [13, 7, 9, 3, 2], hourly: [0,0,0,0,0,0,0,1,2,2,1,0,1,2,3,1,1,1,2,1,3,5,3,2] },
    "last-week": { usage: [3.6, 3.2, 4.7, 1.1, 2.3], hours: [1.7, 2, 1.4, 2.2, 1.6, 2.1, 2.6], total: 13.6, delta: "+9%", pace: 86, alerts: 15, trend: "−6% vs. prior period", streak: 2, average: 1.7, attempts: [19, 27, 12, 6, 4], hourly: [0, 0, 0, 0, 0, 0, 1, 2, 4, 6, 5, 4, 3, 4, 6, 5, 3, 2, 2, 3, 4, 6, 5, 4] },
    "30": { usage: [18.4, 12.6, 21.7, 5.8, 8.2], hours: [1.2,2.1,0.5,1.8,2.4,1.1,1.7,0.5,2.2,1.5,1.4,2.6,0.5,1.9,1.2,2.3,0.5,1.6,2.8,1.1,1.5,0.5,2.4,1.2,2.1,1.7,0.5,2.4,1.4,0.9], total: 45.5, delta: "+16%", pace: 76, alerts: 142, trend: "−15% vs. prior period", streak: 6, average: 1.5, attempts: [135, 91, 146, 42, 20], hourly: [2, 1, 0, 0, 0, 1, 3, 5, 8, 13, 16, 21, 24, 29, 38, 33, 21, 15, 13, 16, 24, 37, 35, 23] },
  };
  let isConnected = false;
  let requestId = 0;
  let hideTimer;
  const dashboard = document.getElementById("analytics-dashboard");
  const gate = document.getElementById("analytics-gate");
  const loadMessage = document.getElementById("analytics-load-message");
  const retry = document.getElementById("analytics-retry");
  retry.addEventListener("click", render);
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let pulsed = [];
  function present(el, text) {
    if (!el) return;
    const next = String(text);
    if (el.textContent === next) return;
    el.dataset.iwReady = "1";
    el.textContent = next;
    pulsed.push(el);
  }
  function flushPulse() {
    const pending = pulsed;
    pulsed = [];
    if (reduceMotion()) return;
    for (const el of pending) {
      el.classList.remove("iw-bounce");
      void el.offsetWidth;
      el.classList.add("iw-bounce");
    }
  }

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
      document.querySelectorAll("[data-range]").forEach(pill => pill.setAttribute("aria-pressed", String(pill === button)));
      render();
    });
  });

  function renderPeakCurve(counts) {
    const peak = Math.max(...counts);
    const scale = Math.max(16, peak);
    const points = counts.map((count, hour) => ({ x: hour * 480 / 24, y: 94 - count * 82 / scale }));
    points.push({ x: 480, y: points[0].y });
    let curve = "M0 " + points[0].y;
    for (let i = 1; i < points.length; i++) {
      const previous = points[i - 1];
      const next = points[i];
      const middle = (previous.x + next.x) / 2;
      curve += " C" + middle + " " + previous.y + " " + middle + " " + next.y + " " + next.x + " " + next.y;
    }
    document.getElementById("peak-line").setAttribute("d", curve);
    document.getElementById("peak-area").setAttribute("d", curve + " L480 94 H0 Z");
    const hour = counts.indexOf(peak);
    const label = (hour % 12 || 12) + ":00 " + (hour < 12 ? "AM" : "PM");
    const summary = peak ? "Peak hour: " + label + " · " + peak + " attempts" : "No blocked attempts in this period";
    document.getElementById("stat-peak-window").textContent = summary;
    document.getElementById("peak-curve-title").textContent = "Blocked attempts by hour. " + summary;
  }

  function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function dailyShare(total, index) {
    return Math.round(total * (index + 1) / 30) - Math.round(total * index / 30);
  }

  function rangeStart() {
    const now = Date.now();
    if (range === "last-week") return startOfDay(now) - ((new Date().getDay() + 6) % 7 + 7) * DAY_MS;
    if (range === "30") {
      const start = new Date(startOfDay(now));
      start.setDate(start.getDate() - 29);
      return start.getTime();
    }
    return startOfDay(now);
  }

  function inRange(timestamp, from, to) {
    return timestamp >= from && timestamp < to;
  }

  function hoursLabel(minutes) {
    return (minutes / 60).toFixed(1);
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
    pulsed = [];
    const from = rangeStart();
    const to = range === "last-week" ? from + 7 * DAY_MS : startOfDay(Date.now()) + DAY_MS;
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

    const logs = Array.isArray(stats.logs) ? stats.logs.filter(Boolean) : [];
    const sample = samples[range];
    // Use calendar dates so daylight-saving changes do not shift monthly entries.
    const dayKey = timestamp => new Date(timestamp).toDateString();
    const monthly = range === "30";
    const monthDays = monthly ? sample.hours.map((_, index) => {
      const date = new Date(from);
      date.setDate(date.getDate() + index);
      return dayKey(date);
    }) : [];
    const recordedFocusDays = new Set(slice.map(item => dayKey(item.endedAt)));
    const recordedBlockDays = new Set(logs.filter(log => log.event_type === "BLOCKED").map(log => dayKey(log.timestamp)));
    const recordedAlertDays = new Set(logs.filter(log => log.event_type === "LOOK_AWAY").map(log => dayKey(log.timestamp)));
    const missingFocusHours = monthDays.map((day, index) => recordedFocusDays.has(day) ? 0 : sample.hours[index]);
    const sampleFocus = !slice.length;
    const sampleBlocks = !logs.some(log => log.event_type === "BLOCKED");
    const sampleAlerts = !logs.some(log => log.event_type === "LOOK_AWAY");
    document.getElementById("analytics-sample-label").hidden = false;
    const minutes = sampleFocus ? sample.total * 60 : slice.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0) + missingFocusHours.reduce((sum, hours) => sum + hours * 60, 0);
    const prevMinutes = prevSlice.reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
    const lookAwayEvents = Array.isArray(stats.lookAwayEvents) ? stats.lookAwayEvents : [];
    const lookAways = lookAwayEvents.length
      ? lookAwayEvents.filter((ts) => inRange(ts, from, to)).length
      : slice.reduce((sum, item) => sum + (Number(item.lookAways) || 0), 0);

    const focusEl = document.getElementById("stat-focus-hours");
    const lookEl = document.getElementById("stat-lookaways");
    const deltaEl = document.getElementById("stat-focus-delta");
    if (focusEl) present(focusEl, hoursLabel(minutes));
    if (lookEl) present(lookEl, monthly ? lookAways + monthDays.reduce((sum, day, index) => sum + (recordedAlertDays.has(day) ? 0 : dailyShare(sample.alerts, index)), 0) : sampleAlerts ? sample.alerts : lookAways);
    document.getElementById("stat-look-trend").textContent = sampleAlerts ? sample.trend : "";
    if (deltaEl) {
      const delta = (minutes - prevMinutes) / 60;
      const sign = delta >= 0 ? "+" : "";
      deltaEl.textContent = sampleFocus ? sample.delta + " vs. prior period" : `${sign}${delta.toFixed(1)} hrs vs. last period`;
    }

    const attempts = Object.create(null);
    const counts = Array(24).fill(0);
    const fallbackAttempts = sample.attempts.map(total => monthly
      ? monthDays.reduce((sum, day, index) => sum + (recordedBlockDays.has(day) ? 0 : dailyShare(total, index)), 0)
      : sampleBlocks ? total : 0);
    {
      // Distribute the same sample attempts shown in the app breakdown.
      const total = fallbackAttempts.reduce((sum, count) => sum + count, 0);
      const weight = sample.hourly.reduce((sum, count) => sum + count, 0);
      let cumulative = 0;
      sample.hourly.forEach((value, hour) => {
        const previous = Math.round(cumulative * total / weight);
        cumulative += value;
        counts[hour] = Math.round(cumulative * total / weight) - previous;
      });
    }
    APP_ORDER.forEach((name, i) => { if (fallbackAttempts[i]) attempts[name] = fallbackAttempts[i]; });
    for (const log of logs) {
      if (log.event_type !== "BLOCKED") continue;
      const hour = new Date(log.timestamp).getHours();
      if (Number.isInteger(hour)) counts[hour]++;
      const name = appNames.get(log.package_name) || log.package_name;
      attempts[name] = (attempts[name] || 0) + 1;
    }
    const ranked = Object.entries(attempts).sort((a, b) => b[1] - a[1]);
    const top = range === "today" ? ["Instagram", attempts.Instagram ?? 0] : ranked[0];
    const topNameEl = document.getElementById("stat-top-app");
    const topDetailEl = document.getElementById("stat-top-app-detail");
    const featuredIcon = document.getElementById("stat-top-icon");
    const icon = top && document.querySelector('[data-breakdown="' + APP_ORDER.find(name => name === top[0]) + '"] svg')?.parentElement;
    featuredIcon.replaceChildren();
    if (icon) {
      const copy = icon.cloneNode(true);
      copy.setAttribute("aria-hidden", "true");
      featuredIcon.append(copy);
    } else if (top) featuredIcon.textContent = top[0].charAt(0).toUpperCase();
    if (topNameEl) present(topNameEl, top ? top[0] : "—");
    if (topDetailEl) {
      const count = top ? top[1] : 0;
      const shielded = (count * 9.3 / 60).toFixed(1);
      topDetailEl.textContent = `${count} attempts blocked · ${shielded} hrs shielded`;
    }

    showStreak(stats.streak);
    const days = range === "today" ? 1 : range === "30" ? 30 : 7;

    const dailySummary = document.getElementById("stat-daily-summary");
    if (dailySummary) {
      dailySummary.textContent = `${hoursLabel(minutes)} hrs completed · 2.0h/day target`;
    }

    const chart = document.getElementById("daily-focus-bars");
    const columnCount = monthly ? 30 : 7;
    let bars = [...chart.querySelectorAll("[data-dow]")];
    const template = bars[0];
    for (const bar of bars.slice(columnCount)) bar.remove();
    for (let i = bars.length; i < columnCount; i++) chart.append(template.cloneNode(true));
    bars = [...chart.querySelectorAll("[data-dow]")];
    chart.classList.toggle("monthly-focus-chart", monthly);
    const chartMinutes = Array(columnCount).fill(0);
    for (const item of slice) {
      const date = new Date(item.endedAt);
      const day = Math.round((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) -
        Date.UTC(new Date(from).getFullYear(), new Date(from).getMonth(), new Date(from).getDate())) / DAY_MS);
      const bucket = monthly ? day : range === "today" ? Math.floor(date.getHours() * 7 / 24) : (date.getDay() + 6) % 7;
      if (bucket >= 0 && bucket < columnCount) chartMinutes[bucket] += Number(item.minutes) || 0;
    }
    const chartHours = sampleFocus ? sample.hours : chartMinutes.map((value, index) => value / 60 + (missingFocusHours[index] || 0));
    const ceiling = Math.max(3.1, ...chartHours);
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const times = ["12 AM", "4 AM", "7 AM", "11 AM", "2 PM", "6 PM", "9 PM"];
    bars.forEach((col, index) => {
      const date = new Date(from);
      date.setDate(date.getDate() + index);
      const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      const label = chartHours[index].toFixed(1) + "h";
      col.querySelector("[data-hours]").textContent = label;
      col.querySelector("[data-bar]").style.height = Math.round(chartHours[index] / ceiling * 100) + "%";
      const caption = col.lastElementChild;
      caption.textContent = monthly ? dateLabel : (range === "today" ? times : weekdays)[index];
      caption.hidden = monthly && ![0, 7, 14, 21, 29].includes(index);
      caption.style.color = range === "last-week" && index === 6 ? "#e05a2b" : "#a3a3a3";
      col.title = caption.textContent + " · " + label;
    });
    const pace = document.getElementById("stat-goal-pace");
    if (pace) pace.textContent = "Avg: " + hoursLabel(minutes / days) + "h/day";
    const metEl = document.getElementById("stat-days-met");
    if (metEl) metEl.textContent = range === "today" ? "Focus by time of day"
      : range === "30" ? chartHours.filter(hours => hours > 0).length + " active days out of 30"
      : chartHours.filter(hours => hours >= 2).length + " of 7 days met ≥ 2.0h target";

    const totalAttempts = ranked.reduce((sum, item) => sum + item[1], 0);
    const totalAttemptsEl = document.getElementById("stat-attempts-total");
    if (totalAttemptsEl) totalAttemptsEl.textContent = `${totalAttempts} attempts total`;
    const shieldedTotalEl = document.getElementById("stat-shielded-total");
    if (shieldedTotalEl) shieldedTotalEl.textContent = `${(totalAttempts * 9.3 / 60).toFixed(1)}h`;
    const peakSummary = document.getElementById("stat-peak-summary");
    if (peakSummary) peakSummary.textContent = `Concentration of ${totalAttempts} blocked interruption attempts`;

    renderPeakCurve(counts);

    APP_ORDER.forEach((name, index) => {
      const row = document.querySelector(`[data-breakdown="${name}"]`);
      if (!row) return;
      const count = attempts[name] || 0;
      const pct = totalAttempts ? Math.round((count / totalAttempts) * 100) : 0;
      const hours = (count * 9.3 / 60).toFixed(1);
      row.querySelector("[data-usage]").textContent = sample.usage[index].toFixed(1) + "h unmanaged";
      const countEl = row.querySelector("[data-count]");
      const pctEl = row.querySelector("[data-pct]");
      const hoursEl = row.querySelector("[data-shielded]");
      const bar = row.querySelector("[data-bar]");
      if (countEl) countEl.textContent = `${count} blocked ${count === 1 ? "attempt" : "attempts"}`;
      if (pctEl) pctEl.textContent = `${pct}% of attempts`;
      if (hoursEl) hoursEl.textContent = `${hours}h shielded`;
      if (bar) bar.style.width = `${Math.min(100, pct)}%`;
    });
    loadMessage.hidden = true;
    retry.hidden = true;
    dashboard.dataset.ready = "";
    dashboard.classList.remove("iw-refresh");
    void dashboard.offsetWidth;
    dashboard.classList.add("iw-refresh");
    flushPulse();
    dashboard.inert = false;
    gate.dataset.dismissed = "";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { gate.hidden = true; }, 200);
  }

  window.addEventListener("focus:phone-status", event => setConnectionState(event.detail));
  showPairingGate();
  function showStreak(streak) {
    if (range !== "today" && !Number.isSafeInteger(streak)) return;
    present(document.getElementById("stat-streak"), range === "today" ? "1-day streak" : streak + "-session streak");
  }
  api?.onAnalyticsUpdated?.(() => { if (isConnected) render(); });
})();
