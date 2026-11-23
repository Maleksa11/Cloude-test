const SITE_ORIGIN = "https://cloude-test.pages.dev";
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const STORYBOARD_QUERY_KEYS = new Set(["sigh", "sqp"]);
const INVIDIOUS_HOSTS = [
  "inv.nadeko.net",
  "invidious.nerdvpn.de",
  "yt.chocolatemoo53.com",
  "invidious.tiekoetter.com"
];
const PIPED_HOSTS = [
  "pipedapi.kavin.rocks",
  "api.piped.yt",
  "pipedapi.drgns.space",
  "pipedapi.ducks.party",
  "piped-api.codespace.cz",
  "pipedapi.reallyaweso.me",
  "api.piped.private.coffee",
  "pipedapi.darkness.services",
  "pipedapi.nosebs.ru",
  "pipedapi-libre.kavin.rocks",
  "pipedapi.adminforge.de"
];
const PIPED_BATCH_SIZE = 5;
const PIPED_TIMEOUT_MS = 3500;
const FULL_VIDEO_FIELDS = "videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)";
const RECOMMENDED_FIELDS = "recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)";
const MAX_JSON_CHARS = 2500000;
const MAX_IMAGE_BYTES = 4000000;
// Keep the whole relay comfortably below the browser's 26-second request timeout.
const PROVIDER_TIMEOUT_MS = 4000;
const STORYBOARD_PROVIDER_TIMEOUT_MS = 4500;
const RELAY_DEADLINE_MS = 20500;
const HEALTHCHECK_TIMEOUT_MS = 6000;
const RELAY_VERSION = "advanced-worker-v11";

// ---------------------------------------------------------------------------
// Privacy budget for third-party providers.
//
// Every provider that receives a request learns the search phrase or video ID.
// The relay therefore never fans a request out to the whole provider list:
// it asks ONE provider first, and only starts a second after a short stagger
// (or immediately after a failure). Providers that failed recently are tried
// last, and the last provider that worked is tried first, so in the normal case
// exactly one operator sees a given request.
// ---------------------------------------------------------------------------
const HEDGE_STAGGER_MS = 1500;
const HEDGE_MAX_IN_FLIGHT = 2;
const HEDGE_MAX_ATTEMPTS = 4;
const HEDGE_DEADLINE_MS = 14000;
const PIPED_MAX_ATTEMPTS = 5;
const HOST_COOLDOWN_MS = 60000;
const hostState = new Map();

// Best-effort, per-isolate abuse limiter (token bucket per client address).
// The address is only held in memory for the life of the isolate: it is never
// logged, persisted or sent upstream. Cloudflare WAF rate-limiting rules are the
// authoritative control; this stops casual amplification of upstream traffic.
const RATE_LIMIT_CAPACITY = 120;
const RATE_LIMIT_REFILL_PER_SEC = 3;
const RATE_LIMIT_MAX_KEYS = 4000;
const rateBuckets = new Map();

// Operator-only switches, read from the Worker environment on every request.
let diagnosticsEnabled = false;

export function resetRelayState() {
  hostState.clear();
  rateBuckets.clear();
  publishedHost.clear();
  diagnosticsEnabled = false;
}

function rememberHost(host, ok) {
  const state = hostState.get(host) || { badUntil: 0, lastGoodAt: 0 };
  if (ok) {
    state.badUntil = 0;
    state.lastGoodAt = Date.now();
  } else {
    state.badUntil = Date.now() + HOST_COOLDOWN_MS;
  }
  hostState.set(host, state);
}

function shuffleHosts(hosts) {
  const shuffled = hosts.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function orderHosts(hosts) {
  const now = Date.now();
  const entries = hosts.map((host, index) => {
    const state = hostState.get(host);
    const rank = !state ? 1 : state.badUntil > now ? 2 : state.lastGoodAt ? 0 : 1;
    return { host, index, rank, good: state ? state.lastGoodAt || 0 : 0 };
  });

  // Keep recently successful providers first and recently failing providers last.
  // Shuffle only equal-health candidates, so a cold isolate does not always spend
  // its five-provider privacy budget on the same static prefix of the allowlist.
  const knownGood = entries
    .filter((entry) => entry.rank === 0)
    .sort((a, b) => b.good - a.good || a.index - b.index)
    .map((entry) => entry.host);
  const untested = shuffleHosts(entries
    .filter((entry) => entry.rank === 1)
    .map((entry) => entry.host));
  const coolingDown = shuffleHosts(entries
    .filter((entry) => entry.rank === 2)
    .map((entry) => entry.host));

  return [...knownGood, ...untested, ...coolingDown];
}

// Cross-isolate memory of "which provider worked last", kept in the datacenter's
// Cache API (a host name only, never request data). Where the Cache API is not
// available - tests, workers.dev, local development - this is a silent no-op.
const SHARED_STATE_URL = "https://relay-state.invalid/good/";
const publishedHost = new Map();

async function recallSharedHost(group, hosts) {
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    const hit = await caches.default.match(SHARED_STATE_URL + group);
    if (!hit) return;
    const host = (await hit.text()).slice(0, 100);
    const state = hostState.get(host);
    if (hosts.includes(host) && (!state || !state.lastGoodAt) && !(state && state.badUntil > Date.now())) {
      hostState.set(host, { badUntil: 0, lastGoodAt: Date.now() - 1 });
    }
  } catch {}
}

function publishSharedHost(group, host) {
  try {
    if (typeof caches === "undefined" || !caches.default) return;
    const last = publishedHost.get(group);
    if (last && last.host === host && Date.now() - last.at < 300000) return;
    publishedHost.set(group, { host, at: Date.now() });
    caches.default.put(SHARED_STATE_URL + group, new Response(host, {
      headers: { "Cache-Control": "public, max-age=600" }
    })).catch(() => {});
  } catch {}
}

// Resolves with the first successful attempt, or { ok: false, failures }.
// `attempt(host)` returns { ok: true, ... } or { ok: false, failure, soft? };
// a "soft" failure (for example "valid answer, wrong language") does not
// put the provider into cooldown.
async function hedgedRace(hosts, attempt, options = {}) {
  if (options.group) await recallSharedHost(options.group, hosts);
  const staggerMs = options.staggerMs ?? HEDGE_STAGGER_MS;
  const maxInFlight = options.maxInFlight ?? HEDGE_MAX_IN_FLIGHT;
  // The budget counts providers that may have SEEN the request. A connection that
  // never opened (DNS, TCP or TLS failure) cannot have delivered anything, so those
  // attempts are refunded: dead providers cost time, not privacy.
  const budget = options.maxAttempts ?? HEDGE_MAX_ATTEMPTS;
  const deadline = Date.now() + (options.deadlineMs ?? HEDGE_DEADLINE_MS);
  const list = orderHosts(hosts);
  return new Promise((resolve) => {
    const failures = [];
    let next = 0, inFlight = 0, used = 0, done = false, timer = 0;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const settle = (host, result) => {
      inFlight--;
      if (done) return;
      if (result && result.ok) {
        rememberHost(host, true);
        if (options.group) publishSharedHost(options.group, host);
        finish(result);
        return;
      }
      if (result && result.undelivered) used--;
      failures.push((result && result.failure) || { host, status: "failed" });
      if (!(result && result.soft)) rememberHost(host, false);
      advance();
    };
    const advance = () => {
      clearTimeout(timer);
      if (done) return;
      if (next >= list.length || used >= budget || Date.now() >= deadline) {
        if (inFlight === 0) finish({ ok: false, failures });
        return;
      }
      if (inFlight >= maxInFlight) return;
      const host = list[next++];
      inFlight++;
      used++;
      Promise.resolve().then(() => attempt(host)).then(
        (result) => settle(host, result),
        (error) => settle(host, {
          ok: false,
          undelivered: !(error && error.name === "AbortError"),
          failure: { host, status: error && error.name === "AbortError" ? "timeout" : "network-error" }
        })
      );
      if (next < list.length && used < budget) timer = setTimeout(advance, staggerMs);
    };
    advance();
  });
}

function rateLimitWait(request, cost) {
  const address = request.headers.get("CF-Connecting-IP");
  if (!address) return 0; // local development and tests have no client address
  const now = Date.now();
  let bucket = rateBuckets.get(address);
  if (bucket) {
    rateBuckets.delete(address); // re-insert below: Map order doubles as LRU order
  } else {
    if (rateBuckets.size >= RATE_LIMIT_MAX_KEYS) rateBuckets.delete(rateBuckets.keys().next().value);
    bucket = { tokens: RATE_LIMIT_CAPACITY, at: now };
  }
  bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + ((now - bucket.at) / 1000) * RATE_LIMIT_REFILL_PER_SEC);
  bucket.at = now;
  rateBuckets.set(address, bucket);
  if (bucket.tokens < cost) return Math.max(1, Math.ceil((cost - bucket.tokens) / RATE_LIMIT_REFILL_PER_SEC));
  bucket.tokens -= cost;
  return 0;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const encoder = new TextEncoder();
  const x = encoder.encode(a), y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

// Upstream host names and failure reasons are operator diagnostics, not client data.
function publicDiagnostics(key, value) {
  return diagnosticsEnabled ? { [key]: value } : {};
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-MTube-Relay": RELAY_VERSION,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex",
      ...extraHeaders
    }
  });
}

function errorResponse(message, status, extraHeaders = {}) {
  return jsonResponse({ error: message }, status, extraHeaders);
}

function onlyParams(url, allowed, required = allowed) {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => !allowed.includes(key))) return false;
  if (keys.some((key) => url.searchParams.getAll(key).length !== 1)) return false;
  return required.every((key) => url.searchParams.getAll(key).length === 1);
}

function one(url, key) {
  return url.searchParams.getAll(key)[0] || "";
}

// The deployment origin comes from the SITE_ORIGIN Worker variable when it is a
// plain https origin; otherwise the built-in default applies.
function configuredSiteOrigin(env) {
  const raw = env && typeof env.SITE_ORIGIN === "string" ? env.SITE_ORIGIN.trim() : "";
  if (!raw) return SITE_ORIGIN;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port &&
        parsed.pathname === "/" && !parsed.search && !parsed.hash) return parsed.origin;
  } catch {}
  return SITE_ORIGIN;
}

function isAllowedSiteOrigin(url, siteOrigin = SITE_ORIGIN) {
  const projectHost = new URL(siteOrigin).hostname;
  return url.protocol === "https:" &&
    (url.hostname === projectHost || url.hostname.endsWith("." + projectHost)) &&
    !url.username && !url.password && !url.port;
}

function isVideoId(value) {
  return VIDEO_ID.test(value);
}

function isYtImageHost(hostname) {
  return hostname === "i.ytimg.com" || hostname.endsWith(".ytimg.com");
}

function safeStoryboardTarget(raw, expectedVideoId) {
  try {
    const target = new URL(raw);
    if (target.protocol !== "https:" || !isYtImageHost(target.hostname) ||
        target.username || target.password || target.port || target.hash) return null;
    if (!isVideoId(expectedVideoId) ||
        !new RegExp("^/sb/(?:i\\d?/)?"+expectedVideoId+"/[A-Za-z0-9._~$%/+()-]+$").test(target.pathname)) return null;
    // Keep only the two query parameters YouTube's signed sprite URLs use. Anything
    // else would only create unbounded cache keys and widen what the relay forwards.
    const kept = target.search.slice(1).split("&").filter((pair) => {
      const equals = pair.indexOf("=");
      return STORYBOARD_QUERY_KEYS.has(equals < 0 ? pair : pair.slice(0, equals)) && pair.length <= 600;
    });
    return new URL(target.origin + target.pathname + (kept.length ? "?" + kept.join("&") : ""));
  } catch {
    return null;
  }
}

function privacyHeaders(accept, language = "en") {
  // Build fresh headers; never copy visitor IP, cookie, authorization, or referrer headers.
  // Cloudflare sends this as a Worker subrequest rather than forwarding the browser request.
  return new Headers({
    "Accept": accept,
    "Accept-Language": language === "ar" ? "ar,en;q=0.9" : "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  });
}

async function providerFailure(host, response) {
  const contentType = (response.headers.get("content-type") || "").slice(0, 100);
  const server = (response.headers.get("server") || "").slice(0, 80);
  const mitigation = (response.headers.get("cf-mitigated") || "").toLowerCase();
  let body = "";
  if (response.status === 403) {
    try { body = (await response.text()).slice(0, 400).toLowerCase(); } catch {}
  }
  let reason = "upstream-http-error";
  if (mitigation === "challenge" || /verifyngo|captcha|human verification|checking your browser|access denied.*automated/.test(body)) {
    reason = "bot-protection";
  } else if (/cloudflare/i.test(server) || /cloudflare|cf-ray|attention required/.test(body)) {
    reason = "cloudflare-edge-block";
  } else if (response.status === 403) {
    reason = "upstream-forbidden";
  }
  return { host, status: response.status, reason, server: server || undefined, contentType: contentType || undefined };
}

async function timedFetch(url, init, timeoutMs, consume) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Keep the abort timer active while the response body is read, not just until headers arrive.
    return typeof consume === "function" ? await consume(response) : response;
  } finally {
    clearTimeout(timer);
  }
}

async function checkPipedProvider(host) {
  try {
    return await timedFetch("https://" + host + "/search?q=music&filter=videos", {
      method: "GET",
      headers: privacyHeaders("application/json"),
      redirect: "manual"
    }, PROVIDER_TIMEOUT_MS, async (response) => {
      if (!response.ok) return { ...(await providerFailure(host, response)), search: false };
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return { host, status: response.status, search: false, reason: "non-json", contentType: contentType.slice(0, 100) };
      }
      const text = await response.text();
      if (text.length > MAX_JSON_CHARS) return { host, status: response.status, search: false, reason: "too-large" };
      let data;
      try { data = JSON.parse(text); }
      catch { return { host, status: response.status, search: false, reason: "invalid-json" }; }
      const items = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
      if (!items) return { host, status: response.status, search: false, reason: "unexpected-data" };
      const usable = items.map(extractPipedVideo).filter(Boolean);
      return { host, status: response.status, search: true, results: usable.length, sampleShape: usable.length ? "piped-search" : "empty-or-unrecognized" };
    });
  } catch (error) {
    return { host, status: error && error.name === "AbortError" ? "timeout" : "network-error", search: false };
  }
}

async function pipedHealthCheck() {
  const providers = [];
  // Cloudflare Workers limit simultaneous outgoing connections; probe in batches of five.
  for (let i = 0; i < PIPED_HOSTS.length; i += PIPED_BATCH_SIZE) {
    const batch = PIPED_HOSTS.slice(i, i + PIPED_BATCH_SIZE);
    providers.push(...await Promise.all(batch.map(checkPipedProvider)));
  }
  return jsonResponse({
    function: "ok",
    version: RELAY_VERSION,
    probe: "piped-search",
    providerTimeoutMs: PIPED_TIMEOUT_MS,
    providerBatchSize: PIPED_BATCH_SIZE,
    providers
  });
}

function extractPipedVideo(item) {
  if (!item || typeof item !== "object" || typeof item.title !== "string" || typeof item.url !== "string") return null;
  const match = /^\/watch\?v=([A-Za-z0-9_-]{11})(?:&|$)/.exec(item.url);
  if (!match) return null;
  return {
    videoId: match[1],
    title: item.title.slice(0, 300),
    author: String(item.uploaderName || item.uploader || "").slice(0, 120),
    lengthSeconds: Math.max(0, Number(item.duration) || 0),
    viewCount: Math.max(0, Number(item.views) || 0),
    viewCountText: String(item.views || ""),
    publishedText: String(item.uploadedDate || "").slice(0, 100),
    type: "video"
  };
}


function preferredSearchLanguage(query) {
  return /\p{Script=Arabic}/u.test(String(query || "")) ? "ar" : "en";
}
const NON_ENGLISH_WORDS = [
  new Set("der die das den dem des ein eine einen einer einem eines und ist sind war waren geht nicht kein keine mit für auf von zum zur im am ich wir ihr wie warum was wer wo wenn aber auch noch mehr heute morgen gestern jetzt dieser diese dieses weil kann können wird werden wurde wurden muss müssen kannst hat haben habe bin bist seid sein waren folge teil neue besten beste über unter dir euch mich dich uns guten gute nacht ärzte arzte deutschland deutschlands herzlich willkommen schön schöne schöner wunderschön wunderschoen liebe lieber liebt leben welt zeit menschen immer wieder zusammen allein nichts alles einfach sehr morgen kinder leute musik lied lieder sänger saenger song songs nachrichten tagesschau bundesliga fußball fussball spiel spiele spielt spielen tor tore gewinnen verloren meister saison".split(" ")),
  new Set("le la les des du et est sont une un avec pour dans sur pas je tu vous nous que qui comment pourquoi aujourd français française nouvelle nouveau meilleur meilleure chanson paroles musique vidéo cette ces".split(" ")),
  new Set("el los las del y es son una uno un con para que por como hoy qué cómo español española nuevo nueva mejor mejores música canción canciones gracias porque también está están niños niñas esta este".split(" ")),
  new Set("il lo gli della delle del è un una che con per non sono cosa come oggi italiano italiana migliore migliori nuovo nuova canzone canzoni perché questa questo".split(" ")),
  new Set("o os as do da dos das um uma com para que por como não você vocês está estão hoje português brasileiro brasileira melhor novo nova música canção".split(" ")),
  new Set("het een van voor met niet zijn deze dit waarom ook naar hoe wat nederlands nederland".split(" ")),
  new Set("için değil nasıl neden çok bugün türkçe şarkı şarkıları yeni ve".split(" ")),
  new Set("jest nie jak dla się polski polska które który nowy nowa bardzo dlaczego".split(" ")),
  new Set("och det är inte för med som på till svenska varför".split(" ")),
  new Set("og det er ikke for med som på til dansk norsk hvorfor".split(" ")),
  new Set("ja on ei että mitä miten miksi suomi".split(" ")),
  new Set("je se pro že jak český čeština nový nová".split(" "))
];
const NON_ENGLISH_STRONG_WORDS = new Set(
  "und nicht fußball fußballer straße deutsch deutsche deutschen deutschland deutschlands herzlich willkommen guten gute nacht ärzte arzte tagesschau nachrichten bundesliga schlager wunderschön wunderschoen französ français française aujourd español española música canción canciones gracias italiano italiana perché canzone português brasileiro brasileira não você vocês türkçe şarkı değil için polski polska się nederlands nederland svenska varför dansk norsk suomi".split(" ")
);
function isPreferredSearchText(value, language) {
  const text = String(value || "").normalize("NFKC").trim();
  const letters = Array.from(text).filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return false;
  const arabicCount = letters.filter((character) => /\p{Script=Arabic}/u.test(character)).length;
  if (language === "ar") return arabicCount >= 2 && arabicCount / letters.length >= 0.2;
  if (arabicCount || letters.some((character) => !/\p{Script=Latin}/u.test(character))) return false;
  const rawWords = text.toLowerCase().match(/\p{L}+/gu) || [];
  const normalizedWords = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}+/gu) || [];
  const words = new Set([...rawWords, ...normalizedWords]);
  if ([...words].some((word) => NON_ENGLISH_STRONG_WORDS.has(word))) return false;
  for (const markers of NON_ENGLISH_WORDS) {
    let score = 0;
    for (const word of words) if (markers.has(word)) score++;
    if (score >= 2) return false;
  }
  if (/[ßıİşğ]/u.test(text)) return false;
  return true;
}

// Recommendations have no search-query language to infer from. Keep both requested
// languages, English and Arabic, while rejecting titles identified as other languages.
function isPreferredRecommendationText(value) {
  return isPreferredSearchText(value, "en") || isPreferredSearchText(value, "ar");
}

// Search results are ranked, never discarded, by the language evidence in the title.
// Arabic and identifiable English titles rank first. Titles with too little evidence
// stay neutral in the middle tier instead of being guessed from product names
// from a product name such as "RTX 5090".
const ENGLISH_SEARCH_WORDS = new Set(
  "review benchmark unboxing gaming gameplay tutorial explained guide comparison best how the new official setup performance first look build pc video news update full walkthrough trailer specs price launch hands-on hands on test".split(" ")
);
const CONFIRMED_OTHER_LANGUAGE_WORDS = new Set([
  ...NON_ENGLISH_STRONG_WORDS,
  "leistung", "leistungen", "brutale", "praxistest", "anleitung", "bauen",
  "kaufberatung", "vergleich", "vergleichstest", "grafikkarte", "treiber",
  "kuhlung", "kühlung", "übertaktung", "prueba", "reseña", "analisis",
  "análisis", "comparativa", "recensione", "confronto", "migliore",
  "meilleur", "meilleure", "essai"
]);
function languageTier(value) {
  const text = String(value || "").normalize("NFKC").trim();
  const letters = Array.from(text).filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return "neutral";

  const arabicCount = letters.filter((character) => /\p{Script=Arabic}/u.test(character)).length;
  if (arabicCount >= 2 && arabicCount / letters.length >= 0.2) return "preferred";

  // A non-Latin, non-Arabic script is positive evidence of another language.
  if (letters.some((character) =>
    !/\p{Script=Latin}/u.test(character) && !/\p{Script=Arabic}/u.test(character)
  )) return "other";

  const rawWords = text.toLowerCase().match(/\p{L}+/gu) || [];
  const normalizedWords = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().match(/\p{L}+/gu) || [];
  const words = new Set([...rawWords, ...normalizedWords]);

  if ([...words].some((word) => CONFIRMED_OTHER_LANGUAGE_WORDS.has(word))) return "other";
  if (/\bim\s+(?:test|vergleich|benchmark)\b|\b(?:praxistest|anleitung|kaufberatung|brutale\s+leistung)\b/i.test(text)) {
    return "other";
  }
  for (const markers of NON_ENGLISH_WORDS) {
    let score = 0;
    for (const word of words) if (markers.has(word)) score++;
    if (score >= 2) return "other";
  }
  if ([...words].some((word) => ENGLISH_SEARCH_WORDS.has(word))) return "preferred";
  return "neutral";
}
function rankByLanguage(items, getTitle) {
  return items
    .map((item, index) => ({ item, index, tier: languageTier(getTitle(item)) }))
    .sort((a, b) => ({ preferred: 0, neutral: 1, other: 2 })[a.tier] -
      ({ preferred: 0, neutral: 1, other: 2 })[b.tier] || a.index - b.index)
    .map((entry) => entry.item);
}

async function fetchPipedFromHost(host, path, language = "en") {
  try {
    return await timedFetch("https://" + host + path, {
      method: "GET",
      headers: privacyHeaders("application/json", language),
      redirect: "manual"
    }, PIPED_TIMEOUT_MS, async (response) => {
      if (!response.ok) return { ok: false, failure: await providerFailure(host, response) };
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return { ok: false, failure: { host, status: response.status, reason: "non-json" } };
      }
      const text = await response.text();
      if (text.length > MAX_JSON_CHARS) return { ok: false, failure: { host, status: "too-large" } };
      let data;
      try { data = JSON.parse(text); }
      catch { return { ok: false, failure: { host, status: "invalid-json" } }; }
      return { ok: true, host, data };
    });
  } catch (error) {
    return {
      ok: false,
      undelivered: !(error && error.name === "AbortError"),
      failure: { host, status: error && error.name === "AbortError" ? "timeout" : "network-error" }
    };
  }
}

// One provider at a time (see hedgedRace): the request is not broadcast.
async function fetchPiped(path, validate, language = "en") {
  return hedgedRace(PIPED_HOSTS, async (host) => {
    const result = await fetchPipedFromHost(host, path, language);
    if (!result.ok) return result;
    if (!validate(result.data)) return { ok: false, failure: { host, status: "unexpected-data" } };
    return { ok: true, host, data: result.data };
  }, { group: "piped", maxAttempts: PIPED_MAX_ATTEMPTS });
}



function pipedSearchPath(url) {
  const params = new URLSearchParams();
  const nextpage = one(url, "nextpage");
  if (nextpage) params.set("nextpage", nextpage);
  params.set("q", one(url, "q"));
  params.set("filter", "videos");
  return (nextpage ? "/nextpage/search?" : "/search?") + params.toString();
}

async function proxyPipedSearch(url) {
  const path = pipedSearchPath(url);
  const language = preferredSearchLanguage(one(url, "q"));
  const result = await fetchPiped(
    path,
    (data) => !!data && typeof data === "object" && !Array.isArray(data) && Array.isArray(data.items),
    language
  );
  if (!result.ok) {
    console.warn("[MTube relay] All Piped search providers failed:", result.failures);
    return jsonResponse({ error: "Video search is temporarily unavailable.", ...publicDiagnostics("providers", result.failures) }, 503);
  }
  // Reordering is local to this provider response. Keep every valid result and pass
  // the provider's opaque next-page cursor through unchanged.
  const videos = result.data.items.map(extractPipedVideo).filter(Boolean);
  const items = rankByLanguage(videos, (video) => video.title);
  const nextPage = typeof result.data.nextpage === "string" && result.data.nextpage.length <= 10000
    ? result.data.nextpage : null;
  return jsonResponse({ items, nextPage });
}

async function proxyPipedSuggestions(query) {
  const params = new URLSearchParams({ query });
  const language = preferredSearchLanguage(query);
  const result = await fetchPiped("/suggestions?" + params.toString(), Array.isArray, language);
  if (!result.ok) {
    console.warn("[MTube relay] All Piped suggestion providers failed:", result.failures);
    return jsonResponse({ error: "Search suggestions are temporarily unavailable.", ...publicDiagnostics("providers", result.failures) }, 503);
  }
  const suggestions = rankByLanguage(
    result.data.filter((item) => typeof item === "string"),
    (value) => value
  ).slice(0, 12);
  return jsonResponse({ suggestions });
}


function normalizeStoryboardImageTarget(raw, videoId, upstreamHost) {
  try {
    const base = upstreamHost && INVIDIOUS_HOSTS.includes(upstreamHost)
      ? "https://" + upstreamHost + "/" : undefined;
    const target = base ? new URL(raw, base) : new URL(raw);
    if (target.protocol !== "https:" || target.username || target.password ||
        target.port || target.hash) return null;

    const parts = target.pathname.split("/");
    if (INVIDIOUS_HOSTS.includes(target.hostname)) {
      const authority = parts[2] || "";
      const validAuthority = authority === "i" ||
        (authority.length === 2 && authority[0] === "i" && authority[1] >= "0" && authority[1] <= "9");
      if (parts[1] !== "sb" || !validAuthority || parts[3] !== videoId || !parts[4]) return null;
      target.hostname = authority + ".ytimg.com";
      target.pathname = "/sb/" + videoId + "/" + parts.slice(4).join("/");
    } else {
      if (!isYtImageHost(target.hostname) || parts[1] !== "sb") return null;
      const authority = parts[2] || "";
      if (authority === "i" || /^i[0-9]$/.test(authority)) {
        if (parts[3] !== videoId || !parts[4]) return null;
        target.hostname = authority + ".ytimg.com";
        target.pathname = "/sb/" + videoId + "/" + parts.slice(4).join("/");
      } else if (authority !== videoId || !parts[3]) {
        return null;
      }
    }
    return safeStoryboardTarget(target.href, videoId);
  } catch {
    return null;
  }
}

function relayStoryboardTemplate(raw, videoId, upstreamHost) {
  const target = normalizeStoryboardImageTarget(raw, videoId, upstreamHost);
  if (!target) return null;
  // Keep the signed YouTube image URL direct, as the original MTube player did.
  // Preserve the literal $M token so the client can select the requested sheet.
  target.pathname = target.pathname.replace(/%24M/gi, "$M");
  return target.href;
}

function storyboardDiagnostic(diag, entry) {
  if (Array.isArray(diag)) diag.push(entry);
}

function storyboardFailureReason(error) {
  return error && error.name === "AbortError" ? "timeout" : "network-error";
}

async function fetchInvidiousJson(host, path, diag) {
  const note = (reason, extra = {}) => storyboardDiagnostic(diag, {
    source: "invidious", host, path: path.split("?")[0], reason, ...extra
  });
  try {
    return await timedFetch("https://" + host + path, {
      method: "GET",
      headers: privacyHeaders("application/json"),
      redirect: "manual"
    }, STORYBOARD_PROVIDER_TIMEOUT_MS, async (upstream) => {
      const status = upstream.status;
      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      if (status >= 300 && status < 400) {
        let redirectHost = "";
        try { redirectHost = new URL(upstream.headers.get("location") || "").hostname; } catch {}
        note("redirect", { status, redirectHost });
        return null;
      }
      if (!upstream.ok) {
        note("http-error", { status, contentType: contentType.slice(0, 60) });
        return null;
      }
      if (!contentType.startsWith("application/json")) {
        note("not-json", { status, contentType: contentType.slice(0, 60) });
        return null;
      }
      const body = await upstream.text();
      if (!body) {
        note("empty-body", { status });
        return null;
      }
      if (body.length > MAX_JSON_CHARS) {
        note("too-large", { status, bytes: body.length });
        return null;
      }
      try { return JSON.parse(body); }
      catch {
        note("invalid-json", { status, bytes: body.length });
        return null;
      }
    });
  } catch (error) {
    note(storyboardFailureReason(error));
    return null;
  }
}

function normalizeStoryboardBoards(sourceBoards, videoId, upstreamHost) {
  if (!Array.isArray(sourceBoards)) return [];
  return sourceBoards.map((board) => {
    if (!board) return null;
    const width = Number(board.width), height = Number(board.height);
    const count = Math.floor(Number(board.count));
    const columns = Math.floor(Number(board.storyboardWidth));
    const rows = Math.floor(Number(board.storyboardHeight));
    const templateUrl = typeof board.templateUrl === "string" ? relayStoryboardTemplate(board.templateUrl, videoId, upstreamHost) : null;
    const interval = Number(board.interval);
    const storyboardCount = Math.floor(Number(board.storyboardCount)) || Math.ceil(count / (columns * rows));
    if (!templateUrl || !(width > 0) || !(height > 0) || !(count > 0) ||
        !Number.isFinite(interval) || interval < 0 || !(columns > 0) || !(rows > 0) || !(storyboardCount > 0)) return null;
    if (storyboardCount > 1 && board.templateUrl.indexOf("$M") < 0 && !/%24M/i.test(board.templateUrl)) return null;
    return {
      width, height, count, interval,
      storyboardWidth: columns,
      storyboardHeight: rows,
      storyboardCount,
      templateUrl
    };
  }).filter(Boolean).sort((a,b) => b.width - a.width);
}


function isDigits(value) {
  return typeof value === "string" && value.length > 0 &&
    [...value].every((character) => character >= "0" && character <= "9");
}

function parseStoryboardVttTime(value) {
  const parts = String(value || "").trim().split(":");
  if (parts.length !== 3 || !isDigits(parts[0]) || !isDigits(parts[1])) return null;
  const secondsParts = parts[2].split(".");
  if (secondsParts.length > 2 || secondsParts[0].length !== 2 || !isDigits(secondsParts[0])) return null;
  if (secondsParts[1] !== undefined && (!isDigits(secondsParts[1]) || secondsParts[1].length > 3)) return null;
  const hours = Number(parts[0]), minutes = Number(parts[1]), seconds = Number(secondsParts[0]);
  const milliseconds = Number((secondsParts[1] || "").padEnd(3, "0"));
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function parseStoryboardVttCues(body, videoId, upstreamHost) {
  if (!INVIDIOUS_HOSTS.includes(upstreamHost)) return [];
  if (typeof body !== "string" || body.length > MAX_JSON_CHARS) return [];
  const lines = body.replace(/^\uFEFF/, "").split(/\r?\n/);
  const cues = [];

  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow < 0) continue;
    const leftTime = lines[i].slice(0, arrow).trim().split(/\s+/)[0];
    const rightTime = lines[i].slice(arrow + 3).trim().split(/\s+/)[0];
    const start = parseStoryboardVttTime(leftTime);
    const end = parseStoryboardVttTime(rightTime);
    if (start === null || end === null || end <= start) continue;

    let urlLine = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim()) { urlLine = lines[j].trim(); i = j; break; }
    }
    if (!urlLine) continue;

    try {
      const image = new URL(urlLine, "https://" + upstreamHost);
      if (!image.hash.startsWith("#xywh=")) continue;
      const crop = image.hash.slice(6).split(",");
      if (crop.length !== 4 || !crop.every(isDigits)) continue;
      image.hash = "";

      const safe = normalizeStoryboardImageTarget(image.href, videoId, upstreamHost);
      if (!safe) continue;
      const url = relayStoryboardTemplate(safe.href, videoId);
      if (!url) continue;
      const x = Number(crop[0]), y = Number(crop[1]), w = Number(crop[2]), h = Number(crop[3]);
      if (!(w > 0) || !(h > 0)) continue;
      cues.push({ start, end, url, x, y, w, h });
    } catch {}
  }
  return cues;
}

async function proxyStoryboardVtt(videoId, width, height, region = "JO") {
  const upstreamPath = "/api/v1/storyboards/" + videoId + "?width=" + width + "&height=" + height + "&region=" + region;
  const result = await hedgedRace(INVIDIOUS_HOSTS, async (host) => {
    try {
      return await timedFetch("https://" + host + upstreamPath, {
        method: "GET",
        headers: privacyHeaders("text/vtt, text/plain;q=0.9, */*;q=0.1"),
        redirect: "manual"
      }, STORYBOARD_PROVIDER_TIMEOUT_MS, async (upstream) => {
        const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
        const fail = (reason) => ({
          ok: false,
          failure: {
            host, status: upstream.status, reason,
            ...(contentType ? { contentType: contentType.slice(0, 60) } : {})
          }
        });
        if (!upstream.ok) return fail("http-error");
        const body = await upstream.text();
        // Validate the payload signature. Current Invidious source emits text/vtt
        // for this route, while the signature check tolerates differing instance headers.
        if (!/^\uFEFF?\s*WEBVTT(?:\s|$)/i.test(body)) return fail(body ? "not-webvtt" : "empty-body");
        const cues = parseStoryboardVttCues(body, videoId, host);
        if (!cues.length) return fail("no-valid-cues");
        return { ok: true, cues };
      });
    } catch (error) {
      return { ok: false, failure: { host, status: 0, reason: storyboardFailureReason(error) } };
    }
  }, { group: "invidious" });
  if (result.ok) return jsonResponse(result.cues);
  console.warn("[MTube relay] Storyboard VTT unavailable for", videoId, result.failures);
  return jsonResponse({
    error: "Storyboard preview frames are temporarily unavailable.",
    ...publicDiagnostics("providers", result.failures)
  }, 503);
}

async function fetchStoryboardFromInvidious(videoId, path, diag) {
  // Ask the allowlisted instances one at a time (hedged, not broadcast). A response
  // only wins when its storyboard templates are actually usable, not merely non-empty.
  const result = await hedgedRace(INVIDIOUS_HOSTS, async (host) => {
    const data = await fetchInvidiousJson(host, path, diag);
    if (!data) return { ok: false, failure: { host, status: "no-data" } };
    const rawBoards = Array.isArray(data.storyboards) ? data.storyboards.length : 0;
    const boards = normalizeStoryboardBoards(data.storyboards, videoId, host);
    if (!boards.length) {
      storyboardDiagnostic(diag, {
        source: "invidious", host, path: path.split("?")[0],
        reason: rawBoards ? "templates-rejected" : "no-storyboards-in-json",
        rawBoards
      });
      // The provider answered correctly; the video just has no usable sprite sheets.
      return { ok: false, soft: true, failure: { host, status: "no-storyboards" } };
    }
    return { ok: true, boards };
  }, { group: "invidious", maxAttempts: 3 });
  return result.ok ? result.boards : [];
}

async function fetchInvidiousStoryboards(videoId, region = "JO", diag) {
  // Match the original MTube source: Invidious video JSON carries the storyboard array.
  const videoBoards = await fetchStoryboardFromInvidious(
    videoId, "/api/v1/videos/" + videoId + "?hl=en&region=" + region, diag
  );
  if (videoBoards.length) return videoBoards;
  // Some instances expose storyboard metadata only through this dedicated endpoint.
  const dedicatedBoards = await fetchStoryboardFromInvidious(
    videoId, "/api/v1/storyboards/" + videoId + "?region=" + region, diag
  );
  if (dedicatedBoards.length) return dedicatedBoards;
  // Invidious can return an empty 200 when a video has no storyboard object.
  // Use YouTube's own player response as an independent final source.
  return fetchYouTubeStoryboards(videoId, diag);
}

function extractJsonObjectAt(source, start) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index++;
  if (source[index] !== "{") return null;
  const objectStart = index;
  let depth = 0, inString = false, escaped = false;
  for (; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(source.slice(objectStart, index + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function extractYouTubePlayerResponse(html) {
  const markers = [
    /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/,
    /window\s*\[\s*["']ytInitialPlayerResponse["']\s*\]\s*=\s*/
  ];
  for (const marker of markers) {
    const match = marker.exec(html);
    if (!match) continue;
    const response = extractJsonObjectAt(html, match.index + match[0].length);
    if (response && typeof response === "object") return response;
  }
  return null;
}

function parseYouTubeStoryboardSpec(rawSpec, videoId) {
  if (typeof rawSpec !== "string" || rawSpec.length > 100000) return [];
  const segments = rawSpec.split("|");
  const base = segments.shift();
  if (!base || !segments.length) return [];
  const parsedBoards = [];
  for (let index = 0; index < segments.length; index++) {
    const fields = segments[index].split("#");
    if (fields.length < 8) continue;
    const [widthRaw, heightRaw, countRaw, columnsRaw, rowsRaw, intervalRaw, name, signature] = fields;
    const width = Number(widthRaw), height = Number(heightRaw);
    const count = Math.floor(Number(countRaw));
    const columns = Math.floor(Number(columnsRaw)), rows = Math.floor(Number(rowsRaw));
    const interval = Number(intervalRaw);
    if (!(width > 0) || !(height > 0) || !(count > 0) ||
        !(columns > 0) || !(rows > 0) || !Number.isFinite(interval) || interval < 0 ||
        !name || !signature) continue;
    try {
      const template = new URL(base);
      if (template.protocol !== "https:" || !isYtImageHost(template.hostname) ||
          !template.pathname.startsWith("/sb/" + videoId + "/")) continue;
      template.pathname = template.pathname.replace("$L", String(index)).replace("$N", name);
      if (template.pathname.includes("$L") || template.pathname.includes("$N")) continue;
      template.searchParams.set("sigh", signature);
      const templateUrl = template.href.replace(/%24M/gi, "$M");
      parsedBoards.push({
        templateUrl, width, height, count, interval,
        storyboardWidth: columns, storyboardHeight: rows,
        storyboardCount: Math.ceil(count / (columns * rows))
      });
    } catch {}
  }
  return normalizeStoryboardBoards(parsedBoards, videoId);
}

async function fetchYouTubeStoryboards(videoId, diag) {
  const url = "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) + "&hl=en&gl=JO";
  const note = (reason, extra = {}) => storyboardDiagnostic(diag, {
    source: "youtube-watch", reason, ...extra
  });
  try {
    return await timedFetch(url, {
      method: "GET",
      headers: new Headers({
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Cache-Control": "no-cache"
      }),
      redirect: "follow"
    }, 7000, async (upstream) => {
      let finalHost = "";
      try { finalHost = new URL(upstream.url || url).hostname; } catch {}
      const responseInfo = { status: upstream.status, finalHost };
      if (finalHost === "consent.youtube.com") {
        note("consent-redirect", responseInfo);
        return [];
      }
      if (!upstream.ok) {
        note("http-error", responseInfo);
        return [];
      }
      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html")) {
        note("not-html", { ...responseInfo, contentType: contentType.slice(0, 60) });
        return [];
      }
      const html = await upstream.text();
      if (!html || html.length > 8000000) {
        note("bad-html-size", { ...responseInfo, bytes: html ? html.length : 0 });
        return [];
      }
      const playerResponse = extractYouTubePlayerResponse(html);
      if (!playerResponse) {
        note("no-player-response", { ...responseInfo, bytes: html.length });
        return [];
      }
      const playability = playerResponse.playabilityStatus || {};
      const spec = playerResponse.storyboards &&
        playerResponse.storyboards.playerStoryboardSpecRenderer &&
        playerResponse.storyboards.playerStoryboardSpecRenderer.spec;
      if (!spec) {
        note("no-storyboard-spec", {
          ...responseInfo,
          playability: String(playability.status || "").slice(0, 40),
          playabilityReason: String(playability.reason || "").slice(0, 80)
        });
        return [];
      }
      const boards = parseYouTubeStoryboardSpec(spec, videoId);
      if (!boards.length) {
        note("spec-rejected", { ...responseInfo, segments: String(spec).split("|").length - 1 });
        return [];
      }
      note("ok", { ...responseInfo, boards: boards.length });
      return boards;
    });
  } catch (error) {
    note(storyboardFailureReason(error));
    return [];
  }
}

// Piped already returns timeline sprite sheets ("previewFrames") inside the stream
// metadata the relay fetched anyway. Using them means no additional provider has to
// learn which video is being watched. Piped points the sheets at its own image proxy;
// only the signed YouTube path and the two signature parameters are kept, and the
// sheet is rebuilt on YouTube's image host so the normal storyboard validation applies.
function boardsFromPreviewFrames(frames, videoId) {
  if (!Array.isArray(frames)) return [];
  const boards = [];
  for (const frame of frames.slice(0, 8)) {
    if (!frame || !Array.isArray(frame.urls) || !frame.urls.length || frame.urls.length > 64) continue;
    try {
      const sample = new URL(frame.urls[0]);
      if (sample.protocol !== "https:" || sample.username || sample.password || sample.port) continue;
      const match = new RegExp("^/sb/" + videoId + "/([A-Za-z0-9_]{1,40})/M0\\.jpg$").exec(sample.pathname);
      if (!match) continue;
      const requestedHost = sample.searchParams.get("host") || "i.ytimg.com";
      const host = /^i[0-9]?\.ytimg\.com$/.test(requestedHost) ? requestedHost : "i.ytimg.com";
      const kept = sample.search.slice(1).split("&").filter((pair) => {
        const equals = pair.indexOf("=");
        return STORYBOARD_QUERY_KEYS.has(equals < 0 ? pair : pair.slice(0, equals)) && pair.length <= 600;
      });
      boards.push({
        templateUrl: "https://" + host + "/sb/" + videoId + "/" + match[1] + "/M$M.jpg" +
          (kept.length ? "?" + kept.join("&") : ""),
        width: Number(frame.frameWidth),
        height: Number(frame.frameHeight),
        count: Number(frame.totalCount),
        interval: Number(frame.durationPerFrame),
        storyboardWidth: Number(frame.framesPerPageX),
        storyboardHeight: Number(frame.framesPerPageY),
        storyboardCount: frame.urls.length
      });
    } catch {}
  }
  return normalizeStoryboardBoards(boards, videoId);
}

async function proxyPipedVideo(videoId, includeStoryboards = true, region = "JO") {
  const result = await fetchPiped("/streams/" + videoId, (data) => !!data &&
    typeof data === "object" && !Array.isArray(data) && typeof data.title === "string");
  const storyboardDiagnostics = [];

  // Prefer the sprite sheets that came with the metadata. Only when they are absent
  // or unusable does the relay ask Invidious (one instance at a time) and, last,
  // YouTube itself. Storyboard data is independent of Piped's stream metadata, so a
  // fully failed Piped lookup does not discard valid fallback boards.
  let storyboards = [];
  let storyboardSource = "";
  if (includeStoryboards && result.ok) {
    storyboards = boardsFromPreviewFrames(result.data.previewFrames, videoId);
    if (storyboards.length) storyboardSource = "piped";
  }
  if (includeStoryboards && !storyboards.length) {
    storyboards = await fetchInvidiousStoryboards(videoId, region, storyboardDiagnostics);
    if (storyboards.length) {
      storyboardSource = storyboardDiagnostics.some((entry) => entry.source === "youtube-watch" && entry.reason === "ok")
        ? "youtube" : "invidious";
    }
  }

  const metadataAvailable = !!result.ok;
  const metadata = metadataAvailable ? result.data : {};
  if (!metadataAvailable) {
    console.warn("[MTube relay] Piped video metadata unavailable; retaining independent storyboard result:", result.failures);
  }

  const lengthSeconds = Math.max(0, Number(metadata.duration) || 0);
  for (const board of storyboards) {
    if (!(board.interval > 0) && lengthSeconds > 0 && board.count > 0) {
      board.interval = (lengthSeconds * 1000) / board.count;
    }
  }
  const related = Array.isArray(metadata.relatedStreams) ? metadata.relatedStreams : [];
  const recommendedVideos = related.map((item) => {
    const video = extractPipedVideo(item);
    if (!video || !isPreferredRecommendationText(video.title)) return null;
    return {
      videoId: video.videoId,
      title: video.title,
      author: video.author,
      lengthSeconds: video.lengthSeconds,
      viewCount: video.viewCount,
      viewCountText: video.viewCountText,
      publishedText: video.publishedText
    };
  }).filter(Boolean).slice(0, 40);

  if (includeStoryboards && !storyboards.length) {
    console.warn("[MTube relay] No storyboard source produced usable boards:", videoId, storyboardDiagnostics);
  }

  return jsonResponse({
    videoId,
    title: String(metadata.title || "").slice(0, 300),
    author: String(metadata.uploader || "").slice(0, 120),
    lengthSeconds,
    genre: "",
    keywords: [],
    storyboards,
    // Exact per-frame cues need one more provider call. The sprite sheets already carry
    // everything the player needs, so the browser asks for cues only when the sheets came
    // from Invidious (which has already seen this video ID). Otherwise it computes frames itself.
    ...(storyboardSource === "invidious" ? { cuesRecommended: true } : {}),
    recommendedVideos,
    ...(metadataAvailable ? {} : {
      metadataAvailable: false,
      ...publicDiagnostics("metadataProviders", result.failures || [])
    }),
    ...(includeStoryboards && !storyboards.length ? publicDiagnostics("storyboardDiagnostics", storyboardDiagnostics) : {})
  });
}

function safeImageRedirect(raw, videoId, type) {
  try {
    const next = new URL(raw);
    if (next.protocol !== "https:" || !isYtImageHost(next.hostname) ||
        next.username || next.password || next.port || next.hash) return null;
    if (type === "storyboard") return safeStoryboardTarget(next.href, videoId);
    if (!new RegExp("^/vi(?:_webp)?/" + videoId + "/[A-Za-z0-9._~$%/+()-]+$").test(next.pathname)) return null;
    return next;
  } catch {
    return null;
  }
}

async function proxyImage(target, videoId, type) {
  let current = target;
  for (let hop = 0; hop <= 3; hop++) {
    const abortController = new AbortController();
    let finished = false;
    let streamController = null;
    let reader = null;
    const timeout = setTimeout(() => {
      if (finished) return;
      abortController.abort();
      if (reader) reader.cancel().catch(() => {});
      if (streamController) {
        try { streamController.error(new Error("Image request timed out.")); } catch {}
      }
    }, 7000);
    try {
      const upstream = await fetch(current.href, {
        method: "GET",
        headers: privacyHeaders("image/avif,image/webp,image/apng,image/*,*/*;q=0.8"),
        redirect: "manual",
        cf: { cacheEverything: true, cacheTtl: 86400 },
        signal: abortController.signal
      });
      if ([301,302,303,307,308].includes(upstream.status)) {
        clearTimeout(timeout);
        const location = upstream.headers.get("location");
        const next = location ? safeImageRedirect(new URL(location, current).href, videoId, type) : null;
        try { await upstream.body?.cancel(); } catch {}
        if (!next) return errorResponse("Unsafe image redirect.", 502);
        current = next;
        continue;
      }
      if (!upstream.ok) {
        clearTimeout(timeout);
        try { await upstream.body?.cancel(); } catch {}
        return errorResponse("Image unavailable.", 502);
      }
      const contentType = upstream.headers.get("content-type") || "";
      if (!/^image\/(?:jpeg|jpg|png|webp|avif)$/i.test(contentType)) {
        clearTimeout(timeout);
        try { await upstream.body?.cancel(); } catch {}
        return errorResponse("Unexpected image response.", 502);
      }
      const declaredLength = Number(upstream.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        clearTimeout(timeout);
        try { await upstream.body?.cancel(); } catch {}
        return errorResponse("Image too large.", 502);
      }
      if (!upstream.body) {
        clearTimeout(timeout);
        return errorResponse("Image unavailable.", 502);
      }

      // Stream the image to the browser as Cloudflare receives it. Buffering the
      // entire sprite first added a second full transfer delay to the first preview.
      // Count streamed bytes to retain the existing 4 MB response-size ceiling.
      reader = upstream.body.getReader();
      let totalBytes = 0;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              finished = true;
              clearTimeout(timeout);
              controller.close();
              return;
            }
            totalBytes += chunk.value.byteLength;
            if (totalBytes > MAX_IMAGE_BYTES) {
              finished = true;
              clearTimeout(timeout);
              abortController.abort();
              try { await reader.cancel(); } catch {}
              controller.error(new Error("Image too large."));
              return;
            }
            controller.enqueue(chunk.value);
          } catch (error) {
            finished = true;
            clearTimeout(timeout);
            try { controller.error(error); } catch {}
          }
        },
        async cancel(reason) {
          finished = true;
          clearTimeout(timeout);
          abortController.abort();
          try { await reader.cancel(reason); } catch {}
        }
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400, s-maxage=86400",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Referrer-Policy": "no-referrer"
        }
      });
    } catch {
      clearTimeout(timeout);
      finished = true;
      try { await reader?.cancel(); } catch {}
      return errorResponse("Image unavailable.", 502);
    }
  }
  return errorResponse("Too many image redirects.", 502);
}

async function proxyOEmbed(videoId) {
  const target = "https://www.youtube.com/oembed?format=json&url=" +
    encodeURIComponent("https://www.youtube.com/watch?v=" + videoId);
  try {
    return await timedFetch(target, {
      method: "GET",
      headers: privacyHeaders("application/json"),
      redirect: "manual"
    }, 7000, async (upstream) => {
      if (!upstream.ok || !/^application\/json(?:\s*;|$)/i.test(upstream.headers.get("content-type") || "")) {
        return errorResponse("Video title unavailable.", 502);
      }
      const text = await upstream.text();
      if (text.length > 100000) return errorResponse("Video title unavailable.", 502);
      const data = JSON.parse(text);
      if (!data || typeof data.title !== "string" || data.title.length > 300) {
        return errorResponse("Video title unavailable.", 502);
      }
      return jsonResponse({ title: data.title });
    });
  } catch {
    return errorResponse("Video title unavailable.", 502);
  }
}

function routeCost(route) {
  if (route === "v1/search") return 3;
  if (route === "v1/search/suggestions") return 1;
  if (route.startsWith("v1/storyboards/")) return 2;
  if (route.startsWith("v1/videos/")) return 5;
  if (route === "storyboard" || route === "youtube/oembed" || route.startsWith("thumb/")) return 0.25;
  return 1;
}

export async function handleApiRequest(request, env = {}) {
  if (request.method !== "GET") return errorResponse("Method not allowed.", 405);
  diagnosticsEnabled = !!env && env.EXPOSE_DIAGNOSTICS === "1";

  const url = new URL(request.url);
  const siteOrigin = configuredSiteOrigin(env);
  // Accept the production project hostname and Cloudflare Pages preview subdomains
  // belonging to this exact Pages project. Preview deployments use unique hosts.
  if (!isAllowedSiteOrigin(url, siteOrigin)) return errorResponse("Not found.", 404);

  const origin = request.headers.get("Origin");
  if (origin) {
    let parsedOrigin;
    try { parsedOrigin = new URL(origin); }
    catch { return errorResponse("Forbidden.", 403); }
    if (!isAllowedSiteOrigin(parsedOrigin, siteOrigin) || parsedOrigin.origin !== url.origin) {
      return errorResponse("Forbidden.", 403);
    }
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return errorResponse("Forbidden.", 403);

  const route = url.pathname.startsWith("/api/") ? url.pathname.slice(5) : "";

  const wait = rateLimitWait(request, routeCost(route));
  if (wait) return errorResponse("Too many requests. Please slow down.", 429, { "Retry-After": String(wait) });

  // The public health route is static and touches no upstream. The deep probe contacts
  // every provider, so it is an operator tool: it needs the HEALTH_TOKEN secret.
  if (route === "health" && url.search === "") return jsonResponse({ function: "ok", version: RELAY_VERSION });
  if (route === "piped-health" && url.search === "") {
    if (!safeEqual(request.headers.get("X-Health-Token") || "", env && env.HEALTH_TOKEN)) {
      return errorResponse("Not found.", 404);
    }
    return pipedHealthCheck();
  }

  if (route === "v1/search/suggestions") {
    if (!onlyParams(url, ["q"]) || one(url, "q").trim().length < 2 || one(url, "q").length > 100) {
      return errorResponse("Invalid query.", 400);
    }
    return proxyPipedSuggestions(one(url, "q").trim());
  }

  if (route === "v1/search") {
    const required = ["q", "type", "page", "region", "hl"];
    if (!onlyParams(url, [...required, "nextpage"], required) ||
        !one(url, "q").trim() || one(url, "q").length > 200 ||
        one(url, "type") !== "video" ||
        !/^[1-9][0-9]{0,2}$/.test(one(url, "page")) || Number(one(url, "page")) > 100 ||
        !/^[A-Z]{2}$/.test(one(url, "region")) || one(url, "hl") !== preferredSearchLanguage(one(url, "q")) ||
        one(url, "nextpage").length > 10000 ||
        (Number(one(url, "page")) > 1 && !one(url, "nextpage"))) {
      return errorResponse("Invalid search request.", 400);
    }
    return proxyPipedSearch(url);
  }

  const storyboardVttPrefix = "v1/storyboards/";
  if (route.startsWith(storyboardVttPrefix)) {
    const videoId = route.slice(storyboardVttPrefix.length);
    const width = one(url, "width"), height = one(url, "height");
    const region = url.searchParams.has("region") ? one(url, "region") : "JO";
    if (!VIDEO_ID.test(videoId) || !onlyParams(url, ["width", "height", "region"], ["width", "height"]) ||
        !/^[1-9][0-9]{0,3}$/.test(width) || !/^[1-9][0-9]{0,3}$/.test(height) ||
        Number(width) > 2048 || Number(height) > 2048 || !/^[A-Z]{2}$/.test(region)) {
      return errorResponse("Invalid storyboard dimensions.", 400);
    }
    return proxyStoryboardVtt(videoId, Number(width), Number(height), region);
  }

  const videoMatch = /^v1\/videos\/([A-Za-z0-9_-]{11})$/.exec(route);
  if (videoMatch) {
    const videoId = videoMatch[1];
    if (!onlyParams(url, ["fields", "hl", "region"]) ||
        ![FULL_VIDEO_FIELDS, RECOMMENDED_FIELDS].includes(one(url, "fields")) ||
        one(url, "hl") !== "en" || !/^[A-Z]{2}$/.test(one(url, "region"))) {
      return errorResponse("Invalid video metadata request.", 400);
    }
    return proxyPipedVideo(videoId, one(url, "fields") === FULL_VIDEO_FIELDS, one(url, "region"));
  }

  const thumbMatch = /^thumb\/([A-Za-z0-9_-]{11})$/.exec(route);
  if (thumbMatch && url.search === "") {
    const id = thumbMatch[1];
    return proxyImage(new URL("https://i.ytimg.com/vi/" + id + "/mqdefault.jpg"), id, "thumbnail");
  }

  if (route === "storyboard" && onlyParams(url, ["url"])) {
    const raw = one(url, "url");
    let target, match;
    try {
      match = /^https:\/\/[^/]+\/sb\/(?:i\d?\/)?([A-Za-z0-9_-]{11})\//.exec(raw);
      if (!match) return errorResponse("Invalid storyboard URL.", 400);
      target = safeStoryboardTarget(raw, match[1]);
    } catch {
      target = null;
    }
    if (!target || !match) return errorResponse("Invalid storyboard URL.", 400);
    return proxyImage(target, match[1], "storyboard");
  }

  if (route === "youtube/oembed" && onlyParams(url, ["videoId"])) {
    const videoId = one(url, "videoId");
    if (!isVideoId(videoId)) return errorResponse("Invalid video ID.", 400);
    return proxyOEmbed(videoId);
  }

  return errorResponse("Not found.", 404);
}
