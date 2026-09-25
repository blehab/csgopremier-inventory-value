// A compact scoreboard on match pages (/match/<id>), laid out like the Overwatch card (overwatch-info.js).
//
// The site's Scoreboard tab is replaced by the two teams side by side (stacked when there isn't room),
// one short row per player: country flag, avatar, username (opens their profile in a new tab), Steam id
// (opens steamcommunity.com and steamcommunity.now), then rating, K / D / A, +/–, ADR, KAST and HS%. The
// stat cells are shaded like a heatmap against the whole match, green above the average and red below.
// Entry, clutch, multi-kill and utility numbers are in each row's tooltip, and "Full table" brings the
// site's own table back (remembered). The Heatmaps and Replay tabs are left alone, but the tab strip's
// stray scrollbars are hidden (see "tab strip" below).
//
// Data: /api/match/<id> (teams, ratings, avatars, Steam ids) and /api/match/<id>/analysis (the demo
// stats the site's table shows), both fetched once per match; countries come from country-flags.js.
//
// Before and during a match, the site's lineup is swapped for the same table, refreshed every 15 s;
// see "live lineup" below.
(() => {
  const CARD_ID = "cip-match-table";
  const VIEW_KEY = "cip-match-table-view"; // "compact" (default) | "site"
  const MATCH_RE = /^\/match\/(\d+)\/?$/;

  const C = () => window.__cipCountry; // country-flags.js
  const cache = new Map(); // match id → Promise of { match, analysis }

  let view = (() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "site" ? "site" : "compact";
    } catch {
      return "compact";
    }
  })();
  let sort = { key: "adr", dir: -1 }; // the site's table also starts on ADR, highest first

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (n) => Number(n || 0).toLocaleString("en-US");

  const steamLink = (id) => `https://steamcommunity.com/profiles/${id}`;
  const mirrorLink = (id) => `https://steamcommunity.now/profiles/${id}`;
  const STEAM_ID_CLASS = "cip-steam-id";
  const ID_TITLE = "Open on steamcommunity.com and steamcommunity.now";
  const profileLink = (username) => `/${encodeURIComponent(username)}`;

  function getJson(url) {
    return fetch(url, { credentials: "include" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
  }

  function load(matchId) {
    if (!cache.has(matchId)) {
      cache.set(
        matchId,
        Promise.all([getJson(`/api/match/${matchId}`), getJson(`/api/match/${matchId}/analysis`).catch(() => null)]).then(
          ([match, analysis]) => ({ match, analysis }),
          (e) => {
            cache.delete(matchId);
            throw e;
          }
        )
      );
    }
    return cache.get(matchId);
  }

  // The site's scoreboard: the block holding both team tables (and the legend under them).
  function findBoard() {
    for (const th of document.querySelectorAll("table thead th")) {
      if (th.textContent.trim() !== "KAST" || th.closest('[id^="cip-"]')) continue; // not the live lineup card
      const board = th.closest(".space-y-4");
      if (board) return board;
    }
    return null;
  }

  // ---------- rows ----------

  // One player's numbers, from the demo analysis when there is one, else the basic match stats.
  function statsFor(p, analysisById, rounds) {
    const a = analysisById.get(String(p.steamId));
    if (a) {
      const multi = (a.multi_kills || []).map((n, i) => [n, i + 2]).filter(([n]) => n > 0).pop(); // best multi-kill
      return {
        kills: a.kills,
        deaths: a.deaths,
        assists: a.assists,
        adr: a.adr,
        kast: a.kast,
        hs: a.hs_pct,
        extra: [
          `Entry ${a.entry_wins ?? 0}–${a.entry_losses ?? 0}`,
          `Clutch ${a.clutches_won ?? 0}/${a.clutches_total ?? 0}`,
          `Multi ${multi ? `${multi[0]}×${multi[1]}K` : "–"}`,
          `Utility ${a.utility_damage ?? 0} dmg`,
          `Flashed ${a.enemies_flashed ?? 0}`,
        ].join(" · "),
      };
    }
    const s = p.stats || {};
    if (s.kills == null && s.deaths == null) return null;
    return {
      kills: s.kills,
      deaths: s.deaths,
      assists: s.assists,
      adr: rounds > 0 && s.damage != null ? s.damage / rounds : null,
      kast: null,
      hs: s.kills > 0 && s.headshots != null ? (100 * s.headshots) / s.kills : null,
      extra: "",
    };
  }

  const STAT_W = 44; // every stat column the same width, so the cells (and their shading) line up evenly

  // key, header, tooltip, value, text, heat (1: higher is better, -1: lower is better, 0: not shaded)
  const COLUMNS = [
    { key: "rating", label: "Rating", title: "Rating", w: 56, get: (r) => r.rating ?? null, fmt: num, heat: 0 },
    { key: "kills", label: "K", title: "Kills", w: STAT_W, get: (r) => r.s?.kills, heat: 1 },
    { key: "deaths", label: "D", title: "Deaths", w: STAT_W, get: (r) => r.s?.deaths, heat: -1 },
    { key: "assists", label: "A", title: "Assists", w: STAT_W, get: (r) => r.s?.assists, heat: 1 },
    {
      key: "diff",
      label: "+/–",
      title: "Kills minus deaths",
      w: STAT_W,
      get: (r) => (r.s?.kills != null && r.s?.deaths != null ? r.s.kills - r.s.deaths : null),
      fmt: (v) => (v > 0 ? `+${v}` : String(v)),
      heat: 1,
    },
    { key: "adr", label: "ADR", title: "Average damage per round", w: STAT_W, get: (r) => r.s?.adr, fmt: (v) => Math.round(v), heat: 1 },
    { key: "kast", label: "KAST", title: "Rounds with a kill, assist, survival or trade", w: STAT_W, get: (r) => r.s?.kast, fmt: (v) => `${Math.round(v)}%`, heat: 1 },
    { key: "hs", label: "HS%", title: "Headshot kills", w: STAT_W, get: (r) => r.s?.hs, fmt: (v) => `${Math.round(v)}%`, heat: 1 },
  ];

  // Where each value sits between the match's lowest and highest, as -1 (worst) … 1 (best).
  function heatScales(rows) {
    const scales = {};
    for (const col of COLUMNS) {
      if (!col.heat) continue;
      const vals = rows.filter((r) => !r.p.didNotJoin).map(col.get).filter((v) => v != null && Number.isFinite(+v));
      if (vals.length < 2) continue;
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      if (max > min) scales[col.key] = (v) => col.heat * ((2 * (v - min)) / (max - min) - 1);
    }
    return scales;
  }

  function heatStyle(t) {
    if (t == null || !Number.isFinite(t)) return "";
    const a = (0.3 * Math.abs(t)).toFixed(3);
    return `background:${t >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})`};`;
  }

  // "Lifetime: K/D 1.21 · ADR 99 · 281 games", the tooltip on live rows (no demo details yet).
  function lifetimeText(p) {
    const l = p.lifetimeStats;
    if (!l?.gamesTracked) return "";
    return `Lifetime: K/D ${(l.kdRatio ?? 0).toFixed(2)} · ADR ${Math.round(l.adr ?? 0)} · ${num(l.gamesTracked)} games`;
  }

  function rowHtml(r, scales, mvp) {
    const { p } = r;
    const cells = COLUMNS.map((col) => {
      const v = col.get(r);
      const has = v != null && Number.isFinite(+v);
      const t = has && scales[col.key] && !p.didNotJoin ? scales[col.key](v) : null;
      return `<td class="px-0.5 py-1 text-center font-mono tabular-nums ${has ? "text-white/75" : "text-white/25"}" style="${heatStyle(t)}">${
        has ? escapeHtml(col.fmt ? col.fmt(+v) : v) : "–"
      }</td>`;
    }).join("");
    return `
      <tr class="border-t border-white/[0.04] ${p.didNotJoin ? "opacity-40" : ""}" title="${escapeHtml(r.s?.extra || lifetimeText(p))}">
        <td class="px-2.5 py-1">
          <div class="flex min-w-0 items-center gap-1.5">
            ${C() ? C().slotHtml(p.username) : ""}
            ${
              p.avatarUrl
                ? `<img src="${escapeHtml(p.avatarUrl)}" alt="" class="h-4 w-4 shrink-0 object-cover">`
                : `<span class="h-4 w-4 shrink-0 bg-white/[0.06]"></span>`
            }
            <a href="${profileLink(p.username)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(p.username)}'s profile"
               class="truncate text-white/80 hover:text-white hover:underline"
               ${p.flairNameColor ? `style="color:${escapeHtml(p.flairNameColor)}"` : ""}>${escapeHtml(p.username)}</a>
            <a href="${steamLink(p.steamId)}" target="_blank" rel="noopener noreferrer" data-steam="${escapeHtml(p.steamId)}"
               class="${STEAM_ID_CLASS} shrink-0 font-mono text-[10px] tabular-nums text-white/30 hover:text-white/70 hover:underline"
               title="${ID_TITLE}">(${escapeHtml(p.steamId)})</a>
            ${
              mvp
                ? `<span class="shrink-0 border border-primary/30 bg-primary/10 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-primary" title="Match MVP (top ADR)">MVP</span>`
                : ""
            }
            ${p.didNotJoin ? `<span class="shrink-0 border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/45">No show</span>` : ""}
          </div>
        </td>
        ${cells}
      </tr>`;
  }

  function sortRows(rows) {
    const col = COLUMNS.find((c) => c.key === sort.key) || COLUMNS[5];
    return [...rows].sort((a, b) => {
      const va = col.get(a);
      const vb = col.get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1; // blanks last either way
      if (vb == null) return -1;
      return sort.dir * (va - vb);
    });
  }

  // Team A / B accents, as on the site's own scoreboard.
  const ACCENT = { A: "#3b82f6", B: "#f59e0b" };

  function teamHtml(rows, side, name, score, won, scales, mvpId) {
    const joined = rows.filter((r) => !r.p.didNotJoin && r.s);
    const kills = joined.reduce((t, r) => t + (r.s.kills || 0), 0);
    const adrs = joined.map((r) => r.s.adr).filter((v) => v != null);
    const avgAdr = adrs.length ? Math.round(adrs.reduce((a, b) => a + b, 0) / adrs.length) : null;
    return `
      <div class="border border-white/[0.06] bg-black/25">
        <div class="flex items-center justify-between gap-2 border-b border-white/[0.06] px-2.5 py-1.5" style="box-shadow:inset 2px 0 0 ${ACCENT[side]}">
          <span class="ui-meta truncate text-white/60">${escapeHtml(name || `Team ${side}`)}</span>
          <span class="flex shrink-0 items-center gap-3">
            <span class="font-mono text-[10px] tabular-nums text-white/30">${kills} kills${avgAdr != null ? ` · avg ADR ${avgAdr}` : ""}</span>
            <span class="font-mono text-sm font-bold tabular-nums" style="color:${won ? "#22c55e" : "rgba(255,255,255,0.9)"}">${score ?? 0}</span>
          </span>
        </div>
        <table class="w-full table-fixed text-[11px]">
          <thead>
            <tr class="text-[9px] uppercase tracking-wider text-white/30">
              <th class="px-2.5 py-1 text-left font-bold">Player</th>
              ${COLUMNS.map((col) => {
                const active = col.key === sort.key;
                // The sort arrow hangs off the label's right edge, so the label itself stays centred over the numbers.
                return `<th data-sort="${col.key}" title="${escapeHtml(col.title)} (click to sort)" style="width:${col.w}px;cursor:pointer;user-select:none"
                  class="px-0.5 py-1 text-center font-bold ${active ? "text-primary" : "hover:text-white/60"}"><span class="relative">${col.label}${
                  active ? `<span class="absolute left-full top-1/2 -translate-y-1/2 pl-px text-[7px] leading-none">${sort.dir < 0 ? "▾" : "▴"}</span>` : ""
                }</span></th>`;
              }).join("")}
            </tr>
          </thead>
          <tbody>${sortRows(rows)
            .map((r) => rowHtml(r, scales, String(r.p.steamId) === mvpId))
            .join("")}</tbody>
        </table>
      </div>`;
  }

  const BUTTON =
    "border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white/45 transition-colors hover:text-white";

  // The card for one match: the finished scoreboard (live: false) or the live lineup (live: true), drawn the
  // same way. card.cip holds its data (null until loaded) and the site elements it hides.
  function render(card) {
    const { data, live } = card.cip;
    if (!data) {
      card.innerHTML = "";
      return;
    }
    card.className = live && view === "compact" ? M.CARD_CLASS : "";
    if (view === "site") {
      card.innerHTML = `<div class="flex justify-end"><button type="button" class="cip-mt-view ${BUTTON}" title="Switch back to the compact scoreboard">Compact view</button></div>`;
      return;
    }
    const { match, analysis } = data;
    const rounds = (match.teamAScore || 0) + (match.teamBScore || 0) || analysis?.rounds?.length || 0;
    const analysisById = new Map((analysis?.players || []).map((a) => [String(a.steam_id), a]));
    const toRows = (players) => (players || []).map((p) => ({ p, rating: p.rating, s: statsFor(p, analysisById, rounds) }));
    const a = toRows(match.teamA);
    const b = toRows(match.teamB);
    const scales = heatScales([...a, ...b]);
    const mvp = !live && [...a, ...b].filter((r) => r.s?.adr != null && !r.p.didNotJoin).sort((x, y) => y.s.adr - x.s.adr)[0];
    const mvpId = mvp ? String(mvp.p.steamId) : "";
    const done = String(match.status || "").toLowerCase() === "completed";
    const aScore = match.teamAScore ?? 0;
    const bScore = match.teamBScore ?? 0;
    const note = live
      ? "Live, refreshed every 15 s · shading compares each stat across the match: green above average, red below · KAST and the entry, clutch and utility details come with the demo once the match ends · hover a row for lifetime stats · click a header to sort."
      : "Shading compares each stat across the match: green above average, red below · hover a row for entry, clutch, multi-kill and utility · click a header to sort.";

    card.innerHTML = `
      <div class="grid gap-2.5" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,540px),1fr))">
        ${teamHtml(a, "A", match.teamAName, aScore, done && aScore > bScore, scales, mvpId)}
        ${teamHtml(b, "B", match.teamBName, bScore, done && bScore > aScore, scales, mvpId)}
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p class="font-mono text-[10px] leading-relaxed text-white/30">${note}</p>
        <button type="button" class="cip-mt-view ${BUTTON}" title="Show the site's own ${live ? "lineup" : "scoreboard"}">Full table</button>
      </div>`;
    C()?.fillFlags(card);
  }

  // Hides the site's own tables while the compact view is showing. Only once the data is in: until then
  // (or if it fails) the site's table stays.
  function applyView(card) {
    const hide = view === "compact" && !!card.cip.data;
    for (const el of card.cip.targets()) el.toggleAttribute("hidden", hide);
  }

  function show(card) {
    render(card);
    applyView(card);
  }

  const cards = new Set(); // the finished and live cards, re-drawn together when the view or sort changes

  function makeCard(id, live) {
    const card = document.createElement("div");
    card.id = live ? LINEUP_ID : CARD_ID;
    card.cip = { id, live, targets: () => [], data: null, json: "", fetchedAt: 0 };
    card.addEventListener("click", (e) => {
      const steam = e.target.closest(`.${STEAM_ID_CLASS}`)?.dataset.steam;
      if (steam) {
        window.open(mirrorLink(steam), "_blank", "noopener"); // the anchor itself opens steamcommunity.com
        return;
      }
      const th = e.target.closest("th[data-sort]");
      if (th) {
        const key = th.dataset.sort;
        sort = sort.key === key ? { key, dir: -sort.dir } : { key, dir: key === "deaths" ? 1 : -1 };
        cards.forEach(show);
        return;
      }
      if (e.target.closest(".cip-mt-view")) {
        view = view === "site" ? "compact" : "site";
        try {
          localStorage.setItem(VIEW_KEY, view);
        } catch {}
        cards.forEach(show);
      }
    });
    cards.add(card);
    return card;
  }

  function drop(card) {
    if (!card) return;
    card.remove();
    cards.delete(card);
  }

  let card = null;

  function update() {
    const m = location.pathname.match(MATCH_RE);
    const board = m && findBoard();
    if (!board || card?.cip.id !== m[1]) {
      drop(card);
      card = null;
    }
    if (!board) return;
    if (!card) {
      const c = (card = makeCard(m[1], false));
      load(c.cip.id).then(
        (data) => {
          c.cip.data = data;
          show(c);
        },
        () => {} // the site's own table stays
      );
    }
    if (board.firstElementChild !== card) board.insertBefore(card, board.firstElementChild); // React remounts move it
    const c = card;
    c.cip.targets = () => [...board.children].filter((el) => el !== c);
    applyView(c);
  }

  // ---------- live lineup ----------
  // Before a match finishes, the site shows a lineup instead of the scoreboard: rating, lifetime K/D and ADR
  // until the server goes live, then K / D / A / ADR from the match. It's swapped for the same compact
  // table as the finished scoreboard, in a panel like the page's own cards: K / D / A, +/–, ADR and HS%
  // from the live match stats (KAST and the row details need the demo, so they come once it's parsed),
  // blank before the server goes live, with each player's lifetime stats in the row tooltip.
  // Re-fetched every 15 s so the score and stats keep up.

  const LINEUP_ID = "cip-match-lineup";
  const LINEUP_REFRESH = 15 * 1000;
  const M = window.__cipMatchCard; // match-card.js, for the panel style

  // The site's lineup: the grid holding both teams' tables (the finished scoreboard has KAST, this doesn't).
  function findLineup() {
    for (const th of document.querySelectorAll("table thead th")) {
      if (th.textContent.trim() !== "ADR" || th.closest('[id^="cip-"]')) continue; // not the extension's own cards
      const grid = th.closest("div.grid");
      if (grid && ![...grid.querySelectorAll("th")].some((h) => h.textContent.trim() === "KAST")) return grid;
    }
    return null;
  }

  let lineup = null;

  function fetchLineup(c) {
    c.cip.fetchedAt = Date.now();
    getJson(`/api/match/${c.cip.id}`).then(
      (match) => {
        if (lineup !== c) return;
        const json = JSON.stringify(match);
        if (json === c.cip.json) return; // unchanged: keep the flags already filled in
        c.cip.json = json;
        c.cip.data = { match, analysis: null };
        show(c);
      },
      () => {} // the site's own lineup stays
    );
  }

  function updateLineup() {
    const m = location.pathname.match(MATCH_RE);
    const grid = m && findLineup();
    if (!grid || lineup?.cip.id !== m[1]) {
      drop(lineup);
      lineup = null;
    }
    if (!grid) return;
    lineup ??= makeCard(m[1], true);
    lineup.cip.targets = () => [grid];
    if (grid.previousElementSibling !== lineup) grid.parentElement.insertBefore(lineup, grid); // React remounts move it
    applyView(lineup);
    if (Date.now() - lineup.cip.fetchedAt > LINEUP_REFRESH) fetchLineup(lineup);
  }

  setInterval(() => lineup && updateLineup(), LINEUP_REFRESH);

  // ---------- tab strip ----------
  // The site's Scoreboard / Heatmaps / Replay strip is an overflow-x-auto tablist whose content is a pixel
  // taller than the strip, so Chrome draws both scrollbars (arrows and all) under and beside the tabs even
  // though nothing needs scrolling. It's marked with an attribute (React leaves unknown attributes alone)
  // and its scrollbars hidden; it can still be scrolled sideways by wheel or touch on a narrow screen.

  const TABS_ATTR = "data-cip-match-tabs";

  function fixTabs() {
    if (!MATCH_RE.test(location.pathname)) return;
    if (!document.getElementById("cip-match-tabs-style")) {
      const style = document.createElement("style");
      style.id = "cip-match-tabs-style";
      style.textContent = `
        [${TABS_ATTR}] { overflow-y: hidden !important; scrollbar-width: none; }
        [${TABS_ATTR}]::-webkit-scrollbar { display: none; }`;
      document.head.appendChild(style);
    }
    for (const list of document.querySelectorAll('[role="tablist"]:not([' + TABS_ATTR + "])")) {
      if ([...list.querySelectorAll('[role="tab"]')].some((t) => t.textContent.trim() === "Scoreboard")) list.setAttribute(TABS_ATTR, "");
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
      updateLineup();
      fixTabs();
    }, 100);
  }).observe(document.documentElement, { childList: true, subtree: true });

  update();
  updateLineup();
  fixTabs();
})();
