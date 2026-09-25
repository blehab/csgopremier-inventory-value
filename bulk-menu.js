// Right-click actions for several inventory items at once (/inventory).
//
// The site already keeps selectMode and selectedIds in its inventory store, and the bar above the grid
// offers "Sell N items" (quick-sell at the item's rate, usually 60%) and "Delete N items" (burn), each
// with its own dialog and confirmation. Right-clicking a single card opens the site's own item menu.
// What's missing is picking several items from the cards and acting on all of them — and a Market sale
// for more than one item, which the site only offers one item at a time.
//
// This adds:
//   ctrl/cmd-click a card       → select mode on, that card selected
//   shift-click                 → select the run between the last clicked card and this one
//   right-click a selected card → a menu for the whole selection
// Quick-Sell and Burn press the site's own buttons, so their checks and confirmations stay the site's.
// Sell to Market is ours: POST /api/market/quote-sell-bulk (25 items at a time) for the offers, our own
// dialog to confirm them, then POST /api/market/execute per accepted offer, exactly as the site's
// single-item sale does. Nothing is sold until that dialog is confirmed.
//
// Runs in the page's MAIN world, because the store is only reachable through React's fiber tree.
(() => {
  const MENU_ID = "cip-bulk-menu";
  const DIALOG_ID = "cip-bulk-sell";
  const CARD_SELECTOR = "div.grid.grid-cols-2 > article";
  // The site's buttons in the selection bar, by label ("Sell 3 items", "Delete 1 item"). Anchored so the
  // single-item menu's own "Sell to Market" / "Delete Item" entries can't match.
  const SELL_LABEL = /^sell(\s+\d+)?\s+items?$/i;
  const BURN_LABEL = /^delete(\s+\d+)?\s+items?$/i;
  const QUOTE_BATCH = 25; // the endpoint's limit

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];
  const onInventory = () => location.pathname === "/inventory";
  const fmtPP = (n) => Number(n || 0).toLocaleString("en-US");
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let lastClickedId = null; // anchor for shift-click

  function findStoreHook(from) {
    for (let f = fiberOf(from), d = 0; f && d < 80; f = f.return, d++) {
      for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
        const v = h.memoizedState;
        if (v && typeof v.toggleSelected === "function" && typeof v.filteredItems === "function") {
          return typeof h.queue?.getSnapshot === "function" ? h.queue.getSnapshot : () => v;
        }
      }
    }
    return null;
  }

  const getState = () => findStoreHook(document.querySelector(CARD_SELECTOR))?.();

  function itemOf(card) {
    for (let f = fiberOf(card), d = 0; f && d < 12; f = f.return, d++) {
      const item = f.memoizedProps?.item;
      if (item && typeof item === "object" && "id" in item && "skin" in item) return item;
    }
    return null;
  }

  function findQueryClient() {
    for (let f = fiberOf(document.querySelector("main") || document.body.firstElementChild), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  const siteButton = (label) => [...document.querySelectorAll("button")].find((b) => label.test(b.textContent.trim()));

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
    if (!res.ok) throw new Error(data?.error || data?.message || text.trim() || `HTTP ${res.status}`);
    return data;
  }

  // ---------- selection ----------

  function select(state, id, { extend = false } = {}) {
    if (!state.selectMode) state.enterSelectMode();
    if (!extend || lastClickedId == null) {
      if (!getState().selectedIds?.has(id)) getState().toggleSelected(id);
      lastClickedId = id;
      return;
    }
    // shift-click: everything between the anchor and this card, in the order the grid shows them
    const ids = getState()
      .filteredItems()
      .map((i) => i.id);
    const from = ids.indexOf(lastClickedId);
    const to = ids.indexOf(id);
    if (from < 0 || to < 0) return;
    const selected = getState().selectedIds || new Set();
    for (const runId of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      if (!selected.has(runId)) getState().toggleSelected(runId);
    }
  }

  const selectedItems = (state) => state.items.filter((i) => state.selectedIds?.has(i.id));

  // The site's own condition for offering a Market sale, same as the Sellable tab's.
  const MARKET_CATEGORIES = ["Pistols", "SMGs", "Rifles", "Heavy", "Knives", "Gloves", "Agents", "Music Kits", "Stickers"];
  function marketCandidate(item) {
    const usesMarket = !!item.sticker || MARKET_CATEGORIES.includes(item.skin?.category);
    const unsealedGraffiti = item.skin?.category === "Graffiti" && item.graffiti_charges != null;
    return (
      usesMarket &&
      !unsealedGraffiti &&
      !!item.market_eligible &&
      !item.sell_locked &&
      !item.imported_from_steam &&
      item.source !== "admin" &&
      (item.quick_sell_percentage || 0) > 0
    );
  }

  // ---------- menu ----------

  const closeMenu = () => document.getElementById(MENU_ID)?.remove();

  function menuItem(act, text, hint, disabled) {
    return (
      `<button type="button" data-act="${act}"${disabled ? " disabled" : ""} ` +
      `class="flex w-full items-center justify-between gap-6 px-3 py-2 text-left text-xs font-bold uppercase tracking-wider ` +
      `${disabled ? "cursor-not-allowed text-white/25" : "text-white/75 hover:bg-white/[0.06] hover:text-white"}">` +
      `<span>${text}</span>${hint ? `<span class="font-mono text-[10px] font-bold text-white/35">${escapeHtml(hint)}</span>` : ""}</button>`
    );
  }

  function openMenu(x, y, state) {
    closeMenu();
    const count = state.selectedIds?.size || 0;
    const total = state.filteredItems().length;
    const marketable = selectedItems(state).filter(marketCandidate).length;
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className =
      "fixed border border-white/10 bg-[rgba(13,13,18,0.97)] py-1 backdrop-blur-md";
    // Inline, not Tailwind: arbitrary values like z-[200] only exist in the site's stylesheet while the site
    // itself uses them, and without its z-index the menu opens underneath the page.
    menu.style.cssText = "z-index:10050;min-width:232px;box-shadow:0 18px 50px rgba(0,0,0,0.55);";
    menu.innerHTML =
      `<p class="px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-secondary">${count} selected</p>` +
      `<div class="my-1 h-px bg-white/[0.07]"></div>` +
      menuItem("market", "Sell to Market", marketable ? String(marketable) : "none", !marketable) +
      menuItem("quick", "Quick-Sell", "", !count) +
      menuItem("burn", "Burn", "", !count) +
      `<div class="my-1 h-px bg-white/[0.07]"></div>` +
      menuItem("all", "Select all", String(total), !total) +
      menuItem("clear", "Clear selection", "", !count) +
      menuItem("exit", "Exit select mode", "Esc", false);
    document.body.appendChild(menu);

    // Keep it on screen.
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;

    menu.addEventListener("click", (e) => {
      const act = e.target.closest("button[data-act]")?.dataset.act;
      if (!act) return;
      closeMenu();
      const s = getState();
      if (!s) return;
      if (act === "quick" || act === "burn") {
        // The site's own dialog does the rest: eligibility, totals and the confirmation.
        const button = siteButton(act === "quick" ? SELL_LABEL : BURN_LABEL);
        if (button) button.click();
        else console.warn("[CSGOPremier bulk] the site's bulk button wasn't found");
      } else if (act === "market") {
        sellOnMarket(s);
      } else if (act === "all") {
        s.selectAll(s.filteredItems().map((i) => i.id));
      } else if (act === "clear") {
        s.clearSelected();
      } else if (act === "exit") {
        s.exitSelectMode();
        lastClickedId = null;
      }
    });
  }

  // ---------- selling several items on the Market ----------

  const closeDialog = () => {
    document.getElementById(DIALOG_ID)?.remove();
    clearInterval(expiryTimer);
    expiryTimer = null;
    settle(null); // no-op once the sales have reported their own result
  };
  let expiryTimer = null;

  function dialogShell(body, { busy = false } = {}) {
    let el = document.getElementById(DIALOG_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = DIALOG_ID;
      el.className = "fixed inset-0 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm";
      // Inline for the same reason as the menu's: the site no longer ships z-[300], which left this dialog
      // with no z-index, behind the page. Above the site's own dialogs and its item reveal (10000).
      el.style.zIndex = "10100";
      el.addEventListener("click", (e) => {
        if (e.target === el && !el.dataset.busy) closeDialog();
      });
      document.body.appendChild(el);
    }
    el.dataset.busy = busy ? "1" : "";
    el.innerHTML =
      `<div class="relative w-full max-w-lg overflow-hidden border border-primary/25 bg-[rgba(13,13,18,0.98)]" style="max-height:86vh;box-shadow:0 24px 70px rgba(0,0,0,0.6)">
         <span class="pointer-events-none absolute left-0 top-0 z-20 h-4 w-4 border-l-2 border-t-2 border-primary/70"></span>
         <span class="pointer-events-none absolute bottom-0 right-0 z-20 h-4 w-4 border-b-2 border-r-2 border-primary/70"></span>
         ${body}
       </div>`;
    return el;
  }

  const dialogHeader = (status) =>
    `<div class="flex items-center justify-between border-b border-white/5 bg-primary/[0.035] px-4 py-2.5 font-mono text-[9px] uppercase tracking-widest">
       <div class="flex items-center gap-2 font-bold text-white/70"><span class="h-1.5 w-1.5 bg-primary"></span>Sell to Market</div>
       <span class="font-bold text-primary">${escapeHtml(status)}</span>
     </div>`;

  const sellOnMarket = (state) => sellItems(selectedItems(state));

  // Shared with multi-open.js (window.__cipBulkMarket) for the drops of a case opening.
  // Resolves to { sold: [{id, amount}], failed: [{id, error}], balance } once the sales are done,
  // or to null if the dialog was closed without confirming.
  async function sellItems(chosen, { refresh = true } = {}) {
    const candidates = chosen.filter(marketCandidate);
    if (!candidates.length) return null;
    armOutcome();

    dialogShell(
      dialogHeader("Checking") +
        `<div class="flex items-center gap-3 px-5 py-6">
           <span class="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"></span>
           <p class="text-sm text-white/70">Asking the Market for offers on ${candidates.length} ${candidates.length === 1 ? "item" : "items"}…</p>
         </div>`
    );

    // The endpoint takes 25 at a time.
    const offers = new Map(); // item id → { quote } | { error }
    try {
      for (let i = 0; i < candidates.length; i += QUOTE_BATCH) {
        const batch = candidates.slice(i, i + QUOTE_BATCH);
        const res = await apiPost("/api/market/quote-sell-bulk", { item_ids: batch.map((x) => x.id) });
        for (const row of res?.items || []) offers.set(row.item_id, row);
        if (i + QUOTE_BATCH < candidates.length) await new Promise((r) => setTimeout(r, 400));
      }
    } catch (e) {
      settle(null);
      dialogShell(
        dialogHeader("Failed") +
          `<div class="px-5 py-5"><p class="text-sm text-white/70">Could not get offers: ${escapeHtml(e.message)}</p>
             <div class="mt-4 flex justify-end"><button type="button" data-act="close" class="border border-white/15 bg-white/[0.04] px-5 py-2 text-xs font-bold uppercase tracking-wider text-white/80 hover:bg-white/[0.08]">Close</button></div></div>`
      ).addEventListener("click", (ev) => ev.target.closest('[data-act="close"]') && closeDialog());
      return;
    }

    const accepted = candidates
      .map((item) => ({ item, quote: offers.get(item.id)?.quote, error: offers.get(item.id)?.error }))
      .filter((row) => row.quote);
    const refused = candidates
      .map((item) => ({ item, error: offers.get(item.id)?.error || "No offer" }))
      .filter((row) => !offers.get(row.item.id)?.quote);
    const skipped = chosen.length - candidates.length;

    renderOffers(accepted, refused, skipped, refresh);
    return outcome; // resolved by executeSales, or null when the dialog is dismissed
  }

  // The promise sellItems() hands back, settled by whichever way the dialog ends.
  let settle = () => {};
  let outcome = null;
  function armOutcome() {
    outcome = new Promise((resolve) => {
      settle = (value) => {
        settle = () => {};
        resolve(value);
      };
    });
  }

  const earliestExpiry = (rows) => Math.min(...rows.map((r) => new Date(r.quote.expires_at).getTime()));
  const secondsLeft = (rows) => Math.max(0, Math.round((earliestExpiry(rows) - Date.now()) / 1000));

  function renderOffers(accepted, refused, skipped, refresh = true) {
    if (!accepted.length) {
      const reasons = [...new Set(refused.map((r) => r.error))].slice(0, 4);
      dialogShell(
        dialogHeader("No offers") +
          `<div class="px-5 py-5">
             <p class="text-sm text-white/70">The Market wouldn't quote any of the selected items.</p>
             <ul class="mt-3 space-y-1 text-xs text-white/45">${reasons.map((r) => `<li>· ${escapeHtml(r)}</li>`).join("")}</ul>
             <div class="mt-4 flex justify-end"><button type="button" data-act="close" class="border border-white/15 bg-white/[0.04] px-5 py-2 text-xs font-bold uppercase tracking-wider text-white/80 hover:bg-white/[0.08]">Close</button></div>
           </div>`
      ).addEventListener("click", (e) => e.target.closest('[data-act="close"]') && closeDialog());
      return;
    }

    const total = accepted.reduce((sum, r) => sum + (r.quote.amount_pp || 0), 0);
    const rows = accepted
      .map(
        (r, i) => `
        <li class="flex items-center justify-between gap-3 border-t border-white/[0.05] px-4 py-2 text-xs">
          <span class="flex min-w-0 items-center gap-2">
            <span class="w-5 shrink-0 font-mono text-[10px] text-white/30">${i + 1}</span>
            <span class="truncate text-white/80">${escapeHtml(r.item.skin?.name || "Item")}</span>
          </span>
          <span class="shrink-0 font-bold tabular-nums text-white">+${fmtPP(r.quote.amount_pp)}<span class="ml-1 text-[10px] italic font-bold text-secondary">PP</span></span>
        </li>`
      )
      .join("");

    const notes = [];
    if (refused.length) notes.push(`${refused.length} ${refused.length === 1 ? "item has" : "items have"} no offer (${escapeHtml(refused[0].error)}).`);
    if (skipped) notes.push(`${skipped} ${skipped === 1 ? "item isn't" : "aren't"} eligible for the Market.`);

    const el = dialogShell(
      dialogHeader(`${accepted.length} ${accepted.length === 1 ? "offer" : "offers"}`) +
        `<ul class="overflow-y-auto" style="max-height:46vh">${rows}</ul>
         <div class="border-t border-white/[0.07] px-4 py-3">
           <div class="flex items-center justify-between text-sm">
             <span class="text-white/55">You receive</span>
             <span class="font-bold tabular-nums text-white">+${fmtPP(total)}<span class="ml-1 text-[10px] italic font-bold text-secondary">PP</span></span>
           </div>
           ${notes.length ? `<p class="mt-2 text-[11px] leading-4 text-white/35">${notes.join(" ")}</p>` : ""}
           <p class="mt-2 text-[11px] leading-4 text-white/35">Selling is permanent. Offers expire in <span class="cip-expiry font-bold tabular-nums text-white/60"></span>.</p>
           <div class="mt-4 flex items-center justify-end gap-2">
             <button type="button" data-act="cancel" class="border border-white/15 bg-white/[0.04] px-5 py-2 text-xs font-bold uppercase tracking-wider text-white/80 hover:bg-white/[0.08]">Cancel</button>
             <button type="button" data-act="confirm" class="cip-confirm border border-primary/40 bg-primary/15 px-5 py-2 text-xs font-bold uppercase tracking-wider text-primary hover:bg-primary/25">Confirm sell · ${accepted.length}</button>
           </div>
         </div>`
    );

    const tick = () => {
      const left = secondsLeft(accepted);
      const label = el.querySelector(".cip-expiry");
      const confirm = el.querySelector(".cip-confirm");
      if (!label || !confirm) return clearInterval(expiryTimer);
      label.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (left <= 0) {
        confirm.disabled = true;
        confirm.className = confirm.className.replace("text-primary", "text-white/25").replace("hover:bg-primary/25", "");
        confirm.textContent = "Offers expired";
        clearInterval(expiryTimer);
      }
    };
    clearInterval(expiryTimer);
    expiryTimer = setInterval(tick, 1000);
    tick();

    el.addEventListener("click", (e) => {
      if (e.target.closest('[data-act="cancel"]')) closeDialog();
      else if (e.target.closest('[data-act="confirm"]')) executeSales(accepted, refresh);
    });
  }

  async function executeSales(accepted, refresh = true) {
    clearInterval(expiryTimer);
    const done = [];
    const failed = [];
    for (const [i, row] of accepted.entries()) {
      dialogShell(
        dialogHeader("Selling") +
          `<div class="flex items-center gap-3 px-5 py-6">
             <span class="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary"></span>
             <p class="text-sm text-white/70">Selling ${i + 1} of ${accepted.length}…</p>
           </div>`,
        { busy: true }
      );
      try {
        const res = await apiPost("/api/market/execute", { quote_id: row.quote.id, request_key: crypto.randomUUID() });
        done.push({ ...row, balance: res?.balance_pp });
      } catch (e) {
        failed.push({ ...row, error: e.message });
      }
    }

    const earned = done.reduce((sum, r) => sum + (r.quote.amount_pp || 0), 0);
    const balance = done[done.length - 1]?.balance;
    if (refresh) {
      const client = findQueryClient();
      if (typeof balance === "number") client?.setQueryData(["pp-balance"], (old) => (old ? { ...old, balance } : old));
      for (const key of ["inventory", "pp-balance", "market-stock", "my-stickers"]) client?.invalidateQueries({ queryKey: [key] });
      getState()?.exitSelectMode();
      lastClickedId = null;
    }
    settle({
      sold: done.map((r) => ({ id: r.item.id, amount: r.quote.amount_pp })),
      failed: failed.map((r) => ({ id: r.item.id, error: r.error })),
      balance,
    });

    dialogShell(
      dialogHeader(failed.length ? "Partly sold" : "Sold") +
        `<div class="px-5 py-5">
           <p class="text-sm text-white/80">Sold ${done.length} ${done.length === 1 ? "item" : "items"} for
             <span class="font-bold tabular-nums text-white">+${fmtPP(earned)}</span><span class="ml-0.5 text-[10px] italic font-bold text-secondary">PP</span>.</p>
           ${
             failed.length
               ? `<ul class="mt-3 max-h-40 space-y-1 overflow-y-auto text-xs text-white/45">${failed
                   .map((f) => `<li>· ${escapeHtml(f.item.skin?.name || "Item")}: ${escapeHtml(f.error)}</li>`)
                   .join("")}</ul>`
               : ""
           }
           <div class="mt-4 flex justify-end"><button type="button" data-act="close" class="border border-white/15 bg-white/[0.04] px-5 py-2 text-xs font-bold uppercase tracking-wider text-white/80 hover:bg-white/[0.08]">Done</button></div>
         </div>`
    ).addEventListener("click", (e) => e.target.closest('[data-act="close"]') && closeDialog());
  }

  // ---------- wiring ----------

  document.addEventListener(
    "contextmenu",
    (e) => {
      if (!onInventory()) return;
      const card = e.target.closest(CARD_SELECTOR);
      if (!card) return;
      const state = getState();
      const item = itemOf(card);
      if (!state || !item) return;
      // Outside select mode the site's own item menu is the better one: leave it be.
      if (!state.selectMode) return;
      e.preventDefault();
      e.stopPropagation(); // and don't open the site's single-item menu on top of ours
      // Right-clicking a card that isn't in the selection selects it first, the way a file manager does.
      if (!state.selectedIds?.has(item.id)) select(state, item.id);
      openMenu(e.clientX, e.clientY, getState());
    },
    true
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!onInventory()) return;
      if (!e.target.closest(`#${MENU_ID}`)) closeMenu();
      const card = e.target.closest(CARD_SELECTOR);
      if (!card) return;
      const state = getState();
      if (!state) return;
      if (e.ctrlKey || e.metaKey || (e.shiftKey && state.selectMode)) {
        const item = itemOf(card);
        if (!item) return;
        e.preventDefault();
        e.stopPropagation(); // don't open the item while picking several
        select(state, item.id, { extend: e.shiftKey });
      } else if (state.selectMode) {
        lastClickedId = itemOf(card)?.id ?? lastClickedId; // the site's own toggle handles the rest
      }
    },
    true
  );

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !onInventory()) return;
    const dialog = document.getElementById(DIALOG_ID);
    if (dialog) {
      if (!dialog.dataset.busy) closeDialog();
      return;
    }
    if (document.getElementById(MENU_ID)) return closeMenu();
    const state = getState();
    if (state?.selectMode) {
      state.exitSelectMode();
      lastClickedId = null;
    }
  });

  window.addEventListener("scroll", closeMenu, true);
  window.addEventListener("resize", closeMenu);

  // multi-open.js sells a case's drops through the same dialog.
  window.__cipBulkMarket = { sellItems };
})();
