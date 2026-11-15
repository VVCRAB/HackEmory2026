(() => {
  const dialog = document.getElementById("site-capture-log");
  const results = document.getElementById("site-capture-results");
  let generation = 0;
  async function refresh() {
      const request = ++generation;
      try {
        const entries = await window.focusAPI.getSiteCaptures();
        if (request !== generation || !dialog.open) return;
        if (!entries.length) { results.textContent = "No snapshots yet."; return; }
        results.replaceChildren(...entries.map(({ domain, timestamp, image }) => {
          const item = document.createElement("figure");
          const thumb = document.createElement("img");
          thumb.src = image;
          thumb.alt = "Snapshot of " + domain;
          thumb.loading = "lazy";
          const caption = document.createElement("figcaption");
          caption.textContent = domain + " · " + new Date(timestamp).toLocaleString();
          item.append(thumb, caption);
          return item;
        }));
      } catch {
        if (request === generation && dialog.open) results.textContent = "Could not load snapshots.";
      }
  }
  let interval;
  document.querySelectorAll("[data-open-captures]").forEach(button => {
    button.addEventListener("click", () => {
      if (dialog.open) return;
      dialog.showModal();
      results.textContent = "Loading snapshots…";
      refresh();
      interval = setInterval(refresh, 2500);
    });
  });
  dialog.addEventListener("close", () => {
    clearInterval(interval);
    generation++;
    results.replaceChildren();
  });
})();
