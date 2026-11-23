import test, { beforeEach } from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { handleApiRequest, resetRelayState } from "../functions/_lib/relay.js";
import { onRequest as healthRoute } from "../functions/api/health.js";
import { onRequest as searchRoute } from "../functions/api/v1/search.js";
import { onRequest as suggestionsRoute } from "../functions/api/v1/search/suggestions.js";
import { onRequest as videoRoute } from "../functions/api/v1/videos/[id].js";
import { onRequest as storyboardVttRoute } from "../functions/api/v1/storyboards/[id].js";
import { onRequest as thumbRoute } from "../functions/api/thumb/[id].js";
import { onRequest as storyboardRoute } from "../functions/api/storyboard.js";
import { onRequest as oembedRoute } from "../functions/api/youtube/oembed.js";
import pagesWorker from "../dist/_worker.js";
const onRequest = (context) => handleApiRequest(context.request);

const SITE = "https://cloude-test.pages.dev";
const originalFetch = globalThis.fetch;

// Provider health and rate-limit memory is module state; every test starts clean.
beforeEach(() => resetRelayState());

function context(path, headers = {}, method = "GET") {
  return {
    request: new Request(SITE + path, {
      method,
      headers: { "Sec-Fetch-Site": "same-origin", ...headers }
    })
  };
}

test("player preserves the original pointer-event interaction model", async () => {
  const css = await readFile(new URL("../style.css", import.meta.url), "utf8");
  assert.ok(css.includes("#stage{position:fixed;inset:0;background:#000;overflow:hidden;direction:ltr;touch-action:none;z-index:5;-webkit-user-select:none!important;"));
  assert.ok(css.includes("#slide{position:absolute;inset:0;pointer-events:none!important}"));
  assert.ok(css.includes("#touch{position:absolute;inset:0;z-index:2;display:block;pointer-events:auto;touch-action:none;"));
  assert.ok(css.includes("#stage *{-webkit-user-select:none!important;user-select:none!important;-webkit-touch-callout:none!important;"));
  assert.ok(css.includes("#slide{position:absolute;inset:0;pointer-events:none!important}"));
  assert.ok(css.includes("#slide iframe{position:absolute;border:0;background:#000;pointer-events:none!important;"));

  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes("t.addEventListener('pointerdown'"));
  assert.ok(app.includes("t.addEventListener('pointerup'"));
  assert.ok(app.includes("t.addEventListener('pointercancel'"));
  assert.ok(!app.includes("stage.addEventListener('selectstart'"));
  assert.ok(!app.includes("stage.addEventListener('contextmenu'"));
  assert.ok(app.includes("document.addEventListener('selectstart',blockPlayerSelection,true)"));
  assert.ok(app.includes("document.addEventListener('contextmenu',blockPlayerSelection,true)"));
  assert.ok(app.includes("document.addEventListener('dragstart',blockPlayerSelection,true)"));
  assert.ok(app.includes("document.addEventListener('selectionchange'"));
  assert.ok(app.includes("if(e.pointerType!=='mouse'&&e.cancelable)e.preventDefault();"));
  assert.ok(app.includes("seekMetadataWaitId!==previewVideoId"));
  assert.ok(!app.includes("function ensureStoryboardMetadata"), "metadata comes from the relay only; there is no browser-side provider fallback");
  assert.ok(app.includes("function requestStoryboardPreviewData(id)"), "hover must retry storyboard metadata when no frame was returned");
  assert.ok(app.includes("if(!frame&&!pendingInfo)pendingInfo=requestStoryboardPreviewData(previewVideoId)"));
  assert.ok(app.includes("var storyboardCueRequests=Object.create(null);"), "VTT requests need a defined per-video in-flight cache");
  assert.ok(app.includes("function ensureStoryboardCues(id,data)"));
  assert.ok(app.includes("return ensureStoryboardCues(id,data);"), "video metadata must finish by loading the exact VTT cues");
  const storyboardAt = app.slice(app.indexOf("function storyboardAt(id,seconds){"), app.indexOf("function finishStoryboardImageLoad"));
  assert.ok(storyboardAt.includes("target>=+cue.start&&target<+cue.end"), "hover seconds must select the matching VTT cue");
  const showPreview = app.slice(app.indexOf("function showSeekPreview(e){"), app.indexOf("function tap(x){"));
  assert.ok(showPreview.includes("seekHover&&lastSeekPreviewEvent"), "late storyboard metadata must repaint the currently hovered time");

  assert.ok(!app.includes("directStoryboardImageUrl"), "the browser no longer resolves provider-hosted sprite URLs itself");
  assert.ok(!app.includes("fetchDirectStoryboard"), "the browser never queries a metadata provider directly");
  assert.ok(app.includes("function drawStoryboardPreview(frame,thumb,tw)"));
  const drawPreview = app.slice(app.indexOf("function drawStoryboardPreview(frame,thumb,tw){"), app.indexOf("\n  var lastSeekPreviewEvent=null"));
  assert.ok(app.includes("function ensureStoryboardCues(id,data)"));
  assert.ok(app.includes("function enrichStoryboardData(id,data)"));
  assert.ok(app.includes("data.storyboardCues"));
  assert.ok(drawPreview.includes("thumb._storyboardFrame=frame"), "the latest hovered frame must win while one sprite is loading");
  assert.ok(drawPreview.includes("if(!entry.loaded)"), "do not crop a sprite until its real image dimensions are available");
  assert.ok(!app.includes("drawSeekThumbnailFallback"), "do not disguise a failed storyboard with the static video thumbnail");
   assert.ok(app.includes("function storyboardImageFallbackUrl(raw,id)"));
   assert.ok(app.includes("function finishStoryboardImageLoad(entry,frame,thumb,tw,key)"));
   assert.ok(app.includes("var fallback=storyboardImageFallbackUrl(key,frame.videoId)"));
   assert.ok(app.includes("entry.fallbackTried=true"));
   assert.ok(app.includes("u.searchParams.getAll('url').length!==1"));
  assert.ok(!app.includes("t.addEventListener('touchstart'"));
  assert.ok(!app.includes("t.addEventListener('touchmove'"));
  assert.ok(app.includes("trk.addEventListener('pointerdown'"));
  assert.ok(app.includes("trk.addEventListener('pointermove'"));
  assert.ok(app.includes("trk.addEventListener('pointerup'"));
  assert.ok(app.includes("trk.addEventListener('pointercancel'"));
  assert.ok(app.includes("trk.addEventListener('lostpointercapture'"));
  assert.ok(!app.includes("trk.addEventListener('touchstart'"));
  assert.ok(!app.includes("trk.addEventListener('touchmove'"));
  assert.ok(app.includes("serviceWorker.register(swUrl,{updateViaCache:'none'})"));
  assert.ok(app.includes("createPolicy('mtube-sw'"), "Trusted Types must not silently block service-worker registration");

  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(html.includes('<div id="touch"></div>'));
  assert.ok(!html.includes('<button id="touch"'));
  assert.ok(html.includes("style.css?v=71"));
  assert.ok(html.includes("app.js?v=71"));

  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes("malek-tube-shell-v71"));
});

test("preloads the first storyboard sprite as soon as current video metadata is available", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const preload = app.slice(
    app.indexOf("function preloadStoryboardPreview(id){"),
    app.indexOf("var lastSeekPreviewEvent=null")
  );
  const videoInfo = app.slice(
    app.indexOf("function loadVideoInfo(id){"),
    app.indexOf("function showListMessage(message)")
  );
  assert.ok(preload.includes("storyboardAt(id,0)"), "warm the initial video-time sprite");
  assert.ok(preload.includes("storyboardPreviewProxyUrl(key,id)"), "warm the image through the same-origin storyboard relay first");
  assert.ok(preload.includes("entry.image.src=proxyUrl"), "start the same-origin image request before the first seek");
  assert.ok(preload.includes("entry.image.onerror"), "keep the existing direct-image fallback if the relay image request fails");
  assert.ok(preload.includes("drawStoryboardPreview(frame,thumb,tw)"), "reuse the existing validated image loader and cache");
  assert.ok(preload.includes("if(!id||id!==currentVideoId||seekHover)return"), "only warm the active video when the timeline is not being used");
  assert.ok(!preload.includes("fetch("), "preloading must not add a new fetch path");
  assert.ok(!preload.includes("https://"), "preloading must not introduce a new external host");
  assert.ok(app.includes("function storyboardPreviewProxyUrl(raw,id)"));
  assert.ok(videoInfo.includes("if(id===currentVideoId)preloadStoryboardPreview(id)"), "start preloading as soon as metadata is received");
  assert.ok(app.includes("var preloadedStoryboardKey=''"), "retain only the active preloaded sheet key");
});

test("YouTube player iframe keeps a restrictive sandbox", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const iframe = html.match(/<iframe\b(?=[^>]*\bid="yt")[^>]*>/i);
  assert.ok(iframe, "the YouTube player iframe must exist");
  const sandbox = iframe[0].match(/\bsandbox="([^"]*)"/i);
  assert.ok(sandbox, "the YouTube player iframe must be sandboxed");
  const capabilities = sandbox[1].trim().split(/\s+/).sort();
  assert.deepEqual(capabilities, ["allow-presentation", "allow-same-origin", "allow-scripts"].sort());
  assert.doesNotMatch(sandbox[1], /\ballow-popups(?:-to-escape-sandbox)?\b/);
  assert.doesNotMatch(sandbox[1], /\ballow-top-navigation(?:-by-user-activation)?\b/);
});

test("page CSP lets the browser talk to this origin only, and header and meta policies agree", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  const header = headers.match(/Content-Security-Policy: ([^\r\n]+)/);
  assert.ok(meta && header, "both the meta tag and the response header must define a CSP");
  assert.match(meta[1], /connect-src 'self';/);
  assert.match(meta[1], /img-src 'self' https:\/\/\*\.ytimg\.com/);
  assert.match(meta[1], /frame-src https:\/\/www\.youtube\.com;/);
  assert.doesNotMatch(meta[1] + header[1], /invidious|chocolatemoo|nadeko|nerdvpn|piped/i, "no provider host may appear in the browser policy");
  // Only frame-ancestors differs: it is ignored in a meta element, so it lives in the header alone.
  assert.equal(header[1].replace("frame-ancestors 'none'; ", ""), meta[1]);
  assert.match(meta[1], /require-trusted-types-for 'script'; trusted-types mtube-sw/);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Permissions-Policy: [^\r\n]*browsing-topics=\(\)/);
});

test("browser never contacts providers directly and keeps only relay-bound requests", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /Try direct connection/);
  assert.doesNotMatch(app, /directApiGet/);
  assert.ok(!app.includes("directStoryboardHosts"));
  assert.ok(!app.includes("mode:'cors'"));
  assert.ok(!app.includes("'https://'+host"));
  assert.ok(app.includes("function drawStoryboardPreview(frame,thumb,tw)"));
  assert.ok(app.includes("if(!isStoryboardImageUrl(url,id))continue;"));
  assert.ok(app.includes("var ytImageHost=u.hostname==='i.ytimg.com'||u.hostname.endsWith('.ytimg.com')"));
  assert.match(app, /function thumbnailUrl\(id\)\s*\{\s*return '\/api\/thumb\/'\+/);
  assert.ok(app.includes("if(!(interval>0))interval=Math.max(1,(+(data.lengthSeconds)||dur||1)*1000/count)"));
  assert.ok(app.includes("Math.ceil(count/perSheet)"));
  assert.ok(app.includes("Math.floor(frameIndex/perSheet)"));
});

test("the personalized feed is opt-in and nothing derived from history is queried while it is off", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.ok(app.includes("var personalizeFeed=ls('personalize')==='1';"));
  assert.ok(app.includes("function feedHistory(){return (privacyMode||!personalizeFeed)?[]:getHist()}"));
  assert.ok(!app.includes("var h=privacyMode?[]:getHist(),excluded"), "the feed must read history through feedHistory() only");
  assert.ok(html.includes('id="personalizeToggle"'));
  assert.ok(app.includes("tr(personalizeFeed?'feedHint':'feedHintOff')"));
});

test("watch history expires and the stored copy is purged at start-up", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes("HISTORY_MAX_AGE_MS=90*24*60*60*1000"));
  assert.ok(app.includes("Date.now()-stamp>HISTORY_MAX_AGE_MS"));
  assert.ok(app.includes("function purgeExpiredHistory()"));
  assert.match(app, /purgeExpiredHistory\(\);\s*renderChips\(\)/);
});

test("rejects cross-origin calls before any upstream request", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=test&type=video&page=1&region=JO&hl=en",
      { Origin: "https://attacker.example" }
    ));
    assert.equal(response.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("allows search and suggestions from Cloudflare Pages preview hosts", async () => {
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (target.pathname === "/suggestions") {
      return new Response(JSON.stringify(["privacy explained"]), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      items: [{
        type: "stream",
        title: "Privacy explained",
        uploaderName: "Example channel",
        duration: 42,
        views: 100,
        url: "/watch?v=dQw4w9WgXcQ"
      }],
      nextpage: null
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const hashedPreview = "https://6b1411df.cloude-test.pages.dev";
    const branchPreview = "https://fix-player-longpress-storybo.cloude-test.pages.dev";
    const suggestions = await handleApiRequest(new Request(
      hashedPreview + "/api/v1/search/suggestions?q=privacy",
      { headers: { Origin: hashedPreview, "Sec-Fetch-Site": "same-origin" } }
    ));
    assert.equal(suggestions.status, 200);
    assert.deepEqual(await suggestions.json(), { suggestions: ["privacy explained"] });

    const search = await handleApiRequest(new Request(
      branchPreview + "/api/v1/search?q=privacy&type=video&page=1&region=JO&hl=en",
      { headers: { Origin: branchPreview, "Sec-Fetch-Site": "same-origin" } }
    ));
    const data = await search.json();
    assert.equal(search.status, 200);
    assert.equal(data.items[0].videoId, "dQw4w9WgXcQ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects non-project preview hosts and mismatched preview origins", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const outside = await handleApiRequest(new Request(
      "https://cloude-test.pages.dev.attacker.example/api/v1/search/suggestions?q=privacy"
    ));
    const mismatched = await handleApiRequest(new Request(
      "https://preview-a.cloude-test.pages.dev/api/v1/search/suggestions?q=privacy",
      { headers: { Origin: "https://preview-b.cloude-test.pages.dev", "Sec-Fetch-Site": "same-origin" } }
    ));
    assert.equal(outside.status, 404);
    assert.equal(mismatched.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not expose arbitrary paths or methods as an open proxy", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const unknown = await onRequest(context("/api/proxy?url=https://example.com"));
    const post = await onRequest(context("/api/v1/search", {}, "POST"));
    assert.equal(unknown.status, 404);
    assert.equal(post.status, 405);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("proxies search through the Piped relay and normalizes its response", async () => {
  const seen = [];
  const seenHeaders = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    seen.push(target);
    seenHeaders.push(new Headers(init.headers));
    return new Response(JSON.stringify({
      items: [{
        type: "stream",
        title: "Piped result",
        uploaderName: "Example channel",
        duration: 123,
        views: 9876,
        uploadedDate: "2 days ago",
        url: "/watch?v=dQw4w9WgXcQ"
      }],
      nextpage: "opaque-next-page"
    }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=privacy&type=video&page=1&region=JO&hl=en",
      {
        Origin: SITE,
        "CF-Connecting-IP": "198.51.100.22",
        "X-Forwarded-For": "198.51.100.22",
        "X-Real-IP": "198.51.100.22",
        Cookie: "session=private",
        Authorization: "Bearer private"
      }
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.items.length, 1);
    assert.deepEqual(data.items[0], {
      videoId: "dQw4w9WgXcQ",
      title: "Piped result",
      author: "Example channel",
      lengthSeconds: 123,
      viewCount: 9876,
      viewCountText: "9876",
      publishedText: "2 days ago",
      type: "video"
    });
    assert.equal(data.nextPage, "opaque-next-page");
    assert.equal(seen.length, 1, "a search phrase is sent to exactly one provider, never broadcast");
    assert.equal(seen.every((url) => PIPED_TEST_HOSTS.includes(url.hostname)), true);
    for (const headers of seenHeaders) {
      assert.equal(headers.has("cf-connecting-ip"), false);
      assert.equal(headers.has("x-forwarded-for"), false);
      assert.equal(headers.has("x-real-ip"), false);
      assert.equal(headers.has("cookie"), false);
      assert.equal(headers.has("authorization"), false);
      assert.equal(headers.has("referer"), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const PIPED_TEST_HOSTS = [
  "pipedapi.kavin.rocks", "api.piped.yt", "pipedapi.drgns.space",
  "pipedapi.ducks.party", "piped-api.codespace.cz", "pipedapi.reallyaweso.me",
  "api.piped.private.coffee", "pipedapi.darkness.services", "pipedapi.nosebs.ru",
  "pipedapi-libre.kavin.rocks", "pipedapi.adminforge.de"
];

test("Piped pagination uses the opaque next-page token and rejects a missing token", async () => {
  const outbound = [];
  globalThis.fetch = async (url) => {
    outbound.push(String(url));
    return new Response(JSON.stringify({
      items: [{ title: "Next result", url: "/watch?v=9bZkp7q19f0", duration: 10 }],
      nextpage: null
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const missing = await onRequest(context(
      "/api/v1/search?q=music&type=video&page=2&region=JO&hl=en",
      { Origin: SITE }
    ));
    assert.equal(missing.status, 400);
    const response = await onRequest(context(
      "/api/v1/search?q=music&type=video&page=2&region=JO&hl=en&nextpage=cursor-token",
      { Origin: SITE }
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(outbound.length, 1, "the next-page token goes to one provider only");
    assert.equal(outbound.every((value) => new URL(value).pathname === "/nextpage/search"), true);
    assert.equal(outbound.every((value) => new URL(value).searchParams.get("nextpage") === "cursor-token"), true);
    assert.equal(data.items[0].videoId, "9bZkp7q19f0");
    assert.equal(data.nextPage, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Piped suggestions are normalized to the app response shape", async () => {
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(PIPED_TEST_HOSTS.includes(target.hostname), true);
    assert.equal(target.pathname, "/suggestions");
    assert.equal(target.searchParams.get("query"), "privacy");
    assert.equal(new Headers(init.headers).get("Accept-Language"), "en-US,en;q=0.9");
    return new Response(JSON.stringify(["privacy", "privacy browser"]), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await onRequest(context("/api/v1/search/suggestions?q=privacy", { Origin: SITE }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions: ["privacy", "privacy browser"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("English suggestions filter German suggestions", async () => {
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(target.pathname, "/suggestions");
    assert.equal(new Headers(init.headers).get("Accept-Language"), "en-US,en;q=0.9");
    return new Response(JSON.stringify(["Fußball spielen", "Best football goals", "Die besten Tore"]), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await onRequest(context("/api/v1/search/suggestions?q=football", { Origin: SITE }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { suggestions: ["Best football goals"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("English search skips German-only providers and filters German titles", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    seen.push(target.hostname);
    assert.equal(new Headers(init.headers).get("Accept-Language"), "en-US,en;q=0.9");
    const isGermanOnly = target.hostname === PIPED_TEST_HOSTS[0];
    const titles = isGermanOnly
      ? ["Die besten Fußball Momente", "Warum ist das so?"]
      : ["Best football moments", "How this game changed everything"];
    return new Response(JSON.stringify({
      items: titles.map((title, index) => ({
        title, url: "/watch?v=" + (index ? "9bZkp7q19f0" : "dQw4w9WgXcQ"), duration: 10
      })),
      nextpage: "english-next-page"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=football&type=video&page=1&region=JO&hl=en",
      { Origin: SITE }
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.items.length, 2);
    assert.equal(data.items.every((item) => !/fußball|\bder\b|\bdie\b|\bdas\b|\bund\b/i.test(item.title)), true);
    assert.equal(data.items[0].title, "Best football moments");
    assert.equal(seen.length, 2, "a provider with no English results is followed by exactly one more");
    assert.notEqual(seen[0], seen[1]);
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("Arabic search sends Arabic preference and returns Arabic titles only", async () => {
  const seenHeaders = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    assert.equal(PIPED_TEST_HOSTS.includes(target.hostname), true);
    seenHeaders.push(new Headers(init.headers).get("Accept-Language"));
    return new Response(JSON.stringify({
      items: [
        { title: "أفضل أهداف كرة القدم", url: "/watch?v=dQw4w9WgXcQ", duration: 10 },
        { title: "Best football highlights", url: "/watch?v=9bZkp7q19f0", duration: 10 }
      ],
      nextpage: null
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=" + encodeURIComponent("كرة القدم") + "&type=video&page=1&region=JO&hl=ar",
      { Origin: SITE }
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].title, "أفضل أهداف كرة القدم");
    assert.equal(seenHeaders.length, 1);
    assert.equal(seenHeaders.every((value) => value === "ar,en;q=0.9"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("search rejects a language code that does not match the query script", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=" + encodeURIComponent("كرة القدم") + "&type=video&page=1&region=JO&hl=en"
    ));
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storyboard VTT route resolves root-relative and absolute URLs to direct YouTube sprite images", async () => {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    requests.push({host: target.hostname, path: target.pathname, headers: new Headers(init.headers)});
    if (target.hostname === "inv.nadeko.net") {
      assert.equal(target.pathname, "/api/v1/storyboards/dQw4w9WgXcQ");
      assert.equal(target.searchParams.get("width"), "160");
      assert.equal(target.searchParams.get("height"), "90");
      assert.equal(target.searchParams.get("region"), "JO");
      return new Response([
        "WEBVTT",
        "",
        "00:00:00.000 --> 00:00:10.000",
        "/sb/i1/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sigh=abc#xywh=160,90,158,90",
        "",
        "00:00:10.000 --> 00:00:20.000",
        "https://inv.nadeko.net/sb/i1/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sigh=abc#xywh=320,90,158,90",
        ""
      ].join("\n"), {status: 200, headers: {"Content-Type": "application/json; charset=utf-8"}});
    }
    return new Response("Not found", {status: 404});
  };
  try {
    const response = await onRequest(context(
      "/api/v1/storyboards/dQw4w9WgXcQ?width=160&height=90&region=JO",
      {Origin: SITE, Cookie: "private=1", "X-Forwarded-For": "198.51.100.22"}
    ));
    const cues = await response.json();
    assert.equal(response.status, 200);
    assert.equal(cues.length, 2);
    assert.deepEqual(cues.map(cue => [cue.start, cue.end, cue.x, cue.y, cue.w, cue.h]), [
      [0, 10, 160, 90, 158, 90],
      [10, 20, 320, 90, 158, 90]
    ]);
    for (const cue of cues) {
      const imageUrl = new URL(cue.url);
      assert.equal(imageUrl.hostname, "i1.ytimg.com");
      assert.equal(imageUrl.pathname, "/sb/dQw4w9WgXcQ/storyboard3_L2/M0.jpg");
      assert.equal(imageUrl.searchParams.get("sigh"), "abc");
      assert.equal(imageUrl.hash, "");
    }
    assert.ok(requests.some(request => request.host === "inv.nadeko.net"));
    assert.equal(requests.every(request =>
      !request.headers.has("cookie") &&
      !request.headers.has("x-forwarded-for") &&
      !request.headers.has("cf-connecting-ip") &&
      !request.headers.has("referer")), true);
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    assert.match(html, /img-src 'self' https:\/\/\*\.ytimg\.com/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("storyboard VTT route rejects invalid dimensions before contacting providers", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const response = await onRequest(context("/api/v1/storyboards/dQw4w9WgXcQ?width=0&height=90"));
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Piped metadata uses regional Invidious video JSON and restores direct YouTube sprite images", async () => {
  const upstreamHeaders = [];
  const invidiousHosts = [
    "inv.nadeko.net", "invidious.nerdvpn.de",
    "yt.chocolatemoo53.com", "invidious.tiekoetter.com"
  ];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url)), headers = new Headers(init.headers);
    upstreamHeaders.push({ host: target.hostname, path: target.pathname, headers });

    if (invidiousHosts.includes(target.hostname) && target.pathname === "/api/v1/videos/dQw4w9WgXcQ") {
      assert.equal(target.searchParams.get("hl"), "en");
      assert.equal(target.searchParams.get("region"), "JO");
      return new Response(JSON.stringify({
        storyboards: target.hostname === "inv.nadeko.net" ? [{
          url: "/api/v1/storyboards/dQw4w9WgXcQ?width=160&height=90",
          templateUrl: "https://i.ytimg.com/sb/i1/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sqp=abc&sigh=def",
          width:160,height:90,count:30,interval:0,storyboardWidth:5,storyboardHeight:5,storyboardCount:2
        }] : []
      }), {status:200,headers:{"Content-Type":"application/json; charset=utf-8"}});
    }

    assert.equal(PIPED_TEST_HOSTS.includes(target.hostname),true);
    assert.equal(target.pathname,"/streams/dQw4w9WgXcQ");
    return new Response(JSON.stringify({
      title:"Video title",uploader:"Uploader",duration:212,
      relatedStreams:[{title:"Related",uploaderName:"Other",duration:50,views:12,url:"/watch?v=9bZkp7q19f0",thumbnail:"https://pipedproxy.example/private.jpg"}]
    }),{status:200,headers:{"Content-Type":"application/json"}});
  };

  try {
    const response=await onRequest(context(
      "/api/v1/videos/dQw4w9WgXcQ?fields=videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&hl=en&region=JO",
      {Origin:SITE,"CF-Connecting-IP":"198.51.100.22","X-Forwarded-For":"198.51.100.22",Cookie:"private=1"}
    ));
    const data=await response.json();
    assert.equal(response.status,200);
    assert.equal(data.title,"Video title");
    assert.equal(data.recommendedVideos[0].videoId,"9bZkp7q19f0");
    assert.equal(data.storyboards.length,1);
    assert.equal(data.storyboards[0].count,30);
    assert.equal(data.storyboards[0].interval,212000/30);
    assert.equal(data.storyboards[0].storyboardCount,2);
    assert.ok(data.storyboards[0].templateUrl.startsWith("https://i1.ytimg.com/sb/dQw4w9WgXcQ/"));

    // The phone loads the signed sheets directly from YouTube's image CDN.
    const sprite0Url=new URL(data.storyboards[0].templateUrl.replace(/\$M/g,"0"));
    const sprite1Url=new URL(data.storyboards[0].templateUrl.replace(/\$M/g,"1"));
    for (const spriteUrl of [sprite0Url,sprite1Url]) {
      assert.equal(spriteUrl.hostname,"i1.ytimg.com");
      assert.ok(spriteUrl.pathname.endsWith(".jpg"));
      assert.ok(spriteUrl.pathname.startsWith("/sb/dQw4w9WgXcQ/"));
      assert.equal(spriteUrl.searchParams.get("sigh"),"def");
      assert.equal(spriteUrl.hash,"");
    }
    assert.ok(sprite0Url.pathname.endsWith("M0.jpg"));
    assert.ok(sprite1Url.pathname.endsWith("M1.jpg"));
    const invidiousRequests = upstreamHeaders.filter(({host}) => invidiousHosts.includes(host));
    assert.ok(invidiousRequests.length > 0);
    assert.equal(invidiousRequests.every(({path}) => path === "/api/v1/videos/dQw4w9WgXcQ"),
      true, "the original Invidious video JSON endpoint supplies valid storyboard templates");
    assert.equal(upstreamHeaders.every(({headers})=>
      !headers.has("cf-connecting-ip")&&!headers.has("x-forwarded-for")&&!headers.has("x-real-ip")&&
      !headers.has("cookie")&&!headers.has("authorization")&&!headers.has("referer")),true);

    assert.ok(sprite0Url.href.includes("sqp=abc") && sprite1Url.href.includes("sqp=abc"));
  } finally {
    globalThis.fetch=originalFetch;
  }
});
test("uses dedicated storyboard JSON only when regional video metadata has no boards", async () => {
  const invidiousHosts = ["inv.nadeko.net", "invidious.nerdvpn.de", "yt.chocolatemoo53.com", "invidious.tiekoetter.com"];
  const routes = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (invidiousHosts.includes(target.hostname)) {
      routes.push(target.pathname);
      if (target.pathname === "/api/v1/videos/dQw4w9WgXcQ") {
        assert.equal(target.searchParams.get("region"), "JO");
        return new Response(JSON.stringify({storyboards: []}), {status: 200, headers: {"Content-Type": "application/json"}});
      }
      if (target.pathname === "/api/v1/storyboards/dQw4w9WgXcQ") {
        assert.equal(target.searchParams.get("region"), "JO");
        assert.equal(target.searchParams.has("width"), false);
        assert.equal(target.searchParams.has("height"), false);
        const boards = target.hostname === "inv.nadeko.net" ? [{
          templateUrl: "https://i.ytimg.com/sb/i/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sigh=fallback",
          width: 160, height: 90, count: 10, interval: 1000, storyboardWidth: 5, storyboardHeight: 2, storyboardCount: 1
        }] : [];
        return new Response(JSON.stringify({storyboards: boards}), {status: 200, headers: {"Content-Type": "application/json"}});
      }
    }
    assert.equal(PIPED_TEST_HOSTS.includes(target.hostname), true);
    assert.equal(target.pathname, "/streams/dQw4w9WgXcQ");
    return new Response(JSON.stringify({title: "Video title", uploader: "Uploader", duration: 10, relatedStreams: []}),
      {status: 200, headers: {"Content-Type": "application/json"}});
  };
  try {
    const response = await onRequest(context(
      "/api/v1/videos/dQw4w9WgXcQ?fields=videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&hl=en&region=JO",
      {Origin: SITE}
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.storyboards.length, 1);
    assert.ok(data.storyboards[0].templateUrl.startsWith("https://i.ytimg.com/sb/dQw4w9WgXcQ/"));
    assert.ok(routes.includes("/api/v1/videos/dQw4w9WgXcQ"));
    assert.ok(routes.includes("/api/v1/storyboards/dQw4w9WgXcQ"));
    assert.ok(routes.indexOf("/api/v1/videos/dQw4w9WgXcQ") < routes.indexOf("/api/v1/storyboards/dQw4w9WgXcQ"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("YouTube player response supplies storyboard metadata when Invidious returns no boards", async () => {
  const invidiousHosts = [
    "inv.nadeko.net", "invidious.nerdvpn.de",
    "yt.chocolatemoo53.com", "invidious.tiekoetter.com"
  ];
  const invidiousPaths = [];
  let youtubeWatchRequests = 0;
  const spec = [
    "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L$L/$N.jpg?sqp=base",
    "160#90#95#5#5#10000#M$M#rs$youtube-signature"
  ].join("|");
  const playerResponse = {
    videoDetails: {videoId: "dQw4w9WgXcQ", lengthSeconds: "950"},
    storyboards: {playerStoryboardSpecRenderer: {spec}}
  };
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (invidiousHosts.includes(target.hostname)) {
      invidiousPaths.push(target.pathname);
      // Reproduce Invidious issue #6018: HTTP 200 with a zero-byte JSON body.
      return new Response("", {
        status: 200, headers: {"Content-Type": "application/json; charset=utf-8"}
      });
    }
    if (target.hostname === "www.youtube.com" && target.pathname === "/watch") {
      youtubeWatchRequests++;
      assert.equal(target.searchParams.get("v"), "dQw4w9WgXcQ");
      assert.equal(target.searchParams.get("gl"), "JO");
      return new Response(
        '<!doctype html><script>var ytInitialPlayerResponse = ' +
          JSON.stringify(playerResponse) + ';</script>',
        {status: 200, headers: {"Content-Type": "text/html; charset=utf-8"}}
      );
    }
    assert.equal(PIPED_TEST_HOSTS.includes(target.hostname), true);
    assert.equal(target.pathname, "/streams/dQw4w9WgXcQ");
    return new Response(JSON.stringify({
      title: "Video title", uploader: "Uploader", duration: 950, relatedStreams: []
    }), {status: 200, headers: {"Content-Type": "application/json"}});
  };
  try {
    const response = await onRequest(context(
      "/api/v1/videos/dQw4w9WgXcQ?fields=videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&hl=en&region=JO",
      {Origin: SITE}
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.storyboards.length, 1);
    const board = data.storyboards[0];
    assert.equal(board.width, 160);
    assert.equal(board.height, 90);
    assert.equal(board.count, 95);
    assert.equal(board.storyboardWidth, 5);
    assert.equal(board.storyboardHeight, 5);
    assert.equal(board.storyboardCount, 4);
    assert.equal(board.interval, 10000);
    const firstSheet = new URL(board.templateUrl.replace(/\$M/g, "0"));
    const fourthSheet = new URL(board.templateUrl.replace(/\$M/g, "3"));
    assert.equal(firstSheet.hostname, "i.ytimg.com");
    assert.equal(firstSheet.pathname, "/sb/dQw4w9WgXcQ/storyboard3_L0/M0.jpg");
    assert.equal(fourthSheet.pathname, "/sb/dQw4w9WgXcQ/storyboard3_L0/M3.jpg");
    assert.equal(firstSheet.searchParams.get("sqp"), "base");
    assert.equal(firstSheet.searchParams.get("sigh"), "rs$youtube-signature");
    assert.ok(invidiousPaths.includes("/api/v1/videos/dQw4w9WgXcQ"));
    assert.ok(invidiousPaths.includes("/api/v1/storyboards/dQw4w9WgXcQ"));
    assert.equal(youtubeWatchRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps independent storyboard metadata when every Piped video metadata host fails", async () => {
  const invidiousHosts = [
    "inv.nadeko.net", "invidious.nerdvpn.de",
    "yt.chocolatemoo53.com", "invidious.tiekoetter.com"
  ];
  const pipedSeen = new Set();
  const storyboardTemplate = "https://inv.nadeko.net/sb/i/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sqp=sample&sigh=signature";
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (PIPED_TEST_HOSTS.includes(target.hostname)) {
      pipedSeen.add(target.hostname);
      return new Response("Piped temporarily unavailable", {
        status: 503, headers: { "Content-Type": "text/plain" }
      });
    }
    if (invidiousHosts.includes(target.hostname)) {
      assert.equal(target.pathname, "/api/v1/videos/dQw4w9WgXcQ");
      return new Response(JSON.stringify({
        videoId: "dQw4w9WgXcQ",
        storyboards: [{
          templateUrl: storyboardTemplate,
          width: 160, height: 90, count: 60, interval: 10000,
          storyboardWidth: 5, storyboardHeight: 5, storyboardCount: 3
        }]
      }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    }
    throw new Error("Unexpected upstream request: " + target.href);
  };
  try {
    const response = await onRequest(context(
      "/api/v1/videos/dQw4w9WgXcQ?fields=videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)&hl=en&region=JO",
      { Origin: SITE }
    ));
    const data = await response.json();
    assert.equal(response.status, 200, "Piped failure must not turn valid storyboard data into HTTP 503");
    assert.equal(data.videoId, "dQw4w9WgXcQ");
    assert.equal(data.metadataAvailable, false);
    assert.equal(data.title, "");
    assert.equal(data.lengthSeconds, 0);
    assert.deepEqual(data.recommendedVideos, []);
    assert.equal(data.storyboards.length, 1);
    assert.equal(data.storyboards[0].templateUrl.includes("M$M.jpg"), true);
    assert.equal(data.storyboards[0].storyboardCount, 3);
    assert.equal(pipedSeen.size, 5, "failover is bounded by the privacy budget instead of trying every provider");
    assert.equal(data.storyboardDiagnostics, undefined, "successful storyboard metadata must not be reported as missing");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails over sequentially to the next provider when earlier ones are unavailable", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  const hosts = [];
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    hosts.push(host);
    const batchIndex = PIPED_TEST_HOSTS.indexOf(host);
    if (batchIndex < 3) {
      return new Response("temporarily unavailable", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
    return new Response(JSON.stringify({
      items: [{ title: "Recovered", url: "/watch?v=dQw4w9WgXcQ", duration: 1 }],
      nextpage: null
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=music&type=video&page=1&region=JO&hl=en",
      { Origin: SITE }
    ));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.items[0].videoId, "dQw4w9WgXcQ");
    assert.deepEqual(hosts, PIPED_TEST_HOSTS.slice(0, 4), "providers are tried one after another, in order");

    // The provider that answered is remembered and asked first next time; the failed
    // ones are demoted, so the next search does not walk the dead providers again.
    hosts.length = 0;
    const second = await onRequest(context(
      "/api/v1/search?q=music&type=video&page=1&region=JO&hl=en",
      { Origin: SITE }
    ));
    assert.equal(second.status, 200);
    assert.deepEqual(hosts, [PIPED_TEST_HOSTS[3]]);
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("rejects unapproved query parameters before contacting providers", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("must not fetch"); };
  try {
    const response = await onRequest(context(
      "/api/v1/search?q=test&type=video&page=1&region=JO&hl=en&url=https://attacker.example"
    ));
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relays oEmbed through Cloudflare and returns only the video title", async () => {
  let outboundUrl = "";
  let outboundHeaders;
  globalThis.fetch = async (url, init) => {
    outboundUrl = String(url);
    outboundHeaders = new Headers(init.headers);
    return new Response('{"title":"Example title","author_name":"Ignored"}', {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const response = await onRequest(context("/api/youtube/oembed?videoId=dQw4w9WgXcQ", { Origin: SITE }));
    assert.equal(response.status, 200);
    assert.match(outboundUrl, /^https:\/\/www\.youtube\.com\/oembed\?/);
    assert.equal(outboundHeaders.has("cf-connecting-ip"), false);
    assert.equal(outboundHeaders.has("x-real-ip"), false);
    assert.deepEqual(await response.json(), { title: "Example title" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const HEALTH_ENV = { HEALTH_TOKEN: "operator-secret-for-tests" };
const healthRequest = (headers = {}) => new Request(SITE + "/api/piped-health", {
  headers: { "Sec-Fetch-Site": "same-origin", Origin: SITE, ...headers }
});

test("public health route is static and never contacts a provider", async () => {
  globalThis.fetch = async () => { throw new Error("health must not call upstream"); };
  try {
    const response = await onRequest(context("/api/health", { Origin: SITE }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-MTube-Relay"), "advanced-worker-v11");
    assert.deepEqual(await response.json(), { function: "ok", version: "advanced-worker-v11" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("deep provider probe is operator-only and refuses without the token", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("unauthorised probe must not call upstream"); };
  try {
    for (const env of [{}, HEALTH_ENV]) {
      const none = await handleApiRequest(healthRequest(), env);
      assert.equal(none.status, 404);
      const wrong = await handleApiRequest(healthRequest({ "X-Health-Token": "guess" }), env);
      assert.equal(wrong.status, 404);
    }
    assert.equal((await onRequest(context("/api/piped-health", { Origin: SITE }))).status, 404);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Piped health probe calls only the fixed public API allowlist", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url));
    seen.push(target.hostname);
    assert.equal(target.pathname, "/search");
    assert.equal(target.searchParams.get("q"), "music");
    assert.equal(target.searchParams.get("filter"), "videos");
    assert.equal(new Headers(init.headers).has("x-real-ip"), false);
    return new Response(JSON.stringify({ items: [{
      type: "stream", title: "Test", url: "/watch?v=dQw4w9WgXcQ"
    }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await handleApiRequest(healthRequest({ "X-Health-Token": HEALTH_ENV.HEALTH_TOKEN }), HEALTH_ENV);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.version, "advanced-worker-v11");
    assert.equal(data.probe, "piped-search");
    assert.equal(data.providers.length, PIPED_TEST_HOSTS.length);
    assert.equal(data.providers.every((provider) => provider.search && provider.results === 1), true);
    assert.deepEqual(seen.sort(), PIPED_TEST_HOSTS.slice().sort());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("classifies an upstream 403 challenge without exposing its response body", async () => {
  globalThis.fetch = async () => new Response("<html>verifyngo human verification</html>", {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Server": "cloudflare",
      "cf-mitigated": "challenge"
    }
  });
  try {
    const response = await handleApiRequest(healthRequest({ "X-Health-Token": HEALTH_ENV.HEALTH_TOKEN }), HEALTH_ENV);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.providers.every((provider) => provider.status === 403 && provider.reason === "bot-protection"), true);
    assert.equal(data.providers.every((provider) => !("body" in provider)), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider names and failure reasons stay server-side unless diagnostics are switched on", async () => {
  globalThis.fetch = async () => new Response("down", { status: 503, headers: { "Content-Type": "text/plain" } });
  const path = "/api/v1/search?q=music&type=video&page=1&region=JO&hl=en";
  const quiet = console.warn;
  console.warn = () => {};
  try {
    const normal = await handleApiRequest(context(path, { Origin: SITE }).request, {});
    assert.equal(normal.status, 503);
    const body = await normal.json();
    assert.deepEqual(Object.keys(body), ["error"]);
    assert.equal(JSON.stringify(body).includes("piped"), false);

    resetRelayState();
    const verbose = await handleApiRequest(context(path, { Origin: SITE }).request, { EXPOSE_DIAGNOSTICS: "1" });
    const detail = await verbose.json();
    assert.equal(Array.isArray(detail.providers) && detail.providers.length > 0, true);
  } finally {
    console.warn = quiet;
    globalThis.fetch = originalFetch;
  }
});

test("all explicit Pages route modules load the shared handler", () => {
  for (const route of [healthRoute, searchRoute, suggestionsRoute, videoRoute, storyboardVttRoute, thumbRoute, storyboardRoute, oembedRoute]) {
    assert.equal(typeof route, "function");
  }
});

test("YouTube embed receives the required origin referrer and reports playback errors", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
  assert.ok(app.includes("https://www.youtube.com/embed/"));
  assert.ok(!app.includes("youtube-nocookie.com"));
  assert.ok(app.includes("playerErrorCode===101||playerErrorCode===150"));
  assert.ok(app.includes("errorCode)===153"));
  assert.ok(app.includes("open.hidden=!showYoutubeFallback||!currentVideoId"));
  assert.ok(app.includes("YouTube playback error code: '+Number(errorCode)+'.'"));
  assert.ok(html.includes("frame-src https://www.youtube.com;"));
  assert.ok(html.includes('id="playerOpenYoutube"'));
  assert.ok(html.includes('<meta name="referrer" content="strict-origin-when-cross-origin">'));
  assert.ok(html.includes('referrerpolicy="strict-origin-when-cross-origin"'));
  assert.ok(headers.includes("Referrer-Policy: strict-origin-when-cross-origin"));
  assert.ok(!headers.includes("Referrer-Policy: no-referrer"));
});

test("Advanced Mode Worker routes the API to the relay and everything else to static assets", async () => {
  globalThis.fetch = async () => { throw new Error("static health must not call upstream"); };
  try {
    const response = await pagesWorker.fetch(new Request(SITE + "/api/health", {
      headers: { Origin: SITE, "Sec-Fetch-Site": "same-origin" }
    }), {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).function, "ok");
    const asset = await pagesWorker.fetch(new Request(SITE + "/"), {
      ASSETS: { fetch: async (request) => new Response("static asset: " + new URL(request.url).pathname) }
    });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "static asset: /");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("_headers.txt, kept for hosts that read that name, never drifts from _headers", async () => {
  const [main, copy] = await Promise.all([
    readFile(new URL("../_headers", import.meta.url), "utf8"),
    readFile(new URL("../_headers.txt", import.meta.url), "utf8")
  ]);
  assert.equal(copy, main);
});
