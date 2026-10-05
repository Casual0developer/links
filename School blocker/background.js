// Nuvix - background service worker (MV3)
// Sources: remote domains.txt + remote links.txt -> chrome.storage cache -> bundled domains.txt -> bundled links.txt (legacy)
// Rule: each line is a domain/keyword; if it appears ANYWHERE in a URL (lowercased), block it.
// Live re-check: if local list allows a URL, GitHub is re-queried live before allowing.

const REMOTE_DOMAINS_URL = "https://raw.githubusercontent.com/Casual0developer/links/refs/heads/main/domains.txt";
const REMOTE_LINKS_URL = "https://raw.githubusercontent.com/Casual0developer/links/refs/heads/main/links.txt";
const REMOTE_URL = REMOTE_DOMAINS_URL; // alias
const REFRESH_MINUTES = 30;
// How often already-open tabs are re-scanned (catches tabs left open while
// the extension was off, plus pages opened while the worker was asleep).
const RESCAN_MINUTES = 5;
// How often a live GitHub re-check may hit the network (per-URL checks share the cache).
const REMOTE_LIVE_TTL_MS = 60 * 1000;

let BLOCKED_KEYWORDS = []; // lowercase strings, e.g. "mooo.com"
let LAST_SOURCE = "none";
// Live remote cache: fresh GitHub truth shared across navigations.
let REMOTE_CACHE = { keywords: [], fetchedAt: 0 };
let REMOTE_INFLIGHT = null;
// Normalized endpoint IPs derived from the lists (exact "1.2.3.4" / expanded IPv6).
// Any hostname that RESOLVES to one of these is blocked, not just IP-literal URLs.
let BLOCKED_IPS = new Set();

function normKeyword(s) {
  s = String(s || "").toLowerCase().trim();
  // strip URL scheme if someone puts a full link in the list
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  // strip leading "*." or "www."? No — keep as-is for substring match,
  // just remove trailing dots/slashes/spaces.
  s = s.replace(/^[*/.\s]+/, "").replace(/[*/.\s]+$/, "");
  // cut off any path/query — keyword is the domain part before first / ? # or space
  const cut = s.search(/[\s/?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  return s;
}

// Parse raw text: one domain/keyword per line.
// Legacy support: full URLs (old links.txt) -> extract hostname as keyword.
function parseList(text) {
  const out = [];
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let kw;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(line)) {
      try {
        kw = normKeyword(new URL(line).hostname);
      } catch { continue; }
    } else {
      kw = normKeyword(line);
    }
    if (!kw || kw.length < 2) continue;
    if (!seen.has(kw)) {
      seen.add(kw);
      out.push(kw);
    }
  }
  return out;
}

// Normalize an IPv4/IPv6 literal for comparison (null if not an IP).
// IPv6 is expanded to full 4-hex form so compressed list entries still match.
function normalizeIp(s) {
  s = String(s || "").trim().toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // strip zone id
  s = s.replace(/^\[|\]$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    const parts = s.split(".");
    if (!parts.every((n) => +n >= 0 && +n <= 255)) return null;
    return parts.map((n) => String(+n)).join(".");
  }
  if (s.includes(":")) return expandIpv6(s);
  return null;
}

function expandIpv6(s) {
  if (!/^[0-9a-f:.]+$/i.test(s)) return null;
  if (s.includes(".")) { // IPv4-mapped, e.g. ::ffff:1.2.3.4
    const m = s.match(/^(.*):(\d+\.\d+\.\d+\.\d+)$/);
    if (!m) return null;
    const v4 = m[2].split(".").map(Number);
    if (v4.some((n) => n < 0 || n > 255)) return null;
    s = m[1] + ":" + ((v4[0] * 256 + v4[1]).toString(16)) +
      ":" + ((v4[2] * 256 + v4[3]).toString(16));
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const ok = (g) => /^[0-9a-f]{1,4}$/i.test(g);
  if (!head.every(ok) || !tail.every(ok)) return null;
  if (halves.length === 1 && head.length !== 8) return null;
  const zeros = 8 - head.length - tail.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) return null;
  const full = [...head, ...Array(zeros).fill("0"), ...tail];
  if (full.length !== 8) return null;
  return full.map((g) => g.toLowerCase().padStart(4, "0")).join(":");
}

// Rebuild the IP set from the keyword list (IPs are just list lines).
function rebuildIpSet() {
  const ips = new Set();
  for (const kw of BLOCKED_KEYWORDS) {
    const ip = normalizeIp(kw);
    if (ip) ips.add(ip);
  }
  BLOCKED_IPS = ips;
}

// Adaptive learning: hosts the heuristic detector caught, persisted for offline use.
let LEARNED_HOSTS = new Map(); // host -> { host, reasons, at }
let LEARNED_LOADED = false;
// Never auto-learn or IP-block these (school tools share cloud IPs and must
// never be smart-filtered; explicit keyword entries still apply as listed).
const NEVER_LEARN = [
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

function isNeverLearn(host) {
  host = String(host || "").toLowerCase();
  return NEVER_LEARN.some((s) => host === s || host.endsWith("." + s));
}

async function loadLearned() {
  try {
    const d = await chrome.storage.local.get(["learnedHosts"]);
    const arr = d.learnedHosts || [];
    // Self-healing: drop entries that are now safe-listed (learned before
    // the exemption existed) so they can never fire again.
    const clean = arr.filter((e) => e && e.host && !isNeverLearn(e.host));
    LEARNED_HOSTS = new Map(clean.map((e) => [e.host, e]));
    if (clean.length !== arr.length) {
      try { await chrome.storage.local.set({ learnedHosts: clean }); } catch {}
    }
  } catch {}
}

async function saveLearned() {
  try {
    await chrome.storage.local.set({ learnedHosts: [...LEARNED_HOSTS.values()].slice(-500) });
  } catch {}
}

function matchLearned(urlStr) {
  let host;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (isNeverLearn(host)) return null; // stale safe-listed entry: never enforce
  if (LEARNED_HOSTS.has(host)) return "smart:" + host;
  const parts = host.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parent = parts.slice(i).join(".");
    if (LEARNED_HOSTS.has(parent)) return "smart:" + parent;
  }
  return null;
}

// Fast matching index: one case-insensitive regex over all keywords instead of
// hundreds of String.includes() scans per navigation. Rebuilt on every list change.
let BLOCKED_RE = null;
let BLOCKED_SET = new Set(); // exact membership for cheap merge-vs-known checks
function rebuildIndexes() {
  rebuildIpSet();
  BLOCKED_SET = new Set(BLOCKED_KEYWORDS);
  try {
    const parts = [];
    for (const kw of BLOCKED_KEYWORDS) {
      const k = String(kw).trim().toLowerCase();
      if (k.length >= 2) parts.push(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    BLOCKED_RE = parts.length ? new RegExp(parts.join("|"), "i") : null;
  } catch {
    BLOCKED_RE = null;
  }
}
// Substring rule, single pass. Returns the matched text lowercased, or null.
function regexMatchUrl(urlStr) {
  if (!BLOCKED_RE) return null;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const m = BLOCKED_RE.exec(urlStr);
    return m ? m[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

// Returns the matched keyword, or null.
function matchKeyword(urlStr) {
  return regexMatchUrl(urlStr);
}

function isBlockedUrl(urlStr) {
  return matchKeyword(urlStr) !== null;
}

function blockedPageUrl(originalUrl, keyword) {
  let host = "";
  try { host = new URL(originalUrl).hostname; } catch {}
  return chrome.runtime.getURL("blocked.html") +
    "?url=" + encodeURIComponent(originalUrl) +
    "&host=" + encodeURIComponent(host) +
    "&match=" + encodeURIComponent(keyword || "") +
    "&t=" + Date.now();
}

async function fetchText(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("bad status " + res.status);
  return await res.text();
}

async function saveKeywords(keywords, source) {
  BLOCKED_KEYWORDS = keywords;
  rebuildIndexes();
  LAST_SOURCE = source;
  await chrome.storage.local.set({
    keywords: keywords,
    hosts: keywords, // keep legacy key in sync for old content scripts
    updatedAt: Date.now(),
    source: source
  });
}

async function loadBlocklist(opts = {}) {
  const { awaitRemote = false } = opts;
  // 1. Last-known-good cache FIRST: the first verdict must never wait on network.
  try {
    const data = await chrome.storage.local.get(["keywords", "hosts"]);
    const cached = (data.keywords && data.keywords.length ? data.keywords : data.hosts) || [];
    const keywords = [...new Set(cached.map(normKeyword).filter((k) => k && k.length >= 2))];
    if (keywords.length > 0) {
      BLOCKED_KEYWORDS = keywords;
      rebuildIndexes();
      LAST_SOURCE = "cache";
    }
  } catch {}

  // 2. Bundled fallbacks (extension disk: instant, offline-safe).
  if (BLOCKED_KEYWORDS.length === 0) {
    try {
      const text = await fetchText(chrome.runtime.getURL("domains.txt"));
      const keywords = parseList(text);
      if (keywords.length > 0) await saveKeywords(keywords, "local");
    } catch {}
  }
  if (BLOCKED_KEYWORDS.length === 0) {
    try {
      const text = await fetchText(chrome.runtime.getURL("links.txt"));
      const keywords = parseList(text);
      if (keywords.length > 0) await saveKeywords(keywords, "local-legacy");
    } catch {}
  }
  if (BLOCKED_KEYWORDS.length === 0) LAST_SOURCE = "none";

  // 3. Fresh GitHub truth merges in when it arrives (awaited only for manual refresh).
  if (awaitRemote) {
    await refreshRemoteFromGitHub(true);
  } else {
    void refreshRemoteFromGitHub(false);
  }
}

// Pull GitHub lists and merge anything new into the local set + network rules.
async function refreshRemoteFromGitHub(force = false) {
  try {
    const remote = await getRemoteKeywordsLive(force);
    if (remote && remote.length > 0) {
      await mergeRemoteEntries(remote, "remote");
    }
  } catch {}
}

// Merge entries, persist + resync network rules only when something is actually new.
async function mergeRemoteEntries(remote, sourceLabel) {
  if (!remote || remote.length === 0) return false;
  let added = false;
  for (const k of remote) {
    if (!BLOCKED_SET.has(k)) {
      BLOCKED_KEYWORDS.push(k);
      BLOCKED_SET.add(k);
      added = true;
    }
  }
  if (added) {
    try { await saveKeywords([...BLOCKED_KEYWORDS], sourceLabel || LAST_SOURCE); } catch {}
    try { await syncDnrRules(); } catch {}
  }
  return added;
}

// Single shared load: concurrent navigation events must not each trigger
// their own network/storage cascade. Hot path returns with zero awaits.
let LOAD_INFLIGHT = null;
async function ensureLoaded() {
  if (BLOCKED_KEYWORDS.length > 0 && LEARNED_LOADED && DNS_HYDRATED) return;
  if (!LOAD_INFLIGHT) {
    LOAD_INFLIGHT = Promise.all([
      BLOCKED_KEYWORDS.length > 0 ? Promise.resolve() : loadBlocklist(),
      LEARNED_LOADED ? Promise.resolve() : loadLearned().then(() => { LEARNED_LOADED = true; }),
      DNS_HYDRATED ? Promise.resolve() : hydrateDnsCache().then(() => { DNS_HYDRATED = true; }),
    ]).finally(() => { LOAD_INFLIGHT = null; });
  }
  await LOAD_INFLIGHT;
}

// Fetch both GitHub lists live (shared cache + in-flight dedupe so every
// navigation doesn't hammer the network). Returns merged keywords, or [] offline.
async function getRemoteKeywordsLive(force = false) {
  const now = Date.now();
  if (!force && now - REMOTE_CACHE.fetchedAt < REMOTE_LIVE_TTL_MS && REMOTE_CACHE.keywords.length > 0) {
    return REMOTE_CACHE.keywords;
  }
  if (REMOTE_INFLIGHT) {
    try { return await REMOTE_INFLIGHT; } catch { return []; }
  }
  REMOTE_INFLIGHT = (async () => {
    const [d, l] = await Promise.allSettled([fetchText(REMOTE_DOMAINS_URL), fetchText(REMOTE_LINKS_URL)]);
    const merged = [
      ...(d.status === "fulfilled" ? parseList(d.value) : []),
      ...(l.status === "fulfilled" ? parseList(l.value) : [])
    ];
    const keywords = [...new Set(merged)];
    if (keywords.length > 0) REMOTE_CACHE = { keywords, fetchedAt: Date.now() };
    return keywords;
  })();
  try {
    return await REMOTE_INFLIGHT;
  } catch {
    return [];
  } finally {
    REMOTE_INFLIGHT = null;
  }
}

// Background GitHub revalidation (fire-and-forget): merges fresh remote entries,
// then enforces against this URL in case it just got listed. Keeps navigations
// fast by never making the allow-verdict wait on the network.
async function revalidateRemoteAndEnforce(tabId, url) {
  try {
    const remote = await getRemoteKeywordsLive();
    await mergeRemoteEntries(remote, LAST_SOURCE);
    const kw = matchKeyword(url);
    if (kw && tabId !== undefined && tabId >= 0) redirectTab(tabId, url, kw);
  } catch {}
}

// Scan every already-open tab (extension just enabled / restarted / updated).
// Navigations hooks miss these because no new navigation fires — so a blocked
// site sitting open would otherwise stay open. One shared live fetch for all tabs.
async function scanOpenTabs(reason) {
  try {
    await ensureLoaded();
    try { await syncDnrRules(); } catch {}
    let tabs;
    try {
      tabs = await chrome.tabs.query({});
    } catch { return; }
    if (!tabs || tabs.length === 0) return;
    let remote = [];
    try { remote = await getRemoteKeywordsLive(); } catch { remote = []; }
    // Merge fresh remote entries first so endpoint-IP checks use the latest list.
    await mergeRemoteEntries(remote, LAST_SOURCE);
    for (const t of tabs) {
      // Committed URL only: pendingUrl is an autocomplete/prefetch the user may
      // never open, and blocking it hijacks the visible tab for no reason.
      // Discarded (unloaded) tabs aren't visible either — leave them alone.
      if (t.discarded) continue;
      const url = t.url;
      if (!shouldCheck(url) || t.id === undefined || t.id < 0) continue;
      const localKw = matchKeyword(url);
      if (localKw) {
        redirectTab(t.id, url, localKw);
        continue;
      }
      const learnedScanKw = matchLearned(url);
      if (learnedScanKw) {
        redirectTab(t.id, url, learnedScanKw);
        continue;
      }
      const ipKw = await checkIpBlock(url);
      if (ipKw) redirectTab(t.id, url, ipKw);
    }
  } catch {}
}

// DNS-over-HTTPS cache: hostname -> { ips, exp }. Lets us block by endpoint IP:
// any hostname resolving to a blocked IP is blocked, even via a fresh domain.
// NOTE: MV3 service workers are killed after ~30s idle and lose all Map state,
// so the cache is ALSO persisted to chrome.storage.local to survive restarts.
const DNS_CACHE = new Map();
const DNS_INFLIGHT = new Map();
const DNS_TTL_MS = 5 * 60 * 1000;
const DNS_EMPTY_TTL_MS = 60 * 1000; // negative answers re-check sooner
const DNS_STORE_KEY = "dnsCache";
const DNS_MAX_STORE = 500;
let DNS_HYDRATED = false;

async function hydrateDnsCache() {
  try {
    const data = await chrome.storage.local.get([DNS_STORE_KEY]);
    const obj = data[DNS_STORE_KEY] || {};
    const now = Date.now();
    for (const [host, entry] of Object.entries(obj)) {
      if (entry && Array.isArray(entry.ips) && entry.exp > now) {
        DNS_CACHE.set(host, { ips: entry.ips, exp: entry.exp });
      }
    }
  } catch {}
}

function persistDnsCache() {
  try {
    const obj = {};
    const now = Date.now();
    let n = 0;
    for (const [host, entry] of DNS_CACHE) {
      if (n >= DNS_MAX_STORE) break;
      if (entry && Array.isArray(entry.ips) && entry.exp > now) {
        obj[host] = entry;
        n++;
      }
    }
    chrome.storage.local.set({ [DNS_STORE_KEY]: obj });
  } catch {}
}

async function resolveHostIps(host) {
  const now = Date.now();
  const cached = DNS_CACHE.get(host);
  if (cached && cached.exp > now) return cached.ips;
  if (DNS_INFLIGHT.has(host)) {
    try { return await DNS_INFLIGHT.get(host); } catch { return []; }
  }
  const p = (async () => {
    const ips = new Set();
    for (const type of ["A", "AAAA"]) {
      try {
        const res = await fetch(
          "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(host) + "&type=" + type,
          { headers: { accept: "application/dns-json" } }
        );
        if (!res.ok) continue;
        const body = await res.json();
        for (const a of (body.Answer || [])) {
          if (a.type === 1 || a.type === 28) { // A / AAAA (CNAME chains included)
            const ip = normalizeIp(String(a.data || ""));
            if (ip) ips.add(ip);
          }
        }
      } catch {}
    }
    const list = [...ips];
    DNS_CACHE.set(host, {
      ips: list,
      exp: Date.now() + (list.length > 0 ? DNS_TTL_MS : DNS_EMPTY_TTL_MS)
    });
    if (DNS_CACHE.size > 1000) DNS_CACHE.delete(DNS_CACHE.keys().next().value);
    persistDnsCache(); // fire-and-forget: survives worker restarts
    return list;
  })();
  DNS_INFLIGHT.set(host, p);
  try {
    return await p;
  } finally {
    DNS_INFLIGHT.delete(host);
  }
}

// Returns "ip:1.2.3.4" if the URL's host IS or RESOLVES TO a blocked endpoint IP.
async function checkIpBlock(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host || BLOCKED_IPS.size === 0) return null;
  if (isNeverLearn(host)) return null; // school tools share cloud IPs — never IP-block them
  const literal = normalizeIp(host.replace(/^\[|\]$/g, ""));
  if (literal) return BLOCKED_IPS.has(literal) ? "ip:" + literal : null;
  if (host === "localhost") return null;
  let ips;
  try {
    ips = await resolveHostIps(host);
  } catch {
    return null; // offline -> keep local verdict
  }
  for (const ip of ips) {
    if (BLOCKED_IPS.has(ip)) return "ip:" + ip;
  }
  return null;
}

// Network-level blocking (declarativeNetRequest): kills resource LOADS from
// blocked hosts (game .unityweb/.wasm/data files, scripts, images, XHR) even
// when embedded in an otherwise-allowed page, plus whole-frame navigations
// (redirected to the block page via onErrorOccurred below).
const DNR_ID_BASE = 200000;
let DNR_RULE_COUNT = 0;
// Game-engine build outputs + big game-distribution networks. Conservative:
// Unity/Construct build files and pure game CDNs only (not generic .wasm,
// which legit apps like Figma/Google Earth also use).
const GAME_ASSET_PATTERNS = [
  "*.unity3d*", "*.unityweb*", "*c3runtime*",
  "*gamedistribution.com*", "*gamepix.com*", "*gamemonetize.com*",
  "*crazygames*.com*", "*poki*.com*", "*y8.com*",
  "*addictinggames.com*", "*miniclip.com*", "*coolmathgames.com*"
];
// Never network-block our own lifelines (list updates + DNS lookups),
// nor our own pages (a broad keyword like "block" must never match blocked.html).
const DNR_ALLOW = [
  "*://raw.githubusercontent.com/*",
  "*://cloudflare-dns.com/*",
  "chrome-extension://*/*"
];
// Resource types for the silent network block (everything except whole pages,
// which get the friendlier redirect below instead of an error page).
const DNR_BLOCK_TYPES = [
  "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket",
  "webtransport", "webbundle", "other"
];

async function syncDnrRules() {
  try {
    if (!chrome.declarativeNetRequest) return;
    // Keyed by kind+filter: each keyword becomes a silent resource block plus
    // a native main_frame redirect (instant, no error-page flash, no wake needed).
    const desired = new Map();
    for (const f of DNR_ALLOW) {
      desired.set("A|" + f, { urlFilter: f, type: "allow", priority: 100 });
    }
    const blockFilters = new Set();
    for (const kw of BLOCKED_KEYWORDS) {
      const k = String(kw).trim().toLowerCase();
      if (k.length >= 2) blockFilters.add("*" + k + "*");
    }
    for (const host of LEARNED_HOSTS.keys()) {
      if (host) blockFilters.add("*" + host + "*");
    }
    for (const pat of GAME_ASSET_PATTERNS) blockFilters.add(pat);
    let i = 0;
    for (const f of blockFilters) {
      if (i++ >= 2200) break; // two rules each: stay safely under the 5000-rule ceiling
      desired.set("B|" + f, { urlFilter: f, type: "block", priority: 1, resourceTypes: DNR_BLOCK_TYPES });
      desired.set("R|" + f, { urlFilter: f, type: "redirect", priority: 1, resourceTypes: ["main_frame"], redirect: { extensionPath: "/blocked.html" } });
    }
    const keyOf = (r) => {
      const t = r.action && r.action.type;
      return (t === "allow" ? "A|" : t === "redirect" ? "R|" : "B|") + (r.condition ? r.condition.urlFilter : "");
    };
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const byKey = new Map(existing.map((r) => [keyOf(r), r.id]));
    const removeRuleIds = [];
    for (const [key, id] of byKey) {
      if (!desired.has(key)) removeRuleIds.push(id);
    }
    let nextId = DNR_ID_BASE;
    for (const r of existing) {
      if (r.id >= nextId) nextId = r.id + 1;
    }
    const allowAdds = [];
    const mainAdds = [];
    let allowId = 1;
    for (const [key, spec] of desired) {
      if (byKey.has(key)) continue;
      if (spec.type === "allow") {
        allowAdds.push({ id: allowId++, action: { type: "allow" }, priority: spec.priority, condition: { urlFilter: spec.urlFilter } });
      } else {
        const rule = { id: nextId++, priority: spec.priority, condition: { urlFilter: spec.urlFilter, resourceTypes: spec.resourceTypes } };
        if (spec.type === "redirect") {
          rule.action = { type: "redirect", redirect: spec.redirect };
        } else {
          rule.action = { type: "block" };
        }
        mainAdds.push(rule);
      }
    }
    if (removeRuleIds.length) {
      try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }); } catch {}
    }
    for (let n = 0; n < mainAdds.length; n += 500) {
      try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: mainAdds.slice(n, n + 500) }); } catch {}
    }
    // Allow rules go last, one per call: a single rejected pattern (e.g. an
    // engine balking at the extension-scheme filter) can't wipe the rest.
    for (const rule of allowAdds) {
      try { await chrome.declarativeNetRequest.updateDynamicRules({ addRules: [rule] }); } catch {}
    }
    DNR_RULE_COUNT = desired.size;
  } catch {}
}

async function redirectTab(tabId, url, keyword) {
  try {
    const prev = PENDING_BLOCK.get(tabId);
    PENDING_BLOCK.set(tabId, { url, match: keyword || (prev && prev.match) || "", at: Date.now() });
    prunePending();
    await chrome.tabs.update(tabId, { url: blockedPageUrl(url, keyword) });
  } catch {}
}

// Last navigation seen per tab. Feeds the block page when it arrives WITHOUT
// params (native DNR redirect path), so it can still show URL + match.
const PENDING_BLOCK = new Map(); // tabId -> { url, match, at }
function noteNavigation(tabId, url) {
  try {
    PENDING_BLOCK.set(tabId, { url, match: "", at: Date.now() });
    prunePending();
  } catch {}
}
function prunePending() {
  try {
    if (PENDING_BLOCK.size > 300) PENDING_BLOCK.delete(PENDING_BLOCK.keys().next().value);
  } catch {}
}

// Only http(s) should ever be evaluated. Extension/browser pages are ignored,
// which also prevents redirect loops on blocked.html itself.
function shouldCheck(url) {
  return typeof url === "string" &&
    (url.startsWith("http://") || url.startsWith("https://"));
}

// Chrome pre-loads pages the user never opened: hovering/clicking an autocomplete
// suggestion or Google's speculation rules fire navigation events for a hidden
// "prerender" document. Blocking those yanks the visible tab to the block page
// even though the site never loaded — so ignore anything that isn't active.
function isBackgroundSpeculation(details) {
  return !!(details && details.documentLifecycle && details.documentLifecycle !== "active");
}

async function checkAndBlock(tabId, url) {
  if (!shouldCheck(url)) return;
  if (tabId !== undefined && tabId >= 0) noteNavigation(tabId, url);
  await ensureLoaded();
  // 0. Adaptively learned hosts first (instant exact match, works offline).
  const learnedKw = matchLearned(url);
  if (learnedKw) {
    if (tabId >= 0) redirectTab(tabId, url, learnedKw);
    return;
  }
  // 1. Local list first (instant, works offline).
  const localKw = matchKeyword(url);
  if (localKw) {
    if (tabId >= 0) redirectTab(tabId, url, localKw);
    return;
  }
  // 2. Endpoint-IP check (DNS cache is sync-fast on repeat hosts; school tools
  // are exempt since they share cloud IPs that must never trigger IP blocks).
  const ipKw = await checkIpBlock(url);
  if (ipKw) {
    if (tabId >= 0) redirectTab(tabId, url, ipKw);
    return;
  }
  // 3. Allowed for now — revalidate GitHub in the background; late hits redirect.
  revalidateRemoteAndEnforce(tabId, url);
}

// --- Navigation hooks (refresh-proof: every navigation is re-checked) ---

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (isBackgroundSpeculation(details)) return;
  if (details.frameId !== 0) return; // top frame only here; subframes handled below
  checkAndBlock(details.tabId, details.url);
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (isBackgroundSpeculation(details)) return;
  if (details.frameId !== 0) return;
  checkAndBlock(details.tabId, details.url);
});

// SPA navigations (history.pushState) — catches sites that change URL without reload
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (isBackgroundSpeculation(details)) return;
  if (details.frameId !== 0) return;
  checkAndBlock(details.tabId, details.url);
});

// Fallback for anything the navigation API misses.
// NOTE: only changeInfo.url (a committed URL change). Re-checking tab.url on every
// "loading" status or acting on pending/autocomplete URLs caused blocks for pages
// the user never actually opened.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  checkAndBlock(tabId, changeInfo.url);
});

// Block embedded blocked sites in iframes: kill the subframe by navigating the tab
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (isBackgroundSpeculation(details)) return;
  if (details.frameId === 0) return;
  checkAndBlock(details.tabId, details.url);
});

// A DNR network block on a whole frame lands the tab on Chrome's error page.
// Catch that and redirect to our block page instead (with match attribution).
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (isBackgroundSpeculation(details)) return;
  if (details.frameId !== 0) return;
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") return;
  if (!shouldCheck(details.url)) return;
  ensureLoaded().then(() => {
    const kw = matchLearned(details.url) || matchKeyword(details.url) || "network-rule";
    if (details.tabId >= 0) redirectTab(details.tabId, details.url, kw);
  });
});

// New tabs (committed URL only — pendingUrl may be an unopened suggestion).
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url) checkAndBlock(tab.id, tab.url);
});

// --- Messaging (content.js backup + popup status) ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "check") {
    (async () => {
      await ensureLoaded();
      const learnedKw = matchLearned(msg.url);
      if (learnedKw) return { blocked: true, match: learnedKw, source: "learned", via: "learned" };
      const localKw = matchKeyword(msg.url);
      if (localKw) return { blocked: true, match: localKw, source: LAST_SOURCE, via: "local" };
      const ipKw = await checkIpBlock(msg.url);
      if (ipKw) return { blocked: true, match: ipKw, source: LAST_SOURCE, via: "endpoint-ip" };
      const fwdTabId = sender && sender.tab && sender.tab.id;
      revalidateRemoteAndEnforce(fwdTabId, msg.url);
      return { blocked: false, match: null, source: LAST_SOURCE, via: "local+ip" };
    })().then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "heuristicBlock") {
    // Content script judged this page a games/proxy hub. Learn its host
    // (unless exempt) and bounce the tab to the block page.
    (async () => {
      const rawHost = String(msg.host || "").toLowerCase().replace(/\.$/, "");
      if (!rawHost || isNeverLearn(rawHost)) return { learned: false };
      await ensureLoaded();
      LEARNED_HOSTS.set(rawHost, { host: rawHost, reasons: msg.reasons || [], at: Date.now() });
      await saveLearned();
      try { await syncDnrRules(); } catch {}
      const tabId = sender && sender.tab && sender.tab.id;
      const match = "smart:" + String((msg.reasons || []).join("+")).slice(0, 60);
      if (tabId !== undefined && tabId >= 0 && msg.url) {
        redirectTab(tabId, msg.url, match);
      }
      return { learned: true };
    })().then(sendResponse);
    return true; // async response
  }
  if (msg && msg.type === "clearLearned") {
    LEARNED_HOSTS = new Map();
    saveLearned().then(() => syncDnrRules()).then(() => sendResponse({ count: 0 }));
    return true; // async response
  }
  if (msg && msg.type === "blockedInfo") {
    // Block page arrived without params (native DNR redirect): hand it the
    // most recent navigation seen in its tab so URL + match still display.
    let out = null;
    try {
      const tabId = sender && sender.tab && sender.tab.id;
      const e = tabId !== undefined ? PENDING_BLOCK.get(tabId) : null;
      if (e && e.url && Date.now() - e.at < 60000) {
        let host = "";
        try { host = new URL(e.url).hostname; } catch {}
        out = { url: e.url, host, match: e.match || "" };
      }
    } catch {}
    sendResponse(out);
    return false;
  }
  if (msg && msg.type === "status") {
    chrome.storage.local.get(["keywords", "hosts", "updatedAt", "source"]).then((d) => {
      const n = BLOCKED_KEYWORDS.length || (d.keywords || d.hosts || []).length;
      sendResponse({ count: n, source: LAST_SOURCE, updatedAt: d.updatedAt || 0, dnsCached: DNS_CACHE.size, learned: LEARNED_HOSTS.size, netRules: DNR_RULE_COUNT });
    });
    return true;
  }
  if (msg && msg.type === "refresh") {
    loadBlocklist({ awaitRemote: true }).then(async () => {
      await scanOpenTabs("manual-refresh");
      sendResponse({ count: BLOCKED_KEYWORDS.length, source: LAST_SOURCE });
    });
    return true;
  }
});

// --- Lifecycle ---

function ensureAlarms() {
  try {
    chrome.alarms.create("refresh-list", { periodInMinutes: REFRESH_MINUTES });
    chrome.alarms.create("rescan-tabs", { periodInMinutes: RESCAN_MINUTES });
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  loadBlocklist().then(() => scanOpenTabs("installed"));
  ensureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  loadBlocklist().then(() => scanOpenTabs("startup"));
  ensureAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "refresh-list") {
    loadBlocklist().then(() => scanOpenTabs("refresh-list"));
  } else if (alarm.name === "rescan-tabs") {
    scanOpenTabs("rescan-tabs");
  }
});

// Load immediately when the service worker wakes (covers disable -> re-enable:
// the worker restarts fresh, so already-open tabs get scanned).
loadBlocklist().then(() => scanOpenTabs("wake"));
ensureAlarms();
