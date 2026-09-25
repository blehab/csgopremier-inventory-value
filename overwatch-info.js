// Match details above the clip on the Overwatch review page (/overwatch/review).
//
// The site's own API (/api/overwatch/next) only hands out a clip id, but the clip the player loads is
// stored as "<match id>_<steam id>.mp4", so both ids can be read straight off the video's URL once it
// loads. Everything else comes from /api/match/<match id>, the endpoint the site's match pages use:
// both teams with their names, scores, ratings and per-player stats. The suspect's row is marked. The
// card itself is drawn by match-card.js, which the live match lineup (match-table.js) shares.
//
// Nothing is requested before a clip is actually loaded, and each match is only fetched once.
(() => {
  const CARD_ID = "cip-ow-info";
  const STORAGE_KEY = "cip-ow-info-open";
  // .../overwatch-clips/22036_76561199415992629.mp4?<signature>
  const CLIP_RE = /\/overwatch-clips\/(\d+)_(\d{17})\./i;

  const M = window.__cipMatchCard; // match-card.js
  const { escapeHtml } = M;
  const cache = new Map(); // match id → Promise of the /api/match payload

  // The scoreboard can be folded away, so the clip keeps its place on screen; the header stays.
  let open = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  })();

  // The clip the page is showing, if its URL carries the ids.
  function currentClip() {
    const video = [...document.querySelectorAll("video")].find((v) => CLIP_RE.test(v.currentSrc || v.src || ""));
    if (!video) return null;
    const [, matchId, steamId] = (video.currentSrc || video.src).match(CLIP_RE);
    return { video, matchId, steamId };
  }

  function loadMatch(matchId) {
    if (!cache.has(matchId)) {
      cache.set(
        matchId,
        fetch(`/api/match/${matchId}`, { credentials: "include" })
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .catch((e) => {
            cache.delete(matchId); // so the next clip of the same match can try again
            throw e;
          })
      );
    }
    return cache.get(matchId);
  }

  const CHEVRON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5 transition-transform" aria-hidden="true">` +
    `<path d="m6 9 6 6 6-6"/></svg>`;

  // Puts the card directly above the clip's panel, inside the page's own column.
  function placeCard(video) {
    const column = video.closest("div.mx-auto");
    if (!column) return null;
    let panel = video;
    while (panel.parentElement && panel.parentElement !== column) panel = panel.parentElement;
    if (panel.parentElement !== column) return null;

    let card = document.getElementById(CARD_ID);
    if (!card) {
      card = document.createElement("div");
      card.id = CARD_ID;
      card.className = M.CARD_CLASS;
      card.addEventListener("click", (e) => {
        if (M.openMirror(e)) return;
        if (!e.target.closest(".cip-ow-toggle")) return;
        open = !open;
        try {
          localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
        } catch {}
        applyOpen(card);
      });
    }
    if (card.nextElementSibling !== panel) column.insertBefore(card, panel); // React re-renders move it
    return card;
  }

  function applyOpen(card) {
    card.querySelector(".cip-ow-body")?.toggleAttribute("hidden", !open);
    const toggle = card.querySelector(".cip-ow-toggle");
    if (!toggle) return;
    toggle.setAttribute("aria-expanded", String(open));
    const icon = toggle.querySelector("svg"); // inline, so it doesn't depend on the site's utility CSS
    if (icon) icon.style.transform = open ? "" : "rotate(-90deg)";
  }

  function headerHtml({ matchId, steamId }, data, suspect) {
    return `
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        ${M.titleHtml(matchId, data)}
        <div class="ui-meta flex items-center gap-1.5 text-white/40">
          <span>Suspect</span>
          ${
            suspect
              ? `<a href="${M.profileLink(suspect.username)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(suspect.username)}'s profile"
                   class="font-bold text-primary hover:underline">${escapeHtml(suspect.username)}</a>`
              : ""
          }
          <a href="${M.steamLink(steamId)}" target="_blank" rel="noopener noreferrer" data-steam="${escapeHtml(steamId)}"
             class="${M.STEAM_ID_CLASS} font-mono tabular-nums text-white/60 hover:text-white hover:underline"
             title="${M.ID_TITLE}">(${escapeHtml(steamId)})</a>
          <button type="button" class="cip-ow-toggle -my-1 ml-1 inline-flex items-center p-1 text-white/35 transition-colors hover:text-white"
                  title="Show or hide the scoreboard" aria-label="Show or hide the scoreboard">${CHEVRON}</button>
        </div>
      </div>`;
  }

  function render(card, ids, state, data, error) {
    const suspect = data ? [...(data.teamA || []), ...(data.teamB || [])].find((p) => String(p.steamId) === ids.steamId) : null;
    let body = "";
    if (state === "loading") body = `<div class="ui-meta mt-2 text-white/30">Loading match details…</div>`;
    else if (state === "error") body = `<div class="ui-meta mt-2 text-white/30">Match details unavailable (${escapeHtml(error)}).</div>`;
    else body = M.teamsHtml(data, M.statColumns(data), { steamId: ids.steamId, tag: "Suspect" }, "cip-ow-body");
    card.innerHTML = headerHtml(ids, data, suspect) + body;
    window.__cipCountry?.fillFlags(card); // country-flags.js
    applyOpen(card);
  }

  function update() {
    const clip = currentClip();
    if (!clip) {
      document.getElementById(CARD_ID)?.remove(); // no clip loaded: nothing to show
      return;
    }
    const card = placeCard(clip.video);
    if (!card) return;
    const key = `${clip.matchId}_${clip.steamId}`;
    if (card.dataset.key === key) return;
    card.dataset.key = key;

    render(card, clip, "loading");
    loadMatch(clip.matchId).then(
      (data) => card.dataset.key === key && render(card, clip, "ready", data),
      (e) => card.dataset.key === key && render(card, clip, "error", null, e.message)
    );
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

  update();
})();
