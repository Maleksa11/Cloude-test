# MTube

A small, privacy-first YouTube search and player, served as a static site plus one Cloudflare Worker.

> **Version 71 (hardened).** The relay and the page were reworked for privacy and isolation. The
> previous long change log is kept in `docs/CHANGELOG-legacy.md`.
> **Scope note:** `docs/SECURITY_AUDIT_AR.md` describes `Maleksa11/MtubeOld`, not this repository. It is retained as historical reference and is not a security audit of Cloude-test.

## What it is — and what it is not

- It searches through public Piped/Invidious community services and plays videos with **YouTube's own
  embedded player** (in a sandboxed frame).
- It is **not an ad blocker.** Advertising that YouTube's player decides to show is shown. Removing it
  would mean playing the media streams outside YouTube's player, which this build deliberately does not do
  (see section 5 of `docs/SECURITY_AUDIT_AR.md`).

## Architecture

```
browser ──same origin──▶ Cloudflare Worker (/api/*) ──▶ one public provider at a time
   │                              │
   │                              └──▶ i.ytimg.com (thumbnails, sprite sheets)
   └──▶ www.youtube.com (sandboxed player iframe, direct)
```

- `index.html`, `app.js`, `style.css`, `sw.js`: the whole client. No libraries, no inline script or style.
- `functions/_lib/relay.js`: the Worker. Fixed routes, fixed provider allowlists, validated parameters,
  fresh outbound headers, bounded response sizes, rate limiting, provider failover.
- `build-cloudflare.sh` publishes `dist/` and builds `dist/_worker.js` (Pages Advanced Mode, only `/api/*`).
- `_headers` carries the response headers (CSP with Trusted Types, COOP, CORP, Permissions-Policy, HSTS…).

## Privacy model in one page

| Question | Answer |
|---|---|
| Does the browser contact a search/metadata provider? | **No.** It talks to its own origin only (`connect-src 'self'`). |
| Who sees my search phrase or video ID? | The Worker, and **one** provider (a second only after the first fails or stays silent; never more than five; unreachable providers do not count). |
| Does a provider see my IP, cookies or browser identity? | No. Outgoing requests are built from scratch; the provider sees the Worker. |
| Who sees my IP? | Cloudflare (hosting) and YouTube (player, sprite sheets). |
| What is stored locally? | History (≤500 entries, **auto-erased after 90 days**), progress, titles, settings — unencrypted local storage. |
| Is the “For you” feed personalized? | **Off by default.** Turning it on sends phrases derived from watched titles through the relay. |
| Analytics / cookies / ads? | None from MTube. |

## Develop

```sh
sh build-cloudflare.sh                       # build dist/
node --test tests/*.test.mjs                 # relay + client invariants (no network needed)
node scripts/check-privacy-invariants.mjs    # privacy/isolation guard for the built files
node scripts/dev-server.mjs                  # preview on http://127.0.0.1:8788 with the real Worker
```

## Configuration (Cloudflare Pages → Settings → Variables)

| Name | Purpose |
|---|---|
| `SITE_ORIGIN` | Your production origin, e.g. `https://tube.example.org`. Defaults to `https://cloude-test.pages.dev`. Must be a bare `https://` origin. Its subdomains (previews) are allowed too. |
| `HEALTH_TOKEN` *(secret)* | Enables `/api/piped-health` (a deep probe of every provider) for requests sending `X-Health-Token`. Unset = disabled. |
| `EXPOSE_DIAGNOSTICS` | Set to `1` temporarily to include provider names/failure reasons in API error bodies while debugging. Leave unset in production. |

See `DEPLOYMENT.md` for the Pages setup and the recommended Cloudflare rate-limiting rule.
