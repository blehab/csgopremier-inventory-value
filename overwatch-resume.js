// Keeps the watch progress you already earned on the Overwatch review page (/overwatch/review).
//
// The page reloads the clip whenever the window regains focus: the season-pass provider refreshes its
// progress on "focus", that replaces the user object, and the review page's effect depends on it, so it
// calls getNextClip() again. That sets its loading flag, which unmounts the player, and the fresh player
// starts at 0:00 with its "furthest second watched" back to zero — so alt-tabbing to answer a message
// costs you everything you had watched.
//
// This restores only what was genuinely watched, and never more:
//   - while the window is not focused the clip is PAUSED, so no progress accrues while you're away
//     (the site itself keeps playing in the background; this is deliberately stricter);
//   - the furthest second reached is remembered in memory, per clip, and put back after the reload,
//     capped at what was actually watched, and the clip is left paused where you left it.
// The site's own gate is untouched: it still unlocks voting only once playback reports 60 seconds.
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

  let state = null; // { key, watched, position } for the clip on screen
  let tracked = null; // the <video> element we've hooked up

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
      `${NOTICE_CLASS} pointer-events-none absolute left-1/2 top-4 z-[6] -translate-x-1/2 border border-secondary/30 ` +
      `bg-[rgba(13,13,18,0.92)] px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-secondary backdrop-blur-md ` +
      `transition-opacity duration-500`;
    chip.textContent = text;
    host.appendChild(chip);
    setTimeout(() => (chip.style.opacity = "0"), 2200);
    setTimeout(() => chip.remove(), 2800);
  }

  // The player holds the furthest second watched in a React state hook, right after the clip's duration.
  // Nothing is restored unless that hook is found and reads 0, i.e. the page really did reset it.
  function watchedHook(video) {
    let fiber = fiberOf(video);
    while (fiber && typeof fiber.type !== "function") fiber = fiber.return;
    if (!fiber || !Number.isFinite(video.duration)) return null;
    const hooks = [];
    for (let h = fiber.memoizedState; h; h = h.next) if (h.queue?.dispatch) hooks.push(h);
    const durationAt = hooks.findIndex((h) => typeof h.memoizedState === "number" && Math.abs(h.memoizedState - video.duration) < 0.5);
    const hook = durationAt >= 0 ? hooks[durationAt + 1] : null;
    return hook && hook.memoizedState === 0 ? hook : null;
  }

  // The fresh player only records the clip's duration once its metadata arrives, and that state is what
  // identifies the hook, so keep looking for a moment before giving up.
  function restore(video, attempt = 0) {
    if (!state || video !== document.querySelector("video")) return;
    const hook = watchedHook(video);
    if (!hook) {
      if (attempt < 40) setTimeout(() => restore(video, attempt + 1), 80);
      return;
    }
    const watched = Math.min(state.watched, video.duration);
    if (watched < 1) return;
    hook.queue.dispatch(watched);
    // The player clamps seeking to the furthest second watched, so let that render land first.
    setTimeout(() => {
      video.currentTime = Math.min(state.position, watched);
      notice(video, `Progress kept · ${fmt(watched)} watched`);
    }, 60);
  }

  function track(video, key) {
    tracked = video;
    if (!state || state.key !== key) state = { key, watched: 0, position: 0 }; // a different clip: start fresh
    video.addEventListener("timeupdate", () => {
      if (!state || state.key !== key) return;
      state.position = video.currentTime;
      if (video.currentTime > state.watched) state.watched = video.currentTime;
    });
  }

  function update() {
    if (!onReviewPage()) {
      state = tracked = null;
      return;
    }
    const video = document.querySelector("video");
    const key = clipKey(video);
    if (!video || !key || video === tracked) return; // same element: nothing was remounted

    const resuming = state && state.key === key && state.watched >= 1;
    track(video, key);
    if (!resuming) return;
    if (video.readyState >= 1) restore(video);
    else video.addEventListener("loadedmetadata", () => restore(video), { once: true });
  }

  // Leaving the window pauses the clip: time you spend in another app shouldn't count as watched.
  window.addEventListener("blur", () => {
    if (!onReviewPage()) return;
    const video = document.querySelector("video");
    if (video && !video.paused) video.pause();
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
