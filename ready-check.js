// The match's ready check, made less of a wall.
//
// While a ready check is running:
//   · the dialog lists the people in your party who still haven't accepted, with their avatars, for the
//     whole ready check; each name drops off the moment that player accepts;
//   · once you have accepted (by hand or through auto-accept), the dialog is hidden and the count moves
//     to a chip beside the PP balance, e.g. "Accepted 7/10 · waiting: rudolf, yazq", which keeps counting
//     up and keeps naming the stragglers. The chip has a button to bring the dialog back, and it goes away
//     when the ready check does.
//
// The counts come from the server, not from the page. The site's matchmaking store is only asked which
// match you're in (currentMatchId); its acceptScreenData is wiped to null the moment the accept screen is
// dismissed, and isAcceptScreenVisible goes false with it — which is why anything reading the screen's own
// state loses the chip at random. So the match id comes from that store, or from the engagements query
// when the store has none (straight after a reload), and /api/match/<id> is polled while the ready check
// is live: it carries every player's accepted flag, their partyId and avatar, and acceptDeadline. A ready
// check counts as live while that deadline is in the future and not everyone has accepted yet.
//
// Runs in the page's MAIN world, because the store is only reachable through React's fiber tree.
(() => {
  const CHIP_ID = "cip-ready-chip";
  const WAITING_CLASS = "cip-ready-waiting";
  const HIDDEN_ATTR = "data-cip-ready-hidden";
  const TICK_MS = 1000;
  const POLL_MS = 2000; // how often the server is asked while a ready check is live

  let getStore = null; // the store's snapshot getter, cached between passes
  let mySteamId = null;
  let revealed = null; // the match id whose dialog you asked to see again

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- the site's matchmaking store ----------

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
      while (stack.length && steps < 40000) {
        const f = stack.pop();
        steps++;
        if (!f) continue;
        for (let h = f.memoizedState; h && typeof h === "object" && "next" in h; h = h.next) {
          const v = h.memoizedState;
          if (v && typeof v === "object" && "isAcceptScreenVisible" in v && "acceptScreenData" in v) {
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
        if (state && "isAcceptScreenVisible" in state) return state;
      } catch {
        /* the component remounted: look it up again */
      }
      getStore = null;
    }
    return null;
  }

  async function whoAmI() {
    if (mySteamId !== null) return mySteamId;
    mySteamId = "";
    try {
      const data = await (await fetch("/api/me", { credentials: "include" })).json();
      mySteamId = String(data?.user?.steam_id || "");
    } catch {
      /* without it the chip still counts, it just can't tell which player is you */
    }
    return mySteamId;
  }

  // Which match to ask about: the store's id, or the one the engagements query knows about after a reload.
  function currentMatchId() {
    const id = storeState()?.currentMatchId;
    if (typeof id === "number" || typeof id === "string") return id;
    const active = findQueryClient()?.getQueryData(["v2", "engagements"])?.active;
    for (const entry of Array.isArray(active) ? active : []) {
      const found = entry?.match_id ?? entry?.game_id ?? entry?.gameId ?? entry?.id;
      if (typeof found === "number" || typeof found === "string") return found;
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

  function toCheck(matchId, data) {
    const players = [...(data.teamA || []), ...(data.teamB || [])];
    if (!players.length) return null;
    const deadline = Date.parse(data.acceptDeadline || "");
    const secondsLeft = Number.isFinite(deadline) ? Math.round((deadline - Date.now()) / 1000) : null;
    const accepted = players.filter((p) => p.accepted).length;
    // The ready check is over once the deadline passes or everyone is in: the match itself takes over.
    if (secondsLeft == null || secondsLeft <= 0 || accepted === players.length) return null;
    const mine = players.find((p) => String(p.steamId) === mySteamId);
    return {
      matchId,
      players,
      mine,
      accepted,
      total: players.length,
      secondsLeft,
      party: mine?.partyId ? players.filter((p) => p.partyId === mine.partyId && p.steamId !== mine.steamId) : [],
    };
  }

  // The server's answer, kept for a couple of seconds so every pass doesn't re-ask.
  let polling = false;
  let cached = null; // { matchId, at, check }
  function refresh(matchId) {
    if (polling || (cached?.matchId === matchId && Date.now() - cached.at < POLL_MS)) return;
    polling = true;
    fetch(`/api/match/${matchId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        cached = { matchId, at: Date.now(), raw: data, check: data ? toCheck(matchId, data) : null };
        update();
      })
      .catch(() => {
        cached = { matchId, at: Date.now(), raw: cached?.raw ?? null, check: cached?.check ?? null }; // keep what we had
      })
      .finally(() => {
        polling = false;
      });
  }

  // While the accept screen is up the site keeps its own copy of the match, updated over the websocket as
  // people accept. It's fresher than our two-second poll, so its flags win when it's for the same match.
  function withStoreData(check) {
    const data = storeState()?.acceptScreenData;
    if (!data || (data.gameId ?? null) !== check.matchId) return check;
    const players = [...(data.teamA || []), ...(data.teamB || [])];
    if (players.length !== check.total) return check;
    const mine = players.find((p) => String(p.steamId) === mySteamId);
    return {
      ...check,
      players,
      mine: mine ?? check.mine,
      accepted: players.filter((p) => p.accepted).length,
      party: mine?.partyId ? players.filter((p) => p.partyId === mine.partyId && p.steamId !== mine.steamId) : check.party,
    };
  }

  // The counts age between polls; the countdown doesn't need to.
  function liveCheck() {
    const check = cached?.check;
    if (!check) return null;
    const secondsLeft = check.secondsLeft - Math.round((Date.now() - cached.at) / 1000);
    return secondsLeft > 0 ? { ...check, secondsLeft } : null;
  }

  // ---------- the dialog ----------

  // The site leaves closed dialogs in the page (data-state="closed"), so they have to be filtered out.
  const isOpenDialog = (el) =>
    el.getAttribute("data-state") !== "closed" && !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true";

  const readyDialog = () =>
    [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find(
      (d) => /ready check/i.test(d.textContent || "") && isOpenDialog(d)
    );

  function injectStyle() {
    if (document.getElementById("cip-ready-style")) return;
    const style = document.createElement("style");
    style.id = "cip-ready-style";
    style.textContent = `[${HIDDEN_ATTR}] { display: none !important; }`;
    document.head.appendChild(style);
  }

  function hideDialog(dialog) {
    injectStyle();
    dialog.setAttribute(HIDDEN_ATTR, "");
    // the backdrop is a sibling in the same portal
    for (const sib of dialog.parentElement?.children || []) {
      if (sib !== dialog && /fixed/.test(sib.className || "")) sib.setAttribute(HIDDEN_ATTR, "");
    }
  }

  const unhideDialog = () => {
    for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) el.removeAttribute(HIDDEN_ATTR);
  };

  function renderWaiting(check) {
    const dialog = readyDialog();
    if (!dialog) return;
    const waiting = check.party.filter((p) => !p.accepted);
    let row = dialog.querySelector(`.${WAITING_CLASS}`);
    if (!waiting.length) {
      row?.remove(); // everyone in your party is in
      return;
    }
    if (!row) {
      row = document.createElement("div");
      row.className = `${WAITING_CLASS} flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-primary/25 bg-primary/[0.06] px-5 py-3 sm:px-7`;
      dialog.appendChild(row);
    }
    const html =
      `<span class="text-xs font-bold uppercase tracking-wider text-primary">Still to accept</span>` +
      waiting
        .map(
          (p) =>
            `<span class="flex items-center gap-2">` +
            (p.avatarUrl ? `<img src="${escapeHtml(p.avatarUrl)}" alt="" class="h-6 w-6 shrink-0 border border-primary/40 object-cover">` : "") +
            `<span class="text-sm font-semibold text-white/85">${escapeHtml(p.username)}</span></span>`
        )
        .join("");
    if (row.innerHTML !== html) row.innerHTML = html;
  }

  // ---------- the chip beside the PP balance ----------

  // The balance appears more than once in the markup (top bar and mobile header), so take the one that's
  // actually on screen — otherwise the chip lands in a hidden copy and looks like it vanished.
  function ppGroup() {
    const all = [...document.querySelectorAll("span")].filter((el) => /^\d[\d,]*\s*PP$/.test(el.textContent.trim()));
    const pp = all.find((el) => el.getBoundingClientRect().width > 0) || all[0];
    return pp?.closest("div.flex.shrink-0.items-center") || pp?.closest("a")?.parentElement || null;
  }

  function renderChip(check) {
    const group = ppGroup();
    if (!group) return;
    let chip = document.getElementById(CHIP_ID);
    if (!chip) {
      chip = document.createElement("div");
      chip.id = CHIP_ID;
      chip.className = "flex h-11 shrink-0 items-center gap-2 border-r border-white/[0.08] px-3.5";
      chip.innerHTML =
        `<span class="h-1.5 w-1.5 shrink-0 bg-quaternary"></span>` +
        `<span class="cip-ready-count whitespace-nowrap text-xs font-semibold text-white/80"></span>` +
        `<span class="cip-ready-waiting-names whitespace-nowrap text-xs text-primary"></span>` +
        `<button type="button" class="cip-ready-show text-[10px] font-bold uppercase tracking-wider text-white/35 transition-colors hover:text-white" title="Show the ready check">Show</button>`;
      chip.querySelector(".cip-ready-show").addEventListener("click", () => {
        revealed = check.matchId ?? "current";
        unhideDialog();
        // Once you've accepted, the site takes its accept screen down and clears the data behind it, so
        // there's usually nothing left to un-hide: it gets re-opened through the site's own action, with
        // the match as the server last described it.
        const store = storeState();
        if (!readyDialog() && store?.showAcceptScreen && cached?.raw && check.matchId != null) {
          store.showAcceptScreen(check.matchId, { ...cached.raw, status: "ACCEPTING" });
        }
        chip.remove();
      });
      group.insertAdjacentElement("afterbegin", chip);
    }
    const text = `Accepted ${check.accepted}/${check.total}`;
    const label = chip.querySelector(".cip-ready-count");
    if (label.textContent !== text) label.textContent = text;

    // Who in your party is still holding it up. Two names, then a count, so the top bar stays readable.
    const waiting = check.party.filter((p) => !p.accepted).map((p) => p.username);
    const names = waiting.length
      ? `· waiting: ${waiting.slice(0, 2).join(", ")}${waiting.length > 2 ? ` +${waiting.length - 2}` : ""}`
      : "";
    const namesEl = chip.querySelector(".cip-ready-waiting-names");
    if (namesEl.textContent !== names) namesEl.textContent = names;
    chip.title = waiting.length ? `Still to accept: ${waiting.join(", ")}` : "Everyone in your party has accepted";
  }

  function clearChip() {
    document.getElementById(CHIP_ID)?.remove();
    unhideDialog();
  }

  // ---------- the pass, run on a timer and on every DOM change ----------

  function update() {
    const matchId = currentMatchId();
    if (matchId != null) refresh(matchId);
    const stale = liveCheck();
    const check = stale ? withStoreData(stale) : null;
    if (!check) {
      // no ready check, or it's over: put everything back
      clearChip();
      revealed = null;
      return;
    }

    // Closing the dialog you asked to see brings the chip back.
    if (revealed !== null && !readyDialog()) revealed = null;

    if (check.mine?.accepted && revealed !== (check.matchId ?? "current")) {
      const dialog = readyDialog();
      if (dialog) hideDialog(dialog); // it isn't rendered on every page, which is fine
      renderChip(check);
    } else {
      clearChip();
      renderWaiting(check);
    }
  }

  whoAmI().then(update);
  setInterval(update, TICK_MS);
  // React re-renders the top bar on its own and drops anything it didn't put there; rebuilding straight
  // away, rather than on the next tick, keeps the chip from blinking out.
  new MutationObserver(() => update()).observe(document.documentElement, { childList: true, subtree: true });
})();
