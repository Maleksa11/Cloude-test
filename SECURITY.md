# Security Policy

## Supported version

Only the latest commit on `main` is supported.

## Reporting a vulnerability

Please do not publish exploit details, credentials or private data in a public issue. Use GitHub's
**Security → Advisories → Report a vulnerability** flow if it is enabled; otherwise contact the repository
owner through the GitHub profile and ask for a private channel.

## Security model

- **No secrets in the client.** Everything shipped to the browser is public. The relay needs no API keys.
  Optional operator secrets (`HEALTH_TOKEN`) live in Cloudflare variables, never in the repository.
- **The relay is not a proxy.** It serves a fixed set of `GET` routes, validates every parameter, talks only to
  hard-coded provider hosts and to `ytimg.com` image hosts, never follows an unvalidated redirect, caps
  response sizes and time, and builds outgoing requests from scratch.
- **Browser isolation.** CSP with `default-src 'none'`, `script-src 'self'`, no inline script or style, Trusted
  Types enforced (the only policy, `mtube-sw`, accepts this origin's own `sw.js`), `connect-src 'self'`,
  `frame-src https://www.youtube.com`, sandboxed player frame, COOP/CORP, a restrictive Permissions-Policy.
- **Untrusted data** (titles, authors, suggestions, stored history) is only ever inserted with `textContent`
  and validated before use. `scripts/check-privacy-invariants.mjs` fails the build if `innerHTML` and friends appear.
- **Abuse limits.** Per-client token bucket in the Worker, bounded provider failover, a provider is never asked
  more often than needed. Add a Cloudflare rate-limiting rule for the authoritative limit (see `DEPLOYMENT.md`).
- **Supply chain.** No runtime dependencies. GitHub Actions are pinned by commit SHA, run with read-only
  permissions and `persist-credentials: false`, and Dependabot proposes updates weekly.

## Repository hardening checklist (owner)

- Turn on 2FA with a passkey or security key for the GitHub account.
- Protect `main`: require pull requests and the CI checks, block force pushes and deletion.
- Enable secret scanning with push protection, Dependabot alerts, and private vulnerability reporting.
- Delete stale `backup/*` and `stable-test/*` branches once they are no longer needed.

## Out of scope

Third-party providers and YouTube are outside this repository's control; see `privacy.html` for what each can see.
