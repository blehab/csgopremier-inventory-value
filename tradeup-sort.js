// Price sort for the Trade-Up page (/armory/trade-up): a "Sort" row under the rarity chips with
// Default / Price ↓ (highest first) / Price ↑ (lowest first). The choice is remembered.
//
// The item list comes from the page's React Query data ["trade-up-inventory"] ({ items: [...] }) and the
// list component then orders it by eligibility and rarity with a stable sort, so items of the same
// group keep the order they have in the data. We therefore reorder that data by pp_value (the price on
// the cards): with "All" the list is by price within each rarity, with a rarity chip selected it's
// simply by price. Items without a price go last. When the page loads fresh data (e.g. after a
// trade-up), it's sorted again; "Default" puts back the order the server sent.
//
// Runs in the page's MAIN world, because the query client is only reachable through React's fiber tree.
(() => {
  const ROW_ID = "cip-tradeup-sort";
  const STORAGE_KEY = "cip-tradeup-sort";
  const QUERY_KEY = ["trade-up-inventory"];
  const MODES = [
    { key: "default", label: "Default" },
    { key: "desc", label: "Price ↓", title: "Highest price first" },
    { key: "asc", label: "Price ↑", title: "Lowest price first" },
  ];

  const loadMode = () => {
    try {
      const m = localStorage.getItem(STORAGE_KEY);
      return MODES.some((x) => x.key === m) ? m : "default";
    } catch {
      return "default";
    }
  };
  let mode = loadMode();

  let serverOrder = null; // item ids in the order the server last sent them

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  function findQueryClient(from) {
    for (let f = fiberOf(from), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  function ordered(items) {
    if (mode === "default") {
      const pos = new Map(serverOrder.map((id, i) => [id, i]));
      return [...items].sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
    }
    const sign = mode === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const pa = a.pp_value, pb = b.pp_value;
      if (pa == null || pb == null) return (pa == null) - (pb == null); // no price: last either way
      return sign * (pa - pb);
    });
  }

  function apply(client) {
    const data = client.getQueryData(QUERY_KEY);
    if (!Array.isArray(data?.items)) return;
    serverOrder ??= data.items.map((i) => i.id); // what's there when we start is the server's order
    client.setQueryData(QUERY_KEY, { ...data, items: ordered(data.items) });
  }

  // Sort fresh data as soon as it arrives. Our own setQueryData shows up here too, as a "success" action
  // marked manual (React Query copies the data, so it can't be recognised by identity); only a real
  // fetch updates the server order and gets sorted.
  let subscribed = null;
  function subscribe(client) {
    if (subscribed === client) return;
    subscribed = client;
    client.getQueryCache().subscribe((event) => {
      if (event?.type !== "updated" || event.query.queryKey?.[0] !== QUERY_KEY[0]) return;
      if (event.action?.type !== "success" || event.action.manual) return;
      const items = event.query.state.data?.items;
      if (!Array.isArray(items)) return;
      serverOrder = items.map((i) => i.id);
      if (mode !== "default") setTimeout(() => apply(client), 0);
    });
  }

  // Same look as the rarity chips above it.
  const CHIP = "relative justify-center whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-primary min-w-0 flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider transition-all";
  const chipClass = (on) => `${CHIP} ${on ? "bg-secondary text-black hover:bg-white/10" : "text-white/50 hover:text-white hover:bg-white/5"}`;

  function render(row) {
    for (const btn of row.querySelectorAll("button[data-mode]")) {
      const cls = chipClass(btn.dataset.mode === mode);
      if (btn.className !== cls) btn.className = cls;
      btn.setAttribute("aria-pressed", String(btn.dataset.mode === mode));
    }
  }

  function createRow(client) {
    const row = document.createElement("div");
    row.id = ROW_ID;
    row.className = "flex items-center gap-1 bg-black/30 border border-white/10 p-1 flex-wrap self-start";
    row.innerHTML =
      `<span class="px-2 font-mono text-[10px] font-bold uppercase tracking-widest text-white/35">Sort</span>` +
      MODES.map((m) => `<button type="button" data-mode="${m.key}"${m.title ? ` title="${m.title}"` : ""}>${m.label}</button>`).join("");
    row.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn || btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {}
      render(row);
      apply(client);
    });
    render(row);
    return row;
  }

  function update() {
    if (!location.pathname.startsWith("/armory/trade-up")) return;
    if (document.getElementById(ROW_ID)) return;
    const search = document.querySelector('input[placeholder="Search skins..."]');
    const controls = search?.closest("div.flex.flex-col.gap-3"); // search box + rarity chips
    if (!controls) return;
    const client = findQueryClient(controls);
    if (!client) return;
    subscribe(client);
    controls.appendChild(createRow(client));
    if (mode !== "default") apply(client);
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
