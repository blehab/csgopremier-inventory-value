// Extra filters for the Market (/market), in the Filters sidebar under "Float range":
//   Pattern ID: pattern seeds and ranges, e.g. "661", "661, 670", "100-120";
//   Rare items: "Low float only", "High float only", "Rare pattern", using the same rules as the badges
//   (badges-core.js): a float in the lowest / highest 1% of the skin's range, and a blue gem, Fade 95%+
//   or notable Crimson Web seed. Low and High together mean either one; everything else combines.
//
// The server's listing endpoint (GET /api/market/items) can't filter on any of these, so while one is set
// we answer the Market's listing requests ourselves: we page through the server's results for the same
// filters (search, wear, category, rarity, price, float, sort), 100 at a time, keep the listings that
// match, and return them as one page ({ items, total }). The site's own grid, count and buy buttons then
// show just the matches. A scan stops after SCAN_CAP listings; the note under the filters says when it
// did, and a search (e.g. "AK-47 | Case Hardened") or a category narrows it to a few requests.
//
// Offsets: the Market asks for the next page at offset = listings loaded so far, until that reaches
// `total`. We return every match at offset 0 with total = number of matches, so it never asks for more.
//
// Scans are kept per request key (the Market's filters + ours). Starting a scan for a new key stops the
// scans for other keys (you've typed on or cleared the search, and the Market cancelled those requests),
// and a scan is reused for SCAN_TTL_MS, longer than the Market's 30 s refresh. The note shows the scan for
// the query the grid is showing right now, which can come from the Market's cache without any request.
//
// Runs in the page's MAIN world: it wraps window.fetch and uses the page's React Query client.
(() => {
  const PATTERN_CLASS = "cip-pattern-filter";
  const RARE_CLASS = "cip-rare-filter";
  const PAGE_SIZE = 100; // the server's maximum
  const SCAN_CAP = 2000;
  const SCAN_TTL_MS = 60000;
  const REQUEST_GAP_MS = 120; // be gentle between scan requests

  const TOGGLES = [
    { key: "low", label: "Low float only", color: "#ffd700" },
    { key: "high", label: "High float only", color: "#ffd700" },
    {
      key: "rare",
      label: "Rare pattern or phase",
      title: "Blue gems, Fades, Crimson Webs and other notable seeds, plus Ruby, Sapphire, Black Pearl and Emerald",
      color: "#3b9dff",
    },
  ];

  let patternText = "";
  let ranges = []; // [[from, to], ...]
  const toggles = { low: false, high: false, rare: false };
  const scans = new Map(); // key → { key, at, matches, scanned, total, capped, scanning, promise, controller }

  const B = () => window.__cipBadges;
  const active = () => ranges.length > 0 || toggles.low || toggles.high || toggles.rare;

  function parsePattern(text) {
    const out = [];
    for (const part of text.split(/[\s,;]+/)) {
      const m = part.match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
      if (!m) continue;
      const a = Number(m[1]);
      const b = m[2] != null ? Number(m[2]) : a;
      out.push([Math.min(a, b), Math.max(a, b)]);
    }
    return out;
  }

  function matches(item) {
    const seed = item.paint_seed;
    if (ranges.length && !(typeof seed === "number" && ranges.some(([a, b]) => seed >= a && seed <= b))) return false;
    if (toggles.low || toggles.high) {
      const label = B()?.floatBadge(item, item.skin)?.label || "";
      if (!((toggles.low && label.startsWith("Low")) || (toggles.high && label.startsWith("High")))) return false;
    }
    if (toggles.rare) {
      // Memorable seeds (#69 and so on) aren't rare patterns.
      const pattern = (B()?.patternBadges(item, item.skin) || []).some((b) => b.kind !== "memorable");
      // Ruby, Sapphire, Black Pearl and Emerald: a one-off finish rather than a seed, but the same idea.
      const gemPhase = B()?.phaseBadge(item, item.skin)?.gem === true;
      if (!pattern && !gemPhase) return false;
    }
    return true;
  }

  // ---------- fetch interception ----------

  const realFetch = window.fetch.bind(window);

  // Not tied to any one request's abort signal: the Market cancels and re-sends the same request while
  // you type, and the re-sent one reuses this scan (see waitFor below). It stops when a scan for another
  // key starts (signal).
  async function scan(params, signal) {
    const found = [];
    let scanned = 0;
    let total = Infinity;
    for (let offset = 0; offset < total && scanned < SCAN_CAP; offset += PAGE_SIZE) {
      if (offset > 0) await new Promise((r) => setTimeout(r, REQUEST_GAP_MS));
      const qs = new URLSearchParams(params);
      qs.set("limit", String(PAGE_SIZE));
      qs.set("offset", String(offset));
      const res = await realFetch(`/api/market/items?${qs}`, { credentials: "include", signal });
      if (!res.ok) throw new Error(`GET /api/market/items → ${res.status}`);
      const page = await res.json();
      total = page.total ?? 0;
      const items = page.items || [];
      scanned += items.length;
      for (const item of items) if (matches(item)) found.push(item);
      if (!items.length) break;
    }
    return { matches: found, scanned, total: Number.isFinite(total) ? total : scanned, capped: scanned < total };
  }

  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
    const method = (init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
    if (!active() || method !== "GET" || !url) return realFetch(input, init);
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin || u.pathname !== "/api/market/items") return realFetch(input, init);

    const params = new URLSearchParams(u.search);
    const offset = Number(params.get("offset") || 0);
    const key = scanKey(params);

    return (async () => {
      if (offset > 0) return jsonResponse({ items: [], total: scans.get(key)?.matches.length ?? 0 });
      const entry = getScan(key, params);
      const result = await waitFor(entry.promise, init?.signal);
      return jsonResponse({ items: result.matches, total: result.matches.length });
    })();
  };

  // The Market's filters (without paging) plus ours.
  function scanKey(params) {
    const p = new URLSearchParams(params);
    p.delete("offset");
    p.delete("limit");
    p.sort();
    return `${ranges.map((r) => r.join("-")).join(",")}|${toggles.low}${toggles.high}${toggles.rare}|${p}`;
  }

  function getScan(key, params) {
    const now = Date.now();
    const existing = scans.get(key);
    if (existing && (existing.scanning || now - existing.at < SCAN_TTL_MS)) return existing;

    // Stop the scans for other keys, and forget old results.
    for (const [k, e] of scans) {
      if (e.scanning) e.controller.abort();
      if (e.scanning || now - e.at >= SCAN_TTL_MS) scans.delete(k);
    }
    const scanParams = new URLSearchParams(params);
    scanParams.delete("offset");
    scanParams.delete("limit");
    const entry = { key, at: now, matches: [], scanned: 0, total: 0, capped: false, scanning: true, controller: new AbortController() };
    entry.promise = scan(scanParams, entry.controller.signal).then(
      (result) => {
        Object.assign(entry, result, { scanning: false, at: Date.now() });
        renderNotes();
        return entry;
      },
      (e) => {
        if (scans.get(key) === entry) scans.delete(key);
        renderNotes();
        throw e;
      }
    );
    entry.promise.catch(() => {}); // a stopped scan isn't an unhandled error
    scans.set(key, entry);
    renderNotes();
    return entry;
  }

  // Waits for a scan, but gives up (like a real fetch) if this particular request is cancelled.
  function waitFor(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  const jsonResponse = (data) =>
    new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

  // ---------- refetching ----------

  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  function findQueryClient() {
    const start = document.querySelector("aside") || document.querySelector("main") || document.body.firstElementChild;
    for (let f = fiberOf(start), d = 0; f && d < 300; f = f.return, d++) {
      const p = f.memoizedProps;
      if (p?.client?.getQueryCache) return p.client;
      if (p?.value?.getQueryCache) return p.value;
    }
    return null;
  }

  // After a filter change: drop the Market's cached results for other searches (they were built for the
  // old filters and would show again when you go back to that search), and reload the one on screen
  // (it goes through the wrapper above).
  function refetch() {
    const client = findQueryClient();
    if (!client) return;
    client.removeQueries({ queryKey: ["market-stock"], type: "inactive" });
    client.invalidateQueries({ queryKey: ["market-stock"] });
  }

  // Key of the query the grid is showing now. queryKey is ["market-stock", daily, params, …]; the Market's
  // API client puts every param that isn't null/undefined in the URL, then adds offset.
  function displayedKey() {
    const q = findQueryClient()?.getQueryCache().findAll({ queryKey: ["market-stock"], type: "active" })[0];
    const params = q?.queryKey?.[2];
    if (!params || typeof params !== "object") return null;
    return scanKey(new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)));
  }

  // Keep the note in step when the Market switches queries without a request (from its cache).
  let subscribed = null;
  function subscribeToQueries() {
    const client = findQueryClient();
    if (!client || subscribed === client) return;
    subscribed = client;
    let pending = false;
    client.getQueryCache().subscribe(() => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        stopHiddenScans();
        renderNotes();
      }, 50);
    });
  }

  // A scan for a search that's no longer on screen (you cleared or changed it, and the Market went back to
  // a cached list without asking again) has nobody left to show it to, so stop it.
  function stopHiddenScans() {
    const shown = displayedKey();
    if (!shown) return;
    for (const [k, e] of scans) {
      if (e.scanning && k !== shown) {
        e.controller.abort();
        scans.delete(k);
      }
    }
  }

  // ---------- UI ----------

  function noteText(entry) {
    if (!active() || !entry) return "";
    if (entry.scanning) return "Scanning listings…";
    const n = entry.matches.length;
    const found = `${n} ${n === 1 ? "match" : "matches"} in ${entry.scanned.toLocaleString("en-US")} listings.`;
    return entry.capped
      ? `${found} Stopped after the first ${SCAN_CAP.toLocaleString("en-US")} of ${entry.total.toLocaleString("en-US")}: search a skin or pick a category to scan them all.`
      : found;
  }

  function renderNotes() {
    const notes = document.querySelectorAll(`.${RARE_CLASS} .cip-note`);
    if (!notes.length) return;
    const key = active() ? displayedKey() : null;
    const entry = key ? scans.get(key) : null;
    const text = noteText(entry);
    const warn = !!entry?.capped && !entry.scanning;
    for (const note of notes) {
      if (note.textContent !== text) note.textContent = text;
      note.hidden = !text;
      note.style.color = warn ? "rgb(250, 204, 21)" : "";
    }
  }

  function renderToggles() {
    for (const btn of document.querySelectorAll(`.${RARE_CLASS} button[data-toggle]`)) {
      const on = toggles[btn.dataset.toggle];
      if (btn.getAttribute("aria-pressed") === String(on)) continue;
      btn.setAttribute("aria-pressed", String(on));
      btn.querySelector(".cip-check").style.display = on ? "" : "none";
      btn.style.borderColor = on ? `${btn.dataset.color}99` : "";
      btn.style.backgroundColor = on ? `${btn.dataset.color}14` : "";
    }
  }

  function setFilters({ text = patternText, low = toggles.low, high = toggles.high, rare = toggles.rare } = {}, { refresh = true } = {}) {
    const next = parsePattern(text);
    const changed =
      JSON.stringify(next) !== JSON.stringify(ranges) || low !== toggles.low || high !== toggles.high || rare !== toggles.rare;
    patternText = text;
    ranges = next;
    Object.assign(toggles, { low, high, rare });
    for (const input of document.querySelectorAll(`.${PATTERN_CLASS} input`)) {
      if (input.value !== text && document.activeElement !== input) input.value = text;
    }
    renderToggles();
    renderNotes();
    if (changed && refresh) refetch();
  }

  // Same markup as the "Float range" fieldset and its number inputs.
  function createPatternSection() {
    const fs = document.createElement("fieldset");
    fs.className = `${PATTERN_CLASS} space-y-2`;
    fs.innerHTML = `
      <legend class="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">Pattern</legend>
      <label class="font-medium flex items-center justify-between gap-3 text-xs text-white/60">
        <span>Pattern ID</span>
        <div class="relative group w-32 shrink-0">
          <input type="text" inputmode="numeric" autocomplete="off" spellcheck="false" placeholder="Any" aria-label="Pattern ID"
            class="flex w-full px-3 py-2 text-sm transition-all placeholder:text-white/30 focus:outline-none bg-black/30 text-white border border-white/10 hover:border-white/20 focus:border-secondary/50 h-8 text-right font-mono">
          <div class="absolute top-0 right-0 w-2 h-2 border-t border-r border-white/20 pointer-events-none"></div>
          <div class="absolute bottom-0 left-0 w-2 h-2 border-b border-l border-white/20 pointer-events-none"></div>
        </div>
      </label>
      <p class="text-[11px] leading-4 text-white/40">Seeds or ranges, e.g. 661, 670 or 100-120.</p>`;
    const input = fs.querySelector("input");
    input.value = patternText;
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => setFilters({ text: input.value }), 400);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(timer);
        setFilters({ text: input.value });
      }
    });
    return fs;
  }

  // lucide "check", as on the site's selected Rarity options
  const checkIcon = (color) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="cip-check ml-auto h-3.5 w-3.5 shrink-0" ` +
    `style="color:${color};display:none" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`;

  // Same markup as the "Rarity" option buttons (coloured dot, label, check when selected).
  function createRareSection() {
    const fs = document.createElement("fieldset");
    fs.className = `${RARE_CLASS} space-y-1.5`;
    fs.innerHTML =
      `<legend class="mb-3 text-xs font-semibold uppercase tracking-wider text-white/50">Rare items</legend>` +
      TOGGLES.map(
        (t) => `
        <button type="button" data-toggle="${t.key}" data-color="${t.color}" aria-pressed="false"${t.title ? ` title="${t.title}"` : ""}
          class="relative inline-flex items-center whitespace-nowrap transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background bg-white/5 border border-white/10 text-white/70 hover:bg-white/10 hover:text-white py-1.5 h-9 w-full min-w-0 justify-start gap-2.5 px-3 text-xs font-medium normal-case tracking-normal group/btn overflow-hidden">
          <span class="size-1.5 shrink-0 rounded-full" style="background-color:${t.color}"></span>
          <span class="min-w-0 truncate" style="color:${t.color}">${t.label}</span>
          ${checkIcon(t.color)}
          <div class="absolute top-0 left-0 w-1.5 h-1.5 border-t border-l transition-colors border-white/20 group-hover/btn:border-white/40"></div>
          <div class="absolute bottom-0 right-0 w-1.5 h-1.5 border-b border-r transition-colors border-white/20 group-hover/btn:border-white/40"></div>
        </button>`
      ).join("") +
      `<p class="cip-note pt-1 text-[11px] leading-4 text-white/40" hidden></p>`;
    for (const btn of fs.querySelectorAll("button[data-toggle]")) {
      btn.addEventListener("click", () => setFilters({ [btn.dataset.toggle]: !toggles[btn.dataset.toggle] }));
    }
    return fs;
  }

  // The Filters list can exist twice (desktop sidebar and the mobile filter sheet).
  function inject() {
    for (const legend of document.querySelectorAll("fieldset > legend")) {
      if (legend.textContent.trim() !== "Float range") continue;
      const floatSection = legend.parentElement;
      let pattern = floatSection.nextElementSibling;
      if (!pattern?.classList.contains(PATTERN_CLASS)) {
        pattern = createPatternSection();
        floatSection.insertAdjacentElement("afterend", pattern);
      }
      if (!pattern.nextElementSibling?.classList.contains(RARE_CLASS)) {
        pattern.insertAdjacentElement("afterend", createRareSection());
        renderToggles();
        renderNotes();
      }
    }
  }

  // The site's "Reset" (top of the Filters list) clears these too.
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest?.("button");
      if (btn && btn.textContent.trim() === "Reset" && btn.closest("aside, [role='dialog']") && active()) {
        setFilters({ text: "", low: false, high: false, rare: false });
      }
    },
    true
  );

  function update() {
    if (!location.pathname.startsWith("/market")) {
      // Don't carry a hidden filter to the next visit.
      if (active()) setFilters({ text: "", low: false, high: false, rare: false }, { refresh: false });
      return;
    }
    inject();
    subscribeToQueries();
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });

  update();
})();
