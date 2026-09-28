// Bridges FACEIT lookups between the compact match scoreboard and the background worker.
//
// match-table.js runs in the page's own world (manifest world:"MAIN"), so it can't reach FACEIT
// itself (CORS) and has no extension APIs. It posts the match's Steam ids on the page, this content
// script — which does have chrome.runtime — forwards them to faceit-bg.js, and posts the answers
// back. Only same-origin page messages are relayed, and the payload is public FACEIT level/elo.
(() => {
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const req = e.data;
    if (req == null || req.__cipFaceitReq == null || !Array.isArray(req.ids)) return;
    const reqId = req.__cipFaceitReq;
    chrome.runtime.sendMessage({ type: "cip-faceit", ids: req.ids }, (res) => {
      const data = !chrome.runtime.lastError && res?.ok ? res.data : {};
      window.postMessage({ __cipFaceitRes: reqId, data }, location.origin);
    });
  });
})();
