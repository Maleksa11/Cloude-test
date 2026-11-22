// Local preview of the production build. Not part of the deployed site.
//
//   sh build-cloudflare.sh && node scripts/dev-server.mjs
//
// Serves dist/ exactly as Cloudflare Pages would (including the response headers from
// _headers) and runs the real dist/_worker.js for /api/*, so the relay talks to the
// real public providers. It listens on 127.0.0.1 only.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const port = Number(process.env.PORT || 8788);
const SITE = process.env.SITE_ORIGIN || "https://mtube-test.pages.dev";
const worker = (await import(pathToFileURL(join(root, "_worker.js")).href)).default;

const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

// Apply the "/*" block of _headers. Local http cannot use HSTS and must not upgrade
// loopback requests to https, so those two are the only things left out.
const pageHeaders = {};
for (const line of (await readFile(join(root, "_headers"), "utf8")).split(/\r?\n/)) {
  const match = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (!match || match[1].toLowerCase() === "strict-transport-security") continue;
  pageHeaders[match[1]] = match[1].toLowerCase() === "content-security-policy"
    ? match[2].replace("; upgrade-insecure-requests", "")
    : match[2];
}

async function asset(request) {
  let path = decodeURIComponent(new URL(request.url).pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return new Response("Forbidden", { status: 403 });
  try {
    return new Response(await readFile(file), {
      headers: { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "public, max-age=0, must-revalidate", ...pageHeaders }
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

http.createServer(async (req, res) => {
  try {
    const request = new Request(SITE + req.url, {
      method: req.method,
      headers: { "Sec-Fetch-Site": "same-origin" }
    });
    const response = await worker.fetch(request, { ASSETS: { fetch: asset } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("dev server error: " + (error && error.message));
  }
}).listen(port, "127.0.0.1", () => console.log("MTube preview on http://127.0.0.1:" + port + "/"));
