// Auto-accept lobby invites: presses "Accept" on the party invite banner as soon as it appears.
//
// When someone invites you to their party the site shows a banner rail at the top of every page
// (PartyInviteBanner, from usePopupStore.partyInviteData) titled "<leader> invited you to their party",
// with "Accept" and dismiss buttons. "Accept" posts partyApi.acceptInvite(partyId), toasts "Joined party!"
// and hides the banner. We press that same button, so the site's own request, toasts and party refresh run
// as if it had been clicked.
// Invites that would pull you out of the party you're in (the banner then says "Accepting leaves your
// current party") are left for you to decide. Each banner is pressed once: if the accept fails, the site
// shows its error toast and the banner stays for a manual click.
//
// The switch lives in the site's Settings panel (the gear icon in the left sidebar), as an Off/On card
// styled like the site's own settings (remembered in localStorage, off by default).
(() => {
  const STORAGE_KEY = "cip-auto-accept-invites";
  const CARD_ID = "cip-invite-accept-setting";
  const CLICK_DELAY_MS = 400; // let the banner finish mounting (and the leave-party warning render)

  const TITLE_RE = /invited you to their party$/;
  const LEAVES_PARTY_RE = /Accepting leaves your current party/i;

  const pressed = new WeakSet(); // banner title elements we already pressed Accept for
  let pending = null;

  const isEnabled = () => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  };
  const setEnabled = (on) => {
    try {
      localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {}
  };

  // The banner: its title element, the rail around it and that rail's "Accept" button.
  function findInvite() {
    for (const el of document.querySelectorAll("div, span, p, h1, h2, h3, h4")) {
      if (el.children.length || !TITLE_RE.test(el.textContent.trim())) continue;
      const rail = el.closest(".app-shell-container") || el.parentElement?.parentElement?.parentElement;
      const btn = [...(rail?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "Accept");
      if (btn) return { title: el, rail, btn };
    }
    return null;
  }

  const acceptable = (inv) =>
    inv && !inv.btn.disabled && !pressed.has(inv.title) && !LEAVES_PARTY_RE.test(inv.rail.textContent);

  function tryAccept() {
    if (!isEnabled() || pending || !acceptable(findInvite())) return;

    // setTimeout rather than requestAnimationFrame: invites often arrive while the tab is in the
    // background, where animation frames don't run (timers do, throttled to about once a second).
    pending = setTimeout(() => {
      pending = null;
      const inv = findInvite();
      if (!isEnabled() || !acceptable(inv)) return;
      pressed.add(inv.title);
      console.log(`[CSGOPremier Auto-accept] Accepting party invite: ${inv.title.textContent.trim()}`);
      inv.btn.click();
    }, CLICK_DELAY_MS);
  }

  // --- Settings panel card ---

  // The site's Off/On option buttons (as in its "3D Skin Previews" setting).
  const OPTION_BASE =
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 hover:bg-white/10 min-w-0 flex-1 p-2 border text-[10px] uppercase tracking-wider transition-all";
  const OPTION_OFF = "border-white/10 text-white/40 hover:border-white/30";
  const OPTION_ON = "border-tertiary bg-tertiary/10 text-white/80";

  function renderCard(card) {
    const on = isEnabled();
    for (const btn of card.querySelectorAll("button[data-value]")) {
      const selected = (btn.dataset.value === "1") === on;
      btn.className = `${OPTION_BASE} ${selected ? OPTION_ON : OPTION_OFF}`;
      btn.setAttribute("aria-pressed", String(selected));
    }
  }

  function createCard() {
    const card = document.createElement("div");
    card.id = CARD_ID;
    card.className = "relative bg-black/20 border border-white/10 p-3";
    card.innerHTML = `
      <div class="text-sm font-medium text-white/80 mb-1">Auto-accept Lobby Invites</div>
      <p class="text-[10px] text-white/40 mb-2">Join a party as soon as someone invites you, on any page. Invites that would make you leave your current party are left for you.</p>
      <div class="flex gap-2">
        <button type="button" data-value="0">Off</button>
        <button type="button" data-value="1">On</button>
      </div>`;
    for (const btn of card.querySelectorAll("button[data-value]")) {
      btn.addEventListener("click", () => {
        setEnabled(btn.dataset.value === "1");
        renderCard(card);
        tryAccept();
      });
    }
    renderCard(card);
    return card;
  }

  // The right-hand panel (data-tour="friends-panel") shows Settings when its header reads "Settings";
  // the setting cards sit in the "p-3 space-y-3" list under that header. (The panel's tab rail also has a
  // "Settings" label, hence matching only a span inside the bordered header.)
  function findSettingsList() {
    const panel = document.querySelector('[data-tour="friends-panel"]');
    if (!panel) return null;
    const header = [...panel.querySelectorAll(".border-b")].find((h) =>
      [...h.querySelectorAll("span")].some((s) => s.textContent.trim() === "Settings"),
    );
    const list = header?.nextElementSibling;
    return list && list.querySelector(".border") ? list : null;
  }

  function injectCard() {
    if (document.getElementById(CARD_ID)) return;
    const list = findSettingsList();
    if (list) list.appendChild(createCard());
  }

  function update() {
    injectCard();
    tryAccept();
  }

  // Also re-render when the setting changes in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const card = document.getElementById(CARD_ID);
    if (card) renderCard(card);
    tryAccept();
  });

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 0);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

  update();
})();
