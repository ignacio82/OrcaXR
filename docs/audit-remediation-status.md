# Audit remediation evidence

This tracks implementation of [`plan.md`](../plan.md). It does not replace or
reduce that plan, and it does not claim completion of the separate parity backlog.

## Current implementation

| Plan area | State | Evidence / work remaining |
| --- | --- | --- |
| A: dependencies | Implemented | Multer 2.4.0, qs 6.16.0, compatible patched web transitive dependencies; XRBlocks 0.17.0 and UIKit 1.0.74 unchanged. CI and the local quality script audit development dependencies at moderate severity. |
| A: credential source and logging | Implemented | Seven maintenance scripts share verified OpenSSH authentication. No embedded password or automatic host-key acceptance remains. Generated server tokens log only their protected file location. Remembered device-local printer credentials remain optional; UI/docs explain the storage boundary. |
| A: operational revocation | Pending | Rotation or invalidation of previously exposed credentials and logged tokens requires operator evidence. Source cleanup does not revoke them. History rewriting is a separate coordinated action. |
| B: printer session and command intent | Implemented; hardware evidence pending | One controller owns selection, connection epochs, subscriptions, queries, and commands. Immutable click/press intents bind exact job history and metadata; fresh queries reject replacement, reconnect, partial/failing responses, and duplicate commands. DOM/XR holds carry single-use confirmations. Emergency stop and distinct firmware restart remain reachable through authenticated HTTP without status/history success. |
| C: submission lifecycle | Implemented; hardware evidence pending | Shared DOM/XR workflow owns session/artifact/mapping/option guards, cancellation, preparation, random upload names, exact overwrite and response checks. Stored-file starts also bind confirmation to fresh metadata and readiness. Full web quality passes; supervised firmware evidence remains pending. |
| D: process and artifact lifecycle | Implemented | Native exit/group termination, repeatable downloads, leases, TTL/release, capacity refusal, artifact validation and bounded browser cancellation pass server, container and full web gates. Fresh native image assembly, non-root process reaping and a real native HTTP slice pass; final changes still require image refresh. |
| E: deployment and artifacts | Implemented; qualification in progress | Static/API separation, actual-peer proxy trust, userspace Tailscale configuration, strict adjacent-manifest checks and atomic version publication pass focused tests. Real Express HTTP/HTTPS browser tests pass. Full web quality passes. Refreshed native-container HTTP/HTTPS, process reaping and real CLI slicing pass; final changes still require image refresh. |
| F: discovery and startup | Implemented; automated qualification passes | Discovery, atomic preferences, session-only fallback and actual external UI slicing pass full web and deployment tests. Core/optional startup health, owned initialization, shared DOM/XR recovery and guarded dirty reload pass the full web gate, including five production-browser fault scenarios. |
| G: controllers and snapshots | Implemented; automated qualification passes | Printer/session/submission ownership and feature initialization lifetimes are implemented. Opaque copy-on-write asset rollback and import history pass focused regressions and the full web gate. Persistence and DOM/XR surface lifetime ownership are integrated; surface regressions and the full web gate pass. |
| H: persistence | Implemented; automated qualification passes | Live worker serialization, guarded manual checkpoints, atomic per-session IndexedDB retention, DOM/XR recovery/import decisions, Save/Discard/Cancel, beforeunload and coordinated PWA updates. Focused lifecycle/storage/browser tests and the complete web quality gate pass. Broader device qualification remains pending. |
| I: large-project performance | Pending | Worker indexing before rich allocations, oversized-layer checkpoints, typed import traversal, measured baselines. |
| Release qualification | Pending | Full supported-deployment checks, native container build, final report regeneration, supervised U1/CC/Galaxy XR procedures, independent review/security signoff. |

## Reproduced regressions and verification (2026-10-01)

- `server/multipart.test.mjs`: the delayed filename callback reproduces an
  orphaned disk file with Multer 2.2.0 and passes with 2.4.0. Real Express HTTP
  tests abort eight uploads after disk storage begins and verify cleanup after
  each; malformed bracket/prototype/long fields return client errors, never
  dispatch slicing, and leave no files behind.
- `server/server.integration.test.mjs`: startup logging exposed the synthetic
  generated credential before the fix; it now reports only its protected path.
  Assertions never echo the credential, even when failing.
- `python3 -m unittest scripts/test_maintenance_security.py`: six tests pass,
  including scanning all seven maintenance scripts, verified hosts, key/agent
  defaults, terminal password opt-in, argument boundaries, and secret-free
  error handling. Before the change all seven script scans failed.
- `npm --prefix server test`: 33/33 pass against the default artifact resolver,
  with no `ORCAXR_WASM_DIR` override. The previously stale local manifest was
  corrected after independently hashing canonical, browser, and server copies.
- `npm --prefix {web,server,wasm} audit --include=dev --audit-level=moderate`:
  all three report zero vulnerabilities. Initial audits found two affected
  server packages and seven affected web dependency packages.
- `npm --prefix wasm run verify:artifacts`: passes, including the optional
  server deployment binaries. At this checkpoint, the verifier did not yet cover adjacent
  manifests or partial directories; E adds those checks below.
- `npm --prefix web run quality`: passes in full, including architecture,
  localization, production browser workflows, offline, accessibility (28 axe
  rules), pseudo-locales (155 critical controls), all 13 slicing test files,
  and unchanged bundle ceilings. Main chunk: 2,328,292 bytes; total JavaScript:
  10,537,352 bytes. These existing browser tests use the Vite-built preview and
  simulator; the real-Express/container deployment suite had not yet been
  implemented at this checkpoint. E records its later evidence below.
- Current-source Gitleaks scan: passes with repository configuration and full
  redaction, using image digest
  `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.
  This scans the current tracked files plus new implementation files, not Git
  history. A documentation phrase was reworded to avoid a false positive;
  secret rules and allowances were not weakened.

The dependency and source-credential change passes its automated gates.
Hardware, credential revocation, deployment release, and independent review are
not proven by these checks. The overall plan remains active.

## Printer command verification (2026-10-01)

- A new full-query regression failed against the prior accumulator: a response
  containing only progress retained the old `printing` state and filename. Full
  queries now discard old fields; incremental notifications alone merge.
- `printer-session-controller.test.ts`: 18 tests cover exact immutable identity,
  same-filename restarts, job/state changes, printer switches, reconnects,
  disposal, partial/failed queries, missing metadata, forged/replayed tokens,
  serialized commands across dialogs, and superseded/late query publication.
- DOM hold tests retain the original intent across telemetry updates, suppress
  duplicate releases, and abandon holds and dialogs on disposal/session abort.
  Real transport tests prove recovery uses authenticated POSTs without opening
  a WebSocket, and still honors cancellation and disposal.
- Production browser regressions pass for same-filename replacements during a
  modal, a DOM hold, and an XR-port hold; failed refresh after confirmation;
  dialog cancellation on reconnect; successful DOM and XR-port pause/resume;
  and separately confirmed emergency stop / firmware restart while queries fail.
  The XR ports now invoke the registered `xr-inspector` surface; the previous
  `xr-menu` invocation silently skipped those commands. These checks do not
  substitute for controller/pinch interaction on Galaxy XR.
- `npm --prefix web run quality`: passes (228 unit test files, integration,
  architecture, localization/parity/settings checks, production browser/offline,
  accessibility, pseudo-locales, and all 13 slice test files). Bundle limits are
  unchanged: main 2,339,383 bytes; total JavaScript 10,548,443 bytes. Final dialog
  lifecycle/controller tests and type checks were repeated after the corresponding
  changes; the final XR control layout is included in the accessibility/pseudo
  production builds. The localization sweep decreased from 178 to 177 strings.
- Current-source Gitleaks scan passes with the same pinned image and unchanged
  scanner rules. Regenerated qualification reporting still withholds the parity
  claim and lists five outstanding human gates.

Installed-firmware identity fields, supervised machine control, credential
revocation, and independent security/release review remain unqualified.

## Submission verification (2026-10-01)

- The readiness regression reproduced automatic-start authorization from missing
  state fields. Full, recognized Klipper/print/virtual-SD state is now required;
  only ready, inactive, explicitly idle states authorize start.
- `print-workflow-controller.test.ts`: 32 tests cover lifecycle order,
  upload-only defaults, changed artifact/session/mapping/readiness/capabilities,
  cancellation at each mutation boundary, changed preparation commands,
  ambiguous preparation/start reconciliation without retries, listing failure,
  wrong upload root/path/size, changed/active overwrite targets, collision
  regeneration, two clients choosing the same name, and stale stored reprints.
- DOM dialog tests cover abort cleanup, focus restoration, exact overwrite
  metadata, upload-only defaults and blockers. Seven XR renderer tests include
  an explicit overwrite toggle, upload-only availability with a start blocker,
  and stored-file confirmation. Both surfaces use one workflow and start
  options; closing an XR send sheet cancels its pending confirmation.
- Production browser tests upload the real sliced artifact, change loaded
  filaments before upload completes, and prove the file remains without any
  preparation/start request. Replacing a stored file during confirmation also
  sends no start. Normal verified upload/preparation/start and reprint pass.
- `npm --prefix web run quality`: passes in full, including 230 unit test files,
  all integration/project/settings/localization/XR checks, production browser
  and offline tests, 28 accessibility rules, 155 pseudo-localized controls,
  and 13 real slicing test files. The initial size check caught a 2,863-byte
  main-bundle overrun; loading the DOM confirmation on demand resolved it
  without changing ceilings. Final main: 2,346,538 bytes; JavaScript total:
  10,562,784 bytes. The localization sweep decreased from 177 to 176 strings.
- Current-source Gitleaks passes with the same pinned image and unchanged
  rules. Regenerated parity reporting still withholds the claim and lists five
  outstanding human gates. Upload checksum and response validation follow the
  [Moonraker file API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/).

No printer hardware was mutated during these tests. Moonraker has no atomic
client-side check-and-start transaction; other-client races and installed
firmware compatibility still require supervised qualification.

## Slicing lifecycle verification (2026-10-01)

- Native regressions reproduced publication after exit 17 or a signal, and a
  live descendant after the immediate child exited. Nine lifecycle tests now
  cover those cases, normal/missing/oversized output, a CLI that never opens its
  progress FIFO, cancellation, and SIGKILL escalation of a TERM-ignoring child.
  The same nine pass in an isolated Linux container with `--init`, including
  disappearance of adopted descendants from `/proc`. This uses the existing
  runtime image with current code mounted; it is not a fresh native image build.
- All 48 server tests pass against the default artifact path. HTTP regressions
  cover interrupted/repeated/concurrent downloads, expiry and release while
  transferring, retained-capacity refusal, synchronous job recovery, bounded
  private diagnostics, and unsuccessful jobs never publishing partial output.
- The old browser deadline probe failed because a hung DELETE never reached its
  timer. Nineteen helper tests and fourteen canonical-route tests now cover
  hung DELETE/body/poll/delay, independent cleanup cancellation, distinct
  terminal outcomes, complete download before release, digest/length/identity
  mismatch, insecure-LAN hashing, older servers, and failed or hung releases.
- Full `npm --prefix web run quality` passes: 231 unit test files, all
  integration/project/settings/localization/XR checks, production browser and
  offline tests, 28 accessibility rules, 155 pseudo-localized controls, and
  thirteen real slicing test files. Unchanged budgets: main 2,344,997 bytes;
  total JavaScript 10,565,669 bytes.
- Qualification reporting was regenerated; the five human gates remain
  incomplete. Current-source scanning uses the same pinned Gitleaks image and
  unchanged repository rules.

Process-tree settlement is qualified on Linux with an init reaper. A kernel task
that remains alive after SIGKILL keeps its worker slot; cancellation cannot be
reported confirmed prematurely. Other host platforms remain unqualified.

## Deployment verification (2026-10-01)

- Real HTTP regressions first reproduced static assets exhausting the API
  allowance and reserved API paths returning SPA HTML. Seven deployment tests
  now cover cold assets and entry-point caching, JSON API misses, token and
  same-origin mutation authorization, malformed forwarded protocol, and actual
  socket authority for authentication, CORS and rate identity.
- Artifact tests reproduced acceptance of a stale adjacent manifest and a
  partially populated optional copy. Seven expanded cases now cover schema,
  source/input identity, expected filenames, missing/changed files, concurrent
  publication, old readers, invalid sources and interrupted staging. Initial
  publication builds its whole directory privately before activation; readers
  never see a partial root, including simultaneous first publishers. All
  required/present copies pass the shared verifier. Canonical/browser adjacent
  manifests were added only after independently checking every binary hash.
- A real WASM slice through Express passes against the default resolver,
  without an environment override, and validates the returned output digest.
  The server suite passes 56 tests. Native manifest regression additionally
  reproduced acceptance of an unsupported schema; the shared verifier now
  rejects wrong schema/source and malformed patch or executable identities.
- The new browser suite serves the actual production build through Express.
  Both insecure HTTP LAN and a local HTTPS proxy pass cold loads, automatic
  attested discovery, retained downloads, and API rate limits. HTTPS verifies
  every one of 157 precache entries and cross-origin isolation. The HTTP case
  connects to the existing Moonraker simulator; no hardware is contacted.
- Those browser checks exposed an unguarded service-worker registration on
  insecure LAN pages. The helper now skips registration there, and the actual
  page script is covered in addition to its pure reload-decision tests.
- A separate regression found the browser's WASM digest differed from the
  canonical published bytes. The pin now matches the independently verified
  binaries; the engine source and binaries are unchanged. Web security checks,
  a unit regression, Docker coherence checks and live discovery assertions keep
  that mismatch from recurring.
- Base and Tailscale-profile Compose validation pass. The optional sidecar uses
  shared application networking, userspace mode and a directory configuration
  mount; base LAN publication remains intentional. Embedded startup uses the
  same loopback trust boundary. A native image build is in progress; its browser
  and process-reaping checks are not yet recorded as passing.
- All three dependency audits report zero vulnerabilities. Current-source
  Gitleaks passes with the existing pinned image and unchanged rules.

Full web quality passes, including 231 unit test files, production browser and
complete offline checks, 28 accessibility rules, 155 pseudo-localized controls,
and all thirteen slicing test files. Main remains 2,344,997 bytes; total JavaScript
remains 10,565,669 bytes, with unchanged ceilings. The artifact gate required the
adjacent metadata to be committed before qualification; that metadata-only commit
is `5b90733`, and the generated release report now includes its exact Git blob.
Live tailnet enrollment, actual printer/XR hardware, credential rotation and
independent release signoff remain unqualified.

## Discovery verification (2026-10-01)

- The original probe reproduced an external route becoming enabled while its
  discovery request was still pending. Discovery now probes an explicit candidate
  without writing shared preferences, then commits one attested route only while
  its generation remains current.
- Twenty-one controller tests cover late success/failure after manual selection,
  disable/forget/token or candidate edits, preference changes, reset, disposal,
  bounded hung probes, repeated connections, coherent atomic storage, and blocked
  or full storage. An additional regression reproduced a rejected preference reset
  reviving old persisted state; reset now preserves the operator’s session intent.
- Twenty attestation tests include manual connections requiring provenance after
  ping, bounded invalidation of hung proofs, complete native executable digests,
  exact patch sets, and captured endpoint/engine/generation identity. Canonical
  route tests retain the generation and reject secret-bearing URLs before requests.
- Four DOM lifecycle tests exercise real controls against the shared controller,
  including late status updates, draft preservation, disabled remounts and disposal.
  The real-Express browser suite also passes delayed attestation versus a manual
  choice and disabled-discovery reloads over both insecure HTTP and proxy HTTPS.
- A real browser with a throwing storage getter reproduced a startup failure in
  legacy AI credential cleanup. The getter is now guarded, and both deployment
  origins boot and connect with an explicit session-only persistence hint.
- The actual Slice control reproduced a hardcoded browser route that ignored the
  attested external choice; all-plate slicing also omitted engine metadata. Both
  now consume one captured route and proof, reject changed consent before upload,
  and pass real UI slicing through the deterministic external fixture on HTTP and
  HTTPS. The native executable itself remains separately qualified.
- Preference imports preserve the chosen endpoint as disabled until reconnection.
  Export/reset includes the atomic record and legacy origin marker, with no change
  to optional credential remembrance. New status messages use the existing
  localization pipeline, and the settings surface loads in its own lazy chunk.

Full web quality passes, including 233 unit test files, the integration/project/
settings/localization/XR suites, production browser and offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,349,793 bytes; total JavaScript 10,574,317 bytes.
Current-source Gitleaks passes with the pinned image and unchanged rules.
Startup qualification follows below; discovery evidence alone does not establish
application readiness.

## Startup verification (2026-10-01)

- A browser regression reproduced Ready while the required settings schema
  returned HTTP 503. The marker now derives from core workspace, shell, profiles
  and settings capabilities; unused optional integrations remain idle.
- Nine registry tests cover required/optional health, single-flight retry,
  partial-resource disposal, cancellation, deadlines, late import rejection and
  module failures that need reload. Policy/surface tests preserve printer
  recovery availability and show the same recovery target in DOM and XR.
- Required profile fetches now reject errors instead of swallowing them. A
  follow-up regression caught empty catalogs replacing valid data; failed,
  malformed, empty and late responses now preserve the previous usable catalog.
- Built-browser tests pass profile/schema failures, one request for repeated
  retry gestures, recovery without duplicate panels, and optional panel failure.
  Reload leaves a dirty project intact, then succeeds after explicit discard.
  Both HTTP and HTTPS deployment suites still pass with the derived Ready state.
- Startup controls and the shared settings adapters load separately; lazy panels
  are owned before mount and late imports cannot restore disposed features.
  Recovery text uses the localization pipeline. The XR desk retains its existing
  physical size with a bounded, scrollable failure row.
- Architecture checks follow the extracted settings adapter and still require
  `settings_apply_project` through the action registry, while forbidding direct
  canonical writes throughout the presentation layer. Startup recovery is an
  inspector action shared by the DOM status surface and XR desk.

Full web quality passes: 238 unit test files, integration/project/settings/
localization/XR suites, five startup fault scenarios, offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,312,049 bytes; total JavaScript 10,588,763 bytes.
The final build also passes the real Express HTTP/HTTPS deployment suites and
the current-source scan with the pinned Gitleaks image and unchanged rules.
Broader navigation/update protection and Save/Discard/Cancel persistence flows
remain in H; hardware qualification is not implied by renderer or browser tests.

## Asset rollback verification (2026-10-01)

- A regression reproduced 6,291,456 copied mesh bytes during transform/settings
  edits and undo/redo with a 1 MiB fixture. Repository-owned opaque snapshots now
  restore immutable records and cached fingerprints by reference. Insert/remove
  create new maps; serialized imports still validate and public mutable reads
  still copy. Forged and foreign handles are rejected.
- Seven focused regressions cover ordinary edits, transaction/command failure,
  failed undo/redo, independent repository versions, defensive public reads,
  invalid serialized imports, import undo/redo and fingerprint copy avoidance.
  Import history releases its serialized staging copy after validation and
  includes the replaced and imported payload sizes in its history estimate.
- Audited both production `peek()` consumers: the Three projection and canonical
  bounds reader only read shared descriptors/bytes; their mesh decoder allocates
  separate position/index buffers. Descriptors are deeply frozen on insertion.
- Fixed 8 MiB generated fixture, Node 22.21.0, twenty transform/undo pairs on the
  same host: copied bytes fell from 335,544,320 to zero; median pair duration fell
  from 10.38 ms to 0.59 ms, with p95 14.51 ms to 1.55 ms. Asset fingerprint
  `fnv1a64:ac1234b6ba312faf` and semantic hash `fnv1a64:66c954a755f47ac5`
  stayed identical. `bench:assets` runs in the project gate and enforces zero
  copied bytes; timing is reported without a hardware-independent latency claim.

Full web quality passes: 239 unit test files, integration/project/settings/
localization/XR suites, production startup/browser/offline workflows,
28 accessibility rules, 155 pseudo-localized controls and thirteen slicing test
files. Unchanged ceilings: main 2,313,191 bytes; total JavaScript 10,591,579 bytes.
This does not complete the persistence controller or remaining surface ownership
work.

## Persistence verification (2026-10-01)

- Persistence qualification adds guarded snapshot/checkpoint, queue/disposal,
  real IndexedDB transaction and DOM/XR decision regressions. The production
  browser loses a tab, restores through the import worker, preserves dirty state,
  exercises all three navigation choices and validates per-session discard plus
  explicit manual export when worker creation fails. Initial profile defaults
  establish a clean baseline only before any authored revision exists.
- A production browser rerun exposed a pending camera request proceeding after
  the panel was hidden. The focused regression now proves cancellation on
  hide/disposal and prevents overlapping slow captures; the live adapter checks
  visibility and selected camera again after awaiting a connection/frame.
- The native source image completed all 604 build steps. Its non-root,
  init-managed process lifecycle suite passes 9/9, including required descendant
  reaping. After refreshing the runtime/web layers, real-container HTTP and
  proxy HTTPS browser checks both pass, including full precache, insecure-LAN
  behavior, simulator access, retained downloads and API limits.
- The refreshed container also slices a generated 20 mm cube through its actual
  pinned native CLI and production HTTP service with bundled Centauri Carbon
  0.4 mm / 0.20 mm Standard / Elegoo PLA profiles. Two downloads return identical
  183,923-byte G-code with extruding moves and SHA-256
  `72958e0f6f29f68d9678eb1ba8a3bdc1dbbd521697f2a476bcc901fe1442ab79`;
  explicit release then returns 404. The disposable container is non-root,
  read-only and init-managed. No deployed service or printer was changed.
  Subsequent implementation commits require another runtime/web image refresh;
  this does not claim hardware printing or a final-release image.

Full web quality passes: 247 unit test files, integration/project/settings/
localization/XR suites, production recovery and real IndexedDB fault scenarios,
five startup recovery scenarios, offline workflows, 28 accessibility rules,
155 pseudo-localized controls and thirteen slicing test files. Unchanged bundle
ceilings: main 2,324,209 bytes; total JavaScript 10,474,956 bytes. Import and
serialization share one emitted archive-worker module with independently owned
instances, avoiding duplicate codec bundles. Current-source Gitleaks passes with
the pinned image and unchanged rules. Server tests pass 56/56 against the default
artifact resolver. Generated parity reporting still lists five human gates.

## Technical context reduction (2026-10-01)

`GEMINI.md` now keeps the cross-cutting constraints and required reading in 310
lines. Detailed canonical/parity, XR/UI, runtime/deployment, engine and large-model
context moved into maintained topic documents. Retired Android/JNI guidance has
its own clearly marked historical archive; current WASM memory, config, indexing
and provenance constraints remain in the active guidance. Relative documentation
links were rebased and checked. The obsolete seven-action XR rail and pre-attestation
external-routing statements were corrected to match the shipped behavior.

## Surface lifetime verification (2026-10-01)

- A production-browser regression reproduced dead workspace tabs after a persisted
  pagehide/pageshow pair. A palette regression reproduced two Ctrl-K handlers
  toggling twice after remount. Both pass with explicit surface ownership.
- Unit checks cover permanent departure, callback restoration without clobbering a
  newer owner, observer cleanup, partial mount failure, child cancellation and late
  initialization rejection. Cached-document event handling is browser-tested; this
  does not claim a particular device's actual back-forward-cache eligibility.
- Shell callbacks/subscriptions, eager panels, optional feature children, generated
  file inputs/modal controls, AI configuration, observers and XR viewport listeners
  now have explicit disposal. A two-simulator browser regression also reproduced
  console replies disappearing after printer replacement. The console now replaces
  its notification subscription with the selected transport; both simulators' replies
  arrive, and its last subscription is released on disposal.

Full web quality passes: 249 unit test files, integration/project/settings/
localization/XR suites, production browser/recovery/startup and real IndexedDB
fault scenarios, offline workflows, 28 accessibility rules, 155 pseudo-localized
controls and thirteen slicing test files. Unchanged bundle ceilings: main
2,329,856 bytes; total JavaScript 10,477,051 bytes. Current-source Gitleaks passes
with the pinned image and unchanged rules. Generated parity reporting retains
the five outstanding human gates.
