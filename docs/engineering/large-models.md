# Large-model performance contracts

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

## Large-model performance (load-bearing)

- Command rollback uses repository-owned opaque snapshot handles. Versions share
  immutable asset records and copy only the map on insert/remove; restoring a
  version also restores its cached bundle fingerprint. Serialized bundles remain
  a separate validated boundary, and public mutable reads still copy. Imported
  history validates once, retains version handles for undo/redo, and accounts for
  both replaced and imported payloads in the history budget. The only production
  `peek()` consumers are the Three projection and canonical bounds reader; both
  decode into new position/index arrays and must never mutate shared bytes.
  `npm --prefix web run bench:assets` enforces zero payload copies for twenty
  transform/undo pairs over an 8 MiB generated asset; timing is informational.

Measured on `~/Downloads/narwhal.3mf` — 1,897,256 facets, 629k of them painted,
stored as 161 MB of mesh XML inside a 28 MB archive. Every number below is from
that project on a desktop; a Galaxy XR is several times slower, so these are
floors, not ceilings.

- **Canonical state must never hold one entry per triangle.** The single worst
  offender was `FacetRefinementEncoding` version 1, which stored one root per
  source facet: 137 of the project's 137.3 M canonical chars, two thirds of them
  the literal default `{kind:'leaf',state:{kind:'unpainted'}}`. Because
  `ProjectStore.replaceState` clones, validates, fingerprints, and deep-freezes
  the whole state, **nudging an object one millimetre cost 24.3 s**. Version 2
  stores only subdivided facets and derives the rest from the sparse
  `TriangleAssignments` beside it; the same commit is now **1.3 s**. When adding
  canonical state, ask what it costs *per commit*, not per save.
- **A dense-per-facet shape is still the right working form mid-gesture.**
  `FacetRefinedRootSet` (dense) is what selection and painting operate on;
  `collapseFacetRefinementRoots` splits it into the sparse pair at the commit
  boundary, and `expandFacetRefinementRoots` rebuilds it. Do not persist the
  dense form, and do not make the selector work sparsely.
- **A split that collapses to a uniform leaf must move its value into the sparse
  assignments.** Remapping filaments, or resolving imported paint slots, can make
  a subdivided facet uniform; dropping the collapsed split without carrying its
  value across silently unpaints the facet. `remapFacetChannelValues` is the only
  correct way to remap one channel — it handles both halves together.
- **`fnv1a64` runs over hundreds of megabytes on import and save.** It is written
  with 16-bit limbs and `Math.imul` so a round costs no floating-point division;
  the naive `Math.floor(x / 2**32)` form ran at roughly 27 MB/s and dominated
  every profile. `projectFingerprint` likewise streams canonical JSON straight
  into the digest instead of materializing it — the string alone was 1.4 GB — and
  emits safe integers digit by digit rather than allocating one string per
  triangle index. All three are bit-identical to the old form, pinned by test.
- **Per-element path strings are the hidden cost in validators.** Building
  `` `${channel}[${i}].triangles[${j}]` `` for every triangle allocated hundreds of
  thousands of strings per commit for the overwhelmingly common case where
  nothing is wrong. Build the path only when an issue is actually reported.
- **`ProjectStore.replaceState` validates once, on the candidate.** Validating the
  caller's object as well doubled commit cost for no extra guarantee: a faithful
  JSON clone cannot turn a valid state invalid.
- **The mesh codec is packed; the tuple views are lazy.** `decodeIndexedMeshAsset`
  returns `positions`/`indices` typed arrays and materializes
  `vertices`/`triangles` only on demand. The eager tuple form cost 911 ms and
  ~400 MB per call on a path shared by render, paint, bounds, and export.
- **`ThreeProjectSurface.resolveGeometry` is cache-first.** It used to clone the
  asset bytes and re-hash 33 MB on *every* projection — that is every canonical
  change — before consulting its own geometry cache. It now `peek`s the
  repository (no copy) and compares payload identity; the immutable repository
  makes reference equality proof enough that the content is unchanged.
- **Slice/save archive authoring runs on a worker.** `buildBbsCore` plus zip is
  ~3 s and over a gigabyte of garbage for this project, so
  `CanonicalWorkspaceSlicer` injects `WorkerProjectSerializer` rather than the
  codec directly. The canonical BBS codec is still the only writer, on both the
  worker and the no-worker fallback; `inspectWorkerSerializer` pins that.
- **Remaining headroom, deliberately not taken.** A commit still re-validates and
  re-fingerprints the whole state (~1.1 s of the 1.3 s). Scoping that to changed
  subtrees needs structural sharing — commands would have to declare what they
  touched — because `cloneProjectState` destroys object identity and any
  identity-keyed digest cache would go stale silently the first time a command
  mutated a shared subtree in place. Given that published G-code is bound to the
  exact project hash, a cache that can go stale is not an acceptable trade.
- **A live edit re-derived what canonical state already guaranteed.** Changing a
  printer profile or a filament ran a canonical capture, and
  `StoreProjectSliceSource.capture()` validated, re-cloned, re-froze, and
  re-hashed the state and every asset byte it had just read from the store —
  2.8 s on the narwhal, on a path that runs on every profile, filament, and
  placement change. The store already validated, hashed, and froze that state at
  commit, and the repository is immutable by contract, so capture now trusts it;
  the check that matters is unchanged, because `SliceJobCoordinator` never
  trusted the source port anyway and still runs `validatedSnapshot` on every
  capture it slices. Related: `deepFreeze` records the states it froze all the
  way down, and validation and `projectFingerprint` are memoized against those,
  so `replaceState` freezes *before* it validates and hashes; a repository
  caches its own bundle fingerprint; and `ReplaceProjectCommand` stops cloning
  the frozen state it is merely remembering, which is what made undo cost as
  much as the edit. One profile change went from ~6 s to well under a second of
  derived work, and undo/redo from seconds to ~120 ms.
- **`validateProjectState` stringified the whole project to throw away the
  string.** Its serializability check called `canonicalStringify` purely for the
  exception — half the cost of validating. `assertCanonicalSerializable` walks
  the same structure and throws the same errors without building anything.
- **A slice attempt limit must measure silence, not duration.** `attemptTimeoutMs`
  capped one attempt at 120 s, so a large model was cancelled mid-slice, retried,
  and then failed — and the failure surfaced as "Canonical slice route cleanup
  confirmed", which named the teardown rather than the cause. It is now
  `attemptIdleTimeoutMs`: the deadline restarts on every progress report, and
  both routes report continuously (the external one polls its job about once a
  second, the browser engine reports each stage). The route also names why it
  stopped instead of reporting that cleanup went fine. `serializationTimeoutMs`
  had the same shape of bug — a 30 s cap on work that takes ~19 s for a
  two-million-facet plate — and archive authoring reports no progress, so it is
  simply bounded generously now that it runs on a worker.
- **A regenerated archive was three times its source, for two independent
  reasons — both fixed.** The narwhal reopened as 85.7 MB against a 27.9 MB
  source; it is now 46.6 MB, and its core model XML is *smaller* and compresses
  *better* than the file it came from (158.2 MB → 27.7 MB at 5.7x, against the
  original's 161.6 MB → 29.6 MB at 5.5x).
  - **Mesh coordinates are float32, so `String(value)` is the wrong formatter.**
    It emits the shortest *double* that round-trips, which for a float32 is its
    full binary expansion: a coordinate authored as `-25.7756138` came back out
    as `-25.77561378479004`. Those digits name the same float32, so they carry
    no information — they just cost ~60% more bytes each and, being effectively
    noise, destroy compression. `formatMeshCoordinate` emits the shortest
    decimal that still round-trips through `Math.fround`. Use it for mesh
    positions only: `formatNumber` stays for canonical doubles such as layer
    `top_z` and height-range bounds, where shortening would lose precision.
  - **A referenced Production Extension part must not be preserved once the
    generated core absorbs it.** BBS keeps its meshes in `3D/Objects/*.model`,
    so this is every Orca/Bambu archive, not an exotic case: the writer resolved
    those parts into the flattened `3D/3dmodel.model` *and* kept the originals
    as opaque blobs, storing the geometry twice and leaving the copy frozen at
    import while the core moved on. `ImportedCoreProject.absorbedIntoCorePaths`
    names them, and they are excluded from preservation only when the core was
    actually regenerated — if `buildBbsCore` could not run, the originals are
    still the only carrier and must stay. The existing machinery already drops
    the now-dangling OPC relationship, which is required: a relationship to a
    missing part makes the pinned engine reject the whole archive.
  - What remains is principled duplication, not waste: the XML core is for
    foreign readers and the engine, and `Metadata/orcaxr/assets/*.bin` (17.2 MB
    compressed here) is the byte-exact canonical mesh the envelope reopens from.

- **The preview's parse budget silently truncated a real print, and it looked
  like a failed slice.** A 78 mm three-colour narwhal slices to 95 MB of G-code:
  99.7M UTF-16 code units, 3.17M records, 490 layers. The old caps
  (`inputCharacters` 64 MiB, `records` 1.5M) stopped the parser at Z 21.4 mm of
  78.8 mm — a quarter of the print — and the preview drew that stump as though
  it were the whole model. Both engines were fine: WASM and the external CLI
  each produced 1472 layer markers over Z 0.200–78.440 from both the source
  archive and OrcaXR's regenerated one, with identical per-tool move counts.
  Only the preview was short. Caps are now sized from that measurement
  (`inputCharacters` 256 MiB, `lines` 16M, `records` 4M, `pathPoints` 8M) and
  `GCODE_RENDER_HARD_CAPS.segments` was raised to 4M with them — the renderer
  *throws* above its cap rather than drawing part of a path, so a render cap
  below the parser's turns "shows the whole print" into "shows no preview at
  all". A surface that cannot afford that, the headset above all, passes its own
  smaller `maxRenderedSegments`. Full parse costs ~4.4 s and ~400 MB of typed
  columns at ~132 B per record, of which about a quarter is `RecordColumnsBuilder`
  doubling slack that `finish()` keeps because it hands out `subarray` views.
  The current browser viewer indexes before allocating rich columns. It parses
  the whole input only when the complete index fits 240,000 records and the
  path-point budget; otherwise it loads bounded windows immediately. An unusually
  large layer gets additional record checkpoints, and arc-heavy spans get
  checkpoints before a whole arc would overflow the path budget. A single arc
  larger than that budget remains explicitly incomplete; no partial arc is drawn.
  Index checkpoint metadata has a 64 MiB accounting budget, and input/line caps
  remain explicit. The index counts records without retaining columns or applying
  the window's record cap to the whole input.

  Checkpoints preserve machine state, absolute source offsets/lines and original
  semantic record IDs. Inspection reports original IDs; render projection indices
  stay local to the loaded columns and use `recordOffset` to recover source identity.
  Previous/Next moves controls in DOM and XR reach all chunks of a large layer;
  colour/filter changes preserve the selected chunk. Notices quantify the layers
  and records shown. A complete index means only that the supplied input was fully
  indexed, never proof that a slice finished. Incomplete input names its limiting
  reason and says that later input was not inspected.

  `WorkerGcodePreviewSession` owns one browser worker per source. Indexing,
  window parsing and default projection/inspection run there; the main thread
  receives transferred bounded snapshots and reuses those projections across
  surfaces. The worker retains one source (at most 256 Mi UTF-16 code units),
  its index and one window; the main thread retains its current window. A source
  replacement/disposal terminates the old worker immediately. Window requests
  settle obsolete callers immediately and coalesce to one pending request while
  the active bounded parse finishes; obsolete replies are never published.
  Requests have a 120-second deadline; failure disables that preview visibly
  instead of falling back to a blocking main-thread parse. No worker holds old
  response buffers after transferring them. Engine completion releases its slicing
  slot before asynchronous preview completes, so a new slice can supersede a
  still-indexing artifact. This bounds live owners; garbage
  collection can temporarily retain unreachable previous windows.

  The generated 300,002-record single-layer regression previously retained all
  records and allocated a 524,288-element Float32 column. It now retains at most
  240,000 with no column allocation above that cap, and every remaining record is
  reachable. Index-first scanning is additional work for small files: the same
  Node fixture measured 426.6 ms before and 603.1 ms in the isolated bounded
  implementation. The improvement is bounded allocation and responsiveness,
  not a claim of faster total parsing. Production Chromium evidence records
  heartbeat progress during worker indexing rather than inventing a universal
  latency threshold. `bench:preview` alternates five whole-parse/reference and
  indexed-window opens after warmup and collection. The measured paired ratios
  were 1.45–1.65 (median 1.59); CI caps the median at 2.5, roughly 50% headroom
  over the observed worst pair. This compares work on the same runtime/host,
  with no absolute device latency assertion. Earlier narwhal measurements remain historical;
  hardware/XR qualification of this implementation is still pending.

- Import feature detection walks typed volume emboss recipes, so unrelated
  extension flags do not generate geometry warnings and no project-wide JSON
  string is allocated. Save/slice snapshot preparation shares the frozen canonical
  state and cached hash, validates one defensive asset bundle once, and uses the
  repository's cached fingerprint for freshness. Public/untrusted byte boundaries
  still copy and validate; derived fingerprints never replace output SHA-256 or
  engine provenance.

- **A slice is not cancelled for going quiet.** Slicing the narwhal at 0.12 mm
  failed with an idle timeout, because the engine legitimately says nothing for
  long stretches: measured on that model, the longest silence is **77.8 s** — right
  after `5% Slicing mesh` — with a second gap of 51.8 s, in a 248 s slice. A
  browser worker is slower than that native measurement, so 120 s of silence is
  reachable on real hardware, and no fixed number is right because the silence
  belongs to one stage of one model. Nothing can tell a slow engine from a stuck
  one from outside, so `attemptIdleTimeoutMs` now defaults to `null` — silence is
  *reported* (`stallNoticeMs`, a repeating "still slicing, no update for N s"
  status) and never acted on. An unattended caller can still set a ceiling. The
  consequence is load-bearing: **stopping a slice is now only the operator's
  call, so `slice_cancel` had to exist** — `OrcaWorkspace.cancelSlice()` was
  already written but nothing invoked it, so before this there was no way to end
  a running slice at all. It sits on the primary bar beside Slice, enabled only
  while slicing. Removing an automatic stop without adding a manual one would
  have left a hung slice needing a page reload.

- **An upload deadline is a guess about someone else's network, and there is no
  way to measure the thing that would justify it.** Three deadlines were tried
  and all three were wrong: the shared 10 s request timeout could not carry
  95 MB; a size-derived deadline at a 256 kB/s floor collided with
  `positiveDuration`'s 5-minute bound and rejected every print over ~67 MB; and
  raising that bound then failed a real 93 MB upload at 402 s because the link
  was moving 237 kB/s — healthy, merely below a floor invented on its behalf.
  The tempting fix is "cancel only when progress stops", but **upload progress
  is unobservable here**: `fetch` exposes none, `XMLHttpRequest` does but cannot
  carry the `targetAddressSpace` opt-in that `fetchLocalNetwork` needs for
  Chrome's Local Network Access, and a streaming request body needs HTTP/2,
  which a LAN printer on HTTP/1.1 will not offer. So `timeoutMs: null` is now a
  supported value meaning *no deadline at all* (no timer is armed, verified by
  asserting the scheduler holds only the heartbeat), the upload reports elapsed
  time — never a percentage, which would be invented — so it is visibly alive,
  and the operator cancels via the send button, which already doubles as
  "Cancel send". A caller passing `null` **must** offer that cancel. Downloads
  keep their content-length-derived deadline: a response body's size is known
  in advance, so it is measured rather than guessed.

- **A hard reload removes cross-origin isolation; the guard against a reload
  loop must not also block recovery.** In-browser slicing needs
  SharedArrayBuffer, which needs cross-origin isolation, which on GitHub Pages
  comes from `public/coi-serviceworker.js` adding COOP/COEP to each response. A
  **hard** reload (Ctrl+Shift+R) bypasses service workers, so the document
  arrives with no isolation headers — it is the one kind of reload that removes
  isolation rather than restoring it. The shim's recovery reload was gated on
  `sessionStorage['coiReloaded']`, a boolean set on the first reload and *never
  cleared*, so after one successful load that flag permanently suppressed the
  recovery: the tab stayed un-isolated for the rest of the session and every
  slice failed with "needs a cross-origin-isolated context". The guard is now a
  timestamp with a 10 s cooldown and is **cleared on success** — it exists to
  stop a loop, not to stop recovery. `decideCoiReload` is a pure function
  exported through a CommonJS seam so the decision is unit-tested directly
  rather than by trying to reproduce a header-stripping reload in a headless
  browser. The three isolation errors in `SlicerClient` also shared one
  developer-facing sentence ("serve the page with COOP/COEP headers"), which is
  advice for whoever deploys the site, not for the person reading it; they now
  share `isolationFailureMessage`, which says to reload normally and warns that
  a hard reload is what breaks it.

- **A test double that accepts what the real server rejects is worse than no
  double.** Starting a print failed with `http_error` because `/printer/print/
  start` was sent as a **GET**; Moonraker serves it, and every other print
  command, for POST only and answers 405. `MoonrakerTransport.request` defaults
  to GET, and the call sites in `PrintJobSubmission` and `PrintJobControl`
  simply omitted the method — so start, pause, resume, cancel, emergency-stop
  and firmware-restart were *all* broken. Only the upload path worked, because
  it sets `method: 'POST'` explicitly, and `PrinterStorage.startStoredPrint`
  calls the identical endpoint correctly, which is what made the omission
  visible. It survived because **both** doubles — `scripts/moonraker-simulator.
  mjs` and the inline `Simulator` in `moonraker-print-simulator.test.ts` —
  dispatched on `url.pathname` alone and never looked at the method, so every
  test passed while nothing worked. Both now answer 405 exactly as Moonraker
  does, `METHOD_ONLY_ENDPOINTS` in the transport refuses a mutation sent as a
  GET before it reaches the wire (`invalid_request`), and the minimal transport
  interfaces these modules declare now include `method` — omitting it had made
  the correct call untypeable. Two further consequences worth keeping: a failed
  response's body is now read into `MoonrakerTransportError.detail`, because
  Moonraker explains its refusals there and discarding it left `http_error` as
  the entire story; and that detail is routed through the credential redactor
  first, since a server can echo back the API key it was sent — an existing
  security test caught exactly that leak when `detail` was added raw.

- **Printer commands belong to the job and connection the operator saw.**
  `PrinterSessionController` owns the selected transport, subscriptions, epoch,
  query publication, and pending commands. DOM dialogs and DOM/XR holds capture
  an immutable intent before confirmation; a single-use confirmation carries
  that exact intent. Fresh full queries reset the object accumulator; only
  WebSocket patches merge. Ordinary commands require matching Moonraker file
  metadata and history (`job_id`, `print_start_time`/`start_time`, filename,
  file size/modification and an active history row) and read them again after
  confirmation. Missing identity blocks with recovery guidance; a new run of
  the same filename, changed printer, reconnect, partial response, or failed
  refresh cannot authorize the old command. Pending ordinary commands are
  serialized, including their dialogs. After command verification begins, its
  completion or refusal invalidates the old job identity before releasing the
  command lock; only a completed authoritative refresh re-enables ordinary
  controls. This prevents a retry hold from capturing a just-rejected identity.
  Emergency stop and the distinct,
  confirmed firmware-restart action retain an authenticated, bounded HTTP path
  without a successful readiness/history query or WebSocket handshake. These
  checks close client stale-state paths; Moonraker offers no atomic comparison
  and command transaction against other clients. Simulator/browser evidence
  does not establish installed-firmware or supervised hardware qualification.

- **A send confirmation owns one artifact and printer session through completion.**
  `PrintWorkflowController` is shared by DOM and XR and owns cancellation,
  confirmation, upload, verification, explicit preparation, and start. Unknown
  or incomplete readiness blocks even upload-only; start requires Klipper ready,
  a recognized idle state, and an inactive virtual SD card. Session, artifact,
  used-tool mappings, and selected capabilities are revalidated after upload
  and before each preparation/start. Changed prerequisites retain the file and
  require another confirmation. Ambiguous POSTs are never retried; a bounded
  query reconciles current state without claiming the request failed to execute.
  Non-overwrite filenames use 128 random bits from LAN-compatible
  `crypto.getRandomValues`; listing failures block. Explicit overwrite names
  the exact target and its captured size/modification time, rechecks it before
  upload, and cannot replace an active file. Uploads use the published artifact's
  SHA-256 checksum and verify response root/path/size and upload-only flags.
  Both surfaces default to upload-only with overwrite and preparation off.
  Stored-file starts share the workflow lock and require their own session,
  metadata, and idle-state confirmation; they do not upload again.

- **A per-request deadline is a property of the payload, not of the transport.**
  Sending the narwhal failed with `invalid_state` *before a byte left the
  browser*. `fetchWith` validated the caller's `timeoutMs` with
  `positiveDuration` — the helper that bounds the transport's own configuration
  knobs (`requestTimeoutMs`, `socketOpenTimeoutMs`, the heartbeat pair) at five
  minutes. Once `PrintJobSubmission` began deriving an upload deadline from the
  artifact size, that bound silently became a **size** limit: at the 256 kB/s
  floor plus 30 s of setup, anything over ~67.5 MB asks for more than 300 s, so
  every print above that threshold was rejected outright — narwhal is 95 MB at
  0.20 mm and 124 MB at 0.12 mm, so both were. Configuration knobs keep
  `positiveDuration`; a per-request deadline now goes through `requestDeadline`,
  bounded by `MAXIMUM_REQUEST_DEADLINE_MS` (1 hour) purely to catch a runaway
  argument. Two lessons worth more than the fix. First, **a bad argument is not
  a bad connection**: `invalid_state` sent the investigation to the connection
  layer and cost a whole cycle chasing a real but unrelated bug, so argument
  validation now raises `invalid_request`. Second, **a size threshold is only
  found by testing a realistic size**: every existing test sent a few megabytes
  and passed by staying under the bound by accident. The regression test feeds
  the deadlines narwhal actually asks for (95/124/512 MB) through a real
  transport, checking the contract *between* the two modules rather than each
  side's opinion of it.

- **Moonraker's HTTP API does not depend on its websocket.** While chasing the
  `invalid_state` above — which this did *not* cause — `request`, `upload`, and
  `download` turned out to refuse unless `state.status === 'connected'`, so a
  socket that happened to be reconnecting blocked the readiness query that
  precedes every send. Worse, each re-checked `socketEpoch` *after* the transfer, and that
  epoch advances on every reconnect: a websocket blink during a multi-minute
  upload discarded a file that had already landed on the printer, reported as
  `cancelled`. Uploads, downloads, and REST queries go over HTTP and owe the
  JSON-RPC socket nothing, so they now require only a live *session*
  (`connected` or `reconnecting`, not disposed) and, afterwards, only that the
  session `generation` is unchanged — generation moves when the operator
  deliberately disconnects or switches printers, which is the only thing that
  should invalidate a finished transfer. The send workflow captures its session
  before confirmation and aborts when that session changes; it must never
  reconnect and transfer an old confirmation to the replacement session.

- **A transfer cannot be capped by duration.** Sending the narwhal to a printer
  failed with a timeout: `MoonrakerTransport` applied its flat 10 s
  `requestTimeoutMs` to every request including the upload, and 95 MB of G-code
  does not cross any real network in ten seconds. That timeout suits a status
  query — which either answers promptly or is broken — but a transfer's honest
  duration is a function of its bytes. An **upload** sends its body before any
  reply, so `PrintJobSubmission` uses no deadline, reports elapsed time, and
  exposes operator cancellation. The former 256 kB/s assumed floor rejected a
  healthy 237 kB/s link and was removed. A **download** cannot be sized in advance, so `fetchWith`
  keeps the short deadline for getting a reply and then re-arms from the
  response's `content-length` once the headers say how much is coming. An
  unknown length deliberately keeps the short deadline rather than guessing
  generously, since that would turn a hung connection into a long wait. The
  operator is the only one who can
  tell "my printer is on slow wifi" from "it is stuck". Note this is the same bug
  shape as the slice attempt cap: whenever a limit guards work whose duration
  scales with the input, it has to scale too, or measure silence instead.

- **What the external slicer container can and cannot fix.** Offloading helps the
  *slice* itself and nothing else: the costs above are all in the browser,
  between the user's input and the scene updating, and cannot survive a network
  round-trip. A server-side canonical importer is also explicitly the wrong
  answer — it would be a second canonical import path. Render-side LOD is the one
  genuinely container-shaped idea left, and it is not free: display meshes are
  what `faceIndex` is resolved against for paint, measure, and brim ears, so a
  decimated display mesh needs a separate full-resolution picking mesh first.

- **All-in-one container architecture, web UI serving, and same-origin trust.** The Dockerfile builds a unified all-in-one image combining the web front-end (`/app/public`), native CLI engine (`/app/orca/bin/snapmaker-orca`), versioned WASM engine (`/app/wasm-artifacts/current`), and Tailscale binaries. Build-time coherence asserts that `web/src/slicer/pinnedEngineProvenance.ts` commit and patch digests match `/app/orca/engine-provenance.json`. Static assets and SPA routes are served with exact `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`, and `Permissions-Policy` matching `web/vite.config.ts`. In `ORCAXR_TRUST=same-origin` mode, same-origin browser requests (`isSameOriginRequest`) are trusted on loopback and Tailscale Serve HTTPS boundaries without manual token entry, while non-browser API clients authenticate with an explicitly provisioned token (loopback-only same-origin setups can generate `~/.orcaxr/server-token`) (0600 permissions). `SlicerClient` probes the serving origin on startup via `autoDiscoverExternalSlicer`, connects only upon valid engine attestation, and preserves explicit user endpoints.
