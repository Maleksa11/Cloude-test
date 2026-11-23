// Fails the build when a change would quietly weaken the privacy or isolation
// guarantees of the shipped site. Run after `sh build-cloudflare.sh`:
//
//   node scripts/check-privacy-invariants.mjs
import { readFile, readdir } from "node:fs/promises";

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const relay = await read("functions/_lib/relay.js");
const providerHosts = [...relay.matchAll(/^\s+"([a-z0-9-]+(?:\.[a-z0-9-]+)+)",?\s*$/gm)].map((match) => match[1]);
check(providerHosts.length >= 10, "could not read the provider host lists from relay.js");

// 1. No browser-facing file may name a provider: the browser talks to its own origin only.
const browserFiles = ["dist/index.html", "dist/app.js", "dist/sw.js", "dist/_headers", "dist/privacy.html", "dist/manifest.webmanifest"];
for (const file of browserFiles) {
  const text = await read(file);
  for (const host of providerHosts) check(!text.includes(host), file + " names the provider host " + host);
}

// 2. Both CSP copies keep the browser on its own origin and enforce Trusted Types.
const html = await read("dist/index.html");
const headers = await read("dist/_headers");
check(!headers.includes("\r"), "deployed _headers must use LF line endings");
const metaCsp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || "";
const headerCsp = (headers.match(/Content-Security-Policy: ([^\r\n]+)/) || [])[1] || "";
for (const [name, policy] of [["meta CSP", metaCsp], ["header CSP", headerCsp]]) {
  check(policy.includes("default-src 'none'"), name + " must start from default-src 'none'");
  check(policy.includes("connect-src 'self';"), name + " must allow connections to 'self' only");
  check(policy.includes("script-src 'self';"), name + " must not allow inline or remote scripts");
  check(!/unsafe-inline|unsafe-eval|\*(?!\.ytimg\.com)/.test(policy.replace("https://*.ytimg.com", "")), name + " contains a wildcard or unsafe keyword");
  check(policy.includes("require-trusted-types-for 'script'"), name + " must enforce Trusted Types");
  check(policy.includes("frame-src https://www.youtube.com;"), name + " must frame YouTube and nothing else");
}
check(headerCsp.includes("frame-ancestors 'none'"), "the header CSP must forbid framing of the site");
check(headerCsp.replace("frame-ancestors 'none'; ", "") === metaCsp, "header and meta CSP have drifted apart");

// 3. The embedded player stays sandboxed.
check(html.includes('sandbox="allow-scripts allow-same-origin allow-presentation"'), "the player iframe lost its sandbox");

// 4. Hardening response headers are present.
for (const header of ["Cross-Origin-Opener-Policy: same-origin", "Cross-Origin-Resource-Policy: same-origin",
  "X-Content-Type-Options: nosniff", "Referrer-Policy: strict-origin-when-cross-origin", "X-Frame-Options: DENY",
  "Strict-Transport-Security:", "Permissions-Policy:"]) {
  check(headers.includes(header), "_headers is missing " + header);
}

// 5. No dangerous DOM or script sinks in the application code.
const app = await read("dist/app.js");
for (const sink of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\(/, /\bnew Function\b/, /\bsrcdoc\b/]) {
  check(!sink.test(app), "app.js uses a forbidden sink: " + sink);
}

// 6. Nothing but the site's own assets is published.
const published = (await readdir(new URL("../dist/", import.meta.url))).sort();
const expected = ["_headers", "_routes.json", "_worker.js", "app.js", "icon.svg", "index.html", "manifest.webmanifest", "privacy.html", "style.css", "sw.js"];
check(JSON.stringify(published) === JSON.stringify(expected), "dist contains unexpected files: " + published.join(", "));

if (failures.length) {
  console.error("Privacy invariants violated:\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("Privacy invariants hold (" + providerHosts.length + " provider hosts checked against " + browserFiles.length + " browser files).");
