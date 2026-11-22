# Legacy change log (README before version 71)

Kept for history only. Several statements below describe earlier builds and are no longer accurate
(for example the browser-side Invidious fallback and the four-instance fail-over were removed in version 71).

## Privacy relay update — November 21, 2026

- Invidious search, suggestions, recommendations, and video metadata now use same-origin `/api/v1/*` requests and are relayed by a Cloudflare Pages Advanced Mode Worker.
- The Function supports only fixed API paths, fixed upstream hosts, bounded query parameters, validated 11-character video IDs, GET requests, the exact `mtube-test.pages.dev` origin, and bounded JSON/image responses. It is not an arbitrary URL proxy.
- Outbound requests are created with fresh headers. Outbound requests are built with fresh headers rather than copying the browser request; browser cookies, authorization, referrer, and client-IP headers are not forwarded. Cloudflare still processes the visitor IP, and the directly embedded YouTube player connects from the visitor device.
- YouTube oEmbed title lookups, thumbnails, and storyboard sheets are also relayed through Cloudflare. The embedded YouTube player itself remains a direct connection: YouTube can still see the visitor's IP and playback activity. Cloudflare also receives the visitor's IP.
- CSP now permits only same-origin API connections and images; the YouTube privacy-enhanced iframe remains explicitly allowed. Cache version advanced to v40.
- `_routes.json` keeps the Advanced Mode Worker limited to `/api/*`, so static site asset requests use Pages static asset serving.

> **MTube Main — V70.** This repository is the production source for the MTube Cloudflare Pages project `mtube-test`.

# MTube

A lightweight, client-side YouTube search and player.

## Current architecture

- Static frontend; no application server, account system, or shared user database is configured.
- Watch history (up to 500 entries), playback position, cached titles, autoplay preference, and recommendation preferences are stored in the visitor's browser storage under a versioned namespace. This browser storage is not encrypted by the app.
- The browser retains at most 500 history entries and 150 cached video titles. Clearing history also removes the app's saved title metadata and cached feed. Video files are not saved by the app; thumbnails are loaded from YouTube's image CDN.
- Search, suggestions, recommendation metadata, video metadata, oEmbed title lookup, thumbnails, and storyboard previews are relayed through a same-origin Cloudflare Pages Advanced Mode Worker. The Worker contacts fixed upstream allowlists using fresh outbound headers. It does not copy browser IP headers, cookies, authorization, or referrer into upstream requests. Cloudflare still receives and processes the visitor's connection IP. The embedded YouTube player remains a direct browser connection and YouTube can see the visitor IP.
- The service worker caches only the app shell for offline opening. It does not cache search responses, video streams, watch history, or user-specific API responses.

## Privacy boundary

Data is separate between different browser profiles and devices because it is stored locally. This is **not account-level separation**: people sharing the same browser profile on the same device also share that profile's local history and interests. Adding true per-account history requires authentication and a backend database with user-scoped access rules.

## Deployment

The test site is hosted on Cloudflare Pages from this private GitHub repository. The Pages build uses `sh build-cloudflare.sh` and publishes `dist/`; the root `functions/` directory provides the API relay, and `dist/_routes.json` invokes it only for `/api/*`. The public site remains accessible even though the source repository is private.

The manifest and service worker require a secure context for installation/offline support. A service-worker update may take a browser reload to activate.

## Security and privacy review

- The current release is a static, client-side site. It has no login, application server, private API keys, or shared user database. Do not treat it as an account-based private service.
- Watch history, playback position, saved titles, and preferences are stored in browser local storage. They are not encrypted by this app and are visible to anyone who can use the same browser profile or inspect that device. Clearing the app's history removes its local history and saved title/feed data; it cannot erase logs held by external providers or YouTube account activity.
- Search phrases, autocomplete requests, video IDs, and video metadata requests are sent to public Invidious instances listed in `index.html`. The personalized home feed builds a small number of search queries from keywords in recent watched-video titles/metadata (it does not upload the full watch-history list), and those derived queries are also sent to the selected Invidious instance. Providers can receive the visitor's IP address and the query/video ID. API requests omit browser credentials and use a no-referrer policy, but the app cannot guarantee how third-party operators retain or use their logs.
- Playback is provided by the YouTube embedded player. YouTube processes the playback request under its own privacy terms and browser cookie/account settings. MTube does not receive a user's Google password or YouTube login credentials.
- The page applies a restrictive Content Security Policy, a no-referrer policy, HTTPS-only allowlisted API/media origins, YouTube player message source/origin checks, video-ID validation, and text-only insertion for external titles and search suggestions. There are no third-party JavaScript libraries loaded by the page.
- The service worker caches only the app shell; it does not cache API responses, video streams, watch history, or personalized data.
- Static source review found no obvious critical client-side injection issue in the reviewed paths. This is not a penetration test or a formal security audit. The current public host is Cloudflare Pages, which applies the response headers defined in `_headers`, including CSP, `Permissions-Policy`, HSTS, `X-Content-Type-Options`, and frame restrictions. The HTML also retains a meta CSP fallback. These controls reduce browser-side exposure. The same-origin relay prevents the visitor's IP headers from being forwarded to the configured Invidious, oEmbed, and image upstreams; Cloudflare still sees the visitor IP, and the directly embedded YouTube player still exposes it to YouTube.
- Before adding accounts, payments, uploads, or private user data, use a backend with authentication, per-user authorization rules, server-side validation, rate limits, monitoring, and a separate security review.


## Interface refresh (November 21, 2026)

- The home screen now has a focused search-first layout, with video-link playback as a secondary action, a compact topic strip, and clearer history/feed sections.
- Search results use a dedicated, quieter layout that hides home discovery elements while searching. The layout adapts from mobile to desktop and respects reduced-motion settings.
- The interface uses local CSS and system fonts; no external font or JavaScript CDN was added.

## Player update (November 2026)

- Search and For You show an animated loading indicator while additional result pages are being fetched.
- Search, For You, and history selections load the clicked video ID directly as a single-video embed. The app manages the follow-up queue itself with explicit `loadVideoById` calls, so the clicked card, actual YouTube video, timeline, and watch history stay tied to the same confirmed video ID. Original YouTube playlist URLs continue to use YouTube's native playlist player.
- The player list also loads the exact selected video ID; it no longer asks YouTube to infer the clicked position from a separate result queue.
- Watch-history cards include a per-video remove control; history expands beyond its three-item preview up to 500 locally stored entries.
- The Autoplay control is enabled by default and remembers its setting on this device. When enabled, app-managed queues advance to the next video; when disabled, the current video is replayed.
- Tapping the video picture no longer pauses playback. The central play/pause button is the playback toggle; double-tapping the left or right side still seeks ten seconds.
- The timeline has a drag/hover preview when the metadata endpoint returns YouTube storyboard sheets; where no sheet is available, the time bubble still appears. Some videos or public API instances may not provide usable storyboard data, so thumbnail preview availability is not guaranteed for every video.
- Picture-in-picture has been removed from this build. Playback remains inside the embedded YouTube player.


## Playback startup recovery (November 20, 2026)

- The page no longer calls the Fullscreen API before the YouTube iframe is loaded. The player is already laid out to fill the app viewport; avoiding an early fullscreen request preserves the original card-click interaction for media playback.
- The iframe `onload` handler is installed before assigning its source. After load, the app retries the IFrame Player API listening handshake and `playVideo` command for a short bounded period.
- If YouTube reports that autoplay was blocked, the app shows a visible message and leaves the central Play button available. Player errors show a separate message instead of leaving an unresponsive-looking screen.
- The app script URL is versioned. The service worker shell cache was bumped and the app script/document use network-first requests, with a cached fallback for offline access. This prevents old cached JavaScript from silently replacing the deployed version during normal online use.
- A browser may still block unmuted autoplay based on its own policy. In that case the user must tap the central Play control; the site cannot override browser autoplay restrictions.


## Security hardening (November 21, 2026)

- The page now uses a default-deny Content Security Policy with explicit allowlists for its own script, styles, thumbnails, YouTube embed, the four public video-search instances, YouTube oEmbed, Google video streams, the service worker, and the web manifest. Inline script attributes are blocked; no inline JavaScript handlers are used.
- Trusted Types enforcement is enabled with no application-created Trusted Types policy. The app no longer writes HTML strings into DOM injection sinks; runtime icons and loading placeholders are constructed with DOM APIs.
- API paths are checked to remain within the expected `/api/v1/` namespace before being sent to a fixed HTTPS provider allowlist.
- Cached watch-history and feed objects are validated and bounded before use. Invalid video IDs, malformed fields, duplicate records, oversized text, and unusually large cached objects are ignored.
- Search text and pasted-link input have conservative length limits. No third-party JavaScript library or runtime dependency was added. The service-worker shell cache was advanced to v17 so the security update is not hidden behind an older cached app shell.
- The app still stores history and preferences in browser local storage without encryption. Anyone able to use or inspect the same browser profile/device may see them. Search suggestions, search terms, recommendation queries, and video IDs are sent to public third-party providers; YouTube also receives playback requests. This static app has no account system or private server-side storage.
- The policy is delivered as a CSP meta element. Meta-delivered CSP cannot enforce `frame-ancestors`; response-header protections such as `X-Frame-Options`, `X-Content-Type-Options`, and `Permissions-Policy` must be configured by a hosting layer that supports custom response headers. This repository-only code change cannot guarantee those host-level headers.
- This is a conservative source hardening pass, not a formal penetration test. No browser/device test or third-party infrastructure audit is implied.


## Player controls update (November 21, 2026)

- Removed the Shuffle control and its random queue behavior. App-managed playback queues now advance in their original order. The Autoplay toggle and playlist/list control remain unchanged.
- The app shell and service worker cache were advanced to v18.


## Security and privacy test build (November 2026)

This repository is a separate test copy. The original `Maleksa11/test` repository is not changed by this project.

### Changes in this test build

- Removed persistence of pasted video/playlist URLs and added cleanup for the old namespaced and legacy `txt` keys.
- Added a Private mode control. When enabled, new watch history and playback progress are not saved, saved history is hidden, cached personalized feed data is ignored, and For You queries are generated from the generic topic list rather than the visitor's watched videos. Existing local history is retained until the visitor clears it.
- Added a Search suggestions control and increased the autocomplete debounce to 450 ms.
- API requests can fall back across all four configured Invidious instances when a provider is unreachable, returns an HTTP error, or sends an invalid response. A valid empty search result is treated as a real empty result, not as a reason to send the same query to more providers. The currently documented responsive provider is tried first.
- Moved CSS into `style.css`, removed `unsafe-inline`, added `style-src-attr 'none'`, and replaced dynamic `cssText` styles with CSS classes.
- Added a versioned service-worker cache for `style.css`.
- Switched the embedded player to `youtube-nocookie.com`, added an iframe sandbox, and updated IFrame API message-origin checks.
- Disabled direct Googlevideo URL extraction and background PiP in this test build. This may remove the previous PiP behavior; playback stays inside the YouTube iframe.
- Restored YouTube's native controls, keyboard controls, and fullscreen option in the player parameters.
- Removed the `googlevideo.com` media-source allowance from the page CSP.
- Added a privacy notice, security guidance, hosting headers for Cloudflare Pages/Netlify, scheduled Invidious health checks, and a JavaScript syntax-check workflow.

### Test notes

- The iframe sandbox and `youtube-nocookie.com` changes are experimental. Verify video start, queue navigation, seeking, fullscreen, autoplay, playlists, and iPhone/Android behavior before using this build as the main site.
- Private mode is a local-device preference, not an anonymity feature. Search and image requests pass through Cloudflare's relay, which receives the visitor IP; YouTube's embedded player still connects directly and receives it.
- The Invidious health workflow checks API availability and response shape. It cannot reliably prove domain ownership or detect every possible domain takeover.
- `_headers` is read by Cloudflare Pages and Netlify; GitHub Pages ignores it. The HTML meta CSP remains as a fallback, but response-only protections such as `frame-ancestors` and HSTS require a host that applies HTTP headers.
- This is not a formal security audit or a guarantee of YouTube/Apple/Google policy approval.


## Search availability hotfix

The first security test build capped failover at two instances, which could stop search even when the remaining configured instances were healthy. The hotfix restores sequential fallback across all four configured public instances, prioritizes the currently documented responsive instance, and retries only failed or invalid responses. Successful empty search responses are returned immediately without being forwarded to another provider.


## Browser-side diagnostics (v21)

The Preferences section now includes a “Test search connection” button. It checks both the normal video search endpoint and the suggestion endpoint from the visitor's actual browser origin, then reports per-instance HTTP, CORS/network, timeout, and response-shape results. API request timeout was increased to 12 seconds. The search suggestions preference key was versioned so an older setting cannot accidentally keep autocomplete disabled in the test build.


## Advanced Mode API build — November 21, 2026

The Pages build now emits a single `dist/_worker.js` Advanced Mode entrypoint from the shared relay module. `dist/_routes.json` limits Worker invocation to `/api/*`; static assets continue to use Pages' static asset serving. This avoids relying on Pages file-based route discovery for the API surface. The relay does not copy visitor-IP forwarding headers or send a fabricated placeholder IP; upstream requests are created with a clean header set. Cloudflare itself sees the visitor IP, and YouTube playback remains direct.
