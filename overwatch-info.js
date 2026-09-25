// Match details above the clip on the Overwatch review page (/overwatch/review).
//
// The site's own API (/api/overwatch/next) only hands out a clip id, but the clip the player loads is
// stored as "<match id>_<steam id>.mp4", so both ids can be read straight off the video's URL once it
// loads. Everything else comes from /api/match/<match id>, the endpoint the site's match pages use:
// both teams with their names, scores, ratings and per-player stats. The suspect's row is marked. Each
// player reads "username (steam64)": the username opens that player's profile (/<username>) in a new tab,
// and the id opens steamcommunity.com and steamcommunity.now for that id.
//
// Nothing is requested before a clip is actually loaded, and each match is only fetched once.
(() => {
  const CARD_ID = "cip-ow-info";
  const STORAGE_KEY = "cip-ow-info-open";
  // .../overwatch-clips/22036_76561199415992629.mp4?<signature>
  const CLIP_RE = /\/overwatch-clips\/(\d+)_(\d{17})\./i;

  const cache = new Map(); // match id → Promise of the /api/match payload

  // The scoreboard can be folded away, so the clip keeps its place on screen; the header stays.
  let open = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY) !== "0";
    } catch {
      return true;
    }
  })();

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n || 0).toLocaleString("en-US");
  // "premier5v5_ladder" → "Premier 5v5 Ladder", "nuke" → "Nuke"
  const label = (s) =>
    String(s || "")
      .replace(/[_-]+/g, " ")
      .replace(/([a-z])(\d)/gi, "$1 $2")
      .replace(/\b\w/g, (c) => c.toUpperCase());

  const steamLink = (id) => `https://steamcommunity.com/profiles/${id}`;
  // The second lookup the user asked for, opened alongside Steam when an id is clicked.
  const mirrorLink = (id) => `https://steamcommunity.now/profiles/${id}`;
  const STEAM_ID_CLASS = "cip-steam-id";
  const ID_TITLE = "Open on steamcommunity.com and steamcommunity.now";
  // The site's own profile pages sit at the root: /rudolf, /grepxekruska, and so on.
  const profileLink = (username) => `/${encodeURIComponent(username)}`;

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

  // Same panel as the page's own cards, a little tighter.
  const CARD_CLASS =
    "relative overflow-hidden border border-white/[0.065] bg-[rgba(11,12,17,0.56)] " +
    "shadow-[0_16px_50px_rgba(0,0,0,0.1)] backdrop-blur-[2px] px-[18px] py-3";
  const CHIP = "border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/45";
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
      card.className = CARD_CLASS;
      card.addEventListener("click", (e) => {
        // A Steam id opens two tabs: the anchor handles steamcommunity.com, this opens the other one.
        // Chrome allows one pop-up per click, so the second may need "always allow" for this site.
        const id = e.target.closest(`.${STEAM_ID_CLASS}`)?.dataset.steam;
        if (id) {
          window.open(mirrorLink(id), "_blank", "noopener");
          return;
        }
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
    const chips = data
      ? [data.map && label(data.map), data.gameMode && label(data.gameMode), data.region, data.status && label(data.status)]
          .filter(Boolean)
          .map((t) => `<span class="${CHIP}">${escapeHtml(t)}</span>`)
          .join("")
      : "";
    const score =
      data && (data.teamAScore != null || data.teamBScore != null)
        ? `<span class="font-mono text-sm font-bold tabular-nums text-white">${data.teamAScore ?? 0}<span class="mx-1 text-white/25">:</span>${data.teamBScore ?? 0}</span>`
        : "";
    return `
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <span class="ui-overline text-secondary">Match #${escapeHtml(matchId)}</span>
          ${chips}
          ${score}
        </div>
        <div class="ui-meta flex items-center gap-1.5 text-white/40">
          <span>Suspect</span>
          ${
            suspect
              ? `<a href="${profileLink(suspect.username)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(suspect.username)}'s profile"
                   class="font-bold text-primary hover:underline">${escapeHtml(suspect.username)}</a>`
              : ""
          }
          <a href="${steamLink(steamId)}" target="_blank" rel="noopener noreferrer" data-steam="${escapeHtml(steamId)}"
             class="${STEAM_ID_CLASS} font-mono tabular-nums text-white/60 hover:text-white hover:underline"
             title="${ID_TITLE}">(${escapeHtml(steamId)})</a>
          <button type="button" class="cip-ow-toggle -my-1 ml-1 inline-flex items-center p-1 text-white/35 transition-colors hover:text-white"
                  title="Show or hide the scoreboard" aria-label="Show or hide the scoreboard">${CHEVRON}</button>
        </div>
      </div>`;
  }

  function playerRowHtml(p, steamId, rounds) {
    const isSuspect = String(p.steamId) === steamId;
    const s = p.stats || {};
    const adr = rounds > 0 && s.damage != null ? Math.round(s.damage / rounds) : null;
    const cells = [p.rating ? num(p.rating) : "–", s.kills ?? "–", s.deaths ?? "–", s.assists ?? "–", adr ?? "–"];
    return `
      <tr class="border-t border-white/[0.04] ${isSuspect ? "bg-primary/[0.07]" : ""} ${p.didNotJoin ? "opacity-40" : ""}">
        <td class="px-2.5 py-1">
          <div class="flex min-w-0 items-center gap-1.5">
            ${p.avatarUrl ? `<img src="${escapeHtml(p.avatarUrl)}" alt="" class="h-4 w-4 shrink-0 object-cover">` : ""}
            <a href="${profileLink(p.username)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(p.username)}'s profile"
               class="truncate ${isSuspect ? "font-bold text-primary" : "text-white/75 hover:text-white"} hover:underline">${escapeHtml(p.username)}</a>
            <a href="${steamLink(p.steamId)}" target="_blank" rel="noopener noreferrer" data-steam="${escapeHtml(p.steamId)}"
               class="${STEAM_ID_CLASS} shrink-0 font-mono text-[10px] tabular-nums text-white/30 hover:text-white/70 hover:underline"
               title="${ID_TITLE}">(${escapeHtml(p.steamId)})</a>
            ${isSuspect ? `<span class="shrink-0 border border-primary/30 bg-primary/10 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-primary">Suspect</span>` : ""}
            ${p.didNotJoin ? `<span class="${CHIP} shrink-0">No show</span>` : ""}
          </div>
        </td>
        ${cells
          .map((v, i) => `<td class="${i === cells.length - 1 ? "px-2.5" : "px-1"} py-1 text-right font-mono tabular-nums text-white/60">${escapeHtml(v)}</td>`)
          .join("")}
      </tr>`;
  }

  function teamHtml(players, name, score, steamId, rounds) {
    return `
      <div class="border border-white/[0.06] bg-black/25">
        <div class="flex items-center justify-between gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
          <span class="ui-meta truncate text-white/45">${escapeHtml(name || "Team")}</span>
          <span class="font-mono text-sm font-bold tabular-nums text-white">${score ?? 0}</span>
        </div>
        <table class="w-full table-fixed text-[11px]">
          <thead>
            <tr class="text-[9px] uppercase tracking-wider text-white/30">
              <th class="px-2.5 py-1 text-left font-bold">Player</th>
              ${["Rating", "K", "D", "A", "ADR"]
                .map(
                  (h, i) =>
                    `<th class="${i === 4 ? "px-2.5" : "px-1"} py-1 text-right font-bold ${i === 0 ? "w-14" : i === 4 ? "w-10" : "w-7"}">${h}</th>`
                )
                .join("")}
            </tr>
          </thead>
          <tbody>${(players || []).map((p) => playerRowHtml(p, steamId, rounds)).join("")}</tbody>
        </table>
      </div>`;
  }

  function render(card, ids, state, data, error) {
    const suspect = data ? [...(data.teamA || []), ...(data.teamB || [])].find((p) => String(p.steamId) === ids.steamId) : null;
    let body = "";
    if (state === "loading") body = `<div class="ui-meta mt-2 text-white/30">Loading match details…</div>`;
    else if (state === "error") body = `<div class="ui-meta mt-2 text-white/30">Match details unavailable (${escapeHtml(error)}).</div>`;
    else {
      const rounds = (data.teamAScore || 0) + (data.teamBScore || 0);
      body = `
        <div class="cip-ow-body mt-2.5 grid gap-2.5 sm:grid-cols-2">
          ${teamHtml(data.teamA, data.teamAName, data.teamAScore, ids.steamId, rounds)}
          ${teamHtml(data.teamB, data.teamBName, data.teamBScore, ids.steamId, rounds)}
        </div>`;
    }
    card.innerHTML = headerHtml(ids, data, suspect) + body;
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
