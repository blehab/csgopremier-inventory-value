// Background service worker: looks up FACEIT skill level and elo by Steam id for the match scoreboard.
//
// match-table.js runs in the page's own world (manifest world:"MAIN"), where a fetch to FACEIT is
// blocked by CORS, and the site's own API carries no FACEIT data at all. So the compact scoreboard
// asks faceit-bridge.js (a normal content script), which relays the match's Steam ids here; with
// host_permissions for api.faceit.com this worker can read FACEIT's public users endpoint free of
// the CORS limit.
//
// api.faceit.com/users/v1/users?game=cs2&game_id=<steamid64> returns
//   { result: "OK", payload: [ { nickname, games: { cs2: { skill_level, faceit_elo }, csgo: {…} } } ] }
// (and just { result: "OK" }, no payload, for a Steam id with no FACEIT account). cs2 is used, csgo
// is the fallback for players who never played cs2 on FACEIT. Results — including "no account", so it
// isn't asked again — are cached in memory and de-duplicated, so a lobby of ten is at most ten
// requests until the worker restarts; a network error is left uncached so it can be retried.

const CACHE = new Map(); // steamId -> { level, elo, nickname } | null  (null: looked up, no FACEIT account)
const PENDING = new Map(); // steamId -> Promise, so concurrent asks for the same id share one request

async function lookup(steamId) {
  if (CACHE.has(steamId)) return CACHE.get(steamId);
  if (PENDING.has(steamId)) return PENDING.get(steamId);
  const p = (async () => {
    const r = await fetch(`https://api.faceit.com/users/v1/users?game=cs2&game_id=${encodeURIComponent(steamId)}`, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const u = Array.isArray(j?.payload) ? j.payload[0] : j?.payload;
    if (!u) return null; // no FACEIT account for this Steam id
    const g = u.games?.cs2 || u.games?.csgo || null;
    return { level: g?.skill_level ?? null, elo: g?.faceit_elo ?? null, nickname: u.nickname || null };
  })();
  PENDING.set(steamId, p);
  try {
    const res = await p;
    CACHE.set(steamId, res); // caches the answer, including a null "no account"
    return res;
  } catch {
    return undefined; // network/HTTP error: leave uncached (the page shows "–" and can retry later)
  } finally {
    PENDING.delete(steamId);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "cip-faceit" || !Array.isArray(msg.ids)) return;
  Promise.all(msg.ids.map((id) => lookup(String(id)).then((v) => ({ id: String(id), v }))))
    .then((results) => {
      // A found id maps to its data, a "no FACEIT account" id to null; an id whose lookup errored
      // is left out entirely (v === undefined), so the page keeps it pending and retries it later.
      const data = {};
      for (const { id, v } of results) if (v !== undefined) data[id] = v;
      sendResponse({ ok: true, data });
    })
    .catch(() => sendResponse({ ok: false }));
  return true; // keep the message channel open for the async reply
});
