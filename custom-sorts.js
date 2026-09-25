// Adds extra options to the inventory's sort dropdown (after Rarity / Newest / Name / Item type):
//   Price: the price shown on the card, and what the inventory opens on;
//   Float: the item's float (wear) value.
// The site's direction button applies: descending = highest first, ascending = lowest first.
// Items without a value (no price shown, or no float: stickers, cases…) always come last.
//
// The dropdown is a Radix Select bound to the site's zustand inventory store
// ({ items, sortBy, sortDirection, setItems, setSortBy, filteredItems, ... }).
// filteredItems() sorts with a switch over sortBy; an unknown value compares every pair as equal,
// so with sortBy = "price" or "float" the grid simply shows `items` in store order. We therefore set
// sortBy through the Select's own onValueChange and keep `items` in our order (re-sorting when the
// direction button is toggled or the inventory is reloaded).
//
// Runs in the page's MAIN world, because the store and Radix handlers are only reachable
// through React's fiber tree.
(() => {
  // Same rule as the cards: a price is shown when pp_value is set and quick sell is > 0.
  const shownPrice = (i) => (i.pp_value != null && i.quick_sell_percentage > 0 ? i.pp_value : null);
  const SORTS = {
    price: { label: "Price", value: shownPrice },
    float: { label: "Float", value: (i) => (typeof i.float_value === "number" ? i.float_value : null) },
  };
  const SITE_SORTS = ["rarity", "date", "name", "type"];
  const OPTION_CLASS = "cip-custom-sort";
  const TRIGGER_LABEL_CLASS = "cip-custom-sort-label";
  // lucide "check", same as the site's selected-option indicator
  const CHECK_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check h-3 w-3 text-secondary" ` +
    `aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

  let lastSorted = null; // the items array we last put in the store, and the sort + direction it was made for
  let lastKey = null;

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  // Radix's SelectProvider for the inventory sort dropdown: { value, onValueChange, onOpenChange, ... }
  function findSelect() {
    for (const trigger of document.querySelectorAll('button[role="combobox"]')) {
      for (let f = fiberOf(trigger), d = 0; f && d < 30; f = f.return, d++) {
        const p = f.memoizedProps;
        if (p && typeof p.onValueChange === "function" && typeof p.onOpenChange === "function") {
          if (SITE_SORTS.includes(p.value) || p.value in SORTS) return { trigger, provider: p };
          break;
        }
      }
    }
    return null;
  }

  // Current store state, read through the useSyncExternalStore hook of a component that
  // subscribes to the whole store (its getSnapshot returns api.getState()).
  function findStore(from) {
    for (let f = fiberOf(from), d = 0; f && d < 80; f = f.return, d++) {
      for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
        const v = h.memoizedState;
        if (v && typeof v.setSortBy === "function" && typeof v.setItems === "function" && Array.isArray(v.items)) {
          return typeof h.queue?.getSnapshot === "function" ? h.queue.getSnapshot() : v;
        }
      }
    }
    return null;
  }

  function sortItems(items, sortKey, direction) {
    const value = SORTS[sortKey].value;
    const sign = direction === "asc" ? 1 : -1;
    return [...items].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va == null || vb == null) return (va == null) - (vb == null); // missing values last, either way
      return sign * (va - vb);
    });
  }

  function select(sortKey) {
    const found = findSelect();
    if (!found) return;
    // Same order Radix uses when one of its own items is picked.
    found.provider.onValueChange(sortKey);
    found.provider.onOpenChange(false);
  }

  function createOption(template, sortKey) {
    const opt = document.createElement("div");
    opt.className = `${template.className} ${OPTION_CLASS}`;
    opt.dataset.sort = sortKey;
    opt.setAttribute("role", "option");
    opt.tabIndex = -1;
    opt.innerHTML =
      `<span class="absolute left-2 flex h-4 w-4 items-center justify-center"></span><span>${SORTS[sortKey].label}</span>`;
    // Radix highlights an item by focusing it on hover; the focus: classes do the styling.
    opt.addEventListener("pointermove", () => {
      if (document.activeElement !== opt) opt.focus({ preventScroll: true });
    });
    opt.addEventListener("pointerleave", () => {
      if (document.activeElement === opt) opt.closest('[role="listbox"]')?.focus({ preventScroll: true });
    });
    opt.addEventListener("click", () => select(sortKey));
    opt.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        select(sortKey);
      }
    });
    return opt;
  }

  function renderOptions(trigger, current) {
    const listbox = document.getElementById(trigger.getAttribute("aria-controls"));
    const template = listbox?.querySelector(`[role="option"]:not(.${OPTION_CLASS})`);
    if (!template) return;

    for (const sortKey of Object.keys(SORTS)) {
      let opt = listbox.querySelector(`.${OPTION_CLASS}[data-sort="${sortKey}"]`);
      if (!opt) {
        opt = createOption(template, sortKey);
        template.parentElement.appendChild(opt);
      }
      const active = sortKey === current;
      const state = active ? "checked" : "unchecked";
      if (opt.dataset.state !== state) {
        opt.dataset.state = state;
        opt.setAttribute("aria-selected", String(active));
        opt.firstElementChild.innerHTML = active ? `<span aria-hidden="true">${CHECK_ICON}</span>` : "";
      }
    }
  }

  // With a value that matches none of its items, Radix leaves the trigger's value span empty,
  // so we show our own label next to it (and hide the site's span meanwhile).
  function renderTrigger(trigger, current) {
    const valueSpan = trigger.querySelector(`:scope > span:not(.${TRIGGER_LABEL_CLASS})`);
    let label = trigger.querySelector(`.${TRIGGER_LABEL_CLASS}`);
    if (current) {
      if (!label) {
        label = document.createElement("span");
        label.className = TRIGGER_LABEL_CLASS;
        label.style.pointerEvents = "none";
        trigger.prepend(label);
      }
      if (label.textContent !== SORTS[current].label) label.textContent = SORTS[current].label;
      if (valueSpan && valueSpan.style.display !== "none") valueSpan.style.display = "none";
    } else {
      label?.remove();
      if (valueSpan && valueSpan.style.display === "none") valueSpan.style.display = "";
    }
  }

  // The site opens the inventory sorted by rarity; Price is the more useful default, so it's picked once
  // per visit. Changing it afterwards sticks until you leave the page and come back.
  let defaulted = false;

  function update() {
    if (!location.pathname.startsWith("/inventory")) {
      defaulted = false;
      return;
    }
    const found = findSelect();
    if (!found) return;
    const store = findStore(found.trigger);
    if (store && !defaulted && store.items.length) {
      defaulted = true;
      if (!(store.sortBy in SORTS)) {
        select("price");
        return; // the store change brings us straight back here
      }
    }
    // The store is read live; the fiber's props can lag a render behind.
    const current = store && store.sortBy in SORTS ? store.sortBy : null;

    renderTrigger(found.trigger, current);
    renderOptions(found.trigger, current);

    const key = current && `${current}|${store.sortDirection}`;
    if (current && (store.items !== lastSorted || key !== lastKey)) {
      lastSorted = sortItems(store.items, current, store.sortDirection);
      lastKey = key;
      store.setItems(lastSorted);
    }
  }

  // setTimeout rather than requestAnimationFrame, so a background tab still keeps up.
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 16);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-label", "data-state"] });

  update();
})();
