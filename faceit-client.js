// Page-world FACEIT client, shared through window.__cipFaceit by the compact match scoreboard
// (match-table.js) and the Overwatch review card (overwatch-info.js / match-card.js).
//
// Both of those run in the page's own world (manifest world:"MAIN"), where a fetch to api.faceit.com
// is blocked by CORS and the site's own API carries no FACEIT data. So a lookup by Steam id is posted
// on the page, faceit-bridge.js (a content script) relays it to the faceit-bg.js background worker,
// and the answer is posted back. Answers are cached per Steam id — including null for a player with no
// FACEIT account, so that id isn't asked again — and each id is requested only once unless its lookup
// fails, in which case it's retried on the next re-draw (see ensure). Presentation (the coloured level
// badge) lives here too, so both tables draw it the same way.
(() => {
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const cache = new Map(); // steamId -> { level, elo, nickname } | null  (null: looked up, no FACEIT account)
  const asked = new Set(); // Steam ids already requested, so each is looked up only once (until a miss)
  const pending = new Set(); // Steam ids whose lookup is in flight right now (not yet settled)
  const subscribers = new Set(); // { ids:Set, onReady } — callers waiting on ids another caller is fetching
  const waiters = new Map(); // reqId -> resolve
  let reqId = 0;
  let retry = 0; // caps the retries below so a persistent failure can't spin

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const res = e.data;
    if (res == null || res.__cipFaceitRes == null) return;
    const done = waiters.get(res.__cipFaceitRes);
    if (done) {
      waiters.delete(res.__cipFaceitRes);
      done(res.data || {});
    }
  });

  function request(ids) {
    return new Promise((resolve) => {
      const id = ++reqId;
      waiters.set(id, resolve);
      window.postMessage({ __cipFaceitReq: id, ids }, location.origin);
      setTimeout(() => {
        if (waiters.delete(id)) resolve({}); // no bridge, or no answer in time
      }, 8000);
    });
  }

  // Look up any Steam ids not asked for yet, then call onReady once their FACEIT data is in so the
  // caller can re-draw. The worker answers with each id's data, null for a player with no FACEIT
  // account, or nothing at all when the lookup failed (a cold service worker just after an extension
  // reload, or a network blip): those ids are dropped back out of "asked" and onReady is scheduled
  // again with a growing delay, so a re-draw retries them instead of leaving them stuck on "–".
  // Notify any borrowers whose awaited ids have all settled (found, no-account, or failed), then drop them.
  // Firing on failure too preserves the retry: the caller re-draws and re-requests the ids that missed.
  function notifySubscribers() {
    for (const sub of [...subscribers]) {
      if ([...sub.ids].some((id) => pending.has(id))) continue; // still waiting on at least one
      subscribers.delete(sub);
      sub.onReady?.();
    }
  }

  function ensure(steamIds, onReady) {
    const wanted = [...new Set((steamIds || []).map(String).filter(Boolean))];
    if (!wanted.length) return;
    const needed = wanted.filter((id) => !cache.has(id)); // what this caller still doesn't have
    if (!needed.length) return;
    const fresh = needed.filter((id) => !asked.has(id)); // ids nobody has requested yet
    // ids this caller needs that another caller is already fetching: subscribe so we're told when they land.
    const borrowed = needed.filter((id) => !fresh.includes(id) && pending.has(id));
    if (onReady && borrowed.length) subscribers.add({ ids: new Set(borrowed), onReady });
    if (!fresh.length) return; // nothing new to look up; a subscription (if any) will redraw us
    fresh.forEach((id) => {
      asked.add(id);
      pending.add(id);
    });
    request(fresh).then((data) => {
      let got = false;
      let missed = false;
      for (const id of fresh) {
        pending.delete(id);
        if (Object.prototype.hasOwnProperty.call(data, id)) {
          cache.set(id, data[id]); // found, or null for no FACEIT account — settled either way
          got = true;
        } else {
          asked.delete(id); // lookup failed: leave it unsettled so a later pass retries it
          missed = true;
        }
      }
      if (got) onReady?.();
      notifySubscribers(); // other consumers waiting on any of these ids
      if (missed && retry < 6) {
        retry++;
        setTimeout(() => onReady?.(), 2000 * retry); // re-draw → ensure retries the misses
      }
    });
  }

  // The cached FACEIT data for a Steam id, or undefined until its lookup has settled.
  const get = (steamId) => cache.get(String(steamId));

  // FACEIT's skill levels run 1 (grey) through 10 (red); its badges colour the number, so ours do too.
  const LEVEL_COLORS = {
    1: "#c0c0c0",
    2: "#2fd85e",
    3: "#2fd85e",
    4: "#f0c419",
    5: "#f0c419",
    6: "#f0c419",
    7: "#ff9d1e",
    8: "#ff9d1e",
    9: "#ff5e1e",
    10: "#ff2d2d",
  };
  const profileUrl = (nickname) => `https://www.faceit.com/en/players/${encodeURIComponent(nickname)}`;

  // The level as a badge of its level colour, linking to the player's FACEIT profile; "" when there's
  // no level yet (or no account), so the caller can render its own "–". Inline box styles (not Tailwind
  // arbitrary classes) so the badge renders regardless of the site's build.
  function badgeHtml(f) {
    const lvl = f?.level;
    if (lvl == null) return "";
    const c = LEVEL_COLORS[lvl] || "#c0c0c0";
    const badge = `<span class="font-mono text-[10px] font-bold tabular-nums"
        style="display:inline-block;min-width:16px;padding:1px 3px;border-radius:2px;line-height:1.15;color:${c};border:1px solid ${c}66;background:${c}1f">${lvl}</span>`;
    return f.nickname
      ? `<a href="${escapeHtml(profileUrl(f.nickname))}" target="_blank" rel="noopener noreferrer" title="FACEIT level ${lvl} · ${escapeHtml(f.nickname)} on FACEIT">${badge}</a>`
      : `<span title="FACEIT level ${lvl}">${badge}</span>`;
  }

  window.__cipFaceit = { ensure, get, LEVEL_COLORS, profileUrl, badgeHtml };
})();
