(function () {
  const api = window.focusAPI;
  const PRESETS = [25, 50, 90];
  let totalSeconds = 50 * 60;
  let plannedSeconds = 50 * 60;
  let isRunning = false;
  let timerReady = false;
  let gazePaused = false;
  const AWAY_GRACE_MS = 6000;
  const GAZE_QUACK_MS = 2000;
  let gazeQuacked = false;
  const AWAY_VIBRATION_MS = 11000;
  let awayReminderSent = false;
  let focusSessionId;
  let lastPreset = 50;
  let lockMode = "SELECTED";
  let awayStartedAt = null;

  let cameraStream = null;
  let detectTimer = null;
  let faceLandmarker = null;
  let usingFallback = false;
  const videoEl = document.getElementById("camera-preview-video");
  const eyeHud = document.createElement("canvas");
  eyeHud.setAttribute("aria-hidden", "true");
  eyeHud.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform:scaleX(-1);pointer-events:none";
  videoEl.after(eyeHud);
  const gazeDebug = document.createElement("pre");
  gazeDebug.style.cssText = "position:absolute;right:8px;bottom:8px;z-index:20;margin:0;padding:6px 8px;background:#121214e8;color:#e5e5e5;border-radius:6px;font:11px monospace;pointer-events:none";
  videoEl.parentElement.append(gazeDebug);
  const hudContext = eyeHud.getContext("2d");
  const EYES = [
    { iris: 468, rim: [469, 470, 471, 472], contour: [33, 160, 158, 133, 153, 144] },
    { iris: 473, rim: [474, 475, 476, 477], contour: [362, 385, 387, 263, 373, 380] },
  ];
  const AWAY_THRESHOLD_FRAMES = 2;
  const YAW_LIMIT_DEG = 18;
  const PITCH_LIMIT_DEG = 16;
  const toDegrees = radians => radians * 180 / Math.PI;
  let baselineOffset = null;
  let calibrationStartedAt = null;
  let calibrationSum = { head: { yaw: 0, pitch: 0 }, eyes: EYES.map(() => ({ x: 0, y: 0 })), count: 0 };
  let consecutiveAwayFrames = 0;
  let lastVideoTime = -1;
  let currentDeviceId = "";

  const displayHours = document.getElementById("display-hours");
  const displayMinutes = document.getElementById("display-minutes");
  const displaySeconds = document.getElementById("display-seconds");
  const timerFields = [displayHours, displayMinutes, displaySeconds];
  const sessionToggleBtn = document.getElementById("session-toggle-btn");
  const sessionToggleLabel = document.getElementById("session-toggle-label");
  const sessionResetBtn = document.getElementById("session-reset-btn");
  const adjustUp = document.getElementById("adjust-up");
  const adjustDown = document.getElementById("adjust-down");
  const presetButtons = document.querySelectorAll(".preset-btn");
  const cameraToggle = document.getElementById("camera-toggle-input");
  const inlineVideo = document.getElementById("presence-inline-video");
  const inlinePlaceholder = document.getElementById("camera-placeholder");
  const previewPlaceholder = document.getElementById("modal-camera-placeholder");
  const cameraPreviewDialog = document.getElementById("camera-preview-dialog");
  const gazeLabel = document.getElementById("gaze-label");
  const cameraSelectors = document.querySelectorAll("[data-camera-select]");

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function bounce(el) {
    if (!el || reduceMotion()) return;
    el.classList.remove("iw-bounce");
    void el.offsetWidth;
    el.classList.add("iw-bounce");
  }

  function paintDigit(el, value) {
    if (!el) return;
    const next = pad(value);
    if (el instanceof HTMLInputElement && document.activeElement === el && !el.readOnly) return;
    const current = el instanceof HTMLInputElement ? el.value : el.textContent;
    if (el instanceof HTMLInputElement) el.value = next;
    else el.textContent = next;
    if (current === next || reduceMotion()) return;
    el.classList.remove("iw-tick");
    void el.offsetWidth;
    el.classList.add("iw-tick");
  }

  function updateDisplay() {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    paintDigit(document.getElementById("active-hours"), hrs);
    paintDigit(document.getElementById("active-minutes"), mins);
    paintDigit(document.getElementById("active-seconds"), secs);
    [hrs, mins, secs].forEach((value, index) => paintDigit(timerFields[index], value));
  }

  function selectedApps() {
    return Array.from(document.querySelectorAll(".app-row .app-toggle:not(:disabled):checked")).map((input) => {
      return input.getAttribute("data-app") || "App";
    });
  }

  function lockPayload() {
    return {
      mode: lockMode,
      selectedPackages: selectedApps(),
      apps: lockMode === "FULL" ? ["*"] : selectedApps(),
    };
  }

  function syncPhoneRules() {
    if (!api) return;
    const rules = lockPayload();
    const update = rules.apps.length ? api.lockPhone(rules) : api.unlockPhone(rules);
    update.catch(reportPhoneError);
    refreshTodayStats();
  }

  function reportPhoneError(error) {
    console.error("Phone lock update failed", error);
    document.getElementById("phone-lock-error").textContent = "Could not update phone lock.";
    document.getElementById("active-block-error").textContent = "Could not update phone lock.";
  }

  function renderTimer(state) {
    const previousSession = focusSessionId;
    const wasActive = Boolean(previousSession);
    totalSeconds = state.remainingSeconds;
    plannedSeconds = state.plannedSeconds;
    lastPreset = state.preset;
    focusSessionId = state.sessionId;
    isRunning = state.endTime !== null;
    gazePaused = state.gazePaused;
    timerReady = true;
    renderFocusProgress(state.progress, previousSession);
    document.body.toggleAttribute("data-focus-active", Boolean(focusSessionId));
    document.getElementById("active-focus").hidden = !focusSessionId;
    if (wasActive !== Boolean(focusSessionId)) {
      if (focusSessionId && cameraPreviewDialog.open) cameraPreviewDialog.close();
      renderActiveBlocker();
      if (focusSessionId) {
        document.getElementById("end-focus-session").focus();
        if (!cameraToggle.checked) {
          cameraToggle.checked = true;
          cameraToggle.dispatchEvent(new Event("change"));
        }
      }
      else requestAnimationFrame(() => sessionToggleBtn.focus());
    }
    timerFields.forEach(input => { input.readOnly = Boolean(focusSessionId); });
    sessionResetBtn.hidden = Boolean(focusSessionId);
    presetButtons[0].parentElement.hidden = Boolean(focusSessionId);
    adjustDown.parentElement.hidden = Boolean(focusSessionId);
    sessionToggleBtn.disabled = Boolean(focusSessionId) || !plannedSeconds;
    sessionToggleLabel.textContent = gazePaused ? "Session paused" : isRunning ? "Session running" : "Start Focus Session";
    for (const control of [adjustUp, adjustDown, ...presetButtons]) control.disabled = Boolean(focusSessionId);
    const pauseOverlay = document.getElementById("presence-pause-status");
    const showGazePause = gazePaused && !state.messagingPaused && !state.paymentPaused;
    pauseOverlay.dataset.paused = String(showGazePause);
    pauseOverlay.setAttribute("aria-hidden", String(!showGazePause));
    document.getElementById("active-focus").inert = showGazePause;
    if (!focusSessionId) {
      awayStartedAt = null;
      awayReminderSent = false;
    }
    if (wasActive && !focusSessionId) {
      if (cancelDialog.open) cancelDialog.close();
      cameraToggle.checked = false;
      updateCameraControls();
      stopCamera();
      if (totalSeconds === 0) celebrateCompletion();
      refreshTodayStats();
    }
    markPreset(lastPreset);
    updateDisplay();

  }

  function celebrateCompletion() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100";
    document.body.append(canvas);
    const context = canvas.getContext("2d");
    if (!context) { canvas.remove(); return; }
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const colors = ["#e05a2b", "#ffba73", "#fff4df", "#86efac", "#93c5fd"];
    const particles = Array.from({ length: 130 }, (_, index) => ({
      x: Math.random() * canvas.width, y: -Math.random() * canvas.height,
      drift: (Math.random() - 0.5) * 140, speed: 220 + Math.random() * 430,
      spin: (Math.random() - 0.5) * 12, color: colors[index % colors.length],
    }));
    const start = performance.now();
    function frame(now) {
      const time = (now - start) / 1000;
      if (time >= 2.8) { canvas.remove(); return; }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.globalAlpha = Math.min(1, (2.8 - time) * 2);
      for (const particle of particles) {
        context.save();
        context.translate(particle.x + particle.drift * time, particle.y + particle.speed * time);
        context.rotate(particle.spin * time);
        context.fillStyle = particle.color;
        context.fillRect(-4, -2, 8, 4);
        context.restore();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderFocusProgress(progress, previousSession) {
    if (!progress) return;
    const streak = progress.streak + "-session streak";
    const cardStreak = 0; // Pairing demo display.
    const streakEl = document.getElementById("today-streak");
    const nextStreak = String(cardStreak);
    if (streakEl.textContent !== nextStreak) {
      streakEl.textContent = nextStreak;
      bounce(streakEl);
    }
    document.getElementById("today-streak-unit").textContent = cardStreak === 1 ? "session" : "sessions";
    const stake = "$" + (progress.weekStakeCents / 100).toFixed(2);
    document.getElementById("focus-week-stake").textContent = "Staked in the last 7 days: " + stake + " USD";
    const events = document.getElementById("focus-events");
    const signature = JSON.stringify(progress.events);
    if (events.dataset.signature !== signature) {
      events.dataset.signature = signature;
      events.replaceChildren(...(progress.events.length ? progress.events : [{ label: "No events yet." }]).map(event => {
        const row = document.createElement("li");
        row.textContent = event.timestamp
          ? new Date(event.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " · " + event.label
          : event.label;
        return row;
      }));
    }
    window.dispatchEvent(new CustomEvent("focus-breadcrumbs", { detail: progress.earnedBreadcrumbCents }));
    const result = progress.latest;
    if (!result || result.id !== previousSession || focusSessionId) return;
    const dialog = document.getElementById("focus-result");
    document.getElementById("focus-result-title").textContent = result.completed ? "Session cleared" : "Early exit · streak reset";
    const scoreEl = document.getElementById("focus-result-score");
    scoreEl.textContent = result.score;
    bounce(scoreEl);
    const reward = document.getElementById("focus-result-reward");
    reward.hidden = !result.rewardCents;
    reward.textContent = result.rewardCents ? "+" + (result.rewardCents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " breadcrumbs earned" : "";
    const metrics = document.getElementById("focus-result-metrics");
    const seconds = result.focusedSeconds;
    const entries = [
      ["Time focused", Math.floor(seconds / 60) + "m " + seconds % 60 + "s"],
      ["Times looked away", result.lookAways],
      ["Tabs blocked", result.tabsClosed],
      ["Messages handled", result.messagesHandled],
      ["Current streak", streak],
      ["Staked this session", "$" + (result.stakeCents / 100).toFixed(2) + " USD"],
    ];
    metrics.replaceChildren(...entries.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = value;
      return [term, detail];
    }));
    if (cancelDialog.open) cancelDialog.close();
    if (!dialog.open) dialog.showModal();
  }

  function timerCommand(command, value) {
    return api?.commandTimer(command, value, focusSessionId).catch(error => console.error("Timer update failed", error));
  }

  function toggleTimer() {
    if (timerReady && !focusSessionId) timerCommand("start");
  }

  function markPreset(minutes) {
    presetButtons.forEach((btn) => {
      const active = Number(btn.getAttribute("data-minutes")) === minutes;
      btn.classList.toggle("bg-white/15", active);
      btn.classList.toggle("text-white", active);
      btn.classList.toggle("border", active);
      btn.classList.toggle("border-white/10", active);
      btn.classList.toggle("shadow-sm", active);
      btn.classList.toggle("text-neutral-400", !active);
    });
  }

  sessionToggleBtn.disabled = true;
  displayHours.readOnly = true;
  sessionToggleBtn.addEventListener("click", toggleTimer);
  sessionResetBtn.addEventListener("click", () => timerCommand("reset"));
  adjustUp.addEventListener("click", () => timerCommand("duration", plannedSeconds + 300));
  adjustDown.addEventListener("click", () => {
    if (plannedSeconds >= 300) timerCommand("duration", plannedSeconds - 300);
  });
  presetButtons.forEach(button => button.addEventListener("click", () =>
    timerCommand("preset", Number(button.dataset.minutes))));

  timerFields.forEach((input, index) => {
    input.addEventListener("focus", () => { if (!input.readOnly) input.select(); });
    input.addEventListener("input", () => { input.value = input.value.replace(/[^0-9]/g, ""); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") input.blur();
    });
    input.addEventListener("blur", () => {
      if (!timerReady || focusSessionId) return;
      const value = Math.min(index === 0 ? 23 : 59, Number(input.value) || 0);
      input.value = pad(value);
      const duration = Number(displayHours.value) * 3600 +
        Number(displayMinutes.value) * 60 + Number(displaySeconds.value);
      if (duration !== plannedSeconds) timerCommand("duration", duration);
    });
  });

  window.addEventListener("keydown", (event) => {
    if (document.body.hasAttribute("data-duck-shop")) return;
    if (event.code === "Space" && event.target.tagName !== "INPUT" && event.target.tagName !== "SELECT" && event.target.tagName !== "TEXTAREA") {
      event.preventDefault();
      toggleTimer();
    }
  });

  const modeSelectedBtn = document.getElementById("mode-selected");
  const modeLockoutBtn = document.getElementById("mode-lockout");
  const appsContainer = document.getElementById("apps-container");
  const lockoutContainer = document.getElementById("lockout-container");

  function showBlockMode(mode) {
    lockMode = mode === "FULL" ? "FULL" : "SELECTED";
    const full = lockMode === "FULL";
    for (const [button, active] of [[modeSelectedBtn, !full], [modeLockoutBtn, full]]) {
      for (const style of ["bg-white/10", "text-white", "border", "border-white/10", "shadow-sm"]) {
        button.classList.toggle(style, active);
      }
      button.classList.toggle("text-neutral-400", !active);
      button.setAttribute("aria-pressed", String(active));
    }
    appsContainer.classList.toggle("hidden", full);
    lockoutContainer.classList.toggle("hidden", !full);
    lockoutContainer.classList.toggle("flex", full);
  }

  modeSelectedBtn.addEventListener("click", () => {
    showBlockMode("SELECTED");
    syncPhoneRules();
  });
  modeLockoutBtn.addEventListener("click", () => {
    showBlockMode("FULL");
    syncPhoneRules();
  });

  const toggleAllBtn = document.getElementById("toggle-all-btn");
  toggleAllBtn.disabled = true;
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener("click", () => {
      const toggles = document.querySelectorAll(".app-row .app-toggle:not(:disabled)");
      const allOn = Array.from(toggles).every((input) => input.checked);
      toggles.forEach((input) => {
        input.checked = !allOn;
      });
      appList.dispatchEvent(new Event("change"));
    });
  }

  const appList = document.getElementById("installed-app-list");
  const selectedPackages = new Set();
  const commonApps = new Map([
    ["YouTube", "com.google.android.youtube"],
    ["Instagram", "com.instagram.android"],
    ["TikTok", "com.zhiliaoapp.musically"],
    ["Reddit", "com.reddit.frontpage"],
    ["X (Twitter)", "com.twitter.android"],
    ["Discord", "com.discord"],
  ]);
  const commonButton = document.getElementById("toggle-common-apps");
  function togglePackages(packages) {
    const toggles = [...appList.querySelectorAll(".app-toggle")].filter(toggle => packages.includes(toggle.dataset.app));
    if (!toggles.length) return;
    const enable = toggles.some(toggle => !toggle.checked);
    toggles.forEach(toggle => { toggle.checked = enable; });
    appList.dispatchEvent(new Event("change"));
  }
  commonButton.disabled = true;
  commonButton.addEventListener("click", () => togglePackages([...commonApps.values()]));
  const appSearch = document.getElementById("installed-app-search");
  const noMatchingApps = document.getElementById("installed-app-no-match");

  let appFilter = "all";
  const filterButtons = document.querySelectorAll("[data-app-filter]");
  filterButtons.forEach(button => button.addEventListener("click", () => {
    appFilter = button.dataset.appFilter === "all" ? "all"
      : appFilter === "blocked" ? "unblocked" : "blocked";
    filterButtons.forEach(tab => {
      tab.setAttribute("aria-pressed", String(tab === button));
      if (tab.dataset.appFilter === "blocked") {
        tab.textContent = appFilter === "unblocked" ? "Unblocked" : "Blocked";
        tab.title = appFilter === "blocked" ? "Show unblocked apps" : "Show blocked apps";
      }
    });
    filterInstalledApps();
  }));

  function filterInstalledApps() {
    const common = [...appList.querySelectorAll(".app-toggle")].filter(toggle =>
      [...commonApps.values()].includes(toggle.dataset.app));
    commonButton.disabled = !common.length;
    commonButton.textContent = common.length && common.every(toggle => toggle.checked)
      ? "Unblock common apps" : "Select common apps";
    const query = appSearch.value.trim().toLowerCase();
    let hasMatch = false;
    for (const row of appList.children) {
      const blocked = row.querySelector(".app-toggle").checked;
      row.hidden = !row.dataset.searchText.includes(query) ||
        (appFilter !== "all" && blocked !== (appFilter === "blocked"));
      hasMatch ||= !row.hidden;
    }
    noMatchingApps.hidden = (!query && appFilter === "all") || !appList.children.length || hasMatch;
  }

  appSearch.addEventListener("input", filterInstalledApps);
  appList.addEventListener("change", () => {
    appSearch.value = "";
    activeSearch.value = "";
    filterInstalledApps();
    selectedPackages.clear();
    selectedApps().forEach(name => selectedPackages.add(name));
    refreshTodayStats();
    syncPhoneRules();
    renderActiveBlocker();
  });

  const appStatus = document.getElementById("installed-app-status");
  let inventoryTimer;
  let inventoryRequested = false;
  async function requestInstalledApps() {
    clearTimeout(inventoryTimer);
    appStatus.textContent = "Loading apps from your phone…";
    inventoryTimer = setTimeout(() => {
      appStatus.textContent = "The phone hasn’t sent its app list. Update Focus Companion and tap Refresh apps.";
    }, 5000);
    try {
      await api.requestInstalledApps();
    } catch (error) {
      clearTimeout(inventoryTimer);
      appStatus.textContent = "Could not request the app list.";
      console.error(error);
    }
  }

  document.getElementById("refresh-installed-apps").addEventListener("click", requestInstalledApps);
  window.addEventListener("focus:phone-status", ({ detail: connected }) => {
    if (!connected) {
      clearTimeout(inventoryTimer);
      inventoryRequested = false;
    } else if (!inventoryRequested) {
      inventoryRequested = true;
      requestInstalledApps();
    }
  });
  window.addEventListener("focus:installed-apps", ({ detail: { apps, ready, error, blockMode, selectedPackages: savedPackages } }) => {
    showBlockMode(blockMode);
    selectedPackages.clear();
    savedPackages.forEach(pkg => selectedPackages.add(pkg));
    if (error && !ready) {
      clearTimeout(inventoryTimer);
      appStatus.textContent = "The phone could not read its app list. Tap Refresh apps to retry.";
      return;
    }
    if (!ready) {
      if (document.body.dataset.phoneState === "connected" && !error && !appStatus.textContent) {
        appStatus.textContent = "Waiting for the phone’s app list…";
      }
      return;
    }
    clearTimeout(inventoryTimer);
    appStatus.textContent = apps.length ? "" : "No eligible apps were found on your phone.";
    toggleAllBtn.disabled = !apps.length;
    appList.replaceChildren(...apps.sort((a, b) => a.label.localeCompare(b.label)).map(app => {
      const row = document.createElement("label");
      row.className = "app-row flex w-full min-w-0 shrink-0 cursor-pointer items-center gap-2.5 rounded-lg bg-[#1a1b1f] px-2.5 py-1.5 text-sm hover:bg-[#23252b]";
      const name = document.createElement("span");
      name.textContent = app.label || app.packageName;
      name.className = "min-w-0 flex-1 truncate";
      row.title = name.textContent;
      row.dataset.searchText = (name.textContent + " " + app.packageName).toLowerCase();
      const icon = document.createElement(app.icon ? "img" : "span");
      icon.className = "h-7 w-7 shrink-0 rounded-md bg-[#272930]";
      if (app.icon) {
        icon.src = "data:image/png;base64," + app.icon;
        icon.alt = "";
      } else {
        icon.classList.add("grid", "place-items-center");
        icon.textContent = name.textContent[0].toUpperCase();
      }
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "app-toggle phone-app-switch";
      toggle.setAttribute("role", "switch");
      toggle.dataset.app = app.packageName;
      toggle.checked = selectedPackages.has(app.packageName);
      row.append(icon, name, toggle);
      return row;
    }));
    filterInstalledApps();
    renderActiveBlocker();
    refreshTodayStats();
  });



  function setGaze(looking) {
    if (looking || (!isRunning && !gazePaused)) awayStartedAt = null;
    else if (awayStartedAt === null) {
      awayStartedAt = Date.now();
      if (focusSessionId && isRunning) timerCommand("look-away");
    }
    const elapsed = awayStartedAt === null ? 0 : Date.now() - awayStartedAt;
    if (awayStartedAt === null) {
      awayReminderSent = false;
      gazeQuacked = false;
    }
    if (focusSessionId && isRunning && !looking && elapsed >= GAZE_QUACK_MS && !gazeQuacked) {
      gazeQuacked = true;
      window.dispatchEvent(new CustomEvent("ironwill-gaze"));
    }
    if (focusSessionId && !looking && elapsed >= AWAY_VIBRATION_MS && !awayReminderSent) {
      awayReminderSent = true;
      api?.vibrateForLookAway(focusSessionId).catch(error => console.error("Phone reminder failed", error));
    }
    const status = looking ? "Focused" : focusSessionId
      ? "Looking away (" + Math.min(6, Math.floor(elapsed / 1000)) + "s / 6s)"
      : "Looking away";
    for (const badge of [gazeLabel, document.getElementById("presence-status")]) {
      if (badge.textContent !== status) badge.textContent = status;
      badge.style.color = looking ? "#86efac" : "#fbbf24";
    }
    if (!looking && isRunning && elapsed >= AWAY_GRACE_MS) {
      isRunning = false;
      timerCommand("pause-gaze");
    } else if (looking && gazePaused) {
      gazePaused = false;
      timerCommand("resume");
    }
  }

  let cameraRequest = 0;
  function stopCamera() {
    cameraRequest++;
    if (detectTimer) {
      cancelAnimationFrame(detectTimer);
      detectTimer = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    videoEl.srcObject = null;
    inlineVideo.srcObject = null;
    inlineVideo.hidden = true;
    inlinePlaceholder.hidden = false;
    videoEl.hidden = true;
    previewPlaceholder.hidden = false;
    resetGazeCalibration();
    clearEyeHud();
    gazeLabel.textContent = "Camera off";
    gazeDebug.textContent = "";
    const badge = document.getElementById("presence-status");
    badge.textContent = "Camera off";
    badge.style.color = "";
  }

  function resetGazeCalibration() {
    baselineOffset = null;
    calibrationStartedAt = null;
    calibrationSum = { head: { yaw: 0, pitch: 0 }, eyes: EYES.map(() => ({ x: 0, y: 0 })), count: 0 };
    consecutiveAwayFrames = 0;
    awayStartedAt = null;
    awayReminderSent = false;

  }

  function clearEyeHud() {
    hudContext.clearRect(0, 0, eyeHud.width, eyeHud.height);
  }

  function landmarkPoint(mark) {
    return { x: mark.x * videoEl.videoWidth, y: mark.y * videoEl.videoHeight };
  }

  function eyeGeometry(marks, eye) {
    const iris = marks?.[eye.iris];
    const contour = eye.contour.map(index => marks?.[index]);
    if (!iris || contour.some(point => !point)) return null;
    const points = contour.map(landmarkPoint);
    const [left, , , right] = points;
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    if (width < 1) return null;
    // Both contours run image-left to image-right, so positive offsets agree.
    const ux = (right.x - left.x) / width;
    const uy = (right.y - left.y) / width;
    const vertical = points.map(point => -(point.x - left.x) * uy + (point.y - left.y) * ux);
    const top = Math.min(...vertical);
    const bottom = Math.max(...vertical);
    const height = bottom - top;
    if (height < width * 0.10) return null;
    const pupil = landmarkPoint(iris);
    const x = pupil.x - left.x;
    const y = pupil.y - left.y;
    return {
      pupilX: pupil.x,
      pupilY: pupil.y,
      rim: eye.rim.map(index => marks[index]).filter(Boolean),
      eyeWidth: width,
      dx: (x * ux + y * uy) / width - 0.5,
      dy: (-x * uy + y * ux - (top + bottom) / 2) / height,
    };
  }

  function headPose(marks) {
    const points = [1, 234, 454, 10, 152].map(index => marks?.[index]);
    if (points.some(point => !point)) return null;
    const [nose, left, right, forehead, chin] = points.map(landmarkPoint);
    const roll = Math.atan2(right.y - left.y, right.x - left.x);
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const width = Math.hypot(right.x - left.x, right.y - left.y);
    const height = -(chin.x - forehead.x) * sin + (chin.y - forehead.y) * cos;
    if (width < 1 || height < 1) return null;
    return {
      yaw: ((nose.x - (left.x + right.x) / 2) * cos + (nose.y - (left.y + right.y) / 2) * sin) / width,
      pitch: (-(nose.x - (forehead.x + chin.x) / 2) * sin + (nose.y - (forehead.y + chin.y) / 2) * cos) / height,
      roll,
    };
  }

  function combineGaze(head, eye, baseline) {
    // Each ratio estimates a displacement in an unmirrored, image-right,
    // image-down frame. atan converts the scaled displacement into degrees.
    const headYaw = toDegrees(Math.atan((head.yaw - baseline.head.yaw) * 2));
    const headPitch = toDegrees(Math.atan((head.pitch - baseline.head.pitch) * 2));
    const eyeYaw = toDegrees(Math.atan((eye.dx - baseline.eye.x) * 2.5));
    const eyePitch = toDegrees(Math.atan((eye.dy - baseline.eye.y) * 0.85));
    // atan2 already supplied radians. Rotate both vectors into camera space.
    const cos = Math.cos(head.roll);
    const sin = Math.sin(head.roll);
    const localYaw = headYaw + eyeYaw;
    const localPitch = headPitch + eyePitch;
    return {
      headYaw, headPitch, eyeYaw, eyePitch,
      totalYaw: localYaw * cos - localPitch * sin,
      totalPitch: localYaw * sin + localPitch * cos,
      score: Math.hypot(localYaw / YAW_LIMIT_DEG, localPitch / PITCH_LIMIT_DEG),
    };
  }

  function showGazeDebug(head, gaze, state) {
    if (!cameraPreviewDialog.open) return;
    const round = value => value.toFixed(1);
    const text = gaze
      ? [
          "head yaw/pitch/roll: " + [gaze.headYaw, gaze.headPitch, toDegrees(head.roll)].map(round).join(" / ") + "°",
          "raw eye yaw/pitch: " + [gaze.eyeYaw, gaze.eyePitch].map(round).join(" / ") + "°",
          "total yaw/pitch: " + [gaze.totalYaw, gaze.totalPitch].map(round).join(" / ") + "°",
          "thresholds: " + YAW_LIMIT_DEG + "° yaw / " + PITCH_LIMIT_DEG + "° pitch",
          "isLookingAway: " + state,
        ].join("\n")
      : state;
    if (gazeDebug.textContent !== text) gazeDebug.textContent = text;
  }

  function drawEyeHud(eyes) {
    if (eyeHud.width !== videoEl.videoWidth || eyeHud.height !== videoEl.videoHeight) {
      eyeHud.width = videoEl.videoWidth;
      eyeHud.height = videoEl.videoHeight;
    }
    clearEyeHud();
    hudContext.strokeStyle = "#C2410C";
    hudContext.lineWidth = Math.max(1.5, videoEl.videoWidth / 640);
    for (const eye of eyes) {
      // In a 45-degree diamond, each point fits when |dx| + |dy| <= radius.
      const radius = eye.rim.length === 4
        ? Math.max(...eye.rim.map(point =>
          Math.abs(point.x * videoEl.videoWidth - eye.pupilX) +
          Math.abs(point.y * videoEl.videoHeight - eye.pupilY)
        )) + hudContext.lineWidth
        : eye.eyeWidth * 0.22;
      const { pupilX: x, pupilY: y } = eye;
      hudContext.beginPath();
      hudContext.moveTo(x, y - radius);
      hudContext.lineTo(x + radius, y);
      hudContext.lineTo(x, y + radius);
      hudContext.lineTo(x - radius, y);
      hudContext.closePath();
      hudContext.stroke();
    }
  }

  function applyGazeSample(looking) {
    consecutiveAwayFrames = looking ? 0 : Math.min(consecutiveAwayFrames + 1, AWAY_THRESHOLD_FRAMES);
    setGaze(consecutiveAwayFrames < AWAY_THRESHOLD_FRAMES);
  }

  function trackEyes(marks, timestamp) {
    const eyes = EYES.map(eye => eyeGeometry(marks, eye));
    drawEyeHud(eyes.filter(Boolean));
    const head = headPose(marks);
    if (!head || eyes.some(eye => !eye)) {
      showGazeDebug(null, null, "Face or iris landmarks unavailable");
      applyGazeSample(false);
      return;
    }
    if (!baselineOffset) {
      calibrationStartedAt ??= timestamp;
      calibrationSum.head.yaw += head.yaw;
      calibrationSum.head.pitch += head.pitch;
      eyes.forEach((eye, index) => {
        calibrationSum.eyes[index].x += eye.dx;
        calibrationSum.eyes[index].y += eye.dy;
      });
      const count = ++calibrationSum.count;
      if (timestamp - calibrationStartedAt < 1000) {
        showGazeDebug(null, null, "Calibrating · Look straight at the screen");
        applyGazeSample(true);
        return;
      }
      baselineOffset = {
        head: { yaw: calibrationSum.head.yaw / count, pitch: calibrationSum.head.pitch / count },
        eyes: calibrationSum.eyes.map(eye => ({ x: eye.x / count, y: eye.y / count })),
      };
    }
    const estimates = eyes.map((eye, index) =>
      combineGaze(head, eye, { head: baselineOffset.head, eye: baselineOffset.eyes[index] }));
    const largest = estimates.reduce((a, b) => a.score >= b.score ? a : b);
    applyGazeSample(largest.score <= 1);
    showGazeDebug(head, largest, consecutiveAwayFrames >= AWAY_THRESHOLD_FRAMES);
  }

  async function detectFrame() {
    const stream = cameraStream;
    if (!stream) return;
    if (videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      if (faceLandmarker) {
        const timestamp = performance.now();
        try {
          const result = faceLandmarker.detectForVideo(videoEl, timestamp);
          trackEyes(result.faceLandmarks?.[0], timestamp);
        } catch (error) {
          console.error("Gaze inference failed", error);
          setGaze(false);
        }
      } else if (usingFallback && window.FaceDetector) {
        try {
          const detector = detectFrame.detector || (detectFrame.detector = new window.FaceDetector({ fastMode: true }));
          const faces = await detector.detect(videoEl);
          if (cameraStream === stream && !focusSessionId) applyGazeSample(faces.length > 0);
        } catch {
          if (cameraStream === stream) gazeLabel.textContent = "Gaze tracking unavailable";
        }
      } else {
        gazeLabel.textContent = "Gaze tracking unavailable";
      }
    }
    if (cameraStream) detectTimer = requestAnimationFrame(detectFrame);
  }

  async function initLandmarker() {
    if (faceLandmarker || usingFallback) return;
    try {
      const vision = await import("./node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");
      const fileset = await vision.FilesetResolver.forVisionTasks(
        new URL("./node_modules/@mediapipe/tasks-vision/wasm", document.baseURI).href
      );
      const options = {
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      };
      try {
        faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "GPU",
          },
        });
      } catch {
        faceLandmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
          ...options,
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            delegate: "CPU",
          },
        });
      }
    } catch {
      usingFallback = true;
    }
  }

  async function startCamera(deviceId) {
    const request = ++cameraRequest;
    await initLandmarker();
    if (request !== cameraRequest) return;
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (request !== cameraRequest) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = stream;
      videoEl.srcObject = stream;
      await videoEl.play();
      if (request !== cameraRequest) return;
      videoEl.hidden = false;
      inlineVideo.srcObject = stream;
      inlineVideo.hidden = false;
      inlinePlaceholder.hidden = true;
      previewPlaceholder.hidden = true;
      resetGazeCalibration();
      clearEyeHud();
      lastVideoTime = -1;
      if (!detectTimer) detectTimer = requestAnimationFrame(detectFrame);
      const track = stream.getVideoTracks()[0];
      currentDeviceId = track.getSettings().deviceId || deviceId || "";
      await refreshCameraOptions();
    } catch (error) {
      if (request !== cameraRequest) return;
      console.warn("Camera unavailable", error);
      if (gazeLabel) gazeLabel.textContent = "Camera unavailable";
    }
  }

  async function refreshCameraOptions() {
    let devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (error) {
      console.warn("Unable to list cameras", error);
      return;
    }
    const cameras = devices.filter(device => device.kind === "videoinput" && device.deviceId);
    cameraSelectors.forEach(select => {
      select.replaceChildren(new Option("Default webcam", ""));
      cameras.forEach((camera, index) => {
        select.add(new Option(camera.label || `Webcam ${index + 1}`, camera.deviceId));
      });
      select.value = cameras.some(camera => camera.deviceId === currentDeviceId) ? currentDeviceId : "";
    });
  }

  const activeCameraSwitch = document.getElementById("active-camera-switch");
  function updateCameraControls() {
    const enabled = cameraToggle.checked;
    const text = enabled ? "Disable Camera" : "Enable Camera";
    document.getElementById("camera-toggle-label").textContent = text;
  }

  function openCameraOptions() {
    if (!cameraPreviewDialog.open) cameraPreviewDialog.showModal();
  }

  const cameraStage = document.getElementById("camera-stage");
  cameraStage.addEventListener("click", openCameraOptions);
  cameraStage.addEventListener("keydown", event => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openCameraOptions();
  });
  activeCameraSwitch.addEventListener("click", openCameraOptions);

  if (cameraToggle) {
    cameraToggle.addEventListener("change", () => {
      updateCameraControls();
      if (cameraToggle.checked) {
        startCamera(currentDeviceId);
      } else {
        stopCamera();
        if (gazePaused) timerCommand("resume");
      }
    });
  }

  cameraSelectors.forEach(select => {
    select.addEventListener("change", () => {
      currentDeviceId = select.value;
      cameraSelectors.forEach(other => { other.value = currentDeviceId; });
      if (cameraStream) startCamera(currentDeviceId);
    });
  });
  refreshCameraOptions();

  function startOfDay(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  async function refreshTodayStats() {
    const shieldedEl = document.getElementById("today-shielded");
    const focusEl = document.getElementById("today-focus");
    const connected = document.body.dataset.phoneState === "connected";
    // The paired hackathon dashboard shows a zeroed summary without changing saved stats.
    const blockedCount = 0;
    shieldedEl.textContent = connected ? String(blockedCount) : "--";
    shieldedEl.classList.toggle("text-neutral-400", !connected);
    shieldedEl.classList.toggle("text-white", connected);
    const unit = document.getElementById("shield-app-unit");
    unit.hidden = !connected;
    unit.textContent = blockedCount === 1 ? "app" : "apps";
    if (!api) return;
    try {
      const stats = await api.getStats();
      const today = startOfDay(Date.now());
      const todayMinutes = (stats.sessions || [])
        .filter((item) => startOfDay(item.endedAt) === today)
        .reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
      if (focusEl) focusEl.textContent = document.body.dataset.phoneState === "connected" ? "0.0" : (todayMinutes / 60).toFixed(1);
    } catch {
      /* ignore */
    }
  }

  const blockerToggle = document.getElementById("active-blocker-toggle");
  const blockerContent = document.getElementById("active-blocker-content");
  const blockerPreference = "focus.activeBlockerCollapsed";
  function setBlockerCollapsed(collapsed) {
    blockerToggle.setAttribute("aria-expanded", String(!collapsed));
    blockerToggle.setAttribute("aria-label", (collapsed ? "Expand" : "Collapse") + " App Blocker");
    blockerContent.inert = collapsed;
    document.getElementById("active-blocker").toggleAttribute("data-collapsed", collapsed);
  }

  setBlockerCollapsed(localStorage.getItem(blockerPreference) === "true");
  blockerToggle.addEventListener("click", () => {
    const collapsed = blockerToggle.getAttribute("aria-expanded") === "true";
    setBlockerCollapsed(collapsed);
    localStorage.setItem(blockerPreference, String(collapsed));
  });

  const activeSearch = document.getElementById("active-app-search");
  activeSearch.addEventListener("input", renderActiveBlocker);
  const cancelDialog = document.getElementById("cancel-payment");
  const cancelFee = document.getElementById("cancel-fee");
  const cancelProgress = document.getElementById("cancel-progress");
  const cancelVerify = document.getElementById("cancel-verify");
  const cancelLink = document.getElementById("cancel-link");
  const dismissButtons = [...cancelDialog.querySelectorAll("form button")];
  const keepFocusing = dismissButtons.at(-1);
  cancelDialog.addEventListener("cancel", event => { if (keepFocusing.disabled) event.preventDefault(); });
  cancelDialog.addEventListener("close", () => timerCommand("close-payment"));
  let paymentQuote;
  let paymentSession;
  document.getElementById("end-focus-session").addEventListener("click", async () => {
    const id = focusSessionId;
    if (cancelDialog.open) return;
    document.getElementById("ironwill-payment-quip").textContent = "IronWill: My disappointment is immeasurable, and your wallet is about to be lighter.";
    cancelDialog.showModal();
    window.dispatchEvent(new Event("ironwill-exit-warning"));
    await timerCommand("open-payment");
    if (!cancelDialog.open || id !== focusSessionId) return;
    cancelProgress.textContent = "";
    if (paymentSession === id && paymentQuote) return;
    paymentSession = id;
    paymentQuote = undefined;
    cancelLink.disabled = cancelVerify.disabled = true;
    document.getElementById("cancel-signature").value = "";
    document.getElementById("cancel-usd").textContent = "—";
    document.getElementById("cancel-total").textContent = "—";
    cancelFee.textContent = "Fetching SOL price…";
    try {
      paymentQuote = await api.cancelPaymentQuote(id);
      const { usd, sol } = paymentQuote;
      document.getElementById("ironwill-payment-quip").textContent = "IronWill: Quitting already? That’ll be $" + usd + " in bread crumbs.";
      cancelFee.textContent = "Because you are ending your focus session early, a mandatory early exit penalty fee of $" + usd + " USD (" + sol + " SOL) will be donated directly to an attention span research organization (LogOut.org) to support their work.";
      document.getElementById("cancel-usd").textContent = "$" + usd + " USD";
      document.getElementById("cancel-total").textContent = "$" + usd + " USD / " + sol + " SOL";
      cancelLink.disabled = cancelVerify.disabled = false;
    } catch {
      cancelFee.textContent = "Unable to fetch a payment quote. Close and try again.";
    }
  });
  cancelLink.addEventListener("click", async () => {
    const { recipient, sol, reference } = paymentQuote;
    const params = new URLSearchParams({ amount: sol, label: "LogOut.org", memo: reference });
    try {
      await navigator.clipboard.writeText("solana:" + recipient + "?" + params);
      cancelProgress.textContent = "Payment link copied. Sign it in your wallet.";
    } catch {
      cancelProgress.textContent = "Could not copy the payment link.";
    }
  });
  cancelVerify.addEventListener("click", async () => {
    const wallet = document.getElementById("cancel-wallet").value.trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
      cancelProgress.textContent = "Enter your Solana wallet address.";
      return;
    }
    const signature = document.getElementById("cancel-signature").value.trim();
    if (!signature) {
      cancelProgress.textContent = "Paste the transaction signature.";
      return;
    }
    cancelVerify.disabled = true;
    dismissButtons.forEach(button => { button.disabled = true; });
    cancelProgress.textContent = "Checking transaction confirmation…";
    try {
      if (await api.verifyCancelPayment(paymentSession, wallet, signature)) cancelDialog.close();
      else cancelProgress.textContent = "Payment is unverified. Check the details or retry once finalized.";
    } catch {
      cancelProgress.textContent = "Could not check confirmation. Try again.";
    } finally {
      cancelVerify.disabled = false;
      dismissButtons.forEach(button => { button.disabled = false; });
    }
  });

  function renderActiveBlocker() {
    const visible = Boolean(focusSessionId) && document.body.dataset.phoneState === "connected";
    document.getElementById("active-phone-controls").hidden = !visible;
    document.getElementById("active-phone-offline").hidden = visible;
    if (!visible) return;
    const blocked = document.getElementById("active-blocked-apps");
    const available = document.getElementById("active-unblocked-apps");
    const query = activeSearch.value.trim().toLowerCase();
    blocked.replaceChildren();
    available.replaceChildren();
    let unblocked = 0;
    for (const row of appList.children) {
      const toggle = row.querySelector(".app-toggle");
      const locked = lockMode === "FULL" || toggle.checked;
      if (!locked) unblocked++;
      if (!locked && !row.dataset.searchText.includes(query)) continue;
      const item = document.createElement("div");
      item.className = locked ? "active-app-chip" : "active-app-row";
      item.append(row.children[0].cloneNode(true), row.children[1].cloneNode(true));
      if (locked) {
        const lock = document.createElement("span");
        lock.className = "material-symbols-outlined active-lock-icon";
        lock.textContent = "lock";
        lock.setAttribute("aria-label", "Blocked");
        item.append(lock);
        blocked.append(item);
      } else {
        const add = document.createElement("button");
        add.type = "button";
        add.textContent = "+ Block";
        add.setAttribute("aria-label", "Block " + row.title);
        add.addEventListener("click", () => {
          toggle.checked = true;
          appList.dispatchEvent(new Event("change"));
          activeSearch.focus();
        });
        item.append(add);
        available.append(item);
      }
    }
    document.getElementById("active-unblocked-count").textContent = "Unblocked apps (" + unblocked + ")";
  }

  function handlePhoneConnected(connected) {
    if (connected) {
      document.getElementById("today-focus").textContent = "0.0";
      document.getElementById("today-streak").textContent = "0";
      document.getElementById("today-streak-unit").textContent = "sessions";
    }
    renderActiveBlocker();
    document.getElementById("phone-prompt").hidden = connected;
    document.getElementById("phone-modes").hidden = !connected;
    document.getElementById("phone-rules").hidden = !connected;
    document.getElementById("shield-status-label").textContent = connected ? "Active" : "Phone offline";
    const dot = document.getElementById("shield-status-dot");
    dot.classList.toggle("bg-neutral-500", !connected);
    dot.classList.toggle("bg-[#c2410c]", connected);
    refreshTodayStats();
  }

  window.addEventListener("focus:phone-status", event => handlePhoneConnected(event.detail));

  let timerUpdates = 0;
  api?.onTimerState(state => { timerUpdates++; renderTimer(state); });
  api?.getTimer().then(state => { if (!timerUpdates) renderTimer(state); }).catch(console.error);
  updateDisplay();
  refreshTodayStats();
})();
