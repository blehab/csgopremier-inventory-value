// Keeps the watch progress you already earned on the Overwatch review page (/overwatch/review).
//
// The page reloads the clip whenever the window regains focus: the season-pass provider refreshes its
// progress on "focus", that replaces the user object, and the review page's effect depends on it, so it
// calls getNextClip() again. That sets its loading flag, which unmounts the player, and the fresh player
// starts at 0:00 with its "furthest second watched" back to zero — so alt-tabbing to answer a message
// costs you everything you had watched.
//
// This restores only what was genuinely watched, and never more:
//   - the player tracks watch *coverage* as an array of [start, end] intervals (jumping ahead doesn't
//     count; the green parts of its timeline are these intervals), and the vote gate opens once the
//     covered seconds reach min(180, duration). We mirror that intervals array in memory, per clip,
//     and put it back into the fresh player after a reload, so the coverage — and the vote gate — carry
//     over instead of resetting to zero. The clip is left paused where you were.
// The site's own gate is untouched: it still computes eligibility from those intervals itself; we only
// hand the fresh player the coverage the old one already had.
//
// Runs in the page's MAIN world, because the player's progress lives in React state.
(() => {
  const NOTICE_CLASS = "cip-ow-notice";
  // .../overwatch-clips/22036_76561199415992629.mp4?<signature> — the signature changes on every reload,
  // the path identifies the clip.
  const CLIP_RE = /\/overwatch-clips\/\d+_\d{17}\.[a-z0-9]+/i;

  const onReviewPage = () => location.pathname.startsWith("/overwatch/review");
  const clipKey = (video) => ((video && (video.currentSrc || video.src)) || "").match(CLIP_RE)?.[0] || null;
  const fiberOf = (el) => el && el[Object.keys(el).find((k) => k.startsWith("__reactFiber"))];

  let state = null; // { key, intervals: [[s,e],...], position, index } for the clip on screen
  let tracked = null; // the <video> element we've hooked up
  let trackedKey = null; // the clip key that element was hooked up for
  let trackedListener = null; // its timeupdate handler, so it can be removed when the element is rebound

  // Stop the reload itself.
  //
  // Coming back to the window (and the websocket reconnecting) makes the season-pass provider refresh its
  // progress and call useAuthStore().updateSeasonPassXP() unconditionally, even when the XP is identical.
  // That hands out a new user object, the review page's effect depends on it, so it calls getNextClip()
  // again, and its loading flag unmounts the player: the clip restarts at 0:00 whether or not it was ever
  // played. When the XP really is unchanged there is nothing to write, so that refresh is dropped here and
  // the site's own handler ignores the rejection (it catches and discards errors). A real XP change is
  // passed through untouched, and only this page is affected.
  const PROGRESS_PATH = "/api/season-pass/progress";
  let lastProgress = null;
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url || "";
    if (!onReviewPage() || !url.includes(PROGRESS_PATH)) return nativeFetch.apply(this, arguments);
    return nativeFetch.apply(this, arguments).then(async (res) => {
      let stamp = null;
      try {
        const data = await res.clone().json();
        stamp = JSON.stringify([data.totalXp, data.level, data.nextLevelXp]);
      } catch {
        return res; // not the payload we know: leave it alone
      }
      if (stamp === lastProgress) throw new Error("cip: season-pass XP unchanged, refresh dropped");
      lastProgress = stamp;
      return res;
    });
  };

  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // A short-lived chip over the player, in the site's style.
  function notice(video, text) {
    const host = video.closest("div.group.relative") || video.parentElement;
    if (!host) return;
    host.querySelector(`.${NOTICE_CLASS}`)?.remove();
    const chip = document.createElement("div");
    chip.className =
      `${NOTICE_CLASS} pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 border border-secondary/30 ` +
      `bg-[rgba(13,13,18,0.92)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-secondary backdrop-blur-md ` +
      `transition-opacity duration-500`;
    chip.style.zIndex = "6"; // inline: the site's stylesheet has no z-[6]
    chip.textContent = text;
    host.appendChild(chip);
    setTimeout(() => (chip.style.opacity = "0"), 2200);
    setTimeout(() => chip.remove(), 2800);
  }

  // The player's useState hooks, in order, for the component that owns this <video>.
  function playerHooks(video) {
    let fiber = fiberOf(video);
    while (fiber && typeof fiber.type !== "function") fiber = fiber.return;
    if (!fiber) return null;
    const hooks = [];
    for (let h = fiber.memoizedState; h; h = h.next) hooks.push(h);
    return hooks;
  }

  // A coverage-intervals state: an array of [start, end] number pairs (empty in a fresh player). Empty
  // arrays are ambiguous, so we identify the real one only when it's non-empty (see readCoverage), then
  // restore into the hook at that same index — hook order is identical across instances of one component.
  const isIntervals = (v) =>
    Array.isArray(v) && v.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "number" && typeof x[1] === "number");
  const coveredSeconds = (intervals) => intervals.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0);

  // The player's current coverage intervals (a copy) and the index of the hook that holds them, or null
  // until the player has recorded at least one interval.
  function readCoverage(video) {
    const hooks = playerHooks(video);
    if (!hooks) return null;
    const index = hooks.findIndex((h) => h.queue?.dispatch && isIntervals(h.memoizedState) && h.memoizedState.length);
    if (index < 0) return null;
    return { index, intervals: hooks[index].memoizedState.map((p) => p.slice()) };
  }

  // Put the remembered coverage back into the fresh player. Only when it really reset (the intervals hook
  // at the same index is present, is an intervals array, and is currently empty) — never overwrite coverage
  // the new player already has, and bail rather than dispatch into a hook that isn't the one we expected.
  function restore(video, attempt = 0) {
    // Recheck the clip before a deferred restore lands: the element may have moved on to another clip.
    if (!state || video !== document.querySelector("video") || clipKey(video) !== state.key) return;
    if (!state.intervals.length || state.index == null) return;
    const hooks = playerHooks(video);
    const hook = hooks && hooks[state.index];
    if (!hooks || !Number.isFinite(video.duration) || !hook?.queue?.dispatch || !isIntervals(hook.memoizedState)) {
      if (attempt < 40) setTimeout(() => restore(video, attempt + 1), 80);
      return;
    }
    if (hook.memoizedState.length) return; // the player already has coverage; leave it alone
    const dur = video.duration;
    const intervals = state.intervals
      .map(([s, e]) => [Math.max(0, Math.min(s, dur)), Math.max(0, Math.min(e, dur))])
      .filter(([s, e]) => e - s > 0.05);
    if (!intervals.length) return;
    hook.queue.dispatch(intervals);
    // Let that render land, then seek back to where you left off.
    setTimeout(() => {
      video.currentTime = Math.min(state.position, dur);
      notice(video, `Progress kept · ${fmt(coveredSeconds(intervals))} watched`);
    }, 60);
  }

  function track(video, key) {
    // Rebinding (same element, new clip): drop the old handler so it can't keep writing to the new clip's state.
    if (tracked && trackedListener) tracked.removeEventListener("timeupdate", trackedListener);
    tracked = video;
    trackedKey = key;
    if (!state || state.key !== key) state = { key, intervals: [], position: 0, index: null }; // different clip: start fresh
    trackedListener = () => {
      if (!state || state.key !== key) return;
      state.position = video.currentTime;
      // Mirror the player's own coverage intervals as they grow, so a remount can be handed them back.
      const cov = readCoverage(video);
      if (cov) {
        state.intervals = cov.intervals;
        state.index = cov.index;
      }
    };
    video.addEventListener("timeupdate", trackedListener);
  }

  function update() {
    if (!onReviewPage()) {
      state = tracked = trackedKey = trackedListener = null;
      return;
    }
    const video = document.querySelector("video");
    const key = clipKey(video);
    if (!video || !key) return;
    // Nothing to do only when it's the same element AND the same clip. A reused element that swapped clips
    // (the signature-only URL change keeps the same key) must re-track, or its progress lands on the old clip.
    if (video === tracked && key === trackedKey) return;

    const resuming = state && state.key === key && state.intervals.length > 0;
    track(video, key);
    if (!resuming) return;
    if (video.readyState >= 1) restore(video);
    else video.addEventListener("loadedmetadata", () => restore(video), { once: true });
  }

  // Leaving the window pauses the clip: time you spend in another app shouldn't count as watched.
  window.addEventListener("blur", () => {
    if (!onReviewPage()) return;
    const video = document.querySelector("video");
    //if (video && !video.paused) video.pause();
  });

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 100);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });

  update();
})();
