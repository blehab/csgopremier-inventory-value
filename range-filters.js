// Float and price range filters for the inventory, next to the sort dropdown.
//
// Each is a button ("Float" / "Price", showing the active range) that opens a small min/max popover.
// Filtering hooks into the site's zustand inventory store the same way sellable-tab.js does: the grid
// renders state.filteredItems(), so we wrap that function once. The wrappers chain (site filters →
// Sellable tab → these ranges) and all apply together with search, tabs and sorting.
//
// The grid only re-renders when the filteredItems reference changes, so after a filter change we swap in
// a fresh pass-through reference and poke the store with setSearchQuery(current query).
//
// Runs in the page's MAIN world, because the store is only reachable through React's fiber tree.
(() => {
  const GROUP_ID = "cip-range-filters";
  const POPOVER_ID = "cip-range-popover";
  const WRAPPED = Symbol.for("cip-range-filters");
  const SECONDARY = "54, 248, 248"; // the site's secondary colour (rgb)

  const ranges = {
    float: { label: "Float", min: null, max: null, step: "0.0001", placeholder: ["0.00", "1.00"] },
    price: { label: "Price", min: null, max: null, step: "1", placeholder: ["0", "∞"] },
  };

  // The price a card shows: pp_value when it can be quick-sold, else none ("NO SELL" / "SYNCED"), as in content.js.
  const shownPrice = (item) => (item.pp_value != null && item.quick_sell_percentage > 0 ? item.pp_value : null);

  const inRange = (value, { min, max }) =>
    (min == null && max == null) || (value != null && (min == null || value >= min) && (max == null || value <= max));

  const passes = (item) => inRange(item.float_value, ranges.float) && inRange(shownPrice(item), ranges.price);
  const active = (r) => r.min != null || r.max != null;

  // ---------- store ----------

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  function findStoreHook(from) {
    for (let f = fiberOf(from), d = 0; f && d < 80; f = f.return, d++) {
      for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
        const v = h.memoizedState;
        if (v && typeof v.setSearchQuery === "function" && typeof v.filteredItems === "function" && Array.isArray(v.items)) {
          return typeof h.queue?.getSnapshot === "function" ? h.queue.getSnapshot : null;
        }
      }
    }
    return null;
  }

  // Carry the other wrappers' markers over, so each script can still see that its wrapper is in the chain.
  const withMarkers = (fn, inner) => {
    for (const sym of Object.getOwnPropertySymbols(inner)) fn[sym] = inner[sym];
    return fn;
  };

  function wrapFilteredItems(state) {
    if (state.filteredItems[WRAPPED]) return;
    const inner = state.filteredItems;
    const filteredItems = withMarkers(() => {
      const items = inner();
      return active(ranges.float) || active(ranges.price) ? items.filter(passes) : items;
    }, inner);
    filteredItems[WRAPPED] = true;
    state.filteredItems = filteredItems;
  }

  function refresh() {
    const getState = findStoreHook(document.querySelector('input[aria-label="Search inventory"]'));
    const state = getState?.();
    if (!state) return;
    wrapFilteredItems(state);
    const current = state.filteredItems;
    state.filteredItems = withMarkers(() => current(), current); // new reference → the grid re-renders
    state.setSearchQuery(state.searchQuery);
  }

  // ---------- UI ----------

  const fmt = (key, n) => (key === "float" ? String(n) : n.toLocaleString("en-US"));

  function buttonText(key) {
    const r = ranges[key];
    if (!active(r)) return r.label;
    if (r.min != null && r.max != null) return `${r.label} ${fmt(key, r.min)}–${fmt(key, r.max)}`;
    return r.min != null ? `${r.label} ≥ ${fmt(key, r.min)}` : `${r.label} ≤ ${fmt(key, r.max)}`;
  }

  // lucide "sliders-horizontal"
  const ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3 w-3 shrink-0" aria-hidden="true">` +
    `<path d="M10 5H3"/><path d="M12 19H3"/><path d="M14 3v4"/><path d="M16 17v4"/><path d="M21 12h-9"/>` +
    `<path d="M21 19h-5"/><path d="M21 5h-7"/><path d="M8 10v4"/><path d="M8 12H3"/></svg>`;

  function renderButtons() {
    for (const key of Object.keys(ranges)) {
      const btn = document.querySelector(`#${GROUP_ID} [data-range="${key}"]`);
      if (!btn) continue;
      const on = active(ranges[key]);
      btn.querySelector(".cip-text").textContent = buttonText(key);
      btn.style.color = on ? `rgb(${SECONDARY})` : "";
      btn.parentElement.style.borderColor = on ? `rgba(${SECONDARY}, 0.7)` : "";
    }
  }

  function createGroup() {
    const group = document.createElement("div");
    group.id = GROUP_ID;
    group.className = "flex items-center gap-2";
    group.innerHTML = Object.keys(ranges)
      .map(
        (key) => `
        <div class="flex items-center border border-white/10 bg-[rgba(13,13,18,0.84)] transition-colors">
          <button type="button" data-range="${key}" aria-haspopup="dialog" class="flex items-center gap-2 whitespace-nowrap bg-transparent px-3 py-2 text-xs font-semibold text-white transition-colors hover:text-white/80 focus:outline-none">
            ${ICON}<span class="cip-text tabular-nums"></span>
          </button>
        </div>`
      )
      .join("");
    group.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-range]");
      if (btn) togglePopover(btn.dataset.range, btn);
    });
    return group;
  }

  function closePopover() {
    document.getElementById(POPOVER_ID)?.remove();
  }

  function togglePopover(key, anchor) {
    const open = document.getElementById(POPOVER_ID);
    closePopover();
    if (open?.dataset.range === key) return;

    const r = ranges[key];
    const pop = document.createElement("div");
    pop.id = POPOVER_ID;
    pop.dataset.range = key;
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", `${r.label} range`);
    // Same panel style as the site's sort dropdown.
    pop.className =
      "fixed z-50 w-64 border border-white/15 bg-[rgba(13,13,18,0.98)] p-3 text-white backdrop-blur-md shadow-[0_22px_70px_rgba(0,0,0,0.55)]";
    const rect = anchor.parentElement.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 6}px`;
    pop.style.left = `${Math.max(16, Math.min(rect.right - 256, window.innerWidth - 272))}px`;
    const input = (which, value) =>
      `<input type="number" inputmode="decimal" min="0" step="${r.step}" data-which="${which}" value="${value ?? ""}" ` +
      `placeholder="${r.placeholder[which === "min" ? 0 : 1]}" aria-label="${r.label} ${which}" ` +
      `class="h-9 w-full min-w-0 border border-white/10 bg-black/30 px-2.5 text-sm tabular-nums text-white placeholder:text-white/30 hover:border-white/20 focus:border-secondary/50 focus:outline-none">`;
    pop.innerHTML = `
      <div class="pointer-events-none absolute -left-px -top-px h-3 w-3 border-l-2 border-t-2 border-secondary"></div>
      <div class="pointer-events-none absolute -bottom-px -right-px h-3 w-3 border-b-2 border-r-2 border-secondary"></div>
      <div class="mb-2 flex items-center justify-between">
        <span class="font-mono text-[9px] font-bold uppercase tracking-widest text-white/55">${r.label} range${key === "price" ? " · PP" : ""}</span>
        <button type="button" class="cip-clear text-[10px] font-semibold uppercase tracking-wider text-white/45 hover:text-white/80">Clear</button>
      </div>
      <div class="flex items-center gap-2">${input("min", r.min)}<span class="text-white/30">–</span>${input("max", r.max)}</div>
      ${key === "float" ? `<p class="mt-2 text-[10px] leading-4 text-white/40">Items without a float (stickers, cases…) are hidden while this is set.</p>` : `<p class="mt-2 text-[10px] leading-4 text-white/40">Uses the price shown on the card; "NO SELL" and "SYNCED" items are hidden while this is set.</p>`}`;

    let timer = null;
    pop.addEventListener("input", (e) => {
      const el = e.target.closest("input[data-which]");
      if (!el) return;
      const n = el.value.trim() === "" ? null : Number(el.value);
      r[el.dataset.which] = n == null || Number.isNaN(n) ? null : n;
      renderButtons();
      clearTimeout(timer);
      timer = setTimeout(refresh, 200);
    });
    pop.querySelector(".cip-clear").addEventListener("click", () => {
      r.min = r.max = null;
      for (const el of pop.querySelectorAll("input")) el.value = "";
      renderButtons();
      refresh();
    });
    document.body.appendChild(pop);
    pop.querySelector("input").focus();
  }

  document.addEventListener("pointerdown", (e) => {
    const pop = document.getElementById(POPOVER_ID);
    if (pop && !pop.contains(e.target) && !e.target.closest(`#${GROUP_ID}`)) closePopover();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePopover();
  });
  window.addEventListener("scroll", closePopover, { passive: true });

  function update() {
    if (!location.pathname.startsWith("/inventory")) return closePopover();
    const sortGroup = document.querySelector('button[role="combobox"]')?.closest(".lg\\:ml-auto");
    if (!sortGroup || !document.querySelector('input[aria-label="Search inventory"]')) return;
    if (!document.getElementById(GROUP_ID)) {
      sortGroup.prepend(createGroup());
      renderButtons();
    }
    const getState = findStoreHook(sortGroup);
    const state = getState?.();
    if (state) wrapFilteredItems(state);
  }

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
