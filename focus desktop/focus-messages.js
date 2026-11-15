(() => {
  const api = window.focusAPI;
  if (!api) return;
  const NORMAL_MS = 3 * 60_000;
  const WINDOW_MS = 7 * 60_000;
  const get = id => document.getElementById(id);
  const panel = get("focus-messages");
  const open = get("focus-message-open");
  const close = get("focus-message-close");
  const normal = get("message-normal");
  const emergency = get("message-emergency");
  const status = get("message-lock-status");
  const countdown = get("normal-message-time");
  const thread = get("focus-message-thread");
  let messages = { emergency: [], summaries: [] };
  let sessionId;
  let tab = "emergency";
  let windowStart = null;
  let spent = 0;
  let measuredAt;
  let pending = false;
  let connected = false;
  let inboxVersion = 0;
  const time = ms => {
    const seconds = Math.ceil(Math.max(0, ms) / 1000);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  };

  function drawThread() {
    get("message-held-count").textContent = "· " + messages.summaries.length + " held";
    emergency.textContent = tab === "emergency" ? "Emergencies" : "Summaries";
    const entries = messages[tab] || [];
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "message-empty";
      empty.textContent = tab === "emergency" ? "No emergency messages." : "No summaries yet.";
      thread.replaceChildren(empty);
      return;
    }
    thread.replaceChildren(...entries.map(entry => {
      const item = document.createElement("article");
      item.className = tab === "emergency" ? "emergency-entry" : "summary-entry";
      if (tab === "emergency") {
        const details = document.createElement("details");
        const header = document.createElement("summary");
        const sender = document.createElement("strong");
        sender.textContent = entry.sender || entry.sourceApp;
        const badge = document.createElement("span");
        badge.className = "emergency-source";
        const icon = document.createElement("span");
        icon.className = "emergency-app-icon";
        icon.textContent = entry.sourceApp.slice(0, 1).toUpperCase();
        icon.setAttribute("aria-hidden", "true");
        badge.append(icon, "via " + entry.sourceApp);
        const timestamp = document.createElement("time");
        const date = new Date(entry.timestamp);
        timestamp.dateTime = date.toISOString();
        timestamp.textContent = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const message = document.createElement("p");
        message.className = "emergency-text";
        message.textContent = entry.text;
        header.append(sender, badge, timestamp);
        details.append(header, message);
        details.open = true;
        item.append(details);
        return item;
      }
      const source = document.createElement("strong");
      source.textContent = entry.sourceApp;
      item.append(source, " · " + entry.summaryText);
      return item;
    }));
  }

  function refresh(now = Date.now()) {
    if (windowStart !== null && now >= windowStart + WINDOW_MS) {
      windowStart += Math.floor((now - windowStart) / WINDOW_MS) * WINDOW_MS;
      spent = 0;
      if (measuredAt !== undefined) measuredAt = Math.max(measuredAt, windowStart);
    }
    if (measuredAt !== undefined) {
      spent += now - measuredAt;
      measuredAt = now;
    }
    const left = NORMAL_MS - spent;
    if (left <= 0 && tab === "summaries") {
      measuredAt = undefined;
      tab = "emergency";
      drawThread();
      emergency.focus();
    }
    normal.disabled = left <= 0;
    normal.setAttribute("aria-pressed", String(tab === "summaries"));

    status.textContent = left <= 0 ? "Summaries will be available in " + time(windowStart + WINDOW_MS - now) : "";
    const normalOpen = !panel.hidden && tab === "summaries";
    countdown.hidden = !normalOpen;
    countdown.textContent = "Summaries · " + time(left);
    document.body.toggleAttribute("data-normal-messages", normalOpen);
  }

  function select(next) {
    refresh();
    if (next === "summaries" && normal.disabled) return;
    if (tab === next) return;
    tab = next;
    const now = Date.now();
    if (tab === "summaries") windowStart ??= now;
    measuredAt = tab === "summaries" ? now : undefined;
    drawThread();
    refresh(now);
  }

  function setOpen(visible) {
    if (!visible) {
      refresh();
      measuredAt = undefined;
    }
    panel.hidden = !visible;
    document.body.toggleAttribute("data-messages-open", visible);
    open.setAttribute("aria-expanded", String(visible));
    if (visible) {
      tab = "emergency";
      drawThread();
    }
    refresh();
  }

  async function changePanel(visible) {
    if (!sessionId || pending || (visible && !connected)) return;
    pending = true;
    try {
      await api.commandTimer(visible ? "open-messages" : "close-messages", null, sessionId);
    } catch (error) {
      console.error("Unable to change messaging pause", error);
    } finally {
      pending = false;
    }
  }

  function sync(state) {
    if (sessionId !== state.sessionId) {
      setOpen(false);
      windowStart = null;
      spent = 0;
      sessionId = state.sessionId;
    }
    const visible = connected && state.messagingPaused;
    if (visible === panel.hidden) {
      setOpen(visible);
      if (visible) close.focus();
      else if (sessionId) open.focus();
    }
  }

  open.addEventListener("click", () => changePanel(true));
  close.addEventListener("click", () => changePanel(false));
  normal.addEventListener("click", () => select(tab === "summaries" ? "emergency" : "summaries"));
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) changePanel(false);
  });
  api.onFocusMessagesUpdated(inbox => {
    if (!connected) return;
    inboxVersion++;
    messages = inbox;
    if (!panel.hidden) drawThread();
  });
  window.addEventListener("focus:phone-status", ({ detail }) => {
    if (connected === detail) return;
    connected = detail;
    open.hidden = !connected;
    const version = ++inboxVersion;
    if (!connected) {
      setOpen(false);
      messages = { emergency: [], summaries: [] };
      thread.replaceChildren();
      return;
    }
    api.getFocusMessages().then(inbox => {
      if (!connected || version !== inboxVersion) return;
      messages = inbox;
      if (!panel.hidden) drawThread();
    }).catch(console.error);
  });
  let updates = 0;
  api.onTimerState(state => { updates++; sync(state); });
  api.getTimer().then(state => { if (!updates) sync(state); }).catch(console.error);
  setInterval(() => { if (!panel.hidden) refresh(); }, 200);
})();
