#!/usr/bin/env sh
set -eu

# Publish only the public static files.
rm -rf dist
mkdir -p dist
cp index.html app.js style.css sw.js icon.svg manifest.webmanifest privacy.html _headers dist/
# Cloudflare parses _headers line-by-line; strip Windows CR characters from the published copy.
tr -d '\r' < _headers > dist/_headers

# Cloudflare Pages Advanced Mode: one Worker owns only the API surface.
# Pages ignores /functions when dist/_worker.js exists.
cp functions/_lib/relay.js dist/_worker.js
cat >> dist/_worker.js <<'WORKER'

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  }
};
WORKER

cat > dist/_routes.json <<'ROUTES'
{
  "version": 1,
  "include": ["/api/*"],
  "exclude": []
}
ROUTES
