// Open one or several copies of the same case at once, with the case-opening animation for each.
//
// On a case's page (/inventory/<item id> and /armory/crates/<case id>) this replaces the site's
// "Open Case · Free" button with a quantity picker (1 by default, 2, 3, Max, Custom) and an
// "Open case · Free" / "Open N cases · Free" button. The case the page opens comes from the site's own
// opening component (its inventoryItemId prop), so both kinds of page work the same way. If the owned
// copies can't be loaded, the site's button stays as it was.
//
// The site opens one case with POST /api/inventory/open-crate { inventory_item_id } and gets back
// { Skins, DroppedSkin, InventoryItem }: Skins is the reel the server built, with the drop in the
// middle slot. We send that same request once per copy of this case you own (one after another),
// then spin all the reels together using the markup and timing of the site's CaseStrip component
// (5 s, cubic-bezier(0.15, 0.85, 0.3, 1), 120 px per item, winner under the center marker), and
// finish with a grid of the drops.
//
// The site's own bulk opener (POST /api/inventory/open-crate-bulk) returns results without reels,
// so it can't drive the animation.
//
// Each drop in the results can be sold or burned, the same way the site's own case reveal does it:
//   Get offer → POST /api/market/quote { operation: "sell", id } → { id, amount_pp, expires_at },
//   then Sell (only with a live offer) → POST /api/market/execute { quote_id, request_key } → { balance_pp };
//   Burn → a confirm click → POST /api/inventory/<id>/burn → { payout, new_balance }.
// Which items may be sold or burned follows the site's rules, from the full inventory item.
//
// It only appears when the site's button says "Free" (Premium Pro), so it never spends PP.
// Drops get float and pattern badges from badges-core.js, so this runs in the MAIN world with it.
(() => {
  const ROW_ID = "cip-multi-open";
  const REELS_ID = "cip-multi-open-reels";
  const MAX_CASES = 25; // same cap the site uses for bulk opening
  const ITEM_WIDTH = 120;
  const HEADER_OFFSET = 72; // the site's sticky top bar
  const SPIN_MS = 5000;
  const RARITY_COLORS = {
    Extraordinary: "#ffd700", Covert: "#eb4b4b", Classified: "#d32ce6", Restricted: "#8847ff",
    "Mil-Spec Grade": "#4b69ff", "Industrial Grade": "#5e98d9", "Consumer Grade": "#b0c3d9",
    Exotic: "#d32ce6", Remarkable: "#8847ff", "High Grade": "#4b69ff", "Base Grade": "#b0c3d9",
  };
  // lucide "layers" and "lock-open", the icon set the site uses
  const LAYERS_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">` +
    `<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/>` +
    `<path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/>` +
    `<path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/></svg>`;

  const LOCK_OPEN_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">` +
    `<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>`;

  let caseInfo = null; // { itemId, crateId, crateName, ownedIds: [...] } for the case page that's open
  let loadingFor = null;
  let count = 1;
  let busy = false;

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const isCasePage = () => /^\/(inventory\/\d+|armory\/crates\/[^/]+)\/?$/.test(location.pathname);

  // The site's button (ours reads "Open case · Free" too, so it's excluded).
  const findOpenButton = () =>
    [...document.querySelectorAll("button")].find((b) => /Open Case\s*·\s*Free/i.test(b.textContent) && !b.closest(`#${ROW_ID}`));

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  // The inventory item the page's "Open Case" would open: the site's opening component gets it as a prop.
  function siteItemId() {
    for (let f = fiberOf(findOpenButton()), d = 0; f && d < 40; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && "inventoryItemId" in p) return p.inventoryItemId != null ? String(p.inventoryItemId) : null;
    }
    return null;
  }

  // A POST the way the site's API client sends it (CSRF header from the cookie). Throws an Error with the
  // server's message, plus its code and retry_at when given.
  async function apiPost(path, body) {
    const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const error = new Error(data?.error || data?.message || text.trim() || `HTTP ${res.status}`);
      Object.assign(error, { code: data?.code, retryAt: data?.retry_at });
      throw error;
    }
    return data;
  }

  // Same request the site's "Open Case" button sends.
  async function openCrate(inventoryItemId) {
    const data = await apiPost("/api/inventory/open-crate", { inventory_item_id: inventoryItemId });
    if (!data?.Skins?.length) throw new Error("The server returned no reel for this case.");
    return data;
  }

  async function loadCaseInfo(itemId) {
    loadingFor = itemId;
    try {
      const res = await fetch("/api/inventory", { credentials: "include" });
      if (!res.ok) throw new Error(`GET /api/inventory → ${res.status}`);
      const { items = [] } = await res.json();
      const current = items.find((i) => String(i.id) === itemId);
      if (!current?.crate || siteItemId() !== itemId) return;
      // This copy first, then the rest of the same case, oldest first.
      const ownedIds = [
        current.id,
        ...items.filter((i) => i.id !== current.id && i.crate?.id === current.crate.id).map((i) => i.id).sort((a, b) => a - b),
      ];
      caseInfo = { itemId, crateId: current.crate.id, crateName: current.crate.name, ownedIds, unitCost: null };
      loadCaseCost(caseInfo);
      count = Math.min(Math.max(1, count), maxCount());
      update();
    } catch (e) {
      console.error("[CSGOPremier Multi-open]", e);
    } finally {
      loadingFor = null;
    }
  }

  // What one of these cases costs in the shop right now, for "did that pay off?" after opening. It's the
  // price you'd pay today (the Pro price on a Pro account), not necessarily what this copy cost you.
  async function loadCaseCost(info) {
    try {
      const res = await fetch(`/api/shop/cases/${encodeURIComponent(info.crateId)}`, { credentials: "include" });
      if (!res.ok) return;
      const shop = await res.json();
      const cost = shop?.is_pro ? (shop.pro_price_pp ?? shop.price_pp) : shop?.price_pp;
      if (info === caseInfo && typeof cost === "number") info.unitCost = cost;
    } catch {
      /* the profit line is simply left out */
    }
  }

  const maxCount = () => Math.min(caseInfo?.ownedIds.length || 0, MAX_CASES);

  // ---------- controls ----------

  function chipClass(active) {
    return (
      "inline-flex min-h-8 items-center justify-center border px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors " +
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary " +
      (active ? "border-primary/60 bg-white/[0.05] text-primary" : "border-transparent text-white/45 hover:text-white/75")
    );
  }

  const presets = (max) => [...[1, 2, 3].filter((n) => n < max), max];

  // Only touches the DOM when something changed: our own writes would otherwise re-trigger the observer.
  function renderRow(row) {
    const max = maxCount();
    const key = `${caseInfo.ownedIds.length}|${max}|${count}|${busy}`;
    if (row.dataset.key === key) return;
    row.dataset.key = key;
    const options = presets(max);
    // A single copy needs no picker.
    row.querySelector(".cip-chips").hidden = max <= 1;
    row.querySelector(".cip-presets").innerHTML = options
      .map((n) => `<button type="button" data-n="${n}" class="${chipClass(n === count)}"${busy ? " disabled" : ""}>${n === max && max > 1 ? `Max ${n}` : n}</button>`)
      .join("");
    const custom = row.querySelector(".cip-custom");
    const input = custom.querySelector("input");
    const isCustom = !options.includes(count);
    custom.className = `cip-custom ${chipClass(isCustom)} gap-2`;
    input.max = String(max);
    input.disabled = busy;
    if (document.activeElement !== input) input.value = isCustom ? String(count) : "";
    row.querySelector(".cip-owned").textContent = `${caseInfo.ownedIds.length} owned`;
    row.querySelector(".cip-go-label").textContent = busy ? "Opening…" : count === 1 ? "Open case · Free" : `Open ${count} cases · Free`;
    row.querySelector(".cip-go-icon").innerHTML = count === 1 ? LOCK_OPEN_ICON : LAYERS_ICON;
    row.querySelector(".cip-go").disabled = busy;
  }

  function createRow() {
    const row = document.createElement("div");
    row.id = ROW_ID;
    row.innerHTML = `
      <div class="mb-3 flex items-center justify-between gap-3">
        <span class="font-mono text-[9px] font-bold uppercase tracking-widest text-white/55">Quantity</span>
        <span class="cip-owned font-mono text-[9px] font-bold uppercase tracking-widest text-white/35"></span>
      </div>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="cip-chips inline-flex max-w-full items-center gap-1 overflow-x-auto border border-white/10 bg-black/25 p-1">
          <div class="cip-presets inline-flex gap-1"></div>
          <label class="cip-custom">
            <span style="color:inherit">Custom</span>
            <input type="number" min="1" step="1" inputmode="numeric" placeholder="–" aria-label="Custom number of cases"
              class="w-10 bg-transparent text-center font-mono tabular-nums text-white placeholder:text-white/30 focus:outline-none">
          </label>
        </div>
        <button type="button" class="cip-go relative inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap font-bold uppercase tracking-wider transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 bg-primary/10 border border-primary/30 text-primary hover:bg-primary/20 text-xs py-3 px-8 min-w-[140px] group/btn overflow-hidden">
          <div class="absolute inset-0 -translate-x-full group-hover/btn:translate-x-full transition-transform duration-700 bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none z-0"></div>
          <span class="relative z-10 inline-flex items-center gap-2"><span class="cip-go-icon inline-flex"></span><span class="cip-go-label"></span></span>
          <div class="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l transition-colors border-primary/30 group-hover/btn:border-primary/60"></div>
          <div class="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r transition-colors border-primary/30 group-hover/btn:border-primary/60"></div>
        </button>
      </div>`;
    row.querySelector(".cip-presets").addEventListener("click", (e) => {
      const n = Number(e.target.closest("button[data-n]")?.dataset.n);
      if (!n || busy) return;
      count = n;
      renderRow(row);
    });
    const input = row.querySelector(".cip-custom input");
    input.addEventListener("input", () => {
      const n = Math.floor(Number(input.value));
      if (!n || busy) return;
      count = Math.min(Math.max(n, 1), maxCount());
      renderRow(row);
    });
    input.addEventListener("blur", () => {
      row.dataset.key = ""; // show the clamped number
      renderRow(row);
    });
    row.querySelector(".cip-go").addEventListener("click", () => openMultiple());
    return row;
  }

  // ---------- reels ----------

  // All the reels have to be watchable at once, so they share the height the window has left: one case
  // keeps the site's own size, ten shrink to fit. Below that the names go, since there's no room to read
  // them mid-spin anyway. Sizes are inline because they're computed per opening.
  function reelSize(count) {
    const CHROME = 170; // panel header, the row under it and the page's own margins
    const columns = count > 12 ? 2 : 1; // past a dozen, two columns beat one postage-stamp-sized row each
    const rows = Math.ceil(Math.max(1, count) / columns);
    const per = Math.max(46, (window.innerHeight - CHROME) / rows);
    const padY = per >= 110 ? 10 : per >= 76 ? 6 : 3;
    const itemPad = per >= 76 ? 6 : 3;
    const showNames = per >= 92;
    const nameH = showNames ? 17 : 0;
    const imageH = Math.round(Math.max(26, Math.min(ITEM_WIDTH * 0.75, per - 2 * padY - 2 * itemPad - nameH - 2)));
    return { columns, padY, itemPad, showNames, imageH, itemWidth: Math.round((imageH * 4) / 3) };
  }

  function stripHtml(skins, winningIndex, size = reelSize(1)) {
    const items = skins
      .map((s, i) => {
        const color = s.rarity_color || RARITY_COLORS[s.rarity] || "#4b69ff";
        return `
          <div class="relative flex-shrink-0 border-r border-white/[0.06] bg-white/[0.012] transition-colors${i === winningIndex ? " bg-primary/[0.035]" : ""}" style="width:${size.itemWidth}px;padding:${size.itemPad}px 8px">
            <div class="flex items-center justify-center p-1" style="height:${size.imageH}px;background:radial-gradient(circle at center, ${color}16 0%, transparent 70%)">
              <img src="${escapeHtml(s.image_url)}" alt="${escapeHtml(s.name)}" class="max-h-full max-w-full object-contain drop-shadow-lg" loading="eager">
            </div>
            ${size.showNames ? `<p class="mt-1.5 truncate text-center text-[10px] font-medium text-white/70">${escapeHtml(s.name)}</p>` : ""}
            <div class="absolute inset-x-2 bottom-0 h-px" style="background-color:${color}"></div>
          </div>`;
      })
      .join("");
    // Markup of the site's CaseStrip component.
    return `
      <div class="relative overflow-hidden bg-[#080d12]" style="padding:${size.padY}px 0">
        <div class="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-secondary/35 to-transparent"></div>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-px bg-gradient-to-r from-transparent via-secondary/20 to-transparent"></div>
        <div class="absolute bottom-0 left-1/2 top-0 z-20 w-px -translate-x-1/2 bg-primary shadow-[0_0_12px_rgba(246,8,100,0.75)]">
          <div class="absolute left-1/2 top-0 h-0 w-0 -translate-x-1/2 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-primary"></div>
          <div class="absolute bottom-0 left-1/2 h-0 w-0 -translate-x-1/2 border-b-[8px] border-l-[6px] border-r-[6px] border-b-primary border-l-transparent border-r-transparent"></div>
        </div>
        <div class="cip-track flex will-change-transform" style="transform:translateX(0px);transition:none">${items}</div>
        <div class="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-[#080d12] via-[#080d12]/85 to-transparent sm:w-24"></div>
        <div class="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-[#080d12] via-[#080d12]/85 to-transparent sm:w-24"></div>
      </div>`;
  }

  // Frame of the site's "Case opening" panel.
  function panelHtml(status, body) {
    return `
      <div aria-live="polite" class="relative overflow-hidden border border-primary/25 bg-black/25">
        <span class="pointer-events-none absolute left-0 top-0 z-20 h-4 w-4 border-l-2 border-t-2 border-primary/70"></span>
        <span class="pointer-events-none absolute bottom-0 right-0 z-20 h-4 w-4 border-b-2 border-r-2 border-primary/70"></span>
        <div class="flex items-center justify-between border-b border-white/5 bg-primary/[0.035] px-3 py-2.5 font-mono text-[9px] uppercase tracking-widest sm:px-4">
          <div class="flex items-center gap-2 font-bold text-white/70"><span class="h-1.5 w-1.5 bg-primary"></span>Case opening</div>
          <span class="cip-status font-bold text-primary">${escapeHtml(status)}</span>
        </div>
        <div class="cip-body">${body}</div>
      </div>`;
  }

  const fmtPP = (n) => Number(n).toLocaleString("en-US");
  // Same look as the price on the site's item cards.
  const priceHtml = (pp) =>
    pp == null
      ? ""
      : `<p class="mt-2 text-sm font-bold tabular-nums text-white">${fmtPP(pp)}<span class="ml-1 text-[10px] italic font-bold text-secondary">PP</span></p>`;

  // prices: Map of inventory item id → pp_value, for drops whose InventoryItem didn't include it.
  // cost: what the opened cases would cost in the shop, when it's known.
  function resultsHtml(results, error, prices = new Map(), cost = null) {
    const B = window.__cipBadges; // badges-core.js
    let rare = 0;
    let total = 0;
    let priced = 0;
    const cards = results
      .map(({ DroppedSkin: s, InventoryItem: item }) => {
        const pp = item?.pp_value ?? prices.get(item?.id) ?? null;
        if (pp != null) {
          total += pp;
          priced++;
        }
        const color = s.rarity_color || RARITY_COLORS[s.rarity] || "#4b69ff";
        const float = typeof item?.float_value === "number" ? item.float_value.toFixed(8) : "";
        const badges = B ? B.badgesFor(item, s) : [];
        // Rare drops get a border and glow in their best badge's colour.
        const glow = B?.topColor(badges);
        if (glow) rare++;
        const highlight = glow ? ` style="border-color:${glow}99;box-shadow:0 0 18px ${glow}40, inset 0 0 24px ${glow}14"` : "";
        return `
          <div class="cip-drop relative flex flex-col border border-white/10 bg-white/[0.012] p-3" data-id="${item.id}"${highlight}>
            <label class="cip-pick absolute right-2 top-2 z-10 flex h-4 w-4 cursor-pointer items-center justify-center border border-white/25 bg-black/50 transition-colors hover:border-white/60" title="Pick this item">
              <input type="checkbox" class="cip-pick-box h-3 w-3 cursor-pointer accent-secondary" data-pick="${item.id}">
            </label>
            <div class="relative flex aspect-[4/3] items-center justify-center p-1" style="background:radial-gradient(circle at center, ${color}26 0%, transparent 70%)">
              <img src="${escapeHtml(s.image_url)}" alt="${escapeHtml(s.name)}" class="max-h-full max-w-full object-contain drop-shadow-lg">
            </div>
            <p class="mt-2 text-[10px] font-semibold" style="color:${color}">${escapeHtml(s.rarity)}${s.phase ? ` · ${escapeHtml(s.phase)}` : ""}</p>
            <p class="truncate text-xs font-bold text-white">${escapeHtml(s.name)}</p>
            ${float ? `<p class="mt-1 font-mono text-[10px] text-white/45">${float}</p>` : ""}
            ${badges.length ? `<div class="mt-2 flex flex-wrap gap-1">${B.badgeHtml(badges)}</div>` : ""}
            ${priceHtml(pp)}
            <div class="cip-actions mt-auto pt-3">${actionsHtml(item.id)}</div>
            <div class="absolute inset-x-3 bottom-0 h-px" style="background-color:${color}"></div>
          </div>`;
      })
      .join("");
    const rareLine = rare
      ? `<p class="mb-3 font-mono text-[10px] font-bold uppercase tracking-widest" style="color:${B.COLORS.gold}">★ ${rare} rare ${rare === 1 ? "drop" : "drops"}: extreme float or notable pattern</p>`
      : "";

    // Did it pay off? Total value of the drops against what the cases cost in the shop.
    let profitLine = "";
    if (priced === results.length && cost != null && results.length) {
      const spent = cost * results.length;
      const profit = total - spent;
      const pct = spent ? Math.round((profit / spent) * 100) : 0;
      const up = profit >= 0;
      const color = up ? "text-quaternary" : "text-primary";
      profitLine = `
        <div class="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border border-white/[0.07] bg-black/25 px-3 py-2 text-[11px]">
          <span class="text-white/45">${results.length} × <span class="tabular-nums text-white/70">${fmtPP(cost)}</span> PP
            = <span class="font-bold tabular-nums text-white/70">${fmtPP(spent)}</span> PP spent</span>
          <span class="text-white/45">Drops <span class="font-bold tabular-nums text-white">${fmtPP(total)}</span> PP</span>
          <span class="font-bold ${color}">${up ? "Profit" : "Loss"} ${up ? "+" : "−"}${fmtPP(Math.abs(profit))} PP
            <span class="font-mono text-[10px]">(${up ? "+" : "−"}${Math.abs(pct)}%)</span></span>
        </div>`;
    }
    return `
      <div class="p-4 sm:p-5">
        ${error ? `<p class="mb-4 border border-yellow-400/30 bg-yellow-400/10 px-3 py-2 text-xs text-yellow-400">${escapeHtml(error)}</p>` : ""}
        ${profitLine}
        ${rareLine}
        <div class="cip-bulk-bar mb-3"></div>
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">${cards}</div>
        <div class="mt-4 flex items-center justify-between gap-3">
          <p class="text-xs text-white/60">${results.length} ${results.length === 1 ? "item" : "items"} added to your inventory.${
            priced ? ` Total value <span class="font-bold tabular-nums text-white">${fmtPP(total)}</span><span class="ml-0.5 text-[10px] italic font-bold text-secondary">PP</span>.` : ""
          }</p>
          <button type="button" class="cip-done relative inline-flex items-center justify-center whitespace-nowrap border border-white/15 bg-white/[0.04] px-5 py-2 text-xs font-bold uppercase tracking-wider text-white/80 transition-colors hover:bg-white/[0.08]">Done</button>
        </div>
      </div>`;
  }

  function spin(container, results) {
    return new Promise((resolve) => {
      const tick = new Audio("/sounds/crate_sound_tick.wav");
      tick.volume = 0.3;
      const strips = results.map((r, i) => {
        const wrap = container.querySelectorAll(".cip-strip")[i];
        const track = wrap.querySelector(".cip-track");
        const winningIndex = Math.floor(r.Skins.length / 2);
        const width = track.parentElement.clientWidth || 840;
        // Measured, because the items shrink when several reels share the screen.
        const itemW = track.firstElementChild?.getBoundingClientRect().width || ITEM_WIDTH;
        const jitter = Math.min(48, itemW * 0.4) * (Math.random() - 0.5); // land somewhere on the winning item
        return { track, itemW, offset: itemW * winningIndex - (width / 2 - itemW / 2) + jitter };
      });
      // Start on the next frame so the initial transform is applied before the transition.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const { track, offset } of strips) {
            track.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.15, 0.85, 0.3, 1)`;
            track.style.transform = `translateX(-${offset}px)`;
          }
          // One tick per item passing the marker, from the first reel only (all of them at once is noise).
          const first = strips[0].track;
          const firstItemW = strips[0].itemW;
          let lastIndex = -1;
          let running = true;
          (function loop() {
            if (!running) return;
            const m = getComputedStyle(first).transform;
            if (m && m !== "none") {
              const index = Math.floor((-new DOMMatrix(m).m41 + first.parentElement.clientWidth / 2) / firstItemW);
              if (index !== lastIndex) {
                lastIndex = index;
                const t = tick.cloneNode();
                t.volume = 0.3;
                t.play().catch(() => {});
              }
            }
            requestAnimationFrame(loop);
          })();
          setTimeout(() => {
            running = false;
            resolve();
          }, SPIN_MS + 150);
        })
      );
    });
  }

  // Every inventory item (one request): the drops' prices when the open response has none, and what
  // Sell / Burn need to know (market_eligible, burn_payout, sell_locked, …).
  async function loadItems() {
    try {
      const res = await fetch("/api/inventory", { credentials: "include" });
      const { items = [] } = await res.json();
      return new Map(items.map((i) => [i.id, i]));
    } catch {
      return new Map();
    }
  }

  // ---------- selling and burning the drops ----------

  const MARKET_CATEGORIES = ["Pistols", "SMGs", "Rifles", "Heavy", "Knives", "Gloves", "Agents", "Music Kits", "Stickers"];
  const trades = new Map(); // item id → { status, item, quote, requestKey, error, amount }
  let tradeTimer = null;

  // The site's rules (case reveal): why an item can't be sold or burned, if it can't.
  function blockedReason(item) {
    if (item.source === "admin_grant") return "Admin gifts cannot be sold or burned.";
    if (item.sell_locked) return "This item is locked.";
    if (item.imported_from_steam || item.source === "steam_sync") return "Steam items cannot be redeemed.";
    if (item.quick_sell_percentage <= 0) return item.quick_sell_reason || "This item cannot be sold or burned.";
    return "";
  }
  const canMarket = (item) =>
    !blockedReason(item) && item.market_eligible === true && (!!item.sticker || MARKET_CATEGORIES.includes(item.skin?.category));
  const canBurn = (item) => !blockedReason(item) && item.burn_payout > 0 && !item.burn_unavailable_reason;

  const ACT = "inline-flex w-full items-center justify-center gap-1.5 whitespace-nowrap border px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-all disabled:pointer-events-none disabled:opacity-50";
  const SELL = `${ACT} bg-secondary/10 border-secondary/30 text-secondary hover:bg-secondary/20`; // site "tactical-secondary"
  const BURN = `${ACT} bg-tertiary/10 border-tertiary/30 text-tertiary hover:bg-tertiary/20`; // site "tactical-tertiary"
  const GRAY = `${ACT} bg-white/5 border-white/15 text-white/70 hover:bg-white/10`;
  const note = (text, color = "text-white/45") => `<p class="text-[10px] leading-4 ${color}">${escapeHtml(text)}</p>`;
  const secondsLeft = (quote) => Math.max(0, Math.ceil((Date.parse(quote.expires_at) - Date.now()) / 1000));

  function errorText(e) {
    const when = e.retryAt ? new Date(e.retryAt) : null;
    if (e.code === "market_purchase_protection" && when && Number.isFinite(when.getTime())) {
      return when <= new Date() ? `${e.message} Purchase protection has ended, get a new offer.` : `${e.message} Try again from ${when.toLocaleString()}.`;
    }
    return e.message;
  }

  function actionsHtml(id) {
    const t = trades.get(id);
    if (!t) return "";
    const { item } = t;
    if (t.status === "sold") return note(`Sold for ${fmtPP(t.amount)} PP`, "text-quaternary font-bold");
    if (t.status === "burned") return note(`Burned for ${fmtPP(t.amount)} PP`, "text-tertiary font-bold");
    if (t.status === "selling") return `<button type="button" class="${SELL}" disabled>Selling…</button>`;
    if (t.status === "burning") return `<button type="button" class="${BURN}" disabled>Burning…</button>`;
    if (t.status === "burnConfirm") {
      return `<div class="grid gap-1">
        <button type="button" class="${BURN}" data-act="burn-confirm">Confirm burn · ${fmtPP(item.burn_payout)} PP</button>
        <button type="button" class="${GRAY}" data-act="cancel">Cancel</button></div>`;
    }
    const blocked = blockedReason(item);
    if (blocked) return note(blocked);

    const parts = [];
    if (canMarket(item)) {
      if (t.status === "quoting") parts.push(`<button type="button" class="${SELL}" disabled>Getting offer…</button>`);
      else if (t.status === "offer" && secondsLeft(t.quote) > 0) {
        parts.push(`<p class="text-[10px] leading-4 text-white/60">Offer <span class="font-bold tabular-nums text-white">${fmtPP(t.quote.amount_pp)}</span> PP · <span class="cip-countdown tabular-nums">${secondsLeft(t.quote)}s</span></p>`);
        parts.push(`<button type="button" class="${SELL}" data-act="sell">Sell · ${fmtPP(t.quote.amount_pp)} PP</button>`);
      } else {
        if (t.status === "offer") parts.push(note("Offer expired."));
        parts.push(`<button type="button" class="${SELL}" data-act="quote">${t.status === "offer" ? "New offer" : "Get offer"}</button>`);
      }
    } else parts.push(note("Not accepted by the Market."));
    if (t.error) parts.unshift(note(t.error, "text-amber-300"));
    if (canBurn(item)) parts.push(`<button type="button" class="${BURN}" data-act="burn">Burn · ${fmtPP(item.burn_payout)} PP</button>`);
    else if (item.burn_unavailable_reason) parts.push(note(item.burn_unavailable_reason));
    return `<div class="grid gap-1">${parts.join("")}</div>`;
  }

  // ---------- acting on several drops at once ----------

  const picked = new Set(); // ids ticked in the results grid

  const openTrades = () => [...trades.values()].filter((t) => !["sold", "burned", "selling", "burning"].includes(t.status));
  const sellableTrades = () => openTrades().filter((t) => canMarket(t.item));
  const burnableTrades = () => openTrades().filter((t) => canBurn(t.item));
  // With nothing ticked the buttons act on everything they can; ticking narrows them down.
  const targets = (list) => (picked.size ? list.filter((t) => picked.has(t.item.id)) : list);

  function renderBulkBar(confirm = null) {
    const bar = document.querySelector(`#${REELS_ID} .cip-bulk-bar`);
    if (!bar) return;
    const sell = targets(sellableTrades());
    const burn = targets(burnableTrades());
    const burnTotal = burn.reduce((sum, t) => sum + (t.item.burn_payout || 0), 0);
    const all = picked.size === 0;

    if (confirm === "burn") {
      bar.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3 border border-tertiary/30 bg-tertiary/[0.06] px-3 py-2">
          <p class="text-[11px] text-white/70">Burn ${burn.length} ${burn.length === 1 ? "item" : "items"} for
            <span class="font-bold tabular-nums text-tertiary">+${fmtPP(burnTotal)}</span> PP? This cannot be undone.</p>
          <div class="flex items-center gap-2">
            <button type="button" class="${GRAY} w-auto px-3" data-bulk="cancel">Cancel</button>
            <button type="button" class="${BURN} w-auto px-3" data-bulk="burn-confirm">Confirm burn</button>
          </div>
        </div>`;
      return;
    }

    const count = openTrades().length;
    if (!count) {
      bar.innerHTML = "";
      return;
    }
    bar.innerHTML = `
      <div class="flex flex-wrap items-center justify-between gap-3 border border-white/[0.07] bg-black/25 px-3 py-2">
        <div class="flex items-center gap-3 text-[11px]">
          <span class="font-mono text-[10px] font-bold uppercase tracking-widest ${picked.size ? "text-secondary" : "text-white/35"}">
            ${picked.size ? `${picked.size} picked` : "Nothing picked"}</span>
          <button type="button" class="text-[11px] font-bold uppercase tracking-wider text-white/45 transition-colors hover:text-white" data-bulk="${picked.size ? "clear" : "all"}">
            ${picked.size ? "Clear" : "Select all"}</button>
        </div>
        <div class="flex items-center gap-2">
          <button type="button" class="${SELL} w-auto px-3" data-bulk="sell"${sell.length ? "" : " disabled"}>
            ${all ? "Sell all" : "Sell"} · ${sell.length}</button>
          <button type="button" class="${BURN} w-auto px-3" data-bulk="burn"${burn.length ? "" : " disabled"}>
            ${all ? "Burn all" : "Burn"} · ${burn.length}${burnTotal ? ` · +${fmtPP(burnTotal)} PP` : ""}</button>
        </div>
      </div>`;
  }

  function syncPickBoxes() {
    for (const box of document.querySelectorAll(`#${REELS_ID} .cip-pick-box`)) {
      const id = Number(box.dataset.pick);
      const done = ["sold", "burned"].includes(trades.get(id)?.status);
      box.checked = picked.has(id);
      box.disabled = done;
      box.closest(".cip-pick").style.display = done ? "none" : "";
    }
  }

  // Burning several at once is one request, the same the site's own bulk burn uses.
  async function burnPicked() {
    const burn = targets(burnableTrades());
    if (!burn.length) return;
    for (const t of burn) t.status = "burning";
    for (const t of burn) renderActions(t.item.id);
    renderBulkBar();
    try {
      const res = await apiPost("/api/inventory/burn-bulk", { item_ids: burn.map((t) => t.item.id) });
      const skipped = new Map((res?.skipped || []).map((s) => [s.item_id, s.reason]));
      for (const t of burn) {
        if (skipped.has(t.item.id)) {
          t.status = "idle";
          t.error = skipped.get(t.item.id);
        } else {
          t.status = "burned";
          t.amount = t.item.burn_payout;
        }
      }
      refreshAfterTrade(res?.new_balance);
    } catch (e) {
      for (const t of burn) {
        t.status = "idle";
        t.error = errorText(e);
      }
    }
    picked.clear();
    for (const t of burn) renderActions(t.item.id);
    syncPickBoxes();
    renderBulkBar();
  }

  // Selling several goes through the shared Market flow (bulk quotes, one confirmation, then each sale).
  async function sellPicked() {
    const sell = targets(sellableTrades());
    const bulk = window.__cipBulkMarket;
    if (!sell.length || !bulk) return;
    const outcome = await bulk.sellItems(sell.map((t) => t.item), { refresh: false });
    if (!outcome) return; // cancelled
    for (const row of outcome.sold) {
      const t = trades.get(row.id);
      if (!t) continue;
      t.status = "sold";
      t.amount = row.amount;
    }
    for (const row of outcome.failed) {
      const t = trades.get(row.id);
      if (t) t.error = row.error;
    }
    refreshAfterTrade(outcome.balance);
    picked.clear();
    for (const t of sell) renderActions(t.item.id);
    syncPickBoxes();
    renderBulkBar();
  }

  function onBulkClick(e) {
    const act = e.target.closest("button[data-bulk]")?.dataset.bulk;
    if (!act) return;
    if (act === "all") for (const t of openTrades()) picked.add(t.item.id);
    else if (act === "clear") picked.clear();
    else if (act === "burn") return renderBulkBar("burn");
    else if (act === "cancel") return renderBulkBar();
    else if (act === "burn-confirm") return burnPicked();
    else if (act === "sell") return sellPicked();
    syncPickBoxes();
    renderBulkBar();
  }

  function renderActions(id) {
    const card = document.querySelector(`#${REELS_ID} .cip-drop[data-id="${id}"]`);
    if (!card) return;
    card.querySelector(".cip-actions").innerHTML = actionsHtml(id);
    const done = ["sold", "burned"].includes(trades.get(id)?.status);
    card.style.opacity = done ? "0.55" : "";
  }

  // Live offer countdowns (and expiry), once a second while any offer is open.
  function tickOffers() {
    let live = false;
    for (const [id, t] of trades) {
      if (t.status !== "offer") continue;
      const left = secondsLeft(t.quote);
      const el = document.querySelector(`#${REELS_ID} .cip-drop[data-id="${id}"] .cip-countdown`);
      if (left > 0 && el) {
        el.textContent = `${left}s`;
        live = true;
      } else if (left <= 0 && el) renderActions(id); // shows "Offer expired" + New offer
    }
    if (!live) {
      clearInterval(tradeTimer);
      tradeTimer = null;
    }
  }

  // After a sale or burn, refresh what the site shows (as the site's own sell/burn does).
  function refreshAfterTrade(balance) {
    const client = findQueryClient();
    if (!client) return;
    if (typeof balance === "number") client.setQueryData(["pp-balance"], (old) => (old ? { ...old, balance } : old));
    for (const key of ["inventory", "my-stickers", "market-stock", "pp-balance", "skin-database"]) client.invalidateQueries({ queryKey: [key] });
  }

  async function onTradeClick(e) {
    if (e.target.closest("button[data-bulk]")) return onBulkClick(e);
    const box = e.target.closest(".cip-pick-box");
    if (box) {
      const id = Number(box.dataset.pick);
      if (box.checked) picked.add(id);
      else picked.delete(id);
      return renderBulkBar();
    }
    const btn = e.target.closest("button[data-act]");
    const card = btn?.closest(".cip-drop");
    if (!card) return;
    const id = Number(card.dataset.id);
    const t = trades.get(id);
    if (!t) return;
    const act = btn.dataset.act;
    t.error = "";

    if (act === "cancel") t.status = "idle";
    else if (act === "burn") t.status = "burnConfirm";
    else if (act === "quote") {
      t.status = "quoting";
      renderActions(id);
      try {
        t.quote = await apiPost("/api/market/quote", { operation: "sell", id, daily: false });
        t.requestKey = crypto.randomUUID();
        t.status = "offer";
        tradeTimer ??= setInterval(tickOffers, 1000);
      } catch (err) {
        t.status = "idle";
        t.error = errorText(err);
      }
    } else if (act === "sell") {
      if (!t.quote || secondsLeft(t.quote) <= 0) return renderActions(id);
      t.status = "selling";
      renderActions(id);
      try {
        const res = await apiPost("/api/market/execute", { quote_id: t.quote.id, request_key: t.requestKey });
        t.status = "sold";
        t.amount = t.quote.amount_pp;
        refreshAfterTrade(res?.balance_pp);
      } catch (err) {
        t.status = "offer"; // the site offers "Retry sale" with the same offer
        t.error = errorText(err);
      }
    } else if (act === "burn-confirm") {
      t.status = "burning";
      renderActions(id);
      try {
        const res = await apiPost(`/api/inventory/${id}/burn`);
        t.status = "burned";
        t.amount = res?.payout ?? t.item.burn_payout;
        refreshAfterTrade(res?.new_balance);
      } catch (err) {
        t.status = "idle";
        t.error = errorText(err);
      }
    }
    renderActions(id);
  }

  function findQueryClient() {
    for (let f = fiberOf(document.querySelector("main") || document.body.firstElementChild), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  // "Done": put the page back as it was before opening, with fresh data instead of a reload.
  //  - Case Shop page (/armory/crates/…): the site's card shows the case copy the server names in
  //    ["case-detail", id] (owned_inventory_item_id); refreshing that (and the inventory and PP balance)
  //    moves the card to the next unopened copy, or to "none owned".
  //  - Inventory case page (/inventory/<id>): that copy is opened now, so go (in-app, no reload) to the
  //    next copy of the same case, or to the inventory when none are left.
  function resetAfterOpen(opened) {
    document.getElementById(REELS_ID)?.remove();
    trades.clear();
    clearInterval(tradeTimer);
    tradeTimer = null;
    const button = findOpenButton();
    button?.closest(".space-y-3 > *")?.style.removeProperty("display");
    const remaining = caseInfo?.ownedIds || [];
    caseInfo = null; // reloaded for whichever copy the card offers next
    if (!opened) return update();

    const client = findQueryClient();
    for (const queryKey of [["case-detail"], ["inventory"], ["pp-balance"]]) client?.invalidateQueries({ queryKey });

    if (location.pathname.startsWith("/inventory/")) {
      const to = remaining.length ? `/inventory/${remaining[0]}` : "/inventory";
      if (window.next?.router?.push) window.next.router.push(to);
      else location.assign(to);
    }
    update();
  }

  // The panel goes in above the case card, so the page below it shifts; each swap (preparing → reels →
  // results) also changes its height. Put it back under the site's top bar after every swap instead of
  // leaving the view wherever the reflow dropped it.
  // Keep the page still. The panel is inserted below the button, so nothing above it moves; the only
  // scrolling left is the minimum needed to actually see the reels, and only when they don't fit as they
  // are. Swapping the panel's contents (preparing → spinning → results) never scrolls on its own.
  function focusReels(reels) {
    const rect = reels.getBoundingClientRect();
    const room = window.innerHeight - HEADER_OFFSET;
    if (rect.top >= HEADER_OFFSET && rect.bottom <= window.innerHeight) return; // already fully in view
    // Scroll as little as possible: bring the top under the header when the panel is taller than the
    // screen or starts above it, otherwise just lift its bottom into view.
    const top =
      rect.height >= room || rect.top < HEADER_OFFSET
        ? rect.top + window.scrollY - HEADER_OFFSET
        : rect.bottom + window.scrollY - window.innerHeight;
    window.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  }

  async function openMultiple() {
    if (busy || !caseInfo) return;
    const ids = caseInfo.ownedIds.slice(0, count);
    busy = true;
    update();

    const host = findOpenButton()?.closest(".space-y-3") || document.getElementById(ROW_ID)?.parentElement;
    let reels = document.getElementById(REELS_ID);
    if (!reels) {
      reels = document.createElement("div");
      reels.id = REELS_ID;
      // Right below the quantity row, i.e. where you just clicked. Putting it at the top of the column
      // pushed the whole card down and the page appeared to jump.
      const row = document.getElementById(ROW_ID);
      if (row) row.insertAdjacentElement("afterend", reels);
      else host.prepend(reels);
    }
    const preparing = `
      <div class="flex items-center gap-3 px-4 py-6">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"></span>
        <div>
          <p class="cip-progress text-sm font-bold text-white">Preparing cases</p>
          <p class="mt-0.5 text-xs text-white/45">Locking the results and building your reels…</p>
        </div>
      </div>`;
    reels.innerHTML = panelHtml("Preparing", preparing);
    focusReels(reels);

    // One request at a time, like pressing the button repeatedly; stop at the first failure.
    const results = [];
    let error = null;
    for (const id of ids) {
      reels.querySelector(".cip-progress").textContent = `Preparing cases · ${results.length + 1} / ${ids.length}`;
      try {
        results.push(await openCrate(id));
      } catch (e) {
        error = `Opened ${results.length} of ${ids.length}: ${e.message}`;
        console.error("[CSGOPremier Multi-open]", e);
        break;
      }
    }
    console.log(`[CSGOPremier Multi-open] Opened ${results.length} × ${caseInfo.crateName}`, results);

    // The full inventory items (price, and what Sell / Burn need), looked up while the reels spin.
    const itemsPromise = results.length ? loadItems() : Promise.resolve(new Map());

    if (results.length) {
      const size = reelSize(results.length);
      reels.innerHTML = panelHtml(
        "Spinning",
        `<div class="${size.columns > 1 ? "grid grid-cols-2 gap-px bg-white/5" : "divide-y divide-white/5"}">${results
          .map((r) => `<div class="cip-strip">${stripHtml(r.Skins, Math.floor(r.Skins.length / 2), size)}</div>`)
          .join("")}</div>`
      );
      focusReels(reels); // the panel just grew: make sure the reels are on screen before they move
      await spin(reels, results);
    }
    const fullItems = await itemsPromise;
    trades.clear();
    for (const r of results) {
      const item = { ...r.InventoryItem, ...fullItems.get(r.InventoryItem.id) };
      trades.set(item.id, { status: "idle", item });
    }
    const prices = new Map([...fullItems].map(([id, i]) => [id, i.pp_value]));
    const unitCost = caseInfo?.unitCost ?? null; // captured before "Done" clears caseInfo
    picked.clear();
    reels.innerHTML = panelHtml(
      results.length ? `Opened ${results.length}` : "Failed",
      resultsHtml(results, error, prices, unitCost)
    );
    focusReels(reels);
    renderBulkBar();
    reels.onclick = onTradeClick; // one handler, even if the panel is reused
    reels.querySelector(".cip-done").addEventListener("click", () => resetAfterOpen(results.length > 0));

    // These cases are gone now, and so is the one the page's card was for; "Done" brings the page back.
    busy = false;
    lockSiteButton(false); // only matters if nothing opened; otherwise its card is hidden below
    caseInfo.ownedIds = caseInfo.ownedIds.filter((id) => !ids.slice(0, results.length).includes(id));
    document.getElementById(ROW_ID)?.remove();
    const siteButton = findOpenButton();
    if (siteButton && results.length) siteButton.closest(".space-y-3 > *")?.style.setProperty("display", "none");
  }

  // ---------- blocking the site's button while we open ----------

  // The site's own "Open Case · Free" would open the same case we're opening, so it's disabled while we
  // prepare and spin (its disabled: classes grey it out like the site does), and a click guard catches
  // anything that gets through (e.g. if React redraws it enabled).
  const LOCK_ATTR = "data-cip-locked";

  function lockSiteButton(locked) {
    const button = findOpenButton();
    if (!button) return;
    if (locked && !button.hasAttribute(LOCK_ATTR)) {
      button.setAttribute(LOCK_ATTR, button.disabled ? "was-disabled" : "");
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.title = "Opening your cases…";
    } else if (locked && !button.disabled) {
      button.disabled = true;
    } else if (!locked && button.hasAttribute(LOCK_ATTR)) {
      button.disabled = button.getAttribute(LOCK_ATTR) === "was-disabled";
      button.removeAttribute(LOCK_ATTR);
      button.removeAttribute("aria-disabled");
      button.removeAttribute("title");
    }
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!busy) return;
      const button = e.target instanceof Element && e.target.closest("button");
      if (button && button === findOpenButton()) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  // ---------- wiring ----------

  // Our button replaces the site's, which is hidden once ours is in place (a rule rather than inline
  // styles, since React owns the button).
  function hideSiteButton(button) {
    if (!document.getElementById("cip-multi-open-style")) {
      const style = document.createElement("style");
      style.id = "cip-multi-open-style";
      style.textContent = `
        button[data-cip-replaced] { display: none !important; }
        #${ROW_ID} .cip-custom input { -moz-appearance: textfield; appearance: textfield; }
        #${ROW_ID} .cip-custom input::-webkit-inner-spin-button,
        #${ROW_ID} .cip-custom input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }`;
      document.head.appendChild(style);
    }
    if (!button.hasAttribute("data-cip-replaced")) button.setAttribute("data-cip-replaced", "");
  }

  function update() {
    if (!isCasePage()) {
      if (!busy) caseInfo = null;
      return;
    }
    if (busy) {
      // Keep both buttons blocked while preparing and spinning (React may redraw the site's).
      lockSiteButton(true);
      const row = document.getElementById(ROW_ID);
      if (row) renderRow(row);
      return;
    }
    const itemId = siteItemId(); // null unless the site's "Open Case · Free" is on the page
    if (!itemId) return;
    if (caseInfo?.itemId !== itemId) {
      caseInfo = null;
      document.getElementById(ROW_ID)?.remove();
      if (loadingFor !== itemId) loadCaseInfo(itemId);
      return;
    }
    if (!caseInfo.ownedIds.length) return;
    const button = findOpenButton();
    let row = document.getElementById(ROW_ID);
    if (!row) {
      row = createRow();
      button.insertAdjacentElement("afterend", row);
    }
    hideSiteButton(button);
    renderRow(row);
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
