// On a profile's match-history page (/<user>/matches), marks each listed match that contained a cheater — a
// player who currently holds a ban whose reason mentions cheating — with a red border and red glow, and lets a
// middle-click (or Ctrl/Cmd-click) on a row open that match in a new tab (the row's own left-click already
// opens it in place).
//
// The match list (/api/users/<user>/matches?page=<n>) carries no roster or ban info, so the work is split and
// cached for the session: the set of banned cheaters is read once from the public ban list (/api/bans, every
// page, any ban whose reason contains "cheat"); each listed match's roster is fetched once (/api/match/<id>)
// and a match is flagged when any of its players is in that set. Rows are matched to the list API by position,
// verified against each row's map image. Roster lookups run with a small concurrency cap.
(() => {
  const MATCHES_RE = /^\/([^/]+)\/matches\/?$/; // /<username>/matches
  const ROW_ATTR = "data-cip-game"; // the match id we stamp on each row
  const HILITE = "cip-cheater-match";

  function getJson(url) {
    return fetch(url, { credentials: "include" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
  }

  const isCheatReason = (s) => String(s || "").toLowerCase().includes("cheat");

  // ---------- caches ----------

  // Every currently-banned cheater's username (lower-cased), read once from the public ban list. On failure
  // the promise is dropped so the next draw retries.
  let cheaterSetPromise = null;
  function getCheaterSet() {
    if (!cheaterSetPromise) {
      cheaterSetPromise = (async () => {
        const set = new Set();
        const add = (d) =>
          (d?.banned_players || []).forEach((b) => {
            if (b?.username && isCheatReason(b.ban_reason)) set.add(String(b.username).toLowerCase());
          });
        const first = await getJson("/api/bans?page=1");
        add(first);
        const pages = Math.min(Number(first?.total_pages) || 1, 50); // guard against a runaway count
        for (let p = 2; p <= pages; p++) {
          try {
            add(await getJson(`/api/bans?page=${p}`));
          } catch {
            /* skip a page that fails; the rest of the set still works */
          }
        }
        return set;
      })().catch((e) => {
        cheaterSetPromise = null;
        throw e;
      });
    }
    return cheaterSetPromise;
  }

  const listCache = new Map(); // "<user>|<page>" → Promise of the page's games (in order)
  function getGames(user, page) {
    const key = `${user}|${page}`;
    if (!listCache.has(key)) {
      listCache.set(
        key,
        getJson(`/api/users/${encodeURIComponent(user)}/matches?page=${encodeURIComponent(page)}`).then(
          (d) => d?.games || [],
          (e) => {
            listCache.delete(key);
            throw e;
          }
        )
      );
    }
    return listCache.get(key);
  }

  const matchResult = new Map(); // gameId → [cheater usernames] once resolved (sync access for painting)
  const matchCache = new Map(); // gameId → Promise, so a lookup in flight isn't started twice
  function resolveMatch(gameId) {
    if (matchResult.has(gameId)) return Promise.resolve(matchResult.get(gameId));
    if (!matchCache.has(gameId)) {
      matchCache.set(
        gameId,
        (async () => {
          const [m, set] = await Promise.all([getJson(`/api/match/${gameId}`), getCheaterSet()]);
          const players = [...(m?.teamA || []), ...(m?.teamB || [])];
          const cheaters = players.filter((p) => set.has(String(p.username).toLowerCase())).map((p) => p.username);
          matchResult.set(gameId, cheaters);
          return cheaters;
        })().catch((e) => {
          matchCache.delete(gameId);
          throw e;
        })
      );
    }
    return matchCache.get(gameId);
  }

  async function pool(items, n, fn) {
    let i = 0;
    const run = async () => {
      while (i < items.length) await fn(items[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  }

  // ---------- highlight ----------

  function ensureStyle() {
    if (document.getElementById("cip-cheater-style")) return;
    const style = document.createElement("style");
    style.id = "cip-cheater-style";
    style.textContent = `
      tr.${HILITE} {
        outline: 1.5px solid rgba(248,113,113,0.95);
        outline-offset: -1.5px;
        box-shadow: 0 0 16px 2px rgba(239,68,68,0.55);
        background: rgba(239,68,68,0.08) !important;
      }`;
    document.head.appendChild(style);
  }

  function mapOf(row) {
    const img = row.querySelector('img[src*="/maps/"]');
    return img ? (img.getAttribute("src").match(/maps\/([^.?/]+)/) || [])[1]?.toLowerCase() : null;
  }

  // The matches table: the one whose header has these columns (not a stats table).
  function findTable() {
    for (const table of document.querySelectorAll("table")) {
      const hs = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim().toLowerCase());
      if (hs.includes("result") && hs.includes("map") && hs.includes("score") && hs.includes("date")) return table;
    }
    return null;
  }

  // Apply (or clear) the highlight on every row we've already resolved. Idempotent, so it's safe to re-run on
  // each DOM change after React re-renders the table.
  function paint() {
    const table = findTable();
    const tbody = table?.tBodies[0];
    if (!tbody) return;
    for (const row of tbody.rows) {
      const id = Number(row.getAttribute(ROW_ATTR));
      if (!id || !matchResult.has(id)) continue;
      const cheaters = matchResult.get(id);
      row.classList.toggle(HILITE, cheaters.length > 0);
      if (cheaters.length && row.getAttribute("data-cip-cheater-title") !== "1") {
        row.setAttribute("title", `Cheater in this match: ${cheaters.join(", ")}`);
        row.setAttribute("data-cip-cheater-title", "1");
      }
    }
  }

  async function process() {
    const m = location.pathname.match(MATCHES_RE);
    if (!m) return;
    ensureStyle();
    const table = findTable();
    const tbody = table?.tBodies[0];
    const rows = tbody ? [...tbody.rows] : [];
    if (!rows.length) return;
    const page = new URLSearchParams(location.search).get("page") || "1";
    let games;
    try {
      games = await getGames(m[1], page);
    } catch {
      return; // the list didn't load; leave the table as the site drew it
    }
    // Map each row to its game by position, but only trust it when the row's map matches — if the two ever
    // fall out of step, that row is left unstamped rather than mislabeled.
    rows.forEach((row, i) => {
      const g = games[i];
      const rowMap = mapOf(row);
      if (g && g.gameId && (!rowMap || !g.map || rowMap === String(g.map).toLowerCase())) {
        row.setAttribute(ROW_ATTR, String(g.gameId));
      } else {
        row.removeAttribute(ROW_ATTR);
      }
    });
    paint();
    const ids = [...new Set(rows.map((r) => Number(r.getAttribute(ROW_ATTR))).filter(Boolean))];
    await pool(
      ids.filter((id) => !matchResult.has(id)),
      4,
      async (id) => {
        try {
          await resolveMatch(id);
        } catch {
          /* a match that fails to load just stays unmarked */
        }
        paint();
      }
    );
  }

  // ---------- middle / modifier click → open in a new tab ----------
  // The row's own left-click opens the match in place; these add a new-tab open without disturbing that.
  const rowGame = (e) => e.target?.closest?.(`tr[${ROW_ATTR}]`)?.getAttribute(ROW_ATTR);
  const openMatch = (id) => window.open(`/match/${encodeURIComponent(id)}`, "_blank", "noopener");

  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 1 && rowGame(e)) e.preventDefault(); // stop the middle-click auto-scroll circle
    },
    true
  );
  document.addEventListener(
    "auxclick",
    (e) => {
      if (e.button !== 1) return;
      const id = rowGame(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      openMatch(id);
    },
    true
  );
  document.addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
      const id = rowGame(e);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation(); // take over so the site doesn't also navigate in place
      openMatch(id);
    },
    true
  );

  // ---------- run ----------
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      process();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });

  process();
})();
