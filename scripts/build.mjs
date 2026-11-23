// Optional Node-based builder. Run with `node scripts/build.mjs`.
// Cloudflare Pages uses the shell entry point `sh build-cloudflare.sh`.
//
// This is Node rather than shell on purpose: a shell script saved with Windows (CRLF)
// line endings fails on Linux ("set: Illegal option -"), while Node does not care.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const PUBLIC_FILES = [
  "index.html", "app.js", "style.css", "sw.js", "icon.svg", "manifest.webmanifest", "privacy.html"
];
const toLf = (text) => text.replace(/\r\n?/g, "\n");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// Publish only the public static files.
for (const name of PUBLIC_FILES) await cp(join(root, name), join(dist, name));

// The host parses _headers line by line; a stray carriage return would end up inside
// header values, so this one file is always written with Unix line endings.
await writeFile(join(dist, "_headers"), toLf(await readFile(join(root, "_headers"), "utf8")));

// One Worker owns only the API surface. Pages ignores /functions when dist/_worker.js exists.
const relay = toLf(await readFile(join(root, "functions", "_lib", "relay.js"), "utf8"));
await writeFile(join(dist, "_worker.js"), relay + `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
`);

await writeFile(join(dist, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }, null, 2) + "\n");

console.log("Built dist/: " + [...PUBLIC_FILES, "_headers", "_worker.js", "_routes.json"].length + " files.");
