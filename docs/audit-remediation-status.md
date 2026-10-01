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
| D: process and artifact lifecycle | Implemented | Native exit/group termination, repeatable downloads, leases, TTL/release, capacity refusal, artifact validation and bounded browser cancellation pass server, container and full web gates. Fresh native image assembly remains a deployment qualification item. |
| E: deployment and artifacts | Pending | Static/API separation, Tailscale namespace/trust, adjacent-manifest verification, atomic publication, deployment coverage. The existing local server manifest was repaired only after all three binary copies matched canonical SHA-256 hashes. |
| F: discovery and startup | Pending | Transactional discovery and truthful capability initialization/recovery on DOM and XR. |
| G: controllers and snapshots | Pending | Controller ownership/disposal and opaque immutable asset rollback snapshots. |
| H: persistence | Pending | Worker serialization/checkpoints, transactional recovery storage, autosave, recovery flows, navigation/update guards. |
| I: large-project performance | Pending | Worker indexing before rich allocations, oversized-layer checkpoints, typed import traversal, measured baselines. |
| Release qualification | Pending | Full supported-deployment checks, native container build, report regeneration, documentation reduction, supervised U1/CC/Galaxy XR procedures, independent review/security signoff. |

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
  server deployment binaries. The current verifier still lacks the adjacent
  manifest and partial-directory checks required by E.
- `npm --prefix web run quality`: passes in full, including architecture,
  localization, production browser workflows, offline, accessibility (28 axe
  rules), pseudo-locales (155 critical controls), all 13 slicing test files,
  and unchanged bundle ceilings. Main chunk: 2,328,292 bytes; total JavaScript:
  10,537,352 bytes. These existing browser tests use the Vite-built preview and
  simulator; the real-Express/container deployment suite required by E remains
  to be implemented.
- Current-source Gitleaks scan: passes with repository configuration and full
  redaction, using image digest
  `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`.
  This scans the current tracked files plus new implementation files, not Git
  history. A documentation phrase was reworded to avoid a false positive;
  secret rules and allowances were not weakened.

The dependency and source-credential change passes its automated gates.
Hardware, credential revocation, deployment release, and independent review are
not proven by these checks. Continue with D; the overall plan remains active.

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
