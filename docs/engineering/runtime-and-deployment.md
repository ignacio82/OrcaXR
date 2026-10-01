# Runtime, persistence, networking and deployment

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

## Web → local services: Chrome Local Network Access + CORS

`web/src/printer/` is the single Moonraker boundary: explicit endpoint normalization without scheme/port probing, typed HTTP/WebSocket handshake/state/capabilities, cancellation/timeouts, stale-event rejection, reconnect/heartbeat, and bounded redacted diagnostics. `main.ts` uses it through `ActionRegistry` for live connection tests and read-only filament-slot inspection; sparse physical slot IDs are preserved and never auto-applied to project mappings. Printer API keys and slicer tokens are optionally remembered in device-local browser storage (enabled by default); disabling remembrance erases saved copies. That storage is not encrypted by OrcaXR and is accessible to same-origin scripts and browser-profile users. Transport credentials remain per-instance memory, and AI credentials remain tab-memory only. Legacy printer clients are retired. Printer mutation uses session/job-bound intents, authoritative fresh queries, and post-upload revalidation through the shared controllers. Hardware qualification remains incomplete. `AiSessionSecrets` purges legacy plaintext AI keys rather than migrating them. External-slicer URLs may persist, but routing activates only after attestation and opt-in; failed replacement, disable, or clear fail closed to local slicing.

The hosted app is HTTPS (`https://orcaxr.martinez.fyi/slicer/`), while
Moonraker and the optional external slicer commonly expose HTTP on the LAN.
Chrome 142+ can relax mixed-content blocking after the user grants Local
Network Access. `web/src/net/LocalNetworkAccess.ts` is the shared seam: API,
upload, probe, external-slicer polling, and fetched webcam snapshots must use
`fetchLocalNetwork`. IP literals, localhost, IPv6, and `.local` stay under the
browser's complete address-space table; HTTP hostnames outside those syntactic
categories receive an explicit `targetAddressSpace: local`. That declaration
is needed for custom LAN DNS, while avoiding a wrong declaration for literal
addresses that Chrome classifies itself. Older browsers ignore the option and
retain normal mixed-content blocking.

The GitHub Pages cross-origin-isolation shim must not own cross-origin fetches:
`web/public/coi-serviceworker.js` returns without `respondWith` for all of
them so the page origin can obtain/use Local Network Access permission for HTTP
or HTTPS targets. Do not restore a hand-written subnet allowlist; Chrome's
classification includes details that application code should not duplicate.
For same-origin requests it precaches the deploy app shell and bundled XR icons,
uses NetworkFirst at runtime, keeps the large slicer artifacts in a separate
four-entry cache, supplies the offline navigation fallback, and restores COOP/
COEP headers. Update its cache version and offline contract whenever deploy
assets or worker/schema compatibility changes.

A camera Moonraker reports is almost never served by Moonraker.
`PrinterCamera.resolveCameraSources` answers two questions, and both were once
answered wrongly. **Where**: a snapshot URL is usually reported *relative*
(`/webcam/snapshot.jpg`), and on a stock machine nginx serves that on port 80 —
the origin the printer's own web UI loads from — while Moonraker answers the API
on 7125. Verified on the Snapmaker at 192.168.1.228: port 80 returns
`200 image/jpeg`, port 7125 returns 404. So a relative path resolves to the
printer's **web origin**, keeping the API path as a second candidate for the
arrangement where Moonraker does serve it; do not restore the old "keep the
path, drop the origin" reading, which asked 7125 for a file only 80 has and left
the panel on "Waiting for the first frame…" forever. A different *host* is still
refused, naming both origins: a camera list is printer-host content, and
following it off-host would make the page a request forwarder.

**How**: `cameraMechanisms` orders the routes and callers walk them, keeping the
first that works. `image` points an `<img>` at the camera — no credential, and
**no CORS**, which is the only thing that works against a service that sends no
`access-control-*` headers (the same Snapmaker's nginx sends none). `direct`
fetches those bytes, worth trying only where an image cannot go — an HTTPS page
cannot load an HTTP image, while LNA does let the fetch through — and it needs
the camera to allow cross-origin reads. `transport` fetches the path through
Moonraker with the key, for a camera Moonraker really does serve; an `<img>`
cannot send `x-api-key`, and the key must never go in the URL. So on the hosted
HTTPS app a plain-HTTP camera is only visible if the camera allows cross-origin
reads, and the panel says exactly that instead of waiting.

Two consequences reach outside the code. A camera route is **proven by a frame**
and then kept: cameras drop frames, and retiring a working route over one walks
the panel onto a broken route and then reports *its* failure as the camera's.
And the hosted HTTPS app needs the camera itself to allow the read — `nginx`
serving `/webcam/` sends no `access-control-*` by default — so `fix-webcam-cors.py`
in the repo root adds that header over SSH, named to specific origins rather
than `*` (a camera in somebody's house should not be readable by every site they
visit), with a backup, an `nginx -t` gate, and a rollback. That fetch must stay
header-free: mjpg-streamer answers `OPTIONS` with `501`, so anything that turns
it into a preflighted request breaks it.

`PrinterCameraPanel` draws frames into **two buffers**, loading into the back
one and swapping only once it has decoded, and keeps **one load outstanding at a
time** (10 s cap). Both matter only against a real camera: an `<img>` blanks when
its `src` changes and cancels the load in flight when it changes again, so a
single element pointed at a printer that needs longer than the poll interval
shows a grey box forever — which is exactly what it did, while every assertion
about frames arriving passed. Test fixtures serve a 1×1 PNG that decodes
instantly, so neither reproduces in the suite; check a screenshot.

Two more panel invariants come out of this. `PrinterCameraPanel` must claim its timer
*before* asking for the first frame: the image route completes synchronously and
notifies, which re-enters `applyPolling`, and with the assignment last every
re-entry started another timer — a few hundred intervals and a blown stack
within a second. And actions that reveal something on a workspace page must show
the page first: `view_webcam` opens the Device workspace before the camera
section, and polling stops when the tab, the workspace page, or the section is
hidden, not just the first of those.

LNA does **not** bypass CORS. Moonraker's `cors_domains` must include the
page's exact origin (the hosted app uses `https://orcaxr.martinez.fyi`);
API-key/custom-header requests preflight. The typed boundary requires one
explicit endpoint and never probes alternative schemes or ports. Direct
HTTP exposes status, credentials, webcam frames, and uploaded G-code, so use it
only on trusted LANs. Tailscale Serve or another trusted HTTPS reverse proxy
remains the cross-browser and remote-network fallback.


## External slicer connection ownership

- `ExternalSlicerConnectionController` owns one immutable session route, a
  preference generation and abortable, bounded probes. Serving-origin discovery
  never writes preferences until attestation succeeds. Manual connect requires
  both `/ping` and engine proof, and disables the previous route before probing.
  Disable, forget, candidate/token edits, preference import/reset, storage events
  and disposal supersede pending work; a late response cannot restore a route.
- Preferences v3 stores endpoint, enabled state, origin and the successful proof
  in one `orcaxr.slicer.connection` JSON record. Legacy keys are read only as
  migration inputs when that record is absent. A disabled or forgotten choice
  stays local across startup; imported connection settings require reconnection.
  Remembered proof is informational: canonical slicing still attests the engine.
- Canonical active/all-plate slicing captures endpoint, connection generation and
  engine digest together. Never attest one endpoint and re-read preferences to
  select another, or hardcode the browser route after accepting external proof.
  Native proofs require a complete executable digest and exact, nonduplicate
  patch list. Changed consent or credentials invalidate a captured submission.
- Storage failure leaves the current session operational and reports session-only
  persistence. Failed writes or resets must never re-adopt stale enabled bytes.
  The lazy DOM settings surface renders controller snapshots and owns its
  listeners; BFCache suspends probes without destroying reusable controls.
  Slicer credentials retain the separate optional device-local remembrance policy.
  Reading the storage property itself can throw; legacy AI credential cleanup
  must guard that getter too, otherwise it prevents the whole shell from booting.


## Application initialization

- The initialization registry owns feature phases, deadlines, retry attempts and
  partial resources. Workspace, shell, required profiles and settings schema are
  core; unrequested camera/AI/printer/XR integrations stay idle. A missing core
  dependency disables dependent registry actions in both surfaces; printer
  recovery and slice cancellation remain available. Overall boot state derives
  from these capabilities, never an unconditional Ready marker.
- Profile/schema retries fetch and validate fresh data. A failed module import
  requires reload; recovery uses the shared action intent and the persistence
  controller's Save/Discard/Cancel decision. Never bypass that decision for a
  startup retry, application update, or app-owned navigation.
- Lazy features own panels before mounting and cancel their asynchronous work
  before teardown. A late import/body cannot remount a closed feature. Settings
  adapters are mounted together in a separate chunk, with independent DOM/XR
  draft guards. The architecture gate requires registry invocation in that
  extracted owner and still rejects presentation-layer direct writes.
  Required profile fetches reject empty/invalid results before
  replacing a valid catalog. Startup failure details have bounded DOM/XR space;
  they must not hide printer recovery controls.
- `SurfaceLifecycle` owns shell event listeners, callback bindings, panels,
  observers and subscriptions, with child initialization linked to cancellation.
  Register ownership before mount. Permanent departure disposes the application;
  persisted `pagehide` retains it for back-forward cache restoration. Never add
  per-panel pagehide handlers that destroy a cached document's controls.
  Remounting the command palette replaces its global shortcut listener. DOM
  shell, AI dialog, modal/file inputs, resize/mutation observers and XR viewport
  listeners all release with the same owner. Console response subscriptions
  follow the selected transport and unsubscribe when replaced or disposed.
- Camera polling owns one cancellable frame at a time. Hiding the section,
  switching cameras or disposing the panel aborts pending acquisition, including
  work waiting for a printer connection; recheck identity/visibility after each
  await and before publishing a frame. Stopping only the interval is insufficient.


## Project persistence and recovery

- Snapshot serialization does not change dirty state. Only successful manual
  download handoff may acknowledge an exact project/revision/hash/asset guard;
  the browser cannot promise that a disk write finished. Initial catalog defaults
  establish a clean baseline only before any authored revision exists.
- The browser injects the owned worker serializer. One persistence queue gives
  explicit saves priority and coalesces recovery requests. Recovery never falls
  back onto the UI thread; a failed worker pauses it visibly. Explicit manual
  export can retry/fall back. Cancellation/disposal settles callers and rejects
  late results. Import and export workers share one emitted archive-codec bundle,
  but have independent instances and lifetimes.
- Recovery captures after five idle seconds, at most thirty seconds into
  continuous editing. IndexedDB keeps up to three snapshots per project/editing
  session; sequence allocation, insertion and pruning are one transaction.
  Failed writes preserve previous records. The default total budget is 512 MiB,
  adjustable up to the 1 GiB archive limit and available browser quota. Never
  evict another tab's lineage or automatically delete an unfamiliar schema.
- Startup lists stored sessions in the DOM/XR Project view. Recover, download and
  discard share registry actions. Recovery verifies archive SHA-256 and raw
  project/asset identity before the normal import preview/normalization; it stays
  dirty until manual export. A corrupt newest record leaves older ones selectable.
- New/Open, startup reload, app links and PWA updates use Save/Discard/Cancel.
  Approval is bound to the exact revision, including edits during update
  activation. Native browser close/reload uses `beforeunload` only while dirty;
  visibility changes make best-effort captures. No async unload guarantee exists.
  PWA updates wait for an explicit guarded `SKIP_WAITING` request.
- Storage/serialization failures are visible and must not trap ordinary editing
  or manual export. See [the recovery guide](../../docs/project-recovery.md).


## External slicer server (`server/`)

Dockerized HTTP endpoint (`POST /slice`, STL or signature-validated project 3MF plus flattened-overrides JSON) the
web app can offload plain slices to. `POST /slice?async=1` returns
`202 {job}` for progress polling (`GET /jobs/:id` →
`{status, percent, message}`, then `GET /jobs/:id/gcode`); without the flag
the original synchronous contract is preserved, and a new client against an
old server degrades gracefully (old server ignores the flag and answers
`200` + G-code, which the client detects by status code). CLI progress
comes from orca-slicer's `--pipe <fifo>` option — newline-delimited JSON
with `total_percent`/`message`; the fifo read end must exist before the CLI
opens the write end (`O_WRONLY|O_NONBLOCK` fails with ENXIO otherwise and
the CLI slices on silently after a few retries). Two engines, chosen by
`SLICER_ENGINE`:

- **`cli` (default)** — Snapmaker OrcaSlicer **built from source** in the
  Dockerfile (stage 1; `ARG ORCA_VERSION=2.3.4` — bump deliberately, never
  track "latest") with `server/patches/` applied: 0001 guards the headless
  null-preset segfault in `expand_plate_extruders` (the released 2.3.3/2.3.4
  AppImages crash on every multi-filament project-3MF `--slice`), 0002 fixes
  the `normalize_fdm` wipe_tower_filament null-deref (see below). Stage-1
  apt needs `libwebkit2gtk-4.1-dev` or wxWidgets configures without webview
  and the slicer link fails. Native 64-bit, real TBB threads, runs under
  `xvfb-run`. Snapmaker Orca ≥ 2.3.3 is FullSpectrum-native, so FS keys
  pass through (the old FS_KEY_RE dropping is gone).
- **`wasm`** — the browser's libslic3r build (now the SAME Snapmaker-fork
  source) in a Node child process; parity/debug fallback.
- **Project 3MF slicing**: `/slice` sniffs the upload's ZIP magic — a 3MF
  slices as a PROJECT (embedded config incl. FullSpectrum mixed-filament
  definitions; no generated preset files), an STL gets the flattened
  profile split into typed preset files as before. This is how web FS
  slices offload: `SlicerClient.sliceProject` posts the original 3MF.

The server defaults to loopback. Any non-loopback `HOST` fails startup unless
`ORCAXR_SERVER_TOKEN` contains at least 32 bytes and
`ORCAXR_ALLOWED_ORIGINS` contains exact HTTP(S) origins; wildcard CORS is
forbidden. Upload/JSON/ZIP/output/rate/queue/job/time limits are configurable,
owned Linux process groups are cancelled before releasing their worker slots,
completed jobs expire, and logs
record only bounded error class/code—not engine messages that may contain paths
or secrets. Keep the abuse tests green when adding an endpoint or runner.

Native output is private until the process exits successfully and its regular,
nonempty, bounded file passes validation. Nonzero/signaled exit, timeout, or
cancellation cannot publish a partial file. Track the detached process group
even after the leader exits; SIGTERM escalates to SIGKILL, and settlement waits
for all owned live members. Linux `/proc` distinguishes dead zombies from running
members; the supported container must retain `init: true` to reap adopted
descendants. Other host platforms have no qualified process-tree guarantee.
A kernel task that cannot yet exit continues to occupy its slot. Native progress
FIFO reads are nonblocking so an engine that never opens its writer cannot strand
libuv threads during cleanup.

Completed job downloads are repeatable until terminal-completion TTL (ten minutes
by default) or explicit DELETE. Each transfer holds a file lease; expiry/release
cannot unlink a file until all readers finish. Capacity rejects new work with a
retryable 503 rather than evicting unexpired results. GET status reports terminal
timestamps; synchronous responses expose `X-OrcaXR-Job-Id`. Both download routes
expose SHA-256 and uncompressed byte-count headers. The browser validates those
before a best-effort release; missing evidence on an older server leaves TTL
cleanup in charge. Cancellation uses one independent deadline for DELETE, JSON,
polling, and delays, and distinguishes confirmed cancellation from an already
terminal job and an unconfirmed outcome. Its 30-second inner deadline precedes
the canonical route's 31-second outer cleanup safeguard.

Multer is pinned to 2.4.0 or newer: 2.2/2.3 can orphan disk writes when an
upload aborts before the filename callback. Keep the delayed-storage regression
and real HTTP disconnect tests. Multipart overrides accept one JSON string,
never bracket-expanded fields. Full dependency audits include development
packages and fail at moderate severity. Generated tokens are logged by protected
file location only. Printer maintenance scripts use `maintenance_ssh.py`, require
explicit host/account, verify known host keys, and default to keys/agent;
`--password` enables OpenSSH's hidden terminal prompt without giving Python a
credential. Removing source literals does not rotate exposed credentials or
rewrite repository history; those operational steps need separate evidence.

CLI invocation gotchas (all found empirically against Snapmaker Orca 2.3.4,
logic verified against `src/OrcaSlicer.cpp` in the submodule):

- `--load-settings` **rejects** `from: project` and a single merged file. It
  wants typed files: machine + process via `--load-settings a.json;b.json`,
  filament via `--load-filaments`. `server.js` splits the client's flat
  config using key sets extracted from `Preset.cpp` into
  `server/preset_key_types.json` (machine = printer + machine-limits +
  extruder options; filament list; everything else → process). Mis-binned
  keys are harmless — the CLI loads with substitution rule `Enable`.
- The compatibility gate compares process/filament `compatible_printers`
  against the machine's **system name**, which for a `from: user` machine is
  its (empty) `inherits` — nothing matches and it exits `-17`. Fix: machine
  is declared `from: system` (its own name becomes the system name) and the
  generated process/filament files list it in `compatible_printers`.
- `wipe_tower_filament` (ANY value) **segfaulted** the 2.3.4 CLI config
  loader — root-caused 2026-07-05: `DynamicPrintConfig::normalize_fdm`
  dereferences `opt("nozzle_diameter")->size()` unguarded whenever
  wipe_tower_filament is present, and the CLI normalizes each settings
  file alone (process key, machine vector absent → null deref). Fixed at
  the source by `server/patches/0002-normalize-fdm-partial-config-null-
  nozzle.patch` (+ same fix in the wasm fork tree); `CLI_CRASH_KEYS` is
  now empty. If a future profile key crashes the CLI, bisect keys with a
  probe loop against the container.
- `--arrange 0 --orient 0` is load-bearing: the client bakes transforms into
  printer coordinates before upload; arranging would move the parts.


## Deployment verification boundaries

- Serve existing static assets and explicit HTML navigations before API rate/auth
  middleware. Reserved API paths never become SPA documents, even with HTML Accept;
  wildcard fetch Accept is not a document navigation. Preserve hashed immutable
  caching, entry-point revalidation, COOP/COEP and permissions headers. The isolation
  shim must check both secure context and service-worker availability before registration.
- The optional Tailscale sidecar shares `service:orcaxr` networking, uses userspace
  mode, and mounts its Serve configuration directory. Base Compose intentionally
  keeps LAN publication. Trust protocol/identity only when the actual socket peer
  is loopback; never use forwarded `req.ip` for this decision. Authentication,
  CORS and rate keys share the predicate; malformed trusted protocols are rejected.
  Embedded startup applies the same loopback/userspace rules.
- Deployment browser tests use the actual built UI through Express and local HTTPS,
  an insecure HTTP hostname, a complete precache inventory and the printer simulator.
  The container variant mounts only its deterministic test entrypoint and ephemeral
  certificates; it does not replace packaged application code or contact real printers.
  These checks supplement, rather than replace, native engine fixtures and hardware tests.
- Native Docker builds default to two lower-priority top-level jobs; reduce
  `ORCA_BUILD_JOBS` to one on a busy host. Upstream dependency subbuilds can
  choose their own worker counts. The exact engine source pin is unchanged.

- `npm --prefix server run test:native:container` qualifies the actual pinned CLI
  in a disposable non-root, read-only, init-managed image over production HTTP.
  It slices the generated cube with bundled Centauri Carbon profiles, checks
  attestation, repeatable identical output and explicit release. The manual native
  CI job and optional container stage of `scripts/quality.sh` include it after
  HTTP/HTTPS browser qualification. Set `ORCAXR_TEST_IMAGE` to choose another
  already-built image. It uses the web package's installed TypeScript loader to
  consume the same profile resolver as the browser; no separate test config is
  guessed. This is software qualification and never sends printer commands.
