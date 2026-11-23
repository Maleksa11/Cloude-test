# Deployment (Cloudflare Pages)

Connect the Pages project to this repository and use:

1. Production branch: `main`
2. Framework preset: **None**
3. Build command: `sh build-cloudflare.sh`
4. Build output directory: `dist`

The build copies the public files into `dist/` and turns `functions/_lib/relay.js` into `dist/_worker.js`
(Advanced Mode). `dist/_routes.json` sends only `/api/*` to the Worker; everything else is served as static assets.

## Variables

| Variable | Type | Notes |
|---|---|---|
| `SITE_ORIGIN` | plain | Optional for the default project; the Worker defaults to `https://cloude-test.pages.dev`. Set a bare `https://` origin when using a custom domain. |
| `HEALTH_TOKEN` | secret | Optional. Enables `/api/piped-health`; send `X-Health-Token: <value>`. |
| `EXPOSE_DIAGNOSTICS` | plain | Debug only (`1`). Shows provider names/failure reasons in error bodies. |

## Rate limiting (recommended, 2 minutes)

The Worker has a best-effort per-client limiter, but its memory is per instance. Add the real one in
Cloudflare → Security → WAF → Rate limiting rules:

- Match: URI Path starts with `/api/`
- Characteristics: IP
- Rate: `120` requests per `1 minute` (the page itself needs a few dozen when it loads thumbnails)
- Action: Block for `1 minute`

Without it, a script can still make the Worker spend your free-plan request quota.

## After each deployment

1. `https://<site>/` loads; `/api/health` returns `{"function":"ok",...}`.
2. Search (English and Arabic), open a video, drag the timeline: previews appear.
3. DevTools → Network: every request is same-origin except `www.youtube.com` (player) and `*.ytimg.com` (sprites).
4. DevTools → Console: no Trusted Types or CSP violations; Application → Service Workers shows an active worker.
5. `curl -I https://<site>/` shows the headers from `_headers` (CSP, COOP, CORP, Permissions-Policy, HSTS).
6. `curl -H 'Origin: https://evil.example' https://<site>/api/v1/search/suggestions?q=abc` → `403`.

GitHub Actions validates syntax, the relay tests, the built output and the privacy invariants on every push and pull request.
