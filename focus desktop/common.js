(function () {
  const analyticsMethods = new Set(["getAnalytics", "getPairInfo", "getPairQr"]);
  if (window !== window.top && !window.focusAPI) {
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    window.addEventListener("message", ({ source, data }) => {
      if (source !== window.parent || !data) return;
      if (data.event) listeners.get(data.event)?.(data.value);
      const request = pending.get(data.reply);
      if (!request) return;
      pending.delete(data.reply);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
    });
    window.focusAPI = Object.fromEntries([...analyticsMethods].map(method => [method, (...args) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ method, args, id }, "*");
      })]));
    window.focusAPI.onCompanionStatus = callback => listeners.set("companion", callback);
    window.focusAPI.onAnalyticsUpdated = callback => listeners.set("analytics", callback);
  }
  const api = window.focusAPI;
  const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let analyticsFrame;
  let analyticsMotion = 0;
  function playClass(element, name) {
    element.classList.remove("iw-enter", "iw-leave");
    if (reduceMotion()) return;
    void element.offsetWidth;
    element.classList.add(name);
  }
  function hideAnalytics() {
    if (!analyticsFrame) return;
    const motion = ++analyticsMotion;
    const finish = () => {
      if (motion !== analyticsMotion || !analyticsFrame || analyticsFrame.hidden) return;
      analyticsFrame.hidden = true;
      analyticsFrame.style.display = "none";
      analyticsFrame.classList.remove("iw-leave", "iw-enter");
      const dash = document.getElementById("study-dashboard");
      if (dash && !reduceMotion()) {
        dash.classList.remove("iw-return");
        void dash.offsetWidth;
        dash.classList.add("iw-return");
      }
      document.querySelector('[data-path="analytics"]')?.focus();
    };
    if (reduceMotion()) {
      finish();
      return;
    }
    playClass(analyticsFrame, "iw-leave");
    const onEnd = (event) => {
      if (event.target !== analyticsFrame || event.animationName !== "iw-view-out") return;
      analyticsFrame.removeEventListener("animationend", onEnd);
      finish();
    };
    analyticsFrame.addEventListener("animationend", onEnd);
    window.setTimeout(finish, 260);
  }
  function showAnalytics() {
    if (!analyticsFrame) {
      analyticsFrame = document.createElement("iframe");
      analyticsFrame.title = "Analytics";
      analyticsFrame.src = "analytics.html";
      analyticsFrame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:100;background:#121214";
      document.body.append(analyticsFrame);
      api?.onCompanionStatus(info => analyticsFrame.contentWindow.postMessage({ event: "companion", value: info }, "*"));
      api?.onAnalyticsUpdated(() => analyticsFrame.contentWindow.postMessage({ event: "analytics" }, "*"));
      window.addEventListener("message", async event => {
        if (event.source !== analyticsFrame.contentWindow) return;
        const request = event.data;
        if (request !== "focus:show-study") {
          if (!analyticsMethods.has(request?.method) || !Array.isArray(request.args) ||
              !Number.isSafeInteger(request.id)) return;
          const response = { reply: request.id };
          try {
            response.value = await api[request.method](...request.args);
          } catch (error) {
            response.error = error.message;
          }
          event.source.postMessage(response, "*");
          return;
        }
        hideAnalytics();
      });
    }
    analyticsMotion++;
    analyticsFrame.hidden = false;
    analyticsFrame.style.display = "block";
    playClass(analyticsFrame, "iw-enter");
    analyticsFrame.focus();
  }

  document.querySelectorAll("[data-path]").forEach(link => {
    link.addEventListener("click", event => {
      event.preventDefault();
      if (link.dataset.path === "analytics") {
        if (window === window.top && !location.pathname.endsWith("/analytics.html")) showAnalytics();
      } else if (window !== window.top) {
        window.parent.postMessage("focus:show-study", "*");
      } else if (location.pathname.endsWith("/analytics.html")) {
        window.location.href = "index.html";
      }
    });
  });

  function ensurePairModal() {
    let modal = document.getElementById("pair-modal");
    if (modal) return modal;

    document.body.insertAdjacentHTML("beforeend", `
<div id="pair-modal" class="fixed inset-0 z-50 hidden items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
  <section id="pair-modal-card" class="phone-pair-card" role="dialog" aria-modal="true" aria-labelledby="pair-title">
    <button id="close-pair-modal-btn" class="phone-close" type="button" aria-label="Close pairing">×</button>
    <h2 id="pair-title">Connect Phone</h2>
    <p>Open the companion app on the same Wi-Fi and scan the QR code.</p>
    <div class="phone-qr-stage">
      <span id="pair-spinner" class="phone-spinner" aria-hidden="true" hidden></span>
      <img id="pair-qr" width="256" height="256" alt="Phone pairing QR code" hidden>
      <p id="pair-feedback" role="status"></p>
    </div>
  </section>
</div>
    `);
    return document.getElementById("pair-modal");
  }

  const pairModal = ensurePairModal();
  const pairModalCard = document.getElementById("pair-modal-card");
  const openPairModalBtn = document.getElementById("open-pair-modal-btn");
  const closePairModalBtn = document.getElementById("close-pair-modal-btn");

  const qr = document.getElementById("pair-qr");
  const spinner = document.getElementById("pair-spinner");
  const feedback = document.getElementById("pair-feedback");
  let openRequest = 0;
  let connected = false;
  let statusVersion = 0;

  let pairMotion = 0;
  async function openModal() {
    if (connected) return;
    const request = ++openRequest;
    pairMotion++;
    delete pairModal.dataset.iwClosing;
    pairModal.classList.remove("hidden", "iw-leave");
    pairModal.classList.add("flex");
    closePairModalBtn.focus({ preventScroll: true });
    refreshPairInfo();
    if (!qr) return;
    qr.hidden = true;
    spinner.hidden = false;
    feedback.textContent = "Preparing QR code…";
    await new Promise(resolve => setTimeout(resolve, 800));
    if (request !== openRequest) return;
    try {
      const image = await api.getPairQr();
      if (request !== openRequest) return;
      qr.src = image;
      qr.hidden = false;
      feedback.textContent = "";
    } catch {
      if (request === openRequest) feedback.textContent = "QR code unavailable. Close and reopen pairing to retry.";
    } finally {
      if (request === openRequest) spinner.hidden = true;
    }
  }

  function closeModal() {
    openRequest += 1;
    if (pairModal.classList.contains("hidden")) return;
    const motion = ++pairMotion;
    const finish = () => {
      if (motion !== pairMotion) return;
      pairModal.classList.add("hidden");
      pairModal.classList.remove("flex", "iw-leave");
      delete pairModal.dataset.iwClosing;
    };
    if (reduceMotion()) {
      finish();
      return;
    }
    pairModal.dataset.iwClosing = "1";
    pairModal.classList.add("iw-leave");
    window.setTimeout(finish, 170);
  }

  function applyCompanionStatus(info) {
    if (!info || typeof info !== "object") throw new Error("Missing companion status");
    const status = document.getElementById("pair-status-label");
    const isConnected = Boolean(info.connected);
    if (status) status.textContent = isConnected ? "Connected" : "Pair Phone";
    if (isConnected && !connected) closeModal();
    connected = isConnected;
    document.body.dataset.phoneState = connected ? "connected" : "disconnected";
    window.dispatchEvent(new CustomEvent("focus:phone-status", { detail: connected }));
    window.dispatchEvent(new CustomEvent("focus:installed-apps", { detail: { apps: Array.isArray(info.installedApps) ? info.installedApps : [], ready: Boolean(info.inventoryReady), error: Boolean(info.inventoryError), blockMode: info.blockMode, selectedPackages: Array.isArray(info.selectedPackages) ? info.selectedPackages : [] } }));
  }



  async function refreshPairInfo() {
    try {
      const version = statusVersion;
      const info = await api.getPairInfo();
      if (version === statusVersion) applyCompanionStatus(info);
    } catch (error) {
      console.error("Unable to read phone connection", error);
      document.querySelectorAll(".phone-state-feedback").forEach(message => {
        message.textContent = "Unable to check the phone connection. Reload this view to retry.";
      });
    }
  }

  document.querySelectorAll("#connect-phone-btn, [data-open-phone-pairing]").forEach(button => {
    button.addEventListener("click", openModal);
  });
  if (openPairModalBtn) openPairModalBtn.addEventListener("click", openModal);
  if (closePairModalBtn) closePairModalBtn.addEventListener("click", closeModal);

  pairModal.addEventListener("click", (event) => {
    if (pairModalCard && !pairModalCard.contains(event.target)) closeModal();
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pairModal.classList.contains("hidden")) closeModal();
  });

  const nativeShowModal = HTMLDialogElement.prototype.showModal;
  const nativeClose = HTMLDialogElement.prototype.close;
  HTMLDialogElement.prototype.showModal = function showModalWithMotion(...args) {
    this.classList.remove("iw-leave");
    delete this.dataset.iwClosing;
    const result = nativeShowModal.apply(this, args);
    if (reduceMotion()) return result;
    this.classList.remove("iw-enter");
    void this.offsetWidth;
    this.classList.add("iw-enter");
    const dialog = this;
    const drop = (event) => {
      if (event.target !== dialog || event.animationName !== "iw-pop") return;
      dialog.removeEventListener("animationend", drop);
      dialog.classList.remove("iw-enter");
    };
    dialog.addEventListener("animationend", drop);
    window.setTimeout(() => dialog.classList.remove("iw-enter"), 320);
    return result;
  };
  HTMLDialogElement.prototype.close = function closeWithMotion(...args) {
    if (!this.open) {
      nativeClose.apply(this, args);
      return;
    }
    if (this.dataset.iwClosing) return;
    if (reduceMotion()) {
      this.classList.remove("iw-leave", "iw-enter");
      nativeClose.apply(this, args);
      return;
    }
    const dialog = this;
    dialog.dataset.iwClosing = "1";
    dialog.classList.remove("iw-enter");
    dialog.classList.add("iw-leave");
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener("animationend", onEnd);
      delete dialog.dataset.iwClosing;
      dialog.classList.remove("iw-leave");
      nativeClose.apply(dialog, args);
    };
    const onEnd = (event) => {
      if (event.target !== dialog || event.animationName !== "iw-pop-out") return;
      finish();
    };
    dialog.addEventListener("animationend", onEnd);
    window.setTimeout(finish, 220);
  };

  document.addEventListener("DOMContentLoaded", () => {
    api?.onCompanionStatus?.(info => {
      statusVersion++;
      applyCompanionStatus(info);
    });
    refreshPairInfo();
  }, { once: true });
})();
