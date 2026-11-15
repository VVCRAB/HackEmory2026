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
  const readEmergencies = new Set();
  function updateUnread() {
    if (!panel.hidden && tab === "emergency") {
      for (const entry of messages.emergency) if (entry.id && (!activeThread || threadKey(entry) === activeThread)) readEmergencies.add(entry.id);
    }
    const unread = messages.emergency.some(entry => entry.id && !readEmergencies.has(entry.id));
    open.toggleAttribute("data-unread-emergency", unread);
    open.setAttribute("aria-label", unread ? "Open messages, unread emergency messages" : "Open messages");
  }
  const time = ms => {
    const seconds = Math.ceil(Math.max(0, ms) / 1000);
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  };

  let activeThread = null;
  const drafts = new Map();
  const sentReplies = new Map();
  const submitting = new Set();
  const replyStatus = new Map();
  const threadKey = entry => entry.threadId || JSON.stringify([entry.sourceApp, entry.sender]);
  const clock = timestamp => new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function drawThread() {
    updateUnread();
    get("message-held-count").textContent = "· " + messages.summaries.length + " held";
    emergency.textContent = tab === "emergency" ? "Emergencies" : "Summaries";
    const groups = new Map();
    for (const entry of messages.emergency) {
      const key = threadKey(entry);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    if (tab === "emergency" && groups.has(activeThread)) {
      showConversation(activeThread, groups.get(activeThread));
      return;
    }
    const entries = tab === "emergency" ? [...groups] : messages.summaries;
    if (!entries.length) {
      thread.replaceChildren(element("p", "message-empty", tab === "emergency" ? "No emergency messages." : "No summaries yet."));
      return;
    }
    if (tab === "summaries") {
      thread.replaceChildren(...entries.map(entry => {
        const item = element("article", "summary-entry", "");
        item.append(element("strong", "", (entry.sender || "Unknown sender") + " · via " + entry.sourceApp),
          element("div", "", entry.summaryText));
        return item;
      }));
      return;
    }
    thread.replaceChildren(...entries.map(([key, conversation]) => {
      const latest = conversation[0];
      const card = element("button", "emergency-thread-card", "");
      card.type = "button";
      const heading = element("span", "emergency-thread-heading", "");
      heading.append(element("strong", "", latest.sender || latest.sourceApp),
        element("time", "", clock(latest.timestamp)));
      card.append(heading, element("span", "emergency-thread-source", "via " + latest.sourceApp),
        element("span", "emergency-thread-preview", latest.text));
      card.addEventListener("click", () => { activeThread = key; drawThread(); });
      return card;
    }));
  }

  function showConversation(key, entries) {
    const current = entries[0];
    const token = entries.find(entry => entry.replyToken)?.replyToken;
    const hadFocus = document.activeElement?.id === "emergency-reply";
    const position = hadFocus ? document.activeElement.selectionStart : null;
    const back = element("button", "emergency-back", "‹ All emergencies");
    back.type = "button";
    back.addEventListener("click", () => { activeThread = null; drawThread(); emergency.focus(); });
    const title = element("h4", "emergency-thread-title", current.sender || current.sourceApp);
    const source = element("p", "emergency-thread-source", "via " + current.sourceApp);
    const transcript = element("div", "emergency-transcript", "");
    const conversation = [...entries, ...(sentReplies.get(key) || [])].sort((a, b) => a.timestamp - b.timestamp);
    for (const entry of conversation) {
      const bubble = element("article", entry.outgoing ? "emergency-bubble outgoing" : "emergency-bubble", "");
      bubble.append(element("p", "emergency-bubble-text", entry.text), element("time", "", clock(entry.timestamp)));
      transcript.append(bubble);
    }
    thread.replaceChildren(back, title, source, transcript);
    if (token) {
      const form = element("form", "emergency-composer", "");
      const input = document.createElement("input");
      input.id = "emergency-reply";
      input.setAttribute("aria-label", "Your reply");
      input.placeholder = "Write a reply…";
      input.maxLength = 500;
      input.required = true;
      input.value = drafts.get(key) || "";
      input.addEventListener("input", () => drafts.set(key, input.value));
      const send = element("button", "", submitting.has(key) ? "Sending…" : "Send");
      send.type = "submit";
      send.disabled = submitting.has(key);
      form.append(input, send);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || submitting.has(key) || activeThread !== key || tab !== "emergency" || panel.hidden) return;
        submitting.add(key);
        replyStatus.delete(key);
        drawThread();
        try {
          const result = await api.replyToFocusMessage(token, text);
          if (result) {
            const replies = sentReplies.get(key) || [];
            replies.push({ text, timestamp: Date.now(), outgoing: true });
            sentReplies.set(key, replies);
            if (drafts.get(key)?.trim() === text) drafts.delete(key);
          } else replyStatus.set(key, result === null ? "No confirmation. Check your phone before retrying." : "Reply unavailable on the phone.");
        } catch {
          replyStatus.set(key, "Could not confirm the reply.");
        } finally {
          submitting.delete(key);
          if (!panel.hidden && tab === "emergency" && activeThread === key) drawThread();
        }
      });
      thread.append(form);
      if (hadFocus) {
        input.focus({ preventScroll: true });
        input.setSelectionRange(position, position);
      }
    }
    if (replyStatus.has(key)) {
      const feedback = element("p", "emergency-reply-status", replyStatus.get(key));
      feedback.setAttribute("role", "status");
      thread.append(feedback);
    }
    thread.scrollTop = thread.scrollHeight;
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
      activeThread = null;
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

  let panelMotion = 0;
  function setOpen(visible) {
    const motion = ++panelMotion;
    if (!visible) {
      refresh();
      measuredAt = undefined;
    }
    const apply = () => {
      if (motion !== panelMotion) return;
      panel.classList.remove("iw-leave");
      delete panel.dataset.iwClosing;
      panel.hidden = !visible;
      document.body.toggleAttribute("data-messages-open", visible);
      open.setAttribute("aria-expanded", String(visible));
      if (visible) {
        tab = "emergency";
        drawThread();
      }
      refresh();
    };
    if (!visible && !panel.hidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      panel.dataset.iwClosing = "1";
      panel.classList.add("iw-leave");
      window.setTimeout(apply, 180);
      return;
    }
    apply();
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
      activeThread = null;
      drafts.clear();
      sentReplies.clear();
      replyStatus.clear();
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
    updateUnread();
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
      updateUnread();
      return;
    }
    api.getFocusMessages().then(inbox => {
      if (!connected || version !== inboxVersion) return;
      messages = inbox;
      updateUnread();
      if (!panel.hidden) drawThread();
    }).catch(console.error);
  });
  let updates = 0;
  api.onTimerState(state => { updates++; sync(state); });
  api.getTimer().then(state => { if (!updates) sync(state); }).catch(console.error);
  setInterval(() => { if (!panel.hidden) refresh(); }, 200);
})();
