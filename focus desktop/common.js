(function () {
  const api = window.focusAPI;

  document.querySelectorAll("[data-path]").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const path = link.getAttribute("data-path");
      if (path === "analytics") {
        window.location.href = "analytics.html";
      } else {
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
    <p><span id="pair-host"></span> <span id="pair-code"></span></p>
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

  async function openModal() {
    const request = ++openRequest;

    pairModal.classList.remove("hidden");
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
      if (request === openRequest) feedback.textContent = "QR code unavailable. Use the address and code below.";
    } finally {
      if (request === openRequest) spinner.hidden = true;
    }
  }

  function closeModal() {
    openRequest += 1;
    pairModal.classList.add("hidden");
    pairModal.classList.remove("flex");
  }

  function applyCompanionStatus(info) {
    const status = document.getElementById("pair-status-label");
    const isConnected = Boolean(info.connected);
    if (status) status.textContent = isConnected ? "Connected" : "Pair Phone";
    if (isConnected && !connected) closeModal();
    connected = isConnected;
    window.dispatchEvent(new CustomEvent("focus:phone-status", { detail: connected }));
    window.dispatchEvent(new CustomEvent("focus:installed-apps", { detail: { apps: info.installedApps || [], ready: Boolean(info.inventoryReady), error: Boolean(info.inventoryError) } }));
  }

  api?.onCompanionStatus(applyCompanionStatus);

  async function refreshPairInfo() {
    if (!api) return;
    try {
      const info = await api.getPairInfo();
      const host = document.getElementById("pair-host");
      const code = document.getElementById("pair-code");
      if (host) host.textContent = `${info.ip}:${info.port}`;
      if (code) code.textContent = `Code: ${info.code}`;
      applyCompanionStatus(info);
    } catch {
      /* preload missing outside Electron */
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

  refreshPairInfo();

})();
