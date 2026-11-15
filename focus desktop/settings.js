(() => {
  const key = "ironwill.settings";
  const presets = {
    Polite: "Automatic reply from IronWill: I'm in a focus session. Reply {keyword} followed by a separate message if you need me urgently.",
    "IronWill Roast": "Automatic reply from IronWill: The duck is guarding my focus. Reply {keyword}, then send what you need, if it can't wait.",
    Minimal: "Auto-reply: Focusing. Reply {keyword}, then send your urgent message.",
    "Ghost Mode": ""
  };
  const defaults = {
    autoReply: true, message: "🦆 [IronWill] Locked into a focus session. Reply URGENT for emergencies.",
    keyword: "URGENT", repeatCall: true, platforms: ["Discord", "Instagram", "WhatsApp", "Messages", "Slack", "X"],
    roast: "Tough Love", quack: true, tts: false, clicks: true, fanfare: true,
    shake: "Arcade Max", ambient: "Matrix Rain", accent: "Emerald Ops",
    presence: "Strict", grace: 10, screenGuard: true, monitors: true, incognito: true, faceDown: true, pickup: true,
    lockPause: false, lockReset: false, browserLock: false, stake: 4, destination: "Charity Pool", startup: false, tray: true
  };
  const groups = [
    ["Auto-Reply & DM Shield", [
      ["autoReply", "Auto-Reply"], ["message", "Reply message", "textarea"], ["preset", "Reply presets", Object.keys(presets)],
      ["keyword", "Emergency Bypass Word", "text"], ["repeatCall", "Repeat-Call Breakthrough"], ["platforms", "Silenced platforms", defaults.platforms]
    ]],
    ["IronWill Mascot & Audio", [
      ["roast", "Roast aggression", ["Gentle", "Tough Love", "Menace", "Unhinged"]], ["quack", "Quack Alerts"],
      ["tts", "TTS Voice Roasts"], ["clicks", "8-Bit Click SFX"], ["fanfare", "Victory Fanfare"], ["test", "Test Quack", "action"]
    ]],
    ["Arcade HUD & Visual FX", [
      ["shake", "Screen-shake & glitch", ["Off", "Subtle", "Arcade Max"]],
      ["ambient", "Ambient background", ["Matrix Rain", "Floating Crumbs", "Minimal Grid", "None"]],
      ["accent", "HUD accent", ["Emerald Ops", "Burnt Orange", "Cyber Cyan"]]
    ]],
    ["Sensors & AI Detection", [
      ["presence", "Webcam presence", ["Strict", "Head-Only", "Off"]], ["grace", "Presence grace period", [5, 10, 15, 30]],
      ["screenGuard", "AI Screen Guard"], ["monitors", "Multi-Monitor Scan"], ["incognito", "Incognito Watch"],
      ["faceDown", "Face-Down 2x Crumbs"], ["pickup", "Pickup Alarm"], ["calibrate", "Calibrate Desk Angle", "action"]
    ]],
    ["Hardcore & High-Stakes", [
      ["lockPause", "Lock Pause Button"], ["lockReset", "Lock Reset Button"], ["browserLock", "Strict Browser Lock"],
      ["stake", "Bailout stake", [2, 4, 10, 25, 50]], ["destination", "Penalty destination", ["Burn Wallet", "Charity Pool", "Friend's Wallet"]]
    ]],
    ["System & Data", [["startup", "Launch on Startup"], ["tray", "Minimize to Tray"], ["export", "Export Session CSV", "action"]]]
  ];
  const dialog = document.querySelector("#iron-settings");
  const content = dialog.querySelector(".settings-content");
  const toast = document.querySelector("#settings-toast");
  let draft;
  let toastTimeout;
  let calibrationPreview = false;

  function announce(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function button(label, click, selected) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    if (selected !== undefined) element.setAttribute("aria-pressed", String(selected));
    element.onclick = click;
    return element;
  }

  async function runAction(id) {
    if (id === "test") window.ironWillSound.play("warning");
    if (id === "calibrate") {
      calibrationPreview = true;
      render();
      setTimeout(() => { calibrationPreview = false; if (dialog.open) render(); }, 1600);
    }
    if (id === "export") {
      try {
        const { sessions } = await window.focusAPI.getStats();
        const csv = ["ended_at,minutes", ...sessions.map(row => [Number(row.endedAt), Number(row.minutes)].join(","))].join("\n");
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "ironwill-sessions.csv";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch {
        announce("Could not export sessions");
      }
    }
  }

  function render() {
    const focused = document.activeElement?.dataset.setting;
    content.replaceChildren();
    for (const [title, rows] of groups) {
      const section = document.createElement("section");
      const heading = document.createElement("h3");
      heading.textContent = title;
      section.append(heading);
      for (const [id, label, mode] of rows) {
        const group = document.createElement("div");
        group.className = "settings-group";
        if (mode === "text" || mode === "textarea") {
          const input = document.createElement(mode === "text" ? "input" : "textarea");
          const caption = document.createElement("label");
          input.id = "setting-" + id;
          caption.htmlFor = input.id;
          caption.textContent = label;
          input.value = draft[id];
          input.maxLength = mode === "text" ? 32 : 500;
          input.oninput = () => { draft[id] = input.value; if (id === "message") draft.preset = ""; };
          group.append(caption, input);
        } else if (Array.isArray(mode)) {
          const caption = document.createElement("span");
          caption.textContent = label;
          const choices = document.createElement("div");
          choices.className = "settings-choices";
          choices.setAttribute("role", "group");
          choices.setAttribute("aria-label", label);
          for (const value of mode) {
            const multi = id === "platforms";
            const selected = multi ? draft[id].includes(value) : draft[id] === value;
            const text = id === "grace" ? value + "s" : id === "stake" ? "$" + value : value;
            const option = button(text, () => {
              draft[id] = multi ? selected ? draft[id].filter(item => item !== value) : [...draft[id], value] : value;
              if (id === "preset") {
                draft.autoReply = value !== "Ghost Mode";
                draft.message = presets[value].replace("{keyword}", draft.keyword.trim() || defaults.keyword);
              }
              render();
            }, selected);
            option.dataset.setting = id + "-" + value;
            choices.append(option);
          }
          group.append(caption, choices);
        } else if (mode === "action") {
          group.append(button(id === "calibrate" && calibrationPreview ? "Calibration preview ✓" : label, () => runAction(id)));
        } else {
          const toggle = button(label + ": " + (draft[id] ? "ON" : "OFF"), () => {
            draft[id] = !draft[id];
            render();
          }, draft[id]);
          toggle.dataset.setting = id;
          group.append(toggle);
        }
        section.append(group);
      }
      content.append(section);
    }
    if (focused) Array.from(content.querySelectorAll("[data-setting]"))
      .find(element => element.dataset.setting === focused)?.focus({ preventScroll: true });
  }

  document.querySelector("#settings-entry").onclick = () => {
    draft = structuredClone(defaults);
    try { Object.assign(draft, JSON.parse(localStorage.getItem(key))); } catch {}
    render();
    dialog.showModal();
    content.scrollTop = 0;
  };
  dialog.querySelector(".settings-close").onclick = () => dialog.close();
  dialog.querySelector(".settings-reset").onclick = () => { draft = structuredClone(defaults); render(); };
  dialog.querySelector(".settings-save").onclick = async () => {
    draft.keyword = draft.keyword.trim() || defaults.keyword;
    localStorage.setItem(key, JSON.stringify(draft));
    dialog.close();
    announce("Settings Saved ✓");
    try { await window.focusAPI.syncSettings(draft); } catch { announce("Saved locally · phone sync unavailable"); }
  };
})();
