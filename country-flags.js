// Country flags as images, for the match scoreboard (match-table.js) and the Overwatch card
// (overwatch-info.js), shared through window.__cipCountry.
//
// The site draws countries as flag emoji, which Windows doesn't render (it shows the two letters), so
// these are small PNGs from flagcdn.com instead. A player's country is only on their profile
// (/api/users/<username> → user.CountryCode), so it's looked up once per player and remembered in
// localStorage for a week; players without one get an empty placeholder of the same size, which keeps
// the names lined up.
//
// countryFor(username) → Promise of "SI" / "" (not set or lookup failed)
// flagHtml(code)       → <img> markup, 16×12
//
// The site's own flag emoji (profile pages: <span role="img" aria-label="Serbia">🇨🇸</span>) get the same
// image put in front of them, with the emoji text hidden. Some codes the site uses are retired ones that
// flagcdn doesn't have (Serbia is "CS"), so those go through CODE_ALIASES first.
(() => {
  const STORAGE_KEY = "cip-country-cache";
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const CODE_ALIASES = { CS: "RS", YU: "RS", UK: "GB", EL: "GR", TP: "TL", ZR: "CD" };
  const canonical = (code) => CODE_ALIASES[code] || code;

  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {}
  const pending = new Map(); // username → Promise, so a scoreboard's lookups are made once

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {}
  }

  function countryFor(username) {
    const key = String(username || "").toLowerCase();
    if (!key) return Promise.resolve("");
    const hit = stored[key];
    if (hit && Date.now() - hit.t < TTL) return Promise.resolve(hit.c);
    if (!pending.has(key)) {
      pending.set(
        key,
        fetch(`/api/users/${encodeURIComponent(username)}`, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((d) => {
            const code = String(d?.user?.CountryCode || "").trim().toUpperCase();
            stored[key] = { c: /^[A-Z]{2}$/.test(code) ? code : "", t: Date.now() };
            save();
            return stored[key].c;
          })
          .catch(() => "") // not cached, so the next scoreboard tries again
          .finally(() => pending.delete(key))
      );
    }
    return pending.get(key);
  }

  let names = null;
  function countryName(code) {
    try {
      names ??= new Intl.DisplayNames(["en"], { type: "region" });
      return names.of(code) || code;
    } catch {
      return code;
    }
  }

  // Inline sizes and styles, so it doesn't depend on which utility classes the site's CSS happens to have.
  const BOX = "display:inline-block;flex-shrink:0;width:16px;height:12px;vertical-align:middle;";
  function flagHtml(code, title) {
    code = canonical(code);
    if (!/^[A-Z]{2}$/.test(code || ""))
      return `<span class="cip-flag" style="${BOX}border:1px dashed rgba(255,255,255,0.12)" title="Country not set"></span>`;
    const cc = code.toLowerCase();
    const name = (title || countryName(code)).replace(/"/g, "&quot;");
    return (
      `<img class="cip-flag" src="https://flagcdn.com/w20/${cc}.png" srcset="https://flagcdn.com/w40/${cc}.png 2x" ` +
      `alt="${code}" title="${name}" loading="lazy" style="${BOX}object-fit:cover;box-shadow:0 0 0 1px rgba(255,255,255,0.08)">`
    );
  }

  // A same-sized slot to put in a row; fillFlags() swaps in the flag once the country is known.
  const escapeAttr = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const slotHtml = (username) =>
    `<span class="cip-flag-slot" data-user="${escapeAttr(username)}" style="${BOX}background:rgba(255,255,255,0.04)"></span>`;

  function fillFlags(root) {
    for (const slot of root.querySelectorAll(".cip-flag-slot[data-user]")) {
      const user = slot.dataset.user;
      slot.removeAttribute("data-user");
      countryFor(user).then((code) => {
        if (slot.isConnected) slot.outerHTML = flagHtml(code);
      });
    }
  }

  // A flag emoji is two regional-indicator letters (U+1F1E6 = "A"); anything else isn't a flag.
  function emojiCode(text) {
    const cps = Array.from(String(text || "").trim(), (c) => c.codePointAt(0));
    if (cps.length !== 2 || !cps.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)) return "";
    return String.fromCharCode(cps[0] - 0x1f1e6 + 65, cps[1] - 0x1f1e6 + 65);
  }

  // The emoji span stays React's (its text node is left alone, so React can still update it); the image
  // is added inside it and font-size:0 hides the letters Windows would show.
  const style = document.createElement("style");
  style.textContent = `[data-cip-emoji-flag]{font-size:0!important;line-height:0!important}`;
  document.head.appendChild(style);

  function replaceEmojiFlags() {
    for (const span of document.querySelectorAll('span[role="img"]')) {
      const text = Array.from(span.childNodes, (n) => (n.nodeType === 3 ? n.nodeValue : "")).join("");
      const code = emojiCode(text);
      if ((span.dataset.cipEmojiFlag || "") === code) continue;
      span.querySelector(":scope > .cip-flag")?.remove();
      if (!code) {
        delete span.dataset.cipEmojiFlag;
        continue;
      }
      span.dataset.cipEmojiFlag = code;
      span.insertAdjacentHTML("afterbegin", flagHtml(code, span.getAttribute("aria-label")));
    }
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      replaceEmojiFlags();
    });
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
  replaceEmojiFlags();

  window.__cipCountry = { countryFor, countryName, flagHtml, slotHtml, fillFlags };
})();
