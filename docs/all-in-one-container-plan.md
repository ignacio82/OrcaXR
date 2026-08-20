# OrcaXR All-in-One Local Container & Tailscale Integration Plan

**Status:** revised after a code review against the shipped server
(`server/server.js`, `server/security.mjs`, `server/Dockerfile`) and the
shipped client (`web/src/slicer/SlicerClient.ts`,
`web/src/slicer/pinnedEngineProvenance.ts`, `web/vite.config.ts`). The first
draft of this plan described a security model the code does not have and used
an Express 4 route form that throws on the pinned Express 5. Both are fixed
below; see [Appendix A](#appendix-a--review-findings-that-shaped-this-plan) for
the full list of what changed and why.

## Executive Summary

Turn the OrcaXR slicing server container ([server/Dockerfile](file:///home/ignacio/OrcaXR/server/Dockerfile))
into an **All-in-One Local Container**: it serves the production web front-end
(`web/dist`) *and* runs the attested native Snapmaker Orca CLI, so one command
gives a user a complete, self-hosted OrcaXR.

Two outcomes:

1. **Zero-config local use.** `docker compose up` → open `http://localhost:3000`
   → the app binds itself to the slicer that served it, with no URL to type and
   no token to copy.
2. **Zero-config remote XR use.** With a Tailscale auth key, the same container
   is reachable at `https://orcaxr.<tailnet>.ts.net` with a real Let's Encrypt
   certificate — a secure context, which is what WebXR on Quest 3 / Vision Pro
   requires — again with no token to copy.

The load-bearing insight that makes (1) and (2) safe is stated up front because
the rest of the plan depends on it:

> **Same-origin trust is only sound where reaching the port is itself the
> authorization boundary.** A browser cannot forge `Origin` or `Sec-Fetch-Site`,
> so same-origin checks defend against cross-origin browser attacks (CSRF). They
> do **not** defend against a non-browser client that can simply set those
> headers. Therefore same-origin trust may replace the bearer token *only* when
> the socket is loopback — either directly (`localhost`) or via Tailscale Serve,
> which terminates TLS and connects to loopback after the tailnet has already
> authenticated the peer. On a LAN-published port, the token stays mandatory.

This is why Tailscale is not an optional Phase 4 nicety in this revision: it is
the mechanism that makes the zero-config promise safe off-device.

---

## Architectural Principles & Parity Invariants

1. **Strict Provenance & Attestation.** The container keeps serving `GET /engine`
   proving the pinned Snapmaker Orca commit, the applied patch digests, and the
   SHA-256 of the binary it will actually execute (`server/server.js:66-113`).
2. **Front-end/engine coherence is proven at build time, not hoped for.** The
   client refuses an engine whose patch set differs from
   `PINNED_ENGINE_PROVENANCE.cliPatches` by name *and* digest
   (`SlicerClient.ts:1100-1121`). Because the all-in-one image builds both
   halves, the Dockerfile can assert they agree and fail the build if they do
   not. An image must never ship a UI that refuses its own engine.
3. **Authorization boundary, stated exactly.** Loopback (direct or via Tailscale
   Serve) → same-origin trust, no token. Anything else → bearer token plus an
   explicit `ORCAXR_ALLOWED_ORIGINS` allowlist, exactly as
   `validateServerConfig` enforces today (`security.mjs:239-250`).
4. **Secure context is a feature requirement, not a detail.** WebXR needs
   HTTPS-or-localhost; the in-browser WASM engine needs `SharedArrayBuffer`,
   which needs cross-origin isolation (`SlicerClient.ts:92-105`). The container
   must therefore send the same COOP/COEP/Permissions-Policy header set the dev
   and preview servers send (`web/vite.config.ts:9-17`).
5. **No silent downgrades.** Every place the deployment loses a capability
   (plain-HTTP LAN access loses WebXR, in-browser slicing, and service workers)
   must be reported to the user rather than degrade quietly.

---

## Technical Architecture Overview

```
                    ┌──────────────── OrcaXR All-in-One Container ────────────────┐
                    │                                                             │
 headset / laptop   │  ┌───────────────┐        ┌──────────────────────────────┐  │
        │           │  │  tailscaled   │        │      Express 5 (server.js)   │  │
        │  HTTPS    │  │  + serve      │──────▶ │  bound 127.0.0.1:3000        │  │
        └──────────▶│  │  (userspace)  │  loop  │                              │  │
   orcaxr.ts.net    │  └───────────────┘  back  │  ├─ static  /app/public ◀─────┼──┐
                    │         ▲                 │  │   (web/dist + COOP/COEP)   │  │
                    │         │ Let's Encrypt   │  ├─ GET  /engine  (attestation)│ │
 localhost:3000 ────┼─────────┘                 │  ├─ POST /slice   ──┐          │ │
                    │                           │  ├─ GET  /jobs/:id  │          │ │
                    │                           │  └─ SPA fallback    │          │ │
                    │                           └─────────────────────┼──────────┘ │
                    │                                                 ▼            │
                    │                                  ┌───────────────────────┐   │
                    │                                  │ /app/orca/bin/        │   │
                    │                                  │   snapmaker-orca      │   │
                    │                                  │ + engine-provenance   │   │
                    │                                  └───────────────────────┘   │
                    └─────────────────────────────────────────────────────────────┘
                                                                     │
                        build-time assertion: engine-provenance.json patches
                        ==  pinnedEngineProvenance.ts cliPatches ─────┘
```

---

## Phase 0: Prerequisites (must land first)

### 0.1 `.dockerignore` — **done**

The build context is the repository root (`server/docker-compose.yml` uses
`context: ..`). That tree was **16 GB**: `third_party/` alone is 14 GB and
`web/node_modules/` is 552 MB, and every build sent all of it to the daemon
before the first instruction ran. Adding a `web-builder` stage makes this worse
— a bare `COPY web/ ./` would also overwrite the freshly installed
`node_modules` with the host's (wrong-architecture native binaries) and copy a
stale `web/dist` into the image.

`/.dockerignore` now exists. Measured: **47 MB transferred, 63 MB on disk**, a
~340× reduction. Verified that every path a stage `COPY`s survives
(`server/patches`, `server/*.js|mjs|json`, `wasm/dist/*`,
`wasm/artifact-provenance.json`, `web/package.json`, `web/src`,
`web/public/slicer/slic3r.wasm`) and that `third_party`, `.git`, all
`node_modules`, `server/wasm-dist`, `web/dist`, `docs/slicer`, and `server/.env`
do not.

`server/wasm-dist` is excluded because it is a gitignored local publish that may
be stale; the runtime stage copies the canonical `wasm/dist` instead (see 1.3).

### 0.2 Publish a prebuilt image

"Run OrcaXR in a single command" is not true if that command triggers a
from-source OrcaSlicer build — `build_linux.sh -dr && -sr` takes roughly an hour
and needs ~15 GB of scratch space. The user-facing path must be a **pull**, not
a build:

- CI job publishes `ghcr.io/<org>/orcaxr:<version>` and `:latest` on tag.
- `server/docker-compose.yml` gains `image: ghcr.io/<org>/orcaxr:${ORCAXR_TAG:-latest}`
  alongside `build:`, so `docker compose up` pulls by default and
  `docker compose build` remains available for engine work.
- Publish `linux/amd64` first. `linux/arm64` is a follow-up: the orca build
  stage is long enough that emulated cross-builds are impractical, so arm64
  needs a native runner before it is promised.
- Record the published image digest next to the engine provenance, so a user can
  check that the image they pulled is the one CI attested.

---

## Phase 1: Multi-Stage Docker Build Pipeline

### 1.1 Web builder stage

```dockerfile
# ---- Stage 0: build the production web front-end ----
FROM node:22-slim AS web-builder
WORKDIR /build

# Lockfile-only install layer, so front-end source edits do not re-resolve deps.
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci

# The build reads tools/ and wasm/ through relative paths in web/scripts and
# web/tools; copy them so `vite build` and its verify hooks see a real tree.
COPY web/ ./web/
COPY tools/ ./tools/
COPY wasm/dist/ ./wasm/dist/

# NOT ORCAXR_DEPLOY=1: that variant targets GitHub Pages (base /slicer/, PWA
# service worker dropped in favour of the COI shim). The container serves real
# COOP/COEP headers at the root, so it wants base '/' and the VitePWA worker.
RUN npm --prefix web run build \
 && test -f web/dist/index.html \
 && test -f web/dist/slicer/slic3r.wasm
```

The `ORCAXR_DEPLOY` choice is load-bearing and easy to get wrong in both
directions — see [2.4](#24-service-worker-scope-one-owner-only).

### 1.2 Build-time front-end/engine coherence assertion

Add this to the runtime stage, after both the engine provenance manifest and the
web bundle are present. It is the cheapest possible guarantee that the image is
internally consistent:

```dockerfile
# The client refuses any CLI engine whose patch set differs from the one
# compiled into it (SlicerClient.compareCliPatches). If this image shipped a UI
# and an engine that disagree, every slice would fail at run time with a
# provenance error. Fail the *build* instead.
COPY web/src/slicer/pinnedEngineProvenance.ts /tmp/pinned.ts
RUN node -e '                                                                 \
  const fs = require("fs");                                                    \
  const eng = JSON.parse(fs.readFileSync("/app/orca/engine-provenance.json")); \
  const src = fs.readFileSync("/tmp/pinned.ts", "utf8");                       \
  const pinnedCommit = src.match(/commit:\s*.([0-9a-f]{40})./)[1];             \
  if (eng.engine.commit !== pinnedCommit)                                      \
    throw new Error(`commit drift: ${eng.engine.commit} != ${pinnedCommit}`);  \
  const block = src.split("cliPatches:")[1];                                   \
  const pinned = new Map(                                                      \
    [...block.matchAll(/.([\w.-]+\.patch).:\s*\n?\s*.([0-9a-f]{64})./g)]       \
      .map((m) => [m[1], m[2]]));                                              \
  const applied = new Map(eng.patches.map((p) => [p.name, p.sha256]));         \
  for (const [n, d] of pinned)                                                 \
    if (applied.get(n) !== d) throw new Error(`patch drift: ${n}`);            \
  for (const n of applied.keys())                                              \
    if (!pinned.has(n)) throw new Error(`engine carries unpinned patch: ${n}`);\
  console.log(`[orcaxr] engine/UI coherent: ${pinned.size} patches @ ${pinnedCommit}`); \
' && rm /tmp/pinned.ts
```

If the regex parsing of a `.ts` file feels brittle: the durable version is to
have `web/scripts` emit `web/dist/engine-pin.json` during the build and compare
two JSON files. Prefer that if the build script is being touched anyway.

### 1.3 Runtime stage changes

Keep every existing runtime property. The additions are the web bundle, the
entrypoint, and one bug fix:

```dockerfile
# ---- Stage 2: runtime (existing) ----
FROM ubuntu:24.04
# ... existing runtime deps, /app/orca copy, orca-slicer shim,
#     engine-provenance binary digest step ...

WORKDIR /app

COPY server/package*.json ./
RUN npm ci --omit=dev

# DONE — the attestation and the slice worker now resolve one directory
# (slice_worker.mjs resolveWasmDir), and the image publishes the manifest
# beside the artifacts it describes.
COPY wasm/dist /app/wasm-dist
COPY wasm/artifact-provenance.json /app/wasm-dist/artifact-provenance.json

# The production web bundle this image serves.
COPY --from=web-builder /build/web/dist /app/public

COPY server/server.js server/security.mjs server/slice_worker.mjs \
     server/preset_key_types.json ./
COPY server/entrypoint.sh /usr/local/bin/orcaxr-entrypoint

RUN chmod +x /usr/local/bin/orcaxr-entrypoint \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin orcaxr \
 && install -d -o orcaxr -g orcaxr /var/lib/tailscale

EXPOSE 3000
ENV PORT=3000
ENV HOST=127.0.0.1
ENV HOME=/home/orcaxr
ENV ORCAXR_WEB_ROOT=/app/public

# Root only long enough to start tailscaled; the entrypoint drops to orcaxr
# before exec'ing node. See Phase 4.
ENTRYPOINT ["/usr/local/bin/orcaxr-entrypoint"]
CMD ["node", "server.js"]
```

Note the image now carries the ~15 MB `slic3r.wasm` twice: once in
`/app/public/slicer/` (served to the browser) and once in `/app/wasm-dist/`
(loadable by `SLICER_ENGINE=wasm`). That is intentional — they are consumed by
different processes and hashed against different manifests — but it should be a
conscious ~30 MB, not a surprise.

---

## Phase 2: Serving the Web UI from Express 5

### 2.1 Route order (this is the part that breaks if it is guessed)

`server/server.js` registers, in order: global headers → rate limit → CORS →
auth → JSON body → routes → error handler → JSON 404 (`server.js:611-1084`).
Static assets and the SPA fallback go **after every API route and before the
JSON 404 handler**. Registering them earlier makes the fallback shadow
`GET /jobs/:id` and `GET /jobs/:id/output`, which the first draft's exclusion
list did not mention (it excluded `/health`, which is not a route — the health
route is `/ping`, `server.js:809`).

### 2.2 Static middleware, with correct cache semantics

The global middleware sets `Cache-Control: no-store` on every response
(`server.js:614`). That is right for the API and wrong for hashed assets, and
blanket `immutable, max-age=1y` — as the first draft proposed — is wrong for the
unhashed files Vite also emits (`sw.js`, `coi-serviceworker.js`,
`manifest.webmanifest`, `icon.svg`, `profiles/catalog.json`). Marking those
immutable pins a stale service worker and a stale profile catalog on every
existing client, permanently.

```javascript
const WEB_ROOT = process.env.ORCAXR_WEB_ROOT || path.join(__dirname, "public");
const SERVES_WEB_UI = existsSync(path.join(WEB_ROOT, "index.html"));

// COOP/COEP: SharedArrayBuffer — and therefore in-browser WASM slicing — needs
// cross-origin isolation. Permissions-Policy xr-spatial-tracking is what lets
// WebXR start. These MUST match web/vite.config.ts securityHeaders exactly; a
// test asserts they do.
const WEB_SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(self), microphone=(), geolocation=(), xr-spatial-tracking=(self)",
};

const applyWebHeaders = (res) => {
  for (const [k, v] of Object.entries(WEB_SECURITY_HEADERS)) res.setHeader(k, v);
};

if (SERVES_WEB_UI) {
  app.use(
    express.static(WEB_ROOT, {
      index: false,
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        applyWebHeaders(res);
        const rel = path.relative(WEB_ROOT, filePath);
        const contentHashed =
          rel.startsWith("assets" + path.sep) && /-[A-Za-z0-9_-]{8,}\./.test(rel);
        res.setHeader(
          "Cache-Control",
          contentHashed
            ? "public, max-age=31536000, immutable"
            : "no-cache", // revalidate: SW, manifest, catalog, icons, HTML
        );
      },
    }),
  );
}
```

`express.static` sets `Cache-Control` itself, which overwrites the earlier
`no-store` — that is the intended interaction, but it is exactly the kind of
ordering coupling that deserves the comment and the test in [5.2](#5-verification--testing-strategy).

### 2.3 SPA fallback — Express 5 syntax, and an allowlist not a denylist

**`app.get("*", …)` throws on the pinned Express 5.2.1.** Verified against the
installed dependency:

```
TypeError: Missing parameter name at index 1: *
```

Express 5 uses path-to-regexp v8; the bare `*` wildcard was removed. Use a
RegExp route (or `/*splat`). And gate on what a document request actually looks
like, so a mistyped API path still returns the JSON 404 the client's error
handling expects instead of an HTML page:

```javascript
if (SERVES_WEB_UI) {
  const INDEX_HTML = path.join(WEB_ROOT, "index.html");
  // Registered after every API route: anything that reaches here matched none
  // of them. Only real document navigations get the SPA shell.
  app.get(/.*/, (req, res, next) => {
    if (!req.accepts("html")) return next();          // fetch/XHR → JSON 404
    if (path.extname(req.path)) return next();        // missing asset → 404
    applyWebHeaders(res);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(INDEX_HTML, (error) => (error ? next() : undefined));
  });
}
```

`ORCAXR_WEB_ROOT` keeps a dev checkout working: `npm --prefix server start`
resolves `server/public` (absent → API-only, exactly today's behaviour), and CI
can point it at `web/dist` without building an image.

### 2.4 Service worker scope: one owner only

`web/index.html:12` loads `coi-serviceworker.js` unconditionally, and the
non-deploy Vite build also emits the VitePWA worker at scope `/`. Two service
workers cannot both control `/` — which is precisely why the `ORCAXR_DEPLOY`
path drops VitePWA (`web/vite.config.ts:5-8`).

The container avoids the collision *because* it sends real COOP/COEP headers:
`coi-serviceworker.js:190` returns before registering when
`window.crossOriginIsolated` is already true, leaving VitePWA the sole owner of
scope `/`.

That makes the header block in 2.2 doubly load-bearing. **If COOP/COEP are ever
dropped from the static route, the container silently acquires two competing
service workers on top of losing in-browser slicing.** The test in 5.2 asserts
the headers for that reason, not merely for isolation.

---

## Phase 3: Same-Origin Trust (the actual security work)

The first draft asserted that "requests originating from the local web UI are
granted zero-config slicer session access." **No such concept exists in the
code.** Today:

- `authRequired = Boolean(token) || !isLoopbackHost(host)` (`security.mjs:86`),
  and the auth middleware runs before every route (`server.js:638-651`). With a
  non-loopback bind, `GET /` and `GET /engine` return 401 — the browser cannot
  even load the app.
- `validateServerConfig` *refuses to boot* on a non-loopback `HOST` without a
  ≥32-byte token and an explicit origin allowlist (`security.mjs:239-250`).
- `isOriginAllowed` returns `true` when `Origin` is absent (`security.mjs:265`),
  which is correct for the CORS layer and would be a hole if reused as an auth
  decision: a naive "same-origin ⇒ no token" check would let any non-browser
  client on the LAN slice by simply omitting the header.

So same-origin trust must be *built*, and scoped to where it is sound.

### 3.1 Trust modes

Add `ORCAXR_TRUST` to `loadServerConfig` with three values:

| Mode | When | Token required |
| :--- | :--- | :--- |
| `loopback` (default) | `HOST` is loopback | No (unchanged behaviour) |
| `same-origin` | `HOST` is loopback **and** the image serves the UI | No, for same-origin browser requests |
| `token` (default when `HOST` is non-loopback) | LAN-published port | Yes, plus `ORCAXR_ALLOWED_ORIGINS` |

`same-origin` is only selectable on a loopback bind. Requesting it with a
non-loopback `HOST` is a boot-time error with an explicit message naming
Tailscale Serve as the supported way to reach a loopback bind remotely. This is
the invariant from the summary, enforced in `validateServerConfig` rather than
documented and hoped for.

An operator who genuinely wants an unauthenticated LAN port must set
`ORCAXR_TRUST=same-origin` *and* `ORCAXR_ACCEPT_LAN_EXPOSURE=yes-i-understand`;
the server logs a one-line warning naming the bind address every startup. Never
make this reachable by accident.

### 3.2 The same-origin predicate

```javascript
// A browser cannot forge Origin or Sec-Fetch-Site, so these two together
// establish "this request came from the page we served". They do NOT establish
// "this client is authorized" — a non-browser client sets any header it likes.
// That is why this predicate may only relax auth on a loopback socket, where
// reaching the port is already the authorization boundary.
function isSameOriginRequest(req, config) {
  const forwardedProto = config.trustedProxy ? req.get("x-forwarded-proto") : null;
  const scheme = (forwardedProto || req.protocol || "http").split(",")[0].trim();
  const host = req.get("host");
  if (!host) return false;
  const self = `${scheme}://${host}`.toLowerCase();

  const fetchSite = req.get("sec-fetch-site");
  const origin = req.get("origin");

  if (req.method === "GET" || req.method === "HEAD") {
    // Documents and subresources: `none` is a typed-in URL or bookmark.
    if (fetchSite === "same-origin" || fetchSite === "none") return true;
    return origin ? origin.toLowerCase() === self : false;
  }

  // State-changing requests must carry a matching Origin. A missing Origin is
  // NOT treated as same-origin here, unlike the CORS layer: that is the
  // difference between "no CORS preflight needed" and "authorized to slice".
  if (!origin || origin.toLowerCase() !== self) return false;
  return fetchSite === undefined || fetchSite === "same-origin";
}
```

Then in the auth middleware (`server.js:638`):

```javascript
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (!config.authRequired) return next();
  if (config.trustSameOrigin && isSameOriginRequest(req, config)) return next();
  // ... existing bearer check, unchanged ...
});
```

And `isOriginAllowed` must additionally accept an origin that equals the
request's own `${scheme}://${host}` when `trustSameOrigin` is on — otherwise the
Tailscale case dies at the CORS layer before it reaches auth. **This was a
concrete bug in the first draft's security matrix**: browsers send `Origin` on
every POST, including same-origin ones, so a same-origin `POST /slice` from
`https://orcaxr.tailnet.ts.net` presents an origin that is neither loopback nor
in `explicitOrigins` and is rejected with `403 ORIGIN_DENIED`.

### 3.3 Generate a token instead of refusing to boot

For non-browser clients (MCP, `curl`, scripts) the token still matters even in
`same-origin` mode. Rather than making the operator invent one:

- If `ORCAXR_SERVER_TOKEN` is unset, generate 32 random bytes, persist to
  `${HOME}/.orcaxr/server-token` at mode 0600, and log it once at startup with
  the exact `Authorization: Bearer …` header to use.
- Support `ORCAXR_SERVER_TOKEN_FILE` so Docker/Compose secrets work. Env-var
  secrets are readable via `docker inspect` and leak into shell history; the
  `_FILE` form is the documented pattern for both this and `TS_AUTHKEY`.

### 3.4 Rate limiting behind a proxy

`app.set("trust proxy", false)` (`server.js:612`) means every request arriving
through Tailscale Serve is keyed to `127.0.0.1`, so all tailnet users share one
rate-limit bucket and one person's slice queue 429s everyone else. When
`ORCAXR_TRUSTED_PROXY=loopback` is set:

- `app.set("trust proxy", "loopback")`, so `req.protocol` and `req.ip` are real.
- Prefer the `Tailscale-User-Login` header that Serve injects as the rate-limit
  key when present, falling back to IP. The tailnet has already authenticated
  that identity, so it is a better key than a shared proxy address — and it also
  gives the server an honest "who sliced this" line for its logs.

---

## Phase 4: Client Auto-Discovery

Enhance the slicer client so it binds itself to the origin that served it.

### 4.1 The check must be the real attestation, not `attested: true`

The first draft bound on the server's self-reported `attested: true`. That is
not the client's test. `SlicerClient.attestExternalEngine()` additionally
requires `record.upstream.commit === PINNED_ENGINE_PROVENANCE.commit` and, for
CLI, an exact name-and-digest match against `cliPatches`
(`SlicerClient.ts:267-277`, `1100-1121`). Binding on the weaker check would show
a green light and then fail at slice time with a provenance error.

So: **call `attestExternalEngine()` itself.** Nothing else.

### 4.2 Flow

1. On startup, if `EXTERNAL_URL_KEY` holds an explicit user choice, do nothing.
   A user's configured endpoint always wins over discovery.
2. Otherwise, only if `location.origin` is not a known static host (skip when the
   app was served from the GitHub Pages deployment — there, `/engine` 404s and
   the probe is pure latency), provisionally set the endpoint to
   `location.origin`, enable it, and call
   `SlicerClient.attestExternalEngine()`.
3. On `{ attested: true }`, keep the binding and mark it
   `origin: 'auto-discovered'` in local storage — distinct from a user-typed
   endpoint, so a later image upgrade may re-probe rather than inherit a stale
   choice.
4. On `{ attested: false, reason }`, revert to `browser-wasm` and surface the
   reason in the External Slicer panel. Never leave a failed probe enabled —
   `connectExternalSlicer` already establishes this discipline
   (`SlicerClient.ts:296-320`); auto-discovery must follow it.

### 4.3 Auto-binding must be visible, named, and revertible

The repo's honesty invariants do not permit a hidden route for canonical work.
The External Slicer panel shows, without being opened:

> **Slicing here** · Snapmaker Orca 2.3.4 CLI · 4 patches · attested — *use browser engine instead*

### 4.4 Say what plain-HTTP LAN access costs

`http://192.168.1.20:3000` is **not** a secure context. That means no WebXR, no
`SharedArrayBuffer` (so no in-browser engine — the external CLI route is the
only one that works), no service worker, and Chrome's Local Network Access
prompt on top. `http://localhost:3000` and `https://*.ts.net` are the only fully
functional origins.

`localNetworkFailureMessage` already recommends Tailscale Serve for this reason
(`web/src/net/LocalNetworkAccess.ts:83-89`). The all-in-one UI should say the
same thing proactively when it detects a non-secure context, rather than letting
the user discover it as three unrelated broken features.

---

## Phase 5: Tailscale Integration

Both first-draft options had blocking defects. Option B never enabled HTTPS at
all — it started `tailscaled` but no `tailscale serve`, so the `.ts.net` TLS
endpoint that motivates the whole phase did not exist. Option A could not run in
the container it was written for. Corrected below; **the sidecar is the
recommended default**, because it keeps `tailscaled`'s root requirements out of
the app image.

**Tailnet prerequisite (was missing entirely):** HTTPS certificates must be
enabled for the tailnet in the admin console (Settings → Features → HTTPS
Certificates) and MagicDNS must be on. Without both, `tailscale serve` cannot
obtain a Let's Encrypt certificate and the headset gets a certificate warning —
which defeats the secure-context requirement.

### 5.1 Option A — integrated (single container)

Two fixes are required over the first draft:

- **Pin the binary and get it from a real source.** `apt-get install -y
  tailscale` on `ubuntu:24.04` is not a supported install path and is unpinned
  even where a package exists. Copy from the official image at a fixed version:

  ```dockerfile
  FROM tailscale/tailscale:v1.78.1 AS tailscale
  # ... in the runtime stage:
  COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled
  COPY --from=tailscale /usr/local/bin/tailscale  /usr/local/bin/tailscale
  ```

  `iptables` is not needed: userspace networking does not touch netfilter.

- **Persist state, and drop privileges correctly.** Without
  `--statedir`/`--state` on a volume, every restart consumes a fresh auth key
  and registers a *new* node — `orcaxr-1`, `orcaxr-2` — so the URL the user
  bookmarked changes on restart. And `tailscaled` needs root while the app must
  not have it, so the entrypoint starts as root and drops with `setpriv`.

```sh
#!/bin/sh
# server/entrypoint.sh
set -eu

if [ -n "${TS_AUTHKEY_FILE:-}" ]; then
  TAILSCALE_AUTHKEY="$(cat "$TS_AUTHKEY_FILE")"
fi

if [ -n "${TAILSCALE_AUTHKEY:-}" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "[OrcaXR] tailscaled needs root; start the container as root or use the sidecar." >&2
    exit 1
  fi
  echo "[OrcaXR] starting tailscaled (userspace networking)"
  # --statedir on a volume: without it, each restart burns an auth key and
  # registers a NEW node, so the .ts.net hostname the user bookmarked changes.
  tailscaled \
    --tun=userspace-networking \
    --statedir=/var/lib/tailscale \
    --socket=/tmp/tailscaled.sock &

  tailscale --socket=/tmp/tailscaled.sock up \
    --authkey="${TAILSCALE_AUTHKEY}" \
    --hostname="${TS_HOSTNAME:-orcaxr}" \
    ${TS_EXTRA_ARGS:-}

  if [ "${TAILSCALE_SERVE:-true}" = "true" ]; then
    echo "[OrcaXR] enabling Tailscale Serve → https://$(tailscale --socket=/tmp/tailscaled.sock status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
    tailscale --socket=/tmp/tailscaled.sock serve --bg 3000
  fi
fi

# Drop to the unprivileged app user for the server itself.
if [ "$(id -u)" -eq 0 ]; then
  exec setpriv --reuid=10001 --regid=10001 --init-groups "$@"
fi
exec "$@"
```

`TAILSCALE_AUTHKEY` unset ⇒ the whole block is skipped and the container is a
plain localhost server, unchanged. The `serve` target stays `3000` on loopback,
which is why `HOST` can remain `127.0.0.1` and same-origin trust stays sound.

Use an **ephemeral, pre-authorized, tagged** auth key. If the key is already
tagged, do not also pass `--advertise-tags` (the first draft did, in the
sidecar); the two conflict and `tailscale up` errors.

### 5.2 Option B — sidecar (recommended)

```yaml
services:
  orcaxr:
    image: ghcr.io/<org>/orcaxr:${ORCAXR_TAG:-latest}
    build:
      context: ..
      dockerfile: server/Dockerfile
    container_name: orcaxr
    init: true
    ports:
      - "127.0.0.1:3000:3000"   # loopback-only publish; see note below
    environment:
      - SLICER_ENGINE=cli
      - MAX_OLD_SPACE_SIZE=4096
      - PORT=3000
      - HOST=127.0.0.1
      - ORCAXR_TRUST=same-origin
      - ORCAXR_TRUSTED_PROXY=loopback
      - ORCAXR_WEB_ROOT=/app/public
    secrets:
      - orcaxr_server_token
    healthcheck:
      # /ping is behind the auth middleware, so a token-mode deployment must
      # authenticate its own healthcheck. Same-origin mode does not need to.
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
    tmpfs:
      - /tmp:size=8g,mode=1777    # slices land in os.tmpdir(); bound it
    restart: unless-stopped
    stop_grace_period: 20s

  tailscale:
    image: tailscale/tailscale:v1.78.1   # pinned, not :latest
    container_name: orcaxr-tailscale
    hostname: ${TS_HOSTNAME:-orcaxr}
    profiles: [tailscale]
    environment:
      - TS_AUTHKEY_FILE=/run/secrets/tailscale_authkey
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_USERSPACE=true
      # THIS is what the first draft omitted: without a serve config there is
      # no HTTPS endpoint, so no secure context, so no WebXR.
      - TS_SERVE_CONFIG=/config/serve.json
    secrets:
      - tailscale_authkey
    volumes:
      - tailscale-data:/var/lib/tailscale
      - ./tailscale-serve.json:/config/serve.json:ro
    network_mode: "service:orcaxr"
    depends_on: [orcaxr]
    restart: unless-stopped

secrets:
  orcaxr_server_token:
    file: ./secrets/server-token
  tailscale_authkey:
    file: ./secrets/tailscale-authkey

volumes:
  tailscale-data:
```

No top-level `version:` key — it is obsolete in Compose v2 and emits a warning;
the current `server/docker-compose.yml` correctly omits it, and the first draft
reintroduced it.

`server/tailscale-serve.json`:

```json
{
  "TCP": { "443": { "HTTPS": true } },
  "Web": {
    "${TS_CERT_DOMAIN}:443": {
      "Handlers": { "/": { "Proxy": "http://127.0.0.1:3000" } }
    }
  }
}
```

Because `network_mode: "service:orcaxr"` shares the network namespace, the
sidecar reaches the loopback-bound server directly — so `HOST` stays
`127.0.0.1`, the port publish stays `127.0.0.1:3000:3000`, and nothing is
exposed to the LAN by default.

**Do not enable Tailscale Funnel** unless the user explicitly asks. Funnel puts
the slicer on the public internet, where same-origin trust is no longer sound
and the token mode is mandatory. Say this in the docs next to the Serve
instructions, because the two commands look nearly identical.

---

## Security & CORS Matrix (corrected)

| Origin context | Bind | `ORCAXR_TRUST` | Token | Why it is safe |
| :--- | :--- | :--- | :--- | :--- |
| `http://localhost:3000` (container web UI) | `127.0.0.1` | `same-origin` | Not required | Only processes on the host can reach a loopback socket |
| `https://orcaxr.<tailnet>.ts.net` via Serve | `127.0.0.1` | `same-origin` | Not required | Serve terminates TLS and connects to loopback *after* the tailnet authenticated the peer |
| `http://192.168.x.x:3000` (LAN publish) | `0.0.0.0` | `token` | **Required** (≥32 B) + explicit `ORCAXR_ALLOWED_ORIGINS` | Anyone on the LAN can reach the socket; header-based trust is forgeable by non-browsers |
| Hosted app (`orcaxr.martinez.fyi`) → LAN container | `0.0.0.0` | `token` | **Required** + allowlisted origin | Cross-origin by construction |
| Tailscale **Funnel** (public) | `127.0.0.1` | `token` | **Required** | The socket is reachable by the internet; loopback no longer implies authorization |
| Non-browser client (MCP, curl, CI) in any mode | any | any | **Required** | `Origin`/`Sec-Fetch-Site` prove nothing outside a browser — this is why 3.2 refuses a missing `Origin` on POST |

---

## Verification & Testing Strategy

The repo's own gate applies: `./scripts/quality.sh` for the clean-clone
repository check, and at minimum `npm --prefix web run quality` for web changes.
The items below are what this feature adds on top.

### 1. Build

- `docker build -t orcaxr-standalone -f server/Dockerfile .` — confirm the
  context upload is megabytes, not gigabytes (proves `.dockerignore` works).
- Assert `/app/public/index.html`, `/app/public/slicer/slic3r.wasm`,
  `/app/wasm-dist/artifact-provenance.json`, and
  `/app/orca/bin/snapmaker-orca` all exist.
- **Negative test:** edit one byte of a `server/patches/*.patch` without
  updating `pinnedEngineProvenance.ts`; the build must fail at 1.2 with
  `patch drift`. This test is the whole value of that step.

### 2. Server unit/integration tests (`server/server.unit.test.mjs`)

New cases, each pinned to a defect found in review:

- `app.get(/.*/)` boots — a regression guard against reintroducing `"*"`, which
  throws `Missing parameter name at index 1` on Express 5.2.1.
- The SPA fallback does **not** shadow `GET /jobs/:id` or `/jobs/:id/output`.
- A `fetch`-style request (`Accept: application/json`) to an unknown path still
  gets the JSON 404, not HTML.
- Static responses carry `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: credentialless`, and those values are read from
  the same table `web/vite.config.ts` uses — a drift test, because losing them
  costs in-browser slicing *and* creates a duplicate service worker.
- Hashed `assets/*.js` get `immutable`; `sw.js`, `coi-serviceworker.js`, and
  `manifest.webmanifest` get `no-cache`.
- `same-origin` mode: `GET /` and `POST /slice` with a matching `Origin`
  succeed without a token; `POST /slice` with **no** `Origin` gets 401; `POST
  /slice` with a foreign `Origin` gets 403.
- `ORCAXR_TRUST=same-origin` with a non-loopback `HOST` fails to boot with the
  message naming Tailscale Serve.
- `token` mode is byte-for-byte unchanged — the existing suite must still pass
  untouched.

### 3. Client tests

- Auto-discovery calls `attestExternalEngine()` (not a bare `attested` read) and
  reverts to `browser-wasm` on any failure reason, leaving the endpoint disabled.
- An explicit user endpoint in `localStorage` is never overwritten by discovery.

### 4. Live local run

`docker compose up` → `http://localhost:3000` → app loads → the External Slicer
panel already reads "Slicing here · attested" → slice a multi-filament project
3MF end to end. Then confirm `window.crossOriginIsolated === true` and that only
one service worker is registered for scope `/`.

### 5. Tailscale + WebXR

- `docker compose --profile tailscale up`, restart the stack twice, and confirm
  the node keeps the **same** hostname (proves state persistence — the defect
  that would otherwise change the user's URL on every restart).
- On Quest 3 / Vision Pro, open `https://orcaxr.<tailnet>.ts.net`, confirm no
  certificate warning, enter an immersive session, and slice.
- Confirm two headsets slicing simultaneously do not 429 each other (proves the
  proxy-aware rate-limit keying in 3.4).

### 6. Documentation, per the self-update mandate

`GEMINI.md` and `README.md` must be updated in the **same commit**: the README's
"External Slicer (Docker)" section currently tells users to type
`http://localhost:3000` into a panel, which the all-in-one image makes obsolete,
and `GEMINI.md` gains the same-origin trust invariant and the build-time
coherence assertion.

---

## Appendix A — Review findings that shaped this plan

Recorded so the reasoning is not lost, and so none of these are reintroduced.

**Would not have run:**

1. `app.get("*", …)` throws on Express 5.2.1 (path-to-regexp v8). Verified.
2. `docker run -p 3000:3000` cannot work: the image sets `HOST=127.0.0.1`, so
   the published port has nothing listening; setting `HOST=0.0.0.0` makes
   `validateServerConfig` refuse to boot without a token and an origin
   allowlist. The draft's verification step 2 was therefore impossible.
3. The draft's Compose replaced the existing `${VAR:?error}` guards with
   `${VAR:-}` defaults, which removes the guardrail preventing an
   unauthenticated public bind — and then fails to boot anyway, for (2).
4. Option B started `tailscaled` but never `tailscale serve`, so it produced no
   HTTPS endpoint and could not satisfy the WebXR secure-context requirement
   that motivates the phase.
5. Option A's `tailscaled` needs root, but the image ends with `USER orcaxr`;
   and with no `--statedir` on a volume, every restart registers a new node and
   changes the user's URL.
6. `apt-get install -y tailscale` is not a supported install path on the
   `ubuntu:24.04` base, and is unpinned regardless.

**Security model did not match the code:**

7. "Same-origin ⇒ zero-config access" describes a feature the code does not
   have; the auth middleware is global and precedes every route.
8. Browsers send `Origin` on same-origin POSTs, so the Tailscale row of the
   draft's matrix would have been rejected at the CORS layer with
   `403 ORIGIN_DENIED`, before auth was even consulted.
9. Reusing `isOriginAllowed`'s "absent `Origin` ⇒ allowed" rule as an auth
   decision would let any non-browser client on the network slice without a
   token. Phase 3.2 refuses a missing `Origin` on state-changing requests
   specifically to close this.

**Would have shipped broken behaviour:**

10. No COOP/COEP headers → no `SharedArrayBuffer` → in-browser WASM slicing
    fails outright, *and* `coi-serviceworker.js` starts registering, producing
    two service workers competing for scope `/`.
11. No `Permissions-Policy: xr-spatial-tracking=(self)` → WebXR can be blocked.
12. `immutable, max-age=1y` applied to the whole bundle permanently pins a stale
    service worker and profile catalog for existing clients.
13. The fallback's exclusion list named `/health` (not a route; it is `/ping`)
    and omitted `/jobs/:id` and `/jobs/:id/output`.
14. Auto-discovery keyed on the server's `attested: true` rather than the
    client's real check (pinned commit + exact CLI patch digests), which would
    show a green light and fail at slice time.

**Pre-existing bugs — both now FIXED, ahead of the rest of this plan:**

15. **Split-brain WASM directory.** `server/Dockerfile` copied `wasm/dist` →
    `/app/wasm/dist`, but the attestation resolved `path.join(__dirname,
    "wasm-dist")` = `/app/wasm-dist`, while `slice_worker.mjs` loaded the module
    from `/app/wasm/dist`. So the container **executed a real engine and
    reported `attested: false`**, and the client refused a route that was
    actually sound. Reproduced against `HEAD`:

    ```
    {"engine":"wasm","attested":false,
     "reason":"The server could not read its own WASM engine artifacts."}
    ```

    The minimal fix would have been a one-line `COPY` change, but that would
    leave two independent resolvers free to disagree again — and the failure in
    the other direction (attesting a directory you do not load) is worse, since
    it vouches for a build that never runs. So `resolveWasmDir()` /
    `resolveWasmProvenancePath()` in `slice_worker.mjs` are now the sole
    authority and `GET /engine` hashes what they return.

    Verified in a simulated container layout: `attested: true`, commit
    `9fd12ffb…`, digests equal to `PINNED_ENGINE_PROVENANCE.artifacts`. Also
    verified backward-compatible — an image already built from the old
    Dockerfile now attests too, because the resolver still finds `wasm/dist` and
    falls back one level up for the manifest. Locked by a new unit test that
    asserts both consumers resolve the same directory and that a swapped
    artifact stops attesting.

16. **No `.dockerignore`; the build context was 16 GB.** Now 47 MB transferred
    (see 0.1), with the required/excluded path sets both verified.

**Improvements added:**

17. Build-time assertion that the shipped UI and the shipped engine agree on
    commit and patch digests — the image cannot ship a UI that refuses its own
    engine.
18. Publish a prebuilt image; a one-hour from-source build is not "one command".
19. Auto-generate and persist a server token instead of refusing to boot, and
    support `*_FILE` secrets for both the token and the Tailscale auth key.
20. Proxy-aware rate-limit keying using Serve's `Tailscale-User-Login`, so one
    headset cannot 429 another.
21. `ORCAXR_WEB_ROOT` so a dev checkout and CI can exercise the static route
    without building an image.
22. State plainly what plain-HTTP LAN access costs (no WebXR, no in-browser
    engine, no service worker) instead of letting the user find out three times.
23. Warn explicitly that Funnel is not Serve: Funnel is public, and same-origin
    trust is unsound there.
