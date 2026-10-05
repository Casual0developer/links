# Nuvix (GoGuardian / FrontiGuard style)

Chrome Manifest V3 extension.

## How it meets your requirements

- **Remote set list:** fetches `https://raw.githubusercontent.com/Casual0developer/links/refs/heads/main/domains.txt` **and** `.../links.txt` (merged), one domain/keyword per line. If a keyword appears **anywhere** in a visited link (case-insensitive), it is blocked.
- **Live re-check:** every navigation first checks the local list (instant, works offline). If local allows it, the background live-checks GitHub (`domains.txt` + `links.txt`) before allowing — so a site added to GitHub after the last sync still gets blocked, even if the local copy is stale. Results share a 60-second cache to avoid hammering GitHub, and newly seen remote keywords are merged into local storage for offline use. If offline, the local verdict stands.
- **Endpoint-IP blocking:** list an IP (one per line, e.g. `149.56.15.214`) and two things happen: direct `http://IP/...` links match by substring as before, **and** every other hostname is resolved via DNS-over-HTTPS (Cloudflare, cached 5 min in memory **and** persisted to storage so it survives extension restarts — see the "DNS cached hosts" count in the popup). If it resolves to a blocked IP, it's blocked even under a brand-new domain. Results show as `Matched: ip:1.2.3.4`. Offline = local verdict stands.
- **Smart filter (adaptive):** pages that pass every list are scored for games/proxy-hub signals: suspicious URL/title words, game iframes (YouTube/Vimeo/music embeds excluded), canvas, Play buttons, game-engine scripts, proxy client libraries (`__uv`, Rammerhead…), proxy-style address bars, app tiles (TikTok/YouTube/Discord/etc. in links, images, or buttons), tab cloaking (fake Google/Canvas title *or* favicon on a foreign host), and links to already-blocked hosts. Score ≥ 5 across multiple signal types = instant block + the host is auto-learned (persisted, works offline, exact-host match). Late-loading games are re-scanned as the DOM changes. IXL, iReady, Membean, Pear Assessment, DeltaMath, Kahoot, Blooket, and ~25 more school tools (plus Google/Microsoft/Bing-search/YouTube) are exempt from learning *and* endpoint-IP blocks. See counts and wipe the learned list in the popup.
- **Performance:** first verdicts serve from local cache/bundled lists (never wait on network), concurrent navigations share one load, keyword matching is a single compiled regex, GitHub revalidation never blocks the allow-verdict (late hits redirect), and network rules kill loads before the worker even wakes.
- **Network-level loading blocks:** every keyword/learned host becomes declarativeNetRequest rules — silent blocks for resources/iframes plus **native main-frame redirects** straight to the block page (no error-page flash, works even with the worker asleep). The block page recovers the original URL + match from the background when it arrives without params. Our own list-update and DNS traffic is allowlisted. Rule count is visible in the popup.
- **Offline fallback:** if fetch fails (no internet), uses last cached copy in `chrome.storage.local`, else bundled `domains.txt`, else legacy bundled `links.txt` (hostnames used as keywords). So a loaded machine with no internet still blocks.
- **Block action:** any navigation to a blocked `http(s)` URL is redirected to `blocked.html` ("Site Blocked", shows matched keyword). A `content.js` backup at `document_start` wipes the page and shows an undismissable overlay if the page somehow loads.
- **No bypass by refresh / click-off:** there is no Close / Proceed button. Refresh reloads the check. Back button re-triggers `webNavigation` check and bounces back to the block page. `blocked.html` also traps history with `pushState`.
- **Already-open tabs scanned:** on install / browser startup / worker wake (covers disable → re-enable), plus every 5 minutes and after each list refresh, all open tabs are scanned against local + live GitHub lists — so a blocked site left open while the extension was off gets redirected instead of staying open.
- **No false blocks from autocomplete/prefetch:** prerendered or pending URLs (address-bar suggestions, hover pre-loads, Google speculation) that the user never actually opened are ignored — only active, committed navigations are blocked.

## Files

- `manifest.json` — extension manifest
- `background.js` — fetch list, cache, `webNavigation` + `tabs.onUpdated` redirects, auto-refresh every 30 min
- `content.js` — backup overlay, runs on all pages at `document_start`
- `blocked.html` / `blocked.js` — refresh-proof block page, no dismiss button, shows matched keyword
- `popup.html` / `popup.js` — status (count, source, last updated) + manual refresh
- `domains.txt` — local fallback (shipped with extension)
- `links.txt` — legacy local fallback (hostnames used as keywords)

## Install (test)

1. Go to `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Add a test keyword to remote `domains.txt` (or test with an existing one, e.g. `mooo.com`), then visit a URL containing it → you get `Site Blocked`.
4. Disconnect internet → reload extension → it still blocks using `domains.txt` / cache.
5. Click extension icon to see count / source / Refresh button.

## Important limitation

Like any normal extension, a user can disable/uninstall it from `chrome://extensions` unless you force-install it via admin policy (Chrome Enterprise / Group Policy / school MDM with `ExtensionInstallForcelist` + block `chrome://extensions`). True GoGuardian-style tamper-proofing requires managed devices — the extension alone cannot prevent uninstall.

## Note on substring matching

Short keywords (e.g. `my.to`, `k.vu`, `hs.vc`) match anywhere in the URL, so they can over-block (e.g. `my.to` matches any URL containing those 5 letters in sequence). That is per your requested rule — remove very short keywords if you get false positives.
