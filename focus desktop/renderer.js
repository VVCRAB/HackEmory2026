(function () {
  const api = window.focusAPI;
  const PRESETS = [25, 50, 90];
  let totalSeconds = 50 * 60;
  let plannedSeconds = 50 * 60;
  let isRunning = false;
  let timerInterval = null;
  let sessionLookAways = 0;
  let focusSessionId;
  let lastPreset = 50;
  let lockMode = "SELECTED";
  let awayStartedAt = 0;
  let lookAwayEmitted = false;
  let cameraStream = null;
  let detectTimer = null;
  let faceLandmarker = null;
  let usingFallback = false;
  const videoEl = document.getElementById("camera-preview-video");
  const eyeHud = document.createElement("canvas");
  eyeHud.setAttribute("aria-hidden", "true");
  eyeHud.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;transform:scaleX(-1);pointer-events:none";
  videoEl.after(eyeHud);
  const hudContext = eyeHud.getContext("2d");
  const EYES = [
    { iris: 468, rim: [469, 470, 471, 472], contour: [33, 160, 158, 133, 153, 144] },
    { iris: 473, rim: [474, 475, 476, 477], contour: [362, 385, 387, 263, 373, 380] },
  ];
  const AWAY_THRESHOLD_FRAMES = 2;
  const GAZE_TOLERANCE = 0.045;
  let baselineOffset = null;
  let calibrationStartedAt = null;
  let calibrationSum = { x: 0, y: 0, count: 0 };
  let consecutiveAwayFrames = 0;
  let lastVideoTime = -1;
  let currentDeviceId = "";

  const displayHours = document.getElementById("display-hours");
  const displayMinutes = document.getElementById("display-minutes");
  const displaySeconds = document.getElementById("display-seconds");
  const sessionToggleBtn = document.getElementById("session-toggle-btn");
  const sessionToggleLabel = document.getElementById("session-toggle-label");
  const sessionResetBtn = document.getElementById("session-reset-btn");
  const adjustUp = document.getElementById("adjust-up");
  const adjustDown = document.getElementById("adjust-down");
  const presetButtons = document.querySelectorAll(".preset-btn");
  const cameraToggle = document.getElementById("camera-toggle-input");
  const cameraStage = document.getElementById("camera-stage");
  const previewPlaceholder = document.getElementById("modal-camera-placeholder");
  const cameraPreviewDialog = document.getElementById("camera-preview-dialog");
  const gazeLabel = document.getElementById("gaze-label");
  const cameraSelectors = document.querySelectorAll("[data-camera-select]");

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function updateDisplay() {
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (displayHours) displayHours.textContent = pad(hrs);
    if (displayMinutes) displayMinutes.textContent = pad(mins);
    if (displaySeconds) displaySeconds.textContent = pad(secs);
  }

  function setRunningLabel(running) {
    if (sessionToggleLabel) {
      sessionToggleLabel.textContent = running ? "Pause Session" : "Start Focus Session";
    }
  }

  function selectedApps() {
    return Array.from(document.querySelectorAll(".app-row .app-toggle:not(:disabled):checked")).map((input) => {
      return input.getAttribute("data-app") || "App";
    });
  }

  function lockPayload() {
    return {
      mode: lockMode,
      apps: lockMode === "FULL" ? ["*"] : selectedApps(),
    };
  }

  function syncPhoneRules() {
    if (!api) return;
    const payload = lockPayload();
    const update = payload.apps.length
      ? api.lockPhone(payload)
      : api.unlockPhone(payload);
    update.catch(error => {
      console.error("Phone lock update failed", error);
      document.getElementById("phone-lock-error").textContent = "Could not update phone lock.";
    });
  }

  function finishSession() {
    focusSessionId = null;
    refreshTodayStats();
  }

  function stopClock() {
    clearInterval(timerInterval);
    timerInterval = null;
    isRunning = false;
    setRunningLabel(false);
  }

  function startClock() {
    if (timerInterval) clearInterval(timerInterval);
    focusSessionId ??= crypto.randomUUID();
    isRunning = true;
    setRunningLabel(true);
    timerInterval = setInterval(async () => {
      if (totalSeconds > 0) {
        totalSeconds -= 1;
        api?.recordFocusTick(focusSessionId).catch(error => console.error("Focus time logging failed", error));
        updateDisplay();
        return;
      }
      stopClock();
      await finishSession();
    }, 1000);
  }

  async function toggleTimer() {
    if (isRunning) {
      stopClock();
        return;
    }
    if (totalSeconds <= 0) totalSeconds = plannedSeconds;
    sessionLookAways = 0;
    lookAwayEmitted = false;
    awayStartedAt = 0;
    if (cameraStream) resetGazeCalibration();
    startClock();
  }

  function resetTimer(newSeconds = lastPreset * 60) {
    clearInterval(timerInterval);
    timerInterval = null;
    isRunning = false;
    focusSessionId = null;
    plannedSeconds = newSeconds;
    totalSeconds = newSeconds;
    elapsedSeconds = 0;
    sessionLookAways = 0;
    lookAwayEmitted = false;
    awayStartedAt = 0;
    setRunningLabel(false);
    updateDisplay();
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

  if (sessionToggleBtn) sessionToggleBtn.addEventListener("click", toggleTimer);
  if (sessionResetBtn) sessionResetBtn.addEventListener("click", () => resetTimer(lastPreset * 60));

  if (adjustUp) {
    adjustUp.addEventListener("click", () => {
      totalSeconds += 300;
      plannedSeconds += 300;
      updateDisplay();
    });
  }

  if (adjustDown) {
    adjustDown.addEventListener("click", () => {
      if (totalSeconds >= 300) {
        totalSeconds -= 300;
        plannedSeconds = Math.max(300, plannedSeconds - 300);
        updateDisplay();
      }
    });
  }

  presetButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mins = parseInt(btn.getAttribute("data-minutes"), 10);
      if (!PRESETS.includes(mins)) return;
      lastPreset = mins;
      markPreset(mins);
      resetTimer(mins * 60);
    });
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && event.target.tagName !== "INPUT" && event.target.tagName !== "SELECT" && event.target.tagName !== "TEXTAREA") {
      event.preventDefault();
      toggleTimer();
    }
  });

  const modeSelectedBtn = document.getElementById("mode-selected");
  const modeLockoutBtn = document.getElementById("mode-lockout");
  const appsContainer = document.getElementById("apps-container");
  const lockoutContainer = document.getElementById("lockout-container");

  if (modeSelectedBtn) {
    modeSelectedBtn.addEventListener("click", () => {
      lockMode = "SELECTED";
      syncPhoneRules();
      modeSelectedBtn.classList.add("bg-white/10", "text-white", "border", "border-white/10", "shadow-sm");
      modeSelectedBtn.classList.remove("text-neutral-400");
      if (modeLockoutBtn) {
        modeLockoutBtn.classList.remove("bg-white/10", "text-white", "border", "border-white/10", "shadow-sm");
        modeLockoutBtn.classList.add("text-neutral-400");
      }
      if (appsContainer) appsContainer.classList.remove("hidden");
      if (lockoutContainer) {
        lockoutContainer.classList.add("hidden");
        lockoutContainer.classList.remove("flex");
      }
    });
  }

  if (modeLockoutBtn) {
    modeLockoutBtn.addEventListener("click", () => {
      lockMode = "FULL";
      syncPhoneRules();
      modeLockoutBtn.classList.add("bg-white/10", "text-white", "border", "border-white/10", "shadow-sm");
      modeLockoutBtn.classList.remove("text-neutral-400");
      if (modeSelectedBtn) {
        modeSelectedBtn.classList.remove("bg-white/10", "text-white", "border", "border-white/10", "shadow-sm");
        modeSelectedBtn.classList.add("text-neutral-400");
      }
      if (appsContainer) appsContainer.classList.add("hidden");
      if (lockoutContainer) {
        lockoutContainer.classList.remove("hidden");
        lockoutContainer.classList.add("flex");
      }
    });
  }

  const toggleAllBtn = document.getElementById("toggle-all-btn");
  toggleAllBtn.disabled = true;
  if (toggleAllBtn) {
    toggleAllBtn.addEventListener("click", () => {
      const toggles = document.querySelectorAll(".app-row .app-toggle:not(:disabled)");
      const allOn = Array.from(toggles).every((input) => input.checked);
      toggles.forEach((input) => {
        input.checked = !allOn;
      });
      toggleAllBtn.textContent = allOn ? "Select all" : "Deselect all";
      appList.dispatchEvent(new Event("change"));
    });
  }

  const appList = document.getElementById("installed-app-list");
  const selectedPackages = new Set();
  const appSearch = document.getElementById("installed-app-search");
  const noMatchingApps = document.getElementById("installed-app-no-match");

  function filterInstalledApps() {
    const query = appSearch.value.trim().toLowerCase();
    let hasMatch = false;
    for (const row of appList.children) {
      row.hidden = !row.dataset.searchText.includes(query);
      hasMatch ||= !row.hidden;
    }
    noMatchingApps.hidden = !query || !appList.children.length || hasMatch;
  }

  appSearch.addEventListener("input", filterInstalledApps);
  appList.addEventListener("change", () => {
    selectedPackages.clear();
    selectedApps().forEach(name => selectedPackages.add(name));
    refreshTodayStats();
    syncPhoneRules();
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
  window.addEventListener("focus:installed-apps", ({ detail: { apps, ready, error } }) => {
    if (error) {
      clearTimeout(inventoryTimer);
      appStatus.textContent = "The phone could not read its app list. Tap Refresh apps to retry.";
      return;
    }
    if (!ready) return;
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
    syncPhoneRules();
  });


  syncPhoneRules();

  function setGaze(looking) {
    const status = looking ? "Looking at Screen" : "Looking Away";
    if (gazeLabel.textContent !== status) gazeLabel.textContent = status;
    if (!isRunning) {
      awayStartedAt = 0;
      lookAwayEmitted = false;
      return;
    }
    if (looking) {
      awayStartedAt = 0;
      lookAwayEmitted = false;
      return;
    }
    if (!awayStartedAt) awayStartedAt = Date.now();
    if (!lookAwayEmitted && Date.now() - awayStartedAt >= 3000) {
      lookAwayEmitted = true;
      sessionLookAways += 1;
      stopClock();
      if (api) api.addLookAway();
    }
  }

  function stopCamera() {
    if (detectTimer) {
      cancelAnimationFrame(detectTimer);
      detectTimer = null;
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    videoEl.srcObject = null;
    videoEl.hidden = true;
    previewPlaceholder.hidden = false;
    resetGazeCalibration();
    clearEyeHud();
    gazeLabel.textContent = "Camera off";
  }

  function resetGazeCalibration() {
    baselineOffset = null;
    calibrationStartedAt = null;
    calibrationSum = { x: 0, y: 0, count: 0 };
    consecutiveAwayFrames = 0;
    awayStartedAt = 0;
    lookAwayEmitted = false;
  }

  function clearEyeHud() {
    hudContext.clearRect(0, 0, eyeHud.width, eyeHud.height);
  }

  function eyeGeometry(marks, eye) {
    const iris = marks?.[eye.iris];
    const contour = eye.contour.map(index => marks?.[index]);
    if (!iris || contour.some(point => !point)) return null;
    const xs = contour.map(point => point.x * videoEl.videoWidth);
    const ys = contour.map(point => point.y * videoEl.videoHeight);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const width = right - left;
    if (width < 1) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    return {
      pupilX: iris.x * videoEl.videoWidth,
      pupilY: iris.y * videoEl.videoHeight,
      rim: eye.rim.map(index => marks[index]).filter(Boolean),
      eyeWidth: width,
      dx: (iris.x * videoEl.videoWidth - x) / width,
      dy: (iris.y * videoEl.videoHeight - y) / width,
    };
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
    const eyes = EYES.map(eye => eyeGeometry(marks, eye)).filter(Boolean);
    drawEyeHud(eyes);
    if (eyes.length !== EYES.length) {
      if (baselineOffset) applyGazeSample(false);
      else {
        resetGazeCalibration();
        if (gazeLabel.textContent !== "Position your face in view") {
          gazeLabel.textContent = "Position your face in view";
        }
      }
      return;
    }
    const offset = { x: (eyes[0].dx + eyes[1].dx) / 2, y: (eyes[0].dy + eyes[1].dy) / 2 };
    if (!baselineOffset) {
      calibrationStartedAt ??= timestamp;
      calibrationSum.x += offset.x;
      calibrationSum.y += offset.y;
      calibrationSum.count += 1;
      if (timestamp - calibrationStartedAt < 1000) {
        if (gazeLabel.textContent !== "Calibrating · Look at the screen") {
          gazeLabel.textContent = "Calibrating · Look at the screen";
        }
        return;
      }
      baselineOffset = {
        x: calibrationSum.x / calibrationSum.count,
        y: calibrationSum.y / calibrationSum.count,
      };
    }
    applyGazeSample(Math.abs(offset.x - baselineOffset.x) <= GAZE_TOLERANCE &&
      Math.abs(offset.y - baselineOffset.y) <= GAZE_TOLERANCE);
  }

  async function detectFrame() {
    const stream = cameraStream;
    if (!stream) return;
    if (videoEl.readyState >= 2 && videoEl.currentTime !== lastVideoTime) {
      lastVideoTime = videoEl.currentTime;
      if (faceLandmarker) {
        const timestamp = performance.now();
        const result = faceLandmarker.detectForVideo(videoEl, timestamp);
        trackEyes(result.faceLandmarks?.[0], timestamp);
      } else if (usingFallback && window.FaceDetector) {
        try {
          const detector = detectFrame.detector || (detectFrame.detector = new window.FaceDetector({ fastMode: true }));
          const faces = await detector.detect(videoEl);
          if (cameraStream === stream) applyGazeSample(faces.length > 0);
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
      const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/+esm");
      const fileset = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const options = {
        runningMode: "VIDEO",
        numFaces: 1,
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
    await initLandmarker();
    const constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = stream;
      videoEl.srcObject = stream;
      await videoEl.play();
      videoEl.hidden = false;
      previewPlaceholder.hidden = true;
      resetGazeCalibration();
      clearEyeHud();
      lastVideoTime = -1;
      if (!detectTimer) detectTimer = requestAnimationFrame(detectFrame);
      const track = stream.getVideoTracks()[0];
      currentDeviceId = track.getSettings().deviceId || deviceId || "";
      await refreshCameraOptions();
    } catch (error) {
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

  async function onPresenceRequested() {
    if (cameraToggle && !cameraToggle.checked) {
      cameraToggle.checked = true;
    }
    if (cameraStream) {
      resetGazeCalibration();
      return;
    }
    gazeLabel.textContent = "Starting camera…";
    await startCamera(currentDeviceId);
  }

  function openPresenceCheck() {
    if (!cameraPreviewDialog.open) cameraPreviewDialog.showModal();
  }

  cameraStage.addEventListener("click", openPresenceCheck);
  document.getElementById("open-presence-check").addEventListener("click", openPresenceCheck);
  document.getElementById("camera-preview-btn").addEventListener("click", onPresenceRequested);

  if (cameraToggle) {
    cameraToggle.addEventListener("change", () => {
      if (cameraToggle.checked) startCamera(currentDeviceId);
      else stopCamera();
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
    const streakEl = document.getElementById("today-streak");
    if (shieldedEl) {
      shieldedEl.textContent = String(lockMode === "FULL" ? 1 : selectedApps().length);
    }
    if (!api) return;
    try {
      const stats = await api.getStats();
      const today = startOfDay(Date.now());
      const todayMinutes = (stats.sessions || [])
        .filter((item) => startOfDay(item.endedAt) === today)
        .reduce((sum, item) => sum + (Number(item.minutes) || 0), 0);
      if (focusEl) focusEl.textContent = (todayMinutes / 60).toFixed(1);
      if (streakEl) streakEl.textContent = String(computeStreak(stats.sessions || []));
    } catch {
      /* ignore */
    }
  }

  function computeStreak(sessions) {
    const days = new Set(sessions.map((item) => startOfDay(item.endedAt)));
    let streak = 0;
    let cursor = startOfDay(Date.now());
    if (!days.has(cursor)) cursor -= 86400000;
    while (days.has(cursor)) {
      streak += 1;
      cursor -= 86400000;
    }
    return streak;
  }

  function handlePhoneConnected(connected) {
    document.getElementById("phone-prompt").hidden = connected;
    document.getElementById("phone-modes").hidden = !connected;
    document.getElementById("phone-rules").hidden = !connected;
  }

  window.addEventListener("focus:phone-status", event => handlePhoneConnected(event.detail));

  updateDisplay();
  refreshTodayStats();
})();
