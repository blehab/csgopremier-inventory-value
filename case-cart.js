// A cart for the case shop (/armory/cases), so several cases and capsules can be bought in one go instead
// of one "Buy" dialog at a time.
//
// Every tile that's in stock gets a small cart button beside its "Buy" (showing ×N once it's in the cart);
// each click adds one, up to what the dialog would allow (the stock left, at most 50). A "Max" button next
// to it fills the cart with as many as that allows and the wallet covers, as does "Max" on a cart line.
// The cart itself is a panel in the bottom-right corner: one line per item with − / + / Max and a quantity
// box, the line price, the total, and the wallet, the cart's total taken off it and what's left. It
// collapses to a small bar and is remembered in localStorage. The cart never holds more than the wallet
// covers: adding past that (from a tile, "+" or the quantity box) is refused with a "Not enough PP" notice
// above the panel, until something is removed.
//
// "Buy all" asks for a second click ("Confirm"), then buys line by line with the dialog's own requests:
//   GET /api/shop/cases/<id> (or /sticker-packs/<id>) for the current price and stock, then
//   POST /api/shop/cases/buy/<id> { quantity, expected_price_pp } (or /sticker-packs/buy/<id> { quantity }).
// A line whose price went up or whose stock went down since the cart showed it is skipped (and updated),
// so nothing costs more than the total that was confirmed. Cases need Premium Pro, as in the dialog.
// Bought lines leave the cart; the rest stay with their error, and a line says what was bought. When
// everything went through, that line goes away after a few seconds (and with it the emptied panel); it's
// also dropped on leaving the shop, so coming back doesn't show an old purchase. The page's data is
// refreshed afterwards, the same queries the dialog refreshes. While it buys (and a little after, for the
// socket's late events) the page carries data-cip-cart-buying, so crate-received.js words its grouped
// notices "Bought 5× …" instead of popping a dialog per case.
//
// Prices, names and images come from the page's React Query data (["case-shop"] / ["sticker-pack-shop"]),
// the same data the tiles are drawn from; see case-shop.js. Runs in the page's MAIN world for that.
(() => {
  const PANEL_ID = "cip-case-cart";
  const ADD_CLASS = "cip-cart-add";
  const MAX_CLASS = "cip-cart-max";
  const BUYING_ATTR = "data-cip-cart-buying";
  const BUYING_LINGER_MS = 10000;
  const HOST_ATTR = "data-cip-cart-host";
  const STORAGE_KEY = "cip-case-cart";
  const CASES_PATH = "/armory/cases";
  const MAX_PER_BUY = 50; // the dialog's own cap
  const CONFIRM_MS = 4000;
  // Cases Auto-fill ("Max" across the shop) never reaches for on its own — still addable by hand from their
  // tiles. Matched by name, case-insensitively and trimmed.
  const AUTOFILL_IGNORE = new Set(["music kit box", "agent case", "the dragon case"]);
  const autoFillIgnored = (name) => AUTOFILL_IGNORE.has(String(name ?? "").trim().toLowerCase());

  const KINDS = {
    case: { query: "case-shop", list: "cases", detail: (id) => `/api/shop/cases/${id}`, buy: (id) => `/api/shop/cases/buy/${id}` },
    pack: {
      query: "sticker-pack-shop",
      list: "packs",
      detail: (id) => `/api/shop/sticker-packs/${id}`,
      buy: (id) => `/api/shop/sticker-packs/buy/${id}`,
    },
  };
  const REFRESH = ["case-shop", "sticker-pack-shop", "case-detail", "sticker-pack-detail", "pp-balance", "inventory"];

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  const pp = (n) => `${num(n)} <span class="font-bold italic text-secondary">PP</span>`;

  // lucide "shopping-cart" and "plus", like the site's own Buy button icon
  const CART_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round" class="h-4 w-4 shrink-0" aria-hidden="true"><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/>` +
    `<path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/></svg>`;
  const PLUS_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" ` +
    `stroke-linejoin="round" class="h-3 w-3 shrink-0" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`;

  // ---------- state ----------

  // lines: [{ kind: "case" | "pack", id, qty, name, error? }], name kept for items that leave the shop
  let lines = [];
  let open = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved?.lines)) lines = saved.lines.filter((l) => KINDS[l.kind] && l.id && l.qty > 0).map((l) => ({ ...l, error: "" }));
    if (typeof saved?.open === "boolean") open = saved.open;
  } catch {}

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, lines: lines.map(({ kind, id, qty, name }) => ({ kind, id, qty, name })) }));
    } catch {}
  }

  let busy = false; // buying
  let confirmUntil = 0;
  let confirmTimer = 0;
  let status = null; // { ok, text } after a checkout
  let statusTimer = 0;
  let buyingTimer = 0;
  const STATUS_MS = 6000;

  // Any change to the cart must void an armed "Buy all" confirmation, so the second click always confirms
  // the cart as it is now — never a quantity or a set of lines that changed after the first click.
  function resetConfirm() {
    confirmUntil = 0;
    clearTimeout(confirmTimer);
  }

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

  // The shop's entry for an item, with the price you pay (the Pro price on a Pro account).
  function shopEntry(client, kind, id) {
    const k = KINDS[kind];
    const data = client?.getQueryData([k.query]);
    const entry = data?.[k.list]?.find((x) => x.id === id);
    if (!entry) return null;
    const price = data.is_pro ? (entry.pro_price_pp ?? entry.price_pp) : entry.price_pp;
    return { entry, price: price ?? 0, isPro: !!data.is_pro, max: maxFor(entry) };
  }

  const maxFor = (entry) => (entry.stock_remaining == null ? MAX_PER_BUY : Math.max(0, Math.min(MAX_PER_BUY, entry.stock_remaining)));

  function wallet(client) {
    const cases = client?.getQueryData(["case-shop"]);
    const balance = client?.getQueryData(["pp-balance"]);
    return {
      // ["pp-balance"] is what the top bar shows, and it's refetched every minute; the shop's copy is older.
      balance: balance?.balance ?? cases?.pp_balance ?? null,
      frozen: !!cases?.pp_frozen,
      isPro: !!cases?.is_pro,
    };
  }

  // ---------- requests ----------

  // A request the way the site's API client sends it (CSRF header from the cookie), as in multi-open.js.
  async function api(path, body) {
    const csrf = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/)?.[1];
    const res = await fetch(
      path,
      body === undefined
        ? { credentials: "include" }
        : {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}) },
            body: JSON.stringify(body),
          }
    );
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new Error(data?.error || data?.message || text.trim() || `HTTP ${res.status}`);
    return data;
  }

  // ---------- adding ----------

  // PP left once the rest of the cart (every line but `except`) is paid for; null if the balance isn't known.
  function spareFor(client, except) {
    const { balance } = wallet(client);
    if (balance == null) return null;
    let used = 0;
    for (const l of lines) {
      const shop = l === except ? null : shopEntry(client, l.kind, l.id);
      if (shop) used += shop.price * l.qty;
    }
    return balance - used;
  }

  // A notice above the cart panel, gone after a few seconds.
  const TOAST_ID = "cip-case-cart-toast";
  const TOAST_MS = 4500;
  let toastTimer = 0;
  function notify(title, text) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = TOAST_ID;
      toast.setAttribute("role", "alert");
      toast.className = "border border-primary/50 px-3 py-2 text-xs leading-snug shadow-2xl";
      toast.addEventListener("click", () => toast.remove());
      document.body.appendChild(toast);
    }
    const panelEl = document.getElementById(PANEL_ID);
    toast.style.cssText =
      `position:fixed;right:16px;bottom:${panelEl ? panelEl.offsetHeight + 24 : 16}px;z-index:41;cursor:pointer;` +
      "width:min(400px,calc(100vw - 32px));background:rgba(28,10,16,0.97);backdrop-filter:blur(6px)";
    toast.innerHTML = `<div class="font-bold uppercase tracking-wider text-primary">${escapeHtml(title)}</div><div class="mt-0.5 text-white/75">${escapeHtml(text)}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), TOAST_MS);
  }

  function notEnough(name, price, spare) {
    notify(
      "Not enough PP",
      `${name} costs ${num(price)} PP, and after the cart you'd have ${num(Math.max(0, spare))} PP left. Remove something from the cart to add more.`
    );
  }

  // One more of an item, or with `all` as many as can be bought (the stock/50 cap, then the wallet).
  function add(kind, id, all) {
    if (busy) return; // a checkout is running: don't let a tile change a purchase that's already in flight
    const client = findQueryClient();
    const shop = shopEntry(client, kind, id);
    if (!shop || shop.max < 1) return;
    let line = lines.find((l) => l.kind === kind && l.id === id);
    const spare = spareFor(client, line);
    const have = line?.qty || 0;
    let want = all ? shop.max : Math.min(shop.max, have + 1);
    if (spare != null && shop.price > 0 && shop.price * want > spare) {
      const fits = Math.max(have, Math.floor(spare / shop.price));
      if (fits <= have) {
        if (have < shop.max) notEnough(shop.entry.name, shop.price, spare - shop.price * have);
        return;
      }
      want = fits;
    }
    if (!line) lines.push((line = { kind, id, qty: 0, name: shop.entry.name, error: "" }));
    line.qty = want;
    line.error = "";
    status = null;
    open = true;
    resetConfirm(); // the cart changed: a pending "Buy all" confirmation no longer matches it
    save();
    render();
  }

  // Fill the cart from the cheapest in-stock case upward, keeping whatever's already in the cart (its cost is
  // spent first). Takes as many of the cheapest case as the balance and its stock allow, then moves to the
  // next cheapest, and so on — so the cart favours cheap cases and only reaches dearer ones once the cheaper
  // ones are maxed out or unaffordable. The leftover ends under the price of the cheapest case still in stock.
  // Packs are left alone, and the cart's "never past the wallet" rule holds (it only spends `spare`).
  function autoFill() {
    if (busy) return;
    const client = findQueryClient();
    const w = wallet(client);
    if (w.balance == null) return notify("Auto-fill", "The balance isn't known right now — try again in a moment.");
    if (w.frozen) return notify("Auto-fill", "The wallet is frozen, so nothing can be bought.");
    if (!w.isPro) return notify("Auto-fill", "Buying cases needs Premium Pro.");

    // PP left to spend once the current cart is paid for.
    let spare = w.balance;
    for (const l of lines) {
      const shop = shopEntry(client, l.kind, l.id);
      if (shop) spare -= shop.price * l.qty;
    }
    if (spare <= 0) return notify("Auto-fill", "The cart already uses up the balance — remove something to add more.");

    // Every buyable case with room left (stock/50 cap, minus what's already in the cart).
    const cases = client?.getQueryData([KINDS.case.query])?.[KINDS.case.list] || [];
    const cand = [];
    for (const entry of cases) {
      const shop = shopEntry(client, "case", entry.id);
      if (!shop || shop.price <= 0 || shop.max < 1) continue;
      if (autoFillIgnored(shop.entry.name)) continue;
      const have = lines.find((l) => l.kind === "case" && l.id === entry.id)?.qty || 0;
      const room = shop.max - have;
      if (room > 0) cand.push({ id: entry.id, name: shop.entry.name, price: shop.price, room, add: 0 });
    }
    if (!cand.length) return notify("Auto-fill", "No cases are in stock to add right now.");

    const minPrice = Math.min(...cand.map((c) => c.price));
    if (minPrice > spare)
      return notify("Auto-fill", `The cheapest case is ${num(minPrice)} PP, more than the ${num(spare)} PP left after the cart.`);

    // Cheapest first: take as many of the cheapest case as fit (up to its stock), then move up to dearer
    // cases only once a cheaper one is maxed out or the balance can't afford another of it.
    cand.sort((a, b) => a.price - b.price);
    let left = spare;
    for (const c of cand) {
      const n = Math.min(c.room, Math.floor(left / c.price));
      c.add = n;
      left -= n * c.price;
    }

    const chosen = cand.filter((c) => c.add > 0);
    const total = chosen.reduce((t, c) => t + c.add, 0);
    if (!total) return notify("Auto-fill", `The cheapest case is ${num(minPrice)} PP, more than the ${num(spare)} PP left after the cart.`);

    for (const c of chosen) {
      let line = lines.find((l) => l.kind === "case" && l.id === c.id);
      if (!line) lines.push((line = { kind: "case", id: c.id, qty: 0, name: c.name, error: "" }));
      line.qty += c.add;
      line.error = "";
    }
    status = null;
    open = true;
    resetConfirm(); // the cart changed: a pending "Buy all" confirmation no longer matches it
    save();
    render();

    const allMaxed = cand.every((c) => c.add === c.room);
    // The dearest case we couldn't fit another of is the cheapest one still in stock (cheapest-first means
    // anything cheaper is already maxed), so the leftover is under its price.
    const stillInStock = cand.filter((c) => c.add < c.room).map((c) => c.price);
    const tail =
      left <= 0
        ? " The balance is fully spent."
        : allMaxed
        ? ` ${num(left)} PP is left — that's every case in stock, the cart can't spend more.`
        : ` ${num(left)} PP left, under the ${num(Math.min(...stillInStock))} PP cheapest case still in stock.`;
    notify("Auto-filled", `Added ${num(total)} ${total === 1 ? "case" : "cases"} across ${chosen.length} ${chosen.length === 1 ? "type" : "types"}.${tail}`);
  }

  const idOf = (card) => {
    const href = card.querySelector('a[href*="/armory/"]')?.getAttribute("href") || "";
    const m = href.match(/\/armory\/(crates|sticker-packs)\/([^/?#]+)/);
    return m ? { kind: m[1] === "crates" ? "case" : "pack", id: decodeURIComponent(m[2]) } : null;
  };

  // The tile's "N left" stock line, so it counts down as the cart reserves stock. The site renders "{n} left"
  // as two text nodes (the number, then " left"); we rewrite only the number. React's own re-renders put the
  // real number back, and the render loop re-adjusts it, the same way the cart button is kept in sync.
  function setLeft(card, n) {
    const text = String(n);
    for (const span of card.querySelectorAll("span")) {
      const kids = span.childNodes;
      for (let i = 1; i < kids.length; i++) {
        if (
          kids[i].nodeType === 3 &&
          /^\s*left\s*$/i.test(kids[i].textContent) &&
          kids[i - 1].nodeType === 3 &&
          /\d/.test(kids[i - 1].textContent)
        ) {
          if (kids[i - 1].textContent.trim() !== text) kids[i - 1].textContent = text;
          return;
        }
      }
      // "{n} left" as a single text node
      if (kids.length === 1 && kids[0].nodeType === 3) {
        const m = kids[0].textContent.match(/^(\s*)([\d,]+)(\s+left\s*)$/i);
        if (m) {
          const next = `${m[1]}${text}${m[3]}`;
          if (kids[0].textContent !== next) kids[0].textContent = next;
          return;
        }
      }
    }
  }

  // The cart button goes beside the tile's own "Buy": its parent becomes a two-column grid (the price row
  // spans both), marked with an attribute that React leaves alone.
  function decorateCards(client) {
    for (const card of document.querySelectorAll("article")) {
      const item = idOf(card);
      if (!item) continue;
      const buy = [...card.querySelectorAll("button")].find((b) => !b.classList.contains(ADD_CLASS) && !b.classList.contains(MAX_CLASS) && /buy|sold out/i.test(b.textContent));
      if (!buy) continue;
      const host = buy.parentElement;
      let btn = host.querySelector(`:scope > .${ADD_CLASS}`);
      let maxBtn = host.querySelector(`:scope > .${MAX_CLASS}`);
      const shop = shopEntry(client, item.kind, item.id);
      const inCart = lines.find((l) => l.kind === item.kind && l.id === item.id)?.qty || 0;
      // Count the tile's "N left" down by what's reserved in the cart (only cases with a stock limit show it).
      if (shop && shop.entry.stock_remaining != null) setLeft(card, Math.max(0, shop.entry.stock_remaining - inCart));
      const can = !busy && !!shop && shop.max > 0 && inCart < shop.max && !buy.disabled;
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        // The Buy button's own look, minus its full width and padding.
        const drop = ["w-full", "min-w-[80px]", "px-4"];
        btn.className = [ADD_CLASS, ...buy.className.split(/\s+/).filter((c) => !drop.includes(c)), "px-2.5"].join(" ");
        btn.dataset.kind = item.kind;
        btn.dataset.id = item.id;
        host.setAttribute(HOST_ATTR, "");
        buy.insertAdjacentElement("afterend", btn);
      }
      if (!maxBtn) {
        maxBtn = btn.cloneNode(false);
        maxBtn.classList.replace(ADD_CLASS, MAX_CLASS);
        maxBtn.textContent = "Max";
        btn.insertAdjacentElement("afterend", maxBtn);
      }
      const html = inCart ? `${CART_ICON}<span class="tabular-nums">×${inCart}</span>` : `${PLUS_ICON}${CART_ICON}`;
      if (btn.innerHTML !== html) btn.innerHTML = html;
      if (btn.disabled !== !can) btn.disabled = !can;
      if (btn.hidden !== (!shop || shop.max < 1)) btn.hidden = !shop || shop.max < 1; // sold out: Buy keeps the full width
      const title = !shop || shop.max < 1 ? "Sold out" : inCart >= shop.max ? `All ${shop.max} you can buy are in the cart` : `Add one to the cart`;
      if (btn.title !== title) btn.title = title;
      btn.setAttribute("aria-label", `${title}: ${shop?.entry.name || ""}`);
      if (maxBtn.disabled !== !can) maxBtn.disabled = !can;
      if (maxBtn.hidden !== btn.hidden) maxBtn.hidden = btn.hidden;
      const maxTitle = can ? `Add as many as you can buy (up to ${shop.max}) to the cart` : title;
      if (maxBtn.title !== maxTitle) maxBtn.title = maxTitle;
      maxBtn.setAttribute("aria-label", `${maxTitle}: ${shop?.entry.name || ""}`);
    }
  }

  // ---------- the panel ----------

  function lineHtml(client, line, i) {
    const shop = shopEntry(client, line.kind, line.id);
    const name = shop?.entry.name || line.name || line.id;
    const img = shop?.entry.image;
    const max = shop ? shop.max : 0;
    const gone = !shop ? "No longer in the shop" : max < 1 ? "Sold out" : "";
    const err = line.error || gone;
    return `
      <div class="flex items-center gap-2 border-t border-white/[0.06] px-3 py-2" data-line="${i}">
        ${
          img
            ? `<img src="${escapeHtml(img)}" alt="" class="h-9 w-12 shrink-0 object-contain">`
            : `<span class="h-9 w-12 shrink-0 bg-white/[0.04]"></span>`
        }
        <div class="min-w-0 flex-1">
          <div class="truncate text-xs font-semibold text-white/85" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
          <div class="mt-0.5 font-mono text-[10px] tabular-nums text-white/40">${shop ? `${num(shop.price)} each · ${max} left` : "–"}</div>
          ${err ? `<div class="mt-0.5 text-[10px] leading-snug text-primary">${escapeHtml(err)}</div>` : ""}
        </div>
        <div class="flex shrink-0 items-center border border-white/10">
          <button type="button" data-act="dec" class="px-1.5 py-0.5 text-white/50 hover:text-white disabled:opacity-30" ${busy ? "disabled" : ""} aria-label="One less">−</button>
          <input type="text" inputmode="numeric" data-act="qty" value="${line.qty}" ${busy ? "disabled" : ""} aria-label="Quantity"
                 class="w-8 bg-transparent text-center font-mono text-xs tabular-nums text-white outline-none">
          <button type="button" data-act="inc" class="px-1.5 py-0.5 text-white/50 hover:text-white disabled:opacity-30" ${busy || line.qty >= max ? "disabled" : ""} aria-label="One more">+</button>
          <button type="button" data-act="max" class="border-l border-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/50 hover:text-white disabled:opacity-30" ${busy || line.qty >= max ? "disabled" : ""} title="As many as you can buy" aria-label="As many as you can buy">Max</button>
        </div>
        <div class="w-[72px] shrink-0 text-right text-xs font-bold tabular-nums text-white">${shop ? pp(shop.price * line.qty) : "–"}</div>
        <button type="button" data-act="remove" class="shrink-0 px-1 text-white/30 hover:text-primary disabled:opacity-30" ${busy ? "disabled" : ""} title="Remove" aria-label="Remove">✕</button>
      </div>`;
  }

  // What "Buy all" would spend, and why it can't, if it can't.
  function summary(client) {
    const w = wallet(client);
    let total = 0;
    let count = 0;
    let problem = "";
    for (const line of lines) {
      const shop = shopEntry(client, line.kind, line.id);
      if (!shop) problem ||= "Remove the items that are no longer in the shop";
      else if (shop.max < 1) problem ||= `Remove ${shop.entry.name}: sold out`;
      else if (line.qty > shop.max) problem ||= `Only ${shop.max} ${shop.entry.name} left`;
      else if (line.kind === "case" && !shop.isPro) problem ||= "Buying cases needs Premium Pro";
      else {
        total += shop.price * line.qty;
        count += line.qty;
      }
    }
    if (!problem && w.frozen) problem = "Wallet frozen";
    if (!problem && w.balance != null && total > w.balance) problem = "Not enough PP";
    return { total, count, balance: w.balance, problem };
  }

  const BUTTON = "inline-flex items-center justify-center gap-2 whitespace-nowrap border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40";
  const PRIMARY = `${BUTTON} border-secondary/40 bg-secondary/15 text-secondary hover:bg-secondary/25`;
  const CONFIRM = `${BUTTON} border-primary/60 bg-primary/20 text-primary hover:bg-primary/30`;
  const GHOST = `${BUTTON} border-white/10 bg-white/[0.03] text-white/50 hover:text-white`;

  function panelHtml(client) {
    const s = summary(client);
    const count = lines.reduce((t, l) => t + l.qty, 0);
    const head = `
      <button type="button" data-act="toggle" class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left" title="${open ? "Collapse" : "Expand"} the cart">
        <span class="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-white/80">${CART_ICON}Cart
          <span class="font-mono text-[10px] font-normal normal-case tracking-normal text-white/40">${count} ${count === 1 ? "item" : "items"}</span></span>
        <span class="flex items-center gap-2 text-xs font-bold tabular-nums text-white">${pp(s.total)}<span class="text-white/40">${open ? "▾" : "▴"}</span></span>
      </button>`;
    if (!open) return head;
    const confirming = Date.now() < confirmUntil;
    const buyLabel = busy ? "Buying…" : s.problem || (confirming ? `Confirm · ${num(s.total)} PP` : `Buy all · ${num(s.total)} PP`);
    const hasLines = lines.length > 0;
    const autoTitle = "Add cases until the balance is as close to 0 as possible";
    return `
      ${head}
      ${hasLines ? `<div data-cip-scroll class="max-h-[50vh] overflow-y-auto">${lines.map((l, i) => lineHtml(client, l, i)).join("")}</div>` : ""}
      ${
        s.balance != null || status
          ? `<div class="space-y-1 border-t border-white/10 px-3 py-2 text-xs">
        ${
          s.balance != null
            ? `<div class="flex justify-between text-white/50"><span>Wallet</span><span class="tabular-nums text-white/80">${pp(s.balance)}</span></div>
               <div class="flex justify-between text-white/50"><span>Cart</span><span class="tabular-nums text-primary">− ${pp(s.total)}</span></div>
               <div class="flex justify-between text-white/50"><span>After buying</span><span class="tabular-nums text-white/80">${pp(Math.max(0, s.balance - s.total))}</span></div>`
            : ""
        }
        ${status ? `<p class="pt-1 text-[11px] leading-snug ${status.ok ? "text-secondary" : "text-primary"}" role="status">${escapeHtml(status.text)}</p>` : ""}
      </div>`
          : ""
      }
      <div class="flex gap-2 border-t border-white/10 px-3 py-2">
        <button type="button" data-act="autofill" class="${GHOST} ${hasLines ? "" : "flex-1"}" ${busy ? "disabled" : ""} title="${autoTitle}" aria-label="${autoTitle}">Auto-fill</button>
        ${
          hasLines
            ? `<button type="button" data-act="clear" class="${GHOST}" ${busy ? "disabled" : ""}>Clear</button>
        <button type="button" data-act="buy" class="${confirming ? CONFIRM : PRIMARY} flex-1" ${busy || s.problem || !s.count ? "disabled" : ""}
                title="${confirming ? "Click again to buy everything in the cart" : "Buy everything in the cart"}">${escapeHtml(buyLabel)}</button>`
            : ""
        }
      </div>`;
  }

  function panel() {
    let el = document.getElementById(PANEL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = PANEL_ID;
      el.className = "border border-white/10 shadow-2xl";
      // Placement inline: the site's CSS only has the utility classes it uses itself.
      el.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:40;width:min(400px,calc(100vw - 32px));" +
        "background:rgba(12,12,16,0.97);backdrop-filter:blur(6px);border-top:2px solid var(--color-secondary, #22d3ee)";
      el.addEventListener("click", onPanelClick);
      el.addEventListener("change", onQtyChange);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && e.target.matches('input[data-act="qty"]')) e.target.blur();
      });
      document.body.appendChild(el);
    }
    return el;
  }

  function render() {
    if (!onCasesPage()) document.getElementById(TOAST_ID)?.remove();
    if (!onCasesPage() && status && !busy) {
      status = null; // left the shop: the last purchase's message is done with
      clearTimeout(statusTimer);
    }
    const show = onCasesPage(); // always up on the shop so Auto-fill has a home, even with an empty cart
    const existing = document.getElementById(PANEL_ID);
    if (!show) {
      existing?.remove();
    } else {
      const el = panel();
      // Don't redraw under an input being typed in.
      if (!el.contains(document.activeElement) || document.activeElement.tagName !== "INPUT") {
        const html = panelHtml(findQueryClient());
        if (el.cipHtml !== html) {
          // Replacing innerHTML drops the lines list's scroll position; keep it where it was so
          // removing/changing a line doesn't jump the cart back to the top.
          const scrollTop = el.querySelector("[data-cip-scroll]")?.scrollTop ?? 0;
          el.innerHTML = html;
          el.cipHtml = html;
          const list = el.querySelector("[data-cip-scroll]");
          if (list && scrollTop) list.scrollTop = scrollTop;
        }
      }
    }
    decorateCards(findQueryClient());
  }

  function setQty(i, qty) {
    if (busy) return; // don't let − / + / Max / the quantity box change a purchase that's in flight
    const line = lines[i];
    if (!line) return;
    const client = findQueryClient();
    const shop = shopEntry(client, line.kind, line.id);
    const max = shop ? shop.max : line.qty;
    qty = Math.floor(Number(qty));
    if (!Number.isFinite(qty)) qty = line.qty;
    const spare = spareFor(client, line);
    if (shop && spare != null && qty > line.qty && qty * shop.price > spare) {
      // Raise it only as far as the wallet goes (never below where it was).
      const fits = Math.max(line.qty, Math.floor(spare / shop.price));
      notEnough(shop.entry.name, shop.price, spare - shop.price * fits);
      qty = fits;
    }
    if (qty < 1) lines.splice(i, 1);
    else line.qty = Math.min(qty, Math.max(1, max));
    if (lines[i] === line) line.error = "";
    status = null;
    resetConfirm();
    save();
    render();
  }

  function onQtyChange(e) {
    const input = e.target.closest('input[data-act="qty"]');
    if (!input) return;
    const i = Number(input.closest("[data-line]").dataset.line);
    input.blur();
    panel().cipHtml = ""; // redraw even if the quantity ends up unchanged, so the box shows it again
    setQty(i, input.value);
  }

  function onPanelClick(e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled || btn.tagName === "INPUT") return;
    const act = btn.dataset.act;
    const i = Number(btn.closest("[data-line]")?.dataset.line);
    if (act === "toggle") {
      open = !open;
      save();
    } else if (act === "inc") setQty(i, lines[i].qty + 1);
    else if (act === "dec") setQty(i, lines[i].qty - 1);
    else if (act === "max") {
      const line = lines[i];
      add(line.kind, line.id, true);
      return;
    }
    else if (act === "remove") setQty(i, 0);
    else if (act === "autofill") {
      autoFill();
      return;
    } else if (act === "clear") {
      lines = [];
      status = null;
      resetConfirm();
      save();
    } else if (act === "buy") {
      if (Date.now() < confirmUntil) {
        confirmUntil = 0;
        clearTimeout(confirmTimer);
        checkout();
      } else {
        confirmUntil = Date.now() + CONFIRM_MS;
        clearTimeout(confirmTimer);
        confirmTimer = setTimeout(render, CONFIRM_MS + 50);
      }
    }
    render();
  }

  // ---------- checkout ----------

  async function checkout() {
    const client = findQueryClient();
    // Snapshot each line's price AND quantity as confirmed. The buy uses this snapshot, not the live line,
    // so nothing bought differs from what the confirmed total covered even if something changed mid-checkout.
    const confirmed = new Map(lines.map((l) => [l, { price: shopEntry(client, l.kind, l.id)?.price, qty: l.qty }]));
    busy = true;
    status = null;
    clearTimeout(buyingTimer);
    document.documentElement.setAttribute(BUYING_ATTR, "");
    render();
    const bought = [];
    const failed = [];
    for (const line of [...lines]) {
      const k = KINDS[line.kind];
      const snap = confirmed.get(line) || { price: undefined, qty: line.qty };
      const want = snap.qty; // buy exactly what was confirmed, not whatever the live line says now
      try {
        const d = await api(k.detail(encodeURIComponent(line.id)));
        // Mirror shopEntry's Pro-price fallback: a Pro account pays pro_price_pp, or price_pp if it's unset.
        const price = (d?.is_pro ? (d.pro_price_pp ?? d.price_pp) : d?.price_pp) ?? 0;
        // stock_remaining == null means unlimited (as the shop tiles treat it), not sold out.
        const stock = d?.stock_remaining == null ? Infinity : d.stock_remaining;
        const name = (d?.crate || d?.pack)?.name || line.name;
        if (line.kind === "case" && !d?.is_pro) throw new Error("Buying cases needs Premium Pro");
        if (d?.pack && d.can_purchase === false) throw new Error("Can't be bought right now");
        if (d?.pp_frozen) throw new Error("Wallet frozen");
        if (stock < want) {
          if (stock > 0) line.qty = Math.min(stock, MAX_PER_BUY);
          throw new Error(stock > 0 ? `Only ${stock} left, so the quantity was lowered: check and buy again` : "Sold out");
        }
        if (!(price > 0)) throw new Error("No price");
        const before = snap.price;
        if (before != null && price > before) throw new Error(`Price went up to ${num(price)} PP each: check and buy again`);
        const body = line.kind === "case" ? { quantity: want, expected_price_pp: price } : { quantity: want };
        const res = await api(k.buy(encodeURIComponent(line.id)), body);
        const got = res?.quantity ?? want;
        bought.push(`${got}× ${name}`);
        line.qty -= got;
        if (line.qty <= 0) lines = lines.filter((l) => l !== line);
      } catch (e) {
        line.error = e.message || String(e);
        failed.push(line);
      }
      save();
      render();
    }
    busy = false;
    buyingTimer = setTimeout(() => document.documentElement.removeAttribute(BUYING_ATTR), BUYING_LINGER_MS);
    status = bought.length
      ? { ok: !failed.length, text: `Bought ${bought.join(", ")}.${failed.length ? ` ${failed.length} ${failed.length === 1 ? "line" : "lines"} not bought, see above.` : ""}` }
      : { ok: false, text: "Nothing was bought, see above." };
    save();
    render();
    clearTimeout(statusTimer);
    if (!failed.length) {
      statusTimer = setTimeout(() => {
        status = null;
        render();
      }, STATUS_MS);
    }
    // The same refresh as the site's dialog, so the wallet, stock and inventory show the purchase.
    await Promise.all(REFRESH.map((key) => client?.invalidateQueries({ queryKey: [key] })));
    render();
  }

  // ---------- wiring ----------

  const style = document.createElement("style");
  style.textContent = `
    [${HOST_ATTR}] { display: grid !important; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 6px; }
    [${HOST_ATTR}]:has(> .${ADD_CLASS}[hidden]) { grid-template-columns: minmax(0, 1fr); }
    [${HOST_ATTR}] > :first-child { grid-column: 1 / -1; }
    [${HOST_ATTR}] > button { margin: 0 !important; }
    [${HOST_ATTR}] > button[hidden] { display: none !important; }
    #${PANEL_ID} input[data-act="qty"]:focus { background: rgba(255,255,255,0.06); }`;
  document.head.appendChild(style);

  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest(`.${ADD_CLASS}, .${MAX_CLASS}`);
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      if (!btn.disabled) add(btn.dataset.kind, btn.dataset.id, btn.classList.contains(MAX_CLASS));
    },
    true
  );

  let scheduled = false;
  new MutationObserver((records) => {
    if (scheduled || records.every((r) => r.target.closest?.(`#${PANEL_ID}`))) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (onCasesPage() || document.getElementById(PANEL_ID)) render();
    }, 80);
  }).observe(document.documentElement, { childList: true, subtree: true });

  render();
})();
