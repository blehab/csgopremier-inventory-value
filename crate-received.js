// Buying a case pops a "Case unlocked!" dialog over the page ("A new case has been added to your
// inventory", with Later / Open now), one per case: buying ten from the cart means ten dialogs. This
// replaces them with a notification in the top-right corner, in the style the site uses for its own
// toasts, one per kind of case: cases that arrive close together are counted into a single
// "Bought 5× Operation Phoenix Case" (or "… received" when the cart isn't buying).
//
// The dialog comes from the site's popup store: the "crate_received" socket event calls
// usePopupStore.getState().showCrateReceived(data). That function is swapped on the store's state for one
// that only queues the notice, so the dialog never opens (zustand copies the state's fields into every new
// state, so the swap stays). Should the dialog open anyway (before the swap, or after a remount), it's
// closed through the site's own hideCrateReceived, which keeps its overlay stack consistent.
//
// Runs in the page's MAIN world, because the store is only reachable through React's fiber tree.
(() => {
  const HOST_ID = "cip-notices";
  const TICK_MS = 500;
  const GROUP_MS = 1500; // quiet time after the last case of a kind before its notice shows
  const GROUP_MAX_MS = 8000; // ...but no longer than this after the first
  const CART_ATTR = "data-cip-cart-buying"; // set by case-cart.js while (and shortly after) it buys
  const PATCHED = Symbol.for("cip-crate-received");

  let getStore = null;
  const seen = new Set(); // inventory item ids already counted, so one case gives one count
  const groups = new Map(); // case name -> { count, itemId, first, timer, bought }

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function findStore() {
    for (const el of document.querySelectorAll("body > div, body > main, #__next")) {
      const containerKey = Object.keys(el).find((k) => k.startsWith("__reactContainer"));
      const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      let root = containerKey ? el[containerKey] : null;
      if (!root && fiberKey) {
        root = el[fiberKey];
        while (root.return) root = root.return;
      }
      if (!root) continue;
      let steps = 0;
      const stack = [root];
      while (stack.length && steps < 60000) {
        const f = stack.pop();
        steps++;
        if (!f) continue;
        for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
          const v = h.memoizedState;
          if (v && typeof v === "object" && "isCrateReceivedVisible" in v && typeof v.hideCrateReceived === "function") {
            return typeof h.queue?.getSnapshot === "function" ? h.queue.getSnapshot : () => v;
          }
        }
        if (f.child) stack.push(f.child);
        if (f.sibling) stack.push(f.sibling);
      }
    }
    return null;
  }

  function storeState() {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!getStore) getStore = findStore();
      if (!getStore) return null;
      try {
        const state = getStore();
        if (state && "isCrateReceivedVisible" in state) return state;
      } catch {
        /* remounted: look it up again */
      }
      getStore = null;
    }
    return null;
  }

  // ---------- the notice ----------

  // Same look as the site's own toasts: dark panel, thin accent edge, brand title, top right.
  function notice(title, detail, href, linkLabel) {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      // Inline, not Tailwind: arbitrary values like top-[72px] only exist in the site's stylesheet if the
      // site itself uses them, and these don't — the corner placement has to be set here.
      host.style.cssText =
        "position:fixed;top:72px;right:16px;z-index:400;display:flex;flex-direction:column;gap:8px;" +
        "width:340px;max-width:92vw;pointer-events:none;";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "flex items-start gap-3 border-l-2 border-l-tertiary px-4 py-3 transition-opacity duration-300";
    // Same reason: the panel's colours are spelled out rather than trusting arbitrary utilities to exist.
    el.style.cssText =
      "pointer-events:auto;background:rgba(13,13,18,0.95);border:1px solid rgba(255,255,255,0.08);" +
      "border-left:2px solid var(--color-tertiary, #fafe38);box-shadow:0 18px 50px rgba(0,0,0,0.5);backdrop-filter:blur(6px);";
    el.innerHTML =
      `<span class="mt-1 h-1.5 w-1.5 shrink-0 bg-tertiary"></span>` +
      `<div class="min-w-0 flex-1">` +
      `<p class="font-brand text-[13px] font-extrabold uppercase italic leading-tight tracking-wide text-white">${escapeHtml(title)}</p>` +
      `${detail ? `<p class="mt-0.5 text-xs text-white/50">${escapeHtml(detail)}</p>` : ""}` +
      `${href ? `<a href="${escapeHtml(href)}" class="mt-1.5 inline-block text-[11px] font-bold uppercase tracking-wider text-tertiary hover:text-white">${escapeHtml(linkLabel)}</a>` : ""}` +
      `</div>`;
    const link = el.querySelector("a");
    if (link) {
      link.addEventListener("click", (e) => {
        const push = window.next?.router?.push;
        if (!push) return; // a plain navigation is fine
        e.preventDefault();
        push(href);
        el.remove();
      });
    }
    host.appendChild(el);
    setTimeout(() => (el.style.opacity = "0"), 5200);
    setTimeout(() => el.remove(), 5600);
  }

  const nameOf = (data) => data?.crateName || data?.name || data?.crate?.name || data?.case?.name || "Case";
  const itemIdOf = (data) => data?.inventoryItemId ?? data?.inventory_item_id ?? data?.inventoryItem?.id ?? data?.crate?.inventory_item_id ?? null;

  function flush(name) {
    const g = groups.get(name);
    if (!g) return;
    groups.delete(name);
    clearTimeout(g.timer);
    const what = g.count > 1 ? `${g.count}× ${name}` : name;
    const title = g.bought ? `Bought ${what}` : `${what} received`;
    // One case opens straight from the notice; several are in the inventory.
    if (g.count === 1 && g.itemId != null) notice(title, "Added to your inventory.", `/inventory/${g.itemId}`, "Open now");
    else notice(title, "Added to your inventory.", "/inventory", "Inventory");
  }

  // A case arrived: count it into the notice for its kind.
  function received(data) {
    const itemId = itemIdOf(data);
    if (itemId != null) {
      if (seen.has(itemId)) return;
      seen.add(itemId);
    }
    const name = nameOf(data);
    let g = groups.get(name);
    if (!g) groups.set(name, (g = { count: 0, itemId, first: Date.now(), timer: 0, bought: false }));
    g.count++;
    g.itemId = itemId;
    g.bought ||= document.documentElement.hasAttribute(CART_ATTR);
    clearTimeout(g.timer);
    g.timer = setTimeout(() => flush(name), Math.max(0, Math.min(GROUP_MS, g.first + GROUP_MAX_MS - Date.now())));
  }

  function update() {
    const state = storeState();
    if (!state) return;
    // Swap the store's showCrateReceived so the dialog never opens.
    if (typeof state.showCrateReceived === "function" && !state.showCrateReceived[PATCHED]) {
      const patched = (data) => received(data);
      patched[PATCHED] = true;
      state.showCrateReceived = patched;
    }
    if (state.isCrateReceivedVisible) {
      const data = state.crateReceivedData;
      state.hideCrateReceived(); // the site's own way to close it, so its overlay stack stays right
      received(data);
    }
  }

  setInterval(update, TICK_MS);
  new MutationObserver(() => update()).observe(document.documentElement, { childList: true, subtree: true });
  update();
})();
