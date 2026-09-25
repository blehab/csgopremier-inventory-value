// The Overwatch card's look (panel, header chips, team boxes, player rows), shared through
// window.__cipMatchCard with the Overwatch review page (overwatch-info.js); the live match table
// (match-table.js) borrows its panel style.
//
// Each player reads "flag avatar username (steam64)" (flags from country-flags.js): the username opens
// that player's profile (/<username>) in a new tab, and the id opens steamcommunity.com and
// steamcommunity.now for that id (the page's click handler calls openMirror for the second one).
(() => {
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
  const mirrorLink = (id) => `https://steamcommunity.now/profiles/${id}`;
  const STEAM_ID_CLASS = "cip-steam-id";
  const ID_TITLE = "Open on steamcommunity.com and steamcommunity.now";
  // The site's own profile pages sit at the root: /rudolf, /grepxekruska, and so on.
  const profileLink = (username) => `/${encodeURIComponent(username)}`;

  // Same panel as the page's own cards, a little tighter.
  const CARD_CLASS =
    "relative overflow-hidden border border-white/[0.065] bg-[rgba(11,12,17,0.56)] " +
    "shadow-[0_16px_50px_rgba(0,0,0,0.1)] backdrop-blur-[2px] px-[18px] py-3";
  const CHIP = "border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/45";

  // A click on a Steam id: the anchor handles steamcommunity.com, this opens the other one. Chrome allows
  // one pop-up per click, so the second may need "always allow" for this site. True if it was one.
  function openMirror(e) {
    const id = e.target.closest(`.${STEAM_ID_CLASS}`)?.dataset.steam;
    if (id) window.open(mirrorLink(id), "_blank", "noopener");
    return !!id;
  }

  // "Match #123  MAP  MODE  REGION  STATUS  12 : 16"
  function titleHtml(matchId, data) {
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
      <div class="flex flex-wrap items-center gap-2">
        <span class="ui-overline text-secondary">Match #${escapeHtml(matchId)}</span>
        ${chips}
        ${score}
      </div>`;
  }

  // The site's own rating badge (its Rating component): two bars and the number on a skewed box, coloured
  // by rating tier. Tiers and glow colours are copied from the site's getRatingColors.
  const RATING_TIERS = [
    [30000, "tertiary", "rgba(250, 254, 56, 0.1)"],
    [25000, "primary", "rgba(246, 8, 100, 0.1)"],
    [20000, "pink-500", "rgba(236, 72, 153, 0.1)"],
    [15000, "purple-500", "rgba(168, 85, 247, 0.1)"],
    [10000, "secondary", "rgba(54, 248, 248, 0.1)"],
    [5000, "blue-300", "rgba(147, 197, 253, 0.1)"],
    [-Infinity, "gray-400", "rgba(156, 163, 175, 0.1)"],
  ];
  function ratingBadgeHtml(rating) {
    const r = Number(rating) || 0;
    const [, color, glow] = RATING_TIERS.find(([min]) => r >= min);
    const text = r === 0 ? "-" : r === 74999 ? "75k" : r.toLocaleString();
    const bar = `<div class="bg-${color} h-5 w-[4px]" style="box-shadow:0 0 8px ${glow}"></div>`;
    return `
      <div style="display:flex;justify-content:flex-end">
        <div class="relative flex items-center min-w-[90px] max-w-[90px] gap-2 py-1 pl-2 pr-3"
             style="background:rgba(0,0,0,0.4);transform:skewX(-8deg);box-shadow:0 0 15px ${glow}">
          <div class="flex gap-[2px]">${bar}${bar}</div>
          <span class="text-${color} text-sm font-bold italic" style="text-shadow:0 0 10px ${glow};transform:skewX(8deg)">${text}</span>
        </div>
      </div>`;
  }

  // Sizes as inline styles, so they don't depend on which utility classes the site's CSS happens to have.
  // The default is the Overwatch card's; "large" is the match page's.
  const LARGE = {
    table: "font-size:13px",
    head: "font-size:10px",
    cell: "padding-top:5px;padding-bottom:5px",
    avatar: "width:22px;height:22px",
    id: "font-size:11px",
    name: "font-size:12px",
    score: "font-size:16px",
  };
  const NORMAL = {};

  // columns: [{ label, w: width class, width: px, get: (player) → text, html: (player) → markup }];
  // marked: { steamId, tag } to highlight one row.
  function playerRowHtml(p, columns, marked, sz) {
    const isMarked = !!marked && String(p.steamId) === String(marked.steamId);
    return `
      <tr class="border-t border-white/[0.04] ${isMarked ? "bg-primary/[0.07]" : ""} ${p.didNotJoin ? "opacity-40" : ""}">
        <td class="px-2.5 py-1" style="${sz.cell || ""}">
          <div class="flex min-w-0 items-center gap-1.5">
            ${window.__cipCountry ? window.__cipCountry.slotHtml(p.username) : ""}
            ${p.avatarUrl ? `<img src="${escapeHtml(p.avatarUrl)}" alt="" class="h-4 w-4 shrink-0 object-cover" style="${sz.avatar || ""}">` : ""}
            <a href="${profileLink(p.username)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(p.username)}'s profile"
               class="truncate ${isMarked ? "font-bold text-primary" : "text-white/75 hover:text-white"} hover:underline">${escapeHtml(p.username)}</a>
            <a href="${steamLink(p.steamId)}" target="_blank" rel="noopener noreferrer" data-steam="${escapeHtml(p.steamId)}"
               class="${STEAM_ID_CLASS} shrink-0 font-mono text-[10px] tabular-nums text-white/30 hover:text-white/70 hover:underline"
               style="${sz.id || ""}" title="${ID_TITLE}">(${escapeHtml(p.steamId)})</a>
            ${isMarked ? `<span class="shrink-0 border border-primary/30 bg-primary/10 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-primary">${escapeHtml(marked.tag)}</span>` : ""}
            ${p.didNotJoin ? `<span class="${CHIP} shrink-0">No show</span>` : ""}
          </div>
        </td>
        ${columns
          .map((col, i) => {
            const pad = i === columns.length - 1 ? "px-2.5" : "px-1";
            const content = col.html ? col.html(p) : escapeHtml(col.get(p) ?? "–");
            return `<td class="${pad} py-1 text-right ${col.html ? "" : "font-mono tabular-nums text-white/60"}" style="${sz.cell || ""}">${content}</td>`;
          })
          .join("")}
      </tr>`;
  }

  function teamHtml(players, name, score, columns, marked, sz) {
    return `
      <div class="border border-white/[0.06] bg-black/25">
        <div class="flex items-center justify-between gap-2 border-b border-white/[0.06] px-2.5 py-1.5">
          <span class="ui-meta truncate text-white/45" style="${sz.name || ""}">${escapeHtml(name || "Team")}</span>
          <span class="font-mono text-sm font-bold tabular-nums text-white" style="${sz.score || ""}">${score ?? 0}</span>
        </div>
        <table class="w-full table-fixed text-[11px]" style="${sz.table || ""}">
          <thead>
            <tr class="text-[9px] uppercase tracking-wider text-white/30" style="${sz.head || ""}">
              <th class="px-2.5 py-1 text-left font-bold">Player</th>
              ${columns
                .map(
                  (col, i) =>
                    `<th class="${i === columns.length - 1 ? "px-2.5" : "px-1"} py-1 text-right font-bold ${col.w || ""}" ${
                      col.width ? `style="width:${col.width}px"` : ""
                    }>${escapeHtml(col.label)}</th>`
                )
                .join("")}
            </tr>
          </thead>
          <tbody>${(players || []).map((p) => playerRowHtml(p, columns, marked, sz)).join("")}</tbody>
        </table>
      </div>`;
  }

  // The Overwatch card's columns: rating, then K, D, A and ADR from the match itself.
  function statColumns(data) {
    const rounds = (data.teamAScore || 0) + (data.teamBScore || 0);
    return [
      { label: "Rating", w: "w-14", get: (p) => (p.rating ? num(p.rating) : null) },
      { label: "K", w: "w-7", get: (p) => p.stats?.kills },
      { label: "D", w: "w-7", get: (p) => p.stats?.deaths },
      { label: "A", w: "w-7", get: (p) => p.stats?.assists },
      { label: "ADR", w: "w-10", get: (p) => (rounds > 0 && p.stats?.damage != null ? Math.round(p.stats.damage / rounds) : null) },
    ];
  }

  // Both teams side by side (stacked on narrow screens).
  function teamsHtml(data, columns, marked, extraClass = "", large = false) {
    const sz = large ? LARGE : NORMAL;
    return `
      <div class="${extraClass} mt-2.5 grid gap-2.5 sm:grid-cols-2">
        ${teamHtml(data.teamA, data.teamAName, data.teamAScore, columns, marked, sz)}
        ${teamHtml(data.teamB, data.teamBName, data.teamBScore, columns, marked, sz)}
      </div>`;
  }

  window.__cipMatchCard = {
    escapeHtml,
    num,
    label,
    steamLink,
    profileLink,
    STEAM_ID_CLASS,
    ID_TITLE,
    CARD_CLASS,
    CHIP,
    openMirror,
    titleHtml,
    ratingBadgeHtml,
    statColumns,
    teamsHtml,
  };
})();
