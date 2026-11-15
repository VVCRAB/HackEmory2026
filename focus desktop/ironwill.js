(() => {
  const api = window.focusAPI;
  const sound = window.ironWillSound;
  const get = id => document.getElementById(id);
  const toast = get("ironwill-toast");
  const mood = get("ironwill-mood");
  const avatar = get("ironwill-avatar");
  const stats = get("ironwill-stats");
  let session;
  let cleanSince;
  let quacks = 0;
  let hide;
  let calm;
  let updates = 0;

  function focused() {
    mood.textContent = "Focused";
    avatar.textContent = "🦆";
    avatar.dataset.mood = "focused";
  }
  function updateStats() {
    if (!session) return;
    const seconds = Math.max(0, Math.floor((Date.now() - cleanSince) / 1000));
    stats.textContent = "Clean Streak " + Math.floor(seconds / 60) + ":" +
      String(seconds % 60).padStart(2, "0") + " · Quacks " + quacks;
  }
  function sync(state) {
    if (session === state.sessionId) return;
    session = state.sessionId;
    cleanSince = Date.now();
    quacks = 0;
    clearTimeout(hide);
    clearTimeout(calm);
    toast.hidden = true;
    focused();
    updateStats();
  }
  function react({ kind, source }) {
    if (!session || !["emergency", "normal", "warning", "angry"].includes(kind)) return;
    quacks++;
    sound.play(kind);
    if (kind === "warning" || kind === "angry") {
      cleanSince = Date.now();
      const angry = kind === "angry";
      mood.textContent = angry ? "Furious" : "Suspicious";
      avatar.textContent = angry ? "🪶" : "🦆";
      avatar.dataset.mood = angry ? "furious" : "suspicious";
      const options = angry ? [
        "Nice try opening " + source + ". Back to work.",
        "You really thought a duck wouldn’t notice " + source + "?",
        "I didn’t put on this headset to watch " + source + " with you.",
      ] : [
        "My eyes are up here. So is your work.",
        "That was a suspiciously long glance.",
        "Back to the screen. Your duck is watching.",
      ];
      get("ironwill-comment").textContent = "IronWill: " + options[Math.floor(Math.random() * options.length)];
      toast.hidden = false;
      clearTimeout(hide);
      clearTimeout(calm);
      hide = setTimeout(() => { toast.hidden = true; }, 4500);
      calm = setTimeout(focused, 9000);
    }
    updateStats();
  }

  get("ironwill-dismiss").addEventListener("click", () => { toast.hidden = true; });
  window.addEventListener("ironwill-gaze", () => react({ kind: "warning" }));
  api?.onIronWillCue(react);
  api?.onTimerState(state => { updates++; sync(state); });
  api?.getTimer().then(state => { if (!updates) sync(state); }).catch(console.error);
  setInterval(updateStats, 1000);
})();
