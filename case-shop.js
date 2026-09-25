// Case shop helpers (/armory/cases):
//   · a "Cases" entry in the left sidebar's Loadout group, which the site doesn't have (the shop is only
//     reachable from the tiles at the top of the armory pages);
//   · a price sort, by the price you actually pay (the Pro price when the account is Pro);
//   · sold-out cases gathered under their own "Out of stock" heading below the ones you can buy;
//
// The grid is rendered from the page's React Query data (["case-shop"].cases, and ["sticker-pack-shop"]
// .packs for capsules), so the order comes from reordering that data, the way tradeup-sort.js does; the
// heading is the one piece of DOM, inserted into the grid as a full-width row before the first sold-out
// card. Sold-out cases go last whichever sort is chosen, "Default" being the server's own order otherwise.
//
// Runs in the page's MAIN world, because the query client is only reachable through React's fiber tree.
(() => {
  const NAV_CLASS = "cip-cases-nav";
  const ROW_ID = "cip-case-sort";
  const DIVIDER_CLASS = "cip-oos-divider";
  const STORAGE_KEY = "cip-case-sort";
  const FILTER_KEY = "cip-cases-filter";
  const CASES_PATH = "/armory/cases";
  // lucide icons, sized like the ones in the shop's own chips
  const ICON_ATTRS =
    `xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4 shrink-0" aria-hidden="true"`;
  const MODES = [
    {
      key: "default",
      label: "Default",
      // lucide "list"
      icon: `<svg ${ICON_ATTRS}><path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/></svg>`,
    },
    {
      key: "desc",
      label: "Price",
      title: "Highest price first",
      // lucide "arrow-down-wide-narrow"
      icon: `<svg ${ICON_ATTRS}><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="M11 4h10"/><path d="M11 8h7"/><path d="M11 12h4"/></svg>`,
    },
    {
      key: "asc",
      label: "Price",
      title: "Lowest price first",
      // lucide "arrow-up-narrow-wide"
      icon: `<svg ${ICON_ATTRS}><path d="m3 8 4-4 4 4"/><path d="M7 4v16"/><path d="M11 12h4"/><path d="M11 16h7"/><path d="M11 20h10"/></svg>`,
    },
  ];
  // Both shop lists, so the sort covers capsules too.
  const QUERIES = [
    { key: "case-shop", list: "cases" },
    { key: "sticker-pack-shop", list: "packs" },
  ];

  // lucide "boxes", sized and coloured like the sidebar's own icons: no colour class, so it follows the
  // link's own text colour (dim when idle, secondary when active). "package" is Inventory's icon already.
  const ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-boxes h-4 w-4 shrink-0" aria-hidden="true">` +
    `<path d="M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z"/>` +
    `<path d="m7 16.5-4.74-2.85"/><path d="m7 16.5 5-3"/><path d="M7 16.5v5.17"/>` +
    `<path d="M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z"/>` +
    `<path d="m17 16.5-5-3"/><path d="m17 16.5 4.74-2.85"/><path d="M17 16.5v5.17"/>` +
    `<path d="M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z"/>` +
    `<path d="M12 8 7.26 5.15"/><path d="m12 8 4.74-2.85"/><path d="M12 13.5V8"/></svg>`;

  const loadMode = () => {
    try {
      const m = localStorage.getItem(STORAGE_KEY);
      return MODES.some((x) => x.key === m) ? m : "default";
    } catch {
      return "default";
    }
  };
  let mode = loadMode();
  const serverOrder = new Map(); // query key → ids in the order the server sent them
  let wantCasesFilter = (() => {
    try {
      return sessionStorage.getItem(FILTER_KEY) === "1";
    } catch {
      return false;
    }
  })();

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];
  const onCasesPage = () => location.pathname.startsWith(CASES_PATH);

  function findQueryClient() {
    for (let f = fiberOf(document.querySelector("main") || document.body.firstElementChild), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  // ---------- sidebar entry ----------

  // The sidebar's own links, e.g. Inventory / Market / Skin database, live in one scrolling column and
  // are the only ones with the sidebar's row padding — the same hrefs also appear in the tiles at the top
  // of the page and in the footer, which is what the class check keeps us out of. Ours goes in first in
  // the Loadout group, above Inventory.
  const SIDEBAR_ROW = /py-\[9px\]/;
  function sidebarLinks() {
    const anchor = [...document.querySelectorAll('a[href="/inventory"]')].find((a) => SIDEBAR_ROW.test(a.className));
    return anchor ? { anchor, container: anchor.parentElement } : null;
  }

  const NAV_BASE = "group relative flex items-center gap-3 py-[9px] text-[13px] transition-colors px-3.5";
  const NAV_ACTIVE = `${NAV_BASE} bg-secondary/10 text-secondary`;
  const NAV_IDLE = `${NAV_BASE} text-white/50 hover:text-white hover:bg-white/5`;

  function updateSidebar() {
    const spot = sidebarLinks();
    if (!spot) return;
    let link = spot.container.querySelector(`.${NAV_CLASS}`);
    if (!link) {
      link = document.createElement("a");
      link.className = `${NAV_CLASS} ${NAV_IDLE}`;
      link.href = CASES_PATH;
      link.innerHTML = `${ICON}<span class="truncate">Cases</span>`;
      // In-app navigation, like the site's own links, instead of a full page load.
      link.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        wantCasesFilter = true; // the shop opens on "All"; coming from here, cases are what's wanted
        try {
          sessionStorage.setItem(FILTER_KEY, "1"); // survives a full page load
        } catch {}
        const push = window.next?.router?.push;
        if (!push) return;
        e.preventDefault();
        push(CASES_PATH);
      });
    }
    // First in the Loadout group, above Inventory.
    if (link.nextElementSibling !== spot.anchor) spot.anchor.insertAdjacentElement("beforebegin", link);

    const active = onCasesPage() || location.pathname.startsWith("/armory/crates/");
    const className = `${NAV_CLASS} ${active ? NAV_ACTIVE : NAV_IDLE}`;
    if (link.className !== className) link.className = className;
    link.querySelector("span").className = active ? "truncate font-semibold" : "truncate";
    let bar = link.querySelector(".cip-nav-bar");
    if (active && !bar) {
      bar = document.createElement("div");
      bar.className = "cip-nav-bar absolute inset-y-0 left-0 w-[2px] bg-secondary";
      link.appendChild(bar);
    } else if (!active && bar) {
      bar.remove();
    }
  }

  // ---------- ordering ----------

  const soldOut = (entry) => entry.stock_remaining === 0; // null means no limit
  const priceOf = (entry, isPro) => (isPro ? (entry.pro_price_pp ?? entry.price_pp) : entry.price_pp) ?? Infinity;

  function ordered(list, isPro, ids) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    const sign = mode === "asc" ? 1 : -1;
    return [...list].sort((a, b) => {
      if (soldOut(a) !== soldOut(b)) return soldOut(a) ? 1 : -1; // sold out always goes last
      if (mode === "default") return (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity);
      return sign * (priceOf(a, isPro) - priceOf(b, isPro));
    });
  }

  function apply(client) {
    for (const { key, list } of QUERIES) {
      const data = client.getQueryData([key]);
      if (!Array.isArray(data?.[list])) continue;
      if (!serverOrder.has(key)) serverOrder.set(key, data[list].map((x) => x.id));
      client.setQueryData([key], { ...data, [list]: ordered(data[list], !!data.is_pro, serverOrder.get(key)) });
    }
  }

  // Fresh data from the server is the new "Default" order, and gets sorted again. Our own setQueryData
  // comes back through here too, as a success action marked manual, and is ignored.
  let subscribed = null;
  function subscribe(client) {
    if (subscribed === client) return;
    subscribed = client;
    client.getQueryCache().subscribe((event) => {
      const key = event?.query?.queryKey?.[0];
      if (event?.type !== "updated" || !QUERIES.some((q) => q.key === key)) return;
      if (event.action?.type !== "success" || event.action.manual) return;
      const list = QUERIES.find((q) => q.key === key).list;
      const items = event.query.state.data?.[list];
      if (!Array.isArray(items)) return;
      serverOrder.set(key, items.map((x) => x.id));
      setTimeout(() => apply(client), 0);
    });
  }

  // ---------- sort control ----------

  // The shop's own All / Cases / Capsules chips, class for class, so this reads as part of the page:
  // one bordered group, chips that mark themselves with data-active.
  const GROUP_CLASS = "inline-flex max-w-full gap-1 overflow-x-auto border border-white/10 bg-black/25 p-1";
  const CHIP_CLASS =
    "group/tab relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-semibold text-white/45 " +
    "transition-colors hover:text-white/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset " +
    "disabled:cursor-not-allowed disabled:opacity-35 min-h-11 py-2.5 text-sm border border-transparent px-3 " +
    "data-[active]:bg-white/[0.05] data-[active]:border-tertiary/60 data-[active]:text-tertiary focus-visible:ring-tertiary";

  function renderRow(row) {
    for (const btn of row.querySelectorAll("button[data-mode]")) {
      const on = btn.dataset.mode === mode;
      btn.toggleAttribute("data-active", on);
      btn.setAttribute("aria-pressed", String(on));
    }
  }

  function createRow(client) {
    const row = document.createElement("div");
    row.id = ROW_ID;
    row.className = GROUP_CLASS;
    row.innerHTML = MODES.map(
      (m) =>
        `<button type="button" class="${CHIP_CLASS}" data-mode="${m.key}"${m.title ? ` title="${m.title}"` : ""}>${m.icon}<span>${m.label}</span></button>`
    ).join("");
    row.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-mode]");
      if (!btn || btn.dataset.mode === mode) return;
      mode = btn.dataset.mode;
      try {
        localStorage.setItem(STORAGE_KEY, mode);
      } catch {}
      renderRow(row);
      apply(client);
    });
    renderRow(row);
    return row;
  }

  // ---------- the "Out of stock" heading ----------

  function dividerHtml(count) {
    return `<div class="flex items-center gap-3 pt-3">
        <h3 class="font-brand text-lg font-black uppercase italic text-white/40">Out of stock</h3>
        <span class="ui-meta whitespace-nowrap text-white/25">${count} ${count === 1 ? "case" : "cases"}</span>
        <div class="h-px flex-1 bg-white/[0.07]"></div>
      </div>`;
  }

  function markGrids(client) {
    const stock = new Map();
    for (const { key, list } of QUERIES) {
      for (const entry of client.getQueryData([key])?.[list] || []) stock.set(entry.id, entry.stock_remaining);
    }
    if (!stock.size) return;

    for (const grid of document.querySelectorAll('div[class*="grid-cols"]')) {
      const cards = [...grid.children].filter((el) => el.tagName === "ARTICLE");
      if (!cards.length) continue;
      const idOf = (card) => card.querySelector('a[href*="/armory/"]')?.getAttribute("href")?.split("/").pop();
      const out = cards.filter((c) => stock.get(idOf(c)) === 0);
      let divider = grid.querySelector(`.${DIVIDER_CLASS}`);
      if (!out.length) {
        divider?.remove();
        continue;
      }
      if (!divider) {
        divider = document.createElement("div");
        divider.className = DIVIDER_CLASS;
        divider.style.gridColumn = "1 / -1";
      }
      const html = dividerHtml(out.length);
      if (divider.innerHTML !== html) divider.innerHTML = html;
      if (divider.nextElementSibling !== out[0]) grid.insertBefore(divider, out[0]);
    }
  }

  // ---------- wiring ----------

  function update() {
    updateSidebar();
    if (!onCasesPage()) return;
    const client = findQueryClient();
    if (!client) return;
    subscribe(client);

    let row = document.getElementById(ROW_ID);
    if (!row) {
      // next to the shop's own All / Cases / Capsules chips
      const filters = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Capsules")?.parentElement;
      if (filters) {
        row = createRow(client);
        filters.insertAdjacentElement("afterend", row);
        apply(client);
      }
    }
    applyCasesFilter();
    markGrids(client);
  }

  // The shop opens on "All"; when the sidebar brought us here, press its own "Cases" chip instead.
  function applyCasesFilter() {
    if (!wantCasesFilter) return;
    const chips = [...document.querySelectorAll("button")].filter((b) => ["All", "Cases", "Capsules"].includes(b.textContent.trim()));
    const cases = chips.find((b) => b.textContent.trim() === "Cases");
    if (!cases) return; // not rendered yet
    wantCasesFilter = false;
    try {
      sessionStorage.removeItem(FILTER_KEY);
    } catch {}
    if (!cases.hasAttribute("data-active")) cases.click();
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 80);
  }).observe(document.documentElement, { childList: true, subtree: true });

  update();
})();
