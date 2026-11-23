import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const ORIGIN = "https://cloude-test.pages.dev";

// Runs the real sw.js in a sandbox with an in-memory Cache Storage and a scripted network.
async function loadWorker(network) {
  const source = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  const stores = new Map();
  const listeners = {};
  const cacheApi = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      put: async (key, response) => { store.set(String(key.url || key), response); },
      match: async (key) => { const hit = store.get(String(key.url || key)); return hit ? hit.clone() : undefined; },
      addAll: async (urls) => { for (const u of urls) store.set(new URL(u, ORIGIN + "/").href, new Response("precached " + u)); }
    };
  };
  const caches = {
    open: async (name) => cacheApi(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (key) => {
      for (const store of stores.values()) {
        const hit = store.get(String(key.url || key));
        if (hit) return hit.clone();
      }
      return undefined;
    }
  };
  const self = {
    location: { href: ORIGIN + "/sw.js?v=71", origin: ORIGIN },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} }
  };
  const fetched = [];
  const fetchStub = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    fetched.push(url);
    return network(url);
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchStub, Response, URL, Promise, console });

  const dispatch = async (url, mode = "same-origin", method = "GET") => {
    let responded = null;
    listeners.fetch({
      request: { method, url, mode },
      respondWith: (value) => { responded = Promise.resolve(value); }
    });
    return responded ? { handled: true, response: await responded } : { handled: false };
  };
  return { listeners, stores, caches, fetched, dispatch };
}

const online = (url) => new Response("network " + new URL(url).pathname, { status: 200 });
const offline = () => { throw new TypeError("offline"); };

test("service worker never intercepts the API, cross-origin requests or non-GET requests", async () => {
  const worker = await loadWorker(online);
  for (const [url, mode, method] of [
    [ORIGIN + "/api/v1/search?q=private", "cors", "GET"],
    [ORIGIN + "/api/thumb/dQw4w9WgXcQ", "no-cors", "GET"],
    ["https://www.youtube.com/embed/dQw4w9WgXcQ", "navigate", "GET"],
    [ORIGIN + "/app.js", "same-origin", "POST"]
  ]) {
    assert.equal((await worker.dispatch(url, mode, method)).handled, false, method + " " + url);
  }
  assert.deepEqual(worker.fetched, []);
});

test("only the app shell page is stored as the offline shell; privacy.html is not", async () => {
  const worker = await loadWorker(online);
  await worker.dispatch(ORIGIN + "/", "navigate");
  const shellKey = ORIGIN + "/index.html";
  const cache = await worker.caches.open("malek-tube-shell-v71");
  assert.equal(await (await cache.match(shellKey)).text(), "network /", "the app shell is refreshed from the network");

  // A visit to the privacy page must not overwrite the shell...
  await worker.dispatch(ORIGIN + "/privacy.html", "navigate");
  assert.equal(await (await cache.match(shellKey)).text(), "network /");

  // ...and offline, the app opens, while a non-shell page simply fails instead of showing the app.
  const offlineWorker = await loadWorker(offline);
  await offlineWorker.caches.open("malek-tube-shell-v71").then((c) => c.put(shellKey, new Response("cached app shell")));
  const app = await offlineWorker.dispatch(ORIGIN + "/", "navigate");
  assert.equal(await app.response.text(), "cached app shell");
  const privacy = await offlineWorker.dispatch(ORIGIN + "/privacy.html", "navigate");
  assert.equal(privacy.response.type, "error");
});

test("shell files are network-first with an offline fallback, regardless of the ?v= suffix", async () => {
  const worker = await loadWorker(online);
  const fresh = await worker.dispatch(ORIGIN + "/style.css?v=71");
  assert.equal(await fresh.response.text(), "network /style.css", "an online request is never answered with an old copy");

  const offlineWorker = await loadWorker(offline);
  const cache = await offlineWorker.caches.open("malek-tube-shell-v71");
  await cache.put(ORIGIN + "/style.css", new Response("cached css"));
  const stale = await offlineWorker.dispatch(ORIGIN + "/style.css?v=71");
  assert.equal(await stale.response.text(), "cached css");
  const missing = await offlineWorker.dispatch(ORIGIN + "/app.js?v=71");
  assert.equal(missing.response.type, "error");
});

test("activating a new version deletes older shell caches and nothing else", async () => {
  const worker = await loadWorker(online);
  await worker.caches.open("malek-tube-shell-v70");
  await worker.caches.open("malek-tube-shell-v71");
  await worker.caches.open("unrelated-cache");
  let finished = null;
  worker.listeners.activate({ waitUntil: (promise) => { finished = promise; } });
  await finished;
  assert.deepEqual([...worker.stores.keys()].sort(), ["malek-tube-shell-v71", "unrelated-cache"]);
});

test("the page registers exactly this worker through a Trusted Types policy", async () => {
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const sw = await readFile(new URL("../sw.js", import.meta.url), "utf8");
  assert.ok(app.includes("var swUrl='sw.js?v=71'"));
  assert.ok(sw.includes("malek-tube-shell-v71"));
});
