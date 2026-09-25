// Auto-accept: presses "Accept match" as soon as the match-found dialog appears.
//
// When a match is found the site opens its accept dialog on whatever page is open
// (useMatchmakingStore.showAcceptScreen → AcceptScreenDialog). Its only button, "Accept match",
// posts /api/matchmaking/{gameId}/accept; while that's in flight it reads "Accepting…" (disabled),
// and once accepted it's replaced by "You're ready". We press that same button, so the site's own
// request, error toast and sound/title handling all run as if it had been clicked.
// It presses once per match: if that accept fails, the site shows its error toast and the button
// stays for a manual click (pressing again straight away would most likely fail the same way).
//
// An "Auto-accept" switch under the lobby's action button on the Play page ("Find Match" for the leader,
// "Leave" for party members) turns it on and off
// (remembered in localStorage, off by default). The accepting itself works on every page.
(() => {
  const STORAGE_KEY = "cip-auto-accept";
  const TOGGLE_ID = "cip-auto-accept-toggle";
  const CLICK_DELAY_MS = 400; // let the dialog finish opening

  const acceptedMatches = new Set(); // "Match #<id>" of every match we pressed accept for
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

  function findAcceptButton() {
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
      const btn = [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept match");
      // The dialog's heading reads "Match #<id> · Ready check".
      if (btn) return { btn, match: dialog.textContent.match(/Match #\S+/)?.[0] || "unknown" };
    }
    return null;
  }

  function tryAccept() {
    if (!isEnabled() || pending) return;
    const found = findAcceptButton();
    if (!found || found.btn.disabled || acceptedMatches.has(found.match)) return;

    // setTimeout rather than requestAnimationFrame: a match is usually found while the tab is in
    // the background, where animation frames don't run (timers do, throttled to about once a second).
    pending = setTimeout(() => {
      pending = null;
      const again = findAcceptButton();
      if (!isEnabled() || !again || again.btn.disabled || acceptedMatches.has(again.match)) return;
      acceptedMatches.add(again.match);
      console.log(`[CSGOPremier Auto-accept] Accepting ${again.match}`);
      again.btn.click();
    }, CLICK_DELAY_MS);
  }

  function renderToggle(bar) {
    const on = isEnabled();
    const sw = bar.querySelector('[role="switch"]');
    sw.setAttribute("aria-checked", String(on));
    sw.title = on
      ? "Auto-accept is on: found matches are accepted automatically. Click to turn off."
      : "Auto-accept is off. Click to accept found matches automatically.";
    // Switch track and knob; the site's quaternary green when on.
    sw.querySelector(".cip-track").className =
      `cip-track relative inline-flex h-4 w-7 shrink-0 items-center border transition-colors ${on ? "border-quaternary/60 bg-quaternary/20" : "border-white/15 bg-white/[0.04]"}`;
    sw.querySelector(".cip-knob").className =
      `cip-knob absolute h-2.5 w-2.5 transition-all ${on ? "bg-quaternary" : "bg-white/35"}`;
    sw.querySelector(".cip-knob").style.left = on ? "14px" : "2px";
    bar.querySelector(".cip-state").className =
      `cip-state font-mono text-[10px] font-bold uppercase tracking-widest ${on ? "text-quaternary" : "text-white/30"}`;
    bar.querySelector(".cip-state").textContent = on ? "On" : "Off";
  }

  // A slim bar under the "Find Match" button, in the same frame style as the panels around it.
  function createToggle() {
    const bar = document.createElement("div");
    bar.id = TOGGLE_ID;
    bar.className = "relative flex items-center justify-between gap-3 border border-white/10 bg-black/25 px-3 py-2";
    bar.innerHTML = `
      <button type="button" role="switch" class="group flex min-w-0 items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span class="cip-track"><span class="cip-knob"></span></span>
        <span class="min-w-0">
          <span class="block text-xs font-bold uppercase tracking-wider text-white/80 transition-colors group-hover:text-white">Auto-accept</span>
          <span class="block truncate text-[11px] text-white/40">Accept found matches for me, on any page</span>
        </span>
      </button>
      <span class="cip-state"></span>`;
    bar.querySelector('[role="switch"]').addEventListener("click", () => {
      setEnabled(!isEnabled());
      renderToggle(bar);
      tryAccept();
    });
    renderToggle(bar);
    return bar;
  }

  // The action buttons the Play page (/) shows under the lobby, depending on your role and the queue state:
  // leader: "Find Match" ("Joining queue…" / "Checking players…" while it starts), then "Stop searching";
  // party member (not the leader): "Leave"; in a match: a "Go to Match" link.
  const ACTION_LABEL = /^(Find Match|Joining queue…|Checking players…|Stop searching|Leave|Go to Match)/i;

  // Goes in the grid that holds those buttons, inside the "Find your match" panel (so a "Leave" button
  // elsewhere on the page can't be mistaken for it).
  function findActionGrid() {
    const heading = [...document.querySelectorAll("h1")].find((h) => /^\s*Find your match\s*$/i.test(h.textContent));
    let panel = heading;
    for (let i = 0; panel && i < 8; i++) {
      panel = panel.parentElement;
      const action = [...(panel?.querySelectorAll("button, a") || [])].find((el) => ACTION_LABEL.test(el.textContent.trim()));
      if (action) return action.parentElement;
    }
    return null;
  }

  function injectToggle() {
    if (document.getElementById(TOGGLE_ID)) return;
    const grid = findActionGrid();
    if (!grid) return;
    grid.appendChild(createToggle());
  }

  function update() {
    injectToggle();
    tryAccept();
  }

  // Also re-render when the setting changes in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    const bar = document.getElementById(TOGGLE_ID);
    if (bar) renderToggle(bar);
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
