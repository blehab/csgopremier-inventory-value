// Shows the Upgrader's winning range on a full circle, laid out exactly like the dial
// the upgrade is revealed on, and lets you drag the window around that circle.
//
// The site previews the odds on a semicircle (0 → 1 running left → top → right) with a
// flat 0–100 slider under it, but reveals the roll on a full dial where 0 sits at
// 12 o'clock and values run clockwise (needle angle = roll × 360°). This hides the
// semicircle and the flat bar and draws a ring with the reveal dial's geometry
// instead. The site's own range input stays mounted (hidden) and is driven through
// its React onChange, so the chosen range is exactly what the site submits.
(() => {
  const RING_CLASS = "cip-upgrader-ring";
  const CYAN = "#36F8F8"; // the reveal dial's win colour
  const TRACK = "#63323d"; // and its lose colour
  const SVG_NS = "http://www.w3.org/2000/svg";
  const R = 84; // ring radius, same as the reveal dial
  const CIRC = 2 * Math.PI * R;

  const polar = (r, frac) => {
    const a = frac * 2 * Math.PI - Math.PI / 2; // 0 at the top, clockwise
    return [100 + r * Math.cos(a), 100 + r * Math.sin(a)];
  };

  const el = (tag, attrs = {}) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  function buildRing() {
    const svg = el("svg", { viewBox: "0 0 200 200", class: RING_CLASS });
    Object.assign(svg.style, { width: "100%", display: "block", overflow: "visible", touchAction: "none" });
    svg.append(
      el("circle", { cx: 100, cy: 100, r: 96, fill: "#0a0f17", stroke: "#788796", "stroke-opacity": 0.2, "stroke-width": 0.75 }),
      el("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: TRACK, "stroke-width": 12 })
    );
    const arc = el("circle", { cx: 100, cy: 100, r: R, fill: "none", stroke: CYAN, "stroke-width": 12, "data-part": "arc" });
    arc.style.filter = `drop-shadow(0 0 5px ${CYAN}aa)`;
    svg.append(arc);

    // 60 ticks like the reveal dial, every 5th one longer
    for (let i = 0; i < 60; i++) {
      const major = i % 5 === 0;
      const [x1, y1] = polar(major ? 66 : 70, i / 60);
      const [x2, y2] = polar(73, i / 60);
      svg.append(el("line", { x1, y1, x2, y2, stroke: "#bdcbd9", "stroke-opacity": major ? 0.5 : 0.16, "stroke-width": major ? 1 : 0.6 }));
    }
    // quarter labels on the outside of the ring
    for (const q of [0, 25, 50, 75]) {
      const [x, y] = polar(R + 12 + (q === 0 || q === 50 ? 1 : 3), q / 100);
      const t = el("text", { x, y, fill: "#fff", "fill-opacity": 0.4, "font-size": 8, "text-anchor": "middle", "dominant-baseline": "central" });
      t.textContent = q === 0 ? "0 / 100" : String(q);
      svg.append(t);
    }
    // handle at the centre of the winning window
    svg.append(el("circle", { r: 7, fill: "#0a0f17", stroke: CYAN, "stroke-width": 2.5, "data-part": "handle" }));
    return svg;
  }

  function paint(svg, lower, width, interactive) {
    const arc = svg.querySelector('[data-part="arc"]');
    arc.style.display = width > 0 ? "" : "none";
    arc.setAttribute("stroke-dasharray", `${width * CIRC} ${CIRC}`);
    arc.setAttribute("transform", `rotate(${-90 + 360 * lower} 100 100)`);
    const handle = svg.querySelector('[data-part="handle"]');
    handle.style.display = interactive && width > 0 ? "" : "none";
    const [hx, hy] = polar(R, lower + width / 2);
    handle.setAttribute("cx", hx);
    handle.setAttribute("cy", hy);
    svg.style.cursor = interactive ? "pointer" : "";
  }

  // Win window as {lower, width}, read from the site's range input when it is mounted
  // (exact), otherwise from the semicircle's cyan arc (drawn from 180 + 180·lower to
  // 180 + 180·upper degrees).
  function readWindow(input, gauge) {
    if (input) {
      const chance = Number(input.min) / 50;
      return { lower: Math.max(0, Number(input.value) / 100 - chance / 2), width: chance };
    }
    const d = gauge.querySelector("path[style*='drop-shadow']")?.getAttribute("d");
    const nums = d?.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number);
    if (!nums || nums.length < 9) return { lower: 0, width: 0 };
    const deg = (x, y) => ((Math.atan2(y - 100, x - 100) * 180) / Math.PI + 360) % 360;
    let a1 = deg(nums[0], nums[1]);
    if (a1 < 90) a1 += 360; // the arc starts somewhere on 180°–360°
    let a2 = deg(nums[7], nums[8]);
    while (a2 < a1) a2 += 360;
    return { lower: (a1 - 180) / 180, width: (a2 - a1) / 180 };
  }

  // React tracks the input's value, so it has to be set through the native setter
  // for the synthetic onChange to fire.
  const setNative = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  function setCenter(input, center) {
    const min = Number(input.min), max = Number(input.max);
    const v = Math.min(max, Math.max(min, center * 100));
    setNative.call(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let current = null; // {svg, input} of the mounted ring

  function wire(svg) {
    const fracAt = (e) => {
      const b = svg.getBoundingClientRect();
      const x = e.clientX - (b.left + b.width / 2), y = e.clientY - (b.top + b.height / 2);
      return ((Math.atan2(y, x) + Math.PI / 2) / (2 * Math.PI) + 1) % 1;
    };
    let dragging = false;
    svg.addEventListener("pointerdown", (e) => {
      if (!current?.input) return;
      dragging = true;
      svg.setPointerCapture(e.pointerId);
      setCenter(current.input, fracAt(e));
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => dragging && current?.input && setCenter(current.input, fracAt(e)));
    const stop = () => (dragging = false);
    svg.addEventListener("pointerup", stop);
    svg.addEventListener("pointercancel", stop);
    svg.addEventListener("keydown", (e) => {
      const input = current?.input;
      if (!input) return;
      const center = Number(input.value) / 100;
      const step = e.shiftKey ? 0.05 : 0.005;
      const next = {
        ArrowRight: center + step, ArrowUp: center + step,
        ArrowLeft: center - step, ArrowDown: center - step,
        Home: 0, End: 1,
      }[e.key];
      if (next === undefined) return;
      setCenter(input, next);
      e.preventDefault();
    });
  }

  function update() {
    const gauge = document.querySelector('svg[viewBox="0 0 200 116"]');
    const input = document.querySelector('input[type="range"][aria-label="Winning range center"]');

    // Flat bar and 0–25–50–75–100 scale above the slider: the ring replaces them.
    const block = input?.closest(".space-y-3");
    if (block) {
      for (const child of block.children) {
        if (child.matches("div.relative.h-5, div.flex.justify-between.text-xs") && child.style.display !== "none") {
          child.style.display = "none";
        }
      }
      let inputWrap = input;
      while (inputWrap.parentElement !== block) inputWrap = inputWrap.parentElement;
      if (inputWrap.style.display !== "none") inputWrap.style.display = "none";
    }

    if (!gauge) {
      current = null;
      return;
    }
    const box = gauge.parentElement;
    let svg = box.querySelector(`:scope > svg.${RING_CLASS}`);
    if (!svg) {
      svg = buildRing();
      wire(svg);
      box.insertBefore(svg, gauge);
      box.style.maxWidth = "240px";
      // centre the site's "56.1% ×1.71" readout inside the ring
      const readout = box.querySelector(":scope > div.absolute");
      if (readout) Object.assign(readout.style, { top: "0", bottom: "0" });
    }
    if (gauge.style.display !== "none") gauge.style.display = "none";

    current = { svg, input };
    const { lower, width } = readWindow(input, gauge);
    paint(svg, lower, width, !!input);
    if (input) {
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("role", "slider");
      svg.setAttribute("aria-label", "Winning range center");
      svg.setAttribute("aria-valuemin", input.min);
      svg.setAttribute("aria-valuemax", input.max);
      svg.setAttribute("aria-valuenow", input.value);
      svg.setAttribute("aria-valuetext", input.getAttribute("aria-valuetext") || "");
    } else {
      for (const a of ["tabindex", "role", "aria-label", "aria-valuemin", "aria-valuemax", "aria-valuenow", "aria-valuetext"]) {
        svg.removeAttribute(a);
      }
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["value", "d", "min"] });
})();
