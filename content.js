(() => {
  const BTN_ID = "cip-value-btn";
  const STAT_ID = "cip-value-stat";

  let lastValue = null; // { sum, priced, total, noSell, noSellSum } — kept so we can restore after React re-renders
  let loading = false;
  let error = null;
  let autoLoaded = false;

  const fmt = (n) => n.toLocaleString("en-US");

  // The page loads the whole inventory in one request (GET /api/inventory → { items: [...] })
  // and only renders the cards lazily, so we read the same endpoint instead of scrolling.
  //
  // A card shows its price exactly when pp_value is set and quick_sell_percentage > 0,
  // and the shown price is pp_value (verified against every card of a 177-item inventory).
  // Otherwise the card says "NO SELL" (stickers, some knives — pp_value set, quick sell 0%)
  // or "SYNCED" (Steam items — pp_value null). Those don't count toward the value, same as on the cards.
  async function calculate() {
    const res = await fetch("/api/inventory", { credentials: "include" });
    if (!res.ok) throw new Error(`GET /api/inventory → ${res.status}`);
    const { items = [] } = await res.json();

    const value = { sum: 0, priced: 0, total: items.length, noSell: 0, noSellSum: 0 };
    for (const item of items) {
      if (item.pp_value == null) continue;
      if (item.quick_sell_percentage > 0) {
        value.sum += item.pp_value;
        value.priced++;
      } else {
        value.noSell++;
        value.noSellSum += item.pp_value;
      }
    }
    return value;
  }

  function renderStat() {
    const dd = document.querySelector(`#${STAT_ID} dd`);
    if (!dd) return;
    const stat = document.getElementById(STAT_ID);
    if (loading) {
      dd.innerHTML = `<span class="text-white/50">…</span>`;
      stat.title = "Loading inventory…";
    } else if (error) {
      dd.innerHTML = `<span class="text-yellow-400">!</span>`;
      stat.title = `Couldn't load the inventory: ${error}`;
    } else if (lastValue) {
      dd.innerHTML = `${fmt(lastValue.sum)}<span class="ml-1 text-sm italic font-bold text-secondary">PP</span>`;
      stat.title =
        `${lastValue.priced} of ${lastValue.total} items have a price` +
        (lastValue.noSell ? `\n${lastValue.noSell} "NO SELL" items not included (${fmt(lastValue.noSellSum)} PP)` : "");
    } else {
      dd.innerHTML = `<span class="text-white/50">—</span>`;
      stat.title = "Click \"Get my inventory value\"";
    }
  }

  function renderButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.disabled = loading;
    btn.querySelector(".cip-label").textContent =
      loading ? "Loading…" : lastValue ? "Refresh inventory value" : "Get my inventory value";
  }

  async function onClick() {
    if (loading) return;
    loading = true;
    error = null;
    renderButton();
    renderStat();
    try {
      lastValue = await calculate();
      console.log("[CSGOPremier Inventory Value]", lastValue);
    } catch (e) {
      error = e.message;
      console.error("[CSGOPremier Inventory Value]", e);
    } finally {
      loading = false;
      renderButton();
      renderStat();
    }
  }

  function createButton() {
    const btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    // Same classes as the site's own SELECT / SYNC STEAM / LOADOUT buttons.
    btn.className =
      "relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold uppercase tracking-wider transition-all " +
      "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
      "disabled:pointer-events-none disabled:opacity-50 bg-secondary/10 border border-secondary/30 text-secondary hover:bg-secondary/20 " +
      "text-xs py-1.5 px-4 min-w-[80px] group/btn overflow-hidden";
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 pointer-events-none shrink-0">
        <circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>
      </svg>
      <span class="cip-label">Get my inventory value</span>
      <div class="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l transition-colors border-secondary/30 group-hover/btn:border-secondary/60"></div>
      <div class="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r transition-colors border-secondary/30 group-hover/btn:border-secondary/60"></div>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function createStat() {
    const div = document.createElement("div");
    div.id = STAT_ID;
    div.innerHTML = `<dt class="text-sm text-white/50">Value</dt><dd class="mt-1 text-2xl font-bold tabular-nums text-white"></dd>`;
    return div;
  }

  // Injects (or re-injects after a React re-render / SPA navigation) the button and stat.
  function inject() {
    if (!location.pathname.startsWith("/inventory")) {
      autoLoaded = false; // load again next time the inventory is opened (SPA navigation)
      return;
    }

    const stats = [...document.querySelectorAll("dl")].find((dl) => /^\s*Total/.test(dl.textContent));
    if (stats && !document.getElementById(STAT_ID)) {
      stats.appendChild(createStat());
      renderStat();
    }

    const row = stats?.parentElement?.querySelector(":scope > .flex.flex-wrap.gap-3");
    if (row && !document.getElementById(BTN_ID)) {
      row.appendChild(createButton());
      renderButton();
    }

    // It's a single request, so load the value as soon as the page opens; the button then refreshes it.
    if (stats && !autoLoaded) {
      autoLoaded = true;
      onClick();
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      inject();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  inject();
})();
