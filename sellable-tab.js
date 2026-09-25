// Adds a "Sellable" tab next to All items / Skins / Cases / Stickers that shows only the items
// the inventory context menu offers "Sell to Market" for.
//
// Which items those are is decided client side by the site (see isSellable), from fields that
// /api/inventory already returns, so no extra requests are made. The per-item market quote
// (POST /api/market/quote, or /api/market/quote-sell-bulk with at most 25 items) is rate limited
// to about one request every several seconds and shares that budget with the right-click menu,
// so it isn't used here. The server can still refuse a quote for an item in this tab
// (e.g. "we are overstocked on this item"); the context menu shows that as "Unavailable".
//
// The tabs are bound to the site's zustand inventory store: filteredItems() filters by
// filterType ("all" | "skins" | "cases" | "stickers") and ignores values it doesn't know.
// We wrap filteredItems() once on the current state object (zustand builds each new state
// with Object.assign({}, prev, partial), so the wrapper carries over) and select the tab
// with the store's own setFilterType("sellable").
//
// Runs in the page's MAIN world, because the store is only reachable through React's fiber tree.
(() => {
  const FILTER_VALUE = "sellable";
  const LABEL = "Sellable";
  const TAB_CLASS = "cip-sellable-tab";
  const EQUIP_ID = "cip-hide-equipped";
  const EQUIP_KEY = "cip-sellable-hide-equipped";
  const WRAPPED = Symbol("cip-sellable");
  // lucide "badge-dollar-sign", the icon set the site uses
  const ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-badge-dollar-sign h-3.5 w-3.5" ` +
    `aria-hidden="true"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 ` +
    `4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/>` +
    `<path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>`;

  // Selling something you're wearing is the usual regret, so the Sellable tab can leave equipped items
  // out. /api/inventory marks them per side, and an item counts as equipped on either.
  const isEquipped = (item) => !!(item.equipped_t || item.equipped_ct);
  let hideEquipped = (() => {
    try {
      return localStorage.getItem(EQUIP_KEY) === "1";
    } catch {
      return false;
    }
  })();

  const sellableNow = (item) => isSellable(item) && !(hideEquipped && isEquipped(item));

  const MARKET_CATEGORIES = ["Pistols", "SMGs", "Rifles", "Heavy", "Knives", "Gloves", "Agents", "Music Kits", "Stickers"];

  // Mirrors the site's condition for showing "Sell to Market" in the inventory context menu
  // (and requesting its quote): usesItemMarketEconomy(item) && market_eligible && not admin-granted
  // && not synced from Steam && quick-sell > 0 && not an unsealed graffiti && not sell-locked.
  function isSellable(item) {
    const usesMarket = !!item.sticker || MARKET_CATEGORIES.includes(item.skin?.category);
    const unsealedGraffiti = item.skin?.category === "Graffiti" && item.graffiti_charges != null;
    return (
      usesMarket &&
      item.market_eligible === true &&
      item.source !== "admin_grant" &&
      !item.imported_from_steam &&
      item.quick_sell_percentage > 0 &&
      !unsealedGraffiti &&
      !item.sell_locked
    );
  }

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  // The useSyncExternalStore hook of a component that subscribes to the whole store;
  // its getSnapshot() returns the live store state (api.getState()).
  function findStoreHook(from) {
    for (let f = fiberOf(from), d = 0; f && d < 80; f = f.return, d++) {
      for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
        const v = h.memoizedState;
        if (v && typeof v.setFilterType === "function" && typeof v.filteredItems === "function" && Array.isArray(v.items)) {
          return typeof h.queue?.getSnapshot === "function" ? h.queue.getSnapshot : null;
        }
      }
    }
    return null;
  }

  function wrapFilteredItems(state, getState) {
    if (state.filteredItems[WRAPPED]) return;
    const original = state.filteredItems;
    const filteredItems = () => {
      const items = original();
      return getState().filterType === FILTER_VALUE ? items.filter(sellableNow) : items;
    };
    // Keep other scripts' markers (range-filters.js wraps this function too), so neither re-wraps the other.
    for (const sym of Object.getOwnPropertySymbols(original)) filteredItems[sym] = original[sym];
    filteredItems[WRAPPED] = true;
    state.filteredItems = filteredItems;
  }

  function createTab(template, onSelect) {
    const tab = template.cloneNode(true);
    for (const attr of ["id", "data-active", "data-composite-item-active", "data-highlighted"]) tab.removeAttribute(attr);
    tab.classList.add(TAB_CLASS);
    tab.setAttribute("aria-selected", "false");
    tab.tabIndex = -1;
    tab.querySelector("svg")?.remove();
    tab.insertAdjacentHTML("afterbegin", ICON);
    const [label, count] = tab.querySelectorAll(":scope > span");
    label.textContent = LABEL;
    count.textContent = "";
    tab.addEventListener("click", onSelect);
    return tab;
  }

  // A chip next to the tabs, in the site's style, shown only while the Sellable tab is the open one.
  function renderEquipToggle(tablist, getState) {
    const state = getState();
    const on = state.filterType === FILTER_VALUE;
    let chip = document.getElementById(EQUIP_ID);
    if (!on) {
      chip?.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement("button");
      chip.id = EQUIP_ID;
      chip.type = "button";
      chip.innerHTML =
        `<span class="cip-box flex h-3 w-3 shrink-0 items-center justify-center border"></span>` +
        `<span>Hide equipped</span><span class="cip-equip-count tabular-nums"></span>`;
      chip.addEventListener("click", () => {
        hideEquipped = !hideEquipped;
        try {
          localStorage.setItem(EQUIP_KEY, hideEquipped ? "1" : "0");
        } catch {}
        refreshGrid(getState);
        renderEquipToggle(tablist, getState);
        update();
      });
      tablist.insertAdjacentElement("afterend", chip);
    }
    if (chip.previousElementSibling !== tablist) tablist.insertAdjacentElement("afterend", chip);

    const equipped = state.items.filter((i) => isSellable(i) && isEquipped(i)).length;
    chip.className =
      "ml-2 inline-flex items-center gap-2 border px-3 py-1.5 align-middle text-[11px] font-bold uppercase tracking-wider transition-colors " +
      (hideEquipped
        ? "border-secondary/40 bg-secondary/10 text-secondary"
        : "border-white/10 bg-black/25 text-white/45 hover:text-white/75");
    chip.title = hideEquipped
      ? `${equipped} equipped ${equipped === 1 ? "item is" : "items are"} hidden`
      : `${equipped} of these ${equipped === 1 ? "item is" : "items are"} equipped in your loadout`;
    chip.querySelector(".cip-box").className =
      `cip-box flex h-3 w-3 shrink-0 items-center justify-center border ${hideEquipped ? "border-secondary bg-secondary text-black" : "border-white/25"}`;
    chip.querySelector(".cip-box").textContent = hideEquipped ? "✓" : "";
    chip.querySelector(".cip-equip-count").textContent = equipped ? `· ${equipped}` : "";
  }

  // Hand the store a fresh filteredItems reference so the grid re-renders (same trick as range-filters.js).
  function refreshGrid(getState) {
    const state = getState();
    const current = state.filteredItems;
    const next = () => current();
    for (const sym of Object.getOwnPropertySymbols(current)) next[sym] = current[sym];
    state.filteredItems = next;
    state.setSearchQuery(state.searchQuery);
  }

  function update() {
    if (!location.pathname.startsWith("/inventory")) return;
    const tablist = document.querySelector('[role="tablist"][aria-label="Inventory item type"]');
    const template = tablist?.querySelector(`[role="tab"]:not(.${TAB_CLASS})`);
    if (!template) return;
    const getState = findStoreHook(tablist);
    const state = getState?.();
    if (!state) return;

    wrapFilteredItems(state, getState);

    let tab = tablist.querySelector(`.${TAB_CLASS}`);
    if (!tab) {
      tab = createTab(tablist.querySelector('[role="tab"]:last-of-type') || template, () => {
        const s = getState();
        wrapFilteredItems(s, getState);
        s.setFilterType(FILTER_VALUE);
      });
      tablist.appendChild(tab);
    }
    if (tab !== tablist.lastElementChild) tablist.appendChild(tab); // keep it last if React adds tabs

    const count = String(state.items.filter(sellableNow).length);
    const countEl = tab.querySelectorAll(":scope > span")[1];
    if (countEl && countEl.textContent !== count) countEl.textContent = count;

    renderEquipToggle(tablist, getState);

    // The tab styles itself through the site's data-[active] classes.
    const active = state.filterType === FILTER_VALUE;
    if (tab.hasAttribute("data-active") !== active) {
      tab.toggleAttribute("data-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-active"] });

  update();
})();
