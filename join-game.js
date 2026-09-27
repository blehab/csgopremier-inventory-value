// A "Join game" button on match pages (/match/<id>), beside the site's "Copy connect" and "Team voice",
// and an "Auto-join" switch that presses it for you when the join timer gets down to a time you set.
//
// Once the server is up (the "Server ready" card before the match, and the live summary during it) the
// site only offers to copy "connect <ip>:<port>" for the game console. This adds a link to
// steam://run/4465480//+connect <ip>:<port>, which has Steam start the site's CS:GO (its own Steam app,
// 4465480, not CS2's 730) with that command, the same as pasting it. steam://connect/ isn't used: it
// picks the game from the app id the server reports, and CS:GO servers report 730, which opens CS2.
// The site's command has no password, so neither does the link.
// Chrome and Brave ask before a site opens Steam; setup.ps1 (run by update.bat) pre-approves csgopremier.com.
//
// Auto-join: a slim bar under the "Server ready" card's buttons, like the Auto-accept one on the Play
// page: a switch and the time left on the join timer ("mm:ss") at which to connect (remembered in
// localStorage, off by default, 01:00). The same two settings are also a card in the site's Settings
// panel (the gear icon in the left sidebar), next to "Auto-accept Lobby Invites"; either one changes both. The card's timer counts down to the match's joinDeadline, so
// this does too; when what's left reaches the set time, the match is fetched once more and, if it is
// still waiting for players, the same steam:// link is opened. If you open the page with less time left
// than that, it connects straight away. Once per match: after it has fired, or you pressed "Join game"
// or "Copy connect" yourself, it leaves that match alone (the site doesn't say who is already on the
// server, so that's how it knows). It runs off a small Web Worker ticking twice a second, since Chrome
// slows a background tab's own timers down to once a minute and the join would come late.
//
// Data: serverIp / serverPort / status / joinDeadline from /api/match/<id>, the fields the site builds its
// command and its timer from, refetched every 10 s while the page shows a server.
// The button copies the look of the site's "Copy connect" next to it.
(() => {
  const BTN_CLASS = "cip-join-game";
  const BAR_ID = "cip-auto-join";
  const CARD_ID = "cip-auto-join-setting";
  const SETTINGS_KEY = "cip-auto-join"; // { on, secs }
  const DONE_KEY = "cip-auto-join-done"; // the last match id joined (or copied) for
  const MATCH_RE = /^\/match\/(\d+)\/?$/;
  const RETRY = 5 * 1000; // refetch while the server address is still missing
  const REFRESH = 10 * 1000; // and while it's there, for the match status
  const APP_ID = 4465480; // Counter-Strike: Global Offensive on Steam
  const joinLink = (addr) => `steam://run/${APP_ID}//+connect%20${addr}`; // only the space encoded, as Steam expects

  const PLAY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';

  const mmss = (secs) => `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;

  // ---------- settings ----------

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s && Number.isInteger(s.secs) && s.secs > 0) return { on: !!s.on, secs: s.secs };
    } catch {}
    return { on: false, secs: 60 };
  }
  let settings = loadSettings();
  const saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {}
  };

  const isDone = (id) => {
    try {
      return !!id && localStorage.getItem(DONE_KEY) === id;
    } catch {
      return false;
    }
  };
  const markDone = (id) => {
    try {
      localStorage.setItem(DONE_KEY, id);
    } catch {}
  };

  // ---------- match data ----------

  let server = { id: null, addr: null, status: null, deadline: 0, fetchedAt: 0, pending: false };
  let joining = false; // the last check before connecting is in flight

  function applyMatch(m) {
    server.addr = m?.serverIp && m?.serverPort ? `${m.serverIp}:${m.serverPort}` : null;
    server.status = m?.status || null;
    server.deadline = m?.joinDeadline ? new Date(m.joinDeadline).getTime() || 0 : 0;
  }

  function fetchMatch(id) {
    return fetch(`/api/match/${id}`, { credentials: "include" }).then((r) => (r.ok ? r.json() : null));
  }

  function fetchServer(id) {
    server.pending = true;
    server.fetchedAt = Date.now();
    fetchMatch(id)
      .then(
        (m) => {
          if (server.id === id && m) applyMatch(m);
        },
        () => {}
      )
      .finally(() => {
        if (server.id === id) server.pending = false;
        update();
      });
  }

  // ---------- Join game button ----------

  // The site's copy buttons: "Copy connect" (server ready) and "Copy Connect" (live).
  function copyButtons() {
    return [...document.querySelectorAll("button")].filter((b) => /^copy connect$/i.test(b.textContent.trim()));
  }

  function makeButton(copy, addr) {
    const a = document.createElement("a");
    a.className = `${copy.className} ${BTN_CLASS}`;
    a.title = "Start CS:GO through Steam and connect to the match server";
    const icon = copy.querySelector("svg");
    a.innerHTML = PLAY_SVG + "Join game";
    if (icon) a.firstElementChild.setAttribute("class", icon.getAttribute("class") || "");
    a.href = joinLink(addr);
    return a;
  }

  // Joining or copying the command by hand counts as joined, so auto-join won't connect a second time.
  document.addEventListener(
    "click",
    (e) => {
      if (!server.id || !(e.target instanceof Element)) return;
      const btn = e.target.closest(`.${BTN_CLASS}, button`);
      if (btn && (btn.classList.contains(BTN_CLASS) || /^copy connect$/i.test(btn.textContent.trim()))) {
        markDone(server.id);
        render();
      }
    },
    true
  );

  // ---------- auto-join ----------

  const waiting = () => server.addr && server.status === "WAITING_FOR_PLAYERS" && server.deadline > 0;

  function join(id) {
    joining = true;
    render();
    fetchMatch(id)
      .then(
        (m) => {
          if (server.id !== id || !m) return;
          applyMatch(m);
          if (!waiting() || isDone(id) || !settings.on) return; // everyone's in, or the match moved on
          const left = server.deadline - Date.now();
          if (left <= 0 || left > settings.secs * 1000) return; // the deadline moved: wait for the new one
          markDone(id);
          console.log(`[CSGOPremier Auto-join] Joining match #${id} at ${server.addr}`);
          location.href = joinLink(server.addr);
        },
        () => {}
      )
      .finally(() => {
        joining = false;
        render();
      });
  }

  function tick() {
    const id = server.id;
    if (id && !server.pending && Date.now() - server.fetchedAt > REFRESH) fetchServer(id); // status, even in a background tab
    if (settings.on && !joining && id && waiting() && !isDone(id)) {
      const left = server.deadline - Date.now();
      if (left > 0 && left <= settings.secs * 1000) join(id);
    }
    render();
  }

  // Background tabs get their timers slowed to once a minute; a worker's aren't.
  let ticker = null;
  function setTicking(on) {
    if (on && !ticker) {
      try {
        const url = URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 500);"], { type: "text/javascript" }));
        ticker = new Worker(url);
        URL.revokeObjectURL(url);
        ticker.onmessage = tick;
      } catch {
        const t = setInterval(tick, 500); // no workers: ordinary timers, possibly late in a background tab
        ticker = { terminate: () => clearInterval(t) };
      }
    } else if (!on && ticker) {
      ticker.terminate();
      ticker = null;
    }
  }

  function parseTime(text) {
    const m = String(text).trim().match(/^(?:(\d{1,2}):)?(\d{1,4})$/);
    if (!m) return null;
    const secs = Number(m[1] || 0) * 60 + Number(m[2]);
    return secs > 0 && secs < 3600 ? secs : null;
  }

  function changeSettings(patch) {
    settings = { ...settings, ...patch };
    saveSettings();
    tick(); // connects now if the new time has already been reached; re-renders the bar and the card
  }

  // A "mm:ss" box: shows the setting, and takes 1:30, 01:30 or 90 (seconds); anything else is put back.
  const TIME_INPUT = `<input type="text" inputmode="numeric" spellcheck="false" maxlength="5" class="cip-time font-mono font-bold"
    style="width:3.4rem;padding:2px 4px;text-align:center;font-size:12px;color:#fff;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.15);outline:none">`;

  function wireTimeInput(input) {
    input.value = mmss(settings.secs);
    input.addEventListener("change", () => {
      const secs = parseTime(input.value);
      input.value = mmss(secs || settings.secs);
      if (secs) changeSettings({ secs });
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
    });
  }

  function syncTimeInput(input) {
    if (document.activeElement !== input && parseTime(input.value) !== settings.secs) input.value = mmss(settings.secs);
  }

  function createBar() {
    const bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.className = "relative mt-3 flex flex-wrap items-center justify-between gap-3 border border-white/10 bg-black/25 px-3 py-2";
    bar.innerHTML = `
      <div class="flex min-w-0 flex-wrap items-center gap-3">
        <button type="button" role="switch" class="group flex min-w-0 items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span class="cip-track"><span class="cip-knob"></span></span>
          <span class="block text-xs font-bold uppercase tracking-wider text-white/80 transition-colors group-hover:text-white">Auto-join</span>
        </button>
        <label class="flex items-center gap-2 text-[11px] text-white/40">when the timer reaches ${TIME_INPUT}</label>
      </div>
      <span class="cip-state"></span>`;
    bar.querySelector('[role="switch"]').addEventListener("click", () => changeSettings({ on: !settings.on }));
    wireTimeInput(bar.querySelector(".cip-time"));
    return bar;
  }

  function render() {
    renderCard();
    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    const on = settings.on;
    const sw = bar.querySelector('[role="switch"]');
    sw.setAttribute("aria-checked", String(on));
    sw.title = on
      ? "Auto-join is on: CS:GO is started and connected for you when the join timer reaches the set time. Click to turn off."
      : "Auto-join is off. Click to have CS:GO started and connected for you when the join timer reaches the set time.";
    // Switch track and knob, as the Auto-accept switch; the site's quaternary green when on.
    sw.querySelector(".cip-track").className =
      `cip-track relative inline-flex h-4 w-7 shrink-0 items-center border transition-colors ${on ? "border-quaternary/60 bg-quaternary/20" : "border-white/15 bg-white/[0.04]"}`;
    sw.querySelector(".cip-knob").className = `cip-knob absolute h-2.5 w-2.5 transition-all ${on ? "bg-quaternary" : "bg-white/35"}`;
    sw.querySelector(".cip-knob").style.left = on ? "14px" : "2px";
    syncTimeInput(bar.querySelector(".cip-time"));

    const left = Math.max(0, Math.floor((server.deadline - Date.now()) / 1000));
    let text = "Off";
    let active = false;
    if (isDone(server.id)) {
      text = "Joined";
    } else if (joining) {
      text = "Joining…";
      active = true;
    } else if (left <= 0) {
      text = "Time's up";
    } else if (on) {
      text = `in ${mmss(Math.max(0, left - settings.secs))}`; // until it connects
      active = true;
    }
    const state = bar.querySelector(".cip-state");
    state.className = `cip-state font-mono text-[10px] font-bold uppercase tracking-widest ${active ? "text-quaternary" : "text-white/30"}`;
    if (state.textContent !== text) state.textContent = text;
  }

  // ---------- Settings panel card ----------
  // Like invite-accept.js's "Auto-accept Lobby Invites" card: the site's Off/On option buttons (as in its
  // "3D Skin Previews" setting), plus the time box.

  const OPTION_BASE =
    "relative inline-flex items-center justify-center gap-2 whitespace-nowrap font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 hover:bg-white/10 min-w-0 flex-1 p-2 border text-[10px] uppercase tracking-wider transition-all";
  const OPTION_OFF = "border-white/10 text-white/40 hover:border-white/30";
  const OPTION_ON = "border-tertiary bg-tertiary/10 text-white/80";

  function renderCard() {
    const card = document.getElementById(CARD_ID);
    if (!card) return;
    for (const btn of card.querySelectorAll("button[data-value]")) {
      const selected = (btn.dataset.value === "1") === settings.on;
      const cls = `${OPTION_BASE} ${selected ? OPTION_ON : OPTION_OFF}`;
      if (btn.className !== cls) btn.className = cls;
      btn.setAttribute("aria-pressed", String(selected));
    }
    syncTimeInput(card.querySelector(".cip-time"));
  }

  function createCard() {
    const card = document.createElement("div");
    card.id = CARD_ID;
    card.className = "relative bg-black/20 border border-white/10 p-3";
    card.innerHTML = `
      <div class="text-sm font-medium text-white/80 mb-1">Auto-join Matches</div>
      <p class="text-[10px] text-white/40 mb-2">Start CS:GO and connect to your match when its join timer gets down to this time. Not if you already joined or copied the connect command yourself.</p>
      <label class="flex items-center gap-2 text-[10px] text-white/40 mb-2">Join when the timer reaches ${TIME_INPUT}</label>
      <div class="flex gap-2">
        <button type="button" data-value="0">Off</button>
        <button type="button" data-value="1">On</button>
      </div>`;
    for (const btn of card.querySelectorAll("button[data-value]")) {
      btn.addEventListener("click", () => changeSettings({ on: btn.dataset.value === "1" }));
    }
    wireTimeInput(card.querySelector(".cip-time"));
    return card;
  }

  // The right-hand panel (data-tour="friends-panel") shows Settings when its header reads "Settings";
  // the setting cards sit in the list under that header (found the same way as in invite-accept.js).
  function findSettingsList() {
    const panel = document.querySelector('[data-tour="friends-panel"]');
    if (!panel) return null;
    const header = [...panel.querySelectorAll(".border-b")].find((h) =>
      [...h.querySelectorAll("span")].some((s) => s.textContent.trim() === "Settings"),
    );
    const list = header?.nextElementSibling;
    return list && list.querySelector(".border") ? list : null;
  }

  function injectCard() {
    if (document.getElementById(CARD_ID)) return;
    const list = findSettingsList();
    if (!list) return;
    list.appendChild(createCard());
    renderCard();
  }

  // The setting changed in another tab.
  window.addEventListener("storage", (e) => {
    if (e.key !== SETTINGS_KEY) return;
    settings = loadSettings();
    tick();
  });

  // ---------- page ----------

  function update() {
    injectCard();
    const m = location.pathname.match(MATCH_RE);
    const buttons = m ? copyButtons() : [];
    if (!buttons.length) {
      document.querySelectorAll(`.${BTN_CLASS}, #${BAR_ID}`).forEach((b) => b.remove());
      setTicking(false);
      return;
    }
    if (server.id !== m[1]) {
      server = { id: m[1], addr: null, status: null, deadline: 0, fetchedAt: 0, pending: false };
      joining = false;
    }
    if (!server.pending && Date.now() - server.fetchedAt > (server.addr ? REFRESH : RETRY)) fetchServer(m[1]);
    if (!server.addr) return;
    for (const copy of buttons) {
      let link = copy.nextElementSibling;
      if (!link?.classList.contains(BTN_CLASS)) {
        link = makeButton(copy, server.addr);
        copy.after(link);
      }
      if (link.getAttribute("href") !== joinLink(server.addr)) link.href = joinLink(server.addr);
    }

    // The bar goes under the row holding the buttons, only while the match waits for players.
    let bar = document.getElementById(BAR_ID);
    const row = buttons[0].parentElement;
    if (!waiting()) {
      bar?.remove();
    } else {
      bar ??= createBar();
      if (row.nextElementSibling !== bar) row.after(bar);
    }
    setTicking(waiting());
    render();
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 100);
  }).observe(document.documentElement, { childList: true, subtree: true });

  update();
})();
