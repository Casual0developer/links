// blocked.html logic: display info + make Back/Refresh useless.
// Refreshing this page keeps you on this page (its URL is chrome-extension://,
// which the blocker never treats as blocked, and never redirects away from).
// Pressing Back to the blocked site triggers the background re-check and
// bounces you straight back here — so we also poison the history entry.

(function () {
  const urlEl = document.getElementById("blocked-url");
  const metaEl = document.getElementById("blocked-meta");

  function render(u, h, m) {
    urlEl.textContent = u || "Unknown site";
    metaEl.textContent = [h ? "Host: " + h : "", m ? "Matched: " + m : ""]
      .filter(Boolean).join("  •  ");
  }

  const params = new URLSearchParams(location.search);
  const pUrl = params.get("url") || "";
  const pHost = params.get("host") || "";
  const pMatch = params.get("match") || "";
  if (pUrl) {
    render(pUrl, pHost, pMatch);
  } else {
    // No params (native DNR redirect path): ask background for this tab's
    // most recent blocked navigation so URL + match still display.
    render("", "", "");
    try {
      chrome.runtime.sendMessage({ type: "blockedInfo" }).then((res) => {
        if (res && res.url) render(res.url, res.host || "", res.match || "");
      }).catch(() => {});
    } catch {}
  }

  // Trap the Back button: keep dummy history entries so "Back" lands here,
  // not on the site. Re-lock on pageshow in case bfcache dropped the trap.
  const lockHistory = () => {
    try {
      history.pushState({ blocked: true }, "", location.href);
      history.pushState({ blocked: true }, "", location.href);
    } catch {}
  };
  lockHistory();
  window.addEventListener("popstate", () => {
    try { history.pushState({ blocked: true }, "", location.href); } catch {}
  });
  window.addEventListener("pageshow", () => {
    try { history.pushState({ blocked: true }, "", location.href); } catch {}
  });

  // Copy button: let users copy the blocked link text (nothing navigates anywhere).
  const copyBtn = document.getElementById("copy-btn");
  copyBtn.addEventListener("click", async () => {
    const text = urlEl.textContent || "";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        ta.remove();
      } catch { ok = false; }
    }
    copyBtn.textContent = ok ? "Copied!" : "Copy failed";
    copyBtn.classList.toggle("copied", ok);
    setTimeout(() => {
      copyBtn.textContent = "Copy link";
      copyBtn.classList.remove("copied");
    }, 1600);
  });

  // Kill context menu everywhere EXCEPT the copy row, so the link can be
  // right-click selected/copied too. View-source shortcuts stay dead.
  document.addEventListener("contextmenu", (e) => {
    if (e.target && e.target.closest && e.target.closest("#copy-row")) return;
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    // Block F5 / Ctrl+R / Ctrl+W close tricks from restoring content — F5 just reloads THIS page.
    if (e.key === "F5") { e.preventDefault(); location.reload(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") { e.preventDefault(); location.reload(); }
  });

  // Belt-and-suspenders: if the opener tab somehow navigates back to the blocked
  // URL, background.js will redirect it here again. Nothing to click off exists.
})();
