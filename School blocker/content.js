// Nuvix - content script backup (runs at document_start, all frames)
// Defense-in-depth: if a blocked page somehow loads (JS redirect, race),
// wipe it and show an undismissable overlay. Refreshing re-runs this script,
// so there is no way to refresh/click back to the site content.
// Rule: block if any keyword from domains.txt appears ANYWHERE in the URL.

(async function () {
  // Never run on the extension's own block page
  if (location.protocol === "chrome-extension:" ||
      location.protocol === "moz-extension:" ||
      location.protocol === "about:" ||
      location.protocol === "data:") return;
  if (location.href.includes("blocked.html")) return;
  // Prerendered (pre-loaded autocomplete/hover) documents the user never opened:
  // don't touch them. If the prerender ever activates, the background
  // navigation hooks re-check it as a real visit.
  try { if (document.prerendering) return; } catch {}

  function normKeyword(s) {
    s = String(s || "").toLowerCase().trim();
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    s = s.replace(/^[*/.\s]+/, "").replace(/[*/.\s]+$/, "");
    const cut = s.search(/[\s/?#]/);
    if (cut >= 0) s = s.slice(0, cut);
    return s;
  }

  function localCheck(url, keywords) {
    let lower;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      lower = url.toLowerCase();
    } catch { return null; }
    for (const raw of keywords) {
      const kw = normKeyword(raw);
      if (kw && kw.length >= 2 && lower.includes(kw)) return kw;
    }
    return null;
  }

  function showOverlay(blockedUrl, keyword) {
    try { window.stop(); } catch {}
    try { document.documentElement.innerHTML = ""; } catch {}

    const show = () => {
      if (document.getElementById("__nuvix_root__")) return;
      const root = document.createElement("div");
      root.id = "__nuvix_root__";
      const shadow = root.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = `
        :host { all: initial; }
        .wrap { position: fixed; inset: 0; z-index: 2147483647; background: #0f172a;
          color: #f1f5f9; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
          display: flex; align-items: center; justify-content: center; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px;
          padding: 40px; max-width: 520px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
        .icon { font-size: 56px; }
        h1 { margin: 12px 0 8px; font-size: 28px; }
        p { color: #94a3b8; font-size: 15px; word-break: break-all; }
        .url { background: #0f172a; border: 1px solid #334155; border-radius: 8px;
          padding: 8px 12px; margin-top: 12px; font-size: 13px; color: #f87171; word-break: break-all; }
      `;
      const wrap = document.createElement("div");
      wrap.className = "wrap";
      wrap.innerHTML = `<div class="card">
          <div class="icon">🚫</div>
          <h1>Site Blocked</h1>
          <p>This site is blocked by Nuvix policy.</p>
          <div class="url"></div>
        </div>`;
      wrap.querySelector(".url").textContent = blockedUrl + (keyword ? "  [matched: " + keyword + "]" : "");
      shadow.appendChild(style);
      shadow.appendChild(wrap);
      // Remove everything else so page scripts can't resurrect content
      try {
        [...document.documentElement.children].forEach((el) => {
          if (el !== root && el.tagName !== "HEAD") el.remove();
        });
        document.documentElement.appendChild(root);
      } catch {}
      // No dismiss button on purpose. Block context menu / shortcuts that pages use to hide overlays.
      document.addEventListener("contextmenu", (e) => e.preventDefault(), true);
    };

    show();
    // If page JS deletes our node, put it back. No close path exists.
    new MutationObserver(show).observe(document.documentElement, { childList: true, subtree: false });

    // Prefer full redirect to the extension block page (history-safe).
    try {
      const target = chrome.runtime.getURL("blocked.html") +
        "?url=" + encodeURIComponent(blockedUrl) +
        "&match=" + encodeURIComponent(keyword || "") + "&t=" + Date.now();
      if (window.top === window.self) {
        window.location.replace(target);
      }
    } catch {}
  }

  // Hosts the smart filter must never auto-learn (school tools + YouTube).
  // Must stay in sync with NEVER_LEARN in background.js.
  const NEVER_LEARN_SUFFIX = [
    "google.com", "gstatic.com", "googleapis.com", "googleusercontent.com",
    "youtube.com", "youtu.be", "ytimg.com", "googlevideo.com",
    "microsoft.com", "office.com", "live.com", "apple.com", "icloud.com",
    "khanacademy.org", "clever.com", "classlink.com",
    "bing.com", "msn.com", "duckduckgo.com", "yahoo.com",
    "brave.com", "ecosia.org", "startpage.com", "yandex.com",
    "ixl.com", "i-readycentral.com", "curriculumassociates.com",
    "membean.com", "pearassessment.com", "edulastic.com", "deltamath.com",
    "kahoot.com", "kahoot.it", "blooket.com", "gimkit.com",
    "quizlet.com", "quizizz.com", "wayground.com", "nearpod.com",
    "desmos.com", "geogebra.org", "phet.colorado.edu",
    "code.org", "scratch.mit.edu", "scratchfoundation.org",
    "schoology.com", "powerschool.com", "instructure.com",
    "seesaw.me", "padlet.com", "flip.com", "classdojo.com", "remind.com",
    "newsela.com", "commonlit.org", "readworks.org",
    "prodigygame.com", "education.minecraft.net"
  ];
  function hostIsExempt(host) {
    host = String(host || "").toLowerCase();
    return NEVER_LEARN_SUFFIX.some((s) => host === s || host.endsWith("." + s));
  }
  function learnedLocalCheck(url, learned) {
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      host = u.hostname.toLowerCase().replace(/\.$/, "");
    } catch { return null; }
    if (!host || !learned) return null;
    if (hostIsExempt(host)) return null; // stale safe-listed entry: never enforce
    for (const raw of learned) {
      const b = normKw(String((raw && raw.host) || raw));
      if (!b) continue;
      if (host === b || host.endsWith("." + b)) return "smart:" + b;
    }
    return null;
  }
  function normKw(s) {
    return String(s || "").toLowerCase().trim().replace(/^[*/.\s]+/, "").replace(/[*/.\s]+$/, "");
  }

  // Adaptive heuristic: score the page for games/proxy-hub signals.
  // No single clue can fire alone — it takes a combination (threshold 5).
  function analyzePage(keywords) {
    try {
      const u = new URL(location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const host = u.hostname.toLowerCase().replace(/\.$/, "");
      if (!host || hostIsExempt(host)) return null;
      const pathHay = (host + " " + (u.pathname || "")).toLowerCase();
      let score = 0;
      const reasons = [];
      if (/(unblock|\bubg\b|\bgames?\b|\bplay\b|arcade|clicker|\bio\b)/.test(pathHay)) { score += 2; reasons.push("games-url"); }
      if (/(proxy|proxie|rammerhead|ultraviolet|interstellar|womginx|\buv\b|eclipse|nebula|lunar|incognito|tung\s*tung|tungtung)/.test(pathHay)) { score += 2; reasons.push("proxy-url"); }
      const h1 = document.querySelector("h1");
      const meta = document.querySelector('meta[name="description"]');
      const titleHay = ((document.title || "") + " " + (meta ? meta.content || "" : "") + " " + (h1 ? h1.textContent || "" : "")).toLowerCase();
      if (/(unblock|free games|play .* online|proxy|tung\s*tung|tungtung|tower defense|clicker|\.io game)/.test(titleHay)) { score += 2; reasons.push("title"); }
      const iframes = [...document.querySelectorAll("iframe")];
      const MEDIA_EMBED = /(youtube\.com|youtu\.be|youtube-nocookie|vimeo\.com|dailymotion|spotify|soundcloud|twitch\.tv\/embed|facebook\.com\/plugins|instagram\.com\/(p|reel)\/|tiktok\.com\/embed)/;
      const gameFrame = iframes.some((f) => {
        const src = (f.src || "").toLowerCase();
        if (!src || MEDIA_EMBED.test(src)) return false; // video/music player, not a game
        return /game|play|embed|unity|construct|godot|ruffle|emulat|retro|poki|crazygames|miniclip|coolmath|itch\.io|gamejolt|slope|2048|tetris|minecraft|fnf|papa'?s|run ?3|\bvex\b|drift ?hunters|1v1|krunker/.test(src);
      });
      if (gameFrame) { score += 2; reasons.push("game-frame"); }
      else if (iframes.length >= 3) { score += 1; reasons.push("iframes"); }
      if (document.querySelectorAll("canvas").length >= 1) { score += 1; reasons.push("canvas"); }
      const playBtns = [...document.querySelectorAll("button,a")].filter((el) => /^\s*play(\s+(now|game|online))?\s*$/i.test(el.textContent || "")).length;
      if (playBtns >= 2) { score += 1; reasons.push("play-buttons"); }
      const scriptHay = [...document.scripts].map((s) => (s.src || "").toLowerCase()).join(" ");
      if (/(unity|construct|godot|ruffle|emulatorjs|retroarch|gamepix|gamedistribution|coolmathgames|poki|crazygames)/.test(scriptHay)) { score += 2; reasons.push("engine"); }
      // Proxy client libraries bundled in page scripts (Ultraviolet/Rammerhead/etc).
      let proxyEngine = false;
      try {
        const scripts = document.scripts;
        for (let si = 0; si < Math.min(scripts.length, 25) && !proxyEngine; si++) {
          const blob = ((scripts[si].src || "") + " " + (scripts[si].textContent || "").slice(0, 2000)).toLowerCase();
          if (/__uv|rammerhead|womginx|ultraviolet|scramjet|corrosion|alloyproxy|libcurl|bare-mux|epoxy/.test(blob)) proxyEngine = true;
        }
      } catch {}
      if (proxyEngine) { score += 2; reasons.push("proxy-engine"); }
      const pageText = (document.body ? document.body.innerText || "" : "").toLowerCase();
      // D1: proxy-style address bar (placeholder/name/id/aria says URL/address).
      const barInput = [...document.querySelectorAll('input[type="text"],input[type="search"],input:not([type]),textarea')].find((el) => {
        const s = ((el.placeholder || "") + " " + (el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("aria-label") || "")).toLowerCase();
        return /url|address|search the web|browse|unblock|proxy|enter (a )?site|go to|type a url/.test(s);
      });
      if (barInput) { score += 3; reasons.push("proxy-bar"); }
      // D2: app tiles — distinct app brands in links, image alt/src, button text,
      // aria-labels, or visible text (proxy frontends show TikTok/YouTube/etc tiles).
      const APP_BRANDS = ["tiktok", "youtube", "youtu", "discord", "roblox", "snapchat", "instagram", "twitch", "spotify", "netflix", "steam", "epic games", "xbox", "pinterest", "reddit", "whatsapp", "telegram", "facebook", "crazygames", "poki", "y8", "miniclip", "coolmath"];
      const structuredHay = (
        [...document.querySelectorAll("a[href]")].map((a) => (a.href || "")).join(" ") + " " +
        [...document.querySelectorAll("img")].map((i) => ((i.alt || "") + " " + (i.src || ""))).join(" ") + " " +
        [...document.querySelectorAll("button,a,[role=button]")].map((el) => ((el.textContent || "") + " " + (el.getAttribute("aria-label") || ""))).join(" ")
      ).toLowerCase();
      const escRe = (b) => b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const brandHits = APP_BRANDS.filter((b) => structuredHay.includes(b) || new RegExp("\\b" + escRe(b) + "\\b").test(pageText)).length;
      if (brandHits >= 2) { score += 2; reasons.push("app-tiles"); }
      // D3: tab cloaking — title pretends to be Google/Canvas/Classroom on a foreign host.
      const cleanTitle = (document.title || "").trim().toLowerCase();
      if (/^(google|canvas|classroom|clever|classlink|schoology|powerschool|infinite campus)$/.test(cleanTitle) &&
          !/(google|instructure|clever|classlink|powerschool|schoology|infinite-campus)/.test(host)) { score += 3; reasons.push("cloaked"); }
      // Cloaked favicon: Google/etc icon served from a foreign host.
      try {
        const iconHay = [...document.querySelectorAll('link[rel*="icon"]')].map((l) => (l.href || "")).join(" ").toLowerCase();
        if (/(google|gstatic|clever|classlink|instructure|powerschool|schoology)/.test(iconHay)) { score += 2; reasons.push("cloaked-icon"); }
      } catch {}
      if (keywords && keywords.length) {
        const linked = new Set();
        for (const a of document.querySelectorAll("a[href]")) {
          const href = String(a.href || "").toLowerCase();
          for (const raw of keywords) {
            const kw = normKw(raw);
            if (kw && kw.length >= 2 && href.includes(kw)) { linked.add(kw); break; }
          }
          if (linked.size >= 3) break;
        }
        if (linked.size >= 3) { score += 2; reasons.push("bad-links"); }
      }
      if (score >= 5) return { host, reasons, score };
      return null;
    } catch { return null; }
  }

  // Soft lockdown: fullscreen overlay WITHOUT wiping the DOM, so a refused
  // verdict (exempt host) can lift cleanly and leave the page intact.
  function softOverlay(blockedUrl, reason) {
    const root = document.createElement("div");
    root.id = "__nuvix_root__";
    let shadow = null;
    try { shadow = root.attachShadow({ mode: "closed" }); } catch { return null; }
    const style = document.createElement("style");
    style.textContent = `
      .wrap { position: fixed; inset: 0; z-index: 2147483647; background: #0f172a;
        color: #f1f5f9; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        display: flex; align-items: center; justify-content: center; }
      .card { background: #1e293b; border: 1px solid #334155; border-radius: 16px;
        padding: 40px; max-width: 520px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
      h1 { margin: 12px 0 8px; font-size: 28px; }
      p { color: #94a3b8; font-size: 15px; }
      .url { background: #0f172a; border: 1px solid #334155; border-radius: 8px;
        padding: 8px 12px; margin-top: 12px; font-size: 13px; color: #f87171; word-break: break-all; }
    `;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = "<h1>Site Blocked</h1><p>Flagged by the Nuvix smart filter.</p>";
    const urlDiv = document.createElement("div");
    urlDiv.className = "url";
    urlDiv.textContent = blockedUrl + (reason ? "  [smart: " + reason + "]" : "");
    card.appendChild(urlDiv);
    shadow.appendChild(style);
    shadow.appendChild(wrap);
    wrap.appendChild(card);
    try { document.documentElement.appendChild(root); } catch { return null; }
    return root;
  }

  let keywords = null;
  let learned = null;
  try {
    const data = await chrome.storage.local.get(["keywords", "hosts", "learnedHosts"]);
    const arr = (data.keywords && data.keywords.length ? data.keywords : data.hosts);
    if (arr && arr.length) keywords = arr;
    if (data.learnedHosts && data.learnedHosts.length) learned = data.learnedHosts;
  } catch {}

  // 1. Instant local checks (work offline): substring keywords + learned hosts.
  let match = keywords ? localCheck(location.href, keywords) : null;
  if (!match) match = learnedLocalCheck(location.href, learned);
  if (match) {
    showOverlay(location.href, typeof match === "string" ? match : "");
    return;
  }

  // 2. Local allowed it -> ask background, which auto-checks GitHub live
  // (domains.txt + links.txt). Catches sites added to GitHub after the last sync.
  try {
    const res = await chrome.runtime.sendMessage({ type: "check", url: location.href });
    if (res && res.blocked) {
      showOverlay(location.href, typeof res.match === "string" ? res.match : "");
      return;
    }
  } catch { /* offline or background busy -> keep local verdict (allowed) */ }

  // 3. Adaptive heuristic (top frame only): page looks like an unlisted
  // games/proxy hub -> soft-lock, report to background to learn + redirect.
  if (window.top === window.self && !document.prerendering) {
    let fired = false;
    const runAnalysis = () => {
      if (fired || document.getElementById("__nuvix_root__")) return;
      let verdict = null;
      try { verdict = analyzePage(keywords || []); } catch { verdict = null; }
      if (!verdict) return;
      fired = true;
      const root = softOverlay(location.href, verdict.reasons.join("+"));
      try {
        chrome.runtime.sendMessage(
          { type: "heuristicBlock", url: location.href, host: verdict.host, reasons: verdict.reasons },
          (res) => {
            if (res && res.learned) {
              try { window.stop(); } catch {}
              try { document.documentElement.innerHTML = ""; } catch {}
              // Background redirects this tab to the block page.
            } else if (root && root.parentNode) {
              root.parentNode.removeChild(root); // exempt: lift overlay, page intact
            } else {
              fired = false;
            }
          }
        );
      } catch {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        fired = false;
      }
    };
    // Late booters (Unity/WebGL games that assemble seconds after load):
    // re-run on big DOM changes, debounced, capped so it can't spin forever.
    // NOTE: at document_start documentElement may not exist yet, so attach
    // lazily — otherwise the watcher silently never runs.
    const attachLateWatcher = () => {
      try {
        if (!document.documentElement || document.getElementById("__nuvix_root__")) return;
        let reruns = 0;
        let moTimer = 0;
        const mo = new MutationObserver(() => {
          if (fired || reruns >= 5 || document.getElementById("__nuvix_root__")) {
            try { mo.disconnect(); } catch {}
            return;
          }
          clearTimeout(moTimer);
          moTimer = setTimeout(() => { reruns++; try { runAnalysis(); } catch {} }, 2000);
        });
        mo.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => { try { mo.disconnect(); } catch {} }, 45000);
      } catch {}
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => { runAnalysis(); setTimeout(runAnalysis, 2500); attachLateWatcher(); }, { once: true });
    } else {
      runAnalysis();
      setTimeout(runAnalysis, 2500);
    }
    attachLateWatcher();
  }
})();
