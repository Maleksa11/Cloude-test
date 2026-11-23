import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, resetRelayState } from "../functions/_lib/relay.js";

const SITE = "https://cloude-test.pages.dev";
const originalFetch = globalThis.fetch;
const PIPED_FIRST = "pipedapi.kavin.rocks";
const PIPED_HOSTS = [
  "pipedapi.kavin.rocks", "api.piped.yt", "pipedapi.drgns.space",
  "pipedapi.ducks.party", "piped-api.codespace.cz", "pipedapi.reallyaweso.me",
  "api.piped.private.coffee", "pipedapi.darkness.services", "pipedapi.nosebs.ru",
  "pipedapi-libre.kavin.rocks", "pipedapi.adminforge.de"
];
const INVIDIOUS_HOSTS = [
  "inv.nadeko.net", "invidious.nerdvpn.de", "yt.chocolatemoo53.com", "invidious.tiekoetter.com"
];
const VIDEO_FIELDS = "videoId,title,author,lengthSeconds,genre,keywords,storyboards,recommendedVideos(videoId,title,author,lengthSeconds,viewCount,viewCountText,publishedText)";
const VIDEO_PATH = "/api/v1/videos/dQw4w9WgXcQ?fields=" + VIDEO_FIELDS + "&hl=en&region=JO";

beforeEach(() => resetRelayState());

function request(path, headers = {}, base = SITE) {
  return new Request(base + path, { headers: { "Sec-Fetch-Site": "same-origin", ...headers } });
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json" }
});

function pipedVideo(extra = {}) {
  return { title: "A video", uploader: "A channel", duration: 200, relatedStreams: [], ...extra };
}

function previewFrames(videoId, host = "proxy.piped.example") {
  const sheet = (level, index) =>
    "https://" + host + "/sb/" + videoId + "/storyboard3_L" + level + "/M" + index +
    ".jpg?host=i.ytimg.com&sigh=rs%24SIGNATURE" + level + "&sqp=-oaymw%3D%3D&tracker=evil";
  return [
    { urls: [sheet(1, 0), sheet(1, 1)], frameWidth: 80, frameHeight: 45, totalCount: 108,
      durationPerFrame: 2000, framesPerPageX: 10, framesPerPageY: 10 },
    { urls: [sheet(2, 0), sheet(2, 1)], frameWidth: 160, frameHeight: 90, totalCount: 108,
      durationPerFrame: 2000, framesPerPageX: 5, framesPerPageY: 5 }
  ];
}

test("storyboards come from Piped's own previewFrames, so no extra provider learns the video", async () => {
  const hosts = [];
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    hosts.push(target.hostname);
    return json(pipedVideo({ previewFrames: previewFrames("dQw4w9WgXcQ") }));
  };
  try {
    const response = await handleApiRequest(request(VIDEO_PATH), {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(hosts, [PIPED_FIRST], "one provider, no Invidious, no YouTube");
    assert.equal(data.storyboards.length, 2);
    const best = data.storyboards[0];
    assert.equal(best.width, 160);
    assert.equal(best.storyboardCount, 2);
    assert.equal(data.cuesRecommended, undefined, "no extra provider call is requested for sheets that came with the metadata");
    assert.equal(best.interval, 2000);
    const template = new URL(best.templateUrl);
    assert.equal(template.hostname, "i.ytimg.com", "sheets are re-pointed at YouTube's image host, not the provider's proxy");
    assert.equal(template.pathname, "/sb/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg");
    assert.deepEqual([...template.searchParams.keys()].sort(), ["sigh", "sqp"], "provider tracking parameters are dropped");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("previewFrames that point at another video, another scheme or a stranger's path are ignored", async () => {
  const bad = [
    { urls: ["https://p.example/sb/AAAAAAAAAAA/storyboard3_L1/M0.jpg?sigh=a"], frameWidth: 80, frameHeight: 45, totalCount: 10, durationPerFrame: 1000, framesPerPageX: 10, framesPerPageY: 10 },
    { urls: ["http://p.example/sb/dQw4w9WgXcQ/storyboard3_L1/M0.jpg?sigh=a"], frameWidth: 80, frameHeight: 45, totalCount: 10, durationPerFrame: 1000, framesPerPageX: 10, framesPerPageY: 10 },
    { urls: ["https://p.example/sb/dQw4w9WgXcQ/../../etc/M0.jpg?sigh=a"], frameWidth: 80, frameHeight: 45, totalCount: 10, durationPerFrame: 1000, framesPerPageX: 10, framesPerPageY: 10 },
    { urls: ["https://p.example/sb/dQw4w9WgXcQ/storyboard3_L1/M0.jpg?host=evil.example&sigh=a"], frameWidth: 80, frameHeight: 45, totalCount: 10, durationPerFrame: 1000, framesPerPageX: 10, framesPerPageY: 10 }
  ];
  const warn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (PIPED_HOSTS.includes(target.hostname)) return json(pipedVideo({ previewFrames: bad }));
    if (INVIDIOUS_HOSTS.includes(target.hostname)) return json({ storyboards: [] });
    return new Response("not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  };
  try {
    const response = await handleApiRequest(request(VIDEO_PATH), {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.storyboards.length, 1, "only the frame whose host falls back to i.ytimg.com is accepted");
    assert.equal(new URL(data.storyboards[0].templateUrl).hostname, "i.ytimg.com");
    assert.ok(!data.storyboards[0].templateUrl.includes("evil.example"));
  } finally {
    console.warn = warn;
    globalThis.fetch = originalFetch;
  }
});

test("a second provider is only asked after the first has been silent for the stagger delay", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  const started = [];
  const t0 = Date.now();
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    started.push({ host, at: Date.now() - t0 });
    if (host === PIPED_HOSTS[0]) {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return new Response("late", { status: 503, headers: { "Content-Type": "text/plain" } });
    }
    return json({ items: [{ title: "Quick answer", url: "/watch?v=dQw4w9WgXcQ", duration: 5 }], nextpage: null });
  };
  try {
    const response = await handleApiRequest(
      request("/api/v1/search?q=music&type=video&page=1&region=JO&hl=en"), {}
    );
    assert.equal(response.status, 200);
    assert.deepEqual(started.map((entry) => entry.host), [PIPED_HOSTS[0], PIPED_HOSTS[1]]);
    assert.ok(started[1].at >= 1400, "second provider waited for the stagger, got " + started[1].at + "ms");
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("cold-start search ordering does not always begin with the same provider", async () => {
  const originalRandom = Math.random;
  const contacted = [];
  Math.random = () => 0;
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    contacted.push(host);
    return json({
      items: [{ title: "Available", url: "/watch?v=dQw4w9WgXcQ", duration: 5 }],
      nextpage: null
    });
  };
  try {
    const response = await handleApiRequest(
      request("/api/v1/search?q=music&type=video&page=1&region=JO&hl=en"), {}
    );
    assert.equal(response.status, 200);
    assert.deepEqual(contacted, [PIPED_HOSTS[1]], "the cold-start provider order is shuffled");
    assert.equal(contacted.length, 1, "a healthy first provider still serves the request alone");
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("storyboard image relay forwards only the signature parameters", async () => {
  let upstream = "";
  globalThis.fetch = async (url) => {
    upstream = String(url);
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
  };
  try {
    const wanted = "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sqp=abc&sigh=def&cachebust=1&x=" + "y".repeat(50);
    const response = await handleApiRequest(
      request("/api/storyboard?url=" + encodeURIComponent(wanted)), {}
    );
    assert.equal(response.status, 200);
    assert.equal(upstream, "https://i.ytimg.com/sb/dQw4w9WgXcQ/storyboard3_L2/M0.jpg?sqp=abc&sigh=def");
    assert.equal(response.headers.get("Content-Type"), "image/jpeg");
    assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("per-client rate limit throttles floods, isolates clients and never keys on nothing", async () => {
  let upstreamCalls = 0;
  globalThis.fetch = async () => { upstreamCalls++; return json(["alpha", "alpha beta"]); };
  const call = (ip) => handleApiRequest(
    request("/api/v1/search/suggestions?q=alpha", ip ? { "CF-Connecting-IP": ip } : {}), {}
  );
  try {
    let limited = null;
    for (let i = 0; i < 125; i++) {
      const response = await call("203.0.113.9");
      if (response.status === 429) { limited = response; break; }
    }
    assert.ok(limited, "a flood from one address must be refused");
    assert.ok(Number(limited.headers.get("Retry-After")) >= 1);
    assert.deepEqual(await limited.json(), { error: "Too many requests. Please slow down." });
    const before = upstreamCalls;
    assert.equal((await call("203.0.113.9")).status, 429);
    assert.equal(upstreamCalls, before, "a refused request must not reach any provider");

    assert.equal((await call("203.0.113.10")).status, 200, "other visitors are unaffected");
    assert.equal((await call(null)).status, 200, "no client address means no limiting state is created");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the deployment origin can be configured and a malformed value falls back safely", async () => {
  globalThis.fetch = async () => { throw new Error("no upstream expected"); };
  const env = { SITE_ORIGIN: "https://tube.example.org" };
  try {
    const own = await handleApiRequest(request("/api/health", {}, "https://tube.example.org"), env);
    assert.equal(own.status, 200);
    const preview = await handleApiRequest(request("/api/health", {}, "https://abc123.tube.example.org"), env);
    assert.equal(preview.status, 200, "preview subdomains of the configured project are allowed");
    const lookalike = await handleApiRequest(request("/api/health", {}, "https://eviltube.example.org"), env);
    assert.equal(lookalike.status, 404, "a host that merely ends with the same text is not a subdomain");
    const old = await handleApiRequest(request("/api/health"), env);
    assert.equal(old.status, 404, "the built-in default no longer applies once an origin is configured");

    for (const broken of ["http://tube.example.org", "https://tube.example.org:8443", "https://user@tube.example.org", "not a url", "https://tube.example.org/path"]) {
      const fallback = await handleApiRequest(request("/api/health"), { SITE_ORIGIN: broken });
      assert.equal(fallback.status, 200, "invalid SITE_ORIGIN " + broken + " must not widen or break access");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every relay response carries the privacy and isolation headers", async () => {
  globalThis.fetch = async () => json(["alpha", "alpha beta"]);
  try {
    for (const path of ["/api/health", "/api/v1/search/suggestions?q=alpha", "/api/nothing-here"]) {
      const response = await handleApiRequest(request(path), {});
      assert.equal(response.headers.get("Cache-Control"), "no-store", path);
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff", path);
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer", path);
      assert.equal(response.headers.get("Cross-Origin-Resource-Policy"), "same-origin", path);
      assert.equal(response.headers.get("X-Robots-Tag"), "noindex", path);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("providers that never opened a connection do not use up the privacy budget", async () => {
  const originalRandom = Math.random;
  Math.random = () => 0.999999;
  const contacted = [];
  globalThis.fetch = async (url) => {
    const host = new URL(String(url)).hostname;
    contacted.push(host);
    // Hosts 0-5 refuse the connection outright (DNS/TCP failure): nothing was delivered.
    if (PIPED_HOSTS.indexOf(host) < 6) throw new TypeError("fetch failed");
    return json({ items: [{ title: "Found", url: "/watch?v=dQw4w9WgXcQ", duration: 5 }], nextpage: null });
  };
  try {
    const response = await handleApiRequest(request("/api/v1/search?q=music&type=video&page=1&region=JO&hl=en"), {});
    assert.equal(response.status, 200);
    assert.deepEqual(contacted, PIPED_HOSTS.slice(0, 7), "unreachable providers are skipped without limit");
  } finally {
    Math.random = originalRandom;
    globalThis.fetch = originalFetch;
  }
});

test("providers that answered with errors DO use up the budget, so a query is never walked across the whole list", async () => {
  const contacted = [];
  globalThis.fetch = async (url) => {
    contacted.push(new URL(String(url)).hostname);
    return new Response("busy", { status: 503, headers: { "Content-Type": "text/plain" } });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const response = await handleApiRequest(request("/api/v1/search?q=private+words&type=video&page=1&region=JO&hl=en"), {});
    assert.equal(response.status, 503);
    assert.equal(contacted.length, 5, "at most five operators ever see one search phrase");
    assert.equal(new Set(contacted).size, 5);
  } finally {
    console.warn = warn;
    globalThis.fetch = originalFetch;
  }
});

test("outbound requests never carry visitor identity and never leave the provider allowlist", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: new URL(String(url)), headers: new Headers(init && init.headers) });
    return json({ items: [{ title: "Result", url: "/watch?v=dQw4w9WgXcQ", duration: 5 }], nextpage: null });
  };
  try {
    const response = await handleApiRequest(request(
      "/api/v1/search?q=private+thing&type=video&page=1&region=JO&hl=en",
      {
        Cookie: "sid=secret", Authorization: "Bearer secret", Referer: SITE + "/?u=secret",
        "CF-Connecting-IP": "198.51.100.7", "X-Forwarded-For": "198.51.100.7", "True-Client-IP": "198.51.100.7",
        "User-Agent": "VisitorBrowser/1.0 (secret device)"
      }
    ), {});
    assert.equal(response.status, 200);
    assert.equal(seen.length, 1);
    for (const { url, headers } of seen) {
      assert.ok(PIPED_HOSTS.includes(url.hostname));
      for (const name of ["cookie", "authorization", "referer", "cf-connecting-ip", "x-forwarded-for", "true-client-ip", "x-real-ip", "origin"]) {
        assert.equal(headers.has(name), false, name + " must not be forwarded");
      }
      assert.ok(!(headers.get("user-agent") || "").includes("secret"), "the visitor's user agent must not be forwarded");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sheets that had to come from Invidious ask the browser to fetch exact cues; the browser skips them otherwise", async () => {
  globalThis.fetch = async (url) => {
    const target = new URL(String(url));
    if (PIPED_HOSTS.includes(target.hostname)) return json(pipedVideo());
    if (INVIDIOUS_HOSTS.includes(target.hostname)) {
      return json({
        videoId: "dQw4w9WgXcQ",
        storyboards: [{
          templateUrl: "https://" + target.hostname + "/sb/i/dQw4w9WgXcQ/storyboard3_L2/M$M.jpg?sqp=a&sigh=b",
          width: 160, height: 90, count: 60, interval: 10000,
          storyboardWidth: 5, storyboardHeight: 5, storyboardCount: 3
        }]
      });
    }
    throw new Error("unexpected host " + target.hostname);
  };
  try {
    const response = await handleApiRequest(request(VIDEO_PATH), {});
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.storyboards.length, 1);
    assert.equal(data.cuesRecommended, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.ok(app.includes("if(!data||data.cuesRecommended!==true)return Promise.resolve(data);"));
});
