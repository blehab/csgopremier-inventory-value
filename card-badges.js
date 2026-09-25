// Shows float and pattern badges (badges-core.js) on:
//  - inventory cards: top-left of the image, with a gold border and glow on the card;
//  - market listings (/market): the same, under the listing number;
//  - the case reveal shown after opening a single case.
//
// Each inventory card is the site's InventoryItemCard, whose React props hold the item
// ({ float_value, paint_seed, skin: { name, weapon_name, min_float, max_float } }).
// The reveal is the site's CaseReveal, whose props hold skin, inventoryItemId, floatValue
// and (sometimes) paintSeed. When the seed is missing we look the new item up in /api/inventory,
// which the reveal itself fetches at the same moment.
//
// Runs in the page's MAIN world, because React props are only reachable there.
(() => {
  const CARD_ROW_CLASS = "cip-card-badges";
  const REVEAL_ROW_ID = "cip-reveal-badges";
  const REVEAL_TEXT = "Your new item has been added to your inventory.";

  const B = () => window.__cipBadges;
  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  function propsWith(el, test, depth = 12) {
    for (let f = fiberOf(el), d = 0; f && d < depth; f = f.return, d++) {
      if (f.memoizedProps && test(f.memoizedProps)) return f.memoizedProps;
    }
    return null;
  }

  // ---------- inventory cards ----------

  // Rare cards get a coloured border and glow, picked by their best badge:
  //   data-cip-rare="gold"     extreme float and other badges: gold;
  //   data-cip-rare="bluegem"  blue gem: blue;
  //   data-cip-rare="phase"    Ruby / Sapphire / Black Pearl / Emerald: that finish's colour (--cip-phase-*);
  //   data-cip-rare="fade"     Fade %: the Fade gradient as the border, glow strength by % (--cip-fade-*).
  // A numbered Doppler phase is shown as a badge but doesn't mark the card: it's which phase you got,
  // not a find.
  // It's done with an attribute plus these rules rather than inline styles, because React owns the card's
  // inline style (its rarity-coloured top border); removing the attribute restores the card exactly.
  // !important overrides that inline border-top-color.
  function injectStyle() {
    if (document.getElementById("cip-card-badges-style")) return;
    const style = document.createElement("style");
    style.id = "cip-card-badges-style";
    style.textContent = `
      article[data-cip-rare="gold"] {
        border-color: rgba(255, 215, 0, 0.75) !important;
        box-shadow: 0 0 14px rgba(255, 215, 0, 0.35), inset 0 0 22px rgba(255, 215, 0, 0.08);
      }
      article[data-cip-rare="gold"]:hover { border-color: rgba(255, 215, 0, 0.95) !important; }
      article[data-cip-rare="bluegem"] {
        border-color: rgba(59, 157, 255, 0.8) !important;
        box-shadow: 0 0 16px rgba(59, 157, 255, 0.4), inset 0 0 24px rgba(59, 157, 255, 0.1);
      }
      article[data-cip-rare="bluegem"]:hover { border-color: rgba(59, 157, 255, 1) !important; }
      article[data-cip-rare="phase"] {
        border-color: var(--cip-phase-color) !important;
        box-shadow: 0 0 16px var(--cip-phase-glow), inset 0 0 24px var(--cip-phase-inner);
      }
      article[data-cip-rare="fade"] {
        border-image: var(--cip-fade-gradient) 1 !important;
        box-shadow: 0 0 var(--cip-fade-size) var(--cip-fade-glow), inset 0 0 22px var(--cip-fade-inner);
      }`;
    document.head.appendChild(style);
  }

  // Colours that differ by kind keep their own style; everything else is gold, like the card's border.
  // Phases keep theirs too: Ruby, Sapphire, Black Pearl and Emerald are recognised by their colour.
  const OWN_STYLE = new Set(["fade", "bluegem", "phase"]);

  function styleCard(card, badges) {
    const marking = badges.filter((b) => !b.plain); // a numbered phase alone leaves the card as it was
    const fade = marking.find((b) => b.kind === "fade");
    const gemPhase = marking.find((b) => b.kind === "phase" && b.gem);
    const kind = fade
      ? "fade"
      : gemPhase
        ? "phase"
        : marking.some((b) => b.kind === "bluegem")
          ? "bluegem"
          : marking.length
            ? "gold"
            : null;
    if (kind) card.setAttribute("data-cip-rare", kind);
    else card.removeAttribute("data-cip-rare");
    // CSS variables only; React doesn't touch properties it didn't set.
    for (const prop of ["--cip-fade-gradient", "--cip-fade-glow", "--cip-fade-size", "--cip-fade-inner", "--cip-phase-color", "--cip-phase-glow", "--cip-phase-inner"])
      card.style.removeProperty(prop);
    if (gemPhase) {
      card.style.setProperty("--cip-phase-color", `${gemPhase.color}cc`);
      card.style.setProperty("--cip-phase-glow", `${gemPhase.color}66`);
      card.style.setProperty("--cip-phase-inner", `${gemPhase.color}1a`);
    }
    if (fade) {
      const f = B().fadeStyle(fade.pct);
      card.style.setProperty("--cip-fade-gradient", f.gradient);
      card.style.setProperty("--cip-fade-glow", f.glow);
      card.style.setProperty("--cip-fade-size", `${f.glowSize}px`);
      card.style.setProperty("--cip-fade-inner", f.glow.replace(/[\d.]+\)$/, "0.1)"));
    }
  }

  // position: classes placing the badge row inside the card's image area.
  function renderCard(card, item, position) {
    const key = item ? `${item.id}|${item.float_value}|${item.paint_seed}` : "";
    if (card.dataset.cipBadges === key) return;
    card.dataset.cipBadges = key;

    card.querySelector(`.${CARD_ROW_CLASS}`)?.remove();
    const badges = item?.skin ? B().badgesFor(item, item.skin) : [];
    styleCard(card, badges);
    // Every phase gets its chip over the image, numbered ones included: the site prints them too, but only
    // in small text under the picture. What "plain" still means is that a numbered phase doesn't make the
    // card look like a find (no gold border) — see styleCard.
    if (!badges.length) return;
    injectStyle();
    const imageBox = card.firstElementChild;
    const row = document.createElement("div");
    row.className = `${CARD_ROW_CLASS} pointer-events-auto absolute z-10 flex flex-wrap gap-1 ${position}`;
    row.style.maxWidth = "70%"; // inline: the site's stylesheet has no max-w-[70%]
    row.innerHTML = B().badgeHtml(badges.map((b) => (OWN_STYLE.has(b.kind) ? b : { ...b, color: B().COLORS.gold })));
    imageBox.appendChild(row);
  }

  // ---------- single-case reveal ----------

  const seedCache = new Map(); // inventory item id → paint_seed
  let lookingUp = null;

  async function lookUpSeed(id) {
    lookingUp = id;
    try {
      const res = await fetch("/api/inventory", { credentials: "include" });
      const { items = [] } = await res.json();
      for (const i of items) seedCache.set(i.id, i.paint_seed);
    } catch (e) {
      console.error("[CSGOPremier Badges]", e);
    } finally {
      lookingUp = null;
      if (!seedCache.has(id)) seedCache.set(id, null);
      update();
    }
  }

  function renderReveal() {
    const text = document.evaluate(
      `//*[normalize-space(text())="${REVEAL_TEXT}"]`, document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    if (!text) return;
    // The text sits inside the reveal's dialog, many React layers below CaseReveal itself.
    const props = propsWith(text, (p) => p.skin && "inventoryItemId" in p && "floatValue" in p, 100);
    if (!props) return;

    let seed = props.paintSeed;
    if (seed == null) {
      if (!seedCache.has(props.inventoryItemId)) {
        if (lookingUp !== props.inventoryItemId) lookUpSeed(props.inventoryItemId);
        return;
      }
      seed = seedCache.get(props.inventoryItemId);
    }

    const badges = B().badgesFor({ float_value: props.floatValue, paint_seed: seed }, props.skin);
    const key = `${props.inventoryItemId}|${badges.map((b) => b.label).join(",")}`;
    let row = document.getElementById(REVEAL_ROW_ID);
    if (row?.dataset.key === key && row.previousElementSibling === text) return;
    row?.remove();
    if (!badges.length) return;
    row = document.createElement("div");
    row.id = REVEAL_ROW_ID;
    row.dataset.key = key;
    row.className = "mt-3 flex flex-wrap items-center justify-center gap-1.5";
    row.innerHTML = B().badgeHtml(badges);
    text.insertAdjacentElement("afterend", row);
  }

  // ---------- market listings ----------

  // Market cards only get display props (name, float, seed), not the skin's float range. Each card's
  // React key is its listing id, and the full listings are in the page's React Query cache
  // (query "market-stock"), so we look them up there.
  let queryClient = null;

  function findQueryClient(from) {
    for (let f = fiberOf(from), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  function marketListings(from) {
    queryClient ||= findQueryClient(from);
    const byId = new Map();
    for (const q of queryClient?.getQueryCache().findAll({ queryKey: ["market-stock"] }) || []) {
      for (const page of q.state.data?.pages || []) for (const item of page.items || []) byId.set(String(item.id), item);
    }
    return byId;
  }

  function update() {
    if (!B()) return;
    // Inventory: badges top-left; the CT/T tag is top-right, the wear label bottom-left, the 3D button bottom-right.
    for (const card of document.querySelectorAll("div.grid.grid-cols-2 > article")) {
      renderCard(card, propsWith(card, (p) => p.item && p.item.id != null, 6)?.item, "left-2 top-2");
    }
    // Market: badges under the "#<listing id>" in the top-left corner.
    if (location.pathname.startsWith("/market")) {
      const cards = document.querySelectorAll("div.grid.gap-4 > article");
      if (cards.length) {
        const listings = marketListings(cards[0]);
        for (const card of cards) renderCard(card, listings.get(fiberOf(card)?.return?.key), "left-3 top-8");
      }
    }
    renderReveal();
  }

  // Cards render lazily as you scroll, so keep watching (debounced).
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });

  update();
})();
