// A "Join game" button on match pages (/match/<id>), beside the site's "Copy connect" and "Team voice".
//
// Once the server is up (the "Server ready" card before the match, and the live summary during it) the
// site only offers to copy "connect <ip>:<port>" for the game console. This adds a link to
// steam://run/4465480//+connect <ip>:<port>, which has Steam start the site's CS:GO (its own Steam app,
// 4465480, not CS2's 730) with that command, the same as pasting it. steam://connect/ isn't used: it
// picks the game from the app id the server reports, and CS:GO servers report 730, which opens CS2.
// The site's command has no password, so neither does the link.
// Chrome and Brave ask before a site opens Steam; setup.ps1 (run by update.bat) pre-approves csgopremier.com.
//
// Data: serverIp / serverPort from /api/match/<id>, the same fields the site builds its command from.
// The button copies the look of the site's "Copy connect" next to it.
(() => {
  const BTN_CLASS = "cip-join-game";
  const MATCH_RE = /^\/match\/(\d+)\/?$/;
  const RETRY = 5 * 1000; // refetch while the server address is still missing
  const APP_ID = 4465480; // Counter-Strike: Global Offensive on Steam
  const joinLink = (addr) => `steam://run/${APP_ID}//+connect%20${addr}`; // only the space encoded, as Steam expects

  const PLAY_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';

  let server = { id: null, addr: null, fetchedAt: 0, pending: false };

  function fetchServer(id) {
    server.pending = true;
    server.fetchedAt = Date.now();
    fetch(`/api/match/${id}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (m) => {
          if (server.id !== id) return;
          server.addr = m?.serverIp && m?.serverPort ? `${m.serverIp}:${m.serverPort}` : null;
        },
        () => {}
      )
      .finally(() => {
        if (server.id === id) server.pending = false;
        update();
      });
  }

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

  function update() {
    const m = location.pathname.match(MATCH_RE);
    const buttons = m ? copyButtons() : [];
    if (!buttons.length) {
      document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => b.remove());
      return;
    }
    if (server.id !== m[1]) server = { id: m[1], addr: null, fetchedAt: 0, pending: false };
    if (!server.addr) {
      if (!server.pending && Date.now() - server.fetchedAt > RETRY) fetchServer(m[1]);
      return;
    }
    for (const copy of buttons) {
      let join = copy.nextElementSibling;
      if (!join?.classList.contains(BTN_CLASS)) {
        join = makeButton(copy, server.addr);
        copy.after(join);
      }
      if (join.getAttribute("href") !== joinLink(server.addr)) join.href = joinLink(server.addr);
    }
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
