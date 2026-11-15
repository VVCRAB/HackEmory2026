(() => {
  const skins = [
    { id: "default", name: "Classic Duck", price: 0 },
    { id: "visor", name: "Cyber-Visor", price: 50 },
    { id: "headset", name: "Studio Headset", price: 100 },
    { id: "gentleman", name: "Gentleman", price: 150 },
    { id: "crown", name: "Overlord Crown", price: 200 },
  ];
  const STARTER_BALANCE = 200;
  const key = "duckfocus.profile.v1";
  const get = id => document.getElementById(id);
  const shop = get("duck-shop");
  const profile = get("duck-profile");
  const action = get("duck-action");
  const preview = get("duck-preview");
  const feedback = get("duck-shop-feedback");
  let profileState = loadProfile();
  let index = 0;
  let earnedCents = 0;
  const format = cents => (cents / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const balanceCents = () => profileState.balanceCents + Math.max(0, earnedCents - profileState.creditedCents);
  window.addEventListener("focus-breadcrumbs", ({ detail }) => {
    if (!Number.isSafeInteger(detail) || detail < 0 || detail === earnedCents) return;
    earnedCents = detail;
    showAvatar();
    if (!shop.hidden) render();
  });
  const descriptions = {
    default: "The original IronWill. A no-frills companion for getting things done.",
    visor: "A bright cyber visor for keeping distractions in sight.",
    headset: "Studio headphones and a boom mic for getting in the zone.",
    gentleman: "A sharp top hat for a more distinguished focus session.",
    crown: "A crown for the duck in charge of the flock.",
  };

  function loadProfile() {
    const defaults = { selected: "default", owned: ["default"], balanceCents: STARTER_BALANCE * 100, creditedCents: 0 };
    try {
      const stored = JSON.parse(localStorage.getItem(key));
      if (!stored || !Array.isArray(stored.owned)) return defaults;
      const balanceCents = stored.balanceCents ?? stored.balance * 100;
      if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) return defaults;
      const creditedCents = Number.isSafeInteger(stored.creditedCents) && stored.creditedCents >= 0 ? stored.creditedCents : 0;
      const owned = skins.filter(skin => skin.price === 0 || stored.owned.includes(skin.id)).map(skin => skin.id);
      return { balanceCents, creditedCents, owned, selected: owned.includes(stored.selected) ? stored.selected : "default" };
    } catch {
      return defaults;
    }
  }

  function showAvatar() {
    get("duck-profile-image").src = "assets/ducks/" + profileState.selected + "-head.png";
  }

  function render() {
    const skin = skins[index];
    const owned = profileState.owned.includes(skin.id);
    const selected = profileState.selected === skin.id;
    preview.src = "assets/ducks/" + skin.id + (owned ? "" : "-locked") + ".png";
    preview.alt = owned ? skin.name : skin.name + " silhouette";
    preview.classList.toggle("locked", !owned);
    get("duck-name").textContent = skin.name;
    get("duck-description").textContent = descriptions[skin.id];
    get("duck-price").textContent = selected ? "Selected" : owned ? "Owned" : skin.price + " breadcrumbs";
    get("duck-balance").textContent = format(balanceCents()) + " breadcrumbs";
    action.hidden = selected;
    action.textContent = owned ? "Select" : "Buy";
    action.disabled = !owned && balanceCents() < skin.price * 100;
    if (action.disabled) feedback.textContent = "Not enough breadcrumbs.";
  }

  function move(direction) {
    index = (index + direction + skins.length) % skins.length;
    feedback.textContent = "";
    render();
  }

  showAvatar();
  profile.addEventListener("click", () => {
    if (!shop.hidden) return;
    index = skins.findIndex(skin => skin.id === profileState.selected);
    feedback.textContent = "";
    render();
    shop.hidden = false;
    document.body.setAttribute("data-duck-shop", "");
    get("duck-shop-back").focus();
  });
  get("duck-prev").addEventListener("click", () => move(-1));
  get("duck-next").addEventListener("click", () => move(1));
  function leaveShop() {
    shop.hidden = true;
    document.body.removeAttribute("data-duck-shop");
    profile.focus();
  }
  get("duck-shop-back").addEventListener("click", leaveShop);
  shop.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      leaveShop();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    move(event.key === "ArrowLeft" ? -1 : 1);
  });
  action.addEventListener("click", () => {
    const skin = skins[index];
    const owned = profileState.owned.includes(skin.id);
    if (!owned && balanceCents() < skin.price * 100) return;
    const next = owned ? { ...profileState, selected: skin.id } : {
      ...profileState,
      balanceCents: balanceCents() - skin.price * 100,
      creditedCents: Math.max(profileState.creditedCents, earnedCents),
      owned: [...profileState.owned, skin.id],
    };
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      feedback.textContent = "Could not save your duck profile.";
      return;
    }
    profileState = next;
    feedback.textContent = owned ? "Skin selected." : "Skin unlocked.";
    showAvatar();
    render();
  });
})();
