// Season Pass page (/season-pass): scrolls the "Reward track" so the current level sits in the middle,
// instead of opening on Level 1 with the rest of the 200-odd levels off to the right.
//
// The track is one horizontal scroller (overflow-x-auto) holding a card per level. The site marks the
// level to look at in its accent colour (text-tertiary, "Current or available" in the legend): the first
// unclaimed reward you've reached, or else the level you're working towards. Claimed levels are
// text-quaternary. If no card is marked (every level claimed), the last claimed one is used.
//
// The progress can arrive after the cards first render, so the track keeps being re-centred while the
// target changes, until the user scrolls it themselves or a few seconds have passed.
(() => {
  const SETTLE_MS = 8000;

  let track = null; // the scroller we last centred
  let startedAt = 0;
  let lastTarget = null;
  let userMoved = false;

  function findTrack() {
    const heading = [...document.querySelectorAll("h2")].find((h) => /^reward track$/i.test(h.textContent.trim()));
    // The panel isn't a <section>: climb from the heading to the first box that holds the scroller.
    for (let el = heading?.parentElement, d = 0; el && d < 6; el = el.parentElement, d++) {
      const scroller = el.querySelector(".overflow-x-auto");
      if (scroller) return scroller;
    }
    return null;
  }

  function targetCard(scroller) {
    const cards = [...(scroller.firstElementChild?.children || [])];
    const label = (c) => c.querySelector("article p");
    return (
      cards.find((c) => label(c)?.classList.contains("text-tertiary")) ||
      cards.findLast((c) => label(c)?.classList.contains("text-quaternary")) ||
      null
    );
  }

  function centre(scroller, card) {
    const s = scroller.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    scroller.scrollLeft += c.left + c.width / 2 - (s.left + s.width / 2);
  }

  function update() {
    if (!location.pathname.startsWith("/season-pass")) {
      track = null;
      return;
    }
    const scroller = findTrack();
    if (!scroller) return;
    if (scroller !== track) {
      track = scroller;
      startedAt = Date.now();
      lastTarget = null;
      userMoved = false;
      const stop = () => (userMoved = true);
      for (const ev of ["wheel", "pointerdown", "touchstart", "keydown"]) {
        scroller.addEventListener(ev, stop, { passive: true });
      }
    }
    if (userMoved || Date.now() - startedAt > SETTLE_MS) return;
    const card = targetCard(scroller);
    if (!card || card === lastTarget) return;
    lastTarget = card;
    centre(scroller, card);
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });

  update();
})();
