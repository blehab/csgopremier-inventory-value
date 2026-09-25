// Shows how much lower (or higher) the "Sell to Market" quote is than the item's
// listed price, as a small badge inside the inventory context menu.
//
// Right-clicking a card makes the site POST /api/market/quote {operation:"sell", id}
// and render the returned amount_pp in the menu. We read both the card price and
// the rendered quote from the DOM, so no extra requests are made.
(() => {
  const PRICE_CLASS = "text-xs font-semibold tabular-nums text-white/75";
  const MENU_SELECTOR = "body > div.fixed.z-\\[9999\\]";
  const BADGE_CLASS = "cip-sell-diff";
  // lucide "triangle-alert", the icon set the site uses
  const WARN_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="shrink-0">` +
    `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`;

  let cardPrice = null; // price of the card the menu was last opened for

  const parsePP = (text) => {
    const n = parseInt((text || "").replace(/[^\d]/g, ""), 10);
    return isNaN(n) ? null : n;
  };

  function rememberCard(e) {
    const card = e.target instanceof Element && e.target.closest("div.grid.grid-cols-2 > article");
    if (!card) return;
    cardPrice = parsePP(card.getElementsByClassName(PRICE_CLASS)[0]?.textContent);
  }
  // Capture phase so we run before the site's handlers open the menu.
  document.addEventListener("contextmenu", rememberCard, true);
  document.addEventListener("click", rememberCard, true);

  function update() {
    const menu = document.querySelector(MENU_SELECTOR);
    if (!menu) return;
    const row = [...menu.querySelectorAll("button")].find((b) => /Sell to Market/.test(b.textContent));
    if (!row) return;

    // The price span holds "Loading…" while the quote request is in flight, then either
    // "28,280<span>PP</span>" or "Unavailable" when the item can't be sold to the market.
    const priceEl = row.querySelector(`span.tabular-nums:not(.${BADGE_CLASS})`);
    const priceText = priceEl?.textContent.trim() || "";
    const quote = parsePP(priceEl?.firstChild?.textContent);
    let badge = row.querySelector(`.${BADGE_CLASS}`);

    if (!priceEl || !cardPrice || /loading/i.test(priceText) || !priceText) {
      badge?.remove();
      return;
    }

    let tone, html, title;
    if (quote === null) {
      tone = "yellow-400";
      html = `${WARN_ICON}N/A`;
      title = `Can't be sold to the market right now (card price ${cardPrice.toLocaleString("en-US")} PP)`;
    } else {
      const pct = Math.round(((quote - cardPrice) / cardPrice) * 1000) / 10;
      tone = pct < 0 ? "primary" : pct > 0 ? "green-400" : "blue-400";
      html = `${pct < 0 ? "−" : pct > 0 ? "+" : ""}${Math.abs(pct).toFixed(1)}%`;
      title = `Card price ${cardPrice.toLocaleString("en-US")} PP → market ${quote.toLocaleString("en-US")} PP`;
    }

    if (!badge) {
      badge = document.createElement("span");
      // Goes in front of the price inside the price column. The price's fixed 100px
      // width is dropped so the "Sell to Market" label keeps enough room not to truncate
      // (the price stays right-aligned, so it still lines up with the other rows).
      const wrap = priceEl.parentElement;
      Object.assign(wrap.style, { display: "flex", alignItems: "center", gap: "6px" });
      priceEl.style.width = "auto";
      wrap.prepend(badge);
    }
    const cls = `${BADGE_CLASS} inline-flex shrink-0 items-center gap-0.5 border px-1 text-[10px] font-bold leading-4 ` +
      `tabular-nums border-${tone}/30 bg-${tone}/10 text-${tone}`;
    if (badge.className !== cls) badge.className = cls;
    // Compare against a stored copy: the browser normalises the SVG when it serialises innerHTML.
    if (badge.dataset.html !== html) {
      badge.innerHTML = html;
      badge.dataset.html = html;
    }
    badge.title = title;
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
