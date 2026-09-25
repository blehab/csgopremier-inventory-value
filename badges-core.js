// Float and pattern badges: which items get one, and the badge markup.
// Shared by card-badges.js (inventory cards, case reveal) and multi-open.js (results grid)
// through window.__cipBadges. Needs pattern-data.js to be loaded first.
//
// badgesFor(item, skin) → [{ kind, label, title, color, ... }, ...]
//   kind: "float" | "bluegem" (+ tier "T1"/"T2") | "fade" (+ pct) | "pattern" | "memorable" | "phase"
//   item: { float_value, paint_seed }   skin: { name, weapon_name, min_float, max_float, phase }
//   Badges marked plain: true are information rather than a find (a numbered Doppler phase), so they
//   don't give the card a coloured border or glow.
(() => {
  const COLORS = {
    gold: "#ffd700", // top tier (rarity "Extraordinary" colour)
    purple: "#d32ce6", // second tier ("Classified")
    pink: "#f60864", // site primary, memorable seeds
    blueGem: "#3b9dff",
    lowFloat: "#22d3ee",
    highFloat: "#f59e0b",
    ruby: "#e0244a",
    sapphire: "#2a6fdb",
    blackPearl: "#8fa3b8",
    emerald: "#2ad17a",
    doppler: "#a78bfa", // numbered Doppler phases
    gammaDoppler: "#5cd18a", // numbered Gamma Doppler phases
  };

  // ---------- Doppler phases ----------
  // The site stores the phase on the skin (skin.phase), taken from the paint index: Doppler 415 Ruby,
  // 416 Sapphire, 417 Black Pearl, 418-421 Phase 1-4; Gamma Doppler 568-571 Phase 1-4, 572 Emerald.
  // The one-off finishes are a find in their own right and get the card's border; a numbered phase is
  // just which of the four you got, so it's shown but stays plain.
  const GEM_PHASES = {
    ruby: COLORS.ruby,
    sapphire: COLORS.sapphire,
    "black pearl": COLORS.blackPearl,
    emerald: COLORS.emerald,
    "fire & ice": COLORS.gold,
    "fire and ice": COLORS.gold,
  };

  function phaseBadge(item, skin) {
    const phase = typeof skin?.phase === "string" ? skin.phase.trim() : "";
    if (!phase) return null;
    const gemColor = GEM_PHASES[phase.toLowerCase()];
    const kit = skin.paint_kit != null ? ` · paint index ${skin.paint_kit}` : "";
    if (gemColor) {
      return { kind: "phase", gem: true, label: phase, title: `${phase} — the rarest finish of this skin${kit}`, color: gemColor };
    }
    if (!/^phase\s*\d/i.test(phase)) return null; // anything else the site stores is left alone
    const gamma = /gamma/i.test(skin.name || "");
    return {
      kind: "phase",
      plain: true,
      label: phase,
      title: `${gamma ? "Gamma Doppler" : "Doppler"} ${phase}${kit}`,
      color: gamma ? COLORS.gammaDoppler : COLORS.doppler,
    };
  }

  // ---------- Fade percentage ----------
  // Port of FadeCalculator from csgo-fade-percentage-calculator 2.0.0
  // (https://github.com/chescos/csgo-fade-percentage-calculator), used under the MIT License:
  //
  //   MIT License
  //   Copyright (c) 2022 chescos
  //   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
  //   associated documentation files (the "Software"), to deal in the Software without restriction,
  //   including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense,
  //   and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
  //   subject to the following conditions: The above copyright notice and this permission notice shall be
  //   included in all copies or substantial portions of the Software.
  //   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
  //   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
  //   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
  //   WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
  //   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  //
  // Valve's pattern RNG turns the seed into an x offset and a rotation; the best raw value is 100%,
  // the worst 80%.
  function createRng(seed) {
    const NTAB = 32, IA = 16807, IM = 2147483647, IQ = 127773, IR = 2836;
    const NDIV = 1 + (IM - 1) / NTAB, AM = 1.0 / IM, RNMX = 1.0 - 1.2e-7;
    let idum = seed >= 0 ? -seed : seed;
    let iy = 0;
    const iv = [];
    const next = () => {
      let k, j;
      if (idum <= 0 || iy === 0) {
        idum = -idum < 1 ? 1 : -idum;
        for (j = NTAB + 7; j >= 0; j -= 1) {
          k = Math.floor(idum / IQ);
          idum = Math.floor(IA * (idum - k * IQ) - IR * k);
          if (idum < 0) idum += IM;
          if (j < NTAB) iv[j] = idum;
        }
        [iy] = iv;
      }
      k = Math.floor(idum / IQ);
      idum = Math.floor(IA * (idum - k * IQ) - IR * k);
      if (idum < 0) idum += IM;
      j = Math.floor(iy / NDIV);
      iy = Math.floor(iv[j]);
      iv[j] = idum;
      return iy;
    };
    return (low, high) => Math.min(AM * next(), RNMX) * (high - low) + low;
  }

  const FADE_WEAPONS = [
    "AWP", "Bayonet", "Bowie Knife", "Butterfly Knife", "Classic Knife", "Falchion Knife", "Flip Knife", "Glock-18",
    "Gut Knife", "Huntsman Knife", "Karambit", "Kukri Knife", "M4A1-S", "M9 Bayonet", "MAC-10", "MP7", "Navaja Knife",
    "Nomad Knife", "Paracord Knife", "R8 Revolver", "Shadow Daggers", "Skeleton Knife", "Stiletto Knife",
    "Survival Knife", "Talon Knife", "UMP-45", "Ursus Knife",
  ];
  const FADE_REVERSED = ["AWP", "Karambit", "MP7", "Talon Knife"];
  const FADE_CONFIGS = {
    default: { x: [-0.7, -0.7], y: [-0.7, -0.7], rotate: [-55, -65] },
    MP7: { x: [-0.9, -0.3], y: [-0.7, -0.5], rotate: [-55, -65] },
    "M4A1-S": { x: [-0.14, 0.05], y: [0, 0], rotate: [-45, -45] },
  };
  const fadeCache = new Map();

  // Fade percentage (80–100) for every seed 0–1000 of a weapon, or null if the weapon has no Fade.
  function fadeTable(weapon) {
    if (!FADE_WEAPONS.includes(weapon)) return null;
    if (fadeCache.has(weapon)) return fadeCache.get(weapon);
    const c = FADE_CONFIGS[weapon] || FADE_CONFIGS.default;
    const usesRotation = c.rotate[0] !== c.rotate[1];
    const usesX = c.x[0] !== c.x[1];
    const raw = [];
    for (let seed = 0; seed <= 1000; seed += 1) {
      const rand = createRng(seed);
      const x = rand(c.x[0], c.x[1]);
      rand(c.y[0], c.y[1]);
      const rotation = rand(c.rotate[0], c.rotate[1]);
      raw.push(usesRotation && usesX ? rotation * x : usesRotation ? rotation : x);
    }
    const reversed = FADE_REVERSED.includes(weapon);
    const best = reversed ? Math.min(...raw) : Math.max(...raw);
    const worst = reversed ? Math.max(...raw) : Math.min(...raw);
    const table = raw.map((r) => 80 + ((worst - r) / (worst - best)) * 20);
    fadeCache.set(weapon, table);
    return table;
  }

  const fadePercent = (weapon, seed) => fadeTable(weapon)?.[seed] ?? null;

  // Fade colours (yellow → pink → purple) for a Fade %. The higher the %, the more of the gradient is
  // yellow/pink and the stronger the glow, so a 100% fade glows brightest.
  function fadeStyle(pct) {
    const t = Math.min(Math.max((pct - 90) / 10, 0), 1); // 90% → 0, 100% → 1
    const pinkAt = Math.round(35 + 25 * t); // where the pink sits in the gradient
    return {
      gradient: `linear-gradient(90deg, #ffd24d 0%, #ff8a5c ${Math.round(pinkAt / 2)}%, #ff4fa3 ${pinkAt}%, #8b5cf6 100%)`,
      glow: `rgba(255, 79, 163, ${(0.3 + 0.4 * t).toFixed(2)})`,
      glowSize: Math.round(10 + 12 * t),
    };
  }

  // lucide "gem"
  const GEM_ICON =
    `<svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" fill-opacity=".25" ` +
    `stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0">` +
    `<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>`;

  // ---------- badges ----------

  function floatBadge(item, skin) {
    const f = item?.float_value;
    const min = skin?.min_float;
    const max = skin?.max_float;
    if (typeof f !== "number" || typeof min !== "number" || typeof max !== "number" || max <= min) return null;
    const rel = (f - min) / (max - min);
    const range = `${min.toFixed(2)}–${max.toFixed(2)}`;
    if (rel <= 0.01) {
      const tier = f < 0.001 ? " · 0.000x" : f < 0.01 ? " · 0.00x" : "";
      return {
        kind: "float",
        label: `Low float${tier}`,
        title: `Float ${f.toFixed(6)}: in the lowest ${Math.max(rel * 100, 0.01).toFixed(2)}% of this skin's ${range} range`,
        color: COLORS.lowFloat,
      };
    }
    if (rel >= 0.99) {
      const tier = f >= 0.999 ? " · 0.999+" : f >= 0.99 ? " · 0.99+" : "";
      return {
        kind: "float",
        label: `High float${tier}`,
        title: `Float ${f.toFixed(6)}: in the highest ${Math.max((1 - rel) * 100, 0.01).toFixed(2)}% of this skin's ${range} range`,
        color: COLORS.highFloat,
      };
    }
    return null;
  }

  function patternBadges(item, skin) {
    const seed = item?.paint_seed;
    const data = window.__cipPatternData;
    if (typeof seed !== "number" || !skin?.name || !data) return [];
    const finish = skin.name.split(" | ")[1]?.trim();
    const weapon = skin.weapon_name;
    const out = [];

    if (finish === "Case Hardened" && data.caseHardened[weapon]) {
      const { t1, t2 } = data.caseHardened[weapon];
      // Shown as a gem icon plus the tier; the seed is only in the tooltip.
      const tier = t1.includes(seed) ? "T1" : t2.includes(seed) ? "T2" : null;
      if (tier) {
        out.push({
          kind: "bluegem",
          tier,
          label: tier,
          title: `Blue gem, Tier ${tier[1]}: pattern #${seed} on the ${weapon} (csgoskins.gg)`,
          color: COLORS.blueGem,
        });
      }
    }

    if (finish === "Fade") {
      const pct = fadePercent(weapon, seed);
      if (pct !== null && pct >= 95) {
        const full = pct.toFixed(1) === "100.0";
        out.push({
          kind: "fade",
          pct,
          label: full ? "Full Fade · 100%" : `Fade ${pct.toFixed(1)}%`,
          title: `Fade ${pct.toFixed(2)}% for seed #${seed} (80% = least faded, 100% = full fade)`,
          color: "#ff4fa3", // the gradient's pink, as a hex colour for places that add their own opacity
        });
      }
    }

    if (finish === "Crimson Web" && data.crimsonWeb[weapon]) {
      const hit = data.crimsonWeb[weapon].find(([seeds]) => seeds.includes(seed));
      if (hit) out.push({ kind: "pattern", label: `${hit[1]} · #${seed}`, title: `Notable Crimson Web seed for the ${weapon}`, color: hit[2] === 1 ? COLORS.gold : COLORS.purple });
    }

    // Only when no other pattern badge shows (a blue gem, for one, shows no seed number).
    if (data.memorable.includes(seed) && !out.length) {
      out.push({ kind: "memorable", label: `#${seed}`, title: `Memorable pattern seed #${seed}`, color: COLORS.pink });
    }
    return out;
  }

  const badgesFor = (item, skin) => [phaseBadge(item, skin), floatBadge(item, skin), ...patternBadges(item, skin)].filter(Boolean);

  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Small square chips like the site's "FREE" / CT / T tags. Colours are inline so they don't depend
  // on which Tailwind classes the site's CSS happens to include.
  function badgeHtml(badges) {
    const base = "font-size:9px;line-height:14px;padding:0 4px;letter-spacing:.04em;";
    const cls = "cip-badge inline-flex shrink-0 items-center gap-1 whitespace-nowrap border font-bold uppercase tabular-nums";
    return badges
      .map((b) => {
        const title = `title="${escapeHtml(b.title)}"`;
        if (b.kind === "fade") {
          // Gradient outline (border-box layer) behind a dark fill (padding-box layer), gradient text.
          const f = fadeStyle(b.pct);
          return (
            `<span class="${cls}" ${title} style="${base}border-color:transparent;` +
            `background:linear-gradient(rgba(13,13,18,.9),rgba(13,13,18,.9)) padding-box,${f.gradient} border-box;` +
            `box-shadow:0 0 ${Math.round(f.glowSize / 2)}px ${f.glow}">` +
            `<span style="background:${f.gradient};-webkit-background-clip:text;background-clip:text;color:transparent">` +
            `${escapeHtml(b.label)}</span></span>`
          );
        }
        const icon = b.kind === "bluegem" ? GEM_ICON : "";
        return (
          `<span class="${cls}" ${title} style="${base}color:${b.color};border-color:${b.color}66;background:${b.color}1f">` +
          `${icon}${escapeHtml(b.label)}</span>`
        );
      })
      .join("");
  }

  // The colour of the best badge in a list (fade > Ruby/Sapphire/… > blue gem > gold > purple > others),
  // for highlighting a card. Plain badges never highlight anything.
  function topColor(badges) {
    const rank = (b) => ({ fade: 0, phase: 1, bluegem: 2 })[b.kind] ?? [COLORS.gold, COLORS.purple, COLORS.pink, COLORS.lowFloat, COLORS.highFloat].indexOf(b.color) + 3;
    return [...badges].filter((b) => !b.plain).sort((a, b) => rank(a) - rank(b))[0]?.color || null;
  }

  window.__cipBadges = { badgesFor, floatBadge, patternBadges, phaseBadge, fadePercent, fadeStyle, badgeHtml, topColor, COLORS };
})();
